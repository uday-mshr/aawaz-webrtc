import { io, Socket } from 'socket.io-client';
import { Persona } from '../types/persona';
import { MicVAD } from '@ricky0123/vad-web';
import * as ort from 'onnxruntime-web';
import { encode } from '@msgpack/msgpack';

// Configure ONNX Runtime WASM paths before any operations
// This must be set at module level to ensure it's configured before VAD initialization
if (typeof window !== 'undefined') {
  ort.env.wasm.wasmPaths = '/onnxruntime-web/';
}

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';

export interface InitiateSessionPayload {
  name: string;
  email: string;
  mobile: string;
  persona: Persona;
}

export interface JoinSessionPayload {
  sessionId: string;
}

export interface AudioChunkPayload {
  sessionId: string;
  audio: string; // base64 encoded audio string
  timestamp: number;
}

export interface TurnStartPayload {
  sessionId: string;
  type: 'turn_start';
}

export interface TurnCompletePayload {
  sessionId: string;
  type: 'turn_complete';
}

export interface EndSessionPayload {
  sessionId: string;
}

class SocketService {
  private socket: Socket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private isRecording = false;
  private audioChunks: Float32Array[] = [];
  private vad: any = null; // MicVAD instance
  private currentSessionId: string | null = null;
  private onAudioChunkCallback: ((chunk: ArrayBuffer) => void) | null = null;
  private speakingTimer: NodeJS.Timeout | null = null;
  private readonly SPEAKING_DEBOUNCE_MS = 300;
  // Audio playback queue management
  private activeAudioSources: AudioBufferSourceNode[] = [];
  private nextPlayTime: number = 0;
  private readonly GEMINI_SAMPLE_RATE = 24000;
  // Audio batching for MessagePack encoding optimization
  private audioChunkQueue: Uint8Array[] = [];
  private audioChunkQueueSize = 0;
  private readonly BATCH_SIZE_BYTES = 8192; // ~256ms of audio at 16kHz (4096 samples * 2 bytes)
  private batchTimer: NodeJS.Timeout | null = null;
  private readonly BATCH_TIMEOUT_MS = 50; // Max latency before sending partial batch

  connect() {
    if (this.socket?.connected) {
      return this.socket;
    }

    this.socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'], // Allow fallback to polling if websocket fails
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
      withCredentials: true,
      autoConnect: true,
    });

    // Add connection event listeners for debugging
    this.socket.on('connect', () => {
      console.log('Socket.io connected:', this.socket?.id);
    });

    this.socket.on('connect_error', (error) => {
      console.error('Socket.io connection error:', error);
    });

    this.socket.on('disconnect', (reason) => {
      console.log('Socket.io disconnected:', reason);
    });

    return this.socket;
  }

  disconnect() {
    this.stopRecording();
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
  }

  sendTurnStart(sessionId: string) {
    if (this.socket && this.socket.connected) {
      const payload: TurnStartPayload = {
        sessionId,
        type: 'turn_start',
      };
      this.emit('turn_start', payload);
      console.log('Sent turn_start signal');
    }
  }

  sendTurnComplete(sessionId: string) {
    if (this.socket && this.socket.connected) {
      const payload: TurnCompletePayload = {
        sessionId,
        type: 'turn_complete',
      };
      this.emit('turn_complete', payload);
      console.log('Sent turn_complete signal');
    }
  }

  on(event: string, callback: (...args: any[]) => void) {
    if (this.socket) {
      this.socket.on(event, callback);
    }
  }

  off(event: string, callback?: (...args: any[]) => void) {
    if (this.socket) {
      this.socket.off(event, callback);
    }
  }

  emit(event: string, data: any) {
    if (this.socket) {
      this.socket.emit(event, data);
    }
  }

  async startRecording(
    sessionId: string, 
    onAudioChunk: (chunk: ArrayBuffer) => void,
    onSpeechStart?: () => void,
    onSpeechEnd?: () => void
  ) {
    if (this.isRecording) {
      return;
    }

    try {
      this.currentSessionId = sessionId;
      this.onAudioChunkCallback = onAudioChunk;

      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      this.audioContext = new AudioContext({ sampleRate: 16000 });

      // Initialize VAD
      const vad = await MicVAD.new({
        getStream: async () => this.mediaStream!,
        onSpeechStart: () => {
          // Debounce to avoid false positives from echo/noise
          if (this.speakingTimer) {
            clearTimeout(this.speakingTimer);
          }
          this.speakingTimer = setTimeout(() => {
            this.speakingTimer = null;
            console.log('VAD: Speech started');
            // Clear audio queue when user starts speaking (barge-in)
            this.clearAudioQueue();
            this.sendTurnStart(sessionId);
            if (onSpeechStart) {
              onSpeechStart();
            }
          }, this.SPEAKING_DEBOUNCE_MS);
        },
        onSpeechEnd: () => {
          // If debounce timer is still pending, cancel it
          if (this.speakingTimer) {
            clearTimeout(this.speakingTimer);
            this.speakingTimer = null;
            return;
          }
          console.log('VAD: Speech ended');
          this.sendTurnComplete(sessionId);
          if (onSpeechEnd) {
            onSpeechEnd();
          }
        },
        onVADMisfire: () => {
          // VAD misfire - can be ignored or logged
          console.debug('VAD misfire detected');
        },
        // Use local paths for assets (served from public directory)
        baseAssetPath: '/',
        onnxWASMBasePath: '/onnxruntime-web/',
        modelURL: '/silero_vad.onnx',
        modelFname: 'silero_vad.onnx', // Explicitly set model filename
        workletURL: '/vad.worklet.bundle.min.js',
      });

      this.vad = vad;

      // Create audio processing node
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (!this.isRecording) return;

        const inputData = e.inputBuffer.getChannelData(0);
        const buffer = new ArrayBuffer(inputData.length * 2);
        const view = new DataView(buffer);

        // Convert Float32Array to Int16Array (PCM)
        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }

        // Convert ArrayBuffer to Uint8Array for batching
        const audioBuffer = new Uint8Array(buffer);
        
        // Add to batch queue
        this.audioChunkQueue.push(audioBuffer);
        this.audioChunkQueueSize += audioBuffer.length;

        // Send when batch is full or schedule timeout for partial batch
        if (this.audioChunkQueueSize >= this.BATCH_SIZE_BYTES) {
          this.sendBatchedAudio();
        } else if (!this.batchTimer) {
          // Send after timeout if batch not full (max latency)
          this.batchTimer = setTimeout(() => {
            this.sendBatchedAudio();
          }, this.BATCH_TIMEOUT_MS);
        }

        if (this.onAudioChunkCallback) {
          this.onAudioChunkCallback(buffer);
        }
      };

      source.connect(processor);
      processor.connect(this.audioContext.destination);
      
      // Start VAD
      vad.start();
      this.isRecording = true;

      console.log('Recording started with VAD');
    } catch (error) {
      console.error('Error starting recording:', error);
      throw error;
    }
  }

  stopRecording() {
    this.isRecording = false;

    // Send any remaining batched audio
    if (this.audioChunkQueue.length > 0) {
      this.sendBatchedAudio();
    }

    // Stop VAD
    if (this.vad) {
      try {
        this.vad.pause();
        this.vad.destroy();
      } catch (error) {
        console.error('Error stopping VAD:', error);
      }
      this.vad = null;
    }

    // Clear speaking timer
    if (this.speakingTimer) {
      clearTimeout(this.speakingTimer);
      this.speakingTimer = null;
    }

    // Clear batch timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Clear audio queue
    this.clearAudioQueue();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    // Don't close audioContext here - it might be needed for playback
    // Only close if we're disconnecting
    // if (this.audioContext) {
    //   this.audioContext.close();
    //   this.audioContext = null;
    // }

    this.audioChunks = [];
    this.currentSessionId = null;
    this.onAudioChunkCallback = null;
    console.log('Recording stopped');
  }

  private sendBatchedAudio() {
    if (this.audioChunkQueue.length === 0 || !this.currentSessionId) return;

    // Merge all queued chunks
    const totalSize = this.audioChunkQueue.reduce((sum, chunk) => sum + chunk.length, 0);
    const merged = new Uint8Array(totalSize);
    let offset = 0;
    for (const chunk of this.audioChunkQueue) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Encode as MessagePack
    const payload = {
      sessionId: this.currentSessionId,
      timestamp: Date.now(),
      data: merged,
    };

    const binaryPayload = encode(payload);
    this.emit('audio_input', binaryPayload);

    // Reset queue
    this.audioChunkQueue = [];
    this.audioChunkQueueSize = 0;
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
  }

  playAudio(base64Audio: string) {
    try {
      // Decode base64 to binary string
      const binary = atob(base64Audio);
      const length = binary.length / 2; // PCM16 is 2 bytes per sample
      const arrayBuffer = new ArrayBuffer(binary.length);
      const view = new Uint8Array(arrayBuffer);

      // Convert binary string to Uint8Array
      for (let i = 0; i < binary.length; i++) {
        view[i] = binary.charCodeAt(i);
      }

      // Decode PCM16 to Float32Array
      const dataView = new DataView(arrayBuffer);
      const audioData = new Float32Array(length);
      for (let i = 0; i < length; i++) {
        const int16 = dataView.getInt16(i * 2, true); // little-endian
        // Convert Int16 (-32768 to 32767) to Float32 (-1.0 to 1.0)
        audioData[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7FFF;
      }

      // Create audio context if needed
      const audioContext = this.audioContext || new AudioContext({ sampleRate: this.GEMINI_SAMPLE_RATE });
      this.audioContext = audioContext;

      // Create AudioBuffer directly from Float32Array
      const buffer = audioContext.createBuffer(1, audioData.length, this.GEMINI_SAMPLE_RATE);
      buffer.copyToChannel(audioData, 0);

      // Calculate when to start playing (sequentially after previous chunks)
      const now = audioContext.currentTime;
      const playTime = Math.max(now, this.nextPlayTime);

      // Create and schedule audio source
      const source = audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(audioContext.destination);

      // Track active sources
      this.activeAudioSources.push(source);

      // Clean up when playback ends
      source.onended = () => {
        const index = this.activeAudioSources.indexOf(source);
        if (index > -1) {
          this.activeAudioSources.splice(index, 1);
        }
      };

      // Start playback at scheduled time
      source.start(playTime);

      // Update next play time to be after this chunk finishes
      this.nextPlayTime = playTime + buffer.duration;
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  }

  clearAudioQueue() {
    // Stop all currently playing audio sources
    this.activeAudioSources.forEach((source) => {
      try {
        source.stop();
      } catch (error) {
        // Source may have already ended
      }
    });
    this.activeAudioSources = [];
    this.nextPlayTime = 0;
  }
}

export default new SocketService();


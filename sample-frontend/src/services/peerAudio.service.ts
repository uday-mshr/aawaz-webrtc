import { io, Socket } from 'socket.io-client';

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';

export interface AudioConstraints {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export interface AudioMetrics {
  rms: number;
  peak: number;
  sampleRate: number;
  latency?: number;
}

export interface PeerAudioChunk {
  sessionId: string;
  audio: string; // base64
  timestamp: number;
  fromSocketId: string;
}

class PeerAudioService {
  private socket: Socket | null = null;
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private audioProcessor: ScriptProcessorNode | null = null;
  private isRecording = false;
  private isMuted = false;
  private sessionId: string | null = null;
  private constraints: AudioConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  private metricsCallbacks: Set<(metrics: AudioMetrics) => void> = new Set();
  private lastSentTimestamp: number = 0;
  private audioLevels: { rms: number; peak: number }[] = [];

  connect() {
    if (this.socket?.connected) {
      return this.socket;
    }

    this.socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
      withCredentials: true,
      autoConnect: true,
    });

    this.socket.on('connect', () => {
      console.log('Peer Audio Service: Socket connected', this.socket?.id);
    });

    this.socket.on('disconnect', (reason) => {
      console.log('Peer Audio Service: Socket disconnected', reason);
    });

    // Listen for peer audio chunks
    this.socket.on('peer_audio_chunk', (data: PeerAudioChunk) => {
      console.log('Peer Audio Service: Received peer audio chunk', {
        sessionId: data.sessionId,
        audioLength: data.audio.length,
        timestamp: data.timestamp
      });
      this.handlePeerAudio(data);
    });

    // Listen for QA session events
    this.socket.on('qa_session_created', (data: { sessionId: string; status: string }) => {
      console.log('QA session created:', data);
    });

    this.socket.on('qa_session_joined', (data: { sessionId: string; status: string; peerCount?: number }) => {
      console.log('QA session joined:', data);
    });

    this.socket.on('qa_session_left', (data: { sessionId: string; peerSocketId: string }) => {
      console.log('Peer left QA session:', data);
    });

    this.socket.on('session_error', (data: { code: string; message: string; details?: any }) => {
      console.error('Session error:', data);
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

  async createQASession(sessionId?: string): Promise<string> {
    if (!this.socket) {
      this.connect();
    }

    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Session creation timeout'));
      }, 10000);

      this.socket.once('qa_session_created', (data: { sessionId: string; status: string }) => {
        clearTimeout(timeout);
        this.sessionId = data.sessionId;
        resolve(data.sessionId);
      });

      this.socket.once('session_error', (error: { code: string; message: string }) => {
        clearTimeout(timeout);
        reject(new Error(error.message));
      });

      this.socket.emit('create_qa_session', { sessionId });
    });
  }

  async joinQASession(sessionId: string): Promise<void> {
    if (!this.socket) {
      this.connect();
    }

    return new Promise((resolve, reject) => {
      if (!this.socket) {
        reject(new Error('Socket not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Session join timeout'));
      }, 10000);

      this.socket.once('qa_session_joined', (data: { sessionId: string; status: string }) => {
        clearTimeout(timeout);
        this.sessionId = data.sessionId;
        resolve();
      });

      this.socket.once('session_error', (error: { code: string; message: string }) => {
        clearTimeout(timeout);
        reject(new Error(error.message));
      });

      this.socket.emit('join_qa_session', { sessionId });
    });
  }

  updateConstraints(constraints: Partial<AudioConstraints>) {
    this.constraints = { ...this.constraints, ...constraints };
    // If recording, restart with new constraints
    if (this.isRecording) {
      this.stopRecording();
      setTimeout(() => {
        if (this.sessionId) {
          this.startRecording(this.sessionId);
        }
      }, 100);
    }
  }

  getConstraints(): AudioConstraints {
    return { ...this.constraints };
  }

  async startRecording(sessionId: string) {
    if (this.isRecording || !this.socket) {
      return;
    }

    try {
      this.sessionId = sessionId;

      // Request microphone access with constraints
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: this.constraints.echoCancellation,
          noiseSuppression: this.constraints.noiseSuppression,
          autoGainControl: this.constraints.autoGainControl,
        },
      });

      this.audioContext = new AudioContext({ sampleRate: 16000 });
      const source = this.audioContext.createMediaStreamSource(this.mediaStream);
      const processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      processor.onaudioprocess = (e) => {
        if (!this.isRecording || !this.sessionId || this.isMuted) return;

        const inputData = e.inputBuffer.getChannelData(0);
        
        // Calculate metrics
        const rms = this.calculateRMS(inputData);
        const peak = this.calculatePeak(inputData);
        this.audioLevels.push({ rms, peak });
        
        // Keep only last 10 measurements
        if (this.audioLevels.length > 10) {
          this.audioLevels.shift();
        }

        // Notify metrics callbacks
        const avgRms = this.audioLevels.reduce((sum, level) => sum + level.rms, 0) / this.audioLevels.length;
        const maxPeak = Math.max(...this.audioLevels.map(level => level.peak));
        
        const metrics: AudioMetrics = {
          rms: avgRms,
          peak: maxPeak,
          sampleRate: this.audioContext?.sampleRate || 16000,
        };
        
        this.metricsCallbacks.forEach(callback => callback(metrics));

        // Convert Float32Array to Int16Array (PCM)
        const buffer = new ArrayBuffer(inputData.length * 2);
        const view = new DataView(buffer);

        for (let i = 0; i < inputData.length; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i]));
          view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        }

        // Convert ArrayBuffer to base64 for Socket.IO transmission
        const uint8Array = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < uint8Array.length; i++) {
          binary += String.fromCharCode(uint8Array[i]);
        }
        const base64Audio = btoa(binary);

        // Send audio chunk
        const timestamp = Date.now();
        this.lastSentTimestamp = timestamp;
        
        console.log('Peer Audio Service: Sending audio chunk', {
          sessionId: this.sessionId,
          audioLength: base64Audio.length,
          timestamp
        });
        
        this.socket!.emit('audio_chunk', {
          sessionId: this.sessionId,
          audio: base64Audio,
          timestamp,
        });
      };

      source.connect(processor);
      processor.connect(this.audioContext.destination);
      this.audioProcessor = processor;
      this.isRecording = true;

      console.log('Peer Audio Service: Recording started');
    } catch (error) {
      console.error('Error starting recording:', error);
      throw error;
    }
  }

  stopRecording() {
    this.isRecording = false;

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }

    if (this.audioProcessor) {
      this.audioProcessor.disconnect();
      this.audioProcessor = null;
    }

    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.audioLevels = [];
    console.log('Peer Audio Service: Recording stopped');
  }

  mute() {
    this.isMuted = true;
  }

  unmute() {
    this.isMuted = false;
  }

  getMuted(): boolean {
    return this.isMuted;
  }

  private handlePeerAudio(data: PeerAudioChunk) {
    try {
      console.log('Peer Audio Service: Processing peer audio', {
        audioLength: data.audio.length,
        timestamp: data.timestamp
      });

      // Decode base64 audio (PCM16 format)
      const audioData = atob(data.audio);
      const arrayBuffer = new ArrayBuffer(audioData.length);
      const view = new Uint8Array(arrayBuffer);

      for (let i = 0; i < audioData.length; i++) {
        view[i] = audioData.charCodeAt(i);
      }

      // Create a separate audio context for playback (don't reuse recording context)
      // This prevents conflicts between recording and playback
      const playbackContext = new AudioContext({ sampleRate: 16000 });

      // Resume AudioContext if suspended (required by browser autoplay policy)
      if (playbackContext.state === 'suspended') {
        playbackContext.resume().then(() => {
          console.log('Peer Audio Service: AudioContext resumed');
        }).catch(err => {
          console.error('Peer Audio Service: Failed to resume AudioContext:', err);
        });
      }

      // Convert PCM16 to Float32Array
      const dataView = new DataView(arrayBuffer);
      const length = arrayBuffer.byteLength / 2;
      const float32Array = new Float32Array(length);
      
      for (let i = 0; i < length; i++) {
        const int16 = dataView.getInt16(i * 2, true); // little-endian
        float32Array[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7FFF;
      }

      // Create AudioBuffer and play
      const audioBuffer = playbackContext.createBuffer(1, length, 16000);
      audioBuffer.copyToChannel(float32Array, 0);

      const source = playbackContext.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(playbackContext.destination);
      
      // Clean up when playback ends
      source.onended = () => {
        playbackContext.close().catch(err => {
          console.warn('Error closing playback context:', err);
        });
      };
      
      // Ensure context is running before starting playback
      playbackContext.resume().then(() => {
        source.start(0);
        console.log('Peer Audio Service: Audio playback started', {
          length: length,
          duration: (length / 16000).toFixed(2) + 's'
        });
      }).catch(err => {
        console.error('Peer Audio Service: Failed to start playback:', err);
      });

      console.log('Peer Audio Service: Playing audio', {
        length: length,
        duration: length / 16000,
        sampleRate: 16000
      });

      // Calculate latency
      const receiveTime = Date.now();
      const latency = receiveTime - data.timestamp;
      
      // Update metrics with latency
      const metrics: AudioMetrics = {
        rms: 0,
        peak: 0,
        sampleRate: 16000,
        latency,
      };
      
      this.metricsCallbacks.forEach(callback => callback(metrics));
    } catch (error) {
      console.error('Error handling peer audio:', error);
    }
  }

  private calculateRMS(audioData: Float32Array): number {
    let sumSquares = 0;
    for (let i = 0; i < audioData.length; i++) {
      sumSquares += audioData[i] * audioData[i];
    }
    return Math.sqrt(sumSquares / audioData.length);
  }

  private calculatePeak(audioData: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < audioData.length; i++) {
      const value = Math.abs(audioData[i]);
      if (value > peak) {
        peak = value;
      }
    }
    return peak;
  }

  onMetrics(callback: (metrics: AudioMetrics) => void) {
    this.metricsCallbacks.add(callback);
    return () => {
      this.metricsCallbacks.delete(callback);
    };
  }

  endSession() {
    if (this.sessionId && this.socket) {
      this.socket.emit('end_session', { sessionId: this.sessionId });
    }
    this.stopRecording();
    this.sessionId = null;
  }

  isConnected(): boolean {
    return this.socket?.connected || false;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }
}

export default new PeerAudioService();


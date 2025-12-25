import { useState, useEffect, useRef, useCallback } from 'react';
import { MicVAD } from '@ricky0123/vad-web';
import * as ort from 'onnxruntime-web';
import { io, Socket } from 'socket.io-client';


// Configure ONNX Runtime WASM paths before any operations
// This must be set at module level to ensure it's configured before VAD initialization
if (typeof window !== 'undefined') {
  ort.env.wasm.wasmPaths = '/onnxruntime-web/';
}

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';
export type AiStatus = 'idle' | 'listening' | 'thinking' | 'typing';

export type Message = {
  id: string;
  role: 'user' | 'ai';
  text: string;
  isPartial?: boolean;
};

interface UseAudioStreamOptions {
  socketUrl?: string;
  targetSampleRate?: number;
  useBase64?: boolean;
  onError?: (error: Error) => void;
  sessionId?: string;
  persona?: string;
}

interface UseAudioStreamReturn {
  isConnected: boolean;
  connectionState: ConnectionState;
  isRecording: boolean;
  messages: Message[];
  isUserSpeaking: boolean;
  isAiSpeaking: boolean;
  aiStatus: AiStatus;
  startCall: () => Promise<void>;
  endCall: () => void;
  clearPlayback: () => void;
}

const DEFAULT_SAMPLE_RATE = 16000; // Gemini requirement
const JITTER_BUFFER_MS = 100; // 100ms jitter buffer for smooth playback
const MIN_READY_CHUNKS = 3; // soft prime before starting playback
const AI_FINGERPRINT_WINDOW_SEC = 1.5; // retain ~1.5s of AI playback energy
const AI_FINGERPRINT_SAMPLES = 512; // small snippet to correlate against
const DEBUG_AUDIO_GATE = false; // set true to trace gate decisions in console (manual checks: laptop-speaker echo should be gated; speaking over AI should clear playback and capture user)
const HEARTBEAT_INTERVAL_MS = 15000; // 15 seconds
const RECONNECT_DELAY_MS = 1000; // 1 second delay before reconnecting
const MIN_BUFFER_SIZE_BYTES = 4096; // hard floor to avoid tiny "crumb" frames
const SPEAKING_DEBOUNCE_MS = 300; // debounce barge-in to ignore coughs/clicks

/**
 * Generate unique message ID
 */
function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Gets Socket.IO URL for signaling
 */
function getSocketUrl(): string {
  if (typeof window === 'undefined') {
    return 'http://localhost:3000';
  }
  return import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';
}

/**
 * Custom hook for bidirectional audio streaming via WebRTC with VAD
 */
export function useAudioStream(options: UseAudioStreamOptions = {}): UseAudioStreamReturn {
  const {
    socketUrl = getSocketUrl(),
    targetSampleRate = DEFAULT_SAMPLE_RATE,
    useBase64 = true,
    onError,
    sessionId,
    persona,
  } = options;

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [isRecording, setIsRecording] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [isUserSpeaking, setIsUserSpeaking] = useState(false);
  const [isAiSpeaking, setIsAiSpeaking] = useState(false);
  const [aiStatus, setAiStatus] = useState<AiStatus>('listening');

  // Refs for audio context, VAD, and WebRTC
  const audioContextRef = useRef<AudioContext | null>(null);
  const vadRef = useRef<MicVAD | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const audioElementRef = useRef<HTMLAudioElement | null>(null);
  const shouldReconnectRef = useRef(false);
  const isUserSpeakingRef = useRef(false);
  const isAiSpeakingRef = useRef(false);
  const speechRecognitionRef = useRef<SpeechRecognition | null>(null);
  const currentUserMessageRef = useRef<string>('');
  const messageIdCounterRef = useRef(0);

  // Refs for audio playback with jitter buffer
  const activeAudioSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef<number>(0);
  const jitterBufferRef = useRef<Array<{ audio: Float32Array; timestamp: number }>>([]);
  const jitterBufferProcessingRef = useRef(false);
  const firstChunkTimeRef = useRef<number | null>(null); // AudioContext time when first chunk arrived
  const aiPlaybackEnergyRef = useRef<Array<{
    timestamp: number;
    rms: number;
    peak: number;
    fingerprint: Float32Array;
  }>>([]);
  const speakingTimerRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Convert Float32Array to Int16Array (PCM 16-bit)
   */
  const float32ToInt16 = useCallback((audioData: Float32Array): Int16Array => {
    const int16 = new Int16Array(audioData.length);
    for (let i = 0; i < audioData.length; i++) {
      const sample = Math.max(-1, Math.min(1, audioData[i]));
      int16[i] = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    }
    return int16;
  }, []);

  /**
   * Encode Int16Array PCM to Base64
   */
  const encodeInt16Base64 = useCallback((audioData: Int16Array): string => {
    const buffer = new ArrayBuffer(audioData.length * 2);
    const view = new DataView(buffer);
    for (let i = 0; i < audioData.length; i++) {
      view.setInt16(i * 2, audioData[i], true);
    }
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }, []);

  /**
   * Decode Base64 PCM 16-bit to Float32Array
   */
  const decodePCM16Base64 = useCallback((base64: string): Float32Array => {
    const binary = atob(base64);
    const buffer = new ArrayBuffer(binary.length);
    const view = new DataView(buffer);
    
    for (let i = 0; i < binary.length; i++) {
      view.setUint8(i, binary.charCodeAt(i));
    }
    
    // Decode PCM16 to Float32Array
    const length = buffer.byteLength / 2;
    const audioData = new Float32Array(length);
    const dataView = new DataView(buffer);
    
    for (let i = 0; i < length; i++) {
      const int16 = dataView.getInt16(i * 2, true); // little-endian
      audioData[i] = int16 < 0 ? int16 / 0x8000 : int16 / 0x7FFF;
    }
    
    return audioData;
  }, []);

  /**
   * Lightweight audio stats helpers
   */
  const computeRms = useCallback((audioData: Float32Array): number => {
    let sumSquares = 0;
    for (let i = 0; i < audioData.length; i++) {
      const sample = audioData[i];
      sumSquares += sample * sample;
    }
    return Math.sqrt(sumSquares / audioData.length);
  }, []);

  const computePeak = useCallback((audioData: Float32Array): number => {
    let peak = 0;
    for (let i = 0; i < audioData.length; i++) {
      const value = Math.abs(audioData[i]);
      if (value > peak) {
        peak = value;
      }
    }
    return peak;
  }, []);

  const computeCorrelation = useCallback((a: Float32Array, b: Float32Array): number => {
    const length = Math.min(a.length, b.length, AI_FINGERPRINT_SAMPLES);
    if (length === 0) return 0;

    let dot = 0;
    let sumASq = 0;
    let sumBSq = 0;

    for (let i = 0; i < length; i++) {
      const av = a[i];
      const bv = b[i];
      dot += av * bv;
      sumASq += av * av;
      sumBSq += bv * bv;
    }

    const denom = Math.sqrt(sumASq) * Math.sqrt(sumBSq) || 1;
    return dot / denom;
  }, []);

  /**
   * Track AI playback fingerprint for gating
   */
  const trackAiPlayback = useCallback((audioData: Float32Array) => {
    if (!audioContextRef.current) return;
    const timestamp = audioContextRef.current.currentTime;
    const rms = computeRms(audioData);
    const peak = computePeak(audioData);
    const snippet = audioData.length > AI_FINGERPRINT_SAMPLES
      ? audioData.subarray(0, AI_FINGERPRINT_SAMPLES)
      : audioData;
    const fingerprint =
      snippet.length === AI_FINGERPRINT_SAMPLES
        ? snippet
        : (() => {
            // Pad to consistent length so correlation stays stable
            const padded = new Float32Array(AI_FINGERPRINT_SAMPLES);
            padded.set(snippet);
            return padded;
          })();

    aiPlaybackEnergyRef.current.push({
      timestamp,
      rms,
      peak,
      fingerprint,
    });

    // Keep only recent fingerprints
    const windowStart = timestamp - AI_FINGERPRINT_WINDOW_SEC;
    aiPlaybackEnergyRef.current = aiPlaybackEnergyRef.current.filter((entry) => entry.timestamp >= windowStart);
  }, [computePeak, computeRms]);

  /**
   * Decide whether to gate mic frames due to AI playback leak
   */
  const shouldGateAudio = useCallback((audioData: Float32Array): boolean => {
    // Never gate while VAD says the user is speaking (preserve barge-in)
    if (isUserSpeakingRef.current) {
      return false;
    }

    const audioContext = audioContextRef.current;
    const now = audioContext ? audioContext.currentTime : performance.now() / 1000;
    const recent = aiPlaybackEnergyRef.current.filter((entry) => (now - entry.timestamp) <= AI_FINGERPRINT_WINDOW_SEC);
    if (!recent.length) return false;

    const micRms = computeRms(audioData);
    const micPeak = computePeak(audioData);
    const avgAiRms = recent.reduce((sum, entry) => sum + entry.rms, 0) / recent.length;
    const avgAiPeak = recent.reduce((sum, entry) => sum + entry.peak, 0) / recent.length;
    const latestFingerprint = recent[recent.length - 1].fingerprint;
    const correlation = computeCorrelation(audioData, latestFingerprint);

    const energyMatch = micRms <= avgAiRms * 1.15 && micPeak <= avgAiPeak * 1.1;
    const correlated = correlation >= 0.7;

    const gate = (energyMatch || correlated) && isAiSpeakingRef.current;

    if (DEBUG_AUDIO_GATE && gate) {
      console.debug('[audio-gate] gating chunk', {
        micRms,
        micPeak,
        avgAiRms,
        avgAiPeak,
        correlation,
        recentFingerprints: recent.length,
        isAiSpeaking: isAiSpeakingRef.current,
      });
    }

    return gate;
  }, [computeCorrelation, computePeak, computeRms]);

  /**
   * Update AI speaking state based on active audio sources
   */
  const updateAiSpeakingState = useCallback(() => {
    const hasActiveAudio = activeAudioSourcesRef.current.length > 0;
    setIsAiSpeaking(hasActiveAudio);
    isAiSpeakingRef.current = hasActiveAudio;

    if (hasActiveAudio) {
      setAiStatus('typing');
    } else if (!isUserSpeakingRef.current) {
      setAiStatus('listening');
    }
  }, []);

  /**
   * Clear playback buffer (for barge-in/interruption)
   */
  const clearPlayback = useCallback(() => {
    // Stop all active audio sources
    activeAudioSourcesRef.current.forEach((source) => {
      try {
        source.stop();
        source.disconnect();
      } catch (e) {
        // Source may have already ended or been stopped
      }
    });
    activeAudioSourcesRef.current = [];

    // Clear jitter buffer
    jitterBufferRef.current = [];
    firstChunkTimeRef.current = null;
    jitterBufferProcessingRef.current = false;
    aiPlaybackEnergyRef.current = [];

    // Reset playback timing
    if (audioContextRef.current) {
      nextPlayTimeRef.current = audioContextRef.current.currentTime;
    }
    
    // Update AI speaking state
    updateAiSpeakingState();
  }, [updateAiSpeakingState]);

  /**
   * Process jitter buffer and play audio chunks
   */
  const processJitterBuffer = useCallback(() => {
    if (jitterBufferProcessingRef.current || !audioContextRef.current) {
      return;
    }

    jitterBufferProcessingRef.current = true;
    const audioContext = audioContextRef.current;
    const GEMINI_SAMPLE_RATE = 24000; // Gemini outputs 24kHz audio
    const now = audioContext.currentTime;
    const playTime = now + (JITTER_BUFFER_MS / 1000); // Add jitter buffer delay

    // Sort buffer by timestamp to handle out-of-order packets
    jitterBufferRef.current.sort((a, b) => a.timestamp - b.timestamp);

    // Process all chunks that are ready to play
    const readyChunks: Array<{ audio: Float32Array; timestamp: number }> = [];
    const remainingChunks: typeof jitterBufferRef.current = [];

    // Process chunks: if timestamp is in the past (accounting for jitter buffer delay), they're ready
    const readyThreshold = now - (JITTER_BUFFER_MS / 1000); // Allow chunks up to jitter buffer delay in the past
    for (const chunk of jitterBufferRef.current) {
      // Chunks are ready if their timestamp is before the ready threshold
      // This accounts for network delay and ensures smooth playback
      if (chunk.timestamp <= readyThreshold) {
        readyChunks.push(chunk);
      } else {
        remainingChunks.push(chunk);
      }
    }

    jitterBufferRef.current = remainingChunks;

    // If we don't have enough priming chunks and nothing is currently playing, hold until buffer fills
    if (activeAudioSourcesRef.current.length === 0 && readyChunks.length > 0 && readyChunks.length < MIN_READY_CHUNKS) {
      jitterBufferRef.current.push(...readyChunks);
      jitterBufferRef.current.sort((a, b) => a.timestamp - b.timestamp);
      jitterBufferProcessingRef.current = false;
      setTimeout(processJitterBuffer, 10);
      return;
    }

    // Play all ready chunks
    let currentPlayTime = Math.max(playTime, nextPlayTimeRef.current);
    
    for (const { audio: audioData } of readyChunks) {
      try {
        const buffer = audioContext.createBuffer(1, audioData.length, GEMINI_SAMPLE_RATE);
        buffer.copyToChannel(audioData, 0);

        const source = audioContext.createBufferSource();
        source.buffer = buffer;
        source.connect(audioContext.destination);

        activeAudioSourcesRef.current.push(source);
        trackAiPlayback(audioData);
        source.start(currentPlayTime);
        // Update AI speaking state when audio starts playing
        updateAiSpeakingState();

        // Clean up when playback ends
        source.onended = () => {
          const index = activeAudioSourcesRef.current.indexOf(source);
          if (index > -1) {
            activeAudioSourcesRef.current.splice(index, 1);
          }
          // Update AI speaking state when source ends
          updateAiSpeakingState();
        };

        currentPlayTime += buffer.duration;
      } catch (error) {
        console.error('Error playing audio chunk:', error);
      }
    }

    nextPlayTimeRef.current = currentPlayTime;

    // Schedule next processing
    if (jitterBufferRef.current.length > 0) {
      setTimeout(() => {
        jitterBufferProcessingRef.current = false;
        processJitterBuffer();
      }, 10); // Check every 10ms
    } else {
      jitterBufferProcessingRef.current = false;
    }
  }, [trackAiPlayback, updateAiSpeakingState]);

  /**
   * Handle incoming audio from WebSocket with jitter buffer
   */
  const handleIncomingAudio = useCallback(async (audioData: Float32Array) => {
    try {
      // Drop/clear AI audio while user is speaking to avoid overlap
      if (isUserSpeakingRef.current) {
        clearPlayback();
        return;
      }

      if (!audioContextRef.current) {
        return;
      }

      // Use AudioContext time (in seconds) for timestamps to match comparison logic
      const audioContext = audioContextRef.current;
      const timestamp = audioContext.currentTime;
      
      // Track first chunk time for relative timing
      if (firstChunkTimeRef.current === null) {
        firstChunkTimeRef.current = timestamp;
      }
      
      // Add to jitter buffer with AudioContext time (seconds)
      jitterBufferRef.current.push({ audio: audioData, timestamp });
      trackAiPlayback(audioData);

      // Trigger processing
      processJitterBuffer();
    } catch (error) {
      console.error('Error handling incoming audio:', error);
      onError?.(error as Error);
    }
  }, [processJitterBuffer, updateAiSpeakingState, clearPlayback, trackAiPlayback, onError]);

  /**
   * Resample audio to target sample rate
   */
  const resampleAudio = useCallback(async (
    audioData: Float32Array,
    sourceSampleRate: number,
    targetSampleRate: number
  ): Promise<Float32Array> => {
    if (sourceSampleRate === targetSampleRate) {
      return audioData;
    }

    const ratio = targetSampleRate / sourceSampleRate;
    const newLength = Math.round(audioData.length * ratio);
    
    // Use OfflineAudioContext for resampling
    const offlineContext = new OfflineAudioContext(1, newLength, targetSampleRate);
    const buffer = offlineContext.createBuffer(1, audioData.length, sourceSampleRate);
    buffer.copyToChannel(audioData, 0);
    
    const source = offlineContext.createBufferSource();
    source.buffer = buffer;
    source.connect(offlineContext.destination);
    source.start(0);
    
    const renderedBuffer = await offlineContext.startRendering();
    return renderedBuffer.getChannelData(0);
  }, []);

  /**
   * Send control signal via WebRTC data channel
   */
  const sendDataChannelMessage = useCallback((data: any) => {
    if (dataChannelRef.current && dataChannelRef.current.readyState === 'open') {
      try {
        dataChannelRef.current.send(JSON.stringify(data));
      } catch (error) {
        console.error('Error sending data channel message:', error);
        onError?.(error as Error);
      }
    }
  }, [onError]);

  /**
   * Setup WebRTC connection and signaling
   */
  const setupWebRTC = useCallback(async () => {
    if (pcRef.current) {
      return; // Already initialized
    }

    console.log('Setting up WebRTC connection');
    
    // Create RTCPeerConnection
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    pcRef.current = pc;

    // Handle incoming audio track (AI audio)
    pc.ontrack = (event) => {
      console.log('Received remote track:', event.track.kind);
      if (event.track.kind === 'audio') {
        // Create audio element for playback
        if (!audioElementRef.current) {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.playsInline = true;
          
          // Add error handlers
          audio.onerror = (e) => {
            console.error('Audio element error:', e, audio.error);
          };
          
          audio.onloadedmetadata = () => {
            console.log('Audio metadata loaded, ready to play');
          };
          
          audio.oncanplay = () => {
            console.log('Audio can play, attempting to play');
            audio.play().catch(err => {
              console.error('Failed to play audio:', err);
            });
          };
          
          audio.onplay = () => {
            console.log('Audio started playing');
            setAiStatus('speaking');
            setIsAiSpeaking(true);
            isAiSpeakingRef.current = true;
          };
          
          audio.onpause = () => {
            console.log('Audio paused');
          };
          
          audio.onended = () => {
            console.log('Audio ended');
          };
          
          // Track audio data flow
          const track = event.track;
          track.onmute = () => {
            console.warn('Audio track muted');
          };
          
          track.onunmute = () => {
            console.log('Audio track unmuted');
          };
          
          document.body.appendChild(audio);
          audioElementRef.current = audio;
        }
        
        // Attach stream to audio element
        const stream = new MediaStream([event.track]);
        audioElementRef.current.srcObject = stream;
        
        // Explicitly try to play (required by some browsers)
        audioElementRef.current.play().catch(err => {
          console.error('Failed to autoplay audio:', err);
          // User interaction might be required
        });
        
        console.log('Audio track attached to audio element, stream:', stream.id, 'track:', event.track.id);
        
        setAiStatus('typing');
        setIsAiSpeaking(true);
        isAiSpeakingRef.current = true;
      }
    };

    // Handle ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate && socketRef.current) {
        socketRef.current.emit('signal', {
          type: 'candidate',
          candidate: event.candidate,
          sessionId: sessionId
        });
      }
    };

    // Handle connection state changes
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      const iceState = pc.iceConnectionState;
      const iceGathering = pc.iceGatheringState;
      console.log(`WebRTC connection state: ${state}, ICE: ${iceState}, Gathering: ${iceGathering}`);
      
      if (state === 'connected') {
        console.log('WebRTC connection established!');
        setConnectionState('connected');
        setIsRecording(true);
        setAiStatus('listening');
      } else if (state === 'disconnected' || state === 'failed') {
        console.warn(`WebRTC connection ${state}`);
        setConnectionState('disconnected');
        setIsRecording(false);
        clearPlayback();
      }
    };
    
    // Add ICE connection state monitoring
    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      console.log(`ICE connection state: ${iceState}`);
      if (iceState === 'failed') {
        console.error('ICE connection failed - connection may not work');
      } else if (iceState === 'connected' || iceState === 'completed') {
        console.log(`ICE connection ${iceState}`);
      }
    };
    
    // Add ICE gathering state monitoring
    pc.onicegatheringstatechange = () => {
      console.log(`ICE gathering state: ${pc.iceGatheringState}`);
    };

    // Create data channel for control signals and transcripts
    const dataChannel = pc.createDataChannel('control');
    dataChannelRef.current = dataChannel;

    dataChannel.onopen = () => {
      console.log('Data channel opened');
    };

    dataChannel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log('Received data channel message:', data);

        if (data.type === 'transcript') {
          const textContent = data.text?.trim();
          const isPartial = data.isPartial === true;
          
          if (textContent) {
            setAiStatus('typing');
            setMessages((prev) => {
              const lastMessage = prev[prev.length - 1];
              if (lastMessage && lastMessage.role === 'ai' && (lastMessage.isPartial || isPartial)) {
                return [
                  ...prev.slice(0, -1),
                  { ...lastMessage, text: textContent, isPartial: isPartial }
                ];
              } else {
                return [...prev, {
                  id: generateMessageId(),
                  role: 'ai' as const,
                  text: textContent,
                  isPartial: isPartial
                }];
              }
            });
          }
        } else if (data.type === 'turn_complete') {
          // AI turn completed
          console.log('AI turn completed');
          setAiStatus('listening');
          setIsAiSpeaking(false);
          isAiSpeakingRef.current = false;
        } else if (data.type === 'state') {
          // Handle state updates if needed
          console.log('State update:', data.state);
        }
      } catch (error) {
        console.error('Error processing data channel message:', error);
      }
    };

    // Setup Socket.IO for signaling
    const socket = io(socketUrl, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 5,
      withCredentials: true,
      autoConnect: true,
    });
    socketRef.current = socket;

    socket.on('connect', () => {
      console.log('Socket.IO connected for signaling');
      
      // CRITICAL: Join the session room FIRST before sending offer
      if (sessionId) {
        console.log(`Joining session room: session:${sessionId}`);
        socket.emit('join_session', { sessionId: sessionId });
        
        // Wait for session join confirmation, then create offer
        socket.once('session_joined', () => {
          console.log('Session joined, creating WebRTC offer');
          createWebRTCOffer();
        });
        
        // Fallback: If no confirmation, proceed after short delay
        setTimeout(() => {
          if (pc.localDescription === null) {
            console.log('Proceeding with offer creation (session join timeout)');
            createWebRTCOffer();
          }
        }, 500);
      } else {
        console.warn('No sessionId, creating offer without joining room');
        createWebRTCOffer();
      }
      
      function createWebRTCOffer() {
        // Create offer
        pc.createOffer().then(async (offer) => {
          await pc.setLocalDescription(offer);
          
          // Send offer via Socket.IO
          socket.emit('signal', {
            type: 'offer',
            sdp: offer.sdp,
            sessionId: sessionId,
            persona: persona
          });
          console.log('Sent WebRTC offer');
        }).catch((error) => {
          console.error('Error creating offer:', error);
          onError?.(error as Error);
        });
      }
    });

    // Listen for signaling messages
    socket.on('signal', async (data: { type: string; sdp?: string; candidate?: RTCIceCandidateInit; sessionId?: string }) => {
      try {
        console.log(`Received signaling message: ${data.type}`, { 
          hasSdp: !!data.sdp, 
          hasCandidate: !!data.candidate,
          sessionId: data.sessionId 
        });
        
        if (data.type === 'answer' && data.sdp) {
          // Check current signaling state before setting remote description
          const currentState = pc.signalingState;
          console.log('Current signaling state:', currentState);
          
          // Only set if we're in 'have-local-offer' state (waiting for answer)
          if (currentState === 'have-local-offer') {
            console.log('Setting remote description (answer), SDP length:', data.sdp.length);
            await pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp: data.sdp }));
            console.log('Remote description (answer) set successfully');
          } else {
            console.warn(`Ignoring duplicate answer - wrong signaling state: ${currentState}. Expected: have-local-offer`);
          }
        } else if (data.type === 'candidate' && data.candidate) {
          console.log('Adding ICE candidate:', {
            type: data.candidate.type,
            address: data.candidate.address || data.candidate.ip,
            port: data.candidate.port
          });
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
          console.log('ICE candidate added successfully');
        } else {
          console.warn('Unknown or incomplete signaling message:', data.type);
        }
      } catch (error) {
        console.error('Error handling signaling message:', error, data);
        onError?.(error as Error);
      }
    });
    
    // Listen for session join confirmation
    socket.on('session_joined', (data: { sessionId: string }) => {
      console.log('Session joined confirmation received:', data);
    });

    socket.on('disconnect', () => {
      console.log('Socket.IO disconnected');
      setConnectionState('disconnected');
    });

    socket.on('error', (error) => {
      console.error('Socket.IO error:', error);
      onError?.(new Error('Socket.IO connection error'));
    });
  }, [socketUrl, sessionId, persona, clearPlayback, onError]);

  /**
   * End audio call
   */
  const endCall = useCallback(() => {
    shouldReconnectRef.current = false;

    // Close WebRTC peer connection
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }

    // Close data channel
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }

    // Close Socket.IO connection
    if (socketRef.current) {
      socketRef.current.disconnect();
      socketRef.current = null;
    }

    // Remove audio element
    if (audioElementRef.current) {
      audioElementRef.current.srcObject = null;
      audioElementRef.current.remove();
      audioElementRef.current = null;
    }

    // Stop media stream
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // Stop VAD
    if (vadRef.current) {
      try {
        vadRef.current.pause();
        vadRef.current.destroy();
      } catch (error) {
        console.error('Error stopping VAD:', error);
      }
      vadRef.current = null;
    }
    if (speakingTimerRef.current) {
      clearTimeout(speakingTimerRef.current);
      speakingTimerRef.current = null;
    }

    // Reset speech state
    isUserSpeakingRef.current = false;
    isAiSpeakingRef.current = false;
    setIsUserSpeaking(false);
    setIsAiSpeaking(false);

    // Stop Speech Recognition
    if (speechRecognitionRef.current) {
      try {
        speechRecognitionRef.current.stop();
      } catch (error) {
        console.error('Error stopping Speech Recognition:', error);
      }
      speechRecognitionRef.current = null;
    }
    currentUserMessageRef.current = '';

    // Clear messages
    setMessages([]);

    // Close AudioContext
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }

    // Clear refs
    activeAudioSourcesRef.current = [];
    nextPlayTimeRef.current = 0;
    jitterBufferRef.current = [];
    jitterBufferProcessingRef.current = false;
    firstChunkTimeRef.current = null;

    setConnectionState('disconnected');
    setIsRecording(false);
    setAiStatus('idle');
  }, []);

  /**
   * Start audio call
   */
  const startCall = useCallback(async () => {
    try {
      setConnectionState('connecting');
      shouldReconnectRef.current = true;
      setAiStatus('listening');

      // Create AudioContext
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      audioContextRef.current = audioContext;
      nextPlayTimeRef.current = audioContext.currentTime;

      // Get user media with strict constraints
      const getStream = async () => {
        const supported = navigator.mediaDevices.getSupportedConstraints?.() || {};
        const baseConstraints: MediaTrackConstraints = {
          channelCount: 1,
          echoCancellation: supported.echoCancellation !== false ? true : undefined,
          noiseSuppression: supported.noiseSuppression !== false ? true : undefined,
          autoGainControl: supported.autoGainControl !== false ? true : undefined,
          sampleRate: (supported as any).sampleRate || supported.sampleRate === undefined ? targetSampleRate : undefined,
          suppressLocalAudioPlayback: (supported as any).suppressLocalAudioPlayback !== false ? true : undefined,
        };

        const advanced: MediaTrackConstraintSet[] = [];
        if ((supported as any).voiceIsolation) {
          advanced.push({ voiceIsolation: true } as MediaTrackConstraintSet);
        }
        if ((supported as any).googEchoCancellation) {
          advanced.push({ googEchoCancellation: true } as MediaTrackConstraintSet);
        }

        return await navigator.mediaDevices.getUserMedia({
          audio: {
            ...baseConstraints,
            ...(advanced.length ? { advanced } : {}),
          },
        });
      };

      // Get the stream first
      const stream = await getStream();
      mediaStreamRef.current = stream;

      // Setup WebRTC connection
      await setupWebRTC();
      
      // Add microphone track to WebRTC peer connection
      if (pcRef.current) {
        stream.getAudioTracks().forEach(track => {
          pcRef.current!.addTrack(track, stream);
        });
        console.log('Added microphone track to WebRTC');
      }

      // Check file accessibility before VAD initialization
      const checkFiles = async () => {
        const files = ['/silero_vad.onnx', '/vad.worklet.bundle.min.js', '/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs', '/onnxruntime-web/ort-wasm-simd-threaded.jsep.mjs?import'];
        const results = await Promise.all(files.map(async (file) => {
          try {
            const res = await fetch(file, { method: 'HEAD' });
            return { file, status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()) };
          } catch (e) {
            return { file, status: 'error', error: String(e) };
          }
        }));
      };
      await checkFiles();
      

      // Initialize VAD for speech detection
      // Use local paths for assets (served from public directory)
      const vad = await MicVAD.new({
        getStream: async () => stream,
        onSpeechStart: () => {
          // Debounce barge-in to ignore short noises/echo
          if (speakingTimerRef.current) {
            clearTimeout(speakingTimerRef.current);
          }
          speakingTimerRef.current = setTimeout(() => {
            speakingTimerRef.current = null;
            isUserSpeakingRef.current = true;
            setIsUserSpeaking(true);
            setAiStatus('listening');
            currentUserMessageRef.current = '';
            setMessages((prev) => prev.filter((msg) => !(msg.role === 'user' && msg.isPartial)));
            if (activeAudioSourcesRef.current.length > 0) {
              clearPlayback();
            }
            // Send turn start signal via WebRTC data channel
            sendDataChannelMessage({ type: 'turn_start' });
          }, SPEAKING_DEBOUNCE_MS);
        },
        onSpeechEnd: () => {
          // Speech ended; if debounce not elapsed, cancel pending barge-in
          if (speakingTimerRef.current) {
            clearTimeout(speakingTimerRef.current);
            speakingTimerRef.current = null;
            return;
          }
          isUserSpeakingRef.current = false;
          setIsUserSpeaking(false);
          setAiStatus('thinking');
          
          // Send turn completion signal via WebRTC data channel
          sendDataChannelMessage({ type: 'turn_complete' });
        },
        onVADMisfire: () => {
          // VAD misfire - can be ignored or logged
        },
        // Use local paths - files are in public directory
        baseAssetPath: "/",
        onnxWASMBasePath: "/onnxruntime-web/",
        // Explicitly set model URL to ensure it's found
        modelURL: "/silero_vad.onnx",
      });

      vadRef.current = vad;

      // Start VAD
      vad.start();

      // Setup Speech Recognition for user transcript
      const SpeechRecognition = window.SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (SpeechRecognition) {
        const recognition = new SpeechRecognition();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';

        recognition.onresult = (event: SpeechRecognitionEvent) => {
          let interimTranscript = '';
          let finalTranscript = '';

          for (let i = event.resultIndex; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalTranscript += transcript + ' ';
            } else {
              interimTranscript += transcript;
            }
          }

          // Update current user message
          if (finalTranscript.trim()) {
            // Final result - add to messages
            setMessages((prev) => {
              // Remove any existing partial user message
              const filtered = prev.filter((msg) => !(msg.role === 'user' && msg.isPartial));
              const newMsg = {
                id: generateMessageId(),
                role: 'user' as const,
                text: finalTranscript.trim(),
                isPartial: false
              };
              return [
                ...filtered,
                newMsg
              ];
            });
            currentUserMessageRef.current = '';
          } else if (interimTranscript.trim()) {
            // Interim result - update partial message
            const fullText = currentUserMessageRef.current + interimTranscript;
            setMessages((prev) => {
              const lastMessage = prev[prev.length - 1];
              if (lastMessage && lastMessage.role === 'user' && lastMessage.isPartial) {
                // Update existing partial message
                return [
                  ...prev.slice(0, -1),
                  { ...lastMessage, text: fullText }
                ];
              } else {
                // Create new partial message
                const newPartial = {
                  id: generateMessageId(),
                  role: 'user' as const,
                  text: fullText,
                  isPartial: true
                };
                return [
                  ...prev,
                  newPartial
                ];
              }
            });
            currentUserMessageRef.current = fullText;
          }
        };

        recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
          console.warn('Speech Recognition error:', event.error);
          // Graceful degradation - continue without user transcript
        };

        recognition.onend = () => {
          // Restart recognition if call is still active
          if (isRecording && pcRef.current && pcRef.current.connectionState === 'connected') {
            try {
              recognition.start();
            } catch (e) {
              // Recognition may already be starting
            }
          }
        };

        try {
          recognition.start();
          speechRecognitionRef.current = recognition;
        } catch (e) {
          console.warn('Could not start Speech Recognition:', e);
        }
      }

      // WebRTC is already set up in setupWebRTC() above

    } catch (error) {
      console.error('Error starting call:', error);
      const errorDetails = error instanceof Error ? {
        name: error.name,
        message: error.message,
        stack: error.stack?.substring(0, 500),
      } : { error: String(error) };
      setConnectionState('error');
      setIsRecording(false);
      onError?.(error as Error);
      endCall();
    }
  }, [targetSampleRate, setupWebRTC, clearPlayback, endCall, onError, sendDataChannelMessage]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      endCall();
    };
  }, [endCall]);

  return {
    isConnected: connectionState === 'connected',
    connectionState,
    isRecording,
    messages,
    isUserSpeaking,
    isAiSpeaking,
    aiStatus,
    startCall,
    endCall,
    clearPlayback,
  };
}


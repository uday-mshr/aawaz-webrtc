# Voice Bot Implementation Documentation
## Complete Architecture & Implementation Guide for Google Gemini Brainstormer

---

## Table of Contents

1. [System Overview](#system-overview)
2. [Architecture Components](#architecture-components)
3. [Technology Stack](#technology-stack)
4. [Complete Call Flow](#complete-call-flow)
5. [Frontend Implementation](#frontend-implementation)
6. [Backend Implementation](#backend-implementation)
7. [Worker Implementation](#worker-implementation)
8. [Redis Architecture](#redis-architecture)
9. [VAD (Voice Activity Detection) Mechanism](#vad-voice-activity-detection-mechanism)
10. [Barge-in Mechanism](#barge-in-mechanism)
11. [Gemini Model Integration](#gemini-model-integration)
12. [Audio Processing Pipeline](#audio-processing-pipeline)
13. [WebRTC Signaling Flow](#webrtc-signaling-flow)
14. [Session Management](#session-management)
15. [Error Handling & Resilience](#error-handling--resilience)

---

## System Overview

This is a real-time voice bot system that enables natural, conversational interactions between users and AI assistants powered by Google Gemini. The system uses WebRTC for low-latency bidirectional audio streaming, Redis for pub/sub messaging, and a Python worker for processing audio with Gemini API.

### Key Features:
- **Real-time bidirectional audio streaming** via WebRTC
- **Voice Activity Detection (VAD)** for automatic speech detection
- **Barge-in capability** allowing users to interrupt AI responses
- **Multiple persona support** (restaurant receptionist, university counsellor, clinic receptionist)
- **Echo cancellation** and audio gating to prevent feedback loops
- **Jitter buffering** for smooth audio playback
- **Session persistence** in MongoDB

---

## Architecture Components

```
┌─────────────────┐
│   Frontend      │  React + TypeScript + Vite
│   (Browser)     │  - WebRTC Peer Connection
└────────┬────────┘  - VAD (Silero VAD)
         │           - Audio Playback
         │           - Socket.IO Client
         │
         │ WebSocket (Socket.IO)
         │
┌────────▼────────┐
│   Backend       │  Node.js + TypeScript + Express
│   (Gateway)     │  - Socket.IO Server
└────────┬────────┘  - Session Management (MongoDB)
         │           - Redis Pub/Sub
         │
         │ Redis Pub/Sub
         │
┌────────▼────────┐
│   Worker        │  Python + asyncio
│   (Python)      │  - WebRTC Peer Connection (aiortc)
└────────┬────────┘  - Gemini API Integration
         │           - Audio Processing (PyAV)
         │
         │ WebSocket
         │
┌────────▼────────┐
│   Gemini API    │  Google Gemini 2.5 Flash Native Audio
│   (External)    │  - Real-time Audio Streaming
└─────────────────┘  - Voice Synthesis (Kore voice)
```

---

## Technology Stack

### Frontend
- **Framework**: React 18+ with TypeScript
- **Build Tool**: Vite
- **WebRTC**: Native browser WebRTC APIs
- **VAD**: `@ricky0123/vad-web` (Silero VAD model)
- **ONNX Runtime**: `onnxruntime-web` (WASM)
- **Signaling**: Socket.IO client
- **Audio**: Web Audio API

### Backend (Gateway)
- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **WebSocket**: Socket.IO
- **Database**: MongoDB (Mongoose)
- **Cache/Pub-Sub**: Redis (ioredis)
- **Adapter**: Socket.IO Redis Adapter (for scaling)

### Worker
- **Language**: Python 3.9+
- **WebRTC**: `aiortc`
- **Audio Processing**: `PyAV` (FFmpeg bindings)
- **Gemini API**: `google.genai` (official SDK)
- **Async**: `asyncio`
- **Redis**: `redis.asyncio`

### Infrastructure
- **Containerization**: Docker + Docker Compose
- **Database**: MongoDB 6
- **Message Broker**: Redis 7
- **Reverse Proxy**: (Optional) Nginx

---

## Complete Call Flow

### 1. Session Initiation

```
User → Frontend → Backend → MongoDB
  │
  ├─> User fills form (name, email, mobile, persona)
  ├─> Frontend calls Socket.IO: 'initiate_session'
  ├─> Backend creates session in MongoDB
  ├─> Backend emits 'session_created' with sessionId
  └─> Frontend stores sessionId
```

**Code Flow:**
1. User initiates call in `VoiceDemo.tsx` or `QATestPage.tsx`
2. `useAudioStream` hook calls `startCall()`
3. Socket.IO emits `initiate_session` with user data
4. Backend `socket.service.ts` handles `initiate_session` event
5. `session.service.ts` creates MongoDB document
6. Backend emits `session_created` event
7. Frontend receives `sessionId` and stores it

### 2. WebRTC Connection Setup

```
Frontend                    Backend                    Worker
   │                          │                          │
   ├─> create RTCPeerConnection                          │
   ├─> createOffer()                                       │
   ├─> setLocalDescription(offer)                         │
   ├─> emit('signal', {type: 'offer', sdp, sessionId})   │
   │                          │                          │
   │                          ├─> Redis Publish            │
   │                          │   signaling:to_worker:    │
   │                          │   persona:{p}:session:{s}│
   │                          │                          │
   │                          │                          ├─> Redis Subscribe
   │                          │                          ├─> Create WebRTCSession
   │                          │                          ├─> handle_offer()
   │                          │                          ├─> createAnswer()
   │                          │                          ├─> setLocalDescription(answer)
   │                          │                          ├─> Redis Publish answer
   │                          │                          │
   │                          ├─> Redis Subscribe         │
   │                          ├─> Socket.IO emit         │
   │                          │   'signal' (answer)       │
   │                          │                          │
   ├─> receive 'signal' (answer)                         │
   ├─> setRemoteDescription(answer)                      │
   │                          │                          │
   ├─> ICE Candidates exchange (bidirectional)          │
   │                          │                          │
   └─> WebRTC Connection Established                     │
```

### 3. Audio Streaming Flow

#### User Speech → Gemini

```
Browser Microphone
    │
    ├─> MediaStream (getUserMedia)
    ├─> VAD Detection (Silero VAD)
    │   ├─> onSpeechStart → emit 'turn_start' via data channel
    │   └─> onSpeechEnd → emit 'turn_complete' via data channel
    │
    ├─> WebRTC Audio Track (Opus, 48kHz)
    │
    ├─> WebRTC Peer Connection
    │
    └─> Worker receives audio track
        │
        ├─> AudioProcessor.process_incoming_audio()
        │   └─> Resample: 48kHz → 16kHz (PCM)
        │
        ├─> GeminiVoiceProxy.process_audio_chunk()
        │   └─> Convert to base64 PCM16
        │
        └─> Gemini API WebSocket
            └─> realtimeInput.mediaChunks
```

#### Gemini Response → User

```
Gemini API WebSocket
    │
    ├─> serverContent.modelTurn.parts[].inlineData.data
    │   └─> Base64 PCM16 audio (24kHz)
    │
    ├─> GeminiVoiceProxy._receive_responses()
    │   └─> Decode base64 → numpy array (int16)
    │
    ├─> Callback: _on_gemini_audio()
    │   └─> Queue audio for WebRTC
    │
    ├─> AudioTrack.recv() (WebRTC outgoing track)
    │   └─> AudioProcessor.process_outgoing_audio()
    │       └─> Resample: 24kHz → 48kHz (Opus)
    │
    └─> Browser WebRTC Peer Connection
        │
        ├─> Audio playback via Web Audio API
        ├─> Jitter buffer (150ms)
        └─> Echo cancellation & gating
```

---

## Frontend Implementation

### Core Hook: `useAudioStream`

**Location**: `sample-frontend/src/hooks/useAudioStream.ts`

**Key Responsibilities:**
1. **WebRTC Connection Management**
   - Creates RTCPeerConnection with STUN server
   - Handles offer/answer exchange
   - Manages ICE candidates
   - Monitors connection state

2. **VAD Integration**
   - Initializes Silero VAD model
   - Detects speech start/end
   - Debounces barge-in (300ms)
   - Sends turn_start/turn_complete via data channel

3. **Audio Playback**
   - Jitter buffer (150ms delay)
   - Sequential playback scheduling
   - Echo cancellation fingerprinting
   - Audio gating to prevent feedback

4. **State Management**
   - Connection state (disconnected/connecting/connected/error)
   - User speaking state
   - AI speaking state
   - AI status (idle/listening/thinking/typing)

### VAD Configuration

```typescript
const vad = await MicVAD.new({
  getStream: async () => stream,
  onSpeechStart: () => {
    // Debounce barge-in (300ms)
    // Clear AI playback
    // Send turn_start via data channel
  },
  onSpeechEnd: () => {
    // Send turn_complete via data channel
    // Update AI status to 'thinking'
  },
  baseAssetPath: "/",
  onnxWASMBasePath: "/onnxruntime-web/",
  modelURL: "/silero_vad.onnx",
});
```

### Audio Gating Mechanism

**Purpose**: Prevent microphone from picking up AI's own voice (echo cancellation)

**Implementation**:
1. **Fingerprint AI Playback**: Store recent AI audio chunks with RMS, peak, and correlation fingerprint
2. **Compare Mic Input**: When VAD detects activity, compare mic audio with AI fingerprint
3. **Gate Decision**: If correlation > 0.7 and energy matches, gate the mic input
4. **Barge-in Override**: Never gate when VAD confirms user is speaking

```typescript
const shouldGateAudio = (audioData: Float32Array): boolean => {
  // Never gate during confirmed user speech
  if (isUserSpeakingRef.current) return false;
  
  // Compare with recent AI playback fingerprints
  const correlation = computeCorrelation(audioData, latestFingerprint);
  const energyMatch = micRms <= avgAiRms * 1.15;
  
  return (energyMatch || correlation >= 0.7) && isAiSpeakingRef.current;
};
```

### Jitter Buffer

**Purpose**: Smooth audio playback despite network jitter

**Implementation**:
- **Buffer Size**: 150ms delay
- **Minimum Ready Chunks**: 5 chunks before starting playback
- **Timestamp-based Sorting**: Handle out-of-order packets
- **Sequential Scheduling**: Schedule audio chunks sequentially to prevent gaps

```typescript
const processJitterBuffer = () => {
  // Sort by timestamp
  jitterBufferRef.current.sort((a, b) => a.timestamp - b.timestamp);
  
  // Find ready chunks (timestamp <= now - jitter_delay)
  const readyChunks = jitterBufferRef.current.filter(
    chunk => chunk.timestamp <= readyThreshold
  );
  
  // Play sequentially
  let currentPlayTime = Math.max(playTime, nextPlayTimeRef.current);
  for (const chunk of readyChunks) {
    source.start(currentPlayTime);
    currentPlayTime += buffer.duration;
  }
};
```

---

## Backend Implementation

### Socket.IO Service

**Location**: `voice-gateway/src/services/socket.service.ts`

**Key Responsibilities:**

1. **Session Management Events**
   - `initiate_session`: Create new session
   - `join_session`: Join existing session
   - `end_session`: Terminate session

2. **WebRTC Signaling Relay**
   - Receives signaling from frontend (`signal` event)
   - Publishes to Redis: `signaling:to_worker:persona:{persona}:session:{sessionId}`
   - Subscribes to Redis: `signaling:to_frontend:persona:{persona}:session:{sessionId}`
   - Emits to frontend via Socket.IO rooms

3. **Redis Adapter**
   - Uses Socket.IO Redis Adapter for horizontal scaling
   - Enables multiple backend instances to share socket state

### Session Service

**Location**: `voice-gateway/src/services/session.service.ts`

**Database Schema** (MongoDB):
```typescript
{
  sessionId: string (UUID),
  persona: 'restaurant_receptionist' | 'university_admission_counsellor' | 'clinic_receptionist',
  userInfo: {
    name: string,
    email: string,
    mobile: string
  },
  socketId: string,
  status: 'active' | 'ended' | 'timeout',
  conversationState: {
    intent?: string,
    bookingDetails?: {...},
    orderDetails?: {...}
  },
  geminiConfig: {
    model: string,
    systemPrompt: string,
    persona: string
  },
  createdAt: Date,
  endedAt?: Date,
  duration?: number
}
```

### Redis Service

**Location**: `voice-gateway/src/services/redis.service.ts`

**Channels Used:**

1. **Signaling Channels** (Persona-specific)
   - `signaling:to_worker:persona:{persona}:session:{sessionId}`
     - Direction: Backend → Worker
     - Messages: WebRTC offers, ICE candidates from frontend
   
   - `signaling:to_frontend:persona:{persona}:session:{sessionId}`
     - Direction: Worker → Backend → Frontend
     - Messages: WebRTC answers, ICE candidates from worker

2. **Session Control Channels** (Optional)
   - `session_control:persona:{persona}:session:{sessionId}`
   - `builder_events:persona:{persona}:session:{sessionId}`

---

## Worker Implementation

### Session Manager

**Location**: `sample-worker/session_manager.py`

**Key Components:**

1. **SessionManager Class**
   - Manages multiple WebRTC sessions
   - Subscribes to Redis signaling channels
   - Creates WebRTCSession instances per session

2. **WebRTCSession Class**
   - Represents single WebRTC peer connection
   - Handles offer/answer exchange
   - Manages audio tracks (incoming/outgoing)
   - Integrates with GeminiVoiceProxy

### WebRTC Session Lifecycle

```python
async def initialize(self):
    # 1. Create RTCPeerConnection
    self.pc = RTCPeerConnection(configuration)
    
    # 2. Setup data channel handler
    @self.pc.on("datachannel")
    def on_datachannel(channel):
        # Handle control messages (turn_start, turn_complete, interrupt)
    
    # 3. Setup audio track handler
    @self.pc.on("track")
    def on_track(track):
        # Process incoming audio from frontend
    
    # 4. Setup ICE candidate handler
    @self.pc.on("icecandidate")
    def on_icecandidate(event):
        # Send ICE candidates to frontend via Redis
    
    # 5. Create outgoing audio track
    self.audio_track = AudioTrack(self._audio_queue)
    self.pc.addTrack(self.audio_track)
    
    # 6. Initialize Gemini proxy when connection established
    # (Multiple fallback mechanisms)
```

### Audio Processing

**Location**: `sample-worker/audio_processor.py`

**Resampling Pipeline:**

1. **Incoming Audio** (Frontend → Gemini)
   - Input: Opus/48kHz (WebRTC)
   - Process: Decode Opus → PCM → Resample to 16kHz
   - Output: PCM16/16kHz (Gemini input format)

2. **Outgoing Audio** (Gemini → Frontend)
   - Input: PCM16/24kHz (Gemini output)
   - Process: Resample to 48kHz → Encode to Opus
   - Output: Opus/48kHz (WebRTC format)

**Code:**
```python
# Incoming
resampled_frames = self.incoming_resampler.resample(frame)  # 48kHz → 16kHz
audio_data = resampled_frames.to_ndarray()

# Outgoing
frame = av.AudioFrame.from_ndarray(pcm_audio_2d, format='s16', layout='mono')
frame.rate = 24000  # Gemini output rate
resampled_frames = self.outgoing_resampler.resample(frame)  # 24kHz → 48kHz
```

### Gemini Voice Proxy

**Location**: `sample-worker/gemini_proxy.py`

**Key Features:**

1. **WebSocket Connection**
   - Connects to: `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={api_key}`
   - Keepalive: ping_interval=20s, ping_timeout=10s

2. **Setup Message**
   ```python
   {
     "setup": {
       "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",
       "generationConfig": {
         "responseModalities": ["AUDIO"],
         "temperature": 0.55,
         "topP": 0.9,
         "topK": 40,
         "enableAffectiveDialog": True,
         "speechConfig": {
           "voiceConfig": {
             "prebuiltVoiceConfig": {"voiceName": "Kore"}
           }
         }
       },
       "realtimeInputConfig": {
         "automaticActivityDetection": {"disabled": True}  # We handle VAD
       },
       "systemInstruction": {
         "parts": [{"text": system_prompt}]
       },
       "outputAudioTranscription": {}
     }
   }
   ```

3. **Audio Input**
   - Format: Base64-encoded PCM16, 16kHz
   - Message:
     ```python
     {
       "realtimeInput": {
         "mediaChunks": [{
           "mimeType": "audio/pcm;rate=16000",
           "data": base64_audio
         }]
       }
     }
     ```

4. **Activity Signals**
   - `activity_start`: User started speaking (sent when VAD detects speech)
   - `activity_end`: User finished speaking (sent when VAD detects silence for 2.5s)

5. **Response Handling**
   - **Audio**: `serverContent.modelTurn.parts[].inlineData.data` (base64 PCM16, 24kHz)
   - **Text**: `serverContent.outputTranscription.text` or `modelTurn.parts[].text`
   - **Turn Complete**: `serverContent.turnComplete`

---

## Redis Architecture

### Pub/Sub Pattern

**Why Redis?**
- Decouples frontend, backend, and worker
- Enables horizontal scaling (multiple workers/backends)
- Persona-specific routing (each persona can have dedicated workers)

### Channel Naming Convention

```
signaling:to_worker:persona:{persona}:session:{sessionId}
signaling:to_frontend:persona:{persona}:session:{sessionId}
```

**Benefits:**
- Persona isolation (different workers per persona)
- Session-specific channels (no message collision)
- Easy subscription patterns (wildcard support)

### Message Format

```json
{
  "type": "offer" | "answer" | "candidate",
  "sdp": "...",  // For offer/answer
  "candidate": {...},  // For ICE candidates
  "sessionId": "uuid"
}
```

### Subscription Flow

**Backend:**
```typescript
// Subscribe to worker → frontend signaling
redisService.subClient.on('message', (channel, message) => {
  const match = channel.match(/^signaling:to_frontend:persona:([^:]+):session:(.+)$/);
  if (match) {
    const [, persona, sessionId] = match;
    io.to(`session:${sessionId}`).emit('signal', JSON.parse(message));
  }
});
```

**Worker:**
```python
# Subscribe to frontend → worker signaling
await redis_client.subscribe(
    f"signaling:to_worker:persona:{persona}:session:*",
    self._handle_signaling_message
)
```

---

## VAD (Voice Activity Detection) Mechanism

### Silero VAD Model

**Model**: Silero VAD (ONNX format)
**Location**: `sample-frontend/public/silero_vad.onnx`
**Runtime**: ONNX Runtime Web (WASM)

### Detection Flow

```
Microphone Stream
    │
    ├─> VAD Worklet (AudioWorklet)
    │   └─> ONNX Model Inference
    │
    ├─> Speech Probability Threshold
    │   └─> Default: 0.5 (configurable)
    │
    ├─> onSpeechStart
    │   ├─> Debounce (300ms) to filter false positives
    │   ├─> Clear AI playback (barge-in)
    │   ├─> Set isUserSpeaking = true
    │   └─> Send 'turn_start' via data channel
    │
    └─> onSpeechEnd
        ├─> Set isUserSpeaking = false
        ├─> Set AI status = 'thinking'
        └─> Send 'turn_complete' via data channel
```

### Debouncing

**Purpose**: Filter out short noises, clicks, or echo artifacts

**Implementation**:
```typescript
onSpeechStart: () => {
  if (speakingTimerRef.current) {
    clearTimeout(speakingTimerRef.current);
  }
  speakingTimerRef.current = setTimeout(() => {
    // Only trigger if speech continues for 300ms
    isUserSpeakingRef.current = true;
    sendDataChannelMessage({ type: 'turn_start' });
  }, SPEAKING_DEBOUNCE_MS); // 300ms
}
```

### VAD Configuration

```typescript
const vad = await MicVAD.new({
  getStream: async () => stream,
  onSpeechStart: handleSpeechStart,
  onSpeechEnd: handleSpeechEnd,
  onVADMisfire: () => {
    // Handle false positives (optional)
  },
  baseAssetPath: "/",
  onnxWASMBasePath: "/onnxruntime-web/",
  modelURL: "/silero_vad.onnx",
  workletURL: "/vad.worklet.bundle.min.js",
});
```

---

## Barge-in Mechanism

### What is Barge-in?

Barge-in allows users to interrupt the AI's response mid-sentence, similar to natural human conversation.

### Implementation Flow

```
AI Speaking
    │
    ├─> Audio playback active (isAiSpeaking = true)
    │
    ├─> User starts speaking
    │   │
    │   ├─> VAD detects speech (onSpeechStart)
    │   │
    │   ├─> clearPlayback()
    │   │   ├─> Stop all active AudioBufferSourceNode instances
    │   │   ├─> Clear jitter buffer
    │   │   ├─> Clear AI playback fingerprints
    │   │   └─> Reset playback timing
    │   │
    │   ├─> Send 'interrupt' or 'turn_start' via data channel
    │   │
    │   └─> Worker receives interrupt
    │       ├─> Clear audio queue
    │       └─> Signal activity_end to Gemini (optional)
    │
    └─> User audio now streams to Gemini
```

### Code Implementation

**Frontend:**
```typescript
onSpeechStart: () => {
  // Clear AI playback immediately
  if (activeAudioSourcesRef.current.length > 0) {
    clearPlayback();
  }
  
  // Send turn_start signal
  sendDataChannelMessage({ type: 'turn_start' });
}
```

**Worker:**
```python
async def _handle_interrupt(self):
    """Handle user interrupt"""
    logger.info("User interrupted")
    # Clear audio queue
    self._audio_queue = asyncio.Queue()
    
    # Signal activity_end to Gemini (optional)
    if self.gemini_proxy:
        await self.gemini_proxy.signal_activity_end()
```

### Audio Gating During Barge-in

When user speaks, the system:
1. **Stops AI playback** immediately
2. **Clears jitter buffer** to prevent delayed audio
3. **Disables audio gating** (allows user audio through)
4. **Sends turn_start** to worker/Gemini

---

## Gemini Model Integration

### Model Details

- **Model**: `gemini-2.5-flash-native-audio-preview-12-2025`
- **Voice**: Kore (prebuilt voice)
- **Input Format**: PCM16, 16kHz, mono
- **Output Format**: PCM16, 24kHz, mono
- **Modalities**: Audio-only (responseModalities: ["AUDIO"])

### Configuration

```python
{
  "setup": {
    "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",
    "generationConfig": {
      "responseModalities": ["AUDIO"],
      "temperature": 0.55,  # Balanced creativity
      "topP": 0.9,
      "topK": 40,
      "enableAffectiveDialog": True,  # Emotional responses
      "speechConfig": {
        "voiceConfig": {
          "prebuiltVoiceConfig": {"voiceName": "Kore"}
        }
      }
    },
    "realtimeInputConfig": {
      "automaticActivityDetection": {
        "disabled": True  # We handle VAD manually
      }
    },
    "systemInstruction": {
      "parts": [{
        "text": persona_system_prompt
      }]
    },
    "outputAudioTranscription": {}  # Get text transcripts
  }
}
```

### Persona System Prompts

**Restaurant Receptionist:**
```
You are a friendly restaurant receptionist. Help customers with:
- Table bookings
- Extending existing bookings
- Takeaway orders
- For other queries, schedule a callback
Be professional, courteous, and efficient.
```

**University Admission Counsellor:**
```
You are a university admission counsellor. Help students with:
- Course information
- Admission requirements
- Application process
- Scholarship opportunities
Be helpful, informative, and supportive.
```

**Clinic Receptionist:**
```
You are a clinic receptionist. Help patients with:
- Appointment scheduling
- Doctor availability
- Medical records
- Insurance queries
Be professional, empathetic, and organized.
```

### Audio Streaming Protocol

**Input (User → Gemini):**
```python
{
  "realtimeInput": {
    "mediaChunks": [{
      "mimeType": "audio/pcm;rate=16000",
      "data": base64_encoded_pcm16_audio
    }]
  }
}
```

**Output (Gemini → User):**
```json
{
  "serverContent": {
    "modelTurn": {
      "parts": [{
        "inlineData": {
          "data": "base64_encoded_pcm16_audio_24khz"
        }
      }]
    },
    "outputTranscription": {
      "text": "transcribed text"
    },
    "turnComplete": true
  }
}
```

### Activity Detection

Since `automaticActivityDetection` is disabled, we manually signal:

1. **activity_start**: When VAD detects user speech
   ```python
   {
     "realtimeInput": {
       "activity_start": {}
     }
   }
   ```

2. **activity_end**: When user stops speaking (2.5s silence timeout)
   ```python
   {
     "realtimeInput": {
       "activity_end": {}
     }
   }
   ```

---

## Audio Processing Pipeline

### Complete Audio Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    USER SPEECH → GEMINI                     │
└─────────────────────────────────────────────────────────────┘

Browser Microphone
  │ (getUserMedia)
  ├─> MediaStream (native sample rate, typically 48kHz)
  │
  ├─> VAD Detection (Silero VAD)
  │   └─> Speech start/end events
  │
  ├─> WebRTC Audio Track
  │   └─> Opus encoding, 48kHz
  │
  ├─> WebRTC Peer Connection
  │   └─> Network transmission
  │
  └─> Worker receives track
      │
      ├─> AudioProcessor.process_incoming_audio()
      │   ├─> Decode Opus → PCM
      │   └─> Resample: 48kHz → 16kHz
      │
      └─> GeminiVoiceProxy.process_audio_chunk()
          ├─> Convert numpy array → base64 PCM16
          └─> Send to Gemini WebSocket

┌─────────────────────────────────────────────────────────────┐
│                    GEMINI → USER PLAYBACK                    │
└─────────────────────────────────────────────────────────────┘

Gemini WebSocket
  │
  ├─> Base64 PCM16 audio (24kHz)
  │
  ├─> GeminiVoiceProxy._receive_responses()
  │   ├─> Decode base64 → numpy array (int16)
  │   └─> Callback: _on_gemini_audio()
  │
  ├─> AudioTrack.recv() (WebRTC outgoing track)
  │   └─> AudioProcessor.process_outgoing_audio()
  │       └─> Resample: 24kHz → 48kHz
  │
  ├─> WebRTC Peer Connection
  │   └─> Opus encoding, 48kHz
  │
  └─> Browser receives track
      │
      ├─> Web Audio API
      │   ├─> Jitter buffer (150ms)
      │   ├─> Sequential playback
      │   └─> Echo cancellation fingerprinting
      │
      └─> Speaker output
```

### Sample Rate Conversions

| Stage | Format | Sample Rate | Channels | Encoding |
|-------|--------|-------------|-----------|----------|
| Browser Mic | Float32 | Native (48kHz) | Mono | - |
| WebRTC (TX) | Opus | 48kHz | Mono | Opus |
| Worker Input | PCM16 | 48kHz | Mono | - |
| Worker → Gemini | PCM16 | 16kHz | Mono | Base64 |
| Gemini Output | PCM16 | 24kHz | Mono | Base64 |
| Worker → WebRTC | PCM16 | 48kHz | Mono | - |
| WebRTC (RX) | Opus | 48kHz | Mono | Opus |
| Browser Playback | Float32 | 48kHz | Mono | - |

### Resampling Quality

**Library**: PyAV (FFmpeg bindings)
- Uses `libswresample` for high-quality resampling
- Automatic quality settings (best quality by default)
- Handles mono/stereo conversion

**Code:**
```python
# Incoming: 48kHz → 16kHz
self.incoming_resampler = av.AudioResampler(
    format='s16',
    layout='mono',
    rate=16000
)

# Outgoing: 24kHz → 48kHz
self.outgoing_resampler = av.AudioResampler(
    format='s16',
    layout='mono',
    rate=48000
)
```

---

## WebRTC Signaling Flow

### Offer/Answer Exchange

```
┌──────────┐                    ┌──────────┐                    ┌──────────┐
│ Frontend │                    │ Backend  │                    │  Worker  │
└────┬─────┘                    └────┬─────┘                    └────┬─────┘
     │                                │                                │
     │ 1. createOffer()               │                                │
     │ 2. setLocalDescription(offer)  │                                │
     │                                │                                │
     │ 3. emit('signal', offer)      │                                │
     ├───────────────────────────────>│                                │
     │                                │                                │
     │                                │ 4. Redis Publish                │
     │                                │    signaling:to_worker:...     │
     │                                ├───────────────────────────────>│
     │                                │                                │
     │                                │                                │ 5. handle_offer()
     │                                │                                │ 6. setRemoteDescription(offer)
     │                                │                                │ 7. createAnswer()
     │                                │                                │ 8. setLocalDescription(answer)
     │                                │                                │
     │                                │ 9. Redis Publish                │
     │                                │    signaling:to_frontend:...   │
     │                                │<───────────────────────────────┤
     │                                │                                │
     │ 10. Socket.IO emit('signal')  │                                │
     │<───────────────────────────────┤                                │
     │                                │                                │
     │ 11. setRemoteDescription(answer)                                │
     │                                │                                │
```

### ICE Candidate Exchange

ICE candidates are exchanged bidirectionally:

**Frontend → Worker:**
```
Frontend generates ICE candidate
  → Socket.IO emit('signal', {type: 'candidate', candidate})
  → Backend Redis publish
  → Worker receives and adds via pc.addIceCandidate()
```

**Worker → Frontend:**
```
Worker generates ICE candidate
  → Redis publish
  → Backend Socket.IO emit
  → Frontend receives and adds via pc.addIceCandidate()
```

### Connection State Monitoring

**Frontend:**
```typescript
pc.onconnectionstatechange = () => {
  if (state === 'connected') {
    // Start audio streaming
  } else if (state === 'failed') {
    // Handle error
  }
};
```

**Worker:**
```python
@self.pc.on("connectionstatechange")
def on_connectionstatechange():
    if state == "connected":
        # Initialize Gemini proxy
    elif state in ["failed", "disconnected"]:
        # Cleanup session
```

---

## Session Management

### Session Lifecycle

```
1. CREATE
   ├─> User initiates session
   ├─> Backend creates MongoDB document
   ├─> Generate sessionId (UUID)
   └─> Status: 'active'

2. JOIN
   ├─> Frontend joins session room (Socket.IO)
   ├─> Backend validates session exists
   ├─> Update socketId in session
   └─> Subscribe to Redis channels

3. ACTIVE
   ├─> WebRTC connection established
   ├─> Audio streaming active
   ├─> Conversation state updates
   └─> Status: 'active'

4. END
   ├─> User ends call OR disconnect
   ├─> Backend updates status to 'ended'
   ├─> Calculate duration
   ├─> Unsubscribe from Redis channels
   └─> Cleanup WebRTC connections
```

### Session Data Model

```typescript
{
  sessionId: "uuid-v4",
  persona: "restaurant_receptionist",
  userInfo: {
    name: "John Doe",
    email: "john@example.com",
    mobile: "+1234567890"
  },
  socketId: "socket-io-id",
  status: "active" | "ended" | "timeout",
  conversationState: {
    intent: "table_booking",
    bookingDetails: {
      date: "2024-01-15",
      time: "19:00",
      guests: 4
    }
  },
  geminiConfig: {
    model: "gemini-2.5-flash-native-audio-preview-12-2025",
    systemPrompt: "...",
    persona: "restaurant_receptionist"
  },
  createdAt: ISODate,
  endedAt: ISODate,
  duration: 300  // seconds
}
```

### Session Cleanup

**On Disconnect:**
- Backend auto-ends session
- Worker closes WebRTC connection
- Worker closes Gemini WebSocket
- Redis channels unsubscribed

**On Explicit End:**
- Frontend emits `end_session`
- Backend updates MongoDB
- All connections closed gracefully

---

## Error Handling & Resilience

### Connection Failures

**WebRTC Connection Failed:**
- Frontend: Retry connection with exponential backoff
- Worker: Log error, cleanup session
- Backend: Notify frontend via Socket.IO

**Gemini WebSocket Disconnected:**
- Worker: Attempt reconnection (if session still active)
- Log error, notify via data channel
- Frontend: Show error message to user

### Audio Processing Errors

**Resampling Errors:**
- Return silence frame
- Log error
- Continue processing (graceful degradation)

**VAD Failures:**
- Fallback to manual push-to-talk (if implemented)
- Log error
- Continue with reduced functionality

### Redis Failures

**Connection Lost:**
- Backend: Retry connection
- Worker: Retry connection
- Log errors, notify administrators

**Message Loss:**
- Implement message acknowledgments (optional)
- Use Redis persistence (AOF/RDB)

### Session Recovery

**Frontend Reconnect:**
- Join existing session with `join_session`
- Resume WebRTC connection
- Continue conversation

**Worker Restart:**
- Sessions lost (need reconnection)
- Frontend detects disconnect
- User may need to restart call

---

## Deployment Architecture

### Docker Compose Services

```yaml
services:
  api:          # Backend (Node.js)
  frontend:     # Frontend (Vite dev server)
  worker:       # Python worker
  redis:        # Redis 7
  mongo:        # MongoDB 6
  mongo-express: # MongoDB UI (optional)
```

### Environment Variables

**Backend:**
- `NODE_ENV=production`
- `PORT=3000`
- `MONGO_URI=mongodb://mongo:27017/your_app_name`
- `REDIS_HOST=redis`
- `REDIS_PORT=6379`
- `CORS_ORIGIN=http://localhost:5173,http://localhost:3000`

**Worker:**
- `REDIS_HOST=redis`
- `REDIS_PORT=6379`
- `GEMINI_API_KEY=your-api-key`
- `PERSONA=restaurant_receptionist`
- `LOG_LEVEL=INFO`

**Frontend:**
- `VITE_API_URL=http://localhost:3000/api/v1`
- `VITE_SOCKET_URL=http://localhost:3000`

### Scaling Considerations

1. **Horizontal Scaling (Backend)**
   - Use Socket.IO Redis Adapter
   - Multiple backend instances share socket state
   - Load balancer required (sticky sessions optional)

2. **Horizontal Scaling (Worker)**
   - Multiple workers per persona
   - Redis pub/sub distributes sessions
   - Stateless workers (no shared state)

3. **Redis Clustering**
   - Redis Cluster for high availability
   - Sentinel for failover

4. **MongoDB Replication**
   - Replica set for read scaling
   - Sharding for write scaling (if needed)

---

## Performance Optimizations

### Audio Optimizations

1. **Jitter Buffer**: 150ms delay for smooth playback
2. **Chunk Batching**: Batch audio chunks to reduce WebSocket overhead
3. **Resampling Quality**: High-quality resampling (libswresample)
4. **Echo Cancellation**: Fingerprint-based gating

### Network Optimizations

1. **Opus Codec**: High-quality, low-latency audio codec
2. **ICE Candidate Filtering**: Prioritize host candidates
3. **STUN Server**: Google's public STUN server
4. **WebSocket Keepalive**: 20s ping interval

### Frontend Optimizations

1. **VAD Debouncing**: 300ms to reduce false positives
2. **Audio Gating**: Prevents echo feedback
3. **Jitter Buffer**: Handles network jitter
4. **Sequential Playback**: Prevents audio gaps

---

## Testing & Debugging

### Key Log Points

**Frontend:**
- WebRTC connection state changes
- VAD speech start/end events
- Audio playback events
- Socket.IO connection events

**Backend:**
- Session creation/join/end
- Redis pub/sub messages
- Socket.IO room joins

**Worker:**
- WebRTC offer/answer exchange
- Gemini WebSocket connection
- Audio processing (resampling)
- Activity start/end signals

### Debug Tools

1. **Browser DevTools**
   - WebRTC internals: `chrome://webrtc-internals`
   - Audio context: Web Audio API inspector
   - Network: WebSocket frames

2. **Redis CLI**
   ```bash
   redis-cli MONITOR  # Monitor all Redis commands
   redis-cli PUBSUB CHANNELS "signaling:*"  # List active channels
   ```

3. **MongoDB**
   ```bash
   mongosh
   use your_app_name
   db.sessions.find().pretty()
   ```

---

## Future Enhancements

1. **Multi-language Support**
   - VAD language detection
   - Gemini multi-language prompts

2. **Analytics & Monitoring**
   - Session duration tracking
   - Audio quality metrics
   - Error rate monitoring

3. **Advanced Features**
   - Screen sharing
   - Video calls
   - File sharing

4. **Performance**
   - WebRTC data channel for transcripts (reduce latency)
   - Adaptive bitrate based on network conditions
   - Server-side audio processing (optional)

---

## Conclusion

This implementation provides a complete, production-ready voice bot system with:

- ✅ Real-time bidirectional audio streaming
- ✅ Voice Activity Detection (VAD)
- ✅ Barge-in capability
- ✅ Echo cancellation
- ✅ Multiple persona support
- ✅ Scalable architecture (Redis pub/sub)
- ✅ Session persistence
- ✅ Error handling & resilience

The system is designed for horizontal scaling and can handle multiple concurrent sessions across different personas.

---

**Document Version**: 1.0  
**Last Updated**: 2024-12-XX  
**Author**: AI Assistant  
**For**: Google Gemini Brainstormer


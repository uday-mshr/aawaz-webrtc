import { useState, useEffect } from 'react';
import { Persona, PersonaDisplayNames } from '../types/persona';
import { createSession } from '../services/api';
import { useAudioStream } from '../hooks/useAudioStream';
import { io, Socket } from 'socket.io-client';
import '../index.css';

type SessionStatus = 'idle' | 'creating' | 'connecting' | 'connected' | 'recording' | 'error';
type VADStatus = 'listening' | 'speaking' | 'processing';

interface TranscriptMessage {
  type: 'user' | 'ai';
  text: string;
  timestamp: number;
}

function VoiceDemo() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [persona, setPersona] = useState<Persona>(Persona.RESTAURANT_RECEPTIONIST);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [status, setStatus] = useState<SessionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [vadStatus, setVadStatus] = useState<VADStatus>('listening');
  
  // Use WebRTC audio stream hook
  const {
    isConnected,
    connectionState,
    isRecording,
    messages,
    isUserSpeaking,
    isAiSpeaking,
    aiStatus,
    startCall,
    endCall,
    clearPlayback
  } = useAudioStream({
    sessionId: sessionId || undefined,
    persona: persona,
    onError: (err) => {
      console.error('WebRTC error:', err);
      setError(err.message);
      setStatus('error');
    }
  });

  // Update status based on WebRTC connection state
  useEffect(() => {
    if (connectionState === 'connected' && sessionId) {
      setStatus('connected');
    } else if (connectionState === 'connecting') {
      setStatus('connecting');
    } else if (connectionState === 'disconnected' || connectionState === 'error') {
      if (sessionId) {
        setStatus('error');
      } else {
        setStatus('idle');
      }
    }
  }, [connectionState, sessionId]);

  // Update VAD status based on speaking state
  useEffect(() => {
    if (isUserSpeaking) {
      setVadStatus('speaking');
    } else if (isAiSpeaking || aiStatus === 'typing') {
      setVadStatus('processing');
    } else {
      setVadStatus('listening');
    }
  }, [isUserSpeaking, isAiSpeaking, aiStatus]);

  // Update recording status
  useEffect(() => {
    if (isRecording && status === 'connected') {
      setStatus('recording');
    }
  }, [isRecording, status]);

  const handleStartCall = async () => {
    if (!name || !email || !mobile) {
      setError('Please fill in all fields');
      return;
    }

    setStatus('creating');
    setError(null);

    try {
      // Create session via REST API
      const response = await createSession({
        name,
        email,
        mobile,
        persona,
      });

      const newSessionId = response.data.sessionId;
      setSessionId(newSessionId);

      // Initiate session via Socket.IO for signaling setup
      setStatus('connecting');
      const socketUrl = import.meta.env.VITE_SOCKET_URL || 'http://localhost:3000';
      const socket: Socket = io(socketUrl, {
        transports: ['websocket', 'polling'],
        reconnection: false,
        autoConnect: true,
      });

      socket.on('connect', () => {
        // Initiate session on backend (this sets up signaling channels)
        socket.emit('initiate_session', {
          name,
          email,
          mobile,
          persona,
        });
      });

      socket.on('session_created', () => {
        // Session initiated, now we can start WebRTC call
        socket.disconnect();
        setStatus('connected');
        setError(null);
      });

      socket.on('session_error', (data: { code: string; message: string }) => {
        console.error('Session error:', data);
        setError(`${data.message} (${data.code})`);
        setStatus('error');
        socket.disconnect();
      });
    } catch (err: any) {
      console.error('Error creating session:', err);
      setError(err.response?.data?.message || err.message || 'Failed to create session');
      setStatus('error');
    }
  };

  const handleStartRecording = async () => {
    if (!sessionId) {
      setError('No active session');
      return;
    }

    try {
      setStatus('connecting');
      // Start WebRTC call - this will establish connection and start recording
      await startCall();
      setStatus('recording');
    } catch (err: any) {
      console.error('Error starting recording:', err);
      setError(err.message || 'Failed to start recording');
      setStatus('error');
    }
  };

  const handleStopRecording = () => {
    // Stop the call (this will stop recording)
    endCall();
    setStatus('connected');
  };

  const handleEndCall = () => {
    // End the WebRTC call
    endCall();
    setStatus('idle');
    setSessionId(null);
  };

  const getStatusMessage = () => {
    switch (status) {
      case 'idle':
        return 'Ready to start';
      case 'creating':
        return 'Creating session...';
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return 'Connected - Ready to talk';
      case 'recording':
        return vadStatus === 'speaking' ? 'Speaking...' : vadStatus === 'processing' ? 'Processing...' : 'Listening...';
      case 'error':
        return 'Error occurred';
      default:
        return '';
    }
  };

  const getStatusClass = () => {
    switch (status) {
      case 'idle':
        return 'info';
      case 'creating':
      case 'connecting':
        return 'warning';
      case 'connected':
      case 'recording':
        return 'success';
      case 'error':
        return 'error';
      default:
        return 'info';
    }
  };

  return (
    <div className="container">
      <div className="header">
        <h1>🎙️ Voice Gateway Demo</h1>
        <p>Experience AI-powered voice conversations</p>
      </div>

      <div className="content">
        {!sessionId ? (
          <>
            <div className={`status ${getStatusClass()}`}>{getStatusMessage()}</div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleStartCall();
              }}
            >
              <div className="form-group">
                <label htmlFor="name">Name *</label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Enter your name"
                  required
                  disabled={status !== 'idle'}
                />
              </div>

              <div className="form-group">
                <label htmlFor="email">Email *</label>
                <input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  required
                  disabled={status !== 'idle'}
                />
              </div>

              <div className="form-group">
                <label htmlFor="mobile">Mobile *</label>
                <input
                  id="mobile"
                  type="tel"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                  placeholder="Enter your mobile number"
                  required
                  disabled={status !== 'idle'}
                />
              </div>

              <div className="form-group">
                <label htmlFor="persona">Persona *</label>
                <select
                  id="persona"
                  value={persona}
                  onChange={(e) => setPersona(e.target.value as Persona)}
                  disabled={status !== 'idle'}
                  required
                >
                  {Object.entries(PersonaDisplayNames).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>

              {error && <div className="error-message">{error}</div>}

              <button
                type="submit"
                className="button"
                disabled={status !== 'idle'}
              >
                Start Call
              </button>
            </form>
          </>
        ) : (
          <>
            <div className={`status ${getStatusClass()}`}>{getStatusMessage()}</div>

            <div className="session-info">
              <h3>Session Information</h3>
              <p>
                <strong>Session ID:</strong> {sessionId}
              </p>
              <p>
                <strong>Persona:</strong> {PersonaDisplayNames[persona]}
              </p>
              <p>
                <strong>Status:</strong> {status}
              </p>
            </div>

            {error && <div className="error-message">{error}</div>}

            <div className="audio-controls">
              {!isRecording ? (
                <button
                  className="button"
                  onClick={handleStartRecording}
                  disabled={status !== 'connected'}
                >
                  🎤 Start Listening
                </button>
              ) : (
                <>
                  <div className="vad-status">
                    <span className={`vad-indicator ${vadStatus}`}>
                      {vadStatus === 'listening' && '👂 Listening...'}
                      {vadStatus === 'speaking' && '🎙️ Speaking...'}
                      {vadStatus === 'processing' && '⏳ Processing...'}
                    </span>
                  </div>
                  <button
                    className="button secondary"
                    onClick={handleStopRecording}
                  >
                    ⏸️ Stop Listening
                  </button>
                </>
              )}
              <button className="button danger" onClick={handleEndCall}>
                End Call
              </button>
            </div>

            {messages.length > 0 && (
              <div className="transcript">
                <h4>Conversation Transcript</h4>
                {messages.map((msg) => (
                  <div key={msg.id} className={`transcript-message ${msg.role}`}>
                    <strong>{msg.role === 'user' ? 'You' : 'AI'}:</strong> {msg.text}
                    {msg.isPartial && <span className="partial-indicator"> (typing...)</span>}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export default VoiceDemo;


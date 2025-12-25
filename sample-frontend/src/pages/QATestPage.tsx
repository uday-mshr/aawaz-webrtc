import { useState, useEffect, useRef } from 'react';
import peerAudioService, { AudioConstraints } from '../services/peerAudio.service';
import { useAudioMetrics } from '../hooks/useAudioMetrics';
import './QATestPage.css';

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
type SessionRole = 'host' | 'peer' | null;

function QATestPage() {
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected');
  const [sessionId, setSessionId] = useState<string>('');
  const [inputSessionId, setInputSessionId] = useState<string>('');
  const [sessionRole, setSessionRole] = useState<SessionRole>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [peerCount, setPeerCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  const [constraints, setConstraints] = useState<AudioConstraints>({
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  });

  const { metrics } = useAudioMetrics();
  const sessionIdRef = useRef<string>('');

  useEffect(() => {
    const socket = peerAudioService.connect();
    
    if (socket) {
      socket.on('connect', () => {
        setConnectionStatus('connected');
      });

      socket.on('disconnect', () => {
        setConnectionStatus('disconnected');
        setIsRecording(false);
      });

      socket.on('qa_session_joined', (data: { sessionId: string; peerCount?: number }) => {
        setPeerCount(data.peerCount || 1);
        setConnectionStatus('connected');
      });

      socket.on('qa_session_left', () => {
        setPeerCount((prev) => Math.max(0, prev - 1));
      });

      socket.on('session_error', (data: { code: string; message: string }) => {
        setError(data.message);
        setConnectionStatus('error');
      });
    }

    return () => {
      peerAudioService.endSession();
      peerAudioService.disconnect();
    };
  }, []);

  const handleCreateSession = async () => {
    try {
      setError(null);
      setConnectionStatus('connecting');
      const newSessionId = await peerAudioService.createQASession();
      setSessionId(newSessionId);
      sessionIdRef.current = newSessionId;
      setInputSessionId(newSessionId);
      setSessionRole('host');
      setConnectionStatus('connected');
    } catch (err: any) {
      setError(err.message || 'Failed to create session');
      setConnectionStatus('error');
    }
  };

  const handleJoinSession = async () => {
    if (!inputSessionId.trim()) {
      setError('Please enter a session ID');
      return;
    }

    try {
      setError(null);
      setConnectionStatus('connecting');
      await peerAudioService.joinQASession(inputSessionId.trim());
      setSessionId(inputSessionId.trim());
      sessionIdRef.current = inputSessionId.trim();
      setSessionRole('peer');
      setConnectionStatus('connected');
    } catch (err: any) {
      setError(err.message || 'Failed to join session');
      setConnectionStatus('error');
    }
  };

  const handleStartRecording = async () => {
    if (!sessionId) {
      setError('No active session');
      return;
    }

    try {
      await peerAudioService.startRecording(sessionId);
      setIsRecording(true);
      setError(null);
    } catch (err: any) {
      setError(err.message || 'Failed to start recording');
      setIsRecording(false);
    }
  };

  const handleStopRecording = () => {
    peerAudioService.stopRecording();
    setIsRecording(false);
  };

  const handleToggleMute = () => {
    if (isMuted) {
      peerAudioService.unmute();
    } else {
      peerAudioService.mute();
    }
    setIsMuted(!isMuted);
  };

  const handleToggleConstraint = (key: keyof AudioConstraints) => {
    const newConstraints = {
      ...constraints,
      [key]: !constraints[key],
    };
    setConstraints(newConstraints);
    peerAudioService.updateConstraints(newConstraints);
  };

  const handleEndCall = () => {
    peerAudioService.endSession();
    setSessionId('');
    setInputSessionId('');
    setSessionRole(null);
    setIsRecording(false);
    setConnectionStatus('disconnected');
    setPeerCount(0);
    setError(null);
  };

  const getStatusColor = () => {
    switch (connectionStatus) {
      case 'connected':
        return '#28a745';
      case 'connecting':
        return '#ffc107';
      case 'error':
        return '#dc3545';
      default:
        return '#6c757d';
    }
  };

  const getRmsPercentage = () => {
    // RMS is typically between 0 and 1, convert to percentage
    return Math.min(100, (metrics.rms / 0.1) * 100);
  };

  const getPeakPercentage = () => {
    // Peak is typically between 0 and 1, convert to percentage
    return Math.min(100, (metrics.peak / 0.5) * 100);
  };

  return (
    <div className="qa-container">
      <div className="qa-header">
        <h1>🔊 QA Peer-to-Peer Testing</h1>
        <p>Test socket implementation and noise cancellation</p>
      </div>

      <div className="qa-content">
        {/* Connection Status */}
        <div className="qa-status-section">
          <div className="status-indicator" style={{ backgroundColor: getStatusColor() }}>
            <span>{connectionStatus.toUpperCase()}</span>
          </div>
          {sessionId && (
            <div className="session-info">
              <p><strong>Session ID:</strong> {sessionId}</p>
              <p><strong>Role:</strong> {sessionRole}</p>
              <p><strong>Peers:</strong> {peerCount}</p>
            </div>
          )}
        </div>

        {/* Error Display */}
        {error && (
          <div className="qa-error">{error}</div>
        )}

        {/* Session Management */}
        {!sessionId ? (
          <div className="qa-session-setup">
            <div className="session-controls">
              <button className="qa-button primary" onClick={handleCreateSession}>
                Create Session
              </button>
              <div className="join-section">
                <input
                  type="text"
                  placeholder="Enter Session ID"
                  value={inputSessionId}
                  onChange={(e) => setInputSessionId(e.target.value)}
                  className="qa-input"
                />
                <button className="qa-button secondary" onClick={handleJoinSession}>
                  Join Session
                </button>
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Audio Controls */}
            <div className="qa-controls-section">
              <h3>Audio Controls</h3>
              <div className="control-buttons">
                {!isRecording ? (
                  <button className="qa-button primary" onClick={handleStartRecording}>
                    🎤 Start Recording
                  </button>
                ) : (
                  <button className="qa-button secondary" onClick={handleStopRecording}>
                    ⏸️ Stop Recording
                  </button>
                )}
                <button
                  className={`qa-button ${isMuted ? 'danger' : 'secondary'}`}
                  onClick={handleToggleMute}
                >
                  {isMuted ? '🔇 Unmute' : '🔊 Mute'}
                </button>
                <button className="qa-button danger" onClick={handleEndCall}>
                  End Call
                </button>
              </div>
            </div>

            {/* Noise Cancellation Controls */}
            <div className="qa-constraints-section">
              <h3>Noise Cancellation</h3>
              <div className="constraint-toggles">
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={constraints.echoCancellation}
                    onChange={() => handleToggleConstraint('echoCancellation')}
                  />
                  <span>Echo Cancellation</span>
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={constraints.noiseSuppression}
                    onChange={() => handleToggleConstraint('noiseSuppression')}
                  />
                  <span>Noise Suppression</span>
                </label>
                <label className="toggle-label">
                  <input
                    type="checkbox"
                    checked={constraints.autoGainControl}
                    onChange={() => handleToggleConstraint('autoGainControl')}
                  />
                  <span>Auto Gain Control</span>
                </label>
              </div>
            </div>

            {/* Audio Level Meters */}
            <div className="qa-meters-section">
              <h3>Audio Levels</h3>
              <div className="meter-container">
                <div className="meter-label">RMS</div>
                <div className="meter-bar">
                  <div
                    className="meter-fill"
                    style={{ width: `${getRmsPercentage()}%` }}
                  />
                </div>
                <div className="meter-value">{metrics.rms.toFixed(4)}</div>
              </div>
              <div className="meter-container">
                <div className="meter-label">Peak</div>
                <div className="meter-bar">
                  <div
                    className="meter-fill peak"
                    style={{ width: `${getPeakPercentage()}%` }}
                  />
                </div>
                <div className="meter-value">{metrics.peak.toFixed(4)}</div>
              </div>
            </div>

            {/* Metrics Display */}
            <div className="qa-metrics-section">
              <h3>Audio Metrics</h3>
              <div className="metrics-grid">
                <div className="metric-item">
                  <div className="metric-label">Sample Rate</div>
                  <div className="metric-value">{metrics.sampleRate} Hz</div>
                </div>
                <div className="metric-item">
                  <div className="metric-label">Latency</div>
                  <div className="metric-value">
                    {metrics.latency !== undefined ? `${metrics.latency} ms` : 'N/A'}
                  </div>
                </div>
                <div className="metric-item">
                  <div className="metric-label">Correlation</div>
                  <div className="metric-value">
                    {metrics.correlation !== undefined
                      ? metrics.correlation.toFixed(3)
                      : 'N/A'}
                  </div>
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export default QATestPage;


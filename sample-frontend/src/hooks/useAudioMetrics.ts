import { useState, useEffect, useRef } from 'react';
import peerAudioService, { AudioMetrics } from '../services/peerAudio.service';

export interface AudioMetricsState {
  rms: number;
  peak: number;
  sampleRate: number;
  latency?: number;
  correlation?: number;
}

export function useAudioMetrics() {
  const [metrics, setMetrics] = useState<AudioMetricsState>({
    rms: 0,
    peak: 0,
    sampleRate: 16000,
  });

  const metricsRef = useRef<AudioMetricsState>(metrics);
  const sentAudioRef = useRef<Float32Array[]>([]);
  const receivedAudioRef = useRef<Float32Array[]>([]);

  useEffect(() => {
    const unsubscribe = peerAudioService.onMetrics((newMetrics: AudioMetrics) => {
      metricsRef.current = {
        ...newMetrics,
        correlation: calculateCorrelation(),
      };
      setMetrics(metricsRef.current);
    });

    return unsubscribe;
  }, []);

  const calculateCorrelation = (): number | undefined => {
    // Simple correlation calculation between sent and received audio
    // This is a simplified version - in production, you'd want more sophisticated echo detection
    if (sentAudioRef.current.length === 0 || receivedAudioRef.current.length === 0) {
      return undefined;
    }

    // For now, return a placeholder correlation value
    // In a real implementation, you'd compare audio fingerprints
    return 0.0;
  };

  const updateSentAudio = (audio: Float32Array) => {
    sentAudioRef.current.push(audio);
    // Keep only last 5 chunks
    if (sentAudioRef.current.length > 5) {
      sentAudioRef.current.shift();
    }
  };

  const updateReceivedAudio = (audio: Float32Array) => {
    receivedAudioRef.current.push(audio);
    // Keep only last 5 chunks
    if (receivedAudioRef.current.length > 5) {
      receivedAudioRef.current.shift();
    }
  };

  return {
    metrics,
    updateSentAudio,
    updateReceivedAudio,
  };
}


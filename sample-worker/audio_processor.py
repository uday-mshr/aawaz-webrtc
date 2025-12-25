"""
Audio Processor
Handles audio resampling between WebRTC (Opus/48kHz) and Gemini (PCM/16kHz input, 24kHz output)
"""

import asyncio
import logging
import av
import numpy as np
from typing import Optional

logger = logging.getLogger(__name__)


class AudioProcessor:
    """Processes audio between WebRTC and Gemini formats"""
    
    # WebRTC audio format: Opus, 48kHz
    WEBRTC_SAMPLE_RATE = 48000
    WEBRTC_CHANNELS = 1  # Mono
    WEBRTC_FORMAT = 's16'  # 16-bit signed PCM
    
    # Gemini audio format: PCM, 16kHz input, 24kHz output
    GEMINI_INPUT_SAMPLE_RATE = 16000  # For incoming audio to Gemini
    GEMINI_OUTPUT_SAMPLE_RATE = 24000  # For outgoing audio from Gemini
    GEMINI_CHANNELS = 1  # Mono
    GEMINI_FORMAT = 's16'  # 16-bit signed PCM

    FRAME_DURATION_MS = 20
    GEMINI_OUTPUT_FRAME_SAMPLES = int(GEMINI_OUTPUT_SAMPLE_RATE * FRAME_DURATION_MS / 1000)
    WEBRTC_FRAME_SAMPLES = int(WEBRTC_SAMPLE_RATE * FRAME_DURATION_MS / 1000)
    
    def __init__(self):
        # Create resampler for incoming audio (48kHz -> 16kHz for Gemini input)
        self.incoming_resampler = av.AudioResampler(
            format=self.GEMINI_FORMAT,
            layout='mono',
            rate=self.GEMINI_INPUT_SAMPLE_RATE
        )
        
        # Create resampler for outgoing audio (24kHz -> 48kHz) - CRITICAL for quality
        # Configure for best quality resampling using libswresample's highest quality algorithm
        self.outgoing_resampler = av.AudioResampler(
            format=self.WEBRTC_FORMAT,
            layout='mono',
            rate=self.WEBRTC_SAMPLE_RATE
        )

        self._configure_resampler(self.incoming_resampler, direction="incoming")
        self._configure_resampler(self.outgoing_resampler, direction="outgoing")

        self._outgoing_buffer = np.zeros(0, dtype=np.int16)
        self._smoothed_gain = 1.0
        
        logger.info("Audio processor initialized with resamplers (48kHz->16kHz input, 24kHz->48kHz output)")

    def _configure_resampler(self, resampler: av.AudioResampler, direction: str) -> None:
        """Configure resampler for higher quality if supported by PyAV/libswresample."""
        try:
            if hasattr(resampler, 'set_option'):
                # Prefer soxr for higher quality if available.
                resampler.set_option('resampler', 'soxr')
                resampler.set_option('precision', '28')
                resampler.set_option('filter_size', '64')
                resampler.set_option('phase_shift', '10')
            else:
                logger.debug(f"Resampler options not supported for {direction} audio.")
        except Exception as e:
            logger.warning(
                f"Could not set resampler quality options for {direction} audio: {e}. Using default quality."
            )

    def _to_mono(self, audio_data: np.ndarray) -> np.ndarray:
        """Ensure mono audio without introducing integer overflow."""
        if len(audio_data.shape) == 1:
            return audio_data
        if audio_data.shape[0] == 1:
            return audio_data[0]
        return np.mean(audio_data.astype(np.float32), axis=0).astype(audio_data.dtype)

    def _apply_limiter(self, pcm_audio: np.ndarray) -> np.ndarray:
        """Apply a gentle limiter with smoothing to avoid pumping and clipping."""
        if pcm_audio.size == 0:
            return pcm_audio

        peak = float(np.max(np.abs(pcm_audio)))
        if peak == 0:
            return pcm_audio

        target_peak = 0.95 * 32767.0
        desired_gain = min(1.0, target_peak / peak)

        # Fast attack, slow release to avoid pumping
        attack = 0.4
        release = 0.08
        if desired_gain < self._smoothed_gain:
            self._smoothed_gain = (1 - attack) * self._smoothed_gain + attack * desired_gain
        else:
            self._smoothed_gain = (1 - release) * self._smoothed_gain + release * desired_gain

        if self._smoothed_gain >= 0.999:
            return pcm_audio

        limited = pcm_audio.astype(np.float32) * self._smoothed_gain
        return np.clip(limited, -32768, 32767).astype(np.int16)
    
    async def process_incoming_audio(self, frame: av.AudioFrame) -> Optional[np.ndarray]:
        """
        Process incoming audio from WebRTC (Opus/48kHz) -> PCM/16kHz for Gemini
        
        Args:
            frame: AudioFrame from WebRTC (Opus, 48kHz)
            
        Returns:
            numpy array of PCM audio data (16kHz, int16)
        """
        try:
            # Resample from 48kHz to 16kHz
            resampled_frames = self.incoming_resampler.resample(frame)
            
            # Convert to numpy array
            # resampled_frames can be a list of frames or a single frame
            if isinstance(resampled_frames, list):
                if len(resampled_frames) == 0:
                    return None
                # Concatenate all frames
                audio_data = np.concatenate([f.to_ndarray() for f in resampled_frames])
            else:
                audio_data = resampled_frames.to_ndarray()
            
            # Ensure mono (single channel)
            audio_data = self._to_mono(audio_data)
            
            # Convert to int16 if needed
            if audio_data.dtype != np.int16:
                # Normalize to [-1, 1] range and convert to int16
                if audio_data.dtype == np.float32 or audio_data.dtype == np.float64:
                    audio_data = (audio_data * 32767).astype(np.int16)
                else:
                    audio_data = audio_data.astype(np.int16)
            
            return audio_data
        
        except Exception as e:
            logger.error(f"Error processing incoming audio: {e}", exc_info=True)
            return None
    
    async def process_outgoing_audio(self, pcm_audio: np.ndarray) -> av.AudioFrame:
        """
        Process outgoing audio from Gemini (PCM/24kHz) -> Opus/48kHz for WebRTC
        
        Args:
            pcm_audio: numpy array of PCM audio data (24kHz from Gemini, int16)
            
        Returns:
            AudioFrame for WebRTC (Opus, 48kHz)
        """
        try:
            # Ensure int16 format
            if pcm_audio.dtype != np.int16:
                pcm_audio = pcm_audio.astype(np.int16)
            
            # Ensure 1D array (mono)
            pcm_audio = self._to_mono(pcm_audio)

            # Buffer and frame the audio to stable 20ms chunks (prevents jitter/stutter)
            if self._outgoing_buffer.size == 0:
                self._outgoing_buffer = pcm_audio
            else:
                self._outgoing_buffer = np.concatenate([self._outgoing_buffer, pcm_audio])

            if self._outgoing_buffer.size >= self.GEMINI_OUTPUT_FRAME_SAMPLES:
                frame_audio = self._outgoing_buffer[:self.GEMINI_OUTPUT_FRAME_SAMPLES]
                self._outgoing_buffer = self._outgoing_buffer[self.GEMINI_OUTPUT_FRAME_SAMPLES:]
            else:
                pad_length = self.GEMINI_OUTPUT_FRAME_SAMPLES - self._outgoing_buffer.size
                frame_audio = np.pad(self._outgoing_buffer, (0, pad_length), mode='constant')
                self._outgoing_buffer = np.zeros(0, dtype=np.int16)

            frame_audio = self._apply_limiter(frame_audio)
            
            # Reshape to 2D: (channels=1, samples) for PyAV
            pcm_audio_2d = frame_audio.reshape(1, -1)
            
            # Create AudioFrame from numpy array (24kHz from Gemini)
            # CRITICAL: Explicitly set input sample rate to 24kHz before resampling
            frame = av.AudioFrame.from_ndarray(
                pcm_audio_2d,  # Shape: (channels, samples) as 2D numpy array
                format=self.GEMINI_FORMAT,
                layout='mono'
            )
            frame.rate = self.GEMINI_OUTPUT_SAMPLE_RATE  # Explicitly set: Gemini outputs 24kHz
            logger.debug(f"Resampling audio: input={frame.rate}Hz, samples={frame.samples}, output={self.WEBRTC_SAMPLE_RATE}Hz")
            
            # Resample from 24kHz to 48kHz (direct, better quality than 24->16->48)
            resampled_frames = self.outgoing_resampler.resample(frame)
            
            # Log resampling result for verification
            if isinstance(resampled_frames, list) and len(resampled_frames) > 0:
                logger.debug(f"Resampling complete: {len(resampled_frames)} frame(s), output rate={resampled_frames[0].rate}Hz, samples={resampled_frames[0].samples}")
            elif not isinstance(resampled_frames, list):
                logger.debug(f"Resampling complete: output rate={resampled_frames.rate}Hz, samples={resampled_frames.samples}")
            
            # resampled_frames can be a list or single frame
            if isinstance(resampled_frames, list):
                if len(resampled_frames) == 0:
                    # Return silence frame
                    silence_array = np.zeros((1, self.WEBRTC_FRAME_SAMPLES), dtype=np.int16)
                    silence_frame = av.AudioFrame.from_ndarray(
                        silence_array,
                        format=self.WEBRTC_FORMAT,
                        layout='mono'
                    )
                    silence_frame.rate = self.WEBRTC_SAMPLE_RATE
                    silence_frame.pts = 0  # Will be set by caller
                    return silence_frame
                
                # If multiple frames, concatenate them
                if len(resampled_frames) > 1:
                    combined_arrays = []
                    for f in resampled_frames:
                        arr = f.to_ndarray()
                        if len(arr.shape) == 1:
                            arr = arr.reshape(1, -1)
                        combined_arrays.append(arr)
                    
                    combined_audio = np.concatenate(combined_arrays, axis=1)
                    combined_frame = av.AudioFrame.from_ndarray(
                        combined_audio,
                        format=self.WEBRTC_FORMAT,
                        layout='mono'
                    )
                    combined_frame.rate = self.WEBRTC_SAMPLE_RATE
                    combined_frame.pts = 0  # Will be set by caller
                    return combined_frame
                
                # Single frame in list
                result_frame = resampled_frames[0]
                # Ensure rate is correct
                if result_frame.rate != self.WEBRTC_SAMPLE_RATE:
                    result_frame.rate = self.WEBRTC_SAMPLE_RATE
                result_frame.pts = 0  # Will be set by caller
                return result_frame
            else:
                # Single frame (not a list)
                if resampled_frames.rate != self.WEBRTC_SAMPLE_RATE:
                    resampled_frames.rate = self.WEBRTC_SAMPLE_RATE
                resampled_frames.pts = 0  # Will be set by caller
                return resampled_frames
        
        except Exception as e:
            logger.error(f"Error processing outgoing audio: {e}", exc_info=True)
            # Return silence frame on error
            silence_array = np.zeros((1, self.WEBRTC_FRAME_SAMPLES), dtype=np.int16)
            return av.AudioFrame.from_ndarray(
                silence_array,  # Shape: (channels, samples) as 2D numpy array
                format=self.WEBRTC_FORMAT,
                layout='mono'
            )
    
    async def cleanup(self):
        """Cleanup resources"""
        # Resamplers don't need explicit cleanup in av
        logger.debug("Audio processor cleaned up")

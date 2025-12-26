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
        
        # Create resampler for outgoing audio (24kHz -> 48kHz)
        # CRITICAL: Ensure format='s16', layout='mono', rate=48000 are strictly set
        self.outgoing_resampler = av.AudioResampler(
            format=self.WEBRTC_FORMAT,  # 's16' - 16-bit signed PCM
            layout='mono',  # Mono channel layout
            rate=self.WEBRTC_SAMPLE_RATE  # 48000 Hz for WebRTC
        )

        self._configure_resampler(self.incoming_resampler, direction="incoming")
        self._configure_resampler(self.outgoing_resampler, direction="outgoing")

        self._outgoing_buffer = np.zeros(0, dtype=np.int16)
        self._smoothed_gain = 1.0
        
        logger.info("Audio processor initialized with resamplers (48kHz->16kHz input, 24kHz->48kHz output)")
    
    @property
    def buffer_duration_ms(self) -> float:
        """Get current buffer duration in milliseconds"""
        if self._outgoing_buffer.size == 0:
            return 0.0
        return (self._outgoing_buffer.size / self.GEMINI_OUTPUT_SAMPLE_RATE) * 1000

    def _configure_resampler(self, resampler: av.AudioResampler, direction: str) -> None:
        """Configure resampler for higher quality if supported by PyAV/libswresample."""
        try:
            if hasattr(resampler, 'set_option'):
                # Prefer soxr for higher quality if available.
                resampler.set_option('resampler', 'soxr')
                resampler.set_option('precision', '28')  # High precision
                resampler.set_option('filter_size', '64')  # Larger filter for better quality
                resampler.set_option('phase_shift', '10')  # Better phase response
                # Enable dithering to reduce quantization artifacts
                try:
                    resampler.set_option('dither_scale', '1.0')
                except Exception:
                    # Dithering option may not be available in all PyAV versions
                    logger.debug(f"Dithering option not available for {direction} resampler")
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
    
    def _normalize_audio(self, audio_data: np.ndarray) -> np.ndarray:
        """Normalize audio to optimal level without clipping."""
        if audio_data.size == 0:
            return audio_data
        
        # Convert to float for processing
        audio_float = audio_data.astype(np.float32) / 32768.0
        
        # Calculate RMS
        rms = np.sqrt(np.mean(audio_float ** 2))
        
        # Target RMS for voice (around -18dB to -12dB)
        target_rms = 0.15  # Adjustable: 0.1 (quieter) to 0.2 (louder)
        
        if rms > 0.001:  # Avoid division by zero
            gain = target_rms / rms
            # Limit gain to prevent over-amplification
            gain = min(gain, 2.0)  # Max 2x amplification
            
            audio_float = audio_float * gain
            # Clip to prevent overflow
            audio_float = np.clip(audio_float, -1.0, 1.0)
            
            # Convert back to int16
            return (audio_float * 32767.0).astype(np.int16)
        
        return audio_data

    def _apply_limiter(self, pcm_audio: np.ndarray) -> np.ndarray:
        """Apply a gentle limiter with smoothing to avoid pumping and clipping."""
        if pcm_audio.size == 0:
            return pcm_audio

        peak = float(np.max(np.abs(pcm_audio)))
        if peak == 0:
            return pcm_audio

        # Increased target peak from 0.95 to 0.98 for less aggressive limiting
        target_peak = 0.98 * 32767.0
        desired_gain = min(1.0, target_peak / peak)

        # Slower attack and faster release for smoother, more natural limiting
        attack = 0.2  # Slower attack = less pumping
        release = 0.05  # Faster release = more natural
        if desired_gain < self._smoothed_gain:
            self._smoothed_gain = (1 - attack) * self._smoothed_gain + attack * desired_gain
        else:
            self._smoothed_gain = (1 - release) * self._smoothed_gain + release * desired_gain

        # Only apply if gain reduction is significant (avoid unnecessary processing)
        if self._smoothed_gain >= 0.995:
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
            
            # Normalize audio levels for optimal quality
            audio_data = self._normalize_audio(audio_data)
            
            return audio_data
        
        except Exception as e:
            logger.error(f"Error processing incoming audio: {e}", exc_info=True)
            return None
    
    def add_audio(self, pcm_audio: np.ndarray) -> None:
        """
        Add audio to buffer (input side).
        This method only appends audio to the buffer, it does not process or return frames.
        
        Args:
            pcm_audio: numpy array of PCM audio data (24kHz from Gemini, int16)
        """
        # CRITICAL: Ensure input is int16 format
        # If pcm_audio comes from raw bytes, use np.frombuffer with dtype=np.int16
        if not isinstance(pcm_audio, np.ndarray):
            # If it's bytes, convert using frombuffer
            pcm_audio = np.frombuffer(pcm_audio, dtype=np.int16)
        elif pcm_audio.dtype != np.int16:
            pcm_audio = pcm_audio.astype(np.int16)
        
        # Ensure 1D array (mono)
        pcm_audio = self._to_mono(pcm_audio)

        # Append to buffer
        if self._outgoing_buffer.size == 0:
            self._outgoing_buffer = pcm_audio
        else:
            self._outgoing_buffer = np.concatenate([self._outgoing_buffer, pcm_audio])
    
    def get_next_frame(self) -> Optional[av.AudioFrame]:
        """
        Get next ready frame from buffer (output side).
        This method extracts and processes frames from the buffer without requiring new input.
        
        Returns:
            AudioFrame for WebRTC (Opus, 48kHz) if buffer has enough data, None otherwise
        """
        try:
            # Check if buffer has enough samples for a complete frame
            if self._outgoing_buffer.size < self.GEMINI_OUTPUT_FRAME_SAMPLES:
                return None
            
            # Extract frame from buffer
            frame_audio = self._outgoing_buffer[:self.GEMINI_OUTPUT_FRAME_SAMPLES]
            self._outgoing_buffer = self._outgoing_buffer[self.GEMINI_OUTPUT_FRAME_SAMPLES:]
            logger.debug(f"[PATH: get_next_frame] Extracted frame: {len(frame_audio)} samples, buffer remaining: {self._outgoing_buffer.size}")

            # Apply limiter
            frame_audio = self._apply_limiter(frame_audio)
            
            # Reshape to 2D: (channels=1, samples) for PyAV
            pcm_audio_2d = frame_audio.reshape(1, -1)
            
            # Create AudioFrame from numpy array (24kHz from Gemini)
            # CRITICAL: Explicitly set input sample rate to 24kHz BEFORE resampling
            frame = av.AudioFrame.from_ndarray(
                pcm_audio_2d,  # Shape: (channels, samples) as 2D numpy array
                format=self.GEMINI_FORMAT,  # 's16' format
                layout='mono'  # Mono layout
            )
            # CRITICAL: Set sample rate to 24kHz (Gemini output rate) BEFORE calling resample()
            # PyAV must know the input is 24kHz to avoid distortion
            frame.rate = self.GEMINI_OUTPUT_SAMPLE_RATE  # 24000 Hz - Gemini outputs 24kHz
            # Also set sample_rate attribute if it exists (some PyAV versions use this)
            if hasattr(frame, 'sample_rate'):
                frame.sample_rate = self.GEMINI_OUTPUT_SAMPLE_RATE
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
            logger.error(f"Error getting next frame: {e}", exc_info=True)
            # Return None on error (caller will handle)
            return None
    
    async def process_outgoing_audio(self, pcm_audio: np.ndarray) -> Optional[av.AudioFrame]:
        """
        DEPRECATED: Use add_audio() and get_next_frame() instead.
        This method is kept for backward compatibility but should not be used.
        
        Process outgoing audio from Gemini (PCM/24kHz) -> Opus/48kHz for WebRTC
        
        Args:
            pcm_audio: numpy array of PCM audio data (24kHz from Gemini, int16)
            
        Returns:
            AudioFrame for WebRTC (Opus, 48kHz)
        """
        # Add audio to buffer
        self.add_audio(pcm_audio)
        # Try to get a frame
        return self.get_next_frame()
    
    async def cleanup(self):
        """Cleanup resources"""
        # Resamplers don't need explicit cleanup in av
        logger.debug("Audio processor cleaned up")

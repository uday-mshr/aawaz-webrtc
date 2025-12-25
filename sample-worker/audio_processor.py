"""
Audio Processor
Handles audio resampling between WebRTC (Opus/48kHz) and Gemini (PCM/16kHz)
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
    
    # Gemini audio format: PCM, 16kHz
    GEMINI_SAMPLE_RATE = 16000
    GEMINI_CHANNELS = 1  # Mono
    GEMINI_FORMAT = 's16'  # 16-bit signed PCM
    
    def __init__(self):
        # Create resampler for incoming audio (48kHz -> 16kHz)
        self.incoming_resampler = av.AudioResampler(
            format=self.GEMINI_FORMAT,
            layout='mono',
            rate=self.GEMINI_SAMPLE_RATE
        )
        
        # Create resampler for outgoing audio (16kHz -> 48kHz) - CRITICAL for quality
        # Note: PyAV's default resampler uses libswresample which provides good quality
        self.outgoing_resampler = av.AudioResampler(
            format=self.WEBRTC_FORMAT,
            layout='mono',
            rate=self.WEBRTC_SAMPLE_RATE
        )
        
        logger.info("Audio processor initialized with default resamplers")
    
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
            if len(audio_data.shape) > 1:
                audio_data = audio_data[0] if audio_data.shape[0] == 1 else np.mean(audio_data, axis=0)
            
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
        Process outgoing audio from Gemini (PCM/16kHz) -> Opus/48kHz for WebRTC
        
        Args:
            pcm_audio: numpy array of PCM audio data (16kHz, int16)
            
        Returns:
            AudioFrame for WebRTC (Opus, 48kHz)
        """
        try:
            # Ensure int16 format
            if pcm_audio.dtype != np.int16:
                pcm_audio = pcm_audio.astype(np.int16)
            
            # Ensure 1D array (mono)
            if len(pcm_audio.shape) > 1:
                pcm_audio = pcm_audio[0] if pcm_audio.shape[0] == 1 else np.mean(pcm_audio, axis=0)
            
            # Reshape to 2D: (channels=1, samples) for PyAV
            pcm_audio_2d = pcm_audio.reshape(1, -1) if len(pcm_audio.shape) == 1 else pcm_audio
            
            # Create AudioFrame from numpy array (16kHz)
            frame = av.AudioFrame.from_ndarray(
                pcm_audio_2d,  # Shape: (channels, samples) as 2D numpy array
                format=self.GEMINI_FORMAT,
                layout='mono'
            )
            frame.rate = self.GEMINI_SAMPLE_RATE
            
            # Resample from 16kHz to 48kHz
            resampled_frames = self.outgoing_resampler.resample(frame)
            
            # resampled_frames can be a list or single frame
            if isinstance(resampled_frames, list):
                if len(resampled_frames) == 0:
                    # Return silence frame - USE 2D NUMPY ARRAY
                    silence_array = np.zeros((1, 480), dtype=np.int16)
                    silence_frame = av.AudioFrame.from_ndarray(
                        silence_array,  # Shape: (channels, samples) as 2D numpy array
                        format=self.WEBRTC_FORMAT,
                        layout='mono'
                    )
                    silence_frame.rate = self.WEBRTC_SAMPLE_RATE
                    return silence_frame
                
                # If multiple frames, concatenate them to avoid losing audio data
                if len(resampled_frames) > 1:
                    # Combine all frames into one for smoother playback
                    combined_arrays = []
                    for f in resampled_frames:
                        arr = f.to_ndarray()
                        # Ensure 2D shape (channels, samples)
                        if len(arr.shape) == 1:
                            arr = arr.reshape(1, -1)
                        combined_arrays.append(arr)
                    
                    # Concatenate along the samples axis (axis=1)
                    combined_audio = np.concatenate(combined_arrays, axis=1)
                    combined_frame = av.AudioFrame.from_ndarray(
                        combined_audio,
                        format=self.WEBRTC_FORMAT,
                        layout='mono'
                    )
                    combined_frame.rate = self.WEBRTC_SAMPLE_RATE
                    return combined_frame
                
                # Single frame in list
                result_frame = resampled_frames[0]
                result_frame.rate = self.WEBRTC_SAMPLE_RATE
                return result_frame
            else:
                # Single frame (not a list)
                resampled_frames.rate = self.WEBRTC_SAMPLE_RATE
                return resampled_frames
        
        except Exception as e:
            logger.error(f"Error processing outgoing audio: {e}", exc_info=True)
            # Return silence frame on error - USE 2D NUMPY ARRAY
            silence_array = np.zeros((1, 480), dtype=np.int16)
            return av.AudioFrame.from_ndarray(
                silence_array,  # Shape: (channels, samples) as 2D numpy array
                format=self.WEBRTC_FORMAT,
                layout='mono'
            )
    
    async def cleanup(self):
        """Cleanup resources"""
        # Resamplers don't need explicit cleanup in av
        logger.debug("Audio processor cleaned up")


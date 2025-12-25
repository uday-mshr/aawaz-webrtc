"""Gemini Voice Proxy for handling audio streaming to/from Gemini API via WebRTC."""
import json
import asyncio
import base64
import websockets
import websockets.exceptions
import logging
import numpy as np
from typing import Optional, Callable

logger = logging.getLogger(__name__)


class GeminiVoiceProxy:
    """Proxy service for bidirectional audio streaming between WebRTC and Gemini API."""
    
    def __init__(self, session_id: str, gemini_api_key: str, system_prompt: str):
        self.session_id = session_id
        self.gemini_ws: Optional[websockets.WebSocketClientProtocol] = None
        self.gemini_url = f"wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key={gemini_api_key}"
        self.system_prompt = system_prompt
        self.current_text_accumulator = ""
        self._shutdown_event = asyncio.Event()
        self.empty_chunk_count = 0
        self.total_chunks_received = 0
        self.user_activity_active = False
        self.setup_complete = False
        self._receiver_task: Optional[asyncio.Task] = None
        self._receiver_lock = asyncio.Lock()
        self._is_closed = False
        self._activity_end_timer: Optional[asyncio.Task] = None
        self._last_audio_time = 0.0
        self._audio_sequence = 0
        
        # Callbacks for WebRTC integration
        self._on_audio: Optional[Callable[[np.ndarray], None]] = None
        self._on_text: Optional[Callable[[str, bool], None]] = None
        self._on_state: Optional[Callable[[dict], None]] = None
        
        logger.info(f"Initialized GeminiVoiceProxy for session: {session_id}")
    
    def _is_websocket_closed(self) -> bool:
        """Check if WebSocket connection is closed using the correct API."""
        if not self.gemini_ws:
            return True
        # websockets library: close_code is None when open, a number when closed
        if hasattr(self.gemini_ws, 'close_code'):
            return self.gemini_ws.close_code is not None
        # Fallback: try to access closed attribute (for older versions)
        try:
            return getattr(self.gemini_ws, 'closed', True)
        except AttributeError:
            # If neither attribute exists, assume closed
            return True
    
    def set_callbacks(self, on_audio: Callable[[np.ndarray], None], 
                     on_text: Callable[[str, bool], None], 
                     on_state: Callable[[dict], None]):
        """Set callbacks for audio, text, and state updates."""
        self._on_audio = on_audio
        self._on_text = on_text
        self._on_state = on_state
    
    async def connect(self) -> None:
        """Establish WebSocket connection to Gemini API with keepalive."""
        if self._is_closed:
            raise RuntimeError(f"Session {self.session_id} is closed and cannot reconnect")
        
        try:
            self.gemini_ws = await websockets.connect(
                self.gemini_url,
                ping_interval=20,
                ping_timeout=10,
                close_timeout=10
            )
            logger.info(f"Connected to Gemini API for session: {self.session_id}")
        except Exception as e:
            logger.error(f"Failed to connect to Gemini API for session {self.session_id}: {e}")
            self._is_closed = True
            raise
    
    async def send_setup_message(self) -> None:
        """Send setup message to Gemini with persona-specific prompt."""
        if not self.gemini_ws:
            raise RuntimeError("Gemini WebSocket not connected")
        
        setup_message = {
            "setup": {
                "model": "models/gemini-2.5-flash-native-audio-preview-12-2025",
                "generationConfig": {
                    "responseModalities": ["AUDIO"],
                    "temperature": 0.55,
                    "topP": 0.9,
                    "topK": 40,
                    "enableAffectiveDialog": True,
                    "speechConfig": {
                        "voiceConfig": {"prebuiltVoiceConfig": {"voiceName": "Kore"}}
                    }
                },
                "realtimeInputConfig": {
                    "automaticActivityDetection": {
                        "disabled": True
                    }
                },
                "systemInstruction": {
                    "parts": [{
                        "text": self.system_prompt
                    }]
                },
                "outputAudioTranscription": {}
            }
        }
        await self.gemini_ws.send(json.dumps(setup_message))
        logger.info(f"Setup message sent for session: {self.session_id}")
    
    async def process_audio_chunk(self, audio_data: np.ndarray) -> None:
        """Process incoming audio chunk (numpy array) and send to Gemini."""
        if self._is_closed:
            logger.warning(f"Session {self.session_id} is closed, ignoring audio chunk")
            return
        
        if self._is_websocket_closed():
            logger.warning(f"Gemini WebSocket not connected for session {self.session_id}, marking as closed")
            self._is_closed = True
            return
        
        if not self.setup_complete:
            logger.warning(f"Setup not complete yet for session: {self.session_id}, dropping audio chunk")
            return
        
        # Convert numpy array to bytes (int16 PCM)
        if audio_data.dtype != np.int16:
            audio_data = audio_data.astype(np.int16)
        
        audio_bytes = audio_data.tobytes()
        
        # Validate audio size
        if len(audio_bytes) < 320:
            logger.debug(f"Dropping too-small audio chunk ({len(audio_bytes)} bytes) for session: {self.session_id}")
            return
        if len(audio_bytes) % 2 != 0:
            logger.warning(f"Dropping misaligned audio chunk (len {len(audio_bytes)}) for session: {self.session_id}")
            return
        
        # Encode to base64
        b64_audio = base64.b64encode(audio_bytes).decode('utf-8')
        
        self.total_chunks_received += 1
        self._last_audio_time = asyncio.get_event_loop().time()

        # Cancel any pending activity_end timer since we're receiving audio
        if self._activity_end_timer and not self._activity_end_timer.done():
            self._activity_end_timer.cancel()
            self._activity_end_timer = None

        # Schedule activity_end after 2.5 seconds of silence
        self._schedule_activity_end()
        
        logger.debug(f"Processing audio chunk #{self.total_chunks_received} for session: {self.session_id}, size={len(audio_bytes)}")
        
        # Send to Gemini
        msg = {
            "realtimeInput": {
                "mediaChunks": [{
                    "mimeType": "audio/pcm;rate=16000",
                    "data": b64_audio
                }]
            }
        }
        
        try:
            await self.gemini_ws.send(json.dumps(msg))
            if self.total_chunks_received % 100 == 0:
                logger.info(f"Sent {self.total_chunks_received} audio chunks to Gemini for session: {self.session_id}")
        except Exception as e:
            logger.error(f"Error sending to Gemini for session {self.session_id}: {e}", exc_info=True)
            raise
    
    async def signal_activity_start(self) -> None:
        """Signal user activity start to Gemini."""
        if self._is_websocket_closed() or not self.setup_complete:
            return
        
        if self.user_activity_active:
            return
        
        try:
            msg = {
                "realtimeInput": {
                    "activity_start": {}
                }
            }
            await self.gemini_ws.send(json.dumps(msg))
            self.user_activity_active = True
            logger.info(f"Sent activity_start for session: {self.session_id}")
        except Exception as e:
            logger.error(f"Error sending activity_start for session {self.session_id}: {e}")
    
    async def signal_activity_end(self) -> None:
        """Signal user activity end to Gemini."""
        if self._is_websocket_closed() or not self.setup_complete:
            return
        
        try:
            msg = {
                "realtimeInput": {
                    "activity_end": {}
                }
            }
            await self.gemini_ws.send(json.dumps(msg))
            self.user_activity_active = False
            logger.info(f"Sent activity_end for session: {self.session_id}")
        except Exception as e:
            logger.error(f"Error sending activity_end for session {self.session_id}: {e}")
    
    async def start_receiver(self) -> None:
        """Start receiving responses from Gemini. Only one instance should run per session."""
        if not self.gemini_ws:
            raise RuntimeError("Gemini not connected")
        
        async with self._receiver_lock:
            if self._receiver_task and not self._receiver_task.done():
                logger.warning(f"Receiver task already running for session: {self.session_id}")
                return
            
            self._receiver_task = asyncio.create_task(self._receive_responses())
            logger.info(f"Receiver task started for session: {self.session_id}")
    
    async def _receive_responses(self) -> None:
        """Receive responses from Gemini and call callbacks."""
        logger.info(f"Receiver task started for session: {self.session_id}, waiting for responses from Gemini")
        
        message_count = 0
        try:
            while True:
                if self._shutdown_event.is_set():
                    logger.info(f"Shutdown event set for session: {self.session_id}")
                    break
                
                if self._is_websocket_closed():
                    logger.warning(f"Gemini WebSocket closed for session: {self.session_id}")
                    self._is_closed = True
                    break
                
                # Receive message from Gemini with timeout
                try:
                    message = await asyncio.wait_for(
                        self.gemini_ws.recv(),
                        timeout=60.0
                    )
                    message_count += 1
                    if message_count <= 5 or message_count % 10 == 0:
                        logger.info(f"Received message #{message_count} from Gemini for session: {self.session_id}")
                except asyncio.TimeoutError:
                    if self._is_websocket_closed():
                        logger.warning(f"Gemini WebSocket closed during timeout for session: {self.session_id}")
                        break
                    logger.debug(f"Timeout waiting for message from Gemini for session: {self.session_id}")
                    continue
                except websockets.exceptions.ConnectionClosed as e:
                    logger.warning(f"Gemini WebSocket connection closed for session {self.session_id}: code={e.code}, reason={e.reason}")
                    self._is_closed = True
                    break
                except Exception as e:
                    logger.error(f"Error receiving from Gemini for session {self.session_id}: {e}", exc_info=True)
                    self._is_closed = True
                    break
                
                # Handle bytes (decode to string) or string
                if isinstance(message, bytes):
                    try:
                        message = message.decode('utf-8')
                    except UnicodeDecodeError:
                        logger.error(f"Received non-UTF-8 binary data from Gemini for session {self.session_id}: {len(message)} bytes")
                        continue
                
                try:
                    response = json.loads(message)
                    
                    # Check for setupComplete
                    if "setupComplete" in response:
                        self.setup_complete = True
                        logger.info(f"Gemini setup complete for session: {self.session_id}")
                        if self._on_state:
                            self._on_state({"setupComplete": True})
                        continue
                    
                    # Check for errors
                    if "error" in response:
                        logger.error(f"Gemini API error for session {self.session_id}: {response.get('error')}")
                        if self._on_state:
                            self._on_state({"error": response.get('error')})
                        continue
                    
                    # Extract Audio and Text
                    server_content = response.get("serverContent", {})
                    model_turn = server_content.get("modelTurn", {})
                    parts = model_turn.get("parts", [])
                    
                    # Handle Audio
                    for part in parts:
                        if "inlineData" in part:
                            b64_audio = part["inlineData"]["data"]
                            self._audio_sequence += 1
                            logger.info(f"Received audio response from Gemini for session: {self.session_id}, size={len(b64_audio)}, sequence={self._audio_sequence}")
                            
                            # Decode base64 to PCM16 bytes, then to numpy array
                            try:
                                pcm16_data = base64.b64decode(b64_audio)
                                audio_array = np.frombuffer(pcm16_data, dtype=np.int16)
                                
                                if self._on_audio:
                                    self._on_audio(audio_array)
                                logger.debug(f"Processed audio chunk for session: {self.session_id}, size={len(audio_array)}")
                            except Exception as e:
                                logger.error(f"Error processing audio from Gemini: {e}", exc_info=True)
                    
                    # Extract Text
                    text_content = None
                    output_transcription = server_content.get("outputTranscription", {})
                    if "text" in output_transcription:
                        text_content = output_transcription["text"]
                    
                    if not text_content:
                        for part in parts:
                            if "text" in part:
                                text_content = part["text"]
                                break
                    
                    if not text_content:
                        candidates = response.get("candidates", [])
                        for candidate in candidates:
                            content = candidate.get("content", {})
                            candidate_parts = content.get("parts", [])
                            for part in candidate_parts:
                                if "text" in part:
                                    text_content = part["text"]
                                    break
                            if text_content:
                                break
                    
                    # Handle text transcription
                    if text_content and text_content.strip():
                        logger.info(f"Received text from Gemini for session: {self.session_id}, text_length={len(text_content)}")
                        is_from_output_transcription = "outputTranscription" in server_content and "text" in output_transcription
                        
                        if is_from_output_transcription:
                            if self.current_text_accumulator:
                                if text_content.startswith(self.current_text_accumulator):
                                    self.current_text_accumulator = text_content
                                else:
                                    self.current_text_accumulator += text_content
                            else:
                                self.current_text_accumulator = text_content
                            
                            if self._on_text:
                                self._on_text(self.current_text_accumulator.strip(), is_partial=True)
                        else:
                            if text_content != self.current_text_accumulator:
                                if self.current_text_accumulator and text_content.startswith(self.current_text_accumulator):
                                    new_text = text_content[len(self.current_text_accumulator):]
                                    if new_text.strip():
                                        self.current_text_accumulator = text_content
                                        if self._on_text:
                                            self._on_text(new_text.strip(), is_partial=False)
                                else:
                                    self.current_text_accumulator = text_content
                                    if self._on_text:
                                        self._on_text(text_content.strip(), is_partial=False)
                    
                    # Reset accumulator on turn complete
                    if "turnComplete" in server_content and server_content.get("turnComplete"):
                        logger.info(f"Turn complete for session: {self.session_id}")
                        self.current_text_accumulator = ""
                        if self._on_state:
                            self._on_state({"turnComplete": True})
                    
                    await asyncio.sleep(0)
                    
                except json.JSONDecodeError as e:
                    logger.error(f"Gemini parsing error for session {self.session_id}: {e}, message preview: {message[:200]}")
                except Exception as e:
                    logger.error(f"Gemini processing error for session {self.session_id}: {e}", exc_info=True)
                    
        except asyncio.CancelledError:
            logger.info(f"Receive responses task cancelled for session: {self.session_id}")
            raise
        except Exception as e:
            logger.error(f"Error in receive_responses for session {self.session_id}: {e}", exc_info=True)
            self._is_closed = True
            raise
        finally:
            logger.info(f"Receiver task ending for session: {self.session_id}, processed {message_count} messages")
            async with self._receiver_lock:
                self._receiver_task = None
    
    def _schedule_activity_end(self) -> None:
        """Schedule activity_end to be sent after a period of silence."""
        async def send_activity_end_after_delay():
            await asyncio.sleep(2.5)  # Wait 2.5 seconds of silence
            # Check if we've received new audio since scheduling
            current_time = asyncio.get_event_loop().time()
            if current_time - self._last_audio_time >= 2.4:  # Still silent
                if self.user_activity_active:
                    await self.signal_activity_end()
        
        if self._activity_end_timer and not self._activity_end_timer.done():
            self._activity_end_timer.cancel()
        self._activity_end_timer = asyncio.create_task(send_activity_end_after_delay())
    
    async def close(self) -> None:
        """Close Gemini WebSocket connection gracefully."""
        self._is_closed = True
        self._shutdown_event.set()
        
        # Cancel receiver task if running
        async with self._receiver_lock:
            if self._receiver_task and not self._receiver_task.done():
                self._receiver_task.cancel()
                try:
                    await self._receiver_task
                except asyncio.CancelledError:
                    pass
                self._receiver_task = None
        
        if self._activity_end_timer and not self._activity_end_timer.done():
            self._activity_end_timer.cancel()
            try:
                await self._activity_end_timer
            except asyncio.CancelledError:
                pass
            self._activity_end_timer = None
        
        if self.gemini_ws:
            try:
                if not self._is_websocket_closed():
                    await self.gemini_ws.close()
                logger.info(f"Gemini WebSocket closed for session: {self.session_id}")
            except Exception as e:
                logger.error(f"Error closing Gemini connection for session {self.session_id}: {e}")
            finally:
                self.gemini_ws = None
        
        self.current_text_accumulator = ""


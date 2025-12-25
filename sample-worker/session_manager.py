"""
WebRTC Session Manager
Handles WebRTC peer connections, data channels, and audio processing
"""

import asyncio
import json
import logging
import os
import numpy as np
from typing import Optional, Dict
from aiortc import RTCPeerConnection, RTCSessionDescription, RTCIceCandidate, MediaStreamTrack, RTCConfiguration, RTCIceServer
from aiortc.contrib.media import MediaPlayer, MediaRelay
import av
import google.genai as genai

from redis_client import RedisClient
from audio_processor import AudioProcessor
from gemini_proxy import GeminiVoiceProxy

logger = logging.getLogger(__name__)


class SessionManager:
    """Manages WebRTC sessions for voice bot"""
    
    def __init__(self, redis_client: RedisClient, persona: str, gemini_api_key: str):
        self.redis_client = redis_client
        self.persona = persona
        self.gemini_api_key = gemini_api_key
        self.sessions: Dict[str, 'WebRTCSession'] = {}
        self._running = False
        
        # Initialize Gemini client
        self.gemini_client = genai.Client(api_key=gemini_api_key)
    
    async def run(self):
        """Start the session manager"""
        await self.redis_client.connect()
        self._running = True
        
        # Subscribe to signaling channel pattern
        # We'll subscribe to all sessions for this persona
        signaling_pattern = f"signaling:to_worker:persona:{self.persona}:session:*"
        
        # Since Redis doesn't support pattern subscriptions in async, we'll use a different approach
        # Subscribe to a base channel and handle routing in the callback
        base_channel = f"signaling:to_worker:persona:{self.persona}"
        
        # For now, we'll subscribe to a wildcard pattern by subscribing to a base channel
        # and handling session-specific routing in the message handler
        await self.redis_client.subscribe(
            f"signaling:to_worker:persona:{self.persona}:session:*",
            self._handle_signaling_message
        )
        
        logger.info(f"Session manager started for persona: {self.persona}")
        
        # Keep running
        while self._running:
            await asyncio.sleep(1)
    
    async def _handle_signaling_message(self, channel: str, data: dict):
        """Handle incoming signaling messages from Redis"""
        try:
            # Extract session ID from channel
            # Channel format: signaling:to_worker:persona:{persona}:session:{sessionId}
            parts = channel.split(':')
            if len(parts) < 6:
                logger.error(f"Invalid channel format: {channel}")
                return
            
            session_id = parts[-1]  # Last part is session ID
            
            # Get or create session
            session = self.sessions.get(session_id)
            if not session:
                session = WebRTCSession(
                    session_id=session_id,
                    persona=self.persona,
                    redis_client=self.redis_client,
                    gemini_client=self.gemini_client,
                    gemini_api_key=self.gemini_api_key
                )
                self.sessions[session_id] = session
                await session.initialize()
            
            # Handle signaling message
            msg_type = data.get('type')
            if msg_type == 'offer':
                await session.handle_offer(data)
            elif msg_type == 'candidate':
                await session.handle_ice_candidate(data)
            else:
                logger.warning(f"Unknown signaling message type: {msg_type}")
        
        except Exception as e:
            logger.error(f"Error handling signaling message: {e}", exc_info=True)
    
    async def cleanup(self):
        """Cleanup all sessions"""
        self._running = False
        for session_id, session in list(self.sessions.items()):
            await session.close()
        self.sessions.clear()
        logger.info("All sessions cleaned up")


class WebRTCSession:
    """Represents a single WebRTC session"""
    
    def __init__(self, session_id: str, persona: str, redis_client: RedisClient, gemini_client, gemini_api_key: str):
        self.session_id = session_id
        self.persona = persona
        self.redis_client = redis_client
        self.gemini_client = gemini_client
        self.gemini_api_key = gemini_api_key
        self.pc: Optional[RTCPeerConnection] = None
        self.data_channel: Optional[any] = None
        self.audio_processor: Optional[AudioProcessor] = None
        self.audio_track: Optional[MediaStreamTrack] = None
        self._audio_queue: asyncio.Queue = asyncio.Queue()  # For OUTGOING audio (to frontend)
        self._incoming_audio_buffer: list = []  # For INCOMING audio (from frontend, to Gemini)
        self._is_collecting_audio = False
        self._gemini_model = None
        self._gemini_model_name = 'gemini-2.0-flash-exp'
        
        # Gemini proxy
        self.gemini_proxy: Optional[GeminiVoiceProxy] = None
        
        # Persona system prompts
        self._persona_prompts = {
            'restaurant_receptionist': 'You are a friendly restaurant receptionist. Help customers with:\n- Table bookings\n- Extending existing bookings\n- Takeaway orders\n- For other queries, schedule a callback\nBe professional, courteous, and efficient.',
            'university_admission_counsellor': 'You are a university admission counsellor. Help students with:\n- Course information\n- Admission requirements\n- Application process\n- Scholarship opportunities\nBe helpful, informative, and supportive.',
            'clinic_receptionist': 'You are a clinic receptionist. Help patients with:\n- Appointment scheduling\n- Doctor availability\n- Medical records\n- Insurance queries\nBe professional, empathetic, and organized.',
        }
    
    async def initialize(self):
        """Initialize the WebRTC session"""
        logger.info(f"[PATH: initialize] Initializing WebRTC session: {self.session_id}")
        
        # Create RTCPeerConnection with ICE servers configuration
        configuration = RTCConfiguration(
            iceServers=[
                RTCIceServer(urls=['stun:stun.l.google.com:19302'])
            ]
        )
        logger.info(f"[PATH: initialize] Creating RTCPeerConnection with ICE servers")
        self.pc = RTCPeerConnection(configuration=configuration)
        
        # Setup data channel handler (for incoming channel from frontend)
        @self.pc.on("datachannel")
        def on_datachannel(channel):
            logger.info(f"[PATH: on_datachannel] Data channel received: {channel.label}, state: {channel.readyState}")
            self.data_channel = channel
            
            @channel.on("open")
            def on_open():
                logger.info(f"[PATH: data_channel.on_open] Data channel opened: {channel.label}")
                # Initialize Gemini proxy when data channel opens (fallback)
                if not self.gemini_proxy:
                    logger.info("[PATH: data_channel.on_open] Initializing Gemini proxy via data channel open")
                    asyncio.create_task(self._initialize_gemini_proxy())
            
            @channel.on("close")
            def on_close():
                logger.info(f"[PATH: data_channel.on_close] Data channel closed: {channel.label}")
            
            @channel.on("error")
            def on_error(error):
                logger.error(f"[PATH: data_channel.on_error] Data channel error: {error}")
            
            @channel.on("message")
            def on_message(message):
                logger.debug(f"[PATH: data_channel.on_message] Data channel message received: {message[:100] if len(message) > 100 else message}")
                asyncio.create_task(self._handle_data_channel_message(message))
        
        # Setup audio track handler (for incoming audio from frontend)
        @self.pc.on("track")
        def on_track(track):
            logger.info(f"[PATH: on_track] Track received: {track.kind}, id: {track.id}")
            if track.kind == "audio":
                logger.info(f"[PATH: on_track] Scheduling audio track handler for session: {self.session_id}")
                asyncio.create_task(self._handle_audio_track(track))
        
        # Setup ICE candidate handler (for outgoing candidates)
        @self.pc.on("icecandidate")
        def on_icecandidate(event):
            if event.candidate:
                logger.debug(f"[PATH: on_icecandidate] ICE candidate generated: {event.candidate.type}")
                asyncio.create_task(self._send_ice_candidate(event.candidate))
            else:
                logger.info(f"[PATH: on_icecandidate] ICE candidate gathering complete")
        
        # Setup connection state handler
        @self.pc.on("connectionstatechange")
        def on_connectionstatechange():
            state = self.pc.connectionState
            logger.info(f"[PATH: connectionstatechange] Connection state: {state}, ICE state: {self.pc.iceConnectionState}, ICE gathering: {self.pc.iceGatheringState}")
            if state == "connected":
                logger.info(f"[PATH: connectionstatechange] WebRTC connection established for session: {self.session_id}")
                # Initialize Gemini proxy when connection is established
                asyncio.create_task(self._initialize_gemini_proxy())
            elif state in ["failed", "disconnected", "closed"]:
                logger.warning(f"[PATH: connectionstatechange] WebRTC connection {state} for session: {self.session_id}")
                asyncio.create_task(self.close())
        
        # Also check ICE connection state as fallback
        @self.pc.on("iceconnectionstatechange")
        def on_iceconnectionstatechange():
            ice_state = self.pc.iceConnectionState
            logger.info(f"[PATH: iceconnectionstatechange] ICE connection state: {ice_state}, connection state: {self.pc.connectionState}")
            if ice_state == "connected":
                logger.info(f"[PATH: iceconnectionstatechange] ICE connection established for session: {self.session_id}")
                # Also try to initialize Gemini proxy here as a fallback
                if not self.gemini_proxy:
                    logger.info("[PATH: iceconnectionstatechange] Initializing Gemini proxy via ICE connection state")
                    asyncio.create_task(self._initialize_gemini_proxy())
            elif ice_state in ["failed", "disconnected", "closed"]:
                logger.warning(f"[PATH: iceconnectionstatechange] ICE connection {ice_state} for session: {self.session_id}")
        
        # Monitor ICE gathering state
        @self.pc.on("icegatheringstatechange")
        def on_icegatheringstatechange():
            gathering_state = self.pc.iceGatheringState
            logger.info(f"[PATH: icegatheringstatechange] ICE gathering state: {gathering_state}")
        
        # Initialize audio processor
        logger.info(f"[PATH: initialize] Initializing audio processor")
        self.audio_processor = AudioProcessor()
        
        # Create outgoing audio track
        logger.info(f"[PATH: initialize] Creating outgoing audio track")
        self.audio_track = AudioTrack(self._audio_queue)
        self.pc.addTrack(self.audio_track)
        logger.info(f"[PATH: initialize] Added outgoing audio track to peer connection")
        
        # Start connection monitoring task
        logger.info(f"[PATH: initialize] Starting connection monitoring task")
        asyncio.create_task(self._monitor_connection())
        
        logger.info(f"[PATH: initialize] WebRTC session initialized: {self.session_id}")
    
    async def _monitor_connection(self):
        """Monitor connection and initialize Gemini when ready (fallback mechanism)"""
        logger.info(f"[PATH: _monitor_connection] Starting connection monitor for session: {self.session_id}")
        max_wait = 30  # 30 seconds max
        check_interval = 1  # Check every second
        elapsed = 0
        
        while elapsed < max_wait:
            await asyncio.sleep(check_interval)
            elapsed += check_interval
            
            if not self.pc:
                logger.warning(f"[PATH: _monitor_connection] Peer connection is None, stopping monitor")
                break
            
            state = self.pc.connectionState
            ice_state = self.pc.iceConnectionState
            ice_gathering = self.pc.iceGatheringState
            has_data_channel = self.data_channel is not None
            data_channel_state = self.data_channel.readyState if self.data_channel else None
            
            logger.debug(f"[PATH: _monitor_connection] Check {elapsed}s: connection={state}, ice={ice_state}, gathering={ice_gathering}, has_dc={has_data_channel}, dc_state={data_channel_state}")
            
            # If we have data channel open, consider it ready
            if has_data_channel and data_channel_state == 'open':
                if not self.gemini_proxy:
                    logger.info(f"[PATH: _monitor_connection] Data channel is open, initializing Gemini proxy (connection={state}, ice={ice_state})")
                    await self._initialize_gemini_proxy()
                    break
            # If ICE is connected/completed and we have tracks, also try
            elif ice_state in ['connected', 'completed'] and state in ['connecting', 'connected']:
                if not self.gemini_proxy:
                    logger.info(f"[PATH: _monitor_connection] ICE connected, initializing Gemini proxy (connection={state}, ice={ice_state})")
                    await self._initialize_gemini_proxy()
                    break
            
            if state in ['failed', 'disconnected', 'closed']:
                logger.warning(f"[PATH: _monitor_connection] Connection failed: {state}, stopping monitor")
                break
        
        if elapsed >= max_wait:
            logger.warning(f"[PATH: _monitor_connection] Connection monitor timeout after {max_wait}s, connection={self.pc.connectionState if self.pc else 'None'}, gemini_proxy={'initialized' if self.gemini_proxy else 'not initialized'}")
    
    async def _initialize_gemini_proxy(self):
        """Initialize Gemini proxy after WebRTC connection is established"""
        # Prevent multiple initializations
        if self.gemini_proxy:
            logger.debug(f"[PATH: _initialize_gemini_proxy] Gemini proxy already initialized, skipping")
            return
        
        try:
            logger.info(f"[PATH: _initialize_gemini_proxy] Starting Gemini proxy initialization for session: {self.session_id}")
            
            # Use stored API key
            gemini_api_key = self.gemini_api_key
            if not gemini_api_key:
                logger.error(f"[PATH: _initialize_gemini_proxy] Gemini API key not found for session: {self.session_id}")
                return
            
            logger.info(f"[PATH: _initialize_gemini_proxy] Gemini API key found (length: {len(gemini_api_key)})")
            
            # Get system prompt for persona
            system_prompt = self._persona_prompts.get(self.persona, self._persona_prompts['restaurant_receptionist'])
            logger.info(f"[PATH: _initialize_gemini_proxy] Using persona: {self.persona}, prompt length: {len(system_prompt)}")
            
            # Create Gemini proxy
            logger.info(f"[PATH: _initialize_gemini_proxy] Creating GeminiVoiceProxy instance")
            self.gemini_proxy = GeminiVoiceProxy(
                session_id=self.session_id,
                gemini_api_key=gemini_api_key,
                system_prompt=system_prompt
            )
            
            # Set callbacks
            logger.info(f"[PATH: _initialize_gemini_proxy] Setting callbacks")
            self.gemini_proxy.set_callbacks(
                on_audio=self._on_gemini_audio,
                on_text=self._on_gemini_text,
                on_state=self._on_gemini_state
            )
            
            # Connect and setup
            logger.info(f"[PATH: _initialize_gemini_proxy] Connecting to Gemini WebSocket...")
            await self.gemini_proxy.connect()
            
            logger.info(f"[PATH: _initialize_gemini_proxy] Sending Gemini setup message...")
            await self.gemini_proxy.send_setup_message()
            
            # Start receiver
            logger.info(f"[PATH: _initialize_gemini_proxy] Starting Gemini receiver task...")
            await self.gemini_proxy.start_receiver()
            
            logger.info(f"[PATH: _initialize_gemini_proxy] Gemini proxy initialized successfully for session: {self.session_id}")
            
        except Exception as e:
            logger.error(f"[PATH: _initialize_gemini_proxy] Error initializing Gemini proxy: {e}", exc_info=True)
            import traceback
            logger.error(f"[PATH: _initialize_gemini_proxy] Traceback: {traceback.format_exc()}")
            # Reset proxy on error so we can retry
            self.gemini_proxy = None
    
    def _on_gemini_audio(self, audio_array: np.ndarray):
        """Callback when Gemini sends audio - queue it for WebRTC"""
        try:
            # Get the running event loop (we're called from async context)
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                # No running loop - try to get event loop
                loop = asyncio.get_event_loop()
            
            # Create task to put audio in queue (non-blocking)
            loop.create_task(self._audio_queue.put(audio_array))
            logger.info(f"[PATH: _on_gemini_audio] Queued Gemini audio for WebRTC: {len(audio_array)} samples")
        except Exception as e:
            logger.error(f"[PATH: _on_gemini_audio] Error queuing Gemini audio: {e}", exc_info=True)
    
    def _on_gemini_text(self, text: str, is_partial: bool):
        """Callback when Gemini sends text - send via data channel"""
        try:
            self.send_json_event('transcript', {
                'role': 'ai',
                'text': text,
                'isPartial': is_partial
            })
        except Exception as e:
            logger.error(f"Error sending Gemini text: {e}", exc_info=True)
    
    def _on_gemini_state(self, state: dict):
        """Callback when Gemini sends state updates"""
        try:
            if 'turnComplete' in state:
                self.send_json_event('turn_complete', {})
            elif 'error' in state:
                self.send_json_event('error', {'message': str(state['error'])})
        except Exception as e:
            logger.error(f"Error handling Gemini state: {e}", exc_info=True)
    
    async def handle_offer(self, offer_data: dict):
        """Handle WebRTC offer from frontend"""
        try:
            logger.info(f"[PATH: handle_offer] Handling offer for session: {self.session_id}")
            logger.debug(f"[PATH: handle_offer] Offer SDP length: {len(offer_data.get('sdp', ''))}")
            
            # Create offer description
            offer = RTCSessionDescription(sdp=offer_data['sdp'], type='offer')
            logger.info(f"[PATH: handle_offer] Setting remote description (offer)")
            await self.pc.setRemoteDescription(offer)
            logger.info(f"[PATH: handle_offer] Remote description set, local description: {self.pc.localDescription.type if self.pc.localDescription else 'None'}")
            
            # Create answer
            logger.info(f"[PATH: handle_offer] Creating answer")
            answer = await self.pc.createAnswer()
            logger.info(f"[PATH: handle_offer] Answer created, setting local description")
            await self.pc.setLocalDescription(answer)
            logger.info(f"[PATH: handle_offer] Local description set: {self.pc.localDescription.type}")
            
            # Send answer via Redis
            signaling_channel = f"signaling:to_frontend:persona:{self.persona}:session:{self.session_id}"
            logger.info(f"[PATH: handle_offer] Publishing answer to Redis channel: {signaling_channel}")
            await self.redis_client.publish(
                signaling_channel,
                {
                    'type': 'answer',
                    'sdp': self.pc.localDescription.sdp,
                    'sessionId': self.session_id
                }
            )
            
            logger.info(f"[PATH: handle_offer] Sent answer for session: {self.session_id}, SDP length: {len(self.pc.localDescription.sdp)}")
            
            # ICE candidates will be sent automatically via on_icecandidate handler
        
        except Exception as e:
            logger.error(f"[PATH: handle_offer] Error handling offer: {e}", exc_info=True)
    
    async def _send_ice_candidate(self, candidate: RTCIceCandidate):
        """Send ICE candidate to frontend via Redis"""
        try:
            signaling_channel = f"signaling:to_frontend:persona:{self.persona}:session:{self.session_id}"
            logger.debug(f"[PATH: _send_ice_candidate] Sending ICE candidate to {signaling_channel}, type: {candidate.type}, ip: {candidate.ip}, port: {candidate.port}")
            await self.redis_client.publish(
                signaling_channel,
                {
                    'type': 'candidate',
                    'candidate': {
                        'component': candidate.component,
                        'foundation': candidate.foundation,
                        'ip': candidate.ip,
                        'port': candidate.port,
                        'priority': candidate.priority,
                        'protocol': candidate.protocol,
                        'relatedAddress': candidate.relatedAddress,
                        'relatedPort': candidate.relatedPort,
                        'sdpMLineIndex': candidate.sdpMLineIndex,
                        'sdpMid': candidate.sdpMid,
                        'tcpType': candidate.tcpType,
                        'type': candidate.type,
                        'usernameFragment': candidate.usernameFragment
                    },
                    'sessionId': self.session_id
                }
            )
            logger.debug(f"[PATH: _send_ice_candidate] Sent ICE candidate for session: {self.session_id}")
        except Exception as e:
            logger.error(f"[PATH: _send_ice_candidate] Error sending ICE candidate: {e}", exc_info=True)
    
    async def handle_ice_candidate(self, candidate_data: dict):
        """Handle ICE candidate from frontend"""
        try:
            logger.debug(f"[PATH: handle_ice_candidate] Received ICE candidate for session: {self.session_id}")
            # #region agent log
            try:
                import json
                import os
                log_path = '/Users/udaymishra/Developer/aawaz-webrtc/.cursor/debug.log'
                os.makedirs(os.path.dirname(log_path), exist_ok=True)
                with open(log_path, 'a') as f:
                    f.write(json.dumps({"sessionId":"debug-session","runId":"run1","hypothesisId":"B","location":"session_manager.py:228","message":"ICE candidate data received","data":{"candidate_data_keys":list(candidate_data.keys()),"candidate_obj":str(candidate_data.get('candidate'))[:200] if candidate_data.get('candidate') else None},"timestamp":int(__import__('time').time()*1000)})+'\n')
            except Exception:
                pass  # Logging failed, continue execution
            # #endregion
            
            # candidate_data structure: { type: 'candidate', candidate: {...}, sessionId: ... }
            candidate_obj = candidate_data.get('candidate')
            
            if not candidate_obj:
                logger.warning("No candidate object in candidate_data")
                return
            
            # JavaScript RTCIceCandidate serializes with 'candidate' property (SDP string)
            # Format: "candidate:1 1 udp 2130706431 192.168.1.1 54321 typ host"
            candidate_str = None
            sdp_mid = None
            sdp_m_line_index = None
            
            if isinstance(candidate_obj, dict):
                # Get the SDP candidate string (this is the key property)
                candidate_str = candidate_obj.get('candidate')
                sdp_mid = candidate_obj.get('sdpMid')
                sdp_m_line_index = candidate_obj.get('sdpMLineIndex')
            elif isinstance(candidate_obj, str):
                # If it's already a string, use it directly
                candidate_str = candidate_obj
            else:
                logger.warning(f"Unexpected candidate_obj type: {type(candidate_obj)}")
                return
            
            if not candidate_str:
                logger.warning("No candidate string found in candidate_obj")
                return
            
            # Parse the SDP candidate string
            # Format: "candidate:<foundation> <component> <protocol> <priority> <ip> <port> typ <type>"
            try:
                # Try using from_sdp if available
                if hasattr(RTCIceCandidate, 'from_sdp'):
                    candidate = RTCIceCandidate.from_sdp(candidate_str)
                else:
                    # Manual parsing of SDP candidate string
                    # Remove "candidate:" prefix if present
                    if candidate_str.startswith('candidate:'):
                        candidate_str = candidate_str[10:]
                    
                    parts = candidate_str.strip().split()
                    if len(parts) < 8:
                        raise ValueError(f"Invalid candidate string format: {candidate_str}")
                    
                    # Parse: foundation component protocol priority ip port typ type
                    foundation = parts[0]
                    component = int(parts[1])
                    protocol = parts[2].lower()
                    priority = int(parts[3])
                    ip = parts[4]
                    port = int(parts[5])
                    # parts[6] should be "typ"
                    candidate_type = parts[7] if len(parts) > 7 else 'host'
                    
                    # Parse optional related address/port
                    related_address = None
                    related_port = None
                    if len(parts) > 8:
                        i = 8
                        while i < len(parts):
                            if parts[i] == 'raddr' and i + 1 < len(parts):
                                related_address = parts[i + 1]
                                i += 2
                            elif parts[i] == 'rport' and i + 1 < len(parts):
                                related_port = int(parts[i + 1])
                                i += 2
                            else:
                                i += 1
                    
                    candidate = RTCIceCandidate(
                        component=component,
                        foundation=foundation,
                        ip=ip,
                        port=port,
                        priority=priority,
                        protocol=protocol,
                        type=candidate_type,
                        relatedAddress=related_address,
                        relatedPort=related_port,
                        sdpMLineIndex=sdp_m_line_index,
                        sdpMid=sdp_mid
                    )
                
                # Set sdpMid and sdpMLineIndex if provided
                if sdp_mid is not None:
                    candidate.sdpMid = sdp_mid
                if sdp_m_line_index is not None:
                    candidate.sdpMLineIndex = sdp_m_line_index
                
                await self.pc.addIceCandidate(candidate)
                logger.debug(f"[PATH: handle_ice_candidate] Added ICE candidate for session: {self.session_id}, type: {candidate.type}, ip: {candidate.ip}")
            
            except Exception as e:
                logger.error(f"Error parsing/adding ICE candidate: {e}", exc_info=True)
                # #region agent log
                try:
                    import json
                    import os
                    log_path = '/Users/udaymishra/Developer/aawaz-webrtc/.cursor/debug.log'
                    os.makedirs(os.path.dirname(log_path), exist_ok=True)
                    with open(log_path, 'a') as f:
                        f.write(json.dumps({"sessionId":"debug-session","runId":"run1","hypothesisId":"B","location":"session_manager.py:300","message":"ICE candidate parse error","data":{"error":str(e),"candidate_str":candidate_str[:200] if candidate_str else None},"timestamp":int(__import__('time').time()*1000)})+'\n')
                except Exception:
                    pass
                # #endregion
        
        except Exception as e:
            logger.error(f"Error handling ICE candidate: {e}", exc_info=True)
    
    async def _handle_data_channel_message(self, message: str):
        """Handle incoming data channel messages"""
        try:
            logger.debug(f"[PATH: _handle_data_channel_message] Raw message: {message[:200]}")
            data = json.loads(message)
            msg_type = data.get('type')
            
            logger.info(f"[PATH: _handle_data_channel_message] Received data channel message: {msg_type}")
            
            if msg_type == 'turn_start':
                # User started speaking
                logger.info(f"[PATH: _handle_data_channel_message] Processing turn_start event")
                await self._handle_turn_start()
            elif msg_type == 'turn_complete':
                # User finished speaking
                logger.info(f"[PATH: _handle_data_channel_message] Processing turn_complete event")
                await self._handle_turn_complete()
            elif msg_type == 'interrupt':
                # User interrupted AI
                logger.info(f"[PATH: _handle_data_channel_message] Processing interrupt event")
                await self._handle_interrupt()
            else:
                logger.warning(f"[PATH: _handle_data_channel_message] Unknown data channel message type: {msg_type}")
        
        except json.JSONDecodeError as e:
            logger.error(f"[PATH: _handle_data_channel_message] Failed to parse data channel message: {e}, message: {message[:200]}")
        except Exception as e:
            logger.error(f"[PATH: _handle_data_channel_message] Error handling data channel message: {e}", exc_info=True)
    
    async def _handle_turn_start(self):
        """Handle user turn start"""
        logger.info(f"[PATH: _handle_turn_start] User turn started - beginning audio collection for session: {self.session_id}")
        self._is_collecting_audio = True
        self._incoming_audio_buffer.clear()
        
        # Signal activity start to Gemini
        if self.gemini_proxy:
            logger.info(f"[PATH: _handle_turn_start] Signaling activity_start to Gemini")
            await self.gemini_proxy.signal_activity_start()
        else:
            logger.warning(f"[PATH: _handle_turn_start] Gemini proxy not initialized, cannot signal activity_start")
    
    async def _handle_turn_complete(self):
        """Handle user turn complete"""
        logger.info(f"[PATH: _handle_turn_complete] User turn completed, collected {len(self._incoming_audio_buffer)} audio chunks for session: {self.session_id}")
        self._is_collecting_audio = False
        
        # Signal activity end to Gemini
        if self.gemini_proxy:
            logger.info(f"[PATH: _handle_turn_complete] Signaling activity_end to Gemini")
            await self.gemini_proxy.signal_activity_end()
        else:
            logger.warning(f"[PATH: _handle_turn_complete] Gemini proxy not initialized, cannot signal activity_end")
        
        # Clear buffer (audio was already sent during collection)
        self._incoming_audio_buffer.clear()
    
    async def _handle_interrupt(self):
        """Handle user interrupt"""
        logger.info("User interrupted")
        # Stop any ongoing AI response
        self._audio_queue = asyncio.Queue()  # Clear audio queue
        
        # Signal interrupt to Gemini if needed
        if self.gemini_proxy:
            # Gemini doesn't have explicit interrupt, but we can signal activity_end
            await self.gemini_proxy.signal_activity_end()
    
    async def _handle_audio_track(self, track: MediaStreamTrack):
        """Handle incoming audio track from frontend"""
        logger.info(f"[PATH: _handle_audio_track] Handling audio track for session: {self.session_id}, track_id: {track.id}")
        
        # #region agent log
        try:
            import json
            import os
            log_path = '/Users/udaymishra/Developer/aawaz-webrtc/.cursor/debug.log'
            os.makedirs(os.path.dirname(log_path), exist_ok=True)
            with open(log_path, 'a') as f:
                f.write(json.dumps({"sessionId":"debug-session","runId":"run1","hypothesisId":"A","location":"session_manager.py:300","message":"Track object type and methods","data":{"track_type":str(type(track)),"has_recv":hasattr(track,'recv'),"has_aiter":hasattr(track,'__aiter__'),"dir":str([m for m in dir(track) if not m.startswith('_')][:10])},"timestamp":int(__import__('time').time()*1000)})+'\n')
        except Exception:
            pass  # Logging failed, continue execution
        # #endregion
        
        try:
            frame_count = 0
            # Use recv() method for RemoteStreamTrack (aiortc doesn't support async iteration)
            while True:
                frame = await track.recv()
                frame_count += 1
                
                if frame_count == 1:
                    logger.info(f"[PATH: _handle_audio_track] Received first audio frame")
                    # Fallback: Initialize Gemini proxy on first audio frame if not already initialized
                    if not self.gemini_proxy:
                        logger.info(f"[PATH: _handle_audio_track] Initializing Gemini proxy on first audio frame (fallback)")
                        asyncio.create_task(self._initialize_gemini_proxy())
                elif frame_count % 100 == 0:
                    logger.debug(f"[PATH: _handle_audio_track] Received {frame_count} audio frames")
                
                # Process audio frame
                # Resample from Opus/48kHz to PCM/16kHz for Gemini
                pcm_audio = await self.audio_processor.process_incoming_audio(frame)
                
                if pcm_audio is not None:
                    # If we're collecting audio for a turn, send to Gemini
                    if self._is_collecting_audio:
                        if self.gemini_proxy:
                            await self.gemini_proxy.process_audio_chunk(pcm_audio)
                            if frame_count % 100 == 0:
                                logger.debug(f"[PATH: _handle_audio_track] Sent {frame_count} audio chunks to Gemini")
                        else:
                            if frame_count % 50 == 0:  # Log less frequently
                                logger.warning(f"[PATH: _handle_audio_track] Gemini proxy not initialized, dropping audio chunks (frame {frame_count})")
                    # Also buffer it (for potential replay/debugging)
                    self._incoming_audio_buffer.append(pcm_audio)
        
        except Exception as e:
            logger.error(f"Error handling audio track: {e}", exc_info=True)
    
    def send_json_event(self, event_type: str, payload: dict):
        """Send JSON event over data channel"""
        if self.data_channel and self.data_channel.readyState == 'open':
            message = {
                'type': event_type,
                **payload
            }
            try:
                self.data_channel.send(json.dumps(message))
                logger.debug(f"Sent data channel event: {event_type}")
            except Exception as e:
                logger.error(f"Failed to send data channel event: {e}")
        else:
            logger.warning("Data channel not open, cannot send event")
    
    async def close(self):
        """Close the WebRTC session"""
        logger.info(f"[PATH: close] Closing WebRTC session: {self.session_id}")
        
        # Close Gemini proxy first
        if self.gemini_proxy:
            logger.info(f"[PATH: close] Closing Gemini proxy")
            await self.gemini_proxy.close()
            self.gemini_proxy = None
        
        if self.pc:
            logger.info(f"[PATH: close] Closing peer connection")
            await self.pc.close()
            self.pc = None
        
        if self.audio_processor:
            logger.info(f"[PATH: close] Cleaning up audio processor")
            await self.audio_processor.cleanup()
            self.audio_processor = None
        
        self.data_channel = None
        self.audio_track = None
        logger.info(f"[PATH: close] WebRTC session closed: {self.session_id}")


class AudioTrack(MediaStreamTrack):
    """Custom audio track for outgoing audio to frontend"""
    
    kind = "audio"
    
    def __init__(self, audio_queue: asyncio.Queue):
        super().__init__()
        self.audio_queue = audio_queue
        self.audio_processor = AudioProcessor()
        self.next_pts = None  # Presentation timestamp for audio synchronization (initialized to None)
        self.sample_rate = 48000  # WebRTC expects 48kHz
    
    async def recv(self):
        """Receive audio frame from queue and convert to WebRTC format"""
        try:
            # Get PCM audio from queue (16kHz from Gemini)
            # Use timeout to avoid blocking indefinitely and return silence if no audio
            try:
                # Increased timeout to 200ms to reduce silence frames and improve quality
                pcm_audio = await asyncio.wait_for(self.audio_queue.get(), timeout=0.2)
                logger.debug(f"[PATH: AudioTrack.recv] Received audio from queue: {len(pcm_audio)} samples, dtype={pcm_audio.dtype}")
            except asyncio.TimeoutError:
                # Return silence frame if no audio available (normal during gaps)
                # Initialize next_pts if not set
                if self.next_pts is None:
                    self.next_pts = 0
                
                # Create numpy array for silence (48kHz, 10ms = 480 samples)
                # Reshape to 2D: (channels=1, samples=480)
                silence_array = np.zeros((1, 480), dtype=np.int16)
                logger.debug(f"[PATH: AudioTrack.recv] No audio available, returning silence frame")
                frame = av.AudioFrame.from_ndarray(
                    silence_array,  # Shape: (channels, samples) as 2D numpy array
                    format='s16',
                    layout='mono'
                )
                frame.sample_rate = self.sample_rate
                frame.pts = self.next_pts
                # Update next_pts to keep timeline continuous (480 samples = 10ms at 48kHz)
                self.next_pts += 480
                return frame
            
            # Resample to Opus/48kHz for WebRTC
            frame = await self.audio_processor.process_outgoing_audio(pcm_audio)
            logger.debug(f"[PATH: AudioTrack.recv] Processed audio frame, returning to WebRTC")
            
            # Initialize next_pts if not set
            if self.next_pts is None:
                self.next_pts = 0
            
            # Ensure sample rate and PTS are set for proper audio synchronization
            frame.sample_rate = self.sample_rate
            frame.pts = self.next_pts
            # Update next_pts by the number of samples in this frame
            self.next_pts += frame.samples
            
            return frame
        
        except Exception as e:
            logger.error(f"[PATH: AudioTrack.recv] Error in AudioTrack.recv: {e}", exc_info=True)
            # Return silence frame on error
            # Initialize next_pts if not set
            if self.next_pts is None:
                self.next_pts = 0
            
            # Create numpy array for silence (48kHz, 10ms = 480 samples)
            # Reshape to 2D: (channels=1, samples=480)
            silence_array = np.zeros((1, 480), dtype=np.int16)
            frame = av.AudioFrame.from_ndarray(
                silence_array,  # Shape: (channels, samples) as 2D numpy array
                format='s16',
                layout='mono'
            )
            frame.sample_rate = self.sample_rate
            frame.pts = self.next_pts
            # Update next_pts to keep timeline continuous (480 samples = 10ms at 48kHz)
            self.next_pts += 480
            return frame


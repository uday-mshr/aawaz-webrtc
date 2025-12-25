import { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import redisService from './redis.service';
import sessionService from './session.service';
import logger from '../utils/logger';
import { Persona } from '../types/persona.types';
import {
  InitiateSessionPayload,
  JoinSessionPayload,
  EndSessionPayload,
  SessionCreatedEvent,
  SessionJoinedEvent,
  SessionErrorEvent,
  SessionEndedEvent
} from '../types/session.types';
import { SessionNotFoundError, SessionAlreadyEndedError } from '../utils/errors';

export class SocketService {
  private io: Server;
  private activeSubscriptions: Set<string> = new Set();
  private sessionSocketMap: Map<string, string> = new Map(); // sessionId -> socketId
  private qaSessionSockets: Map<string, Set<string>> = new Map(); // sessionId -> Set of socketIds (for peer-to-peer)

  constructor(httpServer: HttpServer) {
    const corsOrigin = process.env.CORS_ORIGIN || '*';
    const allowedOrigins = corsOrigin.includes(',') 
      ? corsOrigin.split(',').map(o => o.trim())
      : corsOrigin;
    
    this.io = new Server(httpServer, {
      cors: {
        origin: (origin, callback) => {
          if (!origin) {
            logger.debug('Socket.io CORS: Allowing request with no origin');
            return callback(null, true);
          }
          
          logger.debug(`Socket.io CORS: Checking origin: ${origin}, NODE_ENV: ${process.env.NODE_ENV}, CORS_ORIGIN: ${corsOrigin}`);
          
          // Always allow localhost origins for local development
          if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
            logger.debug('Socket.io CORS: Allowing localhost origin');
            return callback(null, true);
          }
          
          if (allowedOrigins === '*') {
            logger.debug('Socket.io CORS: Allowing all origins (*)');
            callback(null, true);
          } else if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
            logger.debug('Socket.io CORS: Allowing origin from allowed list');
            callback(null, true);
          } else if (typeof allowedOrigins === 'string' && allowedOrigins === origin) {
            logger.debug('Socket.io CORS: Allowing exact match origin');
            callback(null, true);
          } else {
            logger.warn(`Socket.io CORS: Rejecting origin: ${origin}`);
            callback(new Error('Not allowed by CORS'));
          }
        },
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: 60000,
      transports: ['websocket', 'polling'],
    });

    // Redis Adapter for Scaling
    const pubClient = redisService.pubClient;
    const subClient = redisService.pubClient.duplicate();
    this.io.adapter(createAdapter(pubClient, subClient));

    this.initializeMiddlewares();
    this.initializeRedisSubscriptions();
    this.initializeEvents();
  }

  private initializeMiddlewares() {
    this.io.use((socket, next) => {
      // Initialize socket data
      socket.data.user = { id: socket.handshake.auth.token || 'guest' };
      socket.data.sessionId = undefined;
      socket.data.persona = undefined;
      socket.data.userInfo = undefined;
      next();
    });
  }

  private initializeRedisSubscriptions() {
    // Listen for WebRTC signaling messages from Python worker
    // Channel patterns: signaling:to_frontend:persona:{persona}:session:{sessionId}
    redisService.subClient.on('message', (channel: string, message: string) => {
      try {
        // Handle WebRTC signaling - persona-specific channels
        const signalingMatch = channel.match(/^signaling:to_frontend:persona:([^:]+):session:(.+)$/);
        if (signalingMatch) {
          const [, persona, sessionId] = signalingMatch;
          const payload = JSON.parse(message);
          
          logger.info('Received WebRTC signaling message from worker', { 
            channel, 
            persona, 
            sessionId, 
            type: payload.type,
            hasSdp: !!payload.sdp,
            hasCandidate: !!payload.candidate
          });
          
          // Emit to room only (socket is already in the room, emitting both causes duplicates)
          const roomName = `session:${sessionId}`;
          this.io.to(roomName).emit('signal', {
            type: payload.type,
            sdp: payload.sdp,
            candidate: payload.candidate,
            sessionId
          });
          
          logger.debug('WebRTC signaling message delivered to room', { 
            channel, 
            persona, 
            sessionId, 
            type: payload.type,
            roomName
          });
        }
      } catch (error) {
        logger.error('Error processing Redis message', { channel, error });
      }
    });
  }

  private initializeEvents() {
    this.io.on('connection', (socket: Socket) => {
      logger.info(`Socket connected: ${socket.id}`);

      // 1. Initiate Session - Create session from user data
      socket.on('initiate_session', async (payload: InitiateSessionPayload) => {
        try {
          const session = await sessionService.createSession(
            payload,
            {
              userAgent: socket.handshake.headers['user-agent'],
              ipAddress: socket.handshake.address
            },
            socket.id
          );

          // Store session data in socket
          socket.data.sessionId = session.sessionId;
          socket.data.persona = session.persona;
          socket.data.userInfo = session.userInfo;
          socket.data.status = session.status;
          socket.data.sessionValidated = true; // Session validated during creation

          // Join session room
          socket.join(`session:${session.sessionId}`);

          // Map session to socket
          this.sessionSocketMap.set(session.sessionId, socket.id);

          // Subscribe to persona-specific Redis channels (signaling)
          this.subscribeToSessionSignaling(session.persona, session.sessionId);

          // Emit session created event
          socket.emit('session_created', {
            sessionId: session.sessionId,
            status: session.status
          } as SessionCreatedEvent);

          logger.info('Session initiated', { 
            sessionId: session.sessionId, 
            socketId: socket.id,
            persona: session.persona
          });
        } catch (error) {
          logger.error('Failed to initiate session', { error, socketId: socket.id });
          socket.emit('session_error', {
            code: 'SESSION_CREATION_FAILED',
            message: 'Failed to create session',
            details: error instanceof Error ? error.message : 'Unknown error'
          } as SessionErrorEvent);
        }
      });

      // 2. Join Session - Join existing session room
      socket.on('join_session', async (payload: JoinSessionPayload) => {
        try {
          const { sessionId } = payload;
          
          logger.info('Join session request received', { sessionId, socketId: socket.id });
          
          // Validate session exists and is active
          const session = await sessionService.validateSession(sessionId);
          
          // Update socket ID in session
          await sessionService.updateSocketId(sessionId, socket.id);

          // Store session data in socket
          socket.data.sessionId = sessionId;
          socket.data.persona = session.persona;
          socket.data.userInfo = session.userInfo;
          socket.data.status = session.status;
          socket.data.sessionValidated = true; // Session validated during join

          // Join session room
          const roomName = `session:${sessionId}`;
          socket.join(roomName);
          logger.info('Socket joined session room', { sessionId, socketId: socket.id, roomName });
          
          // Map session to socket
          this.sessionSocketMap.set(sessionId, socket.id);
          logger.debug('Session mapped to socket', { sessionId, socketId: socket.id });

          // Subscribe to persona-specific session signaling channels
          this.subscribeToSessionSignaling(session.persona, sessionId);
          logger.debug('Subscribed to Redis signaling channel', { 
            sessionId, 
            persona: session.persona,
            channel: `signaling:to_frontend:persona:${session.persona}:session:${sessionId}`
          });

          // Emit session joined event
          socket.emit('session_joined', {
            sessionId,
            status: session.status
          } as SessionJoinedEvent);

          logger.info('Session joined successfully', { sessionId, socketId: socket.id, persona: session.persona });
        } catch (error) {
          logger.error('Failed to join session', { error, sessionId: payload.sessionId, socketId: socket.id });
          socket.emit('session_error', {
            code: error instanceof SessionNotFoundError ? 'SESSION_NOT_FOUND' : 
                  error instanceof SessionAlreadyEndedError ? 'SESSION_ALREADY_ENDED' : 'SESSION_JOIN_FAILED',
            message: error instanceof Error ? error.message : 'Failed to join session'
          } as SessionErrorEvent);
        }
      });

      // 3. WebRTC Signaling - Handle WebRTC signaling messages (SDP/ICE candidates)
      socket.on('signal', async (data: { type: 'offer' | 'answer' | 'candidate'; sdp?: string; candidate?: any; sessionId?: string; persona?: string }) => {
        try {
          const sessionId = data.sessionId || socket.data.sessionId;
          if (!sessionId) {
            throw new Error('Session ID not found');
          }

          logger.info('Received WebRTC signaling message from frontend', {
            type: data.type,
            sessionId,
            socketId: socket.id,
            hasSdp: !!data.sdp,
            hasCandidate: !!data.candidate,
            sdpLength: data.sdp?.length || 0
          });

          // Get persona from signal data, socket data, or look up from session
          let persona = (data.persona as Persona) || (socket.data.persona as Persona);
          if (!persona) {
            // Fallback: look up persona from session
            try {
              const session = await sessionService.getSession(sessionId);
              persona = session.persona;
              logger.debug('Retrieved persona from session', { sessionId, persona });
            } catch (err) {
              throw new Error('Persona not found in session');
            }
          }

          // Ensure socket is in session room (in case join_session wasn't called)
          const roomName = `session:${sessionId}`;
          if (!socket.rooms.has(roomName)) {
            logger.warn('Socket not in session room, joining now', { sessionId, socketId: socket.id, roomName });
            socket.join(roomName);
            this.sessionSocketMap.set(sessionId, socket.id);
          }

          // Publish signaling message to Redis for Python worker
          const signalingChannel = `signaling:to_worker:persona:${persona}:session:${sessionId}`;
          await redisService.publishEvent(signalingChannel, {
            type: data.type,
            sdp: data.sdp,
            candidate: data.candidate,
            sessionId
          });

          logger.info('Forwarded WebRTC signaling message to worker', { 
            sessionId, 
            type: data.type,
            socketId: socket.id,
            channel: signalingChannel,
            inRoom: socket.rooms.has(roomName)
          });
        } catch (error) {
          logger.error('Failed to process signaling message', { error, socketId: socket.id, data });
          socket.emit('session_error', {
            code: 'SIGNALING_FAILED',
            message: 'Failed to process signaling message',
            details: error instanceof Error ? error.message : 'Unknown error'
          } as SessionErrorEvent);
        }
      });

      // 4. End Session
      socket.on('end_session', async (payload: EndSessionPayload) => {
        try {
          const { sessionId } = payload;

          // Validate session belongs to socket
          if (socket.data.sessionId !== sessionId) {
            throw new Error('Session ID mismatch');
          }

          // End session
          const session = await sessionService.endSession(sessionId);

          // Leave room
          socket.leave(`session:${sessionId}`);

          // Unsubscribe from persona-specific Redis channels
          this.unsubscribeFromSessionSignaling(session.persona, sessionId);

          // Remove from map
          this.sessionSocketMap.delete(sessionId);

          // Emit session ended event
          socket.emit('session_ended', {
            sessionId,
            endedAt: session.endedAt?.toISOString() || new Date().toISOString(),
            duration: session.duration || 0
          } as SessionEndedEvent);

          logger.info('Session ended', { sessionId, socketId: socket.id });
        } catch (error) {
          logger.error('Failed to end session', { error, socketId: socket.id });
          socket.emit('session_error', {
            code: 'SESSION_END_FAILED',
            message: 'Failed to end session',
            details: error instanceof Error ? error.message : 'Unknown error'
          } as SessionErrorEvent);
        }
      });

      // Legacy events (for backward compatibility, can be removed later)
      socket.on('builder_action', async (data: any) => {
        const sessionId = socket.data.sessionId;
        const persona = socket.data.persona as Persona;
        if (sessionId && persona) {
          await redisService.publishEvent(`builder_events:persona:${persona}:session:${sessionId}`, {
            ...data,
            socketId: socket.id,
            sessionId,
            persona
          });
        }
      });

      socket.on('start_simulation', async (config: any) => {
        const sessionId = socket.data.sessionId;
        const persona = socket.data.persona as Persona;
        if (sessionId && persona) {
          await redisService.publishEvent(`session_control:persona:${persona}:session:${sessionId}`, {
            action: 'START_SIMULATION',
            config,
            sessionId,
            persona
          });
        }
      });

      // QA Session Events - Peer-to-peer testing
      socket.on('create_qa_session', async (payload: { sessionId?: string }) => {
        try {
          const sessionId = payload.sessionId || `qa_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
          
          // Mark socket as QA session
          socket.data.sessionId = sessionId;
          socket.data.isQASession = true;
          socket.data.persona = 'QA_TEST' as Persona;

          // Join session room
          socket.join(`qa_session:${sessionId}`);

          // Add to QA session sockets map
          if (!this.qaSessionSockets.has(sessionId)) {
            this.qaSessionSockets.set(sessionId, new Set());
          }
          this.qaSessionSockets.get(sessionId)!.add(socket.id);

          // Emit session created event
          socket.emit('qa_session_created', {
            sessionId,
            status: 'active'
          });

          logger.info('QA session created', { sessionId, socketId: socket.id });
        } catch (error) {
          logger.error('Failed to create QA session', { error, socketId: socket.id });
          socket.emit('session_error', {
            code: 'QA_SESSION_CREATION_FAILED',
            message: 'Failed to create QA session',
            details: error instanceof Error ? error.message : 'Unknown error'
          } as SessionErrorEvent);
        }
      });

      socket.on('join_qa_session', async (payload: { sessionId: string }) => {
        try {
          const { sessionId } = payload;

          // Check if session exists
          if (!this.qaSessionSockets.has(sessionId)) {
            throw new Error('QA session not found');
          }

          // Mark socket as QA session
          socket.data.sessionId = sessionId;
          socket.data.isQASession = true;
          socket.data.persona = 'QA_TEST' as Persona;

          // Join session room
          socket.join(`qa_session:${sessionId}`);

          // Add to QA session sockets map
          this.qaSessionSockets.get(sessionId)!.add(socket.id);

          // Notify other peers
          const peerSockets = this.qaSessionSockets.get(sessionId);
          if (peerSockets) {
            peerSockets.forEach((peerSocketId) => {
              if (peerSocketId !== socket.id) {
                const peerSocket = this.io.sockets.sockets.get(peerSocketId);
                if (peerSocket) {
                  peerSocket.emit('qa_session_joined', {
                    sessionId,
                    peerSocketId: socket.id
                  });
                }
              }
            });
          }

          // Emit session joined event
          socket.emit('qa_session_joined', {
            sessionId,
            status: 'active',
            peerCount: this.qaSessionSockets.get(sessionId)!.size
          });

          logger.info('QA session joined', { sessionId, socketId: socket.id, peerCount: this.qaSessionSockets.get(sessionId)!.size });
        } catch (error) {
          logger.error('Failed to join QA session', { error, sessionId: payload.sessionId, socketId: socket.id });
          socket.emit('session_error', {
            code: 'QA_SESSION_JOIN_FAILED',
            message: 'Failed to join QA session',
            details: error instanceof Error ? error.message : 'Unknown error'
          } as SessionErrorEvent);
        }
      });

      // Handle disconnect
      socket.on('disconnect', async () => {
        const sessionId = socket.data?.sessionId;
        const isQASession = socket.data?.isQASession === true;
        logger.info('Socket disconnected', { socketId: socket.id, sessionId, isQASession });

        if (sessionId) {
          if (isQASession) {
            // Handle QA session disconnect
            const peerSockets = this.qaSessionSockets.get(sessionId);
            if (peerSockets) {
              peerSockets.delete(socket.id);
              
              // Notify other peers
              peerSockets.forEach((peerSocketId) => {
                const peerSocket = this.io.sockets.sockets.get(peerSocketId);
                if (peerSocket) {
                  peerSocket.emit('qa_session_left', {
                    sessionId,
                    peerSocketId: socket.id
                  });
                }
              });

              // Remove session if no peers left
              if (peerSockets.size === 0) {
                this.qaSessionSockets.delete(sessionId);
                logger.info('QA session ended (no peers left)', { sessionId });
              }
            }
          } else {
            // Handle regular session disconnect
            try {
              // Get session to retrieve persona
              const session = await sessionService.getSession(sessionId);
              
              // Auto-end session on disconnect
              await sessionService.endSession(sessionId);
              
              // Unsubscribe from persona-specific Redis channels
              this.unsubscribeFromSessionSignaling(session.persona, sessionId);
              
              // Remove from map
              this.sessionSocketMap.delete(sessionId);
              
              logger.info('Session auto-ended on disconnect', { sessionId, persona: session.persona });
            } catch (error) {
              logger.error('Error ending session on disconnect', { error, sessionId });
            }
          }
        }
      });
    });
  }

  private subscribeToSessionSignaling(persona: Persona, sessionId: string) {
    const signalingChannel = `signaling:to_frontend:persona:${persona}:session:${sessionId}`;

    // Subscribe to signaling channel only
    if (!this.activeSubscriptions.has(signalingChannel)) {
      redisService.subClient.subscribe(signalingChannel, (err) => {
        if (err) {
          logger.error('Failed to subscribe to signaling channel', { channel: signalingChannel, err });
        } else {
          this.activeSubscriptions.add(signalingChannel);
          logger.info('Subscribed to Redis signaling channel', { 
            channel: signalingChannel, 
            persona, 
            sessionId,
            totalSubscriptions: this.activeSubscriptions.size
          });
        }
      });
    } else {
      logger.debug('Already subscribed to signaling channel', { channel: signalingChannel, persona, sessionId });
    }
  }

  private unsubscribeFromSessionSignaling(persona: Persona, sessionId: string) {
    const signalingChannel = `signaling:to_frontend:persona:${persona}:session:${sessionId}`;

    // Unsubscribe from signaling channel only
    if (this.activeSubscriptions.has(signalingChannel)) {
      redisService.subClient.unsubscribe(signalingChannel, (err) => {
        if (err) {
          logger.error('Failed to unsubscribe from signaling channel', { channel: signalingChannel, err });
        } else {
          this.activeSubscriptions.delete(signalingChannel);
          logger.debug('Unsubscribed from signaling channel', { channel: signalingChannel, persona, sessionId });
        }
      });
    }
  }
}

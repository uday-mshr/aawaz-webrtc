import { ConversationState } from '../models/session.model';
import { Persona } from './persona.types';

export interface CreateSessionRequest {
  name: string;
  email: string;
  mobile: string;
  persona: Persona;
}

export interface CreateSessionResponse {
  sessionId: string;
  status: 'active';
  createdAt: string;
}

export interface SessionResponse {
  sessionId: string;
  persona: Persona;
  userInfo: {
    name: string;
    email: string;
    mobile: string;
  };
  connectionType: 'web';
  socketId?: string;
  status: 'active' | 'ended' | 'timeout';
  conversationState: ConversationState;
  geminiConfig: {
    model: string;
    systemPrompt: string;
    persona: Persona;
  };
  metadata: {
    userAgent?: string;
    ipAddress?: string;
  };
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  duration?: number;
}

export interface UpdateSessionStateRequest {
  conversationState?: Partial<ConversationState>;
  status?: 'active' | 'ended';
}

export interface EndSessionResponse {
  sessionId: string;
  endedAt: string;
  duration: number;
}

export interface SocketSessionData {
  sessionId: string;
  persona: Persona;
  userInfo: {
    name: string;
    email: string;
    mobile: string;
  };
  status: 'active' | 'ended' | 'timeout';
}

export interface InitiateSessionPayload {
  name: string;
  email: string;
  mobile: string;
  persona: Persona;
}

export interface JoinSessionPayload {
  sessionId: string;
}

/**
 * Legacy audio chunk payload (Base64 JSON format)
 * @deprecated Use 'audio_input' event with binary MessagePack instead
 */
export interface AudioChunkPayload {
  sessionId: string;
  audio: string | ArrayBuffer; // Support both string (base64) and ArrayBuffer for backward compatibility
  timestamp: number;
}

/**
 * Binary audio input payload (MessagePack format)
 * The frontend sends this as a binary MessagePack-encoded Buffer containing:
 * { sessionId: string, timestamp: number, data: Uint8Array }
 */
export type AudioInputPayload = Buffer | Uint8Array;

export interface EndSessionPayload {
  sessionId: string;
}

export interface TurnStartPayload {
  sessionId: string;
  type: 'turn_start';
}

export interface TurnCompletePayload {
  sessionId: string;
  type: 'turn_complete';
}

export interface SessionCreatedEvent {
  sessionId: string;
  status: 'active';
}

export interface SessionJoinedEvent {
  sessionId: string;
  status: 'active';
}

export interface ConversationStateEvent {
  sessionId: string;
  conversationState: ConversationState;
}

export interface SessionErrorEvent {
  code: string;
  message: string;
  details?: any;
}

export interface SessionEndedEvent {
  sessionId: string;
  endedAt: string;
  duration: number;
}


import { Session, SessionDocument } from '../models/session.model';
import { CreateSessionRequest, UpdateSessionStateRequest } from '../types/session.types';
import { SessionNotFoundError, SessionAlreadyEndedError } from '../utils/errors';
import { getPersonaGeminiConfig } from '../utils/persona-config';
import logger from '../utils/logger';

class SessionService {
  async createSession(
    userData: CreateSessionRequest,
    metadata?: { userAgent?: string; ipAddress?: string },
    socketId?: string
  ): Promise<SessionDocument> {
    try {
      const persona = userData.persona;
      const geminiConfig = getPersonaGeminiConfig(persona);

      const session = new Session({
        persona,
        userInfo: {
          name: userData.name,
          email: userData.email,
          mobile: userData.mobile
        },
        connectionType: 'web',
        socketId,
        status: 'active',
        conversationState: {},
        metadata: metadata || {},
        geminiConfig
      });

      const savedSession = await session.save();
      logger.info('Session created', { 
        sessionId: savedSession.sessionId, 
        email: userData.email,
        persona: savedSession.persona
      });
      return savedSession;
    } catch (error) {
      logger.error('Failed to create session', { error, userData });
      throw error;
    }
  }

  async getSession(sessionId: string): Promise<SessionDocument> {
    const session = await Session.findOne({ sessionId });
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }

  async updateSessionState(
    sessionId: string,
    updateData: UpdateSessionStateRequest
  ): Promise<SessionDocument> {
    const session = await this.getSession(sessionId);

    if (session.status === 'ended' || session.status === 'timeout') {
      throw new SessionAlreadyEndedError(sessionId);
    }

    // Update conversation state if provided
    if (updateData.conversationState) {
      session.conversationState = {
        ...session.conversationState,
        ...updateData.conversationState
      } as any;
    }

    // Update status if provided
    if (updateData.status) {
      if (updateData.status === 'ended') {
        session.endedAt = new Date();
      }
      session.status = updateData.status;
    }

    const updatedSession = await session.save();
    logger.info('Session state updated', { sessionId, status: updatedSession.status });
    return updatedSession;
  }

  async endSession(sessionId: string): Promise<SessionDocument> {
    const session = await this.getSession(sessionId);

    if (session.status === 'ended') {
      throw new SessionAlreadyEndedError(sessionId);
    }

    session.status = 'ended';
    session.endedAt = new Date();

    if (session.createdAt) {
      session.duration = Math.floor(
        (session.endedAt.getTime() - session.createdAt.getTime()) / 1000
      );
    }

    const endedSession = await session.save();
    logger.info('Session ended', { sessionId, duration: endedSession.duration });
    return endedSession;
  }

  async validateSession(sessionId: string): Promise<SessionDocument> {
    const session = await this.getSession(sessionId);

    if (session.status === 'ended' || session.status === 'timeout') {
      throw new SessionAlreadyEndedError(sessionId);
    }

    return session;
  }

  async getActiveSessions(): Promise<SessionDocument[]> {
    return Session.find({ status: 'active' })
      .sort({ createdAt: -1 })
      .exec();
  }

  async updateSocketId(sessionId: string, socketId: string): Promise<SessionDocument> {
    const session = await this.getSession(sessionId);
    session.socketId = socketId;
    return session.save();
  }

  async removeSocketId(sessionId: string): Promise<void> {
    await Session.updateOne({ sessionId }, { $unset: { socketId: 1 } });
  }
}

export default new SessionService();


import { Request, Response, NextFunction } from 'express';
import { Socket } from 'socket.io';
import sessionService from '../services/session.service';
import { SessionNotFoundError, SessionAlreadyEndedError } from '../utils/errors';
import logger from '../utils/logger';

/**
 * Middleware to validate session exists and is active for REST API requests
 */
export const validateSessionMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const { sessionId } = req.params;
    if (!sessionId) {
      res.status(400).json({
        success: false,
        message: 'Session ID is required',
        code: 'MISSING_SESSION_ID'
      });
      return;
    }

    await sessionService.validateSession(sessionId);
    next();
  } catch (error) {
    if (error instanceof SessionNotFoundError || error instanceof SessionAlreadyEndedError) {
      res.status(error.status).json({
        success: false,
        message: error.message,
        code: error.code,
        details: error.details
      });
      return;
    }
    next(error);
  }
};

/**
 * Socket middleware to validate session for socket events
 */
export const validateSessionSocket = async (socket: Socket, next: (err?: Error) => void) => {
  try {
    const sessionId = socket.data?.sessionId;
    
    if (!sessionId) {
      // Allow connection but require session validation for specific events
      return next();
    }

    await sessionService.validateSession(sessionId);
    next();
  } catch (error) {
    if (error instanceof SessionNotFoundError || error instanceof SessionAlreadyEndedError) {
      logger.error('Socket session validation failed', { 
        socketId: socket.id, 
        error: error.message 
      });
      socket.emit('session_error', {
        code: error.code,
        message: error.message,
        details: error.details
      });
      return next(new Error(error.message));
    }
    next(error as Error);
  }
};

/**
 * Helper function to get and validate session from socket data
 */
export const getSessionFromSocket = async (socket: Socket) => {
  const sessionId = socket.data?.sessionId;
  if (!sessionId) {
    throw new Error('Session ID not found in socket data');
  }
  return await sessionService.validateSession(sessionId);
};


import { HttpException } from '../middleware/error.middleware';

export class SessionNotFoundError extends HttpException {
  constructor(sessionId: string) {
    super(404, `Session not found: ${sessionId}`, 'SESSION_NOT_FOUND', { sessionId });
  }
}

export class SessionAlreadyEndedError extends HttpException {
  constructor(sessionId: string) {
    super(400, `Session already ended: ${sessionId}`, 'SESSION_ALREADY_ENDED', { sessionId });
  }
}

export class InvalidSessionStateError extends HttpException {
  constructor(message: string, details?: any) {
    super(400, message, 'INVALID_SESSION_STATE', details);
  }
}

export class SessionValidationError extends HttpException {
  constructor(message: string, details?: any) {
    super(400, message, 'SESSION_VALIDATION_ERROR', details);
  }
}


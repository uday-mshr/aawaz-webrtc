import { Router, Request, Response, NextFunction } from 'express';
import SessionController from '../controllers/session.controller';
import {
  createSessionSchema,
  sessionIdParamSchema,
  updateSessionStateSchema
} from '../utils/validation';
import { HttpException } from '../middleware/error.middleware';

const router = Router();
const sessionController = new SessionController();

// Validation middleware
const validateRequest = (schema: any) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Explicitly mark res as used to satisfy strict compiler options
    void res;
    try {
      schema.parse(req.body);
      next();
    } catch (error: any) {
      const details = error.errors?.map((err: any) => ({
        field: err.path.join('.'),
        message: err.message
      }));
      throw new HttpException(400, 'Validation failed', 'VALIDATION_ERROR', details);
    }
  };
};

const validateParams = (schema: any) => {
  return (req: Request, res: Response, next: NextFunction) => {
    // Explicitly mark res as used to satisfy strict compiler options
    void res;
    try {
      schema.parse(req.params);
      next();
    } catch (error: any) {
      const details = error.errors?.map((err: any) => ({
        field: err.path.join('.'),
        message: err.message
      }));
      throw new HttpException(400, 'Invalid parameters', 'VALIDATION_ERROR', details);
    }
  };
};

// Routes
router.post(
  '/',
  validateRequest(createSessionSchema),
  sessionController.createSession.bind(sessionController)
);

router.get(
  '/:sessionId',
  validateParams(sessionIdParamSchema),
  sessionController.getSession.bind(sessionController)
);

router.patch(
  '/:sessionId',
  validateParams(sessionIdParamSchema),
  validateRequest(updateSessionStateSchema),
  sessionController.updateSessionState.bind(sessionController)
);

router.post(
  '/:sessionId/end',
  validateParams(sessionIdParamSchema),
  sessionController.endSession.bind(sessionController)
);

export const sessionRoutes = {
  path: '/sessions',
  router,
};


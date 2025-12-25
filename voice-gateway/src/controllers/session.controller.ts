import { Request, Response } from 'express';
import {
  ApiController,
  Post,
  Get,
  Patch,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBody
} from '../utils/swagger.decorators';
import sessionService from '../services/session.service';
import redisService from '../services/redis.service';
import { CreateSessionRequest, UpdateSessionStateRequest } from '../types/session.types';
import { Persona, getAvailablePersonas } from '../types/persona.types';
import logger from '../utils/logger';

@ApiController('/sessions', ['Sessions'])
export class SessionController {
  @Post('/')
  @ApiOperation({
    summary: 'Create a new session',
    description: 'Creates a new session for a user with their information from the entry form'
  })
  @ApiBody({
    description: 'User information from entry form with persona selection',
    schema: {
      type: 'object',
      required: ['name', 'email', 'mobile', 'persona'],
      properties: {
        name: { type: 'string', example: 'John Doe' },
        email: { type: 'string', format: 'email', example: 'john@example.com' },
        mobile: { type: 'string', example: '+1234567890' },
        persona: {
          type: 'string',
          enum: getAvailablePersonas(),
          example: Persona.RESTAURANT_RECEPTIONIST,
          description: 'AI persona to use for this session. Each persona has a dedicated Python worker with persona-specific prompts.'
        }
      }
    }
  })
  @ApiResponse({
    statusCode: '201',
    description: 'Session created successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            sessionId: { type: 'string', format: 'uuid' },
            status: { type: 'string', enum: ['active'] },
            createdAt: { type: 'string', format: 'date-time' }
          }
        }
      }
    }
  })
  @ApiResponse({
    statusCode: '400',
    description: 'Validation error',
    schema: {
      $ref: '#/components/schemas/ErrorResponse'
    }
  })
  async createSession(req: Request, res: Response) {
    const userData: CreateSessionRequest = req.body;
    const metadata = {
      userAgent: req.get('user-agent'),
      ipAddress: req.ip || req.socket.remoteAddress
    };

    const session = await sessionService.createSession(userData, metadata);
    
    // Publish SESSION_INIT control message to trigger speculative connection
    try {
      await redisService.publishEvent(
        `session_control:persona:${session.persona}:session:${session.sessionId}`,
        {
          action: 'SESSION_INIT',
          sessionId: session.sessionId
        }
      );
      logger.info('Published SESSION_INIT control message', {
        sessionId: session.sessionId,
        persona: session.persona
      });
    } catch (error) {
      // Log error but don't fail the session creation
      logger.error('Failed to publish SESSION_INIT control message', {
        error,
        sessionId: session.sessionId,
        persona: session.persona
      });
    }
    
    res.status(201).json({
      success: true,
      data: {
        sessionId: session.sessionId,
        status: session.status,
        createdAt: session.createdAt.toISOString()
      }
    });
  }

  @Get('/:sessionId')
  @ApiOperation({
    summary: 'Get session details',
    description: 'Retrieves detailed information about a specific session'
  })
  @ApiParam({
    name: 'sessionId',
    type: 'string',
    required: true,
    description: 'Unique session identifier (UUID)'
  })
  @ApiResponse({
    statusCode: '200',
    description: 'Session details retrieved successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            userInfo: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                email: { type: 'string' },
                mobile: { type: 'string' }
              }
            },
            status: { type: 'string', enum: ['active', 'ended', 'timeout'] },
            conversationState: { type: 'object' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        }
      }
    }
  })
  @ApiResponse({
    statusCode: '404',
    description: 'Session not found',
    schema: {
      $ref: '#/components/schemas/ErrorResponse'
    }
  })
  async getSession(req: Request, res: Response) {
    const { sessionId } = req.params;
    const session = await sessionService.getSession(sessionId);

    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        persona: session.persona,
        userInfo: session.userInfo,
        connectionType: session.connectionType,
        socketId: session.socketId,
        status: session.status,
        conversationState: session.conversationState,
        geminiConfig: session.geminiConfig,
        metadata: session.metadata,
        createdAt: session.createdAt.toISOString(),
        updatedAt: session.updatedAt.toISOString(),
        endedAt: session.endedAt?.toISOString(),
        duration: session.duration
      }
    });
  }

  @Patch('/:sessionId')
  @ApiOperation({
    summary: 'Update session state',
    description: 'Updates the conversation state or status of a session. Typically called by Python worker when intent is detected.'
  })
  @ApiParam({
    name: 'sessionId',
    type: 'string',
    required: true,
    description: 'Unique session identifier (UUID)'
  })
  @ApiBody({
    description: 'Session state update data',
    schema: {
      type: 'object',
      properties: {
        conversationState: {
          type: 'object',
          properties: {
            intent: {
              type: 'string',
              enum: ['table_booking', 'takeaway', 'extend_booking', 'general_query']
            },
            bookingDetails: { type: 'object' },
            orderDetails: { type: 'object' },
            callbackScheduled: { type: 'object' }
          }
        },
        status: { type: 'string', enum: ['active', 'ended'] }
      }
    }
  })
  @ApiResponse({
    statusCode: '200',
    description: 'Session state updated successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            status: { type: 'string' },
            conversationState: { type: 'object' }
          }
        }
      }
    }
  })
  @ApiResponse({
    statusCode: '400',
    description: 'Invalid session state or session already ended',
    schema: {
      $ref: '#/components/schemas/ErrorResponse'
    }
  })
  @ApiResponse({
    statusCode: '404',
    description: 'Session not found',
    schema: {
      $ref: '#/components/schemas/ErrorResponse'
    }
  })
  async updateSessionState(req: Request, res: Response) {
    const { sessionId } = req.params;
    const updateData: UpdateSessionStateRequest = req.body;

    const session = await sessionService.updateSessionState(sessionId, updateData);

    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        status: session.status,
        conversationState: session.conversationState
      }
    });
  }

  @Post('/:sessionId/end')
  @ApiOperation({
    summary: 'End a session',
    description: 'Marks a session as ended and calculates the duration'
  })
  @ApiParam({
    name: 'sessionId',
    type: 'string',
    required: true,
    description: 'Unique session identifier (UUID)'
  })
  @ApiResponse({
    statusCode: '200',
    description: 'Session ended successfully',
    schema: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: {
          type: 'object',
          properties: {
            sessionId: { type: 'string' },
            endedAt: { type: 'string', format: 'date-time' },
            duration: { type: 'number', description: 'Duration in seconds' }
          }
        }
      }
    }
  })
  @ApiResponse({
    statusCode: '400',
    description: 'Session already ended',
    schema: {
      $ref: '#/components/schemas/ErrorResponse'
    }
  })
  @ApiResponse({
    statusCode: '404',
    description: 'Session not found',
    schema: {
      $ref: '#/components/schemas/ErrorResponse'
    }
  })
  async endSession(req: Request, res: Response) {
    const { sessionId } = req.params;
    const session = await sessionService.endSession(sessionId);

    res.json({
      success: true,
      data: {
        sessionId: session.sessionId,
        endedAt: session.endedAt?.toISOString(),
        duration: session.duration
      }
    });
  }
}

export default SessionController;


import { Request, Response } from 'express';
import { ApiController, Get, ApiOperation, ApiResponse } from '../utils/swagger.decorators';

@ApiController('/health', ['System'])
export class HealthController {
  @Get('/')
  @ApiOperation({
    summary: 'Health check',
    description: 'Check if the API is running'
  })
  @ApiResponse({
    statusCode: '200',
    description: 'Service is healthy',
    schema: {
      type: 'object',
      properties: {
        status: { type: 'string' },
        timestamp: { type: 'string' },
        uptime: { type: 'number' }
      }
    }
  })
  @ApiResponse({
    statusCode: '500',
    description: 'Internal server error',
    schema: {
      $ref: '#/components/schemas/ErrorResponse'
    }
  })
  async health(req: Request, res: Response) {
    // Explicitly mark req as used to satisfy strict compiler options
    void req;
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  }
}

export default HealthController;

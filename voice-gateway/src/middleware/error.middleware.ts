import { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import logger from '../utils/logger';

export class HttpException extends Error {
    public status: number;
    public message: string;
    public code?: string;
    public details?: any;

    constructor(status: number, message: string, code?: string, details?: any) {
        super(message);
        this.status = status;
        this.message = message;
        if (code !== undefined) this.code = code;
        if (details !== undefined) this.details = details;
    }
}

const errorMiddleware: ErrorRequestHandler = (error: any, req: Request, res: Response, next: NextFunction): void => {
    // Explicitly mark next as used to satisfy strict compiler options
    void next;
    // Log the error
    logger.error('Error occurred', {
        error: error.message,
        stack: error.stack,
        url: req.url,
        method: req.method,
        body: req.body,
        params: req.params,
        query: req.query,
        user: (req as any).user
    });

    // Handle custom HTTP exceptions
    if (error instanceof HttpException) {
        const response: any = {
            success: false,
            message: error.message
        };
        
        if (error.code) {
            response.code = error.code;
        }
        
        if (error.details) {
            response.details = error.details;
        }

        res.status(error.status).json(response);
        return;
    }

    // Handle validation errors
    if (error.name === 'ValidationError') {
        res.status(400).json({
            success: false,
            message: 'Validation failed',
            code: 'VALIDATION_ERROR',
            details: error.details || error.message
        });
        return;
    }

    // Handle generic errors
    res.status(500).json({
        success: false,
        message: 'Internal server error',
        code: 'INTERNAL_ERROR'
    });
};

export default errorMiddleware;

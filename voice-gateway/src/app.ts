import express, { Application, Request, Response } from 'express';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import { generateSwaggerSpec } from './utils/swagger.util';
import errorMiddleware, { HttpException } from './middleware/error.middleware';
import http from 'http';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import type { NextFunction } from 'express';
import { SocketService } from './services/socket.service';

class App {
    public app: Application;
    public server: http.Server;
    public io: SocketService;
    public port: number;
    public apiVersion: string;

    constructor(controllers: any[], routes: { path: string, router: express.Router }[], port: number, apiVersion: string = 'v1') {
        this.app = express();
        this.server = http.createServer(this.app);
        this.io = new SocketService(this.server);
        this.port = port;
        this.apiVersion = apiVersion;

        this.initializeMiddlewares();
        this.initializeRoutes(routes);
        this.initializeSwagger(controllers);
        this.initializeErrorHandling();
    }  

    private initializeMiddlewares() {
        // CORS configuration - MUST be before other middleware
        const corsOrigin = process.env.CORS_ORIGIN || '*';
        const allowedOrigins = corsOrigin.includes(',') 
            ? corsOrigin.split(',').map(o => o.trim())
            : corsOrigin;
        
        this.app.use(cors({
            origin: (origin, callback) => {
                // Allow requests with no origin (like mobile apps or curl requests)
                if (!origin) {
                    console.log('CORS: Allowing request with no origin');
                    return callback(null, true);
                }
                
                console.log(`CORS: Checking origin: ${origin}, NODE_ENV: ${process.env.NODE_ENV}, CORS_ORIGIN: ${corsOrigin}`);
                
                // In development, allow any localhost origin
                if (process.env.NODE_ENV !== 'production' && origin.startsWith('http://localhost:')) {
                    console.log('CORS: Allowing localhost origin (development mode)');
                    return callback(null, true);
                }
                
                // Always allow localhost origins regardless of NODE_ENV for local development
                if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
                    console.log('CORS: Allowing localhost origin');
                    return callback(null, true);
                }
                
                if (allowedOrigins === '*') {
                    console.log('CORS: Allowing all origins (*)');
                    callback(null, true);
                } else if (Array.isArray(allowedOrigins) && allowedOrigins.includes(origin)) {
                    console.log('CORS: Allowing origin from allowed list');
                    callback(null, true);
                } else if (typeof allowedOrigins === 'string' && allowedOrigins === origin) {
                    console.log('CORS: Allowing exact match origin');
                    callback(null, true);
                } else {
                    console.log(`CORS: Rejecting origin: ${origin}`);
                    callback(new Error('Not allowed by CORS'));
                }
            },
            credentials: true,
            methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
            allowedHeaders: ['Content-Type', 'Authorization'],
            preflightContinue: false,
            optionsSuccessStatus: 204
        }));
        
        // Security middleware - configured to not interfere with CORS
        this.app.use(helmet({
            crossOriginResourcePolicy: { policy: "cross-origin" },
            crossOriginEmbedderPolicy: false
        }));
        
        // Compression middleware
        this.app.use(compression());
        
        // Rate limiting
        const limiter = rateLimit({
            windowMs: 15 * 60 * 1000, // 15 minutes
            max: 100, // limit each IP to 100 requests per windowMs
            message: {
                error: 'Too many requests from this IP, please try again later.'
            }
        });
        this.app.use('/api/', limiter);
        
        this.app.use(express.json({ limit: '10mb' }));
        this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));
    }

    private initializeSwagger(controllers: any[]) {
        const swaggerSpec = generateSwaggerSpec(controllers);
        this.app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
    }

    private initializeRoutes(routes: { path: string, router: express.Router }[]) {
        const apiPrefix = `/api/${this.apiVersion}`;
        routes.forEach((route) => {
            if (route && route.path && route.router) {
                this.app.use(`${apiPrefix}${route.path}`, route.router);
            } else {
                console.warn(`Route at path ${route?.path} is missing a 'path' or 'router' property.`);
            }
        });
        // Default route for service welcome
        this.app.get('/', (req: Request, res: Response) => {
            // Explicitly mark req as used to satisfy strict compiler options
            void req;
            res.send("Welcome to API service");
        });

        // Catch-all 404 for unknown routes under the API prefix
        this.app.use((req: Request, res: Response, next: NextFunction) => {
            // Explicitly mark res as used to satisfy strict compiler options
            void res;
            if (req.path.startsWith(apiPrefix)) {
                return next(
                    new HttpException(
                        404,
                        `Route ${req.originalUrl} not found`,
                        'NOT_FOUND'
                    )
                );
            }
            return next();
        });
    }

    private initializeErrorHandling() {
        // Use the centralized error handling middleware
        this.app.use(errorMiddleware);
    }

    public listen() {
        this.server.listen(this.port, '0.0.0.0', () => {
            console.log(`App listening on http://0.0.0.0:${this.port}`);
            console.log(`CORS Origin: ${process.env.CORS_ORIGIN || '*'}`);
            console.log(`NODE_ENV: ${process.env.NODE_ENV || 'development'}`);
        });
    }
}

export default App;

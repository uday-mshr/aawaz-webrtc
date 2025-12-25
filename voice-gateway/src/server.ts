import 'reflect-metadata';
import App from './app';
import dotenv from 'dotenv';
import { loadSchemas } from './utils/schema-loader';
import HealthController from './controllers/health.controller';
import SessionController from './controllers/session.controller';
import { healthRoutes } from './routes/health.route';
import { sessionRoutes } from './routes/session.route';
import database from './config/database';
import logger from './utils/logger';

dotenv.config();

const PORT = process.env.PORT || 3000;
const API_VERSION = process.env.API_VERSION || 'v1';

(async () => {
    try {
        // Connect to MongoDB
        logger.info('Connecting to MongoDB...');
        await database.connect();
        logger.info('MongoDB connected successfully');

        // Load schemas if needed
        console.log('Loading schemas...');
        loadSchemas({
            'ErrorResponse': {
                type: 'object',
                properties: {
                    success: { type: 'boolean' },
                    message: { type: 'string' },
                    code: { type: 'string' },
                    details: { type: 'object', additionalProperties: true }
                }
            }
        });

        // Register controllers and routes
        const controllers = [HealthController, SessionController];
        const routes = [healthRoutes, sessionRoutes];

        // Initialize the application
        const app = new App(controllers, routes, Number(PORT), API_VERSION);

        // Start the server
        app.listen();
    } catch (error) {
        logger.error('Failed to start server', { error });
        process.exit(1);
    }
})();

// Handle graceful shutdown
process.on('SIGINT', async () => {
    console.log('\nGracefully shutting down');
    try {
        await database.disconnect();
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', { error });
        process.exit(1);
    }
});

process.on('SIGTERM', async () => {
    console.log('\nTerminating');
    try {
        await database.disconnect();
        process.exit(0);
    } catch (error) {
        logger.error('Error during shutdown', { error });
        process.exit(1);
    }
});

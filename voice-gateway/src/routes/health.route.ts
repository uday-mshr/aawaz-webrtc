import { Router } from 'express';
import HealthController from '../controllers/health.controller';

const router = Router();
const healthController = new HealthController();

router.get('/', healthController.health.bind(healthController));

export const healthRoutes = {
  path: '/health',
  router,
};

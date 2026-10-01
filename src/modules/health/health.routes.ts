// Health endpoints for load balancers and orchestrators. Infrastructure, so not versioned
// under /api/v1 and not wrapped in the API envelope.
import { Router } from 'express';
import type { HealthService } from './health.service.ts';

export function createHealthRouter(health: HealthService): Router {
  const router = Router();

  router.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });

  router.get('/ready', async (_req, res) => {
    const report = await health.readiness();
    res.status(report.status === 'ready' ? 200 : 503).json(report);
  });

  return router;
}

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
    // `degraded` still takes traffic; only critical failures and draining return 503.
    const serving = report.status === 'ready' || report.status === 'degraded';
    res.status(serving ? 200 : 503).json(report);
  });

  return router;
}

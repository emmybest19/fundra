// Mounts all module routers under /api/v1.
import { Router } from 'express';

export const apiRouter = Router();

// Module routers are mounted here as each module is built, e.g.:
// apiRouter.use('/auth', authRouter);

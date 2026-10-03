// HTTP layer for auth: parse request, call service, shape response.
import { success } from '../../common/utils/response.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import { toPublicUser } from '../users/user.types.ts';
import { registerBody } from './auth.schema.ts';
import type { AuthService } from './auth.service.ts';

export function createAuthController(auth: AuthService) {
  return {
    register: validated({ body: registerBody }, async ({ body }, req, res) => {
      const user = await auth.register(body, auditContextFrom(req));
      res.status(201).json(success({ user: toPublicUser(user) }));
    }),
  };
}

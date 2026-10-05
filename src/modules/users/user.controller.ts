// HTTP layer for users: parse request, call service, shape response.
import { success } from '../../common/utils/response.ts';
import { authOf } from '../../middleware/auth.middleware.ts';
import { validated } from '../../middleware/validation.middleware.ts';
import { auditContextFrom } from '../audit/audit.service.ts';
import { noStore, tokenResponse } from '../auth/auth.controller.ts';
import { preferencesPatch } from './preferences.ts';
import {
  changePasswordBody,
  confirmEmailChangeBody,
  confirmPhoneChangeBody,
  deactivateBody,
  requestEmailChangeBody,
  requestPhoneChangeBody,
  updateProfileBody,
} from './user.schema.ts';
import type { PasswordChanger, UserService } from './user.service.ts';

export function createUserController(users: UserService, passwords: PasswordChanger) {
  return {
    getProfile: validated({}, async (_input, req, res) => {
      res.json(success({ user: await users.getProfile(authOf(req).userId) }));
    }),

    updateProfile: validated({ body: updateProfileBody }, async ({ body }, req, res) => {
      const user = await users.updateProfile(authOf(req).userId, body, auditContextFrom(req));
      res.json(success({ user }));
    }),

    getPreferences: validated({}, async (_input, req, res) => {
      res.json(success({ preferences: await users.getPreferences(authOf(req).userId) }));
    }),

    updatePreferences: validated({ body: preferencesPatch }, async ({ body }, req, res) => {
      const preferences = await users.updatePreferences(
        authOf(req).userId,
        body,
        auditContextFrom(req),
      );
      res.json(success({ preferences }));
    }),

    requestEmailChange: validated({ body: requestEmailChangeBody }, async ({ body }, req, res) => {
      await users.requestContactChange(
        authOf(req).userId,
        'email',
        body.newEmail,
        body.password,
        auditContextFrom(req),
      );
      // Same response whether or not the address belongs to another account.
      res.status(202).json(success({ sent: true }));
    }),

    confirmEmailChange: validated({ body: confirmEmailChangeBody }, async ({ body }, req, res) => {
      const user = await users.confirmContactChange(
        authOf(req).userId,
        'email',
        body.newEmail,
        body.code,
        auditContextFrom(req),
      );
      res.json(success({ user }));
    }),

    requestPhoneChange: validated({ body: requestPhoneChangeBody }, async ({ body }, req, res) => {
      await users.requestContactChange(
        authOf(req).userId,
        'phone',
        body.newPhone,
        body.password,
        auditContextFrom(req),
      );
      res.status(202).json(success({ sent: true }));
    }),

    confirmPhoneChange: validated({ body: confirmPhoneChangeBody }, async ({ body }, req, res) => {
      const user = await users.confirmContactChange(
        authOf(req).userId,
        'phone',
        body.newPhone,
        body.code,
        auditContextFrom(req),
      );
      res.json(success({ user }));
    }),

    changePassword: validated({ body: changePasswordBody }, async ({ body }, req, res) => {
      const { userId, sessionId } = authOf(req);
      const tokens = await passwords.changePassword(
        userId,
        sessionId,
        body.currentPassword,
        body.newPassword,
        auditContextFrom(req),
      );
      // The old tokens are dead: the client must switch to these.
      noStore(res).json(success(tokenResponse(tokens)));
    }),

    deactivate: validated({ body: deactivateBody }, async ({ body }, req, res) => {
      await users.deactivate(authOf(req).userId, body.password, body.reason, auditContextFrom(req));
      res.status(204).end();
    }),
  };
}

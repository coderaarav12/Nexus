import { Router } from 'express';
import { requireAuth, authContext } from '../middleware/auth';
import { AuthError } from '../services/authService';
import {
  privateStatus,
  setPrivatePassword,
  unlockPrivateFolder,
  adminResetPrivatePassword,
  getPrivateRoot,
} from '../services/privateService';

export const privateRouter = Router();

const handle = (fn: (req: any, res: any) => void) => (req: any, res: any) => {
  try {
    fn(req, res);
  } catch (err) {
    if (err instanceof AuthError) res.status(err.status).json({ error: err.message });
    else {
      console.error('route error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  }
};

privateRouter.use(requireAuth);

privateRouter.get(
  '/status',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ status: privateStatus(user) });
  }),
);

privateRouter.get(
  '/root',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ folder: getPrivateRoot(user) });
  }),
);

privateRouter.post(
  '/password',
  handle((req, res) => {
    const { user } = authContext(req);
    const { current, next } = req.body ?? {};
    setPrivatePassword(user, typeof current === 'string' ? current : undefined, typeof next === 'string' ? next : '');
    res.json({ ok: true });
  }),
);

privateRouter.post(
  '/unlock',
  handle((req, res) => {
    const { user } = authContext(req);
    const { password } = req.body ?? {};
    if (typeof password !== 'string') throw new AuthError(400, 'password required');
    const token = unlockPrivateFolder(user, password);
    res.json({ token });
  }),
);

// Admin: reset (or clear) any user's private folder password.
privateRouter.post(
  '/admin/reset',
  handle((req, res) => {
    const { user } = authContext(req);
    const { userId, password } = req.body ?? {};
    adminResetPrivatePassword(user, Number(userId), password ? String(password) : null);
    res.json({ ok: true });
  }),
);

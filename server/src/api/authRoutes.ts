import { Router } from 'express';
import {
  createUser,
  startLogin,
  completeMfa,
  registerDevice,
  rotateRefreshToken,
  revokeRefreshToken,
  revokeDevice,
  listDevices,
  renameDevice,
  listSecurityLogs,
  setupTotp,
  enableTotp,
  disableTotp,
  listNotifications,
  markNotificationsRead,
  changePassword,
  createNotification,
  findUserById,
  AuthError,
} from '../services/authService';
import { requireAuth, authContext } from '../middleware/auth';

export const authRouter = Router();

const handle = (fn: (req: any, res: any) => Promise<void> | void) => (req: any, res: any) => {
  try {
    Promise.resolve(fn(req, res)).catch((err) => {
      if (err instanceof AuthError) res.status(err.status).json({ error: err.message });
      else {
        console.error('route error:', err);
        res.status(500).json({ error: 'internal error' });
      }
    });
  } catch (err) {
    if (err instanceof AuthError) res.status(err.status).json({ error: err.message });
    else {
      console.error('route error:', err);
      res.status(500).json({ error: 'internal error' });
    }
  }
};

authRouter.post(
  '/register',
  handle((req, res) => {
    const { username, password, displayName } = req.body ?? {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const user = createUser(username, password, displayName);
    res.status(201).json({ id: user.id, username: user.username, role: user.role });
  }),
);

authRouter.post(
  '/login',
  handle((req, res) => {
    const { username, password } = req.body ?? {};
    if (!username || !password) return res.status(400).json({ error: 'username and password required' });
    const result = startLogin(username, password, req.ip, req.get('user-agent'));
    res.json(result);
  }),
);

authRouter.post(
  '/mfa',
  handle((req, res) => {
    const { grantToken, code } = req.body ?? {};
    if (!grantToken || !code) return res.status(400).json({ error: 'grantToken and code required' });
    const token = completeMfa(grantToken, code, req.ip, req.get('user-agent'));
    res.json({ grantToken: token });
  }),
);

authRouter.post(
  '/devices/register',
  handle((req, res) => {
    const { grantToken, name, platform, osVersion } = req.body ?? {};
    if (!grantToken) return res.status(400).json({ error: 'grantToken required' });
    const out = registerDevice(grantToken, name, platform, osVersion, req.ip, req.get('user-agent'));
    res.status(201).json(out);
  }),
);

authRouter.post(
  '/refresh',
  handle((req, res) => {
    const { refreshToken } = req.body ?? {};
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken required' });
    const out = rotateRefreshToken(refreshToken, req.ip, req.get('user-agent'));
    res.json(out);
  }),
);

authRouter.post(
  '/logout',
  handle((req, res) => {
    const { refreshToken } = req.body ?? {};
    if (refreshToken) revokeRefreshToken(refreshToken);
    res.json({ ok: true });
  }),
);

authRouter.use(requireAuth);

authRouter.get(
  '/me',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({
      id: user.id,
      username: user.username,
      displayName: user.display_name,
      role: user.role,
      totpEnabled: !!user.totp_enabled,
      settings: user.settings ? JSON.parse(user.settings) : null,
    });
  }),
);

authRouter.get(
  '/devices',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ devices: listDevices(user.id) });
  }),
);

authRouter.post(
  '/devices/:id/rename',
  handle((req, res) => {
    const { user } = authContext(req);
    renameDevice(user.id, Number(req.params.id), req.body?.name ?? '');
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/devices/:id/revoke',
  handle((req, res) => {
    const { user } = authContext(req);
    revokeDevice(user.id, Number(req.params.id));
    createNotification(user.id, 'warning', `Device revoked`);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/security-log',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ logs: listSecurityLogs(user.id) });
  }),
);

authRouter.post(
  '/2fa/setup',
  handle((req, res) => {
    const { user } = authContext(req);
    const out = setupTotp(user.id);
    res.json(out);
  }),
);

authRouter.post(
  '/2fa/enable',
  handle((req, res) => {
    const { user } = authContext(req);
    enableTotp(user.id, req.body?.code ?? '');
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/2fa/disable',
  handle((req, res) => {
    const { user } = authContext(req);
    disableTotp(user.id, req.body?.code ?? '');
    res.json({ ok: true });
  }),
);

authRouter.post(
  '/change-password',
  handle((req, res) => {
    const { user } = authContext(req);
    changePassword(user.id, req.body?.oldPassword ?? '', req.body?.newPassword ?? '');
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/notifications',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ notifications: listNotifications(user.id) });
  }),
);

authRouter.post(
  '/notifications/read',
  handle((req, res) => {
    const { user } = authContext(req);
    markNotificationsRead(user.id);
    res.json({ ok: true });
  }),
);

authRouter.get(
  '/whoami',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ id: user.id, username: user.username, role: user.role });
  }),
);

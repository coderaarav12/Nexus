import { Router } from 'express';
import { requireAuth, authContext } from '../middleware/auth';
import {
  createWorkspace,
  listWorkspacesForUser,
  addMember,
  removeMember,
  listMembers,
  deleteWorkspace,
  requireWorkspaceAccess,
} from '../services/sharingService';
import { listChildren, createFolder, softDelete } from '../services/storageService';
import { AuthError } from '../services/authService';
import { findUsersByUsername } from '../services/sharingService';

export const sharingRouter = Router();

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

sharingRouter.use(requireAuth);

sharingRouter.get(
  '/workspaces',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ workspaces: listWorkspacesForUser(user.id) });
  }),
);

sharingRouter.post(
  '/workspaces',
  handle((req, res) => {
    const { user } = authContext(req);
    const { name, kind } = req.body ?? {};
    if (!name) return res.status(400).json({ error: 'name required' });
    const ws = createWorkspace(user, name, kind ?? 'shared');
    res.status(201).json({ workspace: ws });
  }),
);

sharingRouter.get(
  '/workspaces/:id',
  handle((req, res) => {
    const { user } = authContext(req);
    const { ws, role } = requireWorkspaceAccess(Number(req.params.id), user, 'viewer');
    const members = listMembers(user, ws.id);
    res.json({ workspace: ws, role, members });
  }),
);

sharingRouter.delete(
  '/workspaces/:id',
  handle((req, res) => {
    const { user } = authContext(req);
    deleteWorkspace(user, Number(req.params.id));
    res.json({ ok: true });
  }),
);

sharingRouter.get(
  '/users/search',
  handle((req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    res.json({ users: findUsersByUsername(q) });
  }),
);

sharingRouter.post(
  '/workspaces/:id/members',
  handle((req, res) => {
    const { user } = authContext(req);
    const { userId, role } = req.body ?? {};
    if (!userId || !role) return res.status(400).json({ error: 'userId and role required' });
    addMember(user, Number(req.params.id), Number(userId), role);
    res.status(201).json({ ok: true });
  }),
);

sharingRouter.delete(
  '/workspaces/:id/members/:userId',
  handle((req, res) => {
    const { user } = authContext(req);
    removeMember(user, Number(req.params.id), Number(req.params.userId));
    res.json({ ok: true });
  }),
);

sharingRouter.get(
  '/workspaces/:id/items',
  handle((req, res) => {
    const { user } = authContext(req);
    requireWorkspaceAccess(Number(req.params.id), user, 'viewer');
    res.json({ items: listChildren(user, null, Number(req.params.id)) });
  }),
);

sharingRouter.post(
  '/workspaces/:id/folder',
  handle((req, res) => {
    const { user } = authContext(req);
    const { name, parentId } = req.body ?? {};
    const folder = createFolder(user, name, parentId ? Number(parentId) : null, Number(req.params.id));
    res.status(201).json({ folder });
  }),
);

sharingRouter.delete(
  '/workspaces/:id/items/:itemId',
  handle((req, res) => {
    const { user } = authContext(req);
    softDelete(user, Number(req.params.itemId));
    res.json({ ok: true });
  }),
);

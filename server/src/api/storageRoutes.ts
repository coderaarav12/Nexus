import { Router } from 'express';
import fs from 'node:fs';
import { requireAuth, authContext } from '../middleware/auth';
import {
  listChildren,
  createFolder,
  softDelete,
  listVersions,
  restoreVersion,
  getItem,
  getContentBuffer,
} from '../services/storageService';
import { AuthError } from '../services/authService';
import { canAccessItem } from '../services/sharingService';

export const storageRouter = Router();

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

storageRouter.use(requireAuth);

storageRouter.get(
  '/vault',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ items: listChildren(user, null) });
  }),
);

storageRouter.get(
  '/vault/:parentId',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ items: listChildren(user, Number(req.params.parentId)) });
  }),
);

storageRouter.post(
  '/vault/folder',
  handle((req, res) => {
    const { user } = authContext(req);
    const { name, parentId, workspaceId } = req.body ?? {};
    const folder = createFolder(user, name, parentId ? Number(parentId) : null, workspaceId ? Number(workspaceId) : undefined);
    res.status(201).json({ folder });
  }),
);

storageRouter.post(
  '/vault/:itemId/restore',
  handle((req, res) => {
    const { user } = authContext(req);
    restoreVersion(user, Number(req.params.itemId), Number(req.body?.version));
    res.json({ ok: true });
  }),
);

storageRouter.get(
  '/vault/:itemId/versions',
  handle((req, res) => {
    const { user } = authContext(req);
    res.json({ versions: listVersions(user, Number(req.params.itemId)) });
  }),
);

storageRouter.delete(
  '/vault/:itemId',
  handle((req, res) => {
    const { user } = authContext(req);
    softDelete(user, Number(req.params.itemId));
    res.json({ ok: true });
  }),
);

storageRouter.get(
  '/vault/:itemId/content',
  handle((req, res) => {
    const { user } = authContext(req);
    const item = getItem(Number(req.params.itemId));
    if (!item || !canAccessItem(item, user, 'viewer')) return res.status(404).json({ error: 'not found' });
    if (item.kind !== 'file' || !item.sha256) return res.status(400).json({ error: 'not a file' });
    const buf = getContentBuffer(item);
    const name = encodeURIComponent(item.name).replace(/'/g, '%27');
    res.set('Content-Type', 'application/octet-stream');
    res.set('Content-Disposition', `attachment; filename*=UTF-8''${name}`);
    res.set('X-Sha256', item.sha256);
    res.send(buf);
  }),
);

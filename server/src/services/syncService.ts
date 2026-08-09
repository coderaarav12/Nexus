import crypto from 'node:crypto';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import { config } from '../config';
import { randomToken } from '../lib/crypto';
import type { ItemRow, UserRow, TransferRow, RouteInfo, ManifestEntry } from '../types';
import { AuthError } from './authService';
import { chooseRoute } from './gatewayService';
import {
  getItem,
  archiveVersion,
  ensureVaultRoot,
  ensureWorkspaceRoot,
  buildItemPath,
} from './storageService';
import { canAccessItem, requireWorkspaceAccess, getUserRole } from './sharingService';
import { indexItem } from './searchService';
import { contentPath, ensureContentDirs, contentExists } from '../lib/paths';

function sha256FileSync(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function getTransferByJob(jobId: string): TransferRow | undefined {
  return db.prepare('SELECT * FROM transfers WHERE job_id = ?').get(jobId) as unknown as TransferRow | undefined;
}

export function findUploadTarget(user: UserRow, parentId: number | null, workspaceId: number | null, filename: string): ItemRow | undefined {
  if (workspaceId) {
    return db
      .prepare('SELECT * FROM items WHERE workspace_id = ? AND parent_id = ? AND name = ? AND deleted = 0')
      .get(workspaceId, parentId, filename) as unknown as ItemRow | undefined;
  }
  if (!parentId) {
    const root = ensureVaultRoot(user.id);
    return db
      .prepare('SELECT * FROM items WHERE owner_id = ? AND workspace_id IS NULL AND parent_id = ? AND name = ? AND deleted = 0')
      .get(user.id, root.id, filename) as unknown as ItemRow | undefined;
  }
  const parent = getItem(parentId);
  if (!parent) throw new AuthError(404, 'parent not found');
  if (!canAccessItem(parent, user, 'editor')) throw new AuthError(403, 'forbidden');
  return db
    .prepare('SELECT * FROM items WHERE parent_id = ? AND name = ? AND deleted = 0')
    .get(parentId, filename) as unknown as ItemRow | undefined;
}

export function resolveParent(user: UserRow, parentId: number | null, workspaceId: number | null): { parentId: number | null; scopeWs: number | null } {
  if (workspaceId) {
    requireWorkspaceAccess(workspaceId, user, 'editor');
    const root = ensureWorkspaceRoot(workspaceId);
    return { parentId: parentId ?? root.id, scopeWs: workspaceId };
  }
  if (parentId) {
    const parent = getItem(parentId);
    if (!parent) throw new AuthError(404, 'parent not found');
    if (parent.workspace_id) {
      requireWorkspaceAccess(parent.workspace_id, user, 'editor');
      return { parentId, scopeWs: parent.workspace_id };
    }
    if (parent.owner_id !== user.id) throw new AuthError(403, 'forbidden');
    return { parentId, scopeWs: null };
  }
  const root = ensureVaultRoot(user.id);
  return { parentId: root.id, scopeWs: null };
}

export interface UploadRequest {
  filename: string;
  size: number;
  sha256: string;
  mtime?: number;
  parentId?: number | null;
  workspaceId?: number | null;
}

export interface UploadJobResult {
  jobId: string | null;
  jobToken: string | null;
  itemId: number;
  chunkSize: number;
  totalBytes: number;
  sha256: string;
  route: RouteInfo;
  deduped: boolean;
  noChange: boolean;
}

export function createUploadJob(user: UserRow, deviceId: number, req: UploadRequest, remoteIp?: string): UploadJobResult {
  const filename = req.filename;
  if (!filename || filename.includes('/') || filename.includes('\\') || filename === '..') {
    throw new AuthError(400, 'invalid filename');
  }
  const size = Number(req.size);
  const sha256 = req.sha256;
  if (!sha256 || !/^[a-f0-9]{64}$/i.test(sha256)) throw new AuthError(400, 'valid sha256 required');
  if (!Number.isFinite(size) || size < 0) throw new AuthError(400, 'invalid size');

  const { parentId, scopeWs } = resolveParent(user, req.parentId ?? null, req.workspaceId ?? null);
  let existing = findUploadTarget(user, parentId, scopeWs, filename);
  let item: ItemRow;

  if (existing) {
    if (existing.sha256 === sha256 && existing.size === size) {
      return { deduped: true, noChange: true, itemId: existing.id, jobId: null, jobToken: null, chunkSize: config.chunkSize, totalBytes: size, sha256, route: { mode: 'direct', reason: 'deduped' } };
    }
    item = existing;
  } else {
    const now = Date.now();
    const info = db
      .prepare(
        `INSERT INTO items (owner_id, workspace_id, parent_id, name, kind, sha256, size, mtime, version, created_at, updated_at)
         VALUES (?,?,?,?,'file',NULL,?,?,1,?,?)`,
      )
      .run(user.id, scopeWs, parentId, filename, size, req.mtime ?? now, now, now);
    item = getItem(Number(info.lastInsertRowid))!;
  }

  if (contentExists(sha256, size)) {
    if (!existing) {
      const now = Date.now();
      db.prepare('UPDATE items SET sha256 = ?, mtime = ?, updated_at = ? WHERE id = ?').run(
        sha256,
        req.mtime ?? now,
        now,
        item.id,
      );
      indexItem(getItem(item.id)!);
    }
    return { deduped: true, noChange: existing?.sha256 === sha256, itemId: item.id, jobId: null, jobToken: null, chunkSize: config.chunkSize, totalBytes: size, sha256, route: { mode: 'direct', reason: 'content already stored' } };
  }

  const route = chooseRoute(remoteIp);
  const jobId = randomUUID();
  const jobToken = randomToken(24);
  const now = Date.now();
  db.prepare(
    `INSERT INTO transfers (job_id, user_id, device_id, item_id, direction, status, total_bytes, bytes_done, chunk_size, node_id, node_name, job_token, sha256, created_at, updated_at)
     VALUES (?,?,?,?,'upload','queued',?,0,?,?,?,?,?,?,?)`,
  ).run(
    jobId,
    user.id,
    deviceId,
    item.id,
    size,
    config.chunkSize,
    route.node?.id ?? 0,
    route.node?.name ?? 'server',
    jobToken,
    sha256,
    now,
    now,
  );
  return {
    jobId,
    jobToken,
    itemId: item.id,
    chunkSize: config.chunkSize,
    totalBytes: size,
    sha256,
    route,
    deduped: false,
    noChange: false,
  };
}

export function createDownloadJob(user: UserRow, deviceId: number, itemId: number, remoteIp?: string) {
  const item = getItem(itemId);
  if (!item || !canAccessItem(item, user, 'viewer')) throw new AuthError(404, 'file not found');
  if (item.kind !== 'file' || !item.sha256) throw new AuthError(400, 'not a downloadable file');
  if (!contentExists(item.sha256, item.size)) throw new AuthError(500, 'content missing on server');

  const route = chooseRoute(remoteIp);
  const jobId = randomUUID();
  const jobToken = randomToken(24);
  const now = Date.now();
  db.prepare(
    `INSERT INTO transfers (job_id, user_id, device_id, item_id, direction, status, total_bytes, bytes_done, chunk_size, node_id, node_name, job_token, sha256, created_at, updated_at)
     VALUES (?,?,?,?,'download','queued',?,0,?,?,?,?,?,?,?)`,
  ).run(
    jobId,
    user.id,
    deviceId,
    item.id,
    item.size,
    config.chunkSize,
    route.node?.id ?? 0,
    route.node?.name ?? 'server',
    jobToken,
    item.sha256,
    now,
    now,
  );
  return {
    jobId,
    jobToken,
    itemId: item.id,
    chunkSize: config.chunkSize,
    totalBytes: item.size,
    sha256: item.sha256,
    name: item.name,
    route,
  };
}

export function reassignTransfer(userId: number, jobId: string, remoteIp?: string): { route: RouteInfo; transfer: TransferRow } {
  const t = getTransferByJob(jobId);
  if (!t || t.user_id !== userId) throw new AuthError(404, 'transfer not found');
  if (t.status === 'done' || t.status === 'failed') throw new AuthError(400, 'transfer already finished');
  const route = chooseRoute(remoteIp);
  if (t.reassign_count >= config.maxReassignments) throw new AuthError(409, 'max reassignments reached');
  db.prepare(
    'UPDATE transfers SET node_id = ?, node_name = ?, status = ?, reassign_count = reassign_count + 1, updated_at = ? WHERE id = ?',
  ).run(route.node?.id ?? 0, route.node?.name ?? 'server', 'queued', Date.now(), t.id);
  return { route, transfer: getTransferByJob(jobId)! };
}

// ---------- chunk engine (direct path: device <-> server) ----------

function authTransfer(jobId: string, jobToken: string, direction: string): TransferRow {
  const t = getTransferByJob(jobId);
  if (!t || t.job_token !== jobToken) throw new AuthError(401, 'invalid job token');
  if (t.direction !== direction) throw new AuthError(400, 'wrong direction');
  if (t.status === 'done' || t.status === 'failed') throw new AuthError(409, 'transfer already finished');
  return t;
}

export function storeUploadChunk(jobId: string, jobToken: string, index: number, buffer: Buffer) {
  const t = authTransfer(jobId, jobToken, 'upload');
  if (t.status === 'queued') db.prepare("UPDATE transfers SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), t.id);
  const expected = Math.floor(t.bytes_done / t.chunk_size);
  if (index < expected) return { skipped: true, bytesDone: t.bytes_done, resumeIndex: expected };
  if (index > expected) return { gap: true, bytesDone: t.bytes_done, resumeIndex: expected };
  if (!t.sha256) throw new AuthError(500, 'transfer missing sha256');
  const p = ensureContentDirs(t.sha256);
  const fd = fs.openSync(p, 'a');
  fs.writeSync(fd, buffer, 0, buffer.length);
  fs.closeSync(fd);
  const bytesDone = index * t.chunk_size + buffer.length;
  db.prepare('UPDATE transfers SET bytes_done = ?, updated_at = ? WHERE id = ?').run(bytesDone, Date.now(), t.id);
  return { ok: true, index, bytesDone, totalBytes: t.total_bytes };
}

export function fetchDownloadChunk(jobId: string, jobToken: string, index: number): { buffer: Buffer; start: number; end: number; total: number; index: number } {
  const t = authTransfer(jobId, jobToken, 'download');
  if (!t.sha256) throw new AuthError(500, 'transfer missing sha256');
  const start = index * t.chunk_size;
  if (start >= t.total_bytes) throw new AuthError(416, 'past end of file');
  const end = Math.min(start + t.chunk_size, t.total_bytes);
  const p = contentPath(t.sha256);
  let fd: fs.promises.FileHandle | number;
  try {
    fd = fs.openSync(p, 'r');
  } catch {
    throw new AuthError(500, 'content missing');
  }
  const buf = Buffer.alloc(end - start);
  fs.readSync(fd, buf, 0, buf.length, start);
  fs.closeSync(fd);
  const done = Math.max(t.bytes_done, end);
  db.prepare("UPDATE transfers SET status = 'running', bytes_done = ?, updated_at = ? WHERE id = ?").run(done, Date.now(), t.id);
  return { buffer: buf, start, end, total: t.total_bytes, index };
}

export function completeUpload(jobId: string, jobToken: string) {
  const t = authTransfer(jobId, jobToken, 'upload');
  if (t.bytes_done !== t.total_bytes) {
    throw new AuthError(409, `incomplete: ${t.bytes_done}/${t.total_bytes} bytes`);
  }
  if (!t.sha256 || !t.item_id) throw new AuthError(500, 'transfer metadata missing');
  const p = contentPath(t.sha256);
  const stat = fs.statSync(p);
  if (stat.size !== t.total_bytes) {
    failTransferById(t.id, 'size mismatch on disk');
    throw new AuthError(409, 'size mismatch on disk');
  }
  if (t.total_bytes <= 128 * 1024 * 1024) {
    const hash = sha256FileSync(p);
    if (hash !== t.sha256) {
      failTransferById(t.id, 'sha256 mismatch');
      throw new AuthError(409, 'sha256 mismatch');
    }
  }
  const item = getItem(t.item_id);
  if (!item) throw new AuthError(404, 'item missing');
  const now = Date.now();
  if (config.versioning && item.sha256 && item.sha256 !== t.sha256) {
    archiveVersion(item, now);
  }
  db.prepare(
    'UPDATE items SET sha256 = ?, size = ?, mtime = ?, version = version + 1, updated_at = ? WHERE id = ?',
  ).run(t.sha256, t.total_bytes, now, now, item.id);
  indexItem(getItem(item.id)!);
  db.prepare("UPDATE transfers SET status = 'done', updated_at = ? WHERE id = ?").run(now, t.id);
  return { ok: true, itemId: t.item_id };
}

export function completeDownload(jobId: string, jobToken: string) {
  const t = authTransfer(jobId, jobToken, 'download');
  db.prepare("UPDATE transfers SET status = 'done', bytes_done = ?, updated_at = ? WHERE id = ?").run(
    t.total_bytes,
    Date.now(),
    t.id,
  );
  return { ok: true };
}

export function failTransfer(jobId: string, jobToken: string, error: string) {
  const t = getTransferByJob(jobId);
  if (!t || t.job_token !== jobToken) throw new AuthError(401, 'invalid job token');
  failTransferById(t.id, error);
  return { ok: true };
}

export function failTransferById(id: number, error: string) {
  db.prepare("UPDATE transfers SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(
    error,
    Date.now(),
    id,
  );
}

// ---------- incremental sync (manifest diff) ----------

function serverManifest(user: UserRow): Map<string, { itemId: number; sha256: string | null; size: number; mtime: number | null; kind: string }> {
  const map = new Map<string, { itemId: number; sha256: string | null; size: number; mtime: number | null; kind: string }>();
  const root = ensureVaultRoot(user.id);
  const walk = (parentId: number, prefix: string) => {
    const rows = db.prepare('SELECT * FROM items WHERE parent_id = ? AND deleted = 0').all(parentId) as unknown as ItemRow[];
    for (const r of rows) {
      const path = prefix ? `${prefix}/${r.name}` : r.name;
      if (r.kind === 'folder') {
        walk(r.id, path);
      } else {
        map.set(path, { itemId: r.id, sha256: r.sha256, size: r.size, mtime: r.mtime, kind: r.kind });
      }
    }
  };
  walk(root.id, '');

  const workspaces = db
    .prepare('SELECT workspace_id FROM workspace_members WHERE user_id = ?')
    .all(user.id) as { workspace_id: number }[];
  for (const { workspace_id } of workspaces) {
    const wsRoot = ensureWorkspaceRoot(workspace_id);
    const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspace_id) as { name: string };
    const walkWs = (parentId: number, prefix: string) => {
      const rows = db.prepare('SELECT * FROM items WHERE parent_id = ? AND deleted = 0').all(parentId) as unknown as ItemRow[];
      for (const r of rows) {
        const path = prefix ? `${prefix}/${r.name}` : r.name;
        if (r.kind === 'folder') walkWs(r.id, path);
        else map.set(`<${ws.name}>/${path}`, { itemId: r.id, sha256: r.sha256, size: r.size, mtime: r.mtime, kind: r.kind });
      }
    };
    walkWs(wsRoot.id, '');
  }
  return map;
}

function baselineFor(deviceId: number, itemId: number) {
  return db
    .prepare('SELECT * FROM device_sync_state WHERE device_id = ? AND item_id = ?')
    .get(deviceId, itemId) as { sha256: string | null; mtime: number | null; deleted: number } | undefined;
}

export function diffManifest(user: UserRow, deviceId: number, deviceManifest: ManifestEntry[]) {
  const server = serverManifest(user);
  const device = new Map<string, ManifestEntry>();
  for (const e of deviceManifest) device.set(e.path, e);

  const toUpload: ManifestEntry[] = [];
  const toDownload: { itemId: number; path: string; sha256: string | null; size: number; mtime: number | null; kind: string }[] = [];

  for (const [path, de] of device) {
    const s = server.get(path);
    if (!s) {
      if (!de.deleted) toUpload.push(de);
      continue;
    }
    const same = de.sha256 === s.sha256 && de.size === s.size;
    if (same) {
      db.prepare(
        'INSERT OR REPLACE INTO device_sync_state (device_id, item_id, sha256, mtime, deleted) VALUES (?,?,?,?,0)',
      ).run(deviceId, s.itemId, s.sha256, s.mtime);
      continue;
    }
    const base = baselineFor(deviceId, s.itemId);
    const deviceChanged = base ? base.sha256 !== de.sha256 || (base.mtime ?? 0) !== (de.mtime ?? 0) : true;
    const serverChanged = base ? base.sha256 !== s.sha256 : true;
    if (base && deviceChanged && serverChanged) {
      toUpload.push({ ...de, conflictOf: path });
    } else if (deviceChanged && !serverChanged) {
      toUpload.push(de);
    } else {
      toDownload.push({ itemId: s.itemId, path, sha256: s.sha256, size: s.size, mtime: s.mtime, kind: s.kind });
    }
  }

  for (const [path, s] of server) {
    if (!device.has(path)) {
      toDownload.push({ itemId: s.itemId, path, sha256: s.sha256, size: s.size, mtime: s.mtime, kind: s.kind });
    }
  }

  return { toUpload, toDownload };
}

export function ackSynced(deviceId: number, entries: { itemId: number; sha256: string | null; mtime: number | null; deleted: boolean }[]) {
  const now = Date.now();
  const stmt = db.prepare(
    'INSERT OR REPLACE INTO device_sync_state (device_id, item_id, sha256, mtime, deleted) VALUES (?,?,?,?,?)',
  );
  for (const e of entries) stmt.run(deviceId, e.itemId, e.sha256, e.mtime, e.deleted ? 1 : 0);
  return { ok: true, syncedAt: now };
}

// ---------- fault tolerance ----------

export function requeueOrphanedJobs(now = Date.now()) {
  const cutoff = now - config.heartbeatIntervalMs * config.nodeTimeoutMultiplier;
  const offline = db.prepare("SELECT id FROM nodes WHERE status = 'offline' AND last_seen < ?").all(cutoff) as {
    id: number;
  }[];
  for (const n of offline) {
    const jobs = db
      .prepare("SELECT * FROM transfers WHERE node_id = ? AND status IN ('queued','running') AND direction = 'upload'")
      .all(n.id) as unknown as TransferRow[];
    for (const j of jobs) {
      if (j.reassign_count >= config.maxReassignments) {
        failTransferById(j.id, 'node offline; max reassignments');
        continue;
      }
      db.prepare(
        "UPDATE transfers SET status = 'queued', node_id = 0, node_name = 'server', reassign_count = reassign_count + 1, updated_at = ? WHERE id = ?",
      ).run(now, j.id);
    }
  }
}

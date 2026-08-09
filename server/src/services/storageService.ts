import fs from 'node:fs';
import { db } from '../db/database';
import { config } from '../config';
import type { ItemRow, UserRow } from '../types';
import { AuthError } from './authService';
import { canAccessItem, requireWorkspaceAccess } from './sharingService';
import { contentPath, ensureContentDirs } from '../lib/paths';
import { isPrivateItem, requirePrivateAccess } from './privateAccess';

export function getItem(id: number): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemRow | undefined;
}

/** True if this item (or any of its ancestors) lives under a private root. */
export function itemIsPrivate(itemId: number): boolean {
  let cur = getItem(itemId);
  let guard = 0;
  while (cur && guard < 100) {
    if (cur.private === 1) return true;
    cur = cur.parent_id ? getItem(cur.parent_id) : undefined;
    guard++;
  }
  return false;
}

export function ensureVaultRoot(userId: number): ItemRow {
  const existing = db
    .prepare("SELECT * FROM items WHERE owner_id = ? AND workspace_id IS NULL AND parent_id IS NULL AND kind = 'folder' AND private = 0")
    .get(userId) as unknown as ItemRow | undefined;
  if (existing) return existing;
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO items (owner_id, workspace_id, parent_id, name, kind, created_at, updated_at)
       VALUES (?,NULL,NULL,'My Vault','folder',?,?)`,
    )
    .run(userId, now, now);
  return getItem(Number(info.lastInsertRowid))!;
}

export function ensureWorkspaceRoot(workspaceId: number): ItemRow {
  const existing = db
    .prepare('SELECT * FROM items WHERE workspace_id = ? AND parent_id IS NULL AND kind = ?')
    .get(workspaceId, 'folder') as unknown as ItemRow | undefined;
  if (existing) return existing;
  const ws = db.prepare('SELECT name FROM workspaces WHERE id = ?').get(workspaceId) as { name: string } | undefined;
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO items (owner_id, workspace_id, parent_id, name, kind, created_at, updated_at)
       VALUES (NULL,?,NULL,?,'folder',?,?)`,
    )
    .run(workspaceId, ws?.name ?? 'Workspace', now, now);
  return getItem(Number(info.lastInsertRowid))!;
}

export function createFolder(user: UserRow, name: string, parentId: number | null, workspaceId?: number): ItemRow {
  const parent = parentId ? getItem(parentId) : undefined;
  if (parentId && !parent) throw new AuthError(404, 'parent not found');
  if (!name || name.includes('/') || name.includes('\\') || name === '..') throw new AuthError(400, 'invalid name');

  const scopeWs = workspaceId ?? parent?.workspace_id ?? null;
  let actualParent: number | null = parentId;
  if (scopeWs) {
    requireWorkspaceAccess(scopeWs, user, 'editor');
    actualParent = parentId ?? ensureWorkspaceRoot(scopeWs).id;
  } else {
    const vault = ensureVaultRoot(user.id);
    actualParent = parentId ?? vault.id;
    if (parent && parent.owner_id !== user.id) throw new AuthError(403, 'forbidden');
  }
  const privateFlag = isPrivateItem(parent) ? 1 : 0;
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO items (owner_id, workspace_id, parent_id, name, kind, private, created_at, updated_at)
       VALUES (?,?,?,?,'folder',?,?,?)`,
    )
    .run(user.id, scopeWs ?? null, actualParent, name, privateFlag, now, now);
  return getItem(Number(info.lastInsertRowid))!;
}

export function listChildren(user: UserRow, parentId: number | null, workspaceId?: number, unlockToken?: string | null): ItemRow[] {
  if (workspaceId) {
    requireWorkspaceAccess(workspaceId, user, 'viewer');
    const root = ensureWorkspaceRoot(workspaceId);
    return db.prepare('SELECT * FROM items WHERE parent_id = ? AND deleted = 0 ORDER BY kind DESC, name ASC').all(root.id) as unknown as ItemRow[];
  }
  if (!parentId) {
    ensureVaultRoot(user.id);
    return db
      .prepare(
        'SELECT * FROM items WHERE owner_id = ? AND workspace_id IS NULL AND parent_id IS NULL AND deleted = 0 AND private = 0 ORDER BY kind DESC, name ASC',
      )
      .all(user.id) as unknown as ItemRow[];
  }
  const parent = getItem(parentId);
  if (!parent) throw new AuthError(404, 'folder not found');
  if (!canAccessItem(parent, user, 'viewer')) throw new AuthError(403, 'forbidden');
  requirePrivateAccess(user, parent, unlockToken);
  return db.prepare('SELECT * FROM items WHERE parent_id = ? AND deleted = 0 ORDER BY kind DESC, name ASC').all(parentId) as unknown as ItemRow[];
}

export function buildItemPath(itemId: number): string {
  const parts: string[] = [];
  let cur = getItem(itemId);
  let guard = 0;
  while (cur && cur.parent_id && guard < 100) {
    parts.unshift(cur.name);
    cur = getItem(cur.parent_id);
    guard++;
  }
  if (cur) parts.unshift(cur.name);
  return parts.join('/');
}

export function listVersions(user: UserRow, itemId: number) {
  const item = getItem(itemId);
  if (!item || !canAccessItem(item, user, 'viewer')) throw new AuthError(404, 'file not found');
  return db
    .prepare('SELECT id, version, sha256, size, created_at FROM file_versions WHERE item_id = ? ORDER BY version DESC')
    .all(itemId);
}

export function restoreVersion(user: UserRow, itemId: number, version: number) {
  const item = getItem(itemId);
  if (!item || !canAccessItem(item, user, 'editor')) throw new AuthError(403, 'forbidden');
  const v = db.prepare('SELECT * FROM file_versions WHERE item_id = ? AND version = ?').get(itemId, version) as
    | { sha256: string; size: number; created_at: number }
    | undefined;
  if (!v) throw new AuthError(404, 'version not found');
  const now = Date.now();
  // archive current, then set current to the restored version
  if (config.versioning && item.sha256 && item.sha256 !== v.sha256) {
    archiveVersion(item, now);
  }
  db.prepare('UPDATE items SET sha256 = ?, size = ?, mtime = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
    v.sha256,
    v.size,
    now,
    now,
    itemId,
  );
}

export function archiveVersion(item: ItemRow, now = Date.now()) {
  if (!item.sha256) return;
  db.prepare('INSERT INTO file_versions (item_id, version, sha256, size, created_at) VALUES (?,?,?,?,?)').run(
    item.id,
    item.version,
    item.sha256,
    item.size,
    now,
  );
  const keep = config.keepVersions;
  db.prepare(
    `DELETE FROM file_versions WHERE item_id = ? AND id IN (
       SELECT id FROM file_versions WHERE item_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?
     )`,
  ).run(item.id, item.id, keep);
}

export function softDelete(user: UserRow, itemId: number) {
  const item = getItem(itemId);
  if (!item || !canAccessItem(item, user, 'editor')) throw new AuthError(403, 'forbidden');
  const now = Date.now();
  db.prepare('UPDATE items SET deleted = 1, updated_at = ? WHERE id = ?').run(now, itemId);
  db.prepare('UPDATE items SET deleted = 1, updated_at = ? WHERE parent_id = ? AND deleted = 0').run(now, itemId);
  db.prepare('DELETE FROM search_index WHERE item_id = ?').run(itemId);
}

export function getContentBuffer(item: ItemRow): Buffer {
  if (!item.sha256) throw new AuthError(400, 'not a file');
  return fs.readFileSync(contentPath(item.sha256));
}

export function itemBytesOnDisk(sha256: string): number {
  try {
    return fs.statSync(contentPath(sha256)).size;
  } catch {
    return -1;
  }
}

export function uploadContentBuffer(item: ItemRow, buf: Buffer) {
  ensureContentDirs(item.sha256!);
  fs.writeFileSync(contentPath(item.sha256!), buf);
}

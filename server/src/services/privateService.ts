import { db } from '../db/database';
import type { UserRow, ItemRow } from '../types';
import { AuthError } from './authService';
import { getItem, ensureVaultRoot } from './storageService';
import { isPrivateItem, itemIsPrivate, isUnlocked, requirePrivateAccess } from './privateAccess';
import {
  generateDek,
  wrapDek,
  unwrapDek,
  encryptPrivateBlob,
  decryptPrivateBlob,
  hashPassword,
  verifyPassword,
  signPrivateUnlock,
} from '../lib/crypto';

export interface PrivateFolderRow {
  id: number;
  user_id: number;
  root_item_id: number | null;
  enc_key: string;
  password_hash: string | null;
  created_at: number;
  updated_at: number;
}

export const PRIVATE_FOLDER_NAME = 'Private';

function getPrivateRow(userId: number): PrivateFolderRow | undefined {
  return db.prepare('SELECT * FROM private_folders WHERE user_id = ?').get(userId) as unknown as PrivateFolderRow | undefined;
}

/**
 * Every user has exactly one private folder, rooted at an items row named
 * 'Private'. It is encrypted per-user. Creating it is lazy and idempotent.
 */
export function ensurePrivateRoot(userId: number): ItemRow {
  const row = getPrivateRow(userId);
  if (row?.root_item_id) {
    const existing = getItem(row.root_item_id);
    if (existing) return existing;
  }
  const now = Date.now();
  const vault = ensureVaultRoot(userId);
  // Look for an existing private root item (in case a previous run crashed mid-way).
  const found = db
    .prepare("SELECT * FROM items WHERE owner_id = ? AND workspace_id IS NULL AND parent_id = ? AND name = ? AND kind = 'folder' AND deleted = 0")
    .get(userId, vault.id, PRIVATE_FOLDER_NAME) as unknown as ItemRow | undefined;
  if (found) {
    if (!row) {
      db.prepare('INSERT INTO private_folders (user_id, root_item_id, enc_key, created_at, updated_at) VALUES (?,?,?,?,?)').run(
        userId,
        found.id,
        wrapDek(generateDek()),
        now,
        now,
      );
    }
    return found;
  }

  const info = db
    .prepare(
      `INSERT INTO items (owner_id, workspace_id, parent_id, name, kind, private, created_at, updated_at)
       VALUES (?,NULL,?,?,'folder',1,?,?)`,
    )
    .run(userId, vault.id, PRIVATE_FOLDER_NAME, now, now);
  const root = getItem(Number(info.lastInsertRowid))!;
  if (row) {
    db.prepare('UPDATE private_folders SET root_item_id = ?, updated_at = ? WHERE user_id = ?').run(root.id, now, userId);
  } else {
    db.prepare('INSERT INTO private_folders (user_id, root_item_id, enc_key, created_at, updated_at) VALUES (?,?,?,?,?)').run(
      userId,
      root.id,
      wrapDek(generateDek()),
      now,
      now,
    );
  }
  return root;
}

export function getPrivateRoot(user: UserRow): ItemRow {
  return ensurePrivateRoot(user.id);
}

export function getDek(userId: number): Buffer {
  const row = getPrivateRow(userId);
  if (!row) throw new AuthError(404, 'private folder not set up');
  return unwrapDek(row.enc_key);
}

// Re-exported for convenience; canonical implementations live in privateAccess.
export { isPrivateItem, itemIsPrivate, isUnlocked, requirePrivateAccess };

// ---------- password management ----------

export interface PrivateStatus {
  id: number;
  name: string;
  hasPassword: boolean;
  canUnlock: boolean;
  encrypted: boolean;
}

export function privateStatus(user: UserRow): PrivateStatus {
  const root = getPrivateRoot(user);
  const row = getPrivateRow(user.id);
  return {
    id: root.id,
    name: root.name,
    hasPassword: !!row?.password_hash,
    canUnlock: user.role === 'admin' || root.owner_id === user.id,
    encrypted: true,
  };
}

/** Set or change the private folder password. Empty password clears it. */
export function setPrivatePassword(user: UserRow, currentPassword: string | undefined, newPassword: string) {
  const row = getPrivateRow(user.id) ?? (ensurePrivateRoot(user.id), getPrivateRow(user.id));
  if (!row) throw new AuthError(500, 'private folder unavailable');

  if (row.password_hash) {
    const ok = currentPassword != null && verifyPassword(currentPassword, row.password_hash);
    if (user.role !== 'admin' && !ok) throw new AuthError(403, 'current password is incorrect');
  }
  if (newPassword && newPassword.length < 6) throw new AuthError(400, 'password must be at least 6 characters');

  const now = Date.now();
  db.prepare('UPDATE private_folders SET password_hash = ?, updated_at = ? WHERE user_id = ?').run(
    newPassword ? hashPassword(newPassword) : null,
    now,
    user.id,
  );
}

/** Admin: reset a user's private folder password without knowing the current one. */
export function adminResetPrivatePassword(admin: UserRow, targetUserId: number, newPassword: string | null) {
  if (admin.role !== 'admin') throw new AuthError(403, 'admin only');
  const row = getPrivateRow(targetUserId) ?? (ensurePrivateRoot(targetUserId), getPrivateRow(targetUserId));
  if (!row) throw new AuthError(404, 'user has no private folder');
  if (newPassword && newPassword.length < 6) throw new AuthError(400, 'password must be at least 6 characters');
  const now = Date.now();
  db.prepare('UPDATE private_folders SET password_hash = ?, updated_at = ? WHERE user_id = ?').run(
    newPassword ? hashPassword(newPassword) : null,
    now,
    targetUserId,
  );
}

/** Unlock the private folder with its password. Returns a short-lived token. */
export function unlockPrivateFolder(user: UserRow, password: string): string {
  const row = getPrivateRow(user.id);
  if (!row?.password_hash) throw new AuthError(400, 'private folder has no password set');
  if (!verifyPassword(password, row.password_hash)) throw new AuthError(403, 'wrong password');
  return signPrivateUnlock(user.id);
}

// ---------- content encryption helpers ----------

export function encryptPrivateContent(userId: number, plain: Buffer): string {
  return encryptPrivateBlob(getDek(userId), plain);
}

export function decryptPrivateContent(userId: number, stored: string): Buffer {
  return decryptPrivateBlob(getDek(userId), stored);
}

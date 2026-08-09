import { db } from '../db/database';
import type { UserRow, ItemRow } from '../types';
import { AuthError } from './authService';
import { verifyPrivateUnlock } from '../lib/crypto';

export function isPrivateItem(item: ItemRow | undefined): boolean {
  return !!item && item.private === 1;
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

function getItem(id: number): ItemRow | undefined {
  return db.prepare('SELECT * FROM items WHERE id = ?').get(id) as unknown as ItemRow | undefined;
}

function getPrivateRow(userId: number): { password_hash: string | null } | undefined {
  return db.prepare('SELECT password_hash FROM private_folders WHERE user_id = ?').get(userId) as
    | { password_hash: string | null }
    | undefined;
}

/** Verify an unlock token (if present) for the given user. */
export function isUnlocked(userId: number, unlockToken: string | undefined | null): boolean {
  if (!unlockToken) return false;
  const payload = verifyPrivateUnlock(unlockToken);
  return !!payload && payload.uid === userId;
}

/** Access helper: admin bypasses; otherwise needs ownership + (if password set) unlock token. */
export function requirePrivateAccess(user: UserRow, item: ItemRow, unlockToken: string | undefined | null) {
  if (!isPrivateItem(item)) return;
  if (user.role === 'admin') return;
  if (item.owner_id !== user.id) throw new AuthError(403, 'forbidden');
  const row = getPrivateRow(user.id);
  if (row?.password_hash && !isUnlocked(user.id, unlockToken)) {
    throw new AuthError(423, 'private folder is locked; unlock required');
  }
}

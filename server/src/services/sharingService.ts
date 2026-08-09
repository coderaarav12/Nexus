import { db } from '../db/database';
import type { UserRow, WorkspaceRow, ItemRow } from '../types';
import { AuthError } from './authService';

export type Role = 'owner' | 'editor' | 'viewer';

export function createWorkspace(user: UserRow, name: string, kind: string): WorkspaceRow {
  const now = Date.now();
  const info = db
    .prepare('INSERT INTO workspaces (name, kind, owner_id, created_at) VALUES (?,?,?,?)')
    .run(name, kind, user.id, now);
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(Number(info.lastInsertRowid)) as unknown as WorkspaceRow;
  db.prepare('INSERT OR IGNORE INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)').run(
    ws.id,
    user.id,
    'owner',
  );
  return ws;
}

export function listWorkspacesForUser(userId: number): (WorkspaceRow & { role: string })[] {
  return db
    .prepare(
      `SELECT w.*, m.role FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.user_id = ? ORDER BY w.created_at ASC`,
    )
    .all(userId) as unknown as (WorkspaceRow & { role: string })[];
}

export function getWorkspace(workspaceId: number): WorkspaceRow | undefined {
  return db.prepare('SELECT * FROM workspaces WHERE id = ?').get(workspaceId) as unknown as WorkspaceRow | undefined;
}

export function getUserRole(workspaceId: number, userId: number): Role | null {
  const row = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(
    workspaceId,
    userId,
  ) as { role: Role } | undefined;
  return row?.role ?? null;
}

export function requireWorkspaceAccess(workspaceId: number, user: UserRow, minRole: Role): { ws: WorkspaceRow; role: Role } {
  const ws = getWorkspace(workspaceId);
  if (!ws) throw new AuthError(404, 'workspace not found');
  if (user.role === 'admin') return { ws, role: 'owner' };
  const role = getUserRole(workspaceId, user.id);
  if (!role) throw new AuthError(403, 'not a member of this workspace');
  const order: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
  if (order[role] < order[minRole]) throw new AuthError(403, 'insufficient permission');
  return { ws, role };
}

export function addMember(user: UserRow, workspaceId: number, targetUserId: number, role: Role) {
  requireWorkspaceAccess(workspaceId, user, 'owner');
  if (!db.prepare('SELECT id FROM users WHERE id = ?').get(targetUserId)) throw new AuthError(404, 'user not found');
  db.prepare('INSERT OR REPLACE INTO workspace_members (workspace_id, user_id, role) VALUES (?,?,?)').run(
    workspaceId,
    targetUserId,
    role,
  );
}

export function removeMember(user: UserRow, workspaceId: number, targetUserId: number) {
  const { role } = requireWorkspaceAccess(workspaceId, user, 'owner');
  if (targetUserId === (user.id)) throw new AuthError(400, 'cannot remove the owner');
  if (role !== 'owner') throw new AuthError(403, 'insufficient permission');
  db.prepare('DELETE FROM workspace_members WHERE workspace_id = ? AND user_id = ?').run(workspaceId, targetUserId);
}

export function listMembers(user: UserRow, workspaceId: number): { user_id: number; username: string; role: string }[] {
  requireWorkspaceAccess(workspaceId, user, 'viewer');
  return db
    .prepare(
      `SELECT m.user_id, u.username, m.role FROM workspace_members m
       JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ?`,
    )
    .all(workspaceId) as { user_id: number; username: string; role: string }[];
}

export function findUsersByUsername(query: string, limit = 10) {
  return db
    .prepare('SELECT id, username, display_name FROM users WHERE username LIKE ? ORDER BY username ASC LIMIT ?')
    .all(`${query.toLowerCase()}%`, limit);
}

export function deleteWorkspace(user: UserRow, workspaceId: number) {
  const { ws } = requireWorkspaceAccess(workspaceId, user, 'owner');
  db.prepare('DELETE FROM workspaces WHERE id = ?').run(ws.id);
}

// ---------- scope resolution for items ----------

export interface ItemScope {
  workspaceId: number | null;
  userId: number | null;
}

export function itemScope(item: ItemRow): ItemScope {
  if (item.workspace_id) return { workspaceId: item.workspace_id, userId: null };
  return { workspaceId: null, userId: item.owner_id };
}

export function canAccessItem(item: ItemRow, user: UserRow, minRole: Role = 'viewer'): boolean {
  if (user.role === 'admin') return true;
  if (item.workspace_id) {
    const role = getUserRole(item.workspace_id, user.id);
    if (!role) return false;
    const order: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
    return order[role] >= order[minRole];
  }
  return item.owner_id === user.id;
}

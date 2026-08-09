import { randomUUID } from 'node:crypto';
import { db } from '../db/database';
import { config } from '../config';
import {
  hashPassword,
  verifyPassword,
  hashToken,
  randomToken,
  signAccessToken,
  signLoginGrant,
  verifyLoginGrant,
  verifyTotp,
  encryptSecret,
  decryptSecret,
  generateTotpSecret,
  generateBackupCodes,
  otpauthUrl,
} from '../lib/crypto';
import type { UserRow, DeviceRow } from '../types';

export class AuthError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// ---------- users ----------

export function findUserByUsername(username: string): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username.toLowerCase()) as unknown as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id) as unknown as UserRow | undefined;
}

export function countUsers(): number {
  const row = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  return Number(row.c);
}

export function createUser(username: string, password: string, displayName?: string): UserRow {
  const lower = username.toLowerCase();
  if (findUserByUsername(lower)) throw new AuthError(409, 'username already taken');
  if (password.length < 6) throw new AuthError(400, 'password must be at least 6 characters');
  const now = Date.now();
  const isFirst = countUsers() === 0;
  const info = db
    .prepare(
      `INSERT INTO users (username, password_hash, display_name, role, created_at, updated_at)
       VALUES (?,?,?,?,?,?)`,
    )
    .run(lower, hashPassword(password), displayName ?? null, isFirst ? 'admin' : 'user', now, now);
  const user = findUserById(Number(info.lastInsertRowid))!;
  logSecurity(user.id, undefined, 'user_registered', true);
  return user;
}

export function authenticatePassword(username: string, password: string): UserRow {
  const user = findUserByUsername(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    if (user) logSecurity(user.id, undefined, 'login_failed', false);
    throw new AuthError(401, 'invalid credentials');
  }
  return user;
}

// ---------- 2FA ----------

export function setupTotp(userId: number): { secret: string; otpauthUrl: string; backupCodes: string[] } {
  const user = findUserById(userId);
  if (!user) throw new AuthError(404, 'user not found');
  const secret = generateTotpSecret();
  const backupCodes = generateBackupCodes();
  const hashedCodes = backupCodes.map((c) => hashToken(c));
  db.prepare('UPDATE users SET totp_secret = ?, backup_codes = ?, updated_at = ? WHERE id = ?').run(
    encryptSecret(secret),
    JSON.stringify(hashedCodes),
    Date.now(),
    userId,
  );
  return { secret, otpauthUrl: otpauthUrl(user.username, secret), backupCodes };
}

export function enableTotp(userId: number, code: string) {
  const user = findUserById(userId);
  if (!user) throw new AuthError(404, 'user not found');
  if (!user.totp_secret) throw new AuthError(400, 'run 2FA setup first');
  const secret = decryptSecret(user.totp_secret);
  if (!verifyTotp(secret, code)) throw new AuthError(400, 'invalid code');
  db.prepare('UPDATE users SET totp_enabled = 1, updated_at = ? WHERE id = ?').run(Date.now(), userId);
  logSecurity(userId, undefined, 'totp_enabled', true);
}

export function disableTotp(userId: number, code: string) {
  const user = findUserById(userId);
  if (!user) throw new AuthError(404, 'user not found');
  if (!user.totp_secret) throw new AuthError(400, '2FA not configured');
  const secret = decryptSecret(user.totp_secret);
  if (!verifyTotp(secret, code)) throw new AuthError(400, 'invalid code');
  db.prepare('UPDATE users SET totp_enabled = 0, updated_at = ? WHERE id = ?').run(Date.now(), userId);
  logSecurity(userId, undefined, 'totp_disabled', true);
}

export function verifyBackupCode(user: UserRow, code: string): boolean {
  if (!user.backup_codes) return false;
  const codes = JSON.parse(user.backup_codes) as string[];
  const idx = codes.findIndex((c) => hashToken(code) === c);
  if (idx < 0) return false;
  codes.splice(idx, 1);
  db.prepare('UPDATE users SET backup_codes = ?, updated_at = ? WHERE id = ?').run(
    JSON.stringify(codes),
    Date.now(),
    user.id,
  );
  return true;
}

// ---------- login flow ----------

export function startLogin(username: string, password: string, ip?: string, userAgent?: string) {
  const user = authenticatePassword(username, password);
  if (user.totp_enabled) {
    const { token, jti } = signLoginGrant(user.id);
    db.prepare('INSERT OR REPLACE INTO login_grants (jti, user_id, created_at, used) VALUES (?,?,?,0)').run(
      jti,
      user.id,
      Date.now(),
    );
    logSecurity(user.id, undefined, 'mfa_challenge', true, ip, userAgent);
    return { mfaRequired: true, grantToken: token };
  }
  const { token, jti } = signLoginGrant(user.id);
  db.prepare('INSERT OR REPLACE INTO login_grants (jti, user_id, created_at, used) VALUES (?,?,?,0)').run(
    jti,
    user.id,
    Date.now(),
  );
  logSecurity(user.id, undefined, 'login', true, ip, userAgent);
  return { mfaRequired: false, grantToken: token };
}

export function completeMfa(grantToken: string, code: string, ip?: string, userAgent?: string) {
  const grant = verifyLoginGrant(grantToken);
  if (!grant) throw new AuthError(401, 'invalid or expired login token');
  const used = db.prepare('SELECT used FROM login_grants WHERE jti = ?').get(grant.jti) as
    | { used: number }
    | undefined;
  if (!used || used.used) throw new AuthError(401, 'login token already used');
  const user = findUserById(grant.uid);
  if (!user) throw new AuthError(401, 'user not found');
  let ok = false;
  if (user.totp_secret) {
    ok = verifyTotp(decryptSecret(user.totp_secret), code);
    if (!ok) ok = verifyBackupCode(user, code);
  }
  if (!ok) {
    logSecurity(user.id, undefined, 'mfa_failed', false, ip, userAgent);
    throw new AuthError(401, 'invalid 2FA code');
  }
  db.prepare('UPDATE login_grants SET used = 1 WHERE jti = ?').run(grant.jti);
  logSecurity(user.id, undefined, 'mfa_verified', true, ip, userAgent);
  const { token, jti } = signLoginGrant(user.id);
  db.prepare('INSERT OR REPLACE INTO login_grants (jti, user_id, created_at, used) VALUES (?,?,?,0)').run(
    jti,
    user.id,
    Date.now(),
  );
  return token;
}

export function registerDevice(grantToken: string, name: string, platform?: string, osVersion?: string, ip?: string, userAgent?: string) {
  const grant = verifyLoginGrant(grantToken);
  if (!grant) throw new AuthError(401, 'invalid or expired login token');
  const used = db.prepare('SELECT used FROM login_grants WHERE jti = ?').get(grant.jti) as
    | { used: number }
    | undefined;
  if (!used || used.used) throw new AuthError(401, 'login token already used');
  db.prepare('UPDATE login_grants SET used = 1 WHERE jti = ?').run(grant.jti);
  const now = Date.now();
  const info = db
    .prepare(
      `INSERT INTO user_devices (user_id, name, platform, os_version, last_active, last_ip, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    )
    .run(grant.uid, name || 'Untitled device', platform ?? null, osVersion ?? null, now, ip ?? null, now);
  const deviceId = Number(info.lastInsertRowid);
  const refresh = issueRefreshToken(grant.uid, deviceId);
  const access = signAccessToken(grant.uid, findUserById(grant.uid)!.role, deviceId);
  logSecurity(grant.uid, deviceId, 'device_registered', true, ip, userAgent);
  return { deviceId, accessToken: access, refreshToken: refresh };
}

// ---------- tokens ----------

export function issueRefreshToken(userId: number, deviceId: number): string {
  const token = randomToken(48);
  const familyId = randomUUID();
  const expiresAt = Date.now() + config.refreshTokenDays * 86400000;
  db.prepare(
    `INSERT INTO refresh_tokens (user_id, device_id, token_hash, family_id, expires_at, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(userId, deviceId, hashToken(token), familyId, expiresAt, Date.now());
  return token;
}

export function rotateRefreshToken(refreshToken: string, ip?: string, userAgent?: string) {
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(hashToken(refreshToken)) as
    | (Record<string, any> & { user_id: number; device_id: number; family_id: string; revoked_at: number | null; expires_at: number })
    | undefined;
  if (!row) throw new AuthError(401, 'invalid refresh token');
  const device = db.prepare('SELECT * FROM user_devices WHERE id = ?').get(row.device_id) as unknown as DeviceRow | undefined;
  if (!device || device.revoked_at) throw new AuthError(401, 'device revoked');
  if (row.revoked_at || row.expires_at < Date.now()) throw new AuthError(401, 'refresh token expired or revoked');

  // reuse of an already-rotated token in the same family -> possible theft
  const sibling = db
    .prepare('SELECT * FROM refresh_tokens WHERE family_id = ? AND id != ? AND revoked_at IS NULL')
    .get(row.family_id, row.id);
  if (sibling) {
    db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ?').run(Date.now(), row.family_id);
    db.prepare("UPDATE user_devices SET trust_status = 'revoked' WHERE id = ?").run(row.device_id);
    logSecurity(row.user_id, row.device_id, 'token_theft_revoked', false, ip, userAgent);
    throw new AuthError(401, 'suspicious token reuse detected');
  }

  db.prepare('UPDATE refresh_tokens SET revoked_at = ?, last_used = ? WHERE id = ?').run(
    Date.now(),
    Date.now(),
    row.id,
  );
  const newToken = randomToken(48);
  db.prepare(
    `INSERT INTO refresh_tokens (user_id, device_id, token_hash, family_id, expires_at, created_at)
     VALUES (?,?,?,?,?,?)`,
  ).run(row.user_id, row.device_id, hashToken(newToken), row.family_id, Date.now() + config.refreshTokenDays * 86400000, Date.now());
  db.prepare('UPDATE user_devices SET last_active = ?, last_ip = ? WHERE id = ?').run(Date.now(), ip ?? null, row.device_id);
  const user = findUserById(row.user_id);
  const access = signAccessToken(row.user_id, user?.role ?? 'user', row.device_id);
  logSecurity(row.user_id, row.device_id, 'token_refresh', true, ip, userAgent);
  return { accessToken: access, refreshToken: newToken };
}

export function revokeRefreshToken(refreshToken: string) {
  const row = db.prepare('SELECT id FROM refresh_tokens WHERE token_hash = ?').get(hashToken(refreshToken));
  if (row) db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(Date.now(), (row as any).id);
}

export function revokeDevice(userId: number, deviceId: number) {
  const device = db.prepare('SELECT * FROM user_devices WHERE id = ? AND user_id = ?').get(deviceId, userId) as
    | DeviceRow
    | undefined;
  if (!device) throw new AuthError(404, 'device not found');
  db.prepare("UPDATE user_devices SET trust_status = 'revoked', revoked_at = ? WHERE id = ?").run(Date.now(), deviceId);
  db.prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL').run(
    Date.now(),
    deviceId,
  );
  logSecurity(userId, deviceId, 'device_revoked', true);
}

export function listDevices(userId: number): DeviceRow[] {
  return db.prepare('SELECT * FROM user_devices WHERE user_id = ? ORDER BY created_at DESC').all(userId) as unknown as DeviceRow[];
}

export function renameDevice(userId: number, deviceId: number, name: string) {
  db.prepare('UPDATE user_devices SET name = ? WHERE id = ? AND user_id = ?').run(name, deviceId, userId);
  logSecurity(userId, deviceId, 'device_renamed', true);
}

// ---------- security log ----------

export function logSecurity(userId: number | undefined, deviceId: number | undefined, event: string, success: boolean, ip?: string, userAgent?: string) {
  db.prepare(
    'INSERT INTO security_logs (user_id, device_id, event, ip, user_agent, success, ts) VALUES (?,?,?,?,?,?,?)',
  ).run(userId ?? null, deviceId ?? null, event, ip ?? null, userAgent ?? null, success ? 1 : 0, Date.now());
}

export function listSecurityLogs(userId: number, limit = 100) {
  return db
    .prepare(
      `SELECT s.*, d.name AS device_name FROM security_logs s
       LEFT JOIN user_devices d ON d.id = s.device_id
       WHERE s.user_id = ? ORDER BY s.ts DESC LIMIT ?`,
    )
    .all(userId, limit);
}

export function createNotification(userId: number, level: string, message: string) {
  db.prepare('INSERT INTO notifications (user_id, level, message, created_at) VALUES (?,?,?,?)').run(
    userId,
    level,
    message,
    Date.now(),
  );
}

export function listNotifications(userId: number, limit = 50) {
  return db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(userId, limit);
}

export function markNotificationsRead(userId: number) {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(userId);
}

export function changePassword(userId: number, oldPassword: string, newPassword: string) {
  const user = findUserById(userId);
  if (!user) throw new AuthError(404, 'user not found');
  if (!verifyPassword(oldPassword, user.password_hash)) throw new AuthError(401, 'invalid current password');
  if (newPassword.length < 6) throw new AuthError(400, 'password must be at least 6 characters');
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
    hashPassword(newPassword),
    Date.now(),
    userId,
  );
  logSecurity(userId, undefined, 'password_changed', true);
}

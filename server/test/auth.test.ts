import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initDb } from '../src/db/database';
import {
  createUser,
  authenticatePassword,
  startLogin,
  completeMfa,
  registerDevice,
  setupTotp,
  enableTotp,
  rotateRefreshToken,
  revokeDevice,
  revokeRefreshToken,
  listDevices,
  AuthError,
} from '../src/services/authService';
import { db } from '../src/db/database';
import { computeTotp } from '../src/lib/crypto';

initDb();

function register(username: string, password = 'correct-horse') {
  const user = authenticatePassword(username, password);
  const { grantToken } = startLogin(username, password);
  const dev = registerDevice(grantToken, 'test-device', 'android', '14');
  return { user, ...dev };
}

test('first user becomes admin', () => {
  const u = createUser('alice', 'password123', 'Alice');
  assert.equal(u.role, 'admin');
});

test('password auth rejects wrong password', () => {
  createUser('bob', 'password123');
  assert.throws(() => authenticatePassword('bob', 'wrong'), (e: AuthError) => e.status === 401);
});

test('duplicate username rejected', () => {
  createUser('carol', 'password123');
  assert.throws(() => createUser('carol', 'otherpass'), (e: AuthError) => e.status === 409);
});

test('device registration + refresh token rotation', () => {
  createUser('dave', 'password123');
  const { user, deviceId, refreshToken } = register('dave', 'password123');
  const devices = listDevices(user.id);
  assert.ok(devices.some((d) => d.id === deviceId));

  const rotated = rotateRefreshToken(refreshToken);
  assert.ok(rotated.accessToken);
  assert.notEqual(rotated.refreshToken, refreshToken);

  // old token is now dead
  assert.throws(() => rotateRefreshToken(refreshToken), (e: AuthError) => e.status === 401);
});

test('token reuse across family revokes device', () => {
  createUser('erin', 'password123');
  const { user, deviceId, refreshToken } = register('erin', 'password123');
  const row = db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').get(createHash('sha256').update(refreshToken).digest('hex')) as { id: number; family_id: string; user_id: number; device_id: number; expires_at: number };
  // forge a second un-revoked token in the same family (the "stolen" copy)
  db.prepare(
    'INSERT INTO refresh_tokens (user_id, device_id, token_hash, family_id, expires_at, created_at) VALUES (?,?,?,?,?,?)',
  ).run(row.user_id, row.device_id, 'forged-hash', row.family_id, row.expires_at, Date.now());

  assert.throws(() => rotateRefreshToken(refreshToken), (e: AuthError) => e.status === 401);
  const dev = db.prepare('SELECT trust_status FROM user_devices WHERE id = ?').get(deviceId) as { trust_status: string };
  assert.equal(dev.trust_status, 'revoked');
});

test('revoking device kills its refresh tokens', () => {
  createUser('frank', 'password123');
  const { user, deviceId, refreshToken } = register('frank', 'password123');
  revokeDevice(user.id, deviceId);
  assert.throws(() => rotateRefreshToken(refreshToken), (e: AuthError) => e.status === 401);
});

test('logout revokes just the presented token', () => {
  createUser('gina', 'password123');
  const { user, refreshToken } = register('gina', 'password123');
  revokeRefreshToken(refreshToken);
  assert.throws(() => rotateRefreshToken(refreshToken), (e: AuthError) => e.status === 401);
  assert.ok(listDevices(user.id).length >= 1);
});

test('2FA flow: setup, enable, mfa login', () => {
  createUser('heidi', 'password123');
  const user = authenticatePassword('heidi', 'password123');
  const { secret } = setupTotp(user.id);

  // wrong code rejected
  assert.throws(() => enableTotp(user.id, '000000'), (e: AuthError) => e.status === 400);

  const code = computeTotp(secret);
  enableTotp(user.id, code);

  // login now requires MFA
  const challenge = startLogin('heidi', 'password123');
  assert.equal(challenge.mfaRequired, true);

  const mfaCode = computeTotp(secret);
  const grant = completeMfa(challenge.grantToken, mfaCode);
  const dev = registerDevice(grant, 'totp-device', 'web', '1.0');
  assert.ok(dev.accessToken);
});

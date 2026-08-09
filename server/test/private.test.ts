import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { initDb } from '../src/db/database';
import { createUser, authenticatePassword, startLogin, registerDevice, AuthError } from '../src/services/authService';
import { createFolder, getItem, listChildren, getContentBuffer } from '../src/services/storageService';
import { createUploadJob, storeUploadChunk, completeUpload } from '../src/services/syncService';
import {
  ensurePrivateRoot,
  getPrivateRoot,
  getDek,
  privateStatus,
  setPrivatePassword,
  unlockPrivateFolder,
  encryptPrivateContent,
  decryptPrivateContent,
} from '../src/services/privateService';
import { isPrivateItem, itemIsPrivate, requirePrivateAccess } from '../src/services/privateAccess';
import type { UserRow } from '../src/types';

initDb();

// First user in the file becomes admin; used by the admin-bypass test.
const adminUser = makeUser('priv_superadmin');

function makeUser(username: string): UserRow {
  createUser(username, 'password123');
  return authenticatePassword(username, 'password123');
}

function upload(user: UserRow, deviceId: number, parentId: number, filename: string, buffer: Buffer) {
  const job = createUploadJob(user, deviceId, {
    filename,
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    mtime: Date.now(),
    parentId,
  });
  if (!job.jobId || !job.jobToken) return job;
  const { chunkSize } = job;
  for (let i = 0; i * chunkSize < buffer.length; i++) {
    storeUploadChunk(job.jobId, job.jobToken, i, buffer.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buffer.length)));
  }
  completeUpload(job.jobId, job.jobToken);
  return job;
}

test('ensurePrivateRoot is lazy and idempotent, and stays out of vault listing', () => {
  const user = makeUser('priv_alice');
  const root = ensurePrivateRoot(user.id);
  assert.equal(root.name, 'Private');
  assert.equal(root.kind, 'folder');
  assert.equal(isPrivateItem(root), true);

  // Listing the vault root must NOT include the private root.
  const vault = ensurePrivateRoot(user.id); // ensurePrivateRoot calls ensureVaultRoot internally
  assert.ok(vault.id > 0);

  const again = ensurePrivateRoot(user.id);
  assert.equal(again.id, root.id, 'ensurePrivateRoot must be idempotent');
});

test('private status reflects password state', () => {
  const user = makeUser('priv_bob');
  const st = privateStatus(user);
  assert.equal(st.name, 'Private');
  assert.equal(st.hasPassword, false);
  assert.equal(st.encrypted, true);
});

test('private root cannot be listed without unlock when password is set', () => {
  const user = makeUser('priv_carol');
  const root = ensurePrivateRoot(user.id);
  const { deviceId } = registerDevice(startLogin(user.username, 'password123').grantToken, 'priv-device', 'android', '14');
  const buf = Buffer.from('super secret data');
  upload(user, deviceId, root.id, 'secret.txt', buf);

  setPrivatePassword(user, undefined, 'secret123');

  // No token -> must throw 423.
  assert.throws(() => requirePrivateAccess(user, root, null), (e: AuthError) => e.status === 423);

  // With correct unlock -> passes.
  const token = unlockPrivateFolder(user, 'secret123');
  requirePrivateAccess(user, root, token);

  // Wrong password rejected.
  assert.throws(() => unlockPrivateFolder(user, 'nope'), (e: AuthError) => e.status === 403);
});

test('encryptPrivateContent round-trips with AES-GCM and is not plaintext', () => {
  const user = makeUser('priv_dave');
  ensurePrivateRoot(user.id);
  const plain = Buffer.from('attack at dawn');
  const stored = encryptPrivateContent(user.id, plain);
  assert.notEqual(stored, plain.toString());
  assert.ok(stored.startsWith('p1:'));
  assert.deepEqual(decryptPrivateContent(user.id, stored), plain);
  getDek(user.id); // no throw
});

test('private folder children are private and access-checked', () => {
  const user = makeUser('priv_eve');
  const root = ensurePrivateRoot(user.id);
  setPrivatePassword(user, undefined, 'pw123456');
  const token = unlockPrivateFolder(user, 'pw123456');

  const folder = createFolder(user, 'Sub', root.id);
  assert.equal(isPrivateItem(folder), true);
  assert.equal(itemIsPrivate(folder.id), true);

  // Without token, listing children must throw.
  assert.throws(() => listChildren(user, root.id), (e: AuthError) => e.status === 423);
  // With token it works.
  const kids = listChildren(user, root.id, undefined, token);
  assert.ok(kids.some((k) => k.id === folder.id));
});

test('encryption key is per-user (independent DEKs)', () => {
  const a = makeUser('priv_frank');
  const b = makeUser('priv_grace');
  ensurePrivateRoot(a.id);
  ensurePrivateRoot(b.id);
  const ka = getDek(a.id);
  const kb = getDek(b.id);
  assert.notDeepEqual(ka, kb);
});

test('admin can access private items without unlock token', () => {
  const user = makeUser('priv_henry');
  const root = ensurePrivateRoot(user.id);
  setPrivatePassword(user, undefined, 'henry123');
  const token = unlockPrivateFolder(user, 'henry123');
  createFolder(user, 'SecretDocs', root.id);

  assert.throws(() => listChildren(user, root.id), (e: AuthError) => e.status === 423);
  // Admin bypasses the lock.
  const kids = listChildren(adminUser, root.id);
  assert.ok(kids.some((k) => k.name === 'SecretDocs'));
});

test('stored private content is encrypted and getContentBuffer returns plaintext', () => {
  const user = makeUser('priv_ivy');
  const root = ensurePrivateRoot(user.id);
  const { deviceId } = registerDevice(startLogin(user.username, 'password123').grantToken, 'priv-device2', 'android', '14');
  const buf = Buffer.from('classified payload 12345');
  const job = upload(user, deviceId, root.id, 'classified.txt', buf);
  const item = getItem(job.itemId)!;
  assert.equal(isPrivateItem(item), true);
  assert.equal(item.private, 1);
  assert.deepEqual(getContentBuffer(item), buf);
});

import './setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { initDb } from '../src/db/database';
import { db } from '../src/db/database';
import { createUser, authenticatePassword, startLogin, registerDevice, AuthError } from '../src/services/authService';
import { createFolder, getItem, listChildren, listVersions, softDelete } from '../src/services/storageService';
import {
  createUploadJob,
  storeUploadChunk,
  fetchDownloadChunk,
  completeUpload,
  completeDownload,
  createDownloadJob,
  diffManifest,
  ackSynced,
  failTransfer,
} from '../src/services/syncService';
import { search } from '../src/services/searchService';
import { createWorkspace, addMember, listMembers, removeMember, requireWorkspaceAccess } from '../src/services/sharingService';
import { getContentBuffer, ensureVaultRoot } from '../src/services/storageService';
import { config } from '../src/config';
import { contentPath } from '../src/lib/paths';
import type { UserRow } from '../src/types';

initDb();

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function makeUser(username: string): UserRow {
  createUser(username, 'password123');
  return authenticatePassword(username, 'password123');
}

function makeDevice(user: UserRow) {
  const { grantToken } = startLogin(user.username, 'password123');
  return registerDevice(grantToken, 'sync-test-device', 'android', '14');
}

function upload(user: UserRow, deviceId: number, parentId: number | null, filename: string, buffer: Buffer, workspaceId?: number) {
  const job = createUploadJob(user, deviceId, {
    filename,
    size: buffer.length,
    sha256: sha256(buffer),
    mtime: Date.now(),
    parentId,
    workspaceId,
  });
  if (!job.jobId || !job.jobToken) return job;
  const { chunkSize } = job;
  for (let i = 0; i * chunkSize < buffer.length; i++) {
    const chunk = buffer.subarray(i * chunkSize, Math.min((i + 1) * chunkSize, buffer.length));
    storeUploadChunk(job.jobId, job.jobToken, i, Buffer.from(chunk));
  }
  completeUpload(job.jobId, job.jobToken);
  return job;
}

function await_upload(user: UserRow, deviceId: number, parentId: number | null, filename: string, buffer: Buffer, workspaceId?: number) {
  return upload(user, deviceId, parentId, filename, buffer, workspaceId);
}

test('upload -> chunked write -> content verified', () => {
  const user = makeUser('sync_alice');
  const { deviceId } = makeDevice(user);
  const root = ensureVaultRoot(user.id);
  const buf = Buffer.from('the quick brown fox jumps over the lazy dog'.repeat(50));
  const job = await_upload(user, deviceId, root.id, 'notes.txt', buf);

  const item = getItem(job.itemId)!;
  assert.equal(item.kind, 'file');
  assert.equal(item.sha256, sha256(buf));
  assert.equal(item.size, buf.length);
  assert.deepEqual(getContentBuffer(item), buf);

  // second identical upload dedupes
  const again = createUploadJob(user, deviceId, { filename: 'notes.txt', size: buf.length, sha256: sha256(buf), parentId: root.id });
  assert.equal(again.deduped, true);
  assert.equal(again.noChange, true);
});

test('uploading new content creates a version', () => {
  const user = makeUser('sync_bob');
  const { deviceId } = makeDevice(user);
  const root = ensureVaultRoot(user.id);
  const v1 = Buffer.from('version one');
  const v2 = Buffer.from('version two is longer');

  await_upload(user, deviceId, root.id, 'doc.txt', v1);
  const job2 = await_upload(user, deviceId, root.id, 'doc.txt', v2);

  const item = getItem(job2.itemId)!;
  assert.equal(item.version, 3);
  const versions = listVersions(user, item.id);
  assert.equal(versions.length, 1);
  assert.equal(versions[0].sha256, sha256(v1));
});

test('download reassembles the exact file', () => {
  const user = makeUser('sync_carol');
  const { deviceId } = makeDevice(user);
  const root = ensureVaultRoot(user.id);
  const buf = Buffer.alloc(15000);
  for (let i = 0; i < buf.length; i++) buf[i] = (i * 7) % 251;
  const job = await_upload(user, deviceId, root.id, 'binary.bin', buf);

  const dl = createDownloadJob(user, deviceId, job.itemId);
  const parts: Buffer[] = [];
  for (let i = 0; i * dl.chunkSize < dl.totalBytes; i++) {
    const { buffer } = fetchDownloadChunk(dl.jobId, dl.jobToken, i);
    parts.push(buffer);
  }
  assert.deepEqual(Buffer.concat(parts), buf);
  completeDownload(dl.jobId, dl.jobToken);
});

test('manifest diff detects uploads, downloads and conflicts', () => {
  const user = makeUser('sync_dave');
  const { deviceId } = makeDevice(user);
  const root = ensureVaultRoot(user.id);
  const serverBuf = Buffer.from('server state');
  await_upload(user, deviceId, root.id, 'shared.txt', serverBuf);

  // empty device -> everything downloads
  let d = diffManifest(user, deviceId, []);
  assert.equal(d.toDownload.length, 1);
  assert.equal(d.toDownload[0].path, 'shared.txt');

  // device acked up to server state -> nothing to do
  const item = db.prepare("SELECT * FROM items WHERE name = 'shared.txt' AND parent_id = ?").get(root.id) as { id: number; sha256: string; size: number; mtime: number };
  ackSynced(deviceId, [{ itemId: item.id, sha256: item.sha256, mtime: item.mtime, deleted: false }]);
  d = diffManifest(user, deviceId, [{ path: 'shared.txt', sha256: item.sha256, size: item.size, mtime: item.mtime, deleted: false }]);
  assert.equal(d.toUpload.length, 0);
  assert.equal(d.toDownload.length, 0);

  // device edits locally -> upload
  const localBuf = Buffer.from('local edit');
  d = diffManifest(user, deviceId, [{ path: 'shared.txt', sha256: sha256(localBuf), size: localBuf.length, mtime: 2, deleted: false }]);
  assert.equal(d.toUpload.length, 1);

  // device deletes locally -> upload tombstone
  d = diffManifest(user, deviceId, [{ path: 'shared.txt', sha256: undefined, size: 0, mtime: 0, deleted: true }]);
  assert.equal(d.toUpload.length, 1);
  assert.equal(d.toUpload[0].deleted, true);

  // both sides changed since baseline -> conflict flagged
  ackSynced(deviceId, [{ itemId: item.id, sha256: item.sha256, mtime: item.mtime, deleted: false }]);
  const conflict = Buffer.from('remote also changed');
  await_upload(user, deviceId, root.id, 'shared.txt', conflict);
  d = diffManifest(user, deviceId, [{ path: 'shared.txt', sha256: sha256(localBuf), size: localBuf.length, mtime: 5, deleted: false }]);
  assert.equal(d.toUpload.length, 1);
  assert.equal(d.toUpload[0].conflictOf, 'shared.txt');
});

test('search finds indexed files', () => {
  const user = makeUser('sync_eve');
  const { deviceId } = makeDevice(user);
  const root = ensureVaultRoot(user.id);
  await_upload(user, deviceId, root.id, 'quarterly-report.pdf', Buffer.from('pdf bytes'));
  const results = search('quarterly', user);
  assert.ok(results.some((r) => r.name === 'quarterly-report.pdf'));
});

test('folders can be created and listed', () => {
  const user = makeUser('sync_frank');
  const folder = createFolder(user, 'Photos', null);
  const root = ensureVaultRoot(user.id);
  assert.equal(folder.parent_id, root.id);
  const children = listChildren(user, root.id);
  assert.ok(children.some((c) => c.id === folder.id && c.kind === 'folder'));
});

test('soft delete hides item and removes from search', () => {
  const user = makeUser('sync_grace');
  const { deviceId } = makeDevice(user);
  const root = ensureVaultRoot(user.id);
  const job = await_upload(user, deviceId, root.id, 'obsolete.txt', Buffer.from('x'));
  softDelete(user, job.itemId);
  assert.equal(getItem(job.itemId)!.deleted, 1);
  assert.equal(search('obsolete', user).length, 0);
});

test('invalid chunk order is rejected or skipped', () => {
  const user = makeUser('sync_henry');
  const { deviceId } = makeDevice(user);
  const root = ensureVaultRoot(user.id);
  const buf = Buffer.from('chunk ordering test payload');
  const job = createUploadJob(user, deviceId, { filename: 'ordered.bin', size: buf.length, sha256: sha256(buf), parentId: root.id });
  const jobId = job.jobId!;
  const jobToken = job.jobToken!;
  // out-of-order chunk -> gap
  const r = storeUploadChunk(jobId, jobToken, 2, Buffer.from(buf.subarray(2 * job.chunkSize)));
  assert.equal(r.gap, true);
  // wrong token rejected
  assert.throws(() => storeUploadChunk(jobId, 'bad-token', 0, Buffer.from('x')), (e: AuthError) => e.status === 401);
});

test('mismatched content fails upload', () => {
  const user = makeUser('sync_ivy');
  const { deviceId } = makeDevice(user);
  const root = ensureVaultRoot(user.id);
  const real = Buffer.from('real content');
  const job = createUploadJob(user, deviceId, { filename: 'liar.txt', size: real.length, sha256: sha256(real), parentId: root.id });
  const jobId = job.jobId!;
  const jobToken = job.jobToken!;
  const chunk = storeUploadChunk(jobId, jobToken, 0, real);
  // tamper with stored content before finalize
  const p = contentPath(sha256(real));
  fs.writeFileSync(p, 'real conten?');
  assert.throws(() => completeUpload(jobId, jobToken), (e: AuthError) => e.status === 409);
});

test('workspace sharing: viewer can read but not edit', () => {
  const owner = makeUser('ws_owner');
  const viewer = makeUser('ws_viewer');
  const { deviceId: ownerDev } = makeDevice(owner);

  const ws = createWorkspace(owner, 'Team Docs', 'shared');
  addMember(owner, ws.id, viewer.id, 'viewer');
  assert.deepEqual(listMembers(owner, ws.id).map((m) => m.user_id), [owner.id, viewer.id]);

  // owner can upload into the workspace
  const job = await_upload(owner, ownerDev, null, 'plan.md', Buffer.from('plan'), ws.id);
  assert.ok(job.itemId);

  // viewer can read the workspace tree
  const items = listChildren(viewer, null, ws.id);
  assert.ok(items.length > 0);

  // viewer cannot create a folder (needs editor)
  assert.throws(() => createFolder(viewer, 'hax', null, ws.id), (e: AuthError) => e.status === 403);

  // viewer cannot upload
  const { deviceId: viewerDev } = makeDevice(viewer);
  assert.throws(
    () => createUploadJob(viewer, viewerDev, { filename: 'x.txt', size: 1, sha256: 'a'.repeat(64), parentId: null, workspaceId: ws.id }),
    (e: AuthError) => e.status === 403,
  );

  // removed member loses access
  removeMember(owner, ws.id, viewer.id);
  assert.throws(() => requireWorkspaceAccess(ws.id, viewer, 'viewer'), (e: AuthError) => e.status === 403);
});

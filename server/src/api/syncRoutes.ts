import { Router } from 'express';
import { requireAuth, authContext } from '../middleware/auth';
import {
  createUploadJob,
  createDownloadJob,
  reassignTransfer,
  storeUploadChunk,
  fetchDownloadChunk,
  completeUpload,
  completeDownload,
  failTransfer,
  diffManifest,
  ackSynced,
  getTransferByJob,
} from '../services/syncService';
import { AuthError } from '../services/authService';
import type { ManifestEntry } from '../types';

export const syncRouter = Router();

const jobToken = (req: any) => (req.headers['x-job-token'] as string) ?? req.body?.jobToken;

function authJob(req: any) {
  const job = getTransferByJob(req.params.jobId);
  const token = jobToken(req);
  if (!job || job.job_token !== token) throw new AuthError(401, 'invalid job token');
  return job;
}

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

syncRouter.post(
  '/upload',
  requireAuth,
  handle((req, res) => {
    const { user, deviceId } = authContext(req);
    if (!deviceId) return res.status(400).json({ error: 'device token required' });
    const out = createUploadJob(user, deviceId, req.body ?? {}, req.ip);
    res.status(201).json(out);
  }),
);

syncRouter.post(
  '/download',
  requireAuth,
  handle((req, res) => {
    const { user, deviceId } = authContext(req);
    if (!deviceId) return res.status(400).json({ error: 'device token required' });
    const out = createDownloadJob(user, deviceId, Number(req.body?.itemId), req.ip);
    res.status(201).json(out);
  }),
);

syncRouter.post(
  '/jobs/:jobId/reassign',
  requireAuth,
  handle((req, res) => {
    const { user } = authContext(req);
    const out = reassignTransfer(user.id, req.params.jobId, req.ip);
    res.json(out);
  }),
);

syncRouter.post(
  '/jobs/:jobId/chunks/:index',
  handle((req, res) => {
    const job = authJob(req);
    if (job.direction !== 'upload') return res.status(400).json({ error: 'not an upload job' });
    const buffer = req.body;
    if (!Buffer.isBuffer(buffer)) return res.status(400).json({ error: 'expected octet-stream body' });
    const result = storeUploadChunk(job.job_id, job.job_token, Number(req.params.index), buffer);
    res.json({ index: Number(req.params.index), ...result });
  }),
);

syncRouter.get(
  '/jobs/:jobId/chunks/:index',
  handle((req, res) => {
    const job = authJob(req);
    if (job.direction !== 'download') return res.status(400).json({ error: 'not a download job' });
    const { buffer, start, end, total } = fetchDownloadChunk(job.job_id, job.job_token, Number(req.params.index));
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Chunk-Start', String(start));
    res.set('X-Chunk-End', String(end));
    res.set('X-Total-Bytes', String(total));
    res.send(buffer);
  }),
);

syncRouter.post(
  '/jobs/:jobId/complete',
  handle((req, res) => {
    const job = authJob(req);
    const out = job.direction === 'upload' ? completeUpload(job.job_id, job.job_token) : completeDownload(job.job_id, job.job_token);
    res.json(out);
  }),
);

syncRouter.post(
  '/jobs/:jobId/fail',
  handle((req, res) => {
    const job = authJob(req);
    failTransfer(job.job_id, job.job_token, req.body?.error ?? 'failed');
    res.json({ ok: true });
  }),
);

syncRouter.post(
  '/manifest',
  requireAuth,
  handle((req, res) => {
    const { user, deviceId } = authContext(req);
    if (!deviceId) return res.status(400).json({ error: 'device token required' });
    const manifest = Array.isArray(req.body?.manifest) ? (req.body.manifest as unknown as ManifestEntry[]) : [];
    const diff = diffManifest(user, deviceId, manifest);
    res.json(diff);
  }),
);

syncRouter.post(
  '/ack',
  requireAuth,
  handle((req, res) => {
    const { deviceId } = authContext(req);
    if (!deviceId) return res.status(400).json({ error: 'device token required' });
    const entries = Array.isArray(req.body?.entries) ? req.body.entries : [];
    res.json(ackSynced(deviceId, entries));
  }),
);

import { Router } from 'express';
import { registerNode } from '../services/gatewayService';
import { db } from '../db/database';
import { config } from '../config';
import { requireAgent, type AuthRequest } from '../middleware/auth';
import {
  computeNodeScore,
  historicalBonus,
  recordScoreSample,
  countActiveTransfers,
  pickBestGateway,
} from '../services/gatewayService';
import {
  storeUploadChunk,
  fetchDownloadChunk,
  completeUpload,
  completeDownload,
  failTransfer,
  getTransferByJob,
} from '../services/syncService';

export const gatewayRouter = Router();

gatewayRouter.post('/register', (req: AuthRequest, res: any) => {
  const { name, model, osVersion } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { nodeId, token } = registerNode(name, model, osVersion);
  res.status(201).json({ node_id: nodeId, token });
});

gatewayRouter.post('/heartbeat', requireAgent, (req: AuthRequest, res: any) => {
  const node = req.node;
  const {
    cpu,
    ramTotal,
    ramAvailable,
    battery,
    charging,
    temp,
    storageFree,
    activeTransfers,
    lanIp,
    lanPort,
    bytesSentSinceLast,
    bytesRecvSinceLast,
    sentAt,
  } = req.body ?? {};

  const now = Date.now();
  const intervalMs = Math.max(now - (node.last_seen || now), 1);
  let netSpeed = 0;
  if (typeof bytesSentSinceLast === 'number' && typeof bytesRecvSinceLast === 'number' && node.last_seen > 0) {
    netSpeed = (bytesSentSinceLast + bytesRecvSinceLast) / (intervalMs / 1000);
  }
  const latency = typeof sentAt === 'number' ? Math.max(0, now - sentAt) : null;

  db.prepare(
    `INSERT INTO node_metrics (node_id, ts, cpu, ram_total, ram_available, battery, charging, temp, net_speed, latency, storage_free, active_transfers)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    node.id,
    now,
    cpu ?? null,
    ramTotal ?? null,
    ramAvailable ?? null,
    battery ?? null,
    charging ? 1 : 0,
    temp ?? null,
    netSpeed,
    latency,
    storageFree ?? null,
    activeTransfers ?? null,
  );

  db.prepare('UPDATE nodes SET last_seen = ?, status = ?, lan_ip = ?, lan_port = ? WHERE id = ?').run(
    now,
    'online',
    lanIp ?? node.lan_ip,
    lanPort ?? node.lan_port,
    node.id,
  );

  const active = activeTransfers ?? countActiveTransfers(node.id);
  const score = computeNodeScore(
    { cpu, ram_total: ramTotal, ram_available: ramAvailable, battery, charging, temp, net_speed: netSpeed, latency, storage_free: storageFree, active_transfers: active },
    active,
    historicalBonus(node.id, now),
  );
  recordScoreSample(node.id, score, now);

  const jobs = db
    .prepare(
      "SELECT job_id, direction, total_bytes, bytes_done, chunk_size, item_id, sha256, job_token, node_id, node_name FROM transfers WHERE node_id = ? AND status = 'queued' ORDER BY created_at ASC",
    )
    .all(node.id) as any[];

  res.json({ now, score, jobs });
});

gatewayRouter.post('/jobs/:jobId/claim', requireAgent, (req: AuthRequest, res: any) => {
  const job = getTransferByJob(req.params.jobId);
  if (!job || job.node_id !== req.node.id) return res.status(404).json({ error: 'job not assigned to this node' });
  if (job.status !== 'queued') return res.json({ job, status: job.status });
  db.prepare("UPDATE transfers SET status = 'running', updated_at = ? WHERE id = ?").run(Date.now(), job.id);
  res.json({ job: { ...job, status: 'running' } });
});

function jobTokenOk(job: any, token: string | undefined): boolean {
  return !!job && job.job_token === token;
}

gatewayRouter.post('/jobs/:jobId/chunks/:index', requireAgent, (req: AuthRequest, res: any) => {
  const job = getTransferByJob(req.params.jobId);
  if (!job || job.node_id !== req.node.id) return res.status(404).json({ error: 'job not assigned' });
  if (job.direction !== 'upload') return res.status(400).json({ error: 'not an upload job' });
  if (!jobTokenOk(job, req.headers['x-job-token'] as string)) return res.status(401).json({ error: 'invalid job token' });
  const index = Number(req.params.index);
  const buffer = req.body;
  if (!Buffer.isBuffer(buffer)) return res.status(400).json({ error: 'expected binary body' });
  try {
    const result = storeUploadChunk(job.job_id, job.job_token, index, buffer);
    res.json({ index, ...result });
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

gatewayRouter.get('/jobs/:jobId/chunks/:index', requireAgent, (req: AuthRequest, res: any) => {
  const job = getTransferByJob(req.params.jobId);
  if (!job || job.node_id !== req.node.id) return res.status(404).json({ error: 'job not assigned' });
  if (job.direction !== 'download') return res.status(400).json({ error: 'not a download job' });
  if (!jobTokenOk(job, req.headers['x-job-token'] as string)) return res.status(401).json({ error: 'invalid job token' });
  try {
    const { buffer, start, end, total } = fetchDownloadChunk(job.job_id, job.job_token, Number(req.params.index));
    res.set('Content-Type', 'application/octet-stream');
    res.set('X-Chunk-Start', String(start));
    res.set('X-Chunk-End', String(end));
    res.set('X-Total-Bytes', String(total));
    res.send(buffer);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

gatewayRouter.post('/jobs/:jobId/complete', requireAgent, (req: AuthRequest, res: any) => {
  const job = getTransferByJob(req.params.jobId);
  if (!job || job.node_id !== req.node.id) return res.status(404).json({ error: 'job not assigned' });
  if (!jobTokenOk(job, req.headers['x-job-token'] as string)) return res.status(401).json({ error: 'invalid job token' });
  try {
    const out = job.direction === 'upload' ? completeUpload(job.job_id, job.job_token) : completeDownload(job.job_id, job.job_token);
    res.json(out);
  } catch (err: any) {
    res.status(err.status ?? 500).json({ error: err.message });
  }
});

gatewayRouter.post('/jobs/:jobId/fail', requireAgent, (req: AuthRequest, res: any) => {
  const job = getTransferByJob(req.params.jobId);
  if (!job || job.node_id !== req.node.id) return res.status(404).json({ error: 'job not assigned' });
  if (!jobTokenOk(job, req.headers['x-job-token'] as string)) return res.status(401).json({ error: 'invalid job token' });
  failTransfer(job.job_id, job.job_token, req.body?.error ?? 'failed');
  res.json({ ok: true });
});

gatewayRouter.get('/route-preview', requireAgent, (_req, res) => {
  const best = pickBestGateway();
  res.json({ currentBest: best });
});

export { config };

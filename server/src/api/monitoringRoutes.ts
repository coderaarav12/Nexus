import { Router } from 'express';
import { exec } from 'node:child_process';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { dashboardSummary, listUsers, storageUsage, runServerBackup } from '../services/monitoringService';
import { db } from '../db/database';
import { config } from '../config';
import { AuthError } from '../services/authService';

export const monitoringRouter = Router();

monitoringRouter.use(requireAuth);

monitoringRouter.get('/dashboard/summary', requireAdmin, (_req, res) => {
  res.json(dashboardSummary());
});

monitoringRouter.get('/admin/users', requireAdmin, (_req, res) => {
  res.json({ users: listUsers() });
});

monitoringRouter.get('/admin/storage', requireAdmin, (_req, res) => {
  res.json(storageUsage());
});

monitoringRouter.post('/admin/backup', requireAdmin, (_req, res) => {
  const out = runServerBackup();
  res.json(out);
});

monitoringRouter.post('/admin/shutdown', requireAdmin, (_req, res) => {
  // Fire-and-forget: the OS goes down moments later, so reply first.
  res.json({ ok: true, message: 'shutting down' });
  exec(config.powerOffCmd, { timeout: 10000 }, (err, _stdout, stderr) => {
    if (err) {
      console.error('[shutdown] failed:', err.message, stderr);
    }
  });
});

monitoringRouter.get('/admin/activity', requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all();
  res.json({ activity: rows });
});

monitoringRouter.get('/admin/nodes', requireAdmin, (_req, res) => {
  const nodes = db
    .prepare(
      `SELECT n.*, (SELECT COUNT(*) FROM transfers t WHERE t.node_id = n.id AND t.status IN ('queued','running')) AS active_transfers
       FROM nodes n ORDER BY n.id ASC`,
    )
    .all();
  res.json({ nodes });
});

monitoringRouter.get('/admin/config', requireAdmin, (_req, res) => {
  res.json({
    chunkSize: config.chunkSize,
    maxConcurrentTransfers: config.maxConcurrentTransfers,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    batteryMin: config.batteryMin,
    tempMaxC: config.tempMaxC,
    keepVersions: config.keepVersions,
    metricsRetentionDays: config.metricsRetentionDays,
  });
});

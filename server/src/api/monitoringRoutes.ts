import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { requireAuth, requireAdmin } from '../middleware/auth';
import { dashboardSummary, listUsers, storageUsage, runServerBackup, logActivity, minecraftStatus } from '../services/monitoringService';
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
  // Reply first so the client sees success before the OS goes down.
  res.json({ ok: true, message: 'shutting down' });
  logActivity('info', 'Shutdown requested from dashboard');
  // A root-owned systemd path unit (nexus-shutdown.path) watches this flag
  // file and powers the machine off. Writing it never needs sudo.
  try {
    fs.mkdirSync(path.dirname(config.shutdownFlagPath), { recursive: true });
    fs.writeFileSync(config.shutdownFlagPath, String(Date.now()));
  } catch (err) {
    const msg = (err as Error).message;
    console.error('[shutdown] flag write failed:', msg);
    logActivity('error', `Shutdown flag write failed: ${msg}`);
  }
});

monitoringRouter.get('/admin/activity', requireAdmin, (_req, res) => {
  const rows = db.prepare('SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100').all();
  res.json({ activity: rows });
});

monitoringRouter.get('/admin/minecraft', requireAdmin, async (_req, res) => {
  try {
    res.json({ status: await minecraftStatus() });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

monitoringRouter.post('/admin/minecraft/action', requireAdmin, (_req, res) => {
  const { action } = _req.body ?? {};
  if (action !== 'start' && action !== 'stop') throw new AuthError(400, 'action must be start or stop');
  // Control is delegated to a root-owned systemd oneshot that toggles the
  // server, mirroring the shutdown flag-file pattern (no sudo inside nexus).
  const flag = action === 'start' ? config.minecraftStartFlagPath : config.minecraftStopFlagPath;
  try {
    fs.mkdirSync(path.dirname(flag), { recursive: true });
    fs.writeFileSync(flag, String(Date.now()));
    logActivity('info', `Minecraft ${action} requested from dashboard`);
    res.json({ ok: true, action });
  } catch (err) {
    throw new AuthError(500, `failed to write ${action} flag: ${(err as Error).message}`);
  }
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

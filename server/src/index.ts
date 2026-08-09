import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config';
import { initDb, pruneMetrics, pruneHistory, pruneTransfers } from './db/database';
import { requeueOrphanedJobs } from './services/syncService';
import { updateNodeStatuses } from './services/gatewayService';
import { logActivity, runServerBackup } from './services/monitoringService';
import { authRouter } from './api/authRoutes';
import { gatewayRouter } from './api/gatewayRoutes';
import { syncRouter } from './api/syncRoutes';
import { storageRouter } from './api/storageRoutes';
import { privateRouter } from './api/privateRoutes';
import { sharingRouter } from './api/sharingRoutes';
import { searchRouter } from './api/searchRoutes';
import { monitoringRouter } from './api/monitoringRoutes';

initDb();
for (const dir of [config.storageDir, config.backupDir, config.logDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));
app.use(express.raw({ type: 'application/octet-stream', limit: config.chunkBufferLimit }));

app.get('/healthz', (_req, res) => res.json({ ok: true, name: 'nexus-server', version: '2.0' }));

app.use('/api/v1/auth', authRouter);
app.use('/api/v1/agent', gatewayRouter);
app.use('/api/v1/sync', syncRouter);
app.use('/api/v1/storage', storageRouter);
app.use('/api/v1/private', privateRouter);
app.use('/api/v1/sharing', sharingRouter);
app.use('/api/v1/search', searchRouter);
app.use('/api/v1/monitor', monitoringRouter);

const publicDir = path.resolve(config.rootDir, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

app.use((req, res) => {
  if (req.path.startsWith('/api/')) res.status(404).json({ error: 'not found' });
  else res.status(404).send('Not found');
});

// ---- background loops ----

const faultDetectorMs = 10_000;
let faultRuns = 0;
setInterval(() => {
  const affected = updateNodeStatuses();
  requeueOrphanedJobs();
  faultRuns++;
  if (affected.length && faultRuns % 6 === 1) {
    logActivity('warning', `${affected.length} gateway node(s) marked offline: ${affected.map((n) => n.name).join(', ')}`);
  }
}, faultDetectorMs);

setInterval(() => {
  pruneMetrics(config.metricsRetentionDays);
  pruneHistory(config.metricsRetentionDays);
  pruneTransfers(30);
}, 6 * 3600 * 1000);

const backupHours = Number(process.env.SERVER_BACKUP_HOURS ?? '24');
if (backupHours > 0) {
  setInterval(() => {
    try {
      runServerBackup();
    } catch (err) {
      console.error('backup failed:', err);
    }
  }, backupHours * 3600 * 1000);
}

app.listen(config.port, config.host, () => {
  console.log(`Nexus Server v2 listening on http://${config.host}:${config.port}`);
  console.log(`  db:        ${config.dbPath}`);
  console.log(`  storage:   ${config.storageDir}`);
  console.log(`  backups:   ${config.backupDir}`);
});

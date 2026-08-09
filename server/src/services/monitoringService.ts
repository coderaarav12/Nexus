import fs from 'node:fs';
import { db } from '../db/database';
import { config } from '../config';
import { serverHealth } from '../lib/system';
import {
  latestMetrics,
  countActiveTransfers,
  computeNodeScore,
  historicalBonus,
} from './gatewayService';

export function dashboardSummary() {
  const health = serverHealth(config.storageDir, config.logDir);

  const nodes = db.prepare('SELECT * FROM nodes ORDER BY id ASC').all() as any[];
  const nodesView = nodes.map((n) => {
    const m = latestMetrics(n.id);
    const active = countActiveTransfers(n.id);
    const score = m ? computeNodeScore(m, active, historicalBonus(n.id)) : null;
    const inFlight = db
      .prepare("SELECT job_id, direction, total_bytes, bytes_done, status FROM transfers WHERE node_id = ? AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1")
      .get(n.id);
    return {
      id: n.id,
      name: n.name,
      model: n.model,
      status: n.status,
      lastSeen: n.last_seen,
      lanIp: n.lan_ip,
      lanPort: n.lan_port,
      score,
      battery: m?.battery ?? null,
      charging: m?.charging ?? null,
      cpu: m?.cpu ?? null,
      temp: m?.temp ?? null,
      netSpeed: m?.net_speed ?? null,
      latency: m?.latency ?? null,
      ramAvailable: m?.ram_available ?? null,
      ramTotal: m?.ram_total ?? null,
      storageFree: m?.storage_free ?? null,
      activeTransfers: active,
      currentTransfer: inFlight ?? null,
    };
  });

  const activeTransfers = db
    .prepare(
      `SELECT t.*, n.name AS node_name, u.username FROM transfers t
       LEFT JOIN nodes n ON n.id = t.node_id
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.status IN ('queued','running') ORDER BY t.created_at DESC LIMIT 20`,
    )
    .all() as any[];

  const recentFailed = db
    .prepare(
      `SELECT t.*, n.name AS node_name, u.username FROM transfers t
       LEFT JOIN nodes n ON n.id = t.node_id
       LEFT JOIN users u ON u.id = t.user_id
       WHERE t.status = 'failed' ORDER BY t.updated_at DESC LIMIT 10`,
    )
    .all() as any[];

  const files = db.prepare('SELECT COUNT(*) AS c, COALESCE(SUM(size),0) AS s FROM items WHERE kind = ? AND deleted = 0').get('file') as { c: number; s: number };
  const users = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number };
  const devices = db.prepare('SELECT COUNT(*) AS c FROM user_devices').get() as { c: number };
  const workspaces = db.prepare('SELECT COUNT(*) AS c FROM workspaces').get() as { c: number };

  const recentActivity = db
    .prepare('SELECT id, level, message, created_at FROM notifications ORDER BY created_at DESC LIMIT 15')
    .all() as any[];

  return {
    server: { ...health, time: Date.now() },
    nodes: nodesView,
    transfers: { active: activeTransfers, recentFailed },
    files: { count: Number(files.c), totalBytes: Number(files.s) },
    counts: {
      users: Number(users.c),
      devices: Number(devices.c),
      workspaces: Number(workspaces.c),
    },
    recentActivity,
    config: {
      chunkSize: config.chunkSize,
      maxConcurrentTransfers: config.maxConcurrentTransfers,
      heartbeatIntervalMs: config.heartbeatIntervalMs,
    },
  };
}

export function listUsers() {
  return db
    .prepare('SELECT id, username, display_name, role, totp_enabled, created_at, updated_at FROM users ORDER BY id ASC')
    .all() as any[];
}

export function storageUsage() {
  const byUser = db
    .prepare(
      `SELECT owner_id, u.username, SUM(size) AS bytes, COUNT(*) AS files
       FROM items i LEFT JOIN users u ON u.id = i.owner_id
       WHERE i.kind = 'file' AND i.deleted = 0 AND i.workspace_id IS NULL
       GROUP BY owner_id`,
    )
    .all() as any[];
  const byWorkspace = db
    .prepare(
      `SELECT workspace_id, w.name, SUM(size) AS bytes, COUNT(*) AS files
       FROM items i LEFT JOIN workspaces w ON w.id = i.workspace_id
       WHERE i.kind = 'file' AND i.deleted = 0 AND i.workspace_id IS NOT NULL
       GROUP BY workspace_id`,
    )
    .all() as any[];
  return { byUser, byWorkspace };
}

export function logActivity(level: string, message: string) {
  db.prepare('INSERT INTO notifications (user_id, level, message, created_at) VALUES (NULL,?,?,?)').run(
    level,
    message,
    Date.now(),
  );
}

// ---------- server-side backup ----------

export function runServerBackup() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = `${config.backupDir}/backup-${stamp}`;
  fs.mkdirSync(dest, { recursive: true });
  const dbDest = `${dest}/nexus.db`;
  fs.copyFileSync(config.dbPath, dbDest);
  // copy content-addressed storage (only existing files, flattened with shard dirs)
  const storageDest = `${dest}/files`;
  fs.mkdirSync(storageDest, { recursive: true });
  if (fs.existsSync(config.storageDir)) {
    const copy = (dir: string, rel: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const src = `${dir}/${entry.name}`;
        const dst = `${storageDest}/${rel ? `${rel}/` : ''}${entry.name}`;
        if (entry.isDirectory()) {
          fs.mkdirSync(dst, { recursive: true });
          copy(src, rel ? `${rel}/${entry.name}` : entry.name);
        } else if (entry.isFile()) {
          fs.copyFileSync(src, dst);
        }
      }
    };
    copy(config.storageDir, '');
  }
  const size = (() => {
    let total = 0;
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(p);
        else if (entry.isFile()) total += fs.statSync(p).size;
      }
    };
    walk(dest);
    return total;
  })();
  logActivity('info', `Server backup created: backup-${stamp} (${(size / 1e6).toFixed(1)} MB)`);
  // keep last 10 backups
  const backups = fs
    .readdirSync(config.backupDir)
    .filter((d) => d.startsWith('backup-'))
    .sort()
    .reverse();
  for (const old of backups.slice(10)) {
    fs.rmSync(`${config.backupDir}/${old}`, { recursive: true, force: true });
  }
  return { backup: `backup-${stamp}`, size };
}

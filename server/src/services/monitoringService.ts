import fs from 'node:fs';
import net from 'node:net';
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

// ---------- Minecraft server integration ----------

const MC_DIR = process.env.MC_DIR ?? '/opt/minecraft';
const MC_HOST = process.env.MC_HOST ?? '127.0.0.1';
const MC_PORT = Number(process.env.MC_PORT ?? 25565);
const MC_RCON_PORT = Number(process.env.MC_RCON_PORT ?? 25575);

function rconPassword(): string | null {
  try {
    return fs.readFileSync(`${MC_DIR}/rcon-password`, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Minimal RCON (Source RCON protocol, Minecraft's rcon) client. */
function rcon(command: string, timeoutMs = 4000): Promise<string | null> {
  return new Promise((resolve) => {
    const pass = rconPassword();
    if (!pass) return resolve(null);
    const sock = net.createConnection({ host: MC_HOST, port: MC_RCON_PORT });
    let buf = Buffer.alloc(0);
    let authed = false;
    let finished = false;

    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);

    const send = (reqId: number, type: number, body: string) => {
      const bodyBuf = Buffer.from(body + '\0\0', 'utf8');
      const packet = Buffer.alloc(4 + 4 + 4 + bodyBuf.length);
      packet.writeInt32LE(4 + 4 + bodyBuf.length, 0);
      packet.writeInt32LE(reqId, 4);
      packet.writeInt32LE(type, 8);
      bodyBuf.copy(packet, 12);
      sock.write(packet);
    };

    sock.on('error', () => finish(null));
    sock.on('close', () => finish(null));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (buf.length < 4 + len) break;
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.subarray(12, 4 + len - 2).toString('utf8');
        buf = buf.subarray(4 + len);
        if (!authed) {
          if (id === -1) return finish(null); // auth failed
          authed = true;
          send(2, 2, command);
        } else {
          // id=2 response carries the command output (type may be 2 or 0).
          return finish(body);
        }
      }
    });
    sock.on('connect', () => send(1, 3, pass));
  });
}

export interface MinecraftStatus {
  online: boolean;
  host: string;
  port: number;
  players: number | null;
  maxPlayers: number | null;
  version: string | null;
}

export async function minecraftStatus(): Promise<MinecraftStatus> {
  const status: MinecraftStatus = {
    online: false,
    host: MC_HOST,
    port: MC_PORT,
    players: null,
    maxPlayers: null,
    version: null,
  };
  if (!fs.existsSync(`${MC_DIR}/server.properties`)) return status;
  try {
    const props = fs.readFileSync(`${MC_DIR}/server.properties`, 'utf8');
    const grab = (k: string) => props.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1];
    const max = Number(grab('max-players') ?? '10');
    if (Number.isFinite(max)) status.maxPlayers = max;
    status.version = grab('motd') ?? null;
  } catch {
    /* ignore */
  }

  const online = await portOpen(MC_HOST, MC_PORT);
  status.online = online;
  if (online) {
    const out = await rcon('list');
    if (out) {
      // e.g. "There are 2 of a max of 10 players online: Alice, Bob"
      const m = out.match(/There are (\d+) of a max of (\d+)/);
      if (m) {
        status.players = Number(m[1]);
        if (Number.isFinite(Number(m[2]))) status.maxPlayers = Number(m[2]);
      }
    }
  }
  return status;
}

function portOpen(host: string, port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.on('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.on('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function loadDotEnv() {
  const envPath = path.resolve(rootDir, '.env');
  try {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (process.env[k] === undefined) process.env[k] = v;
    }
  } catch {
    /* no .env file -> env vars only */
  }
}
loadDotEnv();

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const dataDir = process.env.DATA_DIR
  ? path.resolve(rootDir, process.env.DATA_DIR)
  : path.resolve(rootDir, 'data');
const systemDir = path.join(dataDir, 'system');

function loadOrCreateKey(name: string): Buffer {
  const p = path.join(systemDir, name);
  try {
    const b64 = fs.readFileSync(p, 'utf8').trim();
    const buf = Buffer.from(b64, 'base64');
    if (buf.length >= 32) return buf;
  } catch {
    /* generate below */
  }
  fs.mkdirSync(systemDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(p, key.toString('base64'), { mode: 0o600 });
  return key;
}

export const config = {
  rootDir,
  host: process.env.HOST ?? '0.0.0.0',
  port: num(process.env.PORT, 8080),
  dbPath: process.env.DB_PATH
    ? path.resolve(rootDir, process.env.DB_PATH)
    : path.join(dataDir, 'nexus.db'),
  storageDir: process.env.STORAGE_DIR
    ? path.resolve(rootDir, process.env.STORAGE_DIR)
    : path.join(dataDir, 'storage'),
  backupDir: process.env.BACKUP_DIR
    ? path.resolve(rootDir, process.env.BACKUP_DIR)
    : path.join(dataDir, 'backups'),
  logDir: process.env.LOG_DIR
    ? path.resolve(rootDir, process.env.LOG_DIR)
    : path.join(dataDir, 'logs'),
  systemDir,
  tokenSecret: process.env.TOKEN_SECRET || loadOrCreateKey('token.key').toString('base64'),
  masterKey: process.env.MASTER_KEY
    ? Buffer.from(process.env.MASTER_KEY, 'hex')
    : loadOrCreateKey('master.key'),
  heartbeatIntervalMs: num(process.env.HEARTBEAT_INTERVAL_MS, 3000),
  nodeTimeoutMultiplier: num(process.env.NODE_TIMEOUT_MULTIPLIER, 4),
  maxConcurrentTransfers: num(process.env.MAX_CONCURRENT_TRANSFERS_PER_NODE, 1),
  batteryMin: num(process.env.BATTERY_MIN, 15),
  tempMaxC: num(process.env.TEMP_MAX_C, 45),
  chunkSize: num(process.env.CHUNK_SIZE, 1024 * 1024),
  chunkBufferLimit: num(process.env.CHUNK_BUFFER_LIMIT, 2 * 1024 * 1024),
  maxReassignments: num(process.env.MAX_REASSIGNMENTS, 3),
  metricsRetentionDays: num(process.env.METRICS_RETENTION_DAYS, 7),
  accessTokenMinutes: num(process.env.ACCESS_TOKEN_MINUTES, 15),
  refreshTokenDays: num(process.env.REFRESH_TOKEN_DAYS, 90),
  keepVersions: num(process.env.KEEP_VERSIONS, 10),
  versioning: process.env.VERSIONING !== 'false',
  // Path unit approach: the server writes this flag file and a root-owned
  // systemd oneshot (nexus-shutdown) reacts by powering off. This avoids
  // needing sudo inside a NoNewPrivileges service.
  shutdownFlagPath: process.env.SHUTDOWN_FLAG ?? path.join(systemDir, 'shutdown.request'),
  minecraftStartFlagPath: path.join(systemDir, 'minecraft.start'),
  minecraftStopFlagPath: path.join(systemDir, 'minecraft.stop'),
};

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  backup_codes TEXT,
  settings TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS user_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT,
  os_version TEXT,
  last_active INTEGER,
  last_ip TEXT,
  trust_status TEXT NOT NULL DEFAULT 'trusted',
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON user_devices(user_id);

CREATE TABLE IF NOT EXISTS security_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER,
  event TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  success INTEGER NOT NULL DEFAULT 1,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sec_logs_user ON security_logs(user_id, ts);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  family_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used INTEGER
);
CREATE INDEX IF NOT EXISTS idx_refresh_family ON refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_device ON refresh_tokens(device_id);

CREATE TABLE IF NOT EXISTS login_grants (
  jti TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  used INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'shared',
  owner_id INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'viewer',
  UNIQUE(workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_ws ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_members_user ON workspace_members(user_id);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  workspace_id INTEGER REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id INTEGER,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'file',
  sha256 TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  mtime INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_ws ON items(workspace_id, parent_id);

CREATE TABLE IF NOT EXISTS file_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_by INTEGER REFERENCES users(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_item ON file_versions(item_id);

CREATE TABLE IF NOT EXISTS transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  device_id INTEGER REFERENCES user_devices(id) ON DELETE CASCADE,
  item_id INTEGER REFERENCES items(id),
  direction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  total_bytes INTEGER NOT NULL DEFAULT 0,
  bytes_done INTEGER NOT NULL DEFAULT 0,
  chunk_size INTEGER NOT NULL DEFAULT 1048576,
  node_id INTEGER NOT NULL DEFAULT 0,
  node_name TEXT,
  job_token TEXT NOT NULL,
  sha256 TEXT,
  error TEXT,
  reassign_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON transfers(status);
CREATE INDEX IF NOT EXISTS idx_transfers_node ON transfers(node_id);
CREATE INDEX IF NOT EXISTS idx_transfers_user ON transfers(user_id);

CREATE TABLE IF NOT EXISTS nodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  model TEXT,
  os_version TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'offline',
  lan_ip TEXT,
  lan_port INTEGER,
  last_seen INTEGER NOT NULL DEFAULT 0,
  first_seen INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS node_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id INTEGER NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  cpu REAL,
  ram_total INTEGER,
  ram_available INTEGER,
  battery INTEGER,
  charging INTEGER,
  temp REAL,
  net_speed REAL,
  latency INTEGER,
  storage_free INTEGER,
  active_transfers INTEGER
);
CREATE INDEX IF NOT EXISTS idx_metrics_node ON node_metrics(node_id, ts);

CREATE TABLE IF NOT EXISTS hourly_stats (
  node_id INTEGER NOT NULL,
  day INTEGER NOT NULL,
  hour_of_day INTEGER NOT NULL,
  score_sum REAL NOT NULL DEFAULT 0,
  score_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, day, hour_of_day)
);

CREATE TABLE IF NOT EXISTS device_sync_state (
  device_id INTEGER NOT NULL REFERENCES user_devices(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  sha256 TEXT,
  mtime INTEGER,
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, item_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  level TEXT NOT NULL DEFAULT 'info',
  message TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);

CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  item_id UNINDEXED,
  name,
  path,
  tokenize = 'unicode61'
);
`;

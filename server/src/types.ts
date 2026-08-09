export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  display_name: string | null;
  role: string;
  totp_secret: string | null;
  totp_enabled: number;
  backup_codes: string | null;
  settings: string | null;
  created_at: number;
  updated_at: number;
}

export interface DeviceRow {
  id: number;
  user_id: number;
  name: string;
  platform: string | null;
  os_version: string | null;
  last_active: number | null;
  last_ip: string | null;
  trust_status: string;
  created_at: number;
  revoked_at: number | null;
}

export interface WorkspaceRow {
  id: number;
  name: string;
  kind: string;
  owner_id: number | null;
  created_at: number;
}

export interface ItemRow {
  id: number;
  owner_id: number | null;
  workspace_id: number | null;
  parent_id: number | null;
  name: string;
  kind: string;
  sha256: string | null;
  size: number;
  mtime: number | null;
  version: number;
  deleted: number;
  created_at: number;
  updated_at: number;
}

export interface TransferRow {
  id: number;
  job_id: string;
  user_id: number | null;
  device_id: number | null;
  item_id: number | null;
  direction: string;
  status: string;
  total_bytes: number;
  bytes_done: number;
  chunk_size: number;
  node_id: number;
  node_name: string | null;
  job_token: string;
  sha256: string | null;
  error: string | null;
  reassign_count: number;
  created_at: number;
  updated_at: number;
}

export interface RouteInfo {
  mode: 'direct' | 'gateway';
  node?: { id: number; name: string; ip: string; port: number; score: number };
  reason: string;
}

export interface AuthContext {
  user: UserRow;
  deviceId: number | undefined;
}

export interface ManifestEntry {
  itemId?: number;
  path: string;
  sha256?: string;
  size: number;
  mtime: number;
  deleted: boolean;
  conflictOf?: string;
}

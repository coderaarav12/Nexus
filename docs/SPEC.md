# Project Nexus v2 — Coordination Spec

Self-hosted multi-user private cloud ("Project Nexus"). Central server on an old Lenovo
IdeaPad (i3 11th gen, 4GB RAM, 1TB HDD, Ubuntu Linux). Two Android phones act as
gateway/relay nodes. Windows PC mounts storage over SMB. A Samsung Tab A7 runs the web
dashboard.

## Repo layout (this repo root)

```
server/            Node 24 + TypeScript + Express + node:sqlite backend (DONE, tested)
  src/index.ts     entry point, mounts routers, fault detector, prunes, backups
  src/api/         authRoutes, gatewayRoutes, syncRoutes, storageRoutes, sharingRoutes,
                   searchRoutes, monitoringRoutes
  src/services/    authService, gatewayService, sharingService, storageService,
                   searchService, syncService, monitoringService
  src/db/          schema.ts, database.ts (WAL, FTS5 search_index)
  src/lib/         crypto.ts, paths.ts (content-addressed), system.ts
  src/middleware/  auth.ts (requireAuth/requireAdmin/requireAgent)
  src/config.ts    env config, auto-generated keys in data/system/
  test/            23 passing tests (auth, gateway, storage)
  public/          <TODO: dashboard SPA — static files served by express.static>
android/           <TODO: Kotlin Gradle projects — agent/ and backup/>
deploy/            <TODO: setup-linux.sh, nexus.service, setup-samba.sh, export tool>
windows/           <TODO: SMB mount script + sync helper>
docs/              <TODO: README material + this spec>
```

## Server facts

- Listens on `HOST:PORT` (default 0.0.0.0:8080), reads `server/.env`.
- Data under `server/data/`: `nexus.db`, `storage/` (content-addressed by sha256 shards),
  `backups/`, `logs/`, `system/` (keys).
- Auth model: HMAC-signed access token in `Authorization: Bearer <token>` (15 min),
  device-bound rotating refresh token. Login returns a single-use `grantToken`.
- Agents (phone gateways) authenticate with their node token in `Authorization: Bearer`.
- Storage: files uploaded in chunks (`CHUNK_SIZE`, default 1 MiB); server verifies size +
  sha256 on complete. Dedup by sha256. Versioning keeps `KEEP_VERSIONS` copies.

## API contract (base path `/api/v1`)

All requests `Content-Type: application/json` unless noted.

### Auth — /auth
- `POST /register` `{username, password, displayName?}` → 201 `{id, username, role}`
  (first registered user becomes admin)
- `POST /login` `{username, password}` → `{mfaRequired: bool, grantToken}` (if
  `mfaRequired`, call /mfa then /devices/register)
- `POST /mfa` `{grantToken, code}` → `{grantToken}`
- `POST /devices/register` `{grantToken, name, platform?, osVersion?}` → 201
  `{deviceId, accessToken, refreshToken}`
- `POST /refresh` `{refreshToken}` → `{accessToken, refreshToken}`
- `POST /logout` `{refreshToken}` → `{ok:true}`
- `GET /me` (auth) → `{id, username, displayName, role, totpEnabled, settings}`
- `GET /devices` → `{devices}`
- `POST /devices/:id/rename` `{name}`, `POST /devices/:id/revoke` → `{ok:true}`
- `GET /security-log` → `{logs}`
- `POST /2fa/setup` → `{secret, otpauthUrl, backupCodes}`; `POST /2fa/enable`
  `{code}`; `POST /2fa/disable` `{code}`
- `POST /change-password` `{oldPassword, newPassword}`
- `GET /notifications` → `{notifications}`; `POST /notifications/read`

### Storage — /storage (auth)
- `GET /vault` → root of "My Vault" `{items}`
- `GET /vault/:parentId` → children `{items}`
- `POST /vault/folder` `{name, parentId?, workspaceId?}` → 201 `{folder}`
- `GET /vault/:itemId/versions` → `{versions}`; `POST /vault/:itemId/restore`
  `{version}`
- `DELETE /vault/:itemId` → `{ok:true}`
- `GET /vault/:itemId/content` → octet-stream download (sha256 in `X-Sha256` header)

Item shape: `{id, owner_id, workspace_id, parent_id, name, kind: 'file'|'folder',
sha256, size, mtime, version, deleted, created_at, updated_at}`

### Sync — /sync (auth; upload/download need device-bound access token)
- `POST /upload` `{filename, size, sha256, mtime?, parentId?, workspaceId?}` → 201
  `{jobId, jobToken, itemId, chunkSize, totalBytes, sha256, route, deduped, noChange}`
  (if `deduped` true, nothing more to do)
- `POST /download` `{itemId}` → 201 `{jobId, jobToken, itemId, chunkSize, totalBytes,
  sha256, name, route}`
- `POST /jobs/:jobId/chunks/:index` — body = raw `application/octet-stream` chunk
  (`Content-Type: application/octet-stream`), header `x-job-token: <jobToken>` →
  `{index, ok|skipped|gap, bytesDone, resumeIndex, totalBytes}`. Client sends chunks
  sequentially from index 0; `gap` means it must retry from `resumeIndex`.
- `GET /jobs/:jobId/chunks/:index` — header `x-job-token` → octet-stream chunk +
  headers `X-Chunk-Start`, `X-Chunk-End`, `X-Total-Bytes`
- `POST /jobs/:jobId/complete` `{jobToken}` → `{ok, itemId?}` (server verifies sha)
- `POST /jobs/:jobId/fail` `{jobToken, error?}`
- `POST /jobs/:jobId/reassign` (auth) → `{route, transfer}`
- `POST /manifest` `{manifest: ManifestEntry[]}` → `{toUpload, toDownload}`; a device
  sends the list of local files `{path, sha256?, size, mtime, deleted, conflictOf?}`.
  toUpload entries reuse the same shape (may include `conflictOf`); toDownload entries
  are `{itemId, path, sha256, size, mtime, kind}`.
- `POST /ack` `{entries: [{itemId, sha256, mtime, deleted}]}` → `{ok, syncedAt}`
  (client persists this so the server knows its baseline for conflict detection)

### Search — /search (auth)
- `GET /search?q=...` → `{results: ItemRow[] & {path}}`

### Sharing — /sharing (auth)
- `GET /workspaces` → `{workspaces}`; `POST /workspaces` `{name, kind?}` → 201
  `{workspace}`; `GET /workspaces/:id` → `{workspace, role, members}`;
  `DELETE /workspaces/:id`
- `POST /workspaces/:id/members` `{userId, role: owner|editor|viewer}`;
  `DELETE /workspaces/:id/members/:userId`
- `GET /workspaces/:id/items`; `POST /workspaces/:id/folder` `{name, parentId?}`;
  `DELETE /workspaces/:id/items/:itemId`

### Agent gateway — /agent (phones)
- `POST /register` `{name, model?, osVersion?}` → 201 `{node_id, token}` (one-time,
  store in device keychain; header for later calls = `Authorization: Bearer <token>`)
- `POST /heartbeat` (agent auth) body `{cpu, ramTotal, ramAvailable, battery,
  charging, temp, storageFree, activeTransfers, lanIp, lanPort, bytesSentSinceLast,
  bytesRecvSinceLast, sentAt}` → `{now, score, jobs}` where `jobs` = queued transfers
  assigned to this node `[{job_id, direction, total_bytes, bytes_done, chunk_size,
  item_id, sha256, job_token, node_id, node_name}]`
- `POST /jobs/:jobId/claim` (agent auth) → `{job, status}`
- `POST /jobs/:jobId/chunks/:index` (agent auth, octet-stream, `x-job-token`) — relay
  for upload
- `GET /jobs/:jobId/chunks/:index` (agent auth, `x-job-token`) — relay for download
- `POST /jobs/:jobId/complete` / `POST /jobs/:jobId/fail` `{error?}` (agent auth)

### Admin / monitoring — /monitor (auth + admin role)
- `GET /dashboard/summary` → `{server:{hostname,platform,arch,uptime,cpu,ram,storage,
  temp,addresses,time}, nodes:[{id,name,model,status,lastSeen,lanIp,lanPort,score,
  battery,charging,cpu,temp,netSpeed,latency,ramAvailable,ramTotal,storageFree,
  activeTransfers,currentTransfer}], transfers:{active:[],recentFailed:[]}, files:
  {count,totalBytes}, counts:{users,devices,workspaces}, recentActivity, config}`
- `GET /admin/users` → `{users}`; `GET /admin/storage` → `{byUser, byWorkspace}`;
  `POST /admin/backup` → `{backup,size}`; `GET /admin/activity`; `GET /admin/nodes`;
  `GET /admin/config`

## Scoring / routing (server-side, already implemented)
score = 0.25·net + 0.15·ram + 0.2·battery + 0.05·charging − 0.15·cpu − 0.15·load −
0.05·temp + 0.1·history. Node gates: battery<15% unless charging, temp>45°C, ≥1 active
transfer. LAN device → direct route; remote → best gateway; else direct fallback.

## Hardware / config defaults (document in README)
- Server: Lenovo IdeaPad, i3 11th gen, 4GB RAM, 1TB HDD, Ubuntu. Port 8080.
- Gateways: Motorola E32s (4/64), Motorola E7 (4/64) — Android 12/13. Battery: keep
  plugged in when acting as gateways. Heartbeat 3s, exact alarm, wakelock during relay.
- Dashboard: Samsung Tab A7 web browser.
- Windows: SMB mount of server share (native, no WinFsp).
- Phase 2: Tailscale mesh for web access.

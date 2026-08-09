# Project Nexus

A self-hosted private cloud for your family, built entirely out of hardware you already
own. No subscriptions, no cloud accounts, no data leaving the house. A central server on
an old laptop keeps all files, two spare Android phones act as always-on gateway/relay
nodes, the Windows PC gets a plain network drive, and a tablet browses the whole thing
over the LAN.

Phase 1 is a fully local network ("LAN only"). Phase 2 adds remote access anywhere via a
Tailscale mesh. See the [Phase 2 roadmap](#phase-2-roadmap) at the end.

Detailed API and coordination contracts live in [docs/SPEC.md](docs/SPEC.md).

---

## Architecture overview

```
                         Nexus server (Lenovo IdeaPad)
                     Node 24 + TypeScript + Express
                  SQLite (WAL) + FTS5 full-text search
                   content-addressed dedup storage
              systemd unit + 5-min Samba export timer
                                 ^
                                 | HTTP :8080 (API + web dashboard)
                 +---------------+------+----------------+
                 |              |       |                |
    Gateway phones   Android backup apps   Windows PC      Samsung Tab A7
    (Motorola E32s)  (each family member)  mounts Samba    web dashboard in
    (Motorola E7)                             \\<ip>\nexus     a browser
    relay + route      |                       as drive N:
    transfers         v
                 upload via chunked sync
                 (agents relay when the
                 client cannot reach the
                 server directly)
```

- **Central server** — the single source of truth. Holds the SQLite database (WAL mode)
  plus an FTS5 `search_index` for full-text search, stores every file once by its
  sha256 (content-addressed dedup), and keeps `KEEP_VERSIONS` copies of changed files so
  nothing is ever silently overwritten.
- **Gateway phones** — the two Motorolas run the Nexus Agent app 24/7 and are always
  plugged in. The server scores every node from its heartbeat and routes transfers
  through the best one. Clients that can reach the server directly are routed direct;
  otherwise transfers go via a gateway.
- **Windows PC** — maps the server's Samba share `\\<server-ip>\nexus` to a drive letter
  using native SMB. No extra drivers.
- **Android backup app** — each family member's phone automatically uploads photos and
  files (Wi-Fi only, charging only, configurable) into `Backups/YYYY/MM` in the vault.
- **Samsung Tab A7** — just a browser pointed at the server's web dashboard.

Transfers are chunked (default 1 MiB per chunk), verified on both ends by sha256, and
resumable. Version history lives on the server, so a client's bad edit never destroys an
older copy.

## Hardware map

| Device | Role | Requirement |
| --- | --- | --- |
| Lenovo IdeaPad, i3 11th gen, 4GB RAM, 1TB HDD, Ubuntu | Central server (Node 24, SQLite, Samba) | Always on, port 8080, static LAN IP |
| Motorola E32s (4GB/64GB), Android 12 | Gateway / relay node | Nexus Agent app 24/7, plugged in, exempt from battery optimization |
| Motorola E7 (4GB/64GB), Android 13 | Gateway / relay node | Nexus Agent app 24/7, plugged in, exempt from battery optimization |
| Samsung Galaxy Tab A7 | Web dashboard client | Browser, LAN access to the server |
| Windows PC (10/11) | File client over SMB | Native SMB share mapping, no WinFsp |

## Repo layout

```
server/       Node 24 + TypeScript + Express backend
  src/        api/, services/, db/ (WAL + FTS5), lib/, middleware/
  public/     web dashboard (static SPA served by express.static)
  test/       23 passing tests (auth, gateway, storage)
  .env.example  configuration template
android/
  agent/      Kotlin Gradle app - phone gateway/relay agent
  backup/     Kotlin Gradle app - per-family-member backup uploader
deploy/       Linux setup scripts, systemd unit + export timer
windows/      SMB mount helper for the Windows PC
docs/         spec and documentation index
```

## Server setup (Linux)

These steps happen on the Lenovo IdeaPad (Ubuntu). You only need `setup-linux.sh`; the
Samba script is optional and only if you want the Windows drive.

### 1. Clone and configure

```bash
git clone <this repo> nexus
cd nexus
cp server/.env.example server/.env
```

### 2. Install everything

Run the installer. It installs Node 24, Samba, a systemd unit for the server, and a
systemd timer that exports the vault to the Samba share every 5 minutes:

```bash
bash deploy/setup-linux.sh
```

### 3. Create the admin account

Start the server (the systemd unit `nexus` does this for you; `systemctl start nexus`)
and open a browser on any device on the LAN:

```
http://<server-ip>:8080/
```

Register with a username and password. The **first registered user becomes admin**. The
dashboard then opens: users, devices, gateways, files, search, and the security log.

### 4. Optional: Windows Samba share

If you want the Windows drive (`\\<server-ip>\nexus`), run:

```bash
bash deploy/setup-samba.sh
```

This creates the Samba share and a Samba account. Write down that username/password —
the Windows PC needs it. See [windows/README.md](windows/README.md) for the Windows side.

### Configuration reference (`server/.env`)

| Key | Default | Meaning |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | HTTP listen address. Keep `0.0.0.0` so LAN devices can reach the server. |
| `PORT` | `8080` | HTTP port for the API and web dashboard. |
| `DATA_DIR` | `./data` | Data directory (relative to `server/`): db, storage, backups, logs, keys. |
| `CHUNK_SIZE` | `1048576` | Transfer chunk size in bytes (1 MiB). |
| `KEEP_VERSIONS` | `10` | Number of file versions kept when a file changes. |
| `HEARTBEAT_INTERVAL_MS` | `3000` | Heartbeat cadence (ms) for the Android agents. |
| `BATTERY_MIN` | `15` | Below this battery %, a node gets no new work unless it is charging. |
| `TEMP_MAX_C` | `45` | Above this temperature (Celsius), a node gets no new work. |
| `MAX_CONCURRENT_TRANSFERS_PER_NODE` | `1` | Transfers a phone gateway handles at once (low power => 1). |
| `SERVER_BACKUP_HOURS` | `24` | Automatic server backup every N hours; 0 disables. |

Useful extras that also exist in `server/.env.example`: `NODE_TIMEOUT_MULTIPLIER`
(offline after N missed heartbeats), `CHUNK_BUFFER_LIMIT`, `MAX_REASSIGNMENTS`,
`METRICS_RETENTION_DAYS`, `ACCESS_TOKEN_MINUTES` (15), `REFRESH_TOKEN_DAYS` (90),
`VERSIONING`, and `TOKEN_SECRET` (otherwise auto-generated into `data/system/token.key`).

### Backups and WAL

The SQLite database runs in **WAL mode**, so reads don't block writes and the DB keeps a
growing `nexus.db-wal`. Backups are handled two ways:

- **Automatic**: the server writes a backup every `SERVER_BACKUP_HOURS` hours to
  `server/data/backups/`. If you notice the WAL file growing large between backups, that
  is normal; a backup checkpoints the WAL.
- **On demand**: an admin can trigger a backup from the dashboard or via:

```
POST /api/v1/monitor/admin/backup      (Authorization: Bearer <access token>, admin role)
```

returns `{backup, size}`.

## Gateway phones (Nexus Agent)

### Build the app

You need **JDK 17 or 21**. JDK 26 is not compatible (the Android Gradle Plugin does not
support it yet), so install JDK 17 or 21 and point `JAVA_HOME` at it before building:

```bash
cd android/agent
./gradlew assembleRelease
```

Install the resulting APK on both Motorolas (E32s and E7).

### Configure

1. Open the Nexus Agent app on each phone.
2. Point it at the server: `http://<server-ip>:8080`.
3. Register the node. The server returns a one-time node token, which the app stores in
   the device keychain (it is the app's permanent identity).
4. In Android settings, set the app to be **exempt from battery optimization**
   (Settings > Apps > Nexus Agent > Battery > "Don't optimize"). If your phone also has
   an aggressive "app killer", allow background activity.
5. **Keep both phones plugged in** at all times — they act as gateways for the whole
   house. A phone that dies means transfers route through the remaining node.

### How heartbeats and scoring work

Every `HEARTBEAT_INTERVAL_MS` (default 3 s) the agent POSTs its state
(`cpu`, `ramAvailable`, `battery`, `charging`, `temp`, `storageFree`, `activeTransfers`,
`lanIp`, `lanPort`, byte counters, `sentAt`) to `POST /api/v1/agent/heartbeat`. The
server replies with the node's current score and any jobs assigned to it.

The server scores each node on every heartbeat:

```
score = 0.25*net + 0.15*ram + 0.2*battery + 0.05*charging - 0.15*cpu - 0.15*load - 0.05*temp + 0.1*history
```

Node gates (a node is skipped for new work when): battery below `BATTERY_MIN` unless
charging, temperature above `TEMP_MAX_C`, or it already has `MAX_CONCURRENT_TRANSFERS_PER_NODE`
active transfers.

Routing: a LAN device talks to the server directly; otherwise the scheduler picks the
best-scoring gateway and the job is relayed through it. The agent keeps the phone awake
during a relay (wakelock) and uses an exact alarm for its heartbeat.

## Android backup app

### Build

```bash
cd android/backup
./gradlew assembleRelease
```

Install the APK on each family member's phone.

### Set up

1. Log in with the family member's Nexus account (created on the web dashboard).
2. The app registers itself as a trusted device with the server (device-bound refresh
   token, see the security model below).
3. In settings choose:
   - **Wi-Fi only** — never upload over mobile data.
   - **Charging only** — only sync while plugged in.
   - **Media types** — photos, videos, and/or documents.

### Where uploads land

The backup app syncs its content into the vault under `Backups/YYYY/MM/` (year/month),
one folder per family member's device. Because storage is content-addressed, identical
files (for example, the same photo forwarded twice) are stored once and only linked.

## Windows drive

Map the server's Samba share to a drive letter with native SMB (no WinFsp — that is a
Phase 2 item):

```powershell
cd windows
.\mount-drive.ps1 -Server <server-ip> -User <samba-user>
```

It maps `\\<server-ip>\nexus` to `N:` with `/persistent:yes`, handles an already-mapped
or stale `N:`, and prints a test write. Use `.\unmount-drive.ps1` to remove it.

**Remember the 5-minute caveat**: the server exports the vault to the Samba share via a
systemd timer every ~5 minutes. This is not a live FUSE mount — a file uploaded to the
dashboard or backup app appears on `N:` within about 5 minutes. See
[windows/README.md](windows/README.md) for the full guide, prerequisites, and
troubleshooting.

## Web dashboard

Open `http://<server-ip>:8080/` in any browser (the Tab A7 works well):

- **Dashboard** — server health, node/gateway status, active and failed transfers,
  storage used, recent activity.
- **Files** — browse the vault, upload, download, and restore any previous version
  (`GET /api/v1/vault/:itemId/versions`, `POST .../restore`).
- **Workspaces** — shared folders with roles **owner**, **editor**, **viewer**
  (`POST /api/v1/workspaces`, add/remove members, per-workspace items).
- **Search** — full-text search across the vault backed by SQLite FTS5
  (`GET /api/v1/search?q=...`).
- **Users** — manage accounts and roles.
- **Devices** — every trusted device, rename or revoke access.
- **Security log** — logins, token events, admin actions.
- **2FA** — per-user TOTP setup with recovery backup codes.
- **Notifications** — in-app notifications and read state.

## Security model

- **Passwords**: hashed with **scrypt** (stored as `scrypt$N$r$p$salt$hash`), never in
  plain text.
- **Two-factor**: optional **TOTP 2FA** per user, with one-time **backup codes** for
  recovery.
- **Access tokens**: **HMAC-signed** access tokens with a 15-minute lifetime
  (`ACCESS_TOKEN_MINUTES`), sent as `Authorization: Bearer <token>`.
- **Refresh tokens**: rotating, **device-bound**, and organized into families. On login
  a device gets a refresh token tied to that device. Each refresh rotates the token; if
  an already-rotated token is ever reused, the server treats it as possible theft,
  revokes the whole token family, and logs `token_theft_revoked` in the security log.
- **Devices**: all devices must be registered and are listed in the dashboard, where
  they can be renamed or **revoked** at any time.
- **Authorization**: per-vault ownership plus workspace **RBAC** with
  owner/editor/viewer roles; admin-only routes are enforced by middleware
  (`requireAuth` / `requireAdmin` / `requireAgent`).
- **HTTPS (optional but recommended)**: put the server behind a reverse proxy such as
  **Caddy** or **nginx** with a Let's Encrypt cert. The server itself listens on plain
  HTTP on `:8080`; on a trusted LAN that is acceptable, but a proxy is the right choice
  once Phase 2 exposes it beyond the house.

## Troubleshooting

| Problem | What to check |
| --- | --- |
| Server won't start | `journalctl -u nexus -e`. Common causes: `.env` missing or a bad `DATA_DIR`, port 8080 already in use (`ss -ltnp`), or Node version not 24 (`node -v`). |
| Phones show offline | Heartbeat missed → node marked offline after `NODE_TIMEOUT_MULTIPLIER` missed beats. Check the phones are charged/plugged in, the agent is exempt from battery optimization, and the agent points at the right server IP. |
| Samba can't connect on Windows | Server off, wrong IP, Samba service stopped, or the Samba user/password. Run `testparm` and `smbstatus` on the server; see [windows/README.md](windows/README.md). |
| Disk filling up | Data lives in `server/data/`: `storage/` (deduped blobs), `backups/`, `logs/`. Check `df -h`; raise `KEEP_VERSIONS` downward effect is by version pruning, and clear old backups under `data/backups/`. |
| WAL file (`nexus.db-wal`) keeps growing | Normal between backup checkpoints. Trigger `POST /api/v1/monitor/admin/backup` to checkpoint, or check `SERVER_BACKUP_HOURS` is not 0. |
| Transfers fail / slow | Look at the dashboard transfers view. Node likely gated (battery, temp, already busy). Verify `MAX_CONCURRENT_TRANSFERS_PER_NODE` and that gateways are plugged in. |
| Anything server-related | `journalctl -u nexus -e` is the first place to look. |

## Phase 2 roadmap

- **Remote access anywhere (Tailscale mesh)** — short version: install Tailscale on the
  server and on the devices you want to reach it from (phones, laptop, tablet). Each
  device joins your tailnet and gets a Tailscale IP; you then browse
  `http://<tailscale-ip>:8080/` from anywhere, with no port forwarding and no public
  exposure. The server, agents, and clients keep working unchanged because they only
  need the reachable IP swapped. Put HTTPS on it before relying on this outside the LAN.
- **Ollama-based AI search** — today search is SQLite FTS5 keyword search; a local
  Ollama model can add semantic search over vault text without sending data anywhere.
- **WinFsp live mount** — replace the 5-minute Samba export timer with a live
  FUSE/WinFsp mount so `N:` updates instantly.
- **Per-user quotas** — enforce storage limits per family member (dashboard shows usage
  by user and workspace today).

## Docs

- [docs/SPEC.md](docs/SPEC.md) — full architecture, API contract, and scoring spec.
- [docs/README.md](docs/README.md) — documentation index.
- [windows/README.md](windows/README.md) — Windows setup guide.

# Project Nexus - Linux deployment ops guide

Target: Ubuntu 22.04+ LTS on the Lenovo IdeaPad. The server runs as system user `nexus`,
listens on TCP 8080, and exposes a Samba share at `\\<server-ip>\nexus` for the Windows PC.

## Order of scripts

1. `sudo ./deploy/setup-linux.sh [/path/to/repo]`
   Bootstrap: installs Node.js 24 (NodeSource) plus git/curl/jq/rsync/samba, creates the
   `nexus` system user, copies `server/` to `/opt/nexus/server` (skipped if already there,
   or set `NEXUS_FORCE_COPY=1` to re-copy), runs `npm ci --omit=dev` (+ installs the `tsx`
   runtime, a devDependency that `npm start` needs, via `npm install --no-save tsx`), writes
   `.env` from `.env.example` with production values, installs and starts `nexus.service` and
   `nexus-export.timer`, opens TCP 8080 in ufw, and prints the LAN IPs.
   The repo root is detected automatically by walking up from the script, or defaults to
   `/opt/nexus-repo`.

2. `sudo ./deploy/setup-samba.sh`
   Installs Samba, creates the `sambausers` group, adds `nexus` to it, appends a `[nexus]`
   share to `/etc/samba/smb.conf` pointing at `/opt/nexus/share`, prompts once for the SMB
   password (`smbpasswd -a nexus`), opens ports 139/445 in ufw, restarts smbd/nmbd and prints
   the UNC path. Re-runnable.

3. Open `http://<server-ip>:8080` in a browser and register - the first account becomes admin.

## What each file does

- `setup-linux.sh` - full server bootstrap (see above).
- `nexus.service` - systemd unit for the API/dashboard. Runs `npm start` (i.e.
  `tsx src/index.ts`) as `nexus` with hardening. `ExecStart=/usr/bin/npm start` is used (not
  raw `node --import tsx`) because it is the exact command tested in development and npm adds
  `node_modules/.bin` to PATH for the script, so `tsx` resolves regardless of systemd's
  minimal PATH. `/usr/bin/npm` is used as an absolute path so the unit works without a shell.
  Both forms need `tsx`, which setup-linux.sh ensures is installed.
- `setup-samba.sh` - Samba share for the Windows drive.
- `nexus-export.timer` / `nexus-export.service` - run the export tool every 5 minutes
  (`OnBootSec=1min`, `OnUnitActiveSec=5min`, `Persistent=true`). The service runs
  `node --import tsx src/tools/exportShare.ts` as `nexus` in `/opt/nexus/server`.
- `server/src/tools/exportShare.ts` - materializes the logical file tree from the
  content-addressed storage into `/opt/nexus/share` (vault files as `<username>/My Vault/...`,
  workspace files as `<workspace>/...`). Uses hard links to the sha256 blobs, prunes stale
  files, and is incremental/idempotent.

## .env keys used on the server

Created once from `.env.example`; an existing `.env` is never overwritten.

```
HOST=0.0.0.0
PORT=8080
DATA_DIR=/opt/nexus/server/data
SHARE_DIR=/opt/nexus/share
SERVER_BACKUP_HOURS=24
```

`SHARE_DIR` is read directly by `exportShare.ts` (default `data/share` if unset). The npm
cache is redirected to `/opt/nexus/server/data/.npm-cache` via `npm_config_cache` in the
systemd units so the service stays writable under `ProtectSystem=strict`.

## Backup

- API backup (recommended): call `POST /api/v1/monitor/admin/backup` with an admin bearer
  token. A backup archive is written to `data/backups/`.
- Manual: copy `/opt/nexus/server/data` (DB, content-addressed storage, backups). For a
  consistent copy, stop the server first (`sudo systemctl stop nexus`), copy, then start it.
  Never copy or delete `data/nexus.db-wal` / `data/nexus.db-shm` while the server is running.

## Upgrade

```bash
cd /opt/nexus-repo && git pull
sudo rsync -a --delete --exclude node_modules --exclude data --exclude .env server/ /opt/nexus/server/
sudo -u nexus bash -c 'cd /opt/nexus/server && npm_config_cache=/opt/nexus/server/data/.npm-cache npm ci --omit=dev'
sudo -u nexus bash -c 'cd /opt/nexus/server && npm_config_cache=/opt/nexus/server/data/.npm-cache npm install --no-save tsx@^4'
sudo systemctl restart nexus
```

(or run `sudo NEXUS_FORCE_COPY=1 ./deploy/setup-linux.sh /opt/nexus-repo` to re-copy +
reinstall in one go).

## Firewall

- TCP 8080 - Nexus API and dashboard.
- TCP 139 and 445 - Samba.

Both are opened by the setup scripts when ufw is installed.

## Changing the Samba password

```bash
sudo smbpasswd nexus
```

## Troubleshooting

- Server logs: `journalctl -u nexus -f`, service status: `systemctl status nexus`.
- Export logs: `journalctl -u nexus-export.service`, timer: `systemctl list-timers
  nexus-export.timer`. Run the export by hand with
  `sudo systemctl start nexus-export.service` and check
  `journalctl -u nexus-export.service -n 50`.
- Server not starting: check `journalctl -u nexus -n 50`. Common causes: `.env` owned or
  unreadable by `nexus` (fix: `sudo chown -R nexus:nexus /opt/nexus/server`), or missing
  `tsx` (re-run the npm steps from the Upgrade section).
- Disk full: `df -h`. Files live in `/opt/nexus/server/data/storage` (deduped blobs); the
  Samba share only holds hard links, so it does not duplicate space. Run
  `sudo journalctl -u nexus -n 100` to see space errors, and check prune/backup settings.
- WAL files: SQLite runs in WAL mode, so `data/nexus.db-wal` grows between checkpoints. Do
  not delete it while the server runs. Checkpointing is automatic; a clean stop checkpoints
  too. For backup consistency use the API endpoint or stop the server first.
- SMB mount fails: verify `smbd` is running (`systemctl status smbd`), the `nexus` SMB
  password exists (`pdbedit -L`), the Windows user logs in as `nexus`, and the share is
  listed with `smbclient -L <server-ip> -U nexus`.
- Permission errors in the share: files should be owned by `nexus`. Fix with
  `sudo chown -R nexus:sambausers /opt/nexus/share`.

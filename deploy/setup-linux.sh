#!/usr/bin/env bash
# Project Nexus - Linux server bootstrap (idempotent, Ubuntu 22.04+ LTS)
set -euo pipefail

if [ -t 1 ]; then
  C_BOLD=$'\033[1m'
  C_GREEN=$'\033[0;32m'
  C_YELLOW=$'\033[1;33m'
  C_RED=$'\033[0;31m'
  C_RESET=$'\033[0m'
else
  C_BOLD=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

step() { echo; echo "${C_BOLD}==> $*${C_RESET}"; }
info() { echo "${C_GREEN}[nexus]${C_RESET} $*"; }
warn() { echo "${C_YELLOW}[warn]${C_RESET} $*"; }
die()  { echo "${C_RED}[error]${C_RESET} $*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
  $SUDO -v || die "this script needs root (run with sudo or as root)"
fi
run_nexus() { sudo -u nexus bash -c "$1"; }

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

step "Locating the Nexus repo"
REPO="${1:-}"
if [ -z "$REPO" ]; then
  d="$SCRIPT_DIR"
  while [ "$d" != "/" ]; do
    if [ -d "$d/server" ] && [ -f "$d/docs/SPEC.md" ]; then REPO="$d"; break; fi
    d="$(dirname -- "$d")"
  done
fi
if [ -z "$REPO" ]; then REPO="/opt/nexus-repo"; fi
[ -d "$REPO/server" ] || die "no server/ found in repo '$REPO' - pass the repo root as arg 1 or clone it to /opt/nexus-repo"
info "repo root: $REPO"

step "Detecting platform"
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) NODE_ARCH="x64" ;;
  aarch64|arm64) NODE_ARCH="arm64" ;;
  *) warn "unknown arch '$ARCH', assuming x64"; NODE_ARCH="x64" ;;
esac
if [ -f /etc/os-release ]; then
  . /etc/os-release
  info "distro: ${PRETTY_NAME:-$ID $VERSION_ID} (arch: $ARCH, NodeSource: $NODE_ARCH)"
else
  info "arch: $ARCH (NodeSource: $NODE_ARCH)"
fi

step "Installing system packages"
if ! command -v curl >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y curl
fi
need_node=1
if command -v node >/dev/null 2>&1; then
  v="$(node --version 2>/dev/null || true)"
  major="${v#v}"; major="${major%%.*}"
  case "$major" in ''|*[!0-9]*) major=0 ;; esac
  if [ "$major" -ge 24 ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  info "installing Node.js 24 from NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
else
  info "node $(node --version) already installed (>= 24)"
fi
$SUDO apt-get update -qq
$SUDO apt-get install -y git jq rsync samba

step "Creating the 'nexus' system user"
if id -u nexus >/dev/null 2>&1; then
  info "user 'nexus' already exists"
else
  $SUDO useradd --system --shell /usr/sbin/nologin --home-dir /opt/nexus nexus
  info "created system user 'nexus' (no login)"
fi

NEXUS_SERVER=/opt/nexus/server
step "Installing server code to $NEXUS_SERVER"
$SUDO mkdir -p "$NEXUS_SERVER"
if [ -f "$NEXUS_SERVER/package.json" ] && [ "${NEXUS_FORCE_COPY:-0}" != "1" ]; then
  info "server already installed, skipping copy (set NEXUS_FORCE_COPY=1 to re-copy from repo)"
else
  if command -v rsync >/dev/null 2>&1; then
    $SUDO rsync -a --exclude node_modules --exclude data --exclude .env "$REPO/server/" "$NEXUS_SERVER/"
  else
    $SUDO cp -a "$REPO/server/." "$NEXUS_SERVER/"
    $SUDO rm -rf "$NEXUS_SERVER/node_modules" "$NEXUS_SERVER/data"
  fi
  info "copied server/ from $REPO"
fi
$SUDO chown -R nexus:nexus "$NEXUS_SERVER"

step "Preparing data directories"
$SUDO mkdir -p "$NEXUS_SERVER/data/storage" "$NEXUS_SERVER/data/backups" "$NEXUS_SERVER/data/logs" "$NEXUS_SERVER/data/system" "$NEXUS_SERVER/data/.npm-cache" /opt/nexus/share
$SUDO chown -R nexus:nexus "$NEXUS_SERVER" /opt/nexus/share

step "Installing npm dependencies (as nexus)"
if [ -f "$NEXUS_SERVER/package-lock.json" ]; then
  run_nexus "cd $NEXUS_SERVER && npm_config_cache=$NEXUS_SERVER/data/.npm-cache npm ci --omit=dev"
  if [ ! -x "$NEXUS_SERVER/node_modules/.bin/tsx" ]; then
    info "tsx is a devDependency but 'npm start' needs it; installing without saving"
    run_nexus "cd $NEXUS_SERVER && npm_config_cache=$NEXUS_SERVER/data/.npm-cache npm install --no-save tsx@^4"
  fi
else
  run_nexus "cd $NEXUS_SERVER && npm_config_cache=$NEXUS_SERVER/data/.npm-cache npm install"
fi

step "Configuring .env"
ENV_FILE="$NEXUS_SERVER/.env"
if [ -f "$ENV_FILE" ]; then
  info ".env already exists (not overwritten)"
else
  if [ -f "$NEXUS_SERVER/.env.example" ]; then
    $SUDO cp "$NEXUS_SERVER/.env.example" "$ENV_FILE"
    info "created .env from .env.example"
  else
    $SUDO touch "$ENV_FILE"
    info "created empty .env"
  fi
  ensure_env_key() {
    local key="$1" val="$2"
    if grep -qE "^${key}=" "$ENV_FILE"; then
      $SUDO sed -i "s|^${key}=.*|${key}=${val}|" "$ENV_FILE"
    else
      printf '%s=%s\n' "$key" "$val" | $SUDO tee -a "$ENV_FILE" >/dev/null
    fi
  }
  ensure_env_key HOST 0.0.0.0
  ensure_env_key PORT 8080
  ensure_env_key DATA_DIR /opt/nexus/server/data
  ensure_env_key SHARE_DIR /opt/nexus/share
  ensure_env_key SERVER_BACKUP_HOURS 24
fi
info ".env keys in use: HOST, PORT, DATA_DIR, SHARE_DIR, SERVER_BACKUP_HOURS"

step "Installing systemd units"
DEPLOY_DIR="$SCRIPT_DIR"
if [ ! -f "$DEPLOY_DIR/nexus.service" ]; then
  DEPLOY_DIR="/opt/nexus-repo/deploy"
fi
for unit in nexus.service nexus-export.service nexus-export.timer nexus-shutdown.path nexus-shutdown.service; do
  [ -f "$DEPLOY_DIR/$unit" ] || die "missing $DEPLOY_DIR/$unit (expected in the deploy/ folder next to this script)"
  $SUDO cp "$DEPLOY_DIR/$unit" "/etc/systemd/system/$unit"
done
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now nexus.service
$SUDO systemctl enable --now nexus-export.timer
$SUDO systemctl start nexus-export.service || warn "initial export failed (the 5-min timer will retry)"
$SUDO systemctl enable --now nexus-shutdown.path

step "Firewall"
if command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow 8080/tcp
  info "ufw: allowed 8080/tcp for the Nexus API/dashboard"
else
  info "ufw not present; open TCP 8080 in your firewall"
fi

step "Server LAN addresses"
if command -v hostname >/dev/null 2>&1; then
  hostname -I 2>/dev/null | tr ' ' '\n' | grep -v '^$' | sed 's/^/  /' || true
else
  ip -4 addr show 2>/dev/null | grep -oE 'inet [0-9.]+' | awk '{print $2}' | grep -v '^127\.' | sed 's/^/  /' || true
fi

step "Bootstrap complete"
info "Nexus is running: http://<server-ip>:8080"
info "The first visit to / creates the admin account (first registered user becomes admin)."
info "Port 8080/tcp is open in ufw."
info "Next: run deploy/setup-samba.sh to expose /opt/nexus/share over SMB."

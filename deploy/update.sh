#!/usr/bin/env bash
# Project Nexus - Server update script
# Pulls latest code, syncs to /opt/nexus/server, reinstall deps, restarts service
set -euo pipefail

C_BOLD=$'\033[1m'
C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[1;33m'
C_RED=$'\033[0;31m'
C_RESET=$'\033[0m'

step() { echo; echo "${C_BOLD}==> $*${C_RESET}"; }
info() { echo "${C_GREEN}[nexus]${C_RESET} $*"; }
warn() { echo "${C_YELLOW}[warn]${C_RESET} $*"; }
die()  { echo "${C_RED}[error]${C_RESET} $*" >&2; exit 1; }

REPO="${1:-${NEXUS_REPO:-/opt/nexus-repo}}"
[ -d "$REPO/server" ] || REPO="${HOME}/nexus"
[ -d "$REPO/server" ] || die "Nexus repo not found (tried /opt/nexus-repo and ~/nexus). Pass the repo path: bash deploy/update.sh /path/to/nexus"

NEXUS_SERVER=/opt/nexus/server

step "Pulling latest code in $REPO"
cd "$REPO"
git pull origin main || git pull origin master || warn "git pull failed - are you on the right branch?"

step "Syncing server/ to $NEXUS_SERVER"
sudo rsync -a --delete --exclude node_modules --exclude data --exclude .env "$REPO/server/" "$NEXUS_SERVER/"
sudo chown -R nexus:nexus "$NEXUS_SERVER"

step "Installing dependencies"
sudo -u nexus bash -c 'cd /opt/nexus/server && npm_config_cache=/opt/nexus/server/data/.npm-cache npm ci --omit=dev'
sudo -u nexus bash -c 'cd /opt/nexus/server && npm_config_cache=/opt/nexus/server/data/.npm-cache npm install --no-save tsx@^4'

step "Installing shutdown units (dashboard Shut down button)"
for unit in nexus-shutdown.path nexus-shutdown.service; do
  sudo cp "$REPO/deploy/$unit" "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemctl enable --now nexus-shutdown.path

step "Restarting nexus service"
sudo systemctl restart nexus

sleep 2

if systemctl is-active --quiet nexus; then
  info "Nexus is running!"
  info "Dashboard: http://$(hostname -I | awk '{print $1}'):8080"
else
  die "Nexus failed to start. Check: sudo journalctl -u nexus -n 20"
fi

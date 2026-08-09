#!/usr/bin/env bash
# Project Nexus - Server update script
# Pulls latest code and restarts the service
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

REPO="${HOME}/nexus"
[ -d "$REPO" ] || die "Nexus repo not found at $REPO"

cd "$REPO"

step "Pulling latest code"
git pull origin main || git pull origin master || warn "git pull failed — are you on the right branch?"

step "Installing dependencies"
cd server
npm install --omit=dev 2>/dev/null || npm install

step "Restarting nexus service"
sudo systemctl restart nexus

sleep 2

if systemctl is-active --quiet nexus; then
  info "Nexus is running!"
  info "Dashboard: http://$(hostname -I | awk '{print $1}'):8080"
else
  die "Nexus failed to start. Check: sudo journalctl -u nexus -n 20"
fi

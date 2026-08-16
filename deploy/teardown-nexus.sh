#!/usr/bin/env bash
# Project Nexus - Teardown: removes all Nexus software from this machine.
# Leaves the Minecraft server files in /opt/minecraft untouched.
# Usage: sudo bash deploy/teardown-nexus.sh
set -euo pipefail

C_BOLD=$'\033[1m'
C_RED=$'\033[0;31m'
C_YELLOW=$'\033[1;33m'
C_GREEN=$'\033[0;32m'
C_RESET=$'\033[0m'

step() { echo; echo "${C_BOLD}==> $*${C_RESET}"; }
warn() { echo "${C_YELLOW}[warn]${C_RESET} $*"; }
info() { echo "${C_GREEN}[teardown]${C_RESET} $*"; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
  $SUDO -v || { echo "needs root - run with sudo" >&2; exit 1; }
fi

step "Stopping and disabling Nexus services"
for unit in nexus.service nexus-export.service nexus-export.timer nexus-shutdown.path nexus-shutdown.service nexus-minecraft-start.path nexus-minecraft-start.service nexus-minecraft-stop.path nexus-minecraft-stop.service; do
  $SUDO systemctl stop "$unit" 2>/dev/null || true
  $SUDO systemctl disable "$unit" 2>/dev/null || true
done
$SUDO rm -f /etc/systemd/system/nexus.service /etc/systemd/system/nexus-export.* /etc/systemd/system/nexus-shutdown.* /etc/systemd/system/nexus-minecraft-*.{service,path} 2>/dev/null || true
$SUDO systemctl daemon-reload
info "Nexus services removed"

step "Deleting /opt/nexus"
if [ -d /opt/nexus ]; then
  $SUDO rm -rf /opt/nexus
  info "/opt/nexus removed"
else
  info "/opt/nexus not present"
fi

step "Removing Samba [nexus] share"
if grep -q '^\[nexus\]' /etc/samba/smb.conf 2>/dev/null; then
  $SUDO sed -i '/^\[nexus\]$/,/^$/d' /etc/samba/smb.conf
  $SUDO pdbedit -x nexus 2>/dev/null || true
  info "Samba share removed"
else
  info "no [nexus] share in smb.conf"
fi

step "Removing the 'nexus' system user"
if id -u nexus >/dev/null 2>&1; then
  $SUDO userdel nexus 2>/dev/null || true
  info "user 'nexus' removed"
else
  info "user 'nexus' not present"
fi

step "Removing firewall rule for 8080"
if command -v ufw >/dev/null 2>&1; then
  $SUDO ufw delete allow 8080/tcp 2>/dev/null || true
  info "ufw rule removed (8080/tcp)"
else
  info "ufw not present"
fi

step "Removing the local repo copy"
if [ -d "$HOME/nexus" ]; then
  $SUDO rm -rf "$HOME/nexus"
  info "$HOME/nexus removed"
fi
if [ -d /opt/nexus-repo ]; then
  $SUDO rm -rf /opt/nexus-repo
  info "/opt/nexus-repo removed"
fi

step "Teardown complete"
warn "Nexus is gone from this machine."
warn "The Minecraft server files are still at /opt/minecraft (untouched)."
warn "Samba service itself is still installed but no longer shares anything."

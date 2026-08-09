#!/usr/bin/env bash
# Project Nexus - Samba share for Windows clients (native SMB, no WinFsp)
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
info() { echo "${C_GREEN}[samba]${C_RESET} $*"; }
warn() { echo "${C_YELLOW}[warn]${C_RESET} $*"; }
die()  { echo "${C_RED}[error]${C_RESET} $*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
  $SUDO -v || die "this script needs root (run with sudo or as root)"
fi

step "Installing Samba"
if ! command -v smbpasswd >/dev/null 2>&1; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y samba
else
  info "samba already installed"
fi

step "Creating the 'sambausers' group"
if getent group sambausers >/dev/null 2>&1; then
  info "group 'sambausers' already exists"
else
  $SUDO groupadd sambausers
  info "created group 'sambausers'"
fi

if ! id nexus >/dev/null 2>&1; then
  die "user 'nexus' does not exist - run deploy/setup-linux.sh first"
fi
$SUDO usermod -aG sambausers nexus
info "added 'nexus' to 'sambausers'"

step "Preparing the share directory"
SHARE_DIR=/opt/nexus/share
$SUDO mkdir -p "$SHARE_DIR"
$SUDO chown -R nexus:sambausers "$SHARE_DIR"
info "share dir: $SHARE_DIR"

step "Configuring /etc/samba/smb.conf"
SMB_CONF=/etc/samba/smb.conf
if grep -q '^\[nexus\]' "$SMB_CONF" 2>/dev/null; then
  info "[nexus] share already defined"
else
  $SUDO tee -a "$SMB_CONF" >/dev/null <<EOF

[nexus]
   path = $SHARE_DIR
   browseable = yes
   read only = no
   guest ok = no
   valid users = @sambausers
   force user = nexus
   create mask = 0664
   directory mask = 0775
EOF
  info "added [nexus] share to smb.conf"
fi

step "Samba password for user 'nexus'"
if pdbedit -L 2>/dev/null | grep -q '^nexus:'; then
  info "nexus already has a Samba password (change it with: sudo smbpasswd nexus)"
else
  info "set a password for the SMB user 'nexus' - this is the login used by Windows"
  $SUDO smbpasswd -a nexus
fi

step "Firewall rules for Samba"
if command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow 139/tcp || true
  $SUDO ufw allow 445/tcp || true
  $SUDO ufw allow Samba || true
  info "ufw: allowed 139/tcp, 445/tcp and the Samba profile"
else
  info "ufw not present; open TCP 139 and 445 for Samba"
fi

step "Restarting Samba services"
$SUDO systemctl enable --now smbd nmbd 2>/dev/null || true
$SUDO systemctl restart smbd nmbd || $SUDO systemctl restart smbd
info "Samba is running"

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$IP" ] || IP="<server-ip>"

step "Done - mount from Windows"
info "UNC path: \\\\${IP}\\nexus"
info "username: nexus  (password is the one you just set)"

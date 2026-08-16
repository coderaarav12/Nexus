#!/usr/bin/env bash
# Project Nexus - Restore a Minecraft server backup into /opt/minecraft
# Usage: sudo bash deploy/restore-minecraft.sh /path/to/backup-dir
set -euo pipefail

C_BOLD=$'\033[1m'
C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[1;33m'
C_RED=$'\033[0;31m'
C_RESET=$'\033[0m'

step() { echo; echo "${C_BOLD}==> $*${C_RESET}"; }
info() { echo "${C_GREEN}[restore]${C_RESET} $*"; }
warn() { echo "${C_YELLOW}[warn]${C_RESET} $*"; }
die()  { echo "${C_RED}[error]${C_RESET} $*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
  $SUDO -v || die "this script needs root (run with sudo or as root)"
fi
run_as_minecraft() {
  if [ "$(id -u)" -eq 0 ]; then
    su -s /bin/bash minecraft -c "$1"
  else
    $SUDO -u minecraft bash -c "$1"
  fi
}

SRC="${1:-}"
[ -n "$SRC" ] || die "usage: $0 /path/to/backup-dir"
[ -d "$SRC" ] || die "backup dir not found: $SRC"
[ -f "$SRC/purpur.jar" ] || die "$SRC does not contain purpur.jar - is this the right backup?"

MC_DIR=/opt/minecraft
MC_RAM_GB="${MC_RAM_GB:-4}"
JAVA_BIN="$(command -v java || true)"
[ -n "$JAVA_BIN" ] || die "java not installed (run setup-linux or install openjdk-21)"

step "Stopping any existing Minecraft server"
$SUDO systemctl stop minecraft 2>/dev/null || true

step "Creating the 'minecraft' user if needed"
if ! id -u minecraft >/dev/null 2>&1; then
  $SUDO useradd --system --shell /usr/sbin/nologin --home-dir "$MC_DIR" minecraft
  info "created user 'minecraft'"
fi

step "Replacing $MC_DIR with the backup contents"
$SUDO rm -rf "$MC_DIR"
$SUDO mkdir -p "$MC_DIR"
$SUDO cp -a "$SRC/." "$MC_DIR/"
$SUDO chown -R minecraft:minecraft "$MC_DIR"
info "copied backup into $MC_DIR"

step "Ensuring EULA is accepted"
if ! grep -q '^eula=true' "$MC_DIR/eula.txt" 2>/dev/null; then
  echo 'eula=true' | $SUDO tee "$MC_DIR/eula.txt" >/dev/null
fi

step "Installing systemd unit (purpur.jar, ${MC_RAM_GB} GB)"
$SUDO tee /etc/systemd/system/minecraft.service >/dev/null <<EOF
[Unit]
Description=Minecraft Purpur server (${MC_RAM_GB} GB)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=minecraft
Group=minecraft
WorkingDirectory=${MC_DIR}
ExecStart=${JAVA_BIN} -Xms${MC_RAM_GB}G -Xmx${MC_RAM_GB}G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:UnlockExperimentalVMOptions -XX:+DisableExplicitGC -Dfile.encoding=UTF-8 -jar ${MC_DIR}/purpur.jar nogui
Restart=on-failure
RestartSec=10
LimitNOFILE=65535
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable minecraft.service

step "Starting the restored server"
$SUDO systemctl start minecraft || { warn "start failed - logs:"; $SUDO journalctl -u minecraft -n 30; exit 1; }
sleep 5

PORT="$(grep '^server-port=' "$MC_DIR/server.properties" | cut -d= -f2 || echo 25565)"
ONLINE="$(grep '^online-mode=' "$MC_DIR/server.properties" | cut -d= -f2 || echo true)"
MOTD="$(grep '^motd=' "$MC_DIR/server.properties" | cut -d= -f2- || echo '-')"

step "Done"
info "Server: ${MC_DIR}"
info "Port: ${PORT}   online-mode: ${ONLINE}"
info "MOTD: ${MOTD}"
info "Connect locally: 192.168.1.9:${PORT}"
info "Logs: sudo journalctl -u minecraft -f"

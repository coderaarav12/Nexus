#!/usr/bin/env bash
# Project Nexus - Minecraft Forge server bootstrap (idempotent)
# Installs Java 21, downloads the latest recommended Forge for the given MC
# version, creates a 'minecraft' system user, configures server.properties,
# and installs a systemd unit running with 4 GB of RAM.
#
# Usage:  sudo bash deploy/setup-minecraft.sh
#   env:  MC_VERSION=1.21.1   (default 1.21.1)
#         FORGE_VERSION=      (empty = auto-resolve recommended for MC_VERSION)
#         MC_DIR=/opt/minecraft
#         MC_RAM_GB=4
set -euo pipefail

C_BOLD=$'\033[1m'
C_GREEN=$'\033[0;32m'
C_YELLOW=$'\033[1;33m'
C_RED=$'\033[0;31m'
C_RESET=$'\033[0m'

step() { echo; echo "${C_BOLD}==> $*${C_RESET}"; }
info() { echo "${C_GREEN}[mc]${C_RESET} $*"; }
warn() { echo "${C_YELLOW}[mc]${C_RESET} $*"; }
die()  { echo "${C_RED}[error]${C_RESET} $*" >&2; exit 1; }

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  SUDO="sudo"
  $SUDO -v || die "this script needs root (run with sudo or as root)"
fi
# Run a command as the 'minecraft' user, whether we are root or in sudoers.
run_as_minecraft() {
  if [ "$(id -u)" -eq 0 ]; then
    su -s /bin/bash minecraft -c "$1"
  else
    $SUDO -u minecraft bash -c "$1"
  fi
}

MC_VERSION="${MC_VERSION:-1.21.1}"
FORGE_VERSION="${FORGE_VERSION:-}"
MC_DIR="${MC_DIR:-/opt/minecraft}"
MC_RAM_GB="${MC_RAM_GB:-4}"
DOMAIN="${MC_DOMAIN:-mc.goelaarav.dpdns.org}"
RCON_PORT=25575

step "Configuring Forge ${MC_VERSION} server at ${MC_DIR} (${MC_RAM_GB} GB RAM)"
info "public address: ${DOMAIN}:25565"

step "Installing Java 21"
if ! java -version >/dev/null 2>&1 || ! java -version 2>&1 | grep -q 'version "21'; then
  $SUDO apt-get update -qq
  $SUDO apt-get install -y openjdk-21-jre-headless jq curl
  info "installed openjdk-21-jre-headless"
else
  info "java 21 already present: $(java -version 2>&1 | head -n1)"
fi
JAVA_BIN="$(command -v java)"
info "using java: ${JAVA_BIN}"

step "Creating the 'minecraft' system user"
if id -u minecraft >/dev/null 2>&1; then
  info "user 'minecraft' already exists"
else
  $SUDO useradd --system --shell /usr/sbin/nologin --home-dir "$MC_DIR" minecraft
  info "created system user 'minecraft'"
fi
$SUDO mkdir -p "$MC_DIR"
$SUDO chown -R minecraft:minecraft "$MC_DIR"

step "Resolving Forge installer"
FORGE_PROMO_URL="https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"
if [ -z "$FORGE_VERSION" ]; then
  FORGE_VERSION="$($SUDO curl -fsSL "$FORGE_PROMO_URL" | jq -r --arg mc "$MC_VERSION" '.promos[$mc+"-recommended"] // empty')"
  [ -n "$FORGE_VERSION" ] || die "no recommended Forge for MC ${MC_VERSION} - set FORGE_VERSION explicitly"
fi
INSTALLER_URL="https://maven.minecraftforge.net/net/minecraftforge/forge/${MC_VERSION}-${FORGE_VERSION}/forge-${MC_VERSION}-${FORGE_VERSION}-installer.jar"
info "Forge ${MC_VERSION}-${FORGE_VERSION}"
info "downloading ${INSTALLER_URL}"

step "Installing Forge server"
$SUDO curl -fsSL -o "$MC_DIR/forge-installer.jar" "$INSTALLER_URL"
$SUDO chown minecraft:minecraft "$MC_DIR/forge-installer.jar"
if [ ! -f "$MC_DIR/run.sh" ]; then
  run_as_minecraft "cd '$MC_DIR' && '$JAVA_BIN' -jar forge-installer.jar --installServer >/dev/null"
  info "forge installer ran"
else
  info "forge already installed (run.sh present)"
fi
$SUDO rm -f "$MC_DIR/forge-installer.jar"

step "Accepting EULA"
if [ -f "$MC_DIR/eula.txt" ]; then
  $SUDO sed -i 's/^eula=.*/eula=true/' "$MC_DIR/eula.txt" || true
fi
if ! grep -q '^eula=true' "$MC_DIR/eula.txt" 2>/dev/null; then
  echo 'eula=true' | $SUDO tee "$MC_DIR/eula.txt" >/dev/null
fi

step "Writing server.properties"
RCON_PASS_FILE="$MC_DIR/rcon-password"
if [ ! -f "$RCON_PASS_FILE" ]; then
  RCON_PASS="$(head -c 16 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
  printf '%s' "$RCON_PASS" | $SUDO tee "$RCON_PASS_FILE" >/dev/null
else
  RCON_PASS="$($SUDO cat "$RCON_PASS_FILE")"
fi
$SUDO chown minecraft:minecraft "$RCON_PASS_FILE"
$SUDO chmod 600 "$RCON_PASS_FILE"

$SUDO tee "$MC_DIR/server.properties" >/dev/null <<EOF
# Nexus-managed Minecraft server
server-port=25565
motd=\u00a7bNexus \u00a7fMinecraft \u00a77(${DOMAIN})
level-seed=
online-mode=true
enable-query=false
enable-rcon=true
rcon.port=${RCON_PORT}
rcon.password=${RCON_PASS}
max-players=10
view-distance=10
gamemode=survival
difficulty=normal
spawn-protection=0
enable-command-block=true
white-list=false
EOF
$SUDO chown minecraft:minecraft "$MC_DIR/server.properties"

step "Installing systemd unit (minecraft.service, ${MC_RAM_GB} GB)"
# Recent Forge installers ship a run.sh; fall back to a forge/minecraft jar.
SERVER_JAR="$(ls "$MC_DIR"/forge-*.jar "$MC_DIR"/minecraft_server.*.jar 2>/dev/null | head -n1 || true)"
if [ -f "$MC_DIR/run.sh" ]; then
  LAUNCH="$MC_DIR/run.sh"
elif [ -n "$SERVER_JAR" ]; then
  LAUNCH="$JAVA_BIN -Xms${MC_RAM_GB}G -Xmx${MC_RAM_GB}G -XX:+UseG1GC -XX:+ParallelRefProcEnabled -XX:MaxGCPauseMillis=200 -XX:UnlockExperimentalVMOptions -XX:+DisableExplicitGC -Dfile.encoding=UTF-8 -jar $SERVER_JAR nogui"
else
  warn "could not detect the server jar - run.sh/forge-*.jar not found; edit minecraft.service ExecStart manually"
  LAUNCH="$JAVA_BIN -Xmx${MC_RAM_GB}G -jar ${MC_DIR}/server.jar nogui"
fi
$SUDO tee /etc/systemd/system/minecraft.service >/dev/null <<EOF
[Unit]
Description=Minecraft Forge server (Project Nexus)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=minecraft
Group=minecraft
WorkingDirectory=${MC_DIR}
ExecStart=${LAUNCH}
Restart=on-failure
RestartSec=10
LimitNOFILE=65535
TimeoutStopSec=60

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable minecraft.service
info "minecraft.service installed and enabled (auto-starts on boot)"

step "Firewall: opening 25565/tcp (game) and ${RCON_PORT}/tcp (rcon, LAN only)"
if command -v ufw >/dev/null 2>&1; then
  $SUDO ufw allow 25565/tcp || true
  $SUDO ufw allow from 192.168.1.0/24 to any port ${RCON_PORT} proto tcp || true
  info "ufw updated"
else
  warn "ufw not present; open TCP 25565 (and ${RCON_PORT} to your LAN) manually"
fi

step "Starting Minecraft server (first boot generates world)"
if systemctl is-active --quiet minecraft; then
  info "minecraft already running"
else
  $SUDO systemctl start minecraft || warn "start failed - check: sudo journalctl -u minecraft -n 30"
fi

step "Done"
info "Server dir: ${MC_DIR}"
info "Local connect: 127.0.0.1:25565  or  192.168.1.7:25565"
info "Public connect (after port forward + DNS): ${DOMAIN}:25565"
info "Console logs: sudo journalctl -u minecraft -f"
info "RCON password (used by Nexus status/backup): stored in ${RCON_PASS_FILE}"
warn "Next steps (do once):"
warn "  1. Router: forward TCP 25565 -> 192.168.1.7"
warn "  2. Cloudflare: add a DNS-only (grey cloud) A record for ${DOMAIN} -> your public IP"
warn "     (Minecraft is raw TCP and cannot be proxied by Cloudflare)"

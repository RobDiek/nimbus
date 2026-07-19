#!/usr/bin/env bash
# Nimbus Golden Image Bootstrap — Innerhalb der Ubuntu-VM als root ausführen.
# Siehe vm-image/GOLDEN_IMAGE.md
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

HOSTNAME_SLUG="${NIMBUS_HOSTNAME:-}"
FQDN="${NIMBUS_FQDN:-}"
WORKSPACE="${NIMBUS_WORKSPACE:-/home/workspace}"
AGENT_DIR="${NIMBUS_AGENT_DIR:-/opt/nimbus-agent}"
SPACE_PORT="${NIMBUS_SPACE_PORT:-3000}"
AGENT_PORT="${NIMBUS_AGENT_PORT:-8100}"
INSTALL_DOCKER="${NIMBUS_INSTALL_DOCKER:-1}"
INSTALL_NODE="${NIMBUS_INSTALL_NODE:-1}"

log() { echo "[nimbus-bootstrap] $*"; }

if [[ "$(id -u)" -ne 0 ]]; then
  log "Bitte als root ausführen (sudo bash bootstrap.sh)"
  exec sudo -E bash "$0" "$@"
fi

log "start workspace=$WORKSPACE agent=$AGENT_DIR"

# --- Hostname (optional, wenn vom Orchestrator gesetzt) ---
if [[ -n "$HOSTNAME_SLUG" ]]; then
  hostnamectl set-hostname "$HOSTNAME_SLUG" || true
  echo "$HOSTNAME_SLUG" > /etc/hostname
fi

# --- Basis-Pakete ---
apt-get update -y
apt-get install -y \
  ca-certificates curl wget gnupg lsb-release \
  git jq unzip zip htop tmux ripgrep \
  build-essential pkg-config \
  qemu-guest-agent \
  python3 python3-pip python3-venv python3-dev

# Python 3.12+ sicherstellen (Ubuntu 24.04 hat 3.12; 22.04 ggf. nachrüsten)
PY_VER="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
log "python3 version=$PY_VER"
if python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'; then
  log "Python OK (>= 3.11)"
else
  log "WARNUNG: Python < 3.11 — für Pydantic-AI deadsnakes/Ubuntu 24.04 empfohlen"
fi

# Guest agent für IP-Erkennung
systemctl enable --now qemu-guest-agent || true

# --- Bun ---
if ! command -v bun >/dev/null 2>&1; then
  log "Installiere Bun…"
  curl -fsSL https://bun.sh/install | bash
fi
# Bun systemweit verlinkbar machen
if [[ -x /root/.bun/bin/bun ]]; then
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
elif [[ -x "$HOME/.bun/bin/bun" ]]; then
  ln -sf "$HOME/.bun/bin/bun" /usr/local/bin/bun
fi
export PATH="/usr/local/bin:/root/.bun/bin:${HOME}/.bun/bin:${PATH}"
log "bun=$(command -v bun || echo missing) $(bun --version 2>/dev/null || true)"

# --- Node.js (optional, für Vite/Tooling) ---
if [[ "$INSTALL_NODE" == "1" ]] && ! command -v node >/dev/null 2>&1; then
  log "Installiere Node.js 22.x…"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
log "node=$(command -v node || echo skipped) $(node --version 2>/dev/null || true)"

# --- Docker (optional) ---
if [[ "$INSTALL_DOCKER" == "1" ]] && ! command -v docker >/dev/null 2>&1; then
  log "Installiere Docker…"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker || true
fi

# --- Ordnerstruktur ---
mkdir -p \
  "$WORKSPACE/__substrate/space/routes/api" \
  "$WORKSPACE/__substrate/space/routes/page" \
  "$WORKSPACE/__substrate/space/routes/static" \
  "$WORKSPACE/__substrate/space/public" \
  "$WORKSPACE/skills" \
  "$AGENT_DIR"

# Space-Vorlage kopieren, falls Bootstrap aus dem Repo heraus läuft
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -d "$SCRIPT_DIR/space" ]]; then
  cp -a "$SCRIPT_DIR/space/." "$WORKSPACE/__substrate/space/"
fi
if [[ -d "$SCRIPT_DIR/agent" ]]; then
  cp -a "$SCRIPT_DIR/agent/." "$AGENT_DIR/"
fi

# Placeholder routes.json
if [[ ! -f "$WORKSPACE/__substrate/space/routes.json" ]]; then
  echo '{"version":1,"routes":[]}' > "$WORKSPACE/__substrate/space/routes.json"
fi

# Ownership: falls CI-User existiert
for u in nimbus ubuntu; do
  if id "$u" >/dev/null 2>&1; then
    chown -R "$u:$u" "$WORKSPACE" "$AGENT_DIR" || true
  fi
done

# Agent venv (ohne LLM-Key — nur Deps)
if [[ -f "$AGENT_DIR/requirements.txt" ]]; then
  log "Python venv + requirements…"
  python3 -m venv "$AGENT_DIR/.venv"
  # shellcheck disable=SC1091
  source "$AGENT_DIR/.venv/bin/activate"
  pip install -U pip wheel
  pip install -r "$AGENT_DIR/requirements.txt" || log "WARNUNG: pip install teilweise fehlgeschlagen"
  deactivate || true
fi

# Space deps
if [[ -f "$WORKSPACE/__substrate/space/package.json" ]] && command -v bun >/dev/null 2>&1; then
  log "bun install (space)…"
  (cd "$WORKSPACE/__substrate/space" && bun install) || log "WARNUNG: bun install fehlgeschlagen"
fi

# Ready-Marker
cat > /tmp/nimbus-ready.txt <<EOF
Nimbus Golden Image ready
hostname=${HOSTNAME_SLUG:-$(hostname)}
fqdn=${FQDN:-}
workspace=$WORKSPACE
agent_dir=$AGENT_DIR
space_port=$SPACE_PORT
agent_port=$AGENT_PORT
python=$(python3 --version 2>&1)
bun=$(bun --version 2>&1 || echo none)
node=$(node --version 2>&1 || echo none)
docker=$(docker --version 2>&1 || echo none)
EOF

log "done — siehe /tmp/nimbus-ready.txt"
cat /tmp/nimbus-ready.txt

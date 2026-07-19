#!/usr/bin/env bash
# Nimbus VM Bootstrap — läuft nur über den Control-Plane-Orchestrator (SSH).
# Niemals vom Agenten selbst aufrufen/ändern lassen.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

HOSTNAME_SLUG="${NIMBUS_HOSTNAME:-nimbus}"
FQDN="${NIMBUS_FQDN:-${HOSTNAME_SLUG}.agents.diekerit.com}"
WORKSPACE="${NIMBUS_WORKSPACE:-/home/workspace}"
AGENT_DIR="${NIMBUS_AGENT_DIR:-/opt/nimbus-agent}"
SPACE_PORT="${NIMBUS_SPACE_PORT:-3000}"
AGENT_PORT="${NIMBUS_AGENT_PORT:-8100}"

echo "[nimbus] bootstrap start host=$HOSTNAME_SLUG fqdn=$FQDN"

if command -v hostnamectl >/dev/null 2>&1; then
  sudo hostnamectl set-hostname "$HOSTNAME_SLUG" || true
fi
echo "$HOSTNAME_SLUG" | sudo tee /etc/hostname >/dev/null || true

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y \
    bash-completion git curl wget htop tmux build-essential \
    python3 python3-pip python3-venv \
    ripgrep fd-find unzip zip jq ca-certificates gnupg lsb-release
fi

sudo mkdir -p "$WORKSPACE" "$AGENT_DIR" "$WORKSPACE/__substrate/space"
sudo chown -R "${USER}:${USER}" "$WORKSPACE" "$AGENT_DIR" 2>/dev/null || true

# Bun für Space-Substrat
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
export PATH="$BUN_INSTALL/bin:$PATH"

# Shell-Komfort
touch ~/.bashrc
grep -q "alias ll=" ~/.bashrc || echo "alias ll='ls -la'" >> ~/.bashrc
grep -q 'export PATH=.*\.bun/bin' ~/.bashrc || echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.bashrc

cat > /tmp/nimbus-ready.txt <<EOF
Nimbus VM ready
hostname=$HOSTNAME_SLUG
fqdn=$FQDN
workspace=$WORKSPACE
agent_dir=$AGENT_DIR
space_port=$SPACE_PORT
agent_port=$AGENT_PORT
EOF

echo "[nimbus] bootstrap done"

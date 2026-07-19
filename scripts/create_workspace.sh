#!/usr/bin/env bash
# Nimbus create_workspace — Dispatcher:
#   - Auf Proxmox-Host (qm vorhanden) → scripts/host/create_workspace.sh
#   - Sonst → Bun Control-Plane API (scripts/create_workspace.js)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if command -v qm >/dev/null 2>&1; then
  exec bash "$ROOT/scripts/host/create_workspace.sh" "$@"
fi

export PATH="${HOME}/.bun/bin:${PATH}"
if ! command -v bun >/dev/null 2>&1; then
  echo "Weder 'qm' (Proxmox-Host) noch 'bun' gefunden." >&2
  echo "Auf dem Proxmox-Host: sudo bash scripts/host/create_workspace.sh <slug>" >&2
  exit 1
fi

TENANT="${1:-}"
if [[ -z "$TENANT" ]]; then
  echo "Usage: $0 <tenant-slug>" >&2
  exit 1
fi
exec bun "$ROOT/scripts/create_workspace.js" "$TENANT"

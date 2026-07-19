#!/usr/bin/env bash
# Nimbus: Workspace/VM über Control-Plane CLI anlegen.
# Wrapper um scripts/create_workspace.js
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="${HOME}/.bun/bin:${PATH}"

if ! command -v bun >/dev/null 2>&1; then
  echo "bun nicht gefunden — bitte Bun installieren." >&2
  exit 1
fi

TENANT="${1:-}"
if [[ -z "$TENANT" ]]; then
  echo "Usage: $0 <tenant-slug>" >&2
  echo "Example: $0 robin   # → robin.agents.diekerit.com" >&2
  exit 1
fi

exec bun "$ROOT/scripts/create_workspace.js" "$TENANT"

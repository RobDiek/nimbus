#!/usr/bin/env bash
# Nimbus Phase 1 — Bestandsaufnahme auf dem Proxmox-Host.
# Ausführen als root (oder user mit qm-Rechten) DIREKT auf 45.84.197.121:
#   ./scripts/host/inventory.sh [TEMPLATE_VMID]
set -euo pipefail

TEMPLATE_VMID="${1:-${PROXMOX_TEMPLATE_VMID:-9000}}"

if ! command -v qm >/dev/null 2>&1; then
  echo "FEHLER: 'qm' nicht gefunden. Dieses Skript muss auf dem Proxmox-Host laufen." >&2
  exit 1
fi

echo "=============================================="
echo " Nimbus Proxmox Inventory"
echo " Host: $(hostname -f 2>/dev/null || hostname)"
echo " Time: $(date -Is)"
echo "=============================================="
echo
echo "--- qm list ---"
qm list
echo
echo "--- pvesm status (storage) ---"
pvesm status 2>/dev/null || echo "(pvesm nicht verfügbar)"
echo
echo "--- Template ${TEMPLATE_VMID}: qm config ---"
if qm config "$TEMPLATE_VMID" >/dev/null 2>&1; then
  qm config "$TEMPLATE_VMID"
  echo
  echo "--- Template ${TEMPLATE_VMID}: qm status ---"
  qm status "$TEMPLATE_VMID" || true
else
  echo "WARNUNG: VM/Template ${TEMPLATE_VMID} existiert nicht."
  echo "Suche nach Templates (template: 1 in config)…"
  while read -r vmid name status; do
    [[ "$vmid" =~ ^[0-9]+$ ]] || continue
    if qm config "$vmid" 2>/dev/null | grep -q '^template:'; then
      echo "  gefunden: vmid=$vmid name=$name status=$status"
      qm config "$vmid" | sed 's/^/    /'
      echo
    fi
  done < <(qm list | awk 'NR>1 {print $1,$2,$3}')
fi
echo
echo "--- next free VMID (pvesh) ---"
pvesh get /cluster/nextid 2>/dev/null || echo "(pvesh nextid nicht verfügbar)"
echo
echo "DONE"

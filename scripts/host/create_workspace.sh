#!/usr/bin/env bash
# Nimbus Phase 1 — Workspace-VM auf dem Proxmox-Host (DiekerIT).
#
# Defaults (Host 45.84.197.121):
#   Template 9000 (niemals überschreiben), Storage local, Bridge vmbr1,
#   LAN 10.10.0.0/24 gw 10.10.0.1, CI-User ubuntu, statische IP aus Pool.
#   OpenWRT Portfreigaben optional via OPENWRT_PASS.
#
# Usage:
#   ./scripts/host/create_workspace.sh robin-workspace
#   ./scripts/host/create_workspace.sh robin --ip 10.10.0.201/24
#   OPENWRT_PASS='...' ./scripts/host/create_workspace.sh robin
set -euo pipefail

die() { echo "FEHLER: $*" >&2; exit 1; }
info() { echo "[nimbus] $*"; }

if ! command -v qm >/dev/null 2>&1; then
  die "'qm' nicht gefunden — bitte auf dem Proxmox-Host ausführen."
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

TEMPLATE_VMID="${TEMPLATE_VMID:-${PROXMOX_TEMPLATE_VMID:-9000}}"
STORAGE="${STORAGE:-${PROXMOX_STORAGE:-local}}"
BRIDGE="${BRIDGE:-${PROXMOX_BRIDGE:-vmbr1}}"
VMID_START="${VMID_START:-${PROXMOX_VMID_START:-5000}}"
CORES="${CORES:-${PROXMOX_VM_CORES:-2}}"
MEMORY_MB="${MEMORY_MB:-${PROXMOX_VM_MEMORY_MB:-4096}}"
DISK_GB="${DISK_GB:-${PROXMOX_VM_DISK_GB:-32}}"
CI_USER="${CI_USER:-${PROXMOX_CI_USER:-ubuntu}}"
NAMESERVER="${NAMESERVER:-1.1.1.1}"
SEARCHDOMAIN="${SEARCHDOMAIN:-agents.diekerit.com}"
LAN_GW="${LAN_GW:-10.10.0.1}"
LAN_PREFIX="${LAN_PREFIX:-24}"
LAN_POOL_START="${LAN_POOL_START:-200}"
LAN_POOL_END="${LAN_POOL_END:-249}"
IP_WAIT_TIMEOUT_SEC="${IP_WAIT_TIMEOUT_SEC:-180}"
IP_WAIT_INTERVAL_SEC="${IP_WAIT_INTERVAL_SEC:-4}"
FULL_CLONE="${FULL_CLONE:-1}"
WAN_IP="${OPENWRT_WAN_IP:-45.84.197.154}"

# Default DiekerIT Deploy-Key (kann überschrieben werden)
DEFAULT_DIEKER_PUB='ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3dIaMkaR8OYgz9QIzNxhR4h9zkm98IVQVSem4DTF/q DiekerIT SSH Key'

HOSTNAME_SLUG=""
IP_MODE="auto"   # auto | dhcp | <CIDR>
STATIC_GW="$LAN_GW"
DRY_RUN=0
SKIP_OPENWRT=0

usage() {
  cat <<EOF
Usage: $0 <hostname-slug> [options]

Options:
  --ip auto|dhcp|<CIDR>  Netz (Default: auto = nächste freie 10.10.0.200-249)
  --gw <gateway>         Gateway (Default: 10.10.0.1)
  --vmid <id>            Explizite VMID
  --template <id>        Template (Default: 9000 — wird nur geklont)
  --storage <name>       Storage (Default: local)
  --bridge <name>        Bridge (Default: vmbr1)
  --cores <n>            vCPU (Default: 2)
  --memory <mb>          RAM MB (Default: 4096)
  --disk <gb>            Disk nach Clone resizen (Default: 32)
  --user <name>          Cloud-Init User (Default: ubuntu)
  --ssh-key-file <f>     Public-Key-Datei
  --skip-openwrt         Keine Portfreigaben anlegen
  --dry-run              Nur planen
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --ip) IP_MODE="${2:-}"; shift 2 ;;
    --gw) STATIC_GW="${2:-}"; shift 2 ;;
    --vmid) EXPLICIT_VMID="${2:-}"; shift 2 ;;
    --template) TEMPLATE_VMID="${2:-}"; shift 2 ;;
    --storage) STORAGE="${2:-}"; shift 2 ;;
    --bridge) BRIDGE="${2:-}"; shift 2 ;;
    --cores) CORES="${2:-}"; shift 2 ;;
    --memory) MEMORY_MB="${2:-}"; shift 2 ;;
    --disk) DISK_GB="${2:-}"; shift 2 ;;
    --user) CI_USER="${2:-}"; shift 2 ;;
    --ssh-key-file) SSH_PUBKEY_FILE="${2:-}"; shift 2 ;;
    --skip-openwrt) SKIP_OPENWRT=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "Unbekannte Option: $1" ;;
    *)
      if [[ -z "$HOSTNAME_SLUG" ]]; then HOSTNAME_SLUG="$1"; shift
      else die "Unerwartetes Argument: $1"; fi
      ;;
  esac
done

[[ -n "$HOSTNAME_SLUG" ]] || { usage; die "hostname-slug fehlt"; }

HOSTNAME_SLUG="$(echo "$HOSTNAME_SLUG" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
[[ -n "$HOSTNAME_SLUG" ]] || die "Hostname nach Sanitizing leer"
VM_NAME="$HOSTNAME_SLUG"
FQDN="${HOSTNAME_SLUG}.${SEARCHDOMAIN}"

qm config "$TEMPLATE_VMID" >/dev/null 2>&1 || die "Template ${TEMPLATE_VMID} nicht gefunden (niemals überschreiben — nur klonen)."

# SSH keys → Datei für qm set
SSH_KEY_FILE_TMP="$(mktemp)"
cleanup() { rm -f "$SSH_KEY_FILE_TMP"; }
trap cleanup EXIT

if [[ -n "${SSH_PUBKEY_FILE:-}" ]]; then
  [[ -f "$SSH_PUBKEY_FILE" ]] || die "SSH_PUBKEY_FILE fehlt: $SSH_PUBKEY_FILE"
  cat "$SSH_PUBKEY_FILE" > "$SSH_KEY_FILE_TMP"
elif [[ -n "${SSH_PUBKEY:-}" ]]; then
  printf '%s\n' "$SSH_PUBKEY" > "$SSH_KEY_FILE_TMP"
else
  for cand in "${HOME}/.ssh/id_ed25519.pub" "${HOME}/.ssh/id_rsa.pub" /root/.ssh/id_ed25519.pub; do
    if [[ -f "$cand" ]]; then cat "$cand" > "$SSH_KEY_FILE_TMP"; break; fi
  done
  # Immer DiekerIT-Key sicherstellen
  if ! grep -qF 'AAAAC3NzaC1lZDI1NTE5AAAAIK3dIaMkaR8OYgz9QIzNxhR4h9zkm98IVQVSem4DTF/q' "$SSH_KEY_FILE_TMP" 2>/dev/null; then
    printf '%s\n' "$DEFAULT_DIEKER_PUB" >> "$SSH_KEY_FILE_TMP"
  fi
fi
[[ -s "$SSH_KEY_FILE_TMP" ]] || die "Kein SSH Public Key"

alloc_vmid() {
  if [[ -n "${EXPLICIT_VMID:-}" ]]; then echo "$EXPLICIT_VMID"; return; fi
  if command -v pvesh >/dev/null 2>&1; then
    local next; next="$(pvesh get /cluster/nextid 2>/dev/null || true)"
    if [[ "$next" =~ ^[0-9]+$ ]]; then echo "$next"; return; fi
  fi
  local id="$VMID_START"
  while qm status "$id" >/dev/null 2>&1; do id=$((id + 1)); done
  echo "$id"
}

# Belegte LAN-IPs aus qm configs + ping
used_lan_ips() {
  local id cfg ip
  for id in $(qm list | awk 'NR>1 {print $1}'); do
    cfg="$(qm config "$id" 2>/dev/null || true)"
    ip="$(echo "$cfg" | sed -n 's/^ipconfig0:.*ip=\([0-9.]*\).*/\1/p' | head -1)"
    [[ -n "$ip" ]] && echo "$ip"
  done
}

alloc_lan_ip() {
  local used n cand
  used="$(used_lan_ips | sort -u)"
  for n in $(seq "$LAN_POOL_START" "$LAN_POOL_END"); do
    cand="10.10.0.$n"
    if echo "$used" | grep -qx "$cand"; then continue; fi
    # optional live check
    if ping -c1 -W1 "$cand" >/dev/null 2>&1; then continue; fi
    echo "$cand"
    return
  done
  die "Kein freier LAN-IP im Pool 10.10.0.${LAN_POOL_START}-${LAN_POOL_END}"
}

# IPCONFIG bestimmen
STATIC_HOST=""
if [[ "$IP_MODE" == "dhcp" ]]; then
  IPCONFIG="ip=dhcp"
elif [[ "$IP_MODE" == "auto" ]]; then
  STATIC_HOST="$(alloc_lan_ip)"
  IPCONFIG="ip=${STATIC_HOST}/${LAN_PREFIX},gw=${STATIC_GW}"
else
  # CIDR angegeben
  STATIC_HOST="${IP_MODE%%/*}"
  local_cidr="$IP_MODE"
  if [[ "$local_cidr" != */* ]]; then local_cidr="${local_cidr}/${LAN_PREFIX}"; fi
  IPCONFIG="ip=${local_cidr},gw=${STATIC_GW}"
fi

VMID="$(alloc_vmid)"

info "Plan:"
info "  template=$TEMPLATE_VMID → vmid=$VMID name=$VM_NAME (9000 wird NICHT überschrieben)"
info "  hostname=$HOSTNAME_SLUG fqdn=$FQDN"
info "  bridge=$BRIDGE storage=$STORAGE ipconfig=$IPCONFIG"
info "  user=$CI_USER cores=$CORES memory=${MEMORY_MB}M disk=${DISK_GB}G"
info "  dry_run=$DRY_RUN skip_openwrt=$SKIP_OPENWRT"

if [[ "$DRY_RUN" -eq 1 ]]; then
  info "Dry-Run — keine Änderungen."
  exit 0
fi

info "Cloning…"
CLONE_ARGS=(clone "$TEMPLATE_VMID" "$VMID" --name "$VM_NAME" --full "$FULL_CLONE")
[[ "$FULL_CLONE" == "1" ]] && CLONE_ARGS+=(--storage "$STORAGE")
qm "${CLONE_ARGS[@]}"

info "Resize disk → ${DISK_GB}G…"
qm resize "$VMID" scsi0 "${DISK_GB}G" || info "WARNUNG: resize fehlgeschlagen (ggf. schon größer)"

info "Cloud-Init + vmbr1…"
qm set "$VMID" \
  --name "$VM_NAME" \
  --cores "$CORES" \
  --memory "$MEMORY_MB" \
  --ciuser "$CI_USER" \
  --sshkeys "$SSH_KEY_FILE_TMP" \
  --ipconfig0 "$IPCONFIG" \
  --nameserver "$NAMESERVER" \
  --searchdomain "$SEARCHDOMAIN" \
  --net0 "virtio,bridge=${BRIDGE}" \
  --agent enabled=1 \
  --description "Nimbus workspace ${HOSTNAME_SLUG} (${FQDN}) lan=${STATIC_HOST:-dhcp}"

qm cloudinit update "$VMID" 2>/dev/null || true

info "Starting VM $VMID…"
qm start "$VMID"

wait_for_ip() {
  local expect="$1" deadline=$((SECONDS + IP_WAIT_TIMEOUT_SEC)) ip=""
  while (( SECONDS < deadline )); do
    if [[ -n "$expect" ]]; then
      if ping -c1 -W1 "$expect" >/dev/null 2>&1; then echo "$expect"; return 0; fi
    fi
    ip="$(qm guest cmd "$VMID" network-get-interfaces 2>/dev/null | python3 -c '
import sys,json
try: data=json.load(sys.stdin)
except Exception: sys.exit(0)
if isinstance(data,dict) and "result" in data: data=data["result"]
for iface in data or []:
  for addr in iface.get("ip-addresses") or []:
    a=addr.get("ip-address","")
    if a and not a.startswith("127.") and "." in a and ":" not in a:
      print(a); raise SystemExit
' 2>/dev/null || true)"
    if [[ -n "$ip" ]]; then echo "$ip"; return 0; fi
    sleep "$IP_WAIT_INTERVAL_SEC"
  done
  return 1
}

info "Warte auf LAN-IP…"
VM_IP=""
if VM_IP="$(wait_for_ip "${STATIC_HOST:-}")"; then
  info "VM IP: $VM_IP"
else
  VM_IP="${STATIC_HOST:-}"
  info "WARNUNG: IP nicht verifiziert — angenommen: ${VM_IP:-unbekannt}"
fi

# OpenWRT Portfreigaben
if [[ "$SKIP_OPENWRT" -eq 0 && -n "${OPENWRT_PASS:-}" && -n "$VM_IP" ]]; then
  info "OpenWRT Portfreigaben…"
  OPENWRT_PASS="$OPENWRT_PASS" bash "$SCRIPT_DIR/openwrt_portforward.sh" ensure "$VM_IP" "$HOSTNAME_SLUG" || \
    info "WARNUNG: OpenWRT-Forwards fehlgeschlagen"
elif [[ "$SKIP_OPENWRT" -eq 0 && -z "${OPENWRT_PASS:-}" ]]; then
  info "Hinweis: OPENWRT_PASS nicht gesetzt — Portfreigaben übersprungen"
fi

n_oct=""
if [[ -n "$VM_IP" ]]; then n_oct="$(echo "$VM_IP" | awk -F. '{print $4}')"; fi

cat <<EOF

==============================================
 Nimbus Workspace bereit (Phase 1)
==============================================
  VMID:       $VMID
  Name:       $VM_NAME
  Hostname:   $HOSTNAME_SLUG
  FQDN:       $FQDN
  Bridge:     $BRIDGE
  LAN-IP:     ${VM_IP:-"(unbekannt)"}
  User:       $CI_USER
  SSH (LAN):  ssh ${CI_USER}@${VM_IP:-<IP>}

OpenWRT WAN ${WAN_IP} (Schema 10xxx/11xxx/12xxx + Host-Oktett):
  SSH:   ${WAN_IP}:$((10000 + ${n_oct:-0}))  →  ${VM_IP:-<IP>}:22
  Space: ${WAN_IP}:$((11000 + ${n_oct:-0})) →  ${VM_IP:-<IP>}:3000
  Agent: ${WAN_IP}:$((12000 + ${n_oct:-0})) →  ${VM_IP:-<IP>}:8100

Zoraxy (manuell): ${FQDN} → ${WAN_IP}:$((11000 + ${n_oct:-0}))
==============================================
EOF

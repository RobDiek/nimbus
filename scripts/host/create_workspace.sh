#!/usr/bin/env bash
# Nimbus Phase 1 — Workspace-VM auf dem Proxmox-Host provisionieren.
#
# Läuft DIREKT auf dem Proxmox-Host (qm-CLI). Keine Zoraxy-Automation:
# die ausgegebene IP manuell in Zoraxy eintragen.
#
# Usage:
#   ./scripts/host/create_workspace.sh <hostname-slug> [options]
#
# Beispiele:
#   ./scripts/host/create_workspace.sh robin-workspace
#   ./scripts/host/create_workspace.sh robin --ip dhcp
#   ./scripts/host/create_workspace.sh robin --ip 10.10.10.50/24 --gw 10.10.10.1
#   SSH_PUBKEY_FILE=~/.ssh/id_ed25519.pub ./scripts/host/create_workspace.sh robin
#
# Env-Overrides:
#   TEMPLATE_VMID=9000  STORAGE=local-lvm  BRIDGE=vmbr0
#   VMID_START=5000     CORES=2  MEMORY_MB=4096
#   CI_USER=root        SSH_PUBKEY_FILE=...  SSH_PUBKEY=...
set -euo pipefail

die() { echo "FEHLER: $*" >&2; exit 1; }
info() { echo "[nimbus] $*"; }

if ! command -v qm >/dev/null 2>&1; then
  die "'qm' nicht gefunden — bitte auf dem Proxmox-Host ausführen."
fi

TEMPLATE_VMID="${TEMPLATE_VMID:-${PROXMOX_TEMPLATE_VMID:-9000}}"
STORAGE="${STORAGE:-${PROXMOX_STORAGE:-local-lvm}}"
BRIDGE="${BRIDGE:-${PROXMOX_BRIDGE:-vmbr0}}"
VMID_START="${VMID_START:-${PROXMOX_VMID_START:-5000}}"
CORES="${CORES:-${PROXMOX_VM_CORES:-2}}"
MEMORY_MB="${MEMORY_MB:-${PROXMOX_VM_MEMORY_MB:-4096}}"
CI_USER="${CI_USER:-${PROXMOX_CI_USER:-root}}"
NAMESERVER="${NAMESERVER:-1.1.1.1}"
SEARCHDOMAIN="${SEARCHDOMAIN:-agents.diekerit.com}"
IP_WAIT_TIMEOUT_SEC="${IP_WAIT_TIMEOUT_SEC:-180}"
IP_WAIT_INTERVAL_SEC="${IP_WAIT_INTERVAL_SEC:-4}"
FULL_CLONE="${FULL_CLONE:-1}"

HOSTNAME_SLUG=""
IP_MODE="dhcp"
STATIC_IP=""
STATIC_GW=""
DRY_RUN=0

usage() {
  cat <<EOF
Usage: $0 <hostname-slug> [options]

Options:
  --ip dhcp|<CIDR>     Netzwerk (Default: dhcp). Beispiel: 10.10.10.50/24
  --gw <gateway>       Gateway bei statischer IP
  --vmid <id>          Explizite VMID (sonst nextid / Scan ab VMID_START)
  --template <id>      Template-VMID (Default: 9000)
  --storage <name>     Storage (Default: local-lvm)
  --cores <n>          vCPU (Default: 2)
  --memory <mb>        RAM in MB (Default: 4096)
  --user <name>        Cloud-Init User (Default: root)
  --ssh-key-file <f>   Public-Key-Datei
  --dry-run            Nur planen, nichts ändern
  -h, --help           Hilfe
EOF
}

# --- Args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --ip) IP_MODE="${2:-}"; shift 2 ;;
    --gw) STATIC_GW="${2:-}"; shift 2 ;;
    --vmid) EXPLICIT_VMID="${2:-}"; shift 2 ;;
    --template) TEMPLATE_VMID="${2:-}"; shift 2 ;;
    --storage) STORAGE="${2:-}"; shift 2 ;;
    --cores) CORES="${2:-}"; shift 2 ;;
    --memory) MEMORY_MB="${2:-}"; shift 2 ;;
    --user) CI_USER="${2:-}"; shift 2 ;;
    --ssh-key-file) SSH_PUBKEY_FILE="${2:-}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -*) die "Unbekannte Option: $1" ;;
    *)
      if [[ -z "$HOSTNAME_SLUG" ]]; then HOSTNAME_SLUG="$1"; shift
      else die "Unerwartetes Argument: $1"; fi
      ;;
  esac
done

[[ -n "$HOSTNAME_SLUG" ]] || { usage; die "hostname-slug fehlt"; }

# Hostname: nur DNS-sichere Zeichen
HOSTNAME_SLUG="$(echo "$HOSTNAME_SLUG" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"
[[ -n "$HOSTNAME_SLUG" ]] || die "Hostname nach Sanitizing leer"
# Optional: -workspace Suffix nicht erzwingen, aber erlauben
VM_NAME="$HOSTNAME_SLUG"
FQDN="${HOSTNAME_SLUG}.${SEARCHDOMAIN}"

# IP config
IPCONFIG="ip=dhcp"
if [[ "$IP_MODE" != "dhcp" ]]; then
  STATIC_IP="$IP_MODE"
  [[ -n "$STATIC_GW" ]] || die "Statische IP erfordert --gw"
  IPCONFIG="ip=${STATIC_IP},gw=${STATIC_GW}"
fi

# SSH key
SSH_KEY_CONTENT="${SSH_PUBKEY:-}"
if [[ -z "$SSH_KEY_CONTENT" && -n "${SSH_PUBKEY_FILE:-}" ]]; then
  [[ -f "$SSH_PUBKEY_FILE" ]] || die "SSH_PUBKEY_FILE nicht gefunden: $SSH_PUBKEY_FILE"
  SSH_KEY_CONTENT="$(cat "$SSH_PUBKEY_FILE")"
fi
if [[ -z "$SSH_KEY_CONTENT" ]]; then
  for cand in \
    "${HOME}/.ssh/id_ed25519.pub" \
    "${HOME}/.ssh/id_rsa.pub" \
    "/root/.ssh/id_ed25519.pub" \
    "/root/.ssh/id_rsa.pub"
  do
    if [[ -f "$cand" ]]; then
      SSH_KEY_CONTENT="$(cat "$cand")"
      SSH_PUBKEY_FILE="$cand"
      break
    fi
  done
fi
[[ -n "$SSH_KEY_CONTENT" ]] || die "Kein SSH Public Key. Setze SSH_PUBKEY_FILE oder SSH_PUBKEY."

# Template prüfen
qm config "$TEMPLATE_VMID" >/dev/null 2>&1 || die "Template ${TEMPLATE_VMID} nicht gefunden. Zuerst: scripts/host/inventory.sh"

# Freie VMID
alloc_vmid() {
  if [[ -n "${EXPLICIT_VMID:-}" ]]; then
    echo "$EXPLICIT_VMID"
    return
  fi
  if command -v pvesh >/dev/null 2>&1; then
    local next
    next="$(pvesh get /cluster/nextid 2>/dev/null || true)"
    if [[ "$next" =~ ^[0-9]+$ ]]; then
      echo "$next"
      return
    fi
  fi
  local id="$VMID_START"
  while qm status "$id" >/dev/null 2>&1; do
    id=$((id + 1))
  done
  echo "$id"
}

VMID="$(alloc_vmid)"

info "Plan:"
info "  template=$TEMPLATE_VMID → vmid=$VMID name=$VM_NAME"
info "  hostname=$HOSTNAME_SLUG fqdn=$FQDN"
info "  user=$CI_USER cores=$CORES memory=${MEMORY_MB}M storage=$STORAGE bridge=$BRIDGE"
info "  ipconfig=$IPCONFIG"
info "  ssh_key_from=${SSH_PUBKEY_FILE:-env:SSH_PUBKEY}"
info "  full_clone=$FULL_CLONE dry_run=$DRY_RUN"

if [[ "$DRY_RUN" -eq 1 ]]; then
  info "Dry-Run — keine Änderungen."
  exit 0
fi

# 1) Clone
CLONE_ARGS=(clone "$TEMPLATE_VMID" "$VMID" --name "$VM_NAME" --full "$FULL_CLONE")
# Storage nur setzen wenn full clone (linked clones nutzen Template-Storage)
if [[ "$FULL_CLONE" == "1" ]]; then
  CLONE_ARGS+=(--storage "$STORAGE")
fi
info "Cloning…"
qm "${CLONE_ARGS[@]}"

# 2) Cloud-Init + Ressourcen
# sshkeys erwartet URL-encoded Newlines (%0A) bei qm set
SSH_KEY_ENCODED="$(printf '%s' "$SSH_KEY_CONTENT" | sed 's/$/%0A/' | tr -d '\n')"

info "Configuring cloud-init…"
qm set "$VMID" \
  --name "$VM_NAME" \
  --cores "$CORES" \
  --memory "$MEMORY_MB" \
  --ciuser "$CI_USER" \
  --sshkeys "$SSH_KEY_ENCODED" \
  --ipconfig0 "$IPCONFIG" \
  --nameserver "$NAMESERVER" \
  --searchdomain "$SEARCHDOMAIN" \
  --description "Nimbus workspace ${HOSTNAME_SLUG} (${FQDN})"

# Netz-Bridge sicherstellen (falls Template anderes Bridge hatte — net0 behalten wenn vorhanden)
if ! qm config "$VMID" | grep -q '^net0:'; then
  info "net0 fehlt — setze virtio auf $BRIDGE"
  qm set "$VMID" --net0 "virtio,bridge=${BRIDGE}"
fi

# 3) Start
info "Starting VM $VMID…"
qm start "$VMID"

# 4) Auf IP warten (qemu-guest-agent)
wait_for_ip() {
  local vmid="$1" deadline=$((SECONDS + IP_WAIT_TIMEOUT_SEC))
  local ip=""
  while (( SECONDS < deadline )); do
    # qm guest cmd network-get-interfaces (agent)
    if ip="$(qm guest cmd "$vmid" network-get-interfaces 2>/dev/null \
      | python3 -c '
import sys, json
try:
  data=json.load(sys.stdin)
except Exception:
  data=[]
# pvesh/qm may wrap result
if isinstance(data, dict) and "result" in data:
  data=data["result"]
for iface in data or []:
  for addr in iface.get("ip-addresses") or []:
    a=addr.get("ip-address","")
    t=addr.get("ip-address-type","")
    if t=="ipv4" and a and not a.startswith("127."):
      print(a); raise SystemExit
' 2>/dev/null)"; then
      if [[ -n "$ip" ]]; then
        echo "$ip"
        return 0
      fi
    fi
    # Fallback: agent-get-ipv4 falls vorhanden
    if ip="$(qm agent "$vmid" network-get-interfaces 2>/dev/null \
      | python3 -c '
import sys, json
raw=sys.stdin.read()
try:
  data=json.loads(raw)
except Exception:
  sys.exit(0)
if isinstance(data, dict) and "result" in data:
  data=data["result"]
for iface in data or []:
  for addr in iface.get("ip-addresses") or []:
    a=addr.get("ip-address","")
    if a and not a.startswith("127.") and "." in a and ":" not in a:
      print(a); raise SystemExit
' 2>/dev/null)"; then
      if [[ -n "$ip" ]]; then
        echo "$ip"
        return 0
      fi
    fi
    sleep "$IP_WAIT_INTERVAL_SEC"
  done
  return 1
}

info "Warte auf IPv4 (qemu-guest-agent, timeout ${IP_WAIT_TIMEOUT_SEC}s)…"
VM_IP=""
if VM_IP="$(wait_for_ip "$VMID")"; then
  info "VM IP: $VM_IP"
else
  info "WARNUNG: Keine IP via Guest-Agent. Prüfe: qm guest cmd $VMID network-get-interfaces"
  info "Tipp: qemu-guest-agent muss im Template installiert+aktiviert sein."
fi

cat <<EOF

==============================================
 Nimbus Workspace bereit (Phase 1)
==============================================
  VMID:       $VMID
  Name:       $VM_NAME
  Hostname:   $HOSTNAME_SLUG
  FQDN:       $FQDN
  IP:         ${VM_IP:-"(unbekannt — manuell ermitteln)"}
  User:       $CI_USER
  SSH:        ssh ${CI_USER}@${VM_IP:-<IP>}

Nächster Schritt (manuell in Zoraxy):
  ${FQDN}  →  ${VM_IP:-<IP>}:3000   (Space / Hono)
  Optional:  agent.${FQDN} → ${VM_IP:-<IP>}:8100

Bootstrap Golden Image (falls noch nicht im Template):
  scp -r vm-image/ ${CI_USER}@${VM_IP:-<IP>}:/tmp/nimbus-image
  ssh ${CI_USER}@${VM_IP:-<IP>} 'sudo bash /tmp/nimbus-image/bootstrap.sh'
==============================================
EOF

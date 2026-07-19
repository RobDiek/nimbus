#!/usr/bin/env bash
# Backt aus dem laufenden Golden-Builder (Default 9100) ein eigenes
# Proxmox-Template (Default 9001 = nimbus-golden).
# Template 9000 (ubuntu-cloud-template) bleibt unberührt.
set -euo pipefail

SOURCE_VMID="${SOURCE_VMID:-9100}"
TARGET_VMID="${TARGET_VMID:-9001}"
TARGET_NAME="${TARGET_NAME:-nimbus-golden}"
NODE="${PROXMOX_NODE:-DiekDataCenter1}"
STORAGE="${PROXMOX_STORAGE:-local}"

echo "Bake Golden Template: ${SOURCE_VMID} → ${TARGET_VMID} (${TARGET_NAME})"
echo "Node=${NODE} Storage=${STORAGE}"
echo "HINWEIS: 9000 wird nicht überschrieben."

if [[ -z "${PROXMOX_BASE_URL:-}" || -z "${PROXMOX_TOKEN_ID:-}" || -z "${PROXMOX_TOKEN_SECRET:-}" ]]; then
  echo "PROXMOX_* Env fehlt. Bitte .env laden." >&2
  exit 1
fi

AUTH="Authorization: PVEAPIToken=${PROXMOX_TOKEN_ID}=${PROXMOX_TOKEN_SECRET}"
API="${PROXMOX_BASE_URL%/}"

pve() {
  local method="$1" path="$2"
  shift 2
  curl -sk -X "$method" -H "$AUTH" "$@" "${API}/api2/json${path}"
}

echo "== Prüfe Quelle ${SOURCE_VMID} =="
pve GET "/nodes/${NODE}/qemu/${SOURCE_VMID}/status/current" | head -c 200
echo

EXISTING=$(pve GET "/cluster/resources?type=vm" | bun -e "
const d=JSON.parse(await Bun.stdin.text());
const hit=(d.data||[]).find(v=>Number(v.vmid)===${TARGET_VMID});
console.log(hit ? (hit.template ? 'template' : 'vm') : '');
")

if [[ "$EXISTING" == "template" ]]; then
  echo "Target ${TARGET_VMID} ist bereits ein Template — Abbruch (nichts überschreiben)."
  exit 0
fi
if [[ "$EXISTING" == "vm" ]]; then
  echo "Target ${TARGET_VMID} existiert bereits als VM — bitte andere TARGET_VMID wählen." >&2
  exit 1
fi

echo "== Full-Clone ${SOURCE_VMID} → ${TARGET_VMID} =="
# full=1, storage=local
UPID=$(pve POST "/nodes/${NODE}/qemu/${SOURCE_VMID}/clone" \
  --data-urlencode "newid=${TARGET_VMID}" \
  --data-urlencode "name=${TARGET_NAME}" \
  --data-urlencode "full=1" \
  --data-urlencode "storage=${STORAGE}" \
  --data-urlencode "target=${NODE}" | bun -e 'const d=JSON.parse(await Bun.stdin.text()); console.log(d.data||"")')
echo "clone task: $UPID"

# Wait for clone task
for i in $(seq 1 120); do
  STATUS=$(pve GET "/nodes/${NODE}/tasks/$(python3 -c "import urllib.parse; print(urllib.parse.quote('''$UPID''', safe=''))")/status" | \
    bun -e 'const d=JSON.parse(await Bun.stdin.text()); console.log((d.data&&d.data.status)||"")')
  echo "  clone status=$STATUS ($i)"
  [[ "$STATUS" == "stopped" ]] && break
  sleep 5
done

echo "== Start Clone zur Bereinigung =="
pve POST "/nodes/${NODE}/qemu/${TARGET_VMID}/status/start" >/dev/null || true
sleep 15

# Wait for guest agent
for i in $(seq 1 40); do
  if pve GET "/nodes/${NODE}/qemu/${TARGET_VMID}/agent/network-get-interfaces" >/dev/null 2>&1; then
    echo "  guest-agent ready"
    break
  fi
  sleep 3
done

echo "== Cloud-Init / Machine-ID bereinigen (via guest-agent) =="
# Proxmox guest exec: command as repeated form fields
CLEAN='set -e
export DEBIAN_FRONTEND=noninteractive
cloud-init clean --logs --seed 2>/dev/null || cloud-init clean --logs || true
truncate -s 0 /etc/machine-id 2>/dev/null || true
rm -f /var/lib/dbus/machine-id 2>/dev/null || true
ln -sf /etc/machine-id /var/lib/dbus/machine-id 2>/dev/null || true
rm -f /etc/ssh/ssh_host_* 2>/dev/null || true
hostnamectl set-hostname nimbus-golden || true
echo nimbus-golden > /etc/hostname || true
# Runtime-Logs leeren, Substrate behalten
journalctl --rotate 2>/dev/null || true
journalctl --vacuum-time=1s 2>/dev/null || true
sync
echo CLEAN_OK
'

# Use SSH to PVE + qm guest exec for reliable multi-arg commands
if [[ -n "${SSHPASS_PVE:-}${SSHPASS:-}" ]]; then
  export SSHPASS="${SSHPASS_PVE:-$SSHPASS}"
  sshpass -e ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "root@${PROXMOX_HOST:-45.84.197.121}" \
    "qm guest exec ${TARGET_VMID} -- bash -lc $(printf %q "$CLEAN")"
  echo "== Shutdown =="
  sshpass -e ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no \
    "root@${PROXMOX_HOST:-45.84.197.121}" \
    "qm shutdown ${TARGET_VMID} --timeout 120; for i in \$(seq 1 60); do qm status ${TARGET_VMID} | grep -q stopped && break; sleep 2; done; qm template ${TARGET_VMID}; qm config ${TARGET_VMID} | head -20"
else
  echo "SSHPASS_PVE fehlt — stoppe via API und templaten via API (ohne cloud-clean)."
  pve POST "/nodes/${NODE}/qemu/${TARGET_VMID}/status/shutdown" >/dev/null || \
    pve POST "/nodes/${NODE}/qemu/${TARGET_VMID}/status/stop" >/dev/null
  sleep 30
  pve POST "/nodes/${NODE}/qemu/${TARGET_VMID}/template"
fi

echo "== Fertig: Template ${TARGET_VMID} (${TARGET_NAME}) =="
echo "Setze PROXMOX_TEMPLATE_VMID=${TARGET_VMID} für neue Workspaces."

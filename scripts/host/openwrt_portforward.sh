#!/usr/bin/env bash
# Nimbus — OpenWRT Portforward Helper (VM 107, LAN 10.10.0.0/24)
#
# Ausführen auf dem Proxmox-Host (erreicht OpenWRT via IPv6 LL auf vmbr1)
# oder mit OPENWRT_HOST gesetzt.
#
# Port-Schema (LAN-Host = 10.10.0.N):
#   SSH   public 10000+N  →  N:22
#   Space public 11000+N  →  N:3000
#   Agent public 12000+N  →  N:8100
#
# Usage:
#   OPENWRT_PASS='...' ./scripts/host/openwrt_portforward.sh ensure 10.10.0.200
#   OPENWRT_PASS='...' ./scripts/host/openwrt_portforward.sh list
#   OPENWRT_PASS='...' ./scripts/host/openwrt_portforward.sh remove 10.10.0.200
set -euo pipefail

die() { echo "FEHLER: $*" >&2; exit 1; }
info() { echo "[openwrt-fwd] $*"; }

ACTION="${1:-}"
LAN_IP="${2:-}"
OPENWRT_PASS="${OPENWRT_PASS:-}"
OPENWRT_USER="${OPENWRT_USER:-root}"
# Link-local der OpenWRT-LAN-NIC (net0/vmbr1) — aus Inventory bekannt
OPENWRT_LL="${OPENWRT_LL:-fe80::be24:11ff:fe70:766d%vmbr1}"
OPENWRT_HOST="${OPENWRT_HOST:-}"
WAN_IP="${OPENWRT_WAN_IP:-45.84.197.154}"

[[ -n "$OPENWRT_PASS" ]] || die "OPENWRT_PASS fehlt"
command -v sshpass >/dev/null || die "sshpass fehlt"
command -v ssh >/dev/null || die "ssh fehlt"

ow_ssh() {
  if [[ -n "$OPENWRT_HOST" ]]; then
    SSHPASS="$OPENWRT_PASS" sshpass -e ssh \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o PreferredAuthentications=password -o PubkeyAuthentication=no \
      "${OPENWRT_USER}@${OPENWRT_HOST}" "$@"
  else
    SSHPASS="$OPENWRT_PASS" sshpass -e ssh \
      -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
      -o PreferredAuthentications=password -o PubkeyAuthentication=no \
      "${OPENWRT_USER}@${OPENWRT_LL}" "$@"
  fi
}

last_octet() {
  echo "$1" | awk -F. '{print $4}'
}

ports_for_ip() {
  local ip="$1" n
  n="$(last_octet "$ip")"
  [[ "$n" =~ ^[0-9]+$ ]] || die "Ungültige LAN-IP: $ip"
  SSH_PUB=$((10000 + n))
  SPACE_PUB=$((11000 + n))
  AGENT_PUB=$((12000 + n))
}

ensure_fwd() {
  local name="$1" sport="$2" dip="$3" dport="$4"
  ow_ssh sh -s <<EOF
set -e
name='$name'; sport='$sport'; dip='$dip'; dport='$dport'
idx=0
while uci -q get firewall.@redirect[\$idx] >/dev/null; do
  n=\$(uci -q get firewall.@redirect[\$idx].name || true)
  if [ "\$n" = "\$name" ]; then
    uci delete firewall.@redirect[\$idx]
  else
    idx=\$((idx+1))
  fi
done
uci add firewall redirect >/dev/null
uci set firewall.@redirect[-1].name="\$name"
uci set firewall.@redirect[-1].target='DNAT'
uci set firewall.@redirect[-1].src='wan'
uci set firewall.@redirect[-1].dest='lan'
uci set firewall.@redirect[-1].proto='tcp'
uci set firewall.@redirect[-1].src_dport="\$sport"
uci set firewall.@redirect[-1].dest_ip="\$dip"
uci set firewall.@redirect[-1].dest_port="\$dport"
EOF
}

commit_fw() {
  ow_ssh sh -c 'uci commit firewall; /etc/init.d/firewall reload'
}

list_fwd() {
  ow_ssh sh -c "uci show firewall | grep -E 'redirect|name=|src_dport|dest_ip|dest_port' || true"
}

remove_for_ip() {
  local ip="$1"
  ow_ssh sh -s <<EOF
set -e
ip='$ip'
idx=0
while uci -q get firewall.@redirect[\$idx] >/dev/null; do
  dip=\$(uci -q get firewall.@redirect[\$idx].dest_ip || true)
  if [ "\$dip" = "\$ip" ]; then
    uci delete firewall.@redirect[\$idx]
  else
    idx=\$((idx+1))
  fi
done
uci commit firewall
/etc/init.d/firewall reload
EOF
}

case "$ACTION" in
  list)
    list_fwd
    ;;
  ensure)
    [[ -n "$LAN_IP" ]] || die "Usage: $0 ensure <lan-ip>"
    ports_for_ip "$LAN_IP"
    n="$(last_octet "$LAN_IP")"
    slug="${3:-$n}"
    info "ensure forwards for $LAN_IP (slug=$slug)"
    ensure_fwd "nimbus-${slug}-ssh" "$SSH_PUB" "$LAN_IP" 22
    ensure_fwd "nimbus-${slug}-space" "$SPACE_PUB" "$LAN_IP" 3000
    ensure_fwd "nimbus-${slug}-agent" "$AGENT_PUB" "$LAN_IP" 8100
    commit_fw
    cat <<EOF

Portfreigaben aktiv (WAN ${WAN_IP}):
  SSH:   ${WAN_IP}:${SSH_PUB}  →  ${LAN_IP}:22
  Space: ${WAN_IP}:${SPACE_PUB} →  ${LAN_IP}:3000
  Agent: ${WAN_IP}:${AGENT_PUB} →  ${LAN_IP}:8100
EOF
    ;;
  remove)
    [[ -n "$LAN_IP" ]] || die "Usage: $0 remove <lan-ip>"
    remove_for_ip "$LAN_IP"
    info "entfernt alle Redirects nach $LAN_IP"
    ;;
  *)
    cat <<EOF
Usage:
  OPENWRT_PASS=... $0 list
  OPENWRT_PASS=... $0 ensure <lan-ip> [slug]
  OPENWRT_PASS=... $0 remove <lan-ip>
EOF
    exit 1
    ;;
esac

# Phase 1 Inventory — DiekDataCenter1 (45.84.197.121)

Stand: 2026-07-19 (live geprüft)

## Host

| Item | Wert |
|---|---|
| Hostname | DiekDataCenter1 |
| PVE | pve-manager/9.2.4 |
| Public | 45.84.197.121/24 auf **vmbr0** |
| Intern | **vmbr1** (keine Host-IP, OpenWRT-LAN) |
| Storage | `local` (dir, ~1.8T) — **kein** local-lvm |

## Template 9000 (`ubuntu-cloud-template`)

**Nicht überschrieben.** Nur geklont.

| Feld | Wert |
|---|---|
| template | 1 |
| agent | enabled=1 |
| ciuser | ubuntu |
| cores/memory | 2 / 2048 |
| disk | scsi0 `local:9000/...` **3.5G** raw |
| cloud-init | ide2 vorhanden |
| net0 | virtio, **vmbr0** (Original) |
| ipconfig | (im Template nicht gesetzt) |

Zusätzlich existiert VMID **900** `nimbus-ubuntu-template` (32G, dhcp) — separat, unberührt.

## Netzwerk-Architektur (Soll)

```
Internet → 45.84.197.154 (OpenWRT WAN / eth1 / vmbr0)
        → DNAT Portforwards
        → 10.10.0.0/24 (OpenWRT LAN / br-lan / vmbr1)
        → Nimbus-VMs (net0=vmbr1, statische IP)
```

OpenWRT VM **107**:
- LAN: `10.10.0.1/24`
- WAN: `45.84.197.154/24` gw `45.84.197.1`
- LuCI: `https://45.84.197.154:8443`

## Golden Builder (Klon)

| Item | Wert |
|---|---|
| VMID | **9100** `nimbus-golden-builder` |
| Quelle | Full-Clone von 9000 (+ Resize 32G) |
| Bridge | **vmbr1** |
| IP | **10.10.0.200/24** gw 10.10.0.1 |
| User | ubuntu + DiekerIT SSH-Key |
| Bootstrap | Bun 1.3, Node 22, Python 3.12, Pydantic-AI, Space-Hono |

Portfreigaben (OpenWRT):

| Dienst | WAN | LAN |
|---|---|---|
| SSH | 45.84.197.154:**10200** | 10.10.0.200:22 |
| Space | 45.84.197.154:**11200** | 10.10.0.200:3000 |
| Agent | 45.84.197.154:**12200** | 10.10.0.200:8100 |

Schema allgemein für Host `10.10.0.N`: öffentliche Ports `10000+N` / `11000+N` / `12000+N`.

## Skripte

```bash
# Auf Proxmox-Host
sudo bash scripts/host/inventory.sh 9000
sudo bash scripts/host/create_workspace.sh robin   # auto-IP aus Pool .200-.249, vmbr1
OPENWRT_PASS='…' sudo -E bash scripts/host/create_workspace.sh robin
OPENWRT_PASS='…' bash scripts/host/openwrt_portforward.sh ensure 10.10.0.201 robin
```

Secrets (Proxmox-/OpenWRT-Passwörter) **nicht** committen — nur Env.

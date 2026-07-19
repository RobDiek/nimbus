# Phase 1: VM-Orchestrator & Golden Image

## Bestandsaufnahme (Status)

Live auf `45.84.197.121` geprüft — Details: `docs/PHASE1_INVENTORY.md`.

| Check | Ergebnis |
|---|---|
| Template **9000** | vorhanden (`ubuntu-cloud-template`, ciuser=ubuntu, 3.5G, agent on) |
| Storage | `local` (nicht local-lvm) |
| OpenWRT **107** | LAN `10.10.0.1`, WAN `45.84.197.154` |
| Golden Builder | VMID **9100** auf `vmbr1` / `10.10.0.200` (Klon, 9000 unberührt) |
| Portforwards | 10200/11200/12200 → 9100 |

```bash
sudo bash scripts/host/inventory.sh 9000
```

---

## Vorschlag Orchestrierungs-Skript

**Primär (jetzt):** `scripts/host/create_workspace.sh` — läuft **auf dem Proxmox-Host** via `qm`.

```bash
# Dry-Run
sudo bash scripts/host/create_workspace.sh robin-workspace --dry-run

# Provisionieren (DHCP + SSH-Key aus ~/.ssh/*.pub)
sudo bash scripts/host/create_workspace.sh robin-workspace

# Statische IP
sudo SSH_PUBKEY_FILE=~/.ssh/id_ed25519.pub \
  bash scripts/host/create_workspace.sh robin \
  --ip 10.10.10.50/24 --gw 10.10.10.1
```

Ablauf:

1. Freie VMID (`pvesh get /cluster/nextid` oder Scan ab 5000)
2. `qm clone 9000 <newid> --name <slug> --full 1 --storage local-lvm`
3. `qm set` Cloud-Init: hostname/name, `ciuser`, `sshkeys`, `ipconfig0`, DNS
4. `qm start`
5. Warten auf IPv4 via `qm guest cmd … network-get-interfaces`
6. IP + FQDN ausgeben → **manuell in Zoraxy** eintragen

**Nicht in Phase 1:** automatisches Zoraxy-Routing (bewusst manuell).

**Sekundär (später):** Bun Control-Plane (`src/proxmox.js` + API-Token), wenn der Orchestrator nicht mehr auf dem Host selbst laufen soll.

---

## Golden Image Bootstrap

Dokumentation: `vm-image/GOLDEN_IMAGE.md`  
Skript: `vm-image/bootstrap.sh`

Installiert: Bun, Node (opt.), Python 3.11+/venv, Docker (opt.), qemu-guest-agent,  
Ordner `/home/workspace` + `/home/workspace/__substrate/space` + `/opt/nimbus-agent`.

Empfehlung: Bootstrap **einmal ins Template 9000** backen, dann nur noch klonen.

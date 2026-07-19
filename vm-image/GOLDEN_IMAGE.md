# Nimbus Golden Image — Bootstrap-Definition (Phase 1)

Ziel: Aus dem nackten Ubuntu-Cloud-Image (Template **VMID 9000**) einen
wiederverwendbaren **Agent-Workspace** machen und als **eigenes Template** speichern.

| VMID | Rolle |
|---|---|
| **9000** | `ubuntu-cloud-template` — Basis, **nicht überschreiben** |
| **9100** | `nimbus-golden-builder` — laufender Builder (`vmbr1` / `10.10.0.200`) |
| **9001** | `nimbus-golden` — **Produktions-Template** (Agent + Space gebacken) |

Default für neue Workspaces: `PROXMOX_TEMPLATE_VMID=9001`.

## Empfohlene Reihenfolge

1. Template 9000 prüfen (`scripts/host/inventory.sh`)
2. Template klonen → Builder-VM **9100**
3. Agent/Space bootstrappen und testen
4. Golden Image backen:
   ```bash
   SOURCE_VMID=9100 TARGET_VMID=9001 bash scripts/host/bake_golden_template.sh
   ```
5. Cloud-Init wird im Bake bereinigt; 9001 wird `qm template`

## Pflichtpakete / Runtimes

| Komponente | Zweck | Install |
|---|---|---|
| Python 3.12+ | Agent-Backend (Pydantic-AI) | `apt` / deadsnakes falls nötig |
| `python3-venv`, `pip` | isolierte Agent-Env | `apt` |
| Bun | Space/PaaS (Vite+React+Hono) | `curl https://bun.sh/install` |
| Docker Engine | User-Container in der VM | Docker apt repo |
| qemu-guest-agent | IP-Erkennung für Orchestrator | `apt` + enable |
| Basis-Tools | Ops | `git curl jq ripgrep unzip build-essential` |

## Ordnerstruktur in der VM

```text
/home/workspace/                 # Nutzer-Workspace (Agent schreibt hierhin)
  __substrate/
    space/                       # Vite + React + Tailwind 4 + Hono
      server.js
      pages/*.tsx
      routes.json
      src/
  skills/                        # optionale SKILL.md Workflows
/opt/nimbus-agent/               # Python Agent Core
  SOUL.md
  AGENTS.md
  nimbus_agent/
  requirements.txt
  .venv/
```

## Services (nach Bootstrap)

| Service | Port | Start |
|---|---|---|
| nimbus-space (Vite/React/Hono) | 3000 | systemd `nimbus-space.service` |
| nimbus-agent (Python) | 8100 | systemd `nimbus-agent.service` |

## Cloud-Init-Erwartungen

- Cloud-Init aktiv
- `qemu-guest-agent` installiert und enabled
- Netz: `vmbr1` (LAN hinter OpenWRT)
- SSH für CI-User `ubuntu`
- Keine fest verdrahtete Hostname/Machine-ID im Template (sonst Clone-Kollisionen)

## DNS & Ingress

```text
<slug>.nimbus.diekerit.com        →  WAN-IP (Cloudflare A-Record, auto)
*.nimbus.diekerit.com             →  WAN-IP (Wildcard)
```

Cloudflare-Automapping: `src/cloudflare.js` (Provisioning + `/api/dns/ensure`).
Zoraxy Host→Origin bleibt bewusst manuell.

## Schnellstart Bootstrap

```bash
# Auf der Builder-VM:
sudo bash vm-image/bootstrap.sh

# Optional Agent-Deps vorab:
cd /opt/nimbus-agent && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

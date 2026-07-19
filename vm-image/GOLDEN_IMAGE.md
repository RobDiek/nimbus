# Nimbus Golden Image — Bootstrap-Definition (Phase 1)

Ziel: Aus einem nackten Ubuntu-Cloud-Image (Template **VMID 9000**) einen
wiederverwendbaren **Agent-Workspace** machen.

Das Bootstrap läuft **einmal im Template** (danach erneut als Template
konvertieren) oder beim ersten Boot jeder User-VM via `vm-image/bootstrap.sh`.

## Empfohlene Reihenfolge

1. Template 9000 prüfen (`scripts/host/inventory.sh`)
2. Template klonen → temporäre Builder-VM
3. `bootstrap.sh` als root ausführen
4. Cloud-Init zurücksetzen (`cloud-init clean` o.ä.)
5. VM herunterfahren, erneut als Template (`qm template <id>`) setzen  
   **oder** 9000 in-place bootstrappen und wieder templaten

## Pflichtpakete / Runtimes

| Komponente | Zweck | Install |
|---|---|---|
| Python 3.12+ | Agent-Backend (Pydantic-AI) | `apt` / deadsnakes falls nötig |
| `python3-venv`, `pip` | isolierte Agent-Env | `apt` |
| Bun | Space/PaaS (Hono) | `curl https://bun.sh/install` |
| Node.js 22.x (optional) | Tooling/Vite falls nötig | NodeSource oder `apt` |
| Docker Engine | User-Container in der VM | Docker apt repo |
| qemu-guest-agent | IP-Erkennung für Orchestrator | `apt` + enable |
| Basis-Tools | Ops | `git curl jq ripgrep unzip build-essential` |

## Ordnerstruktur in der VM

```text
/home/workspace/                 # Nutzer-Workspace (Agent schreibt hierhin)
  __substrate/
    space/                       # Hono PaaS (zo.space-Äquivalent)
      server.js
      routes.json
      routes/{api,page,static}/
      public/
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
| nimbus-space (Bun/Hono) | 3000 | systemd `nimbus-space.service` oder nohup |
| nimbus-agent (Python) | 8100 | systemd `nimbus-agent.service` (Phase 2) |

Phase 1 reicht: Pakete + Ordner + guest-agent. Agent/Space-Services können
erst nach dem Deploy der `vm-image/`-Dateien dauerhaft laufen.

## Cloud-Init-Erwartungen an Template 9000

- Cloud-Init aktiv (`ide2`/`scsi` cloudinit drive oder equivalent)
- `qemu-guest-agent` installiert und enabled
- Netz: DHCP auf `vmbr0` (oder dokumentierte Bridge)
- SSH erlaubt für den CI-User (Default im Host-Skript: `root`)
- Keine fest verdrahtete Hostname/Machine-ID (sonst Clone-Kollisionen)

## Manuelles Routing (Zoraxy) — bewusst nicht automatisiert

Nach `create_workspace.sh`:

```text
<slug>.agents.diekerit.com        →  <VM-IP>:3000
*.<slug>.agents.diekerit.com      →  <VM-IP>:3000   (optional, Wildcard)
```

Cloudflare Wildcard zeigt auf die Public IP; Zoraxy terminiert TLS und
routet intern.

## Schnellstart Bootstrap

```bash
# Auf der (Template-)VM:
sudo bash vm-image/bootstrap.sh

# Optional Agent-Deps vorab:
cd /opt/nimbus-agent && python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

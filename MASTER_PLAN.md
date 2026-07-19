# MASTER PLAN: Nimbus Agent-Platform (zo.computer-Klon)

Stand: 2026-07-19  
Produktname: **Nimbus** (intern auch „DiekerHost“)

## 1. Projekt-Vision

Nimbus ist ein „Intelligent Personal Server“ nach dem Architektur-Modell von
`zo.computer`: Cloud-IDE-Backend, dynamisches PaaS-Hosting und tief integriertes
AI-Agent-Framework.

Statt MicroVMs: **dedizierte Proxmox-VMs pro Mandant**, damit Code-Ausführung
mit Root-Rechten sicher gekapselt bleibt.

## 2. Infrastruktur & Tech-Stack

| Schicht | Technologie |
|---|---|
| Hypervisor | Proxmox VE (`PROXMOX_BASE_URL`, Default-Host `45.84.197.121`) |
| DNS | Cloudflare (`*.agents.diekerit.com`) |
| Ingress | Zoraxy Reverse Proxy (Wildcard-SSL + dynamische Routes) |
| VM-Template | Ubuntu Golden Image, Cloud-Init, Template-VMID **9000** |
| Control Plane | Bun (`src/`), Proxmox-/Zoraxy-Orchestrierung |
| Agent Core (in der VM) | Python + Pydantic-AI (`vm-image/agent/`) |
| PaaS / Space (in der VM) | Bun + Hono (`vm-image/space/`) |

## 3. Architektur-Phasen

### Phase 1 — Control Plane & Provisioning
- Template 9000 klonen, Cloud-Init (Hostname/User/Netz), Boot, IP ermitteln
- CLI: `scripts/create_workspace.sh` / `scripts/create_workspace.js`
- Orchestrator darf **niemals** als Agent-Tool exponiert werden

### Phase 2 — Agent-Backend & Core Tools (in der VM)
- Python-Service mit System-Prompt (`SOUL.md` / `AGENTS.md`)
- Kern-Tools: `bash`, `read_file`, `write_file`, `list_directory`, `agent_browser`

### Phase 3 — Dynamisches PaaS (`zo.space`-Äquivalent)
- Bootstrap `/__substrate/space` mit Hono
- Tools: `write_space_route`, `edit_space_route`, `list_space_routes`
- Dynamisches Routing von Workspace-Assets, API-Routen und Pages

### Phase 4 — Ingress & Netzwerk
- DNS: Cloudflare Wildcard `*.agents.diekerit.com` → Public IP
- **Phase 1:** Zoraxy-Routing **manuell** (Orchestrator gibt nur IP/FQDN aus)
- Später optional: Zoraxy-API-Automation (`src/zoraxy.js`)

## 4. Design-Prinzipien

1. **Extreme Concision** — knappe, operative Antworten
2. **Verification over guessing** — Zustand per `bash`/`read_file`/`curl` prüfen
3. **Keine Fake-Umgebungen** — Agent läuft als Root in der User-VM
4. **Sicherheitsgrenze** — KI nur innerhalb der geklonten User-VM; Control Plane
   (Proxmox/Zoraxy/Orchestrator) ist für den Agenten tabu

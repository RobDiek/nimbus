# CLAUDE.md

Leitfaden für Claude Code (und andere Agenten) bei der Arbeit an **Nimbus**.

## Was Nimbus ist

Nimbus ist ein **persönlicher KI-Computer in der Cloud** — ein zo.computer-Klon.
Kein reiner Chatbot, sondern ein Server mit eingebautem Agenten, der echtes
Terminal, Dateisystem, langlebige Services, Scheduler, Web-Zugriff, Memory und
Personas steuert. Der Agent *handelt* (führt Befehle aus, schreibt Dateien,
deployt), statt nur zu antworten.

Architektur-Ziel (siehe `MASTER_PLAN.md`): dedizierte **Proxmox-VMs pro Mandant**,
in-VM Agent (Python/Pydantic-AI), dynamisches PaaS (`__substrate/space`) und
Zoraxy-Ingress unter `*.agents.diekerit.com`.

## Tech-Stack

- **Control Plane:** Bun (kein Node) — `Bun.serve`, `Bun.spawn`, `bun:sqlite`
- **Control Plane Dependencies:** bewusst dependency-frei
- **Frontend:** Vanilla JS + handgeschriebenes CSS (kein Framework, kein Build-Step)
- **DB:** SQLite (`data/nimbus.db`, WAL-Modus)
- **LLM (Control Plane):** Anthropic/OpenAI/Google/Custom, BYOK
- **Hypervisor:** Proxmox VE (Template-VMID Default **9000**)
- **Ingress:** Zoraxy → `\<tenant\>.agents.diekerit.com`
- **In-VM Agent:** Python + Pydantic-AI (`vm-image/agent/`)
- **In-VM Space:** Bun + Hono (`vm-image/space/`)

## Projektstruktur

```
src/
  server.js           Bun.serve: REST-API, SSE-Chat, WebSocket-Terminal, Space/Ingress
  agent.js            Agent-Loop (Control Plane)
  tools.js            TOOL_DEFS + executeTool (inkl. Space-Routen)
  proxmox.js          Proxmox API: clone, cloud-init, bootstrap, agent-deploy
  vm-orchestrator.js  Provisioning-Pipeline (Phase 1–4)
  zoraxy.js           Ingress-Adapter (HTTP-API oder Config-Dir)
  space.js            Space-Routen im Workspace / Deploy auf VM
  services.js         User-Services
  scheduler.js        Cron-Matcher
  db.js               SQLite-Schema
vm-image/
  bootstrap.sh        VM-Erstinstallation (nur Orchestrator)
  agent/              Python Agent Core (in der VM)
  space/              Hono PaaS-Substrat (in der VM)
scripts/
  create_workspace.sh|.js   CLI zum Provisionieren
public/               Landing + App-Konsole
MASTER_PLAN.md        Architektur-Roadmap
```

## Starten

```bash
bun run src/server.js      # Produktion
bun run dev                # mit Auto-Reload (--watch)
```

Läuft auf http://localhost:4000 — `/` Landing, `/app` Konsole.
Port über `PORT`-Env änderbar.

Workspace provisionieren (Proxmox):

```bash
PROXMOX_ENABLED=true bun scripts/create_workspace.js <tenant-slug>
```

## Architektur-Konventionen

- **Alle Server-Routen** stehen im `routes`-Objekt in `src/server.js`, gekeyed als
  `"METHOD /pfad"`. Async-Handler müssen `await`en (sonst wird eine Promise serialisiert).
- **Neue Agent-Tools** brauchen zwei Dinge: einen Eintrag in `TOOL_DEFS` (Schema)
  **und** einen `case` im `executeTool`-Switch in `src/tools.js`.
- **Chat läuft über SSE** (`POST /api/chat`), nicht über JSON. Events: `session`,
  `text`, `tool_use`, `tool_result`, `error`, `end`.
- **Terminal ist eine echte persistente Bash-Session** pro WebSocket (`/ws/term`),
  kein One-Shot. Zustand (cwd, Env-Vars) bleibt über Befehle erhalten.
- **Persona + Memory** werden in `buildSystem()` in den System-Prompt injiziert.

## Sicherheitsgrenzen (bewusst gesetzt)

- `run_command` hat vollen Shell-Zugriff (persönlicher Server, wie beim Original).
  Nur mit eigenem Key und auf eigener Maschine betreiben.
- `delete_path` ist auf den Workspace beschränkt (`src/tools.js`, Pfad-Check).
- Der API-Key wird **nur** an die LLM-API gesendet, sonst nirgends.
- **Orchestrator / Proxmox / Zoraxy sind KEINE Agent-Tools.** Die KI darf die
  Control Plane nicht manipulieren — alles bleibt in der geklonten User-VM.

## Beim Arbeiten beachten

- Sprache im Code/UI: **Deutsch** (Kommentare, Labels, Meldungen).
- Keine Emojis in der App-UI — stattdessen das SVG-Icon-Sprite in `app.html`
  (`<symbol id="i-…">`, referenziert via `icon("name")` in `js/app.js`).
- Kein Build-Step: Änderungen an `public/` wirken sofort nach Reload.
- `data/` und `workspace/` sind git-ignoriert (Laufzeit-Zustand).
- Produktname bleibt **Nimbus** (auch wenn intern „DiekerHost“ genannt).

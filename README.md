# ☁️ Nimbus

Nimbus is a personal AI computer in the cloud: not just a chatbot, but a Bun-powered server with an integrated agent that can use terminal commands, files, web tools, persistent memory, scheduled tasks, services, and a browser-style UI.

This project includes:

- A landing page (`/`)
- A full app console (`/app`)
- REST APIs
- Streaming chat via SSE
- Persistent terminal via WebSocket
- SQLite-backed persistence (tenant-scoped settings, chats/runs/events, memory, tasks/runs, personas, services)

---

## Table of Contents

- [Features](#features)
- [Tech Stack](#tech-stack)
- [Project Structure](#project-structure)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Run the Project](#run-the-project)
- [Initial Setup (BYOK)](#initial-setup-byok)
- [Usage Guide](#usage-guide)
- [API Overview](#api-overview)
- [Data & Persistence](#data--persistence)
- [Multi-Tenant Notes](#multi-tenant-notes)
- [Troubleshooting](#troubleshooting)
- [Security Notes](#security-notes)
- [License](#license)

---

## Features

### Agent Capabilities (Tooling)

The AI agent can use these tools:

- `run_command` – run bash commands
- `read_file`, `write_file`, `list_files`, `delete_path` – filesystem operations
- `web_search`, `web_fetch` – web search and page text extraction
- `remember`, `search_memory` – persistent memory storage/search
- `schedule_task`, `list_tasks`, `delete_task` – cron-like automations
- `start_service`, `stop_service`, `list_services`, `service_logs` – background service management
- `write_file_base64` – binary-sicherer Upload-/Datei-Write-Pfad
- `list_skills`, `scan_skills` – SKILL.md registry with scopes/rules
- `browser_open`, `browser_click`, `browser_submit`, `browser_screenshot` – persistent browser sessions
- `list_oauth_integrations`, `start_oauth_integration` – OAuth provider discovery/start
- `deploy_hosting`, `hosting_healthcheck`, `hosting_rollback`, `list_hosting_deployments` – versioned hosting supervisor
- `list_directory` – alias for `list_files` (zo parity)
- `write_space_route`, `edit_space_route`, `list_space_routes`, `delete_space_route` – dynamic PaaS / Space routes

### App Sections

In `/app` you get:

- **Start**: chat interface with SSE streaming and tool-call visibility
- **Mein Nimbus Space**: provider/key settings, model selection, memory management
- **Dateien**: file browser + editor + upload
- **Automatisierungen**: scheduled task management
- **Integrationen**: OAuth provider state, auth URL generation, callback/token persistence, manual token path
- **Fähigkeiten**: SKILL.md import/create/scan with scopes/rules plus personas
- **Browser**: persistent sessions with navigation, link clicks, form submit and text screenshot
- **Hosting**: service deployments with public/HTTPS URL metadata, healthchecks and rollback history
- **Terminal**: persistent bash session over WebSocket

---

## Tech Stack

- **Runtime**: [Bun](https://bun.sh)
- **Database**: `bun:sqlite` (SQLite file in `data/nimbus.db`)
- **Frontend**: Vanilla HTML/CSS/JS
- **Server**: Bun `Bun.serve` + REST + SSE + WebSocket
- **Dependencies**: no external npm dependencies currently required

## Architecture Notes

- `src/server.js` handles HTTP routing, SSE chat, static file serving, and WebSocket terminal upgrades.
- `src/agent.js` provides multi-provider orchestration and tool-call execution loop.
- `src/tools.js` contains tool implementations and centralized dispatching.
- `src/tenancy/router.js` resolves tenant context from host and prepares tenant workspace.
- `src/logger.js` provides lightweight structured logging across server/tool execution.
- `src/config.js` centralizes runtime defaults (port, timeouts, max turns).
- `src/scheduler.js` provides tenant-aware scheduling, manual task runs and persisted run history.
- `src/db.js` migrates legacy settings to the composite `(tenant_id, key)` primary key and maintains chat search/run indexes.

## Runtime Configuration

Primary runtime options:

- `PORT` (default: `4000`)
- `HTTP_TIMEOUT_MS` (default: `30000`)
- `TOOL_TIMEOUT_MS` (default: `120000`)
- `ANTHROPIC_API_KEY`
- `OPENAI_API_KEY`
- `GEMINI_API_KEY`
- `CUSTOM_LLM_API_KEY`
- `CUSTOM_LLM_BASE_URL`
- `OPENROUTER_API_KEY`

Provider/model preferences are persisted in settings (`/api/settings`) and can fallback to env vars.

Proxmox / Ingress options (see `MASTER_PLAN.md`):

- `PROXMOX_ENABLED=true|false`
- `PROXMOX_BASE_URL` (default: `https://45.84.197.121:8006`)
- `PROXMOX_TOKEN_ID` (e.g. `nimbus@pve!api-token`)
- `PROXMOX_TOKEN_SECRET`
- `PROXMOX_NODE`
- `PROXMOX_STORAGE` (default: `local-lvm`)
- `PROXMOX_BRIDGE` (default: `vmbr0`)
- `PROXMOX_TEMPLATE_VMID` (default: `9000` — Ubuntu Golden Image)
- `PROXMOX_VMID_START` (default: `5000`)
- `PROXMOX_VM_CORES` (default: `2`)
- `PROXMOX_VM_MEMORY_MB` (default: `4096`)
- `PROXMOX_VM_DISK_GB` (default: `32`)
- `PROXMOX_CI_USER` (default: `nimbus`)
- `PROXMOX_CI_SSH_PUBLIC_KEY`
- `PROXMOX_CI_PASSWORD`
- `PROXMOX_IPCONFIG` (default: `ip=dhcp`)
- `PROXMOX_NAMESERVER` (default: `1.1.1.1`)
- `PROXMOX_SEARCHDOMAIN` (default: `agents.diekerit.com`)
- `PROXMOX_SSH_CONNECT_TIMEOUT_SEC` (default: `5`)
- `NIMBUS_BASE_DOMAIN` (default: `agents.diekerit.com`)
- `NIMBUS_SPACE_PORT` (default: `3000`)
- `NIMBUS_AGENT_PORT` (default: `8100`)
- `ZORAXY_ENABLED=true|false`
- `ZORAXY_BASE_URL` / `ZORAXY_API_TOKEN` or `ZORAXY_USERNAME`/`ZORAXY_PASSWORD`
- `ZORAXY_CONFIG_DIR` (optional: write `.config` files instead of HTTP API)

Provision a tenant VM from CLI:

```bash
PROXMOX_ENABLED=true bun scripts/create_workspace.js robin
# → robin.agents.diekerit.com
```

---

## Project Structure

```text
nimbus/
  public/                 # Landing + app console
  src/
    server.js             # HTTP, SSE chat, WS terminal, Space/Ingress APIs
    agent.js              # Control-plane agent loop
    tools.js              # Tools incl. Space routes
    proxmox.js            # Proxmox clone/cloud-init/bootstrap
    vm-orchestrator.js    # Provision pipeline (VM → agent → space → ingress)
    zoraxy.js             # Zoraxy ingress adapter
    space.js              # Dynamic PaaS route management
    db.js / scheduler.js / services.js / tenancy/
  vm-image/
    bootstrap.sh          # In-VM first boot (orchestrator only)
    agent/                # Python + Pydantic-AI agent core
    space/                # Bun + Hono PaaS substrate
  scripts/
    create_workspace.sh   # CLI wrapper
    create_workspace.js   # Provision tenant VM
  MASTER_PLAN.md          # Architecture roadmap
  data/                   # SQLite (gitignored)
  workspace/              # Agent workspaces (gitignored)
```

---

## Prerequisites

- **Bun** installed (recommended latest stable)
- macOS/Linux environment recommended for shell tooling
- Internet access for LLM API calls and web tools
- At least one API key for your chosen LLM provider

> Nimbus runs with no key, but chat agent responses requiring a provider won’t work until BYOK is configured.

---

## Installation

From project root:

```bash
bun install
```

Even with no declared dependencies, this keeps standard Bun workflow consistent.

---

## Run the Project

### Development (watch mode)

```bash
bun run dev
```

### Start (normal mode)

```bash
bun run src/server.js
```

or

```bash
bun run start
```

Default URL:

- Landing: `http://localhost:4000/`
- App: `http://localhost:4000/app`

Optional environment variable:

```bash
PORT=4010 bun run src/server.js
```

---

## Initial Setup (BYOK)

1. Open `http://localhost:4000/app`
2. Go to **Mein Nimbus Space**
3. Select provider and enter key/base URL as needed
4. Save settings

### Supported Providers (current implementation)

- Anthropic
- OpenAI
- Google Gemini (OpenAI-compatible endpoint mode)
- Custom OpenAI-compatible provider
- OpenRouter (supported in backend logic)

Settings are stored in SQLite and can also be sourced from environment variables (fallbacks exist in backend logic).

---

## Usage Guide

### 1) Chat & Agent Actions

- Open **Start**
- Ask Nimbus to perform tasks in natural language
- Watch streamed text/tool events
- Tool calls appear in the UI with payload/result snippets

### 2) Files

- Open **Dateien**
- Browse workspace folders
- Open, edit, and save files
- Upload files using multipart upload controls

### 3) Terminal

- Open **Terminal**
- Uses VM-backed execution when tenant VM is available and ready
- Falls back to local persistent bash process if VM integration is not configured/ready
- Command history is maintained client-side in the terminal panel

### 4) Hosting / Services

- Open **Hosting**
- Start long-running processes (e.g., local API or static server)
- View logs and stop/remove services from UI

### 5) Automations

- Open **Automatisierungen**
- Create tasks with cron syntax (`min hour day month weekday`)
- Scheduler executes prompts in background via agent loop

### 6) Personas

- Open **Fähigkeiten**
- Create/edit personas with:
  - Name
  - Optional model override
  - System prompt

---

## API Overview

High-level endpoints in `src/server.js` include:

- Status/settings:
  - `GET /api/status`
  - `GET /api/sysinfo`
  - `GET /api/settings`
  - `POST /api/settings`
- Chat:
  - `POST /api/chat` (SSE stream response)
- Sessions/messages:
  - `GET /api/sessions`
  - `POST /api/sessions/delete`
  - `GET /api/messages?session_id=...`
- Personas:
  - `GET /api/personas`
  - `POST /api/personas`
  - `POST /api/personas/delete`
- Memories:
  - `GET /api/memories`
  - `POST /api/memories`
  - `POST /api/memories/delete`
- Tasks:
  - `GET /api/tasks`
  - `POST /api/tasks`
  - `POST /api/tasks/toggle`
  - `POST /api/tasks/delete`
  - `POST /api/tasks/run`
  - `GET /api/task-runs?task_id=...`
- Chats:
  - `GET /api/chats?q=...&archived=false`
  - `GET /api/chats/:id`
  - `PATCH /api/chats/:id`
  - `DELETE /api/chats/:id`
  - `POST /api/chats/:id/share`
  - `POST /api/chats/:id/share/revoke`
  - `GET /api/share/:token` (read-only)
- Services:
  - `GET /api/services`
  - `POST /api/services/start`
  - `POST /api/services/stop`
  - `POST /api/services/remove`
  - `GET /api/services/logs?name=...`
- Skills:
  - `GET /api/skills`
  - `POST /api/skills/scan`
  - `POST /api/skills`
  - `POST /api/skills/toggle`
  - `POST /api/skills/run`
- Browser:
  - `GET /api/browser/sessions`
  - `POST /api/browser/session`
  - `GET /api/browser/session?id=...`
  - `POST /api/browser/open`
  - `POST /api/browser/click`
  - `POST /api/browser/submit`
  - `POST /api/browser/screenshot`
- OAuth:
  - `GET /api/oauth/providers`
  - `POST /api/oauth/start`
  - `GET /api/oauth/callback`
  - `POST /api/oauth/token`
  - `POST /api/oauth/disconnect`
- Hosting supervisor:
  - `GET /api/hosting/deployments`
  - `GET /api/hosting/latest?name=...`
  - `POST /api/hosting/deploy`
  - `POST /api/hosting/health`
  - `POST /api/hosting/rollback`
- Files:
  - `GET /api/files?path=...`
  - `GET /api/file?path=...`
  - `POST /api/file`
  - `POST /api/upload`
- Web tools:
  - `GET /api/webfetch?url=...`
- Terminal fallback:
  - `POST /api/exec`
- VM lifecycle:
  - `GET /api/vm/status`
  - `POST /api/vm/create`
  - `POST /api/vm/start`
  - `POST /api/vm/stop`
- WebSocket terminal:
  - `/ws/term` (VM-backed when ready, local fallback otherwise)

---

## Data & Persistence

Auto-created directories/files:

- `data/nimbus.db` – SQLite DB
- `workspace/` – working directory for tools/terminal defaults

Persisted entities include:

- settings
- chats/chat_runs/chat_events (legacy sessions/messages remain compatible)
- task_runs
- memories
- tasks
- personas
- services
- vm_instances (tenant VM lifecycle + metadata)

---

## Multi-Tenant Notes

The current backend includes tenant-aware schema and helpers (e.g., `tenant_id`, tenant context resolver). Some parts are tenant-scoped, while other parts still include backward-compatible/global behavior.

If extending tenancy, review:

- `src/tenancy/router.js`
- `src/db.js`
- `src/server.js`
- `src/tools.js`
- `src/services.js` / scheduler behavior

---

## Testing (Critical Path)

Run server:

```bash
bun run dev
```

Example critical API checks with curl:

```bash
curl -s http://localhost:4000/api/status
curl -s http://localhost:4000/api/settings
curl -s "http://localhost:4000/api/files?path=."
curl -s -X POST http://localhost:4000/api/chat \
  -H "content-type: application/json" \
  -d '{"message":"ping"}'
```

Frontend smoke checks:

- Open `/app`
- Verify provider/settings can be loaded and saved
- Send one chat message and observe streaming/tool rendering
- Open file browser and read/write one file
- Open terminal tab and verify websocket connects

## Proxmox VM Integration

Nimbus can provision and control one VM per tenant using Proxmox.

### Flow

1. Tenant calls `POST /api/vm/create`
2. Nimbus clones from configured template VM
3. Nimbus applies cloud-init settings (user/password/ssh/network)
4. Nimbus starts VM and waits for running state
5. Nimbus stores VM metadata in `vm_instances`
6. Terminal websocket (`/ws/term`) uses VM SSH execution when VM is ready

### Required template prerequisites

- Template must be a Proxmox QEMU VM template
- Cloud-init support is strongly recommended
- Guest agent is recommended for reliable IP discovery

### Security guidance

- Do not commit Proxmox credentials
- Use environment variables only
- Rotate tokens/passwords regularly
- Use least-privilege API token where possible

## Troubleshooting

### Port already in use

Set another port:

```bash
PORT=4010 bun run dev
```

### “No API key” / provider errors

- Verify provider/key in **Mein Nimbus Space**
- Confirm key format and permissions
- Check fallback env vars if used

### Chat not streaming

- Inspect browser devtools network for `/api/chat`
- Check server logs for provider API errors

### Terminal not connecting

- Ensure WebSocket path `/ws/term` is reachable
- Confirm no reverse proxy/websocket misconfiguration

### File operations failing

- Validate path input in file browser/editor
- Ensure workspace and permissions are available on host system

---

## Security Notes

- `run_command` executes shell commands and can access system resources.
- `delete_path` includes workspace safety checks.
- API keys are sensitive; keep deployment private and secure.
- Use network/firewall controls when exposing Nimbus beyond localhost.

---

## License

MIT — see [LICENSE](./LICENSE).

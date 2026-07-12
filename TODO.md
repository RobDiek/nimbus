- [x] P0: Harden tenant auth context contract in `src/tenancy/router.js` (identity/session placeholder + strict context shape)
- [x] P0: Enforce tenant-scoped CRUD in `src/server.js` for sessions/messages/personas/memories/tasks/services
- [x] P0: Pass `tenantContext` to all tool-execution routes in `src/server.js` (`/api/exec`, `/api/files`, `/api/file`, `/api/webfetch`)
- [x] P0: Refactor `src/services.js` to tenant-aware runtime/process map and tenant-scoped SQL operations
- [x] P0: Add robust personas tenant-scoping + migration/index hardening in `src/db.js`
- [ ] P0: Verify cross-tenant isolation paths (read/write/delete + service name collision checks)
- [ ] Post-P0 backlog: Chat parity features (search/filter/archive/share/run-observability/multi-device+API)
- [ ] Post-P0 backlog: Skill-system architecture completion (`SKILL.md`, progressive loading, UI mgmt, audit/scopes/versioning)

## Active: Chat-Plattform Ausbau
- [x] A1: Schema in `src/db.js` erweitern (`chats`, `chat_runs`, `chat_events`, `chat_shares`) inkl. Indizes
- [x] A2: Legacy-Migration `sessions/messages` -> neues Chat-Modell (idempotent)
- [x] A3: Suche vorbereiten (FTS5 best-effort + Fallback `chat_search`)
- [x] A4: Backend-Routen in `src/server.js` ergänzen (`GET /api/chats`, `GET/PATCH/DELETE /api/chats/:id`, Share create/revoke, share read-only)
- [x] A5: `POST /api/chat` auf chat_runs/chat_events umstellen (SSE-Event-Persistenz)
- [x] A6: Öffentlichen auth-geschützten `/v1/zo/ask`-ähnlichen Endpoint ergänzen (stream/json + schema-mode)
- [ ] A7: Frontend in `public/js/app.js` auf neue Chat-APIs umstellen (debounced search, details, timeline, rename/archive/delete/share)
- [ ] A8: Optionales UI-Markup in `public/app.html` ergänzen falls nötig
- [ ] A9: Smoke-Validation der Akzeptanzkriterien (tenant-safe search, reload/continue, timeline, share 404/410, SSE/JSON parity)

## P1: große Paritätslücken
- [x] P1.1 Dateien/Upload: Binary-safe Upload ohne UTF-8-Korruption (`src/server.js`, `src/tools.js`)
- [ ] P1.2 Scheduler-Reliability: Run-Historie + Lock/Idempotenz + Retry-Metadaten (`src/db.js`, `src/scheduler.js`)
- [ ] P1.3 Hosting-Foundation: Service-Definitionen (port/mode/health/env/public/private/resource hints) (`src/db.js`, `src/services.js`, `src/server.js`)
- [ ] P1.4 Integrationen-Foundation: OAuth/Token-Speicher + Connector-Metadaten (`src/db.js`, `src/server.js`)
- [ ] P1.5 Browser-Automation-Bridge: vorbereitende API/Tool-Fläche statt nur webfetch (scaffold, no full agent yet) (`src/tools.js`, `src/server.js`)

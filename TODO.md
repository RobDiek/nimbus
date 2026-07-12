# Nimbus Zo-Parity – Work TODO

## 1) Datenbank erweitern
- [x] `src/db.js`: Tabelle `hosting_deployment_events` hinzufügen
- [x] `src/db.js`: Tabelle `hosting_deployment_env` hinzufügen
- [x] `src/db.js`: `skills`-Schema um `triggers` erweitern (Migration/Best-Effort)
- [x] `src/db.js`: nötige Indizes für neue Tabellen ergänzen

## 2) Hosting-Supervisor härten
- [x] `src/hosting.js`: interne Port-Zuweisung, wenn kein Port angegeben
- [x] `src/hosting.js`: deploy mit optional `env`/`secrets`
- [x] `src/hosting.js`: Deployment-Events/Logs in SQLite schreiben
- [x] `src/hosting.js`: Healthcheck vor Veröffentlichung erzwingen
- [x] `src/hosting.js`: `public_url` erst bei healthy aktiv setzen
- [x] `src/hosting.js`: Restart-Policy für abgestürzte Services ergänzen
- [x] `src/hosting.js`: API-Kompatibilität beibehalten (`deploy`, `health`, `rollback`, `deployments`)

## 3) Proxy-Route
- [x] `src/server.js`: optionale lokale Proxy-Route `/_host/:service/*` ergänzen

## 4) Skill-System robuster machen
- [x] `src/skills.js`: YAML-Frontmatter-Parser hinzufügen
- [x] `src/skills.js`: Felder `name`, `description`, `scopes`, `rules`, `triggers` robust parsen
- [x] `src/skills.js`: `triggers` persistieren und bei list/get zurückgeben
- [x] `src/skills.js`: Relevanz-Selektion anhand Prompt (Top-N Skills) implementieren
- [x] `src/agent.js`: relevante Skills statt globalem Volltext in System-Prompt nutzen

## 5) Scope-Enforcement erweitern
- [x] `src/tools.js`: Scope-Gruppen `tools:*`, `files:read/write`, `network:*`, `browser:*`, `hosting:*`, `oauth:provider` enforce’n
- [x] `src/tools.js`: Scope-Verletzungen mit klaren Fehlermeldungen sichtbar machen

## 6) Skills API erweitern
- [x] `src/server.js`: `GET /api/skills/:id`
- [x] `src/server.js`: `POST /api/skills/update`
- [x] `src/server.js`: `POST /api/skills/test`

## 7) UI für Skills erweitern
- [x] `public/js/app.js`: Skill-Detailansicht
- [x] `public/js/app.js`: SKILL.md bearbeiten/speichern
- [x] `public/js/app.js`: Skill-Testlauf mit Prompt

## 8) Validierung
- [ ] Start-/Smoke-Test der Serverfunktionen
- [ ] Hosting-Flows testen (`deploy`, `health`, `deployments`, `rollback`)
- [ ] Skills-Flows testen (`scan`, `detail`, `update`, `test`)
- [ ] Scope-Verletzungsfälle testen

## 9) Echtes Browser-Backend (Playwright/Chromium)
- [x] `src/browser.js`: Provider-Architektur einführen (Playwright + Fallback)
- [x] `src/browser.js`: echte Chromium-Sessions pro Tenant isolieren (Cookies/Context)
- [x] `src/browser.js`: echte Screenshots (Base64 + optional Datei) bereitstellen
- [x] `src/browser.js`: DOM-/A11y-Snapshot ergänzen
- [x] `src/browser.js`: Klick per Text, Selector und Koordinaten
- [x] `src/browser.js`: Formularfelder setzen + Submit robust machen
- [x] `src/browser.js`: Timeout/Close/Cleanup für Sessions
- [x] `src/tools.js`: Browser-Tool-Input-Schema um selector/x/y erweitern (kompatibel)
- [x] Kompatibilität der APIs sicherstellen (`/api/browser/open`, `/click`, `/submit`, `/screenshot`)

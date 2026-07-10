# CLAUDE.md

Leitfaden für Claude Code (und andere Agenten) bei der Arbeit an **Nimbus**.

## Was Nimbus ist

Nimbus ist ein **persönlicher KI-Computer in der Cloud** — ein zo.computer-Klon.
Kein reiner Chatbot, sondern ein Server mit eingebautem Agenten, der echtes
Terminal, Dateisystem, langlebige Services, Scheduler, Web-Zugriff, Memory und
Personas steuert. Der Agent *handelt* (führt Befehle aus, schreibt Dateien,
deployt), statt nur zu antworten.

## Tech-Stack

- **Runtime:** Bun (kein Node) — nutzt `Bun.serve`, `Bun.spawn`, `bun:sqlite`
- **Keine externen Dependencies** — bewusst dependency-frei gehalten
- **Frontend:** Vanilla JS + handgeschriebenes CSS (kein Framework, kein Build-Step)
- **DB:** SQLite (`data/nimbus.db`, WAL-Modus)
- **LLM:** Anthropic Messages API, BYOK (Key liegt lokal in der DB)

## Projektstruktur

```
src/
  server.js     Bun.serve: REST-API, SSE-Chat, WebSocket-Terminal, statische Auslieferung
  agent.js      Agent-Loop gegen Anthropic Messages API (Tool-Use-Schleife, max 25 Turns)
  tools.js      Tool-Definitionen (TOOL_DEFS) + executeTool-Dispatcher
  services.js   User-Services: Prozess-Management mit Ring-Buffer-Logs
  scheduler.js  Minütlicher Cron-Matcher, führt Tasks über den Agenten aus
  db.js         SQLite-Schema, Settings-Helper, Default-Personas
public/
  index.html    Landing Page (dunkel, animiert)
  app.html      Single-Page-Konsole (hell, zo-Style) inkl. SVG-Icon-Sprite
  css/app.css   Design-System der App
  js/app.js     Frontend-Logik (Views, Chat-Streaming, Terminal, alle Panels)
```

## Starten

```bash
bun run src/server.js      # Produktion
bun run dev                # mit Auto-Reload (--watch)
```

Läuft auf http://localhost:4000 — `/` Landing, `/app` Konsole.
Port über `PORT`-Env änderbar.

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
- Der API-Key wird **nur** an die Anthropic-API gesendet, sonst nirgends.

## Beim Arbeiten beachten

- Sprache im Code/UI: **Deutsch** (Kommentare, Labels, Meldungen).
- Keine Emojis in der App-UI — stattdessen das SVG-Icon-Sprite in `app.html`
  (`<symbol id="i-…">`, referenziert via `icon("name")` in `js/app.js`).
- Kein Build-Step: Änderungen an `public/` wirken sofort nach Reload.
- `data/` und `workspace/` sind git-ignoriert (Laufzeit-Zustand).

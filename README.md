# ☁ Nimbus — Dein KI-Computer in der Cloud

Ein voll funktionsfähiger **zo.computer-Klon**: kein reiner Chatbot, sondern ein
persönlicher Server mit eingebautem KI-Agenten, der echtes Terminal, Dateisystem,
Services, Scheduler, Web-Zugriff, Memory und Personas steuert.

![Bun](https://img.shields.io/badge/runtime-Bun-black) ![No deps](https://img.shields.io/badge/dependencies-0-brightgreen) ![License](https://img.shields.io/badge/license-MIT-blue)

## Schnellstart

```bash
bun run src/server.js          # oder: bun run dev  (Auto-Reload)
```

Dann im Browser:
- **Landing Page:** http://localhost:4000/
- **App / Konsole:** http://localhost:4000/app

Beim ersten Start unter **Mein Nimbus Space → BYOK** deinen Anthropic-API-Key
eintragen (bleibt lokal in `data/nimbus.db`). Modell wählbar (Sonnet 5, Fable 5,
Opus 4.8, Haiku 4.5). Alle Bereiche außer dem Chat funktionieren auch ohne Key.

## Was der Agent kann (echte Tools)

| Tool | Funktion |
|---|---|
| `run_command` | Bash im Workspace ausführen (Bun, Python, Node, …) |
| `read_file` / `write_file` / `list_files` / `delete_path` | Vollständiger Dateizugriff |
| `web_search` / `web_fetch` | Websuche (DuckDuckGo) & Seiten als Text |
| `remember` / `search_memory` | Persistentes Memory über Sessions hinweg |
| `schedule_task` / `list_tasks` / `delete_task` | Autonome Cron-Agenten |
| `start_service` / `stop_service` / `list_services` / `service_logs` | Langlebige Hintergrundprozesse |

## Oberfläche (App)

Im hellen zo-Style mit SVG-Icons und Animationen:

- **Start** — Chat-Konsole mit Live-Streaming (SSE), Persona-Wahl, Vorschlags-Chips und aufklappbaren Tool-Calls
- **Mein Nimbus Space** — Systemstatus (echte CPU-/RAM-Werte), BYOK & Memory-Verwaltung
- **Dateien** — Explorer mit Editor (lesen/schreiben/speichern)
- **Automatisierungen** — Cron-Tasks, die ein Agent autonom abarbeitet
- **Integrationen** — Gmail, Outlook, Telegram, Slack, Notion, GitHub, … (an-/abschaltbar)
- **Fähigkeiten** — Personas: KI-Persönlichkeiten mit eigenem Prompt & Modell
- **Browser** — URL laden (iframe) oder als Text extrahieren
- **Hosting** — Services starten/stoppen, Live-Logs
- **Terminal** — echte **persistente Bash-Session** über WebSocket, mit Boot-Sequenz & History

## Terminal = echtes virtuelles System

Das Terminal ist keine One-Shot-Ausführung, sondern eine durchgehende Bash-Session
pro WebSocket-Verbindung (`/ws/term`). Zustand bleibt erhalten:

```bash
nimbus:~$ cd /tmp && export FOO=nimbus
nimbus:~$ pwd && echo $FOO
/tmp
nimbus
```

## Architektur

```
src/
  server.js     Bun.serve: REST-API, SSE-Chat, WebSocket-Terminal, statische Auslieferung
  agent.js      Agent-Loop gegen Anthropic Messages API (Tool-Use-Schleife, max 25 Turns)
  tools.js      Tool-Definitionen + executeTool-Dispatcher
  services.js   User-Services: Prozess-Management mit Ring-Buffer-Logs
  scheduler.js  Minütlicher Cron-Matcher, führt Tasks über den Agenten aus
  db.js         SQLite-Schema, Settings, Default-Personas
public/
  index.html    Landing Page (dunkel, animiert)
  app.html      Single-Page-Konsole (hell, zo-Style) + SVG-Icon-Sprite
  css/app.css   Design-System
  js/app.js     Frontend-Logik (Views, Streaming, Terminal, Panels)
```

**Stack:** Bun + bun:sqlite + Vanilla JS. Keine externen Dependencies, kein Build-Step.
Details für Mitwirkende in [CLAUDE.md](CLAUDE.md).

## Sicherheit

- `delete_path` ist auf den Workspace beschränkt; `run_command` hat vollen Zugriff
  (persönlicher Server, wie beim Original — nur mit eigenem Key betreiben).
- Der API-Key liegt lokal in der SQLite-DB und wird nur an die Anthropic-API gesendet.

## Lizenz

MIT — siehe [LICENSE](LICENSE). Inspiriert von [zo.computer](https://zo.computer).

# Nimbus VM Agent

In-VM Agent Core (Phase 2). Läuft unter `/opt/nimbus-agent`.

## Tools

| Tool | Zweck |
|---|---|
| `bash` | Systembefehle ausführen |
| `read_file` | Datei lesen |
| `write_file` | Datei schreiben |
| `list_directory` | Verzeichnis listen |
| `agent_browser` | Playwright-Navigation / Screenshot |

## Start

```bash
cd /opt/nimbus-agent
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
python -m nimbus_agent.main
```

HTTP: `POST /v1/ask` auf Port `NIMBUS_AGENT_PORT` (Default 8100).

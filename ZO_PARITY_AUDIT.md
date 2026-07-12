# Nimbus ↔ Zo Computer: Feature-Paritätsaudit

Stand: 2026-07-11  
Scope: vorhandene Nimbus-Codebase in diesem Repository plus öffentlich dokumentierte Zo-Computer-Funktionen.

## Kurzfazit

Nimbus hat den technischen Kern eines persönlichen AI-Computers bereits: SSE-Chat, persistente Sessions, Shell, Workspace-Dateien, Web-Fetch, Memory, Cron-Tasks, Personas, langlebige Services und eine erste Proxmox-/Tenant-Schicht.

Für echte Feature-Parität fehlen vor allem die Produktplattform-Schichten rund um diesen Kern:

1. echte Identität, Authentifizierung und durchgängige Tenant-Isolation,
2. vollständige Chat-Historie mit Suche, Teilen und Run-Transparenz,
3. ein echtes Agent-Skills-System statt nur Personas,
4. interaktiver Browser statt iframe/Text-Fetch,
5. öffentliches Hosting mit URL, Restart-Policy, HTTPS und Domains,
6. echte Integrationen und Messaging-Kanäle statt Toggle-Platzhalter,
7. ein belastbarer Automations-Runner mit Historie, Delivery und Zeitzonen,
8. Datei-/Medienverarbeitung, Volltextsuche und Previews,
9. Modellkatalog, Usage-/Kostenkontrolle und strukturierte API.

Die wichtigste technische Vorarbeit ist nicht mehr ein weiteres UI-Panel, sondern eine sichere, tenant-scoped Plattformbasis. Im aktuellen Stand umgehen mehrere HTTP-Routen die Tenant-Logik, obwohl Agent-Chat und VM-Routen sie teilweise verwenden.

## Referenz: öffentlich dokumentierte Zo-Funktionen

Die Bewertung basiert primär auf den offiziellen Zo-Seiten:

- Features: Dateien, Chats, Automationen, Hosting, Sites/Space, Skills, Terminal, Browser, Suche, Commerce und AI-Modelle.
- Chats: persistente, durchsuchbare und teilbare Konversationen.
- Skills: `SKILL.md`-basierte, progressive und portable Workflows.
- Personas: eigene Prompts plus Tool-Scopes/Permission-Presets.
- Automations: Zeitplan, Modell, Delivery-Kanal und gespeicherte Runs.
- Services: langlebige Prozesse, öffentliche/private HTTP-Endpunkte, Restart-Verhalten und Custom Domains.
- Integrationen: Messaging-Kanäle und ein großer Katalog verbundener Apps.
- Tools/Dateien: Web-Interaktion, Mediengenerierung, Transkription, PDF-/Bild-/Videoverarbeitung, Dateisuche und Konvertierung.

## Was Nimbus bereits abdeckt

| Bereich | Nimbus heute | Einschätzung |
|---|---|---|
| Chat/Agent | SSE, Tool-Loop, Anthropic/OpenAI-kompatibel/Google/Custom, max. Turns | Kern vorhanden; Streaming ist nicht tokenweise, sondern ereignisbasiert |
| Sessions | SQLite-Sessions und Messages, Resume im UI | Basis vorhanden; Suche/Share/Run-Ansicht fehlen |
| Files | List/Read/Write/Delete, Editor, Upload | Basis vorhanden; Binärdateien, Preview, Download, Suche und sichere Workspace-UX fehlen |
| Shell | persistente Bash-WebSocket-Verbindung | Vorhanden; echte PTY-/VM-Reconnects und Ressourcen-/Security-Policies ausbauen |
| Web | DuckDuckGo-Suche und HTML-Text-Fetch | Nur Recherche-Basis; keine Browser-Automation/Auth/Screenshot/Downloads |
| Memory | SQLite-Memory, manuell und per Agent | Vorhanden; keine semantische Suche, Quellen, Lösch-/Retention-Policies |
| Automationen | einfacher Cron-Matcher, enabled, last_run/result | MVP vorhanden; keine Zeitzone, RRULE, Run-Historie, Delivery, Retry-/Locking-Modell |
| Hosting | lokale langlebige Prozesse und Logs | MVP vorhanden; keine öffentliche URL, HTTPS, Healthcheck, Restart/Deploy-Revisionen |
| Personas | Prompt + Modell | Teilweise; keine Tool-Scopes, Regeln, Channel-Zuordnung |
| Integrationen | UI-Karten mit gespeicherten Bool-Toggles | Funktional nicht implementiert; OAuth und Tools fehlen |
| VM/Isolation | Proxmox-Orchestrierung und Tenant-Workspace-Ansätze | Gute Richtung; HTTP-Routen und Services sind noch nicht durchgängig tenant-scoped |
| API | interne REST-Routen und Chat-SSE | Keine authentifizierte öffentliche API, API-Keys, OpenAPI oder strukturierte Outputs |

## Fehlende Features, priorisiert

### P0: vor weiterer Featurearbeit beheben

#### 1. Authentifizierung, Autorisierung und Tenant-Isolation

Betroffene Stellen:

- `src/tenancy/router.js`: Tenant wird aus Hostname abgeleitet, aber ohne Benutzer-Login oder signierte Session.
- `src/server.js`: `/api/sessions`, `/api/messages`, `/api/personas`, `/api/memories`, `/api/tasks` und `/api/services` lesen/schreiben teilweise global oder ohne Tenant-Filter.
- `/api/exec`, `/api/files`, `/api/file` und `/api/webfetch` rufen Tools ohne `tenantContext` auf.
- `src/services.js`: Prozess-Map und DB-Zugriffe sind global nach Service-Namen.
- `src/db.js`: Personas sind nicht tenant-scoped; einige Tabellen werden nur best-effort migriert.

Risiko: Nutzer A kann je nach Route Daten von Nutzer B sehen oder löschen; Services können Namen kollidieren; der Hostname allein ist keine Authentifizierung.

#### 2. Chat-Produktfunktionen

Fehlen gegenüber Zo:

- Volltextsuche über Titel und Message-Content.
- Filter nach Zeitraum/Persona/Tool/Status.
- Chat löschen/archivieren/umbenennen ohne Tenant-Leak.
- Öffentliche Share-Links mit explizitem Read-only-Snapshot und Revocation.
- Run-Ansicht: Prompt, Tool-Aufrufe, Ergebnisse, Fehler und Dauer pro Lauf.
- Zugriff über mehrere Geräte und externe API.

#### 3. Skill-System

Personas sind kein Skill-System. Es fehlt:

- Skill-Verzeichnis mit `SKILL.md`-Frontmatter (`name`, `description,` optional scopes).
- progressive loading: Metadata immer, Volltext nur bei Match,
- Skill-Management im UI,
- Skills als Agent-Kontext/Workflow, nicht als unkontrollierter System-Prompt,
- Versionierung, Enable/Disable, Quelle und Audit,
- Permission-Scopes pro Persona/Skill.

### P1: große Paritätslücken

#### 4. Browser-Automation

Der aktuelle Browser lädt ein iframe oder ruft `/api/webfetch` auf. Das ist kein Browser-Agent. Es fehlen Navigation, DOM-/Accessibility-Inspektion, Klick, Formulare, Login-Session, Downloads, Screenshots, Tabs, Timeouts und sichere Secret-Isolation.

#### 5. Hosting/Sites/Services

Nimbus startet Prozesse, aber ein Service ist noch kein belastbares Hosting-Produkt. Es fehlen Service-Definitionen mit Port/Mode/Healthcheck/Env-Secrets, Supervisor-Restart, public/private URL, Reverse Proxy, TLS/Custom Domain, Deploy-Revisionen, Logs/Events und Resource-Limits.

#### 6. Integrationen und Messaging

Die Integrationskarten speichern nur `true/false`; der UI-Text nennt selbst Demo-Platzhalter. Es fehlen OAuth/Token-Speicher, Connector-Adapter, Tool-Schemas, Webhooks und Ein-/Ausgangskanäle. Die erste sinnvolle Paritätsstufe ist Gmail/Outlook, Google Calendar, Telegram, Slack und GitHub.

#### 7. Automations-Engine

Der Cron-Matcher ist minimal und führt Tasks direkt aus. Es fehlen RFC-5545/RRULE oder ein gleichwertiges Scheduling-Modell, Zeitzonen, eindeutige Run-Locks, Retry/Backoff, manuelles Run, Edit, Run-Historie, per Run-Konversation, Delivery über E-Mail/SMS/Telegram/Slack und ein ausgewähltes Modell/Persona.

#### 8. Dateien, Suche und Medien

Es fehlen rekursive Volltextsuche/Regex, Download, Preview für PDF/Bild/Audio/Video, sichere Binary-Speicherung, Konvertierung, Transkription, OCR, Datei-Metadaten, Favoriten und Upload-Limits. Der aktuelle Upload dekodiert jedes Binary als UTF-8-Text und kann dadurch Dateien beschädigen.

### P2: wichtige Produktreife

- Modellkatalog statt statischer/unsauberer Freitextauswahl; pro Modell Vendor, Kontextfenster, Typ, BYOK und Deprication-Mapping.
- Usage-/Kostenlimits pro Tenant, Provider und Automation.
- strukturierte Outputs per JSON Schema und öffentliche `/v1`-API mit SSE.
- Regeln/Policies getrennt von Personas; z. B. „niemals E-Mail ohne Bestätigung senden“.
- Systemmonitoring, Healthchecks, Snapshots/Restore und Audit-Log.
- Commerce/Stripe nur, wenn Nimbus tatsächlich als persönliche Verkaufs-/Site-Plattform positioniert werden soll.

## Empfohlene Reihenfolge

1. Security foundation: Auth, TenantContext als Pflichtparameter, DB-Migrationen, Audit-Log, Tests.
2. Chat-Historie/Search/Share und Run-Events.
3. Skills + Persona-Scopes + Rules.
4. Automation v2 mit Run-Historie und Delivery.
5. Files/Search/Previews/Downloads.
6. Hosting supervisor + URLs/HTTPS.
7. Browser-Automation.
8. Integrations-Framework und die fünf ersten Connectoren.
9. Public API, Model Catalog, Usage/Cost und danach Commerce.

## Genaue Agenten-Anleitung: gemeinsamer Implementierungsvertrag

Der nachfolgende Text kann als Auftrag an einen Coding-Agenten gegeben werden. Er soll in kleinen, überprüfbaren Slices arbeiten und bestehende Änderungen respektieren.

```text
Arbeite im Repository /Users/robindieker/DiekDev/nimbus.

Ziel: Nimbus sicher und schrittweise featuregleich zu einem Zo-Computer machen.
Arbeitsregeln:
1. Lies zuerst AGENTS.md, CLAUDE.md, README.md, TODO.md und ZO_PARITY_AUDIT.md.
2. Bewahre bestehende Nutzeränderungen; kein git reset, kein destruktives Überschreiben.
3. Runtime ist Bun, Frontend ist Vanilla JS ohne Build-Step, Datenbank bun:sqlite.
4. Jede neue Agent-Funktion braucht TOOL_DEFS plus executeTool-Dispatcher.
5. Jede Änderung muss TenantContext explizit durch HTTP-Route, Tool, DB und Runtime tragen.
6. Keine geheimen Tokens in Logs, Responses oder Chat-Messages speichern.
7. Nach jedem Slice: bun --check für alle geänderten JS-Dateien, API-Smoke-Test und ein kurzer Abschlussbericht mit Dateien, Tests, offenen Risiken.

Nicht alles in einem Durchlauf bauen. Implementiere exakt einen Slice, teste ihn, dokumentiere ihn und fahre erst dann mit dem nächsten fort.
```

## Agenten-Anleitung A: Security Foundation / Tenant-Isolation

```text
Implementiere zuerst die Security Foundation.

Ziel:
- Jeder Request hat einen authentifizierten Benutzer und einen unveränderbaren tenantContext.
- Kein Tenant kann Sessions, Messages, Memories, Tasks, Personas, Services, Dateien oder VM-Jobs eines anderen Tenants lesen oder verändern.

Schritte:
1. Ergänze Tabellen users, sessions/auth_sessions, api_keys und audit_events in src/db.js.
2. Implementiere HttpOnly-Signed-Session-Cookies für die Web-App und Bearer API-Keys für API-Clients. Secrets nur gehasht speichern.
3. Ersetze die Hostname-only-Auflösung in src/tenancy/router.js durch Authentifizierung plus optionalen Hostname-Hinweis.
4. Führe tenantContext als Pflichtargument durch alle Routes, Tools und Services. Kein executeTool-Aufruf ohne Kontext.
5. Ergänze tenant_id für personas und fehlende Tabellen per idempotenter Migration. Alle SELECT/UPDATE/DELETE müssen tenant_id filtern.
6. Services erhalten tenantId als Teil des In-Memory-Keys und als DB-Spalte. `/api/exec`, `/api/files`, `/api/file`, `/api/upload` und WebSocket-Terminal müssen den richtigen Workspace verwenden.
7. Lege einen Audit-Eintrag für Login, Datei-Schreib-/Löschvorgänge, Tool-Ausführung, Token-Verbindung, Service- und Automation-Aktionen an.
8. Schreibe Tests für Cross-Tenant-Reads, Cross-Tenant-Deletes, manipulierte session_id, path traversal, absolute Pfade über HTTP und fremde VM job_id.

Akzeptanzkriterien:
- Ein Request ohne gültige Authentifizierung bekommt 401, außer öffentliche Landing-/Health-Routen.
- Nutzer A sieht bei jeder Liste nur eigene Rows.
- Nutzer A kann keine fremde session_id laden/löschen und keinen fremden Service/VM-Job bedienen.
- Uploads landen ausschließlich im Tenant-Workspace.
- `bun --check` und die Cross-Tenant-Tests laufen erfolgreich.
```

## Agenten-Anleitung B: Chats, Suche, Teilen und Run-Transparenz

```text
Baue die Chat-Plattform aus.

Datenmodell:
- chats(id, tenant_id, title, persona_id, archived, created_at, updated_at)
- chat_runs(id, chat_id, tenant_id, status, model, started_at, finished_at, error)
- chat_events(id, run_id, sequence, type, payload_json, created_at)
- chat_shares(id, chat_id, tenant_id, token_hash, revoked_at, expires_at)
- FTS5 virtual table für chat title/message text, falls bun:sqlite FTS5 unterstützt; sonst normalisierte Search-Tabelle.

Backend:
1. Migriere sessions/messages kompatibel auf chats/chat_runs/chat_events.
2. Speichere jeden SSE-Event-Typ serverseitig: text, tool_use, tool_result, error, done.
3. Implementiere GET `/api/chats?q=&archived=&from=&to=`, GET `/api/chats/:id`, PATCH title/archive, DELETE und POST share/revoke.
4. Implementiere read-only Share-Route mit zufälligem, gehasht gespeichertem Token. Niemals die Original-Session ohne Share-Berechtigung ausliefern.
5. Implementiere eine öffentliche, authentifizierte `/v1/zo/ask`-ähnliche Route mit conversation_id, persona_id, model, stream und optionalem JSON-Schema-Output.
6. Ergänze im Frontend Suche mit Debounce, Chat-Details/Run-Timeline, Rename/Archive/Delete und Copy-Link.

Akzeptanzkriterien:
- Suche findet Text in älteren Messages und filtert tenant-sicher.
- Nach Reload kann ein Chat mit vollständigem Kontext fortgesetzt werden.
- Jeder Tool-Aufruf ist in einer Run-Timeline mit Dauer und Ergebnis sichtbar.
- Ein widerrufener oder abgelaufener Share-Link liefert 404/410.
- SSE und JSON-Modus liefern denselben finalen Output.
```

## Agenten-Anleitung C: Skills, Persona-Scopes und Regeln

```text
Implementiere ein Agent-Skills-System nach dem Agent-Skills-Muster.

Format:
- Workspace-Verzeichnis `Skills/<slug>/SKILL.md`.
- YAML-Frontmatter: name, description, version, license, required_scopes.
- Optionale Unterordner references/, scripts/, templates/.

Backend:
1. Scanne Skills rekursiv und validiere Frontmatter ohne beliebigen Code beim Scan auszuführen.
2. Halte nur Metadata im Basisprompt. Lade SKILL.md erst bei passendem Skill oder expliziter Auswahl.
3. Ergänze `list_skills`, `read_skill`, `create_skill`, `enable_skill` und `delete_skill` mit Tenant-Scope.
4. Führe ein zentralisiertes Permission-Modul ein: files:read, files:write, shell:execute, web:search, web:browse, integrations:<name>, hosting:manage, settings:manage.
5. Persona besitzt Scopes; Tool-Definitionen werden vor dem Agent-Run nach Scopes gefiltert. Ein verbotenes Tool darf dem Modell gar nicht angeboten werden.
6. Ergänze user rules mit Priorität und konfliktauflösender Reihenfolge. Regeln und Persona-Prompt getrennt speichern.
7. UI: Skill-Liste, Metadata, Enable/Disable, Scopes und Persona-Zuordnung.

Akzeptanzkriterien:
- Ein Read-only-Agent erhält kein write_file, delete_path, shell oder sendendes Integrationstool.
- Skill-Metadata wird ohne Volltext geladen; passende Skills laden ihre Anweisung erst danach.
- Ein Skill kann dieselbe Routine manuell aus Chat und aus einer Automation verwenden.
- Jede Scope-Verletzung wird vor Tool-Aufruf abgelehnt und auditiert.
```

## Agenten-Anleitung D: Automation v2

```text
Ersetze den einfachen Cron-Runner durch einen persistierten Automation-Runner.

Datenmodell:
- automations(id, tenant_id, name, instruction, rrule, timezone, enabled, persona_id, model, delivery_method, delivery_target, next_run_at, last_run_at)
- automation_runs(id, automation_id, tenant_id, status, conversation_id, started_at, finished_at, output, error, retry_count)

Implementierung:
1. Unterstütze zunächst eine geprüfte RRULE-Subset-Implementierung oder eine kleine dependency-freie Parser-Schicht für daily/weekly/hourly/interval plus IANA-Zeitzone.
2. Validierung vor Speicherung; keine stillschweigend falschen Cron-Termine.
3. Worker claimt fällige Runs atomar, damit mehrere Nimbus-Prozesse nicht doppelt ausführen.
4. Jeder Run erhält eigene Conversation/Run-Events und optional Persona/Modell.
5. Retry mit exponentiellem Backoff, Max-Retries, Timeout und Idempotency-Key.
6. Ergänze manual run, edit, pause/resume, run history, error details und delivery adapters für E-Mail, Telegram, Slack; Delivery muss separat fehlschlagen können.
7. Frontend zeigt next run, timezone, last status, run history, manual run und delivery.

Akzeptanzkriterien:
- DST-Wechsel in Europe/Berlin erzeugt keinen doppelten Run.
- Zwei Worker führen denselben fälligen Run höchstens einmal aus.
- Ein fehlgeschlagener Delivery-Versuch macht den eigentlichen Agent-Run sichtbar, aber nicht fälschlich erfolgreich.
- Ein Run ist als Chat/Conversation mit Tool-Historie nachvollziehbar.
```

## Agenten-Anleitung E: Files/Search/Media

```text
Baue eine sichere Datei-Plattform.

1. Upload und Download bytegenau implementieren; keine TextDecoder/UTF-8-Konvertierung für Binärdateien.
2. Begrenze Größe, Anzahl, MIME-Types und Upload-Rate pro Tenant.
3. Ergänze GET download, rekursive list/search mit filename/content/regex und Pagination.
4. Ergänze Preview-Adapter: text/code, image, PDF, audio/video metadata; Adapter müssen mit fehlenden Systemtools sauber umgehen.
5. Ergänze Agent-Tools `search_files`, `download_file`, `convert_file`, `transcribe_media`, `save_article` und `generate_image` zunächst hinter klaren Provider-Interfaces.
6. Baue eine Index-Tabelle mit tenant_id, path, mime, size, checksum, modified_at und extracted_text. Reindexing muss tenant-scoped und abbrechbar sein.
7. UI: Suche, Preview, Download, Upload-Fortschritt, Fehlerzustand und zuletzt erzeugte Outputs.

Akzeptanzkriterien:
- PDF, PNG und ZIP überleben Upload/Download byte-identisch.
- Suche findet Dateiname und extrahierten Text ohne fremde Tenants.
- Preview erzeugt keine aktive Ausführung von eingebettetem HTML/JavaScript.
```

## Agenten-Anleitung F: Browser-Automation

```text
Ersetze iframe/Text-Fetch nicht sofort vollständig, sondern führe eine Browser-Provider-Schnittstelle ein.

Interface:
- createBrowserSession(tenantId)
- navigate(sessionId, url)
- inspect(sessionId) -> title/url/accessibility tree
- click/type/select/press(sessionId, locator, value)
- screenshot(sessionId)
- download(sessionId, targetPath)
- close(sessionId)

Sicherheit:
1. Browser-Prozess/Context pro Tenant, kurze TTL, explizite Close- und Quota-Regeln.
2. Keine Secrets in DOM-Logs oder Screenshots persistieren.
3. SSRF-Schutz, private IPs/metadata endpoints blockieren, Download- und Navigation-Limits.
4. Tool-Scopes `web:search` und `web:browse` trennen.
5. Tool-Ergebnisse strukturiert und klein halten; Screenshots als Artefakt referenzieren.

UI/Agent:
- Tabs, URL, Screenshot, DOM-Auszug und laufende Aktionen anzeigen.
- Agent kann navigate/inspect/click/type nur nach Scope ausführen.
- Bestehenden web_fetch als stateless Fallback behalten.

Akzeptanzkriterien:
- Öffnen, Inspektieren, Klick und Formular-Eingabe funktionieren in einer isolierten Testseite.
- Session kann geschlossen werden und hinterlässt keine Browser-Cookies im falschen Tenant.
- SSRF-Test gegen localhost, 127.0.0.1, private RFC1918 und Cloud-Metadata wird blockiert.
```

## Agenten-Anleitung G: Hosting/Sites/Services

```text
Erweitere Services zu einem sicheren Hosting-Supervisor.

Datenmodell:
- services tenant-scoped mit mode(http|worker|database), port, public, healthcheck_url, restart_policy, env_ref, url, revision, last_exit_code.
- service_revisions und service_events für Deploys/Restarts.

1. Prozessstarts laufen ausschließlich über den tenant-scoped Supervisor, nicht über eine lose globale Map.
2. Service-Konfiguration validieren: Name, command, cwd, Port, Ressourcen, Environment-Referenzen.
3. Implementiere autostart/restart-on-failure, graceful stop, healthchecks, log rotation und bounded logs.
4. Für HTTP-Services Reverse-Proxy-Routing mit zufälliger interner Portzuweisung. Externe URL darf erst nach erfolgreichem Healthcheck erscheinen.
5. TLS/Custom Domain als klar getrennten Adapter planen; bei fehlender DNS-/ACME-Konfiguration explizit `not configured` anzeigen.
6. Deploy erzeugt Revision, führt Smoke-Test aus und erlaubt Rollback.
7. UI: public/private, URL, Status, Health, Revision, Logs, Restart und Rollback.

Akzeptanzkriterien:
- Service überlebt einen Nimbus-Neustart, wenn autostart aktiv ist.
- Crash-Loop wird begrenzt und sichtbar gemeldet.
- Service eines Tenants ist von anderem Tenant nicht erreichbar.
- URL wird nicht als aktiv angezeigt, bevor Healthcheck erfolgreich ist.
```

## Agenten-Anleitung H: Integrations-Framework

```text
Baue ein Connector-Framework und implementiere zuerst Telegram, Gmail/Outlook, Google Calendar, Slack und GitHub.

Abstraktionen:
- connector manifest: id, scopes, auth_type, tool definitions, webhook support.
- encrypted credential store pro tenant.
- connect/callback/disconnect/refresh lifecycle.
- executeConnectorTool(connectorId, toolName, input, tenantContext).

1. Keine Integration darf nur ein UI-Bool sein. Der Status kommt aus Credential-/Health-Prüfung.
2. OAuth callback mit state, PKCE und exact redirect validation.
3. Tokens verschlüsselt at rest; Refresh-Token nie an den Agenten zurückgeben.
4. Connector-Tools mit read/write/send Scopes versehen; sendende Aktionen standardmäßig bestätigungspflichtig.
5. Webhook-Signaturen prüfen und eingehende Nachrichten einem Tenant/Channel/Persona zuordnen.
6. Delivery-Adapter für Automations wiederverwenden.
7. UI zeigt benötigte Scopes, letzte Prüfung, Reauth und Trennen.

Akzeptanzkriterien:
- Ein Test-Connector kann verbinden, refreshen, lesen und sauber trennen.
- Ein Agent ohne comms:send kann keine Nachricht senden.
- OAuth state/PKCE- und falsche-Tenant-Tests schlagen sicher fehl.
```

## Nicht als Paritätsziel übernehmen

Einige Zo-Funktionen sind für Nimbus als DSGVO-/Enterprise-Produkt nicht automatisch sinnvoll: globale Drittanbieter-Connector-Kataloge, SMS/iMessage, X/LinkedIn-Automation, Commerce/Stripe und unbeschränkter Root-Zugriff. Diese sollten hinter Enterprise-Policies, EU-Datenresidenz, DPA/AVV, Audit und expliziten Scopes stehen. Featuregleichheit bedeutet hier gleiche Fähigkeitsschicht, nicht ungeprüfte Übernahme jedes externen Datenflusses.

## Verifikation des aktuellen Repositories

- `bun --check` für `src/*.js`, `src/tenancy/*.js` und `public/js/app.js`: erfolgreich.
- Ein zusätzlicher Serverstart auf Port 4000 war nicht möglich, weil bereits ein Nimbus-Prozess auf dem Port lauschte.
- Der laufende Dienst antwortete erfolgreich auf `/api/status` und `/api/files`.
- Im aktuellen Arbeitsbaum existieren bereits uncommitted Änderungen; diese Analyse-Datei wurde separat ergänzt.

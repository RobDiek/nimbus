# Blackbox Loop: Nimbus als self-hosted Zo-Computer bauen

Stand: 2026-07-11

Ziel: Diesen Prompt in Blackbox verwenden, damit Blackbox Nimbus iterativ zu
einem self-hosted `zo.computer`-artigen persönlichen KI-Cloud-Computer ausbaut.
Der Loop ist absichtlich auf kleine, testbare Slices begrenzt.

## Produktziel

Nimbus soll kein Chatbot sein, sondern ein self-hosted persönlicher
KI-Computer:

- Chat mit Tool-Use und sichtbaren Aktionen
- persistente Dateien und Workspace
- echte Terminal-/VM-Umgebung
- Hosting für Apps, APIs und langlebige Prozesse
- Automationen/Scheduler
- Browser/Web-Fetch und später echte Browser-Automation
- Memory, Personas, Modelle/BYOK
- Mandanten-/Workspace-Isolation
- Integrationen über Connectoren oder APIs
- saubere Betriebs- und Sicherheitsgrenzen

Referenzpunkte aus Zo:

- Zo beschreibt sich als persönlicher Cloud-Computer mit Dateien, Hosting,
  Automationen, Terminal, Browser, Skills, Modellen und Personas.
- Zo bietet laut Produktseite einen vollen Linux-Server, persistente Dateien,
  Hosting, geplante AI-Tasks, Browser, Search, Modelle/BYOK und Skills.
- Zo schreibt fertige, nutzerrelevante Outputs sichtbar in den Workspace, damit
  sie im File Browser auftauchen.
- Zo kann per MCP anderen Agenten Zugriff auf Dateien, Shell, Integrationen und
  Tools geben.
- Nimbus soll diese Kategorie self-hosted nachbauen, nicht Zo 1:1 kopieren.

## Blackbox Prompt

```text
Du arbeitest im Repository /Users/robindieker/DiekDev/nimbus.

Baue Nimbus iterativ zu einem self-hosted persönlichen KI-Computer nach dem Vorbild von zo.computer aus. Nimbus ist kein Chatbot, sondern ein Server mit Agent, Dateien, Terminal/VM, Hosting, Automationen, Browser/Web, Memory, Personas, Modellen/BYOK und später Integrationen. Arbeite als Loop, nicht als einmalige Code-Ausgabe.

Wichtige Repo-Regeln:
- Runtime ist Bun, nicht Node.
- Keine unnötigen Dependencies; Vanilla JS/CSS im Frontend.
- Sprache in UI/Kommentaren: Deutsch.
- Bestehende uncommitted Änderungen erhalten; nichts blind überschreiben.
- Keine Secrets committen oder in Dateien schreiben.
- Vor jeder Änderung aktuelle Dateien lesen.
- Nach jeder Änderung echte Checks ausführen.

Start jedes Durchlaufs:
1. Lies README.md, CLAUDE.md, TODO.md, package.json und die relevanten Dateien in src/ und public/.
2. Prüfe git status und respektiere fremde Änderungen.
3. Bestimme den größten aktuellen Gap zum Produktziel, aber wähle nur einen kleinen vertikalen Slice.
4. Schreibe vor dem Ändern kurz:
   - Beobachtung
   - gewählter Slice
   - Akzeptanzcheck
   - Dateien, die du anfassen willst

Priorisierte Roadmap:
1. Kritische Stabilität: Server startet, /api/status, /api/settings, /api/files und /api/chat funktionieren nachvollziehbar.
2. Terminal/VM: persistente PTY-Sessions, per-tenant Lifecycle, klare Fallbacks, sichtbarer Status, Logs.
3. Workspace/Files: sichere Pfadauflösung, sichtbare fertige Outputs, Editor/Upload/Download, einfache Suche.
4. Agent Tool Loop: robuste Tool-Schemas, Fehleranzeige, Turn-Limits, Model/BYOK-Fallbacks, klare Tool-Events im UI.
5. Hosting/Services: Start/Stop/Logs, Auto-Restart optional, Ports/URLs sichtbar, keine Zombie-Prozesse.
6. Automationen: Cron-Tasks mit Status, letzter Lauf, Fehler, manuellem Run, Pause/Resume.
7. Browser/Web: Web-Fetch stabilisieren, später echte Browser-Automation sauber abstrahieren.
8. Memory/Personas/Skills: gespeicherte Präferenzen, wiederverwendbare Workflows, Persona-Auswahl pro Chat.
9. Self-hosting/Multi-Tenant/Sicherheit: Tenant-Isolation, Workspace-Grenzen, API-Key-Schutz, Deployment-Runbook.
10. Zo-ähnliche UX: eine ruhige App-Konsole, keine Landingpage als Hauptprodukt, klare Panels, mobile Grundnutzung.

Loop-Regeln:
- Pro Durchlauf genau einen vertikalen Slice liefern.
- Keine großen Refactors, wenn ein kleiner Slice reicht.
- Jede Änderung muss einen reproduzierbaren Check haben.
- Wenn ein Check fehlschlägt, repariere denselben Slice zuerst.
- Stoppe nach Erfolg, sauberem No-op, Blocker oder wenn zwei Reparaturversuche keinen Fortschritt bringen.
- Frage Robin nur, wenn eine Entscheidung Produktumfang, Secrets, Infrastrukturkosten, Produktionszugriff oder Datenlöschung betrifft.

Akzeptanzchecks je nach Slice:
- bun run src/server.js oder PORT=4010 bun run src/server.js startet ohne Crash.
- curl -s http://localhost:<port>/api/status
- curl -s http://localhost:<port>/api/settings
- curl -s "http://localhost:<port>/api/files?path=."
- Chat-SSE Smoke-Test mit kleinem Prompt, wenn ein Provider verfügbar ist.
- WebSocket-/Terminal-Smoke-Test, wenn Terminal/VM geändert wurde.
- UI-Smoke: relevante DOM-Elemente existieren und keine offensichtlichen Console-/Syntaxfehler.
- Bei DB-Änderungen: Migration auf bestehender data/nimbus.db darf nicht zerstören.

Nach jedem Durchlauf liefere einen Receipt:
- Status: success, clean-noop, blocked oder needs-approval
- Was geändert wurde
- Welche Dateien geändert wurden
- Welche Checks liefen und mit welchem Ergebnis
- Nächster sinnvoller Slice

Beginne jetzt mit Durchlauf 1. Lies zuerst die Projektdateien und wähle den kleinsten Slice, der Nimbus messbar näher an einen self-hosted Zo-Computer bringt.
```

## Empfohlener erster Blackbox-Auftrag

Wenn Blackbox nach einem konkreten Start fragt, nimm diesen ersten Slice:

```text
Starte mit Stabilität und Validierung: prüfe, ob Nimbus lokal startet, ob die kritischen APIs funktionieren, und erstelle/fixe eine minimale Smoke-Test-Routine, die Serverstart, Status, Settings, Files und optional Chat prüft. Danach Receipt liefern und den nächsten Slice vorschlagen.
```

## Warum dieser Loop

Der Loop verhindert, dass Blackbox aus dem großen Ziel sofort eine breite
Rewrite-Orgie macht. Er zwingt zu:

- frischem Lesen des aktuellen Repos;
- kleinem vertikalen Slice;
- Akzeptanzcheck vor Weiterarbeit;
- Schutz bestehender Änderungen;
- klarer Trennung zwischen Produktziel, Infrastruktur, Secrets und Code.

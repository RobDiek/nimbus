// Nimbus – HTTP-Server (Bun), API + WebSocket-Terminal + statische Auslieferung
import { join } from "path";
import os from "node:os";
import { db, getSetting, setSetting, ROOT, WORKSPACE } from "./db.js";
import { runAgent, hasKey } from "./agent.js";
import { executeTool } from "./tools.js";
import { services } from "./services.js";
import { startScheduler } from "./scheduler.js";

const PUBLIC = join(ROOT, "public");
const PORT = Number(process.env.PORT || 4000);
const BOOT_TIME = Date.now();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

// System-Prompt für eine Session inkl. Persona + Memory-Kontext
function buildSystem(personaId) {
  const persona = personaId
    ? db.query("SELECT * FROM personas WHERE id = ?").get(personaId)
    : db.query("SELECT * FROM personas ORDER BY id LIMIT 1").get();
  const base = persona?.system_prompt ||
    "Du bist Nimbus, ein persönlicher KI-Computer mit Terminal- und Dateizugriff.";
  const mems = db.query("SELECT content FROM memories ORDER BY id DESC LIMIT 15").all();
  const memText = mems.length
    ? "\n\nWas du dir über den Nutzer gemerkt hast:\n" + mems.map((m) => "- " + m.content).join("\n")
    : "";
  const env = `\n\nUmgebung: Workspace=${WORKSPACE}. Du hast run_command (bash), Dateisystem-, Web-, Memory-, Service- und Scheduler-Tools. Handle proaktiv – führe Aufgaben aus, statt nur zu beschreiben.`;
  return { system: base + env + memText, model: persona?.model || undefined };
}

const routes = {
  // --- Status / Settings / Sysinfo ---
  "GET /api/status": () => json({
    ok: true,
    hasKey: hasKey(),
    model: getSetting("model", "claude-sonnet-5"),
    workspace: WORKSPACE,
  }),
  "GET /api/sysinfo": () => json({
    cores: os.cpus().length,
    mem_gb: Math.round(os.totalmem() / 1024 ** 3),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime_s: Math.round((Date.now() - BOOT_TIME) / 1000),
    workspace: WORKSPACE,
  }),
  "GET /api/settings": () => json({
    model: getSetting("model", "claude-sonnet-5"),
    hasKey: hasKey(),
    integrations: JSON.parse(getSetting("integrations", "{}")),
  }),
  "POST /api/settings": async (req) => {
    const b = await body(req);
    if (typeof b.apiKey === "string" && b.apiKey.trim()) setSetting("anthropic_api_key", b.apiKey.trim());
    if (b.model) setSetting("model", b.model);
    if (b.integrations) setSetting("integrations", JSON.stringify(b.integrations));
    return json({ ok: true });
  },

  // --- Sessions ---
  "GET /api/sessions": () => json({
    sessions: db.query("SELECT * FROM sessions ORDER BY id DESC").all(),
  }),
  "POST /api/sessions/delete": async (req) => {
    const b = await body(req);
    db.query("DELETE FROM messages WHERE session_id = ?").run(b.id);
    db.query("DELETE FROM sessions WHERE id = ?").run(b.id);
    return json({ ok: true });
  },
  "GET /api/messages": (req, url) => {
    const sid = url.searchParams.get("session_id");
    const rows = db.query("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id").all(sid);
    return json({ messages: rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) })) });
  },

  // --- Personas ---
  "GET /api/personas": () => json({ personas: db.query("SELECT * FROM personas ORDER BY id").all() }),
  "POST /api/personas": async (req) => {
    const b = await body(req);
    if (b.id) {
      db.query("UPDATE personas SET name=?, system_prompt=?, model=? WHERE id=?")
        .run(b.name, b.system_prompt || "", b.model || "", b.id);
      return json({ ok: true, id: b.id });
    }
    const r = db.query("INSERT INTO personas (name, emoji, system_prompt, model) VALUES (?,?,?,?)")
      .run(b.name, "", b.system_prompt || "", b.model || "");
    return json({ id: r.lastInsertRowid });
  },
  "POST /api/personas/delete": async (req) => {
    const b = await body(req);
    db.query("DELETE FROM personas WHERE id = ?").run(b.id);
    return json({ ok: true });
  },

  // --- Memory ---
  "GET /api/memories": () => json({ memories: db.query("SELECT * FROM memories ORDER BY id DESC").all() }),
  "POST /api/memories": async (req) => {
    const b = await body(req);
    db.query("INSERT INTO memories (content, tags) VALUES (?, ?)").run(b.content, b.tags || "");
    return json({ ok: true });
  },
  "POST /api/memories/delete": async (req) => {
    const b = await body(req);
    db.query("DELETE FROM memories WHERE id = ?").run(b.id);
    return json({ ok: true });
  },

  // --- Tasks ---
  "GET /api/tasks": () => json({ tasks: db.query("SELECT * FROM tasks ORDER BY id DESC").all() }),
  "POST /api/tasks": async (req) => {
    const b = await body(req);
    db.query("INSERT INTO tasks (name, cron, prompt) VALUES (?, ?, ?)").run(b.name, b.cron, b.prompt);
    return json({ ok: true });
  },
  "POST /api/tasks/toggle": async (req) => {
    const b = await body(req);
    db.query("UPDATE tasks SET enabled = NOT enabled WHERE id = ?").run(b.id);
    return json({ ok: true });
  },
  "POST /api/tasks/delete": async (req) => {
    const b = await body(req);
    db.query("DELETE FROM tasks WHERE id = ?").run(b.id);
    return json({ ok: true });
  },

  // --- Services (Hosting) ---
  "GET /api/services": () => json({ services: services.list() }),
  "POST /api/services/start": async (req) => {
    const b = await body(req);
    return json(services.start(b.name, b.command, b.cwd));
  },
  "POST /api/services/stop": async (req) => {
    const b = await body(req);
    return json(services.stop(b.name));
  },
  "POST /api/services/remove": async (req) => {
    const b = await body(req);
    return json(services.remove(b.name));
  },
  "GET /api/services/logs": (req, url) => json(services.logs(url.searchParams.get("name"))),

  // --- Files ---
  "GET /api/files": async (req, url) => json(await executeTool("list_files", { path: url.searchParams.get("path") || "." })),
  "GET /api/file": async (req, url) => json(await executeTool("read_file", { path: url.searchParams.get("path") })),
  "POST /api/file": async (req) => {
    const b = await body(req);
    return json(await executeTool("write_file", { path: b.path, content: b.content }));
  },

  // --- Web (für Browser-View) ---
  "GET /api/webfetch": async (req, url) => json(await executeTool("web_fetch", { url: url.searchParams.get("url") })),

  // --- Terminal (One-Shot-Fallback) ---
  "POST /api/exec": async (req) => {
    const b = await body(req);
    return json(await executeTool("run_command", { command: b.command, cwd: b.cwd }));
  },
};

// --- Chat-Endpoint mit SSE-Streaming ---
async function handleChat(req) {
  const b = await body(req);
  const { message } = b;
  let sessionId = b.session_id;

  if (!sessionId) {
    const r = db.query("INSERT INTO sessions (title, persona_id) VALUES (?, ?)")
      .run(message.slice(0, 48), b.persona_id || null);
    sessionId = r.lastInsertRowid;
  }

  const session = db.query("SELECT * FROM sessions WHERE id = ?").get(sessionId);
  const { system, model } = buildSystem(b.persona_id || session?.persona_id);

  const history = db.query("SELECT role, content FROM messages WHERE session_id = ? ORDER BY id").all(sessionId)
    .map((r) => ({ role: r.role, content: JSON.parse(r.content) }));
  history.push({ role: "user", content: message });
  db.query("INSERT INTO messages (session_id, role, content) VALUES (?, 'user', ?)")
    .run(sessionId, JSON.stringify(message));

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (e) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: "session", session_id: sessionId });
      const startLen = history.length;
      try {
        await runAgent({ messages: history, system, model, onEvent: send });
      } catch (err) {
        send({ type: "error", error: String(err.message || err) });
      }
      for (let i = startLen; i < history.length; i++) {
        const m = history[i];
        db.query("INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)")
          .run(sessionId, m.role, JSON.stringify(m.content));
      }
      send({ type: "end" });
      controller.close();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
  });
}

// --- WebSocket-Terminal: persistente Bash-Session pro Verbindung ---
async function pipeToWs(stream, ws, kind) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      ws.send(JSON.stringify({ type: "out", kind, data: dec.decode(value) }));
    }
  } catch { /* Socket zu */ }
}

const server = Bun.serve({
  port: PORT,
  idleTimeout: 255,
  async fetch(req, srv) {
    const url = new URL(req.url);

    if (url.pathname === "/ws/term") {
      if (srv.upgrade(req, { data: { proc: null } })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    const key = `${req.method} ${url.pathname}`;
    if (key === "POST /api/chat") return handleChat(req);

    const handler = routes[key];
    if (handler) return handler(req, url);

    let path = url.pathname === "/" ? "/index.html"
      : url.pathname === "/app" ? "/app.html"
      : url.pathname;
    const file = Bun.file(join(PUBLIC, path));
    if (await file.exists()) return new Response(file);

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const proc = Bun.spawn(["bash"], {
        cwd: WORKSPACE,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PS1: "", TERM: "dumb", NIMBUS: "1" },
      });
      ws.data.proc = proc;
      pipeToWs(proc.stdout, ws, "out");
      pipeToWs(proc.stderr, ws, "err");
      proc.exited.then((code) => {
        try { ws.send(JSON.stringify({ type: "exit", code })); ws.close(); } catch {}
      });
      ws.send(JSON.stringify({ type: "ready", cwd: WORKSPACE }));
    },
    message(ws, raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "cmd" && ws.data.proc) {
        ws.data.proc.stdin.write(m.cmd + "\n");
        ws.data.proc.stdin.flush();
      }
      // m.type === "ping" → keepalive, nichts tun
    },
    close(ws) {
      try { ws.data.proc?.kill(); } catch {}
    },
  },
});

startScheduler();
console.log(`\n☁  Nimbus läuft auf http://localhost:${server.port}`);
console.log(`   Landing: /    App: /app    Workspace: ${WORKSPACE}`);
if (!hasKey()) console.log("   ⚠  Kein API-Key – in der App unter 'Mein Nimbus Space' eintragen.\n");

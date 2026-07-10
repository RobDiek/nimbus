// Nimbus – Tool-Implementierungen für den Agenten
import { db, WORKSPACE } from "./db.js";
import { services } from "./services.js";
import { join, resolve, relative } from "path";
import {
  readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync, existsSync,
} from "fs";

// Pfade werden relativ zum Workspace aufgelöst; absolute Pfade sind erlaubt
// (persönlicher Server, wie bei zo.computer: der Agent hat vollen Zugriff).
function resolvePath(p) {
  if (!p || p === ".") return WORKSPACE;
  return p.startsWith("/") ? p : resolve(join(WORKSPACE, p));
}

const MAX_OUTPUT = 20000;
function clip(s) {
  s = String(s ?? "");
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + `\n… [${s.length - MAX_OUTPUT} Zeichen abgeschnitten]` : s;
}

// --- Shell ---
export async function runCommand(command, cwd, timeoutMs = 120000) {
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: resolvePath(cwd),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NIMBUS: "1" },
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  clearTimeout(timer);
  return { exit_code: code, stdout: clip(stdout), stderr: clip(stderr) };
}

// --- Dateisystem ---
export function readFile(path) {
  const full = resolvePath(path);
  const st = statSync(full);
  if (st.size > 512 * 1024) return { error: "Datei größer als 512 KB – nutze run_command mit head/tail." };
  return { path: full, content: clip(readFileSync(full, "utf8")) };
}

export function writeFile(path, content) {
  const full = resolvePath(path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, content ?? "");
  return { ok: true, path: full, bytes: Buffer.byteLength(content ?? "") };
}

export function listFiles(path) {
  const full = resolvePath(path);
  const entries = readdirSync(full).slice(0, 500).map((name) => {
    try {
      const st = statSync(join(full, name));
      return { name, type: st.isDirectory() ? "dir" : "file", size: st.size };
    } catch {
      return { name, type: "unknown", size: 0 };
    }
  });
  return { path: full, entries };
}

export function deletePath(path) {
  const full = resolvePath(path);
  // Löschen nur innerhalb des Workspace – Schutz vor Agent-Fehlern
  if (relative(WORKSPACE, full).startsWith("..")) {
    return { error: "Löschen ist nur innerhalb des Workspace erlaubt." };
  }
  rmSync(full, { recursive: true, force: true });
  return { ok: true, deleted: full };
}

// --- Web ---
function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

export async function webSearch(query) {
  const res = await fetch(
    "https://html.duckduckgo.com/html/?q=" + encodeURIComponent(query),
    { headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" } }
  );
  const html = await res.text();
  const results = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let m;
  while ((m = re.exec(html)) && results.length < 8) {
    let url = m[1];
    const uddg = url.match(/uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    results.push({ url, title: stripHtml(m[2]), snippet: stripHtml(m[3]) });
  }
  return results.length ? { results } : { results: [], note: "Keine Treffer (evtl. Rate-Limit) – versuche web_fetch mit einer bekannten URL." };
}

export async function webFetch(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
  });
  const type = res.headers.get("content-type") || "";
  const body = await res.text();
  return {
    url, status: res.status,
    content: clip(type.includes("html") ? stripHtml(body) : body),
  };
}

// --- Memory ---
export function remember(content, tags = "") {
  db.query("INSERT INTO memories (content, tags) VALUES (?, ?)").run(content, tags);
  return { ok: true };
}

export function searchMemory(query = "") {
  const rows = query
    ? db.query("SELECT * FROM memories WHERE content LIKE ? OR tags LIKE ? ORDER BY id DESC LIMIT 20")
        .all(`%${query}%`, `%${query}%`)
    : db.query("SELECT * FROM memories ORDER BY id DESC LIMIT 20").all();
  return { memories: rows };
}

// --- Scheduled Tasks ---
export function scheduleTask(name, cron, prompt) {
  db.query("INSERT INTO tasks (name, cron, prompt) VALUES (?, ?, ?)").run(name, cron, prompt);
  return { ok: true, name, cron };
}
export function listTasks() {
  return { tasks: db.query("SELECT * FROM tasks ORDER BY id").all() };
}
export function deleteTask(id) {
  db.query("DELETE FROM tasks WHERE id = ?").run(id);
  return { ok: true };
}

// --- Tool-Definitionen für die Anthropic API ---
export const TOOL_DEFS = [
  {
    name: "run_command",
    description: "Führt einen Shell-Befehl (bash) auf dem Nimbus-Computer aus. Standard-Arbeitsverzeichnis ist der Workspace. Timeout 120s.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Der bash-Befehl" },
        cwd: { type: "string", description: "Optionales Arbeitsverzeichnis (relativ zum Workspace oder absolut)" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Liest eine Textdatei.",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Schreibt/überschreibt eine Datei (legt Verzeichnisse automatisch an).",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    name: "list_files",
    description: "Listet ein Verzeichnis auf.",
    input_schema: { type: "object", properties: { path: { type: "string" } } },
  },
  {
    name: "delete_path",
    description: "Löscht Datei oder Verzeichnis (nur innerhalb des Workspace).",
    input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "web_search",
    description: "Websuche (DuckDuckGo). Liefert Titel, URL, Snippet.",
    input_schema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "web_fetch",
    description: "Lädt eine URL und liefert den Textinhalt (HTML wird zu Text reduziert).",
    input_schema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
  },
  {
    name: "remember",
    description: "Speichert einen Fakt dauerhaft im Memory (über Sessions hinweg abrufbar).",
    input_schema: {
      type: "object",
      properties: { content: { type: "string" }, tags: { type: "string", description: "Kommagetrennte Tags" } },
      required: ["content"],
    },
  },
  {
    name: "search_memory",
    description: "Durchsucht das persistente Memory.",
    input_schema: { type: "object", properties: { query: { type: "string" } } },
  },
  {
    name: "schedule_task",
    description: "Legt einen zeitgesteuerten Agenten-Task an (Cron-Syntax: 'min std tag monat wochentag', z.B. '0 7 * * *' = täglich 07:00). Der Prompt wird zur geplanten Zeit von einem Agenten ausgeführt.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        cron: { type: "string" },
        prompt: { type: "string" },
      },
      required: ["name", "cron", "prompt"],
    },
  },
  { name: "list_tasks", description: "Listet alle geplanten Tasks.", input_schema: { type: "object", properties: {} } },
  {
    name: "delete_task",
    description: "Löscht einen geplanten Task.",
    input_schema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] },
  },
  {
    name: "start_service",
    description: "Startet einen dauerhaften Hintergrund-Prozess (z.B. einen HTTP-Server) und verwaltet ihn als Service.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Eindeutiger Service-Name" },
        command: { type: "string", description: "Startbefehl (bash)" },
        cwd: { type: "string" },
      },
      required: ["name", "command"],
    },
  },
  {
    name: "stop_service",
    description: "Stoppt einen laufenden Service.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  { name: "list_services", description: "Listet alle Services mit Status.", input_schema: { type: "object", properties: {} } },
  {
    name: "service_logs",
    description: "Liefert die letzten Log-Zeilen eines Services.",
    input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
];

// --- Dispatcher ---
export async function executeTool(name, input) {
  try {
    switch (name) {
      case "run_command": return await runCommand(input.command, input.cwd);
      case "read_file": return readFile(input.path);
      case "write_file": return writeFile(input.path, input.content);
      case "list_files": return listFiles(input.path);
      case "delete_path": return deletePath(input.path);
      case "web_search": return await webSearch(input.query);
      case "web_fetch": return await webFetch(input.url);
      case "remember": return remember(input.content, input.tags);
      case "search_memory": return searchMemory(input.query);
      case "schedule_task": return scheduleTask(input.name, input.cron, input.prompt);
      case "list_tasks": return listTasks();
      case "delete_task": return deleteTask(input.id);
      case "start_service": return services.start(input.name, input.command, input.cwd);
      case "stop_service": return services.stop(input.name);
      case "list_services": return { services: services.list() };
      case "service_logs": return services.logs(input.name);
      default: return { error: `Unbekanntes Tool: ${name}` };
    }
  } catch (err) {
    return { error: String(err?.message || err) };
  }
}

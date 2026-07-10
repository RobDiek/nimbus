// Nimbus Console – Frontend (zo-Style)
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = {
  async get(p) { return (await fetch(p)).json(); },
  async post(p, b) { return (await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json(); },
};
const esc = (s) => String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const icon = (name, cls = "ic") => `<svg class="${cls}"><use href="#i-${name}"/></svg>`;
const LOGO = `<svg viewBox="0 0 24 24" style="width:16px;height:16px"><path d="M6.5 17.5c-2.2 0-4-1.8-4-4 0-1.9 1.3-3.4 3-3.9C5.8 6.9 8.1 5 11 5c2.6 0 4.8 1.6 5.6 3.9 2.1.2 3.9 2 3.9 4.3 0 2.4-1.9 4.3-4.3 4.3h-9.7z" fill="currentColor" stroke="none"/></svg>`;

let state = { sessionId: null, personaId: null, streaming: false, showAllChats: false };

/* ============ Navigation ============ */
function switchView(v) {
  $$(".nav-item").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
  $$(".view").forEach((x) => x.classList.toggle("active", x.dataset.view === v));
  onViewOpen(v);
}
$$(".nav-item").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) switchView(g.dataset.goto);
});

function onViewOpen(v) {
  if (v === "space") loadSpace();
  if (v === "files") loadFiles(".");
  if (v === "hosting") loadServices();
  if (v === "automations") loadTasks();
  if (v === "skills") loadPersonas();
  if (v === "integrations") loadIntegrations();
  if (v === "terminal") initTerminal();
  if (v === "start") $("#input").focus();
}

/* ============ Status / Header ============ */
async function initStatus() {
  const [s, sys] = await Promise.all([api.get("/api/status"), api.get("/api/sysinfo")]);
  $("#bCores").innerHTML = `${icon("cpu")}${sys.cores} cores`;
  $("#bMem").innerHTML = `${icon("ram")}${sys.mem_gb} GB`;
  const kb = $("#bKey");
  kb.textContent = s.hasKey ? "● verbunden" : "● kein Key";
  kb.className = "hbadge key-badge " + (s.hasKey ? "ok" : "bad");
  $("#noKeyBanner").hidden = s.hasKey;
  $("#send").disabled = !s.hasKey && !$("#input").value.trim() ? $("#send").disabled : $("#send").disabled;
  await fillPersonaSelect();
  await loadRecent();
}

async function fillPersonaSelect() {
  const { personas } = await api.get("/api/personas");
  const sel = $("#personaSel");
  sel.innerHTML = personas.map((p) => `<option value="${p.id}">${esc(p.name)}${p.model ? " · " + esc(p.model) : ""}</option>`).join("");
  if (personas[0] && !state.personaId) state.personaId = personas[0].id;
  sel.value = state.personaId;
  sel.onchange = () => { state.personaId = Number(sel.value); };
}

/* ============ Recent Chats ============ */
async function loadRecent(filter = "") {
  const { sessions } = await api.get("/api/sessions");
  const list = $("#recentList");
  const shown = sessions
    .filter((s) => !filter || s.title.toLowerCase().includes(filter.toLowerCase()))
    .slice(0, state.showAllChats ? 200 : 8);
  list.innerHTML = "";
  shown.forEach((s) => {
    const b = document.createElement("button");
    b.className = "recent-item" + (s.id === state.sessionId ? " active" : "");
    b.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis">${esc(s.title)}</span><span class="del" title="Löschen">${icon("x")}</span>`;
    b.onclick = (e) => {
      if (e.target.closest(".del")) return deleteSession(s.id);
      openSession(s.id);
    };
    list.appendChild(b);
  });
}
$("#chatSearch").addEventListener("input", (e) => loadRecent(e.target.value));
$("#viewAll").onclick = () => { state.showAllChats = !state.showAllChats; loadRecent($("#chatSearch").value); };

async function deleteSession(id) {
  await api.post("/api/sessions/delete", { id });
  if (state.sessionId === id) newChat();
  loadRecent();
}

async function openSession(id) {
  state.sessionId = id;
  switchView("start");
  const { messages } = await api.get("/api/messages?session_id=" + id);
  const area = $("#chatArea");
  area.classList.remove("empty");
  const box = $("#messages");
  box.innerHTML = "";
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") addUserMsg(m.content);
      // Array-Content = interne tool_results → nicht anzeigen
    } else {
      const bubble = addAssistantShell();
      for (const block of m.content) {
        if (block.type === "text" && block.text.trim()) appendText(bubble, block.text);
        if (block.type === "tool_use") bubble.appendChild(toolCallEl(block.name, block.input, false));
      }
    }
  }
  box.scrollTop = box.scrollHeight;
  loadRecent();
}

/* ============ Chat ============ */
const messagesEl = $("#messages");
const inputEl = $("#input");
const sendBtn = $("#send");

const CHIP_SETS = [
  [
    { i: "doc", t: "Erstelle eine Status-Seite und hoste sie" },
    { i: "term", t: "Zeig mir die Systemauslastung" },
    { i: "clock", t: "Plane ein tägliches Briefing um 8 Uhr" },
  ],
  [
    { i: "search", t: "Recherchiere die neuesten Bun-Releases" },
    { i: "file", t: "Schreibe ein Python-Skript und führe es aus" },
    { i: "server", t: "Starte einen Webserver auf Port 8080" },
  ],
  [
    { i: "brain", t: "Merke dir: Ich arbeite mit Hetzner & M365" },
    { i: "globe", t: "Extrahiere den Text von anthropic.com" },
    { i: "folder", t: "Räume meinen Workspace auf" },
  ],
];
let chipIdx = 0;
function renderChips() {
  $("#chipList").innerHTML = CHIP_SETS[chipIdx].map((c) =>
    `<button class="chip">${icon(c.i)}${esc(c.t)}</button>`).join("");
  $$("#chipList .chip").forEach((b, i) =>
    b.onclick = () => sendMessage(CHIP_SETS[chipIdx][i].t));
}
$("#chipRefresh").onclick = () => { chipIdx = (chipIdx + 1) % CHIP_SETS.length; renderChips(); };
$("#chipHide").onclick = () => $("#chips").style.display = "none";
renderChips();

function addUserMsg(text) {
  const w = document.createElement("div");
  w.className = "msg user";
  w.innerHTML = `<div class="av">Du</div><div class="bubble"><div class="text"></div></div>`;
  w.querySelector(".text").textContent = text;
  messagesEl.appendChild(w);
  return w;
}
function addAssistantShell() {
  const w = document.createElement("div");
  w.className = "msg assistant";
  w.innerHTML = `<div class="av">${LOGO}</div><div class="bubble"><div class="who">Nimbus</div></div>`;
  messagesEl.appendChild(w);
  return w.querySelector(".bubble");
}
function appendText(bubble, text) {
  const d = document.createElement("div");
  d.className = "text";
  d.innerHTML = esc(text).replace(/`([^`]+)`/g, "<code>$1</code>");
  bubble.appendChild(d);
}
function toolCallEl(name, input, running = true) {
  const d = document.createElement("div");
  d.className = "tool-call" + (running ? " running" : "");
  d.innerHTML = `<div class="tc-head">${icon("gear")}<b>${esc(name)}</b><svg class="ic arrow"><use href="#i-chev"/></svg></div><div class="tc-body">${esc(JSON.stringify(input, null, 2))}</div>`;
  d.querySelector(".tc-head").onclick = () => d.classList.toggle("open");
  return d;
}

async function sendMessage(text) {
  if (!text.trim() || state.streaming) return;
  state.streaming = true;
  sendBtn.disabled = true;
  $("#chatArea").classList.remove("empty");
  addUserMsg(text);
  inputEl.value = ""; inputEl.style.height = "auto";

  const bubble = addAssistantShell();
  const typing = document.createElement("div");
  typing.className = "typing"; typing.innerHTML = "<i></i><i></i><i></i>";
  bubble.appendChild(typing);
  messagesEl.scrollTop = messagesEl.scrollHeight;

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, session_id: state.sessionId, persona_id: state.personaId }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop();
      for (const part of parts) {
        const line = part.replace(/^data: /, "");
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        typing.remove();
        if (e.type === "session") { state.sessionId = e.session_id; loadRecent(); }
        else if (e.type === "text") appendText(bubble, e.text);
        else if (e.type === "tool_use") bubble.appendChild(toolCallEl(e.name, e.input));
        else if (e.type === "tool_result") {
          const last = bubble.querySelector(".tool-call.running");
          if (last) {
            last.classList.remove("running");
            last.querySelector(".tc-body").textContent += "\n→ " + JSON.stringify(e.result, null, 2).slice(0, 4000);
          }
        }
        else if (e.type === "error") {
          const err = document.createElement("div");
          err.className = "text err-text";
          err.textContent = "⚠ " + e.error;
          bubble.appendChild(err);
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      }
    }
  } catch (err) {
    typing.remove();
    const d = document.createElement("div");
    d.className = "text err-text";
    d.textContent = "⚠ Verbindungsfehler: " + err.message;
    bubble.appendChild(d);
  } finally {
    state.streaming = false;
    sendBtn.disabled = !inputEl.value.trim();
    inputEl.focus();
  }
}

sendBtn.onclick = () => sendMessage(inputEl.value);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(inputEl.value); }
});
inputEl.addEventListener("input", () => {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 200) + "px";
  sendBtn.disabled = !inputEl.value.trim() || state.streaming;
});
function newChat() {
  state.sessionId = null;
  messagesEl.innerHTML = "";
  $("#chatArea").classList.add("empty");
  $("#chips").style.display = "";
  switchView("start");
  loadRecent();
}
$("#newChat").onclick = newChat;

/* ============ Terminal (WebSocket, persistente Session) ============ */
let term = { ws: null, booted: false, hist: [], histIdx: -1 };
const termOut = $("#termOut");
const termCmd = $("#termCmd");

function tPrint(text, cls = "") {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = text;
  termOut.appendChild(d);
  termOut.scrollTop = termOut.scrollHeight;
}

const BOOT_LINES = [
  ["NimbusOS 1.0 — virtuelles System wird gestartet …", "t-sys", 0],
  ["[  OK  ] Kernel geladen (bun " + "runtime)", "t-ok", 260],
  ["[  OK  ] Dateisystem eingehängt  →  /workspace", "t-ok", 480],
  ["[  OK  ] Netzwerk verbunden", "t-ok", 680],
  ["[  OK  ] Bash-Session bereit", "t-ok", 880],
  ["", "", 1000],
];

function initTerminal() {
  termCmd.focus();
  if (term.ws && term.ws.readyState === WebSocket.OPEN) return;

  if (!term.booted) {
    term.booted = true;
    BOOT_LINES.forEach(([txt, cls, delay]) => setTimeout(() => tPrint(txt, cls), delay));
  }

  setTimeout(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/term`);
    term.ws = ws;
    ws.onopen = () => {
      $("#termStatus").textContent = "verbunden";
      $("#termStatus").classList.add("on");
    };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "out") {
        // ANSI-Sequenzen entfernen
        const clean = m.data.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
        if (clean) tPrint(clean.replace(/\n$/, ""), m.kind === "err" ? "t-err" : "");
      }
      if (m.type === "exit") tPrint(`[Prozess beendet mit Code ${m.code}]`, "t-sys");
    };
    ws.onclose = () => {
      $("#termStatus").textContent = "getrennt — Enter zum Neuverbinden";
      $("#termStatus").classList.remove("on");
      term.ws = null;
    };
    // Keepalive
    const ka = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      else clearInterval(ka);
    }, 60000);
  }, term.booted && termOut.children.length > 6 ? 0 : 1100);
}

termCmd.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (term.histIdx < term.hist.length - 1) termCmd.value = term.hist[++term.histIdx] || "";
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (term.histIdx > 0) termCmd.value = term.hist[--term.histIdx] || "";
    else { term.histIdx = -1; termCmd.value = ""; }
    return;
  }
  if (e.key !== "Enter") return;
  const cmd = termCmd.value;
  termCmd.value = "";
  term.histIdx = -1;
  if (!term.ws || term.ws.readyState !== WebSocket.OPEN) { initTerminal(); return; }
  if (!cmd.trim()) { tPrint("nimbus:~$", "t-cmd"); return; }
  term.hist.unshift(cmd);
  tPrint("nimbus:~$ " + cmd, "t-cmd");
  term.ws.send(JSON.stringify({ type: "cmd", cmd }));
});

/* ============ Mein Space ============ */
async function loadSpace() {
  const [sys, s] = await Promise.all([api.get("/api/sysinfo"), api.get("/api/settings")]);
  const up = sys.uptime_s > 3600 ? Math.floor(sys.uptime_s / 3600) + " h" : Math.floor(sys.uptime_s / 60) + " min";
  $("#statGrid").innerHTML = `
    <div class="stat"><div class="k">${icon("cpu")}CPU</div><div class="v">${sys.cores} <small>Cores</small></div></div>
    <div class="stat"><div class="k">${icon("ram")}Arbeitsspeicher</div><div class="v">${sys.mem_gb} <small>GB</small></div></div>
    <div class="stat"><div class="k">${icon("clock")}Uptime</div><div class="v">${up}</div></div>
    <div class="stat"><div class="k">${icon("term")}System</div><div class="v">${esc(sys.platform)} <small>${esc(sys.arch)}</small></div></div>`;
  $("#modelSel").value = s.model || "claude-sonnet-5";
  $("#apiKey").placeholder = s.hasKey ? "•••••••• (gesetzt) — neu eingeben zum Ändern" : "sk-ant-…";
  loadMemory();
}
$("#saveSettings").onclick = async () => {
  await api.post("/api/settings", { apiKey: $("#apiKey").value, model: $("#modelSel").value });
  $("#apiKey").value = "";
  $("#settingsMsg").textContent = "✓ Gespeichert";
  initStatus();
  setTimeout(() => $("#settingsMsg").textContent = "", 2500);
};

async function loadMemory() {
  const { memories } = await api.get("/api/memories");
  const list = $("#memList");
  list.innerHTML = memories.length ? "" : `<p class="mut">Noch nichts gemerkt.</p>`;
  memories.forEach((m) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><p style="color:var(--txt)">${esc(m.content)}</p>
      <div class="meta">${esc(m.tags || "")} · ${esc(m.created_at)}</div></div>
      <button class="icon-btn danger">${icon("trash")}</button>`;
    c.querySelector(".icon-btn").onclick = async () => { await api.post("/api/memories/delete", { id: m.id }); loadMemory(); };
    list.appendChild(c);
  });
}
$("#memAdd").onclick = async () => {
  const content = $("#memContent").value.trim(); if (!content) return;
  await api.post("/api/memories", { content, tags: $("#memTags").value.trim() });
  $("#memContent").value = ""; $("#memTags").value = ""; loadMemory();
};

/* ============ Dateien ============ */
let openPath = null;
async function loadFiles(path) {
  const r = await api.get("/api/files?path=" + encodeURIComponent(path));
  $("#filePath").textContent = r.path || path;
  const list = $("#fileList");
  list.innerHTML = "";
  if (r.path && r.path !== "/" && path !== ".") {
    const up = document.createElement("div");
    up.className = "file-item";
    up.innerHTML = `${icon("chev")}..`;
    up.querySelector(".ic").style.transform = "rotate(180deg)";
    up.onclick = () => {
      const parent = r.path.split("/").slice(0, -1).join("/") || "/";
      loadFiles(parent);
    };
    list.appendChild(up);
  }
  (r.entries || []).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1))
    .forEach((en) => {
      const it = document.createElement("div");
      it.className = "file-item" + (en.type === "dir" ? " dir" : "");
      it.innerHTML = `${icon(en.type === "dir" ? "folder" : "file")}${esc(en.name)}<span class="sz">${en.type === "file" ? fmtSize(en.size) : ""}</span>`;
      it.onclick = () => {
        const full = r.path + "/" + en.name;
        en.type === "dir" ? loadFiles(full) : openFile(full, en.name);
      };
      list.appendChild(it);
    });
}
function fmtSize(b) { return b < 1024 ? b + " B" : b < 1048576 ? (b / 1024).toFixed(1) + " K" : (b / 1048576).toFixed(1) + " M"; }
async function openFile(path, name) {
  const r = await api.get("/api/file?path=" + encodeURIComponent(path));
  if (r.error) { $("#fileContent").value = ""; $("#editorName").textContent = r.error; return; }
  openPath = path;
  $("#editorName").textContent = name;
  $("#fileContent").value = r.content;
  $("#saveFile").disabled = false;
}
$("#saveFile").onclick = async () => {
  if (!openPath) return;
  await api.post("/api/file", { path: openPath, content: $("#fileContent").value });
  $("#editorName").textContent = $("#editorName").textContent.replace(" ✓", "") + " ✓";
};

/* ============ Hosting (Services) ============ */
async function loadServices() {
  const { services } = await api.get("/api/services");
  const list = $("#svcList");
  list.innerHTML = services.length ? "" : `<p class="mut">Noch keine Services. Starte einen oben oder per Chat.</p>`;
  services.forEach((s) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><h3>${esc(s.name)} <span class="badge ${s.status}">${s.status === "running" ? "läuft" : "gestoppt"}</span></h3>
      <p class="mono">${esc(s.command)}</p>${s.pid ? `<div class="meta">PID ${s.pid}</div>` : ""}</div>
      <div style="display:flex;gap:6px">
        <button class="icon-btn" data-a="logs">${icon("doc")}Logs</button>
        <button class="icon-btn" data-a="toggle">${icon(s.status === "running" ? "stop" : "play")}${s.status === "running" ? "Stop" : "Start"}</button>
        <button class="icon-btn danger" data-a="rm">${icon("trash")}</button>
      </div>`;
    c.querySelector('[data-a="logs"]').onclick = () => showLogs(s.name);
    c.querySelector('[data-a="toggle"]').onclick = async () => {
      if (s.status === "running") await api.post("/api/services/stop", { name: s.name });
      else await api.post("/api/services/start", { name: s.name, command: s.command, cwd: s.cwd });
      loadServices();
    };
    c.querySelector('[data-a="rm"]').onclick = async () => { await api.post("/api/services/remove", { name: s.name }); loadServices(); };
    list.appendChild(c);
  });
}
async function showLogs(name) {
  $("#logTitle").textContent = "Logs · " + name;
  const r = await api.get("/api/services/logs?name=" + encodeURIComponent(name));
  $("#svcLogs").textContent = r.logs ? r.logs.join("\n") : (r.error || "Keine Logs.");
}
$("#svcStart").onclick = async () => {
  const name = $("#svcName").value.trim(), command = $("#svcCmd").value.trim();
  if (!name || !command) return;
  await api.post("/api/services/start", { name, command });
  $("#svcName").value = ""; $("#svcCmd").value = "";
  loadServices();
};

/* ============ Automatisierungen ============ */
async function loadTasks() {
  const { tasks } = await api.get("/api/tasks");
  const list = $("#taskList");
  list.innerHTML = tasks.length ? "" : `<p class="mut">Noch keine Automatisierungen.</p>`;
  tasks.forEach((t) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><h3>${esc(t.name)} <span class="badge ${t.enabled ? "on" : "off"}">${t.enabled ? "aktiv" : "pausiert"}</span></h3>
      <p>${esc(t.prompt)}</p><div class="meta">cron ${esc(t.cron)}${t.last_run ? " · zuletzt " + esc(t.last_run) : ""}</div>
      ${t.last_result ? `<p class="mut" style="margin-top:6px">↳ ${esc(t.last_result.slice(0, 220))}</p>` : ""}</div>
      <div style="display:flex;gap:6px">
        <button class="icon-btn" data-a="toggle">${icon(t.enabled ? "stop" : "play")}${t.enabled ? "Pause" : "Aktivieren"}</button>
        <button class="icon-btn danger" data-a="del">${icon("trash")}</button>
      </div>`;
    c.querySelector('[data-a="toggle"]').onclick = async () => { await api.post("/api/tasks/toggle", { id: t.id }); loadTasks(); };
    c.querySelector('[data-a="del"]').onclick = async () => { await api.post("/api/tasks/delete", { id: t.id }); loadTasks(); };
    list.appendChild(c);
  });
}
$("#taskAdd").onclick = async () => {
  const name = $("#taskName").value.trim(), cron = $("#taskCron").value.trim(), prompt = $("#taskPrompt").value.trim();
  if (!name || !cron || !prompt) return;
  await api.post("/api/tasks", { name, cron, prompt });
  $("#taskName").value = ""; $("#taskCron").value = ""; $("#taskPrompt").value = "";
  loadTasks();
};

/* ============ Integrationen ============ */
const INTEGRATIONS = [
  { id: "gmail", name: "Gmail", color: "#ea4335", desc: "E-Mails lesen, durchsuchen und Entwürfe erstellen." },
  { id: "outlook", name: "Outlook", color: "#0078d4", desc: "Microsoft-365-Postfach & Kalender." },
  { id: "telegram", name: "Telegram", color: "#2aabee", desc: "Nachrichten senden und empfangen." },
  { id: "gcal", name: "Google Calendar", color: "#4285f4", desc: "Termine lesen, erstellen und verschieben." },
  { id: "slack", name: "Slack", color: "#611f69", desc: "Channels lesen und Nachrichten posten." },
  { id: "notion", name: "Notion", color: "#1c1f23", desc: "Seiten und Datenbanken bearbeiten." },
  { id: "github", name: "GitHub", color: "#24292f", desc: "Repos, Issues und Pull Requests." },
  { id: "gdrive", name: "Google Drive", color: "#0f9d58", desc: "Dateien suchen und lesen." },
  { id: "figma", name: "Figma", color: "#a259ff", desc: "Design-Kontext für den Agenten." },
];
async function loadIntegrations() {
  const s = await api.get("/api/settings");
  const conn = s.integrations || {};
  const grid = $("#intGrid");
  grid.innerHTML = "";
  INTEGRATIONS.forEach((it) => {
    const isOn = !!conn[it.id];
    const c = document.createElement("div");
    c.className = "int-card";
    c.innerHTML = `<div class="int-head"><span class="int-logo" style="background:${it.color}">${esc(it.name[0])}</span>
      <h3>${esc(it.name)}</h3></div>
      <p>${esc(it.desc)}</p>
      <div class="int-foot">
        <span class="badge ${isOn ? "on" : "off"}">${isOn ? "verbunden" : "nicht verbunden"}</span>
        <button class="btn ${isOn ? "" : "dark"}">${isOn ? "Trennen" : "Verbinden"}</button>
      </div>`;
    c.querySelector(".btn").onclick = async () => {
      conn[it.id] = !isOn;
      await api.post("/api/settings", { integrations: conn });
      loadIntegrations();
    };
    grid.appendChild(c);
  });
}

/* ============ Fähigkeiten (Personas) ============ */
async function loadPersonas() {
  const { personas } = await api.get("/api/personas");
  const list = $("#personaList");
  list.innerHTML = "";
  personas.forEach((p) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<span class="avatar-initial">${esc(p.name[0] || "?")}</span>
      <div class="grow"><h3>${esc(p.name)} ${p.model ? `<span class="badge off mono">${esc(p.model)}</span>` : ""}</h3>
      <p>${esc(p.system_prompt.slice(0, 200))}${p.system_prompt.length > 200 ? "…" : ""}</p></div>
      <div style="display:flex;gap:6px">
        <button class="icon-btn" data-a="edit">${icon("gear")}Bearbeiten</button>
        <button class="icon-btn danger" data-a="del">${icon("trash")}</button>
      </div>`;
    c.querySelector('[data-a="edit"]').onclick = () => {
      $("#pId").value = p.id; $("#pName").value = p.name;
      $("#pModel").value = p.model; $("#pPrompt").value = p.system_prompt;
      window.scrollTo(0, 0);
    };
    c.querySelector('[data-a="del"]').onclick = async () => { await api.post("/api/personas/delete", { id: p.id }); loadPersonas(); fillPersonaSelect(); };
    list.appendChild(c);
  });
}
$("#pSave").onclick = async () => {
  const name = $("#pName").value.trim(); if (!name) return;
  await api.post("/api/personas", {
    id: $("#pId").value || undefined, name,
    model: $("#pModel").value.trim(), system_prompt: $("#pPrompt").value,
  });
  $("#pClear").click(); loadPersonas(); fillPersonaSelect();
};
$("#pClear").onclick = () => { ["pId", "pName", "pModel", "pPrompt"].forEach((i) => $("#" + i).value = ""); };

/* ============ Browser ============ */
function loadUrl(asText = false) {
  let url = $("#urlInput").value.trim();
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  $("#urlInput").value = url;
  $("#browserHint").hidden = true;
  if (asText) {
    $("#browserFrame").hidden = true;
    const pre = $("#browserText");
    pre.hidden = false;
    pre.textContent = "Lade …";
    api.get("/api/webfetch?url=" + encodeURIComponent(url)).then((r) => {
      pre.textContent = r.error ? "Fehler: " + r.error : r.content;
    });
  } else {
    $("#browserText").hidden = true;
    const f = $("#browserFrame");
    f.hidden = false;
    f.src = url;
  }
}
$("#urlGo").onclick = () => loadUrl(false);
$("#urlText").onclick = () => loadUrl(true);
$("#urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadUrl(false); });

/* ============ Start ============ */
initStatus();
inputEl.focus();

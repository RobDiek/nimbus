// Nimbus Console – Frontend (zo-Style)
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = {
  async get(p) { return (await fetch(p)).json(); },
  async post(p, b) { return (await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json(); },
  async put(p, b) { return (await fetch(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json(); },
  async del(p, b) { return (await fetch(p, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json(); },
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

function initModelUIFromSettings(s) {
  // requirement: fully writeable text input, and "every model i type" must work
  // UI: dropdown (#modelSel) + text input (#modelCustomInput)
  const modelSel = $("#modelSel");
  const modelCustomInput = $("#modelCustomInput");
  const providerSel = $("#providerSel");
  if (providerSel && s?.provider) providerSel.value = s.provider;
  if ($("#customBaseUrl")) $("#customBaseUrl").value = s?.customBaseUrl || "";
  if (modelCustomInput) {
    modelCustomInput.style.display = "";
    modelCustomInput.value = (s?.model ?? modelCustomInput.value ?? "").toString();
  }
  if (modelSel) {
    const known = [
      "blackboxai/openai/gpt-oss-120b",
      "claude-sonnet-5",
      "gpt-4o-mini",
      "gemini-1.5-flash",
      "openai/gpt-4o-mini",
    ];
    const current = (s?.model ?? "").toString();
    const options = current && !known.includes(current) ? [current, ...known] : known;
    modelSel.innerHTML = options.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    modelSel.style.display = "";
    modelSel.value = current || options[0] || "";
  }
}

function ensureCustomInputAlwaysSane() {
  const modelCustomInput = $("#modelCustomInput");
  if (!modelCustomInput) return;
  if (!modelCustomInput.value && $("#modelSel")?.value) modelCustomInput.value = $("#modelSel").value;
}
$$(".nav-item").forEach((t) => t.addEventListener("click", () => switchView(t.dataset.view)));
document.addEventListener("click", (e) => {
  const g = e.target.closest("[data-goto]");
  if (g) switchView(g.dataset.goto);
});

function onViewOpen(v) {
  if (v === "space") loadSpace();
  if (v === "files") loadFiles(".");
  if (v === "hosting") { loadHosting(); loadVmPanel(); loadSpaceRoutes(); }
  if (v === "automations") loadTasks();
  if (v === "skills") { loadSkills(); loadPersonas(); }
  if (v === "integrations") loadIntegrations();
  if (v === "browser") loadBrowserSessions();
  if (v === "terminal") { initTerminal(); loadVmPanel(); loadVmJobs(); loadTermSessions(); }
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
  const { chats } = await api.get("/api/chats?q=" + encodeURIComponent(filter || "") + "&archived=false");
  const list = $("#recentList");
  const shown = (chats || [])
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
  await fetch("/api/chats/" + encodeURIComponent(id), { method: "DELETE" });
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
        else if (e.type === "backend") {
          const label = e.backend === "vm" ? "In-VM-Agent" : "Lokal";
          bubble.appendChild(Object.assign(document.createElement("div"), {
            className: "mut",
            textContent: `Backend: ${label}`,
          }));
        }
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

  initModelUIFromSettings(s);
  ensureCustomInputAlwaysSane();

  const chatBackendSel = $("#chatBackendSel");
  if (chatBackendSel && s?.chatBackend) chatBackendSel.value = s.chatBackend;

  // NOTE: this file is now missing the old provider/model dropdown logic; keep it minimal.
  // We only ensure the model input is editable and persists.
  loadMemory();
}
$("#saveSettings").onclick = async () => {
  // requirement: any model string user types must be sent as "model"
  const modelSel = $("#modelSel");
  const modelCustomInput = $("#modelCustomInput");

  let model = "";
  if (modelCustomInput && modelCustomInput.value?.trim()) model = modelCustomInput.value.trim();
  else if (modelSel && modelSel.value?.trim()) model = modelSel.value.trim();

  // preserve existing provider/key fields if they exist
  const provider = $("#providerSel")?.value || "anthropic";
  const anthropicApiKey = $("#apiKeyAnthropic")?.value || "";
  const openaiApiKey = $("#apiKeyOpenAI")?.value || "";
  const googleApiKey = $("#apiKeyGoogle")?.value || "";
  const customApiKey = $("#apiKeyCustom")?.value || "";
  const customBaseUrl = $("#customBaseUrl")?.value || "";
  const chatBackend = $("#chatBackendSel")?.value || "auto";

  await api.post("/api/settings", {
    provider,
    model,
    anthropicApiKey,
    openaiApiKey,
    googleApiKey,
    customApiKey,
    customBaseUrl,
    chatBackend,
  });

  if ($("#apiKeyAnthropic")) $("#apiKeyAnthropic").value = "";
  if ($("#apiKeyOpenAI")) $("#apiKeyOpenAI").value = "";
  if ($("#apiKeyGoogle")) $("#apiKeyGoogle").value = "";
  if ($("#apiKeyCustom")) $("#apiKeyCustom").value = "";

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

/* ============ Hosting (Supervisor + Services) ============ */
async function loadHosting() {
  const [{ services }, { deployments }] = await Promise.all([
    api.get("/api/services"),
    api.get("/api/hosting/deployments"),
  ]);
  const latest = new Map();
  (deployments || []).forEach((d) => {
    if (!latest.has(d.service_name)) latest.set(d.service_name, d);
  });
  const list = $("#svcList");
  list.innerHTML = services.length ? "" : `<p class="mut">Noch keine Services. Starte einen oben oder per Chat.</p>`;
  services.forEach((s) => {
    const dep = latest.get(s.name);
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><h3>${esc(s.name)} <span class="badge ${s.status}">${s.status === "running" ? "läuft" : "gestoppt"}</span></h3>
      <p class="mono">${esc(s.command)}</p>
      ${dep ? `<div class="meta">v${dep.version} · health ${esc(dep.health_status)}${dep.public_url ? " · " + esc(dep.public_url) : ""}${dep.https_url ? " · " + esc(dep.https_url) : ""}</div>` : ""}
      ${s.pid ? `<div class="meta">PID ${s.pid}</div>` : ""}</div>
      <div style="display:flex;gap:6px">
        <button class="icon-btn" data-a="logs">${icon("doc")}Logs</button>
        <button class="icon-btn" data-a="health">${icon("pulse")}Health</button>
        <button class="icon-btn" data-a="rollback">${icon("refresh")}Rollback</button>
        <button class="icon-btn" data-a="toggle">${icon(s.status === "running" ? "stop" : "play")}${s.status === "running" ? "Stop" : "Start"}</button>
        <button class="icon-btn danger" data-a="rm">${icon("trash")}</button>
      </div>`;
    c.querySelector('[data-a="logs"]').onclick = () => showLogs(s.name);
    c.querySelector('[data-a="health"]').onclick = async () => { await api.post("/api/hosting/health", { name: s.name }); loadHosting(); };
    c.querySelector('[data-a="rollback"]').onclick = async () => { await api.post("/api/hosting/rollback", { name: s.name }); loadHosting(); };
    c.querySelector('[data-a="toggle"]').onclick = async () => {
      if (s.status === "running") await api.post("/api/services/stop", { name: s.name });
      else await api.post("/api/services/start", { name: s.name, command: s.command, cwd: s.cwd });
      loadHosting();
    };
    c.querySelector('[data-a="rm"]').onclick = async () => { await api.post("/api/services/remove", { name: s.name }); loadHosting(); };
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
  const port = Number($("#svcPort").value.trim()) || undefined;
  await api.post("/api/hosting/deploy", { name, command, port });
  $("#svcName").value = ""; $("#svcCmd").value = ""; $("#svcPort").value = "";
  loadHosting();
};

/* ============ Workspace-VM + Ingress ============ */
function formatVmStatus(vm, ingress, configured) {
  if (!vm) {
    return configured === false
      ? "Proxmox nicht konfiguriert (PROXMOX_ENABLED=false).\nCLI: scripts/host/create_workspace.sh"
      : "Keine VM für diesen Tenant.\n„VM erstellen“ startet die Provisionierung.";
  }
  const lines = [
    `state=${vm.state || "?"}  vmid=${vm.vmid ?? "—"}  node=${vm.node || "—"}`,
    `ip=${vm.ip_address || "—"}  user=${vm.username || "ubuntu"}  bridge=vmbr1`,
  ];
  if (vm.public_hostname || vm.public_url) {
    lines.push(`fqdn=${vm.public_hostname || "—"}  url=${vm.public_url || "—"}`);
  }
  if (ingress?.ports) {
    const p = ingress.ports;
    lines.push(`WAN ${p.wan_ip}: SSH :${p.ssh.public}  Space :${p.space.public}  Agent :${p.agent.public}`);
    lines.push(`Space-URL (Portforward): ${p.space.url}`);
  } else if (ingress?.hostname) {
    lines.push(`Hostname: ${ingress.hostname}`);
    lines.push(`DNS: Cloudflare auto → ${ingress.cloudflare?.wanIp || "WAN"} (Zoraxy Host→Origin manuell)`);
  }
  if (vm.last_error) lines.push(`error: ${vm.last_error}`);
  return lines.join("\n");
}

async function loadVmPanel() {
  const [st, ingress] = await Promise.all([
    api.get("/api/vm/status"),
    api.get("/api/ingress/status"),
  ]);
  const vm = st.vm;
  const text = formatVmStatus(vm, ingress, st.configured);
  const box = $("#vmStatusBox");
  const boxT = $("#vmStatusBoxTerm");
  const quick = $("#vmQuickStatus");
  if (box) box.textContent = text;
  if (boxT) {
    boxT.style.display = "";
    boxT.textContent = text;
  }
  if (quick) {
    quick.textContent = vm
      ? `${vm.state || "?"} · ${vm.ip_address || "keine IP"} · vmid ${vm.vmid ?? "—"}`
      : (st.configured === false ? "Proxmox aus" : "kein VM zugewiesen");
  }
}

async function loadVmJobs() {
  const sel = $("#vmJobSel");
  if (!sel) return;
  const { jobs } = await api.get("/api/vm/jobs");
  sel.innerHTML = (jobs || []).map((j) =>
    `<option value="${esc(j.id)}">${esc(j.status)} · ${esc(j.type)} · ${esc(j.id)}</option>`
  ).join("") || `<option value="">keine Jobs</option>`;
}

async function loadTermSessions() {
  const sel = $("#termSessionSel");
  if (!sel) return;
  const { sessions } = await api.get("/api/vm/terminal/sessions");
  sel.innerHTML = (sessions || []).map((s) =>
    `<option value="${esc(s.id)}">${esc(s.status)} · ${esc(s.mode || "local")} · ${esc(s.id)}</option>`
  ).join("") || `<option value="">keine Sessions</option>`;
}

async function vmAction(action) {
  const map = { create: "/api/vm/create", start: "/api/vm/start", stop: "/api/vm/stop" };
  const path = map[action];
  if (!path) return;
  const r = await api.post(path, {});
  if (r.error) alert(r.error);
  await loadVmPanel();
  await loadVmJobs();
}

function wireVmButtons() {
  const pairs = [
    ["vmCreateBtn", "create"], ["vmCreateBtnH", "create"],
    ["vmStartBtn", "start"], ["vmStartBtnH", "start"],
    ["vmStopBtn", "stop"], ["vmStopBtnH", "stop"],
  ];
  pairs.forEach(([id, action]) => {
    const el = $("#" + id);
    if (el) el.onclick = () => vmAction(action);
  });
  ["vmRefreshBtn", "vmRefreshBtnH"].forEach((id) => {
    const el = $("#" + id);
    if (el) el.onclick = () => { loadVmPanel(); loadVmJobs(); };
  });
  const cancel = $("#vmCancelJobBtn");
  if (cancel) {
    cancel.onclick = async () => {
      const id = $("#vmJobSel")?.value;
      if (!id) return;
      await api.post("/api/vm/jobs/cancel", { job_id: id });
      loadVmJobs();
    };
  }
  const refreshJobs = $("#vmRefreshJobsBtn");
  if (refreshJobs) refreshJobs.onclick = () => loadVmJobs();
  const recon = $("#termReconnectBtn");
  if (recon) recon.onclick = () => { term.ws?.close(); term.ws = null; initTerminal(); };
  const refreshSess = $("#termRefreshSessionsBtn");
  if (refreshSess) refreshSess.onclick = () => loadTermSessions();
}
wireVmButtons();

/* ============ Space-Routen (PaaS) ============ */
async function loadSpaceRoutes() {
  const list = $("#spaceRouteList");
  if (!list) return;
  const r = await api.get("/api/space/routes");
  const routes = r.routes || [];
  list.innerHTML = routes.length ? "" : `<p class="mut">Noch keine Space-Routen. Lege oben eine an (z. B. /api/hello).</p>`;
  routes.forEach((route) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><h3><span class="mono">${esc(route.path)}</span>
      <span class="badge ${route.public === false ? "off" : "on"}">${route.public === false ? "privat" : "public"}</span>
      <span class="badge off">${esc(route.type)}</span></h3>
      <div class="meta">${esc(route.file || "")}${route.updated_at ? " · " + esc(route.updated_at) : ""}</div></div>
      <div style="display:flex;gap:6px">
        <button class="icon-btn" data-a="edit">${icon("gear")}Laden</button>
        <button class="icon-btn danger" data-a="del">${icon("trash")}</button>
      </div>`;
    c.querySelector('[data-a="edit"]').onclick = () => {
      $("#spacePath").value = route.path;
      $("#spaceType").value = route.type || "api";
      $("#spacePublic").checked = route.public !== false;
      $("#spaceMsg").textContent = "Route geladen — Code ggf. in Dateien bearbeiten oder neu speichern.";
    };
    c.querySelector('[data-a="del"]').onclick = async () => {
      await api.del("/api/space/routes", { path: route.path });
      loadSpaceRoutes();
    };
    list.appendChild(c);
  });
}

function wireSpaceUi() {
  const save = $("#spaceSaveBtn");
  if (save) {
    save.onclick = async () => {
      const path = $("#spacePath").value.trim();
      const code = $("#spaceCode").value;
      if (!path || !code) { $("#spaceMsg").textContent = "Pfad und Code nötig."; return; }
      const r = await api.post("/api/space/routes", {
        path,
        route_type: $("#spaceType").value,
        code,
        public: $("#spacePublic").checked,
      });
      $("#spaceMsg").textContent = r.error ? r.error : `Gespeichert: ${r.route?.path || path}`;
      if (!r.error) loadSpaceRoutes();
    };
  }
  const refresh = $("#spaceRefreshBtn");
  if (refresh) refresh.onclick = () => loadSpaceRoutes();
}
wireSpaceUi();

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
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        <button class="icon-btn" data-a="run">${icon("play")}Jetzt ausführen</button>
        <button class="icon-btn" data-a="toggle">${icon(t.enabled ? "stop" : "play")}${t.enabled ? "Pause" : "Aktivieren"}</button>
        <button class="icon-btn danger" data-a="del">${icon("trash")}</button>
      </div>`;
    c.querySelector('[data-a="run"]').onclick = async () => {
      const btn = c.querySelector('[data-a="run"]');
      btn.disabled = true;
      await api.post("/api/tasks/run", { id: t.id });
      btn.disabled = false;
      loadTasks();
    };
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
const INT_META = {
  gmail: ["#ea4335", "E-Mails lesen, durchsuchen und Entwürfe erstellen."],
  outlook: ["#0078d4", "Microsoft-365-Postfach & Kalender."],
  telegram: ["#2aabee", "Bot-Nachrichten senden und empfangen."],
  gcal: ["#4285f4", "Termine lesen, erstellen und verschieben."],
  slack: ["#611f69", "Channels lesen und Nachrichten posten."],
  github: ["#24292f", "Repos, Issues und Pull Requests."],
  gdrive: ["#0f9d58", "Dateien suchen und lesen."],
};
async function loadIntegrations() {
  const { providers } = await api.get("/api/oauth/providers");
  const grid = $("#intGrid");
  grid.innerHTML = "";
  (providers || []).forEach((it) => {
    const [color, desc] = INT_META[it.id] || ["#4b5563", "OAuth-Integration"];
    const isOn = it.status === "connected";
    const c = document.createElement("div");
    c.className = "int-card";
    c.innerHTML = `<div class="int-head"><span class="int-logo" style="background:${color}">${esc(it.name[0])}</span>
      <h3>${esc(it.name)}</h3></div>
      <p>${esc(desc)}</p>
      <div class="int-foot">
        <span class="badge ${isOn ? "on" : "off"}">${isOn ? "verbunden" : (it.configured ? "bereit" : "Client fehlt")}</span>
        <button class="btn ${isOn ? "" : "dark"}">${isOn ? "Trennen" : "Verbinden"}</button>
      </div>`;
    c.querySelector(".btn").onclick = async () => {
      if (isOn) await api.post("/api/oauth/disconnect", { provider: it.id });
      else {
        const r = await api.post("/api/oauth/start", { provider: it.id, redirect_uri: location.origin + "/api/oauth/callback" });
        if (r.auth_url) window.open(r.auth_url, "_blank", "noopener");
        else alert(r.error || r.setup || "OAuth nicht konfiguriert.");
      }
      loadIntegrations();
    };
    grid.appendChild(c);
  });
}

/* ============ Fähigkeiten (SKILL.md + Personas) ============ */
async function loadSkillDetail(id) {
  const out = $("#skillTestOut");
  const r = await api.get("/api/skills/" + encodeURIComponent(id));
  if (r.error || !r.skill) {
    out.textContent = "Fehler: " + (r.error || "Skill nicht gefunden");
    return;
  }
  $("#skillDetailId").value = r.skill.id;
  $("#skillContent").value = r.skill.content || "";
  out.textContent = `Skill geladen: ${r.skill.name}\nScopes: ${(r.skill.scopes || []).join(", ")}\nTriggers: ${(r.skill.triggers || []).join(", ")}`;
}

async function loadSkills() {
  const { skills } = await api.get("/api/skills");
  const list = $("#skillList");
  list.innerHTML = skills?.length ? "" : `<p class="mut">Noch keine SKILL.md importiert. Lege einen Skill an oder scanne workspace/skills.</p>`;
  (skills || []).forEach((s) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<span class="avatar-initial">${esc(s.name[0] || "S")}</span>
      <div class="grow"><h3>${esc(s.name)} <span class="badge ${s.enabled ? "on" : "off"}">${s.enabled ? "aktiv" : "aus"}</span></h3>
      <p>${esc(s.description || "Keine Beschreibung")}</p>
      <div class="meta">${esc((s.scopes || []).join(", "))}${s.source_path ? " · " + esc(s.source_path) : ""}</div></div>
      <div style="display:flex;gap:6px">
        <button class="icon-btn" data-a="detail">Details</button>
        <button class="icon-btn" data-a="toggle">${s.enabled ? "Deaktivieren" : "Aktivieren"}</button>
      </div>`;
    c.querySelector('[data-a="detail"]').onclick = async () => {
      await loadSkillDetail(s.id);
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    };
    c.querySelector('[data-a="toggle"]').onclick = async () => {
      await api.post("/api/skills/toggle", { id: s.id, enabled: !s.enabled });
      loadSkills();
    };
    list.appendChild(c);
  });
}
$("#skillScan").onclick = async () => { await api.post("/api/skills/scan"); loadSkills(); };
$("#skillCreate").onclick = async () => {
  const name = $("#skillName").value.trim();
  if (!name) return;
  await api.post("/api/skills", {
    name,
    scopes: $("#skillScopes").value,
    rules: $("#skillRules").value,
  });
  $("#skillName").value = ""; $("#skillScopes").value = ""; $("#skillRules").value = "";
  loadSkills();
};

$("#skillLoadDetail").onclick = async () => {
  const id = $("#skillDetailId").value.trim();
  if (!id) return;
  await loadSkillDetail(id);
};

$("#skillSaveDetail").onclick = async () => {
  const id = $("#skillDetailId").value.trim();
  if (!id) return;
  const r = await api.post("/api/skills/update", {
    id: Number(id),
    content: $("#skillContent").value || "",
  });
  $("#skillTestOut").textContent = r.ok ? "SKILL.md gespeichert." : ("Fehler: " + (r.error || "update failed"));
  if (r.ok) loadSkills();
};

$("#skillTestRun").onclick = async () => {
  const id = $("#skillDetailId").value.trim();
  if (!id) return;
  const prompt = $("#skillTestPrompt").value.trim();
  const r = await api.post("/api/skills/test", {
    skill_id: Number(id),
    prompt,
  });
  if (r.ok) {
    const errors = (r.events || []).filter((e) => e.type === "error");
    $("#skillTestOut").textContent =
      `Test ok\nEvents: ${(r.events || []).length}\n` +
      (errors.length ? `Scope/Fehler:\n${errors.map((e) => JSON.stringify(e)).join("\n")}` : "Keine Fehler.");
  } else {
    $("#skillTestOut").textContent = `Test fehlgeschlagen:\n${r.error || "unknown"}\n\nEvents:\n${JSON.stringify(r.events || [], null, 2)}`;
  }
};

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
let browserState = { sessionId: null };
async function loadBrowserSessions() {
  const { sessions } = await api.get("/api/browser/sessions");
  const sel = $("#browserSessionSel");
  if (!sel) return;
  sel.innerHTML = (sessions || []).map((s) => `<option value="${esc(s.id)}">${esc(s.id)} · ${esc(s.title || s.current_url || "leer")}</option>`).join("");
  if (!browserState.sessionId && sessions?.[0]) browserState.sessionId = sessions[0].id;
  if (browserState.sessionId) sel.value = browserState.sessionId;
  sel.onchange = () => browserState.sessionId = sel.value;
}
function showBrowserText(text) {
  $("#browserHint").hidden = true;
  $("#browserFrame").hidden = true;
  const pre = $("#browserText");
  pre.hidden = false;
  pre.textContent = text || "";
}
async function loadUrl(asText = false) {
  let url = $("#urlInput").value.trim();
  if (!url) return;
  if (!/^https?:\/\//.test(url)) url = "https://" + url;
  $("#urlInput").value = url;
  $("#browserHint").hidden = true;
  const r = await api.post("/api/browser/open", { session_id: browserState.sessionId, url });
  if (r.session?.id) browserState.sessionId = r.session.id;
  await loadBrowserSessions();
  if (asText) {
    showBrowserText(r.error ? "Fehler: " + r.error : r.session?.text);
  } else {
    $("#browserText").hidden = true;
    const f = $("#browserFrame");
    f.hidden = false;
    f.src = r.session?.current_url || url;
  }
}
$("#urlGo").onclick = () => loadUrl(false);
$("#urlText").onclick = () => loadUrl(true);
$("#urlShot").onclick = async () => {
  if (!browserState.sessionId) return;
  const r = await api.post("/api/browser/screenshot", { session_id: browserState.sessionId });
  showBrowserText(r.screenshot_text || r.error || "");
};
$("#browserClick").onclick = async () => {
  if (!browserState.sessionId) return;
  const raw = $("#browserClickText").value.trim();
  const payload = /^\d+$/.test(raw) ? { session_id: browserState.sessionId, index: Number(raw) } : { session_id: browserState.sessionId, text: raw };
  const r = await api.post("/api/browser/click", payload);
  if (r.session?.id) browserState.sessionId = r.session.id;
  $("#urlInput").value = r.session?.current_url || $("#urlInput").value;
  showBrowserText(r.error ? "Fehler: " + r.error : r.session?.text);
  loadBrowserSessions();
};
$("#browserSubmit").onclick = async () => {
  if (!browserState.sessionId) return;
  let fields = {};
  try { fields = JSON.parse($("#browserFormFields").value || "{}"); } catch { alert("Form JSON ist ungueltig."); return; }
  const r = await api.post("/api/browser/submit", { session_id: browserState.sessionId, fields });
  if (r.session?.id) browserState.sessionId = r.session.id;
  $("#urlInput").value = r.session?.current_url || $("#urlInput").value;
  showBrowserText(r.error ? "Fehler: " + r.error : r.session?.text);
  loadBrowserSessions();
};
$("#urlInput").addEventListener("keydown", (e) => { if (e.key === "Enter") loadUrl(false); });

/* ============ Start ============ */
initStatus();
inputEl.focus();

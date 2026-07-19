// Nimbus Workspace — zo-ähnliche Cloud-IDE (kein Infra-Admin)
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const api = {
  async get(p) { return (await fetch(p)).json(); },
  async post(p, b) {
    return (await fetch(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json();
  },
  async del(p, b) {
    return (await fetch(p, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(b || {}) })).json();
  },
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const icon = (n) => `<svg class="ic"><use href="#i-${n}"/></svg>`;
const LOGO = `<svg viewBox="0 0 24 24" style="width:15px;height:15px"><path d="M6.5 17.5c-2.2 0-4-1.8-4-4 0-1.9 1.3-3.4 3-3.9C5.8 6.9 8.1 5 11 5c2.6 0 4.8 1.6 5.6 3.9 2.1.2 3.9 2 3.9 4.3 0 2.4-1.9 4.3-4.3 4.3h-9.7z" fill="currentColor" stroke="none"/></svg>`;

const VIEWS = ["chat", "files", "automations", "integrations", "skills", "browser", "sites", "terminal", "settings"];
let state = {
  sessionId: null, personaId: null, streaming: false,
  spaceBaseUrl: "", spaceHostname: "", filePath: ".", settingsTab: "ki",
  ux: { language: "de", compact_chat: false, show_tool_details: true },
};

/* ===== Navigation ===== */
function switchView(v, opts = {}) {
  const view = v === "hosting" ? "sites" : (v === "start" ? "chat" : v);
  if (!VIEWS.includes(view)) return;
  $$(".nav-item").forEach((x) => x.classList.toggle("active", x.dataset.view === view));
  $$(".panel.view").forEach((x) => x.classList.toggle("active", x.dataset.view === view));
  if (location.hash.replace(/^#\/?/, "") !== view) history.replaceState(null, "", `#${view}`);
  if (view === "settings" && opts.tab) openSettingsTab(opts.tab);
  onViewOpen(view);
}

function onViewOpen(v) {
  if (v === "chat") $("#input")?.focus();
  if (v === "files") loadFiles(state.filePath || ".");
  if (v === "automations") loadTasks();
  if (v === "integrations") loadIntegrations();
  if (v === "skills") { loadSkills(); loadPersonas(); }
  if (v === "browser") { /* noop */ }
  if (v === "sites") loadSpaceRoutes();
  if (v === "terminal") { toggleTerm(true); ensureTerm("full"); }
  if (v === "settings") loadSettingsAll();
}

document.addEventListener("click", (e) => {
  const nav = e.target.closest("[data-view]");
  if (nav && !nav.closest(".stab")) {
    e.preventDefault();
    const tab = nav.dataset.settingsTab;
    switchView(nav.dataset.view, tab ? { tab } : {});
  }
});
window.addEventListener("hashchange", () => {
  const h = (location.hash || "#chat").replace(/^#\/?/, "");
  switchView(h);
});

/* ===== Boot / Status ===== */
async function initStatus() {
  const s = await api.get("/api/status");
  $("#noKeyBanner").hidden = !!s.hasKey;
  if ($("#userPill")) $("#userPill").textContent = s.tenant || "nimbus";
  await fillPersonaSelect();
  await loadRecent();
  try {
    const ux = await api.get("/api/ux");
    if (ux?.ux) {
      state.ux = { ...state.ux, ...ux.ux };
      document.body.classList.toggle("compact-chat", !!state.ux.compact_chat);
    }
  } catch {}
  try {
    const ing = await api.get("/api/ingress/status");
    if (ing?.hostname) {
      state.spaceHostname = ing.hostname;
      state.spaceBaseUrl = `https://${ing.hostname}`;
    }
  } catch {}
}

async function fillPersonaSelect() {
  const { personas } = await api.get("/api/personas");
  const sel = $("#personaSel");
  if (!sel) return;
  sel.innerHTML = (personas || []).map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join("");
  if (personas?.[0] && !state.personaId) state.personaId = personas[0].id;
  if (state.personaId) sel.value = state.personaId;
  sel.onchange = () => { state.personaId = Number(sel.value); };
}

/* ===== Chats ===== */
async function loadRecent(filter = "") {
  const { chats } = await api.get("/api/chats?q=" + encodeURIComponent(filter || "") + "&archived=false");
  const list = $("#recentList");
  if (!list) return;
  list.innerHTML = "";
  (chats || []).slice(0, 50).forEach((s) => {
    const b = document.createElement("button");
    b.className = "recent-item" + (s.id === state.sessionId ? " active" : "");
    b.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis">${esc(s.title)}</span><span class="del">${icon("x")}</span>`;
    b.onclick = (e) => {
      if (e.target.closest(".del")) return deleteSession(s.id);
      openSession(s.id);
    };
    list.appendChild(b);
  });
}
$("#chatSearch")?.addEventListener("input", (e) => loadRecent(e.target.value));

async function deleteSession(id) {
  await fetch("/api/chats/" + id, { method: "DELETE" });
  if (state.sessionId === id) newChat();
  else loadRecent();
}

async function openSession(id) {
  state.sessionId = id;
  switchView("chat");
  const { messages } = await api.get("/api/messages?session_id=" + encodeURIComponent(id));
  $("#messages").innerHTML = "";
  $("#chatArea").classList.remove("empty");
  for (const m of messages || []) {
    if (m.role === "user") {
      const bubble = addMsg("user");
      if (typeof m.content === "string") bubble.textContent = m.content;
      else if (Array.isArray(m.content)) {
        const text = m.content.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
        bubble.textContent = text;
      }
    } else {
      const bubble = addMsg("assistant");
      if (typeof m.content === "string") appendMarkdown(bubble, m.content);
      else if (Array.isArray(m.content)) {
        m.content.forEach((b) => {
          if (b.type === "text" && b.text?.trim()) appendMarkdown(bubble, b.text);
          if (b.type === "tool_use" && state.ux?.show_tool_details !== false) {
            bubble.appendChild(toolCallEl(b.name, b.input, false));
          }
        });
      }
    }
  }
  updateShareBtn();
  loadRecent();
}

function newChat() {
  state.sessionId = null;
  $("#messages").innerHTML = "";
  $("#chatArea").classList.add("empty");
  switchView("chat");
  updateShareBtn();
  loadRecent();
  $("#input")?.focus();
}
$("#newChat")?.addEventListener("click", newChat);

function updateShareBtn() {
  const btn = $("#shareChat");
  if (!btn) return;
  btn.hidden = !state.sessionId;
}
$("#shareChat")?.addEventListener("click", async () => {
  if (!state.sessionId) return;
  const r = await api.post(`/api/chats/${state.sessionId}/share`, {});
  if (r.link) {
    try { await navigator.clipboard.writeText(r.link); } catch {}
    $("#shareMsg").textContent = "Link kopiert";
    setTimeout(() => { if ($("#shareMsg")) $("#shareMsg").textContent = ""; }, 2500);
  } else {
    $("#shareMsg").textContent = r.error || "Share fehlgeschlagen";
  }
});

function addMsg(role) {
  $("#chatArea").classList.remove("empty");
  const el = document.createElement("div");
  el.className = "msg " + role;
  el.innerHTML = role === "assistant"
    ? `<div class="av">${LOGO}</div><div class="bubble"><div class="who">Nimbus</div><div class="text"></div></div>`
    : `<div class="av">Du</div><div class="bubble"><div class="who">Du</div><div class="text"></div></div>`;
  $("#messages").appendChild(el);
  $("#messages").scrollTop = $("#messages").scrollHeight;
  return el.querySelector(".text");
}

function appendMarkdown(el, text) {
  let html = esc(text || "");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/(^|[\s(])(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  el.innerHTML += html;
  $("#messages").scrollTop = $("#messages").scrollHeight;
}

function toolCallEl(name, input, running = true) {
  const d = document.createElement("div");
  d.className = "tool-call" + (running ? " running" : "");
  d.innerHTML = `<div class="tc-head"><b>${esc(name)}</b></div><div class="tc-body">${esc(typeof input === "string" ? input : JSON.stringify(input, null, 2))}</div>`;
  d.querySelector(".tc-head").onclick = () => d.classList.toggle("open");
  return d;
}

async function sendChat() {
  const input = $("#input");
  const text = input.value.trim();
  if (!text || state.streaming) return;
  input.value = "";
  autoSize(input);
  addMsg("user").textContent = text;
  const bubble = addMsg("assistant");
  const typing = Object.assign(document.createElement("span"), { className: "typing", innerHTML: "<i></i><i></i><i></i>" });
  bubble.appendChild(typing);
  state.streaming = true;
  $("#send").disabled = true;
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: text, chat_id: state.sessionId, persona_id: state.personaId }),
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    typing.remove();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n");
      buf = parts.pop() || "";
      for (const part of parts) {
        if (!part.trim().startsWith("data:")) continue;
        let e; try { e = JSON.parse(part.trim().slice(5).trim()); } catch { continue; }
        if (e.type === "session") { state.sessionId = e.session_id || e.chat_id; loadRecent(); }
        else if (e.type === "text") appendMarkdown(bubble, e.text);
        else if (e.type === "tool_use") {
          if (state.ux?.show_tool_details !== false) bubble.appendChild(toolCallEl(e.name, e.input));
        } else if (e.type === "tool_result") {
          const open = [...bubble.querySelectorAll(".tool-call.running")].pop();
          if (open) {
            open.classList.remove("running");
            const body = open.querySelector(".tc-body");
            if (body) body.textContent = typeof e.result === "string" ? e.result : JSON.stringify(e.result, null, 2);
          }
        } else if (e.type === "error") {
          bubble.appendChild(Object.assign(document.createElement("div"), { className: "err-text", textContent: e.error || "Fehler" }));
        }
      }
    }
  } catch (err) {
    typing.remove();
    bubble.appendChild(Object.assign(document.createElement("div"), { className: "err-text", textContent: String(err.message || err) }));
  }
  state.streaming = false;
  $("#send").disabled = false;
  updateShareBtn();
  loadRecent();
}

function autoSize(el) { el.style.height = "auto"; el.style.height = Math.min(el.scrollHeight, 180) + "px"; }
$("#input")?.addEventListener("input", (e) => { autoSize(e.target); $("#send").disabled = !e.target.value.trim() || state.streaming; });
$("#input")?.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
$("#send")?.addEventListener("click", sendChat);

/* ===== Files ===== */
let openPath = null;
const fmtSize = (n) => n == null ? "" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(1) + " MB";

async function loadFiles(path) {
  state.filePath = path || ".";
  const r = await api.get("/api/files?path=" + encodeURIComponent(state.filePath));
  const list = $("#fileList");
  const cur = r.path || state.filePath;
  $("#filePath").textContent = cur === "." ? "~" : cur;
  list.innerHTML = "";
  if (cur !== "." && cur !== "/") {
    const up = document.createElement("div");
    up.className = "file-item dir";
    up.innerHTML = `${icon("folder")}..`;
    up.onclick = () => {
      const parts = cur.replace(/\\/g, "/").split("/").filter(Boolean);
      parts.pop();
      loadFiles(parts.length ? parts.join("/") : ".");
    };
    list.appendChild(up);
  }
  (r.entries || []).sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1)
    .forEach((en) => {
      const full = cur === "." ? en.name : cur.replace(/\/$/, "") + "/" + en.name;
      const it = document.createElement("div");
      it.className = "file-item" + (en.type === "dir" ? " dir" : "");
      it.dataset.name = en.name.toLowerCase();
      it.innerHTML = `${icon(en.type === "dir" ? "folder" : "file")}${esc(en.name)}<span class="sz">${en.type === "file" ? fmtSize(en.size) : ""}</span>`;
      it.onclick = () => en.type === "dir" ? loadFiles(full) : openFile(full, en.name);
      list.appendChild(it);
    });
  applyFileFilter();
}

async function openFile(path, name) {
  const r = await api.get("/api/files/read?path=" + encodeURIComponent(path));
  if (r.error) { $("#uploadMsg").textContent = r.error; return; }
  openPath = path;
  $("#editorName").textContent = name || path;
  $("#fileContent").value = r.content ?? "";
  $("#saveFile").disabled = false;
}

function applyFileFilter() {
  const q = ($("#fileSearch")?.value || "").toLowerCase().trim();
  $$("#fileList .file-item").forEach((it) => {
    if (it.classList.contains("dir") && it.textContent.trim() === "..") return;
    it.classList.toggle("hidden", q && !(it.dataset.name || "").includes(q));
  });
}
$("#fileSearch")?.addEventListener("input", applyFileFilter);
$("#saveFile")?.addEventListener("click", async () => {
  if (!openPath) return;
  const r = await api.post("/api/files/write", { path: openPath, content: $("#fileContent").value });
  $("#uploadMsg").textContent = r.error || "Gespeichert";
  setTimeout(() => { $("#uploadMsg").textContent = ""; }, 2000);
});
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    reader.onerror = () => reject(reader.error || new Error("Lesen fehlgeschlagen"));
    reader.readAsDataURL(file);
  });
}
$("#uploadInput")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  $("#uploadMsg").textContent = "Upload…";
  try {
    const b64 = await fileToBase64(file);
    const base = state.filePath || ".";
    const path = base === "." ? file.name : base.replace(/\/$/, "") + "/" + file.name;
    const r = await api.post("/api/files/upload", { path, content_base64: b64 });
    $("#uploadMsg").textContent = r.error || "Hochgeladen";
    loadFiles(base);
  } catch (err) {
    $("#uploadMsg").textContent = String(err.message || err);
  }
  e.target.value = "";
});

/* ===== Automations ===== */
async function loadTasks() {
  const { tasks } = await api.get("/api/tasks");
  const list = $("#taskList");
  list.innerHTML = tasks?.length ? "" : `<p class="mut">Noch keine Automatisierungen.</p>`;
  (tasks || []).forEach((t) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><h3>${esc(t.name)} <span class="badge ${t.enabled ? "on" : "off"}">${t.enabled ? "an" : "aus"}</span></h3>
      <p class="mono mut">${esc(t.cron)}</p><p class="mut">${esc(t.prompt || "")}</p></div>
      <button class="icon-btn" data-a="run">Run</button>
      <button class="icon-btn" data-a="tog">${t.enabled ? "Pause" : "Start"}</button>
      <button class="icon-btn danger" data-a="del">${icon("trash")}</button>`;
    c.querySelector('[data-a="run"]').onclick = async () => { await api.post("/api/tasks/run", { id: t.id }); };
    c.querySelector('[data-a="tog"]').onclick = async () => { await api.post("/api/tasks/toggle", { id: t.id }); loadTasks(); };
    c.querySelector('[data-a="del"]').onclick = async () => { await api.post("/api/tasks/delete", { id: t.id }); loadTasks(); };
    list.appendChild(c);
  });
}
$("#taskAdd")?.addEventListener("click", async () => {
  const name = $("#taskName").value.trim();
  const cron = $("#taskCron").value.trim();
  const prompt = $("#taskPrompt").value.trim();
  if (!name || !cron || !prompt) return;
  await api.post("/api/tasks", { name, cron, prompt });
  $("#taskName").value = ""; $("#taskCron").value = ""; $("#taskPrompt").value = "";
  loadTasks();
});

/* ===== Integrations ===== */
async function loadIntegrations() {
  const { providers } = await api.get("/api/oauth/providers");
  const grid = $("#intGrid");
  grid.innerHTML = "";
  (providers || []).forEach((p) => {
    const on = p.status === "connected";
    const c = document.createElement("div");
    c.className = "int-card";
    c.innerHTML = `<h3>${esc(p.name)}</h3>
      <span class="badge ${on ? "on" : "off"}">${on ? "verbunden" : "getrennt"}</span>
      <div class="int-foot">
        <span class="mut">${p.configured ? "" : "Client-ID fehlt"}</span>
        <button class="btn ${on ? "" : "dark"}" data-a="tog">${on ? "Trennen" : "Verbinden"}</button>
      </div>`;
    c.querySelector("[data-a=tog]").onclick = async () => {
      if (on) await api.post("/api/oauth/disconnect", { provider: p.id });
      else {
        if (p.id === "telegram") {
          const token = prompt("Telegram Bot-Token");
          if (token) await api.post("/api/oauth/token", { provider: "telegram", token });
        } else {
          const r = await api.post("/api/oauth/start", { provider: p.id, redirect_uri: location.origin + "/api/oauth/callback" });
          if (r.url) location.href = r.url;
          else if (r.error) alert(r.error);
        }
      }
      loadIntegrations();
    };
    grid.appendChild(c);
  });
}

/* ===== Skills + Personas ===== */
async function loadSkills() {
  const { skills } = await api.get("/api/skills");
  const list = $("#skillList");
  list.innerHTML = skills?.length ? "" : `<p class="mut">Keine Skills. Scan oder neu anlegen.</p>`;
  (skills || []).forEach((s) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><h3>${esc(s.name)} <span class="badge ${s.enabled ? "on" : "off"}">${s.enabled ? "an" : "aus"}</span></h3>
      <p class="mut">${esc(s.description || "")}</p></div>
      <button class="icon-btn" data-a="tog">${s.enabled ? "Aus" : "An"}</button>`;
    c.querySelector("[data-a=tog]").onclick = async () => {
      await api.post("/api/skills/toggle", { id: s.id, enabled: !s.enabled });
      loadSkills();
    };
    list.appendChild(c);
  });
}
$("#skillScan")?.addEventListener("click", async () => { await api.post("/api/skills/scan", {}); loadSkills(); });
$("#skillCreate")?.addEventListener("click", async () => {
  const name = $("#skillName").value.trim();
  if (!name) return;
  await api.post("/api/skills", { name, scopes: [], rules: [] });
  $("#skillName").value = "";
  loadSkills();
});

async function loadPersonas() {
  const { personas } = await api.get("/api/personas");
  const list = $("#personaList");
  list.innerHTML = "";
  (personas || []).forEach((p) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><h3>${esc(p.name)}</h3><p class="mut mono">${esc(p.model || "")}</p></div>
      <button class="icon-btn" data-a="edit">Laden</button>
      <button class="icon-btn danger" data-a="del">${icon("trash")}</button>`;
    c.querySelector("[data-a=edit]").onclick = () => {
      $("#pId").value = p.id; $("#pName").value = p.name; $("#pModel").value = p.model || "";
      $("#pPrompt").value = p.system_prompt || "";
    };
    c.querySelector("[data-a=del]").onclick = async () => { await api.post("/api/personas/delete", { id: p.id }); loadPersonas(); fillPersonaSelect(); };
    list.appendChild(c);
  });
}
$("#pSave")?.addEventListener("click", async () => {
  await api.post("/api/personas", {
    id: $("#pId").value ? Number($("#pId").value) : undefined,
    name: $("#pName").value.trim(),
    model: $("#pModel").value.trim(),
    system_prompt: $("#pPrompt").value,
  });
  $("#pClear").click();
  loadPersonas(); fillPersonaSelect();
});
$("#pClear")?.addEventListener("click", () => {
  $("#pId").value = ""; $("#pName").value = ""; $("#pModel").value = ""; $("#pPrompt").value = "";
});

/* ===== Browser ===== */
$("#urlGo")?.addEventListener("click", async () => {
  const url = $("#urlInput").value.trim();
  if (!url) return;
  $("#browserHint").hidden = true;
  $("#browserText").textContent = "Lade…";
  const r = await api.post("/api/browser/open", { url });
  $("#browserText").textContent = r.text || r.error || JSON.stringify(r, null, 2);
});
$("#urlText")?.addEventListener("click", () => $("#urlGo").click());
$("#urlInput")?.addEventListener("keydown", (e) => { if (e.key === "Enter") $("#urlGo").click(); });

/* ===== Sites ===== */
async function loadSpaceRoutes() {
  const list = $("#spaceRouteList");
  const hostEl = $("#spaceHostname");
  if (hostEl) {
    hostEl.textContent = state.spaceHostname
      ? `Öffentlich: https://${state.spaceHostname}`
      : "FQDN erscheint nach Provisionierung.";
  }
  const r = await api.get("/api/space/routes");
  const routes = r.routes || [];
  list.innerHTML = routes.length ? "" : `<p class="mut">Noch keine Routen.</p>`;
  routes.forEach((route) => {
    const isPublic = route.public !== false;
    const href = state.spaceBaseUrl ? state.spaceBaseUrl.replace(/\/$/, "") + (route.path === "/" ? "" : route.path) : "";
    const row = document.createElement("div");
    row.className = "site-row";
    row.innerHTML = `<span class="path">${esc(route.path)}</span>
      <span class="badge">${esc(route.type || "page")}</span>
      <span class="badge ${isPublic ? "public" : "private"}">${isPublic ? "public" : "private"}</span>
      ${href ? `<a class="btn" href="${esc(href)}" target="_blank" rel="noopener">Öffnen</a>` : ""}
      <button class="icon-btn danger" data-a="del">${icon("trash")}</button>`;
    row.querySelector("[data-a=del]").onclick = async () => { await api.del("/api/space/routes", { path: route.path }); loadSpaceRoutes(); };
    list.appendChild(row);
  });
}
$("#spaceRefreshBtn")?.addEventListener("click", loadSpaceRoutes);
$("#spaceRestartBtn")?.addEventListener("click", async () => {
  $("#spaceMsg").textContent = "Neustart…";
  const r = await api.post("/api/space/restart", {});
  $("#spaceMsg").textContent = r.ok ? "Space Server neu gestartet." : (r.error || "Fehler");
});
$("#spaceSaveBtn")?.addEventListener("click", async () => {
  const path = $("#spacePath").value.trim();
  const code = $("#spaceCode").value;
  if (!path || !code) { $("#spaceMsg").textContent = "Pfad und Code nötig."; return; }
  const r = await api.post("/api/space/routes", { path, route_type: $("#spaceType").value, code, public: $("#spacePublic").checked });
  $("#spaceMsg").textContent = r.error || `Gespeichert: ${r.route?.path || path}`;
  if (!r.error) { $("#spaceCode").value = ""; loadSpaceRoutes(); }
});

/* ===== Settings tabs ===== */
function openSettingsTab(tab) {
  state.settingsTab = tab;
  $$(".stab").forEach((b) => b.classList.toggle("active", b.dataset.stab === tab));
  $$(".stab-panel").forEach((p) => p.classList.toggle("active", p.dataset.stabPanel === tab));
}
$$(".stab").forEach((b) => b.addEventListener("click", () => {
  openSettingsTab(b.dataset.stab);
  loadSettingsAll();
}));

const CHANNEL_LABELS = {
  chat: "Chat", text: "Text", email: "E-Mail", telegram: "Telegram",
  discord: "Discord", slack: "Slack", image: "Image",
};

async function loadSettingsAll() {
  const s = await api.get("/api/settings");
  initModelUI(s);
  await loadChannelModels();
  await loadChannelsUI();
  await loadToolsUI();
  await loadUxUI();
  await loadSecretsUI();
  await loadTokensUI();
  await loadRestoreUI();
  loadMemory();
  renderProviderCards(s);
}

function initModelUI(s) {
  if ($("#providerSel") && s?.provider) $("#providerSel").value = s.provider;
  if ($("#customBaseUrl")) $("#customBaseUrl").value = s?.customBaseUrl || "";
  const known = ["blackboxai/openai/gpt-oss-120b", "claude-sonnet-5", "gpt-4o-mini", "gemini-1.5-flash"];
  const current = (s?.model || "").toString();
  const opts = current && !known.includes(current) ? [current, ...known] : known;
  if ($("#modelSel")) {
    $("#modelSel").innerHTML = opts.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
    $("#modelSel").value = current || opts[0];
  }
  if ($("#modelCustomInput")) $("#modelCustomInput").value = current;
}

function renderProviderCards(s) {
  const box = $("#providerCards");
  if (!box) return;
  const cards = [
    { id: "anthropic", name: "Anthropic", on: s.hasAnthropicKey },
    { id: "openai", name: "OpenAI", on: s.hasOpenAIKey },
    { id: "google", name: "Google", on: s.hasGoogleKey },
    { id: "custom", name: "Custom", on: s.hasCustomKey },
    { id: "blackbox", name: "Blackbox", on: s.provider === "blackbox" || s.hasCustomKey },
  ];
  box.innerHTML = cards.map((c) => `<div class="provider-card"><div class="name">${esc(c.name)}</div>
    <div class="st ${c.on ? "on" : ""}">${c.on ? "Connected" : "Nicht verbunden"}</div></div>`).join("");
}

async function loadChannelModels() {
  const r = await api.get("/api/channel-models");
  const models = r.models || {};
  const card = $("#channelModelsCard");
  if (!card) return;
  card.innerHTML = Object.keys(CHANNEL_LABELS).map((k) => {
    const m = models[k] || {};
    return `<div class="row-form">
      <span style="min-width:90px;font-weight:600">${CHANNEL_LABELS[k]}</span>
      <select data-cm-provider="${k}" style="max-width:140px">
        <option value="default">Nimbus</option>
        <option value="anthropic">Anthropic</option>
        <option value="openai">OpenAI</option>
        <option value="google">Google</option>
        <option value="custom">Custom</option>
      </select>
      <input data-cm-model="${k}" class="mono" placeholder="Modell" value="${esc(m.model || "")}" />
    </div>`;
  }).join("") + `<button id="channelModelsSave" class="btn dark">Modelle speichern</button>`;
  Object.keys(CHANNEL_LABELS).forEach((k) => {
    const sel = card.querySelector(`[data-cm-provider="${k}"]`);
    if (sel) sel.value = models[k]?.provider || "default";
  });
  $("#channelModelsSave")?.addEventListener("click", async () => {
    const patch = {};
    Object.keys(CHANNEL_LABELS).forEach((k) => {
      patch[k] = {
        provider: card.querySelector(`[data-cm-provider="${k}"]`)?.value || "default",
        model: card.querySelector(`[data-cm-model="${k}"]`)?.value || "",
      };
    });
    await api.post("/api/channel-models", { models: patch });
    $("#settingsMsg").textContent = "Modelle gespeichert";
  });
}

$("#saveSettings")?.addEventListener("click", async () => {
  const model = $("#modelCustomInput")?.value?.trim() || $("#modelSel")?.value || "";
  await api.post("/api/settings", {
    provider: $("#providerSel")?.value,
    model,
    anthropicApiKey: $("#apiKeyAnthropic")?.value || "",
    openaiApiKey: $("#apiKeyOpenAI")?.value || "",
    googleApiKey: $("#apiKeyGoogle")?.value || "",
    customApiKey: $("#apiKeyCustom")?.value || "",
    customBaseUrl: $("#customBaseUrl")?.value || "",
    chatBackend: "auto",
  });
  ["apiKeyAnthropic", "apiKeyOpenAI", "apiKeyGoogle", "apiKeyCustom"].forEach((id) => { if ($("#" + id)) $("#" + id).value = ""; });
  $("#settingsMsg").textContent = "Gespeichert";
  initStatus();
});

async function loadChannelsUI() {
  const r = await api.get("/api/channels");
  const ch = r.channels || {};
  renderChipList("#phoneList", ch.phones || [], (v) => {
    ch.phones = (ch.phones || []).filter((x) => x !== v);
    api.post("/api/channels", ch).then(loadChannelsUI);
  });
  renderChipList("#emailList", ch.emails || [], (v) => {
    ch.emails = (ch.emails || []).filter((x) => x !== v);
    api.post("/api/channels", ch).then(loadChannelsUI);
  });
  if ($("#noReplyConfirm")) $("#noReplyConfirm").checked = ch.no_reply_confirmation !== false;
  const tg = ch.telegram;
  $("#telegramStatus").textContent = tg?.connected ? `Verbunden als: ${tg.username || "bot"}` : "Nicht verbunden";
}
function renderChipList(sel, items, onRemove) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = (items || []).map((v) => `<span class="chip-item">${esc(v)}<button type="button" data-v="${esc(v)}">${icon("x")}</button></span>`).join("");
  el.querySelectorAll("button").forEach((b) => b.onclick = () => onRemove(b.dataset.v));
}
$("#phoneAdd")?.addEventListener("click", async () => {
  const v = $("#phoneInput").value.trim();
  if (!v) return;
  const r = await api.get("/api/channels");
  const ch = r.channels || {};
  ch.phones = [...(ch.phones || []), v];
  await api.post("/api/channels", ch);
  $("#phoneInput").value = "";
  loadChannelsUI();
});
$("#emailAdd")?.addEventListener("click", async () => {
  const v = $("#emailInput").value.trim();
  if (!v) return;
  const r = await api.get("/api/channels");
  const ch = r.channels || {};
  ch.emails = [...(ch.emails || []), v];
  await api.post("/api/channels", ch);
  $("#emailInput").value = "";
  loadChannelsUI();
});
$("#telegramConnect")?.addEventListener("click", async () => {
  const token = $("#telegramToken").value.trim();
  if (!token) return;
  await api.post("/api/oauth/token", { provider: "telegram", token });
  const r = await api.get("/api/channels");
  const ch = r.channels || {};
  ch.telegram = { connected: true, username: "bot" };
  await api.post("/api/channels", ch);
  $("#telegramToken").value = "";
  loadChannelsUI();
});
$("#telegramDisconnect")?.addEventListener("click", async () => {
  await api.post("/api/oauth/disconnect", { provider: "telegram" });
  const r = await api.get("/api/channels");
  const ch = r.channels || {};
  ch.telegram = null;
  await api.post("/api/channels", ch);
  loadChannelsUI();
});
$("#channelsSave")?.addEventListener("click", async () => {
  const r = await api.get("/api/channels");
  const ch = r.channels || {};
  ch.no_reply_confirmation = $("#noReplyConfirm")?.checked !== false;
  await api.post("/api/channels", ch);
  $("#channelsMsg").textContent = "Gespeichert";
});

async function loadToolsUI() {
  const r = await api.get("/api/tools-settings");
  const t = r.tools || {};
  const box = $("#toolsToggles");
  if (!box) return;
  const labels = { web_search: "Websuche", browser: "Browser", shell: "Shell", space_routes: "Space-Routen" };
  box.innerHTML = Object.keys(labels).map((k) =>
    `<label class="check"><input type="checkbox" data-tool="${k}" ${t[k] !== false ? "checked" : ""}/> ${labels[k]}</label>`
  ).join("");
}
$("#toolsSave")?.addEventListener("click", async () => {
  const patch = {};
  $$("#toolsToggles [data-tool]").forEach((el) => { patch[el.dataset.tool] = el.checked; });
  await api.post("/api/tools-settings", patch);
  $("#toolsMsg").textContent = "Gespeichert";
});

async function loadUxUI() {
  const r = await api.get("/api/ux");
  const ux = r.ux || {};
  if ($("#uxLang")) $("#uxLang").value = ux.language || "de";
  if ($("#uxCompact")) $("#uxCompact").checked = !!ux.compact_chat;
  if ($("#uxTools")) $("#uxTools").checked = ux.show_tool_details !== false;
}
$("#uxSave")?.addEventListener("click", async () => {
  const patch = {
    language: $("#uxLang")?.value,
    compact_chat: $("#uxCompact")?.checked,
    show_tool_details: $("#uxTools")?.checked,
  };
  await api.post("/api/ux", patch);
  state.ux = { ...state.ux, ...patch };
  document.body.classList.toggle("compact-chat", !!state.ux.compact_chat);
  $("#uxMsg").textContent = "Gespeichert";
});

async function loadMemory() {
  const { memories } = await api.get("/api/memories");
  const list = $("#memList");
  if (!list) return;
  list.innerHTML = memories?.length ? "" : `<p class="mut">Noch nichts gemerkt.</p>`;
  (memories || []).forEach((m) => {
    const c = document.createElement("div");
    c.className = "item-card";
    c.innerHTML = `<div class="grow"><p>${esc(m.content)}</p><div class="mut">${esc(m.tags || "")}</div></div>
      <button class="icon-btn danger">${icon("trash")}</button>`;
    c.querySelector("button").onclick = async () => { await api.post("/api/memories/delete", { id: m.id }); loadMemory(); };
    list.appendChild(c);
  });
}
$("#memAdd")?.addEventListener("click", async () => {
  const content = $("#memContent").value.trim();
  if (!content) return;
  await api.post("/api/memories", { content, tags: $("#memTags").value.trim() });
  $("#memContent").value = ""; $("#memTags").value = "";
  loadMemory();
});

async function loadSecretsUI() {
  const r = await api.get("/api/secrets");
  const list = $("#secretList");
  if (!list) return;
  list.innerHTML = (r.secrets || []).map((s) =>
    `<div class="secret-row"><span class="grow">${esc(s.key)}</span><span class="mut">${esc(s.masked)}</span>
      <button class="icon-btn danger" data-k="${esc(s.key)}">${icon("trash")}</button></div>`
  ).join("") || `<p class="mut">Keine Secrets.</p>`;
  list.querySelectorAll("button[data-k]").forEach((b) => b.onclick = async () => {
    await api.del("/api/secrets", { key: b.dataset.k });
    loadSecretsUI();
  });
}
$("#secretAdd")?.addEventListener("click", async () => {
  await api.post("/api/secrets", { key: $("#secretKey").value, value: $("#secretVal").value });
  $("#secretKey").value = ""; $("#secretVal").value = "";
  loadSecretsUI();
});

async function loadTokensUI() {
  const r = await api.get("/api/access-tokens");
  const list = $("#tokenList");
  if (!list) return;
  list.innerHTML = (r.tokens || []).map((t) =>
    `<div class="secret-row"><span class="grow">${esc(t.name)}</span><span class="mut">${esc(t.token_preview)}</span>
      <button class="icon-btn danger" data-id="${esc(t.id)}">${icon("trash")}</button></div>`
  ).join("") || `<p class="mut">Keine Tokens.</p>`;
  list.querySelectorAll("button[data-id]").forEach((b) => b.onclick = async () => {
    await api.del("/api/access-tokens", { id: b.dataset.id });
    loadTokensUI();
  });
}
$("#tokenAdd")?.addEventListener("click", async () => {
  const r = await api.post("/api/access-tokens", { name: $("#tokenName").value.trim() || "token" });
  $("#tokenName").value = "";
  if (r.token) $("#tokenOnce").textContent = `Token (nur jetzt sichtbar): ${r.token}`;
  loadTokensUI();
});

async function loadRestoreUI() {
  const r = await api.get("/api/workspace/restore-points");
  const list = $("#restoreList");
  if (!list) return;
  list.innerHTML = (r.points || []).map((p) =>
    `<div class="secret-row"><span class="grow">${esc(new Date(p.at).toLocaleString("de-DE"))}</span>
      <button class="btn" disabled title="Snapshot-Restore folgt">Restore</button></div>`
  ).join("") || `<p class="mut">Noch keine Restore Points.</p>`;
}
$("#workspaceReboot")?.addEventListener("click", async () => {
  $("#rebootMsg").textContent = "Reboot…";
  const r = await api.post("/api/workspace/reboot", {});
  $("#rebootMsg").textContent = r.ok ? "Workspace neu gestartet." : (r.error || "Fehler");
  loadRestoreUI();
});

/* ===== Terminal (dock + full) ===== */
const termState = { ws: null, dock: null, full: null, fitDock: null, fitFull: null, mode: "dock" };

function setTermStatus(text, on) {
  ["#termStatus", "#termStatusFull"].forEach((sel) => {
    const el = $(sel);
    if (!el) return;
    el.textContent = text;
    el.classList.toggle("on", !!on);
  });
}

function createTerm(host) {
  if (typeof Terminal === "undefined") return null;
  const term = new Terminal({
    cursorBlink: true, fontSize: 13,
    fontFamily: 'ui-monospace, Menlo, monospace',
    theme: { background: "#0f1216", foreground: "#d6dae1", cursor: "#34d399" },
    convertEol: true,
  });
  let fit = null;
  try {
    const Fit = window.FitAddon?.FitAddon || window.FitAddon;
    if (Fit) { fit = new Fit(); term.loadAddon(fit); }
  } catch {}
  term.open(host);
  fit?.fit();
  let line = "";
  term.onData((data) => {
    if (!termState.ws || termState.ws.readyState !== WebSocket.OPEN) {
      if (data === "\r") connectTerm();
      return;
    }
    if (data === "\r") {
      const cmd = line; line = "";
      term.write("\r\n");
      termState.ws.send(JSON.stringify({ type: "cmd", cmd }));
      return;
    }
    if (data === "\u007f") {
      if (line.length) { line = line.slice(0, -1); term.write("\b \b"); }
      return;
    }
    if (data >= " " || data === "\t") { line += data; term.write(data); }
  });
  return { term, fit };
}

function ensureTerm(mode = "dock") {
  termState.mode = mode;
  if (mode === "full") {
    if (!termState.full && $("#xtermFull")) termState.full = createTerm($("#xtermFull"));
    termState.full?.fit?.fit();
    return termState.full?.term;
  }
  if (!termState.dock && $("#xterm")) termState.dock = createTerm($("#xterm"));
  termState.dock?.fit?.fit();
  return termState.dock?.term;
}

function connectTerm() {
  ensureTerm(termState.mode);
  if (termState.ws && termState.ws.readyState === WebSocket.OPEN) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws/term`);
  termState.ws = ws;
  setTermStatus("verbindet…", false);
  ws.onopen = () => setTermStatus("verbunden", true);
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    const write = (t) => {
      termState.dock?.term?.write(t);
      termState.full?.term?.write(t);
    };
    if (m.type === "ready") { write("\x1b[90mShell bereit\x1b[0m\r\n"); setTermStatus("verbunden", true); }
    if (m.type === "out" && m.data) write(String(m.data).replace(/\n/g, "\r\n"));
    if (m.type === "exit") { write(`\r\n\x1b[90m[exit ${m.code}]\x1b[0m\r\n`); setTermStatus("getrennt", false); }
  };
  ws.onclose = () => { setTermStatus("getrennt", false); termState.ws = null; };
}

function toggleTerm(forceOpen) {
  const dock = $("#termDock");
  if (!dock) return;
  const open = forceOpen === true ? true : forceOpen === false ? false : dock.classList.contains("collapsed");
  dock.classList.toggle("collapsed", !open);
  if (open) { ensureTerm("dock"); connectTerm(); requestAnimationFrame(() => termState.dock?.fit?.fit()); }
}
$("#termToggle")?.addEventListener("click", () => toggleTerm());
window.addEventListener("resize", () => {
  if (!$("#termDock")?.classList.contains("collapsed")) termState.dock?.fit?.fit();
  termState.full?.fit?.fit();
});

/* ===== Boot ===== */
(async function boot() {
  await initStatus();
  const h = (location.hash || "#chat").replace(/^#\/?/, "");
  switchView(h || "chat");
})();

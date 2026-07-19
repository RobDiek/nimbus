// Nimbus – HTTP-Server (Bun), API + WebSocket-Terminal + statische Auslieferung
import { join } from "path";
import os from "node:os";
import { randomBytes } from "crypto";
import {
  db,
  getSetting,
  setSetting,
  getSettingTenant,
  setSettingTenant,
  ROOT,
  WORKSPACE,
  getVmInstance,
  upsertVmInstance,
  upsertVmTerminalSession,
  getVmTerminalSession,
  listVmTerminalSessions,
  listChats,
  getChatDetail,
  updateChat,
  deleteChat,
  createChatShare,
  revokeChatShare,
  resolveSharedChatByToken,
  createChat,
  createChatRun,
  appendChatEvent,
  finishChatRun,
  getLegacyMessagesForChat,
  touchChat,
  listTaskRuns,
} from "./db.js";
import { runAgent, hasKey } from "./agent.js";
import { executeTool } from "./tools.js";
import { services } from "./services.js";
import { startScheduler, runTaskForTenant } from "./scheduler.js";
import { resolveTenantFromRequest } from "./tenancy/router.js";
import { logger } from "./logger.js";
import { config, publicHostnameForTenant } from "./config.js";
import { getVmStatus, createVmSshPty } from "./proxmox.js";
import { vmOrchestrator } from "./vm-orchestrator.js";
import { ingressStatusForTenant, ensureTenantIngress } from "./zoraxy.js";
import {
  listSpaceRoutes, writeSpaceRoute, editSpaceRoute, deleteSpaceRoute, ensureSpaceScaffold,
} from "./space.js";
import { createSkillFile, getSkillByNameOrId, importSkillFromContent, listSkills, scanSkills, setSkillEnabled, buildSkillSystemAppendix } from "./skills.js";
import { browserClick, browserOpen, browserScreenshot, browserSubmit, createBrowserSession, getBrowserSession, listBrowserSessions } from "./browser.js";
import { completeOAuth, disconnectOAuth, listOAuthProviders, saveManualToken, startOAuth } from "./oauth.js";
import { deployService, healthCheck, latestDeployment, latestHealthyDeployment, listDeploymentEvents, listDeployments, rollbackDeployment } from "./hosting.js";

const PUBLIC = join(ROOT, "public");
const PORT = config.port;
const BOOT_TIME = Date.now();

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

function jsonResponseWithCors(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-api-key",
    },
  });
}

async function body(req) {
  try { return await req.json(); } catch { return {}; }
}

const withErrorHandling = (handler) => async (req, url, tenantContext) => {
  try {
    return await handler(req, url, tenantContext);
  } catch (err) {
    logger.error("route_error", {
      method: req.method,
      path: url?.pathname,
      tenant: tenantId(tenantContext),
      error: String(err?.message || err),
    });
    return json({ error: "Internal Server Error" }, 500);
  }
};

function providerStatus(tenantContext = { userId: "default" }) {
  const tId = tenantId(tenantContext);
  const setting = (key, fallback = "") => getSettingTenant(tId, key, fallback);
  const provider = setting("llm_provider", "anthropic") || "anthropic";
  const hasAnthropicKey = !!(setting("anthropic_api_key", "") || process.env.ANTHROPIC_API_KEY || "");
  const hasOpenAIKey = !!(setting("openai_api_key", "") || process.env.OPENAI_API_KEY || "");
  const hasGoogleKey = !!(setting("google_api_key", "") || process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY || "");
  const hasCustomKey = !!(setting("custom_api_key", "") || process.env.CUSTOM_LLM_API_KEY || "");

  // Alias: "blackbox" uses the same key as the existing "custom" provider.
  const effectiveProvider = provider === "blackbox" ? "custom" : provider;

  const providerHasKey =
    effectiveProvider === "openai" ? hasOpenAIKey :
    effectiveProvider === "google" ? hasGoogleKey :
    effectiveProvider === "custom" ? hasCustomKey :
    hasAnthropicKey;

  return { provider, hasKey: providerHasKey, hasAnthropicKey, hasOpenAIKey, hasGoogleKey, hasCustomKey };
}

function tenantId(tc) {
  return tc?.userId || "default";
}

function vmPublic(vm) {
  if (!vm) return null;
  let metadata = {};
  try { metadata = typeof vm.metadata === "string" ? JSON.parse(vm.metadata || "{}") : (vm.metadata || {}); } catch {}
  const hostname = metadata.public_hostname || publicHostnameForTenant(vm.tenant_id);
  return {
    tenant_id: vm.tenant_id,
    provider: vm.provider,
    node: vm.node,
    vmid: vm.vmid,
    state: vm.state,
    ip_address: vm.ip_address,
    template_vmid: vm.template_vmid,
    cpu_cores: vm.cpu_cores,
    memory_mb: vm.memory_mb,
    disk_gb: vm.disk_gb,
    username: vm.username,
    last_error: vm.last_error,
    created_at: vm.created_at,
    updated_at: vm.updated_at,
    public_hostname: hostname,
    public_url: `https://${hostname}`,
    metadata,
  };
}

// System-Prompt für eine Session inkl. Persona + Memory-Kontext
function buildSystem(personaId, tenantContext) {
  const tId = tenantId(tenantContext);
  const persona = personaId
    ? db.query("SELECT * FROM personas WHERE id = ? AND tenant_id = ?").get(personaId, tId)
    : db.query("SELECT * FROM personas WHERE tenant_id = ? ORDER BY id LIMIT 1").get(tId);
  const base = persona?.system_prompt ||
    "Du bist Nimbus, ein persönlicher KI-Computer mit Terminal- und Dateizugriff.";
  const mems = db
    .query("SELECT content FROM memories WHERE tenant_id = ? ORDER BY id DESC LIMIT 15")
    .all(tId);
  const memText = mems.length
    ? "\n\nWas du dir über den Nutzer gemerkt hast:\n" + mems.map((m) => "- " + m.content).join("\n")
    : "";
  const env = `\n\nUmgebung: Workspace=${tenantContext?.workspaceRoot || WORKSPACE}. Du hast run_command (bash), Dateisystem-, Web-, Memory-, Service- und Scheduler-Tools. Handle proaktiv – führe Aufgaben aus, statt nur zu beschreiben.`;
  const skillAppendix = tenantContext?.activeSkill ? buildSkillSystemAppendix(tenantContext.activeSkill) : "";
  return { system: base + env + memText + skillAppendix, model: persona?.model || undefined };
}

function ensureDefaultLLMSettings() {
  // For parity: make the app converge to Blackbox defaults even if an older
  // settings row exists. We intentionally do NOT set any API key defaults.
  const desiredProvider = "blackbox";
  const desiredModel = "blackboxai/openai/gpt-oss-120b";
  const desiredBaseUrl = "https://api.blackbox.ai";

  const curProvider = getSetting("llm_provider", "");
  const curModel = getSetting("model", "");
  const curBaseUrl = getSetting("custom_base_url", "");

  if (curProvider !== desiredProvider) setSetting("llm_provider", desiredProvider);
  if (curModel !== desiredModel) setSetting("model", desiredModel);
  if (curBaseUrl !== desiredBaseUrl && curBaseUrl !== desiredBaseUrl + "/v1") setSetting("custom_base_url", desiredBaseUrl);
}

ensureDefaultLLMSettings();

function parseBool(v) {
  if (v === true || v === false) return v;
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return null;
}

function safeNumber(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function buildHistoryFromLegacyRows(rows = []) {
  const toContentBlocks = (v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object" && v.type === "text" && typeof v.text === "string") return [v];
    const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
    return [{ type: "text", text: s }];
  };
  return rows.map((r) => {
    let parsed;
    try { parsed = JSON.parse(r.content); } catch { parsed = r.content; }
    return { role: r.role, content: toContentBlocks(parsed) };
  });
}

async function runChatEngine({ tenantContext, message, chatId, personaId, modelOverride, mode = "stream", schema = null }) {
  const tId = tenantId(tenantContext);
  let chat = chatId ? getChatDetail(tId, chatId)?.chat : null;
  if (!chat) {
    chat = createChat({
      tenantId: tId,
      title: String(message || "").slice(0, 80) || "Neuer Chat",
      personaId: personaId ?? null,
    });
    chatId = chat.id;
  }

  const { system, model: personaModel } = buildSystem(personaId || chat?.persona_id, tenantContext);
  const model = (typeof modelOverride === "string" && modelOverride.trim()) ? modelOverride.trim() : (personaModel || "");

  const historyRows = getLegacyMessagesForChat(tId, chatId);
  const history = buildHistoryFromLegacyRows(historyRows);

  const userBlocks = [{ type: "text", text: String(message || "") }];
  history.push({ role: "user", content: userBlocks });
  db.query("INSERT INTO messages (tenant_id, session_id, role, content) VALUES (?, ?, 'user', ?)")
    .run(tId, chatId, JSON.stringify(userBlocks));

  const runId = createChatRun({ chatId, tenantId: tId, model: model || "" });
  appendChatEvent({ runId, type: "user", payload: { message: String(message || ""), persona_id: personaId ?? null, schema } });

  const events = [];
  const forward = (e) => {
    events.push(e);
    if (["text", "tool_use", "tool_result", "error", "done"].includes(e?.type)) {
      appendChatEvent({ runId, type: e.type, payload: e });
    }
  };

  const startLen = history.length;
  let error = null;
  try {
    await runAgent({ messages: history, system, model, onEvent: forward, tenantContext });
    finishChatRun({ runId, status: "done" });
  } catch (err) {
    error = String(err?.message || err);
    forward({ type: "error", error });
    finishChatRun({ runId, status: "error", error });
  }

  for (let i = startLen; i < history.length; i++) {
    const m = history[i];
    db.query("INSERT INTO messages (tenant_id, session_id, role, content) VALUES (?, ?, ?, ?)")
      .run(tId, chatId, m.role, JSON.stringify(m.content));
  }

  touchChat(tId, chatId);

  if (mode === "json") {
    const text = events.filter((e) => e.type === "text").map((e) => e.text || "").join("\n");
    let structured = null;
    if (schema) {
      try { structured = JSON.parse(text); } catch { structured = null; }
    }
    return {
      mode: "json",
      chat_id: chatId,
      run_id: runId,
      error,
      output_text: text,
      output_json: structured,
      events,
    };
  }

  return { mode: "stream", chat_id: chatId, run_id: runId, events, error };
}

const routes = {
  // --- Status / Settings / Sysinfo ---
  "GET /api/status": (_req, _url, tenantContext) => {
    const s = providerStatus(tenantContext);
    const tId = tenantId(tenantContext);
    return json({
      ok: true,
      ...s,
      model: getSettingTenant(tId, "model", "claude-sonnet-5"),
      workspace: tenantContext?.workspaceRoot || WORKSPACE,
    });
  },
  "GET /api/sysinfo": (_req, _url, tenantContext) => json({
    cores: os.cpus().length,
    mem_gb: Math.round(os.totalmem() / 1024 ** 3),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime_s: Math.round((Date.now() - BOOT_TIME) / 1000),
    workspace: tenantContext?.workspaceRoot || WORKSPACE,
  }),
  "GET /api/settings": (_req, _url, tenantContext) => {
    const s = providerStatus(tenantContext);
    const tId = tenantId(tenantContext);
    return json({
      provider: s.provider,
      model: getSettingTenant(tId, "model", "claude-sonnet-5"),
      hasKey: s.hasKey,
      hasAnthropicKey: s.hasAnthropicKey,
      hasOpenAIKey: s.hasOpenAIKey,
      hasGoogleKey: s.hasGoogleKey,
      hasCustomKey: s.hasCustomKey,
      customBaseUrl: getSettingTenant(tId, "custom_base_url", ""),
      integrations: JSON.parse(getSettingTenant(tId, "integrations", "{}")),
    });
  },
  "POST /api/settings": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const setting = (key, value) => setSettingTenant(tId, key, value);
    const b = await body(req);
    if (typeof b.apiKey === "string" && b.apiKey.trim()) setting("anthropic_api_key", b.apiKey.trim());
    if (typeof b.anthropicApiKey === "string" && b.anthropicApiKey.trim()) setting("anthropic_api_key", b.anthropicApiKey.trim());
    if (typeof b.openaiApiKey === "string" && b.openaiApiKey.trim()) setting("openai_api_key", b.openaiApiKey.trim());
    if (typeof b.googleApiKey === "string" && b.googleApiKey.trim()) setting("google_api_key", b.googleApiKey.trim());
    if (typeof b.customApiKey === "string" && b.customApiKey.trim()) setting("custom_api_key", b.customApiKey.trim());
    if (typeof b.customBaseUrl === "string") setting("custom_base_url", b.customBaseUrl.trim());
    if (typeof b.provider === "string" && b.provider.trim()) setting("llm_provider", b.provider.trim());
    if (b.model) setting("model", b.model);
    if (b.integrations) setting("integrations", JSON.stringify(b.integrations));
    return json({ ok: true });
  },

  // --- Sessions ---
  "GET /api/sessions": (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    return json({
      sessions: db.query("SELECT * FROM sessions WHERE tenant_id = ? ORDER BY id DESC").all(tId),
    });
  },
  "POST /api/sessions/delete": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    db.query("DELETE FROM messages WHERE session_id = ? AND tenant_id = ?").run(b.id, tId);
    db.query("DELETE FROM sessions WHERE id = ? AND tenant_id = ?").run(b.id, tId);
    return json({ ok: true });
  },
  "GET /api/messages": (req, url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const sid = url.searchParams.get("session_id");
    const rows = db.query("SELECT role, content FROM messages WHERE session_id = ? AND tenant_id = ? ORDER BY id").all(sid, tId);
    return json({ messages: rows.map((r) => ({ role: r.role, content: JSON.parse(r.content) })) });
  },

  // --- Chats (new model) ---
  "GET /api/chats": (_req, url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const q = url.searchParams.get("q") || "";
    const archivedRaw = url.searchParams.get("archived");
    const archived = archivedRaw === null ? null : parseBool(archivedRaw);
    const from = url.searchParams.get("from") || "";
    const to = url.searchParams.get("to") || "";
    const chats = listChats({ tenantId: tId, q, archived, from, to });
    return json({ chats });
  },

  // --- Personas ---
  "GET /api/personas": (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    return json({ personas: db.query("SELECT * FROM personas WHERE tenant_id = ? ORDER BY id").all(tId) });
  },
  "POST /api/personas": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    if (b.id) {
      db.query("UPDATE personas SET name=?, system_prompt=?, model=? WHERE id=? AND tenant_id=?")
        .run(b.name, b.system_prompt || "", b.model || "", b.id, tId);
      return json({ ok: true, id: b.id });
    }
    const r = db.query("INSERT INTO personas (tenant_id, name, emoji, system_prompt, model) VALUES (?,?,?,?,?)")
      .run(tId, b.name, "", b.system_prompt || "", b.model || "");
    return json({ id: r.lastInsertRowid });
  },
  "POST /api/personas/delete": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    db.query("DELETE FROM personas WHERE id = ? AND tenant_id = ?").run(b.id, tId);
    return json({ ok: true });
  },

  // --- Memory ---
  "GET /api/memories": (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    return json({ memories: db.query("SELECT * FROM memories WHERE tenant_id = ? ORDER BY id DESC").all(tId) });
  },
  "POST /api/memories": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    db.query("INSERT INTO memories (tenant_id, content, tags) VALUES (?, ?, ?)").run(tId, b.content, b.tags || "");
    return json({ ok: true });
  },
  "POST /api/memories/delete": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    db.query("DELETE FROM memories WHERE id = ? AND tenant_id = ?").run(b.id, tId);
    return json({ ok: true });
  },

  // --- Tasks ---
  "GET /api/tasks": (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    return json({ tasks: db.query("SELECT * FROM tasks WHERE tenant_id = ? ORDER BY id DESC").all(tId) });
  },
  "POST /api/tasks": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    db.query("INSERT INTO tasks (tenant_id, name, cron, prompt) VALUES (?, ?, ?, ?)").run(tId, b.name, b.cron, b.prompt);
    return json({ ok: true });
  },
  "POST /api/tasks/toggle": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    db.query("UPDATE tasks SET enabled = NOT enabled WHERE id = ? AND tenant_id = ?").run(b.id, tId);
    return json({ ok: true });
  },
  "POST /api/tasks/delete": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    db.query("DELETE FROM tasks WHERE id = ? AND tenant_id = ?").run(b.id, tId);
    return json({ ok: true });
  },
  "POST /api/tasks/run": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    const result = await runTaskForTenant(Number(b.id), tId);
    return json(result, result.ok ? 200 : 409);
  },
  "GET /api/task-runs": (_req, url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const taskId = Number(url.searchParams.get("task_id"));
    if (!Number.isFinite(taskId)) return json({ error: "task_id required" }, 400);
    return json({ runs: listTaskRuns(tId, taskId, 50) });
  },

  // --- Services (Hosting) ---
  "GET /api/services": (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    return json({ services: services.list(tId) });
  },
  "POST /api/services/start": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    return json(services.start(tId, b.name, b.command, b.cwd, tenantContext?.workspaceRoot));
  },
  "POST /api/services/stop": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    return json(services.stop(tId, b.name));
  },
  "POST /api/services/remove": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    return json(services.remove(tId, b.name));
  },
  "GET /api/services/logs": (req, url, tenantContext) => {
    const tId = tenantId(tenantContext);
    return json(services.logs(tId, url.searchParams.get("name")));
  },

  // --- Skills (SKILL.md + Scopes) ---
  "GET /api/skills": (_req, _url, tenantContext) => json({ skills: listSkills(tenantContext) }),
  "POST /api/skills/scan": (_req, _url, tenantContext) => json(scanSkills(tenantContext)),
  "POST /api/skills": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(createSkillFile(tenantContext, {
      name: b.name,
      description: b.description || "",
      scopes: Array.isArray(b.scopes) ? b.scopes : String(b.scopes || "").split(",").map((s) => s.trim()).filter(Boolean),
      rules: Array.isArray(b.rules) ? b.rules : String(b.rules || "").split("\n").map((s) => s.trim()).filter(Boolean),
      content: b.content || "",
    }));
  },
  "POST /api/skills/toggle": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(setSkillEnabled(tenantContext, Number(b.id), !!b.enabled));
  },
  "POST /api/skills/update": async (req, _url, tenantContext) => {
    const b = await body(req);
    const skill = getSkillByNameOrId(tenantContext, b.id || b.skill_id || b.name);
    if (!skill) return json({ error: "Skill nicht gefunden." }, 404);

    const sourcePath = b.source_path || skill.source_path || "";
    const content = String(b.content || "");
    if (!sourcePath) return json({ error: "source_path fehlt." }, 400);

    await executeTool("write_file", { path: sourcePath, content }, tenantContext);
    const updated = importSkillFromContent(tenantContext, { name: skill.name, content, sourcePath });
    return json({ ok: true, skill: updated });
  },
  "POST /api/skills/test": async (req, _url, tenantContext) => {
    const b = await body(req);
    const skill = getSkillByNameOrId(tenantContext, b.skill_id || b.skill || b.name);
    if (!skill || !skill.enabled) return json({ error: "Skill nicht gefunden oder deaktiviert." }, 404);
    const tc = { ...tenantContext, activeSkill: skill };
    const { system } = buildSystem(b.persona_id || null, tc);
    const messages = [{ role: "user", content: [{ type: "text", text: String(b.prompt || "") }] }];
    const events = [];
    try {
      await runAgent({ messages, system, model: b.model || "", onEvent: (e) => events.push(e), tenantContext: tc });
      return json({ ok: true, skill: { id: skill.id, name: skill.name, scopes: skill.scopes }, events });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err), events }, 400);
    }
  },
  "POST /api/skills/run": async (req, _url, tenantContext) => {
    const b = await body(req);
    const skill = getSkillByNameOrId(tenantContext, b.skill_id || b.skill || b.name);
    if (!skill || !skill.enabled) return json({ error: "Skill nicht gefunden oder deaktiviert." }, 404);
    const tc = { ...tenantContext, activeSkill: skill };
    const { system } = buildSystem(b.persona_id || null, tc);
    const messages = [{ role: "user", content: [{ type: "text", text: String(b.prompt || "") }] }];
    const events = [];
    try {
      await runAgent({ messages, system, model: b.model || "", onEvent: (e) => events.push(e), tenantContext: tc });
      return json({ ok: true, skill: { id: skill.id, name: skill.name, scopes: skill.scopes }, events });
    } catch (err) {
      return json({ ok: false, error: String(err?.message || err), events }, 400);
    }
  },

  // --- Interactive Browser ---
  "GET /api/browser/sessions": (_req, _url, tenantContext) => json({ sessions: listBrowserSessions(tenantContext) }),
  "POST /api/browser/session": (_req, _url, tenantContext) => json({ ok: true, session: createBrowserSession(tenantContext) }),
  "GET /api/browser/session": (_req, url, tenantContext) => {
    const session = getBrowserSession(tenantContext, url.searchParams.get("id"));
    return session ? json({ session }) : json({ error: "Browser-Session nicht gefunden." }, 404);
  },
  "POST /api/browser/open": async (req, _url, tenantContext) => json(await browserOpen(tenantContext, await body(req))),
  "POST /api/browser/click": async (req, _url, tenantContext) => json(await browserClick(tenantContext, await body(req))),
  "POST /api/browser/submit": async (req, _url, tenantContext) => json(await browserSubmit(tenantContext, await body(req))),
  "POST /api/browser/screenshot": async (req, _url, tenantContext) => json(await browserScreenshot(tenantContext, await body(req))),

  // --- OAuth Integrations ---
  "GET /api/oauth/providers": (_req, _url, tenantContext) => json({ providers: listOAuthProviders(tenantContext) }),
  "POST /api/oauth/start": async (req, _url, tenantContext) => json(startOAuth(tenantContext, await body(req))),
  "POST /api/oauth/token": async (req, _url, tenantContext) => json(saveManualToken(tenantContext, await body(req))),
  "POST /api/oauth/disconnect": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(disconnectOAuth(tenantContext, b.provider));
  },

  // --- Hosting Supervisor ---
  "GET /api/hosting/deployments": (_req, _url, tenantContext) => json({ deployments: listDeployments(tenantContext) }),
  "GET /api/hosting/events": (_req, url, tenantContext) => {
    const name = url.searchParams.get("name") || "";
    const limit = Number(url.searchParams.get("limit") || 200);
    return json({ events: listDeploymentEvents(tenantContext, name, limit) });
  },
  "POST /api/hosting/deploy": async (req, _url, tenantContext) => json(deployService(tenantContext, await body(req))),
  "POST /api/hosting/health": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(await healthCheck(tenantContext, b.name));
  },
  "POST /api/hosting/rollback": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(rollbackDeployment(tenantContext, b.name, b.version));
  },
  "GET /api/hosting/latest": (_req, url, tenantContext) => {
    const dep = latestDeployment(tenantContext, url.searchParams.get("name"));
    return dep ? json({ deployment: dep }) : json({ error: "Deployment nicht gefunden." }, 404);
  },

  // --- Files ---
  "GET /api/files": async (req, url, tenantContext) => json(await executeTool("list_files", { path: url.searchParams.get("path") || "." }, tenantContext)),
  "GET /api/file": async (req, url, tenantContext) => json(await executeTool("read_file", { path: url.searchParams.get("path") }, tenantContext)),
  "POST /api/file": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(await executeTool("write_file", { path: b.path, content: b.content }, tenantContext));
  },

  // --- Upload (multipart/form-data) ---
  "POST /api/upload": async (req, url, tenantContext) => {
    try {
      const tId = tenantId(tenantContext);
      const form = await req.formData();
      const file = form.get("file");
      const pathRaw = (form.get("path") || ".")?.toString?.() || ".";
      if (!file || typeof file === "string") return json({ error: "Kein Datei-Upload gefunden." }, 400);

      const fileName = file.name || "upload.bin";
      // sanitize filename + prevent path traversal
      const safeFileName = fileName.replace(/[/\\]/g, "_").replace(/\.\.+/g, "..").replace(/^\.+/, "");
      if (!safeFileName.trim()) return json({ error: "Ungültiger Dateiname." }, 400);

      const baseDir = pathRaw.replace(/\\/g, "/");
      // keep only relative dir (no absolute, no traversal)
      const safeDir = baseDir.startsWith("/") ? baseDir.slice(1) : baseDir;
      if (safeDir.split("/").some((p) => p === "..")) return json({ error: "Ungültiger Upload-Pfad." }, 400);

      const fullRelative = safeDir === "." || safeDir === "" ? safeFileName : safeDir.replace(/\/+$/, "") + "/" + safeFileName;

      // Write exact bytes (binary-safe) to tenant workspace via base64 tool helper.
      const arrayBuf = await file.arrayBuffer();
      const content_base64 = Buffer.from(arrayBuf).toString("base64");

      const out = await executeTool("write_file_base64", { path: fullRelative, content_base64 }, tenantContext);
      if (out?.error) return json({ error: out.error }, 400);

      return json({
        ok: true,
        path: out?.path || fullRelative,
        bytes: out?.bytes ?? null,
        tenant_id: tId,
      });
    } catch (e) {
      return json({ error: String(e?.message || e) }, 500);
    }
  },

  // --- Web (für Browser-View) ---
  "GET /api/webfetch": async (req, url, tenantContext) => json(await executeTool("web_fetch", { url: url.searchParams.get("url") }, tenantContext)),

  // --- Terminal (One-Shot-Fallback) ---
  "POST /api/exec": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(await executeTool("run_command", { command: b.command, cwd: b.cwd }, tenantContext));
  },

  // --- VM lifecycle (Proxmox) ---
  "GET /api/vm/status": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const vm = getVmInstance(tId);
    if (!vm) return json({ ok: true, vm: null, configured: config.proxmox.enabled });

    if (config.proxmox.enabled && vm.vmid) {
      try {
        const st = await getVmStatus(vm.vmid);
        const mapped = st?.status === "running" ? "ready" : "stopped";
        if (vm.state !== mapped) upsertVmInstance(tId, { state: mapped, last_error: "" });
      } catch (err) {
        logger.warn("vm_status_refresh_failed", { tenant: tId, vmid: vm.vmid, error: String(err?.message || err) });
      }
    }

    return json({ ok: true, vm: vmPublic(getVmInstance(tId)), configured: config.proxmox.enabled });
  },

  "POST /api/vm/create": async (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const existing = getVmInstance(tId);
    if (existing?.vmid) return json({ ok: true, vm: vmPublic(existing), reused: true });

    upsertVmInstance(tId, {
      provider: "proxmox",
      state: "provisioning",
      node: config.proxmox.node || "",
      template_vmid: config.proxmox.templateVmid || null,
      cpu_cores: config.proxmox.cpuCores,
      memory_mb: config.proxmox.memoryMb,
      disk_gb: config.proxmox.diskGb,
      username: config.proxmox.ciUser || "nimbus",
      metadata: { phase: "queued" },
      last_error: "",
    });

    const job = vmOrchestrator.enqueue("provision", tId, {});
    return json({ ok: true, queued: true, job });
  },

  "POST /api/vm/start": async (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const vm = getVmInstance(tId);
    if (!vm?.vmid) return json({ error: "No VM registered for tenant." }, 404);
    const job = vmOrchestrator.enqueue("start", tId, {});
    return json({ ok: true, queued: true, job });
  },

  "POST /api/vm/stop": async (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const vm = getVmInstance(tId);
    if (!vm?.vmid) return json({ error: "No VM registered for tenant." }, 404);
    const job = vmOrchestrator.enqueue("stop", tId, {});
    return json({ ok: true, queued: true, job });
  },

  "GET /api/vm/jobs": async (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const jobs = vmOrchestrator.listJobs(200, tId);
    return json({ ok: true, jobs });
  },

  "GET /api/vm/terminal/sessions": async (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const sessions = listVmTerminalSessions(tId, 100);
    return json({ ok: true, sessions });
  },

  "POST /api/vm/jobs/cancel": async (req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const b = await body(req);
    const job = vmOrchestrator.getJob(b.job_id);
    if (!job || job.tenantId !== tId) return json({ error: "Job not found." }, 404);
    const ok = vmOrchestrator.cancel(b.job_id);
    return json({ ok });
  },

  // --- Space (dynamisches PaaS) ---
  "GET /api/space/routes": async (_req, _url, tenantContext) => {
    return json(listSpaceRoutes(tenantContext));
  },

  "POST /api/space/routes": async (req, _url, tenantContext) => {
    const b = await body(req);
    ensureSpaceScaffold(tenantContext);
    return json(writeSpaceRoute(tenantContext, b));
  },

  "PUT /api/space/routes": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(editSpaceRoute(tenantContext, b));
  },

  "DELETE /api/space/routes": async (req, _url, tenantContext) => {
    const b = await body(req);
    return json(deleteSpaceRoute(tenantContext, b.path));
  },

  // --- Ingress (Zoraxy) — Control Plane only ---
  "GET /api/ingress/status": async (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const vm = getVmInstance(tId);
    const base = ingressStatusForTenant(tId, vm?.ip_address || "");
    const wanIp = config.ingress.wanIp || "45.84.197.154";
    let ports = null;
    const ip = vm?.ip_address || "";
    const m = ip.match(/^10\.10\.0\.(\d+)$/);
    if (m) {
      const n = Number(m[1]);
      ports = {
        wan_ip: wanIp,
        ssh: { public: 10000 + n, target: `${ip}:22`, url: `ssh://ubuntu@${wanIp}:${10000 + n}` },
        space: { public: 11000 + n, target: `${ip}:3000`, url: `http://${wanIp}:${11000 + n}` },
        agent: { public: 12000 + n, target: `${ip}:8100`, url: `http://${wanIp}:${12000 + n}` },
      };
    }
    let metadata = {};
    try {
      metadata = typeof vm?.metadata === "string" ? JSON.parse(vm.metadata || "{}") : (vm?.metadata || {});
    } catch { /* ignore */ }
    return json({
      ok: true,
      ...base,
      vm_state: vm?.state || null,
      vm_ip: ip || null,
      public_url: vm ? `https://${base.hostname}` : null,
      ports,
      bridge: "vmbr1",
      configured: config.ingress.enabled,
      openwrt_manual: true,
      metadata,
    });
  },

  "POST /api/ingress/ensure": async (_req, _url, tenantContext) => {
    const tId = tenantId(tenantContext);
    const vm = getVmInstance(tId);
    if (!vm?.ip_address) return json({ error: "VM hat noch keine IP." }, 400);
    const result = await ensureTenantIngress({
      tenantId: tId,
      ip: vm.ip_address,
      port: config.ingress.spacePort,
    });
    return json({ ok: true, ...result, url: `https://${publicHostnameForTenant(tId)}` });
  },
};

// dynamic routes for /api/chats/:id and /api/share/:token
async function handleDynamicApi(req, url, tenantContext) {
  const tId = tenantId(tenantContext);
  const mChat = url.pathname.match(/^\/api\/chats\/(\d+)(?:\/(share|share\/revoke))?$/);
  if (mChat) {
    const chatId = safeNumber(mChat[1], null);
    if (!chatId) return json({ error: "Invalid chat id." }, 400);

    const action = mChat[2] || "";
    if (req.method === "GET" && !action) {
      const detail = getChatDetail(tId, chatId);
      if (!detail) return json({ error: "Chat not found." }, 404);
      return json(detail);
    }

    if (req.method === "PATCH" && !action) {
      const b = await body(req);
      const patch = {};
      if (typeof b.title === "string") patch.title = b.title.trim() || "Neuer Chat";
      if (b.archived !== undefined) patch.archived = !!b.archived;
      if (b.persona_id !== undefined) patch.persona_id = b.persona_id;
      const updated = updateChat(tId, chatId, patch);
      if (!updated) return json({ error: "Chat not found." }, 404);
      return json({ ok: true, chat: updated });
    }

    if (req.method === "DELETE" && !action) {
      deleteChat(tId, chatId);
      return json({ ok: true });
    }

    if (req.method === "POST" && action === "share") {
      if (!getChatDetail(tId, chatId)) return json({ error: "Chat not found." }, 404);
      const b = await body(req);
      const token = randomBytes(24).toString("base64url");
      const expiresAt = b?.expires_at ? String(b.expires_at) : null;
      createChatShare({ tenantId: tId, chatId, token, expiresAt });
      const base = new URL(req.url);
      const link = `${base.protocol}//${base.host}/api/share/${token}`;
      return json({ ok: true, link, expires_at: expiresAt });
    }

    if (req.method === "POST" && action === "share/revoke") {
      revokeChatShare({ tenantId: tId, chatId });
      return json({ ok: true });
    }

    return json({ error: "Method not allowed." }, 405);
  }

  const mSkill = url.pathname.match(/^\/api\/skills\/(\d+)$/);
  if (mSkill && req.method === "GET") {
    const skill = getSkillByNameOrId(tenantContext, mSkill[1]);
    if (!skill) return json({ error: "Skill nicht gefunden." }, 404);
    return json({ skill });
  }

  const mHosted = url.pathname.match(/^\/_host\/([^\/]+)(\/.*)?$/);
  if (mHosted && req.method === "GET") {
    const serviceName = decodeURIComponent(mHosted[1] || "");
    const suffix = mHosted[2] || "/";
    const dep = latestHealthyDeployment(tenantContext, serviceName);
    if (!dep || !dep.port) return new Response("Hosted service not available", { status: 404 });

    try {
      const targetUrl = `http://127.0.0.1:${dep.port}${suffix}`;
      const upstream = await fetch(targetUrl, {
        method: "GET",
        headers: req.headers,
        signal: AbortSignal.timeout(15000),
      });
      const h = new Headers(upstream.headers);
      h.set("x-nimbus-proxy-service", serviceName);
      return new Response(upstream.body, { status: upstream.status, headers: h });
    } catch (err) {
      return json({ error: `Proxy request failed: ${String(err?.message || err)}` }, 502);
    }
  }

  const mShare = url.pathname.match(/^\/api\/share\/([A-Za-z0-9_\-]+)$/);
  if (mShare && req.method === "GET") {
    const token = mShare[1];
    const resolved = resolveSharedChatByToken(token);
    if (resolved.status === "not_found") return json({ error: "Not found." }, 404);
    if (resolved.status === "revoked") return json({ error: "Share revoked." }, 410);
    if (resolved.status === "expired") return json({ error: "Share expired." }, 410);
    return json({
      chat: resolved.detail.chat,
      runs: resolved.detail.runs,
      events: resolved.detail.events,
      read_only: true,
    });
  }

  return null;
}

// --- Chat-Endpoint mit SSE-Streaming ---
async function handleChat(req) {
  const b = await body(req);
  const tenantContext = resolveTenantFromRequest(req);
  const message = String(b.message || "").trim();
  if (!message) return json({ error: "Message required." }, 400);

  const chatId = safeNumber(b.chat_id ?? b.session_id, null);
  const personaId = b.persona_id ?? null;
  const modelOverride = b.model ?? null;

  const result = await runChatEngine({
    tenantContext,
    message,
    chatId,
    personaId,
    modelOverride,
    mode: "stream",
  });

  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (e) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      send({ type: "session", session_id: result.chat_id, chat_id: result.chat_id, run_id: result.run_id });
      for (const ev of result.events) send(ev);
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

    const tenantContext = resolveTenantFromRequest(req);

    if (url.pathname === "/ws/term") {
      const sessionId = (url.searchParams.get("session_id") || "").trim();
      if (srv.upgrade(req, { data: { proc: null, tenantContext, sessionId } })) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }

    if (req.method === "OPTIONS" && url.pathname.startsWith("/v1/zo/ask")) {
      return jsonResponseWithCors({ ok: true }, 204);
    }

    if (url.pathname === "/v1/zo/ask") {
      const auth = req.headers.get("authorization") || req.headers.get("x-api-key") || "";
      if (!auth || auth.trim().length < 8) return jsonResponseWithCors({ error: "Unauthorized" }, 401);

      if (req.method !== "POST") return jsonResponseWithCors({ error: "Method not allowed" }, 405);

      const b = await body(req);
      const message = String(b.message || "").trim();
      if (!message) return jsonResponseWithCors({ error: "message required" }, 400);

      const conversationId = safeNumber(b.conversation_id, null);
      const personaId = b.persona_id ?? null;
      const modelOverride = b.model ?? null;
      const streamMode = !!b.stream;
      const schema = b?.response_schema || null;

      const result = await runChatEngine({
        tenantContext,
        message,
        chatId: conversationId,
        personaId,
        modelOverride,
        mode: streamMode ? "stream" : "json",
        schema,
      });

      if (streamMode) {
        const rs = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            const send = (e) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            send({ type: "session", conversation_id: result.chat_id, run_id: result.run_id });
            for (const ev of result.events) send(ev);
            send({ type: "done", conversation_id: result.chat_id, run_id: result.run_id });
            controller.close();
          },
        });
        return new Response(rs, {
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
            "access-control-allow-origin": "*",
            "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
            "access-control-allow-headers": "content-type,authorization,x-api-key",
          },
        });
      }

      return jsonResponseWithCors({
        conversation_id: result.chat_id,
        run_id: result.run_id,
        output_text: result.output_text,
        output_json: result.output_json,
        error: result.error,
      });
    }

    if (url.pathname === "/api/oauth/callback") {
      const result = await completeOAuth({
        state: url.searchParams.get("state") || "",
        code: url.searchParams.get("code") || "",
      });
      const text = result.ok
        ? `OAuth verbunden: ${result.provider}. Du kannst dieses Fenster schließen.`
        : `OAuth fehlgeschlagen: ${result.error || "unknown"}`;
      return new Response(text, { status: result.ok ? 200 : 400, headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    const key = `${req.method} ${url.pathname}`;
    if (key === "POST /api/chat") return handleChat(req);

    const dyn = await handleDynamicApi(req, url, tenantContext);
    if (dyn) return dyn;

    const handler = routes[key];
    if (handler) {
      const started = Date.now();
      const wrapped = withErrorHandling(handler);
      const res = await wrapped(req, url, tenantContext);
      logger.info("http_request", {
        method: req.method,
        path: url.pathname,
        tenant: tenantId(tenantContext),
        status: res?.status || 200,
        duration_ms: Date.now() - started,
      });
      return res;
    }

    let path = url.pathname === "/" ? "/index.html"
      : url.pathname === "/app" ? "/app.html"
      : url.pathname;
    const file = Bun.file(join(PUBLIC, path));
    if (await file.exists()) return new Response(file);

    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const tenantContext = ws.data?.tenantContext || { userId: "default" };
      const tId = tenantId(tenantContext);
      ws.data.tenantId = tId;
      ws.data.useVm = false;
      const now = new Date().toISOString();
      const requestedSessionId = (ws.data?.sessionId || "").trim();
      let sessionId = requestedSessionId || `term_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      if (requestedSessionId) {
        const existing = getVmTerminalSession(requestedSessionId);
        if (!existing || existing.tenant_id !== tId) {
          sessionId = `term_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
        }
      }

      ws.data.sessionId = sessionId;

      const vm = getVmInstance(tId);
      if (config.proxmox.enabled && vm?.state === "ready" && vm?.ip_address) {
        try {
          const pty = createVmSshPty({
            ip: vm.ip_address,
            username: vm.username || config.proxmox.ciUser || "nimbus",
          });
          ws.data.proc = pty;
          ws.data.useVm = true;
          pipeToWs(pty.stdout, ws, "out");
          pipeToWs(pty.stderr, ws, "err");
          pty.exited.then((code) => {
            try { ws.send(JSON.stringify({ type: "exit", code })); ws.close(); } catch {}
          });
          upsertVmTerminalSession({
            id: sessionId,
            tenantId: tId,
            mode: "vm",
            vmid: vm.vmid ?? null,
            ip_address: vm.ip_address || "",
            username: vm.username || config.proxmox.ciUser || "nimbus",
            status: "open",
            metadata: { reconnectable: true, transport: "ssh-pty" },
            createdAt: now,
            updatedAt: now,
            lastSeenAt: now,
          });

          ws.send(JSON.stringify({
            type: "ready",
            mode: "vm",
            session_id: sessionId,
            vm: vmPublic(vm),
            cwd: "~",
          }));
          return;
        } catch (err) {
          logger.warn("vm_pty_fallback_local", { tenant: tId, error: String(err?.message || err) });
        }
      }

      const proc = Bun.spawn(["bash"], {
        cwd: tenantContext?.workspaceRoot || WORKSPACE,
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
      upsertVmTerminalSession({
        id: sessionId,
        tenantId: tId,
        mode: "local",
        vmid: null,
        ip_address: "",
        username: "",
        status: "open",
        metadata: { reconnectable: true, transport: "local-bash" },
        createdAt: now,
        updatedAt: now,
        lastSeenAt: now,
      });

      ws.send(JSON.stringify({
        type: "ready",
        mode: "local",
        session_id: sessionId,
        cwd: tenantContext?.workspaceRoot || WORKSPACE,
      }));
    },
    async message(ws, raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === "ping") {
        if (ws.data?.sessionId) {
          upsertVmTerminalSession({
            id: ws.data.sessionId,
            tenantId: ws.data.tenantId || "default",
            status: "open",
            updatedAt: new Date().toISOString(),
            lastSeenAt: new Date().toISOString(),
          });
        }
        return;
      }

      if (m.type !== "cmd") return;

      if (ws.data.useVm) {
        if (!ws.data.proc) {
          ws.send(JSON.stringify({ type: "out", kind: "err", data: "VM PTY unavailable.\n" }));
          return;
        }
        ws.data.proc.stdin.write(String(m.cmd || "") + "\n");
        ws.data.proc.stdin.flush();
        return;
      }

      if (ws.data.proc) {
        ws.data.proc.stdin.write(String(m.cmd || "") + "\n");
        ws.data.proc.stdin.flush();
      }
    },
    close(ws) {
      try { ws.data.proc?.kill(); } catch {}
      if (ws.data?.sessionId) {
        upsertVmTerminalSession({
          id: ws.data.sessionId,
          tenantId: ws.data.tenantId || "default",
          status: "closed",
          updatedAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
        });
      }
    },
  },
});

startScheduler();
console.log(`\n☁  Nimbus läuft auf http://localhost:${server.port}`);
console.log(`   Landing: /    App: /app    Workspace: ${WORKSPACE}`);
if (!hasKey({ userId: "default" })) console.log("   ⚠  Kein API-Key – in der App unter 'Mein Nimbus Space' eintragen.\n");

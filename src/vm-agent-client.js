/**
 * Control-Plane → In-VM-Agent Client.
 *
 * Wenn die Tenant-VM ready ist, wird Chat an POST /v1/ask des VM-Agents
 * weitergereicht (LAN oder WAN-Port 12000+N). Fallback: lokaler Control-Plane-Agent.
 */
import { getVmInstance, getSettingTenant } from "./db.js";
import { config } from "./config.js";
import { logger } from "./logger.js";

function tenantIdOf(tenantContext) {
  return tenantContext?.userId || "default";
}

/** chat_backend: auto | local | vm */
export function getChatBackendPreference(tenantContext) {
  const v = String(
    getSettingTenant(tenantIdOf(tenantContext), "chat_backend", "auto") || "auto",
  ).toLowerCase();
  if (v === "local" || v === "vm" || v === "auto") return v;
  return "auto";
}

export function lanOctetFromIp(ip) {
  const m = String(ip || "").match(/^10\.10\.0\.(\d+)$/);
  return m ? Number(m[1]) : null;
}

/**
 * Erreichbare Basis-URLs für den In-VM-Agent (Reihenfolge: LAN, dann WAN).
 */
export function resolveVmAgentUrls(vm) {
  const urls = [];
  const ip = vm?.ip_address || "";
  const agentPort = config.ingress.agentPort || 8100;
  if (ip) urls.push(`http://${ip}:${agentPort}`);

  const n = lanOctetFromIp(ip);
  const wan = config.ingress.wanIp;
  if (n != null && wan) urls.push(`http://${wan}:${12000 + n}`);

  // Explizite Override-URL (Debugging / Remote)
  const override = (process.env.NIMBUS_VM_AGENT_URL || "").trim();
  if (override) urls.unshift(override.replace(/\/+$/, ""));

  return [...new Set(urls)];
}

export async function probeVmAgent(baseUrl, timeoutMs = 2500) {
  const ctrl = AbortSignal.timeout(timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/health`, { signal: ctrl });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json().catch(() => ({}));
    return { ok: !!data?.ok, data, baseUrl };
  } catch (err) {
    return { ok: false, error: String(err?.message || err), baseUrl };
  }
}

/**
 * Findet einen erreichbaren VM-Agent für den Tenant, oder null.
 */
export async function findReadyVmAgent(tenantContext) {
  const tId = tenantIdOf(tenantContext);
  const vm = getVmInstance(tId);
  if (!vm?.ip_address) return null;
  if (vm.state && !["ready", "running"].includes(vm.state)) return null;

  const urls = resolveVmAgentUrls(vm);
  for (const url of urls) {
    const probe = await probeVmAgent(url);
    if (probe.ok) {
      return { vm, baseUrl: url, health: probe.data };
    }
  }
  return null;
}

function historyToPrompt(messages = []) {
  const lines = [];
  for (const m of messages) {
    const role = m.role || "user";
    let text = "";
    if (typeof m.content === "string") text = m.content;
    else if (Array.isArray(m.content)) {
      text = m.content
        .filter((b) => b?.type === "text")
        .map((b) => b.text || "")
        .join("\n");
    }
    if (!text.trim()) continue;
    lines.push(`${role.toUpperCase()}: ${text.trim()}`);
  }
  return lines.join("\n\n");
}

function extractLastUserText(messages = []) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "user") continue;
    if (typeof m.content === "string") return m.content;
    if (Array.isArray(m.content)) {
      return m.content
        .filter((b) => b?.type === "text")
        .map((b) => b.text || "")
        .join("\n");
    }
  }
  return "";
}

/**
 * Führt eine Anfrage gegen den In-VM-Agent aus und mappt auf Control-Plane-Events.
 *
 * @param {object} opts
 * @param {object} opts.tenantContext
 * @param {array}  opts.messages  Anthropic-ähnliche Historie
 * @param {string} opts.system
 * @param {string} opts.model
 * @param {function} opts.onEvent
 * @param {object} [opts.credentials] Provider-Keys für die VM (optional)
 */
export async function runVmAgentChat({
  tenantContext,
  messages,
  system,
  model,
  onEvent,
  credentials = {},
  baseUrl: forcedBaseUrl,
}) {
  let baseUrl = forcedBaseUrl;
  if (!baseUrl) {
    const ready = await findReadyVmAgent(tenantContext);
    if (!ready) {
      return { ok: false, error: "VM-Agent nicht erreichbar", fallback: true };
    }
    baseUrl = ready.baseUrl;
  }

  const prompt = extractLastUserText(messages) || historyToPrompt(messages);
  const body = {
    prompt,
    model: model || undefined,
    system: system || undefined,
    messages: (messages || []).map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string"
          ? m.content
          : Array.isArray(m.content)
            ? m.content.filter((b) => b?.type === "text").map((b) => b.text || "").join("\n")
            : "",
    })),
    credentials: {
      openai_api_key: credentials.openai_api_key || undefined,
      anthropic_api_key: credentials.anthropic_api_key || undefined,
      google_api_key: credentials.google_api_key || undefined,
      openrouter_api_key: credentials.openrouter_api_key || undefined,
    },
    max_turns: config.maxTurns || 25,
  };

  onEvent?.({ type: "backend", backend: "vm", base_url: baseUrl });

  const ctrl = AbortSignal.timeout(config.toolTimeoutMs || 120000);
  let res;
  try {
    res = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl,
    });
  } catch (err) {
    logger.warn("vm_agent_ask_failed", { baseUrl, error: String(err?.message || err) });
    return { ok: false, error: String(err?.message || err), fallback: true };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return {
      ok: false,
      error: `VM-Agent HTTP ${res.status}: ${text.slice(0, 400)}`,
      fallback: res.status >= 500 || res.status === 404,
    };
  }

  const data = await res.json();
  const trace = Array.isArray(data.tool_trace) ? data.tool_trace : [];

  for (const step of trace) {
    const name = step.tool || step.name || "tool";
    const input = step.input || step.args || {};
    onEvent?.({ type: "tool_use", name, input });
    onEvent?.({
      type: "tool_result",
      name,
      result: step.result ?? step.output ?? step,
    });
  }

  const output = String(data.output || "");
  if (output) onEvent?.({ type: "text", text: output });
  onEvent?.({ type: "done", backend: "vm", mode: data.mode || "vm" });

  // Historie lokal erweitern (wie runAgent)
  if (Array.isArray(messages) && output) {
    messages.push({ role: "assistant", content: [{ type: "text", text: output }] });
  }

  return {
    ok: !!data.ok,
    output,
    mode: data.mode || "vm",
    baseUrl,
    tool_trace: trace,
    fallback: false,
  };
}

/**
 * Entscheidet, ob Chat über VM oder lokal laufen soll.
 */
export async function shouldUseVmAgent(tenantContext) {
  const pref = getChatBackendPreference(tenantContext);
  if (pref === "local") return { use: false, reason: "preference_local" };
  if (pref === "vm") {
    const ready = await findReadyVmAgent(tenantContext);
    if (!ready) return { use: false, reason: "vm_unavailable", preferVm: true };
    return { use: true, ready };
  }
  // auto
  const ready = await findReadyVmAgent(tenantContext);
  if (!ready) return { use: false, reason: "vm_not_ready" };
  return { use: true, ready };
}

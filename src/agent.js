// Nimbus – Agent-Loop mit Multi-Provider-Support (Anthropic, OpenAI, Gemini, Custom OpenAI-kompatibel)
import { getSettingTenant } from "./db.js";
import { TOOL_DEFS, executeTool } from "./tools.js";
import { config } from "./config.js";

const DEFAULT_PROVIDER = "anthropic";
const DEFAULT_MODELS = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-4o-mini",
  google: "gemini-1.5-flash",
  custom: "gpt-4o-mini",
  openrouter: "openai/gpt-4o-mini",
};
const MAX_TURNS = config.maxTurns;

function tenantId(tenantContext) {
  return tenantContext?.userId || "default";
}

function provider(tenantContext) {
  return getSettingTenant(tenantId(tenantContext), "llm_provider", DEFAULT_PROVIDER) || DEFAULT_PROVIDER;
}

function anthropicKey(tenantContext) {
  return (
    getSettingTenant(tenantId(tenantContext), "anthropic_api_key", "") ||
    process.env.ANTHROPIC_API_KEY ||
    ""
  );
}
function openaiKey(tenantContext) {
  return (
    getSettingTenant(tenantId(tenantContext), "openai_api_key", "") ||
    process.env.OPENAI_API_KEY ||
    ""
  );
}
function googleKey(tenantContext) {
  return (
    getSettingTenant(tenantId(tenantContext), "google_api_key", "") ||
    process.env.GEMINI_API_KEY ||
    ""
  );
}
function customKey(tenantContext) {
  return (
    getSettingTenant(tenantId(tenantContext), "custom_api_key", "") ||
    process.env.CUSTOM_LLM_API_KEY ||
    ""
  );
}
function customBaseUrl(tenantContext) {
  return (
    getSettingTenant(tenantId(tenantContext), "custom_base_url", "") ||
    process.env.CUSTOM_LLM_BASE_URL ||
    ""
  );
}

function openrouterKey(tenantContext) {
  return (
    getSettingTenant(tenantId(tenantContext), "openrouter_api_key", "") ||
    process.env.OPENROUTER_API_KEY ||
    ""
  );
}

function providerHasKey(tenantContext, p = provider(tenantContext)) {
  if (p === "anthropic") return !!anthropicKey(tenantContext);
  if (p === "openai") return !!openaiKey(tenantContext);
  if (p === "google") return !!googleKey(tenantContext);
  if (p === "custom") return !!customKey(tenantContext);
  if (p === "openrouter") return !!openrouterKey(tenantContext);
  return false;
}

export function hasKey(tenantContext) {
  return providerHasKey(tenantContext);
}

/**
 * Führt eine Agent-Runde aus. `messages` ist die Anthropic-Historie (mutiert
 * um neue Assistant/Tool-Blöcke). `onEvent` streamt Ereignisse an die UI.
 * Rückgabe: die aktualisierte Nachrichtenliste.
 */

function mapToolDefsToOpenAI() {
  return TOOL_DEFS.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || { type: "object", properties: {} },
    },
  }));
}

function normalizeFromOpenAI(msg) {
  const content = [];
  if (msg.content) {
    content.push({ type: "text", text: msg.content });
  }
  const calls = msg.tool_calls || [];
  for (const c of calls) {
    let input = {};
    try {
      input = JSON.parse(c.function?.arguments || "{}");
    } catch {}
    content.push({
      type: "tool_use",
      id: c.id,
      name: c.function?.name || "unknown_tool",
      input,
    });
  }
  return content;
}

function toOpenAIMessages(messages) {
  const out = [];
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        out.push({ role: "user", content: m.content });
      } else if (Array.isArray(m.content)) {
        const toolResults = m.content.filter((x) => x.type === "tool_result");
        for (const tr of toolResults) {
          out.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: typeof tr.content === "string" ? tr.content : JSON.stringify(tr.content),
          });
        }
      }
    } else if (m.role === "assistant") {
      if (Array.isArray(m.content)) {
        const text = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
        const toolUses = m.content.filter((b) => b.type === "tool_use");
        if (toolUses.length) {
          out.push({
            role: "assistant",
            content: text || null,
            tool_calls: toolUses.map((u) => ({
              id: u.id,
              type: "function",
              function: { name: u.name, arguments: JSON.stringify(u.input || {}) },
            })),
          });
        } else {
          out.push({ role: "assistant", content: text });
        }
      } else if (typeof m.content === "string") {
        out.push({ role: "assistant", content: m.content });
      }
    }
  }
  return out;
}

async function fetchJsonWithTimeout(url, options, timeoutMs = config.httpTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function readApiError(res, label) {
  let text = "";
  try { text = await res.text(); } catch {}

  // blackbox.ai/v1 often returns a JSON error body; keep message usable for user
  // without hardcoding any specific vendor model availability rules.
  let detail = "";
  try {
    const j = text ? JSON.parse(text) : null;
    detail = j?.error?.message || j?.message || text;
  } catch {
    detail = text;
  }

  // If vendor returns "open-source only" we should not treat it as a hard limitation
  // for our UI/UX; surface the exact error message instead.
  return `${label} API ${res.status}: ${String(detail).slice(0, 500)}`;
}

async function runAnthropic({ messages, system, model, onEvent, tenantContext }) {
  const key = anthropicKey(tenantContext);
  if (!key) throw new Error("Kein Anthropic API-Key gesetzt (Settings → BYOK).");

  const useModel =
    model ||
    getSettingTenant(tenantId(tenantContext), "model", DEFAULT_MODELS.anthropic) ||
    DEFAULT_MODELS.anthropic;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetchJsonWithTimeout("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: useModel,
        max_tokens: 8000,
        system,
        tools: TOOL_DEFS,
        messages,
      }),
    });

    if (!res.ok) {
      throw new Error(await readApiError(res, "Anthropic"));
    }

    const data = await res.json();
    messages.push({ role: "assistant", content: data.content });

    for (const block of data.content) {
      if (block.type === "text" && block.text.trim()) onEvent({ type: "text", text: block.text });
    }

    const toolUses = data.content.filter((b) => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
      onEvent({ type: "done", stop_reason: data.stop_reason });
      return messages;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      onEvent({ type: "tool_use", name: tu.name, input: tu.input });
      const result = await executeTool(tu.name, tu.input, tenantContext);
      onEvent({ type: "tool_result", name: tu.name, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result).slice(0, 30000),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  onEvent({ type: "done", stop_reason: "max_turns" });
  return messages;
}

async function runOpenAICompat({
  messages,
  system,
  model,
  onEvent,
  baseUrl,
  apiKey,
  providerLabel,
  tenantContext,
}) {
  if (!apiKey) throw new Error(`Kein ${providerLabel}-API-Key gesetzt (Settings → BYOK).`);

  const useModel =
    model ||
    getSettingTenant(tenantId(tenantContext), "model", DEFAULT_MODELS.openai) ||
    DEFAULT_MODELS.openai;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const oaMessages = [{ role: "system", content: system }, ...toOpenAIMessages(messages)];
    const res = await fetchJsonWithTimeout(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: useModel,
        messages: oaMessages,
        tools: mapToolDefsToOpenAI(),
        tool_choice: "auto",
      }),
    });

  if (!res.ok) {
    throw new Error(await readApiError(res, providerLabel));
  }

    const data = await res.json();
    const choice = data.choices?.[0]?.message;
    if (!choice) throw new Error(`${providerLabel}: Unerwartete API-Antwort.`);

    const content = normalizeFromOpenAI(choice);
    messages.push({ role: "assistant", content });

    for (const block of content) {
      if (block.type === "text" && block.text.trim()) onEvent({ type: "text", text: block.text });
    }

    const toolUses = content.filter((b) => b.type === "tool_use");
    if (!toolUses.length) {
      onEvent({ type: "done", stop_reason: data.choices?.[0]?.finish_reason || "stop" });
      return messages;
    }

    const toolResults = [];
    for (const tu of toolUses) {
      onEvent({ type: "tool_use", name: tu.name, input: tu.input });
      const result = await executeTool(tu.name, tu.input, tenantContext);
      onEvent({ type: "tool_result", name: tu.name, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result).slice(0, 30000),
      });
    }
    messages.push({ role: "user", content: toolResults });
  }

  onEvent({ type: "done", stop_reason: "max_turns" });
  return messages;
}

export async function runAgent({ messages, system, model, onEvent, tenantContext = { userId: "default" } }) {
  const tc = tenantContext || { userId: "default" };
  // Alias: UI/UX may send "blackbox" but we route it to the existing "custom" provider implementation.
  const rawProvider = provider(tc);
  const p = rawProvider === "blackbox" ? "custom" : rawProvider;

  if (!providerHasKey(tc, rawProvider === "blackbox" ? "custom" : p)) {
    if (p === "openai") throw new Error("Kein OpenAI API-Key gesetzt (Settings → BYOK).");
    if (p === "google") throw new Error("Kein Google/Gemini API-Key gesetzt (Settings → BYOK).");
    if (p === "custom") throw new Error("Kein Custom-Provider API-Key gesetzt (Settings → BYOK).");
    throw new Error("Kein Anthropic API-Key gesetzt (Settings → BYOK).");
  }

  if (p === "anthropic") {
    return runAnthropic({ messages, system, model, onEvent, tenantContext: tc });
  }

  if (p === "openai") {
    return runOpenAICompat({
      messages,
      system,
      model: model || getSettingTenant(tenantId(tc), "model", DEFAULT_MODELS.openai) || DEFAULT_MODELS.openai,
      onEvent,
      baseUrl: "https://api.openai.com/v1",
      apiKey: openaiKey(tc),
      providerLabel: "OpenAI",
      tenantContext: tc,
    });
  }

  if (p === "google") {
    // Gemini über OpenAI-kompatiblen Endpoint
    return runOpenAICompat({
      messages,
      system,
      model: model || getSettingTenant(tenantId(tc), "model", DEFAULT_MODELS.google) || DEFAULT_MODELS.google,
      onEvent,
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: googleKey(tc),
      providerLabel: "Google Gemini",
      tenantContext: tc,
    });
  }

  if (p === "custom") {
    // Safeguard for common Blackbox-style base URLs:
    // - Nimbus appends `${baseUrl}/chat/completions`
    // - Users may enter either:
    //   * https://api.blackbox.ai/v1
    //   * https://api.blackbox.ai
    let base = customBaseUrl(tc).replace(/\/+$/, "");
    if (!base) throw new Error("Custom Provider: Base URL fehlt (Settings → BYOK).");

    // If user provided .../v1, strip it so `${base}/chat/completions` becomes correct.
    base = base.replace(/\/v1$/i, "");

    return runOpenAICompat({
      messages,
      system,
      model: model || getSettingTenant(tenantId(tc), "model", DEFAULT_MODELS.custom) || DEFAULT_MODELS.custom,
      onEvent,
      baseUrl: base,
      apiKey: customKey(tc),
      providerLabel: "Custom Provider",
      tenantContext: tc,
    });
  }

  if (p === "openrouter") {
    // OpenRouter is OpenAI-compatible for chat/completions at /v1
    return runOpenAICompat({
      messages,
      system,
      model: model || getSettingTenant(tenantId(tc), "model", DEFAULT_MODELS.openrouter) || DEFAULT_MODELS.openrouter,
      onEvent,
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: openrouterKey(tc),
      providerLabel: "OpenRouter",
      tenantContext: tc,
    });
  }

  throw new Error(`Unbekannter Provider: ${rawProvider}`);
}

// Nimbus – Agent-Loop gegen die Anthropic Messages API
import { getSetting } from "./db.js";
import { TOOL_DEFS, executeTool } from "./tools.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";
const MAX_TURNS = 25;

function apiKey() {
  return getSetting("anthropic_api_key", "") || process.env.ANTHROPIC_API_KEY || "";
}

export function hasKey() {
  return !!apiKey();
}

/**
 * Führt eine Agent-Runde aus. `messages` ist die Anthropic-Historie (mutiert
 * um neue Assistant/Tool-Blöcke). `onEvent` streamt Ereignisse an die UI.
 * Rückgabe: die aktualisierte Nachrichtenliste.
 */
export async function runAgent({ messages, system, model, onEvent }) {
  const key = apiKey();
  if (!key) throw new Error("Kein Anthropic API-Key gesetzt (Settings → BYOK).");
  const useModel = model || getSetting("model", DEFAULT_MODEL) || DEFAULT_MODEL;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const res = await fetch(API_URL, {
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
      const errText = await res.text();
      throw new Error(`Anthropic API ${res.status}: ${errText.slice(0, 500)}`);
    }

    const data = await res.json();
    messages.push({ role: "assistant", content: data.content });

    // Text-Blöcke streamen
    for (const block of data.content) {
      if (block.type === "text" && block.text.trim()) {
        onEvent({ type: "text", text: block.text });
      }
    }

    const toolUses = data.content.filter((b) => b.type === "tool_use");
    if (data.stop_reason !== "tool_use" || toolUses.length === 0) {
      onEvent({ type: "done", stop_reason: data.stop_reason });
      return messages;
    }

    // Tools ausführen
    const toolResults = [];
    for (const tu of toolUses) {
      onEvent({ type: "tool_use", name: tu.name, input: tu.input });
      const result = await executeTool(tu.name, tu.input);
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

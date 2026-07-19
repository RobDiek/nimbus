/**
 * Tenant-Secrets & Access-Tokens (Settings → Erweitert).
 * Werte liegen in der Tenant-Settings-Tabelle (JSON), nie im Repo.
 */
import { randomBytes } from "crypto";
import { getSettingTenant, setSettingTenant } from "./db.js";

function readJson(tenantId, key, fallback) {
  try {
    const raw = getSettingTenant(tenantId, key, "");
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJson(tenantId, key, value) {
  setSettingTenant(tenantId, key, JSON.stringify(value));
}

/** Secrets: { KEY: value } — API gibt Werte maskiert zurück */
export function listSecrets(tenantId) {
  const map = readJson(tenantId, "workspace_secrets", {});
  return Object.keys(map).sort().map((key) => ({
    key,
    masked: "••••••••",
    hasValue: !!map[key],
  }));
}

export function upsertSecret(tenantId, key, value) {
  const k = String(key || "").trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  if (!k) return { error: "KEY_NAME erforderlich" };
  const map = readJson(tenantId, "workspace_secrets", {});
  // .env paste: KEY=value lines
  if (String(key).includes("=") && (value === undefined || value === "")) {
    const lines = String(key).split("\n");
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("=");
      if (i < 1) continue;
      const kk = t.slice(0, i).trim().toUpperCase().replace(/[^A-Z0-9_]/g, "_");
      const vv = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (kk) map[kk] = vv;
    }
    writeJson(tenantId, "workspace_secrets", map);
    return { ok: true, secrets: listSecrets(tenantId) };
  }
  map[k] = String(value ?? "");
  writeJson(tenantId, "workspace_secrets", map);
  return { ok: true, key: k };
}

export function deleteSecret(tenantId, key) {
  const map = readJson(tenantId, "workspace_secrets", {});
  delete map[String(key || "").toUpperCase()];
  writeJson(tenantId, "workspace_secrets", map);
  return { ok: true };
}

export function getSecretMap(tenantId) {
  return readJson(tenantId, "workspace_secrets", {});
}

/** Access tokens für externe API/MCP */
export function listAccessTokens(tenantId) {
  const list = readJson(tenantId, "access_tokens", []);
  return (Array.isArray(list) ? list : []).map((t) => ({
    id: t.id,
    name: t.name,
    created_at: t.created_at,
    last_used_at: t.last_used_at || null,
    token_preview: t.token ? `${t.token.slice(0, 8)}…` : "",
  }));
}

export function createAccessToken(tenantId, name) {
  const n = String(name || "").trim() || "token";
  const list = readJson(tenantId, "access_tokens", []);
  const arr = Array.isArray(list) ? list : [];
  const token = `nim_${randomBytes(24).toString("hex")}`;
  const row = {
    id: `atk_${Date.now().toString(36)}`,
    name: n,
    token,
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  arr.push(row);
  writeJson(tenantId, "access_tokens", arr);
  return { ok: true, id: row.id, name: row.name, token }; // token nur einmal klartext
}

export function deleteAccessToken(tenantId, id) {
  const list = readJson(tenantId, "access_tokens", []);
  const arr = (Array.isArray(list) ? list : []).filter((t) => t.id !== id);
  writeJson(tenantId, "access_tokens", arr);
  return { ok: true };
}

export function getChannels(tenantId) {
  return readJson(tenantId, "channels", {
    emails: [],
    phones: [],
    telegram: null,
    no_reply_confirmation: true,
  });
}

export function saveChannels(tenantId, patch = {}) {
  const cur = getChannels(tenantId);
  const next = { ...cur, ...patch };
  writeJson(tenantId, "channels", next);
  return { ok: true, channels: next };
}

export function getUxSettings(tenantId) {
  return readJson(tenantId, "ux_settings", {
    language: "de",
    compact_chat: false,
    show_tool_details: true,
  });
}

export function saveUxSettings(tenantId, patch = {}) {
  const next = { ...getUxSettings(tenantId), ...patch };
  writeJson(tenantId, "ux_settings", next);
  return { ok: true, ux: next };
}

/** Modell-Routing pro Kanal (Settings → KI) */
export function getChannelModels(tenantId) {
  return readJson(tenantId, "channel_models", {
    chat: { provider: "default", model: "" },
    text: { provider: "default", model: "" },
    email: { provider: "default", model: "" },
    telegram: { provider: "default", model: "" },
    discord: { provider: "default", model: "" },
    slack: { provider: "default", model: "" },
    image: { provider: "default", model: "" },
  });
}

export function saveChannelModels(tenantId, patch = {}) {
  const cur = getChannelModels(tenantId);
  const next = { ...cur };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object") next[k] = { ...cur[k], ...v };
  }
  writeJson(tenantId, "channel_models", next);
  return { ok: true, models: next };
}

export function getToolsSettings(tenantId) {
  return readJson(tenantId, "tools_settings", {
    web_search: true,
    browser: true,
    shell: true,
    space_routes: true,
  });
}

export function saveToolsSettings(tenantId, patch = {}) {
  const next = { ...getToolsSettings(tenantId), ...patch };
  writeJson(tenantId, "tools_settings", next);
  return { ok: true, tools: next };
}

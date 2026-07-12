import { randomBytes } from "crypto";
import { db, getSettingTenant } from "./db.js";

const PROVIDERS = {
  gmail: {
    name: "Gmail",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.compose"],
  },
  gdrive: {
    name: "Google Drive",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: ["https://www.googleapis.com/auth/drive.readonly"],
  },
  gcal: {
    name: "Google Calendar",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    defaultScopes: ["https://www.googleapis.com/auth/calendar"],
  },
  outlook: {
    name: "Outlook",
    authUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenUrl: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    defaultScopes: ["offline_access", "Mail.ReadWrite", "Mail.Send", "Calendars.ReadWrite"],
  },
  slack: {
    name: "Slack",
    authUrl: "https://slack.com/oauth/v2/authorize",
    tokenUrl: "https://slack.com/api/oauth.v2.access",
    defaultScopes: ["channels:read", "chat:write", "users:read"],
  },
  github: {
    name: "GitHub",
    authUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    defaultScopes: ["repo", "read:user", "user:email"],
  },
  telegram: {
    name: "Telegram",
    authUrl: "",
    tokenUrl: "",
    defaultScopes: ["bot:send", "bot:read"],
  },
};

function tenantId(tenantContext) {
  return tenantContext?.userId || "default";
}

function readJson(s, fallback) {
  try { return JSON.parse(s || ""); } catch { return fallback; }
}

function providerConfig(tId, provider) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error(`Unbekannter OAuth-Provider: ${provider}`);
  const prefix = `oauth_${provider}`;
  return {
    ...p,
    clientId: getSettingTenant(tId, `${prefix}_client_id`, process.env[`${provider.toUpperCase()}_CLIENT_ID`] || ""),
    clientSecret: getSettingTenant(tId, `${prefix}_client_secret`, process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] || ""),
  };
}

export function listOAuthProviders(tenantContext) {
  const tId = tenantId(tenantContext);
  const rows = db.query("SELECT * FROM oauth_connections WHERE tenant_id = ?").all(tId);
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return Object.entries(PROVIDERS).map(([id, p]) => {
    const row = byProvider.get(id);
    const cfg = providerConfig(tId, id);
    return {
      id,
      name: p.name,
      configured: !!cfg.clientId || id === "telegram",
      status: row?.status || "disconnected",
      scopes: readJson(row?.scopes, p.defaultScopes),
      expires_at: row?.expires_at || null,
      metadata: readJson(row?.metadata, {}),
    };
  });
}

export function startOAuth(tenantContext, { provider, scopes = [], redirect_uri = "" }) {
  const tId = tenantId(tenantContext);
  const cfg = providerConfig(tId, provider);
  const wantedScopes = scopes.length ? scopes : cfg.defaultScopes;

  if (provider === "telegram") {
    return {
      ok: false,
      provider,
      setup: "Telegram nutzt Bot-Token statt OAuth. Speichere den Bot-Token unter Settings oder per /api/oauth/token.",
    };
  }
  if (!cfg.clientId) return { ok: false, provider, error: `OAuth Client ID für ${provider} fehlt.` };

  const state = randomBytes(18).toString("base64url");
  const redirect = redirect_uri || "/api/oauth/callback";
  db.query("INSERT INTO oauth_states (state, tenant_id, provider, scopes, redirect_uri) VALUES (?, ?, ?, ?, ?)")
    .run(state, tId, provider, JSON.stringify(wantedScopes), redirect);

  const u = new URL(cfg.authUrl);
  u.searchParams.set("client_id", cfg.clientId);
  u.searchParams.set("redirect_uri", redirect);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("state", state);
  u.searchParams.set("scope", wantedScopes.join(" "));
  if (provider.startsWith("g")) {
    u.searchParams.set("access_type", "offline");
    u.searchParams.set("prompt", "consent");
  }
  return { ok: true, provider, auth_url: u.toString(), state };
}

export async function completeOAuth({ state, code }) {
  const row = db.query("SELECT * FROM oauth_states WHERE state = ?").get(state);
  if (!row) return { ok: false, error: "OAuth state nicht gefunden oder abgelaufen." };
  const cfg = providerConfig(row.tenant_id, row.provider);
  if (!cfg.clientId || !cfg.clientSecret) return { ok: false, error: `OAuth Client Secret für ${row.provider} fehlt.` };

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: row.redirect_uri,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
  });
  const res = await fetch(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: params.toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: data.error_description || data.error || `Token exchange failed: ${res.status}` };

  const expiresAt = data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : null;
  db.query(`
    INSERT INTO oauth_connections (tenant_id, provider, status, scopes, access_token, refresh_token, expires_at, metadata, updated_at)
    VALUES (?, ?, 'connected', ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id, provider) DO UPDATE SET
      status='connected',
      scopes=excluded.scopes,
      access_token=excluded.access_token,
      refresh_token=COALESCE(NULLIF(excluded.refresh_token, ''), refresh_token),
      expires_at=excluded.expires_at,
      metadata=excluded.metadata,
      updated_at=datetime('now')
  `).run(row.tenant_id, row.provider, row.scopes, data.access_token || "", data.refresh_token || "", expiresAt, JSON.stringify({ token_type: data.token_type || "" }));
  db.query("DELETE FROM oauth_states WHERE state = ?").run(state);
  return { ok: true, provider: row.provider, status: "connected" };
}

export function saveManualToken(tenantContext, { provider, token = "", refresh_token = "", scopes = [] }) {
  const tId = tenantId(tenantContext);
  providerConfig(tId, provider);
  db.query(`
    INSERT INTO oauth_connections (tenant_id, provider, status, scopes, access_token, refresh_token, metadata, updated_at)
    VALUES (?, ?, 'connected', ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id, provider) DO UPDATE SET
      status='connected',
      scopes=excluded.scopes,
      access_token=excluded.access_token,
      refresh_token=excluded.refresh_token,
      metadata=excluded.metadata,
      updated_at=datetime('now')
  `).run(tId, provider, JSON.stringify(scopes.length ? scopes : PROVIDERS[provider].defaultScopes), token, refresh_token, JSON.stringify({ manual: true }));
  return { ok: true, provider, status: "connected" };
}

export function disconnectOAuth(tenantContext, provider) {
  db.query("UPDATE oauth_connections SET status='disconnected', access_token='', refresh_token='', updated_at=datetime('now') WHERE tenant_id = ? AND provider = ?")
    .run(tenantId(tenantContext), provider);
  return { ok: true, provider };
}

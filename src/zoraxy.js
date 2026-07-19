/**
 * Zoraxy Ingress-Adapter (Phase 4).
 *
 * Legt dynamische Reverse-Proxy-Routen an:
 *   <tenant>.agents.diekerit.com  →  <vm-ip>:<space-port>
 *
 * Modi:
 *  1) HTTP-API (`ZORAXY_BASE_URL` + Token/Login) → POST /api/proxy/add
 *  2) Config-Dir (`ZORAXY_CONFIG_DIR`) → JSON-.config-Datei schreiben
 *  3) Dry-Run, wenn Ingress deaktiviert ist
 *
 * NICHT als Agent-Tool exponieren — nur Control Plane.
 */
import { writeFileSync, mkdirSync, existsSync, unlinkSync } from "fs";
import { join } from "path";
import { config, publicHostnameForTenant, sanitizeTenantSlug } from "./config.js";
import { logger } from "./logger.js";

function encodeForm(data = {}) {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

function buildProxyConfig(hostname, originHost, originPort) {
  return {
    ProxyType: 0,
    RootOrMatchingDomain: hostname,
    MatchingDomainAlias: [],
    ActiveOrigins: [
      {
        OriginIpOrDomain: `${originHost}:${originPort}`,
        RequireTLS: false,
        SkipCertValidations: true,
        SkipWebSocketOriginCheck: true,
        Weight: 1,
        MaxConn: 0,
        RespTimeout: 0,
      },
    ],
    InactiveOrigins: [],
    UseStickySession: false,
    UseActiveLoadBalance: false,
    Disabled: false,
    BypassGlobalTLS: false,
    TlsOptions: {
      DisableSNI: false,
      EnableAutoHTTPS: !!config.ingress.zoraxy.useTls,
      PreferredCertificate: {},
    },
    VirtualDirectories: [],
    Tags: ["nimbus", "auto-provisioned"],
  };
}

async function zoraxyLogin() {
  const z = config.ingress.zoraxy;
  if (!z.baseUrl || !z.username || !z.password) return null;

  const url = `${z.baseUrl.replace(/\/+$/, "")}/api/auth/login`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: encodeForm({ username: z.username, password: z.password }),
  });

  if (!res.ok) {
    throw new Error(`Zoraxy login failed: HTTP ${res.status}`);
  }

  const setCookie = res.headers.getSetCookie?.() || [];
  const cookieHeader = setCookie.map((c) => c.split(";")[0]).join("; ");
  if (cookieHeader) return cookieHeader;

  // Fallback: manche Builds liefern Token im Body
  try {
    const body = await res.json();
    return body?.token || body?.session || null;
  } catch {
    return null;
  }
}

async function zoraxyRequest(path, init = {}) {
  const z = config.ingress.zoraxy;
  if (!z.baseUrl) throw new Error("Missing ZORAXY_BASE_URL.");

  const headers = { ...(init.headers || {}) };
  if (z.apiToken) {
    headers.Authorization = `Bearer ${z.apiToken}`;
    headers["X-API-Token"] = z.apiToken;
  } else {
    const cookie = await zoraxyLogin();
    if (cookie) headers.Cookie = cookie;
  }

  const url = `${z.baseUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }

  if (!res.ok) {
    throw new Error(`Zoraxy request failed (${res.status}) ${path}: ${text || res.statusText}`);
  }
  return parsed;
}

function writeConfigFile(hostname, originHost, originPort) {
  const dir = config.ingress.zoraxy.configDir;
  if (!dir) throw new Error("Missing ZORAXY_CONFIG_DIR.");
  mkdirSync(dir, { recursive: true });
  const safeName = hostname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(dir, `${safeName}.config`);
  const payload = buildProxyConfig(hostname, originHost, originPort);
  writeFileSync(filePath, JSON.stringify(payload, null, 2));
  return { mode: "config_file", path: filePath, hostname, origin: `${originHost}:${originPort}` };
}

function removeConfigFile(hostname) {
  const dir = config.ingress.zoraxy.configDir;
  if (!dir) return { ok: false, skipped: true };
  const safeName = hostname.replace(/[^a-zA-Z0-9._-]/g, "_");
  const filePath = join(dir, `${safeName}.config`);
  if (existsSync(filePath)) unlinkSync(filePath);
  return { ok: true, removed: filePath };
}

/**
 * Route für Tenant anlegen / aktualisieren.
 * @returns {{ ok: boolean, hostname: string, origin: string, mode: string, dryRun?: boolean }}
 */
export async function ensureTenantIngress({ tenantId, ip, port }) {
  const hostname = publicHostnameForTenant(tenantId);
  const originPort = Number(port) || config.ingress.spacePort;
  const originHost = ip;
  const origin = `${originHost}:${originPort}`;

  if (!config.ingress.enabled) {
    logger.info("zoraxy_dry_run", { hostname, origin, reason: "ZORAXY_ENABLED=false" });
    return { ok: true, dryRun: true, mode: "dry_run", hostname, origin };
  }

  if (!originHost) {
    throw new Error("Cannot create ingress without VM IP.");
  }

  // Prefer config-dir when set (robust, no auth dance)
  if (config.ingress.zoraxy.configDir) {
    const result = writeConfigFile(hostname, originHost, originPort);
    logger.info("zoraxy_config_written", result);
    return { ok: true, ...result };
  }

  if (!config.ingress.zoraxy.baseUrl) {
    logger.warn("zoraxy_skipped", { hostname, reason: "no baseUrl and no configDir" });
    return { ok: true, dryRun: true, mode: "dry_run", hostname, origin, warning: "Zoraxy not configured" };
  }

  // Zoraxy HTTP API: form-encoded add/edit
  const body = encodeForm({
    rootname: hostname,
    domain: hostname,
    origin: origin,
    dest: origin,
    useTLS: config.ingress.zoraxy.useTls ? "true" : "false",
  });

  try {
    await zoraxyRequest(config.ingress.zoraxy.addPath, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    logger.info("zoraxy_route_added", { hostname, origin });
    return { ok: true, mode: "http_api", hostname, origin };
  } catch (err) {
    // Edit als Fallback, falls Route schon existiert
    try {
      await zoraxyRequest("/api/proxy/edit", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      });
      logger.info("zoraxy_route_updated", { hostname, origin });
      return { ok: true, mode: "http_api_edit", hostname, origin };
    } catch (err2) {
      logger.error("zoraxy_route_failed", {
        hostname,
        origin,
        error: String(err2?.message || err2 || err?.message || err),
      });
      throw err2;
    }
  }
}

export async function removeTenantIngress({ tenantId }) {
  const hostname = publicHostnameForTenant(tenantId);
  if (!config.ingress.enabled) {
    return { ok: true, dryRun: true, hostname };
  }
  if (config.ingress.zoraxy.configDir) {
    return removeConfigFile(hostname);
  }
  // Best-effort delete via API (endpoint-Namen variieren je Zoraxy-Version)
  try {
    await zoraxyRequest("/api/proxy/delete", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: encodeForm({ rootname: hostname, domain: hostname }),
    });
    return { ok: true, mode: "http_api", hostname };
  } catch (err) {
    logger.warn("zoraxy_delete_failed", { hostname, error: String(err?.message || err) });
    return { ok: false, hostname, error: String(err?.message || err) };
  }
}

export function ingressStatusForTenant(tenantId, ip) {
  const hostname = publicHostnameForTenant(tenantId);
  const slug = sanitizeTenantSlug(tenantId);
  return {
    hostname,
    url: `https://${hostname}`,
    origin: ip ? `${ip}:${config.ingress.spacePort}` : null,
    enabled: config.ingress.enabled,
    baseDomain: config.ingress.baseDomain,
    slug,
  };
}

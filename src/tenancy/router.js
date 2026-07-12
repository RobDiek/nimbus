import { join } from "path";
import { mkdirSync } from "fs";
import { ROOT } from "../db.js";

const BASE_DOMAIN = "nimbus.diekerit.com";
const DEFAULT_TENANT_ID = "default";
const TENANT_ID_RE = /^[a-z0-9-]{1,64}$/;

export function resolveTenantFromRequest(req) {
  const host = (req?.headers?.get?.("host") || "").split(":")[0].toLowerCase();
  const userId = extractUserIdFromHost(host);

  // P0 contract prep: auth/session placeholders so downstream layers can
  // enforce authenticated tenant binding without changing context shape.
  const auth = {
    isAuthenticated: false,
    sessionId: null,
    subject: null,
    source: "hostname",
  };

  return buildTenantContext(userId, auth);
}

export function extractUserIdFromHost(hostname) {
  // expected: `${userId}.nimbus.diekerit.com`
  if (!hostname) return null;
  if (!hostname.endsWith(`.${BASE_DOMAIN}`) && hostname !== `localhost` && hostname !== `127.0.0.1`) {
    return null;
  }

  // localhost / 127.0.0.1 -> default tenant
  if (hostname === "localhost" || hostname === "127.0.0.1") return null;

  const parts = hostname.split(".");
  // e.g. ["abc123", "nimbus", "diekerit", "com"] => take left-most as userId
  return parts.length >= 4 ? parts[0] : null;
}

function sanitizeTenantId(value) {
  if (typeof value !== "string") return DEFAULT_TENANT_ID;
  const v = value.trim().toLowerCase();
  if (!TENANT_ID_RE.test(v)) return DEFAULT_TENANT_ID;
  return v;
}

export function buildTenantContext(tenantId, auth = null) {
  const userId = sanitizeTenantId(tenantId);
  const workspaceRoot = join(ROOT, "workspace", userId);
  mkdirSync(workspaceRoot, { recursive: true });

  // config placeholder (später pro tenant aus DB)
  const config = {
    llmProvider: null,
    integrations: {},
    model: null,
    apiKeysRef: null,
  };

  const authContext = auth && typeof auth === "object"
    ? {
        isAuthenticated: !!auth.isAuthenticated,
        sessionId: auth.sessionId || null,
        subject: auth.subject || null,
        source: auth.source || "unknown",
      }
    : {
        isAuthenticated: false,
        sessionId: null,
        subject: null,
        source: "unknown",
      };

  return { userId, tenantId: userId, workspaceRoot, config, auth: authContext };
}

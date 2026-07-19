/**
 * Cloudflare DNS-Automapping für Nimbus-Tenant-Hosts.
 *
 * Schema: <slug>.nimbus.diekerit.com → WAN-IP (OpenWRT)
 * Zusätzlich: Apex nimbus.diekerit.com + Wildcard *.nimbus.diekerit.com
 *
 * Nur Control Plane — niemals als Agent-Tool.
 */
import { config, publicHostnameForTenant, sanitizeTenantSlug } from "./config.js";
import { logger } from "./logger.js";

const CF_API = "https://api.cloudflare.com/client/v4";

function cfEnabled() {
  return !!(config.ingress.cloudflare?.apiToken);
}

async function cfRequest(path, init = {}) {
  const token = config.ingress.cloudflare.apiToken;
  if (!token) throw new Error("CLOUDFLARE_API_TOKEN fehlt.");

  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    const errMsg =
      (Array.isArray(data?.errors) && data.errors.map((e) => e.message).join("; ")) ||
      data?.message ||
      `HTTP ${res.status}`;
    throw new Error(`Cloudflare API: ${errMsg}`);
  }
  return data?.result ?? data;
}

export async function resolveCloudflareZoneId() {
  const configured = config.ingress.cloudflare.zoneId;
  if (configured) return configured;

  const zoneName = config.ingress.cloudflare.zoneName || "diekerit.com";
  const zones = await cfRequest(`/zones?name=${encodeURIComponent(zoneName)}`);
  const list = Array.isArray(zones) ? zones : [];
  const zone = list.find((z) => z.name === zoneName) || list[0];
  if (!zone?.id) throw new Error(`Cloudflare-Zone nicht gefunden: ${zoneName}`);
  return zone.id;
}

async function listDnsByName(zoneId, name) {
  const q = new URLSearchParams({ name, per_page: "50" });
  const result = await cfRequest(`/zones/${zoneId}/dns_records?${q}`);
  return Array.isArray(result) ? result : [];
}

/**
 * Legt A-Record an oder aktualisiert ihn (idempotent).
 */
export async function upsertDnsARecord({
  name,
  content,
  proxied = false,
  ttl = 1, // 1 = automatic
  comment = "nimbus-auto",
}) {
  if (!cfEnabled()) {
    return { ok: true, dryRun: true, name, content, reason: "CLOUDFLARE_API_TOKEN unset" };
  }
  if (!name || !content) throw new Error("name und content erforderlich");

  const zoneId = await resolveCloudflareZoneId();
  const existing = await listDnsByName(zoneId, name);
  const aRecords = existing.filter((r) => r.type === "A");

  if (aRecords.length > 0) {
    const rec = aRecords[0];
    if (rec.content === content && !!rec.proxied === !!proxied) {
      return {
        ok: true,
        action: "unchanged",
        id: rec.id,
        name: rec.name,
        content: rec.content,
        proxied: rec.proxied,
        zoneId,
      };
    }
    const updated = await cfRequest(`/zones/${zoneId}/dns_records/${rec.id}`, {
      method: "PUT",
      body: JSON.stringify({
        type: "A",
        name,
        content,
        ttl,
        proxied: !!proxied,
        comment,
      }),
    });
    logger.info("cloudflare_dns_updated", { name, content, proxied: !!proxied });
    return {
      ok: true,
      action: "updated",
      id: updated.id,
      name: updated.name,
      content: updated.content,
      proxied: updated.proxied,
      zoneId,
    };
  }

  const created = await cfRequest(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({
      type: "A",
      name,
      content,
      ttl,
      proxied: !!proxied,
      comment,
    }),
  });
  logger.info("cloudflare_dns_created", { name, content, proxied: !!proxied });
  return {
    ok: true,
    action: "created",
    id: created.id,
    name: created.name,
    content: created.content,
    proxied: created.proxied,
    zoneId,
  };
}

/**
 * Basis-Records für die Nimbus-Domain (Apex + Wildcard).
 */
export async function ensureNimbusBaseDns(wanIp = config.ingress.wanIp) {
  const domain = config.ingress.baseDomain; // nimbus.diekerit.com
  const proxied = !!config.ingress.cloudflare.proxied;
  const ip = wanIp || config.ingress.wanIp;
  if (!ip) throw new Error("WAN-IP fehlt (OPENWRT_WAN_IP / config.ingress.wanIp)");

  const apex = await upsertDnsARecord({
    name: domain,
    content: ip,
    proxied,
    comment: "nimbus-apex",
  });
  const wildcard = await upsertDnsARecord({
    name: `*.${domain}`,
    content: ip,
    proxied,
    comment: "nimbus-wildcard",
  });

  return { ok: true, domain, ip, apex, wildcard };
}

/**
 * Tenant-Hostname anlegen/aktualisieren:
 *   robin.nimbus.diekerit.com → WAN-IP
 */
export async function ensureTenantDns({ tenantId, wanIp } = {}) {
  const hostname = publicHostnameForTenant(tenantId);
  const slug = sanitizeTenantSlug(tenantId);
  const ip = wanIp || config.ingress.wanIp;
  const proxied = !!config.ingress.cloudflare.proxied;

  if (!cfEnabled()) {
    return {
      ok: true,
      dryRun: true,
      hostname,
      slug,
      content: ip,
      reason: "CLOUDFLARE_API_TOKEN unset",
    };
  }

  // Wildcard reicht oft — trotzdem expliziten Record für Klarheit / spätere Overrides
  const base = await ensureNimbusBaseDns(ip);
  const record = await upsertDnsARecord({
    name: hostname,
    content: ip,
    proxied,
    comment: `nimbus-tenant:${slug}`,
  });

  return {
    ok: true,
    hostname,
    slug,
    url: `https://${hostname}`,
    content: ip,
    record,
    base,
  };
}

export async function removeTenantDns({ tenantId } = {}) {
  if (!cfEnabled()) return { ok: true, dryRun: true };
  const hostname = publicHostnameForTenant(tenantId);
  const zoneId = await resolveCloudflareZoneId();
  const existing = await listDnsByName(zoneId, hostname);
  const removed = [];
  for (const rec of existing.filter((r) => r.type === "A")) {
    await cfRequest(`/zones/${zoneId}/dns_records/${rec.id}`, { method: "DELETE" });
    removed.push(rec.id);
  }
  return { ok: true, hostname, removed };
}

export function cloudflareStatus() {
  return {
    enabled: cfEnabled(),
    zoneId: config.ingress.cloudflare.zoneId || null,
    zoneName: config.ingress.cloudflare.zoneName || "diekerit.com",
    baseDomain: config.ingress.baseDomain,
    wanIp: config.ingress.wanIp,
    proxied: !!config.ingress.cloudflare.proxied,
    hasToken: cfEnabled(),
  };
}

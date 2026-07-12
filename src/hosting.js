import { db } from "./db.js";
import { services } from "./services.js";

function tenantId(tenantContext) {
  return tenantContext?.userId || "default";
}

function readPort(command, explicitPort) {
  if (Number.isFinite(Number(explicitPort))) return Number(explicitPort);
  const text = String(command || "");
  const m = text.match(/(?:--port|-p)\s+(\d{2,5})|\bPORT=(\d{2,5})\b|:(\d{2,5})\b/);
  return Number(m?.[1] || m?.[2] || m?.[3] || 0) || null;
}

function publicUrls(tenantContext, serviceName, port) {
  const baseHost = process.env.NIMBUS_PUBLIC_HOST || tenantContext?.host || "localhost";
  const safe = String(serviceName || "service").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "service";
  if (baseHost === "localhost" || baseHost.startsWith("localhost:")) {
    return {
      public_url: port ? `http://localhost:${port}` : "",
      https_url: "",
    };
  }
  return {
    public_url: `http://${safe}.${baseHost}`,
    https_url: `https://${safe}.${baseHost}`,
  };
}

function mapDeployment(row) {
  return row ? { ...row, port: row.port ?? null, rollback_of: row.rollback_of ?? null } : null;
}

export function listDeployments(tenantContext) {
  return db.query(`
    SELECT * FROM hosting_deployments
    WHERE tenant_id = ?
    ORDER BY service_name ASC, version DESC
  `).all(tenantId(tenantContext)).map(mapDeployment);
}

export function latestDeployment(tenantContext, serviceName) {
  return mapDeployment(db.query(`
    SELECT * FROM hosting_deployments
    WHERE tenant_id = ? AND service_name = ?
    ORDER BY version DESC LIMIT 1
  `).get(tenantId(tenantContext), serviceName));
}

export function deployService(tenantContext, { name, command, cwd = "", port = null, health_path = "/" }) {
  if (!name || !command) throw new Error("name und command sind erforderlich.");
  const tId = tenantId(tenantContext);
  const old = latestDeployment(tenantContext, name);
  const version = Number(old?.version || 0) + 1;
  const resolvedPort = readPort(command, port);
  const urls = publicUrls(tenantContext, name, resolvedPort);
  const healthUrl = urls.public_url ? `${urls.public_url.replace(/\/+$/, "")}${health_path || "/"}` : "";

  const started = services.start(tId, name, command, cwd, tenantContext?.workspaceRoot);
  if (started?.error && !String(started.error).includes("läuft bereits")) return started;

  db.query(`
    INSERT INTO hosting_deployments
      (tenant_id, service_name, version, command, cwd, port, public_url, https_url, status, health_url, health_status, rollback_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 'unknown', NULL)
  `).run(tId, name, version, command, cwd || "", resolvedPort, urls.public_url, urls.https_url, healthUrl);

  return { ok: true, deployment: latestDeployment(tenantContext, name), service: started };
}

export async function healthCheck(tenantContext, serviceName) {
  const dep = latestDeployment(tenantContext, serviceName);
  if (!dep) return { ok: false, error: "Deployment nicht gefunden." };
  let status = "unknown";
  let detail = "";
  if (!dep.health_url) {
    status = "no_url";
  } else {
    try {
      const res = await fetch(dep.health_url, { method: "GET", signal: AbortSignal.timeout(8000) });
      status = res.ok ? "healthy" : "unhealthy";
      detail = `HTTP ${res.status}`;
    } catch (err) {
      status = "unhealthy";
      detail = String(err?.message || err);
    }
  }
  db.query(`
    UPDATE hosting_deployments
    SET health_status = ?, last_health_at = datetime('now')
    WHERE tenant_id = ? AND id = ?
  `).run(status, tenantId(tenantContext), dep.id);
  return { ok: status === "healthy", status, detail, deployment: latestDeployment(tenantContext, serviceName) };
}

export function rollbackDeployment(tenantContext, serviceName, targetVersion = null) {
  const tId = tenantId(tenantContext);
  const current = latestDeployment(tenantContext, serviceName);
  if (!current) return { ok: false, error: "Deployment nicht gefunden." };
  const target = targetVersion
    ? db.query("SELECT * FROM hosting_deployments WHERE tenant_id = ? AND service_name = ? AND version = ?").get(tId, serviceName, Number(targetVersion))
    : db.query("SELECT * FROM hosting_deployments WHERE tenant_id = ? AND service_name = ? AND version < ? ORDER BY version DESC LIMIT 1").get(tId, serviceName, current.version);
  if (!target) return { ok: false, error: "Keine vorherige Version gefunden." };

  services.stop(tId, serviceName);
  const started = services.start(tId, serviceName, target.command, target.cwd, tenantContext?.workspaceRoot);
  if (started?.error && !String(started.error).includes("läuft bereits")) return started;

  const version = Number(current.version || 0) + 1;
  db.query(`
    INSERT INTO hosting_deployments
      (tenant_id, service_name, version, command, cwd, port, public_url, https_url, status, health_url, health_status, rollback_of)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, 'unknown', ?)
  `).run(tId, serviceName, version, target.command, target.cwd, target.port, target.public_url, target.https_url, target.health_url, target.id);

  return { ok: true, deployment: latestDeployment(tenantContext, serviceName), rolled_back_to: target.version };
}

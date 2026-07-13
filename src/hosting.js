import { db, encryptSecret, decryptSecret } from "./db.js";
import { services } from "./services.js";

const PORT_RANGE_START = 20000;
const PORT_RANGE_END = 29999;
const MAX_RESTARTS = 3;
const RESTART_BACKOFF_MS = 1200;

const restartState = new Map(); // key: tenant:service -> { failures, lastAt, timer }

function tenantId(tenantContext) {
  return tenantContext?.userId || "default";
}

function keyFor(tId, serviceName) {
  return `${tId}:${serviceName}`;
}

function readPort(command, explicitPort) {
  if (Number.isFinite(Number(explicitPort))) return Number(explicitPort);
  const text = String(command || "");
  const m = text.match(/(?:--port|-p)\s+(\d{2,5})|\bPORT=(\d{2,5})\b|:(\d{2,5})\b/);
  return Number(m?.[1] || m?.[2] || m?.[3] || 0) || null;
}

function allocateInternalPort(tId, preferred = null) {
  const p = Number(preferred);
  if (Number.isFinite(p) && p >= 1 && p <= 65535) return p;
  const rows = db.query(`
    SELECT port FROM hosting_deployments
    WHERE tenant_id = ? AND port IS NOT NULL
  `).all(tId);
  const used = new Set(rows.map((r) => Number(r.port)).filter((n) => Number.isFinite(n)));
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (!used.has(port)) return port;
  }
  throw new Error("Keine freien internen Ports im Bereich 20000-29999 verfügbar.");
}

function publicUrls(tenantContext, serviceName, port, customDomain = "", tlsEnabled = false) {
  const baseHost = process.env.NIMBUS_PUBLIC_HOST || tenantContext?.host || "localhost";
  const safe = String(serviceName || "service").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "service";
  const cd = String(customDomain || "").trim().toLowerCase();

  if (cd) {
    return {
      public_url: `http://${cd}`,
      https_url: tlsEnabled ? `https://${cd}` : "",
    };
  }

  if (baseHost === "localhost" || baseHost.startsWith("localhost:")) {
    return {
      public_url: port ? `http://localhost:${port}` : "",
      https_url: tlsEnabled && port ? `https://localhost:${port}` : "",
    };
  }
  return {
    public_url: `http://${safe}.${baseHost}`,
    https_url: tlsEnabled ? `https://${safe}.${baseHost}` : "",
  };
}

function healthUrlForPort(port, healthPath = "/") {
  const hp = String(healthPath || "/").startsWith("/") ? String(healthPath || "/") : `/${healthPath}`;
  return port ? `http://127.0.0.1:${port}${hp}` : "";
}

function mapDeployment(row) {
  return row ? {
    ...row,
    port: row.port ?? null,
    rollback_of: row.rollback_of ?? null,
    tls_enabled: Number(row.tls_enabled || 0),
    cpu_limit: Number(row.cpu_limit || 0),
    memory_limit_mb: Number(row.memory_limit_mb || 0),
  } : null;
}

function addDeploymentEvent(tId, deployment, event_type, message, level = "info", payload = {}) {
  if (!deployment?.id) return;
  db.query(`
    INSERT INTO hosting_deployment_events
      (deployment_id, tenant_id, service_name, version, level, event_type, message, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    deployment.id,
    tId,
    deployment.service_name,
    deployment.version,
    level,
    event_type,
    String(message || ""),
    JSON.stringify(payload || {})
  );
}

function saveDeploymentEnv(tId, deploymentId, env = {}, secrets = {}) {
  const normEnv = (env && typeof env === "object") ? env : {};
  const normSecrets = (secrets && typeof secrets === "object") ? secrets : {};
  const ins = db.query(`
    INSERT INTO hosting_deployment_env
      (deployment_id, tenant_id, key, value, is_secret, value_encrypted, created_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  for (const [k, v] of Object.entries(normEnv)) {
    if (!k) continue;
    ins.run(deploymentId, tId, String(k), String(v ?? ""), 0, "");
  }
  for (const [k, v] of Object.entries(normSecrets)) {
    if (!k) continue;
    const plain = String(v ?? "");
    ins.run(deploymentId, tId, String(k), "", 1, encryptSecret(plain));
  }
}

function envForDeployment(tId, deploymentId) {
  const rows = db.query(`
    SELECT key, value, is_secret, value_encrypted FROM hosting_deployment_env
    WHERE tenant_id = ? AND deployment_id = ?
  `).all(tId, deploymentId);
  const out = {};
  for (const r of rows) {
    out[r.key] = Number(r.is_secret || 0) === 1 ? decryptSecret(r.value_encrypted) : r.value;
  }
  return out;
}

function scheduleRestartIfNeeded(tenantContext, dep, reason = "Service abgestürzt") {
  if (!dep) return;
  const tId = tenantId(tenantContext);
  const key = keyFor(tId, dep.service_name);
  const cur = restartState.get(key) || { failures: 0, lastAt: 0, timer: null };
  if (cur.failures >= MAX_RESTARTS) {
    addDeploymentEvent(tId, dep, "restart_giveup", `Restart-Limit erreicht (${MAX_RESTARTS}).`, "warn", { reason });
    db.query("UPDATE hosting_deployments SET status = 'failed' WHERE tenant_id = ? AND id = ?").run(tId, dep.id);
    return;
  }
  if (cur.timer) clearTimeout(cur.timer);

  cur.failures += 1;
  cur.lastAt = Date.now();
  addDeploymentEvent(tId, dep, "restart_scheduled", `Automatischer Restart #${cur.failures} geplant.`, "warn", { reason });

  cur.timer = setTimeout(() => {
    const env = envForDeployment(tId, dep.id);
    const started = services.start(tId, dep.service_name, dep.command, dep.cwd, tenantContext?.workspaceRoot, env);
    if (started?.error && !String(started.error).includes("läuft bereits")) {
      addDeploymentEvent(tId, dep, "restart_failed", `Restart fehlgeschlagen: ${started.error}`, "error");
      db.query("UPDATE hosting_deployments SET status = 'failed' WHERE tenant_id = ? AND id = ?").run(tId, dep.id);
      return;
    }
    addDeploymentEvent(tId, dep, "restart_ok", `Service erfolgreich neu gestartet (Versuch ${cur.failures}).`, "info");
    db.query("UPDATE hosting_deployments SET status = 'running' WHERE tenant_id = ? AND id = ?").run(tId, dep.id);
  }, RESTART_BACKOFF_MS);

  restartState.set(key, cur);
}

function startServiceWithRestartPolicy(tenantContext, dep, env = {}) {
  const tId = tenantId(tenantContext);
  const key = keyFor(tId, dep.service_name);
  const started = services.start(tId, dep.service_name, dep.command, dep.cwd, tenantContext?.workspaceRoot, env);
  if (started?.error && !String(started.error).includes("läuft bereits")) return started;

  const cur = restartState.get(key) || { failures: 0, lastAt: 0, timer: null };
  cur.failures = 0;
  if (cur.timer) clearTimeout(cur.timer);
  cur.timer = null;
  restartState.set(key, cur);

  return started;
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

export function latestHealthyDeployment(tenantContext, serviceName) {
  return mapDeployment(db.query(`
    SELECT * FROM hosting_deployments
    WHERE tenant_id = ? AND service_name = ? AND health_status = 'healthy'
    ORDER BY version DESC LIMIT 1
  `).get(tenantId(tenantContext), serviceName));
}

export function deployService(tenantContext, {
  name,
  command,
  cwd = "",
  port = null,
  health_path = "/",
  env = {},
  secrets = {},
  custom_domain = "",
  tls_enabled = false,
  cpu_limit = 0,
  memory_limit_mb = 0,
}) {
  if (!name || !command) throw new Error("name und command sind erforderlich.");
  const tId = tenantId(tenantContext);
  const old = latestDeployment(tenantContext, name);
  const version = Number(old?.version || 0) + 1;

  const parsedPort = readPort(command, port);
  const resolvedPort = allocateInternalPort(tId, parsedPort);

  const internalHealthUrl = healthUrlForPort(resolvedPort, health_path || "/");
  const plannedUrls = publicUrls(tenantContext, name, resolvedPort, custom_domain, !!tls_enabled);

  db.query(`
    INSERT INTO hosting_deployments
      (tenant_id, service_name, version, command, cwd, port, public_url, https_url, status, health_url, health_status, rollback_of, custom_domain, tls_enabled, tls_status, cpu_limit, memory_limit_mb)
    VALUES (?, ?, ?, ?, ?, ?, '', '', 'starting', ?, 'unknown', NULL, ?, ?, ?, ?, ?)
  `).run(
    tId,
    name,
    version,
    command,
    cwd || "",
    resolvedPort,
    internalHealthUrl,
    String(custom_domain || ""),
    tls_enabled ? 1 : 0,
    tls_enabled ? "enabled" : "disabled",
    Number(cpu_limit || 0),
    Number(memory_limit_mb || 0)
  );

  const dep = latestDeployment(tenantContext, name);
  addDeploymentEvent(tId, dep, "deploy_started", `Deployment v${version} gestartet.`, "info", {
    port: resolvedPort,
    health_path,
    custom_domain,
    tls_enabled: !!tls_enabled,
    cpu_limit: Number(cpu_limit || 0),
    memory_limit_mb: Number(memory_limit_mb || 0),
  });

  if (dep?.id) saveDeploymentEnv(tId, dep.id, env, secrets);

  const mergedEnv = { ...(env || {}), ...(secrets || {}), PORT: String(resolvedPort) };
  const started = startServiceWithRestartPolicy(tenantContext, { ...dep, command, cwd, service_name: name }, mergedEnv);
  if (started?.error && !String(started.error).includes("läuft bereits")) {
    addDeploymentEvent(tId, dep, "service_start_failed", String(started.error), "error");
    db.query("UPDATE hosting_deployments SET status = 'failed' WHERE tenant_id = ? AND id = ?").run(tId, dep.id);
    return started;
  }

  addDeploymentEvent(tId, dep, "service_started", "Service gestartet. Warte auf Healthcheck.", "info");
  db.query("UPDATE hosting_deployments SET status = 'running' WHERE tenant_id = ? AND id = ?").run(tId, dep.id);

  // no public activation here: publish only after successful health check
  addDeploymentEvent(tId, dep, "publish_pending_health", "public_url bleibt inaktiv bis health_status=healthy.", "info", plannedUrls);

  return { ok: true, deployment: latestDeployment(tenantContext, name), service: started };
}

export async function healthCheck(tenantContext, serviceName) {
  const tId = tenantId(tenantContext);
  const dep = latestDeployment(tenantContext, serviceName);
  if (!dep) return { ok: false, error: "Deployment nicht gefunden." };

  let status = "unknown";
  let detail = "";

  if (!dep.health_url) {
    status = "no_url";
    detail = "Kein Healthcheck-URL gesetzt.";
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

  if (status === "healthy") {
    const urls = publicUrls(tenantContext, dep.service_name, dep.port, dep.custom_domain, Number(dep.tls_enabled || 0) === 1);
    db.query(`
      UPDATE hosting_deployments
      SET health_status = ?, last_health_at = datetime('now'), public_url = ?, https_url = ?, status = 'running'
      WHERE tenant_id = ? AND id = ?
    `).run(status, urls.public_url, urls.https_url, tId, dep.id);
    addDeploymentEvent(tId, dep, "health_healthy", `Healthcheck erfolgreich (${detail}).`, "info", { public_url: urls.public_url, https_url: urls.https_url });
    addDeploymentEvent(tId, dep, "published", "Deployment veröffentlicht.", "info");
  } else {
    db.query(`
      UPDATE hosting_deployments
      SET health_status = ?, last_health_at = datetime('now')
      WHERE tenant_id = ? AND id = ?
    `).run(status, tId, dep.id);
    addDeploymentEvent(tId, dep, "health_unhealthy", `Healthcheck fehlgeschlagen (${detail}).`, "warn");
    scheduleRestartIfNeeded(tenantContext, dep, detail);
  }

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

  const version = Number(current.version || 0) + 1;
  const port = allocateInternalPort(tId, target.port);
  const healthUrl = healthUrlForPort(port, "/");
  db.query(`
    INSERT INTO hosting_deployments
      (tenant_id, service_name, version, command, cwd, port, public_url, https_url, status, health_url, health_status, rollback_of, custom_domain, tls_enabled, tls_status, cpu_limit, memory_limit_mb)
    VALUES (?, ?, ?, ?, ?, ?, '', '', 'starting', ?, 'unknown', ?, ?, ?, ?, ?, ?)
  `).run(
    tId,
    serviceName,
    version,
    target.command,
    target.cwd,
    port,
    healthUrl,
    target.id,
    target.custom_domain || "",
    Number(target.tls_enabled || 0),
    target.tls_status || "pending",
    Number(target.cpu_limit || 0),
    Number(target.memory_limit_mb || 0)
  );

  const newDep = latestDeployment(tenantContext, serviceName);
  const env = target?.id ? envForDeployment(tId, target.id) : {};
  const started = startServiceWithRestartPolicy(tenantContext, { ...newDep, command: target.command, cwd: target.cwd, service_name: serviceName }, env);
  if (started?.error && !String(started.error).includes("läuft bereits")) {
    addDeploymentEvent(tId, newDep, "rollback_start_failed", String(started.error), "error", { target_version: target.version });
    db.query("UPDATE hosting_deployments SET status = 'failed' WHERE tenant_id = ? AND id = ?").run(tId, newDep.id);
    return started;
  }

  addDeploymentEvent(tId, newDep, "rollback_started", `Rollback von v${current.version} auf v${target.version} initiiert.`, "info");
  return { ok: true, deployment: latestDeployment(tenantContext, serviceName), rolled_back_to: target.version };
}

export function listDeploymentEvents(tenantContext, serviceName = "", limit = 200) {
  const tId = tenantId(tenantContext);
  if (serviceName) {
    return db.query(`
      SELECT * FROM hosting_deployment_events
      WHERE tenant_id = ? AND service_name = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(tId, serviceName, Number(limit || 200));
  }
  return db.query(`
    SELECT * FROM hosting_deployment_events
    WHERE tenant_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(tId, Number(limit || 200));
}

export function resolveHostedServiceForRequest(tenantContext, hostHeader = "", pathname = "/") {
  const tId = tenantId(tenantContext);
  const host = String(hostHeader || "").toLowerCase().split(":")[0];
  if (!host) return null;

  const byCustom = db.query(`
    SELECT * FROM hosting_deployments
    WHERE tenant_id = ? AND lower(custom_domain) = ? AND health_status = 'healthy'
    ORDER BY version DESC LIMIT 1
  `).get(tId, host);
  if (byCustom) return { deployment: mapDeployment(byCustom), proxyPath: pathname || "/" };

  const baseHost = String(process.env.NIMBUS_PUBLIC_HOST || tenantContext?.host || "").toLowerCase();
  if (baseHost && host.endsWith(`.${baseHost}`)) {
    const service = host.slice(0, -(baseHost.length + 1)).split(".").pop();
    const dep = latestHealthyDeployment(tenantContext, service);
    if (dep) return { deployment: dep, proxyPath: pathname || "/" };
  }

  return null;
}

export function recoverHostingSupervisor(tenantContext) {
  const tId = tenantId(tenantContext);
  const running = db.query(`
    SELECT * FROM hosting_deployments
    WHERE tenant_id = ? AND status = 'running'
    ORDER BY id DESC
  `).all(tId);

  for (const dep of running) {
    const env = envForDeployment(tId, dep.id);
    const started = startServiceWithRestartPolicy(tenantContext, dep, env);
    if (started?.error && !String(started.error).includes("läuft bereits")) {
      addDeploymentEvent(tId, dep, "recover_failed", `Supervisor-Recovery fehlgeschlagen: ${started.error}`, "error");
      db.query("UPDATE hosting_deployments SET status = 'failed' WHERE tenant_id = ? AND id = ?").run(tId, dep.id);
    } else {
      addDeploymentEvent(tId, dep, "recover_ok", "Service nach Server-Restart wiederhergestellt.", "info");
    }
  }

  return { ok: true, recovered: running.length };
}

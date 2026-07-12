// Nimbus – User Services: langlebige Hintergrundprozesse mit Logs
import { db, WORKSPACE } from "./db.js";
import { join, resolve } from "path";

const running = new Map(); // `${tenantId}:${name}` -> { proc, logs: string[], tenantId, name }

function normalizeTenantId(tenantId) {
  return (typeof tenantId === "string" && tenantId.trim()) ? tenantId.trim() : "default";
}

function runtimeKey(tenantId, name) {
  return `${normalizeTenantId(tenantId)}:${String(name || "").trim()}`;
}

function resolveServiceCwd(cwd, workspaceRoot = WORKSPACE) {
  const root = workspaceRoot || WORKSPACE;
  if (!cwd || cwd === ".") return root;
  const candidate = cwd.startsWith("/") ? resolve(cwd) : resolve(join(root, cwd));
  if (candidate !== root && (candidate.startsWith(`${root}/`) === false)) {
    throw new Error("Service-Arbeitsverzeichnis muss im Tenant-Workspace liegen.");
  }
  return candidate;
}

function pushLog(entry, line) {
  entry.logs.push(line);
  if (entry.logs.length > 500) entry.logs.splice(0, entry.logs.length - 500);
}

async function pipeStream(stream, entry, prefix) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value).split("\n")) {
        if (line.trim()) pushLog(entry, `${prefix} ${line}`);
      }
    }
  } catch { /* Stream beendet */ }
}

export const services = {
  start(tenantId, name, command, cwd, workspaceRoot = WORKSPACE) {
    const tId = normalizeTenantId(tenantId);
    const key = runtimeKey(tId, name);
    if (running.has(key)) return { error: `Service '${name}' läuft bereits.` };

    const resolvedCwd = resolveServiceCwd(cwd, workspaceRoot);
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: resolvedCwd,
      stdout: "pipe",
      stderr: "pipe",
    });

    const entry = { proc, logs: [], command, tenantId: tId, name };
    running.set(key, entry);
    pipeStream(proc.stdout, entry, "[out]");
    pipeStream(proc.stderr, entry, "[err]");

    proc.exited.then((code) => {
      pushLog(entry, `[exit] Prozess beendet mit Code ${code}`);
      running.delete(key);
      db.query("UPDATE services SET status = 'stopped' WHERE tenant_id = ? AND name = ?").run(tId, name);
    });

    const upd = db.query("UPDATE services SET command = ?, cwd = ?, status = 'running' WHERE tenant_id = ? AND name = ?")
      .run(command, resolvedCwd, tId, name);
    if (!upd || upd.changes === 0) {
      db.query("INSERT INTO services (tenant_id, name, command, cwd, status) VALUES (?, ?, ?, ?, 'running')")
        .run(tId, name, command, resolvedCwd);
    }

    return { ok: true, tenant_id: tId, name, pid: proc.pid };
  },

  stop(tenantId, name) {
    const tId = normalizeTenantId(tenantId);
    const key = runtimeKey(tId, name);
    const entry = running.get(key);

    if (!entry) {
      db.query("UPDATE services SET status = 'stopped' WHERE tenant_id = ? AND name = ?").run(tId, name);
      return { error: `Service '${name}' läuft nicht.` };
    }

    entry.proc.kill();
    running.delete(key);
    db.query("UPDATE services SET status = 'stopped' WHERE tenant_id = ? AND name = ?").run(tId, name);
    return { ok: true, tenant_id: tId, stopped: name };
  },

  list(tenantId) {
    const tId = normalizeTenantId(tenantId);
    return db.query("SELECT * FROM services WHERE tenant_id = ? ORDER BY name").all(tId).map((s) => {
      const key = runtimeKey(tId, s.name);
      return {
        ...s,
        status: running.has(key) ? "running" : "stopped",
        pid: running.get(key)?.proc.pid ?? null,
      };
    });
  },

  logs(tenantId, name) {
    const tId = normalizeTenantId(tenantId);
    const key = runtimeKey(tId, name);
    const entry = running.get(key);
    if (!entry) return { error: `Service '${name}' läuft nicht (Logs nur zur Laufzeit verfügbar).` };
    return { tenant_id: tId, name, logs: entry.logs.slice(-100) };
  },

  remove(tenantId, name) {
    const tId = normalizeTenantId(tenantId);
    this.stop(tId, name);
    db.query("DELETE FROM services WHERE tenant_id = ? AND name = ?").run(tId, name);
    return { ok: true, tenant_id: tId };
  },
};

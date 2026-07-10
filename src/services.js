// Nimbus – User Services: langlebige Hintergrundprozesse mit Logs
import { db, WORKSPACE } from "./db.js";

const running = new Map(); // name -> { proc, logs: string[] }

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
  start(name, command, cwd) {
    if (running.has(name)) return { error: `Service '${name}' läuft bereits.` };
    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd: cwd && cwd.startsWith("/") ? cwd : WORKSPACE,
      stdout: "pipe",
      stderr: "pipe",
    });
    const entry = { proc, logs: [], command };
    running.set(name, entry);
    pipeStream(proc.stdout, entry, "[out]");
    pipeStream(proc.stderr, entry, "[err]");
    proc.exited.then((code) => {
      pushLog(entry, `[exit] Prozess beendet mit Code ${code}`);
      running.delete(name);
      db.query("UPDATE services SET status = 'stopped' WHERE name = ?").run(name);
    });
    db.query(
      `INSERT INTO services (name, command, cwd, status) VALUES (?, ?, ?, 'running')
       ON CONFLICT(name) DO UPDATE SET command = excluded.command, cwd = excluded.cwd, status = 'running'`
    ).run(name, command, cwd || "");
    return { ok: true, name, pid: proc.pid };
  },

  stop(name) {
    const entry = running.get(name);
    if (!entry) {
      db.query("UPDATE services SET status = 'stopped' WHERE name = ?").run(name);
      return { error: `Service '${name}' läuft nicht.` };
    }
    entry.proc.kill();
    running.delete(name);
    db.query("UPDATE services SET status = 'stopped' WHERE name = ?").run(name);
    return { ok: true, stopped: name };
  },

  list() {
    return db.query("SELECT * FROM services ORDER BY name").all().map((s) => ({
      ...s,
      status: running.has(s.name) ? "running" : "stopped",
      pid: running.get(s.name)?.proc.pid ?? null,
    }));
  },

  logs(name) {
    const entry = running.get(name);
    if (!entry) return { error: `Service '${name}' läuft nicht (Logs nur zur Laufzeit verfügbar).` };
    return { name, logs: entry.logs.slice(-100) };
  },

  remove(name) {
    this.stop(name);
    db.query("DELETE FROM services WHERE name = ?").run(name);
    return { ok: true };
  },
};

// Nimbus – Scheduler: prüft jede Minute Cron-Tasks und lässt sie vom Agenten ausführen
import { db, createTaskRun, finishTaskRun } from "./db.js";
import { runAgent, hasKey } from "./agent.js";
import { buildTenantContext } from "./tenancy/router.js";

// Minimaler Cron-Matcher: "min std tag monat wochentag" (mit * und */n und Listen a,b)
function fieldMatches(field, value) {
  if (field === "*") return true;
  for (const part of field.split(",")) {
    if (part.includes("/")) {
      const [, step] = part.split("/");
      if (value % Number(step) === 0) return true;
    } else if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      if (value >= a && value <= b) return true;
    } else if (Number(part) === value) return true;
  }
  return false;
}

function cronMatches(cron, date) {
  const [min, hr, dom, mon, dow] = cron.trim().split(/\s+/);
  return (
    fieldMatches(min, date.getMinutes()) &&
    fieldMatches(hr, date.getHours()) &&
    fieldMatches(dom, date.getDate()) &&
    fieldMatches(mon, date.getMonth() + 1) &&
    fieldMatches(dow, date.getDay())
  );
}

const activeTasks = new Set();

export async function runTask(task) {
  const key = `${task.tenant_id || "default"}:${task.id}`;
  if (activeTasks.has(key)) return { ok: false, error: "Task läuft bereits." };
  activeTasks.add(key);
  const runId = createTaskRun({ taskId: task.id, tenantId: task.tenant_id || "default" });
  const messages = [{ role: "user", content: task.prompt }];
  let output = "";
  let error = "";
  try {
    await runAgent({
      messages,
      system:
        "Du bist ein autonomer Nimbus-Agent, der einen geplanten Task ausführt. Arbeite den Auftrag vollständig ab und fasse das Ergebnis am Ende kurz zusammen.",
      onEvent: (e) => {
        if (e.type === "text") output += e.text + "\n";
      },
      tenantContext: buildTenantContext(task.tenant_id || "default"),
    });
  } catch (err) {
    error = String(err.message || err);
    output = "Fehler: " + error;
  }
  db.query("UPDATE tasks SET last_run = datetime('now'), last_result = ? WHERE id = ? AND tenant_id = ?")
    .run(output.slice(0, 4000), task.id, task.tenant_id || "default");
  finishTaskRun({ runId, status: error ? "error" : "done", result: output, error });
  activeTasks.delete(key);
  console.log(`[scheduler] Task '${task.name}' ausgeführt.`);
  return { ok: !error, run_id: runId, result: output, error: error || null };
}

export async function runTaskForTenant(taskId, tenantId) {
  const task = db.query("SELECT * FROM tasks WHERE id = ? AND tenant_id = ?").get(taskId, tenantId || "default");
  if (!task) return { ok: false, error: "Task nicht gefunden." };
  return runTask(task);
}

let lastMinute = -1;
export function startScheduler() {
  setInterval(() => {
    const now = new Date();
    if (now.getMinutes() === lastMinute) return;
    lastMinute = now.getMinutes();
    const tasks = db.query("SELECT * FROM tasks WHERE enabled = 1").all();
    for (const task of tasks) {
      const tenant = buildTenantContext(task.tenant_id || "default");
      if (hasKey(tenant) && cronMatches(task.cron, now)) {
        runTask(task).catch((err) => console.error("[scheduler] task error", err));
      }
    }
  }, 15000);
  console.log("[scheduler] gestartet (Cron-Auflösung: 1 Minute).");
}

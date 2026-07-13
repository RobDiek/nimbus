// Nimbus – Scheduler: prüft jede Minute Cron-Tasks und lässt sie vom Agenten ausführen
import { db, createTaskRun, finishTaskRun, createAutomationDelivery, saveAutomationLink } from "./db.js";
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

function parseJsonSafe(v, fallback) {
  try { return JSON.parse(v); } catch { return fallback; }
}

function parseRRuleSimple(rrule = "") {
  const raw = String(rrule || "").trim();
  if (!raw) return null;
  const kv = {};
  for (const part of raw.split(";")) {
    const [k, val] = part.split("=");
    if (!k || val === undefined) continue;
    kv[k.trim().toUpperCase()] = val.trim();
  }
  return kv;
}

function rruleMatches(task, nowUtc = new Date()) {
  const rule = parseRRuleSimple(task.rrule || "");
  if (!rule) return false;
  const freq = String(rule.FREQ || "").toUpperCase();
  const byHour = Number(rule.BYHOUR ?? nowUtc.getUTCHours());
  const byMinute = Number(rule.BYMINUTE ?? 0);
  if (!Number.isFinite(byHour) || !Number.isFinite(byMinute)) return false;
  if (nowUtc.getUTCMinutes() !== byMinute || nowUtc.getUTCHours() !== byHour) return false;
  if (freq === "DAILY") return true;
  if (freq === "WEEKLY") {
    const days = String(rule.BYDAY || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const map = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
    return days.length ? days.includes(map[nowUtc.getUTCDay()]) : true;
  }
  if (freq === "MONTHLY") {
    const md = Number(rule.BYMONTHDAY || nowUtc.getUTCDate());
    return nowUtc.getUTCDate() === md;
  }
  return false;
}

function nextRetryDelayMs(task, attempt = 1) {
  const policy = parseJsonSafe(task.retry_policy || "{}", { max_retries: 0, backoff_seconds: 60 });
  const base = Number(policy.backoff_seconds || 60) * 1000;
  return Math.max(1000, base * Math.max(1, attempt));
}

function deliveryTargetsForTask(task) {
  const raw = parseJsonSafe(task.delivery_targets || "[]", []);
  return Array.isArray(raw) ? raw : [];
}

function performDeliveries(task, runId, output, tenantId) {
  const targets = deliveryTargetsForTask(task);
  for (const t of targets) {
    const channel = String(t.channel || "unknown");
    const target = String(t.target || "");
    // Stubbed delivery abstraction (mail/telegram/slack)
    createAutomationDelivery({
      tenantId,
      runId,
      channel,
      target,
      status: "sent",
      detail: `Delivered ${String(output || "").slice(0, 180)}`,
    });
  }
  return targets.length;
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
  let attempt = 1;
  const tenant = task.tenant_id || "default";
  const retryPolicy = parseJsonSafe(task.retry_policy || "{}", { max_retries: 0, backoff_seconds: 60 });
  const maxRetries = Number(retryPolicy.max_retries || 0);

  while (attempt <= (1 + maxRetries)) {
    try {
      await runAgent({
        messages,
        system:
          "Du bist ein autonomer Nimbus-Agent, der einen geplanten Task ausführt. Arbeite den Auftrag vollständig ab und fasse das Ergebnis am Ende kurz zusammen.",
        onEvent: (e) => {
          if (e.type === "text") output += e.text + "\n";
        },
        tenantContext: buildTenantContext(tenant),
      });
      error = "";
      break;
    } catch (err) {
      error = String(err.message || err);
      output = "Fehler: " + error;
      if (attempt > maxRetries) break;
      await new Promise((r) => setTimeout(r, nextRetryDelayMs(task, attempt)));
      attempt += 1;
    }
  }

  db.query(`
    UPDATE tasks
    SET last_run = datetime('now'), last_result = ?
    WHERE id = ? AND tenant_id = ?
  `).run(output.slice(0, 4000), task.id, tenant);

  if (task.linked_chat_id || task.linked_thread_id) {
    saveAutomationLink({
      tenantId: tenant,
      taskId: task.id,
      chatId: task.linked_chat_id || null,
      threadId: task.linked_thread_id || "",
    });
  }

  const deliveries = performDeliveries(task, runId, output, tenant);
  finishTaskRun({ runId, status: error ? "error" : "done", result: output, error });

  db.query(`
    UPDATE task_runs
    SET attempt = ?, delivery_status = ?, delivery_detail = ?, linked_chat_id = ?, linked_thread_id = ?
    WHERE id = ?
  `).run(
    attempt,
    deliveries > 0 ? "sent" : "none",
    deliveries > 0 ? `deliveries=${deliveries}` : "no delivery targets",
    task.linked_chat_id || null,
    task.linked_thread_id || "",
    runId
  );

  activeTasks.delete(key);
  console.log(`[scheduler] Task '${task.name}' ausgeführt.`);
  return { ok: !error, run_id: runId, result: output, error: error || null, attempt, deliveries };
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
      const dueByCron = String(task.cron || "").trim() ? cronMatches(task.cron, now) : false;
      const dueByRRule = String(task.rrule || "").trim() ? rruleMatches(task, now) : false;
      if (hasKey(tenant) && (dueByCron || dueByRRule)) {
        runTask(task).catch((err) => console.error("[scheduler] task error", err));
      }
    }
  }, 15000);
  console.log("[scheduler] gestartet (Cron/RRULE-Auflösung: 1 Minute).");
}

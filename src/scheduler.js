// Nimbus – Scheduler: prüft jede Minute Cron-Tasks und lässt sie vom Agenten ausführen
import { db, getSetting } from "./db.js";
import { runAgent, hasKey } from "./agent.js";

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

async function runTask(task) {
  const messages = [{ role: "user", content: task.prompt }];
  let output = "";
  try {
    await runAgent({
      messages,
      system:
        "Du bist ein autonomer Nimbus-Agent, der einen geplanten Task ausführt. Arbeite den Auftrag vollständig ab und fasse das Ergebnis am Ende kurz zusammen.",
      onEvent: (e) => {
        if (e.type === "text") output += e.text + "\n";
      },
    });
  } catch (err) {
    output = "Fehler: " + String(err.message || err);
  }
  db.query("UPDATE tasks SET last_run = datetime('now'), last_result = ? WHERE id = ?")
    .run(output.slice(0, 4000), task.id);
  console.log(`[scheduler] Task '${task.name}' ausgeführt.`);
}

let lastMinute = -1;
export function startScheduler() {
  setInterval(() => {
    const now = new Date();
    if (now.getMinutes() === lastMinute) return;
    lastMinute = now.getMinutes();
    if (!hasKey()) return;
    const tasks = db.query("SELECT * FROM tasks WHERE enabled = 1").all();
    for (const task of tasks) {
      if (cronMatches(task.cron, now)) runTask(task);
    }
  }, 15000);
  console.log("[scheduler] gestartet (Cron-Auflösung: 1 Minute).");
}

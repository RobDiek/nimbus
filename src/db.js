// Nimbus – SQLite-Persistenz (bun:sqlite, keine externen Dependencies)
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { join } from "path";

export const ROOT = join(import.meta.dir, "..");
export const WORKSPACE = join(ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(join(ROOT, "data"), { recursive: true });

export const db = new Database(join(ROOT, "data", "nimbus.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT 'Neue Session',
  persona_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL, -- JSON: Anthropic content blocks
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run TEXT,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  autostart INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'stopped'
);
`);

// --- Settings ---
export function getSetting(key, fallback = "") {
  const row = db.query("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : fallback;
}
export function setSetting(key, value) {
  db.query(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, String(value));
}

// --- Default-Personas beim ersten Start ---
const personaCount = db.query("SELECT COUNT(*) AS c FROM personas").get().c;
if (personaCount === 0) {
  const ins = db.query(
    "INSERT INTO personas (name, emoji, system_prompt, model) VALUES (?, ?, ?, ?)"
  );
  ins.run(
    "Nimbus",
    "☁️",
    "Du bist Nimbus, ein persönlicher KI-Computer mit vollem Zugriff auf Terminal, Dateisystem und Web. Du handelst proaktiv: Du führst Aufgaben direkt aus, statt nur zu erklären. Antworte auf Deutsch, direkt und ohne Fülltext.",
    ""
  );
  ins.run(
    "DevOps",
    "🛠️",
    "Du bist ein DevOps-Spezialist. Fokus: Shell, Services, Deployments, Monitoring. Du prüfst Ergebnisse nach jeder Aktion und meldest Fehler ehrlich.",
    ""
  );
  ins.run(
    "Researcher",
    "🔎",
    "Du bist ein Recherche-Agent. Du nutzt Websuche und Seitenabruf intensiv, zitierst Quellen mit URL und fasst strukturiert zusammen.",
    ""
  );
}

// Nimbus – SQLite-Persistenz (bun:sqlite, keine externen Dependencies)
import { Database } from "bun:sqlite";
import { mkdirSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";

export const ROOT = join(import.meta.dir, "..");
export const WORKSPACE = join(ROOT, "workspace");
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(join(ROOT, "data"), { recursive: true });

export const db = new Database(join(ROOT, "data", "nimbus.db"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL DEFAULT 'Neue Session',
  persona_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  session_id INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL, -- JSON: Anthropic content blocks
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  title TEXT NOT NULL DEFAULT 'Neuer Chat',
  persona_id INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'running',
  model TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS chat_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS chat_shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  token_hash TEXT NOT NULL,
  revoked_at TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chats_tenant_updated ON chats(tenant_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chats_tenant_archived_updated ON chats(tenant_id, archived, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_runs_chat_started ON chat_runs(chat_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_runs_tenant_started ON chat_runs(tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_events_run_seq ON chat_events(run_id, sequence);
CREATE INDEX IF NOT EXISTS idx_chat_shares_chat ON chat_shares(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_shares_token_hash ON chat_shares(token_hash);
CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  content TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run TEXT,
  last_result TEXT
);
CREATE TABLE IF NOT EXISTS task_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  result TEXT NOT NULL DEFAULT '',
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_task_runs_tenant_task ON task_runs(tenant_id, task_id, started_at DESC);
CREATE TABLE IF NOT EXISTS skills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  source_path TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '[]',
  rules TEXT NOT NULL DEFAULT '[]',
  triggers TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS idx_skills_tenant_name ON skills(tenant_id, name);
CREATE TABLE IF NOT EXISTS oauth_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'disconnected',
  scopes TEXT NOT NULL DEFAULT '[]',
  access_token TEXT NOT NULL DEFAULT '',
  refresh_token TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (tenant_id, provider)
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  provider TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  redirect_uri TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_oauth_connections_tenant_provider ON oauth_connections(tenant_id, provider);
CREATE TABLE IF NOT EXISTS browser_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  current_url TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  html TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  forms TEXT NOT NULL DEFAULT '[]',
  links TEXT NOT NULL DEFAULT '[]',
  screenshot_text TEXT NOT NULL DEFAULT '',
  cookies TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_tenant_updated ON browser_sessions(tenant_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS hosting_deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  service_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  port INTEGER,
  public_url TEXT NOT NULL DEFAULT '',
  https_url TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'created',
  health_url TEXT NOT NULL DEFAULT '',
  health_status TEXT NOT NULL DEFAULT 'unknown',
  last_health_at TEXT,
  rollback_of INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hosting_tenant_service_version ON hosting_deployments(tenant_id, service_name, version DESC);
CREATE TABLE IF NOT EXISTS hosting_deployment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  service_name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  level TEXT NOT NULL DEFAULT 'info',
  event_type TEXT NOT NULL DEFAULT 'event',
  message TEXT NOT NULL DEFAULT '',
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hosting_events_tenant_service_created
  ON hosting_deployment_events(tenant_id, service_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hosting_events_deployment_created
  ON hosting_deployment_events(deployment_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hosting_deployment_env (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  deployment_id INTEGER NOT NULL,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  key TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_hosting_env_deployment ON hosting_deployment_env(deployment_id);
CREATE INDEX IF NOT EXISTS idx_hosting_env_tenant_service_key ON hosting_deployment_env(tenant_id, key);
CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🤖',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  command TEXT NOT NULL,
  cwd TEXT NOT NULL DEFAULT '',
  autostart INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'stopped',
  UNIQUE (tenant_id, name)
);
CREATE TABLE IF NOT EXISTS vm_instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL DEFAULT 'proxmox',
  node TEXT NOT NULL DEFAULT '',
  vmid INTEGER,
  state TEXT NOT NULL DEFAULT 'pending',
  ip_address TEXT NOT NULL DEFAULT '',
  template_vmid INTEGER,
  cpu_cores INTEGER NOT NULL DEFAULT 2,
  memory_mb INTEGER NOT NULL DEFAULT 4096,
  disk_gb INTEGER NOT NULL DEFAULT 32,
  username TEXT NOT NULL DEFAULT 'nimbus',
  metadata TEXT NOT NULL DEFAULT '{}',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vm_instances_state ON vm_instances(state);
CREATE INDEX IF NOT EXISTS idx_vm_instances_vmid ON vm_instances(vmid);
CREATE TABLE IF NOT EXISTS vm_jobs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  retries INTEGER NOT NULL DEFAULT 0,
  payload TEXT NOT NULL DEFAULT '{}',
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  canceled INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_vm_jobs_tenant_created ON vm_jobs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_vm_jobs_status ON vm_jobs(status);
CREATE TABLE IF NOT EXISTS vm_terminal_sessions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT 'default',
  mode TEXT NOT NULL DEFAULT 'local',
  vmid INTEGER,
  ip_address TEXT NOT NULL DEFAULT '',
  username TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vm_terminal_sessions_tenant_status ON vm_terminal_sessions(tenant_id, status);
`);

// --- SQLite schema migration (for existing nimbus.db without tenant_id) ---
function columnExists(table, column) {
  const row = db.query(`PRAGMA table_info(${table})`).all().find((r) => r.name === column);
  return !!row;
}

function ensureTenantColumn(table) {
  if (columnExists(table, "tenant_id")) return;
  // Best-effort: add column; constraints/PK updates are handled by our tenant helpers (no reliance on composite PK).
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'default';`);
  } catch {
    // ignore
  }
}

["settings", "sessions", "messages", "memories", "tasks", "services", "vm_instances", "vm_jobs", "vm_terminal_sessions", "personas", "chats", "chat_runs", "chat_shares", "skills", "oauth_connections", "oauth_states", "browser_sessions", "hosting_deployments", "hosting_deployment_events", "hosting_deployment_env"].forEach(ensureTenantColumn);

// Legacy databases used `key` as the sole primary key on settings. That
// prevents two tenants from storing the same setting name. Rebuild the small
// table once so tenant-scoped settings can work on existing installations.
function ensureSettingsCompositePrimaryKey() {
  const info = db.query("PRAGMA table_info(settings)").all();
  const tenant = info.find((c) => c.name === "tenant_id");
  const key = info.find((c) => c.name === "key");
  if (!tenant || !key || tenant.pk === 1 || key.pk !== 1) return;

  try {
    db.exec("BEGIN IMMEDIATE");
    db.exec(`
      CREATE TABLE settings_migrated (
        tenant_id TEXT NOT NULL DEFAULT 'default',
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (tenant_id, key)
      );
      INSERT OR REPLACE INTO settings_migrated (tenant_id, key, value)
      SELECT COALESCE(tenant_id, 'default'), key, value FROM settings;
      DROP TABLE settings;
      ALTER TABLE settings_migrated RENAME TO settings;
    `);
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch {}
    console.warn(`[db] settings migration skipped: ${String(err?.message || err)}`);
  }
}

ensureSettingsCompositePrimaryKey();

// Best-effort backfill: older rows get tenant_id='default'
try {
  db.exec(`
    UPDATE sessions SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE messages SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE memories SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE tasks SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE services SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE settings SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE personas SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE chats SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE chat_runs SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE chat_shares SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE skills SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE oauth_connections SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE oauth_states SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE browser_sessions SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE hosting_deployments SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE hosting_deployment_events SET tenant_id='default' WHERE tenant_id IS NULL;
    UPDATE hosting_deployment_env SET tenant_id='default' WHERE tenant_id IS NULL;
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_tenant ON sessions(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_messages_tenant_session ON messages(tenant_id, session_id);
    CREATE INDEX IF NOT EXISTS idx_memories_tenant ON memories(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_tenant ON tasks(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_services_tenant_name ON services(tenant_id, name);
    CREATE INDEX IF NOT EXISTS idx_personas_tenant ON personas(tenant_id);
    CREATE INDEX IF NOT EXISTS idx_task_runs_tenant_task ON task_runs(tenant_id, task_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_skills_tenant_name ON skills(tenant_id, name);
    CREATE INDEX IF NOT EXISTS idx_oauth_connections_tenant_provider ON oauth_connections(tenant_id, provider);
    CREATE INDEX IF NOT EXISTS idx_browser_sessions_tenant_updated ON browser_sessions(tenant_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hosting_tenant_service_version ON hosting_deployments(tenant_id, service_name, version DESC);
    CREATE INDEX IF NOT EXISTS idx_hosting_events_tenant_service_created
      ON hosting_deployment_events(tenant_id, service_name, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hosting_events_deployment_created
      ON hosting_deployment_events(deployment_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hosting_env_deployment ON hosting_deployment_env(deployment_id);
    CREATE INDEX IF NOT EXISTS idx_hosting_env_tenant_service_key ON hosting_deployment_env(tenant_id, key);
  `);
} catch {
  // ignore
}

function normalizeTenantId(tenantId) {
  return (typeof tenantId === "string" && tenantId.trim()) ? tenantId.trim() : "default";
}

/** --- Settings (tenant-scoped) ---
 * Important: existing DB might not have composite PK (tenant_id,key).
 * So we implement "upsert" via UPDATE then INSERT if needed.
 */
export function getSettingTenant(tenantId, key, fallback = "") {
  tenantId = normalizeTenantId(tenantId);
  const row = db.query("SELECT value FROM settings WHERE tenant_id = ? AND key = ?").get(tenantId, key);
  return row ? row.value : fallback;
}
export function setSettingTenant(tenantId, key, value) {
  tenantId = normalizeTenantId(tenantId);
  const v = String(value);

  const upd = db.query("UPDATE settings SET value = ? WHERE tenant_id = ? AND key = ?").run(v, tenantId, key);
  // bun sqlite doesn't always expose changes reliably; best-effort check:
  if (!upd || upd.changes === undefined || upd.changes > 0) return;

  db.query("INSERT INTO settings (tenant_id, key, value) VALUES (?, ?, ?)").run(tenantId, key, v);
}

// Backward compat (global settings reads/writes as default tenant)
export function getSetting(key, fallback = "") {
  return getSettingTenant("default", key, fallback);
}
export function setSetting(key, value) {
  return setSettingTenant("default", key, value);
}

function ensureDefaultTenantColumns() {
  // Best-effort backfill. If the DB file is older than this schema change,
  // columns might not exist yet -> wrap in try/catch.
  try {
    db.exec(`
    UPDATE sessions SET tenant_id = 'default' WHERE tenant_id IS NULL;
    UPDATE messages SET tenant_id = 'default' WHERE tenant_id IS NULL;
    UPDATE memories SET tenant_id = 'default' WHERE tenant_id IS NULL;
    UPDATE tasks SET tenant_id = 'default' WHERE tenant_id IS NULL;
    UPDATE services SET tenant_id = 'default' WHERE tenant_id IS NULL;
    UPDATE settings SET tenant_id = 'default' WHERE tenant_id IS NULL;
    UPDATE personas SET tenant_id = 'default' WHERE tenant_id IS NULL;
    `);
  } catch {
    // ignore
  }
}

ensureDefaultTenantColumns();

function ensureChatSchemaMigrations() {
  // Legacy -> chats
  db.exec(`
    INSERT INTO chats (id, tenant_id, title, persona_id, archived, created_at, updated_at)
    SELECT s.id, COALESCE(s.tenant_id, 'default'), s.title, s.persona_id, 0, s.created_at, s.created_at
    FROM sessions s
    LEFT JOIN chats c ON c.id = s.id
    WHERE c.id IS NULL
  `);

  // exactly one legacy run per migrated chat
  db.exec(`
    INSERT INTO chat_runs (chat_id, tenant_id, status, model, started_at, finished_at, error)
    SELECT c.id, c.tenant_id, 'done', '', c.created_at, c.updated_at, ''
    FROM chats c
    LEFT JOIN chat_runs r ON r.chat_id = c.id
    WHERE r.id IS NULL
  `);

  // migrate message rows as chat_events
  const rows = db.query(`
    SELECT
      m.id as message_id,
      m.tenant_id as tenant_id,
      m.session_id as chat_id,
      m.role as role,
      m.content as content,
      m.created_at as created_at,
      r.id as run_id
    FROM messages m
    JOIN chat_runs r ON r.chat_id = m.session_id AND r.tenant_id = m.tenant_id
    ORDER BY m.session_id, m.id
  `).all();

  const insEvent = db.query(`
    INSERT INTO chat_events (run_id, sequence, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const existsEvent = db.query(`
    SELECT id FROM chat_events
    WHERE run_id = ? AND type = 'legacy_message' AND json_extract(payload_json, '$.message_id') = ?
    LIMIT 1
  `);

  const seqByRun = new Map();
  const seqQuery = db.query("SELECT COALESCE(MAX(sequence), 0) as seq FROM chat_events WHERE run_id = ?");

  for (const r of rows) {
    if (existsEvent.get(r.run_id, r.message_id)) continue;
    let seq = seqByRun.get(r.run_id);
    if (seq === undefined) {
      seq = Number(seqQuery.get(r.run_id)?.seq || 0);
    }
    seq += 1;
    seqByRun.set(r.run_id, seq);

    insEvent.run(
      r.run_id,
      seq,
      "legacy_message",
      JSON.stringify({
        message_id: r.message_id,
        role: r.role,
        content: (() => { try { return JSON.parse(r.content); } catch { return r.content; } })(),
      }),
      r.created_at || new Date().toISOString()
    );
  }

  // search table fallback
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_search (
      chat_id INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'default',
      text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (chat_id, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_chat_search_tenant_updated ON chat_search(tenant_id, updated_at DESC);
  `);

  // best-effort FTS5
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chats_fts USING fts5(
        tenant_id UNINDEXED,
        chat_id UNINDEXED,
        title,
        text
      );
    `);
  } catch {
    // fallback remains chat_search + LIKE
  }
}

ensureChatSchemaMigrations();

export function isChatFtsAvailable() {
  try {
    db.query("SELECT 1 FROM chats_fts LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

export function rebuildChatSearchIndexForTenant(tenantId) {
  const tId = normalizeTenantId(tenantId);
  const chats = db.query("SELECT id, title, updated_at FROM chats WHERE tenant_id = ?").all(tId);
  const updFallback = db.query(`
    INSERT INTO chat_search (chat_id, tenant_id, text, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id, tenant_id) DO UPDATE SET text=excluded.text, updated_at=datetime('now')
  `);

  const delFts = db.query("DELETE FROM chats_fts WHERE tenant_id = ? AND chat_id = ?");
  const insFts = db.query("INSERT INTO chats_fts (tenant_id, chat_id, title, text) VALUES (?, ?, ?, ?)");
  const fts = isChatFtsAvailable();

  for (const c of chats) {
    const ev = db.query(`
      SELECT payload_json FROM chat_events e
      JOIN chat_runs r ON r.id = e.run_id
      WHERE r.chat_id = ? AND r.tenant_id = ?
      ORDER BY e.created_at ASC, e.sequence ASC
    `).all(c.id, tId);

    const textParts = [];
    for (const row of ev) {
      let p = {};
      try { p = JSON.parse(row.payload_json || "{}"); } catch {}
      if (typeof p?.text === "string") textParts.push(p.text);
      if (typeof p?.message === "string") textParts.push(p.message);
      if (p?.content) textParts.push(typeof p.content === "string" ? p.content : JSON.stringify(p.content));
      if (p?.result) textParts.push(typeof p.result === "string" ? p.result : JSON.stringify(p.result));
    }

    const text = [c.title || "", ...textParts].join("\n").slice(0, 200000);
    updFallback.run(c.id, tId, text);

    if (fts) {
      try {
        delFts.run(tId, String(c.id));
        insFts.run(tId, String(c.id), c.title || "", text);
      } catch {
        // ignore fts write failures
      }
    }
  }
}

export function createChat({ tenantId, title = "Neuer Chat", personaId = null }) {
  const tId = normalizeTenantId(tenantId);
  const r = db.query(`
    INSERT INTO chats (tenant_id, title, persona_id, archived, created_at, updated_at)
    VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
  `).run(tId, title, personaId ?? null);
  return getChatById(tId, Number(r.lastInsertRowid));
}

export function getChatById(tenantId, chatId) {
  const tId = normalizeTenantId(tenantId);
  return db.query("SELECT * FROM chats WHERE id = ? AND tenant_id = ?").get(chatId, tId) || null;
}

export function listChats({ tenantId, q = "", archived = null, from = "", to = "" }) {
  const tId = normalizeTenantId(tenantId);
  let rows = db.query("SELECT * FROM chats WHERE tenant_id = ? ORDER BY updated_at DESC, id DESC").all(tId);

  if (archived === true) rows = rows.filter((r) => Number(r.archived || 0) === 1);
  if (archived === false) rows = rows.filter((r) => Number(r.archived || 0) === 0);
  if (from) rows = rows.filter((r) => String(r.updated_at || "") >= from);
  if (to) rows = rows.filter((r) => String(r.updated_at || "") <= to);

  const qq = String(q || "").trim().toLowerCase();
  if (!qq) return rows;

  if (isChatFtsAvailable()) {
    try {
      const ids = db.query(`
        SELECT DISTINCT chat_id FROM chats_fts
        WHERE tenant_id = ? AND chats_fts MATCH ?
      `).all(tId, qq).map((r) => Number(r.chat_id));
      const set = new Set(ids);
      return rows.filter((r) => set.has(Number(r.id)));
    } catch {}
  }

  rebuildChatSearchIndexForTenant(tId);
  const matched = db.query(`
    SELECT chat_id FROM chat_search
    WHERE tenant_id = ? AND lower(text) LIKE '%' || lower(?) || '%'
  `).all(tId, qq).map((r) => Number(r.chat_id));
  const set = new Set(matched);
  return rows.filter((r) => set.has(Number(r.id)));
}

export function updateChat(tenantId, chatId, patch = {}) {
  const tId = normalizeTenantId(tenantId);
  db.query(`
    UPDATE chats
    SET
      title = COALESCE(?, title),
      archived = COALESCE(?, archived),
      persona_id = COALESCE(?, persona_id),
      updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(
    patch.title ?? null,
    patch.archived === undefined ? null : (patch.archived ? 1 : 0),
    patch.persona_id ?? null,
    chatId,
    tId
  );
  rebuildChatSearchIndexForTenant(tId);
  return getChatById(tId, chatId);
}

export function deleteChat(tenantId, chatId) {
  const tId = normalizeTenantId(tenantId);
  const runIds = db.query("SELECT id FROM chat_runs WHERE chat_id = ? AND tenant_id = ?").all(chatId, tId).map((r) => r.id);
  for (const rid of runIds) db.query("DELETE FROM chat_events WHERE run_id = ?").run(rid);
  db.query("DELETE FROM chat_runs WHERE chat_id = ? AND tenant_id = ?").run(chatId, tId);
  db.query("DELETE FROM chat_shares WHERE chat_id = ? AND tenant_id = ?").run(chatId, tId);
  db.query("DELETE FROM chat_search WHERE chat_id = ? AND tenant_id = ?").run(chatId, tId);
  db.query("DELETE FROM chats WHERE id = ? AND tenant_id = ?").run(chatId, tId);
  try { db.query("DELETE FROM chats_fts WHERE tenant_id = ? AND chat_id = ?").run(tId, String(chatId)); } catch {}
  return true;
}

export function createChatRun({ chatId, tenantId, model = "", status = "running" }) {
  const tId = normalizeTenantId(tenantId);
  const r = db.query(`
    INSERT INTO chat_runs (chat_id, tenant_id, status, model, started_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(chatId, tId, status, model || "");
  return Number(r.lastInsertRowid);
}

export function finishChatRun({ runId, status = "done", error = "" }) {
  db.query(`
    UPDATE chat_runs
    SET status = ?, finished_at = datetime('now'), error = COALESCE(?, error)
    WHERE id = ?
  `).run(status, error || "", runId);
}

export function appendChatEvent({ runId, type, payload = {} }) {
  const seqRow = db.query("SELECT COALESCE(MAX(sequence), 0) as seq FROM chat_events WHERE run_id = ?").get(runId);
  const seq = Number(seqRow?.seq || 0) + 1;
  db.query(`
    INSERT INTO chat_events (run_id, sequence, type, payload_json, created_at)
    VALUES (?, ?, ?, ?, datetime('now'))
  `).run(runId, seq, type, JSON.stringify(payload || {}));
  return seq;
}

export function getChatDetail(tenantId, chatId) {
  const tId = normalizeTenantId(tenantId);
  const chat = getChatById(tId, chatId);
  if (!chat) return null;

  const runs = db.query(`
    SELECT * FROM chat_runs
    WHERE chat_id = ? AND tenant_id = ?
    ORDER BY started_at DESC, id DESC
  `).all(chatId, tId);

  const runIds = runs.map((r) => r.id);
  let events = [];
  if (runIds.length) {
    const placeholders = runIds.map(() => "?").join(",");
    events = db.query(`
      SELECT e.*, r.chat_id, r.tenant_id
      FROM chat_events e
      JOIN chat_runs r ON r.id = e.run_id
      WHERE e.run_id IN (${placeholders})
      ORDER BY e.run_id ASC, e.sequence ASC
    `).all(...runIds);
  }

  return { chat, runs, events: events.map((e) => ({ ...e, payload: (() => { try { return JSON.parse(e.payload_json || "{}"); } catch { return {}; } })() })) };
}

function hashToken(raw) {
  return createHash("sha256").update(String(raw)).digest("hex");
}

export function createChatShare({ tenantId, chatId, token, expiresAt = null }) {
  const tId = normalizeTenantId(tenantId);
  const tokenHash = hashToken(token);
  db.query(`
    INSERT INTO chat_shares (chat_id, tenant_id, token_hash, revoked_at, expires_at, created_at)
    VALUES (?, ?, ?, NULL, ?, datetime('now'))
  `).run(chatId, tId, tokenHash, expiresAt || null);
  return { tokenHash };
}

export function revokeChatShare({ tenantId, chatId }) {
  const tId = normalizeTenantId(tenantId);
  db.query(`
    UPDATE chat_shares
    SET revoked_at = datetime('now')
    WHERE tenant_id = ? AND chat_id = ? AND revoked_at IS NULL
  `).run(tId, chatId);
}

export function resolveSharedChatByToken(token) {
  const tokenHash = hashToken(token);
  const row = db.query(`
    SELECT * FROM chat_shares
    WHERE token_hash = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(tokenHash);
  if (!row) return { status: "not_found", detail: null };
  if (row.revoked_at) return { status: "revoked", detail: row };
  if (row.expires_at && String(row.expires_at) < new Date().toISOString()) return { status: "expired", detail: row };
  const detail = getChatDetail(row.tenant_id, row.chat_id);
  if (!detail) return { status: "not_found", detail: null };
  return { status: "ok", detail };
}

export function getLegacyMessagesForChat(tenantId, chatId) {
  const tId = normalizeTenantId(tenantId);
  return db.query("SELECT role, content FROM messages WHERE session_id = ? AND tenant_id = ? ORDER BY id").all(chatId, tId);
}

export function touchChat(tenantId, chatId) {
  const tId = normalizeTenantId(tenantId);
  db.query("UPDATE chats SET updated_at = datetime('now') WHERE id = ? AND tenant_id = ?").run(chatId, tId);
  rebuildChatSearchIndexForTenant(tId);
}

export function createTaskRun({ taskId, tenantId }) {
  const tId = normalizeTenantId(tenantId);
  const r = db.query(`
    INSERT INTO task_runs (task_id, tenant_id, status, started_at)
    VALUES (?, ?, 'running', datetime('now'))
  `).run(taskId, tId);
  return Number(r.lastInsertRowid);
}

export function finishTaskRun({ runId, status = 'done', result = '', error = '' }) {
  db.query(`
    UPDATE task_runs
    SET status = ?, finished_at = datetime('now'), result = ?, error = ?
    WHERE id = ?
  `).run(status, String(result || '').slice(0, 20000), String(error || '').slice(0, 4000), runId);
}

export function listTaskRuns(tenantId, taskId, limit = 50) {
  const tId = normalizeTenantId(tenantId);
  return db.query(`
    SELECT * FROM task_runs
    WHERE tenant_id = ? AND task_id = ?
    ORDER BY started_at DESC, id DESC
    LIMIT ?
  `).all(tId, taskId, limit);
}

export function getVmInstance(tenantId) {
  tenantId = normalizeTenantId(tenantId);
  return db.query("SELECT * FROM vm_instances WHERE tenant_id = ?").get(tenantId) || null;
}

export function listVmInstances() {
  return db.query("SELECT * FROM vm_instances ORDER BY updated_at DESC, id DESC").all();
}

export function upsertVmInstance(tenantId, patch = {}) {
  tenantId = normalizeTenantId(tenantId);

  const existing = getVmInstance(tenantId);
  if (!existing) {
    db.query(`
      INSERT INTO vm_instances (
        tenant_id, provider, node, vmid, state, ip_address, template_vmid,
        cpu_cores, memory_mb, disk_gb, username, metadata, last_error, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(
      tenantId,
      patch.provider ?? "proxmox",
      patch.node ?? "",
      patch.vmid ?? null,
      patch.state ?? "pending",
      patch.ip_address ?? "",
      patch.template_vmid ?? null,
      patch.cpu_cores ?? 2,
      patch.memory_mb ?? 4096,
      patch.disk_gb ?? 32,
      patch.username ?? "nimbus",
      typeof patch.metadata === "string" ? patch.metadata : JSON.stringify(patch.metadata || {}),
      patch.last_error ?? ""
    );
    return getVmInstance(tenantId);
  }

  db.query(`
    UPDATE vm_instances
    SET
      provider = COALESCE(?, provider),
      node = COALESCE(?, node),
      vmid = COALESCE(?, vmid),
      state = COALESCE(?, state),
      ip_address = COALESCE(?, ip_address),
      template_vmid = COALESCE(?, template_vmid),
      cpu_cores = COALESCE(?, cpu_cores),
      memory_mb = COALESCE(?, memory_mb),
      disk_gb = COALESCE(?, disk_gb),
      username = COALESCE(?, username),
      metadata = COALESCE(?, metadata),
      last_error = COALESCE(?, last_error),
      updated_at = datetime('now')
    WHERE tenant_id = ?
  `).run(
    patch.provider ?? null,
    patch.node ?? null,
    patch.vmid ?? null,
    patch.state ?? null,
    patch.ip_address ?? null,
    patch.template_vmid ?? null,
    patch.cpu_cores ?? null,
    patch.memory_mb ?? null,
    patch.disk_gb ?? null,
    patch.username ?? null,
    patch.metadata === undefined ? null : (typeof patch.metadata === "string" ? patch.metadata : JSON.stringify(patch.metadata)),
    patch.last_error ?? null,
    tenantId
  );

  return getVmInstance(tenantId);
}

export function updateVmState(tenantId, state, lastError = null) {
  tenantId = normalizeTenantId(tenantId);
  db.query(`
    UPDATE vm_instances
    SET state = ?, last_error = COALESCE(?, last_error), updated_at = datetime('now')
    WHERE tenant_id = ?
  `).run(state, lastError, tenantId);
  return getVmInstance(tenantId);
}

export function insertVmJob(job) {
  const tenantId = normalizeTenantId(job.tenantId);
  db.query(`
    INSERT INTO vm_jobs (id, tenant_id, type, status, retries, payload, error, created_at, updated_at, canceled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    job.id,
    tenantId,
    job.type,
    job.status || "queued",
    Number(job.retries || 0),
    typeof job.payload === "string" ? job.payload : JSON.stringify(job.payload || {}),
    job.error || "",
    job.createdAt || new Date().toISOString(),
    job.updatedAt || new Date().toISOString(),
    job.canceled ? 1 : 0
  );
}

export function updateVmJob(jobId, patch = {}) {
  db.query(`
    UPDATE vm_jobs
    SET
      status = COALESCE(?, status),
      retries = COALESCE(?, retries),
      payload = COALESCE(?, payload),
      error = COALESCE(?, error),
      canceled = COALESCE(?, canceled),
      updated_at = COALESCE(?, datetime('now'))
    WHERE id = ?
  `).run(
    patch.status ?? null,
    patch.retries ?? null,
    patch.payload === undefined ? null : (typeof patch.payload === "string" ? patch.payload : JSON.stringify(patch.payload)),
    patch.error ?? null,
    patch.canceled === undefined ? null : (patch.canceled ? 1 : 0),
    patch.updatedAt ?? null,
    jobId
  );
}

export function getVmJob(jobId) {
  const row = db.query("SELECT * FROM vm_jobs WHERE id = ?").get(jobId);
  if (!row) return null;
  return {
    ...row,
    retries: Number(row.retries || 0),
    canceled: Number(row.canceled || 0) === 1,
    payload: (() => { try { return JSON.parse(row.payload || "{}"); } catch { return {}; } })(),
  };
}

export function listVmJobs(tenantId, limit = 200) {
  const tId = normalizeTenantId(tenantId);
  const rows = db.query(`
    SELECT * FROM vm_jobs
    WHERE tenant_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(tId, limit);

  return rows.map((row) => ({
    ...row,
    retries: Number(row.retries || 0),
    canceled: Number(row.canceled || 0) === 1,
    payload: (() => { try { return JSON.parse(row.payload || "{}"); } catch { return {}; } })(),
  }));
}

export function listPendingVmJobs(limit = 1000) {
  const rows = db.query(`
    SELECT * FROM vm_jobs
    WHERE status IN ('queued', 'retrying', 'running')
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);

  return rows.map((row) => ({
    ...row,
    retries: Number(row.retries || 0),
    canceled: Number(row.canceled || 0) === 1,
    payload: (() => { try { return JSON.parse(row.payload || "{}"); } catch { return {}; } })(),
  }));
}

export function upsertVmTerminalSession(session) {
  const tenantId = normalizeTenantId(session.tenantId);
  const existing = db.query("SELECT id FROM vm_terminal_sessions WHERE id = ?").get(session.id);
  if (!existing) {
    db.query(`
      INSERT INTO vm_terminal_sessions (
        id, tenant_id, mode, vmid, ip_address, username, status, metadata, created_at, updated_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      session.id,
      tenantId,
      session.mode || "local",
      session.vmid ?? null,
      session.ip_address || "",
      session.username || "",
      session.status || "open",
      typeof session.metadata === "string" ? session.metadata : JSON.stringify(session.metadata || {}),
      session.createdAt || new Date().toISOString(),
      session.updatedAt || new Date().toISOString(),
      session.lastSeenAt || new Date().toISOString()
    );
    return;
  }

  db.query(`
    UPDATE vm_terminal_sessions
    SET
      mode = COALESCE(?, mode),
      vmid = COALESCE(?, vmid),
      ip_address = COALESCE(?, ip_address),
      username = COALESCE(?, username),
      status = COALESCE(?, status),
      metadata = COALESCE(?, metadata),
      updated_at = COALESCE(?, datetime('now')),
      last_seen_at = COALESCE(?, datetime('now'))
    WHERE id = ?
  `).run(
    session.mode ?? null,
    session.vmid ?? null,
    session.ip_address ?? null,
    session.username ?? null,
    session.status ?? null,
    session.metadata === undefined ? null : (typeof session.metadata === "string" ? session.metadata : JSON.stringify(session.metadata)),
    session.updatedAt ?? null,
    session.lastSeenAt ?? null,
    session.id
  );
}

export function getVmTerminalSession(sessionId) {
  const row = db.query("SELECT * FROM vm_terminal_sessions WHERE id = ?").get(sessionId);
  if (!row) return null;
  return {
    ...row,
    metadata: (() => { try { return JSON.parse(row.metadata || "{}"); } catch { return {}; } })(),
  };
}

export function listVmTerminalSessions(tenantId, limit = 100) {
  const tId = normalizeTenantId(tenantId);
  const rows = db.query(`
    SELECT * FROM vm_terminal_sessions
    WHERE tenant_id = ?
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(tId, limit);

  return rows.map((row) => ({
    ...row,
    metadata: (() => { try { return JSON.parse(row.metadata || "{}"); } catch { return {}; } })(),
  }));
}

// --- Default-Personas beim ersten Start ---
const defaultPersonaCount = db.query("SELECT COUNT(*) AS c FROM personas WHERE tenant_id = 'default'").get().c;
if (defaultPersonaCount === 0) {
  const ins = db.query(
    "INSERT INTO personas (tenant_id, name, emoji, system_prompt, model) VALUES (?, ?, ?, ?, ?)"
  );
  ins.run(
    "default",
    "Nimbus",
    "☁️",
    "Du bist Nimbus, ein persönlicher KI-Computer mit vollem Zugriff auf Terminal, Dateisystem und Web. Du handelst proaktiv: Du führst Aufgaben direkt aus, statt nur zu erklären. Antworte auf Deutsch, direkt und ohne Fülltext.",
    ""
  );
  ins.run(
    "default",
    "DevOps",
    "🛠️",
    "Du bist ein DevOps-Spezialist. Fokus: Shell, Services, Deployments, Monitoring. Du prüfst Ergebnisse nach jeder Aktion und meldest Fehler ehrlich.",
    ""
  );
  ins.run(
    "default",
    "Researcher",
    "🔎",
    "Du bist ein Recherche-Agent. Du nutzt Websuche und Seitenabruf intensiv, zitierst Quellen mit URL und fasst strukturiert zusammen.",
    ""
  );
}

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { db } from "./db.js";

function tenantId(tenantContext) {
  return tenantContext?.userId || "default";
}

function skillRoot(tenantContext) {
  const root = join(tenantContext?.workspaceRoot || join(import.meta.dir, "..", "workspace"), "skills");
  mkdirSync(root, { recursive: true });
  return root;
}

function parseList(raw) {
  if (!raw) return [];
  return String(raw)
    .split(/[,\n]/)
    .map((s) => s.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function parseSkillMd(content) {
  const lines = String(content || "").split(/\r?\n/);
  let name = "";
  let description = "";
  let scopes = [];
  let rules = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!name) {
      const h = line.match(/^#\s+(.+)/);
      if (h) name = h[1].trim();
    }
    const kv = line.match(/^([A-Za-z][A-Za-z _-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase().replace(/\s+/g, "_");
    const value = kv[2].trim();
    if (key === "name" && value) name = value;
    if (key === "description" && value) description = value;
    if (key === "scopes") scopes = parseList(value);
    if (key === "rules") rules = parseList(value);
  }

  if (!description) {
    const firstText = lines.find((l) => l.trim() && !l.startsWith("#") && !l.includes(":"));
    description = firstText ? firstText.trim().slice(0, 240) : "";
  }
  if (!scopes.length) scopes = ["tools:read_file", "tools:list_files", "tools:web_fetch", "tools:web_search"];
  if (!name) name = "Unbenannter Skill";
  return { name, description, scopes, rules };
}

export function importSkillFromContent(tenantContext, { name = "", content = "", sourcePath = "" }) {
  const tId = tenantId(tenantContext);
  const parsed = parseSkillMd(content);
  const skillName = String(name || parsed.name).trim();
  db.query(`
    INSERT INTO skills (tenant_id, name, source_path, description, scopes, rules, content, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(tenant_id, name) DO UPDATE SET
      source_path=excluded.source_path,
      description=excluded.description,
      scopes=excluded.scopes,
      rules=excluded.rules,
      content=excluded.content,
      enabled=1,
      updated_at=datetime('now')
  `).run(tId, skillName, sourcePath || "", parsed.description, JSON.stringify(parsed.scopes), JSON.stringify(parsed.rules), content);
  return getSkillByNameOrId(tId, skillName);
}

export function scanSkills(tenantContext) {
  const root = skillRoot(tenantContext);
  const imported = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    const file = statSync(p).isDirectory() ? join(p, "SKILL.md") : p;
    if (!file.endsWith(".md") || !existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    imported.push(importSkillFromContent(tenantContext, { content, sourcePath: file }));
  }
  return { ok: true, root, imported };
}

export function createSkillFile(tenantContext, { name, description = "", scopes = [], rules = [], content = "" }) {
  const safeName = String(name || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safeName) throw new Error("Skill-Name fehlt.");
  const dir = join(skillRoot(tenantContext), safeName);
  mkdirSync(dir, { recursive: true });
  const body = content || [
    `# ${name}`,
    "",
    description ? `Description: ${description}` : "Description: ",
    `Scopes: ${(scopes.length ? scopes : ["tools:read_file", "tools:list_files"]).join(", ")}`,
    rules.length ? `Rules: ${rules.join(", ")}` : "Rules: ",
    "",
    "## Anleitung",
    "Beschreibe hier, wie der Agent diesen Skill einsetzen soll.",
    "",
  ].join("\n");
  const path = join(dir, "SKILL.md");
  writeFileSync(path, body);
  const skill = importSkillFromContent(tenantContext, { name, content: body, sourcePath: path });
  return { ok: true, path, skill };
}

export function listSkills(tenantContext) {
  const tId = tenantId(tenantContext);
  return db.query("SELECT id, tenant_id, name, source_path, description, scopes, rules, enabled, created_at, updated_at FROM skills WHERE tenant_id = ? ORDER BY name").all(tId)
    .map((s) => ({ ...s, scopes: JSON.parse(s.scopes || "[]"), rules: JSON.parse(s.rules || "[]") }));
}

export function getSkillByNameOrId(tenantIdOrContext, nameOrId) {
  const tId = typeof tenantIdOrContext === "string" ? tenantIdOrContext : tenantId(tenantIdOrContext);
  const key = String(nameOrId || "").trim();
  const row = /^\d+$/.test(key)
    ? db.query("SELECT * FROM skills WHERE tenant_id = ? AND id = ?").get(tId, Number(key))
    : db.query("SELECT * FROM skills WHERE tenant_id = ? AND name = ?").get(tId, key);
  if (!row) return null;
  return { ...row, scopes: JSON.parse(row.scopes || "[]"), rules: JSON.parse(row.rules || "[]") };
}

export function setSkillEnabled(tenantContext, id, enabled) {
  const tId = tenantId(tenantContext);
  db.query("UPDATE skills SET enabled = ?, updated_at = datetime('now') WHERE tenant_id = ? AND id = ?").run(enabled ? 1 : 0, tId, id);
  return { ok: true };
}

export function isToolAllowedBySkill(skill, toolName) {
  if (!skill) return true;
  const scopes = Array.isArray(skill.scopes) ? skill.scopes : [];
  if (scopes.includes("*") || scopes.includes("tools:*")) return true;
  return scopes.includes(`tools:${toolName}`);
}

export function buildSkillSystemAppendix(skill) {
  if (!skill) return "";
  return [
    "\n\nAktiver SKILL.md:",
    `Name: ${skill.name}`,
    `Erlaubte Scopes: ${(skill.scopes || []).join(", ") || "keine"}`,
    skill.rules?.length ? `Regeln:\n${skill.rules.map((r) => `- ${r}`).join("\n")}` : "",
    "Inhalt:",
    skill.content,
  ].filter(Boolean).join("\n");
}

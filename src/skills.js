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
  if (Array.isArray(raw)) return raw.map((x) => String(x || "").trim()).filter(Boolean);
  return String(raw)
    .split(/[,\n]/)
    .map((s) => s.replace(/^[-*]\s*/, "").trim())
    .filter(Boolean);
}

function parseFrontmatterBlock(raw = "") {
  const obj = {};
  const lines = String(raw || "").split(/\r?\n/);
  let currentKey = "";
  let currentList = null;

  const flushList = () => {
    if (currentKey && currentList) obj[currentKey] = currentList.slice();
    currentList = null;
  };

  for (const lineRaw of lines) {
    const line = lineRaw.trimEnd();
    if (!line.trim()) continue;

    const m = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (m) {
      flushList();
      currentKey = m[1].toLowerCase();
      const val = m[2].trim();
      if (!val) {
        currentList = [];
      } else if (val.startsWith("[") && val.endsWith("]")) {
        obj[currentKey] = val.slice(1, -1).split(",").map((x) => x.trim()).filter(Boolean);
      } else {
        obj[currentKey] = val;
      }
      continue;
    }

    const lm = line.match(/^\s*-\s*(.+)$/);
    if (lm && currentKey) {
      if (!currentList) currentList = Array.isArray(obj[currentKey]) ? obj[currentKey].slice() : [];
      currentList.push(lm[1].trim());
    }
  }

  flushList();
  return obj;
}

function parseSkillMd(content) {
  const text = String(content || "");
  let body = text;
  let fm = {};

  const fmMatch = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (fmMatch) {
    fm = parseFrontmatterBlock(fmMatch[1] || "");
    body = text.slice(fmMatch[0].length);
  }

  const lines = body.split(/\r?\n/);
  let name = String(fm.name || "").trim();
  let description = String(fm.description || "").trim();
  let scopes = parseList(fm.scopes);
  let rules = parseList(fm.rules);
  let triggers = parseList(fm.triggers);

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
    if (key === "description" && value && !description) description = value;
    if (key === "scopes" && !scopes.length) scopes = parseList(value);
    if (key === "rules" && !rules.length) rules = parseList(value);
    if (key === "triggers" && !triggers.length) triggers = parseList(value);
  }

  if (!description) {
    const firstText = lines.find((l) => l.trim() && !l.startsWith("#") && !l.includes(":"));
    description = firstText ? firstText.trim().slice(0, 240) : "";
  }
  if (!scopes.length) scopes = ["tools:read_file", "tools:list_files", "tools:web_fetch", "tools:web_search"];
  if (!name) name = "Unbenannter Skill";
  return { name, description, scopes, rules, triggers };
}

export function importSkillFromContent(tenantContext, { name = "", content = "", sourcePath = "" }) {
  const tId = tenantId(tenantContext);
  const parsed = parseSkillMd(content);
  const skillName = String(name || parsed.name).trim();
  db.query(`
    INSERT INTO skills (tenant_id, name, source_path, description, scopes, rules, triggers, content, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
    ON CONFLICT(tenant_id, name) DO UPDATE SET
      source_path=excluded.source_path,
      description=excluded.description,
      scopes=excluded.scopes,
      rules=excluded.rules,
      triggers=excluded.triggers,
      content=excluded.content,
      enabled=1,
      updated_at=datetime('now')
  `).run(
    tId,
    skillName,
    sourcePath || "",
    parsed.description,
    JSON.stringify(parsed.scopes),
    JSON.stringify(parsed.rules),
    JSON.stringify(parsed.triggers || []),
    content
  );
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
  return db.query("SELECT id, tenant_id, name, source_path, description, scopes, rules, triggers, enabled, created_at, updated_at FROM skills WHERE tenant_id = ? ORDER BY name").all(tId)
    .map((s) => ({
      ...s,
      scopes: JSON.parse(s.scopes || "[]"),
      rules: JSON.parse(s.rules || "[]"),
      triggers: JSON.parse(s.triggers || "[]"),
    }));
}

export function getSkillByNameOrId(tenantIdOrContext, nameOrId) {
  const tId = typeof tenantIdOrContext === "string" ? tenantIdOrContext : tenantId(tenantIdOrContext);
  const key = String(nameOrId || "").trim();
  const row = /^\d+$/.test(key)
    ? db.query("SELECT * FROM skills WHERE tenant_id = ? AND id = ?").get(tId, Number(key))
    : db.query("SELECT * FROM skills WHERE tenant_id = ? AND name = ?").get(tId, key);
  if (!row) return null;
  return {
    ...row,
    scopes: JSON.parse(row.scopes || "[]"),
    rules: JSON.parse(row.rules || "[]"),
    triggers: JSON.parse(row.triggers || "[]"),
  };
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

function scoreSkillForPrompt(skill, prompt = "") {
  const q = String(prompt || "").toLowerCase();
  if (!q.trim()) return 0;
  const parts = [
    skill?.name || "",
    skill?.description || "",
    ...(skill?.triggers || []),
    ...(skill?.rules || []),
  ].map((x) => String(x || "").toLowerCase());

  let score = 0;
  for (const p of parts) {
    if (!p) continue;
    if (q.includes(p)) score += 5;
    const tokens = p.split(/[^a-z0-9:_-]+/).filter((t) => t.length > 2);
    for (const t of tokens) {
      if (q.includes(t)) score += 1;
    }
  }
  return score;
}

export function selectRelevantSkills(tenantContext, prompt = "", limit = 3) {
  const all = listSkills(tenantContext).filter((s) => !!s.enabled);
  return all
    .map((s) => ({ skill: s, score: scoreSkillForPrompt(s, prompt) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Number(limit || 3)))
    .map((x) => x.skill);
}

export function buildSkillSystemAppendix(skillOrSkills) {
  const skills = Array.isArray(skillOrSkills) ? skillOrSkills : (skillOrSkills ? [skillOrSkills] : []);
  if (!skills.length) return "";
  const blocks = [];
  for (const skill of skills) {
    blocks.push([
      `Skill: ${skill.name}`,
      `Scopes: ${(skill.scopes || []).join(", ") || "keine"}`,
      skill.rules?.length ? `Regeln:\n${skill.rules.map((r) => `- ${r}`).join("\n")}` : "",
      skill.triggers?.length ? `Trigger:\n${skill.triggers.map((t) => `- ${t}`).join("\n")}` : "",
      "Inhalt (kompakt):",
      String(skill.content || "").slice(0, 1800),
    ].filter(Boolean).join("\n"));
  }
  return `\n\nRelevante SKILL.md-Kontexte:\n${blocks.join("\n\n---\n\n")}`;
}

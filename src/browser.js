import { randomBytes } from "crypto";
import { db } from "./db.js";

function tenantId(tenantContext) {
  return tenantContext?.userId || "default";
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s{2,}/g, " ")
    .trim();
}

function titleOf(html) {
  return String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() || "";
}

function absolutize(base, href) {
  try { return new URL(href, base).toString(); } catch { return href || ""; }
}

function extractLinks(html, url) {
  const links = [];
  const re = /<a\b[^>]*href=["']?([^"'\s>]+)["']?[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && links.length < 200) {
    links.push({ index: links.length, url: absolutize(url, m[1]), text: stripHtml(m[2]).slice(0, 180) });
  }
  return links;
}

function extractForms(html, url) {
  const forms = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m;
  while ((m = re.exec(html)) && forms.length < 50) {
    const attrs = m[1] || "";
    const inner = m[2] || "";
    const action = attrs.match(/\baction=["']?([^"'\s>]+)["']?/i)?.[1] || url;
    const method = attrs.match(/\bmethod=["']?([^"'\s>]+)["']?/i)?.[1]?.toUpperCase() || "GET";
    const inputs = [];
    const inputRe = /<(input|textarea|select)\b([^>]*)>([\s\S]*?<\/\1>)?/gi;
    let im;
    while ((im = inputRe.exec(inner)) && inputs.length < 100) {
      const a = im[2] || "";
      const name = a.match(/\bname=["']?([^"'\s>]+)["']?/i)?.[1] || "";
      if (!name) continue;
      inputs.push({
        name,
        type: a.match(/\btype=["']?([^"'\s>]+)["']?/i)?.[1] || im[1].toLowerCase(),
        value: a.match(/\bvalue=["']?([^"']*)["']?/i)?.[1] || "",
      });
    }
    forms.push({ index: forms.length, action: absolutize(url, action), method, inputs });
  }
  return forms;
}

function sessionPublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    current_url: row.current_url,
    title: row.title,
    text: row.text,
    forms: JSON.parse(row.forms || "[]"),
    links: JSON.parse(row.links || "[]"),
    screenshot_text: row.screenshot_text,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function loadIntoSession(tenantContext, sessionId, url, init = {}) {
  const res = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "NimbusBrowser/1.0" },
    signal: AbortSignal.timeout(30000),
    ...init,
  });
  const finalUrl = res.url || url;
  const html = await res.text();
  const text = stripHtml(html).slice(0, 300000);
  const links = extractLinks(html, finalUrl);
  const forms = extractForms(html, finalUrl);
  const title = titleOf(html);
  const screenshot = [
    `URL: ${finalUrl}`,
    title ? `TITLE: ${title}` : "",
    text.slice(0, 5000),
  ].filter(Boolean).join("\n\n");
  db.query(`
    INSERT INTO browser_sessions (id, tenant_id, current_url, title, html, text, forms, links, screenshot_text, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      current_url=excluded.current_url,
      title=excluded.title,
      html=excluded.html,
      text=excluded.text,
      forms=excluded.forms,
      links=excluded.links,
      screenshot_text=excluded.screenshot_text,
      updated_at=datetime('now')
  `).run(sessionId, tenantId(tenantContext), finalUrl, title, html, text, JSON.stringify(forms), JSON.stringify(links), screenshot);
  return { ok: true, status: res.status, session: getBrowserSession(tenantContext, sessionId) };
}

export function createBrowserSession(tenantContext) {
  const id = `br_${randomBytes(8).toString("hex")}`;
  db.query("INSERT INTO browser_sessions (id, tenant_id, updated_at) VALUES (?, ?, datetime('now'))").run(id, tenantId(tenantContext));
  return getBrowserSession(tenantContext, id);
}

export function listBrowserSessions(tenantContext) {
  return db.query("SELECT * FROM browser_sessions WHERE tenant_id = ? ORDER BY updated_at DESC LIMIT 50").all(tenantId(tenantContext)).map(sessionPublic);
}

export function getBrowserSession(tenantContext, id) {
  const row = db.query("SELECT * FROM browser_sessions WHERE tenant_id = ? AND id = ?").get(tenantId(tenantContext), id);
  return sessionPublic(row);
}

export async function browserOpen(tenantContext, { session_id = "", url }) {
  if (!url) throw new Error("URL fehlt.");
  const session = session_id ? getBrowserSession(tenantContext, session_id) : createBrowserSession(tenantContext);
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return loadIntoSession(tenantContext, session.id, target);
}

export async function browserClick(tenantContext, { session_id, text = "", index = null }) {
  const session = getBrowserSession(tenantContext, session_id);
  if (!session) throw new Error("Browser-Session nicht gefunden.");
  const links = session.links || [];
  const link = Number.isFinite(Number(index))
    ? links[Number(index)]
    : links.find((l) => String(l.text || "").toLowerCase().includes(String(text || "").toLowerCase()));
  if (!link?.url) throw new Error("Link nicht gefunden.");
  return loadIntoSession(tenantContext, session.id, link.url);
}

export async function browserSubmit(tenantContext, { session_id, form_index = 0, fields = {} }) {
  const session = getBrowserSession(tenantContext, session_id);
  if (!session) throw new Error("Browser-Session nicht gefunden.");
  const form = (session.forms || [])[Number(form_index) || 0];
  if (!form) throw new Error("Formular nicht gefunden.");
  const params = new URLSearchParams();
  for (const input of form.inputs || []) params.set(input.name, fields[input.name] ?? input.value ?? "");
  for (const [k, v] of Object.entries(fields || {})) if (!params.has(k)) params.set(k, v);
  const method = String(form.method || "GET").toUpperCase();
  if (method === "GET") {
    const u = new URL(form.action);
    for (const [k, v] of params.entries()) u.searchParams.set(k, v);
    return loadIntoSession(tenantContext, session.id, u.toString());
  }
  return loadIntoSession(tenantContext, session.id, form.action, {
    method,
    headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": "NimbusBrowser/1.0" },
    body: params.toString(),
  });
}

export function browserScreenshot(tenantContext, { session_id }) {
  const session = getBrowserSession(tenantContext, session_id);
  if (!session) throw new Error("Browser-Session nicht gefunden.");
  return { ok: true, session_id, screenshot_text: session.screenshot_text };
}

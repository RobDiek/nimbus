import { randomBytes } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { db, WORKSPACE } from "./db.js";

let chromium = null;
let playwrightReady = false;
const runtimeBySession = new Map(); // sessionId -> { browser, context, page, provider, tenantId, lastUsedAt }

async function ensurePlaywright() {
  if (playwrightReady) return chromium;
  try {
    const mod = await import("playwright");
    chromium = mod.chromium;
    playwrightReady = true;
    return chromium;
  } catch {
    playwrightReady = false;
    return null;
  }
}

function tenantId(tenantContext) {
  return tenantContext?.userId || "default";
}

function workspaceRoot(tenantContext) {
  return tenantContext?.workspaceRoot || WORKSPACE;
}

function screenshotsDir(tenantContext) {
  const p = join(workspaceRoot(tenantContext), "browser-shots");
  mkdirSync(p, { recursive: true });
  return p;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/"/g, '"')
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

function persistSession(tenantContext, sessionId, payload) {
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
  `).run(
    sessionId,
    tenantId(tenantContext),
    payload.current_url || "",
    payload.title || "",
    payload.html || "",
    payload.text || "",
    JSON.stringify(payload.forms || []),
    JSON.stringify(payload.links || []),
    payload.screenshot_text || ""
  );
}

async function snapshotWithPlaywright(tenantContext, sessionId, page) {
  const html = await page.content();
  const currentUrl = page.url();
  const title = await page.title();
  const text = stripHtml(html).slice(0, 300000);
  const links = extractLinks(html, currentUrl);
  const forms = extractForms(html, currentUrl);

  let screenshot_base64 = "";
  let screenshot_path = "";
  try {
    const png = await page.screenshot({ fullPage: true, type: "png", timeout: 15000 });
    screenshot_base64 = Buffer.from(png).toString("base64");
    const p = join(screenshotsDir(tenantContext), `${sessionId}_${Date.now()}.png`);
    writeFileSync(p, png);
    screenshot_path = p;
  } catch {}

  let a11y = null;
  try { a11y = await page.accessibility.snapshot({ interestingOnly: false }); } catch {}

  const dom_snapshot = {
    url: currentUrl,
    title,
    links_count: links.length,
    forms_count: forms.length,
  };

  const screenshot_text = [
    `URL: ${currentUrl}`,
    title ? `TITLE: ${title}` : "",
    `DOM: links=${links.length}, forms=${forms.length}`,
    text.slice(0, 5000),
  ].filter(Boolean).join("\n\n");

  persistSession(tenantContext, sessionId, {
    current_url: currentUrl,
    title,
    html,
    text,
    forms,
    links,
    screenshot_text,
  });

  return {
    ok: true,
    session: getBrowserSession(tenantContext, sessionId),
    screenshot_base64,
    screenshot_path,
    dom_snapshot,
    a11y_snapshot: a11y,
  };
}

async function ensureRuntimeSession(tenantContext, sessionId) {
  const existing = runtimeBySession.get(sessionId);
  if (existing) {
    existing.lastUsedAt = Date.now();
    return existing;
  }

  const pw = await ensurePlaywright();
  if (!pw) return null;

  const browser = await pw.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);

  const rt = {
    browser,
    context,
    page,
    provider: "playwright",
    tenantId: tenantId(tenantContext),
    lastUsedAt: Date.now(),
  };
  runtimeBySession.set(sessionId, rt);
  return rt;
}

async function closeRuntimeSession(sessionId) {
  const rt = runtimeBySession.get(sessionId);
  if (!rt) return;
  try { await rt.page?.close(); } catch {}
  try { await rt.context?.close(); } catch {}
  try { await rt.browser?.close(); } catch {}
  runtimeBySession.delete(sessionId);
}

setInterval(() => {
  const now = Date.now();
  for (const [sid, rt] of runtimeBySession.entries()) {
    if (now - (rt.lastUsedAt || 0) > 10 * 60 * 1000) {
      closeRuntimeSession(sid);
    }
  }
}, 60 * 1000);

async function loadIntoSessionHttp(tenantContext, sessionId, url, init = {}) {
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

  persistSession(tenantContext, sessionId, {
    current_url: finalUrl,
    title,
    html,
    text,
    forms,
    links,
    screenshot_text: screenshot,
  });

  return {
    ok: true,
    status: res.status,
    provider: "http-fallback",
    session: getBrowserSession(tenantContext, sessionId),
    dom_snapshot: { url: finalUrl, title, links_count: links.length, forms_count: forms.length },
    a11y_snapshot: null,
    screenshot_base64: "",
  };
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

  const rt = await ensureRuntimeSession(tenantContext, session.id);
  if (!rt) return loadIntoSessionHttp(tenantContext, session.id, target);

  await rt.page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
  return snapshotWithPlaywright(tenantContext, session.id, rt.page);
}

export async function browserClick(tenantContext, { session_id, text = "", index = null, selector = "", x = null, y = null }) {
  const session = getBrowserSession(tenantContext, session_id);
  if (!session) throw new Error("Browser-Session nicht gefunden.");

  const rt = await ensureRuntimeSession(tenantContext, session.id);
  if (!rt) {
    const links = session.links || [];
    const link = Number.isFinite(Number(index))
      ? links[Number(index)]
      : links.find((l) => String(l.text || "").toLowerCase().includes(String(text || "").toLowerCase()));
    if (!link?.url) throw new Error("Link nicht gefunden.");
    return loadIntoSessionHttp(tenantContext, session.id, link.url);
  }

  if (selector) {
    await rt.page.click(selector, { timeout: 15000 });
  } else if (Number.isFinite(Number(x)) && Number.isFinite(Number(y))) {
    await rt.page.mouse.click(Number(x), Number(y));
  } else if (text) {
    const loc = rt.page.getByRole("link", { name: new RegExp(text, "i") }).first();
    await loc.click({ timeout: 15000 });
  } else if (Number.isFinite(Number(index))) {
    const links = await rt.page.locator("a").all();
    const el = links[Number(index)];
    if (!el) throw new Error("Link nicht gefunden.");
    await el.click({ timeout: 15000 });
  } else {
    throw new Error("Bitte text, selector, index oder x/y angeben.");
  }

  await rt.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  return snapshotWithPlaywright(tenantContext, session.id, rt.page);
}

export async function browserSubmit(tenantContext, { session_id, form_index = 0, fields = {}, selector = "" }) {
  const session = getBrowserSession(tenantContext, session_id);
  if (!session) throw new Error("Browser-Session nicht gefunden.");

  const rt = await ensureRuntimeSession(tenantContext, session.id);
  if (!rt) {
    const form = (session.forms || [])[Number(form_index) || 0];
    if (!form) throw new Error("Formular nicht gefunden.");
    const params = new URLSearchParams();
    for (const input of form.inputs || []) params.set(input.name, fields[input.name] ?? input.value ?? "");
    for (const [k, v] of Object.entries(fields || {})) if (!params.has(k)) params.set(k, v);
    const method = String(form.method || "GET").toUpperCase();
    if (method === "GET") {
      const u = new URL(form.action);
      for (const [k, v] of params.entries()) u.searchParams.set(k, v);
      return loadIntoSessionHttp(tenantContext, session.id, u.toString());
    }
    return loadIntoSessionHttp(tenantContext, session.id, form.action, {
      method,
      headers: { "content-type": "application/x-www-form-urlencoded", "User-Agent": "NimbusBrowser/1.0" },
      body: params.toString(),
    });
  }

  for (const [k, v] of Object.entries(fields || {})) {
    const byName = rt.page.locator(`[name="${k}"]`).first();
    if (await byName.count()) {
      await byName.fill(String(v ?? ""));
      continue;
    }
    try {
      await rt.page.fill(k, String(v ?? ""));
    } catch {}
  }

  if (selector) {
    await rt.page.click(selector, { timeout: 15000 });
  } else {
    const forms = rt.page.locator("form");
    const count = await forms.count();
    const idx = Math.max(0, Number(form_index || 0));
    if (count > idx) {
      const targetForm = forms.nth(idx);
      const submit = targetForm.locator('button[type="submit"], input[type="submit"]').first();
      if (await submit.count()) await submit.click({ timeout: 10000 });
      else await targetForm.press("Enter").catch(() => {});
    } else {
      await rt.page.keyboard.press("Enter").catch(() => {});
    }
  }

  await rt.page.waitForLoadState("domcontentloaded", { timeout: 20000 }).catch(() => {});
  return snapshotWithPlaywright(tenantContext, session.id, rt.page);
}

export async function browserScreenshot(tenantContext, { session_id, close = false }) {
  const session = getBrowserSession(tenantContext, session_id);
  if (!session) throw new Error("Browser-Session nicht gefunden.");

  const rt = await ensureRuntimeSession(tenantContext, session.id);
  if (!rt) {
    return { ok: true, session_id, screenshot_text: session.screenshot_text, screenshot_base64: "" };
  }

  const snap = await snapshotWithPlaywright(tenantContext, session.id, rt.page);
  if (close) await closeRuntimeSession(session.id);

  return {
    ok: true,
    session_id,
    screenshot_text: snap.session?.screenshot_text || "",
    screenshot_base64: snap.screenshot_base64 || "",
    screenshot_path: snap.screenshot_path || "",
    dom_snapshot: snap.dom_snapshot || null,
    a11y_snapshot: snap.a11y_snapshot || null,
  };
}

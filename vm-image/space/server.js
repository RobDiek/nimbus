/**
 * Nimbus Space — dynamisches PaaS (zo.space-Äquivalent).
 *
 * - API-/Page-/Static-Routen aus routes.json + routes/*
 * - Workspace-Assets unter /assets/* aus NIMBUS_WORKSPACE
 * - Health: GET /__health
 */
import { Hono } from "hono";
import { readFileSync, existsSync, statSync } from "fs";
import { join, extname } from "path";

const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT || process.env.NIMBUS_SPACE_PORT || 3000);
const WORKSPACE = process.env.NIMBUS_WORKSPACE || join(ROOT, "..", "..", "workspace");

const app = new Hono();

function loadManifest() {
  const p = join(ROOT, "routes.json");
  if (!existsSync(p)) return { version: 1, routes: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { version: 1, routes: [] };
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

app.get("/__health", (c) => c.json({
  ok: true,
  service: "nimbus-space",
  workspace: WORKSPACE,
  routes: loadManifest().routes?.length || 0,
}));

app.get("/__routes", (c) => c.json(loadManifest()));

// Workspace-Dateien als Assets
app.get("/assets/*", async (c) => {
  const rel = c.req.path.replace(/^\/assets\/?/, "");
  if (!rel || rel.includes("..")) return c.text("Forbidden", 403);
  const full = join(WORKSPACE, rel);
  if (!existsSync(full) || !statSync(full).isFile()) return c.text("Not found", 404);
  const ext = extname(full).toLowerCase();
  const body = readFileSync(full);
  return new Response(body, {
    headers: { "content-type": MIME[ext] || "application/octet-stream" },
  });
});

app.all("/*", async (c) => {
  const path = new URL(c.req.url).pathname.replace(/\/+$/, "") || "/";
  const manifest = loadManifest();
  const route = (manifest.routes || []).find((r) => {
    const rp = r.path.replace(/\/+$/, "") || "/";
    return rp === path;
  });

  if (!route) {
    // Fallback: index page
    if (path === "/") {
      return c.html(`<!doctype html><html><head><meta charset="utf-8"><title>Nimbus Space</title></head>
<body style="font-family:system-ui;padding:2rem">
<h1>Nimbus Space</h1>
<p>Keine Root-Route definiert. Nutze <code>write_space_route</code>.</p>
<p><a href="/__routes">/__routes</a> · <a href="/__health">/__health</a></p>
</body></html>`);
    }
    return c.text("Not found", 404);
  }

  if (route.public === false) {
    return c.text("Private route", 403);
  }

  const file = join(ROOT, route.file);
  if (!existsSync(file)) return c.text("Route file missing", 500);

  if (route.type === "api") {
    try {
      const mod = await import(`${file}?t=${Date.now()}`);
      const handler = mod.default || mod.handler;
      if (typeof handler !== "function") return c.json({ error: "API route has no default export" }, 500);
      return await handler(c);
    } catch (err) {
      return c.json({ error: String(err?.message || err) }, 500);
    }
  }

  if (route.type === "static") {
    const body = readFileSync(file);
    const ext = extname(file).toLowerCase();
    return new Response(body, {
      headers: { "content-type": MIME[ext] || "text/plain; charset=utf-8" },
    });
  }

  // page
  return c.html(readFileSync(file, "utf8"));
});

export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`[nimbus-space] listening on :${PORT} workspace=${WORKSPACE}`);

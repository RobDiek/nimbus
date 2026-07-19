/**
 * Nimbus Space Runtime — Vite + React + Tailwind CSS 4 + Hono.
 *
 * Vite ist der HTTP-Server (HMR). Hono hängt als Middleware für
 * /__* und /api/* davor. In Produktion: dist/ + dieselbe API.
 */
import { Hono } from "hono";
import { createServer as createViteServer, build as viteBuild } from "vite";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.SPACE_PORT || process.env.PORT || process.env.NIMBUS_SPACE_PORT || 3000);
const IS_PROD =
  process.env.NODE_ENV === "production" ||
  process.env.NIMBUS_SPACE_MODE === "prod";
const DIST = join(ROOT, "dist");
const ROUTES_FILE = join(ROOT, "routes.json");
const PAGES_DIR = join(ROOT, "pages");
const API_DIR = join(ROOT, "api");

mkdirSync(PAGES_DIR, { recursive: true });
mkdirSync(API_DIR, { recursive: true });

function loadRoutes() {
  if (!existsSync(ROUTES_FILE)) return { routes: [] };
  try {
    return JSON.parse(readFileSync(ROUTES_FILE, "utf8"));
  } catch {
    return { routes: [] };
  }
}

function saveRoutes(data) {
  writeFileSync(ROUTES_FILE, JSON.stringify(data, null, 2));
}

function listPageFiles() {
  if (!existsSync(PAGES_DIR)) return [];
  return readdirSync(PAGES_DIR)
    .filter((f) => /\.(jsx|tsx|js|ts)$/.test(f))
    .map((f) => f.replace(/\.(jsx|tsx|js|ts)$/, ""));
}

function createApiApp() {
  const app = new Hono();

  app.get("/__health", (c) =>
    c.json({
      ok: true,
      service: "nimbus-space",
      mode: IS_PROD ? "production" : "development",
      framework: "vite+react+tailwind4",
      pages: listPageFiles(),
      routes: loadRoutes().routes.length,
    }),
  );

  app.get("/__routes", (c) => {
    const data = loadRoutes();
    const pages = listPageFiles();
    return c.json({
      routes: data.routes,
      pages: pages.map((name) => ({
        name,
        path: name.toLowerCase() === "hello" ? "/" : `/${name.toLowerCase()}`,
        type: "page",
        file: `pages/${name}.tsx`,
      })),
    });
  });

  app.post("/__routes", async (c) => {
    const body = await c.req.json();
    const { path, type = "page", name, content } = body;
    if (!path || !content) return c.json({ error: "path und content erforderlich" }, 400);

    const data = loadRoutes();
    const existing = data.routes.findIndex((r) => r.path === path);
    const entry = {
      path,
      type,
      name: name || path,
      updatedAt: new Date().toISOString(),
    };

    if (type === "page") {
      const pageName =
        (name || path.replace(/^\//, "") || "Index").replace(/[^a-zA-Z0-9_-]/g, "") ||
        "Page";
      const file = join(PAGES_DIR, `${pageName}.tsx`);
      writeFileSync(file, content);
      entry.file = `pages/${pageName}.tsx`;
      entry.name = pageName;
    } else if (type === "api") {
      const apiName =
        (name || path.replace(/^\/api\//, "") || "handler").replace(/[^a-zA-Z0-9_-]/g, "") ||
        "handler";
      const file = join(API_DIR, `${apiName}.js`);
      writeFileSync(file, content);
      entry.file = `api/${apiName}.js`;
      entry.name = apiName;
    } else {
      return c.json({ error: `Unbekannter Typ: ${type}` }, 400);
    }

    if (existing >= 0) data.routes[existing] = entry;
    else data.routes.push(entry);
    saveRoutes(data);
    return c.json({ ok: true, route: entry });
  });

  app.delete("/__routes", async (c) => {
    const body = await c.req.json();
    const { path } = body;
    if (!path) return c.json({ error: "path erforderlich" }, 400);
    const data = loadRoutes();
    const route = data.routes.find((r) => r.path === path);
    if (route?.file) {
      const full = join(ROOT, route.file);
      if (existsSync(full)) unlinkSync(full);
    }
    data.routes = data.routes.filter((r) => r.path !== path);
    saveRoutes(data);
    return c.json({ ok: true });
  });

  app.all("/api/*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    const name = pathname.replace(/^\/api\//, "").split("/")[0];
    const file = join(API_DIR, `${name}.js`);
    if (!existsSync(file)) return c.json({ error: "API-Route nicht gefunden" }, 404);
    try {
      const mod = await import(`${file}?t=${Date.now()}`);
      const handler = mod.default || mod.handler;
      if (typeof handler !== "function") {
        return c.json({ error: "Kein Handler exportiert" }, 500);
      }
      return handler(c);
    } catch (e) {
      return c.json({ error: String(e) }, 500);
    }
  });

  return app;
}

async function handleApi(req, res, app) {
  const host = req.headers.host || `127.0.0.1:${PORT}`;
  const url = `http://${host}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v != null) headers.set(k, Array.isArray(v) ? v.join(", ") : String(v));
  }

  let body;
  if (req.method !== "GET" && req.method !== "HEAD") {
    body = await new Promise((resolve, reject) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => resolve(Buffer.concat(chunks)));
      req.on("error", reject);
    });
  }

  const response = await app.fetch(
    new Request(url, { method: req.method, headers, body }),
  );
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  const buf = Buffer.from(await response.arrayBuffer());
  res.end(buf);
}

async function startDev() {
  const api = createApiApp();

  const vite = await createViteServer({
    root: ROOT,
    configFile: join(ROOT, "vite.config.js"),
    server: {
      host: "0.0.0.0",
      port: PORT,
      strictPort: true,
    },
    plugins: [
      {
        name: "nimbus-space-api",
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const url = req.url || "";
            const path = url.split("?")[0];
            if (path.startsWith("/__") || path.startsWith("/api/")) {
              try {
                await handleApi(req, res, api);
              } catch (e) {
                res.statusCode = 500;
                res.end(String(e));
              }
              return;
            }
            next();
          });
        },
      },
    ],
  });

  await vite.listen(PORT);
  vite.printUrls();
  console.log(`[nimbus-space] vite+react+tailwind4 on :${PORT}`);
}

async function startProd() {
  const api = createApiApp();

  if (!existsSync(join(DIST, "index.html"))) {
    console.log("[nimbus-space] dist/ fehlt — baue Production-Bundle…");
    await viteBuild({ root: ROOT, configFile: join(ROOT, "vite.config.js") });
  }

  const indexHtml = readFileSync(join(DIST, "index.html"), "utf8");

  Bun.serve({
    port: PORT,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith("/__") || url.pathname.startsWith("/api/")) {
        return api.fetch(req);
      }
      const filePath = join(DIST, url.pathname === "/" ? "index.html" : url.pathname);
      if (url.pathname !== "/" && existsSync(filePath) && !filePath.endsWith("/")) {
        const file = Bun.file(filePath);
        return new Response(file);
      }
      return new Response(indexHtml, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  });
  console.log(`[nimbus-space] production on :${PORT}`);
}

if (IS_PROD) {
  startProd().catch((e) => {
    console.error(e);
    process.exit(1);
  });
} else {
  startDev().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

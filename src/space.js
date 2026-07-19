/**
 * Dynamisches PaaS / Space (Phase 3) — Control-Plane-Seite.
 *
 * Verwaltet Routen unter `<workspace>/__substrate/space/`.
 * Der Hono-Server in der VM (vm-image/space) lädt dieselbe Struktur.
 *
 * Route-Typen: api | page | static
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync,
} from "fs";
import { join, dirname } from "path";
import { config } from "./config.js";
import { getVmInstance } from "./db.js";
import { execOnVmViaSsh } from "./proxmox.js";

function workspaceRoot(tenantContext) {
  return tenantContext?.workspaceRoot || join(import.meta.dir, "..", "workspace");
}

function spaceRoot(tenantContext) {
  return join(workspaceRoot(tenantContext), config.space.substratePath);
}

function manifestPath(tenantContext) {
  return join(spaceRoot(tenantContext), "routes.json");
}

function normalizeRoutePath(path) {
  let p = String(path || "").trim();
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function routeFileName(routePath, routeType) {
  // /api/ping + api → routes/api/api__ping.js (keine verschachtelten Pfadsegmente)
  const safe = (routePath.replace(/^\//, "").replace(/\//g, "__").replace(/[^a-zA-Z0-9._-]/g, "_") || "index");
  const ext = routeType === "page" ? "html" : routeType === "static" ? "txt" : "js";
  return join("routes", routeType, `${safe}.${ext}`);
}

export function ensureSpaceScaffold(tenantContext) {
  const root = spaceRoot(tenantContext);
  mkdirSync(join(root, "routes", "api"), { recursive: true });
  mkdirSync(join(root, "routes", "page"), { recursive: true });
  mkdirSync(join(root, "routes", "static"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });

  const pkgPath = join(root, "package.json");
  if (!existsSync(pkgPath)) {
    writeFileSync(pkgPath, JSON.stringify({
      name: "nimbus-space",
      private: true,
      type: "module",
      scripts: {
        start: "bun run server.js",
        dev: "bun --watch server.js",
      },
      dependencies: {
        hono: "^4.7.2",
      },
    }, null, 2));
  }

  const serverPath = join(root, "server.js");
  if (!existsSync(serverPath)) {
    // Minimaler Hono-Loader — vollständige Vorlage liegt in vm-image/space
    writeFileSync(serverPath, readSpaceServerTemplate());
  }

  if (!existsSync(manifestPath(tenantContext))) {
    writeFileSync(manifestPath(tenantContext), JSON.stringify({ version: 1, routes: [] }, null, 2));
  }

  return { ok: true, root };
}

function readSpaceServerTemplate() {
  const bundled = join(import.meta.dir, "..", "vm-image", "space", "server.js");
  if (existsSync(bundled)) return readFileSync(bundled, "utf8");
  return `import { Hono } from "hono";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
const app = new Hono();
const ROOT = import.meta.dir;
const PORT = Number(process.env.PORT || 3000);
const WORKSPACE = process.env.NIMBUS_WORKSPACE || join(ROOT, "..", "..");
app.get("/__health", (c) => c.json({ ok: true, service: "nimbus-space" }));
app.get("/*", async (c) => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "routes.json"), "utf8"));
  const path = new URL(c.req.url).pathname;
  const route = (manifest.routes || []).find((r) => r.path === path && r.public !== false);
  if (!route) return c.text("Not found", 404);
  const file = join(ROOT, route.file);
  if (!existsSync(file)) return c.text("Route file missing", 500);
  if (route.type === "api") {
    const mod = await import(file + "?t=" + Date.now());
    return mod.default(c);
  }
  return c.html(readFileSync(file, "utf8"));
});
export default { port: PORT, fetch: app.fetch };
console.log("Nimbus Space listening on :" + PORT + " workspace=" + WORKSPACE);
`;
}

function loadManifest(tenantContext) {
  ensureSpaceScaffold(tenantContext);
  try {
    return JSON.parse(readFileSync(manifestPath(tenantContext), "utf8"));
  } catch {
    return { version: 1, routes: [] };
  }
}

function saveManifest(tenantContext, manifest) {
  writeFileSync(manifestPath(tenantContext), JSON.stringify(manifest, null, 2));
}

export function listSpaceRoutes(tenantContext) {
  const manifest = loadManifest(tenantContext);
  return {
    ok: true,
    root: spaceRoot(tenantContext),
    routes: manifest.routes || [],
  };
}

export function writeSpaceRoute(tenantContext, input = {}) {
  const routePath = normalizeRoutePath(input.path);
  const routeType = String(input.route_type || input.routeType || "api").toLowerCase();
  if (!["api", "page", "static"].includes(routeType)) {
    return { error: "route_type muss api, page oder static sein." };
  }
  const code = String(input.code ?? "");
  const isPublic = input.public !== false && input.public !== "false";

  ensureSpaceScaffold(tenantContext);
  const relFile = routeFileName(routePath, routeType);
  const fullFile = join(spaceRoot(tenantContext), relFile);
  mkdirSync(dirname(fullFile), { recursive: true });

  let content = code;
  if (routeType === "api" && !code.includes("export")) {
    content = `/** Auto-generated Nimbus Space API route: ${routePath} */
export default async function handler(c) {
${code.split("\n").map((l) => `  ${l}`).join("\n")}
}
`;
  }

  writeFileSync(fullFile, content);

  const manifest = loadManifest(tenantContext);
  const routes = manifest.routes || [];
  const idx = routes.findIndex((r) => r.path === routePath);
  const entry = {
    path: routePath,
    type: routeType,
    file: relFile.replace(/\\/g, "/"),
    public: isPublic,
    updated_at: new Date().toISOString(),
  };
  if (idx >= 0) routes[idx] = { ...routes[idx], ...entry };
  else routes.push(entry);
  manifest.routes = routes;
  saveManifest(tenantContext, manifest);

  return { ok: true, route: entry };
}

export function editSpaceRoute(tenantContext, input = {}) {
  const routePath = normalizeRoutePath(input.path);
  const manifest = loadManifest(tenantContext);
  const route = (manifest.routes || []).find((r) => r.path === routePath);
  if (!route) return { error: `Route nicht gefunden: ${routePath}` };

  const fullFile = join(spaceRoot(tenantContext), route.file);
  if (!existsSync(fullFile)) return { error: `Route-Datei fehlt: ${route.file}` };

  const edit = input.code_edit ?? input.codeEdit ?? input.code;
  if (edit === undefined || edit === null) return { error: "code_edit fehlt." };

  // Einfache Strategie: vollständiger Ersatz wenn code_edit ein kompletter Inhalt ist,
  // sonst Append mit Marker.
  const existing = readFileSync(fullFile, "utf8");
  const next = String(edit).includes("export default") || String(edit).includes("<")
    ? String(edit)
    : `${existing}\n\n// --- edit ${new Date().toISOString()} ---\n${edit}\n`;

  writeFileSync(fullFile, next);
  route.updated_at = new Date().toISOString();
  saveManifest(tenantContext, manifest);

  return { ok: true, route, bytes: Buffer.byteLength(next) };
}

export function deleteSpaceRoute(tenantContext, path) {
  const routePath = normalizeRoutePath(path);
  const manifest = loadManifest(tenantContext);
  const route = (manifest.routes || []).find((r) => r.path === routePath);
  if (!route) return { error: `Route nicht gefunden: ${routePath}` };

  const fullFile = join(spaceRoot(tenantContext), route.file);
  if (existsSync(fullFile)) rmSync(fullFile, { force: true });
  manifest.routes = (manifest.routes || []).filter((r) => r.path !== routePath);
  saveManifest(tenantContext, manifest);
  return { ok: true, deleted: routePath };
}

/**
 * Space-Substrat auf die Tenant-VM syncen und starten (via SSH).
 */
export async function deploySpaceToVm(tenantId, tenantContext) {
  const vm = getVmInstance(tenantId);
  if (!vm?.ip_address) return { ok: false, error: "VM hat noch keine IP." };

  ensureSpaceScaffold(tenantContext);
  const localRoot = spaceRoot(tenantContext);
  const remoteRoot = join(config.space.workspaceMount, config.space.substratePath).replace(/\\/g, "/");
  const user = vm.username || config.proxmox.ciUser || "nimbus";

  // Tar über SSH streamen (kein externes rsync nötig)
  const script = `
set -euo pipefail
mkdir -p ${JSON.stringify(remoteRoot)}
mkdir -p ${JSON.stringify(config.space.workspaceMount)}
cd ${JSON.stringify(remoteRoot)}
if command -v bun >/dev/null 2>&1; then
  bun install || true
else
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  bun install || true
fi
# Space-Service als systemd user unit oder nohup
pkill -f 'nimbus-space|__substrate/space/server.js' 2>/dev/null || true
nohup bun run server.js > /tmp/nimbus-space.log 2>&1 &
echo $! > /tmp/nimbus-space.pid
sleep 1
curl -sf http://127.0.0.1:${config.ingress.spacePort}/__health || true
`;

  // Erst Dateien übertragen
  const list = [];
  function walk(dir, base = "") {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = base ? `${base}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else list.push(rel);
    }
  }
  walk(localRoot);

  for (const rel of list) {
    const content = readFileSync(join(localRoot, rel));
    const b64 = content.toString("base64");
    const remoteFile = `${remoteRoot}/${rel}`.replace(/\/+/g, "/");
    const put = `
mkdir -p $(dirname ${JSON.stringify(remoteFile)})
echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(remoteFile)}
`;
    const r = await execOnVmViaSsh({ ip: vm.ip_address, username: user, command: `bash -lc ${JSON.stringify(put)}` });
    if (!r.ok) {
      return { ok: false, error: `Upload fehlgeschlagen (${rel}): ${r.stderr || r.stdout}` };
    }
  }

  const start = await execOnVmViaSsh({
    ip: vm.ip_address,
    username: user,
    command: `bash -lc ${JSON.stringify(script)}`,
  });

  return {
    ok: start.ok,
    files: list.length,
    remoteRoot,
    stdout: start.stdout,
    stderr: start.stderr,
  };
}

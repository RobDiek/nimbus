/**
 * Dynamisches PaaS / Space (Phase 3) — Control-Plane-Seite.
 *
 * Verwaltet Routen unter `<workspace>/__substrate/space/`.
 * Der Vite+React+Hono-Server in der VM (vm-image/space) lädt dieselbe Struktur.
 *
 * Route-Typen:
 *  - page   → pages/{Name}.tsx (React-Komponente, Tailwind)
 *  - api    → api/{name}.js    (Hono-Handler)
 *  - static → public/...       (statische Datei)
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync,
} from "fs";
import { join, dirname, basename } from "path";
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

function bundledSpaceRoot() {
  return join(import.meta.dir, "..", "vm-image", "space");
}

function normalizeRoutePath(path) {
  let p = String(path || "").trim();
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/+/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function pageComponentName(routePath, explicitName) {
  if (explicitName) {
    const cleaned = String(explicitName).replace(/[^a-zA-Z0-9_-]/g, "");
    if (cleaned) return cleaned[0].toUpperCase() + cleaned.slice(1);
  }
  const raw = routePath.replace(/^\//, "").replace(/\//g, "_") || "Index";
  const parts = raw.split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const name = parts.map((p) => p[0].toUpperCase() + p.slice(1)).join("") || "Index";
  return name;
}

function wrapAsReactPage(code, componentName) {
  const src = String(code || "").trim();
  if (
    src.includes("export default") ||
    /export\s+function\s+\w+/.test(src) ||
    /export\s+const\s+\w+\s*=/.test(src)
  ) {
    return src.endsWith("\n") ? src : `${src}\n`;
  }
  // Reines JSX / HTML → Default-Export-Komponente
  const body = src.startsWith("<") ? src : `<div>${src}</div>`;
  return `export default function ${componentName}() {
  return (
    <>
${body.split("\n").map((l) => `      ${l}`).join("\n")}
    </>
  );
}
`;
}

function wrapAsApiHandler(code, routePath) {
  const src = String(code || "");
  if (src.includes("export")) return src.endsWith("\n") ? src : `${src}\n`;
  return `/** Auto-generated Nimbus Space API route: ${routePath} */
export default async function handler(c) {
${src.split("\n").map((l) => `  ${l}`).join("\n")}
}
`;
}

/**
 * Kopiert das Vite/React-Substrat aus vm-image/space (ohne node_modules/dist).
 */
function syncBundledScaffold(root) {
  const bundled = bundledSpaceRoot();
  if (!existsSync(bundled)) return;

  const skip = new Set(["node_modules", "dist", ".vite"]);
  function walkCopy(srcDir, destDir) {
    mkdirSync(destDir, { recursive: true });
    for (const name of readdirSync(srcDir)) {
      if (skip.has(name)) continue;
      const src = join(srcDir, name);
      const dest = join(destDir, name);
      const st = statSync(src);
      if (st.isDirectory()) walkCopy(src, dest);
      else {
        // Bestehende User-Pages/API nicht überschreiben, außer Core-Dateien
        const isCore =
          name === "server.js" ||
          name === "package.json" ||
          name === "vite.config.js" ||
          name === "index.html" ||
          name === "nimbus-space.service" ||
          destDir.includes(`${root}/src`);
        if (!existsSync(dest) || isCore) {
          mkdirSync(dirname(dest), { recursive: true });
          writeFileSync(dest, readFileSync(src));
        }
      }
    }
  }
  walkCopy(bundled, root);
}

export function ensureSpaceScaffold(tenantContext) {
  const root = spaceRoot(tenantContext);
  mkdirSync(join(root, "pages"), { recursive: true });
  mkdirSync(join(root, "api"), { recursive: true });
  mkdirSync(join(root, "public"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  // Legacy-Ordner (ältere Routen) weiter erlauben
  mkdirSync(join(root, "routes", "api"), { recursive: true });
  mkdirSync(join(root, "routes", "page"), { recursive: true });
  mkdirSync(join(root, "routes", "static"), { recursive: true });

  syncBundledScaffold(root);

  if (!existsSync(manifestPath(tenantContext))) {
    writeFileSync(manifestPath(tenantContext), JSON.stringify({ version: 1, routes: [] }, null, 2));
  }

  return { ok: true, root };
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
  const root = spaceRoot(tenantContext);
  const pagesDir = join(root, "pages");
  const pageFiles = existsSync(pagesDir)
    ? readdirSync(pagesDir).filter((f) => /\.(jsx|tsx|js|ts)$/.test(f))
    : [];
  return {
    ok: true,
    root,
    framework: "vite+react+tailwind4",
    routes: manifest.routes || [],
    pages: pageFiles.map((f) => ({
      name: basename(f).replace(/\.(jsx|tsx|js|ts)$/, ""),
      file: `pages/${f}`,
    })),
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
  const root = spaceRoot(tenantContext);

  let relFile;
  let content = code;

  if (routeType === "page") {
    const componentName = pageComponentName(routePath, input.name);
    relFile = `pages/${componentName}.tsx`;
    content = wrapAsReactPage(code, componentName);
  } else if (routeType === "api") {
    const apiName =
      (input.name || routePath.replace(/^\/api\//, "") || "handler")
        .replace(/[^a-zA-Z0-9_-]/g, "") || "handler";
    relFile = `api/${apiName}.js`;
    content = wrapAsApiHandler(code, routePath);
  } else {
    // static
    const safe =
      routePath.replace(/^\//, "").replace(/\//g, "__").replace(/[^a-zA-Z0-9._-]/g, "_") ||
      "index.txt";
    relFile = `public/${safe}`;
    content = code;
  }

  const fullFile = join(root, relFile);
  mkdirSync(dirname(fullFile), { recursive: true });
  writeFileSync(fullFile, content);

  const manifest = loadManifest(tenantContext);
  const routes = manifest.routes || [];
  const idx = routes.findIndex((r) => r.path === routePath);
  const entry = {
    path: routePath,
    type: routeType,
    file: relFile.replace(/\\/g, "/"),
    name: routeType === "page" ? pageComponentName(routePath, input.name) : (input.name || routePath),
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

  const existing = readFileSync(fullFile, "utf8");
  let next;
  if (route.type === "page") {
    const name = route.name || pageComponentName(routePath);
    next =
      String(edit).includes("export default") || String(edit).includes("export function")
        ? String(edit)
        : wrapAsReactPage(String(edit), name);
  } else {
    next =
      String(edit).includes("export default") || String(edit).includes("<")
        ? String(edit)
        : `${existing}\n\n// --- edit ${new Date().toISOString()} ---\n${edit}\n`;
  }

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

  const script = `
set -euo pipefail
mkdir -p ${JSON.stringify(remoteRoot)}
mkdir -p ${JSON.stringify(config.space.workspaceMount)}
cd ${JSON.stringify(remoteRoot)}
export PATH="$HOME/.bun/bin:$PATH"
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi
bun install
sudo systemctl restart nimbus-space 2>/dev/null || {
  pkill -f 'nimbus-space|__substrate/space/server.js' 2>/dev/null || true
  nohup bun run server.js > /tmp/nimbus-space.log 2>&1 &
  echo $! > /tmp/nimbus-space.pid
}
sleep 2
curl -sf http://127.0.0.1:${config.ingress.spacePort}/__health || true
`;

  const list = [];
  function walk(dir, base = "") {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist" || name === ".vite") continue;
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

/**
 * Space-Service in der Tenant-VM neu starten (systemd / Fallback nohup).
 * Nur Control Plane — kein Agent-Tool. UI zeigt keine Infra-Details.
 */
export async function restartSpaceOnVm(tenantId) {
  const vm = getVmInstance(tenantId);
  if (!vm?.ip_address) return { ok: false, error: "Workspace noch nicht bereit." };
  const user = vm.username || config.proxmox.ciUser || "ubuntu";
  const remoteRoot = join(config.space.workspaceMount, config.space.substratePath).replace(/\\/g, "/");
  const script = `
set -euo pipefail
export PATH="$HOME/.bun/bin:/usr/local/bin:$PATH"
if systemctl list-unit-files 2>/dev/null | grep -q '^nimbus-space'; then
  sudo systemctl restart nimbus-space
  sleep 1
  systemctl is-active nimbus-space || true
else
  pkill -f '__substrate/space/server.js' 2>/dev/null || true
  cd ${JSON.stringify(remoteRoot)}
  nohup bun run server.js > /tmp/nimbus-space.log 2>&1 &
  echo restarted
fi
curl -sf http://127.0.0.1:${config.ingress.spacePort}/__health >/dev/null && echo healthy || echo started
`;
  const r = await execOnVmViaSsh({
    ip: vm.ip_address,
    username: user,
    command: `bash -lc ${JSON.stringify(script)}`,
  });
  if (!r.ok) {
    return { ok: false, error: "Space-Server konnte nicht neu gestartet werden." };
  }
  return { ok: true };
}

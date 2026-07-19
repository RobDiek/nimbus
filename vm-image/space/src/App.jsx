import { useEffect, useMemo, useState } from "react";

/**
 * Dynamischer Page-Router:
 * - lädt /__routes
 * - mappt pathname → pages/*.tsx via import.meta.glob
 * - Live-Reload über Vite HMR
 */
const pageModules = import.meta.glob("../pages/**/*.{jsx,tsx,js,ts}");

function normalize(path) {
  let p = path || "/";
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p || "/";
}

function componentKeyFromFile(file) {
  // routes/page/foo__bar.tsx OR pages/Hello.tsx
  return String(file || "")
    .replace(/^.*\//, "")
    .replace(/\.(jsx|tsx|js|ts)$/, "");
}

export default function App() {
  const [routes, setRoutes] = useState([]);
  const [Comp, setComp] = useState(null);
  const [error, setError] = useState("");
  const path = normalize(window.location.pathname);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/__routes");
        const data = await res.json();
        if (cancelled) return;
        const fromManifest = (data.routes || []).filter((r) => r.type === "page");
        const fromFs = (data.pages || []).map((p) => ({
          path: p.path,
          type: "page",
          name: p.name,
          file: p.file || `pages/${p.name}.tsx`,
        }));
        // Manifest hat Vorrang; fehlende Pages aus dem Dateisystem nachziehen
        const byPath = new Map();
        for (const p of fromFs) byPath.set(normalize(p.path), p);
        for (const p of fromManifest) byPath.set(normalize(p.path), p);
        setRoutes([...byPath.values()]);
      } catch (err) {
        if (!cancelled) setError(String(err?.message || err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const match = useMemo(() => {
    const pages = (routes || []).filter((r) => r.type === "page");
    return pages.find((r) => normalize(r.path) === path) || null;
  }, [routes, path]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setComp(null);
      setError("");
      if (!match) return;

      // Prefer pages/<Name>.tsx matching file basename or route path
      const want = componentKeyFromFile(match.file || match.component || match.path);
      const entries = Object.entries(pageModules);
      let hit = entries.find(([k]) => componentKeyFromFile(k) === want);
      if (!hit) {
        // fallback: path segments joined
        const alt = path.replace(/^\//, "").replace(/\//g, "__") || "index";
        hit = entries.find(([k]) => componentKeyFromFile(k) === alt);
      }
      if (!hit) {
        setError(`Keine React-Page gefunden für ${path} (gesucht: ${want}). Datei unter pages/ anlegen.`);
        return;
      }
      try {
        const mod = await hit[1]();
        if (!cancelled) setComp(() => mod.default || mod.Page);
      } catch (err) {
        if (!cancelled) setError(String(err?.message || err));
      }
    })();
    return () => { cancelled = true; };
  }, [match, path]);

  if (error) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold text-rose-300">Space-Fehler</h1>
        <p className="mt-3 font-mono text-sm text-slate-300">{error}</p>
      </div>
    );
  }

  if (!match && path === "/") {
    return (
      <div className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center gap-4 p-8">
        <p className="text-sm uppercase tracking-[0.2em] text-cyan-400">Nimbus Space</p>
        <h1 className="text-4xl font-semibold">React · Tailwind 4 · Vite</h1>
        <p className="text-slate-400">
          Noch keine Root-Page. Lege eine an mit <code className="text-cyan-300">write_space_route</code>
          {" "}(route_type=page) oder öffne <a className="underline" href="/__routes">/__routes</a>.
        </p>
      </div>
    );
  }

  if (!match) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <h1 className="text-2xl font-semibold">404</h1>
        <p className="mt-2 text-slate-400">Keine Page-Route für <code>{path}</code>.</p>
      </div>
    );
  }

  if (!Comp) {
    return (
      <div className="grid min-h-screen place-items-center text-slate-400">
        Lade Page …
      </div>
    );
  }

  return <Comp route={match} />;
}

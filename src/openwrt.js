/**
 * OpenWRT Portforward-Adapter (ubus über WAN LuCI HTTPS).
 * LAN: 10.10.0.0/24 hinter vmbr1 — VMs bekommen DNAT auf WAN-IP.
 *
 * Schema für Host 10.10.0.N:
 *   SSH   10000+N → N:22
 *   Space 11000+N → N:3000
 *   Agent 12000+N → N:8100
 */
import { config } from "./config.js";
import { logger } from "./logger.js";

function wanBase() {
  return `https://${config.ingress.wanIp}:8443`;
}

async function ubus(session, object, method, params = {}) {
  const res = await fetch(`${wanBase()}/ubus`, {
    method: "POST",
    tls: { rejectUnauthorized: false },
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "call",
      params: [session, object, method, params],
    }),
  });
  const data = await res.json();
  if (!Array.isArray(data.result) || data.result[0] !== 0) {
    throw new Error(`ubus ${object}.${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result[1];
}

async function login() {
  const pass = config.ingress.openwrt.password;
  if (!pass) throw new Error("OPENWRT_PASS fehlt.");
  const res = await fetch(`${wanBase()}/ubus`, {
    method: "POST",
    tls: { rejectUnauthorized: false },
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "call",
      params: ["00000000000000000000000000000000", "session", "login", {
        username: "root",
        password: pass,
      }],
    }),
  });
  const data = await res.json();
  const session = data?.result?.[1]?.ubus_rpc_session;
  if (!session) throw new Error(`OpenWRT login fehlgeschlagen: ${JSON.stringify(data)}`);
  return session;
}

export function portsForLanIp(lanIp) {
  const m = String(lanIp || "").match(/^10\.10\.0\.(\d+)$/);
  if (!m) return null;
  const n = Number(m[1]);
  const wan = config.ingress.wanIp;
  return {
    lanIp,
    wanIp: wan,
    ssh: { public: 10000 + n, dest: 22 },
    space: { public: 11000 + n, dest: config.ingress.spacePort },
    agent: { public: 12000 + n, dest: config.ingress.agentPort },
  };
}

async function listRedirects(session) {
  const values = await ubus(session, "uci", "get", { config: "firewall" });
  const valuesMap = values?.values || {};
  const redirects = [];
  for (const [key, val] of Object.entries(valuesMap)) {
    if (val?.[".type"] === "redirect") {
      redirects.push({ key, ...val });
    }
  }
  return redirects;
}

async function deleteRedirectByName(session, name) {
  const all = await listRedirects(session);
  for (const r of all) {
    if (r.name === name) {
      await ubus(session, "uci", "delete", { config: "firewall", section: r[".name"] || r.key });
    }
  }
}

async function addRedirect(session, { name, srcPort, destIp, destPort }) {
  await deleteRedirectByName(session, name);
  const added = await ubus(session, "uci", "add", { config: "firewall", type: "redirect" });
  const section = added?.section;
  if (!section) throw new Error("uci add redirect lieferte keine section");
  const values = {
    name,
    target: "DNAT",
    src: "wan",
    dest: "lan",
    proto: "tcp",
    src_dport: String(srcPort),
    dest_ip: destIp,
    dest_port: String(destPort),
  };
  for (const [k, v] of Object.entries(values)) {
    await ubus(session, "uci", "set", { config: "firewall", section, values: { [k]: v } });
  }
}

/**
 * Stellt SSH/Space/Agent-Portforwards für eine LAN-IP sicher.
 */
export async function ensureOpenwrtForwards({ lanIp, slug }) {
  if (!config.ingress.openwrt.enabled) {
    return { ok: true, skipped: true, reason: "OPENWRT_ENABLED=false" };
  }
  if (!config.ingress.openwrt.password) {
    return { ok: true, dryRun: true, reason: "OPENWRT_PASS fehlt" };
  }
  const ports = portsForLanIp(lanIp);
  if (!ports) throw new Error(`LAN-IP nicht im 10.10.0.0/24 Pool: ${lanIp}`);

  const session = await login();
  const label = (slug || lanIp).toString().replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 32);
  await addRedirect(session, {
    name: `nimbus-${label}-ssh`,
    srcPort: ports.ssh.public,
    destIp: lanIp,
    destPort: ports.ssh.dest,
  });
  await addRedirect(session, {
    name: `nimbus-${label}-space`,
    srcPort: ports.space.public,
    destIp: lanIp,
    destPort: ports.space.dest,
  });
  await addRedirect(session, {
    name: `nimbus-${label}-agent`,
    srcPort: ports.agent.public,
    destIp: lanIp,
    destPort: ports.agent.dest,
  });
  await ubus(session, "uci", "commit", { config: "firewall" });
  try {
    await ubus(session, "file", "exec", {
      command: "/etc/init.d/firewall",
      params: ["reload"],
    });
  } catch (err) {
    logger.warn("openwrt_firewall_reload_soft", { error: String(err?.message || err) });
  }

  const result = {
    ok: true,
    lanIp,
    wanIp: ports.wanIp,
    forwards: {
      ssh: `${ports.wanIp}:${ports.ssh.public} → ${lanIp}:22`,
      space: `${ports.wanIp}:${ports.space.public} → ${lanIp}:${ports.space.dest}`,
      agent: `${ports.wanIp}:${ports.agent.public} → ${lanIp}:${ports.agent.dest}`,
    },
  };
  logger.info("openwrt_forwards_ensured", result);
  return result;
}

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { config, sanitizeTenantSlug, publicHostnameForTenant } from "./config.js";
import { logger } from "./logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function ensureConfigured() {
  const p = config.proxmox;
  if (!p?.enabled) throw new Error("Proxmox integration is disabled (PROXMOX_ENABLED=false).");
  if (!p.baseUrl) throw new Error("Missing PROXMOX_BASE_URL.");
  if (!p.tokenId || !p.tokenSecret) throw new Error("Missing PROXMOX_TOKEN_ID / PROXMOX_TOKEN_SECRET.");
  if (!p.node) throw new Error("Missing PROXMOX_NODE.");
  if (!p.templateVmid) throw new Error("Missing PROXMOX_TEMPLATE_VMID.");
}

function authHeader() {
  const p = config.proxmox;
  return `PVEAPIToken=${p.tokenId}=${p.tokenSecret}`;
}

async function proxmoxRequest(path, init = {}) {
  ensureConfigured();
  const url = `${config.proxmox.baseUrl.replace(/\/+$/, "")}${path}`;
  const res = await fetch(url, {
    ...init,
    tls: { rejectUnauthorized: false },
    headers: {
      Authorization: authHeader(),
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let parsed = {};
  try { parsed = text ? JSON.parse(text) : {}; } catch {}

  if (!res.ok) {
    const msg = parsed?.errors ? JSON.stringify(parsed.errors) : (parsed?.message || text || `HTTP ${res.status}`);
    throw new Error(`Proxmox request failed (${res.status}) ${path}: ${msg}`);
  }

  return parsed?.data ?? parsed;
}

function encodeForm(data = {}) {
  return Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
}

export async function getClusterResources(type = "vm") {
  return proxmoxRequest(`/api2/json/cluster/resources?type=${encodeURIComponent(type)}`);
}

export async function getVmStatus(vmid) {
  return proxmoxRequest(`/api2/json/nodes/${encodeURIComponent(config.proxmox.node)}/qemu/${encodeURIComponent(vmid)}/status/current`);
}

export async function startVm(vmid) {
  return proxmoxRequest(
    `/api2/json/nodes/${encodeURIComponent(config.proxmox.node)}/qemu/${encodeURIComponent(vmid)}/status/start`,
    { method: "POST" }
  );
}

export async function stopVm(vmid) {
  return proxmoxRequest(
    `/api2/json/nodes/${encodeURIComponent(config.proxmox.node)}/qemu/${encodeURIComponent(vmid)}/status/stop`,
    { method: "POST" }
  );
}

export async function allocNextVmid() {
  const data = await proxmoxRequest("/api2/json/cluster/nextid");
  const next = Number(data);
  if (Number.isFinite(next) && next > 0) return next;
  return config.proxmox.vmidStart;
}

/** Liest Template-Metadaten (Sanity-Check für Golden Image 9000). */
export async function getTemplateInfo(templateVmid = config.proxmox.templateVmid) {
  const vmid = Number(templateVmid);
  const cfg = await proxmoxRequest(
    `/api2/json/nodes/${encodeURIComponent(config.proxmox.node)}/qemu/${encodeURIComponent(vmid)}/config`
  );
  return {
    vmid,
    name: cfg?.name || "",
    cores: cfg?.cores,
    memory: cfg?.memory,
    template: cfg?.template === 1 || cfg?.template === "1",
    raw: cfg,
  };
}

export async function cloneTenantVm(tenantId, vmidOverride) {
  const p = config.proxmox;
  const vmid = Number(vmidOverride) || await allocNextVmid();
  const tenant = sanitizeTenantSlug(tenantId);
  const name = `nimbus-${tenant}`;

  const body = encodeForm({
    newid: vmid,
    name,
    full: 1,
    target: p.node,
    storage: p.storage,
  });

  await proxmoxRequest(
    `/api2/json/nodes/${encodeURIComponent(p.node)}/qemu/${encodeURIComponent(p.templateVmid)}/clone`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }
  );

  return { vmid, name, node: p.node, templateVmid: p.templateVmid, tenant };
}

/**
 * Cloud-Init: User, SSH, Netz + Hostname (für DNS/Ingress).
 * Hostname = Tenant-Slug; FQDN = <slug>.nimbus.diekerit.com
 */
export async function configureTenantCloudInit(vmid, tenantId, username = config.proxmox.ciUser || "ubuntu", ipconfigOverride) {
  const p = config.proxmox;
  const slug = sanitizeTenantSlug(tenantId);
  const fqdn = publicHostnameForTenant(tenantId);
  const resolved = ipconfigOverride || await resolveIpConfig();

  const body = encodeForm({
    ciuser: username,
    cipassword: p.ciPassword || undefined,
    sshkeys: p.ciSshPublicKey || undefined,
    ipconfig0: resolved.ipconfig,
    nameserver: p.nameserver || undefined,
    searchdomain: p.searchdomain || undefined,
    description: `Nimbus workspace for ${slug} (${fqdn})`,
  });

  if (body) {
    await proxmoxRequest(
      `/api2/json/nodes/${encodeURIComponent(p.node)}/qemu/${encodeURIComponent(vmid)}/config`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }
    );
  }

  await applyVmResources(vmid, {
    name: slug,
    cores: p.cpuCores,
    memory: p.memoryMb,
  });

  return { ok: true, hostname: slug, fqdn, lanIp: resolved.lanIp, ipconfig: resolved.ipconfig };
}

export async function applyVmResources(vmid, { name, cores, memory } = {}) {
  const p = config.proxmox;
  const body = encodeForm({
    name: name || undefined,
    cores: cores ?? p.cpuCores,
    memory: memory ?? p.memoryMb,
    net0: `virtio,bridge=${p.bridge}`,
  });

  await proxmoxRequest(
    `/api2/json/nodes/${encodeURIComponent(p.node)}/qemu/${encodeURIComponent(vmid)}/config`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }
  );
  return { ok: true };
}

export async function resizeVmDisk(vmid, disk = "scsi0", sizeGb = config.proxmox.diskGb) {
  const body = encodeForm({ disk, size: `${Number(sizeGb)}G` });
  await proxmoxRequest(
    `/api2/json/nodes/${encodeURIComponent(config.proxmox.node)}/qemu/${encodeURIComponent(vmid)}/resize`,
    {
      method: "PUT",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    }
  );
  return { ok: true, disk, sizeGb };
}

/** Nächste freie LAN-IP aus dem Pool. */
export async function allocateLanIp() {
  const start = config.proxmox.lanPoolStart;
  const end = config.proxmox.lanPoolEnd;
  const used = new Set(["10.10.0.1", "10.10.0.109", "10.10.0.200"]);

  try {
    const { listVmInstances } = await import("./db.js");
    for (const row of listVmInstances()) {
      if (row.ip_address) used.add(row.ip_address);
      try {
        const meta = typeof row.metadata === "string" ? JSON.parse(row.metadata || "{}") : (row.metadata || {});
        if (meta.lan_ip) used.add(meta.lan_ip);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }

  for (let n = start; n <= end; n++) {
    const cand = `10.10.0.${n}`;
    if (!used.has(cand)) return cand;
  }
  throw new Error(`Kein freier LAN-IP im Pool 10.10.0.${start}-${end}`);
}

export async function resolveIpConfig() {
  const raw = (config.proxmox.ipConfig || "auto").trim();
  if (!raw || raw === "auto") {
    const ip = await allocateLanIp();
    return {
      ipconfig: `ip=${ip}/24,gw=${config.proxmox.lanGateway}`,
      lanIp: ip,
    };
  }
  if (raw === "ip=dhcp" || raw === "dhcp") {
    return { ipconfig: "ip=dhcp", lanIp: "" };
  }
  const m = raw.match(/ip=([0-9.]+)/);
  return { ipconfig: raw, lanIp: m?.[1] || "" };
}

export async function waitForVmRunning(vmid, timeoutMs = 120000, intervalMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const status = await getVmStatus(vmid);
    if (status?.status === "running") return status;
    await sleep(intervalMs);
  }
  throw new Error(`VM ${vmid} did not reach running state in time.`);
}

export async function getVmIpBestEffort(vmid) {
  try {
    const data = await proxmoxRequest(
      `/api2/json/nodes/${encodeURIComponent(config.proxmox.node)}/qemu/${encodeURIComponent(vmid)}/agent/network-get-interfaces`
    );
    const ifaces = Array.isArray(data?.result) ? data.result : [];
    for (const iface of ifaces) {
      const ips = iface?.["ip-addresses"] || [];
      for (const ip of ips) {
        const addr = ip?.["ip-address"];
        if (addr && !addr.startsWith("127.") && !addr.includes(":")) return addr;
      }
    }
  } catch (err) {
    logger.warn("proxmox_ip_lookup_failed", { vmid, error: String(err?.message || err) });
  }
  return "";
}

/** Wartet aktiv, bis qemu-guest-agent eine IPv4 liefert. */
export async function waitForVmIp(vmid, timeoutMs = config.proxmox.ipWaitTimeoutMs, intervalMs = config.proxmox.ipWaitIntervalMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ip = await getVmIpBestEffort(vmid);
    if (ip) return ip;
    await sleep(intervalMs);
  }
  return "";
}

export async function ensureTenantVm({ tenantId, existingVmid }) {
  const tenant = sanitizeTenantSlug(tenantId);
  const fqdn = publicHostnameForTenant(tenantId);

  try {
    const tpl = await getTemplateInfo(config.proxmox.templateVmid);
    logger.info("proxmox_template_ok", {
      vmid: tpl.vmid,
      name: tpl.name,
      template: tpl.template,
    });
  } catch (err) {
    logger.warn("proxmox_template_check_failed", { error: String(err?.message || err) });
  }

  const resolved = await resolveIpConfig();
  const clone = await cloneTenantVm(tenant, existingVmid);

  try {
    await resizeVmDisk(clone.vmid, "scsi0", config.proxmox.diskGb);
  } catch (err) {
    logger.warn("proxmox_resize_soft", { vmid: clone.vmid, error: String(err?.message || err) });
  }

  await configureTenantCloudInit(
    clone.vmid,
    tenantId,
    config.proxmox.ciUser || "ubuntu",
    resolved
  );
  await startVm(clone.vmid);
  await waitForVmRunning(clone.vmid, 180000, 4000);

  let ip = resolved.lanIp || "";
  if (!ip) ip = await waitForVmIp(clone.vmid);
  else await waitForVmIp(clone.vmid, 90000, 3000);

  return {
    provider: "proxmox",
    node: clone.node,
    vmid: clone.vmid,
    template_vmid: clone.templateVmid,
    ip_address: ip || resolved.lanIp || "",
    username: config.proxmox.ciUser || "ubuntu",
    cpu_cores: config.proxmox.cpuCores,
    memory_mb: config.proxmox.memoryMb,
    disk_gb: config.proxmox.diskGb,
    metadata: {
      vm_name: clone.name,
      hostname: tenant,
      public_hostname: fqdn,
      lan_ip: ip || resolved.lanIp || "",
      ipconfig: resolved.ipconfig,
      proxmox_base: config.proxmox.baseUrl,
      bridged_network: config.proxmox.bridge,
      space_port: config.ingress.spacePort,
      agent_port: config.ingress.agentPort,
    },
  };
}

export function createVmSshPty({ ip, username }) {
  if (!ip) throw new Error("VM has no known IP address yet.");

  const sshArgs = [
    "-tt",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", `ConnectTimeout=${config.proxmox.sshConnectTimeoutSec}`,
    `${username || "nimbus"}@${ip}`,
  ];

  return Bun.spawn(["ssh", ...sshArgs], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
  });
}

export async function execOnVmViaSsh({ ip, username, command }) {
  if (!ip) return { ok: false, error: "VM has no known IP address yet." };

  const sshArgs = [
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", `ConnectTimeout=${config.proxmox.sshConnectTimeoutSec}`,
    `${username || "nimbus"}@${ip}`,
    command,
  ];

  const proc = Bun.spawn(["ssh", ...sshArgs], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });

  const [outText, errText, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return {
    ok: code === 0,
    code,
    stdout: outText || "",
    stderr: errText || "",
  };
}

function loadBootstrapScript() {
  const p = join(import.meta.dir, "..", "vm-image", "bootstrap.sh");
  if (existsSync(p)) return readFileSync(p, "utf8");
  return null;
}

/**
 * Basis-Pakete + Agent-/Space-Substrat auf der VM installieren.
 * Der Orchestrator ruft das nach dem Boot auf — nicht der Agent.
 */
export async function applyVmBootstrap({ ip, username, tenantId }) {
  if (!ip) throw new Error("Cannot bootstrap VM without IP.");
  const user = username || config.proxmox.ciUser || "nimbus";
  const slug = sanitizeTenantSlug(tenantId || "default");
  const fqdn = publicHostnameForTenant(tenantId || "default");
  const bundled = loadBootstrapScript();

  const script = bundled || `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
HOSTNAME_SLUG=${JSON.stringify(slug)}
FQDN=${JSON.stringify(fqdn)}
WORKSPACE=${JSON.stringify(config.space.workspaceMount)}
AGENT_DIR=${JSON.stringify(config.agentVm.installPath)}
SPACE_PORT=${JSON.stringify(String(config.ingress.spacePort))}
AGENT_PORT=${JSON.stringify(String(config.ingress.agentPort))}

if command -v hostnamectl >/dev/null 2>&1; then
  sudo hostnamectl set-hostname "$HOSTNAME_SLUG" || true
fi
echo "$HOSTNAME_SLUG" | sudo tee /etc/hostname >/dev/null || true

if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y \\
    bash-completion git curl wget htop tmux build-essential python3 python3-pip python3-venv \\
    ripgrep fd-find unzip zip jq ca-certificates gnupg lsb-release
fi

sudo mkdir -p "$WORKSPACE" "$AGENT_DIR"
sudo chown -R "$USER":"$USER" "$WORKSPACE" "$AGENT_DIR" || true

# Bun für Space-Substrat
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
fi

mkdir -p "$WORKSPACE/__substrate/space"
echo "Nimbus VM ready host=$HOSTNAME_SLUG fqdn=$FQDN" > /tmp/nimbus-ready.txt
`;

  // Env in gebündeltes Script injizieren
  const wrapped = bundled
    ? `export NIMBUS_HOSTNAME=${JSON.stringify(slug)}
export NIMBUS_FQDN=${JSON.stringify(fqdn)}
export NIMBUS_WORKSPACE=${JSON.stringify(config.space.workspaceMount)}
export NIMBUS_AGENT_DIR=${JSON.stringify(config.agentVm.installPath)}
export NIMBUS_SPACE_PORT=${JSON.stringify(String(config.ingress.spacePort))}
export NIMBUS_AGENT_PORT=${JSON.stringify(String(config.ingress.agentPort))}
${bundled}`
    : script;

  return execOnVmViaSsh({ ip, username: user, command: `bash -lc ${JSON.stringify(wrapped)}` });
}

/**
 * Agent-Dateien (vm-image/agent) per SSH auf die VM legen.
 */
export async function deployAgentToVm({ ip, username }) {
  if (!ip) return { ok: false, error: "No IP" };
  const user = username || config.proxmox.ciUser || "nimbus";
  const localAgent = join(import.meta.dir, "..", "vm-image", "agent");
  if (!existsSync(localAgent)) return { ok: false, error: "vm-image/agent missing" };

  const remote = config.agentVm.installPath;
  const { readdirSync, statSync } = await import("fs");

  const files = [];
  function walk(dir, base = "") {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const rel = base ? `${base}/${name}` : name;
      if (statSync(full).isDirectory()) walk(full, rel);
      else files.push(rel);
    }
  }
  walk(localAgent);

  await execOnVmViaSsh({
    ip,
    username: user,
    command: `bash -lc ${JSON.stringify(`mkdir -p ${remote}`)}`,
  });

  for (const rel of files) {
    const b64 = readFileSync(join(localAgent, rel)).toString("base64");
    const remoteFile = `${remote}/${rel}`;
    const put = `mkdir -p $(dirname ${JSON.stringify(remoteFile)}) && echo ${JSON.stringify(b64)} | base64 -d > ${JSON.stringify(remoteFile)}`;
    const r = await execOnVmViaSsh({ ip, username: user, command: `bash -lc ${JSON.stringify(put)}` });
    if (!r.ok) return { ok: false, error: `agent upload failed: ${rel}`, stderr: r.stderr };
  }

  const install = `
set -euo pipefail
cd ${JSON.stringify(remote)}
python3 -m venv .venv || true
. .venv/bin/activate
pip install -U pip
pip install -r requirements.txt || pip install pydantic-ai playwright httpx
# Playwright browser optional
python -m playwright install chromium || true
nohup .venv/bin/python -m nimbus_agent.main > /tmp/nimbus-agent.log 2>&1 &
echo $! > /tmp/nimbus-agent.pid
`;
  const r = await execOnVmViaSsh({ ip, username: user, command: `bash -lc ${JSON.stringify(install)}` });
  return { ok: r.ok, files: files.length, stdout: r.stdout, stderr: r.stderr };
}

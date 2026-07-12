import { config } from "./config.js";
import { logger } from "./logger.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeTenant(tenantId) {
  const t = (tenantId || "default").toString().trim().toLowerCase();
  return t.replace(/[^a-z0-9-_]/g, "-").slice(0, 40) || "default";
}

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

export async function cloneTenantVm(tenantId, vmidOverride) {
  const p = config.proxmox;
  const vmid = Number(vmidOverride) || await allocNextVmid();
  const tenant = sanitizeTenant(tenantId);
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

  return { vmid, name, node: p.node, templateVmid: p.templateVmid };
}

export async function configureTenantCloudInit(vmid, username = config.proxmox.ciUser || "nimbus") {
  const p = config.proxmox;
  const body = encodeForm({
    ciuser: username,
    cipassword: p.ciPassword || undefined,
    sshkeys: p.ciSshPublicKey || undefined,
    ipconfig0: p.ipConfig || "ip=dhcp",
    nameserver: p.nameserver || undefined,
    searchdomain: p.searchdomain || undefined,
  });

  if (!body) return { ok: true, skipped: true };

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

export async function ensureTenantVm({ tenantId, existingVmid }) {
  const tenant = sanitizeTenant(tenantId);
  const clone = await cloneTenantVm(tenant, existingVmid);
  await configureTenantCloudInit(clone.vmid, config.proxmox.ciUser || "nimbus");
  await startVm(clone.vmid);
  await waitForVmRunning(clone.vmid, 180000, 4000);
  const ip = await getVmIpBestEffort(clone.vmid);

  return {
    provider: "proxmox",
    node: clone.node,
    vmid: clone.vmid,
    template_vmid: clone.templateVmid,
    ip_address: ip || "",
    username: config.proxmox.ciUser || "nimbus",
    metadata: {
      vm_name: clone.name,
      proxmox_base: config.proxmox.baseUrl,
      bridged_network: config.proxmox.bridge,
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

export async function applyVmBootstrap({ ip, username }) {
  if (!ip) throw new Error("Cannot bootstrap VM without IP.");
  const user = username || config.proxmox.ciUser || "nimbus";

  const script = `
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
if command -v apt-get >/dev/null 2>&1; then
  sudo apt-get update -y
  sudo apt-get install -y \
    bash-completion git curl wget htop tmux build-essential python3 python3-pip \
    ripgrep fd-find unzip zip jq ca-certificates gnupg lsb-release
fi
mkdir -p ~/.config
touch ~/.bashrc
grep -q "alias ll='ls -la'" ~/.bashrc || echo "alias ll='ls -la'" >> ~/.bashrc
grep -q "set -o vi" ~/.bashrc || echo "set -o vi" >> ~/.bashrc
echo "Nimbus VM ready for ${user}" > /tmp/nimbus-ready.txt
`;

  return execOnVmViaSsh({ ip, username: user, command: `bash -lc ${JSON.stringify(script)}` });
}

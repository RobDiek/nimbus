const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toBool = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).toLowerCase() === "true" || value === "1";
};

/** Sanitized tenant slug for hostnames / DNS labels. */
export function sanitizeTenantSlug(tenantId) {
  const t = (tenantId || "default").toString().trim().toLowerCase();
  return t.replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "default";
}

export function publicHostnameForTenant(tenantId, domain = config.ingress.baseDomain) {
  const slug = sanitizeTenantSlug(tenantId);
  return `${slug}.${domain}`;
}

export const config = {
  port: toNumber(process.env.PORT, 4000),
  defaultProvider: "anthropic",
  maxTurns: 25,
  httpTimeoutMs: toNumber(process.env.HTTP_TIMEOUT_MS, 30000),
  toolTimeoutMs: toNumber(process.env.TOOL_TIMEOUT_MS, 120000),

  proxmox: {
    enabled: toBool(process.env.PROXMOX_ENABLED, false),
    // Default: DiekerIT Proxmox host (überschreibbar per Env)
    baseUrl: (process.env.PROXMOX_BASE_URL || "https://45.84.197.121:8006").trim(),
    tokenId: (process.env.PROXMOX_TOKEN_ID || "").trim(),
    tokenSecret: (process.env.PROXMOX_TOKEN_SECRET || "").trim(),
    node: (process.env.PROXMOX_NODE || "").trim(),
    storage: (process.env.PROXMOX_STORAGE || "local").trim(),
    bridge: (process.env.PROXMOX_BRIDGE || "vmbr1").trim(),
    // Golden Image / Ubuntu Template
    // Nimbus Golden Image (Agent+Space) — 9000 bleibt unberührtes Ubuntu-Cloud-Template
    templateVmid: toNumber(process.env.PROXMOX_TEMPLATE_VMID, 9001),
    vmidStart: toNumber(process.env.PROXMOX_VMID_START, 5000),
    cpuCores: toNumber(process.env.PROXMOX_VM_CORES, 2),
    memoryMb: toNumber(process.env.PROXMOX_VM_MEMORY_MB, 4096),
    diskGb: toNumber(process.env.PROXMOX_VM_DISK_GB, 32),
    ciUser: (process.env.PROXMOX_CI_USER || "ubuntu").trim(),
    ciSshPublicKey: (process.env.PROXMOX_CI_SSH_PUBLIC_KEY || "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIK3dIaMkaR8OYgz9QIzNxhR4h9zkm98IVQVSem4DTF/q DiekerIT SSH Key").trim(),
    ciPassword: (process.env.PROXMOX_CI_PASSWORD || "").trim(),
    // auto = nächste freie 10.10.0.200-249
    ipConfig: (process.env.PROXMOX_IPCONFIG || "auto").trim(),
    nameserver: (process.env.PROXMOX_NAMESERVER || "1.1.1.1").trim(),
    searchdomain: (process.env.PROXMOX_SEARCHDOMAIN || "nimbus.diekerit.com").trim(),
    sshConnectTimeoutSec: toNumber(process.env.PROXMOX_SSH_CONNECT_TIMEOUT_SEC, 5),
    // Wartezeit bis qemu-guest-agent eine IP liefert
    ipWaitTimeoutMs: toNumber(process.env.PROXMOX_IP_WAIT_TIMEOUT_MS, 180000),
    ipWaitIntervalMs: toNumber(process.env.PROXMOX_IP_WAIT_INTERVAL_MS, 4000),
    lanCidr: (process.env.NIMBUS_LAN_CIDR || "10.10.0.0/24").trim(),
    lanGateway: (process.env.NIMBUS_LAN_GW || "10.10.0.1").trim(),
    lanPoolStart: toNumber(process.env.NIMBUS_LAN_POOL_START, 200),
    lanPoolEnd: toNumber(process.env.NIMBUS_LAN_POOL_END, 249),
  },

  ingress: {
    enabled: toBool(process.env.ZORAXY_ENABLED, false),
    // Standard-Domain für Agent-VMs: <slug>.nimbus.diekerit.com
    baseDomain: (process.env.NIMBUS_BASE_DOMAIN || "nimbus.diekerit.com").trim(),
    spacePort: toNumber(process.env.NIMBUS_SPACE_PORT, 3000),
    agentPort: toNumber(process.env.NIMBUS_AGENT_PORT, 8100),
    // OpenWRT WAN — Portforwards statt direkter Public-IP auf VMs
    wanIp: (process.env.OPENWRT_WAN_IP || "45.84.197.154").trim(),
    openwrt: {
      enabled: toBool(process.env.OPENWRT_ENABLED, true),
      lanGateway: (process.env.NIMBUS_LAN_GW || "10.10.0.1").trim(),
      // Passwort nur per Env — niemals committen
      password: (process.env.OPENWRT_PASS || "").trim(),
    },
    cloudflare: {
      apiToken: (process.env.CLOUDFLARE_API_TOKEN || "").trim(),
      zoneId: (process.env.CLOUDFLARE_ZONE_ID || "").trim(),
      zoneName: (process.env.CLOUDFLARE_ZONE_NAME || "diekerit.com").trim(),
      // DNS-only (false): nötig für Non-Standard-Ports / OpenWRT-DNAT
      proxied: toBool(process.env.CLOUDFLARE_PROXIED, false),
    },
    zoraxy: {
      baseUrl: (process.env.ZORAXY_BASE_URL || "").trim(),
      // Session-Cookie oder API-Token (je nach Zoraxy-Setup)
      apiToken: (process.env.ZORAXY_API_TOKEN || "").trim(),
      username: (process.env.ZORAXY_USERNAME || "").trim(),
      password: (process.env.ZORAXY_PASSWORD || "").trim(),
      // Optional: Config-Dateien statt HTTP-API schreiben
      configDir: (process.env.ZORAXY_CONFIG_DIR || "").trim(),
      addPath: (process.env.ZORAXY_ADD_PATH || "/api/proxy/add").trim(),
      useTls: toBool(process.env.ZORAXY_USE_TLS, true),
    },
  },

  space: {
    // Relativer Pfad im Tenant-Workspace / in der VM
    substratePath: (process.env.NIMBUS_SPACE_SUBSTRATE || "__substrate/space").trim(),
    workspaceMount: (process.env.NIMBUS_VM_WORKSPACE || "/home/workspace").trim(),
  },

  agentVm: {
    installPath: (process.env.NIMBUS_AGENT_INSTALL_PATH || "/opt/nimbus-agent").trim(),
    soulPath: (process.env.NIMBUS_AGENT_SOUL_PATH || "/opt/nimbus-agent/SOUL.md").trim(),
  },
};

const toNumber = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: toNumber(process.env.PORT, 4000),
  defaultProvider: "anthropic",
  maxTurns: 25,
  httpTimeoutMs: toNumber(process.env.HTTP_TIMEOUT_MS, 30000),
  toolTimeoutMs: toNumber(process.env.TOOL_TIMEOUT_MS, 120000),

  proxmox: {
    enabled: String(process.env.PROXMOX_ENABLED || "false").toLowerCase() === "true",
    baseUrl: (process.env.PROXMOX_BASE_URL || "").trim(), // e.g. https://pve.example.com:8006
    tokenId: (process.env.PROXMOX_TOKEN_ID || "").trim(), // e.g. nimbus@pve!api-token
    tokenSecret: (process.env.PROXMOX_TOKEN_SECRET || "").trim(),
    node: (process.env.PROXMOX_NODE || "").trim(),
    storage: (process.env.PROXMOX_STORAGE || "local-lvm").trim(),
    bridge: (process.env.PROXMOX_BRIDGE || "vmbr0").trim(),
    templateVmid: toNumber(process.env.PROXMOX_TEMPLATE_VMID, 0),
    vmidStart: toNumber(process.env.PROXMOX_VMID_START, 5000),
    cpuCores: toNumber(process.env.PROXMOX_VM_CORES, 2),
    memoryMb: toNumber(process.env.PROXMOX_VM_MEMORY_MB, 4096),
    diskGb: toNumber(process.env.PROXMOX_VM_DISK_GB, 32),
    ciUser: (process.env.PROXMOX_CI_USER || "nimbus").trim(),
    ciSshPublicKey: (process.env.PROXMOX_CI_SSH_PUBLIC_KEY || "").trim(),
    ciPassword: (process.env.PROXMOX_CI_PASSWORD || "").trim(),
    ipConfig: (process.env.PROXMOX_IPCONFIG || "ip=dhcp").trim(), // cloud-init ipconfig0 value
    nameserver: (process.env.PROXMOX_NAMESERVER || "").trim(),
    searchdomain: (process.env.PROXMOX_SEARCHDOMAIN || "").trim(),
    sshConnectTimeoutSec: toNumber(process.env.PROXMOX_SSH_CONNECT_TIMEOUT_SEC, 5),
  },
};

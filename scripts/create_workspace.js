#!/usr/bin/env bun
/**
 * Nimbus Control-Plane CLI — Workspace/VM provisionieren.
 *
 * Usage:
 *   PROXMOX_ENABLED=true bun scripts/create_workspace.js <tenant-slug>
 *
 * Erfordert Proxmox-Env (siehe README / MASTER_PLAN.md).
 * Ruft denselben Orchestrator wie POST /api/vm/create auf.
 */
import { config, publicHostnameForTenant, sanitizeTenantSlug } from "../src/config.js";
import { upsertVmInstance, getVmInstance } from "../src/db.js";
import { vmOrchestrator } from "../src/vm-orchestrator.js";
import { getTemplateInfo } from "../src/proxmox.js";

const tenantArg = process.argv[2] || process.env.NIMBUS_TENANT || "";
if (!tenantArg) {
  console.error("Usage: bun scripts/create_workspace.js <tenant-slug>");
  process.exit(1);
}

const tenantId = sanitizeTenantSlug(tenantArg);
const fqdn = publicHostnameForTenant(tenantId);

console.log(`[nimbus] create_workspace tenant=${tenantId} fqdn=${fqdn}`);
console.log(`[nimbus] proxmox.enabled=${config.proxmox.enabled} template=${config.proxmox.templateVmid} node=${config.proxmox.node || "(unset)"}`);

if (!config.proxmox.enabled) {
  console.error("PROXMOX_ENABLED=true erforderlich.");
  process.exit(2);
}

try {
  const tpl = await getTemplateInfo(config.proxmox.templateVmid);
  console.log(`[nimbus] template ok vmid=${tpl.vmid} name=${tpl.name || "?"} isTemplate=${tpl.template}`);
} catch (err) {
  console.warn(`[nimbus] template check failed: ${err?.message || err}`);
}

const existing = getVmInstance(tenantId);
if (existing?.vmid && existing.state === "ready") {
  console.log(`[nimbus] VM already ready vmid=${existing.vmid} ip=${existing.ip_address}`);
  console.log(JSON.stringify({ ok: true, reused: true, vm: existing, url: `https://${fqdn}` }, null, 2));
  process.exit(0);
}

upsertVmInstance(tenantId, {
  provider: "proxmox",
  state: "provisioning",
  node: config.proxmox.node || "",
  template_vmid: config.proxmox.templateVmid,
  cpu_cores: config.proxmox.cpuCores,
  memory_mb: config.proxmox.memoryMb,
  disk_gb: config.proxmox.diskGb,
  username: config.proxmox.ciUser || "nimbus",
  metadata: { phase: "cli_queued", public_hostname: fqdn },
  last_error: "",
});

const job = vmOrchestrator.enqueue("provision", tenantId, { source: "cli" });
console.log(`[nimbus] queued job ${job.id}`);

// Auf Abschluss warten
const started = Date.now();
const timeoutMs = 15 * 60 * 1000;
while (Date.now() - started < timeoutMs) {
  await Bun.sleep(2000);
  const j = vmOrchestrator.getJob(job.id);
  const vm = getVmInstance(tenantId);
  process.stdout.write(`\r[nimbus] job=${j?.status} vm=${vm?.state || "?"} ip=${vm?.ip_address || "-"}   `);
  if (j?.status === "done") {
    console.log("\n[nimbus] provision complete");
    console.log(JSON.stringify({
      ok: true,
      tenant: tenantId,
      url: `https://${fqdn}`,
      vm,
      job: j,
    }, null, 2));
    process.exit(0);
  }
  if (j?.status === "failed" || j?.status === "canceled") {
    console.error(`\n[nimbus] provision ${j.status}: ${j.error}`);
    process.exit(3);
  }
}

console.error("\n[nimbus] timeout waiting for provision");
process.exit(4);

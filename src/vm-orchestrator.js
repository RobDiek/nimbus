import { mkdirSync } from "fs";
import { join } from "path";
import { logger } from "./logger.js";
import {
  getVmInstance,
  upsertVmInstance,
  updateVmState,
  insertVmJob,
  updateVmJob,
  getVmJob,
  listVmJobs,
  listPendingVmJobs,
} from "./db.js";
import { config, publicHostnameForTenant } from "./config.js";
import {
  ensureTenantVm,
  startVm,
  stopVm,
  getVmStatus,
  getVmIpBestEffort,
  applyVmBootstrap,
  deployAgentToVm,
  waitForVmIp,
} from "./proxmox.js";
import { deploySpaceToVm, ensureSpaceScaffold } from "./space.js";
// Phase 1: Zoraxy-Routing bewusst manuell — kein ensureTenantIngress im Provision-Pfad.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function tenantWorkspace(tenantId) {
  // Muss mit tenancy/router.js übereinstimmen: workspace/<userId>
  const base = join(import.meta.dir, "..", "workspace");
  const root = !tenantId || tenantId === "default" ? base : join(base, tenantId);
  mkdirSync(root, { recursive: true });
  return root;
}

class VmOrchestrator {
  constructor() {
    this.queue = [];
    this.running = false;
    this.jobs = new Map();
    this.maxRetries = 3;
    this.baseBackoffMs = 2000;
  }

  enqueue(type, tenantId, payload = {}) {
    const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const job = {
      id,
      type,
      tenantId,
      payload,
      status: "queued",
      retries: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      canceled: false,
      error: "",
    };

    this.jobs.set(id, job);
    insertVmJob(job);
    this.queue.push(job);
    this.loop();
    return job;
  }

  cancel(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.canceled = true;
    job.status = "canceled";
    job.updatedAt = new Date().toISOString();
    updateVmJob(job.id, { canceled: true, status: "canceled", updatedAt: job.updatedAt });
    return true;
  }

  getJob(jobId) {
    const mem = this.jobs.get(jobId);
    if (mem) return mem;
    const dbJob = getVmJob(jobId);
    if (!dbJob) return null;
    return {
      id: dbJob.id,
      type: dbJob.type,
      tenantId: dbJob.tenant_id,
      payload: dbJob.payload || {},
      status: dbJob.status,
      retries: dbJob.retries || 0,
      createdAt: dbJob.created_at,
      updatedAt: dbJob.updated_at,
      canceled: !!dbJob.canceled,
      error: dbJob.error || "",
    };
  }

  listJobs(limit = 100, tenantId = null) {
    if (tenantId) {
      return listVmJobs(tenantId, limit).map((j) => ({
        id: j.id,
        type: j.type,
        tenantId: j.tenant_id,
        payload: j.payload || {},
        status: j.status,
        retries: j.retries || 0,
        createdAt: j.created_at,
        updatedAt: j.updated_at,
        canceled: !!j.canceled,
        error: j.error || "",
      }));
    }
    return [...this.jobs.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);
  }

  resumePendingJobs() {
    const pending = listPendingVmJobs(500);
    for (const j of pending) {
      const job = {
        id: j.id,
        type: j.type,
        tenantId: j.tenant_id,
        payload: j.payload || {},
        status: j.status || "queued",
        retries: Number(j.retries || 0),
        createdAt: j.created_at,
        updatedAt: j.updated_at,
        canceled: !!j.canceled,
        error: j.error || "",
      };
      this.jobs.set(job.id, job);
      if (!job.canceled && (job.status === "queued" || job.status === "retrying" || job.status === "running")) {
        job.status = "queued";
        this.queue.push(job);
      }
    }
    if (this.queue.length) this.loop();
  }

  async loop() {
    if (this.running) return;
    this.running = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift();
      if (!job || job.canceled) continue;

      job.status = "running";
      job.updatedAt = new Date().toISOString();
      updateVmJob(job.id, { status: job.status, updatedAt: job.updatedAt });

      try {
        await this.processJob(job);
        job.status = "done";
        job.error = "";
        job.updatedAt = new Date().toISOString();
        updateVmJob(job.id, { status: job.status, error: "", retries: job.retries, updatedAt: job.updatedAt });
      } catch (err) {
        job.retries += 1;
        job.error = String(err?.message || err);
        job.updatedAt = new Date().toISOString();

        if (job.retries <= this.maxRetries && !job.canceled) {
          job.status = "retrying";
          updateVmJob(job.id, { status: job.status, error: job.error, retries: job.retries, updatedAt: job.updatedAt });
          const waitMs = this.baseBackoffMs * Math.pow(2, job.retries - 1);
          logger.warn("vm_job_retry", {
            id: job.id, type: job.type, tenant: job.tenantId, retries: job.retries, waitMs, error: job.error,
          });
          await sleep(waitMs);
          this.queue.push(job);
        } else {
          job.status = "failed";
          updateVmJob(job.id, { status: job.status, error: job.error, retries: job.retries, updatedAt: job.updatedAt });
          logger.error("vm_job_failed", { id: job.id, type: job.type, tenant: job.tenantId, error: job.error });
        }
      }
    }

    this.running = false;
  }

  /**
   * Provisioning-Pipeline (Control Plane only — niemals als Agent-Tool):
   * 1) Proxmox clone + cloud-init + boot + IP ausgeben
   * 2) Optional Bootstrap + Agent/Space-Deploy
   * Zoraxy-Ingress: Phase 1 manuell (IP wird nur geloggt/gespeichert).
   */
  async processJob(job) {
    const tenantId = job.tenantId;

    if (job.type === "provision") {
      updateVmState(tenantId, "provisioning", null);
      const vmData = await ensureTenantVm({ tenantId, existingVmid: null });
      upsertVmInstance(tenantId, {
        ...vmData,
        state: "bootstrapping",
        last_error: "",
        metadata: vmData.metadata,
      });

      await applyVmBootstrap({
        ip: vmData.ip_address,
        username: vmData.username || config.proxmox.ciUser || "nimbus",
        tenantId,
      });

      upsertVmInstance(tenantId, { state: "deploying_agent", last_error: "" });
      const agentDeploy = await deployAgentToVm({
        ip: vmData.ip_address,
        username: vmData.username || config.proxmox.ciUser || "nimbus",
      });
      if (!agentDeploy.ok) {
        logger.warn("agent_deploy_soft_fail", { tenantId, error: agentDeploy.error || agentDeploy.stderr });
      }

      upsertVmInstance(tenantId, { state: "deploying_space", last_error: "" });
      const tenantContext = {
        userId: tenantId,
        tenantId,
        workspaceRoot: tenantWorkspace(tenantId),
      };
      ensureSpaceScaffold(tenantContext);
      const spaceDeploy = await deploySpaceToVm(tenantId, tenantContext);
      if (!spaceDeploy.ok) {
        logger.warn("space_deploy_soft_fail", { tenantId, error: spaceDeploy.error || spaceDeploy.stderr });
      }

      const hostname = publicHostnameForTenant(tenantId);
      const meta = {
        ...(typeof vmData.metadata === "object" ? vmData.metadata : {}),
        public_hostname: hostname,
        public_url: `https://${hostname}`,
        ingress: {
          mode: "manual",
          note: "Zoraxy-Route manuell anlegen",
          target: vmData.ip_address ? `${vmData.ip_address}:${config.ingress.spacePort}` : null,
          hostname,
        },
        agent_deploy: { ok: !!agentDeploy.ok, files: agentDeploy.files },
        space_deploy: { ok: !!spaceDeploy.ok, files: spaceDeploy.files },
      };

      logger.info("provision_ready_manual_ingress", {
        tenantId,
        vmid: vmData.vmid,
        ip: vmData.ip_address,
        hostname,
        zoraxy_hint: `${hostname} → ${vmData.ip_address || "<IP>"}:${config.ingress.spacePort}`,
      });

      upsertVmInstance(tenantId, { state: "ready", last_error: "", metadata: meta });
      return;
    }

    const vm = getVmInstance(tenantId);
    if (!vm?.vmid) throw new Error("No VM assigned to tenant.");

    if (job.type === "start") {
      await startVm(vm.vmid);
      const status = await getVmStatus(vm.vmid);
      let ip = await waitForVmIp(vm.vmid, 60000, 3000);
      if (!ip) ip = (await getVmIpBestEffort(vm.vmid)) || vm.ip_address || "";
      const state = status?.status === "running" ? "ready" : "starting";
      if (ip) {
        logger.info("vm_started_manual_ingress", {
          tenantId,
          ip,
          hostname: publicHostnameForTenant(tenantId),
          zoraxy_hint: `${publicHostnameForTenant(tenantId)} → ${ip}:${config.ingress.spacePort}`,
        });
      }
      upsertVmInstance(tenantId, { state, ip_address: ip, last_error: "" });
      return;
    }

    if (job.type === "stop") {
      await stopVm(vm.vmid);
      upsertVmInstance(tenantId, { state: "stopped", last_error: "" });
      return;
    }

    throw new Error(`Unknown job type: ${job.type}`);
  }
}

export const vmOrchestrator = new VmOrchestrator();
vmOrchestrator.resumePendingJobs();

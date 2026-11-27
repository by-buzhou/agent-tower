import { createUpdater, hasUpdateProbation, readUpdateRecord, writeUpdateRecord, updateError, UPDATE_INTERNAL } from "../updater.mjs";

const READ_OR_CANCEL = new Set([
  "getBootstrap", "getEvents", "getConversationPolicy", "listHealthIncidents",
  "getCapabilities", "listProjectSpecs", "getTaskStatus", "listThreads", "readThread",
  "listWorktrees", "getWorktreeDiff", "getRuntimeCacheStatus", "listExtensionProviders",
  "respondRuntimeRequest", "cancelTask", "cancelThread", "updateHostContext", "systemUpdate",
]);
const QUEUE_READ_OR_CANCEL = new Set(["list", "read", "cancel", "remove", "delete", "clear"]);
const HOST_DISPATCH = new Set(["invoke_subagent", "define_subagent", "run_workflow"]);

export function createUpdatesModule(ctx, options) {
  let activeWrites = 0;
  let activeSpecWrites = 0;
  let cutoverId;
  let pendingDrain;
  function isUpdating() {
    if (cutoverId && readUpdateRecord(ctx.dataDir, "apply.lock")?.id !== cutoverId) {
      cutoverId = undefined;
      pendingDrain = undefined;
      ctx.flags.quiescing = false;
    }
    return Boolean(ctx.flags.quiescing || hasUpdateProbation(ctx.dataDir));
  }
  function blocksNewWrites() {
    const phase = readUpdateRecord(ctx.dataDir, "apply.lock")?.phase;
    return isUpdating() || ["quiescing", "applying", "rolling_back"].includes(phase);
  }
  const publish = systemUpdate => ctx.context.emitEvent({ type: "system_update_changed", systemUpdate });
  const updater = createUpdater({
    ...options,
    dataDir: ctx.dataDir,
    autoCheck: () => ctx.db.getSettings().autoCheckUpdates,
    isUpdating,
    onChange: publish,
    log: ctx.log,
  });

  async function runWrite(method, params, fn) {
    if (blocksNewWrites()) throw updateError("DAEMON_UPDATING", "Daemon is preparing an update");
    const counterIsSpec = method === "specCuration" || method === "initProjectSpecs";
    if (counterIsSpec) activeSpecWrites++;
    else activeWrites++;
    try { return await fn(params); }
    finally {
      if (counterIsSpec) activeSpecWrites--;
      else activeWrites--;
    }
  }

  function optionalWrite(fn) {
    if (!blocksNewWrites()) return runWrite("background", undefined, fn);
  }

  function guardRoutes(routes) {
    const readPolicy = routes.getConversationPolicy;
    routes.getConversationPolicy = (params = {}) => {
      const policy = readPolicy(params);
      const tool = params?.hostToolName;
      const dispatch = HOST_DISPATCH.has(tool) ||
        (tool === "swarm" && ["add", "post_message"].includes(params?.hostToolArgs?.action)) ||
        (!tool && params && Object.hasOwn(params, "hostToolArgs"));
      // This read is also the native host's pre-tool gate. A rejected RPC would trigger its offline fallback.
      if (dispatch && blocksNewWrites()) {
        return { ...policy, hostToolAllowed: false, hostToolReason: "DAEMON_UPDATING: Daemon is preparing an update" };
      }
      return policy;
    };
    const guarded = new Map();
    for (const [method, fn] of Object.entries(routes)) {
      if (READ_OR_CANCEL.has(method)) continue;
      if (!guarded.has(fn)) {
        guarded.set(fn, (params = {}) => {
          const action = String(params?.action || "").trim();
          if ((method === "specCuration" && action === "status") ||
              (method === "manageQueue" && QUEUE_READ_OR_CANCEL.has(action.toLowerCase() || "list"))) return fn(params);
          return runWrite(method, params, fn);
        });
      }
      routes[method] = guarded.get(fn);
    }
  }

  async function prepareCutover() {
    isUpdating();
    if (pendingDrain) return pendingDrain;
    if (!ctx.flags.quiescing) {
      const busy = {
        activeRuns: ctx.activeRuns.size,
        pendingTurnStartLocks: ctx.pendingTurnStartLocks.size,
        worktreeOperations: ctx.worktreeOperations.size,
        queuedRuns: ctx.db.listThreadsWithQueuedRuns().reduce((count, id) => count + ctx.db.listQueuedRuns(id).length, 0),
        activeSpecWrites,
        activeWrites,
      };
      if (Object.values(busy).some(Boolean)) return { ...updater.status(), busy, quiescing: false };
      ctx.flags.quiescing = true;
      const lock = readUpdateRecord(ctx.dataDir, "apply.lock");
      cutoverId = lock?.phase === "quiescing" ? lock.id : undefined;
      ctx.hostSync.stopNativeWatchers();
      ctx.specs.stopAutoCuration();
      const draining = Promise.resolve().then(() => ctx.engineManager?.drainWarmPool?.()).then(() => {
        if (pendingDrain !== draining || !isUpdating()) return { ...updater.status(), quiescing: false };
        updater.schedule();
        publish(updater.status());
        return { ...updater.status(), quiescing: true };
      }).catch(error => {
        if (pendingDrain === draining) releaseCutover();
        throw error;
      }).finally(() => { if (pendingDrain === draining) pendingDrain = undefined; });
      pendingDrain = draining;
      return draining;
    }
    return { ...updater.status(), quiescing: ctx.flags.quiescing };
  }

  function releaseCutover() {
    pendingDrain = undefined;
    ctx.flags.quiescing = false;
    cutoverId = undefined;
    updater.refresh();
    return { ...updater.status(), quiescing: isUpdating() };
  }

  async function systemUpdate({ action, version, [UPDATE_INTERNAL]: workerId } = {}) {
    switch (action) {
      case "status": return updater.status();
      case "check": return runWrite("systemUpdate", undefined, updater.check);
      case "dismiss": return runWrite("systemUpdate", version, updater.dismiss);
      case "apply": return updater.apply(version);
      case "rollback": return updater.rollback(version);
      case "prepareCutover": return prepareCutover();
      case "cancelCutover": {
        if (updater.cancel()) return { ...updater.status(), quiescing: isUpdating() };
        if (ctx.flags.quiescing) return releaseCutover();
        return { ...updater.status(), quiescing: isUpdating() };
      }
      case "commitWorker": {
        const lock = readUpdateRecord(ctx.dataDir, "apply.lock");
        if (!workerId || lock?.id !== workerId || lock.phase !== "quiescing" || !ctx.flags.quiescing) break;
        if (pendingDrain) return { committed: false };
        if (readUpdateRecord(ctx.dataDir, "cancel.json")?.id === workerId) return { committed: false };
        // This RPC and cancelCutover run in the same daemon, so cancellation and commitment are serialized.
        writeUpdateRecord(ctx.dataDir, "apply.lock", { ...lock, phase: lock.mode === "apply" ? "applying" : "rolling_back" });
        publish(updater.status());
        return { committed: true };
      }
      case "finishWorker":
        if (workerId) {
          const next = readUpdateRecord(ctx.dataDir, "apply.lock");
          return next && next.id !== workerId ? updater.status() : releaseCutover();
        }
        break;
    }
    throw updateError("INVALID_SYSTEM_UPDATE_ACTION", "Invalid systemUpdate action");
  }

  return { guardRoutes, isUpdating, optionalWrite, runWrite, systemUpdate,
    status: updater.status, schedule: updater.schedule, close: updater.close };
}

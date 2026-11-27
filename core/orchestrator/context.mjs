import { EventEmitter } from "node:events";
import { collectHostContext } from "../daemon-client.mjs";
import { openProjectStore } from "../project-store.mjs";
import { createEngineManager } from "../engines/index.mjs";
import { projectPathKey } from "./helpers.mjs";

export function createContext({ dataDir, defaultStudioRoot, catalogLoader, studioUrl, hostWakeSender, log, watchdogOptions }) {
  const db = openProjectStore(dataDir, defaultStudioRoot);
  const engineManager = createEngineManager({ pluginDataDir: dataDir });
  const bus = new EventEmitter();
  bus.setMaxListeners(200);
  return {
    dataDir, defaultStudioRoot, catalogLoader, hostWakeSender, log, watchdogOptions,
    db, engineManager, bus,
    flags: {
      currentStudioUrl: studioUrl,
      cachedCatalog: null,
      cachedCatalogKey: "",
      cachedCatalogAt: 0,
      catalogLoad: undefined,
      shuttingDown: false,
      dbClosed: false,
    },
    // runId -> active handle and settlement waiters; threadId -> runId.
    activeRuns: new Map(),
    activeRunByThread: new Map(),
    synchronousWaits: new Map(),
    pendingTurnStartLocks: new Set(),
    worktreeOperations: new Map(),
    cancelledPendingStarts: new Set(),
    inFlightClientRequests: new Map(),
    stateWaiters: new Set(),
    repoRootCache: new Map(),
    nativeWatchers: new Map(),
    latestSwarmSnapshots: new Map(),
    // rootConversationId -> { fingerprint, lastInitialNumSteps, everNonDirect }
    // Used by PreInvocation to inject a mode playbook once per mode/roster revision.
    playbookFingerprints: new Map(),
    // Host context stays in memory and is never echoed raw.
    hostContext: collectHostContext(process.env, { includeInternalIpcAuth: true }),
    // 最近一次被采信 LS / CSRF 凭据的客户端进程启动时间戳（0 = 尚未收到带时间戳的凭据）。
    hostContextStartedAt: 0,
  };
}

export function createContextModule(ctx) {
  function notifyStateWaiters() {
    for (const fn of ctx.stateWaiters) {
      try {
        fn();
      } catch {}
    }
  }

  function waitForCondition(predicate, timeoutMs = 600000, pollMs = 0) {
    return new Promise((resolve) => {
      let timer, poll;
      function finish(value, timedOut) {
        clearTimeout(timer);
        clearInterval(poll);
        ctx.stateWaiters.delete(check);
        resolve({ value, timedOut });
      }
      function check() {
        try {
          const value = predicate();
          if (value) {
            finish(value, false);
            return true;
          }
        } catch {}
        return false;
      }
      if (check()) return;
      if (timeoutMs <= 0) return finish(null, true);
      ctx.stateWaiters.add(check);
      timer = setTimeout(() => { if (!check()) finish(null, true); }, timeoutMs);
      // Another daemon writes to the same SQLite database without notifying this event bus.
      if (pollMs) poll = setInterval(check, pollMs);
    });
  }

  function resolveEventRootConversationId(eventObj = {}) {
    const directRoot = String(eventObj?.rootConversationId || eventObj?.swarm?.rootConversationId || "").trim();
    if (directRoot) return directRoot;
    const tid = String(eventObj?.threadId || "").trim();
    if (tid) {
      const th = ctx.db.getThread(tid, { includeQueue: false });
      const thRoot = ctx.scopePolicy.threadPolicyRoot(th);
      if (thRoot) return thRoot;
    }
    return String(eventObj?.conversationId || eventObj?.hostConversationId || "").trim();
  }

  function matchesEventConversation(ev, rootConvId = "") {
    const target = String(rootConvId || "").trim().toLowerCase();
    if (!target) return true;
    if (!ev || typeof ev !== "object") return false;
    if (ev.type === "settings_updated" || ev.type === "system_update_changed") return true;
    if (ev.type === "project_config_updated") {
      const targetWs = ctx.scopePolicy.configWorkspace({}, target);
      return Boolean(targetWs && ev.workspace && projectPathKey(targetWs) === projectPathKey(ev.workspace));
    }
    if (ev.type === "spec_curation_updated") {
      const targetWs = ctx.scopePolicy.configWorkspace({}, target);
      if (targetWs && ev.workspace) {
        return projectPathKey(targetWs) === projectPathKey(ev.workspace);
      }
      const evRoot = resolveEventRootConversationId(ev).toLowerCase();
      return !evRoot || evRoot === target;
    }
    const evRoot = resolveEventRootConversationId(ev).toLowerCase();
    return Boolean(evRoot && evRoot === target);
  }

  function emitEvent(eventObj) {
    if (eventObj?.thread?.id) {
      eventObj = { ...eventObj, thread: ctx.cancellation.withCancelCapability(eventObj.thread) };
    }
    const rootConvId = resolveEventRootConversationId(eventObj);
    const enrichedEvent =
      eventObj && typeof eventObj === "object" && !eventObj.rootConversationId && rootConvId
        ? { ...eventObj, rootConversationId: rootConvId }
        : eventObj;
    if (rootConvId && ["queue_updated", "run_completed", "run_started"].includes(eventObj.type)) {
      enrichedEvent.workCounts = ctx.scopePolicy.conversationWorkCounts(rootConvId);
    }
    const stored = ctx.db.appendEvent(enrichedEvent);
    ctx.bus.emit("event", stored);
    notifyStateWaiters();
    return stored;
  }

  function updateHostContext(patch = {}) {
    if (!patch || typeof patch !== "object") return;
    if (patch.appDataDir && String(patch.appDataDir).trim()) {
      ctx.hostContext.appDataDir = String(patch.appDataDir).trim();
    }
    if (patch.agentApiExe && String(patch.agentApiExe).trim()) {
      ctx.hostContext.agentApiExe = String(patch.agentApiExe).trim();
    }
    if (patch.projectId && String(patch.projectId).trim()) {
      ctx.hostContext.projectId = String(patch.projectId).trim();
    }
    // An explicitly identified host can be suggested for binding without changing the scope of other requests.
    if (typeof patch.conversationId === "string" && patch.conversationId.trim()) {
      const root = ctx.scopePolicy.policyRoot(patch);
      ctx.scopePolicy.recordActiveHost(root, patch);
    }
    // v0.2.6 C07①：带进程启动时间戳的客户端只允许「同龄或更新」的进程覆盖 LS / CSRF，
    // 防止长寿旧 Sidecar 轮询把已轮换的过期凭据倒灌回 Daemon；未携带时间戳的调用保持原直写语义。
    const startedAt = patch.clientStartedAt;
    const stamped = Number.isSafeInteger(startedAt) && startedAt > 0;
    const acceptCredentials = !stamped || startedAt >= (ctx.hostContextStartedAt || 0);
    const hasCredentials = Boolean(String(patch.lsAddress || "").trim() || String(patch.csrfToken || "").trim());
    if (acceptCredentials) {
      if (patch.lsAddress && String(patch.lsAddress).trim()) {
        ctx.hostContext.lsAddress = String(patch.lsAddress).trim();
      }
      if (patch.csrfToken && String(patch.csrfToken).trim()) {
        ctx.hostContext.csrfToken = String(patch.csrfToken).trim();
      }
      if (stamped && hasCredentials) ctx.hostContextStartedAt = startedAt;
    }
    ctx.engineManager.setHostContext?.({
      hostEnv: ctx.hostSync.buildHostEnvForDriver(),
      appDataDir: ctx.hostContext.appDataDir,
      agentApiExe: ctx.hostContext.agentApiExe,
      lsAddress: ctx.hostContext.lsAddress,
      csrfToken: ctx.hostContext.csrfToken,
    });
  }

  function withSynchronousWait(key, action) {
    if (!key) return action();
    ctx.synchronousWaits.set(key, (ctx.synchronousWaits.get(key) || 0) + 1);
    return action().finally(() => {
      const count = ctx.synchronousWaits.get(key) - 1;
      if (count) ctx.synchronousWaits.set(key, count);
      else ctx.synchronousWaits.delete(key);
    });
  }

  function subscribe(listener) {
    ctx.bus.on("event", listener);
    return () => ctx.bus.off("event", listener);
  }

  return {
    emitEvent,
    matchesEventConversation,
    notifyStateWaiters,
    subscribe,
    updateHostContext,
    waitForCondition,
    withSynchronousWait,
  };
}

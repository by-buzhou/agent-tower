import fs from "node:fs";
import { openOrchestratorDb, inspectSqliteHeaderFile, probeSpecCuration } from "./db.mjs";
import { globalSettings } from "./global-settings.mjs";
import { safeRoot, inside, child, studioDir, rotateLog } from "./storage-paths.mjs";

/** One daemon owns writes. All ID assignment, SQLite writes and event publication are synchronous. */
export function openProjectStore(controlDir, specifiedRoot) {
  const settings = globalSettings(controlDir, specifiedRoot);
  const projects = new Map();
  const indexes = Object.fromEntries(
    [
      "threads",
      "tasks",
      "runs",
      "taskRuns",
      "items",
      "requests",
      "commands",
      "conversations",
      "incidents",
    ].map((k) => [k, new Map()]),
  );
  const managedSessions = new Set();
  const managedSessionIdsByThread = new Map();
  let seq = 0;
  const resolveRoot = (p) => safeRoot(p, settings.root, controlDir);
  const policyKey = (id) => String(id || "").trim().toLowerCase();
  function indexThread(record, store) {
    indexes.threads.set(record.id, store);
    if (record.taskId) indexes.tasks.set(record.taskId, store);
    for (const id of managedSessionIdsByThread.get(record.id) || []) managedSessions.delete(id);
    const native = record.isNativeHost ?? (record.id.startsWith("thr_native_") || Boolean(record.hostConversationId));
    const managedIds = native ? [] : [record.id, record.nativeSessionId].filter(Boolean).map(id => String(id).toLowerCase());
    managedSessionIdsByThread.set(record.id, managedIds);
    for (const id of managedIds) managedSessions.add(id);
    for (const id of [record.hostConversationId, record.nativeSessionId].filter(
      Boolean,
    )) {
      const key = String(id).toLowerCase();
      if (
        !indexes.conversations.has(key) ||
        record.id.startsWith("thr_native_")
      )
        indexes.conversations.set(key, { store, id: record.id });
    }
  }
  function open(root) {
    // Linked trees execute at their own cwd, but share the primary project's database (never collapse test-runs sandboxes).
    const marker = [...root.matchAll(/[\\/]\.agent-tower[\\/]worktrees[\\/]/gi)].at(-1);
    const sandbox = process.env.AGENT_TOWER_TEST_ROOT;
    if (marker && !/[\\/]\.agent-tower[\\/]test-runs(?:[\\/]|$)/i.test(root.slice(marker.index)) && (!sandbox || inside(sandbox, root.slice(0, marker.index)))) {
      root = resolveRoot(root.slice(0, marker.index));
    }
    if (projects.has(root)) return projects.get(root);
    const file = child(studioDir(root, "conversations"), "tower.sqlite");
    const store = openOrchestratorDb(file);
    store.root = root;
    try {
      const rows = store.indexRows();
      for (const t of rows.threads)
        indexThread(
          {
            id: t.id,
            taskId: t.task_id,
            hostConversationId: t.host_conversation_id,
            nativeSessionId: t.native_session_id,
            isNativeHost: Boolean(t.is_native_host || String(t.id).startsWith("thr_native_") || (t.provider === "antigravity" && t.host_conversation_id)),
          },
          store,
        );
      for (const run of rows.runs) {
        if (run.taskId) indexes.taskRuns.set(run.taskId, run.id);
      }
      for (const key of ["runs", "items", "requests", "commands", "incidents"])
        for (const { id } of rows[key]) indexes[key].set(id, store);
      seq = Math.max(seq, store.getLatestSeq());
      settings.remember(root);
      projects.set(root, store);
      rotateLog(root, "tower.log", "Project database opened");
      return store;
    } catch (e) {
      store.close();
      throw e;
    }
  }
  const base = open(settings.root);
  for (const root of settings.read().knownProjects) {
    if (
      resolveRoot(root) === root &&
      fs.existsSync(child(root, ".agent-tower", "conversations", "tower.sqlite"))
    )
      open(root);
  }
  seq = base.eventClock(seq);
  const byThread = (id) => indexes.threads.get(id) || indexes.tasks.get(id);
  // Index misses (rows written by another daemon sharing the same project database, or projects opened after the
  // row was created) fall back to scanning every opened project store, then backfill the index.
  function scanThread(id, opts) {
    if (!id) return null;
    for (const s of projects.values()) {
      const row = s.getThread(id, opts);
      if (row) {
        indexThread(row, s);
        return row;
      }
    }
    return null;
  }
  function scanRun(id) {
    if (!id) return null;
    for (const s of projects.values()) {
      const run = s.getRun(id);
      if (run) {
        indexes.runs.set(run.id, s);
        if (run.meta?.taskId) indexes.taskRuns.set(run.meta.taskId, run.id);
        return run;
      }
    }
    return null;
  }
  const byPatch = (p) =>
    byThread(p.threadId) ||
    indexes.runs.get(p.runId) ||
    open(
      resolveRoot(p.meta?.projectRoot || p.projectRoot || p.workspace || p.cwd),
    );
  const aggregate = (name, ...args) =>
    Array.from(projects.values()).flatMap((s) => s[name](...args));
  const recent = (a, b) =>
    b.updatedAt - a.updatedAt || a.id.localeCompare(b.id);
  const indexedWrite = (key, method, p) => {
    const s = indexes[key].get(p.id || p.runId || p.requestId) || byPatch(p);
    const row = s[method](p);
    indexes[key].set(row.id, s);
    return row;
  };
  function findPolicy(id) {
    const conversationId = String(id || "").trim();
    if (!conversationId) return null;
    let latest = null;
    for (const store of projects.values()) {
      const record = store.getConversationPolicyRecord(conversationId);
      if (!record || (latest && record.policyRevision <= latest.policyRevision)) continue;
      latest = { ...record, workspace: store.root };
    }
    return latest;
  }

  return {
    defaultStudioRoot: settings.root,
    resolveRoot,
    getProjectRoster: settings.getProjectRoster,
    getProjectSpec: settings.getProjectSpec,
    getProjectExternalSessions: settings.getProjectExternalSessions,
    isProjectExternalSessionVisible: settings.isProjectExternalSessionVisible,
    setProjectExternalSessionMode: settings.setProjectExternalSessionMode,
    isProjectSpecEnabled: settings.isProjectSpecEnabled,
    setProjectSpecEnabled: settings.setProjectSpecEnabled,
    setSpecCurationAuto: settings.setSpecCurationAuto,
    setSpecCurationLimits: settings.setSpecCurationLimits,
    latestCurationWork: (root, conversationId) => projects.get(resolveRoot(root))?.latestCurationWork(conversationId),
    readSpecCuration(root) {
      const resolved = resolveRoot(root);
      if (projects.has(resolved)) return projects.get(resolved).readSpecCuration();
      const file = child(resolved, ".agent-tower", "conversations", "tower.sqlite");
      return fs.existsSync(file) ? probeSpecCuration(file) : {};
    },
    getSpecProposal(root, id) {
      const resolved = resolveRoot(root);
      if (projects.has(resolved)) return projects.get(resolved).getSpecProposal(id);
      const file = child(resolved, ".agent-tower", "conversations", "tower.sqlite");
      return fs.existsSync(file) ? open(resolved).getSpecProposal(id) : null;
    },
    putSpecProposal: (root, record) => open(resolveRoot(root)).putSpecProposal(record),
    patchSpecCurationState: (root, patch) => open(resolveRoot(root)).patchSpecCurationState(patch),
    getSettings: settings.read,
    saveSettings: settings.save,
    listWorkCountsByThread: () => aggregate("listWorkCountsByThread"),
    listThreadsWithQueuedRuns: () => aggregate("listThreadsWithQueuedRuns"),
    getConversationPolicyRecord: findPolicy,
    listConversationPolicies() {
      const policies = new Map();
      for (const store of projects.values()) {
        for (const record of store.listConversationPolicyRecords()) {
          const key = policyKey(record.conversationId);
          const previous = policies.get(key);
          if (!previous || record.policyRevision > previous.policyRevision) {
            policies.set(key, { ...record, workspace: store.root });
          }
        }
      }
      return [...policies.values()];
    },
    setConversationPolicyRecord(p) {
      const conversationId = String(p.conversationId || "").trim();
      const workspace = safeRoot(p.workspace, null, controlDir);
      const target = workspace && workspace !== settings.root ? open(resolveRoot(workspace)) : null;
      const previous = findPolicy(conversationId);
      const store = target || projects.get(previous?.workspace) || byThread(p.threadId) || base;
      return store.setConversationPolicyRecord({ ...p, conversationId }, previous?.workspace !== store.root ? previous : null);
    },
    isManagedChildSession(id) {
      const wanted = String(id || "").trim().toLowerCase();
      return Boolean(wanted) && managedSessions.has(wanted);
    },
    getHealthIncident(id) {
      const hit = indexes.incidents.get(id)?.getHealthIncident(id);
      if (hit) return hit;
      for (const s of projects.values()) {
        const row = s.getHealthIncident(id);
        if (row) {
          indexes.incidents.set(id, s);
          return row;
        }
      }
      return null;
    },
    upsertHealthIncident: (p) => indexedWrite("incidents", "upsertHealthIncident", p),
    listHealthIncidents: (p = {}) => aggregate("listHealthIncidents", p).sort(recent),
    dismissHealthIncident(p = {}) {
      if (p.dismissAll) return aggregate("dismissHealthIncident", p).reduce((a, b) => a + b, 0);
      if (!p.incidentId) return 0;
      const indexed = indexes.incidents.get(p.incidentId);
      if (indexed?.getHealthIncident(p.incidentId)) return indexed.dismissHealthIncident(p) || 0;
      for (const s of projects.values()) {
        if (!s.getHealthIncident(p.incidentId)) continue;
        indexes.incidents.set(p.incidentId, s);
        return s.dismissHealthIncident(p) || 0;
      }
      return 0;
    },
    upsertThread(p) {
      const root = p.meta?.projectRoot || p.projectRoot || p.workspace || p.cwd;
      const s =
        byThread(p.id || p.threadId) ||
        (root ? open(resolveRoot(root)) : byThread(p.parentThreadId)) ||
        base;
      const previousTask = p.taskId !== undefined && s.getThread(p.id || p.threadId, { includeQueue: false })?.taskId;
      const row = s.upsertThread(p);
      if (previousTask && previousTask !== row.taskId) indexes.tasks.delete(previousTask);
      indexThread(row, s);
      return row;
    },
    getConversationThread(id) {
      const match = indexes.conversations.get(String(id).toLowerCase());
      return match?.store.getThread(match.id) || null;
    },
    getThread: (id, opts) => (id && byThread(id)?.getThread(id, opts)) || scanThread(id, opts),
    hasProjectDb(root) {
      const resolved = safeRoot(root, null, controlDir);
      if (!resolved) return false;
      if (projects.has(resolved)) return true;
      try {
        return fs.existsSync(child(resolved, ".agent-tower", "conversations", "tower.sqlite"));
      } catch {
        return false;
      }
    },
    listRoleThreads(workspace, role, rootConversationId) {
      const resolved = safeRoot(workspace, null, controlDir);
      if (!resolved) return base.listRoleThreads(base.root, role, rootConversationId);
      let store = projects.get(resolved);
      if (!store) {
        let file;
        try {
          file = child(resolved, ".agent-tower", "conversations", "tower.sqlite");
        } catch {
          return [];
        }
        if (!fs.existsSync(file)) return [];
        store = open(resolved);
      }
      return store.listRoleThreads(resolved, role, rootConversationId);
    },
    listThreads(opts = {}) {
      const { limit = 200, offset = 0 } = opts;
      return aggregate("listThreads", {
        ...opts,
        limit: limit + offset,
        offset: 0,
      })
        .sort(recent)
        .slice(offset, offset + limit);
    },
    searchThreads: (q, opts = {}) =>
      aggregate("searchThreads", q, opts)
        .sort(recent)
        .slice(0, opts.limit || 50),
    upsertRun(p) {
      const run = indexedWrite("runs", "upsertRun", p);
      if (p.meta?.taskId) indexes.taskRuns.set(p.meta.taskId, run.id);
      return run;
    },
    getTaskRun(taskId) {
      const id = indexes.taskRuns.get(taskId);
      return indexes.runs.get(id)?.getRun(id) || null;
    },
    getRun: (id) => (id && indexes.runs.get(id)?.getRun(id)) || scanRun(id),
    getLatestRun: (id) => byThread(id)?.getLatestRun(id) || null,
    listRuns: (opts = {}) =>
      opts.threadId
        ? byThread(opts.threadId)?.listRuns(opts) || []
        : aggregate("listRuns", opts)
            .sort((a, b) => a.ordinal - b.ordinal || a.createdAt - b.createdAt)
            .slice(0, opts.limit || 200),
    summarizeBoardRuns: (id, limit, getCachedSummary) =>
      byThread(id)?.summarizeBoardRuns(id, limit, getCachedSummary) || [],
    listQueuedRuns: (id) => byThread(id)?.listQueuedRuns(id) || [],
    reorderQueuedRuns: (id, order) =>
      byThread(id)?.reorderQueuedRuns(id, order) || [],
    upsertTurnItem: (p) => indexedWrite("items", "upsertTurnItem", p),
    appendTurnItemDelta(id, p) {
      const s = indexes.items.get(id) || byPatch(p);
      const row = s.appendTurnItemDelta(id, p);
      if (row) indexes.items.set(id, s);
      return row;
    },
    listTurnItems: (p = {}) =>
      (byThread(p.threadId) || indexes.runs.get(p.runId))?.listTurnItems(p) ||
      [],
    getLocalContinuation: threadId => byThread(threadId)?.getLocalContinuation(threadId),
    // O(1) primary-key read; the thread store is the fallback when the item index has not seen this row yet.
    getTurnItem(id, threadId) {
      if (!id) return null;
      const indexed = indexes.items.get(id)?.getTurnItem(id);
      if (indexed) return indexed;
      const s = threadId && byThread(threadId);
      const row = s?.getTurnItem(id) || null;
      if (row) indexes.items.set(id, s);
      return row;
    },
    upsertRuntimeRequest: (p) =>
      indexedWrite("requests", "upsertRuntimeRequest", p),
    getRuntimeRequest: (id) =>
      indexes.requests.get(id)?.getRuntimeRequest(id) || null,
    listPendingRequests: (p = {}) =>
      aggregate("listPendingRequests", p).sort(
        (a, b) => a.createdAt - b.createdAt,
      ),
    claimCommandReceipt(id, p, method, root) {
      const s =
        indexes.commands.get(id) ||
        byThread(p.threadId) ||
        open(resolveRoot(root));
      const ok = s.claimCommandReceipt(id, p, method);
      indexes.commands.set(id, s);
      return ok;
    },
    getCommandReceipt: (id, m) =>
      indexes.commands.get(id)?.getCommandReceipt(id, m) || null,
    releaseCommandReceipt(id, p) {
      const ok = indexes.commands.get(id)?.releaseCommandReceipt(id, p);
      if (ok) indexes.commands.delete(id);
      return !!ok;
    },
    saveCommandReceipt(id, m, p) {
      const s = indexes.commands.get(id) || byPatch(p);
      s.saveCommandReceipt(id, m, p);
      indexes.commands.set(id, s);
    },
    appendEvent(p) {
      const s =
        byThread(p.threadId) ||
        indexes.runs.get(p.runId) ||
        indexes.requests.get(p.requestId) ||
        indexes.tasks.get(p.taskId) ||
        indexes.commands.get(p.commandId) ||
        (["spec_curation_updated", "project_config_updated"].includes(p.type) ? projects.get(resolveRoot(p.workspace)) || base : byPatch(p));
      const event = s.appendEvent(p, (seq = base.eventClock(seq, 1)));
      // Batch trim (every 200 events) instead of a full-table DELETE subquery on every append.
      if (s.shouldTrimEvents()) s.trimEvents();
      if (
        [
          "run_started",
          "run_completed",
          "thread_created",
          "worktree_updated",
        ].includes(event.type)
      )
        rotateLog(s.root, "tower.log", `${event.type} seq=${seq}`);
      if (seq % 250 === 0) s.checkpoint();
      return event;
    },
    listEvents: (p = {}) =>
      aggregate("listEvents", p)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, Math.max(1, Math.min(2000, Number(p.limit) || 300))),
    getLatestSeq: () => seq,
    // Strictly read-only storage probe: an already-open store answers via PRAGMA, otherwise only the 100-byte
    // file header is read (never open() here: that would create -wal and append to tower.log).
    inspectProjectDb(root, opts = {}) {
      const resolved = safeRoot(root, null, controlDir);
      if (!resolved) return null;
      const s = projects.get(resolved);
      if (s) {
        try { return s.inspectStorage(opts); } catch { return null; }
      }
      let file = "";
      try { file = child(resolved, ".agent-tower", "conversations", "tower.sqlite"); } catch { return null; }
      return inspectSqliteHeaderFile(file, opts);
    },
    // Runtime-cache hygiene: trim old events and fold the WAL back, but never create a database where none existed.
    // Physical reclaim (VACUUM / incremental_vacuum) only runs on explicit manual request while the project is idle.
    compactProjectDb(root, opts = {}) {
      const resolved = safeRoot(root, null, controlDir);
      if (!resolved) return { ok: false, compacted: false, reason: "restricted" };
      let s = projects.get(resolved);
      if (!s) {
        let file = "";
        try { file = child(resolved, ".agent-tower", "conversations", "tower.sqlite"); } catch { return { ok: false, compacted: false, reason: "unsafe" }; }
        if (!fs.existsSync(file)) return { ok: true, compacted: false, reason: "missing" };
        try { s = open(resolved); } catch { return { ok: false, compacted: false, reason: "open_failed" }; }
      }
      if (opts.allowPhysicalVacuum === true && opts.isIdle !== false) {
        try { return s.compactStorage(opts); } catch (error) {
          return { ok: false, compacted: false, vacuumed: false, vacuumSkippedReason: "vacuum_failed", error: String(error?.message || error) };
        }
      }
      let trimmed = false;
      let checkpointed = false;
      try { s.trimEvents(); trimmed = true; } catch { /* SQLite busy: keep going */ }
      try { const r = s.checkpoint(); checkpointed = !r?.busy; } catch { /* WAL busy: retry on a later cleanup */ }
      const result = { ok: true, compacted: trimmed || checkpointed, trimmed, checkpointed };
      return opts.allowPhysicalVacuum === true ? { ...result, vacuumed: false, vacuumSkippedReason: "active_tasks" } : result;
    },
    getStats(p) {
      const total = {};
      for (const s of projects.values())
        for (const [key, value] of Object.entries(s.getStats(p)))
          total[key] = (total[key] || 0) + value;
      return total;
    },
    close() {
      for (const s of projects.values()) s.close();
      projects.clear();
    },
  };
}

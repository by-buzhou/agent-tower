import { existsSync } from "node:fs";
import { unsupportedHostCancel } from "../engines/agy-native.mjs";
import {
  ACTIVE_RUN_STATUSES,
  deriveCleanMemberName,
  foreignRunOwnerPid,
  makeId,
  isThreadBusyStatus,
} from "./helpers.mjs";

export function createCancellationModule(ctx) {
  async function cancelTask(params = {}) {
    const reqKey = String(params.clientRequestId ?? "").trim();
    if (!reqKey) return cancelTaskCore(params);
    const id = `cancelTask:${reqKey}`;
    if (ctx.inFlightClientRequests.has(id)) return ctx.inFlightClientRequests.get(id);

    async function cancelOnce() {
      const pending = { status: "pending", ownerPid: process.pid, claimId: makeId("cancel") };
      const deadline = Date.now() + 10000;
      while (!ctx.db.claimCommandReceipt(id, pending, "cancelTask", ctx.db.getThread(params.threadId || params.taskId)?.workspace || ctx.scopePolicy.executionRoot(params))) {
        const receipt = ctx.db.getCommandReceipt(id, "cancelTask");
        if (!receipt) continue;
        if (receipt.status !== "pending" || !receipt.ownerPid) return receipt;
        // A lost owner may already have signalled the process. Never take over a cancellation.
        if (Date.now() >= deadline) return { status: "pending", cancelled: false };
        await new Promise(resolve => setTimeout(resolve, 50));
      }

      let effectsStarted = false;
      let result;
      try {
        result = await cancelTaskCore(params, () => { effectsStarted = true; });
      } catch (err) {
        if (!effectsStarted) {
          ctx.db.releaseCommandReceipt(id, pending);
          throw err;
        }
        // A partially applied cancellation must never be replayed against the thread's next turn.
        result = { ok: false, cancelled: false, error: "取消结果未能确认，请查询任务状态。" };
      }
      // If persistence fails, keep the claim: execution may already have succeeded.
      ctx.db.saveCommandReceipt(id, "cancelTask", result);
      return result;
    }
    const flight = Promise.resolve().then(cancelOnce).finally(() => ctx.inFlightClientRequests.delete(id));
    ctx.inFlightClientRequests.set(id, flight);
    return flight;
  }

  function isActiveRunStatus(status) {
    return ACTIVE_RUN_STATUSES.includes(String(status || "").toLowerCase());
  }

  // Who owns a DB-level active run that this daemon holds no handle for?
  function describeRunOwner(thread) {
    const runIds = new Set([thread.activeRunId, ...ctx.db.listRuns({ threadId: thread.id, statuses: ACTIVE_RUN_STATUSES, limit: 20 })
      .map(r => r.id)].filter(Boolean));
    let foreignOwnerPid = null;
    for (const id of runIds) {
      foreignOwnerPid = foreignRunOwnerPid(ctx.db.getRun(id)) || foreignOwnerPid;
    }
    return { runIds: [...runIds], foreignOwnerPid };
  }

  /** Client-facing stop affordance: "stoppable" | "reconcilable_orphan" | "host_only" | "none". */
  function computeCancelCapability(thread) {
    if (!thread?.id) return "none";
    const liveRunId = ctx.activeRunByThread.get(thread.id) || thread.activeRunId;
    const entry = liveRunId ? ctx.activeRuns.get(liveRunId) : null;
    if (entry) return entry.handle?.passiveHost ? "host_only" : "stoppable";
    if (ctx.pendingTurnStartLocks.has(thread.id)) return "stoppable";
    const status = String(thread.status || "").toLowerCase();
    if (!isThreadBusyStatus(status)) return "none";
    if (thread.isNativeHost || thread.meta?.isNativeHost) return "host_only";
    if (status === "queued") return "stoppable";
    return describeRunOwner(thread).foreignOwnerPid ? "none" : "reconcilable_orphan";
  }

  function withCancelCapability(thread) {
    return thread && typeof thread === "object" && thread.id ? { ...thread, cancelCapability: computeCancelCapability(thread) } : thread;
  }

  function closePendingRequests(thread, runIds = null, onEffect = () => {}) {
    for (const req of ctx.db.listPendingRequests({ threadId: thread.id })) {
      if (runIds && !runIds.includes(req.runId)) continue;
      ctx.db.upsertRuntimeRequest({ ...req, status: "cancelled", decision: "cancelled", resolvedAt: Date.now() });
      onEffect();
      ctx.context.emitEvent({ type: "runtime_request_resolved", threadId: thread.id, runId: req.runId,
        workspace: thread.workspace || thread.cwd, requestId: req.id, decision: "cancelled" });
    }
  }

  function cancelQueuedRuns(thread, onEffect = () => {}) {
    const queued = ctx.db.listQueuedRuns(thread.id);
    for (const qr of queued) {
      ctx.db.upsertRun({ id: qr.id, threadId: thread.id, status: "cancelled", stopReason: "cancelled", completedAt: Date.now() });
      onEffect();
    }
    if (queued.length) ctx.context.emitEvent({ type: "queue_updated", threadId: thread.id, workspace: thread.workspace || thread.cwd, queue: [] });
  }

  function reconcileOrphanThread(thread, { onEffect = () => {}, runIds } = {}) {
    const now = Date.now();
    const ids = runIds || describeRunOwner(thread).runIds;
    const finished = [];
    for (const id of ids) {
      const run = ctx.db.getRun(id);
      if (run?.threadId !== thread.id || !isActiveRunStatus(run.status)) continue;
      const finishedRun = ctx.db.upsertRun({ id, threadId: thread.id, status: "interrupted", stopReason: "orphan_reconciled",
        error: "运行句柄已丢失（原守护进程已退出），已由用户中断收割。", completedAt: now });
      onEffect();
      finished.push(finishedRun);
    }
    closePendingRequests(thread, null, onEffect);
    const resolved = ctx.health.resolveSoftStallIncidents(thread);
    for (const incident of resolved) {
      ctx.context.emitEvent({ type: "health_incident_resolved", rootConversationId: incident.rootConversationId || ctx.scopePolicy.threadPolicyRoot(thread),
        threadId: thread.id, runId: incident.runId, workspace: thread.workspace, incidentId: incident.id, incident });
    }
    const softHealth = thread.meta?.health?.state === "suspected_stall";
    const updated = ctx.db.upsertThread({ id: thread.id, status: "interrupted", activeRunId: null,
      ...(softHealth ? { meta: { health: { state: "healthy", runId: thread.meta.health.runId, updatedAt: now } } } : {}) });
    onEffect();
    for (const run of finished) {
      ctx.context.emitEvent({ type: "run_completed", threadId: thread.id, runId: run.id, workspace: updated.workspace || updated.cwd,
        status: "interrupted", summary: updated.summary || "", error: null, reconciledOrphan: true, run, thread: updated });
    }
    ctx.context.emitEvent({ type: "thread_updated", threadId: thread.id, workspace: updated.workspace || updated.cwd,
      reconciledOrphan: true, thread: updated });
    ctx.context.notifyStateWaiters();
    return updated;
  }

  async function stopThreadExecution(targetThread, { force = false, keepQueue = false, onEffect = () => {} } = {}) {
    const activeRunId = ctx.activeRunByThread.get(targetThread.id) || targetThread.activeRunId;
    const entry = activeRunId ? ctx.activeRuns.get(activeRunId) : null;
    const handle = entry?.handle;
    if (handle?.passiveHost || (!entry && (targetThread.isNativeHost || targetThread.meta?.isNativeHost))) {
      return { ok: false, cancelled: false, unsupported: true, cancelState: "host_only" };
    }
    if (entry) {
      // Clear any pending steering restart BEFORE signalling, so the settled turn cannot relaunch itself.
      entry.steeringRestartPending = null;
      entry.cancelRequested = true;
      ctx.watchdog.stop(activeRunId);
      if (!keepQueue) cancelQueuedRuns(targetThread, onEffect);
      closePendingRequests(targetThread, null, onEffect);
      if (ctx.pendingTurnStartLocks.has(targetThread.id)) ctx.cancelledPendingStarts.add(targetThread.id);
      if (handle) {
        onEffect(); // The driver can signal the process before its promise rejects.
        if (force) await handle.forceKill?.();
        else await handle.cancel?.();
      }
      return { ok: true, cancelled: true, cancelState: force ? "force_killed" : "cancelled", runId: activeRunId };
    }
    if (ctx.pendingTurnStartLocks.has(targetThread.id)) {
      if (!keepQueue) cancelQueuedRuns(targetThread, onEffect);
      closePendingRequests(targetThread, null, onEffect);
      ctx.cancelledPendingStarts.add(targetThread.id);
      onEffect();
      return { ok: true, cancelled: true, cancelState: "cancelled_before_start" };
    }
    const status = String(targetThread.status || "").toLowerCase();
    if (!isThreadBusyStatus(status)) {
      if (!keepQueue) cancelQueuedRuns(targetThread, onEffect);
      return { ok: true, cancelled: false, alreadyFinished: true, cancelState: "idle" };
    }
    if (status === "queued") {
      if (keepQueue) return { ok: true, cancelled: false, cancelState: "queue_frozen" };
      cancelQueuedRuns(targetThread, onEffect);
      const updated = ctx.db.upsertThread({ id: targetThread.id, status: "interrupted", activeRunId: null });
      ctx.context.emitEvent({ type: "thread_updated", threadId: targetThread.id, workspace: updated.workspace || updated.cwd, thread: updated });
      return { ok: true, cancelled: true, cancelState: "cancelled" };
    }
    const owner = describeRunOwner(targetThread);
    if (owner.foreignOwnerPid) {
      return { ok: false, cancelled: false, unsupported: true, cancelState: "foreign_owner",
        error: `该回合由另一个仍存活的守护进程（PID ${owner.foreignOwnerPid}）执行，当前进程无法中断；请在该进程退出后重试。` };
    }
    if (!keepQueue) cancelQueuedRuns(targetThread, onEffect);
    reconcileOrphanThread(targetThread, { onEffect, runIds: owner.runIds });
    return { ok: true, cancelled: true, reconciledOrphan: true, cancelState: "orphaned_reconciled" };
  }

  async function cancelTaskCore(params, onEffect = () => {}) {
    const key = params.taskId || params.threadId || params.id;
    const force = Boolean(params.force);
    const expectedRunId = String(params.expectedRunId || "").trim();

    let thread = key ? ctx.db.getThread(key) : null;
    if (!thread) {
      const r = ctx.db.getRun(params.runId || expectedRunId);
      if (r) thread = ctx.db.getThread(r.threadId);
    }
    if (!thread) {
      throw new Error(`找不到要中断的任务或会话: ${key || params.runId || expectedRunId || ""}`);
    }

    const liveRunId = ctx.activeRunByThread.get(thread.id) || thread.activeRunId || "";
    // Bind force escalation to the original turn. A first click stops the member's current turn.
    if (expectedRunId && liveRunId !== expectedRunId && (force || !liveRunId)) {
      const expectedRun = force && liveRunId ? ctx.db.getRun(expectedRunId) : null;
      const finished = !expectedRun || !isActiveRunStatus(expectedRun.status);
      return { ok: true, cancelled: false, alreadyFinished: finished, cancelState: "stale_run",
        threadId: thread.id, runId: expectedRunId, status: thread.status,
        summary: finished ? "该回合已结束，未中断后续回合。" : "该回合不是此成员当前回合，未发送停止信号。" };
    }

    const cancelledThreadIds = [];
    const unsupportedThreadIds = [];
    const visited = new Set([thread.id]);
    let reconciledOrphan = false;

    async function cancelChildren(parent) {
      const children = ctx.db.listThreads({ parentThreadId: parent.id, includeSubagents: true, limit: 100 });
      for (const child of children) {
        if (visited.has(child.id)) continue;
        visited.add(child.id);
        try { await cancelSingleThread(child); }
        catch { unsupportedThreadIds.push(child.id); await cancelChildren(child); }
      }
    }

    async function cancelSingleThread(targetThread) {
      const outcome = await stopThreadExecution(targetThread, { force, onEffect });
      if (outcome.cancelState === "host_only") {
        unsupportedThreadIds.push(targetThread.id);
        // The host turn itself belongs to Antigravity, but its external children are ours to stop.
        await cancelChildren(targetThread);
        return outcome;
      }
      if (!outcome.ok) {
        unsupportedThreadIds.push(targetThread.id);
        await cancelChildren(targetThread);
        return outcome;
      }
      if (outcome.cancelled) cancelledThreadIds.push(targetThread.id);
      if (outcome.reconciledOrphan) reconciledOrphan = true;
      await cancelChildren(targetThread);
      return outcome;
    }

    const outcome = await cancelSingleThread(thread);
    if (outcome.cancelState === "host_only") {
      const childCount = cancelledThreadIds.length;
      const base = unsupportedHostCancel();
      return { ...base, cancelState: "host_only", threadId: thread.id, cancelledThreadIds, unsupportedThreadIds,
        error: childCount
          ? `已级联中断 ${childCount} 个由塔台管理的外部子成员；宿主主回合属于 Antigravity，请在主窗口停止。`
          : base.error };
    }
    if (!outcome.ok) return { ...outcome, threadId: thread.id, cancelledThreadIds, unsupportedThreadIds };

    const updated = ctx.db.getThread(thread.id);
    return {
      ok: true,
      cancelled: Boolean(outcome.cancelled || cancelledThreadIds.length),
      ...(outcome.alreadyFinished ? { alreadyFinished: true } : {}),
      ...(reconciledOrphan ? { reconciledOrphan: true } : {}),
      cancelState: outcome.cancelState,
      force,
      taskId: updated?.taskId || thread.id,
      threadId: thread.id,
      ...(outcome.cancelled && liveRunId ? { runId: outcome.runId || liveRunId } : {}),
      status: updated?.status || "interrupted",
      cancelledThreadIds,
      unsupportedThreadIds,
    };
  }

  async function archiveThreads(toArchive, { force = false, conversationRoot = "" } = {}) {
    // Stop live work first; a refused or failed stop must never be hidden behind a silent archive.
    const refusals = [];
    const settling = [];
    const collectSettled = threadId => {
      const runId = ctx.activeRunByThread.get(threadId);
      const settled = runId ? ctx.activeRuns.get(runId)?.settledPromise : null;
      if (settled) settling.push(settled);
    };
    for (const t of toArchive) {
      const cur = ctx.db.getThread(t.id, { includeQueue: false }) || t;
      if (!(ctx.activeRunByThread.has(cur.id) || ctx.pendingTurnStartLocks.has(cur.id) || isThreadBusyStatus(cur.status))) continue;
      const preRunId = ctx.activeRunByThread.get(cur.id);
      const preSettled = preRunId ? ctx.activeRuns.get(preRunId)?.settledPromise : null;
      const stop = conversationRoot
        ? stopThreadExecution(cur, { force })
        : cancelTask({ threadId: cur.id, force });
      const res = await stop.catch(error => ({ ok: false, cancelled: false, error: error?.message || String(error) }));
      if (res?.ok && res?.cancelled) {
        if (preSettled) settling.push(preSettled);
        collectSettled(cur.id);
      }
      if (!res?.ok || !(res.cancelled || res.alreadyFinished || res.reconciledOrphan)) {
        refusals.push({ threadId: cur.id, cancelState: res?.cancelState || "failed", error: res?.error || "中断失败" });
      }
    }
    if (refusals.length) {
      throw Object.assign(new Error(`无法归档仍在运行的成员（${refusals.map(r => r.error).join("；")}），已保留会话。`),
        { code: "THREAD_STILL_RUNNING", refusals });
    }

    for (const t of toArchive) collectSettled(t.id);
    if (settling.length) await Promise.race([Promise.allSettled(settling), new Promise((r) => { const timer = setTimeout(r, 5000); timer.unref?.(); })]);

    const stillBusy = toArchive.map(t => ctx.db.getThread(t.id, { includeQueue: false }))
      .filter(t => t && (ctx.activeRunByThread.has(t.id) || isThreadBusyStatus(t.status)));
    if (stillBusy.length) throw Object.assign(new Error("停止尚未完成或成员已进入下一回合，已保留会话。"),
      { code: "THREAD_STILL_RUNNING", threadIds: stillBusy.map(t => t.id) });
    const deletedIds = [];
    for (const t of toArchive) {
      // Manual / whole-conversation archives drop the member's board history; only idle-clone sweeps keep it.
      ctx.db.upsertThread({ id: t.id, archived: true, meta: { keepBoardHistory: false } });
      deletedIds.push(t.id);
      ctx.context.emitEvent({
        type: "thread_deleted",
        threadId: t.id,
        rootConversationId: conversationRoot || undefined,
        workspace: t.workspace || t.cwd,
      });
    }
    return deletedIds;
  }

  const IDLE_CLONE_TERMINAL_STATUSES = new Set(["completed", "failed", "interrupted"]);

  function isConversationHostRoot(t) {
    return Boolean(t.isNativeHost && (!t.parentThreadId || t.role === "commander" || String(t.meta?.memberName || "").toLowerCase() === "coordinator"));
  }

  function idleCloneSlotKey(t) {
    if (t.presetKey) return `preset:${t.presetKey}`;
    const baseName = String(t.meta?.baseMemberName || t.memberName || t.meta?.memberName || deriveCleanMemberName(t))
      .replace(/-\d+$/, "").toLowerCase();
    return `custom:${t.provider}:${t.role}:${baseName}`;
  }

  /** Archive finished duplicate member cards of one conversation, keeping 1 resident card per role slot and their board history. */
  function archiveIdleClones(params = {}) {
    const rootConvId = String(params.rootConversationId || params.conversationId || ctx.scopePolicy.policyRoot(params) || "").trim();
    if (!rootConvId) throw new Error("deleteThread 归档闲置分身需要提供 conversationId 或 threadId");
    const threads = ctx.db.listThreads({
      rootConversationId: rootConvId,
      includeSubagents: true,
      includeArchived: false,
      includeQueue: true,
      limit: 500,
    });
    const pendingIds = new Set(ctx.db.listPendingRequests({}).map(r => r.threadId));
    const isProtected = t => ctx.activeRunByThread.has(t.id) || ctx.pendingTurnStartLocks.has(t.id) || isThreadBusyStatus(t.status) ||
      pendingIds.has(t.id) || (t.queue?.length > 0) || Boolean(t.worktreePath && existsSync(t.worktreePath));
    const isSharedCard = t => !t.worktreePath && t.isolation !== "worktree";

    const slots = new Map();
    for (const t of threads) {
      if (isConversationHostRoot(t) || t.isSwarmMember || t.meta?.isSwarmMember) continue;
      const key = idleCloneSlotKey(t);
      if (!slots.has(key)) slots.set(key, []);
      slots.get(key).push(t);
    }

    const deletedIds = [];
    for (const group of slots.values()) {
      // Resident card: shared-directory cards first (reusable by the next dispatch), then most recently updated.
      const ordered = [...group].sort((a, b) => Number(isSharedCard(b)) - Number(isSharedCard(a)) || (b.updatedAt || 0) - (a.updatedAt || 0));
      for (const t of ordered.slice(1)) {
        if (isProtected(t) || !IDLE_CLONE_TERMINAL_STATUSES.has(String(t.status || "").toLowerCase())) continue;
        ctx.db.upsertThread({ id: t.id, archived: true, meta: { keepBoardHistory: true, archivedReason: "idle_clone" } });
        deletedIds.push(t.id);
        ctx.context.emitEvent({
          type: "thread_archived",
          threadId: t.id,
          rootConversationId: rootConvId,
          keepBoardHistory: true,
          workspace: t.workspace || t.cwd,
        });
      }
    }
    return { deleted: true, scope: "idle_clones", rootConversationId: rootConvId, deletedIds, keptCount: threads.length - deletedIds.length };
  }

  async function deleteThread(params = {}) {
    if (params.scope === "idle_clones" || params.archiveIdleClones === true) return archiveIdleClones(params);
    const archiveConversation = params.archiveConversation === true || params.scope === "conversation";
    if (archiveConversation) {
      const rootConvId = String(params.rootConversationId || params.conversationId || ctx.scopePolicy.policyRoot(params) || "").trim();
      if (!rootConvId) throw new Error("deleteThread 按会话归档需要提供 conversationId 或 threadId");
      const toArchive = ctx.db.listThreads({
        rootConversationId: rootConvId,
        includeSubagents: true,
        includeArchived: false,
        limit: 500,
      }).filter(t => !isConversationHostRoot(t));
      const deletedIds = await archiveThreads(toArchive, { force: Boolean(params.force), conversationRoot: rootConvId });
      return { deleted: true, rootConversationId: rootConvId, deletedIds };
    }

    const key = params.threadId || params.taskId || params.id;
    if (!key) throw new Error("deleteThread 需要提供 threadId");
    const target = ctx.db.getThread(key, { includeQueue: false });
    if (!target) throw new Error(`找不到会话: ${key}`);

    const cascade = params.cascade !== false;
    const toArchive = [target];
    if (cascade) {
      const allThreads = ctx.db.listThreads({ includeSubagents: true, includeArchived: true, limit: 500 });
      const visited = new Set([target.id]);
      const queue = [target.id];
      while (queue.length > 0) {
        const pid = queue.shift();
        for (const t of allThreads) {
          if (t.parentThreadId === pid && !visited.has(t.id)) {
            visited.add(t.id);
            toArchive.push(t);
            queue.push(t.id);
          }
        }
      }
    }
    const deletedIds = await archiveThreads(toArchive, { force: Boolean(params.force) });
    return { deleted: true, threadId: target.id, deletedIds };
  }

  return {
    cancelTask,
    computeCancelCapability,
    deleteThread,
    describeRunOwner,
    stopThreadExecution,
    withCancelCapability,
  };
}

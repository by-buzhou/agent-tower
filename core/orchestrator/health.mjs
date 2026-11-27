export function createHealthModule(ctx) {
  async function listHealthIncidents(params = {}) {
    const root = ctx.scopePolicy.policyRoot(params);
    const workspace = !root && params.workspace ? await ctx.queries.resolveRepoRootCached(params.workspace) : undefined;
    return { ok: true, incidents: ctx.db.listHealthIncidents({ rootConversationId: root || undefined,
      workspace, includeResolved: params.includeResolved }) };
  }

  async function dismissHealthIncident(params = {}) {
    const root = ctx.scopePolicy.policyRoot(params);
    const workspace = !root && params.workspace ? await ctx.queries.resolveRepoRootCached(params.workspace) : undefined;
    const candidates = params.dismissAll
      ? ctx.db.listHealthIncidents({ rootConversationId: root || undefined, workspace })
      : [ctx.db.getHealthIncident(params.incidentId)].filter(Boolean);
    const dismissedCount = ctx.db.dismissHealthIncident({ incidentId: params.incidentId, rootConversationId: root || undefined,
      workspace, dismissAll: params.dismissAll });
    const dismissed = candidates.filter(c => c.status === "open" && ctx.db.getHealthIncident(c.id)?.status === "resolved");
    const dismissedIds = dismissed.map(c => c.id);
    // Keep the member badge in sync with the banner: clear the thread's soft health state tied to the dismissed alert.
    for (const incident of dismissed) {
      const thread = incident.threadId && ctx.db.getThread(incident.threadId, { includeQueue: false });
      const health = thread?.meta?.health;
      if (!health || !(health.incidentId === incident.id || (!health.incidentId && health.runId === incident.runId &&
        health.state === "suspected_stall" && incident.kind === "suspected_stall"))) continue;
      const updated = ctx.db.upsertThread({ id: thread.id, meta: { health: { state: "healthy", runId: health.runId || incident.runId,
        dismissedIncidentId: incident.id, updatedAt: Date.now() } } });
      ctx.context.emitEvent({ type: "thread_updated", threadId: thread.id, workspace: updated.workspace || updated.cwd,
        healthCleared: true, thread: updated });
    }
    const { incidents } = await listHealthIncidents({ conversationId: root, workspace });
    ctx.context.emitEvent({ type: "health_incident", rootConversationId: root, workspace, dismissedCount, dismissedIds, incidents });
    return { ok: true, dismissedCount, dismissedIds, incidents };
  }

  // Resolve soft `suspected_stall` alerts of a thread (optionally a single run) and report what changed.
  function resolveSoftStallIncidents(thread, runId) {
    const resolved = [];
    for (const incident of ctx.db.listHealthIncidents({ rootConversationId: ctx.scopePolicy.threadPolicyRoot(thread) })) {
      if (incident.threadId !== thread.id || incident.kind !== "suspected_stall") continue;
      if (runId && incident.runId !== runId) continue;
      resolved.push(ctx.db.upsertHealthIncident({ id: incident.id, status: "resolved", actionTaken: "auto_resolved" }));
    }
    return resolved;
  }

  function publishHealth(thread, runId, { kind, detail, retryAttempt = 0 }, notify = false) {
    const rootConversationId = ctx.scopePolicy.threadPolicyRoot(thread);
    const retry = kind === 'transient_retry';
    const warning = kind === 'suspected_stall';
    const baseId = retry ? `health_${runId}_${kind}_${retryAttempt}` : `health_${runId}_${kind}`;
    const entry = warning && ctx.activeRuns.get(runId);
    const episode = entry ? (entry.stallEpisodes = (entry.stallEpisodes || 0) + 1) : 1;
    // A second stall in the same run is not the dismissed incident from the first episode.
    const id = episode > 1 ? `${baseId}_${episode}` : baseId;
    const titles = {
      transient_retry: '瞬时故障，已安排重试', suspected_stall: '外部子任务疑似卡住',
      stall_terminated: '外部子任务无响应，已终止', doom_loop: '工具调用死循环已熔断',
      quota_exhausted: '外部引擎额度已耗尽', fatal_error: '外部子任务失败',
    };
    const previous = ctx.db.getHealthIncident(id);
    // A soft stall that recovered may stall again within the same run: reopen it instead of staying silent.
    if (previous && !(warning && previous.status === 'resolved')) return;
    const shouldWake = notify && rootConversationId && !ctx.flags.shuttingDown;
    const incident = ctx.db.upsertHealthIncident({
      id, rootConversationId, threadId: thread.id, runId, kind, title: titles[kind], detail,
      severity: retry ? 'info' : warning ? 'warning' : 'error', status: retry ? 'resolved' : 'open',
      actionTaken: retry ? 'auto_retry_scheduled' : warning ? 'warning_only' :
        ['stall_terminated', 'doom_loop'].includes(kind) ? 'run_cancelled' : 'none',
      retryAttempt, notifiedAt: shouldWake ? Date.now() : null, ...(previous ? { resolvedAt: null } : {}),
    });
    const updatedThread = ctx.db.upsertThread({ id: thread.id,
      meta: { health: { state: kind, runId, incidentId: id, retryAttempt, updatedAt: incident.updatedAt } },
    });
    ctx.context.emitEvent({ type: 'health_incident', rootConversationId, threadId: thread.id, runId,
      workspace: thread.workspace, incident, thread: updatedThread });
    if (shouldWake) {
      const message = `【AgentTower】${titles[kind]}。线程：${thread.title}。${detail.slice(0, 240)}`;
      void Promise.resolve().then(() => (0, ctx.hostWakeSender)({ conversationId: rootConversationId, message,
        agentApiExe: ctx.hostContext.agentApiExe, projectId: ctx.hostContext.projectId,
        lsAddress: ctx.hostContext.lsAddress, csrfToken: ctx.hostContext.csrfToken,
      })).then(result => { if (result?.ok === false) (0, ctx.log)('Host wake delivery failed'); })
        .catch(() => (0, ctx.log)('Host wake delivery failed'));
    }
  }

  function handleWatchdogSignal(state, signal) {
    const entry = ctx.activeRuns.get(state.runId);
    if (!entry || entry.cancelRequested || entry.handle?.passiveHost || ctx.flags.shuttingDown) return;
    if (signal.kind === 'suspected_stall') {
      const thread = ctx.db.getThread(entry.threadId, { includeQueue: false });
      if (thread) publishHealth(thread, state.runId, signal);
      return;
    }
    entry.watchdogFailure = signal;
    // Defer until synchronous driver callbacks have returned the process handle.
    queueMicrotask(() => {
      if (ctx.activeRuns.get(state.runId) !== entry || entry.handle?.passiveHost) return;
      const kill = Promise.resolve().then(() => {
        const handle = entry.handle;
        return (handle?.forceKill || handle?.cancel)?.call(handle);
      }).catch(() => {});
      const deadline = setTimeout(entry.finishWatchdogKill, ctx.watchdogOptions?.killTimeoutMs ?? 5000);
      void kill.then(() => { clearTimeout(deadline); entry.finishWatchdogKill(); });
    });
  }

  // Watchdog automatic recovery: a warned run produced real activity again, so close its soft alert.
  function handleStallRecovered(state) {
    const entry = ctx.activeRuns.get(state.runId);
    if (!entry || entry.cancelRequested || entry.handle?.passiveHost || ctx.flags.shuttingDown || ctx.flags.dbClosed) return;
    const thread = ctx.db.getThread(entry.threadId, { includeQueue: false });
    if (!thread) return;
    const resolved = resolveSoftStallIncidents(thread, state.runId);
    const updated = ctx.db.upsertThread({ id: thread.id, meta: { health: { state: "healthy", runId: state.runId, updatedAt: Date.now() } } });
    for (const incident of resolved) {
      ctx.context.emitEvent({ type: "health_incident_resolved", rootConversationId: incident.rootConversationId || ctx.scopePolicy.threadPolicyRoot(thread),
        threadId: thread.id, runId: state.runId, workspace: thread.workspace, incidentId: incident.id, incident, thread: updated });
    }
    ctx.context.emitEvent({ type: "thread_updated", threadId: thread.id, workspace: updated.workspace || updated.cwd, healthRecovered: true, thread: updated });
  }

  return {
    dismissHealthIncident,
    handleStallRecovered,
    handleWatchdogSignal,
    listHealthIncidents,
    publishHealth,
    resolveSoftStallIncidents,
  };
}

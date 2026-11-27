import path from "node:path";
import { runGit } from "../worktree.mjs";
import { assertReadOnlySupport, curatorRestrictions, resolveRoleTarget } from "../catalog.mjs";
import { rootRejection, inside } from "../storage-paths.mjs";
import { classifyEngineError, safeEngineError } from "../engines/proc-utils.mjs";
import {
  ACTIVE_RUN_STATUSES,
  assertExternalDispatch,
  OWNER_STARTED_AT,
  foreignRunOwnerPid,
  projectPathKey,
  isIsolatedWorktreePath,
  makeId,
  summarizeOutput,
  shouldHideExternalSession,
} from "./helpers.mjs";

export function createExecutionModule(ctx) {
  const builtInRunTurn = ctx.engineManager.runTurn;
  function launchTurn({ sessionPrompt, ...options }) {
    // The built-in manager forwards only `prompt`. Other launch adapters receive separate strings.
    if (ctx.engineManager.runTurn === builtInRunTurn) options.prompt = sessionPrompt;
    return ctx.engineManager.runTurn(options);
  }

  // Startup crash recovery: mark orphaned running/starting/waiting threads, runs & runtime requests from dead daemon
  function recoverStaleStateOnStartup() {
    const staleThreads = ctx.db.listThreads({
      statuses: ["running", "starting", "preparing", "waiting", "waiting_approval", "waiting_input"],
      includeSubagents: true,
      limit: 1000,
    });
    for (const t of staleThreads) {
      if (t.meta?.isNativeHost || String(t.id || "").startsWith("thr_native_")) {
        // Daemon restart is not evidence that the host turn settled.
        continue;
      }
      // Another live daemon sharing this project database still owns the turn: leave it alone.
      if (ctx.cancellation.describeRunOwner(t).foreignOwnerPid) continue;
      const runs = ctx.db.listRuns({
        threadId: t.id,
        statuses: ["running", "starting", "preparing", "waiting", "waiting_approval", "waiting_input"],
        limit: 50,
      });
      for (const r of runs) {
        ctx.db.upsertRun({
          id: r.id,
          threadId: t.id,
          status: "interrupted",
          stopReason: "daemon_restarted",
          error: "Daemon restarted before turn completed",
          completedAt: Date.now(),
        });
      }
      ctx.db.upsertThread({
        id: t.id,
        status: "interrupted",
        activeRunId: null,
        lastError: t.lastError || "Interrupted by daemon restart",
      });
    }
    const staleReqs = ctx.db.listPendingRequests({});
    for (const req of staleReqs) {
      const thread = ctx.db.getThread(req.threadId, { includeQueue: false });
      if (thread?.meta?.isNativeHost || String(req.threadId).startsWith("thr_native_")) continue;
      const run = req.runId ? ctx.db.getRun(req.runId) : null;
      if (ACTIVE_RUN_STATUSES.includes(run?.status) && foreignRunOwnerPid(run)) continue;
      ctx.db.upsertRuntimeRequest({
        ...req,
        status: "cancelled",
        decision: "cancelled",
        resolvedAt: Date.now(),
      });
    }
  }

  // A thread's stored directory is as explicit as a caller-supplied cwd: never silently run elsewhere. Only a removed
  // isolated worktree degrades to the thread's own primary project root.
  function resolveThreadExecutionCwd(thread) {
    const candidate = thread.worktreePath || thread.cwd || thread.workspace;
    if (!candidate) return ctx.scopePolicy.executionRoot(thread);
    const reason = rootRejection(String(candidate), ctx.dataDir);
    if (!reason) return ctx.db.resolveRoot(candidate);
    const worktreeGone = reason === "missing" && (candidate === thread.worktreePath || isIsolatedWorktreePath(candidate));
    const primary = thread.meta?.projectRoot || thread.workspace;
    if (worktreeGone && primary && primary !== candidate && !rootRejection(String(primary), ctx.dataDir)) return ctx.db.resolveRoot(primary);
    return ctx.scopePolicy.assertUsableRoot(candidate, worktreeGone ? "工作树目录" : "线程工作目录");
  }

  function startEngineExecution({
    thread,
    run,
    effectivePrompt,
    ephemeral,
    nativeReview = false,
    reuseNativeSession = false,
    transientRetryCount = 0,
    synchronous = false,
    launchDriver = launchTurn,
  }) {
    const threadId = thread.id;
    const runId = run.id;
    const curator = ctx.specs.isCuratorThread(thread, run);
    const restrictions = curator ? curatorRestrictions(run.provider || thread.provider) : null;
    const workspace = thread.meta?.projectRoot || thread.workspace || thread.cwd;
    if (curator) ctx.specs.assertCuratorAvailable(workspace, runId);
    let targetCwd, cwdError;
    try {
      targetCwd = resolveThreadExecutionCwd(curator ? { ...thread, cwd: workspace, worktreePath: null } : thread);
      for (const [root, action] of ctx.worktreeOperations) {
        if (projectPathKey(targetCwd) === projectPathKey(root) || inside(root, targetCwd)) {
          throw Object.assign(new Error(`工作树正在${action}，未启动回合。`), { code: "WORKTREE_BUSY" });
        }
      }
    } catch (error) {
      cwdError = error;
      targetCwd = ctx.db.defaultStudioRoot;
    }
    const settings = ctx.db.getSettings(workspace);
    const effectiveEphemeral = ephemeral ?? shouldHideExternalSession(ctx.db, thread, thread.meta?.projectRoot || thread.workspace || thread.cwd);

    const attemptKey = transientRetryCount ? `${runId}_retry_${transientRetryCount}` : runId;
    const reasoningItemId = `item_think_${attemptKey}`;
    const messageItemId = `item_msg_${attemptKey}`;
    const todoItemId = `item_todo_${attemptKey}`;

    const blocked = ctx.scopePolicy.dispatchBypass({ threadId, _manualCurationBypass: run?.meta?.triggerSource === "manual" }, thread);
    if (blocked) {
      ctx.db.upsertRun({ id: runId, threadId, status: 'interrupted', stopReason: blocked.status, completedAt: Date.now() });
      ctx.db.upsertThread({ id: threadId, status: 'interrupted', activeRunId: null });
      return { ...blocked, settledPromise: Promise.resolve(ctx.db.getRun(runId)) };
    }
    const startedAt = Date.now();
    // A fresh turn starts without the previous turn's leftover health badge (retries keep their own state).
    const staleHealth = !transientRetryCount && thread.meta?.health && thread.meta.health.runId !== runId;
    const updatedThread = ctx.db.upsertThread({
      id: threadId,
      status: "running",
      activeRunId: runId,
      lastError: null,
      ...(curator ? { ...restrictions, role: "curator" } : {}),
      ...(staleHealth ? { meta: { health: { state: "healthy", runId, updatedAt: startedAt } } } : {}),
    });
    const updatedRun = ctx.db.upsertRun({
      id: runId,
      threadId,
      status: "running",
      startedAt,
      ...(curator ? { ...restrictions, role: "curator", cwd: targetCwd } : {}),
      meta: {
        ownerPid: process.pid,
        ownerStartedAt: OWNER_STARTED_AT,
        title: updatedThread.title || "",
        taskId: updatedThread.taskId || "",
        usageReported: Boolean(run.meta?.usageReported),
      },
    });

    let finishWatchdogKill;
    const forcedSettlement = new Promise(resolve => { finishWatchdogKill = resolve; });
    const runEntry = {
      finishWatchdogKill, effectivePrompt, ephemeral, effectiveEphemeral, nativeReview, synchronous, launchDriver,
      runId,
      threadId,
      startedAt,
      handle: null,
      steeringRestartPending: null,
      spawnStartedAt: null,
      timings: {
        queueWaitMs: Math.max(0, startedAt - Number(updatedRun.createdAt || startedAt)),
        prepMs: 0,
        spawnMs: 0,
        sessionBoundMs: null,
        firstEventMs: null,
        firstTextMs: null,
        totalMs: 0,
        planBytes: 0,
        specBytes: 0,
        effectivePromptBytes: Buffer.byteLength(String(effectivePrompt || ""), "utf8"),
        specInlineCount: 0,
        reusedSession: 0,
        transport: "",
      },
    };
    ctx.activeRuns.set(runId, runEntry);
    ctx.activeRunByThread.set(threadId, runId);
    if (curator) runEntry.curation = ctx.specs.startCurator(updatedThread, updatedRun);
    else ctx.specs.onWorkStarted(updatedThread);

    // Emitted after the run is registered so the attached `cancelCapability` reflects the live (stoppable) turn.
    ctx.context.emitEvent({
      type: "run_started",
      threadId,
      runId,
      inputIntent: updatedRun.inputIntent || "",
      title: updatedRun.meta?.title || updatedThread.title || "",
      taskId: updatedRun.meta?.taskId || updatedThread.taskId || "",
      startedAt,
      createdAt: updatedRun.createdAt || startedAt,
      workspace: updatedThread.workspace || targetCwd,
      provider: updatedRun.provider,
      model: updatedRun.model,
      effort: updatedRun.effort,
      run: updatedRun,
      thread: updatedThread,
    });
    const state = ctx.watchdog.start({ runId, threadId, provider: updatedRun.provider, startedAt, transientRetryCount,
      managed: !updatedThread.isNativeHost });

    const acceptsDriverEvents = () => !ctx.flags.dbClosed && !runEntry.retryPending && !runEntry.watchdogFailure &&
      !runEntry.cancelRequested && ctx.activeRuns.get(runId) === runEntry;
    let handle, preparation;
    runEntry.prepStartedAt = Date.now();
    function launchPrepared(preloadedTop, preloadedMainDrafts) {
      if (!updatedThread.isNativeHost && updatedRun.provider === "antigravity") {
        // A host can attach after a managed turn was queued or put into retry backoff.
        assertExternalDispatch(ctx.engineManager, { ...updatedRun, routing: updatedRun.meta, isolation: updatedThread.isolation },
          updatedThread.presetKey || updatedThread.role, updatedRun.prompt);
      }
      assertReadOnlySupport(updatedRun.provider, updatedRun.permissionMode || updatedThread.permissionMode);
      const runtimeProviderCfg = ctx.catalogSettings.getRuntimeProviderConfig(updatedRun.provider, settings);
      const canUseNativeHostBridge = updatedRun.provider === "antigravity" &&
        Boolean(updatedThread.isNativeHost) && Boolean(ctx.engineManager.getHostContext?.()?.hostBridgeAvailable);
      const oldSessionId = updatedThread.nativeSessionId || undefined;
      const nativeHost = Boolean(updatedThread.isNativeHost);
      const expectedSessionId = reuseNativeSession && !effectiveEphemeral && !nativeReview && !nativeHost
        ? oldSessionId : undefined;
      runEntry.timings.reusedSession = expectedSessionId ? 1 : 0;
      const transport = (updatedRun.provider === "antigravity" ? canUseNativeHostBridge : nativeReview || runtimeProviderCfg?.protocol === "cli") ? "argv" : "stdin";
      runEntry.timings.transport = transport;
      const specTurn = ctx.specs.prepareTurn({ thread: updatedThread, run: updatedRun, cwd: targetCwd,
        expectedSessionId, hideExternalSession: effectiveEphemeral, nativeReview, nativeHost, transport, dynamicPrompt: effectivePrompt,
        preloadedTop, preloadedMainDrafts, selectsPromptOnSend: launchDriver === launchTurn && ctx.engineManager.runTurn === builtInRunTurn });
      runEntry.timings.prepMs = Math.max(0, Date.now() - runEntry.prepStartedAt);
      runEntry.specTurn = specTurn;
      runEntry.timings.effectivePromptBytes = Buffer.byteLength(String(specTurn.deltaPrompt || ""), "utf8");
      runEntry.curation?.snapshot();
      runEntry.spawnStartedAt = Date.now();
      const driver = launchDriver({
        runId,
        threadId,
        title: updatedThread.title,
        provider: updatedRun.provider,
        providerConfig: runtimeProviderCfg,
        inheritHostMcp: !curator && updatedRun.meta?.inheritHostMcp === true,
        customProviders: ctx.catalogSettings.getRuntimeCustomProvidersList(settings),
        model: updatedRun.model,
        effort: updatedRun.effort,
        permissionMode: updatedRun.permissionMode || updatedThread.permissionMode,
        interactionMode: updatedRun.interactionMode || updatedThread.interactionMode,
        cwd: targetCwd,
        nativeSessionId: nativeHost && (updatedThread.isNativeHost || reuseNativeSession) ? oldSessionId : expectedSessionId,
        forceAcp: updatedRun.provider === "antigravity" && !canUseNativeHostBridge,
        isNativeHost: updatedThread.isNativeHost,
        hostEnv: ctx.hostSync.buildHostEnvForDriver(),
        appDataDir: ctx.hostContext.appDataDir,
        prompt: specTurn.deltaPrompt,
        sessionPrompt: specTurn.sessionPrompt,
        freshSessionPrompt: specTurn.freshSessionPrompt,
        ephemeral: effectiveEphemeral,
        onEvent(evt) {
          if (!acceptsDriverEvents()) return;
          const eventAt = Date.now();
          if (runEntry.timings.firstEventMs === null) runEntry.timings.firstEventMs = Math.max(0, eventAt - runEntry.spawnStartedAt);
          if (evt.type === "session_bound") {
            if (runEntry.timings.sessionBoundMs === null) runEntry.timings.sessionBoundMs = Math.max(0, eventAt - runEntry.spawnStartedAt);
            runEntry.timings.reusedSession = Number(evt.resumed ?? Boolean(expectedSessionId && expectedSessionId === evt.nativeSessionId));
            if (evt.resumed === false) runEntry.timings.effectivePromptBytes = Buffer.byteLength(String(specTurn.freshSessionPrompt || ""), "utf8");
          }
          if (runEntry.timings.firstTextMs === null && ["message_delta", "assistant_message"].includes(evt.type) && (evt.delta || evt.text)) {
            runEntry.timings.firstTextMs = Math.max(0, eventAt - runEntry.spawnStartedAt);
          }
          ctx.watchdog.observe(runId, evt);
          specTurn.observe(evt);
          handleDriverEvent(updatedThread, updatedRun, evt, {
            attemptKey,
            reasoningItemId,
            messageItemId,
            todoItemId,
            ephemeral: effectiveEphemeral || nativeReview,
          });
        },
        onPermissionRequest: curator ? undefined : reqPayload => {
          if (acceptsDriverEvents()) handleDriverRuntimeRequest(updatedThread, updatedRun, "approval", reqPayload);
        },
        onQuestionRequest(reqPayload) {
          if (acceptsDriverEvents()) handleDriverRuntimeRequest(updatedThread, updatedRun, "user-input", reqPayload);
        },
      });
      runEntry.timings.spawnMs = Math.max(0, Date.now() - runEntry.spawnStartedAt);
      runEntry.handle = driver;
      state.managed = !driver.passiveHost;
      if (driver.retrySafe === false) state.hasSideEffects = true;
      return driver;
    }
    try {
      if (cwdError) throw cwdError;
      const repoRoot = updatedThread.meta?.projectRoot || updatedThread.workspace || targetCwd;
      if (path.relative(repoRoot, targetCwd) === "") {
        handle = launchPrepared(targetCwd, "");
      } else {
        const readGit = (cwd, ...args) => runGit(["--no-optional-locks", ...args], { cwd }).then(r => r.stdout, () => null);
        preparation = (async () => {
          const top = (await readGit(targetCwd, "rev-parse", "--show-toplevel"))?.trim() || targetCwd;
          const drafts = !curator && ctx.db.isProjectSpecEnabled(repoRoot) && path.relative(top, repoRoot) ? await readGit(repoRoot, "status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ".agent-tower/spec") : "";
          if (!acceptsDriverEvents() || ctx.flags.shuttingDown || ctx.scopePolicy.dispatchBypass({ threadId })) return { result: { status: "interrupted" } };
          return launchPrepared(top, drafts);
        })();
        handle = { result: preparation.then(driver => driver.result) };
      }
    } catch (error) {
      if (runEntry.spawnStartedAt !== null) runEntry.timings.spawnMs = Math.max(0, Date.now() - runEntry.spawnStartedAt);
      else if (runEntry.prepStartedAt) runEntry.timings.prepMs = Math.max(0, Date.now() - runEntry.prepStartedAt);
      handle = { result: Promise.reject(error) };
    }

    if (!preparation) runEntry.handle = handle;
    const root = ctx.scopePolicy.threadPolicyRoot(updatedThread);
    const curPolicy = root ? ctx.scopePolicy.readConversationPolicy(root) : null;
    if (root && curPolicy?.dispatchEnabled && !ctx.db.getConversationPolicyRecord(root)) {
      ctx.db.setConversationPolicyRecord({ conversationId: root, orchestrationMode: curPolicy.orchestrationMode, dispatchEnabled: curPolicy.dispatchEnabled, source: 'latched', threadId });
      ctx.context.emitEvent({ type: 'conversation_policy_updated', rootConversationId: root, threadId,
        workspace: thread.workspace, conversationPolicy: ctx.scopePolicy.getConversationPolicy({ threadId }), activeMode: ctx.scopePolicy.getActiveModeSummary({ threadId }) });
    }
    const driverResult = Promise.resolve(handle.result).catch(error => ({
      status: 'failed', error: error?.message || String(error), ...classifyEngineError(error), code: error?.code,
    }));
    const settledPromise = Promise.race([driverResult, forcedSettlement]).then(async result => {
      if (ctx.flags.dbClosed || result?.detached) {
        if (!ctx.flags.dbClosed) runEntry.curation?.finish({ status: 'interrupted' }, '');
        ctx.watchdog.stop(runId);
        ctx.activeRuns.delete(runId);
        if (ctx.activeRunByThread.get(threadId) === runId) ctx.activeRunByThread.delete(threadId);
        return result;
      }
      return finalizeRun(threadId, runId, startedAt, result, runEntry);
    });
    runEntry.settledPromise = settledPromise;
    return { handle, settledPromise, started: preparation?.then(() => {}, () => {}) };
  }

  function handleDriverEvent(thread, run, evt, itemIds) {
    const threadId = thread.id;
    const runId = run.id;
    const ws = thread.workspace || thread.cwd;

    if (["tool_call", "command_execution", "file_change"].includes(evt.type)) {
      ctx.db.upsertThread({ id: threadId, updatedAt: Date.now() });
    }

    if (evt.type === 'assistant_delta') evt = { ...evt, type: 'message_delta' };
    switch (evt.type) {
      case "runtime_request_cancelled": {
        const req = ctx.db.getRuntimeRequest(evt.requestId);
        if (req?.runId !== runId || req.status !== "pending") break;
        ctx.db.upsertRuntimeRequest({ ...req, status: "cancelled", decision: "cancelled", resolvedAt: Date.now() });
        ctx.turns.publishRuntimeRequestResolution(req, "cancelled");
        break;
      }
      case "effective_model": {
        if (evt.effectiveModel) {
          const run = ctx.db.getRun(runId);
          ctx.db.upsertRun({ id: runId, threadId, meta: { ...run?.meta, effectiveModel: evt.effectiveModel } });
          ctx.context.emitEvent({ type: "effective_model", threadId, runId, workspace: ws, effectiveModel: evt.effectiveModel });
        }
        break;
      }
      case "session_bound": {
        if (evt.nativeSessionId) {
          const cur = ctx.db.getThread(threadId, { includeQueue: false });
          const isNative = Boolean(evt.isNativeHost || cur?.meta?.isNativeHost);
          const hostConvId = evt.hostConversationId || (isNative ? evt.nativeSessionId : cur?.hostConversationId || "");
          if (!itemIds.ephemeral) ctx.db.upsertThread({
            id: threadId,
            nativeSessionId: evt.nativeSessionId,
            ...(hostConvId ? { hostConversationId: hostConvId } : {}),
            ...(isNative
              ? { meta: { ...(cur?.meta || {}), isNativeHost: true, hostConversationId: hostConvId } }
              : {}),
          });
          if (!itemIds.ephemeral) ctx.db.upsertRun({ id: runId, threadId, nativeSessionId: evt.nativeSessionId });
          ctx.context.emitEvent({
            type: "session_bound",
            threadId,
            runId,
            workspace: ws,
            nativeSessionId: evt.nativeSessionId,
            resumed: evt.resumed ?? (evt.nativeSessionId === thread.nativeSessionId),
            ...(evt.effectiveModel ? { effectiveModel: evt.effectiveModel } : {}),
            ...(isNative ? { isNativeHost: true, hostConversationId: hostConvId } : {}),
          });
        }
        break;
      }
      case "title_updated": {
        if (evt.title) {
          const cur = ctx.db.getThread(threadId, { includeQueue: false });
          if (cur && (!cur.title || cur.title === "New Session" || cur.title === "Agent Task")) {
            const nextT = ctx.db.upsertThread({ id: threadId, title: evt.title });
            ctx.context.emitEvent({
              type: "title_updated",
              threadId,
              runId,
              workspace: ws,
              title: evt.title,
              thread: nextT,
            });
          }
        }
        break;
      }
      case "reasoning_delta": {
        const delta = evt.delta ?? evt.text ?? "";
        if (!delta) break;
        const tItemId = evt.itemId ? `item_think_${itemIds.attemptKey}_${evt.itemId}` : itemIds.reasoningItemId;
        ctx.db.appendTurnItemDelta(tItemId, {
          threadId,
          runId,
          type: "reasoning",
          title: "Thinking",
          textDelta: delta,
          status: "streaming",
        });
        ctx.context.emitEvent({
          type: "reasoning_delta",
          threadId,
          runId,
          workspace: ws,
          itemId: tItemId,
          delta,
        });
        break;
      }
      case "message_delta": {
        const delta = evt.delta ?? evt.text ?? "";
        if (!delta) break;
        const mItemId = evt.itemId ? `item_msg_${itemIds.attemptKey}_${evt.itemId}` : itemIds.messageItemId;
        ctx.db.appendTurnItemDelta(mItemId, {
          threadId,
          runId,
          type: "assistant_message",
          textDelta: delta,
          status: "streaming",
        });
        ctx.context.emitEvent({
          type: "message_delta",
          threadId,
          runId,
          workspace: ws,
          itemId: mItemId,
          delta,
          phase: evt.phase || "final_answer",
        });
        break;
      }
      case "tool_call": {
        const rawToolId = evt.toolCallId || evt.itemId || evt.id || "tool";
        const itemId = rawToolId.startsWith("item_") && itemIds.attemptKey === runId
          ? rawToolId : `item_tool_${itemIds.attemptKey}_${rawToolId}`;
        ctx.db.upsertTurnItem({
          id: itemId,
          threadId,
          runId,
          type: "tool_call",
          role: "tool",
          kind: evt.kind || "other",
          title: evt.title || evt.toolName || evt.name || "Tool Call",
          status: evt.status || "in_progress",
          toolCallId: rawToolId,
          rawInput: evt.rawInput ?? evt.input,
          rawOutput: evt.rawOutput ?? evt.output,
          diff: evt.diff,
          locations: evt.locations,
          meta: {
            toolName: evt.toolName || evt.name,
            exitCode: evt.exitCode ?? null,
            durationMs: evt.durationMs ?? null,
          },
        });
        ctx.context.emitEvent({
          type: "tool_call",
          threadId,
          runId,
          workspace: ws,
          itemId,
          toolCallId: rawToolId,
          toolName: evt.toolName || evt.name || "tool",
          name: evt.name || evt.toolName || "tool",
          kind: evt.kind || "other",
          title: evt.title || evt.toolName || "Tool Call",
          status: evt.status || "in_progress",
          input: evt.input ?? evt.rawInput,
          output: evt.output ?? evt.rawOutput ?? "",
          outputDelta: evt.outputDelta,
          diff: evt.diff,
          locations: evt.locations,
          exitCode: evt.exitCode,
          durationMs: evt.durationMs,
        });
        break;
      }
      case "todo_list": {
        const entries = evt.entries || evt.items || [];
        const textLines = entries.map(
          (e) => `[${e.status || "pending"}] ${e.content || e.title || e.step || ""}`
        );
        ctx.db.upsertTurnItem({
          id: itemIds.todoItemId,
          threadId,
          runId,
          type: "todo_list",
          role: "assistant",
          title: "Plan / Checklist",
          text: textLines.join("\n"),
          status: "completed",
          meta: { entries, items: entries },
        });
        ctx.context.emitEvent({
          type: "todo_list",
          threadId,
          runId,
          workspace: ws,
          itemId: itemIds.todoItemId,
          entries,
          items: entries,
        });
        break;
      }
      case "usage_updated": {
        const u = evt.usage || {};
        const usagePatch = {
          inputTokens: Number(u.inputTokens) || 0,
          cachedTokens: Number(u.cachedTokens ?? u.cachedInputTokens) || 0,
          reasoningTokens: Number(u.reasoningTokens ?? u.reasoningOutputTokens) || 0,
          outputTokens: Number(u.outputTokens) || 0,
          totalTokens: Number(u.totalTokens) || 0,
          contextUsed: Number(evt.contextUsed ?? u.contextUsed) || 0,
          contextLimit: Number(evt.contextLimit ?? u.contextLimit) || 0,
        };
        const meta = { usageReported: true };
        ctx.db.upsertRun({ id: runId, threadId, usage: usagePatch, meta });
        const nextThread = ctx.db.upsertThread({ id: threadId, usage: usagePatch, meta });
        ctx.context.emitEvent({
          type: "usage_updated",
          threadId,
          runId,
          workspace: ws,
          usage: nextThread.usage,
          usageReported: true,
        });
        break;
      }
      case "error": {
        const errMsg = evt.error || evt.message || "Engine error";
        ctx.db.upsertTurnItem({
          id: `item_err_${runId}_${Date.now()}`,
          threadId,
          runId,
          type: "error",
          role: "system",
          title: evt.category ? `Error (${evt.category})` : "Runtime Error",
          text: errMsg,
          status: "failed",
        });
        ctx.context.emitEvent({
          type: "error",
          threadId,
          runId,
          workspace: ws,
          error: errMsg,
          message: errMsg,
          category: evt.category,
        });
        break;
      }
      default:
        break;
    }
  }

  function handleDriverRuntimeRequest(thread, run, kind, reqPayload) {
    const threadId = thread.id;
    const runId = run.id;
    const requestId = reqPayload.requestId || makeId("req");
    const waitStatus = kind === "user-input" ? "waiting_input" : "waiting_approval";
    if (ctx.flags.dbClosed || !ctx.activeRuns.has(runId)) return;
    ctx.watchdog.phase(runId, waitStatus, true);

    const storedReq = ctx.db.upsertRuntimeRequest({
      id: requestId,
      threadId,
      runId,
      provider: reqPayload.provider || run.provider,
      kind,
      status: "pending",
      title:
        reqPayload.title ||
        reqPayload.message ||
        (kind === "user-input" ? "Agent Question" : "Permission Approval Required"),
      toolCallId: reqPayload.toolCallId || null,
      payload: reqPayload,
    });

    ctx.db.upsertRun({ id: runId, threadId, status: waitStatus });
    const waitingThread = ctx.db.upsertThread({ id: threadId, status: waitStatus });

    ctx.context.emitEvent({
      type: "runtime_request",
      threadId,
      runId,
      workspace: thread.workspace || thread.cwd,
      requestId,
      request: storedReq,
      thread: waitingThread,
    });
  }

  async function finalizeRun(threadId, runId, startedAt, result, runEntry) {
    const state = ctx.watchdog.stop(runId);
    const thread = ctx.db.getThread(threadId, { includeQueue: false });
    const ownsRun = thread?.activeRunId === runId;
    const managed = !runEntry.handle?.passiveHost;
    const watchdogFailure = runEntry.watchdogFailure;
    if (watchdogFailure) {
      result = { ...result, status: 'failed', error: watchdogFailure.detail, stopReason: watchdogFailure.kind };
    } else if (runEntry.cancelRequested) {
      result = { ...result, status: 'interrupted', error: null, stopReason: 'cancelled' };
    }
    const specViolation = runEntry.curation?.check();
    if (specViolation) {
      result = { ...result, status: "failed", error: specViolation.message, code: specViolation.code, stopReason: specViolation.code };
    }

    if (ownsRun) runEntry.specTurn?.settle(result);

    const classification = classifyEngineError({ ...result, message: result.error || '' });
    const finalCategory = result.category || classification.category;
    const failure = [classification, result, state?.error].find(e => e?.category === 'quota_exhausted') || {
      category: finalCategory === 'provider_error' ? state?.error?.category || finalCategory : finalCategory,
      retryAfterMs: result.retryAfterMs ?? classification.retryAfterMs ?? state?.error?.retryAfterMs,
    };
    const retryDelay = !specViolation && result.status === 'failed' && ownsRun && !runEntry.cancelRequested &&
      !runEntry.steeringRestartPending && !ctx.flags.shuttingDown
      ? ctx.watchdog.retryDelay(state, failure, !ctx.scopePolicy.dispatchBypass({ threadId })) : null;

    // Cancel any leftover pending runtime requests on this run
    const pendingReqs = ctx.db.listPendingRequests({ threadId }).filter((r) => r.runId === runId);
    for (const req of pendingReqs) {
      ctx.db.upsertRuntimeRequest({
        ...req,
        status: "cancelled",
        decision: "run_ended",
        resolvedAt: Date.now(),
      });
    }

    // Seal any streaming items for this run
    const runItems = ctx.db.listTurnItems({ threadId, runId, view: "activity", limit: 500 });
    for (const it of runItems) {
      if (it.status === "streaming" || it.status === "in_progress") {
        ctx.db.upsertTurnItem({
          id: it.id,
          threadId,
          runId,
          type: it.type,
          status: result.status === "failed" ? "failed" : "completed",
        });
      }
    }

    if (retryDelay !== null) {
      const retryAttempt = state.transientRetryCount + 1;
      runEntry.retryPending = true;
      const delayed = new Promise(resolve => {
        const timer = setTimeout(() => resolve(true), retryDelay);
        const cancel = async () => {
          runEntry.cancelRequested = true;
          clearTimeout(timer);
          resolve(false);
        };
        runEntry.handle = { cancel, forceKill: cancel, steer: async () => ({ supported: false }) };
      });
      ctx.db.upsertRun({ id: runId, threadId, status: 'starting' });
      ctx.db.upsertThread({ id: threadId, status: 'starting' });
      ctx.health.publishHealth(thread, runId, {
        kind: 'transient_retry', retryAttempt, detail: '瞬时故障，将在 ' + retryDelay + ' 毫秒后重试。',
      });
      const elapsed = await delayed;
      if (elapsed && !ctx.flags.shuttingDown && !runEntry.cancelRequested && !ctx.scopePolicy.dispatchBypass({ threadId })) {
        return startEngineExecution({
          thread: ctx.db.getThread(threadId, { includeQueue: false }), run: ctx.db.getRun(runId),
          effectivePrompt: runEntry.effectivePrompt,
          ephemeral: runEntry.ephemeral, nativeReview: runEntry.nativeReview,
          reuseNativeSession: Boolean(thread.nativeSessionId), synchronous: runEntry.synchronous,
          launchDriver: runEntry.launchDriver, transientRetryCount: retryAttempt,
        }).settledPromise;
      }
      if (runEntry.cancelRequested || ctx.flags.shuttingDown) {
        result = { status: 'interrupted', stopReason: 'cancelled' };
      }
    }
    ctx.activeRuns.delete(runId);
    if (ctx.activeRunByThread.get(threadId) === runId) ctx.activeRunByThread.delete(threadId);

    // Every terminal state (completed / interrupted / failed) closes this thread's soft stall warnings; only an
    // explicit hard-timeout kill (`stall_terminated`) keeps a timeout alert open.
    if (managed && thread && !ctx.flags.dbClosed) {
      const softResolved = ctx.health.resolveSoftStallIncidents(thread, ownsRun ? undefined : runId);
      const softHealth = ctx.db.getThread(threadId, { includeQueue: false })?.meta?.health?.state === 'suspected_stall';
      const afterSoft = softHealth && result.status !== 'completed'
        ? ctx.db.upsertThread({ id: threadId, meta: { health: { state: 'healthy', runId, updatedAt: Date.now() } } }) : null;
      for (const incident of softResolved) {
        ctx.context.emitEvent({ type: 'health_incident_resolved', rootConversationId: incident.rootConversationId || ctx.scopePolicy.threadPolicyRoot(thread),
          threadId, runId: incident.runId, workspace: thread.workspace, incidentId: incident.id, incident,
          ...(afterSoft ? { thread: afterSoft } : {}) });
      }
    }

    if (ownsRun && managed && !ctx.flags.shuttingDown && !runEntry.steeringRestartPending) {
      if (result.status === 'failed') {
        const kind = watchdogFailure?.kind || (failure.category === 'quota_exhausted' ? 'quota_exhausted' : 'fatal_error');
        const detail = safeEngineError(result.error || '外部引擎执行失败。');
        const synchronous = runEntry.synchronous || ctx.synchronousWaits.has(runId) || ctx.synchronousWaits.has(threadId);
        ctx.health.publishHealth(thread, runId, { kind, detail }, !synchronous);
      } else if (result.status === 'completed') {
        for (const incident of ctx.db.listHealthIncidents({ rootConversationId: ctx.scopePolicy.threadPolicyRoot(thread) })) {
          if (incident.threadId === threadId) {
            const resolved = ctx.db.upsertHealthIncident({ id: incident.id, status: 'resolved' });
            ctx.context.emitEvent({ type: 'health_incident', rootConversationId: resolved.rootConversationId,
              threadId, runId: resolved.runId, workspace: thread.workspace, incident: resolved });
          }
        }
        ctx.db.upsertThread({ id: threadId, meta: { health: { state: 'healthy', runId, updatedAt: Date.now() } } });
      }
    }

    // Ensure final assistant text is captured if driver returned non-streamed text
    const attemptKey = state?.transientRetryCount ? runId + '_retry_' + state.transientRetryCount : runId;
    const messageId = 'item_msg_' + attemptKey;
    const hasAssistantItem = runItems.some(it => it.type === 'assistant_message' && it.text &&
      (it.id === messageId || it.id.startsWith(messageId + '_') &&
        (state?.transientRetryCount || !it.id.startsWith(messageId + '_retry_'))));
    if (!hasAssistantItem && result.assistantText) {
      ctx.db.upsertTurnItem({
        id: messageId,
        threadId,
        runId,
        type: "assistant_message",
        role: "assistant",
        text: result.assistantText,
        status: "completed",
      });
    }

    const completedAt = Date.now();
    const durationMs = Math.max(0, completedAt - startedAt);
    const summary = summarizeOutput(result.assistantText || result.reviewText || "");

    const usagePatch = result.usage
      ? {
          inputTokens: Number(result.usage.inputTokens) || 0,
          cachedTokens: Number(result.usage.cachedTokens ?? result.usage.cachedInputTokens) || 0,
          reasoningTokens: Number(result.usage.reasoningTokens ?? result.usage.reasoningOutputTokens) || 0,
          outputTokens: Number(result.usage.outputTokens) || 0,
          totalTokens: Number(result.usage.totalTokens) || 0,
          contextUsed: Number(result.usage.contextUsed) || 0,
          contextLimit: Number(result.usage.contextLimit) || 0,
        }
      : undefined;

    const finalStatus =
      result.status === "completed" || result.status === "interrupted" || result.status === "failed"
        ? result.status
        : "completed";

    const latestMeta = ctx.db.getRun(runId)?.meta || {};
    const injectedSpecs = latestMeta.injectedSpecs || {};
    const timings = {
      ...runEntry.timings,
      sessionBoundMs: runEntry.timings.sessionBoundMs ?? 0,
      firstEventMs: runEntry.timings.firstEventMs ?? 0,
      firstTextMs: runEntry.timings.firstTextMs ?? 0,
      totalMs: durationMs,
      planBytes: injectedSpecs.planBytes || 0,
      specBytes: injectedSpecs.specBytes || 0,
      specInlineCount: Number(injectedSpecs.inlineCount) || 0,
    };
    const finishedRun = ctx.db.upsertRun({
      id: runId,
      threadId,
      status: finalStatus,
      nativeSessionId: runEntry.effectiveEphemeral || runEntry.nativeReview ? undefined : result.nativeSessionId || undefined,
      assistantText: result.assistantText || result.reviewText || undefined,
      stopReason: result.stopReason || finalStatus,
      error: result.error || null,
      meta: {
        ...latestMeta,
        ...(result.code ? { errorCode: result.code } : {}),
        ...(result.effectiveModel ? { effectiveModel: result.effectiveModel } : {}),
        timings: { ...(latestMeta.timings || {}), ...timings },
      },
      usage: usagePatch,
      durationMs,
      completedAt,
    });

    const curThread = ctx.db.getThread(threadId, { includeQueue: false });
    const persistedSessionId = runEntry.effectiveEphemeral || runEntry.nativeReview ? undefined : result.nativeSessionId;
    const ownsThread = curThread?.activeRunId === runId;
    const updatedThread = ownsThread ? ctx.db.upsertThread({
      id: threadId,
      status: finalStatus,
      activeRunId: null,
      nativeSessionId: persistedSessionId || curThread?.nativeSessionId || null,
      summary: summary || curThread?.summary || "",
      lastError: finalStatus === "failed" ? result.error || "Run failed" : null,
      usage: usagePatch,
    }) : curThread;

    runEntry.curation?.finish(ownsThread && !ctx.flags.shuttingDown ? result : { status: "interrupted" },
      result.assistantText || runItems.filter(item => item.type === "assistant_message" && item.text &&
        (item.id === messageId || item.id.startsWith(messageId + "_"))).map(item => item.text).join("\n"));
    if (ownsThread && !runEntry.curation) ctx.specs.onWorkSettled(updatedThread, finishedRun);

    ctx.context.emitEvent({
      type: "run_completed",
      threadId,
      runId,
      workspace: updatedThread?.workspace || updatedThread?.cwd,
      status: finalStatus,
      summary: summary || updatedThread?.summary || "",
      durationMs,
      error: result.error || null,
      run: finishedRun,
      thread: updatedThread,
    });

    if (!ownsThread) return finishedRun;

    // Check if a steering_restart was requested while cancelling this turn (a user stop always wins over it)
    if (!ctx.flags.shuttingDown && runEntry?.steeringRestartPending && !runEntry.cancelRequested) {
      const pendingSteer = runEntry.steeringRestartPending;
      runEntry.steeringRestartPending = null;
      await ctx.turns.executeFollowUpTurn(threadId, {
        message: pendingSteer.text,
        inputIntent: "steer",
        ...pendingSteer.overrides,
      });
      return finishedRun;
    }

    // Otherwise, if the run completed (or was interrupted without full thread cancel), drain next queued run!
    if (finalStatus === "completed" && !ctx.flags.shuttingDown) {
      await drainNextQueuedRun(threadId);
    }

    return finishedRun;
  }

  function drainNextQueuedRun(threadId) {
    if (ctx.activeRunByThread.has(threadId) || ctx.pendingTurnStartLocks.has(threadId)) return null;
    if (ctx.scopePolicy.dispatchBypass({ threadId })) return null;
    ctx.pendingTurnStartLocks.add(threadId);
    try {
      if (ctx.scopePolicy.dispatchBypass({ threadId })) return null;
      return startNextQueuedRun(threadId);
    } finally {
      ctx.pendingTurnStartLocks.delete(threadId);
    }
  }

  function startNextQueuedRun(threadId) {
    if (ctx.updates.isUpdating()) return null;
    if (ctx.scopePolicy.dispatchBypass({ threadId })) return null;
    const queued = ctx.db.listQueuedRuns(threadId);
    if (!queued.length) return null;

    let nextRun = queued[0];
    let thread = ctx.db.getThread(threadId, { includeQueue: false });
    if (!thread) return null;
    const queuedMode = nextRun.meta?.orchestrationMode || ctx.scopePolicy.readConversationPolicy(ctx.scopePolicy.threadPolicyRoot(thread)).orchestrationMode;
    const queuedIntent = nextRun.meta?.executionIntent;
    const queuedPreset = nextRun.meta?.nextPresetKey ?? thread.presetKey;
    const curator = ctx.specs.isCuratorThread(thread, nextRun);
    if (curator) {
      const workspace = thread.meta?.projectRoot || thread.workspace || thread.cwd;
      if (!ctx.db.isProjectSpecEnabled(workspace) || ctx.specs.curationStatus(workspace).running) return null;
      nextRun = ctx.db.upsertRun({ id: nextRun.id, threadId, role: "curator", ...curatorRestrictions(nextRun.provider) });
    }
    if ((nextRun.meta?.followThreadPreset || nextRun.meta?.nextPresetKey) && queuedPreset && !thread.isNativeHost) {
      const settings = ctx.db.getSettings(thread.meta?.projectRoot || thread.workspace || thread.cwd);
      const presets = settings?.presets || {};
      if (Object.hasOwn(presets, queuedPreset)) {
        const refreshed = resolveRoleTarget({
          role: curator ? "curator" : thread.role,
          presetKey: queuedPreset,
          presets,
          customProviders: settings?.customProviders || [],
          catalog: ctx.flags.cachedCatalog,
          deletedPresets: settings.deletedPresets,
          orchestrationMode: queuedMode,
          executionIntent: queuedIntent,
        });
        nextRun = ctx.db.upsertRun({
          id: nextRun.id,
          threadId,
          provider: refreshed.provider,
          model: refreshed.model,
          effort: refreshed.effort,
          permissionMode: refreshed.permissionMode,
          interactionMode: refreshed.interactionMode,
          meta: { ...nextRun.meta, resolvedModel: refreshed.model },
        });
      }
    }
    const previousProvider = thread.meta?.pendingHandoffFromProvider || thread.provider;
    const switched = nextRun.provider !== thread.provider || nextRun.provider !== previousProvider;
    const fresh = nextRun.meta?.freshContext;
    const hideExternalSession = shouldHideExternalSession(ctx.db, thread, thread.meta?.projectRoot || thread.workspace || thread.cwd);
    const reuseNativeSession = Boolean(thread.nativeSessionId) && !fresh && !switched && !hideExternalSession;
    const rawPrompt = nextRun.prompt;
    const prompt = nextRun.meta?.reviewSpec
      ? ctx.review.buildTurnPrompt(nextRun.meta.reviewSpec, thread.worktreePath || thread.cwd, nextRun.meta.reviewSpec.customPrompt)
      : rawPrompt;
    const effectivePrompt = !reuseNativeSession && !fresh
      ? ctx.turns.buildLocalContinuationPrompt(thread, previousProvider, nextRun.provider, prompt) : prompt;
    thread = ctx.db.upsertThread({ id: threadId, presetKey: queuedPreset, provider: nextRun.provider, model: nextRun.model, effort: nextRun.effort,
      permissionMode: nextRun.permissionMode, interactionMode: nextRun.interactionMode,
      ...(curator ? { role: "curator", isolation: "shared" } : {}),
      ...((switched || fresh || (hideExternalSession && !thread.isNativeHost)) ? { nativeSessionId: null } : {}),
      ...((switched || fresh) ? { meta: { pendingHandoffFromProvider: null } } : {}),
    });

    // Record user_message item for the dequeued run
    ctx.db.upsertTurnItem({
      id: `item_user_${nextRun.id}`,
      threadId,
      runId: nextRun.id,
      type: "user_message",
      role: "user",
      text: nextRun.prompt,
      status: "completed",
      meta: { dequeued: true },
    });

    if (ctx.scopePolicy.dispatchBypass({ threadId })) return null;
    ctx.db.upsertRun({
      id: nextRun.id,
      threadId,
      status: "starting",
      queuePosition: null,
      meta: { orchestrationMode: queuedMode },
    });

    ctx.context.emitEvent({
      type: "queue_updated",
      threadId,
      workspace: thread.workspace || thread.cwd,
      queue: ctx.db.listQueuedRuns(threadId),
    });

    startEngineExecution({
      thread,
      run: nextRun,
      effectivePrompt,
      reuseNativeSession,
      ephemeral: hideExternalSession,
    });
    return nextRun;
  }

  return {
    drainNextQueuedRun,
    recoverStaleStateOnStartup,
    startEngineExecution,
  };
}

import { specSelection } from "../spec-context.mjs";
import {
  assertReadOnlySupport,
  curatorRestrictions,
  ROUTER_DEFAULT_MODEL,
  INHERIT_EFFORT,
  isInheritedEffort,
  getCatalogEfforts,
  isInheritedModel,
  assertAgySubagentModel,
  splitAgyModelVariant,
  normalizeEffortForTarget,
  normalizePermissionModeForProvider,
  normalizeProviderId,
} from "../catalog.mjs";
import { unsupportedHostCancel } from "../engines/agy-native.mjs";
import {
  makeId,
  isThreadBusyStatus,
  normalizePermissionMode,
  normalizeInteractionMode,
  shouldHideExternalSession,
} from "./helpers.mjs";

const HANDOFF_DIGEST_BYTES = 2048;
const HANDOFF_CONTEXT_PRESSURE = 150000;
const utf8Bytes = text => Buffer.byteLength(String(text || ""), "utf8");
function clipBytes(text, limit) {
  const value = String(text || "");
  if (utf8Bytes(value) <= limit) return value;
  return `${Buffer.from(value).subarray(0, Math.max(0, limit - 3)).toString("utf8").replace(/\uFFFD+$/, "")}...`;
}
const squash = text => String(text || "").replace(/\s+/g, " ").trim();

function matchesLiveModes(live, selection) {
  const permission = mode => normalizePermissionModeForProvider(live.provider, mode || "default");
  return permission(selection.permissionMode) === permission(live.permissionMode) &&
    (selection.interactionMode || "default") === (live.interactionMode || "default");
}

function steerStartingError() {
  return Object.assign(new Error("当前回合正在启动，请稍后重试 Steer"), { code: "STEER_TURN_STARTING" });
}

export function createTurnsModule(ctx) {
  // Deterministic, <= 2 KiB digest for the next engine: the last instruction, the latest two conclusions and the
  // files the thread touched. The new instruction itself is appended untouched after the digest.
  function buildLocalContinuationPrompt(thread, previousProvider, newProvider, userPrompt) {
    const history = ctx.db.getLocalContinuation(thread.id);
    if (!history || (!history.lastUser && !history.conclusions.length)) return userPrompt;
    const { lastUser, conclusions, files } = history;
    const lines = [
      previousProvider !== newProvider
        ? `[Cross-Engine Context Handoff: ${previousProvider} -> ${newProvider}]`
        : "[Local Continuation Context]",
    ];
    if (lastUser) lines.push(`Last User Instruction: ${clipBytes(squash(lastUser.text), 420)}`);
    conclusions.forEach((item, index) => {
      const latest = index === conclusions.length - 1;
      lines.push(`${latest ? "Latest" : "Earlier"} Conclusion (${previousProvider}): ${clipBytes(squash(item.text), latest ? 760 : 320)}`);
    });
    if (files.length) lines.push(clipBytes(`Touched Files: ${files.join(", ")}`, 300));
    const digest = clipBytes(lines.join("\n"), HANDOFF_DIGEST_BYTES);
    return `${digest}\n\n[Current User Instruction]:\n${String(userPrompt || "")}`;
  }

  async function executeFollowUpTurn(threadId, params) {
    const bypass = ctx.scopePolicy.dispatchBypass({ threadId, _manualCurationBypass: params?._manualCurationBypass === true });
    if (bypass) return bypass;
    if (ctx.pendingTurnStartLocks.has(threadId) || ctx.activeRunByThread.has(threadId)) {
      if (params.inputIntent === "steer") throw steerStartingError();
      const thread = ctx.db.getThread(threadId, { includeQueue: false });
      return { queued: await enqueueThreadMessage(thread, params.message, params) };
    }
    ctx.cancelledPendingStarts.delete(threadId);
    ctx.pendingTurnStartLocks.add(threadId);
    try {
      return await startFollowUpTurn(threadId, params);
    } finally {
      ctx.pendingTurnStartLocks.delete(threadId);
      const wasCancelled = ctx.cancelledPendingStarts.delete(threadId);
      if (!wasCancelled && !ctx.activeRunByThread.has(threadId)) ctx.execution.drainNextQueuedRun(threadId);
    }
  }

  function hasExplicitRoute(params) {
    return Boolean(params.presetKey || [params, params.target, params.modelSelection]
      .some(v => v?.provider || v?.driverKind || v?.providerInstanceId || v?.instanceId || v?.model));
  }

  // Carry a thread's permission onto a (possibly different) engine: same engine keeps its native value, a switch to
  // another engine maps semantically and never lands on the target's full-access rung.
  function carryPermission(fromProvider, toProvider, mode) {
    if (normalizeProviderId(fromProvider) === normalizeProviderId(toProvider)) return normalizePermissionMode(mode, "default", toProvider);
    return normalizePermissionModeForProvider(toProvider, mode || "default", { crossEngine: true, strictReadOnly: false });
  }

  function applyCarriedPermission(resolved, thread, explicitPermission, explicitInteraction) {
    if (resolved.role === "curator") return resolved;
    if (explicitPermission != null && explicitPermission !== "") return resolved;
    const permissionMode = carryPermission(thread.provider, resolved.provider, thread.permissionMode);
    assertReadOnlySupport(resolved.provider, permissionMode);
    const interactionMode = permissionMode === "plan" ? "plan"
      : normalizeInteractionMode(explicitInteraction ?? thread.interactionMode, permissionMode);
    return { ...resolved, permissionMode, interactionMode };
  }

  function isKnownPreset(presetKey, thread) {
    if (!presetKey) return false;
    const settings = ctx.db.getSettings(thread.meta?.projectRoot || thread.workspace || thread.cwd);
    const presets = settings?.presets || settings?.rolePresets || {};
    return Object.hasOwn(presets, presetKey);
  }

  async function resolveContinuationTarget(thread, params) {
    const root = ctx.scopePolicy.threadPolicyRoot(thread);
    const policy = ctx.scopePolicy.readConversationPolicy(root);
    const orchestrationMode = policy.orchestrationMode;
    const executionIntent = params.executionIntent;
    const curator = ctx.specs.isCuratorThread(thread);
    if (curator && !hasExplicitRoute(params)) {
      ctx.specs.assertSpecEnabled(thread.meta?.projectRoot || thread.workspace || thread.cwd);
      const { provider, model } = thread;
      const effort = params.effort == null ? thread.effort
        : normalizeEffortForTarget(provider, model, params.effort, getCatalogEfforts(await ctx.catalogSettings.ensureCatalog(), provider, model));
      return { provider, model, effort, ...curatorRestrictions(provider), role: "curator", nextPresetKey: thread.presetKey,
        routing: { resolvedModel: model, selectionSource: "thread_resume", orchestrationMode } };
    }
    if (hasExplicitRoute(params)) {
      const explicitPermission = params.permissionMode ?? params.runtimeMode;
      const resolved = await ctx.catalogSettings.resolveEffectiveTarget({ ...params, workspace: thread.meta?.projectRoot || thread.workspace || thread.cwd, role: curator ? "curator" : thread.role,
        permissionMode: explicitPermission,
        interactionMode: params.interactionMode ?? (params.presetKey ? undefined : thread.interactionMode),
        effort: params.effort ?? (params.presetKey || params.target?.effort || params.modelSelection?.effort ? undefined : thread.effort),
        orchestrationMode,
        executionIntent,
        allowDisabledPreset: params.allowDisabledPreset === true,
      });
      const finalTarget = params.presetKey ? resolved : applyCarriedPermission(resolved, thread, explicitPermission, params.interactionMode);
      return { ...finalTarget, nextPresetKey: params.presetKey || "" };
    }
    if (thread.presetKey && !thread.isNativeHost && !(thread.meta?.reviewMode === "read_only" && thread.permissionMode === "read-only") && isKnownPreset(thread.presetKey, thread)) {
      const base = await ctx.catalogSettings.resolveEffectiveTarget({
        role: thread.role,
        workspace: thread.meta?.projectRoot || thread.workspace || thread.cwd,
        presetKey: thread.presetKey,
        orchestrationMode,
        executionIntent,
      });
      const explicitPerm = params.permissionMode ?? params.runtimeMode;
      const permissionMode = explicitPerm != null && explicitPerm !== ""
        ? normalizePermissionMode(explicitPerm, base.permissionMode, base.provider)
        : base.permissionMode;
      assertReadOnlySupport(base.provider, permissionMode);
      const interactionMode = params.interactionMode != null && params.interactionMode !== ""
        ? normalizeInteractionMode(params.interactionMode, permissionMode, base.interactionMode)
        : (permissionMode === "plan" ? "plan" : base.interactionMode);
      const effort = params.effort != null && params.effort !== ""
        ? normalizeEffortForTarget(base.provider, base.model, params.effort, getCatalogEfforts(await ctx.catalogSettings.ensureCatalog(), base.provider, base.model))
        : base.effort;
      return {
        provider: base.provider,
        model: base.model,
        permissionMode,
        interactionMode,
        effort,
        nextPresetKey: thread.presetKey,
        routing: { requestedPresetKey: thread.presetKey, requestedModel: null, resolvedModel: base.model, selectionSource: "thread_resume", orchestrationMode, ...(orchestrationMode === "relay" ? { executionIntent } : {}) },
      };
    }
    const provider = thread.provider;
    const model = provider === "antigravity" && !isInheritedModel(thread.model) ? splitAgyModelVariant(thread.model).model : thread.model;
    assertAgySubagentModel(provider, model);
    const inheritedPermission = normalizePermissionMode(params.permissionMode ?? params.runtimeMode, thread.permissionMode, provider);
    const permissionMode = orchestrationMode === "relay" && executionIntent === "read"
      ? (provider === "codex" ? "read-only" : "plan")
      : inheritedPermission;
    assertReadOnlySupport(provider, permissionMode);
    return { provider, model, permissionMode,
      interactionMode: orchestrationMode === "relay" && executionIntent === "read"
        ? "plan"
        : normalizeInteractionMode(params.interactionMode ?? thread.interactionMode, permissionMode),
      effort: normalizeEffortForTarget(provider, model, params.effort ?? thread.effort, getCatalogEfforts(await ctx.catalogSettings.ensureCatalog(), provider, model)),
      nextPresetKey: thread.permissionMode === "read-only" && thread.meta?.reviewMode === "read_only" ? "" : thread.presetKey || "",
      routing: { requestedPresetKey: null, requestedModel: null, resolvedModel: model, selectionSource: "thread_resume", orchestrationMode, ...(orchestrationMode === "relay" ? { executionIntent } : {}) },
    };
  }

  async function startFollowUpTurn(
    threadId,
    {
      message,
      inputIntent = "follow_up",
      freshContext = false,
      synchronous = false,
      presetKey, target, modelSelection,
      provider,
      model,
      effort,
      permissionMode,
      interactionMode,
      liveModes,
      executionIntent,
      specIds, targetPaths, planPath, readPaths, reviewSpec,
      allowDisabledPreset = false,
      _manualCurationBypass = false,
    } = {}
  ) {
    let thread = ctx.db.getThread(threadId, { includeQueue: false });
    if (!thread) throw new Error(`找不到会话: ${threadId}`);
    const root = ctx.scopePolicy.threadPolicyRoot(thread);

    const resolved = await resolveContinuationTarget(thread, {
      presetKey, provider, model, target, modelSelection, effort, permissionMode, interactionMode,
      executionIntent, allowDisabledPreset,
    });
    const { provider: nextProvider, model: nextModel, effort: nextEffort, permissionMode: nextPerm, role: nextRole,
      interactionMode: nextInter, nextPresetKey, routing } = liveModes
      ? applyCarriedPermission(resolved, liveModes)
      : resolved;
    const bypass = ctx.scopePolicy.dispatchBypass({ threadId, _manualCurationBypass }, thread);
    if (bypass) return bypass;
    if (ctx.cancelledPendingStarts.has(threadId)) {
      return { thread: ctx.db.getThread(threadId), run: null, settledPromise: Promise.resolve(null), cancelled: true };
    }
    thread = ctx.db.getThread(threadId, { includeQueue: false });
    if (!thread || thread.archived) throw new Error(`找不到可续聊的会话: ${threadId}`);
    if (nextRole === "curator") {
      ctx.specs.assertCuratorAvailable(thread.meta?.projectRoot || thread.workspace || thread.cwd);
      thread = ctx.db.upsertThread({ id: threadId, role: "curator", isolation: "shared" });
    }
    const previousProvider = thread.provider;
    const providerSwitched =
      Boolean(previousProvider && previousProvider !== nextProvider) ||
      Boolean(thread.meta?.pendingHandoffFromProvider && thread.meta.pendingHandoffFromProvider !== nextProvider);
    const handoffSourceProvider = thread.meta?.pendingHandoffFromProvider || previousProvider;
    const workspace = thread.meta?.projectRoot || thread.workspace || thread.cwd;
    const hideExternalSession = shouldHideExternalSession(ctx.db, thread, workspace);
    const reuseNativeSession = Boolean(thread.nativeSessionId) && !freshContext && !providerSwitched && !hideExternalSession;
    const effectivePresetKey = nextPresetKey !== undefined ? (nextPresetKey || "") : (thread.presetKey || "");

    let effectivePrompt = String(message || "").trim();
    if (!reuseNativeSession && !freshContext) {
      effectivePrompt = buildLocalContinuationPrompt(thread, handoffSourceProvider, nextProvider, effectivePrompt);
    }
    if (freshContext) {
      thread = ctx.db.upsertThread({
        id: threadId,
        presetKey: effectivePresetKey,
        provider: nextProvider,
        model: nextModel,
        effort: nextEffort,
        permissionMode: nextPerm,
        interactionMode: nextInter,
        nativeSessionId: null,
        meta: { ...thread.meta, pendingHandoffFromProvider: null },
      });
    } else if (providerSwitched) {
      thread = ctx.db.upsertThread({
        id: threadId,
        presetKey: effectivePresetKey,
        provider: nextProvider,
        model: nextModel,
        effort: nextEffort,
        permissionMode: nextPerm,
        interactionMode: nextInter,
        nativeSessionId: null,
        meta: { ...thread.meta, pendingHandoffFromProvider: null },
      });
      ctx.db.upsertTurnItem({
        id: makeId("item_handoff"),
        threadId,
        type: "handoff",
        role: "system",
        title: `Engine Handoff: ${handoffSourceProvider} → ${nextProvider}`,
        text: `Cross-engine context digest injected for ${nextModel} (${nextEffort}).`,
        status: "completed",
      });
    } else if (
      (hideExternalSession && thread.nativeSessionId && !thread.isNativeHost) ||
      effectivePresetKey !== (thread.presetKey || "") ||
      nextProvider !== thread.provider ||
      nextModel !== thread.model ||
      nextEffort !== thread.effort ||
      nextPerm !== thread.permissionMode ||
      nextInter !== thread.interactionMode
    ) {
      thread = ctx.db.upsertThread({
        id: threadId,
        ...(hideExternalSession && !thread.isNativeHost ? { nativeSessionId: null } : {}),
        presetKey: effectivePresetKey,
        provider: nextProvider,
        model: nextModel,
        effort: nextEffort,
        permissionMode: nextPerm,
        interactionMode: nextInter,
      });
    }

    const runId = makeId("run");
    const run = ctx.db.upsertRun({
      id: runId,
      threadId,
      status: "starting",
      role: thread.role,
      provider: thread.provider,
      model: thread.model,
      effort: thread.effort,
      permissionMode: thread.permissionMode,
      interactionMode: thread.interactionMode,
      prompt: String(message || "").trim(),
      inputIntent,
      meta: { ...routing, ...specSelection({ specIds, targetPaths, planPath }), ...ctx.dispatch.readPathsSelection({ readPaths }), ...(reviewSpec ? { reviewSpec } : {}), ...(allowDisabledPreset && routing.temporaryOverride ? { temporaryOverride: true } : {}), ...(_manualCurationBypass ? { triggerSource: "manual" } : {}) },
      cwd: thread.worktreePath || thread.cwd,
    });

    ctx.db.upsertTurnItem({
      id: `item_user_${runId}`,
      threadId,
      runId,
      type: "user_message",
      role: "user",
      title: inputIntent === "steer" ? "Steer Instruction" : undefined,
      text: String(message || "").trim(),
      status: "completed",
      meta: { inputIntent },
    });

    const exec = ctx.execution.startEngineExecution({
      thread,
      run,
      effectivePrompt: reviewSpec ? ctx.review.buildTurnPrompt(reviewSpec, thread.worktreePath || thread.cwd, effectivePrompt) : effectivePrompt,
      reuseNativeSession,
      ephemeral: hideExternalSession,
      synchronous,
    });

    if (exec.bypassed) return exec;
    if (exec.started) await exec.started;
    return { thread: ctx.db.getThread(threadId), run, settledPromise: exec.settledPromise, activeMode: ctx.scopePolicy.getActiveModeSummary(root) };
  }

  async function enqueueThreadMessage(thread, text, params, resolved) {
    resolved ||= await resolveContinuationTarget(thread, params);
    const bypass = ctx.scopePolicy.dispatchBypass(params, thread);
    if (bypass) return bypass;
    const followThreadPreset = Boolean(
      thread.presetKey &&
      !thread.isNativeHost &&
      !hasExplicitRoute(params) &&
      params.effort == null &&
      params.permissionMode == null &&
      params.runtimeMode == null &&
      params.interactionMode == null
    );
    const queuedRun = ctx.db.upsertRun({
      id: makeId("run"),
      threadId: thread.id,
      status: "queued",
      role: resolved.role || thread.role,
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
      permissionMode: resolved.permissionMode,
      interactionMode: resolved.interactionMode,
      prompt: text,
      inputIntent: "queue",
      meta: { ...resolved.routing, ...specSelection(params), ...ctx.dispatch.readPathsSelection(params), ...(params.reviewSpec ? { reviewSpec: params.reviewSpec } : {}), freshContext: Boolean(params.freshContext), executionIntent: resolved.routing?.executionIntent || params.executionIntent, ...(hasExplicitRoute(params) ? { nextPresetKey: resolved.nextPresetKey } : {}), ...(followThreadPreset ? { followThreadPreset: true } : {}), ...(resolved.routing?.temporaryOverride ? { temporaryOverride: true } : {}) },
      cwd: thread.worktreePath || thread.cwd,
    });
    const queue = ctx.db.listQueuedRuns(thread.id);
    ctx.context.emitEvent({ type: "queue_updated", threadId: thread.id, workspace: thread.workspace || thread.cwd, queue });
    return { action: "queued", threadId: thread.id, queuedRunId: queuedRun.id, queuePosition: queuedRun.queuePosition, queue,
      activeMode: ctx.scopePolicy.getActiveModeSummary(ctx.scopePolicy.threadPolicyRoot(thread)) };
  }

  // Follow-ups keep the full native session; a near-full context is surfaced read-only instead of silently reset.
  async function sendToThread(params = {}) {
    const result = await sendToThreadCore(params);
    if (!result || typeof result !== "object" || result.bypassed || !result.threadId) return result;
    const used = Number(ctx.db.getThread(result.threadId, { includeQueue: false })?.usage?.contextUsed) || 0;
    return used >= HANDOFF_CONTEXT_PRESSURE ? { ...result, contextPressure: "high" } : result;
  }

  async function sendToThreadCore(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    const bypass = ctx.scopePolicy.dispatchBypass(params);
    if (bypass) return bypass;
    const key = params.threadId || params.taskId || params.id;
    const text = String(params.message ?? params.prompt ?? "").trim();
    if (!key) throw new Error("sendToThread 需要提供 threadId");
    if (!text) throw new Error("sendToThread 消息内容不能为空");

    let thread = ctx.db.getThread(key, { includeQueue: true });
    if (!thread || thread.archived) throw new Error(`找不到可续聊的会话: ${key}`);

    const targetBypass = ctx.scopePolicy.dispatchBypass(params, thread);
    if (targetBypass) return targetBypass;
    const selection = await resolveContinuationTarget(thread, params);
    if (!thread.isNativeHost) {
      const nativeHandoff = ctx.dispatch.createNativeHostHandoff({ params, resolved: selection,
        rootConversationId: ctx.scopePolicy.threadPolicyRoot(thread), role: thread.role, brief: text,
        cwd: thread.worktreePath || thread.cwd, repoRoot: thread.meta?.projectRoot || thread.workspace });
      if (nativeHandoff) return nativeHandoff;
    }
    thread = ctx.db.getThread(thread.id, { includeQueue: true });
    if (!thread || thread.archived) throw new Error(`找不到可续聊的会话: ${key}`);
    const blockedAfterResolve = ctx.scopePolicy.dispatchBypass(params, thread);
    if (blockedAfterResolve) return blockedAfterResolve;
    const mode = String(params.mode || "auto").trim().toLowerCase();
    const activeRunId = ctx.activeRunByThread.get(thread.id);
    const activeEntry = activeRunId ? ctx.activeRuns.get(activeRunId) : null;

    if (mode === "steer" && activeEntry?.steeringRestartPending) throw steerStartingError();
    if (ctx.pendingTurnStartLocks.has(thread.id) || (activeEntry && !activeEntry.handle)) {
      if (mode === "steer") throw steerStartingError();
      return enqueueThreadMessage(thread, text, params, selection);
    }
    if (!activeEntry && thread.activeRunId && isThreadBusyStatus(thread.status)) {
      throw new Error(ctx.cancellation.computeCancelCapability(thread) === "reconcilable_orphan"
        ? "该成员的上一回合已失联（原守护进程已退出），请先点击「停止」收割后再发送"
        : "线程仍由上一 Daemon 执行，请等待当前回合结束后再发送");
    }

    if (activeEntry?.handle) {
      const { specIds, targetPaths, planPath } = specSelection(params);
      const scoped = specIds.length || targetPaths.length || planPath || ctx.dispatch.readPathsSelection(params).readPaths;
      const fresh = Boolean(params.freshContext);
      if (mode === "queue" || (mode !== "restart" && mode !== "steer" && (scoped || fresh))) {
        return enqueueThreadMessage(thread, text, params, selection);
      }

      const live = ctx.db.getRun(activeRunId);
      const inheritLiveModes = mode === "steer" && live && !params.presetKey && params.permissionMode == null &&
        params.runtimeMode == null && params.interactionMode == null &&
        !(selection.routing?.orchestrationMode === "relay" && params.executionIntent === "read");
      const presetTracked = Boolean(thread.presetKey && !thread.isNativeHost && isKnownPreset(thread.presetKey, thread));
      const changesRoute = (hasExplicitRoute(params) || presetTracked) &&
        (selection.provider !== live?.provider || selection.model !== live?.model);
      const changesModes = !inheritLiveModes && (!live || !matchesLiveModes(live, selection));
      if (mode === "auto" && (changesRoute || (!hasExplicitRoute(params) && presetTracked && selection.effort !== live?.effort))) {
        return enqueueThreadMessage(thread, text, params, selection);
      }
      if (mode === "auto" && changesModes) return enqueueThreadMessage(thread, text, params, selection);
      if (!changesRoute && !changesModes && !scoped && !fresh && (mode === "steer" || mode === "auto")) {
        const steerRes = await activeEntry.handle.steer(text);
        if (steerRes?.supported) {
          const activeRun = ctx.db.getRun(activeRunId);
          const deferredConfig = {};
          if (params.model != null) {
            const model = isInheritedModel(params.model) ? ROUTER_DEFAULT_MODEL : params.model;
            if (model !== activeRun?.model) deferredConfig.model = model;
          }
          if (params.effort != null) {
            const effort = isInheritedEffort(params.effort) ? INHERIT_EFFORT : params.effort;
            if (effort !== activeRun?.effort) deferredConfig.effort = effort;
          }
          const deferredConfigNotice = Object.keys(deferredConfig).length > 0;
          if (deferredConfigNotice) ctx.db.upsertThread({ id: thread.id, ...deferredConfig });
          ctx.db.upsertTurnItem({
            id: makeId("item_steer"),
            threadId: thread.id,
            runId: activeRunId,
            type: "user_message",
            role: "user",
            title: "Live Steer",
            text,
            status: "completed",
            meta: { inputIntent: "steer", live: true },
          });
          ctx.context.emitEvent({
            type: "thread_updated",
            threadId: thread.id,
            workspace: thread.workspace || thread.cwd,
            steered: true,
            thread: ctx.db.getThread(thread.id),
          });
          return {
            action: "steered_live",
            threadId: thread.id,
            runId: activeRunId,
            ...(deferredConfigNotice ? { deferredConfigNotice: true } : {}),
            activeMode: ctx.scopePolicy.getActiveModeSummary(ctx.scopePolicy.threadPolicyRoot(thread)),
          };
        }

        // Driver does not support in-flight turn/steer (e.g. ACP stdio):
        // If caller explicitly chose `steer`, perform atomic steering_restart (cancel current turn -> immediately resume session with steer message).
        // If caller passed `auto`, safely enqueue so running tool work isn't killed unexpectedly unless user clicked Steer!
        if (ctx.activeRunByThread.get(thread.id) !== activeRunId) return sendToThreadCore(params);
        if (mode === "auto") return enqueueThreadMessage(thread, text, params, selection);
      }

      // mode === 'steer' (without native steer) OR mode === 'restart': atomic steering_restart
      if (activeEntry.handle.passiveHost) return unsupportedHostCancel();
      if (mode === "steer" && activeEntry.steeringRestartPending) throw steerStartingError();
      const pendingRestart = {
        text,
        overrides: {
          freshContext: Boolean(params.freshContext),
          presetKey: params.presetKey, target: params.target, modelSelection: params.modelSelection,
          provider: params.provider,
          model: params.model,
          effort: params.effort,
          permissionMode: params.permissionMode ?? params.runtimeMode,
          interactionMode: params.interactionMode,
          liveModes: inheritLiveModes ? {
            provider: live.provider,
            permissionMode: live.permissionMode,
            interactionMode: live.interactionMode,
          } : undefined,
          executionIntent: params.executionIntent,
          ...specSelection(params),
          ...ctx.dispatch.readPathsSelection(params),
          reviewSpec: params.reviewSpec,
          allowDisabledPreset: params.allowDisabledPreset === true,
        },
      };
      activeEntry.steeringRestartPending = pendingRestart;
      try {
        await activeEntry.handle.cancel?.();
      } catch (error) {
        if (activeEntry.steeringRestartPending === pendingRestart) activeEntry.steeringRestartPending = null;
        throw error;
      }
      ctx.watchdog.stop(activeRunId);
      return {
        action: "steering_restart",
        threadId: thread.id,
        interruptedRunId: activeRunId,
        activeMode: ctx.scopePolicy.getActiveModeSummary(ctx.scopePolicy.threadPolicyRoot(thread)),
      };
    }

    // Case 2: Thread is idle / completed / failed / interrupted — start follow-up run immediately
    const launched = await executeFollowUpTurn(thread.id, {
      message: text,
      inputIntent: mode === "steer" ? "steer" : "follow_up",
      synchronous: Boolean(params.wait),
      freshContext: Boolean(params.freshContext),
      presetKey: params.presetKey, target: params.target, modelSelection: params.modelSelection,
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      permissionMode: params.permissionMode ?? params.runtimeMode,
      interactionMode: params.interactionMode,
      executionIntent: params.executionIntent,
      ...specSelection(params),
      ...ctx.dispatch.readPathsSelection(params),
      reviewSpec: params.reviewSpec,
      allowDisabledPreset: params.allowDisabledPreset === true,
      _manualCurationBypass: params._manualCurationBypass === true,
    });

    if (launched.bypassed) return launched;
    if (launched.queued) return launched.queued;
    if (launched.cancelled || !launched.run) return { action: "cancelled", cancelled: true, threadId: thread.id, runId: null };

    if (params.wait) {
      await launched.settledPromise;
      const doneThread = ctx.db.getThread(thread.id);
      return {
        action: "completed",
        threadId: thread.id,
        runId: launched.run.id,
        status: doneThread?.status,
        summary: doneThread?.summary,
        thread: doneThread,
        activeMode: ctx.scopePolicy.getActiveModeSummary(ctx.scopePolicy.threadPolicyRoot(doneThread)),
      };
    }

    return {
      action: "started",
      threadId: thread.id,
      runId: launched.run.id,
      status: "running",
      thread: launched.thread,
      activeMode: launched.activeMode || ctx.scopePolicy.getActiveModeSummary(ctx.scopePolicy.threadPolicyRoot(thread)),
    };
  }

  async function manageQueue(params = {}) {
    const threadId = params.threadId;
    if (!threadId) throw new Error("manageQueue 需要提供 threadId");
    const thread = ctx.db.getThread(threadId, { includeQueue: false });
    if (!thread) throw new Error(`找不到会话: ${threadId}`);

    const action = String(params.action || "list").trim().toLowerCase();
    const targetRunId = params.queueId || params.queuedRunId || params.itemId || params.runId;

    if (action === "list" || action === "read") {
      return { threadId, queue: ctx.db.listQueuedRuns(threadId) };
    }

    if (["enqueue", "promote_to_steer"].includes(action)) {
      const bypass = ctx.scopePolicy.dispatchBypass(params, thread);
      if (bypass) return bypass;
    }
    if (action === "enqueue") {
      return sendToThread({
        threadId,
        message: params.text || params.message || params.prompt,
        mode: "queue",
        presetKey: params.presetKey, target: params.target, modelSelection: params.modelSelection,
        provider: params.provider,
        permissionMode: params.permissionMode ?? params.runtimeMode,
        executionIntent: params.executionIntent,
        allowDisabledPreset: params.allowDisabledPreset === true,
      });
    }

    if (action === "edit") {
      if (!targetRunId) throw new Error("manageQueue edit 需要提供 queueId / queuedRunId");
      const existing = ctx.db.getRun(targetRunId);
      if (!existing || existing.threadId !== threadId || existing.status !== "queued") {
        throw new Error(`找不到该会话排队中的消息: ${targetRunId}`);
      }
      ctx.db.upsertRun({
        id: targetRunId,
        threadId,
        status: "queued",
        prompt: String(params.text ?? params.message ?? existing.prompt).trim(),
      });
      const queue = ctx.db.listQueuedRuns(threadId);
      ctx.context.emitEvent({ type: "queue_updated", threadId, workspace: thread.workspace, queue });
      return { threadId, queue };
    }

    if (action === "cancel" || action === "remove" || action === "delete") {
      if (!targetRunId) throw new Error("manageQueue cancel 需要提供 queueId / queuedRunId");
      const existingRun = ctx.db.getRun(targetRunId);
      // Only a still-queued item of THIS thread may be removed; never touch a running turn or another member's run.
      if (!existingRun || existingRun.threadId !== threadId || existingRun.status !== "queued") {
        throw new Error(`找不到该会话排队中的消息: ${targetRunId}`);
      }
      ctx.db.upsertRun({
        id: targetRunId,
        threadId,
        status: "cancelled",
        stopReason: "removed_from_queue",
        completedAt: Date.now(),
      });
      const queue = ctx.db.listQueuedRuns(threadId);
      ctx.context.emitEvent({ type: "queue_updated", threadId, workspace: thread.workspace, queue });
      return { threadId, queue };
    }

    if (action === "clear") {
      const currentQueue = ctx.db.listQueuedRuns(threadId);
      for (const q of currentQueue) {
        ctx.db.upsertRun({
          id: q.id,
          threadId,
          status: "cancelled",
          stopReason: "queue_cleared",
          completedAt: Date.now(),
        });
      }
      ctx.context.emitEvent({ type: "queue_updated", threadId, workspace: thread.workspace, queue: [] });
      return { threadId, queue: [] };
    }

    if (action === "reorder") {
      let orderedIds = Array.isArray(params.orderedRunIds) ? [...params.orderedRunIds] : null;
      if (!orderedIds) {
        const current = ctx.db.listQueuedRuns(threadId).map((r) => r.id);
        const idx = current.indexOf(targetRunId);
        if (idx !== -1) {
          orderedIds = [...current];
          if (params.beforeRunId) {
            orderedIds.splice(idx, 1);
            const targetIdx = orderedIds.indexOf(params.beforeRunId);
            orderedIds.splice(targetIdx === -1 ? 0 : targetIdx, 0, targetRunId);
          } else if (typeof params.position === "number") {
            orderedIds.splice(idx, 1);
            const pos = Math.max(0, Math.min(orderedIds.length, Number(params.position)));
            orderedIds.splice(pos, 0, targetRunId);
          } else {
            const dir = String(params.direction || "up").toLowerCase();
            const swapIdx = dir === "down" ? idx + 1 : idx - 1;
            if (swapIdx >= 0 && swapIdx < orderedIds.length) {
              [orderedIds[idx], orderedIds[swapIdx]] = [orderedIds[swapIdx], orderedIds[idx]];
            }
          }
        } else {
          orderedIds = current;
        }
      }
      const queue = ctx.db.reorderQueuedRuns(threadId, orderedIds);
      ctx.context.emitEvent({ type: "queue_updated", threadId, workspace: thread.workspace, queue });
      return { threadId, queue };
    }

    if (action === "promote_to_steer") {
      const currentQueue = ctx.db.listQueuedRuns(threadId);
      const target = targetRunId
        ? currentQueue.find((q) => q.id === targetRunId)
        : currentQueue[0];
      if (!target) {
        throw new Error("队列中没有可提升为 Steer 的待发消息");
      }
      const selection = {
        permissionMode: target.permissionMode ?? thread.permissionMode,
        interactionMode: target.interactionMode ?? thread.interactionMode,
        provider: target.provider || thread.provider,
        model: target.model || thread.model,
        effort: target.effort || thread.effort,
      };
      assertReadOnlySupport(selection.provider, selection.permissionMode);
      const liveId = ctx.activeRunByThread.get(threadId) || thread.activeRunId;
      const live = liveId && ctx.db.getRun(liveId);
      if (ctx.pendingTurnStartLocks.has(threadId) || (liveId && (!live || !matchesLiveModes(live, selection) ||
          selection.provider !== live.provider || selection.model !== live.model || selection.effort !== live.effort))) {
        throw new Error("当前回合权限或路由与排队项不一致；消息保留在队列中");
      }
      const steerRes = await sendToThread({
        threadId,
        message: target.prompt,
        mode: "steer",
        ...selection,
        permissionMode: selection.permissionMode || "default",
        interactionMode: selection.interactionMode || "default",
        freshContext: Boolean(target.meta?.freshContext),
        ...specSelection(target.meta || {}),
        ...ctx.dispatch.readPathsSelection(target.meta || {}),
      });
      if (!["started", "steered_live", "steering_restart"].includes(steerRes.action)) return steerRes;
      if (ctx.db.getRun(target.id)?.status === "queued") {
        ctx.db.upsertRun({ id: target.id, threadId, status: "cancelled", stopReason: "promoted_to_steer", completedAt: Date.now() });
      }
      const queue = ctx.db.listQueuedRuns(threadId);
      ctx.context.emitEvent({ type: "queue_updated", threadId, workspace: thread.workspace, queue });
      return {
        threadId,
        promotedRunId: target.id,
        steerResult: steerRes,
        queue,
      };
    }

    throw new Error(`不支持的队列操作: ${action}`);
  }

  async function configureThread(params = {}) {
    const key = params.threadId || params.id;
    if (!key) throw new Error("configureThread 需要提供 threadId");
    const existing = ctx.db.getThread(key, { includeQueue: false });
    if (!existing) throw new Error(`找不到会话: ${key}`);

    const hasTargetChange =
      params.presetKey !== undefined ||
      params.provider !== undefined ||
      params.model !== undefined ||
      params.effort !== undefined ||
      params.modelSelection !== undefined ||
      params.target !== undefined ||
      params.permissionMode !== undefined ||
      params.runtimeMode !== undefined ||
      params.interactionMode !== undefined ||
      params.isolation !== undefined;

    let patch = { id: existing.id };
    if (params.title !== undefined) patch.title = String(params.title).trim();
    if (params.archived !== undefined) patch.archived = Boolean(params.archived);

    if (hasTargetChange) {
      const changedRoute = hasExplicitRoute(params);
      const resolved = await ctx.catalogSettings.resolveEffectiveTarget({
        workspace: existing.meta?.projectRoot || existing.workspace || existing.cwd,
        role: ctx.specs.isCuratorThread(existing) ? "curator" : params.role || existing.role,
        presetKey: params.presetKey,
        provider: changedRoute ? params.provider : existing.provider,
        model: changedRoute ? params.model : existing.model,
        modelSelection: params.modelSelection,
        target: params.target,
        effort: params.effort ?? params.modelSelection?.effort ?? (params.presetKey ? undefined : existing.effort),
        permissionMode: params.permissionMode ?? params.runtimeMode,
        interactionMode: params.interactionMode ?? (params.presetKey ? undefined : existing.interactionMode),
        isolation: params.isolation ?? existing.isolation,
      }).then(target => params.presetKey ? target
        : applyCarriedPermission(target, existing, params.permissionMode ?? params.runtimeMode, params.interactionMode));

      const providerChanged = resolved.provider !== existing.provider;
      let nextPresetKey = "";
      if (params.presetKey != null) {
        nextPresetKey = String(params.presetKey || "");
      } else if (existing.presetKey && isKnownPreset(existing.presetKey, existing)) {
        const bound = await ctx.catalogSettings.resolveEffectiveTarget({
          workspace: existing.meta?.projectRoot || existing.workspace || existing.cwd,
          role: resolved.role || params.role || existing.role,
          presetKey: existing.presetKey,
        });
        const stillMatchesPreset =
          resolved.provider === bound.provider &&
          resolved.model === bound.model &&
          resolved.effort === bound.effort &&
          resolved.permissionMode === bound.permissionMode &&
          resolved.interactionMode === bound.interactionMode;
        nextPresetKey = stillMatchesPreset ? existing.presetKey : "";
      }
      patch = {
        ...patch,
        presetKey: nextPresetKey,
        provider: resolved.provider,
        model: resolved.model,
        effort: resolved.effort,
        ...(resolved.role ? { role: resolved.role } : {}),
        permissionMode: resolved.permissionMode,
        interactionMode: resolved.interactionMode,
        isolation: resolved.isolation,
        ...(providerChanged
          ? {
              nativeSessionId: null,
              meta: {
                ...existing.meta,
                pendingHandoffFromProvider: existing.provider,
              },
            }
          : {}),
      };
    } else if (ctx.specs.isCuratorThread(existing)) {
      patch = { ...patch, role: "curator", ...curatorRestrictions(existing.provider) };
    }

    const updated = ctx.db.upsertThread(patch);
    ctx.context.emitEvent({
      type: "thread_updated",
      threadId: updated.id,
      workspace: updated.workspace || updated.cwd,
      thread: updated,
    });
    return { thread: updated };
  }

  async function retryRun(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    const bypass = ctx.scopePolicy.dispatchBypass(params);
    if (bypass) return bypass;
    const key = params.threadId || params.id;
    if (!key) throw new Error("retryRun 需要提供 threadId");
    const thread = ctx.db.getThread(key, { includeQueue: false });
    if (!thread) throw new Error(`找不到会话: ${key}`);

    const targetBypass = ctx.scopePolicy.dispatchBypass(params, thread);
    if (targetBypass) return targetBypass;
    const sourceRun = params.runId ? ctx.db.getRun(params.runId) : ctx.db.getLatestRun(thread.id);
    if (params.runId && sourceRun?.threadId !== thread.id) throw new Error("重试源回合不存在或不属于该线程");
    const promptToRetry =
      String(params.prompt || sourceRun?.prompt || "").trim() ||
      "Continue and complete the previous task.";
    const explicitModel = params.model ?? params.modelOverride;
    const explicitEffort = params.effort ?? params.effortOverride;
    const explicitPerm = params.permissionMode ?? params.runtimeMode;
    const route = { presetKey: params.presetKey, target: params.target, modelSelection: params.modelSelection,
      provider: params.provider, model: explicitModel, effort: explicitEffort,
      permissionMode: explicitPerm, interactionMode: params.interactionMode,
      executionIntent: params.executionIntent,
      allowDisabledPreset: params.allowDisabledPreset === true };
    const retryRoot = ctx.scopePolicy.threadPolicyRoot(thread);
    const retryMode = ctx.scopePolicy.readConversationPolicy(retryRoot).orchestrationMode;
    const readOnlySource = retryMode !== "relay" && sourceRun?.permissionMode === "read-only";
    if (readOnlySource && explicitPerm == null && !params.presetKey) route.permissionMode = "read-only";
    // A caller-supplied route and a bound thread both go through the ordinary send resolver.
    // Only an unbound retry with no route replays the historical run configuration.
    if (!hasExplicitRoute(route) && !thread.presetKey) {
      route.provider = sourceRun?.provider ?? thread.provider;
      route.model = sourceRun?.model ?? thread.model;
      route.effort ??= sourceRun?.effort ?? thread.effort;
      route.permissionMode ??= sourceRun?.permissionMode ?? thread.permissionMode;
      route.interactionMode ??= sourceRun?.interactionMode ?? thread.interactionMode;
    }
    const priorReview = sourceRun?.meta?.reviewSpec;
    const reviewSpec = priorReview && await ctx.review.snapshotReview({ ...priorReview, customPrompt: params.prompt ?? priorReview.customPrompt }, thread.worktreePath || thread.cwd);
    return sendToThread({ ...route, threadId: thread.id, message: promptToRetry, mode: "restart", wait: params.wait,
      freshContext: Boolean(params.freshContext), executionIntent: route.executionIntent,
      specIds: params.specIds ?? sourceRun?.meta?.specIds, targetPaths: params.targetPaths ?? sourceRun?.meta?.targetPaths,
      planPath: params.planPath ?? sourceRun?.meta?.planPath,
      readPaths: params.readPaths ?? sourceRun?.meta?.readPaths,
      ...(reviewSpec ? { reviewSpec } : {}),
      allowDisabledPreset: route.allowDisabledPreset });
  }

  function publishRuntimeRequestResolution(req, decision) {
    const remaining = ctx.db.listPendingRequests({ threadId: req.threadId });
    if (remaining.length === 0 && ctx.activeRunByThread.get(req.threadId) === req.runId) {
      ctx.watchdog.phase(req.runId, "running");
      ctx.db.upsertRun({ id: req.runId, threadId: req.threadId, status: "running" });
      ctx.db.upsertThread({ id: req.threadId, status: "running" });
    }
    const thread = ctx.db.getThread(req.threadId);
    ctx.context.emitEvent({ type: "runtime_request_resolved", threadId: req.threadId, runId: req.runId,
      workspace: thread?.workspace || thread?.cwd, requestId: req.id, decision, thread });
    return thread;
  }

  async function respondRuntimeRequest(params = {}) {
    const requestId = params.requestId || params.runtimeRequestId || params.reqId || params.id;
    let reqRecord = requestId ? ctx.db.getRuntimeRequest(requestId) : null;

    if (!requestId && params.threadId) {
      const pending = ctx.db.listPendingRequests({ threadId: params.threadId });
      reqRecord = pending[0] || null;
    }
    if (!reqRecord) {
      throw new Error(`找不到待处理的审批或提问请求: ${requestId || ""}`);
    }

    const activeRunId = reqRecord.runId || ctx.activeRunByThread.get(reqRecord.threadId);
    const runEntry = activeRunId ? ctx.activeRuns.get(activeRunId) : null;
    function staleRequest() {
      return Object.assign(new Error("该审批或提问已失效，未发送回复。"), { code: "STALE_RUNTIME_REQUEST" });
    }
    if (reqRecord.status !== "pending" || !runEntry?.handle || runEntry.cancelRequested) throw staleRequest();

    let decisionValue =
      params.decision ??
      params.optionId ??
      params.action ??
      (params.approved === false ? "reject" : params.approved === true ? "approve_once" : undefined);

    if (reqRecord.kind === "user-input") {
      const answersPayload = params.answers ?? params.response ?? params.content ?? {};
      if (runEntry?.handle) {
        if (await runEntry.handle.respondQuestion(reqRecord.id, answersPayload) === false) throw staleRequest();
      }
      decisionValue = decisionValue || "answered";
    } else {
      decisionValue = decisionValue || "reject";
      if (runEntry?.handle) {
        if (await runEntry.handle.respondPermission(reqRecord.id, {
          decision: decisionValue,
          optionId: params.optionId,
          feedback: params.feedback,
        }) === false) throw staleRequest();
      }
    }
    if (ctx.db.getRuntimeRequest(reqRecord.id)?.status !== "pending") throw staleRequest();

    const finalDecision = typeof decisionValue === "string" ? decisionValue : JSON.stringify(decisionValue);
    const resolvedReq = ctx.db.upsertRuntimeRequest({
      ...reqRecord,
      status: "resolved",
      resolution: params.answers ?? params.response ?? { decision: finalDecision, optionId: params.optionId },
      resolvedAt: Date.now(),
    });

    const updatedThread = publishRuntimeRequestResolution(reqRecord, finalDecision);

    return {
      resolved: true,
      requestId: reqRecord.id,
      decision: finalDecision,
      thread: updatedThread,
    };
  }

  return {
    buildLocalContinuationPrompt,
    configureThread,
    executeFollowUpTurn,
    manageQueue,
    publishRuntimeRequestResolution,
    respondRuntimeRequest,
    retryRun,
    sendToThread,
  };
}

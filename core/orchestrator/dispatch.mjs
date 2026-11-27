import { readPlanDocument, specSelection } from "../spec-context.mjs";
import { buildAgyPinnedModelId, isInheritedModel, splitAgyModelVariant, swarmMemberName } from "../catalog.mjs";
import { readNativeSwarmSnapshot, resolveDefaultAppDataDir } from "../engines/agy-native.mjs";
import { nativePath } from "../storage-paths.mjs";
import { cleanupWorktree, createIsolatedWorktree, getRepoRoot } from "../worktree.mjs";
import {
  normalizeProjectPath,
  projectPathKey,
  isIsolatedWorktreePath,
  resolveEphemeralFlag,
  shouldHideExternalSession,
  makeId,
  summarizeTitle,
  summarizeOutput,
  isThreadBusyStatus,
  enrichThreadForClient,
  deriveCleanMemberName,
} from "./helpers.mjs";

const FINAL_REPORT_LIMIT = 8000;
const BATCH_REPORT_BUDGET = 16000;

// In-process only (never serialisable from MCP/RPC input): a batch hands its pre-resolved repo root to each item.
const BATCH_CONTEXT = Symbol("batchContext");

/** Read-only evidence paths travel next to the spec selection until spec-context owns them. */
export function readPathsSelection(params = {}) {
  const readPaths = Array.isArray(params.readPaths)
    ? [...new Set(params.readPaths.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()))] : [];
  return readPaths.length ? { readPaths } : {};
}

/** Cut a report to `limit` chars and describe how to read the rest through thread_read({ itemId, textOffset }). */
export function clipFinalReport(report, limit = FINAL_REPORT_LIMIT) {
  if (typeof report?.finalReport !== "string" || report.finalReport.length <= limit) return report;
  return { ...report, finalReport: report.finalReport.slice(0, limit), finalReportTruncated: true,
    finalReportTotalLength: report.finalReportTotalLength ?? report.finalReport.length,
    itemId: report.itemId ?? null, nextTextOffset: limit };
}

const REPORT_KEYS = ["finalReport", "finalReportTruncated", "finalReportTotalLength", "itemId", "nextTextOffset"];
function withoutReport(result) {
  if (!result || typeof result !== "object" || !("finalReport" in result)) return result;
  const rest = { ...result };
  for (const key of REPORT_KEYS) delete rest[key];
  return rest;
}

export function createDispatchModule(ctx) {
  const nativeHandoffs = new Map();
  let handoffSequence = 0;

  function lastAssistantItem(threadId, runId) {
    if (!threadId) return null;
    return ctx.db.listTurnItems({ threadId, ...(runId ? { runId } : {}), view: "last_assistant", limit: 1, tail: true })[0] || null;
  }

  /** Full final answer for a finished turn: external runs keep assistantText, native child sessions only have items. */
  function finalReportFields({ threadId, runId, run }, limit = FINAL_REPORT_LIMIT) {
    const item = lastAssistantItem(threadId, runId);
    const runText = String(run?.assistantText || "");
    const text = runText.trim() ? runText : String(item?.text || "");
    const itemId = item && item.text === text ? item.id : runText && run?.id ? `report:${run.id}` : null;
    return clipFinalReport({ finalReport: text, ...(itemId ? { itemId } : {}) }, limit);
  }

  function findNativeHandoff({ handoffId = "", rootConversationId = "", conversationId = "", presetKey = "", swarmName = "", label = "", nativeKind = "",
    role = "", unboundWorkspace = "", includeClaimed = false, requireUnique = false, matchesToolArgs } = {}) {
    const rootKey = String(rootConversationId || "").toLowerCase();
    const convKey = String(conversationId || "").toLowerCase();
    const labelKey = String(label || "").trim().toLowerCase();
    const matches = [...nativeHandoffs.values()].filter(ticket =>
      (includeClaimed || !ticket.claimedAt) && (!ticket.expiresAt || ticket.claimedAt || ticket.expiresAt > Date.now()) &&
      (!handoffId || ticket.handoffId === handoffId) &&
      (!rootKey || ticket.rootConversationId.toLowerCase() === rootKey ||
        (!ticket.rootConversationId && unboundWorkspace && projectPathKey(ticket.repoRoot) === projectPathKey(unboundWorkspace))) &&
      (!convKey || String(ticket.conversationId || "").toLowerCase() === convKey) &&
      (!presetKey || ticket.presetKey === presetKey) &&
      (!labelKey || String(ticket.label || "").trim().toLowerCase() === labelKey) &&
      (!nativeKind || ticket.nativeKind === nativeKind) &&
      (!role || ticket.role === role) &&
      (!matchesToolArgs || matchesToolArgs(ticket.hostAction)) &&
      (!swarmName || ticket.swarmName.toLowerCase() === String(swarmName).toLowerCase()));
    if (requireUnique && matches.length !== 1) return null;
    return matches.sort((a, b) => b.sequence - a.sequence)[0] || null;
  }

  function createNativeHostHandoff({ params = {}, resolved, rootConversationId = "", role = "executor", brief = "", cwd = "", repoRoot = "", activeMode, curation } = {}) {
    if (resolved?.provider !== "antigravity") return null;
    const settings = ctx.db.getSettings(repoRoot);
    const acpMode = params.antigravityAcpMode || settings.antigravityAcpMode || "off";
    if (acpMode === "api_key") return null;
    const resolvedPresetKey = resolved.routing?.requestedPresetKey || params.presetKey || "";
    const preset = settings.presets?.[resolvedPresetKey] || {};
    const normalizedRole = resolved.role === "curator" ? "curator" :
      preset.group === "reviewer" ? "review" : preset.group || role || "executor";
    const curator = normalizedRole === "curator";
    // Validate only: the plan body reaches the child once, privately, through PreInvocation (nativeChildPlaybook).
    const plan = readPlanDocument({ cwd, repoRoot, planPath: params.planPath });
    const handoffId = makeId("hnd");
    const requestedModel = resolved.model;
    const coarseModel = isInheritedModel(requestedModel) ? "inherit" : splitAgyModelVariant(requestedModel).model.toLowerCase();
    const resident = params.multiTurn === true || params.persistSession === true || params.nativeResident === true;
    const nativeKind = (isInheritedModel(requestedModel) || ["pro", "flash", "flash_lite"].includes(coarseModel)) && !resident
      ? "subagent" : "swarm";
    let swarmName = swarmMemberName(resolvedPresetKey || params.memberName || normalizedRole);
    if (!swarmName || ["all", "coordinator"].includes(swarmName)) swarmName = "tower-agent";
    const label = preset.label || preset.title || resolvedPresetKey || normalizedRole;
    const rawTask = String(brief || "").trim();
    let nativeBrief = rawTask;
    if (curator) {
      nativeBrief = `[AgentTower Curation Ticket #${handoffId}]\n${nativeBrief}`;
      nativeBrief += "\n\n仅做只读梳理，严禁改写任何文件或执行命令。回复末尾必须附唯一一个以 ```agent-tower-spec-proposal 开头的完整代码块。";
      if (nativeKind === "swarm") nativeBrief += "向 @coordinator 发送 [done] 消息，消息末尾附同一个完整代码块，再调用 swarm_wait。";
    }
    if (normalizedRole === "advisor" && nativeKind === "swarm") {
      nativeBrief += "\n\n完成独立盲评后向 @coordinator 发 `@coordinator [done]`，随后调用 swarm_wait；不要先读他人黑板。";
    }
    if (plan?.relPath) nativeBrief += `\n\n定稿规划：${plan.relPath}（已由宿主注入，若未见 <agent_tower_plan> 请直接读取该文件）`;
    let tool;
    let args;
    let residentConversationId;
    let boardHead;
    if (nativeKind === "subagent") {
      tool = "invoke_subagent";
      args = { TypeName: curator ? "research" : "self", Role: label, Model: coarseModel,
        Workspace: resolved.isolation === "worktree" ? "share" : "inherit", Prompt: nativeBrief };
    } else {
      const cachedSnapshot = ctx.latestSwarmSnapshots.get(rootConversationId) ||
        ctx.latestSwarmSnapshots.get(String(rootConversationId).toLowerCase());
      const liveSnapshot = (!cachedSnapshot || curator) && rootConversationId ? readNativeSwarmSnapshot({
        conversationId: rootConversationId,
        appDataDir: resolveDefaultAppDataDir(params.appDataDir || ctx.hostContext.appDataDir, ctx.hostSync.buildHostEnvForDriver()),
      }) : null;
      const snapshot = liveSnapshot?.found ? liveSnapshot : cachedSnapshot;
      if (liveSnapshot?.found) ctx.latestSwarmSnapshots.set(liveSnapshot.rootConversationId, liveSnapshot);
      boardHead = Number(snapshot?.head || 0);
      const waiting = snapshot?.members?.find(member => member.name.toLowerCase() === swarmName.toLowerCase() &&
        member.state === "waiting" && !member.killed);
      if (waiting) {
        tool = "post_message";
        args = { text: `@${swarmName} ${nativeBrief}` };
        residentConversationId = waiting.conversation_id;
      } else {
        tool = "swarm";
        args = { action: "add", name: swarmName, model: buildAgyPinnedModelId(requestedModel, resolved.effort),
          workspace: resolved.isolation === "worktree" ? "share" : "inherit", brief: nativeBrief };
      }
    }
    const hostPrompt = `${curator ? `[AgentTower Curation Ticket #${handoffId}]\n` : ""}请执行宿主原生派遣票据 #${handoffId}：调用 ${tool}，参数 ${JSON.stringify(args)}。严禁调用 agentapi new-conversation 或 agy acp。`;
    const hostAction = { handoffId, presetKey: resolvedPresetKey, label, role: normalizedRole, nativeKind, tool, args, hostPrompt };
    const ticket = { handoffId, rootConversationId: String(rootConversationId || ""), presetKey: resolvedPresetKey,
      label, role: normalizedRole, nativeKind, swarmName, requestedModel, cwd: cwd || "", repoRoot: repoRoot || "",
      ...specSelection(params), ...readPathsSelection(params),
      temporaryOverride: Boolean(resolved.routing?.temporaryOverride),
      planPath: plan?.relPath || "", rawTask, brief: nativeBrief, hostAction, sequence: ++handoffSequence, createdAt: Date.now() };
    if (curator) ctx.specs.issueNativeCuration(ticket, { ...curation, residentConversationId, boardHead });
    nativeHandoffs.set(handoffId, ticket);
    if (curator && ticket.rootConversationId && ctx.hostSync.nativeTranscriptAvailable(ticket.rootConversationId)) {
      void ctx.hostSync.syncNativeHostConversation(ticket.rootConversationId, { workspace: repoRoot }).catch(error => ctx.log(error.message));
    }
    while (nativeHandoffs.size > 256) {
      const oldest = [...nativeHandoffs.values()].find(item => item.role !== "curator");
      if (!oldest) break;
      nativeHandoffs.delete(oldest.handoffId);
    }
    return { ok: true, bypassed: false, status: "waiting_host_dispatch", code: "HOST_DISPATCH_REQUIRED",
      handoffId, nativeKind, presetKey: resolvedPresetKey, role: normalizedRole, hostAction, hostActions: [hostAction],
      ...(curator ? { runId: ticket.runId } : {}),
      ...(ticket.temporaryOverride ? { temporaryOverride: true } : {}),
      summary: `待宿主执行原生派遣票据 #${handoffId}（${tool} -> ${resolvedPresetKey || swarmName}）`, activeMode: activeMode || ctx.scopePolicy.getActiveModeSummary({ conversationId: rootConversationId, workspace: repoRoot }) };
  }

  function claimNativeHandoff({ rootConversationId, presetKey, swarmName, label, nativeKind, conversationId, curationPrompt, invocation = false,
    swarmState = "", freshOutput = false }) {
    if (!rootConversationId) return null;
    const existing = conversationId && findNativeHandoff({ rootConversationId, conversationId, nativeKind, includeClaimed: true });
    // A waiting Swarm member woken for a second job must bind the newer unclaimed ticket (new brief / planPath)
    // instead of replaying the ticket its conversation claimed last time.
    const member = existing && nativeKind === "swarm"
      ? { presetKey: presetKey || existing.presetKey || "", swarmName: swarmName || existing.swarmName || "" }
      : { presetKey, swarmName };
    const ticket = (label && (!existing || nativeKind === "swarm") ? findNativeHandoff({ rootConversationId, ...member, label, nativeKind }) : null) ||
      (!existing || (nativeKind === "swarm" && (member.presetKey || member.swarmName)) ? findNativeHandoff({ rootConversationId, ...member, nativeKind, requireUnique: !member.presetKey && !member.swarmName }) : null);
    if (!ticket || (existing && ticket.sequence < existing.sequence)) return existing || null;
    if (ticket.role === "curator" && nativeKind === "subagent" &&
        curationPrompt !== ticket.hostAction.args.Prompt) return existing || null;
    if (ticket.role === "curator" && nativeKind === "swarm" && !swarmName && !member.presetKey) return existing || null;
    if (ticket.role === "curator" && (!conversationId || !(
      ticket.admittedAt || (ticket.residentConversationId?.toLowerCase() === conversationId.toLowerCase() &&
        (invocation || freshOutput || ["working", "running"].includes(String(swarmState).toLowerCase())))
    ))) return existing || null;
    if (ticket.role === "curator" && !ctx.specs.claimNativeCuration(ticket, conversationId)) return existing || null;
    ticket.claimedAt = Date.now();
    ticket.conversationId = conversationId || "";
    return ticket;
  }

  function delegateWaitTimeout(params, settings) {
    const mode = String(params.mode || settings.defaultMode || "async").toLowerCase();
    return mode === "wait" || mode === "sync" ? Math.max(1000, Number(params.timeoutMs) || 600000) : 0;
  }

  function findReusableRoleThread({ rootConversationId, repoRoot, role, presetKey, memberName, provider }, roster) {
    if (!rootConversationId) return null;
    const members = roster ?? ctx.db.listRoleThreads(repoRoot, role, rootConversationId);
    return members.find(t => !t.archived && !t.isNativeHost && !t.meta?.ephemeral && !t.worktreePath && t.isolation !== "worktree" && !t.meta?.targetWorktreeId &&
      !isThreadBusyStatus(t.status) && !ctx.activeRunByThread.has(t.id) && !ctx.pendingTurnStartLocks.has(t.id) &&
      (presetKey
        ? t.presetKey === presetKey || (!t.presetKey && t.provider === provider && (t.meta?.baseMemberName || t.meta?.memberName) === memberName)
        : t.provider === provider && (t.meta?.baseMemberName || t.meta?.memberName) === memberName) && !ctx.db.listQueuedRuns(t.id).length);
  }

  function allocateRoleMember(scope, allowReuse) {
    const roster = scope.rootConversationId ? ctx.db.listRoleThreads(scope.repoRoot, scope.role, scope.rootConversationId) : [];
    let existing = allowReuse && findReusableRoleThread(scope, roster);
    // New work orders keep the idle member card but start a clean native session unless explicitly continued.
    if (existing && scope.continueSession !== true &&
      (existing.nativeSessionId || existing.meta?.pendingHandoffFromProvider || existing.meta?.usageReported ||
        Object.values(existing.usage || {}).some((value) => value))) {
      existing = ctx.db.upsertThread({
        id: existing.id,
        nativeSessionId: null,
        usage: {
          inputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextUsed: 0,
          contextLimit: existing.usage?.contextLimit || 0,
        },
        meta: { ...existing.meta, pendingHandoffFromProvider: null, usageReported: false },
      });
    }
    if (existing) return { existing, memberName: existing.meta.memberName || scope.memberName };
    const names = new Set(roster.filter(t => !t.meta?.ephemeral).map(t => t.meta?.memberName));
    let memberName = scope.memberName;
    for (let n = 2; names.has(memberName); n++) memberName = `${scope.memberName}-${n}`;
    return { existing: null, memberName };
  }

  async function waitForDelegateResult(base, remainingMs, { includeReport = true } = {}) {
    const { threadId, runId } = base;
    const isTerminal = run => ["completed", "failed", "interrupted"].includes(run?.status);
    const isBlocked = t => (!runId || t?.activeRunId === runId) && ["waiting_approval", "waiting_input"].includes(t?.status);
    const { timedOut } = await ctx.context.withSynchronousWait(remainingMs > 0 && (runId || threadId), () => ctx.context.waitForCondition(() => {
      const cur = ctx.db.getThread(threadId, { includeQueue: false });
      return isBlocked(cur) || (runId ? isTerminal(ctx.db.getRun(runId)) : cur && ctx.queries.computeWorkState(cur) === "result_available");
    }, remainingMs, 400));
    const latest = ctx.db.getThread(threadId, { includeQueue: false });
    const run = runId && ctx.db.getRun(runId);
    const workState = runId ? (isTerminal(run) ? "result_available" : "working") : ctx.queries.computeWorkState(latest);
    const report = includeReport !== false && (runId ? isTerminal(run) : workState === "result_available")
      ? finalReportFields({ threadId, runId, run }) : {};
    return {
      ...withoutReport(base), childThreadId: threadId,
      provider: run?.provider || base.provider, model: run?.model || base.model,
      effort: run?.effort || base.effort, isolation: base.isolation || latest?.isolation,
      status: isBlocked(latest) ? latest.status : run?.status || base.status,
      workState,
      waitTimedOut: timedOut, summary: runId ? summarizeOutput(run?.assistantText) : latest?.summary || "",
      error: (runId ? run?.error : latest?.lastError) || null, usage: (runId ? run?.usage : latest?.usage) || {},
      pendingRequests: ctx.db.listPendingRequests({ threadId }).filter(r => !runId || r.runId === runId),
      ...report,
    };
  }

  const reportOpts = params => ({ includeReport: params.includeReport !== false });

  async function assertCuratorSpecEnabled(params) {
    ctx.specs.assertSpecEnabled(await ctx.queries.resolveRepoRootCached(ctx.scopePolicy.executionRoot(params)));
  }

  async function delegateTask(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    params = ctx.scopePolicy.withDispatchConversation(params);
    if (params.role === "curator") await assertCuratorSpecEnabled(params);
    const bypass = ctx.scopePolicy.dispatchBypass(params);
    if (bypass) return bypass;
    const reqKey = String(params.clientRequestId ?? "").trim();
    if (!reqKey) return delegateTaskCore({ ...params, clientRequestId: undefined });
    const flightKey = `delegateTask:${reqKey}`;
    const waitMs = delegateWaitTimeout(params, ctx.db.getSettings());
    const deadline = Date.now() + (waitMs || 10000);
    const pending = { status: "pending", ownerPid: process.pid, threadId: makeId("thr"), taskId: params.taskId || makeId("task"), runId: makeId("run") };
    async function dispatchOnce() {
      const root = params[BATCH_CONTEXT]?.root || await ctx.queries.resolveRepoRootCached(ctx.scopePolicy.executionRoot(params));
      while (true) {
        const denied = ctx.scopePolicy.dispatchBypass(params);
        if (denied) return denied;
        if (ctx.db.claimCommandReceipt(reqKey, pending, "delegateTask", root)) break;
        const receipt = ctx.db.getCommandReceipt(reqKey, "delegateTask");
        if (!receipt) continue;
        const remainingMs = Math.max(0, deadline - Date.now());
        if (receipt.status !== "pending" || !receipt.ownerPid) {
          if (receipt.code === "HOST_DISPATCH_REQUIRED") return receipt;
          if (waitMs && receipt.waitTimedOut === undefined) return waitForDelegateResult(receipt, remainingMs, reportOpts(params));
          return params.includeReport === false ? withoutReport(receipt) : receipt;
        }
        const t = ctx.db.getThread(receipt.threadId, { includeQueue: false });
        if (t) {
          if (waitMs) return waitForDelegateResult(receipt, remainingMs, reportOpts(params));
          return { taskId: receipt.taskId, childThreadId: t.id, threadId: t.id, runId: receipt.runId, status: t.status, provider: t.provider, model: t.model };
        }
        try { process.kill(receipt.ownerPid, 0); } catch (err) {
          if (err.code === "ESRCH" && ctx.db.releaseCommandReceipt(reqKey, receipt)) continue;
        }
        if (!remainingMs) {
          if (waitMs) return waitForDelegateResult(receipt, 0, reportOpts(params));
          return { status: "pending", taskId: receipt.taskId, threadId: receipt.threadId, runId: receipt.runId };
        }
        await new Promise(resolve => setTimeout(resolve, Math.min(50, remainingMs)));
      }
      try {
        const result = await delegateTaskCore({ ...params, clientRequestId: reqKey }, pending);
        if (result.bypassed) ctx.db.releaseCommandReceipt(reqKey, pending);
        else if (result.code === "HOST_DISPATCH_REQUIRED") ctx.db.saveCommandReceipt(reqKey, "delegateTask", result);
        return result;
      }
      catch (err) { ctx.db.releaseCommandReceipt(reqKey, pending); throw err; }
    }
    if (ctx.inFlightClientRequests.has(flightKey)) {
      return waitMs ? dispatchOnce() : ctx.inFlightClientRequests.get(flightKey);
    }
    const flight = dispatchOnce().finally(() => ctx.inFlightClientRequests.delete(flightKey));
    ctx.inFlightClientRequests.set(flightKey, flight);
    return flight;
  }

  function dispatchCurator(params, source, beforeStart) {
    return ctx.updates.runWrite("dispatchCurator", params,
      () => delegateTaskCore({ ...params, role: "curator", _skipInferConversation: true }, undefined, { source, beforeStart }));
  }

  async function createRequiredWorktree(options) {
    try {
      return await createIsolatedWorktree(options);
    } catch (wtErr) {
      const rawMessage = wtErr?.message || String(wtErr);
      const suffix = "（已拒绝退回原工作目录执行）";
      const message = rawMessage.endsWith(suffix) ? rawMessage : `${rawMessage}${suffix}`;
      throw Object.assign(new Error(message, { cause: wtErr }), {
        code: typeof wtErr?.code === "string" && wtErr.code ? wtErr.code : "WORKTREE_CREATE_FAILED",
      });
    }
  }

  async function delegateTaskCore(params = {}, claim, curation) {
    const rawTask = String(params.task ?? params.prompt ?? params.message ?? "").trim();
    if (!rawTask) {
      throw new Error("delegateTask 需要非空的 task 任务描述");
    }

    const rootConversationId = ctx.scopePolicy.policyRoot(params);
    const policy = ctx.scopePolicy.readConversationPolicy(rootConversationId);
    let orchestrationMode = policy.orchestrationMode;
    const executionIntent = params.executionIntent;
    if (executionIntent && !["read", "write"].includes(executionIntent)) {
      throw Object.assign(new Error("executionIntent 仅支持 read 或 write"), { code: "INVALID_EXECUTION_INTENT" });
    }

    const batch = params[BATCH_CONTEXT];
    const baseWorkspace = ctx.scopePolicy.executionRoot(params);
    let repoRoot = curation ? baseWorkspace : batch?.base === baseWorkspace ? batch.root : (await getRepoRoot(baseWorkspace)) || baseWorkspace;

    let effectiveParentThreadId = params.parentThreadId || null;
    if (!effectiveParentThreadId && (params.parentConversationId || params.conversationId)) {
      const parentHost = ctx.hostSync.findThreadByHostConversationId(params.parentConversationId || params.conversationId);
      if (parentHost) effectiveParentThreadId = parentHost.id;
    }
    if (!params.cwd && !params.workspace && effectiveParentThreadId) {
      const pThread = ctx.db.getThread(effectiveParentThreadId, { includeQueue: false });
      const pRoot = pThread?.meta?.projectRoot || pThread?.workspace;
      if (pRoot && !isIsolatedWorktreePath(pRoot)) {
        repoRoot = pRoot;
      }
    }
    repoRoot = normalizeProjectPath(repoRoot);
    const validBatchTarget = () => batch?.mode === orchestrationMode && batch.projectKey === projectPathKey(repoRoot) &&
      batch.revision === ctx.db.getProjectRoster(repoRoot).rosterRevision;
    const resolveTarget = curation ? ctx.catalogSettings.resolveCuratorTarget : ctx.catalogSettings.resolveEffectiveTarget;
    let resolved = validBatchTarget() ? batch.resolved : await resolveTarget({
      ...params, workspace: repoRoot, role: params.role || "executor", orchestrationMode,
      allowDisabledPreset: Boolean(params.presetKey) && params.allowDisabledPreset === true,
    });
    const rechecked = !curation && ctx.scopePolicy.dispatchBypass(params);
    if (rechecked) return rechecked;
    const nativeTarget = () => resolved.provider === "antigravity" &&
      (params.antigravityAcpMode || ctx.db.getSettings(repoRoot).antigravityAcpMode) !== "api_key";
    const issueNative = () => createNativeHostHandoff({ params, resolved, rootConversationId, role: params.role || "executor",
      brief: rawTask, cwd: baseWorkspace, repoRoot, curation: { source: curation?.source, ticketTtlMs: params.ticketTtlMs } });
    if (nativeTarget()) {
      if (curation?.beforeStart && !await curation.beforeStart(true)) return null;
      return issueNative();
    }
    if (resolved.role !== "curator") readPlanDocument({ cwd: baseWorkspace, repoRoot, planPath: params.planPath });

    let threadId = claim?.threadId;
    const taskId = claim?.taskId || params.taskId || makeId("task");
    const title = params.title ? String(params.title).trim() : summarizeTitle(rawTask, "Delegated Subagent");

    let effectiveIsolation = resolved.isolation;
    let worktreeInfo = null;
    if (effectiveIsolation === "worktree") {
      threadId ||= makeId("thr");
      worktreeInfo = await createRequiredWorktree({
        cwd: baseWorkspace,
        workspace: repoRoot,
        threadId,
        taskSlug: title,
        branch: params.branch || params.workspaceStrategy?.branch,
        baseRef: params.baseRef || params.workspaceStrategy?.baseRef || "HEAD",
      });
    }

    const afterWorktreeBypass = !curation && ctx.scopePolicy.dispatchBypass(params);
    if (afterWorktreeBypass) {
      if (worktreeInfo?.worktreePath) await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
      return afterWorktreeBypass;
    }
    try {
      const currentPolicy = ctx.scopePolicy.readConversationPolicy(rootConversationId);
      const currentBypass = !curation && ctx.scopePolicy.dispatchBypass(params);
      if (currentBypass) {
        if (worktreeInfo?.worktreePath) await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
        return currentBypass;
      }
      orchestrationMode = currentPolicy.orchestrationMode;
      if (!validBatchTarget()) resolved = await resolveTarget({
        ...params,
        workspace: repoRoot,
        role: params.role || "executor",
        presetKey: resolved.routing?.requestedPresetKey || params.presetKey,
        orchestrationMode,
        executionIntent: params.executionIntent,
        allowDisabledPreset: Boolean(params.presetKey) && params.allowDisabledPreset === true,
      });
      if (nativeTarget()) {
        if (worktreeInfo?.worktreePath) await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
        if (curation?.beforeStart && !await curation.beforeStart(true)) return null;
        return issueNative();
      }
      if (resolved.isolation !== effectiveIsolation) {
        if (worktreeInfo?.worktreePath && resolved.isolation !== "worktree") {
          await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
          worktreeInfo = null;
        }
        effectiveIsolation = resolved.isolation;
      }
      if (effectiveIsolation === "worktree" && !worktreeInfo) {
        threadId ||= makeId("thr");
        worktreeInfo = await createRequiredWorktree({
          cwd: baseWorkspace, workspace: repoRoot, threadId, taskSlug: title,
          branch: params.branch || params.workspaceStrategy?.branch,
          baseRef: params.baseRef || params.workspaceStrategy?.baseRef || "HEAD",
        });
      }
    } catch (error) {
      if (worktreeInfo?.worktreePath) await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
      throw error;
    }
    if (curation?.beforeStart && !await curation.beforeStart(false)) return null;
    if (resolved.role === "curator") ctx.specs.assertCuratorAvailable(repoRoot);
    const execCwd = nativePath(worktreeInfo?.worktreePath || (resolved.role === "curator" ? repoRoot : baseWorkspace));
    const isDisposableThread = resolveEphemeralFlag(params, [baseWorkspace, repoRoot, execCwd]);
    const settings = ctx.db.getSettings(repoRoot);
    const activePresets = settings.presets;
    const selectedPreset = resolved.routing?.requestedPresetKey ? activePresets[resolved.routing.requestedPresetKey] : null;
    const effectiveRole = resolved.role || (selectedPreset?.group === "reviewer" ? "review" : selectedPreset?.group || params.role || "executor");
    const memberKey = resolved.routing?.requestedPresetKey;
    const baseMemberName = params.memberName || deriveCleanMemberName({ role: effectiveRole, presetKey: memberKey, provider: resolved.provider });
    // continueSession (or the legacy explicit freshContext: false) resumes the member's previous native session.
    const continueSession = params.freshContext !== true && (params.continueSession === true || params.freshContext === false);
    const { existing, memberName } = allocateRoleMember({ rootConversationId, repoRoot, role: effectiveRole,
      presetKey: memberKey, memberName: baseMemberName, provider: resolved.provider, continueSession },
      params.createNewThread !== true && params.forceNewThread !== true && effectiveIsolation !== "worktree" && !isDisposableThread);
    threadId = existing?.id || threadId || makeId("thr");
    const switched = existing && existing.provider !== resolved.provider;
    const hideExternalSession = isDisposableThread || shouldHideExternalSession(ctx.db, continueSession ? existing : null, repoRoot, params.persistSession);
    const freshSession = !continueSession || switched;
    const reuseNativeSession = !freshSession && !hideExternalSession && Boolean(existing?.nativeSessionId);
    const effectivePrompt = existing && continueSession && !reuseNativeSession
      ? ctx.turns.buildLocalContinuationPrompt(existing, existing.provider, resolved.provider, rawTask) : rawTask;

    const thread = ctx.db.upsertThread({
      id: threadId,
      taskId,
      parentThreadId: existing ? existing.parentThreadId : effectiveParentThreadId,
      parentConversationId: params.parentConversationId || params.conversationId || null,
      title,
      role: effectiveRole,
      presetKey: memberKey || existing?.presetKey || null,
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
      permissionMode: resolved.permissionMode,
      interactionMode: resolved.interactionMode,
      isolation: effectiveIsolation,
      status: "starting",
      nativeSessionId: freshSession || hideExternalSession ? null : undefined,
      ...(existing && freshSession ? {
        usage: {
          inputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          contextUsed: 0,
          contextLimit: existing.usage?.contextLimit || 0,
        },
      } : {}),
      summary: "", completedAt: null, startedAt: Date.now(), durationMs: 0,
      workspace: repoRoot,
      cwd: execCwd,
      worktreePath: worktreeInfo?.worktreePath || null,
      worktreeId: worktreeInfo?.worktreeId || null,
      branch: worktreeInfo?.branch || null,
      baseRef: worktreeInfo?.baseRef || null,
      meta: {
        projectRoot: repoRoot,
        ...(effectiveRole === "curator" ? { triggerSource: curation?.source || "delegate" } : {}),
        memberName, baseMemberName,
        ...(isDisposableThread ? { ephemeral: true } : {}),
        externalSessionVisible: !hideExternalSession,
        ...(rootConversationId ? { rootConversationId } : {}),
        ...(worktreeInfo?.baseSha || worktreeInfo?.headSha ? { baseSha: worktreeInfo.baseSha || worktreeInfo.headSha } : {}),
        ...resolved.routing,
        orchestrationMode,
        ...(orchestrationMode === "relay" ? { executionIntent } : {}),
        ...(existing && freshSession ? { pendingHandoffFromProvider: null, usageReported: false } : {}),
      },
    });

    const enrichedThread = enrichThreadForClient(thread, { repoRootCache: ctx.repoRootCache, fallbackWorkspace: repoRoot });

    ctx.context.emitEvent({
      type: existing ? "thread_updated" : "thread_created",
      threadId,
      taskId,
      workspace: repoRoot,
      ...(rootConversationId ? { rootConversationId } : {}),
      thread: enrichedThread,
    });

    if (worktreeInfo) {
      ctx.context.emitEvent({
        type: "worktree_updated",
        threadId,
        workspace: repoRoot,
        worktree: worktreeInfo,
      });
    }

    const runId = claim?.runId || makeId("run");
    const run = ctx.db.upsertRun({
      id: runId,
      threadId,
      status: "starting",
      role: effectiveRole,
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
      permissionMode: resolved.permissionMode,
      interactionMode: resolved.interactionMode,
      prompt: rawTask,
      inputIntent: "delegate",
      meta: { taskId, title, ...resolved.routing, ...(params.inheritHostMcp === true ? { inheritHostMcp: true } : {}), ...specSelection(params), ...readPathsSelection(params), orchestrationMode, ...(orchestrationMode === "relay" ? { executionIntent } : {}) },
      cwd: execCwd,
    });

    ctx.db.upsertTurnItem({
      id: `item_user_${runId}`,
      threadId,
      runId,
      type: "user_message",
      role: "user",
      text: rawTask,
      status: "completed",
    });

    const execution = ctx.execution.startEngineExecution({
      thread,
      run,
      effectivePrompt,
      reuseNativeSession,
      ephemeral: hideExternalSession,
    });
    if (execution.bypassed) return execution;
    if (execution.started) await execution.started;

    const asyncResponse = {
      taskId,
      childThreadId: threadId,
      threadId,
      runId,
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
      isolation: effectiveIsolation,
      worktreeId: worktreeInfo?.worktreeId || null,
      worktreePath: worktreeInfo?.worktreePath || null,
      branch: worktreeInfo?.branch || null,
      status: "running",
      workState: "working",
      next: `Call task_status({ taskId: "${taskId}" }) or monitor live in AgentTower.`,
      activeMode: ctx.scopePolicy.getActiveModeSummary({ conversationId: rootConversationId, workspace: repoRoot }),
    };
    if (params.clientRequestId) ctx.db.saveCommandReceipt(params.clientRequestId, "delegateTask", asyncResponse);
    const waitMs = delegateWaitTimeout(params, settings);
    const response = waitMs
      ? await waitForDelegateResult({ ...asyncResponse, isolation: effectiveIsolation }, waitMs, reportOpts(params))
      : asyncResponse;
    if (params.clientRequestId) ctx.db.saveCommandReceipt(params.clientRequestId, "delegateTask", response);
    return response;
  }

  async function delegateParallelBatch(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    params = ctx.scopePolicy.withDispatchConversation(params);

    const tasks = Array.isArray(params.tasks) ? params.tasks : [];
    const bypass = ctx.scopePolicy.dispatchBypass(params);
    if (bypass) {
      for (const task of tasks) {
        if (task?.role !== "curator") continue;
        await assertCuratorSpecEnabled({ ...params, ...task, cwd: task.cwd ?? task.workspace ?? params.cwd });
      }
      return bypass;
    }
    const batchRoot = ctx.scopePolicy.policyRoot(params);
    if (tasks.length === 0) {
      throw new Error("delegateParallelBatch 需要至少包含 1 个任务的 tasks 数组");
    }

    if (tasks.length > 6 && params.allowLargeBatch !== true) throw new Error("单批最多 6 个任务，请拆分或显式传 allowLargeBatch: true");
    const catalog = await ctx.catalogSettings.ensureCatalog();
    const batchId = makeId("batch");
    const mode = String(params.mode || "async").toLowerCase();
    const shouldWaitAll = mode === "wait_all" || mode === "wait" || mode === "sync";
    const timeoutMs = Math.max(2000, Number(params.timeoutMs) || 600000);

    const batchConversationId = batchRoot;

    const repoRoots = new Map();
    const prepared = [];
    for (const item of tasks) {
      ctx.scopePolicy.explicitExecutionRoot(item);
      const merged = {
        ...item,
        cwd: item.cwd ?? item.workspace ?? params.cwd,
        workspace: item.workspace ?? params.workspace,
        parentThreadId: item.parentThreadId || params.parentThreadId,
        parentConversationId: item.parentConversationId || params.parentConversationId || batchConversationId,
        conversationId: item.conversationId || batchConversationId,
        planPath: item.planPath ?? params.planPath,
        continueSession: item.continueSession ?? params.continueSession,
        freshContext: item.freshContext ?? params.freshContext,
        ephemeral: item.ephemeral ?? params.ephemeral,
        persistSession: item.persistSession ?? params.persistSession,
        ...(item.readPaths ?? params.readPaths ? { readPaths: item.readPaths ?? params.readPaths } : {}),
        ...((item.includeReport ?? params.includeReport) === false ? { includeReport: false } : {}),
        _skipInferConversation: true,
        mode: shouldWaitAll ? "wait" : "async",
        timeoutMs,
      };
      const base = ctx.scopePolicy.executionRoot(merged);
      const mode = ctx.scopePolicy.readConversationPolicy(ctx.scopePolicy.policyRoot(merged)).orchestrationMode;

      if (!repoRoots.has(base)) repoRoots.set(base, await ctx.queries.resolveRepoRootCached(base));
      const root = repoRoots.get(base);
      const projectKey = projectPathKey(root);
      const revision = ctx.db.getProjectRoster(root).rosterRevision;
      const resolved = await ctx.catalogSettings.resolveEffectiveTarget({ ...merged, workspace: root, role: item.role || "executor", orchestrationMode: mode }, catalog);
      prepared.push({ ...merged, [BATCH_CONTEXT]: { base, root, projectKey, resolved, revision, mode } });
    }
    const launched = await Promise.all(prepared.map(item => delegateTask(item)));

    if (launched.every(r => r.bypassed && r.conversationId === launched[0].conversationId)) return launched[0];
    const allCompleted = launched.every((r) => r.status === "completed");
    // wait_all shares one report budget across the finished tasks.
    const reported = launched.filter(r => typeof r?.finalReport === "string").length;
    if (reported) {
      const share = Math.min(FINAL_REPORT_LIMIT, Math.floor(BATCH_REPORT_BUDGET / reported));
      for (let i = 0; i < launched.length; i++) launched[i] = clipFinalReport(launched[i], share);
    }
    const uniqueRoots = [...new Set(repoRoots.values())];
    const batchWorkspace = params.workspace || params.cwd
      ? await ctx.queries.resolveRepoRootCached(ctx.scopePolicy.executionRoot(params))
      : (uniqueRoots.length === 1 ? uniqueRoots[0] : ctx.scopePolicy.configWorkspace(params, batchRoot));
    return {
      batchId,
      mode: shouldWaitAll ? "wait_all" : "async",
      count: launched.length,
      allCompleted,
      tasks: launched,
      hostActions: launched.flatMap(result => result.hostActions || []),
      activeMode: ctx.scopePolicy.getActiveModeSummary({ conversationId: batchRoot, ...(batchWorkspace ? { workspace: batchWorkspace } : {}) }),
    };
  }

  async function getTaskStatus(params = {}) {
    const key = params.taskId || params.threadId || params.id;
    if (!key) throw new Error("getTaskStatus 需要提供 taskId 或 threadId");

    // A task identifies a single run even after its member accepts another task.
    const indexedRun = ctx.db.getTaskRun(key);
    // Follow-up runs carry the work order's taskId for Studio. Resolve the original run for task status.
    const taskRun = indexedRun && indexedRun.inputIntent !== "delegate"
      ? ctx.db.listRuns({ threadId: indexedRun.threadId, taskId: key, limit: 1 })[0] || indexedRun
      : indexedRun;
    if (taskRun) {
      const thread = ctx.db.getThread(taskRun.threadId);
      const result = await waitForDelegateResult({ taskId: key, threadId: thread.id, runId: taskRun.id,
        isolation: thread.isolation, worktreeId: thread.worktreeId, worktreePath: thread.worktreePath, branch: thread.branch },
        params.wait ? Math.max(500, Number(params.timeoutMs) || 120000) : 0, reportOpts(params));
      return { ...result, title: taskRun.meta.title, role: thread.role, queueCount: thread.queue.length,
        updatedAt: ctx.db.getRun(taskRun.id).updatedAt,
        activeMode: ctx.scopePolicy.getActiveModeSummary({ threadId: thread.id }) };
    }
    let thread = ctx.db.getThread(key);
    if (!thread) {
      throw new Error(`未找到任务或会话: ${key}`);
    }

    if (params.wait) {
      const timeoutMs = Math.max(500, Number(params.timeoutMs) || 120000);
      await ctx.context.withSynchronousWait(thread.id, () => ctx.context.waitForCondition(() => {
        const cur = ctx.db.getThread(thread.id, { includeQueue: false });
        if (!cur) return true;
        if (cur.status === "waiting_approval" || cur.status === "waiting_input") return true;
        return ctx.queries.computeWorkState(cur) === "result_available";
      }, timeoutMs));
      thread = ctx.db.getThread(thread.id);
    }

    const pendingRequests = ctx.db.listPendingRequests({ threadId: thread.id });
    const workState = ctx.queries.computeWorkState(thread);
    const finished = ["completed", "failed", "interrupted"].includes(thread.status) || workState === "result_available";
    const latestRun = finished && params.includeReport !== false ? ctx.db.getLatestRun(thread.id) : null;
    const report = finished && params.includeReport !== false
      ? finalReportFields({ threadId: thread.id, runId: latestRun?.id, run: latestRun }) : {};

    return {
      taskId: thread.taskId || thread.id,
      childThreadId: thread.id,
      threadId: thread.id,
      title: thread.title,
      role: thread.role,
      provider: thread.provider,
      model: thread.model,
      effort: thread.effort,
      isolation: thread.isolation,
      worktreeId: thread.worktreeId,
      worktreePath: thread.worktreePath,
      branch: thread.branch,
      status: thread.status,
      workState,
      summary: thread.summary || "",
      error: thread.lastError || null,
      usage: thread.usage,
      queueCount: Array.isArray(thread.queue) ? thread.queue.length : 0,
      pendingRequests,
      updatedAt: thread.updatedAt,
      activeMode: ctx.scopePolicy.getActiveModeSummary({ threadId: thread.id }),
      ...report,
    };
  }

  async function launchThread(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    params = ctx.scopePolicy.withDispatchConversation(params);
    if (params.role === "curator") await assertCuratorSpecEnabled(params);
    const bypass = ctx.scopePolicy.dispatchBypass(params);
    if (bypass) return bypass;
    const launchRootConvId = ctx.scopePolicy.policyRoot(params);
    const launchPolicy = ctx.scopePolicy.readConversationPolicy(launchRootConvId);
    let orchestrationMode = launchPolicy.orchestrationMode;
    const executionIntent = params.executionIntent;

    const initialMessage = String(params.message ?? params.prompt ?? "").trim();
    const baseWorkspace = ctx.scopePolicy.executionRoot(params);
    let repoRoot = (await getRepoRoot(baseWorkspace)) || baseWorkspace;

    let effectiveParentThreadId = params.parentThreadId || null;
    if (!effectiveParentThreadId && (params.parentConversationId || params.conversationId)) {
      const parentHost = ctx.hostSync.findThreadByHostConversationId(params.parentConversationId || params.conversationId);
      if (parentHost) effectiveParentThreadId = parentHost.id;
    }
    if (!params.cwd && !params.workspace && effectiveParentThreadId) {
      const pThread = ctx.db.getThread(effectiveParentThreadId, { includeQueue: false });
      const pRoot = pThread?.meta?.projectRoot || pThread?.workspace;
      if (pRoot && !isIsolatedWorktreePath(pRoot)) {
        repoRoot = pRoot;
      }
    }
    repoRoot = normalizeProjectPath(repoRoot);
    let resolved = await ctx.catalogSettings.resolveEffectiveTarget({
      workspace: repoRoot,
      role: params.role || "general",
      presetKey: params.presetKey,
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      modelSelection: params.modelSelection,
      permissionMode: params.permissionMode,
      runtimeMode: params.runtimeMode,
      interactionMode: params.interactionMode,
      isolation: params.isolation,
      workspaceStrategy: params.workspaceStrategy,
      target: params.target,
      orchestrationMode,
      executionIntent,
      allowDisabledPreset: Boolean(params.presetKey) && params.allowDisabledPreset === true,
    });

    const rechecked = ctx.scopePolicy.dispatchBypass(params);
    if (rechecked) return rechecked;
    const nativeHandoff = createNativeHostHandoff({ params, resolved, rootConversationId: launchRootConvId,
      role: params.role || "general", brief: initialMessage, cwd: baseWorkspace, repoRoot });
    if (nativeHandoff) return nativeHandoff;
    if (resolved.role !== "curator") readPlanDocument({ cwd: baseWorkspace, repoRoot, planPath: params.planPath });

    const threadId = makeId("thr");
    const title = params.title
      ? String(params.title).trim()
      : initialMessage
        ? summarizeTitle(initialMessage, "New Session")
        : "New Session";

    let effectiveIsolation = resolved.isolation;
    let worktreeInfo = null;
    if (effectiveIsolation === "worktree") {
      worktreeInfo = await createRequiredWorktree({
        cwd: baseWorkspace,
        workspace: repoRoot,
        threadId,
        taskSlug: title,
        branch: params.branch || params.workspaceStrategy?.branch,
        baseRef: params.baseRef || params.workspaceStrategy?.baseRef || "HEAD",
      });
    }

    const afterWorktreeBypass = ctx.scopePolicy.dispatchBypass(params);
    if (afterWorktreeBypass) {
      if (worktreeInfo?.worktreePath) await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
      return afterWorktreeBypass;
    }
    try {
      const currentPolicy = ctx.scopePolicy.readConversationPolicy(launchRootConvId);
      const currentBypass = ctx.scopePolicy.dispatchBypass(params);
      if (currentBypass) {
        if (worktreeInfo?.worktreePath) await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
        return currentBypass;
      }
      orchestrationMode = currentPolicy.orchestrationMode;
      resolved = await ctx.catalogSettings.resolveEffectiveTarget({
        ...params,
        workspace: repoRoot,
        role: params.role || "general",
        presetKey: resolved.routing?.requestedPresetKey || params.presetKey,
        orchestrationMode,
        executionIntent: params.executionIntent,
        allowDisabledPreset: Boolean(params.presetKey) && params.allowDisabledPreset === true,
      });
      const reroutedNative = createNativeHostHandoff({ params, resolved, rootConversationId: launchRootConvId,
        role: params.role || "general", brief: initialMessage, cwd: baseWorkspace, repoRoot });
      if (reroutedNative) {
        if (worktreeInfo?.worktreePath) await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
        return reroutedNative;
      }
      if (resolved.isolation !== effectiveIsolation) {
        if (worktreeInfo?.worktreePath && resolved.isolation !== "worktree") {
          await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
          worktreeInfo = null;
        }
        effectiveIsolation = resolved.isolation;
      }
      if (effectiveIsolation === "worktree" && !worktreeInfo) {
        worktreeInfo = await createRequiredWorktree({
          cwd: baseWorkspace, workspace: repoRoot, threadId, taskSlug: title,
          branch: params.branch || params.workspaceStrategy?.branch,
          baseRef: params.baseRef || params.workspaceStrategy?.baseRef || "HEAD",
        });
      }
    } catch (error) {
      if (worktreeInfo?.worktreePath) await cleanupWorktree({ worktreePath: worktreeInfo.worktreePath, repoRoot, force: true }).catch(() => {});
      throw error;
    }
    const execCwd = nativePath(worktreeInfo?.worktreePath || baseWorkspace);
    const isDisposableThread = resolveEphemeralFlag(params, [baseWorkspace, repoRoot, execCwd]);
    const hideExternalSession = isDisposableThread || shouldHideExternalSession(ctx.db, null, repoRoot, params.persistSession);
    const role = params.role || "general";
    const launchSettings = ctx.db.getSettings(repoRoot);
    const launchPresets = launchSettings.presets || launchSettings.rolePresets || {};
    const launchPreset = resolved.routing?.requestedPresetKey ? launchPresets[resolved.routing.requestedPresetKey] : null;
    const effectiveLaunchRole = resolved.role || (launchPreset?.group === "reviewer" ? "review" : launchPreset?.group || role);
    if (effectiveLaunchRole === "curator") ctx.specs.assertCuratorAvailable(repoRoot);
    const launchMemberName =
      params.memberName ||
      deriveCleanMemberName({
        role: effectiveLaunchRole,
        presetKey: launchPreset?.key || "",
        provider: resolved.provider,
        title,
        id: threadId,
      });

    let thread = ctx.db.upsertThread({
      id: threadId,
      parentThreadId: effectiveParentThreadId,
      parentConversationId: params.parentConversationId || params.conversationId || null,
      title,
      role: effectiveLaunchRole,
      presetKey: launchPreset?.key || null,
      provider: resolved.provider,
      model: resolved.model,
      effort: resolved.effort,
      permissionMode: resolved.permissionMode,
      interactionMode: resolved.interactionMode,
      isolation: effectiveIsolation,
      status: initialMessage ? "starting" : "idle",
      workspace: repoRoot,
      cwd: execCwd,
      worktreePath: worktreeInfo?.worktreePath || null,
      worktreeId: worktreeInfo?.worktreeId || null,
      branch: worktreeInfo?.branch || null,
      baseRef: worktreeInfo?.baseRef || null,
      meta: {
        projectRoot: repoRoot,
        memberName: launchMemberName,
        ...(isDisposableThread ? { ephemeral: true } : {}),
        externalSessionVisible: !hideExternalSession,
        ...(launchRootConvId ? { rootConversationId: launchRootConvId } : {}),
        ...(worktreeInfo?.baseSha || worktreeInfo?.headSha ? { baseSha: worktreeInfo.baseSha || worktreeInfo.headSha } : {}),
        ...resolved.routing,
        orchestrationMode,
        ...(orchestrationMode === "relay" ? { executionIntent } : {}),
      },
    });

    const enrichedLaunchThread = enrichThreadForClient(thread, {
      repoRootCache: ctx.repoRootCache,
      fallbackWorkspace: repoRoot,
    });

    ctx.context.emitEvent({
      type: "thread_created",
      threadId,
      workspace: repoRoot,
      ...(launchRootConvId ? { rootConversationId: launchRootConvId } : {}),
      thread: enrichedLaunchThread,
    });

    if (worktreeInfo) {
      ctx.context.emitEvent({
        type: "worktree_updated",
        threadId,
        workspace: repoRoot,
        worktree: worktreeInfo,
      });
    }

    let runId = null;
    if (initialMessage) {
      runId = makeId("run");
      const run = ctx.db.upsertRun({
        id: runId,
        threadId,
        status: "starting",
        role: effectiveLaunchRole,
        provider: resolved.provider,
        model: resolved.model,
        effort: resolved.effort,
        permissionMode: resolved.permissionMode,
        interactionMode: resolved.interactionMode,
        prompt: initialMessage,
        inputIntent: "initial",
        meta: { ...resolved.routing, ...(params.inheritHostMcp === true ? { inheritHostMcp: true } : {}), ...specSelection(params), ...readPathsSelection(params), orchestrationMode, ...(orchestrationMode === "relay" ? { executionIntent } : {}) },
        cwd: execCwd,
      });

      ctx.db.upsertTurnItem({
        id: `item_user_${runId}`,
        threadId,
        runId,
        type: "user_message",
        role: "user",
        text: initialMessage,
        status: "completed",
      });

      const exec = ctx.execution.startEngineExecution({
        thread,
        run,
        reuseNativeSession: false,
        synchronous: String(params.mode || "").toLowerCase() === "wait",
        ephemeral: hideExternalSession,
      });

      if (exec.bypassed) return exec;
      if (exec.started) await exec.started;
      if (String(params.mode || "").toLowerCase() === "wait") {
        await exec.settledPromise;
      }
      thread = ctx.db.getThread(threadId);
    }

    const enrichedRet = enrichThreadForClient(thread, {
      repoRootCache: ctx.repoRootCache,
      fallbackWorkspace: repoRoot,
    });

    return {
      threadId,
      id: threadId,
      runId,
      status: enrichedRet?.status || "idle",
      worktreePath: worktreeInfo?.worktreePath || null,
      branch: worktreeInfo?.branch || null,
      thread: enrichedRet,
      activeMode: ctx.scopePolicy.getActiveModeSummary({ conversationId: launchRootConvId, workspace: repoRoot }),
    };
  }

  return {
    allocateRoleMember,
    claimNativeHandoff,
    dispatchCurator,
    createNativeHostHandoff,
    delegateParallelBatch,
    delegateTask,
    finalReportFields,
    lastAssistantItem,
    findNativeHandoff,
    revokeNativeHandoff: handoffId => nativeHandoffs.delete(handoffId),
    getTaskStatus,
    launchThread,
    readPathsSelection,
  };
}

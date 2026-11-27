import { specSelection } from "../spec-context.mjs";
import { assertReadOnlySupport } from "../catalog.mjs";
import { collectReviewGitSnapshot, getRepoRoot } from "../worktree.mjs";
import {
  normalizeProjectPath,
  isIsolatedWorktreePath,
  makeId,
  enrichThreadForClient,
  resolveEphemeralFlag,
  shouldHideExternalSession,
} from "./helpers.mjs";

export function createReviewModule(ctx) {
  function buildPersistentReviewPrompt({
    scope = "uncommitted",
    targetCwd = "",
    baseBranch = "",
    commitSha = "",
    customPrompt = "",
  } = {}) {
    const s = String(scope || "uncommitted").trim().toLowerCase();
    let scopeGuide = `Inspect all uncommitted changes (staged, unstaged, and untracked files) in "${targetCwd}" using read-only commands such as \`git --no-optional-locks status --short\`, \`git --no-optional-locks diff\`, and \`git --no-optional-locks diff --cached\`, then inspect the modified files carefully.`;
    if (s === "branch") {
      const base = String(baseBranch || "main").trim();
      scopeGuide = `Inspect all changes on the current branch relative to base branch "${base}" in "${targetCwd}" using read-only commands such as \`git --no-optional-locks status --short\`, \`git --no-optional-locks log ${base}..HEAD --oneline\`, and \`git --no-optional-locks diff ${base}...HEAD\`, then read the changed files.`;
    } else if (s === "commit") {
      const sha = String(commitSha || "HEAD").trim();
      scopeGuide = `Inspect commit "${sha}" in "${targetCwd}" using read-only commands such as \`git --no-optional-locks show --stat ${sha}\` and \`git --no-optional-locks show ${sha}\`, then read the surrounding code as needed.`;
    }
    const lines = [
      "Perform this review in READ-ONLY mode. Do NOT modify, write, or delete any repository files.",
      scopeGuide,
      "Prioritize real bugs, broken contracts, race conditions, security/isolation flaws, and missing error handling. Cite exact file paths, line numbers, root causes, and concrete fixes ordered by severity (P0 / P1 / P2).",
      "Stay strictly restrained: report only reproducible logic, state-machine, concurrency, and contract bugs. Do NOT propose over-engineered abstractions, unrequested defensive allowlists, or preemptive interceptors for normal flows.",
      "Keep context concise and structured so follow-up verification rounds can re-check fixes cleanly.",
    ];
    const extra = String(customPrompt || "").trim();
    if (extra) {
      lines.push("", "User Focus / Specific Instructions:", extra);
    }
    return lines.join("\n");
  }

  function buildReviewAndFixPrompt({ scope, targetCwd, baseBranch, commitSha, customPrompt }) {
    const target = scope === "branch" ? `current branch against ${baseBranch || "main"}` :
      scope === "commit" ? `commit ${commitSha || "HEAD"}` : "all staged, unstaged and untracked changes";
    return [`在 ${targetCwd} 按 Defect-First 标准严查 ${target}，包括相关调用方和边界条件。`,
      "若无实质缺陷，直接报告 PASS。若有 Bug、竞态、契约不一致或边界遗漏，必须当场直接修改文件修复。",
      "严守工程克制：只准修复可复现的真实逻辑、状态机、并发竞态与契约缺陷；严禁过度设计和空想推演，严禁擅自给正常链路额外叠加未要求的防御性白名单、前置拦截或多余抽象。",
      "运行语法检查与相关自动化测试，验证修复通过。测试与临时脚本仅用项目内 tmp/（Git 仓库先确认已忽略）并自动清理。",
      "严禁只列评论推回给其他 Agent。向主会话一次性汇报：发现的问题或 PASS、已修改文件及修复说明、实际验证结果。",
      customPrompt && `用户关注点：${customPrompt}`].filter(Boolean).join("\n");
  }

  function buildTurnPrompt(review, targetCwd, customPrompt) {
    const build = review.readOnly ? buildPersistentReviewPrompt : buildReviewAndFixPrompt;
    return `${build({ ...review, targetCwd, customPrompt })}${review.reviewFilesBlock || ""}`;
  }

  async function snapshotReview(review, cwd) {
    const { changedPaths, summaryBlock } = await collectReviewGitSnapshot({ ...review, cwd });
    const reviewFilesBlock = summaryBlock ? `\n\n<agent_tower_review_files>\n${summaryBlock}\n</agent_tower_review_files>` : "";
    return { ...review, changedPaths, reviewFilesBlock };
  }

  function checkReviewAvailability(params, reviewRootConvId, repoRoot, readOnly) {
    const reviewPolicy = ctx.scopePolicy.readConversationPolicy(reviewRootConvId);
    if (reviewPolicy.orchestrationMode === "relay") {
      throw Object.assign(new Error("简单模式不启用外部评审"), { code: "MODE_REVIEW_NOT_ALLOWED" });
    }
    const activeMode = ctx.scopePolicy.getActiveModeSummary({ conversationId: reviewRootConvId, workspace: repoRoot });
    const customTarget = params.provider || params.model || params.effort || params.target || params.modelSelection ||
      params.interactionMode || (!readOnly && params.permissionMode);
    if (reviewPolicy.orchestrationMode === "complex" && activeMode.groups.reviewer.stageEnabled === false) {
      return { bypass: {
        ok: true,
        bypassed: true,
        code: "review_stage_disabled",
        status: "bypassed_by_stage",
        hostSelfReviewRequired: true,
        degradedReview: true,
        activeMode,
        summary: "当前复杂自定义模式已关闭独立审核阶段，请由主会话自行检查 Diff 与验证结果。",
        instruction: "用户已在复杂自定义模式中关闭审核阶段。请勿重试 review_code，直接由主会话核查改动与测试结果，并在汇报中说明由主会话验收。",
      } };
    }
    if (activeMode.groups.reviewer.enabledKeys.length === 0 && !params.allowDisabledPreset && !customTarget) {
      if (params.degradeToHostSelfReview === true) {
        return { bypass: {
          ok: true,
          bypassed: true,
          reason: "review_pool_degraded_to_host",
          status: "degraded_self_review",
          degradedReview: true,
          activeMode,
          summary: "已确认降级：本轮不启动外部评审官，由主会话自行审查改动，终审结论需标注「主会话代审」。",
          instruction: "评审组已全部停用，用户已确认本轮降级由主会话自行审查 Diff 与测试结果。",
        } };
      }
      throw Object.assign(new Error("评审组已全部停用"), { code: "REVIEW_POOL_EMPTY", details: { group: "reviewer" } });
    }
    return { reviewPolicy, activeMode };
  }

  async function runCodeReview(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    params = ctx.scopePolicy.withDispatchConversation(params);
    const bypass = ctx.scopePolicy.dispatchBypass(params);
    if (bypass) return bypass;
    const reviewRootConvId = ctx.scopePolicy.policyRoot(params);
    const rawReviewMode = String(params.reviewMode || "").trim().toLowerCase();
    const readOnly = params.readOnly === true || ["read_only", "read-only"].includes(rawReviewMode) ||
      String(params.permissionMode || "").toLowerCase() === "read-only";
    const reviewMode = readOnly ? "read_only" : "review_and_fix";
    const targetCwd = await ctx.worktrees.resolveWorktreeTargetPath(params);
    const repoRoot = normalizeProjectPath((await getRepoRoot(targetCwd)) || targetCwd);
    const isDisposableThread = rawReviewMode === "ephemeral" || resolveEphemeralFlag(params, [repoRoot, targetCwd]);
    const nativeReview = readOnly && (params.ephemeral === true || rawReviewMode === "ephemeral");
    const beforeSnapshot = ctx.scopePolicy.dispatchBypass(params) ||
      checkReviewAvailability(params, reviewRootConvId, repoRoot, readOnly).bypass;
    if (beforeSnapshot) return beforeSnapshot;
    const scope = params.scope || "uncommitted";
    const reviewSpec = await snapshotReview({ scope, baseBranch: params.baseBranch, commitSha: params.commitSha, customPrompt: params.prompt, readOnly }, targetCwd);
    const { reviewFilesBlock } = reviewSpec;
    const afterSnapshot = ctx.scopePolicy.dispatchBypass(params);
    if (afterSnapshot) return afterSnapshot;
    const { bypass: reviewBypass, reviewPolicy, activeMode } = checkReviewAvailability(params, reviewRootConvId, repoRoot, readOnly);
    if (reviewBypass) return reviewBypass;
    const targetPresetKey = params.presetKey;
    const resolved = await ctx.catalogSettings.resolveEffectiveTarget({
      role: "review",
      workspace: repoRoot,
      presetKey: targetPresetKey,
      provider: params.provider,
      model: params.model,
      effort: params.effort,
      permissionMode: readOnly ? undefined : params.permissionMode,
      target: params.target,
      modelSelection: params.modelSelection,
      interactionMode: params.interactionMode,
      isolation: params.isolation,
      workspaceStrategy: params.workspaceStrategy,
      orchestrationMode: reviewPolicy.orchestrationMode,
      allowDisabledPreset: params.allowDisabledPreset === true,
    });
    const rechecked = ctx.scopePolicy.dispatchBypass(params);
    if (rechecked) return rechecked;
    const nativeHandoff = ctx.dispatch.createNativeHostHandoff({ params, resolved, rootConversationId: reviewRootConvId,
      role: "review", brief: String(params.prompt || `审查当前改动 (${scope})`), cwd: targetCwd, repoRoot, activeMode });
    if (nativeHandoff) {
      const ticket = ctx.dispatch.findNativeHandoff({ handoffId: nativeHandoff.handoffId, includeClaimed: true });
      if (ticket) {
        ticket.reviewSpec = reviewSpec;
        if (reviewFilesBlock) ticket.reviewFilesBlock = reviewFilesBlock;
      }
      return reviewFilesBlock ? { ...nativeHandoff, reviewFilesBlock } : nativeHandoff;
    }
    const { provider, model, effort } = resolved;
    if (readOnly) assertReadOnlySupport(provider, "read-only");
    const permissionMode = readOnly ? "read-only" : resolved.permissionMode;
    const taskId = params.taskId || makeId("task");
    const runId = makeId("run");
    const startedAt = Date.now();
    const title = params.title || `${readOnly ? "只读诊断" : "审改一体终审"} (${scope}) · ${model}`;

    const parentTid = params.parentThreadId || params.threadId || null;

    const targetedWorktree = params.worktreeId || params.worktreePath || isIsolatedWorktreePath(targetCwd);
    const memberPresetKey = resolved.routing?.requestedPresetKey || activeMode.groups.reviewer.preferredKey || "";
    const continueSession = params.freshContext !== true && (params.continueSession === true || params.freshContext === false);
    const { existing, memberName } = ctx.dispatch.allocateRoleMember({ rootConversationId: reviewRootConvId, repoRoot,
      role: "review", presetKey: memberPresetKey, memberName: memberPresetKey || "reviewer", provider, continueSession },
      !isDisposableThread && !targetedWorktree && params.createNewThread !== true && params.forceNewThread !== true);
    const threadId = existing?.id || makeId("thr");
    const switched = existing && existing.provider !== provider;
    const interactionMode = nativeReview ? "plan" : readOnly ? "default" : resolved.interactionMode;
    const prompt = buildTurnPrompt(reviewSpec, targetCwd, params.prompt);
    const hideExternalSession = isDisposableThread || nativeReview || shouldHideExternalSession(ctx.db, continueSession ? existing : null, repoRoot, params.persistSession);
    const reuseNativeSession = continueSession && !hideExternalSession && !switched && Boolean(existing?.nativeSessionId);
    const effectivePrompt = existing && continueSession && !reuseNativeSession
      ? ctx.turns.buildLocalContinuationPrompt(existing, existing.provider, provider, prompt)
      : prompt;
    const userDisplayPrompt = params.prompt || `Run defect-first review (${scope}) on ${targetCwd}`;

    const thread = ctx.db.upsertThread({
      id: threadId,
      parentThreadId: existing ? existing.parentThreadId : parentTid,
      parentConversationId: params.parentConversationId || params.conversationId || null,
      taskId,
      title,
      role: "review",
      presetKey: readOnly ? "" : memberPresetKey || "",
      provider,
      model,
      effort,
      permissionMode,
      interactionMode,
      isolation: targetedWorktree ? "worktree" : "shared",
      // Reviewing a worktree does not grant ownership of its cleanup/integration.
      nativeSessionId: !continueSession || switched || hideExternalSession ? null : undefined,
      startedAt, completedAt: null, durationMs: 0, summary: "",
      status: nativeReview ? "running" : "starting",
      activeRunId: nativeReview ? runId : null,
      workspace: repoRoot,
      cwd: targetCwd,
      meta: {
        projectRoot: repoRoot,
        memberName,
        reviewMode,
        ephemeral: isDisposableThread,
        externalSessionVisible: !hideExternalSession,
        ...(params.worktreeId ? { targetWorktreeId: params.worktreeId } : {}),
        ...(reviewRootConvId ? { rootConversationId: reviewRootConvId } : {}),
        orchestrationMode: reviewPolicy.orchestrationMode,
        ...(resolved.routing?.temporaryOverride ? { temporaryOverride: true } : {}),
      },
    });

    const run = ctx.db.upsertRun({
      id: runId,
      threadId,
      status: nativeReview ? "running" : "starting",
      role: "review",
      provider,
      model,
      effort,
      permissionMode,
      interactionMode,
      prompt: userDisplayPrompt,
      inputIntent: "review",
      meta: { taskId, title, ...resolved.routing, ...(params.inheritHostMcp === true ? { inheritHostMcp: true } : {}), ...specSelection(params), reviewSpec, orchestrationMode: reviewPolicy.orchestrationMode, ...(resolved.routing?.temporaryOverride ? { temporaryOverride: true } : {}) },
      cwd: targetCwd,
      ...(nativeReview ? { startedAt } : {}),
    });

    ctx.db.upsertTurnItem({
      id: `item_user_${runId}`,
      threadId,
      runId,
      type: "user_message",
      role: "user",
      text: userDisplayPrompt,
      status: "completed",
    });

    const enrichedReviewThread = enrichThreadForClient(thread, {
      repoRootCache: ctx.repoRootCache,
      fallbackWorkspace: repoRoot,
    });
    ctx.context.emitEvent({
      type: existing ? "thread_updated" : "thread_created",
      threadId,
      workspace: repoRoot,
      ...(reviewRootConvId ? { rootConversationId: reviewRootConvId } : {}),
      thread: enrichedReviewThread,
    });

    // Studio UI modal/button sends `workspace: targetCwd` and wants instant `{ taskId, threadId }` to switch tabs & watch live;
    // MCP `review_code` defaults to `mode: 'async'` to avoid 3-minute MCP RPC timeouts; pass `mode: 'wait'` or `wait: true` to block (with optional `timeoutMs`).
    const mode = String(params.mode || "").trim().toLowerCase();
    const shouldWait =
      params.wait !== undefined
        ? Boolean(params.wait)
        : mode ? ["wait", "sync"].includes(mode) : !params.workspace;
    const waitTimeoutMs = shouldWait && Number(params.timeoutMs) > 0
      ? Math.max(500, Number(params.timeoutMs))
      : 0;
    const nextHint = `Call task_status({ taskId: "${taskId}", wait: true, timeoutMs: 120000 }) or monitor live in AgentTower.`;
    const makeAsyncReply = (status = "running", extra = {}) => ({
      taskId,
      childThreadId: threadId,
      threadId,
      runId,
      status,
      workState: "working",
      provider,
      model,
      effort,
      cwd: targetCwd,
      reviewMode,
      ephemeral: isDisposableThread,
      next: nextHint,
      activeMode,
      ...extra,
    });
    async function awaitSettled(settledPromise) {
      if (!waitTimeoutMs) return { timedOut: false, result: await settledPromise };
      let timedOut = false;
      let timer = null;
      const race = Promise.race([
        settledPromise,
        new Promise((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            resolve(null);
          }, waitTimeoutMs);
          timer.unref?.();
        }),
      ]).finally(() => {
        if (timer) clearTimeout(timer);
      });
      const result = await ctx.context.withSynchronousWait(runId, () => race);
      if (timedOut) settledPromise.catch(() => {});
      return { timedOut, result };
    }

    if (!nativeReview) {
      const exec = ctx.execution.startEngineExecution({
        thread,
        run,
        effectivePrompt,
        reuseNativeSession,
        ephemeral: hideExternalSession,
        synchronous: shouldWait && !waitTimeoutMs,
      });

      if (exec.bypassed) return exec;
      if (exec.started) await exec.started;
      if (!shouldWait) {
        return makeAsyncReply("running");
      }

      const { timedOut, result: finishedRun } = await awaitSettled(exec.settledPromise);
      if (timedOut) {
        const curThread = ctx.db.getThread(threadId, { includeQueue: false });
        return makeAsyncReply(curThread?.status || "running", { waitTimedOut: true });
      }
      const curThread = ctx.db.getThread(threadId, { includeQueue: false });
      const reviewText = finishedRun?.assistantText || ctx.dispatch.lastAssistantItem(threadId, runId)?.text || "";

      return {
        taskId,
        childThreadId: threadId,
        threadId,
        runId,
        status: finishedRun?.status || curThread?.status || "completed",
        workState: "result_available",
        provider,
        model,
        effort,
        cwd: targetCwd,
        reviewMode,
        ephemeral: isDisposableThread,
        nativeSessionId: curThread?.nativeSessionId || finishedRun?.nativeSessionId || null,
        reviewText,
        findings: [],
        ...(params.includeReport === false ? {} : ctx.dispatch.finalReportFields({ threadId, runId, run: finishedRun })),
        usage: finishedRun?.usage || {},
        error: finishedRun?.error || null,
        activeMode,
      };
    }

    let reviewResult;
    const exec = ctx.execution.startEngineExecution({
      thread, run, effectivePrompt, ephemeral: true, nativeReview: true, synchronous: shouldWait && !waitTimeoutMs,
      launchDriver({ onEvent, prompt }) {
        reviewResult = undefined;
        const handle = ctx.engineManager.runReview({
          cwd: targetCwd, scope, baseBranch: params.baseBranch, commitSha: params.commitSha,
          model, effort, ephemeral: true, prompt, onEvent,
        });
        return { ...handle, result: handle.result.then(result => {
          reviewResult = result;
          return { ...result, assistantText: result.reviewText };
        }) };
      },
    });
    if (exec.bypassed) return exec;
    if (exec.started) await exec.started;

    if (!shouldWait) {
      return makeAsyncReply("running", { ephemeral: true });
    }

    const { timedOut, result: reviewRes } = await awaitSettled(exec.settledPromise);
    if (timedOut) {
      const curThread = ctx.db.getThread(threadId, { includeQueue: false });
      return makeAsyncReply(curThread?.status || "running", { ephemeral: true, waitTimedOut: true });
    }
    const nativeReviewText = reviewResult?.reviewText || "";
    return {
      taskId,
      childThreadId: threadId,
      threadId,
      runId,
      status: reviewRes.status,
      workState: "result_available",
      provider,
      model,
      effort,
      cwd: targetCwd,
      reviewMode,
      ephemeral: true,
      reviewText: nativeReviewText,
      findings: reviewResult?.findings || [],
      ...(params.includeReport === false ? {} : ctx.dispatch.finalReportFields({ threadId, runId, run: reviewRes })),
      usage: reviewRes.usage || {},
      error: reviewRes.error || null,
      activeMode,
    };
  }

  return {
    buildTurnPrompt,
    snapshotReview,
    runCodeReview,
  };
}

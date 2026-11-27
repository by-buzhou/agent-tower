import { resolveSessionPrompt } from "../spec-context.mjs";
import { PLUGIN_VERSION } from "../daemon-client.mjs";
import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import * as crypto from "node:crypto";
import * as readline from "node:readline";
import { isInheritedEffort, isInheritedModel, normalizeEffortForTarget, normalizePermissionModeForProvider } from "../catalog.mjs";
import {
  spawnNoWindow,
  buildCleanChildEnv,
  classifyErrorCategory,
  createNdjsonRpcConnection,
  forceKillProcessTree,
  gracefulCancelWithEscalation,
  resolveCodexBinary,
  safeCatalogText,
  safeEngineError,
  isMissingSessionError,
} from "./proc-utils.mjs";

/**
 * Map a requested permission to Codex's native sandbox + approval policy:
 * read-only (or plan interaction) -> read-only/never; on-request -> workspace-write/on-request (panel approvals);
 * auto -> workspace-write/on-request reviewed by Codex's auto reviewer; full-access -> danger-full-access/never.
 */
export function resolveCodexSandboxAndApproval(permissionMode, interactionMode) {
  const inter = String(interactionMode || "").trim().toLowerCase();
  const perm = normalizePermissionModeForProvider("codex", permissionMode, { fallback: "on-request" });

  if (inter === "plan" || perm === "read-only") {
    return { sandbox: "read-only", approvalPolicy: "never" };
  }
  if (perm === "full-access") {
    return { sandbox: "danger-full-access", approvalPolicy: "never" };
  }
  if (perm === "auto") {
    return { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" };
  }
  return { sandbox: "workspace-write", approvalPolicy: "on-request" };
}

function mapDecisionToCodexApproval(decision) {
  if (!decision) return "decline";
  if (typeof decision === "object") {
    if (decision.cancelled) return "cancel";
    decision = decision.decision || decision.optionId || decision.action || "";
  }
  const d = String(decision).trim().toLowerCase();
  if (d === "cancel" || d === "cancelled") return "cancel";
  if (d === "reject" || d === "rejected" || d === "decline" || d === "deny") return "decline";
  if (d === "approve_always" || d === "allow_always" || d === "acceptforsession" || d === "session") {
    return "acceptForSession";
  }
  return ["accept", "approve_once", "allow_once", "allow", "approve"].includes(d) ? "accept" : "decline";
}

function mapCodexThreadItemToToolEvent(item, overrideStatus, extra = {}) {
  if (!item || typeof item !== "object") return null;

  if (item.type === "commandExecution") {
    const rawStatus = overrideStatus || item.status || "inProgress";
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "failed" || rawStatus === "declined"
          ? "failed"
          : "in_progress";
    return {
      type: "tool_call",
      toolCallId: item.id,
      id: item.id,
      toolName: "command_execution",
      name: "command_execution",
      kind: "execute",
      title: item.command || "Shell Command",
      status,
      input: { command: item.command, cwd: item.cwd },
      rawInput: { command: item.command, cwd: item.cwd },
      output: item.aggregatedOutput ?? extra.accumulatedOutput ?? "",
      rawOutput: item.aggregatedOutput ?? extra.accumulatedOutput ?? "",
      exitCode: item.exitCode ?? null,
      durationMs: item.durationMs ?? null,
      ...extra,
    };
  }

  if (item.type === "fileChange") {
    const rawStatus = overrideStatus || item.status || "inProgress";
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "failed" || rawStatus === "declined"
          ? "failed"
          : "in_progress";
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const locations = changes.filter((c) => c?.path).map((c) => ({ path: c.path }));
    const combinedDiff = changes.map((c) => c?.diff || "").filter(Boolean).join("\n");
    return {
      type: "tool_call",
      toolCallId: item.id,
      id: item.id,
      toolName: "file_change",
      name: "file_change",
      kind: "edit",
      title: changes.length === 1 ? `Edit ${changes[0].path}` : `Edit ${changes.length} file(s)`,
      status,
      input: { changes: changes.map((c) => ({ path: c.path, kind: c.kind })) },
      output: combinedDiff,
      changes,
      locations,
      diff: combinedDiff,
      ...extra,
    };
  }

  if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
    const rawStatus = overrideStatus || item.status || "inProgress";
    const status =
      rawStatus === "completed"
        ? "completed"
        : rawStatus === "failed" || item.error
          ? "failed"
          : "in_progress";
    const toolLabel = item.server ? `${item.server}.${item.tool}` : item.tool || "tool";
    const outObj = item.result ?? item.contentItems ?? item.error ?? "";
    const outStr = typeof outObj === "string" ? outObj : JSON.stringify(outObj);
    return {
      type: "tool_call",
      toolCallId: item.id,
      id: item.id,
      toolName: toolLabel,
      name: toolLabel,
      kind: "other",
      title: toolLabel,
      status,
      input: item.arguments,
      rawInput: item.arguments,
      output: outStr,
      durationMs: item.durationMs ?? null,
      ...extra,
    };
  }

  if (item.type === "webSearch") {
    return {
      type: "tool_call",
      toolCallId: item.id,
      id: item.id,
      toolName: "web_search",
      name: "web_search",
      kind: "fetch",
      title: item.query ? `Search: ${item.query}` : "Web Search",
      status: overrideStatus || "completed",
      input: { query: item.query },
      output: "",
      ...extra,
    };
  }

  return null;
}

/**
 * Execute one Codex turn via `codex app-server --listen stdio://` with full streaming deltas,
 * session resume (`thread/resume`), live `turn/steer`, and surgical `turn/interrupt`.
 */
export function runCodexTurn({
  runId,
  threadId,
  model,
  effort,
  permissionMode = "on-request",
  interactionMode = "default",
  cwd,
  nativeSessionId,
  resolveBinary = resolveCodexBinary,
  prompt,
  freshSessionPrompt,
  ephemeral = false,
  onEvent,
  onPermissionRequest,
  onQuestionRequest,
}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const bin = resolveBinary();
  const proc = spawnNoWindow(
    bin.command,
    [...bin.prefixArgs, "app-server", "--listen", "stdio://"],
    {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],

      env: buildCleanChildEnv(bin.env),
    }
  );

  let settled = false;
  let cancelRequested = false;
  let activeThreadId = nativeSessionId || "";
  let activeTurnId = "";
  let assistantText = "";
  let reasoningText = "";
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    contextUsed: 0,
    contextLimit: 475000,
  };

  const streamedMessageItemIds = new Set();
  const streamedReasoningItemIds = new Set();
  const commandOutputs = new Map();
  const pendingPermissions = new Map();
  const pendingQuestions = new Map();

  let resolveTurnCompleted;
  let rejectTurnCompleted;
  const turnCompletedPromise = new Promise((res, rej) => {
    resolveTurnCompleted = res;
    rejectTurnCompleted = rej;
  });
  // Prevent unhandled rejection before `await turnCompletedPromise`
  turnCompletedPromise.catch(() => {});

  const emit = (evt) => {
    try {
      onEvent?.({
        runId,
        threadId,
        provider: "codex",
        timestamp: Date.now(),
        ...evt,
      });
    } catch {}
  };

  const { sandbox, approvalPolicy, approvalsReviewer } = resolveCodexSandboxAndApproval(permissionMode, interactionMode);
  const autoApprove = sandbox === "danger-full-access";
  const reviewerOverride = approvalsReviewer ? { approvalsReviewer } : {};

  const rpc = createNdjsonRpcConnection(proc, {
    onNotification(method, params) {
      // Strictly ignore account/* notifications to guarantee zero PII/email handling
      if (!method || method.startsWith("account/")) return;

      switch (method) {
        case "thread/name/updated": {
          if (params?.name) {
            emit({ type: "title_updated", title: params.name });
          }
          break;
        }
        case "turn/started": {
          if (params?.turn?.id) {
            activeTurnId = params.turn.id;
          }
          break;
        }
        case "item/reasoning/summaryTextDelta":
        case "item/reasoning/textDelta": {
          const delta = params?.delta ?? "";
          if (delta) {
            if (params?.itemId) streamedReasoningItemIds.add(params.itemId);
            reasoningText += delta;
            emit({ type: "reasoning_delta", delta, text: delta, itemId: params?.itemId });
          }
          break;
        }
        case "item/agentMessage/delta": {
          const delta = params?.delta ?? "";
          if (delta) {
            if (params?.itemId) streamedMessageItemIds.add(params.itemId);
            assistantText += delta;
            emit({
              type: "message_delta",
              delta,
              text: delta,
              itemId: params?.itemId,
            });
          }
          break;
        }
        case "item/commandExecution/outputDelta": {
          const itemId = params?.itemId;
          const delta = params?.delta ?? "";
          if (itemId && delta) {
            const prevOut = commandOutputs.get(itemId) || "";
            const nextOut = prevOut + delta;
            commandOutputs.set(itemId, nextOut);
            emit({
              type: "tool_call",
              toolCallId: itemId,
              id: itemId,
              toolName: "command_execution",
              name: "command_execution",
              kind: "execute",
              status: "in_progress",
              outputDelta: delta,
              output: nextOut,
            });
          }
          break;
        }
        case "item/fileChange/patchUpdated": {
          const itemId = params?.itemId;
          const changes = Array.isArray(params?.changes) ? params.changes : [];
          if (itemId) {
            const diffStr = changes.map((c) => c?.diff || "").filter(Boolean).join("\n");
            emit({
              type: "tool_call",
              toolCallId: itemId,
              id: itemId,
              toolName: "file_change",
              name: "file_change",
              kind: "edit",
              status: "in_progress",
              changes,
              diff: diffStr,
              output: diffStr,
            });
          }
          break;
        }
        case "turn/plan/updated": {
          const planSteps = Array.isArray(params?.plan) ? params.plan : [];
          emit({
            type: "todo_list",
            entries: planSteps.map((s) => ({
              content: s.step || s.content || "",
              status: s.status || "pending",
            })),
            items: planSteps,
          });
          break;
        }
        case "item/started": {
          const item = params?.item;
          const toolEvt = mapCodexThreadItemToToolEvent(item, "in_progress");
          if (toolEvt) emit(toolEvt);
          break;
        }
        case "item/completed": {
          const item = params?.item;
          if (!item) break;

          if (item.type === "reasoning" && !streamedReasoningItemIds.has(item.id)) {
            const summaryStr = Array.isArray(item.summary) ? item.summary.join("\n") : "";
            const contentStr = Array.isArray(item.content) ? item.content.join("\n") : "";
            const combined = contentStr || summaryStr;
            if (combined) {
              reasoningText += (reasoningText ? "\n" : "") + combined;
              emit({ type: "reasoning_delta", delta: combined, text: combined, itemId: item.id });
            }
          } else if (item.type === "agentMessage") {
            if (!streamedMessageItemIds.has(item.id) && item.text) {
              assistantText += (assistantText ? "\n" : "") + item.text;
              emit({
                type: "message_delta",
                delta: item.text,
                text: item.text,
                phase: item.phase || "final_answer",
                itemId: item.id,
              });
            } else if (item.phase === "commentary") {
              // Ensure newline separator between commentary and final_answer chunks
              assistantText += "\n";
            }
          } else {
            const accOut = commandOutputs.get(item.id);
            const toolEvt = mapCodexThreadItemToToolEvent(item, undefined, accOut ? { accumulatedOutput: accOut } : {});
            if (toolEvt) emit(toolEvt);
            commandOutputs.delete(item.id);
          }
          break;
        }
        case "thread/tokenUsage/updated": {
          const tu = params?.tokenUsage;
          if (tu) {
            const tot = tu.total || {};
            const last = tu.last || {};
            const windowSize = Number(tu.modelContextWindow) || 475000;
            usage = {
              inputTokens: Number(tot.inputTokens) || 0,
              outputTokens: Number(tot.outputTokens) || 0,
              cachedInputTokens: Number(tot.cachedInputTokens) || 0,
              reasoningOutputTokens: Number(tot.reasoningOutputTokens) || 0,
              totalTokens: Number(tot.totalTokens) || 0,
              contextUsed: Number(last.totalTokens) || Number(tot.totalTokens) || 0,
              contextLimit: windowSize,
            };
            emit({
              type: "usage_updated",
              usage: { ...usage },
              contextUsed: usage.contextUsed,
              contextLimit: windowSize,
            });
          }
          break;
        }
        case "error": {
          const errMsg = safeEngineError(params?.error?.message || params?.message, "Codex turn error");
          if (!params?.willRetry) {
            emit({
              type: "error",
              message: errMsg,
              error: errMsg,
              category: classifyErrorCategory(errMsg),
            });
          }
          break;
        }
        case "turn/completed": {
          resolveTurnCompleted(params?.turn || { status: "completed" });
          break;
        }
        default:
          break;
      }
    },
    async onServerRequest(method, params, rpcId) {
      if (
        method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval" ||
        method === "execCommandApproval" ||
        method === "applyPatchApproval"
      ) {
        if (autoApprove) return { decision: "accept" };
        if (approvalPolicy === "never" || !onPermissionRequest) return { decision: "decline" };
        const reqId = `perm_${runId || "codex"}_${rpcId}_${crypto.randomUUID().slice(0, 8)}`;
        const isFile = method.toLowerCase().includes("file") || method.toLowerCase().includes("patch");
        return new Promise((resolve) => {
          pendingPermissions.set(reqId, (decision) => {
            pendingPermissions.delete(reqId);
            resolve({ decision: mapDecisionToCodexApproval(decision) });
          });

          Promise.resolve(
            onPermissionRequest({
              requestId: reqId,
              runId,
              threadId,
              provider: "codex",
              kind: isFile ? "file-change" : "command",
              title: params?.command || params?.reason || (isFile ? "Approve File Change" : "Approve Command"),
              toolCallId: params?.itemId || params?.callId,
              command: params?.command,
              cwd: params?.cwd,
              options: [
                { optionId: "approve_once", name: "批准本次", kind: "allow_once" },
                { optionId: "approve_always", name: "本会话放行", kind: "allow_always" },
                { optionId: "reject", name: "拒绝", kind: "reject_once" },
              ],
              preview: params,
            })
          )
            .then((direct) => {
              if (direct !== undefined && pendingPermissions.has(reqId)) {
                pendingPermissions.get(reqId)(direct);
              }
            })
            .catch(() => {
              if (pendingPermissions.has(reqId)) {
                pendingPermissions.get(reqId)("reject");
              }
            });
        });
      }

      if (method === "item/tool/requestUserInput") {
        if (!onQuestionRequest) {
          return { answers: {} };
        }
        const reqId = `ques_${runId || "codex"}_${rpcId}_${crypto.randomUUID().slice(0, 8)}`;
        return new Promise((resolve) => {
          pendingQuestions.set(reqId, (answers) => {
            pendingQuestions.delete(reqId);
            if (!answers || answers.cancelled) {
              resolve({ answers: {} });
            } else {
              resolve({ answers: answers.answers || answers });
            }
          });

          Promise.resolve(
            onQuestionRequest({
              requestId: reqId,
              runId,
              threadId,
              provider: "codex",
              questions: params?.questions || [],
              toolCallId: params?.itemId,
            })
          )
            .then((direct) => {
              if (direct !== undefined && pendingQuestions.has(reqId)) {
                pendingQuestions.get(reqId)(direct);
              }
            })
            .catch(() => {
              if (pendingQuestions.has(reqId)) {
                pendingQuestions.get(reqId)({});
              }
            });
        });
      }

      return undefined;
    },
  });

  proc.stdout.once("end", () => rejectTurnCompleted(new Error("Codex app-server stdout closed before turn completed")));
  proc.once("exit", (code, signal) => {
    rejectTurnCompleted(
      new Error(`Codex app-server exited before turn completed (code=${code ?? "null"}, signal=${signal ?? "null"})`)
    );
  });

  const cleanupProcess = async () => {
    rpc.closeStdin();
    if (proc.exitCode === null) {
      await Promise.race([
        new Promise((r) => proc.once("exit", r)),
        new Promise((r) => setTimeout(r, 350)),
      ]);
      if (proc.exitCode === null) {
        await forceKillProcessTree(proc);
      }
    }
    rpc.dispose();
  };

  const result = (async () => {
    try {
      await rpc.request(
        "initialize",
        {
          clientInfo: { name: "agent-tower", version: PLUGIN_VERSION },
          capabilities: { experimentalApi: true },
        },
        20000
      );
      rpc.notify("initialized", {});

      const modelOverride = model && !isInheritedModel(model) ? { model } : {};
      const effortOverride = effort && !isInheritedEffort(effort)
        ? { effort: normalizeEffortForTarget("codex", model, effort) } : {};
      let effectiveModel;

      let resumed = false;
      if (nativeSessionId) {
        try {
          const resumeRes = await rpc.request(
            "thread/resume",
            {
              threadId: nativeSessionId,
              ...modelOverride,
              cwd,
              sandbox,
              approvalPolicy,
              ...reviewerOverride,
              excludeTurns: true,
            },
            15000
          );
          activeThreadId = resumeRes?.thread?.id || nativeSessionId;
          effectiveModel = safeCatalogText(resumeRes?.thread?.model);
          resumed = true;
        } catch (err) {
          if (!isMissingSessionError(err)) throw err;
        }
      }

      if (!resumed) {
        const startRes = await rpc.request(
          "thread/start",
          {
            ...modelOverride,
            cwd,
            sandbox,
            approvalPolicy,
            ...reviewerOverride,
            ephemeral: Boolean(ephemeral),
          },
          15000
        );
        activeThreadId = startRes?.thread?.id;
        effectiveModel = safeCatalogText(startRes?.thread?.model);
      }

      emit({
        type: "session_bound",
        nativeSessionId: activeThreadId,
        sessionId: activeThreadId,
        resumed: resumed && activeThreadId === nativeSessionId,
        ...(effectiveModel ? { effectiveModel } : {}),
      });

      if (cancelRequested) {
        settled = true;
        await cleanupProcess();
        return {
          status: "interrupted",
          stopReason: "cancelled",
          nativeSessionId: activeThreadId,
          assistantText: assistantText.trim(),
          reasoningText,
          usage,
        };
      }

      const turnPrompt = resolveSessionPrompt(prompt, freshSessionPrompt, resumed && activeThreadId === nativeSessionId);
      const effectivePrompt =
        String(interactionMode || "").toLowerCase() === "plan"
          ? `[PLAN MODE: Analyze thoroughly in read-only mode and present a structured implementation plan without modifying files.]\n\n${turnPrompt}`
          : turnPrompt;

      const turnStartRes = await rpc.request("turn/start", {
        threadId: activeThreadId,
        ...modelOverride,
        ...effortOverride,
        summary: "detailed",
        input: [{ type: "text", text: effectivePrompt }],
      });

      if (turnStartRes?.turn?.id) {
        activeTurnId = turnStartRes.turn.id;
      }

      const finalTurn = await turnCompletedPromise;
      settled = true;
      await cleanupProcess();

      // Fallback: if finalTurn carries summary items and assistantText was empty
      if (!assistantText.trim() && Array.isArray(finalTurn?.items)) {
        const fallbackMsgs = finalTurn.items
          .filter((it) => it?.type === "agentMessage" && it.text)
          .map((it) => it.text);
        if (fallbackMsgs.length > 0) {
          assistantText = fallbackMsgs.join("\n");
        }
      }

      const turnStatus = String(finalTurn?.status || "completed");
      if (cancelRequested || turnStatus === "interrupted") {
        return {
          status: "interrupted",
          stopReason: "cancelled",
          nativeSessionId: activeThreadId,
          assistantText: assistantText.trim(),
          reasoningText,
          usage,
        };
      }

      if (turnStatus === "failed" || finalTurn?.error) {
        const errMsg = safeEngineError(finalTurn?.error, "Codex turn failed");
        return {
          status: "failed",
          stopReason: "error",
          nativeSessionId: activeThreadId,
          assistantText: assistantText.trim(),
          reasoningText,
          usage,
          error: errMsg,
        };
      }

      return {
        status: "completed",
        stopReason: "end_turn",
        nativeSessionId: activeThreadId,
        assistantText: assistantText.trim(),
        reasoningText,
        usage,
      };
    } catch (err) {
      settled = true;
      await cleanupProcess();

      if (cancelRequested) {
        return {
          status: "interrupted",
          stopReason: "cancelled",
          nativeSessionId: activeThreadId || undefined,
          assistantText: assistantText.trim(),
          reasoningText,
          usage,
        };
      }

      const activeWriter = /already has an active writer/i.test(String(err?.message || ""));
      const errMsg = activeWriter
        ? "该 Codex 会话仍被另一个进程占用。请等待原回合结束或在原客户端停止后重试；未开启新会话。"
        : safeEngineError(err);
      emit({
        type: "error",
        message: errMsg,
        error: errMsg,
        category: classifyErrorCategory(errMsg, err?.rpcCode),
      });

      return {
        status: "failed",
        stopReason: "error",
        nativeSessionId: activeThreadId || nativeSessionId || undefined,
        assistantText: assistantText.trim(),
        reasoningText,
        usage,
        error: errMsg,
        ...(activeWriter ? { code: "CODEX_ACTIVE_WRITER" } : {}),
      };
    }
  })();

  return {
    async cancel() {
      cancelRequested = true;
      await gracefulCancelWithEscalation(
        proc,
        async () => {
          if (activeThreadId && activeTurnId) {
            await rpc.request(
              "turn/interrupt",
              { threadId: activeThreadId, turnId: activeTurnId },
              1800
            );
          }
        },
        () => settled,
        2000
      );
    },
    async forceKill() {
      cancelRequested = true;
      for (const [, res] of pendingPermissions) res("cancel");
      pendingPermissions.clear();
      for (const [, res] of pendingQuestions) res({ cancelled: true });
      pendingQuestions.clear();
      await forceKillProcessTree(proc);
    },
    async steer(text) {
      if (settled || !activeThreadId || !activeTurnId) {
        return { supported: false };
      }
      try {
        await rpc.request(
          "turn/steer",
          {
            threadId: activeThreadId,
            expectedTurnId: activeTurnId,
            input: [{ type: "text", text: String(text ?? "") }],
          },
          5000
        );
        return { supported: true };
      } catch {
        return { supported: false };
      }
    },
    async respondPermission(reqId, decision) {
      const resolver = pendingPermissions.get(reqId);
      if (resolver) resolver(decision);
    },
    async respondQuestion(reqId, answers) {
      const resolver = pendingQuestions.get(reqId);
      if (resolver) resolver(answers);
    },
    result,
  };
}

function parseReviewFindings(reviewText) {
  if (!reviewText) return [];
  const findings = [];
  const regex = /^-\s*\[(P[0-3])\]\s*(.+?)(?:\s+[—-]\s+([^\n]+))?$/gm;
  let match;
  while ((match = regex.exec(reviewText)) !== null) {
    findings.push({
      priority: match[1],
      title: match[2].trim(),
      location: match[3]?.trim() || null,
    });
  }
  return findings;
}

/**
 * Run non-interactive defect-first code review via `codex exec review --json`
 * (Default model: `gpt-6-astra`).
 */
export function runCodexReview({
  cwd,
  scope = "uncommitted",
  baseBranch,
  commitSha,
  model,
  effort,
  prompt,
  ephemeral = true,
  onEvent,
  resolveBinary = resolveCodexBinary,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const bin = resolveBinary();
  const args = [
    ...bin.prefixArgs,
    "exec", "--sandbox", "read-only",
    "review",
    "--json",
    ...(ephemeral ? ["--ephemeral"] : []),
    ...(model && !isInheritedModel(model) ? ["-m", model] : []),
    ...(effort && !isInheritedEffort(effort)
      ? ["-c", `model_reasoning_effort=${JSON.stringify(normalizeEffortForTarget("codex", model, effort))}`] : []),
  ];

  // Note: clap makes --uncommitted, --base, --commit, and positional [PROMPT] mutually exclusive.
  // When both a target flag and custom prompt are supplied, pass custom instructions via -c developer_instructions.
  const normScope = String(scope || "uncommitted").trim().toLowerCase();
  let usedTargetFlag = false;

  if (commitSha || normScope === "commit") {
    args.push("--commit", commitSha || "HEAD");
    usedTargetFlag = true;
  } else if (baseBranch || normScope === "base" || normScope === "branch") {
    args.push("--base", baseBranch || "main");
    usedTargetFlag = true;
  } else if (normScope === "custom" && prompt) {
    args.push(String(prompt));
  } else {
    args.push("--uncommitted");
    usedTargetFlag = true;
  }

  if (usedTargetFlag && prompt && String(prompt).trim()) {
    args.push("-c", `developer_instructions=${JSON.stringify(String(prompt).trim())}`);
  }

  // Must ignore stdin so `codex exec` never blocks waiting for piped stdin EOF!
  const proc = spawnNoWindow(bin.command, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],

    env: buildCleanChildEnv(bin.env),
  });

  let settled = false;
  let cancelRequested = false;
  let reviewText = "";
  let streamErrorMsg = "";
  let stderrTail = "";
  const exit = new Promise((resolve, reject) => {
    proc.once("error", reject);
    proc.once("exit", (code) => resolve(code ?? 1));
  });
  exit.catch(() => {});
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };

  const emit = (evt) => {
    try {
      onEvent?.({
        provider: "codex",
        timestamp: Date.now(),
        ...evt,
      });
    } catch {}
  };

  proc.stderr?.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk.toString("utf-8")).slice(-2000);
  });

  const result = (async () => {
    try {
      const rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let evt;
        try {
          evt = JSON.parse(trimmed);
        } catch {
          continue;
        }

        if (evt.type === "thread.started" && evt.thread_id) {
          emit({ type: "session_bound", nativeSessionId: evt.thread_id, sessionId: evt.thread_id, resumed: false });
        } else if (evt.type === "item.started" && evt.item?.type === "command_execution") {
          emit({
            type: "tool_call",
            toolCallId: evt.item.id,
            id: evt.item.id,
            toolName: "command_execution",
            name: "command_execution",
            kind: "execute",
            title: evt.item.command || "Review Check",
            status: "in_progress",
            input: { command: evt.item.command },
          });
        } else if (evt.type === "item.completed" && evt.item) {
          const it = evt.item;
          if (it.type === "reasoning" && it.text) {
            emit({ type: "reasoning_delta", delta: it.text, text: it.text });
          } else if (it.type === "command_execution") {
            emit({
              type: "tool_call",
              toolCallId: it.id,
              id: it.id,
              toolName: "command_execution",
              name: "command_execution",
              kind: "execute",
              title: it.command || "Review Check",
              status: it.status === "failed" ? "failed" : "completed",
              input: { command: it.command },
              output: it.aggregated_output || "",
              exitCode: it.exit_code ?? 0,
            });
          } else if (it.type === "agent_message" && it.text) {
            reviewText = reviewText ? `${reviewText}\n\n${it.text}` : it.text;
            emit({ type: "message_delta", delta: it.text, text: it.text, phase: "final_answer" });
          }
        } else if (evt.type === "turn.failed" || evt.type === "error") {
          streamErrorMsg = safeEngineError(evt.error?.message || evt.message || evt.error, `Codex review: ${evt.type}`);
        } else if (evt.type === "turn.completed" && evt.usage) {
          usage = {
            inputTokens: Number(evt.usage.input_tokens) || 0,
            outputTokens: Number(evt.usage.output_tokens) || 0,
            cachedInputTokens: Number(evt.usage.cached_input_tokens) || 0,
            reasoningOutputTokens: Number(evt.usage.reasoning_output_tokens) || 0,
            totalTokens: (Number(evt.usage.input_tokens) || 0) + (Number(evt.usage.output_tokens) || 0),
          };
          emit({ type: "usage_updated", usage: { ...usage } });
        }
      }

      const exitCode = await exit;

      settled = true;
      if (cancelRequested) {
        return {
          status: "interrupted",
          reviewText,
          findings: parseReviewFindings(reviewText),
          usage,
        };
      }

      if (streamErrorMsg || exitCode !== 0) {
        const errMsg = streamErrorMsg || safeEngineError(stderrTail.trim(), `codex exec review exited with code ${exitCode}`);
        emit({ type: "error", message: errMsg, error: errMsg, category: classifyErrorCategory(errMsg) });
        return {
          status: "failed",
          reviewText,
          findings: [],
          usage,
          error: errMsg,
        };
      }

      return {
        status: "completed",
        reviewText,
        findings: parseReviewFindings(reviewText),
        usage,
      };
    } catch (err) {
      settled = true;
      await forceKillProcessTree(proc);
      if (cancelRequested) {
        return { status: "interrupted", reviewText, findings: parseReviewFindings(reviewText), usage };
      }
      const errMsg = safeEngineError(err);
      emit({ type: "error", message: errMsg, error: errMsg, category: classifyErrorCategory(errMsg) });
      return { status: "failed", reviewText, findings: [], usage, error: errMsg };
    }
  })();

  return {
    async cancel() {
      cancelRequested = true;
      if (!settled) {
        await forceKillProcessTree(proc);
      }
    },
    async forceKill() {
      cancelRequested = true;
      await forceKillProcessTree(proc);
    },
    result,
  };
}

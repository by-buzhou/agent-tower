import { resolveSessionPrompt } from "../spec-context.mjs";
import { classifyAcpError, closeAcpSession, extractAcpToolTextAndDiff, initializeAcp, resumeOrCreateAcpSession } from "./acp-protocol.mjs";
import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import * as crypto from "node:crypto";
import { isInheritedEffort, isInheritedModel, normalizeEffortForTarget, normalizePermissionModeForProvider } from "../catalog.mjs";
import {
  binaryFingerprint,
  settleTurnWithClose,
  flattenAcpOptions,
  startRpcProcess,
  buildCleanChildEnv,
  gracefulCancelWithEscalation,
  mapAcpPermissionOutcome,
  resolveKimiBinary,
} from "./proc-utils.mjs";

/** Kimi ACP native modes: plan / default (ask) / auto / yolo. Only explicit yolo-class values unlock yolo. */
export function resolveKimiAcpMode(permissionMode, interactionMode) {
  const inter = String(interactionMode || "").trim().toLowerCase();
  if (inter === "plan" || String(permissionMode || "").trim().toLowerCase() === "plan") return "plan";
  const mode = normalizePermissionModeForProvider("kimi-code", permissionMode, { fallback: "default", strictReadOnly: false });
  return ["plan", "default", "auto", "yolo"].includes(mode) ? mode : "default";
}

/**
 * Execute one Kimi Code turn over `kimi acp` (Stdio NDJSON JSON-RPC 2.0).
 */
export function runKimiTurn({
  runId,
  threadId,
  model,
  effort,
  permissionMode = "auto",
  interactionMode = "default",
  cwd,
  nativeSessionId,
  resolveBinary = resolveKimiBinary,
  prompt,
  freshSessionPrompt,
  ephemeral = false,
  inheritHostMcp = false,
  mcpServers,
  warmPool,
  onEvent,
  onPermissionRequest,
  onQuestionRequest,
  asyncTeardown = true,
}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const bin = resolveBinary();
  const start = directory => startRpcProcess(bin.command, [...(bin.prefixArgs || []), "acp"], {
    cwd: directory, env: buildCleanChildEnv(bin.env),
  });
  const initialize = rpc => initializeAcp(rpc, { elicitation: true });
  const spare = warmPool?.acquire("kimi-code", binaryFingerprint(bin), inheritHostMcp === true, start, initialize);
  const { proc, rpc, close, kill } = spare || start(cwd);
  let initHandshakeMs = spare?.initHandshakeMs;
  const timing = () => ({ warmHit: Boolean(spare), ...(initHandshakeMs === undefined ? {} : { initHandshakeMs }) });

  let promptSent = false;
  let settled = false;
  let cancelRequested = false;
  const resumeSessionId = ephemeral ? undefined : nativeSessionId;
  let boundSessionId = resumeSessionId || "";
  let initialized;
  let openedSession = false;
  let assistantText = "";
  let reasoningText = "";
  let latestConfigOptions;
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    contextUsed: 0,
    contextLimit: 1048576,
  };

  const toolStates = new Map();
  const pendingPermissions = new Map();
  const pendingQuestions = new Map();

  const emit = (evt) => {
    try {
      onEvent?.({
        runId,
        threadId,
        provider: "kimi-code",
        timestamp: Date.now(),
        ...evt,
      });
    } catch {
      // Never crash driver loop on consumer callback error
    }
  };

  const kimiMode = resolveKimiAcpMode(permissionMode, interactionMode);
  const autoApproveAll = kimiMode === "yolo";

  rpc.setHandlers({
    onNotification(method, params) {
      if (settled || (params?.sessionId && params.sessionId !== boundSessionId)) return;
      const update = method === "session/update" ? params?.update : params;
      if ((method === "config_option_update" || update?.sessionUpdate === "config_option_update") &&
          (!params?.sessionId || !boundSessionId || params.sessionId === boundSessionId) && Array.isArray(update?.configOptions)) {
        latestConfigOptions = update.configOptions;
        return;
      }
      if (method !== "session/update" || !params?.update) return;
      const u = params.update;
      if (!promptSent && u.sessionUpdate !== "session_info_update") return;
      switch (u.sessionUpdate) {
        case "session_info_update": {
          if (typeof u.title === "string" && u.title.trim()) {
            emit({ type: "title_updated", title: u.title.trim() });
          }
          break;
        }
        case "agent_thought_chunk": {
          const delta = u.content?.text ?? "";
          if (delta) {
            reasoningText += delta;
            emit({ type: "reasoning_delta", delta, text: delta });
          }
          break;
        }
        case "agent_message_chunk": {
          const delta = u.content?.text ?? "";
          if (delta) {
            assistantText += delta;
            emit({ type: "message_delta", delta, text: delta, phase: "final_answer" });
          }
          break;
        }
        case "tool_call":
        case "tool_call_update": {
          const id = u.toolCallId || `kimi_tool_${toolStates.size + 1}`;
          const prev = toolStates.get(id) || {
            toolCallId: id,
            id,
            toolName: u.title || "tool",
            name: u.title || "tool",
            kind: u.kind || "other",
            title: u.title || "Tool Call",
            status: "in_progress",
            input: undefined,
            output: "",
            locations: undefined,
            diff: undefined,
          };

          const { text: contentText, diff } = extractAcpToolTextAndDiff(u.content);
          const nextStatus = u.status || prev.status;
          const isTerminal = nextStatus === "completed" || nextStatus === "failed";

          const updated = {
            ...prev,
            ...(u.title ? { title: u.title } : {}),
            ...(u.kind ? { kind: u.kind } : {}),
            ...(u.sessionUpdate === "tool_call" && u.title ? { toolName: u.title, name: u.title } : {}),
            status: nextStatus,
            ...(u.rawInput !== undefined ? { input: u.rawInput, rawInput: u.rawInput } : {}),
            ...(u.locations ? { locations: u.locations } : {}),
            ...(diff ? { diff } : {}),
          };

          if (isTerminal) {
            const outStr =
              typeof u.rawOutput === "string"
                ? u.rawOutput
                : u.rawOutput !== undefined
                  ? JSON.stringify(u.rawOutput)
                  : contentText;
            updated.output = outStr;
            updated.rawOutput = u.rawOutput ?? outStr;
          } else if (contentText && updated.input === undefined) {
            updated.argsDelta = contentText;
          }

          toolStates.set(id, updated);
          emit({ type: "tool_call", ...updated });
          break;
        }
        case "plan": {
          if (Array.isArray(u.entries)) {
            emit({
              type: "todo_list",
              entries: u.entries,
              items: u.entries.map((e) => ({
                title: e.content,
                content: e.content,
                status: e.status || "pending",
                priority: e.priority || "medium",
              })),
            });
          }
          break;
        }
        case "usage_update": {
          const used = Number(u.used) || 0;
          const size = Number(u.size) || 1048576;
          usage = {
            ...usage,
            contextUsed: used,
            contextLimit: size,
            totalTokens: Math.max(usage.totalTokens, used),
          };
          emit({ type: "usage_updated", usage: { ...usage }, contextUsed: used, contextLimit: size });
          break;
        }
        default:
          break;
      }
    },
    async onServerRequest(method, params, rpcId) {
      if (method === "session/request_permission") {
        if (settled || (params?.sessionId && params.sessionId !== boundSessionId)) return { outcome: { outcome: "cancelled" } };
        const options = Array.isArray(params?.options) ? params.options : [];
        if (autoApproveAll) return { outcome: mapAcpPermissionOutcome("approve_once", options) };
        if (!onPermissionRequest) return { outcome: mapAcpPermissionOutcome(undefined, options) };

        const reqId = `perm_${runId || "kimi"}_${rpcId}_${crypto.randomUUID().slice(0, 8)}`;
        return new Promise((resolve) => {
          pendingPermissions.set(reqId, (decision) => {
            pendingPermissions.delete(reqId);
            resolve({ outcome: mapAcpPermissionOutcome(decision, options) });
          });

          Promise.resolve()
            .then(() => onPermissionRequest({
              requestId: reqId,
              runId,
              threadId,
              provider: "kimi-code",
              kind: "permission",
              title: params?.toolCall?.title || "Tool Permission Request",
              toolCallId: params?.toolCall?.toolCallId,
              options,
              preview: params?.toolCall,
            }))
            .then((directDecision) => {
              if (directDecision !== undefined && pendingPermissions.has(reqId)) {
                pendingPermissions.get(reqId)(directDecision);
              }
            })
            .catch(() => {
              if (pendingPermissions.has(reqId)) {
                pendingPermissions.get(reqId)("reject");
              }
            });
        });
      }

      if (method === "elicitation/create") {
        if (settled || (params?.sessionId && params.sessionId !== boundSessionId)) return { action: "decline" };
        if (!onQuestionRequest) {
          return { action: "decline" };
        }
        const reqId = `ques_${runId || "kimi"}_${rpcId}_${crypto.randomUUID().slice(0, 8)}`;
        return new Promise((resolve) => {
          pendingQuestions.set(reqId, (answers) => {
            pendingQuestions.delete(reqId);
            if (!answers || answers.cancelled || answers.action === "decline") {
              resolve({ action: "decline" });
            } else {
              resolve({
                action: "accept",
                content: answers.content && typeof answers.content === "object" ? answers.content : answers,
              });
            }
          });

          Promise.resolve(
            onQuestionRequest({
              requestId: reqId,
              runId,
              threadId,
              provider: "kimi-code",
              message: params?.message || "",
              schema: params?.requestedSchema,
              toolCallId: params?.toolCallId,
            })
          )
            .then((directAnswers) => {
              if (directAnswers !== undefined && pendingQuestions.has(reqId)) {
                pendingQuestions.get(reqId)(directAnswers);
              }
            })
            .catch(() => {
              if (pendingQuestions.has(reqId)) {
                pendingQuestions.get(reqId)(null);
              }
            });
        });
      }

      return undefined;
    },
  });

  const rawResult = (async () => {
    try {
      if (spare) initialized = spare.initialized;
      else {
        const started = performance.now();
        initialized = await initialize(rpc);
        initHandshakeMs = Math.round(performance.now() - started);
      }
      const opened = await resumeOrCreateAcpSession(rpc, {
        nativeSessionId: resumeSessionId, cwd, capabilities: initialized.capabilities,
        mcpServers: inheritHostMcp === true ? mcpServers : undefined,
      });
      openedSession = true;
      boundSessionId = opened.sessionId;
      const sessionData = opened.sessionData;

      emit({
        type: "session_bound",
        ...timing(),
        nativeSessionId: boundSessionId,
        sessionId: boundSessionId,
        resumed: opened.resumed && boundSessionId === resumeSessionId,
      });

      // A model change can replace the entire config option set.
      latestConfigOptions ??= Array.isArray(sessionData.configOptions) ? sessionData.configOptions : [];
      const currentModelOpt = latestConfigOptions.find((o) => o?.id === "model" || o?.category === "model");
      if (model && !isInheritedModel(model) && currentModelOpt?.currentValue !== model) {
        try {
          const before = latestConfigOptions;
          const modelRes = await rpc.request("session/set_config_option", {
            sessionId: boundSessionId,
            configId: currentModelOpt?.id || "model",
            value: model,
          });
          if (latestConfigOptions === before && Array.isArray(modelRes?.configOptions)) {
            latestConfigOptions = modelRes.configOptions;
          }
        } catch (err) {
          if (!/already/i.test(err?.message || "")) throw err;
        }
      }

      const thinkingOpt = latestConfigOptions.find((o) => o?.id === "thinking" || o?.category === "thought_level");
      if (effort && !isInheritedEffort(effort) && Array.isArray(thinkingOpt?.options)) {
        const allowed = flattenAcpOptions(thinkingOpt.options)
          .map((o) => o?.value ?? o?.id).filter((v) => typeof v === "string");
        const chosen = allowed.length ? normalizeEffortForTarget("kimi-code", model, effort, allowed) : undefined;
        if (chosen && thinkingOpt.currentValue !== chosen) {
          await rpc.request("session/set_config_option", {
            sessionId: boundSessionId,
            configId: thinkingOpt.id,
            value: chosen,
          });
        }
      }

      // 3. Set permission / plan mode
      // Note: On session/resume of a plan-mode session, Kimi ACP v2.6.2 may report currentModeId="default"
      // while its internal agent state is already in plan mode, throwing -32603 ("Already in plan mode").
      try {
        await rpc.request("session/set_config_option", {
          sessionId: boundSessionId,
          configId: "mode",
          value: kimiMode,
        });
      } catch (modeErr) {
        const detail = modeErr?.message || "";
        const alreadyInRequestedMode = new RegExp(`^already in ${kimiMode} mode\\b`, "i").test(detail);
        if (!alreadyInRequestedMode && (kimiMode === "plan" || modeErr?.rpcCode === -32602 || modeErr?.rpcCode === -32603)) throw modeErr;
      }

      if (cancelRequested) {
        return {
          status: "interrupted",
          stopReason: "cancelled",
          nativeSessionId: ephemeral ? undefined : boundSessionId,
          assistantText,
          reasoningText,
          usage,
        };
      }

      promptSent = true;
      const promptRes = await rpc.request("session/prompt", {
        sessionId: boundSessionId,
        prompt: [{ type: "text", text: resolveSessionPrompt(prompt, freshSessionPrompt, opened.resumed && boundSessionId === resumeSessionId) }],
      });

      const stopReason = promptRes?.stopReason || "end_turn";
      const isCancelled = cancelRequested || stopReason === "cancelled";

      return {
        status: isCancelled ? "interrupted" : "completed",
        stopReason,
        nativeSessionId: ephemeral ? undefined : boundSessionId,
        assistantText,
        reasoningText,
        usage,
      };
    } catch (err) {
      if (cancelRequested) {
        return {
          status: "interrupted",
          stopReason: "cancelled",
          nativeSessionId: ephemeral ? undefined : boundSessionId || undefined,
          assistantText,
          reasoningText,
          usage,
        };
      }

      const classification = classifyAcpError(err, initialized, "kimi");
      emit({ type: "error", message: classification.error, ...classification });

      return {
        status: "failed",
        stopReason: "error",
        nativeSessionId: ephemeral ? undefined : boundSessionId || undefined,
        assistantText,
        reasoningText,
        usage,
        ...classification,
      };
    } finally {
      settled = true;
    }
  })().then(value => ({ ...value, ...timing() }));

  const { result, closed } = settleTurnWithClose(rawResult, async () => {
    for (const resolve of pendingPermissions.values()) resolve("cancel");
    for (const resolve of pendingQuestions.values()) resolve({ cancelled: true });
    try {
      if (openedSession) await closeAcpSession(rpc, boundSessionId, initialized?.capabilities, ephemeral, 1500);
    } finally { await close(); }
  }, emit, asyncTeardown);

  return {
    async cancel() {
      if (settled) return;
      cancelRequested = true;
      await gracefulCancelWithEscalation(
        proc,
        async () => {
          if (boundSessionId) {
            rpc.notify("session/cancel", { sessionId: boundSessionId });
          }
        },
        () => settled,
        2000,
        kill
      );
    },
    async forceKill() {
      cancelRequested = true;
      for (const [, resolvePerm] of pendingPermissions) resolvePerm("cancel");
      pendingPermissions.clear();
      for (const [, resolveQues] of pendingQuestions) resolveQues({ cancelled: true });
      pendingQuestions.clear();
      await kill();
    },
    async steer(_text) {
      // Kimi ACP rejects concurrent prompts on the same session with turn.agent_busy;
      // returning supported: false tells orchestrator to queue or perform steering_restart.
      return { supported: false };
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
    closed,
  };
}

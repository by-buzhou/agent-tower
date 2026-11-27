import { resolveSessionPrompt } from "../spec-context.mjs";
import { PLUGIN_VERSION } from "../daemon-client.mjs";
import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import * as crypto from "node:crypto";
import { assertAgySubagentModel, canonicalAgyModelSlug, isAgyOrchestratorModel, assertReadOnlySupport, isInheritedModel, isInheritedEffort, normalizeEffortForTarget, normalizePermissionModeForProvider, splitAgyModelVariant } from "../catalog.mjs";
import {
  spawnNoWindow,
  buildCleanChildEnv,
  classifyEngineError,
  createNdjsonRpcConnection,
  forceKillProcessTree,
  flattenAcpOptions,
  gracefulCancelWithEscalation,
  mapAcpPermissionOutcome,
  resolveAgyBinary,
  resumeOrCreateAcpSession,
} from "./proc-utils.mjs";

/**
 * Managed `agy acp` modes. Only always-proceed (and legacy full-access / yolo / danger-full-access) may pass
 * `--dangerously-skip-permissions`; legacy `auto` is safely mapped to accept-edits without skipping approvals.
 */
export function resolveAgyModeAndFlags(permissionMode, interactionMode) {
  const inter = String(interactionMode || "").trim().toLowerCase();
  if (inter === "plan" || String(permissionMode || "").trim().toLowerCase() === "plan") {
    return { acpMode: "plan", skipPermissionsFlag: false };
  }
  const perm = normalizePermissionModeForProvider("antigravity", permissionMode, { fallback: "accept-edits", strictReadOnly: false });
  if (perm === "plan") return { acpMode: "plan", skipPermissionsFlag: false };
  if (perm === "always-proceed") {
    // Live verified: --mode auto is unavailable on personal OAuth accounts;
    // passing --dangerously-skip-permissions enables autonomous tool execution cleanly.
    return { acpMode: "accept-edits", skipPermissionsFlag: true };
  }
  if (perm === "accept-edits") return { acpMode: "accept-edits", skipPermissionsFlag: false };
  return { acpMode: "default", skipPermissionsFlag: false };
}

/**
 * Execute one Antigravity CLI turn over `agy.exe acp` (Stdio NDJSON JSON-RPC 2.0),
 * capturing full real-time `agent_thought_chunk` reasoning streams, tool calls, and token usage.
 */
export function runAgyTurn({
  runId,
  threadId,
  model = "gemini-4-hydrogen",
  effort = "high",
  permissionMode = "auto-accept-edits",
  interactionMode = "default",
  cwd,
  nativeSessionId,
  prompt,
  freshSessionPrompt,
  onEvent,
  onPermissionRequest,
  signal,
  resolveBinary = resolveAgyBinary,
  promptIdleTimeoutMs = 450_000,
  promptResponseTimeoutMs = 1_800_000,
}) {
  signal?.throwIfAborted();
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  assertReadOnlySupport("antigravity", permissionMode);
  assertAgySubagentModel("antigravity", model);
  const bin = resolveBinary();
  const { acpMode, skipPermissionsFlag } = resolveAgyModeAndFlags(permissionMode, interactionMode);
  const acpArgs = [...bin.prefixArgs, "acp"];
  if (skipPermissionsFlag) {
    acpArgs.push("--dangerously-skip-permissions");
  }

  const proc = spawnNoWindow(bin.command, acpArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],

    env: buildCleanChildEnv({ ...bin.env, AGENT_TOWER_MANAGED_AGY_ACP: "1" }),

  });

  let settled = false;
  let cancelRequested = false;
  let boundSessionId = "";
  let effectiveModel;
  let assistantText = "";
  let reasoningText = "";
  let stderrTail = "";
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
  let promptTimers;
  const boundedTimeout = (value, fallback) => Number.isFinite(value) && value > 0 ? value : fallback;

  async function requestPrompt(params) {
    const idleMs = boundedTimeout(promptIdleTimeoutMs, 450_000);
    let responseRemaining = boundedTimeout(promptResponseTimeoutMs, 1_800_000);
    let idleTimer, responseTimer, resumedAt;
    const timeout = kind => rpc.dispose(new Error(`session/prompt ${kind} timeout`));
    const pause = () => {
      clearTimeout(idleTimer);
      clearTimeout(responseTimer);
      if (resumedAt !== undefined) responseRemaining -= Date.now() - resumedAt;
      resumedAt = undefined;
    };
    const touch = () => {
      clearTimeout(idleTimer);
      if (resumedAt !== undefined) idleTimer = setTimeout(() => timeout('idle'), idleMs);
    };
    const resume = () => {
      if (pendingPermissions.size || resumedAt !== undefined) return;
      resumedAt = Date.now();
      responseTimer = setTimeout(() => timeout('response'), Math.max(0, responseRemaining));
      touch();
    };
    promptTimers = { touch, pause, resume };
    resume();
    try {
      return await rpc.request("session/prompt", params);
    } finally {
      pause();
      promptTimers = undefined;
    }
  }

  const emit = (evt) => {
    try {
      onEvent?.({
        runId,
        threadId,
        provider: "antigravity",
        timestamp: Date.now(),
        ...evt,
      });
    } catch {}
  };

  let promptSent = false;
  const rpc = createNdjsonRpcConnection(proc, {
    onStderr(chunk) {
      stderrTail = (stderrTail + chunk).slice(-2000);
    },
    onNotification(method, params) {
      if (method !== "session/update" || !params?.update) return;
      promptTimers?.touch();
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
          const id = u.toolCallId || `agy_tool_${toolStates.size + 1}`;
          const prev = toolStates.get(id) || {
            toolCallId: id,
            id,
            toolName: u.name || u.title || "tool",
            name: u.name || u.title || "tool",
            kind: u.kind || "other",
            title: u.title || u.name || "Tool Call",
            status: "in_progress",
            input: u.args ?? u.rawInput,
            output: "",
            locations: u.locations,
          };

          let outText = prev.output;
          if (Array.isArray(u.content)) {
            const parts = u.content
              .map((c) => (c?.type === "content" ? c.content?.text : c?.text) || "")
              .filter(Boolean);
            if (parts.length > 0) outText = parts.join("\n");
          } else if (typeof u.rawOutput === "string") {
            outText = u.rawOutput;
          }

          const updated = {
            ...prev,
            ...(u.name ? { toolName: u.name, name: u.name } : {}),
            ...(u.title ? { title: u.title } : {}),
            ...(u.kind ? { kind: u.kind } : {}),
            ...(u.status ? { status: u.status } : {}),
            ...(u.args !== undefined || u.rawInput !== undefined
              ? { input: u.args ?? u.rawInput, rawInput: u.rawInput ?? u.args }
              : {}),
            ...(u.locations ? { locations: u.locations } : {}),
            output: outText,
          };
          toolStates.set(id, updated);
          emit({ type: "tool_call", ...updated });
          break;
        }
        case "plan": {
          if (Array.isArray(u.entries)) {
            emit({
              type: "todo_list",
              entries: u.entries,
              items: u.entries,
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
        const options = Array.isArray(params?.options) ? params.options : [];
        if (skipPermissionsFlag) return { outcome: mapAcpPermissionOutcome("allow", options) };
        if (!onPermissionRequest) return { outcome: mapAcpPermissionOutcome(undefined, options) };
        const reqId = `perm_${runId || "agy"}_${rpcId}_${crypto.randomUUID().slice(0, 8)}`;
        return new Promise((resolve) => {
          pendingPermissions.set(reqId, (decision) => {
            pendingPermissions.delete(reqId);
            promptTimers?.resume();
            resolve({ outcome: mapAcpPermissionOutcome(decision, options) });
          });

          promptTimers?.pause();
          Promise.resolve()
            .then(() => onPermissionRequest({
              requestId: reqId,
              runId,
              threadId,
              provider: "antigravity",
              kind: "permission",
              title: params?.toolCall?.title || "Antigravity Tool Permission",
              toolCallId: params?.toolCall?.toolCallId,
              options,
              preview: params?.toolCall,
            }))
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
      return undefined;
    },
  });

  const abort = () => {
    cancelRequested = true;
    if (boundSessionId) rpc.notify("session/cancel", { sessionId: boundSessionId });
    rpc.dispose(signal?.reason || new Error("Cancelled"));
  };
  signal?.addEventListener("abort", abort, { once: true });

  const cleanupProcess = async () => {
    signal?.removeEventListener("abort", abort);
    for (const resolve of pendingPermissions.values()) resolve("cancel");
    if (boundSessionId) await rpc.request("session/close", { sessionId: boundSessionId }, 1000).catch(() => {});
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
          protocolVersion: 1,
          clientInfo: { name: "agent-tower", version: PLUGIN_VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        20000
      );

      // Only a clearly missing session may fork a new context; transient resume failures surface as errors.
      const opened = await resumeOrCreateAcpSession(rpc, { nativeSessionId, cwd, resumeTimeoutMs: 15000, newTimeoutMs: 15000,
        methods: ["session/resume", "session/load"] });
      boundSessionId = opened.sessionId;
      const sessionData = opened.sessionData;

      emit({
        type: "session_bound",
        nativeSessionId: boundSessionId,
        sessionId: boundSessionId,
        resumed: opened.resumed && boundSessionId === nativeSessionId,
      });

      const inheritModel = isInheritedModel(model);
      const split = inheritModel ? {} : splitAgyModelVariant(model || "gemini-4-hydrogen");
      const baseModel = split.model || "";
      let configOptions = Array.isArray(sessionData.configOptions) ? sessionData.configOptions : [];
      const modelOption = options => options.find(o => o.id === "model" || o.category === "model");
      const unavailable = () => Object.assign(new Error("所选模型在当前 agy CLI 中不可用或未能确认选中；请检查 agy update 及模型目录。"), { code: "MODEL_UNAVAILABLE" });
      if (!inheritModel) {
        const advertised = flattenAcpOptions(modelOption(configOptions)?.options).map(o => o?.value ?? o?.id ?? o);
        const matchedAdvertised = advertised.find(v => canonicalAgyModelSlug(String(v)) === baseModel);
        if (advertised.length && !matchedAdvertised) throw unavailable();
        const wireModel = matchedAdvertised ?? baseModel;
        let setModelRes;
        try {
          setModelRes = await rpc.request("session/set_config_option", {
            sessionId: boundSessionId, configId: "model", value: wireModel,
          });
        } catch { throw unavailable(); }
        if (setModelRes === false || setModelRes?.success === false) throw unavailable();
        if (Array.isArray(setModelRes?.configOptions)) {
          configOptions = setModelRes.configOptions;
          if (canonicalAgyModelSlug(modelOption(configOptions)?.currentValue) !== baseModel) throw unavailable();
        }
        effectiveModel = baseModel;
      } else {
        effectiveModel = canonicalAgyModelSlug(modelOption(configOptions)?.currentValue);
        if (!effectiveModel) throw unavailable();
        assertAgySubagentModel("antigravity", effectiveModel);
      }

      const verifyNoModelDrift = response => {
        const updated = Array.isArray(response?.configOptions) && modelOption(response.configOptions);
        if (updated && canonicalAgyModelSlug(updated.currentValue) !== effectiveModel) throw unavailable();
      };
      const tlOpt = configOptions.find(o => o.id === "thought_level");
      const allowed = flattenAcpOptions(tlOpt?.options).map(o => o?.value ?? o?.id ?? o).filter(Boolean);
      const desiredEffort = normalizeEffortForTarget("antigravity", effectiveModel, effort || split.effort || "high", allowed);
      if (!isAgyOrchestratorModel(effectiveModel) && !isInheritedEffort(desiredEffort) && allowed.length) {
        const chosenEffort = allowed.includes(desiredEffort)
          ? desiredEffort
          : allowed.includes("high")
            ? "high"
            : allowed[allowed.length - 1];
        const response = await rpc.request("session/set_config_option", {
          sessionId: boundSessionId, configId: "thought_level", value: chosenEffort,
        }).catch(() => undefined);
        verifyNoModelDrift(response);
      }

      const modeOpt = configOptions.find(o => o.id === "mode" || o.category === "mode");
      if (acpMode && (acpMode !== "default" || (modeOpt?.currentValue && modeOpt.currentValue !== "default"))) {
        const response = await rpc.request("session/set_config_option", {
          sessionId: boundSessionId, configId: modeOpt?.id || "mode", value: acpMode,
        }).catch(error => {
          if (acpMode === "plan" || modeOpt?.currentValue) throw error;
          return undefined;
        });
        const reported = response?.configOptions?.find(o => o.id === (modeOpt?.id || "mode"));
        if (response === false || response?.success === false || (reported?.currentValue && reported.currentValue !== acpMode)) {
          throw Error(`agy 未能切换至 ${acpMode} 模式`);
        }
        verifyNoModelDrift(response);
      }

      if (cancelRequested) {
        settled = true;
        await cleanupProcess();
        return {
          status: "interrupted",
          stopReason: "cancelled",
          nativeSessionId: boundSessionId,
          assistantText,
          reasoningText,
          usage,
        };
      }

      emit({ type: "effective_model", effectiveModel });
      promptSent = true;
      const promptRes = await requestPrompt({
        sessionId: boundSessionId,
        prompt: [{ type: "text", text: resolveSessionPrompt(prompt, freshSessionPrompt, opened.resumed && boundSessionId === nativeSessionId) }],
      });

      await new Promise((r) => setTimeout(r, 100));

      if (promptRes?.usage) {
        const u = promptRes.usage;
        usage = {
          ...usage,
          inputTokens: Number(u.inputTokens) || usage.inputTokens,
          outputTokens: Number(u.outputTokens) || usage.outputTokens,
          cachedInputTokens: Number(u.cachedReadTokens) || usage.cachedInputTokens,
          reasoningOutputTokens: Number(u.thoughtTokens) || usage.reasoningOutputTokens,
          totalTokens: Number(u.totalTokens) || usage.totalTokens,
        };
        emit({
          type: "usage_updated",
          usage: { ...usage },
          contextUsed: usage.contextUsed,
          contextLimit: usage.contextLimit,
        });
      }

      settled = true;
      await cleanupProcess();

      const stopReason = promptRes?.stopReason || "end_turn";
      const isCancelled = cancelRequested || stopReason === "cancelled";

      return {
        status: isCancelled ? "interrupted" : "completed",
        effectiveModel,
        stopReason,
        nativeSessionId: boundSessionId,
        assistantText,
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
          nativeSessionId: boundSessionId || nativeSessionId || undefined,
          assistantText,
          reasoningText,
          usage,
        };
      }

      const errMsg = err?.message || String(err);
      const classification = ["MODEL_UNAVAILABLE", "UNSUPPORTED_AGY_MODEL"].includes(err?.code)
        ? { code: err.code, category: "validation_error", isRetryable: false } : classifyEngineError(err, err?.rpcCode);
      emit({
        type: "error",
        message: errMsg,
        error: errMsg,
        ...classification,
      });

      return {
        status: "failed",
        stopReason: "error",
        nativeSessionId: boundSessionId || nativeSessionId || undefined,
        assistantText,
        reasoningText,
        usage,
        error: errMsg,
        ...classification,
      };
    }
  })();

  return {
    async cancel() {
      cancelRequested = true;
      await gracefulCancelWithEscalation(
        proc,
        async () => {
          if (boundSessionId) {
            rpc.notify("session/cancel", { sessionId: boundSessionId });
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
      await forceKillProcessTree(proc);
    },
    async steer(_text) {
      return { supported: false };
    },
    async respondPermission(reqId, decision) {
      const resolver = pendingPermissions.get(reqId);
      if (resolver) resolver(decision);
    },
    async respondQuestion(_reqId, _answers) {},
    result,
  };
}

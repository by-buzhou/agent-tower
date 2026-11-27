import { resolveSessionPrompt } from "../spec-context.mjs";
import { PLUGIN_VERSION } from "../daemon-client.mjs";
import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import { isInheritedEffort, isInheritedModel, normalizeEffortForTarget, normalizePermissionModeForProvider } from "../catalog.mjs";
import * as crypto from "node:crypto";
import {
  spawnNoWindow,
  buildCleanChildEnv,
  classifyErrorCategory,
  createNdjsonRpcConnection,
  forceKillProcessTree,
  gracefulCancelWithEscalation,
  mapAcpPermissionOutcome,
  resolveExternalCommand,
  resumeOrCreateAcpSession,
  safeEngineError,
} from "./proc-utils.mjs";

export async function closeAcpSession(rpc, sessionId, capabilities, ephemeral, closeTimeoutMs) {
  if (!sessionId) return;
  const params = { sessionId };
  if (ephemeral && capabilities?.sessionCapabilities?.delete) {
    try {
      await rpc.request("session/delete", params, 3000);
      return;
    } catch {}
  }
  try {
    await rpc.request("session/close", params, closeTimeoutMs);
  } catch {}
}

function parseArgsInput(args) {
  if (Array.isArray(args)) return args.map(String).filter(Boolean);
  if (typeof args === "string" && args.trim()) {
    return args.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function extractModelsAndOptionsFromAcpSession(sessionRes = {}, providerId = "custom-acp") {
  const configOptions = Array.isArray(sessionRes.configOptions) ? sessionRes.configOptions : [];
  const modelOpt = configOptions.find((o) => o?.id === "model" || o?.category === "model");
  const effortOpt = configOptions.find(
    (o) =>
      o?.id === "thinking" ||
      o?.id === "thought_level" ||
      o?.id === "effort" ||
      o?.id === "reasoningEffort" ||
      o?.category === "thought_level"
  );
  const modeOpt = configOptions.find((o) => o?.id === "mode" || o?.category === "mode");

  const efforts = Array.isArray(effortOpt?.options)
    ? effortOpt.options.map((o) => String(o.value ?? o.id)).filter(Boolean)
    : ["low", "medium", "high"];
  const defaultEffort = effortOpt?.currentValue || efforts[Math.floor(efforts.length / 2)] || "high";
  const effortOptionId = effortOpt?.id || "thinking";

  const modesFromState = Array.isArray(sessionRes.modes?.availableModes)
    ? sessionRes.modes.availableModes.map((m) => ({
        id: String(m.id || m.value),
        label: String(m.name || m.label || m.id),
        description: m.description || "",
      }))
    : [];
  const modesFromOpt = Array.isArray(modeOpt?.options)
    ? modeOpt.options.map((m) => ({
        id: String(m.value ?? m.id),
        label: String(m.name || m.label || m.value || m.id),
        description: m.description || "",
      }))
    : [];
  const modeDescriptors = modesFromState.length > 0 ? modesFromState : modesFromOpt;
  const modeIds = modeDescriptors.length > 0 ? modeDescriptors.map((m) => m.id) : ["default", "plan", "auto"];

  const rawModelEntries = [];
  if (Array.isArray(modelOpt?.options) && modelOpt.options.length > 0) {
    for (const opt of modelOpt.options) {
      const slug = String(opt.value ?? opt.id ?? "").trim();
      if (!slug) continue;
      rawModelEntries.push({
        slug,
        name: String(opt.name || opt.label || slug),
        description: opt.description || "",
      });
    }
  } else if (Array.isArray(sessionRes.models?.availableModels) && sessionRes.models.availableModels.length > 0) {
    for (const m of sessionRes.models.availableModels) {
      const slug = String(m.modelId ?? m.id ?? m.value ?? "").trim();
      if (!slug) continue;
      rawModelEntries.push({
        slug,
        name: String(m.name || m.displayName || slug),
        description: m.description || "",
      });
    }
  }

  const defaultModel =
    String(modelOpt?.currentValue || sessionRes.models?.currentModelId || rawModelEntries[0]?.slug || "").trim();

  const optionDescriptors = [];
  if (efforts.length > 0) {
    optionDescriptors.push({
      id: effortOptionId,
      label: effortOpt?.name || "Thinking",
      type: "select",
      role: "reasoning",
      currentValue: defaultEffort,
      options: efforts.map((id) => ({ id, label: id })),
    });
  }
  if (modeDescriptors.length > 0) {
    optionDescriptors.push({
      id: "mode",
      label: "Mode",
      type: "select",
      currentValue: sessionRes.modes?.currentModeId || modeOpt?.currentValue || modeDescriptors[0].id,
      options: modeDescriptors,
    });
  }

  const models = rawModelEntries.map((entry, idx) => ({
    id: entry.slug,
    slug: entry.slug,
    name: entry.name,
    description: entry.description,
    provider: providerId,
    isDefault: entry.slug === defaultModel || (!defaultModel && idx === 0),
    enabled: true,
    locked: false,
    effortOptionId,
    efforts,
    defaultEffort,
    modes: modeIds,
    optionDescriptors,
    capabilities: { optionDescriptors },
  }));

  return {
    defaultModel,
    effortOptionId,
    efforts,
    defaultEffort,
    modes: modeIds,
    modeDescriptors,
    models,
    rawConfigOptions: configOptions,
  };
}

/**
 * Live handshake probe for any ACP-compatible Agent CLI (`initialize` -> `session/new` -> `session/close`).
 * Dynamically discovers supported models, thinking/effort levels, and runtime modes!
 */
export async function probeAcpProvider({
  id = "custom-acp",
  command,
  args = ["acp"],
  env = {},
  cwd,
  timeoutMs = 6000,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  if (!command || !String(command).trim()) {
    return { ok: false, protocol: "acp", error: "未指定可执行命令 (command)" };
  }

  const parsedArgs = parseArgsInput(args);
  const resolved = resolveExternalCommand(command, parsedArgs);
  let proc;
  try {
    proc = spawnNoWindow(resolved.command, resolved.args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],

      env: buildCleanChildEnv({ ...resolved.env, ...(env || {}) }),
    });
  } catch (spawnErr) {
    return { ok: false, protocol: "acp", error: `启动进程失败: ${spawnErr.message}` };
  }

  const rpc = createNdjsonRpcConnection(proc, {
  });

  const cleanup = async () => {
    rpc.closeStdin();
    if (proc.exitCode === null) {
      await Promise.race([
        new Promise((r) => proc.once("exit", r)),
        new Promise((r) => setTimeout(r, 250)),
      ]);
      if (proc.exitCode === null) {
        await forceKillProcessTree(proc);
      }
    }
    rpc.dispose();
  };

  try {
    const halfTimeout = Math.max(2500, Math.floor(Number(timeoutMs) || 6000));
    const initRes = await rpc.request(
      "initialize",
      {
        protocolVersion: 1,
        clientInfo: { name: "agent-tower", version: PLUGIN_VERSION },
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
      },
      halfTimeout
    );

    const sessionRes = await rpc.request(
      "session/new",
      { cwd, mcpServers: [] },
      halfTimeout
    );

    const extracted = extractModelsAndOptionsFromAcpSession(sessionRes, id);

    if (sessionRes?.sessionId) {
      try {
        await rpc.request("session/delete", { sessionId: sessionRes.sessionId }, 3000);
      } catch {
        try {
          await rpc.request("session/close", { sessionId: sessionRes.sessionId }, 1000);
        } catch {}
      }
    }

    await cleanup();

    return {
      ok: true,
      protocol: "acp",
      binaryPath: resolved.resolvedPath || resolved.command,
      agentInfo: initRes?.agentInfo || { name: String(command), version: "detected" },
      capabilities: initRes?.agentCapabilities || {},
      defaultModel: extracted.defaultModel,
      models: extracted.models,
      modes: extracted.modes,
      efforts: extracted.efforts,
      effortOptionId: extracted.effortOptionId,
    };
  } catch (err) {
    await cleanup();
    const detail = safeEngineError(err);
    return {
      ok: false,
      protocol: "acp",
      binaryPath: resolved.resolvedPath || null,
      error: detail,
    };
  }
}

/** Generic ACP ladder (plan / default / auto / full-access); foreign "skip everything" values never unlock full access. */
export function normalizeGenericPermission(provider, permissionMode) {
  return normalizePermissionModeForProvider(provider || "generic", permissionMode, { fallback: "default", strictReadOnly: false });
}

export function mapGenericModeFromPermission(permissionMode, interactionMode, availableModes = []) {
  const inter = String(interactionMode || "").trim().toLowerCase();
  const perm = String(permissionMode || "").trim().toLowerCase();

  // Never fall upward: when no candidate is offered, prefer the agent's own ask/plan modes, else leave it unchanged.
  const pickIfAvailable = (candidates) => {
    if (!Array.isArray(availableModes) || availableModes.length === 0) return candidates[0];
    for (const c of [...candidates, "default", "manual", "ask", "plan"]) {
      if (availableModes.includes(c)) return c;
    }
    return undefined;
  };

  if (inter === "plan" || perm === "plan") {
    return availableModes.length && !availableModes.includes("plan") ? undefined : "plan";
  }
  if (perm === "full-access" || perm === "yolo" || perm === "danger-full-access") {
    return pickIfAvailable(["full-access", "yolo", "auto", "accept-edits", "default"]);
  }
  if (perm === "auto" || perm === "workspace-write") {
    return pickIfAvailable(["auto", "accept-edits", "default"]);
  }
  if (perm === "auto-accept-edits" || perm === "accept-edits") {
    return pickIfAvailable(["accept-edits", "default"]);
  }
  return pickIfAvailable(["default", "manual"]);
}

/**
 * Universal ACP (Stdio JSON-RPC 2.0) Turn Driver for any external ACP platform
 * (OpenCode, Gemini CLI, Cursor Agent, Grok CLI, Kiro CLI, Goose, or custom ACP servers).
 */
export function runGenericAcpTurn({
  runId,
  threadId,
  provider = "custom-acp",
  providerConfig = {},
  model,
  effort,
  permissionMode = "auto",
  interactionMode = "default",
  cwd,
  nativeSessionId,
  prompt = "",
  freshSessionPrompt,
  ephemeral = false,
  onEvent,
  onPermissionRequest,
  onQuestionRequest,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const rawCommand = providerConfig.command || provider;
  const rawArgs = parseArgsInput(providerConfig.args ?? ["acp"]);
  const resolved = resolveExternalCommand(rawCommand, rawArgs, providerConfig.candidatePaths || []);

  const proc = spawnNoWindow(resolved.command, resolved.args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],

    env: buildCleanChildEnv({
      ...resolved.env,
      ...(providerConfig.env && typeof providerConfig.env === "object" ? providerConfig.env : {}),
    }),
  });

  let settled = false;
  let cancelRequested = false;
  const resumeSessionId = ephemeral ? undefined : nativeSessionId;
  let boundSessionId = resumeSessionId || "";
  let agentCapabilities;
  let assistantText = "";
  let reasoningText = "";
  let usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    contextUsed: 0,
    contextLimit: 0,
  };

  const toolStates = new Map();
  const pendingPermissions = new Map();
  const pendingQuestions = new Map();
  const nativePermission = normalizeGenericPermission(provider, permissionMode);
  const planning = nativePermission === "plan" || String(interactionMode).toLowerCase() === "plan";
  const autoApprove = !planning && nativePermission === "full-access";

  const emit = (evt) => {
    try {
      onEvent?.({
        runId,
        threadId,
        provider,
        timestamp: Date.now(),
        ...evt,
      });
    } catch {}
  };

  let promptSent = false;
  const rpc = createNdjsonRpcConnection(proc, {
    onNotification(method, params) {
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
          const id = u.toolCallId || `${provider}_tool_${toolStates.size + 1}`;
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

          let outStr = prev.output;
          if (typeof u.rawOutput === "string") {
            outStr = u.rawOutput;
          } else if (Array.isArray(u.content)) {
            const texts = u.content
              .map((c) => (c?.type === "content" ? c.content?.text : c?.text) || "")
              .filter(Boolean);
            if (texts.length > 0) outStr = texts.join("\n");
          }

          const updated = {
            ...prev,
            ...(u.name ? { toolName: u.name, name: u.name } : {}),
            ...(u.title ? { title: u.title } : {}),
            ...(u.kind ? { kind: u.kind } : {}),
            ...(u.status ? { status: u.status } : {}),
            ...(u.rawInput !== undefined || u.args !== undefined
              ? { input: u.rawInput ?? u.args, rawInput: u.rawInput ?? u.args }
              : {}),
            ...(u.locations ? { locations: u.locations } : {}),
            output: outStr,
          };
          toolStates.set(id, updated);
          emit({ type: "tool_call", ...updated });
          break;
        }
        case "plan": {
          if (Array.isArray(u.entries)) {
            emit({ type: "todo_list", entries: u.entries, items: u.entries });
          }
          break;
        }
        case "usage_update": {
          const used = Number(u.used) || 0;
          const size = Number(u.size) || 0;
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
        const options = Array.isArray(params?.options) ? params.options : [];
        if (autoApprove) return { outcome: mapAcpPermissionOutcome("allow", options) };
        if (!onPermissionRequest) return { outcome: mapAcpPermissionOutcome(undefined, options) };
        const reqId = `perm_${runId || provider}_${rpcId}_${crypto.randomUUID().slice(0, 8)}`;
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
              provider,
              kind: "permission",
              title: params?.toolCall?.title || `${provider} Permission Request`,
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

      if (method === "elicitation/create") {
        if (!onQuestionRequest) return { action: "decline" };
        const reqId = `ques_${runId || provider}_${rpcId}_${crypto.randomUUID().slice(0, 8)}`;
        return new Promise((resolve) => {
          pendingQuestions.set(reqId, (answers) => {
            pendingQuestions.delete(reqId);
            if (!answers || answers.cancelled) resolve({ action: "decline" });
            else resolve({ action: "accept", content: answers.content || answers });
          });
          Promise.resolve(
            onQuestionRequest({
              requestId: reqId,
              runId,
              threadId,
              provider,
              message: params?.message || "",
              schema: params?.requestedSchema,
            })
          )
            .then((direct) => {
              if (direct !== undefined && pendingQuestions.has(reqId)) {
                pendingQuestions.get(reqId)(direct);
              }
            })
            .catch(() => {
              if (pendingQuestions.has(reqId)) pendingQuestions.get(reqId)(null);
            });
        });
      }
      return undefined;
    },
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
      const initialized = await rpc.request(
        "initialize",
        {
          protocolVersion: 1,
          clientInfo: { name: "agent-tower", version: PLUGIN_VERSION },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            elicitation: { form: true },
          },
        },
        20000
      );
      agentCapabilities = initialized?.agentCapabilities;

      // resume -> (unimplemented) load -> new only when the session is clearly gone; transient errors rethrow.
      const opened = await resumeOrCreateAcpSession(rpc, { nativeSessionId: resumeSessionId, cwd, resumeTimeoutMs: 12000, newTimeoutMs: 15000 });
      boundSessionId = opened.sessionId;
      const sessionRes = opened.sessionData;

      emit({
        type: "session_bound",
        nativeSessionId: boundSessionId,
        sessionId: boundSessionId,
        resumed: opened.resumed && boundSessionId === resumeSessionId,
      });

      const meta = extractModelsAndOptionsFromAcpSession(sessionRes, provider);
      let configOptions = meta.rawConfigOptions;

      // 1. Apply model selection (prefer configOption 'model', fallback 'session/set_model')
      if (model && !isInheritedModel(model)) {
        const modelOpt = configOptions.find((o) => o?.id === "model" || o?.category === "model");
        let modelApplied = (modelOpt?.currentValue ?? sessionRes.models?.currentModelId) === model;
        if (!modelApplied) {
          if (modelOpt?.id) {
            try {
              const r = await rpc.request("session/set_config_option", {
                sessionId: boundSessionId,
                configId: modelOpt.id,
                value: model,
              }, 5000);
              if (Array.isArray(r?.configOptions)) configOptions = r.configOptions;
              modelApplied = true;
            } catch {}
          }
          if (!modelApplied) {
            try {
              await rpc.request("session/set_model", { sessionId: boundSessionId, modelId: model }, 5000);
            } catch {
              const requestedModel = safeEngineError(model, "指定模型");
              emit({
                type: "message_delta",
                phase: "commentary",
                itemId: "acp-model-warning",
                delta: `⚠️ ACP 引擎未能切换到模型 ${requestedModel}，将沿用当前模型。`,
              });
            }
          }
        }
      }

      // 2. Apply effort / thinking level if supported
      if (effort && !isInheritedEffort(effort)) {
        const effOpt = configOptions.find(
          (o) =>
            o?.id === "thinking" ||
            o?.id === "thought_level" ||
            o?.id === "effort" ||
            o?.id === "reasoningEffort" ||
            o?.category === "thought_level"
        );
        if (effOpt && Array.isArray(effOpt.options) && effOpt.options.length > 0) {
          const allowed = effOpt.options.flatMap((o) => Array.isArray(o?.options) ? o.options : [o])
            .map((o) => o?.value ?? o?.id).filter((v) => typeof v === "string");
          const chosen = allowed.length ? normalizeEffortForTarget(provider, model, effort, allowed) : undefined;
          if (chosen && effOpt.currentValue !== chosen) {
            try {
              await rpc.request("session/set_config_option", {
                sessionId: boundSessionId,
                configId: effOpt.id,
                value: chosen,
              });
            } catch {}
          }
        }
      }

      // 3. Apply permission / plan mode
      const targetMode = mapGenericModeFromPermission(nativePermission, interactionMode, meta.modes);
      const modeOpt = configOptions.find((o) => o?.id === "mode" || o?.category === "mode");
      const currentMode = modeOpt?.currentValue || sessionRes.modes?.currentModeId;
      if (!targetMode) throw new Error("该 ACP 引擎未提供相容的权限模式，未发送任务。");
      if (currentMode !== targetMode) {
        try {
          if (modeOpt) {
            await rpc.request("session/set_config_option", {
              sessionId: boundSessionId,
              configId: modeOpt.id,
              value: targetMode,
            });
          } else {
            await rpc.request("session/set_mode", {
              sessionId: boundSessionId,
              modeId: targetMode,
            });
          }
        } catch (error) {
          if (planning || currentMode || meta.modeDescriptors.length) throw error;
        }
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

      await new Promise((r) => setTimeout(r, 100));

      if (promptRes?.usage) {
        const u = promptRes.usage;
        usage = {
          ...usage,
          inputTokens: Number(u.inputTokens ?? u.input_tokens ?? usage.inputTokens),
          outputTokens: Number(u.outputTokens ?? u.output_tokens ?? usage.outputTokens),
          cachedInputTokens: Number(u.cachedReadTokens ?? u.cached_input_tokens ?? usage.cachedInputTokens),
          reasoningOutputTokens: Number(u.thoughtTokens ?? u.reasoning_output_tokens ?? usage.reasoningOutputTokens),
          totalTokens: Number(u.totalTokens ?? u.total_tokens ?? usage.totalTokens),
        };
        emit({ type: "usage_updated", usage: { ...usage } });
      }

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

      const fullError = safeEngineError(err);

      emit({
        type: "error",
        message: fullError,
        error: fullError,
        category: classifyErrorCategory(fullError, err?.rpcCode),
      });

      return {
        status: "failed",
        stopReason: "error",
        nativeSessionId: ephemeral ? undefined : boundSessionId || undefined,
        assistantText,
        reasoningText,
        usage,
        error: fullError,
      };
    } finally {
      settled = true;
      try {
        await closeAcpSession(rpc, boundSessionId, agentCapabilities, ephemeral, 1200);
      } finally {
        await cleanupProcess();
      }
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
      for (const [, res] of pendingQuestions) res({ cancelled: true });
      pendingQuestions.clear();
      await forceKillProcessTree(proc);
    },
    async steer() {
      return { supported: false };
    },
    async respondPermission(reqId, decision) {
      const r = pendingPermissions.get(reqId);
      if (r) r(decision);
    },
    async respondQuestion(reqId, answers) {
      const r = pendingQuestions.get(reqId);
      if (r) r(answers);
    },
    result,
  };
}

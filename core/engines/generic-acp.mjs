import { resolveSessionPrompt } from "../spec-context.mjs";
import { classifyAcpError, closeAcpSession, extractAcpToolTextAndDiff, initializeAcp, resumeOrCreateAcpSession } from "./acp-protocol.mjs";
import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import { isInheritedEffort, isInheritedModel, normalizeEffortForTarget, normalizePermissionModeForProvider } from "../catalog.mjs";
import * as crypto from "node:crypto";
import {
  settleTurnWithClose,
  flattenAcpOptions,
  startRpcProcess,
  buildCleanChildEnv,
  gracefulCancelWithEscalation,
  mapAcpPermissionOutcome,
  resolveExternalCommand,
  safeCatalogText,
  safeEngineError,
} from "./proc-utils.mjs";

export { closeAcpSession } from "./acp-protocol.mjs";

function parseArgsInput(args) {
  if (Array.isArray(args)) return args.map(String).filter(Boolean);
  if (typeof args === "string" && args.trim()) {
    return args.trim().split(/\s+/).filter(Boolean);
  }
  return [];
}

function flattenAcpConfigOptions(configOptions) {
  return Array.isArray(configOptions) ? configOptions.filter(Boolean).map(option =>
    Array.isArray(option.options) ? { ...option, options: flattenAcpOptions(option.options).filter(Boolean) } : option) : [];
}

function startAcpCommand(command, args, { cwd, env, candidatePaths, handlers }) {
  const resolved = resolveExternalCommand(command, args, candidatePaths);
  let diagnostic = "";
  const child = startRpcProcess(resolved.command, resolved.args, { cwd, env: buildCleanChildEnv({ ...resolved.env, ...env }) });
  child.rpc.setHandlers({ ...handlers, onStderr: chunk => { diagnostic = (diagnostic + chunk).slice(-8192); } });
  return { ...child, binaryPath: resolved.resolvedPath || resolved.command, diagnostic: () => diagnostic };
}

async function negotiateAcp(id, args, start, options, cancelled = () => false) {
  const child = start(args);
  try { return await initializeAcp(child.rpc, options); }
  catch (error) {
    if (id !== "gemini-cli" || !args.includes("--acp") || args.includes("--experimental-acp") || cancelled() || error.code || error.rpcCode !== undefined) throw error;
    await child.close(0);
    const detail = child.diagnostic();
    if (cancelled() || !/(?:unknown|unrecognized|unexpected|unsupported|invalid|no such)\s+(?:command|option|argument|flag)s?[^\r\n]*\b(?:--)?acp\b/i.test(detail)) throw error;
    const fallback = start(args.map(arg => arg === "--acp" ? "--experimental-acp" : arg));
    return initializeAcp(fallback.rpc, options);
  }
}

function extractModelsAndOptionsFromAcpSession(sessionRes = {}, providerId = "custom-acp") {
  const configOptions = flattenAcpConfigOptions(sessionRes.configOptions);
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
    ? effortOpt.options.map(o => o?.value ?? o?.id).filter(value => typeof value === "string" && value)
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
      options: efforts.map(id => {
        const option = effortOpt?.options?.find(o => (o?.value ?? o?.id) === id);
        return { id, label: option?.name || option?.label || id };
      }),
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
  extraCandidatePaths,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  if (!command || !String(command).trim()) {
    return { ok: false, protocol: "acp", error: "未指定可执行命令 (command)" };
  }

  let child, initialized;
  const halfTimeout = Math.max(2500, Math.floor(Number(timeoutMs) || 6000));
  const start = args => child = startAcpCommand(command, args, { cwd, env, candidatePaths: extraCandidatePaths });
  try {
    initialized = await negotiateAcp(id, parseArgsInput(args), start, { timeoutMs: halfTimeout });
    const session = await resumeOrCreateAcpSession(child.rpc, { cwd, newTimeoutMs: halfTimeout });
    const extracted = extractModelsAndOptionsFromAcpSession(session.sessionData, id);
    await closeAcpSession(child.rpc, session.sessionId, initialized.capabilities, true);
    return {
      ok: true,
      protocol: "acp",
      binaryPath: child.binaryPath,
      agentInfo: initialized.agentInfo || { name: String(command), version: "detected" },
      capabilities: initialized.capabilities || {},
      defaultModel: extracted.defaultModel,
      models: extracted.models,
      modes: extracted.modes,
      efforts: extracted.efforts,
      effortOptionId: extracted.effortOptionId,
    };
  } catch (err) {
    return { ok: false, protocol: "acp", binaryPath: child?.binaryPath || null, ...classifyAcpError(err, initialized, command) };
  } finally { await child?.close(); }
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
  asyncTeardown = true,
  inheritHostMcp = false,
  mcpServers = providerConfig.mcpServers,
  onEvent,
  onPermissionRequest,
  onQuestionRequest,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const rawCommand = providerConfig.command || provider;
  const rawArgs = parseArgsInput(providerConfig.args ?? ["acp"]);
  let child, rpc, initialized, initHandshakeMs;
  let openedSession = false;
  let configOptions;
  let effectiveModel;

  let settled = false;
  let cancelRequested = false;
  const resumeSessionId = ephemeral ? undefined : nativeSessionId;
  let boundSessionId = resumeSessionId || "";
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

  function reportEffectiveModel() {
    const selected = safeCatalogText(configOptions?.find(o => o.id === "model" || o.category === "model")?.currentValue);
    if (!selected || selected === effectiveModel) return;
    effectiveModel = selected;
    emit({ type: "effective_model", effectiveModel });
  }

  let promptSent = false;
  const handlers = {
    onNotification(method, params) {
      if (settled || (params?.sessionId && params.sessionId !== boundSessionId)) return;
      const u = method === "session/update" ? params?.update : params;
      if ((method === "config_option_update" || u?.sessionUpdate === "config_option_update") && Array.isArray(u?.configOptions)) {
        configOptions = flattenAcpConfigOptions(u.configOptions);
        if (promptSent) reportEffectiveModel();
        return;
      }
      if (method !== "session/update" || !u) return;
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

          const { text, diff } = extractAcpToolTextAndDiff(u.content);
          const output = typeof u.rawOutput === "string" ? u.rawOutput : text || prev.output;

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
            output,
            ...(diff ? { diff } : {}),
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
        if (settled || (params?.sessionId && params.sessionId !== boundSessionId)) return { outcome: { outcome: "cancelled" } };
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
        if (settled || (params?.sessionId && params.sessionId !== boundSessionId)) return { action: "decline" };
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
  };
  const start = args => {
    child = startAcpCommand(rawCommand, args, {
      cwd, env: providerConfig.env, candidatePaths: providerConfig.candidatePaths ?? providerConfig.extraCandidatePaths, handlers,
    });
    rpc = child.rpc;
    return child;
  };

  const rawResult = (async () => {
    try {
      const started = performance.now();
      initialized = await negotiateAcp(provider, rawArgs, start, { elicitation: true }, () => cancelRequested);
      initHandshakeMs = Math.round(performance.now() - started);
      const opened = await resumeOrCreateAcpSession(rpc, {
        nativeSessionId: resumeSessionId, cwd, capabilities: initialized.capabilities,
        mcpServers: inheritHostMcp === true ? mcpServers : undefined, resumeTimeoutMs: 12000,
      });
      openedSession = true;
      boundSessionId = opened.sessionId;
      const sessionRes = opened.sessionData;

      emit({
        type: "session_bound",
        initHandshakeMs,
        nativeSessionId: boundSessionId,
        sessionId: boundSessionId,
        resumed: opened.resumed && boundSessionId === resumeSessionId,
      });

      configOptions ??= flattenAcpConfigOptions(sessionRes.configOptions);

      // 1. Apply model selection (prefer configOption 'model', fallback 'session/set_model')
      if (model && !isInheritedModel(model)) {
        const modelOpt = configOptions.find((o) => o?.id === "model" || o?.category === "model");
        let modelApplied = (modelOpt?.currentValue ?? sessionRes.models?.currentModelId) === model;
        if (!modelApplied) {
          if (modelOpt?.id) {
            try {
              const before = configOptions;
              const r = await rpc.request("session/set_config_option", {
                sessionId: boundSessionId,
                configId: modelOpt.id,
                value: model,
              }, 5000);
              if (configOptions === before && Array.isArray(r?.configOptions)) configOptions = flattenAcpConfigOptions(r.configOptions);
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
          const allowed = effOpt.options
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
      const meta = extractModelsAndOptionsFromAcpSession({ ...sessionRes, configOptions }, provider);
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

      reportEffectiveModel();
      promptSent = true;
      const promptRes = await rpc.request("session/prompt", {
        sessionId: boundSessionId,
        prompt: [{ type: "text", text: resolveSessionPrompt(prompt, freshSessionPrompt, opened.resumed && boundSessionId === resumeSessionId) }],
      });

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
        effectiveModel,
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

      const classification = classifyAcpError(err, initialized, rawCommand);
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
  })().then(value => initHandshakeMs === undefined ? value : { ...value, initHandshakeMs });

  const { result, closed } = settleTurnWithClose(rawResult, async () => {
    for (const resolve of pendingPermissions.values()) resolve("cancel");
    for (const resolve of pendingQuestions.values()) resolve({ cancelled: true });
    try {
      if (openedSession) await closeAcpSession(rpc, boundSessionId, initialized?.capabilities, ephemeral);
    } finally { await child?.close(); }
  }, emit, asyncTeardown);

  return {
    async cancel() {
      if (settled || !child) return;
      cancelRequested = true;
      await gracefulCancelWithEscalation(
        child.proc,
        async () => {
          if (boundSessionId) {
            rpc.notify("session/cancel", { sessionId: boundSessionId });
          }
        },
        () => settled,
        2000,
        child.kill
      );
    },
    async forceKill() {
      cancelRequested = true;
      for (const [, res] of pendingPermissions) res("cancel");
      pendingPermissions.clear();
      for (const [, res] of pendingQuestions) res({ cancelled: true });
      pendingQuestions.clear();
      await child?.kill();
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
    closed,
  };
}

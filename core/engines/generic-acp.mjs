import { resolveSessionPrompt } from "../spec-context.mjs";
import { classifyAcpError, closeAcpSession, extractAcpToolTextAndDiff, initializeAcp, resumeOrCreateAcpSession } from "./acp-protocol.mjs";
import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import { isInheritedEffort, normalizeEffortForTarget, normalizePermissionModeForProvider } from "../catalog.mjs";
import * as crypto from "node:crypto";
import {
  settleTurnWithClose,
  flattenAcpOptions,
  normalizeTokenLimit,
  startRpcProcess,
  buildCleanChildEnv,
  extensionEnvOptions,
  isExtensionDefaultModel,
  gracefulCancelWithEscalation,
  mapAcpPermissionOutcome,
  resolveExternalCommand,
  resolveDshBinary,
  safeCatalogText,
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

function startAcpCommand(command, args, { id, cwd, env, candidatePaths, handlers, envOptions }) {
  let resolved;
  if (id === "dsh") {
    const bin = resolveDshBinary(candidatePaths, command);
    if (!bin.available) throw new Error("未找到 DeepSeek Harness 可执行程序。");
    resolved = { ...bin, args: [...bin.prefixArgs, ...args] };
  } else {
    resolved = resolveExternalCommand(command, args, candidatePaths);
  }
  let diagnostic = "";
  const child = startRpcProcess(resolved.command, resolved.args, {
    cwd, env: buildCleanChildEnv({ ...resolved.env, ...env }, envOptions),
  });
  child.rpc.setHandlers({ ...handlers, onStderr: chunk => { diagnostic = (diagnostic + chunk).slice(-8192); } });
  return { ...child, binaryPath: resolved.resolvedPath || resolved.command, diagnostic: () => diagnostic };
}

function dshEnv(id, env, permission = "workspace-write") {
  if (id !== "dsh") return env;
  const configured = { DSH_TELEMETRY_DISABLED: process.env.DSH_TELEMETRY_DISABLED || "1", ...env };
  for (const key of Object.keys(configured)) {
    if (key.toUpperCase() === "DSH_PERMISSION_MODE") delete configured[key];
  }
  return { ...configured, DSH_PERMISSION_MODE: permission };
}

function dshModelParts(id) {
  if (typeof id !== "string" || !id.startsWith("[")) return [];
  try {
    const pair = JSON.parse(id);
    if (Array.isArray(pair) && pair.length === 2 && pair.every(part => typeof part === "string" && part)) return pair;
  } catch {}
  return [];
}

function publicModelId(provider, id) {
  const parts = provider === "dsh" ? dshModelParts(id) : [];
  return parts.length ? parts.join("/") : id;
}

function resolveDshModel(model, session) {
  const entries = [session.defaultModel, ...session.models.map(entry => entry.slug)].filter(Boolean);
  const exact = entries.find(id => id === model || publicModelId("dsh", id) === model);
  if (exact) return exact;
  const matches = [...new Set(entries.filter(id => dshModelParts(id)[1] === model))];
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) return undefined;
  const separator = model.indexOf("/");
  return separator > 0 ? JSON.stringify([model.slice(0, separator), model.slice(separator + 1)]) : model;
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

function findAcpEffortOption(configOptions = []) {
  return configOptions.find(
    (o) =>
      o?.id === "thinking" ||
      o?.id === "thought_level" ||
      o?.id === "effort" ||
      o?.id === "reasoning_effort" ||
      o?.id === "reasoningEffort" ||
      o?.category === "thought_level"
  );
}

function applyModelEffortMetadata(model, modelEfforts, rawDefaultEffort, effortOpt, fallbackEffortOptionId, modeOptions) {
  const cleanEfforts = modelEfforts.map(v => safeCatalogText(v)).filter(Boolean);
  const cur = safeCatalogText(rawDefaultEffort);
  const modelDefaultEffort = cleanEfforts.length === 0
    ? ""
    : cleanEfforts.includes(cur)
      ? cur
      : cleanEfforts[Math.floor(cleanEfforts.length / 2)] || cleanEfforts[0];
  const effId = safeCatalogText(effortOpt?.id) || fallbackEffortOptionId || "thinking";
  const optionDescriptors = cleanEfforts.length ? [{
    id: effId,
    label: safeCatalogText(effortOpt?.name) || "Thinking",
    type: "select",
    role: "reasoning",
    currentValue: modelDefaultEffort,
    options: cleanEfforts.map(id => {
      const option = effortOpt?.options?.find(o => safeCatalogText(o?.value ?? o?.id) === id);
      return { id, label: safeCatalogText(option?.name || option?.label) || id };
    }),
  }, ...modeOptions] : modeOptions;
  return {
    ...model,
    effortOptionId: cleanEfforts.length ? effId : undefined,
    efforts: cleanEfforts,
    defaultEffort: modelDefaultEffort,
    optionDescriptors,
    capabilities: { optionDescriptors },
  };
}

function extractModelsAndOptionsFromAcpSession(sessionRes = {}, providerId = "custom-acp") {
  const configOptions = flattenAcpConfigOptions(sessionRes.configOptions);
  const modelOpt = configOptions.find((o) => o?.id === "model" || o?.category === "model");
  const effortOpt = findAcpEffortOption(configOptions);
  const modeOpt = configOptions.find((o) => o?.id === "mode" || o?.category === "mode");

  const efforts = Array.isArray(effortOpt?.options)
    ? effortOpt.options.map(o => safeCatalogText(o?.value ?? o?.id)).filter(Boolean)
    : modelOpt ? [] : ["low", "medium", "high"];
  const currentEffort = safeCatalogText(effortOpt?.currentValue);
  const defaultEffort = efforts.includes(currentEffort) ? currentEffort : efforts[Math.floor(efforts.length / 2)] || "high";
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
  const modeIds = modeDescriptors.map((m) => m.id);

  const rawModelEntries = [];
  if (Array.isArray(modelOpt?.options) && modelOpt.options.length > 0) {
    for (const opt of modelOpt.options) {
      const slug = String(opt.value ?? opt.id ?? "").trim();
      if (!slug) continue;
      const optEfforts = Array.isArray(opt.efforts)
        ? opt.efforts.map(v => safeCatalogText(v?.value ?? v?.id ?? v)).filter(Boolean)
        : null;
      rawModelEntries.push({
        slug,
        name: safeCatalogText(opt.name || opt.label) || slug,
        description: safeCatalogText(opt.description),
        group: safeCatalogText(opt.group || opt.providerLabel || opt.providerGroup || ""),
        contextWindow: normalizeTokenLimit(opt.contextWindow ?? opt.maxContextTokens ?? opt.context_window ?? opt.limits?.contextWindow),
        maxOutputTokens: normalizeTokenLimit(opt.maxOutputTokens ?? opt.max_output_tokens ?? opt.limits?.maxOutputTokens),
        efforts: optEfforts,
        defaultEffort: safeCatalogText(opt.defaultEffort || ""),
      });
    }
  } else if (Array.isArray(sessionRes.models?.availableModels) && sessionRes.models.availableModels.length > 0) {
    for (const m of sessionRes.models.availableModels) {
      const slug = String(m.modelId ?? m.id ?? m.value ?? "").trim();
      if (!slug) continue;
      const mEfforts = Array.isArray(m.efforts)
        ? m.efforts.map(v => safeCatalogText(v?.value ?? v?.id ?? v)).filter(Boolean)
        : null;
      rawModelEntries.push({
        slug,
        name: safeCatalogText(m.name || m.displayName) || slug,
        description: safeCatalogText(m.description),
        group: safeCatalogText(m.group || m.providerLabel || m.providerGroup || ""),
        contextWindow: normalizeTokenLimit(m.contextWindow ?? m.maxContextTokens ?? m.context_window ?? m.limits?.contextWindow),
        maxOutputTokens: normalizeTokenLimit(m.maxOutputTokens ?? m.max_output_tokens ?? m.limits?.maxOutputTokens),
        efforts: mEfforts,
        defaultEffort: safeCatalogText(m.defaultEffort || ""),
      });
    }
  }

  const currentModel = String(modelOpt?.currentValue || sessionRes.models?.currentModelId || "").trim();
  const defaultModel = currentModel || rawModelEntries[0]?.slug || "";

  const modeOptions = [];
  if (modeDescriptors.length > 0) {
    modeOptions.push({
      id: "mode",
      label: "Mode",
      type: "select",
      currentValue: sessionRes.modes?.currentModeId || modeOpt?.currentValue || modeDescriptors[0].id,
      options: modeDescriptors,
    });
  }

  const models = rawModelEntries.map((entry, idx) => {
    const modelEfforts = entry.efforts || efforts;
    const rawDefault = entry.defaultEffort || (entry.efforts ? "" : defaultEffort);
    const baseModel = {
      id: entry.slug,
      slug: entry.slug,
      name: entry.name,
      description: entry.description,
      ...(entry.group ? { group: entry.group } : {}),
      contextWindow: entry.contextWindow,
      ...(entry.maxOutputTokens > 0 ? { maxOutputTokens: entry.maxOutputTokens } : {}),
      provider: providerId,
      isDefault: entry.slug === defaultModel || (!defaultModel && idx === 0),
      enabled: true,
      locked: false,
      modes: modeIds,
      hasExplicitEfforts: Boolean(entry.efforts),
    };
    return applyModelEffortMetadata(baseModel, modelEfforts, rawDefault, effortOpt, effortOptionId, modeOptions);
  });

  return {
    defaultModel,
    currentModel,
    modelOptionId: safeCatalogText(modelOpt?.id),
    hasEffortOption: Boolean(effortOpt),
    effortOptionId,
    efforts,
    defaultEffort,
    modes: modeIds,
    modeDescriptors,
    modeOptions,
    models,
    rawConfigOptions: configOptions,
  };
}

/**
 * Live handshake probe for any ACP-compatible Agent CLI (`initialize` -> `session/new` -> `session/close`).
 * Dynamically discovers supported models, per-model thinking/effort levels, and runtime modes!
 */
export async function probeAcpProvider({
  id = "custom-acp",
  command = id === "dsh" ? "dsh" : undefined,
  args = id === "dsh" ? ["--profile", "acp"] : ["acp"],
  env = {},
  envPolicy,
  credentialEnvKeys,
  cwd,
  timeoutMs = 6000,
  extraCandidatePaths,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  if (!command || !String(command).trim()) {
    return { ok: false, protocol: "acp", error: "未指定可执行命令 (command)" };
  }

  let child, initialized, session, onConfigOptions;
  const handshakeTimeout = Math.max(8000, Math.floor(Number(timeoutMs) || 6000));
  const handlers = {
    onNotification(method, params) {
      const update = method === "config_option_update" ? params : params?.update;
      if (params?.sessionId === session?.sessionId &&
          (method === "config_option_update" || method === "session/update" && update?.sessionUpdate === "config_option_update")) {
        onConfigOptions?.(update.configOptions);
      }
    },
  };
  const start = args => child = startAcpCommand(command, args, {
    id, cwd, handlers, env: dshEnv(id, env), candidatePaths: extraCandidatePaths,
    envOptions: extensionEnvOptions(id, { envPolicy, credentialEnvKeys }),
  });
  try {
    initialized = await negotiateAcp(id, parseArgsInput(args), start, { timeoutMs: handshakeTimeout });
    session = await resumeOrCreateAcpSession(child.rpc, { cwd, newTimeoutMs: handshakeTimeout });
    const extracted = extractModelsAndOptionsFromAcpSession(session.sessionData, id);
    const probedModels = [...extracted.models];
    if (extracted.modelOptionId && extracted.currentModel && probedModels.length > 1) {
      const sweepDeadline = Date.now() + Math.min(handshakeTimeout, 6000);
      const limit = Math.min(probedModels.length, 32);
      const changeModel = (value, timeout) => child.rpc.request("session/set_config_option", {
        sessionId: session.sessionId, configId: extracted.modelOptionId, value,
      }, timeout);
      let needsRestore = false;
      try {
        for (const [i, current] of probedModels.slice(0, limit).entries()) {
          const waitMs = Math.min(1500, sweepDeadline - Date.now());
          if (waitMs <= 0) break;
          if (current.hasExplicitEfforts || current.slug === extracted.currentModel) continue;
          const options = Promise.withResolvers();
          onConfigOptions = raw => {
            if (!Array.isArray(raw)) return;
            const reported = raw.find(o => o?.id === extracted.modelOptionId)?.currentValue;
            if (!reported || reported === current.slug) options.resolve(raw);
          };
          const timer = setTimeout(() => options.resolve(null), waitMs);
          let nextRaw;
          try {
            const response = await changeModel(current.slug, waitMs);
            needsRestore = true;
            onConfigOptions(response?.configOptions);
            nextRaw = await options.promise;
          } catch (err) {
            if (err.rpcCode !== undefined) continue;
            // A missing acknowledgement does not tell us whether the engine applied the switch.
            needsRestore = true;
            break;
          } finally {
            clearTimeout(timer);
            onConfigOptions = undefined;
          }
          if (!nextRaw) break;
          const nextEffortOpt = findAcpEffortOption(flattenAcpConfigOptions(nextRaw));
          if (nextEffortOpt) {
            const levels = Array.isArray(nextEffortOpt.options) ? nextEffortOpt.options.map(o => o?.value ?? o?.id) : [];
            probedModels[i] = applyModelEffortMetadata(
              current, levels, nextEffortOpt.currentValue, nextEffortOpt, extracted.effortOptionId, extracted.modeOptions
            );
          } else if (extracted.hasEffortOption) {
            probedModels[i] = applyModelEffortMetadata(
              current, [], "", null, extracted.effortOptionId, extracted.modeOptions
            );
          }
        }
      } finally {
        if (needsRestore) await changeModel(extracted.currentModel, 1500).catch(() => {});
      }
    }
    const cleanedModels = probedModels
      .filter(model => safeCatalogText(publicModelId(id, model.id)))
      .map(({ hasExplicitEfforts, ...model }) => ({
        ...model, id: publicModelId(id, model.id), slug: publicModelId(id, model.slug),
      }));
    const mergedEfforts = [...new Set([...extracted.efforts, ...cleanedModels.flatMap(m => m.efforts)])];
    return {
      ok: true,
      protocol: "acp",
      binaryPath: child.binaryPath,
      agentInfo: initialized.agentInfo || { name: String(command), version: "detected" },
      capabilities: initialized.capabilities || {},
      defaultModel: safeCatalogText(publicModelId(id, extracted.defaultModel)),
      models: cleanedModels,
      modes: extracted.modes,
      efforts: mergedEfforts,
      effortOptionId: extracted.effortOptionId,
    };
  } catch (err) {
    return { ok: false, protocol: "acp", binaryPath: child?.binaryPath || null, ...classifyAcpError(err, initialized, command) };
  } finally {
    if (session) await closeAcpSession(child.rpc, session.sessionId, initialized.capabilities, true);
    await child?.close();
  }
}

/** Generic ACP ladder (plan / default / auto / full-access); foreign "skip everything" values never unlock full access. */
export function normalizeGenericPermission(provider, permissionMode) {
  return normalizePermissionModeForProvider(provider || "generic", permissionMode, { fallback: "default", strictReadOnly: false });
}

export function mapGenericModeFromPermission(permissionMode, interactionMode, availableModes = []) {
  const inter = String(interactionMode || "").trim().toLowerCase();
  const perm = String(permissionMode || "").trim().toLowerCase();

  const pickIfAvailable = candidates => candidates.find(mode => availableModes?.includes(mode));
  const guarded = ["default", "guarded", "manual", "ask"];
  const build = ["build", "code", "agent", "edit"];

  if (inter === "plan" || perm === "plan") {
    return pickIfAvailable(["plan"]);
  }
  if (perm === "full-access" || perm === "yolo" || perm === "danger-full-access") {
    return pickIfAvailable(["full-access", "yolo", "auto", "accept-edits", ...build, ...guarded]);
  }
  if (perm === "auto" || perm === "workspace-write") {
    return pickIfAvailable(["auto", "accept-edits", ...build, ...guarded]);
  }
  if (perm === "auto-accept-edits" || perm === "accept-edits") {
    return pickIfAvailable(["accept-edits", "edit", ...guarded, ...build]);
  }
  return pickIfAvailable([...guarded, ...build]);
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
  const rawArgs = parseArgsInput(providerConfig.args ?? (provider === "dsh" ? ["--profile", "acp"] : ["acp"]));
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

  function reportEffectiveModel(fallback) {
    const raw = configOptions?.find(o => o.id === "model" || o.category === "model")?.currentValue;
    const selected = safeCatalogText(publicModelId(provider, fallback ?? raw));
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
        if ((provider === "dsh" && planning) || !onPermissionRequest) return { outcome: mapAcpPermissionOutcome(undefined, options) };
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
      id: provider, cwd, handlers, candidatePaths: providerConfig.candidatePaths ?? providerConfig.extraCandidatePaths,
      env: dshEnv(provider, providerConfig.env, planning ? "read-only" : autoApprove ? "danger-full-access" : "workspace-write"),
      envOptions: extensionEnvOptions(provider, providerConfig),
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
        allowNewSessionFallback: provider === "dsh" && Boolean(freshSessionPrompt),
      });
      openedSession = true;
      boundSessionId = opened.sessionId;
      const sessionRes = opened.sessionData;

      emit({
        type: "session_bound",
        initHandshakeMs,
        nativeSessionId: ephemeral ? undefined : boundSessionId,
        sessionId: ephemeral ? undefined : boundSessionId,
        resumed: opened.resumed && boundSessionId === resumeSessionId,
      });

      configOptions ??= flattenAcpConfigOptions(sessionRes.configOptions);

      // 1. Apply model selection (prefer configOption 'model', fallback 'session/set_model')
      let appliedModel;
      if (model && !isExtensionDefaultModel(provider, model)) {
        const modelOpt = configOptions.find((o) => o?.id === "model" || o?.category === "model");
        const target = provider === "dsh"
          ? resolveDshModel(String(model), extractModelsAndOptionsFromAcpSession({ ...sessionRes, configOptions }, provider))
          : model;
        const switchError = () => Object.assign(new Error("ACP 引擎未能切换到指定模型。"), { code: "ACP_MODEL_SWITCH_FAILED" });
        if (!target) throw switchError();
        let modelApplied = (modelOpt?.currentValue ?? sessionRes.models?.currentModelId) === target;
        if (!modelApplied) {
          if (modelOpt?.id) {
            try {
              const before = configOptions;
              const r = await rpc.request("session/set_config_option", {
                sessionId: boundSessionId,
                configId: modelOpt.id,
                value: target,
              }, 5000);
              if (configOptions === before && Array.isArray(r?.configOptions)) configOptions = flattenAcpConfigOptions(r.configOptions);
              const reported = configOptions.find(o => o.id === modelOpt.id)?.currentValue;
              modelApplied = !Array.isArray(r?.configOptions) || !reported || reported === target;
            } catch {}
          }
          if (!modelApplied) {
            try {
              await rpc.request("session/set_model", { sessionId: boundSessionId, modelId: target }, 5000);
            } catch {
              throw switchError();
            }
          }
        }
        appliedModel = target;
      }

      // 2. Apply effort / thinking level if supported
      if (effort && !isInheritedEffort(effort)) {
        const effOpt = configOptions.find(
          (o) =>
            o?.id === "thinking" ||
            o?.id === "thought_level" ||
            o?.id === "effort" ||
            o?.id === "reasoning_effort" ||
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
      if (planning && !targetMode && provider !== "dsh") {
        throw Object.assign(new Error("该 ACP 引擎未提供规划模式，未发送任务。"), { code: "ACP_PLAN_MODE_UNSUPPORTED" });
      }
      if (!planning && !targetMode && (meta.modes.length || currentMode === "plan")) {
        throw new Error("该 ACP 引擎未提供相容的权限模式，未发送任务。");
      }
      if (targetMode && currentMode !== targetMode) {
        if (modeOpt) {
          const response = await rpc.request("session/set_config_option", {
            sessionId: boundSessionId,
            configId: modeOpt.id,
            value: targetMode,
          }, 5000);
          const reported = response?.configOptions?.find(option => option.id === modeOpt.id)?.currentValue;
          if (reported && reported !== targetMode) throw new Error("该 ACP 引擎未应用指定权限模式，未发送任务。");
        } else {
          await rpc.request("session/set_mode", {
            sessionId: boundSessionId,
            modeId: targetMode,
          }, 5000);
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

      reportEffectiveModel(appliedModel ?? configOptions.find(o => o.id === "model" || o.category === "model")?.currentValue ?? sessionRes.models?.currentModelId);
      promptSent = true;
      const requestedPrompt = resolveSessionPrompt(prompt, freshSessionPrompt, opened.resumed);
      const promptText = provider === "dsh" && planning
        ? "本轮为只读规划。仅分析与提出计划，不得修改文件或执行有副作用的操作。\n\n" + requestedPrompt : requestedPrompt;
      const promptRes = await rpc.request("session/prompt", {
        sessionId: boundSessionId,
        prompt: [{ type: "text", text: promptText }],
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

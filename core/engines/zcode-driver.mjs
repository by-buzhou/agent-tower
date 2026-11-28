import { randomUUID } from "node:crypto";
import { isInheritedEffort, normalizeEffortForTarget, permissionTierOf } from "../catalog.mjs";
import { resolveSessionPrompt } from "../spec-context.mjs";
import { ensureMainRoot, nativePath } from "../storage-paths.mjs";
import {
  buildCleanChildEnv, classifyEngineError, extensionEnvOptions, gracefulCancelWithEscalation,
  isEngineAuthenticationError, isExtensionDefaultModel, isMethodNotFoundError, isMissingSessionError,
  mapAcpPermissionOutcome, normalizeTokenLimit, resolveZCodeBinary, safeCatalogText, safeEngineError, settleTurnWithClose, startRpcProcess,
} from "./proc-utils.mjs";

const modesByTier = { plan: "plan", ask: "guarded", edits: "edit", auto: "build", full: "yolo" };
const capabilities = { sessionCapabilities: { resume: true, delete: false } };
const workspaceFor = cwd => ({ workspacePath: cwd, workspaceKey: cwd });
const snapshotOf = response => response?.snapshot ?? response;
const sessionIdOf = snapshot => snapshot?.session?.sessionId ?? snapshot?.sessionId;
const currentModelOf = snapshot => snapshot?.session?.model ?? snapshot?.settings?.model?.current;
const modelSlug = ref => ref?.providerId && ref?.modelId ? ref.providerId + "/" + ref.modelId : ref?.modelId || "";
const sameModel = (left, right) => !!left?.modelId && left.modelId === right?.modelId && left.providerId === right?.providerId;
const modelEntries = snapshot => Array.isArray(snapshot?.settings?.model?.available) ? snapshot.settings.model.available : [];
const modelContextWindow = entry => normalizeTokenLimit(entry?.contextWindow ?? entry?.maxContextTokens ?? entry?.limits?.contextWindow);
const valuesOf = options => Array.isArray(options)
  ? options.map(option => safeCatalogText(option?.value ?? option?.id ?? option)).filter(Boolean) : [];

function reasoningLevels(entry, currentLevels) {
  const levels = entry?.reasoning?.levels ?? currentLevels;
  return Array.isArray(levels) ? valuesOf(levels) : undefined;
}

function modelsOf(snapshot, provider) {
  return modelEntries(snapshot).flatMap(entry => {
    const slug = safeCatalogText(modelSlug(entry?.ref));
    if (!slug) return [];
    const contextWindow = modelContextWindow(entry);
    const maxOutputTokens = normalizeTokenLimit(entry.maxOutputTokens ?? entry.limits?.maxOutputTokens);
    const group = safeCatalogText(entry.providerLabel ?? entry.ref?.providerId);
    const isDefault = sameModel(entry.ref, currentModelOf(snapshot));
    const efforts = reasoningLevels(entry, isDefault ? snapshot.settings?.thoughtLevel?.available : undefined);
    return [{
      id: slug, slug, provider, name: safeCatalogText(entry.label) || slug,
      description: safeCatalogText(entry.description),
      ...(group ? { group } : {}),
      contextWindow,
      ...(maxOutputTokens > 0 ? { maxOutputTokens } : {}),
      enabled: !entry.disabledReason, locked: false,
      isDefault,
      ...(efforts ? { efforts } : {}), defaultEffort: safeCatalogText(entry.reasoning?.defaultLevel),
    }];
  });
}

function modelReference(snapshot, model) {
  const entries = modelEntries(snapshot);
  const matches = entries.filter(entry =>
    model === modelSlug(entry.ref) || model === entry.ref?.modelId || model === entry.label);
  const ref = (matches.find(entry => sameModel(entry.ref, currentModelOf(snapshot))) ?? matches[0])?.ref;
  if (ref) return { providerId: ref.providerId, modelId: ref.modelId };
  const slash = model.indexOf("/");
  const providerId = currentModelOf(snapshot)?.providerId;
  if (slash > 0 && (!providerId || entries.some(entry => entry.ref?.providerId === model.slice(0, slash)))) {
    return { providerId: model.slice(0, slash), modelId: model.slice(slash + 1) };
  }
  return providerId ? { providerId, modelId: model } : undefined;
}

function startZCode(config, cwd) {
  const bin = resolveZCodeBinary(config.candidatePaths ?? config.extraCandidatePaths, config.command);
  if (!bin.available) throw new Error("未找到 ZCode CLI 或桌面安装包。");
  const args = config.args ?? ["app-server", "--stdio"];
  const argv = Array.isArray(args) ? args.map(String) : String(args).trim().split(/\s+/).filter(Boolean);
  const env = buildCleanChildEnv({ ...bin.env, ...config.env }, extensionEnvOptions("zcode", config));
  let stderr = "";
  const onStderr = chunk => { stderr = (stderr + chunk).slice(0, 8192); };
  return {
    ...startRpcProcess(bin.command, [...bin.prefixArgs, ...argv], { cwd, env, onStderr, omitJsonRpcVersion: true }),
    binaryPath: bin.resolvedPath, onStderr, diagnostic: () => stderr,
  };
}

function zcodeError(err, diagnostic) {
  const detail = safeEngineError(err);
  const stderr = safeEngineError(diagnostic, "");
  if (err?.code === "ZCODE_MODEL_SWITCH_FAILED") {
    return { error: detail, code: err.code, category: "validation_error", isRetryable: false };
  }
  if (isEngineAuthenticationError(detail) || isEngineAuthenticationError(stderr) || /not signed in|sign.in required/i.test(detail)) {
    return { error: "ZCode 需要登录。请在终端运行 zcode 完成认证后重试。", code: "ZCODE_AUTH_REQUIRED", category: "permission_error", isRetryable: false };
  }
  const error = /stdout closed|process exited|RPC timeout/i.test(detail) && stderr ? stderr : detail;
  return { error, ...classifyEngineError(error, err?.rpcCode) };
}

export async function probeZCodeProvider({ id = "zcode", cwd, timeoutMs = 8000, ...config } = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  let child, sessionId;
  try {
    child = startZCode(config, cwd);
    const snapshot = snapshotOf(await child.rpc.request("session/create", {
      workspace: workspaceFor(cwd), mode: "plan", persistence: "deferred", titleGenerationEnabled: false,
    }, Math.max(8000, Number(timeoutMs) || 0)));
    sessionId = sessionIdOf(snapshot);
    if (!sessionId) throw new Error("ZCode 未返回有效的 sessionId。");
    return {
      ok: true, protocol: "zcode", binaryPath: child.binaryPath, capabilities,
      agentInfo: { name: "ZCode", version: safeCatalogText(String(snapshot.protocol?.version ?? "detected")) },
      defaultModel: safeCatalogText(modelSlug(currentModelOf(snapshot))), models: modelsOf(snapshot, id),
      modes: valuesOf(snapshot.settings?.mode?.available).length
        ? valuesOf(snapshot.settings.mode.available) : Object.values(modesByTier),
      efforts: valuesOf(snapshot.settings?.thoughtLevel?.available),
    };
  } catch (err) {
    return { ok: false, protocol: "zcode", binaryPath: child?.binaryPath || null, ...zcodeError(err, child?.diagnostic()) };
  } finally {
    if (sessionId) await child.rpc.request("session/close", { sessionId }, 1500).catch(() => {});
    await child?.close();
  }
}

export function runZCodeTurn({
  runId, threadId, provider = "zcode", providerConfig = {}, model, effort, permissionMode = "auto",
  interactionMode = "default", cwd, nativeSessionId, prompt = "", freshSessionPrompt, ephemeral = false,
  asyncTeardown = true, onEvent, onPermissionRequest, onQuestionRequest,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const requestedTier = permissionTierOf(permissionMode);
  const full = /^(?:full-access|yolo|danger-full-access)$/i.test(String(permissionMode).trim());
  const tier = String(interactionMode).trim().toLowerCase() === "plan"
    ? "plan" : requestedTier === "full" && !full ? "auto" : requestedTier;
  const mode = Object.hasOwn(modesByTier, tier) ? modesByTier[tier] : "guarded";
  const workspace = workspaceFor(cwd);
  const inputId = randomUUID();
  const pending = new Map(), tools = new Map();
  const resumeId = ephemeral ? undefined : nativeSessionId;
  let child, rpc, sessionId, effectiveModel, selectedModelEntry, usage, turnId;
  let assistantText = "", reasoningText = "";
  let cancelled = false, settled = false, sending = false;
  const terminal = Promise.withResolvers();
  const emit = event => {
    try { onEvent?.({ runId, threadId, provider, timestamp: Date.now(), ...event }); } catch {}
  };
  const interrupt = () => ({ status: "interrupted", stopReason: "cancelled" });
  const clearRequests = () => { for (const finish of pending.values()) finish(null); };

  function ask(rpcId, payload, callback) {
    if (!callback) return null;
    const requestId = "zcode_" + (runId || provider) + "_" + rpcId;
    return new Promise(resolve => {
      const finish = answer => { pending.delete(requestId); resolve(answer); };
      pending.set(requestId, finish);
      try {
        const direct = callback({ requestId, runId, threadId, provider, ...payload });
        // A synchronous void callback registers the request for a later respond* call.
        if (direct !== undefined) Promise.resolve(direct).then(finish, () => finish(null));
      } catch { finish(null); }
    });
  }

  async function onServerRequest(method, params, rpcId) {
    const active = sending && !settled && !cancelled && params?.sessionId === sessionId;
    if (method === "interaction/requestPermission") {
      if (!active || mode === "plan") return { decision: "deny" };
      const options = Array.isArray(params.options) ? params.options.map(option => ({
        ...option, optionId: option.optionId ?? option.kind,
      })) : [];
      const direct = mode === "yolo" && options.some(option => /^allow[-_]once$/.test(option.kind)) ? "allow" : undefined;
      const decision = direct ?? await ask(rpcId, {
        kind: "permission", title: params.toolName || "ZCode Permission Request", toolCallId: params.toolCallId,
        options: options.map(({ optionId, kind, name }) => ({ optionId, kind, name })), preview: params.input,
      }, onPermissionRequest);
      const selection = mapAcpPermissionOutcome(decision, options);
      const option = options.find(item => item.optionId === selection.optionId);
      if (cancelled || settled || !/^allow(?:[-_](?:once|always))?$/.test(option?.kind ?? "")) return { decision: "deny" };
      return option.response ?? { decision: "allow" };
    }
    if (method === "interaction/requestUserInput") {
      if (!active || params.schema?.interaction === "plan_approval") return { action: "decline" };
      const answers = await ask(rpcId, {
        message: params.message || "", questions: params.questions, schema: params.requestedSchema ?? params.schema,
      }, onQuestionRequest);
      return answers && !answers.cancelled && !cancelled && !settled
        ? { action: "accept", content: answers.content ?? { answers: answers.answers ?? answers } } : { action: "decline" };
    }
    // This includes credential-header and browser requests. Undefined yields -32601.
    return undefined;
  }

  function publishTool(update) {
    const id = update?.toolCallId;
    if (!id) return;
    const toolName = update.toolName || tools.get(id)?.toolName || "tool";
    const status = update.kind === "error" || update.isError ? "failed"
      : update.kind === "result" ? "completed" : "in_progress";
    const tool = { ...tools.get(id), type: "tool_call", id, toolCallId: id, toolName, name: toolName, status };
    if (update.input !== undefined) tool.input = update.input;
    const output = update.output ?? update.result ?? update.stderrTail ?? update.stdoutTail;
    if (output !== undefined) tool.output = output;
    tools.set(id, tool);
    emit(tool);
  }

  function onNotification(method, params) {
    if (!sending || settled || method !== "session/event" || params?.sessionId !== sessionId) return;
    const payload = params.payload ?? {};
    const type = params.type ?? payload.type;
    if ((params.inputId ?? payload.inputId) && (params.inputId ?? payload.inputId) !== inputId) return;
    const eventTurnId = params.turnId ?? payload.turnId;
    if (type === "turn.started") turnId ??= eventTurnId;
    if (turnId && eventTurnId && turnId !== eventTurnId) return;
    if (type === "model.streaming" && typeof payload.delta === "string") {
      if (payload.kind === "text_delta") {
        assistantText += payload.delta;
        emit({ type: "message_delta", text: payload.delta, delta: payload.delta, phase: "final_answer" });
      } else if (payload.kind === "reasoning_delta") {
        reasoningText += payload.delta;
        emit({ type: "reasoning_delta", text: payload.delta, delta: payload.delta });
      }
    } else if (type === "tool.updated" || type === "model.streaming" && payload.kind === "tool_call") {
      if (payload.kind === "batch" && Array.isArray(payload.results)) payload.results.forEach(publishTool);
      else publishTool(payload);
    } else if (type === "turn.completed" || type === "turn.failed") {
      terminal.resolve({ type, payload });
    } else if (type === "session.titleUpdated" && safeCatalogText(payload.title)) {
      emit({ type: "title_updated", title: safeCatalogText(payload.title) });
    }
  }

  const rawResult = (async () => {
    try {
      child = startZCode(providerConfig, cwd);
      rpc = child.rpc;
      rpc.setHandlers({ onNotification, onServerRequest, onStderr: child.onStderr });
      let snapshot, resumed = false;
      if (resumeId) {
        try {
          snapshot = snapshotOf(await rpc.request("session/resume", { sessionId: resumeId, workspace }, 15000));
          resumed = Boolean(sessionIdOf(snapshot));
        } catch (err) {
          if (err.rpcCode !== -32004 && !isMethodNotFoundError(err) && !isMissingSessionError(err)) throw err;
        }
      }
      if (!resumed && !cancelled) {
        snapshot = snapshotOf(await rpc.request("session/create", { workspace, mode, persistence: "deferred" }, 15000));
      }
      sessionId = sessionIdOf(snapshot);
      if (cancelled) return interrupt();
      if (!sessionId) throw new Error("ZCode 未返回有效的 sessionId。");
      emit({ type: "session_bound", nativeSessionId: ephemeral ? undefined : sessionId,
        sessionId: ephemeral ? undefined : sessionId, resumed });
      await rpc.request("session/subscribe", { sessionId, deliveryKind: "desktop-continuous" }, 10000);
      if (cancelled) return interrupt();
      const modeResult = snapshotOf(await rpc.request("session/setMode", { sessionId, mode }, 5000));
      const reportedMode = modeResult?.settings?.mode?.current ?? modeResult?.session?.mode;
      const planEnabled = modeResult?.session?.planEnabled;
      // ZCode represents plan as an overlay on the underlying execution mode.
      if (modeResult?.ok === false || (mode === "plan" && planEnabled === false) ||
          (reportedMode && reportedMode !== mode && !(mode === "plan" && (planEnabled === true || reportedMode === "build")))) {
        throw new Error("ZCode 引擎未能切换到指定权限模式。");
      }
      let sessionLevels = snapshot.settings?.thoughtLevel?.available;
      if (!isExtensionDefaultModel(provider, model)) {
        try {
          const ref = modelReference(snapshot, String(model));
          if (!ref) throw new Error("Unknown model provider");
          const changed = snapshotOf(await rpc.request("session/setModel", { sessionId, model: ref }, 5000));
          const actual = currentModelOf(changed);
          if (changed?.ok === false || actual?.modelId && !sameModel(ref, actual)) throw new Error("Model not applied");
          selectedModelEntry = modelEntries(changed).find(entry => sameModel(entry.ref, actual || ref))
            ?? modelEntries(snapshot).find(entry => sameModel(entry.ref, actual || ref));
          sessionLevels = changed?.settings?.thoughtLevel?.available ?? (sameModel(ref, currentModelOf(snapshot)) ? sessionLevels : undefined);
          effectiveModel = safeCatalogText(modelSlug(ref));
        } catch {
          throw Object.assign(new Error("ZCode 引擎未能切换到指定模型。"), { code: "ZCODE_MODEL_SWITCH_FAILED" });
        }
      } else {
        const currentRef = currentModelOf(snapshot);
        selectedModelEntry = modelEntries(snapshot).find(entry => sameModel(entry.ref, currentRef));
        effectiveModel = safeCatalogText(modelSlug(currentRef)) || undefined;
      }
      if (cancelled) return interrupt();
      if (effort && !isInheritedEffort(effort)) {
        const allowedLevels = reasoningLevels(selectedModelEntry, sessionLevels);
        const chosenEffort = allowedLevels === undefined
          ? effort
          : allowedLevels.length === 0
            ? undefined
            : normalizeEffortForTarget(provider, effectiveModel, effort, allowedLevels);
        if (chosenEffort) {
          await rpc.request("session/setThoughtLevel", { sessionId, thoughtLevel: chosenEffort }, 5000);
        }
      }
      if (cancelled) return interrupt();
      if (effectiveModel) emit({ type: "effective_model", effectiveModel });
      if (cancelled) return interrupt();
      sending = true;
      const sent = await rpc.request("session/send", {
        sessionId, inputId, content: resolveSessionPrompt(prompt, freshSessionPrompt, resumed),
      }, 15000);
      if (sent?.accepted === false) throw new Error("ZCode 拒绝了本轮任务。");
      const end = await Promise.race([terminal.promise, child.exited.then(() => null)]);
      if (cancelled || end?.payload?.stopReason === "cancelled") return interrupt();
      if (!end) throw new Error("ZCode process exited before the turn completed");
      if (end.type === "turn.failed") throw Object.assign(new Error(end.payload?.error?.message || "ZCode turn failed"), {
        rpcCode: end.payload?.error?.code,
      });
      usage = end.payload?.usage;
      if (usage) {
        const contextLimit = normalizeTokenLimit(usage.contextLimit) || modelContextWindow(selectedModelEntry);
        if (contextLimit || usage.contextLimit !== undefined) usage = { ...usage, contextLimit };
      }
      if (usage) emit({ type: "usage_updated", usage });
      return { status: "completed", stopReason: end.payload?.stopReason || "end_turn" };
    } catch (err) {
      if (cancelled) return interrupt();
      const classification = zcodeError(err, child?.diagnostic());
      emit({ type: "error", message: classification.error, ...classification });
      return { status: "failed", stopReason: "error", ...classification };
    } finally {
      settled = true;
    }
  })().then(value => ({ ...value, nativeSessionId: ephemeral ? undefined : sessionId, effectiveModel, assistantText, reasoningText, usage }));

  const { result, closed } = settleTurnWithClose(rawResult, async () => {
    clearRequests();
    try {
      if (sessionId) await rpc.request("session/close", { sessionId }, 1500).catch(() => {});
    } finally { await child?.close(); }
  }, emit, asyncTeardown);

  return {
    result, closed,
    async cancel() {
      if (settled || cancelled) return;
      cancelled = true;
      clearRequests();
      await gracefulCancelWithEscalation(child?.proc, () => {
        if (sending) return rpc.request("session/stop", { sessionId }, 1000);
      }, () => settled, 2000, child?.kill);
    },
    async forceKill() { cancelled = true; clearRequests(); await child?.kill(); },
    async steer() { return { supported: false }; },
    async respondPermission(id, decision) { pending.get(id)?.(decision); },
    async respondQuestion(id, answers) { pending.get(id)?.(answers); },
  };
}

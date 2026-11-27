import { resolveSessionPrompt } from "../spec-context.mjs";
import { createInterface } from "node:readline";
import * as crypto from "node:crypto";
import { assertReadOnlySupport, isInheritedEffort, isInheritedModel, normalizePermissionModeForProvider } from "../catalog.mjs";
import { ensureMainRoot, nativePath } from "../storage-paths.mjs";
import { binaryFingerprint, captureNoWindow, spawnNoWindow, buildCleanChildEnv, classifyEngineError, forceKillProcessTree, resolveClaudeBinary, safeCatalogText, safeEngineError } from "./proc-utils.mjs";

const CLAUDE_CLI_MODES = new Set(["plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]);
const HEARTBEAT_INTERVAL_MS = 5000;
const GRACEFUL_CANCEL_MS = 1500;
const ALLOW_DECISIONS = new Set(["approve_once", "approve", "allow", "allow_once", "accept", "approve_always", "allow_always"]);
const strictMcpProbeCache = new Map();

function probeStrictMcpFlag(bin, cwd) {
  const fingerprint = binaryFingerprint(bin);
  let entry = strictMcpProbeCache.get(fingerprint);
  if (!entry) {
    entry = { supported: false };
    entry.pending = captureNoWindow(bin.command, [...(bin.prefixArgs || []), "--help"], {
      cwd, env: buildCleanChildEnv(bin.env), timeoutMs: 1500, detached: process.platform !== "win32",
    }).then(({ stdout, stderr }) => {
      entry.supported = (stdout + "\n" + stderr).includes("--strict-mcp-config");
      return entry.supported;
    }, () => false);
    strictMcpProbeCache.set(fingerprint, entry);
    while (strictMcpProbeCache.size > 32) strictMcpProbeCache.delete(strictMcpProbeCache.keys().next().value);
  }
  return entry.pending;
}

// Existing synchronous callers can inspect the last probe result without spawning.
export function supportsStrictMcpFlag(binaryPath) {
  const bin = /\.(?:mjs|cjs|js)$/i.test(binaryPath)
    ? { command: process.execPath, prefixArgs: [binaryPath], resolvedPath: binaryPath }
    : { command: binaryPath, prefixArgs: [], resolvedPath: binaryPath };
  return strictMcpProbeCache.get(binaryFingerprint(bin))?.supported ?? false;
}

/**
 * Map a requested permission to Claude Code's native `--permission-mode`.
 * `auto` stays Claude's classifier-reviewed `auto`; only explicit bypassPermissions / full-access / yolo /
 * danger-full-access unlock `bypassPermissions`. Unknown values land on `default` (ask).
 */
export function resolveClaudePermissionMode(permissionMode, interactionMode) {
  if (String(interactionMode || "").trim().toLowerCase() === "plan" || String(permissionMode || "").trim().toLowerCase() === "plan") return "plan";
  const mode = normalizePermissionModeForProvider("claude-code", permissionMode, { fallback: "default" });
  if (mode === "read-only") assertReadOnlySupport("claude-code", mode);
  return CLAUDE_CLI_MODES.has(mode) ? mode : "default";
}

export function buildClaudeArgs({ prefixArgs = [], mode, model, effort, nativeSessionId, ephemeral } = {}) {
  const args = [...prefixArgs, "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--include-partial-messages", "--permission-mode", mode];
  // Route approval prompts to the panel (control_request can_use_tool) only in the ask-first mode.
  if (mode === "default") args.push("--permission-prompts", "host");
  if (model && !isInheritedModel(model)) args.push("--model", model);
  if (effort && !isInheritedEffort(effort) && /^(low|medium|high|xhigh|max)$/.test(effort)) args.push("--effort", effort);
  if (nativeSessionId) args.push(`--resume=${nativeSessionId}`);
  if (ephemeral === true) args.push("--no-session-persistence");
  return args;
}

const userFrame = text => ({ type: "user", message: { role: "user", content: [{ type: "text", text: String(text ?? "") }] } });

function toolKind(name) {
  return /^(Bash|Shell|Terminal)$/i.test(name) ? "execute" : /edit|write|patch|delete|move/i.test(name) ? "edit" :
    /^(Read|Glob|Grep|LS|WebSearch|WebFetch)$/i.test(name) ? "read" : "other";
}

function decisionOf(payload) {
  if (payload && typeof payload === "object") {
    if (payload.cancelled) return "cancel";
    return String(payload.decision ?? payload.action ?? payload.optionId ?? "").trim().toLowerCase();
  }
  return String(payload === true ? "approve_once" : payload ?? "").trim().toLowerCase();
}

export function runClaudeTurn(opts = {}) {
  const { permissionMode, interactionMode, resolveBinary = resolveClaudeBinary, inheritHostMcp,
    options, params, strictMcpSupport } = opts;
  assertReadOnlySupport("claude-code", permissionMode);
  const mode = resolveClaudePermissionMode(permissionMode, interactionMode);
  const bin = resolveBinary();
  const cwd = nativePath(opts.cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const start = strict => startClaudeTurn({ ...opts, cwd }, bin, mode, strict);
  if (inheritHostMcp === true || options?.inheritHostMcp === true || params?.inheritHostMcp === true) return start(false);
  const supported = strictMcpSupport ? strictMcpSupport(bin) : probeStrictMcpFlag(bin, cwd);
  if (typeof supported === "boolean") return start(supported);

  let cancelled = false, handle;
  const result = Promise.resolve(supported).then((strict) => {
    if (cancelled) return { status: "interrupted", stopReason: "cancelled" };
    handle = start(strict);
    return handle.result;
  }).catch(error => {
    const detail = safeEngineError(error);
    const classification = classifyEngineError(error);
    try { opts.onEvent?.({ type: "error", runId: opts.runId, threadId: opts.threadId, provider: "claude-code",
      timestamp: Date.now(), message: detail, error: detail, ...classification }); } catch {}
    return { status: "failed", stopReason: "error", error: detail, ...classification };
  });
  return {
    result,
    closed: result.then(() => handle?.closed),
    async cancel() { cancelled = true; if (handle) await handle.cancel(); },
    async forceKill() { cancelled = true; if (handle) await handle.forceKill(); },
    async steer(text) { return handle ? handle.steer(text) : { supported: false }; },
    async respondPermission(id, decision) { return handle?.respondPermission(id, decision); },
    async respondQuestion(id, answers) { return handle?.respondQuestion(id, answers); },
  };
}

function startClaudeTurn({ runId, threadId, model, effort, cwd, nativeSessionId, ephemeral, prompt,
  freshSessionPrompt, onEvent, onPermissionRequest, onQuestionRequest }, bin, mode, strictSupported) {
  const args = buildClaudeArgs({ prefixArgs: bin.prefixArgs, mode, model, effort, nativeSessionId, ephemeral });
  if (strictSupported && !args.includes("--strict-mcp-config")) args.push("--strict-mcp-config");
  const processGroup = process.platform !== "win32";
  const proc = spawnNoWindow(bin.command, args, {
    cwd,
    env: buildCleanChildEnv(bin.env), stdio: ["pipe", "pipe", "pipe"], detached: processGroup,
  });
  const emit = event => { try { onEvent?.({ runId, threadId, provider: "claude-code", timestamp: Date.now(), ...event }); } catch {} };
  const tools = new Map();
  // panelRequestId -> { requestId (Claude's), input, kind }
  const pendingRequests = new Map();
  // Partial-message bookkeeping: messageId -> [{ type, text, consumed }]
  const streamedByMessage = new Map();
  const currentStream = new Map(); // parent_tool_use_id key -> { messageId, blocks: Map<index, entry> }
  let cancelRequested = false, bound = false, exited = false, stdinClosed = false, sessionId = nativeSessionId;
  let effectiveModel, finalEvent, spawnError, stderr = "", lastHeartbeatAt = Date.now(), syntheticSeq = 0;
  let assistantText = "", reasoningText = "", stopPromise, drainTimer;

  const stdinWritable = () => !exited && !stdinClosed && proc.stdin && !proc.stdin.destroyed && proc.stdin.writable;
  const writeFrame = frame => {
    if (!stdinWritable()) return false;
    try { proc.stdin.write(`${JSON.stringify(frame)}\n`); return true; } catch { return false; }
  };
  const closeStdin = () => {
    if (stdinClosed) return;
    stdinClosed = true;
    try { if (proc.stdin && !proc.stdin.destroyed) proc.stdin.end(); } catch {}
  };
  const writeControlResponse = (requestId, response) => writeFrame({
    type: "control_response", response: { subtype: "success", request_id: requestId, response },
  });
  const denyAllPending = (message, interrupt) => {
    for (const [panelId, pending] of pendingRequests) {
      pendingRequests.delete(panelId);
      writeControlResponse(pending.requestId, { behavior: "deny", message, interrupt });
    }
  };

  const bind = id => {
    if (!id || (id === sessionId && bound)) return;
    sessionId = id;
    bound = true;
    emit({ type: "session_bound", nativeSessionId: id, sessionId: id, resumed: id === nativeSessionId });
  };
  const reportModel = value => {
    const actual = safeCatalogText(value);
    if (!actual || actual === effectiveModel || actual === "<synthetic>") return;
    effectiveModel = actual;
    emit({ type: "effective_model", effectiveModel });
  };

  function respondPermissionNow(panelId, payload) {
    const pending = pendingRequests.get(panelId) ||
      [...pendingRequests.values()].find(p => p.requestId === panelId);
    if (pending?.kind !== "permission") return false;
    pendingRequests.delete(pending.panelId);
    const d = decisionOf(payload);
    if (!ALLOW_DECISIONS.has(d)) {
      return writeControlResponse(pending.requestId, {
        behavior: "deny", message: payload?.feedback || "Denied by user", interrupt: d === "cancel" || d === "cancelled",
      });
    }
    return writeControlResponse(pending.requestId, { behavior: "allow", updatedInput: pending.input });
  }

  function respondQuestionNow(panelId, answers) {
    const pending = pendingRequests.get(panelId) ||
      [...pendingRequests.values()].find(p => p.requestId === panelId);
    if (pending?.kind !== "question") return false;
    pendingRequests.delete(pending.panelId);
    if (!answers || answers.cancelled) {
      return writeControlResponse(pending.requestId, { behavior: "deny", message: "User declined to answer", interrupt: false });
    }
    return writeControlResponse(pending.requestId, { behavior: "allow", updatedInput: { ...pending.input, answers } });
  }

  function handleControlRequest(event) {
    if (!stdinWritable() || cancelRequested) return;
    const requestId = event.request_id;
    const request = event.request || {};
    if (!requestId || [...pendingRequests.values()].some(p => p.requestId === requestId)) return;
    if (request.subtype !== "can_use_tool") {
      writeFrame({ type: "control_response", response: { subtype: "error", request_id: requestId,
        error: `Unsupported control request: ${String(request.subtype || "unknown")}` } });
      return;
    }
    const toolName = String(request.tool_name || "tool");
    const input = request.input && typeof request.input === "object" ? request.input : {};
    const isQuestion = toolName === "AskUserQuestion";
    const handler = isQuestion ? onQuestionRequest : onPermissionRequest;
    if (typeof handler !== "function") {
      writeControlResponse(requestId, { behavior: "deny", message: isQuestion ? "No question handler is attached" : "No approval handler is attached", interrupt: false });
      return;
    }
    const panelId = `claude_${runId || "run"}_${String(requestId).replace(/[^\w-]/g, "").slice(0, 40)}_${crypto.randomUUID().slice(0, 8)}`;
    pendingRequests.set(panelId, { panelId, requestId, input, kind: isQuestion ? "question" : "permission" });
    const payload = isQuestion
      ? { requestId: panelId, runId, threadId, provider: "claude-code", kind: "question", title: "Claude 提问",
        questions: Array.isArray(input.questions) ? input.questions : [], toolCallId: request.tool_use_id, rawInput: input }
      : { requestId: panelId, runId, threadId, provider: "claude-code", kind: "permission", title: `允许执行 ${toolName}`,
        toolName, toolCallId: request.tool_use_id, command: input.command,
        filePaths: input.file_path ? [input.file_path] : undefined, rawInput: input };
    Promise.resolve().then(() => pendingRequests.has(panelId) ? handler(payload) : undefined).then(direct => {
      if (direct === undefined || !pendingRequests.has(panelId)) return;
      if (isQuestion) respondQuestionNow(panelId, direct);
      else respondPermissionNow(panelId, direct);
    }).catch(() => {
      if (!pendingRequests.has(panelId)) return;
      if (isQuestion) respondQuestionNow(panelId, null);
      else respondPermissionNow(panelId, "reject");
    });
  }

  const streamKey = (parent, id) => JSON.stringify([parent, id]);
  function handleStreamEvent(event) {
    const inner = event.event || {};
    const key = String(event.parent_tool_use_id || "");
    if (inner.type === "message_start") {
      const messageId = streamKey(key, inner.message?.id || `synthetic_${++syntheticSeq}`);
      if (!event.parent_tool_use_id) reportModel(inner.message?.model);
      currentStream.set(key, { messageId, blocks: new Map() });
      if (!streamedByMessage.has(messageId)) streamedByMessage.set(messageId, []);
      return;
    }
    let cur = currentStream.get(key);
    if (!cur && (inner.type === "content_block_start" || inner.type === "content_block_delta")) {
      const messageId = streamKey(key, `synthetic_${++syntheticSeq}`);
      cur = { messageId, blocks: new Map() };
      currentStream.set(key, cur);
      streamedByMessage.set(messageId, []);
    }
    if (!cur) return;
    const list = streamedByMessage.get(cur.messageId);
    const blockFor = (index, type) => {
      let entry = cur.blocks.get(index);
      if (!entry) {
        entry = { type, text: "", consumed: false };
        cur.blocks.set(index, entry);
        list.push(entry);
      }
      return entry;
    };
    if (inner.type === "content_block_start") {
      const block = inner.content_block || {};
      if (block.type === "tool_use" && block.id && !tools.has(block.id)) {
        const tool = { type: "tool_call", toolCallId: block.id, title: block.name, toolName: block.name, kind: toolKind(block.name) };
        tools.set(block.id, tool);
        emit({ ...tool, status: "in_progress" });
      } else if (block.type === "thinking" || block.type === "text") {
        const entry = blockFor(inner.index ?? cur.blocks.size, block.type);
        const seed = block.type === "thinking" ? block.thinking : block.text;
        if (typeof seed === "string" && seed) {
          entry.text += seed;
          if (block.type === "thinking") { reasoningText += seed; emit({ type: "reasoning_delta", delta: seed }); }
          else { assistantText += seed; emit({ type: "message_delta", delta: seed }); }
        }
      }
    } else if (inner.type === "content_block_delta") {
      const delta = inner.delta || {};
      if (delta.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking) {
        blockFor(inner.index ?? 0, "thinking").text += delta.thinking;
        reasoningText += delta.thinking;
        emit({ type: "reasoning_delta", delta: delta.thinking });
      } else if (delta.type === "text_delta" && typeof delta.text === "string" && delta.text) {
        blockFor(inner.index ?? 0, "text").text += delta.text;
        assistantText += delta.text;
        emit({ type: "message_delta", delta: delta.text });
      }
    } else if (inner.type === "message_stop") {
      currentStream.delete(key);
    }
  }

  // Return the not-yet-streamed remainder of a full assistant block (or the whole block when it was never streamed).
  function unstreamedRemainder(messageId, key, type, text) {
    const list = streamedByMessage.get(streamKey(key, messageId));
    if (!list) return text;
    // Full assistant messages may be emitted one block at a time. Match in stream order,
    // but never use an old stream's block to suppress unrelated text.
    const candidates = list.filter(b => !b.consumed && b.type === type);
    const next = (text && candidates.find(b => b.text && (text.startsWith(b.text) || b.text.startsWith(text)))) ||
      candidates.find(b => b.text === "");
    if (!next) return text;
    next.consumed = true;
    return text.startsWith(next.text) ? text.slice(next.text.length) : "";
  }

  const lines = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  lines.on("line", line => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    if (!event || typeof event !== "object") return;
    const now = Date.now();
    if (now - lastHeartbeatAt >= HEARTBEAT_INTERVAL_MS) {
      lastHeartbeatAt = now;
      emit({ type: "heartbeat", subtype: String(event.type || "") });
    }
    bind(event.session_id);
    if (event.type === "control_request") return handleControlRequest(event);
    if (event.type === "control_cancel_request") {
      for (const [panelId, pending] of pendingRequests) {
        if (pending.requestId !== event.request_id) continue;
        pendingRequests.delete(panelId);
        emit({ type: "runtime_request_cancelled", requestId: panelId });
      }
      return;
    }
    if (event.type === "control_response" || event.type === "keep_alive") return;
    if (event.type === "stream_event") return handleStreamEvent(event);
    if (event.type === "system" && event.subtype === "init") reportModel(event.model);
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === "assistant") {
      if (!event.parent_tool_use_id) reportModel(event.message?.model);
      const messageId = String(event.message?.id || "");
      const key = String(event.parent_tool_use_id || "");
      for (const item of blocks) {
        if (item?.type === "thinking" && typeof item.thinking === "string") {
          const rest = unstreamedRemainder(messageId, key, "thinking", item.thinking);
          if (rest) { reasoningText += rest; emit({ type: "reasoning_delta", delta: rest }); }
        } else if (item?.type === "text" && typeof item.text === "string") {
          const rest = unstreamedRemainder(messageId, key, "text", item.text);
          if (rest) { assistantText += rest; emit({ type: "message_delta", delta: rest }); }
        } else if (item?.type === "tool_use" && item.id && !tools.get(item.id)?.full) {
          const tool = { type: "tool_call", toolCallId: item.id, title: item.name, toolName: item.name, kind: toolKind(item.name), rawInput: item.input };
          tools.set(item.id, { ...tool, full: true });
          emit({ ...tool, status: "in_progress" });
        }
      }
    } else if (event.type === "user") {
      for (const item of blocks) {
        if (item?.type !== "tool_result" || !item.tool_use_id) continue;
        const tool = tools.get(item.tool_use_id) || { type: "tool_call", toolCallId: item.tool_use_id };
        emit({ ...tool, status: item.is_error ? "failed" : "completed", rawOutput: item.content });
      }
    } else if (event.type === "result") {
      finalEvent = event;
      // The turn is settled: no approval can arrive any more; let Claude flush and exit normally.
      denyAllPending("Turn already finished", false);
      closeStdin();
    }
  });
  proc.stdin.on("error", closeStdin);
  proc.stderr.setEncoding("utf8").on("data", chunk => { stderr = (stderr + chunk).slice(-2000); });
  proc.on("error", error => { spawnError = error; });
  proc.once("exit", () => {
    exited = true;
    pendingRequests.clear();
    closeStdin();
    // A descendant can inherit the streams. Drain normally, but don't hang forever after Claude exits.
    drainTimer = setTimeout(() => {
      proc.stdout.destroy();
      proc.stderr.destroy();
    }, 1500);
    drainTimer.unref?.();
  });
  const result = new Promise(resolve => proc.once("close", code => {
    clearTimeout(drainTimer);
    exited = true;
    pendingRequests.clear();
    closeStdin();
    const usage = {
      inputTokens: Number(finalEvent?.usage?.input_tokens) || 0,
      outputTokens: Number(finalEvent?.usage?.output_tokens) || 0,
      cachedInputTokens: Number(finalEvent?.usage?.cache_read_input_tokens) || 0,
    };
    usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cachedInputTokens + (Number(finalEvent?.usage?.cache_creation_input_tokens) || 0);
    const actualModels = Object.keys(finalEvent?.modelUsage || {});
    reportModel(finalEvent?.model || (!effectiveModel && actualModels.length === 1 ? actualModels[0] : undefined));
    if (finalEvent?.usage) emit({ type: "usage_updated", usage });
    const failed = !cancelRequested && (Boolean(spawnError) || code !== 0 || !finalEvent || finalEvent.is_error || /^error/.test(finalEvent.subtype || ""));
    const error = failed ? safeEngineError(finalEvent?.errors?.[0] || finalEvent?.result || spawnError || stderr, "Claude Code 未成功完成本轮。") : undefined;
    const classification = error ? classifyEngineError(error) : {};
    if (error) emit({ type: "error", message: error, error, ...classification });
    resolve({ status: cancelRequested ? "interrupted" : failed ? "failed" : "completed",
      stopReason: cancelRequested ? "cancelled" : finalEvent?.stop_reason || (failed ? finalEvent?.subtype || "error" : "end_turn"),
      nativeSessionId: bound ? sessionId : undefined, effectiveModel, assistantText: assistantText || (!failed && !cancelRequested ? finalEvent?.result || "" : ""),
      reasoningText, usage, error, ...classification });
  }));

  // Bidirectional stream-json: first user frame now, stdin stays open for approvals / steer until `result`.
  writeFrame(userFrame(resolveSessionPrompt(prompt, freshSessionPrompt, Boolean(nativeSessionId))));

  const forceKill = async () => {
    if (exited || finalEvent) return result.then(() => {});
    cancelRequested = true;
    denyAllPending("Turn cancelled", true);
    closeStdin();
    await forceKillProcessTree(proc, { processGroup });
    await result;
  };
  const cancel = () => stopPromise ??= (async () => {
    if (exited || finalEvent) return result.then(() => {});
    cancelRequested = true;
    denyAllPending("Turn cancelled", true);
    writeFrame({ type: "control_request", request_id: `interrupt_${crypto.randomUUID().slice(0, 8)}`, request: { subtype: "interrupt" } });
    closeStdin();
    let timer;
    try {
      const settledInTime = await Promise.race([
        result.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), GRACEFUL_CANCEL_MS); timer.unref?.(); }),
      ]);
      if (!settledInTime) await forceKillProcessTree(proc, { processGroup });
    } finally { clearTimeout(timer); }
    await result;
  })();
  return {
    result, closed: result.then(() => {}, () => {}), cancel, forceKill,
    async steer(text) {
      if (cancelRequested || !stdinWritable()) return { supported: false };
      return writeFrame(userFrame(text)) ? { supported: true } : { supported: false };
    },
    async respondPermission(reqId, payload) { return respondPermissionNow(reqId, payload); },
    async respondQuestion(reqId, answers) { return respondQuestionNow(reqId, answers); },
  };
}

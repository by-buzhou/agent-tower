import path from "node:path";
import { PLUGIN_VERSION } from "../daemon-client.mjs";
import { classifyEngineError, isEngineAuthenticationError, isMethodNotFoundError, isMissingSessionError, safeEngineError } from "./proc-utils.mjs";

export async function initializeAcp(rpc, { elicitation = false, timeoutMs = 20000 } = {}) {
  const response = await rpc.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "agent-tower", version: PLUGIN_VERSION },
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
      ...(elicitation ? { elicitation: { form: true } } : {}),
    },
  }, timeoutMs);
  // Older adapters omitted the version when accepting the client's proposal.
  if (response?.protocolVersion !== undefined && response.protocolVersion !== 1) {
    throw Object.assign(new Error("该引擎返回了不兼容的 ACP 协议版本，AgentTower 支持 ACP v1。"), {
      code: "ACP_PROTOCOL_UNSUPPORTED",
    });
  }
  return { ...response, capabilities: response?.agentCapabilities ?? response?.capabilities };
}

function loginHint(method) {
  const terminal = method?.terminal ?? method?._meta?.["terminal-auth"] ?? method;
  if (typeof terminal?.command === "string" && terminal.command.trim()) {
    const args = Array.isArray(terminal.args) ? terminal.args.filter(arg => typeof arg === "string") : [];
    return safeEngineError([terminal.command, ...args].join(" "), "");
  }
  return safeEngineError(method?.description || method?.name || method?.id, "");
}

export function classifyAcpError(err, initialized, command) {
  const detail = safeEngineError(err);
  if (["ACP_PROTOCOL_UNSUPPORTED", "ACP_MODEL_SWITCH_FAILED", "ACP_PLAN_MODE_UNSUPPORTED", "ACP_SESSION_RESUME_UNSUPPORTED"].includes(err?.code)) {
    return { error: detail, code: err.code, category: "validation_error", isRetryable: false };
  }
  if (Number(err?.rpcCode) === -32000 || isEngineAuthenticationError(detail) ||
      /auth(?:entication)?[ _-]required|unauthenticated|not (?:logged in|authenticated|signed in)|requires authentication|authentication or authorization failed|(?:authentication|login|sign.in) (?:failed|required)|please (?:log|sign) in|\b401\b/i.test(detail)) {
    const methods = err?.rpcData?.authMethods ?? initialized?.authMethods;
    const hints = Array.isArray(methods) ? methods.map(loginHint).filter(Boolean) : [];
    const error = `ACP 引擎需要登录。请在终端完成认证后重试。 ${hints.join(" / ") || `打开 ${path.basename(String(command || "ACP"))} CLI，按提示登录。`}`;
    return { error, code: "ACP_AUTH_REQUIRED", category: "permission_error", isRetryable: false };
  }
  return { error: detail, ...classifyEngineError(err, err?.rpcCode) };
}

export async function resumeOrCreateAcpSession(rpc, {
  nativeSessionId, cwd, capabilities, mcpServers = [], resumeTimeoutMs = 15000, newTimeoutMs = 15000, allowNewSessionFallback = false,
} = {}) {
  const params = { cwd, mcpServers: Array.isArray(mcpServers) ? mcpServers : [] };
  if (nativeSessionId) {
    const methods = [];
    if (capabilities?.sessionCapabilities?.resume) methods.push("session/resume");
    if (capabilities?.loadSession === true) methods.push("session/load");
    let missing = false;
    for (const method of methods) {
      try {
        const sessionData = await rpc.request(method, { ...params, sessionId: nativeSessionId }, resumeTimeoutMs);
        return { sessionId: nativeSessionId, sessionData: sessionData || {}, resumed: true };
      } catch (err) {
        if (Number(err?.rpcCode) === -32000) throw err;
        if (isMethodNotFoundError(err)) continue;
        if (isMissingSessionError(err)) {
          missing = true;
          break;
        }
        throw err;
      }
    }
    if (!missing && !allowNewSessionFallback) {
      throw Object.assign(new Error("该 ACP 引擎未声明会话恢复能力，无法续接指定会话。"), {
        code: "ACP_SESSION_RESUME_UNSUPPORTED",
      });
    }
  }
  const created = await rpc.request("session/new", params, newTimeoutMs);
  if (typeof created?.sessionId !== "string" || !created.sessionId) throw new Error("ACP 未返回有效的 sessionId。");
  return { sessionId: created.sessionId, sessionData: created, resumed: false };
}

export async function closeAcpSession(rpc, sessionId, capabilities, ephemeral, closeTimeoutMs = 3000) {
  if (!sessionId) return;
  const params = { sessionId };
  if (ephemeral && capabilities?.sessionCapabilities?.delete) {
    try {
      await rpc.request("session/delete", params, 3000);
      return;
    } catch {}
  }
  await rpc.request("session/close", params, closeTimeoutMs).catch(() => {});
}

export function extractAcpToolTextAndDiff(content) {
  const text = [];
  let diff;
  for (const entry of Array.isArray(content) ? content : []) {
    if (entry?.type === "diff") {
      diff = { path: entry.path, oldText: entry.oldText ?? "", newText: entry.newText ?? "" };
    } else {
      const value = entry?.type === "content" ? entry.content?.text : entry?.text;
      if (typeof value === "string" && value) text.push(value);
    }
  }
  return { text: text.join("\n"), diff };
}

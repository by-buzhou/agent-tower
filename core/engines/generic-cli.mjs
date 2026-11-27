import { resolveSessionPrompt } from "../spec-context.mjs";
import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import * as readline from "node:readline";
import { isInheritedModel, isInheritedEffort } from "../catalog.mjs";
import {
  spawnNoWindow,
  buildCleanChildEnv,
  classifyErrorCategory,
  forceKillProcessTree,
  resolveExternalCommand,
} from "./proc-utils.mjs";

function tokenizeArgsTemplate(template) {
  if (Array.isArray(template)) {
    return template.map((t) => String(t));
  }
  const str = String(template || "").trim();
  if (!str) return ["{{prompt}}"];

  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * Safely expand `{{model}}`, `{{effort}}`, `{{prompt}}`, `{{cwd}}`, `{{sessionId}}` placeholders
 * per argument token (no shell interpolation, preserving spaces/newlines inside `{{prompt}}`).
 */
export function expandCliTemplateArgs(argsTemplate, vars = {}) {
  const rawTokens = tokenizeArgsTemplate(argsTemplate);
  const hasPromptPlaceholder = rawTokens.some((t) => t.includes("{{prompt}}"));

  const out = [];
  for (let i = 0; i < rawTokens.length; i++) {
    const tok = rawTokens[i];
    const nextTok = rawTokens[i + 1];

    // Drop flag + value pair if value is purely a placeholder that resolved to empty
    if (
      tok.startsWith("-") &&
      !tok.includes("=") &&
      typeof nextTok === "string" &&
      /^\{\{(\w+)\}\}$/.test(nextTok)
    ) {
      const key = nextTok.slice(2, -2);
      if (!vars[key]) {
        i++;
        continue;
      }
    }

    const replaced = tok.replace(/\{\{(\w+)\}\}/g, (_m, key) => {
      const v = vars[key];
      return v !== undefined && v !== null ? String(v) : "";
    });

    if (replaced.length > 0 || tok === "{{prompt}}") {
      out.push(replaced);
    }
  }

  if (!hasPromptPlaceholder && vars.prompt) {
    out.push(String(vars.prompt));
  }

  return out;
}

/**
 * Probe whether a non-ACP CLI command exists and responds on the local machine.
 */
export async function probeCliProvider({
  command,
  args = ["--version"],
  env = {},
  cwd,
  timeoutMs = 5000,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  if (!command || !String(command).trim()) {
    return { ok: false, protocol: "cli", error: "未指定可执行命令 (command)" };
  }

  const checkArgs = Array.isArray(args) && args.length > 0 ? args.map(String) : ["--version"];
  const resolved = resolveExternalCommand(command, checkArgs);

  return new Promise((resolve) => {
    let settled = false;
    let outBuf = "";
    let errBuf = "";

    let proc;
    try {
      proc = spawnNoWindow(resolved.command, resolved.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],

        env: buildCleanChildEnv({ ...resolved.env, ...(env || {}) }),
      });
    } catch (err) {
      resolve({ ok: false, protocol: "cli", error: err.message });
      return;
    }

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await forceKillProcessTree(proc);
      resolve({
        ok: Boolean(resolved.resolvedPath),
        protocol: "cli",
        binaryPath: resolved.resolvedPath || resolved.command,
        versionOutput: (outBuf || errBuf).trim().slice(0, 200) || "timeout (binary exists)",
      });
    }, Math.max(1500, Number(timeoutMs) || 5000));
    timer.unref?.();

    proc.stdout?.on("data", (d) => {
      outBuf = (outBuf + d.toString("utf-8")).slice(0, 2000);
    });
    proc.stderr?.on("data", (d) => {
      errBuf = (errBuf + d.toString("utf-8")).slice(0, 2000);
    });

    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        protocol: "cli",
        binaryPath: resolved.resolvedPath || null,
        error: err.message,
      });
    });

    proc.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = (outBuf || errBuf).trim();
      const firstLine = combined.split(/\r?\n/)[0] || "";
      if (code === 0 || Boolean(resolved.resolvedPath && combined)) {
        resolve({
          ok: true,
          protocol: "cli",
          binaryPath: resolved.resolvedPath || resolved.command,
          versionOutput: firstLine.slice(0, 200) || "ready",
        });
      } else {
        resolve({
          ok: false,
          protocol: "cli",
          binaryPath: resolved.resolvedPath || null,
          error: firstLine || `Exited with code ${code}`,
        });
      }
    });
  });
}

/**
 * Generic CLI Template Turn Driver (supports Aider and custom command-line agents).
 * Automatically parses JSONL event streams when emitted, or streams plain stdout text lines.
 */
export function runGenericCliTurn({
  runId,
  threadId,
  provider = "custom-cli",
  providerConfig = {},
  model = "",
  effort = "",
  cwd,
  nativeSessionId = "",
  prompt = "",
  freshSessionPrompt,
  onEvent,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const rawCommand = providerConfig.command || provider;
  const template = providerConfig.argsTemplate ?? providerConfig.args ?? ["{{prompt}}"];
  const resumeId = tokenizeArgsTemplate(template).some(token => token.includes("{{sessionId}}")) ? nativeSessionId : "";
  const selectedModel = model || providerConfig.defaultModel || "";
  const expandedArgs = expandCliTemplateArgs(template, {
    model: isInheritedModel(selectedModel) ? "" : selectedModel,
    effort: isInheritedEffort(effort) ? "" : effort || "",
    // argv is fixed before the CLI reports whether it actually resumed the requested session.
    prompt: resolveSessionPrompt(prompt, freshSessionPrompt, false),
    cwd,
    sessionId: resumeId,
  });

  let proc;
  let settled = false;
  let cancelRequested = false;
  let boundSessionId = "";
  let assistantText = "";
  let reasoningText = "";
  let stderrTail = "";

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

  const result = (async () => {
    let rl;
    try {
      const resolved = resolveExternalCommand(rawCommand, expandedArgs, providerConfig.candidatePaths || []);
      proc = spawnNoWindow(resolved.command, resolved.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],

        env: buildCleanChildEnv({
          ...resolved.env,
          ...(providerConfig.env && typeof providerConfig.env === "object" ? providerConfig.env : {}),
        }),
      });
      let spawnError;
      const exitPromise = new Promise(resolve => {
        proc.once("error", err => {
          spawnError = err;
          rl?.close();
          proc.stdout?.destroy();
          resolve(1);
        });
        proc.once("close", code => resolve(code ?? 1));
      });
      proc.stderr?.on("data", chunk => { stderrTail = (stderrTail + chunk.toString("utf8")).slice(-2000); });
      rl = readline.createInterface({ input: proc.stdout, crlfDelay: Infinity });
      for await (const line of rl) {
        const trimmed = line.trim();
        if (!trimmed) {
          if (assistantText) {
            assistantText += "\n";
            emit({ type: "message_delta", delta: "\n", text: "\n" });
          }
          continue;
        }

        // Try structured JSONL first
        if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
          try {
            const obj = JSON.parse(trimmed);
            const sid = obj.session_id || obj.sessionId || obj.thread_id || obj.conversation_id;
            if (sid && sid !== boundSessionId) {
              boundSessionId = String(sid);
              emit({ type: "session_bound", nativeSessionId: boundSessionId, sessionId: boundSessionId, resumed: boundSessionId === resumeId });
            }

            const think = obj.thinking || obj.reasoning || obj.thought_delta;
            if (typeof think === "string" && think) {
              reasoningText += think;
              emit({ type: "reasoning_delta", delta: think, text: think });
            }

            const msg =
              obj.delta ??
              obj.text_delta ??
              obj.step_update?.text_delta ??
              (typeof obj.content === "string" ? obj.content : undefined) ??
              (typeof obj.text === "string" ? obj.text : undefined) ??
              (typeof obj.response === "string" ? obj.response : undefined);

            if (typeof msg === "string" && msg) {
              assistantText += msg;
              emit({ type: "message_delta", delta: msg, text: msg, phase: "final_answer" });
            }
            continue;
          } catch {
            // Treat as plain text line below
          }
        }

        const chunk = `${line}\n`;
        assistantText += chunk;
        emit({ type: "message_delta", delta: chunk, text: chunk, phase: "final_answer" });
      }

      const exitCode = await exitPromise;
      if (spawnError) throw spawnError;

      settled = true;

      if (cancelRequested) {
        return {
          status: "interrupted",
          stopReason: "cancelled",
          nativeSessionId: boundSessionId || undefined,
          assistantText: assistantText.trim(),
          reasoningText: reasoningText.trim(),
        };
      }

      if (exitCode !== 0) {
        const errMsg = stderrTail.trim() || `${rawCommand} exited with code ${exitCode}`;
        emit({
          type: "error",
          message: errMsg,
          error: errMsg,
          category: classifyErrorCategory(errMsg),
        });
        return {
          status: "failed",
          stopReason: "error",
          nativeSessionId: boundSessionId || undefined,
          assistantText: assistantText.trim(),
          reasoningText: reasoningText.trim(),
          error: errMsg,
        };
      }

      return {
        status: "completed",
        stopReason: "end_turn",
        nativeSessionId: boundSessionId || undefined,
        assistantText: assistantText.trim(),
        reasoningText: reasoningText.trim(),
      };
    } catch (err) {
      settled = true;
      await forceKillProcessTree(proc);
      if (cancelRequested) {
        return {
          status: "interrupted",
          stopReason: "cancelled",
          nativeSessionId: boundSessionId || undefined,
          assistantText: assistantText.trim(),
          reasoningText: reasoningText.trim(),
        };
      }
      const errMsg = err?.message || String(err);
      emit({
        type: "error",
        message: errMsg,
        error: errMsg,
        category: classifyErrorCategory(errMsg),
      });
      return {
        status: "failed",
        stopReason: "error",
        nativeSessionId: boundSessionId || undefined,
        assistantText: assistantText.trim(),
        reasoningText: reasoningText.trim(),
        error: errMsg,
      };
    } finally { rl?.close(); }
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
    async steer() {
      return { supported: false };
    },
    async respondPermission() {},
    async respondQuestion() {},
    // Plain CLI output cannot establish whether the process already modified the workspace.
    retrySafe: false,
    result,
  };
}

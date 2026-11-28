import { resolveSessionPrompt } from "../spec-context.mjs";
import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import * as readline from "node:readline";
import { isInheritedModel, isInheritedEffort } from "../catalog.mjs";
import {
  spawnNoWindow,
  buildCleanChildEnv,
  classifyErrorCategory,
  extensionEnvOptions,
  forceKillProcessTree,
  isEngineAuthenticationError,
  redactSensitiveText,
  resolveExternalCommand,
  safeEngineError,
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
  id,
  command,
  args = ["--version"],
  env = {},
  envPolicy,
  credentialEnvKeys,
  extraCandidatePaths,
  cwd,
  timeoutMs = 5000,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  if (!command || !String(command).trim()) {
    return { ok: false, protocol: "cli", error: "未指定可执行命令 (command)" };
  }

  const checkArgs = Array.isArray(args) && args.length > 0 ? args.map(String) : ["--version"];
  let resolved;
  try { resolved = resolveExternalCommand(command, checkArgs, extraCandidatePaths); }
  catch (err) { return { ok: false, protocol: "cli", error: safeEngineError(err) }; }

  return new Promise((resolve) => {
    let settled = false;
    let outBuf = "";
    let errBuf = "";

    let proc;
    try {
      proc = spawnNoWindow(resolved.command, resolved.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],

        env: buildCleanChildEnv({ ...resolved.env, ...env }, extensionEnvOptions(id, { envPolicy, credentialEnvKeys })),
      });
    } catch (err) {
      resolve({ ok: false, protocol: "cli", error: safeEngineError(err) });
      return;
    }

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await forceKillProcessTree(proc);
      resolve({
        ok: false,
        protocol: "cli",
        binaryPath: resolved.resolvedPath || resolved.command,
        error: "CLI probe timed out",
      });
    }, Math.max(1500, Number(timeoutMs) || 5000));
    timer.unref?.();

    proc.stdout?.on("data", (d) => {
      outBuf = (outBuf + d).slice(0, 8192);
    });
    proc.stderr?.on("data", (d) => {
      errBuf = (errBuf + d).slice(0, 8192);
    });

    proc.once("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        protocol: "cli",
        binaryPath: resolved.resolvedPath || null,
        error: safeEngineError(err),
      });
    });

    proc.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const combined = redactSensitiveText(outBuf || errBuf).trim();
      const firstLine = combined.split(/\r?\n/)[0] || "";
      const authError = code !== 0 && isEngineAuthenticationError(redactSensitiveText(errBuf || outBuf));
      if (code === 0) {
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
          error: safeEngineError(authError ? errBuf || outBuf : firstLine, `Exited with code ${code}`),
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
  ephemeral = false,
  prompt = "",
  freshSessionPrompt,
  onEvent,
} = {}) {
  cwd = nativePath(cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
  const rawCommand = providerConfig.command || provider;
  const template = providerConfig.argsTemplate ?? providerConfig.args ?? ["{{prompt}}"];
  const resumeId = !ephemeral && tokenizeArgsTemplate(template).some(token => token.includes("{{sessionId}}")) ? nativeSessionId : "";
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
  let inDiagnostics = false;
  const publicOutput = value => {
    if (inDiagnostics) return "";
    if (/\bFull diagnostics:/i.test(value)) inDiagnostics = true;
    return redactSensitiveText(value);
  };

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
      const resolved = resolveExternalCommand(rawCommand, expandedArgs, providerConfig.candidatePaths ?? providerConfig.extraCandidatePaths);
      proc = spawnNoWindow(resolved.command, resolved.args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],

        env: buildCleanChildEnv({
          ...resolved.env,
          ...(providerConfig.env && typeof providerConfig.env === "object" ? providerConfig.env : {}),
        }, extensionEnvOptions(provider, providerConfig)),
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
      // Retain the diagnostics header even when the child prints a large crash block.
      proc.stderr?.on("data", chunk => { stderrTail = (stderrTail + chunk).slice(0, 8192); });
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
            if (!ephemeral && sid && sid !== boundSessionId) {
              boundSessionId = String(sid);
              emit({ type: "session_bound", nativeSessionId: boundSessionId, sessionId: boundSessionId, resumed: boundSessionId === resumeId });
            }

            const think = obj.thinking || obj.reasoning || obj.thought_delta;
            if (typeof think === "string" && think) {
              const delta = publicOutput(think);
              reasoningText += delta;
              if (delta) emit({ type: "reasoning_delta", delta, text: delta });
            }

            const msg =
              obj.delta ??
              obj.text_delta ??
              obj.step_update?.text_delta ??
              (typeof obj.content === "string" ? obj.content : undefined) ??
              (typeof obj.text === "string" ? obj.text : undefined) ??
              (typeof obj.response === "string" ? obj.response : undefined);

            if (typeof msg === "string" && msg) {
              const delta = publicOutput(msg);
              assistantText += delta;
              if (delta) emit({ type: "message_delta", delta, text: delta, phase: "final_answer" });
            }
            continue;
          } catch {
            // Treat as plain text line below
          }
        }

        const chunk = publicOutput(`${line}\n`);
        if (!chunk) continue;
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
        const errMsg = safeEngineError(stderrTail, `CLI exited with code ${exitCode}`);
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
          category: classifyErrorCategory(errMsg),
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
      const errMsg = safeEngineError(err);
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
        category: classifyErrorCategory(errMsg),
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

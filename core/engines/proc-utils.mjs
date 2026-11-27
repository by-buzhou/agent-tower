import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";

const require = createRequire(import.meta.url);

/**
 * Resolve clean standalone system `node.exe` so child Node CLIs (like Kimi Code)
 * never accidentally launch Electron (`Antigravity.exe`) without ELECTRON_RUN_AS_NODE.
 */
export function resolveSystemNodeExe() {
  if (process.execPath && path.basename(process.execPath).toLowerCase() === "node.exe" && existsSync(process.execPath)) {
    return { nodeCmd: process.execPath, extraEnv: {} };
  }
  const winDefault = "C:\\Program Files\\nodejs\\node.exe";
  if (process.platform === "win32" && existsSync(winDefault)) {
    return { nodeCmd: winDefault, extraEnv: {} };
  }
  return {
    nodeCmd: process.execPath,
    extraEnv: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

/**
 * Strip Sidecar loader hooks from `NODE_OPTIONS` so child CLI processes (Kimi/Codex/AGY)
 * run in a clean environment unpolluted by parent host loaders.
 */
export function buildCleanChildEnv(extraEnv = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^ANTIGRAVITY_(?:CSRF_TOKEN|LS_ADDRESS)$/i.test(key)) delete env[key];
  }
  Object.assign(env, extraEnv);
  if (typeof env.NODE_OPTIONS === "string" && env.NODE_OPTIONS.includes("sidecar_sdk")) {
    const args = env.NODE_OPTIONS.match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) || [];
    const kept = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      const flag = arg.replace(/^"|"$/g, "");
      if (/^(?:--import|--require|-r)$/.test(flag) && args[i + 1]?.includes("sidecar_sdk")) i++;
      else if (!arg.includes("sidecar_sdk")) kept.push(arg);
    }
    const cleaned = kept.join(" ");
    if (cleaned) env.NODE_OPTIONS = cleaned;
    else delete env.NODE_OPTIONS;
  }
  return env;
}

// Public metadata may come from user-managed configuration or an untrusted child process.
const privateText = /(?:@|%40|:\/\/|\btoken\s*[:=]|\b(?:bearer|authorization|(?:x[-_ ])?api[-_ ]?key|[\w-]*[-_]token|password|secret|sk[-_][\w-]+)\b)/iu;

export function safeCatalogText(value) {
  return typeof value === "string" && value.length <= 4096 && !privateText.test(value)
    ? value.trim() : "";
}

export function safeEngineError(value, fallback = "Engine request failed") {
  const message = typeof value === "string" ? value : value?.message;
  const safe = safeCatalogText(message);
  if (safe) return safe;
  if (/auth|credentials?|login|\b40[13]\b/i.test(message || "")) return "Engine authentication or authorization failed";
  if (/network|connection|timed? ?out|transport/i.test(message || "")) return "Engine network or transport request failed";
  return fallback;
}

function compareSemverDesc(a, b) {
  const pa = String(a).split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pb[i] || 0) !== (pa[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
  }
  return String(b).localeCompare(String(a));
}

function isCommandFile(file) {
  try {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return false;
    if (process.platform !== "win32" && !/\.(mjs|cjs|js)$/i.test(file)) accessSync(file, constants.X_OK);
    return true;
  } catch { return false; }
}

export function safePathBinary(name) {
  try {
    const bin = resolveExternalCommand(name, []);
    return { command: bin.command, prefixArgs: bin.args, env: bin.env, resolvedPath: bin.resolvedPath || "", available: Boolean(bin.resolvedPath) };
  } catch {
    // A native executable may still be present later on PATH after an opaque batch shim.
    const command = process.platform === "win32" ? name + ".exe" : name;
    const resolvedPath = detectCommandOnSystem(command).binaryPath || "";
    return { command: resolvedPath || command, prefixArgs: [], env: {}, resolvedPath, available: Boolean(resolvedPath) };
  }
}

export function resolveKimiBinary() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const { nodeCmd, extraEnv } = resolveSystemNodeExe();

  // 1. Check ~/.agent-tower/tools/kimi-code/<ver>/npm/node_modules/@moonshot-ai/kimi-code/dist/main.mjs
  const towerToolsDir = path.join(home, ".agent-tower", "tools", "kimi-code");
  if (existsSync(towerToolsDir)) {
    try {
      const versions = readdirSync(towerToolsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort(compareSemverDesc);
      for (const ver of versions) {
        const candidate = path.join(
          towerToolsDir,
          ver,
          "npm",
          "node_modules",
          "@moonshot-ai",
          "kimi-code",
          "dist",
          "main.mjs"
        );
        if (isCommandFile(candidate)) {
          return {
            command: nodeCmd,
            prefixArgs: [candidate],
            env: extraEnv,
            versionHint: ver,
            resolvedPath: candidate,
          };
        }
      }
    } catch {
      // Fall through to global npm check
    }
  }

  // 2. Check global npm @moonshot-ai/kimi-code/dist/main.mjs
  const npmMain = path.join(appData, "npm", "node_modules", "@moonshot-ai", "kimi-code", "dist", "main.mjs");
  if (isCommandFile(npmMain)) {
    return {
      command: nodeCmd,
      prefixArgs: [npmMain],
      env: extraEnv,
      versionHint: "npm-global",
      resolvedPath: npmMain,
    };
  }

  return safePathBinary("kimi");
}

/**
 * Locate the native Rust codex.exe binary directly (bypassing pwsh -> node -> codex.exe 3-layer wrapper).
 */
export function resolveCodexBinary() {
  const platform = process.platform;
  const arch = process.arch;
  const targetPlatform = { win32: "pc-windows-msvc", darwin: "apple-darwin", linux: "unknown-linux-musl" }[platform];
  const targetArch = { x64: "x86_64", arm64: "aarch64" }[arch];
  const target = targetPlatform && targetArch ? targetArch + "-" + targetPlatform : "";
  const executable = platform === "win32" ? "codex.exe" : "codex";
  const npmRoots = new Set([path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules")]);
  const prefixes = [process.env.npm_config_prefix, path.join(os.homedir(), ".npm-global")];
  for (const dir of commandSearchDirs()) {
    if (platform === "win32") npmRoots.add(path.join(dir, "node_modules"));
    else if (path.basename(dir) === "bin") prefixes.push(path.dirname(dir));
  }
  for (const prefix of prefixes.filter(Boolean)) {
    npmRoots.add(platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules"));
  }
  const sourcePackageRoots = [...npmRoots].map(root => path.join(root, "@openai", "codex"));
  try {
    sourcePackageRoots.push(path.dirname(path.dirname(require.resolve("@openai/codex/bin/codex.js"))));
  } catch {}

  if (target) {
    const platformPackage = "codex-" + platform + "-" + arch;
    const nativePackageRoots = [
      ...sourcePackageRoots.map(root => path.join(root, "node_modules", "@openai", platformPackage)),
      ...[...npmRoots].map(root => path.join(root, "@openai", platformPackage)),
      ...sourcePackageRoots,
    ];
    try {
      nativePackageRoots.push(path.dirname(require.resolve("@openai/" + platformPackage + "/package.json")));
    } catch {}
    const packageRoot = sourcePackageRoots.find(root => isCommandFile(path.join(root, "bin", "codex.js")));
    for (const root of nativePackageRoots) {
      for (const layout of ["bin", "codex"]) {
        const candidate = path.join(root, "vendor", target, layout, executable);
        if (isCommandFile(candidate)) {
          return {
            command: candidate,
            prefixArgs: [],
            env: { CODEX_MANAGED_BY_NPM: "1", ...(packageRoot ? { CODEX_MANAGED_PACKAGE_ROOT: packageRoot } : {}) },
            resolvedPath: candidate,
          };
        }
      }
    }
  }

  const codexJs = sourcePackageRoots.map(root => path.join(root, "bin", "codex.js")).find(isCommandFile);
  if (codexJs) {
    const { nodeCmd, extraEnv } = resolveSystemNodeExe();
    return { command: nodeCmd, prefixArgs: [codexJs], env: extraEnv, resolvedPath: codexJs };
  }
  return safePathBinary("codex");
}

export function resolveClaudeBinary() {
  const home = os.homedir();
  const name = process.platform === "win32" ? "claude.exe" : "claude";
  const npm = path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "npm");
  const candidates = [path.join(home, ".local", "bin", name), path.join(npm, name),
    path.join(npm, "node_modules", "@anthropic-ai", "claude-code", "cli.js")];
  try {
    const bin = resolveExternalCommand("claude", [], candidates);
    if (bin.resolvedPath && !/\.ps1$/i.test(bin.resolvedPath)) {
      return { command: bin.command, prefixArgs: bin.args, env: bin.env, resolvedPath: bin.resolvedPath };
    }
  } catch { /* Do not execute opaque shell shims. */ }
  return { command: name, prefixArgs: [], resolvedPath: null };
}

export function flattenAcpOptions(options) {
  return Array.isArray(options) ? options.flatMap(o => Array.isArray(o?.options) ? flattenAcpOptions(o.options) : [o]) : [];
}

const ACP_ALLOW_ONCE = /^(?:approve(?:_once)?|allow(?:_once)?|accept)$/i;
const ACP_ALLOW_ALWAYS = /^(?:approve|allow)_always$/i;
const ACP_REJECT = /^(?:reject|deny|decline)(?:_once|_always)?$/i;
const ACP_NON_APPROVAL = /^(?:cancel(?:led|ed)?|timeout|timed_out|rejected)$/i;

export function mapAcpPermissionOutcome(decision, options = []) {
  const offered = Array.isArray(options) ? options.filter(o => typeof o?.optionId === "string" && o.optionId.trim()) : [];
  const kindOf = o => o.kind || o.optionId;
  const selected = o => ({ outcome: "selected", optionId: o.optionId });
  const rejected = offered.find(o => ACP_REJECT.test(kindOf(o)) && !/_always$/i.test(kindOf(o))) ??
    offered.find(o => ACP_REJECT.test(kindOf(o)));
  const denied = rejected ? selected(rejected) : { outcome: "cancelled" };
  const reply = typeof decision === "string" ? decision : decision?.decision ?? decision?.action;
  const action = typeof reply === "string" ? reply.trim() : "";
  if (decision?.cancelled || ACP_REJECT.test(action) || ACP_NON_APPROVAL.test(action)) return denied;

  const isOnce = ACP_ALLOW_ONCE.test(action);
  const isAlways = ACP_ALLOW_ALWAYS.test(action);
  const allowOnce = o => ACP_ALLOW_ONCE.test(kindOf(o)) && !ACP_REJECT.test(o.optionId) && !ACP_NON_APPROVAL.test(o.optionId);
  const allowAlways = o => ACP_ALLOW_ALWAYS.test(kindOf(o)) && !ACP_REJECT.test(o.optionId) && !ACP_NON_APPROVAL.test(o.optionId);
  const optionId = decision?.optionId ?? (isOnce || isAlways ? undefined : action);
  if (optionId) {
    const option = offered.find(o => o.optionId === optionId);
    if (option && (allowOnce(option) || !isOnce && allowAlways(option))) return selected(option);
    return denied;
  }
  if (isOnce || isAlways) {
    const option = (isAlways ? offered.find(allowAlways) : undefined) ?? offered.find(allowOnce);
    if (option) return selected(option);
  }
  return denied;
}

/**
 * Locate Antigravity CLI executable (`agy.exe`).
 */
export function resolveAgyBinary() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [
    path.join(localAppData, "agy", "bin", "agy.exe"),
    path.join(home, ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy"),
  ];
  const name = process.platform === "win32" ? "agy.exe" : "agy";
  const found = detectCommandOnSystem(name, process.platform === "win32" ? candidates : candidates.slice(1)).binaryPath;
  return { command: found || name, prefixArgs: [], resolvedPath: found };
}

/**
 * Resolve Antigravity Host's native `agentapi` Language Server executable when running inside Antigravity.
 */
export function resolveHostAgentApiBinary(hostEnv = {}) {
  const merged = { ...process.env, ...hostEnv };
  const explicitExe = merged.ANTIGRAVITY_AGENTAPI_EXE;
  if (explicitExe && existsSync(explicitExe)) {
    return {
      available: Boolean(merged.ANTIGRAVITY_LS_ADDRESS && merged.ANTIGRAVITY_CSRF_TOKEN),
      command: explicitExe,
      prefixArgs: ["agentapi"],
      env: merged,
      resolvedPath: explicitExe,
    };
  }

  const home = os.homedir();
  const localAppData = merged.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const candidates = [
    path.join(localAppData, "Programs", "antigravity", "resources", "bin", "language_server.exe"),
  ];

  // Also check ~/.gemini/antigravity/bin/agentapi.bat for custom install paths
  const batShim = path.join(home, ".gemini", "antigravity", "bin", "agentapi.bat");
  if (existsSync(batShim)) {
    try {
      const batText = readFileSync(batShim, "utf-8");
      const m = /"([^"]+language_server\.exe)"/i.exec(batText);
      if (m && m[1]) candidates.unshift(m[1]);
    } catch {}
  }

  for (const exe of candidates) {
    if (existsSync(exe)) {
      return {
        available: Boolean(merged.ANTIGRAVITY_LS_ADDRESS && merged.ANTIGRAVITY_CSRF_TOKEN),
        command: exe,
        prefixArgs: ["agentapi"],
        env: merged,
        resolvedPath: exe,
      };
    }
  }

  return {
    available: false,
    command: null,
    prefixArgs: [],
    env: merged,
    resolvedPath: null,
  };
}

function commandSearchDirs() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");

  return new Set([
    ...(process.env.PATH || "").split(path.delimiter).filter(Boolean),
    ...(process.platform === "darwin" ? ["/opt/homebrew/bin"] : []),
    ...(process.platform !== "win32" ? ["/usr/local/bin"] : []),
    path.join(appData, "npm"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".grok", "bin"),
    path.join(home, ".kiro", "bin"),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".cargo", "bin"),
    path.join(localAppData, "cursor-agent"),
  ]);
}

/**
 * Detect an executable or Node entrypoint without spawning a process.
 */
export function detectCommandOnSystem(commandName, extraCandidatePaths = []) {
  const candidate = extraCandidatePaths.find(p => p && isCommandFile(p));
  if (candidate) return { detected: true, binaryPath: path.resolve(candidate) };

  const trimmed = String(commandName || "").trim();
  if (!trimmed) return { detected: false, binaryPath: null };
  if (path.isAbsolute(trimmed) || trimmed.includes("/") || (process.platform === "win32" && trimmed.includes("\\"))) {
    return isCommandFile(trimmed)
      ? { detected: true, binaryPath: path.resolve(trimmed) }
      : { detected: false, binaryPath: null };
  }

  const exts = process.platform === "win32" && !/\.(?:exe|cmd|bat|ps1|mjs|cjs|js)$/i.test(trimmed)
    ? [".exe", ".cmd", ".bat", ".ps1", ""] : [""];
  for (const dir of commandSearchDirs()) {
    for (const ext of exts) {
      const full = path.join(dir, trimmed + ext);
      if (isCommandFile(full)) {
        return { detected: true, binaryPath: path.resolve(full) };
      }
    }
  }

  return { detected: false, binaryPath: null };
}

/**
 * Resolve any external CLI/ACP command on Windows/POSIX so `spawn()` works reliably
 * without ENOENT on `.cmd`/`.mjs`/`.js` shims and without shell injection.
 */
export function resolveExternalCommand(command, args = [], extraCandidatePaths = []) {
  const rawCmd = String(command || "").trim();
  const cleanArgs = Array.isArray(args) ? args.map(String) : [];
  const { nodeCmd, extraEnv } = resolveSystemNodeExe();

  if (/\.(mjs|cjs|js)$/i.test(rawCmd) && isCommandFile(rawCmd)) {
    const script = path.resolve(rawCmd);
    return { command: nodeCmd, args: [script, ...cleanArgs], env: extraEnv, resolvedPath: script };
  }

  const found = detectCommandOnSystem(rawCmd, extraCandidatePaths);
  const target = found.binaryPath || rawCmd;
  const lower = target.toLowerCase();

  if (/\.(mjs|cjs|js)$/i.test(lower) && found.detected) {
    return { command: nodeCmd, args: [target, ...cleanArgs], env: extraEnv, resolvedPath: target };
  }

  // Unwrap standard npm `.cmd` wrappers directly to `node.exe <script.js>` when possible!
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    try {
      const content = readFileSync(target, "utf-8");
      const dp0 = path.dirname(target);
      const scriptMatch = /"%dp0%\\([^"]+\.(?:mjs|cjs|js))"/i.exec(content) ||
        /"%USERPROFILE%\\([^"]+\.(?:mjs|cjs|js))"/i.exec(content);
      if (scriptMatch) {
        const base = content.includes("%USERPROFILE%") && !content.includes("%dp0%\\" + scriptMatch[1])
          ? os.homedir()
          : dp0;
        const jsPath = path.resolve(base, scriptMatch[1]);
        if (isCommandFile(jsPath)) {
          return { command: nodeCmd, args: [jsPath, ...cleanArgs], env: extraEnv, resolvedPath: jsPath };
        }
      }
    } catch {}
    throw new Error(
      `Refusing to execute unparsed batch wrapper via cmd.exe (${path.basename(target)}). Please configure the underlying .exe or .mjs/.js entrypoint directly.`
    );
  }

  if (lower.endsWith(".ps1") && found.detected) {
    return {
      command: "pwsh.exe",
      args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", target, ...cleanArgs],
      env: {},
      resolvedPath: target,
    };
  }

  return {
    command: target,
    args: cleanArgs,
    env: {},
    resolvedPath: found.binaryPath || null,
  };
}

// SW_HIDE alone still allows console allocation from a detached Windows daemon.
export function noWindowSpawnOptions(options = {}, platform = process.platform) {
  return { ...options, windowsHide: true, shell: false, ...(platform === "win32" ? { detached: true } : {}) };
}

export function spawnNoWindow(command, args, options) {
  return spawn(command, args, noWindowSpawnOptions(options));
}

export function captureNoWindow(command, args, { timeoutMs = 10000, maxBuffer = 1024 * 1024, ...options } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawnNoWindow(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    const output = { stdout: [], stderr: [] };
    let failure, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = Object.fromEntries(Object.entries(output).map(([key, chunks]) => [key, Buffer.concat(chunks).toString("utf8")]));
      if (error) reject(Object.assign(error, text));
      else resolve(text);
    };
    const abort = (message, code) => {
      if (failure || settled) return;
      failure = Object.assign(new Error(message), { code });
      // The tree kill is itself bounded, including if a descendant holds the pipes open.
      void forceKillProcessTree(proc, { processGroup: options.detached === true }).finally(() => {
        proc.stdout.destroy();
        proc.stderr.destroy();
        finish(failure);
      });
    };
    const timer = timeoutMs > 0 ? setTimeout(() => abort(`Process timed out after ${timeoutMs}ms`, "ETIMEDOUT"), timeoutMs) : undefined;
    for (const key of Object.keys(output)) {
      let bytes = 0;
      proc[key].on("data", chunk => {
        if (failure || settled) return;
        bytes += chunk.length;
        if (bytes > maxBuffer) abort(`${key} exceeded ${maxBuffer} bytes`, "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
        else output[key].push(chunk);
      });
    }
    proc.once("error", error => { if (!failure) finish(error); });
    proc.once("close", (code, signal) => {
      if (failure) return; // Let abort finish tree cleanup before returning.
      finish(code === 0 ? undefined : Object.assign(new Error(`Process exited with ${signal || code}`), { code, signal }));
    });
  });
}

const cleanedProcessTrees = new WeakSet();

/**
 * Force-kill an entire OS process tree on Windows (`taskkill /PID /T /F`) or POSIX.
 */
export async function forceKillProcessTree(proc, { processGroup = false } = {}) {
  if (!proc || cleanedProcessTrees.has(proc)) return;
  cleanedProcessTrees.add(proc);
  const pid = proc.pid;

  if (process.platform === "win32" && pid) {
    await new Promise((resolve) => {
      const killer = spawnNoWindow("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { killer.kill("SIGKILL"); } catch {} finish(); }, 4000);
      killer.once("error", finish);
      killer.once("close", finish);
    });
  }

  try {
    if (processGroup && pid && process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
  } catch {
    // Process already exited
  }
}

/**
 * Send graceful cancel signal first; if the turn/process does not settle within `graceMs`,
 * automatically escalate to `forceKillProcessTree`.
 */
export async function gracefulCancelWithEscalation(proc, sendGraceful, isSettledFn, graceMs = 2000) {
  try {
    await sendGraceful();
  } catch {
    // Ignore transport write errors during cancel
  }

  if (isSettledFn?.() || !proc || proc.exitCode !== null) {
    return;
  }

  await Promise.race([
    new Promise((resolve) => proc.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, graceMs)),
  ]);

  if (!isSettledFn?.() && proc.exitCode === null) {
    await forceKillProcessTree(proc);
  }
}

/**
 * Create a lightweight NDJSON JSON-RPC 2.0 connection over a spawned child process's stdio.
 * Automatically rejects all in-flight RPC calls when the child process exits unexpectedly.
 */
export function createNdjsonRpcConnection(
  proc,
  { onNotification, onServerRequest, onStderr } = {}
) {
  let nextId = 1;
  let closed = false;
  const pending = new Map();

  const rl = readline.createInterface({
    input: proc.stdout,
    crlfDelay: Infinity,
  });

  const writeJson = (obj) => {
    if (closed || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) {
      return false;
    }
    try {
      proc.stdin.write(`${JSON.stringify(obj)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    // 1. Response to a client-initiated request
    if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = pending.get(msg.id);
      if (entry) {
        pending.delete(msg.id);
        if (entry.timer) clearTimeout(entry.timer);
        if (msg.error) {
          const err = new Error(safeEngineError(msg.error.message, "Engine RPC request failed"));
          err.rpcCode = msg.error.code;
          entry.reject(err);
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }

    // 2. Server-initiated reverse RPC request (e.g. permission approval or user question)
    if (msg.id !== undefined && msg.id !== null && typeof msg.method === "string") {
      Promise.resolve().then(() => onServerRequest?.(msg.method, msg.params, msg.id))
        .then((result) => writeJson(result === undefined
          ? { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } }
          : { jsonrpc: "2.0", id: msg.id, result }))
        .catch(() => writeJson({
          jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: "Internal client handler error" },
        }));
      return;
    }

    // 3. Server notification
    if (typeof msg.method === "string") {
      try {
        onNotification?.(msg.method, msg.params);
      } catch {
        // Guard stream loop from listener exceptions
      }
    }
  });

  if (proc.stderr) {
    proc.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf-8");
      onStderr?.(text);
    });
  }

  const rejectAllPending = (reason) => {
    if (closed) return;
    closed = true;
    for (const [, entry] of pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(reason);
    }
    pending.clear();
    try {
      rl.close();
    } catch {}
  };

  rl.once("close", () => {
    rejectAllPending(new Error("Engine stdout closed"));
  });
  proc.stdout.once("error", () => rejectAllPending(new Error("Engine stdout failed")));
  proc.stdin?.on("error", () => rejectAllPending(new Error("Engine stdin failed")));

  proc.once("error", (err) => {
    rejectAllPending(new Error(`Engine process spawn error: ${safeEngineError(err)}`));
  });

  proc.once("exit", (code, signal) => {
    rejectAllPending(
      new Error(`Engine process exited (code=${code ?? "null"}, signal=${signal ?? "null"})`)
    );
  });

  return {
    request(method, params = {}, timeoutMs = 0) {
      if (closed) {
        return Promise.reject(new Error(`RPC connection already closed before calling ${method}`));
      }
      const id = nextId++;
      return new Promise((resolve, reject) => {
        let timer = null;
        if (timeoutMs > 0) {
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`RPC timeout (${timeoutMs}ms) waiting for ${method}`));
          }, timeoutMs);
          timer.unref?.();
        }
        pending.set(id, { resolve, reject, timer });
        const ok = writeJson({ jsonrpc: "2.0", id, method, params });
        if (!ok) {
          if (timer) clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`Failed to write RPC request ${method} to engine stdin`));
        }
      });
    },
    notify(method, params = {}) {
      return writeJson({ jsonrpc: "2.0", method, params });
    },
    reply(id, result) {
      return writeJson({ jsonrpc: "2.0", id, result });
    },
    replyError(id, code, message) {
      return writeJson({ jsonrpc: "2.0", id, error: { code, message } });
    },
    closeStdin() {
      try {
        if (proc.stdin && !proc.stdin.destroyed) {
          proc.stdin.end();
        }
      } catch {}
    },
    dispose(reason = new Error("RPC connection disposed")) {
      rejectAllPending(reason);
      this.closeStdin();
    },
  };
}

/**
 * Classify raw engine error messages into AgentTower-aligned error categories.
 */
export function classifyEngineError(error = "", rpcCode) {
  const text = typeof error === "object" && error ? [error.message, error.code, error.status].filter(Boolean).join(" ") : String(error);
  const explicit = typeof error === "object" && error ? error : {};
  const code = rpcCode ?? explicit.rpcCode ?? explicit.status;
  if (/insufficient.quota|\bbilling\b|credit balance|monthly limit|quota (?:has been )?(?:exceeded|exhausted)/i.test(text)) {
    return { category: "quota_exhausted", isRetryable: false };
  }
  if ([429, 502, 503, 504].includes(Number(code)) || /\b(?:429|502|503|504|ECONNRESET|ETIMEDOUT)\b|too many requests|rate[ _-]?limit|overloaded/i.test(text)) {
    const hint = /retry[ _-]?after[\s"']*[:=]\s*["']?([^\r\n"'}]+)/i.exec(text)?.[1]?.trim();
    const inline = /(?:retry[ _-]?after|retry in)\s*[:=]?\s*["']?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|seconds?|secs?|s)?/i.exec(text);
    const date = hint ? Date.parse(hint) : NaN;
    const retryAfterMs = explicit.retryAfterMs ?? (inline
      ? Number(inline[1]) * (/^m/i.test(inline[2] || "") ? 1 : 1000)
      : Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined);
    return { category: "rate_limit_transient", isRetryable: true,
      ...(Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? { retryAfterMs } : {}) };
  }
  let category = "provider_error";
  if (/quota|usage limit/i.test(text)) category = "usage_limit";
  else if (/auth|login|\b401\b/i.test(text)) category = "permission_error";
  else if (code === -32602) category = "validation_error";
  else if (/spawn|econn|eof|exited/i.test(text)) category = "transport_error";
  return { category, isRetryable: false };
}

/**
 * True only when a resume/load failure clearly means the native session no longer exists
 * (so starting a fresh session is safe). Transient failures (timeouts, transport, auth,
 * rate limits, generic internal errors) return false so callers surface them and keep
 * the bound nativeSessionId instead of silently forking a new context.
 */
export function isMissingSessionError(err) {
  const message = String(err?.message || err || "");
  if (/timeout|timed out|transport|connection|econn|epipe|eof|exited|auth|login|credential|forbidden|permission|\b40[13]\b|\b429\b|rate[ _-]?limit|overloaded|quota/i.test(message)) {
    return false;
  }
  return /^(?:unknown|no such) (?:session|thread|conversation|rollout)\b|^no rollout found\b|\b(?:session|thread|conversation|rollout)(?:\s+id)?(?:\s+["'`]?[-\w]+["'`]?)?\s+(?:not found|(?:does not|doesn't|no longer) exist(?:s)?|(?:is )?(?:missing|not persisted|expired))\b/i.test(message);
}

/** JSON-RPC "method not found" (the agent does not implement this optional method). */
export function isMethodNotFoundError(err) {
  return Number(err?.rpcCode) === -32601 || /^(?:method not found|unknown method|unsupported method)(?=[:\s]|$)/i.test(String(err?.message || ""));
}

/**
 * Resume an ACP session (`session/resume`, then `session/load` when resume is unimplemented) and only fall back to
 * `session/new` only when the agent clearly reports the session is gone.
 * Transient failures are rethrown so the caller keeps its nativeSessionId instead of silently losing context.
 */
export async function resumeOrCreateAcpSession(rpc, { nativeSessionId, cwd, resumeTimeoutMs = 15000, newTimeoutMs = 15000,
  methods = ["session/resume", "session/load"] } = {}) {
  if (nativeSessionId) {
    const params = { sessionId: nativeSessionId, cwd, mcpServers: [] };
    let unsupported;
    let missing = false;
    for (const method of methods) {
      try {
        const sessionData = await rpc.request(method, params, resumeTimeoutMs);
        return { sessionId: nativeSessionId, sessionData: sessionData || {}, resumed: true, method };
      } catch (err) {
        if (isMethodNotFoundError(err)) { unsupported = err; continue; }
        if (isMissingSessionError(err)) { missing = true; break; }
        throw err;
      }
    }
    if (!missing) throw new Error("ACP 无法恢复此会话：引擎不支持恢复或加载；未另建会话。", { cause: unsupported });
  }
  const created = await rpc.request("session/new", { cwd, mcpServers: [] }, newTimeoutMs);
  return { sessionId: created?.sessionId, sessionData: created || {}, resumed: false, method: "session/new" };
}

export function classifyErrorCategory(errMessage = "", rpcCode) {
  return classifyEngineError(errMessage, rpcCode).category;
}

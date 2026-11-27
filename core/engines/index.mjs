import { nativePath, ensureMainRoot } from "../storage-paths.mjs";
import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BUILTIN_EXTENSION_TEMPLATES,
  INHERIT_EFFORT,
  ROUTER_DEFAULT_MODEL,
  isInheritedEffort,
  isInheritedModel,
  assertAgySubagentModel,
  assertReadOnlySupport,
  inferProviderFromModel,
  normalizeProviderId,
} from "../catalog.mjs";
import { runClaudeTurn } from "./claude-code.mjs";
import { runAgyTurn } from "./agy-acp.mjs";
import {
  buildAgyPinnedModelId,
  execHostAgentApi,
  inferCallingHostConversation,
  ingestNativeConversation,
  readNativeConversationTitle,
  readNativeSwarmSnapshot,
  readNativeTranscriptSnapshot,
  resolveConversationRoot,
  resolveDefaultAppDataDir,
  resolveNativeSwarmLocation,
  resolveTranscriptPath,
  runAgyNativeTurn,
} from "./agy-native.mjs";
import { runCodexReview, runCodexTurn } from "./codex-driver.mjs";
import { probeAcpProvider, runGenericAcpTurn } from "./generic-acp.mjs";
import {
  expandCliTemplateArgs,
  probeCliProvider,
  runGenericCliTurn,
} from "./generic-cli.mjs";
import { runKimiTurn } from "./kimi-acp.mjs";
import { createWarmPool } from "./warm-pool.mjs";
import {
  detectCommandOnSystem,
  resolveAgyBinary,
  resolveCodexBinary,
  resolveClaudeBinary,
  resolveExternalCommand,
  resolveHostAgentApiBinary,
  resolveKimiBinary,
} from "./proc-utils.mjs";

export {
  buildAgyPinnedModelId,
  detectCommandOnSystem,
  execHostAgentApi,
  expandCliTemplateArgs,
  inferCallingHostConversation,
  ingestNativeConversation,
  probeAcpProvider,
  probeCliProvider,
  readNativeConversationTitle,
  readNativeSwarmSnapshot,
  readNativeTranscriptSnapshot,
  resolveConversationRoot,
  resolveDefaultAppDataDir,
  resolveExternalCommand,
  resolveHostAgentApiBinary,
  resolveNativeSwarmLocation,
  resolveTranscriptPath,
  runAgyNativeTurn,
  runGenericAcpTurn,
  runGenericCliTurn,
};

function findTemplateById(id = "") {
  const key = String(id || "").trim().toLowerCase();
  if (!key) return null;
  return (
    BUILTIN_EXTENSION_TEMPLATES.find(
      (t) => t.id === key || (Array.isArray(t.aliases) && t.aliases.includes(key))
    ) || null
  );
}

/**
 * Create the unified multi-engine runtime manager driving:
 * - Antigravity CLI (`agy acp`) for managed turns; native host attachment stays separate
 * - Claude Code CLI (`claude -p --output-format stream-json`)
 * - Kimi Code CLI (`kimi acp` over stdio JSON-RPC)
 * - Codex CLI (`codex app-server --listen stdio://` + `codex exec review --json`)
 * - Any ACP or CLI Extension Provider (`generic-acp.mjs` / `generic-cli.mjs`: OpenCode, Gemini CLI, Cursor Agent, Grok, Kiro, Goose, Aider, or user-defined custom providers)
 *
 * Validates provider/model compatibility at the execution boundary and tracks active handles
 * & transcript watchers for clean daemon shutdown / cascading cancellation.
 */
function publicBinary(bin) {
  if (!bin) return null;
  return Object.fromEntries(["command", "prefixArgs", "resolvedPath", "versionHint", "available"]
    .filter((key) => Object.hasOwn(bin, key)).map((key) => [key, bin[key]]));
}

export function createEngineManager({
  pluginDataDir,
  hostEnv = {},
  appDataDir,
  agentApiExe,
  getCustomProviders,
  warmPoolOptions,
} = {}) {
  const activeHandles = new Set();
  const closingHandles = new Set();
  const warmPool = createWarmPool({ ...warmPoolOptions, pluginDataDir });
  let shutdown;
  const activeWatchers = new Map();

  let currentHostEnv = {
    ...(hostEnv || {}),
    ...(agentApiExe ? { ANTIGRAVITY_AGENTAPI_EXE: agentApiExe } : {}),
  };
  let currentAppDataDir = appDataDir || null;

  function registerHandle(handle, threadId, cwd) {
    const entry = { handle, threadId, cwd };
    activeHandles.add(entry);
    closingHandles.add(entry);
    const settled = () => { activeHandles.delete(entry); };
    void handle.result.then(settled, settled);
    handle.closed = Promise.resolve(handle.closed ?? handle.result).then(() => {}, () => {});
    void handle.closed.then(() => { closingHandles.delete(entry); });
    return handle;
  }

  async function waitForClosed(matches, timeoutMs) {
    const closing = [...closingHandles].filter(matches);
    if (!closing.length) return;
    let timer;
    try {
      await Promise.race([
        Promise.all(closing.map(({ handle }) => handle.closed)),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error("等待引擎释放会话或工作目录超时。"), {
            code: "ENGINE_CLOSE_TIMEOUT",
          })), timeoutMs);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }

  function assertRunning() {
    if (shutdown) throw Object.assign(new Error("引擎管理器已进入关闭流程。"), { code: "ENGINE_MANAGER_SHUTDOWN" });
  }

  function resolveExtensionConfig(providerId, opts = {}) {
    if (opts.providerConfig && typeof opts.providerConfig === "object") {
      const tpl = findTemplateById(opts.providerConfig.templateId || providerId);
      return {
        ...(tpl || {}),
        ...opts.providerConfig,
        id: providerId,
      };
    }

    const customList = Array.isArray(opts.customProviders)
      ? opts.customProviders
      : typeof getCustomProviders === "function"
        ? getCustomProviders() || []
        : [];

    const matchedCustom = customList.find(
      (item) =>
        item &&
        typeof item === "object" &&
        normalizeProviderId(item.id || item.providerId) === providerId
    );
    if (matchedCustom) {
      if (matchedCustom.enabled === false) {
        return { ...matchedCustom, _disabled: true };
      }
      const tpl = findTemplateById(matchedCustom.templateId || providerId);
      return {
        ...(tpl || {}),
        ...matchedCustom,
        id: providerId,
      };
    }

    const tpl = findTemplateById(providerId);
    if (tpl) {
      return {
        ...tpl,
        id: tpl.id,
      };
    }

    return null;
  }

  return {
    pluginDataDir: pluginDataDir || null,

    /**
     * Dynamically update host bridge context (`appDataDir`, `agentApiExe`, `ANTIGRAVITY_LS_ADDRESS`, `ANTIGRAVITY_CSRF_TOKEN`)
     * when reported by an active Antigravity Sidecar/MCP session.
     */
    setHostContext(next = {}) {
      if (next.hostEnv && typeof next.hostEnv === "object") {
        currentHostEnv = { ...currentHostEnv, ...next.hostEnv };
      }
      if (next.agentApiExe) {
        currentHostEnv = {
          ...currentHostEnv,
          ANTIGRAVITY_AGENTAPI_EXE: String(next.agentApiExe),
        };
      }
      if (next.lsAddress) {
        currentHostEnv = {
          ...currentHostEnv,
          ANTIGRAVITY_LS_ADDRESS: String(next.lsAddress),
        };
      }
      if (next.csrfToken) {
        currentHostEnv = {
          ...currentHostEnv,
          ANTIGRAVITY_CSRF_TOKEN: String(next.csrfToken),
        };
      }
      if (next.appDataDir) {
        currentAppDataDir = String(next.appDataDir);
      }
      return this.getHostContext();
    },

    /**
     * Inspect current host bridge status (secret-safe: never exposes CSRF tokens).
     */
    getHostContext() {
      const resolvedAppData = resolveDefaultAppDataDir(currentAppDataDir, currentHostEnv);
      const agentApi = resolveHostAgentApiBinary(currentHostEnv);
      return {
        appDataDir: resolvedAppData,
        agentApiExe: agentApi.executable,
        hostBridgeAvailable: Boolean(agentApi.available),
      };
    },

    /**
     * Launch or resume a turn on any built-in or extension engine with normalized streaming events.
     */
    runTurn(opts = {}) {
      assertRunning();
      const {
        runId = `run_${crypto.randomUUID().slice(0, 8)}`,
        threadId = "",
        provider: rawProvider,
        model: rawModel,
        effort: rawEffort,
        permissionMode = "auto",
        interactionMode = "default",
        cwd: rawCwd,
        nativeSessionId,
        prompt = "",
        ephemeral = false,
        onEvent,
        onPermissionRequest,
        onQuestionRequest,
      } = opts;
      const cwd = nativePath(rawCwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());

      const customList = Array.isArray(opts.customProviders)
        ? opts.customProviders
        : typeof getCustomProviders === "function"
          ? getCustomProviders() || []
          : [];

      const model = isInheritedModel(rawModel) ? ROUTER_DEFAULT_MODEL : rawModel;
      const effort = isInheritedEffort(rawEffort) ? INHERIT_EFFORT : rawEffort;
      const provider = normalizeProviderId(rawProvider) || inferProviderFromModel(model, customList) ||
        (model && !isInheritedModel(model) ? "" : "kimi-code");
      if (!provider) throw Object.assign(new Error("Explicit model requires a provider."), { code: "PROVIDER_REQUIRED" });
      assertAgySubagentModel(provider, model ?? ROUTER_DEFAULT_MODEL);
      assertReadOnlySupport(provider, permissionMode);

      const driverOpts = {
        runId,
        threadId,
        provider,
        model,
        effort,
        permissionMode,
        interactionMode,
        cwd,
        nativeSessionId,
        prompt,
        freshSessionPrompt: opts.freshSessionPrompt,
        ephemeral: Boolean(ephemeral),
        asyncTeardown: opts.asyncTeardown ?? true,
        inheritHostMcp: opts.inheritHostMcp === true,
        mcpServers: opts.mcpServers,
        resolveBinary: opts.resolveBinary,
        onEvent,
        onPermissionRequest,
        onQuestionRequest,
      };

      let handle;
      if (provider === "kimi-code") {
        handle = runKimiTurn({ ...driverOpts, warmPool });
      } else if (provider === "codex") {
        handle = runCodexTurn({ ...driverOpts, warmPool });
      } else if (provider === "claude-code") {
        handle = runClaudeTurn(driverOpts);
      } else if (provider === "antigravity") {
        const mergedHostEnv = {
          ...currentHostEnv,
          ...(opts.hostEnv || {}),
          ...(opts.agentApiExe ? { ANTIGRAVITY_AGENTAPI_EXE: opts.agentApiExe } : {}),
        };
        const hostReady = resolveHostAgentApiBinary(mergedHostEnv).available;
        const useNativeHost = opts.forceAcp !== true && opts.isNativeHost && hostReady;
        if (!useNativeHost) {
          let configuredMode = "off";
          if (pluginDataDir) {
            try { configuredMode = JSON.parse(readFileSync(path.join(pluginDataDir, "global-settings.json"), "utf8")).antigravityAcpMode || "off"; }
            catch {}
          }
          const acpMode = opts.antigravityAcpMode || configuredMode;
          const env = { ...process.env, ...mergedHostEnv };
          const hasPaidCredential = ["GEMINI_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT"]
            .some(key => typeof env[key] === "string" && env[key].trim());
          if (acpMode !== "api_key" || !hasPaidCredential) {
            throw Object.assign(new Error("Antigravity 默认仅使用宿主原生 swarm / invoke_subagent；个人 OAuth 下禁止启动 agy acp。仅当显式设置 antigravityAcpMode=api_key 且配置付费 GEMINI_API_KEY 或企业云认证后才可运行。"), {
              code: "AGY_ACP_OAUTH_FORBIDDEN",
            });
          }
          handle = runAgyTurn(driverOpts);
        } else {
          const effectiveAppDataDir =
            opts.appDataDir || currentAppDataDir || resolveDefaultAppDataDir(null, mergedHostEnv);
          handle = runAgyNativeTurn({
            ...driverOpts,
            hostEnv: mergedHostEnv,
            appDataDir: effectiveAppDataDir,
          });
        }
      } else {
        const extCfg = resolveExtensionConfig(provider, {
          providerConfig: opts.providerConfig,
          customProviders: customList,
        });

        if (extCfg && !extCfg._disabled && extCfg.command) {
          const protocol = String(extCfg.protocol || "acp").trim().toLowerCase();
          if (protocol === "cli") {
            handle = runGenericCliTurn({
              ...driverOpts,
              providerConfig: extCfg,
            });
          } else {
            handle = runGenericAcpTurn({
              ...driverOpts,
              providerConfig: extCfg,
            });
          }
        } else {
          const reasonSuffix = extCfg?._disabled
            ? `（扩展平台 "${provider}" 当前已被禁用，请在扩展中心启用）`
            : `（未找到已配置的引擎通道 "${provider}"，请在「平台与扩展中心」添加或启用）`;
          const unsupportedMsg = `不支持或未启用的引擎通道: "${provider}" ${reasonSuffix}`;
          try {
            onEvent?.({
              type: "error",
              runId,
              threadId,
              provider,
              timestamp: Date.now(),
              message: unsupportedMsg,
              error: unsupportedMsg,
              category: "validation_error",
            });
          } catch {}
          return {
            cancel: async () => {},
            forceKill: async () => {},
            steer: async () => ({ supported: false }),
            respondPermission: async () => {},
            respondQuestion: async () => {},
            closed: Promise.resolve(),
            result: Promise.resolve({
              status: "failed",
              stopReason: "unsupported_provider",
              nativeSessionId: nativeSessionId || undefined,
              assistantText: "",
              reasoningText: "",
              error: unsupportedMsg,
            }),
          };
        }
      }

      return registerHandle(handle, threadId, cwd);
    },

    /**
     * Probe an external ACP or CLI provider (live ACP handshake or CLI `--version` check)
     * to discover models, reasoning effort options, and binary health.
     */
    async probeExtensionProvider(cfg = {}) {
      const templateId = cfg.templateId || cfg.id || "";
      const tpl = findTemplateById(templateId);
      const id = normalizeProviderId(cfg.id || tpl?.id || "custom-acp") || "custom-acp";
      const protocol = String(cfg.protocol || tpl?.protocol || "acp").trim().toLowerCase();
      const command = String(cfg.command || tpl?.command || "").trim();
      const args = cfg.args !== undefined ? cfg.args : tpl?.args || (protocol === "acp" ? ["acp"] : []);
      const extraCandidatePaths =
        cfg.extraCandidatePaths || tpl?.extraCandidatePaths || [];

      if (protocol === "cli") {
        return probeCliProvider({
          id,
          command,
          argsTemplate: args,
          env: cfg.env || {},
          cwd: nativePath(cfg.cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot()),
          timeoutMs: cfg.timeoutMs || 6000,
          extraCandidatePaths,
        });
      }

      return probeAcpProvider({
        id,
        command,
        args,
        env: cfg.env || {},
        cwd: nativePath(cfg.cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot()),
        timeoutMs: cfg.timeoutMs || 12000,
        extraCandidatePaths,
      });
    },

    /**
     * Attach a zero-subprocess tailer to an Antigravity native `transcript.jsonl` conversation
     * (and recursively track any `invoke_subagent` child conversations).
     */
    ingestNativeConversation(opts = {}) {
      const convId = String(opts.conversationId || "").trim();
      if (!convId) {
        throw new Error("ingestNativeConversation requires conversationId");
      }
      if (activeWatchers.has(convId)) {
        return activeWatchers.get(convId);
      }

      const effectiveAppDataDir =
        opts.appDataDir || currentAppDataDir || resolveDefaultAppDataDir(null, currentHostEnv);

      const watcher = ingestNativeConversation({
        ...opts,
        conversationId: convId,
        appDataDir: effectiveAppDataDir,
      });

      const originalStop = watcher.stop.bind(watcher);
      watcher.stop = () => {
        activeWatchers.delete(convId);
        return originalStop();
      };

      activeWatchers.set(convId, watcher);
      return watcher;
    },

    /**
     * Read a one-shot parsed snapshot of an Antigravity native `transcript.jsonl`.
     */
    readNativeTranscriptSnapshot(opts = {}) {
      const effectiveAppDataDir =
        opts.appDataDir || currentAppDataDir || resolveDefaultAppDataDir(null, currentHostEnv);
      return readNativeTranscriptSnapshot({
        ...opts,
        appDataDir: effectiveAppDataDir,
      });
    },

    /**
     * Read native Antigravity `/swarm` members, board messages (#seq), and directed @mention edges.
     */
    readNativeSwarmSnapshot(opts = {}) {
      const effectiveAppDataDir =
        opts.appDataDir || currentAppDataDir || resolveDefaultAppDataDir(null, currentHostEnv);
      return readNativeSwarmSnapshot({
        ...opts,
        appDataDir: effectiveAppDataDir,
      });
    },

    /**
     * Resolve any conversationId (coordinator, Swarm worker, or invoke_subagent child)
     * to its root main conversationId.
     */
    resolveConversationRoot(conversationId, explicitAppDataDir) {
      const effectiveAppDataDir =
        explicitAppDataDir || currentAppDataDir || resolveDefaultAppDataDir(null, currentHostEnv);
      return resolveConversationRoot(conversationId, effectiveAppDataDir);
    },

    /**
     * Infer the calling host conversationId when an MCP tool is invoked without explicit `conversationId`.
     */
    inferCallingHostConversation(opts = {}) {
      const effectiveAppDataDir =
        opts.appDataDir || currentAppDataDir || resolveDefaultAppDataDir(null, currentHostEnv);
      return inferCallingHostConversation({
        ...opts,
        appDataDir: effectiveAppDataDir,
      });
    },

    /**
     * Extract a clean display title for a native Antigravity conversation (Swarm title or cleaned first USER_INPUT).
     */
    readNativeConversationTitle(conversationId, explicitAppDataDir) {
      const effectiveAppDataDir =
        explicitAppDataDir || currentAppDataDir || resolveDefaultAppDataDir(null, currentHostEnv);
      return readNativeConversationTitle(conversationId, effectiveAppDataDir);
    },

    /**
     * Stop watching a specific native conversation transcript (if active).
     */
    stopNativeConversationWatcher(conversationId) {
      const key = String(conversationId || "").trim();
      const watcher = activeWatchers.get(key);
      if (!watcher) return false;
      watcher.stop();
      activeWatchers.delete(key);
      return true;
    },

    /**
     * Run non-interactive defect-first code review via Codex (`gpt-6-astra` by default).
     */
    runReview(opts = {}) {
      assertRunning();
      const cwd = nativePath(opts.cwd || process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
      const handle = runCodexReview({
        cwd,
        inheritHostMcp: opts.inheritHostMcp === true,
        resolveBinary: opts.resolveBinary,
        scope: opts.scope || "uncommitted",
        baseBranch: opts.baseBranch,
        commitSha: opts.commitSha,
        model: isInheritedModel(opts.model) ? ROUTER_DEFAULT_MODEL : opts.model,
        effort: isInheritedEffort(opts.effort) ? INHERIT_EFFORT : opts.effort,
        prompt: opts.prompt,
        ephemeral: opts.ephemeral !== undefined ? Boolean(opts.ephemeral) : true,
        asyncTeardown: opts.asyncTeardown ?? true,
        onEvent: opts.onEvent,
      });
      return registerHandle(handle, opts.threadId, cwd);
    },

    /**
     * Inspect resolved local CLI binary paths + native host bridge binary.
     */
    probeBinaries() {
      return {
        "kimi-code": publicBinary(resolveKimiBinary()),
        codex: publicBinary(resolveCodexBinary()),
        "claude-code": publicBinary(resolveClaudeBinary()),
        antigravity: publicBinary(resolveAgyBinary()),
        "antigravity-host": publicBinary(resolveHostAgentApiBinary(currentHostEnv)),
      };
    },

    /**
     * Number of currently running engine turns/reviews.
     */
    getActiveCount() {
      return activeHandles.size;
    },

    drainWarmPool() {
      return warmPool.drain();
    },

    waitForThreadClosed(threadId, timeoutMs = 5000) {
      return waitForClosed(entry => Boolean(threadId) && entry.threadId === threadId, timeoutMs);
    },

    waitForPathClosed(targetPath, timeoutMs = 5000) {
      if (!targetPath) return Promise.resolve();
      const normalize = value => {
        const absolute = path.resolve(nativePath(value));
        return process.platform === "win32" ? absolute.toLowerCase() : absolute;
      };
      const root = normalize(targetPath);
      return waitForClosed(({ cwd }) => {
        const relative = path.relative(root, normalize(cwd));
        return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
      }, timeoutMs);
    },

    /** Stop managed processes and wait until they have released their resources. */
    shutdownAll() {
      return shutdown ??= (async () => {
        await warmPool.drain();
        for (const watcher of activeWatchers.values()) {
          try { watcher.stop(); } catch {}
        }
        activeWatchers.clear();
        const detached = new Set();
        await Promise.allSettled([...activeHandles].map(async ({ handle }) => {
          if (handle.detach) {
            detached.add(handle);
            handle.detach();
          } else {
            await handle.forceKill();
          }
        }));
        await Promise.all([...closingHandles].filter(({ handle }) => !detached.has(handle)).map(({ handle }) => handle.closed));
        activeHandles.clear();
        await warmPool.drain();
      })();
    },
  };
}

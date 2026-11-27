import { PLUGIN_VERSION } from "./daemon-client.mjs";
import { atomicJson, nativePath, ensureMainRoot } from "./storage-paths.mjs";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  spawnNoWindow, captureNoWindow,
  buildCleanChildEnv, createNdjsonRpcConnection, detectCommandOnSystem,
  resolveAgyBinary, resolveClaudeBinary, resolveCodexBinary, resolveHostAgentApiBinary, resolveKimiBinary, safeCatalogText,
  forceKillProcessTree, flattenAcpOptions,
} from "./engines/proc-utils.mjs";

export const ROUTER_DEFAULT_MODEL = "__default__";
export const INHERIT_EFFORT = "inherit";
export function isInheritedModel(v) {
  return typeof v === "string" && [ROUTER_DEFAULT_MODEL, "inherit", "router"].includes(v.trim().toLowerCase());
}
export function isInheritedEffort(v) {
  return typeof v === "string" && [INHERIT_EFFORT, ROUTER_DEFAULT_MODEL, "default"].includes(v.trim().toLowerCase());
}

/**
 * Map base AGY model + effort to Language Server's pinned model variant ID for native Swarm.
 */
export function buildAgyPinnedModelId(rawModel = "gemini-4-hydrogen", rawEffort = "high") {
  if (isInheritedModel(rawModel)) return "gemini-4-hydrogen-high";
  const split = splitAgyModelVariant(rawModel);
  const base = split.model || "gemini-4-hydrogen";
  if (isAgyOrchestratorModel(base)) {
    return base;
  }
  if (base === "pro" || base === "flash" || base === "flash_lite") {
    return base;
  }
  const eff = normalizeEffortForTarget("antigravity", base, split.effort || rawEffort || "high");
  return isInheritedEffort(eff) ? base : `${base}-${eff}`;
}

// Native swarm names are limited to 24 characters; retain distinct long preset IDs.
export function swarmMemberName(key) {
  const name = String(key).toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  if (name.length <= 24) return name;
  return `${name.slice(0, 15)}-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`;
}

export const DEFAULT_ROLE_PRESETS = Object.freeze({
  curator_codex: Object.freeze({
    key: "curator_codex", group: "curator", label: "规范维护官 · GPT-6.2 Astra",
    role: "curator", provider: "codex", model: "gpt-6.2-astra", effort: "high",
    permissionMode: "read-only", interactionMode: "plan", isolation: "shared",
  }),
  commander: Object.freeze({
    key: "commander",
     group: null,
     builtin: true,
     enabled: true,
    id: "commander",
    label: "总指挥 · Gemini 4 Carbon",
    title: "总指挥 (Commander)",
    role: "general",
    provider: "antigravity",
    model: "gemini-4-carbon",
    fallbackModel: "gemini-4-argon",
    effort: "high",
    permissionMode: "always-proceed",
    runtimeMode: "always-proceed",
    interactionMode: "default",
    isolation: "shared",
    description: "全局需求澄清、任务拆解、跨引擎派单统筹与最终收敛交付（备选 Gemini 4 Argon）",
  }),
  advisor_kimi: Object.freeze({
    key: "advisor_kimi",
     group: "advisor",
     builtin: true,
     enabled: true,
    id: "advisor_kimi",
    label: "军师 A · Kimi K3.1 Pro",
    title: "首席全景架构军师 (Kimi)",
    role: "design",
    provider: "kimi-code",
    model: "kimi-code/k3.1-pro",
    effort: "max",
    permissionMode: "plan",
    runtimeMode: "plan",
    interactionMode: "plan",
    isolation: "shared",
    description: "依托 1M 超长上下文通读全仓，输出架构蓝图、模块接口契约与全局风险清单",
  }),
  advisor_codex: Object.freeze({
    key: "advisor_codex",
     group: "advisor",
     builtin: true,
     enabled: true,
    id: "advisor_codex",
    label: "军师 B · GPT-6.2 Astra",
    title: "深度逻辑推演军师 (Codex)",
    role: "advisor",
    provider: "codex",
    model: "gpt-6.2-astra",
    effort: "xhigh",
    permissionMode: "read-only",
    runtimeMode: "read-only",
    interactionMode: "plan",
    isolation: "shared",
    description: "与 K3.1 Pro 交叉对撞，严密推演状态机、并发竞争、算法复杂度与边界条件",
  }),
  advisor_claude: Object.freeze({
    key: "advisor_claude",
     group: "advisor",
     builtin: true,
     enabled: true,
    id: "advisor_claude",
    label: "军师 C · Claude Opus 5.5",
    title: "全栈与产品架构军师 (Claude)",
    role: "design",
    provider: "claude-code",
    model: "claude-opus-5-5",
    effort: "xhigh",
    permissionMode: "plan",
    runtimeMode: "plan",
    interactionMode: "plan",
    isolation: "shared",
    description: "依托 Claude Opus 5.5 审视前后端产品交互一致性、代码可维护性与工程权衡",
  }),
  executor_kimi: Object.freeze({
    key: "executor_kimi",
     group: "executor",
     builtin: true,
     enabled: true,
    id: "executor_kimi",
    label: "执行主力 · Kimi K3.1 Pro",
    title: "大规模贯通执行官 (Kimi)",
    role: "implementation",
    provider: "kimi-code",
    model: "kimi-code/k3.1-pro",
    effort: "high",
    permissionMode: "auto",
    runtimeMode: "auto",
    interactionMode: "default",
    isolation: "shared",
    description: "负责跨多文件联动开发、协议胶水层实现、脚本工具链与中文技术规范落地",
  }),
  executor_codex: Object.freeze({
    key: "executor_codex",
     group: "executor",
     builtin: true,
     enabled: true,
    id: "executor_codex",
    label: "执行攻坚 · GPT-6.2 Sol",
    title: "系统与算法攻坚执行官 (Codex)",
    role: "implementation",
    provider: "codex",
    model: "gpt-6.2-sol",
    effort: "high",
    permissionMode: "full-access",
    runtimeMode: "full-access",
    interactionMode: "default",
    isolation: "shared",
    description: "负责核心后端服务、数据库事务状态机、复杂重构与单元测试闭环验证",
  }),
  executor_claude: Object.freeze({
    key: "executor_claude",
     group: "executor",
     builtin: true,
     enabled: true,
    id: "executor_claude",
    label: "全能执行 · Claude Opus 5.5",
    title: "前后端小全能执行官 (Claude)",
    role: "implementation",
    provider: "claude-code",
    model: "claude-opus-5-5",
    effort: "xhigh",
    permissionMode: "bypassPermissions",
    runtimeMode: "bypassPermissions",
    interactionMode: "default",
    isolation: "shared",
    description: "负责前后端一体中小型全栈功能贯通开发、UI 交互与验证落地",
  }),
  executor_hydrogen: Object.freeze({
    key: "executor_hydrogen",
     group: "executor",
     builtin: true,
     enabled: true,
    id: "executor_hydrogen",
    label: "执行前端/推演 · Gemini 4 Hydrogen",
    title: "UI 与全栈极速执行官 (Hydrogen)",
    role: "implementation",
    provider: "antigravity",
    model: "gemini-4-hydrogen",
    effort: "high",
    permissionMode: "accept-edits",
    runtimeMode: "accept-edits",
    interactionMode: "default",
    isolation: "shared",
    description: "负责高交互可视化面板、现代前端组件体系与多模态全栈构建（难点可升 xhigh）",
  }),
  reviewer: Object.freeze({
    key: "reviewer",
     group: "reviewer",
     builtin: true,
     enabled: true,
    id: "reviewer",
    label: "审改终审官 · GPT-6.2 Astra",
    title: "Defect-First 审改一体闭环",
    role: "review",
    provider: "codex",
    model: "gpt-6.2-astra",
    effort: "xhigh",
    permissionMode: "full-access",
    runtimeMode: "full-access",
    interactionMode: "default",
    isolation: "shared",
    description: "严查变更中的缺陷，当场修复并验证，然后汇报主会话。",
  }),
});

/**
 * Built-in fallback catalogs (used if ~/.agent-tower/caches/*.json is absent or unreadable).
 * Zero credentials or personal identifiers.
 */
const BUILTIN_KIMI_MODELS = [
  { slug: "kimi-code/k3.1-pro", name: "K3.1 Pro", isDefault: true },
  { slug: "kimi-code/k3.1-pro-highspeed", name: "K3.1 Pro Highspeed 2x Usage Cost" },
  { slug: "kimi-code/kimi-for-coding", name: "K2.8 Preview" },
  { slug: "kimi-code/kimi-for-coding-highspeed", name: "K2.7 Code Highspeed" },
  { slug: "kimi-code/k3", name: "K3" },
  { slug: "kimi-code/k3-256k", name: "K3-256k" },
];

const BUILTIN_CODEX_MODELS = [
  { slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-6.2-astra", name: "GPT-6.2-Astra", isDefault: true, defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-6.1-sol", name: "GPT-6.1-Sol", defaultEffort: "low", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-astra", name: "GPT-6-Astra", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6.1-terra", name: "GPT-6.1 Terra", defaultEffort: "low", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-6-luna", name: "GPT-6-Luna", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-6-sol", name: "GPT-6-Sol", isLegacy: true, defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-sol", name: "GPT-5.6-Sol", isLegacy: true, defaultEffort: "low", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-terra", name: "GPT-5.6-Terra", isLegacy: true, defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
  { slug: "gpt-5.6-luna", name: "GPT-5.6-Luna", isLegacy: true, defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "gpt-5.5", name: "GPT-5.5", isLegacy: true, defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
];

const BUILTIN_CLAUDE_MODELS = [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isDefault: true, defaultEffort: "xhigh", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh", "max"] },
  { slug: "claude-haiku-5-5", name: "Claude Haiku 5.5", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
];

const BUILTIN_AGY_MODELS = [
  { slug: "gemini-4-carbon", name: "Gemini 4 Carbon", isDefault: true, defaultEffort: "medium", efforts: ["low", "medium", "high"] },
  { slug: "gemini-4-argon", name: "Gemini 4 Argon", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
  { slug: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh"] },
  { slug: "gemini-4-neon", name: "Gemini 4 Neon", defaultEffort: "high", efforts: ["low", "medium", "high", "xhigh"] },
  { slug: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)", efforts: [] },
  { slug: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", efforts: [] },
  { slug: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)", efforts: [] },
  { slug: "gemini-3.8-flash", name: "Gemini 3.8 Flash", defaultEffort: "medium", efforts: ["low", "medium", "high"] },
];

/**
 * Built-in Extension Hub Templates (7 mainstream external Agent platforms with auto-detection).
 */
export const BUILTIN_EXTENSION_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "opencode",
    displayName: "OpenCode",
    protocol: "acp",
    command: "opencode",
    args: Object.freeze(["acp"]),
    argsTemplate: "acp",
    description: "开源终端编程 Agent 平台（标准 ACP 协议接入）",
    installHint: "npm install -g opencode-ai",
    homeSubdir: ".opencode",
    defaultModels: Object.freeze([
      Object.freeze({ slug: "opencode/default", name: "OpenCode Default", isDefault: true }),
    ]),
  }),
  Object.freeze({
    id: "gemini-cli",
    displayName: "Gemini CLI",
    protocol: "acp",
    command: "gemini",
    args: Object.freeze(["--acp"]),
    argsTemplate: "--acp",
    description: "Google 官方开源 Gemini CLI（标准 ACP 协议模式）",
    installHint: "npm install -g @google/gemini-cli",
    homeSubdir: ".gemini",
    defaultModels: Object.freeze([
      Object.freeze({ slug: "gemini-2.5-pro", name: "Gemini Pro", isDefault: true }),
      Object.freeze({ slug: "gemini-2.5-flash", name: "Gemini Flash" }),
    ]),
  }),
  Object.freeze({
    id: "qwen-code",
    aliases: Object.freeze(["qwen"]),
    displayName: "Qwen Code",
    protocol: "acp",
    command: "qwen",
    args: Object.freeze(["--acp"]),
    argsTemplate: "--acp",
    homeSubdir: ".qwen",
    installHint: "npm install -g @qwen-code/qwen-code",
    defaultModels: Object.freeze([
      Object.freeze({ slug: "qwen3-coder-plus", name: "Qwen3 Coder Plus", isDefault: true }),
    ]),
  }),
  Object.freeze({
    id: "cursor",
    displayName: "Cursor Agent",
    protocol: "acp",
    command: "cursor-agent",
    args: Object.freeze(["acp"]),
    argsTemplate: "acp",
    description: "Cursor CLI / Background Agent（ACP 协议模式）",
    installHint: "cursor-agent install",
    homeSubdir: ".cursor",
    defaultModels: Object.freeze([
      Object.freeze({ slug: "cursor/auto", name: "Cursor Auto", isDefault: true }),
    ]),
  }),
  Object.freeze({
    id: "grok",
    displayName: "Grok CLI",
    protocol: "acp",
    command: "grok",
    args: Object.freeze(["acp"]),
    argsTemplate: "acp",
    description: "xAI Grok 编程智能体 CLI（ACP 协议模式）",
    installHint: "grok-cli",
    homeSubdir: ".grok",
    defaultModels: Object.freeze([
      Object.freeze({ slug: "grok-4", name: "Grok 4", isDefault: true }),
      Object.freeze({ slug: "grok-code-fast-1", name: "Grok Code Fast" }),
    ]),
  }),
  Object.freeze({
    id: "kiro",
    displayName: "Kiro CLI",
    protocol: "acp",
    command: "kiro-cli",
    args: Object.freeze(["acp"]),
    argsTemplate: "acp",
    description: "AWS Kiro Spec-Driven Agent CLI（ACP 协议模式）",
    installHint: "kiro-cli",
    homeSubdir: ".kiro",
    defaultModels: Object.freeze([
      Object.freeze({ slug: "kiro/default", name: "Kiro Default", isDefault: true }),
    ]),
  }),
  Object.freeze({
    id: "goose",
    displayName: "Goose Agent",
    protocol: "acp",
    command: "goose",
    args: Object.freeze(["acp"]),
    argsTemplate: "acp",
    description: "Block Goose 开源可扩展工程 Agent（ACP 协议模式）",
    installHint: "pipx install goose-ai",
    homeSubdir: ".config/goose",
    defaultModels: Object.freeze([
      Object.freeze({ slug: "goose/default", name: "Goose Default", isDefault: true }),
    ]),
  }),
  Object.freeze({
    id: "aider",
    displayName: "Aider CLI",
    protocol: "cli",
    command: "aider",
    args: Object.freeze(["--model", "{{model}}", "--yes-always", "--no-pretty", "--message", "{{prompt}}"]),
    argsTemplate: "--model {{model}} --yes-always --no-pretty --message {{prompt}}",
    description: "经典 Git AI 结对编程命令行（通用 CLI 模板模式）",
    installHint: "pipx install aider-chat",
    homeSubdir: ".aider",
    defaultModels: Object.freeze([
      Object.freeze({ slug: "deepseek/deepseek-coder", name: "DeepSeek Coder", isDefault: true }),
      Object.freeze({ slug: "gpt-4.1", name: "GPT-4.1" }),
    ]),
  }),
]);

/**
 * Normalize customProviders input (Array or Object map) into an Array of configs.
 */
export function normalizeCustomProvidersList(customProviders) {
  if (!customProviders) return [];
  if (Array.isArray(customProviders)) {
    return customProviders.filter((c) => c && typeof c === "object" && (c.id || c.provider));
  }
  if (typeof customProviders === "object") {
    return Object.entries(customProviders)
      .filter(([, v]) => v && typeof v === "object")
      .map(([k, v]) => ({ id: k, ...v }));
  }
  return [];
}

/**
 * Sanitize an extension provider config for public display / API responses:
 * NEVER echoes raw secret values inside `env` — only exposes `envKeys: string[]`!
 */
export function sanitizeExtensionProviderConfig(cfg = {}) {
  const id = String(cfg.id || cfg.provider || "").trim();
  const envObj = cfg.env && typeof cfg.env === "object" ? cfg.env : {};
  const envKeys = Array.isArray(cfg.envKeys)
    ? cfg.envKeys.map(String)
    : Object.keys(envObj);

  const protocol = String(cfg.protocol || "acp").toLowerCase() === "cli" ? "cli" : "acp";
  const args = Array.isArray(cfg.args)
    ? cfg.args.map(String)
    : typeof cfg.args === "string" && cfg.args.trim()
      ? cfg.args.trim().split(/\s+/)
      : protocol === "acp"
        ? ["acp"]
        : ["{{prompt}}"];

  return {
    id,
    provider: id,
    displayName: String(cfg.displayName || cfg.name || id),
    protocol,
    command: String(cfg.command || id).trim(),
    args,
    argsTemplate: typeof cfg.argsTemplate === "string" ? cfg.argsTemplate : args.join(" "),
    enabled: cfg.enabled !== false,
    isExtension: true,
    defaultModel: String(cfg.defaultModel || cfg.models?.[0]?.slug || cfg.models?.[0]?.id || ""),
    efforts: Array.isArray(cfg.efforts) && cfg.efforts.length > 0 ? cfg.efforts.map(String) : ["low", "medium", "high"],
    modes: Array.isArray(cfg.modes) && cfg.modes.length > 0 ? cfg.modes.map(String) : ["default", "plan", "auto"],
    models: Array.isArray(cfg.models)
      ? cfg.models.map((m, idx) => {
          const slug = typeof m === "string" ? m : String(m.slug || m.id || m.value || `model_${idx + 1}`);
          return {
            id: slug,
            slug,
            name: typeof m === "string" ? m : String(m.name || m.label || slug),
            isDefault: Boolean(typeof m === "object" && m.isDefault) || idx === 0,
          };
        })
      : [],
    envKeys,
    updatedAt: cfg.updatedAt || Date.now(),
  };
}

/**
 * Inspect all 7 built-in extension templates with live local binary & directory auto-detection.
 */
export function listExtensionTemplates({ customProviders = [] } = {}) {
  const home = os.homedir();
  const savedMap = new Map(
    normalizeCustomProvidersList(customProviders).map((c) => [String(c.id || c.provider).toLowerCase(), c])
  );

  return BUILTIN_EXTENSION_TEMPLATES.map((tpl) => {
    const binCheck = detectCommandOnSystem(tpl.command);
    const homeDirPath = tpl.homeSubdir ? path.join(home, tpl.homeSubdir) : null;
    const directoryDetected = Boolean(homeDirPath && existsSync(homeDirPath));
    const saved = savedMap.get(tpl.id.toLowerCase());

    return {
      id: tpl.id,
      displayName: tpl.displayName,
      protocol: tpl.protocol,
      command: saved?.command || tpl.command,
      args: saved?.args || [...tpl.args],
      argsTemplate: saved?.argsTemplate || tpl.argsTemplate,
      description: tpl.description,
      installHint: tpl.installHint,
      detected: Boolean(binCheck.detected || directoryDetected),
      binaryDetected: Boolean(binCheck.detected),
      binaryPath: binCheck.binaryPath || null,
      directoryDetected,
      directoryPath: directoryDetected ? homeDirPath : null,
      configured: Boolean(saved),
      enabled: saved ? saved.enabled !== false : false,
      defaultModels: tpl.defaultModels.map((m) => ({ ...m })),
    };
  });
}

export const detectExtensionTemplates = listExtensionTemplates;

/**
 * Normalize provider/driver aliases to canonical IDs:
 * 'kimi-code' | 'codex' | 'antigravity' | 'claude-code'
 */
export function normalizeProviderId(id) {
  if (!id || typeof id !== "string") return "";
  const raw = id.trim();
  const lower = raw.toLowerCase();
  if (
    lower === "acpregistry_kimi_code" ||
    lower === "kimi-code" ||
    lower === "kimi_code" ||
    lower === "kimi" ||
    lower === "moonshot" ||
    lower.startsWith("acpregistry:instance:acpregistry_kimi")
  ) {
    return "kimi-code";
  }
  if (lower === "qwen" || lower === "qwen-code") return "qwen-code";
  if (lower === "codex" || lower === "openai" || lower === "openai-codex") {
    return "codex";
  }
  if (
    lower === "antigravity" ||
    lower === "antigravity-native" ||
    lower === "agy" ||
    lower === "antigravity-cli" ||
    lower === "google"
  ) {
    return "antigravity";
  }
  if (
    lower === "claudeagent" ||
    lower === "claude-agent" ||
    lower === "claude_agent" ||
    lower === "claude" ||
    lower === "claude-code" ||
    lower === "claude_code" ||
    lower === "anthropic"
  ) {
    return "claude-code";
  }
  return raw;
}

/**
 * Infer canonical provider ID from a model slug when no provider is supplied.
 */
export function inferProviderFromModel(model, customProviders = []) {
  if (!model || typeof model !== "string") return "";
  const m = model.trim();
  if (isInheritedModel(m)) return "";
  const lower = m.toLowerCase();
  if (lower.startsWith("gpt-oss")) return "";
  if (lower.startsWith("claude-")) return "claude-code";

  if (Array.isArray(customProviders) && customProviders.length > 0) {
    for (const cp of customProviders) {
      if (!cp || cp.enabled === false) continue;
      const cpId = String(cp.id || cp.provider || "").trim();
      if (!cpId) continue;
      if (lower.startsWith(`${cpId.toLowerCase()}/`)) {
        return cpId;
      }
      if (Array.isArray(cp.models)) {
        const hit = cp.models.some(
          (cm) => String(cm?.slug || cm?.id || cm || "").trim().toLowerCase() === lower
        );
        if (hit) return cpId;
      }
    }
  }

  if (lower.startsWith("kimi-code/")) return "kimi-code";
  if (m.includes("/")) return "";
  if ((!isAgyCoarseSubagentModel(m) && isAllowedAgySubagentModel(m)) || lower === "antigravity-default") return "antigravity";
  if (lower.startsWith("gpt-") || lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4")) {
    return "codex";
  }
  return "";
}

const AGY_ORCHESTRATOR_ALIASES = Object.freeze({
  "orchestrator (neon)": "gemini-pro-orchestrator-neon",
  "orchestrator (carbon)": "gemini-pro-orchestrator",
  "orchestrator (argon)": "gemini-pro-orchestrator-argon",
});

export function canonicalAgyModelSlug(raw) {
  if (typeof raw !== "string") return "";
  const trimmed = raw.trim();
  return AGY_ORCHESTRATOR_ALIASES[trimmed.toLowerCase()] || trimmed;
}

export function isAgyOrchestratorModel(slug) {
  const norm = canonicalAgyModelSlug(slug);
  return Boolean(norm) && /^(?:Orchestrator \([a-z0-9][a-z0-9-]*\)|gemini-pro-orchestrator(?:-[a-z0-9-]+)?)$/i.test(norm);
}

export function isAgyCoarseSubagentModel(slug) {
  return typeof slug === "string" && /^(?:pro|flash|flash_lite)$/i.test(slug.trim());
}

export function isAllowedAgySubagentModel(slug) {
  const norm = canonicalAgyModelSlug(slug);
  return Boolean(norm) && (/^gemini-[a-z0-9][a-z0-9.-]{0,146}$/i.test(norm) || isAgyOrchestratorModel(norm) || isAgyCoarseSubagentModel(norm));
}

export function splitAgyModelVariant(rawModel) {
  if (typeof rawModel !== "string") return { model: "", effort: undefined };
  const trimmed = canonicalAgyModelSlug(rawModel);
  if (trimmed.toLowerCase() === "antigravity-default") return { model: "gemini-4-carbon" };
  const match = !isAgyOrchestratorModel(trimmed) && /^(gemini-[a-z0-9.-]+)-(low|medium|high|xhigh)$/i.exec(trimmed);
  return match ? { model: match[1], effort: match[2].toLowerCase() } : { model: trimmed, effort: undefined };
}

export function assertAgySubagentModel(provider, model) {
  if (normalizeProviderId(provider) === "antigravity" && !isInheritedModel(model) && !isAllowedAgySubagentModel(splitAgyModelVariant(model).model)) {
    throw Object.assign(new Error("Antigravity 子 Agent 只支持 Gemini 和 Google Orchestrator 系列模型。"), { code: "UNSUPPORTED_AGY_MODEL" });
  }
}

async function readJsonSafe(filePath) {
  try {
    const resolved = safeReadablePath(filePath);
    if (!resolved) return null;
    const content = await readFile(resolved, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

const CODEX_CONFIG_FIELDS = new Set([
  "model", "model_provider", "model_reasoning_effort", "review_model", "model_catalog_json", "model_context_window",
]);
const KIMI_MODEL_FIELDS = new Set(["model", "provider", "max_context_size", "support_efforts", "default_effort"]);
const configCache = new Map();
const liveCatalogCache = new Map();
const agyPending = new Map();
const agyProbeRecords = new Map();

function safeReadablePath(filePath) {
  const forbidden = /(?:^|[\\/])auth\.json(?:$|[:.\\/])/i;
  if (!filePath || forbidden.test(filePath)) return "";
  try {
    const resolved = realpathSync(filePath);
    return forbidden.test(resolved) ? "" : resolved;
  } catch { return ""; }
}

function fileState(filePath) {
  if (!filePath) return { fingerprint: "" };
  try {
    const st = statSync(filePath);
    if (st.isFile()) return { fingerprint: `${filePath}:${st.mtimeMs}:${st.size}`, exists: true };
  } catch {}
  return { fingerprint: `${filePath}:missing` };
}

const tomlString = /"(?:[^"\\]|\\.)*"|'[^']*'/u;
const tomlKey = new RegExp(`${tomlString.source}|[\\w-]+`, "gu");
const quoted = new RegExp(`^(?:${tomlString.source})$`, "u");
function decodeTomlString(raw) {
  if (raw[0] === "'") return raw.slice(1, -1);
  try { return JSON.parse(raw.replace(/\\U([\da-f]{8})/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))); } catch { return undefined; }
}

// Scan TOML structure without decoding values or table names outside the whitelist.
function readConfig(filePath, state, kind, refresh = false) {
  const cached = configCache.get(kind);
  if (!refresh && cached?.fingerprint === state.fingerprint) return cached.value;
  const value = { top: Object.create(null), thinking: Object.create(null), models: new Map() };
  const resolved = state.exists && safeReadablePath(filePath);
  if (resolved) {
    try {
      const text = readFileSync(resolved, "utf8");
      const tokens = /"""(?:\\[\s\S]|(?!""")[\s\S])*"""|'{3}[\s\S]*?'{3}|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*'|#[^\r\n]*|\r?\n|[\[\]{}]|[^"'#\r\n\[\]{}]+|./gu;
      let line = "", scope = [], depth = 0;
      const flush = () => {
        const raw = line.trim();
        line = "";
        if (raw.startsWith("[")) {
          const section = raw.match(/^\[([^\r\n]*)\]$/u);
          const keys = section && !raw.startsWith("[[") ? [...section[1].matchAll(tomlKey)].map(([key]) => key) : [];
          const decodeKey = (key = "") => quoted.test(key) ? decodeTomlString(key) : key;
          const head = decodeKey(keys[0]);
          scope = kind === "kimi" && ((head === "models" && keys.length === 2) || (head === "thinking" && keys.length === 1))
            ? [head, ...keys.slice(1).map(decodeKey)] : [null];
          return;
        }
        const assignment = raw.match(/^([\w-]+)\s*=\s*([\s\S]*)$/u);
        if (!assignment) return;
        const [, key, rhs] = assignment;
        let target;
        if (!scope.length && (kind === "codex" ? CODEX_CONFIG_FIELDS.has(key) : key === "default_model")) target = value.top;
        if (kind === "kimi" && scope[0] === "thinking" && key === "effort") target = value.thinking;
        if (kind === "kimi" && scope[0] === "models" && KIMI_MODEL_FIELDS.has(key)) {
          const slug = publicIdentifier(scope[1]);
          if (!slug) return;
          if (!value.models.has(slug)) value.models.set(slug, Object.create(null));
          target = value.models.get(slug);
        }
        if (!target) return;
        if (key === "support_efforts" && rhs.startsWith("[")) {
          target[key] = cleanEfforts([...rhs.matchAll(new RegExp(tomlString.source, "gu"))].map(([x]) => decodeTomlString(x)));
        } else if (/^\d[\d_]*$/.test(rhs)) {
          target[key] = Number(rhs.replaceAll("_", ""));
        } else if (quoted.test(rhs)) {
          const decoded = decodeTomlString(rhs);
          target[key] = key === "model_catalog_json" ? decoded : publicIdentifier(decoded);
        }
      };
      for (const [token] of text.matchAll(tokens)) {
        if (token.startsWith("#")) continue;
        if (/^\r?\n$/.test(token)) {
          if (!depth) flush();
          else line += " ";
        } else {
          if (token === "[" || token === "{") depth++;
          if (token === "]" || token === "}") depth = Math.max(0, depth - 1);
          line += token;
        }
      }
      flush();
    } catch { /* Invalid or unreadable config: use protocol/built-in fallback. */ }
  }
  configCache.set(kind, { fingerprint: state.fingerprint, value });
  return value;
}

function publicIdentifier(value) {
  const safe = safeCatalogText(value);
  return isAgyOrchestratorModel(safe) || /^[\p{L}\p{N}_.:+/-]{1,160}$/u.test(safe) ? safe : "";
}
function cleanEfforts(values) {
  return Array.isArray(values) ? [...new Set(values.map(publicIdentifier).filter(Boolean))] : [];
}
function contextSize(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function getLocalCatalogInputs({ refresh = false } = {}) {
  const home = os.homedir();
  const codexConfigPath = path.resolve(process.env.CODEX_HOME || path.join(home, ".codex"), "config.toml");
  const codexState = fileState(codexConfigPath);
  const codex = readConfig(codexConfigPath, codexState, "codex", refresh).top;
  const rawPath = codex.model_catalog_json;
  const catalogPath = typeof rawPath === "string" && /\.json$/i.test(rawPath) && !/[\x00-\x1f?]/u.test(rawPath) && !/^[a-z][\w+.-]*:\/\//iu.test(rawPath)
    ? safeReadablePath(/^~[\\/]/.test(rawPath) ? path.join(home, rawPath.slice(2)) : path.resolve(path.dirname(codexConfigPath), rawPath)) : "";
  const primaryKimi = path.join(home, ".kimi-code", "config.toml");
  const legacyKimi = path.join(home, ".kimi", "config.toml");
  const kimiState = fileState(primaryKimi);
  const legacyState = kimiState.exists ? null : fileState(legacyKimi);
  const kimi = readConfig(legacyState ? legacyKimi : primaryKimi, legacyState || kimiState, "kimi", refresh);
  return { codex, kimi, catalogPath,
    fingerprint: createHash("sha256").update(JSON.stringify([codexState.fingerprint, fileState(catalogPath).fingerprint,
      kimiState.fingerprint, legacyState?.fingerprint])).digest("hex"),
  };
}

function agyCacheFile(cacheDir = process.env.AGENT_TOWER_DATA_DIR || path.join(os.homedir(), ".gemini", "antigravity", "plugin_data", "agent-tower")) {
  return path.join(cacheDir, "agy-catalog-cache.json");
}

const CATALOG_FINGERPRINT_TTL_MS = 5000;
let catalogFingerprintCache = null;

export function resetCatalogFingerprintCache() {
  catalogFingerprintCache = null;
}

export function getCatalogConfigFingerprint(cacheDir, env = process.env) {
  const useCache = env === process.env;
  const key = String(cacheDir || "");
  const now = Date.now();
  if (useCache && catalogFingerprintCache?.key === key && catalogFingerprintCache.expiresAt > now) {
    return catalogFingerprintCache.value;
  }
  const value = JSON.stringify([getLocalCatalogInputs().fingerprint, fileState(agyCacheFile(cacheDir)).fingerprint,
    agyBinaryFingerprint(resolveAgyBinary()), fileState(resolveClaudeBinary().resolvedPath).fingerprint]);
  if (useCache) catalogFingerprintCache = { key, value, expiresAt: now + CATALOG_FINGERPRINT_TTL_MS };
  return value;
}

const flatOptions = flattenAcpOptions;

async function stopCatalogChild(proc, rpc) {
  rpc?.dispose();
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  let timer;
  await new Promise(resolve => {
    const done = () => { clearTimeout(timer); proc.off("close", done); resolve(); };
    timer = setTimeout(done, 100);
    proc.once("close", done);
  });
  await forceKillProcessTree(proc);
}


async function probeLocalCatalog(resolveBinary, args, timeoutMs, read) {
  let child, rpc, timer;
  try {
    const bin = resolveBinary();
    if (!bin.resolvedPath || /\.(?:cmd|bat)$/i.test(bin.command)) return undefined;
    const cwd = nativePath(process.env.AGENT_TOWER_DEFAULT_ROOT || ensureMainRoot());
    child = spawnNoWindow(bin.command, [...bin.prefixArgs, ...args], {
      cwd, env: buildCleanChildEnv(bin.env), stdio: ["pipe", "pipe", "ignore"],
      });
    rpc = createNdjsonRpcConnection(child);
    return await Promise.race([read(rpc, cwd), new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); })]);
  } catch { return undefined; }
  finally {
    clearTimeout(timer);
    await stopCatalogChild(child, rpc);
  }
}

function projectCodexModels(entries, includeHidden = false) {
  return (Array.isArray(entries) ? entries : []).flatMap((m) => {
    const slug = publicIdentifier(m?.slug ?? m?.model ?? m?.id);
    if (!slug || (!includeHidden && m?.hidden === true)) return [];
    const levels = m.supported_reasoning_levels ?? m.supportedReasoningEfforts;
    return [{ slug, name: safeCatalogText(m.display_name ?? m.displayName) || slug,
      description: safeCatalogText(m.description),
      efforts: cleanEfforts(Array.isArray(levels) ? levels.map((x) => x?.effort ?? x?.reasoningEffort ?? x) : []),
      defaultEffort: publicIdentifier(m.default_reasoning_level ?? m.defaultReasoningEffort),
      contextWindow: contextSize(m.context_window ?? m.contextWindow), isDefault: m.isDefault === true,
    }];
  });
}

function probeCodexCatalog() {
  return probeLocalCatalog(resolveCodexBinary, ["app-server", "--listen", "stdio://"], 4500, async (rpc) => {
    await rpc.request("initialize", { clientInfo: { name: "agent-tower", version: PLUGIN_VERSION } });
    rpc.notify("initialized", {});
    const res = await rpc.request("model/list", { limit: 100 });
    return projectCodexModels(res?.data ?? res?.models);
  });
}

function probeKimiCatalog() {
  return probeLocalCatalog(resolveKimiBinary, ["acp"], 5000, async (rpc, cwd) => {
    await rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    const res = await rpc.request("session/new", { cwd, mcpServers: [] });
    if (res?.sessionId) {
      try { await rpc.request("session/delete", { sessionId: res.sessionId }, 500); } catch {}
    }
    const options = Array.isArray(res?.configOptions) ? res.configOptions : [];
    const modelOpt = options.find((o) => o?.id === "model" || o?.category === "model");
    const think = options.find((o) => o?.id === "thinking" || o?.category === "thought_level");
    const defaultModel = publicIdentifier(modelOpt?.currentValue ?? res?.models?.currentModelId);
    const choices = flatOptions(modelOpt?.options);
    return (choices.length ? choices : res?.models?.availableModels ?? []).flatMap((m) => {
      const slug = publicIdentifier(m?.value ?? m?.modelId ?? m?.id);
      if (!slug) return [];
      return [{ slug, name: safeCatalogText(m.name ?? m.label) || slug,
        description: safeCatalogText(m.description), isDefault: slug === defaultModel,
        ...(slug === defaultModel && think ? {
          efforts: cleanEfforts(flatOptions(think.options).map((o) => o?.value ?? o?.id)),
          defaultEffort: publicIdentifier(think.currentValue),
        } : {}),
      }];
    });
  });
}

function buildKimiOptionDescriptors(existing) {
  if (Array.isArray(existing) && existing.length > 0) {
    return structuredClone(existing);
  }
  return [
    {
      id: "thinking",
      label: "Thinking",
      type: "select",
      role: "reasoning",
      currentValue: "max",
      options: [
        { id: "low", label: "Thinking Low" },
        { id: "high", label: "Thinking High" },
        { id: "max", label: "Thinking Max" },
      ],
    },
    {
      id: "mode",
      label: "Mode",
      type: "select",
      currentValue: "default",
      options: [
        { id: "default", label: "Default", description: "Manual approvals; tools execute normally." },
        { id: "plan", label: "Plan", description: "Read-only planning; no tool execution." },
        { id: "auto", label: "Auto", description: "Auto-approve safe operations." },
        { id: "yolo", label: "YOLO", description: "Auto-approve everything." },
      ],
    },
  ];
}

function buildCodexOptionDescriptors(efforts, defaultEffort, existing) {
  if (Array.isArray(existing) && existing.length > 0) {
    return structuredClone(existing);
  }
  const effortLabels = {
    low: "Low",
    medium: "Medium",
    high: "High",
    xhigh: "Extra High",
    max: "Max",
    ultra: "Ultra",
  };
  return [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      currentValue: defaultEffort || "medium",
      options: efforts.map((id) => ({
        id,
        label: effortLabels[id] || id,
        ...(id === defaultEffort ? { isDefault: true } : {}),
      })),
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      currentValue: "default",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast", description: "Higher speed tier" },
      ],
    },
  ];
}

function buildAgyOptionDescriptors({ efforts, defaultEffort }) {
  return efforts.length ? [{
    id: "thought_level", label: "Thinking Level", type: "select", role: "reasoning",
    currentValue: defaultEffort, options: efforts.map(id => ({ id, label: id })),
  }] : [];
}

function cleanAgyModels(entries) {
  const models = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const rawSlug = publicIdentifier(entry?.slug ?? entry?.value ?? entry?.id ?? entry);
    const slug = canonicalAgyModelSlug(rawSlug);
    if (!isAllowedAgySubagentModel(slug)) continue;
    const builtin = BUILTIN_AGY_MODELS.find(m => m.slug === slug);
    const efforts = isAgyOrchestratorModel(slug) ? [] : cleanEfforts(entry?.efforts ?? builtin?.efforts ?? []);
    const desired = publicIdentifier(entry?.defaultEffort ?? builtin?.defaultEffort);
    const rawName = safeCatalogText(entry?.name || entry?.label);
    const name = rawName && rawName !== rawSlug ? rawName : builtin?.name || rawName || slug;
    models.set(slug, { slug, name,
      isDefault: entry?.isDefault === true, efforts, ...(efforts.length ? { defaultEffort: efforts.includes(desired) ? desired : efforts[0] } : {}) });
  }
  return [...models.values()];
}

function mergeWithBuiltinAgyModels(discovered = []) {
  if (!discovered.length) return BUILTIN_AGY_MODELS;
  const seen = new Set(discovered.map(m => m.slug));
  const hasExplicitDefault = discovered.some(m => m.isDefault);
  return [
    ...discovered,
    ...BUILTIN_AGY_MODELS.filter(m => !seen.has(m.slug)).map(m => (hasExplicitDefault && m.isDefault ? { ...m, isDefault: false } : m)),
  ];
}

function parseAgyModels(output) {
  try {
    const parsed = JSON.parse(output);
    return cleanAgyModels(parsed?.models ?? parsed?.data ?? parsed);
  } catch {
    return cleanAgyModels(output.replace(/\x1b\[[0-9;]*m/g, "").split(/\r?\n/u).flatMap(line => {
      const row = /^(?:\s|[|│*●>•-])*(Orchestrator \([a-z0-9-]+\)|gemini-[a-z0-9.-]+)(?:\s*[|│:\t]\s*|\s+(?:[-–—]\s+)?|$)([^|│]*)/i.exec(line);
      return row ? [{ slug: row[1], name: row[2].trim() }] : [];
    }));
  }
}

async function readCliOutput(bin, args, cwd, timeoutMs) {
  try {
    return (await captureNoWindow(bin.command, [...bin.prefixArgs, ...args], {
      cwd, env: buildCleanChildEnv(bin.env), timeoutMs, maxBuffer: 256_000,
    })).stdout;
  } catch { return ""; }
}

export async function probeAgyCatalog({ resolveBinary = resolveAgyBinary, cwd, timeoutMs = 3500 } = {}) {
  const bin = resolveBinary();
  if (!bin?.resolvedPath || /\.(?:bat|cmd|ps1)$/i.test(bin.command)) return undefined;
  cwd = nativePath(cwd || ensureMainRoot());
  const models = await readCliOutput(bin, ["models"], cwd, timeoutMs).then(parseAgyModels);
  if (!models.length) return undefined;
  const versionOutput = await readCliOutput(bin, ["--version"], cwd, timeoutMs);
  return { models, probedAt: Date.now(), version: /\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(versionOutput)?.[0] };
}

function agyBinaryFingerprint(bin) {
  if (!bin?.resolvedPath) return "";
  try {
    const file = realpathSync(bin.resolvedPath);
    const st = statSync(file);
    if (!st.isFile()) return "";
    return createHash("sha256").update(JSON.stringify([file, st.size, st.mtimeMs, st.ctimeMs, st.ino])).digest("hex");
  } catch { return ""; }
}

function sanitizeAgyCatalog(raw) {
  const models = cleanAgyModels(raw?.models);
  return models.length ? { models, version: publicIdentifier(raw.version) || undefined,
    probedAt: Number.isSafeInteger(raw.probedAt) ? raw.probedAt : null } : undefined;
}

function readAgyAttempts(raw) {
  return (Array.isArray(raw?.attempts) ? raw.attempts : []).filter(a =>
    /^[a-f0-9]{64}$/.test(a?.fingerprint) && Number.isSafeInteger(a.at) && ["ok", "failed"].includes(a.status));
}

async function loadAgyCatalog(file, { refresh, agyProbe, agyResolveBinary, cwd }) {
  const disk = await readJsonSafe(file);
  let catalog = sanitizeAgyCatalog(disk);
  if (!refresh) return { catalog };
  const run = async probe => {
    try { return sanitizeAgyCatalog(await probe()); } catch { return undefined; }
  };
  if (agyProbe) {
    const live = await run(() => agyProbe({ cwd }));
    if (live) {
      try { atomicJson(file, { ...live, attempts: readAgyAttempts(disk) }); } catch {}
    }
    return { catalog: live || catalog, live: Boolean(live) };
  }
  const bin = agyResolveBinary();
  const fingerprint = agyBinaryFingerprint(bin);
  if (!fingerprint) return { catalog };
  const key = `${file}|${fingerprint}`;
  const inFlight = agyPending.get(key);
  if (inFlight) return inFlight;
  const recorded = agyProbeRecords.get(key);
  if (recorded || readAgyAttempts(disk).some(a => a.fingerprint === fingerprint)) {
    return { catalog: catalog || recorded?.catalog };
  }
  const pending = (async () => {
    const live = await run(() => probeAgyCatalog({ resolveBinary: () => bin, cwd }));
    // A failed or timed-out version is not retried on clicks or daemon restarts.
    const latest = await readJsonSafe(file);
    catalog = live || sanitizeAgyCatalog(latest) || catalog;
    const attempts = [...readAgyAttempts(latest).filter(a => a.fingerprint !== fingerprint),
      { fingerprint, at: Date.now(), status: live ? "ok" : "failed" }].slice(-8);
    const result = { catalog, live: Boolean(live) };
    try { atomicJson(file, { ...catalog, attempts }); }
    catch { agyProbeRecords.set(key, result); }
    if (agyProbeRecords.size > 32) agyProbeRecords.delete(agyProbeRecords.keys().next().value);
    return result;
  })().finally(() => agyPending.delete(key));
  agyPending.set(key, pending);
  return pending;
}

const binaryAvailable = bin => Boolean(bin?.command && bin.resolvedPath && bin.available !== false);

export async function loadProviderCatalogs({
  customProviders = [], cacheDir, refresh = false, agyProbe, agyResolveBinary = resolveAgyBinary, cwd, hostBridgeAvailable,
  codexResolveBinary = resolveCodexBinary, kimiResolveBinary = resolveKimiBinary,
  codexProbe = probeCodexCatalog, kimiProbe = probeKimiCatalog,
} = {}) {
  const { codex, kimi, catalogPath, fingerprint } = getLocalCatalogInputs({ refresh });
  const kimiInstalled = binaryAvailable(kimiResolveBinary());
  const codexInstalled = binaryAvailable(codexResolveBinary());
  const agyBinary = agyResolveBinary();
  const previousProbe = liveCatalogCache.get(fingerprint);
  const configuredCodex = readJsonSafe(catalogPath).then(data => projectCodexModels(data?.models, true));
  const [configuredCodexModels, agy, liveCodex, liveKimi] = await Promise.all([
    configuredCodex,
    loadAgyCatalog(agyCacheFile(cacheDir), { refresh, agyProbe, agyResolveBinary: () => agyBinary, cwd }),
    configuredCodex.then(models => models.length ? undefined : refresh ? codexProbe() : previousProbe?.liveCodex),
    kimi.models.size ? undefined : refresh ? kimiProbe() : previousProbe?.liveKimi,
  ]);
  const agyCatalog = agy.catalog;
  const agyInstalled = Boolean(agyCatalog || agyProbe || hostBridgeAvailable || process.env.ANTIGRAVITY_APP_DATA_DIR ||
    binaryAvailable(agyBinary) || resolveHostAgentApiBinary().available);
  const probedAt = refresh ? Date.now() : previousProbe?.probedAt ?? null;
  if (refresh) {
    liveCatalogCache.delete(fingerprint);
    liveCatalogCache.set(fingerprint, { liveCodex, liveKimi, probedAt });
    if (liveCatalogCache.size > 4) liveCatalogCache.delete(liveCatalogCache.keys().next().value);
  }
  const kimiDefault = publicIdentifier(kimi.top.default_model);
  const kimiDefaultEffort = publicIdentifier(kimi.thinking.effort);
  const kimiBySlug = new Map((liveKimi ?? []).map((m) => [m.slug, m]));
  for (const [slug, cfg] of kimi.models) {
    const name = typeof cfg.model === "string" ? cfg.model : "";
    const live = kimiBySlug.get(slug);
    kimiBySlug.set(slug, {
      ...live, slug, name: live?.name || name || slug,
      efforts: cfg.support_efforts ?? live?.efforts,
      defaultEffort: cfg.default_effort || (slug === kimiDefault ? kimiDefaultEffort : "") || live?.defaultEffort,
      contextWindow: contextSize(cfg.max_context_size),
    });
  }
  const rawKimiModels = kimiBySlug.size ? [...kimiBySlug.values()] : [...BUILTIN_KIMI_MODELS];
  if (kimiDefault && !rawKimiModels.some((m) => m.slug === kimiDefault)) {
    rawKimiModels.unshift({ slug: kimiDefault, isCustom: true });
  }
  const kimiModels = rawKimiModels.map((m) => {
    const slug = m.slug || m.id;
    const optionDescriptors = buildKimiOptionDescriptors(m.capabilities?.optionDescriptors);
    const thinkingDesc = optionDescriptors.find((d) => d.id === "thinking");
    const modeDesc = optionDescriptors.find((d) => d.id === "mode");
    const efforts = m.efforts ?? thinkingDesc.options.map((o) => o.id);
    const defaultEffort = efforts.includes(m.defaultEffort) ? m.defaultEffort
      : efforts.includes(thinkingDesc.currentValue) ? thinkingDesc.currentValue : efforts[0];
    thinkingDesc.currentValue = defaultEffort;
    thinkingDesc.options = efforts.map((id) => ({ id, label: id, ...(id === defaultEffort ? { isDefault: true } : {}) }));
    const modes = modeDesc?.options?.map((o) => o.id) || ["default", "plan", "auto", "yolo"];
    return {
      id: slug,
      slug,
      name: m.name || slug,
      provider: "kimi-code",
      isDefault: kimiDefault ? slug === kimiDefault : Boolean(m.isDefault),
      isCustom: Boolean(m.isCustom),
      isLegacy: false,
      enabled: true,
      locked: false,
      effortOptionId: "thinking",
      efforts,
      defaultEffort,
      modes,
      contextWindow: m.contextWindow ?? (slug.includes("256k") ? 262144 : 1048576),
      optionDescriptors,
      capabilities: { optionDescriptors },
    };
  });

  const kimiProvider = {
    id: "kimi-code",
    provider: "kimi-code",
    driver: "acp",
    displayName: "Kimi Code",
    status: kimiInstalled ? "ready" : "not_installed",
    installed: kimiInstalled,
    catalogSource: liveKimi?.length ? "kimi-acp-live" : kimi.models.size ? "kimi-config" : "builtin",
    configDefaultModel: kimiDefault,
    configDefaultEffort: kimiDefaultEffort,
    probedAt,
    enabled: true,
    authenticated: true,
    locked: false,
    contextWindow: 1048576,
    supportedPermissionModes: PROVIDER_PERMISSION_MODES["kimi-code"].map((m) => m.value),
    permissionModes: listPermissionModesForProvider("kimi-code"),
    supportedInteractionModes: ["default", "plan"],
    nativeModes: ["default", "plan", "auto", "yolo"],
    supportsLiveSteer: false,
    supportsSessionResume: true,
    models: kimiModels,
  };

  // A valid on-disk catalog is authoritative; no live CLI probe is needed.
  const rawCodexModels = [...(configuredCodexModels.length ? configuredCodexModels
    : liveCodex?.length ? liveCodex : BUILTIN_CODEX_MODELS)];
  const codexDefault = publicIdentifier(codex.model);
  const codexDefaultEffort = publicIdentifier(codex.model_reasoning_effort);
  if (codexDefault && !rawCodexModels.some((m) => m.slug === codexDefault)) {
    rawCodexModels.unshift({ slug: codexDefault, name: `${codexDefault} (config.toml \u5f53\u524d\u9ed8\u8ba4)`, isCustom: true });
  }
  const codexModels = rawCodexModels.map((m) => {
    const slug = m.slug;
    const efforts = m.efforts?.length ? m.efforts : BUILTIN_CODEX_MODELS.find((x) => x.slug === slug)?.efforts ?? [];
    const defaultEffort = m.defaultEffort || (slug === codexDefault ? codexDefaultEffort : "") || efforts[0];
    const optionDescriptors = buildCodexOptionDescriptors(efforts, defaultEffort);
    const tierDesc = optionDescriptors.find((d) => d.id === "serviceTier");
    return {
      id: slug,
      slug,
      name: m.name || slug,
      provider: "codex",
      description: m.description || "",
      isDefault: codexDefault ? slug === codexDefault : Boolean(m.isDefault),
      isCustom: Boolean(m.isCustom),
      isLegacy: Boolean(m.isLegacy),
      enabled: true,
      locked: false,
      effortOptionId: "reasoningEffort",
      efforts,
      defaultEffort,
      serviceTiers: tierDesc?.options?.map((o) => o.id) || ["default", "priority"],
      modes: ["read-only", "workspace-write", "danger-full-access"],
      contextWindow: m.contextWindow ?? (slug === codexDefault ? contextSize(codex.model_context_window) : undefined) ?? 475000,
      optionDescriptors,
      capabilities: { optionDescriptors },
    };
  });

  const codexProvider = {
    id: "codex",
    provider: "codex",
    driver: "codex-app-server",
    displayName: "Codex",
    status: codexInstalled ? "ready" : "not_installed",
    installed: codexInstalled,
    catalogSource: configuredCodexModels.length ? "local-config-catalog" : liveCodex?.length ? "codex-rpc-live" : "builtin",
    configDefaultModel: codexDefault,
    configDefaultEffort: codexDefaultEffort,
    probedAt,
    enabled: true,
    authenticated: true,
    locked: false,
    contextWindow: 475000,
    supportedPermissionModes: PROVIDER_PERMISSION_MODES.codex.map((m) => m.value),
    permissionModes: listPermissionModesForProvider("codex"),
    supportedInteractionModes: ["default", "plan"],
    nativeModes: ["read-only", "workspace-write", "danger-full-access"],
    supportsLiveSteer: true,
    supportsSessionResume: true,
    supportsCodeReview: true,
    models: codexModels,
  };

  const agyModels = mergeWithBuiltinAgyModels(agyCatalog?.models).map(m => {
    const optionDescriptors = buildAgyOptionDescriptors(m);
    return {
      ...m, id: m.slug, provider: "antigravity", enabled: true,
      effortOptionId: m.efforts.length ? "thought_level" : undefined,
      modes: ["default", "accept-edits", "auto", "plan"], contextWindow: 1048576,
      optionDescriptors, capabilities: { optionDescriptors },
    };
  });
  const agyProvider = {
    id: "antigravity", provider: "antigravity", driver: "antigravity-native", isNativeHost: true,
    badge: "宿主原生", displayName: "Antigravity (宿主原生)",
    version: agyCatalog?.version, probedAt: agyCatalog?.probedAt ?? null,
    catalogSource: agy.live ? "agy-live" : agyCatalog ? "agy-cache" : "builtin",
    status: agyInstalled ? "ready" : "not_installed", installed: agyInstalled, enabled: true,
    contextWindow: 1048576,
    supportedPermissionModes: PROVIDER_PERMISSION_MODES.antigravity.map((m) => m.value),
    // Managed `agy acp` ladder; native host bridge threads render HOST_NATIVE_PERMISSION_MODE instead.
    permissionModes: listPermissionModesForProvider("antigravity"),
    hostPermissionModes: [{ ...HOST_NATIVE_PERMISSION_MODE }],
    supportedInteractionModes: ["default", "plan"],
    nativeModes: ["default", "accept-edits", "always-proceed", "plan"],
    supportsLiveSteer: true, supportsSessionResume: true,
    configDefaultModel: (agyCatalog?.models ?? agyModels).find(m => m.isDefault)?.slug,
    models: agyModels,
  };

  // 4. Merge user-enabled Extension Hub / Custom Providers (ACP & CLI templates)
  const extensionProviders = [];
  const coreIds = new Set(["kimi-code", "codex", "antigravity", "claude-code"]);
  for (const rawExt of normalizeCustomProvidersList(customProviders)) {
    const clean = sanitizeExtensionProviderConfig(rawExt);
    if (!clean.id || coreIds.has(normalizeProviderId(clean.id))) continue;
    if (!clean.enabled) continue;

    const tplMatch = BUILTIN_EXTENSION_TEMPLATES.find((t) => t.id === clean.id);
    const binDetect = detectCommandOnSystem(clean.command);
    const rawModels =
      clean.models.length > 0
        ? clean.models
        : tplMatch?.defaultModels?.length
          ? tplMatch.defaultModels
          : [{ slug: clean.defaultModel || `${clean.id}/default`, name: `${clean.displayName} Default`, isDefault: true }];

    const extEfforts = clean.efforts || ["low", "medium", "high"];
    const extOptionDescriptors = [
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        role: "reasoning",
        currentValue: extEfforts[Math.floor(extEfforts.length / 2)] || "high",
        options: extEfforts.map((e) => ({ id: e, label: e })),
      },
    ];

    const projectedModels = rawModels.map((m, idx) => {
      const slug = String(m.slug || m.id || `${clean.id}/default`);
      return {
        id: slug,
        slug,
        name: String(m.name || slug),
        provider: clean.id,
        isDefault: Boolean(m.isDefault) || idx === 0,
        isCustom: true,
        isLegacy: false,
        enabled: true,
        locked: false,
        effortOptionId: "thinking",
        efforts: extEfforts,
        defaultEffort: extEfforts[Math.floor(extEfforts.length / 2)] || "high",
        modes: clean.modes,
        contextWindow: 262144,
        optionDescriptors: extOptionDescriptors,
        capabilities: { optionDescriptors: extOptionDescriptors },
      };
    });

    extensionProviders.push({
      id: clean.id,
      provider: clean.id,
      driver: clean.protocol === "cli" ? "generic-cli" : "generic-acp",
      protocol: clean.protocol,
      isExtension: true,
      displayName: clean.displayName,
      version: binDetect.detected ? "installed" : "custom",
      status: "ready",
      installed: binDetect.detected,
      binaryPath: binDetect.binaryPath,
      command: clean.command,
      args: clean.args,
      argsTemplate: clean.argsTemplate,
      envKeys: clean.envKeys,
      enabled: true,
      authenticated: true,
      locked: false,
      supportedPermissionModes: PROVIDER_PERMISSION_MODES.generic.map((m) => m.value),
      permissionModes: listPermissionModesForProvider(clean.id),
      supportedInteractionModes: ["default", "plan"],
      nativeModes: clean.modes,
      supportsLiveSteer: false,
      supportsSessionResume: clean.protocol === "acp",
      models: projectedModels,
    });
  }

  const claudeBin = resolveClaudeBinary();
  const claudeProvider = {
    id: "claude-code", provider: "claude-code", driver: "claude-code", displayName: "Claude Code",
    installed: Boolean(claudeBin.resolvedPath), enabled: true,
    status: claudeBin.resolvedPath ? "ready" : "not_installed",
    supportedPermissionModes: PROVIDER_PERMISSION_MODES["claude-code"].map((m) => m.value),
    permissionModes: listPermissionModesForProvider("claude-code"),
    supportedInteractionModes: ["default", "plan"], supportsSessionResume: true, supportsLiveSteer: true,
    configDefaultModel: BUILTIN_CLAUDE_MODELS[0].slug,
    models: BUILTIN_CLAUDE_MODELS.map(m => ({ ...m, id: m.slug, provider: "claude-code", enabled: true })),
  };
  const providers = [kimiProvider, codexProvider, agyProvider, claudeProvider, ...extensionProviders];
  latestCatalog = { providers };
  return {
    providers,
    extensionTemplates: listExtensionTemplates({ customProviders }),
  };
}

/**
 * Normalize an effort/thinking value to a valid option supported by the target provider & model.
 */
const EFFORT_SCALE = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];
const builtinEfforts = {
  codex: BUILTIN_CODEX_MODELS,
  antigravity: BUILTIN_AGY_MODELS,
  "claude-code": BUILTIN_CLAUDE_MODELS,
};
let latestCatalog;

export function getCatalogEfforts(catalog, provider, model) {
  const entry = catalog?.providers?.find((p) => p.id === normalizeProviderId(provider));
  const selected = isInheritedModel(model) || !model ? entry?.configDefaultModel : model;
  return entry?.models?.find((m) => m.slug === selected)?.efforts;
}

export function normalizeEffortForTarget(provider, model, rawEffort, allowedEfforts) {
  if (isInheritedEffort(rawEffort)) return INHERIT_EFFORT;
  const p = normalizeProviderId(provider) || inferProviderFromModel(model);
  const e = typeof rawEffort === "string" ? rawEffort.trim().toLowerCase() : "";
  const valid = allowedEfforts ?? getCatalogEfforts(latestCatalog, p, model) ??
    builtinEfforts[p]?.find((m) => m.slug === model?.toLowerCase())?.efforts ??
    (p === "antigravity" ? ["low", "medium", "high"] : undefined);
  if (p === "antigravity" && (isAgyOrchestratorModel(model) || isAgyCoarseSubagentModel(model) || valid?.length === 0)) return INHERIT_EFFORT;
  if (!valid?.length || valid.includes(rawEffort)) return rawEffort || "high";
  if (valid.includes(e)) return e;
  const rank = (v) => EFFORT_SCALE.indexOf(({ none: "off", on: "high", normal: "medium" })[v] ?? v);
  const target = rank(e);
  if (target >= 0) {
    const supported = valid.filter((v) => rank(v) >= 0);
    if (supported.length) return supported.reduce((best, v) => {
      const delta = Math.abs(rank(v) - target) - Math.abs(rank(best) - target);
      return delta < 0 || (delta === 0 && rank(v) < rank(best)) ? v : best;
    });
  }
  return valid.includes("high") ? "high" : valid[0];
}

function extractOptionFromTargetOptions(options, keys) {
  if (!options) return undefined;
  if (Array.isArray(options)) {
    for (const item of options) {
      if (item && keys.includes(item.id) && item.value !== undefined) {
        return item.value;
      }
    }
    return undefined;
  }
  if (typeof options === "object") {
    for (const k of keys) {
      if (options[k] !== undefined) return options[k];
    }
  }
  return undefined;
}

// Only Codex currently maps read-only to an enforced filesystem sandbox.
export function assertReadOnlySupport(provider, mode) {
  if (String(mode || '').trim().toLowerCase() === 'read-only' && normalizeProviderId(provider) !== 'codex') {
    throw Object.assign(new Error(`${provider} 无法强制执行 read-only 只读沙盒；请改用 codex。`), { code: 'READ_ONLY_UNSUPPORTED' });
  }
}

/**
 * Engine-native permission ladders (v0.0.3). Every engine exposes its own vocabulary; `tier` is the shared
 * semantic rung used for safe cross-engine mapping: plan < ask < edits < auto < full.
 * `danger: true` marks rungs that skip human/classifier review entirely.
 */
const permissionEntry = (value, label, tier, danger = false) => Object.freeze({ value, label, tier, danger });
export const PROVIDER_PERMISSION_MODES = Object.freeze({
  "claude-code": Object.freeze([
    permissionEntry("plan", "规划模式 (plan)", "plan"),
    permissionEntry("default", "请求批准 (default)", "ask"),
    permissionEntry("acceptEdits", "自动接受编辑 (acceptEdits)", "edits"),
    permissionEntry("auto", "自动安全审查 (auto)", "auto"),
    permissionEntry("bypassPermissions", "跳过全部审批 (bypassPermissions)", "full", true),
  ]),
  codex: Object.freeze([
    permissionEntry("read-only", "只读沙盒 (read-only)", "plan"),
    permissionEntry("on-request", "请求批准 (on-request)", "ask"),
    permissionEntry("auto", "自动审查放行 (auto)", "auto"),
    permissionEntry("full-access", "完全访问 (full-access)", "full", true),
  ]),
  "kimi-code": Object.freeze([
    permissionEntry("plan", "规划模式 (plan)", "plan"),
    permissionEntry("default", "请求批准 (default)", "ask"),
    permissionEntry("auto", "自动安全放行 (auto)", "auto"),
    permissionEntry("yolo", "全自动免审 (yolo)", "full", true),
  ]),
  antigravity: Object.freeze([
    permissionEntry("plan", "规划模式 (plan)", "plan"),
    permissionEntry("default", "常规审查 (default)", "ask"),
    permissionEntry("accept-edits", "自动接受编辑 (accept-edits)", "edits"),
    permissionEntry("always-proceed", "跳过工具审批 (always-proceed)", "full", true),
  ]),
  generic: Object.freeze([
    permissionEntry("plan", "规划模式 (plan)", "plan"),
    permissionEntry("default", "请求批准 (default)", "ask"),
    permissionEntry("auto", "自动放行 (auto)", "auto"),
    permissionEntry("full-access", "完全访问 (full-access)", "full", true),
  ]),
});
/** Native Antigravity host bridge threads: permissions are owned by the host window, never by the panel. */
export const HOST_NATIVE_PERMISSION_MODE = Object.freeze({
  value: "host-default", label: "由宿主主窗口管理 (host-default)", tier: "ask", danger: false, disabled: true,
});

// Extra, non-listed values an engine still accepts verbatim (e.g. Claude `dontAsk` auto-denies unapproved tools).
const EXTRA_NATIVE_PERMISSION_VALUES = { "claude-code": [permissionEntry("dontAsk", "不询问直接拒绝 (dontAsk)", "ask")] };
// Rung -> native value. Engines without an `edits` rung fall back to `ask` (never upward).
const NATIVE_PERMISSION_BY_TIER = {
  "claude-code": { plan: "plan", ask: "default", edits: "acceptEdits", auto: "auto", full: "bypassPermissions" },
  codex: { plan: "read-only", ask: "on-request", edits: "on-request", auto: "auto", full: "full-access" },
  "kimi-code": { plan: "plan", ask: "default", edits: "default", auto: "auto", full: "yolo" },
  antigravity: { plan: "plan", ask: "default", edits: "accept-edits", auto: "accept-edits", full: "always-proceed" },
  generic: { plan: "plan", ask: "default", edits: "default", auto: "auto", full: "full-access" },
};
// Legacy cross-engine aliases that explicitly request the full rung on every engine (backward compatible).
const EXPLICIT_FULL_ACCESS_ALIASES = new Set(["full-access", "yolo", "danger-full-access"]);
const PERMISSION_ALIAS_TIER = {
  plan: "plan", "read-only": "plan", readonly: "plan",
  default: "ask", "approval-required": "ask", "on-request": "ask", manual: "ask", ask: "ask", untrusted: "ask",
  "host-default": "ask", dontask: "ask",
  acceptedits: "edits", "accept-edits": "edits", "auto-accept-edits": "edits",
  auto: "auto", "workspace-write": "auto", "auto-review": "auto",
  bypasspermissions: "full", "full-access": "full", yolo: "full", "danger-full-access": "full", "always-proceed": "full",
  "dangerously-skip-permissions": "full",
};

export function permissionProfileOf(provider) {
  const id = normalizeProviderId(provider);
  return Object.hasOwn(NATIVE_PERMISSION_BY_TIER, id) && id !== "generic" ? id : "generic";
}

/** Public native ladder for a provider (UI + catalog). Native host bridge threads expose a single disabled option. */
export function listPermissionModesForProvider(provider, { isNativeHost = false } = {}) {
  if (isNativeHost && normalizeProviderId(provider) === "antigravity") return [HOST_NATIVE_PERMISSION_MODE];
  return PROVIDER_PERMISSION_MODES[permissionProfileOf(provider)].map((m) => ({ ...m }));
}

export function permissionTierOf(mode) {
  const key = String(mode ?? "").trim().toLowerCase();
  return Object.hasOwn(PERMISSION_ALIAS_TIER, key) ? PERMISSION_ALIAS_TIER[key] : "";
}

/**
 * Map any requested permission (native value of any engine, or a legacy generic value) to the target engine's
 * native value without ever escalating:
 * - unknown values land on the engine's `ask` rung;
 * - an engine-specific "skip everything" value of ANOTHER engine (e.g. Claude `bypassPermissions` on Codex)
 *   never unlocks the target's full rung; only the target's own value or legacy `full-access/yolo/danger-full-access` do;
 * - `crossEngine: true` (switching a selection to another engine) never lands on the full rung at all;
 * - `read-only` on engines without an enforced sandbox is kept verbatim so `assertReadOnlySupport` fails closed,
 *   unless `strictReadOnly: false` (preset/UI carry-over), which degrades it to `plan`.
 * Returns `fallback` for empty / inherit input.
 */
export function normalizePermissionModeForProvider(provider, mode, { fallback, crossEngine = false, strictReadOnly = true } = {}) {
  const raw = String(mode ?? "").trim();
  if (!raw || raw.toLowerCase() === "inherit") return fallback;
  const profile = permissionProfileOf(provider);
  const ladder = NATIVE_PERMISSION_BY_TIER[profile];
  const lower = raw.toLowerCase();
  if (lower === "read-only" || lower === "readonly") {
    if (profile === "codex") return "read-only";
    return strictReadOnly && !crossEngine ? "read-only" : ladder.plan;
  }
  const natives = [...PROVIDER_PERMISSION_MODES[profile], ...(EXTRA_NATIVE_PERMISSION_VALUES[profile] || [])];
  const native = natives.find((m) => m.value.toLowerCase() === lower);
  const tier = native?.tier || permissionTierOf(lower);
  if (!tier) return ladder.ask;
  if (tier === "full") {
    if (crossEngine) return ladder.auto;
    if (native || EXPLICIT_FULL_ACCESS_ALIASES.has(lower)) return ladder.full;
    return ladder.auto;
  }
  if (native) return native.value;
  return ladder[tier];
}

export function isDangerousPermissionMode(provider, mode) {
  const value = normalizePermissionModeForProvider(provider, mode, { fallback: "" });
  return PROVIDER_PERMISSION_MODES[permissionProfileOf(provider)].some((m) => m.value === value && m.danger);
}


function normalizeInteractionMode(mode, permissionRaw, fallback = "default") {
  if (String(permissionRaw || "").trim().toLowerCase() === "plan") {
    return "plan";
  }
  if (!mode || mode === "inherit") return fallback;
  return String(mode).trim().toLowerCase() === "plan" ? "plan" : "default";
}

function normalizeIsolation(isolation, fallback = "shared") {
  if (!isolation) return fallback;
  const v = String(isolation).trim().toLowerCase();
  return v === "worktree" ? "worktree" : "shared";
}

export const ORCHESTRATION_MODES = Object.freeze(["direct", "relay", "complex"]);
export const DEFAULT_MEMBER_POOL = Object.freeze({
  advisor: Object.freeze({ strategy: "all_enabled", defaultPresetKey: null }),
  executor: Object.freeze({ strategy: "locked_default", defaultPresetKey: "executor_claude" }),
  reviewer: Object.freeze({ strategy: "locked_default", defaultPresetKey: "reviewer" }),
});
export const PRESET_KEY_RE = /^[a-z][a-z0-9_-]{2,63}$/;
export const CUSTOM_PRESET_KEY_RE = PRESET_KEY_RE;
const RESERVED_PRESET_KEYS = new Set([
  "commander", "coordinator", "advisor", "executor", "design", "research", "review",
  "implementation", "test", "general", "host", "all", "curator", "__new_member__",
]);

export function validatePresetKey(key, { existingKeys } = {}) {
  const value = String(key ?? "");
  if (!PRESET_KEY_RE.test(value) || RESERVED_PRESET_KEYS.has(value) || new Set(existingKeys).has(value)) {
    throw presetError("成员键必须为 3..64 位小写字母、数字、下划线或连字符，以字母开头，且不得保留或重复", "INVALID_PRESET_KEY");
  }
  return value;
}
export const validateCustomPresetKey = validatePresetKey;
const CUSTOM_PIPELINE_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
export function isValidOrchestrationMode(mode, customPipelines = {}) {
  const value = String(mode ?? "").trim();
  if (ORCHESTRATION_MODES.includes(value)) return true;
  if (!value.startsWith("custom:")) return false;
  const id = value.slice("custom:".length);
  return CUSTOM_PIPELINE_ID_RE.test(id) && (customPipelines?.allowUncheckedCustom === true || Object.hasOwn(customPipelines || {}, id));
}
export function normalizeOrchestrationMode(raw, fallback = "direct", customPipelines = {}) {
  const value = String(raw ?? "").trim();
  if (value === "simple") return "relay";
  if (CUSTOM_PIPELINE_ID_RE.test(value.startsWith("custom:") ? value.slice("custom:".length) : "")) return "complex";
  if (isValidOrchestrationMode(value, customPipelines)) return value;
  const safeFallback = String(fallback ?? "direct").trim();
  if (safeFallback === "simple") return "relay";
  if (CUSTOM_PIPELINE_ID_RE.test(safeFallback.startsWith("custom:") ? safeFallback.slice("custom:".length) : "")) return "complex";
  return isValidOrchestrationMode(safeFallback, customPipelines) ? safeFallback : "direct";
}
export function dispatchEnabledForMode(mode) { return normalizeOrchestrationMode(mode) !== "direct"; }
function presetGroup(value, fallback = "advisor") { return ["advisor", "executor", "reviewer", "curator"].includes(value) ? value : fallback; }

export function curatorRestrictions(provider) {
  provider = normalizeProviderId(provider);
  return { permissionMode: provider === "codex" ? "read-only" : "plan", interactionMode: "plan", isolation: "shared" };
}

export const DEFAULT_MODE_PROFILES = Object.freeze({
  relay: Object.freeze({
    executor: Object.freeze({
      enabledKeys: Object.freeze(["executor_kimi", "executor_codex", "executor_claude", "executor_hydrogen"]),
      preferredKey: "executor_claude",
    }),
  }),
  complex: Object.freeze({
    curator: Object.freeze({
      enabledKeys: Object.freeze(["curator_codex"]),
      preferredKey: "curator_codex",
    }),
    advisor: Object.freeze({
      stageEnabled: true,
      enabledKeys: Object.freeze(["advisor_kimi", "advisor_codex", "advisor_claude"]),
    }),
    executor: Object.freeze({
      enabledKeys: Object.freeze(["executor_kimi", "executor_codex", "executor_claude", "executor_hydrogen"]),
      preferredKey: "executor_claude",
    }),
    reviewer: Object.freeze({
      stageEnabled: true,
      enabledKeys: Object.freeze(["reviewer"]),
      preferredKey: "reviewer",
    }),
  }),
});

function validProfileKeys(activePresets, group, keys, { includeDisabled = false } = {}) {
  const allowed = new Set(Object.entries(activePresets || {})
    .filter(([, preset]) => preset?.group === group && (includeDisabled || preset.enabled !== false))
    .map(([key]) => key));
  return [...new Set((Array.isArray(keys) ? keys : []).map(String).filter(key => allowed.has(key)))];
}

function fallbackProfileKeys(activePresets, group) {
  return Object.entries(activePresets || {})
    .filter(([, preset]) => preset?.group === group && preset.enabled !== false)
    .map(([key]) => key);
}

function validPreferredKey(activePresets, group, preferredKey, enabledKeys) {
  const key = String(preferredKey || "");
  return enabledKeys.includes(key) && activePresets?.[key]?.group === group ? key : enabledKeys[0] || null;
}

function migrateProfileKeys(activePresets, group, keys, legacyKeys = []) {
  const enabled = fallbackProfileKeys(activePresets, group);
  const legacy = legacyKeys.filter(key => activePresets?.[key]?.group === group);
  return [...new Set([...enabled, ...legacy])];
}

export function normalizeModeProfiles(rawProfiles, activePresets = DEFAULT_ROLE_PRESETS, legacy = {}) {
  const source = rawProfiles && typeof rawProfiles === "object" ? rawProfiles : {};
  const relaySource = source.relay && typeof source.relay === "object" ? source.relay : {};
  const complexSource = source.complex && typeof source.complex === "object" ? source.complex : {};
  const relayExecutorSource = relaySource.executor && typeof relaySource.executor === "object" ? relaySource.executor : null;
  const complexAdvisorSource = complexSource.advisor && typeof complexSource.advisor === "object" ? complexSource.advisor : null;
  const complexExecutorSource = complexSource.executor && typeof complexSource.executor === "object" ? complexSource.executor : null;
  const complexReviewerSource = complexSource.reviewer && typeof complexSource.reviewer === "object" ? complexSource.reviewer : null;
  const curatorSource = complexSource.curator;
  const curatorKeys = curatorSource
    ? validProfileKeys(activePresets, "curator", curatorSource.enabledKeys, { includeDisabled: true })
    : fallbackProfileKeys(activePresets, "curator");
  const legacyRelayKey = String(legacy.relayTargetPresetKey || "");
  const legacyExecutorDefault = String(legacy.memberPool?.executor?.defaultPresetKey || "");
  const relayKeys = relayExecutorSource
    ? validProfileKeys(activePresets, "executor", relayExecutorSource.enabledKeys, { includeDisabled: true })
    : migrateProfileKeys(activePresets, "executor", [], [legacyRelayKey, legacyExecutorDefault]);
  const relayPreferred = validPreferredKey(activePresets, "executor",
    relayExecutorSource?.preferredKey || legacyExecutorDefault || legacyRelayKey || "executor_claude", relayKeys);
  const complexExecutorKeys = complexExecutorSource
    ? validProfileKeys(activePresets, "executor", complexExecutorSource.enabledKeys, { includeDisabled: true })
    : fallbackProfileKeys(activePresets, "executor");
  const complexExecutorPreferred = validPreferredKey(activePresets, "executor",
    complexExecutorSource?.preferredKey || legacyExecutorDefault || "executor_claude", complexExecutorKeys);
  const advisorKeys = complexAdvisorSource
    ? validProfileKeys(activePresets, "advisor", complexAdvisorSource.enabledKeys, { includeDisabled: true })
    : fallbackProfileKeys(activePresets, "advisor");
  const reviewerKeys = complexReviewerSource
    ? validProfileKeys(activePresets, "reviewer", complexReviewerSource.enabledKeys, { includeDisabled: true })
    : fallbackProfileKeys(activePresets, "reviewer");
  const advisorAvailable = fallbackProfileKeys(activePresets, "advisor");
  const reviewerAvailable = fallbackProfileKeys(activePresets, "reviewer");
  return {
    relay: {
      executor: {
        enabledKeys: relayKeys,
        preferredKey: relayPreferred,
      },
    },
    complex: {
      curator: {
        enabledKeys: curatorKeys,
        preferredKey: validPreferredKey(activePresets, "curator", curatorSource?.preferredKey || "curator_codex", curatorKeys),
      },
      advisor: {
        stageEnabled: complexAdvisorSource?.stageEnabled === undefined
          ? advisorAvailable.length > 0
          : Boolean(complexAdvisorSource.stageEnabled),
        enabledKeys: advisorKeys,
      },
      executor: {
        enabledKeys: complexExecutorKeys,
        preferredKey: complexExecutorPreferred,
      },
      reviewer: {
        stageEnabled: complexReviewerSource?.stageEnabled === undefined
          ? reviewerAvailable.length > 0
          : Boolean(complexReviewerSource.stageEnabled),
        enabledKeys: reviewerKeys,
        preferredKey: validPreferredKey(activePresets, "reviewer",
          complexReviewerSource?.preferredKey || legacy.memberPool?.reviewer?.defaultPresetKey || "reviewer", reviewerKeys),
      },
    },
  };
}
export function mergeActivePresets(storedPresets = {}, deletedPresets = [], { rosterVersion = 1 } = {}) {
  const deleted = new Set((Array.isArray(deletedPresets) ? deletedPresets : []).map(String));
  const legacy = rosterVersion < 2;
  const active = {};
  if (legacy) {
    for (const [key, preset] of Object.entries(DEFAULT_ROLE_PRESETS)) {
      if (!deleted.has(key)) active[key] = { ...preset };
    }
  }
  for (const [key, raw] of Object.entries(storedPresets || {})) {
    if (!raw || typeof raw !== "object" || deleted.has(key)) continue;
    if (legacy && Object.hasOwn(DEFAULT_ROLE_PRESETS, key) && key !== "curator_codex") {
      const base = active[key];
      active[key] = { ...base, ...structuredClone(raw), key, group: base.group, builtin: true };
      continue;
    }
    if (!PRESET_KEY_RE.test(key) || RESERVED_PRESET_KEYS.has(key)) continue;
    const group = roleMemberGroup(raw.role) === "curator" ? "curator" : presetGroup(raw.group, DEFAULT_ROLE_PRESETS[key]?.group || "advisor");
    const preset = {
      label: key, title: raw.label || key,
      role: group === "reviewer" ? "review" : group === "advisor" ? "design" : "implementation",
      provider: "", model: "", effort: "high", permissionMode: "default",
      interactionMode: "default", isolation: "shared", description: "",
      ...structuredClone(raw), key, group, builtin: false,
    };
    if (group === "curator") {
      Object.assign(preset, curatorRestrictions(preset.provider), { role: "curator" });
      preset.runtimeMode = preset.permissionMode;
    }
    if (legacy) preset.enabled = raw.enabled !== false;
    else delete preset.enabled;
    Object.defineProperty(active, key, { value: preset, enumerable: true, configurable: true, writable: true });
  }
  return active;
}

export function buildInitialRosterFromProbe({ binaries = {}, catalog, hostBridgeAvailable, customProviders } = {}) {
  const providers = catalog?.providers || [];
  const presets = {};
  function addMember(group, key, provider, model, label, effort) {
    presets[key] = {
      ...(key === "curator_codex" ? DEFAULT_ROLE_PRESETS.curator_codex : {}),
      group, provider, model, label, effort,
      permissionMode: group === "advisor" ? "plan" : "auto",
      interactionMode: group === "advisor" ? "plan" : "default",
    };
  }
  for (const [group, prefix] of [["advisor", "军师"], ["executor", "执行官"], ["reviewer", "终审官"], ["curator", "规范维护官"]]) {
    for (const [provider, suffix] of [["claude-code", "claude"], ["codex", "codex"], ["kimi-code", "kimi"], ["antigravity", "agy"]]) {
      if (group === "curator" && provider === "antigravity" && !hostBridgeAvailable) continue;
      if (!(binaryAvailable(binaries[provider]) || (provider === "antigravity" && (hostBridgeAvailable || binaryAvailable(binaries.agy))))) continue;
      const entry = providers.find(p => p.id === provider);
      const key = `${group}_${suffix}`;
      const base = DEFAULT_ROLE_PRESETS[key] ?? DEFAULT_ROLE_PRESETS[`executor_${suffix === "agy" ? "hydrogen" : suffix}`];
      const first = entry?.catalogSource === "builtin" ? undefined : entry?.models?.[0];
      const configured = provider === "antigravity" && entry?.catalogSource === "builtin" ? undefined : entry?.configDefaultModel;
      const fallback = group === "advisor" && suffix === "agy" ? "gemini-4-argon" : base?.model;
      const model = configured || first?.slug || first?.id || fallback;
      const modelInfo = entry?.models?.find(m => (m.slug || m.id) === model);
      const effort = modelInfo?.defaultEffort || base?.effort || "high";
      addMember(group, key, provider, model, `${prefix} · ${entry?.displayName || provider}`, effort);
    }
    for (const ext of normalizeCustomProvidersList(customProviders)) {
      const provider = normalizeProviderId(ext.id || ext.provider);
      const entry = providers.find(p => p.id === provider && p.isExtension);
      if (!provider || ext.enabled === false || !ext.command || !binaryAvailable(binaries[provider]) && !entry?.installed) continue;
      const key = `${group}_${provider.toLowerCase().replace(/[^a-z0-9_-]/g, "_")}`.slice(0, 64);
      if (Object.hasOwn(presets, key)) continue;
      const first = entry?.models?.[0] || ext.models?.[0];
      addMember(group, key, provider, entry?.configDefaultModel || ext.defaultModel || first?.slug || first?.id || `${provider}/default`,
        `${prefix} · ${entry?.displayName || ext.displayName || provider}`, first?.defaultEffort || "high");
    }
  }
  const activePresets = mergeActivePresets(presets, [], { rosterVersion: 2 });
  const modeProfiles = normalizeModeProfiles(undefined, activePresets);
  const curator = modeProfiles.complex.curator;
  curator.preferredKey = curator.enabledKeys.includes("curator_codex") ? "curator_codex" :
    curator.enabledKeys.find(key => activePresets[key].provider !== "antigravity") || curator.enabledKeys[0] || null;
  return { presets: activePresets, modeProfiles };
}
export function normalizeMemberPool(rawPool = {}, activePresets = DEFAULT_ROLE_PRESETS) {
  const result = structuredClone(DEFAULT_MEMBER_POOL);
  const validDefault = (group, key) => { if (!key || !activePresets?.[key]) return null; const preset = activePresets[key]; return preset.group === group && preset.enabled !== false ? key : null; };
  for (const group of Object.keys(result)) {
    const raw = rawPool?.[group] && typeof rawPool[group] === "object" ? rawPool[group] : {};
    const allowed = group === "advisor" ? ["all_enabled", "host_select_1_2"] : ["locked_default", "host_select_enabled"];
    result[group].strategy = allowed.includes(raw.strategy) ? raw.strategy : result[group].strategy;
    result[group].defaultPresetKey = validDefault(group, raw.defaultPresetKey) || validDefault(group, result[group].defaultPresetKey) || null;
    if (group === "advisor" && result[group].strategy === "all_enabled") result[group].defaultPresetKey = null;
  }
  return result;
}
export const MODE_PLAYBOOK_REVISION = 5;
export const INLINE_PLAIN_REPORT_RULE = "自然融合白话汇报（取代段末白话解读）：每点用人话讲清直观效果并顺畅带出关键机制、文件与真实结果/风险，禁机械复读口头禅。简短确认与子 Agent 汇报豁免。";
export function modeRosterSummary(profile, activePresets, { preferred = false, descriptionLimit = 20, compact = false } = {}) {
  const keys = Array.isArray(profile?.enabledKeys) ? profile.enabledKeys : [];
  return keys.map(key => {
    const preset = activePresets?.[key];
    const star = preferred && key === profile?.preferredKey ? "★" : "";
    const label = compact ? "" : preset?.label || key;
    const cleanDesc = String(preset?.description || "").replace(/[\s\p{Cc}\[\]｜|<>]+/gu, " ").trim();
    const shortDesc = Array.from(cleanDesc).slice(0, Math.min(20, descriptionLimit)).join("").trimEnd();
    const provider = normalizeProviderId(preset?.provider);
    let route = key;
    if (provider === "antigravity") {
      route = `swarm:${swarmMemberName(key)}/${buildAgyPinnedModelId(preset.model, preset.effort)}`;
    } else if (provider || preset?.model) {
      const model = String(preset?.model || ROUTER_DEFAULT_MODEL).trim() || ROUTER_DEFAULT_MODEL;
      const target = provider && !model.toLowerCase().startsWith(`${provider.toLowerCase()}/`) ? `${provider}/${model}` : model;
      const effort = String(preset?.effort || "").trim() || "inherit";
      route = `${key} · ${target}(${effort})`;
    }
    const body = `${route}${shortDesc ? `｜${shortDesc}` : ""}`;
    // Compact mode drops the label, so the brackets would only delimit nothing; omit them to save budget.
    return compact ? `${star}${body}` : `${star}${label}[${body}]`;
  }).join("、") || "无可用成员";
}
export function buildModePlaybook({ orchestrationMode, presetRevision = 0, presets, modeProfiles, memberPool, relayTargetPresetKey = "executor_codex", customPipelines = {} } = {}) {
  const mode = normalizeOrchestrationMode(orchestrationMode, "direct", customPipelines);
  const header = `<agent_tower_mode mode="${mode}" rev="${Number(presetRevision) || 0}">`;
  const end = "</agent_tower_mode>";
  if (mode === "direct") return [header, "[当前模式：⚡ 直出模式（派发总闸已关闭）]",
    "1. 严禁调用 delegate_task / delegate_parallel_batch / thread_launch / review_code 及宿主委派工具。",
    "2. 即使用户在对话中点名某成员，也必须直接回复「当前处于直出模式已拦截派发，如需调用请在AgentTower顶栏切换模式」，并由主会话独立完成任务。",
    "3. 当前会话待出队队列已冻结，切勿重试派单。", `4. ${INLINE_PLAIN_REPORT_RULE}`, end].join("\n");

  const activePresets = mergeActivePresets(presets, [], { rosterVersion: presets === undefined ? 1 : 2 });
  const profile = normalizeModeProfiles(modeProfiles, activePresets, { memberPool, relayTargetPresetKey })[mode];
  const intent = "勾选名单与阶段开关为可用上限池。L0 问答、拍板或核心<=4文件(不含单测)明确改动：0 派直答。L1 单域强耦合(含单测)选 1 人 shared，禁拆源码与单测；L2 多独立低耦合模块读 agent-tower-plan 选 2～4 人用独立 Worktree（原生 swarm 用 workspace:\"share\"，禁绕开★原生成员）。按点名→★首选（单兵默认选★；并派主力轨必含★，余轨按专长/空闲复用补位）选人。";
  function render(group) {
    const lines = mode === "relay" ? ["[当前模式：⚡ 简单模式]", `1. ${intent}`, `2. 执行官单派或并发派发：${group("executor")}。只读须传 executionIntent:\"read\"，默认可写。禁调军师团与 review_code。`,
      "3. 有 Worktree 成果才检查 worktree_diff、合入并验证。"] : ["[当前模式：⚡ 复杂自定义模式]", `1. ${intent} 执行官：${group("executor")}`,
      profile.advisor.stageEnabled ? `2. L3 军师阶段开启：仅用户要求讨论或有方案分歧时读 agent-tower-council 技能盲评。军师：${group("advisor")}` : "2. 军师阶段已关闭，不调军师。",
      profile.reviewer.stageEnabled ? `3. L3 审核阶段开启：仅实质代码/配置改动合入后调 review_code。纯问答/讨论跳过。审核官：${group("reviewer")}` : "3. 独立审核阶段已关闭，不调 review_code。改码由主会话自审并标注。"];
    return [header, ...lines, `4. ${INLINE_PLAIN_REPORT_RULE}`, end].join("\n");
  }
  const summary = (descriptionLimit, compact = false) => render(name => modeRosterSummary(profile[name], activePresets, {
    preferred: name !== "advisor", descriptionLimit, compact,
  }));
  const full = summary(20);
  if (Buffer.byteLength(full) <= 1536) return full;
  for (const length of [8, 0]) {
    const compact = summary(length, true);
    if (Buffer.byteLength(compact) <= 1536) return compact;
  }
  // Even IDs alone can exceed the budget. Refer to the complete authorized roster, never a partial ID.
  const digest = createHash("sha256").update(full).digest("hex").slice(0, 12);
  return render(name => `见 orchestrator_capabilities 的 activeMode.groups.${name}.enabledKeys 与 presets（${digest}）`);
}
export function roleMemberGroup(role) {
  if (String(role || "").trim().toLowerCase() === "curator") return "curator";
  if (["advisor", "design", "research"].includes(role)) return "advisor";
  if (["review", "reviewer"].includes(role)) return "reviewer";
  return "executor";
}

function parsePresetOptions(args) {
  let options = {};
  if (Array.isArray(args[0])) options = { deletedPresets: args.shift() };
  else if (args[0] && typeof args[0] === "object" && ("deletedPresets" in args[0] || "orchestrationMode" in args[0] || "executionIntent" in args[0] || "rosterVersion" in args[0])) options = args.shift();
  return { options, selections: args };
}
function presetError(message, code, details) { return Object.assign(new Error(message), { code, ...(details === undefined ? {} : { details }) }); }
function effectiveRelayPreset(preset, orchestrationMode, executionIntent) {
  if (normalizeOrchestrationMode(orchestrationMode) !== "relay" || executionIntent !== "read") return preset;
  const provider = normalizeProviderId(preset.provider);
  return { ...preset, permissionMode: provider === "codex" ? "read-only" : "plan", interactionMode: "plan" };
}
export function assertPresetTarget(presetKey, presets, ...args) {
  const { options, selections } = parsePresetOptions(args);
  const activePresets = mergeActivePresets(presets, options.deletedPresets || [], { rosterVersion: options.rosterVersion ?? (presets === undefined ? 1 : 2) });
  const explicit = String(presetKey || "").trim();
  if (!explicit) return;
  if ((options.deletedPresets || []).map(String).includes(explicit)) throw presetError(`角色预设已删除：${explicit}`, "PRESET_DELETED");
  if (!Object.hasOwn(activePresets, explicit)) throw presetError(`未知角色预设：${explicit}`, "UNKNOWN_PRESET", { presetKey: explicit, availableKeys: Object.keys(activePresets) });
  const preset = effectiveRelayPreset(activePresets[explicit], options.orchestrationMode, options.executionIntent);
  const provider = normalizeProviderId(preset.provider);
  const canonicalModel = value => { const valueText = String(value).trim(); if (isInheritedModel(valueText)) return ROUTER_DEFAULT_MODEL; return provider === "antigravity" ? splitAgyModelVariant(valueText).model : valueText; };
  for (const selection of selections) {
    const providers = [selection?.provider, selection?.driverKind, selection?.providerInstanceId, selection?.instanceId];
    if (providers.some(value => value != null && value !== "" && normalizeProviderId(value) !== provider) || (selection?.model != null && selection.model !== "" && canonicalModel(selection.model) !== canonicalModel(preset.model))) throw presetError(`已指定角色预设 ${explicit}（绑定 ${provider}/${preset.model}），请省略冲突的 provider/model 参数；若确需临时改用其他模型，请勿传 presetKey。`, "PRESET_TARGET_CONFLICT");
  }
  return preset;
}
export function assertPresetStrictFields(presetKey, presets, catalog, ...args) {
  const { options, selections } = parsePresetOptions(args);
  const preset = assertPresetTarget(presetKey, presets, options, ...selections);
  if (!preset) return;
  const provider = normalizeProviderId(preset.provider);
  const rawModel = isInheritedModel(preset.model) ? ROUTER_DEFAULT_MODEL : provider === "antigravity" ? splitAgyModelVariant(preset.model).model : String(preset.model || "").trim();
  const allowedEfforts = getCatalogEfforts(catalog, provider, rawModel);
  const presetVariant = provider === "antigravity" ? splitAgyModelVariant(preset.model).effort : undefined;
  const expectedEffort = normalizeEffortForTarget(provider, rawModel, presetVariant ?? preset.effort ?? "high", allowedEfforts);
  const expectedPerm = normalizePermissionModeForProvider(provider, preset.permissionMode || "auto", { fallback: NATIVE_PERMISSION_BY_TIER[permissionProfileOf(provider)].ask, strictReadOnly: false });
  const expectedInter = normalizeInteractionMode(undefined, expectedPerm === "plan" ? "plan" : undefined, preset.interactionMode || "default");
  for (const selection of selections) {
    if (!selection || typeof selection !== "object") continue;
    const rawEffort = selection.effort ?? selection.thinking ?? selection.reasoningEffort ?? selection.thought_level ?? extractOptionFromTargetOptions(selection.options, ["effort", "thinking", "reasoningEffort", "thought_level"]);
    const variant = provider === "antigravity" ? splitAgyModelVariant(selection.model).effort : undefined;
    for (const value of [rawEffort, variant]) { if (value == null || !String(value).trim()) continue; if (normalizeEffortForTarget(provider, rawModel, value, allowedEfforts) !== expectedEffort) throw presetError(`已指定角色预设 ${presetKey}（面板预设思考强度为 ${expectedEffort}），请勿同时传入冲突的 effort="${value}"；若需单次自定义配置，请省略 presetKey。`, "PRESET_TARGET_CONFLICT"); }
    const rawPerm = selection.permissionMode ?? selection.runtimeMode ?? extractOptionFromTargetOptions(selection.options, ["mode", "permissionMode", "runtimeMode"]);
    if (rawPerm != null && String(rawPerm).trim() !== "" && normalizePermissionModeForProvider(provider, rawPerm) !== expectedPerm) throw presetError(`已指定角色预设 ${presetKey}（面板预设权限为 ${expectedPerm}），请勿同时传入冲突的 permissionMode="${rawPerm}"；若需单次自定义配置，请省略 presetKey。`, "PRESET_TARGET_CONFLICT");
    const rawInter = selection.interactionMode ?? extractOptionFromTargetOptions(selection.options, ["interactionMode"]);
    if (rawInter != null && String(rawInter).trim() !== "" && String(rawInter).trim().toLowerCase() !== "inherit" && normalizeInteractionMode(rawInter, expectedPerm, expectedInter) !== expectedInter) throw presetError(`已指定角色预设 ${presetKey}（面板预设交互模式为 ${expectedInter}），请勿同时传入冲突的 interactionMode="${rawInter}"；若需单次自定义配置，请省略 presetKey。`, "PRESET_TARGET_CONFLICT");
  }
  return preset;
}
export function resolveRoleTarget({ role, presetKey, target, presets, deletedPresets = [], customProviders = [], catalog, orchestrationMode, executionIntent, modeProfiles, rosterVersion = presets === undefined ? 1 : 2 } = {}) {
  const activePresets = mergeActivePresets(presets, deletedPresets, { rosterVersion });
  const explicitPreset = assertPresetTarget(presetKey, activePresets, { deletedPresets, orchestrationMode, executionIntent, rosterVersion }, target);
  const roleKey = String(role || "general").trim().toLowerCase();
  const group = roleMemberGroup(roleKey);
  const profiles = normalizeModeProfiles(modeProfiles, activePresets);
  const mode = normalizeOrchestrationMode(orchestrationMode);
  const profile = mode === "relay" && group !== "curator" ? profiles.relay[group] : profiles.complex[group];
  const basePreset = explicitPreset || activePresets[group === "curator" ? profile?.preferredKey : profile?.enabledKeys[0]];
  const explicitProviderRaw = target?.provider || target?.driverKind || target?.providerInstanceId || target?.instanceId;
  const requestedModel = typeof target?.model === "string" ? target.model.trim() : "";
  if (!basePreset && !explicitProviderRaw && !requestedModel) {
    throw presetError("当前成员组没有可用成员，请明确选择成员或引擎", "MEMBER_SELECTION_REQUIRED", { group });
  }
  const effectivePreset = effectiveRelayPreset(basePreset || {}, orchestrationMode, executionIntent);
  let rawModel = explicitPreset ? effectivePreset.model : requestedModel || effectivePreset.model;
  if (isInheritedModel(rawModel)) rawModel = ROUTER_DEFAULT_MODEL;
  let variantEffort;
  let provider = explicitPreset ? normalizeProviderId(effectivePreset.provider) : normalizeProviderId(explicitProviderRaw);
  if (!provider) {
    if (requestedModel && !isInheritedModel(requestedModel) && requestedModel !== effectivePreset.model) {
      provider = inferProviderFromModel(requestedModel, customProviders);
      if (!provider && !/^gpt-oss/i.test(requestedModel)) { const matches = new Set(Object.values(activePresets).filter(p => p.model === requestedModel).map(p => normalizeProviderId(p.provider)).filter(Boolean)); if (matches.size === 1) [provider] = matches; }
      if (!provider) throw presetError("无法推断此模型的引擎；请明确指定 provider 或使用角色预设。", "PROVIDER_REQUIRED");
    } else provider = normalizeProviderId(effectivePreset.provider);
  }
  if (!provider) throw presetError("请明确指定 provider 或使用角色预设。", "PROVIDER_REQUIRED");
  const curator = group === "curator" || explicitPreset?.group === "curator";
  const restrictions = curator ? curatorRestrictions(provider) : null;
  if (!explicitPreset && explicitProviderRaw && !requestedModel && normalizeProviderId(effectivePreset.provider) !== provider) {
    if (provider === "kimi-code") rawModel = "kimi-code/k3.1-pro";
    else if (provider === "codex") rawModel = ["review", "reviewer", "research"].includes(String(role || effectivePreset.role).toLowerCase()) ? "gpt-6.2-astra" : "gpt-6.2-sol";
    else if (provider === "antigravity") rawModel = "gemini-4-hydrogen";
    else if (provider === "claude-code") rawModel = BUILTIN_CLAUDE_MODELS[0].slug;
    else { const extCfg = normalizeCustomProvidersList(customProviders).find(c => String(c.id || c.provider).toLowerCase() === provider.toLowerCase()); const tpl = BUILTIN_EXTENSION_TEMPLATES.find(t => t.id.toLowerCase() === provider.toLowerCase()); rawModel = extCfg?.defaultModel || extCfg?.models?.[0]?.slug || extCfg?.models?.[0]?.id || tpl?.defaultModels?.[0]?.slug || `${provider}/default`; }
  }
  if (provider === "antigravity" && !isInheritedModel(rawModel)) { const split = splitAgyModelVariant(rawModel); variantEffort = splitAgyModelVariant(requestedModel || rawModel).effort; rawModel = split.model; }
  assertAgySubagentModel(provider, rawModel);
  const rawEffort = target?.effort ?? target?.thinking ?? target?.reasoningEffort ?? target?.thought_level ?? extractOptionFromTargetOptions(target?.options, ["effort", "thinking", "reasoningEffort", "thought_level"]) ?? variantEffort ?? effectivePreset.effort ?? "high";
  const effort = normalizeEffortForTarget(provider, rawModel, rawEffort, getCatalogEfforts(catalog, provider, rawModel));
  const relayRead = normalizeOrchestrationMode(orchestrationMode) === "relay" && executionIntent === "read";
  const rawPermission = target?.permissionMode ?? target?.runtimeMode ?? extractOptionFromTargetOptions(target?.options, ["mode", "permissionMode", "runtimeMode"]);
  const presetProvider = normalizeProviderId(effectivePreset.provider);
  const permissionMode = restrictions?.permissionMode ?? (relayRead ? (provider === "codex" ? "read-only" : "plan") : normalizePermissionModeForProvider(provider, rawPermission) ?? normalizePermissionModeForProvider(provider, effectivePreset.permissionMode || "auto", { fallback: NATIVE_PERMISSION_BY_TIER[permissionProfileOf(provider)].ask, crossEngine: Boolean(presetProvider && presetProvider !== provider), strictReadOnly: false }));
  assertReadOnlySupport(provider, permissionMode);
  const interactionMode = relayRead ? "plan" : normalizeInteractionMode(target?.interactionMode ?? extractOptionFromTargetOptions(target?.options, ["interactionMode"]), permissionMode === "plan" ? "plan" : rawPermission, effectivePreset.interactionMode || "default");
  const isolation = normalizeIsolation(target?.isolation, effectivePreset.isolation || "shared");
  return { provider, model: rawModel, effort, permissionMode, interactionMode, isolation, ...restrictions, ...(curator ? { role: "curator" } : {}), routing: { requestedPresetKey: presetKey || null, requestedModel: requestedModel || null, resolvedModel: rawModel, selectionSource: explicitPreset ? "preset" : explicitProviderRaw || requestedModel ? "explicit" : "role_default", ...(orchestrationMode ? { orchestrationMode: normalizeOrchestrationMode(orchestrationMode, "direct", {}) } : {}), ...(orchestrationMode && executionIntent !== undefined ? { executionIntent } : {}) } };
}

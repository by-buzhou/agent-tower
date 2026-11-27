import { pluginSpec, resolveEvolutionIndexPath } from "../spec-context.mjs";
export { hasEvolutionIndex, hasRoadmapDoc, resolveEvolutionPromptHint } from "../spec-context.mjs";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePermissionModeForProvider, sanitizeExtensionProviderConfig } from "../catalog.mjs";
import { inside } from "../storage-paths.mjs";
import { PLUGIN_VERSION as VERSION } from "../daemon-client.mjs";

// Recorded on every run this daemon starts so another daemon (or a later restart) can tell live owners from orphans.
const OWNER_STARTED_AT = Math.round(Date.now() - process.uptime() * 1000);
const ACTIVE_RUN_STATUSES = ["running", "starting", "preparing", "waiting", "waiting_approval", "waiting_input"];
const ROOT_REJECTION_TEXT = {
  not_absolute: "不是绝对路径",
  missing: "路径不存在",
  not_directory: "不是目录",
  restricted: "命中受保护的敏感目录（系统目录 / 盘符根 / 用户主目录根 / 桌面 / 系统临时目录 / 插件挂载与控制面）",
};

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  if (n === process.pid) return true;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function foreignRunOwnerPid(run) {
  const pid = Number(run?.meta?.ownerPid);
  return pid !== process.pid && isPidAlive(pid) ? pid : null;
}

function normalizeProjectPath(rawPath) {
  const s = String(rawPath || "").trim();
  if (!s) return "";
  try {
    let resolved = path.resolve(s).replace(/\\/g, "/").replace(/\/+$/, "");
    if (process.platform === "win32") {
      // Canonicalize drive letter to uppercase for consistent equality & display
      if (/^[a-z]:/.test(resolved)) {
        resolved = resolved[0].toUpperCase() + resolved.slice(1);
      }
    }
    return resolved;
  } catch {
    return s.replace(/\\/g, "/").replace(/\/+$/, "");
  }
}

function projectPathKey(rawPath) {
  const norm = normalizeProjectPath(rawPath);
  return process.platform === "win32" ? norm.toLowerCase() : norm;
}

function isIsolatedWorktreePath(rawPath) {
  const key = projectPathKey(rawPath);
  if (!key) return false;
  const testRoot = projectPathKey(process.env.AGENT_TOWER_TEST_ROOT);
  // Ignore any enclosing Worktree that hosts the test sandbox itself.
  const localKey = testRoot && key.startsWith(testRoot + '/') ? key.slice(testRoot.length) : key;
  return localKey.includes("/plugin_data/agent-tower/worktrees/") ||
    localKey.includes("/.agent-tower/worktrees/");
}

function isTempTestPath(rawPath) {
  const key = projectPathKey(rawPath);
  if (!key) return false;
  const sysTmp = projectPathKey(process.env.TEMP || process.env.TMPDIR || "");
  const inSysTmp =
    (sysTmp && (key === sysTmp || key.startsWith(`${sysTmp}/`))) ||
    key.includes("/appdata/local/temp/") ||
    key === "/tmp" ||
    key.startsWith("/tmp/");
  if (!inSysTmp) {
    // Also hide scratch tmp-* / tower-e2e-* paths from production UI unless includeTemp=true
    return /\/(?:tmp-|tower-smoke|tower-e2e-)/i.test(key);
  }
  // Any path inside OS temp directory or containing test prefixes is treated as temporary test artifact
  return (
    inSysTmp ||
    /(?:tower-|tower-e2e-|smoke|tmp-v\d|vitest|jest)/i.test(key)
  );
}

function shouldAutoEphemeralForPath(rawPath) {
  if (!rawPath) return false;
  if (isTempTestPath(rawPath)) return true;
  const key = projectPathKey(rawPath);
  return (
    key.includes("/.tmp-e2e") ||
    key.includes("/tests/agent-tower-e2e") ||
    key.endsWith("/.tmp-e2e") ||
    key.endsWith("/tests/agent-tower-e2e")
  );
}

function resolveEphemeralFlag(params = {}, candidatePaths = []) {
  return params.ephemeral === true || candidatePaths.some(shouldAutoEphemeralForPath);
}

function shouldHideExternalSession(db, thread, workspace, persistSession) {
  if (thread?.isNativeHost) return false;
  if (thread?.meta?.ephemeral === true) return true;
  if (typeof thread?.meta?.externalSessionVisible === "boolean") return !thread.meta.externalSessionVisible;
  return persistSession !== true && !db.isProjectExternalSessionVisible(workspace);
}

function deriveProjectName(projectRoot) {
  const norm = normalizeProjectPath(projectRoot);
  if (!norm) return "未归属工作区";
  const base = path.posix.basename(norm);
  return base || norm;
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

function summarizeTitle(text, fallback = "Agent Task") {
  const firstLine = String(text || "")
    .replace(/^\[ROLE:[^\]]+\]\s*/i, "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  if (!firstLine) return fallback;
  return firstLine.length > 72 ? `${firstLine.slice(0, 70)}…` : firstLine;
}

function summarizeOutput(text, maxLen = 420) {
  const s = String(text || "").trim();
  if (!s) return "";
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}…`;
}

function isThreadBusyStatus(status) {
  const s = String(status || "").toLowerCase();
  return (
    s === "running" ||
    s === "starting" ||
    s === "preparing" ||
    s === "queued" ||
    s === "waiting_approval" ||
    s === "waiting_input"
  );
}

// Always resolve to the engine's own native permission value (never escalating across engines).
function normalizePermissionMode(rawMode, fallback = "auto", provider = "") {
  const explicit = normalizePermissionModeForProvider(provider, rawMode);
  if (explicit !== undefined) return explicit;
  return normalizePermissionModeForProvider(provider, fallback, { fallback: "default", strictReadOnly: false });
}

function normalizeInteractionMode(rawInter, rawPerm) {
  const i = String(rawInter || "").trim().toLowerCase();
  const p = String(rawPerm || "").trim().toLowerCase();
  if (i === "plan" || p === "plan") return "plan";
  return "default";
}

export const RELAY_READ_INTENT_TAG = '<agent_tower_intent mode="relay" intent="read">本轮仅做只读代码分析、排查或方案解答，严禁修改、新建或删除任何文件。</agent_tower_intent>\n';
export function buildDynamicPrompt({ prompt, orchestrationMode, executionIntent } = {}) {
  const text = String(prompt || "").trim();
  return orchestrationMode === "relay" && executionIntent === "read" ? `${RELAY_READ_INTENT_TAG}${text}` : text;
}

// Standalone prompt helper kept for callers that do not have a session ledger.
export function buildEffectivePrompt({ prompt, role, orchestrationMode, executionIntent, cwd, repoRoot, skipEvolutionHint = false } = {}) {
  let text = String(prompt || "").trim();
  const evolutionPath = skipEvolutionHint ? "" : resolveEvolutionIndexPath(cwd, repoRoot);
  const card = pluginSpec(role, {
    withEvolution: Boolean(evolutionPath) && !/(?:^|\r?\n)\[EVOLUTION INDEX\]\r?\n/.test(text),
    evolutionPath,
  });
  if (card && !text.startsWith("[ROLE:")) text = `${card.body}\n\n${text}`;
  return buildDynamicPrompt({ prompt: text, orchestrationMode, executionIntent });
}
function enrichThreadForClient(thread, { allThreadsById, repoRootCache, fallbackWorkspace = "" } = {}) {
  if (!thread || typeof thread !== "object") return thread;
  const isNative = Boolean(
    thread.isNativeHost ||
      thread.meta?.isNativeHost ||
      (thread.provider === "antigravity" &&
        (thread.hostConversationId || String(thread.id || "").startsWith("thr_native_")))
  );
  const hostConvId =
    thread.hostConversationId ||
    thread.meta?.hostConversationId ||
    (isNative ? thread.nativeSessionId || "" : "");

  // Resolve standardized `rootConversationId` (the single per-conversation isolation key):
  // 1) Walk parentThreadId chain if present so child subagents/worktrees always inherit rootConversationId
  // 2) Fallback to explicit `meta.rootConversationId` / `hostConversationId` / `parentConversationId`
  let rootConversationId =
    thread.rootConversationId ||
    thread.meta?.rootConversationId ||
    "";
  if (!rootConversationId && thread.parentThreadId && allThreadsById) {
    let cur = allThreadsById.get(thread.parentThreadId);
    const visited = new Set([thread.id]);
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      const candRoot =
        cur.rootConversationId ||
        cur.meta?.rootConversationId ||
        cur.hostConversationId ||
        cur.meta?.hostConversationId ||
        cur.meta?.parentConversationId ||
        "";
      if (candRoot) {
        rootConversationId = candRoot;
        break;
      }
      cur = cur.parentThreadId ? allThreadsById.get(cur.parentThreadId) : null;
    }
  }
  if (!rootConversationId) {
    rootConversationId =
      thread.meta?.parentConversationId ||
      hostConvId ||
      "";
  }

  // Resolve standardized `projectRoot` & `projectName`:
  // 1) Child subagents inherit parent's `projectRoot` so worktree subagents never detach from their project.
  // 2) Explicitly stored `meta.projectRoot` or normalized repoRoot/workspace/cwd (skipping worktree dirs when possible).
  let resolvedRoot = thread.meta?.projectRoot || thread.projectRoot || "";
  if (!resolvedRoot && thread.parentThreadId && allThreadsById) {
    let cur = allThreadsById.get(thread.parentThreadId);
    const visited = new Set([thread.id]);
    while (cur && !visited.has(cur.id)) {
      visited.add(cur.id);
      const cand = cur.projectRoot || cur.meta?.projectRoot || cur.workspace || (!isIsolatedWorktreePath(cur.cwd) ? cur.cwd : "");
      if (cand) {
        resolvedRoot = cand;
        break;
      }
      cur = cur.parentThreadId ? allThreadsById.get(cur.parentThreadId) : null;
    }
  }

  if (!resolvedRoot) {
    const rawWs = thread.projectRoot || thread.meta?.projectRoot || thread.workspace || "";
    const rawCwd = thread.cwd || "";
    if (rawWs && !isIsolatedWorktreePath(rawWs)) {
      resolvedRoot = rawWs;
    } else if (rawCwd && !isIsolatedWorktreePath(rawCwd)) {
      resolvedRoot = rawCwd;
    } else if (rawWs) {
      resolvedRoot = rawWs;
    } else if (rawCwd) {
      resolvedRoot = rawCwd;
    }
  }

  if (resolvedRoot && repoRootCache) {
    const k = projectPathKey(resolvedRoot);
    if (repoRootCache.has(k)) {
      resolvedRoot = repoRootCache.get(k) || resolvedRoot;
    }
  }

  if (!resolvedRoot && isNative && fallbackWorkspace) {
    resolvedRoot = fallbackWorkspace;
  }

  const projectRoot = normalizeProjectPath(resolvedRoot);
  const projectName = deriveProjectName(projectRoot);

  return {
    ...thread,
    memberName: thread.memberName || thread.meta?.memberName || "",
    isSwarmMember: Boolean(thread.isSwarmMember || thread.meta?.isSwarmMember),
    isNativeHost: isNative,
    hostConversationId: hostConvId,
    rootConversationId: String(rootConversationId || ""),
    projectRoot,
    projectName,
    workspace: projectRoot || thread.workspace || "",
  };
}

function deriveCleanMemberName({ role = "executor", presetKey = "", provider = "", title = "", id = "" } = {}) {
  if (String(presetKey || "").trim()) return String(presetKey).trim();
  const r = String(role || "").toLowerCase();
  if (r === "commander" || r === "coordinator") return "coordinator";
  if (r === "review" || r === "reviewer") return "reviewer";
  if (provider === "claude-code") return ["advisor", "design"].includes(r) ? "advisor_claude" : "executor_claude";
  if (r === "advisor") return provider === "codex" ? "advisor_codex" : "advisor_kimi";
  if (r === "research") return "researcher";
  if (provider === "codex") return "executor_codex";
  if (provider === "kimi-code") return "executor_kimi";
  if (provider === "antigravity") return "executor_hydrogen";
  if (provider) return String(provider);
  const cleanTitle = String(title || "").trim().slice(0, 24);
  return cleanTitle || String(id || "agent").slice(0, 12);
}

function assertExternalDispatch() {}

function mapSwarmStateToThreadStatus(swarmState = "") {
  const s = String(swarmState || "").trim().toLowerCase();
  if (s === "working" || s === "running") return "running";
  if (s === "waiting") return "waiting";
  if (s === "error" || s === "failed") return "failed";
  if (s === "killed" || s === "stopped") return "interrupted";
  return "completed";
}

function enrichExtensionTemplates(list = []) {
  return list.map((tpl) => ({
    ...tpl,
    name: tpl.name || tpl.displayName || tpl.id,
    displayName: tpl.displayName || tpl.name || tpl.id,
  }));
}

function sanitizeCustomProviderForPublic(cfg = {}) {
  const clean = sanitizeExtensionProviderConfig(cfg);
  return {
    ...clean,
    name: clean.displayName || clean.id,
  };
}

/**
 * Create the stateful Multi-Agent Orchestrator engine backed by SQLite WAL + Engine Drivers + Git Worktrees.
 */

export {
  assertExternalDispatch,
  VERSION,
  OWNER_STARTED_AT,
  ACTIVE_RUN_STATUSES,
  ROOT_REJECTION_TEXT,
  foreignRunOwnerPid,
  normalizeProjectPath,
  projectPathKey,
  isIsolatedWorktreePath,
  isTempTestPath,
  resolveEphemeralFlag,
  shouldHideExternalSession,
  deriveProjectName,
  makeId,
  summarizeTitle,
  summarizeOutput,
  isThreadBusyStatus,
  normalizePermissionMode,
  normalizeInteractionMode,
  enrichThreadForClient,
  deriveCleanMemberName,
  mapSwarmStateToThreadStatus,
  enrichExtensionTemplates,
  sanitizeCustomProviderForPublic,
};

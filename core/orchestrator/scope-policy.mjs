import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { inspectProjectRoot } from "../storage-paths.mjs";
import { resolveProjectRootSync } from "../global-settings.mjs";
import {
  assembleSpecPrompt, hasCouncilsIndex, hasPlansIndex, inspectSpecPath, projectSpecFileStamps,
  readOnlyGit, readPlanDocument, readProjectSpecs, resolveEvolutionIndexPath, resolveRoadmapDocPath, specSelection,
} from "../spec-context.mjs";
import { inferCallingHostConversation, readNativeSwarmSnapshot, resolveConversationRoot, resolveDefaultAppDataDir } from "../engines/agy-native.mjs";
import {
  ACTIVE_RUN_STATUSES,
  ROOT_REJECTION_TEXT,
  isIsolatedWorktreePath,
  normalizeProjectPath,
  projectPathKey,
} from "./helpers.mjs";
import {
  MODE_PLAYBOOK_REVISION,
  buildModePlaybook,
  normalizeMemberPool,
  normalizeModeProfiles,
  normalizeOrchestrationMode,
  swarmMemberName,
} from "../catalog.mjs";

const PROJECT_CONTEXT_LIMIT = 1536;
const SPEC_INDEX_LINK = ".agent-tower/spec/INDEX.md";
const SPEC_MAINTENANCE = "【规范维护】主会话与干活成员只读消费项目规范，由专职规范维护官提案，经用户确认后落盘。";
const singleLine = text => text.replace(/[<>]/g, char => char === "<" ? "&lt;" : "&gt;").replace(/[\r\n\t]+/g, " ");

const HOST_DOC_PATHS = [
  ".agent-tower/docs/ROADMAP.md", ".agent-tower/docs/evolution/INDEX.md",
  ".agent-tower/councils/INDEX.md", ".agent-tower/plans/INDEX.md",
];

function fileStamp(file) {
  try {
    const stat = inspectSpecPath(file);
    return stat?.isFile() ? [stat.mtimeMs, stat.size, stat.ctimeMs, stat.ino] : null;
  } catch { return null; }
}

function readHostProjectContext(root, specEnabled) {
  const empty = { projectContextBlock: "", contextHash: "" };
  if (!root) return empty;
  const specs = specEnabled ? readProjectSpecs(root).specs : [];
  const roadmap = resolveRoadmapDocPath(root);
  const evolution = resolveEvolutionIndexPath(root);
  const councils = hasCouncilsIndex(root);
  const plans = hasPlansIndex(root);
  if (!specs.length && !roadmap && !evolution && !councils && !plans) return empty;

  // Include spec revisions and titles in the fingerprint even when their visible path has not changed.
  const contextHash = createHash("sha256").update(JSON.stringify([root, specEnabled, roadmap, evolution, councils, plans,
    specs.map(({ key, title, relPath, sha256 }) => [key, title, relPath, sha256])])).digest("hex");
  const start = `<agent_tower_project_context sha="${contextHash.slice(0, 12)}">`;
  const end = "</agent_tower_project_context>";
  const footer = [
    ...(roadmap ? [`- ${roadmap} · 路线图入口，执行阶段按需隔离。`] : []),
    ...(evolution ? [`- ${evolution} · 历史演进与曾否决方案索引。`] : []),
    ...(councils ? ["- .agent-tower/councils/INDEX.md · 军师会审纪要索引（续议同题可查阅，新会审按四段式归档）。"] : []),
    ...(plans ? ["- .agent-tower/plans/INDEX.md · 定稿施工规划索引（派工与终审对照 Checklist）。"] : []),
    ...(specEnabled ? [SPEC_MAINTENANCE] : []), end,
  ];
  const lines = [];
  const render = (more = []) => [start, ...lines, ...more, ...footer].join("\n");
  const overflow = count => `- 另有 ${count} 份规范，查阅 ${SPEC_INDEX_LINK}。`;
  for (const [index, spec] of specs.entries()) {
    const rawTitle = spec.title && spec.title !== spec.id ? spec.title.trim() : "";
    const shortTitle = rawTitle ? ` · ${rawTitle.length > 26 ? `${rawTitle.slice(0, 25)}…` : rawTitle}` : "";
    const line = singleLine(`- ${spec.key}${spec.required ? " [必读]" : ""}${spec.scopes.length ? ` · scopes: ${spec.scopes.join(", ")}` : ""}${shortTitle} (${spec.relPath})`);
    const remaining = specs.length - index - 1;
    const preview = render(remaining ? [line, overflow(remaining)] : [line]);
    if (Buffer.byteLength(preview) > PROJECT_CONTEXT_LIMIT) {
      lines.push(overflow(remaining + 1));
      break;
    }
    lines.push(line);
  }
  return { projectContextBlock: render(), contextHash };
}

export function createScopePolicyModule(ctx) {
  // Explicit host workspace hints take precedence over an implicit binding to the default DB.
  const policyWorkspaces = new Map();
  const pendingPlaybookCommits = new Map();
  let lastActiveHost = { rootConversationId: "", workspace: "", updatedAt: 0 };
  const lastActiveHostTtlMs = 30 * 60 * 1000;

  function inspectHostProjectRoot(candidate) {
    if (typeof candidate !== "string" || !path.isAbsolute(candidate)) return {};
    try {
      // Check the original path before inspectProjectRoot can resolve links.
      inspectSpecPath(path.resolve(candidate));
      return inspectProjectRoot(candidate, ctx.dataDir);
    } catch { return {}; }
  }

  function normalizeHostWorkspace(candidate) {
    const root = inspectHostProjectRoot(candidate).root;
    if (!root || !isIsolatedWorktreePath(root)) return root || "";
    const marker = [...root.matchAll(/[\\/]\.agent-tower[\\/]worktrees[\\/]/gi)].at(-1);
    return marker ? inspectHostProjectRoot(root.slice(0, marker.index)).root || "" : root;
  }

  function getBoundPolicyWorkspace(root) {
    return policyWorkspaces.get(String(root || "").trim().toLowerCase()) || ctx.db.getConversationPolicyRecord(root)?.workspace;
  }

  function recordActiveHost(root, params = {}, workspace) {
    if (params._standalone || !root || ctx.db.isManagedChildSession(root) || ctx.db.isManagedChildSession(params.conversationId)) return;
    lastActiveHost = {
      rootConversationId: root,
      workspace: normalizeHostWorkspace(workspace === undefined ? hostProjectRoot(root, params) : workspace),
      updatedAt: Date.now(),
    };
  }

  function getLastActiveHost() {
    return lastActiveHost.rootConversationId && Date.now() - lastActiveHost.updatedAt < lastActiveHostTtlMs
      ? { ...lastActiveHost } : null;
  }

  function getSuggestedConversation({ workspace = "", availableConversations = [] } = {}) {
    const recent = getLastActiveHost();
    const recentKey = projectPathKey(recent?.workspace);
    const recentProject = ctx.repoRootCache.get(recentKey) || recent?.workspace;
    if (recent && (!workspace || projectPathKey(recentProject) === projectPathKey(workspace))) {
      const id = recent.rootConversationId.toLowerCase();
      if (availableConversations.some(c => c.rootConversationId.toLowerCase() === id)) return recent.rootConversationId;
    }
    return availableConversations.length === 1 ? availableConversations[0].rootConversationId : null;
  }

  function hostProjectRoot(root, params) {
    const record = ctx.db.getConversationPolicyRecord(root);
    const thread = ctx.db.getConversationThread(root) || ctx.db.getThread(root, { includeQueue: false });
    for (const candidate of [policyWorkspaces.get(root.toLowerCase()), thread?.meta?.projectRoot, thread?.workspace,
      record?.workspace !== ctx.db.defaultStudioRoot ? record?.workspace : undefined]) {
      const result = inspectHostProjectRoot(candidate);
      if (result.root) return result.root;
    }
    const workspace = inspectHostProjectRoot(params.workspace);
    const cwd = inspectHostProjectRoot(params.cwd);
    if (workspace.root || cwd.root) return workspace.root || cwd.root;
    return undefined;
  }

  function resolveSyncWorkspace(candidate) {
    if (!candidate) return "";
    const cached = ctx.repoRootCache?.get(projectPathKey(candidate));
    if (cached) return cached;
    const resolved = resolveProjectRootSync(candidate, ctx.db.getSettings()?.projectProfiles);
    return (resolved && inspectHostProjectRoot(resolved).root) || candidate;
  }

  function configWorkspace(params = {}, root = policyRoot(params)) {
    const explicit = normalizeHostWorkspace(params.workspace || params.cwd);
    if (explicit) return resolveSyncWorkspace(explicit);
    const thread = ctx.db.getThread(params.threadId || params.parentThreadId || params.taskId || params.id, { includeQueue: false });
    const fallback = normalizeHostWorkspace(thread?.meta?.projectRoot || thread?.workspace || thread?.cwd) ||
      (root && (hostProjectRoot(root, params) || normalizeHostWorkspace(getBoundPolicyWorkspace(root)) ||
        (lastActiveHost.rootConversationId.toLowerCase() === root.toLowerCase() ? normalizeHostWorkspace(lastActiveHost.workspace) : ""))) || "";
    return fallback ? resolveSyncWorkspace(fallback) : "";
  }

  async function resolveConfigWorkspace(params) {
    const workspace = configWorkspace(params);
    return workspace ? normalizeHostWorkspace(await ctx.queries.resolveRepoRootCached(workspace)) : "";
  }

  // Explicit directories are fail-closed: a missing, non-directory or sensitive path is rejected instead of silently
  // running in the default root (which would cross-contaminate another project). Only an absent cwd uses defaults.
  function assertUsableRoot(candidate, label = "cwd") {
    const { root, reason } = inspectProjectRoot(candidate, ctx.dataDir);
    if (root) return root;
    throw Object.assign(new Error(`${label} 不可用（${ROOT_REJECTION_TEXT[reason] || reason}）：${candidate}；已拒绝执行，未回退到默认项目目录。`),
      { code: "CWD_REJECTED", reason });
  }

  function explicitExecutionRoot(params = {}) {
    const cwd = params.cwd === undefined ? null : assertUsableRoot(params.cwd, "cwd");
    const workspace = params.workspace === undefined ? null : assertUsableRoot(params.workspace, "workspace");
    return cwd || workspace;
  }

  function executionRoot(params = {}) {
    const explicit = explicitExecutionRoot(params);
    if (explicit) return explicit;
    const parent = ctx.db.getThread(params.parentThreadId || params.threadId) ||
      ctx.hostSync.findThreadByHostConversationId(params.parentConversationId || params.conversationId);
    return ctx.db.resolveRoot(parent?.meta?.projectRoot || parent?.workspace || parent?.cwd || configWorkspace(params));
  }

  function resolveEffectiveRootConversationId({
    conversationId = "",
    parentConversationId = "",
    parentThreadId = "",
    cwd = "",
    appDataDir = "",
    allowInfer = false,
  } = {}) {
    const appDir = resolveDefaultAppDataDir(appDataDir || ctx.hostContext.appDataDir, ctx.hostSync.buildHostEnvForDriver());

    if (parentThreadId) {
      const pThread = ctx.db.getThread(parentThreadId, { includeQueue: false });
      const pRoot = pThread?.rootConversationId || pThread?.meta?.rootConversationId || pThread?.hostConversationId || "";
      if (pRoot) {
        const resolvedParent = resolveConversationRoot(pRoot, appDir);
        // Only overwrite pRoot with Swarm coordinator root if pRoot wasn't already an isolated synthetic conversation
        if (resolvedParent && resolvedParent !== pRoot) return resolvedParent;
        return pRoot;
      }
    }

    const rawConv = String(parentConversationId || conversationId || "").trim();
    if (rawConv) {
      // Only resolve against Swarm/subagent brain dir when rawConv actually exists in brain/ or members.json;
      // otherwise preserve rawConv verbatim so unrelated conversations never collide!
      return resolveConversationRoot(rawConv, appDir);
    }

    if (allowInfer) {
      return inferCallingHostConversation({ appDataDir: appDir, cwd, maxAgeMs: 60000 }) || "";
    }

    return "";
  }

  function threadPolicyRoot(thread) {
    if (!thread) return "";
    const directRoot = thread.rootConversationId || thread.meta?.rootConversationId;
    if (directRoot) return directRoot;
    const seen = new Set();
    let hostId = "";
    while (thread && !seen.has(thread.id)) {
      seen.add(thread.id);
      if (thread.meta?.rootConversationId) return thread.meta.rootConversationId;
      hostId = thread.hostConversationId || hostId;
      thread = thread.parentThreadId && ctx.db.getThread(thread.parentThreadId, { includeQueue: false });
    }
    return hostId;
  }

  function policyRoot(params = {}) {
    for (const id of [params.conversationId, params.parentConversationId, params.parentThreadId, params.threadId, params.taskId, params.id]) {
      if (!id) continue;
      const thread = ctx.db.getThread(id, { includeQueue: false }) || ctx.db.getConversationThread(id);
      const mapped = threadPolicyRoot(thread);
      if (mapped) return mapped;
      if ((id === params.conversationId || id === params.parentConversationId) && !thread) {
        return resolveEffectiveRootConversationId({ conversationId: id, appDataDir: params.appDataDir });
      }
    }
    return "";
  }

  function withDispatchConversation(params) {
    if (params.conversationId || params.parentConversationId || params.parentThreadId || params.threadId || params._skipInferConversation) return params;
    const conversationId = resolveEffectiveRootConversationId({ cwd: executionRoot(params), appDataDir: params.appDataDir, allowInfer: true });
    return conversationId ? { ...params, conversationId } : params;
  }

  function readConversationPolicy(rootConversationId, settings = ctx.db.getSettings()) {
    const defaultOrchestrationMode = normalizeOrchestrationMode(
      settings.defaultOrchestrationMode,
      settings.defaultDispatchEnabled ? "relay" : "direct",
      settings.customPipelines,
    );
    const defaultDispatchEnabled = defaultOrchestrationMode !== "direct";
    const record = rootConversationId ? ctx.db.getConversationPolicyRecord(rootConversationId) : null;
    const orchestrationMode = normalizeOrchestrationMode(
      record?.orchestrationMode,
      rootConversationId === null ? "direct" : defaultOrchestrationMode,
      settings.customPipelines,
    );
    return {
      conversationId: rootConversationId, rootConversationId,
      orchestrationMode,
      dispatchEnabled: record?.dispatchEnabled ?? orchestrationMode !== "direct",
      defaultOrchestrationMode,
      defaultDispatchEnabled,
      policyRevision: record?.policyRevision ?? 0,
      source: record?.source ?? "default",
      updatedAt: record?.updatedAt ?? null,
    };
  }

  function dispatchBypass(params, targetThread) {
    const thread = targetThread || (params.threadId && ctx.db.getThread(params.threadId, { includeQueue: false }));
    if (thread?.role === "curator" && (params._manualCurationBypass === true || thread.meta?.triggerSource === "manual")) return null;
    const root = policyRoot(params);
    const related = [
      root,
      threadPolicyRoot(targetThread),
      params.parentThreadId && policyRoot({ parentThreadId: params.parentThreadId }),
      params.parentConversationId && policyRoot({ conversationId: params.parentConversationId, appDataDir: params.appDataDir }),
    ].filter(Boolean);
    for (const id of new Set(related.length ? related : [root])) {
      const policy = readConversationPolicy(id);
      if (!policy.dispatchEnabled) {
        const workspace = configWorkspace({
          ...params,
          workspace: params.workspace || thread?.meta?.projectRoot || thread?.workspace,
          cwd: params.cwd || thread?.cwd,
        }, id);
        return {
          ok: true, bypassed: true, code: "host_direct_only", mode: "host_direct_only",
          orchestrationMode: "direct", dispatchEnabled: false, sideEffects: false,
          conversationId: id, policyRevision: policy.policyRevision, status: "bypassed_by_policy",
          summary: "当前对话已关闭AgentTower子 Agent 派发开关（主会话直出模式）。",
          instruction: "用户已关闭本对话的子 Agent 派发开关（含外部引擎与宿主原生 invoke_subagent）。请勿重试任何委派工具，直接在当前主会话内独立完成本轮任务。",
          activeMode: getActiveModeSummary({ conversationId: id, ...(workspace ? { workspace } : {}) }),
        };
      }
    }
    return null;
  }

  function hostToolGate(root, params, settings, readActiveMode, workspace) {
    const toolName = params.hostToolName;
    if (!["swarm", "invoke_subagent"].includes(toolName)) return {};
    const args = params.hostToolArgs || {};
    const caller = String(params.conversationId || "").toLowerCase();
    const nativeKind = toolName === "swarm" ? "swarm" : "subagent";
    const curationTicket = root && ctx.dispatch?.findNativeHandoff({ rootConversationId: root, nativeKind, role: "curator",
      unboundWorkspace: workspace, includeClaimed: true, requireUnique: true,
      matchesToolArgs: action => action.tool === toolName && Object.entries(action.args).every(([key, value]) => args[key] === value) });
    if (curationTicket) {
      if (caller === root.toLowerCase() && !curationTicket.admittedAt &&
          ctx.specs.admitNativeCuration(curationTicket, root)) {
        return { hostToolAllowed: true, curationTicketAllowed: true, handoffId: curationTicket.handoffId };
      }
      return { hostToolAllowed: false, hostToolReason: "规范维护票据仅可由对应主会话执行一次。" };
    }
    if ([args.Prompt, args.brief].some(value => typeof value === "string" &&
        value.startsWith("[AgentTower Curation Ticket #"))) {
      return { hostToolAllowed: false, hostToolReason: "规范维护需要有效的原生派遣票据。" };
    }
    const presets = settings.presets || {};
    if (toolName === "invoke_subagent") {
      const label = String(args.Role || "").trim().toLowerCase();
      const curator = label && Object.entries(presets).some(([key, preset]) => preset.group === "curator" &&
        preset.provider === "antigravity" && [key, preset.label, preset.title].some(value => String(value || "").toLowerCase() === label));
      return curator ? { hostToolAllowed: false, hostToolReason: "规范维护需要有效的原生派遣票据。" } : {};
    }
    if (args.action !== "add") return { hostToolAllowed: true };
    const name = String(args.name || "").trim().toLowerCase();
    if (!name) return { hostToolAllowed: true };
    const canonical = value => String(value || "").replace(/-/g, "_").toLowerCase();
    const presetKey = Object.keys(presets).find(key => presets[key].provider === "antigravity" &&
      [key, swarmMemberName(key)].some(value => canonical(value) === canonical(name)));
    if (!presetKey) return { hostToolAllowed: true };
    if (presets[presetKey].group === "curator") {
      return { hostToolAllowed: false, hostToolReason: "规范维护需要有效的原生派遣票据。" };
    }
    const active = readActiveMode();
    const enabled = Object.values(active.groups).some(group => group.enabledKeys.includes(presetKey));
    const ticket = ctx.dispatch?.findNativeHandoff({ rootConversationId: root, presetKey, swarmName: name, nativeKind: "swarm" });
    if (enabled || ticket) return { hostToolAllowed: true, ...(ticket ? { handoffId: ticket.handoffId } : {}) };
    return { hostToolAllowed: false,
      hostToolReason: `宿主原生成员 ${name} 对应已配置但当前模式未启用的预设 ${presetKey}，且没有有效待认领 handoffId；已拒绝 swarm add。请先在塔台启用该成员或通过统一派发入口生成本轮票据。` };
  }

  function conversationWorkCounts(root) {
    const counts = { runningCount: 0, queuedCount: 0 };
    for (const row of ctx.db.listWorkCountsByThread()) {
      const thread = ctx.db.getThread(row.threadId, { includeQueue: false });
      if (String(threadPolicyRoot(thread) || "").toLowerCase() !== String(root || "").toLowerCase()) continue;
      const handle = ctx.activeRuns.get(thread.activeRunId)?.handle;
      if (!(handle ? handle.passiveHost : thread.isNativeHost)) counts.runningCount += row.runningCount;
      counts.queuedCount += row.queuedCount;
    }
    return counts;
  }

  function commitPlaybookFingerprint(key, next) {
    ctx.playbookFingerprints.delete(key);
    ctx.playbookFingerprints.set(key, next);
    while (ctx.playbookFingerprints.size > 256) ctx.playbookFingerprints.delete(ctx.playbookFingerprints.keys().next().value);
  }

  function playbookResponse({ base, root, key, next, playbookInject, params }) {
    if (!playbookInject) {
      commitPlaybookFingerprint(key, next);
      return { ...base, playbookInject: null };
    }
    if (params.deferPlaybookCommit !== true) {
      commitPlaybookFingerprint(key, next);
      return { ...base, playbookInject };
    }
    const playbookCommitToken = `pbt_${randomUUID()}`;
    pendingPlaybookCommits.set(playbookCommitToken, { key, root, next, expiresAt: Date.now() + 10000 });
    while (pendingPlaybookCommits.size > 256) pendingPlaybookCommits.delete(pendingPlaybookCommits.keys().next().value);
    return { ...base, playbookInject, playbookCommitToken };
  }

  function nativeChildPlaybook({ base, root, caller, params }) {
    const thread = ctx.hostSync.findThreadByHostConversationId(caller);
    const snapshot = ctx.latestSwarmSnapshots.get(root) || ctx.latestSwarmSnapshots.get(root.toLowerCase());
    let member = snapshot?.members?.find(item => String(item.conversation_id || "").toLowerCase() === caller);
    if (!member) {
      const live = readNativeSwarmSnapshot({
        conversationId: root,
        appDataDir: resolveDefaultAppDataDir(params.appDataDir || ctx.hostContext.appDataDir, ctx.hostSync.buildHostEnvForDriver()),
      });
      if (live?.found) {
        ctx.latestSwarmSnapshots.set(live.rootConversationId, live);
        member = live.members.find(item => String(item.conversation_id || "").toLowerCase() === caller);
      }
    }
    const isSwarm = Boolean(member || thread?.meta?.isSwarmMember || thread?.isSwarmMember);
    const presets = ctx.db.getProjectRoster(configWorkspace(params, root)).presets;
    const swarmName = member?.name || (isSwarm ? thread?.meta?.memberName || "" : "");
    const canonical = value => String(value || "").replace(/-/g, "_").toLowerCase();
    const matchedPresetKey = thread?.presetKey || (swarmName ? Object.keys(presets).find(key =>
      presets[key].provider === "antigravity" &&
      ([key, swarmMemberName(key)].some(v => canonical(v) === canonical(swarmName)) ||
        (swarmName.length === 24 && canonical(key.slice(0, 24)) === canonical(swarmName)))) || "" : "");
    const ticket = !isSwarm || matchedPresetKey || swarmName
      ? ctx.dispatch?.claimNativeHandoff({ rootConversationId: root, presetKey: matchedPresetKey, swarmName,
        nativeKind: isSwarm ? "swarm" : "subagent", conversationId: caller, invocation: true }) : null;
    if (!thread && !member && !ticket) return { ...base, playbookInject: null };
    const workspace = inspectHostProjectRoot(ticket?.cwd || ticket?.repoRoot).root || hostProjectRoot(root, params);
    if (!workspace) return { ...base, playbookInject: null };
    const [gitTop, gitCommon] = (readOnlyGit(workspace, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]) || "")
      .trim().split(/\r?\n/);
    const hasOwnSpec = Boolean(inspectSpecPath(path.join(workspace, ".agent-tower/spec")));
    const commonRoot = gitCommon && path.basename(gitCommon).toLowerCase() === ".git" ? inspectHostProjectRoot(path.dirname(gitCommon)).root : "";
    const parentRoot = inspectHostProjectRoot(ticket?.repoRoot).root || commonRoot;
    const checkout = hasOwnSpec ? workspace : ((gitTop && inspectHostProjectRoot(gitTop).root) || workspace);
    const repoRoot = hasOwnSpec
      ? (isIsolatedWorktreePath(checkout) && commonRoot ? commonRoot : normalizeHostWorkspace(checkout) || checkout)
      : (parentRoot || normalizeHostWorkspace(checkout) || checkout);
    const explicitRepoSpec = ctx.db.getSettings().projectProfiles?.[projectPathKey(repoRoot)]?.spec;
    const specEnabled = typeof explicitRepoSpec?.enabled === "boolean"
      ? explicitRepoSpec.enabled
      : (parentRoot && parentRoot !== repoRoot && ctx.db.getSettings().projectProfiles?.[projectPathKey(parentRoot)]?.spec?.enabled === false
        ? false
        : ctx.db.isProjectSpecEnabled(repoRoot));
    const rosterRoot = ctx.db.getProjectRoster(repoRoot).customized ? repoRoot : (parentRoot || repoRoot);
    const matchedPreset = matchedPresetKey ? ctx.db.getProjectRoster(rosterRoot).presets[matchedPresetKey] : null;
    const rawRole = ticket?.role || matchedPreset?.group || thread?.role || "executor";
    const role = rawRole === "reviewer" ? "review" : rawRole;
    const selection = specSelection(ticket || thread?.meta || {});
    const inventory = specEnabled ? readProjectSpecs(checkout, repoRoot) : undefined;
    let planDoc;
    let planWarning = "";
    try { planDoc = readPlanDocument({ cwd: checkout, repoRoot, planPath: selection.planPath }); }
    catch (error) { planWarning = `【规划读取告警】${error.code || "PLAN_READ_FAILED"}：${singleLine(error.message)}`; }
    // Legacy tickets may still include a plan block in their brief. Match on the task alone.
    const rawPrompt = ticket?.rawTask || (ticket?.brief || "").replace(/<agent_tower_plan\b[^>]*>[\s\S]*?<\/agent_tower_plan>/gi, "").trim() ||
      thread?.title || member?.name || "";
    const specs = assembleSpecPrompt({ inventory, cwd: checkout, repoRoot, role, rawPrompt,
      dynamicPrompt: [ticket?.reviewFilesBlock, planWarning].filter(Boolean).join("\n\n"), selection, planDoc,
      review: ticket?.reviewSpec, specEnabled, controlDir: ctx.dataDir,
      specLimits: specEnabled ? (ctx.specs?.projectSpecLimits?.(repoRoot) ?? ctx.db.getProjectSpec?.(repoRoot)) : undefined,
      ...(role === "curator" && specEnabled ? ctx.specs?.curatorPromptContext?.(repoRoot, root) : {}) });
    const planKey = specs.full.meta.items.find(item => item.kind === "plan")?.key;
    const budgetWarning = specs.full.meta.warnings.find(({ key }) => key === planKey);
    const playbookInject = [specs.full.prompt.trim(), budgetWarning && `【规划投递告警】${budgetWarning.code}：${singleLine(budgetWarning.message)}`]
      .filter(Boolean).join("\n\n") || null;
    const contextHash = createHash("sha256").update(JSON.stringify([ticket?.handoffId || "", playbookInject])).digest("hex");
    const key = caller.toLowerCase();
    const previous = ctx.playbookFingerprints.get(key);
    const compacted = typeof params.initialNumSteps === "number" && previous?.lastInitialNumSteps != null &&
      params.initialNumSteps < previous.lastInitialNumSteps;
    const next = { fingerprint: `native-child:${contextHash}`, modeFingerprint: "native-child", contextHash,
      lastInitialNumSteps: typeof params.initialNumSteps === "number" ? params.initialNumSteps : previous?.lastInitialNumSteps };
    return playbookResponse({ base, root, key, next,
      playbookInject: previous && !compacted && previous.contextHash === contextHash ? null : playbookInject, params });
  }

  function getConversationPolicy(params = {}) {
    const root = typeof params === "string" ? params : policyRoot(params);
    const globalSettingsStamp = params?.syncHostPlaybook === true && ctx.dataDir ? fileStamp(path.join(ctx.dataDir, "global-settings.json")) : null;
    const scopeParams = typeof params === "string" ? {} : params;
    const candidate = root && params?.syncHostPlaybook === true ? hostProjectRoot(root, scopeParams) : configWorkspace(scopeParams, root);
    const workspace = normalizeProjectPath(resolveSyncWorkspace(candidate));
    const settings = ctx.db.getSettings(workspace);
    const policy = readConversationPolicy(root, settings);
    const counts = conversationWorkCounts(root);
    let activeMode;
    const readActiveMode = () => activeMode ??= getActiveModeSummary(root, { policy, settings, counts });
    const responseBase = () => ({ ...policy, ...counts, ...hostToolGate(root, params || {}, settings, readActiveMode, workspace), activeMode: readActiveMode() });
    if (params?.syncHostPlaybook !== true) return responseBase();
    if (params.confirmPlaybookToken) {
      const token = String(params.confirmPlaybookToken);
      const pending = pendingPlaybookCommits.get(token);
      const confirmed = Boolean(pending && pending.expiresAt >= Date.now() && pending.root === root);
      if (confirmed) {
        pendingPlaybookCommits.delete(token);
        commitPlaybookFingerprint(pending.key, pending.next);
      }
      return { ...responseBase(), playbookInject: null, playbookCommitConfirmed: confirmed };
    }
    const caller = String(params.conversationId || "").trim().toLowerCase();
    if (!root || ctx.db.isManagedChildSession(params.conversationId)) return { ...responseBase(), playbookInject: null };
    if (caller && caller !== root.toLowerCase()) {
      const childPlaybook = () => nativeChildPlaybook({ base: responseBase(), root, caller, params });
      // The first child hook may beat the watcher to the parent's invoke_subagent receipt.
      if (params.deferPlaybookCommit && ctx.dispatch.findNativeHandoff({ rootConversationId: root, nativeKind: "subagent", role: "curator" })) {
        return ctx.hostSync.syncNativeHostConversation(root, { workspace, appDataDir: params.appDataDir }).then(childPlaybook);
      }
      return childPlaybook();
    }

    const specEnabled = Boolean(workspace && ctx.db.isProjectSpecEnabled(workspace));
    recordActiveHost(root, params, workspace || null);
    const key = root.toLowerCase();
    const previous = ctx.playbookFingerprints.get(key);
    const lastInitialNumSteps = typeof params.initialNumSteps === "number" ? params.initialNumSteps : previous?.lastInitialNumSteps;
    const compacted = previous?.lastInitialNumSteps != null && lastInitialNumSteps < previous.lastInitialNumSteps;
    const fastSig = JSON.stringify([policy.orchestrationMode, policy.policyRevision, MODE_PLAYBOOK_REVISION,
      settings.presetRevision || 0, specEnabled, globalSettingsStamp, workspace,
      specEnabled ? projectSpecFileStamps(workspace) : [],
      workspace ? HOST_DOC_PATHS.map(rel => fileStamp(path.join(workspace, rel))) : []]);
    if (!compacted && previous?.fastSig === fastSig) {
      previous.lastInitialNumSteps = lastInitialNumSteps;
      activeMode = structuredClone(previous.activeMode);
      activeMode.queueFrozen = !policy.dispatchEnabled && counts.queuedCount > 0;
      return { ...responseBase(), playbookInject: null };
    }
    const direct = policy.orchestrationMode === "direct";
    const renderPlaybook = () => buildModePlaybook({
      orchestrationMode: policy.orchestrationMode,
      presetRevision: settings.presetRevision || 0,
      presets: settings.presets || settings.rolePresets,
      memberPool: settings.memberPool,
      modeProfiles: settings.modeProfiles,
      relayTargetPresetKey: settings.relayTargetPresetKey,
      customPipelines: settings.customPipelines,
    });
    // Hash the rendered playbook so wording or roster model changes re-inject even without a preset revision bump.
    const candidateModeBlock = direct ? "" : renderPlaybook();
    const playbookHash = direct ? "" : createHash("sha256").update(candidateModeBlock).digest("hex").slice(0, 12);
    const modeFingerprint = direct ? "direct" : `${MODE_PLAYBOOK_REVISION}:${policy.orchestrationMode}:${settings.presetRevision || 0}:${playbookHash}`;
    const { projectContextBlock, contextHash } = readHostProjectContext(workspace, specEnabled);
    const needMode = (previous ? previous.modeFingerprint !== modeFingerprint : !direct) || (!direct && compacted);
    const needContext = Boolean(contextHash) && (!previous || previous.contextHash !== contextHash || compacted);
    const next = {
      fingerprint: `${modeFingerprint}:${contextHash}`,
      modeFingerprint,
      contextHash,
      lastInitialNumSteps,
      fastSig,
      activeMode: structuredClone(readActiveMode()),
    };
    const modeBlock = needMode ? (candidateModeBlock || renderPlaybook()) : "";
    const playbookInject = [modeBlock, needContext ? projectContextBlock : ""].filter(Boolean).join("\n\n") || null;
    return playbookResponse({ base: responseBase(), root, key, next, playbookInject, params });
  }

  function getActiveModeSummary(paramsOrRoot = {}, state) {
    const root = typeof paramsOrRoot === "string" ? paramsOrRoot : policyRoot(paramsOrRoot || {});
    const workspace = state?.settings ? "" : configWorkspace(typeof paramsOrRoot === "string" ? {} : paramsOrRoot, root);
    const settings = state?.settings ?? ctx.db.getSettings(workspace);
    const policy = state?.policy ?? readConversationPolicy(root, settings);
    const activePresets = settings.presets || settings.rolePresets || {};
    const modeProfiles = normalizeModeProfiles(settings.modeProfiles, activePresets, {
      memberPool: settings.memberPool,
      relayTargetPresetKey: settings.relayTargetPresetKey,
    });
    const counts = state?.counts ?? conversationWorkCounts(root);
    const emptyGroup = (group, stageEnabled = false) => ({
      stageEnabled,
      ...(group === "reviewer" ? { defaultKey: null, preferredKey: null } : {}),
      enabledKeys: [],
    });
    const profileGroup = (group, config, stageEnabled = true) => ({
      stageEnabled,
      ...(group === "executor" || group === "reviewer" ? { defaultKey: config?.preferredKey || null, preferredKey: config?.preferredKey || null } : {}),
      enabledKeys: stageEnabled ? [...(config?.enabledKeys || [])] : [],
    });
    let stages = { advisor: false, executor: false, reviewer: false };
    let groups = {
      advisor: emptyGroup("advisor"),
      executor: emptyGroup("executor"),
      reviewer: emptyGroup("reviewer"),
    };
    if (policy.orchestrationMode === "relay") {
      stages = { advisor: false, executor: true, reviewer: false };
      groups = {
        advisor: emptyGroup("advisor", false),
        executor: profileGroup("executor", modeProfiles.relay.executor, true),
        reviewer: emptyGroup("reviewer", false),
      };
    } else if (policy.orchestrationMode === "complex") {
      stages = {
        advisor: Boolean(modeProfiles.complex.advisor.stageEnabled),
        executor: true,
        reviewer: Boolean(modeProfiles.complex.reviewer.stageEnabled),
      };
      groups = {
        advisor: profileGroup("advisor", modeProfiles.complex.advisor, stages.advisor),
        executor: profileGroup("executor", modeProfiles.complex.executor, true),
        reviewer: profileGroup("reviewer", modeProfiles.complex.reviewer, stages.reviewer),
      };
    }
    return {
      orchestrationMode: policy.orchestrationMode,
      dispatchEnabled: policy.orchestrationMode !== "direct" && policy.dispatchEnabled,
      policyRevision: policy.policyRevision,
      rosterRevision: settings.presetRevision || 0,
      queueFrozen: !policy.dispatchEnabled && counts.queuedCount > 0,
      relayTarget: modeProfiles.relay.executor.preferredKey,
      modeProfiles,
      stages,
      groups,
    };
  }

  async function setConversationPolicy(params = {}) {
    const root = policyRoot(params);
    const currentSettings = ctx.db.getSettings();
    const previous = readConversationPolicy(root);
    const hasConversationChange = params.orchestrationMode !== undefined || typeof params.dispatchEnabled === "boolean";
    if (hasConversationChange && !root) throw new Error("需要提供 conversationId");
    const requestedMode = params.orchestrationMode !== undefined
      ? normalizeOrchestrationMode(params.orchestrationMode, "direct", currentSettings.customPipelines)
      : typeof params.dispatchEnabled === "boolean"
        ? (params.dispatchEnabled ? (previous.orchestrationMode === "direct" ? "relay" : previous.orchestrationMode) : "direct")
        : undefined;
    const requestedDispatch = requestedMode !== undefined ? requestedMode !== "direct" : undefined;
    const explicitWorkspace = hasConversationChange && normalizeHostWorkspace(params.workspace);
    const workspace = hasConversationChange ? await resolveConfigWorkspace({ ...params, workspace: explicitWorkspace || undefined }) || undefined : undefined;
    const previousDefaultMode = currentSettings.defaultOrchestrationMode;
    const previousDefaultDispatch = currentSettings.defaultDispatchEnabled;
    const hasDefaultChange = params.defaultOrchestrationMode !== undefined || typeof params.defaultDispatchEnabled === "boolean";
    if (hasDefaultChange) {
      const nextDefaultMode = params.defaultOrchestrationMode !== undefined
        ? normalizeOrchestrationMode(params.defaultOrchestrationMode, "direct", currentSettings.customPipelines)
        : (params.defaultDispatchEnabled ? "relay" : "direct");
      ctx.db.saveSettings({
        ...(params.defaultOrchestrationMode !== undefined ? { defaultOrchestrationMode: nextDefaultMode } : {}),
        ...(typeof params.defaultDispatchEnabled === "boolean" ? { defaultDispatchEnabled: nextDefaultMode !== "direct" } : {}),
      });
    }
    if (hasConversationChange) {
      const thread = ctx.db.getConversationThread(root);
      ctx.db.setConversationPolicyRecord({
        conversationId: root,
        orchestrationMode: requestedMode,
        dispatchEnabled: requestedDispatch,
        expectedPolicyRevision: params.expectedPolicyRevision,
        source: "explicit",
        workspace,
        threadId: thread?.id,
      });
      if (workspace) policyWorkspaces.set(root.toLowerCase(), workspace);
    }
    recordActiveHost(root, params);
    const nextSettings = ctx.db.getSettings();
    if (hasDefaultChange && (previousDefaultMode !== nextSettings.defaultOrchestrationMode || previousDefaultDispatch !== nextSettings.defaultDispatchEnabled)) {
      ctx.context.emitEvent({ type: "settings_updated", scope: "global", ...ctx.catalogSettings.configPayload("", nextSettings) });
    }
    let cancelledCount = 0;
    let reconciledCount = 0;
    if (requestedDispatch === false && params.cancelRunning === true) {
      // Same stop + orphan reaping path as cancelTask, but the frozen queue is preserved for when dispatch resumes.
      const inRoot = thread => thread && String(threadPolicyRoot(thread)).toLowerCase() === String(root).toLowerCase();
      const live = [...ctx.activeRuns.values()].filter(entry => !entry.handle?.passiveHost && !entry.cancelRequested &&
        inRoot(ctx.db.getThread(entry.threadId, { includeQueue: false })));
      const liveThreadIds = new Set([...live.map(entry => entry.threadId), ...ctx.pendingTurnStartLocks]);
      const starting = [...ctx.pendingTurnStartLocks].map(id => ctx.db.getThread(id, { includeQueue: false }))
        .filter(t => inRoot(t) && !t.isNativeHost && !t.meta?.isNativeHost);
      const orphans = ctx.db.listThreads({ statuses: ACTIVE_RUN_STATUSES, includeSubagents: true, limit: 500 })
        .filter(t => !liveThreadIds.has(t.id) && inRoot(t) && ctx.cancellation.computeCancelCapability(t) === "reconcilable_orphan");
      const targets = [...new Map([...live.map(entry => ctx.db.getThread(entry.threadId, { includeQueue: false })), ...starting, ...orphans]
        .filter(Boolean).map(t => [t.id, t])).values()];
      const results = await Promise.allSettled(targets.map(t => ctx.cancellation.stopThreadExecution(t, { keepQueue: true })));
      for (const r of results) {
        if (r.status !== "fulfilled" || !r.value?.cancelled) continue;
        cancelledCount++;
        if (r.value.reconciledOrphan) reconciledCount++;
      }
    }
    const current = readConversationPolicy(root);
    const switchedToEnabled = previous.orchestrationMode === "direct" && current.orchestrationMode !== "direct" && current.dispatchEnabled;
    if (switchedToEnabled) {
      for (const threadId of ctx.db.listThreadsWithQueuedRuns()) {
        const threadRoot = threadPolicyRoot(ctx.db.getThread(threadId, { includeQueue: false }));
        if (String(threadRoot || "").toLowerCase() === String(root || "").toLowerCase()) ctx.execution.drainNextQueuedRun(threadId);
      }
    }
    const conversationPolicy = getConversationPolicy({ conversationId: root });
    const activeMode = getActiveModeSummary({ conversationId: root });
    if (root) ctx.context.emitEvent({ type: "conversation_policy_updated", rootConversationId: root, workspace: params.workspace,
      conversationPolicy, activeMode, cancelledCount, reconciledCount });
    return { ok: true, conversationPolicy, activeMode, cancelledCount, reconciledCount,
      defaultOrchestrationMode: conversationPolicy.defaultOrchestrationMode,
      defaultDispatchEnabled: conversationPolicy.defaultDispatchEnabled };
  }

  return {
    assertUsableRoot,
    conversationWorkCounts,
    dispatchBypass,
    executionRoot,
    explicitExecutionRoot,
    getBoundPolicyWorkspace,
    getLastActiveHost,
    getSuggestedConversation,
    normalizeHostWorkspace,
    configWorkspace,
    resolveConfigWorkspace,
    recordActiveHost,
    getConversationPolicy,
    getActiveModeSummary,
    policyRoot,
    readConversationPolicy,
    resolveEffectiveRootConversationId,
    setConversationPolicy,
    threadPolicyRoot,
    withDispatchConversation,
  };
}

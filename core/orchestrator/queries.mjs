import { createHash } from "node:crypto";
import { summarizeThreadRunRollups } from "../db.mjs";
import { frontendAssetHash } from "../frontend-assets.mjs";
import { listExtensionTemplates } from "../catalog.mjs";
import {
  readNativeConversationTitle,
  readNativeSwarmSnapshot,
  resolveDefaultAppDataDir,
  resolveNativeConversationTitleAsync,
} from "../engines/agy-native.mjs";
import { getRepoRoot } from "../worktree.mjs";
import {
  VERSION,
  normalizeProjectPath,
  projectPathKey,
  isIsolatedWorktreePath,
  isTempTestPath,
  deriveProjectName,
  isThreadBusyStatus,
  enrichThreadForClient,
  deriveCleanMemberName,
  enrichExtensionTemplates,
} from "./helpers.mjs";

const SETTLED_BOARD_STATUSES = new Set(['completed', 'failed', 'interrupted']);
const boardRunKey = (run) => `${run.id}:${run.updatedAt}:${run.status}`;
const BOARD_SIG_FULL_TEXT_TAIL = 8;

/** Cheap board watermark: per-message shape for every post, full text for the newest tail, plus every edge counter. */
function computeBoardSig(boardMessages = [], collaborationEdges = [], rootConvId = "") {
  const hash = createHash("sha1");
  hash.update(`${String(rootConvId).toLowerCase()}|${boardMessages.length}|${collaborationEdges.length}\n`);
  const tailFrom = boardMessages.length - BOARD_SIG_FULL_TEXT_TAIL;
  boardMessages.forEach((m, i) => {
    const text = String(m.text || "");
    hash.update(`${m.seq}:${m.ts || 0}:${m.threadId || ""}:${m.runId || ""}:${m.agent || ""}:${text.length}:${m.toolCount || 0}:${m.failedToolCount || 0}:${m.hasError ? 1 : 0}\n`);
    if (i >= tailFrom) hash.update(text);
  });
  for (const e of collaborationEdges) hash.update(`${e.from}>${e.to}:${e.kind}:${e.count}:${e.direct}:${e.viaAll}\n`);
  return hash.digest("base64url").slice(0, 22);
}

export function createQueriesModule(ctx) {
  const settledRunBoardCache = new Map();
  ctx.db.summarizeThreadRunRollups ??= summarizeThreadRunRollups;

  function withThreadRunRollup(thread, rollup) {
    return {
      ...thread,
      currentRun: rollup?.currentRun || null,
      orderCount: rollup?.orderCount || 0,
      cumulativeUsage: rollup?.cumulativeUsage || thread.usage,
      usageReported: Boolean(rollup?.currentRun
        ? rollup.currentRun.usageReported
        : thread.meta?.usageReported || thread.usage?.totalTokens > 0),
    };
  }

  function getSettledBoardSummary(run) {
    return SETTLED_BOARD_STATUSES.has(run.status) ? settledRunBoardCache.get(boardRunKey(run)) : undefined;
  }

  function rememberSettledBoardSummary(run, summary) {
    if (!SETTLED_BOARD_STATUSES.has(run.status)) return;
    const key = boardRunKey(run);
    if (settledRunBoardCache.has(key)) return;
    settledRunBoardCache.set(key, summary);
    if (settledRunBoardCache.size > 2048) {
      settledRunBoardCache.delete(settledRunBoardCache.keys().next().value);
    }
  }

  function filterThreadsByConversation(threads = [], rootConvId = "") {
    const target = String(rootConvId || "").trim().toLowerCase();
    if (!target) return threads;
    return threads.filter((t) => {
      const tRoot = String(t.rootConversationId || t.meta?.rootConversationId || t.hostConversationId || "")
        .trim()
        .toLowerCase();
      return tRoot === target;
    });
  }

  function resolveHostTitle(rootConvId, appDataDir) {
    const { lsAddress, csrfToken } = ctx.hostContext;
    return resolveNativeConversationTitleAsync(rootConvId, appDataDir, { skipRootResolve: true, lsAddress, csrfToken });
  }

  async function listAvailableConversations(cleanAll = [], appDataDir = "", filterWorkspace = "") {
    const byRoot = new Map();
    function candidate(id, root, updatedAt) {
      const key = String(id || "").trim().toLowerCase();
      if (!key) return null;
      if (!byRoot.has(key)) {
        byRoot.set(key, {
          rootConversationId: id,
          conversationId: id,
          projectRoot: "",
          projectName: "",
          memberCount: 0,
          activeCount: 0,
          lastUpdatedAt: 0,
          isRecentHost: false,
          title: "",
        });
      }
      const row = byRoot.get(key);
      if (!row.projectRoot && root) {
        row.projectRoot = normalizeProjectPath(root);
        row.projectName = deriveProjectName(row.projectRoot);
      }
      row.lastUpdatedAt = Math.max(row.lastUpdatedAt, Number(updatedAt || 0));
      return row;
    }

    for (const t of cleanAll) {
      const row = candidate(t.rootConversationId, t.projectRoot, t.updatedAt || t.createdAt);
      if (!row) continue;
      row.memberCount++;
      if (isThreadBusyStatus(t.status)) row.activeCount++;
      if (t.title && (!row.title || String(t.hostConversationId || "").toLowerCase() === row.rootConversationId.toLowerCase())) {
        row.title = t.title;
      }
    }
    for (const policy of ctx.db.listConversationPolicies?.() || []) {
      candidate(policy.conversationId, policy.workspace, policy.updatedAt);
    }
    const recent = ctx.scopePolicy.getLastActiveHost();
    if (recent) {
      const projectRoot = await resolveRepoRootCached(recent.workspace);
      candidate(recent.rootConversationId, projectRoot, recent.updatedAt).isRecentHost = true;
    }

    const workspaceKey = projectPathKey(filterWorkspace);
    const candidates = [...byRoot.values()]
      .filter(c => !workspaceKey || projectPathKey(c.projectRoot) === workspaceKey)
      .sort((a, b) => b.activeCount - a.activeCount || b.lastUpdatedAt - a.lastUpdatedAt);
    return Promise.all(candidates.map(async (c, index) => {
      const title = index < 12
        ? await resolveHostTitle(c.rootConversationId, appDataDir)
        : readNativeConversationTitle(c.rootConversationId, appDataDir, { skipRootResolve: true });
      return { ...c, title: title || c.title || `会话 ${c.rootConversationId.slice(0, 8)}` };
    }));
  }

  async function resolveRepoRootCached(rawDir) {
    const k = projectPathKey(rawDir);
    if (!k) return "";
    if (ctx.repoRootCache.has(k)) return ctx.repoRootCache.get(k);
    const detected = await getRepoRoot(rawDir).catch(() => null);
    const norm = normalizeProjectPath(ctx.scopePolicy.normalizeHostWorkspace(detected) || rawDir);
    ctx.repoRootCache.set(k, norm);
    return norm;
  }

  function buildThreadParentIndex(rawThreads = []) {
    const byId = new Map();
    for (const t of rawThreads) {
      if (t?.id) byId.set(t.id, t);
    }
    return byId;
  }

  async function enrichThreadsWithProjects(rawThreads = [], fallbackWorkspace = "", contextThreads = rawThreads) {
    const rootsToResolve = new Set();
    for (const t of rawThreads) {
      const cand = t.projectRoot || t.meta?.projectRoot || t.workspace || (!isIsolatedWorktreePath(t.cwd) ? t.cwd : t.worktreePath || t.cwd);
      if (cand) {
        const k = projectPathKey(cand);
        if (k && !ctx.repoRootCache.has(k)) rootsToResolve.add(cand);
      }
    }
    if (fallbackWorkspace) {
      const fk = projectPathKey(fallbackWorkspace);
      if (fk && !ctx.repoRootCache.has(fk)) rootsToResolve.add(fallbackWorkspace);
    }
    await Promise.all(Array.from(rootsToResolve).slice(0, 24).map((d) => resolveRepoRootCached(d)));

    const allThreadsById = buildThreadParentIndex(contextThreads);
    const rollups = ctx.db.summarizeThreadRunRollups(rawThreads);
    return rawThreads.map((t) =>
      ctx.cancellation.withCancelCapability(enrichThreadForClient(withThreadRunRollup(t, rollups.get(t.id)), {
        allThreadsById,
        repoRootCache: ctx.repoRootCache,
        fallbackWorkspace,
      }))
    );
  }

  function filterTempTestThreads(threads = [], includeTemp = false) {
    if (includeTemp) return threads;
    return threads.filter((t) => {
      if (t.isNativeHost) return true;
      const root = t.projectRoot || t.workspace || t.cwd || "";
      const wt = t.worktreePath || "";
      if (isTempTestPath(root) || isTempTestPath(wt)) return false;
      return true;
    });
  }

  function buildProjectsSummary(threads = [], activeWorkspace = "") {
    const map = new Map();
    const normActive = normalizeProjectPath(activeWorkspace);
    if (normActive && !isTempTestPath(normActive)) {
      const k = projectPathKey(normActive);
      map.set(k, {
        projectRoot: normActive,
        projectName: deriveProjectName(normActive),
        threadCount: 0,
        activeCount: 0,
        lastUpdatedAt: 0,
        isCurrentHostWorkspace: true,
      });
    }

    for (const t of threads) {
      const root = normalizeProjectPath(t.projectRoot || t.workspace || t.cwd || "");
      if (!root) continue;
      const k = projectPathKey(root);
      const prev = map.get(k) || {
        projectRoot: root,
        projectName: t.projectName || deriveProjectName(root),
        threadCount: 0,
        activeCount: 0,
        lastUpdatedAt: 0,
        isCurrentHostWorkspace: Boolean(normActive && projectPathKey(normActive) === k),
      };
      prev.threadCount += 1;
      if (isThreadBusyStatus(t.status)) prev.activeCount += 1;
      prev.lastUpdatedAt = Math.max(prev.lastUpdatedAt, Number(t.updatedAt || t.createdAt || 0));
      map.set(k, prev);
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.isCurrentHostWorkspace !== b.isCurrentHostWorkspace) {
        return a.isCurrentHostWorkspace ? -1 : 1;
      }
      if (b.activeCount !== a.activeCount) return b.activeCount - a.activeCount;
      return b.lastUpdatedAt - a.lastUpdatedAt;
    });
  }

  function filterThreadsByWorkspace(threads = [], workspace = "") {
    const wsKey = projectPathKey(workspace);
    if (!wsKey) return threads;
    return threads.filter((t) => {
      const tKey = projectPathKey(t.projectRoot || t.workspace || t.cwd || "");
      return tKey === wsKey || tKey.startsWith(`${wsKey}/`);
    });
  }

  function buildStatsFromThreads(threads = [], pendingRequests = []) {
    let running = 0;
    let waiting = 0;
    let completed = 0;
    let failed = 0;
    let inputTokens = 0;
    let cachedTokens = 0;
    let reasoningTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    for (const t of threads) {
      const s = String(t.status || "").toLowerCase();
      if (s === "running" || s === "starting" || s === "preparing") running++;
      else if (s === "waiting_approval" || s === "waiting_input") waiting++;
      else if (s === "completed" || s === "waiting") completed++;
      else if (s === "failed") failed++;

      const usage = t.cumulativeUsage || t.usage;
      inputTokens += usage?.inputTokens || 0;
      cachedTokens += usage?.cachedTokens || 0;
      reasoningTokens += usage?.reasoningTokens || 0;
      outputTokens += usage?.outputTokens || 0;
      totalTokens += usage?.totalTokens || 0;
    }

    return {
      totalThreads: threads.length,
      running,
      pending: Math.max(waiting, pendingRequests.length),
      waiting,
      completed,
      failed,
      inputTokens,
      cachedTokens,
      reasoningTokens,
      outputTokens,
      totalTokens,
    };
  }

  function buildSwarmBoardAndEdges(scopedThreads = [], { appDataDir = "", conversationId = "" } = {}) {
    const threadById = new Map(scopedThreads.map((t) => [t.id, t]));
    const threadByConvId = new Map();
    const threadByMemberName = new Map();

    for (const t of scopedThreads) {
      if (t.hostConversationId) threadByConvId.set(t.hostConversationId.toLowerCase(), t);
      if (t.nativeSessionId) threadByConvId.set(String(t.nativeSessionId).toLowerCase(), t);
      const mName = t.memberName || t.meta?.memberName || deriveCleanMemberName(t);
      if (mName && !threadByMemberName.has(mName)) {
        threadByMemberName.set(mName, t);
      }
    }

    // Collect native swarm snapshots matching any scoped native thread (or current conversationId)
    const swarmSnaps = [];
    const seenSwarmConvs = new Set();
    const candidateConvIds = new Set();
    if (conversationId) candidateConvIds.add(conversationId);
    for (const t of scopedThreads) {
      if (t.hostConversationId) candidateConvIds.add(t.hostConversationId);
    }
    for (const cid of candidateConvIds) {
      const key = cid.toLowerCase();
      if (seenSwarmConvs.has(key)) continue;
      seenSwarmConvs.add(key);
      const s = readNativeSwarmSnapshot({ conversationId: cid, appDataDir: appDataDir || ctx.hostContext.appDataDir });
      if (s?.found) {
        seenSwarmConvs.add(s.rootConversationId.toLowerCase());
        for (const member of s.members) {
          if (member.conversation_id) seenSwarmConvs.add(member.conversation_id.toLowerCase());
        }
        swarmSnaps.push(s);
      }
    }

    const boardMessages = [];
    const edgeMap = new Map();
    let maxSeq = 0;

    function addOrIncrementEdge(from, to, kind = "mention", countDelta = 1, directDelta = 0, viaAllDelta = 0) {
      if (!from || !to || from === to) return;
      const key = `${from}\0${to}\0${kind}`;
      const cur = edgeMap.get(key) || {
        from,
        to,
        kind,
        count: 0,
        direct: 0,
        viaAll: 0,
      };
      cur.count += countDelta;
      cur.direct += directDelta;
      cur.viaAll += viaAllDelta;
      edgeMap.set(key, cur);
    }

    // 1. Ingest native Swarm board messages & directed edges
    for (const swarm of swarmSnaps) {
      for (const msg of swarm.messages || []) {
        const seq = Number(msg.seq) || maxSeq + 1;
        if (seq > maxSeq) maxSeq = seq;
        const t =
          (msg.conversationId && threadByConvId.get(msg.conversationId.toLowerCase())) ||
          threadByMemberName.get(msg.agent) ||
          null;
        boardMessages.push({
          seq,
          agent: msg.agent,
          mentions: Array.isArray(msg.mentions) ? msg.mentions : [],
          all: Boolean(msg.all),
          text: msg.text || "",
          time: msg.time || "",
          ts: msg.ts || Date.now(),
          threadId: t?.id || null,
          provider: "antigravity",
          model: msg.model || t?.model || "",
          modelDisplayName: msg.modelDisplayName || msg.model || t?.model || "",
          reasoningSummary: "",
          toolCount: 0,
          hasError: false,
          source: "native-swarm",
          rootConversationId: conversationId || undefined,
        });
      }
      for (const e of swarm.edges || []) {
        addOrIncrementEdge(e.from, e.to, e.kind || "mention", e.count || 1, e.direct || 0, e.viaAll || 0);
      }
    }

    // 2. Append non-native / external orchestrated thread activity & parent-child delegation edges
    const externalRuns = [];
    for (const t of scopedThreads) {
      const mName = t.memberName || deriveCleanMemberName(t);
      if (t.parentThreadId && threadById.has(t.parentThreadId)) {
        const parentT = threadById.get(t.parentThreadId);
        const parentName = parentT.memberName || deriveCleanMemberName(parentT);
        if (!t.isSwarmMember && parentName !== mName) {
          addOrIncrementEdge(parentName, mName, "delegate", 1, 1, 0);
        }
      }

      if (t.isNativeHost) continue;

      const memberRuns = ctx.db.summarizeBoardRuns(t.id, 30, getSettledBoardSummary);
      for (const { run: r, summary } of memberRuns) {
        rememberSettledBoardSummary(r, summary);
        const { reasoningCount, reasoningMs, toolCount, failedToolCount } = summary;
        const runFailed = Boolean(r.error) || r.status === "failed";
        const reasoningSummary = reasoningCount > 0
          ? `思考 ${reasoningMs > 0 ? `${(reasoningMs / 1000).toFixed(1)}s` : `${reasoningCount} 段`}`
          : "";

        if (r.prompt) {
          const parentT = t.parentThreadId ? threadById.get(t.parentThreadId) : null;
          const sender = parentT ? parentT.memberName || deriveCleanMemberName(parentT) : "user";
          externalRuns.push({
            ts: r.createdAt || t.createdAt || Date.now(),
            agent: sender,
            mentions: [mName],
            all: false,
            text: r.prompt,
            threadId: t.id,
            runId: r.id,
            provider: t.provider,
            model: t.model,
            modelDisplayName: t.model,
            meta: r.meta?.injectedSpecs ? { injectedSpecs: r.meta.injectedSpecs } : undefined,
            reasoningSummary: "",
            toolCount: 0,
            hasError: false,
            source: "orchestrator-dispatch",
          });
        }

        const assistantText = summary.assistantText || (memberRuns.length === 1 && r.status !== "running" && !r.error ? t.summary : "") || "";
        if (assistantText || r.status === "running" || r.error) {
          const parentT = t.parentThreadId ? threadById.get(t.parentThreadId) : null;
          const replyMentions = parentT ? [parentT.memberName || deriveCleanMemberName(parentT)] : [];
          if (parentT) {
            const parentName = parentT.memberName || deriveCleanMemberName(parentT);
            addOrIncrementEdge(mName, parentName, "report", 1, 1, 0);
          }
          externalRuns.push({
            ts: r.completedAt || r.updatedAt || r.startedAt || Date.now(),
            agent: mName,
            mentions: replyMentions,
            all: false,
            text: assistantText || (r.error ? `Error: ${r.error}` : "正在执行任务…"),
            threadId: t.id,
            runId: r.id,
            provider: t.provider,
            model: t.model,
            modelDisplayName: t.model,
            reasoningSummary,
            toolCount,
            failedToolCount,
            hasError: runFailed,
            errorText: runFailed ? String(r.error || "运行未正常结束") : "",
            source: "orchestrator-result",
          });
        }
      }
    }

    externalRuns.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    for (const ext of externalRuns) {
      maxSeq += 1;
      const d = new Date(ext.ts || Date.now());
      const hh = String(d.getHours()).padStart(2, "0");
      const mm = String(d.getMinutes()).padStart(2, "0");
      boardMessages.push({
        seq: maxSeq,
        time: `${hh}:${mm}`,
        ...ext,
        rootConversationId: conversationId || undefined,
      });
    }

    boardMessages.sort((a, b) => (a.seq || 0) - (b.seq || 0));
    return {
      boardMessages,
      collaborationEdges: Array.from(edgeMap.values()),
    };
  }

  /** Idle clones archived with `keepBoardHistory` stay off the roster but keep their posts on the conversation board. */
  function withArchivedBoardHistory(liveThreads = [], rootConvId = "") {
    if (!rootConvId) return liveThreads;
    const liveIds = new Set(liveThreads.map((t) => t.id));
    const archived = ctx.db.listThreads({ rootConversationId: rootConvId, includeSubagents: true, includeArchived: true, includeQueue: false, limit: 500 })
      .filter((t) => t.archived && t.meta?.keepBoardHistory === true && !liveIds.has(t.id));
    if (!archived.length) return liveThreads;
    const allThreadsById = buildThreadParentIndex([...liveThreads, ...archived]);
    const enriched = archived.map((t) => enrichThreadForClient(t, { allThreadsById, repoRootCache: ctx.repoRootCache }));
    return [...liveThreads, ...filterTempTestThreads(enriched, false)];
  }

  function computeWorkState(thread) {
    if (!thread) return "result_available";
    if (ctx.activeRunByThread.has(thread.id) || isThreadBusyStatus(thread.status)) {
      return "working";
    }
    const children = ctx.db.listThreads({
      parentThreadId: thread.id,
      includeSubagents: true,
      limit: 200,
    });
    const anyChildBusy = children.some(
      (child) => ctx.activeRunByThread.has(child.id) || isThreadBusyStatus(child.status)
    );
    if (anyChildBusy) return "waiting_for_children";
    return "result_available";
  }

  async function getBootstrap({
    workspace,
    conversationId,
    appDataDir,
    agentApiExe,
    projectId,
    includeTemp = false,
  } = {}) {
    ctx.context.updateHostContext({ appDataDir, agentApiExe, projectId });
    const catalog = await ctx.catalogSettings.ensureCatalog();
    await ctx.catalogSettings.ensureInitialRoster({ catalog });

    const rawConvId = String(conversationId || "").trim();
    const resolvedAppData = resolveDefaultAppDataDir(
      appDataDir || ctx.hostContext.appDataDir,
      ctx.hostSync.buildHostEnvForDriver()
    );
    const rootConvId = ctx.scopePolicy.policyRoot({ conversationId: rawConvId, appDataDir: resolvedAppData });
    const normActiveWorkspace = workspace
      ? ctx.scopePolicy.normalizeHostWorkspace(await resolveRepoRootCached(workspace)) || normalizeProjectPath(workspace)
      : "";
    const recentHost = ctx.scopePolicy.getLastActiveHost();
    const boundWorkspace = rootConvId
      ? ctx.scopePolicy.normalizeHostWorkspace(ctx.scopePolicy.getBoundPolicyWorkspace(rootConvId)) ||
        (recentHost?.rootConversationId.toLowerCase() === rootConvId.toLowerCase() ? await resolveRepoRootCached(recentHost.workspace) : "")
      : "";

    const hostTitle = rootConvId ? await resolveHostTitle(rootConvId, resolvedAppData) : "";
    if (rawConvId) {
      await ctx.updates.optionalWrite(() => ctx.hostSync.syncNativeHostConversation(rawConvId, {
        appDataDir: resolvedAppData,
        workspace: normActiveWorkspace || boundWorkspace,
      }).catch(() => null));
    }

    const snapshotSeq = ctx.db.getLatestSeq();
    const globalThreads = ctx.db.listThreads({ includeSubagents: true, includeQueue: false, limit: 500 });
    const scopedRaw = rootConvId
      ? ctx.db.listThreads({ rootConversationId: rootConvId, includeSubagents: true, includeQueue: false, limit: 500 })
      : [];
    const seenRawIds = new Set(globalThreads.map((t) => t.id));
    const rawThreads = [...globalThreads, ...scopedRaw.filter((t) => !seenRawIds.has(t.id))];
    const enrichedAll = await enrichThreadsWithProjects(rawThreads);
    const cleanAll = filterTempTestThreads(enrichedAll, Boolean(includeTemp));
    const availableConversations = await listAvailableConversations(cleanAll, resolvedAppData, normActiveWorkspace);
    const suggestedConversationId = ctx.scopePolicy.getSuggestedConversation({
      workspace: normActiveWorkspace, availableConversations,
    });

    const threads = rootConvId ? filterThreadsByConversation(cleanAll, rootConvId).map((t) => ({
      ...t,
      queue: ctx.db.listQueuedRuns(t.id).map((r) => ({
        id: r.id,
        queuedRunId: r.id,
        runId: r.id,
        text: r.prompt,
        message: r.prompt,
        queuePosition: r.queuePosition,
        createdAt: r.createdAt,
      })),
    })) : [];
    const rootThread = threads.find(t => String(t.hostConversationId || "").toLowerCase() === rootConvId.toLowerCase());
    let effectiveWorkspace = normActiveWorkspace || boundWorkspace;
    const hasSpecificBinding = boundWorkspace && projectPathKey(boundWorkspace) !== projectPathKey(ctx.db.defaultStudioRoot);
    if (rootConvId && !normActiveWorkspace && !hasSpecificBinding) {
      // A policy stored in the default DB can predate a thread's actual project binding.
      for (const thread of [rootThread, ...threads]) {
        const threadWorkspace = ctx.scopePolicy.normalizeHostWorkspace(thread?.projectRoot);
        if (!threadWorkspace) continue;
        effectiveWorkspace = threadWorkspace;
        break;
      }
    }
    const conversationTitle = rootConvId
      ? hostTitle || rootThread?.title || "AgentTower"
      : normActiveWorkspace ? deriveProjectName(normActiveWorkspace) : "AgentTower (独立视图)";

    const visibleThreadIds = new Set(threads.map(t => t.id));
    const visibleWorktreePaths = new Set(threads.map(t => projectPathKey(t.worktreePath)).filter(Boolean));
    const visibleWorktreeIds = new Set(threads.map(t => t.worktreeId).filter(Boolean));
    const pendingRequests = rootConvId
      ? ctx.db.listPendingRequests({}).filter(r => visibleThreadIds.has(r.threadId)) : [];
    let worktrees = [];
    if (rootConvId && (visibleWorktreePaths.size || visibleWorktreeIds.size || threads.some((t) => t.isolation === "worktree"))) {
      const wtRes = await ctx.worktrees.listWorktrees({
        conversationId: rootConvId,
        appDataDir: resolvedAppData || undefined,
        workspace: effectiveWorkspace || undefined,
        includeTemp,
      }).catch(() => ({ worktrees: [] }));
      worktrees = (wtRes.worktrees || []).filter(wt =>
        visibleThreadIds.has(wt.threadId) || visibleWorktreeIds.has(wt.id) ||
        visibleWorktreePaths.has(projectPathKey(wt.worktreePath))
      );
    }

    const stats = buildStatsFromThreads(threads, pendingRequests);
    const latestSeq = snapshotSeq;

    const activeRunsList = Array.from(ctx.activeRuns.values())
      .filter((r) => visibleThreadIds.has(r.threadId))
      .map((r) => ({
        runId: r.runId,
        threadId: r.threadId,
        startedAt: r.startedAt,
      }));

    const extensionTemplates = enrichExtensionTemplates(
      catalog.extensionTemplates ||
        listExtensionTemplates({ customProviders: ctx.db.getSettings().customProviders })
    );

    const { boardMessages, collaborationEdges } = rootConvId
      ? buildSwarmBoardAndEdges(withArchivedBoardHistory(threads, rootConvId), { appDataDir: resolvedAppData, conversationId: rootConvId })
      : { boardMessages: [], collaborationEdges: [] };
    const boardSig = computeBoardSig(boardMessages, collaborationEdges, rootConvId);

    effectiveWorkspace = ctx.scopePolicy.normalizeHostWorkspace(effectiveWorkspace);
    const config = ctx.catalogSettings.configPayload(effectiveWorkspace);
    return {
      version: VERSION,
      systemUpdate: ctx.updates.status(),
      ...config,
      ...ctx.specs.projectSpecsSummary({ workspace: effectiveWorkspace }),
      specCuration: ctx.specs.curationStatus(effectiveWorkspace),
      conversationPolicy: ctx.scopePolicy.getConversationPolicy({ conversationId: rootConvId, workspace: effectiveWorkspace }),
      activeMode: ctx.scopePolicy.getActiveModeSummary({ conversationId: rootConvId, workspace: effectiveWorkspace }),
      healthIncidents: rootConvId ? (await ctx.health.listHealthIncidents({ conversationId: rootConvId, workspace: effectiveWorkspace })).incidents : [],
      frontendAssetHash: frontendAssetHash(),
      studioUrl: ctx.flags.currentStudioUrl,
      conversationId: rawConvId || null,
      rootConversationId: rootConvId || null,
      conversationTitle,
      projectName: effectiveWorkspace ? deriveProjectName(effectiveWorkspace) : null,
      availableConversations,
      suggestedConversationId,
      bindingRequired: !rootConvId,
      workspace: effectiveWorkspace || null,
      providers: catalog.providers,
      extensionTemplates,
      customProviders: config.settings.customProviders,
      threads,
      boardMessages,
      collaborationEdges,
      boardSig,
      activeRuns: activeRunsList,
      worktrees,
      pendingRequests,
      stats,
      latestSeq,
    };
  }

  async function listThreads(params = {}) {
    const limit = Math.max(1, Math.min(500, Number(params.limit) || 100));
    const offset = Math.max(0, Number(params.cursor || params.offset) || 0);
    const statuses = params.statuses || (params.status ? [params.status] : undefined);
    const includeTemp = Boolean(params.includeTemp);
    const rawWorkspace = params.workspace ? await resolveRepoRootCached(params.workspace) : "";
    const rootConversationId = params.conversationId
      ? ctx.scopePolicy.resolveEffectiveRootConversationId({
          conversationId: params.conversationId,
          appDataDir: params.appDataDir,
          allowInfer: false,
        })
      : "";

    // Load full pool first so parentThreadId -> projectRoot inheritance & temp filtering work accurately
    let rawThreads;
    if (params.query && String(params.query).trim()) {
      rawThreads = ctx.db.searchThreads(String(params.query).trim(), {
        limit: 500,
      });
    } else {
      rawThreads = ctx.db.listThreads({
        rootConversationId: !params.parentThreadId ? rootConversationId || undefined : undefined,
        statuses,
        parentThreadId: params.parentThreadId,
        includeSubagents: params.includeSubagents !== false,
        includeArchived: Boolean(params.includeArchived),
        includeQueue: false,
        limit: 500,
        offset: 0,
      });
    }

    // If querying children of a specific parentThreadId, still load all threads to resolve parent projectRoot chain
    const contextThreads = params.parentThreadId
      ? ctx.db.listThreads({ includeSubagents: true, includeQueue: false, limit: 500 })
      : rawThreads;
    const enriched = await enrichThreadsWithProjects(rawThreads, rawWorkspace, contextThreads);

    let filtered = filterTempTestThreads(enriched, includeTemp);
    if (rootConversationId) {
      filtered = filterThreadsByConversation(filtered, rootConversationId);
    } else if (rawWorkspace) {
      filtered = filterThreadsByWorkspace(filtered, rawWorkspace);
    }

    const total = filtered.length;
    const paged = filtered.slice(offset, offset + limit).map((t) => ({
      ...t,
      queue: t.queue ?? ctx.db.listQueuedRuns(t.id).map((r) => ({
        id: r.id,
        queuedRunId: r.id,
        runId: r.id,
        text: r.prompt,
        message: r.prompt,
        queuePosition: r.queuePosition,
        createdAt: r.createdAt,
      })),
    }));

    return {
      threads: paged,
      total,
      projects: buildProjectsSummary(
        rootConversationId ? filtered : filterTempTestThreads(enriched, includeTemp),
        rootConversationId ? "" : rawWorkspace
      ),
      nextCursor: offset + paged.length < total ? offset + paged.length : null,
    };
  }

  async function readThread(params = {}) {
    const key = params.threadId || params.taskId || params.id;
    if (!key) throw new Error("readThread 需要提供 threadId");

    const rawThread = ctx.db.getThread(key, { includeQueue: true, includeItems: false });
    if (!rawThread) throw new Error(`找不到会话: ${key}`);
    const rollup = ctx.db.summarizeThreadRunRollups([rawThread]).get(rawThread.id);
    const thread = ctx.cancellation.withCancelCapability(enrichThreadForClient(withThreadRunRollup(rawThread, rollup)));
    const roster = ctx.db.getProjectRoster(thread.meta?.projectRoot || thread.workspace || thread.cwd);

    // Single item full-text / offset pagination (mirrors AgentTower `thread_read` `itemId` + `textOffset`)
    if (params.itemId) {
      // Primary-key lookup first: a long thread's final report sits far beyond any list window.
      const direct = ctx.db.getTurnItem?.(params.itemId, thread.id);
      const found = direct?.threadId === thread.id ? direct : ctx.db.listTurnItems({
        threadId: thread.id,
        view: "activity",
        limit: 2000,
      }).find((i) => i.id === params.itemId || i.toolCallId === params.itemId);
      if (!found) throw new Error(`找不到指定的 TurnItem: ${params.itemId}`);
      const fullText = found.text || (typeof found.rawOutput === "string" ? found.rawOutput : JSON.stringify(found.rawOutput || ""));
      const start = Math.max(0, Number(params.textOffset) || 0);
      const maxChars = Number(params.maxCharsPerItem) > 0 ? Number(params.maxCharsPerItem) : 32000;
      const slice = fullText.slice(start, start + maxChars);
      return {
        thread,
        activeMode: ctx.scopePolicy.getActiveModeSummary({ threadId: thread.id }),
        memberPool: roster.memberPool,
        modeProfiles: roster.modeProfiles,
        presetRevision: roster.rosterRevision,
        item: {
          ...found,
          text: slice,
          totalLength: fullText.length,
          nextTextOffset: start + maxChars < fullText.length ? start + maxChars : null,
        },
      };
    }

    const afterOrdinal = Number(params.afterPosition ?? params.afterOrdinal) || 0;
    const items = ctx.db.listTurnItems({
      threadId: thread.id,
      runId: params.runId ? String(params.runId) : undefined,
      view: params.view || "activity",
      afterOrdinal,
      limit: Number(params.limit) || 400,
      maxCharsPerItem: Number(params.maxCharsPerItem) || 0,
      // Opt-in newest-window read (MCP thread_read); forward cursors keep the oldest-first page semantics.
      tail: params.tail === true && !afterOrdinal,
    });
    const pendingRequests = ctx.db.listPendingRequests({ threadId: thread.id });
    const recentRuns = ctx.db.listRuns({ threadId: thread.id, limit: 50, tail: true });

    return {
      thread,
      activeMode: ctx.scopePolicy.getActiveModeSummary({ threadId: thread.id }),
      memberPool: roster.memberPool,
      modeProfiles: roster.modeProfiles,
      presetRevision: roster.rosterRevision,
      items,
      queue: thread.queue || [],
      pendingRequests,
      recentRuns,
      workState: computeWorkState(thread),
    };
  }

  async function getEvents({
    sinceSeq = 0,
    limit = 300,
    workspace,
    threadId,
    conversationId,
    appDataDir,
    boardSig: clientBoardSig = "",
  } = {}) {
    const rawConvId = String(conversationId || "").trim();
    const resolvedAppData = resolveDefaultAppDataDir(
      appDataDir || ctx.hostContext.appDataDir,
      ctx.hostSync.buildHostEnvForDriver()
    );
    const rootConvId = ctx.scopePolicy.policyRoot({ conversationId: rawConvId, appDataDir: resolvedAppData });

    const hostTitle = rootConvId ? await resolveHostTitle(rootConvId, resolvedAppData) : "";
    if (rawConvId) {
      await ctx.updates.optionalWrite(() => ctx.hostSync.syncNativeHostConversation(rawConvId, {
        appDataDir: resolvedAppData,
        workspace: workspace || "",
      }).catch(() => null));
    }

    const normWs = await ctx.scopePolicy.resolveConfigWorkspace({ workspace, conversationId: rootConvId, threadId });
    const { memberPool, modeProfiles, presetRevision, projectConfig, settings } = ctx.catalogSettings.configPayload(normWs);
    const rawThreads = ctx.db.listThreads({
      rootConversationId: rootConvId || undefined,
      includeSubagents: true,
      includeQueue: false,
      limit: 500,
    });
    const enrichedAll = await enrichThreadsWithProjects(rawThreads, normWs);
    const cleanAll = filterTempTestThreads(enrichedAll, false);

    let cleanThreads;
    if (rootConvId) {
      cleanThreads = filterThreadsByConversation(cleanAll, rootConvId);
    } else {
      cleanThreads = normWs ? filterThreadsByWorkspace(cleanAll, normWs) : cleanAll;
    }

    const scopedThreadIds = new Set(cleanThreads.map((t) => t.id));
    const { boardMessages, collaborationEdges } = buildSwarmBoardAndEdges(withArchivedBoardHistory(cleanThreads, rootConvId), {
      appDataDir: resolvedAppData,
      conversationId: rootConvId || "",
    });
    const boardSig = computeBoardSig(boardMessages, collaborationEdges, rootConvId);
    // Pollers echo the last watermark; an unchanged board skips re-serializing / re-sending the large arrays.
    const boardUnchanged = Boolean(String(clientBoardSig || "").trim()) && String(clientBoardSig).trim() === boardSig;
    const conversationTitle = rootConvId
      ? hostTitle ||
        cleanThreads.find(
          (t) => String(t.hostConversationId || "").toLowerCase() === rootConvId.toLowerCase()
        )?.title ||
        ""
      : "";

    const pageLimit = Math.max(1, Math.min(2000, Number(limit) || 300));
    const latestSeq = ctx.db.getLatestSeq();
    const rawEvents = ctx.db.listEvents({
      sinceSeq,
      limit: pageLimit,
      workspace: rootConvId ? undefined : normWs || workspace,
      threadId,
      rootConversationId: rootConvId || undefined,
    });
    const filterWsKey = projectPathKey(normWs || workspace);

    const events = rawEvents.filter(ev => {
      if (ev.type === "project_config_updated") return Boolean(filterWsKey && projectPathKey(ev.workspace) === filterWsKey);
      if (ev.type === "spec_curation_updated" && filterWsKey && ev.workspace && projectPathKey(ev.workspace) !== filterWsKey) return false;
      return !rootConvId || ctx.context.matchesEventConversation(ev, rootConvId);
    });
    const nextSeq = rawEvents.length >= pageLimit
      ? rawEvents[rawEvents.length - 1].seq
      : Math.max(Number(sinceSeq) || 0, latestSeq, rawEvents.length > 0 ? rawEvents[rawEvents.length - 1].seq : 0);
    const pendingReqs = ctx.db
      .listPendingRequests({})
      .filter((r) => (r.threadId ? scopedThreadIds.has(r.threadId) : !rootConvId));
    const stats = buildStatsFromThreads(cleanThreads, pendingReqs);

    return {
      frontendAssetHash: frontendAssetHash(),
      systemUpdate: ctx.updates.status(),
      conversationPolicy: ctx.scopePolicy.getConversationPolicy({ conversationId: rootConvId, threadId, workspace: normWs }),
      activeMode: ctx.scopePolicy.getActiveModeSummary({ conversationId: rootConvId, threadId, workspace: normWs }),
      memberPool,
      modeProfiles,
      presetRevision,
      projectConfig,
      settings: { defaultExternalSessionVisible: settings.defaultExternalSessionVisible, autoCheckUpdates: settings.autoCheckUpdates },
      healthIncidents: (await ctx.health.listHealthIncidents({ conversationId: rootConvId, workspace, threadId })).incidents,
      events,
      latestSeq,
      nextSeq,
      rootConversationId: rootConvId || null,
      conversationTitle: conversationTitle || null,
      projectName: normWs ? deriveProjectName(normWs) : null,
      // Scoped to the requested conversation / workspace so another project's work cannot keep this view "busy".
      hasActiveRuns: rootConvId || normWs
        ? [...ctx.activeRuns.values()].some(entry => scopedThreadIds.has(entry.threadId)) ||
          [...ctx.pendingTurnStartLocks].some(id => scopedThreadIds.has(id))
        : ctx.activeRuns.size > 0 || ctx.pendingTurnStartLocks.size > 0,
      ...(boardUnchanged ? { boardUnchanged: true } : { boardMessages, collaborationEdges }),
      boardSig,
      threadDigest: cleanThreads.filter((t) => !t.archived).map((t) => ({
        id: t.id,
        status: t.status,
        title: t.title || "",
        usage: t.usage,
        usageReported: Boolean(t.usageReported),
        cumulativeUsage: t.cumulativeUsage || t.usage,
        currentRun: t.currentRun || null,
        orderCount: t.orderCount || 0,
        startedAt: t.startedAt || 0,
        completedAt: t.completedAt || null,
        durationMs: t.durationMs || 0,
        updatedAt: t.updatedAt || 0,
      })),
      stats,
    };
  }

  return {
    computeWorkState,
    enrichThreadsWithProjects,
    filterThreadsByConversation,
    getBootstrap,
    getEvents,
    listThreads,
    readThread,
    resolveRepoRootCached,
  };
}

import * as fsp from "node:fs/promises";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { child, inside } from "../storage-paths.mjs";
import { resolveDefaultAppDataDir, resolveTranscriptPath } from "../engines/agy-native.mjs";
import {
  cleanupWorktree as gitCleanupWorktree,
  getRepoRoot,
  getWorktreeDiff as gitGetWorktreeDiff,
  inspectWorktreeSafety,
  integrateWorktree as gitIntegrateWorktree,
  listWorktrees as gitListWorktrees,
  pruneStaleWorktrees,
  runGit,
} from "../worktree.mjs";
import {
  normalizeProjectPath,
  projectPathKey,
  isTempTestPath,
  deriveProjectName,
  isThreadBusyStatus,
} from "./helpers.mjs";

export function createWorktreesModule(ctx) {
  async function resolveWorktreeTargetPath(params = {}) {
    const { worktreeId, threadId, worktreePath, path: altPath, cwd, workspace } = params;
    // Explicit / recorded directories are fail-closed: never diff or review a different project by fallback.
    if (worktreePath || altPath) return ctx.scopePolicy.assertUsableRoot(worktreePath || altPath, "worktreePath");
    if (!worktreeId && (cwd || workspace)) return ctx.scopePolicy.executionRoot(params);
    if (threadId) {
      const t = ctx.db.getThread(threadId, { includeQueue: false });
      if (t?.worktreePath) return ctx.scopePolicy.assertUsableRoot(t.worktreePath, "工作树目录");
      if (t?.cwd) return ctx.scopePolicy.assertUsableRoot(t.cwd, "线程工作目录");
    }
    if (worktreeId) {
      const wts = await gitListWorktrees({ workspace: workspace || cwd || ctx.db.defaultStudioRoot, includeMain: true });
      const match = wts.find((w) => w.id === worktreeId || w.worktreeId === worktreeId);
      if (match) return match.worktreePath;
      // Also check threads table in case worktree was recorded by id
      const threads = ctx.db.listThreads({ includeSubagents: true, limit: 300 });
      const tMatch = threads.find((t) => t.worktreeId === worktreeId && t.worktreePath);
      if (tMatch) return ctx.scopePolicy.assertUsableRoot(tMatch.worktreePath, "工作树目录");
    }
    return ctx.scopePolicy.executionRoot(params);
  }

  async function listWorktrees(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    const rawConvId = String(params.conversationId || "").trim();
    const rootConvId = rawConvId
      ? ctx.scopePolicy.resolveEffectiveRootConversationId({
          conversationId: rawConvId,
          appDataDir: params.appDataDir || "",
          allowInfer: false,
        })
      : "";

    // Enrich worktrees with bound thread metadata & projectRoot if any
    const rawThreads = ctx.db.listThreads({ includeSubagents: true, limit: 500 });
    const enrichedThreads = await ctx.queries.enrichThreadsWithProjects(rawThreads, params.workspace || params.cwd || "");
    const scopedThreads = rootConvId ? ctx.queries.filterThreadsByConversation(enrichedThreads, rootConvId) : enrichedThreads;

    let rawList = [];
    if (rootConvId) {
      const repoRootsMap = new Map();
      const addCandidateRoot = (p) => {
        const norm = normalizeProjectPath(p || "");
        if (!norm) return;
        const key = projectPathKey(norm);
        if (key && !repoRootsMap.has(key)) repoRootsMap.set(key, norm);
      };
      for (const t of scopedThreads) {
        addCandidateRoot(t.projectRoot || t.workspace || t.cwd || t.worktreePath);
      }
      if (params.workspace) addCandidateRoot(params.workspace);
      if (params.cwd) addCandidateRoot(params.cwd);
      if (repoRootsMap.size === 0) {
        return { worktrees: [] };
      }

      const seenWtKeys = new Set();
      for (const rootPath of repoRootsMap.values()) {
        const part = await gitListWorktrees({
          cwd: rootPath,
          workspace: rootPath,
          includeMain: Boolean(params.includeMain),
        }).catch(() => []);
        for (const wt of part) {
          const wtKey = projectPathKey(wt.worktreePath || "") || String(wt.id || "");
          if (wtKey && seenWtKeys.has(wtKey)) continue;
          if (wtKey) seenWtKeys.add(wtKey);
          rawList.push(wt);
        }
      }
    } else {
      rawList = await gitListWorktrees({
        cwd: params.cwd,
        workspace: params.workspace,
        includeMain: Boolean(params.includeMain),
      });
    }

    const wsKey = params.workspace ? projectPathKey(await ctx.queries.resolveRepoRootCached(params.workspace)) : "";
    const scopedThreadIds = new Set(scopedThreads.map((t) => t.id));
    const scopedWorktreeIds = new Set(scopedThreads.map((t) => t.worktreeId).filter(Boolean));
    const scopedWorktreePaths = new Set(
      scopedThreads.map((t) => (t.worktreePath ? projectPathKey(t.worktreePath) : "")).filter(Boolean)
    );

    const worktrees = rawList
      .map((wt) => {
        const boundThread = scopedThreads.find(
          (t) =>
            t.worktreeId === wt.id ||
            (t.worktreePath && projectPathKey(t.worktreePath) === projectPathKey(wt.worktreePath))
        );
        const normRepoRoot = normalizeProjectPath(wt.repoRoot || boundThread?.projectRoot || "");
        return {
          ...wt,
          repoRoot: normRepoRoot || wt.repoRoot,
          projectRoot: boundThread?.projectRoot || normRepoRoot || "",
          projectName: boundThread?.projectName || deriveProjectName(normRepoRoot),
          threadId: boundThread?.id || null,
          threadTitle: boundThread?.title || null,
          threadStatus: boundThread?.status || null,
          provider: boundThread?.provider || null,
          model: boundThread?.model || null,
        };
      })
      .filter((wt) => {
        if (!params.includeTemp && (isTempTestPath(wt.repoRoot) || isTempTestPath(wt.worktreePath))) {
          return false;
        }
        if (rootConvId) {
          const matchesScoped =
            (wt.threadId && scopedThreadIds.has(wt.threadId)) ||
            (wt.id && scopedWorktreeIds.has(wt.id)) ||
            (wt.worktreePath && scopedWorktreePaths.has(projectPathKey(wt.worktreePath)));
          if (!matchesScoped) return false;
        }
        if (wsKey) {
          const wtKey = projectPathKey(wt.projectRoot || wt.repoRoot || "");
          return !wtKey || wtKey === wsKey;
        }
        return true;
      });

    return { worktrees };
  }

  async function getWorktreeDiff(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    const targetPath = await resolveWorktreeTargetPath(params);
    return gitGetWorktreeDiff({
      worktreePath: targetPath,
      mode: params.mode || "working_tree",
      baseRef: params.baseRef,
      filePath: params.filePath,
    });
  }

  // Threads bound to a worktree path (any state) and whether one of them is still executing there.
  function threadsOnWorktree(targetPath) {
    const contains = candidate => candidate && (projectPathKey(candidate) === projectPathKey(targetPath) || inside(targetPath, candidate));
    return ctx.db.listThreads({ includeSubagents: true, includeArchived: true, limit: 500 })
      .filter(t => contains(t.worktreePath) || contains(t.cwd));
  }

  function assertWorktreeIdle(targetPath, action) {
    const busy = threadsOnWorktree(targetPath).filter(t => ctx.activeRunByThread.has(t.id) || ctx.pendingTurnStartLocks.has(t.id) ||
      (isThreadBusyStatus(t.status) && String(t.status).toLowerCase() !== "queued"));
    if (busy.length) {
      const names = busy.map(t => t.title || t.id).join("、");
      throw Object.assign(new Error(`工作树仍有运行中的回合（${names}），请先停止或等待完成后再${action}。`),
        { code: "WORKTREE_BUSY", threadIds: busy.map(t => t.id) });
    }
  }

  async function withWorktreeOperation(targetPath, action, operation) {
    const real = ctx.scopePolicy.assertUsableRoot(targetPath, "worktreePath");
    if ([...ctx.worktreeOperations.keys()].some(root => projectPathKey(root) === projectPathKey(real))) {
      throw Object.assign(new Error("工作树已有合入或清理正在进行。"), { code: "WORKTREE_BUSY" });
    }
    assertWorktreeIdle(real, action);
    ctx.worktreeOperations.set(real, action);
    try {
      await ctx.engineManager?.waitForPathClosed?.(real);
      return await operation(real);
    } finally { ctx.worktreeOperations.delete(real); }
  }

  function worktreeEventScopes(targetPath, params = {}) {
    const roots = new Map();
    const threads = threadsOnWorktree(targetPath);
    for (const thread of threads) {
      const rootConversationId = ctx.scopePolicy.threadPolicyRoot(thread);
      if (!rootConversationId) continue;
      const key = rootConversationId.toLowerCase();
      if (!roots.has(key) || thread.id === params.threadId) {
        roots.set(key, { threadId: thread.id, rootConversationId });
      }
    }
    if (roots.size) return [...roots.values()];
    const rootConversationId = params.conversationId ? ctx.scopePolicy.policyRoot({ conversationId: params.conversationId }) : "";
    const threadId = params.threadId || threads[0]?.id;
    return [{ ...(threadId ? { threadId } : {}), ...(rootConversationId ? { rootConversationId } : {}) }];
  }

  // After a worktree is removed, rebind its threads to their primary project so a later follow-up never starts in a
  // directory that no longer exists.
  function detachCleanedWorktree(targetPath, repoRoot) {
    const targetKey = projectPathKey(targetPath);
    const updatedIds = [];
    for (const t of threadsOnWorktree(targetPath)) {
      const workspace = t.workspace && projectPathKey(t.workspace) !== targetKey ? t.workspace : "";
      const outside = candidate => candidate && projectPathKey(candidate) !== targetKey && !inside(targetPath, candidate);
      const primary = [t.meta?.projectRoot, workspace, repoRoot].find(outside);
      const updated = ctx.db.upsertThread({ id: t.id, worktreePath: null, worktreeId: null,
        ...(primary ? { cwd: primary, ...(!outside(t.workspace) ? { workspace: primary } : {}),
          ...(!outside(t.meta?.projectRoot) ? { projectRoot: primary } : {}) } : {}),
        meta: { worktreeCleaned: true, cleanedWorktreePath: targetPath, cleanedAt: Date.now() } });
      updatedIds.push(t.id);
      ctx.context.emitEvent({ type: "thread_updated", threadId: t.id, workspace: updated.workspace || updated.cwd, thread: updated });
    }
    return updatedIds;
  }

  async function hasUnintegratedWorktree(threads, workspace) {
    for (const worktreePath of new Set(threads.map(thread => thread.worktreePath).filter(Boolean))) {
      if ([...ctx.worktreeOperations.keys()].some(root => projectPathKey(root) === projectPathKey(worktreePath))) return true;
      const safety = await inspectWorktreeSafety({ worktreePath, repoRoot: workspace });
      if (safety.unverified || safety.stagedCount || safety.unstagedCount || safety.untrackedCount || safety.aheadCount) return true;
    }
    return false;
  }

  async function integrateWorktree(params = {}, { allowSpecChanges = false } = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    let targetPath = params.worktreePath || params.path;
    if (params.threadId) {
      const thread = ctx.db.getThread(params.threadId, { includeQueue: false });
      if (!thread?.worktreePath) throw new Error("该线程没有独立工作树，拒绝从普通项目目录合并");
      if (targetPath && projectPathKey(targetPath) !== projectPathKey(thread.worktreePath)) {
        throw new Error("工作树路径与线程不匹配");
      }
      targetPath = thread.worktreePath;
    } else if (!targetPath && params.worktreeId) {
      const entries = await gitListWorktrees({ workspace: params.workspace || params.cwd, includeMain: false });
      targetPath = entries.find((w) => w.id === params.worktreeId || w.worktreeId === params.worktreeId)?.worktreePath;
    }
    if (!targetPath) throw new Error("合并需要明确的独立工作树，不能使用 cwd 替代");
    return withWorktreeOperation(targetPath, "合入", async targetPath => {
      if (!allowSpecChanges) {
        const repoRoot = await getRepoRoot(targetPath);
        if (!repoRoot || projectPathKey(repoRoot) === projectPathKey(targetPath)) throw new Error("合并需要明确的独立工作树");
        const git = (...args) => runGit(["--no-optional-locks", ...args], { cwd: targetPath }).then(result => result.stdout);
        const mainHead = (await runGit(["--no-optional-locks", "rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
        const base = (await git("merge-base", "HEAD", mainHead)).trim();
        const spec = ["spec", "spec-archive"].map(dir => `:(top,icase).agent-tower/${dir}/`);
        const changes = await Promise.all([
          git("diff", "--name-only", "--no-renames", "-z", base, "--", ...spec),
          git("diff", "--cached", "--name-only", "--no-renames", "-z", "HEAD", "--", ...spec),
          git("ls-files", "--others", "--exclude-standard", "-z", "--", ...spec),
        ]);
        if (changes.some(Boolean)) {
          throw Object.assign(new Error("工作树含项目规范改动，须经规范维护提案确认落盘"), { code: "SPEC_WRITE_FORBIDDEN_IN_WORKTREE" });
        }
      }
      const res = await gitIntegrateWorktree({
        worktreePath: targetPath,
        workspace: params.workspace,
        cwd: params.cwd,
        strategy: params.strategy || "apply_unstaged",
        commitMessage: params.commitMessage,
        cleanupAfter: Boolean(params.cleanupAfter),
        forceCleanup: params.forceCleanup === true || params.force === true,
        deleteBranch: Boolean(params.deleteBranch),
      });

      const scopes = worktreeEventScopes(targetPath, params);
      const detachedThreadIds = res.cleanedUp ? detachCleanedWorktree(targetPath, res.repoRoot) : [];

      for (const scope of scopes) ctx.context.emitEvent({
        type: "worktree_updated",
        ...scope,
        workspace: res.repoRoot || params.workspace || targetPath,
        integrated: true,
        ...(res.cleanedUp ? { cleaned: true, worktreePath: targetPath } : {}),
        result: res,
      });
      for (const scope of scopes) ctx.specs.scheduleAuto(scope.rootConversationId, res.repoRoot);
      return { ...res, ...(detachedThreadIds.length ? { detachedThreadIds } : {}) };
    });
  }

  async function cleanupWorktree(params = {}) {
    ctx.scopePolicy.explicitExecutionRoot(params);
    let targetPath = params.worktreePath || params.path;
    if (params.threadId) {
      const thread = ctx.db.getThread(params.threadId, { includeQueue: false });
      if (!thread?.worktreePath) throw new Error("该线程没有独立工作树，拒绝清理普通项目目录");
      if (targetPath && projectPathKey(targetPath) !== projectPathKey(thread.worktreePath)) throw new Error("工作树路径与线程不匹配");
      targetPath = thread.worktreePath;
    } else if (!targetPath && params.worktreeId) {
      const entries = await gitListWorktrees({ workspace: params.workspace || params.cwd, includeMain: false });
      targetPath = entries.find(w => w.id === params.worktreeId || w.worktreeId === params.worktreeId)?.worktreePath;
    }
    if (!targetPath) throw new Error("清理需要明确的独立工作树，不能使用 cwd 替代");
    return withWorktreeOperation(targetPath, "清理", async targetPath => {
      const res = await gitCleanupWorktree({
        worktreePath: targetPath,
        workspace: params.workspace,
        cwd: params.cwd,
        force: params.force === true,
        deleteBranch: Boolean(params.deleteBranch),
      });

      const scopes = worktreeEventScopes(targetPath, params);
      const detachedThreadIds = detachCleanedWorktree(targetPath, res.repoRoot);

      for (const scope of scopes) ctx.context.emitEvent({
        type: "worktree_updated",
        ...scope,
        workspace: res.repoRoot || params.workspace || params.cwd || targetPath,
        cleaned: true,
        worktreePath: targetPath,
      });
      return { ...res, ...(detachedThreadIds.length ? { detachedThreadIds } : {}) };
    });
  }

  /* ---------- v0.1.2 运行缓存统计与四重安全锁清理 ---------- */
  // Only these five runtime areas are measured or cleaned; spec/, spec-archive/, councils/ and plans/ are permanent documents.
  const CACHE_AREAS = [["tmp", "tmp"], ["testRuns", "test-runs"], ["logs", "logs"], ["conversations", "conversations"], ["worktrees", "worktrees"]];
  const LOG_RECLAIM_TRUNCATE = ["daemon.log", "tower.log"];
  const LOG_RECLAIM_DELETE = ["daemon.log.1", "tower.log.1"];
  const LOG_PRESERVE = new Set(["publish-stage.json", "publish-receipt.json"]);
  const sameKey = (a, b) => Boolean(a && b) && projectPathKey(a) === projectPathKey(b);
  const containsOrEqual = (dir, target) => Boolean(dir && target) && (sameKey(dir, target) || inside(dir, target));
  const lstatOrNull = p => fsp.lstat(p).catch(() => null);
  const readEntries = dir => fsp.readdir(dir, { withFileTypes: true }).catch(() => []);

  const isPermanentArchive = p => ["councils", "plans"].includes(path.basename(p).toLowerCase()) &&
    path.basename(path.dirname(p)).toLowerCase() === ".agent-tower";

  // Recursive byte count over lstat: links / NTFS junctions are never followed nor counted.
  async function treeBytes(p) {
    const st = await lstatOrNull(p);
    if (!st || st.isSymbolicLink() || (st.isDirectory() && isPermanentArchive(p))) return 0;
    if (!st.isDirectory()) return st.isFile() ? st.size : 0;
    let total = 0;
    for (const e of await readEntries(p)) {
      if (!e.isSymbolicLink()) total += await treeBytes(path.join(p, e.name));
    }
    return total;
  }

  // Removal that unlinks links instead of following them, so it never reaches outside the cache area.
  async function safeRemove(p) {
    const st = await lstatOrNull(p);
    if (!st) return;
    if (st.isDirectory() && isPermanentArchive(p)) throw new Error("保留会审与定稿规划归档");
    if (st.isSymbolicLink() || !st.isDirectory()) return fsp.unlink(p);
    for (const name of await fsp.readdir(p)) await safeRemove(path.join(p, name));
    await fsp.rmdir(p);
  }

  // Real (non-link) directory under `<projectRoot>/.agent-tower`, or "" when absent / linked.
  async function cacheDir(projectRoot, ...parts) {
    let dir;
    try { dir = child(projectRoot, ".agent-tower", ...parts); } catch { return ""; }
    const st = await lstatOrNull(dir);
    return st?.isDirectory() && !st.isSymbolicLink() ? dir : "";
  }

  async function resolveCacheProjectRoot(params = {}) {
    let root;
    if (params.cwd !== undefined || params.workspace !== undefined) {
      root = ctx.scopePolicy.explicitExecutionRoot(params);
    } else {
      const thread = (params.threadId && ctx.db.getThread(params.threadId, { includeQueue: false })) ||
        (params.conversationId && (ctx.db.getConversationThread(params.conversationId) ||
          ctx.hostSync.findThreadByHostConversationId(params.conversationId))) || null;
      root = ctx.scopePolicy.assertUsableRoot(thread?.meta?.projectRoot || thread?.workspace || thread?.cwd || ctx.db.defaultStudioRoot, "workspace");
    }
    // A linked worktree root shares its primary project's runtime storage.
    try {
      const top = (await runGit(["rev-parse", "--show-toplevel"], { cwd: root })).stdout.trim();
      const main = await getRepoRoot(root);
      if (top && main && sameKey(top, root) && !sameKey(main, root)) root = ctx.scopePolicy.assertUsableRoot(main, "workspace");
    } catch (err) {
      if (err?.code === "CWD_REJECTED") throw err;
      // Not a Git checkout: keep the validated root.
    }
    return root;
  }

  function pendingRequestCount(threadId) {
    try { return ctx.db.listPendingRequests({ threadId }).length; } catch { return 1; }
  }

  // Lock ①: unlike merging, a queued thread also protects its worktree.
  function worktreeBusy(wtPath, { ignoreOperations = false } = {}) {
    const busy = threadsOnWorktree(wtPath).some(t => ctx.activeRunByThread.has(t.id) || ctx.pendingTurnStartLocks.has(t.id) ||
      isThreadBusyStatus(t.status) || (Array.isArray(t.queue) && t.queue.length > 0) || pendingRequestCount(t.id) > 0);
    return busy || (!ignoreOperations &&
      [...ctx.worktreeOperations.keys()].some(root => containsOrEqual(root, wtPath) || containsOrEqual(wtPath, root)));
  }

  async function evaluateCacheWorktree(entry, repoRoot, opts = {}) {
    const reasons = [];
    if (worktreeBusy(entry.worktreePath, opts)) reasons.push({ code: "active_thread", label: "存在活跃/排队/待审批任务" });
    const names = await fsp.readdir(entry.worktreePath).catch(() => null);
    const empty = Array.isArray(names) && names.length === 0;
    const safety = repoRoot ? await inspectWorktreeSafety({ worktreePath: entry.worktreePath, repoRoot }) : null;
    const registered = Boolean(safety?.registered);
    if (safety?.isGitRepo) {
      if (safety.hasCouncilArchive) reasons.push({ code: "council_archive", label: "包含军师会审归档" });
      if (await lstatOrNull(path.join(entry.worktreePath, ".agent-tower", "plans"))) reasons.push({ code: "plan_archive", label: "包含定稿施工规划" });
      if (safety.stagedCount > 0 || safety.unstagedCount > 0) reasons.push({ code: "dirty_changes", label: "存在未提交修改" });
      if (safety.untrackedCount > 0 || safety.ignoredCount > 0) reasons.push({ code: "untracked_files", label: "存在未跟踪新文件" });
      if (!safety.unverified && safety.aheadCount > 0) reasons.push({ code: "unmerged_commits", label: `分支含 ${safety.aheadCount} 个未合入基线的提交` });
    }
    // Fail closed: only a verified registered tree, or a completely empty unregistered shell, may be removed.
    if (registered ? safety.unverified : !empty) {
      reasons.push({ code: "unverified_git_state", label: registered ? "Git 工作树状态无法核验" : "目录未在 Git 工作树注册且非空" });
    }
    return {
      ...entry,
      worktreeId: safety?.worktreeId || entry.worktreeId || "",
      branch: safety?.branch || entry.branch || "",
      registered,
      aheadCount: safety?.aheadCount || 0,
      cleanable: reasons.length === 0,
      reasons,
    };
  }

  // test-runs children, except anything holding the target project, the live test sandbox or this process' cwd.
  async function testRunItems(dir, projectRoot) {
    if (!dir) return [];
    const guards = [projectRoot, process.env.AGENT_TOWER_TEST_ROOT, process.cwd()].filter(Boolean);
    return (await readEntries(dir))
      .filter(e => !e.isSymbolicLink())
      .map(e => path.join(dir, e.name))
      .filter(item => !guards.some(g => containsOrEqual(item, g)));
  }

  // Only rotating logs and stray *.tmp are reclaimable; publish receipts are kept.
  async function logReclaimFiles(dir) {
    if (!dir) return [];
    return (await readEntries(dir))
      .filter(e => e.isFile() && !LOG_PRESERVE.has(e.name) && (LOG_RECLAIM_TRUNCATE.includes(e.name) ||
        LOG_RECLAIM_DELETE.includes(e.name) || e.name.toLowerCase().endsWith(".tmp")))
      .map(e => path.join(dir, e.name));
  }

  async function scanRuntimeCache(projectRoot, sqliteOpts = {}) {
    const bytesByArea = { tmp: 0, testRuns: 0, logs: 0, conversations: 0, worktrees: 0 };
    const scan = { projectRoot, exists: false, bytesByArea, totalBytes: 0, reclaimableBytes: 0, worktrees: [], gitRoot: "", dirs: {}, sqlite: null };
    if (!(await cacheDir(projectRoot))) return scan;
    scan.exists = true;
    for (const [key, area] of CACHE_AREAS) {
      scan.dirs[key] = await cacheDir(projectRoot, area);
      bytesByArea[key] = scan.dirs[key] ? await treeBytes(scan.dirs[key]) : 0;
    }
    const { dirs } = scan;
    let reclaimable = bytesByArea.tmp;
    for (const item of await testRunItems(dirs.testRuns, projectRoot)) reclaimable += await treeBytes(item);
    for (const file of await logReclaimFiles(dirs.logs)) reclaimable += (await lstatOrNull(file))?.size || 0;
    if (dirs.conversations) {
      const wal = await lstatOrNull(path.join(dirs.conversations, "tower.sqlite-wal"));
      // Read-only probe (PRAGMA on an open store, 100-byte header otherwise): dead pages count only past both watermarks.
      try { scan.sqlite = ctx.db.inspectProjectDb(projectRoot, sqliteOpts) || null; } catch { scan.sqlite = null; }
      // An un-checkpointed WAL and the freelist can overlap; never report more than the area physically occupies.
      reclaimable += Math.min(bytesByArea.conversations,
        (wal?.isFile() ? wal.size : 0) + Math.max(0, Number(scan.sqlite?.reclaimableBytes) || 0));
    }
    const repoRoot = await getRepoRoot(projectRoot);
    scan.gitRoot = repoRoot && sameKey(repoRoot, projectRoot) ? repoRoot : "";
    if (dirs.worktrees) {
      const candidates = new Map();
      const add = p => candidates.has(projectPathKey(p)) || candidates.set(projectPathKey(p), p);
      for (const e of await readEntries(dirs.worktrees)) {
        if (e.isDirectory() && !e.isSymbolicLink()) add(path.join(dirs.worktrees, e.name));
      }
      if (scan.gitRoot) {
        for (const wt of await gitListWorktrees({ workspace: scan.gitRoot, includeMain: false }).catch(() => [])) {
          const st = inside(dirs.worktrees, wt.worktreePath) ? await lstatOrNull(wt.worktreePath) : null;
          if (st?.isDirectory() && !st.isSymbolicLink()) add(wt.worktreePath);
        }
      }
      for (const wtPath of candidates.values()) {
        const entry = await evaluateCacheWorktree({ worktreePath: wtPath, name: path.basename(wtPath) }, scan.gitRoot);
        entry.bytes = await treeBytes(wtPath);
        if (entry.cleanable) reclaimable += entry.bytes;
        scan.worktrees.push(entry);
      }
    }
    scan.totalBytes = Object.values(bytesByArea).reduce((a, b) => a + b, 0);
    scan.reclaimableBytes = reclaimable;
    return scan;
  }

  function publicCacheStatus(scan) {
    const worktrees = scan.worktrees.map(w => ({
      worktreeId: w.worktreeId, worktreePath: w.worktreePath, name: w.name, branch: w.branch, bytes: w.bytes || 0,
      cleanable: w.cleanable, reasons: w.reasons, registered: w.registered, aheadCount: w.aheadCount,
    }));
    const idle = worktrees.filter(w => w.cleanable).length;
    return {
      ok: true,
      projectRoot: scan.projectRoot,
      exists: scan.exists,
      totalBytes: scan.totalBytes,
      reclaimableBytes: scan.reclaimableBytes,
      bytesByArea: { ...scan.bytesByArea },
      worktreeCount: worktrees.length,
      idleWorktreeCount: idle,
      protectedWorktreeCount: worktrees.length - idle,
      worktrees,
      sqlite: scan.sqlite,
    };
  }

  // Only the compaction thresholds may be tuned from RPC params (tests use tiny values); nothing else passes through.
  function sqliteThresholds(params = {}) {
    const raw = params._sqliteCompactOptions || params.sqliteCompactOptions;
    if (!raw || typeof raw !== "object") return {};
    const out = {};
    for (const key of ["minFreeBytes", "minFreeRatio", "reserveFreeBytes"]) {
      const value = Number(raw[key]);
      if (raw[key] !== undefined && Number.isFinite(value) && value >= 0) out[key] = value;
    }
    return out;
  }

  // Manual physical-compaction gate: the project must have zero active runs, start locks, worktree operations,
  // queued turns, pending runtime requests and busy threads. Unknown ownership fails closed (counts as busy).
  function isProjectIdle(projectRoot) {
    if ([...ctx.worktreeOperations.keys()].some(root => containsOrEqual(projectRoot, root))) return false;
    const inProject = t => [t?.meta?.projectRoot, t?.workspace, t?.cwd, t?.worktreePath].some(p => containsOrEqual(projectRoot, p));
    const ownedBusy = threadId => {
      const t = ctx.db.getThread(threadId, { includeQueue: false });
      return !t || inProject(t);
    };
    for (const entry of ctx.activeRuns.values()) if (ownedBusy(entry?.threadId)) return false;
    for (const threadId of ctx.activeRunByThread.keys()) if (ownedBusy(threadId)) return false;
    for (const threadId of ctx.pendingTurnStartLocks) if (ownedBusy(threadId)) return false;
    for (const threadId of ctx.db.listThreadsWithQueuedRuns()) if (ownedBusy(threadId)) return false;
    try {
      if (ctx.db.listPendingRequests({ workspace: projectRoot }).length > 0) return false;
    } catch { return false; }
    // Archived threads never block; neither does the user's own top-level host chat, a passive transcript watch that
    // the Swarm roster keeps "working" while the user talks to it. Real child work (Swarm members, subagents) still blocks.
    const threads = ctx.db.listThreads({ includeSubagents: true, includeArchived: false, limit: 500 }).filter(inProject);
    return !threads.some(t => !isPassiveRootHost(t) &&
      (isThreadBusyStatus(t.status) || (Array.isArray(t.queue) && t.queue.length > 0) || pendingRequestCount(t.id) > 0));
  }

  function isPassiveRootHost(t) {
    return Boolean(t?.isNativeHost && (!t.parentThreadId || t.role === "commander" ||
      String(t.meta?.memberName || "").toLowerCase() === "coordinator"));
  }

  // Manual-cleanup-only reaping of busy rows that can never settle, so they stop pinning the idle gate:
  // - native rows whose host transcript does not exist at all (e.g. fixture rows leaked by a bare `node --test`);
  // - external rows this daemon holds no handle for and no live foreign owner (reuses the cancellation orphan path).
  async function reconcileStaleBusyThreads(projectRoot) {
    const inProject = t => [t?.meta?.projectRoot, t?.workspace, t?.cwd, t?.worktreePath].some(p => containsOrEqual(projectRoot, p));
    const busy = ctx.db.listThreads({ includeSubagents: true, includeArchived: false, limit: 500 })
      .filter(t => inProject(t) && isThreadBusyStatus(t.status));
    const appDataDir = resolveDefaultAppDataDir(ctx.hostContext.appDataDir, ctx.hostSync.buildHostEnvForDriver());
    // Only trust "missing transcript" when the host data root itself resolves; otherwise reap nothing native.
    const hostRootKnown = Boolean(appDataDir) && existsSync(path.join(appDataDir, "brain"));
    const reaped = { phantomNative: [], orphanExternal: [] };
    for (const t of busy) {
      if (t.isNativeHost) {
        const convId = String(t.hostConversationId || "").trim();
        if (!hostRootKnown || !convId || ctx.nativeWatchers.has(convId)) continue;
        if (existsSync(resolveTranscriptPath(convId, appDataDir))) continue;
        const archived = ctx.db.upsertThread({ id: t.id, status: "interrupted", archived: true,
          meta: { ...t.meta, archivedMissingTranscript: true } });
        reaped.phantomNative.push(t.id);
        ctx.context.emitEvent({ type: "thread_archived", threadId: t.id, workspace: archived.workspace || archived.cwd, thread: archived });
        continue;
      }
      if (ctx.activeRunByThread.has(t.id) || ctx.pendingTurnStartLocks.has(t.id)) continue;
      if ([...ctx.activeRuns.values()].some(entry => entry?.threadId === t.id)) continue;
      if (ctx.db.listQueuedRuns(t.id).length) continue;
      if (ctx.cancellation.computeCancelCapability(t) !== "reconcilable_orphan") continue; // includes the live-foreign-owner check
      const outcome = await ctx.cancellation.stopThreadExecution(t, { keepQueue: true });
      if (outcome?.reconciledOrphan) reaped.orphanExternal.push(t.id);
    }
    return reaped;
  }

  // Strictly read-only: no directory creation, no file writes and no `git worktree prune`.
  async function getRuntimeCacheStatus(params = {}) {
    return publicCacheStatus(await scanRuntimeCache(await resolveCacheProjectRoot(params), sqliteThresholds(params)));
  }

  async function cleanRuntimeCache(params = {}) {
    const projectRoot = await resolveCacheProjectRoot(params);
    const sqliteOpts = sqliteThresholds(params);
    const before = await scanRuntimeCache(projectRoot, sqliteOpts);
    if (!before.exists) {
      return { ok: true, projectRoot, beforeBytes: 0, afterBytes: 0, freedBytes: 0, removedWorktrees: [], skippedWorktrees: [], sqliteCompaction: null, status: publicCacheStatus(before) };
    }
    const { dirs } = before;
    const errors = [];
    const attempt = async (label, fn) => {
      try { await fn(); } catch (err) { errors.push(`${label}: ${err?.message || err}`); }
    };

    // tmp/ holds shadow indexes and patches of in-flight merges: only swept while no worktree operation runs.
    if (dirs.tmp && ctx.worktreeOperations.size === 0) {
      for (const e of await readEntries(dirs.tmp)) {
        if (!e.isSymbolicLink()) await attempt(`tmp/${e.name}`, () => safeRemove(path.join(dirs.tmp, e.name)));
      }
    }
    for (const item of await testRunItems(dirs.testRuns, projectRoot)) {
      await attempt(`test-runs/${path.basename(item)}`, () => safeRemove(item));
    }

    const removedWorktrees = [];
    const skippedWorktrees = [];
    const skip = (w, reasons) => skippedWorktrees.push({ worktreeId: w.worktreeId, worktreePath: w.worktreePath, name: w.name, branch: w.branch, reasons });
    const removedWorktreesByRoot = new Map();
    for (const w of before.worktrees) {
      if (!w.cleanable) { skip(w, w.reasons); continue; }
      try {
        await withWorktreeOperation(w.worktreePath, "清理", async real => {
          // Re-check all four locks while holding the operation slot (TOCTOU guard against a racing dispatch).
          const recheck = await evaluateCacheWorktree({ worktreePath: real, name: w.name, branch: w.branch, worktreeId: w.worktreeId },
            before.gitRoot, { ignoreOperations: true });
          if (!recheck.cleanable || recheck.registered !== w.registered) {
            skip(w, recheck.reasons.length ? recheck.reasons : [{ code: "unverified_git_state", label: "复检时工作树状态已变化" }]);
            return;
          }
          if (!recheck.registered) {
            await fsp.rmdir(real); // empty shell only: rmdir refuses anything non-empty
            removedWorktrees.push({ worktreeId: w.worktreeId, worktreePath: real, name: w.name, branch: "", bytes: w.bytes, branchDeleted: false });
            return;
          }
          // force: false lets Git refuse dirty trees and `branch -d` refuse unmerged branches as the final backstop.
          const res = await gitCleanupWorktree({ worktreePath: real, repoRoot: projectRoot, force: false, deleteBranch: true });
          const scopes = worktreeEventScopes(real);
          const detachedThreadIds = detachCleanedWorktree(real, res.repoRoot || projectRoot);
          for (const scope of scopes) {
            const key = String(scope.rootConversationId || "").toLowerCase();
            if (!removedWorktreesByRoot.has(key)) removedWorktreesByRoot.set(key, { ...scope, worktreePaths: [] });
            removedWorktreesByRoot.get(key).worktreePaths.push(real);
          }
          removedWorktrees.push({ worktreeId: w.worktreeId, worktreePath: real, name: w.name, branch: res.branch || w.branch, bytes: w.bytes,
            branchDeleted: Boolean(res.branchDeleted), ...(detachedThreadIds.length ? { detachedThreadIds } : {}) });
        });
      } catch (err) {
        skip(w, [err?.code === "WORKTREE_BUSY"
          ? { code: "active_thread", label: "存在活跃/排队/待审批任务" }
          : { code: "cleanup_failed", label: err?.message || String(err) }]);
      }
    }
    if (before.gitRoot) await pruneStaleWorktrees(before.gitRoot);
    for (const scope of removedWorktreesByRoot.values()) {
      ctx.context.emitEvent({ type: "worktree_updated", workspace: projectRoot, cleaned: true, runtimeCache: true, ...scope });
    }
    // Database and logs go last: worktree rebinding and events above still write to both
    // (and opening a project database appends to tower.log). Physical reclaim only on this manual path, and only when idle.
    let sqliteCompaction = null;
    let reconciledThreads = null;
    await attempt("conversations", async () => {
      reconciledThreads = await reconcileStaleBusyThreads(projectRoot);
      sqliteCompaction = ctx.db.compactProjectDb(projectRoot, { ...sqliteOpts, allowPhysicalVacuum: true, isIdle: isProjectIdle(projectRoot) });
    });
    for (const file of await logReclaimFiles(dirs.logs)) {
      const name = path.basename(file);
      await attempt(`logs/${name}`, () => (LOG_RECLAIM_TRUNCATE.includes(name) ? fsp.truncate(file, 0) : fsp.unlink(file)));
    }

    const status = await getRuntimeCacheStatus({ workspace: projectRoot, _sqliteCompactOptions: sqliteOpts });
    return {
      ok: true,
      projectRoot,
      beforeBytes: before.totalBytes,
      afterBytes: status.totalBytes,
      freedBytes: Math.max(0, before.totalBytes - status.totalBytes),
      removedWorktrees,
      skippedWorktrees,
      sqliteCompaction,
      ...(reconciledThreads && (reconciledThreads.phantomNative.length || reconciledThreads.orphanExternal.length) ? { reconciledThreads } : {}),
      ...(errors.length ? { errors } : {}),
      status,
    };
  }

  return {
    cleanRuntimeCache,
    cleanupWorktree,
    getRuntimeCacheStatus,
    getWorktreeDiff,
    integrateWorktree,
    hasUnintegratedWorktree,
    listWorktrees,
    resolveWorktreeTargetPath,
  };
}

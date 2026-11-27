import { captureNoWindow } from "./engines/proc-utils.mjs";
import * as crypto from "node:crypto";
import { existsSync, lstatSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { inside, studioDir } from "./storage-paths.mjs";
import * as path from "node:path";

/**
 * Execute a git command safely without shell interpolation.
 */
export async function runGit(args, { cwd, env, timeoutMs = 30000 } = {}) {
  const targetCwd = cwd || process.cwd();
  const sandbox = process.env.AGENT_TOWER_TEST_ROOT;
  const ceiling = sandbox && inside(path.resolve(sandbox), path.resolve(targetCwd))
    ? { GIT_CEILING_DIRECTORIES: path.resolve(sandbox) } : {};
  try {
    return await captureNoWindow("git", ["-c", "core.quotepath=false", ...args], {
      cwd: targetCwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...ceiling, ...env },
      maxBuffer: 32 * 1024 * 1024, timeoutMs,
    });
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || "").trim();
    throw Object.assign(new Error(`git ${args[0]} failed: ${detail}`, { cause: err }), {
      code: err.code, stdout: err.stdout || "", stderr: err.stderr || "",
    });
  }
}

const REVIEW_SUMMARY_LIMIT = 2048 - Buffer.byteLength("\n\n<agent_tower_review_files>\n\n</agent_tower_review_files>");

function capReviewSummary(lines, statusLineCount, changedFileCount) {
  const text = lines.filter(Boolean).join("\n");
  if (Buffer.byteLength(text, "utf8") <= REVIEW_SUMMARY_LIMIT) return text;
  const kept = [];
  let keptStatusLines = 0;
  for (const line of lines) {
    const omittedStatus = Math.max(0, statusLineCount - keptStatusLines);
    const omittedLines = Math.max(0, lines.length - kept.length);
    const notice = `… 省略 ${omittedStatus} 个文件及 ${omittedLines} 行摘要（共 ${changedFileCount} 个变更文件）`;
    const candidate = [...kept, line, notice].join("\n");
    if (Buffer.byteLength(candidate, "utf8") > REVIEW_SUMMARY_LIMIT) break;
    kept.push(line);
    if (kept.length <= statusLineCount) keptStatusLines++;
  }
  const omittedStatus = Math.max(0, statusLineCount - keptStatusLines);
  const omittedLines = Math.max(0, lines.length - kept.length);
  return [...kept, `… 省略 ${omittedStatus} 个文件及 ${omittedLines} 行摘要（共 ${changedFileCount} 个变更文件）`].join("\n");
}

export async function collectReviewGitSnapshot({
  cwd,
  scope = "uncommitted",
  baseBranch = "main",
  commitSha = "HEAD",
} = {}) {
  const empty = { changedPaths: [], summaryBlock: "" };
  if (!cwd || !existsSync(cwd)) return empty;
  const git = args => runGit(["--no-optional-locks", ...args], { cwd });
  const paths = output => String(output || "").split("\0").filter(Boolean);
  try {
    const normalizedScope = String(scope || "uncommitted").toLowerCase();
    let changed, statusLines, stats;
    if (normalizedScope === "branch" || normalizedScope === "commit") {
      const args = normalizedScope === "branch" ? ["diff"] : ["diff-tree", "--no-commit-id", "-r", "-m", "--root"];
      const range = normalizedScope === "branch" ? `${baseBranch || "main"}...HEAD` : commitSha || "HEAD";
      const tail = ["--no-renames", "--no-ext-diff", "--no-textconv", "--end-of-options", range, "--"];
      const [names, stat] = await Promise.all([git([...args, "--name-only", "-z", ...tail]), git([...args, "--numstat", ...tail])]);
      changed = paths(names.stdout);
      statusLines = [];
      stats = [stat];
    } else {
      const [status, staged, unstaged] = await Promise.all([
        git(["status", "--porcelain=v1", "--no-renames", "--untracked-files=all", "-z"]),
        git(["diff", "--cached", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "--"]),
        git(["diff", "--numstat", "--no-renames", "--no-ext-diff", "--no-textconv", "--"]),
      ]);
      const records = paths(status.stdout);
      changed = records.map(line => line.slice(3));
      statusLines = records.map(line => line.replaceAll("\n", "\\n").replaceAll("\r", "\\r"));
      stats = [staged, unstaged];
    }
    const changedPaths = [...new Set(changed)].sort();
    const statLines = stats.flatMap(stat => stat.stdout.split(/\r?\n/).filter(Boolean));
    const summaryBlock = capReviewSummary([...statusLines, ...statLines], statusLines.length, changedPaths.length);
    return { changedPaths, summaryBlock };
  } catch {
    return empty;
  }
}

function normalizeFsPath(p) {
  if (!p) return "";
  return path.resolve(String(p).trim());
}

function sameFsPath(a, b) {
  if (!a || !b) return false;
  const na = normalizeFsPath(a).replace(/\\/g, "/").toLowerCase();
  const nb = normalizeFsPath(b).replace(/\\/g, "/").toLowerCase();
  return na === nb;
}

function makeWorktreeId(wtPath) {
  const norm = normalizeFsPath(wtPath).replace(/\\/g, "/").toLowerCase();
  return `wt_${crypto.createHash("sha1").update(norm).digest("hex").slice(0, 12)}`;
}

function sanitizeBranchFragment(text) {
  const cleaned = String(text || "task")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36);
  return cleaned || "task";
}

/**
 * Resolve the primary Git repository root (even if called from inside a linked worktree!).
 */
export async function getRepoRoot(cwd = process.cwd()) {
  if (!cwd || !existsSync(cwd)) return null;
  try {
    // --git-common-dir always points to the main repository's .git directory, even inside linked worktrees
    const commonRes = await runGit(["--no-optional-locks", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd });
    const commonGitDir = commonRes.stdout.trim();
    if (commonGitDir && path.basename(commonGitDir).toLowerCase() === ".git") {
      return normalizeFsPath(path.dirname(commonGitDir));
    }
    const topRes = await runGit(["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd });
    return normalizeFsPath(topRes.stdout.trim());
  } catch {
    return null;
  }
}

/**
 * Inspect working tree status of a Git directory (main repo or worktree).
 */
export async function getRepoStatus(cwd = process.cwd()) {
  if (!cwd || !existsSync(cwd)) {
    return {
      isGitRepo: false,
      repoRoot: null,
      cwd: normalizeFsPath(cwd),
      branch: "",
      headSha: "",
      dirty: false,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      changedFilesCount: 0,
      files: [],
    };
  }

  let topLevel = null;
  try {
    const res = await runGit(["--no-optional-locks", "rev-parse", "--show-toplevel"], { cwd });
    topLevel = normalizeFsPath(res.stdout.trim());
  } catch {
    return {
      isGitRepo: false,
      repoRoot: null,
      cwd: normalizeFsPath(cwd),
      branch: "",
      headSha: "",
      dirty: false,
      stagedCount: 0,
      unstagedCount: 0,
      untrackedCount: 0,
      changedFilesCount: 0,
      files: [],
    };
  }

  let branch = "";
  let headSha = "";
  try {
    const bRes = await runGit(["--no-optional-locks", "symbolic-ref", "--short", "-q", "HEAD"], { cwd: topLevel });
    branch = bRes.stdout.trim();
  } catch {
    branch = "HEAD";
  }
  try {
    const hRes = await runGit(["--no-optional-locks", "rev-parse", "HEAD"], { cwd: topLevel });
    headSha = hRes.stdout.trim();
  } catch {
    headSha = "";
  }

  const stRes = await runGit(["--no-optional-locks", "status", "--porcelain=v1", "-uall"], { cwd: topLevel });
  const lines = stRes.stdout.split(/\r?\n/).filter(Boolean);
  let stagedCount = 0;
  let unstagedCount = 0;
  let untrackedCount = 0;
  const files = [];

  for (const line of lines) {
    const xy = line.slice(0, 2);
    const rawFile = line.slice(3).trim();
    const file = rawFile.includes(" -> ") ? rawFile.split(" -> ").pop().trim() : rawFile;
    if (xy === "??") {
      untrackedCount++;
      files.push({ path: file, status: "untracked", code: xy });
    } else {
      if (xy[0] !== " " && xy[0] !== "?") stagedCount++;
      if (xy[1] !== " " && xy[1] !== "?") unstagedCount++;
      const status =
        xy.includes("D")
          ? "deleted"
          : xy.includes("A")
            ? "added"
            : xy.includes("R")
              ? "renamed"
              : "modified";
      files.push({ path: file, status, code: xy });
    }
  }

  const repoRoot = (await getRepoRoot(topLevel)) || topLevel;
  return {
    isGitRepo: true,
    repoRoot,
    worktreeRoot: topLevel,
    branch,
    headSha,
    dirty: files.length > 0,
    stagedCount,
    unstagedCount,
    untrackedCount,
    changedFilesCount: files.length,
    files,
  };
}

function parsePorcelainWorktrees(stdout) {
  const entries = [];
  let current = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      if (current && current.path) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current && current.path) entries.push(current);
      current = {
        path: normalizeFsPath(line.slice("worktree ".length)),
        headSha: "",
        branch: "",
        bare: false,
        detached: false,
        prunable: false,
        locked: false,
      };
    } else if (current) {
      if (line.startsWith("HEAD ")) {
        current.headSha = line.slice("HEAD ".length).trim();
      } else if (line.startsWith("branch ")) {
        const ref = line.slice("branch ".length).trim();
        current.branch = ref.replace(/^refs\/heads\//, "");
      } else if (line === "bare") {
        current.bare = true;
      } else if (line === "detached") {
        current.detached = true;
      } else if (line.startsWith("prunable")) {
        current.prunable = true;
      } else if (line === "locked" || line.startsWith("locked ")) {
        current.locked = true;
      }
    }
  }
  if (current && current.path) entries.push(current);
  return entries;
}

/**
 * List active Git worktrees for the given workspace/repository.
 * Excludes the primary root working tree by default (`includeMain = false`) so UI lists isolated agent worktrees cleanly.
 */
export async function listWorktrees({
  cwd,
  workspace,
  includeMain = false,
} = {}) {
  const targetDir = workspace || cwd || process.cwd();
  const repoRoot = await getRepoRoot(targetDir);
  if (!repoRoot) return [];

  // Read-only: stale administrative entries are pruned by create/cleanup, never by a listing.
  let rawEntries = [];
  try {
    const wtRes = await runGit(["--no-optional-locks", "worktree", "list", "--porcelain"], { cwd: repoRoot });
    rawEntries = parsePorcelainWorktrees(wtRes.stdout);
  } catch {
    return [];
  }

  const mainHead = rawEntries.find(entry => sameFsPath(entry.path, repoRoot))?.headSha;
  const entries = rawEntries.filter(entry => !entry.bare && !entry.prunable && existsSync(entry.path) &&
    (includeMain || !sameFsPath(entry.path, repoRoot)));
  return Promise.all(entries.map(async entry => {
    const isMain = sameFsPath(entry.path, repoRoot);
    const git = args => runGit(["--no-optional-locks", ...args], { cwd: entry.path });
    let dirty = false;
    let changedFilesCount = 0;
    let additions = 0;
    let deletions = 0;
    try {
      const [status, base] = await Promise.all([
        git(["status", "--porcelain=v1", "-uall"]),
        resolveDiffBase(entry.path, entry.headSha, mainHead),
      ]);
      changedFilesCount = status.stdout.split(/\r?\n/).filter(Boolean).length;
      dirty = changedFilesCount > 0;
      const args = ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv"];
      const numstat = dirty
        ? await withShadowIndex(entry.path, env =>
          runGit(["--no-optional-locks", ...args, "--cached", base, "--"], { cwd: entry.path, env }), { repoRoot, preserveBlankRepo: true })
        : await git([...args, base, entry.headSha, "--"]);
      ({ changedFilesCount, additions, deletions } = summarizeNumstat(numstat.stdout));
    } catch {}

    const id = makeWorktreeId(entry.path);
    return {
      id,
      worktreeId: id,
      path: entry.path,
      worktreePath: entry.path,
      repoRoot,
      branch: entry.branch || (entry.detached ? `detached@${entry.headSha.slice(0, 7)}` : "HEAD"),
      headSha: entry.headSha,
      isMain,
      dirty,
      changedFilesCount,
      additions,
      deletions,
    };
  }));
}

async function hasCouncilArchive(worktreePath) {
  const tower = path.join(worktreePath, ".agent-tower");
  try {
    if (!(await fsp.lstat(tower)).isDirectory()) return false;
    return (await fsp.lstat(path.join(tower, "councils"))).isDirectory();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Read-only safety probe used by runtime-cache cleanup (never prunes, never mutates the index or refs).
 * Fail-closed: anything that is not a verifiably registered linked worktree is reported as `unverified: true`.
 */
export async function inspectWorktreeSafety({ worktreePath, repoRoot } = {}) {
  const targetWt = normalizeFsPath(worktreePath || "");
  const result = {
    worktreeId: targetWt ? makeWorktreeId(targetWt) : "",
    worktreePath: targetWt,
    repoRoot: repoRoot ? normalizeFsPath(repoRoot) : "",
    registered: false,
    locked: false,
    isGitRepo: false,
    branch: "",
    headSha: "",
    baseSha: "",
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    ignoredCount: 0,
    changedFilesCount: 0,
    aheadCount: 0,
    unverified: true,
  };
  if (!targetWt || !result.repoRoot || !existsSync(targetWt) || !existsSync(result.repoRoot)) return result;
  let entries;
  try {
    entries = parsePorcelainWorktrees((await runGit(["worktree", "list", "--porcelain"], { cwd: result.repoRoot })).stdout);
  } catch {
    return result;
  }
  const mainPath = entries[0]?.path;
  const entry = entries.find(w => !w.bare && sameFsPath(w.path, targetWt) && !sameFsPath(w.path, mainPath) && !sameFsPath(w.path, result.repoRoot));
  if (!entry) return result;
  result.registered = true;
  result.locked = entry.locked;
  result.branch = entry.branch || "";
  if (entry.prunable) return result;
  try {
    const st = await getRepoStatus(targetWt);
    if (!st.isGitRepo || !sameFsPath(st.worktreeRoot, targetWt)) return result;
    Object.assign(result, {
      isGitRepo: true,
      branch: st.branch && st.branch !== "HEAD" ? st.branch : result.branch,
      headSha: st.headSha,
      stagedCount: st.stagedCount,
      unstagedCount: st.unstagedCount,
      untrackedCount: st.untrackedCount,
      changedFilesCount: st.changedFilesCount,
    });
    // Git's normal status hides ignored files. Protect user ignored files (e.g. .env / secrets)
    // while allowing AgentTower's own ignored `.agent-tower/` runtime metadata inside the worktree.
    result.hasCouncilArchive = await hasCouncilArchive(targetWt);
    const ignoredStatus = await runGit(["status", "--porcelain=v1", "-uall", "--ignored"], { cwd: targetWt });
    result.ignoredCount = ignoredStatus.stdout.split(/\r?\n/).filter((line) => {
      if (line.slice(0, 2) !== "!!") return false;
      const rel = line.slice(3).trim().replace(/^"|"$/g, "").replace(/\\/g, "/");
      return rel !== ".agent-tower" && !rel.startsWith(".agent-tower/");
    }).length;
    if (!st.headSha) return result;
    result.baseSha = (await runGit(["rev-parse", "--verify", "HEAD"], { cwd: result.repoRoot })).stdout.trim();
    const ahead = Number.parseInt((await runGit(["rev-list", "--count", `HEAD..${st.headSha}`], { cwd: result.repoRoot })).stdout.trim(), 10);
    if (!Number.isFinite(ahead) || ahead < 0) return result;
    result.aheadCount = ahead;
    result.unverified = entry.locked === true;
  } catch {
    result.unverified = true;
  }
  return result;
}

function isPrimaryGitRoot(dir) {
  if (!dir) return false;
  try {
    const dotGit = path.join(dir, ".git");
    return lstatSync(dotGit).isDirectory() && ["HEAD", "refs", "objects"].every(name => existsSync(path.join(dotGit, name)));
  } catch {
    return false;
  }
}

/**
 * Create an isolated Git worktree and dedicated branch for a parallel subagent.
 */
export async function createIsolatedWorktree({
  cwd,
  workspace,
  threadId = "",
  taskSlug = "",
  branch,
  baseRef = "HEAD",
} = {}) {
  const sourceDir = workspace || cwd || process.cwd();
  const normalizedSource = normalizeFsPath(sourceDir);
  const repoRoot = isPrimaryGitRoot(normalizedSource) ? normalizedSource : await getRepoRoot(sourceDir);
  if (!repoRoot) {
    throw Object.assign(
      new Error(`无法创建 Git Worktree：当前目录不是有效的 Git 仓库 (${sourceDir})`),
      { code: "WORKTREE_CREATE_FAILED" },
    );
  }

  const shortSuffix = (threadId ? sanitizeBranchFragment(threadId).slice(-6) : "") || crypto.randomUUID().slice(0, 6);
  const slug = sanitizeBranchFragment(taskSlug || branch || "subagent");
  const branchName = branch || `tower/${slug}-${shortSuffix}`;

  const rootBase = studioDir(repoRoot, "worktrees");

  const folderName = `${slug}-${shortSuffix}-${Date.now().toString(36).slice(-4)}`;
  let worktreePath = normalizeFsPath(path.join(rootBase, folderName));

  // Verify baseRef and check branch existence in parallel to cut subprocess latency.
  const [baseSha, branchExists] = await Promise.all([
    runGit(["--no-optional-locks", "rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`], { cwd: repoRoot })
      .then((rev) => rev.stdout.trim())
      .catch(() => {
        throw Object.assign(
          new Error(`无法创建 Git Worktree：基准引用 "${baseRef}" 无效或仓库尚无初始 Commit。`),
          { code: "WORKTREE_CREATE_FAILED" },
        );
      }),
    runGit(["--no-optional-locks", "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { cwd: repoRoot })
      .then(() => true, () => false),
  ]);

  const finalBranch = branchExists ? `${branchName}-${crypto.randomUUID().slice(0, 4)}` : branchName;

  const createOptions = { cwd: repoRoot, env: { LC_ALL: "C" }, timeoutMs: 60000 };
  async function addWorktree() {
    try {
      await runGit(["worktree", "add", "-b", finalBranch, worktreePath, baseSha], createOptions);
    } catch (error) {
      if (process.platform !== "win32" || !/\$GIT_DIR['"]? too big/.test(error.stderr)) throw error;
      // Git has created the branch. A shorter folder also shortens the Git administrative path used by remove.
      worktreePath = normalizeFsPath(path.join(rootBase, crypto.randomBytes(4).toString("hex")));
      await runGit(["worktree", "add", worktreePath, finalBranch], createOptions);
    }
  }
  try {
    try {
      await addWorktree();
    } catch (firstError) {
      if (!/missing but already registered worktree/.test(firstError.stderr)) throw firstError;
      await pruneStaleWorktrees(repoRoot);
      // add -b can create the ref before noticing the stale registration.
      const ref = await runGit(["--no-optional-locks", "rev-parse", "--verify", `refs/heads/${finalBranch}`],
        { cwd: repoRoot }).then(result => result.stdout.trim(), () => null);
      if (!ref) await addWorktree();
      else if (ref === baseSha) await runGit(["worktree", "add", worktreePath, finalBranch], createOptions);
      else throw firstError;
    }
  } catch (error) {
    throw Object.assign(
      new Error(`无法创建 Git Worktree：${error?.message || String(error)}`, { cause: error }),
      { code: "WORKTREE_CREATE_FAILED", stdout: error?.stdout || "", stderr: error?.stderr || "" },
    );
  }

  // Honor `.worktreeinclude` if present in repoRoot (AgentTower compatibility)
  const includeFile = path.join(repoRoot, ".worktreeinclude");
  if (existsSync(includeFile)) {
    try {
      const patterns = (await fsp.readFile(includeFile, "utf-8"))
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith("#") && !l.includes(".."));
      for (const rel of patterns) {
        const srcPath = path.join(repoRoot, rel);
        const dstPath = path.join(worktreePath, rel);
        if (existsSync(srcPath) && !existsSync(dstPath)) {
          const stat = await fsp.lstat(srcPath);
          if (stat.isFile()) {
            await fsp.mkdir(path.dirname(dstPath), { recursive: true });
            await fsp.copyFile(srcPath, dstPath);
          }
        }
      }
    } catch {
      // Non-fatal
    }
  }

  const id = makeWorktreeId(worktreePath);
  return {
    id,
    worktreeId: id,
    path: worktreePath,
    worktreePath,
    repoRoot,
    branch: finalBranch,
    baseRef,
    baseSha,
    headSha: baseSha,
    dirty: false,
    changedFilesCount: 0,
    createdAt: Date.now(),
  };
}

async function withShadowIndex(worktreePath, readIndex, { repoRoot = "", preserveBlankRepo = false } = {}) {
  const cwd = worktreePath;
  const { stdout } = await runGit(["--no-optional-locks", "rev-parse", "--path-format=absolute",
    "--git-path", "index", "--git-path", "objects"], { cwd });
  const [indexPath, objectsPath] = stdout.trimEnd().split(/\r?\n/);
  const root = repoRoot || (await getRepoRoot(worktreePath)) || worktreePath;
  const tmpBase = preserveBlankRepo && !existsSync(path.join(root, ".agent-tower"))
    ? (process.env.AGENT_TOWER_TEST_ROOT || tmpdir())
    : studioDir(root, "tmp");
  await fsp.mkdir(tmpBase, { recursive: true });
  const scratch = await fsp.mkdtemp(path.join(tmpBase, "tower-shadow-"));
  try {
    const tmpIndex = path.join(scratch, "index");
    const tmpObjects = path.join(scratch, "objects");
    await fsp.mkdir(tmpObjects);
    try {
      await fsp.copyFile(indexPath, tmpIndex);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    // Git add writes blobs as well as the index. Keep both in scratch storage.
    const shadowEnv = {
      GIT_INDEX_FILE: tmpIndex,
      GIT_OBJECT_DIRECTORY: tmpObjects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: [JSON.stringify(objectsPath), process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES]
        .filter(Boolean).join(path.delimiter),
    };
    const addArgs = ["add", "-A", "--", "."];
    try {
      const topEntries = await fsp.readdir(worktreePath);
      for (const name of topEntries) {
        if (name === ".git") continue;
        const st = await fsp.lstat(path.join(worktreePath, name)).catch(() => null);
        if (st?.isSymbolicLink()) {
          addArgs.push(`:(exclude)${name}`);
        }
      }
    } catch {}
    await runGit(["--no-optional-locks", ...addArgs], { cwd, env: shadowEnv });
    return await readIndex(shadowEnv);
  } finally {
    await fsp.rm(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * Capture the combined branch and working-tree diff using temporary Git storage.
 */
export async function buildShadowUnifiedDiff(worktreePath, compareBaseSha, filePath) {
  return withShadowIndex(worktreePath, async shadowEnv => {
    const diffArgs = [
      "diff",
      "--cached",
      "--no-color",
      "--no-ext-diff",
      "--src-prefix=a/",
      "--dst-prefix=b/",
      compareBaseSha,
    ];
    const numstatArgs = ["diff", "--cached", "--numstat", compareBaseSha];
    const nameStatusArgs = ["diff", "--cached", "--name-status", compareBaseSha];

    if (filePath) {
      diffArgs.push("--", filePath);
      numstatArgs.push("--", filePath);
      nameStatusArgs.push("--", filePath);
    }

    const results = await Promise.allSettled([diffArgs, numstatArgs, nameStatusArgs]
      .map(args => runGit(["--no-optional-locks", ...args], { cwd: worktreePath, env: shadowEnv })));
    const [diffRes, numRes, statusRes] = results.map(result => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });

    return {
      diff: diffRes.stdout,
      numstatRaw: numRes.stdout,
      nameStatusRaw: statusRes.stdout,
    };
  });
}

function summarizeNumstat(stdout) {
  let additions = 0, deletions = 0, changedFilesCount = 0;
  const records = stdout.split("\0");
  for (let i = 0; i < records.length - 1; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t/.exec(records[i]);
    if (!match) continue;
    additions += Number(match[1]) || 0;
    deletions += Number(match[2]) || 0;
    changedFilesCount++;
    // NUL-delimited numstat encodes a rename as an empty path followed by both names.
    if (records[i].length === match[0].length) i += 2;
  }
  return { additions, deletions, changedFilesCount };
}

async function resolveDiffBase(cwd, headSha, baseRef) {
  if (!baseRef || headSha === baseRef) return headSha;
  try {
    const { stdout } = await runGit(["--no-optional-locks", "merge-base", "--end-of-options", headSha, baseRef], { cwd });
    return stdout.trim() || headSha;
  } catch {
    return headSha;
  }
}

function splitDiffByFile(unifiedDiff) {
  const byFile = new Map();
  if (!unifiedDiff) return byFile;
  const chunks = unifiedDiff.split(/(?=^diff --git )/m);
  for (const chunk of chunks) {
    if (!chunk.startsWith("diff --git ")) continue;
    const headerMatch = /^diff --git a\/(.+?) b\/(.+?)$/m.exec(chunk);
    if (headerMatch) {
      byFile.set(headerMatch[2], chunk);
    }
  }
  return byFile;
}

/**
 * Extract full Unified Diff and per-file +/- statistics for a worktree.
 */
export async function getWorktreeDiff({
  worktreePath,
  path: altPath,
  cwd,
  mode = "working_tree",
  baseRef,
  filePath,
} = {}) {
  const targetPath = normalizeFsPath(worktreePath || altPath || cwd || "");
  if (!targetPath || !existsSync(targetPath)) {
    throw new Error(`Worktree 路径不存在: ${targetPath}`);
  }

  const status = await getRepoStatus(targetPath);
  if (!status.isGitRepo) {
    throw new Error(`目标目录不是有效的 Git Worktree: ${targetPath}`);
  }

  // Resolve comparison base SHA:
  // If baseRef is specified, use merge-base(HEAD, baseRef); else if main repo HEAD differs from worktree HEAD,
  // use merge-base(mainRepoHEAD, worktreeHEAD) so committed subagent work is ALSO visible alongside unstaged/untracked changes!
  let comparisonRef = baseRef;
  if (!comparisonRef && status.repoRoot && !sameFsPath(status.repoRoot, targetPath)) {
    const mainHead = await runGit(["--no-optional-locks", "rev-parse", "HEAD"], { cwd: status.repoRoot }).catch(() => null);
    comparisonRef = mainHead?.stdout.trim();
  }
  const compareSha = await resolveDiffBase(targetPath, status.headSha, comparisonRef);

  // If mode explicitly asks only committed branch range without working tree
  let diffData;
  if (mode === "committed_only" || mode === "branch_range") {
    const argsBase = [compareSha, "HEAD", ...(filePath ? ["--", filePath] : [])];
    const [dRes, nRes, sRes] = await Promise.all([
      runGit(["--no-optional-locks", "diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", ...argsBase], { cwd: targetPath }),
      runGit(["--no-optional-locks", "diff", "--numstat", ...argsBase], { cwd: targetPath }),
      runGit(["--no-optional-locks", "diff", "--name-status", ...argsBase], { cwd: targetPath }),
    ]);
    diffData = { diff: dRes.stdout, numstatRaw: nRes.stdout, nameStatusRaw: sRes.stdout };
  } else {
    diffData = await buildShadowUnifiedDiff(targetPath, compareSha, filePath);
  }

  const statusByFile = new Map();
  for (const line of diffData.nameStatusRaw.split(/\r?\n/).filter(Boolean)) {
    const parts = line.split("\t");
    const code = parts[0] || "M";
    const fPath = parts[parts.length - 1];
    const kind =
      code.startsWith("A")
        ? "added"
        : code.startsWith("D")
          ? "deleted"
          : code.startsWith("R")
            ? "renamed"
            : "modified";
    if (fPath) statusByFile.set(fPath, kind);
  }

  const perFileDiffs = splitDiffByFile(diffData.diff);
  const files = [];
  let totalAdditions = 0;
  let totalDeletions = 0;

  for (const line of diffData.numstatRaw.split(/\r?\n/).filter(Boolean)) {
    const [addRaw, delRaw, ...rest] = line.split("\t");
    const fPath = rest.join("\t");
    if (!fPath) continue;
    const additions = addRaw === "-" ? 0 : Number.parseInt(addRaw, 10) || 0;
    const deletions = delRaw === "-" ? 0 : Number.parseInt(delRaw, 10) || 0;
    totalAdditions += additions;
    totalDeletions += deletions;
    files.push({
      path: fPath,
      fileName: fPath,
      status: statusByFile.get(fPath) || "modified",
      additions,
      deletions,
      diff: perFileDiffs.get(fPath) || "",
    });
  }

  const id = makeWorktreeId(targetPath);
  return {
    worktreeId: id,
    worktreePath: targetPath,
    repoRoot: status.repoRoot,
    branch: status.branch,
    headSha: status.headSha,
    baseSha: compareSha,
    mode,
    dirty: status.dirty || files.length > 0,
    changedFilesCount: files.length,
    additions: totalAdditions,
    deletions: totalDeletions,
    files,
    diff: diffData.diff,
    summary: `${files.length} file(s) changed, +${totalAdditions} / -${totalDeletions}`,
  };
}

async function ensureWorktreeChangesCommitted(worktreePath, commitMessage) {
  const st = await getRepoStatus(worktreePath);
  if (!st.dirty) return st.headSha;
  await runGit(["add", "-A"], { cwd: worktreePath });
  await runGit(
    [
      "-c",
      "user.name=AgentTower",
      "-c",
      "user.email=tower@local",
      "commit",
      "-m",
      commitMessage || `chore(worktree): snapshot changes on ${st.branch || "subagent"}`,
    ],
    { cwd: worktreePath }
  );
  const rev = await runGit(["rev-parse", "HEAD"], { cwd: worktreePath });
  return rev.stdout.trim();
}

// Git owns both dirty checks and removal of registered linked worktrees.
export async function cleanupWorktree({
  worktreePath,
  path: altPath,
  repoRoot,
  workspace,
  cwd,
  force = false,
  deleteBranch = false,
} = {}) {
  const targetWt = normalizeFsPath(worktreePath || altPath || "");
  if (!targetWt) {
    throw new Error("cleanupWorktree 需要提供 worktreePath");
  }

  const mainRoot = await getRepoRoot(repoRoot || workspace || cwd || targetWt);
  if (!mainRoot || sameFsPath(mainRoot, targetWt)) throw new Error("拒绝清理：目标不是已注册的独立 Git 工作树");
  await pruneStaleWorktrees(mainRoot);
  const listing = await runGit(["worktree", "list", "--porcelain"], { cwd: mainRoot });
  const entry = parsePorcelainWorktrees(listing.stdout).slice(1).find(w => sameFsPath(w.path, targetWt));
  if (!entry || entry.bare) throw new Error("拒绝清理未注册的工作树目录");
  if (await hasCouncilArchive(targetWt)) throw new Error("工作树包含军师会审归档，请先保留纪要再清理");
  // Windows Git may report success but leave NTFS junctions behind. Only an explicit
  // force request may detach them before Git performs its dirtiness check.
  if (force === true && existsSync(targetWt)) {
    if (!sameFsPath(await fsp.realpath(targetWt), targetWt)) throw new Error("拒绝通过重解析路径强制清理工作树");
    async function unlinkLinks(dir) {
      for (const item of await fsp.readdir(dir, { withFileTypes: true })) {
        const child = path.join(dir, item.name);
        if (item.isSymbolicLink()) await fsp.unlink(child);
        else if (item.isDirectory()) await unlinkLinks(child);
      }
    }
    await unlinkLinks(targetWt);
  }
  try {
    await runGit(["worktree", "remove", ...(force === true ? ["--force", "--force"] : []), "--", targetWt], { cwd: mainRoot });
  } catch (cause) {
    throw new Error(force === true ? "Git 强制清理失败，未递归删除目录" : "工作树可能存在未提交改动或被锁定；请先保存/合并，或显式确认强制清理。", { cause });
  }
  if (existsSync(targetWt)) throw new Error("Git 已解除注册，但目录有残留；为保护文件，未递归删除");
  const detectedBranch = entry.branch;
  let branchDeleted = false;
  if (deleteBranch && detectedBranch && !["HEAD", "main", "master"].includes(detectedBranch)) {
    branchDeleted = await runGit(["branch", force === true ? "-D" : "-d", "--", detectedBranch], { cwd: mainRoot }).then(() => true, () => false);
  }
  return { cleaned: true, worktreePath: targetWt, repoRoot: mainRoot, branch: detectedBranch || null, branchDeleted };
}

// Drop administrative entries of worktrees whose directories are already gone (mutating; never from a listing).
export async function pruneStaleWorktrees(repoRoot) {
  try {
    await runGit(["worktree", "prune"], { cwd: repoRoot });
  } catch {}
}

// The merge itself already landed; a failed post-merge cleanup is reported instead of masking the success.
async function cleanupAfterIntegration(options) {
  try {
    return { cleanupResult: await cleanupWorktree(options) };
  } catch (err) {
    return { cleanupResult: null, cleanupError: err?.message || String(err) };
  }
}

/**
 * Integrate changes from an isolated subagent worktree back into the primary workspace.
 * Supports: `'apply_unstaged' | 'squash_merge' | 'merge_noff' | 'cherry_pick'` with preflight conflict checks.
 */
export async function integrateWorktree({
  worktreePath,
  path: altPath,
  repoRoot,
  workspace,
  cwd,
  strategy = "apply_unstaged",
  commitMessage,
  cleanupAfter = false,
  forceCleanup = false,
  deleteBranch = false,
} = {}) {
  const targetWt = normalizeFsPath(worktreePath || altPath || "");
  if (!targetWt || !existsSync(targetWt)) {
    throw new Error(`Worktree 目录不存在: ${targetWt}`);
  }

  const mainRoot =
    (repoRoot ? normalizeFsPath(repoRoot) : null) ||
    (workspace ? await getRepoRoot(workspace) : null) ||
    (cwd ? await getRepoRoot(cwd) : null) ||
    (await getRepoRoot(targetWt));

  if (!mainRoot || !existsSync(mainRoot)) {
    throw new Error("无法定位主 Git 仓库根目录");
  }
  if (sameFsPath(mainRoot, targetWt)) {
    throw new Error("目标路径即为主工作区本身，无需合并");
  }
  const wtListing = await runGit(["worktree", "list", "--porcelain"], { cwd: mainRoot });
  const registeredWt = parsePorcelainWorktrees(wtListing.stdout)
    .slice(1)
    .find((w) => sameFsPath(w.path, targetWt));
  if (!registeredWt || registeredWt.bare) {
    throw new Error("拒绝合并：目标路径不是当前主仓库已注册的独立 Git Worktree");
  }

  const normStrategy = String(strategy || "apply_unstaged").trim().toLowerCase();
  const isCommitStrategy =
    normStrategy === "squash_merge" ||
    normStrategy === "squash" ||
    normStrategy === "merge_noff" ||
    normStrategy === "merge" ||
    normStrategy === "cherry_pick";
  if (isCommitStrategy) {
    const mainStatus = await getRepoStatus(mainRoot);
    if (mainStatus.dirty || mainStatus.stagedCount > 0 || mainStatus.unstagedCount > 0 || mainStatus.untrackedCount > 0) {
      throw new Error(
        "主工作区存在未提交改动或未跟踪文件，拒绝执行分支提交合并以免混入无关改动或回滚误伤；请先提交改动或将改动和未跟踪文件一起收起，或改用「应用补丁 (apply_unstaged)」策略。"
      );
    }
  }
  const diffInfo = await getWorktreeDiff({ worktreePath: targetWt });

  if (!diffInfo.diff.trim() && diffInfo.changedFilesCount === 0) {
    const { cleanupResult, cleanupError } = cleanupAfter
      ? await cleanupAfterIntegration({ worktreePath: targetWt, repoRoot: mainRoot, force: forceCleanup === true, deleteBranch })
      : { cleanupResult: null };
    return {
      integrated: true,
      noChanges: true,
      strategy: normStrategy,
      repoRoot: mainRoot,
      worktreePath: targetWt,
      filesChanged: 0,
      additions: 0,
      deletions: 0,
      cleanedUp: Boolean(cleanupResult?.cleaned),
      ...(cleanupError ? { cleanupError } : {}),
    };
  }

  // Strategy 1: Apply Unified Patch directly onto main workspace without switching/merging branches
  if (normStrategy === "apply_unstaged" || normStrategy === "apply" || normStrategy === "patch") {
    const patchFile = path.join(
      studioDir(mainRoot, "tmp"),
      `tower-wt-patch-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.patch`
    );
    try {
      await fsp.writeFile(patchFile, diffInfo.diff, "utf-8");

      try {
        await runGit(["apply", "--check", "--whitespace=nowarn", patchFile], { cwd: mainRoot });
        await runGit(["apply", "--whitespace=nowarn", patchFile], { cwd: mainRoot });
      } catch (err) {
        throw new Error(`补丁无法直接应用，请解决冲突或改用分支合并策略：${err.message}`);
      }
    } finally {
      await fsp.rm(patchFile, { force: true }).catch(() => {});
    }
  } else if (normStrategy === "squash_merge" || normStrategy === "squash") {
    const wtStatus = await getRepoStatus(targetWt);
    const branchRef = wtStatus.branch && wtStatus.branch !== "HEAD" ? wtStatus.branch : await ensureWorktreeChangesCommitted(targetWt, commitMessage);
    await ensureWorktreeChangesCommitted(targetWt, commitMessage);

    try {
      await runGit(["merge", "--squash", branchRef], { cwd: mainRoot });
      const postMergeStatus = await getRepoStatus(mainRoot);
      if (postMergeStatus.stagedCount > 0) {
        await runGit(
          [
            "-c",
            "user.name=AgentTower",
            "-c",
            "user.email=tower@local",
            "commit",
            "-m",
            commitMessage || `feat(orchestrator): squash merge ${branchRef}`,
          ],
          { cwd: mainRoot }
        );
      }
    } catch (err) {
      await runGit(["reset", "--merge"], { cwd: mainRoot }).catch(() => {});
      throw new Error(`Squash 合并存在冲突已自动回滚：${err.message}`);
    }
  } else if (normStrategy === "merge_noff" || normStrategy === "merge") {
    const wtStatus = await getRepoStatus(targetWt);
    await ensureWorktreeChangesCommitted(targetWt, commitMessage);
    const refToMerge = wtStatus.branch && wtStatus.branch !== "HEAD" ? wtStatus.branch : (await getRepoStatus(targetWt)).headSha;

    try {
      await runGit(
        [
          "-c",
          "user.name=AgentTower",
          "-c",
          "user.email=tower@local",
          "merge",
          "--no-ff",
          "-m",
          commitMessage || `Merge worktree branch ${refToMerge}`,
          refToMerge,
        ],
        { cwd: mainRoot }
      );
    } catch (err) {
      await runGit(["merge", "--abort"], { cwd: mainRoot }).catch(() => {});
      throw new Error(`Merge --no-ff 冲突已自动中止回滚：${err.message}`);
    }
  } else if (normStrategy === "cherry_pick") {
    await ensureWorktreeChangesCommitted(targetWt, commitMessage);
    const wtStatus = await getRepoStatus(targetWt);
    const mbRes = await runGit(["merge-base", "HEAD", wtStatus.headSha], { cwd: mainRoot });
    const mb = mbRes.stdout.trim();
    const revListRes = await runGit(["rev-list", "--reverse", `${mb}..${wtStatus.headSha}`], { cwd: mainRoot });
    const commits = revListRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    if (commits.length > 0) {
      try {
        await runGit(
          [
            "-c",
            "user.name=AgentTower",
            "-c",
            "user.email=tower@local",
            "cherry-pick",
            ...commits,
          ],
          { cwd: mainRoot }
        );
      } catch (err) {
        await runGit(["cherry-pick", "--abort"], { cwd: mainRoot }).catch(() => {});
        throw new Error(`Cherry-pick 冲突已自动中止回滚：${err.message}`);
      }
    }
  } else {
    throw new Error(`不支持的 Worktree 合并策略: "${strategy}"`);
  }

  const { cleanupResult, cleanupError } = cleanupAfter
    ? await cleanupAfterIntegration({ worktreePath: targetWt, repoRoot: mainRoot, force: forceCleanup === true, deleteBranch })
    : { cleanupResult: null };

  return {
    integrated: true,
    strategy: normStrategy,
    repoRoot: mainRoot,
    worktreePath: targetWt,
    branch: diffInfo.branch,
    filesChanged: diffInfo.changedFilesCount,
    additions: diffInfo.additions,
    deletions: diffInfo.deletions,
    cleanedUp: Boolean(cleanupResult?.cleaned),
    ...(cleanupError ? { cleanupError } : {}),
  };
}

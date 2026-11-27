import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { ensureStorageIgnoreRules, inspectProjectRoot, restricted } from "../storage-paths.mjs";
import { specLedgerForThread } from "../db.mjs";
import {
  assembleSpecPrompt, collectWorkspaceFiles, hasActiveProjectSpecs, inspectSpecPath, materializeProjectSpecs, projectSpecStatus, readPlanDocument,
  normalizeSpecQuotaLimits, normalizeSpecRole, parseFrontmatter, readSpecFile, resolveSpecTestExists, ROLE_SYSTEM_PREFIXES,
  readOnlyGit, readProjectSpecs, resolveEvolutionIndexPath, resolveRoadmapDocPath, syncProjectSpecScaffold,
} from "../spec-context.mjs";
import { buildDynamicPrompt, isThreadBusyStatus, makeId, normalizeProjectPath, projectPathKey, VERSION } from "./helpers.mjs";

const toolEvents = new Set(["tool_call", "command_execution", "file_change"]);
const textEvents = new Set(["message_delta", "assistant_message", "reasoning", "reasoning_delta"]);
const confirmsConsumption = event => toolEvents.has(event.type) ||
  (textEvents.has(event.type) && Boolean(event.text || event.delta || event.reasoningText));

const SPEC_ROOT = ".agent-tower/spec";
const ALLOWED_PROJECT_SPEC_ROLES = new Set([
  "advisor", "design", "research", "executor", "implementation", "test", "review", "reviewer", "general",
]);
const curationError = (code, message) => Object.assign(new Error(message), { code });
const sha256 = data => data === null ? null : createHash("sha256").update(data).digest("hex");
function lfSha256(data) {
  if (data === null) return null;
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!buf.includes(0x0d)) return sha256(buf);
  const out = Buffer.allocUnsafe(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out[j++] = buf[i];
  }
  return sha256(out.subarray(0, j));
}
const isCuratorRole = role => normalizeSpecRole(role) === "curator";
const settlingActions = new Set(["confirm", "revise", "dismiss"]);
const curatorActions = new Set(["status", "setEnabled", "archive", "restore", "setAuto", "setLimits", "trigger", ...settlingActions]);
const ARCHIVE_ROOT = ".agent-tower/spec-archive";
const archiveEntries = ["01-business", "02-coding", "INDEX.md"];

function archiveTree(root, names, { strict = false } = {}) {
  const files = new Map();
  const lfFiles = new Map();
  const directories = [];
  const stat = inspectSpecPath(root);
  if (!stat) return { files, lfFiles, directories, exists: false };
  if (!stat.isDirectory()) throw new Error("规范目录必须是普通目录");
  if (strict && fs.readdirSync(root).some(name => !names.includes(name) && name !== "manifest.json")) {
    throw new Error("归档含清单之外的路径");
  }
  function visit(rel, expected) {
    const file = path.join(root, rel);
    const entry = inspectSpecPath(file);
    if (!entry) return;
    if (entry.isDirectory() && expected !== "file") {
      directories.push(rel);
      for (const name of fs.readdirSync(file).sort()) {
        if (/[\\:\x00-\x1f]/.test(name)) throw new Error(`不安全的归档路径：${rel}/${name}`);
        visit(`${rel}/${name}`);
      }
    } else if (entry.isFile() && expected !== "directory") {
      const content = readSpecFile(file, null);
      if (content === null) throw new Error(`规范文件已变化：${rel}`);
      files.set(rel, sha256(content));
      lfFiles.set(rel, lfSha256(content));
    } else throw new Error(`不安全的归档路径：${rel}`);
  }
  for (const name of names) visit(name, name === "INDEX.md" ? "file" : "directory");
  return { files, lfFiles, directories, exists: true };
}

function archiveConflicts(active, tree) {
  const activeStat = inspectSpecPath(active);
  if (activeStat && !activeStat.isDirectory()) return [SPEC_ROOT];
  const folders = new Set(tree.directories);
  const conflicts = new Set();
  for (const rel of [...tree.directories, ...tree.files.keys()]) {
    if ([...conflicts].some(parent => rel.startsWith(parent + "/"))) continue;
    const stat = inspectSpecPath(path.join(active, rel));
    if (stat && (!stat.isDirectory() || !folders.has(rel))) conflicts.add(rel);
  }
  return [...conflicts];
}

function readArchive(root) {
  const tree = archiveTree(root, archiveEntries, { strict: true });
  if (!tree.exists) return tree;
  const manifestText = readSpecFile(path.join(root, "manifest.json"));
  const manifest = manifestText && JSON.parse(manifestText);
  const matchesHash = entry => {
    if (!/^[a-f0-9]{64}$/.test(entry?.sha256)) return false;
    const raw = tree.files.get(entry.path);
    return Boolean(raw) && (raw === entry.sha256 || tree.lfFiles.get(entry.path) === entry.sha256);
  };
  if (manifest?.version !== 1 || !Number.isFinite(manifest.archivedAt) || !Array.isArray(manifest.files) ||
      !tree.files.size || manifest.files.length !== tree.files.size ||
      new Set(manifest.files.map(entry => entry?.path)).size !== tree.files.size ||
      manifest.files.some(entry => !matchesHash(entry))) {
    throw new Error("规范归档清单或 SHA-256 校验失败");
  }
  return { ...tree, manifest, manifestText };
}

function archiveStatus(workspace) {
  const result = { exists: false, fileCount: 0, archivedAt: null, hasActiveSpecs: false, conflictPaths: [] };
  if (!workspace) return result;
  const root = path.join(workspace, ARCHIVE_ROOT);
  try {
    result.exists = Boolean(inspectSpecPath(root));
    result.hasActiveSpecs = hasActiveProjectSpecs(workspace);
    if (!result.exists) return result;
    const tree = readArchive(root);
    result.fileCount = tree.files.size;
    result.archivedAt = tree.manifest.archivedAt;
    result.conflictPaths = archiveConflicts(path.join(workspace, SPEC_ROOT), tree);
  } catch { /* A corrupt or linked archive can only be reported, never followed. */ }
  return result;
}

const retryWord = new Int32Array(new SharedArrayBuffer(4));
function archiveFs(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(); }
    catch (error) {
      if (!["EBUSY", "EPERM"].includes(error.code)) throw error;
      if (attempt === 3) throw curationError("SPEC_ARCHIVE_BUSY", "规范文件被占用，请关闭相关程序后重试");
      Atomics.wait(retryWord, 0, 0, 20 * (attempt + 1));
    }
  }
}

function archiveTransaction(operation) {
  const undo = [];
  const apply = (step, reverse, opts = {}) => {
    archiveFs(step);
    undo.push({ reverse, ...opts });
  };
  try { operation(apply); }
  catch (error) {
    const rollbackErrors = [];
    const preserved = new Set();
    for (const entry of undo.reverse()) {
      if (entry.skipIfPreserved && preserved.has(entry.skipIfPreserved)) continue;
      if (entry.skipIfAnyPreserved && preserved.size > 0) continue;
      try { archiveFs(entry.reverse); }
      catch (rollbackError) {
        rollbackErrors.push(rollbackError.message);
        if (entry.preserveOnFail) preserved.add(entry.preserveOnFail);
      }
    }
    if (rollbackErrors.length) error.details = { ...error.details, rollbackErrors };
    throw error;
  }
}

function makeArchiveDir(dir, apply) {
  const stat = inspectSpecPath(dir);
  if (stat?.isDirectory()) return;
  if (stat) throw curationError("SPEC_RESTORE_CONFLICT", `恢复路径已存在：${dir}`);
  apply(() => fs.mkdirSync(dir), () => fs.rmdirSync(dir), { skipIfAnyPreserved: true });
}

function removeEmptyArchiveDir(dir, apply) {
  if (inspectSpecPath(dir)?.isDirectory() && fs.readdirSync(dir).length === 0) {
    apply(() => fs.rmdirSync(dir), () => fs.mkdirSync(dir));
  }
}

// Phase 1: publish all destination directories and hard links without touching source files.
function stageArchiveFiles(source, destination, tree, apply) {
  makeArchiveDir(destination, apply);
  for (const rel of tree.directories) makeArchiveDir(path.join(destination, rel), apply);
  for (const [rel, hash] of tree.files) {
    const previous = path.join(source, rel);
    const next = path.join(destination, rel);
    if (sha256(readSpecFile(previous, null)) !== hash || !inspectSpecPath(path.dirname(next))?.isDirectory()) {
      throw curationError("SPEC_ARCHIVE_CORRUPTED", `规范文件已变化：${rel}`);
    }
    // A hard link publishes the same bytes without replacing a destination written concurrently.
    try { apply(() => fs.linkSync(previous, next), () => fs.unlinkSync(next), { skipIfPreserved: rel }); }
    catch (error) {
      if (error.code === "EEXIST") throw curationError("SPEC_RESTORE_CONFLICT", `恢复路径已存在：${rel}`);
      throw error;
    }
  }
}

// Phase 2: once destination is 100% complete on disk, unlink source files and prune empty source directories.
function finalizeArchiveRemoval(source, destination, tree, apply) {
  for (const rel of tree.files.keys()) {
    const previous = path.join(source, rel);
    const next = path.join(destination, rel);
    apply(() => fs.unlinkSync(previous), () => fs.linkSync(next, previous), { preserveOnFail: rel });
  }
  for (const rel of [...tree.directories].reverse()) removeEmptyArchiveDir(path.join(source, rel), apply);
}

function snapshotSpecTree(workspace) {
  const snapshot = [];
  function visit(file, rel) {
    const stat = inspectSpecPath(file);
    if (!stat) return;
    if (stat.isDirectory()) {
      snapshot.push([rel, "directory", stat.mtimeMs, stat.ctimeMs]);
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), `${rel}/${name}`);
    } else {
      if (!stat.isFile()) throw new Error(`规范路径不是普通文件：${rel}`);
      snapshot.push([rel, sha256(readSpecFile(file, null)), stat.mtimeMs, stat.ctimeMs]);
    }
  }
  visit(path.join(workspace, SPEC_ROOT), SPEC_ROOT);
  return JSON.stringify(snapshot);
}

function safeSpecTarget(workspace, rel) {
  const match = /^\.agent-tower\/spec\/(01-business|02-coding)\/(.+\.md)$/.exec(rel);
  const parts = match ? match[2].split("/") : [];
  if (!match || /^index\.md$/i.test(parts.at(-1)) || parts.some(part => !part || part.startsWith(".") ||
    /[<>:"\\|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
    /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
    throw new Error("路径必须位于 01-business 或 02-coding，且为安全的 Markdown 文件");
  }
  const file = path.join(workspace, rel);
  const stat = inspectSpecPath(file);
  if (stat && !stat.isFile()) throw new Error("目标必须是普通文件");
  return { file, kind: match[1] === "01-business" ? "business" : "coding" };
}

function diffPreview(rel, previous, next) {
  const lines = text => text == null ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const before = lines(previous), after = lines(next);
  let start = 0, end = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  while (start + end < before.length && start + end < after.length &&
      before.at(-1 - end) === after.at(-1 - end)) end++;
  const removed = before.slice(start, before.length - end);
  const added = after.slice(start, after.length - end);
  return [`--- ${previous === null ? "/dev/null" : `a/${rel}`}`, `+++ ${next === null ? "/dev/null" : `b/${rel}`}`,
    `@@ -${start + Number(removed.length > 0)},${removed.length} +${start + Number(added.length > 0)},${added.length} @@`,
    ...removed.map(line => `-${line}`), ...added.map(line => `+${line}`)].join("\n");
}

function readGitHead(workspace) {
  try {
    const out = (readOnlyGit(workspace, ["rev-parse", "--verify", "HEAD"]) || "").trim();
    return /^[0-9a-f]{7,40}$/i.test(out) ? out : "";
  } catch { return ""; }
}

function validateChange(workspace, raw, seen, repoFiles, limits = normalizeSpecQuotaLimits()) {
  const draftText = key => typeof raw?.[key] === "string" ? raw[key] : "";
  const action = draftText("action"), rel = draftText("path");
  const content = action === "delete" ? null : draftText("content");
  const issues = [];
  let oldContent = null, baseSha256 = null, bodyBytes = 0, oldBodyBytes = 0, title = "", specKey = "", preview = "";
  try {
    if (!["create", "update", "delete"].includes(action)) throw new Error("未知变更动作");
    const { file, kind } = safeSpecTarget(workspace, rel);
    const key = projectPathKey(file);
    if (seen.has(key)) throw new Error("变更集中存在重复路径");
    seen.add(key);
    const expectedId = path.posix.basename(rel, ".md");
    const baseline = readSpecFile(file, null);
    oldContent = baseline?.toString("utf8") ?? null;
    oldBodyBytes = oldContent !== null ? Buffer.byteLength(parseFrontmatter(oldContent).body) : 0;
    baseSha256 = sha256(baseline);
    if ((action === "create") !== (baseline === null)) issues.push("目标文件存在状态与变更动作不符");
    if (!draftText("why").trim()) issues.push("缺少变更原因 why");
    if (content !== null) {
      const { fields, body, error } = parseFrontmatter(content);
      title = fields.title || "";
      specKey = fields.id ? `${kind}/${fields.id}` : "";
      const header = /^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?^---[ \t]*(?:\r?\n|$)/m.exec(content);
      bodyBytes = Buffer.byteLength(body);
      if (error || header?.index !== 0 || !fields.id || !fields.title || (fields.kind && fields.kind !== kind)) {
        issues.push(`Frontmatter 无效${error ? `：${error}` : "，需填写 id、title 并匹配目录分类"}`);
      } else if (fields.id !== expectedId) {
        issues.push(`Frontmatter id 必须与文件名一致（应为 ${expectedId}）`);
      }
      if (action === "update" && oldBodyBytes > limits.singleMaxBytes) {
        if (bodyBytes >= oldBodyBytes) issues.push(`存量超限规范修改后必须净缩减字节（目标 <= ${limits.singleMaxBytes} B）`);
      } else if (bodyBytes > limits.singleMaxBytes) {
        issues.push(`正文超过 ${limits.singleMaxBytes} B`);
      }
      if (action === "update" && oldBodyBytes >= limits.highWaterBytes && bodyBytes > oldBodyBytes && !draftText("mergedOrRemoved").trim()) {
        issues.push("高水位规范净增长必须填写 mergedOrRemoved 说明置换依据");
      }
      for (const roleItem of fields.roles || []) {
        const normRole = String(roleItem || "").trim().toLowerCase();
        if (!ALLOWED_PROJECT_SPEC_ROLES.has(normRole)) {
          issues.push(normRole === "curator" ? "项目规范 roles 不得包含 curator" : `未知的 roles 角色: ${roleItem}`);
        }
      }
      for (const entry of fields.tests || []) {
        if (!resolveSpecTestExists(workspace, entry, repoFiles)) issues.push(`不存在的 tests: ${entry}`);
      }
    } else {
      title = oldContent ? parseFrontmatter(oldContent).fields.title || "" : "";
      if (!draftText("mergedOrRemoved").trim()) issues.push("删除规范必须填写 mergedOrRemoved 说明替代或退役依据");
    }
    preview = diffPreview(rel, oldContent, content);
  } catch (error) { issues.push(error.message); }
  return { action, path: rel, specKey, title: title || path.posix.basename(rel), why: draftText("why"),
    changeSummary: draftText("changeSummary"), mergedOrRemoved: draftText("mergedOrRemoved"),
    impactAndTests: draftText("impactAndTests"), content, oldContent, diffPreview: preview, bodyBytes, baseSha256,
    preflightOk: issues.length === 0, preflightIssues: issues };
}

function preflight(workspace, changes, rawLimits) {
  const limits = normalizeSpecQuotaLimits(rawLimits);
  const seen = new Set();
  const repoFiles = collectWorkspaceFiles(workspace).files;
  const rawChecked = changes.map(change => validateChange(workspace, change, seen, repoFiles, limits));
  for (let i = 0; i < rawChecked.length; i++) {
    const change = rawChecked[i];
    if (change.preflightOk && rawChecked.some((other, j) => i !== j &&
      projectPathKey(path.join(workspace, other.path)).startsWith(projectPathKey(path.join(workspace, change.path)) + "/"))) {
      change.preflightOk = false;
      change.preflightIssues.push("目标文件不能同时作为其他变更的父目录");
    }
  }
  const existing = readProjectSpecs(workspace).specs.filter(spec => spec.kind === "business" || spec.kind === "coding");
  const beforeTotal = existing.reduce((sum, spec) => sum + spec.bytes, 0);
  const simulated = new Map(existing.map(spec => [projectPathKey(path.join(workspace, spec.relPath)), { key: spec.key, bytes: spec.bytes }]));
  for (const change of rawChecked) {
    const pKey = projectPathKey(path.join(workspace, change.path));
    if (change.action === "delete") simulated.delete(pKey);
    else if (change.specKey) simulated.set(pKey, { key: change.specKey, bytes: change.bodyBytes });
  }
  const keyCounts = new Map();
  let afterTotal = 0;
  for (const { key, bytes } of simulated.values()) {
    keyCounts.set(key, (keyCounts.get(key) || 0) + 1);
    afterTotal += bytes;
  }
  for (const change of rawChecked) {
    if (change.specKey && (keyCounts.get(change.specKey) || 0) > 1) {
      change.preflightOk = false;
      change.preflightIssues.push(`变更后存在重复规范 ID: ${change.specKey}`);
    }
    if (change.action !== "delete" && afterTotal > limits.totalMaxBytes && afterTotal > beforeTotal) {
      change.preflightOk = false;
      change.preflightIssues.push(`整组变更后项目规范总正文 ${afterTotal} B 超过 ${limits.totalMaxBytes} B 上限`);
    }
  }
  return rawChecked.map(({ specKey, ...rest }) => rest);
}

function parseProposal(rawText) {
  const pattern = /^ {0,3}```agent-tower-spec-proposal[ \t]*\r?\n([\s\S]*?)^ {0,3}```[ \t]*$/gm;
  const blocks = [...rawText.matchAll(pattern)];
  if (blocks.length !== 1 || rawText.slice(blocks[0].index + blocks[0][0].length).trim()) {
    throw new Error("回复末尾需要恰好一个 agent-tower-spec-proposal 代码块");
  }
  const draft = JSON.parse(blocks[0][1]);
  if (draft?.status === "no_change" && typeof draft.reason === "string") return draft;
  if (draft?.status !== "propose" || typeof draft.summary !== "string" || !draft.summary.trim() ||
      !Array.isArray(draft.changes) || !draft.changes.length) throw new Error("提案状态、摘要或变更列表无效");
  return draft;
}

export function createSpecsModule(ctx) {
  const scaffoldSignatures = new Map();
  const activeCurators = new Map();
  const autoTimers = new Map();
  const inFlightAutoWaterlines = new Map();
  const failedAutoWaterlines = new Map();
  const hostSettlement = new Map();
  const revisions = new Set();

  function cleanExcerpt(text, maxChars = 220) {
    const clean = String(text || "")
      .replace(/<(?:SYSTEM_MESSAGE|agent_tower_[\w-]+|ADDITIONAL_METADATA)[\s\S]*?<\/(?:SYSTEM_MESSAGE|agent_tower_[\w-]+|ADDITIONAL_METADATA)>/gi, "")
      .replace(/<\/?[A-Z_]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
  }

  function projectSpecLimits(workspace) {
    const normWs = normalizeProjectPath(workspace);
    const entry = normWs ? ctx.db.getProjectSpec(normWs) : null;
    return normalizeSpecQuotaLimits(entry);
  }

  function buildCuratorSessionContext(workspace, rootConversationId) {
    const blocks = [];
    if (!workspace || !ctx.db.inspectProjectDb?.(workspace)) return "";
    const state = ctx.db.readSpecCuration(workspace);
    if (state.pendingProposal?.changes?.length) {
      const brief = state.pendingProposal.changes.slice(0, 5).map(c => `${c.action}:${c.path}`).join(", ");
      blocks.push(`[当前挂起待确认提案]\n摘要：${cleanExcerpt(state.pendingProposal.summary, 140)}（${brief}）。若本轮有新增规则请将其与未过期内容合并输出完整提案；若无新增直接输出 no_change（系统会自动保留既有待确认提案）。`);
    }
    if (!rootConversationId) return blocks.join("\n\n");
    const hostThread = ctx.hostSync.findThreadByHostConversationId(rootConversationId) ||
      ctx.db.getConversationThread(rootConversationId);
    if (hostThread) {
      const userLines = ctx.db.listTurnItems({ threadId: hostThread.id })
        .filter(item => (item.type === "user_message" || item.type === "user") && item.text)
        .slice(-4)
        .map(item => cleanExcerpt(item.text, 220))
        .filter(Boolean);
      if (userLines.length) {
        blocks.push(`[本会话用户原话摘录（01-business 立规唯一权威依据）]\n${userLines.map((line, i) => `${i + 1}. ${line}`).join("\n")}`);
      }
    }
    const childThreads = ctx.db.listThreads({ workspace, includeSubagents: true, includeQueue: false, limit: 60 })
      .filter(t => !t.isNativeHost && !isCuratorRole(t.role) &&
        ctx.scopePolicy.threadPolicyRoot(t).toLowerCase() === rootConversationId.toLowerCase());
    const runLines = childThreads
      .flatMap(t => ctx.db.listRuns({ threadId: t.id }).filter(r => r.status === "completed"))
      .sort((a, b) => (b.completedAt || b.updatedAt || 0) - (a.completedAt || a.updatedAt || 0))
      .slice(0, 4)
      .map(r => `- [${r.role || "work"}] ${cleanExcerpt(r.meta?.title || r.prompt, 80)} => ${cleanExcerpt(r.assistantText, 120)}`)
      .filter(Boolean);
    if (runLines.length) {
      blocks.push(`[本会话近期完结子任务摘要（仅供参考，不得替代用户原话脑补 01-business）]\n${runLines.join("\n")}`);
    }
    return blocks.join("\n\n");
  }

  function curationStatus(workspace) {
    workspace = normalizeProjectPath(workspace);
    const key = projectPathKey(workspace);
    const { enabled, autoTrigger, singleMaxKb, totalMaxKb } = ctx.db.getProjectSpec(workspace);
    const state = workspace ? ctx.db.readSpecCuration(workspace) : {};
    const active = activeCurators.get(key);
    return {
      workspace: workspace || null,
      specEnabled: Boolean(workspace && enabled), autoTrigger, singleMaxKb, totalMaxKb,
      archive: archiveStatus(workspace),
      running: Boolean(active), activeThreadId: active?.threadId ?? null, activeRunId: active?.runId ?? null,
      lastNoChange: state.lastNoChange ?? null, pendingProposal: state.pendingProposal ?? null,
      recentProposals: state.proposals ?? [],
    };
  }

  function publish(workspace) {
    const curation = curationStatus(workspace);
    ctx.context.emitEvent({ type: "spec_curation_updated", workspace: curation.workspace, curation });
    return curation;
  }

  function assertSpecEnabled(workspace) {
    if (!ctx.db.isProjectSpecEnabled(workspace)) throw curationError("SPEC_DISABLED_FOR_PROJECT", "当前项目已停用项目规范");
  }

  function assertNoRunningCurator(workspace, runId) {
    const key = projectPathKey(workspace);
    const active = activeCurators.get(key);
    if ((revisions.has(key) && !runId) || (active && active.runId !== runId)) {
      throw curationError("CURATOR_ALREADY_RUNNING", "当前项目已有维护官在运行");
    }
  }

  function assertCuratorAvailable(workspace, runId) {
    assertSpecEnabled(workspace);
    const active = activeCurators.get(projectPathKey(workspace));
    if (active && active.runId !== runId) throw curationError("CURATOR_ALREADY_RUNNING", "当前项目已有维护官在运行");
  }

  function isCuratorThread(thread, run) {
    const presets = ctx.db.getProjectRoster(thread && threadWorkspace(thread)).presets;
    return isCuratorRole(thread?.role) || isCuratorRole(run?.role) ||
      [thread?.presetKey, run?.meta?.nextPresetKey, run?.meta?.requestedPresetKey].some(key => presets?.[key]?.group === "curator");
  }

  function startCurator(thread, run) {
    const workspace = normalizeProjectPath(thread.meta?.projectRoot || thread.workspace || thread.cwd);
    assertCuratorAvailable(workspace, run.id);
    const key = projectPathKey(workspace);
    const rootConversationId = ctx.scopePolicy.threadPolicyRoot(thread) || null;
    activeCurators.set(key, { threadId: thread.id, runId: run.id });
    publish(workspace, rootConversationId);
    let before;
    return {
      snapshot() { before = snapshotSpecTree(workspace); },
      check() {
        if (before === undefined || !ctx.db.isProjectSpecEnabled(workspace)) return;
        try { if (before === snapshotSpecTree(workspace)) return; } catch {}
        return curationError("CURATOR_SPEC_WRITE_DETECTED", "运行期间项目规范发生变化，维护官输出已作废");
      },
      finish(result, rawText) {
        const autoKey = rootConversationId ? conversationKey(rootConversationId, workspace) : "";
        const pendingWaterline = autoKey ? inFlightAutoWaterlines.get(autoKey) : null;
        if (autoKey) inFlightAutoWaterlines.delete(autoKey);
        if (activeCurators.get(key)?.runId !== run.id) return;
        activeCurators.delete(key);
        try {
          if (result.status !== "completed" || before === undefined || !ctx.db.isProjectSpecEnabled(workspace)) {
            if (pendingWaterline && autoKey) failedAutoWaterlines.set(autoKey, `${pendingWaterline.completedAt}:${pendingWaterline.id}`);
            return;
          }
          const now = Date.now();
          const triggerSource = run.meta?.triggerSource || thread.meta?.triggerSource || "delegate";
          const record = { id: makeId("sprop"), workspace, rootConversationId, threadId: thread.id, runId: run.id,
            triggerSource, status: "invalid", summary: "", changes: [], preflightOk: false, parseError: null,
            rawText, createdAt: now, updatedAt: now, resolvedAt: null };
          const commitAutoWaterline = withHead => {
            const statePatch = {};
            if (withHead) {
              const head = readGitHead(workspace);
              if (head) statePatch.curatedHead = head;
            }
            if (pendingWaterline && rootConversationId) {
              const prev = ctx.db.readSpecCuration(workspace).autoWaterlines || {};
              statePatch.autoWaterlines = { ...prev, [rootConversationId.toLowerCase()]: pendingWaterline };
              if (autoKey) failedAutoWaterlines.delete(autoKey);
            }
            return statePatch;
          };
          try {
            const draft = parseProposal(rawText);
            if (draft.status === "no_change") {
              ctx.db.patchSpecCurationState(workspace, {
                ...commitAutoWaterline(true),
                lastNoChange: { threadId: thread.id, runId: run.id, rootConversationId, triggerSource, reason: draft.reason, completedAt: now },
              });
              return;
            }
            record.summary = draft.summary;
            record.changes = preflight(workspace, draft.changes, projectSpecLimits(workspace));
            record.preflightOk = record.changes.every(change => change.preflightOk);
            if (record.preflightOk) record.status = "pending";
            const extraState = commitAutoWaterline(record.preflightOk);
            if (Object.keys(extraState).length) ctx.db.patchSpecCurationState(workspace, extraState);
          } catch (error) {
            record.parseError = error.message;
            if (pendingWaterline && autoKey) failedAutoWaterlines.set(autoKey, `${pendingWaterline.completedAt}:${pendingWaterline.id}`);
          }
          ctx.db.putSpecProposal(workspace, record);
        } finally { publish(workspace, rootConversationId); }
      },
    };
  }

  function writeProposal(workspace, proposal, applied) {
    const staged = [];
    const committed = [];
    const createdDirs = [];
    const scaffoldPaths = [".gitignore", ".agent-tower/.gitignore", `${SPEC_ROOT}/INDEX.md`,
      `${SPEC_ROOT}/00-plugin/README.md`, ...Object.keys(ROLE_SYSTEM_PREFIXES).map(role => `${SPEC_ROOT}/00-plugin/${role}.md`)];
    const scaffold = scaffoldPaths.map(rel => {
      const file = path.join(workspace, rel);
      const old = readSpecFile(file, null);
      if (old === null && inspectSpecPath(file)) throw new Error(`不是普通文件：${rel}`);
      return { file, old };
    });
    const knownDirs = [SPEC_ROOT, `${SPEC_ROOT}/01-business`, `${SPEC_ROOT}/02-coding`, `${SPEC_ROOT}/00-plugin`]
      .map(rel => path.join(workspace, rel)).filter(dir => !inspectSpecPath(dir));
    let refreshing = false, appliedSuccessfully = false;
    function ensureParent(dir) {
      const stat = inspectSpecPath(dir);
      if (stat?.isDirectory()) return;
      if (stat) throw new Error(`不是目录：${dir}`);
      ensureParent(path.dirname(dir));
      fs.mkdirSync(dir);
      createdDirs.push(dir);
    }
    function assertBaseline(entry) {
      if (sha256(readSpecFile(entry.file, null)) !== entry.baseline ||
        (entry.baseline === null && inspectSpecPath(entry.file))) {
        throw curationError("SPEC_PROPOSAL_CONFLICT", `文件已变化：${entry.rel}`);
      }
    }
    try {
      for (const change of proposal.changes) {
        const { file } = safeSpecTarget(workspace, change.path);
        const old = readSpecFile(file, null);
        const entry = { file, rel: change.path, old, baseline: change.baseSha256, content: change.content };
        assertBaseline(entry);
        ensureParent(path.dirname(file));
        if (change.content !== null) {
          const tmp = path.join(path.dirname(file), `.spec-${randomUUID()}.tmp`);
          const fd = fs.openSync(tmp, "wx");
          entry.tmp = tmp;
          staged.push(entry);
          try { fs.writeFileSync(fd, change.content); } finally { fs.closeSync(fd); }
        } else staged.push(entry);
      }
      for (const entry of staged) assertBaseline(entry);
      for (const entry of staged) {
        assertBaseline(entry);
        if (entry.tmp) {
          if (entry.baseline === null) {
            try { fs.linkSync(entry.tmp, entry.file); }
            catch (linkErr) {
              if (linkErr.code === "EEXIST") throw linkErr;
              fs.writeFileSync(entry.file, entry.content, { flag: "wx" });
            }
          } else fs.renameSync(entry.tmp, entry.file);
        } else fs.unlinkSync(entry.file);
        committed.push(entry);
      }
      refreshing = true;
      syncProjectSpecScaffold(workspace, VERSION);
      ctx.db.putSpecProposal(workspace, applied);
      const head = readGitHead(workspace);
      if (head) ctx.db.patchSpecCurationState(workspace, { curatedHead: head });
      appliedSuccessfully = true;
    } catch (error) {
      const rollbackErrors = [];
      const restore = ({ file, old }) => {
        try {
          const current = readSpecFile(file, null);
          if (sha256(current) === sha256(old)) return;
          if (old === null) { fs.unlinkSync(file); return; }
          const temp = path.join(path.dirname(file), `.spec-${randomUUID()}.tmp`);
          try { fs.writeFileSync(temp, old, { flag: "wx" }); fs.renameSync(temp, file); }
          finally { if (inspectSpecPath(temp)?.isFile()) fs.unlinkSync(temp); }
        } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      };
      if (refreshing) for (const entry of scaffold.reverse()) restore(entry);
      for (const entry of committed.reverse()) restore(entry);
      if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "规范写入失败且回滚不完整");
      if (error.code === "EEXIST") throw curationError("SPEC_PROPOSAL_CONFLICT", "文件已由其他进程创建");
      throw error;
    } finally {
      for (const { tmp } of staged) if (tmp && inspectSpecPath(tmp)?.isFile()) fs.unlinkSync(tmp);
      if (!appliedSuccessfully) {
        for (const dir of new Set([...createdDirs, ...knownDirs].sort((a, b) => b.length - a.length))) {
          if (inspectSpecPath(dir)?.isDirectory() && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
        }
      }
    }
  }


  function stopProjectAutoCuration(workspace) {
    const prefix = projectPathKey(workspace) + "\0";
    for (const [key, timer] of autoTimers) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      autoTimers.delete(key);
    }
  }

  async function setSpecEnabled(workspace, enabled) {
    ctx.db.setProjectSpecEnabled(workspace, enabled);
    if (enabled) return;
    stopProjectAutoCuration(workspace);
    const key = projectPathKey(workspace);
    const threadIds = new Set([...ctx.activeRunByThread.keys(), ...ctx.pendingTurnStartLocks,
      ...ctx.db.listThreadsWithQueuedRuns(), activeCurators.get(key)?.threadId].filter(Boolean));
    const threads = [...threadIds].map(id => ctx.db.getThread(id, { includeQueue: false }))
      .filter(thread => thread && projectPathKey(threadWorkspace(thread)) === key &&
        isCuratorThread(thread, ctx.db.getRun(ctx.activeRunByThread.get(thread.id))));
    const results = await Promise.allSettled(threads.map(thread => ctx.cancellation.stopThreadExecution(thread)));
    const rejected = results.find(result => result.status === "rejected");
    if (rejected) {
      publish(workspace);
      throw rejected.reason;
    }
  }

  function changeArchive(workspace, action, enableAfterRestore) {
    assertNoRunningCurator(workspace);
    if (ctx.db.readSpecCuration(workspace).pendingProposal) {
      throw curationError("SPEC_ARCHIVE_PENDING_PROPOSAL", "请先处理待确认的规范提案");
    }
    const active = path.join(workspace, SPEC_ROOT);
    const archive = path.join(workspace, ARCHIVE_ROOT);
    const mirror = path.join(active, "00-plugin");
    if (action === "archive") {
      if (inspectSpecPath(archive)) throw curationError("SPEC_ARCHIVE_ALREADY_EXISTS", "项目已有规范归档");
      const tree = archiveTree(active, archiveEntries);
      if (!tree.files.size || !hasActiveProjectSpecs(workspace)) throw curationError("SPEC_ARCHIVE_EMPTY", "项目没有可归档的规范");
      const mirrorTree = archiveTree(active, ["00-plugin"]);
      const manifest = { version: 1, archivedAt: Date.now(),
        files: [...tree.files].map(([rel, hash]) => ({ path: rel, sha256: hash })) };
      ensureStorageIgnoreRules(workspace, { ensureRoot: true });
      archiveTransaction(apply => {
        // Phase 1: reserve archive root, hardlink all files and write manifest.json before touching source.
        apply(() => fs.mkdirSync(archive), () => fs.rmdirSync(archive), { skipIfAnyPreserved: true });
        stageArchiveFiles(active, archive, tree, apply);
        const manifestFile = path.join(archive, "manifest.json");
        apply(() => fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" }),
          () => fs.unlinkSync(manifestFile), { skipIfAnyPreserved: true });
        const mirrorContents = new Map();
        for (const rel of mirrorTree.files.keys()) {
          const file = path.join(active, rel);
          const content = readSpecFile(file, null);
          if (sha256(content) !== mirrorTree.files.get(rel)) throw new Error(`插件规范镜像已变化：${rel}`);
          mirrorContents.set(file, content);
        }
        // Phase 2: destination archive is complete on disk; unlink source files, mirror and empty directories.
        finalizeArchiveRemoval(active, archive, tree, apply);
        for (const [file, content] of mirrorContents) {
          apply(() => fs.unlinkSync(file), () => fs.writeFileSync(file, content, { flag: "wx" }));
        }
        for (const rel of [...mirrorTree.directories].reverse()) removeEmptyArchiveDir(path.join(active, rel), apply);
        removeEmptyArchiveDir(active, apply);
        ctx.db.setProjectSpecEnabled(workspace, false);
      });
      return {};
    }
    let tree;
    try { tree = readArchive(archive); }
    catch (error) {
      throw curationError("SPEC_ARCHIVE_CORRUPTED", error.message);
    }
    if (!tree.exists) throw curationError("SPEC_ARCHIVE_NOT_FOUND", "项目没有规范归档");
    const conflicts = archiveConflicts(active, tree);
    if (conflicts.length) {
      throw Object.assign(curationError("SPEC_RESTORE_CONFLICT", `恢复路径已存在：${conflicts.join("、")}`), { details: { conflictPaths: conflicts } });
    }
    // Validate existing scaffold paths before moving files into the active tree.
    archiveTree(active, archiveEntries);
    if (inspectSpecPath(mirror)) archiveTree(active, ["00-plugin"]);
    const enabled = ctx.db.isProjectSpecEnabled(workspace);
    archiveTransaction(apply => {
      // Phase 1: hardlink all archived files into active tree before removing archive entries.
      stageArchiveFiles(archive, active, tree, apply);
      // Phase 2: active tree is complete on disk; unlink archive files, manifest and directory.
      finalizeArchiveRemoval(archive, active, tree, apply);
      const manifestFile = path.join(archive, "manifest.json");
      apply(() => fs.unlinkSync(manifestFile), () => fs.writeFileSync(manifestFile, tree.manifestText, { flag: "wx" }));
      apply(() => fs.rmdirSync(archive), () => fs.mkdirSync(archive));
      if (enableAfterRestore || !enabled) ctx.db.setProjectSpecEnabled(workspace, enableAfterRestore);
    });
    if (ctx.db.isProjectSpecEnabled(workspace)) {
      try { syncProjectSpecScaffold(workspace, VERSION, readProjectSpecs(workspace), { preserveIndex: true }); }
      catch (error) { return { warnings: [{ code: "SPEC_SCAFFOLD_REFRESH_FAILED", message: error.message }] }; }
    }
    return {};
  }

  async function specCuration(params = {}) {
    const { action } = params;
    if (!curatorActions.has(action)) throw curationError("INVALID_SPEC_CURATION_ACTION", "specCuration action 无效");
    const rootConversationId = ctx.scopePolicy.policyRoot(params);
    const boundWorkspace = rootConversationId && ctx.scopePolicy.getBoundPolicyWorkspace(rootConversationId);
    const roots = params.cwd === undefined && params.workspace === undefined && boundWorkspace
      ? { ...params, workspace: boundWorkspace } : params;
    const { repoRoot } = checkoutRoots(roots);
    const workspace = normalizeProjectPath(repoRoot);
    if (action === "status") return { ok: true, workspace, curation: curationStatus(workspace) };
    if (action === "setEnabled") {
      if (typeof params.enabled !== "boolean") throw curationError("INVALID_SPEC_CURATION_ACTION", "specCuration setEnabled 需要布尔值 enabled");
      await setSpecEnabled(workspace, params.enabled);
      const config = ctx.catalogSettings.configPayload(workspace);
      ctx.context.emitEvent({ type: "project_config_updated", scope: "project", workspace, ...config });
      return { ok: true, workspace, curation: publish(workspace) };
    }
    if (action === "archive" || action === "restore") {
      const result = changeArchive(workspace, action, params.enableAfterRestore === true);
      if (action === "archive") stopProjectAutoCuration(workspace);
      ctx.context.emitEvent({ type: "project_config_updated", scope: "project", workspace, ...ctx.catalogSettings.configPayload(workspace) });
      return { ok: true, workspace, ...result, curation: publish(workspace) };
    }
    if (action !== "dismiss") assertSpecEnabled(workspace);
    if (action === "setAuto") {
      if (typeof params.autoTrigger !== "boolean") throw curationError("INVALID_SPEC_CURATION_ACTION", "specCuration setAuto 需要布尔值 autoTrigger");
      ctx.db.setSpecCurationAuto(workspace, params.autoTrigger);
      return { ok: true, workspace, autoTrigger: params.autoTrigger, curation: publish(workspace, rootConversationId) };
    }
    if (action === "setLimits") {
      const singleMaxKb = Number(params.singleMaxKb);
      const totalMaxKb = Number(params.totalMaxKb);
      ctx.db.setSpecCurationLimits(workspace, { singleMaxKb, totalMaxKb });
      const nextLimits = projectSpecLimits(workspace);
      if (ctx.db.inspectProjectDb?.(workspace)) {
        const curState = ctx.db.readSpecCuration(workspace);
        const candidate = curState.pendingProposal || (curState.proposals || []).find(p => p?.status === "invalid" && !p.parseError && p.changes?.length);
        if (candidate?.changes?.length && (candidate.status === "pending" || candidate.status === "invalid")) {
          const rechecked = preflight(workspace, candidate.changes, nextLimits);
          const ok = rechecked.every(c => c.preflightOk);
          ctx.db.putSpecProposal(workspace, {
            ...candidate,
            changes: rechecked,
            preflightOk: ok,
            status: ok ? "pending" : "invalid",
            updatedAt: Date.now(),
          });
        }
      }
      return { ok: true, workspace, singleMaxKb: nextLimits.singleMaxKb, totalMaxKb: nextLimits.totalMaxKb, curation: publish(workspace, rootConversationId) };
    }
    if (action === "trigger") return triggerCurator(workspace, rootConversationId, "manual", params);
    if (action === "revise" && (typeof params.feedback !== "string" || !params.feedback.trim())) {
      throw curationError("CURATOR_FEEDBACK_REQUIRED", "请填写重拟意见");
    }
    const proposal = typeof params.proposalId === "string" && ctx.db.getSpecProposal(workspace, params.proposalId);
    if (!proposal) throw curationError("SPEC_PROPOSAL_NOT_FOUND", "当前项目找不到规范提案");
    if (proposal.status !== "pending" && !(action === "dismiss" && ["invalid", "conflict"].includes(proposal.status)) &&
        !(action === "revise" && ["invalid", "conflict"].includes(proposal.status))) {
      throw curationError("SPEC_PROPOSAL_NOT_PENDING", "规范提案已处理或无法确认");
    }
    const resolved = status => ({ ...proposal, status, updatedAt: Date.now(), resolvedAt: Date.now() });
    const publishProposal = () => publish(workspace, proposal.rootConversationId || rootConversationId);
    if (action === "dismiss") {
      const dismissed = ctx.db.putSpecProposal(workspace, resolved("dismissed"));
      return { ok: true, proposal: dismissed, curation: publishProposal() };
    }
    assertCuratorAvailable(workspace);
    if (action === "revise") {
      const key = projectPathKey(workspace);
      if (revisions.has(key)) throw curationError("CURATOR_ALREADY_RUNNING", "当前项目已有提案在重拟");
      const thread = ctx.db.getThread(proposal.threadId, { includeQueue: false });
      if (!thread || thread.archived || !isCuratorRole(thread.role)) throw curationError("CURATOR_THREAD_UNAVAILABLE", "原维护官会话不可用");
      if (isThreadBusyStatus(thread.status) || ctx.activeRunByThread.has(thread.id) || ctx.pendingTurnStartLocks.has(thread.id)) {
        throw curationError("CURATOR_ALREADY_RUNNING", "原维护官会话仍在运行中");
      }
      const priorDiagnostics = [
        proposal.parseError && `上次解析错误：${proposal.parseError}`,
        ...(proposal.changes || []).filter(c => c.preflightIssues?.length)
          .map(c => `预检问题 (${c.path})：${c.preflightIssues.join("；")}`),
      ].filter(Boolean).join("\n");
      revisions.add(key);
      try {
        ctx.db.putSpecProposal(workspace, resolved("superseded"));
        const result = await ctx.turns.sendToThread({ threadId: proposal.threadId, continueSession: true, _manualCurationBypass: true,
          message: `请根据以下意见重拟提案，并基于当前文件重新核对。${priorDiagnostics ? `\n\n[上版问题]\n${priorDiagnostics}` : ""}\n\n${params.feedback.trim()}` });
        if (!result?.runId) throw curationError("CURATOR_THREAD_UNAVAILABLE", "原维护官会话未启动重拟");
        return { ok: true, supersededProposalId: proposal.id, threadId: proposal.threadId, runId: result.runId, curation: publishProposal() };
      } catch (error) {
        ctx.db.putSpecProposal(workspace, proposal);
        publishProposal();
        throw error;
      } finally { revisions.delete(key); }
    }
    const checked = preflight(workspace, proposal.changes, projectSpecLimits(workspace));
    try {
      if (checked.some((change, index) => change.baseSha256 !== proposal.changes[index].baseSha256)) {
        throw curationError("SPEC_PROPOSAL_CONFLICT", "文件自提案后已变化，整组变更未应用");
      }
      if (!checked.every(change => change.preflightOk)) throw curationError("SPEC_PROPOSAL_PREFLIGHT_FAILED", "规范提案未通过整组预检");
      const applied = resolved("applied");
      writeProposal(workspace, proposal, applied);
      return { ok: true, proposal: applied, curation: publishProposal(), status: applied.status };
    } catch (error) {
      if (error.code === "SPEC_PROPOSAL_CONFLICT") {
        ctx.db.putSpecProposal(workspace, resolved("conflict"));
        publishProposal();
      }
      throw error;
    }
  }

  async function triggerCurator(workspace, rootConversationId, source, params = {}, beforeStart) {
    assertCuratorAvailable(workspace);
    const note = typeof params.note === "string" ? params.note.trim() : "";
    const result = await ctx.dispatch.dispatchCurator({ cwd: workspace, conversationId: rootConversationId,
      presetKey: params.presetKey, mode: params.mode || "async", title: "维护项目规范",
      task: `检查本项目近期变更与既有规范，按角色卡输出维护提案。${note ? `\n补充说明：${note}` : ""}` }, source, beforeStart);
    if (!result) return null;
    const { taskId, threadId, runId, status } = result;
    return { ok: true, taskId, threadId, runId, status: ctx.db.getRun(runId)?.status || status, workspace,
      curation: curationStatus(workspace) };
  }

  const threadWorkspace = thread => normalizeProjectPath(thread.meta?.projectRoot || thread.workspace || thread.cwd);
  const conversationKey = (root, workspace) => `${projectPathKey(workspace)}\0${root.toLowerCase()}`;

  function scheduleAuto(root, workspace) {
    if (!root || !workspace || ctx.flags.shuttingDown || ctx.updates.isUpdating() ||
        ctx.scopePolicy.readConversationPolicy(root).orchestrationMode !== "complex" ||
        !ctx.db.getProjectSpec(workspace).autoTrigger) return;
    const key = conversationKey(root, workspace);
    clearTimeout(autoTimers.get(key));
    const timer = setTimeout(async () => {
      try {
        let waterline;
        const eligible = () => {
          if (ctx.flags.shuttingDown || ctx.updates.isUpdating() || autoTimers.get(key) !== timer ||
              ctx.scopePolicy.readConversationPolicy(root).orchestrationMode !== "complex") return false;
          const { running, autoTrigger, pendingProposal } = curationStatus(workspace);
          if (!autoTrigger || running || pendingProposal || revisions.has(projectPathKey(workspace))) return false;
          if (!ctx.db.getProjectRoster(workspace).modeProfiles.complex.curator.enabledKeys.length) return false;
          const threads = ctx.db.listThreads({ workspace, includeSubagents: true, includeQueue: false, limit: 1000 })
            .filter(thread => projectPathKey(threadWorkspace(thread)) === projectPathKey(workspace) &&
              ctx.scopePolicy.threadPolicyRoot(thread).toLowerCase() === root.toLowerCase());
          const snapshot = ctx.latestSwarmSnapshots.get(root) || ctx.latestSwarmSnapshots.get(root.toLowerCase());
          const hostThread = ctx.hostSync.findThreadByHostConversationId(root);
          const nativeRoot = hostThread?.isNativeHost ? hostThread : null;
          if ((nativeRoot || snapshot || hostSettlement.has(key) || ctx.hostSync.nativeTranscriptAvailable(root)) &&
              hostSettlement.get(key) !== true) return false;
          if (ctx.dispatch.findNativeHandoff({ rootConversationId: root }) ||
              snapshot?.members?.some(member => !member.killed && String(member.state).toLowerCase() === "working")) return false;
          const counts = ctx.scopePolicy.conversationWorkCounts(root);
          if (counts.runningCount || counts.queuedCount || threads.some(thread =>
              thread.id !== nativeRoot?.id && (isThreadBusyStatus(thread.status) || ctx.pendingTurnStartLocks.has(thread.id)))) return false;
          const scopedIds = new Set(threads.map(thread => thread.id));
          if (ctx.db.listPendingRequests({ workspace }).some(request => scopedIds.has(request.threadId))) return false;
          const last = ctx.db.readSpecCuration(workspace).autoWaterlines?.[root.toLowerCase()] || {};
          waterline = ctx.db.latestCurationWork(workspace, root);
          if (!waterline || (waterline.completedAt < (last.completedAt || 0)) ||
              (waterline.completedAt === last.completedAt && waterline.id <= last.id)) return false;
          if (inFlightAutoWaterlines.has(key) || failedAutoWaterlines.get(key) === `${waterline.completedAt}:${waterline.id}`) return false;
          return threads;
        };
        if (!eligible()) return;
        await triggerCurator(workspace, root, "auto", {}, async () => {
          if (ctx.hostSync.nativeTranscriptAvailable(root)) await ctx.hostSync.syncNativeHostConversation(root, { workspace });
          const threads = eligible();
          if (!threads || await ctx.worktrees.hasUnintegratedWorktree(threads, workspace) || !eligible()) return false;
          inFlightAutoWaterlines.set(key, waterline);
          return true;
        });
      } catch (error) {
        ctx.log(`自动规范维护未启动：${error.message}`);
      } finally { if (autoTimers.get(key) === timer) autoTimers.delete(key); }
    }, 220);
    timer.unref();
    autoTimers.set(key, timer);
  }

  function onWorkStarted(thread) {
    const root = ctx.scopePolicy.threadPolicyRoot(thread);
    if (!root) return;
    const workspace = threadWorkspace(thread);
    const key = conversationKey(root, workspace);
    clearTimeout(autoTimers.get(key));
    autoTimers.delete(key);
    if (ctx.scopePolicy.readConversationPolicy(root).orchestrationMode === "complex" &&
        ctx.db.getProjectSpec(workspace).autoTrigger &&
        !ctx.nativeWatchers.has(root) && ctx.hostSync.nativeTranscriptAvailable(root)) {
      void ctx.hostSync.syncNativeHostConversation(root, { workspace }).catch(error => {
        ctx.log(`读取宿主收尾状态失败：${error.message}`);
      });
    }
  }

  function onWorkSettled(thread) {
    if (thread) {
      scheduleAuto(ctx.scopePolicy.threadPolicyRoot(thread), threadWorkspace(thread));
    }
  }

  function onHostSettlement(root, workspace, settled) {
    if (!root || !workspace || typeof settled !== "boolean") return;
    const key = conversationKey(root, workspace);
    const previous = hostSettlement.get(key);
    hostSettlement.set(key, settled);
    if (previous !== true && settled) scheduleAuto(root, workspace);
  }

  function stopAutoCuration() {
    for (const timer of autoTimers.values()) clearTimeout(timer);
    autoTimers.clear();
  }

  function syncScaffold(top, inventory) {
    const signature = JSON.stringify([VERSION, resolveRoadmapDocPath(top), resolveEvolutionIndexPath(top),
      inventory.specs.map(({ key, sha256, relPath }) => `${key}:${sha256}:${relPath}`).sort()]);
    const anchors = [".agent-tower/spec/00-plugin/executor.md", ".agent-tower/spec/INDEX.md"];
    if (scaffoldSignatures.get(top) === signature && anchors.every(rel => {
      const file = path.join(top, rel);
      return fs.existsSync(file) && inspectSpecPath(file)?.isFile();
    })) return;
    syncProjectSpecScaffold(top, VERSION, inventory);
    scaffoldSignatures.delete(top);
    scaffoldSignatures.set(top, signature);
    if (scaffoldSignatures.size > 256) scaffoldSignatures.delete(scaffoldSignatures.keys().next().value);
  }

  function validateRoot(candidate) {
    // Inspect the original spelling before realpath can hide a linked root.
    if (typeof candidate !== "string" || !path.isAbsolute(candidate) || restricted(candidate, ctx.dataDir) ||
      !inspectSpecPath(path.resolve(candidate))?.isDirectory()) throw new Error(`规范目录不可用：${candidate}`);
    const { root, reason } = inspectProjectRoot(candidate, ctx.dataDir);
    if (!root) throw new Error(`规范目录不可用：${candidate} (${reason})`);
    return root;
  }

  function checkoutRoots(params) {
    try {
      const workspace = params.workspace !== undefined ? validateRoot(params.workspace) : undefined;
      const cwd = params.cwd !== undefined ? validateRoot(params.cwd) : workspace || validateRoot(ctx.db.defaultStudioRoot);
      const [top, common] = (readOnlyGit(cwd,
        ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"]) || "").trim().split(/\r?\n/);
      const checkout = top && inspectProjectRoot(top, ctx.dataDir).root ? validateRoot(top) : cwd;
      const commonRoot = common && path.basename(common).toLowerCase() === ".git" ? path.dirname(common) : "";
      const repoRoot = commonRoot && inspectProjectRoot(commonRoot, ctx.dataDir).root ? validateRoot(commonRoot) : checkout;
      return { checkout, repoRoot };
    } catch (error) {
      throw Object.assign(error, { code: "CWD_REJECTED" });
    }
  }

  function listProjectSpecs(params = {}) {
    const { checkout, repoRoot } = checkoutRoots(params);
    const curation = curationStatus(repoRoot);
    return { ...projectSpecStatus(checkout, { ...params, repoRoot, version: VERSION, specLimits: curation, specEnabled: curation.specEnabled }),
      archive: curation.archive, curation };
  }

  function initProjectSpecs(params = {}) {
    const { checkout, repoRoot } = checkoutRoots(params);
    assertSpecEnabled(repoRoot);
    try {
      const paths = materializeProjectSpecs(checkout, VERSION);
      const status = listProjectSpecs(params);
      return { ok: true, workspace: status.workspace, ...paths, status };
    } catch (error) {
      throw Object.assign(error, { code: "CWD_REJECTED" });
    }
  }

  function projectSpecsSummary(params = {}) {
    if (!params.cwd && !params.workspace) return {};
    try {
      const { checkout, repoRoot } = checkoutRoots(params);
      if (!ctx.db.isProjectSpecEnabled(repoRoot)) return { projectSpecs: [] };
      const { specs } = projectSpecStatus(checkout, { ...params, repoRoot, version: VERSION, specLimits: projectSpecLimits(repoRoot) });
      const projectSpecs = specs.slice(0, 30).map(({ key, title, kind, summary, relPath, required }) => ({ key, title, kind, summary, relPath, required }));
      return { projectSpecs };
    } catch { return {}; }
  }

  function prepareTurn({ thread, run, cwd, expectedSessionId, hideExternalSession, nativeReview, nativeHost: usesNativeHost, transport, dynamicPrompt, selectsPromptOnSend, preloadedTop, preloadedMainDrafts }) {
    const repoRoot = thread.meta?.projectRoot || thread.workspace || cwd;
    // The execution cwd can be a subdirectory. Specs and path tokens are rooted at the checkout.
    const top = preloadedTop ?? cwd;
    const role = run.role || thread.role;
    const curator = isCuratorRole(role);
    const specEnabled = ctx.db.isProjectSpecEnabled(repoRoot);
    const inventory = curator || !specEnabled ? { specs: [], warnings: [] } : readProjectSpecs(top, repoRoot, { preloadedMainDrafts: preloadedMainDrafts ?? [] });
    if (specEnabled && preloadedMainDrafts === null) inventory.warnings.push({ code: "SPEC_GIT_UNAVAILABLE", key: ".agent-tower/spec", message: "无法读取主仓未提交规范，继续使用工作树快照。" });
    try { if (specEnabled && !curator && !activeCurators.has(projectPathKey(repoRoot))) syncScaffold(top, path.relative(repoRoot, top) === "" ? inventory : readProjectSpecs(top)); }
    catch (error) { inventory.warnings.push({ code: "PLUGIN_MIRROR_REFRESH_FAILED", key: "00-plugin", message: error.message }); }
    const eligible = !curator && !hideExternalSession && !nativeReview && !thread.isNativeHost;
    const ledger = eligible ? specLedgerForThread(thread) : undefined;
    let previous = expectedSessionId ? ledger?.read(run.provider, expectedSessionId) : undefined;
    const projectReceipt = ({ key }) => key === "plugin/spec-catalog" || /^(business|coding)\//.test(key);
    // A hidden continuation can carry conclusions reached under specs from its previous turn.
    // Use the prior run's delivery metadata to announce a project-wide disable once.
    const isLocalContinuation = hideExternalSession && !curator && !nativeReview && dynamicPrompt !== run.prompt &&
      /^(?:\[Local Continuation Context\]|\[Cross-Engine Context Handoff: )/.test(dynamicPrompt);
    if (isLocalContinuation && !specEnabled) {
      const prior = ctx.db.listRuns({ threadId: thread.id, statuses: ["completed"], limit: 1, tail: true })[0]?.meta?.injectedSpecs;
      if (prior?.projectSpecsSent ?? prior?.items?.some(projectReceipt)) {
        previous = new Map([["plugin/spec-catalog", { tier: "inline" }]]);
      }
    }
    const selection = run.meta || {};
    const planDoc = curator ? null : readPlanDocument({ cwd: top, repoRoot, planPath: selection.planPath });
    const rootConvId = curator ? ctx.scopePolicy.threadPolicyRoot(thread) : "";
    const curatedHead = curator && ctx.db.inspectProjectDb?.(repoRoot) ? (ctx.db.readSpecCuration(repoRoot).curatedHead || "") : "";
    const curatorContext = curator && !expectedSessionId ? buildCuratorSessionContext(repoRoot, rootConvId) : "";
    const specLimits = projectSpecLimits(repoRoot);
    const plans = assembleSpecPrompt({ inventory, cwd: top, repoRoot, role,
      rawPrompt: run.meta?.reviewSpec ? (run.meta.reviewSpec.customPrompt || "") : run.prompt,
      dynamicPrompt: buildDynamicPrompt({ prompt: dynamicPrompt ?? run.prompt,
        orchestrationMode: run.meta?.orchestrationMode, executionIntent: run.meta?.executionIntent }),
      selection, review: run.meta?.reviewSpec, transport, ledger: previous, planDoc, controlDir: ctx.dataDir,
      curatedHead, curatorContext, specLimits, specEnabled });
    if (isLocalContinuation && previous?.size) plans.full = plans.delta;
    let sent = plans.delta;
    let variantSelected = false;
    let sessionId;
    let resumed;
    let consumed = false;
    let acknowledged = false;
    let nativeHost = thread.isNativeHost || usesNativeHost;
    const getMeta = () => ({ ...sent.meta, projectSpecsSent: specEnabled && sent.delivered.some(projectReceipt),
      ledgerState: acknowledged ? "acknowledged" : eligible && !nativeHost ? "pending" : "not_applicable" });
    function persist() {
      const meta = { injectedSpecs: getMeta() };
      ctx.db.upsertRun({ id: run.id, threadId: thread.id, meta });
      ctx.db.upsertTurnItem({ id: `item_user_${run.id}`, threadId: thread.id, runId: run.id, meta });
    }
    function acknowledge() {
      if (!eligible || !ledger || nativeHost || !sessionId || !consumed || acknowledged) return;
      const injectedSpecs = { ...getMeta(), ledgerState: "acknowledged" };
      ledger.acknowledge({ provider: run.provider, sessionId, runId: run.id, threadId: thread.id,
        delivered: sent.delivered, injectedSpecs });
      acknowledged = true;
    }
    function choose(didResume) {
      if (!variantSelected) {
        const selected = didResume === false ? plans.full : plans.delta;
        variantSelected = true;
        if (sent !== selected) { sent = selected; persist(); }
      }
      acknowledge();
      return sent.prompt;
    }
    persist();
    return {
      // The engine manager forwards prompt unchanged. Legacy stdin adapters stringify it after binding.
      deltaPrompt: plans.delta.prompt,
      sessionPrompt: { forSession: choose, toString: () => choose(resumed) },
      freshSessionPrompt: plans.full.prompt,
      observe(event) {
        if (event.type === "session_bound" && event.nativeSessionId) {
          nativeHost ||= Boolean(event.isNativeHost);
          sessionId = event.nativeSessionId;
          resumed = event.resumed ?? (sessionId === expectedSessionId);
          if (nativeHost) persist();
        }
        if ((!selectsPromptOnSend || variantSelected) && confirmsConsumption(event)) consumed = true;
        if (variantSelected || plans.delta === plans.full) acknowledge();
      },
      settle(result) {
        if (result.status === "completed") consumed = true;
        if (!variantSelected) choose(resumed);
        acknowledge();
      },
    };
  }

  return { listProjectSpecs, initProjectSpecs, projectSpecsSummary, prepareTurn, specCuration, curationStatus,
    assertSpecEnabled, assertCuratorAvailable, isCuratorThread, startCurator, onWorkStarted, onWorkSettled, onHostSettlement, stopAutoCuration,
    scheduleAuto };
}

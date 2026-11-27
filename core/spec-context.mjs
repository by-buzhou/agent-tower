import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { ensureStorageIgnoreRules, inside, restricted } from "./storage-paths.mjs";

const SPEC_ROOT = ".agent-tower/spec";
const MIRROR_ROOT = `${SPEC_ROOT}/00-plugin`;
const CATEGORIES = { business: `${SPEC_ROOT}/01-business`, coding: `${SPEC_ROOT}/02-coding` };
const DEFAULT_ROLES = { business: ["advisor", "executor", "review"], coding: ["advisor", "executor", "review"] };
const PROJECT_KINDS = ["business", "coding"];
const LEGACY_EXAMPLE = Symbol("legacy example");
const legacyExampleText = kind => `---\nid: example\ntitle: ${kind} 规范示例\nkind: ${kind}\nrequired: false\nscopes: []\ntags: []\nsummary: 填写适用范围和项目规则。\n---\n\n请在此填写项目约定。\n`;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const ARGV_BUDGET = 2048;
const PLAN_BUDGET = 24 * 1024;
export const DEFAULT_SPEC_SINGLE_KB = 2;
export const DEFAULT_SPEC_TOTAL_KB = 16;
export function normalizeSpecQuotaLimits(raw = {}) {
  const sRaw = Number(raw?.singleMaxKb);
  const singleMaxKb = Number.isInteger(sRaw) && sRaw >= 1 && sRaw <= 8 ? sRaw : DEFAULT_SPEC_SINGLE_KB;
  const tRaw = Number(raw?.totalMaxKb);
  const totalBase = Number.isInteger(tRaw) && tRaw >= 8 && tRaw <= 128 ? tRaw : DEFAULT_SPEC_TOTAL_KB;
  const totalMaxKb = Math.min(128, Math.max(totalBase, singleMaxKb * 2));
  const singleMaxBytes = singleMaxKb * 1024;
  const totalMaxBytes = totalMaxKb * 1024;
  const highWaterBytes = singleMaxBytes === 2048 ? 1600 : Math.round(singleMaxBytes * 0.8);
  return { singleMaxKb, totalMaxKb, singleMaxBytes, totalMaxBytes, highWaterBytes };
}
const bytes = text => Buffer.byteLength(text);
const hash = text => createHash("sha256").update(text).digest("hex");
const posix = text => text.replaceAll("\\", "/");
const warning = (code, key, message) => ({ code, key, message });
const escapeBlock = text => text.replace(/<\/agent_tower_/gi, match => `&lt;${match.slice(1)}`);

export const ROLE_SYSTEM_PREFIXES = {
  curator: "[ROLE: SPEC CURATOR]\n只读梳理本项目规范，结合探针与用户原话查 .agent-tower/spec/INDEX.md 及变更证据。禁改任何文件，禁读会审归档目录。\n【盲测四问】①读最新源码即懂的常识/签名不写；②check 或单测已硬拦的机械细节不写（仅留测试无法表达的业务意图/契约）；③单次修补归演进、主会话调度不进规范，仅跨版本业务规则（01-business，无用户拍板或纠偏严禁凭代码脑补）与工程不变量（02-coding）准入；④修漂移错规、清死路标/死符号与删废规优先，无偏差一律 no_change。\n【容量置换】正文 <= 2048 B，原地覆写禁尾追；>= 1600 B 净增或删文须在 mergedOrRemoved 写明同篇精简依据（One-In-One-Out），废规 delete，核对 scopes/tests: 存在。\n先中文简述，末尾仅附一段代码块：\n```agent-tower-spec-proposal\n{\"status\":\"propose\",\"summary\":\"...\",\"changes\":[{\"action\":\"create|update|delete\",\"path\":\".agent-tower/spec/01-business/xxx.md\",\"why\":\"...\",\"changeSummary\":\"...\",\"mergedOrRemoved\":\"...\",\"impactAndTests\":\"...\",\"content\":\"含 Frontmatter 的完整 Markdown，删除时省略\"}]}\n```\n无变更输出 {\"status\":\"no_change\",\"reason\":\"...\"}。",
  advisor: "[ROLE: ADVISOR / PLANNER]\nFocus on architectural investigation, root-cause diagnosis, trade-off analysis, and step-by-step planning. Do NOT make destructive edits unless explicitly instructed.",
  executor: "[ROLE: EXECUTOR]\nImplement the requested changes cleanly and completely. Only implement the requested scope — do not speculatively add future hooks or over-engineer. Verify with fast syntax checks and targeted unit tests covering normal, boundary, and error paths (reuse existing project test helpers instead of ad-hoc server/browser harnesses; follow project testing specs when present). Report modified files and verification results concisely.",
  review: "[ROLE: DEFECT-FIRST REVIEWER]\nPerform a strict defect-first review of the changes. Prioritize real bugs, broken contracts, race conditions, and security issues with file/line references, and run fast targeted verification when fixing defects.",
  general: "[ROLE: GENERAL]\nFollow the task instructions and report the outcome concisely.",
};
const HYGIENE = "[WORKSPACE HYGIENE]\n" +
  "Run tests and temporary scripts inside the current project repository/folder only. " +
  "When no temp directory is specified, create and use a `tmp/` folder in the current project (in a Git repository, make sure `tmp/` is listed in `.gitignore` first). " +
  "Never scatter test or scratch files outside the project (C: system directories, Desktop, system %TEMP%/%TMP%), and clean them up when done.";
const GOVERNANCE_BOUNDARY = "[GOVERNANCE BOUNDARY]\n未经任务明确指派，子 Agent 不得擅自新建或修改 .agent-tower/spec/**、.agent-tower/councils/**、.agent-tower/plans/**、.agent-tower/docs/**；常规任务只读消费项目规范，由专职规范维护官提案，经用户确认后落盘。";

export function normalizeSpecRole(role) {
  const name = String(role || "general").trim().toLowerCase();
  if (["commander", "coordinator"].includes(name)) return name;
  if (name === "reviewer") return "review";
  if (["design", "research"].includes(name) || name.startsWith("advisor_")) return "advisor";
  if (["implementation", "test"].includes(name) || name.startsWith("executor_")) return "executor";
  return Object.hasOwn(ROLE_SYSTEM_PREFIXES, name) ? name : "general";
}

// Check every component, including the candidate root and its ancestors. lstat also detects NTFS junctions.
export function inspectSpecPath(target) {
  const root = path.parse(target).root;
  if (!root) throw new Error("Expected an absolute path");
  let current = root;
  let stat;
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    if (stat && !stat.isDirectory()) throw new Error(`Not a directory: ${current}`);
    current = path.join(current, part);
    try { stat = fs.lstatSync(current); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
    if (stat.isSymbolicLink()) throw new Error(`Linked path refused: ${current}`);
  }
  return stat ?? fs.lstatSync(root);
}

const sameStat = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino &&
  a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

export function readSpecFile(file, encoding = "utf8") {
  const stat = inspectSpecPath(file);
  if (!stat?.isFile()) return null;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!sameStat(stat, fs.fstatSync(fd))) throw new Error("File changed before read");
    const text = fs.readFileSync(fd, encoding);
    if (!sameStat(stat, fs.fstatSync(fd)) || !sameStat(stat, inspectSpecPath(file))) throw new Error("File changed during read");
    return text;
  } finally { fs.closeSync(fd); }
}
const readFile = readSpecFile;

function hasProjectDoc(cwd, repoRoot, relPath) {
  return [cwd, repoRoot].some(root => {
    if (!root || !path.isAbsolute(root) || restricted(root)) return false;
    try { return Boolean(inspectSpecPath(path.join(root, relPath))?.isFile()); }
    catch { return false; }
  });
}

function resolveProjectDocPath(cwd, repoRoot, relPaths) {
  return relPaths.find(relPath => hasProjectDoc(cwd, repoRoot, relPath)) || "";
}

export function resolveEvolutionIndexPath(cwd, repoRoot) {
  return resolveProjectDocPath(cwd, repoRoot, [".agent-tower/docs/evolution/INDEX.md"]);
}
export function resolveRoadmapDocPath(cwd, repoRoot) {
  return resolveProjectDocPath(cwd, repoRoot, [".agent-tower/docs/ROADMAP.md"]);
}
export const hasEvolutionIndex = (cwd, repoRoot) => Boolean(resolveEvolutionIndexPath(cwd, repoRoot));
export const hasRoadmapDoc = (cwd, repoRoot) => Boolean(resolveRoadmapDocPath(cwd, repoRoot));
// Host-only probes for document archives; councils/ is never scanned into sub-agent spec bundles.
export const hasCouncilsIndex = (cwd, repoRoot) => hasProjectDoc(cwd, repoRoot, ".agent-tower/councils/INDEX.md");
export const hasPlansIndex = (cwd, repoRoot) => hasProjectDoc(cwd, repoRoot, ".agent-tower/plans/INDEX.md");

export function readPlanDocument({ cwd, repoRoot = cwd, planPath } = {}) {
  if (planPath === undefined || planPath === null || planPath === "") return null;
  const root = repoRoot || cwd;
  let relPath;
  try {
    const raw = typeof planPath === "string" ? posix(planPath.trim()) : "";
    relPath = !raw || path.isAbsolute(raw) || /^(?:[a-z]:|\/)/i.test(raw) ? null : normalizeTargetPath(root, raw);
  } catch { relPath = null; }
  if (!relPath || !/^\.agent-tower\/plans\/[^/]+\.md$/i.test(relPath)) {
    throw Object.assign(new Error("planPath 必须是项目根目录下 .agent-tower/plans/*.md 的相对路径，且不能包含 ..。"), { code: "PLAN_PATH_REJECTED" });
  }
  for (const candidateRoot of [...new Set([repoRoot, cwd].filter(Boolean))]) {
    const file = path.join(candidateRoot, relPath);
    let stat;
    try { stat = inspectSpecPath(file); }
    catch (error) { throw Object.assign(new Error(`规划路径不安全：${error.message}`), { code: "PLAN_PATH_REJECTED", cause: error }); }
    if (!stat) continue;
    if (!stat.isFile()) throw Object.assign(new Error(`规划路径不是文件：${relPath}`), { code: "PLAN_PATH_REJECTED" });
    const body = readFile(file);
    if (body === null) throw Object.assign(new Error(`规划读取失败：${relPath}`), { code: "PLAN_READ_FAILED" });
    return { id: path.basename(relPath).replace(/\.md$/i, ""), relPath, file, body, bytes: bytes(body), sha256: hash(body) };
  }
  throw Object.assign(new Error(`找不到定稿施工规划：${relPath}`), { code: "PLAN_NOT_FOUND" });
}

export function assemblePlanPrompt({ cwd, repoRoot = cwd, planPath, planDoc, role, ledger, transport, remainingBytes } = {}) {
  const plan = planDoc === undefined ? readPlanDocument({ cwd, repoRoot, planPath }) : planDoc;
  if (!plan) return { prompt: "", delivered: [], item: null, warnings: [] };
  const key = `plan/${plan.id}`;
  const old = ledger?.get(key);
  const reused = old?.sha256 === plan.sha256 && old.tier === "inline";
  const safePath = plan.relPath.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const reviewHint = normalizeSpecRole(role) === "review" ? "请逐条对照规划中的 `[ ]` Checklist 核验代码是否落齐。\n\n" : "";
  const inline = reused || plan.bytes > PLAN_BUDGET ? "" :
    `<agent_tower_plan path="${safePath}">\n${escapeBlock(plan.body)}\n</agent_tower_plan>\n\n${reviewHint}`;
  const budget = Math.min(remainingBytes ?? Infinity, transport === "argv" ? ARGV_BUDGET : Infinity);
  const degraded = !reused && (!inline || bytes(inline) > budget);
  const tier = reused ? "reused" : degraded ? "pointer_degraded" : "inline";
  const file = plan.file || path.join(repoRoot, plan.relPath);
  return {
    prompt: degraded ? `【必读规划】动工前请完整读取 ${escapeBlock(file)}。\n\n${reviewHint}` : inline,
    delivered: reused ? [] : [{ key, sha256: plan.sha256, tier }],
    warnings: degraded ? [warning("REQUIRED_BUDGET_DEGRADED", key, `必读规划 ${file} 超出投递预算，请完整读取原文件。`)] : [],
    item: { key, id: plan.id, title: plan.id, kind: "plan", tier, required: true,
      reason: "explicit", bytes: plan.bytes, sha: plan.sha256.slice(0, 8), relPath: plan.relPath },
  };
}

export function resolveEvolutionPromptHint({ role, evolutionPath = ".agent-tower/docs/evolution/INDEX.md" } = {}) {
  const name = normalizeSpecRole(role);
  if (!Object.hasOwn(ROLE_SYSTEM_PREFIXES, name)) return "";
  return `[EVOLUTION INDEX]\n历史演进与曾否决方案索引见 ${evolutionPath}，规划、重构或评审既有核心模块前请先按关键词检索避坑。\n\n`;
}

export function pluginSpec(role, docs = {}) {
  // The standalone v0.1.x prompt helper still passes the evolution flag as a boolean.
  const {
    withEvolution,
    evolutionPath = ".agent-tower/docs/evolution/INDEX.md",
    specLimits,
    specEnabled = true,
  } = typeof docs === "boolean" ? { withEvolution: docs } : docs;
  const id = normalizeSpecRole(role);
  let prefix = ROLE_SYSTEM_PREFIXES[id];
  if (!prefix) return null;
  if (id === "curator" && specLimits) {
    const limits = normalizeSpecQuotaLimits(specLimits);
    prefix = prefix
      .replace("<= 2048 B", `<= ${limits.singleMaxBytes} B`)
      .replace(">= 1600 B", `>= ${limits.highWaterBytes} B`);
  }
  const [heading, responsibility] = prefix.split("\n");
  const sections = id === "curator" ? [prefix] : [prefix, HYGIENE];
  if (withEvolution) sections.push(resolveEvolutionPromptHint({ role: id, evolutionPath }).trimEnd());
  if (DEFAULT_ROLES.business.includes(id)) sections.push(specEnabled ? GOVERNANCE_BOUNDARY :
    "[GOVERNANCE BOUNDARY]\n遵循目标仓库自有规则文件。未经任务明确指派，不得新建或修改 .agent-tower/councils/**、.agent-tower/plans/**、.agent-tower/docs/**。");
  const body = sections.join("\n\n");
  return { key: `plugin/${id}`, id, title: heading.slice(7, -1), kind: "plugin",
    summary: responsibility.split(/(?<=\.) /, 1)[0], body, bytes: bytes(body), sha256: hash(body),
    relPath: `${MIRROR_ROOT}/${id}.md`, required: false, reason: "role", tier: "inline" };
}

function projectDocFlags(cwd, repoRoot) {
  const evolutionPath = resolveEvolutionIndexPath(cwd, repoRoot);
  return { withEvolution: Boolean(evolutionPath), evolutionPath };
}

const ARRAY_FIELDS = new Set(["roles", "scopes", "tags", "tests"]);
function scalar(value) {
  const text = value.trim();
  if (!text || /^[\[\]{}>|&!]/.test(text)) throw new Error("Expected a scalar");
  if (text.startsWith('"')) {
    const decoded = JSON.parse(text);
    if (typeof decoded !== "string") throw new Error("Expected a string");
    return decoded;
  }
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(text)) throw new Error("Invalid quoted string");
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text;
}

function arrayValue(value) {
  if (!value.startsWith("[") || !value.endsWith("]")) throw new Error("Expected an array");
  const content = value.slice(1, -1).trim();
  if (!content) return [];
  const items = content.match(/(?:"(?:\\.|[^"\\])*"|'(?:[^']|'')*'|[^,'"])+|,/g);
  if (!items || items.join("") !== content) throw new Error("Invalid array");
  const result = [];
  for (let i = 0; i < items.length; i++) {
    if (i % 2 === 0) result.push(scalar(items[i]));
    else if (items[i] !== ",") throw new Error("Invalid array separator");
  }
  return result;
}

export function parseFrontmatter(raw) {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!/^---[ \t]*(?:\n|$)/.test(text)) return { body: text, fields: {} };
  const lines = text.split("\n");
  const end = lines.findIndex((line, index) => index > 0 && /^---[ \t]*$/.test(line));
  try {
    if (end < 0) throw new Error("Missing closing delimiter");
    const fields = Object.create(null);
    let list;
    for (const line of lines.slice(1, end)) {
      if (/^\s*(?:#.*)?$/.test(line)) continue;
      const item = /^\s*-\s+(.+)$/.exec(line);
      if (item && list) { list.push(scalar(item[1])); continue; }
      const field = /^([a-z][\w-]*):\s*(.*)$/i.exec(line);
      if (!field || Object.hasOwn(fields, field[1])) throw new Error("Invalid or duplicate field");
      const [, key, value] = field;
      list = undefined;
      if (ARRAY_FIELDS.has(key)) fields[key] = value ? arrayValue(value) : (list = []);
      else if (key === "required") {
        if (!/^(true|false)$/.test(value.trim())) throw new Error("Expected required: true or false");
        fields[key] = value.trim() === "true";
      } else fields[key] = scalar(value);
    }
    if (fields.id !== undefined && !ID.test(fields.id)) throw new Error("Invalid id");
    if (fields.summary?.includes("\n")) throw new Error("Expected a single-line summary");
    return { body: lines.slice(end + 1).join("\n"), fields };
  } catch (error) { return { body: text, fields: {}, error: error.message }; }
}

function kindAt(relPath) {
  return Object.keys(CATEGORIES).find(kind => relPath.startsWith(`${CATEGORIES[kind]}/`));
}
const isSpecFile = file => /\.md$/i.test(file) && !/^index\.md$/i.test(path.basename(file));

function scan(root, relDir, warnings, onMarkdown) {
  const files = [];
  function visit(relPath, directory) {
    try {
      const target = path.join(root, relPath);
      const st = inspectSpecPath(target);
      if (st?.isDirectory()) {
        for (const name of fs.readdirSync(target).sort()) {
          if (name !== ".git" && !name.includes("\\")) visit(`${relPath}/${name}`, false);
        }
      } else if (!directory && st?.isFile() && /\.md$/i.test(relPath)) {
        onMarkdown?.(relPath, st);
        if (isSpecFile(relPath)) files.push(relPath);
      }
    } catch (error) { warnings.push(warning("UNSAFE_SPEC_PATH", relPath, error.message)); }
  }
  visit(relDir, true);
  return files;
}

export function hasActiveProjectSpecs(root) {
  try {
    if (inspectSpecPath(path.join(root, SPEC_ROOT, "INDEX.md"))?.isFile()) return true;
  } catch {}
  return Object.entries(CATEGORIES).some(([kind, dir]) => scan(root, dir, []).some(rel => {
    if (rel !== `${dir}/example.md`) return true;
    try { const raw = readFile(path.join(root, rel)); return raw !== null && raw !== legacyExampleText(kind); }
    catch { return false; }
  }));
}

export function projectSpecFileStamps(root) {
  const stamps = [];
  for (const relDir of Object.values(CATEGORIES)) {
    scan(root, relDir, [], (relPath, st) => stamps.push([relPath, st.mtimeMs, st.size, st.ctimeMs, st.ino]));
  }
  return stamps;
}

function readSpec(root, relPath, source, warnings) {
  try {
    const raw = readFile(path.join(root, relPath));
    if (raw === null) return null;
    const kind = kindAt(relPath);
    if (PROJECT_KINDS.includes(kind) && relPath === `${CATEGORIES[kind]}/example.md` && raw === legacyExampleText(kind)) return LEGACY_EXAMPLE;
    const { fields, body, error } = parseFrontmatter(raw);
    const id = fields.id ?? path.basename(relPath).replace(/\.md$/i, "");
    const key = `${kind}/${id}`;
    const issues = [];
    if (error) issues.push(warning("PARSE_ERROR", key, error));
    if (!ID.test(id)) {
      warnings.push(...issues, warning("INVALID_SPEC_ID", key, `Invalid filename id: ${relPath}`));
      return null;
    }
    if (fields.kind && fields.kind !== kind) issues.push(warning("KIND_MISMATCH", key, `Using ${kind} from ${relPath}`));
    warnings.push(...issues);
    return { key, id, title: fields.title || id, kind, source, relPath, required: fields.required ?? false,
      roles: fields.roles ? [...new Set(fields.roles.map(role => normalizeSpecRole(role)))] : (DEFAULT_ROLES[kind] ?? DEFAULT_ROLES.business),
      scopes: fields.scopes ?? [], tags: fields.tags ?? [],
      tests: (fields.tests ?? []).filter(item => typeof item === "string" && item.trim()).map(item => item.trim()),
      summary: truncate(fields.summary || body.split("\n").map(line => line.trim()).find(Boolean) || id, 512),
      body, bytes: bytes(body), sha256: hash(raw), warnings: issues };
  } catch (error) {
    warnings.push(warning("UNSAFE_SPEC_PATH", relPath, error.message));
    return null;
  }
}

export function readOnlyGit(cwd, args) {
  const sandbox = process.env.AGENT_TOWER_TEST_ROOT;
  const ceiling = cwd && sandbox && inside(path.resolve(sandbox), path.resolve(cwd))
    ? { GIT_CEILING_DIRECTORIES: path.resolve(sandbox) } : {};
  const output = spawnSync("git", ["--no-optional-locks", ...args], {
    cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...ceiling }, encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  return output.status === 0 ? output.stdout : null;
}

function mainDrafts(root, warnings) {
  try {
    // A missing directory can represent deletion of every tracked spec. Git still has the tombstones.
    const tree = inspectSpecPath(path.join(root, SPEC_ROOT));
    if (tree && !tree.isDirectory()) return [];
  } catch (error) {
    warnings.push(warning("UNSAFE_SPEC_PATH", SPEC_ROOT, error.message));
    return [];
  }
  const output = readOnlyGit(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", SPEC_ROOT]);
  if (output === null) {
    warnings.push(warning("SPEC_GIT_UNAVAILABLE", SPEC_ROOT, "无法读取主仓未提交规范，继续使用工作树快照。"));
    return [];
  }
  return parseMainDrafts(root, output);
}

function parseMainDrafts(root, porcelain) {
  const drafts = new Map();
  const add = (file, deleted) => {
    if (kindAt(file) && isSpecFile(file) && normalizeTargetPath(root, file) === file) drafts.set(file, deleted);
  };
  const records = porcelain.split("\0");
  for (let i = 0; i < records.length && records[i]; i++) {
    const flags = records[i].slice(0, 2);
    const file = records[i].slice(3);
    if (/[RC]/.test(flags)) {
      const old = records[++i];
      if (flags.includes("R") && old) add(old, true);
    }
    add(file, flags[1] === "D" || (flags[0] === "D" && flags[1] === " "));
  }
  return drafts;
}

export function readProjectSpecs(cwd, repoRoot = cwd, { preloadedMainDrafts } = {}) {
  const warnings = [];
  const found = new Map();
  for (const [kind, relDir] of Object.entries(CATEGORIES)) {
    for (const relPath of scan(cwd, relDir, warnings)) {
      const spec = readSpec(cwd, relPath, "project", warnings);
      if (spec && spec !== LEGACY_EXAMPLE) found.set(relPath, spec);
    }
  }
  if (repoRoot && path.relative(repoRoot, cwd) !== "") {
    // Async callers can pass either porcelain -z output or already parsed [path, deleted] entries.
    const drafts = typeof preloadedMainDrafts === "string" ? parseMainDrafts(repoRoot, preloadedMainDrafts) :
      preloadedMainDrafts === undefined ? mainDrafts(repoRoot, warnings) : preloadedMainDrafts ?? [];
    for (const [relPath, deleted] of drafts) {
      if (!kindAt(relPath) || !isSpecFile(relPath) || normalizeTargetPath(repoRoot, relPath) !== relPath) continue;
      if (deleted) found.delete(relPath);
      else {
        const spec = readSpec(repoRoot, relPath, "main-draft", warnings);
        if (spec === LEGACY_EXAMPLE) found.delete(relPath);
        else if (spec) {
          // The checked-out path is also unusable when it contains an older version of the draft.
          spec.draftOnly = found.get(relPath)?.sha256 !== spec.sha256;
          found.set(relPath, spec);
        }
      }
    }
  }
  const byKey = new Map();
  for (const spec of found.values()) {
    const existing = byKey.get(spec.key);
    if (existing) warnings.push(warning("DUPLICATE_SPEC_ID", spec.key, `${existing.relPath}, ${spec.relPath}`));
    if (!existing || (spec.source === "main-draft" && existing.source !== "main-draft")) byKey.set(spec.key, spec);
  }
  const specs = [...byKey.values()];
  for (const [kind, limit] of [["business", 16], ["coding", 10]]) {
    const count = specs.filter(spec => spec.kind === kind).length;
    if (count > limit) warnings.push(warning("SPEC_COUNT_SOFT_LIMIT", kind, `${kind} 活跃规范共 ${count} 份，超过建议的 ${limit} 份。`));
  }
  return { specs, warnings };
}

export function normalizeTargetPath(root, input) {
  if (typeof input !== "string" || !input.trim() || /[\0\r\n]/.test(input)) return null;
  const raw = posix(input.trim());
  if (raw.split("/").includes("..")) return null;
  if (!path.isAbsolute(raw) && /^(?:[a-z]:|\/)/i.test(raw)) return null;
  const absolute = path.resolve(root, raw);
  return inside(root, absolute) ? posix(path.relative(root, absolute)) : null;
}

const quoteRegex = text => text.replace(/[|\\{}()[\]^$+*.?]/g, "\\$&");
export function matchSpecGlob(file, glob) {
  const pattern = posix(glob).replace(/^\.\//, "");
  const wildcards = new Map([["**/", "(?:.*/)?"], ["**", ".*"], ["*", "[^/]*"], ["?", "[^/]"]]);
  const expression = pattern.split(/(\*\*\/|\*\*|\*|\?)/).map(token =>
    wildcards.get(token) ?? quoteRegex(token)).join("");
  return new RegExp(`^${expression}$`, process.platform === "win32" ? "i" : "").test(file);
}

export function matchSpecTag(text, tag) {
  if (/^[\x00-\x7f]+$/.test(tag)) return tag.length >= 3 && new RegExp(`(?:^|[^a-z0-9_])${quoteRegex(tag)}(?=$|[^a-z0-9_])`, "i").test(text);
  return (tag.match(/\p{Script=Han}/gu)?.length ?? 0) >= 2 && text.includes(tag);
}

function normalizeReadPath(input, { cwd, repoRoot = cwd, controlDir } = {}) {
  if (typeof input !== "string" || /[:\x00-\x1f\x7f]/.test(input)) return null;
  const raw = posix(input.trim());
  if (!raw || raw.startsWith("/") || raw.split("/").some(part =>
    part === ".." || part.toLowerCase() === ".git" ||
    (process.platform === "win32" && part !== "." && (/[. ]$|[<>"|?*]/.test(part) || WINDOWS_DEVICE_NAME.test(part))))) return null;
  const rel = path.posix.normalize(raw).replace(/\/$/, "");
  if (rel === "." || /^\.agent-tower\/councils(?:\/|$)/i.test(rel)) return null;
  // The selection can travel through run metadata before the checkout is known. Check both roots at send time.
  for (const root of new Set([cwd, repoRoot].filter(Boolean))) {
    const absolute = path.resolve(root, rel);
    if (!inside(root, absolute) || restricted(absolute, controlDir)) return null;
    try { inspectSpecPath(absolute); }
    catch { return null; }
  }
  return rel;
}

const pathKey = file => process.platform === "win32" ? file.toLowerCase() : file;

export function specSelection(params = {}, options) {
  const strings = value => Array.isArray(value) ? value.filter(item => typeof item === "string" && item.trim()).map(item => item.trim()) : [];
  const readPaths = new Map();
  for (const input of Array.isArray(params.readPaths) ? params.readPaths : []) {
    const rel = normalizeReadPath(input, options);
    if (rel) readPaths.set(pathKey(rel), rel);
    else options?.warnings?.push(warning("INVALID_READ_PATH", String(input), "只读参考路径必须是项目内无链接的相对路径。"));
  }
  return { specIds: strings(params.specIds), targetPaths: strings(params.targetPaths), readPaths: [...readPaths.values()],
    planPath: typeof params.planPath === "string" ? params.planPath.trim() : "" };
}

const diffFiles = (cwd, args) => (readOnlyGit(cwd, args) ?? "").split("\0").filter(Boolean);
export function reviewDiffPaths(cwd, { scope, baseBranch, commitSha, changedPaths } = {}) {
  if (Array.isArray(changedPaths)) return [...new Set(changedPaths.map(file => normalizeTargetPath(cwd, file)).filter(Boolean))];
  scope = String(scope || "uncommitted").toLowerCase();
  const diff = (args, command = "diff") => diffFiles(cwd, [command, "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", ...args]);
  if (scope === "commit") return [...new Set(diff(["--root", "-r", "-m", "--no-commit-id", "--end-of-options", commitSha || "HEAD", "--"], "diff-tree"))];
  if (scope === "branch" && !baseBranch?.startsWith("-")) return diff(["--end-of-options", `${baseBranch || "main"}...HEAD`, "--"]);
  if (scope === "uncommitted") return diffFiles(cwd,
    ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]).map(record => record.slice(3));
  return [];
}

function truncate(text, limit) {
  if (bytes(text) <= limit) return text;
  return Buffer.from(text).subarray(0, limit).toString("utf8").replace(/\uFFFD$/, "");
}

const tierRank = { summary: 1, pointer_degraded: 2, inline: 3 };
const equivalentTier = (previous, tier) => tierRank[previous] >= tierRank[tier];
const block = text => text.length ? `<agent_tower_specs v="1">\n${text.map(escapeBlock).join("\n\n")}\n</agent_tower_specs>\n\n` : "";

const testSuffix = ".test.mjs";
const fileStem = file => path.basename(file).replace(/(?:\.test)?\.[^.]+$/, "");

function evolutionRows(cwd, repoRoot, evolutionPath, target, rawPrompt) {
  if (!evolutionPath) return [];
  let index;
  for (const root of new Set([cwd, repoRoot].filter(Boolean))) {
    try { index = readFile(path.join(root, evolutionPath)); } catch { continue; }
    if (index !== null) break;
  }
  if (!index) return [];
  const stems = target.map(fileStem);
  const rows = [];
  let remaining = 500;
  let columns = [];
  for (const line of index.split(/\r?\n/)) {
    const row = line.trim();
    if (!row.startsWith("|") || !row.endsWith("|")) { columns = []; continue; }
    const cells = row.slice(1, -1).split(/(?<!\\)\|/).map(cell => cell.trim());
    const headings = cells.flatMap((cell, i) => /^(?:版本(?:号)?|(?:.*检索)?关键词|搜索关键词|关键字|version|keywords?)$/i.test(cell) ? [i] : []);
    if (headings.length) { columns = headings; continue; }
    const keywords = columns.flatMap(i => (cells[i] || "").match(/[a-z0-9_./-]+|\p{Script=Han}{3,}/giu) || []);
    const hits = keywords.some(word => {
      if (/^[a-z0-9_./-]+$/i.test(word) && !/[a-z0-9]{2}/i.test(word)) return false;
      if (/^v?\d+(\.\d+)+$/i.test(word)) {
        return new RegExp(`(?:^|[^a-z0-9_.])${quoteRegex(word)}(?![a-z0-9_.])`, "i").test(rawPrompt);
      }
      const stem = fileStem(word);
      const keywordHit = /^[a-z0-9]{2}$/i.test(word) ? new RegExp(`(?:^|[^a-z0-9_])${word}(?![a-z0-9_])`, "i").test(rawPrompt)
        : matchSpecTag(rawPrompt, word);
      return keywordHit ||
        (stem.length >= 2 && stems.some(file => file.toLowerCase() === stem.toLowerCase()));
    });
    if (!hits) continue;
    const cost = bytes(escapeBlock(row)) + 1;
    if (cost > remaining) continue;
    rows.push(row);
    remaining -= cost;
    if (rows.length === 3) break;
  }
  return rows;
}

function quickTestStems(repoRoot, role, target, matched = []) {
  if (!repoRoot || !["executor", "review"].includes(role)) return [];
  const declared = matched
    .filter(entry => ["explicit", "target_path", "diff_path"].includes(entry.reason))
    .flatMap(entry => entry.tests ?? []);
  if (!target.length && !declared.length) return [];
  const wanted = new Set([...target, ...declared].map(file => pathKey(fileStem(file))));
  const found = new Set();
  for (const suite of ["unit", "integration"]) {
    const dir = path.join(repoRoot, "tests", suite);
    try {
      if (!inspectSpecPath(dir)?.isDirectory()) continue;
      for (const name of fs.readdirSync(dir).sort()) {
        if (!name.endsWith(testSuffix)) continue;
        const stem = name.slice(0, -testSuffix.length);
        if (wanted.has(pathKey(stem)) && /^[a-z0-9][a-z0-9_.-]*$/i.test(stem) && !["unit", "integration", "fast", "edge"].includes(stem.toLowerCase()) &&
          inspectSpecPath(path.join(dir, name))?.isFile()) found.add(stem);
        if (found.size === 3) return [...found];
      }
    } catch { /* Optional navigation. */ }
  }
  return [...found];
}

const PROBE_SKIP_DIRS = new Set([
  "spec-archive",
  ".git", "node_modules", ".venv", "venv", "__pycache__", "target", "build", "out", ".next", "vendor",
  ".agent-studio", "dist", "coverage", "worktrees", "test-runs", "sandbox-runs", "tmp", "councils", "logs", "00-plugin",
]);

function hasGitAncestor(root) {
  const sandbox = process.env.AGENT_TOWER_TEST_ROOT ? path.resolve(process.env.AGENT_TOWER_TEST_ROOT) : "";
  let cur = path.resolve(root);
  while (cur) {
    if (sandbox && inside(sandbox, path.resolve(root)) && path.relative(sandbox, cur) === "") return false;
    try { if (fs.existsSync(path.join(cur, ".git"))) return true; } catch { return false; }
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
  return false;
}

export function collectWorkspaceFiles(root, limit = 8000) {
  try { if (!inspectSpecPath(root)?.isDirectory()) return { files: [], partial: true }; }
  catch { return { files: [], partial: true }; }
  if (hasGitAncestor(root)) {
    const out = readOnlyGit(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (out !== null) {
      const files = out.split("\0").map(file => posix(file.trim())).filter(file =>
        file && !file.startsWith(".agent-tower/councils/") && !file.startsWith(".agent-tower/spec/00-plugin/"));
      return { files, partial: false };
    }
  }
  const files = [];
  let partial = false;
  function walk(absDir, relDir, depth) {
    if (files.length >= limit) { partial = true; return; }
    if (depth > 12) { partial = true; return; }
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { partial = true; return; }
    for (const entry of entries) {
      if (files.length >= limit) { partial = true; break; }
      const name = entry.name;
      if (name.includes("\\") || entry.isSymbolicLink()) continue;
      const childAbs = path.join(absDir, name);
      let lstat;
      try { lstat = fs.lstatSync(childAbs); } catch { continue; }
      if (lstat.isSymbolicLink()) continue;
      if (lstat.isDirectory()) {
        if (PROBE_SKIP_DIRS.has(name.toLowerCase())) continue;
        walk(childAbs, relDir ? `${relDir}/${name}` : name, depth + 1);
      } else if (lstat.isFile()) {
        files.push(relDir ? `${relDir}/${name}` : name);
      }
    }
  }
  walk(root, "", 0);
  return { files, partial };
}

export function resolveSpecTestExists(root, entry, repoFiles) {
  if (typeof entry !== "string" || !entry.trim() || /[\0\r\n]/.test(entry)) return false;
  const raw = posix(entry.trim()).replace(/^\.\//, "");
  if (!raw || raw.startsWith("/") || raw.split("/").includes("..")) return false;
  if (/[*?[\]]/.test(raw)) {
    const list = repoFiles ?? collectWorkspaceFiles(root).files;
    return list.some(file => matchSpecGlob(file, raw));
  }
  if (raw.includes("/") || /\.[a-z0-9]+$/i.test(raw)) {
    try { if (inspectSpecPath(path.join(root, raw))?.isFile()) return true; } catch { return false; }
    if (!raw.includes("/") && /\.test\.mjs$/i.test(raw)) {
      const stem = raw.slice(0, -".test.mjs".length);
      return ["unit", "integration"].some(suite => {
        try { return Boolean(inspectSpecPath(path.join(root, "tests", suite, `${stem}.test.mjs`))?.isFile()); }
        catch { return false; }
      });
    }
    return false;
  }
  if (!/^[\w.-]+$/.test(raw)) return false;
  const inNodeSuite = ["unit", "integration"].some(suite => {
    try { return Boolean(inspectSpecPath(path.join(root, "tests", suite, `${raw}.test.mjs`))?.isFile()); }
    catch { return false; }
  });
  if (inNodeSuite) return true;
  const list = repoFiles ?? collectWorkspaceFiles(root).files;
  const stemPattern = new RegExp(`(?:^|/)(?:${quoteRegex(raw)}\\.(?:test|spec)\\.[a-z0-9]+|test_${quoteRegex(raw)}\\.[a-z0-9]+|${quoteRegex(raw)}_test\\.[a-z0-9]+)$`, "i");
  return list.some(file => stemPattern.test(file));
}

export function recentChangedPaths(root, curatedHead = "") {
  if (!root || !hasGitAncestor(root)) return [];
  const filterNoise = file => file && !file.startsWith(".agent-tower/councils/") && !file.startsWith(".agent-tower/plans/") &&
    !file.startsWith(".agent-tower/conversations/") && !file.startsWith(".agent-tower/spec/00-plugin/") && !file.startsWith("tmp/");
  const dirty = (readOnlyGit(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]) ?? "")
    .split("\0").filter(Boolean).map(record => posix(record.slice(3).trim()));
  let committed = null;
  if (typeof curatedHead === "string" && /^[0-9a-f]{7,40}$/i.test(curatedHead.trim())) {
    const sinceHead = readOnlyGit(root, ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", `${curatedHead.trim()}..HEAD`, "--"]);
    if (sinceHead !== null) committed = sinceHead.split("\0").filter(Boolean).map(file => posix(file.trim()));
  }
  if (committed === null) {
    committed = (readOnlyGit(root, ["diff-tree", "--root", "-r", "--first-parent", "-m", "--no-commit-id", "--name-only", "-z", "HEAD", "--"]) ?? "")
      .split("\0").filter(Boolean).map(file => posix(file.trim()));
  }
  return [...new Set([...dirty, ...committed].map(file => normalizeTargetPath(root, file)).filter(filterNoise))];
}

function scanSuspectedDeadSymbols(root, specs, files) {
  if (!hasGitAncestor(root) || !specs.length) return [];
  const fileSet = new Set(files.map(pathKey));
  const candidates = new Map();
  for (const spec of specs) {
    for (const [, raw] of spec.body.matchAll(/`([^`\r\n]{4,64})`/g)) {
      const tok = raw.trim().replace(/[(),:;]+$/, "");
      if (!tok || /[\s*?<>[\]{}|"'=\\]|(?:\.\.\.|xxx|todo)/i.test(tok)) continue;
      if (/^(?:https?:|sidecar:|file:|v\d+\.|--|\d)/i.test(tok)) continue;
      if (!/[a-z]/i.test(tok) || !(/[\/_.-]/.test(tok.slice(1, -1)) || /[a-z][A-Z]/.test(tok))) continue;
      const norm = tok.replace(/^\.\//, "").replace(/\/$/, "");
      if (fileSet.has(pathKey(norm)) || files.some(f => pathKey(f).startsWith(`${pathKey(norm)}/`))) continue;
      if ((spec.tests || []).some(t => t.toLowerCase() === norm.toLowerCase()) || resolveSpecTestExists(root, norm, files)) continue;
      let owners = candidates.get(tok);
      if (!owners) candidates.set(tok, owners = new Set());
      owners.add(spec.key);
      if (candidates.size >= 72) break;
    }
    if (candidates.size >= 72) break;
  }
  if (!candidates.size) return [];
  const tokens = [...candidates.keys()];
  const sandbox = process.env.AGENT_TOWER_TEST_ROOT;
  const ceiling = root && sandbox && inside(path.resolve(sandbox), path.resolve(root))
    ? { GIT_CEILING_DIRECTORIES: path.resolve(sandbox) } : {};
  const grepRes = spawnSync("git", ["--no-optional-locks", "grep", "--untracked", "-h", "-o", "-F", "-I",
    ...tokens.flatMap(tok => ["-e", tok]),
    "--", ".", ":!.agent-tower/spec", ":!.agent-tower/docs", ":!.agent-tower/councils", ":!.agent-tower/plans"], {
    cwd: root, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...ceiling }, encoding: "utf8", timeout: 5000, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
  });
  if (grepRes.status !== 0 && grepRes.status !== 1) return [];
  const hit = new Set((grepRes.stdout || "").split(/\r?\n/).filter(Boolean));
  const dead = [];
  for (const [tok, owners] of candidates) {
    if (!hit.has(tok)) dead.push(`${[...owners].join(",")} => \`${tok}\``);
    if (dead.length >= 6) break;
  }
  return dead;
}

export function buildCuratorStaticProbe(root, { curatedHead = "", specLimits } = {}) {
  if (!root || !path.isAbsolute(root) || restricted(root)) return "";
  const limits = normalizeSpecQuotaLimits(specLimits);
  const specs = readProjectSpecs(root).specs.filter(spec => PROJECT_KINDS.includes(spec.kind));
  const changed = recentChangedPaths(root, curatedHead);
  if (!specs.length && !changed.length) return "";
  const { files, partial } = specs.length ? collectWorkspaceFiles(root) : { files: [], partial: false };
  const drift = [], dead = [], highWater = [];
  let totalBytes = 0, bizCount = 0, codCount = 0, reqCount = 0;
  for (const spec of specs) {
    totalBytes += spec.bytes;
    if (spec.kind === "business") bizCount++;
    else if (spec.kind === "coding") codCount++;
    if (spec.required) reqCount++;
    const hitFiles = changed.filter(file => file !== spec.relPath && spec.scopes.some(glob => matchSpecGlob(file, glob)));
    if (hitFiles.length) drift.push(`${spec.key} (${spec.relPath}) <= ${hitFiles.slice(0, 3).join(", ")}`);
    const deadScopes = spec.scopes.filter(glob => !files.some(file => matchSpecGlob(file, glob)));
    const deadTests = (spec.tests || []).filter(entry => !resolveSpecTestExists(root, entry, files));
    if (deadScopes.length || deadTests.length) {
      const parts = [
        deadScopes.length && `scopes=${JSON.stringify(deadScopes.slice(0, 3))}`,
        deadTests.length && `tests=${JSON.stringify(deadTests.slice(0, 3))}`,
      ].filter(Boolean).join(" ");
      dead.push(`${spec.key} (${spec.relPath}): ${parts}`);
    }
    if (spec.bytes >= limits.highWaterBytes) highWater.push(`${spec.key} (${spec.bytes}B/${limits.singleMaxBytes}B)`);
  }
  const deadSymbols = specs.length ? scanSuspectedDeadSymbols(root, specs, files) : [];
  const deadLabel = partial ? "待核实未命中路标候选（文件扫描部分截断，请点读确认）" : "失效死路标告警（匹配不到真实文件或单测，请修正或删废规）";
  const lines = [
    specs.length && `- 规范总水位：共 ${specs.length} 篇（业务 ${bizCount}/16、编码 ${codCount}/10，必读 ${reqCount} 篇），单篇上限 ${limits.singleMaxBytes}B，总正文 ${totalBytes}B / ${limits.totalMaxBytes}B（${Math.round((totalBytes * 100) / limits.totalMaxBytes)}%）`,
    changed.length && `- 近期变更文件(${changed.length})：${changed.slice(0, 10).join(", ")}${changed.length > 10 ? " ..." : ""}`,
    drift.length && `- 疑似漂移规范（改动命中 scopes，请优先核对是否冲突过期）：${drift.slice(0, 6).join("；")}`,
    dead.length && `- ${deadLabel}：${dead.slice(0, 6).join("；")}`,
    deadSymbols.length && `- 疑似失效代码符号（源码未搜到该反引号标识符，请核实是否已改名/废弃，勿盲删示例）：${deadSymbols.join("；")}`,
    highWater.length && `- 高水位容量预警（>=${limits.highWaterBytes}B，净增或删行须执行 One-In-One-Out 并在 mergedOrRemoved 写明依据）：${highWater.slice(0, 8).join("、")}`,
  ].filter(Boolean);
  return lines.length ? `[CURATOR STATIC PROBE]\n${lines.join("\n")}` : "";
}

function buildFallbackRoutingCatalog(specs, roleName) {
  const candidates = specs.filter(spec => PROJECT_KINDS.includes(spec.kind) && spec.roles.includes(roleName));
  if (!candidates.length) return "";
  const head = "[SPEC ROUTING CATALOG] 本单未直接命中项目规范，若涉及以下模块请先按路径查阅：";
  const lines = [];
  const clean = text => String(text || "").replace(/[\r\n\t]+/g, " ").trim();
  for (const [idx, spec] of candidates.entries()) {
    const rawTitle = spec.title && spec.title !== spec.id ? clean(spec.title) : "";
    const shortTitle = rawTitle ? ` · ${rawTitle.length > 24 ? `${rawTitle.slice(0, 23)}…` : rawTitle}` : "";
    const shortScopes = spec.scopes.length ? ` · scopes: ${spec.scopes.slice(0, 3).join(", ")}${spec.scopes.length > 3 ? ", …" : ""}` : "";
    const line = `- ${spec.key}${spec.required ? " [必读]" : ""}${shortTitle}${shortScopes} (${spec.relPath})`;
    const rest = candidates.length - idx - 1;
    const overflow = rest ? [`- 另有 ${rest} 份规范，查阅 .agent-tower/spec/INDEX.md。`] : [];
    if (bytes([head, ...lines, line, ...overflow].join("\n")) > 1536) {
      lines.push(`- 另有 ${rest + 1} 份规范，查阅 .agent-tower/spec/INDEX.md。`);
      break;
    }
    lines.push(line);
  }
  return [head, ...lines].join("\n");
}

export function assembleSpecPrompt({ inventory, cwd, repoRoot = cwd, role, rawPrompt, dynamicPrompt, selection, review, transport, ledger, planDoc, controlDir, curatedHead = "", curatorContext = "", specLimits, specEnabled = true }) {
  const limits = normalizeSpecQuotaLimits(specLimits);
  const roleName = normalizeSpecRole(role);
  const curate = roleName === "curator";
  const { specs, warnings: inventoryWarnings } = curate || !specEnabled ? { specs: [], warnings: [] } : inventory;
  if (curate) { ledger = undefined; selection = undefined; planDoc = null; }
  const warnings = [...inventoryWarnings];
  selection = specSelection(selection, { cwd, repoRoot, controlDir, warnings });
  const ids = new Set(selection.specIds);
  const target = selection.targetPaths.map(p => {
    const rel = normalizeTargetPath(cwd, p) || (repoRoot === cwd ? null : normalizeTargetPath(repoRoot, p));
    if (!rel) warnings.push(warning("INVALID_TARGET_PATH", p, "路径必须位于项目内，且不能包含 ..。"));
    return rel;
  }).filter(Boolean);
  const hasExplicitScope = Boolean(ids.size || target.length);
  const changed = specs.length && review ? reviewDiffPaths(cwd, review) : [];
  const readOnlyPaths = selection.readPaths;
  const readOnlyKeys = new Set(readOnlyPaths.map(pathKey));
  const isWeak = reason => reason === "read_path" || (hasExplicitScope && (reason === "text_path" || reason === "tag"));
  const mentions = (rawPrompt.match(/[^\s`'"<>()[\]{},;，。；：、（）【】《》“”‘’｜|]+[\\/][^\s`'"<>()[\]{},;，。；：、（）【】《》“”‘’｜|]+|\b[\w.-]+\.[\w-]+\b/g) ?? [])
    .filter(token => !path.isAbsolute(posix(token)))
    .map(token => normalizeTargetPath(cwd, token.replace(/[.:!?]+$/, "")))
    .filter(file => file && !readOnlyKeys.has(pathKey(file)));
  const codingFirst = ["executor", "review"].includes(roleName);
  const matched = [];
  for (const id of ids) if (!specs.some(spec => id === spec.id || id === spec.key)) warnings.push(warning("SPEC_NOT_FOUND", id, `未找到规范 ${id}`));
  for (const spec of specs) {
    if (!spec.roles.includes(roleName)) continue;
    const scopeMatch = paths => paths.some(file => spec.scopes.some(glob => matchSpecGlob(file, glob)));
    const reason = ids.has(spec.key) || ids.has(spec.id) ? "explicit" : scopeMatch(target) ? "target_path"
      : scopeMatch(changed) ? "diff_path" : scopeMatch(readOnlyPaths) ? "read_path" : scopeMatch(mentions) ? "text_path"
        : spec.tags.some(tag => matchSpecTag(rawPrompt, tag)) ? "tag" : "";
    if (reason) matched.push({ ...spec, reason });
  }
  const priorities = ["explicit", "target_path", "diff_path", "read_path", "text_path", "tag"];
  matched.sort((a, b) => Number(b.required) - Number(a.required) || Number(Boolean(b.draftOnly)) - Number(Boolean(a.draftOnly)) ||
    priorities.indexOf(a.reason) - priorities.indexOf(b.reason) ||
    (codingFirst && a.kind !== b.kind ? (a.kind === "coding" ? -1 : a.kind === "business" && b.kind === "coding" ? 1 : 0) : 0) ||
    a.key.localeCompare(b.key));
  const docs = projectDocFlags(cwd, repoRoot);
  const plugin = pluginSpec(roleName, { ...docs, specLimits: limits, specEnabled });
  // Per-task navigation never participates in spec/session deduplication.
  const rows = curate ? [] : evolutionRows(cwd, repoRoot, docs.evolutionPath, target, rawPrompt);
  const stems = curate ? [] : quickTestStems(repoRoot, roleName, target, matched);
  const probe = curate && transport !== "argv" ? buildCuratorStaticProbe(repoRoot || cwd, { curatedHead, specLimits: limits }) : "";
  const extraCurator = curate && transport !== "argv" && curatorContext ? curatorContext.trim() : "";
  const navigation = [
    probe,
    extraCurator,
    readOnlyPaths.length && `[READ-ONLY REFERENCES] ${readOnlyPaths.map(file => JSON.stringify(file)).join(", ")}`,
    rows.length && `[EVOLUTION MATCHES] ${docs.evolutionPath}\n${rows.join("\n")}`,
    stems.length && `关联快测：node scripts/test.mjs ${stems.join(" ")}`,
  ].filter(Boolean).map(escapeBlock).join("\n\n");
  const sendPrompt = navigation ? `${navigation}\n\n${dynamicPrompt}` : dynamicPrompt;
  const entries = [...(plugin ? [plugin] : []), ...matched];
  function render(previous) {
    const chunks = [];
    const items = [];
    const delivered = [];
    const issues = [...warnings];
    const argv = transport === "argv";
    const cost = text => bytes(escapeBlock(text)) + 2;
    const directoryHint = "其余规范见 .agent-tower/spec/。";
    const requiredHint = matched.some(entry => entry.required && !isWeak(entry.reason)) ? "【必读规范】" :
      matched.some(entry => entry.required) ? "【若涉及此模块必读】" : "";
    const argvHint = `${requiredHint}其余约定请按 .agent-tower/spec/INDEX.md 查阅。`;
    const hasProjectEntries = specEnabled && (matched.length > 0 || Boolean(previous?.size));
    const disabledNotice = "【项目规范已停用】此前由 AgentTower 注入的 .agent-tower/spec/ 项目规范自本轮起不再适用。";
    const disabledReceipts = specEnabled || !previous ? [] : [...previous].filter(([key, old]) => (/^(?:business|coding)\//.test(key) || key === "plugin/spec-catalog") && old.tier !== "revoked")
      .map(([key]) => ({ key, sha256: "revoked", tier: "revoked" }));
    const pluginReused = plugin && previous?.get(plugin.key)?.sha256 === plugin.sha256 && previous.get(plugin.key).tier === "inline";
    const argvReserve = (entries.length || hasProjectEntries || disabledReceipts.length ? bytes(block([""])) - 2 : 0) + (hasProjectEntries ? cost(argvHint) : 0);
    const plan = assemblePlanPrompt({ cwd, repoRoot, planDoc: planDoc ?? null, role, ledger: previous, transport,
      remainingBytes: argv ? ARGV_BUDGET - argvReserve - (plugin && !pluginReused ? cost(plugin.body) : 0) - (disabledReceipts.length ? cost(disabledNotice) : 0) : undefined });
    issues.push(...plan.warnings);
    let budget = argv ? Math.max(0, ARGV_BUDGET - argvReserve - bytes(plan.prompt)) : limits.totalMaxBytes;
    let argvCapped = false;
    function addArgvChunk(text) {
      const size = cost(text);
      if (size > budget) { argvCapped = true; return false; }
      budget -= size;
      chunks.push(text);
      return true;
    }
    const revocations = [];
    if (previous) {
      const activeByKey = new Map(specs.map(spec => [spec.key, spec]));
      const matchedKeys = new Set(matched.map(({ key }) => key));
      for (const [key, old] of previous) {
        if (key.startsWith("plugin/") || key.startsWith("plan/") || old.tier === "revoked") continue;
        const receipt = { key, sha256: "revoked", tier: "revoked" };
        if (!/^(?:plugin|plan|business|coding)\//.test(key)) {
          delivered.push(receipt);
          continue;
        }
        if (!specEnabled) continue;
        const active = activeByKey.get(key);
        if (!active) {
          revocations.push({ text: `【规范已废止】${key} 已从项目活跃规范中移除，本轮起不再适用。`,
            receipt: { key, sha256: "revoked", tier: "revoked" } });
        } else if (!matchedKeys.has(key) && (active.sha256 !== old.sha256 || !active.roles.includes(roleName))) {
          revocations.push({ text: `【规范已变更】${key} 内容或适用范围已更新且本轮未命中，此前投递的旧版本不再适用。`,
            receipt: { key, sha256: "revoked", tier: "revoked" } });
        }
      }
    }
    if (disabledReceipts.length) {
      if (!argv) chunks.push(disabledNotice);
      if (!argv || addArgvChunk(disabledNotice)) delivered.push(...disabledReceipts);
    }
    if (!argv) for (const { text, receipt } of revocations) { chunks.push(text); delivered.push(receipt); }
    const summaries = [];
    for (const entry of entries) {
      const { key, id, title, kind, required, reason, relPath } = entry;
      const plugin = kind === "plugin";
      const header = `### ${key} — ${title} (${relPath})\n`;
      const inline = plugin ? entry.body : `${header}${entry.body}`;
      const weak = isWeak(reason);
      const inlineBytes = argv ? cost(inline) : bytes(escapeBlock(inline));
      const canInline = plugin || (!weak &&
        (required || reason === "explicit" || entry.draftOnly || entry.bytes <= limits.singleMaxBytes) && inlineBytes <= budget && !(required && argv));
      const needsPointer = !weak && required;
      let tier = canInline ? "inline" : needsPointer ? "pointer_degraded" : "summary";
      const old = previous?.get(key);
      if (old?.sha256 === entry.sha256 && equivalentTier(old.tier, tier)) tier = "reused";
      if (tier !== "reused") {
        let text;
        let summaryPathOnly = false;
        if (tier === "inline") {
          text = inline;
          if (!argv) budget = Math.max(0, budget - inlineBytes);
        } else if (tier === "pointer_degraded") {
          const reference = entry.draftOnly ? path.join(repoRoot, relPath) : relPath;
          const pointer = `【必读规范】动工前请务必先完整读取 ${reference}`;
          text = `${pointer}：${entry.summary}`;
          let detail = `必读规范 ${relPath} 因内联预算或传输限制降级。`;
          if (entry.draftOnly) {
            detail += "该主仓草稿无法在隔离工作树按相对路径读取。";
            text += "\n【告警】该主仓草稿无法在当前工作树读取。";
            const excerpt = argv ? "" : truncate(entry.body, Math.min(1024, budget));
            if (excerpt) { text += `\n草稿片段：${excerpt}`; budget -= bytes(excerpt); }
          }
          if (argv && cost(text) > budget) text = pointer;
          issues.push(warning("REQUIRED_BUDGET_DEGRADED", key, detail));
        } else {
          const conditional = weak && required ? "【若涉及此模块必读】" : "";
          const reference = entry.draftOnly ? path.join(repoRoot, relPath) : relPath;
          const pointer = `${conditional}${reference}`;
          text = `${conditional}${header}${entry.summary}${entry.draftOnly ? `\n主仓路径：${reference}` : ""}`;
          if (!argv) summaries.push({ slot: chunks.length, text, relPath: pointer, receipt: { key, sha256: entry.sha256, tier } });
          else if (cost(text) > budget) {
            text = pointer;
            summaryPathOnly = true;
          }
        }
        if (argv) {
          if (addArgvChunk(text) && !summaryPathOnly) delivered.push({ key, sha256: entry.sha256, tier });
          else if (curate) throw Object.assign(new Error("argv 无法完整投递规范维护官角色卡"), { code: "CURATOR_ARGV_BUDGET_EXCEEDED" });
        } else {
          chunks.push(text);
          if (tier !== "summary") delivered.push({ key, sha256: entry.sha256, tier });
        }
      }
      items.push({ key, id, title, kind, tier, required, reason, bytes: entry.bytes, sha: entry.sha256.slice(0, 8), relPath });
    }
    // Charge both summaries and their fallback paths, including escaped bytes and separators.
    if (argv) {
      for (const { text, receipt } of revocations) if (addArgvChunk(text)) delivered.push(receipt);
      if (argvCapped && hasProjectEntries && argvReserve + bytes(plan.prompt) <= ARGV_BUDGET) chunks.push(argvHint);
      if (argvCapped) issues.push(warning("ARGV_BUDGET_CAPPED", "spec", "规范投递已达 argv 预算上限。"));
    }
    const pathBytes = summaries.reduce((sum, row) => sum + cost(row.relPath), 0);
    const grouped = pathBytes > 4096;
    let remaining = 4096 - (grouped ? cost(directoryHint) : pathBytes);
    let capped = false;
    for (const row of summaries) {
      const extra = cost(row.text) - (grouped ? 0 : cost(row.relPath));
      if (extra <= remaining) {
        remaining -= extra;
        delivered.push(row.receipt);
      } else {
        chunks[row.slot] = grouped ? "" : row.relPath;
        capped = true;
      }
    }
    if (capped) {
      if (grouped) chunks.push(directoryHint);
      issues.push(warning("SUMMARY_BUDGET_CAPPED", "spec", "摘要与路径总量已达 4 KiB 上限，其余项请按目录查阅。"));
    }
    if (specEnabled && !curate && !argv && plugin && matched.length === 0) {
      const catalogText = buildFallbackRoutingCatalog(specs, roleName);
      if (catalogText) {
        const catalogKey = "plugin/spec-catalog";
        const catalogSha = hash(catalogText);
        const oldCatalog = previous?.get(catalogKey);
        if (!(oldCatalog?.sha256 === catalogSha && oldCatalog.tier === "inline")) {
          chunks.push(catalogText);
          delivered.push({ key: catalogKey, sha256: catalogSha, tier: "inline" });
        }
      }
    }
    const project = items.filter(item => item.kind !== "plugin");
    const count = tier => project.filter(item => item.tier === tier).length;
    const specBlock = block(chunks.filter(Boolean));
    if (curate && argv && bytes(specBlock + sendPrompt) > ARGV_BUDGET) {
      throw Object.assign(new Error("argv 无法完整投递规范维护官角色卡及任务"), { code: "CURATOR_ARGV_BUDGET_EXCEEDED" });
    }
    return { prompt: `${plan.prompt}${specBlock}${sendPrompt}`, delivered: [...plan.delivered, ...delivered], meta: {
      v: 1, planBytes: bytes(plan.prompt), specBytes: bytes(specBlock), deliveredCount: project.length - count("reused"), inlineCount: count("inline"), summaryCount: count("summary"),
      reusedCount: count("reused"), degradedRequiredCount: count("pointer_degraded"), pluginDelivered: delivered.some(item => item.key === plugin?.key),
      ...(plan.item ? { planDelivered: plan.delivered.length > 0 } : {}),
      ledgerState: "pending", items: plan.item ? [plan.item, ...items] : items, warnings: issues,
    } };
  }
  const full = render();
  return { full, delta: ledger?.size ? render(ledger) : full };
}

export function resolveSessionPrompt(prompt, freshSessionPrompt, resumed) {
  if (typeof prompt?.forSession === "function") return String(prompt.forSession(resumed));
  const selected = resumed === false && freshSessionPrompt !== undefined ? freshSessionPrompt : prompt;
  return String((typeof selected === "function" ? selected({ resumed }) : selected) ?? "");
}

export function buildDerivedSpecIndex(specs) {
  const lines = ["# 项目规范", ""];
  for (const [kind, label] of [["business", "业务规范"], ["coding", "编码规范"]]) {
    const dir = CATEGORIES[kind].slice(SPEC_ROOT.length + 1);
    lines.push(`- [${label}](${dir}/)`);
    for (const spec of specs.filter(spec => spec.kind === kind).sort((a, b) => a.relPath.localeCompare(b.relPath))) {
      const title = spec.title.replace(/\s+/g, " ").replace(/[\\\[\]<>`]/g, "\\$&");
      const rel = spec.relPath.slice(SPEC_ROOT.length + 1).split("/")
        .map(part => encodeURIComponent(part).replace(/\(/g, "%28").replace(/\)/g, "%29")).join("/");
      lines.push(`  - [${title}](${rel}) · ${spec.required ? "必读" : "选读"}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function refreshFile(file, content, old) {
  if (!inspectSpecPath(path.dirname(file))?.isDirectory()) throw new Error(`Missing directory: ${path.dirname(file)}`);
  const tmp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(tmp, "wx");
  try {
    try { fs.writeFileSync(fd, content); }
    finally { fs.closeSync(fd); }
    if (readFile(file) !== old || (old === null && inspectSpecPath(file))) throw new Error(`File changed during refresh: ${file}`);
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

function mirrorFiles(root, version) {
  const docs = projectDocFlags(root);
  const cards = Object.keys(ROLE_SYSTEM_PREFIXES).map(role => pluginSpec(role, docs));
  const digest = hash(cards.map(card => card.sha256).join("\n"));
  return [["README.md", `# AgentTower 插件规范只读镜像\n\n版本 ${version} · ${digest}\n\n由插件内存模板生成。项目规范请放入 01-business 或 02-coding。\n`],
    ...cards.map(card => [`${card.id}.md`, `${card.body}\n`])];
}

export function syncPluginMirror(root, version, { initialize = false, createdPaths = [], refreshedPaths = [], preservedPaths = [] } = {}) {
  const dir = path.join(root, MIRROR_ROOT);
  if (!inspectSpecPath(path.join(root, SPEC_ROOT, "INDEX.md"))?.isFile() ||
      ![CATEGORIES.business, CATEGORIES.coding].every(rel => inspectSpecPath(path.join(root, rel))?.isDirectory())) return;
  if (!inspectSpecPath(dir)) fs.mkdirSync(dir);
  const obsolete = path.join(dir, "research.md");
  if (inspectSpecPath(obsolete)?.isFile()) fs.unlinkSync(obsolete);
  for (const [name, content] of mirrorFiles(root, version)) {
    const file = path.join(dir, name);
    const rel = `${MIRROR_ROOT}/${name}`;
    const old = readFile(file);
    if (old === content) { preservedPaths.push(rel); continue; }
    if (old === null && inspectSpecPath(file)) { preservedPaths.push(rel); continue; }
    if (old === null) fs.writeFileSync(file, content, { flag: "wx" });
    else refreshFile(file, content, old);
    (old === null ? createdPaths : refreshedPaths).push(rel);
  }
}

const SCAFFOLD_DIRS = [SPEC_ROOT, CATEGORIES.business, CATEGORIES.coding, MIRROR_ROOT];
const INDEX_PATH = `${SPEC_ROOT}/INDEX.md`;

function checkScaffoldPaths(root, version) {
  for (const rel of SCAFFOLD_DIRS) {
    const target = path.join(root, rel);
    const st = inspectSpecPath(target);
    if (st && !st.isDirectory()) throw new Error(`Not a directory: ${target}`);
  }
  for (const rel of [".gitignore", ".agent-tower/.gitignore", INDEX_PATH]) {
    const stat = inspectSpecPath(path.join(root, rel));
    if (stat && !stat.isFile()) throw new Error(`Not a file: ${rel}`);
  }
  for (const [name] of mirrorFiles(root, version)) inspectSpecPath(path.join(root, MIRROR_ROOT, name));
}

export function syncProjectSpecScaffold(root, version, { specs } = readProjectSpecs(root), { preserveIndex = false } = {}) {
  if (!specs.some(spec => PROJECT_KINDS.includes(spec.kind))) {
    // Only an existing generated listing needs refreshing after the final card disappears.
    const index = path.join(root, INDEX_PATH);
    const old = readFile(index);
    if (!preserveIndex && old?.startsWith("# 项目规范\n\n- [业务规范](01-business/)\n") && old.includes("\n  - [")) {
      refreshFile(index, buildDerivedSpecIndex([]), old);
    }
    syncPluginMirror(root, version); // Compatibility for already initialized, empty checkouts.
    return;
  }
  checkScaffoldPaths(root, version);
  ensureStorageIgnoreRules(root, { ensureRoot: true });
  for (const rel of SCAFFOLD_DIRS) {
    const target = path.join(root, rel);
    if (!inspectSpecPath(target)) fs.mkdirSync(target, { recursive: true });
  }
  const index = path.join(root, INDEX_PATH);
  const old = readFile(index);
  const content = buildDerivedSpecIndex(specs);
  if (old !== content && (!preserveIndex || old === null)) refreshFile(index, content, old);
  syncPluginMirror(root, version);
}

export function materializeProjectSpecs(root, version) {
  const createdPaths = [], refreshedPaths = [], preservedPaths = [];
  checkScaffoldPaths(root, version);
  ensureStorageIgnoreRules(root, { ensureRoot: true });
  for (const rel of SCAFFOLD_DIRS) {
    const target = path.join(root, rel);
    if (inspectSpecPath(target)) preservedPaths.push(rel);
    else { fs.mkdirSync(target); createdPaths.push(rel); }
  }
  const index = path.join(root, INDEX_PATH);
  if (inspectSpecPath(index)) preservedPaths.push(INDEX_PATH);
  else {
    fs.writeFileSync(index, buildDerivedSpecIndex(readProjectSpecs(root).specs), { flag: "wx" });
    createdPaths.push(INDEX_PATH);
  }
  syncPluginMirror(root, version, { initialize: true, createdPaths, refreshedPaths, preservedPaths });
  return { createdPaths, refreshedPaths, preservedPaths };
}

export function projectSpecStatus(root, { specId, includeBody = false, repoRoot = root, version = "", specLimits, specEnabled = true } = {}) {
  const limits = normalizeSpecQuotaLimits(specLimits);
  const inventory = specEnabled ? readProjectSpecs(root, repoRoot) : { specs: [], warnings: [] };
  const warnings = inventory.warnings;
  const exists = (rel, directory = false) => {
    if (!specEnabled) return false;
    try {
      const st = inspectSpecPath(path.join(root, rel));
      return Boolean(directory ? st?.isDirectory() : st?.isFile());
    } catch (error) {
      warnings.push(warning("UNSAFE_SPEC_PATH", rel, error.message));
      return false;
    }
  };
  const docs = projectDocFlags(root, repoRoot);
  const mirrorCards = Object.keys(ROLE_SYSTEM_PREFIXES).map(role => pluginSpec(role, docs));
  const pluginCards = Object.keys(ROLE_SYSTEM_PREFIXES).map(role => pluginSpec(role, { ...docs, specLimits: limits, specEnabled }));
  const pluginSpecs = pluginCards.map(card => {
    const { key, id, kind, title, summary, relPath, bytes, body } = card;
    return { key, id, kind, title, summary, relPath, bytes, materialized: exists(relPath),
      ...(includeBody && (!specId || specId === key || specId === id) ? { body } : {}) };
  });
  const counts = { plugin: pluginSpecs.length, business: 0, coding: 0, total: inventory.specs.length };
  let totalProjectBytes = 0;
  for (const spec of inventory.specs) {
    counts[spec.kind]++;
    if (PROJECT_KINDS.includes(spec.kind)) {
      totalProjectBytes += spec.bytes;
      if (spec.bytes > limits.singleMaxBytes) {
        warnings.push(warning("SPEC_SIZE_SOFT_LIMIT", spec.key, `规范 ${spec.relPath} 正文 ${spec.bytes} B 超过 ${limits.singleMaxBytes.toLocaleString("en-US")} B 上限，请合并压缩。`));
      }
    }
  }
  if (totalProjectBytes > limits.totalMaxBytes) {
    warnings.push(warning("SPEC_SIZE_SOFT_LIMIT", "total", `项目活跃规范总正文 ${totalProjectBytes} B 超过 ${limits.totalMaxKb} KiB 建议上限，请精简合并。`));
  }
  const specs = inventory.specs.filter(spec => !specId || specId === spec.id || specId === spec.key).map(spec => {
    const { roles, draftOnly, body, ...display } = spec;
    return includeBody ? { ...display, body } : display;
  });
  const initialized = exists(`${SPEC_ROOT}/INDEX.md`) && exists(CATEGORIES.business, true) && exists(CATEGORIES.coding, true);
  const pluginMaterialized = exists(`${MIRROR_ROOT}/README.md`) && pluginSpecs.every(spec => spec.materialized);
  const pluginVersion = version ? String(version) : "";
  let pluginMirrorUpToDate = false;
  if (pluginMaterialized) {
    const expected = pluginVersion ? mirrorFiles(root, pluginVersion)
      : mirrorCards.map(card => [path.basename(card.relPath), `${card.body}\n`]);
    try { pluginMirrorUpToDate = expected.every(([name, content]) => readFile(path.join(root, MIRROR_ROOT, name)) === content); }
    catch { pluginMirrorUpToDate = false; }
  }
  return { workspace: repoRoot, specEnabled, initialized, pluginMaterialized, pluginMirrorUpToDate,
    ...(pluginVersion ? { pluginVersion } : {}), totalProjectBytes, specLimits: limits, counts, specs, pluginSpecs, warnings };
}

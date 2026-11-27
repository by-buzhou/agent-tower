import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export const nativePath = (p) =>
  path.resolve(p).replace(/^[a-z]:/, (s) => s.toUpperCase());
export function inside(root, target) {
  const rel = path.relative(root, target);
  return (
    rel !== "" &&
    rel !== ".." &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}
// Sensitive locations are refused precisely instead of blocking whole drives: ordinary project folders such as
// `C:\Users\<user>\code\app` or `D:\work\repo` are allowed.
const SENSITIVE_PATTERNS = [
  /^[a-z]:\/?$/, // drive roots (C:\, D:\ ...)
  /^\/$/, // POSIX filesystem root
  /^[a-z]:\/(?:windows|program files|program files \(x86\)|programdata)(?:\/|$)/, // OS / program directories
  /^[a-z]:\/users\/?$/, // the profiles container itself
  /^[a-z]:\/users\/[^/]+\/?$/, // a user's home root itself (its sub-folders stay allowed)
  /^\/(?:home|users)\/[^/]+\/?$/, // POSIX home roots
  /^\/(?:home|users)\/?$/,
  /^(?:[a-z]:\/users|\/(?:home|users))\/[^/]+\/(?:appdata\/local\/temp|desktop)(?:\/|$)/, // per-user roots only
  /(?:^|\/)\.gemini\/antigravity(?:-cli)?\/plugin_data(?:\/|$)/, // plugin control plane
  /(?:^|\/)\.gemini\/config\/plugins(?:\/|$)/, // mounted plugin installations
  /^\/tmp(?:\/|$)/,
  /^\/var\/tmp(?:\/|$)/,
];
const windowsDevicePath = p => process.platform === "win32" && /^[\\/]{2}[?.][\\/]/.test(p);
const realOrSelf = p => {
  try { return nativePath(fs.realpathSync.native(p)); } catch { return nativePath(p); }
};
export function restricted(p, controlDir) {
  if (windowsDevicePath(p)) return true;
  const candidate = nativePath(p);
  const s = candidate.replaceAll("\\", "/").toLowerCase();
  return (
    SENSITIVE_PATTERNS.some((re) => re.test(s)) ||
    [controlDir, process.env.TEMP, process.env.TMP, process.env.TMPDIR]
      .filter(Boolean)
      .some(r => [nativePath(r), realOrSelf(r)].some(root => path.relative(root, candidate) === "" || inside(root, candidate)))
  );
}
export function resolveMainRoot(moduleRoot, home = os.homedir()) {
  return restricted(moduleRoot) ? nativePath(path.join(home, ".agent-tower", "workspace")) : nativePath(moduleRoot);
}

const moduleRoot = nativePath(fileURLToPath(new URL("..", import.meta.url)));
const moduleHome = os.homedir();
export const MAIN_ROOT = resolveMainRoot(moduleRoot, moduleHome);

export function ensureMainRoot() {
  if (MAIN_ROOT !== moduleRoot && !process.env.NODE_TEST_CONTEXT && !process.env.AGENT_TOWER_TEST_ROOT) {
    fs.mkdirSync(child(moduleHome, ".agent-tower", "workspace"), { recursive: true });
  }
  return MAIN_ROOT;
}

// Under the test runner every project root must stay inside `.agent-tower/test-runs/`.
// A bare `node --test` (no runner sandbox) must never touch a real project's `.agent-tower`.
const bareNodeTest = () => Boolean(process.env.NODE_TEST_CONTEXT && !process.env.AGENT_TOWER_TEST_ROOT);
function outsideTestSandbox(p) {
  if (bareNodeTest()) return true;
  const sandbox = process.env.AGENT_TOWER_TEST_ROOT;
  return Boolean(sandbox) && !inside(sandbox, p);
}
/**
 * Explain why a candidate project directory is unusable (or return "" when it is a valid root).
 * Used by fail-closed callers that must not silently fall back to another project.
 */
export function inspectProjectRoot(p, control) {
  if (typeof p !== "string" || !path.isAbsolute(p) ||
      (process.platform === "win32" && /^[\\/](?![\\/])/.test(p))) return { reason: "not_absolute" };
  if (windowsDevicePath(p)) return { reason: "restricted" };
  const root = nativePath(p);
  if (restricted(root, control) || outsideTestSandbox(root)) return { reason: "restricted" };
  try {
    const st = fs.statSync(root, { throwIfNoEntry: false });
    if (!st) return { reason: "missing" };
    if (!st.isDirectory()) return { reason: "not_directory" };
    const real = nativePath(fs.realpathSync.native(root));
    if (restricted(real, control) || outsideTestSandbox(real)) return { reason: "restricted" };
    return { root: real, reason: "" };
  } catch (error) {
    return { reason: error.code === "ENOENT" ? "missing" : "unavailable" };
  }
}
export function rootRejection(p, control) { return inspectProjectRoot(p, control).reason; }
export function safeRoot(p, fallback, control) {
  return inspectProjectRoot(p, control).root ?? (fallback === MAIN_ROOT ? ensureMainRoot() : fallback);
}
// Check each existing component before following it for writes or recursive cleanup.
export function child(root, ...parts) {
  const target = path.resolve(root, ...parts);
  if (!inside(root, target)) throw Error("Path escaped storage root");
  let cur = path.resolve(root);
  for (const part of ["", ...path.relative(root, target).split(path.sep)]) {
    cur = path.join(cur, part);
    if (fs.lstatSync(cur, { throwIfNoEntry: false })?.isSymbolicLink())
      throw Error("Linked storage path refused");
  }
  return target;
}
const AGENT_TOWER_ROOT_BLOCK = [
  "# >>> agent-tower (managed: ignore runtime state, allow committable project specs)",
  ".agent-tower/*",
  "!.agent-tower/spec/",
  ".agent-tower/spec/*",
  "!.agent-tower/spec/INDEX.md",
  "!.agent-tower/spec/01-business/",
  "!.agent-tower/spec/01-business/**",
  "!.agent-tower/spec/02-coding/",
  "!.agent-tower/spec/02-coding/**",
  "!.agent-tower/spec-archive/",
  ".agent-tower/spec-archive/*",
  "!.agent-tower/spec-archive/INDEX.md",
  "!.agent-tower/spec-archive/manifest.json",
  "!.agent-tower/spec-archive/01-business/",
  "!.agent-tower/spec-archive/01-business/**",
  "!.agent-tower/spec-archive/02-coding/",
  "!.agent-tower/spec-archive/02-coding/**",
  "!.agent-tower/docs/",
  "!.agent-tower/docs/**",
  "# <<< agent-tower",
].join("\n");
const SPEC_EXCEPTIONS = [
  "!spec/",
  "!spec/INDEX.md",
  "!spec/01-business/",
  "!spec/01-business/**",
  "!spec/02-coding/",
  "!spec/02-coding/**",
  "!spec-archive/",
  "spec-archive/*",
  "!spec-archive/INDEX.md",
  "!spec-archive/manifest.json",
  "!spec-archive/01-business/",
  "!spec-archive/01-business/**",
  "!spec-archive/02-coding/",
  "!spec-archive/02-coding/**",
  "!docs/",
  "!docs/**",
];
const AGENT_TOWER_RUNTIME_LINES = [
  "# >>> agent-tower-runtime",
  "/.gitignore",
  "conversations/",
  "logs/",
  "test-runs/",
  "worktrees/",
  "tmp/",
  "councils/",
  "plans/",
  "spec/*",
  "spec/00-plugin/",
  "*.sqlite*",
  "*.db*",
  "*.log",
  "*.tmp",
  ...SPEC_EXCEPTIONS,
  "# <<< agent-tower-runtime",
];
function storageIgnoreError(filePath) {
  return Object.assign(new Error("Unsafe storage ignore path: " + filePath), { code: "STORAGE_IGNORE_UNSAFE" });
}
function assertIgnoreFile(filePath) {
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink() || stat?.isDirectory()) throw storageIgnoreError(filePath);
}
function newlineOf(value) { return value.includes("\r\n") ? "\r\n" : "\n"; }
function withNewline(lines, newline) { return lines.join(newline) + newline; }
function replaceManagedBlock(value, start, end, replacement) {
  const startIndex = value.indexOf(start);
  if (startIndex < 0) return null;
  const endIndex = value.indexOf(end, startIndex + start.length);
  if (endIndex < 0) return null;
  let rest = value.slice(endIndex + end.length);
  // A replacement that already ends with a line break absorbs the old one (and any blank lines it piled up),
  // otherwise every rewrite would append another empty line.
  if (/\r?\n$/.test(replacement)) rest = rest.replace(/^(?:\r?\n)+/, "");
  return value.slice(0, startIndex) + replacement + rest;
}
function updateRootIgnore(root, ensureRoot) {
  const filePath = path.join(root, ".gitignore");
  const stat = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (!stat) {
    if (ensureRoot) fs.writeFileSync(filePath, AGENT_TOWER_ROOT_BLOCK + "\n", { flag: "wx" });
    return;
  }
  assertIgnoreFile(filePath);
  const current = fs.readFileSync(filePath, "utf8");
  const newline = newlineOf(current);
  const block = AGENT_TOWER_ROOT_BLOCK.replaceAll("\n", newline);
  let next = replaceManagedBlock(current, "# >>> agent-tower (managed: ignore runtime state, allow committable project specs)", "# <<< agent-tower", block);
  if (next === null) {
    const oldRule = /^[ \t]*\/?\.agent-tower(?:\/\*?)?[ \t]*$/;
    const lines = current.split(/\r?\n/);
    if (lines.some(line => oldRule.test(line))) {
      let replaced = false;
      next = lines.flatMap(line => {
        if (!oldRule.test(line)) return [line];
        if (replaced) return [];
        replaced = true;
        return [block];
      }).join(newline);
    } else {
      if (!ensureRoot) return;
      next = `${current}${current && !current.endsWith("\n") ? newline : ""}${block}${newline}`;
    }
  }
  if (next !== current) fs.writeFileSync(filePath, next);
}
export function ensureStorageIgnoreRules(root, { ensureRoot = false } = {}) {
  const towerRoot = child(root, ".agent-tower");
  fs.mkdirSync(towerRoot, { recursive: true });
  const runtimeFile = child(root, ".agent-tower", ".gitignore");
  assertIgnoreFile(runtimeFile);
  const current = fs.existsSync(runtimeFile) ? fs.readFileSync(runtimeFile, "utf8") : "";
  const newline = newlineOf(current);
  const lines = [...AGENT_TOWER_RUNTIME_LINES];
  const block = withNewline(lines, newline);
  let next = replaceManagedBlock(current, "# >>> agent-tower-runtime", "# <<< agent-tower-runtime", block);
  if (next === null) {
    if (current.trim() === "*") next = block;
    else next = current ? current.replace(/[\s\r\n]*$/, "") + newline + block : block;
  }
  if (next !== current) fs.writeFileSync(runtimeFile, next);
  updateRootIgnore(root, ensureRoot);
}
export function specDir(root, sub = "") {
  return child(root, ".agent-tower", "spec", ...(sub ? [sub] : []));
}
export function studioDir(root, area) {
  if (restricted(root)) throw Error("Restricted project storage path");
  // Root rejection falls back to the default root (the real repository), so the write gate itself must refuse too.
  if (bareNodeTest()) throw Error("Bare node --test refused: run tests through scripts/test.mjs (AGENT_TOWER_TEST_ROOT sandbox)");
  if (
    process.env.AGENT_TOWER_TEST_ROOT &&
    !inside(process.env.AGENT_TOWER_TEST_ROOT, root) &&
    !(
      area === "test-runs" &&
      path.relative(
        process.env.AGENT_TOWER_TEST_ROOT,
        path.join(root, ".agent-tower", "test-runs"),
      ) === ""
    )
  )
    throw Error("Test write outside sandbox");
  // Test and stage scratch allocation must leave the source repository ignore rules intact.
  if (area !== "test-runs") ensureStorageIgnoreRules(root);
  const dir = child(root, ".agent-tower", area);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function atomicJson(file, obj) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
export function rotateLog(root, name, message) {
  const dir = studioDir(root, "logs");
  const file = child(dir, name);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  if (
    (fs.statSync(file, { throwIfNoEntry: false })?.size || 0) +
      Buffer.byteLength(line) >
      5 * 1024 * 1024 &&
    fs.existsSync(file)
  )
    fs.renameSync(file, child(dir, name + ".1"));
  fs.appendFileSync(file, line);
}

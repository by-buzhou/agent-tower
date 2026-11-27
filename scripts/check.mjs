import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { collectWorkspaceFiles, parseFrontmatter, resolveSpecTestExists } from "../core/spec-context.mjs";

export const repo = path.resolve(import.meta.dirname, "..");
const excluded = new Set([".git", ".agent-tower", "node_modules", "tmp", "archive-legacy"]);
const COUNT_MARKER = "__AGENT_TOWER_CHECK_COUNT__=";

function collectFiles(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(file, files);
    else if (/\.m?js$/.test(entry.name)) files.push(file);
  }
  return files;
}

function nearestPackageType(file) {
  let dir = path.dirname(file);
  while (true) {
    const manifest = path.join(dir, "package.json");
    try {
      const type = JSON.parse(fs.readFileSync(manifest, "utf8")).type;
      if (type === "module" || type === "commonjs") return type;
    } catch {}
    const parent = path.dirname(dir);
    if (parent === dir) return "";
    dir = parent;
  }
}

function compileFile(file) {
  const code = fs.readFileSync(file, "utf8");
  const extension = path.extname(file);
  const packageType = extension === ".js" ? nearestPackageType(file) : "";
  const esm = extension === ".mjs" || (extension === ".js" &&
    (packageType === "module" || (packageType !== "commonjs" && /^\s*(?:import|export)\s/m.test(code))));
  try {
    if (esm) new vm.SourceTextModule(code, { identifier: file });
    else new vm.Script(code, { filename: file });
  } catch (error) {
    if (extension === ".js" && esm && packageType !== "module") {
      try {
        new vm.Script(code, { filename: file });
        return;
      } catch {}
    }
    if (esm) {
      const checked = spawnSync(process.execPath, ["--check", file], {
        encoding: "utf8",
        windowsHide: true,
      });
      const detail = String(checked.stderr || "").trim();
      if (detail) throw Error(detail, { cause: error });
    }
    throw error;
  }
}

function assertArchitecture(dir) {
  if (path.resolve(dir) !== repo) return;
  const root = path.join(repo, "core", "orchestrator.mjs");
  const modules = path.join(repo, "core", "orchestrator");
  const source = fs.readFileSync(root, "utf8");
  if (source.trimEnd().split(/\r?\n/).length > 300) throw Error("core/orchestrator.mjs 超过 300 行");

  const files = fs.readdirSync(modules).filter(file => file.endsWith(".mjs"));
  const peers = new Set(files.map(file => path.join(modules, file)));
  const helper = path.join(modules, "helpers.mjs");
  for (const file of [root, ...peers]) {
    const text = fs.readFileSync(file, "utf8");
    const declarations = /^\s*(?:import\s+(?!\()|export\s+(?=[*{]))(?:(?:[\w*$,\s]|\{[^}]*\})+\s+from\s+)?(["'])([^"'\r\n]+)\1/gm;
    for (const [, , specifier] of text.matchAll(declarations)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      if (!fs.statSync(target, { throwIfNoEntry: false })?.isFile()) throw Error(`${file}: 缺少导入 ${specifier}`);
      if (file === root) continue;
      if (target === root) throw Error(`${file}: 子模块不得反向导入组合根`);
      if (peers.has(target) && (file === helper || target !== helper)) {
        throw Error(`${file}: 禁止兄弟模块互导 ${specifier}`);
      }
    }
  }

  const pluginVersion = JSON.parse(fs.readFileSync(path.join(repo, "plugin.json"), "utf8")).version;
  const packageVersion = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")).version;
  if (pluginVersion !== packageVersion) {
    throw Error(`版本不一致：plugin.json=${pluginVersion}，package.json=${packageVersion}`);
  }

  const repoFiles = collectWorkspaceFiles(repo).files;
  for (const sub of ["01-business", "02-coding"]) {
    const specDir = path.join(repo, ".agent-tower", "spec", sub);
    if (!fs.existsSync(specDir)) continue;
    for (const name of fs.readdirSync(specDir).filter(f => f.endsWith(".md"))) {
      const text = fs.readFileSync(path.join(specDir, name), "utf8");
      const { fields } = parseFrontmatter(text);
      for (const raw of fields.tests || []) {
        if (!resolveSpecTestExists(repo, raw, repoFiles)) {
          throw Error(`.agent-tower/spec/${sub}/${name}: tests 登记了不存在的测试 ${raw}`);
        }
      }
    }
  }
}

function checkInCurrentProcess(dir) {
  const files = collectFiles(dir);
  for (const file of files) compileFile(file);
  assertArchitecture(dir);
  return files.length;
}

function fallbackNodeCheck(files) {
  const worker = String.raw`
const { spawn } = require("node:child_process");
const os = require("node:os");
const files = process.argv.slice(1);
let cursor = 0;
let failed = false;
const workers = Array.from({ length: Math.min(Math.max(1, os.availableParallelism?.() || os.cpus().length || 1), files.length) }, async () => {
  while (cursor < files.length) {
    const file = files[cursor++];
    await new Promise(resolve => {
      const child = spawn(process.execPath, ["--check", file], { stdio: "inherit", windowsHide: true });
      child.once("error", () => { failed = true; resolve(); });
      child.once("close", code => { if (code !== 0) failed = true; resolve(); });
    });
  }
});
Promise.all(workers).then(() => { process.exitCode = failed ? 1 : 0; });
`;
  const result = spawnSync(process.execPath, ["-e", worker, ...files], {
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error || result.status !== 0) throw result.error || Error("语法校验失败");
}

export function check(dir = repo) {
  if (typeof vm.SourceTextModule === "function") return checkInCurrentProcess(dir);
  const files = collectFiles(dir);
  const result = spawnSync(process.execPath, [
    "--experimental-vm-modules",
    "--no-warnings",
    fileURLToPath(import.meta.url),
    "--batch-dir",
    dir,
  ], { encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  if (!result.error && result.status === 0) {
    const count = Number(String(result.stdout).match(new RegExp(`${COUNT_MARKER}(\\d+)`))?.[1]);
    if (Number.isSafeInteger(count)) return count;
    throw Error("批量语法校验未返回文件数");
  }
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  const detail = `${result.stderr || ""}\n${result.error?.message || ""}`;
  if (/bad option|unknown option|unrecognized option|experimental-vm-modules/i.test(detail)) {
    fallbackNodeCheck(files);
    assertArchitecture(dir);
    return files.length;
  }
  throw result.error || Error(detail.trim() || "语法校验失败");
}

const batchIndex = process.argv.indexOf("--batch-dir");
if (batchIndex >= 0) {
  try {
    const dir = path.resolve(process.argv[batchIndex + 1] || repo);
    console.log(`${COUNT_MARKER}${checkInCurrentProcess(dir)}`);
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
} else if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(`语法校验通过，共 ${check()} 个文件`);
}

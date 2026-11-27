import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { check } from "../../scripts/check.mjs";
import { buildReleaseBundle } from "../../scripts/build-release.mjs";
import { RUNTIME_WHITELIST, compareSemver, cutover, stage } from "../../scripts/publish-plugin.mjs";
import { shutdownWhenIdle } from "../../core/daemon-client.mjs";
import { project } from "../helpers/fixtures.mjs";
import { repoRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

const VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugin.json"), "utf8")).version;
const sha256File = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function copyRuntimeSource(dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of RUNTIME_WHITELIST) {
    fs.cpSync(path.join(repoRoot, name), path.join(dest, name), { recursive: true });
  }
  for (const extra of ["package.json", ".gitattributes", "scripts/check.mjs", "scripts/publish-plugin.mjs", "scripts/stage-files.ps1"]) {
    const src = path.join(repoRoot, extra);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(dest, extra);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}

test("v0.3.3 .gitattributes 与 GitHub Actions CI/Release 工作流契约完整", () => {
  const attrs = fs.readFileSync(path.join(repoRoot, ".gitattributes"), "utf8");
  assert.match(attrs, /^\*\s+text=auto\s+eol=lf$/m);
  assert.match(attrs, /^\*\.ps1\s+text\s+eol=crlf$/m);
  for (const ext of ["png", "ico", "zip"]) {
    assert.match(attrs, new RegExp(`^\\*\\.${ext}\\s+binary$`, "m"));
  }

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["build:release"], "node scripts/build-release.mjs");

  const ci = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(ci, /runs-on:\s*windows-latest/);
  assert.match(ci, /node-version:\s*['"]?24['"]?/);
  assert.match(ci, /AGENT_TOWER_DISABLE_UPDATE_CHECK:\s*['"]?1['"]?/);
  assert.match(ci, /concurrency:/);
  assert.match(ci, /contents:\s*read/);
  assert.match(ci, /npm run check/);
  assert.match(ci, /npm run test:fast/);
  assert.match(ci, /npm run build:release/);
  assert.match(ci, /unicode-space-path:/);
  assert.match(ci.slice(ci.indexOf("unicode-space-path:")), /npm run test:fast/);
  assert.match(ci, /AgentTower 中文 路径/);
  assert.match(ci, /publish-plugin\.mjs --stage-only/);

  const rel = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  assert.match(rel, /tags:\s*\r?\n\s*-\s*['"]?v\*['"]?/);
  assert.match(rel, /workflow_dispatch:/);
  assert.match(rel, /contents:\s*write/);
  assert.match(rel, /build-release\.mjs --out-dir dist-release/);
  assert.match(rel, /release-manifest\.json/);
  assert.match(rel, /SHA256SUMS/);
  assert.match(rel, /gh release/);
});

test("v0.3.3 buildReleaseBundle 产出确定性 ZIP、完整 manifest 与 SHA256SUMS，且无 .git 解压可过 check", () => withProjectSandbox("v033-release", (dir) => {
  const out1 = path.join(dir, "out-1");
  const out2 = path.join(dir, "out-2");
  const r1 = buildReleaseBundle({ sourceDir: repoRoot, outDir: out1 });
  const r2 = buildReleaseBundle({ sourceDir: repoRoot, outDir: out2 });

  assert.equal(r1.version, VERSION);
  assert.equal(r1.tag, `v${VERSION}`);
  assert.equal(r1.manifest.format, "agent-tower-release-v1");
  assert.equal(r1.manifest.studioProtocolRevision, 1);
  assert.equal(r1.manifest.minNode, ">=24.0.0");
  assert.equal(r1.manifest.requiresHostReload, false);
  assert.equal(r1.manifest.rollbackSafe, true);
  assert.equal(r1.manifest.treeHash, r2.manifest.treeHash, "树哈希必须跨次构建完全确定");
  assert.equal(r1.manifest.asset.name, `agent-tower-v${VERSION}.zip`);
  assert.equal(r1.manifest.asset.sha256, r2.manifest.asset.sha256, "ZIP 产物必须逐字节确定");
  assert.equal(sha256File(r1.zipPath), r1.manifest.asset.sha256);
  assert.equal(fs.statSync(r1.zipPath).size, r1.manifest.asset.size);
  assert.ok(Object.keys(r1.manifest.files).includes("plugin.json"));
  assert.ok(Object.keys(r1.manifest.files).includes("scripts/stage-files.ps1"));
  assert.equal(Object.keys(r1.manifest.files).some((f) => f.startsWith(".git/") || f.startsWith(".agents/") || f.startsWith(".agent-tower/")), false);

  const sums = fs.readFileSync(r1.checksumsPath, "utf8").trim().split(/\r?\n/);
  assert.equal(sums.length, 2);
  assert.equal(sums[0], `${r1.manifest.asset.sha256}  agent-tower-v${VERSION}.zip`);
  assert.equal(sums[1], `${sha256File(r1.manifestPath)}  release-manifest.json`);

  const extracted = path.join(dir, "extracted");
  fs.mkdirSync(extracted, { recursive: true });
  execFileSync("tar", ["-xf", path.relative(dir, r1.zipPath), "-C", path.relative(dir, extracted)], {
    cwd: dir,
    windowsHide: true,
    timeout: 15_000,
  });
  assert.equal(fs.existsSync(path.join(extracted, ".git")), false);
  assert.equal(fs.existsSync(path.join(extracted, ".agent-tower")), false);
  const ps1 = fs.readFileSync(path.join(extracted, "scripts", "stage-files.ps1"), "utf8");
  assert.ok(ps1.includes("\r\n"), ".ps1 必须保留 CRLF 行尾");
  const mjs = fs.readFileSync(path.join(extracted, "scripts", "check.mjs"), "utf8");
  assert.equal(mjs.includes("\r\n"), false, "非 .ps1 文本必须统一 LF 行尾");
  assert.ok(check(extracted) > 20);
  const installed = stage({ source: extracted, project: project(dir, "project"), target: path.join(dir, "plugins", "agent-tower"),
    control: path.join(dir, "plugin_data", "agent-tower") });
  assert.equal(installed.hash, r1.manifest.treeHash);
}));

test("v0.3.3 publish-plugin.mjs 加固：install.json 安装源、防降级拦截/放行、updates 放行与 apply.lock 冲突拒绝", () => withProjectSandbox("v033-publish-harden", async (dir) => {
  assert.equal(compareSemver("0.3.3.1", "0.3.3"), 1);
  assert.equal(compareSemver("0.3.3", "0.3.2"), 1);
  assert.equal(compareSemver("0.3.2", "0.3.2"), 0);
  assert.equal(compareSemver("0.3.2", "0.3.3"), -1);
  assert.equal(compareSemver("0.3.3.9007199254740993", "0.3.3.9007199254740992"), 1);

  const proj = project(dir, "proj");
  const zipSource = path.join(dir, "zip-src");
  copyRuntimeSource(zipSource);
  const target = path.join(dir, "plugins", "agent-tower");
  const control = path.join(dir, "plugin_data", "agent-tower");
  const opts = { source: zipSource, project: proj, target, control };

  // 1) ZIP 源写入 origin = "zip"
  const zipStaged = stage(opts);
  const installFile = path.join(control, "updates", "install.json");
  assert.ok(fs.existsSync(installFile));
  const zipInfo = JSON.parse(fs.readFileSync(installFile, "utf8"));
  assert.equal(zipInfo.origin, "zip");
  assert.equal(zipInfo.version, VERSION);
  assert.equal(zipInfo.commit, zipStaged.commit);
  assert.equal(zipInfo.treeHash, zipStaged.hash);
  assert.equal(zipInfo.installedAt, zipStaged.stagedAt);

  // 2) git-clone 与 dev 源识别
  const gitSource = path.join(dir, "git-src");
  copyRuntimeSource(gitSource);
  fs.mkdirSync(path.join(gitSource, ".git"), { recursive: true });
  // 无真实 git 仓库时 git rev-parse 会失败，用已初始化仓库测试 git-clone
  const realGitSrc = project(dir, "real-git-src");
  copyRuntimeSource(realGitSrc);
  stage({ source: realGitSrc, project: proj, target, control });
  assert.equal(JSON.parse(fs.readFileSync(installFile, "utf8")).origin, "git-clone");

  fs.mkdirSync(path.join(realGitSrc, ".agent-tower", "councils"), { recursive: true });
  stage({ source: realGitSrc, project: proj, target, control });
  assert.equal(JSON.parse(fs.readFileSync(installFile, "utf8")).origin, "git-clone");
  const skillDir = path.join(realGitSrc, ".agents", "skills", "release-cutover");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "fixture");
  stage({ source: realGitSrc, project: proj, target, control });
  assert.equal(JSON.parse(fs.readFileSync(installFile, "utf8")).origin, "dev");

  // 3) 防意外降级（模拟已装版本高于源码版本）与 allowDowngrade 放行
  const targetPluginPath = path.join(target, "plugin.json");
  const targetPlugin = JSON.parse(fs.readFileSync(targetPluginPath, "utf8"));
  targetPlugin.version = "9.9.9.1";
  fs.writeFileSync(targetPluginPath, JSON.stringify(targetPlugin, null, 2));
  assert.throws(() => stage(opts), (err) => err?.code === "DOWNGRADE_REFUSED");
  assert.equal(JSON.parse(fs.readFileSync(targetPluginPath, "utf8")).version, "9.9.9.1");

  const allowed = stage({ ...opts, allowDowngrade: true });
  assert.equal(allowed.status, "STAGED");
  assert.equal(JSON.parse(fs.readFileSync(targetPluginPath, "utf8")).version, VERSION);

  // 4) apply.lock 存在时 cutover 直接拒绝 UPDATE_IN_PROGRESS
  const applyLock = path.join(control, "updates", "apply.lock");
  fs.writeFileSync(applyLock, JSON.stringify({ pid: process.pid }));
  await assert.rejects(() => cutover(opts), (err) => err?.code === "UPDATE_IN_PROGRESS");
  fs.unlinkSync(applyLock);

  // 5) 移除 apply.lock 后 cutover 放行 updates 目录并正常启动新守护进程
  fs.writeFileSync(path.join(control, "updates", "state.json"), JSON.stringify({ state: "up_to_date" }));
  try {
    const receipt = await cutover(opts);
    assert.equal(receipt.status, "PASS");
    assert.ok(receipt.files.includes("updates"));
    assert.ok(fs.existsSync(installFile));
  } finally {
    await shutdownWhenIdle(control, 10_000).catch(() => {});
  }
}));

test("v0.3.3 净室公开仓导出树包含快测与流水线文件并可独立通过 check", async (t) => {
  const exportScript = path.join(repoRoot, "scripts", "export-public.mjs");
  if (!fs.existsSync(exportScript)) return t.skip("公开净室导出树不含内部导出脚本");
  const { exportPublicRepo, scanPublicTree } = await import(pathToFileURL(exportScript).href);
  await withProjectSandbox("v033-public-check", (dir) => {
    const srcCopy = path.join(dir, "repo-snapshot");
    const target = path.join(dir, "public-repo");
    fs.mkdirSync(srcCopy, { recursive: true });
    for (const entry of fs.readdirSync(repoRoot, { withFileTypes: true })) {
      if ([".git", ".agent-tower", ".agents", "node_modules", "tmp"].includes(entry.name)) continue;
      fs.cpSync(path.join(repoRoot, entry.name), path.join(srcCopy, entry.name), { recursive: true });
    }
    const res = exportPublicRepo({ sourceDir: srcCopy, targetDir: target });
    assert.equal(res.dryRun, false);
    assert.equal(scanPublicTree(target, { sourceDir: repoRoot }).violations, 0);
    for (const rel of [
      ".gitattributes",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "scripts/test.mjs",
      "scripts/clean-sandbox.mjs",
      "scripts/build-release.mjs",
      "tests/helpers/sandbox.mjs",
      "tests/unit/v001-studio-dom.test.mjs",
    ]) {
      assert.ok(fs.existsSync(path.join(target, rel)), `导出树缺少 ${rel}`);
    }
    assert.equal(fs.existsSync(path.join(target, "tests", "integration")), false);
    assert.equal(fs.existsSync(path.join(target, "tests", "unit", "v012-runtime-cache.test.mjs")), false, "Edge 单测不应进入轻量公开树");
    assert.equal(fs.existsSync(path.join(target, "scripts", "export-public.mjs")), false);

    const checked = spawnSync(
      process.execPath,
      ["--experimental-vm-modules", "--no-warnings", path.join(target, "scripts", "check.mjs")],
      { cwd: target, encoding: "utf8", windowsHide: true, timeout: 30_000 },
    );
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);

    const listed = spawnSync(
      process.execPath,
      [path.join(target, "scripts", "test.mjs"), "--list", "fast"],
      { cwd: target, encoding: "utf8", windowsHide: true, timeout: 15_000 },
    );
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const fastList = listed.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    assert.ok(fastList.includes("unit/v001-studio-dom.test.mjs"), "净室公开树 fast 列表应包含基础非 Edge 单测");
    assert.ok(fastList.includes("unit/v033-release-and-ci-pipeline.test.mjs"), "净室公开树 fast 列表应包含 v033 流水线单测");
    assert.ok(!fastList.some((entry) => entry.startsWith("integration/")), "净室公开树不应包含 integration 套件");
    assert.ok(!fastList.includes("unit/v012-runtime-cache.test.mjs"), "净室公开树 fast 列表不应包含 Edge 单测");
  });
});

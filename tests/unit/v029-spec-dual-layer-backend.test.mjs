import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { VERSION } from "../../core/orchestrator/helpers.mjs";
import { materializeProjectSpecs, projectSpecStatus } from "../../core/spec-context.mjs";
import { MCP_TOOLS } from "../../sidecars/studio/mcp-entry.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();
const specRoot = ".agent-tower/spec";
const previousVersion = "0.2.8";
const nextVersion = "0.2.9";
const mirrorNames = ["README.md", "curator.md", "advisor.md", "executor.md", "review.md", "general.md"];
const mirrorPaths = () => mirrorNames.map(name => `${specRoot}/00-plugin/${name}`);
const write = (root, rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const snapshot = (root, rel) => ({ body: read(root, rel), mtimeMs: fs.statSync(path.join(root, rel)).mtimeMs });

test("跨版本显式初始化只刷新插件镜像并保留项目规范", () => withProjectSandbox("v029-upgrade", dir => {
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  materializeProjectSpecs(cwd, previousVersion);
  const projectFiles = [`${specRoot}/INDEX.md`, `${specRoot}/01-business/biz.md`, `${specRoot}/02-coding/code.md`];
  write(cwd, projectFiles[0], "human maintained index\n");
  write(cwd, projectFiles[1], "business rules\n");
  write(cwd, projectFiles[2], "coding rules\n");
  const before = projectFiles.map(rel => [rel, snapshot(cwd, rel)]);

  const current = projectSpecStatus(cwd, { version: previousVersion });
  assert.equal(current.pluginMirrorUpToDate, true);
  assert.equal(current.pluginVersion, previousVersion);
  assert.equal(projectSpecStatus(cwd, { version: nextVersion }).pluginMirrorUpToDate, false);
  const withoutVersion = projectSpecStatus(cwd);
  assert.equal(withoutVersion.pluginMirrorUpToDate, true);
  assert.equal("pluginVersion" in withoutVersion, false);
  for (const name of mirrorNames.slice(1)) write(cwd, `${specRoot}/00-plugin/${name}`, "stale role card\n");

  const upgraded = materializeProjectSpecs(cwd, nextVersion);
  assert.deepEqual(upgraded.createdPaths, []);
  assert.deepEqual(upgraded.refreshedPaths, mirrorPaths());
  assert.match(read(cwd, `${specRoot}/00-plugin/README.md`), new RegExp(`版本 ${nextVersion.replaceAll(".", "\\.")} ·`));
  const status = projectSpecStatus(cwd, { version: nextVersion });
  assert.equal(status.pluginMirrorUpToDate, true);
  assert.equal(status.pluginVersion, nextVersion);
  assert.deepEqual(projectFiles.map(rel => [rel, snapshot(cwd, rel)]), before);
  assert.deepEqual(fs.readdirSync(path.join(cwd, specRoot, "01-business")), ["biz.md"]);
  assert.deepEqual(fs.readdirSync(path.join(cwd, specRoot, "02-coding")), ["code.md"]);
}));

test("真实 RPC 保持空白项目零写盘并报告镜像篡改与恢复", () => withProjectSandbox("v029-rpc", async dir => {
  const cwd = project(dir, "blank");
  const defaultStudioRoot = project(dir, "default");
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot, catalogLoader: offlineCatalog });
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir);
  o.updateHostContext({ appDataDir });
  try {
    const blank = await o.handleRpc("listProjectSpecs", { cwd });
    assert.equal(blank.initialized, false);
    assert.equal(blank.pluginMaterialized, false);
    assert.equal(blank.pluginMirrorUpToDate, false);
    assert.equal(blank.pluginVersion, VERSION);
    assert.equal(fs.existsSync(path.join(cwd, ".agent-tower")), false);

    await assert.rejects(() => o.handleRpc("initProjectSpecs", { cwd }), { code: "SPEC_DISABLED_FOR_PROJECT" });
    assert.equal(fs.existsSync(path.join(cwd, ".agent-tower")), false);
    await o.handleRpc("specCuration", { action: "setEnabled", cwd, enabled: true });
    assert.equal(fs.existsSync(path.join(cwd, ".agent-tower")), false);

    const initialized = await o.handleRpc("initProjectSpecs", { cwd });
    assert.equal(initialized.status.pluginMaterialized, true);
    assert.equal(initialized.status.pluginMirrorUpToDate, true);
    const review = write(cwd, `${specRoot}/00-plugin/review.md`, "tampered mirror\n");
    const stale = await o.handleRpc("listProjectSpecs", { cwd });
    assert.equal(stale.pluginMaterialized, true);
    assert.equal(stale.pluginMirrorUpToDate, false);

    const repaired = await o.handleRpc("initProjectSpecs", { cwd });
    assert.equal(repaired.status.pluginMirrorUpToDate, true);
    assert.match(fs.readFileSync(review, "utf8"), /\[ROLE: DEFECT-FIRST REVIEWER\]/);
    const nonRpcKeys = new Set(["version", "db", "engineManager", "hasActiveRuns", "setStudioUrl", "getStudioUrl",
      "resolveConversationRoot", "matchesEventConversation", "subscribe", "handleRpc", "shutdown"]);
    assert.equal(Object.keys(o).filter(key => !nonRpcKeys.has(key)).length, 40);
    assert.equal(MCP_TOOLS.length, 17);
    const tool = name => MCP_TOOLS.find(item => item.name === name).inputSchema.properties;
    assert.ok(tool("delegate_task").role.enum.includes("curator"));
    assert.ok(tool("delegate_parallel_batch").tasks.items.properties.role.enum.includes("curator"));
    assert.deepEqual(tool("spec_curation").action.enum, ["begin", "submit"]);
    assert.ok(MCP_TOOLS.every(item => !/specCuration|systemUpdate|system_update/.test(item.name)));
  } finally { await o.shutdown(); }
}));

test("只读探测与显式初始化均拒绝链接镜像目录", () => withProjectSandbox("v029-linked-mirror", dir => {
  const cwd = path.join(dir, "project");
  const outside = path.join(dir, "outside");
  fs.mkdirSync(path.join(cwd, specRoot), { recursive: true });
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, specRoot, "00-plugin"), process.platform === "win32" ? "junction" : "dir");

  const status = projectSpecStatus(cwd, { version: nextVersion });
  assert.equal(status.pluginMaterialized, false);
  assert.equal(status.pluginMirrorUpToDate, false);
  assert.ok(status.warnings.some(item => item.code === "UNSAFE_SPEC_PATH"));
  assert.throws(() => materializeProjectSpecs(cwd, nextVersion), /Linked path refused/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(fs.existsSync(path.join(cwd, specRoot, "INDEX.md")), false);
}));

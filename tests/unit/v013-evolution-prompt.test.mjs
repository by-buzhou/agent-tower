import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { buildEffectivePrompt, hasEvolutionIndex, hasRoadmapDoc, resolveEvolutionPromptHint } from "../../core/orchestrator/helpers.mjs";
import { project, offlineCatalog } from "../helpers/fixtures.mjs";
import { runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

const EVOLUTION_MARKER = "[EVOLUTION INDEX]";
const INDEX_BODY = "SECRET_INDEX_BODY_SHOULD_NEVER_BE_INLINED";

function createIndex(root) {
  fs.mkdirSync(path.join(root, ".agent-tower", "docs", "evolution"), { recursive: true });
  fs.writeFileSync(path.join(root, ".agent-tower", "docs", "evolution", "INDEX.md"), INDEX_BODY);
}

test("v0.1.3 Evolution 指引按项目文件存在性注入并保持幂等", async (t) => withProjectSandbox("v013-prompt", async (dir) => {
  const cleanPrompt = buildEffectivePrompt({ prompt: "原始任务", role: "executor", cwd: dir, repoRoot: dir });
  assert.equal(cleanPrompt.includes(EVOLUTION_MARKER), false);
  assert.match(cleanPrompt, /Only implement the requested scope — do not speculatively add future hooks or over-engineer\./);
  assert.equal(buildEffectivePrompt({ prompt: "评审任务", role: "review", cwd: dir, repoRoot: dir }).includes(EVOLUTION_MARKER), false);
  assert.equal(resolveEvolutionPromptHint({ role: "commander" }), "");
  assert.equal(resolveEvolutionPromptHint({ role: "coordinator" }), "");
  assert.match(resolveEvolutionPromptHint({ role: "executor" }), /\.agent-tower\/docs\/evolution\/INDEX\.md/);

  fs.mkdirSync(path.join(dir, "docs", "evolution"), { recursive: true });
  fs.writeFileSync(path.join(dir, "docs", "evolution", "INDEX.md"), INDEX_BODY);
  assert.equal(hasEvolutionIndex(dir, dir), false);
  createIndex(dir);
  assert.equal(hasEvolutionIndex(dir, dir), true);
  const advisor = buildEffectivePrompt({ prompt: "规划任务", role: "advisor", cwd: dir, repoRoot: dir });
  const executor = buildEffectivePrompt({ prompt: "执行任务", role: "executor", cwd: dir, repoRoot: dir });
  assert.equal(advisor.split(EVOLUTION_MARKER).length - 1, 1);
  assert.match(advisor, /规划、重构或评审既有核心模块前请先按关键词检索避坑/);
  fs.writeFileSync(path.join(dir, ".agent-tower", "docs", "ROADMAP.md"), "# Roadmap\n");
  const executorWithRoadmap = buildEffectivePrompt({ prompt: "执行任务", role: "executor", cwd: dir, repoRoot: dir });
  assert.equal(executorWithRoadmap, executor);
  assert.doesNotMatch(executorWithRoadmap, /\[ROADMAP ISOLATION\]|ROADMAP\.md/);
  assert.ok(executor.indexOf("[WORKSPACE HYGIENE]") < executor.indexOf(EVOLUTION_MARKER));
  assert.ok(executor.indexOf(EVOLUTION_MARKER) < executor.indexOf("执行任务"));
  assert.equal(advisor.includes(INDEX_BODY), false);
  assert.equal(buildEffectivePrompt({ prompt: advisor, role: "advisor", cwd: dir, repoRoot: dir }), advisor);

  const inlineMention = buildEffectivePrompt({ prompt: "请检查 [EVOLUTION INDEX] 字段的渲染与注入", role: "executor", cwd: dir, repoRoot: dir });
  assert.match(inlineMention, /(?:^|\n)\[EVOLUTION INDEX\]\n/);

  const junctionRoot = path.join(dir, "junction-project");
  fs.mkdirSync(path.join(junctionRoot, ".agent-tower", "docs"), { recursive: true });
  fs.symlinkSync(
    path.join(dir, ".agent-tower", "docs", "evolution"),
    path.join(junctionRoot, ".agent-tower", "docs", "evolution"),
    process.platform === "win32" ? "junction" : "dir",
  );
  assert.equal(hasEvolutionIndex(junctionRoot, ""), false);

  const rootJunction = path.join(dir, "root-junction-project");
  fs.symlinkSync(dir, rootJunction, process.platform === "win32" ? "junction" : "dir");
  assert.equal(hasEvolutionIndex(rootJunction, ""), false);

  await t.test("INDEX.md 文件符号链接亦被拒绝", (sub) => {
    const symlinkRoot = path.join(dir, "symlink-project");
    fs.mkdirSync(path.join(symlinkRoot, ".agent-tower", "docs", "evolution"), { recursive: true });
    try {
      fs.symlinkSync(path.join(dir, ".agent-tower", "docs", "evolution", "INDEX.md"), path.join(symlinkRoot, ".agent-tower", "docs", "evolution", "INDEX.md"), "file");
      assert.equal(hasEvolutionIndex(symlinkRoot, ""), false);
    } catch (error) {
      if (!["EACCES", "EPERM", "UNKNOWN"].includes(error?.code)) throw error;
      sub.skip("当前 Windows 环境未开启非特权文件符号链接");
    }
  });
}));

test("v0.1.3 真实 Orchestrator 只向引擎注入 Evolution 指引并保持用户数据干净", () => withProjectSandbox("v013-orchestrator", async (dir) => {
  const cwd = project(dir, "project");
  createIndex(cwd);
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  o.updateHostContext({ appDataDir: dir });
  o.db.saveSettings({ defaultOrchestrationMode: "complex", defaultExternalSessionVisible: true });
  const turns = [];
  const reviews = [];
  o.engineManager.runTurn = (options) => {
    const nativeSessionId = options.nativeSessionId || "native-evolution";
    options.onEvent({ type: "session_bound", nativeSessionId, resumed: Boolean(options.nativeSessionId) });
    turns.push({ ...options, prompt: String(options.prompt) });
    return { result: Promise.resolve({ status: "completed", assistantText: "PASS", nativeSessionId: "native-evolution" }) };
  };
  o.engineManager.runReview = (options) => {
    reviews.push(options);
    return { result: Promise.resolve({ status: "completed", reviewText: "PASS", findings: [] }) };
  };
  try {
    const first = await o.delegateTask({ conversationId: "evolution", cwd, presetKey: "executor_codex", task: "原始派单任务", mode: "wait" });
    assert.equal(turns.at(-1).prompt.includes(EVOLUTION_MARKER), true);
    assert.equal(o.db.getRun(first.runId).prompt, "原始派单任务");
    assert.equal(o.db.listTurnItems({ threadId: first.threadId, runId: first.runId }).find((item) => item.type === "user_message").text, "原始派单任务");

    await o.sendToThread({ threadId: first.threadId, message: "同会话续聊", wait: true });
    assert.equal(turns.at(-1).prompt.includes(EVOLUTION_MARKER), false);

    await o.sendToThread({ threadId: first.threadId, message: "fresh context 重置", freshContext: true, wait: true });
    assert.equal(turns.at(-1).prompt.includes(EVOLUTION_MARKER), true);

    await o.runCodeReview({ cwd, conversationId: "review-evolution", readOnly: true, wait: true });
    assert.match(turns.at(-1).prompt, /\[EVOLUTION INDEX\]/);
    assert.match(turns.at(-1).prompt, /规划、重构或评审既有核心模块前请先按关键词检索避坑/);

    await o.runCodeReview({ cwd, conversationId: "native-review-evolution", readOnly: true, reviewMode: "ephemeral", wait: true });
    assert.equal(reviews.at(-1).prompt.includes(EVOLUTION_MARKER), true);
    assert.equal(reviews.at(-1).prompt.includes(INDEX_BODY), false);
  } finally {
    await o.shutdown();
  }
}));

test("v0.1.3 仓库演进档案包含两节必需标题、最多 60 行且相对链接有效", (t) => {
  const repoRoot = path.resolve(import.meta.dirname, "..", "..");
  const evoDir = path.join(repoRoot, ".agent-tower", "docs", "evolution");
  assert.equal(fs.existsSync(path.join(repoRoot, "docs")), false);
  if (!fs.existsSync(evoDir)) return t.skip("公开净室导出树不含本仓内部 .agent-tower/docs");
  assert.equal(hasEvolutionIndex(repoRoot, repoRoot), true);
  assert.equal(hasRoadmapDoc(repoRoot, repoRoot), true);
  const files = fs.readdirSync(evoDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(".md"))
    .map(entry => entry.name);
  const requiredHeadings = [
    "## 1. 背景与痛点 (Why)",
    "## 2. 核心决策与否决方案 (Trade-offs & Rejected)",
  ];

  for (const fileName of files) {
    const filePath = path.join(evoDir, fileName);
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.replace(/\r?\n$/, "").split(/\r?\n/);
    assert.ok(lines.length <= 60, `${fileName} exceeds 60 lines (${lines.length})`);
    if (fileName !== "INDEX.md") {
      for (const heading of requiredHeadings) {
        assert.ok(lines.includes(heading), `${fileName} missing heading: ${heading}`);
      }
    }
    for (const match of content.matchAll(/\[[^\]]+\]\(([^)#]+)(?:#[^)]+)?\)/g)) {
      const linkTarget = match[1].trim();
      if (/^[a-z][a-z0-9+.-]*:/i.test(linkTarget)) continue;
      const resolved = path.resolve(path.dirname(filePath), linkTarget);
      assert.equal(fs.existsSync(resolved), true, `Broken link in ${fileName}: ${linkTarget}`);
    }
  }
});

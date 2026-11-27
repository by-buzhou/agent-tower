import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import {
  ROLE_SYSTEM_PREFIXES,
  assembleSpecPrompt,
  projectSpecStatus,
  readProjectSpecs,
  specSelection,
  syncProjectSpecScaffold,
} from "../../core/spec-context.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { repoRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

function writeSpec(root, kind, id, frontmatter, body) {
  const dir = path.join(root, ".agent-tower", "spec", kind === "business" ? "01-business" : "02-coding");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.md`);
  fs.writeFileSync(file, `---\nid: ${id}\nkind: ${kind}\n${frontmatter}\n---\n\n${body}\n`, "utf8");
  return file;
}

test("v0.2.10.3 本仓 11 份 Spec 全员 <= 2 KiB、0 告警，随包规则与角色卡彻底去私化", () => {
  if (fs.existsSync(path.join(repoRoot, ".agent-tower", "spec"))) {
    syncProjectSpecScaffold(repoRoot, JSON.parse(fs.readFileSync(path.join(repoRoot, "plugin.json"), "utf8")).version);
    const status = projectSpecStatus(repoRoot, { specLimits: { totalMaxKb: 24 } });
    assert.ok(status.specs.length >= 11, `expected >= 11 specs, got ${status.specs.length}`);
    assert.deepEqual(status.warnings, []);
    let totalBytes = 0;
    for (const spec of status.specs) {
      totalBytes += spec.bytes;
      assert.ok(spec.bytes <= 2048, `${spec.relPath} 正文 ${spec.bytes} B 超过 2048 B`);
    }
    assert.ok(totalBytes <= 24576, `总正文 ${totalBytes} B 超过 24 KiB`);
  }

  for (const rel of ["rules/AGENTS.md", "skills/agent-tower/SKILL.md", "skills/agent-tower-council/SKILL.md", "skills/agent-tower-plan/SKILL.md"]) {
    const text = fs.readFileSync(path.join(repoRoot, rel), "utf8");
    assert.doesNotMatch(text, /test:fast|v011-studio-responsive-theme|预挂载/, `${rel} 仍残留本仓私有测试词`);
  }
  assert.ok(fs.readFileSync(path.join(repoRoot, "rules/AGENTS.md")).length <= 3200);
  for (const prefix of Object.values(ROLE_SYSTEM_PREFIXES)) {
    assert.doesNotMatch(prefix, /test:fast|v011-studio-responsive-theme|预挂载/);
  }
});

test("v0.2.10.3 前端单文件收窄连坐（< 5 KiB）并通过 Frontmatter tests 自动注入关联守护快测", (t) => {
  if (!fs.existsSync(path.join(repoRoot, ".agent-tower", "spec"))) return t.skip("公开净室导出树不含本仓内部 .agent-tower/spec");
  const inventory = readProjectSpecs(repoRoot);
  const res = assembleSpecPrompt({
    inventory,
    cwd: repoRoot,
    repoRoot,
    role: "executor",
    rawPrompt: "微调看板间距",
    dynamicPrompt: "微调看板间距",
    selection: specSelection({ targetPaths: ["sidecars/studio/ui/board-view.js"] }),
  }).full;

  assert.ok(res.meta.specBytes < 5500, `board-view 规范块过大：${res.meta.specBytes} B`);
  const keys = res.meta.items.map(item => item.key);
  assert.ok(keys.includes("coding/frontend-iife"));
  assert.ok(keys.includes("business/studio-and-reporting"));
  for (const unrelated of ["business/context-governance", "business/member-roster", "business/orchestration-modes"]) {
    assert.equal(keys.includes(unrelated), false, `不应连坐注入 ${unrelated}`);
  }
  assert.match(res.prompt, /关联快测：node scripts\/test\.mjs .*v011-studio-responsive-theme/);
});

test("v0.2.10.3 coding 优先于 business 排序、explicit 解锁选读内联、中文顿号/括号分词与体积软告警", () => withProjectSandbox("v02103-rules", dir => {
  const cwd = project(dir, "repo");
  writeSpec(cwd, "business", "alpha-biz", 'required: true\nscopes: ["src/**"]', "业务正文".repeat(250));
  writeSpec(cwd, "coding", "zeta-code", 'required: true\nscopes: ["src/**"]', "编码红线".repeat(250));
  writeSpec(cwd, "coding", "opt-large", 'required: false\nscopes: ["other/**"]\nsummary: 选读摘要', "选读长文".repeat(600));
  fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "src", "a.mjs"), "export {};");
  fs.writeFileSync(path.join(cwd, "src", "b.mjs"), "export {};");

  const inventory = readProjectSpecs(cwd);
  assert.deepEqual(inventory.warnings, [], "readProjectSpecs 不得向常规运行注入体积软告警污染红标");
  const status = projectSpecStatus(cwd);
  assert.ok(status.warnings.some(w => w.code === "SPEC_SIZE_SOFT_LIMIT" && w.key === "coding/opt-large"));

  // 中文顿号与全角括号不得粘连两个路径
  const execRes = assembleSpecPrompt({
    inventory,
    cwd,
    repoRoot: cwd,
    role: "executor",
    rawPrompt: "请检查（src/a.mjs、src/b.mjs）两个模块",
    dynamicPrompt: "任务",
    selection: specSelection({ specIds: ["coding/opt-large"] }),
  }).full;
  const projectItems = execRes.meta.items.filter(item => item.kind !== "plugin");
  assert.equal(projectItems.find(item => item.key === "coding/opt-large")?.tier, "inline", "显式 specIds 应解锁 >2KiB 选读内联");
  const idxCoding = projectItems.findIndex(item => item.key === "coding/zeta-code");
  const idxBiz = projectItems.findIndex(item => item.key === "business/alpha-biz");
  assert.ok(idxCoding >= 0 && idxBiz >= 0 && idxCoding < idxBiz, "executor 同优先级下 coding 应排在 business 前");
}));

test("v0.2.10.3 外层宿主工作区派单子目录 cwd 时原生子会话准确注入子项目 Spec 并跨票据去重", () => withProjectSandbox("v02103-native-subdir", async dir => {
  const outer = project(dir, "outer-workspace");
  const inner = path.join(outer, "inner-plugin");
  fs.mkdirSync(inner, { recursive: true });
  writeSpec(inner, "coding", "inner-rule", 'required: true\nscopes: ["core/**"]', "INNER_SUBDIR_GUARDRAIL");
  fs.mkdirSync(path.join(inner, "core"), { recursive: true });
  fs.writeFileSync(path.join(inner, "core", "app.mjs"), "export const ok = 1;\n");

  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir, { recursive: true });
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: outer, catalogLoader: offlineCatalog });
  try {
    o.updateHostContext({ appDataDir });
    await o.setConversationPolicy({ conversationId: "root-conv", workspace: outer, orchestrationMode: "complex" });
    const first = await o.delegateTask({
      conversationId: "root-conv",
      cwd: inner,
      presetKey: "executor_hydrogen",
      targetPaths: ["core/app.mjs"],
      task: "第一单修改 core/app.mjs",
    });
    assert.equal(first.code, "HOST_DISPATCH_REQUIRED");

    const step1 = o.getConversationPolicy({
      conversationId: "child-swarm-conv",
      workspace: outer,
      syncHostPlaybook: true,
      deferPlaybookCommit: true,
      initialNumSteps: 2,
    });
    // 注册原生子会话归属后认领票据
    o.db.upsertThread({
      id: "thr_native_child-swarm-conv",
      hostConversationId: "child-swarm-conv",
      nativeSessionId: "child-swarm-conv",
      presetKey: "executor_hydrogen",
      provider: "antigravity",
      workspace: outer,
      meta: { isNativeHost: true, isSwarmMember: true, memberName: "executor_hydrogen", rootConversationId: "root-conv" },
    });
    const claim1 = o.getConversationPolicy({
      conversationId: "child-swarm-conv",
      workspace: outer,
      syncHostPlaybook: true,
      deferPlaybookCommit: true,
      initialNumSteps: 2,
    });
    assert.equal(Boolean(step1.playbookInject), false);
    assert.match(claim1.playbookInject, /INNER_SUBDIR_GUARDRAIL/, "应命中子目录 inner-plugin 的规范");
    o.getConversationPolicy({ conversationId: "child-swarm-conv", workspace: outer, syncHostPlaybook: true, confirmPlaybookToken: claim1.playbookCommitToken });

    // 同一票据内二次轮次触发 PreInvocation：已确认内容幂等免重注
    const sameTicketAgain = o.getConversationPolicy({
      conversationId: "child-swarm-conv",
      workspace: outer,
      syncHostPlaybook: true,
      initialNumSteps: 8,
    });
    assert.equal(sameTicketAgain.playbookInject, null, "同一票据内未变更规范应幂等免重注");

    // 发生 /compact（initialNumSteps 回落）后自动恢复补发
    const afterCompact = o.getConversationPolicy({
      conversationId: "child-swarm-conv",
      workspace: outer,
      syncHostPlaybook: true,
      initialNumSteps: 2,
    });
    assert.match(afterCompact.playbookInject, /INNER_SUBDIR_GUARDRAIL/, "上下文压缩后应重新补发规范");
  } finally {
    await o.shutdown();
  }
}));

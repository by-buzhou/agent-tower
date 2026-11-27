import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import {
  DEFAULT_ROLE_PRESETS, INLINE_PLAIN_REPORT_RULE, MODE_PLAYBOOK_REVISION,
  buildInitialRosterFromProbe, buildModePlaybook, modeRosterSummary,
} from "../../core/catalog.mjs";
import { ROLE_SYSTEM_PREFIXES, projectSpecStatus, readProjectSpecs } from "../../core/spec-context.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { repoRoot, runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

// v0.2.4：主会话意图前置判定、阵容客观摘要与逐点内联白话汇报。
process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();
const OLD_REPORT_RULES = [/再附一段「白话解读」/, /双层汇报/, /专业说明 \+ (附通俗)?白话解读/, /专业说明与白话解读/, /合并把关 \+ 白话解读/];
const assertNoOldReportRule = (text, label) => {
  for (const pattern of OLD_REPORT_RULES) assert.doesNotMatch(text, pattern, `${label} 仍含旧段末白话解读指令：${pattern}`);
};

function tenMemberRoster() {
  const presets = { ...DEFAULT_ROLE_PRESETS,
    executor_extra: { group: "executor", provider: "codex", model: "gpt-6.2-sol", effort: "high", label: "额外执行", description: "负责脚本与数据迁移" },
    advisor_extra: { group: "advisor", provider: "kimi-code", model: "kimi-code/k3.1-pro", effort: "max", label: "额外军师" },
  };
  const group = name => Object.entries(presets).filter(([, p]) => p.group === name).map(([key]) => key);
  const modeProfiles = {
    relay: { executor: { enabledKeys: group("executor"), preferredKey: "executor_claude" } },
    complex: {
      advisor: { stageEnabled: true, enabledKeys: group("advisor") },
      executor: { enabledKeys: group("executor"), preferredKey: "executor_claude" },
      reviewer: { stageEnabled: true, enabledKeys: group("reviewer"), preferredKey: "reviewer" },
    },
  };
  const total = ["advisor", "executor", "reviewer"].reduce((sum, name) => sum + group(name).length, 0);
  return { presets, modeProfiles, total };
}

test("v0.2.4 三档 Playbook：自然融合白话取代段末白话解读，意图前置分流与上限池选人", () => {
  const { presets, modeProfiles, total } = tenMemberRoster();
  assert.equal(total, 10);
  assert.ok(MODE_PLAYBOOK_REVISION >= 2, "v0.2.4 起 Playbook 修订号至少为 2，后续版本只增不减");
  assert.match(INLINE_PLAIN_REPORT_RULE, /自然融合白话汇报/);
  const render = (orchestrationMode, profiles = modeProfiles) => buildModePlaybook({ orchestrationMode, presets, modeProfiles: profiles, presetRevision: 7 });
  const direct = render("direct");
  const relay = render("relay");
  const complex = render("complex");
  for (const [mode, text] of Object.entries({ direct, relay, complex })) {
    assert.match(text, new RegExp(`^<agent_tower_mode mode="${mode}" rev="7">`));
    assert.match(text, /自然融合白话汇报/);
    assert.match(text, /取代/);
    assert.ok(text.includes(INLINE_PLAIN_REPORT_RULE), `${mode} 未内联汇报规则`);
    assertNoOldReportRule(text, mode);
  }
  // direct：保留 1~3 条硬拦截与队列冻结，第 4 条为汇报规则。
  assert.match(direct, /1\. 严禁调用 delegate_task/);
  assert.match(direct, /2\. 即使用户在对话中点名某成员/);
  assert.match(direct, /3\. 当前会话待出队队列已冻结/);
  assert.match(direct, /\n4\. 自然融合白话汇报/);
  const closed = render("complex", { ...modeProfiles, complex: { ...modeProfiles.complex,
    advisor: { ...modeProfiles.complex.advisor, stageEnabled: false }, reviewer: { ...modeProfiles.complex.reviewer, stageEnabled: false } } });
  for (const text of [relay, complex, closed]) {
    assert.match(text, /勾选名单与阶段开关为可用上限池/);
    assert.match(text, /L0 .*核心<=4文件\(不含单测\).*0 派直答/);
    assert.match(text, /L1 单域强耦合\(含单测\)选 1 人 shared，禁拆源码与单测；L2 多独立低耦合模块读 agent-tower-plan 选 2～4 人用独立 Worktree.*workspace:"share".*禁绕开★原生成员/);
    assert.doesNotMatch(text, />=6文件/);
    assert.match(text, /点名→★首选（单兵默认选★；并派主力轨必含★，余轨按专长\/空闲复用补位）/);
    assert.doesNotMatch(text, /空闲对口线程→模型\/专长→★/);
    assert.ok(text.includes(INLINE_PLAIN_REPORT_RULE));
  }
  assert.match(relay, /单派或并发派发/);
  assert.match(relay, /executionIntent:"read"/);
  assert.match(relay, /禁调军师团与 review_code/);
  assert.match(relay, /有 Worktree 成果才检查 worktree_diff/);
  assert.match(complex, /L3 军师阶段开启：仅用户要求讨论或有方案分歧时(?:同题原话|读 agent-tower-council 技能)?盲评/);
  assert.match(complex, /L3 审核阶段开启：仅实质代码\/配置改动合入后调 review_code。纯问答\/讨论跳过/);
  assert.match(closed, /军师阶段已关闭，不调军师/);
  assert.match(closed, /独立审核阶段已关闭，不调 review_code/);
  assert.doesNotMatch(closed, /advisor_kimi|reviewer ·|阶段开启/);
  for (const key of Object.values(modeProfiles.complex).flatMap(g => g.enabledKeys)) {
    assert.ok(complex.includes(key), `10 人预算内仍须保留成员 ${key}`);
  }
  assert.match(complex, /swarm:executor_hydrogen\/gemini-4-hydrogen-high/);
  assert.match(complex, /codex\/gpt-6.2-sol\(high\)/);
  for (const text of [direct, relay, complex, closed]) assert.ok(Buffer.byteLength(text) <= 1536, `${Buffer.byteLength(text)} B`);
  const long = { ...presets, executor_extra: { ...presets.executor_extra, model: "model".repeat(400) } };
  const large = buildModePlaybook({ orchestrationMode: "complex", presets: long, modeProfiles });
  assert.ok(Buffer.byteLength(large) <= 1536);
  assert.match(large, /orchestrator_capabilities.*activeMode.groups.executor.enabledKeys/);
  assert.ok(large.includes(INLINE_PLAIN_REPORT_RULE));
});

test("v0.2.4 modeRosterSummary：外部引擎输出 key · provider/model(effort)，前缀去重、专长截断、无描述零空壳", () => {
  const presets = {
    executor_kimi: { provider: "kimi-code", model: "kimi-code/k3.1-pro", effort: "high", label: "Kimi 执行",
      description: "  负责[跨文件]｜联动\n\t开发与协议胶水层实现以及更多冗长说明 " },
    executor_upper: { provider: "kimi-code", model: "Kimi-Code/k3.1-pro", effort: "max", label: "大写前缀" },
    executor_codex: { provider: "codex", model: "gpt-6.2-sol", label: "Codex 执行", description: "" },
    executor_hydrogen: { provider: "antigravity", model: "gemini-4-hydrogen", effort: "high", label: "Hydrogen", description: "负责前端" },
    executor_agy_bare: { provider: "antigravity", model: "gemini-4-hydrogen", effort: "high", label: "AGY 裸" },
  };
  const profile = { enabledKeys: Object.keys(presets).concat("executor_ghost"), preferredKey: "executor_codex" };
  const parts = modeRosterSummary(profile, presets, { preferred: true }).split("、");
  const shortDesc = "负责 跨文件 联动 开发与协议胶水层实现";
  assert.equal(parts[0], `Kimi 执行[executor_kimi · kimi-code/k3.1-pro(high)｜${shortDesc}]`);
  assert.ok(shortDesc.length <= 20);
  const unicode = modeRosterSummary({ enabledKeys: ["member"] }, { member: { provider: "codex", model: "m", effort: "  ", description: "字".repeat(19) + "😀后" } });
  assert.ok(unicode.endsWith(`(inherit)｜${"字".repeat(19)}😀]`));
  assert.equal(parts[1], "大写前缀[executor_upper · Kimi-Code/k3.1-pro(max)]");
  assert.equal(parts[2], "★Codex 执行[executor_codex · codex/gpt-6.2-sol(inherit)]");
  assert.equal(parts[3], "Hydrogen[swarm:executor_hydrogen/gemini-4-hydrogen-high｜负责前端]");
  assert.equal(parts[4], "AGY 裸[swarm:executor_agy_bare/gemini-4-hydrogen-high]");
  assert.equal(parts[5], "executor_ghost[executor_ghost]");
  assert.doesNotMatch(parts.join("、"), /kimi-code\/kimi-code|｜\]|\(\)|\[\]/i);
  assert.equal(modeRosterSummary(profile, presets), parts.join("、").replace("★", ""));
  assert.equal(modeRosterSummary({ enabledKeys: [] }, presets), "无可用成员");

  const available = { command: "x", resolvedPath: "x", available: true };
  const probe = buildInitialRosterFromProbe({ binaries: { "claude-code": available, codex: available, "kimi-code": available, agy: available } });
  const executorKeys = Object.keys(probe.presets).filter(key => probe.presets[key].group === "executor");
  const summary = modeRosterSummary({ enabledKeys: executorKeys }, probe.presets);
  assert.match(summary, /executor_codex · codex\/[^()\s]+\(high\)\]/);
  assert.match(summary, /executor_kimi · kimi-code\/k3\.1-pro\(high\)\]/);
  assert.match(summary, /\[swarm:executor_agy\/gemini-4-hydrogen-high\]/);
  assert.doesNotMatch(summary, /｜|\(\)|\[\]|kimi-code\/kimi-code/);
});

async function withOrchestrator(dir, cwd, action) {
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir);
  o.updateHostContext({ appDataDir });
  try { await action(o); }
  finally { await o.shutdown(); }
}

test("v0.2.4 modeFingerprint：Playbook 内容变化即单次重注，direct 零 <agent_tower_mode> 注入", () => withProjectSandbox("v024-fingerprint", async dir => {
  const blank = project(dir, "blank");
  const withSpec = project(dir, "with-spec");
  const card = path.join(withSpec, ".agent-tower", "spec", "01-business", "rule.md");
  fs.mkdirSync(path.dirname(card), { recursive: true });
  fs.writeFileSync(card, "---\nid: rule\n---\n规范正文");
  await withOrchestrator(dir, blank, async o => {
    const sync = (conversationId, workspace) => o.getConversationPolicy({ conversationId, workspace, syncHostPlaybook: true, initialNumSteps: 3 }).playbookInject;
    o.db.saveSettings({
      presets: { executor_v024: { group: "executor", provider: "kimi-code", model: "k3.1-pro", effort: "high", label: "V024 执行", description: "初版专长" } },
      modeProfiles: { relay: { executor: { enabledKeys: ["executor_v024"], preferredKey: "executor_v024" } } },
    });

    // direct：空白项目零注入；有规范项目只投递目录卡，绝不混入模式块。
    assert.equal(sync("direct-blank", blank), null);
    const directSpec = sync("direct-spec", withSpec);
    assert.match(directSpec, /^<agent_tower_project_context sha="[0-9a-f]+">/);
    assert.doesNotMatch(directSpec, /agent_tower_mode/);
    assert.equal(sync("direct-spec", withSpec), null);

    await o.setConversationPolicy({ conversationId: "relay-conv", workspace: blank, orchestrationMode: "relay" });
    const first = sync("relay-conv", blank);
    assert.match(first, /^<agent_tower_mode mode="relay"/);
    assert.match(first, /★V024 执行\[executor_v024 · kimi-code\/k3\.1-pro\(high\)｜初版专长\]/);
    assert.match(first, /自然融合白话汇报/);
    assert.equal(sync("RELAY-CONV", blank), null);

    // 绕过 presetRevision 直接改盘上成员描述：旧版 mode:presetRevision 指纹不会变化，新版按内容哈希单次重注。
    const revision = o.db.getSettings().presetRevision;
    const file = path.join(dir, "control", "global-settings.json");
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.presets.executor_v024.description = "改版专长";
    fs.writeFileSync(file, JSON.stringify(stored, null, 2));
    assert.equal(o.db.getSettings().presetRevision, revision);
    const changed = sync("relay-conv", blank);
    assert.match(changed, /^<agent_tower_mode mode="relay"/);
    assert.match(changed, /｜改版专长\]/);
    assert.equal(sync("relay-conv", blank), null);

    // 切回 direct 时单次下发 direct 模式块，随后保持静默。
    await o.setConversationPolicy({ conversationId: "relay-conv", orchestrationMode: "direct" });
    assert.match(sync("relay-conv", blank), /^<agent_tower_mode mode="direct"[\s\S]+自然融合白话汇报/);
    assert.equal(sync("relay-conv", blank), null);
  });
}));

test("v0.2.4 随包规则、README、配置页与本仓业务规范同步自然融合白话口径，子 Agent 前缀不含白话要求", () => {
  const read = rel => fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const hasRepoSpecs = fs.existsSync(path.join(repoRoot, ".agent-tower", "spec"));
  for (const rel of ["rules/AGENTS.md", "skills/agent-tower/SKILL.md", "README.md",
    ...(hasRepoSpecs ? [".agent-tower/spec/01-business/studio-and-reporting.md"] : [])]) {
    const text = read(rel);
    assert.match(text, /自然融合白话/, `${rel} 缺少自然融合白话口径`);
    assert.doesNotMatch(text, /紧接一句[「“]通俗点讲就是/, `${rel} 仍残留生硬口头禅要求`);
    assertNoOldReportRule(text, rel);
  }
  for (const rel of ["rules/AGENTS.md", "skills/agent-tower/SKILL.md", "README.md"]) assert.match(read(rel), /AgentTower v0\.(?:2\.(?:[4-9]|\d{2,})|[3-9]\.\d+)/);
  for (const rel of ["rules/AGENTS.md", "skills/agent-tower/SKILL.md"]) {
    const text = read(rel);
    assert.match(text, /可用上限池[\s\S]*0 派直答/);
    assert.doesNotMatch(text, /未点名时优先该组 ★/);
    assert.match(text, /按点名 → ★ 首选（单兵默认选 ★；多路并派主力轨必含 ★，其余并发轨再按专长\/空闲复用补位）选人/);
    assert.match(text, /多路拆单.*严禁为图外部 `worktree_integrate` 合入省事而绕开已标 ★ 的宿主原生成员[\s\S]*`hostActions` \+ `workspace: "share"`/);
    assert.doesNotMatch(text, /按点名、空闲线程、专长、★|按点名 → 空闲线程复用 → 专长 → ★/);
  }
  const agentsDoc = read("rules/AGENTS.md");
  const agentsBytes = Buffer.byteLength(agentsDoc);
  assert.ok(agentsBytes <= 3200, `rules/AGENTS.md 超过 3200 字节红线（当前 ${agentsBytes} B）`);
  assert.match(agentsDoc, /核心 `<=4` 文件（不含单测）明确改动 0 派直答（跑快检快测） \/ 单域强耦合单兵（禁拆源码与单测） \/ 多独立低耦合模块读 `agent-tower-plan` 并派/);
  assert.match(agentsDoc, /`review_code` 默认审改一体且异步回 `taskId`（`task_status` 查结算）/);
  assert.doesNotMatch(agentsDoc, />=6 文件必读/);
  const towerSkill = read("skills/agent-tower/SKILL.md");
  assert.match(towerSkill, /默认 `mode: "async"` 立即返回 `taskId` 后台执行[\s\S]*`task_status`[\s\S]*`mode: "wait"`[\s\S]*`timeoutMs`/);
  assert.match(towerSkill, /核心源码 `<= 4` 个文件明确改动[\s\S]*单领域强耦合改动[\s\S]*严禁把源码与单测或强耦合样式劈进隔离 Worktree 盲写[\s\S]*每轨自带本层单测/);
  assert.doesNotMatch(towerSkill, /跨模块 `>= 6` 个文件/);
  const planSkill = read("skills/agent-tower-plan/SKILL.md");
  assert.match(planSkill, /按耦合度拆轨/);
  assert.match(planSkill, /核心源码 `<= 4` 文件明确改动（顺带改断言的单测不计入拆单门槛）/);
  assert.match(planSkill, /单兵执行[\s\S]*未点名时默认选 ★ 首选[\s\S]*严禁把源码与单测、HTML\/JS 与 CSS 硬劈成隔离 Worktree 盲写/);
  assert.match(planSkill, /仅当任务天然包含 2 个及以上接口边界清晰、彼此低耦合的独立模块[\s\S]*每轨自带本层单测（严禁把单测单拆成一条隔离轨）/);
  assert.match(planSkill, /默认异步返回 `taskId`[\s\S]*`task_status`/);
  assert.doesNotMatch(planSkill, /当改动涉及 >= 6 个文件|强制拆成 2～3 路并发执行轨/);
  assert.match(planSkill, /按点名 → `★` 首选（单兵默认选 `★`；多路并派主力轨必含 `★`，其余并发轨再按专长\/空闲复用补位）挑选/);
  assert.match(planSkill, /多路拆单时严禁为图外部 `worktree_integrate` 合入省事而绕开已标 `★` 的宿主原生成员[\s\S]*`hostActions` \+ `workspace: "share"`/);
  assert.doesNotMatch(planSkill, /按点名 → 空闲线程复用 → 专长 → `★`/);
  const mcpEntry = read("sidecars/studio/mcp-entry.mjs");
  assert.match(mcpEntry, /按用户点名 → ★ 首选（单兵默认选 ★；多路并派主力轨必含 ★，其余并发轨再按专长\/空闲复用补位）选人，多路拆单严禁绕开已标 ★ 的宿主原生成员/);
  assert.doesNotMatch(mcpEntry, /按用户点名、同会话同项目空闲对口线程、模型专长、★/);
  if (hasRepoSpecs) {
    const modes = read(".agent-tower/spec/01-business/orchestration-modes.md");
    assertNoOldReportRule(modes, "orchestration-modes.md");
    assert.match(modes, /可用上限池/);
    assert.match(modes, /L0 免派直答/);

    assert.deepEqual(readProjectSpecs(repoRoot).warnings, []);
    assert.equal(projectSpecStatus(repoRoot, { specLimits: { totalMaxKb: 24 } }).warnings.length, 0);
  }
  for (const [role, prefix] of Object.entries(ROLE_SYSTEM_PREFIXES)) {
    assert.doesNotMatch(prefix, /白话|通俗点讲/, `${role} 子 Agent 前缀不应要求白话`);
  }
});

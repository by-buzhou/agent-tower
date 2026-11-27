import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { createEngineManager } from "../../core/engines/index.mjs";
import { readNativeTranscriptSnapshot, resolveTranscriptPath } from "../../core/engines/agy-native.mjs";
import { assemblePlanPrompt, hasPlansIndex } from "../../core/spec-context.mjs";
import { ensureStorageIgnoreRules } from "../../core/storage-paths.mjs";
import { mapSwarmStateToThreadStatus } from "../../core/orchestrator/helpers.mjs";
import { MCP_TOOLS } from "../../sidecars/studio/mcp-entry.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();
const agyPreset = { group: "executor", label: "原生 Argon", provider: "antigravity", model: "gemini-4-argon", effort: "high" };
const write = (root, rel, text) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const open = (dir, cwd) => createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd,
  catalogLoader: offlineCatalog, recoverStaleState: false });

test("v0.2.6 plans 安全直投、账本去重、目录卡、MCP Schema 与清理保留", () => withProjectSandbox("v026-plans", async dir => {
  const cwd = project(dir, "repo");
  const rel = ".agent-tower/plans/v026.md";
  const plan = write(cwd, rel, "# 定稿\n\n- [ ] 落地 plans 直投\n");
  write(cwd, ".agent-tower/plans/INDEX.md", "# 规划索引\n");
  ensureStorageIgnoreRules(cwd);
  assert.equal(hasPlansIndex(cwd), true);
  assert.equal(git(cwd, "check-ignore", "--", rel), rel);
  assert.match(assemblePlanPrompt({ cwd, planPath: rel, role: "review" }).prompt, /请逐条对照规划中的 `\[ \]` Checklist/);
  assert.throws(() => assemblePlanPrompt({ cwd, planPath: "../outside.md" }), { code: "PLAN_PATH_REJECTED" });
  assert.throws(() => assemblePlanPrompt({ cwd, planPath: ".agent-tower/spec/INDEX.md" }), { code: "PLAN_PATH_REJECTED" });
  assert.throws(() => assemblePlanPrompt({ cwd, planPath: plan }), { code: "PLAN_PATH_REJECTED" });

  const tower = open(dir, cwd);
  const prompts = [];
  try {
    await tower.setConversationPolicy({ conversationId: "plans-root", workspace: cwd, orchestrationMode: "complex" });
    tower.engineManager.runTurn = opts => {
      prompts.push(String(opts.prompt));
      opts.onEvent({ type: "session_bound", nativeSessionId: opts.nativeSessionId || `native-${prompts.length}`, resumed: Boolean(opts.nativeSessionId) });
      return { result: Promise.resolve({ status: "completed", assistantText: "done", nativeSessionId: opts.nativeSessionId || `native-${prompts.length}` }) };
    };
    const delegated = await tower.delegateTask({ conversationId: "plans-root", cwd, presetKey: "executor_codex", task: "按图施工", planPath: rel, mode: "wait", persistSession: true });
    assert.match(prompts[0], /<agent_tower_plan path="\.agent-tower\/plans\/v026\.md">/);
    assert.match(prompts[0], /- \[ \] 落地 plans 直投/);
    assert.equal(tower.db.getRun(delegated.runId).prompt, "按图施工");
    assert.equal(tower.db.listTurnItems({ threadId: delegated.threadId, runId: delegated.runId }).find(item => item.type === "user_message").text, "按图施工");
    await tower.sendToThread({ threadId: delegated.threadId, message: "继续", planPath: rel, wait: true });
    assert.doesNotMatch(prompts[1], /agent_tower_plan/);
    await tower.sendToThread({ threadId: delegated.threadId, message: "第三轮不带规划", wait: true });
    assert.doesNotMatch(prompts[2], /【规范已废止】plan\//, "已投递的 plan/* 账本项后续轮次不得被误报为废止规范");
    await tower.runCodeReview({ conversationId: "plans-root", cwd, presetKey: "reviewer", readOnly: true, planPath: rel, wait: true });
    assert.match(prompts[3], /agent_tower_plan[\s\S]+Checklist 核验代码是否落齐/);
    const card = tower.getConversationPolicy({ conversationId: "plans-root", workspace: cwd, syncHostPlaybook: true }).playbookInject;
    assert.match(card, /\.agent-tower\/plans\/INDEX\.md · 定稿施工规划索引/);
    assert.ok(MCP_TOOLS.find(tool => tool.name === "delegate_task").inputSchema.properties.planPath);
    assert.ok(MCP_TOOLS.find(tool => tool.name === "delegate_parallel_batch").inputSchema.properties.planPath);
    assert.ok(MCP_TOOLS.find(tool => tool.name === "delegate_parallel_batch").inputSchema.properties.tasks.items.properties.planPath);
    assert.ok(MCP_TOOLS.find(tool => tool.name === "review_code").inputSchema.properties.planPath);
    const bytes = fs.readFileSync(plan);
    await tower.cleanRuntimeCache({ workspace: cwd });
    assert.ok(fs.readFileSync(plan).equals(bytes));
  } finally { await tower.shutdown(); }
}));

test("v0.2.6 PreInvocation 确认后落指纹，原生子会话只收私密角色卡与 Plan", () => withProjectSandbox("v026-invocation", async dir => {
  const cwd = project(dir, "repo");
  const planPath = ".agent-tower/plans/native.md";
  write(cwd, planPath, "# 原生施工规划\n\n- [ ] 私密投递\n");
  const tower = open(dir, cwd);
  try {
    await tower.setConversationPolicy({ conversationId: "root", workspace: cwd, orchestrationMode: "complex" });
    tower.db.saveSettings({ presets: { executor_argon: agyPreset },
      modeProfiles: { complex: { executor: { enabledKeys: ["executor_argon"] } } } });
    const params = { conversationId: "root", workspace: cwd, syncHostPlaybook: true, initialNumSteps: 8, deferPlaybookCommit: true };
    const first = tower.getConversationPolicy(params);
    assert.match(first.playbookCommitToken, /^pbt_/);
    const beforeConfirm = tower.getConversationPolicy(params);
    assert.ok(beforeConfirm.playbookInject, "未确认前必须重发");
    assert.equal(tower.getConversationPolicy({ ...params, confirmPlaybookToken: first.playbookCommitToken }).playbookCommitConfirmed, true);
    assert.equal(tower.getConversationPolicy(params).playbookInject, null);

    const handoff = await tower.delegateTask({ conversationId: "root", cwd, presetKey: "executor_argon", task: "原生任务", planPath,
      clientRequestId: "native-once" });
    assert.equal(handoff.status, "waiting_host_dispatch");
    const retried = await tower.delegateTask({ conversationId: "root", cwd, presetKey: "executor_argon", task: "原生任务", planPath,
      clientRequestId: "native-once" });
    assert.equal(retried.handoffId, handoff.handoffId);
    const child = "abcdefab-0000-4000-8000-abcdefabcdef";
    tower.db.upsertThread({ id: `thr_native_${child}`, hostConversationId: child, nativeSessionId: child,
      provider: "antigravity", presetKey: "executor_argon", role: "executor", workspace: cwd,
      meta: { isNativeHost: true, isSwarmMember: true, rootConversationId: "root", memberName: "executor_argon" } });
    const childParams = { conversationId: child, workspace: cwd, syncHostPlaybook: true, initialNumSteps: 2 };
    const injected = tower.getConversationPolicy(childParams).playbookInject;
    assert.match(injected, /\[ROLE: EXECUTOR\]/);
    assert.match(injected, /WORKSPACE HYGIENE/);
    assert.match(injected, /原生施工规划/);
    assert.doesNotMatch(injected, /<agent_tower_mode/);
    assert.equal(tower.getConversationPolicy(childParams).playbookInject, null);

    // 粗档位 pro / flash / flash_lite 准入并自动分流至 invoke_subagent（裸 provider/model 仍须命中当前模式已勾选成员，不越池）
    const coarseTiers = ["pro", "flash", "flash_lite"];
    await assert.rejects(tower.delegateTask({ conversationId: "root", cwd, provider: "antigravity", model: "pro", task: "越池探查" }),
      { code: "PRESET_NOT_IN_MODE" });
    tower.db.saveSettings({
      presets: Object.fromEntries(coarseTiers.map(tier => [`executor_${tier}`, { ...agyPreset, label: `原生 ${tier}`, model: tier }])),
      modeProfiles: { complex: { executor: { enabledKeys: ["executor_argon", ...coarseTiers.map(tier => `executor_${tier}`)] } } },
    });
    for (const tier of coarseTiers) {
      const sub = await tower.delegateTask({ conversationId: "root", cwd, provider: "antigravity", model: tier, task: "轻量只读探查" });
      assert.equal(sub.nativeKind, "subagent");
      assert.equal(sub.hostAction.tool, "invoke_subagent");
      assert.equal(sub.hostAction.args.Model, tier);
    }

    // 并发原生 Swarm 首轮竞态（host-sync 尚未轮询建卡前）：按 members.json 精确匹配各自票据，绝不串票或被 subagent 误吞
    const appDataDir = path.join(dir, "host-race");
    const raceRoot = "11111111-0000-4000-8000-111111111111";
    const raceAdvisor = "22222222-0000-4000-8000-222222222222";
    const raceReviewer = "33333333-0000-4000-8000-333333333333";
    const raceSubagent = "44444444-0000-4000-8000-444444444444";
    tower.db.saveSettings({ presets: {
      advisor_argon: { ...agyPreset, group: "advisor", label: "原生军师 Argon" },
      reviewer_carbon: { ...agyPreset, group: "reviewer", label: "原生终审 Carbon", model: "gemini-4-carbon" },
    }, modeProfiles: { complex: {
      advisor: { stageEnabled: true, enabledKeys: ["advisor_argon"] },
      executor: { enabledKeys: ["executor_argon"] },
      reviewer: { stageEnabled: true, enabledKeys: ["reviewer_carbon"], preferredKey: "reviewer_carbon" },
    } } });
    await tower.setConversationPolicy({ conversationId: raceRoot, workspace: cwd, orchestrationMode: "complex" });
    await tower.delegateParallelBatch({ conversationId: raceRoot, cwd, tasks: [
      { presetKey: "advisor_argon", task: "独立盲评架构" },
      { presetKey: "reviewer_carbon", task: "严苛终审代码", planPath },
    ] });
    write(appDataDir, path.join("brain", raceRoot, ".system_generated", "swarm", "members.json"), JSON.stringify({ members: {
      coordinator: { role: "coordinator", conversation_id: raceRoot },
      advisor_argon: { role: "worker", conversation_id: raceAdvisor, applied_model: "gemini-4-argon-high" },
      reviewer_carbon: { role: "worker", conversation_id: raceReviewer, applied_model: "gemini-4-carbon-high" },
    } }));
    write(appDataDir, path.relative(appDataDir, resolveTranscriptPath(raceRoot, appDataDir)),
      JSON.stringify({ type: "GENERIC", step_index: 1, status: "DONE", content: `invoke_subagent spawned ${raceSubagent}` }) + "\n");
    write(appDataDir, path.relative(appDataDir, resolveTranscriptPath(raceSubagent, appDataDir)), "");
    const advInject = tower.getConversationPolicy({ conversationId: raceAdvisor, appDataDir, workspace: cwd, syncHostPlaybook: true }).playbookInject;
    const revInject = tower.getConversationPolicy({ conversationId: raceReviewer, appDataDir, workspace: cwd, syncHostPlaybook: true }).playbookInject;
    const subInject = tower.getConversationPolicy({ conversationId: raceSubagent, appDataDir, workspace: cwd, syncHostPlaybook: true }).playbookInject;
    assert.match(advInject, /\[ROLE: ADVISOR \/ PLANNER\]/);
    assert.doesNotMatch(advInject, /原生施工规划/, "advisor_argon 不得串领 reviewer_carbon 的 plan 票据");
    assert.match(revInject, /\[ROLE: DEFECT-FIRST REVIEWER\]/);
    assert.match(revInject, /原生施工规划/);
    assert.equal(subInject, null, "无 subagent 票据时未知子会话不得偷领 swarm 票据");
  } finally { await tower.shutdown(); }
}));

test("v0.2.6 原生转录提取 post_message 摘要，swarm_wait DONE 完结且探路错误不阻断", () => withProjectSandbox("v026-transcript", async dir => {
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir, { recursive: true });
  const conversationId = "12345678-1234-4123-8123-123456789abc";
  const file = resolveTranscriptPath(conversationId, appDataDir);
  const steps = [
    { type: "PLANNER_RESPONSE", step_index: 1, status: "DONE", tool_calls: [{ name: "read_file", args: { path: "missing" } }] },
    { type: "GENERIC", step_index: 2, status: "ERROR", content: "not found" },
    { type: "PLANNER_RESPONSE", step_index: 3, status: "DONE", tool_calls: [
      { name: "post_message", args: { text: "@coordinator [done] 已完成" } }, { name: "swarm_wait", args: {} },
    ] },
    { type: "GENERIC", step_index: 4, status: "DONE", content: "posted" },
    { type: "GENERIC", step_index: 5, status: "DONE", content: "waiting" },
  ];
  write(appDataDir, path.relative(appDataDir, file), steps.map(step => JSON.stringify(step)).join("\n") + "\n");
  const snapshot = await readNativeTranscriptSnapshot({ appDataDir, conversationId });
  assert.equal(snapshot.isSettled, true);
  assert.equal(snapshot.lastAssistantText, "@coordinator [done] 已完成");
  assert.ok(snapshot.turnItems.some(item => item.type === "assistant_message" && item.text.includes("已完成")));
  assert.ok(snapshot.events.some(event => event.type === "tool_call" && event.status === "failed"));
  assert.deepEqual(["working", "waiting", "error", "killed"].map(mapSwarmStateToThreadStatus),
    ["running", "waiting", "failed", "interrupted"]);
}));

test("v0.2.6 待命唤醒、宿主门禁、幽灵卡精准归档与离队清理", () => withProjectSandbox("v026-roster", async dir => {
  const cwd = project(dir, "repo");
  const appDataDir = path.join(dir, "host");
  const root = "12345678-0000-4000-8000-123456789abc";
  const worker = "23456789-0000-4000-8000-123456789abc";
  const swarmDir = path.join(appDataDir, "brain", root, ".system_generated", "swarm");
  const roster = members => write(appDataDir, path.relative(appDataDir, path.join(swarmDir, "members.json")), JSON.stringify({ members }));
  const tower = open(dir, cwd);
  try {
    tower.db.saveSettings({ presets: { executor_argon: agyPreset,
      executor_disabled: { ...agyPreset, label: "停用原生" } },
    modeProfiles: { complex: { executor: { enabledKeys: ["executor_argon"] } } } });
    await tower.setConversationPolicy({ conversationId: root, workspace: cwd, orchestrationMode: "complex" });
    tower.db.upsertThread({ id: "ghost", presetKey: "executor_argon", provider: "antigravity", status: "failed",
      lastError: "agentapi new-conversation failed", workspace: cwd, meta: { rootConversationId: root } });
    tower.db.upsertThread({ id: "real-concurrent", presetKey: "executor_argon", provider: "antigravity", status: "failed",
      lastError: "real task failure", workspace: cwd, meta: { rootConversationId: root } });
    roster({ coordinator: { role: "coordinator", conversation_id: root },
      executor_argon: { role: "worker", conversation_id: worker, wake_mode: "mentions", applied_model: "gemini-4-argon-high" } });
    await tower.getBootstrap({ conversationId: root, appDataDir, workspace: cwd });
    const native = tower.db.getThread(`thr_native_${worker}`);
    assert.equal(native.status, "waiting");
    assert.equal(native.meta.swarmState, "waiting");
    const taskStatus = await tower.getTaskStatus({ taskId: native.id, wait: true, timeoutMs: 800 });
    assert.equal(taskStatus.workState, "result_available", "swarm_wait 待命成员应立即视为本轮结果就绪而非挂死等待");
    assert.equal(taskStatus.status, "waiting");
    assert.equal(tower.db.getStats({ workspace: cwd }).waiting, 0, "原生待命不计入人工待介入统计");
    assert.equal(tower.db.getThread("ghost").archived, true);
    assert.equal(tower.db.getThread("ghost").meta.supersededByNativeId, native.id);
    assert.equal(tower.db.getThread("real-concurrent").archived, false);
    const wake = await tower.delegateTask({ conversationId: root, cwd, presetKey: "executor_argon", task: "继续收尾" });
    assert.equal(wake.hostAction.tool, "post_message");
    assert.deepEqual(wake.hostAction.args, { text: "@executor_argon 继续收尾" });

    const disabled = { conversationId: root, hostToolName: "swarm", hostToolArgs: { action: "add", name: "executor_disabled" } };
    assert.equal(tower.getConversationPolicy(disabled).hostToolAllowed, false);
    const ticket = await tower.delegateTask({ conversationId: root, cwd, presetKey: "executor_disabled", task: "临时点名", allowDisabledPreset: true });
    assert.ok(ticket.handoffId);
    assert.equal(ticket.temporaryOverride, true);
    assert.equal(tower.getConversationPolicy(disabled).hostToolAllowed, true);
    assert.equal(tower.getConversationPolicy({ ...disabled, hostToolArgs: { action: "add", name: "free_agent" } }).hostToolAllowed, true);

    roster({ coordinator: { role: "coordinator", conversation_id: root } });
    await tower.getBootstrap({ conversationId: root, appDataDir, workspace: cwd });
    assert.equal(tower.db.getThread(native.id).archived, true);
    assert.equal(tower.db.getThread(native.id).meta.leftSwarm, true);
  } finally { await tower.shutdown(); }
}));

test("v0.2.6 默认个人 OAuth 禁止 agy acp，显式付费开关仍是独立前置条件", () => withProjectSandbox("v026-oauth", async dir => {
  const manager = createEngineManager({ pluginDataDir: path.join(dir, "control") });
  assert.throws(() => manager.runTurn({ cwd: dir, provider: "antigravity", model: "gemini-4-argon", prompt: "never",
    resolveBinary: () => { throw Error("不得解析或拉起 agy acp"); } }), { code: "AGY_ACP_OAUTH_FORBIDDEN" });
}));

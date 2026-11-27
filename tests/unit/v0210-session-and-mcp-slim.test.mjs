import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { createDispatchModule, clipFinalReport } from "../../core/orchestrator/dispatch.mjs";
import { openOrchestratorDb } from "../../core/db.mjs";
import { swarmMemberName } from "../../core/catalog.mjs";
import { MCP_TOOLS, slimMcpPayload, threadReadArgs, formatToolSuccess } from "../../sidecars/studio/mcp-entry.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

const write = (root, rel, text) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const bytes = text => Buffer.byteLength(text, "utf8");
const preset = (provider, model) => ({ key: "custom_exec_x", label: "X 执行官", title: "X 执行官", group: "executor", role: "implementation",
  provider, model, effort: "high", permissionMode: provider === "codex" ? "full-access" : "default", interactionMode: "default", isolation: "shared", enabled: true });

async function tower(dir, exercise) {
  const cwd = project(dir, "repo");
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog, recoverStaleState: false });
  o.db.saveSettings({ defaultOrchestrationMode: "complex", presets: { custom_exec_x: preset("codex", "gpt-6.2-sol") },
    modeProfiles: { complex: { executor: { enabledKeys: ["executor_codex", "custom_exec_x"], preferredKey: "executor_codex" } } } });
  const turns = [];
  const replies = [];
  o.engineManager.runTurn = opts => {
    turns.push(opts);
    const session = opts.nativeSessionId || `native-${turns.length}`;
    opts.onEvent({ type: "session_bound", nativeSessionId: session, resumed: Boolean(opts.nativeSessionId) });
    const assistantText = replies.shift() ?? `result-${turns.length}`;
    return { result: Promise.resolve({ status: "completed", assistantText, nativeSessionId: session }) };
  };
  try { await exercise({ o, cwd, turns, replies, ctx: { conversationId: "v0210", cwd, mode: "wait" } }); }
  finally { await o.shutdown(); }
}

test("v0.2.10 新工单默认干净会话、continueSession 续接、换引擎仅续接时交接且摘要 <= 2 KiB", () => withProjectSandbox("v0210-session", dir => tower(dir, async ({ o, turns, replies, ctx }) => {
  const params = { ...ctx, presetKey: "custom_exec_x" };
  o.db.saveSettings({ defaultExternalSessionVisible: true });
  const first = await o.delegateTask({ ...params, task: "first job" });
  o.db.upsertThread({ id: first.threadId, usage: { contextUsed: 160000, contextLimit: 200000 } });

  // thread_send 返工默认完整续接旧会话，高水位只读提示而非静默掐断。
  const followUp = await o.sendToThread({ threadId: first.threadId, message: "rework", wait: true });
  assert.equal(turns.at(-1).nativeSessionId, "native-1");
  assert.equal(followUp.contextPressure, "high");

  // 新工单：复用成员卡片，清零原生会话与上下文水位。
  const second = await o.delegateTask({ ...params, task: "second job" });
  assert.equal(second.threadId, first.threadId);
  assert.equal(turns.at(-1).nativeSessionId, undefined);
  assert.equal(o.db.getThread(first.threadId).usage.contextUsed, 0);
  assert.equal(o.db.getThread(first.threadId).nativeSessionId, "native-3");
  const light = await o.sendToThread({ threadId: first.threadId, message: "quick", wait: true });
  assert.equal(light.contextPressure, undefined);

  // 显式 continueSession 复用旧会话；兼容显式 freshContext: false。
  await o.delegateTask({ ...params, task: "third job", continueSession: true });
  assert.equal(turns.at(-1).nativeSessionId, "native-3");
  await o.delegateTask({ ...params, task: "fourth job", freshContext: false });
  assert.equal(turns.at(-1).nativeSessionId, "native-3");

  // 预设换引擎：新工单不把旧历史灌进来。
  o.db.saveSettings({ presets: { custom_exec_x: preset("kimi-code", "kimi-code/k3.1-pro") } });
  const switched = await o.delegateTask({ ...params, task: "kimi job" });
  assert.equal(switched.threadId, first.threadId);
  assert.equal(turns.at(-1).provider, "kimi-code");
  assert.doesNotMatch(turns.at(-1).prompt, /Cross-Engine Context Handoff/);
  assert.equal(turns.at(-1).nativeSessionId, undefined);

  // 显式续接 + 换引擎：交接摘要精炼为 <= 2 KiB，并原样保留本轮指令。
  replies.push(`${"结论".repeat(3000)} TAIL`);
  await o.sendToThread({ threadId: first.threadId, message: `${"指令".repeat(2000)}`, wait: true });
  o.db.saveSettings({ presets: { custom_exec_x: preset("codex", "gpt-6.2-sol") } });
  const back = await o.delegateTask({ ...params, task: "codex resume job", continueSession: true });
  assert.equal(back.threadId, first.threadId);
  const prompt = String(turns.at(-1).prompt);
  const marker = "\n\n[Current User Instruction]:\n";
  const digest = prompt.slice(prompt.indexOf("[Cross-Engine Context Handoff: kimi-code -> codex]"), prompt.indexOf(marker));
  assert.ok(digest.startsWith("[Cross-Engine Context Handoff: kimi-code -> codex]"), prompt.slice(0, 200));
  assert.ok(bytes(digest) <= 2048, `digest ${bytes(digest)} bytes`);
  assert.match(digest, /Last User Instruction: 指令/);
  assert.match(digest, /Latest Conclusion \(kimi-code\): 结论/);
  assert.ok(prompt.endsWith(`${marker}codex resume job`));
})));

test("v0.2.10 finalReport 直回、超长 itemId O(1) 续读、includeReport 关闭与批量均摊", () => withProjectSandbox("v0210-report", dir => tower(dir, async ({ o, replies, ctx }) => {
  const params = { ...ctx, presetKey: "executor_codex" };
  replies.push("x".repeat(9000));
  const long = await o.delegateTask({ ...params, task: "long report" });
  assert.equal(long.summary.length, 421);
  assert.equal(long.finalReport.length, 8000);
  assert.equal(long.finalReportTruncated, true);
  assert.equal(long.finalReportTotalLength, 9000);
  assert.equal(long.nextTextOffset, 8000);
  assert.match(long.itemId, /^item_msg_/);

  // 2,000 条以外的末尾报告仍可按主键直接续读。
  for (let i = 0; i < 2050; i++) {
    o.db.upsertTurnItem({ id: `item_noise_${i}`, threadId: long.threadId, type: "command_execution", text: `noise ${i}`, status: "completed" });
  }
  o.db.upsertTurnItem({ id: "item_tail_report", threadId: long.threadId, type: "assistant_message", role: "assistant", text: "y".repeat(100), status: "completed" });
  const rest = await o.readThread({ threadId: long.threadId, itemId: long.itemId, textOffset: long.nextTextOffset });
  assert.equal(rest.item.text, "x".repeat(1000));
  assert.equal(rest.item.nextTextOffset, null);
  const tailItem = await o.readThread({ threadId: long.threadId, itemId: "item_tail_report" });
  assert.equal(tailItem.item.text.length, 100);
  await assert.rejects(o.readThread({ threadId: long.threadId, itemId: "item_missing" }), /找不到指定的 TurnItem/);

  // tail: 最新 N 条正序；默认 RPC 仍是 activity / 400 正序首页。
  const tail = await o.readThread({ threadId: long.threadId, view: "activity", limit: 5, tail: true });
  assert.deepEqual(tail.items.map(i => i.id), ["item_noise_2046", "item_noise_2047", "item_noise_2048", "item_noise_2049", "item_tail_report"]);
  const page = await o.readThread({ threadId: long.threadId });
  assert.equal(page.items.length, 400);
  assert.equal(page.items[0].id, `item_user_${long.runId}`);
  const cursor = await o.readThread({ threadId: long.threadId, view: "activity", limit: 2, tail: true, afterPosition: page.items[0].ordinal });
  assert.equal(cursor.items[0].ordinal > page.items[0].ordinal, true);
  assert.equal(cursor.items[1].ordinal > cursor.items[0].ordinal, true);
  assert.ok(cursor.items.at(-1).ordinal < tail.items[0].ordinal, "带正向游标时不走 tail");

  const status = await o.getTaskStatus({ taskId: long.taskId });
  assert.equal(status.finalReport.length, 8000);
  assert.equal((await o.getTaskStatus({ taskId: long.taskId, includeReport: false })).finalReport, undefined);
  const threadStatus = await o.getTaskStatus({ threadId: long.threadId });
  assert.equal(typeof threadStatus.finalReport, "string");

  const quiet = await o.delegateTask({ ...params, task: "quiet", includeReport: false });
  assert.equal(quiet.status, "completed");
  assert.equal("finalReport" in quiet, false);
  const running = await o.delegateTask({ ...params, task: "async", mode: "async" });
  assert.equal("finalReport" in running, false);

  replies.push("a".repeat(9000), "b".repeat(9000), "c".repeat(9000));
  const batch = await o.delegateParallelBatch({ ...ctx, mode: "wait_all", tasks: ["one", "two", "three"].map(task => ({ task, presetKey: "executor_codex" })) });
  assert.equal(batch.count, 3);
  const total = batch.tasks.reduce((sum, t) => sum + t.finalReport.length, 0);
  assert.ok(total <= 16000, `batch total ${total}`);
  for (const t of batch.tasks) {
    assert.equal(t.finalReport.length, 5333);
    assert.equal(t.finalReportTruncated, true);
    assert.equal(t.finalReportTotalLength, 9000);
    assert.equal(t.nextTextOffset, 5333);
  }
  const nineTasks = Array.from({ length: 9 }, (_, index) => ({ task: `wide ${index}`, presetKey: "executor_codex" }));
  replies.push(...nineTasks.map(() => "x".repeat(9000)));
  const wide = await o.delegateParallelBatch({ ...ctx, mode: "wait_all", allowLargeBatch: true, tasks: nineTasks });
  assert.ok(wide.tasks.reduce((sum, t) => sum + t.finalReport.length, 0) <= 16000);
  assert.ok(wide.tasks.every(t => t.itemId && t.finalReportTotalLength === 9000));
  const silentBatch = await o.delegateParallelBatch({ ...ctx, mode: "wait_all", includeReport: false, tasks: [{ task: "s", presetKey: "executor_codex" }] });
  assert.equal("finalReport" in silentBatch.tasks[0], false);
  assert.deepEqual(clipFinalReport({ finalReport: "abc" }, 2), { finalReport: "ab", finalReportTruncated: true, finalReportTotalLength: 3, itemId: null, nextTextOffset: 2 });
})));

test("v0.2.10 readPaths 透传 run meta、排队与重试", () => withProjectSandbox("v0210-readpaths", dir => tower(dir, async ({ o, ctx }) => {
  const sent = await o.delegateTask({ ...ctx, presetKey: "executor_codex", task: "evidence", readPaths: ["docs/a.md", " ", "docs/a.md", 7] });
  assert.deepEqual(o.db.getRun(sent.runId).meta.readPaths, ["docs/a.md"]);
  const plain = await o.delegateTask({ ...ctx, presetKey: "executor_codex", task: "plain" });
  assert.deepEqual(o.db.getRun(plain.runId).meta.readPaths, []);
  const follow = await o.sendToThread({ threadId: sent.threadId, message: "more", readPaths: ["docs/b.md"], wait: true });
  assert.deepEqual(o.db.getRun(follow.runId).meta.readPaths, ["docs/b.md"]);
  const retried = await o.retryRun({ threadId: sent.threadId, wait: true });
  assert.deepEqual(o.db.getRun(retried.runId).meta.readPaths, ["docs/b.md"]);
  const launched = await o.launchThread({ ...ctx, presetKey: "executor_codex", title: "t", message: "go", readPaths: ["docs/c.md"] });
  assert.deepEqual(o.db.getRun(launched.runId).meta.readPaths, ["docs/c.md"]);
})));

test("v0.2.10 db：timings 深合并、tail 正序与 spec_ledger 24h 孤儿回收", () => withProjectSandbox("v0210-db", dir => {
  const file = path.join(dir, "tower.sqlite");
  const db = openOrchestratorDb(file);
  try {
    db.upsertThread({ id: "thr", provider: "codex", nativeSessionId: "current", cwd: dir });
    db.upsertRun({ id: "run", threadId: "thr", meta: { timings: { prepMs: 5 }, keep: 1 } });
    db.upsertRun({ id: "run", threadId: "thr", meta: { timings: { spawnMs: 7, prepMs: 6 } } });
    assert.deepEqual(db.getRun("run").meta, { timings: { prepMs: 6, spawnMs: 7 }, keep: 1 });
    db.upsertRun({ id: "run", threadId: "thr", meta: { other: true } });
    assert.deepEqual(db.getRun("run").meta.timings, { prepMs: 6, spawnMs: 7 });
    db.upsertRun({ id: "plain", threadId: "thr", meta: { a: 1 } });
    assert.equal("timings" in db.getRun("plain").meta, false);

    for (let i = 0; i < 5; i++) db.upsertTurnItem({ id: `i${i}`, threadId: "thr", type: "user_message", text: String(i) });
    assert.deepEqual(db.listTurnItems({ threadId: "thr", limit: 2, tail: true }).map(i => i.id), ["i3", "i4"]);
    assert.deepEqual(db.listTurnItems({ threadId: "thr", limit: 2 }).map(i => i.id), ["i0", "i1"]);
    assert.equal(db.getTurnItem("i4").text, "4");
    assert.equal(db.getTurnItem("nope"), null);

    const ack = sessionId => db.specLedger.acknowledge({ provider: "codex", sessionId, runId: "run", threadId: "thr", injectedSpecs: {},
      delivered: [{ key: "coding/style", sha256: "s", tier: "inline" }] });
    for (const id of ["current", "replaced-old", "replaced-fresh"]) ack(id);
    const sql = new DatabaseSync(file);
    try {
      sql.prepare("UPDATE spec_ledger SET updated_at = ? WHERE native_session_id IN ('current', 'replaced-old')").run(Date.now() - 25 * 60 * 60 * 1000);
    } finally { sql.close(); }
    db.checkpoint();
    assert.equal(db.specLedger.read("codex", "current").size, 1, "当前会话账本保留");
    assert.equal(db.specLedger.read("codex", "replaced-old").size, 0, "超 24h 的被替换会话孤儿行回收");
    assert.equal(db.specLedger.read("codex", "replaced-fresh").size, 1, "未满 24h 的孤儿行保留");
  } finally { db.close(); }
}));

test("v0.2.10 原生派遣：规划不进公共 brief、subagent 免 Swarm 口令、待命成员二次接单认领新票据", () => withProjectSandbox("v0210-native", dir => {
  const cwd = path.join(dir, "repo");
  write(cwd, ".agent-tower/plans/one.md", "# 规划一\n- [ ] A\n");
  write(cwd, ".agent-tower/plans/two.md", "# 规划二\n- [ ] B\n");
  const presets = {
    advisor_argon: { group: "advisor", label: "Argon 军师", provider: "antigravity", model: "gemini-4-argon", effort: "high" },
    advisor_lite: { group: "advisor", label: "Lite 军师", provider: "antigravity", model: "inherit", effort: "high" },
  };
  const name = swarmMemberName("advisor_argon");
  const ctx = {
    db: { getSettings: () => ({ presets }) },
    latestSwarmSnapshots: new Map(),
    hostContext: {},
    hostSync: { buildHostEnvForDriver: () => ({}) },
    scopePolicy: { getActiveModeSummary: () => ({ orchestrationMode: "complex" }) },
  };
  const dispatch = createDispatchModule(ctx);
  const route = (presetKey, model) => ({ provider: "antigravity", model, effort: "high", isolation: "shared", routing: { requestedPresetKey: presetKey } });
  const handoff = (presetKey, model, brief, planPath) => dispatch.createNativeHostHandoff({ params: { presetKey, planPath }, resolved: route(presetKey, model),
    rootConversationId: "root", role: "advisor", brief, cwd, repoRoot: cwd });

  const first = handoff("advisor_argon", "gemini-4-argon", "盲评一", ".agent-tower/plans/one.md");
  assert.equal(first.hostAction.tool, "swarm");
  const brief = first.hostAction.args.brief;
  assert.doesNotMatch(brief, /<agent_tower_plan path=|规划一|- \[ \] A/);
  assert.match(brief, /^盲评一\n\n完成独立盲评后向 @coordinator/);
  assert.match(brief, /定稿规划：\.agent-tower\/plans\/one\.md（已由宿主注入/);
  assert.equal(first.summary, `待宿主执行原生派遣票据 #${first.handoffId}（swarm -> advisor_argon）`);
  assert.equal(first.summary.includes(brief), false);
  assert.deepEqual(first.hostActions, [first.hostAction]);
  const ticket = dispatch.findNativeHandoff({ handoffId: first.handoffId });
  assert.equal(ticket.rawTask, "盲评一");
  assert.equal(ticket.planPath, ".agent-tower/plans/one.md");
  assert.throws(() => handoff("advisor_argon", "gemini-4-argon", "越界", "../x.md"), { code: "PLAN_PATH_REJECTED" });

  const lite = handoff("advisor_lite", "inherit", "轻量盲评");
  assert.equal(lite.hostAction.tool, "invoke_subagent");
  assert.equal(lite.hostAction.args.Prompt, "轻量盲评");

  // 首次认领绑定会话；待命后第二单必须认领更新的未认领票据，而不是回放旧票据。
  const claim = () => dispatch.claimNativeHandoff({ rootConversationId: "root", presetKey: "advisor_argon", swarmName: name, nativeKind: "swarm", conversationId: "child-1" });
  assert.equal(claim().handoffId, first.handoffId);
  ctx.latestSwarmSnapshots.set("root", { found: true, rootConversationId: "root", members: [{ name, state: "waiting", killed: false }] });
  const wake = handoff("advisor_argon", "gemini-4-argon", "盲评二", ".agent-tower/plans/two.md");
  assert.equal(wake.hostAction.tool, "post_message");
  assert.match(wake.hostAction.args.text, new RegExp(`^@${name} 盲评二`));
  const rebound = claim();
  assert.equal(rebound.handoffId, wake.handoffId);
  assert.equal(rebound.conversationId, "child-1");
  assert.equal(rebound.planPath, ".agent-tower/plans/two.md");
  assert.equal(claim().handoffId, wake.handoffId, "无更新票据时沿用本会话最近票据");
  assert.equal(dispatch.findNativeHandoff({ rootConversationId: "root", conversationId: "child-1", nativeKind: "swarm", includeClaimed: true }).handoffId, wake.handoffId);

  // 一次性 subagent 会话不得抢走同预设的新票据。
  const subClaim = conversationId => dispatch.claimNativeHandoff({ rootConversationId: "root", presetKey: "advisor_lite", label: "Lite 军师", nativeKind: "subagent", conversationId });
  assert.equal(subClaim("sub-a").handoffId, lite.handoffId);
  const lite2 = handoff("advisor_lite", "inherit", "轻量盲评二");
  assert.equal(subClaim("sub-a").handoffId, lite.handoffId);
  assert.equal(subClaim("sub-b").handoffId, lite2.handoffId);
  assert.equal(subClaim("unrelated"), null);
}));

test("v0.2.10 MCP Schema 去重纠偏与出口瘦身", () => {
  const tool = name => MCP_TOOLS.find(t => t.name === name);
  const delegate = tool("delegate_task").inputSchema.properties;
  assert.ok(fs.readFileSync(new URL("../../rules/AGENTS.md", import.meta.url)).length <= 3200);
  const batch = tool("delegate_parallel_batch").inputSchema.properties;
  for (const key of ["readPaths", "continueSession", "includeReport"]) assert.ok(delegate[key], key);
  assert.deepEqual(delegate.readPaths.items, { type: "string" });
  assert.equal(delegate.continueSession.default, false);
  assert.equal(delegate.includeReport.default, true);
  for (const name of ["task_status", "review_code"]) assert.ok(tool(name).inputSchema.properties.includeReport, name);
  const reviewProps = tool("review_code").inputSchema.properties;
  assert.ok(reviewProps.continueSession);
  assert.ok(reviewProps.readPaths);
  assert.deepEqual(reviewProps.mode.enum, ["async", "wait"]);
  assert.equal(reviewProps.mode.default, "async");
  assert.equal(reviewProps.timeoutMs.type, "number");
  assert.ok(batch.readPaths && batch.includeReport);
  assert.equal(MCP_TOOLS.length, 16);

  const items = batch.tasks.items.properties;
  assert.deepEqual(Object.keys(items).sort(), Object.keys(delegate).sort());
  for (const [key, schema] of Object.entries(delegate)) {
    assert.equal(items[key].type, schema.type, key);
    assert.deepEqual(items[key].enum, schema.enum, key);
    assert.deepEqual(items[key].items, schema.items, key);
  }
  assert.equal(items.presetKey.description, "同 delegate_task 同名字段。");
  assert.equal(items.task.description, delegate.task.description);
  for (const intent of [delegate.executionIntent, tool("thread_send").inputSchema.properties.executionIntent]) {
    assert.equal(intent.description, "relay 模式下本轮执行意图：省略时默认可写 write，仅显式传 read 才启用只读约束。");
  }
  const capabilities = tool("orchestrator_capabilities").description;
  assert.doesNotMatch(capabilities, /建议首次派单前调用|9 大角色/);

  // thread_read 默认：最新 20 条 messages 正序；itemId / 游标 / 显式参数不被覆盖。
  assert.deepEqual(threadReadArgs({ threadId: "t" }), { threadId: "t", view: "messages", limit: 20, maxCharsPerItem: 8000, tail: true });
  assert.deepEqual(threadReadArgs({ threadId: "t", view: "activity", limit: 5, afterPosition: 3 }),
    { threadId: "t", view: "activity", limit: 5, maxCharsPerItem: 8000, afterPosition: 3 });
  assert.deepEqual(threadReadArgs({ threadId: "t", itemId: "i" }), { threadId: "t", itemId: "i" });

  const activeMode = { orchestrationMode: "complex", dispatchEnabled: true, policyRevision: 3, rosterRevision: 4, queueFrozen: false,
    relayTarget: "x", modeProfiles: { complex: {} }, stages: { advisor: true, executor: true, reviewer: false },
    groups: { executor: { enabledKeys: ["executor_codex"] } } };
  const slimMode = { orchestrationMode: "complex", dispatchEnabled: true, policyRevision: 3, rosterRevision: 4,
    stages: { advisor: true, executor: true, reviewer: false } };
  assert.deepEqual(slimMcpPayload("task_status", { status: "completed", activeMode }).activeMode, slimMode);
  assert.deepEqual(slimMcpPayload("studio_status", { activeMode }).activeMode, activeMode);
  const read = slimMcpPayload("thread_read", { items: [], memberPool: [1], modeProfiles: {}, presetRevision: 2, activeMode });
  assert.equal("memberPool" in read, false);
  assert.equal("modeProfiles" in read, false);
  assert.equal(read.presetRevision, 2);
  const bypass = { bypassed: true, mode: "host_direct_only", instruction: "请勿重试", activeMode };
  assert.equal(slimMcpPayload("delegate_task", bypass).instruction, "请勿重试");

  const caps = { activeMode, providers: [{ id: "codex", models: [{ id: "m", optionDescriptors: [{ id: "effort" }],
    capabilities: { optionDescriptors: [{ id: "effort" }] } }, { id: "n", optionDescriptors: [], capabilities: { optionDescriptors: [], vision: true } }] }] };
  const slimCaps = slimMcpPayload("orchestrator_capabilities", caps);
  assert.deepEqual(slimCaps.activeMode, activeMode, "capabilities 保留完整 activeMode.groups");
  assert.deepEqual(slimCaps.providers[0].models[0], { id: "m", optionDescriptors: [{ id: "effort" }] });
  assert.deepEqual(slimCaps.providers[0].models[1].capabilities, { vision: true });

  // 原生派遣卡：brief 在 MCP 出口只出现一次。
  const brief = "唯一任务正文".repeat(20);
  const card = { handoffId: "hnd_1", presetKey: "advisor_argon", tool: "swarm", args: { action: "add", name: "a", brief },
    hostPrompt: `请执行宿主原生派遣票据 #hnd_1：调用 swarm，参数 ${JSON.stringify({ brief })}。` };
  const handoff = { code: "HOST_DISPATCH_REQUIRED", status: "waiting_host_dispatch", handoffId: "hnd_1", hostAction: card, hostActions: [card],
    summary: "待宿主执行原生派遣票据 #hnd_1（swarm -> advisor_argon）", activeMode };
  const countBrief = payload => formatToolSuccess(payload, "delegate_task").content[0].text.split("唯一任务正文唯一任务正文").length - 1;
  assert.equal(countBrief(handoff), 10, "整段 brief 仅保留在 args 一处");
  const slimHandoff = slimMcpPayload("delegate_task", handoff);
  assert.equal("hostAction" in slimHandoff, false);
  assert.equal(slimHandoff.hostActions[0].args.brief, brief);
  assert.match(slimHandoff.hostActions[0].hostPrompt, /#hnd_1：按 args 调用 swarm。严禁调用 agentapi new-conversation/);
  const batchOut = slimMcpPayload("delegate_parallel_batch", { tasks: [handoff, { status: "completed", activeMode }], hostActions: [card], activeMode });
  assert.equal("hostAction" in batchOut.tasks[0], false);
  assert.equal("hostActions" in batchOut.tasks[0], false);
  assert.equal(batchOut.tasks[0].handoffId, "hnd_1");
  assert.deepEqual(batchOut.tasks[1].activeMode, slimMode);
  assert.equal(batchOut.hostActions.length, 1);

  const text = formatToolSuccess({ a: 1, b: [1, 2] }, "task_status").content[0].text;
  assert.equal(text, '{"a":1,"b":[1,2]}');
  assert.equal(formatToolSuccess("plain").content[0].text, "plain");
  const mcpSource = fs.readFileSync(new URL("../../sidecars/studio/mcp-entry.mjs", import.meta.url), "utf8");
  assert.match(mcpSource, /case 'review_code':[\s\S]*args\.mode === undefined && args\.wait === undefined[\s\S]*mode: 'async'/);
});

test("review_code 异步模式与有界 timeoutMs：不阻塞主会话、超时不中断终审且 task_status 精确回取终审报告（含 nativeReview）", () => withProjectSandbox("v0210-async-review", dir => tower(dir, async ({ o, cwd }) => {
  let resolveTurn;
  o.engineManager.runTurn = opts => {
    opts.onEvent({ type: "session_bound", nativeSessionId: "rev-native-1", resumed: false });
    return { result: new Promise(resolve => { resolveTurn = resolve; }) };
  };
  const asyncRev = await o.runCodeReview({ conversationId: "v0210-rev", cwd, mode: "async", prompt: "async check" });
  assert.equal(asyncRev.status, "running");
  assert.equal(asyncRev.workState, "working");
  assert.match(asyncRev.taskId, /^task_/);
  assert.equal(asyncRev.childThreadId, asyncRev.threadId);
  assert.match(asyncRev.next, new RegExp(`task_status\\(\\{ taskId: "${asyncRev.taskId}"`));
  assert.equal(o.db.getRun(asyncRev.runId).meta.taskId, asyncRev.taskId);
  assert.equal(o.db.getTaskRun(asyncRev.taskId)?.id, asyncRev.runId);

  const pendingStatus = await o.getTaskStatus({ taskId: asyncRev.taskId, wait: false });
  assert.equal(pendingStatus.workState, "working");
  resolveTurn({ status: "completed", assistantText: "PASS: async review complete", nativeSessionId: "rev-native-1" });
  const doneStatus = await o.getTaskStatus({ taskId: asyncRev.taskId, wait: true, timeoutMs: 3000 });
  assert.equal(doneStatus.status, "completed");
  assert.equal(doneStatus.workState, "result_available");
  assert.equal(doneStatus.finalReport, "PASS: async review complete");
  assert.match(doneStatus.title, /审改一体终审/);

  // 有界 timeoutMs 等待超时：不杀进程，释放同步等待计数，随后仍可由 task_status 拿到完整结论
  let resolveSlow;
  o.engineManager.runTurn = opts => {
    opts.onEvent({ type: "session_bound", nativeSessionId: "rev-native-2", resumed: false });
    return { result: new Promise(resolve => { resolveSlow = resolve; }) };
  };
  const timed = await o.runCodeReview({ conversationId: "v0210-rev", cwd, mode: "wait", timeoutMs: 500, prompt: "slow check" });
  assert.equal(timed.waitTimedOut, true);
  assert.equal(timed.workState, "working");
  assert.match(timed.taskId, /^task_/);
  resolveSlow({ status: "completed", assistantText: "PASS: finished after timeout", nativeSessionId: "rev-native-2" });
  const afterTimeout = await o.getTaskStatus({ taskId: timed.taskId, wait: true, timeoutMs: 3000 });
  assert.equal(afterTimeout.status, "completed");
  assert.equal(afterTimeout.finalReport, "PASS: finished after timeout");

  // nativeReview（readOnly + ephemeral）同样支持 mode: "async" 与 timeoutMs
  let resolveNative;
  o.engineManager.runReview = () => ({ result: new Promise(resolve => { resolveNative = resolve; }) });
  const nativeAsync = await o.runCodeReview({ conversationId: "v0210-rev", cwd, readOnly: true, reviewMode: "ephemeral", mode: "async", prompt: "native async" });
  assert.equal(nativeAsync.ephemeral, true);
  assert.equal(nativeAsync.workState, "working");
  assert.match(nativeAsync.taskId, /^task_/);
  resolveNative({ status: "completed", reviewText: "PASS: native async review", findings: [] });
  const nativeDone = await o.getTaskStatus({ taskId: nativeAsync.taskId, wait: true, timeoutMs: 3000 });
  assert.equal(nativeDone.status, "completed");
  assert.equal(nativeDone.finalReport, "PASS: native async review");
})));

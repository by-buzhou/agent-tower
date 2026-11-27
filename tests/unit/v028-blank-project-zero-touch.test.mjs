import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { inferCallingHostConversation } from "../../core/engines/agy-native.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

function writeTranscript(appDataDir, conversationId, steps) {
  const dir = path.join(appDataDir, "brain", conversationId, ".system_generated", "logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "transcript.jsonl"), steps.map(step => JSON.stringify(step)).join("\n") + "\n");
}

function ordinaryTranscript(appDataDir, conversationId, text = "普通对话") {
  writeTranscript(appDataDir, conversationId, [
    { type: "USER_INPUT", step_index: 1, created_at: new Date().toISOString(), content: text },
    { type: "PLANNER_RESPONSE", step_index: 2, created_at: new Date().toISOString(), status: "DONE", content: "普通回答", tool_calls: [] },
  ]);
}

function deferredHandle() {
  let resolve;
  let cancels = 0;
  const result = new Promise(r => { resolve = r; });
  return {
    result,
    resolve,
    get cancels() { return cancels; },
    async cancel() { cancels++; resolve({ status: "interrupted" }); },
    async forceKill() { return this.cancel(); },
    async respondPermission() {},
  };
}

const completed = { status: "completed", assistantText: "完成" };
async function tickUntil(check, message) {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), message);
}

test("陌生空白项目与无目录闲聊 direct 轮询零注入零写盘，relay 后恢复落库", () => withProjectSandbox("v028-zero-touch", async dir => {
  const defaultRoot = project(dir, "default");
  const blankDir = path.join(dir, "blank");
  const appDataDir = path.join(dir, "host");
  const blankConversation = "11111111-1111-4111-8111-111111111111";
  const chatConversation = "22222222-2222-4222-8222-222222222222";
  fs.mkdirSync(blankDir);
  ordinaryTranscript(appDataDir, blankConversation, "空白项目里的普通问答");
  ordinaryTranscript(appDataDir, chatConversation, "没有工作区的纯闲聊");

  const tower = createOrchestrator({
    dataDir: path.join(dir, "control"),
    defaultStudioRoot: defaultRoot,
    catalogLoader: offlineCatalog,
  });
  try {
    const direct = await tower.getConversationPolicy({
      conversationId: blankConversation,
      appDataDir,
      workspace: blankDir,
      syncHostPlaybook: true,
    });
    assert.equal(direct.source, "default");
    assert.equal(direct.orchestrationMode, "direct");
    assert.equal(direct.playbookInject, null);

    const blankBootstrap = await tower.getBootstrap({ conversationId: blankConversation, appDataDir, workspace: blankDir });
    assert.equal(blankBootstrap.threads.length, 0);
    await tower.getEvents({ conversationId: blankConversation, appDataDir, workspace: blankDir });
    await tower.getEvents({ conversationId: blankConversation, appDataDir, workspace: blankDir });

    const chat = await tower.getConversationPolicy({ conversationId: chatConversation, appDataDir, syncHostPlaybook: true });
    assert.equal(chat.playbookInject, null);
    await tower.getBootstrap({ conversationId: chatConversation, appDataDir });
    await tower.getEvents({ conversationId: chatConversation, appDataDir });

    assert.equal(fs.existsSync(path.join(blankDir, ".agent-tower")), false);
    assert.equal(fs.existsSync(path.join(blankDir, ".gitignore")), false);
    assert.equal(tower.db.listThreads({ includeSubagents: true, includeArchived: true, limit: 500 })
      .some(thread => thread.id.startsWith("thr_native_")), false, "默认项目库不得混入空白项目或无目录闲聊");

    await tower.setConversationPolicy({ conversationId: blankConversation, orchestrationMode: "relay", workspace: blankDir });
    const relayBootstrap = await tower.getBootstrap({ conversationId: blankConversation, appDataDir, workspace: blankDir });
    const nativeThread = tower.db.getThread(`thr_native_${blankConversation}`);
    assert.ok(nativeThread, "显式切换 relay 后应恢复原生会话落库");
    assert.equal(nativeThread.meta.projectRoot, blankDir.replace(/\\/g, "/"));
    assert.ok(relayBootstrap.threads.some(thread => thread.id === nativeThread.id));
    assert.equal(fs.existsSync(path.join(blankDir, ".agent-tower", "conversations", "tower.sqlite")), true);
  } finally {
    await tower.shutdown();
  }
}));

test("会话推断只接受工具或 cwd 证据，最近活跃文件不再默认盲猜", () => withProjectSandbox("v028-no-blind-infer", async dir => {
  const unrelated = "33333333-3333-4333-8333-333333333333";
  const toolCaller = "44444444-4444-4444-8444-444444444444";
  const cwdCaller = "55555555-5555-4555-8555-555555555555";
  const blindHost = path.join(dir, "blind-host");
  ordinaryTranscript(blindHost, unrelated, "无关窗口的最近对话");
  assert.equal(inferCallingHostConversation({ appDataDir: blindHost }), "");
  assert.equal(inferCallingHostConversation({ appDataDir: blindHost, allowBlindLatest: true }), unrelated);

  const toolHost = path.join(dir, "tool-host");
  ordinaryTranscript(toolHost, unrelated);
  ordinaryTranscript(toolHost, toolCaller, "调用 delegate_task 派发任务");
  assert.equal(inferCallingHostConversation({ appDataDir: toolHost }), toolCaller);

  const cwdHost = path.join(dir, "cwd-host");
  const cwd = path.join(dir, "Evidence Project");
  fs.mkdirSync(cwd);
  ordinaryTranscript(cwdHost, unrelated);
  ordinaryTranscript(cwdHost, cwdCaller, JSON.stringify({ cwd }));
  assert.equal(inferCallingHostConversation({ appDataDir: cwdHost, cwd }), cwdCaller);
}));

test("direct 急刹只取消当前根会话外部任务并保护宿主与下一轮", () => withProjectSandbox("v028-brake-scope", async dir => {
  const cwd = project(dir, "workspace");
  const otherProject = project(dir, "other");
  const rootA = "root-a";
  const rootB = "root-b";
  const tower = createOrchestrator({
    dataDir: path.join(dir, "control"),
    defaultStudioRoot: cwd,
    catalogLoader: offlineCatalog,
  });
  const handles = [];
  tower.engineManager.runTurn = () => {
    const handle = deferredHandle();
    handles.push(handle);
    return handle;
  };

  try {
    await tower.setConversationPolicy({ conversationId: rootA, orchestrationMode: "relay", workspace: cwd });
    await tower.setConversationPolicy({ conversationId: rootB, orchestrationMode: "relay", workspace: cwd });
    tower.db.upsertThread({
      id: "native-host-a",
      hostConversationId: rootA,
      status: "running",
      activeRunId: "run-native-host-a",
      provider: "antigravity",
      workspace: cwd,
      cwd,
      isNativeHost: true,
      meta: { isNativeHost: true, rootConversationId: rootA, projectRoot: cwd },
    });
    tower.db.upsertRun({ id: "run-native-host-a", threadId: "native-host-a", status: "running", provider: "antigravity" });

    const taskA = await tower.delegateTask({ conversationId: rootA, cwd, workspace: cwd, presetKey: "executor_codex", task: "会话 A" });
    const taskB = await tower.delegateTask({ conversationId: rootB, cwd, workspace: cwd, presetKey: "executor_codex", task: "会话 B" });
    assert.equal(handles.length, 2);

    const stopped = await tower.setConversationPolicy({ conversationId: rootA, dispatchEnabled: false, cancelRunning: true });
    assert.equal(stopped.cancelledCount, 1);
    assert.equal(handles[0].cancels, 1);
    assert.equal(handles[1].cancels, 0);
    assert.equal(tower.db.getRun(taskB.runId).status, "running");
    assert.equal(tower.db.getRun("run-native-host-a").status, "running");
    assert.equal(tower.db.getThread("native-host-a").status, "running");

    const [settingsA, settingsB] = await Promise.all([
      tower.getCapabilities({ cwd }),
      tower.getCapabilities({ cwd: otherProject }),
    ]);
    assert.deepEqual(settingsA.presets, settingsB.presets, "成员池必须跨项目共享");
    assert.deepEqual(settingsA.modeProfiles, settingsB.modeProfiles, "分模式阵容必须跨项目共享");

    handles[1].resolve(completed);
    await tickUntil(() => tower.db.getRun(taskB.runId)?.status === "completed", "会话 B 应正常完成");
    const nextB = await tower.sendToThread({ threadId: taskB.threadId, conversationId: rootB, message: "下一轮" });
    assert.equal(handles.length, 3);
    const stale = await tower.cancelTask({ threadId: taskB.threadId, force: true, expectedRunId: taskB.runId });
    assert.equal(stale.cancelState, "stale_run");
    assert.equal(handles[2].cancels, 0);
    assert.equal(tower.db.getRun(nextB.runId).status, "running");
    assert.equal(tower.db.getRun("run-native-host-a").status, "running");

    handles[2].resolve(completed);
    await tickUntil(() => tower.db.getRun(nextB.runId)?.status === "completed", "会话 B 下一轮应正常完成");
  } finally {
    for (const handle of handles) handle.resolve({ status: "interrupted" });
    await tower.shutdown();
  }
}));

import assert from "node:assert/strict";
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  readNativeConversationTitle, readNativeSwarmSnapshot, resolveConversationRoot, resolveTranscriptPath,
} from "../../core/engines/agy-native.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";

const root = "12345678-0000-4000-8000-123456789abc";
const other = "23456789-0000-4000-8000-123456789abc";
const worker = "34567890-0000-4000-8000-123456789abc";
const planner = (extra) => ({ type: "PLANNER_RESPONSE", status: "DONE", ...extra });
const input = (content) => ({ type: "USER_INPUT", content });
const jsonl = (...steps) => steps.map((step) => JSON.stringify(step) + "\n").join("");

function transcript(host, id, text) {
  const file = resolveTranscriptPath(id, host);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function swarm(host, members, title = "重载协作会话") {
  const dir = path.join(host, "brain", root, ".system_generated", "swarm");
  fs.mkdirSync(dir, { recursive: true });
  const membersFile = path.join(dir, "members.json");
  fs.writeFileSync(membersFile, JSON.stringify({ title, members }));
  fs.writeFileSync(path.join(dir, "board.jsonl"), jsonl({ seq: 1, agent: "worker", time: "2026-11-24T12:00:00Z", text: "协作报告" }));
  return membersFile;
}

const filler = jsonl({ type: "GENERIC", content: "x".repeat(2048) });
const slowEvents = new Set(["turn_item", "reasoning_delta", "tool_call", "message_delta", "usage_updated"]);
const openTower = (dir, cwd) => createOrchestrator({
  dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog,
});

test("重载会话切回和轮询复用终态看板，按会话查线程，且不拉起 Git", (t) => withProjectSandbox("v02101-bootstrap", async (dir) => {
  const cwd = project(dir, "repo");
  const host = path.join(dir, "host");
  fs.mkdirSync(host);
  transcript(host, root, jsonl(input("主会话")));
  // Put a large transcript and many historical directories alongside the active swarm.
  const large = transcript(host, other, jsonl(input("大转录会话")) + filler.repeat(10240) + jsonl(planner({ content: "历史回复" })));
  for (let i = 0; i < 32; i++) transcript(host, `historical-${i}`, jsonl(input(`历史 ${i}`)));
  const members = { coordinator: { role: "coordinator", conversation_id: root } };
  for (let i = 0; i < 4; i++) {
    const id = i ? `swarm-worker-${i}` : worker;
    members[i ? `worker-${i}` : "worker"] = { conversation_id: id, wake_mode: "mentions" };
    transcript(host, id, jsonl(planner({ tool_calls: [{ name: "swarm_wait" }] }), { type: "GENERIC", status: "DONE" }));
  }
  const membersFile = swarm(host, members);
  const tower = openTower(dir, cwd);
  try {
    await tower.setConversationPolicy({ conversationId: root, workspace: cwd, orchestrationMode: "relay" });
    await tower.setConversationPolicy({ conversationId: other, workspace: cwd, orchestrationMode: "relay" });
    for (let i = 0; i < 60; i++) {
      const id = `external-${i}`;
      const runId = `run-${i}`;
      tower.db.upsertThread({ id, workspace: cwd, rootConversationId: root, provider: "codex", status: "completed" });
      tower.db.upsertRun({ id: runId, threadId: id, status: "completed", prompt: `委派 ${i}`, assistantText: i ? `运行回复 ${i}` : "" });
      for (let j = 0; j < 180; j++) {
        tower.db.upsertTurnItem({ id: `${id}-${j}`, threadId: id, runId, type: "tool_call", status: j ? "completed" : "failed", output: "x".repeat(8192) });
      }
      tower.db.upsertTurnItem({ id: `${id}-think`, threadId: id, runId, type: "reasoning", durationMs: 1250 });
      tower.db.upsertTurnItem({ id: `${id}-reply`, threadId: id, runId, type: "assistant_message", text: `轨迹回复 ${i}` });
    }
    tower.db.upsertThread({ id: "other-member", workspace: cwd, rootConversationId: other, provider: "codex", status: "completed" });
    tower.db.upsertRun({ id: "queued-run", threadId: "other-member", status: "queued", prompt: "排队任务" });
    await tower.getBootstrap({ appDataDir: host, workspace: cwd }); // Warm the workspace's root lookup.

    const sql = [];
    const prepare = DatabaseSync.prototype.prepare;
    t.mock.method(DatabaseSync.prototype, "prepare", function (query) {
      sql.push(query);
      return prepare.call(this, query);
    });
    let gitCalls = 0;
    let rosterReads = 0;
    const spawn = cp.spawn;
    const readFileSync = fs.readFileSync;
    const listTurnItems = t.mock.method(tower.db, "listTurnItems");
    const listThreads = t.mock.method(tower.db, "listThreads");
    t.mock.method(cp, "spawn", function (command, ...args) {
      if (/^git(?:\.exe)?$/i.test(path.basename(command))) gitCalls++;
      return spawn.call(this, command, ...args);
    });
    t.mock.method(fs, "readFileSync", function (file, ...args) {
      if (file === membersFile) rosterReads++;
      return readFileSync.call(this, file, ...args);
    });
    syncBuiltinESMExports();
    try {
      const params = { conversationId: root, appDataDir: host, workspace: cwd };
      const measure = async (call) => {
        const start = performance.now();
        const value = await call();
        return { value, elapsed: Math.round(performance.now() - start) };
      };
      const first = await measure(() => tower.getBootstrap(params));
      assert.equal(first.value.threads.length, 65);
      assert.equal(first.value.threads.find(({ hostConversationId }) => hostConversationId === worker).status, "waiting");
      assert.ok(first.value.boardMessages.some((msg) => msg.text === "协作报告"));
      const report = first.value.boardMessages.find((msg) => msg.text === "轨迹回复 0");
      assert.equal(report.toolCount, 180);
      assert.equal(report.failedToolCount, 1);
      assert.equal(report.reasoningSummary, "思考 1.3s");
      assert.ok(first.value.boardMessages.some((msg) => msg.text === "运行回复 1"));
      assert.ok(sql.some((query) => /group by run_id/i.test(query)));
      assert.ok(rosterReads <= 6, `重复读取同一 Swarm 名册 ${rosterReads} 次`);

      const away = await tower.getBootstrap({ ...params, conversationId: other });
      assert.equal(away.conversationTitle, "大转录会话");
      assert.equal(away.threads.find((thread) => thread.id === "other-member").queue[0].text, "排队任务");
      assert.equal(tower.db.getThread(`thr_native_${other}`).meta.nativeTranscriptOffset, fs.statSync(large).size);
      assert.ok(!tower.db.listEvents({ rootConversationId: other }).some((event) => slowEvents.has(event.type)));
      fs.appendFileSync(large, jsonl(planner({ step_index: 50000, content: "后续实时回复" })));
      const live = await tower.getEvents({ ...params, conversationId: other, sinceSeq: away.latestSeq });
      assert.ok(live.events.some((event) => event.type === "message_delta" && event.delta.includes("后续实时回复")));

      sql.length = 0;
      const again = await measure(() => tower.getBootstrap(params));
      assert.deepEqual(again.value.boardMessages, first.value.boardMessages);
      assert.ok(sql.every((query) => !/from turn_items/i.test(query)), "warm Bootstrap must not query turn_items");
      sql.length = 0;
      listThreads.mock.resetCalls();
      const events = await measure(() => tower.getEvents({ ...params, sinceSeq: again.value.latestSeq }));
      assert.equal(events.value.threadDigest.length, 65);
      assert.ok(sql.every((query) => !/from turn_items/i.test(query)), "polling must not query settled turn_items");
      assert.deepEqual(events.value.boardMessages, first.value.boardMessages);
      assert.ok(sql.some((query) => /from threads where .*root_conversation_id = \?/i.test(query)));
      const threadQueries = listThreads.mock.calls.map(({ arguments: args }) => args[0]);
      assert.ok(threadQueries.some((query) => query.limit === 500));
      assert.ok(threadQueries.every((query) => query.rootConversationId === root && query.includeQueue === false));
      const queueSql = sql.filter((query) => /from runs where thread_id = \? and status = 'queued'/i.test(query));
      assert.ok(queueSql.length <= 10, `Unexpected N+1 queue queries: ${queueSql.length}`);
      assert.equal(listTurnItems.mock.callCount(), 0);
      assert.equal(gitCalls, 0);
      assert.ok(first.elapsed < 5000 && again.elapsed < 2500 && events.elapsed < 2500, "Heavy conversation exceeded its timing budget");
      t.diagnostic(`冷 Bootstrap ${first.elapsed} ms，切回 ${again.elapsed} ms，Events ${events.elapsed} ms`);
    } finally {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    }
  } finally {
    await tower.shutdown();
  }
}));

test("跨会话线程超过 500 条时，旧线程仍完整出现在目标会话的三个查询中", () => withProjectSandbox("v02101-scoped-limit", async (dir) => {
  const cwd = project(dir, "repo");
  const host = path.join(dir, "host");
  fs.mkdirSync(host);
  const tower = openTower(dir, cwd);
  try {
    const seed = (id, rootConversationId, updatedAt) => tower.db.upsertThread({
      id, rootConversationId, updatedAt, workspace: cwd, provider: "codex", status: "completed",
    });
    const expected = ["target-oldest", "target-old"];
    expected.forEach((id, i) => seed(id, root, i + 1));
    for (let i = 0; i < 501; i++) seed(`other-${i}`, other, i + 3);

    const params = { conversationId: root, appDataDir: host, workspace: cwd };
    const bootstrap = await tower.getBootstrap(params);
    const listing = await tower.listThreads({ ...params, limit: 500 });
    const events = await tower.getEvents(params);
    const ids = (threads) => threads.map(({ id }) => id).sort();
    assert.deepEqual(ids(events.threadDigest), [...expected].sort());
    assert.deepEqual(ids(bootstrap.threads), ids(events.threadDigest));
    assert.deepEqual(ids(listing.threads), ids(events.threadDigest));
  } finally {
    await tower.shutdown();
  }
}));

test("空白 direct 项目二次静默巡检只读新增字节，且不初始化项目目录", (t) => withProjectSandbox("v02101-passive-direct", async (dir) => {
  const cwd = project(dir, "blank");
  const host = path.join(dir, "host");
  const initial = jsonl(input("直出会话"), planner({ content: "初次回复" }));
  const appended = jsonl(input("第二轮"), planner({ content: "新增回复" }));
  const file = transcript(host, root, initial);
  const tower = openTower(dir, project(dir, "default"));
  const reads = [];
  const open = fs.promises.open;
  t.mock.method(fs.promises, "open", async function (filename, ...args) {
    const handle = await open.call(this, filename, ...args);
    if (filename !== file) return handle;
    const read = handle.read.bind(handle);
    handle.read = (buffer, offset, length, position) => {
      reads.push({ length, position });
      return read(buffer, offset, length, position);
    };
    return handle;
  });
  syncBuiltinESMExports();
  try {
    const params = { conversationId: root, appDataDir: host, workspace: cwd };
    for (let i = 0; i < 2; i++) {
      if (i) fs.appendFileSync(file, appended);
      const bootstrap = await tower.getBootstrap(params);
      const events = await tower.getEvents({ ...params, sinceSeq: bootstrap.latestSeq });
      assert.equal(bootstrap.conversationPolicy.orchestrationMode, "direct");
      assert.deepEqual(bootstrap.threads, []);
      assert.deepEqual(events.threadDigest, []);
      assert.equal(fs.existsSync(path.join(cwd, ".agent-tower")), false);
    }
    assert.deepEqual(reads, [
      { length: Buffer.byteLength(initial), position: 0 },
      { length: Buffer.byteLength(appended), position: Buffer.byteLength(initial) },
    ]);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await tower.shutdown();
  }
}));

test("大转录尾块负责待命状态，标题与子代理扫描按文件复用", (t) => withProjectSandbox("v02101-tails", async (dir) => {
  const host = path.join(dir, "host");
  fs.mkdirSync(host);
  const wait = planner({ tool_calls: [{ name: "swarm_wait" }] });
  const tail = { type: "GENERIC", status: "DONE", content: "y".repeat(80 * 1024) };
  const large = transcript(host, worker, jsonl(input("大文件头标题")) + filler.repeat(10240) + jsonl(wait, tail));
  const roster = swarm(host, { worker: { conversation_id: worker, wake_mode: "mentions" } });
  assert.ok(fs.statSync(large).size > 20 * 1024 * 1024);
  assert.equal(readNativeSwarmSnapshot({ conversationId: root, appDataDir: host }).members[0].state, "waiting");
  fs.appendFileSync(large, jsonl(planner({ tool_calls: [{ name: "read_file" }] })));
  assert.equal(readNativeSwarmSnapshot({ conversationId: root, appDataDir: host }).members[0].state, "working");

  const parent = "historical-parent";
  const child = "45678901-0000-4000-8000-123456789abc";
  const titleFile = transcript(host, child, jsonl(input("初次标题")) + filler);
  const parentFile = transcript(host, parent, jsonl(input("父会话"), planner({ tool_calls: [{ name: "invoke_subagent" }] }), { type: "GENERIC", content: child }));
  const busyFile = transcript(host, "recent-conversation", jsonl(input("活跃会话")));
  for (let i = 0; i < 10; i++) transcript(host, `older-${i}`, filler);
  const reads = [];
  const openSync = fs.openSync;
  t.mock.method(fs, "openSync", function (file, ...args) {
    reads.push(file);
    return openSync.call(this, file, ...args);
  });
  syncBuiltinESMExports();
  try {
    assert.equal(readNativeConversationTitle(root, host, { skipRootResolve: true }), "重载协作会话");
    const rosterData = JSON.parse(fs.readFileSync(roster, "utf8"));
    fs.writeFileSync(roster, JSON.stringify({ ...rosterData, title: "更新后的协作标题" }));
    assert.equal(readNativeConversationTitle(root, host, { skipRootResolve: true }), "更新后的协作标题");
    assert.equal(readNativeConversationTitle(child, host, { skipRootResolve: true }), "初次标题");
    fs.appendFileSync(titleFile, filler);
    reads.length = 0;
    assert.equal(readNativeConversationTitle(child, host, { skipRootResolve: true }), "初次标题");
    assert.deepEqual(reads, []);
    fs.writeFileSync(titleFile, jsonl(input("重置后的标题")));
    assert.equal(readNativeConversationTitle(child, host, { skipRootResolve: true }), "重置后的标题");

    resolveConversationRoot(child, host);
    assert.ok(reads.includes(parentFile));
    fs.appendFileSync(busyFile, filler);
    reads.length = 0;
    resolveConversationRoot(child, host);
    assert.ok(reads.includes(busyFile));
    assert.ok(reads.every((file) => file === busyFile), `重扫历史转录 ${reads.join(", ")}`);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
}));

test("已被看板覆盖的 20 个终态线程零后台 RPC，打开抽屉后合并顶层 items", async (t) => {
  const { state } = await import("../../sidecars/studio/ui/state.js");
  const { normalizeThread } = await import("../../sidecars/studio/ui/normalize.js");
  const { ingestStreamPayload } = await import("../../sidecars/studio/ui/stream.js");
  const { openMemberDrawer } = await import("../../sidecars/studio/ui/members-view.js");
  const globals = { window: { sidecar: { conversationId: root } }, document: { getElementById: () => null }, requestAnimationFrame: () => 0 };
  for (const [name, value] of Object.entries(globals)) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
    t.after(() => previous ? Object.defineProperty(globalThis, name, previous) : Reflect.deleteProperty(globalThis, name));
  }
  state.activeConversationId = state.rootConversationId = root;
  state.conversationUnbound = false;
  state.boardMessages = [];
  const items = [{ id: "activity", type: "tool_call", title: "完整轨迹" }];
  const rpc = t.mock.method(globalThis, "fetch", async (_url, init) => {
    const { method, params } = JSON.parse(init.body);
    assert.equal(method, "readThread");
    const thread = { id: params.threadId, rootConversationId: root, status: "completed" };
    return { ok: true, json: async () => ({ result: { thread, items } }) };
  });
  const messages = Array.from({ length: 20 }, (_, i) => {
    const id = `covered-${i}`;
    state.threadsMap.set(id, normalizeThread({ id, rootConversationId: root, status: "completed" }));
    return { threadId: id, seq: i + 1, text: `汇报 ${i}`, agent: id, source: "orchestrator-result" };
  });
  ingestStreamPayload({ rootConversationId: root, events: [], boardMessages: messages });
  assert.equal(state.boardMessages.length, 20);
  assert.equal(rpc.mock.callCount(), 0);
  openMemberDrawer("covered-0");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rpc.mock.callCount(), 1);
  assert.equal(state.threadsMap.get("covered-0").items[0].title, "完整轨迹");
});

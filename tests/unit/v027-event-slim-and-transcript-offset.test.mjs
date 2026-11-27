import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";
import {
  ingestNativeConversation,
  readNativeTranscriptSnapshot,
  resolveNativeSwarmLocation,
  resolveTranscriptPath,
} from "../../core/engines/agy-native.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { offlineCatalog } from "../helpers/fixtures.mjs";
import { repoRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

const frontendRoot = "v027-frontend";
let eventsRequest = null;
let listThreadsRequest = null;
globalThis.window = {
  location: { pathname: "/", search: "", hash: "", href: "http://127.0.0.1/" },
};
globalThis.document = {
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
};
globalThis.requestAnimationFrame = () => 0;
globalThis.fetch = async (url, init = {}) => {
  const target = String(url);
  if (target.startsWith("api/events")) {
    if (!eventsRequest) throw Error("unexpected api/events request");
    return eventsRequest(target);
  }
  if (target.startsWith("api/rpc")) {
    const { method } = JSON.parse(init.body);
    if (method === "listThreads" && listThreadsRequest) return listThreadsRequest();
    return { ok: true, status: 200, json: async () => ({ result: {} }) };
  }
  return { ok: true, status: 200, json: async () => ({}) };
};

const uiModule = file => import(pathToFileURL(path.join(repoRoot, "sidecars", "studio", "ui", file)).href);
const { state } = await uiModule("state.js");
const { normalizeBoardMessage, normalizeThread } = await uiModule("normalize.js");
const stream = await uiModule("stream.js");

function iso(ms) {
  return new Date(ms).toISOString();
}

function writeTranscript(appDataDir, conversationId, steps) {
  const file = resolveTranscriptPath(conversationId, appDataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, steps.map(step => JSON.stringify(step)).join("\n") + (steps.length ? "\n" : ""));
}

function appendTranscript(appDataDir, conversationId, steps) {
  fs.appendFileSync(resolveTranscriptPath(conversationId, appDataDir), steps.map(step => JSON.stringify(step)).join("\n") + "\n");
}

function writeRoster(appDataDir, root, worker) {
  const swarmDir = path.join(appDataDir, "brain", root, ".system_generated", "swarm");
  fs.mkdirSync(swarmDir, { recursive: true });
  const membersFile = path.join(swarmDir, "members.json");
  fs.writeFileSync(membersFile, JSON.stringify({ title: "v0.2.7", members: {
    coordinator: { role: "coordinator", conversation_id: root },
    worker: { role: "worker", conversation_id: worker, wake_mode: "mentions", applied_model: "gemini-4-argon-high" },
  } }));
  return { swarmDir, membersFile };
}

function openTower(dir, cwd) {
  return createOrchestrator({
    dataDir: path.join(dir, "control"),
    defaultStudioRoot: cwd,
    catalogLoader: offlineCatalog,
    recoverStaleState: false,
  });
}

function historyEventCount(tower, worker) {
  return tower.db.listEvents({ limit: 2000 }).filter(event =>
    event.threadId === `thr_native_${worker}` && ["tool_call", "message_delta"].includes(event.type)).length;
}

test("500 条看板消息仅落轻量事件，轮询保留完整看板，SSE 单飞补齐看板和缺卡成员", () => withProjectSandbox("v027-event-slim", async dir => {
  const cwd = path.join(dir, "repo");
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir, { recursive: true });
  const root = "12345678-0000-4000-8000-123456789abc";
  const worker = "23456789-0000-4000-8000-123456789abc";
  fs.mkdirSync(cwd, { recursive: true });
  writeTranscript(appDataDir, root, []);
  writeTranscript(appDataDir, worker, []);
  const { swarmDir } = writeRoster(appDataDir, root, worker);
  const board = Array.from({ length: 500 }, (_, index) => ({
    seq: index + 1,
    agent: index % 2 ? "worker" : "coordinator",
    text: `${index % 2 ? "@coordinator" : "@worker"} ${"看板消息".repeat(80)}`,
    time: iso(Date.parse("2026-11-23T08:00:00.000Z") + index * 1000),
  }));
  fs.writeFileSync(path.join(swarmDir, "board.jsonl"), board.map(message => JSON.stringify(message)).join("\n") + "\n");

  const tower = openTower(dir, cwd);
  try {
    await tower.setConversationPolicy({ conversationId: root, workspace: cwd, orchestrationMode: "relay" });
    const payload = await tower.getEvents({ conversationId: root, appDataDir, workspace: cwd });
    assert.equal(payload.boardMessages.length, 500);
    assert.ok(payload.collaborationEdges.length > 0);
    const event = tower.db.listEvents({ limit: 2000 }).filter(item => item.type === "swarm_snapshot").at(-1);
    assert.ok(event);
    assert.ok(Buffer.byteLength(JSON.stringify(event), "utf8") < 2048, `事件体积 ${Buffer.byteLength(JSON.stringify(event), "utf8")}`);
    assert.equal(event.swarm.messageCount, 500);
    assert.equal(event.swarm.edgeCount, payload.collaborationEdges.length);
    assert.equal("messages" in event.swarm, false);
    assert.equal("edges" in event.swarm, false);
  } finally {
    await tower.shutdown();
  }

  state.activeConversationId = state.rootConversationId = frontendRoot;
  state.conversationUnbound = false;
  state.connMode = "sse";
  state.latestSeq = 40;
  state.boardMessages = [];
  state.collaborationEdges = [];
  state.threadsMap.clear();
  state.archivedThreadIds.clear();
  let releaseEvents;
  let eventCalls = 0;
  let listCalls = 0;
  let requestedUrl = "";
  eventsRequest = async target => {
    eventCalls++;
    requestedUrl = target;
    await new Promise(resolve => { releaseEvents = resolve; });
    return {
      ok: true,
      status: 200,
      json: async () => ({ boardMessages: board, collaborationEdges: [{ from: "coordinator", to: "worker", count: 250 }], events: [] }),
    };
  };
  listThreadsRequest = async () => {
    listCalls++;
    return { ok: true, status: 200, json: async () => ({ result: { threads: [{
      id: `thr_native_${worker}`, rootConversationId: frontendRoot, status: "waiting", items: [],
    }] } }) };
  };
  const lightEvent = {
    type: "swarm_snapshot",
    rootConversationId: frontendRoot,
    swarm: {
      found: true,
      rootConversationId: frontendRoot,
      head: 500,
      messageCount: 500,
      edgeCount: 1,
      members: [{ name: "worker", conversation_id: worker, state: "waiting" }],
    },
  };
  try {
    stream.ingestStreamPayload(lightEvent);
    stream.ingestStreamPayload(lightEvent);
    assert.equal(eventCalls, 1, "轻量 SSE 看板补拉必须单飞");
    releaseEvents();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.boardMessages.length, 500);
    assert.equal(state.collaborationEdges.length, 1);
    assert.equal(state.threadsMap.has(`thr_native_${worker}`), true);
    assert.equal(listCalls, 1, "缺失成员仍由原补卡逻辑单飞恢复");
    const query = new URL(requestedUrl, "http://127.0.0.1").searchParams;
    assert.equal(query.get("limit"), "1");
    assert.equal(query.get("conversationId"), frontendRoot);
    state.connMode = "poll";
    stream.ingestStreamPayload({ ...lightEvent, swarm: { ...lightEvent.swarm, head: 501, messageCount: 501 } });
    assert.equal(eventCalls, 1, "轮询模式不得额外补拉看板");

    // Mixed board: an orchestrator-dispatch card (seq = maxSeq + 1) must not mask newer native posts, and a higher
    // head that arrives while the first request is in flight gets exactly one trailing catch-up.
    stream.resetSwarmBoardWatermark();
    state.connMode = "sse";
    const native = n => Array.from({ length: n }, (_, i) => ({ seq: i + 1, from: "worker", text: `post ${i + 1}`, source: "native-swarm" }));
    const withCard = posts => [...posts, { seq: posts.length + 1, from: "coordinator", text: "dispatch", source: "orchestrator-dispatch" }];
    state.boardMessages = withCard(native(3)).map((m, i) => normalizeBoardMessage(m, i));
    const releases = [];
    let served = 3;
    eventCalls = 0;
    eventsRequest = async () => {
      eventCalls++;
      await new Promise(resolve => releases.push(resolve));
      const upTo = served;
      return { ok: true, status: 200, json: async () => ({ boardMessages: withCard(native(upTo)), collaborationEdges: [], events: [] }) };
    };
    const mixed = (head, messageCount) => ({ ...lightEvent, swarm: { ...lightEvent.swarm, head, messageCount } });
    stream.ingestStreamPayload(mixed(4, 4));
    assert.equal(eventCalls, 1, "本地混排 orchestrator-dispatch 卡片时仍按原生水位触发补拉");
    stream.ingestStreamPayload(mixed(4, 4));
    assert.equal(eventCalls, 1, "同 head 连发在途期间只请求一次");
    stream.ingestStreamPayload(mixed(5, 5));
    assert.equal(eventCalls, 1, "在途期间到达更高 head 先记入目标水位");
    served = 4;
    releases.shift()();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(eventCalls, 2, "首批落后于在途期间的新 head 时补发唯一一次尾随同步");
    served = 5;
    releases.shift()();
    for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.boardMessages.filter(m => m.source === "native-swarm").length, 5, "尾帧不丢失");
    stream.ingestStreamPayload(mixed(5, 5));
    stream.ingestStreamPayload(mixed(5, 5));
    assert.equal(eventCalls, 2, "已追平水位后同 head 不再请求");
  } finally {
    releaseEvents?.();
    eventsRequest = null;
    listThreadsRequest = null;
    for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
  }
}));

test("子会话偏移跨 Orchestrator 重启续读，新步骤精准追加，截断后安全归零", () => withProjectSandbox("v027-resume", async dir => {
  const cwd = path.join(dir, "repo");
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir, { recursive: true });
  const root = "34567890-0000-4000-8000-123456789abc";
  const worker = "45678901-0000-4000-8000-123456789abc";
  const t0 = Date.parse("2026-11-23T09:00:00.000Z");
  fs.mkdirSync(cwd, { recursive: true });
  writeTranscript(appDataDir, root, []);
  writeRoster(appDataDir, root, worker);
  writeTranscript(appDataDir, worker, [
    { type: "USER_INPUT", step_index: 1, created_at: iso(t0), content: "历史任务" },
    { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(t0 + 1000), status: "DONE", input_tokens: 10,
      tool_calls: [{ name: "read_file", args: { path: "a.txt" } }] },
    { type: "GENERIC", step_index: 3, created_at: iso(t0 + 2000), status: "DONE", content: "旧输出" },
    { type: "PLANNER_RESPONSE", step_index: 4, created_at: iso(t0 + 3000), status: "DONE", content: "历史完成", tool_calls: [] },
  ]);

  let firstOffset = 0;
  let firstCount = 0;
  let firstTiming;
  let tower = openTower(dir, cwd);
  try {
    await tower.setConversationPolicy({ conversationId: root, workspace: cwd, orchestrationMode: "relay" });
    await tower.getEvents({ conversationId: root, appDataDir, workspace: cwd });
    firstOffset = Number(tower.db.getThread(`thr_native_${worker}`)?.meta?.nativeTranscriptOffset || 0);
    firstCount = historyEventCount(tower, worker);
    firstTiming = (({ completedAt, durationMs }) => ({ completedAt, durationMs }))(tower.db.getThread(`thr_native_${worker}`));
    assert.ok(firstOffset > 0);
    assert.ok(firstCount > 0);
    assert.ok(firstTiming.completedAt > 0 && firstTiming.durationMs > 0, JSON.stringify(firstTiming));
  } finally {
    await tower.shutdown();
  }

  tower = openTower(dir, cwd);
  try {
    await tower.getEvents({ conversationId: root, appDataDir, workspace: cwd });
    assert.equal(historyEventCount(tower, worker), firstCount, "重启后不得重刷历史 tool_call/message_delta");
    const resumedThread = tower.db.getThread(`thr_native_${worker}`);
    assert.deepEqual({ completedAt: resumedThread.completedAt, durationMs: resumedThread.durationMs }, firstTiming,
      "重启断点续读不得清零已完结成员的 completedAt / durationMs");
    assert.equal(Number(tower.db.getThread(`thr_native_${worker}`)?.meta?.nativeTranscriptOffset || 0), firstOffset);
    appendTranscript(appDataDir, worker, [
      { type: "PLANNER_RESPONSE", step_index: 5, created_at: iso(t0 + 4000), status: "DONE", content: "断点后新消息", tool_calls: [] },
    ]);
    await tower.getEvents({ conversationId: root, appDataDir, workspace: cwd });
    assert.equal(historyEventCount(tower, worker), firstCount + 1, "只追加新步骤对应事件");
    assert.ok(Number(tower.db.getThread(`thr_native_${worker}`)?.meta?.nativeTranscriptOffset || 0) > firstOffset);
  } finally {
    await tower.shutdown();
  }

  writeTranscript(appDataDir, worker, [
    { type: "GENERIC", step_index: 1, created_at: iso(t0 + 5000), status: "DONE", content: "无归属输出" },
    { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(t0 + 6000), status: "DONE", content: "重建后消息", tool_calls: [] },
  ]);
  const resumed = await readNativeTranscriptSnapshot({
    appDataDir,
    conversationId: worker,
    fromByteOffset: firstOffset,
    initialUsage: { inputTokens: 999, totalTokens: 999 },
    initialPendingTools: [{ toolCallId: "stale", toolName: "read_file", createdAt: t0 }],
    initialOpenReasoning: { stepIdx: 99, createdMs: t0, text: "stale reasoning" },
  });
  assert.equal(resumed.nextByteOffset, fs.statSync(resolveTranscriptPath(worker, appDataDir)).size);
  assert.equal(resumed.events.some(event => event.type === "tool_call" || event.type === "reasoning_delta"), false);
  assert.deepEqual(resumed.pendingTools, []);
  assert.equal(resumed.openReasoning, null);
  assert.equal(resumed.usage.inputTokens, 0);
  assert.ok(resumed.events.some(event => event.type === "message_delta" && event.text.includes("重建后消息")));
  const replayed = [];
  const truncatedWatcher = ingestNativeConversation({
    appDataDir,
    conversationId: worker,
    fromByteOffset: firstOffset,
    followSubagents: false,
    watch: false,
    onEvent: event => replayed.push(event),
  });
  try {
    await truncatedWatcher.initialSyncPromise;
    assert.equal(truncatedWatcher.getOffset(), fs.statSync(resolveTranscriptPath(worker, appDataDir)).size);
    assert.ok(replayed.some(event => event.type === "message_delta" && event.text.includes("重建后消息")));
  } finally {
    truncatedWatcher.stop();
  }
}));

test("花名册索引不重复解析，子 watcher 不重复轮询，空闲三级退避并在新消息时恢复", () => withProjectSandbox("v027-poll-cache", async dir => {
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir, { recursive: true });
  const root = "56789012-0000-4000-8000-123456789abc";
  const worker = "67890123-0000-4000-8000-123456789abc";
  const plain = "78901234-0000-4000-8000-123456789abc";
  const t0 = Date.parse("2026-11-23T10:00:00.000Z");
  writeTranscript(appDataDir, root, []);
  writeTranscript(appDataDir, worker, [
    { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(t0), status: "DONE", content: "等待", tool_calls: [] },
  ]);
  writeTranscript(appDataDir, plain, [
    { type: "PLANNER_RESPONSE", step_index: 1, created_at: iso(t0), status: "DONE", content: "空闲", tool_calls: [] },
  ]);
  const { membersFile } = writeRoster(appDataDir, root, worker);
  const originalReadFileSync = fs.readFileSync;
  let rosterReads = 0;
  fs.readFileSync = function (file, ...args) {
    if (path.resolve(String(file)) === path.resolve(membersFile)) rosterReads++;
    return originalReadFileSync.call(this, file, ...args);
  };
  syncBuiltinESMExports();
  let rootWatcher;
  let watcher;
  try {
    assert.equal(resolveNativeSwarmLocation(plain, appDataDir), null);
    assert.equal(resolveNativeSwarmLocation(plain, appDataDir), null);
    assert.equal(resolveNativeSwarmLocation(worker, appDataDir)?.rootConversationId, root);
    assert.equal(resolveNativeSwarmLocation(worker, appDataDir)?.rootConversationId, root);
    assert.equal(rosterReads, 1, "未命中与正向命中均复用指纹索引，不重复解析");

    rootWatcher = ingestNativeConversation({ appDataDir, conversationId: root, watch: false, pollIntervalMs: 800 });
    await rootWatcher.initialSyncPromise;
    const beforeRootSync = rosterReads;
    await rootWatcher.syncNow();
    assert.equal(rosterReads - beforeRootSync, 1, "根 watcher 同步一拍只读取一次花名册，子 watcher 不重复轮询");
    rootWatcher.stop();
    rootWatcher = null;

    watcher = ingestNativeConversation({
      appDataDir,
      conversationId: plain,
      followSubagents: false,
      watch: true,
      pollIntervalMs: 800,
    });
    await watcher.initialSyncPromise;
    assert.equal(watcher.getPollDelayMs(), 800);
    for (let idle = 1; idle <= 8; idle++) {
      await watcher.syncNow({ resetIdle: false });
      assert.equal(watcher.getPollDelayMs(), idle >= 8 ? 10000 : idle >= 2 ? 3000 : 800);
    }
    await watcher.syncNow();
    assert.equal(watcher.getPollDelayMs(), 800, "显式 syncNow 立即恢复活跃轮询");
    appendTranscript(appDataDir, plain, [
      { type: "PLANNER_RESPONSE", step_index: 2, created_at: iso(t0 + 1000), status: "DONE", content: "新消息", tool_calls: [] },
    ]);
    await watcher.syncNow({ resetIdle: false });
    assert.equal(watcher.getPollDelayMs(), 800, "新字节写入立即恢复活跃轮询");
  } finally {
    watcher?.stop();
    rootWatcher?.stop();
    fs.readFileSync = originalReadFileSync;
    syncBuiltinESMExports();
  }
}));

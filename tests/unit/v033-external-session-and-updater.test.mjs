import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startCoreDaemon } from "../../core/daemon.mjs";
import { daemonRpc, ensureDaemon, readDaemonLease } from "../../core/daemon-client.mjs";
import { runGenericAcpTurn } from "../../core/engines/generic-acp.mjs";
import { runKimiTurn } from "../../core/engines/kimi-acp.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { createUpdater } from "../../core/updater.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { within } from "../helpers/process.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";

const updating = { code: "DAEMON_UPDATING" };
const sha = "a".repeat(64);
const fixture = (name, action) => withProjectSandbox(name, async dir => {
  const cwd = project(dir, "repo");
  const dataDir = path.join(dir, "control");
  await action({ cwd, dataDir, dir, defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
});
function writeUpdate(dataDir, name, body) {
  const dir = path.join(dataDir, "updates");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(body));
}

test("禁网时仅环境变量覆盖 feed 不能触发请求", t => fixture("v033-offline-feed", async ({ dataDir }) => {
  const previous = process.env.AGENT_TOWER_UPDATE_FEED_URL;
  process.env.AGENT_TOWER_UPDATE_FEED_URL = "https://example.invalid/test-feed";
  const fetch = t.mock.method(globalThis, "fetch", async () => Response.json([]));
  const updater = createUpdater({ dataDir, currentVersion: "0.3.3" });
  try {
    updater.schedule();
    await updater.check();
    await delay(5);
    assert.equal(fetch.mock.callCount(), 0);
  } finally {
    updater.close();
    if (previous === undefined) delete process.env.AGENT_TOWER_UPDATE_FEED_URL;
    else process.env.AGENT_TOWER_UPDATE_FEED_URL = previous;
  }
}));

test("项目会话可见性跟随全局，覆盖值独立于阵容和其他项目", () => fixture("v033-settings", async options => {
  const { cwd, dir, dataDir } = options;
  const other = project(dir, "other");
  const o = createOrchestrator(options);
  const events = [];
  const off = o.subscribe(event => events.push(event));
  const read = workspace => o.getBootstrap({ workspace });
  const saveMode = mode => o.saveSettings({ scope: "project", workspace: cwd, projectExternalSessionMode: mode });
  try {
    const before = await read(cwd);
    assert.equal(before.settings.defaultExternalSessionVisible, false);
    assert.equal(before.settings.autoCheckUpdates, true);
    assert.equal(before.projectConfig.externalSessionMode, "inherit");
    assert.equal(before.projectConfig.externalSessionVisible, false);
    await saveMode("hidden");
    await o.saveSettings({ scope: "global", defaultExternalSessionVisible: true, autoCheckUpdates: false });
    assert.equal((await read(other)).projectConfig.externalSessionVisible, true);
    assert.equal((await read(cwd)).projectConfig.externalSessionVisible, false);
    assert.equal((await read(cwd)).settings.autoCheckUpdates, false);
    assert.equal((await saveMode("visible")).projectConfig.externalSessionVisible, true);
    assert.equal((await saveMode("inherit")).projectConfig.externalSessionCustomized, false);
    assert.equal(o.db.isProjectExternalSessionVisible(cwd), true);
    const polled = await o.getEvents({ workspace: cwd });
    assert.equal(polled.settings.defaultExternalSessionVisible, true);
    assert.equal(polled.projectConfig.externalSessionVisible, true);
    assert.equal((await read(cwd)).projectConfig.rosterRevision, before.projectConfig.rosterRevision);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, "global-settings.json"), "utf8"));
    const profile = persisted.projectProfiles[before.projectConfig.projectKey];
    assert.equal(profile.externalSessions.mode, "inherit");
    assert.ok(profile.externalSessions.updatedAt > 0);
    assert.equal(Object.hasOwn(profile, "roster"), false);
    assert.equal(events.filter(event => event.type === "project_config_updated").length, 3);
    await assert.rejects(saveMode("invalid"), { code: "INVALID_EXTERNAL_SESSION_MODE" });
    await assert.rejects(o.saveSettings({ scope: "project", workspace: cwd, autoCheckUpdates: false }));
  } finally { off(); await o.shutdown(); }
}));

test("无痕派发复用成员卡，续聊和队列使用本地摘要，干净工单重新锁定可见性", () => fixture("v033-continuation", async options => {
  const o = createOrchestrator(options);
  const params = { cwd: options.cwd, conversationId: "v033-conversation", presetKey: "executor_codex", isolation: "shared" };
  const seen = [];
  let hold = false;
  o.db.saveSettings({ defaultOrchestrationMode: "complex" });
  o.engineManager.runTurn = config => {
    const { promise, resolve } = Promise.withResolvers();
    const finish = text => resolve({ status: "completed", assistantText: text, nativeSessionId: "native-key" });
    seen.push({ ...config, finish });
    config.onEvent({ type: "session_bound", nativeSessionId: "native-key" });
    if (!hold) finish("结论".repeat(500));
    return { result: promise, async steer() { return { supported: false }; }, async cancel() { resolve({ status: "interrupted" }); } };
  };
  const dispatch = (task, extras = {}) => o.delegateTask({ ...params, task, mode: "wait", ...extras });
  try {
    const first = await dispatch("第一张工单");
    const { threadId, runId } = await dispatch("本地续聊的上一轮指令");
    assert.equal(first.threadId, threadId);
    assert.equal(o.db.getThread(threadId).meta.externalSessionVisible, false);
    assert.equal(o.db.getThread(threadId).meta.ephemeral, undefined);
    assert.equal(o.db.getThread(threadId).nativeSessionId, "");
    assert.equal(o.db.getRun(runId).meta.injectedSpecs.ledgerState, "not_applicable");
    assert.doesNotMatch(String(seen.at(-1).prompt), /Local Continuation Context/);
    o.db.upsertTurnItem({ id: "file-fixture", threadId, runId, type: "file_change", filePath: "src/example.mjs" });
    for (let i = 0; i < 81; i++) {
      o.db.upsertTurnItem({ id: `progress-${i}`, threadId, runId, type: "subagent", text: "progress" });
    }
    await o.saveSettings({ scope: "global", defaultExternalSessionVisible: true });
    await o.sendToThread({ threadId, message: "发给同一成员", wait: true });
    const prompt = String(seen.at(-1).prompt);
    const digest = prompt.slice(prompt.indexOf("[Local Continuation Context]"), prompt.indexOf("\n\n[Current User Instruction]"));
    assert.match(digest, /本地续聊的上一轮指令/);
    assert.match(digest, /Earlier Conclusion/);
    assert.match(digest, /Latest Conclusion/);
    assert.match(digest, /src\/example\.mjs/);
    assert.ok(Buffer.byteLength(digest) <= 2048);
    assert.equal(seen.at(-1).ephemeral, true);
    const continued = await dispatch("继续工单", { continueSession: true });
    assert.equal(continued.threadId, threadId);
    assert.match(String(seen.at(-1).prompt), /Local Continuation Context/);
    assert.equal(o.db.getRun(continued.runId).prompt, "继续工单");
    hold = true;
    await o.sendToThread({ threadId, message: "执行中的工单" });
    const restart = await o.sendToThread({ threadId, message: "立即修订", mode: "steer" });
    assert.equal(restart.action, "steering_restart");
    assert.equal(seen.at(-1).ephemeral, true);
    assert.match(String(seen.at(-1).prompt), /执行中的工单/);
    const count = seen.length;
    await o.sendToThread({ threadId, message: "排队续聊", mode: "queue" });
    hold = false;
    seen.at(-1).finish("最新结论");
    await within((async () => {
      while (seen.length === count) await delay(10);
      while (o.hasActiveRuns()) await delay(10);
    })(), 4000, "queued turn");
    assert.equal(seen.at(-1).ephemeral, true);
    assert.match(String(seen.at(-1).prompt), /最新结论/);
    const visible = await dispatch("新的可见工单");
    assert.equal(visible.threadId, threadId);
    assert.equal(seen.at(-1).ephemeral, false);
    assert.equal(o.db.getThread(threadId).nativeSessionId, "native-key");
    await dispatch("可见的原生续聊", { continueSession: true });
    assert.equal(seen.at(-1).nativeSessionId, "native-key");
    assert.doesNotMatch(String(seen.at(-1).prompt), /Local Continuation Context/);
    const disposable = await dispatch("单次临时卡", { ephemeral: true, persistSession: true });
    assert.notEqual(disposable.threadId, threadId);
    assert.equal(o.db.getThread(disposable.threadId).meta.ephemeral, true);
    assert.equal(seen.at(-1).ephemeral, true);
    await o.saveSettings({ scope: "project", workspace: options.cwd, projectExternalSessionMode: "hidden" });
    await dispatch("本轮主动保留", { persistSession: true });
    assert.equal(seen.at(-1).ephemeral, false);
  } finally { seen.at(-1)?.finish("cleanup"); await o.shutdown(); }
}));

test("Releases 用 ETag 缓存四段版本，404、限流与空列表平滑降级", () => fixture("v033-update-feed", async options => {
  const { dataDir } = options;
  writeUpdate(dataDir, "install.json", { origin: "zip", version: "0.3.3" });
  const notes = "# Head\n<script>hidden()</script><b>plain</b> [more](https://example.invalid)\n" + "字".repeat(2005);
  const request = [];
  const replies = [
    Response.json([
      { tag_name: "v2.0.0", draft: true }, { tag_name: "v1.0.0", prerelease: true },
      { tag_name: "v0.3.3.01" }, { tag_name: "v0.3.3" },
      { tag_name: "v0.3.3.1", body: notes, html_url: "https://example.invalid/release", assets: [
        { name: "agent-tower-v0.3.3.1.zip", digest: `sha256:${sha}`, browser_download_url: "https://github.com/fixture.zip" },
        { name: "release-manifest.json", digest: `sha256:${"b".repeat(64)}`, browser_download_url: "https://github.com/release-manifest.json" },
      ] },
    ], { headers: { etag: '"fixture"' } }),
    new Response(null, { status: 304 }),
    new Response(null, { status: 404 }),
    new Response(null, { status: 403 }),
    Response.json([]),
    Response.json([{ tag_name: "v0.3.3.0" }]),
  ];
  const config = {
    dataDir, currentVersion: "0.3.3",
    autoCheck: () => false,
    fetchImpl: async (url, init) => { request.push({ url, ...init }); return replies.shift(); },
  };
  writeUpdate(dataDir, "state.json", { latestVersion: "0.3.3.1", etag: '"before-download-urls"' });
  const updater = createUpdater(config);
  try {
    assert.throws(() => createUpdater({ ...config, feedUrl: "https://example.invalid/feed" }), { code: "UPDATE_NOT_AVAILABLE" });
    const first = updater.check();
    assert.equal(updater.status().state, "checking");
    assert.equal(updater.check(), first);
    const found = await first;
    assert.equal(found.state, "available");
    assert.equal(found.latestVersion, "0.3.3.1");
    assert.equal(found.assetSha256, sha);
    assert.equal(found.installOrigin, "zip");
    assert.equal(found.autoUpdateSupported, true);
    assert.equal(found.cancellable, false);
    assert.deepEqual(found.progress, { phase: "", percent: null, downloadedBytes: 0, totalBytes: 0, message: "" });
    assert.deepEqual(found.rollback, { available: false, version: "", backedUpAt: "", rollbackSafe: true });
    assert.deepEqual(found.lastResult, { status: "", fromVersion: "", toVersion: "", at: 0, message: "" });
    assert.equal(found.releaseUrl, "https://example.invalid/release");
    assert.match(found.releaseNotes, /^Head\nplain more/);
    assert.equal(Array.from(found.releaseNotes).length, 2000);
    assert.equal(request[0].headers["User-Agent"], "AgentTower-Updater");
    assert.equal(request[0].headers["If-None-Match"], undefined);
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, "updates", "state.json"), "utf8"));
    assert.ok(cache.nextCheckAt - cache.lastCheckedAt >= 12 * 60 * 60 * 1000);
    assert.equal(cache.manifestSha256, "b".repeat(64));
    assert.equal(cache.assetUrl, "https://github.com/fixture.zip");
    assert.equal(cache.manifestUrl, "https://github.com/release-manifest.json");
    updater.dismiss("v0.3.3.1");
    const restarted = createUpdater(config);
    try {
      assert.equal(restarted.status().dismissedVersion, found.latestVersion);
      assert.equal((await restarted.check()).state, "available");
      assert.equal(request[1].headers["If-None-Match"], '"fixture"');
      for (let i = 0; i < 3; i++) {
        const unavailable = await restarted.check();
        assert.equal(unavailable.state, "unavailable");
        assert.equal(unavailable.hasUpdate, false);
        assert.equal(unavailable.error, "");
      }
      assert.equal((await restarted.check()).state, "up_to_date");
    } finally { restarted.close(); }
  } finally { updater.close(); }
}));

test("测试模式默认零外网，排空检查覆盖正在进入的写操作和待发队列", () => fixture("v033-quiesce", async options => {
  const o = createOrchestrator(options);
  const update = action => o.systemUpdate({ action });
  const events = [];
  const off = o.subscribe(event => events.push(event));
  try {
    assert.equal((await update("check")).state, "idle");
    assert.equal(fs.existsSync(path.join(options.dataDir, "updates", "state.json")), false);
    const save = o.saveSettings({ scope: "global", defaultExternalSessionVisible: true });
    assert.equal((await update("prepareCutover")).busy.activeWrites, 1);
    await save;
    o.db.upsertThread({ id: "queued", cwd: options.cwd, workspace: options.cwd, status: "idle" });
    o.db.upsertRun({ id: "queued-run", threadId: "queued", status: "queued", prompt: "waiting" });
    assert.equal((await update("prepareCutover")).busy.queuedRuns, 1);
    await o.manageQueue({ threadId: "queued", queueId: "queued-run", action: "cancel" });
    const specWrite = o.specCuration({ action: "setEnabled", workspace: options.cwd, enabled: true });
    assert.equal((await update("prepareCutover")).busy.activeSpecWrites, 1);
    await specWrite;
    assert.equal((await update("prepareCutover")).quiescing, true);
    await assert.rejects(o.delegateTask({ task: "later" }), updating);
    await assert.rejects(o.handleRpc("saveSettings", { scope: "global", autoCheckUpdates: false }), updating);
    await assert.rejects(update("check"), updating);
    await assert.rejects(o.specCuration({ action: "archive", workspace: options.cwd }), updating);
    const hostGate = o.getConversationPolicy({ hostToolName: "invoke_subagent" });
    assert.equal(hostGate.hostToolAllowed, false);
    assert.match(hostGate.hostToolReason, /DAEMON_UPDATING/);
    await assert.rejects(o.cancelTask({ runId: "absent" }), /找不到要中断/);
    await assert.rejects(o.respondRuntimeRequest({}), /找不到待处理/);
    assert.equal((await o.getBootstrap()).systemUpdate.state, "quiescing");
    const replay = await o.getEvents({ conversationId: "other-root" });
    assert.equal(replay.systemUpdate.state, "quiescing");
    assert.ok(replay.events.some(event => event.type === "system_update_changed"));
    assert.equal((await update("cancelCutover")).quiescing, false);
    assert.equal(events.filter(event => event.type === "system_update_changed").length, 2);
    assert.equal((await o.saveSettings({ autoCheckUpdates: false })).ok, true);
  } finally { off(); await o.shutdown(); }
}));

test("试用期启动即拦写，Daemon 内部排空路由和存活 PID 锁生效", () => fixture("v033-probation", async options => {
  const { dataDir, cwd } = options;
  writeUpdate(dataDir, "probation.json", { version: "0.3.3" });
  writeUpdate(dataDir, "apply.lock", { pid: process.pid });
  await assert.rejects(ensureDaemon({ dataDir, timeoutMs: 100 }), updating);
  assert.equal(fs.existsSync(path.join(dataDir, "daemon-lease.json")), false);
  fs.unlinkSync(path.join(dataDir, "updates", "apply.lock"));
  const daemon = await startCoreDaemon(options);
  try {
    const pinnedOwner = readDaemonLease(dataDir);
    const rpc = (method, params) => daemonRpc(method, params, { dataDir, pinnedOwner, timeoutMs: 3000 });
    assert.equal((await rpc("getEvents")).systemUpdate.state, "quiescing");
    await assert.rejects(rpc("configureThread", {}), updating);
    assert.equal((await rpc("systemUpdate", { action: "cancelCutover" })).quiescing, true);
    fs.writeFileSync(path.join(dataDir, "updates", "probation.json"), "");
    await assert.rejects(rpc("configureThread", {}), updating);
    fs.unlinkSync(path.join(dataDir, "updates", "probation.json"));
    writeUpdate(dataDir, "apply.lock", { pid: process.pid, phase: "applying" });
    await assert.rejects(rpc("systemUpdate", { action: "cancelCutover" }), { code: "UPDATE_ALREADY_COMMITTING" });
    fs.unlinkSync(path.join(dataDir, "updates", "apply.lock"));
    await assert.rejects(rpc("__prepareCutover", { _standalone: true }));
    daemon.orchestrator.db.upsertThread({ id: "pending", workspace: cwd, cwd });
    daemon.orchestrator.db.upsertRun({ id: "pending-run", threadId: "pending", status: "queued" });
    await assert.rejects(rpc("__shutdown", { requireCutover: true }), { code: "DAEMON_BUSY" });
    await rpc("manageQueue", { threadId: "pending", action: "clear" });
    assert.equal((await rpc("__prepareCutover")).quiescing, true);
    await assert.rejects(rpc("launchThread", { cwd }), updating);
    assert.equal((await rpc("systemUpdate", { action: "cancelCutover" })).quiescing, false);
  } finally { await daemon.shutdown(); }
}));

test("首选端口已占用时自动申请新的回环端口", () => fixture("v033-preferred-port", async options => {
  const first = await startCoreDaemon(options);
  try {
    const second = await startCoreDaemon({ ...options, dataDir: path.join(options.dir, "second"), preferPort: first.port });
    try {
      assert.notEqual(second.port, first.port);
      assert.equal(second.host, "127.0.0.1");
    } finally { await second.shutdown(); }
  } finally { await first.shutdown(); }
}));

const acpFixture = String.raw`
import fs from "node:fs";
import { createInterface } from "node:readline";
const [trace, scenario] = process.argv.slice(2);
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  fs.appendFileSync(trace, method + "\n");
  if (id == null) continue;
  let result = {}, error;
  if (method === "initialize") result = { agentCapabilities: { sessionCapabilities: { delete: scenario !== "close-only" } } };
  if (method === "session/new") result = { sessionId: "private-session" };
  if (method === "session/prompt" && scenario === "error") error = { code: -32603, message: "fixture failure" };
  if (method === "session/delete" && scenario === "error") error = { code: -32601, message: "fixture delete failure" };
  console.log(JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }));
}
`;

test("Kimi 和通用 ACP 在成功、早退取消和异常时清理无痕会话", () => withProjectSandbox("v033-acp-cleanup", async cwd => {
  const script = path.join(cwd, "acp-fixture.mjs");
  fs.writeFileSync(script, acpFixture);
  for (const driver of [runKimiTurn, runGenericAcpTurn]) {
    for (const [scenario, status, expectedCleanup] of [
      ["success", "completed", ["session/delete"]],
      ["cancel", "interrupted", ["session/delete"]],
      ["error", "failed", ["session/delete", "session/close"]],
      ["close-only", "completed", ["session/close"]],
    ]) {
      const trace = `${driver.name}-${scenario}.ndjson`;
      let handle;
      handle = driver({ cwd, prompt: "fixture", nativeSessionId: "previous", ephemeral: true, provider: "custom-acp",
        resolveBinary: () => ({ command: process.execPath, prefixArgs: [script, trace, scenario] }),
        providerConfig: { command: script, args: [trace, scenario] },
        onEvent(event) {
          if (scenario === "cancel" && event.type === "session_bound") void handle.cancel();
        },
      });
      const result = await within(handle.result, 8000, trace);
      assert.equal(result.status, status, JSON.stringify(result));
      assert.equal(result.nativeSessionId, undefined);
      const calls = fs.readFileSync(path.join(cwd, trace), "utf8").trim().split(/\r?\n/);
      assert.ok(!calls.includes("session/resume") && !calls.includes("session/load"));
      assert.equal(calls.includes("session/prompt"), scenario !== "cancel");
      assert.deepEqual(calls.slice(-expectedCleanup.length), expectedCleanup);
    }
  }
}));

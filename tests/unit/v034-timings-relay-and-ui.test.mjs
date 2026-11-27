import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { assembleSpecPrompt, readProjectSpecs } from "../../core/spec-context.mjs";
import { createIsolatedWorktree } from "../../core/worktree.mjs";
import { BUILTIN_EXTENSION_TEMPLATES_UI, state as studioState } from "../../sidecars/studio/ui/state.js";
import { renderRunTimingsBarHtml } from "../../sidecars/studio/ui/widgets.js";
import { renderMemberDrawer } from "../../sidecars/studio/ui/members-view.js";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { repoRoot, runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

function commit(cwd, message) {
  git(cwd, "-c", "user.name=AgentTower Test", "-c", "user.email=test@invalid.local", "commit", "-m", message);
}

function openTower(dir, cwd, mode = "complex") {
  const tower = createOrchestrator({
    dataDir: path.join(dir, "control"),
    defaultStudioRoot: cwd,
    catalogLoader: offlineCatalog,
    recoverStaleState: false,
  });
  tower.db.saveSettings({ defaultOrchestrationMode: mode });
  return tower;
}

function makeFakeElement(id = "") {
  const attrs = new Map();
  return {
    id,
    hidden: false,
    className: "",
    textContent: "",
    innerHTML: "",
    scrollTop: 0,
    children: [],
    setAttribute(key, value) { attrs.set(key, String(value)); },
    getAttribute(key) { return attrs.get(key) ?? null; },
    insertBefore(child, ref) {
      const existingIdx = this.children.indexOf(child);
      if (existingIdx !== -1) this.children.splice(existingIdx, 1);
      if (!ref) this.children.push(child);
      else {
        const refIdx = this.children.indexOf(ref);
        if (refIdx === -1) this.children.push(child);
        else this.children.splice(refIdx, 0, child);
      }
      child._parent = this;
      return child;
    },
    remove() {
      if (!this._parent) return;
      const idx = this._parent.children.indexOf(this);
      if (idx !== -1) this._parent.children.splice(idx, 1);
      this._parent = null;
    },
  };
}

test("v0.3.4 跨轨道钩子：prepareCutover/waitForThreadClosed/waitForPathClosed/inheritHostMcp", () => withProjectSandbox("v034-hooks", async dir => {
  const cwd = project(dir, "hooks-repo");
  write(cwd, "src/app.mjs", "export const v = 1;\n");
  git(cwd, "add", "src/app.mjs");
  commit(cwd, "init");

  const tower = openTower(dir, cwd);
  try {
    const order = [];
    let drained = 0;
    let releaseCloseGate;
    let markWaitEntered;
    const waitEntered = new Promise(resolve => { markWaitEntered = resolve; });
    const closeGate = new Promise(resolve => { releaseCloseGate = resolve; });

    tower.engineManager.waitForThreadClosed = async threadId => {
      order.push(`waitThread:${threadId}`);
      markWaitEntered();
      await closeGate;
    };
    tower.engineManager.waitForPathClosed = async targetPath => {
      order.push(`waitPath:${path.basename(targetPath)}`);
    };
    tower.engineManager.runTurn = options => {
      order.push(`runTurn:${options.threadId}`);
      options.onEvent({ type: "session_bound", nativeSessionId: "sess-1", resumed: false, warmHit: true, initHandshakeMs: 42 });
      options.onEvent({ type: "message_delta", delta: "ok" });
      options.onEvent({ type: "engine_teardown", teardownMs: 18 });
      return { result: Promise.resolve({ status: "completed", assistantText: "ok", nativeSessionId: "sess-1" }) };
    };

    const delegatePromise = tower.delegateTask({
      cwd,
      conversationId: "hooks-conv",
      task: "worktree task",
      isolation: "worktree",
      mode: "wait",
    });

    await waitEntered;
    assert.ok(order.some(item => item.startsWith("waitThread:")), "应先等待同线程旧热池进程关闭");
    assert.ok(!order.some(item => item.startsWith("runTurn:")), "旧连接释放前不得提前启动新回合");
    releaseCloseGate();

    const delegated = await delegatePromise;
    assert.equal(delegated.status, "completed");
    assert.ok(delegated.worktreePath);

    const wtRun = tower.db.getRun(delegated.runId);
    const t = wtRun.meta.timings;
    assert.equal(typeof t.worktreeMs, "number");
    assert.ok(t.worktreeMs >= 0);
    assert.equal(t.snapshotMs, null);
    assert.equal(t.warmHit, 1);
    assert.equal(t.initHandshakeMs, 42);
    assert.equal(t.teardownMs, 18);
    assert.equal(typeof t.sessionBoundMs, "number");
    assert.equal(typeof t.firstEventMs, "number");
    assert.equal(typeof t.firstTextMs, "number");
    assert.equal(t.budgetMode, "standard");

    await tower.cleanupWorktree({ worktreePath: delegated.worktreePath, force: true });
    assert.ok(order.some(item => item.startsWith("waitPath:")), "清理 Worktree 前必须等待占用该路径的热池进程释放");

    const reviewCalls = [];
    tower.engineManager.runReview = options => {
      reviewCalls.push(options);
      return { result: Promise.resolve({ status: "completed", reviewText: "LGTM", findings: [] }) };
    };
    await tower.runCodeReview({
      cwd,
      conversationId: "hooks-conv",
      readOnly: true,
      reviewMode: "ephemeral",
      inheritHostMcp: true,
      wait: true,
    });
    await tower.runCodeReview({
      cwd,
      conversationId: "hooks-conv",
      readOnly: true,
      reviewMode: "ephemeral",
      wait: true,
    });
    assert.equal(reviewCalls[0].inheritHostMcp, true, "nativeReview 应透传 inheritHostMcp=true");
    assert.equal(reviewCalls[1].inheritHostMcp, false, "未显式指定 inheritHostMcp 时应默认 false");

    let finishDrain;
    tower.engineManager.drainWarmPool = () => new Promise(resolve => { drained++; finishDrain = resolve; });
    const prepare = () => tower.systemUpdate({ action: "prepareCutover" });
    const first = prepare();
    let secondReady = false;
    const second = prepare().then(reply => { secondReady = true; return reply; });
    await new Promise(resolve => setImmediate(resolve));
    const premature = secondReady;
    finishDrain();
    const [cutover] = await Promise.all([first, second]);
    assert.equal(premature, false, "所有切流调用都必须等到同一轮排空完成");
    assert.equal(cutover.quiescing, true);
    assert.equal(drained, 1, "prepareCutover 静默切流时必须排空热池");
  } finally {
    await tower.shutdown();
  }
}));

test("v0.3.4 实时 timings 落库与失败回合 null 语义", () => withProjectSandbox("v034-live-timings", async dir => {
  const cwd = project(dir, "live-repo");
  write(cwd, "README.md", "# test\n");
  git(cwd, "add", "README.md");
  commit(cwd, "init");

  const tower = openTower(dir, cwd);
  try {
    let finishTurn;
    let emitEvent;
    const turnDone = new Promise(resolve => { finishTurn = resolve; });
    tower.engineManager.runTurn = options => {
      emitEvent = options.onEvent;
      options.onEvent({ type: "session_bound", nativeSessionId: "live-1", resumed: false, warmHit: true, initHandshakeMs: 35 });
      return { result: turnDone };
    };

    const started = await tower.delegateTask({ cwd, conversationId: "live-conv", task: "long task", mode: "async" });
    const midTimings = tower.db.getRun(started.runId).meta.timings;
    assert.equal(midTimings.warmHit, 1);
    assert.equal(midTimings.initHandshakeMs, 35);
    assert.equal(typeof midTimings.sessionBoundMs, "number");
    assert.equal(midTimings.firstTextMs, null, "首字尚未到达前实时 timings.firstTextMs 应保持 null");
    const detail = await tower.readThread({ threadId: started.threadId || started.childThreadId });
    assert.deepEqual(detail.thread.currentRun.timings, midTimings);
    assert.deepEqual(detail.recentRuns.at(-1).timings, midTimings);

    finishTurn({ status: "completed", assistantText: "finished without stream delta", nativeSessionId: "live-1" });
    const settled = await tower.getTaskStatus({ taskId: started.taskId, wait: true, timeoutMs: 5000 });
    assert.equal(settled.status, "completed");
    const doneTimings = tower.db.getRun(started.runId).meta.timings;
    assert.equal(doneTimings.firstTextMs, null, "无流式正文事件时 firstTextMs 保持 null 而非 0");
    emitEvent({ type: "engine_teardown", teardownMs: 321 });
    assert.deepEqual(tower.db.getRun(started.runId).meta.timings, { ...doneTimings, teardownMs: 321 });
  } finally {
    await tower.shutdown();
  }
}));

test("v0.3.4 Worktree 异步化（.worktreeinclude + 懒 prune 恢复）与纯 FS checkoutRoots", () => withProjectSandbox("v034-git-fast", async dir => {
  const repo = project(dir, "wt-repo");
  write(repo, "src/index.mjs", "export const ok = true;\n");
  write(repo, ".worktreeinclude", "config/local.json\n");
  write(repo, "config/local.json", "{\"env\":\"sandbox\"}\n");
  git(repo, "add", "src/index.mjs", ".worktreeinclude");
  commit(repo, "init");

  // Pre-resolved primary Git root + async .worktreeinclude copy
  const wt1 = await createIsolatedWorktree({ workspace: repo, threadId: "thr_alpha01", taskSlug: "fast-wt" });
  assert.equal(fs.existsSync(path.join(wt1.worktreePath, "config/local.json")), true);
  assert.equal(fs.readFileSync(path.join(wt1.worktreePath, "config/local.json"), "utf8"), "{\"env\":\"sandbox\"}\n");

  // Force the same checkout path, so git actually reports a stale registration.
  const realNow = Date.now;
  const fixedNow = realNow();
  const options = { workspace: repo, threadId: "thr_stale01", taskSlug: "stale-wt" };
  try {
    Date.now = () => fixedNow;
    const stale = await createIsolatedWorktree({ ...options, branch: "tower/stale" });
    fs.rmSync(stale.worktreePath, { recursive: true, force: true });
    const recovered = await createIsolatedWorktree({ ...options, branch: "tower/recovered" });
    assert.equal(recovered.worktreePath, stale.worktreePath);
    assert.equal(git(recovered.worktreePath, "branch", "--show-current").trim(), "tower/recovered");
  } finally { Date.now = realNow; }

  // Verify pure-FS checkoutRoots handles main repo, subdir, linked worktree, non-git dir, and freshly git-inited dir.
  const nested = path.join(repo, "src");
  const plainDir = path.join(dir, "plain-folder");
  fs.mkdirSync(plainDir, { recursive: true });
  const tower = openTower(dir, repo);
  try {
    const mainSpecs = tower.listProjectSpecs({ cwd: repo });
    assert.equal(path.resolve(mainSpecs.workspace), path.resolve(repo));

    const subSpecs = tower.listProjectSpecs({ cwd: nested });
    assert.equal(path.resolve(subSpecs.workspace), path.resolve(repo));
    git(nested, "init");
    assert.equal(path.resolve(tower.listProjectSpecs({ cwd: nested }).workspace), path.resolve(nested));

    const wtSpecs = tower.listProjectSpecs({ cwd: wt1.worktreePath });
    assert.equal(path.resolve(wtSpecs.workspace), path.resolve(repo), "linked worktree 的 repoRoot 应通过纯 FS commondir 解析为主仓");

    const plainBefore = tower.listProjectSpecs({ cwd: plainDir });
    assert.equal(path.resolve(plainBefore.workspace), path.resolve(plainDir));

    // Initialize Git inside plainDir immediately after cache warm and make sure cache invalidates cleanly.
    git(plainDir, "init");
    const plainSub = path.join(plainDir, "pkg");
    fs.mkdirSync(plainSub, { recursive: true });
    const plainAfter = tower.listProjectSpecs({ cwd: plainSub });
    assert.equal(path.resolve(plainAfter.workspace), path.resolve(plainDir));
  } finally {
    await tower.shutdown();
  }
}));

test("v0.3.4 relay 模式 4KB 轻量规范预算：保留 00-plugin 与强命中、降级模糊命中、跳过演化记录", () => withProjectSandbox("v034-relay-budget", async dir => {
  const repo = project(dir, "relay-spec");
  write(repo, "src/core/engine.mjs", "export const engine = true;\n");
  write(repo, "src/fuzzy/helper.mjs", "export const helper = true;\n");
  write(repo, ".agent-tower/docs/evolution/INDEX.md", [
    "# Evolution Index",
    "| Version | Keywords | Notes |",
    "| --- | --- | --- |",
    "| v0.3.4 | engine, src/core/engine.mjs | keep latency low |",
  ].join("\n"));

  const bigBody = (label, len) => `## ${label}\n\n${"规则内容".repeat(Math.ceil(len / 12))}\n`;
  write(repo, ".agent-tower/spec/02-coding/req-core.md", [
    "---",
    "id: req-core",
    "title: 核心必读规范",
    "kind: coding",
    "required: true",
    "roles: [executor]",
    "scopes: [src/core/**]",
    "tags: [engine]",
    "summary: 核心模块必须遵守的架构红线。",
    "---",
    bigBody("Req Core", 2800),
  ].join("\n"));
  write(repo, ".agent-tower/spec/02-coding/opt-core-heavy.md", [
    "---",
    "id: opt-core-heavy",
    "title: 核心选读规范",
    "kind: coding",
    "required: false",
    "roles: [executor]",
    "scopes: [src/core/**]",
    "tags: [engine]",
    "summary: 超出 4KB 预算时应退为摘要。",
    "---",
    bigBody("Heavy Core", 1600),
  ].join("\n"));
  write(repo, ".agent-tower/spec/02-coding/fuzzy-tag.md", [
    "---",
    "id: fuzzy-tag",
    "title: 关键词模糊规范",
    "kind: coding",
    "required: false",
    "roles: [executor]",
    "scopes: [src/other/**]",
    "tags: [telemetry-keyword]",
    "summary: 仅靠关键词命中的可选参考规范。",
    "---",
    bigBody("Fuzzy Tag", 600),
  ].join("\n"));
  write(repo, ".agent-tower/spec/02-coding/fuzzy-path.md", [
    "---",
    "id: fuzzy-path",
    "title: 正文路径模糊规范",
    "kind: coding",
    "required: false",
    "roles: [executor]",
    "scopes: [src/fuzzy/**]",
    "tags: [unrelated]",
    "summary: 仅靠正文提及路径命中的可选规范。",
    "---",
    bigBody("Fuzzy Path", 600),
  ].join("\n"));

  const inventory = readProjectSpecs(repo, repo);
  const rawPrompt = "请优化 src/core/engine.mjs，同时参考 telemetry-keyword 与 src/fuzzy/helper.mjs";
  const selection = { targetPaths: ["src/core/engine.mjs"] };

  const relayRes = assembleSpecPrompt({
    inventory,
    cwd: repo,
    repoRoot: repo,
    role: "executor",
    rawPrompt,
    dynamicPrompt: rawPrompt,
    selection,
    transport: "stdin",
    orchestrationMode: "relay",
  });
  assert.equal(relayRes.full.meta.budgetMode, "relay_slim");
  assert.equal(relayRes.full.meta.pluginDelivered, true, "relay 模式必须保留 00-plugin 角色卡");
  assert.doesNotMatch(relayRes.full.prompt, /\[EVOLUTION MATCHES\]/, "relay 模式跳过 evolutionRows 扫描");

  const relayItems = new Map(relayRes.full.meta.items.map(it => [it.id, it]));
  assert.equal(relayItems.get("req-core")?.tier, "inline", "4KB 预算内必读强命中应全文内联");
  assert.equal(relayItems.get("opt-core-heavy")?.tier, "summary", "超出 4KB 项目规范预算的选读项应退为 summary");
  assert.equal(relayItems.get("fuzzy-tag")?.tier, "summary", "relay 模式非必读 tag 命中强制降级为单行摘要指针");
  assert.equal(relayItems.get("fuzzy-path")?.tier, "summary", "relay 模式非必读 text_path 命中强制降级为单行摘要指针");
  assert.match(relayRes.full.prompt, /^\.agent-tower\/spec\/02-coding\/fuzzy-tag\.md$/m);
  assert.match(relayRes.full.prompt, /^\.agent-tower\/spec\/02-coding\/fuzzy-path\.md$/m);
  assert.doesNotMatch(relayRes.full.prompt, /仅靠关键词命中的可选参考规范/);

  // Compare with complex (standard) mode and argv mode
  const complexRes = assembleSpecPrompt({
    inventory,
    cwd: repo,
    repoRoot: repo,
    role: "executor",
    rawPrompt,
    dynamicPrompt: rawPrompt,
    selection,
    transport: "stdin",
    orchestrationMode: "complex",
  });
  assert.equal(complexRes.full.meta.budgetMode, "standard");
  assert.match(complexRes.full.prompt, /\[EVOLUTION MATCHES\]/, "complex 模式保留 evolutionRows 扫描");
  assert.ok(complexRes.full.meta.specBytes > relayRes.full.meta.specBytes, "relay 轻量预算应显著小于 complex 标准预算");

  const argvRes = assembleSpecPrompt({
    inventory,
    cwd: repo,
    repoRoot: repo,
    role: "executor",
    rawPrompt,
    dynamicPrompt: rawPrompt,
    selection,
    transport: "argv",
    orchestrationMode: "relay",
  });
  assert.equal(argvRes.full.meta.budgetMode, "argv");

  // Verify summary 1.5 KiB cap under relay_slim
  for (let i = 0; i < 45; i++) {
    write(repo, `.agent-tower/spec/02-coding/many-tag-${i}.md`, [
      "---",
      `id: many-tag-${i}`,
      `title: 批量模糊规范 ${i}`,
      "kind: coding",
      "required: false",
      "roles: [executor]",
      "scopes: [src/unused/**]",
      "tags: [bulk-relay-cap]",
      `summary: 这是一段用于触发 1.5 KiB 摘要上限的规范摘要内容编号 ${i}，确保超出部分退化为路径指针。`,
      "---",
      `Body ${i}\n`,
    ].join("\n"));
  }
  const bulkInventory = readProjectSpecs(repo, repo);
  const bulkRelay = assembleSpecPrompt({
    inventory: bulkInventory,
    cwd: repo,
    repoRoot: repo,
    role: "executor",
    rawPrompt: "触发 bulk-relay-cap",
    dynamicPrompt: "触发 bulk-relay-cap",
    transport: "stdin",
    orchestrationMode: "relay",
  });
  assert.ok(
    bulkRelay.full.meta.warnings.some(w => w.code === "SUMMARY_BUDGET_CAPPED" && /1\.5 KiB/.test(w.message)),
    "relay 摘要超出 1.5 KiB 时应发出 1.5 KiB 上限告警",
  );

  // End-to-end orchestrator dispatch in relay mode records budgetMode = relay_slim
  const tower = openTower(dir, repo, "relay");
  try {
    tower.engineManager.runTurn = options => {
      options.onEvent({ type: "session_bound", nativeSessionId: "relay-sess", resumed: false });
      options.onEvent({ type: "message_delta", delta: "done" });
      return { result: Promise.resolve({ status: "completed", assistantText: "done", nativeSessionId: "relay-sess" }) };
    };
    const res = await tower.delegateTask({ cwd: repo, conversationId: "relay-e2e", task: "请优化 src/core/engine.mjs", mode: "wait" });
    const run = tower.db.getRun(res.runId);
    assert.equal(run.meta.injectedSpecs.budgetMode, "relay_slim");
    assert.equal(run.meta.timings.budgetMode, "relay_slim");
  } finally {
    await tower.shutdown();
  }
}));

test("v0.3.4 Studio UI：Qwen Code 模板、Gemini --acp、抽屉耗时胶囊、CSS 变量合规与零泳道条", () => {
  const qwen = BUILTIN_EXTENSION_TEMPLATES_UI.find(tpl => tpl.id === "qwen-code");
  assert.ok(qwen, "BUILTIN_EXTENSION_TEMPLATES_UI 应包含 qwen-code");
  assert.equal(qwen.protocol, "acp");
  assert.equal(qwen.command, "qwen");
  assert.deepEqual(qwen.args, ["--acp"]);

  const gemini = BUILTIN_EXTENSION_TEMPLATES_UI.find(tpl => tpl.id === "gemini-cli");
  assert.ok(gemini);
  assert.deepEqual(gemini.args, ["--acp"], "gemini-cli 默认参数应切至标准 --acp");

  // Full settled timings + warmHit
  const fullHtml = renderRunTimingsBarHtml({
    id: "run_full",
    meta: {
      timings: {
        warmHit: 1,
        worktreeMs: 380,
        snapshotMs: 90,
        sessionBoundMs: 1400,
        firstTextMs: 2600,
      },
    },
  });
  assert.match(fullHtml, /class="md-timings-bar"/);
  assert.match(fullHtml, /⚡ 预热命中/);
  assert.match(fullHtml, /🌿 Worktree 380ms/);
  assert.match(fullHtml, /📸 快照 90ms/);
  assert.match(fullHtml, /🚀 就绪 1\.4s/);
  assert.match(fullHtml, /✍️ 首字 2\.6s/);

  // Null unreached fields omitted; live handshake badge rendered
  const handshakeHtml = renderRunTimingsBarHtml({
    id: "run_live_hs",
    meta: { timings: { warmHit: 0, worktreeMs: null, snapshotMs: null, sessionBoundMs: null, firstTextMs: null } },
  }, { live: true });
  assert.match(handshakeHtml, /🔌 握手中…/);
  assert.doesNotMatch(handshakeHtml, /Worktree|快照|就绪|首字|预热命中/);

  // Live thinking / tool stage after session_bound
  const thinkHtml = renderRunTimingsBarHtml({
    id: "run_live_think",
    meta: { timings: { warmHit: 1, sessionBoundMs: 120, firstTextMs: null } },
  }, { live: true, hasText: false, hasTools: false });
  assert.match(thinkHtml, /⚡ 预热命中/);
  assert.match(thinkHtml, /🚀 就绪 120ms/);
  assert.match(thinkHtml, /💭 思考中…/);

  // Legacy run without timings returns empty string gracefully
  assert.equal(renderRunTimingsBarHtml({ id: "run_legacy", meta: {} }), "");
  assert.equal(renderRunTimingsBarHtml(null), "");
  assert.equal(renderRunTimingsBarHtml({ timings: { warmHit: {}, firstTextMs: "<img>", sessionBoundMs: "<script>" } }), "");

  // Render inside member drawer with lightweight DOM stub
  const els = new Map([
    ["member-drawer-backdrop", makeFakeElement("member-drawer-backdrop")],
    ["md-title", makeFakeElement("md-title")],
    ["md-subtitle", makeFakeElement("md-subtitle")],
    ["btn-md-jump-host", makeFakeElement("btn-md-jump-host")],
    ["btn-md-delete", makeFakeElement("btn-md-delete")],
    ["md-actions-bar", makeFakeElement("md-actions-bar")],
    ["md-timeline-body", makeFakeElement("md-timeline-body")],
  ]);
  const prevDoc = globalThis.document;
  const prevThreads = studioState.threadsMap;
  const prevDrawerId = studioState.detailDrawerThreadId;
  const prevLastId = studioState.drawerLastThreadId;
  try {
    globalThis.document = {
      getElementById(id) { return els.get(id) || null; },
      createElement() { return makeFakeElement(); },
    };
    const thread = {
      id: "thr_drawer_timings",
      title: "Timings Drawer Test",
      provider: "codex",
      model: "gpt-6.2-sol",
      effort: "high",
      status: "completed",
      queue: [],
      meta: { memberName: "executor_codex" },
      recentRuns: [{
        id: "run_drawer_1",
        status: "completed",
        createdAt: 1000,
        startedAt: 1000,
        completedAt: 3200,
        prompt: "implement timing pills",
        meta: { timings: { warmHit: 1, worktreeMs: 250, sessionBoundMs: 310, firstTextMs: 1200 } },
      }],
      items: [{
        id: "item_user_run_drawer_1",
        runId: "run_drawer_1",
        type: "user_message",
        text: "implement timing pills",
        createdAt: 1000,
      }],
    };
    studioState.threadsMap = new Map([[thread.id, thread]]);
    studioState.detailDrawerThreadId = thread.id;
    studioState.drawerLastThreadId = "";
    renderMemberDrawer();
    const drawerHtml = els.get("md-timeline-body").children.map(node => node.innerHTML).join("\n");
    assert.match(drawerHtml, /md-timings-bar/);
    assert.match(drawerHtml, /⚡ 预热命中/);
    assert.match(drawerHtml, /🌿 Worktree 250ms/);

    thread.recentRuns.push({ id: "follow", inputIntent: "follow_up", status: "running",
      createdAt: 4000, meta: { timings: { sessionBoundMs: null, firstTextMs: null } } });
    thread.activeRunId = "follow";
    thread.status = "running";
    renderMemberDrawer();
    const followHtml = els.get("md-timeline-body").children.map(node => node.innerHTML).join("\n");
    assert.match(followHtml, /🔌 握手中/);
    assert.doesNotMatch(followHtml, /🌿 Worktree 250ms/);

    // Legacy thread without timings renders cleanly with zero timing bar
    const legacyThread = {
      ...thread,
      id: "thr_drawer_legacy",
      recentRuns: [{ id: "run_legacy_1", status: "completed", createdAt: 1000, prompt: "legacy", meta: {} }],
      items: [{ id: "item_user_run_legacy_1", runId: "run_legacy_1", type: "user_message", text: "legacy", createdAt: 1000 }],
    };
    studioState.threadsMap = new Map([[legacyThread.id, legacyThread]]);
    studioState.detailDrawerThreadId = legacyThread.id;
    renderMemberDrawer();
    const legacyHtml = els.get("md-timeline-body").children.map(node => node.innerHTML).join("\n");
    assert.doesNotMatch(legacyHtml, /md-timings-bar/);
  } finally {
    globalThis.document = prevDoc;
    studioState.threadsMap = prevThreads;
    studioState.detailDrawerThreadId = prevDrawerId;
    studioState.drawerLastThreadId = prevLastId;
  }

  // Static guardrails: 23 ui/*.js modules, zero board swimlane bar, CSS token compliance
  const uiDir = path.join(repoRoot, "sidecars", "studio", "ui");
  const uiFiles = fs.readdirSync(uiDir).filter(f => f.endsWith(".js"));
  assert.equal(uiFiles.length, 23, "sidecars/studio/ui/*.js 模块数必须保持 23");

  const boardHtml = fs.readFileSync(path.join(repoRoot, "sidecars", "studio", "index.html"), "utf8");
  const boardJs = fs.readFileSync(path.join(uiDir, "board-view.js"), "utf8");
  assert.doesNotMatch(boardHtml, /swimlane|stage-bar/i, "看板顶栏不得新增独立阶段泳道条");
  assert.doesNotMatch(boardJs, /swimlane|stage-bar/i, "board-view.js 不得新增独立阶段泳道条");

  const css = fs.readFileSync(path.join(repoRoot, "sidecars", "studio", "styles.css"), "utf8");
  const timingBlock = css.slice(css.indexOf(".md-timings-bar"), css.indexOf(".md-prompt-toggle"));
  assert.ok(timingBlock.includes("flex-wrap: wrap;"), "抽屉耗时胶囊条必须支持换行防窄栏溢出");
  const vars = [...timingBlock.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(m => m[1]);
  assert.ok(vars.length > 0);
  for (const token of vars) {
    assert.match(token, /^--sw-/, `非法 CSS 变量 ${token}`);
  }
});

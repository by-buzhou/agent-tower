import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../helpers/sandbox.mjs";

const ROOT = "12345678-1234-4123-8123-123456789abc";
const studioDir = path.join(repoRoot, "sidecars", "studio");
const uiDir = path.join(studioDir, "ui");
const read = (...parts) => fs.readFileSync(path.join(studioDir, ...parts), "utf8");
const toasts = [];
const rpcLog = [];
let rpcHandler = () => ({ result: {} });

function memberBlockHtml(html, className, nextClass = "") {
  const start = html.indexOf(`<div class="${className}"`);
  if (start < 0) return "";
  const from = html.indexOf(">", start) + 1;
  const to = nextClass ? html.indexOf(`<div class="${nextClass}"`, from) : html.indexOf("\n    </div>", from);
  const chunk = html.slice(from, to);
  return chunk.slice(0, chunk.lastIndexOf("</div>"));
}
function dataKey(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function makeEl(id = "") {
  const classes = new Set();
  const el = {
    id, _innerHTML: "", textContent: "", hidden: false, disabled: false, title: "", attrs: {}, dataset: {}, children: [],
    value: "", placeholder: "", checked: false, className: "", style: {}, parentNode: null, scrollTop: 0,
    get innerHTML() { return this._innerHTML; },
    set innerHTML(html) {
      this._innerHTML = String(html);
      this.children = [];
      if (this.className.split(/\s+/).includes("member-row")) {
        for (const [className, nextClass] of [["member-avatar-tile", "member-col"], ["member-head-line", "member-meta-line"],
          ["member-meta-line", "member-preview-line"], ["member-preview-line", "member-row-actions"], ["member-row-actions", ""]]) {
          const block = makeEl();
          block.className = className;
          block.parentNode = this;
          block.innerHTML = memberBlockHtml(this._innerHTML, className, nextClass);
          if (className === "member-avatar-tile") block.attrs.style = /style="([^"]*)"/.exec(this._innerHTML)?.[1] || "";
          this.children.push(block);
        }
      } else if (this.className.split(/\s+/).includes("member-row-actions")) {
        for (const match of this._innerHTML.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
          const btn = makeEl();
          btn.parentNode = this;
          btn.className = /class="([^"]*)"/.exec(match[1])?.[1] || "";
          btn.textContent = match[2].replace(/<[^>]*>/g, "");
          for (const attr of match[1].matchAll(/data-([\w-]+)="([^"]*)"/g)) btn.dataset[dataKey(attr[1])] = attr[2];
          this.children.push(btn);
        }
      }
    },
    classList: {
      add: (c) => classes.add(c), remove: (c) => classes.delete(c),
      contains: (c) => classes.has(c) || el.className.split(/\s+/).includes(c),
      toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on),
    },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k] ?? null; },
    matches(selector) {
      if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
      const data = /^\[data-([\w-]+)\]$/.exec(selector);
      return data ? this.dataset[dataKey(data[1])] !== undefined : false;
    },
    querySelector(selector) {
      for (const child of this.children) {
        if (child.matches(selector)) return child;
        const nested = child.querySelector(selector);
        if (nested) return nested;
      }
      return null;
    },
    querySelectorAll(selector) {
      const out = [];
      for (const child of this.children) {
        if (child.matches(selector)) out.push(child);
        out.push(...child.querySelectorAll(selector));
      }
      return out;
    },
    insertBefore(child, ref = null) {
      child.remove();
      const index = ref ? this.children.indexOf(ref) : -1;
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      child.parentNode = this;
      return child;
    },
    appendChild(child) {
      if (this.id === "toast-container") toasts.push({ message: child.textContent, kind: child.className.split(/\s+/).at(-1) });
      return this.insertBefore(child);
    },
    remove() {
      if (!this.parentNode) return;
      const index = this.parentNode.children.indexOf(this);
      if (index >= 0) this.parentNode.children.splice(index, 1);
      this.parentNode = null;
    },
    contains: () => false,
    focus() {},
    select() {},
  };
  return el;
}

const els = new Map();
const byId = (id) => {
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id);
};
const store = new Map();
globalThis.location = { pathname: "/v032", search: "" };
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.localStorage = { getItem: (k) => store.get(`ls:${k}`) ?? null, setItem: (k, v) => store.set(`ls:${k}`, String(v)) };
globalThis.requestAnimationFrame = () => 0;
globalThis.CSS ??= { escape: (s) => String(s) };
globalThis.document = {
  activeElement: null,
  documentElement: { dataset: {} },
  getElementById: byId,
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => makeEl(),
};
globalThis.window = {
  location: globalThis.location,
  sidecar: {
    conversationId: ROOT,
    fetch: async (_url, init) => {
      const { method, params } = JSON.parse(init.body);
      rpcLog.push({ method, params });
      const data = await rpcHandler(method, params);
      return { ok: data?.ok !== false, status: data?.ok === false ? 409 : 200, json: async () => data };
    },
  },
};

const mod = (file) => import(pathToFileURL(path.join(uiDir, file)).href);
const S = await mod("state.js");
const N = await mod("normalize.js");
const stream = await mod("stream.js");
const composer = await mod("composer.js");
const members = await mod("members-view.js");
const board = await mod("board-view.js");
const worktrees = await mod("worktree-view.js");
const nav = await mod("nav.js");
const { state } = S;

function seedThread(patch = {}) {
  const thread = N.normalizeThread({
    id: "t1", rootConversationId: ROOT, workspace: "F:/repo", cwd: "F:/repo", projectRoot: "F:/repo",
    title: "执行甲", memberName: "执行甲", provider: "codex", model: "gpt-6.2-sol", effort: "high",
    permissionMode: "on-request", interactionMode: "default", status: "running", activeRunId: "run-1",
    startedAt: 111, createdAt: 100, updatedAt: 200,
    items: [{ id: "initial", type: "assistant_message", text: "首段输出", createdAt: 110 }],
    queue: [{ id: "q0", text: "既有排队", createdAt: 120 }],
    ...patch,
  });
  state.threadsMap.set(thread.id, thread);
  return thread;
}
function resetFixture() {
  state.activeConversationId = ROOT;
  state.rootConversationId = ROOT;
  state.workspace = "F:/repo";
  state.conversationUnbound = false;
  state.bootstrapLoaded = true;
  state.bootstrapPromise = null;
  state.threadsMap.clear();
  state.pendingRequests.clear();
  state.archivedThreadIds.clear();
  state.pendingConfirms.clear();
  state.cancelInFlight.clear();
  state.hydratingThreadIds.clear();
  state.expandedTraces.clear();
  state.expandedPrompts.clear();
  state.detailDrawerThreadId = "";
  state.drawerLastThreadId = "";
  state.worktrees = [];
  state.boardMessages = [];
  state.selectedThreadId = "t1";
  state.manualTarget = true;
  state.activeView = "board";
  state.membersStatusFilter = "all";
  state.membersInactiveLimit = 15;
  state.currentWorktreeDiff = null;
  state.selectedWorktreeId = "";
  state.diffMode = "working_tree";
  state.loadingDiff = false;
  state.renderScheduled = false;
  Object.assign(state.composer, {
    presetKey: "", provider: "codex", model: "gpt-6.2-sol", effort: "high",
    permissionMode: "on-request", interactionMode: "default", isolation: "shared",
  });
  stream.applyConversationPolicyPayload({ rootConversationId: ROOT, orchestrationMode: "relay", source: "explicit", policyRevision: 1 });
  rpcLog.length = 0;
  toasts.length = 0;
  rpcHandler = () => ({ result: {} });
  byId("comp-prompt-input").value = "继续修正边界条件";
  byId("chk-fresh-context").checked = false;
  byId("comp-ephemeral-chk").checked = false;
}
const lastSend = () => rpcLog.filter((r) => r.method === "sendToThread").at(-1)?.params;

test("v0.3.3 五 Tab（含全局配置）、23 模块与 graph 视图安全回落 board", () => {
  const html = read("index.html");
  assert.deepEqual([...html.matchAll(/<button[^>]*role="tab"[^>]*data-view="([^"]+)"/g)].map((m) => m[1]), ["board", "members", "diff", "settings", "global"]);
  assert.equal(fs.existsSync(path.join(uiDir, "graph-view.js")), false);
  assert.equal(fs.readdirSync(uiDir).filter((f) => f.endsWith(".js")).length, 23);
  for (const source of [html, read("app.js"), read("ui", "events.js"), read("styles.css")]) {
    assert.doesNotMatch(source, /view-graph|graph-view|renderGraphView|collab-graph-svg|graph-canvas-wrap/);
  }
  resetFixture();
  nav.setActiveView("global");
  assert.equal(state.activeView, "global");
  assert.equal(byId("studio-app").dataset.view, "global");
  nav.setActiveView("settings");
  assert.equal(state.activeView, "settings");
  assert.equal(byId("studio-app").dataset.view, "settings");
  state.activeView = "graph";
  nav.setActiveView("graph");
  assert.equal(state.activeView, "board");
  assert.equal(byId("studio-app").dataset.view, "board");
  nav.setActiveView("not-a-view");
  assert.equal(state.activeView, "board");
});

test("Composer 按真实 Steer 回执提示，未改权限时省略冗余字段，改权限时显式下发", async () => {
  resetFixture();
  seedThread();
  rpcHandler = () => ({ result: { action: "steered_live" } });
  await composer.handleComposerSubmit("steer");
  assert.equal(toasts.at(-1).message, "⚡ Steer 即时纠偏指令已注入当前回合");
  assert.equal(toasts.at(-1).kind, "success");
  for (const key of ["permissionMode", "runtimeMode", "interactionMode"]) assert.equal(Object.hasOwn(lastSend(), key), false, key);

  byId("comp-prompt-input").value = "切换权限后重启";
  state.composer.permissionMode = "auto";
  rpcHandler = () => ({ result: { action: "steering_restart" } });
  await composer.handleComposerSubmit("steer");
  assert.equal(toasts.at(-1).message, "↻ 当前引擎不支持热注入，已中断本轮并带新指令重启续跑");
  assert.equal(lastSend().permissionMode, "auto");
  assert.equal(lastSend().runtimeMode, "auto");
  assert.equal(lastSend().interactionMode, "default");
});

test("Composer 实际 queued 时撤销乐观消息、保留流式新增内容、恢复状态并本地归队", async () => {
  resetFixture();
  const thread = seedThread();
  rpcHandler = () => {
    thread.items.push(N.normalizeTurnItem({ id: "stream-new", type: "assistant_message", text: "请求期间新增输出" }));
    return { result: { action: "queued" } };
  };
  await composer.handleComposerSubmit("steer");
  assert.deepEqual(thread.items.map((i) => i.id), ["initial", "stream-new"]);
  assert.equal(thread.status, "running");
  assert.equal(thread.startedAt, 111);
  assert.deepEqual(thread.queue.map((q) => q.text), ["既有排队", "继续修正边界条件"]);
  assert.equal(toasts.at(-1).message, "已排入待发队列（当前回合结束后自动执行）");
  assert.equal(toasts.at(-1).kind, "info");

  byId("comp-prompt-input").value = "以后端队列为准";
  rpcHandler = () => ({ result: { action: "queued", queue: [{ id: "server-q", message: "服务端队列" }] } });
  await composer.handleComposerSubmit("auto");
  assert.deepEqual(thread.queue.map((q) => [q.id, q.text]), [["server-q", "服务端队列"]]);
  assert.equal(thread.items.some((i) => i.text === "以后端队列为准"), false);
});

test("队列提升 Steer 区分热注入与重启，运行中输入框提示即时纠偏目标", async () => {
  resetFixture();
  const thread = seedThread();
  rpcHandler = (method) => method === "manageQueue"
    ? { result: { queue: [], steerResult: { action: "steering_restart" } } }
    : { result: {} };
  await composer.handleQueueAction(thread.id, "promote_to_steer", thread.queue[0]);
  assert.equal(toasts.at(-1).message, "↻ 当前引擎不支持热注入，已中断本轮并带新指令重启续跑");

  composer.renderComposerState();
  assert.equal(byId("comp-prompt-input").placeholder, "输入即时纠偏指令，回车立即 Steer 注入给 执行甲…");
  state.threadsMap.get(thread.id).status = "completed";
  composer.renderComposerState();
  assert.equal(byId("comp-prompt-input").placeholder, "向当前目标发指令（空闲续聊 / 运行中 Steer 纠偏，Ctrl+Enter 发送）...");
});

test("成员流式预览更新保持行、Steer 与停止按钮 DOM 引用严格恒等", () => {
  resetFixture();
  const thread = seedThread();
  byId("members-roster-list").innerHTML = "";
  members.renderMembersView();
  const list = byId("members-roster-list");
  const row = list.children[0];
  const actions = row.querySelector(".member-row-actions");
  const steer = actions.querySelector("[data-focus-composer]");
  const stop = actions.querySelector("[data-quick-stop]");
  assert.ok(steer && stop);

  thread.items.push(N.normalizeTurnItem({ id: "stream-1", type: "assistant_message", text: "流式输出第二段" }));
  members.renderMembersView();
  assert.equal(list.children[0], row);
  assert.equal(row.querySelector(".member-row-actions"), actions);
  assert.equal(actions.querySelector("[data-focus-composer]"), steer);
  assert.equal(actions.querySelector("[data-quick-stop]"), stop);
  assert.equal(row.querySelector(".member-preview-line").innerHTML, "流式输出第二段");

  members.renderMembersView();
  assert.equal(actions.querySelector("[data-focus-composer]"), steer);
  assert.equal(actions.querySelector("[data-quick-stop]"), stop);
});

test("Worktree Diff 模式下拉同步，工作树文件统计回填并渲染真实增删行数", async () => {
  resetFixture();
  seedThread();
  const wt = N.normalizeWorktree({
    id: "wt1", threadId: "t1", rootConversationId: ROOT, path: "F:/repo/.agent-tower/worktrees/wt1",
    projectRoot: "F:/repo", branch: "tower/t1", additions: 0, deletions: 0,
  });
  state.worktrees = [wt];
  state.selectedWorktreeId = wt.id;
  state.diffMode = "branch_range";
  worktrees.renderDiffView();
  assert.equal(byId("wt-diff-mode-select").value, "branch_range");

  state.diffMode = "working_tree";
  rpcHandler = () => ({ result: { files: [
    { path: "a.mjs", status: "M", additions: 3, deletions: 1 },
    { path: "b.mjs", status: "M", additions: "2", deletions: 4 },
  ], diff: "" } });
  await worktrees.loadSelectedWorktreeDiff();
  assert.equal(rpcLog.find((r) => r.method === "getWorktreeDiff").params.mode, "working_tree");
  assert.deepEqual([wt.additions, wt.deletions, wt.filesCount], [5, 5, 2]);
  worktrees.renderDiffView();
  assert.equal(byId("wt-diff-mode-select").value, "working_tree");
  assert.match(byId("wt-select-dropdown").innerHTML, /\(\+5\/-5\)/);
  assert.match(byId("wt-diff-viewer").innerHTML, /a\.mjs \(\+3 \/ -1\)/);
  assert.match(byId("wt-diff-viewer").innerHTML, /b\.mjs \(\+2 \/ -4\)/);
});


test("语义工单：多单复用、Steer 归并、queued 排除、无 runId 增量与原生共享 run 切单", () => {
  resetFixture();
  const thread = seedThread({
    activeRunId: "r3",
    currentRun: { id: "r3", status: "running", inputIntent: "delegate", title: "第二单", usage: {}, usageReported: false },
    recentRuns: [
      { id: "r1", ordinal: 1, status: "completed", inputIntent: "delegate", meta: { title: "第一单" } },
      { id: "r2", ordinal: 2, status: "completed", inputIntent: "steering_restart" },
      { id: "q1", ordinal: 3, status: "queued", inputIntent: "delegate" },
      { id: "r3", ordinal: 4, status: "running", inputIntent: "delegate", meta: { title: "第二单" } },
    ],
    items: [
      { id: "u1", type: "user_message", runId: "r1", inputIntent: "delegate", text: "第一单指令", createdAt: 101 },
      { id: "a1", type: "assistant_message", runId: "r1", text: "第一单旧结论", createdAt: 102 },
      { id: "u2", type: "user_message", runId: "r2", inputIntent: "steer", text: "中途纠偏", createdAt: 103 },
      { id: "u3", type: "user_message", runId: "r3", inputIntent: "delegate", text: "第二单指令", createdAt: 104 },
      { id: "n3", type: "assistant_message", runId: "r3", text: "工具前过渡说明", createdAt: 105 },
      { id: "tool3", type: "tool_call", runId: "r3", title: "read_file", createdAt: 106 },
      { id: "live3", type: "assistant_message", text: "无 runId 当前结论", createdAt: 107 },
    ],
  });
  const orders = N.groupThreadWorkOrders(thread);
  assert.equal(orders.length, 2);
  assert.deepEqual(orders[0].runIds, ["r1", "r2"]);
  assert.deepEqual(orders[0].steerItems.map((item) => item.id), ["u2"]);
  assert.equal(orders[1].title, "第二单");
  assert.equal(orders[1].isCurrent, true);
  assert.deepEqual(orders[1].intermediateNotes.map((item) => item.id), ["n3"]);
  assert.deepEqual(orders[1].conclusionItems.map((item) => item.id), ["live3"]);
  assert.ok(!orders.some((order) => order.runIds.includes("q1")));
  assert.equal(thread.orderCount, 2);

  const native = N.normalizeThread({
    id: "native", memberName: "worker", isSwarmMember: true, status: "running", activeRunId: "run_native_shared",
    recentRuns: [{ id: "run_native_shared", status: "running" }],
    items: [
      { id: "nu1", type: "user_message", runId: "run_native_shared", text: "第一轮", createdAt: 201 },
      { id: "na1", type: "assistant_message", runId: "run_native_shared", text: "第一轮回帖", createdAt: 202 },
      { id: "nu2", type: "user_message", runId: "run_native_shared", text: "第二轮", createdAt: 203 },
      { id: "na2", type: "assistant_message", text: "第二轮流式回帖", createdAt: 204 },
    ],
  });
  const nativeOrders = N.groupThreadWorkOrders(native);
  assert.equal(nativeOrders.length, 2);
  assert.deepEqual(nativeOrders.map((order) => order.promptItem.id), ["nu1", "nu2"]);
  assert.deepEqual(nativeOrders[1].conclusionItems.map((item) => item.id), ["na2"]);
});

test("复用成员卡：当前单预览、本轮 Token、去重元信息与空闲外层删除", () => {
  resetFixture();
  state.threadsMap.set("host", N.normalizeThread({ id: "host", rootConversationId: ROOT, isNativeHost: true, memberName: "coordinator", role: "commander", status: "running" }));
  const thread = seedThread({
    parentThreadId: "host", projectName: "重复项目", activeRunId: "r2",
    currentRun: { id: "r2", status: "running", title: "第二单", usage: {}, usageReported: false },
    recentRuns: [{ id: "r1", status: "completed" }, { id: "r2", status: "running", meta: { title: "第二单" } }],
    items: [
      { id: "old", type: "assistant_message", runId: "r1", text: "绝不应残留的第一单结论", createdAt: 101 },
      { id: "new-prompt", type: "user_message", runId: "r2", inputIntent: "delegate", text: "新指令", createdAt: 102 },
    ],
  });
  byId("members-roster-list").innerHTML = "";
  members.renderMembersView();
  const row = byId("members-roster-list").children[0];
  assert.equal(row.querySelector(".member-preview-line").innerHTML, "第二单 — ⏳ 等待首个事件…");
  assert.doesNotMatch(row.querySelector(".member-head-line").innerHTML, /← coordinator/);
  assert.doesNotMatch(row.querySelector(".member-meta-line").innerHTML, /重复项目/);
  assert.equal(row.querySelector("[data-del-thread]"), null);

  thread.items.push(N.normalizeTurnItem({ id: "new-tool", type: "tool_call", runId: "r2", title: "read_file", status: "running" }));
  members.renderMembersView();
  assert.equal(row.querySelector(".member-preview-line").innerHTML, "第二单 — 🛠 read_file");
  assert.doesNotMatch(row.querySelector(".member-preview-line").innerHTML, /第一单结论/);

  thread.status = "completed";
  thread.currentRun.status = "completed";
  thread.currentRun.usage = { totalTokens: 12000 };
  thread.currentRun.usageReported = true;
  members.renderMembersView();
  assert.match(row.querySelector(".member-head-line").innerHTML, /本轮 12\.0K/);
  const del = row.querySelector("[data-del-thread]");
  assert.ok(del);
  assert.equal(del.textContent, "🗑");
  state.pendingConfirms.set(`del:${thread.id}`, Date.now() + 10000);
  members.renderMembersView();
  assert.equal(row.querySelector("[data-del-thread]").textContent, "确认删除?");
});

test("成员抽屉：历史手风琴、过程聚合、切成员归零与流式区块 DOM 恒等", () => {
  resetFixture();
  const longPrompt = "第一行指令\n第二行指令\n第三行指令\n第四行指令\n第五行不应默认展开";
  const thread = seedThread({
    activeRunId: "r2",
    currentRun: { id: "r2", status: "running", title: "最新工单", usage: {}, usageReported: false },
    recentRuns: [{ id: "r1", status: "completed" }, { id: "r2", status: "running", meta: { title: "最新工单" } }],
    items: [
      { id: "old-prompt", type: "user_message", runId: "r1", inputIntent: "delegate", text: "旧指令", createdAt: 101 },
      { id: "old-result", type: "assistant_message", runId: "r1", text: "旧工单结论", createdAt: 102 },
      { id: "new-prompt", type: "user_message", runId: "r2", inputIntent: "delegate", text: longPrompt, createdAt: 103 },
      { id: "note", type: "assistant_message", runId: "r2", text: "工具前中间过渡说明", createdAt: 104 },
      { id: "reason", type: "reasoning", runId: "r2", text: "分析", status: "completed", createdAt: 105, completedAt: 106, durationMs: 1000 },
      { id: "tool", type: "tool_call", runId: "r2", title: "read_file", status: "completed", createdAt: 107 },
      { id: "result", type: "assistant_message", runId: "r2", text: "新工单结论", createdAt: 108 },
    ],
  });
  const body = byId("md-timeline-body");
  body.scrollTop = 77;
  members.openMemberDrawer(thread.id);
  assert.equal(body.scrollTop, 0);
  const byKey = (key) => body.children.find((child) => child.getAttribute("data-md-block") === key);
  const history = byKey("history-orders");
  const prompt = byKey("cur-prompt:run:r2");
  const trace = byKey("cur-trace:run:r2");
  const conclusion = byKey("cur-conclusion:run:r2");
  assert.match(history.innerHTML, /查看历史工单（共 1 单）/);
  assert.doesNotMatch(history.innerHTML, /旧工单结论/);
  assert.match(prompt.innerHTML, /data-toggle-prompt/);
  assert.doesNotMatch(prompt.innerHTML, /第五行不应默认展开/);
  assert.match(trace.innerHTML, /1 段过程说明/);
  assert.match(trace.innerHTML, /工具前中间过渡说明/);
  assert.match(conclusion.innerHTML, /新工单结论/);
  assert.doesNotMatch(conclusion.innerHTML, /旧工单结论/);

  body.scrollTop = 90;
  thread.items.push(N.normalizeTurnItem({ id: "stream-more", type: "assistant_message", runId: "r2", text: "流式追加", createdAt: 109 }));
  members.renderMemberDrawer();
  assert.equal(body.scrollTop, 90);
  assert.equal(byKey("history-orders"), history);
  assert.equal(byKey("cur-prompt:run:r2"), prompt);
  assert.equal(byKey("cur-trace:run:r2"), trace);
  assert.equal(byKey("cur-conclusion:run:r2"), conclusion);
  assert.match(conclusion.innerHTML, /流式追加/);

  state.expandedTraces.add(`${thread.id}:history_orders`);
  state.expandedTraces.add(`${thread.id}:hist_run:r1`);
  members.renderMemberDrawer();
  assert.match(byKey("history-orders").innerHTML, /旧工单结论/);

  const other = seedThread({ id: "t2", title: "执行乙", memberName: "执行乙", activeRunId: "other-run", items: [] });
  body.scrollTop = 99;
  members.openMemberDrawer(other.id);
  assert.equal(body.scrollTop, 0);
});

test("流式本轮与累计 Token 解耦，final 兜底只看当前 run，历史补拉带 tail/runId", async () => {
  resetFixture();
  const thread = seedThread({
    activeRunId: "r1",
    usage: { inputTokens: 4000, outputTokens: 1000, totalTokens: 5000 },
    cumulativeUsage: { inputTokens: 4000, outputTokens: 1000, totalTokens: 5000 },
    currentRun: { id: "r1", status: "completed", usage: { inputTokens: 4000, outputTokens: 1000, totalTokens: 5000 }, usageReported: true },
    recentRuns: [{ id: "r1", status: "completed", inputIntent: "delegate" }],
    items: [{ id: "old", type: "assistant_message", runId: "r1", text: "旧单结论", createdAt: 101 }],
  });
  stream.ingestStreamPayload({ type: "run_started", threadId: thread.id, runId: "r2", inputIntent: "delegate", title: "新单", startedAt: 200 });
  assert.equal(thread.currentRun.id, "r2");
  assert.equal(thread.usage.totalTokens, 0);
  assert.equal(thread.usageReported, false);
  stream.ingestStreamPayload({ type: "reasoning_delta", threadId: thread.id, runId: "r2", delta: "思考" });
  stream.ingestStreamPayload({ type: "usage_updated", threadId: thread.id, runId: "r2", usage: { inputTokens: 1500, outputTokens: 500, totalTokens: 2000 } });
  assert.equal(thread.currentRun.usage.totalTokens, 2000);
  assert.equal(thread.currentRun.usageReported, true);
  assert.equal(thread.cumulativeUsage.totalTokens, 7000);
  stream.ingestStreamPayload({ type: "run_completed", threadId: thread.id, runId: "r2", status: "completed", assistantText: "新单结论", completedAt: 300 });
  assert.equal(thread.items.filter((item) => item.type === "assistant_message" && item.text === "新单结论").length, 1);
  assert.equal(thread.items.at(-1).runId, "r2");
  assert.equal(thread.recentRuns.at(-1).inputIntent, "delegate");
  assert.ok(thread.recentRuns.at(-1).createdAt > 0);
  S.recomputeScopedStats();
  assert.equal(state.stats.totalTokens, 7000);

  // Codex 同原生会话追问：run_started 保持同一工单，usage_updated 按会话累计增量计算不双计
  thread.nativeSessionId = "codex-s2";
  stream.ingestStreamPayload({ type: "run_started", threadId: thread.id, runId: "r3", inputIntent: "follow_up", startedAt: 320 });
  assert.equal(N.groupThreadWorkOrders(thread).length, 2);
  stream.ingestStreamPayload({ type: "usage_updated", threadId: thread.id, runId: "r3", usage: { inputTokens: 2000, outputTokens: 800, totalTokens: 2800 } });
  assert.equal(thread.currentRun.usage.totalTokens, 2800);
  assert.equal(thread.cumulativeUsage.totalTokens, 7800);

  rpcHandler = () => ({ result: { thread: { id: thread.id, rootConversationId: ROOT }, items: [], recentRuns: thread.recentRuns } });
  await stream.hydrateThreadDetails(thread.id);
  assert.equal(rpcLog.at(-1).params.tail, true);
  rpcHandler = () => ({ result: { items: [{ id: "ancient", type: "assistant_message", runId: "r1", text: "窗口外旧轨迹", createdAt: 100 }] } });
  await stream.hydrateOrderRunItems(thread.id, "r1");
  assert.equal(rpcLog.at(-1).params.runId, "r1");
  assert.equal(rpcLog.at(-1).params.tail, undefined);
  assert.ok(state.threadsMap.get(thread.id).items.some((item) => item.id === "ancient"));
});

test("看板复用卡第三单：在途与完结帖数一致，无派单/占位重复且序号连续", () => {
  resetFixture();
  const thread = seedThread({
    activeRunId: "r3",
    currentRun: { id: "r3", status: "running", title: "第三单", usage: {}, usageReported: false },
    recentRuns: [{ id: "r1", status: "completed" }, { id: "r2", status: "completed" }, { id: "r3", status: "running" }],
    items: [1, 2, 3].flatMap((n) => [
      { id: `u${n}`, type: "user_message", runId: `r${n}`, inputIntent: "delegate", text: `第${n}单指令`, createdAt: n * 100 },
      { id: `a${n}`, type: "assistant_message", runId: `r${n}`, text: `第${n}单结论`, createdAt: n * 100 + 10 },
    ]),
  });
  const backendPost = (runId, source, text, ts) => N.normalizeBoardMessage({ threadId: thread.id, runId, source, text, ts, agent: source === "orchestrator-dispatch" ? "你" : "执行甲", rootConversationId: ROOT });
  state.boardMessages = [
    backendPost("r1", "orchestrator-dispatch", "第1单指令", 100), backendPost("r1", "orchestrator-result", "第1单结论", 110),
    backendPost("r2", "orchestrator-dispatch", "第2单指令", 200), backendPost("r2", "orchestrator-result", "第2单结论", 210),
    backendPost("r3", "orchestrator-dispatch", "第3单指令", 300), backendPost("r3", "orchestrator-result", "正在执行任务…", 310),
  ];
  const running = board.buildBoardPosts([thread]);
  assert.equal(running.length, 6);
  assert.deepEqual(running.map((post) => post.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(running.filter((post) => post.bodyText === "第3单指令").length, 1);
  assert.ok(!running.some((post) => post.bodyText === "正在执行任务…"));
  assert.ok(running.some((post) => post.bodyText === "第3单结论"));

  thread.status = "completed";
  thread.currentRun.status = "completed";
  state.boardMessages[state.boardMessages.length - 1] = backendPost("r3", "orchestrator-result", "第3单结论", 310);
  const completed = board.buildBoardPosts([thread]);
  assert.equal(completed.length, running.length);
  assert.deepEqual(completed.map((post) => post.seq), running.map((post) => post.seq));
  assert.deepEqual(completed.map((post) => post.bodyText), running.map((post) => post.bodyText));

  // 同工单追问/Steer 重启（r4 属于第 3 单）：不重复合成 r3 已完结结论、不重复 r4 派单、压掉 r4 占位帖
  thread.status = "running";
  thread.activeRunId = "r4";
  thread.currentRun = { id: "r4", status: "running", inputIntent: "follow_up", title: "第三单", usage: {}, usageReported: false };
  thread.recentRuns.push({ id: "r4", status: "running", inputIntent: "follow_up" });
  thread.items.push(
    N.normalizeTurnItem({ id: "u4", type: "user_message", runId: "r4", inputIntent: "follow_up", text: "第3单追问", createdAt: 400 }),
    N.normalizeTurnItem({ id: "a4", type: "assistant_message", runId: "r4", status: "running", text: "第3单追问流式回复", createdAt: 410 }),
  );
  state.boardMessages.push(
    backendPost("r4", "orchestrator-dispatch", "第3单追问", 400),
    backendPost("r4", "orchestrator-result", "正在执行任务…", 410),
  );
  const followRunning = board.buildBoardPosts([thread]);
  assert.equal(followRunning.length, 8);
  assert.equal(followRunning.filter((post) => post.bodyText === "第3单结论").length, 1);
  assert.equal(followRunning.filter((post) => post.bodyText === "第3单追问").length, 1);
  assert.ok(!followRunning.some((post) => post.bodyText === "正在执行任务…"));
  assert.equal(followRunning.at(-1).bodyText, "第3单追问流式回复");
});

test("主对话派单消息补齐：原生 Swarm 子成员关联看板指令与结论、run.prompt 截断兜底、流式复用 ID 结论外显与看板筛选双向保留", () => {
  resetFixture();
  const host = N.normalizeThread({
    id: "host", rootConversationId: ROOT, isNativeHost: true, isSwarmMember: true,
    memberName: "coordinator", role: "commander", status: "running",
    items: [{ id: "hu1", type: "user_message", text: "让 Carbon 审一下改动", createdAt: 90 }],
  });
  const swarmWorker = N.normalizeThread({
    id: "thr_native_carbon", rootConversationId: ROOT, parentThreadId: "host",
    isNativeHost: true, isSwarmMember: true, memberName: "reviewer_carbon", role: "reviewer", status: "waiting",
    recentRuns: [{ id: "run_native_carbon", status: "completed", prompt: "Native Antigravity Host Conversation" }],
    items: [
      { id: "c_note", type: "assistant_message", runId: "run_native_carbon", text: "先查看文件", createdAt: 102 },
      { id: "c_tool", type: "tool_call", runId: "run_native_carbon", title: "read_file", createdAt: 105 },
      { id: "c_wait", type: "tool_call", runId: "run_native_carbon", title: "swarm_wait", createdAt: 130 },
    ],
  });
  const claudeMember = N.normalizeThread({
    id: "thr_claude", rootConversationId: ROOT, parentThreadId: "host",
    memberName: "advisor_claude", provider: "claude-code", status: "completed",
    recentRuns: [{ id: "rc1", status: "completed", inputIntent: "delegate", prompt: "窗口截断外的原始派单指令", createdAt: 200 }],
    items: [
      // 模拟单条流式消息 ordinal 在前、updatedAt 在工具之后（且首条 user_message 被 400 条窗口截掉）
      { id: "msg_rc1", type: "assistant_message", runId: "rc1", text: "最终完整评审报告", createdAt: 201, updatedAt: 250 },
      { id: "tool_rc1", type: "tool_call", runId: "rc1", title: "read_file", createdAt: 210, completedAt: 220 },
    ],
  });
  state.threadsMap.set(host.id, host);
  state.threadsMap.set(swarmWorker.id, swarmWorker);
  state.threadsMap.set(claudeMember.id, claudeMember);
  state.boardMessages = [
    N.normalizeBoardMessage({ seq: 1, source: "native-swarm", agent: "coordinator", mentions: ["reviewer_carbon"], text: "@reviewer_carbon 第一轮审查任务", ts: 50, rootConversationId: ROOT }),
    N.normalizeBoardMessage({ seq: 2, source: "native-swarm", agent: "reviewer_carbon", mentions: ["coordinator"], text: "@coordinator [done] 第一轮 PASS", ts: 60, rootConversationId: ROOT }),
    N.normalizeBoardMessage({ seq: 3, source: "native-swarm", agent: "coordinator", mentions: ["reviewer_carbon"], text: "@reviewer_carbon 第二轮审查任务", ts: 100, rootConversationId: ROOT }),
    N.normalizeBoardMessage({ seq: 4, source: "native-swarm", agent: "reviewer_carbon", mentions: ["coordinator"], text: "@coordinator [done] 第二轮 PASS", ts: 120, rootConversationId: ROOT }),
  ];

  const swarmOrders = N.groupThreadWorkOrders(swarmWorker);
  assert.equal(swarmOrders.length, 2);
  assert.equal(swarmOrders[0].promptItem?.text, "第一轮审查任务");
  assert.equal(swarmOrders[0].conclusionItems[0]?.text, "[done] 第一轮 PASS");
  assert.equal(swarmOrders[1].promptItem?.text, "第二轮审查任务");
  assert.equal(swarmOrders[1].conclusionItems.at(-1)?.text, "[done] 第二轮 PASS");

  const claudeOrders = N.groupThreadWorkOrders(claudeMember);
  assert.equal(claudeOrders.length, 1);
  assert.equal(claudeOrders[0].promptItem?.text, "窗口截断外的原始派单指令");
  assert.equal(claudeOrders[0].conclusionItems.length, 1);
  assert.equal(claudeOrders[0].conclusionItems[0].text, "最终完整评审报告");

  // 看板按子成员胶囊筛选时保留 coordinator -> @reviewer_carbon 的派单指令
  state.boardMemberFilters.add(swarmWorker.id);
  const filtered = board.getFilteredBoardPosts([host, swarmWorker, claudeMember]);
  assert.equal(filtered.length, 4);
  assert.ok(filtered.some((p) => p.isDispatch && p.bodyText.includes("第二轮审查任务")));
  state.boardMemberFilters.clear();

  // 主对话自身抽屉展示本轮向子 Agent 派发指令汇总
  members.openMemberDrawer(host.id);
  assert.match(byId("md-timeline-body").children.map((c) => c.innerHTML).join(""), /本轮向子 Agent 派发指令/);
});

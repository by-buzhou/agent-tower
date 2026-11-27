import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../helpers/sandbox.mjs";

// v0.2.11 Track B：Studio 第 4 成员组「规范维护组」、按项目双向联动自动维护开关、手动只读梳理入口与整组提案确认卡。
// 纯 Node 驱动真实 ui 模块（最小 window / document 桩），不起浏览器；380px / 1440px 实测复用 v029 共享 Edge 守护套件。
const studioDir = path.join(repoRoot, "sidecars", "studio");
const uiDir = path.join(studioDir, "ui");
const WORKSPACE = "F:/repo";

// UI 内 toast / 二次确认 / 防抖计时器不阻塞进程退出（单文件 < 2s）
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = nativeSetTimeout(fn, ms, ...args);
  t?.unref?.();
  return t;
};

function makeEl(id = "") {
  const classes = new Set();
  return {
    id, innerHTML: "", textContent: "", hidden: false, disabled: false, title: "", attrs: {}, dataset: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on) },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; },
    contains: () => false, querySelector: () => null, querySelectorAll: () => [], closest: () => null, appendChild() {}, remove() {},
  };
}
const els = new Map();
const toasts = [];
const rpcLog = [];
let rpcHandler = () => ({});
const byId = (id) => {
  if (id === "toast-container") return { appendChild: (el) => toasts.push(el.textContent) };
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id);
};
const store = new Map();
globalThis.location = { pathname: "/", search: "" };
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.CSS = { escape: (s) => String(s) };
globalThis.document = {
  activeElement: null, documentElement: { dataset: {} }, body: {},
  getElementById: byId, querySelector: () => null, querySelectorAll: () => [],
  createElement: () => ({ className: "", textContent: "", remove() {} }),
};
globalThis.window = {
  sidecar: {
    conversationId: "conv-curator",
    fetch: async (_url, init) => {
      const { method, params } = JSON.parse(init.body);
      rpcLog.push({ method, params });
      const out = await rpcHandler(method, params);
      if (out?.error) return { ok: false, status: 409, json: async () => ({ ok: false, error: { message: out.error.message, code: out.error.code } }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: out ?? {} }) };
    },
  },
};

const mod = (f) => import(pathToFileURL(path.join(uiDir, f)).href);
const S = await mod("state.js");
const P = await mod("presets.js");
const N = await mod("normalize.js");
const C = await mod("config-view.js");
const M = await mod("members-view.js");
const { state } = S;

const curation = (extra = {}) => ({ workspace: WORKSPACE, autoTrigger: false, running: false, activeThreadId: null, activeRunId: null, lastNoChange: null, pendingProposal: null, recentProposals: [], ...extra });
const proposal = (extra = {}) => ({
  id: "sprop_1", status: "pending", summary: "合并派发规则 <script>x</script>", triggerSource: "manual", threadId: "thr_cur", preflightOk: true, parseError: "",
  changes: [
    { action: "update", path: ".agent-tower/spec/01-business/orchestration-modes.md", why: "两条重复", changeSummary: "合并为一段", mergedOrRemoved: "删去旧第 3 句", impactAndTests: "v010-orchestration-modes",
      content: "---\nid: orchestration-modes\n---\n# 新正文", diffPreview: "-旧\n+新", bodyBytes: 1500, preflightOk: true, preflightIssues: [] },
    { action: "delete", path: ".agent-tower/spec/02-coding/obsolete.md", why: "已废止", changeSummary: "整篇删除", mergedOrRemoved: "全文", impactAndTests: "无", content: "", diffPreview: "-全文", bodyBytes: 0, preflightOk: true, preflightIssues: [] },
  ],
  ...extra,
});
const methods = () => rpcLog.map((r) => r.params?.action ? `${r.method}:${r.params.action}` : r.method);

function resetAll() {
  state.presets = {};
  for (const slot of S.ROLE_SLOT_META) state.presets[slot.key] = S.seedPreset(slot.key);
  for (const k of ["dirtyPresets", "editedPresets", "committedPresets", "dirtyModeProfiles", "pendingDeletes", "pendingResets"]) state[k].clear();
  state.pendingConfirms.clear();
  state.modeProfiles = structuredClone(S.DEFAULT_MODE_PROFILES);
  state.editingModeProfile = "complex";
  state.settingsPane = "roles";
  state.openMemberKey = "";
  state.collapsedGroups.clear();
  state.conversationUnbound = false;
  state.workspace = WORKSPACE;
  state.providers = N.normalizeProvidersCatalog(S.FALLBACK_PROVIDERS, false, []);
  Object.assign(state.projectSpecs, { loading: false, initializing: false, loadedForWorkspace: "", data: null, error: "", openKey: "", bodies: {} });
  state.specCuration = S.emptySpecCuration();
  Object.assign(state.specCurationUi, { busy: "", triggerOpen: false, note: "", reviseOpen: false, feedback: "", statusLoadedFor: "", statusLoading: false, watchRun: "" });
  state.specCurationUi.openDetails.clear();
  state.threadsMap.clear();
  S.applySpecCurationPayload(curation());
  rpcLog.length = 0;
  toasts.length = 0;
  rpcHandler = () => ({});
}
const gridHtml = () => { C.renderSettingsView(); return els.get("role-presets-grid").innerHTML; };
const panelHtml = () => { C.renderSpecCurationSection(); return els.get("spec-curation-panel").innerHTML; };

test("第 4 组 curator：常量、种子、modeProfiles 归一化与派发池隔离", () => {
  resetAll();
  const g = S.MEMBER_GROUPS.find((x) => x.id === "curator");
  assert.deepEqual([g.title, g.stageTitle, g.hint, g.starrable, g.keys], ["规范维护组", "规范维护", "只读提案 · 确认落盘", true, ["curator_codex"]]);
  assert.deepEqual(S.MEMBER_GROUP_IDS, ["advisor", "executor", "reviewer", "curator"]);
  assert.deepEqual(S.DISPATCH_GROUP_IDS, ["advisor", "executor", "reviewer"]);
  assert.deepEqual(S.MODE_PROFILE_GROUPS, { relay: ["executor"], complex: ["advisor", "executor", "reviewer", "curator"] });
  assert.deepEqual(S.DEFAULT_MODE_PROFILES.complex.curator, { enabledKeys: ["curator_codex"], preferredKey: "curator_codex" }, "无 stageEnabled：自动开关按项目另存");
  assert.ok(S.RESERVED_PRESET_KEYS.has("curator") && !P.isValidPresetKey("curator") && P.isValidPresetKey("curator_kimi"));
  const seed = S.seedPreset("curator_codex");
  assert.deepEqual([seed.group, seed.role, seed.provider, seed.model, seed.effort, seed.permissionMode, seed.interactionMode, seed.isolation, seed.label],
    ["curator", "curator", "codex", "gpt-6.2-astra", "high", "read-only", "plan", "shared", "规范维护官 · GPT-6.2 Astra"]);
  assert.deepEqual(S.normalizeClientModeProfiles(null, null), S.DEFAULT_MODE_PROFILES, "离线默认与归一化结果一致");

  // 远端旧结构（无 curator）→ 按成员池迁移；放行宿主原生 antigravity / agy 维护官，仅拦截内部伪 ID（host）与跨组成员
  state.presets.curator_agy = { key: "curator_agy", group: "curator", label: "AGY", provider: "antigravity", model: "gemini-4-argon" };
  state.presets.curator_bad = { key: "curator_bad", group: "curator", label: "BAD", provider: "host", model: "gemini-4-argon" };
  const norm = S.normalizeClientModeProfiles({ complex: { curator: { enabledKeys: ["curator_bad", "curator_agy", "curator_codex", "executor_codex", "ghost"], preferredKey: "curator_agy" } } }, state.presets);
  assert.deepEqual(norm.complex.curator, { enabledKeys: ["curator_agy", "curator_codex"], preferredKey: "curator_agy" });
  assert.equal(norm.complex.advisor.stageEnabled, true);
  assert.ok(!("stageEnabled" in norm.complex.curator));
  delete state.presets.curator_agy;
  delete state.presets.curator_bad;

  // 规范维护组不是派发阶段：不进派发勾选池 / 底栏下拉 / 阵容微摘要
  assert.equal(S.isModeStageEnabled("complex", "curator"), false);
  assert.ok(!S.listDispatchablePresets("complex").some((p) => p.group === "curator"));
  assert.deepEqual(S.activeGroupMembers("curator", "complex"), []);
  assert.equal(S.modeRosterSummary("complex"), "军师 开(3) → 执行(4) → 审核 开(1)");
  assert.equal(S.preferredCuratorMember().key, "curator_codex");
  assert.ok(S.ROLE_SLOT_META.some((s) => s.key === "curator_codex") && S.MEMBER_GROUPS.every((x) => x.keys.every((k) => S.seedGroupOf(k) === x.id)));
});

test("规范维护组放行宿主原生、权限 / 隔离跟随引擎锁定，模型 / 强度 / ★ / 新增 / 删除保持平权", () => {
  resetAll();
  const ids = C.curatorProviderOptions().map((o) => o.value);
  assert.equal(S.isCuratorBlockedProvider(" "), true);
  assert.ok(ids.includes("codex") && ids.includes("claude-code") && ids.includes("kimi-code") && ids.includes("antigravity"), "引擎下拉同时包含外部 CLI 与宿主原生 antigravity");

  C.editRolePreset("curator_codex", "permissionMode", "full-access");
  C.editRolePreset("curator_codex", "isolation", "worktree");
  assert.deepEqual([state.presets.curator_codex.permissionMode, state.presets.curator_codex.isolation], ["read-only", "shared"]);
  assert.match(toasts.at(-1), /权限与目录隔离跟随引擎自动锁定/);

  // 切换为宿主原生 antigravity：放行并锁定 plan + shared
  C.editRolePreset("curator_codex", "provider", "antigravity");
  const agy = state.presets.curator_codex;
  assert.deepEqual([agy.provider, agy.permissionMode, agy.interactionMode, agy.isolation], ["antigravity", "plan", "plan", "shared"], "宿主原生维护官锁 plan + shared");
  assert.ok(agy.model, "换为 antigravity 后模型自动对齐");
  state.openMemberKey = "curator_codex";
  const agyDrawer = gridHtml().slice(gridHtml().indexOf('data-member-drawer="curator_codex"'));
  assert.match(agyDrawer.slice(0, agyDrawer.indexOf("</select>")), /value="antigravity" selected/);
  assert.match(agyDrawer, /data-curator-locked="permissionMode"[^>]*>🔒 只读沙盒 \/ Hook 门禁 \(plan\)/);
  assert.doesNotMatch(agyDrawer, /已排除宿主原生/);

  C.editRolePreset("curator_codex", "provider", "claude-code");
  const p = state.presets.curator_codex;
  assert.deepEqual([p.provider, p.permissionMode, p.interactionMode, p.isolation], ["claude-code", "plan", "plan", "shared"], "非 Codex 外部引擎锁 plan");
  assert.ok(p.model, "换引擎后模型自动对齐新引擎");
  C.editRolePreset("curator_codex", "effort", "max");
  assert.equal(state.presets.curator_codex.effort, "max", "思考强度自由选择");
  C.editRolePreset("curator_codex", "provider", "codex");
  assert.deepEqual([state.presets.curator_codex.permissionMode, state.presets.curator_codex.interactionMode], ["read-only", "plan"]);

  // applyCuratorLocks：antigravity 保留并锁 plan + shared；仅内部伪 ID（host）回落 codex
  const agyLocked = { provider: "antigravity", model: "gemini-4-argon", permissionMode: "always-proceed", interactionMode: "default", isolation: "worktree" };
  assert.deepEqual(P.applyCuratorLocks(agyLocked).sort(), ["interactionMode", "isolation", "permissionMode"]);
  assert.deepEqual([agyLocked.provider, agyLocked.permissionMode, agyLocked.interactionMode, agyLocked.isolation], ["antigravity", "plan", "plan", "shared"]);
  const badLocked = { provider: "host", model: "gemini-4-argon", permissionMode: "always-proceed", interactionMode: "default", isolation: "worktree" };
  assert.deepEqual(P.applyCuratorLocks(badLocked).sort(), ["interactionMode", "isolation", "model", "permissionMode", "provider"]);
  assert.deepEqual([badLocked.provider, badLocked.permissionMode, badLocked.interactionMode, badLocked.isolation], ["codex", "read-only", "plan", "shared"]);
  const draft = P.newCustomPresetBase("curator");
  assert.deepEqual([draft.group, draft.role, draft.permissionMode, draft.interactionMode, draft.isolation], ["curator", "curator", "read-only", "plan", "shared"]);

  // 新增并保存 antigravity 规范维护官草稿：自动勾选进 complex.curator 且锁定 plan + shared
  C.startAddMember("curator");
  C.updateMemberDraftField("label", "原生维护官");
  C.updateMemberDraftField("key", "curator_agy");
  C.editRolePreset(S.MEMBER_DRAFT_KEY, "provider", "antigravity");
  C.confirmAddMember();
  assert.deepEqual(
    [state.presets.curator_agy.provider, state.presets.curator_agy.permissionMode, state.presets.curator_agy.interactionMode, state.presets.curator_agy.isolation],
    ["antigravity", "plan", "plan", "shared"],
  );
  assert.ok(state.modeProfiles.complex.curator.enabledKeys.includes("curator_agy"));
  delete state.presets.curator_agy;
  state.modeProfiles.complex.curator.enabledKeys = state.modeProfiles.complex.curator.enabledKeys.filter((k) => k !== "curator_agy");

  // 抽屉：原生 select 包含 antigravity，权限 / 隔离为锁定提示（不渲染可编辑触发器 / 分段）
  state.openMemberKey = "curator_codex";
  const html = gridHtml();
  const drawer = html.slice(html.indexOf('data-member-drawer="curator_codex"'));
  assert.match(drawer, /<select class="compact-select ps-curator-provider" data-curator-provider="curator_codex"/);
  assert.match(drawer.slice(0, drawer.indexOf("</select>")), /value="antigravity"/);
  assert.match(drawer, /data-curator-locked="permissionMode"[^>]*>🔒 只读沙盒 \(read-only\)/);
  assert.match(drawer, /data-curator-locked="isolation"/);
  assert.doesNotMatch(drawer, /data-ps-field="permissionMode"|data-ps-seg="curator_codex"/);
  assert.match(drawer, /data-ps-key="curator_codex" data-ps-field="model"/);
  assert.match(drawer, /data-member-delete="curator_codex"/, "平权删除");
  // ★ 首选 + 勾选沿用通用阵容链路（modeProfiles.complex.curator）
  C.setModePreferred("complex", "curator", "curator_codex");
  state.presets.curator_kimi = { ...S.seedPreset("curator_codex"), key: "curator_kimi", label: "维护官 Kimi", provider: "kimi-code", model: "kimi-code/k3.1-pro", permissionMode: "plan" };
  C.toggleModeMember("complex", "curator", "curator_kimi");
  C.setModePreferred("complex", "curator", "curator_kimi");
  assert.deepEqual(state.modeProfiles.complex.curator, { enabledKeys: ["curator_codex", "curator_kimi"], preferredKey: "curator_kimi" });
  assert.ok(state.dirtyModeProfiles.has("complex.curator"));
});

test("复杂阶段栏 / 维护组卡头 / 项目规范顶栏三处自动开关同源联动，按项目 setAuto 且不进 toggleModeStage", async () => {
  resetAll();
  state.specCurationUi.statusLoadedFor = WORKSPACE.toLowerCase();
  let html = gridHtml();
  const flow = html.slice(html.indexOf('data-mode-flow="complex"'), html.indexOf('class="pool-columns"'));
  assert.match(flow, /军师阶段[\s\S]*执行阶段[\s\S]*审核阶段[\s\S]*规范维护<span class="mode-flow-scope">（本项目）<\/span> <span class="mode-flow-state">手动<\/span>/);
  assert.match(flow, /data-curation-auto-toggle data-fk="flow:curator" aria-pressed="false"/);
  assert.equal((flow.match(/data-mode-stage-toggle=/g) || []).length, 2, "规范维护不复用阶段开关");
  const columns = html.slice(html.indexOf('class="pool-columns"'), html.indexOf('class="pool-curator-row"'));
  assert.equal((columns.match(/data-pool-group="/g) || []).length, 3, "三阶段组并排不变");
  const curatorRow = html.slice(html.indexOf('class="pool-curator-row"'));
  assert.match(curatorRow, /data-pool-group="curator"[\s\S]*规范维护组[\s\S]*已启用 1 \/ 1 名维护官/);
  assert.match(curatorRow, /role="switch" aria-checked="false" data-curation-auto-toggle data-fk="stage:curator"/);
  assert.match(curatorRow, /data-member-key="curator_codex"/, "自动开关关闭时成员列表照常可编辑");
  assert.match(curatorRow, /data-mode-member-star="curator_codex"/);

  // 服务端快照（任一来源）打开本项目自动维护 → 三处同时显示开启
  S.applySpecCurationPayload(curation({ autoTrigger: true }));
  html = gridHtml();
  assert.match(html, /data-fk="flow:curator" aria-pressed="true"/);
  assert.match(html, /aria-checked="true" data-curation-auto-toggle data-fk="stage:curator"/);
  C.renderProjectSpecsSection();
  assert.equal(els.get("btn-spec-curation-auto").attrs["aria-checked"], "true");
  // 其他项目的快照被丢弃
  assert.equal(S.applySpecCurationPayload(curation({ workspace: "F:/other", autoTrigger: false })), false);
  assert.equal(S.currentSpecCuration().autoTrigger, true);

  // 点击（任一处）→ setAuto 取反；modeProfiles / 阶段开关零改动
  const profilesBefore = JSON.stringify(state.modeProfiles);
  rpcHandler = (method, params) => ({ ok: true, workspace: WORKSPACE, autoTrigger: params.autoTrigger, curation: curation({ autoTrigger: params.autoTrigger }) });
  await C.toggleSpecCurationAuto();
  assert.deepEqual(rpcLog.at(-1), { method: "specCuration", params: { conversationId: "conv-curator", workspace: WORKSPACE, action: "setAuto", cwd: WORKSPACE, autoTrigger: false } });
  assert.equal(S.currentSpecCuration().autoTrigger, false);
  assert.equal(JSON.stringify(state.modeProfiles), profilesBefore);
  assert.equal(state.dirtyModeProfiles.size, 0);
  C.renderProjectSpecsSection();
  assert.equal(els.get("btn-spec-curation-auto").attrs["aria-checked"], "false");
  assert.match(gridHtml(), /data-fk="flow:curator" aria-pressed="false"/);

  // 开启前置：维护组为空 → 本地拦截不发 RPC；有成员 → setAuto true
  state.modeProfiles.complex.curator = { enabledKeys: [], preferredKey: null };
  rpcLog.length = 0;
  await C.toggleSpecCurationAuto();
  assert.equal(rpcLog.length, 0);
  assert.match(toasts.at(-1), /规范维护组尚未勾选成员/);
  state.modeProfiles.complex.curator = structuredClone(S.DEFAULT_MODE_PROFILES.complex.curator);
  await C.toggleSpecCurationAuto();
  assert.deepEqual([rpcLog.at(-1).params.action, rpcLog.at(-1).params.autoTrigger, S.currentSpecCuration().autoTrigger], ["setAuto", true, true]);
  // 自动维护开启但维护组被清空 → 内联告警（不阻断）
  state.modeProfiles.complex.curator = { enabledKeys: [], preferredKey: null };
  assert.deepEqual(S.modeProfileIssues("complex").map((i) => [i.group, i.kind]), [["curator", "curator_empty"]]);
  // 服务端拒绝（CURATOR_ROSTER_EMPTY）透出中文说明，开关保持原值
  state.modeProfiles.complex.curator = structuredClone(S.DEFAULT_MODE_PROFILES.complex.curator);
  S.applySpecCurationPayload(curation({ autoTrigger: false }));
  rpcHandler = () => ({ error: { code: "CURATOR_ROSTER_EMPTY", message: "roster empty" } });
  await C.toggleSpecCurationAuto();
  assert.match(toasts.at(-1), /规范维护组尚未勾选成员/);
  assert.equal(S.currentSpecCuration().autoTrigger, false);
  // 未绑定项目：拦截
  state.conversationUnbound = true;
  rpcLog.length = 0;
  await C.toggleSpecCurationAuto();
  assert.equal(rpcLog.length, 0);
  assert.match(toasts.at(-1), /未绑定项目目录/);
});

test("Bootstrap / 项目规范列表 / 旧守护进程补拉三路同步 curation 快照", async () => {
  resetAll();
  P.mergeRemotePresets({ specCuration: curation({ autoTrigger: true, running: true, activeThreadId: "thr_cur" }) });
  assert.deepEqual([S.currentSpecCuration().autoTrigger, S.currentSpecCuration().running], [true, true]);
  rpcHandler = (method) => (method === "listProjectSpecs" ? { workspace: WORKSPACE, specs: [], pluginSpecs: [], counts: {}, curation: curation({ pendingProposal: proposal() }) } : {});
  await C.refreshProjectSpecs({ silent: true });
  assert.equal(S.currentSpecCuration().pendingProposal.id, "sprop_1");
  assert.equal(S.currentSpecCuration().running, false);
  // 非 pending 状态的提案不挂确认卡；坏数据安全归一
  S.applySpecCurationPayload(curation({ pendingProposal: { ...proposal(), status: "applied" }, recentProposals: [null, { id: "sprop_0", changes: "bad" }] }));
  assert.equal(S.currentSpecCuration().pendingProposal, null);
  assert.deepEqual(S.currentSpecCuration().recentProposals.map((p) => [p.id, p.changes.length, p.preflightOk]), [["sprop_0", 0, false]]);
  // 复杂阵容页 + 无快照时补拉一次 status（同工作区不重复）
  state.specCurationUi.statusLoadedFor = "";
  rpcLog.length = 0;
  rpcHandler = () => ({ ok: true, workspace: WORKSPACE, curation: curation({ autoTrigger: true }) });
  gridHtml();
  await new Promise((r) => nativeSetTimeout(r, 0));
  gridHtml();
  assert.deepEqual(methods(), ["specCuration:status"]);
  assert.equal(S.currentSpecCuration().autoTrigger, true);
});

test("✨ 维护规范：单行补充说明 + 启动只读梳理（三模式通用）、运行中禁用与错误码说明", async () => {
  resetAll();
  state.specCurationUi.statusLoadedFor = WORKSPACE.toLowerCase();
  C.renderProjectSpecsSection();
  assert.equal(els.get("btn-spec-curation-trigger").textContent, "✨ 维护规范");
  C.toggleSpecCurationTriggerBar();
  let html = panelHtml();
  assert.match(html, /<input type="text" class="text-input ps-curation-input" data-curation-input="note"[^>]*placeholder="可选：补充本次想沉淀或删改的规范方向"/);
  assert.match(html, /data-curation-trigger-submit[^>]*>启动只读梳理<\/button>/);
  assert.doesNotMatch(html, /<textarea\b/i);
  C.updateSpecCurationDraft("note", "  沉淀派发总闸  ");
  rpcHandler = (method, params) => ({ ok: true, taskId: "task_1", threadId: "thr_cur", runId: "run_1", status: "running", workspace: WORKSPACE,
    curation: curation({ running: true, activeThreadId: "thr_cur", activeRunId: "run_1" }), echo: params });
  assert.equal(await C.submitSpecCurationTrigger(), true);
  assert.deepEqual(rpcLog.at(-1), { method: "specCuration", params: { conversationId: "conv-curator", workspace: WORKSPACE, action: "trigger", cwd: WORKSPACE, note: "沉淀派发总闸" } });
  assert.deepEqual([state.specCurationUi.note, state.specCurationUi.triggerOpen], ["", false]);
  C.renderProjectSpecsSection();
  const btn = els.get("btn-spec-curation-trigger");
  assert.deepEqual([btn.textContent, btn.disabled], ["梳理中…", true]);
  assert.match(els.get("spec-curation-panel").innerHTML, /data-curation-running/);
  assert.equal(await C.submitSpecCurationTrigger(), false, "运行中不重复触发");

  // 已有维护官在跑：结构化错误码 → 中文说明并补拉状态
  S.applySpecCurationPayload(curation());
  rpcHandler = (method, params) => (params.action === "trigger" ? { error: { code: "CURATOR_ALREADY_RUNNING", message: "busy" } } : { curation: curation({ running: true }) });
  assert.equal(await C.submitSpecCurationTrigger(), false);
  assert.ok(toasts.some((t) => /本项目已有维护官在梳理中/.test(t)));
  // 维护组为空：本地拦截
  S.applySpecCurationPayload(curation());
  state.modeProfiles.complex.curator = { enabledKeys: [], preferredKey: null };
  rpcLog.length = 0;
  assert.equal(await C.submitSpecCurationTrigger(), false);
  assert.equal(rpcLog.length, 0);

  // 自愈兜底：快照仍显示梳理中但维护官线程已完结 → 补拉一次 status（等上一步的在途补拉收尾）
  await new Promise((r) => nativeSetTimeout(r, 0));
  state.modeProfiles.complex.curator = structuredClone(S.DEFAULT_MODE_PROFILES.complex.curator);
  S.applySpecCurationPayload(curation({ running: true, activeThreadId: "thr_cur", activeRunId: "run_9" }));
  state.threadsMap.set("thr_cur", { id: "thr_cur", status: "completed", updatedAt: 1 });
  rpcLog.length = 0;
  rpcHandler = () => ({ curation: curation({ pendingProposal: proposal() }) });
  C.renderSpecCurationSection();
  C.renderSpecCurationSection();
  await new Promise((r) => nativeSetTimeout(r, 0));
  assert.deepEqual(methods(), ["specCuration:status"]);
  assert.equal(S.currentSpecCuration().pendingProposal.id, "sprop_1");
  state.threadsMap.delete("thr_cur");
});

test("整组提案确认卡：四要素直出、Diff / 新正文折叠、预检失败禁用确认、三态 RPC 参数与零 textarea", async () => {
  resetAll();
  S.applySpecCurationPayload(curation({ pendingProposal: proposal({ preflightOk: false, preflightIssues: ["正文超过 2560 B"], changes: [{ ...proposal().changes[0], preflightOk: false, preflightIssues: ["tests: 指向的测试不存在"] }] }) }));
  let html = panelHtml();
  assert.match(html, /data-spec-proposal="sprop_1"/);
  assert.match(html, /data-curation-preflight="bad">预检未通过/);
  assert.match(html, /<button type="button" class="ghost-xs-btn is-accent" data-curation-confirm="sprop_1"[^>]* disabled/);
  assert.match(html, /正文超过 2560 B[\s\S]*tests: 指向的测试不存在/);
  rpcLog.length = 0;
  assert.equal(await C.confirmSpecProposal("sprop_1"), false);
  assert.equal(rpcLog.length, 0, "预检未通过不发 confirm");
  // 解析失败 / 空变更集同样拉低 preflightOk
  assert.equal(S.normalizeSpecProposal({ id: "x", preflightOk: true, changes: [] }).preflightOk, false);
  assert.equal(S.normalizeSpecProposal({ id: "x", preflightOk: true, parseError: "bad json", changes: proposal().changes }).preflightOk, false);

  S.applySpecCurationPayload(curation({ pendingProposal: proposal() }));
  html = panelHtml();
  assert.match(html, /data-curation-preflight="ok">预检通过/);
  assert.match(html, /2 处变更 · 手动触发/);
  assert.match(html, /合并派发规则 &lt;script&gt;x&lt;\/script&gt;/, "动态文案转义");
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /<span class="ps-curation-op is-update">修改<\/span>\s*<code class="ps-curation-path"[^>]*>\.agent-tower\/spec\/01-business\/orchestration-modes\.md<\/code>\s*<span class="spec-meta-faint">正文 [^<]+<\/span>/);
  assert.match(html, /<span class="ps-curation-op is-delete">删除<\/span>/);
  for (const label of ["为什么改", "具体改了什么", "合并 \/ 删减的旧话", "影响模块与守护测试"]) assert.match(html, new RegExp(`<dt>${label}</dt><dd>`));
  assert.match(html, /<details class="ps-curation-details" data-curation-details="diff:0"><summary>查看 Diff<\/summary><pre class="ps-curation-pre">-旧\n\+新<\/pre><\/details>/);
  assert.match(html, /data-curation-details="content:0"><summary>查看完整新内容/);
  assert.doesNotMatch(html, /data-curation-details="content:1"/, "删除项不展示新内容");
  assert.match(html, /data-curation-confirm="sprop_1" data-fk="curation:confirm" title/);
  assert.doesNotMatch(html, /data-curation-confirm="sprop_1"[^>]* disabled/);
  C.setSpecCurationDetailOpen("diff:0", true);
  assert.match(panelHtml(), /data-curation-details="diff:0" open>/, "折叠展开态跨重绘保持");

  // 打回：修改建议输入框默认常驻直出（无需二次点开）；意见为空本地拦截并聚焦；填写后 revise → 旧卡移除、梳理中
  html = panelHtml();
  assert.match(html, /<label class="pool-field-lbl" for="inp-curation-feedback-sprop_1">修改建议<\/label>/);
  assert.match(html, /<input type="text" class="text-input ps-curation-input" data-curation-input="feedback"/);
  assert.match(html, /data-curation-revise-submit="sprop_1"[^>]*>按意见打回重拟<\/button>/);
  assert.doesNotMatch(html, /<textarea\b/i);
  rpcLog.length = 0;
  assert.equal(await C.submitSpecProposalRevise("sprop_1"), false);
  assert.equal(rpcLog.length, 0);
  assert.match(toasts.at(-1), /请先填写打回修改意见/);
  C.updateSpecCurationDraft("feedback", "两条合并成一篇");
  rpcHandler = () => ({ ok: true, supersededProposalId: "sprop_1", threadId: "thr_cur", runId: "run_2", curation: curation({ running: true, activeThreadId: "thr_cur", activeRunId: "run_2" }) });
  assert.equal(await C.submitSpecProposalRevise("sprop_1"), true);
  assert.deepEqual(rpcLog.at(-1).params, { conversationId: "conv-curator", workspace: WORKSPACE, action: "revise", proposalId: "sprop_1", feedback: "两条合并成一篇", cwd: WORKSPACE });
  assert.equal(S.currentSpecCuration().pendingProposal, null);
  assert.deepEqual([state.specCurationUi.reviseOpen, state.specCurationUi.feedback], [false, ""]);

  // 放弃：二次确认后才 dismiss
  S.applySpecCurationPayload(curation({ pendingProposal: proposal({ id: "sprop_2" }) }));
  rpcLog.length = 0;
  rpcHandler = () => ({ ok: true, proposal: { id: "sprop_2", status: "dismissed" }, curation: curation() });
  assert.equal(await C.dismissSpecProposal("sprop_2"), false);
  assert.equal(rpcLog.length, 0);
  assert.match(panelHtml(), /data-curation-dismiss="sprop_2"[^>]*>确认放弃？/);
  assert.equal(await C.dismissSpecProposal("sprop_2"), true);
  assert.deepEqual(rpcLog.at(-1).params, { conversationId: "conv-curator", workspace: WORKSPACE, action: "dismiss", proposalId: "sprop_2", cwd: WORKSPACE });
  assert.equal(S.currentSpecCuration().pendingProposal, null);

  // 确认：整组 confirm → 刷新项目规范列表；CAS 冲突给出说明并补拉状态
  S.applySpecCurationPayload(curation({ pendingProposal: proposal({ id: "sprop_3" }) }));
  rpcLog.length = 0;
  rpcHandler = (method) => (method === "listProjectSpecs" ? { workspace: WORKSPACE, specs: [], pluginSpecs: [], counts: {}, curation: curation() } : { ok: true, status: "applied", curation: curation() });
  assert.equal(await C.confirmSpecProposal("sprop_3"), true);
  assert.deepEqual(rpcLog[0], { method: "specCuration", params: { conversationId: "conv-curator", workspace: WORKSPACE, action: "confirm", proposalId: "sprop_3", cwd: WORKSPACE } });
  assert.deepEqual(methods(), ["specCuration:confirm", "listProjectSpecs"]);
  assert.match(toasts.join("|"), /已确认更新 2 处项目规范/);
  S.applySpecCurationPayload(curation({ pendingProposal: proposal({ id: "sprop_4" }) }));
  rpcHandler = (method, params) => (params.action === "confirm" ? { error: { code: "SPEC_PROPOSAL_CONFLICT", message: "conflict" } } : { curation: curation() });
  assert.equal(await C.confirmSpecProposal("sprop_4"), false);
  assert.match(toasts.join("|"), /基线校验不一致/);
  // 过期 proposalId 不发请求
  rpcLog.length = 0;
  assert.equal(await C.confirmSpecProposal("sprop_old"), false);
  assert.equal(rpcLog.length, 0);
});

test("待办提醒一键定位、维护组卡头提示与静态契约（23 模块、零 textarea、config-view 不引 nav.js）", () => {
  resetAll();
  M.renderSpecCurationReminder();
  assert.equal(els.get("spec-curation-reminder").hidden, true);
  S.applySpecCurationPayload(curation({ pendingProposal: proposal() }));
  M.renderSpecCurationReminder();
  assert.equal(els.get("spec-curation-reminder").hidden, false);
  assert.match(els.get("spec-curation-reminder").innerHTML, /data-goto-spec-proposal>📝 规范维护提案待确认 · 2 处变更/);
  state.specCurationUi.statusLoadedFor = WORKSPACE.toLowerCase();
  assert.match(gridHtml(), /class="pool-curation-pending" data-goto-spec-proposal/);

  const read = (...p) => fs.readFileSync(path.join(studioDir, ...p), "utf8");
  assert.equal(fs.readdirSync(uiDir).filter((f) => f.endsWith(".js")).length, 23);
  const cfg = read("ui", "config-view.js");
  assert.doesNotMatch(cfg, /import[^;]*from ['"]\.\/nav\.js['"]/);
  const curationBlock = cfg.slice(cfg.indexOf("12. v0.2.11 专职规范维护官"));
  assert.doesNotMatch(curationBlock.replace(/严禁 <textarea>/g, ""), /<textarea/i);
  assert.doesNotMatch(cfg, /toggleModeStage\([^)]*curator/);
  const events = read("ui", "events.js");
  assert.match(events, /\[data-curation-auto-toggle\][\s\S]*toggleSpecCurationAuto/);
  assert.match(events, /btn-spec-curation-auto[\s\S]*toggleSpecCurationAuto/);
  assert.match(events, /btn-spec-curation-trigger[\s\S]*toggleSpecCurationTriggerBar/);
  assert.match(events, /\[data-curation-cancel-ticket\][\s\S]*cancelSpecCurationTicket/);
  const css = read("styles.css");
  const curationCss = css.slice(css.indexOf("v0.2.11 专职规范维护官"));
  assert.doesNotMatch(curationCss, /var\(--(?!sw-|r-|text-)/, "新样式仅用内部 --sw-* 色板");
  for (const sel of [".pool-curator-row", ".ps-curation-head", ".ps-curation-card", ".ps-curation-inline", ".ps-curation-pre", ".ps-curation-status--row"]) assert.ok(curationCss.includes(sel), sel);
  assert.match(curationCss, /\.ps-curation-head \{[^}]*flex-wrap: wrap;[^}]*min-width: 0;/);
  assert.match(curationCss, /\.ps-curation-pre \{[^}]*white-space: pre-wrap;/);
});

test("服务端 invalid / conflict 提案（pendingProposal 为空）仍展示卡片供打回或放弃，且未绑定工作区零跨项目串台", async () => {
  resetAll();
  // 1) 真实服务端结构：预检未通过 / 解析失败时 pendingProposal=null，记录位于 recentProposals[0] (status=invalid)
  const invalidProp = proposal({ id: "sprop_inv", status: "invalid", preflightOk: false, parseError: "代码块格式错误", updatedAt: 200 });
  S.applySpecCurationPayload(curation({ pendingProposal: null, recentProposals: [invalidProp] }));
  let html = panelHtml();
  assert.match(html, /data-spec-proposal="sprop_inv"/);
  assert.match(html, /data-curation-preflight="bad">预检未通过/);
  assert.match(html, /data-curation-confirm="sprop_inv"[^>]* disabled/);
  M.renderSpecCurationReminder();
  assert.match(els.get("spec-curation-reminder").innerHTML, /（预检未通过）/);
  C.toggleSpecProposalRevise(true);
  C.updateSpecCurationDraft("feedback", "按 JSON 契约重输出");
  rpcLog.length = 0;
  rpcHandler = () => ({ ok: true, supersededProposalId: "sprop_inv", threadId: "thr_cur", runId: "run_inv2", curation: curation({ running: true, activeThreadId: "thr_cur", activeRunId: "run_inv2" }) });
  assert.equal(await C.submitSpecProposalRevise("sprop_inv"), true);
  assert.equal(rpcLog.at(-1).params.action, "revise");

  // 2) CAS 基线冲突：recentProposals[0].status === 'conflict'（即便原 preflightOk=true 也严禁确认落盘，可放弃）
  const conflictProp = proposal({ id: "sprop_conf", status: "conflict", preflightOk: true, updatedAt: 300 });
  S.applySpecCurationPayload(curation({ pendingProposal: null, recentProposals: [conflictProp] }));
  html = panelHtml();
  assert.match(html, /data-curation-preflight="conflict">基线冲突/);
  assert.match(html, /data-curation-confirm="sprop_conf"[^>]* disabled/);
  M.renderSpecCurationReminder();
  assert.match(els.get("spec-curation-reminder").innerHTML, /（基线冲突）/);
  rpcLog.length = 0;
  assert.equal(await C.confirmSpecProposal("sprop_conf"), false);
  assert.equal(rpcLog.length, 0);
  // 后续出现更新的 no_change（completedAt=500）后，旧 conflict 卡自动收起并展示无需改动结论
  S.applySpecCurationPayload(curation({ pendingProposal: null, recentProposals: [conflictProp], lastNoChange: { reason: "已同步", completedAt: 500 } }));
  assert.equal(S.actionableSpecProposal(), null);
  assert.match(panelHtml(), /data-curation-nochange/);

  // 3) 空工作区 / 未绑定对话：拒绝吸收其他项目的 spec_curation_updated，且旧项目状态不跨会话残留
  state.workspace = "";
  assert.equal(S.currentSpecCuration().autoTrigger, false);
  assert.equal(S.applySpecCurationPayload({ workspace: "F:/other-proj", autoTrigger: true, pendingProposal: proposal({ id: "sprop_leak" }) }), false);
  assert.equal(S.currentSpecCuration().pendingProposal, null);
  state.workspace = WORKSPACE;
  S.applySpecCurationPayload(curation({ autoTrigger: true, pendingProposal: proposal({ id: "sprop_ok" }) }));
  state.conversationUnbound = true;
  assert.equal(S.currentSpecCuration().autoTrigger, false);
  assert.equal(S.currentSpecCuration().pendingProposal, null);
});

test("项目规范顶栏：按项目独立设置单篇与总上限（已用展示、单篇调高联动总上限、非法值拦截回滚与 setLimits 刷新）", async () => {
  resetAll();
  state.projectSpecs.loadedForWorkspace = `${S.getEffectiveConversationId()}::${WORKSPACE.toLowerCase()}`;
  state.projectSpecs.data = { workspace: WORKSPACE, totalProjectBytes: 15360, specs: [], pluginSpecs: [], counts: {}, warnings: [] };
  C.renderProjectSpecsSection();
  assert.equal(els.get("inp-spec-single-kb").value, "2");
  assert.equal(els.get("inp-spec-total-kb").value, "16");
  assert.equal(els.get("spec-quota-used").textContent, "已用 15 KB");
  assert.equal(els.get("spec-quota-used").hidden, false);

  // 非法输入或手动把总上限调低于单篇 2 倍 -> 本地拦截并恢复原值，不发 RPC
  rpcLog.length = 0;
  assert.equal(await C.saveSpecCurationLimits("single", "0", "16"), false);
  assert.match(toasts.at(-1), /1～8 KB/);
  assert.equal(els.get("inp-spec-single-kb").value, "2");
  assert.equal(await C.saveSpecCurationLimits("total", "4", "6"), false);
  assert.match(toasts.at(-1), /8～128 KB/);
  S.applySpecCurationPayload(curation({ singleMaxKb: 5, totalMaxKb: 16 }));
  assert.equal(await C.saveSpecCurationLimits("total", "5", "8"), false);
  assert.match(toasts.at(-1), /2 倍/);
  assert.equal(rpcLog.length, 0);

  // 调高单篇至 6 KB（原总上限 8 KB < 12 KB）-> 自动联动抬升总上限至 12 KB 并调 setLimits + listProjectSpecs
  S.applySpecCurationPayload(curation({ singleMaxKb: 2, totalMaxKb: 8 }));
  rpcHandler = (method, params) => (method === "listProjectSpecs"
    ? { workspace: WORKSPACE, totalProjectBytes: 15360, specs: [], pluginSpecs: [], counts: {}, curation: curation({ singleMaxKb: 6, totalMaxKb: 12 }) }
    : { ok: true, workspace: WORKSPACE, singleMaxKb: params.singleMaxKb, totalMaxKb: params.totalMaxKb, curation: curation({ singleMaxKb: params.singleMaxKb, totalMaxKb: params.totalMaxKb }) });
  assert.equal(await C.saveSpecCurationLimits("single", "6", "8"), true);
  assert.deepEqual(rpcLog[0], { method: "specCuration", params: { conversationId: "conv-curator", workspace: WORKSPACE, cwd: WORKSPACE, action: "setLimits", singleMaxKb: 6, totalMaxKb: 12 } });
  assert.deepEqual(methods(), ["specCuration:setLimits", "listProjectSpecs"]);
  assert.deepEqual([S.currentSpecCuration().singleMaxKb, S.currentSpecCuration().totalMaxKb], [6, 12]);
  assert.equal(els.get("spec-quota-used").classList.contains("is-over"), true, "15 KB > 12 KB 标红提示");
});

test("原生维护票据代派（trigger / revise）、剪贴板降级、awaitingHost 等待与 cancelTicket 及 host_main 提案来源", async () => {
  resetAll();
  const sentMessages = [];
  const copiedTexts = [];
  const prevAgent = globalThis.window.sidecar.agent;
  const prevClipboardDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    // 1) 宿主内 trigger 返回 hostActions → 自动经 window.sidecar.agent.sendMessage 推入主对话，并进入 awaitingHost 等待态
    globalThis.window.sidecar.agent = {
      sendMessage: async (msg, convId) => { sentMessages.push({ msg, convId }); },
    };
    rpcHandler = (_method, params) => {
      if (params.action === "trigger") {
        return {
          ok: true,
          status: "waiting_host_dispatch",
          handoffId: "hnd_cur_1",
          runId: "run_cur_1",
          hostActions: [{ hostPrompt: "[AgentTower Curation Ticket #hnd_cur_1] 请启动原生规范维护" }],
          curation: curation({ running: true, awaitingHost: true, activeHandoffId: "hnd_cur_1", activeExecutorKind: "antigravity_subagent", activeRunId: "run_cur_1" }),
        };
      }
      if (params.action === "cancelTicket") {
        return { ok: true, workspace: WORKSPACE, curation: curation({ running: false, awaitingHost: false, activeHandoffId: null, activeExecutorKind: null }) };
      }
      return {};
    };
    assert.equal(await C.submitSpecCurationTrigger(), true);
    assert.equal(sentMessages.length, 1);
    assert.deepEqual(sentMessages[0], { msg: "[AgentTower Curation Ticket #hnd_cur_1] 请启动原生规范维护", convId: "conv-curator" });
    assert.match(toasts.at(-1), /已发送至当前主对话启动只读梳理/);
    assert.deepEqual([S.currentSpecCuration().awaitingHost, S.currentSpecCuration().activeHandoffId, S.currentSpecCuration().activeExecutorKind], [true, "hnd_cur_1", "antigravity_subagent"]);

    C.renderSpecCurationSection();
    assert.equal(els.get("btn-spec-curation-trigger").textContent, "等待宿主…");
    assert.equal(els.get("btn-spec-curation-trigger").disabled, true);
    const waitHtml = els.get("spec-curation-panel").innerHTML;
    assert.match(waitHtml, /role="status" data-curation-awaiting-host/);
    assert.match(waitHtml, /⏳ 等待宿主执行维护票据…/);
    assert.match(waitHtml, /<button type="button" class="ghost-xs-btn" data-curation-cancel-ticket data-fk="curation:cancel-ticket">取消等待<\/button>/);

    // 2) cancelSpecCurationTicket → 调用 action: 'cancelTicket' 并释放等待态
    rpcLog.length = 0;
    assert.equal(await C.cancelSpecCurationTicket(), true);
    assert.deepEqual(rpcLog.at(-1), { method: "specCuration", params: { conversationId: "conv-curator", workspace: WORKSPACE, action: "cancelTicket", cwd: WORKSPACE, runId: "run_cur_1" } });
    assert.equal(S.currentSpecCuration().awaitingHost, false);
    assert.equal(S.currentSpecCuration().running, false);
    C.renderSpecCurationSection();
    assert.equal(els.get("btn-spec-curation-trigger").textContent, "✨ 维护规范");
    assert.doesNotMatch(els.get("spec-curation-panel").innerHTML, /data-curation-cancel-ticket/);
    // 非 awaitingHost 状态再调 cancelSpecCurationTicket 不发 RPC
    const beforeNoop = rpcLog.length;
    assert.equal(await C.cancelSpecCurationTicket(), false);
    assert.equal(rpcLog.length, beforeNoop);

    S.applySpecCurationPayload(curation({ running: true, activeExecutorKind: "host_main", activeRunId: "run_host" }));
    assert.match(panelHtml(), /data-curation-cancel-ticket/);
    rpcHandler = () => ({ cancelled: false, curation: curation() });
    assert.equal(await C.cancelSpecCurationTicket(), false);
    assert.doesNotMatch(toasts.at(-1), /已取消/);

    // 3) host_main 提案来源展示 + 独立网页降级复制（revise 返回 hostActions 时无 sidecar.agent → 复制到剪贴板）
    S.applySpecCurationPayload(curation({ pendingProposal: proposal({ id: "sprop_host", triggerSource: "host_main", executorKind: "host_main" }) }));
    const hostCard = panelHtml();
    assert.match(hostCard, /2 处变更 · 主会话提案/);
    assert.equal(S.currentSpecCuration().pendingProposal.executorKind, "host_main");

    delete globalThis.window.sidecar.agent;
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: async (text) => { copiedTexts.push(text); } } },
    });
    C.toggleSpecProposalRevise(true);
    C.updateSpecCurationDraft("feedback", "请精简第 2 条");
    rpcHandler = (_method, params) => (params.action === "revise" ? {
      ok: true,
      status: "waiting_host_dispatch",
      handoffId: "hnd_rev_2",
      runId: "run_rev_2",
      hostActions: [{ hostPrompt: "[AgentTower Curation Ticket #hnd_rev_2] 请按意见重拟：请精简第 2 条" }],
      curation: curation({ running: true, awaitingHost: true, activeHandoffId: "hnd_rev_2", activeExecutorKind: "host_main", activeRunId: "run_rev_2" }),
    } : {});
    assert.equal(await C.submitSpecProposalRevise("sprop_host"), true);
    assert.equal(copiedTexts.length, 1);
    assert.match(copiedTexts[0], /hnd_rev_2/);
    assert.match(toasts.at(-1), /已复制重拟维护指令/);
    assert.equal(S.currentSpecCuration().awaitingHost, true);
    assert.equal(S.currentSpecCuration().activeExecutorKind, "host_main");
  } finally {
    if (prevAgent === undefined) delete globalThis.window.sidecar.agent;
    else globalThis.window.sidecar.agent = prevAgent;
    if (prevClipboardDesc) Object.defineProperty(globalThis, "navigator", prevClipboardDesc);
    else delete globalThis.navigator;
  }
});

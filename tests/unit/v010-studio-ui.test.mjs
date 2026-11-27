import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../helpers/sandbox.mjs";

// v0.1.0 Track B → v0.1.1：380px 顶栏三档模式胶囊 + 三组弹性成员池 + 分模式阵容 modeProfiles 单层勾选 + 动态预设打通。
// ui/*.js 顶层零副作用：注入最小 window / document 桩后可在 Node 中直接驱动真实的保存队列、冲突重基与模式切换回滚。
const studioDir = path.join(repoRoot, "sidecars", "studio");
const read = (...parts) => fs.readFileSync(path.join(studioDir, ...parts), "utf8");
const html = read("index.html");
const css = read("styles.css");
const uiFiles = fs.readdirSync(path.join(studioDir, "ui")).filter((f) => f.endsWith(".js")).sort();
const js = ["app.js", ...uiFiles.map((f) => `ui/${f}`)].map((f) => read(f)).join("\n");

const toasts = [];
const rpcLog = [];
let rpcHandler = () => ({ result: {} });
const store = new Map();
globalThis.location = { pathname: "/", search: "" };
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.requestAnimationFrame = () => 0;
globalThis.document = {
  activeElement: null,
  getElementById: (id) => (id === "toast-container" ? { appendChild: (el) => toasts.push(el.textContent) } : null),
  querySelector: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ className: "", textContent: "", remove() {} }),
};
globalThis.window = {
  sidecar: {
    conversationId: "conv-1",
    fetch: async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      rpcLog.push({ method, params });
      const data = await rpcHandler(method, params);
      return { ok: data?.ok !== false, status: data?.ok === false ? 409 : 200, json: async () => data };
    },
  },
};
const mod = (f) => import(pathToFileURL(path.join(studioDir, "ui", f)).href);
const S = await mod("state.js");
const P = await mod("presets.js");
const stream = await mod("stream.js");
const composer = await mod("composer.js");
const widgets = await mod("widgets.js");
const normalize = await mod("normalize.js");
const net = await mod("net.js");
const cfg = await mod("config-view.js");
const { state } = S;

function resetPool() {
  state.presets = {};
  for (const slot of S.ROLE_SLOT_META) state.presets[slot.key] = S.seedPreset(slot.key);
  state.memberPool = structuredClone(S.DEFAULT_MEMBER_POOL);
  state.relayTargetPresetKey = S.DEFAULT_RELAY_TARGET;
  for (const k of ["dirtyPresets", "editedPresets", "committedPresets", "dirtyModeProfiles", "pendingDeletes", "pendingResets"]) state[k].clear();
  state.modeProfiles = structuredClone(S.DEFAULT_MODE_PROFILES);
  state.committedModeProfiles = null;
  state.committedModeProfilesFromServer = false;
  state.committedMemberPool = null;
  state.committedRelayTarget = "";
  state.editingModeProfile = "";
  state.serverPresetRevision = -1;
  state.deletedPresets = [];
  rpcLog.length = 0;
  toasts.length = 0;
  rpcHandler = () => ({ result: {} });
}
const saves = () => rpcLog.filter((r) => r.method === "saveSettings").map((r) => r.params);
const remoteSettings = (presetRevision, presets, extra = {}) => ({
  presetRevision, deletedPresets: [], relayTargetPresetKey: "executor_codex",
  memberPool: structuredClone(S.DEFAULT_MEMBER_POOL),
  presets: Object.fromEntries(S.ROLE_SLOT_META.map((s) => [s.key, { ...S.seedPreset(s.key), group: S.seedPreset(s.key).group }]).concat(Object.entries(presets))),
  ...extra,
});
const setMode = (orchestrationMode) => stream.applyConversationPolicyPayload({ rootConversationId: "conv-1", orchestrationMode, source: "explicit", policyRevision: 1 });

test("v0.1.1 静态契约：顶栏胶囊原位保留旧 ID、浮层 menu、23 个 ui 模块与 380px 宽度纪律", () => {
  assert.equal(uiFiles.length, 23, "ui/*.js 模块集合必须保持 23 个");
  assert.match(html, /<button type="button" id="btn-conv-dispatch-toggle" class="hdr-chip-btn mode-pill mode-direct dispatch-off" aria-haspopup="menu" aria-expanded="false" aria-controls="conv-mode-popover"/);
  assert.match(html, /aria-controls="conv-mode-popover" data-long-label="直出▾"/, "宽屏完整模式名走 data-long-label + ::after，不增加文本节点");
  assert.match(html, /<span id="conv-dispatch-icon" aria-hidden="true">⚡<\/span>\s*<span id="conv-dispatch-text">直出▾<\/span>\s*<\/button>/);
  assert.match(html, /<div id="conv-mode-popover" class="mode-popover" role="menu" aria-label="当前对话编排模式" hidden><\/div>/);
  assert.ok(html.indexOf('id="conv-mode-popover"') < html.indexOf('id="btn-theme-toggle"'), "浮层容器紧随胶囊，不新增顶栏横向控件");
  assert.doesNotMatch(html, /aria-pressed="(true|false)" title="当前对话允许调用子 Agent/, "胶囊为菜单按钮，不再是 aria-pressed 开关");
  for (const removed of ["council-include-claude", "council-preview-a", "council-preview-b", "council-preview-c"]) {
    assert.ok(!html.includes(removed) && !js.includes(removed), `仍残留硬编码军师节点 #${removed}`);
  }
  assert.match(html, /id="council-members-list"/);
  assert.match(html, /id="review-pool-hint" class="review-pool-hint" role="alert" hidden/);
  // CSS：胶囊 ≤ 96px、浮层 264px fixed、三档配色（已删除 simple / custom 死样式）、成员单行 36px、组头 32px
  assert.match(css, /\.hdr-chip-btn\.mode-pill \{[^}]*max-width: 96px;/);
  assert.match(css, /\.mode-popover \{[^}]*position: fixed;[^}]*width: 264px;[^}]*max-width: calc\(100vw - 16px\);/);
  for (const m of ["mode-direct", "mode-relay", "mode-complex"]) assert.ok(css.includes(`.hdr-chip-btn.mode-pill.${m} {`), `缺少胶囊配色 ${m}`);
  for (const m of ["mode-simple", "mode-custom"]) assert.ok(!css.includes(`.mode-pill.${m}`) && !css.includes(`.mode-pop-item.${m}`), `残留已废弃模式样式 ${m}`);
  assert.match(css, /\.pool-row \{[^}]*height: 36px;/);
  assert.match(css, /\.pool-group-head \{[^}]*height: 32px;/);
  for (const cls of [".mode-mini-badge.is-override", ".mode-mini-badge.is-degraded", ".pool-issue.is-blocking", '.save-pill[data-state="blocked"]', ".pool-check", ".pool-stage-switch", ".mode-flow", ".mode-scope-bar", ".mode-pop-roster"]) assert.ok(css.includes(cls), `styles.css 缺少 ${cls}`);
  // 旧版组选人策略下拉 / ⇄ 单目标 / 启停拨杆 / 临时点将放行全部移除
  for (const dead of ["data-pool-strategy", "pool-strategy-trg", "data-member-relay", "data-member-toggle", "allowDisabledPreset: true", "setPoolStrategy", "setRelayTargetMember", "markRelayTargetDirty", "markMemberPoolDirty", "memberPoolIssues"]) {
    assert.ok(!js.includes(dead), `仍残留旧版成员池逻辑：${dead}`);
  }
  for (const fnName of ["renderComposerState", "renderDispatchPresetChips", "openCouncilModal", "fillBatchTemplate", "mergeRemotePresets", "restorePresetDrafts", "markPresetDirty"]) {
    const start = js.search(new RegExp(`(?:export )?(?:async )?function ${fnName}\\(`));
    assert.ok(start >= 0, `缺少 ${fnName}`);
    const body = js.slice(start, start + js.slice(start + 1).search(/\n(?:export )?(?:async )?function /) + 1);
    assert.ok(!body.includes("ROLE_SLOT_META"), `${fnName} 仍遍历固定 ROLE_SLOT_META 槽位`);
  }
});

test("v0.1.1 新对话默认 direct：三档模式元数据、旧模式无感归一与旧布尔策略兼容映射", () => {
  assert.equal(state.defaultOrchestrationMode, "direct");
  assert.equal(state.defaultDispatchEnabled, false);
  assert.deepEqual([state.conversationPolicy.orchestrationMode, state.conversationPolicy.dispatchEnabled], ["direct", false]);
  assert.equal(S.currentOrchestrationMode(), "direct");
  assert.equal(stream.isConversationDispatchEnabled(), false);
  assert.equal(state.lastNonDirectMode, "relay", "非直出兜底默认 relay");
  assert.deepEqual(S.ORCHESTRATION_MODE_META.map((m) => `${m.id}|⚡ ${m.short}▾|${m.name}|${m.option}|${m.desc}|${m.cls}`), [
    "direct|⚡ 直出▾|直出模式|直出（默认关闭派发）|主会话独立直答 · 冻结并关闭子 Agent|mode-direct dispatch-off",
    "relay|⚡ 简单▾|简单模式|简单模式|确认意图 · 自选执行官单派/并派 · 主会话合并汇报|mode-relay dispatch-on",
    "complex|⚡ 复杂▾|复杂自定义|复杂自定义|军师/审核阶段可开关 · 三组角色自由勾选|mode-complex dispatch-on",
  ]);
  assert.equal(S.normalizeModeId("simple"), "relay");
  assert.equal(S.normalizeModeId("custom:release_flow"), "complex");
  assert.equal(S.normalizeModeId("custom:Bad Id"), "direct", "非法 custom 键回退 fallback");
  assert.equal(S.normalizeModeId("bogus", "relay"), "relay");
  assert.equal(S.orchestrationModeMeta("custom:release_flow").id, "complex");
  assert.equal(S.orchestrationModeMeta("simple").short, "简单");

  stream.applyConversationPolicyPayload({ rootConversationId: "conv-1", orchestrationMode: "simple", policyRevision: 3, source: "explicit" });
  assert.deepEqual([S.currentOrchestrationMode(), state.conversationPolicy.dispatchEnabled, state.lastNonDirectMode], ["relay", true, "relay"], "旧值 simple 无感归一为 relay");
  stream.applyConversationPolicyPayload({ orchestrationMode: "custom:release_flow" });
  assert.equal(S.currentOrchestrationMode(), "complex", "旧值 custom:* 无感归一为 complex");
  stream.applyConversationPolicyPayload({ dispatchEnabled: true });
  assert.equal(S.currentOrchestrationMode(), "complex", "旧布尔 true 保持当前非直出模式");
  stream.applyConversationPolicyPayload({ dispatchEnabled: false });
  assert.deepEqual([S.currentOrchestrationMode(), stream.isConversationDispatchEnabled()], ["direct", false]);
  stream.applyConversationPolicyPayload({ dispatchEnabled: true });
  assert.equal(S.currentOrchestrationMode(), "relay", "旧布尔从 direct 开启时映射为 relay");
  stream.applyConversationPolicyPayload({ defaultOrchestrationMode: "complex", orchestrationMode: "direct" });
  assert.deepEqual([state.defaultOrchestrationMode, state.defaultDispatchEnabled, S.currentOrchestrationMode()], ["complex", true, "direct"]);
  stream.applyConversationPolicyPayload({ defaultDispatchEnabled: true, defaultOrchestrationMode: "" });
  assert.equal(state.defaultOrchestrationMode, "relay", "旧版仅有 defaultDispatchEnabled:true 映射为 relay");
  stream.applyConversationPolicyPayload({ defaultDispatchEnabled: false });
  assert.equal(state.defaultOrchestrationMode, "direct", "旧版仅有 defaultDispatchEnabled:false 映射为 direct");
});

test("v0.1.1 模式切换：乐观更新 → setConversationPolicy；失败回滚并提示；新对话默认只发 defaultOrchestrationMode", async () => {
  resetPool();
  stream.applyConversationPolicyPayload({ rootConversationId: "conv-1", orchestrationMode: "direct", policyRevision: 4, source: "explicit" });
  let seenDuringRpc;
  rpcHandler = (method, params) => {
    seenDuringRpc = S.currentOrchestrationMode();
    return { result: { ok: true, conversationPolicy: { rootConversationId: "conv-1", orchestrationMode: params.orchestrationMode, policyRevision: 5, source: "explicit" },
      activeMode: { orchestrationMode: params.orchestrationMode, rosterRevision: 2 } } };
  };
  assert.equal(await composer.handleSetOrchestrationMode("complex"), true);
  assert.equal(seenDuringRpc, "complex", "请求在途时胶囊已乐观显示目标模式");
  assert.deepEqual(rpcLog.at(-1), { method: "setConversationPolicy", params: { conversationId: "conv-1", orchestrationMode: "complex", expectedPolicyRevision: 4, cancelRunning: false } });
  assert.deepEqual([S.currentOrchestrationMode(), state.conversationPolicy.policyRevision, state.activeMode.rosterRevision, state.modeSwitching], ["complex", 5, 2, null]);

  rpcHandler = () => ({ ok: false, error: "daemon offline", code: "POLICY_REVISION_CONFLICT" });
  assert.equal(await composer.handleSetOrchestrationMode("relay"), false);
  assert.deepEqual([S.currentOrchestrationMode(), state.modeSwitching, state.conversationPolicy.policyRevision], ["complex", null, 5], "失败回滚到切换前模式");
  assert.ok(toasts.at(-1).includes("对话模式已在其他窗口变更"));

  rpcHandler = () => ({ result: { cancelledCount: 2, conversationPolicy: { orchestrationMode: "direct", policyRevision: 6 } } });
  await composer.handleSetOrchestrationMode("direct", { cancelRunning: true });
  const brake = rpcLog.filter((r) => r.method === "setConversationPolicy").at(-1).params;
  assert.deepEqual([brake.orchestrationMode, brake.cancelRunning, S.currentOrchestrationMode()], ["direct", true, "direct"]);
  assert.equal(rpcLog.at(-1).method, "listThreads", "中断在途任务后刷新线程列表");
  rpcHandler = (method, params) => ({ result: { conversationPolicy: { orchestrationMode: params.orchestrationMode, policyRevision: 7 } } });
  await composer.handleToggleConversationDispatch(true);
  assert.equal(rpcLog.at(-1).params.orchestrationMode, "complex", "停发条 / 设置页开关：开启恢复上次的非直出模式");
  state.lastNonDirectMode = "simple";
  await composer.handleSetOrchestrationMode("direct");
  await composer.handleToggleConversationDispatch(true);
  assert.equal(rpcLog.at(-1).params.orchestrationMode, "relay", "存量 lastNonDirectMode=simple 恢复时归一为 relay");
  assert.equal(await composer.handleSetOrchestrationMode("simple"), true);
  assert.equal(rpcLog.at(-1).params.orchestrationMode, "relay", "旧模式 ID 发出前即归一");

  rpcHandler = (method, params) => ({ result: { defaultOrchestrationMode: params.defaultOrchestrationMode, defaultDispatchEnabled: true } });
  await composer.handleChangeDefaultOrchestrationMode("relay");
  assert.equal(rpcLog.at(-1).params.defaultOrchestrationMode, "relay");
  assert.equal(Object.hasOwn(rpcLog.at(-1).params, "orchestrationMode"), false);
  assert.deepEqual([state.defaultOrchestrationMode, S.currentOrchestrationMode()], ["relay", "relay"], "修改新对话默认不影响当前对话");
});

test("v0.1.1 动态成员池 + 阵容：远端合并含 custom_* 成员与 modeProfiles，派发池严锁当前模式勾选成员", () => {
  resetPool();
  P.mergeRemotePresets({ settings: remoteSettings(5, {
    custom_sec_reviewer: { key: "custom_sec_reviewer", label: "安全终审官", group: "reviewer", enabled: true, builtin: false, provider: "codex", model: "gpt-6.2-astra", effort: "high", permissionMode: "read-only", interactionMode: "default" },
  }, { modeProfiles: {
    relay: { executor: { enabledKeys: ["executor_codex", "executor_claude", "ghost_key"], preferredKey: "executor_codex" } },
    complex: {
      advisor: { stageEnabled: false, enabledKeys: ["advisor_kimi"] },
      executor: { enabledKeys: ["executor_kimi"], preferredKey: "executor_claude" },
      reviewer: { stageEnabled: true, enabledKeys: ["custom_sec_reviewer", "reviewer"], preferredKey: "custom_sec_reviewer" },
    },
  } }) });
  assert.equal(state.serverPresetRevision, 5);
  assert.deepEqual(S.listPoolMembers("reviewer").map((p) => p.key), ["reviewer", "custom_sec_reviewer"]);
  assert.deepEqual(state.modeProfiles.relay.executor, { enabledKeys: ["executor_codex", "executor_claude"], preferredKey: "executor_codex" }, "未知键被剔除");
  assert.equal(state.modeProfiles.complex.executor.preferredKey, "executor_kimi", "★ 不在勾选池内时回落首位");
  assert.ok(!S.listDispatchablePresets("complex").some((p) => p.key === "commander"), "commander 为宿主自身，不进入三组子 Agent 池");

  setMode("relay");
  assert.deepEqual(S.listDispatchablePresets().map((p) => p.key), ["executor_codex", "executor_claude"], "简单模式只列已勾选执行官");
  assert.deepEqual([S.activeGroupMembers("advisor").length, S.activeGroupMembers("reviewer").length], [0, 0], "简单模式无军师 / 审核阶段");
  assert.equal(S.preferredGroupPreset("executor").key, "executor_codex");
  assert.equal(S.modeRosterSummary("relay"), "已选执行官：Sol★ · Claude");
  assert.equal(S.modeRosterSummary("complex"), "军师 关 → 执行(1) → 审核 开(2)");
  assert.match(composer.stageGateMessage("advisor", "relay"), /简单模式不含军师会诊/);

  setMode("complex");
  assert.deepEqual(S.listDispatchablePresets().map((p) => p.key), ["executor_kimi", "reviewer", "custom_sec_reviewer"], "复杂模式军师阶段关闭时不列军师");
  assert.equal(composer.stageGateMessage("advisor", "complex"), "当前复杂模式已关闭军师阶段，可在配置页开启");
  assert.equal(composer.stageGateMessage("reviewer", "complex"), "");
  assert.equal(P.defaultReviewerPreset().key, "custom_sec_reviewer", "终审默认跟随复杂阵容审核阶段首选 ★");

  // 严锁勾选池：未勾选成员不以 presetKey 派发、不再附加停用成员放行标记
  const sol = { ...state.presets.executor_codex };
  assert.deepEqual(normalize.presetDispatchRoute("executor_codex", sol, { activePoolOnly: true }), { provider: "codex", model: "gpt-6.2-sol" }, "复杂阵容未勾选 Sol → 按自定义引擎派发");
  assert.deepEqual(normalize.presetDispatchRoute("executor_kimi", { ...state.presets.executor_kimi }, { activePoolOnly: true }), { presetKey: "executor_kimi" });
  state.presets.executor_kimi.enabled = false;
  assert.deepEqual(normalize.presetDispatchRoute("executor_kimi", { ...state.presets.executor_kimi }), { presetKey: "executor_kimi" }, "不再附加 allowDisabledPreset");

  // 直出模式（派发关闭）：派发面板按上次非直出模式展示
  setMode("direct");
  assert.equal(S.effectiveDispatchMode(), "complex");

  // 远端删除自定义成员后本地同步移除，并从阵容中剔除、修复 ★
  P.mergeRemotePresets({ settings: remoteSettings(6, {}, { deletedPresets: ["custom_sec_reviewer"] }) });
  assert.ok(!state.presets.custom_sec_reviewer);
  assert.deepEqual(state.deletedPresets, ["custom_sec_reviewer"]);
  assert.deepEqual(state.modeProfiles.complex.reviewer, { stageEnabled: true, enabledKeys: ["reviewer"], preferredKey: "reviewer" });
});

test("v0.1.1 存量迁移：远端尚无 modeProfiles 时由旧版启停 + 锁定 ★ + 翻译目标无感迁移", () => {
  resetPool();
  P.mergeRemotePresets({ settings: remoteSettings(7, {
    executor_hydrogen: { ...S.seedPreset("executor_hydrogen"), enabled: false },
    advisor_claude: { ...S.seedPreset("advisor_claude"), enabled: false },
  }, { relayTargetPresetKey: "executor_kimi", memberPool: { ...S.DEFAULT_MEMBER_POOL, executor: { strategy: "locked_default", defaultPresetKey: "executor_codex" } } }) });
  assert.deepEqual(state.modeProfiles.relay.executor, { enabledKeys: ["executor_kimi", "executor_codex", "executor_claude"], preferredKey: "executor_kimi" }, "翻译目标 ⇄ 迁为简单模式首选");
  assert.deepEqual(state.modeProfiles.complex.executor.preferredKey, "executor_codex", "锁定 ★ 迁为复杂阵容执行组首选");
  assert.deepEqual(state.modeProfiles.complex.advisor, { stageEnabled: true, enabledKeys: ["advisor_kimi", "advisor_codex"] });
  assert.equal(P.hasPendingPresetChanges(), false, "迁移只是本地基线，不主动写回");
  // 离线兜底：完全无输入时为默认结构
  assert.deepEqual(S.normalizeClientModeProfiles(null, null), S.DEFAULT_MODE_PROFILES);
  // 执行组被清空 → 至少保留 1 名
  assert.deepEqual(S.normalizeClientModeProfiles({ relay: { executor: { enabledKeys: [], preferredKey: "executor_codex" } } }, state.presets).relay.executor,
    { enabledKeys: ["executor_codex"], preferredKey: "executor_codex" });
  // activeMode.modeProfiles 仅在尚未收到 settings 阵容时兜底
  resetPool();
  P.applyActiveModePayload({ orchestrationMode: "relay", modeProfiles: { relay: { executor: { enabledKeys: ["executor_hydrogen"], preferredKey: "executor_hydrogen" } } } });
  assert.deepEqual(state.modeProfiles.relay.executor.enabledKeys, ["executor_hydrogen"]);
  P.mergeRemotePresets({ settings: remoteSettings(8, {}, { modeProfiles: { relay: { executor: { enabledKeys: ["executor_kimi"], preferredKey: "executor_kimi" } } } }) });
  P.applyActiveModePayload({ orchestrationMode: "relay", modeProfiles: { relay: { executor: { enabledKeys: ["executor_hydrogen"], preferredKey: "executor_hydrogen" } } } });
  assert.deepEqual(state.modeProfiles.relay.executor.enabledKeys, ["executor_kimi"], "settings.modeProfiles 才是阵容权威来源");
});

test("v0.1.1 单层勾选：执行组保护最后 1 名、★ 仅限已勾选、阶段开关保留勾选，草稿持久化 + 300ms 防抖合并保存", async () => {
  resetPool();
  store.clear();
  P.mergeRemotePresets({ settings: remoteSettings(10, {}, { modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES) }) });
  setMode("relay");
  assert.equal(cfg.editingModeProfile(), "relay", "首次进入配置页：非复杂模式默认编辑简单模式阵容");
  for (const k of ["executor_kimi", "executor_codex", "executor_hydrogen"]) cfg.toggleModeMember("relay", "executor", k);
  assert.deepEqual(state.modeProfiles.relay.executor.enabledKeys, ["executor_claude"]);
  cfg.toggleModeMember("relay", "executor", "executor_claude");
  assert.deepEqual(state.modeProfiles.relay.executor.enabledKeys, ["executor_claude"], "最后 1 名执行官不可取消");
  assert.equal(toasts.at(-1), "至少保留 1 名执行官");
  cfg.setModePreferred("relay", "executor", "executor_codex");
  assert.equal(state.modeProfiles.relay.executor.preferredKey, "executor_claude", "未勾选成员不可设为 ★");
  cfg.toggleModeMember("relay", "executor", "executor_codex");
  cfg.setModePreferred("relay", "executor", "executor_codex");
  assert.equal(state.modeProfiles.relay.executor.preferredKey, "executor_codex");

  cfg.toggleModeStage("complex", "advisor");
  for (const k of ["advisor_kimi", "advisor_codex", "advisor_claude"]) cfg.toggleModeMember("complex", "advisor", k);
  assert.deepEqual(state.modeProfiles.complex.advisor, { stageEnabled: false, enabledKeys: [] });
  assert.deepEqual(S.modeProfileIssues("complex"), [], "阶段关闭时不告警");
  cfg.toggleModeStage("complex", "advisor");
  assert.deepEqual(S.modeProfileIssues("complex").map((i) => [i.group, i.kind, i.blocking]), [["advisor", "stage_empty", false]], "阶段开启但勾选池为空 → 醒目内联告警（不阻断）");
  cfg.toggleModeMember("complex", "advisor", "advisor_codex");

  const draft = JSON.parse(store.get("at-preset-field-drafts:/"));
  assert.deepEqual(Object.keys(draft.__modeProfiles).sort(), ["complex", "relay"], "阵容修改纳入 sessionStorage 草稿");
  assert.deepEqual(draft.__modeProfiles.relay.executor, { enabledKeys: ["executor_claude", "executor_codex"], preferredKey: "executor_codex" });

  rpcHandler = (method, params) => ({ result: { settings: remoteSettings(11, {}, { modeProfiles: params.modeProfiles }) } });
  await P.saveAllRolePresets();
  assert.equal(saves().length, 1, "多次勾选合并为一次 saveSettings");
  assert.deepEqual(saves()[0], { conversationId: "conv-1", scope: "global", modeProfiles: {
    relay: { executor: { enabledKeys: ["executor_claude", "executor_codex"], preferredKey: "executor_codex" } },
    complex: {
      advisor: { stageEnabled: true, enabledKeys: ["advisor_codex"] },
      executor: { enabledKeys: ["executor_kimi", "executor_codex", "executor_claude", "executor_hydrogen"], preferredKey: "executor_claude" },
      reviewer: { stageEnabled: true, enabledKeys: ["reviewer"], preferredKey: "reviewer" },
      curator: { enabledKeys: ["curator_codex"], preferredKey: "curator_codex" },
    },
  }, expectedPresetRevision: 10 });
  assert.deepEqual([P.hasPendingPresetChanges(), state.serverPresetRevision, store.has("at-preset-field-drafts:/")], [false, 11, false]);

  // 草稿恢复（刷新面板后）：未保存的阵容修改按 "mode.group" 重新入队
  store.set("at-preset-field-drafts:/", JSON.stringify({ __modeProfiles: { relay: { executor: { enabledKeys: ["executor_hydrogen"], preferredKey: "executor_hydrogen" } } }, __memberPool: { executor: { strategy: "host_select_enabled" } } }));
  P.restorePresetDrafts();
  assert.deepEqual([state.modeProfiles.relay.executor.enabledKeys, [...state.dirtyModeProfiles.keys()]], [["executor_hydrogen"], ["relay.executor"]]);
  assert.equal(state.memberPool.executor.strategy, "locked_default", "v0.1.0 旧草稿 __memberPool 直接丢弃");
});

test("v0.1.1 多窗口 PRESET_REVISION_CONFLICT：成员字段与阵容 mode.group 粒度安全重基后重试", async () => {
  resetPool();
  P.mergeRemotePresets({ settings: remoteSettings(20, {}, { modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES) }) });
  state.presets.executor_kimi.isolation = "worktree";
  P.markPresetDirty("executor_kimi", ["isolation"]);
  state.presets.executor_codex.isolation = "worktree";
  P.markPresetDirty("executor_codex", ["isolation"]);
  state.presets.executor_hydrogen.label = "本地改名";
  P.markPresetDirty("executor_hydrogen", ["label", "title"]);
  cfg.toggleModeMember("relay", "executor", "executor_hydrogen"); // 本地改传话筒阵容
  cfg.toggleModeStage("complex", "reviewer"); // 本地关闭审核阶段（远端改的是军师组 → 不冲突）
  const remoteProfiles = structuredClone(S.DEFAULT_MODE_PROFILES);
  remoteProfiles.relay.executor = { enabledKeys: ["executor_kimi"], preferredKey: "executor_kimi" }; // 远端同改传话筒执行组 → 冲突
  remoteProfiles.complex.advisor.enabledKeys = ["advisor_kimi"];
  const remote = remoteSettings(21, {
    executor_kimi: { ...S.seedPreset("executor_kimi"), effort: "max" },
    executor_codex: { ...S.seedPreset("executor_codex"), isolation: "shared", effort: "low", model: "gpt-6.2-astra" },
    executor_hydrogen: { ...S.seedPreset("executor_hydrogen"), label: "远端改名" },
  }, { modeProfiles: remoteProfiles });
  remote.presets.executor_codex.isolation = "worktree";
  let calls = 0;
  rpcHandler = (method, params) => (++calls === 1 ? { ok: false, error: "conflict", code: "PRESET_REVISION_CONFLICT", details: { currentRevision: 21, settings: remote } } : { result: { settings: { ...remote, modeProfiles: params.modeProfiles, presetRevision: 22 } } });
  await P.saveAllRolePresets();
  const [first, retry] = saves();
  assert.equal(first.expectedPresetRevision, 20);
  assert.deepEqual(Object.keys(first.presets).sort(), ["executor_codex", "executor_hydrogen", "executor_kimi"]);
  assert.deepEqual([retry.expectedPresetRevision, retry.presets], [21, { executor_kimi: { isolation: "worktree" } }], "仅保留未冲突字段重试");
  assert.deepEqual(retry.modeProfiles.relay.executor, { enabledKeys: ["executor_kimi"], preferredKey: "executor_kimi" }, "同一 mode.group 冲突采用最新配置");
  assert.deepEqual(retry.modeProfiles.complex.advisor.enabledKeys, ["advisor_kimi"], "远端非冲突阵容并入");
  assert.equal(retry.modeProfiles.complex.reviewer.stageEnabled, false, "本地非冲突阵容修改保留重试");
  assert.equal(state.presets.executor_kimi.effort, "max", "远端非冲突字段并入本地");
  assert.equal(state.presets.executor_hydrogen.label, "远端改名", "同字段（显示名 + 标题联动）冲突采用最新配置");
  assert.ok(toasts.some((t) => t.includes("其他窗口已修改") && t.includes("远端改名") && t.includes("简单模式阵容·执行组")), "冲突需提示用户知晓");
  assert.deepEqual([P.hasPendingPresetChanges(), state.serverPresetRevision], [false, 22]);
});

test("v0.2.2 新增 / 删除：成员键无 custom_ 前缀，新成员自动勾选进当前编辑阵容并同次提交，任意成员均可删除并同步移出阵容", async () => {
  resetPool();
  P.mergeRemotePresets({ settings: remoteSettings(30, {}, { modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES) }) });
  assert.equal(P.suggestCustomPresetKey("Sec Reviewer", "reviewer"), "reviewer_sec_reviewer", "按组前缀生成语义化键，不再加 custom_");
  assert.equal(P.suggestCustomPresetKey("安全终审官", "reviewer"), "reviewer_member_1", "非 ASCII 名称回落 <group>_member_N");
  assert.equal(P.isValidCustomPresetKey("ab"), false, "长度不足 3");
  assert.equal(P.isValidCustomPresetKey("Custom_Sec"), false, "仅允许小写字母开头");
  assert.equal(P.isValidCustomPresetKey("review"), false, "系统保留词不可用");
  assert.equal(P.isValidCustomPresetKey("sec_reviewer"), true);
  state.editingModeProfile = "complex";
  state.presets[S.MEMBER_DRAFT_KEY] = { ...P.newCustomPresetBase("reviewer"), label: "Sec Reviewer" };
  P.markPresetDirty(S.MEMBER_DRAFT_KEY, ["label"]);
  assert.equal(P.hasPendingPresetChanges(), false, "草稿确认前不入保存队列");
  assert.ok(!S.listPoolMembers("reviewer").some((p) => p.key === S.MEMBER_DRAFT_KEY));
  P.commitMemberDraft("custom_sec_reviewer");
  await P.saveAllRolePresets();
  const createSave = saves().at(-1);
  const created = createSave.presets.custom_sec_reviewer;
  assert.deepEqual([created.key, created.label, created.group, created.builtin, created.enabled, created.role], ["custom_sec_reviewer", "Sec Reviewer", "reviewer", false, true, "review"]);
  assert.ok(created.provider && created.model && created.permissionMode);
  assert.deepEqual(createSave.modeProfiles.complex.reviewer.enabledKeys, ["reviewer", "custom_sec_reviewer"], "新成员与阵容勾选同一次 saveSettings 提交");
  assert.deepEqual(createSave.modeProfiles.relay.executor, S.DEFAULT_MODE_PROFILES.relay.executor, "不影响另一阵容");

  state.modeProfiles.complex.reviewer.preferredKey = "custom_sec_reviewer";
  P.queuePresetDelete("custom_sec_reviewer");
  assert.deepEqual(state.modeProfiles.complex.reviewer, { stageEnabled: true, enabledKeys: ["reviewer"], preferredKey: "reviewer" }, "删除即移出阵容并修复 ★");
  P.queuePresetDelete("executor_kimi");
  assert.ok(P.hasPendingPresetChanges(), "原默认成员同样可删除（全成员平权）");
  assert.equal(typeof P.queuePresetReset, "undefined", "已废除恢复默认黄金等级");
  await P.saveAllRolePresets();
  assert.deepEqual([saves().at(-1).deletePresets, saves().at(-1).resetPresets], [["custom_sec_reviewer", "executor_kimi"], undefined]);
  assert.deepEqual(saves().at(-1).modeProfiles.complex.reviewer.enabledKeys, ["reviewer"]);
  assert.ok(!saves().at(-1).modeProfiles.relay.executor.enabledKeys.includes("executor_kimi"));
  assert.ok(!state.presets.custom_sec_reviewer && state.deletedPresets.includes("custom_sec_reviewer"));
  assert.ok(!state.presets.executor_kimi && state.deletedPresets.includes("executor_kimi"));
});

test("v0.1.1 rpcCall 透传结构化错误码，徽标：历史线程本轮临时点将 / 主会话代审", async () => {
  rpcHandler = () => ({ ok: false, error: "locked", code: "LOCKED_DEFAULT_UNAVAILABLE", details: { group: "executor", defaultPresetKey: "executor_claude" } });
  await assert.rejects(net.rpcCall("saveSettings", {}), (err) => err.code === "LOCKED_DEFAULT_UNAVAILABLE" && err.details.group === "executor");
  rpcHandler = () => ({ ok: false, error: { message: "empty", code: "REVIEW_POOL_EMPTY", details: { group: "reviewer" } } });
  await assert.rejects(net.rpcCall("runCodeReview", {}), (err) => err.code === "REVIEW_POOL_EMPTY" && err.details.group === "reviewer");
  assert.match(net.describeRpcError({ code: "MODE_SINGLE_MEMBER_REQUIRED" }), /仅允许单线派发/);
  assert.equal(net.describeRpcError({ code: "UNKNOWN_X", message: "原始错误" }), "原始错误");

  assert.equal(widgets.renderThreadModeBadgesHtml({ meta: {}, recentRuns: [] }), "");
  assert.match(widgets.renderThreadModeBadgesHtml({ meta: { temporaryOverride: true } }), /class="mode-mini-badge is-override"[^>]*>本轮临时点将</);
  const degraded = widgets.renderThreadModeBadgesHtml({ meta: {}, activeRunId: "r2", recentRuns: [{ id: "r1", meta: {} }, { id: "r2", meta: { degradedReview: true } }] });
  assert.match(degraded, />主会话代审</);
  assert.doesNotMatch(degraded, /本轮临时点将/);
  for (const fn of ["renderBoardPostHtml", "renderMembersView", "renderMemberDrawer"]) {
    const start = js.search(new RegExp(`function ${fn}\\(`));
    assert.ok(start >= 0, `缺少 ${fn}`);
    assert.ok(js.slice(start, start + 6000).includes("renderThreadModeBadgesHtml(t)"), `${fn} 未渲染模式徽标`);
  }
  // 派发 / 会诊 / 终审入口不再展示「临时点将」诱导文案
  for (const fn of ["renderDispatchPresetChips", "renderReviewPoolHint", "openCouncilModal", "renderComposerState"]) {
    const start = js.search(new RegExp(`function ${fn}\\(`));
    const body = js.slice(start, start + js.slice(start + 1).search(/\n(?:export )?(?:async )?function /) + 1);
    assert.ok(!body.includes("临时点将") && !body.includes("已停用"), `${fn} 仍含临时点将 / 已停用诱导文案`);
  }
});

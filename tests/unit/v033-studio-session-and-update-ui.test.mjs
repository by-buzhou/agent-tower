import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { repoRoot } from "../helpers/sandbox.mjs";

const studioDir = path.join(repoRoot, "sidecars", "studio");
const uiDir = path.join(studioDir, "ui");
const read = (...parts) => fs.readFileSync(path.join(studioDir, ...parts), "utf8");
const ROOT = "conv-v033";
const A = "F:/proj-a";
const B = "F:/proj-b";

const cfgRaw = (workspace = A, extra = {}) => ({
  workspace,
  projectKey: workspace.toLowerCase(),
  rosterSource: "project",
  rosterCustomized: true,
  rosterRevision: 7,
  specEnabled: true,
  externalSessionMode: "inherit",
  externalSessionVisible: false,
  externalSessionCustomized: false,
  ...extra,
});

test("v0.3.3 Studio 静态契约：双层开关、更新卡片、唯一 ID、23 模块与安全样式", () => {
  const html = read("index.html");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, "DOM ID 必须全页唯一");
  assert.equal(fs.readdirSync(uiDir).filter((f) => f.endsWith(".js")).length, 23);
  for (const id of [
    "lbl-default-external-session", "default-external-session-save-status", "default-external-session-desc",
    "btn-default-external-session-visible", "system-update-section", "btn-auto-check-updates", "btn-check-updates-now",
    "btn-apply-system-update", "btn-cancel-system-update", "btn-rollback-system-update",
    "system-update-progress-wrap", "system-update-progress", "system-update-progress-meta", "system-update-result",
    "system-update-status-text", "system-update-notes", "link-system-update-release", "btn-dismiss-update",
    "topbar-update-badge", "lbl-project-external-session", "project-external-session-badge", "project-external-session-desc",
    "project-external-session-seg",
  ]) assert.ok(ids.includes(id), `缺少 #${id}`);
  assert.match(
    html,
    /<progress id="system-update-progress" class="system-update-progress" max="100" aria-labelledby="system-update-status-text"><\/progress>/,
    "<progress> 必须原生空体且无 tabindex",
  );
  assert.doesNotMatch(html, /<progress[^>]*tabindex=/i, "<progress> 严禁设置 tabindex");
  for (const id of ["btn-default-external-session-visible", "btn-auto-check-updates"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*role="switch"[^>]*aria-checked="(?:true|false)"[^>]*aria-labelledby="[^"]+"`));
  }
  assert.match(html, /id="project-external-session-seg"[^>]*role="radiogroup"[^>]*aria-labelledby="lbl-project-external-session"/);
  assert.deepEqual([...html.matchAll(/data-ext-session-mode="(inherit|hidden|visible)"/g)].map((m) => m[1]), ["inherit", "hidden", "visible"]);
  const desc = /id="default-external-session-desc"[^>]*>([^<]+)/.exec(html)?.[1] || "";
  assert.ok([...desc].length <= 18, "默认会话说明须不超过 18 字");
  assert.match(html, /id="link-system-update-release"[^>]*href="https:\/\/github\.com\/[^"]*"[^>]*rel="noopener noreferrer"/);
  assert.equal((html.match(/单次临时成员（不复用卡片且强制无痕）/g) || []).length, 2);
  const composerOptions = html.slice(html.indexOf('id="chk-fresh-context"') - 300, html.indexOf('id="comp-ephemeral-chk"') + 300);
  assert.doesNotMatch(composerOptions, /<label class="form-group"[^>]*>\s*<label/);

  const css = read("styles.css");
  const specAt = css.indexOf("v0.2.0 项目规范（Spec）");
  assert.ok(specAt > 0);
  const updateCssStart = css.indexOf("v0.3.3 外部会话双层开关与版本更新卡片");
  assert.ok(updateCssStart > 0 && updateCssStart < specAt);
  const updateCss = css.slice(updateCssStart, specAt);
  assert.match(updateCss, /\.system-update-progress\s*\{[^}]*appearance:\s*none;[^}]*border:\s*0 solid;[^}]*overflow:\s*clip;[^}]*container-type:\s*inline-size;/s);
  assert.equal((updateCss.match(/::-webkit-progress-value\b/g) || []).length, 1, "::-webkit-progress-value 只能出现一次");
  assert.equal((updateCss.match(/::-moz-progress-bar\b/g) || []).length, 1, "::-moz-progress-bar 只能出现一次");
  assert.doesNotMatch(updateCss, /::-webkit-progress-value\s*,\s*[^\n]*::-moz-progress-bar|::-moz-progress-bar\s*,\s*[^\n]*::-webkit-progress-value/, "WebKit 与 Moz 进度条伪元素严禁合并选择器");
  assert.match(updateCss, /@keyframes\s+system-update-progress-indeterminate\s*\{[\s\S]*?from,\s*to\s*\{[^}]*margin-right:\s*auto;[^}]*inline-size:\s*var\(--progress-bar-indeterminate-size\);[\s\S]*?translate:\s*100cqi;/);
  assert.match(updateCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*?--progress-bar-indeterminate-animation-duration:\s*10s;/);
  assert.doesNotMatch(updateCss, /animation:\s*none/, "indeterminate 进度条在 reduced-motion 下应放慢至 10s，严禁 animation: none");
  assert.doesNotMatch(css.slice(specAt), /var\(--(?!sw-|r-|text-)/);

  const config = read("ui", "config-view.js");
  assert.match(config, /notes\.textContent = text/);
  assert.doesNotMatch(config, /notes\.innerHTML|releaseNotes[^\n]*innerHTML|innerHTML[^\n]*releaseNotes|resultEl\.innerHTML|progressMeta\.innerHTML/);
  const events = read("ui", "events.js");
  for (const id of ["btn-apply-system-update", "btn-cancel-system-update", "btn-rollback-system-update"]) {
    assert.ok(events.includes(id), `events.js 未绑定 #${id}`);
  }
  const composer = read("ui", "composer.js");
  const modals = read("ui", "modals.js");
  for (const source of [composer, modals]) assert.doesNotMatch(source, /ephemeral\s*:\s*false/);
  assert.equal((modals.match(/\.\.\.\(ephemeral \? \{ ephemeral: true \} : \{\}\)/g) || []).length, 4);
  assert.ok(read("ui", "normalize.js").includes("system_update_changed"));
});

const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const timer = nativeSetTimeout(fn, ms, ...args);
  timer?.unref?.();
  return timer;
};

function makeEl(id = "", dataset = {}) {
  const classes = new Set();
  return {
    id,
    innerHTML: "",
    textContent: "",
    hidden: false,
    disabled: false,
    checked: false,
    value: "",
    title: "",
    href: "",
    className: "",
    tabIndex: 0,
    attrs: {},
    dataset,
    style: {},
    children: [],
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
      toggle: (name, on = !classes.has(name)) => (on ? classes.add(name) : classes.delete(name), on),
    },
    setAttribute(name, value) { this.attrs[name] = String(value); },
    getAttribute(name) { return this.attrs[name] ?? null; },
    removeAttribute(name) { delete this.attrs[name]; },
    appendChild(child) { this.children.push(child); },
    remove() {},
    contains: () => false,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    focus() { globalThis.document.activeElement = this; },
    scrollIntoView() {},
  };
}

const els = new Map();
const toasts = [];
const rpcLog = [];
let rpcHandler = () => ({});
const byId = (id) => {
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id);
};
const projectRadios = ["inherit", "hidden", "visible"].map((mode) => makeEl(`ext-${mode}`, { extSessionMode: mode }));
const store = new Map();
globalThis.location = { pathname: "/", search: "" };
globalThis.sessionStorage = { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: (key) => store.delete(key) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.CSS = { escape: (value) => String(value) };
globalThis.document = {
  activeElement: null,
  documentElement: { dataset: {} },
  body: {},
  getElementById: byId,
  querySelector: () => null,
  querySelectorAll: (selector) => selector.includes("[data-ext-session-mode]") ? projectRadios : [],
  createElement: () => makeEl(),
  addEventListener() {},
};
const toastBox = byId("toast-container");
toastBox.appendChild = (el) => toasts.push({ message: el.textContent, kind: el.className });
globalThis.window = {
  addEventListener() {},
  sidecar: {
    conversationId: ROOT,
    fetch: async (_url, init) => {
      const { method, params } = JSON.parse(init.body);
      rpcLog.push({ method, params });
      const out = await rpcHandler(method, params);
      if (out?.error) return { ok: false, status: 409, json: async () => ({ ok: false, error: out.error }) };
      return { ok: true, status: 200, json: async () => ({ ok: true, result: out ?? {} }) };
    },
  },
};

const mod = (file) => import(pathToFileURL(path.join(uiDir, file)).href);
const S = await mod("state.js");
const N = await mod("normalize.js");
const NET = await mod("net.js");
const ST = await mod("stream.js");
const A_actions = await mod("actions.js");
const C = await mod("config-view.js");
const R = await mod("render.js");
const composer = await mod("composer.js");
const modals = await mod("modals.js");
const { state } = S;
const lastRpc = (method) => rpcLog.filter((entry) => entry.method === method).at(-1)?.params;

function resetFixture() {
  state.activeConversationId = ROOT;
  state.rootConversationId = ROOT;
  state.workspace = A;
  state.conversationUnbound = false;
  state.bootstrapLoaded = true;
  state.bootstrapPromise = null;
  state.version = "0.3.2";
  state.projectConfig = S.normalizeProjectConfig(cfgRaw());
  state.defaultExternalSessionVisible = false;
  state.defaultExternalSessionSaving = null;
  state.autoCheckUpdates = true;
  state.autoCheckUpdatesSaving = null;
  state.systemUpdate = N.normalizeSystemUpdate({ currentVersion: "0.3.2", installOrigin: "dev" });
  state.systemUpdateBusy = "";
  state.projectExternalSessionSaving = "";
  state.threadsMap.clear();
  state.archivedThreadIds.clear();
  state.pendingConfirms.clear();
  state.selectedThreadId = "";
  state.manualTarget = false;
  state.presets = {};
  state.presetSaving = false;
  state.presetSavePromise = null;
  state.globalPresetSaving = false;
  state.globalPresetSavePromise = null;
  for (const key of ["dirtyPresets", "dirtyModeProfiles", "pendingDeletes", "pendingResets", "globalDirtyPresets", "globalDirtyModeProfiles", "globalPendingDeletes"]) state[key]?.clear?.();
  Object.assign(state.composer, { presetKey: "", provider: "codex", model: "gpt-6.2-sol", effort: "high", permissionMode: "on-request", interactionMode: "default", isolation: "shared" });
  Object.assign(state.dispatchSelection, { provider: "codex", model: "gpt-6.2-sol", effort: "high", permissionMode: "full-access" });
  state.selectedPresetChip = "";
  state.dispatchMode = "single";
  state.batchDrafts = [];
  state.renderScheduled = false;
  ST.applyConversationPolicyPayload({ rootConversationId: ROOT, orchestrationMode: "relay", source: "explicit", policyRevision: 1 });
  rpcLog.length = 0;
  toasts.length = 0;
  rpcHandler = () => ({});
  byId("comp-prompt-input").value = "测试指令";
  byId("comp-ephemeral-chk").checked = false;
  byId("disp-ephemeral-chk").checked = false;
  byId("disp-prompt").value = "派发指令";
  byId("disp-title").value = "测试任务";
  byId("disp-role").value = "implementation";
  byId("disp-perm").value = "full-access";
  byId("disp-isolation").value = "shared";
  byId("disp-cwd").value = A;
  byId("system-update-notes").innerHTML = "";
  byId("system-update-notes").textContent = "";
  byId("system-update-result").innerHTML = "";
  byId("system-update-result").textContent = "";
  byId("system-update-result").dataset = {};
  byId("system-update-progress").attrs = {};
  byId("system-update-progress").value = "";
  byId("system-update-progress-meta").textContent = "";
}

function seedThread() {
  const thread = N.normalizeThread({
    id: "thread-v033",
    rootConversationId: ROOT,
    workspace: A,
    cwd: A,
    projectRoot: A,
    provider: "codex",
    model: "gpt-6.2-sol",
    effort: "high",
    permissionMode: "on-request",
    interactionMode: "default",
    status: "idle",
    items: [],
    queue: [],
  });
  state.threadsMap.set(thread.id, thread);
  state.selectedThreadId = thread.id;
  return thread;
}

test("归一化与实时入口：安全 URL、全局设置、更新事件和项目隔离", async () => {
  const unsafe = N.normalizeSystemUpdate({ releaseUrl: "javascript:alert(1)", hasUpdate: 1, lastCheckedAt: -1 });
  assert.equal(unsafe.releaseUrl, "");
  assert.equal(unsafe.hasUpdate, false);
  assert.equal(unsafe.lastCheckedAt, 0);
  assert.equal(S.normalizeProjectConfig(cfgRaw()).externalSessionMode, "inherit");
  assert.equal(Object.hasOwn(S.normalizeProjectConfig({ workspace: A }), "externalSessionMode"), false);

  resetFixture();
  ST.ingestStreamPayload({ events: [
    { type: "settings_updated", settings: { defaultExternalSessionVisible: true, autoCheckUpdates: false } },
    { type: "system_update_changed", systemUpdate: {
      state: "available", currentVersion: "0.3.2", latestVersion: "0.3.3", hasUpdate: true,
      releaseUrl: "https://github.com/by-buzhou/agent-tower/releases/tag/v0.3.3", releaseNotes: "safe",
    } },
  ] });
  assert.equal(state.defaultExternalSessionVisible, true);
  assert.equal(state.projectConfig.externalSessionVisible, true);
  assert.equal(state.autoCheckUpdates, false);
  assert.equal(state.systemUpdate.latestVersion, "0.3.3");
  assert.match(state.systemUpdate.releaseUrl, /^https:\/\/github\.com\//);

  ST.ingestStreamPayload({ type: "project_config_updated", workspace: B, projectConfig: cfgRaw(B, { externalSessionMode: "visible" }) });
  assert.equal(state.projectConfig.workspace, A);
  ST.ingestStreamPayload({ type: "project_config_updated", workspace: A, projectConfig: cfgRaw(A, { externalSessionMode: "hidden", externalSessionCustomized: true }) });
  assert.equal(state.projectConfig.externalSessionMode, "hidden");
  ST.ingestStreamPayload({ type: "project_config_updated", workspace: A, projectConfig: cfgRaw(A, { rosterRevision: 6, externalSessionMode: "visible" }) });
  assert.equal(state.projectConfig.externalSessionMode, "hidden", "旧修订不得覆盖新项目配置");

  resetFixture();
  ST.ingestStreamPayload({
    events: [{ type: "system_update_changed", systemUpdate: { state: "checking" } }],
    settings: { defaultExternalSessionVisible: true, autoCheckUpdates: false },
    systemUpdate: { state: "up_to_date", currentVersion: "0.3.2", installOrigin: "zip" },
  });
  assert.deepEqual([state.defaultExternalSessionVisible, state.autoCheckUpdates, state.systemUpdate.state], [true, false, "up_to_date"]);
});

test("渲染：全局与项目生效值、顶栏徽章、Release 防 XSS", () => {
  resetFixture();
  const malicious = "<img src=x onerror=globalThis.pwned=true>\n第二行";
  state.systemUpdate = N.normalizeSystemUpdate({
    state: "available",
    currentVersion: "0.3.2",
    latestVersion: "0.3.3",
    hasUpdate: true,
    releaseUrl: "https://github.com/by-buzhou/agent-tower/releases/tag/v0.3.3",
    releaseNotes: malicious,
    installOrigin: "dev",
  });
  C.renderDefaultExternalSessionSwitch();
  C.renderProjectExternalSessionSection();
  C.renderSystemUpdateSection();
  R.renderSystemUpdateBadge();
  assert.equal(byId("btn-default-external-session-visible").attrs["aria-checked"], "false");
  assert.equal(byId("project-external-session-badge").textContent, "跟随全局 · 已隐藏");
  assert.equal(projectRadios[0].attrs["aria-checked"], "true");
  assert.equal(projectRadios[2].tabIndex, -1);
  assert.equal(byId("system-update-notes").textContent, malicious);
  assert.equal(byId("system-update-notes").innerHTML, "", "远端文本不得进入 innerHTML");
  assert.equal(byId("system-update-notes").hidden, false);
  assert.match(byId("link-system-update-release").href, /^https:\/\/github\.com\//);
  assert.deepEqual([byId("topbar-update-badge").hidden, byId("topbar-update-badge").textContent], [false, "⬆ v0.3.3"]);

  state.systemUpdate.dismissedVersion = "0.3.3";
  R.renderSystemUpdateBadge();
  assert.equal(byId("topbar-update-badge").hidden, true);
  state.systemUpdate = N.normalizeSystemUpdate({ state: "available", hasUpdate: true, latestVersion: "9.9.9", releaseUrl: "https://evil.example/x", releaseNotes: "x" });
  C.renderSystemUpdateSection();
  assert.equal(byId("link-system-update-release").hidden, true);
});

test("双层设置保存：精确 RPC、项目 rosterRevision 不变、失败不击穿原状态", async () => {
  resetFixture();
  rpcHandler = (_method, params) => {
    if (params.scope === "global") return {
      settings: {
        defaultExternalSessionVisible: params.defaultExternalSessionVisible ?? state.defaultExternalSessionVisible,
        autoCheckUpdates: params.autoCheckUpdates ?? state.autoCheckUpdates,
      },
      ...(typeof params.defaultExternalSessionVisible === "boolean" ? { projectConfig: cfgRaw(A, { externalSessionVisible: params.defaultExternalSessionVisible }) } : {}),
    };
    return { projectConfig: cfgRaw(A, {
      externalSessionMode: params.projectExternalSessionMode,
      externalSessionVisible: params.projectExternalSessionMode === "visible",
      externalSessionCustomized: params.projectExternalSessionMode !== "inherit",
    }) };
  };
  assert.equal(await A_actions.toggleDefaultExternalSessionVisible(), true);
  assert.equal(lastRpc("saveSettings").defaultExternalSessionVisible, true);
  assert.equal(state.defaultExternalSessionVisible, true);
  assert.equal(state.projectConfig.externalSessionVisible, true);
  assert.equal(await A_actions.toggleAutoCheckUpdates(), true);
  assert.equal(lastRpc("saveSettings").autoCheckUpdates, false);
  assert.equal(state.autoCheckUpdates, false);
  assert.equal(await A_actions.setProjectExternalSessionMode("visible"), true);
  const projectSave = lastRpc("saveSettings");
  assert.deepEqual([projectSave.scope, projectSave.workspace, projectSave.projectExternalSessionMode], ["project", A, "visible"]);
  assert.equal(Object.hasOwn(projectSave, "rosterRevision"), false);
  assert.equal(state.projectConfig.rosterRevision, 7);
  assert.equal(state.projectConfig.externalSessionCustomized, true);

  resetFixture();
  rpcHandler = () => ({ error: { code: "X", message: "保存失败" } });
  assert.equal(await A_actions.toggleDefaultExternalSessionVisible(), false);
  assert.equal(state.defaultExternalSessionVisible, false);
  assert.match(byId("default-external-session-save-status").textContent, /保存失败/);
  assert.equal(await A_actions.setProjectExternalSessionMode("visible"), false);
  assert.equal(state.projectConfig.externalSessionMode, "inherit");
  const count = rpcLog.length;
  assert.equal(await A_actions.setProjectExternalSessionMode("bogus"), false);
  state.conversationUnbound = true;
  assert.equal(await A_actions.setProjectExternalSessionMode("hidden"), false);
  assert.equal(rpcLog.length, count);
});

test("更新动作：直接/包裹回执、忽略版本与检测失败", async () => {
  resetFixture();
  rpcHandler = (_method, params) => params.action === "check" ? {
    state: "available", currentVersion: "0.3.2", latestVersion: "0.3.3", hasUpdate: true,
    releaseUrl: "https://github.com/by-buzhou/agent-tower/releases/tag/v0.3.3", releaseNotes: "notes",
  } : { systemUpdate: { ...state.systemUpdate, dismissedVersion: params.version } };
  assert.equal(await A_actions.checkSystemUpdates(), true);
  assert.deepEqual(lastRpc("systemUpdate"), { conversationId: ROOT, workspace: A, action: "check" });
  assert.equal(state.systemUpdate.latestVersion, "0.3.3");
  assert.equal(await A_actions.dismissSystemUpdate(), true);
  assert.equal(lastRpc("systemUpdate").version, "0.3.3");
  assert.equal(state.systemUpdate.dismissedVersion, "0.3.3");
  R.renderSystemUpdateBadge();
  assert.equal(byId("topbar-update-badge").hidden, true);

  resetFixture();
  rpcHandler = () => ({ error: { code: "NETWORK", message: "离线" } });
  assert.equal(await A_actions.checkSystemUpdates(), false);
  assert.equal(state.systemUpdate.state, "unavailable");
  assert.match(state.systemUpdate.error, /离线/);
  const count = rpcLog.length;
  state.systemUpdateBusy = "check";
  assert.equal(await A_actions.checkSystemUpdates(), false);
  assert.equal(rpcLog.length, count);
});

test("Composer launchThread / sendToThread：未勾选省略 ephemeral，勾选仅传 true", async () => {
  for (const checked of [false, true]) {
    resetFixture();
    byId("comp-ephemeral-chk").checked = checked;
    rpcHandler = () => ({ bypassed: true, summary: "测试止派" });
    await composer.handleComposerSubmit("auto");
    const params = lastRpc("launchThread");
    assert.equal(Object.hasOwn(params, "ephemeral"), checked, `launchThread checked=${checked}`);
    if (checked) assert.equal(params.ephemeral, true);
  }
  for (const checked of [false, true]) {
    resetFixture();
    seedThread();
    byId("comp-ephemeral-chk").checked = checked;
    rpcHandler = () => ({ action: "steered_live" });
    await composer.handleComposerSubmit("steer");
    const params = lastRpc(checked ? "launchThread" : "sendToThread");
    assert.equal(Object.hasOwn(params, "ephemeral"), checked);
    if (checked) assert.equal(lastRpc("sendToThread"), undefined);
    if (checked) assert.equal(params.ephemeral, true);
  }
});

test("派单抽屉 delegateTask / launchThread / delegateParallelBatch：所有层级均不硬传 false", async () => {
  for (const [mode, method] of [["single", "delegateTask"], ["thread", "launchThread"], ["batch", "delegateParallelBatch"]]) {
    for (const checked of [false, true]) {
      resetFixture();
      state.dispatchMode = mode;
      byId("disp-ephemeral-chk").checked = checked;
      if (mode === "batch") state.batchDrafts = [{
        title: "批任务", prompt: "批量指令", role: "implementation", presetKey: "", provider: "codex", model: "gpt-6.2-sol",
        effort: "high", permissionMode: "full-access", isolation: "shared", council: false,
      }];
      rpcHandler = () => ({ bypassed: true, summary: "测试止派" });
      await modals.submitDispatchDrawer();
      const params = lastRpc(method);
      assert.ok(params, `${method} 未发出`);
      assert.equal(Object.hasOwn(params, "ephemeral"), checked, `${method} checked=${checked}`);
      if (checked) assert.equal(params.ephemeral, true);
      if (mode === "batch") {
        assert.equal(Object.hasOwn(params.tasks[0], "ephemeral"), checked, `batch task checked=${checked}`);
        if (checked) assert.equal(params.tasks[0].ephemeral, true);
      }
    }
  }
});

test("v0.3.3.1 热更新与回滚：状态归一、错误码中文提示、原生进度条渲染与防 XSS", () => {
  for (const st of ["idle", "checking", "up_to_date", "available", "unavailable", "downloading", "verifying", "quiescing", "applying", "rolling_back"]) {
    assert.equal(N.normalizeSystemUpdate({ state: st }).state, st);
  }
  assert.equal(N.normalizeSystemUpdate({ state: "unknown_state" }).state, "idle");

  const norm = N.normalizeSystemUpdate({
    state: "downloading",
    cancellable: true,
    progress: { phase: "download", percent: 145, downloadedBytes: 1024, totalBytes: 2048, message: "下载中" },
    rollback: { available: true, version: "0.3.3", backedUpAt: "2026-11-27T00:00:00Z", rollbackSafe: false },
    lastResult: { status: "auto_rolled_back", fromVersion: "0.3.3", toVersion: "0.3.3.1", at: 1732665600000, message: "探活失败" },
  });
  assert.equal(norm.cancellable, true);
  assert.deepEqual(norm.progress, { phase: "download", percent: 100, downloadedBytes: 1024, totalBytes: 2048, message: "下载中" });
  assert.deepEqual(norm.rollback, { available: true, version: "0.3.3", backedUpAt: "2026-11-27T00:00:00Z", rollbackSafe: false });
  assert.deepEqual(norm.lastResult, { status: "auto_rolled_back", fromVersion: "0.3.3", toVersion: "0.3.3.1", at: 1732665600000, message: "探活失败" });
  assert.equal(N.normalizeSystemUpdate({ progress: { percent: "50" } }).progress.percent, null);

  for (const code of [
    "DAEMON_UPDATING",
    "UPDATE_UNSUPPORTED_INSTALL",
    "UPDATE_NOT_AVAILABLE",
    "UPDATE_TARGET_MODIFIED",
    "UPDATE_CHECKSUM_MISMATCH",
    "UPDATE_INTEGRITY_FAILED",
    "UPDATE_PREFLIGHT_FAILED",
    "UPDATE_ROLLBACK_UNAVAILABLE",
    "UPDATE_IN_PROGRESS",
    "UPDATE_ALREADY_COMMITTING",
  ]) {
    const hint = NET.describeRpcError({ code, message: "raw" });
    assert.notEqual(hint, "raw", `错误码 ${code} 缺少中文提示`);
    assert.ok(hint.length >= 10);
  }

  // 1) zip 安装形态支持在线热更新；dev 形态仅提示命令行热切且隐藏覆盖按钮
  resetFixture();
  state.systemUpdate = N.normalizeSystemUpdate({
    state: "available",
    currentVersion: "0.3.3",
    latestVersion: "0.3.3.1",
    hasUpdate: true,
    installOrigin: "zip",
    autoUpdateSupported: true,
  });
  C.renderSystemUpdateSection();
  assert.equal(byId("btn-apply-system-update").hidden, false);
  assert.equal(byId("btn-apply-system-update").textContent, "⬇ 下载并热更新");
  assert.equal(byId("system-update-progress-wrap").hidden, true);
  assert.equal(byId("btn-cancel-system-update").hidden, true);

  state.systemUpdate = N.normalizeSystemUpdate({
    state: "available",
    currentVersion: "0.3.3",
    latestVersion: "0.3.3.1",
    hasUpdate: true,
    installOrigin: "dev",
    autoUpdateSupported: false,
  });
  C.renderSystemUpdateSection();
  assert.equal(byId("btn-apply-system-update").hidden, true);
  assert.match(byId("system-update-install-origin").textContent, /命令行/);
  assert.match(byId("system-update-status-text").textContent, /命令行/);

  // 2) downloading 有明确百分比 → 设置 progress.value；quiescing 无百分比 → 移除 value 走 indeterminate，且可取消
  state.systemUpdate = N.normalizeSystemUpdate({
    state: "downloading",
    currentVersion: "0.3.3",
    latestVersion: "0.3.3.1",
    hasUpdate: true,
    installOrigin: "zip",
    autoUpdateSupported: true,
    progress: { phase: "download", percent: 42, downloadedBytes: 1_200_000, totalBytes: 2_800_000, message: "" },
  });
  C.renderSystemUpdateSection();
  assert.equal(byId("system-update-progress-wrap").hidden, false);
  assert.equal(byId("system-update-progress").value, 42);
  assert.equal(byId("system-update-progress").getAttribute("value"), "42");
  assert.match(byId("system-update-progress-meta").textContent, /42%/);
  assert.equal(byId("btn-apply-system-update").hidden, true);

  state.systemUpdate = N.normalizeSystemUpdate({
    state: "quiescing",
    currentVersion: "0.3.3",
    latestVersion: "0.3.3.1",
    cancellable: true,
    progress: { phase: "quiescing", percent: null, message: "等待 1 个在途任务完结" },
  });
  C.renderSystemUpdateSection();
  assert.equal(byId("system-update-progress-wrap").hidden, false);
  assert.equal(byId("system-update-progress").getAttribute("value"), null, "无明确百分比时必须移除 value 属性走 indeterminate");
  assert.equal(byId("btn-cancel-system-update").hidden, false);
  assert.equal(byId("system-update-status-text").textContent, "等待 1 个在途任务完结");

  // 3) 自动回滚告警与一键回滚按钮（防 XSS）
  const xssMsg = "<script>globalThis.pwn=1</script> /healthz 503";
  state.systemUpdate = N.normalizeSystemUpdate({
    state: "up_to_date",
    currentVersion: "0.3.3",
    rollback: { available: true, version: "0.3.2", rollbackSafe: true },
    lastResult: { status: "auto_rolled_back", fromVersion: "0.3.3.1", toVersion: "0.3.3", at: 1732665600000, message: xssMsg },
  });
  C.renderSystemUpdateSection();
  assert.equal(byId("system-update-result").hidden, false);
  assert.equal(byId("system-update-result").dataset.status, "auto_rolled_back");
  assert.equal(byId("system-update-result").getAttribute("role"), "alert");
  assert.ok(byId("system-update-result").textContent.includes("已自动回滚至 v0.3.3"));
  assert.ok(byId("system-update-result").textContent.includes(xssMsg));
  assert.equal(byId("system-update-result").innerHTML, "", "lastResult.message 不得进入 innerHTML");
  assert.equal(byId("btn-rollback-system-update").hidden, false);
  assert.equal(byId("btn-rollback-system-update").textContent, "↺ 回滚至 v0.3.2");

  state.systemUpdate.rollback.rollbackSafe = false;
  C.renderSystemUpdateSection();
  assert.equal(byId("btn-rollback-system-update").hidden, true);
});

test("v0.3.3.1 热更新、取消与回滚动作：二次确认、RPC 参数与错误提示", async () => {
  resetFixture();
  state.systemUpdate = N.normalizeSystemUpdate({
    state: "available",
    currentVersion: "0.3.3",
    latestVersion: "0.3.3.1",
    hasUpdate: true,
    installOrigin: "git-clone",
    autoUpdateSupported: true,
  });
  rpcHandler = (_method, params) => {
    if (params.action === "apply") return { state: "quiescing", cancellable: true, currentVersion: "0.3.3", latestVersion: "0.3.3.1" };
    if (params.action === "cancelCutover") return { state: "available", cancellable: false, currentVersion: "0.3.3", latestVersion: "0.3.3.1", hasUpdate: true, autoUpdateSupported: true, installOrigin: "git-clone" };
    if (params.action === "rollback") return { state: "rolling_back", cancellable: false, currentVersion: "0.3.3.1", rollback: { available: true, version: "0.3.3", rollbackSafe: true } };
    return {};
  };

  // apply：首击仅二次确认武装，不发 RPC；次击发 action: 'apply'
  assert.equal(await A_actions.applySystemUpdate(), false);
  assert.equal(rpcLog.length, 0);
  C.renderSystemUpdateSection();
  assert.equal(byId("btn-apply-system-update").textContent, "确认下载并热更新？");
  assert.equal(await A_actions.applySystemUpdate(), true);
  assert.equal(lastRpc("systemUpdate").action, "apply");
  assert.equal(lastRpc("systemUpdate").version, "0.3.3.1");
  assert.equal(state.systemUpdate.state, "quiescing");
  assert.equal(state.systemUpdate.cancellable, true);

  // cancelCutover：cancellable=true 直接触发；cancellable=false 拦截
  assert.equal(await A_actions.cancelSystemUpdate(), true);
  assert.equal(lastRpc("systemUpdate").action, "cancelCutover");
  assert.equal(state.systemUpdate.cancellable, false);
  const beforeNoop = rpcLog.length;
  assert.equal(await A_actions.cancelSystemUpdate(), false);
  assert.equal(rpcLog.length, beforeNoop);

  // rollback：二次确认后发 action: 'rollback'
  state.systemUpdate = N.normalizeSystemUpdate({
    state: "up_to_date",
    currentVersion: "0.3.3.1",
    rollback: { available: true, version: "0.3.3", rollbackSafe: true },
  });
  assert.equal(await A_actions.rollbackSystemUpdate(), false);
  C.renderSystemUpdateSection();
  assert.equal(byId("btn-rollback-system-update").textContent, "确认回滚至 v0.3.3？");
  assert.equal(await A_actions.rollbackSystemUpdate(), true);
  assert.equal(lastRpc("systemUpdate").action, "rollback");
  assert.equal(state.systemUpdate.state, "rolling_back");

  // 错误码中文提示透传 Toast
  resetFixture();
  state.systemUpdate = N.normalizeSystemUpdate({
    state: "available",
    currentVersion: "0.3.3",
    latestVersion: "0.3.3.1",
    hasUpdate: true,
    installOrigin: "zip",
    autoUpdateSupported: true,
  });
  rpcHandler = () => ({ error: { code: "UPDATE_CHECKSUM_MISMATCH", message: "bad hash" } });
  assert.equal(await A_actions.applySystemUpdate(), false);
  assert.equal(await A_actions.applySystemUpdate(), false);
  assert.match(toasts.at(-1).message, /SHA-256/);
});

test("下载先返回、取消回执后到，面板仍可立即再次检测", async () => {
  resetFixture();
  const available = { state: "available", currentVersion: "0.3.3", latestVersion: "0.3.3.1",
    hasUpdate: true, installOrigin: "zip", autoUpdateSupported: true };
  state.systemUpdate = N.normalizeSystemUpdate(available);
  const apply = Promise.withResolvers(), cancel = Promise.withResolvers();
  rpcHandler = (_method, { action }) => ({ apply: apply.promise, cancelCutover: cancel.promise })[action] ?? available;
  await A_actions.applySystemUpdate();
  const applying = A_actions.applySystemUpdate();
  state.systemUpdate = N.normalizeSystemUpdate({ ...available, state: "downloading", cancellable: true });
  const cancelling = A_actions.cancelSystemUpdate();
  apply.resolve(available);
  await applying;
  cancel.resolve({ ...available, state: "downloading", cancellable: false });
  await cancelling;
  assert.equal(state.systemUpdate.state, "available");
  assert.equal(await A_actions.checkSystemUpdates(), true);
});

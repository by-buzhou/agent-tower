import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { pathToFileURL } from "node:url";
import { resolveStudioAsset } from "../../core/frontend-assets.mjs";
import { repoRoot } from "../helpers/sandbox.mjs";

// v0.3.0 Track B：Studio 双作用域配置页（当前项目 / 全局默认）、按项目阵容草稿与流隔离、可插拔项目 Spec 总开关与双向手动归档交互。
// 纯 Node 驱动真实 ui 模块（最小 window / document 桩），不起浏览器；380px / 1440px 实测复用 studio-ui / v020 / v029 共享 Edge 守护套件。
const studioDir = path.join(repoRoot, "sidecars", "studio");
const uiDir = path.join(studioDir, "ui");
const read = (...parts) => fs.readFileSync(path.join(studioDir, ...parts), "utf8");
const A = "F:/proj-a";
const B = "F:/proj-b";
const cfgOf = (workspace, extra = {}) => ({ workspace, projectKey: workspace.toLowerCase(), rosterSource: "project", rosterCustomized: true, rosterRevision: 1, specEnabled: true, ...extra });

/* ---------- 静态契约 ---------- */
test("v0.3.3 静态契约：双顶层配置 3+4 子页面、面板归属、零 textarea / 禁用 Emoji / Trellis、23 模块单包拼装与内部色板", () => {
  const html = read("index.html");
  const viewSettings = html.slice(html.indexOf('<section id="view-settings"'), html.indexOf('<section id="view-global"'));
  const viewGlobal = html.slice(html.indexOf('<section id="view-global"'), html.indexOf("</main>"));
  const paneIn = (view, id, nextIds) => {
    const start = view.indexOf(`id="settings-pane-${id}"`);
    assert.ok(start > 0, `缺少 #settings-pane-${id}`);
    const ends = nextIds.map((p) => view.indexOf(`id="settings-pane-${p}"`)).filter((i) => i > start);
    return view.slice(start, ends.length ? Math.min(...ends) : undefined);
  };
  // 顶栏 5 平级 Tab；一级作用域栏 #settings-scope-bar 彻底移除；双配置子页面切换器为 role=group 卡片栏
  assert.deepEqual([...html.matchAll(/<button[^>]*role="tab"[^>]*data-view="([^"]+)"/g)].map((m) => m[1]), ["board", "members", "diff", "settings", "global"]);
  assert.ok(!html.includes('id="settings-scope-bar"'), "#settings-scope-bar 已彻底移除");
  assert.match(viewSettings, /<section id="view-settings" class="sw-tab-body" role="tabpanel" hidden aria-label="项目配置">/);
  assert.match(viewGlobal, /<section id="view-global" class="sw-tab-body" role="tabpanel" hidden aria-label="全局配置">/);
  assert.match(viewSettings, /<div (?:id="settings-subnav" class="set-subnav subpage-switcher subpage-switcher--3"|class="set-subnav subpage-switcher subpage-switcher--3" id="settings-subnav") role="group" aria-label="项目配置子页面">/);
  assert.match(viewGlobal, /<div (?:id="global-settings-subnav" class="set-subnav subpage-switcher subpage-switcher--4"|class="set-subnav subpage-switcher subpage-switcher--4" id="global-settings-subnav") role="group" aria-label="全局配置子页面">/);
  assert.deepEqual([...viewSettings.matchAll(/data-settings-pane="([\w-]+)" data-pane-scope="(\w+)"/g)].map((m) => `${m[1]}@${m[2]}`), ["roles@project", "project@project", "cache@project"]);
  assert.deepEqual([...viewGlobal.matchAll(/data-settings-pane="([\w-]+)" data-pane-scope="(\w+)"/g)].map((m) => `${m[1]}@${m[2]}`), ["general@global", "global-roles@global", "extensions@global", "catalog@global"]);
  assert.match(viewSettings, /<div class="set-context-strip">[\s\S]*?当前作用项目[\s\S]*?id="settings-scope-project-name"/);
  assert.match(viewGlobal, /<div class="set-context-strip">[\s\S]*?全局共享配置[\s\S]*?跨项目默认生效[\s\S]*?id="global-preset-save-status"/);

  const roles = paneIn(viewSettings, "roles", ["project", "cache"]);
  for (const id of ["project-roster-source-badge", "btn-sync-roster-to-global", "btn-reset-roster-to-global", "btn-reset-presets", "role-presets-grid"]) assert.ok(roles.includes(`id="${id}"`), `roles 缺少 #${id}`);
  assert.match(roles, /id="btn-sync-roster-to-global"[^>]*>⬆ 同步为全局默认配置<\/button>/);
  assert.match(roles, /id="btn-reset-roster-to-global"[^>]*>↺ 恢复为全局默认<\/button>/);
  assert.match(roles, /id="btn-reset-presets"[^>]* hidden>/);

  const project = paneIn(viewSettings, "project", ["cache"]);
  for (const id of ["project-specs-section", "btn-project-spec-enabled", "btn-sync-plugin-spec-templates", "btn-archive-project-specs",
    "btn-restore-project-specs", "btn-restore-enable-project-specs", "project-specs-disabled-banner", "spec-curation-panel", "project-specs-quota-bar", "project-specs-body"]) {
    assert.ok(project.includes(`id="${id}"`), `project 缺少 #${id}`);
  }
  assert.ok(!project.includes('id="conv-dispatch-section"') && !project.includes('id="runtime-cache-section"'), "项目规范子页面清爽聚焦");
  assert.match(project, /id="btn-project-spec-enabled" class="set-switch ps-curation-switch" role="switch" aria-checked="true"/);
  const specHead = project.slice(project.indexOf('id="project-specs-section"'), project.indexOf('id="project-specs-state-row"'));
  assert.ok(specHead.indexOf("btn-project-spec-enabled") < specHead.indexOf("btn-sync-plugin-spec-templates"), "总开关与 00-plugin/ 镜像同步同在项目规范顶栏");
  for (const id of ["btn-archive-project-specs", "btn-restore-project-specs", "btn-restore-enable-project-specs"]) assert.match(project, new RegExp(`id="${id}"[^>]* hidden>`));

  const cache = paneIn(viewSettings, "cache", []);
  const cacheOrder = ["conv-dispatch-section", "runtime-cache-section"].map((id) => cache.indexOf(`id="${id}"`));
  assert.ok(cacheOrder.every((v, i) => v > 0 && (i === 0 || v > cacheOrder[i - 1])), "会话与缓存：当前对话派发 → 运行缓存");
  for (const id of ["btn-settings-toggle-dispatch", "settings-conv-dispatch-badge", "runtime-cache-summary", "btn-refresh-runtime-cache", "btn-clean-runtime-cache", "runtime-cache-protected-hint"]) {
    assert.ok(cache.includes(`id="${id}"`), `cache 缺少 #${id}`);
  }

  const general = paneIn(viewGlobal, "general", ["global-roles", "extensions", "catalog"]);
  for (const id of ["dispatch-default-policy-card", "default-dispatch-seg", "sel-default-dispatch-mode", "btn-default-spec-enabled", "default-spec-save-status",
    "theme-mode-section", "theme-mode-seg", "plugin-spec-template-section", "plugin-spec-template-summary", "settings-about-version", "studio-build-tag"]) {
    assert.ok(general.includes(`id="${id}"`), `general 缺少 #${id}`);
  }
  assert.match(general, /id="btn-default-spec-enabled" class="set-switch" role="switch" aria-checked="false"/, "新项目默认 Spec 出厂关闭");
  assert.match(general, /新项目默认开启项目规范（Spec）/);
  assert.match(project, /id="project-specs-disabled-banner" role="status" hidden>[^<]*零读写 \.agent-tower\/spec\/[^<]*不干扰项目自有规则体系/, "停用说明横幅");
  for (const id of ["btn-settings-toggle-dispatch", "btn-sync-plugin-spec-templates", "project-specs-section", "runtime-cache-section", "extension-hub-section"]) {
    assert.ok(!general.includes(`id="${id}"`), `默认与外观不得承载 #${id}`);
  }

  const globalRoles = paneIn(viewGlobal, "global-roles", ["extensions", "catalog"]);
  for (const id of ["global-role-presets-grid", "global-roster-template-summary"]) assert.ok(globalRoles.includes(`id="${id}"`), `global-roles 缺少 #${id}`);
  assert.match(globalRoles, /class="role-groups"[^>]*id="global-role-presets-grid"|id="global-role-presets-grid"[^>]*class="role-groups"/, "全局默认成员池复用项目成员池同款分组可视化卡片");
  const extensions = paneIn(viewGlobal, "extensions", ["catalog"]);
  for (const id of ["extension-hub-section", "extension-hub-grid", "btn-refresh-extensions", "btn-open-ext-wizard"]) assert.ok(extensions.includes(`id="${id}"`), `extensions 缺少 #${id}`);
  const catalog = paneIn(viewGlobal, "catalog", []);
  for (const id of ["catalog-providers-container", "catalog-search-input", "btn-reload-capabilities", "catalog-empty-hint"]) assert.ok(catalog.includes(`id="${id}"`), `catalog 缺少 #${id}`);
  assert.ok(viewGlobal.includes('id="settings-catalog-count"'), "引擎目录子页面卡片带计数徽标");

  // 硬性护栏：Spec / Curation 区零 textarea；双配置视图零禁用 Emoji / role=tab / data-view；全仓前端零 Trellis
  for (const id of ["project-specs-section", "plugin-spec-template-section", "spec-curation-panel"]) {
    const at = html.indexOf(`id="${id}"`);
    assert.doesNotMatch(html.slice(at, html.indexOf("</section>", at)), /<textarea\b/i);
  }
  for (const emoji of ["🧩", "💾", "⚙️", "🧠", "⚡", "🔍", "✏️"]) {
    assert.ok(!viewSettings.includes(emoji) && !viewGlobal.includes(emoji), `配置视图含禁用 Emoji ${emoji}`);
  }
  for (const view of [viewSettings, viewGlobal]) {
    assert.doesNotMatch(view, /role="tab"/);
    assert.doesNotMatch(view, /\sdata-view=/);
  }
  const uiFiles = fs.readdirSync(uiDir).filter((f) => f.endsWith(".js"));
  assert.equal(uiFiles.length, 23, "ui/*.js 精确保持 23 个模块");
  for (const f of [...uiFiles.map((x) => path.join("ui", x)), "index.html", "styles.css"]) assert.doesNotMatch(read(f), /trellis/i, `${f} 残留 Trellis`);
  const cfgView = read("ui", "config-view.js");
  assert.doesNotMatch(cfgView, /import[^;]*from ['"]\.\/nav\.js['"]/);
  assert.doesNotMatch(cfgView.replace(/^\s*\/?\*.*$/gm, ""), /<textarea\b/i, "config-view.js 渲染模板零 textarea（注释除外）");
  const bundle = resolveStudioAsset("/app.js").content.toString();
  assert.doesNotThrow(() => new Script(bundle));
  assert.equal(bundle.match(/^\/\/ ui\/[a-z0-9-]+\.js$/gm)?.length, 23);
  for (const name of ["setSettingsScope", "setSettingsPane", "renderSettingsView", "toggleProjectSpecEnabled", "handleArchiveProjectSpecs", "handleRestoreProjectSpecs",
    "toggleDefaultSpecEnabled", "switchPresetProject", "editGlobalRolePreset", "saveAllGlobalRolePresets", "mergeRemoteGlobalTemplate"]) {
    assert.ok(bundle.includes(`function ${name}(`), `${name} 未拼入单文件 IIFE`);
  }
  // 新增 / 修改样式只引用内部 --sw-* / --r-* / --text-* 变量
  const css = read("styles.css");
  const whitelist = (marker, endMarker) => {
    const at = css.indexOf(marker);
    assert.ok(at > 0, `styles.css 缺少 ${marker}`);
    const block = css.slice(at, endMarker ? css.indexOf(endMarker, at) : undefined);
    assert.doesNotMatch(block, /var\(--(?!sw-|r-|text-)/, `${marker} 引用了非内部变量`);
  };
  whitelist("左上角双层标题", ".standalone-conv-select {");
  whitelist("Row 2: Swarm-Style 主导航胶囊 Tabs", "2. Main Single-Column Viewport");
  whitelist("二级子页面卡片切换器", "v0.3.3 双顶层配置");
  whitelist("v0.3.3 双顶层配置", "保存状态胶囊");
  whitelist("v0.3.0 可插拔项目规范（Spec）");
  assert.match(css, /#settings-pane-project > \.project-specs-section \{\s*grid-column: 1 \/ -1;/);
  assert.match(css, /@media \(min-width: 1024px\) \{[\s\S]*#settings-pane-cache \{[^}]*display: grid;/);
  assert.match(css, /@media \(min-width: 1280px\) \{[\s\S]*#global-role-presets-grid\[data-scope="relay"\]/);
});

/* ---------- Node 驱动真实 ui 模块 ---------- */
const nativeSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => {
  const t = nativeSetTimeout(fn, ms, ...args);
  t?.unref?.();
  return t;
};
function makeEl(id = "", dataset = {}) {
  const classes = new Set();
  return {
    id, innerHTML: "", textContent: "", hidden: false, disabled: false, title: "", className: "", tabIndex: 0, attrs: {}, dataset, style: {},
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c), toggle: (c, on = !classes.has(c)) => (on ? classes.add(c) : classes.delete(c), on) },
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; },
    contains: () => false, querySelector: () => null, querySelectorAll: () => [], closest: () => null, appendChild() {}, remove() {}, scrollIntoView() {},
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
const paneBtns = ["roles", "project", "cache", "general", "global-roles", "extensions", "catalog"].map((p) => makeEl(`pane-${p}`, { settingsPane: p }));
const store = new Map();
globalThis.location = { pathname: "/", search: "" };
globalThis.sessionStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.localStorage = { getItem: () => null, setItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.CSS = { escape: (s) => String(s) };
globalThis.document = {
  activeElement: null, documentElement: { dataset: {} }, body: {},
  getElementById: byId, querySelector: () => null,
  querySelectorAll: (sel) => (sel.includes("[data-settings-pane]") ? paneBtns : []),
  createElement: () => ({ className: "", textContent: "", remove() {} }),
};
globalThis.window = {
  sidecar: {
    conversationId: "conv-v030",
    fetch: async (_url, init) => {
      const { method, params } = JSON.parse(init.body);
      rpcLog.push({ method, params });
      const out = await rpcHandler(method, params);
      if (out?.error) return { ok: false, status: 409, json: async () => ({ ok: false, error: out.error }) };
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
const ST = await mod("stream.js");
const COMP = await mod("composer.js");
const { state } = S;
const flush = () => new Promise((r) => nativeSetTimeout(r, 0));
const until = async (fn, label) => {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await new Promise((r) => nativeSetTimeout(r, 5));
  }
  throw Error(`等待超时：${label}`);
};
const seedPresets = (label = "") => Object.fromEntries(S.ROLE_SLOT_META.filter((s) => s.key !== "commander").map((s) => [s.key, { ...S.seedPreset(s.key), ...(label ? { label: `${label}-${s.key}` } : {}) }]));
const curation = (extra = {}) => ({ workspace: A, specEnabled: true, archive: { exists: false, fileCount: 0, hasActiveSpecs: false, conflictPaths: [] }, autoTrigger: false, running: false,
  activeThreadId: null, activeRunId: null, lastNoChange: null, pendingProposal: null, recentProposals: [], ...extra });
const saves = () => rpcLog.filter((r) => r.method === "saveSettings").map((r) => r.params);

function resetAll(workspace = A) {
  clearTimeout(state.presetTimer);
  state.presets = seedPresets();
  for (const k of ["dirtyPresets", "editedPresets", "committedPresets", "dirtyModeProfiles", "pendingDeletes", "pendingResets"]) state[k].clear();
  Object.assign(state, { presetProjectKey: null, presetEditTarget: null, serverPresetRevision: -1, presetSavePromise: null, presetSaving: false, committedModeProfiles: null, committedModeProfilesFromServer: false });
  state.pendingConfirms.clear();
  state.modeProfiles = structuredClone(S.DEFAULT_MODE_PROFILES);
  state.editingModeProfile = "complex";
  Object.assign(state, { settingsPane: "roles", settingsScope: "project", settingsScopePanes: { project: "roles", global: "general" }, activeView: "settings", openMemberKey: "", rosterActionBusy: "" });
  Object.assign(state, { globalPresets: {}, globalModeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), globalEditingModeProfile: "complex", globalOpenMemberKey: "", globalServerRevision: -1, globalPresetSaving: false, globalPresetSavePromise: null });
  for (const k of ["globalDirtyPresets", "globalDirtyModeProfiles", "globalEditedPresets", "globalCommittedPresets", "globalPendingDeletes", "globalCollapsedGroups"]) state[k]?.clear?.();
  Object.assign(state, { projectName: "", conversationTitle: "", availableConversations: [] });
  state.collapsedGroups.clear();
  state.conversationUnbound = false;
  state.workspace = workspace;
  state.projectConfig = null;
  state.globalTemplate = null;
  state.defaultSpecEnabled = false;
  state.defaultSpecSaving = null;
  state.providers = N.normalizeProvidersCatalog(S.FALLBACK_PROVIDERS, false, []);
  state.threadsMap.clear();
  Object.assign(state.projectSpecs, { loading: false, initializing: false, loadedForWorkspace: "", data: null, error: "", openKey: "", bodies: {} });
  state.specCuration = S.emptySpecCuration();
  Object.assign(state.specCurationUi, { busy: "", triggerOpen: false, note: "", reviseOpen: false, feedback: "", statusLoadedFor: "", statusLoading: false, watchRun: "" });
  state.specCurationUi.openDetails.clear();
  S.applySpecCurationPayload(curation({ workspace }));
  store.clear();
  rpcLog.length = 0;
  toasts.length = 0;
  rpcHandler = () => ({});
}

test("双顶层配置联动：7 个 SETTINGS_PANES、setSettingsPane 跨 settings / global 自动同步 activeView、各作用域记住落点", () => {
  resetAll();
  assert.deepEqual(S.SETTINGS_PANES, ["roles", "project", "cache", "general", "global-roles", "extensions", "catalog"]);
  assert.deepEqual(S.SETTINGS_PANES.map(S.settingsScopeOf), ["project", "project", "project", "global", "global", "global", "global"]);
  const pressed = () => paneBtns.find((b) => b.attrs["aria-pressed"] === "true")?.dataset.settingsPane;
  C.renderSettingsView();
  assert.deepEqual([state.settingsScope, state.activeView, pressed()], ["project", "settings", "roles"]);
  assert.equal(els.get("settings-scope-project-name").textContent, "proj-a", "项目配置上下文条展示当前项目名徽标");

  // 直接切全局面板：activeView 自动对齐到 global（事件或测试直接调用均可无缝切换）
  C.setSettingsPane("catalog");
  assert.deepEqual([state.settingsPane, state.settingsScope, state.activeView, byId("studio-app").dataset.view, pressed()], ["catalog", "global", "global", "global", "catalog"]);
  assert.equal(els.get("settings-pane-catalog").hidden, false);
  assert.equal(els.get("settings-pane-roles").hidden, true);
  C.setSettingsScope("project");
  assert.deepEqual([state.settingsPane, state.activeView], ["roles", "settings"], "回到项目配置作用域的默认落点");
  C.setSettingsPane("project");
  C.setSettingsScope("global");
  assert.deepEqual([state.settingsPane, state.activeView], ["catalog", "global"], "全局配置记住上次停留的引擎目录");
  C.setSettingsPane("global-roles");
  C.setSettingsScope("project");
  assert.deepEqual([state.settingsPane, state.activeView], ["project", "settings"], "项目配置记住上次停留的项目规范");
  C.setSettingsScope("bogus");
  assert.equal(state.settingsPane, "project");
  C.setSettingsPane("cache");
  assert.deepEqual([state.settingsPane, state.settingsScope, state.activeView], ["cache", "project", "settings"], "会话与缓存归属项目配置");

  state.conversationUnbound = true;
  C.renderSettingsView();
  assert.equal(els.get("settings-scope-project-name").textContent, "未绑定项目");
  assert.ok(els.get("settings-scope-project-name").classList.contains("is-unbound"));
});

test("归一化：specEnabled 缺省 true 兼容旧桩、archive 快照、projectConfig / globalTemplate 摘要", () => {
  resetAll();
  assert.equal(S.normalizeSpecCuration({ workspace: A }).specEnabled, true, "旧守护进程未下发 specEnabled 时保持接入");
  assert.equal(S.normalizeSpecCuration({ workspace: A, specEnabled: false }).specEnabled, false);
  assert.deepEqual(S.normalizeSpecCuration({ archive: { exists: true, fileCount: 3.7, archivedAt: "2026-11-25T00:00:00Z", hasActiveSpecs: 1, conflictPaths: ["a.md", 2] } }).archive,
    { exists: true, fileCount: 3, archivedAt: Date.parse("2026-11-25T00:00:00Z"), hasActiveSpecs: false, conflictPaths: ["a.md", "2"] });
  assert.deepEqual(S.emptySpecCuration(A).archive, { exists: false, fileCount: 0, archivedAt: 0, hasActiveSpecs: false, conflictPaths: [] });
  assert.equal(S.normalizeProjectConfig(null), null);
  assert.deepEqual(S.normalizeProjectConfig({ workspace: "f:\\proj-a\\", rosterRevision: "4" }),
    { workspace: "F:/proj-a", projectKey: "f:/proj-a", rosterSource: "global_template", rosterCustomized: false, rosterRevision: 4, specEnabled: null });
  assert.equal(S.normalizeProjectConfig({ rosterSource: "project", workspace: A }).rosterCustomized, true);
  const tpl = S.normalizeGlobalTemplate({ presetRevision: 7, presets: seedPresets() });
  assert.deepEqual(tpl.counts, { advisor: 3, executor: 4, reviewer: 1, curator: 1, total: 9 });
  assert.equal(S.normalizeGlobalTemplate({ presetRevision: 2, counts: { advisor: 1, executor: "2", total: 3 } }).counts.executor, 2);
  // currentProjectConfig：属于其他项目时视为过期（子目录工作区视为同一主仓）
  state.projectConfig = S.normalizeProjectConfig(cfgOf(A));
  assert.equal(S.currentProjectConfig()?.workspace, A);
  state.workspace = "F:/proj-a/sub";
  assert.equal(S.currentProjectConfig()?.workspace, A);
  state.workspace = B;
  assert.equal(S.currentProjectConfig(), null);
});

test("按项目保存：草稿键附带项目键、保存捕获编辑发起时的工作区（scope: project）、无工作区回退全局省略 scope", async () => {
  resetAll();
  let rev = 5;
  rpcHandler = (method, params) => (method === "saveSettings"
    ? { ok: true, presetRevision: ++rev, modeProfiles: params.modeProfiles, projectConfig: cfgOf(A, { rosterRevision: rev }) }
    : {});
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterRevision: 5 }), presets: seedPresets(), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 5,
    globalTemplate: { presetRevision: 3, presets: seedPresets() }, settings: { defaultSpecEnabled: true } });
  assert.deepEqual([state.presetProjectKey, state.serverPresetRevision, state.defaultSpecEnabled, state.globalTemplate.presetRevision], ["f:/proj-a", 5, true, 3]);
  state.modeProfiles.complex.advisor.stageEnabled = false;
  P.markModeProfileDirty("complex", "advisor");
  assert.ok(store.has("at-preset-field-drafts:/|f:/proj-a"), "草稿键附带项目键");
  assert.ok(!store.has("at-preset-field-drafts:/"));
  // 编辑后才切换了有效工作区：保存目标仍为编辑发起时捕获的项目
  state.workspace = "F:/proj-a/sub";
  await P.saveAllRolePresets();
  const first = saves().at(-1);
  assert.deepEqual([first.scope, first.workspace, first.expectedPresetRevision, first.modeProfiles.complex.advisor.stageEnabled], ["project", A, 5, false]);
  assert.deepEqual([P.hasPendingPresetChanges(), state.serverPresetRevision, state.presetEditTarget, store.has("at-preset-field-drafts:/|f:/proj-a")], [false, 6, null, false]);

  // 无工作区（未绑定项目编辑全局默认模板）：显式写 scope: 'global' 并清除 workspace / cwd，避免 net.js 注入具体项目目录
  resetAll("");
  P.mergeRemotePresets({ presets: seedPresets(), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 2 });
  state.modeProfiles.complex.reviewer.stageEnabled = false;
  P.markModeProfileDirty("complex", "reviewer");
  assert.ok(store.has("at-preset-field-drafts:/"));
  // 即使在保存发出前 state.workspace 已获得路径，未绑定草稿仍只写全局且不带 workspace/cwd
  state.workspace = A;
  rpcHandler = () => ({ ok: true, presetRevision: 3 });
  await P.saveAllRolePresets();
  const globalSave = saves().at(-1);
  assert.deepEqual([globalSave.scope, globalSave.workspace, globalSave.cwd, globalSave.expectedPresetRevision], ["global", undefined, undefined, 2]);
});

test("切换项目防串台：旧项目草稿按原工作区单独补交、revision 基线重置、在途旧项目回执不覆盖新项目阵容", async () => {
  resetAll();
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterRevision: 9 }), presets: seedPresets("A"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 9 });
  C.setMemberLabel("executor_codex", "A 改名");
  assert.ok(P.hasPendingPresetChanges());
  rpcHandler = () => ({ ok: true });
  // 切到项目 B（Bootstrap 下发 B 的独立阵容，revision 更低也必须被采纳）
  state.workspace = B;
  P.mergeRemotePresets({ projectConfig: cfgOf(B, { rosterRevision: 2 }), presets: seedPresets("B"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 2 });
  await flush();
  const detached = saves().at(-1);
  assert.deepEqual([detached.scope, detached.workspace, detached.presets?.executor_codex?.label, detached.expectedPresetRevision], ["project", A, "A 改名", 9], "旧项目修改按 A 单独补交");
  assert.deepEqual([state.presetProjectKey, state.serverPresetRevision, P.hasPendingPresetChanges(), state.presets.executor_codex.label], ["f:/proj-b", 2, false, "B-executor_codex"]);
  await until(() => !store.has("at-preset-field-drafts:/|f:/proj-a"), "补交成功后清除 A 草稿");

  // B 的保存在途时切回 A：B 的迟到回执丢弃；且补交保留最新已知 expectedPresetRevision（不删 revision 盲写）
  let release;
  const hold = new Promise((r) => { release = r; });
  let bCalls = 0;
  rpcHandler = async (method, params) => {
    if (method !== "saveSettings") return {};
    bCalls++;
    if (bCalls === 1) {
      await hold;
      return { ok: true, presetRevision: 3, presets: seedPresets("B-late"), projectConfig: cfgOf(B, { rosterRevision: 3 }) };
    }
    return { error: { code: "PRESET_REVISION_CONFLICT", message: "conflict" } };
  };
  C.setMemberLabel("reviewer", "B 改名");
  const pending = P.saveAllRolePresets();
  await flush();
  assert.equal(saves().at(-1).workspace, B);
  state.workspace = A;
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterRevision: 10 }), presets: seedPresets("A2"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 10 });
  release();
  await pending;
  await flush();
  assert.deepEqual([state.presetProjectKey, state.serverPresetRevision, state.presets.reviewer.label], ["f:/proj-a", 10, "A2-reviewer"], "B 的迟到回执不得覆盖 A");
  await until(() => saves().length >= 3, "等待在途完成后补交");
  const followUp = saves().at(-1);
  assert.deepEqual([followUp.workspace, followUp.expectedPresetRevision], [B, 3], "在途完成后沿用最新已知修订号校验 CAS，严禁盲写");
  await until(() => toasts.some((t) => /放弃覆盖他人新改动/.test(t)), "冲突提示");
});

test("实时流隔离：project_config_updated 仅吸收当前项目；全局 settings_updated 不覆盖已独立定制的项目阵容但吸收全局字段", () => {
  resetAll();
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterRevision: 4 }), presets: seedPresets("A"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 4 });
  // 其他项目的事件：丢弃
  ST.ingestStreamPayload({ type: "project_config_updated", workspace: B, projectConfig: cfgOf(B, { rosterRevision: 8 }), presets: seedPresets("B"), presetRevision: 8 });
  assert.deepEqual([state.presets.executor_codex.label, state.serverPresetRevision, state.presetProjectKey], ["A-executor_codex", 4, "f:/proj-a"]);
  // 当前项目的事件：吸收（大小写 / 反斜杠不同的同一路径同样命中）
  ST.ingestStreamPayload({ type: "project_config_updated", workspace: "f:\\proj-a", presets: seedPresets("A-remote"), presetRevision: 5 });
  assert.deepEqual([state.presets.executor_codex.label, state.serverPresetRevision], ["A-remote-executor_codex", 5]);
  assert.equal(state.projectConfig.rosterCustomized, true);
  ST.ingestStreamPayload({ type: "project_config_updated", workspace: A, projectConfig: cfgOf(A, {
    rosterRevision: 3, rosterSource: "global_template", rosterCustomized: false,
  }), presets: seedPresets("stale"), presetRevision: 3 });
  assert.equal(state.projectConfig.rosterCustomized, true, "迟到快照不得让定制项目重新继承全局阵容");
  // 其他根会话的串台快照（可能属于其他项目）：只吸收全局摘要，绝不切换 / 覆盖当前项目阵容
  ST.ingestStreamPayload({ snapshot: { rootConversationId: "conv-other", projectConfig: cfgOf(B, { rosterRevision: 99 }), presets: seedPresets("X"), presetRevision: 99, globalTemplate: { presetRevision: 31, presets: {} } } });
  assert.deepEqual([state.presets.executor_codex.label, state.serverPresetRevision, state.presetProjectKey, state.projectConfig.workspace, state.globalTemplate.presetRevision],
    ["A-remote-executor_codex", 5, "f:/proj-a", A, 31]);

  // 全局 settings_updated：本项目已独立定制 → 成员池不动，只吸收全局默认模式 / 新项目默认 Spec / 模板摘要 / 扩展平台
  ST.ingestStreamPayload({ type: "settings_updated", scope: "global", settings: { defaultOrchestrationMode: "complex", defaultSpecEnabled: true, presets: seedPresets("G"), presetRevision: 50,
    customProviders: [{ id: "ext-x", name: "Ext X", protocol: "acp", command: "x", enabled: true }] }, globalTemplate: { presetRevision: 50, presets: seedPresets("G") } });
  assert.deepEqual([state.presets.executor_codex.label, state.serverPresetRevision], ["A-remote-executor_codex", 5], "全局事件不得覆盖项目独立阵容");
  assert.deepEqual([state.defaultOrchestrationMode, state.defaultSpecEnabled, state.globalTemplate.presetRevision], ["complex", true, 50]);
  assert.ok(state.customProviders.some((c) => c.id === "ext-x"));

  // 本项目仍继承全局模板：全局模板更新随之生效（含 resetProjectToGlobal 后 rosterRevisionFloor 高于全局修订号仍能跟随更新）
  resetAll();
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterSource: "global_template", rosterCustomized: false, rosterRevision: 11, specEnabled: false, specCustomized: false }), presets: seedPresets("T1"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 11, globalTemplate: { presetRevision: 5, presets: seedPresets("T1") } });
  ST.ingestStreamPayload({ type: "settings_updated", scope: "global", settings: { defaultSpecEnabled: true, presets: seedPresets("T2"), presetRevision: 6, modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES) }, globalTemplate: { presetRevision: 6, presets: seedPresets("T2") } });
  assert.deepEqual([state.presets.executor_codex.label, state.serverPresetRevision, state.presetProjectKey], ["T2-executor_codex", 11, "f:/proj-a"]);
  assert.equal(S.isProjectSpecEnabled(), true, "未单独固定 Spec 开关的项目跟随全局 defaultSpecEnabled 联动刷新");

  // 已单独固定 specCustomized: true 的项目不受全局 defaultSpecEnabled 切换影响
  resetAll();
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterSource: "global_template", rosterCustomized: false, rosterRevision: 3, specEnabled: false, specCustomized: true }), presets: seedPresets("T1"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 3 });
  ST.ingestStreamPayload({ type: "settings_updated", scope: "global", settings: { defaultSpecEnabled: true, presets: seedPresets("T2"), presetRevision: 4, modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES) } });
  assert.equal(S.isProjectSpecEnabled(), false, "已单独固定 Spec 开关的项目不跟随全局切换");
});

test("成员池面板头：来源徽标、⬆ 同步为全局默认 / ↺ 恢复为全局默认二次确认与 RPC 契约", async () => {
  resetAll();
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterSource: "global_template", rosterCustomized: false, rosterRevision: 3 }), presets: seedPresets(), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 3 });
  C.renderSettingsView();
  const badge = els.get("project-roster-source-badge");
  assert.deepEqual([badge.textContent, badge.className], ["全局默认模板初值", "set-source-badge is-template"]);
  assert.deepEqual([els.get("btn-sync-roster-to-global").hidden, els.get("btn-reset-roster-to-global").hidden], [false, true], "未定制时无需恢复");

  state.projectConfig = S.normalizeProjectConfig(cfgOf(A, { rosterRevision: 6 }));
  C.renderSettingsView();
  assert.deepEqual([badge.textContent, els.get("btn-reset-roster-to-global").hidden], ["独立项目阵容", false]);

  rpcHandler = (method, params) => (method === "saveSettings" ? { ok: true, presetRevision: params.action === "resetProjectToGlobal" ? 7 : 6, presets: seedPresets(params.action === "resetProjectToGlobal" ? "R" : ""),
    projectConfig: cfgOf(A, { rosterRevision: params.action === "resetProjectToGlobal" ? 7 : 6 }), globalTemplate: { presetRevision: 11, presets: seedPresets() } } : {});
  assert.equal(await C.handleSyncRosterToGlobal(), false, "首击只武装二次确认");
  assert.equal(saves().length, 0);
  assert.match(toasts.at(-1), /不含项目规范开关与配额/);
  C.renderSettingsView();
  assert.equal(els.get("btn-sync-roster-to-global").textContent, "确认同步为全局默认？");
  assert.equal(await C.handleSyncRosterToGlobal(), true);
  assert.deepEqual(saves().at(-1), { conversationId: "conv-v030", workspace: A, action: "syncProjectToGlobal", cwd: A });
  assert.equal(state.globalTemplate.presetRevision, 11);
  assert.match(toasts.at(-1), /同步为全局默认模板/);

  await C.handleResetRosterToGlobal();
  assert.equal(await C.handleResetRosterToGlobal(), true);
  assert.deepEqual(saves().at(-1), { conversationId: "conv-v030", workspace: A, action: "resetProjectToGlobal", cwd: A });
  assert.deepEqual([state.serverPresetRevision, state.presets.executor_codex.label], [7, "R-executor_codex"], "恢复后 revision 单调递增并采纳全局模板");

  rpcHandler = () => ({ error: { code: "PRESET_REVISION_CONFLICT", message: "conflict" } });
  await C.handleSyncRosterToGlobal();
  assert.equal(await C.handleSyncRosterToGlobal(), false);
  assert.match(toasts.at(-1), /同步为全局默认失败/);
  state.conversationUnbound = true;
  const before = rpcLog.length;
  assert.equal(await C.handleSyncRosterToGlobal(), false);
  assert.equal(rpcLog.length, before);
  C.renderSettingsView();
  assert.deepEqual([badge.textContent, els.get("btn-sync-roster-to-global").hidden], ["未绑定项目", true]);
});

test("全局「新项目默认开启项目规范」开关与全局默认成员池模板摘要", async () => {
  resetAll();
  C.setSettingsPane("general");
  C.renderSettingsView();
  const sw = els.get("btn-default-spec-enabled");
  assert.deepEqual([sw.attrs["aria-checked"], sw.classList.contains("is-on")], ["false", false]);
  // 默认成员池模板摘要位于「全局配置 → 默认成员池」面板头
  C.setSettingsPane("global-roles");
  C.renderSettingsView();
  assert.match(els.get("global-roster-template-summary").textContent, /未下发模板摘要/);
  state.globalTemplate = S.normalizeGlobalTemplate({ presetRevision: 12, presets: seedPresets() });
  C.renderSettingsView();
  assert.equal(els.get("global-roster-template-summary").textContent, "全局默认模板 r12 · 军师 3 · 执行 4 · 评审 1 · 维护 1 · 共 9 名");

  // 回执中 projectConfig.specEnabled 变化时同步联动当前项目显示态
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterSource: "global_template", rosterCustomized: false, rosterRevision: 2, specEnabled: false, specCustomized: false }), presets: seedPresets(), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 2 });
  assert.equal(S.isProjectSpecEnabled(), false);
  rpcHandler = (method, params) => ({ ok: true, settings: { defaultSpecEnabled: params.defaultSpecEnabled }, projectConfig: cfgOf(A, { rosterSource: "global_template", rosterCustomized: false, rosterRevision: 2, specEnabled: params.defaultSpecEnabled, specCustomized: false }) });
  assert.equal(await C.toggleDefaultSpecEnabled(), true);
  assert.deepEqual(saves().at(-1), { conversationId: "conv-v030", workspace: A, scope: "global", defaultSpecEnabled: true });
  assert.deepEqual([state.defaultSpecEnabled, sw.attrs["aria-checked"], els.get("default-spec-save-status").textContent, S.isProjectSpecEnabled()], [true, "true", "已保存 ✓", true]);
  rpcHandler = () => ({ error: { code: "X", message: "boom" } });
  assert.equal(await C.toggleDefaultSpecEnabled(), false);
  assert.equal(state.defaultSpecEnabled, true, "保存失败保持原值");
  assert.match(els.get("default-spec-save-status").textContent, /保存失败/);
});

test("可插拔 Spec 关停：总开关 setEnabled、项目规范卡片折叠、维护官全入口停用、成员页提醒隐藏，reviewer 阵容不受影响", async () => {
  resetAll();
  state.specCurationUi.statusLoadedFor = A.toLowerCase();
  state.projectSpecs.loadedForWorkspace = `conv-v030|${A}`;
  state.projectSpecs.data = { workspace: A, counts: { plugin: 5, business: 1, coding: 0, total: 1 }, pluginSpecs: [], specs: [{ key: "business/x", id: "x", kind: "business", title: "X", bytes: 10 }] };
  S.applySpecCurationPayload(curation({ autoTrigger: true, pendingProposal: { id: "sprop_1", status: "pending", preflightOk: true, changes: [{ action: "update", path: ".agent-tower/spec/01-business/x.md" }] } }));
  C.renderProjectSpecsSection();
  assert.equal(els.get("btn-project-spec-enabled").attrs["aria-checked"], "true");
  assert.deepEqual([els.get("spec-curation-auto-wrap").hidden, els.get("btn-spec-curation-trigger").hidden, els.get("project-specs-quota-bar").hidden, els.get("project-specs-body").hidden], [false, false, false, false]);
  assert.deepEqual([els.get("btn-archive-project-specs").hidden, els.get("btn-restore-project-specs").hidden, els.get("project-specs-disabled-banner").hidden], [false, true, true]);

  rpcHandler = (method, params) => {
    if (method === "specCuration" && params.action === "setEnabled") return { ok: true, workspace: A, curation: curation({ specEnabled: params.enabled, autoTrigger: false, pendingProposal: null }) };
    if (method === "listProjectSpecs") return { workspace: A, specEnabled: false, specs: [], counts: { plugin: 5, business: 0, coding: 0, total: 0 }, totalProjectBytes: 0, archive: { exists: false, hasActiveSpecs: true } };
    return {};
  };
  assert.equal(await C.toggleProjectSpecEnabled(), true);
  assert.deepEqual(rpcLog.find((r) => r.params?.action === "setEnabled").params, { conversationId: "conv-v030", workspace: A, action: "setEnabled", cwd: A, enabled: false });
  assert.deepEqual([S.isProjectSpecEnabled(), S.currentSpecCuration().autoTrigger], [false, false]);
  C.renderProjectSpecsSection();
  assert.deepEqual([els.get("btn-project-spec-enabled").attrs["aria-checked"], els.get("spec-curation-auto-wrap").hidden, els.get("btn-spec-curation-trigger").hidden,
    els.get("project-specs-quota-bar").hidden, els.get("project-specs-body").hidden, els.get("btn-sync-plugin-spec-templates").hidden], ["false", true, true, true, true, true]);
  assert.deepEqual([els.get("project-specs-disabled-banner").hidden, els.get("project-specs-state-row").hidden, els.get("project-specs-state-row").classList.contains("is-disabled")], [false, false, true]);
  assert.equal(els.get("btn-archive-project-specs").hidden, false, "停用但磁盘仍有规范：可归档");
  assert.match(els.get("project-specs-summary").innerHTML, /未接入/);
  assert.match(els.get("btn-project-spec-enabled").title, /未接入项目规范（点击开启）/);

  // 阵容页：复杂阶段栏「规范维护」置灰已停用；维护组折叠为停用引导；军师 / 执行 / 评审组照常
  C.setSettingsPane("roles");
  C.renderSettingsView();
  const grid = els.get("role-presets-grid").innerHTML;
  assert.match(grid, /class="mode-flow-stage is-curation is-off is-spec-off" data-curation-auto-toggle data-fk="flow:curator" aria-pressed="false" disabled/);
  assert.match(grid, /<span class="mode-flow-state">已停用<\/span>/);
  assert.match(grid, /data-curation-spec-off>本项目未开启项目规范，规范维护官已停用/);
  assert.match(grid, /data-goto-project-pane[^>]*>前往「项目规范」开启<\/button>/);
  assert.match(grid, /role="switch" aria-checked="false" data-curation-auto-toggle data-fk="stage:curator" disabled/);
  assert.doesNotMatch(grid.slice(grid.indexOf('class="pool-curator-row"')), /data-member-key="curator_codex"/);
  assert.match(grid, /data-pool-group="reviewer"[\s\S]*data-member-key="reviewer"/, "评审组不受影响");
  assert.deepEqual(S.modeProfileIssues("complex").filter((i) => i.group === "curator"), []);

  // 维护官全入口在前端先行拦截（不发 RPC）
  const before = rpcLog.length;
  await C.toggleSpecCurationAuto();
  assert.equal(await C.submitSpecCurationTrigger(), false);
  assert.equal(await C.saveSpecCurationLimits("single", "3", "16"), false);
  C.toggleSpecCurationTriggerBar(true);
  assert.equal(state.specCurationUi.triggerOpen, false);
  assert.equal(await C.handleSyncPluginSpecTemplates(), false);
  assert.equal(rpcLog.length, before);
  assert.match(toasts.at(-1), /本项目未开启项目规范（Spec）/);
  // 成员页提醒保持隐藏（即便仍有提案）
  S.applySpecCurationPayload(curation({ specEnabled: false, pendingProposal: { id: "sprop_2", status: "pending", preflightOk: true, changes: [{ action: "update", path: "x" }] } }));
  M.renderSpecCurationReminder();
  assert.equal(els.get("spec-curation-reminder").hidden, true);
  // 停用期间提案卡只保留「放弃」（status / dismiss 始终可用）
  C.renderSpecCurationSection();
  const panel = els.get("spec-curation-panel").innerHTML;
  assert.match(panel, /data-curation-confirm="sprop_2" data-fk="curation:confirm" disabled/);
  assert.match(panel, /data-curation-revise-open="sprop_2"[^>]* disabled/);
  assert.doesNotMatch(panel, /data-curation-dismiss="sprop_2"[^>]* disabled/);

  // 重新开启：setEnabled true
  rpcHandler = (method, params) => (method === "specCuration" ? { ok: true, workspace: A, curation: curation({ specEnabled: params.enabled }) } : { workspace: A, specEnabled: true, specs: [], counts: {} });
  await C.toggleProjectSpecEnabled();
  assert.equal(rpcLog.filter((r) => r.params?.action === "setEnabled").at(-1).params.enabled, true);
  assert.equal(S.isProjectSpecEnabled(), true);
});

test("双向手动归档 / 恢复：二次确认、RPC 契约、按钮显隐与错误码中文映射", async () => {
  resetAll();
  state.projectSpecs.loadedForWorkspace = `conv-v030|${A}`;
  state.projectSpecs.data = { workspace: A, specs: [{ key: "coding/y", id: "y", kind: "coding", title: "Y", bytes: 10 }], counts: { plugin: 5, business: 0, coding: 1, total: 1 }, pluginSpecs: [] };
  const archived = { exists: true, fileCount: 2, archivedAt: 1764000000000, hasActiveSpecs: false, conflictPaths: [] };
  rpcHandler = (method, params) => {
    if (method === "specCuration" && params.action === "archive") return { ok: true, workspace: A, curation: curation({ specEnabled: false, archive: archived }) };
    if (method === "specCuration" && params.action === "restore") return { ok: true, workspace: A, curation: curation({ specEnabled: params.enableAfterRestore === true, archive: { exists: false, hasActiveSpecs: true } }) };
    if (method === "listProjectSpecs") return { workspace: A, specEnabled: S.isProjectSpecEnabled(), archive: S.currentSpecCuration().archive, specs: [], counts: {} };
    return {};
  };
  assert.equal(await C.handleArchiveProjectSpecs(), false, "首击只武装二次确认");
  assert.equal(rpcLog.length, 0);
  assert.match(toasts.at(-1), /移入 \.agent-tower\/spec-archive\//);
  C.renderProjectSpecsSection();
  assert.equal(els.get("btn-archive-project-specs").textContent, "确认归档规范？");
  assert.equal(await C.handleArchiveProjectSpecs(), true);
  assert.deepEqual(rpcLog.find((r) => r.method === "specCuration").params, { conversationId: "conv-v030", workspace: A, action: "archive", cwd: A });
  assert.deepEqual([S.isProjectSpecEnabled(), S.currentSpecCuration().archive.exists], [false, true]);
  C.renderProjectSpecsSection();
  assert.deepEqual([els.get("btn-archive-project-specs").hidden, els.get("btn-restore-project-specs").hidden, els.get("btn-restore-enable-project-specs").hidden], [true, false, false]);
  assert.match(els.get("project-specs-archive-hint").textContent, /已归档 2 篇至 \.agent-tower\/spec-archive\//);

  // 恢复（保持开关）
  await C.handleRestoreProjectSpecs(false);
  assert.equal(await C.handleRestoreProjectSpecs(false), true);
  assert.deepEqual(rpcLog.filter((r) => r.method === "specCuration").at(-1).params, { conversationId: "conv-v030", workspace: A, action: "restore", cwd: A, enableAfterRestore: false });
  assert.deepEqual([S.isProjectSpecEnabled(), S.currentSpecCuration().archive.exists], [false, false]);
  // 恢复并开启
  S.applySpecCurationPayload(curation({ specEnabled: false, archive: archived }));
  await C.handleRestoreProjectSpecs(true);
  assert.equal(await C.handleRestoreProjectSpecs(true), true);
  assert.equal(rpcLog.filter((r) => r.method === "specCuration").at(-1).params.enableAfterRestore, true);
  assert.equal(S.isProjectSpecEnabled(), true);
  C.renderProjectSpecsSection();
  assert.equal(els.get("btn-restore-enable-project-specs").hidden, true, "已开启时不再提供「恢复并开启」");

  // listProjectSpecs 顶层 specEnabled / archive 快照同步进当前项目状态
  rpcHandler = () => ({ workspace: A, specEnabled: false, archive: { exists: true, fileCount: 4 }, specs: [], counts: { plugin: 5, business: 0, coding: 0, total: 0 } });
  await C.refreshProjectSpecs({ silent: true });
  assert.deepEqual([S.isProjectSpecEnabled(), S.currentSpecCuration().archive.fileCount], [false, 4]);

  const codes = { SPEC_DISABLED_FOR_PROJECT: /接入项目规范/, SPEC_ARCHIVE_PENDING_PROPOSAL: /待确认的规范维护提案/, SPEC_ARCHIVE_ALREADY_EXISTS: /已有归档/, SPEC_ARCHIVE_EMPTY: /暂无可归档/,
    SPEC_ARCHIVE_BUSY: /占用/, SPEC_ARCHIVE_NOT_FOUND: /未找到本项目规范归档/, SPEC_ARCHIVE_CORRUPTED: /manifest\.json/, SPEC_RESTORE_CONFLICT: /同名规范文件/ };
  for (const [code, re] of Object.entries(codes)) assert.match(C.describeSpecCurationError({ code }), re, code);
  rpcHandler = () => ({ error: { code: "SPEC_RESTORE_CONFLICT", message: "conflict" } });
  await C.handleRestoreProjectSpecs(false);
  assert.equal(await C.handleRestoreProjectSpecs(false), false);
  assert.match(toasts.join("|"), /恢复冲突：\.agent-tower\/spec\/ 下已存在同名规范文件/);
  assert.equal(S.currentSpecCuration().archive.exists, true, "失败不改动本地快照");
  // 未绑定项目：拦截
  state.conversationUnbound = true;
  const before = rpcLog.length;
  assert.equal(await C.handleArchiveProjectSpecs(), false);
  assert.equal(await C.toggleProjectSpecEnabled(), false);
  assert.equal(rpcLog.length, before);
});

test("全局默认成员池直编保存（scope: 'global'）：写入全局模板且不污染已独立定制的项目阵容", async () => {
  resetAll();
  // 项目 A 已独立定制阵容；同时吸收全局默认模板（revision 7），两个作用域物理隔离
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterRevision: 9 }), presets: seedPresets("A"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES), presetRevision: 9,
    globalTemplate: { presetRevision: 7, presets: seedPresets("G"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES) } });
  assert.deepEqual([state.presets.executor_codex.label, state.serverPresetRevision], ["A-executor_codex", 9], "项目阵容保持独立定制");
  assert.deepEqual([state.globalPresets.executor_codex.label, state.globalServerRevision], ["G-executor_codex", 7], "全局默认成员池经 mergeRemoteGlobalTemplate 独立同步");

  // 在「全局配置 → 默认成员池」直接编辑：仅写入全局模板编辑态，项目阵容不动
  C.editGlobalRolePreset("executor_codex", "label", "G 改名");
  assert.equal(state.presets.executor_codex.label, "A-executor_codex", "编辑全局模板不得触碰项目阵容");
  rpcHandler = (method) => (method === "saveSettings" ? { ok: true, presetRevision: 8 } : {});
  await P.saveAllGlobalRolePresets();
  const save = saves().at(-1);
  assert.deepEqual([save.scope, save.workspace, save.cwd, save.expectedPresetRevision], ["global", undefined, undefined, 7], "全局保存不携带项目 workspace / cwd");
  assert.equal(save.presets.executor_codex.label, "G 改名");
  assert.equal(state.globalServerRevision, 8);
  assert.equal(state.presets.executor_codex.label, "A-executor_codex", "保存后项目阵容仍不污染");
  assert.ok(saves().every((s) => s.scope !== "project"), "全局编辑不得串写项目配置");
});

test("全局模板多窗口保存：迟到回执采用较新快照，CAS 按编辑基线重试未冲突字段", async () => {
  resetAll();
  const template = (rev, label) => ({ presetRevision: rev, presets: seedPresets(label), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES) });
  P.mergeRemotePresets({ projectConfig: cfgOf(A), presets: seedPresets("A"), presetRevision: 1, globalTemplate: template(7, "base") });
  C.setGlobalMemberLabel("executor_codex", "本地");
  rpcHandler = () => {
    P.mergeRemoteGlobalTemplate(template(9, "newer"));
    return { globalTemplate: template(8, "ack") };
  };
  await P.saveAllGlobalRolePresets();
  assert.deepEqual([state.globalServerRevision, state.globalPresets.executor_codex.label], [9, "newer-executor_codex"]);
  C.setGlobalMemberLabel("executor_codex", "新草稿");
  C.editGlobalRolePreset("executor_codex", "isolation", "worktree");
  const remote = template(10, "other");
  remote.presets.executor_codex.isolation = "shared";
  P.mergeRemoteGlobalTemplate(remote);
  rpcHandler = (_method, params) => {
    if (params.expectedPresetRevision === 9) return { error: { code: "PRESET_REVISION_CONFLICT", details: { currentRevision: 10, settings: remote } } };
    return { globalTemplate: { ...remote, presetRevision: 11, presets: { ...remote.presets,
      executor_codex: { ...remote.presets.executor_codex, ...params.presets.executor_codex } } } };
  };
  await P.saveAllGlobalRolePresets();
  assert.deepEqual(saves().slice(1).map(s => s.expectedPresetRevision), [9, 10]);
  assert.deepEqual(saves().at(-1).presets.executor_codex, { isolation: "worktree" });
  assert.equal(state.globalPresets.executor_codex.label, "other-executor_codex");
  assert.equal(state.presets.executor_codex.label, "A-executor_codex");
});

test("继承模板的项目在派单前冲刷全局修改，并吸收同字段 CAS 冲突的权威值", async () => {
  resetAll();
  const presets = seedPresets("base");
  P.mergeRemotePresets({ projectConfig: cfgOf(A, { rosterSource: "global_template", rosterCustomized: false, rosterRevision: 9 }),
    presetRevision: 9, presets, globalTemplate: { presetRevision: 4, presets } });
  C.setGlobalMemberLabel("executor_codex", "本地");
  rpcHandler = () => ({ error: { code: "PRESET_REVISION_CONFLICT", details: { currentRevision: 5, settings: {
    presetRevision: 5, presets: seedPresets("server"), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES),
  } } } });
  assert.equal(await P.ensurePresetsSaved(), true);
  assert.deepEqual([state.globalPresets.executor_codex.label, state.presets.executor_codex.label, state.serverPresetRevision],
    ["server-executor_codex", "server-executor_codex", 9]);
  assert.deepEqual(saves().map(s => [s.scope, s.expectedPresetRevision]), [["global", 4]]);
  assert.equal(byId("global-preset-save-status").dataset.state, "saved");
});

test("全局删除回执在同键重建之后抵达，仍保存新成员并保留阶段关闭时的新增草稿", async () => {
  resetAll();
  P.mergeRemoteGlobalTemplate({ presetRevision: 1, presets: seedPresets(), modeProfiles: structuredClone(S.DEFAULT_MODE_PROFILES) });
  C.setSettingsPane("global-roles");
  state.globalModeProfiles.complex.reviewer.stageEnabled = false;
  C.startAddGlobalMember("reviewer");
  C.renderGlobalSettingsView();
  assert.match(byId("global-role-presets-grid").innerHTML, /id="global-member-draft-label"/);
  C.cancelAddGlobalMember();
  P.queueGlobalPresetDelete("executor_codex");
  let release;
  rpcHandler = () => new Promise(r => { release = r; });
  const saving = P.saveAllGlobalRolePresets();
  await until(() => release, "删除请求在途");
  C.startAddGlobalMember("executor");
  C.updateGlobalMemberDraftField("label", "重建成员");
  C.updateGlobalMemberDraftField("key", "executor_codex");
  C.confirmAddGlobalMember();
  const remaining = seedPresets();
  delete remaining.executor_codex;
  rpcHandler = () => ({ presetRevision: 3 });
  release({ globalTemplate: { presetRevision: 2, presets: remaining } });
  await saving;
  assert.equal(saves()[1].presets.executor_codex.label, "重建成员");
  assert.equal(state.globalPresets.executor_codex.label, "重建成员");
});

test("顶栏左上角双层标题：主显项目名、次显真实会话标题，未绑定回退中性文案", () => {
  resetAll();
  ST.applyConversationPolicyPayload({ rootConversationId: "conv-v030", orchestrationMode: "relay", source: "explicit", policyRevision: 1 });
  state.workspace = A;
  // 项目名 + 真实会话标题：主标题项目名，副标题会话名
  state.projectName = "proj-a";
  state.conversationTitle = "修复双配置页布局回归";
  COMP.renderHeaderAndTitleBar();
  assert.equal(els.get("swarm-title").textContent, "proj-a");
  assert.deepEqual([els.get("swarm-subtitle").textContent, els.get("swarm-subtitle").hidden], ["修复双配置页布局回归", false]);
  // 会话标题与主标题相同或为占位名时不再重复展示副标题
  state.conversationTitle = "proj-a";
  COMP.renderHeaderAndTitleBar();
  assert.equal(els.get("swarm-subtitle").hidden, true);
  state.conversationTitle = "AgentTower";
  COMP.renderHeaderAndTitleBar();
  assert.equal(els.get("swarm-subtitle").hidden, true);
  // 无项目名（无工作区）时主标题回退真实会话标题
  state.projectName = "";
  state.workspace = "";
  state.conversationTitle = "真实会话标题";
  COMP.renderHeaderAndTitleBar();
  assert.equal(els.get("swarm-title").textContent, "真实会话标题");
  assert.equal(els.get("swarm-subtitle").hidden, true);
  // 未选择对话：中性空态
  state.conversationUnbound = true;
  COMP.renderHeaderAndTitleBar();
  assert.equal(els.get("swarm-title").textContent, "未选择对话");
  assert.deepEqual([els.get("swarm-subtitle").textContent, els.get("swarm-subtitle").hidden], ["", true]);
});

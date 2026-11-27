import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { readStudioAsset } from "../../core/frontend-assets.mjs";
import { repoRoot } from "../helpers/sandbox.mjs";

// v0.0.4 起前端拆分为原生 ES Module：契约断言针对「app.js 组合入口 + 全部 ui/*.js 子模块」源码集合
const studioDir = path.join(repoRoot, "sidecars", "studio");
const VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugin.json"), "utf8")).version;
function readStudioSources() {
  const uiDir = path.join(studioDir, "ui");
  const modules = fs.readdirSync(uiDir).filter((f) => f.endsWith(".js")).sort();
  assert.ok(modules.length > 0, "缺少 sidecars/studio/ui/*.js 原生 ES Module");
  return [path.join(studioDir, "app.js"), ...modules.map((f) => path.join(uiDir, f))]
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

test("v0.1.0 Studio 前端顶栏模式胶囊、默认策略卡片与看门狗告警契约完整", () => {
  const htmlPath = path.join(studioDir, "index.html");
  const cssPath = path.join(studioDir, "styles.css");

  const html = fs.readFileSync(htmlPath, "utf8");
  const css = fs.readFileSync(cssPath, "utf8");
  const js = readStudioSources();

  assert.ok(html.includes("AgentTower v__STUDIO_VERSION__"), "标题版本号须为 plugin.json 注入占位符");
  assert.match(VERSION, /^\d+\.\d+\.\d+(?:\.\d+)?$/);
  const served = readStudioAsset("index.html").toString("utf8");
  assert.ok(served.includes(`<title>AgentTower v${VERSION}</title>`), "服务端须把 plugin.json 版本注入标题");
  assert.ok(!served.includes("__STUDIO_VERSION__"), "服务端 index.html 不得残留版本占位符");
  assert.match(js, /STUDIO_FRONTEND_BUILD\s*=\s*'v026-native-dual-selfheal'/);

  // The card is a static container. Its controls, below, require bindings.
  assert.match(html, /id="dispatch-default-policy-card"/);
  for (const requiredId of [
    "btn-conv-dispatch-toggle",
    "conv-dispatch-icon",
    "conv-dispatch-text",
    "dispatch-paused-strip",
    "watchdog-incidents-banner",
    "sel-default-dispatch-mode",
    "btn-settings-toggle-dispatch",
  ]) {
    assert.ok(html.includes(`id="${requiredId}"`), `index.html 缺少关键节点 #${requiredId}`);
    assert.ok(js.includes(requiredId), `app.js 未绑定或渲染关键节点 #${requiredId}`);
  }

  for (const rpcMethod of ["setConversationPolicy", "dismissHealthIncident"]) {
    assert.ok(js.includes(`'${rpcMethod}'`), `app.js 未接入 RPC ${rpcMethod}`);
  }

  for (const evtName of ["conversation_policy_updated", "health_incident"]) {
    assert.ok(js.includes(`'${evtName}'`), `app.js 未监听实时事件 ${evtName}`);
  }

  for (const cls of [
    ".hdr-chip-btn.dispatch-on",
    ".hdr-chip-btn.dispatch-off",
    ".dispatch-paused-strip",
    ".watchdog-incidents-banner",
    ".watchdog-incident-card",
    ".health-mini-badge",
  ]) {
    assert.ok(css.includes(cls), `styles.css 缺少样式选择器 ${cls}`);
  }
});

test("双顶层配置页、5 主导航 Tab、子页面卡片切换器、角色分组行、保存胶囊与引擎色标契约完整", () => {
  const read = (...parts) => fs.readFileSync(path.join(repoRoot, "sidecars", "studio", ...parts), "utf8");
  const html = read("index.html");
  const css = read("styles.css");
  const js = readStudioSources();

  // 顶栏：5 个平级主导航 Tab（看板 / 成员 / 变更 / 项目配置 / 全局配置）+ 左上角双层标题组
  assert.deepEqual([...html.matchAll(/<button[^>]*role="tab"[^>]*data-view="([^"]+)"/g)].map((m) => m[1]), ["board", "members", "diff", "settings", "global"]);
  assert.match(html, /<div class="swarm-heading-group" id="swarm-heading-group">[\s\S]*?<h1 id="swarm-title" class="swarm-title"[^>]*>[\s\S]*?<span id="swarm-subtitle" class="swarm-subtitle" hidden><\/span>/);
  assert.ok(html.includes('id="tab-badge-extensions"'));
  assert.ok(html.includes('id="tab-dot-project-dispatch"'));
  assert.ok(!html.includes('id="settings-scope-bar"'), "一级作用域切换栏 #settings-scope-bar 已彻底移除");

  // 项目配置（#view-settings）：3 个子页面卡片（成员与阵容 / 项目规范 / 会话与缓存）
  const viewSettings = html.slice(html.indexOf('<section id="view-settings"'), html.indexOf('<section id="view-global"'));
  assert.match(viewSettings, /<div class="set-subnav subpage-switcher subpage-switcher--3" id="settings-subnav" role="group" aria-label="项目配置子页面">/);
  const projPanes = [...viewSettings.matchAll(/<button type="button" class="set-subtab" aria-pressed="(true|false)" data-settings-pane="([\w-]+)" data-pane-scope="(\w+)"/g)];
  assert.deepEqual(projPanes.map((m) => `${m[2]}@${m[3]}`), ["roles@project", "project@project", "cache@project"]);
  assert.deepEqual(projPanes.map((m) => m[1]), ["true", "false", "false"]);
  assert.match(viewSettings, /<div class="set-context-strip">[\s\S]*?id="settings-scope-project-name"[\s\S]*?id="preset-save-status"/);
  for (const pane of ["roles", "project", "cache"]) assert.ok(viewSettings.includes(`id="settings-pane-${pane}"`), `项目配置缺少子页面 ${pane}`);

  // 全局配置（#view-global）：4 个子页面卡片（默认与外观 / 默认成员池 / 扩展平台 / 引擎目录）
  const viewGlobal = html.slice(html.indexOf('<section id="view-global"'), html.indexOf("</main>"));
  assert.match(viewGlobal, /<div class="set-subnav subpage-switcher subpage-switcher--4" id="global-settings-subnav" role="group" aria-label="全局配置子页面">/);
  const globPanes = [...viewGlobal.matchAll(/<button type="button" class="set-subtab" aria-pressed="(true|false)" data-settings-pane="([\w-]+)" data-pane-scope="(\w+)"/g)];
  assert.deepEqual(globPanes.map((m) => `${m[2]}@${m[3]}`), ["general@global", "global-roles@global", "extensions@global", "catalog@global"]);
  assert.deepEqual(globPanes.map((m) => m[1]), ["true", "false", "false", "false"]);
  assert.match(viewGlobal, /<div class="set-context-strip">[\s\S]*?跨项目默认生效[\s\S]*?id="global-preset-save-status"/);
  for (const pane of ["general", "global-roles", "extensions", "catalog"]) assert.ok(viewGlobal.includes(`id="settings-pane-${pane}"`), `全局配置缺少子页面 ${pane}`);

  // 两个配置视图内部：零 role=tab、零 data-view=（顶栏 [role=tab][aria-selected=true] 必须唯一）
  for (const view of [viewSettings, viewGlobal]) {
    assert.doesNotMatch(view, /role="tab"/);
    assert.doesNotMatch(view, /\sdata-view=/);
  }

  // 运行时契约 id 按子页面归属全部保留（静态容器校验 HTML 归属，交互节点同时校验 app.js 引用）
  const layoutOnlyIds = new Set(["conv-dispatch-section", "runtime-cache-section", "dispatch-default-policy-card", "theme-mode-section", "plugin-spec-template-section", "extension-hub-section"]);
  const settingsIds = [
    "settings-scope-project-name", "preset-save-status", "btn-save-presets",
    "project-roster-source-badge", "btn-sync-roster-to-global", "btn-reset-roster-to-global", "btn-reset-presets", "role-presets-grid",
    "btn-project-spec-enabled", "btn-sync-plugin-spec-templates", "btn-archive-project-specs", "btn-restore-project-specs", "btn-restore-enable-project-specs",
    "conv-dispatch-section", "btn-settings-toggle-dispatch", "settings-conv-dispatch-badge", "settings-general-dot",
    "runtime-cache-section", "runtime-cache-summary", "btn-refresh-runtime-cache", "btn-clean-runtime-cache", "runtime-cache-protected-hint",
  ];
  const globalIds = [
    "global-preset-save-status", "btn-save-global-presets",
    "dispatch-default-policy-card", "default-dispatch-seg", "sel-default-dispatch-mode", "btn-default-spec-enabled", "default-spec-save-status",
    "theme-mode-section", "theme-mode-seg", "plugin-spec-template-section", "plugin-spec-template-summary", "settings-about-version", "studio-build-tag",
    "global-role-presets-grid", "global-roster-template-summary",
    "extension-hub-section", "extension-hub-grid", "btn-refresh-extensions", "btn-open-ext-wizard",
    "catalog-providers-container", "catalog-search-input", "btn-reload-capabilities", "catalog-empty-hint", "settings-catalog-count",
  ];
  for (const id of settingsIds) {
    assert.ok(viewSettings.includes(`id="${id}"`), `#view-settings 缺少 #${id}`);
    if (!layoutOnlyIds.has(id)) assert.ok(js.includes(id), `app.js 未引用 #${id}`);
  }
  for (const id of globalIds) {
    assert.ok(viewGlobal.includes(`id="${id}"`), `#view-global 缺少 #${id}`);
    if (!layoutOnlyIds.has(id)) assert.ok(js.includes(id), `app.js 未引用 #${id}`);
  }
  // 「重试」按钮位于保存胶囊内部
  assert.match(viewSettings, /<div id="preset-save-status" class="save-pill" data-state="idle"[^>]*>[\s\S]*?id="btn-save-presets"[\s\S]*?<\/div>/);

  // 派发开关为 role=switch 轨道；「新开对话默认」select 仅作隐藏数据源，且不被 <label> 包裹 / 关联（防自绘下拉劫持）
  assert.match(viewSettings, /<button type="button" id="btn-settings-toggle-dispatch" class="set-switch[^"]*" role="switch" aria-checked="(true|false)"[^>]*>\s*<span class="set-switch-track"/);
  assert.match(viewGlobal, /<select id="sel-default-dispatch-mode" class="sr-only" tabindex="-1" aria-hidden="true">/);
  assert.doesNotMatch(html, /<label[^>]*for="sel-default-dispatch-mode"/);
  const beforeSelect = viewGlobal.slice(0, viewGlobal.indexOf('id="sel-default-dispatch-mode"'));
  assert.ok(beforeSelect.lastIndexOf("<label") <= beforeSelect.lastIndexOf("</label>"), "#sel-default-dispatch-mode 不得位于 <label> 内");
  // v0.1.1：「新对话默认」收敛为三档编排模式（隐藏 select 与可见分段一一对应；simple / custom:* 已归一为 relay / complex）
  assert.deepEqual([...viewGlobal.matchAll(/data-default-mode="(\w+)"/g)].map((m) => m[1]), ["direct", "relay", "complex"]);
  const defaultSelect = viewGlobal.slice(viewGlobal.indexOf('id="sel-default-dispatch-mode"'), viewGlobal.indexOf("</select>", viewGlobal.indexOf('id="sel-default-dispatch-mode"')));
  assert.deepEqual([...defaultSelect.matchAll(/<option value="(\w+)"/g)].map((m) => m[1]), ["direct", "relay", "complex"]);
  assert.doesNotMatch(viewGlobal, /data-default-dispatch=/, "旧版布尔「默认开启 / 默认关闭」分段已废弃");

  // 配置页与扩展弹窗去 Emoji，仅保留功能符号
  const extModal = html.slice(html.indexOf('id="ext-modal-backdrop"'), html.indexOf('id="custom-model-modal-backdrop"'));
  for (const emoji of ["🧩", "💾", "⚙️", "🧠", "⚡", "🔍", "✏️"]) {
    assert.ok(!viewSettings.includes(emoji) && !viewGlobal.includes(emoji) && !extModal.includes(emoji), `配置页 / 扩展弹窗仍含 Emoji ${emoji}`);
  }
  assert.ok(viewGlobal.includes("↻ 重新探测") && js.includes("btn.textContent = '↻ 重新探测';"), "重新探测按钮复原文案需与静态文案一致");

  // CSS：双配置视图底栏收起、引擎色标变量驱动且亮 / 暗双套、容器查询、保存胶囊状态、减少动态效果
  assert.match(css, /#studio-app\[data-view="settings"\] #at-composer \{\s*display: none;/);
  assert.match(css, /#studio-app\[data-view="global"\] #at-composer \{\s*display: none;/);
  for (const eng of ["kimi-code", "codex", "claude-code", "antigravity", "ext-provider"]) {
    assert.ok(css.includes(`.eng-tag.${eng}`), `缺少引擎色标 .eng-tag.${eng}`);
  }
  for (const v of ["--eng-kimi", "--eng-codex", "--eng-claude", "--eng-host", "--eng-ext"]) {
    assert.ok((css.match(new RegExp(`${v}:`, "g")) || []).length >= 2, `${v} 需同时定义暗色与亮色值`);
  }
  assert.match(css, /container: settings \/ inline-size/);
  assert.match(css, /@container settings \(max-width: 380px\)/);
  for (const st of ["dirty", "saving", "saved", "error"]) assert.ok(css.includes(`.save-pill[data-state="${st}"]`), `缺少胶囊状态 ${st}`);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{[^@]*\.save-pill\[data-state="saving"\] \.save-pill-dot \{\s*animation: none;/);
  for (const cls of [".ps-head {", ".sub-note {", ".sr-only {"]) assert.ok(css.includes(cls), `styles.css 缺少 ${cls}`);
  for (const dead of [".preset-slot-card", ".provider-catalog-box", ".policy-gate-banner", ".ext-card", ".dispatch-default-select", ".set-scope-bar", ".set-scope-btn"]) {
    assert.ok(!css.includes(dead), `已废弃的配置页样式未清理：${dead}`);
  }
  // 双顶层配置视觉：双层标题组、主导航胶囊 Tab、子页面卡片切换器
  for (const cls of [".swarm-heading-group {", ".swarm-title {", ".swarm-subtitle {", ".sw-tab-dot {", ".subpage-switcher--3 {", ".subpage-switcher--4 {", ".set-context-strip {"]) {
    assert.ok(css.includes(cls), `styles.css 缺少 ${cls}`);
  }

  // JS：ROLE_SLOT_META 仅作内置种子且键保持不变；MEMBER_GROUPS 三组覆盖 8 个内置可派发成员；保存状态统一经 setPresetSaveStatus
  const metaBlock = js.slice(js.indexOf("const ROLE_SLOT_META = ["), js.indexOf("const MEMBER_GROUPS = ["));
  const slotKeys = [...metaBlock.matchAll(/^\s+key: '(\w+)'/gm)].map((m) => m[1]);
  assert.deepEqual(slotKeys, ["commander", "advisor_kimi", "advisor_codex", "advisor_claude", "executor_kimi", "executor_codex", "executor_claude", "executor_hydrogen", "reviewer", "curator_codex"]);
  const groupBlock = js.slice(js.indexOf("const MEMBER_GROUPS = ["), js.indexOf("const MEMBER_GROUP_IDS"));
  assert.deepEqual([...groupBlock.matchAll(/id: '(\w+)', title: '([^']+)'/g)].map((m) => `${m[1]}:${m[2]}`), ["advisor:军师组", "executor:执行组", "reviewer:评审组", "curator:规范维护组"]);
  const groupedKeys = [...groupBlock.matchAll(/keys: \[([^\]]*)\]/g)].flatMap((m) => [...m[1].matchAll(/'(\w+)'/g)].map((k) => k[1]));
  assert.deepEqual([...groupedKeys].sort(), slotKeys.filter((k) => k !== "commander").sort());
  assert.ok(!js.includes("const ROLE_GROUPS"), "固定槽位分组 ROLE_GROUPS 已由动态成员池 MEMBER_GROUPS 取代");
  assert.ok(js.includes("getElementById('btn-reset-presets')") && js.includes("resetBtn.hidden = true"), "v0.2.2 全成员平权下恢复全部默认按钮常驻隐藏");
  assert.ok(js.includes("function applyCatalogFilter()") && js.includes("state.catalogOpen"), "目录搜索 / 手风琴需走纯 DOM 过滤");
  assert.ok(js.includes("editGlobalRolePreset") && js.includes("saveAllGlobalRolePresets"), "全局默认成员池直编与保存闭环必须接入");
  for (const cls of [".pool-group-head {", ".pool-row {", ".pool-drawer,", ".pool-issue {", ".mode-popover {", ".hdr-chip-btn.mode-pill {"]) {
    assert.ok(css.includes(cls), `styles.css 缺少 ${cls}`);
  }
});

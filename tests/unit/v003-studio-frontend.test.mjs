import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DEFAULT_ROLE_PRESETS, PROVIDER_PERMISSION_MODES, normalizePermissionModeForProvider } from "../../core/catalog.mjs";
import { readStudioAsset } from "../../core/frontend-assets.mjs";
import { repoRoot } from "../helpers/sandbox.mjs";

const studioDir = path.join(repoRoot, "sidecars", "studio");
const read = (...parts) => fs.readFileSync(path.join(studioDir, ...parts), "utf8");
const html = read("index.html");
const VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugin.json"), "utf8")).version;
// v0.0.4：前端源码 = app.js 组合入口 + 全部 ui/*.js 原生 ES Module
const sources = ["app.js", ...fs.readdirSync(path.join(studioDir, "ui")).filter((f) => f.endsWith(".js")).sort().map((f) => `ui/${f}`)]
  .map((file) => ({ file, text: read(file) }));
const js = sources.map((s) => s.text).join("\n");

// 跨 app.js + ui/*.js 截取某个顶层函数声明（兼容 export / async），到同文件下一个顶层函数声明为止
function fnSource(name) {
  for (const { text } of sources) {
    const start = text.search(new RegExp(`(?:^|\\n)(?:export )?(?:async )?function ${name}\\(`));
    if (start < 0) continue;
    const rest = text.slice(text[start] === "\n" ? start + 1 : start);
    const next = rest.slice(1).search(/\n(?:export )?(?:async )?function [A-Za-z_$][\w$]*\(/);
    return next < 0 ? rest : rest.slice(0, next + 1);
  }
  assert.fail(`app.js / ui/*.js 缺少函数 ${name}`);
}

// 前端权限模块是零 window / document 依赖的叶子 ES Module：直接 import 真实文件，确保与后端 catalog 语义逐值一致
const permissionModule = await import(pathToFileURL(path.join(studioDir, "ui", "permissions.js")).href);
function loadPermissionModule() {
  return permissionModule;
}

const ENGINES = ["claude-code", "codex", "kimi-code", "antigravity", "opencode"];
const LEGACY_VALUES = ["approval-required", "auto-accept-edits", "accept-edits", "auto", "full-access", "yolo", "danger-full-access",
  "plan", "read-only", "default", "on-request", "workspace-write", "bypassPermissions", "acceptEdits", "always-proceed", "host-default",
  "dontAsk", "totally-unknown", ""];

test("v0.1.0 版本号与交互模式下拉移除", () => {
  assert.ok(html.includes("<title>AgentTower v__STUDIO_VERSION__</title>"), "标题版本号须由 frontend-assets 按 plugin.json 注入");
  assert.match(js, /STUDIO_FRONTEND_BUILD = 'v026-native-dual-selfheal'/);
  assert.ok(js.includes("version: '__STUDIO_VERSION__'"), "state.js 初始 version 须使用构建占位符而非硬编码版本号");
  assert.ok(readStudioAsset("app.js").toString("utf8").includes(`version: '${VERSION}'`), `打包后的 app.js 须按 plugin.json 注入版本 (${VERSION})`);
  for (const removed of ["comp-interaction-mode", "disp-imode"]) {
    assert.ok(!html.includes(removed), `index.html 仍包含 #${removed}`);
    assert.ok(!js.includes(removed), `app.js 仍引用 #${removed}`);
  }
  // 权限下拉不再写死跨引擎通用选项，由 JS 按引擎原生档位动态渲染
  for (const id of ["comp-perm-mode", "disp-perm"]) {
    const m = new RegExp(`<select id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html);
    assert.ok(m, `缺少 #${id}`);
    assert.equal(m[1].trim(), "", `#${id} 不应包含静态 <option>`);
  }
  assert.ok(!/value="approval-required"|value="auto-accept-edits"/.test(html), "静态 HTML 不应残留旧版通用权限值");
});

test("各引擎原生权限档位与后端目录逐项一致，高危档只在 full 阶", () => {
  const m = loadPermissionModule();
  const expected = {
    "claude-code": ["plan", "default", "acceptEdits", "auto", "bypassPermissions"],
    codex: ["read-only", "on-request", "auto", "full-access"],
    "kimi-code": ["plan", "default", "auto", "yolo"],
    antigravity: ["plan", "default", "accept-edits", "always-proceed"],
    generic: ["plan", "default", "auto", "full-access"],
  };
  for (const [profile, values] of Object.entries(expected)) {
    const ladder = m.PERMISSION_LADDERS[profile];
    assert.deepEqual(ladder.map((x) => x.value), values, `${profile} 档位`);
    assert.deepEqual(ladder.filter((x) => x.danger).map((x) => x.tier), ["full"], `${profile} 仅 full 阶高危`);
    const backend = PROVIDER_PERMISSION_MODES[profile];
    assert.deepEqual(ladder.map(({ value, label, tier, danger }) => ({ value, label, tier, danger })),
      backend.map(({ value, label, tier, danger }) => ({ value, label, tier, danger })), `${profile} 与 core/catalog.mjs 不一致`);
  }
  assert.equal(m.HOST_DEFAULT_PERMISSION.value, "host-default");
  assert.equal(m.HOST_DEFAULT_PERMISSION.disabled, true);
  assert.equal(m.permissionProfileOf("claude"), "claude-code");
  assert.equal(m.permissionProfileOf("agy"), "antigravity");
  assert.equal(m.permissionProfileOf("opencode"), "generic");
});

test("跨引擎切换永不落到高危档，且与后端归一化逐值一致", () => {
  const m = loadPermissionModule();
  for (const target of ENGINES) {
    const ladder = m.permissionLadderOf(target).map((x) => x.value);
    for (const source of ENGINES) {
      for (const value of [...m.permissionLadderOf(source).map((x) => x.value), ...LEGACY_VALUES]) {
        const cross = m.normalizePermissionForProvider(target, value, { crossEngine: true });
        assert.ok(ladder.includes(cross), `${source}:${value} → ${target} 得到非原生值 ${cross}`);
        assert.equal(m.isDangerPermissionFor(target, cross), false, `${source}:${value} → ${target} 跨引擎被提权到 ${cross}`);
        const same = m.normalizePermissionForProvider(target, value);
        assert.ok(ladder.includes(same), `${target}:${value} 同引擎归一化得到非原生值 ${same}`);
        // Claude 的 dontAsk 是后端接受但不在 UI 档位中展示的隐藏原生值，前端按 ask 阶显示为 default
        if (value && !(m.permissionProfileOf(target) === "claude-code" && value === "dontAsk")) {
          // 后端对显式输入更严格（非 Codex 的 read-only fail-closed）；前端无法下发 read-only，按 strictReadOnly:false 对照
          for (const crossEngine of [false, true]) {
            assert.equal(m.normalizePermissionForProvider(target, value, { crossEngine }),
              normalizePermissionModeForProvider(target, value, { crossEngine, strictReadOnly: false }),
              `${target}:${value} crossEngine=${crossEngine} 前后端不一致`);
          }
        }
      }
    }
  }
  // 安全红线：auto 绝不映射为跳过全部审批；他引擎专属的「跳过全部」不解锁目标高危档；旧版显式全放行别名仍兼容
  assert.equal(m.normalizePermissionForProvider("claude-code", "auto"), "auto");
  assert.equal(m.normalizePermissionForProvider("claude-code", "full-access"), "bypassPermissions");
  assert.equal(m.normalizePermissionForProvider("claude-code", "always-proceed"), "auto");
  assert.equal(m.normalizePermissionForProvider("codex", "bypassPermissions"), "auto");
  assert.equal(m.normalizePermissionForProvider("antigravity", "auto"), "accept-edits");
  assert.equal(m.normalizePermissionForProvider("antigravity", "yolo"), "always-proceed");
  assert.equal(m.normalizePermissionForProvider("codex", "auto-accept-edits"), "on-request");
  assert.equal(m.normalizePermissionForProvider("claude-code", "approval-required"), "default");
  assert.equal(m.normalizePermissionForProvider("kimi-code", "totally-unknown"), "default");
  assert.equal(m.normalizePermissionForProvider("claude-code", "read-only"), "plan");
  assert.equal(m.normalizePermissionForProvider("codex", "plan"), "read-only");
  assert.equal(m.normalizePermissionForProvider("claude-code", "bypassPermissions", { crossEngine: true }), "auto");
  assert.equal(m.deriveInteractionMode("plan"), "plan");
  for (const v of ["read-only", "default", "auto", "bypassPermissions", ""]) assert.equal(m.deriveInteractionMode(v), "default");
});

test("角色预设前端默认值与后端黄金默认的原生权限对齐，配置页渲染权限列", () => {
  const metaBlock = js.slice(js.indexOf("const ROLE_SLOT_META = ["), js.indexOf("const MEMBER_GROUPS = ["));
  const rows = [...metaBlock.matchAll(/key: '(\w+)'[\s\S]*?defaults: \{([^}]*)\}/g)];
  assert.equal(rows.length, 10);
  for (const [, key, body] of rows) {
    const field = (name) => new RegExp(`${name}: '([^']*)'`).exec(body)?.[1];
    assert.equal(field("permissionMode"), DEFAULT_ROLE_PRESETS[key].permissionMode, `${key}.permissionMode`);
    assert.equal(field("interactionMode"), DEFAULT_ROLE_PRESETS[key].interactionMode, `${key}.interactionMode`);
    assert.equal(field("provider"), DEFAULT_ROLE_PRESETS[key].provider, `${key}.provider`);
  }
  assert.match(js, /permissionMode: '权限策略'/);
  // v0.1.0：权限列位于成员内联抽屉（项目与全局成员池共用同一组触发器）
  assert.match(fnSource("presetFieldsGridHtml"), /presetTrigger\(p, p, 'permissionMode'(?:, \{ scope \})?\)/);
  assert.match(fnSource("presetOptions"), /field === 'permissionMode'\) return permissionOptionsFor\(cfg\.provider\)/);
  // 换引擎走跨引擎安全映射；同引擎旧值显示为原生等价档
  assert.match(fnSource("editRolePreset"), /remapPermissionOnProviderChange\(current, previous\.provider\)/);
  assert.match(fnSource("remapPermissionOnProviderChange"), /crossEngine/);
  assert.match(fnSource("mergeRemotePresets"), /normalizeIncomingPreset\(key, v\)/);
  assert.match(fnSource("normalizeIncomingPreset"), /normalizePermissionForProvider\(provider,/);
  // 宿主原生线程只展示禁用的 host-default
  assert.match(fnSource("permissionOptionsFor"), /isNativeHost && pid === 'antigravity'[\s\S]*disabled: true/);
  assert.match(fnSource("syncComposerSelects"), /permEl\.disabled = hostTarget/);
  // 请求一律按「仅 plan → Plan 交互」派生 interactionMode
  for (const name of ["handleComposerSubmit", "submitDispatchDrawer"]) {
    assert.match(fnSource(name), /deriveInteractionMode\(/, `${name} 未派生 interactionMode`);
  }
});

test("成员视图 HTML 串不含随时间跳变的耗时，抽屉操作栏走一次性事件委托", () => {
  const members = fnSource("renderMembersView");
  assert.ok(!members.includes("formatThreadElapsed("), "renderMembersView 的 HTML 串不得直接拼装实时耗时");
  assert.match(members, /memberElapsedSlotHtml\(t\)/);
  assert.match(members, /refreshLiveElapsedLabels\(listEl\)/);
  const slot = fnSource("memberElapsedSlotHtml");
  assert.match(slot, /if \(isStatusActive\(t\.status\)\) \{\s*return `<span class="member-ts-meta" data-elapsed-thread="\$\{escapeHtml\(t\.id\)\}" data-elapsed-live="1"><\/span>`;/);
  assert.match(fnSource("startLiveStopwatchTicker"), /refreshLiveElapsedLabels\(document\)/);

  const drawer = fnSource("renderMemberDrawer");
  assert.ok(!drawer.includes("addEventListener"), "renderMemberDrawer 每次重绘都会叠加监听器");
  for (const action of ["to-composer", "stop", "retry", "switch-model", "astra-review"]) {
    assert.ok(drawer.includes(`data-md-action="${action}"`), `抽屉缺少 data-md-action="${action}"`);
  }
  const bind = fnSource("bindGlobalEvents");
  assert.match(bind, /getElementById\('md-actions-bar'\)\?\.addEventListener\('click'/);
  assert.match(bind, /getElementById\('md-timeline-body'\)\?\.addEventListener\('toggle'[\s\S]*?, true\);/);
  assert.equal((js.match(/getElementById\('md-actions-bar'\)\?\.addEventListener/g) || []).length, 1);

  // installInnerHtmlNoopGuard：同串同子节点数直接短路
  assert.match(js, /this\.__atLastHtml === next &&\s*this\.__atLastChildCount === this\.childNodes\.length/);
});

test("中断入口按 cancelCapability 渲染，两阶段强杀绑定首击 runId", () => {
  const cap = fnSource("threadCancelCapability");
  assert.match(cap, /'reconcilable_orphan'/);
  assert.match(cap, /host_only/);
  const control = fnSource("memberCancelControlHtml");
  assert.match(control, /capability === 'host_only'\) \{\s*return '<span class="host-managed-hint"/);
  assert.ok(!/host_only[^\n]*data-quick-stop/.test(control), "宿主原生回合不得渲染假停止按钮");
  const cancel = fnSource("handleTwoStageCancel");
  assert.match(cancel, /const expectedRunId = tracker\?\.runId \|\| thread\.activeRunId/);
  assert.match(cancel, /rpcCall\('cancelTask', \{ threadId, force, expectedRunId/);
  assert.match(cancel, /runId: expectedRunId \|\| ''/);
  assert.match(cancel, /state\.cancelInFlight\.has\(threadId\)\) return/);
  for (const outcome of ["stale_run", "orphaned_reconciled", "host_only"]) assert.ok(cancel.includes(outcome), `未处理 ${outcome}`);
  assert.match(fnSource("renderComposerState"), /threadCancelCapability\(activeThread\)/);
});

test("告警忽略闭环：乐观隐藏 + 迟到快照过滤 + 徽标联动 + 自愈事件", () => {
  assert.match(js, /dismissedIncidentIds: new Set\(\)/);
  const dismiss = fnSource("handleDismissHealthIncident");
  assert.ok(dismiss.indexOf("state.dismissedIncidentIds.add(id)") < dismiss.indexOf("rpcCall('dismissHealthIncident'"), "必须先乐观隐藏再发 RPC");
  assert.match(dismiss, /state\.dismissedIncidentIds\.delete\(id\)/, "失败时需回滚");
  assert.match(dismiss, /workspace: convId \? undefined : state\.workspace \|\| undefined/, "作用域需与 api/events 轮询一致");
  assert.match(fnSource("ingestStreamPayload"), /acceptOpenIncidents\(payload\.healthIncidents\)/);
  assert.match(fnSource("applyBootstrapSnapshot"), /acceptOpenIncidents\(data\.healthIncidents\)/);
  assert.match(fnSource("acceptOpenIncidents"), /!state\.dismissedIncidentIds\.has/);
  assert.match(fnSource("renderThreadHealthBadgeHtml"), /state\.dismissedIncidentIds\.has\(String\(h\.incidentId\)\)/);
  const apply = fnSource("applySingleEvent");
  assert.match(apply, /type === 'health_incident_resolved'/);
  // P0-4：回合开始 / 结束合并完整线程快照
  assert.match(apply, /if \(snapshotThread\) upsertLocalThread\(snapshotThread\)/);
  assert.match(apply, /const isRunStart = type === 'run_started'/);
  assert.match(apply, /const isRunFinish = type === 'run_completed'/);
});

test("派发闸门直出回滚草稿、Worktree 合入二次确认与 Diff 防乱序", () => {
  const composer = fnSource("handleComposerSubmit");
  assert.match(composer, /res\?\.bypassed\) \{\s*restoreDraft\(\);/);
  assert.match(composer, /sendRes\?\.bypassed\) \{\s*rollback\(\);\s*restoreDraft\(\);/);
  const dispatch = fnSource("submitDispatchDrawer");
  assert.equal((dispatch.match(/\?\.bypassed\) \{\s*showDispatchBypassedToast/g) || []).length, 3, "批量 / 顶层会话 / 子任务三条派发路径都需处理 bypassed");
  assert.match(fnSource("submitCouncilSummon"), /res\?\.bypassed/);

  const integrate = fnSource("handleIntegrateWorktree");
  assert.match(integrate, /if \(!armOrConfirm\(worktreeIntegrateConfirmKey\(wt, strategy\)/);
  assert.match(integrate, /cleanupError/);
  const diff = fnSource("loadSelectedWorktreeDiff");
  assert.match(diff, /const seq = \+\+state\.worktreeDiffSeq/);
  assert.match(diff, /if \(seq !== state\.worktreeDiffSeq/);
  const apply = fnSource("applySingleEvent");
  assert.match(apply, /removeLocalWorktreeByPath\(cleanedPath\)/);
});

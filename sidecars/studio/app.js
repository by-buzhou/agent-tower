/**
 * AgentTower · 前端工作台组合入口 v0.2.0（三类 Spec 按需注入 + 运行缓存安全清理 + 三档编排模式胶囊）（浏览器原生 ES Module，零构建依赖）
 * 像官方原生 Swarm 插件一样严格单会话独立隔离 (Per-Conversation Isolation)：
 * 1. 宿主内嵌模式绑定当前对话 conversationId（URL/sidecar 变化立即 resetForConversation 清空重拉），禁用 EventSource；
 * 2. 两行极简 Swarm 顶栏 + 空协作引导卡 + 无边框双列 Board + 聚合详情抽屉；
 * 3. 底部紧凑配置胶囊 Composer（联动型号/思考档位/跟随默认/自定义模型 ID/排队条/Steer/两段式 2 秒强制终止）。
 *
 * 本文件只做组合：安装 DOM 护栏与自绘下拉 → 写入环境相关初始状态 → 注册视图 → 绑定全局事件 →
 * 首屏同步渲染与秒表 → window.load 后延迟网络同步。各子模块位于 ./ui/*.js，顶层零副作用。
 */
import { fileUriToPath, normalizeProjectPath } from './ui/format.js';
import { installInnerHtmlNoopGuard } from './ui/dom-guards.js';
import { FALLBACK_PROVIDERS, ROLE_SLOT_META, STUDIO_FRONTEND_BUILD, getHostConversationId, getInitialQueryConversationId, getInitialQueryWorkspace, boardLimitFor, readStoredBoardPageSize, readStoredSettingsPane, seedPreset, settingsScopeOf, state } from './ui/state.js';
import { registerViews, renderApp, scheduleRender } from './ui/render.js';
import { isEmbeddedHost, showToast } from './ui/net.js';
import { normalizeProvidersCatalog } from './ui/normalize.js';
import { hasPendingGlobalPresetChanges, hasPendingPresetChanges, restorePresetDrafts, saveAllGlobalRolePresets, saveAllRolePresets } from './ui/presets.js';
import { presetOptions, syncComposerSelects } from './ui/options.js';
import { connectRealtimeStream, loadBootstrap, recoverBootstrap, resetForConversation } from './ui/stream.js';
import { renderDiffView } from './ui/worktree-view.js';
import { editGlobalRolePreset, editRolePreset, refreshExtensionProviders, renderGlobalSettingsView, renderSettingsView } from './ui/config-view.js';
import { renderBoardView } from './ui/board-view.js';
import { renderMemberDrawer, renderMembersView, startLiveStopwatchTicker } from './ui/members-view.js';
import { renderComposerState, renderDispatchPausedStrip, renderGlobalRequestsBanner, renderHeaderAndTitleBar, renderMainViewTabs, renderWatchdogIncidentsBanner } from './ui/composer.js';
import { initCustomSelect } from './ui/custom-select.js';
import { setupHostThemeSync } from './ui/theme.js';
import { bindGlobalEvents } from './ui/events.js';

/* ========================================================================
 * 15. 零阻塞首屏启动入口：同步完成首屏渲染后异步建连与宿主工作区对齐
 * ======================================================================== */
async function resolveInitialHostWorkspace() {
  if (state.workspace) return state.workspace;
  if (!window.sidecar?.getWorkspaceUris) return '';
  try {
    const uris = await Promise.race([
      window.sidecar.getWorkspaceUris(),
      new Promise((resolve) => setTimeout(() => resolve([]), 250)),
    ]);
    if (Array.isArray(uris) && uris.length > 0) {
      const resolved = normalizeProjectPath(fileUriToPath(uris[0]));
      if (resolved) state.workspace = resolved;
    }
  } catch {}
  return state.workspace;
}

function checkHostConversationChange() {
  if (!isEmbeddedHost()) return false;
  const liveHostConv = getHostConversationId();
  if (!liveHostConv || liveHostConv === state.activeConversationId) return false;
  void resetForConversation(liveHostConv);
  return true;
}

function flushPendingAllPresets() {
  const tasks = [];
  if (hasPendingPresetChanges()) tasks.push(saveAllRolePresets());
  if (hasPendingGlobalPresetChanges()) tasks.push(saveAllGlobalRolePresets());
  return tasks.length ? Promise.all(tasks) : undefined;
}

function startDeferredNetworkSync() {
  // 严格单会话隔离：工作区变更仅更新新建外部任务默认 cwd 提示，严禁跨对话切换项目或混入数据
  if (window.sidecar?.onWorkspaceChange) {
    window.sidecar.onWorkspaceChange((uris) => {
      const nextWs = Array.isArray(uris) && uris.length > 0 ? normalizeProjectPath(fileUriToPath(uris[0])) : '';
      if (nextWs) {
        state.workspace = nextWs;
      }
    });
  }

  const workspaceReady = resolveInitialHostWorkspace();
  const bootstrap = getHostConversationId() ? loadBootstrap() : workspaceReady.then(() => loadBootstrap());
  bootstrap
    .then(() => flushPendingAllPresets())
    .then(() => void refreshExtensionProviders(true))
    .catch((err) => {
      state.connMode = 'offline';
      scheduleRender();
      showToast(`正在等待编排守护服务就绪: ${err.message}`);
    })
    .finally(() => {
      connectRealtimeStream();
    });
}

function initStudioShellSync() {
  document.addEventListener('input', e => {
    if (e.target.matches('#review-base-branch,#review-cwd-input,#disp-cwd')) e.target.dataset.atDraft = '1';
  });
  if (typeof window.sidecar?.onConversationChange === 'function') {
    window.sidecar.onConversationChange(checkHostConversationChange);
  }
  window.addEventListener('focus', checkHostConversationChange);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void flushPendingAllPresets();
    // 侧栏重新可见且处于离线 / 首屏快照未就绪：幂等补拉完整 Bootstrap 唤醒重连（关开面板即可自愈）
    if (document.visibilityState === 'visible' && checkHostConversationChange()) return;
    if (document.visibilityState === 'visible' && (state.connMode === 'offline' || !state.bootstrapLoaded)) void recoverBootstrap();
  });
  window.addEventListener('pagehide', () => {
    void flushPendingAllPresets();
  });
  restorePresetDrafts();
  setupHostThemeSync();
  bindGlobalEvents();
  syncComposerSelects();
  renderApp();
  startLiveStopwatchTicker();
  window.__AT_BOOTED = true;

  // 确保 window.load 事件已触发完毕后再发起异步网络同步，杜绝宿主面板转圈圈
  if (document.readyState === 'complete') {
    setTimeout(startDeferredNetworkSync, 16);
  } else {
    window.addEventListener(
      'load',
      () => {
        setTimeout(startDeferredNetworkSync, 16);
      },
      { once: true }
    );
  }
}

/** 写入依赖宿主 / 浏览器环境的初始状态（与原 IIFE 求值 state 字面量时的取值一致）。 */
function initState() {
  state.workspace = getInitialQueryWorkspace();
  // 宿主 sidecar 硬锁定优先；独立网页端 ?conversationId= 仅作首屏初始绑定，之后可经顶栏下拉切换
  state.activeConversationId = getHostConversationId() || getInitialQueryConversationId();
  state.conversationUnbound = !state.activeConversationId;
  state.connMode = isEmbeddedHost() ? 'poll' : 'connecting';
  state.settingsPane = readStoredSettingsPane();
  state.settingsScope = settingsScopeOf(state.settingsPane);
  state.settingsScopePanes[state.settingsScope] = state.settingsPane;
  state.boardPageSize = readStoredBoardPageSize();
  state.boardVisibleLimit = boardLimitFor(state.boardPageSize);
  // 离线兜底：内置种子成员（含 group / enabled / builtin）；Bootstrap 下发的动态成员池随后整体覆盖
  for (const slot of ROLE_SLOT_META) {
    state.presets[slot.key] = seedPreset(slot.key);
    state.globalPresets[slot.key] = seedPreset(slot.key);
  }
  state.providers = normalizeProvidersCatalog(FALLBACK_PROVIDERS, false, []);
  state.loadedAssetHash = document.querySelector('meta[name="agent-tower-asset-hash"]')?.content || '';
}

function bootStudio() {
  installInnerHtmlNoopGuard();
  const isGlobalSelect = (el) => el.dataset.psScope === 'global' || Boolean(el.closest?.('#global-role-presets-grid'));
  initCustomSelect({
    getOptions: (el) => presetOptions((isGlobalSelect(el) ? state.globalPresets : state.presets)[el.dataset.psKey], el.dataset.psField),
    onChoose: (el, value) => (isGlobalSelect(el) ? editGlobalRolePreset : editRolePreset)(el.dataset.psKey, el.dataset.psField, value),
    onOpenChange: (open) => {
      state.uiRenderFrozen = open;
      if (!open && state.uiRenderDeferred) {
        state.uiRenderDeferred = false;
        scheduleRender();
      }
    },
  });
  const tag = document.getElementById('studio-build-tag');
  if (tag) tag.textContent = `前端构建 ${STUDIO_FRONTEND_BUILD}`;
  initState();
  registerViews({
    chrome: [renderHeaderAndTitleBar, renderMainViewTabs, renderDispatchPausedStrip, renderWatchdogIncidentsBanner, renderGlobalRequestsBanner],
    main: { board: renderBoardView, members: renderMembersView, diff: renderDiffView, settings: renderSettingsView, global: renderGlobalSettingsView },
    drawer: renderMemberDrawer,
    composer: renderComposerState,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStudioShellSync);
  } else {
    initStudioShellSync();
  }
}

bootStudio();

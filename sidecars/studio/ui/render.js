/**
 * AgentTower Studio — 渲染调度与视图注册表 (`ui/render.js`)
 * scheduleRender 以 rAF 合帧；renderApp 只遍历 app.js 注入的视图注册表，不反向 import 任何具体视图。
 */
import { state, syncActiveTargetThread } from './state.js';

/* ========================================================================
 * 10. UI 渲染引擎（Swarm 风格单栏 + 5 大核心视图）
 * ======================================================================== */
export function scheduleRender() {
  if (state.renderScheduled) return;
  state.renderScheduled = true;
  requestAnimationFrame(() => {
    state.renderScheduled = false;
    renderApp();
  });
}

/**
 * 视图注册表：由组合入口 app.js 在启动时注入具体渲染函数（render.js 不反向 import 任何视图模块）。
 * - chrome：每帧按序刷新的顶栏 / 标签 / 停发条 / 告警横幅 / 待批横幅；
 * - main：按 state.activeView 选择的主视图；drawer：成员详情抽屉；composer：底部输入栏。
 */
const viewRegistry = { chrome: [], main: {}, drawer: null, composer: null };

export function registerViews({ chrome = [], main = {}, drawer = null, composer = null } = {}) {
  viewRegistry.chrome = [...chrome];
  viewRegistry.main = { ...main };
  viewRegistry.drawer = drawer;
  viewRegistry.composer = composer;
}

export function renderApp() {
  if (state.uiRenderFrozen) {
    state.uiRenderDeferred = true;
    return;
  }
  syncActiveTargetThread();
  renderSystemUpdateBadge();
  for (const renderChrome of viewRegistry.chrome) renderChrome();

  if (Object.hasOwn(viewRegistry.main, state.activeView)) viewRegistry.main[state.activeView]();

  if (state.detailDrawerThreadId) {
    viewRegistry.drawer?.();
  }
  viewRegistry.composer?.();
  if (state.mainScrollResetPending) {
    state.mainScrollResetPending = false;
    const area = document.getElementById('studio-main');
    if (area) area.scrollTop = 0;
  }
}

export function renderSystemUpdateBadge() {
  const badge = document.getElementById('topbar-update-badge');
  if (!badge) return;
  const update = state.systemUpdate;
  const version = String(update?.latestVersion || '');
  const visible = update?.hasUpdate === true && Boolean(version) && version !== String(update?.dismissedVersion || '');
  badge.hidden = !visible;
  if (!visible) return;
  const displayVersion = version.startsWith('v') ? version : `v${version}`;
  const label = `⬆ ${displayVersion}`;
  if (badge.textContent !== label) badge.textContent = label;
  badge.title = `发现 ${displayVersion}，点击查看版本与更新说明`;
}

export function resetBoardFollow() {
  state.boardUserScrolledUp = false;
  state.boardFollow = true;
  state.boardNeedsAutoScroll = true;
}

export function scrollMainToBottom() {
  const area = document.getElementById('studio-main');
  if (!area || state.activeView !== 'board') return;
  area.scrollTop = area.scrollHeight;
  updateJumpLatestButtonVisibility();
}

export function updateJumpLatestButtonVisibility() {
  const area = document.getElementById('studio-main');
  const jumpBtn = document.getElementById('btn-jump-latest');
  if (!area || !jumpBtn) return;
  const dist = area.scrollHeight - area.scrollTop - area.clientHeight;
  jumpBtn.hidden = dist < 120 || state.activeView !== 'board';
}

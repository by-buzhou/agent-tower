/**
 * AgentTower Studio — 主视图切换与文件定位 (`ui/nav.js`)

 */
import { pathToFileUri, shortenPath } from './format.js';
import { GLOBAL_SETTINGS_PANES, PROJECT_SETTINGS_PANES, state } from './state.js';
import { resetBoardFollow, scheduleRender } from './render.js';
import { copyPlainText, showToast } from './net.js';
import { refreshWorktreesList } from './worktree-view.js';
import { refreshExtensionProviders } from './config-view.js';

export function setActiveView(viewName) {
  const nextView = ['board', 'members', 'diff', 'settings', 'global'].includes(viewName) ? viewName : 'board';
  state.activeView = nextView;
  const appEl = document.getElementById('studio-app');
  if (appEl) appEl.dataset.view = nextView;
  if (nextView === 'board') resetBoardFollow();
  if (nextView === 'settings') {
    state.settingsScope = 'project';
    const remembered = state.settingsScopePanes.project;
    state.settingsPane = PROJECT_SETTINGS_PANES.includes(remembered) ? remembered : 'roles';
    state.settingsScopePanes.project = state.settingsPane;
  } else if (nextView === 'global') {
    state.settingsScope = 'global';
    const remembered = state.settingsScopePanes.global;
    state.settingsPane = GLOBAL_SETTINGS_PANES.includes(remembered) ? remembered : 'general';
    state.settingsScopePanes.global = state.settingsPane;
  }
  if (nextView === 'members' || nextView === 'settings' || nextView === 'global') {
    const area = document.getElementById('studio-main');
    if (area) area.scrollTop = 0;
    requestAnimationFrame(() => { if (area && state.activeView === nextView) area.scrollTop = 0; });
  }
  if (nextView === 'settings' || nextView === 'global') {
    // 配置页不需要聊天底栏：关闭参数浮层，并在本帧渲染后再次置顶（防止从看板底部切来落在中段）
    state.composerPopoverOpen = false;
    state.mainScrollResetPending = true;
  }
  if (nextView === 'diff') void refreshWorktreesList();
  else if (nextView === 'global') void refreshExtensionProviders(true);
  document.querySelector(`#main-view-tabs .sw-tab[data-view="${nextView}"]`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  scheduleRender();
}

export function openFileInHostOrInspector(filePath, baseDir = '') {
  if (!filePath) return;
  if (window.sidecar?.ui?.toggleAuxPane) {
    const uri = pathToFileUri(filePath, baseDir);
    window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri });
    showToast(`已在宿主侧栏请求打开 ${shortenPath(filePath)}`);
    return;
  }
  // 独立浏览器无宿主侧栏：命中当前 Diff 文件则切到变更页并选中，否则复制完整路径供本地编辑器打开
  const diffPath = matchCurrentDiffFile(filePath, baseDir);
  if (diffPath) {
    state.selectedDiffFile = diffPath;
    setActiveView('diff');
    showToast(`独立浏览器模式：已在变更页定位 ${shortenPath(diffPath)}`);
    return;
  }
  const fullPath = resolveFullPath(filePath, baseDir);
  void copyPlainText(fullPath).then((ok) => showToast(
    ok ? `独立浏览器模式：已复制文件路径 ${fullPath}` : `独立浏览器模式：复制失败，文件路径 ${fullPath}`,
    ok ? 'success' : 'error'
  ));
}

function resolveFullPath(rawPath, baseDir = '') {
  const p = String(rawPath || '');
  if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('/') || p.startsWith('\\\\') || !baseDir) return p;
  return `${String(baseDir).replace(/[\\/]+$/, '')}/${p.replace(/^(\.[\\/])+/, '').replace(/^[\\/]+/, '')}`;
}

const diffPathKey = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();

/** 在当前 Diff 文件列表中查找目标文件（兼容相对 / 绝对路径与大小写差异），返回 Diff 内的原始路径。 */
function matchCurrentDiffFile(filePath, baseDir = '') {
  const files = Array.isArray(state.currentWorktreeDiff?.files) ? state.currentWorktreeDiff.files : [];
  const target = diffPathKey(filePath);
  const full = diffPathKey(resolveFullPath(filePath, baseDir));
  for (const f of files) {
    const raw = typeof f === 'string' ? f : String(f?.path || f?.filePath || f?.file || '');
    const key = diffPathKey(raw);
    if (!key) continue;
    if (key === target || key === full || full.endsWith(`/${key}`) || target.endsWith(`/${key}`)) return raw;
  }
  return '';
}

/**
 * AgentTower Studio — 全局事件委托绑定 (`ui/events.js`)
 * 保持原 bindGlobalEvents 的注册顺序不变（同一元素同类事件的监听先后即行为契约）。
 */
import { deriveInteractionMode, normalizePermissionForProvider } from './permissions.js';
import { BOARD_PAGE_SIZES, EMPTY_MEMBER_FALLBACK, applyThreadToComposerConfig, boardLimitFor, currentOrchestrationMode, getEffectiveConversationId, getEffectiveCwd, getScopedWorktrees, fallbackGroupPreset, isStatusActive, preferredGroupPreset, state, storeBoardPageSize } from './state.js';
import { resetBoardFollow, scheduleRender, scrollMainToBottom, updateJumpLatestButtonVisibility } from './render.js';
import { copyPlainText, isEmbeddedHost, rpcCall, showToast } from './net.js';
import { normalizeProvidersCatalog, normalizeThread, presetDispatchRoute, shortMemberName } from './normalize.js';
import { saveAllGlobalRolePresets, saveAllRolePresets } from './presets.js';
import { isComposerNativeHostTarget, populateLinkedSelectTrio, reconcileModelSelection, remapPermissionOnProviderChange, syncComposerSelects } from './options.js';
import { cancelCustomModelModal, confirmCustomModelModal, handleModelSelectChange } from './custom-model.js';
import { UNBOUND_CONVERSATION_HINT, closeMemberDrawer, hydrateOrderRunItems, isConversationDispatchEnabled, loadBootstrap, resetForConversation } from './stream.js';
import { applySystemUpdate, cancelSystemUpdate, checkSystemUpdates, dismissSystemUpdate, handleTwoStageCancel, respondToRequest, rollbackSystemUpdate, setProjectExternalSessionMode, toggleAutoCheckUpdates, toggleDefaultExternalSessionVisible } from './actions.js';
import { handleCleanupWorktree, handleIntegrateWorktree, loadSelectedWorktreeDiff, refreshWorktreesList, selectWorktree } from './worktree-view.js';
import { applyCatalogFilter, applyExtLibState, cancelAddGlobalMember, cancelAddMember, confirmAddGlobalMember, confirmAddMember, confirmSpecProposal, copyText, deleteCustomMember, deleteGlobalCustomMember, dismissSpecProposal, editGlobalRolePreset, editRolePreset, editingGlobalModeProfile, editingModeProfile, gotoProjectSpecsSection, gotoRolePreset, handleArchiveProjectSpecs, handleCleanRuntimeCache, handleInitProjectSpecs, handleResetRosterToGlobal, handleRestoreProjectSpecs, handleSyncPluginSpecTemplates, handleSyncRosterToGlobal, openProjectSpecInEditor, quickEnableTemplateProvider, refreshExtensionProviders, refreshRuntimeCacheStatus, reloadProjectSpecs, removeOrDisableExtension, revealSpecCurationPanel, saveSpecCurationLimits, setEditingModeProfile, setGlobalEditingModeProfile, setGlobalMemberDraftGroup, setGlobalMemberLabel, setGlobalModePreferred, setMemberDraftGroup, setMemberLabel, setModePreferred, setSettingsPane, setSpecCurationDetailOpen, startAddGlobalMember, startAddMember, submitSpecCurationTrigger, submitSpecProposalRevise, toggleCatalogProvider, toggleDefaultSpecEnabled, toggleGlobalMemberDrawer, toggleGlobalModeMember, toggleGlobalModeStage, toggleGlobalPoolGroup, toggleMemberDrawer, toggleModeMember, toggleModeStage, togglePoolGroup, toggleProjectSpec, toggleProjectSpecEnabled, toggleSpecCurationAuto, toggleSpecCurationTriggerBar, toggleSpecProposalRevise, updateGlobalMemberDraftField, updateMemberDraftField, updateSpecCurationDraft } from './config-view.js';
import { openFileInHostOrInspector, setActiveView } from './nav.js';
import { handleArchiveIdleMembers, handleDeleteThread, jumpToNativeHostConversation, openMemberDrawer } from './members-view.js';
import { renderBoardView, revealBoardSeq } from './board-view.js';
import { closeModePopover, focusThreadInComposer, handleChangeDefaultOrchestrationMode, handleComposerSubmit, handleDismissHealthIncident, handleQueueAction, handleSetOrchestrationMode, handleToggleConversationDispatch, openModePopover, positionModePopover, renderComposerState } from './composer.js';
import { applyPresetToDispatchForm, batchRowFromPreset, closeCodeReviewModal, closeCouncilModal, executeRetry, fillBatchTemplate, handleReviewPoolAction, openCouncilModal, openDispatchDrawer, openExtensionWizard, openRetryModal, probeWizardExtension, renderBatchDraftRows, renderDispatchDrawerMode, renderDispatchPermSelect, renderReviewModalState, saveWizardExtension, selectReviewMember, submitCodeReviewModal, submitCouncilSummon, submitDispatchDrawer, triggerAstraCodeReview } from './modals.js';
import { setThemeMode, toggleStudioTheme } from './theme.js';
import { toggleSpecBadge } from './widgets.js';

/** 独立网页端「复制链接」：同源根路径 + 当前已绑定会话 / 有效工作区，绝不携带 auth 等敏感参数。 */
function buildStandaloneShareUrl() {
  const url = new URL('/', window.location.origin);
  const conv = getEffectiveConversationId();
  const cwd = getEffectiveCwd();
  if (conv) url.searchParams.set('conversationId', conv);
  if (cwd) url.searchParams.set('workspace', cwd);
  return url.toString();
}

/** v0.2.11 规范维护提案待办一键定位：配置页「当前项目 → 项目规范与缓存」→ 项目规范卡片顶部的提案确认卡。 */
function gotoSpecCurationProposal() {
  setActiveView('settings');
  setSettingsPane('project', { resetScroll: false });
  revealSpecCurationPanel();
}

function gotoSystemUpdateSection() {
  setActiveView('global');
  setSettingsPane('general', { resetScroll: false });
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const section = document.getElementById('system-update-section');
    section?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    section?.focus?.({ preventScroll: true });
  }));
}

/* ========================================================================
 * 14. 事件委托绑定与秒表驱动器
 * ======================================================================== */
export function bindGlobalEvents() {
  // 1. 独立浏览器无宿主 conversationId 时的手动对话切换（宿主内隐藏）
  document.getElementById('standalone-conv-select')?.addEventListener('change', (e) => {
    const nextConvId = String(e.target.value || '').trim();
    if (nextConvId) {
      void resetForConversation(nextConvId);
    }
  });

  // 2. 官方空状态引导卡片快捷入口
  document.getElementById('btn-empty-council')?.addEventListener('click', () => {
    openCouncilModal();
  });
  document.getElementById('btn-empty-dispatch')?.addEventListener('click', () => {
    openDispatchDrawer('single');
  });

  // 3. 顶栏 Tabs 切换
  document.getElementById('main-view-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-view]');
    if (btn) setActiveView(btn.dataset.view);
  });

  // 4. 顶栏主题 / 刷新 / Token Popover / 派发抽屉
  // 按当前已生效的 data-theme 直接翻转（暗 → 亮 / 亮 → 暗），写入 localStorage，图标与 title 即时切换
  document.getElementById('btn-theme-toggle')?.addEventListener('click', () => {
    toggleStudioTheme();
    scheduleRender();
  });

  document.getElementById('btn-refresh-all')?.addEventListener('click', () => {
    void loadBootstrap()
      .then(() => showToast('已刷新项目编排状态', 'success'))
      .catch((err) => showToast(err.message, 'error'));
  });
  document.getElementById('topbar-update-badge')?.addEventListener('click', gotoSystemUpdateSection);

  document.getElementById('btn-open-dispatch')?.addEventListener('click', () => openDispatchDrawer('single'));
  document.getElementById('btn-board-dispatch')?.addEventListener('click', () => openDispatchDrawer('single'));

  document.getElementById('btn-token-breakdown')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = document.getElementById('token-popover');
    if (pop) pop.hidden = !pop.hidden;
  });

  document.getElementById('btn-copy-studio-url')?.addEventListener('click', () => {
    if (!isEmbeddedHost()) {
      // 独立网页端：不调 studioStatus，按当前已绑定会话与工作区拼出无密链接（会话凭据仅存于本浏览器 Cookie）
      const url = buildStandaloneShareUrl();
      void copyPlainText(url).then((ok) => showToast(ok
        ? '已复制当前对话访问链接（当前浏览器可直接打开；跨浏览器请从宿主面板复制）'
        : `复制失败，请手动复制：${url}`, ok ? 'success' : 'error'));
      return;
    }
    if (!state.studioUrl) return;
    void rpcCall('studioStatus')
      .then(async (status) => {
        const url = String(status?.launchUrl || status?.studioUrl || '');
        if (!url || !(await copyPlainText(url))) throw Error('copy failed');
      })
      .then(() => showToast('已复制浏览器全屏访问地址', 'success'))
      .catch(() => showToast('请通过受信的 studio_status 获取首次访问地址'));
  });

  // v0.1.1 顶栏三档模式胶囊：点击 / ↓ / Enter / Space 展开浮层；浮层内 ↑ ↓ 漫游、Enter 选中、Esc 关闭并回焦胶囊；「配置阵容 →」直达对应阵容
  const modePill = document.getElementById('btn-conv-dispatch-toggle');
  const modePop = document.getElementById('conv-mode-popover');
  const blockUnboundModePill = () => {
    if (!state.conversationUnbound) return false;
    showToast(`尚未选择对话：${UNBOUND_CONVERSATION_HINT}`, 'info');
    return true;
  };
  modePill?.addEventListener('click', (e) => {
    if (blockUnboundModePill()) return;
    if (state.modePopoverOpen) closeModePopover();
    else openModePopover(e.detail === 0);
  });
  modePill?.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modePopoverOpen) { e.preventDefault(); closeModePopover(true); return; }
    if (!['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    if (blockUnboundModePill()) return;
    openModePopover(true);
  });
  const chooseModeItem = (item) => {
    if (!item) return;
    if (item.hasAttribute('data-mode-goto-config')) {
      closeModePopover();
      setActiveView('global');
      setSettingsPane('general');
      return;
    }
    if (item.dataset.modeGotoRoster) {
      closeModePopover();
      state.editingModeProfile = item.dataset.modeGotoRoster === 'complex' ? 'complex' : 'relay';
      state.openMemberKey = '';
      setActiveView('settings');
      setSettingsPane('roles');
      return;
    }
    const mode = item.dataset.modeOption;
    closeModePopover(true);
    if (mode && mode !== currentOrchestrationMode()) void handleSetOrchestrationMode(mode);
  };
  modePop?.addEventListener('click', (e) => {
    chooseModeItem(e.target.closest('[data-mode-option], [data-mode-goto-config], [data-mode-goto-roster]'));
  });
  modePop?.addEventListener('keydown', (e) => {
    const items = [...modePop.querySelectorAll('[role^="menuitem"]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = i < 0 ? 0 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items[next]?.focus({ preventScroll: true });
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      items[e.key === 'Home' ? 0 : items.length - 1]?.focus({ preventScroll: true });
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      chooseModeItem(document.activeElement?.closest?.('[data-mode-option], [data-mode-goto-config], [data-mode-goto-roster]'));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeModePopover(true);
    } else if (e.key === 'Tab') {
      closeModePopover();
    }
  });
  window.addEventListener('resize', () => positionModePopover());
  // 鼠标展开后焦点不在浮层内时，Esc 同样关闭并回焦胶囊
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && state.modePopoverOpen && !modePop?.contains(e.target) && e.target !== modePill) closeModePopover(true);
  });
  document.getElementById('btn-settings-toggle-dispatch')?.addEventListener('click', () => {
    void handleToggleConversationDispatch(!isConversationDispatchEnabled());
  });
  document.getElementById('sel-default-dispatch-mode')?.addEventListener('change', (e) => {
    void handleChangeDefaultOrchestrationMode(e.target.value);
  });
  document.getElementById('dispatch-paused-strip')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-paused-action]');
    if (!btn) return;
    const act = btn.dataset.pausedAction;
    if (act === 'switch_relay' || act === 'switch_simple' || act === 'resume') {
      void handleSetOrchestrationMode('relay');
    } else if (act === 'cancel_running') {
      void handleSetOrchestrationMode('direct', { cancelRunning: true });
    }
  });
  document.getElementById('watchdog-incidents-banner')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-inc-action]');
    if (!btn) return;
    const act = btn.dataset.incAction;
    if (act === 'locate' && btn.dataset.incThread) {
      openMemberDrawer(btn.dataset.incThread);
    } else if (act === 'dismiss' && btn.dataset.incId) {
      void handleDismissHealthIncident(btn.dataset.incId, false);
    } else if (act === 'dismiss_all') {
      void handleDismissHealthIncident('', true);
    }
  });

  // 5. 看板 (Board) 控制区 & Feed 交互委托
  document.getElementById('board-search-input')?.addEventListener('input', (e) => {
    state.boardSearch = e.target.value;
    scheduleRender();
  });

  document.getElementById('btn-board-filter-toggle')?.addEventListener('click', () => {
    state.boardFiltersOpen = !state.boardFiltersOpen;
    scheduleRender();
  });

  document.getElementById('chk-board-follow')?.addEventListener('change', (e) => {
    state.boardFollow = Boolean(e.target.checked);
    if (state.boardFollow) { state.boardUserScrolledUp = false; scrollMainToBottom(); }
  });

  document.getElementById('btn-board-clear-filters')?.addEventListener('click', () => {
    state.boardSearch = '';
    state.boardMemberFilters.clear();
    const sInput = document.getElementById('board-search-input');
    if (sInput) sInput.value = '';
    scheduleRender();
  });

  // v0.2.10.2 看板默认展示档位：20 / 50 / 全部（持久化 localStorage），切档即重置可见窗口
  document.getElementById('board-page-size')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-board-limit]');
    const size = btn?.dataset.boardLimit;
    if (!size || !BOARD_PAGE_SIZES.includes(size)) return;
    state.boardPageSize = size;
    state.boardVisibleLimit = boardLimitFor(size);
    storeBoardPageSize(size);
    if (!state.boardUserScrolledUp) state.boardNeedsAutoScroll = true;
    scheduleRender();
  });

  document.getElementById('board-member-chips')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-expand-board-chips]')) {
      state.boardChipsExpanded = true;
      scheduleRender();
      return;
    }
    const chip = e.target.closest('[data-chip-thread]');
    if (!chip) return;
    const tid = chip.dataset.chipThread;
    if (state.boardMemberFilters.has(tid)) state.boardMemberFilters.delete(tid);
    else state.boardMemberFilters.add(tid);
    scheduleRender();
  });

  document.getElementById('btn-summon-council')?.addEventListener('click', openCouncilModal);
  document.getElementById('btn-astra-review')?.addEventListener('click', () => void triggerAstraCodeReview());

  document.getElementById('btn-jump-latest')?.addEventListener('click', () => {
    resetBoardFollow();
    scrollMainToBottom();
    scheduleRender();
  });

  document.getElementById('studio-main')?.addEventListener('scroll', ({ currentTarget: area }) => {
    if (state.activeView !== 'board') return;
    const dist = area.scrollHeight - area.scrollTop - area.clientHeight;
    if (dist > 100) state.boardUserScrolledUp = true;
    if (dist <= 36) { state.boardUserScrolledUp = false; state.boardFollow = true; }
    updateJumpLatestButtonVisibility();
  });

  document.getElementById('board-feed')?.addEventListener('click', (e) => {
    // v0.2.0 用户派单卡片「Spec ×N」徽标：原位展开 / 收起注入明细（原生 button，回车 / 空格同样触发）
    const specBtn = e.target.closest('[data-spec-toggle]');
    if (specBtn) {
      toggleSpecBadge(specBtn);
      return;
    }
    // 加载更早发言：同步重绘后按高度差回填 scrollTop，阅读位置零跳动
    const olderBtn = e.target.closest('[data-board-load-older]');
    if (olderBtn) {
      const area = document.getElementById('studio-main');
      const prevHeight = area?.scrollHeight || 0;
      const prevTop = area?.scrollTop || 0;
      state.boardUserScrolledUp = true;
      const cur = state.boardVisibleLimit;
      state.boardVisibleLimit = olderBtn.dataset.boardLoadOlder === 'all' || !Number.isFinite(cur) ? Infinity : cur + 20;
      renderBoardView();
      if (area) area.scrollTop = Math.max(0, area.scrollHeight - prevHeight + prevTop);
      updateJumpLatestButtonVisibility();
      return;
    }
    const seqRefBtn = e.target.closest('[data-seq-ref]');
    if (seqRefBtn) {
      const seqNum = seqRefBtn.dataset.seqRef;
      const seqSelector = `#board-feed [data-seq="${CSS.escape(seqNum)}"]`;
      // 目标帖被折叠在更早消息中：先扩大可见窗口并同步重绘，再定位高亮
      if (!document.querySelector(seqSelector) && revealBoardSeq(seqNum)) {
        state.boardUserScrolledUp = true;
        renderBoardView();
      }
      const targetPost = document.querySelector(seqSelector);
      if (targetPost) {
        targetPost.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
        targetPost.style.background = 'var(--sw-press)';
        setTimeout(() => { targetPost.style.background = ''; }, 900);
      }
      return;
    }

    const traceBtn = e.target.closest('[data-trace-post]');
    if (traceBtn) {
      const pid = traceBtn.dataset.tracePost;
      if (state.expandedTraces.has(pid)) state.expandedTraces.delete(pid);
      else state.expandedTraces.add(pid);
      scheduleRender();
      return;
    }

    const toolOutBtn = e.target.closest('[data-toggle-tool-out]');
    if (toolOutBtn) {
      const key = toolOutBtn.dataset.toggleToolOut;
      if (state.expandedToolIds.has(key)) state.expandedToolIds.delete(key);
      else state.expandedToolIds.add(key);
      scheduleRender();
      return;
    }

    const fileBtn = e.target.closest('[data-open-file]');
    if (fileBtn) {
      openFileInHostOrInspector(fileBtn.dataset.openFile, fileBtn.dataset.baseDir);
      return;
    }

    const memberBtn = e.target.closest('[data-open-member]');
    if (memberBtn) {
      openMemberDrawer(memberBtn.dataset.openMember);
      return;
    }

    const retryBtn = e.target.closest('[data-retry-thread]');
    if (retryBtn) {
      void executeRetry(retryBtn.dataset.retryThread);
      return;
    }

    const switchRetryBtn = e.target.closest('[data-switch-retry]');
    if (switchRetryBtn) {
      openRetryModal(switchRetryBtn.dataset.switchRetry);
      return;
    }

    const moreBtn = e.target.closest('[data-toggle-body]');
    const clickedPost = e.target.closest('.board-post');
    if (moreBtn || (clickedPost && !e.target.closest('button, a') && !window.getSelection?.()?.toString())) {
      const pid = moreBtn ? moreBtn.dataset.toggleBody : clickedPost.dataset.postId;
      const bodyEl = clickedPost?.querySelector('.post-body');
      if (pid && (moreBtn || bodyEl?.classList.contains('clamped'))) {
        if (state.expandedBodies.has(pid)) state.expandedBodies.delete(pid);
        else state.expandedBodies.add(pid);
        scheduleRender();
      }
    }
  });

  // 6. 全局待批弹窗事件委托
  const handleRequestCardClick = (e) => {
    const btn = e.target.closest('[data-req-action]');
    if (!btn) return;
    const reqId = btn.dataset.reqId;
    const action = btn.dataset.reqAction;
    const req = state.pendingRequests.get(reqId);
    if (!req) return;

    if (action === 'approve_once') {
      void respondToRequest(req, { decision: 'approve_once', approved: true, scope: 'once' });
    } else if (action === 'approve_session') {
      void respondToRequest(req, { decision: 'approve_session', approved: true, scope: 'session' });
    } else if (action === 'reject') {
      const card = btn.closest('.request-card');
      const reason = card?.querySelector('.req-free-input')?.value.trim() || '总指挥在工作台拒绝了本次敏感操作';
      void respondToRequest(req, { decision: 'reject', approved: false, reason });
    } else if (action === 'answer') {
      const card = btn.closest('.request-card');
      const checked = Array.from(card?.querySelectorAll(`input[name="qopt_${CSS.escape(reqId)}"]:checked`) || []).map((i) => i.value);
      const freeText = card?.querySelector(`[data-req-input="${CSS.escape(reqId)}"]`)?.value.trim() || '';
      const answerText = [...checked, freeText].filter(Boolean).join('；');
      if (!answerText) {
        showToast('请选择至少一个选项或填写补充说明', 'error');
        return;
      }
      void respondToRequest(req, { decision: 'answer', answers: checked, text: answerText, response: answerText });
    }
  };
  document.getElementById('global-requests-banner')?.addEventListener('click', handleRequestCardClick);
  document.getElementById('md-timeline-body')?.addEventListener('click', (e) => {
    const specBtn = e.target.closest('[data-spec-toggle]');
    if (specBtn) {
      toggleSpecBadge(specBtn);
      return;
    }
    const promptBtn = e.target.closest('[data-toggle-prompt]');
    if (promptBtn) {
      const key = promptBtn.dataset.togglePrompt;
      if (state.expandedPrompts.has(key)) state.expandedPrompts.delete(key);
      else state.expandedPrompts.add(key);
      scheduleRender();
      return;
    }
    handleRequestCardClick(e);
    const fileBtn = e.target.closest('[data-open-file]');
    if (fileBtn) openFileInHostOrInspector(fileBtn.dataset.openFile, fileBtn.dataset.baseDir);
  });

  // 7. 成员 (Members) 视图与详情抽屉事件
  document.getElementById('members-status-filter')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-mstatus]');
    if (!btn) return;
    state.membersStatusFilter = btn.dataset.mstatus;
    scheduleRender();
  });

  // 看板宽屏右侧实时状态边栏：成员 / 审批复用 data-open-member；Worktree 快照直达变更视图；阵容直达配置页
  document.getElementById('board-side-rail')?.addEventListener('click', (e) => {
    const member = e.target.closest('[data-open-member]');
    if (member) { openMemberDrawer(member.dataset.openMember); return; }
    const wt = e.target.closest('[data-rail-worktree]');
    if (wt) {
      setActiveView('diff');
      void selectWorktree(wt.dataset.railWorktree);
      return;
    }
    const roster = e.target.closest('[data-rail-goto-roster]');
    if (roster) {
      state.editingModeProfile = roster.dataset.railGotoRoster === 'complex' ? 'complex' : 'relay';
      setActiveView('settings');
      setSettingsPane('roles');
    }
  });

  document.getElementById('btn-archive-idle-members')?.addEventListener('click', () => void handleArchiveIdleMembers());

  document.getElementById('members-roster-list')?.addEventListener('click', (e) => {
    const moreBtn = e.target.closest('[data-members-load-more]');
    if (moreBtn) {
      e.stopPropagation();
      const cur = state.membersInactiveLimit;
      state.membersInactiveLimit = moreBtn.dataset.membersLoadMore === 'all' || !Number.isFinite(cur) ? Infinity : cur + 20;
      scheduleRender();
      return;
    }
    const delBtn = e.target.closest('[data-del-thread]');
    if (delBtn) {
      e.stopPropagation();
      void handleDeleteThread(delBtn.dataset.delThread, `del:${delBtn.dataset.delThread}`);
      return;
    }
    const focusBtn = e.target.closest('[data-focus-composer]');
    if (focusBtn) {
      e.stopPropagation();
      focusThreadInComposer(focusBtn.dataset.focusComposer);
      return;
    }
    const retryBtn = e.target.closest('[data-retry-thread]');
    if (retryBtn) {
      e.stopPropagation();
      void executeRetry(retryBtn.dataset.retryThread);
      return;
    }
    const stopBtn = e.target.closest('[data-quick-stop]');
    if (stopBtn) {
      e.stopPropagation();
      void handleTwoStageCancel(stopBtn.dataset.quickStop);
      return;
    }
    const jumpBtn = e.target.closest('[data-jump-host]');
    if (jumpBtn) {
      e.stopPropagation();
      const t = state.threadsMap.get(jumpBtn.dataset.jumpHost);
      if (t) jumpToNativeHostConversation(t);
      return;
    }
    const row = e.target.closest('[data-open-member]');
    if (row) {
      openMemberDrawer(row.dataset.openMember);
    }
  });

  // 抽屉操作栏：一次性事件委托（抽屉每次重绘只换 innerHTML，不再逐次 addEventListener）
  document.getElementById('md-actions-bar')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-md-action]');
    const tid = state.detailDrawerThreadId;
    const t = tid ? state.threadsMap.get(tid) : null;
    if (!btn || !t) return;
    const action = btn.dataset.mdAction;
    if (action === 'to-composer') {
      closeMemberDrawer();
      focusThreadInComposer(t.id, false);
    } else if (action === 'stop') {
      void handleTwoStageCancel(t.id);
    } else if (action === 'retry') {
      void executeRetry(t.id);
    } else if (action === 'switch-model') {
      openRetryModal(t.id);
    } else if (action === 'astra-review') {
      triggerAstraCodeReview(t.worktreePath || t.cwd || getEffectiveCwd(), shortMemberName(t), t.id);
    }
  });
  // <details> 的 toggle 不冒泡：在容器上以捕获阶段委托一次，记录轨迹分组展开态
  document.getElementById('md-timeline-body')?.addEventListener('toggle', (e) => {
    const det = e.target;
    const key = det?.getAttribute?.('data-drawer-trace');
    if (!key) return;
    if (det.open) state.expandedTraces.add(key);
    else state.expandedTraces.delete(key);
    if (det.open && det.getAttribute('data-hist-empty') === '1') {
      const runId = det.getAttribute('data-hist-run');
      if (runId && state.detailDrawerThreadId) void hydrateOrderRunItems(state.detailDrawerThreadId, runId);
    }
    scheduleRender();
  }, true);

  document.getElementById('btn-close-member-drawer')?.addEventListener('click', closeMemberDrawer);
  document.getElementById('member-drawer-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'member-drawer-backdrop') closeMemberDrawer();
  });
  document.getElementById('btn-md-jump-host')?.addEventListener('click', () => {
    const t = state.threadsMap.get(state.detailDrawerThreadId);
    if (t) jumpToNativeHostConversation(t);
  });
  document.getElementById('btn-md-delete')?.addEventListener('click', () => {
    if (state.detailDrawerThreadId) {
      void handleDeleteThread(state.detailDrawerThreadId, `del:${state.detailDrawerThreadId}`);
    }
  });

  // 9. 变更 (Diff) 视图事件
  document.getElementById('wt-select-dropdown')?.addEventListener('change', (e) => {
    void selectWorktree(e.target.value);
  });
  document.getElementById('btn-refresh-worktrees')?.addEventListener('click', () => void refreshWorktreesList());
  document.getElementById('wt-diff-mode-select')?.addEventListener('change', (e) => {
    state.diffMode = e.target.value;
    void loadSelectedWorktreeDiff();
  });
  document.getElementById('btn-wt-apply')?.addEventListener('click', () => void handleIntegrateWorktree('apply_unstaged'));
  document.getElementById('btn-wt-squash')?.addEventListener('click', () => void handleIntegrateWorktree('squash'));
  document.getElementById('btn-wt-cleanup')?.addEventListener('click', () => void handleCleanupWorktree());
  document.getElementById('btn-wt-review')?.addEventListener('click', () => {
    const wt = getScopedWorktrees().find((w) => w.id === state.selectedWorktreeId);
    if (wt) triggerAstraCodeReview(wt.path || wt.cwd, `Worktree ${wt.branch}`, wt.threadId || '');
  });
  document.getElementById('wt-changed-files')?.addEventListener('click', (e) => {
    const pill = e.target.closest('[data-diff-file]');
    if (!pill) return;
    state.selectedDiffFile = pill.dataset.diffFile;
    scheduleRender();
  });
  document.getElementById('wt-diff-viewer')?.addEventListener('click', (e) => {
    const fileBtn = e.target.closest('[data-open-file]');
    if (fileBtn) openFileInHostOrInspector(fileBtn.dataset.openFile, fileBtn.dataset.baseDir);
  });

  // 10. 配置 (扩展中心 & 角色预设) 视图事件
  // 分段控件（role=radiogroup）方向键：移动并选中相邻选项
  const segArrowTarget = (e) => {
    const btn = e.target.closest?.('.seg [role="radio"]');
    if (!btn || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return null;
    const radios = [...btn.closest('.seg').querySelectorAll('[role="radio"]')];
    const i = radios.indexOf(btn);
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? radios.length - 1 : (i + (back ? -1 : 1) + radios.length) % radios.length;
    e.preventDefault();
    return radios[next];
  };

  // 10.1 二级子页面卡片导航（项目配置 3 子页 + 全局配置 4 子页）：点击切换；左右方向键 / Home / End 移动焦点
  const bindSubnav = (subnav) => {
    subnav?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-settings-pane]');
      if (btn) setSettingsPane(btn.dataset.settingsPane);
    });
    subnav?.addEventListener('keydown', (e) => {
      const btn = e.target.closest('[data-settings-pane]');
      if (!btn || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const tabs = [...subnav.querySelectorAll('[data-settings-pane]')].filter((b) => !b.hidden);
      const i = tabs.indexOf(btn);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      e.preventDefault();
      tabs[next].focus();
    });
  };
  bindSubnav(document.getElementById('settings-subnav'));
  bindSubnav(document.getElementById('global-settings-subnav'));

  // 10.2 分模式阵容（项目成员池 & 全局默认成员池共用同款事件委托；引擎、模型、强度、权限走自绘下拉）
  const bindRolesGrid = (grid, scope) => {
    const isGlobal = scope === 'global';
    const edit = isGlobal ? editGlobalRolePreset : editRolePreset;
    const curMode = isGlobal ? editingGlobalModeProfile : editingModeProfile;
    const setScope = isGlobal ? setGlobalEditingModeProfile : setEditingModeProfile;
    const toggleStage = isGlobal ? toggleGlobalModeStage : toggleModeStage;
    const toggleMember = isGlobal ? toggleGlobalModeMember : toggleModeMember;
    const setPreferred = isGlobal ? setGlobalModePreferred : setModePreferred;
    const toggleDrawer = isGlobal ? toggleGlobalMemberDrawer : toggleMemberDrawer;
    const toggleGroup = isGlobal ? toggleGlobalPoolGroup : togglePoolGroup;
    const startAdd = isGlobal ? startAddGlobalMember : startAddMember;
    const deleteMember = isGlobal ? deleteGlobalCustomMember : deleteCustomMember;
    const setDraftGroup = isGlobal ? setGlobalMemberDraftGroup : setMemberDraftGroup;
    const cancelAdd = isGlobal ? cancelAddGlobalMember : cancelAddMember;
    const confirmAdd = isGlobal ? confirmAddGlobalMember : confirmAddMember;
    const updateDraft = isGlobal ? updateGlobalMemberDraftField : updateMemberDraftField;
    const setLabel = isGlobal ? setGlobalMemberLabel : setMemberLabel;

    grid?.addEventListener('click', (e) => {
      const hit = (sel) => e.target.closest(sel);
      let el;
      if (!isGlobal) {
        if (hit('[data-curation-auto-toggle]')) { void toggleSpecCurationAuto(); return; }
        if (hit('[data-goto-spec-proposal]')) { gotoSpecCurationProposal(); return; }
        if (hit('[data-goto-project-pane]')) { gotoProjectSpecsSection(); return; }
      }
      if ((el = hit('[data-ps-seg]'))) {
        if (el.getAttribute('aria-checked') !== 'true') edit(el.dataset.psSeg, 'isolation', el.dataset.value);
      } else if ((el = hit('[data-pool-toggle]'))) toggleGroup(el.dataset.poolToggle);
      else if ((el = hit('[data-pool-add]'))) startAdd(el.dataset.poolAdd);
      else if ((el = hit('[data-mode-scope]'))) setScope(el.dataset.modeScope);
      else if ((el = hit('[data-mode-stage-toggle]'))) toggleStage(curMode(), el.dataset.modeStageToggle);
      else if ((el = hit('[data-mode-member-check]'))) toggleMember(curMode(), el.dataset.modeGroup, el.dataset.modeMemberCheck);
      else if ((el = hit('[data-mode-member-star]'))) setPreferred(curMode(), el.dataset.modeGroup, el.dataset.modeMemberStar);
      else if ((el = hit('[data-member-more]'))) toggleDrawer(el.dataset.memberMore);
      else if ((el = hit('[data-member-delete]'))) deleteMember(el.dataset.memberDelete);
      else if ((el = hit('[data-member-draft-group]'))) setDraftGroup(el.dataset.memberDraftGroup);
      else if (hit('[data-member-draft-cancel]')) cancelAdd();
      else if (hit('[data-member-draft-save]')) confirmAdd();
    });
    grid?.addEventListener('input', (e) => {
      const field = e.target.dataset?.memberDraftField;
      if (field) updateDraft(field, e.target.value);
    });
    grid?.addEventListener('change', (e) => {
      const key = e.target.dataset?.memberLabel;
      if (key) setLabel(key, e.target.value);
      // 规范维护官引擎：原生 <select>（已排除宿主原生），选中后走与自绘下拉相同的 edit 校验链
      const curatorKey = e.target.dataset?.curatorProvider;
      if (curatorKey) edit(curatorKey, 'provider', e.target.value);
    });
    grid?.addEventListener('focusout', (e) => {
      // 输入框失焦后补一次渲染，追上聚焦期间被延后的数据更新
      if (e.target.matches?.('input')) scheduleRender();
    });
    grid?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing && e.target.matches?.('[data-member-label], [data-member-draft-field]')) {
        e.preventDefault();
        if (e.target.dataset.memberDraftField) confirmAdd();
        else e.target.blur();
        return;
      }
      if (e.key === 'Escape' && e.target.matches?.('[data-member-draft-field]')) {
        e.preventDefault();
        cancelAdd();
        return;
      }
      const next = segArrowTarget(e);
      if (next) { next.focus(); next.click(); }
    });
  };
  bindRolesGrid(document.getElementById('role-presets-grid'), 'project');
  bindRolesGrid(document.getElementById('global-role-presets-grid'), 'global');

  // 10.3 引擎目录：手风琴 / 复制模型 ID / 反链跳转角色；搜索框直接 DOM 过滤
  document.getElementById('catalog-providers-container')?.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy-model]');
    if (copyBtn) { void copyText(copyBtn.dataset.copyModel, copyBtn); return; }
    const roleBtn = e.target.closest('[data-goto-role]');
    if (roleBtn) { gotoRolePreset(roleBtn.dataset.gotoRole); return; }
    const head = e.target.closest('[data-cat-toggle]');
    if (head) toggleCatalogProvider(head.dataset.catToggle);
  });
  const catalogSearch = document.getElementById('catalog-search-input');
  const applyCatalogQuery = (value) => {
    state.catalogQuery = value;
    state.catalogSearchCollapsed.clear();
    applyCatalogFilter();
  };
  catalogSearch?.addEventListener('input', () => applyCatalogQuery(catalogSearch.value));
  catalogSearch?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.isComposing || !catalogSearch.value) return;
    e.preventDefault();
    e.stopPropagation();
    catalogSearch.value = '';
    applyCatalogQuery('');
  });
  // 聚焦期间配置页暂停重绘；失焦后补一次渲染，追上被延后的数据更新
  catalogSearch?.addEventListener('blur', () => scheduleRender());

  // 10.4 全局默认与扩展：「新对话默认模式」三档分段 → 隐藏 select 的 change（复用既有处理链）
  const defaultDispatchSeg = document.getElementById('default-dispatch-seg');
  defaultDispatchSeg?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-default-mode]');
    const sel = document.getElementById('sel-default-dispatch-mode');
    if (!btn || !sel || btn.getAttribute('aria-checked') === 'true') return;
    sel.value = btn.dataset.defaultMode;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  });
  defaultDispatchSeg?.addEventListener('keydown', (e) => {
    const next = segArrowTarget(e);
    if (next) { next.focus(); next.click(); }
  });
  // 10.5 界面外观主题：跟随宿主 / 暗色 / 亮色
  const themeModeSeg = document.getElementById('theme-mode-seg');
  themeModeSeg?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-theme-mode]');
    // 以 state.themeMode 为准（而非 DOM aria-checked）：刷新后配置页首帧渲染前点击也必须生效
    if (!btn || btn.dataset.themeMode === state.themeMode) return;
    setThemeMode(btn.dataset.themeMode);
    scheduleRender();
  });
  themeModeSeg?.addEventListener('keydown', (e) => {
    const next = segArrowTarget(e);
    if (next) { next.focus(); next.click(); }
  });

  const projectExternalSessionSeg = document.getElementById('project-external-session-seg');
  projectExternalSessionSeg?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-ext-session-mode]');
    if (!btn || btn.getAttribute('aria-checked') === 'true') return;
    void setProjectExternalSessionMode(btn.dataset.extSessionMode);
  });
  projectExternalSessionSeg?.addEventListener('keydown', (e) => {
    const next = segArrowTarget(e);
    if (next) { next.focus(); next.click(); }
  });

  document.getElementById('btn-default-external-session-visible')?.addEventListener('click', () => void toggleDefaultExternalSessionVisible());
  document.getElementById('btn-auto-check-updates')?.addEventListener('click', () => void toggleAutoCheckUpdates());
  document.getElementById('btn-check-updates-now')?.addEventListener('click', () => void checkSystemUpdates());
  document.getElementById('btn-apply-system-update')?.addEventListener('click', () => void applySystemUpdate());
  document.getElementById('btn-cancel-system-update')?.addEventListener('click', () => void cancelSystemUpdate());
  document.getElementById('btn-rollback-system-update')?.addEventListener('click', () => void rollbackSystemUpdate());
  document.getElementById('btn-dismiss-update')?.addEventListener('click', () => void dismissSystemUpdate());

  // v0.3.0 全局「新项目默认开启项目规范（Spec）」/ 项目阵容「同步为全局默认」「恢复为全局默认」（均二次确认）
  document.getElementById('btn-default-spec-enabled')?.addEventListener('click', () => void toggleDefaultSpecEnabled());
  document.getElementById('btn-sync-roster-to-global')?.addEventListener('click', () => void handleSyncRosterToGlobal());
  document.getElementById('btn-reset-roster-to-global')?.addEventListener('click', () => void handleResetRosterToGlobal());
  document.getElementById('btn-refresh-extensions')?.addEventListener('click', () => void refreshExtensionProviders(false));
  // v0.1.2 运行缓存清理：↻ 重新统计 / 一键安全清理（后端四重安全锁复检后才删除闲置工作树）
  document.getElementById('btn-refresh-runtime-cache')?.addEventListener('click', () => void refreshRuntimeCacheStatus({ silent: false }));
  document.getElementById('btn-clean-runtime-cache')?.addEventListener('click', () => void handleCleanRuntimeCache());
  // v0.2.0 项目规范（Spec）：↻ 重读清单 / 初始化示例骨架 / 点行懒加载只读预览
  document.getElementById('btn-refresh-project-specs')?.addEventListener('click', () => reloadProjectSpecs());
  document.getElementById('btn-init-project-specs')?.addEventListener('click', () => void handleInitProjectSpecs());
  document.getElementById('btn-sync-plugin-spec-templates')?.addEventListener('click', () => void handleSyncPluginSpecTemplates());
  // v0.3.0 可插拔项目规范：接入总开关 / 归档规范 / 恢复归档 / 恢复并开启（切换开关本身绝不搬动文件）
  document.getElementById('btn-project-spec-enabled')?.addEventListener('click', () => void toggleProjectSpecEnabled());
  document.getElementById('btn-archive-project-specs')?.addEventListener('click', () => void handleArchiveProjectSpecs());
  document.getElementById('btn-restore-project-specs')?.addEventListener('click', () => void handleRestoreProjectSpecs(false));
  document.getElementById('btn-restore-enable-project-specs')?.addEventListener('click', () => void handleRestoreProjectSpecs(true));
  // v0.2.11 规范维护：顶栏自动维护开关（与复杂阶段栏 / 规范维护组卡头同源）/ ✨ 维护规范 / 按项目容量配额 / 提案确认卡三态动作
  document.getElementById('btn-spec-curation-auto')?.addEventListener('click', () => void toggleSpecCurationAuto());
  document.getElementById('btn-spec-curation-trigger')?.addEventListener('click', () => toggleSpecCurationTriggerBar());
  const specQuotaBar = document.getElementById('project-specs-quota-bar');
  specQuotaBar?.addEventListener('change', (e) => {
    const kind = e.target.dataset?.specLimit;
    if (kind) void saveSpecCurationLimits(kind);
  });
  specQuotaBar?.addEventListener('keydown', (e) => {
    const kind = e.target.dataset?.specLimit;
    if (!kind || e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.target.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      const cur = state.specCuration;
      e.target.value = String(kind === 'single' ? cur.singleMaxKb : cur.totalMaxKb);
      e.target.blur();
    }
  });
  specQuotaBar?.addEventListener('focusout', (e) => { if (e.target.matches?.('input')) scheduleRender(); });
  const curationPanel = document.getElementById('spec-curation-panel');
  curationPanel?.addEventListener('click', (e) => {
    const hit = (sel) => e.target.closest(sel);
    let el;
    if (hit('[data-curation-trigger-submit]')) void submitSpecCurationTrigger();
    else if (hit('[data-curation-trigger-cancel]')) toggleSpecCurationTriggerBar(false);
    else if ((el = hit('[data-curation-confirm]'))) { if (!el.disabled) void confirmSpecProposal(el.dataset.curationConfirm); }
    else if ((el = hit('[data-curation-revise-open]'))) toggleSpecProposalRevise();
    else if ((el = hit('[data-curation-revise-submit]'))) void submitSpecProposalRevise(el.dataset.curationReviseSubmit);
    else if (hit('[data-curation-revise-cancel]')) toggleSpecProposalRevise(false);
    else if ((el = hit('[data-curation-dismiss]'))) void dismissSpecProposal(el.dataset.curationDismiss);
  });
  curationPanel?.addEventListener('input', (e) => {
    const field = e.target.dataset?.curationInput;
    if (field) updateSpecCurationDraft(field, e.target.value);
  });
  curationPanel?.addEventListener('keydown', (e) => {
    const field = e.target.dataset?.curationInput;
    if (!field || e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (field === 'note') void submitSpecCurationTrigger();
      else void submitSpecProposalRevise(curationPanel.querySelector('[data-curation-revise-submit]')?.dataset.curationReviseSubmit || '');
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (field === 'note') toggleSpecCurationTriggerBar(false);
      else toggleSpecProposalRevise(false);
    }
  });
  // 输入框失焦后补一次渲染，追上聚焦期间被延后的数据更新
  curationPanel?.addEventListener('focusout', (e) => { if (e.target.matches?.('input')) scheduleRender(); });
  // <details> 的 toggle 不冒泡：捕获阶段记录 Diff / 完整新内容的展开态，重绘后保持
  curationPanel?.addEventListener('toggle', (e) => {
    const key = e.target?.getAttribute?.('data-curation-details');
    if (key) setSpecCurationDetailOpen(key, e.target.open);
  }, true);
  document.getElementById('spec-curation-reminder')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-goto-spec-proposal]')) gotoSpecCurationProposal();
  });
  document.getElementById('project-specs-body')?.addEventListener('click', (e) => {
    const editBtn = e.target.closest('[data-spec-open-editor]');
    if (editBtn) {
      void openProjectSpecInEditor(editBtn.dataset.specOpenEditor, editBtn.dataset.baseDir);
      return;
    }
    const row = e.target.closest('[data-spec-open]');
    if (row) toggleProjectSpec(row.dataset.specOpen);
  });
  document.getElementById('btn-open-ext-wizard')?.addEventListener('click', () => openExtensionWizard(''));
  document.getElementById('extension-hub-grid')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-ext-lib-toggle]')) {
      state.extLibOpen = !state.extLibOpen;
      applyExtLibState();
      return;
    }
    const editBtn = e.target.closest('[data-ext-edit]');
    if (editBtn) {
      openExtensionWizard(editBtn.dataset.extEdit);
      return;
    }
    const enBtn = e.target.closest('[data-ext-enable]');
    if (enBtn) {
      void quickEnableTemplateProvider(enBtn.dataset.extEnable);
      return;
    }
    const disBtn = e.target.closest('[data-ext-disable]');
    if (disBtn) {
      void removeOrDisableExtension(disBtn.dataset.extDisable);
    }
  });

  document.getElementById('btn-save-presets')?.addEventListener('click', () => void saveAllRolePresets(true));
  document.getElementById('btn-save-global-presets')?.addEventListener('click', () => void saveAllGlobalRolePresets(true));
  document.getElementById('btn-reload-capabilities')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-reload-capabilities');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '探测中…';
    }
    try {
      const caps = await rpcCall('getCapabilities', { refresh: true });
      if (caps?.providers) {
        state.providers = normalizeProvidersCatalog(caps.providers, state.customProviders);
        syncComposerSelects();
        scheduleRender();
        const totalModels = state.providers.reduce((sum, p) => sum + (p.models?.length || 0), 0);
        showToast(`已重新探测并同步 ${state.providers.length} 个引擎共 ${totalModels} 款模型`, 'success');
      } else {
        showToast('引擎目录探测完成');
      }
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '↻ 重新探测';
      }
    }
  });

  // 11. 底部紧凑 Composer & 配置 Popover 交互
  document.getElementById('btn-composer-cfg-pill')?.addEventListener('click', (e) => {
    e.stopPropagation();
    state.composerPopoverOpen = !state.composerPopoverOpen;
    scheduleRender();
  });
  document.getElementById('btn-close-cfg-pop')?.addEventListener('click', () => {
    state.composerPopoverOpen = false;
    scheduleRender();
  });
  document.getElementById('comp-target-thread')?.addEventListener('change', (e) => {
    state.manualTarget = true;
    const val = e.target.value;
    if (val === '__NEW__') {
      state.selectedThreadId = '';
    } else {
      state.selectedThreadId = val;
      const t = state.threadsMap.get(val);
      if (t) applyThreadToComposerConfig(t);
    }
    syncComposerSelects();
    scheduleRender();
  });

  const syncIdleThreadConfigIfNeeded = async () => {
    renderComposerState();
    const t = state.selectedThreadId ? state.threadsMap.get(state.selectedThreadId) : null;
    if (t && !isStatusActive(t.status)) {
      const prev = {
        presetKey: t.presetKey,
        provider: t.provider,
        model: t.model,
        effort: t.effort,
        permissionMode: t.permissionMode,
        interactionMode: t.interactionMode,
        isolation: t.isolation,
      };
      const patch = { ...state.composer, interactionMode: deriveInteractionMode(state.composer.permissionMode) };
      // 宿主原生线程的权限由主窗口管理：不回写 permission / interaction
      if (t.isNativeHost) { delete patch.permissionMode; delete patch.interactionMode; }
      Object.assign(t, patch);
      try {
        const route = patch.presetKey ? { presetKey: patch.presetKey, isolation: patch.isolation } : patch;
        const res = await rpcCall('configureThread', { threadId: t.id, ...route });
        if (res?.thread) state.threadsMap.set(t.id, normalizeThread(res.thread, t));
      } catch (err) {
        Object.assign(t, prev);
        applyThreadToComposerConfig(t);
        syncComposerSelects();
        scheduleRender();
        showToast(err.message, 'error');
      }
    }
  };

  document.getElementById('comp-preset')?.addEventListener('change', (e) => {
    const key = e.target.value;
    state.composer.presetKey = key;
    state.composer.isolationCustomized = false;
    if (key && state.presets[key]) {
      const cfg = state.presets[key];
      state.composer.provider = cfg.provider;
      state.composer.model = cfg.model;
      state.composer.effort = cfg.effort;
      if (!isComposerNativeHostTarget()) {
        state.composer.permissionMode = normalizePermissionForProvider(cfg.provider, cfg.permissionMode || cfg.runtimeMode);
        state.composer.interactionMode = deriveInteractionMode(state.composer.permissionMode);
      }
      if (!state.selectedThreadId) state.composer.isolation = cfg.isolation || 'shared';
    }
    syncComposerSelects();
    void syncIdleThreadConfigIfNeeded();
    scheduleRender();
  });
  document.getElementById('comp-provider')?.addEventListener('change', (e) => {
    const previousProvider = state.composer.provider;
    state.composer.provider = e.target.value;
    remapPermissionOnProviderChange(state.composer, previousProvider);
    if (!presetDispatchRoute(state.composer.presetKey, state.composer).presetKey) state.composer.presetKey = '';
    syncComposerSelects();
    void syncIdleThreadConfigIfNeeded();
  });
  document.getElementById('comp-model')?.addEventListener('change', (e) => {
    handleModelSelectChange(
      e.target,
      state.composer,
      () => {
        if (!presetDispatchRoute(state.composer.presetKey, state.composer).presetKey) state.composer.presetKey = '';
        syncComposerSelects();
        void syncIdleThreadConfigIfNeeded();
      },
      () => {
        syncComposerSelects();
      }
    );
  });
  document.getElementById('comp-effort')?.addEventListener('change', (e) => {
    state.composer.effort = e.target.value;
    if (!presetDispatchRoute(state.composer.presetKey, state.composer).presetKey) state.composer.presetKey = '';
    void syncIdleThreadConfigIfNeeded();
  });
  document.getElementById('comp-perm-mode')?.addEventListener('change', (e) => {
    if (isComposerNativeHostTarget()) return;
    state.composer.permissionMode = normalizePermissionForProvider(state.composer.provider, e.target.value);
    state.composer.interactionMode = deriveInteractionMode(state.composer.permissionMode);
    if (!presetDispatchRoute(state.composer.presetKey, state.composer).presetKey) state.composer.presetKey = '';
    syncComposerSelects();
    void syncIdleThreadConfigIfNeeded();
  });
  document.getElementById('comp-isolation')?.addEventListener('change', (e) => {
    state.composer.isolationCustomized = true;
    state.composer.isolation = e.target.value;
    void syncIdleThreadConfigIfNeeded();
  });

  document.getElementById('btn-comp-send')?.addEventListener('click', () => void handleComposerSubmit('auto'));
  document.getElementById('comp-ephemeral-chk')?.addEventListener('change', scheduleRender);
  document.getElementById('btn-comp-steer')?.addEventListener('click', () => void handleComposerSubmit('steer'));
  document.getElementById('btn-comp-queue')?.addEventListener('click', () => void handleComposerSubmit('queue'));
  document.getElementById('btn-comp-stop')?.addEventListener('click', () => void handleTwoStageCancel(state.selectedThreadId));

  document.getElementById('comp-prompt-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const t = state.selectedThreadId ? state.threadsMap.get(state.selectedThreadId) : null;
      const isRun = Boolean(t && isStatusActive(t.status));
      void handleComposerSubmit(isRun ? 'steer' : 'auto');
    }
  });

  document.getElementById('queue-items-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-qact]');
    if (!btn || !state.selectedThreadId) return;
    const t = state.threadsMap.get(state.selectedThreadId);
    const qItem = t?.queue.find((q) => q.id === btn.dataset.qid);
    if (!qItem) return;
    const act = btn.dataset.qact;
    if (act === 'up' || act === 'down') {
      void handleQueueAction(t.id, 'reorder', qItem, { direction: act });
    } else {
      void handleQueueAction(t.id, act, qItem);
    }
  });

  // 12. 派发抽屉与弹窗事件
  const closeDispatch = () => {
    const el = document.getElementById('dispatch-drawer-backdrop');
    if (el) el.hidden = true;
  };
  document.getElementById('btn-close-dispatch')?.addEventListener('click', closeDispatch);
  document.getElementById('btn-cancel-dispatch')?.addEventListener('click', closeDispatch);
  document.getElementById('dispatch-drawer-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'dispatch-drawer-backdrop') closeDispatch();
  });

  document.getElementById('dispatch-mode-tabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dmode]');
    if (!btn) return;
    state.dispatchMode = btn.dataset.dmode;
    renderDispatchDrawerMode();
  });

  document.getElementById('dispatch-preset-chips')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-preset-chip]');
    if (chip) applyPresetToDispatchForm(chip.dataset.presetChip);
  });

  document.getElementById('disp-provider')?.addEventListener('change', (e) => {
    state.dispatchPresetDetached = true;
    const previousProvider = state.dispatchSelection.provider;
    state.dispatchSelection.provider = e.target.value;
    populateLinkedSelectTrio(
      document.getElementById('disp-provider'),
      document.getElementById('disp-model'),
      document.getElementById('disp-effort'),
      state.dispatchSelection
    );
    remapPermissionOnProviderChange(state.dispatchSelection, previousProvider);
    renderDispatchPermSelect();
  });
  document.getElementById('disp-perm')?.addEventListener('change', (e) => {
    state.dispatchPresetDetached = true;
    state.dispatchSelection.permissionMode = normalizePermissionForProvider(state.dispatchSelection.provider, e.target.value);
    renderDispatchPermSelect();
  });
  document.getElementById('disp-model')?.addEventListener('change', (e) => {
    handleModelSelectChange(
      e.target,
      state.dispatchSelection,
      () => {
        state.dispatchPresetDetached = true;
        populateLinkedSelectTrio(
          document.getElementById('disp-provider'),
          document.getElementById('disp-model'),
          document.getElementById('disp-effort'),
          state.dispatchSelection
        );
      },
      () => {
        populateLinkedSelectTrio(
          document.getElementById('disp-provider'),
          document.getElementById('disp-model'),
          document.getElementById('disp-effort'),
          state.dispatchSelection
        );
      }
    );
  });
  document.getElementById('disp-isolation')?.addEventListener('change', () => { state.dispatchSelection.isolationCustomized = true; });
  document.getElementById('disp-effort')?.addEventListener('change', (e) => {
    state.dispatchPresetDetached = true;
    state.dispatchSelection.effort = e.target.value;
  });

  document.getElementById('btn-tpl-council')?.addEventListener('click', () => fillBatchTemplate('council'));
  document.getElementById('btn-tpl-tri-exec')?.addEventListener('click', () => fillBatchTemplate('tri_exec'));
  document.getElementById('btn-add-batch-row')?.addEventListener('click', () => {
    // 删光默认成员后不再假设固定键存在：阵容 ★ → 执行组首个成员 → 任意成员 → 空占位路由
    const base = preferredGroupPreset('executor') || fallbackGroupPreset('executor') || EMPTY_MEMBER_FALLBACK;
    state.batchDrafts.push(batchRowFromPreset(base, { title: `子任务 #${state.batchDrafts.length + 1}` }));
    renderBatchDraftRows();
  });

  document.getElementById('batch-rows-container')?.addEventListener('click', (e) => {
    const rmBtn = e.target.closest('[data-batch-remove]');
    if (rmBtn) {
      state.batchDrafts.splice(Number(rmBtn.dataset.batchRemove), 1);
      renderBatchDraftRows();
    }
  });
  document.getElementById('batch-rows-container')?.addEventListener('input', (e) => {
    const el = e.target;
    const idx = el.dataset?.bIdx;
    const field = el.dataset?.bField;
    const row = state.batchDrafts[idx];
    if (!row || !field) return;
    row[field] = el.value;
    if (field === 'prompt' && row.council) {
      for (const input of e.currentTarget.querySelectorAll('[data-b-field="prompt"]')) {
        const peer = state.batchDrafts[input.dataset.bIdx];
        if (peer?.council && input !== el) input.value = peer.prompt = el.value;
      }
    }
  });
  document.getElementById('batch-rows-container')?.addEventListener('change', (e) => {
    const el = e.target;
    const idx = el.dataset?.bIdx;
    const field = el.dataset?.bField;
    if (idx === undefined || !field || !state.batchDrafts[idx]) return;
    const row = state.batchDrafts[idx];
    row.customizedFields ||= {};
    if (field === 'provider') {
      row.customizedFields.provider = true;
      row.customizedFields.model = true;
      row.customizedFields.effort = true;
      row.customizedFields.permissionMode = true;
      const previousProvider = row.provider;
      row.provider = el.value;
      reconcileModelSelection(row);
      remapPermissionOnProviderChange(row, previousProvider);
      renderBatchDraftRows();
    } else if (field === 'model') {
      handleModelSelectChange(
        el,
        row,
        () => {
          row.customizedFields.model = true;
          row.customizedFields.effort = true;
          reconcileModelSelection(row);
          renderBatchDraftRows();
        },
        () => {
          renderBatchDraftRows();
        }
      );
    } else {
      row.customizedFields[field] = true;
      row[field] = el.value;
    }
  });

  document.getElementById('btn-submit-dispatch')?.addEventListener('click', () => void submitDispatchDrawer());

  // 军师团 / 双模代码终审 / 重试 / 扩展向导 弹窗事件
  document.getElementById('btn-close-council')?.addEventListener('click', closeCouncilModal);
  document.getElementById('btn-cancel-council')?.addEventListener('click', closeCouncilModal);
  document.getElementById('btn-confirm-council')?.addEventListener('click', () => void submitCouncilSummon());

  document.getElementById('btn-close-review')?.addEventListener('click', closeCodeReviewModal);
  document.getElementById('btn-cancel-review')?.addEventListener('click', closeCodeReviewModal);
  document.getElementById('review-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'review-modal-backdrop') closeCodeReviewModal();
  });
  document.getElementById('review-mode-pair')?.addEventListener('click', (e) => {
    const mode = e.target.closest('[data-review-mode]')?.dataset.reviewMode;
    if (!mode) return;
    state.reviewDraft.reviewMode = mode;
    renderReviewModalState();
  });
  document.getElementById('review-scope-select')?.addEventListener('change', (e) => {
    state.reviewDraft.scope = e.target.value === 'branch' ? 'branch' : 'uncommitted';
    renderReviewModalState();
  });
  document.getElementById('review-provider')?.addEventListener('change', (e) => {
    state.reviewDraftCustomized = true;
    state.reviewDraft.provider = e.target.value;
    populateLinkedSelectTrio(
      document.getElementById('review-provider'),
      document.getElementById('review-model'),
      document.getElementById('review-effort'),
      state.reviewDraft
    );
  });
  document.getElementById('review-model')?.addEventListener('change', (e) => {
    handleModelSelectChange(
      e.target,
      state.reviewDraft,
      () => {
        state.reviewDraftCustomized = true;
        populateLinkedSelectTrio(
          document.getElementById('review-provider'),
          document.getElementById('review-model'),
          document.getElementById('review-effort'),
          state.reviewDraft
        );
      },
      () => {
        populateLinkedSelectTrio(
          document.getElementById('review-provider'),
          document.getElementById('review-model'),
          document.getElementById('review-effort'),
          state.reviewDraft
        );
      }
    );
  });
  document.getElementById('review-effort')?.addEventListener('change', (e) => {
    state.reviewDraftCustomized = true;
    state.reviewDraft.effort = e.target.value;
  });
  document.getElementById('btn-confirm-review')?.addEventListener('click', () => void submitCodeReviewModal());
  document.getElementById('review-pool-hint')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-review-pool]');
    if (btn) handleReviewPoolAction(btn.dataset.reviewPool);
  });
  document.getElementById('review-member-chips')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-review-member]');
    if (btn) selectReviewMember(btn.dataset.reviewMember);
  });

  const closeRetry = () => (document.getElementById('retry-modal-backdrop').hidden = true);
  document.getElementById('btn-close-retry')?.addEventListener('click', closeRetry);
  document.getElementById('btn-cancel-retry')?.addEventListener('click', closeRetry);
  document.getElementById('retry-provider')?.addEventListener('change', (e) => {
    if (!state.retryContext) return;
    state.retryContext.provider = e.target.value;
    populateLinkedSelectTrio(
      document.getElementById('retry-provider'),
      document.getElementById('retry-model'),
      document.getElementById('retry-effort'),
      state.retryContext
    );
  });
  document.getElementById('retry-model')?.addEventListener('change', (e) => {
    if (!state.retryContext) return;
    handleModelSelectChange(
      e.target,
      state.retryContext,
      () => {
        populateLinkedSelectTrio(
          document.getElementById('retry-provider'),
          document.getElementById('retry-model'),
          document.getElementById('retry-effort'),
          state.retryContext
        );
      },
      () => {
        populateLinkedSelectTrio(
          document.getElementById('retry-provider'),
          document.getElementById('retry-model'),
          document.getElementById('retry-effort'),
          state.retryContext
        );
      }
    );
  });
  document.getElementById('retry-effort')?.addEventListener('change', (e) => {
    if (state.retryContext) state.retryContext.effort = e.target.value;
  });
  document.getElementById('btn-confirm-retry')?.addEventListener('click', () => {
    if (!state.retryContext) return;
    const ctx = { ...state.retryContext };
    closeRetry();
    void executeRetry(ctx.threadId, ctx);
  });

  document.getElementById('btn-close-custom-model')?.addEventListener('click', cancelCustomModelModal);
  document.getElementById('btn-cancel-custom-model')?.addEventListener('click', cancelCustomModelModal);
  document.getElementById('btn-confirm-custom-model')?.addEventListener('click', confirmCustomModelModal);
  document.getElementById('custom-model-modal-backdrop')?.addEventListener('click', (e) => {
    if (e.target.id === 'custom-model-modal-backdrop') cancelCustomModelModal();
  });
  document.getElementById('custom-model-id-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      confirmCustomModelModal();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelCustomModelModal();
    }
  });

  const closeExt = () => (document.getElementById('ext-modal-backdrop').hidden = true);
  document.getElementById('btn-close-ext')?.addEventListener('click', closeExt);
  document.getElementById('btn-cancel-ext')?.addEventListener('click', closeExt);
  document.getElementById('btn-ext-probe')?.addEventListener('click', () => void probeWizardExtension());
  document.getElementById('btn-save-ext')?.addEventListener('click', () => void saveWizardExtension());
  document.getElementById('btn-ext-remove')?.addEventListener('click', () => {
    if (state.editingExtId) void removeOrDisableExtension(state.editingExtId);
  });

  // 全局点击外部关闭 Popovers
  document.addEventListener('click', (e) => {
    const tokPop = document.getElementById('token-popover');
    const tokBtn = document.getElementById('btn-token-breakdown');
    if (tokPop && !tokPop.hidden && !tokPop.contains(e.target) && !tokBtn?.contains(e.target)) {
      tokPop.hidden = true;
    }
    const cfgPop = document.getElementById('composer-config-popover');
    const cfgBtn = document.getElementById('btn-composer-cfg-pill');
    if (cfgPop && !cfgPop.hidden && !cfgPop.contains(e.target) && !cfgBtn?.contains(e.target)) {
      state.composerPopoverOpen = false;
      cfgPop.hidden = true;
    }
    if (state.modePopoverOpen && !modePop?.contains(e.target) && !modePill?.contains(e.target)) closeModePopover();
  });
}

/**
 * AgentTower Studio — 底部输入栏、队列条、顶栏编排模式胶囊 / 浮层、直出冻结横幅与健康告警横幅 (`ui/composer.js`)

 */
import { deriveInteractionMode, normalizePermissionForProvider } from './permissions.js';
import { escapeHtml, formatCompactNumber, formatExactNumber } from './format.js';
import { setText } from './dom-guards.js';
import { MEMBER_GROUPS, ORCHESTRATION_MODE_META, STATUS_LABELS, activeGroupMembers, applyThreadToComposerConfig, currentOrchestrationMode, getEffectiveConversationId, getEffectiveCwd, getScopedRequests, getScopedThreads, getScopedWorktrees, isConversationCollaborationEmpty, isModeStageEnabled, isStatusActive, modeRosterSummary, normalizeModeId, normalizeStatus, orchestrationModeMeta, recomputeScopedStats, state } from './state.js';
import { scheduleRender } from './render.js';
import { describeRpcError, isEmbeddedHost, rpcCall, showToast } from './net.js';
import { normalizeQueueItem, normalizeThread, normalizeTurnItem, presetDispatchRoute, shortMemberName, threadCancelCapability } from './normalize.js';
import { cancelButtonLabel, formatEffortDisplay, formatModelDisplay, formatProviderBadge, renderRuntimeRequestCard } from './widgets.js';
import { syncComposerSelects } from './options.js';
import { UNBOUND_CONVERSATION_HINT, acceptOpenIncidents, applyConversationPolicyPayload, ensureDispatchAllowedInteractive, hydrateThreadDetails, isConversationDispatchEnabled, loadBootstrap, refreshThreadsList } from './stream.js';
import { buildBoardPosts } from './board-view.js';
import { applyActiveModePayload, ensurePresetsSaved } from './presets.js';

export function focusThreadInComposer(threadId, openPopover = false) {
  const t = state.threadsMap.get(threadId);
  if (!t) return;
  state.selectedThreadId = threadId;
  state.manualTarget = true;
  applyThreadToComposerConfig(t);
  state.composerPopoverOpen = Boolean(openPopover);
  syncComposerSelects();
  scheduleRender();
  const input = document.getElementById('comp-prompt-input');
  input?.focus();
}

/**
 * 切换当前对话编排模式：乐观更新胶囊 → setConversationPolicy → 失败回滚并 Toast。
 * 切向 direct 为急刹车（冻结待出队队列）；cancelRunning 仅由「中断在途任务」显式传入。
 */
export async function handleSetOrchestrationMode(nextMode, { cancelRunning = false } = {}) {
  const convId = getEffectiveConversationId();
  if (state.conversationUnbound || (!convId && !isEmbeddedHost())) {
    showToast(`尚未选择对话，无法切换编排模式：${UNBOUND_CONVERSATION_HINT}`, 'error');
    return false;
  }
  if (!convId) {
    showToast('尚未识别到当前宿主对话 ID，请刷新后重试', 'error');
    return false;
  }
  const mode = normalizeModeId(nextMode);
  const prevPolicy = { ...state.conversationPolicy };
  const meta = orchestrationModeMeta(mode);
  state.modeSwitching = mode;
  scheduleRender();
  try {
    const rev = Number(prevPolicy.policyRevision);
    // 乐观锁全覆盖：Bootstrap 已到达后即使 source=default（revision 0）也携带期望版本，杜绝旧默认态无锁冲掉其他窗口已设的模式
    const lockRev = Number.isInteger(rev) && rev >= 0 ? rev : undefined;
    const res = await rpcCall('setConversationPolicy', {
      conversationId: convId,
      workspace: getEffectiveCwd() || undefined,
      orchestrationMode: mode,
      expectedPolicyRevision: lockRev,
      cancelRunning: Boolean(cancelRunning),
    });
    if (convId !== getEffectiveConversationId()) return false;
    state.modeSwitching = null;
    if (res?.conversationPolicy) {
      applyConversationPolicyPayload({ orchestrationMode: mode, ...res.conversationPolicy });
    } else {
      applyConversationPolicyPayload({ ...prevPolicy, orchestrationMode: mode, source: 'explicit' });
    }
    if (res?.activeMode && typeof res.activeMode === 'object') applyActiveModePayload(res.activeMode);
    if (cancelRunning && res?.cancelledCount) {
      await refreshThreadsList();
      showToast(`⏸ 已切为直出模式并中断 ${res.cancelledCount} 项在途子任务`, 'success');
    } else if (mode === 'direct') {
      showToast('⏸ 已切为直出模式：主会话独立作答，子 Agent 派发已关闭、待出队队列已冻结', 'success');
    } else {
      showToast(`⚡ 已切换为「${meta.name}」`, 'success');
    }
    scheduleRender();
    return true;
  } catch (err) {
    if (convId === getEffectiveConversationId()) {
      state.modeSwitching = null;
      state.conversationPolicy = prevPolicy;
      if (err?.code === 'POLICY_REVISION_CONFLICT') void loadBootstrap().catch(() => {});
    }
    scheduleRender();
    showToast(describeRpcError(err), 'error');
    return false;
  }
}

/** 兼容旧布尔开关入口（配置页 switch / 停发条）：开启恢复上次的非直出模式，关闭即切为 direct。 */
export async function handleToggleConversationDispatch(nextEnabled, { cancelRunning = false } = {}) {
  const resumeMode = normalizeModeId(state.lastNonDirectMode, 'relay');
  return handleSetOrchestrationMode(nextEnabled ? (resumeMode === 'direct' ? 'relay' : resumeMode) : 'direct', { cancelRunning });
}

export async function handleChangeDefaultOrchestrationMode(nextMode) {
  const mode = normalizeModeId(nextMode);
  const statusEl = document.getElementById('dispatch-default-save-status');
  if (statusEl) statusEl.textContent = '保存中…';
  // 仅用于分段控件的乐观显示；只改全局「新对话默认」，绝不改动当前对话模式
  state.defaultDispatchSaving = mode;
  scheduleRender();
  try {
    const convId = getEffectiveConversationId();
    const res = await rpcCall('setConversationPolicy', {
      conversationId: convId || undefined,
      workspace: getEffectiveCwd() || undefined,
      defaultOrchestrationMode: mode,
    });
    const saved = typeof res?.defaultOrchestrationMode === 'string' && res.defaultOrchestrationMode ? normalizeModeId(res.defaultOrchestrationMode) : mode;
    state.defaultOrchestrationMode = saved;
    state.defaultDispatchEnabled = saved !== 'direct';
    state.conversationPolicy.defaultOrchestrationMode = saved;
    state.conversationPolicy.defaultDispatchEnabled = saved !== 'direct';
    if (convId !== getEffectiveConversationId()) return;
    if (res?.conversationPolicy) applyConversationPolicyPayload(res.conversationPolicy);
    else if (state.conversationPolicy.source === 'default') {
      state.conversationPolicy.orchestrationMode = saved;
      state.conversationPolicy.dispatchEnabled = saved !== 'direct';
    }
    if (statusEl) statusEl.textContent = '已保存 ✓';
    showToast(`新开对话默认模式设为「${orchestrationModeMeta(saved).option}」`, 'success');
    scheduleRender();
  } catch (err) {
    if (statusEl) statusEl.textContent = `保存失败：${describeRpcError(err)}`;
    showToast(describeRpcError(err), 'error');
  } finally {
    state.defaultDispatchSaving = null;
    scheduleRender();
  }
}

export async function handleDismissHealthIncident(incidentId, dismissAll = false) {
  const convId = getEffectiveConversationId();
  const previous = state.healthIncidents.slice();
  const targets = dismissAll ? previous.map((inc) => String(inc.id || '')) : [String(incidentId || '')];
  const newlyDismissed = targets.filter((id) => id && !state.dismissedIncidentIds.has(id));
  if (!dismissAll && !newlyDismissed.length) return;
  // 乐观隐藏：横幅与关联成员的健康徽标立即消失（renderThreadHealthBadgeHtml 同样按集合过滤）
  for (const id of newlyDismissed) state.dismissedIncidentIds.add(id);
  state.healthIncidents = acceptOpenIncidents(state.healthIncidents);
  scheduleRender();
  try {
    // 作用域与 api/events 轮询完全一致：有对话 ID 只按对话；无对话时才按 state.workspace
    const res = await rpcCall('dismissHealthIncident', {
      incidentId: dismissAll ? undefined : incidentId,
      dismissAll: Boolean(dismissAll),
      conversationId: convId || undefined,
      workspace: convId ? undefined : state.workspace || undefined,
    });
    if (convId !== getEffectiveConversationId()) return;
    if (Array.isArray(res?.incidents)) state.healthIncidents = acceptOpenIncidents(res.incidents);
    scheduleRender();
  } catch (err) {
    // 服务端未确认：回滚乐观隐藏，恢复横幅与成员徽标
    if (convId === getEffectiveConversationId()) {
      for (const id of newlyDismissed) state.dismissedIncidentIds.delete(id);
      const current = new Map(state.healthIncidents.map((inc) => [inc.id, inc]));
      for (const inc of previous) if (!current.has(inc.id)) current.set(inc.id, inc);
      state.healthIncidents = acceptOpenIncidents([...current.values()]);
    }
    scheduleRender();
    showToast(describeRpcError(err), 'error');
  }
}

/** 派发闸门直出回复（bypassed）：统一提示文案（不重试、不启动任何子 Agent）。 */
export function showDispatchBypassedToast(res) {
  showToast(res?.summary || '当前对话处于 ⚡ 直出模式（子 Agent 派发已关闭），本次未启动任何任务，输入已保留。', 'error');
}

export async function handleComposerSubmit(mode = 'auto') {
  if (!ensureDispatchAllowedInteractive()) return;
  const epoch = state.conversationEpoch;
  const inputEl = document.getElementById('comp-prompt-input');
  const text = (inputEl?.value || '').trim();
  if (!text) {
    showToast('请先输入指令内容', 'error');
    inputEl?.focus();
    return;
  }

  if (!state.bootstrapLoaded && state.bootstrapPromise) {
    await Promise.race([state.bootstrapPromise, new Promise(r => setTimeout(r, 1500))]).catch(() => {});
  }
  if (!(await ensurePresetsSaved()) || epoch !== state.conversationEpoch) return;

  const freshContext = Boolean(document.getElementById('chk-fresh-context')?.checked);
  const ephemeral = Boolean(document.getElementById('comp-ephemeral-chk')?.checked);
  const activeThread = !ephemeral && state.selectedThreadId ? state.threadsMap.get(state.selectedThreadId) : null;
  const effectiveCwd = getEffectiveCwd();
  const permissionMode = normalizePermissionForProvider(state.composer.provider, state.composer.permissionMode);
  const interactionMode = deriveInteractionMode(permissionMode);
  // 宿主原生线程的权限由主窗口管理：续聊时不下发权限字段，后端沿用线程自身配置
  const permissionFields = activeThread?.isNativeHost ? {} : { permissionMode, runtimeMode: permissionMode, interactionMode };
  const activePermissionMode = activeThread
    ? normalizePermissionForProvider(activeThread.provider, activeThread.permissionMode || activeThread.runtimeMode)
    : '';
  const steerPermissionFields = mode === 'steer' && activeThread && permissionMode === activePermissionMode ? {} : permissionFields;
  let snapshot = null;
  const restoreDraft = () => {
    if (inputEl && !inputEl.value) inputEl.value = text;
  };
  // 乐观更新回滚：派发被闸门拦截或请求失败时恢复成员时间线 / 队列 / 状态
  const rollback = () => {
    if (!snapshot) return;
    const t = state.threadsMap.get(snapshot.id);
    if (t) {
      t.items = snapshot.items;
      t.queue = snapshot.queue;
      t.status = snapshot.status;
      t.startedAt = snapshot.startedAt;
    }
    snapshot = null;
    recomputeScopedStats();
    scheduleRender();
  };

  try {
    inputEl.value = '';
    if (!activeThread) {
      const compRoute = presetDispatchRoute(state.composer.presetKey, { ...state.composer, permissionMode }, { activePoolOnly: true });
      const res = await rpcCall('launchThread', {
        title: text.slice(0, 46),
        message: text,
        prompt: text,
        ...compRoute,
        ...(compRoute.presetKey ? {} : {
          effort: state.composer.effort,
          ...permissionFields,
        }),
        isolation: state.composer.isolation,
        workspaceStrategy: state.composer.isolation === 'worktree' ? { type: 'worktree' } : { type: 'root' },
        ...(ephemeral ? { ephemeral: true } : {}),
        cwd: effectiveCwd || undefined,
        workspace: effectiveCwd || undefined,

      });
      if (epoch !== state.conversationEpoch) return;
      if (res?.bypassed) {
        restoreDraft();
        showDispatchBypassedToast(res);
        return;
      }
      const newTid = String(res?.threadId || res?.thread?.id || res?.id || '');
      if (newTid) {
        if (ephemeral) document.getElementById('comp-ephemeral-chk').checked = false;
        state.threadsMap.set(
          newTid,
          normalizeThread(
            res.thread || {
              id: newTid,
              title: text.slice(0, 46),
              status: 'running',
              presetKey: compRoute.presetKey || '',
              provider: state.composer.provider,
              isNativeHost: false,
              model: state.composer.model,
              effort: state.composer.effort,
              permissionMode,
              interactionMode,
              isolation: state.composer.isolation,
              cwd: effectiveCwd,
              projectRoot: effectiveCwd,
              items: [{ id: `u_${Date.now()}`, type: 'user_message', text, createdAt: Date.now() }],
            }
          )
        );
        state.selectedThreadId = newTid;
        state.boardNeedsAutoScroll = true;
        void hydrateThreadDetails(newTid);
      }
      recomputeScopedStats();
      scheduleRender();
      showToast('已启动新协作线程', 'success');
      return;
    }

    snapshot = {
      id: activeThread.id,
      items: [...activeThread.items],
      queue: [...activeThread.queue],
      status: activeThread.status,
      startedAt: activeThread.startedAt,
    };
    if (mode === 'queue') {
      activeThread.queue.push({ id: `q_local_${Date.now()}`, text, createdAt: Date.now() });
    } else {
      snapshot.optimisticItemId = `u_${Date.now()}`;
      activeThread.items.push(
        normalizeTurnItem({
          id: snapshot.optimisticItemId,
          type: 'user_message',
          text,
          inputIntent: mode === 'steer' ? 'steer' : 'turn_start',
          createdAt: Date.now(),
        })
      );
      activeThread.status = 'running';
      activeThread.startedAt = Date.now();
      state.boardNeedsAutoScroll = true;
    }
    recomputeScopedStats();
    scheduleRender();

    const followsBoundPreset = Boolean(
      !activeThread.isNativeHost &&
      activeThread.presetKey &&
      state.composer.presetKey === activeThread.presetKey &&
      presetDispatchRoute(activeThread.presetKey, { ...state.composer, permissionMode }).presetKey
    );

    const sendRes = await rpcCall('sendToThread', {
      threadId: activeThread.id,
      message: text,
      prompt: text,
      mode,
      freshContext: mode === 'auto' ? freshContext : false,
      ...(followsBoundPreset ? {} : {
        ...(activeThread.provider === state.composer.provider && activeThread.model === state.composer.model ? {} :
          { provider: state.composer.provider, model: state.composer.model }),
        effort: state.composer.effort,
        ...steerPermissionFields,
      }),
    });
    if (epoch !== state.conversationEpoch) return;
    if (sendRes?.bypassed) {
      rollback();
      restoreDraft();
      showDispatchBypassedToast(sendRes);
      return;
    }

    const sendAction = sendRes?.action;
    if (sendAction === 'queued') {
      activeThread.items = activeThread.items.filter((item) => item.id !== snapshot.optimisticItemId);
      activeThread.status = snapshot.status;
      activeThread.startedAt = snapshot.startedAt;
      if (Array.isArray(sendRes?.queue)) {
        activeThread.queue = sendRes.queue.map((q, i) => normalizeQueueItem(q, i)).filter(Boolean);
      } else if (mode !== 'queue') {
        activeThread.queue = [...snapshot.queue, normalizeQueueItem({ id: `q_local_${Date.now()}`, text, createdAt: Date.now() })];
      }
      snapshot = null;
      recomputeScopedStats();
      showToast('已排入待发队列（当前回合结束后自动执行）', 'info');
    } else {
      snapshot = null;
      if (Array.isArray(sendRes?.queue)) {
        activeThread.queue = sendRes.queue.map((q, i) => normalizeQueueItem(q, i)).filter(Boolean);
      }
      if (sendAction === 'steered_live') showToast('⚡ Steer 即时纠偏指令已注入当前回合', 'success');
      else if (sendAction === 'steering_restart') showToast('↻ 当前引擎不支持热注入，已中断本轮并带新指令重启续跑', 'success');
      else if (sendAction === 'started' || sendAction === 'completed') showToast('已启动续聊回合', 'success');
      else if (mode === 'queue') showToast('已排入待发队列', 'success');
      else if (mode === 'steer') showToast('⚡ Steer 指令已发送，等待成员状态同步', 'info');
      else showToast('已发送续聊指令', 'success');
    }
    scheduleRender();
  } catch (err) {
    if (epoch !== state.conversationEpoch) return;
    rollback();
    showToast(describeRpcError(err), 'error');
    restoreDraft();
  }
}

export async function handleQueueAction(threadId, action, queueItem, extra = {}) {
  const thread = state.threadsMap.get(threadId);
  if (!thread || !queueItem) return;
  try {
    const res = await rpcCall('manageQueue', {
      threadId,
      action,
      queueId: queueItem.id,
      queuedRunId: queueItem.id,
      itemId: queueItem.id,
      ...extra,
    });
    if (Array.isArray(res?.queue)) {
      thread.queue = res.queue.map((q, i) => normalizeQueueItem(q, i)).filter(Boolean);
    } else {
      const idx = thread.queue.findIndex((q) => q.id === queueItem.id);
      if (idx >= 0) {
        if (action === 'cancel' || action === 'promote_to_steer') {
          thread.queue.splice(idx, 1);
        } else if (action === 'edit' && extra.text) {
          thread.queue[idx].text = extra.text;
        } else if (action === 'reorder') {
          const swapIdx = extra.direction === 'up' ? idx - 1 : idx + 1;
          if (swapIdx >= 0 && swapIdx < thread.queue.length) {
            const tmp = thread.queue[idx];
            thread.queue[idx] = thread.queue[swapIdx];
            thread.queue[swapIdx] = tmp;
          }
        }
      }
    }
    if (action === 'promote_to_steer') {
      if (res?.steerResult?.action === 'steering_restart') {
        showToast('↻ 当前引擎不支持热注入，已中断本轮并带新指令重启续跑', 'success');
      } else {
        showToast('⚡ 排队消息已提升为即时 Steer 注入', 'success');
      }
      await hydrateThreadDetails(threadId);
    }
    scheduleRender();
  } catch (err) {
    showToast(describeRpcError(err), 'error');
  }
}

function applyInlineFlex(el, prop, value) {
  if (el && el.style[prop] !== value) el.style[prop] = value;
}

export function renderHeaderAndTitleBar() {
  const standaloneSel = document.getElementById('standalone-conv-select');
  const convList = Array.isArray(state.availableConversations) ? state.availableConversations : [];
  const showStandaloneSel = !isEmbeddedHost() && (convList.length > 0 || state.conversationUnbound);
  if (standaloneSel) {
    standaloneSel.hidden = !showStandaloneSel;
    if (showStandaloneSel) {
      const unbound = state.conversationUnbound || !state.activeConversationId;
      const options = [];
      const seen = new Set();
      for (const c of convList) {
        const cid = String(c?.rootConversationId || c?.conversationId || '').trim();
        if (!cid || seen.has(cid)) continue;
        seen.add(cid);
        const lbl = `${String(c.title || c.conversationTitle || cid.slice(0, 8))}${c.isRecentHost ? '（插件当前）' : ''}`;
        options.push(`<option value="${escapeHtml(cid)}">${escapeHtml(lbl)}</option>`);
      }
      if (unbound) {
        options.unshift(`<option value="">${convList.length > 0 ? '请选择要查看的对话…' : '暂无活跃对话（请从插件复制链接）'}</option>`);
      } else if (!seen.has(state.activeConversationId)) {
        // 已绑定会话尚未出现在候选列表（如刚由链接打开）：补充当前项，保证下拉选中态一致
        const cur = state.activeConversationId;
        options.unshift(`<option value="${escapeHtml(cur)}">${escapeHtml(state.conversationTitle || cur.slice(0, 8))}</option>`);
      }
      standaloneSel.innerHTML = options.join('');
      standaloneSel.value = unbound ? '' : state.activeConversationId;
      standaloneSel.title = unbound ? '尚未选择对话：请选择要查看的宿主对话，或从 IDE 插件侧栏复制链接' : '切换要查看的对话';
      // 380px 窄栏零横向溢出 + 模式胶囊文案不被裁切：下拉可收缩省略（固有宽度取最长选项），标题组优先让位（下拉已显示当前对话名），
      // 胶囊保持自身宽度（styles.css 已封顶 96px）。仅独立网页端显示下拉时施加，宿主布局不受影响。
      applyInlineFlex(standaloneSel, 'minWidth', '0px');
      applyInlineFlex(standaloneSel, 'flexShrink', '2.5');
      const headingGroup = document.getElementById('swarm-heading-group');
      applyInlineFlex(headingGroup, 'minWidth', '0px');
      applyInlineFlex(headingGroup, 'flexShrink', '6');
      applyInlineFlex(document.getElementById('btn-conv-dispatch-toggle'), 'flexShrink', '0');
    }
  }

  const scoped = getScopedThreads();
  const fallbackTitle = scoped.length > 0 ? shortMemberName(scoped[0]) : 'AgentTower';
  const headingGroup = document.getElementById('swarm-heading-group');
  const titleEl = document.getElementById('swarm-title');
  const subtitleEl = document.getElementById('swarm-subtitle');
  if (state.conversationUnbound) {
    setText('swarm-title', '未选择对话');
    if (subtitleEl) {
      setText('swarm-subtitle', '');
      subtitleEl.hidden = true;
    }
    const unboundTip = '当前独立浏览器尚未绑定对话';
    if (headingGroup && headingGroup.title !== unboundTip) headingGroup.title = unboundTip;
    if (titleEl && titleEl.title !== unboundTip) titleEl.title = unboundTip;
  } else {
    const effCwd = getEffectiveCwd();
    const projName = String(state.projectName || '').trim() || (effCwd ? effCwd.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '' : '');
    const convTitle = String(state.conversationTitle || '').trim();
    const primary = projName || convTitle || fallbackTitle;
    const showSub = Boolean(projName && convTitle && convTitle !== primary && convTitle !== 'AgentTower');
    setText('swarm-title', primary);
    if (subtitleEl) {
      setText('swarm-subtitle', showSub ? convTitle : '');
      subtitleEl.hidden = !showSub;
    }
    const fullHover = [
      projName ? `项目：${projName}${effCwd ? ` (${effCwd})` : ''}` : effCwd ? `路径：${effCwd}` : '',
      convTitle ? `会话：${convTitle}` : '',
    ].filter(Boolean).join('\n') || '当前独立对话协作看板';
    if (headingGroup && headingGroup.title !== fullHover) headingGroup.title = fullHover;
    if (titleEl && titleEl.title !== fullHover) titleEl.title = fullHover;
  }

  const dot = document.getElementById('conn-status-dot');
  const lbl = document.getElementById('conn-status-label');
  if (dot && lbl) {
    dot.className = 'sw-live-dot ' + state.connMode;
    lbl.textContent =
      state.connMode === 'sse' ? '实时' : state.connMode === 'poll' ? '轮询' : state.connMode === 'offline' ? '离线' : state.connMode === 'unbound' ? '待选' : '连接中';
    // 独立网页端离线：守护进程升级重启后旧链接的会话凭据失效，需从插件侧栏重新复制访问链接
    const connTitle = state.connMode === 'offline'
      ? isEmbeddedHost() ? '连接已断开，正在自动重试' : '连接已断开；若后台守护进程刚升级重启，请从插件侧栏重新复制访问链接'
      : '实时同步连接状态';
    const badge = document.getElementById('conn-live-badge');
    if (badge && badge.title !== connTitle) badge.title = connTitle;
  }

  const dispToggleBtn = document.getElementById('btn-conv-dispatch-toggle');
  const dispToggleIco = document.getElementById('conv-dispatch-icon');
  const dispToggleTxt = document.getElementById('conv-dispatch-text');
  const dispEnabled = isConversationDispatchEnabled();
  const mode = currentOrchestrationMode();
  const modeMeta = orchestrationModeMeta(mode);
  if (dispToggleBtn && dispToggleIco && dispToggleTxt && state.conversationUnbound) {
    // 未绑定对话：中性禁用态胶囊，点击仅提示先选对话（不展开模式浮层）
    const cls = `hdr-chip-btn mode-pill ${orchestrationModeMeta('direct').cls} is-unbound`;
    if (dispToggleBtn.className !== cls) dispToggleBtn.className = cls;
    dispToggleBtn.dataset.mode = 'unbound';
    dispToggleBtn.setAttribute('aria-expanded', 'false');
    dispToggleBtn.setAttribute('aria-disabled', 'true');
    setText('conv-dispatch-icon', '⚡');
    setText('conv-dispatch-text', '未选对话▾');
    if (dispToggleBtn.dataset.longLabel !== '未选对话▾') dispToggleBtn.dataset.longLabel = '未选对话▾';
    dispToggleBtn.title = '尚未选择对话：请先在顶栏下拉框选择要查看的对话，或从 IDE 插件侧栏复制链接';
    dispToggleBtn.setAttribute('aria-label', '尚未选择对话，请先在顶栏下拉框选择要查看的对话');
  } else if (dispToggleBtn && dispToggleIco && dispToggleTxt) {
    dispToggleBtn.removeAttribute('aria-disabled');
    // 胶囊：「⚡ 直出▾ / 简单▾ / 复杂▾」，窄栏宽度 ≤ 96px；宽屏（≥ 1024px）改显完整名「简单模式▾ / 复杂自定义▾」；dispatch-on/off 兼容旧选择器
    const cls = `hdr-chip-btn mode-pill ${modeMeta.cls}${state.modeSwitching ? ' is-switching' : ''}`;
    if (dispToggleBtn.className !== cls) dispToggleBtn.className = cls;
    dispToggleBtn.dataset.mode = mode;
    dispToggleBtn.setAttribute('aria-expanded', String(state.modePopoverOpen));
    setText('conv-dispatch-icon', '⚡');
    setText('conv-dispatch-text', `${modeMeta.short}▾`);
    // 宽屏完整模式名经 CSS ::after { content: attr(data-long-label) } 呈现（不增加文本节点，textContent 契约不变）
    const longLabel = `${modeMeta.id === 'direct' ? modeMeta.short : modeMeta.name}▾`;
    if (dispToggleBtn.dataset.longLabel !== longLabel) dispToggleBtn.dataset.longLabel = longLabel;
    dispToggleBtn.title = `当前对话编排模式：${modeMeta.name}（${modeMeta.desc}）· 点击切换`;
    dispToggleBtn.setAttribute('aria-label', `当前对话编排模式：${modeMeta.name}，点击切换`);
  }
  renderModePopover();
  for (const btnId of [
    'btn-open-dispatch',
    'btn-empty-dispatch',
    'btn-empty-council',
    'btn-summon-council',
    'btn-astra-review',
    'btn-board-dispatch',
  ]) {
    const b = document.getElementById(btnId);
    if (b) b.classList.toggle('is-dispatch-disabled-btn', !dispEnabled);
  }
  renderStageGatedEntries(mode);

  const st = state.stats;
  const tokLabel = formatCompactNumber(st.totalTokens || 0);
  setText('hdr-telemetry-brief', `${st.running || 0}运行 · ${st.pending || 0}待批 · ${tokLabel}`);

  setText('popover-scope-title', `${state.conversationTitle || '当前独立对话'} · 实时消耗`);
  setText('stat-running-count', String(st.running || 0));
  setText('stat-pending-count', String(st.pending || 0));
  setText('stat-completed-count', String(st.completed || 0));
  setText('tok-input', formatExactNumber(st.inputTokens));
  setText('tok-cached', formatExactNumber(st.cachedTokens));
  setText('tok-reasoning', formatExactNumber(st.reasoningTokens));
  setText('tok-output', formatExactNumber(st.outputTokens));
  setText('tok-total', formatExactNumber(st.totalTokens));

  const urlBox = document.getElementById('studio-url-box');
  // 独立网页端无需 studioUrl 也可按当前绑定会话拼出无密链接；宿主内仍以受信 studioUrl 为准
  if (urlBox) urlBox.hidden = !(state.studioUrl || (!isEmbeddedHost() && !state.conversationUnbound));
}

/**
 * 军师会诊 / 独立终审入口按当前模式阵容置灰：简单模式无军师与审核阶段；复杂模式关闭对应阶段时同样置灰并说明。
 * 只写 class / aria-disabled / title，不改按钮文案；点击后由 modals.js 给出友好提示（不静默失败）。
 */
export function stageGateMessage(group, mode = currentOrchestrationMode()) {
  if (mode === 'direct') return '';
  const label = group === 'advisor' ? '军师会诊' : '独立终审';
  if (mode === 'relay') return `简单模式不含${label}：主会话确认意图后由已勾选执行官改码并合并汇报；如需${label}请切换到「复杂自定义」模式`;
  if (!isModeStageEnabled('complex', group)) return `当前复杂模式已关闭${group === 'advisor' ? '军师' : '审核'}阶段，可在配置页开启`;
  if (!activeGroupMembers(group, 'complex').length) return `当前复杂模式${group === 'advisor' ? '军师' : '审核'}阶段尚未勾选任何成员，请在配置页勾选`;
  return '';
}
function renderStageGatedEntries(mode) {
  const gates = [
    ['advisor', ['btn-summon-council', 'btn-empty-council', 'btn-tpl-council']],
    ['reviewer', ['btn-astra-review', 'btn-wt-review']],
  ];
  for (const [group, ids] of gates) {
    const msg = stageGateMessage(group, mode);
    for (const id of ids) {
      const b = document.getElementById(id);
      if (!b) continue;
      if (b.dataset.baseTitle === undefined) b.dataset.baseTitle = b.getAttribute('title') || '';
      b.classList.toggle('is-stage-off', Boolean(msg));
      if (msg) b.setAttribute('aria-disabled', 'true');
      else b.removeAttribute('aria-disabled');
      const title = msg || b.dataset.baseTitle;
      if (title) b.setAttribute('title', title);
      else b.removeAttribute('title');
    }
  }
}

/* ---------- 顶栏模式胶囊浮层（#conv-mode-popover：264px 单列、position: fixed 右对齐胶囊下沿） ---------- */
export function positionModePopover() {
  const pop = document.getElementById('conv-mode-popover');
  const pill = document.getElementById('btn-conv-dispatch-toggle');
  if (!pop || !pill || pop.hidden) return;
  const r = pill.getBoundingClientRect();
  const vw = document.documentElement.clientWidth || window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(264, vw - 16);
  pop.style.width = `${width}px`;
  pop.style.top = `${Math.round(r.bottom + 6)}px`;
  pop.style.left = `${Math.round(Math.min(Math.max(8, r.right - width), vw - width - 8))}px`;
  pop.style.maxHeight = `${Math.max(160, vh - r.bottom - 14)}px`;
}

export function renderModePopover() {
  const pop = document.getElementById('conv-mode-popover');
  if (!pop) return;
  if (state.conversationUnbound) state.modePopoverOpen = false;
  if (!state.modePopoverOpen) {
    if (!pop.hidden) pop.hidden = true;
    return;
  }
  const mode = currentOrchestrationMode();
  const options = [...ORCHESTRATION_MODE_META];
  if (!options.some((m) => m.id === mode)) options.push(orchestrationModeMeta(mode));
  const defaultMeta = orchestrationModeMeta(state.defaultOrchestrationMode);
  pop.innerHTML = `${options.map((m) => {
    const on = m.id === mode;
    const summary = modeRosterSummary(m.id);
    const item = `<button type="button" role="menuitemradio" aria-checked="${on}" class="mode-pop-item ${escapeHtml(m.cls.split(' ')[0])}${on ? ' is-selected' : ''}" data-mode-option="${escapeHtml(m.id)}" tabindex="-1">
        <span class="mode-pop-radio" aria-hidden="true"></span>
        <span class="mode-pop-main"><span class="mode-pop-name">${escapeHtml(m.name)}</span><span class="mode-pop-desc">${escapeHtml(m.desc)}</span>${summary ? `<span class="mode-pop-roster" data-mode-roster="${escapeHtml(m.id)}">${escapeHtml(summary)}</span>` : ''}</span>
      </button>`;
    // 非直出模式附「配置阵容 →」快捷入口（独立 menuitem，不嵌套在单选项按钮内）
    const roster = m.id === 'direct' ? '' : `<button type="button" role="menuitem" class="mode-pop-roster-link" data-mode-goto-roster="${escapeHtml(m.id)}" tabindex="-1" aria-label="${escapeHtml(`配置${m.name}阵容`)}">配置阵容 →</button>`;
    return `<div class="mode-pop-row${on ? ' is-selected' : ''}" role="none">${item}${roster}</div>`;
  }).join('')}<div class="mode-pop-sep" role="separator"></div><button type="button" role="menuitem" class="mode-pop-foot" data-mode-goto-config tabindex="-1">⚙ 新对话默认：${escapeHtml(defaultMeta.short)}（去配置）</button>`;
  pop.hidden = false;
  positionModePopover();
}

export function openModePopover(focusSelected = false) {
  state.modePopoverOpen = true;
  renderModePopover();
  const pill = document.getElementById('btn-conv-dispatch-toggle');
  pill?.setAttribute('aria-expanded', 'true');
  if (focusSelected) {
    const pop = document.getElementById('conv-mode-popover');
    (pop?.querySelector('[role="menuitemradio"][aria-checked="true"]') || pop?.querySelector('[role^="menuitem"]'))?.focus({ preventScroll: true });
  }
}

export function closeModePopover(restoreFocus = false) {
  if (!state.modePopoverOpen) return;
  state.modePopoverOpen = false;
  renderModePopover();
  const pill = document.getElementById('btn-conv-dispatch-toggle');
  pill?.setAttribute('aria-expanded', 'false');
  if (restoreFocus) pill?.focus({ preventScroll: true });
}

export function renderMainViewTabs() {
  const scopedThreads = getScopedThreads();
  const scopedWt = getScopedWorktrees();
  const enabledExtCount = state.customProviders.filter((c) => c.enabled !== false).length;
  const isEmpty = isConversationCollaborationEmpty(scopedThreads, state.boardMessages);

  const postsCount = isEmpty ? 0 : buildBoardPosts(scopedThreads).length;
  const membersCount = isEmpty ? 0 : scopedThreads.length;

  const applyTabBadge = (id, count) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = String(count);
    el.hidden = count <= 0;
  };
  applyTabBadge('tab-badge-board', postsCount);
  applyTabBadge('tab-badge-members', membersCount);
  applyTabBadge('tab-badge-diff', scopedWt.length);
  applyTabBadge('tab-badge-extensions', enabledExtCount);
  const projectDispatchDot = document.getElementById('tab-dot-project-dispatch');
  if (projectDispatchDot) projectDispatchDot.hidden = state.conversationUnbound || isConversationDispatchEnabled();

  document.querySelectorAll('#main-view-tabs .sw-tab').forEach((btn) => {
    const v = btn.dataset.view;
    btn.classList.toggle('active', v === state.activeView);
    btn.setAttribute('aria-selected', String(v === state.activeView));
  });
  // 供 CSS 按视图收起底栏：#studio-app[data-view="settings"] / [data-view="global"] #at-composer
  const appEl = document.getElementById('studio-app');
  if (appEl && appEl.dataset.view !== state.activeView) appEl.dataset.view = state.activeView;

  const viewIds = ['board', 'members', 'diff', 'settings', 'global'];
  for (const v of viewIds) {
    const panel = document.getElementById(`view-${v}`);
    if (panel) panel.hidden = state.activeView !== v;
  }
}

function getActiveExternalRunningThreads() {
  return getScopedThreads().filter((t) => !t.isNativeHost && isStatusActive(t.status));
}

export function renderDispatchPausedStrip() {
  const strip = document.getElementById('dispatch-paused-strip');
  if (!strip) return;
  if (state.conversationUnbound) {
    // 未绑定对话：中性引导（非告警色、无操作按钮），不冒充直出模式
    strip.hidden = false;
    strip.classList.remove('is-frozen');
    strip.classList.add('is-unbound');
    strip.innerHTML = `
      <div class="dispatch-paused-msg">
        <strong>${escapeHtml(UNBOUND_CONVERSATION_HINT)}</strong>
      </div>
    `;
    return;
  }
  strip.classList.remove('is-unbound');
  if (isConversationDispatchEnabled()) {
    strip.hidden = true;
    strip.innerHTML = '';
    return;
  }
  const runningExternal = getActiveExternalRunningThreads().length;
  const runningCount = Math.max(runningExternal, Number(state.conversationPolicy.runningCount || 0));
  const queuedCount = Number(state.conversationPolicy.queuedCount || 0);
  const pending = runningCount + queuedCount;
  strip.hidden = false;
  // 新对话默认即 direct：无在途 / 排队时为中性静音提示，有冻结任务时才升级为琥珀色告警
  strip.classList.toggle('is-frozen', pending > 0);
  const detail = pending > 0
    ? `<div class="dispatch-paused-sub">待出队队列已冻结（${queuedCount} 项）${runningCount > 0 ? ` · 在途 ${runningCount} 项将自然收尾` : ''}</div>`
    : '';
  strip.innerHTML = `
      <div class="dispatch-paused-msg">
        <strong>当前对话处于 ⚡ 直出模式（子 Agent 派发已关闭）</strong>
        ${detail}
      </div>
      <div class="dispatch-paused-actions">
        ${runningCount > 0 ? '<button type="button" class="ghost-xs-btn danger-txt" data-paused-action="cancel_running">■ 中断在途任务</button>' : ''}
        <button type="button" class="ghost-xs-btn is-accent" data-paused-action="switch_relay">⚡ 切为简单模式</button>
      </div>
    `;
}

export function renderWatchdogIncidentsBanner() {
  const banner = document.getElementById('watchdog-incidents-banner');
  if (!banner) return;
  const openIncidents = acceptOpenIncidents(state.healthIncidents);
  if (openIncidents.length === 0) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  const headHtml =
    openIncidents.length > 1
      ? `<div class="watchdog-banner-head"><span>🛡 看门狗监控告警 (${openIncidents.length})</span><button type="button" class="ghost-xs-btn" data-inc-action="dismiss_all">全部已读</button></div>`
      : '';
  const cardsHtml = openIncidents
    .slice(0, 4)
    .map((inc) => {
      const sev = inc.severity === 'error' ? 'sev-error' : inc.severity === 'info' ? 'sev-info' : 'sev-warning';
      const icon = inc.severity === 'error' ? '⛔' : inc.severity === 'info' ? '↻' : '⚠';
      const threadBtn =
        inc.threadId && state.threadsMap.has(inc.threadId)
          ? `<button type="button" class="ghost-xs-btn" data-inc-action="locate" data-inc-thread="${escapeHtml(inc.threadId)}">定位成员</button>`
          : '';
      return `
          <div class="watchdog-incident-card ${sev}" data-incident-id="${escapeHtml(inc.id)}">
            <div class="watchdog-inc-main">
              <div class="watchdog-inc-title">${icon} ${escapeHtml(inc.title || '子任务健康告警')}</div>
              ${inc.detail ? `<div class="watchdog-inc-detail">${escapeHtml(inc.detail)}</div>` : ''}
            </div>
            <div class="watchdog-inc-actions">
              ${threadBtn}
              <button type="button" class="ghost-xs-btn" data-inc-action="dismiss" data-inc-id="${escapeHtml(inc.id)}">忽略</button>
            </div>
          </div>
        `;
    })
    .join('');
  banner.innerHTML = headHtml + cardsHtml;
}

export function renderGlobalRequestsBanner() {
  const banner = document.getElementById('global-requests-banner');
  if (!banner) return;
  const reqs = getScopedRequests();
  if (reqs.length === 0) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = reqs.map((req) => renderRuntimeRequestCard(req)).join('');
}

export function renderComposerState() {
  // 1. Popover 显示与目标线程列表同步
  const popEl = document.getElementById('composer-config-popover');
  if (popEl) popEl.hidden = !state.composerPopoverOpen;

  const targetSelect = document.getElementById('comp-target-thread');
  const scoped = getScopedThreads();
  if (targetSelect && document.activeElement !== targetSelect) {
    const opts = [
      `<option value="__NEW__">+ 新建交互线程（当前对话）</option>`,
      ...scoped.map((t) => {
        const s = STATUS_LABELS[normalizeStatus(t.status)] || t.status;
        const label = shortMemberName(t);
        return `<option value="${escapeHtml(t.id)}">${escapeHtml(label)} (${escapeHtml(s)})</option>`;
      }),
    ];
    targetSelect.innerHTML = opts.join('');
    if (state.selectedThreadId && scoped.some((t) => t.id === state.selectedThreadId)) {
      targetSelect.value = state.selectedThreadId;
    } else {
      targetSelect.value = '__NEW__';
    }
  }

  const disposable = document.getElementById('comp-ephemeral-chk')?.checked;
  const activeThread = !disposable && state.selectedThreadId ? state.threadsMap.get(state.selectedThreadId) : null;
  const isRunning = Boolean(activeThread && isStatusActive(activeThread.status));
  const preset = document.getElementById('comp-preset');
  if (preset) {
    preset.disabled = Boolean(activeThread);
    const selected = activeThread ? '' : presetDispatchRoute(state.composer.presetKey, state.composer, { activePoolOnly: true }).presetKey || '';
    // 全界面严锁勾选池：只列当前对话模式阵容中有效启用的成员（简单模式只有执行官；复杂模式按阶段开关）
    const groups = MEMBER_GROUPS.map((g) => {
      const members = activeGroupMembers(g.id);
      if (!members.length) return '';
      return `<optgroup label="${escapeHtml(g.title)}">${members.map((p) => `<option value="${escapeHtml(p.key)}">${escapeHtml(p.label || p.key)}</option>`).join('')}</optgroup>`;
    }).join('');
    preset.innerHTML = '<option value="">自定义</option>' + groups;
    preset.value = selected;
  }

  // 2. 更新紧凑配置胶囊文案（目标 · 引擎/模型 · 思考 · 隔离）
  const activeShortName = activeThread ? shortMemberName(activeThread) : '';
  const targetName = activeThread
    ? activeShortName.length > 14
      ? `${activeShortName.slice(0, 13)}…`
      : activeShortName
    : '新会话';
  const modShort = formatModelDisplay(
    state.composer.model,
    activeThread?.effectiveModel || activeThread?.meta?.effectiveModel || ''
  );
  const effShort = formatEffortDisplay(
    state.composer.effort,
    activeThread?.effectiveEffort || activeThread?.meta?.effectiveEffort || ''
  );
  const isoShort = state.composer.isolation === 'worktree' ? 'Worktree' : '共享';
  setText('comp-pill-text', `${targetName} · ${formatProviderBadge(state.composer.provider)}/${modShort} · ${effShort} · ${isoShort}`);
  const promptInput = document.getElementById('comp-prompt-input');
  if (promptInput) {
    const placeholder = isRunning
      ? `输入即时纠偏指令，回车立即 Steer 注入给 ${activeShortName}…`
      : '向当前目标发指令（空闲续聊 / 运行中 Steer 纠偏，Ctrl+Enter 发送）...';
    if (promptInput.placeholder !== placeholder) promptInput.placeholder = placeholder;
  }

  // 3. 排队条渲染
  const queueStrip = document.getElementById('composer-queue-strip');
  const queueList = document.getElementById('queue-items-list');
  const qItems = activeThread?.queue || [];
  if (queueStrip && queueList) {
    if (qItems.length === 0) {
      queueStrip.hidden = true;
      queueList.innerHTML = '';
    } else {
      queueStrip.hidden = false;
      setText('queue-count', String(qItems.length));
      queueList.innerHTML = qItems
        .map(
          (q, idx) => `
          <div class="queue-item-row" data-qid="${escapeHtml(q.id)}">
            <span class="queue-item-text">${idx + 1}. ${escapeHtml(q.text)}</span>
            <div class="queue-item-btns">
              <button type="button" class="q-mini-btn" data-qact="up" data-qid="${escapeHtml(q.id)}" ${idx === 0 ? 'disabled' : ''}>↑</button>
              <button type="button" class="q-mini-btn" data-qact="down" data-qid="${escapeHtml(q.id)}" ${idx === qItems.length - 1 ? 'disabled' : ''}>↓</button>
              <button type="button" class="q-mini-btn promote" data-qact="promote_to_steer" data-qid="${escapeHtml(q.id)}">⚡ Steer</button>
              <button type="button" class="q-mini-btn" data-qact="cancel" data-qid="${escapeHtml(q.id)}">✕</button>
            </div>
          </div>`
        )
        .join('');
    }
  }

  // 4. 空闲发送 vs 运行中 Steer/排队/两段式中断
  const idleBox = document.getElementById('comp-idle-actions');
  const runBox = document.getElementById('comp-running-actions');
  const stopBtn = document.getElementById('btn-comp-stop');
  if (idleBox && runBox) {
    idleBox.hidden = isRunning;
    runBox.hidden = !isRunning;
  }

  const sendBtn = document.getElementById('btn-comp-send');
  if (sendBtn) {
    sendBtn.textContent = activeThread ? '发送续聊' : '新建对话';
  }

  const stopCapability = activeThread ? threadCancelCapability(activeThread) : 'none';
  if (stopBtn) stopBtn.hidden = !activeThread || stopCapability === 'host_only' || stopCapability === 'none';
  if (stopBtn && activeThread) {
    const trk = state.interruptTracker.get(activeThread.id);
    stopBtn.className = trk?.escalated ? 'stop-btn force-escalated' : 'stop-btn';
    stopBtn.textContent = cancelButtonLabel(activeThread);
  }
}

/**
 * AgentTower Studio — 线程级通用动作：两段式中断与待批请求响应 (`ui/actions.js`)

 */
import { getEffectiveCwd, isStatusActive, recomputeScopedStats, state } from './state.js';
import { scheduleRender } from './render.js';
import { armOrConfirm, describeRpcError, rpcCall, showToast } from './net.js';
import { applySessionAndUpdatePayload, isSystemUpdateTransitionState, normalizeSystemUpdate, threadCancelCapability } from './normalize.js';
import { clearInterruptTracker } from './stream.js';

export async function handleTwoStageCancel(threadId) {
  if (!threadId) return;
  const thread = state.threadsMap.get(threadId);
  if (!thread) return;
  const capability = threadCancelCapability(thread);
  if (capability === 'none') return;
  if (capability === 'host_only') {
    showToast('该成员运行在 Antigravity 宿主主会话内，插件无法代为中断；请在主窗口停止回合。', 'info');
    return;
  }
  if (state.cancelInFlight.has(threadId)) return; // 防连击：在途请求未返回前忽略重复点击

  const tracker = state.interruptTracker.get(threadId);
  const force = Boolean(tracker?.escalated);
  // 两阶段强杀绑定首击时的回合：第二击（强制）携带同一 runId，后端据此拒绝误杀下一轮
  const expectedRunId = tracker?.runId || thread.activeRunId || undefined;
  state.cancelInFlight.add(threadId);
  scheduleRender();
  try {
    const res = await rpcCall('cancelTask', { threadId, force, expectedRunId, runId: expectedRunId });
    const latest = state.threadsMap.get(threadId);
    if (res?.cancelState === 'host_only' || (res?.unsupported && !res?.cancelled)) {
      clearInterruptTracker(threadId);
      const children = Array.isArray(res?.cancelledThreadIds) ? res.cancelledThreadIds.length : 0;
      showToast(`${res?.error || '宿主原生回合须在 Antigravity 主窗口停止。'}${children ? `（已级联中断 ${children} 个外部子成员）` : ''}`, 'info');
      return;
    }
    if (res?.alreadyFinished || res?.cancelState === 'stale_run') {
      clearInterruptTracker(threadId);
      showToast('该回合已结束，无需中断（已防止误杀下一轮）', 'info');
      return;
    }
    if (res?.reconciledOrphan || res?.cancelState === 'orphaned_reconciled') {
      clearInterruptTracker(threadId);
      if (latest) {
        latest.status = 'interrupted';
        latest.activeRunId = '';
        latest.cancelCapability = 'none';
        latest.completedAt = Date.now();
      }
      recomputeScopedStats();
      showToast('已收割失联的运行态（原守护进程已不在），成员已标记为已中断', 'success');
      return;
    }
    if (!res?.cancelled) throw new Error(res?.error || '未能中断会话');
    if (force) {
      clearInterruptTracker(threadId);
      recomputeScopedStats();
      showToast('⚡ 已强制终止子进程树', 'success');
      return;
    }
    showToast('已发送优雅中断信号 (2 秒未停可点击强制终止)...');
    clearInterruptTracker(threadId);
    const timer = setTimeout(() => {
      const cur = state.threadsMap.get(threadId);
      const trk = state.interruptTracker.get(threadId);
      if (cur && isStatusActive(cur.status) && trk && !trk.escalated) {
        state.interruptTracker.set(threadId, { ...trk, escalated: true, timer: null });
        scheduleRender();
      } else if (trk && !trk.escalated) {
        clearInterruptTracker(threadId);
      }
    }, 2000);
    state.interruptTracker.set(threadId, { escalated: false, timer, runId: expectedRunId || '' });
    if (res?.runId) {
      const tracked = state.interruptTracker.get(threadId);
      if (tracked) tracked.runId = res.runId;
    }
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    state.cancelInFlight.delete(threadId);
    scheduleRender();
  }
}

export async function respondToRequest(req, payload) {
  try {
    await rpcCall('respondRuntimeRequest', {
      requestId: req.id,
      runtimeRequestId: req.id,
      reqId: req.id,
      threadId: req.threadId,
      runId: req.runId || undefined,
      kind: req.kind,
      ...payload,
    });
    state.pendingRequests.delete(req.id);
    const t = state.threadsMap.get(req.threadId);
    if (t && (t.status === 'pending_approval' || t.status === 'waiting_input' || t.status === 'waiting')) {
      t.status = 'running';
    }
    recomputeScopedStats();
    scheduleRender();
    showToast('已提交响应，任务继续执行', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function saveGlobalBoolean(field, savingField) {
  if (typeof state[savingField] === 'boolean') return false;
  const next = !(state[field] === true);
  const statusEl = field === 'defaultExternalSessionVisible' ? document.getElementById('default-external-session-save-status') : null;
  state[savingField] = next;
  if (statusEl) statusEl.textContent = '保存中…';
  scheduleRender();
  try {
    const res = await rpcCall('saveSettings', { scope: 'global', [field]: next });
    applySessionAndUpdatePayload(res || {});
    const saved = res?.settings?.[field] ?? res?.[field];
    state[field] = typeof saved === 'boolean' ? saved : next;
    if (statusEl) statusEl.textContent = '已保存 ✓';
    showToast(field === 'defaultExternalSessionVisible'
      ? (next ? '新任务默认在外部客户端保留会话' : '新任务默认隐藏外部会话，塔台内追问不受影响')
      : (next ? '已开启自动检测新版本' : '已关闭自动检测新版本'), 'success');
    return true;
  } catch (err) {
    if (statusEl) statusEl.textContent = `保存失败：${describeRpcError(err)}`;
    showToast(describeRpcError(err), 'error');
    return false;
  } finally {
    state[savingField] = null;
    scheduleRender();
  }
}

export async function toggleDefaultExternalSessionVisible() {
  return saveGlobalBoolean('defaultExternalSessionVisible', 'defaultExternalSessionSaving');
}

export async function toggleAutoCheckUpdates() {
  return saveGlobalBoolean('autoCheckUpdates', 'autoCheckUpdatesSaving');
}

export async function setProjectExternalSessionMode(mode) {
  if (!['inherit', 'hidden', 'visible'].includes(mode) || state.projectExternalSessionSaving) return false;
  const workspace = getEffectiveCwd();
  if (state.conversationUnbound || !workspace) {
    showToast('当前未绑定项目目录，无法修改项目会话留存', 'info');
    return false;
  }
  const cfg = state.projectConfig;
  if ((cfg?.externalSessionMode || 'inherit') === mode) return true;
  state.projectExternalSessionSaving = mode;
  scheduleRender();
  try {
    const res = await rpcCall('saveSettings', { scope: 'project', workspace, projectExternalSessionMode: mode });
    if (res?.projectConfig) applySessionAndUpdatePayload(res);
    else {
      applySessionAndUpdatePayload({ projectConfig: {
        ...cfg,
        workspace,
        externalSessionMode: mode,
        externalSessionVisible: mode === 'inherit' ? state.defaultExternalSessionVisible : mode === 'visible',
        externalSessionCustomized: mode !== 'inherit',
      } });
    }
    showToast(mode === 'visible' ? '本项目将保留外部会话，便于恢复调试' : mode === 'hidden' ? '本项目将隐藏外部会话' : '本项目已恢复跟随全局默认', 'success');
    return true;
  } catch (err) {
    showToast(`项目会话设置保存失败：${describeRpcError(err)}`, 'error');
    return false;
  } finally {
    state.projectExternalSessionSaving = '';
    scheduleRender();
  }
}

async function runSystemUpdateAction(action) {
  const cancelling = action === 'cancelCutover';
  if (state.systemUpdateCancelPending || (!cancelling && state.systemUpdateBusy)) return false;
  const version = String((action === 'rollback' ? state.systemUpdate?.rollback?.version : state.systemUpdate?.latestVersion) || '');
  if (action === 'dismiss' && !version) return false;
  if (cancelling) state.systemUpdateCancelPending = true;
  else state.systemUpdateBusy = action;
  scheduleRender();
  try {
    const res = await rpcCall('systemUpdate', { action, ...(version && ['apply', 'dismiss', 'rollback'].includes(action) ? { version } : {}) });
    // A late cancellation acknowledgment can describe the download that has already finished.
    if (!cancelling || state.systemUpdate?.cancellable) {
      applySessionAndUpdatePayload(res?.systemUpdate ? res : { systemUpdate: res || {} });
    }
    if (action === 'dismiss') {
      state.systemUpdate = normalizeSystemUpdate({ ...state.systemUpdate, dismissedVersion: version });
      showToast(`已忽略 v${version.replace(/^v/, '')}，后续新版仍会提示`, 'success');
    } else if (action === 'check') {
      showToast(state.systemUpdate?.hasUpdate ? `发现新版 v${state.systemUpdate.latestVersion.replace(/^v/, '')}` : '版本检测完成', 'success');
    } else if (action === 'apply') {
      if (state.systemUpdate?.state === 'quiescing') showToast('已启动热更新，正在等待在途任务自然排空…', 'success');
    } else if (action === 'cancelCutover') {
      showToast('已请求取消热更新，当前版本将继续运行', 'success');
    } else if (action === 'rollback') {
      showToast('已启动回滚至上一版本，正在排空并切换…', 'success');
    }
    return true;
  } catch (err) {
    if (action === 'check') {
      state.systemUpdate = normalizeSystemUpdate({ ...state.systemUpdate, state: 'unavailable', error: describeRpcError(err) });
    }
    const labels = {
      check: '版本检测',
      dismiss: '忽略版本',
      apply: '热更新',
      cancelCutover: '取消更新',
      rollback: '回滚版本',
    };
    showToast(`${labels[action] || '更新操作'}失败：${describeRpcError(err)}`, 'error');
    return false;
  } finally {
    if (cancelling) state.systemUpdateCancelPending = false;
    else state.systemUpdateBusy = '';
    scheduleRender();
  }
}

export async function checkSystemUpdates() {
  return runSystemUpdateAction('check');
}

export async function dismissSystemUpdate() {
  return runSystemUpdateAction('dismiss');
}

export async function applySystemUpdate() {
  if (state.systemUpdateBusy) return false;
  const update = state.systemUpdate;
  if (!update?.hasUpdate || update.autoUpdateSupported !== true || update.installOrigin === 'dev') return false;
  if (isSystemUpdateTransitionState(update.state)) return false;
  const ver = String(update.latestVersion || '').replace(/^v/, '');
  if (!armOrConfirm('system-update-apply', `再次点击确认下载并热更新至 v${ver}（在途任务会等待自然排空，不会中断）`)) return false;
  return runSystemUpdateAction('apply');
}

export async function cancelSystemUpdate() {
  if (state.systemUpdate?.cancellable !== true) return false;
  return runSystemUpdateAction('cancelCutover');
}

export async function rollbackSystemUpdate() {
  if (state.systemUpdateBusy) return false;
  const update = state.systemUpdate;
  if (isSystemUpdateTransitionState(update?.state)) return false;
  const rb = update?.rollback;
  const ver = String(rb?.version || '').replace(/^v/, '');
  if (rb?.available !== true || !ver || rb?.rollbackSafe === false) return false;
  if (!armOrConfirm('system-update-rollback', `再次点击确认回滚至上一版本 v${ver}（在途任务会等待自然排空）`)) return false;
  return runSystemUpdateAction('rollback');
}

/**
 * AgentTower Studio — 成员列表、成员详情抽屉与实时秒表 (`ui/members-view.js`)

 */
import { escapeHtml, formatCompactNumber, formatDurationMs, formatTimeShort, renderMarkdownSafe, stripAnsi } from './format.js';
import { setText } from './dom-guards.js';
import { STATUS_LABELS, actionableSpecProposal, currentSpecCuration, getEffectiveConversationId, getScopedThreads, isStatusActive, isStatusPendingIntervention, memberPriority, normalizeStatus, recomputeScopedStats, state, syncActiveTargetThread } from './state.js';
import { scheduleRender } from './render.js';
import { armOrConfirm, copyPlainText, relayToHostConversation, rpcCall, showToast } from './net.js';
import { agentPastelColor, groupThreadWorkOrders, shortMemberName, threadCancelCapability } from './normalize.js';
import { cancelButtonLabel, engClass, formatEffortDisplay, formatModelDisplay, formatProviderBadge, formatThreadElapsed, renderRuntimeRequestCard, renderSpecBadgeHtml, renderThreadHealthBadgeHtml, renderThreadModeBadgesHtml, resolveInjectedSpecs } from './widgets.js';
import { syncComposerSelects } from './options.js';
import { closeMemberDrawer, hasAnyActiveRun, hydrateThreadDetails, resetForConversation, UNBOUND_CONVERSATION_HINT } from './stream.js';

/* ---------- v0.2.10.2 一键归档闲置分身（与后端 deleteThread scope=idle_clones 同口径估算） ---------- */
const IDLE_CLONE_TERMINAL_STATUS = new Set(['completed', 'failed', 'interrupted']);

function idleCloneSlotKeyOf(t) {
  if (t.presetKey) return `preset:${t.presetKey}`;
  const baseName = String(t.meta?.baseMemberName || t.memberName || t.meta?.memberName || shortMemberName(t)).replace(/-\d+$/, '').toLowerCase();
  return `custom:${t.provider}:${t.role}:${baseName}`;
}

/** 宿主根会话 / commander / coordinator 与原生常驻 Swarm 成员永不参与归档。 */
function isIdleCloneExempt(t) {
  if (t.isSwarmMember || t.meta?.isSwarmMember) return true;
  return Boolean(t.isNativeHost && (!t.parentThreadId || t.role === 'commander' || String(t.meta?.memberName || '').toLowerCase() === 'coordinator'));
}

function isIdleCloneProtected(t) {
  if (isStatusActive(t.status) || isStatusPendingIntervention(t) || (Array.isArray(t.queue) && t.queue.length > 0)) return true;
  // 前端无法探测磁盘：仍出现在 Worktree 列表中的隔离目录视为尚未清理
  return Boolean(t.worktreePath && state.worktrees.some((w) => w.threadId === t.id || w.path === t.worktreePath));
}

export function listArchivableIdleClones(scopedThreads = getScopedThreads()) {
  const slots = new Map();
  for (const t of scopedThreads) {
    if (isIdleCloneExempt(t)) continue;
    const key = idleCloneSlotKeyOf(t);
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(t);
  }
  const isShared = (t) => !t.worktreePath && t.isolation !== 'worktree';
  const out = [];
  for (const group of slots.values()) {
    const ordered = [...group].sort((a, b) => Number(isShared(b)) - Number(isShared(a)) || (b.updatedAt || 0) - (a.updatedAt || 0));
    for (const t of ordered.slice(1)) {
      if (!isIdleCloneProtected(t) && IDLE_CLONE_TERMINAL_STATUS.has(normalizeStatus(t.status))) out.push(t);
    }
  }
  return out;
}

export function countArchivableIdleClones(scopedThreads = getScopedThreads()) {
  return listArchivableIdleClones(scopedThreads).length;
}

export async function handleArchiveIdleMembers() {
  if (state.conversationUnbound) {
    showToast(`尚未绑定对话：${UNBOUND_CONVERSATION_HINT}`, 'error');
    return;
  }
  const n = countArchivableIdleClones();
  if (n <= 0) {
    showToast('当前对话没有可归档的闲置分身', 'info');
    return;
  }
  if (!armOrConfirm('archive-idle', `请再次点击确认归档 ${n} 张闲置分身卡（每个角色保留最新常驻卡，看板历史发言保留）`)) return;
  try {
    const res = await rpcCall('deleteThread', { scope: 'idle_clones', conversationId: getEffectiveConversationId() });
    const deletedIds = Array.isArray(res?.deletedIds) ? res.deletedIds.map(String) : [];
    for (const did of deletedIds) {
      state.archivedThreadIds.add(did);
      state.threadsMap.delete(did);
      for (const [reqId, req] of state.pendingRequests.entries()) {
        if (req.threadId === did) state.pendingRequests.delete(reqId);
      }
      if (state.selectedThreadId === did) state.selectedThreadId = '';
      if (state.detailDrawerThreadId === did) closeMemberDrawer();
    }
    // state.boardMessages 原样保留：被归档分身的历史发言继续按 rootConversationId 归属当前看板
    syncActiveTargetThread();
    recomputeScopedStats();
    syncComposerSelects();
    scheduleRender();
    showToast(deletedIds.length ? `🧹 已归档 ${deletedIds.length} 张闲置分身卡，看板历史发言已保留` : '没有需要归档的闲置分身', deletedIds.length ? 'success' : 'info');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function renderArchiveIdleButton(scopedThreads) {
  const btn = document.getElementById('btn-archive-idle-members');
  if (!btn) return;
  const n = countArchivableIdleClones(scopedThreads);
  btn.hidden = n === 0;
  const armed = n > 0 && (state.pendingConfirms.get('archive-idle') || 0) > Date.now();
  const label = armed ? `确认归档 ${n} 张?` : `🧹 归档闲置分身 (${n})`;
  if (btn.textContent !== label) btn.textContent = label;
  btn.classList.toggle('danger-txt', armed);
  btn.title = '每个角色槽位保留最新 1 张常驻卡，归档其余已完结分身；运行中、待介入、有排队或隔离目录未清理的成员不受影响，看板历史发言保留';
}

/**
 * v0.2.11 待办提醒：当前项目有待确认的规范维护提案时，在成员页顶部给出一键定位入口
 *（点击由 events.js 切到配置页「项目规范与缓存 → 项目规范」提案确认卡）。
 */
export function renderSpecCurationReminder() {
  const el = document.getElementById('spec-curation-reminder');
  if (!el) return;
  // v0.3.0：本项目未接入项目规范时维护官全入口停用，成员页待办提醒保持隐藏
  const cur = currentSpecCuration();
  const p = cur.specEnabled === false ? null : actionableSpecProposal(cur);
  const suffix = !p ? '' : p.status === 'conflict' ? '（基线冲突）' : p.preflightOk ? '' : '（预检未通过）';
  const html = p
    ? `<button type="button" class="spec-curation-reminder-btn" data-goto-spec-proposal>📝 规范维护提案待确认 · ${p.changes.length} 处变更${suffix} <span class="spec-curation-reminder-go">前往确认 →</span></button>`
    : '';
  if (el.innerHTML !== html) el.innerHTML = html;
  el.hidden = !html;
}

function renderMembersMoreBarInnerHtml(hiddenCount) {
  return `<span>已折叠其余 ${hiddenCount} 位历史成员</span>
    <span class="members-more-actions">
      <button type="button" class="ghost-xs-btn" data-members-load-more="20">↓ 展开更多（+${Math.min(20, hiddenCount)}）</button>
      <button type="button" class="ghost-xs-btn" data-members-load-more="all">展开全部</button>
    </span>`;
}

export async function handleDeleteThread(threadId, confirmKey) {
  const t = state.threadsMap.get(threadId);
  if (!t) return;
  const isBusy = isStatusActive(t.status);
  if (!armOrConfirm(confirmKey || `del:${threadId}`, `${isBusy ? '该会话仍在运行！' : ''}请再次点击确认归档删除「${shortMemberName(t)}」及下属子任务`)) {
    return;
  }
  try {
    const res = await rpcCall('deleteThread', {
      threadId,
      cascade: true,
      force: isBusy,
    });
    const deletedIds = new Set([threadId, ...(Array.isArray(res?.deletedIds) ? res.deletedIds : [])]);
    for (const did of deletedIds) {
      state.threadsMap.delete(did);
      for (const [reqId, req] of state.pendingRequests.entries()) {
        if (req.threadId === did) state.pendingRequests.delete(reqId);
      }
      if (state.selectedThreadId === did) state.selectedThreadId = '';
      if (state.detailDrawerThreadId === did) closeMemberDrawer();
    }
    state.boardMessages = state.boardMessages.filter((m) => !deletedIds.has(String(m.threadId || '')));
    state.boardSig = '';
    syncActiveTargetThread();
    recomputeScopedStats();
    syncComposerSelects();
    scheduleRender();
    showToast(`🗑 已清理归档 ${deletedIds.size} 个会话节点`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function getThreadHostConvId(t) {
  if (!t) return '';
  if (t.hostConversationId) return t.hostConversationId;
  if (t.isNativeHost && t.nativeSessionId) return t.nativeSessionId;
  return '';
}

export function jumpToNativeHostConversation(t) {
  const targetConvId = getThreadHostConvId(t);
  if (!targetConvId) {
    showToast('当前会话尚未关联宿主原生 Conversation ID', 'error');
    return;
  }
  if (window.sidecar?.ui?.toggleConversation) {
    window.sidecar.ui.toggleConversation(targetConvId);
    showToast('已在 Antigravity 主窗口跳转打开原生对话', 'success');
    return;
  }
  // 独立网页端：目标会话在候选列表中则直接切换查看，否则复制原生会话 ID
  const key = targetConvId.toLowerCase();
  const known = (Array.isArray(state.availableConversations) ? state.availableConversations : [])
    .map((c) => String(c?.rootConversationId || c?.conversationId || '').trim())
    .find((cid) => cid && cid.toLowerCase() === key);
  if (known && known.toLowerCase() !== getEffectiveConversationId().toLowerCase()) {
    closeMemberDrawer();
    void resetForConversation(known);
    showToast(`已切换查看原生会话 ${known.slice(0, 12)}`, 'success');
    return;
  }
  void copyPlainText(targetConvId).then((ok) => showToast(
    ok ? `已复制原生会话 ID: ${targetConvId}` : `原生会话 ID: ${targetConvId}（复制失败，请手动选择）`,
    ok ? 'success' : 'error'
  ));
}

export function openMemberDrawer(threadId) {
  const t = state.threadsMap.get(threadId);
  if (!t) return;
  state.detailDrawerThreadId = threadId;
  const bd = document.getElementById('member-drawer-backdrop');
  if (bd) bd.hidden = false;
  void hydrateThreadDetails(threadId);
  renderMemberDrawer();
}

/* ---------- v0.2.6 原生 Swarm 成员：请求收尾待命 / 永久移除（kill）严格分离（C12③） ---------- */
/** 原生 Swarm 子成员（非 coordinator）的 swarm 成员名；非原生成员返回空串。 */
export function nativeSwarmMemberName(t) {
  if (!t || !(t.isSwarmMember || t.meta?.isSwarmMember)) return '';
  const name = String(t.memberName || t.meta?.memberName || '').trim();
  const role = String(t.role || '').toLowerCase();
  if (!name || name.toLowerCase() === 'coordinator' || role === 'coordinator' || role === 'commander') return '';
  return name;
}

export function swarmFinishPrompt(name) {
  return `@${name} 请收尾当前任务后调用 swarm_wait 进入待命`;
}

export function swarmKillPrompt(name) {
  return `请在当前主对话执行 swarm({ action: "kill", name: ${JSON.stringify(name)} }) 永久移除原生成员 @${name}（已确认其成果合入）`;
}

async function relayMemberCommand(text, sentMsg) {
  const outcome = await relayToHostConversation(text);
  if (outcome === 'sent') showToast(sentMsg, 'success');
  else if (outcome === 'copied') showToast('已复制成员指令，请粘贴到主对话执行', 'info');
  else showToast(`指令发送失败，请在主对话手动输入：${text}`, 'error');
  return outcome;
}

/** 请求收尾：向当前主对话发送 @成员 收尾并 swarm_wait 待命指令（不删除任何工作副本）。 */
export async function requestSwarmMemberFinish(threadId) {
  const name = nativeSwarmMemberName(state.threadsMap.get(threadId));
  if (!name) return 'failed';
  return relayMemberCommand(swarmFinishPrompt(name), `已请求 @${name} 收尾并进入待命`);
}

/** 永久移除：二次确认后才向当前主对话发送 swarm kill 指令（会删除成员独立工作副本）。 */
export async function requestSwarmMemberKill(threadId) {
  const name = nativeSwarmMemberName(state.threadsMap.get(threadId));
  if (!name) return 'failed';
  if (!armOrConfirm(`swarmkill:${threadId}`, '永久移除会删除成员独立工作副本，请确认成果已合入，再点一次发送移除指令')) return 'armed';
  return relayMemberCommand(swarmKillPrompt(name), `已发送永久移除 @${name} 的指令`);
}

function swarmMemberControlsHtml(t, s) {
  if (!nativeSwarmMemberName(t)) return '';
  const id = escapeHtml(t.id);
  const finish = isStatusActive(s)
    ? `<button type="button" class="ghost-xs-btn" data-swarm-finish="${id}" title="向主对话发送收尾指令，成员完成后 swarm_wait 待命">⏸ 请求收尾</button>`
    : '';
  if (s === 'interrupted' || s === 'cancelled') return finish;
  const armed = (state.pendingConfirms.get(`swarmkill:${t.id}`) || 0) > Date.now();
  return `${finish}<button type="button" class="ghost-xs-btn danger-txt" data-swarm-kill="${id}" title="swarm kill 会删除成员独立工作副本，须先合入成果">${armed ? '确认永久移除?' : '✖ 永久移除'}</button>`;
}

/** 成员行原生控制按钮：用 onclick 属性幂等绑定并阻止冒泡（不叠加监听、不误开详情抽屉）。 */
function bindSwarmMemberControls(root) {
  root.querySelectorAll?.('[data-swarm-finish]').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); void requestSwarmMemberFinish(btn.dataset.swarmFinish); };
  });
  root.querySelectorAll?.('[data-swarm-kill]').forEach((btn) => {
    btn.onclick = (e) => { e.stopPropagation(); void requestSwarmMemberKill(btn.dataset.swarmKill); };
  });
}

/** 成员状态文案与色标：原生待命 waiting 为中性完成色，待宿主派遣为中性灰。 */
function memberStatusView(t, s) {
  if (isStatusPendingIntervention(t)) return { cls: 'waiting', label: '待人工确认' };
  if (s === 'waiting') return { cls: 'completed', label: STATUS_LABELS.waiting };
  if (s === 'waiting_host_dispatch') return { cls: '', label: STATUS_LABELS.waiting_host_dispatch };
  const cls = isStatusActive(s) ? 'running' : s === 'failed' ? 'failed' : s === 'completed' ? 'completed' : '';
  return { cls, label: STATUS_LABELS[s] || s };
}

function updateMemberRowBlock(row, selector, html) {
  const el = row.querySelector(selector);
  if (el && el.innerHTML !== html) el.innerHTML = html;
}

function reconcileMemberRow(row, model) {
  if (row.className !== model.className) row.className = model.className;
  const avatar = row.querySelector('.member-avatar-tile');
  if (avatar) {
    if (avatar.getAttribute('style') !== model.avatarStyle) avatar.setAttribute('style', model.avatarStyle);
    if (avatar.innerHTML !== model.avatarHtml) avatar.innerHTML = model.avatarHtml;
  }
  updateMemberRowBlock(row, '.member-head-line', model.headHtml);
  updateMemberRowBlock(row, '.member-meta-line', model.metaHtml);
  updateMemberRowBlock(row, '.member-preview-line', model.previewHtml);
  updateMemberRowBlock(row, '.member-row-actions', model.actionsHtml);
}

function createMemberRow(model) {
  const row = document.createElement('div');
  row.className = model.className;
  row.dataset.openMember = model.id;
  row.innerHTML = `<div class="member-avatar-tile" style="${model.avatarStyle}">${model.avatarHtml}</div>
    <div class="member-col">
      <div class="member-head-line">${model.headHtml}</div>
      <div class="member-meta-line">${model.metaHtml}</div>
      <div class="member-preview-line">${model.previewHtml}</div>
      <div class="member-row-actions">${model.actionsHtml}</div>
    </div>`;
  return row;
}

function reconcileMemberRows(listEl, models, hiddenCount) {
  const existing = new Map();
  for (const child of [...listEl.children]) {
    if (child.classList.contains('member-row') && !existing.has(child.dataset.openMember)) {
      existing.set(child.dataset.openMember, child);
    } else if (child.classList.contains('empty-stage-box')) {
      child.remove();
    }
  }

  const retained = new Set(models.map((model) => model.id));
  models.forEach((model, index) => {
    let row = existing.get(model.id);
    if (row) reconcileMemberRow(row, model);
    else {
      row = createMemberRow(model);
      existing.set(model.id, row);
    }
    const current = listEl.children[index] || null;
    if (current !== row) listEl.insertBefore(row, current);
  });
  for (const [id, row] of existing) if (!retained.has(id)) row.remove();

  let moreBar = listEl.querySelector('.members-more-bar');
  if (hiddenCount > 0) {
    const html = renderMembersMoreBarInnerHtml(hiddenCount);
    if (!moreBar) {
      moreBar = document.createElement('div');
      moreBar.className = 'members-more-bar';
      moreBar.setAttribute('role', 'status');
    }
    if (moreBar.innerHTML !== html) moreBar.innerHTML = html;
    const current = listEl.children[models.length] || null;
    if (current !== moreBar) listEl.insertBefore(moreBar, current);
  } else {
    moreBar?.remove();
  }
}

/* ---------- Tab 2: 成员 (Members + Member Detail Drawer) ---------- */
export function renderMembersView() {
  const scopedThreads = getScopedThreads();
  const activeCount = scopedThreads.filter((t) => isStatusActive(t.status) && !isStatusPendingIntervention(t)).length;
  const pendingCount = scopedThreads.filter((t) => isStatusPendingIntervention(t)).length;
  setText('members-count-summary', `当前对话共 ${scopedThreads.length} 位成员 · ${activeCount} 工作中${pendingCount ? ` · ${pendingCount} 待介入` : ''}`);
  renderArchiveIdleButton(scopedThreads);
  renderSpecCurationReminder();

  document.querySelectorAll('#members-status-filter .mini-filter-pill').forEach((b) => {
    b.classList.toggle('active', b.dataset.mstatus === state.membersStatusFilter);
  });

  const filtered = scopedThreads.filter((t) => {
    if (state.membersStatusFilter === 'active') return isStatusActive(t.status) || isStatusPendingIntervention(t);
    if (state.membersStatusFilter === 'completed') return !isStatusActive(t.status) && !isStatusPendingIntervention(t);
    return true;
  });

  const listEl = document.getElementById('members-roster-list');
  if (!listEl) return;

  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-stage-box"><p>当前对话暂无成员。可点击顶栏「+ 派发」召唤子 Agent。</p></div>`;
    return;
  }

  // 活跃 / 待介入成员始终全量置顶；其余完结 / 待命成员按需限量（默认最近 15 位）
  const pinnedActive = [];
  const inactiveRest = [];
  for (const t of filtered) (isStatusActive(t.status) || isStatusPendingIntervention(t) ? pinnedActive : inactiveRest).push(t);
  const visibleInactive = inactiveRest.slice(0, state.membersInactiveLimit);
  const hiddenCount = inactiveRest.length - visibleInactive.length;

  const models = [...pinnedActive, ...visibleInactive].map((t) => {
    const s = normalizeStatus(t.status);
    const { cls: dotCls, label: statusLabel } = memberStatusView(t, s);
    const mName = shortMemberName(t);
    const initials = mName.slice(0, 2).toUpperCase();
    const isRunning = isStatusActive(s);
    const parent = t.parentThreadId ? state.threadsMap.get(t.parentThreadId) : null;
    const parentLabel = parent ? shortMemberName(parent) : '';
    const parentIsHostRoot = Boolean(parent?.isNativeHost && !parent.parentThreadId) ||
      ['coordinator', 'commander'].includes(parentLabel.toLowerCase()) || ['coordinator', 'commander'].includes(String(parent?.role || '').toLowerCase());
    const orders = groupThreadWorkOrders(t);
    const preview = getThreadPreviewLine(t, orders);
    const hasHostConv = Boolean(getThreadHostConvId(t));
    const delKey = `del:${t.id}`;
    const isArmed = (state.pendingConfirms.get(delKey) || 0) > Date.now();
    const modelLabel = formatModelDisplay(t.model, t.effectiveModel || t.meta?.effectiveModel || '', t.modelDisplayName);
    const effortLabel = formatEffortDisplay(t.effort, t.effectiveEffort || t.meta?.effectiveEffort || '');
    const showBranch = Boolean((t.isolation === 'worktree' || t.worktreePath) && t.branch);
    const deleteHtml = `<button type="button" class="ghost-xs-btn member-del-btn ${isArmed ? 'danger-txt' : ''}" data-del-thread="${escapeHtml(t.id)}" title="归档删除该成员会话">${isArmed ? '确认删除?' : '🗑'}</button>`;

    return {
      id: t.id,
      className: `member-row${memberPriority(t) === 1 ? ' is-working' : ''}`,
      avatarStyle: `background:${agentPastelColor(mName)};color:rgba(0,0,0,0.75);border:0;`,
      avatarHtml: `<span>${escapeHtml(initials)}</span><span class="member-avatar-dot ${dotCls}"></span>`,
      headHtml: `<div class="member-name-group">
          <span class="member-name" style="min-width:0;overflow-wrap:anywhere;">${escapeHtml(mName)}</span>
          <span class="member-status-txt ${dotCls}">${escapeHtml(statusLabel)}</span>
          ${renderThreadHealthBadgeHtml(t)}
          ${renderThreadModeBadgesHtml(t)}
          ${t.isNativeHost ? '<span class="native-host-badge">🏠 宿主原生</span>' : ''}
          ${parentLabel && !parentIsHostRoot ? `<span class="branch-tag member-parent-tag">← ${escapeHtml(parentLabel)}</span>` : ''}
        </div>${memberElapsedSlotHtml(t)}`,
      metaHtml: `<span class="eng-tag ${engClass(t.provider)}">${escapeHtml(formatProviderBadge(t.provider))}</span>
        <span>${escapeHtml(modelLabel)} · ${escapeHtml(effortLabel)}</span>
        ${showBranch ? `<span class="branch-tag member-branch-tag" title="${escapeHtml(t.branch)}">${escapeHtml(t.branch)}</span>` : ''}`,
      previewHtml: escapeHtml(preview),
      actionsHtml: isRunning
        ? `<button type="button" class="ghost-xs-btn" data-focus-composer="${escapeHtml(t.id)}">⚡ Steer</button>
          ${memberCancelControlHtml(t)}
          ${swarmMemberControlsHtml(t, s)}`
        : `<button type="button" class="ghost-xs-btn" data-focus-composer="${escapeHtml(t.id)}">💬 续聊</button>
          ${s === 'failed' ? `<button type="button" class="ghost-xs-btn" data-retry-thread="${escapeHtml(t.id)}">🔄 重试</button>` : ''}
          ${swarmMemberControlsHtml(t, s)}
          ${hasHostConv ? `<button type="button" class="ghost-xs-btn host-jump-btn" data-jump-host="${escapeHtml(t.id)}">↗ 主窗口</button>` : ''}
          ${deleteHtml}`,
    };
  });
  reconcileMemberRows(listEl, models, hiddenCount);
  refreshLiveElapsedLabels(listEl);
  bindSwarmMemberControls(listEl);
}

function memberUsageLabel(t) {
  const curUsage = t.currentRun?.usage || t.usage || {};
  const reported = t.currentRun
    ? Boolean(t.currentRun.usageReported || curUsage.totalTokens > 0)
    : Boolean(t.usageReported || curUsage.totalTokens > 0);
  const elapsed = formatThreadElapsed(t);
  if (t.isNativeHost && !t.parentThreadId && !reported) return elapsed;
  return `${elapsed} · 本轮 ${isStatusActive(t.status) && !reported ? '—' : formatCompactNumber(curUsage.totalTokens)}`;
}

/**
 * 成员行耗时槽：活跃线程只渲染稳定的占位节点（data-elapsed-thread），由 refreshLiveElapsedLabels / 秒表每 350ms
 * 写 textContent；已结束线程渲染固定耗时。保证 renderMembersView 的 HTML 串在两次重绘间逐字一致。
 */
function memberElapsedSlotHtml(t) {
  if (isStatusActive(t.status)) {
    return `<span class="member-ts-meta" data-elapsed-thread="${escapeHtml(t.id)}" data-elapsed-live="1"></span>`;
  }
  return `<span class="member-ts-meta">${escapeHtml(memberUsageLabel(t))}</span>`;
}

function liveElapsedLabel(t) {
  return memberUsageLabel(t);
}

function refreshLiveElapsedLabels(root = document) {
  root.querySelectorAll?.('[data-elapsed-thread]').forEach((el) => {
    const t = state.threadsMap.get(el.getAttribute('data-elapsed-thread'));
    if (!t || !isStatusActive(t.status)) return;
    const next = liveElapsedLabel(t);
    if (el.textContent !== next) el.textContent = next;
  });
}

/** 成员行中断入口：stoppable → 两段式中断；reconcilable_orphan → 收割；host_only → 仅提示，绝不渲染假停止按钮。 */
function memberCancelControlHtml(t) {
  const capability = threadCancelCapability(t);
  if (capability === 'host_only') {
    return '<span class="host-managed-hint" title="宿主原生回合由 Antigravity 主窗口管理，插件无法代为中断">宿主管理</span>';
  }
  if (capability === 'none') return '';
  const busy = state.cancelInFlight.has(t.id) ? ' aria-busy="true"' : '';
  return `<button type="button" class="ghost-xs-btn danger-txt" data-quick-stop="${escapeHtml(t.id)}"${busy}>${escapeHtml(cancelButtonLabel(t))}</button>`;
}

function getThreadPreviewLine(t, orders = groupThreadWorkOrders(t)) {
  const order = orders.at(-1);
  const mName = shortMemberName(t);
  if (!order) return isStatusActive(t.status) ? '⏳ 等待首个事件…' : `${STATUS_LABELS[normalizeStatus(t.status)] || t.status}`;
  const latestError = order.errorItems.at(-1);
  let actionText = latestError ? `❌ ${latestError.error || latestError.text || '执行异常'}` : '';
  const entries = order.items || [];
  const lastToolIndex = entries.findLastIndex((item) => ['tool_call', 'command_execution', 'file_change'].includes(item.type));
  const lastTextIndex = entries.findLastIndex((item) => item.type === 'assistant_message' && String(item.text || '').trim());
  if (!actionText && lastToolIndex > lastTextIndex) {
    const tool = entries[lastToolIndex];
    actionText = `🛠 ${tool.command || tool.filePath || tool.title || '执行工具'}`;
  }
  if (!actionText && lastTextIndex >= 0) actionText = String(entries[lastTextIndex].text || '');
  if (!actionText && entries.some((item) => item.type === 'reasoning')) actionText = '💭 思考中…';
  if (!actionText && entries.some((item) => item.type === 'todo_list')) actionText = '📋 正在更新执行计划…';
  if (!actionText) actionText = isStatusActive(t.status) ? '⏳ 等待首个事件…' : `${STATUS_LABELS[normalizeStatus(order.status || t.status)] || order.status || t.status}`;
  actionText = actionText.replace(/\s+/g, ' ').trim().slice(0, 110);
  return order.title && order.title !== mName && (orders.length > 1 || order.promptItem)
    ? `${order.title} — ${actionText}`
    : actionText;
}

function reconcileDrawerBlocks(bodyEl, blocks) {
  const existing = new Map();
  for (const child of [...bodyEl.children]) {
    const key = child.getAttribute('data-md-block');
    if (key && !existing.has(key)) existing.set(key, child);
    else child.remove();
  }
  const retained = new Set(blocks.map((block) => block.key));
  blocks.forEach((block, index) => {
    let child = existing.get(block.key);
    if (!child) {
      child = document.createElement('div');
      child.className = 'md-block';
      child.setAttribute('data-md-block', block.key);
      existing.set(block.key, child);
    }
    if (child.innerHTML !== block.html) child.innerHTML = block.html;
    const current = bodyEl.children[index] || null;
    if (current !== child) bodyEl.insertBefore(child, current);
  });
  for (const [key, child] of existing) if (!retained.has(key)) child.remove();
}

function renderPromptCardHtml(t, order, history = false) {
  const item = order.promptItem;
  if (!item) return '';
  const text = String(item.text || '');
  const promptKey = `${t.id}:${history ? `hist:${order.key}` : order.key}`;
  const expanded = state.expandedPrompts.has(promptKey);
  const lines = text.split(/\r?\n/);
  const longPrompt = text.length > 220 || lines.length > 4;
  const shown = longPrompt && !expanded ? lines.slice(0, 4).join('\n').slice(0, 220) : text;
  const isHostRoot = Boolean(t.isNativeHost && !t.parentThreadId);
  const senderLabel = isHostRoot ? '👤 用户提问' : '📤 主对话派单指令';
  return `<div class="md-item-card md-prompt-card" style="border-left:3px solid var(--sw-primary);">
    <div class="md-card-meta">${senderLabel} · ${formatTimeShort(item.createdAt)}</div>
    <div class="markdown-prose">${renderMarkdownSafe(shown)}</div>
    ${longPrompt ? `<button type="button" class="ghost-xs-btn md-prompt-toggle" data-toggle-prompt="${escapeHtml(promptKey)}">${expanded ? '收起指令 ▴' : `展开完整指令（共 ${lines.length} 行） ▾`}</button>` : ''}
    ${renderSpecBadgeHtml(resolveInjectedSpecs(item, t), `md:${t.id}:${item.id}`)}
  </div>`;
}

function collectCoordinatorDispatches(t, order, nextStartedAt = Infinity) {
  if (!t || !(t.isNativeHost && !t.parentThreadId) || !Array.isArray(state.boardMessages) || !state.boardMessages.length) return [];
  const activeRoot = String(t.rootConversationId || state.rootConversationId || state.activeConversationId || '').toLowerCase();
  const fromTs = Math.max(0, Number(order?.promptItem?.createdAt || order?.startedAt || 0) - 2000);
  const toTs = Number.isFinite(nextStartedAt) && nextStartedAt > 0 ? nextStartedAt : Infinity;
  return state.boardMessages.filter((m) => {
    if (activeRoot && m.rootConversationId && m.rootConversationId.toLowerCase() !== activeRoot) return false;
    const ts = Number(m.ts || 0);
    if (fromTs > 0 && ts > 0 && (ts < fromTs || ts >= toTs)) return false;
    const isOrch = m.source === 'orchestrator-dispatch';
    const isSwarm = m.source === 'native-swarm' && ['coordinator', 'commander'].includes(String(m.agent || '').toLowerCase()) &&
      (Array.isArray(m.mentions) && m.mentions.length > 0 || m.all);
    return isOrch || isSwarm;
  });
}

function renderCoordinatorDispatchesHtml(t, order, nextStartedAt = Infinity, history = false) {
  const list = collectCoordinatorDispatches(t, order, nextStartedAt);
  if (!list.length) return '';
  const key = `${t.id}:${history ? `hist_disp_${order.key}` : `cur_disp_${order.key}`}`;
  const open = state.expandedTraces.has(key);
  const rows = list.map((m) => {
    const target = (m.mentions || []).filter(Boolean).map((x) => `@${x}`).join(' ') || (m.all ? '@all' : '子 Agent');
    const clean = String(m.text || '').replace(/^(\s*@[A-Za-z0-9_.-]+[,:]?)+\s*/, '').trim();
    const msgKey = `coord_disp:${t.id}:${m.source}:${m.seq}`;
    const msgOpen = state.expandedPrompts.has(msgKey);
    const lines = clean.split(/\r?\n/);
    const isLong = clean.length > 200 || lines.length > 4;
    const shown = isLong && !msgOpen ? lines.slice(0, 4).join('\n').slice(0, 200) : clean;
    return `<div class="md-item-card md-dispatch-subcard">
      <div class="md-card-meta">→ <strong>${escapeHtml(target)}</strong> · ${formatTimeShort(m.ts)}</div>
      <div class="markdown-prose">${renderMarkdownSafe(shown)}</div>
      ${isLong ? `<button type="button" class="ghost-xs-btn md-prompt-toggle" data-toggle-prompt="${escapeHtml(msgKey)}">${msgOpen ? '收起 ▴' : '展开全文 ▾'}</button>` : ''}
    </div>`;
  }).join('');
  return `<details class="md-trace-group md-dispatch-group" data-drawer-trace="${escapeHtml(key)}" ${open ? 'open' : ''}>
    <summary class="md-trace-summary"><span>📨 本轮向子 Agent 派发指令（共 ${list.length} 条）</span><span>▾</span></summary>
    <div class="md-trace-content">${rows}</div>
  </details>`;
}

function renderOrderTraceHtml(t, order, history = false) {
  if (!order.processItems.length && !order.intermediateNotes.length) return '';
  const rsItems = order.processItems.filter((item) => item.type === 'reasoning');
  const toolItems = order.processItems.filter((item) => ['command_execution', 'file_change', 'tool_call'].includes(item.type));
  const todoItems = order.processItems.filter((item) => item.type === 'todo_list');
  let rsDurMs = 0;
  for (const item of rsItems) {
    rsDurMs += item.status === 'running'
      ? Math.max(0, Date.now() - item.createdAt)
      : item.durationMs || Math.max(0, (item.completedAt || item.createdAt) - item.createdAt);
  }
  const parts = [];
  if (rsItems.length) parts.push(`💭 思考 ${rsDurMs > 0 ? formatDurationMs(rsDurMs) : `${rsItems.length} 段`}`);
  if (toolItems.length) parts.push(`🛠 ${toolItems.length} 项工具操作`);
  if (todoItems.length && !toolItems.length) parts.push('📋 执行计划');
  if (order.intermediateNotes.length) parts.push(`${order.intermediateNotes.length} 段过程说明`);
  const noteSet = new Set(order.intermediateNotes);
  const content = order.items.filter((item) => WORK_ORDER_DRAWER_PROCESS_TYPES.has(item.type) || noteSet.has(item)).map((item) => {
    if (item.type === 'assistant_message') {
      return `<div class="md-item-card md-intermediate-note"><div class="md-card-meta">过程说明 · ${formatTimeShort(item.createdAt)}</div><div class="markdown-prose">${renderMarkdownSafe(item.text || '')}</div></div>`;
    }
    if (item.type === 'reasoning') {
      return `<div class="trace-reasoning-block"><div class="markdown-prose">${renderMarkdownSafe(item.text || '')}</div></div>`;
    }
    if (item.type === 'todo_list') {
      const listHtml = (item.entries || []).map((entry) => `<div>${entry.status === 'completed' || entry.done ? '✅' : '⏳'} ${escapeHtml(entry.content || entry.title || entry.text || JSON.stringify(entry))}</div>`).join('');
      return `<div class="trace-reasoning-block"><strong>执行计划</strong>${listHtml}</div>`;
    }
    const label = item.type === 'command_execution'
      ? `$ ${item.command || item.title || '执行命令'}`
      : item.type === 'file_change'
      ? `📝 ${item.filePath || item.title} (+${item.additions} / -${item.deletions})`
      : `🔧 ${item.title || item.type}`;
    const out = stripAnsi(String(item.output || item.diff || ''));
    const fileBtn = item.filePath
      ? `<button type="button" class="file-link-btn" data-open-file="${escapeHtml(item.filePath)}" data-base-dir="${escapeHtml(t.worktreePath || t.cwd || '')}">打开文件</button>`
      : '';
    return `<div class="trace-tool-row"><div class="trace-tool-head"><span class="trace-tool-label">${escapeHtml(label)}</span>${fileBtn}</div>${out ? `<pre class="trace-tool-output">${escapeHtml(out)}</pre>` : ''}</div>`;
  }).join('');
  const traceKey = history ? `${t.id}:hist_${order.key}:trace` : `${t.id}:order_${order.key}:trace`;
  return `<details class="md-trace-group" data-drawer-trace="${escapeHtml(traceKey)}" ${state.expandedTraces.has(traceKey) ? 'open' : ''}>
    <summary class="md-trace-summary"><span>${escapeHtml(parts.join(' · ') || '内部执行过程')}</span><span>▾</span></summary>
    <div class="md-trace-content">${content}</div>
  </details>`;
}

const WORK_ORDER_DRAWER_PROCESS_TYPES = new Set(['reasoning', 'tool_call', 'command_execution', 'file_change', 'todo_list']);

function renderOrderMessagesHtml(t, order, mName, history = false, nextStartedAt = Infinity) {
  const prompt = renderPromptCardHtml(t, order, history);
  const dispatches = renderCoordinatorDispatchesHtml(t, order, nextStartedAt, history);
  const trace = renderOrderTraceHtml(t, order, history);
  const steer = order.steerItems.map((item) => `<div class="md-item-card md-steer-card"><div class="md-card-meta">⚡ Steer 纠偏 · ${formatTimeShort(item.createdAt)}</div><div class="markdown-prose">${renderMarkdownSafe(item.text || '')}</div></div>`).join('');
  const conclusions = order.conclusionItems.map((item) => `<div class="md-item-card md-conclusion-card"><div class="md-card-meta">${escapeHtml(mName)} · ${formatTimeShort(item.createdAt)}</div><div class="markdown-prose">${renderMarkdownSafe(item.text || '')}</div></div>`).join('');
  const running = !history && !conclusions && order.isCurrent && isStatusActive(t.status)
    ? '<div class="md-item-card md-live-placeholder">⏳ 正在执行，实时输出将在到达后显示在这里。</div>'
    : '';
  const errors = order.errorItems.map((item) => `<div class="error-inline-box">❌ ${escapeHtml(item.error || item.text || '执行异常')}</div>`).join('');
  return prompt + dispatches + trace + steer + conclusions + running + errors;
}

function renderHistoryOrdersHtml(t, historyOrders, mName, currentOrderStart = Infinity) {
  const key = `${t.id}:history_orders`;
  const open = state.expandedTraces.has(key);
  const content = !open
    ? '<div class="md-history-lazy">展开后按需查看历史指令、过程与结论。</div>'
    : historyOrders.map((order, idx) => {
      const orderKey = `${t.id}:hist_${order.key}`;
      const orderOpen = state.expandedTraces.has(orderKey);
      const nextStart = historyOrders[idx + 1]?.startedAt || currentOrderStart;
      const duration = order.completedAt && order.startedAt ? ` · ${formatDurationMs(order.completedAt - order.startedAt)}` : '';
      const hasRenderable = Boolean(order.items.length || order.promptItem || order.conclusionItems.length);
      const detail = orderOpen
        ? hasRenderable
          ? renderOrderMessagesHtml(t, order, mName, true, nextStart)
          : '<div class="md-history-lazy">该单轨迹超出当前尾部窗口，正在按工单补拉；若暂无记录则稍后重试。</div>'
        : '';
      return `<details class="md-history-order" data-drawer-trace="${escapeHtml(orderKey)}" data-hist-run="${escapeHtml(order.runIds.join(',') || order.primaryRunId || '')}" data-hist-empty="${order.items.length ? '0' : '1'}" ${orderOpen ? 'open' : ''}>
        <summary>#${order.orderNo} · ${escapeHtml(order.title || '历史任务')} · ${escapeHtml(STATUS_LABELS[normalizeStatus(order.status)] || order.status)}${escapeHtml(duration)}</summary>
        <div class="md-history-order-body">${detail}</div>
      </details>`;
    }).join('');
  return `<details class="md-history-accordion" data-drawer-trace="${escapeHtml(key)}" ${open ? 'open' : ''}>
    <summary>📜 查看历史工单（共 ${historyOrders.length} 单）</summary>
    <div class="md-history-orders">${content}</div>
  </details>`;
}

export function renderMemberDrawer() {
  const tid = state.detailDrawerThreadId;
  const t = tid ? state.threadsMap.get(tid) : null;
  const bd = document.getElementById('member-drawer-backdrop');
  if (!t || t.archived) {
    if (bd) bd.hidden = true;
    return;
  }

  const mName = shortMemberName(t);
  setText('md-title', mName);
  const mdModelLabel = formatModelDisplay(t.model, t.effectiveModel || t.meta?.effectiveModel || '', t.modelDisplayName);
  const mdEffortLabel = formatEffortDisplay(t.effort, t.effectiveEffort || t.meta?.effectiveEffort || '');
  const orders = groupThreadWorkOrders(t);
  const currentOrder = orders.at(-1) || null;
  const historyOrders = currentOrder ? orders.slice(0, -1) : [];
  const curUsage = t.currentRun?.usage || t.usage || {};
  const reported = t.currentRun ? Boolean(t.currentRun.usageReported || curUsage.totalTokens > 0) : Boolean(t.usageReported || curUsage.totalTokens > 0);
  const tokText = reported ? formatCompactNumber(curUsage.totalTokens) : '—';
  setText(
    'md-subtitle',
    `${formatProviderBadge(t.provider)} · ${mdModelLabel} (${mdEffortLabel}) · ${STATUS_LABELS[normalizeStatus(t.status)] || t.status} · 共 ${Math.max(orders.length, Number(t.orderCount) || 0)} 单 · 本轮 ${tokText}`
  );

  const jumpBtn = document.getElementById('btn-md-jump-host');
  if (jumpBtn) jumpBtn.hidden = !getThreadHostConvId(t);

  const delBtn = document.getElementById('btn-md-delete');
  if (delBtn) {
    const armed = (state.pendingConfirms.get(`del:${t.id}`) || 0) > Date.now();
    delBtn.textContent = armed ? '确认删除?' : '🗑 删除';
  }

  // 按钮事件统一由 bindGlobalEvents() 中 #md-actions-bar 的一次性委托处理（data-md-action），重绘绝不叠加监听器
  const actionsBar = document.getElementById('md-actions-bar');
  if (actionsBar) {
    const isRun = isStatusActive(t.status);
    const capability = threadCancelCapability(t);
    const stopHtml = capability === 'host_only'
      ? '<span class="host-managed-hint" title="宿主原生回合由 Antigravity 主窗口管理，插件无法代为中断">宿主回合请在主窗口停止</span>'
      : capability === 'none'
      ? ''
      : `<button type="button" class="ghost-xs-btn danger-txt" id="btn-md-stop" data-md-action="stop">${escapeHtml(cancelButtonLabel(t, { long: true }))}</button>`;
    actionsBar.innerHTML = `
        ${renderThreadModeBadgesHtml(t)}
        <button type="button" class="ghost-xs-btn" id="btn-md-to-composer" data-md-action="to-composer">${isRun ? '⚡ 切入底部 Steer' : '💬 在底部续聊'}</button>
        ${stopHtml}
        ${t.status === 'failed' ? '<button type="button" class="ghost-xs-btn" id="btn-md-retry" data-md-action="retry">🔄 重试任务</button>' : ''}
        <button type="button" class="ghost-xs-btn" id="btn-md-switch-model" data-md-action="switch-model">🎛 切换模型/思考</button>
        <button type="button" class="ghost-xs-btn" id="btn-md-astra-review" data-md-action="astra-review">🔍 Astra 终审其改动</button>
      `;
  }

  const bodyEl = document.getElementById('md-timeline-body');
  if (!bodyEl) return;
  if (state.drawerLastThreadId !== t.id) {
    state.drawerLastThreadId = t.id;
    bodyEl.scrollTop = 0;
  }

  const blocks = [];
  const reqs = Array.from(state.pendingRequests.values()).filter((r) => r.threadId === t.id && r.status === 'pending');
  for (const req of reqs) blocks.push({ key: `req:${req.id}`, html: renderRuntimeRequestCard(req) });
  if (historyOrders.length) blocks.push({ key: 'history-orders', html: renderHistoryOrdersHtml(t, historyOrders, mName, currentOrder?.startedAt || Infinity) });
  if (currentOrder) {
    if (orders.length > 1 || Number(t.orderCount) > 1) {
      blocks.push({
        key: `cur-head:${currentOrder.key}`,
        html: `<div class="md-current-order-head">当前工单 #${currentOrder.orderNo}${currentOrder.title ? ` · ${escapeHtml(currentOrder.title)}` : ''}</div>`,
      });
    }
    if (currentOrder.promptItem) blocks.push({ key: `cur-prompt:${currentOrder.key}`, html: renderPromptCardHtml(t, currentOrder) });
    const coordDispHtml = renderCoordinatorDispatchesHtml(t, currentOrder, Infinity, false);
    if (coordDispHtml) blocks.push({ key: `cur-dispatches:${currentOrder.key}`, html: coordDispHtml });
    if (currentOrder.processItems.length || currentOrder.intermediateNotes.length) {
      blocks.push({ key: `cur-trace:${currentOrder.key}`, html: renderOrderTraceHtml(t, currentOrder) });
    }
    if (currentOrder.steerItems.length) {
      blocks.push({
        key: `cur-steer:${currentOrder.key}`,
        html: currentOrder.steerItems.map((item) => `<div class="md-item-card md-steer-card"><div class="md-card-meta">⚡ Steer 纠偏 · ${formatTimeShort(item.createdAt)}</div><div class="markdown-prose">${renderMarkdownSafe(item.text || '')}</div></div>`).join(''),
      });
    }
    const conclusionHtml = currentOrder.conclusionItems.map((item) => `<div class="md-item-card md-conclusion-card"><div class="md-card-meta">${escapeHtml(mName)} · ${formatTimeShort(item.createdAt)}</div><div class="markdown-prose">${renderMarkdownSafe(item.text || '')}</div></div>`).join('') ||
      (isStatusActive(t.status) ? '<div class="md-item-card md-live-placeholder">⏳ 正在执行，实时输出将在到达后显示在这里。</div>' : '');
    if (conclusionHtml) blocks.push({ key: `cur-conclusion:${currentOrder.key}`, html: conclusionHtml });
    if (currentOrder.errorItems.length) {
      blocks.push({ key: `cur-errors:${currentOrder.key}`, html: currentOrder.errorItems.map((item) => `<div class="error-inline-box">❌ ${escapeHtml(item.error || item.text || '执行异常')}</div>`).join('') });
    }
  } else if (!reqs.length) {
    blocks.push({ key: 'empty-current', html: '<div class="empty-stage-box"><p>暂无详细轨迹记录，若任务刚启动请稍候实时刷新。</p></div>' });
  }
  if (t.queue.length > 0) blocks.push({ key: 'current-queue', html: `<div class="md-queue-note">⏳ 排队待执行（${t.queue.length} 条）</div>` });
  reconcileDrawerBlocks(bodyEl, blocks);
}

export function startLiveStopwatchTicker() {
  setInterval(() => {
    if (!hasAnyActiveRun()) return;
    const now = Date.now();
    refreshLiveElapsedLabels(document);
    document.querySelectorAll('[data-live-rs-start]').forEach((el) => {
      const start = Number(el.getAttribute('data-live-rs-start'));
      if (start > 0) el.textContent = formatDurationMs(now - start);
    });
  }, 350);
}

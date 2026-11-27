/**
 * AgentTower Studio — 看板视图与时间线详情 (`ui/board-view.js`)

 */
import { escapeHtml, formatDurationMs, formatTimeShort, renderMarkdownSafe, stripAnsi } from './format.js';
import { STATUS_LABELS, currentOrchestrationMode, getHostConversationId, getScopedRequests, getScopedThreads, getScopedWorktrees, isConversationCollaborationEmpty, isStatusActive, isStatusPendingIntervention, modeRosterSummary, normalizeStatus, orchestrationModeMeta, state } from './state.js';
import { scrollMainToBottom, updateJumpLatestButtonVisibility } from './render.js';
import { agentPastelColor, groupThreadWorkOrders, normalizeInjectedSpecs, shortMemberName } from './normalize.js';
import { formatModelDisplay, renderSpecBadgeHtml, renderThreadHealthBadgeHtml, renderThreadModeBadgesHtml, resolveInjectedSpecs, setTimelineHtml } from './widgets.js';

/* ---------- Tab 1: 看板 (Board) ---------- */
// v0.2.10.2 单帖 HTML 记忆缓存（LRU 512）：完结帖按稳定键复用，Tab 往返 / 轮询重绘零重复 renderMarkdownSafe
const BOARD_POST_HTML_CACHE_MAX = 512;
const boardPostHtmlCache = new Map();
// 折叠测量缓存：postId → { key, overflows }（键含帖子稳定键与 feed 宽度），切回看板只测量新帖 / 运行中帖
const boardClampCache = new Map();
const BOARD_MEMBER_CHIPS_FOLD_AT = 20;
const BOARD_MEMBER_CHIPS_SHOWN = 16;

function hashBoardText(text) {
  const str = String(text || '');
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${str.length}:${(h >>> 0).toString(36)}`;
}

/** 完结帖稳定键：覆盖渲染输出依赖的全部字段；运行中 / 轨迹展开中的帖子返回空串（不缓存）。 */
function boardPostCacheKey(p, latest) {
  if (p.isRunningTurn || state.expandedTraces.has(p.postId)) return '';
  const t = p.thread || {};
  return [
    p.postId, p.seq, latest ? 1 : 0, p.ts || 0, p.isUser ? 1 : 0, p.isDispatch ? 1 : 0, p.authorName, p.targetName, p.inputIntent || '',
    t.id, t.model, t.effectiveModel || t.meta?.effectiveModel || '', t.modelDisplayName || '', t.durationMs || 0,
    t.id && state.threadsMap.has(t.id) ? 1 : 0, state.expandedBodies.has(p.postId) ? 1 : 0,
    p.isUser ? '' : renderThreadHealthBadgeHtml(t) + renderThreadModeBadgesHtml(t),
    p.isUser && p.injectedSpecs ? renderSpecBadgeHtml(p.injectedSpecs, p.postId) : '',
    p.reasoningSummary || '', p.toolCount || 0, p.failedToolCount || 0, p.toolItems.length, p.todoItems.length,
    p.reasoningItems.map((r) => `${r.status}:${r.durationMs || 0}:${r.createdAt || 0}:${r.completedAt || 0}`).join(','),
    resolveBoardTurnDurationMs(p, 0),
    p.errorItems.map((er) => er.error || '').join('\u0001'),
    hashBoardText(p.bodyText),
  ].join('\u0002');
}

function renderBoardPostHtmlCached(p, latest) {
  const key = boardPostCacheKey(p, latest);
  if (!key) return { html: renderBoardPostHtml(p, latest), key };
  const hit = boardPostHtmlCache.get(key);
  if (hit !== undefined) {
    boardPostHtmlCache.delete(key);
    boardPostHtmlCache.set(key, hit);
    return { html: hit, key };
  }
  const html = renderBoardPostHtml(p, latest);
  boardPostHtmlCache.set(key, html);
  if (boardPostHtmlCache.size > BOARD_POST_HTML_CACHE_MAX) boardPostHtmlCache.delete(boardPostHtmlCache.keys().next().value);
  return { html, key };
}

function getScopedBoardMessages(threads) {
  if (!Array.isArray(state.boardMessages) || state.boardMessages.length === 0) return [];
  const scopedIds = new Set(threads.map((t) => t.id));
  const scopedNames = new Set(threads.map((t) => shortMemberName(t).toLowerCase()));
  const activeRoot = state.rootConversationId || state.activeConversationId || getHostConversationId();

  return state.boardMessages.filter((m) => {
    if (m.threadId) {
      if (scopedIds.has(m.threadId)) return true;
      if (state.threadsMap.has(m.threadId)) return false;
    }
    if (activeRoot && m.rootConversationId && m.rootConversationId.toLowerCase() !== activeRoot.toLowerCase()) {
      return false;
    }
    if (scopedNames.has(String(m.agent || '').toLowerCase())) return true;
    return !activeRoot || (m.rootConversationId && m.rootConversationId.toLowerCase() === activeRoot.toLowerCase());
  });
}

function stripLeadingBoardMentions(text) {
  const t = String(text || '');
  const rest = t.replace(/^(\s*@[A-Za-z0-9_.-]+[,:]?)+\s*/, '');
  return rest || t;
}

export function buildBoardPosts(threads) {
  const posts = [];
  const byId = new Map(threads.map((t) => [t.id, t]));
  const byNameLower = new Map();
  for (const t of threads) {
    byNameLower.set(shortMemberName(t).toLowerCase(), t);
  }

  const scopedMsgs = getScopedBoardMessages(threads);
  const coveredThreadIds = new Set();
  const emittedResultRuns = new Set();
  const activeOrderByThread = new Map();
  for (const t of threads) {
    if (isStatusActive(t.status)) {
      const currentOrder = groupThreadWorkOrders(t).at(-1) || null;
      if (currentOrder) activeOrderByThread.set(t.id, currentOrder);
    }
  }

  for (const m of scopedMsgs) {
    const matchedThread =
      (m.threadId && (byId.get(m.threadId) || state.threadsMap.get(m.threadId))) ||
      byNameLower.get(String(m.agent || '').toLowerCase()) ||
      null;
    if (matchedThread) coveredThreadIds.add(matchedThread.id);
    if (matchedThread && m.source === 'orchestrator-result' && String(m.text || '').trim() === '正在执行任务…') {
      const activeOrder = activeOrderByThread.get(matchedThread.id);
      const liveRunId = String(matchedThread.activeRunId || matchedThread.currentRun?.id || activeOrder?.runs?.at(-1)?.id || activeOrder?.primaryRunId || '');
      const hasLiveActivity = Boolean(activeOrder && activeOrder.items.some((item) =>
        item.type !== 'user_message' && (!item.runId || !liveRunId || item.runId === liveRunId)));
      if (liveRunId && m.runId === liveRunId && hasLiveActivity) continue;
    }
    if (matchedThread && m.source === 'orchestrator-result' && m.runId) {
      emittedResultRuns.add(`${matchedThread.id}:${m.runId}`);
    }

    const targets = (m.mentions || []).filter((n) => n && n !== m.agent);
    if (m.all && !targets.includes('all')) targets.push('all');
    const targetName = targets.map((x) => `@${x}`).join(' ');
    const cleanBody = targets.length > 0 ? stripLeadingBoardMentions(m.text) : m.text;
    const authorLower = String(m.agent || '').toLowerCase();
    const isDispatch = m.source === 'orchestrator-dispatch' ||
      (m.source === 'native-swarm' && ['coordinator', 'commander', 'user', '你'].includes(authorLower) && targets.length > 0);

    posts.push({
      postId: `bm_${m.source}_${m.seq}_${m.agent}`,
      seq: m.seq,
      hasExplicitSeq: m.source === 'native-swarm' && m.seq > 0,
      thread: matchedThread || {
        id: m.threadId || `ext_${m.agent}`,
        title: m.agent,
        memberName: m.agent,
        provider: m.provider || 'antigravity',
        model: m.model || m.modelDisplayName || '',
        modelDisplayName: m.modelDisplayName || '',
        effectiveModel: m.effectiveModel || '',
        meta: m.meta || {},
        isNativeHost: m.source === 'native-swarm',
        status: m.hasError ? 'failed' : 'completed',
      },
      isUser: false,
      isDispatch,
      authorName: m.agent,
      targetName,
      targetNamesLower: targets.map((x) => String(x || '').toLowerCase()),
      inputIntent: '',
      ts: m.ts || 0,
      bodyText: cleanBody,
      injectedSpecs: isDispatch ? normalizeInjectedSpecs(m.meta?.injectedSpecs) : null,
      reasoningSummary: m.reasoningSummary || '',
      failedToolCount: m.failedToolCount || 0,
      toolCount: Number(m.toolCount || 0),
      reasoningItems: [],
      toolItems: [],
      todoItems: [],
      errorItems: m.hasError ? [{ error: m.errorText || '执行遇到异常' }] : [],
      isRunningTurn: false,
    });
  }

  for (const t of threads) {
    // 原生 Swarm / 后端已汇总入 boardMessages 的成员不重复合成摘要帖，除非其拥有实时本地增量 items
    const activeOrder = coveredThreadIds.has(t.id) && isStatusActive(t.status) ? activeOrderByThread.get(t.id) : null;
    const items = activeOrder ? activeOrder.items : Array.isArray(t.items) ? t.items : [];
    if (coveredThreadIds.has(t.id) && (t.isSwarmMember || items.length === 0)) {
      continue;
    }
    const parentThread = t.parentThreadId ? byId.get(t.parentThreadId) || state.threadsMap.get(t.parentThreadId) : null;
    const authorShort = shortMemberName(t);
    const parentShort = parentThread ? shortMemberName(parentThread) : '';

    if (items.length === 0) {
      if (coveredThreadIds.has(t.id)) continue;
      const fallbackBody = t.error
        ? `执行遇到问题：${t.error}`
        : t.summary || (isStatusActive(t.status) ? '正在初始化执行上下文...' : `状态：${STATUS_LABELS[t.status] || t.status}`);
      posts.push({
        postId: `post_synth_${t.id}`,
        hasExplicitSeq: false,
        thread: t,
        isUser: false,
        authorName: authorShort,
        targetName: parentShort ? `@${parentShort}` : '',
        ts: t.startedAt || t.createdAt || t.updatedAt,
        bodyText: fallbackBody,
        reasoningSummary: '',
        toolCount: 0,
        reasoningItems: [],
        toolItems: [],
        todoItems: [],
        hasError: Boolean(t.error || t.status === 'failed'), failedToolCount: 0,
        errorItems: t.error || t.status === 'failed' ? [{ error: t.error || '回合失败' }] : [],
        isRunningTurn: isStatusActive(t.status),
      });
      continue;
    }

    if (coveredThreadIds.has(t.id) && !isStatusActive(t.status)) continue;

    let curTurn = null;
    const flushTurn = () => {
      if (!curTurn) return;
      const run = t.recentRuns?.find(r => r.id === curTurn.runId);
      if (run) curTurn.errorItems = run.status === 'failed' || run.error ? [{ error: run.error || '回合失败' }] : [];
      else if (!curTurn.errorItems.length && t.status === 'failed' && curTurn.isLast) curTurn.errorItems.push({ error: t.error || '回合失败' });
      const hasAnyContent =
        curTurn.assistantTexts.length > 0 ||
        curTurn.reasoningItems.length > 0 ||
        curTurn.toolItems.length > 0 ||
        curTurn.todoItems.length > 0 ||
        curTurn.errorItems.length > 0;
      if (hasAnyContent) {
        posts.push({
          postId: curTurn.id,
          hasExplicitSeq: false,
          thread: t,
          isUser: false,
          authorName: authorShort,
          targetName: parentShort ? `@${parentShort}` : '',
          ts: curTurn.ts,
          bodyText: curTurn.assistantTexts.join('\n\n'),
          reasoningSummary: '',
          hasError: curTurn.errorItems.length > 0,
          failedToolCount: curTurn.toolItems.filter(it => it.status === 'failed').length,
          toolCount: curTurn.toolItems.length,
          reasoningItems: curTurn.reasoningItems,
          toolItems: curTurn.toolItems,
          todoItems: curTurn.todoItems,
          errorItems: curTurn.errorItems,
          isRunningTurn: curTurn.isRunning,
        });
      }
      curTurn = null;
    };

    const ensureTurn = (seedTs, idx) => {
      if (!curTurn) {
        curTurn = {
          id: `turn_${t.id}_${idx}`,
          ts: seedTs || t.startedAt || t.createdAt,
          assistantTexts: [],
          reasoningItems: [],
          toolItems: [],
          todoItems: [],
          errorItems: [],
          isRunning: false,
        };
      }
      return curTurn;
    };

    const coveredDispatchRuns = new Set(
      activeOrder
        ? scopedMsgs
            .filter((message) => message.source === 'orchestrator-dispatch' && message.threadId === t.id && message.runId)
            .map((message) => message.runId)
        : []
    );
    const seenCoveredDispatch = new Set();
    items.forEach((item, idx) => {
      if (item.type === 'user_message') {
        flushTurn();
        if (item.meta?.live !== true && item.runId && coveredDispatchRuns.has(item.runId) && !seenCoveredDispatch.has(item.runId)) {
          seenCoveredDispatch.add(item.runId);
          return;
        }
        if (coveredDispatchRuns.size > 0 && item === activeOrder?.promptItem) return;
        posts.push({
          postId: `u_${t.id}_${item.id}_${idx}`,
          hasExplicitSeq: false,
          thread: t,
          isUser: true,
          isDispatch: true,
          authorName: parentShort || '你',
          targetName: `@${authorShort}`,
          targetNamesLower: [authorShort.toLowerCase()],
          inputIntent: item.inputIntent || '',
          ts: item.createdAt || t.createdAt,
          bodyText: item.text || '',
          injectedSpecs: resolveInjectedSpecs(item, t),
          reasoningSummary: '',
          toolCount: 0,
          reasoningItems: [],
          toolItems: [],
          todoItems: [],
          errorItems: [],
          isRunningTurn: false,
        });
      } else {
        if (activeOrder && item.runId && emittedResultRuns.has(`${t.id}:${item.runId}`)) return;
        if (curTurn?.runId && item.runId && item.runId !== curTurn.runId) flushTurn();
        const turn = ensureTurn(item.createdAt, idx);
        turn.runId ||= item.runId;
        if (item.status === 'running') turn.isRunning = true;
        if (item.type === 'reasoning') {
          turn.reasoningItems.push(item);
        } else if (item.type === 'assistant_message') {
          if (item.text) turn.assistantTexts.push(item.text);
        } else if (item.type === 'command_execution' || item.type === 'file_change' || item.type === 'tool_call') {
          turn.toolItems.push(item);
        } else if (item.type === 'todo_list') {
          turn.todoItems.push(item);
        } else if (item.type === 'error') {
          if (item.toolCallId) turn.toolItems.push({ ...item, status: 'failed' });
          else turn.errorItems.push({ ...item, error: item.error || item.text });
        }
      }
    });
    if (curTurn) curTurn.isLast = true;
    flushTurn();
  }

  posts.sort((a, b) => {
    if (a.hasExplicitSeq && b.hasExplicitSeq) return a.seq - b.seq;
    return (a.ts || 0) - (b.ts || 0);
  });
  let nextAutoSeq = 1;
  for (const p of posts) {
    if (p.hasExplicitSeq && p.seq > 0) {
      nextAutoSeq = Math.max(nextAutoSeq, p.seq + 1);
    } else {
      p.seq = nextAutoSeq++;
    }
  }
  return posts;
}

/**
 * 宽屏（≥ 1120px）看板右侧 300px 吸顶实时状态边栏 .board-side-rail：
 * ① 当前模式与已启用阵容速览 ② 活跃 / 排队成员（复用 data-open-member 打开详情）③ 待处理审批与活跃 Worktree 快照。
 * 窄栏下由 CSS 隐藏（DOM 保留、零横向占用）；内容不变时 innerHTML 护栏自动跳过重写。
 */
export function renderBoardSideRail(scopedThreads = getScopedThreads()) {
  const rail = document.getElementById('board-side-rail');
  if (!rail) return;
  const mode = currentOrchestrationMode();
  const meta = orchestrationModeMeta(mode);
  const roster = modeRosterSummary(mode);
  const active = scopedThreads.filter((t) => isStatusActive(t.status) || isStatusPendingIntervention(t)).slice(0, 8);
  const requests = getScopedRequests();
  const worktrees = getScopedWorktrees().slice(0, 6);
  const memberHtml = active.length
    ? active.map((t) => {
      const st = normalizeStatus(t.status);
      return `<button type="button" class="rail-member" data-open-member="${escapeHtml(t.id)}" title="${escapeHtml(`${shortMemberName(t)} · ${formatModelDisplay(t.model) || ''}`)}">
          <span class="rail-dot is-${escapeHtml(st)}" aria-hidden="true"></span>
          <span class="rail-member-name">${escapeHtml(shortMemberName(t))}</span>
          <span class="rail-member-status">${escapeHtml(STATUS_LABELS[st] || st)}</span>
        </button>`;
    }).join('')
    : '<p class="rail-empty">暂无活跃或排队成员</p>';
  const reqHtml = requests.length
    ? requests.slice(0, 4).map((r) => {
      const t = state.threadsMap.get(r.threadId);
      return `<button type="button" class="rail-item" ${t ? `data-open-member="${escapeHtml(t.id)}"` : ''} title="${escapeHtml(r.title)}"><span class="rail-item-kind">${r.kind === 'question' ? '提问' : '审批'}</span><span class="rail-item-text">${escapeHtml(r.title)}</span></button>`;
    }).join('')
    : '<p class="rail-empty">暂无待处理审批</p>';
  const wtHtml = worktrees.length
    ? worktrees.map((w) => `<button type="button" class="rail-item" data-rail-worktree="${escapeHtml(w.id)}" title="${escapeHtml(w.path || w.branch)}"><span class="rail-item-text mono">${escapeHtml(w.branch)}</span><span class="rail-item-meta num">${w.filesCount ? `${w.filesCount} 文件` : ''}${w.additions || w.deletions ? ` +${w.additions}/-${w.deletions}` : ''}</span></button>`).join('')
    : '<p class="rail-empty">暂无活跃 Worktree</p>';
  rail.innerHTML = `<section class="rail-card" data-rail="mode">
      <div class="rail-card-head"><span class="rail-title">当前模式</span><span class="rail-mode-badge ${escapeHtml(meta.cls.split(' ')[0])}">${escapeHtml(meta.name)}</span></div>
      <p class="rail-sub">${escapeHtml(meta.desc)}</p>
      ${roster ? `<p class="rail-roster">${escapeHtml(roster)}</p>` : ''}
      ${mode === 'direct' ? '' : `<button type="button" class="ghost-xs-btn rail-link" data-rail-goto-roster="${escapeHtml(mode)}">配置阵容 →</button>`}
    </section>
    <section class="rail-card" data-rail="members">
      <div class="rail-card-head"><span class="rail-title">活跃 / 排队成员</span><span class="rail-count num">${active.length}</span></div>
      <div class="rail-list">${memberHtml}</div>
    </section>
    <section class="rail-card" data-rail="approvals">
      <div class="rail-card-head"><span class="rail-title">待处理审批</span><span class="rail-count num${requests.length ? ' is-hot' : ''}">${requests.length}</span></div>
      <div class="rail-list">${reqHtml}</div>
    </section>
    <section class="rail-card" data-rail="worktrees">
      <div class="rail-card-head"><span class="rail-title">活跃 Worktree</span><span class="rail-count num">${getScopedWorktrees().length}</span></div>
      <div class="rail-list">${wtHtml}</div>
    </section>`;
}

/** 当前搜索词与成员筛选下的看板帖子（窗口切片前的完整序列）。 */
export function getFilteredBoardPosts(scopedThreads = getScopedThreads()) {
  const allPosts = buildBoardPosts(scopedThreads);
  const q = state.boardSearch.trim().toLowerCase();
  const selectedNamesLower = new Set();
  if (state.boardMemberFilters.size > 0) {
    for (const key of state.boardMemberFilters) {
      const t = state.threadsMap.get(key);
      if (t) selectedNamesLower.add(shortMemberName(t).toLowerCase());
      else selectedNamesLower.add(String(key).toLowerCase());
    }
  }
  return allPosts.filter((p) => {
    if (state.boardMemberFilters.size > 0) {
      const matchId = state.boardMemberFilters.has(p.thread.id);
      const matchName = selectedNamesLower.has(String(p.authorName || '').toLowerCase());
      const matchTarget = Array.isArray(p.targetNamesLower) &&
        p.targetNamesLower.some((name) => selectedNamesLower.has(name) || name === 'all');
      if (!matchId && !matchName && !matchTarget) return false;
    }
    if (q) {
      const hay = `${p.authorName} ${p.targetName} ${p.bodyText} ${p.thread.model} ${p.thread.provider}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

/** 点击 #序号 引用：目标帖被折叠在更早消息中时调大可见窗口使其进入视野；找不到（被筛选掉）返回 false。 */
export function revealBoardSeq(seq) {
  const posts = getFilteredBoardPosts();
  const idx = posts.findIndex((p) => String(p.seq) === String(seq));
  if (idx < 0) return false;
  const need = posts.length - idx;
  if (Number.isFinite(state.boardVisibleLimit) && need > state.boardVisibleLimit) state.boardVisibleLimit = need;
  return true;
}

function renderBoardWindowBar(total, visible) {
  const summary = document.getElementById('board-window-summary');
  if (summary) summary.textContent = visible < total ? `显示最新 ${visible} / 共 ${total} 条` : `共 ${total} 条发言`;
  document.querySelectorAll('#board-page-size [data-board-limit]').forEach((b) => {
    const on = b.dataset.boardLimit === state.boardPageSize;
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function renderBoardMemberChipsHtml(scopedThreads) {
  if (scopedThreads.length === 0) return '<span class="sub-note">当前对话暂无成员</span>';
  let shown = scopedThreads;
  if (scopedThreads.length > BOARD_MEMBER_CHIPS_FOLD_AT && !state.boardChipsExpanded) {
    // getScopedThreads 已按「待介入 → 活跃 → 最近更新」排序：取前 16 位，另补已选中的筛选胶囊
    shown = scopedThreads.filter((t, i) => i < BOARD_MEMBER_CHIPS_SHOWN || state.boardMemberFilters.has(t.id) ||
      state.boardMemberFilters.has(shortMemberName(t).toLowerCase()));
  }
  const chips = shown
    .map((t) => {
      const label = shortMemberName(t);
      const active = state.boardMemberFilters.size === 0 || state.boardMemberFilters.has(t.id) || state.boardMemberFilters.has(label.toLowerCase());
      return `<button type="button" class="member-filter-chip ${active ? '' : 'dim'}" data-chip-thread="${escapeHtml(t.id)}" data-chip-name="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
    })
    .join('');
  const rest = scopedThreads.length - shown.length;
  return rest > 0 ? `${chips}<button type="button" class="member-filter-chip is-more" data-expand-board-chips="1">+展开其余 ${rest} 位</button>` : chips;
}

function renderBoardOlderBarHtml(hiddenCount) {
  return `<div class="board-older-bar" role="status">
      <span class="sub-note">已折叠更早 ${hiddenCount} 条发言</span>
      <span class="board-older-actions">
        <button type="button" class="ghost-xs-btn" data-board-load-older="20">↑ 加载更早 ${Math.min(20, hiddenCount)} 条</button>
        <button type="button" class="ghost-xs-btn" data-board-load-older="all">显示全部</button>
      </span>
    </div>`;
}

let boardWindowFirstPostId = '';
let boardWindowLimit = 0;

export function renderBoardView() {
  const scopedThreads = getScopedThreads();
  renderBoardSideRail(scopedThreads);
  const isEmpty = isConversationCollaborationEmpty(scopedThreads, state.boardMessages);
  const emptyBox = document.getElementById('board-empty-state');
  const toolbarEl = document.getElementById('board-toolbar');
  const feedEl = document.getElementById('board-feed');
  const jumpEl = document.getElementById('btn-jump-latest');

  if (isEmpty) {
    if (emptyBox) emptyBox.hidden = false;
    if (toolbarEl) toolbarEl.hidden = true;
    if (feedEl) {
      feedEl.hidden = true;
      feedEl.__atBoardHtml = '';
      feedEl.innerHTML = '';
    }
    if (jumpEl) jumpEl.hidden = true;
    return;
  }

  if (emptyBox) emptyBox.hidden = true;
  if (toolbarEl) toolbarEl.hidden = false;
  if (feedEl) feedEl.hidden = false;

  const filterDot = document.getElementById('board-filter-dot');
  const hasFilter = Boolean(state.boardSearch.trim()) || state.boardMemberFilters.size > 0;
  if (filterDot) filterDot.hidden = !hasFilter;

  const filterPanel = document.getElementById('board-filters-panel');
  if (filterPanel) filterPanel.hidden = !state.boardFiltersOpen;

  const followChk = document.getElementById('chk-board-follow');
  if (followChk) followChk.checked = state.boardFollow;

  const chipsBox = document.getElementById('board-member-chips');
  if (chipsBox) chipsBox.innerHTML = renderBoardMemberChipsHtml(scopedThreads);

  const filteredPosts = getFilteredBoardPosts(scopedThreads);

  if (!feedEl) return;

  if (filteredPosts.length === 0) {
    renderBoardWindowBar(0, 0);
    feedEl.__atBoardHtml = '';
    feedEl.innerHTML = `<div class="empty-stage-box"><p>当前搜索或成员筛选条件下暂无匹配消息。</p></div>`;
    return;
  }

  // 按需窗口：默认只渲染最新 N 条；用户上翻阅读期间新帖到达时扩窗保住首条可见帖，阅读位置不被顶走
  // （仅当可见上限仍是上一帧所用值；用户主动切档 / 加载更早 / #序号展开时以显式上限为准）
  let limit = state.boardVisibleLimit;
  if (state.boardUserScrolledUp && Number.isFinite(limit) && limit === boardWindowLimit && boardWindowFirstPostId) {
    const anchorIdx = filteredPosts.findIndex((p) => p.postId === boardWindowFirstPostId);
    if (anchorIdx >= 0 && filteredPosts.length - anchorIdx > limit) {
      limit = filteredPosts.length - anchorIdx;
      state.boardVisibleLimit = limit;
    }
  }
  const hiddenCount = Number.isFinite(limit) ? Math.max(0, filteredPosts.length - limit) : 0;
  const visiblePosts = hiddenCount > 0 ? filteredPosts.slice(-limit) : filteredPosts;
  boardWindowFirstPostId = visiblePosts[0]?.postId || '';
  boardWindowLimit = limit;
  renderBoardWindowBar(filteredPosts.length, visiblePosts.length);

  const postKeys = new Map();
  const parts = hiddenCount > 0 ? [{ key: '__older__', html: renderBoardOlderBarHtml(hiddenCount) }] : [];
  visiblePosts.forEach((p, i) => {
    const { html: postHtml, key } = renderBoardPostHtmlCached(p, i === visiblePosts.length - 1);
    if (key) postKeys.set(p.postId, key);
    parts.push({ key: p.postId, html: postHtml });
  });
  const html = parts.map((part) => part.html).join('');
  const feedChanged = html !== feedEl.__atBoardHtml;
  if (feedChanged) {
    const freshPosts = patchBoardFeed(feedEl, parts);
    feedEl.__atBoardHtml = html;
    measureBoardClamps(postKeys, freshPosts);
  }

  if (state.boardFollow && !state.boardUserScrolledUp && (state.boardNeedsAutoScroll || feedChanged)) {
    state.boardNeedsAutoScroll = false;
    scrollMainToBottom();
  }
  updateJumpLatestButtonVisibility();
}

/**
 * 看板 Feed 按帖子键增量协调：HTML 未变的帖子节点原样保留（content-visibility 记住的真实高度、浏览器滚动锚定、
 * 焦点与秒表文本都不丢），只替换 / 插入变化帖并删除离开窗口的帖子。返回新建节点集合供折叠测量；
 * 缺少 DOM 能力的桩环境回退整块 innerHTML（返回 null = 全部重测）。
 */
function patchBoardFeed(feedEl, parts) {
  if (typeof feedEl.insertBefore !== 'function' || !feedEl.children || typeof document.createElement !== 'function') {
    setTimelineHtml(feedEl, parts.map((part) => part.html).join(''));
    return null;
  }
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.specToggle;
  const restoreFocus = Boolean(focusKey && feedEl.contains(focused));
  const reusable = new Map();
  for (const el of Array.from(feedEl.children)) {
    if (el.__atBoardHtml !== undefined && el.dataset?.boardKey) reusable.set(el.dataset.boardKey, el);
  }
  const fresh = new Set();
  let cursor = feedEl.firstChild;
  for (const { key, html } of parts) {
    let el = reusable.get(key);
    if (el && el.__atBoardHtml === html) {
      reusable.delete(key);
    } else {
      const tpl = document.createElement('template');
      tpl.innerHTML = html.trim();
      el = tpl.content.firstElementChild;
      if (!el) continue;
      el.dataset.boardKey = key;
      el.__atBoardHtml = html;
      fresh.add(el);
    }
    if (el === cursor) cursor = cursor.nextSibling;
    else feedEl.insertBefore(el, cursor);
  }
  while (cursor) {
    const next = cursor.nextSibling;
    cursor.remove();
    cursor = next;
  }
  // 绕过 innerHTML 的增量写入后作废 no-op 护栏快照，防止之后同内容整块写入被误判为未变
  feedEl.__atLastHtml = undefined;
  if (restoreFocus && !focused.isConnected) {
    feedEl.querySelector(`[data-spec-toggle="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
  }
  return fresh;
}

function measureBoardClamps(postKeys = new Map(), freshPosts = null) {
  const feedEl = document.getElementById('board-feed');
  if (!feedEl || typeof feedEl.querySelectorAll !== 'function') return;
  const width = Number(feedEl.clientWidth || 0);
  const measurements = [];
  const settled = [];
  for (const body of feedEl.querySelectorAll('.post-body')) {
    const postEl = body.closest?.('.board-post');
    // 增量协调保留下来的旧节点沿用其已有折叠态，只测量新建 / 替换的帖子
    if (freshPosts && postEl && !freshPosts.has(postEl)) continue;
    const postId = postEl?.dataset?.postId || '';
    const btn = body.nextElementSibling?.classList?.contains('post-more') ? body.nextElementSibling : null;
    const key = postKeys.get(postId);
    const clampKey = key && width > 0 ? `${key}@${width}` : '';
    const cached = clampKey ? boardClampCache.get(postId) : null;
    if (cached && cached.key === clampKey) {
      // 稳定帖在同一宽度下测量结果不变：直接复用，免去 content-visibility 跳过区域的强制布局
      settled.push({ body, btn, wasOpen: state.expandedBodies.has(postId), overflows: cached.overflows });
      continue;
    }
    measurements.push({ body, btn, postId, clampKey, wasOpen: state.expandedBodies.has(postId) });
    body.classList.add('clamped');
    body.classList.remove('open');
  }
  for (const entry of measurements) {
    const height = entry.body.clientHeight;
    entry.overflows = height > 0 && entry.body.scrollHeight > height + 4;
    if (entry.clampKey && height > 0) {
      boardClampCache.set(entry.postId, { key: entry.clampKey, overflows: entry.overflows });
      if (boardClampCache.size > BOARD_POST_HTML_CACHE_MAX) boardClampCache.delete(boardClampCache.keys().next().value);
    }
  }
  for (const { body, btn, wasOpen, overflows } of [...measurements, ...settled]) {
    body.classList.toggle('open', wasOpen);
    body.classList.toggle('clamped', overflows);
    if (btn) {
      btn.hidden = !overflows;
      btn.setAttribute('aria-expanded', String(wasOpen));
      btn.textContent = wasOpen ? '收起' : '展开全文';
    }
  }
}

export function resolveBoardTurnDurationMs(post, reasoningDurationMs = 0) {
  if (reasoningDurationMs > 0) return reasoningDurationMs;
  const items = [...(post.reasoningItems || []), ...(post.toolItems || [])];
  const startedAt = Math.min(...items.map((item) => Number(item.createdAt || 0)).filter(Boolean));
  const completedAt = Math.max(...items.map((item) => Number(item.completedAt || item.createdAt || 0)).filter(Boolean));
  const spanMs = startedAt > 0 && completedAt > startedAt ? completedAt - startedAt : 0;
  return spanMs || Number(post.thread?.durationMs || 0);
}

export function renderBoardPostHtml(p, latest) {
  const t = p.thread;
  const isCommandPost = Boolean(p.isUser || p.isDispatch);
  const authorLow = String(p.authorName || '').toLowerCase();
  const initials = p.isUser
    ? '你'
    : p.isDispatch && ['coordinator', 'commander'].includes(authorLow)
    ? '主'
    : (p.authorName || 'A').charAt(0).toUpperCase();
  const avBg = isCommandPost ? '' : `style="--av:${agentPastelColor(p.authorName)}"`;
  const avatarCls = isCommandPost ? 'post-avatar user' : 'post-avatar';

  const targetHtml = p.targetName ? `<span class="post-to-arrow">→ ${escapeHtml(p.targetName)}</span>` : '';
  const dispatchTag = p.isDispatch && !p.isUser ? '<span class="post-dispatch-tag">派单指令</span>' : '';
  const steerTag = p.inputIntent === 'steer' ? '<span class="post-model-faint">⚡ Steer</span>' : '';
  const postModelLabel = formatModelDisplay(t.model, t.effectiveModel || t.meta?.effectiveModel || '', t.modelDisplayName);
  const modelShort = !isCommandPost && postModelLabel ? `<span class="post-model-faint">${escapeHtml(postModelLabel)}</span>` : '';

  let traceHtml = '';
  const totalTools = p.toolItems.length || p.toolCount || 0;
  const hasReasoning = p.reasoningItems.length > 0 || Boolean(p.reasoningSummary);
  const hasTodos = p.todoItems.length > 0;
  if (!isCommandPost && (hasReasoning || totalTools > 0 || hasTodos)) {
    const isExpanded = state.expandedTraces.has(p.postId);
    const rsRunning = p.reasoningItems.some((r) => r.status === 'running') || p.isRunningTurn;

    let rsDurMs = 0;
    let rsLiveStart = 0;
    for (const r of p.reasoningItems) {
      if (r.status === 'running') {
        const st = Number(r.createdAt || 0);
        if (st > 0 && (!rsLiveStart || st < rsLiveStart)) rsLiveStart = st;
      } else {
        rsDurMs += r.durationMs || Math.max(0, (r.completedAt || r.createdAt) - r.createdAt);
      }
    }

    rsDurMs = resolveBoardTurnDurationMs(p, rsDurMs);

    const summaryParts = [];
    if (hasReasoning && !(rsRunning && rsLiveStart)) {
      summaryParts.push(rsDurMs > 0 ? `${rsRunning ? '思考中' : '思考'} ${formatDurationMs(rsDurMs)}` : p.reasoningSummary || '思考记录');
    }
    if (totalTools > 0) summaryParts.push(`${totalTools} 次工具调用${p.failedToolCount ? `（${p.failedToolCount} 次失败）` : ''}`);
    if (hasTodos && !totalTools) summaryParts.push('执行计划');
    // 运行中的思考计时交由 350ms 秒表 ticker 原地更新 textContent，HTML 字符串保持稳定，避免整块重绘闪烁
    const liveRsHtml = rsRunning && rsLiveStart
      ? `<span>思考中 <span data-live-rs-start="${rsLiveStart}"></span></span>${summaryParts.length ? '<span> · </span>' : ''}`
      : '';

    traceHtml = `
        <div class="post-trace-box">
          <button type="button" class="post-trace-toggle" data-trace-post="${escapeHtml(p.postId)}" aria-expanded="${isExpanded}">
            <span>${isExpanded ? '▾' : '▸'}</span>
            ${rsRunning ? '<span class="trace-dot running"></span>' : ''}
            ${liveRsHtml}<span>${escapeHtml(summaryParts.join(' · '))}</span>
          </button>
          ${isExpanded ? renderTraceDetailHtml(p) : ''}
        </div>
      `;
  }

  const errorHtml = p.errorItems
    .map(
      (er) => `
      <div class="error-inline-box" style="grid-column:2;">
        <div>❌ <strong>执行异常：</strong>${escapeHtml(er.error || '任务中断')}</div>
        <div class="req-btn-row">
          <button type="button" class="ghost-xs-btn" data-retry-thread="${escapeHtml(t.id)}">🔄 重试</button>
          <button type="button" class="ghost-xs-btn" data-switch-retry="${escapeHtml(t.id)}">🔀 换模型重试</button>
        </div>
      </div>
    `
    )
    .join('');

  const isBodyOpen = state.expandedBodies.has(p.postId);
  const bodyContent = p.bodyText
    ? `<div class="markdown-prose">${renderMarkdownSafe(p.bodyText)}</div>`
    : p.isRunningTurn
    ? `<span style="color:var(--sw-fg-muted);font-size:12px;">正在执行中…</span>`
    : '';
  const canOpenMember = Boolean(t.id && state.threadsMap.has(t.id));

  return `
      <article class="board-post${latest ? ' is-latest-post' : ''}${isCommandPost ? ' is-dispatch-post' : ''}" data-post-id="${escapeHtml(p.postId)}" data-seq="${p.seq}" data-thread-id="${escapeHtml(t.id)}">
        <div class="${avatarCls}" ${avBg}>${escapeHtml(initials)}</div>
        <div class="post-head">
          <div class="post-who">
            <button type="button" class="post-author-btn" ${canOpenMember ? `data-open-member="${escapeHtml(t.id)}"` : ''}>${escapeHtml(p.authorName)}</button>
            ${targetHtml}
            ${dispatchTag}
            ${steerTag}
            ${modelShort}
            ${!isCommandPost ? renderThreadHealthBadgeHtml(t) + renderThreadModeBadgesHtml(t) : ''}
          </div>
          <span class="post-meta-ts">#${p.seq} · ${escapeHtml(formatTimeShort(p.ts))}</span>
        </div>
        ${bodyContent ? `<div class="post-body ${isBodyOpen ? 'open' : ''}">${bodyContent}</div><button type="button" class="post-more" data-toggle-body="${escapeHtml(p.postId)}" aria-expanded="${isBodyOpen}" hidden>${isBodyOpen ? '收起' : '展开全文'}</button>` : ''}
        ${isCommandPost && p.injectedSpecs ? renderSpecBadgeHtml(p.injectedSpecs, p.postId) : ''}
        ${traceHtml}
        ${errorHtml}
      </article>
    `;
}

function renderTraceDetailHtml(post) {
  const t = post.thread;
  const chunks = [];

  if (post.reasoningItems.length > 0) {
    const mergedRs = post.reasoningItems.map((r) => r.text).filter(Boolean).join('\n\n');
    if (mergedRs) chunks.push(`<div class="trace-reasoning-block">${escapeHtml(mergedRs)}</div>`);
  } else if (post.reasoningSummary) {
    chunks.push(`<div class="trace-reasoning-block">${escapeHtml(post.reasoningSummary)}</div>`);
  }

  for (const todo of post.todoItems) {
    const itemsHtml = (todo.entries || [])
      .map((e) => {
        const done = e.status === 'completed' || e.done;
        return `<div>${done ? '✅' : '⏳'} ${escapeHtml(e.content || e.title || e.text || JSON.stringify(e))}</div>`;
      })
      .join('');
    if (itemsHtml) chunks.push(`<div class="trace-reasoning-block"><strong>执行计划</strong>${itemsHtml}</div>`);
  }

  for (const item of post.toolItems) {
    const expKey = `${t.id}:${item.id}`;
    const isOutOpen = state.expandedToolIds.has(expKey);
    const isFail = item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0);
    const ico = item.status === 'running' ? '⏳' : isFail ? '✗' : '✓';

    let label = item.title || item.type;
    let extraRight = '';
    if (item.type === 'command_execution') {
      label = `$ ${item.command || item.title || '执行命令'}`;
      if (item.exitCode !== null) extraRight = `exit ${item.exitCode}`;
    } else if (item.type === 'file_change') {
      label = item.filePath || item.title || '修改文件';
      extraRight = `<span class="stat-add">+${item.additions}</span> <span class="stat-del">-${item.deletions}</span>`;
    }

    const rawOut = stripAnsi(String(item.output || item.diff || ''));
    const fileBtn = item.filePath
      ? `<button type="button" class="file-link-btn" data-open-file="${escapeHtml(item.filePath)}" data-base-dir="${escapeHtml(t.worktreePath || t.cwd || '')}">打开文件</button>`
      : '';
    const outToggle = rawOut
      ? `<button type="button" class="ghost-xs-btn" data-toggle-tool-out="${escapeHtml(expKey)}">${isOutOpen ? '收起' : '输出'}</button>`
      : '';

    chunks.push(`
        <div class="trace-tool-row">
          <div class="trace-tool-head">
            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${ico} ${escapeHtml(label)}</span>
            <span style="display:inline-flex;align-items:center;gap:5px;flex-shrink:0;">
              ${extraRight}
              ${fileBtn}
              ${outToggle}
            </span>
          </div>
          ${rawOut && isOutOpen ? `<pre class="trace-tool-output">${escapeHtml(rawOut)}</pre>` : ''}
        </div>
      `);
  }

  return `<div class="post-trace-detail">${chunks.join('')}</div>`;
}

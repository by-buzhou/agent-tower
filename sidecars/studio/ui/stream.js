/**
 * AgentTower Studio — Bootstrap、SSE / 轮询实时流与会话切换清理 (`ui/stream.js`)
 * 非重叠轮询 + SSE 断线重连；ingestStreamPayload / applySingleEvent 为实时事件唯一入口。
 */
import { normalizeProjectPath, projectPathKey } from './format.js';
import { applySpecCurationPayload, currentOrchestrationMode, currentProjectConfig, currentProjectKey, emptySpecCuration, getEffectiveConversationId, getHostConversationId, getScopedThreads, isConversationCollaborationEmpty, isStatusActive, isStatusPendingIntervention, normalizeModeId, normalizeStatus, recomputeScopedStats, resetBoardWindowState, state, syncActiveTargetThread } from './state.js';
import { resetBoardFollow, scheduleRender } from './render.js';
import { checkAssetUpdate, httpGetJson, isEmbeddedHost, rpcCall, showToast } from './net.js';
import { applySessionAndUpdatePayload, normalizeBoardMessage, normalizeCollaborationEdge, normalizeExtensionList, normalizeProvidersCatalog, normalizeQueueItem, normalizeRuntimeRequest, normalizeThread, normalizeTurnItem, normalizeWorktree, upsertLocalThread } from './normalize.js';
import { applyActiveModePayload, mergeRemotePresets, syncCurrentProjectSpecFromGlobal } from './presets.js';
import { syncComposerSelects } from './options.js';

export async function loadBootstrap() {
  const convId = getEffectiveConversationId();
  if (convId && state.activeConversationId && convId !== state.activeConversationId) {
    await resetForConversation(convId);
    return;
  }
  if (convId && !state.activeConversationId) {
    state.activeConversationId = convId;
  }
  const reqSeq = ++state.bootstrapSeq;
  const task = httpGetJson('api/bootstrap', {
    conversationId: convId || undefined,
    workspace: !convId && state.workspace ? state.workspace : undefined,
  }, { timeoutMs: 8000 });
  state.bootstrapPromise = task;
  state.bootstrapInFlight = true;
  let autoConvId = '';
  try {
    const data = await task;
    // 旧请求（期间已切换会话或重新发起 Bootstrap）的迟到响应一律丢弃
    if (reqSeq !== state.bootstrapSeq || convId !== getEffectiveConversationId()) return;
    autoConvId = applyBootstrapSnapshot(data, { requestConvId: convId, reqSeq });
    state.bootstrapLoaded = true;
  } finally {
    if (state.bootstrapPromise === task) {
      state.bootstrapPromise = null;
      state.bootstrapInFlight = false;
    }
  }
  // 分支 B：网页裸打开 → 按 suggestedConversationId / 唯一候选自动重拉该会话真实策略与线程快照
  if (autoConvId && reqSeq === state.bootstrapSeq && !getEffectiveConversationId()) {
    await resetForConversation(autoConvId);
  }
}

/**
 * v0.2.6 C06①：断线恢复 / 侧栏重新可见时幂等补拉完整 Bootstrap。单飞（已有在途 Bootstrap 时复用），
 * 旧响应由 loadBootstrap 内的 bootstrapSeq 与会话 ID 校验丢弃；返回是否在同一会话纪元内补拉成功。
 */
export function recoverBootstrap() {
  if (state.bootstrapInFlight && state.bootstrapPromise) return state.bootstrapPromise.then(() => true, () => false);
  const epoch = state.conversationEpoch;
  return loadBootstrap().then(
    () => epoch === state.conversationEpoch && state.bootstrapLoaded,
    () => false
  );
}

/**
 * Bootstrap / 流式快照统一入口，返回分支 B 的自动绑定目标会话 ID（无则为空串）。
 * - 分支 A（已绑定：请求带会话 ID 或响应带 rootConversationId）：正常应用会话策略 / 线程，并把会话与工作区写回地址栏；
 * - 分支 B（独立网页端裸打开且服务端未解析出会话）：只吸收全局配置，严禁应用空会话响应里的默认 direct 策略。
 */
function applyBootstrapSnapshot(data, { requestConvId = getEffectiveConversationId(), reqSeq = 0, fromStream = false } = {}) {
  if (!data || typeof data !== 'object') return '';
  if (reqSeq && reqSeq !== state.bootstrapSeq) return '';
  const hostConv = getHostConversationId();
  const snapRoot = String(data.rootConversationId || '').trim();
  const unboundResponse = !requestConvId && !hostConv && !snapRoot;
  const curRoot = state.rootConversationId || state.activeConversationId || hostConv;
  const foreignSnapshot = fromStream && snapRoot && curRoot && snapRoot.toLowerCase() !== curRoot.toLowerCase();
  // 未绑定期间的流式快照、或串台快照同样只吸收全局部分
  const bound = !unboundResponse && !foreignSnapshot && !(fromStream && state.conversationUnbound);

  checkAssetUpdate(data.frontendAssetHash);
  if (data.version) state.version = String(data.version);
  if (data.studioUrl) state.studioUrl = String(data.studioUrl);
  if (Array.isArray(data.availableConversations)) state.availableConversations = data.availableConversations;
  if (typeof data.suggestedConversationId === 'string' || unboundResponse) {
    state.suggestedConversationId = String(data.suggestedConversationId || '').trim();
  }
  if (bound) {
    state.conversationUnbound = false;
    if (!state.activeConversationId && snapRoot) state.activeConversationId = snapRoot;
    if (Object.hasOwn(data, 'workspace') && (!isEmbeddedHost() || !state.workspace)) {
      state.workspace = normalizeProjectPath(data.workspace || '');
    }
    if (snapRoot) state.rootConversationId = snapRoot;
    if (typeof data.projectName === 'string' || data.projectName === null) state.projectName = data.projectName?.trim() || '';
    if (typeof data.conversationTitle === 'string' && data.conversationTitle.trim()) {
      state.conversationTitle = data.conversationTitle.trim();
    }
  }

  const settings = data.settings || {};
  applyDefaultModeSettings(settings);
  if (bound) {
    if (data.activeMode && typeof data.activeMode === 'object') applyActiveModePayload(data.activeMode);
    if (data.conversationPolicy && typeof data.conversationPolicy === 'object') {
      applyConversationPolicyPayload(data.conversationPolicy);
    } else if (state.conversationPolicy.source === 'default') {
      followDefaultModeIfUnset();
    }
    if (Array.isArray(data.healthIncidents)) {
      state.healthIncidents = acceptOpenIncidents(data.healthIncidents);
    }
  }

  const rawExtTpls = data.extensionTemplates || settings.extensionTemplates || state.extensionTemplates;
  const rawCustomProvs = data.customProviders || settings.customProviders || state.customProviders;
  const normExt = normalizeExtensionList(rawExtTpls, rawCustomProvs);
  state.extensionTemplates = normExt.templates;
  state.customProviders = normExt.customProviders;

  if (data.providers) {
    state.providers = normalizeProvidersCatalog(data.providers, state.customProviders);
  } else {
    state.providers = normalizeProvidersCatalog(null, state.customProviders);
  }

  // 串台快照（其他根会话）只吸收全局摘要，绝不切换 / 覆盖当前项目阵容
  mergeRemotePresets(data, { skipRoster: Boolean(foreignSnapshot) });
  applySessionAndUpdatePayload(foreignSnapshot ? { ...data, projectConfig: undefined } : data);

  if (bound) applySessionCollections(data);

  if (typeof data.latestSeq === 'number' && data.latestSeq > state.latestSeq) {
    state.latestSeq = data.latestSeq;
  } else if (typeof data.nextSeq === 'number' && data.nextSeq > state.latestSeq) {
    state.latestSeq = data.nextSeq;
  }

  let autoConvId = '';
  if (unboundResponse && !fromStream) {
    const list = Array.isArray(state.availableConversations) ? state.availableConversations : [];
    const only = list.length === 1 ? list[0] : null;
    if (!isEmbeddedHost()) autoConvId = state.suggestedConversationId || String(only?.rootConversationId || only?.conversationId || '').trim();
    if (!autoConvId) markConversationUnbound();
  }

  recomputeScopedStats();
  syncActiveTargetThread();
  syncComposerSelects();
  hydrateMissingTimelines();
  state.boardNeedsAutoScroll = true;
  scheduleRender();
  if (bound && !fromStream) syncStandaloneUrl();
  return autoConvId;
}

function resetSpecCurationClientState() {
  state.specCuration = emptySpecCuration('');
  Object.assign(state.specCurationUi, { triggerOpen: false, note: '', reviseOpen: false, feedback: '', busy: '', statusLoading: false, statusLoadedFor: '', watchRun: '' });
  state.specCurationUi.openDetails.clear();
}

/** 0 候选或多候选且无明确活跃提示：进入中性待选空态，清空一切会话级残留。 */
function markConversationUnbound() {
  state.conversationUnbound = true;
  state.activeConversationId = '';
  state.rootConversationId = '';
  state.projectName = '';
  state.conversationTitle = '';
  resetSpecCurationClientState();
  state.threadsMap.clear();
  state.boardMessages = [];
  state.collaborationEdges = [];
  resetSwarmBoardWatermark();
  state.pendingRequests.clear();
  state.worktrees = [];
  state.healthIncidents = [];
  state.activeMode = null;
  state.modeSwitching = null;
  state.modePopoverOpen = false;
  state.selectedThreadId = '';
  closeMemberDrawer();
}

/** 独立网页端：把当前已绑定会话与有效工作区写回地址栏（replaceState，不产生历史记录），并清除残留 auth / launch。 */
export function syncStandaloneUrl() {
  if (isEmbeddedHost() || typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    const conv = String(state.activeConversationId || '').trim();
    const ws = state.workspace ? normalizeProjectPath(state.workspace) : '';
    if (conv) url.searchParams.set('conversationId', conv);
    else url.searchParams.delete('conversationId');
    if (ws) url.searchParams.set('workspace', ws);
    else url.searchParams.delete('workspace');
    url.searchParams.delete('auth');
    url.searchParams.delete('launch');
    const next = `${url.pathname}${url.search}${url.hash}`;
    const cur = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== cur) window.history.replaceState(window.history.state, '', next);
  } catch { /* 受限环境（about:srcdoc 等）不支持改写地址栏时静默跳过 */ }
}

function applySessionCollections(data) {
  if (Array.isArray(data.threads)) {
    const nextIds = new Set();
    for (const rawT of data.threads) {
      const id = String(rawT.id || rawT.threadId || '');
      if (rawT.archived) state.archivedThreadIds.add(id);
      if (!id || state.archivedThreadIds.has(id)) continue;
      nextIds.add(id);
      state.threadsMap.set(id, normalizeThread(rawT, state.threadsMap.get(id)));
    }
    // 单会话快照以服务端返回集合为准，清除不再属于该会话的残留线程
    for (const existingId of Array.from(state.threadsMap.keys())) {
      if (!nextIds.has(existingId)) state.threadsMap.delete(existingId);
    }
  }

  if (Array.isArray(data.activeRuns)) {
    for (const run of data.activeRuns) {
      const tid = String(run.threadId || '');
      if (tid && state.threadsMap.has(tid)) {
        const t = state.threadsMap.get(tid);
        t.activeRunId = String(run.id || run.runId || t.activeRunId || '');
        if (run.status) t.status = normalizeStatus(run.status);
        if (run.startedAt) t.startedAt = Number(run.startedAt);
      }
    }
  }

  if (Array.isArray(data.pendingRequests)) {
    state.pendingRequests.clear();
    for (const r of data.pendingRequests) {
      const nr = normalizeRuntimeRequest(r);
      if (nr && nr.status === 'pending') state.pendingRequests.set(nr.id, nr);
    }
  }

  if (Array.isArray(data.worktrees)) {
    state.worktrees = data.worktrees.map((w, i) => normalizeWorktree(w, i)).filter(Boolean);
  }

  if (Array.isArray(data.boardMessages)) {
    state.boardMessages = data.boardMessages.map((m, i) => normalizeBoardMessage(m, i)).filter(Boolean);
    state.boardSig = typeof data.boardSig === 'string' ? data.boardSig : '';
  }
  if (Array.isArray(data.collaborationEdges)) {
    state.collaborationEdges = data.collaborationEdges.map((e) => normalizeCollaborationEdge(e)).filter(Boolean);
  }
}

/**
 * 实时通道调度器：
 * - 宿主内嵌模式 (IS_EMBEDDED_HOST === true)：严禁创建 EventSource，强制走非重叠增量轮询 (250ms 活跃 / 1200ms 空闲)！
 * - 独立浏览器模式：优先连接相对路径 SSE `api/stream`，异常自动降级到轮询。
 */
export function connectRealtimeStream() {
  if (isEmbeddedHost()) {
    if (state.sse) {
      try { state.sse.close(); } catch {}
      state.sse = null;
    }
    startFallbackPolling(250);
    return;
  }

  if (!getEffectiveConversationId()) {
    if (state.bootstrapLoaded) state.connMode = 'unbound';
    scheduleRender();
    state.sse?.close();
    state.sse = null;
    stopPolling();
    return;
  }
  if (typeof EventSource === 'undefined') {
    startFallbackPolling(250);
    return;
  }

  stopPolling();
  if (state.sse) {
    try { state.sse.close(); } catch {}
    state.sse = null;
  }

  const qs = new URLSearchParams({ sinceSeq: String(state.latestSeq || 0) });
  const convId = getEffectiveConversationId();
  qs.set('conversationId', convId);
  if (state.workspace) qs.set('workspace', state.workspace);

  try {
    const es = new EventSource(`api/stream?${qs.toString()}`);
    state.sse = es;

    const openGuard = setTimeout(() => {
      if (state.sse !== es) return;
      if (es.readyState !== 1 && state.connMode !== 'sse') {
        try { es.close(); } catch {}
        if (state.sse === es) state.sse = null;
        startFallbackPolling(250);
      }
    }, 2800);

    es.onopen = () => {
      clearTimeout(openGuard);
      if (state.sse !== es) return;
      const recovered = !state.bootstrapLoaded || state.connMode === 'offline';
      state.connMode = 'sse';
      stopPolling();
      scheduleRender();
      if (recovered) void recoverBootstrap();
    };

    const onFrame = (e) => {
      if (!e?.data || state.sse !== es || convId !== getEffectiveConversationId()) return;
      try {
        const parsed = JSON.parse(e.data);
        state.connMode = 'sse';
        ingestStreamPayload(parsed);
      } catch {
        // 忽略非 JSON 心跳帧
      }
    };

    es.addEventListener('orch', onFrame);
    es.onmessage = onFrame;

    es.onerror = () => {
      clearTimeout(openGuard);
      if (state.sse !== es) return;
      try { es.close(); } catch {}
      if (state.sse === es) state.sse = null;
      startFallbackPolling(250);
      scheduleSseReconnect();
    };
  } catch {
    startFallbackPolling(250);
  }
}

function scheduleSseReconnect() {
  if (isEmbeddedHost()) return;
  clearTimeout(state.sseReconnectTimer);
  state.sseReconnectTimer = setTimeout(() => {
    if (!state.sse && !isEmbeddedHost()) connectRealtimeStream();
  }, 12000);
}

function stopPolling() {
  clearTimeout(state.pollTimer);
  state.pollTimer = null;
}

function startFallbackPolling(initialDelayMs = 250) {
  if (state.sse) return;
  state.connMode = 'poll';
  scheduleRender();
  scheduleNextPoll(initialDelayMs);
}

function scheduleNextPoll(delayMs) {
  if (state.sse) return;
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(async () => {
    if (state.sse || state.pollInFlight) return;
    state.pollInFlight = true;
    let nextDelay = hasAnyActiveRun() ? 250 : 1200;
    try {
      // 每次轮询检测宿主会话 ID 是否发生切换（仅比对真实 sidecar 锁定 ID；网页 URL 参数不参与，避免锁死手动切换）
      const liveHostConv = getHostConversationId();
      if (isEmbeddedHost() && liveHostConv !== state.activeConversationId) {
        state.pollInFlight = false;
        await resetForConversation(liveHostConv);
        if (!state.sse) scheduleNextPoll(250);
        return;
      }
      const convId = getEffectiveConversationId();
      if (!convId) return;
      const epoch = state.conversationEpoch;
      const res = await httpGetJson('api/events', {
        sinceSeq: state.latestSeq,
        conversationId: convId || undefined,
        workspace: !convId ? state.workspace || undefined : undefined,
        // 看板水位回传：后端签名未变时省略 boardMessages / collaborationEdges 大数组（boardUnchanged: true）
        boardSig: state.boardSig || undefined,
      });
      if (epoch !== state.conversationEpoch || convId !== getEffectiveConversationId() || state.sse) return;
      const recovered = !state.bootstrapLoaded || state.connMode === 'offline';
      state.connMode = 'poll';
      ingestStreamPayload(res);
      nextDelay = (res?.hasActiveRuns ?? hasAnyActiveRun()) ? 250 : 1200;
      // 首屏 Bootstrap 失败后轮询首次拉通，或刚从离线恢复：立即幂等补拉一次完整快照
      if (recovered) void recoverBootstrap();
    } catch {
      const wasOnline = state.connMode === 'sse' || state.connMode === 'poll';
      state.connMode = 'offline';
      if (wasOnline && !isEmbeddedHost()) {
        showToast('与编排守护进程的连接已断开；若后台守护进程刚升级重启，请从插件侧栏重新复制访问链接', 'error');
      }
      nextDelay = 2000;
      scheduleRender();
    } finally {
      state.pollInFlight = false;
      if (!state.sse) scheduleNextPoll(nextDelay);
    }
  }, delayMs);
}

/** 全局「新对话默认模式」：defaultOrchestrationMode 优先（simple → relay、custom:* → complex），旧版仅有布尔开关时 true→relay / false→direct。 */
function applyDefaultModeSettings(src) {
  if (!src || typeof src !== 'object') return false;
  let mode = null;
  if (typeof src.defaultOrchestrationMode === 'string' && src.defaultOrchestrationMode) mode = normalizeModeId(src.defaultOrchestrationMode);
  else if (typeof src.defaultDispatchEnabled === 'boolean') mode = src.defaultDispatchEnabled ? 'relay' : 'direct';
  if (!mode) return false;
  state.defaultOrchestrationMode = mode;
  state.defaultDispatchEnabled = mode !== 'direct';
  state.conversationPolicy.defaultOrchestrationMode = mode;
  state.conversationPolicy.defaultDispatchEnabled = mode !== 'direct';
  return true;
}
/** 当前对话尚未显式设置模式（source=default）时跟随全局默认。 */
function followDefaultModeIfUnset() {
  if (state.conversationPolicy.source !== 'default') return;
  state.conversationPolicy.orchestrationMode = state.defaultOrchestrationMode;
  state.conversationPolicy.dispatchEnabled = state.defaultOrchestrationMode !== 'direct';
}

export function applyConversationPolicyPayload(rawPolicy) {
  if (!rawPolicy || typeof rawPolicy !== 'object') return;
  applyDefaultModeSettings(rawPolicy);
  const prev = state.conversationPolicy;
  // orchestrationMode 为唯一事实源（旧值 simple / custom:* 无感归一）；仅收到旧版布尔开关时兼容映射（true 保持当前非直出模式，否则 relay）
  let mode;
  if (typeof rawPolicy.orchestrationMode === 'string' && rawPolicy.orchestrationMode) mode = normalizeModeId(rawPolicy.orchestrationMode);
  else if (typeof rawPolicy.dispatchEnabled === 'boolean') {
    const prevMode = normalizeModeId(prev.orchestrationMode);
    mode = rawPolicy.dispatchEnabled ? (prevMode !== 'direct' ? prevMode : 'relay') : 'direct';
  } else mode = normalizeModeId(prev.orchestrationMode);
  if (mode !== 'direct') state.lastNonDirectMode = mode;
  state.conversationPolicy = {
    conversationId: String(rawPolicy.conversationId || rawPolicy.rootConversationId || prev.conversationId || ''),
    rootConversationId: String(rawPolicy.rootConversationId || rawPolicy.conversationId || prev.rootConversationId || ''),
    orchestrationMode: mode,
    dispatchEnabled: mode !== 'direct',
    defaultOrchestrationMode: state.defaultOrchestrationMode,
    defaultDispatchEnabled: state.defaultDispatchEnabled,
    policyRevision: Number(rawPolicy.policyRevision ?? prev.policyRevision ?? 0),
    source: String(rawPolicy.source || prev.source || 'default'),
    runningCount: Number(rawPolicy.runningCount ?? prev.runningCount ?? 0),
    queuedCount: Number(rawPolicy.queuedCount ?? prev.queuedCount ?? 0),
    updatedAt: rawPolicy.updatedAt ?? prev.updatedAt ?? null,
  };
}

export function isConversationDispatchEnabled() {
  return currentOrchestrationMode() !== 'direct';
}

export const UNBOUND_CONVERSATION_HINT = '请先在顶栏选择要查看的宿主对话（或从 IDE 插件侧栏复制链接）';

export function ensureDispatchAllowedInteractive() {
  if (state.conversationUnbound) {
    showToast(`尚未绑定对话：${UNBOUND_CONVERSATION_HINT}`, 'error');
    return false;
  }
  if (isConversationDispatchEnabled()) return true;
  showToast('当前对话处于 ⚡ 直出模式（子 Agent 派发已关闭），请先点击顶栏模式胶囊切换为「简单模式」或「复杂自定义」后再派单', 'error');
  return false;
}

let threadDigestRefreshInFlight = false;

export function reconcileThreadDigest(threadDigest) {
  if (!Array.isArray(threadDigest)) return;
  let missingThread = false;
  for (const digest of threadDigest) {
    const id = String(digest?.id || '');
    if (!id || state.archivedThreadIds.has(id)) continue;
    const thread = state.threadsMap.get(id);
    if (!thread) {
      missingThread = true;
      continue;
    }
    if (digest.status) thread.status = normalizeStatus(digest.status);
    thread.startedAt = Number(digest.startedAt || 0);
    thread.completedAt = digest.completedAt == null ? null : Number(digest.completedAt);
    thread.durationMs = Number(digest.durationMs || 0);
    thread.updatedAt = Number(digest.updatedAt || 0);
    if (digest.title !== undefined) thread.title = String(digest.title || '');
    if (digest.usage && typeof digest.usage === 'object') thread.usage = { ...thread.usage, ...digest.usage };
    if (digest.usageReported !== undefined) thread.usageReported = Boolean(digest.usageReported);
    if (digest.cumulativeUsage && typeof digest.cumulativeUsage === 'object') thread.cumulativeUsage = { ...digest.cumulativeUsage };
    if (Object.hasOwn(digest, 'currentRun')) {
      thread.currentRun = normalizeThread({ id, currentRun: digest.currentRun }, thread).currentRun;
    }
    if (digest.orderCount !== undefined) thread.orderCount = Math.max(0, Number(digest.orderCount) || 0);
  }
  if (missingThread) requestMissingThreadsRefresh();
}

// Single-flight backfill of member cards whose birth event was missed (polling digest and pure-SSE swarm snapshots).
function requestMissingThreadsRefresh() {
  if (threadDigestRefreshInFlight) return;
  threadDigestRefreshInFlight = true;
  void refreshThreadsList().finally(() => {
    threadDigestRefreshInFlight = false;
  });
}

let swarmBoardRefreshInFlight = false;
// Target watermark announced by slim swarm_snapshot signals; reset on conversation switch.
let pendingSwarmBoardHead = 0;
let pendingSwarmBoardCount = -1;

export function resetSwarmBoardWatermark() {
  pendingSwarmBoardHead = 0;
  pendingSwarmBoardCount = -1;
  resetBoardWindowState();
}

// Only native blackboard posts count: orchestrator dispatch/result cards use seq = maxSeq + 1 and would mask new posts.
function nativeBoardWatermark() {
  let head = 0;
  let count = 0;
  for (const m of state.boardMessages) {
    if (m?.source && m.source !== 'native-swarm') continue;
    count++;
    head = Math.max(head, Number(m?.seq || 0));
  }
  return { head, count };
}

function swarmBoardBehindTarget() {
  const { head, count } = nativeBoardWatermark();
  return head < pendingSwarmBoardHead || (pendingSwarmBoardCount >= 0 && count !== pendingSwarmBoardCount);
}

function refreshSwarmBoardFromEvents() {
  if (swarmBoardRefreshInFlight) return;
  const curRoot = state.rootConversationId || state.activeConversationId || getEffectiveConversationId();
  if (!curRoot) return;
  const epoch = state.conversationEpoch;
  const requestedHead = pendingSwarmBoardHead;
  const requestedCount = pendingSwarmBoardCount;
  swarmBoardRefreshInFlight = true;
  void httpGetJson('api/events', { sinceSeq: state.latestSeq, limit: 1, conversationId: curRoot })
    .then((data) => {
      if (epoch !== state.conversationEpoch || curRoot !== (state.rootConversationId || state.activeConversationId || getEffectiveConversationId())) return;
      if (Array.isArray(data?.boardMessages)) {
        state.boardMessages = data.boardMessages.map((m, i) => normalizeBoardMessage(m, i)).filter(Boolean);
        state.boardSig = typeof data.boardSig === 'string' ? data.boardSig : '';
      }
      if (Array.isArray(data?.collaborationEdges)) {
        state.collaborationEdges = data.collaborationEdges.map((e) => normalizeCollaborationEdge(e)).filter(Boolean);
      }
      scheduleRender();
    })
    .catch(() => {})
    .finally(() => {
      swarmBoardRefreshInFlight = false;
      // A newer target that arrived while this request was in flight gets exactly one trailing catch-up; an unchanged
      // target never re-requests, so a server board that cannot match the announced count cannot loop.
      const targetMoved = pendingSwarmBoardHead !== requestedHead || pendingSwarmBoardCount !== requestedCount;
      if (targetMoved && epoch === state.conversationEpoch && state.connMode === 'sse' && swarmBoardBehindTarget()) {
        refreshSwarmBoardFromEvents();
      }
    });
}

export function ingestStreamPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  const root = state.rootConversationId || getEffectiveConversationId();
  if (Array.isArray(payload.events) && payload.rootConversationId && root && payload.rootConversationId.toLowerCase() !== root.toLowerCase()) return;
  checkAssetUpdate(payload.frontendAssetHash);
  // 配置类单事件（settings_updated / project_config_updated）交由 applySingleEvent 按作用域过滤后吸收，不在此处无条件合并
  const singleType = String(payload.type || payload.event || '');
  if ((payload.presets || payload.settings) && !CONFIG_STREAM_EVENT_TYPES.has(singleType)) mergeRemotePresets(payload);
  const cursor = payload.nextSeq ?? payload.latestSeq;
  if (typeof cursor === 'number') state.latestSeq = Math.max(cursor, state.latestSeq);
  if (typeof payload.seq === 'number' && payload.seq > state.latestSeq) {
    state.latestSeq = payload.seq;
  }

  if (payload.snapshot && typeof payload.snapshot === 'object') {
    applyBootstrapSnapshot(payload.snapshot, { fromStream: true });
  }
  // 未绑定对话期间只吸收全局配置与游标，会话级看板 / 策略 / 告警一律忽略
  const sessionBound = !state.conversationUnbound;
  if (sessionBound) {
    if (typeof payload.projectName === 'string' || payload.projectName === null) state.projectName = payload.projectName?.trim() || '';
    if (typeof payload.conversationTitle === 'string' && payload.conversationTitle.trim()) {
      state.conversationTitle = payload.conversationTitle.trim();
    }
  }
  if (sessionBound && Array.isArray(payload.boardMessages)) {
    state.boardMessages = payload.boardMessages.map((m, i) => normalizeBoardMessage(m, i)).filter(Boolean);
    state.boardSig = typeof payload.boardSig === 'string' ? payload.boardSig : '';
  } else if (sessionBound && payload.boardUnchanged === true && typeof payload.boardSig === 'string') {
    // 看板未变：保留现有 boardMessages / collaborationEdges，仅同步水位签名
    state.boardSig = payload.boardSig;
  }
  if (sessionBound && Array.isArray(payload.collaborationEdges)) {
    state.collaborationEdges = payload.collaborationEdges.map((e) => normalizeCollaborationEdge(e)).filter(Boolean);
  }

  if (Array.isArray(payload.events)) {
    for (const evt of payload.events) {
      applySingleEvent(evt);
    }
  } else if (payload.type || payload.event) {
    applySingleEvent(payload);
  }
  if (!singleType) applySessionAndUpdatePayload(payload);
  if (sessionBound) reconcileThreadDigest(payload.threadDigest);

  // The poll snapshot is newer than the history page it accompanies.
  if (sessionBound && (Array.isArray(payload.events) || !payload.type && !payload.event)) {
    if (payload.conversationPolicy && typeof payload.conversationPolicy === 'object') {
      applyConversationPolicyPayload(payload.conversationPolicy);
    }
    if (payload.activeMode && typeof payload.activeMode === 'object') applyActiveModePayload(payload.activeMode);
    if (Array.isArray(payload.healthIncidents)) {
      // 迟到的在途快照可能仍含刚被忽略的告警：统一经 dismissedIncidentIds 过滤，杜绝横幅闪回
      state.healthIncidents = acceptOpenIncidents(payload.healthIncidents);
    }
  }

  recomputeScopedStats();
  hydrateMissingTimelines();
  scheduleRender();
}

const GLOBAL_STREAM_EVENT_TYPES = new Set(['settings_updated', 'settings.updated', 'providers_updated', 'project_config_updated', 'spec_curation_updated', 'system_update_changed', 'connected', 'heartbeat']);
const CONFIG_STREAM_EVENT_TYPES = new Set(['settings_updated', 'settings.updated', 'providers_updated', 'project_config_updated']);

function applySingleEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  if (typeof evt.seq === 'number' && evt.seq > state.latestSeq) {
    state.latestSeq = evt.seq;
  }

  const type = String(evt.type || evt.event || '');
  const data = evt.payload && typeof evt.payload === 'object' ? { ...evt, ...evt.payload } : evt;
  if (type === 'system_update_changed') {
    applySessionAndUpdatePayload(data);
    return;
  }
  if (type === 'spec_curation_updated') {
    applySpecCurationPayload(data.curation || data.specCuration);
    return;
  }
  const threadId = String(data.threadId || data.thread?.id || data.id || '');

  // 会话前置防串台：未绑定时忽略一切会话事件；已绑定时丢弃显式属于其他根会话的迟到事件
  if (!GLOBAL_STREAM_EVENT_TYPES.has(type)) {
    const evtRoot = String(data.rootConversationId || data.swarm?.rootConversationId || '').trim();
    const curRoot = state.rootConversationId || state.activeConversationId || getHostConversationId();
    if (state.conversationUnbound || (evtRoot && curRoot && evtRoot.toLowerCase() !== curRoot.toLowerCase())) {
      // 其他会话的策略事件仅用于同步全局「新对话默认」，绝不改动当前对话模式
      if (type === 'conversation_policy_updated' && data.conversationPolicy) {
        applyDefaultModeSettings(data.conversationPolicy);
        if (!state.conversationUnbound) followDefaultModeIfUnset();
      }
      return;
    }
  }

  if (data.workCounts && data.rootConversationId === state.conversationPolicy.rootConversationId) {
    Object.assign(state.conversationPolicy, { runningCount: data.workCounts.runningCount, queuedCount: data.workCounts.queuedCount });
  }
  if (type === 'swarm_snapshot' || type === 'swarm.snapshot') {
    const sw = data.swarm || data;
    const evtRoot = String(sw.rootConversationId || data.rootConversationId || '');
    const curRoot = state.rootConversationId || state.activeConversationId;
    if (evtRoot && curRoot && evtRoot.toLowerCase() !== curRoot.toLowerCase()) return;
    const msgs = Array.isArray(sw.messages) ? sw.messages : Array.isArray(data.boardMessages) ? data.boardMessages : null;
    const edges = Array.isArray(sw.edges) ? sw.edges : Array.isArray(data.collaborationEdges) ? data.collaborationEdges : null;
    if (msgs) {
      state.boardMessages = msgs.map((m, i) => normalizeBoardMessage(m, i)).filter(Boolean);
      // 原生快照只含黑板帖、不含编排汇总帖：作废签名，下一次轮询强制拉回完整看板
      state.boardSig = '';
    }
    if (edges) state.collaborationEdges = edges.map((e) => normalizeCollaborationEdge(e)).filter(Boolean);
    if (!msgs && state.connMode === 'sse') {
      pendingSwarmBoardHead = Math.max(pendingSwarmBoardHead, Number(sw.head || 0));
      if (sw.messageCount != null) pendingSwarmBoardCount = Number(sw.messageCount) || 0;
      if (swarmBoardBehindTarget()) refreshSwarmBoardFromEvents();
    }
    const members = Array.isArray(sw.members) ? sw.members : [];
    const missingMember = members.some((m) => {
      if (!m || m.killed || !m.conversation_id) return false;
      const id = `thr_native_${m.conversation_id}`;
      return !state.threadsMap.has(id) && !state.archivedThreadIds.has(id);
    });
    if (missingMember) requestMissingThreadsRefresh();
    return;
  }

  if (type === 'thread_deleted' || type === 'thread.deleted' || type === 'thread_archived' || type === 'thread.archived' ||
      (['thread_updated','thread.updated'].includes(type) && (data.thread || data).archived === true)) {
    const removedIds = new Set();
    if (threadId) removedIds.add(threadId);
    if (Array.isArray(data.deletedIds)) {
      for (const did of data.deletedIds) removedIds.add(String(did));
    }
    const keepBoard = Boolean(data.keepBoardHistory || data.thread?.meta?.keepBoardHistory);
    if (!keepBoard) {
      state.boardMessages = state.boardMessages.filter((m) => !removedIds.has(String(m.threadId || '')));
      state.boardSig = '';
    }
    for (const rid of removedIds) {
      state.archivedThreadIds.add(rid);
      state.threadsMap.delete(rid);
      for (const [reqId, req] of state.pendingRequests.entries()) {
        if (req.threadId === rid) state.pendingRequests.delete(reqId);
      }
      if (state.selectedThreadId === rid) state.selectedThreadId = '';
      if (state.detailDrawerThreadId === rid) closeMemberDrawer();
    }
    syncActiveTargetThread();
    return;
  }

  if (threadId && state.archivedThreadIds.has(threadId)) return;
  if (type === 'thread_created' || type === 'thread.created' || type === 'thread_updated' || type === 'thread.updated') {
    const rawT = data.thread || data;
    const tid = String(rawT.id || rawT.threadId || threadId);
    if (tid) {
      if (rawT.archived) {
        state.threadsMap.delete(tid);
      } else {
        const updated = normalizeThread(rawT, state.threadsMap.get(tid));
        state.threadsMap.set(tid, updated);
        syncActiveTargetThread();
      }
    }
    return;
  }

  if (type === 'conversation_policy_updated') {
    const evtRoot = String(data.rootConversationId || data.conversationPolicy?.rootConversationId || '');
    const curRoot = state.rootConversationId || state.activeConversationId || getHostConversationId();
    if (data.conversationPolicy) applyDefaultModeSettings(data.conversationPolicy);
    if (!evtRoot || !curRoot || evtRoot.toLowerCase() === curRoot.toLowerCase()) {
      if (data.conversationPolicy) applyConversationPolicyPayload(data.conversationPolicy);
      if (data.activeMode && typeof data.activeMode === 'object') applyActiveModePayload(data.activeMode);
    } else {
      followDefaultModeIfUnset();
    }
    return;
  }

  if (type === 'health_incident') {
    const evtRoot = String(data.rootConversationId || data.incident?.rootConversationId || '');
    const curRoot = state.rootConversationId || state.activeConversationId || getHostConversationId();
    if (evtRoot && curRoot && evtRoot.toLowerCase() !== curRoot.toLowerCase()) return;
    if (data.thread && typeof data.thread === 'object') {
      const tid = String(data.thread.id || data.threadId || '');
      if (tid && !data.thread.archived) {
        state.threadsMap.set(tid, normalizeThread(data.thread, state.threadsMap.get(tid)));
      }
    }
    if (Array.isArray(data.incidents)) {
      state.healthIncidents = acceptOpenIncidents(data.incidents);
    } else if (data.incident && data.incident.id) {
      const inc = data.incident;
      const rest = state.healthIncidents.filter((x) => x.id !== inc.id);
      state.healthIncidents = acceptOpenIncidents([inc]).length ? [inc, ...rest] : rest;
    }
    return;
  }

  // 看门狗自愈：疑似卡顿回合重新收到实质活动 → 后端 resolve 软告警并广播，横幅与成员黄色徽标同步消失
  if (type === 'health_incident_resolved') {
    const evtRoot = String(data.rootConversationId || data.incident?.rootConversationId || '');
    const curRoot = state.rootConversationId || state.activeConversationId || getHostConversationId();
    if (evtRoot && curRoot && evtRoot.toLowerCase() !== curRoot.toLowerCase()) return;
    const resolvedId = String(data.incidentId || data.incident?.id || '');
    if (resolvedId) state.healthIncidents = state.healthIncidents.filter((x) => x.id !== resolvedId);
    if (data.thread && typeof data.thread === 'object') upsertLocalThread(data.thread);
    return;
  }

  if (type === 'settings_updated' || type === 'settings.updated' || type === 'providers_updated') {
    if (applyDefaultModeSettings(data.settings)) followDefaultModeIfUnset();
    if (data.customProviders === undefined && Array.isArray(data.settings?.customProviders)) data.customProviders = data.settings.customProviders;
    if (data.customProviders !== undefined || data.extensionTemplates !== undefined) {
      const normExt = normalizeExtensionList(
        data.extensionTemplates || state.extensionTemplates,
        data.customProviders || state.customProviders
      );
      state.extensionTemplates = normExt.templates;
      state.customProviders = normExt.customProviders;
    }
    state.providers = normalizeProvidersCatalog(data.providers || state.providers, state.customProviders);
    // v0.3.0：全局事件只携带全局默认模板；当前项目已独立定制阵容时只吸收全局摘要，绝不覆盖本项目成员池
    const cfg = currentProjectConfig();
    const skipRoster = Boolean(state.projectConfig?.rosterCustomized);
    const incomingGlobalRev = data.globalTemplate?.presetRevision ?? data.presetRevision ?? data.settings?.presetRevision;
    const prevGlobalRev = state.globalTemplate?.presetRevision ?? -1;
    const global = { ...data, projectConfig: undefined, settings: data.settings ? { ...data.settings, projectConfig: undefined } : undefined };
    if (!skipRoster && cfg?.workspace && typeof incomingGlobalRev === 'number' && incomingGlobalRev >= prevGlobalRev && incomingGlobalRev < state.serverPresetRevision) {
      global.presetRevision = state.serverPresetRevision;
    }
    mergeRemotePresets(global, { skipRoster });
    applySessionAndUpdatePayload(global);
    const nextDefaultSpec = data.settings?.defaultSpecEnabled ?? data.defaultSpecEnabled;
    if (typeof nextDefaultSpec === 'boolean') syncCurrentProjectSpecFromGlobal(null, nextDefaultSpec);
    syncComposerSelects();
    return;
  }

  // v0.3.0 项目级阵容更新（按 workspace 过滤）：仅当事件属于当前有效项目时吸收，杜绝跨项目串台
  if (type === 'project_config_updated') {
    const cfg = data.projectConfig && typeof data.projectConfig === 'object' ? data.projectConfig : {};
    const evtKey = String(data.projectKey || cfg.projectKey || '') || projectPathKey(data.workspace || cfg.workspace || '');
    if (state.conversationUnbound || !evtKey || evtKey !== currentProjectKey()) return;
    mergeRemotePresets(data.projectConfig ? data : { ...data, projectConfig: { workspace: data.workspace, projectKey: evtKey, rosterSource: 'project', rosterCustomized: true, rosterRevision: data.presetRevision } });
    applySessionAndUpdatePayload(data);
    syncComposerSelects();
    return;
  }

  if (type === 'worktree_updated' || type === 'worktree.updated' || type === 'worktree_created') {
    // P2-2：清理（或合入后顺带清理）事件只携带路径，必须移除而不是按路径伪造一条「幽灵」Worktree
    const cleanedPath = data.cleaned ? data.worktreePath || data.path : data.result?.cleanedUp ? data.result.worktreePath : '';
    if (cleanedPath) {
      removeLocalWorktreeByPath(cleanedPath);
      return;
    }
    if (data.integrated && !data.worktree) return;
    const nw = normalizeWorktree(data.worktree || data);
    if (nw && (data.worktree || data.worktreeId || data.id || data.path || data.worktreePath)) {
      const idx = state.worktrees.findIndex((w) => w.id === nw.id || (nw.path && w.path === nw.path));
      if (idx >= 0) state.worktrees[idx] = { ...state.worktrees[idx], ...nw };
      else state.worktrees.unshift(nw);
    }
    return;
  }

  if (
    type === 'runtime_request' ||
    type === 'approval.requested' ||
    type === 'permission_request' ||
    type === 'question_request'
  ) {
    const req = normalizeRuntimeRequest(data.request || data);
    if (req) {
      if (req.status === 'pending') state.pendingRequests.set(req.id, req);
      else state.pendingRequests.delete(req.id);
      if (req.threadId && state.threadsMap.has(req.threadId)) {
        const t = state.threadsMap.get(req.threadId);
        if (req.status === 'pending') t.status = req.kind === 'question' ? 'waiting_input' : 'pending_approval';
      }
    }
    return;
  }

  if (type === 'runtime_request_resolved' || type === 'request_resolved') {
    const rid = String(data.requestId || data.id || '');
    const req = state.pendingRequests.get(rid);
    state.pendingRequests.delete(rid);
    const tid = threadId || req?.threadId || '';
    if (tid && state.threadsMap.has(tid)) {
      const t = state.threadsMap.get(tid);
      if (t.status === 'pending_approval' || t.status === 'waiting_input') t.status = 'running';
    }
    return;
  }

  if (!threadId) return;
  if (!state.threadsMap.has(threadId)) {
    state.threadsMap.set(
      threadId,
      normalizeThread({
        id: threadId,
        title: data.title || '任务线程',
        provider: data.provider || 'kimi-code',
        isNativeHost: data.isNativeHost,
        workspace: data.workspace || state.workspace || '',
        projectRoot: data.projectRoot || '',
        status: 'running',
      })
    );
  }
  const isRunStart = type === 'run_started' || type === 'turn.started' || type === 'turn_started';
  const isRunFinish = type === 'run_completed' || type === 'run_updated' || type === 'turn.completed' || type === 'turn_completed';
  // P0-4：回合开始 / 结束事件携带最新线程快照（健康态、摘要、cancelCapability），先完整合并再叠加增量字段
  const snapshotThread = (isRunStart || isRunFinish) && data.thread && typeof data.thread === 'object' &&
    String(data.thread.id || data.thread.threadId || threadId) === threadId ? data.thread : null;
  if (snapshotThread) upsertLocalThread(snapshotThread);
  const thread = state.threadsMap.get(threadId);
  if (!thread || thread.archived) return;
  thread.updatedAt = Date.now();

  if (type === 'session_bound' || type === 'session.bound') {
    if (data.isNativeHost) thread.isNativeHost = true;
    if (data.nativeSessionId || data.sessionId) {
      thread.nativeSessionId = String(data.nativeSessionId || data.sessionId);
      if (thread.isNativeHost && !thread.hostConversationId) {
        thread.hostConversationId = thread.nativeSessionId;
      }
    }
  } else if (type === 'title_updated' || type === 'title.updated') {
    if (data.title) thread.title = String(data.title);
  } else if (type === 'queue_updated' || type === 'queue.updated') {
    if (Array.isArray(data.queue)) {
      thread.queue = data.queue.map((q, i) => normalizeQueueItem(q, i)).filter(Boolean);
    }
  } else if (isRunStart) {
    const runId = String(data.runId || thread.activeRunId || '');
    const inputIntent = String(data.inputIntent || data.run?.inputIntent || data.run?.meta?.inputIntent || '');
    thread.status = 'running';
    thread.startedAt = Number(data.startedAt || Date.now());
    thread.completedAt = null;
    thread.error = '';
    if (!snapshotThread) thread.cancelCapability = '';
    if (data.runId) {
      const trk = state.interruptTracker.get(threadId);
      if (trk?.runId && trk.runId !== runId) clearInterruptTracker(threadId);
      thread.activeRunId = runId;
    }
    const continuation = ['steer', 'steering_restart', 'follow_up', 'continue', 'chat'].includes(inputIntent);
    const keepsSessionUsage = continuation && (
      (!data.runId && inputIntent === 'steer') ||
      (thread.provider === 'codex' && Boolean(thread.nativeSessionId))
    );
    const runTitle = continuation
      ? String(thread.currentRun?.title || data.title || data.run?.meta?.title || thread.title || '')
      : String(data.title || data.run?.meta?.title || data.run?.title || thread.title || '');
    const runTaskId = continuation
      ? String(thread.currentRun?.taskId || data.taskId || data.run?.meta?.taskId || thread.taskId || '')
      : String(data.taskId || data.run?.taskId || data.run?.meta?.taskId || thread.taskId || '');
    const runCreatedAt = Number(data.createdAt || data.run?.createdAt || (continuation ? thread.currentRun?.createdAt : 0) || thread.startedAt);
    if (!keepsSessionUsage) {
      thread.usageReported = false;
      if (!continuation) thread.summary = '';
      thread.usage = { inputTokens: 0, cachedTokens: 0, reasoningTokens: 0, outputTokens: 0, totalTokens: 0, contextUsed: 0, contextLimit: 0 };
    }
    thread.currentRun = {
      id: runId,
      status: 'running',
      inputIntent,
      title: runTitle,
      taskId: runTaskId,
      usage: { ...thread.usage },
      usageReported: keepsSessionUsage ? Boolean(thread.usageReported) : false,
      startedAt: thread.startedAt,
      completedAt: null,
      createdAt: runCreatedAt,
    };
    if (runId) {
      const existed = (thread.recentRuns || []).some((r) => String(r.id || r.runId) === runId);
      thread.recentRuns = [
        ...(thread.recentRuns || []).filter((r) => String(r.id || r.runId) !== runId),
        { id: runId, status: 'running', inputIntent, createdAt: runCreatedAt, startedAt: thread.startedAt, meta: { title: runTitle, taskId: runTaskId, inputIntent } },
      ];
      if (!existed && (!continuation || !(thread.orderCount > 0))) {
        thread.orderCount = Math.max(1, Number(thread.orderCount || 0) + (continuation ? 0 : 1));
      }
    }
    if (data.userMessage || data.prompt) {
      const msgText = String(data.userMessage || data.prompt);
      const lastUser = [...thread.items].reverse().find((i) => i.type === 'user_message');
      if (!lastUser || lastUser.text !== msgText) {
        thread.items.push(
          normalizeTurnItem({
            id: data.userMessageId || `u_${Date.now()}`,
            type: 'user_message',
            text: msgText,
            runId,
            inputIntent,
            createdAt: Date.now(),
          })
        );
      }
    }
    state.boardNeedsAutoScroll = true;
  } else if (type === 'reasoning_delta' || type === 'reasoning.delta') {
    if (!thread.isSwarmMember) thread.status = 'running';
    const delta = String(data.delta ?? data.textDelta ?? data.text ?? '');
    if (!delta) return;
    const curRunId = String(data.runId || thread.activeRunId || '');
    const itemId = String(data.itemId || `rs_${curRunId || 'live'}`);
    let rsItem = thread.items.find((it) => it.id === itemId && it.type === 'reasoning');
    if (!rsItem) {
      rsItem = [...thread.items].reverse().find((it) => it.type === 'reasoning' && it.status === 'running' && (!it.runId || !curRunId || it.runId === curRunId));
    }
    if (!rsItem) {
      rsItem = normalizeTurnItem({
        id: itemId,
        type: 'reasoning',
        status: 'running',
        runId: curRunId,
        text: delta,
        createdAt: Date.now(),
      });
      thread.items.push(rsItem);
    } else {
      rsItem.runId ||= curRunId;
      rsItem.text = (rsItem.text || '') + delta;
      rsItem.status = 'running';
    }
  } else if (type === 'message_delta' || type === 'message.delta') {
    if (!thread.isSwarmMember) thread.status = 'running';
    const delta = String(data.delta ?? data.textDelta ?? data.text ?? '');
    if (!delta) return;
    finishActiveReasoningItems(thread);
    const curRunId = String(data.runId || thread.activeRunId || '');
    const itemId = String(data.itemId || `msg_${curRunId || 'live'}`);
    let msgItem = thread.items.find((it) => it.id === itemId && it.type === 'assistant_message');
    if (!msgItem) {
      msgItem = [...thread.items].reverse().find((it) => it.type === 'assistant_message' && it.status === 'running' && (!it.runId || !curRunId || it.runId === curRunId));
    }
    if (!msgItem) {
      msgItem = normalizeTurnItem({
        id: itemId,
        type: 'assistant_message',
        status: 'running',
        runId: curRunId,
        text: delta,
        createdAt: Date.now(),
      });
      thread.items.push(msgItem);
    } else {
      msgItem.runId ||= curRunId;
      msgItem.text = (msgItem.text || '') + delta;
    }
    state.boardNeedsAutoScroll = true;
  } else if (
    type === 'tool_call' ||
    type === 'tool.started' ||
    type === 'tool.delta' ||
    type === 'tool.completed'
  ) {
    finishActiveReasoningItems(thread);
    const curRunId = String(data.runId || thread.activeRunId || '');
    const tcId = String(data.toolCallId || data.itemId || data.id || `tc_${thread.items.length}`);
    const idx = thread.items.findIndex((it) => it.id === tcId);
    const incoming = normalizeTurnItem({ ...data, id: tcId, runId: curRunId, type: data.type === 'tool_call' ? 'tool_call' : data.kind || 'tool_call' });
    if (idx >= 0) {
      const prev = thread.items[idx];
      const mergedOutput = data.outputDelta
        ? (prev.output || '') + String(data.outputDelta)
        : incoming.output || prev.output || '';
      thread.items[idx] = {
        ...prev,
        ...incoming,
        title: incoming.title || prev.title,
        command: incoming.command || prev.command,
        filePath: incoming.filePath || prev.filePath,
        output: mergedOutput,
        diff: incoming.diff || prev.diff,
        additions: incoming.additions || prev.additions,
        deletions: incoming.deletions || prev.deletions,
        exitCode: incoming.exitCode !== null ? incoming.exitCode : prev.exitCode,
        createdAt: prev.createdAt,
      };
    } else if (incoming) {
      thread.items.push(incoming);
    }
  } else if (type === 'todo_list' || type === 'plan.updated') {
    const entries = data.entries || data.todos || [];
    const curRunId = String(data.runId || thread.activeRunId || '');
    const planId = `plan_${curRunId || 'cur'}`;
    const idx = thread.items.findIndex((it) => it.id === planId);
    const item = normalizeTurnItem({ id: planId, type: 'todo_list', runId: curRunId, entries, createdAt: Date.now() });
    if (idx >= 0) thread.items[idx] = item;
    else thread.items.push(item);
  } else if (type === 'usage_updated' || type === 'usage.updated') {
    const previousUsage = { ...(thread.currentRun?.usage || thread.usage) };
    const u = data.usage || data;
    if (u.inputTokens !== undefined) thread.usage.inputTokens = Number(u.inputTokens);
    if (u.cachedTokens !== undefined || u.cachedInputTokens !== undefined || u.cachedReadTokens !== undefined) {
      thread.usage.cachedTokens = Number(u.cachedTokens ?? u.cachedInputTokens ?? u.cachedReadTokens);
    }
    if (u.reasoningTokens !== undefined || u.thoughtTokens !== undefined) {
      thread.usage.reasoningTokens = Number(u.reasoningTokens ?? u.thoughtTokens);
    }
    if (u.outputTokens !== undefined) thread.usage.outputTokens = Number(u.outputTokens);
    if (u.totalTokens !== undefined) {
      thread.usage.totalTokens = Number(u.totalTokens);
    } else {
      thread.usage.totalTokens = thread.usage.inputTokens + thread.usage.outputTokens + thread.usage.reasoningTokens;
    }
    if (u.used !== undefined || u.contextUsed !== undefined) {
      thread.usage.contextUsed = Number(u.contextUsed ?? u.used);
    }
    if (u.size !== undefined || u.contextLimit !== undefined || u.modelContextWindow !== undefined) {
      thread.usage.contextLimit = Number(u.contextLimit ?? u.modelContextWindow ?? u.size);
    }
    thread.usageReported = true;
    const curRunId = String(data.runId || thread.activeRunId || thread.currentRun?.id || '');
    thread.currentRun = {
      ...(thread.currentRun || {}),
      id: curRunId,
      status: 'running',
      inputIntent: String(thread.currentRun?.inputIntent || data.inputIntent || ''),
      title: String(thread.currentRun?.title || thread.title || ''),
      taskId: String(thread.currentRun?.taskId || thread.taskId || ''),
      usage: { ...thread.usage },
      usageReported: true,
      startedAt: Number(thread.currentRun?.startedAt || thread.startedAt || 0),
      completedAt: null,
      createdAt: Number(thread.currentRun?.createdAt || thread.startedAt || 0),
    };
    const cumulative = { ...(thread.cumulativeUsage || {}) };
    for (const key of ['inputTokens', 'cachedTokens', 'reasoningTokens', 'outputTokens', 'totalTokens']) {
      const delta = Math.max(0, Number(thread.usage[key] || 0) - Number(previousUsage[key] || 0));
      cumulative[key] = Math.max(Number(cumulative[key] || 0), Number(cumulative[key] || 0) + delta);
    }
    cumulative.contextUsed = Math.max(Number(cumulative.contextUsed || 0), Number(thread.usage.contextUsed || 0));
    cumulative.contextLimit = Math.max(Number(cumulative.contextLimit || 0), Number(thread.usage.contextLimit || 0));
    thread.cumulativeUsage = cumulative;
  } else if (type === 'error' || type === 'run_failed') {
    const errMsg = String(data.error || data.message || '执行发生异常');
    if (!data.toolCallId) thread.error = errMsg;
    if (type === 'run_failed') thread.status = 'failed';
    thread.items.push(
      normalizeTurnItem({
        id: `err_${Date.now()}`,
        runId: data.runId || thread.activeRunId, toolCallId: data.toolCallId, status: 'failed',
        type: 'error',
        error: errMsg,
        createdAt: Date.now(),
      })
    );
    state.boardNeedsAutoScroll = true;
  } else if (isRunFinish) {
    finishActiveReasoningItems(thread);
    for (const it of thread.items) {
      if (it.status === 'running') {
        it.status = 'completed';
        it.completedAt = Date.now();
      }
    }
    const finishedRunId = String(data.runId || thread.activeRunId || '');
    const movedOn = snapshotThread && snapshotThread.activeRunId && data.runId && String(snapshotThread.activeRunId) !== String(data.runId);
    if (data.runId) {
      const runUsage = data.run?.usage || data.usage || (!movedOn && thread.currentRun?.id === finishedRunId ? thread.usage : undefined);
      thread.recentRuns = [...(thread.recentRuns || []).filter(r => String(r.id || r.runId) !== finishedRunId),
        {
          id: finishedRunId,
          status: data.run?.status || data.status || 'completed',
          error: data.run?.error || data.error,
          meta: data.run?.meta || data.meta || undefined,
          createdAt: Number(data.run?.createdAt || data.createdAt || thread.currentRun?.createdAt || thread.startedAt || 0),
          startedAt: Number(data.run?.startedAt || data.startedAt || thread.currentRun?.startedAt || thread.startedAt || 0),
          completedAt: data.run?.completedAt || data.completedAt || Date.now(),
          inputIntent: String(data.run?.inputIntent || data.run?.meta?.inputIntent || data.inputIntent || thread.currentRun?.inputIntent || ''),
          usage: runUsage ? { ...runUsage } : undefined,
          usageReported: Boolean(data.run?.usageReported ?? data.usageReported ?? (!movedOn && thread.currentRun?.id === finishedRunId ? thread.usageReported : runUsage?.totalTokens > 0)),
        }];
    }
    if (type !== 'run_updated') thread.error = data.run?.error || data.error || '';
    // 快照显示线程已切入下一回合（排队续跑 / steering_restart）时，以快照状态为准，不被旧回合终态覆盖
    if (movedOn) thread.status = normalizeStatus(snapshotThread.status || thread.status);
    else if (data.status) thread.status = normalizeStatus(data.status);
    else if (type !== 'run_updated') thread.status = 'completed';
    if (!isStatusActive(thread.status)) {
      thread.completedAt = Date.now();
      thread.durationMs = Math.max(0, thread.completedAt - (thread.startedAt || thread.createdAt));
      clearInterruptTracker(threadId);
    }
    if (!movedOn && thread.currentRun?.id === finishedRunId) {
      thread.currentRun.status = normalizeStatus(thread.status);
      thread.currentRun.completedAt = thread.completedAt || Date.now();
      thread.currentRun.usage = { ...thread.usage };
      thread.currentRun.usageReported = Boolean(thread.usageReported);
    }
    if (data.assistantText && !thread.items.some((i) => i.type === 'assistant_message' && i.runId === finishedRunId && String(i.text || '').trim())) {
      thread.items.push(
        normalizeTurnItem({
          id: `final_${Date.now()}`,
          type: 'assistant_message',
          status: 'completed',
          runId: finishedRunId,
          text: String(data.assistantText),
          createdAt: Date.now(),
        })
      );
    }
    if (data.summary) thread.summary = String(data.summary);
    state.boardNeedsAutoScroll = true;
  } else if (type === 'turn_item' || type === 'item_added' || type === 'item_updated') {
    const norm = normalizeTurnItem(data.item || data);
    if (norm) {
      const idx = thread.items.findIndex((x) => x.id === norm.id);
      if (idx >= 0) thread.items[idx] = { ...thread.items[idx], ...norm };
      else thread.items.push(norm);
    }
  }
}

function finishActiveReasoningItems(thread) {
  const now = Date.now();
  for (const it of thread.items) {
    if (it.type === 'reasoning' && it.status === 'running') {
      it.status = 'completed';
      it.completedAt = now;
      it.durationMs = Math.max(0, now - it.createdAt);
    }
  }
}

export function hasAnyActiveRun() {
  for (const t of state.threadsMap.values()) {
    if (!t.archived && isStatusActive(t.status)) return true;
  }
  return false;
}

/* ========================================================================
 * 8. 核心业务交互：单会话切换重置、归档删除、Composer、工作流
 * ======================================================================== */
export async function resetForConversation(nextConvId) {
  state.conversationEpoch++;
  state.archivedThreadIds.clear();
  state.hydratingThreadIds = new Set();
  state.manualTarget = false;
  resetBoardFollow();
  state.activeConversationId = String(nextConvId || '');
  state.conversationUnbound = !state.activeConversationId;
  state.rootConversationId = '';
  state.projectName = '';
  state.conversationTitle = '';
  if (!isEmbeddedHost()) {
    // 独立网页端切会话：旧会话工作区与按工作区缓存的运行缓存 / 项目规范一并作废，待新 Bootstrap 下发 data.workspace 后按需重拉
    state.workspace = '';
    state.projectConfig = null;
    Object.assign(state.runtimeCache, { loadedForWorkspace: '', data: null, lastResult: null, error: '' });
    Object.assign(state.projectSpecs, { loadedForWorkspace: '', data: null, error: '', openKey: '', bodies: {}, bodyLoading: '', bodyError: '' });
    resetSpecCurationClientState();
    syncStandaloneUrl();
  } else if (state.conversationUnbound) {
    resetSpecCurationClientState();
  }
  state.threadsMap.clear();
  state.boardMessages = [];
  state.collaborationEdges = [];
  resetSwarmBoardWatermark();
  state.worktrees = [];
  state.pendingRequests.clear();
  state.healthIncidents = [];
  state.dismissedIncidentIds.clear();
  state.conversationPolicy = {
    conversationId: String(nextConvId || ''),
    rootConversationId: String(nextConvId || ''),
    orchestrationMode: state.defaultOrchestrationMode,
    dispatchEnabled: state.defaultOrchestrationMode !== 'direct',
    defaultOrchestrationMode: state.defaultOrchestrationMode,
    defaultDispatchEnabled: state.defaultDispatchEnabled,
    policyRevision: 0,
    source: 'default',
    runningCount: 0,
    queuedCount: 0,
    updatedAt: null,
  };
  state.activeMode = null;
  state.modeSwitching = null;
  state.modePopoverOpen = false;
  state.latestSeq = 0;
  state.selectedThreadId = '';
  state.detailDrawerThreadId = '';
  state.drawerLastThreadId = '';
  state.boardMemberFilters.clear();
  state.expandedTraces.clear();
  state.expandedToolIds.clear();
  state.expandedBodies.clear();
  state.expandedPrompts.clear();
  state.selectedWorktreeId = '';
  state.selectedDiffFile = '';
  state.currentWorktreeDiff = null;
  state.batchDrafts = [];
  state.retryContext = null;
  for (const id of ['dispatch-drawer-backdrop', 'retry-modal-backdrop', 'council-modal-backdrop', 'review-modal-backdrop']) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = true;
  }
  for (const id of ['comp-prompt-input', 'disp-prompt', 'disp-title', 'review-focus-input', 'council-topic-input']) {
    const input = document.getElementById(id);
    if (input) input.value = '';
  }
  const cmBd = document.getElementById('custom-model-modal-backdrop');
  if (cmBd) cmBd.hidden = true;
  state.customModelPrompt = null;
  closeMemberDrawer();
  recomputeScopedStats();
  scheduleRender();
  try {
    await loadBootstrap();
  } catch { /* Reconnect below to recover from a transient bootstrap failure. */ }
  finally {
    if (getEffectiveConversationId() === nextConvId) connectRealtimeStream();
  }
}

export async function hydrateThreadDetails(threadId) {
  if (!threadId || state.hydratingThreadIds.has(threadId)) return;
  const pending = state.hydratingThreadIds;
  const convId = getEffectiveConversationId();
  if (!convId) return;
  pending.add(threadId);
  try {
    const res = await rpcCall('readThread', { threadId, includeItems: true, includeQueue: true, tail: true });
    if (pending !== state.hydratingThreadIds || convId !== getEffectiveConversationId()) return;
    const rawT = res?.thread || res;
    if (rawT && typeof rawT === 'object') {
      if (rawT.archived) state.archivedThreadIds.add(threadId);
      if (state.archivedThreadIds.has(threadId)) {
        state.threadsMap.delete(threadId);
      } else {
        const prev = state.threadsMap.get(threadId);
        const merged = normalizeThread({ ...rawT, ...(Array.isArray(res?.items) ? { items: res.items } : {}), id: threadId }, prev);
        merged.recentRuns = res.recentRuns || prev?.recentRuns || [];
        merged.hydrated = true;
        state.threadsMap.set(threadId, merged);
      }
      if (state.activeView === 'board' && state.boardFollow && !state.boardUserScrolledUp) state.boardNeedsAutoScroll = true;
      recomputeScopedStats();
      scheduleRender();
    }
  } catch {
    if (pending !== state.hydratingThreadIds || convId !== getEffectiveConversationId()) return;
    const t = state.threadsMap.get(threadId);
    if (t) t.hydrated = true;
  } finally {
    pending.delete(threadId);
  }
}

const hydratingOrderRunKeys = new Set();

export async function hydrateOrderRunItems(threadId, runId) {
  const convId = getEffectiveConversationId();
  const runIds = String(runId || '').split(',').map((id) => id.trim()).filter(Boolean);
  const key = `${convId}:${threadId}:${runIds.join(',')}`;
  if (!convId || !threadId || !runIds.length || hydratingOrderRunKeys.has(key)) return;
  hydratingOrderRunKeys.add(key);
  try {
    const responses = await Promise.all(runIds.map((rid) => rpcCall('readThread', { threadId, includeItems: true, runId: rid })));
    if (convId !== getEffectiveConversationId()) return;
    const thread = state.threadsMap.get(threadId);
    if (!thread) return;
    const merged = new Map(thread.items.map((item) => [item.id, item]));
    for (const res of responses) {
      const incoming = (Array.isArray(res?.items) ? res.items : Array.isArray(res?.thread?.items) ? res.thread.items : [])
        .map((item, index) => normalizeTurnItem(item, index)).filter(Boolean);
      for (const item of incoming) merged.set(item.id, { ...merged.get(item.id), ...item });
    }
    thread.items = [...merged.values()].sort((a, b) => Number(a.createdAt || 0) - Number(b.createdAt || 0));
    scheduleRender();
  } catch (err) {
    showToast(`历史工单轨迹补拉失败：${err.message}`, 'error');
  } finally {
    hydratingOrderRunKeys.delete(key);
  }
}

function hydrateMissingTimelines() {
  const scopedThreads = getScopedThreads();
  const covered = new Set(state.boardMessages.map((message) => message.threadId));
  const emptyBoard = isConversationCollaborationEmpty(scopedThreads, state.boardMessages);
  let fallbackCount = 0;
  for (const t of scopedThreads) {
    if (t.hydrated || state.hydratingThreadIds.has(t.id)) continue;
    if (t.id === state.detailDrawerThreadId || isStatusActive(t.status) || isStatusPendingIntervention(t)) {
      void hydrateThreadDetails(t.id);
    } else if (!emptyBoard && fallbackCount < 4 && !covered.has(t.id) && !t.summary && !t.isSwarmMember && !t.meta?.isSwarmMember) {
      fallbackCount++;
      void hydrateThreadDetails(t.id);
    }
  }
}

export function closeMemberDrawer() {
  state.detailDrawerThreadId = '';
  const bd = document.getElementById('member-drawer-backdrop');
  if (bd) bd.hidden = true;
}

export function acceptOpenIncidents(list) {
  return (Array.isArray(list) ? list : []).filter(
    (inc) => inc && (inc.status === 'open' || !inc.status) && !state.dismissedIncidentIds.has(String(inc.id || ''))
  );
}

export function clearInterruptTracker(threadId) {
  const t = state.interruptTracker.get(threadId);
  if (t?.timer) clearTimeout(t.timer);
  state.interruptTracker.delete(threadId);
}

export async function refreshThreadsList() {
  try {
    const convId = getEffectiveConversationId();
    if (!convId) return;
    const epoch = state.conversationEpoch;
    const res = await rpcCall('listThreads', { conversationId: convId || undefined, includeSubagents: true, limit: 500 });
    if (epoch !== state.conversationEpoch || convId !== getEffectiveConversationId()) return;
    const list = Array.isArray(res) ? res : res?.threads || [];
    for (const rawT of list) {
      const id = String(rawT.id || rawT.threadId || '');
      if (rawT.archived) state.archivedThreadIds.add(id);
      if (!id || state.archivedThreadIds.has(id)) continue;
      state.threadsMap.set(id, normalizeThread(rawT, state.threadsMap.get(id)));
    }
    recomputeScopedStats();
    syncActiveTargetThread();
    hydrateMissingTimelines();
    scheduleRender();
  } catch {}
}

export function removeLocalWorktreeByPath(rawPath) {
  const key = projectPathKey(rawPath);
  if (!key) return;
  const removed = state.worktrees.filter((w) => projectPathKey(w.path) === key || w.id === rawPath);
  if (!removed.length) return;
  const removedIds = new Set(removed.map((w) => w.id));
  state.worktrees = state.worktrees.filter((w) => !removedIds.has(w.id));
  if (removedIds.has(state.selectedWorktreeId)) {
    state.worktreeDiffSeq++; // 作废在途 Diff 请求
    state.selectedWorktreeId = '';
    state.selectedDiffFile = '';
    state.currentWorktreeDiff = null;
    state.loadingDiff = false;
  }
}

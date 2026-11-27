import { classifyEngineError } from './engines/proc-utils.mjs';

const activity = new Set([
  'assistant_delta', 'message_delta', 'reasoning_delta', 'tool_call', 'tool_result',
  'command_output_delta', 'file_change', 'todo_list', 'session_bound', 'title_updated', 'usage_update', 'usage_updated', 'status_change',
  'heartbeat',
]);
// Substantive progress that clears a soft `suspected_stall` warning (automatic recovery loop).
const recoveryEvents = new Set([
  'reasoning_delta', 'message_delta', 'assistant_delta', 'tool_call', 'tool_result', 'heartbeat', 'usage_updated', 'usage_update',
]);
const toolStartStatuses = new Set(['in_progress', 'inprogress', 'running', 'pending', 'started']);
const toolEndStatuses = new Set([
  'completed', 'failed', 'error', 'errored', 'rejected', 'declined', 'cancelled', 'canceled', 'aborted', 'resolved', 'succeeded', 'success', 'done',
]);
const toolEvents = new Set(['tool_call', 'tool_result', 'command_output_delta', 'file_change']);
const waiting = phase => phase === 'waiting_approval' || phase === 'waiting_input';
const normalize = value => {
  if (typeof value === 'string') return value.trim().replace(/\s+/g, ' ');
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]));
  }
  return value ?? '';
};

export function createWatchdog({
  now = Date.now, softStallMs = 180_000, hardStallMs = 420_000,
  // A long-running tool (build, test suite, install) is not model silence: widen the window while one is in flight.
  toolSoftStallMs = 360_000, toolHardStallMs = 1_800_000,
  // Claude Code streams nothing while it thinks between tool calls; give pure reasoning a wider window.
  reasoningSoftStallMs = 300_000, reasoningHardStallMs = 900_000, wideReasoningProviders = ['claude-code'],
  maxTransientRetries = 2, baseRetryDelayMs = 1500, maxIdenticalFailures = 3,
  pollIntervalMs = Math.max(1, Math.min(1000, softStallMs || 1, hardStallMs || 1)),
  onSignal = () => {}, onStallRecovered = () => {},
} = {}) {
  const runs = new Map();
  let timer;

  function signal(state, kind, detail) {
    if (kind !== 'suspected_stall') state.terminated = true;
    onSignal(state, { kind, detail });
  }

  function limitsFor(state) {
    if (state.inFlightTools.size) {
      return { soft: Math.max(softStallMs, toolSoftStallMs), hard: Math.max(hardStallMs, toolHardStallMs), tools: true };
    }
    if (wideReasoningProviders.includes(state.provider)) {
      return { soft: Math.max(softStallMs, reasoningSoftStallMs), hard: Math.max(hardStallMs, reasoningHardStallMs), tools: false };
    }
    return { soft: softStallMs, hard: hardStallMs, tools: false };
  }

  function tick() {
    for (const state of runs.values()) {
      if (!state.managed || waiting(state.phase) || state.terminated) continue;
      const elapsed = now() - state.lastEventAt;
      const limits = limitsFor(state);
      if (elapsed >= limits.soft && !state.warned) {
        state.warned = true;
        signal(state, 'suspected_stall', limits.tools
          ? '外部子任务的工具调用已长时间未返回结果。'
          : '外部子任务已长时间未收到引擎事件。');
      }
      if (elapsed >= limits.hard) {
        signal(state, 'stall_terminated', limits.tools
          ? '外部子任务的工具调用持续无响应，已超过硬兜底时限并自动终止本轮。'
          : '外部子任务持续无响应，已自动终止本轮。');
      }
    }
  }

  function start({ runId, threadId = '', provider = '', startedAt = now(), transientRetryCount = 0, managed = true }) {
    const state = {
      runId, threadId, provider: String(provider || ''), startedAt, lastEventAt: startedAt, phase: 'starting', managed,
      hasSideEffects: false, transientRetryCount, consecutiveFailureCount: 0,
      lastFailureFingerprint: '', items: new Map(), inFlightTools: new Set(), warned: false, terminated: false,
    };
    runs.set(runId, state);
    if (!timer) {
      timer = setInterval(tick, pollIntervalMs);
      timer.unref?.();
    }
    return state;
  }

  function stop(runId) {
    const state = runs.get(runId);
    runs.delete(runId);
    if (!runs.size) {
      clearInterval(timer);
      timer = undefined;
    }
    return state;
  }

  function phase(runId, next, requestPending = false) {
    const state = runs.get(runId);
    if (!state) return;
    state.requestPending = requestPending;
    if (state.phase === next) return;
    state.phase = next;
    state.lastEventAt = now();
  }

  function observe(runId, event) {
    const state = runs.get(runId);
    if (!state || !state.managed || state.terminated) return;
    if (activity.has(event.type)) {
      state.lastEventAt = now();
      if (state.phase === 'starting') state.phase = 'running';
    }
    trackInFlightTool(state, event);
    if (state.warned && recoveryEvents.has(event.type)) {
      state.warned = false;
      try { onStallRecovered(state, { runId, threadId: state.threadId, eventType: event.type }); } catch {}
    }
    if (event.type === 'status_change') {
      const next = event.phase || event.status;
      if (!state.requestPending && (waiting(next) || next === 'running' || next === 'starting')) phase(runId, next);
    }
    if (event.type === 'error') {
      state.error = classifyEngineError({ message: event.error || event.message, ...event });
      if (['quota_exhausted', 'rate_limit_transient'].includes(event.category) && state.error.category !== 'quota_exhausted') {
        state.error = { ...state.error, category: event.category, isRetryable: event.category === 'rate_limit_transient' };
      }
    }
    if (!toolEvents.has(event.type)) return;
    const id = event.toolCallId || event.itemId || event.id;
    const previous = state.items.get(id);
    const name = event.toolName || event.name || previous?.name || event.title || event.type;
    const kind = event.kind && event.kind !== 'other' ? event.kind : previous?.kind || '';
    const input = event.rawInput ?? event.input ?? previous?.input;
    const readOnly = event.readOnly === true || /^(read|search|inspect|list|view|glob|grep)$/i.test(kind) ||
      /^(read|search|list|view|glob|grep)(?:[_ -](?:file|files|directory|dir|text|code|resources|resource|web|url))?$/i.test(name);
    const explicitMutation = event.diff || event.type === 'file_change' || event.type === 'command_output_delta' ||
      /edit|write|patch|delete|move|execute|command|shell|terminal|notebook/i.test(kind + ' ' + name);
    if (explicitMutation || (!readOnly && (event.type === 'tool_call' || event.type === 'tool_result'))) state.hasSideEffects = true;
    if (!id || previous?.done) return;
    const seen = { name, kind, input, done: false };
    state.items.set(id, seen);
    if (event.outputDelta !== undefined && !event.status && event.exitCode == null) return;
    const status = String(event.status || '').toLowerCase();
    const failed = ['failed', 'error', 'errored', 'rejected'].includes(status) ||
      (event.exitCode != null && Number(event.exitCode) !== 0) || event.isError === true;
    const completed = failed || toolEndStatuses.has(status) ||
      (event.type === 'tool_result' && (!status || status === 'resolved'));
    if (!completed) return;
    seen.done = true;
    if (!failed) {
      state.lastFailureFingerprint = '';
      state.consecutiveFailureCount = 0;
      return;
    }
    const error = event.error ?? event.rawOutput ?? event.output ?? event.exitCode ?? status;
    const head = typeof error === 'string' ? error.trim().split(/\r?\n/, 1)[0] : JSON.stringify(normalize(error));
    const fingerprint = JSON.stringify([normalize(name), normalize(input), normalize(head).slice(0, 300)]);
    state.consecutiveFailureCount = fingerprint === state.lastFailureFingerprint ? state.consecutiveFailureCount + 1 : 1;
    state.lastFailureFingerprint = fingerprint;
    if (state.consecutiveFailureCount >= maxIdenticalFailures) {
      signal(state, 'doom_loop', '检测到连续 ' + maxIdenticalFailures + ' 次相同工具调用失败死循环，已自动熔断止损');
    }
  }

  function trackInFlightTool(state, event) {
    if (event.type !== 'tool_call' && event.type !== 'tool_result') return;
    const id = event.toolCallId || event.itemId || event.id;
    if (!id) return;
    const status = String(event.status || '').toLowerCase();
    if (event.type === 'tool_result' || toolEndStatuses.has(status) || event.isError === true ||
        (event.exitCode != null && event.outputDelta === undefined)) state.inFlightTools.delete(id);
    else if (!state.items.get(id)?.done && (toolStartStatuses.has(status) || !status)) state.inFlightTools.add(id);
  }

  function retryDelay(state, failure, canDispatch) {
    if (!state?.managed || state.terminated || state.hasSideEffects || !canDispatch ||
        failure.category !== 'rate_limit_transient' || state.transientRetryCount >= maxTransientRetries) return null;
    return Math.min(2 ** 31 - 1, failure.retryAfterMs ?? baseRetryDelayMs * 2 ** state.transientRetryCount);
  }

  const inspect = runId => {
    const state = runs.get(runId);
    return state && { warned: state.warned, terminated: state.terminated, phase: state.phase,
      inFlightTools: [...state.inFlightTools], limits: limitsFor(state) };
  };

  return { start, stop, phase, observe, retryDelay, inspect, close() {
    for (const id of runs.keys()) stop(id);
  } };
}

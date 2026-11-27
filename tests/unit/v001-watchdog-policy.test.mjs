import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createOrchestrator } from '../../core/orchestrator.mjs';
import { classifyEngineError } from '../../core/engines/proc-utils.mjs';
import { createWatchdog } from '../../core/watchdog.mjs';
import { withProjectSandbox } from '../helpers/sandbox.mjs';
import { offlineCatalog, project } from '../helpers/fixtures.mjs';

function fixture(name, action, watchdogOptions) {
  return withProjectSandbox(name, async dir => {
    const cwd = project(dir, 'workspace');
    const wake = [];
    const o = createOrchestrator({
      dataDir: path.join(dir, 'control'), defaultStudioRoot: cwd, catalogLoader: offlineCatalog,
      watchdogOptions, hostWakeSender: async alert => { wake.push(alert); return { ok: true }; },
    });
    o.db.saveSettings({ defaultOrchestrationMode: 'complex' });
    try {
      await action(o, { cwd, conversationId: 'root-a', presetKey: 'executor_codex' }, wake);
    } finally { await o.shutdown(); }
  });
}

function deferredHandle() {
  let resolve;
  let cancels = 0;
  const result = new Promise(r => { resolve = r; });
  return {
    result, resolve, get cancels() { return cancels; },
    async cancel() { cancels++; resolve({ status: 'interrupted' }); },
    async forceKill() { return this.cancel(); },
    async respondPermission() {},
  };
}
const completed = { status: 'completed', assistantText: '完成' };
const transient = { status: 'failed', error: 'HTTP 429 Too Many Requests' };
const tickUntil = async (check, message) => {
  const deadline = Date.now() + 2000;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), message);
};

test('错误分类区分硬性额度并保留 Retry-After', () => {
  assert.deepEqual(classifyEngineError('HTTP 429; Retry-After: 2'), {
    category: 'rate_limit_transient', isRetryable: true, retryAfterMs: 2000,
  });
  assert.deepEqual(classifyEngineError('HTTP 429 insufficient_quota'), { category: 'quota_exhausted', isRetryable: false });
  assert.equal(classifyEngineError({ code: 'ECONNRESET' }).isRetryable, true);
  assert.equal(classifyEngineError('HTTP 503 overloaded').isRetryable, true);
});

test('会话策略隔离，派发入口零副作用，关闭后冻结队列并可取消活跃回合', () => fixture('v001-policy', async (o, ctx) => {
  const handles = [];
  o.engineManager.runTurn = () => { const h = deferredHandle(); handles.push(h); return h; };
  const alpha = ctx.conversationId;
  const beta = 'root-b';
  const active = await o.delegateTask({ ...ctx, task: 'active' });
  assert.equal(o.getConversationPolicy({ conversationId: alpha }).source, 'latched');
  const queued = await o.sendToThread({ threadId: active.threadId, message: 'queued', mode: 'queue' });
  assert.equal(queued.action, 'queued');
  const disabled = await o.setConversationPolicy({ conversationId: alpha, workspace: ctx.cwd, dispatchEnabled: false, defaultDispatchEnabled: false });
  assert.equal(disabled.conversationPolicy.runningCount, 1);
  assert.equal(disabled.conversationPolicy.queuedCount, 1);
  assert.equal(disabled.conversationPolicy.policyRevision, 2);
  assert.equal(o.getConversationPolicy({ conversationId: beta, workspace: ctx.cwd }).dispatchEnabled, false);
  await o.setConversationPolicy({ conversationId: beta, workspace: ctx.cwd, dispatchEnabled: true });
  const scope = { ...ctx, threadId: active.threadId };
  const baseline = o.db.listThreads().length;
  for (const promise of [
    o.delegateTask({ ...ctx, task: 'bypass', isolation: 'worktree', clientRequestId: 'must-not-claim' }),
    o.delegateParallelBatch({ ...ctx, tasks: [{ task: 'bypass' }] }), o.launchThread(ctx),
    o.runCodeReview(ctx), o.sendToThread({ ...scope, message: 'bypass' }),
    o.sendToThread({ threadId: active.threadId, conversationId: beta, message: 'bypass' }),
    o.retryRun(scope), o.manageQueue({ ...scope, action: 'enqueue' }),
    o.manageQueue({ ...scope, action: 'promote_to_steer' }),
  ]) {
    const res = await promise;
    assert.equal(res.mode, 'host_direct_only');
    assert.equal(res.bypassed, true);
    assert.match(res.instruction, /请勿重试/);
  }
  assert.equal(o.db.listThreads().length, baseline);
  assert.equal(o.db.getCommandReceipt('must-not-claim', 'delegateTask'), null);
  assert.equal(handles.length, 1);
  assert.equal((await o.listWorktrees({ workspace: ctx.cwd })).worktrees.length, 0);
  handles[0].resolve(completed);
  await tickUntil(() => o.db.getRun(active.runId)?.status === 'completed', 'current run finishes');
  assert.equal(handles.length, 1);
  assert.equal(o.db.getRun(queued.queuedRunId).status, 'queued');
  await o.setConversationPolicy({ conversationId: alpha, dispatchEnabled: true });
  assert.equal(handles.length, 2);
  const other = await o.delegateTask({ ...ctx, conversationId: beta, task: 'unrelated' });
  const stopped = await o.setConversationPolicy({ conversationId: alpha, dispatchEnabled: false, cancelRunning: true });
  assert.equal(stopped.cancelledCount, 1);
  assert.equal(handles[1].cancels, 1);
  assert.equal(handles[2].cancels, 0);
  assert.equal(o.db.getRun(other.runId).status, 'running');
  handles[2].resolve(completed);
  await tickUntil(() => o.db.getRun(other.runId)?.status === 'completed', 'unrelated run finishes');
  const view = await o.getEvents({ conversationId: alpha, workspace: ctx.cwd });
  assert.equal(view.conversationPolicy.dispatchEnabled, false);
  assert.deepEqual(view.healthIncidents, []);
}));

test('无需 Token 的 429 退避在同一任务原地重跑，关闭策略阻止退避中的重试', () => fixture('v001-retry', async (o, ctx, wake) => {
  const turns = [];
  o.engineManager.runTurn = opts => {
    turns.push(opts);
    const result = turns.length === 2 ? completed : turns.length === 3 ? { ...transient, retryAfterMs: 750 } : transient;
    return { cancel: async () => {}, result: Promise.resolve(result) };
  };
  const res = await o.delegateTask({ ...ctx, task: 'retry', mode: 'wait' });
  assert.equal(res.status, 'completed');
  assert.equal(res.summary, '完成');
  assert.equal(turns.length, 2);
  assert.equal(turns[0].threadId, turns[1].threadId);
  assert.equal(turns[0].runId, turns[1].runId);
  assert.equal(o.db.getThread(res.threadId).meta.health.state, 'healthy');
  let { incidents } = await o.listHealthIncidents({ conversationId: ctx.conversationId, includeResolved: true });
  assert.equal(incidents[0].actionTaken, 'auto_retry_scheduled');
  assert.equal(incidents[0].status, 'resolved');
  assert.equal(wake.length, 0);
  const next = await o.delegateTask({ ...ctx, task: 'disable during retry' });
  await tickUntil(() => o.db.getThread(next.threadId).meta.health.state === 'transient_retry');
  await o.setConversationPolicy({ conversationId: ctx.conversationId, dispatchEnabled: false });
  await tickUntil(() => o.db.getRun(next.runId).status === 'failed');
  assert.equal(turns.length, 3);
}, { baseRetryDelayMs: 20 }));

test('已写文件不自动重放，后台错误单次唤醒，后续成功清理告警', () => fixture('v001-wake', async (o, ctx, wake) => {
  let count = 0;
  o.engineManager.runTurn = ({ onEvent }) => {
    if (++count === 1) {
      onEvent({ type: 'file_change', itemId: 'write-1', status: 'completed' });
      onEvent({ type: 'error', error: '429 overloaded' });
      onEvent({ type: 'error', error: '429 overloaded' });
    }
    return { cancel: async () => {}, result: Promise.resolve(count === 1 ? transient : completed) };
  };
  const res = await o.delegateTask({ ...ctx, task: 'write' });
  await tickUntil(() => wake.length === 1);
  assert.equal(count, 1);
  assert.equal(wake[0].conversationId, ctx.conversationId);
  const alerts = await o.listHealthIncidents({ conversationId: ctx.conversationId });
  assert.equal(alerts.incidents.length, 1);
  assert.equal(alerts.incidents[0].kind, 'fatal_error');
  assert.ok(alerts.incidents[0].notifiedAt);
  await o.sendToThread({ threadId: res.threadId, message: 'recover', wait: true });
  assert.equal(o.db.getThread(res.threadId).meta.health.state, 'healthy');
  assert.equal((await o.listHealthIncidents({ conversationId: ctx.conversationId })).incidents.length, 0);
  assert.equal(wake.length, 1);
}));

test('审批等待期间暂停，恢复后先告警再终止，健康恢复和关闭告警可查询', () => fixture('v001-stall', async (o, ctx, wake) => {
  let opts, handle;
  o.engineManager.runTurn = input => { opts = input; return handle = deferredHandle(); };
  const task = await o.delegateTask({ ...ctx, task: 'stall' });
  opts.onPermissionRequest({ requestId: 'approval' });
  opts.onEvent({ type: 'status_change', status: 'running' });
  await delay(120);
  assert.equal(o.db.getRun(task.runId).status, 'waiting_approval');
  assert.equal(handle.cancels, 0);
  assert.deepEqual((await o.listHealthIncidents(ctx)).incidents, []);
  await o.respondRuntimeRequest({ requestId: 'approval', decision: 'approve' });
  await tickUntil(() => o.db.getThread(task.threadId).meta.health?.state === 'suspected_stall');
  assert.equal(handle.cancels, 0);
  await tickUntil(() => wake.length === 1);
  assert.equal(handle.cancels, 1);
  assert.equal(o.db.getRun(task.runId).status, 'failed');
  const open = (await o.listHealthIncidents(ctx)).incidents;
  // v0.0.3: the terminal state closes the soft warning; only the explicit hard-timeout alert stays open.
  assert.deepEqual(new Set(open.map(i => i.kind)), new Set(['stall_terminated']));
  const all = (await o.listHealthIncidents({ ...ctx, includeResolved: true })).incidents;
  assert.equal(all.find(i => i.kind === 'suspected_stall')?.status, 'resolved');
  const terminalIncident = open.find(i => i.kind === 'stall_terminated');
  assert.equal((await o.dismissHealthIncident({ conversationId: 'another', incidentId: terminalIncident.id })).dismissedCount, 0);
  assert.equal((await o.dismissHealthIncident({ ...ctx, incidentId: terminalIncident.id })).dismissedCount, 1);
  await o.sendToThread({ threadId: task.threadId, message: 'recover' });
  handle.resolve(completed);
  await tickUntil(() => o.db.getThread(task.threadId).meta.health.state === 'healthy');
  assert.deepEqual((await o.listHealthIncidents(ctx)).incidents, []);
}, { softStallMs: 35, hardStallMs: 95, pollIntervalMs: 5 }));

test('以完结工具项去重，成功项清空连续失败，再遇三次同指纹才熔断', () => fixture('v001-doom', async (o, ctx, wake) => {
  let opts;
  const h = deferredHandle();
  o.engineManager.runTurn = input => { opts = input; return h; };
  const task = await o.delegateTask({ ...ctx, task: 'loop' });
  const fail = (toolCallId, input) => opts.onEvent({
    type: 'tool_call', toolCallId, toolName: 'read_file', kind: 'read', status: 'failed',
    input, output: 'not found\nmore detail',
  });
  for (let i = 0; i < 4; i++) fail('one', { path: 'foo', line: 1 });
  fail('two', { line: 1, path: ' foo ' });
  opts.onEvent({ type: 'tool_result', toolCallId: 'ok', name: 'read_file', status: 'completed' });
  fail('three', { line: 1, path: 'foo' });
  fail('four', { path: 'foo', line: 1 });
  await delay(5);
  assert.equal(h.cancels, 0);
  fail('five', { path: 'foo', line: 1 });
  await tickUntil(() => wake.length === 1);
  assert.equal(h.cancels, 1);
  assert.match(o.db.getRun(task.runId).error, /检测到连续 3 次相同工具调用失败死循环/);
  assert.equal((await o.listHealthIncidents(ctx)).incidents[0].kind, 'doom_loop');
}));

test('硬性额度耗尽不重放，同步等待任务不唤醒', () => fixture('v001-quota', async (o, ctx, wake) => {
  let count = 0;
  o.engineManager.runTurn = () => {
    count++;
    return { cancel: async () => {}, result: Promise.resolve({
      status: 'failed', error: 'HTTP 429: insufficient_quota',
    }) };
  };
  const run = await o.delegateTask({ ...ctx, task: 'quota', mode: 'wait' });
  assert.equal(run.status, 'failed');
  assert.equal(count, 1);
  assert.deepEqual(wake, []);
  const [incident] = (await o.listHealthIncidents(ctx)).incidents;
  assert.equal(incident.kind, 'quota_exhausted');
  assert.equal(incident.notifiedAt, null);
}));

test('被动宿主观察不触发卡死检测', async () => {
  let now = 0;
  const signals = [];
  const watchdog = createWatchdog({ now: () => now, softStallMs: 1, hardStallMs: 2, onSignal: (...args) => signals.push(args) });
  try {
    watchdog.start({ runId: 'passive', managed: false });
    now = 100;
    await delay(10);
    assert.deepEqual(signals, []);
  } finally { watchdog.close(); }
});


test('带 wait 的续聊直接返回失败，未知副作用和迟到的审批不会触发重放', () => fixture('v001-followup', async (o, ctx, wake) => {
  o.engineManager.runTurn = () => ({ result: Promise.resolve(completed) });
  const initial = await o.delegateTask({ ...ctx, task: 'initial', mode: 'wait' });
  let calls = 0;
  o.engineManager.runTurn = ({ onEvent }) => {
    calls++;
    onEvent({ type: 'tool_result', toolCallId: 'unknown', status: 'completed' });
    return { result: Promise.resolve(transient) };
  };
  const failed = await o.sendToThread({ threadId: initial.threadId, message: 'follow-up', wait: true });
  assert.equal(failed.status, 'failed');
  assert.equal(calls, 1);
  assert.deepEqual(wake, []);
  let attempt = 0, old;
  o.engineManager.runTurn = opts => {
    if (!attempt++) { old = opts; return { result: Promise.resolve(transient) }; }
    old.onPermissionRequest({ requestId: 'stale' });
    return { result: Promise.resolve(completed) };
  };
  await o.sendToThread({ threadId: initial.threadId, message: 'retry', wait: true });
  assert.equal(attempt, 2);
  assert.equal(o.db.getRuntimeRequest('stale'), null);
}, { baseRetryDelayMs: 1 }));

test('全局默认值广播给其他会话，子成员与实时订阅使用同一个根', () => fixture('v001-scope', async (o, ctx) => {
  const events = [];
  const off = o.subscribe(evt => events.push(evt));
  try {
    o.db.upsertThread({ id: 'parent', hostConversationId: ctx.conversationId, workspace: ctx.cwd });
    o.db.upsertThread({ id: 'child', nativeSessionId: 'child-native', parentThreadId: 'parent', workspace: ctx.cwd });
    o.db.upsertRun({ id: 'queued', threadId: 'child', status: 'queued' });
    const res = await o.setConversationPolicy({ ...ctx, dispatchEnabled: false, defaultDispatchEnabled: false });
    assert.equal(o.resolveConversationRoot('child-native'), ctx.conversationId);
    assert.equal(o.getConversationPolicy({ conversationId: 'child-native' }).source, 'explicit');
    const visible = events.filter(e => o.matchesEventConversation(e, 'other-root'));
    assert.ok(visible.some(e => e.type === 'settings_updated' && e.settings.defaultDispatchEnabled === false));
    assert.ok(!visible.some(e => e.type === 'conversation_policy_updated'));
    assert.equal(res.conversationPolicy.queuedCount + res.conversationPolicy.runningCount, 1);
  } finally { off(); }
}));

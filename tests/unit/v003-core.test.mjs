import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createOrchestrator } from '../../core/orchestrator.mjs';
import { createWatchdog } from '../../core/watchdog.mjs';
import { restricted, rootRejection, safeRoot } from '../../core/storage-paths.mjs';
import {
  DEFAULT_ROLE_PRESETS, PROVIDER_PERMISSION_MODES, isDangerousPermissionMode, listPermissionModesForProvider,
  normalizePermissionModeForProvider, resolveRoleTarget,
} from '../../core/catalog.mjs';
import { spawnSupervised } from '../helpers/process.mjs';
import { withProjectSandbox } from '../helpers/sandbox.mjs';
import { offlineCatalog, project } from '../helpers/fixtures.mjs';

function fixture(name, action, watchdogOptions) {
  return withProjectSandbox(name, async dir => {
    const cwd = project(dir, 'workspace');
    const o = createOrchestrator({
      dataDir: path.join(dir, 'control'), defaultStudioRoot: cwd, catalogLoader: offlineCatalog,
      watchdogOptions, hostWakeSender: async () => ({ ok: true }),
    });
    o.db.saveSettings({ defaultOrchestrationMode: 'complex' });
    try {
      await action(o, { cwd, conversationId: 'root-v3', presetKey: 'executor_codex' }, dir);
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
    async steer() { return { supported: false }; },
    async respondPermission() {},
  };
}
const completed = { status: 'completed', assistantText: '完成' };
const tickUntil = async (check, message, ms = 3000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await delay(5);
  assert.ok(check(), message);
};
// A PID that certainly belonged to a process which has already exited.
function deadPid() {
  return spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
}

function seedOrphan(o, cwd, { id, ownerPid, root = 'root-v3' }) {
  const runId = `run-${id}`;
  const incidentId = `health_${runId}_suspected_stall`;
  o.db.upsertThread({ id, title: id, provider: 'codex', role: 'implementation', workspace: cwd, cwd, status: 'running',
    activeRunId: runId, meta: { projectRoot: cwd, rootConversationId: root,
      health: { state: 'suspected_stall', runId, incidentId, updatedAt: Date.now() } } });
  o.db.upsertRun({ id: runId, threadId: id, status: 'running', provider: 'codex', model: 'gpt-6.2-sol',
    ...(ownerPid ? { meta: { ownerPid, ownerStartedAt: 1 } } : {}) });
  o.db.upsertRuntimeRequest({ id: `req-${id}`, threadId: id, runId, provider: 'codex', kind: 'approval', status: 'pending',
    title: 'approve', payload: {} });
  o.db.upsertHealthIncident({ id: incidentId, rootConversationId: root, threadId: id, runId, kind: 'suspected_stall',
    title: 'stall', detail: 'stall', status: 'open', severity: 'warning' });
  return { runId, incidentId };
}

test('v0.0.3 原生权限档位：auto 不提权、跨引擎不落全放行、未知值走请求批准', () => {
  for (const provider of ['claude-code', 'codex', 'kimi-code', 'antigravity', 'opencode']) {
    const ladder = listPermissionModesForProvider(provider);
    assert.ok(ladder.length >= 4, provider);
    assert.equal(ladder.filter(m => m.danger).length, 1, `${provider} has exactly one full rung`);
    for (const source of ['bypassPermissions', 'full-access', 'yolo', 'always-proceed', 'danger-full-access', 'auto']) {
      const mapped = normalizePermissionModeForProvider(provider, source, { crossEngine: true });
      assert.equal(isDangerousPermissionMode(provider, mapped), false, `${source} -> ${provider} = ${mapped}`);
    }
    assert.equal(isDangerousPermissionMode(provider, normalizePermissionModeForProvider(provider, 'totally-unknown')), false);
  }
  assert.deepEqual(listPermissionModesForProvider('antigravity', { isNativeHost: true }).map(m => [m.value, m.disabled]), [['host-default', true]]);
  assert.deepEqual(PROVIDER_PERMISSION_MODES['claude-code'].map(m => m.value), ['plan', 'default', 'acceptEdits', 'auto', 'bypassPermissions']);
  const claude = mode => normalizePermissionModeForProvider('claude-code', mode);
  assert.equal(claude('auto'), 'auto');
  assert.equal(claude('approval-required'), 'default');
  assert.equal(claude('auto-accept-edits'), 'acceptEdits');
  assert.equal(claude('dontAsk'), 'dontAsk');
  assert.equal(claude('always-proceed'), 'auto');
  for (const explicit of ['bypassPermissions', 'full-access', 'yolo', 'danger-full-access']) assert.equal(claude(explicit), 'bypassPermissions');
  assert.equal(normalizePermissionModeForProvider('codex', 'bypassPermissions'), 'auto');
  assert.equal(normalizePermissionModeForProvider('codex', 'auto-accept-edits'), 'on-request');
  assert.equal(normalizePermissionModeForProvider('antigravity', 'auto'), 'accept-edits');
  assert.equal(normalizePermissionModeForProvider('kimi-code', 'auto-accept-edits'), 'default');
  assert.equal(normalizePermissionModeForProvider('claude-code', 'read-only'), 'read-only');
  assert.equal(normalizePermissionModeForProvider('claude-code', 'read-only', { crossEngine: true }), 'plan');
  assert.equal(DEFAULT_ROLE_PRESETS.executor_claude.permissionMode, 'bypassPermissions');
  assert.equal(resolveRoleTarget({ presetKey: 'advisor_codex' }).permissionMode, 'read-only');
  assert.equal(resolveRoleTarget({ presetKey: 'executor_claude', target: { permissionMode: '__proto__' } }).permissionMode, 'default');
  // A Codex full-access role default carried onto Claude never becomes bypassPermissions.
  assert.equal(resolveRoleTarget({ role: 'test', target: { provider: 'claude-code' } }).permissionMode, 'auto');
  assert.equal(resolveRoleTarget({ target: { provider: 'claude-code', permissionMode: 'plan' } }).interactionMode, 'plan');
});

test('storage-paths 放行普通 C 盘项目，精准拦截敏感目录，显式非法 cwd Fail-Closed', () => fixture('v3-paths', async (o, ctx, dir) => {
  if (process.platform === 'win32') {
    for (const ok of ['C:\\Users\\alice\\code\\app', 'C:\\work\\repo', 'D:\\projects\\x', 'C:\\Users\\alice\\Documents\\proj'])
      assert.equal(restricted(ok), false, ok);
    for (const bad of ['C:\\', 'D:\\', 'C:\\Windows\\System32', 'C:\\Program Files\\Git', 'C:\\Program Files (x86)\\x',
      'C:\\ProgramData\\pkg', 'C:\\Users', 'C:\\Users\\alice', 'C:\\Users\\alice\\Desktop\\proj',
      'C:\\Users\\alice\\AppData\\Local\\Temp\\x', 'C:\\Users\\alice\\.gemini\\config\\plugins\\agent-tower',
      'C:\\Users\\alice\\.gemini\\antigravity\\plugin_data\\agent-tower'])
      assert.equal(restricted(bad), true, bad);
  }
  for (const envDir of [process.env.TEMP, process.env.TMP].filter(Boolean)) assert.equal(restricted(path.join(envDir, 'x')), true);
  const file = path.join(dir, 'plain.txt');
  fs.writeFileSync(file, 'x');
  assert.equal(rootRejection(path.join(dir, 'missing')), 'missing');
  assert.equal(rootRejection(file), 'not_directory');
  assert.equal(rootRejection('relative/dir'), 'not_absolute');
  assert.equal(rootRejection(ctx.cwd), '');
  // Under the test runner nothing outside `.agent-tower/test-runs/` is a valid project root.
  assert.equal(rootRejection(path.resolve(import.meta.dirname, '..', '..')), 'restricted');
  assert.equal(safeRoot(path.join(dir, 'missing'), 'fallback'), 'fallback');

  let launched = 0;
  o.engineManager.runTurn = () => { launched++; return { result: Promise.resolve(completed) }; };
  const before = o.db.listThreads({ includeSubagents: true }).length;
  for (const cwd of [path.join(dir, 'missing'), file, process.env.TEMP]) {
    await assert.rejects(o.delegateTask({ ...ctx, cwd, task: 'must not run elsewhere' }), { code: 'CWD_REJECTED' });
  }
  await assert.rejects(o.launchThread({ ...ctx, cwd: path.join(dir, 'missing'), prompt: 'x' }), { code: 'CWD_REJECTED' });
  assert.equal(launched, 0);
  assert.equal(o.db.listThreads({ includeSubagents: true }).length, before);
  const ok = await o.delegateTask({ ...ctx, task: 'valid cwd', mode: 'wait' });
  assert.equal(ok.status, 'completed');
  assert.equal(launched, 1);
}));

test('孤儿运行态点击取消当场收割；存活外部 owner 拒绝且删除不静默归档', () => fixture('v3-orphan', async (o, ctx) => {
  const events = [];
  let stateAtCompletion;
  const off = o.subscribe(e => {
    events.push(e);
    if (e.type === 'run_completed' && e.threadId === 'orphan') {
      stateAtCompletion = {
        activeRunId: o.db.getThread(e.threadId).activeRunId,
        runStatus: o.db.getRun(e.runId).status,
        pending: o.db.listPendingRequests({ threadId: e.threadId }).map(req => req.id),
      };
    }
  });
  const keeper = spawnSupervised(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', timeoutMs: 60_000 });
  try {
    const orphan = seedOrphan(o, ctx.cwd, { id: 'orphan', ownerPid: deadPid() });
    const legacy = seedOrphan(o, ctx.cwd, { id: 'legacy' });
    const foreign = seedOrphan(o, ctx.cwd, { id: 'foreign', ownerPid: keeper.proc.pid });
    const caps = Object.fromEntries((await o.listThreads({ includeSubagents: true })).threads.map(t => [t.id, t.cancelCapability]));
    assert.deepEqual([caps.orphan, caps.legacy, caps.foreign], ['reconcilable_orphan', 'reconcilable_orphan', 'none']);

    const res = await o.cancelTask({ threadId: 'orphan' });
    assert.equal(res.ok, true);
    assert.equal(res.reconciledOrphan, true);
    assert.equal(res.cancelState, 'orphaned_reconciled');
    assert.deepEqual(stateAtCompletion, { activeRunId: '', runStatus: 'interrupted', pending: [] });
    const thread = o.db.getThread('orphan');
    assert.equal(thread.status, 'interrupted');
    assert.ok(!thread.activeRunId);
    assert.equal(thread.meta.health.state, 'healthy');
    assert.equal(o.db.getRun(orphan.runId).status, 'interrupted');
    assert.equal(o.db.getRuntimeRequest('req-orphan').status, 'cancelled');
    assert.equal(o.db.getHealthIncident(orphan.incidentId).status, 'resolved');
    assert.ok(events.some(e => e.type === 'run_completed' && e.runId === orphan.runId && e.reconciledOrphan));
    assert.ok(events.some(e => e.type === 'thread_updated' && e.threadId === 'orphan' && e.thread.cancelCapability === 'none'));
    assert.ok(events.some(e => e.type === 'health_incident_resolved' && e.incidentId === orphan.incidentId));
    assert.equal((await o.cancelTask({ threadId: 'legacy' })).cancelState, 'orphaned_reconciled');
    assert.equal(o.db.getRun(legacy.runId).status, 'interrupted');

    const refused = await o.cancelTask({ threadId: 'foreign' });
    assert.equal(refused.ok, false);
    assert.equal(refused.cancelState, 'foreign_owner');
    assert.equal(o.db.getThread('foreign').status, 'running');
    await assert.rejects(o.deleteThread({ threadId: 'foreign' }), { code: 'THREAD_STILL_RUNNING' });
    assert.equal(o.db.getThread('foreign').archived, false);
    assert.equal(o.db.getRun(foreign.runId).status, 'running');
  } finally {
    off();
    await keeper.stop();
  }
}));

test('expectedRunId 防误杀下一轮；停止后不会被 steering_restart 重新拉起', () => fixture('v3-stale', async (o, ctx) => {
  const handles = [];
  o.engineManager.runTurn = () => {
    const h = deferredHandle();
    handles.push(h);
    return h;
  };
  const first = await o.delegateTask({ ...ctx, task: 'first' });
  handles[0].resolve(completed);
  await tickUntil(() => o.db.getRun(first.runId)?.status === 'completed', 'first turn settles');
  const next = await o.sendToThread({ threadId: first.threadId, message: 'second' });
  assert.equal(next.action, 'started');
  const stale = await o.cancelTask({ threadId: first.threadId, force: true, expectedRunId: first.runId });
  assert.equal(stale.cancelState, 'stale_run');
  assert.equal(stale.alreadyFinished, true);
  assert.equal(handles[1].cancels, 0);
  assert.equal(o.db.getRun(next.runId).status, 'running');

  // Steering restart pending + user stop: the settled turn must not relaunch.
  let releaseCancel, cancelCalls = 0;
  const cancelGate = new Promise(r => { releaseCancel = r; });
  const slow = deferredHandle();
  slow.cancel = async () => { cancelCalls++; await cancelGate; };
  handles[1].resolve(completed);
  await tickUntil(() => o.db.getRun(next.runId)?.status === 'completed', 'second turn settles');
  o.engineManager.runTurn = () => { handles.push(slow); return slow; };
  const third = await o.sendToThread({ threadId: first.threadId, message: 'third' });
  const steering = o.sendToThread({ threadId: first.threadId, message: 'restart please', mode: 'steer' });
  await tickUntil(() => cancelCalls >= 1, 'steering cancel requested');
  const stopping = o.cancelTask({ threadId: first.threadId, expectedRunId: third.runId });
  await delay(10);
  releaseCancel();
  slow.resolve({ status: 'interrupted' });
  assert.equal((await steering).action, 'steering_restart');
  assert.equal((await stopping).cancelled, true);
  await tickUntil(() => o.db.getRun(third.runId)?.status === 'interrupted', 'third turn interrupted');
  await delay(30);
  assert.equal(handles.length, 3, 'no relaunch after user stop');
  assert.equal(o.db.getThread(first.threadId).status, 'interrupted');
}));

test('dismissHealthIncident 跨索引兜底、大小写兼容、清理徽标并广播', () => withProjectSandbox('v3-dismiss', async dir => {
  const cwd = project(dir, 'workspace');
  const control = path.join(dir, 'control');
  const open = () => createOrchestrator({ dataDir: control, defaultStudioRoot: cwd, catalogLoader: offlineCatalog,
    recoverStaleState: false, hostWakeSender: async () => ({ ok: true }) });
  const writer = open();
  const reader = open();
  try {
    writer.db.upsertThread({ id: 'late', title: 'late', provider: 'codex', workspace: cwd, cwd, status: 'running',
      meta: { projectRoot: cwd, rootConversationId: 'Root-Mixed', health: { state: 'suspected_stall', runId: 'r1', incidentId: 'inc-late' } } });
    writer.db.upsertHealthIncident({ id: 'inc-late', rootConversationId: 'Root-Mixed', threadId: 'late', runId: 'r1',
      kind: 'suspected_stall', title: 'stall', detail: 'stall', status: 'open' });
    // Rows written by another daemon are not in the reader's in-memory indexes.
    assert.equal(reader.db.getThread('late')?.id, 'late');
    const events = [];
    const off = reader.subscribe(e => events.push(e));
    assert.equal((await reader.dismissHealthIncident({ conversationId: 'another', incidentId: 'inc-late' })).dismissedCount, 0);
    const res = await reader.dismissHealthIncident({ conversationId: 'root-mixed', incidentId: 'inc-late' });
    off();
    assert.equal(res.dismissedCount, 1);
    assert.deepEqual(res.dismissedIds, ['inc-late']);
    assert.equal(writer.db.getHealthIncident('inc-late').status, 'resolved');
    assert.equal(reader.db.getThread('late').meta.health.state, 'healthy');
    assert.ok(events.some(e => e.type === 'thread_updated' && e.threadId === 'late' && e.healthCleared));
    assert.ok(events.some(e => e.type === 'health_incident' && e.dismissedIds?.includes('inc-late')));
    assert.deepEqual((await reader.listHealthIncidents({ conversationId: 'ROOT-MIXED' })).incidents, []);
  } finally {
    await reader.shutdown();
    await writer.shutdown();
  }
}));

test('看门狗：在途工具放宽阈值、Claude 推理期放宽、告警后实质活动自动恢复', async () => {
  let now = 0;
  const signals = [];
  const recovered = [];
  const watchdog = createWatchdog({ now: () => now, softStallMs: 100, hardStallMs: 200, toolSoftStallMs: 1000,
    toolHardStallMs: 5000, reasoningSoftStallMs: 300, reasoningHardStallMs: 600, pollIntervalMs: 1,
    onSignal: (state, s) => signals.push([state.runId, s.kind]), onStallRecovered: (state, info) => recovered.push([state.runId, info.threadId]) });
  try {
    watchdog.start({ runId: 'tool', threadId: 't1', provider: 'codex', startedAt: 0 });
    watchdog.observe('tool', { type: 'tool_call', toolCallId: 'build', status: 'in_progress' });
    assert.deepEqual(watchdog.inspect('tool').inFlightTools, ['build']);
    now = 900;
    await delay(10);
    assert.deepEqual(signals, []);
    watchdog.observe('tool', { type: 'tool_call', toolCallId: 'build', status: 'completed' });
    assert.deepEqual(watchdog.inspect('tool').inFlightTools, []);
    watchdog.start({ runId: 'claude', threadId: 't2', provider: 'claude-code', startedAt: now });
    now += 250;
    await delay(10);
    assert.ok(!signals.some(([id]) => id === 'claude'), 'claude reasoning window is wider');
    now += 100;
    await delay(10);
    assert.ok(signals.some(([id, kind]) => id === 'claude' && kind === 'suspected_stall'));
    watchdog.observe('claude', { type: 'heartbeat', subtype: 'system' });
    assert.deepEqual(recovered, [['claude', 't2']]);
    assert.equal(watchdog.inspect('claude').warned, false);
    now += 350;
    await delay(10);
    assert.equal(signals.filter(([id, kind]) => id === 'claude' && kind === 'suspected_stall').length, 2, 'warns again after recovery');
  } finally { watchdog.close(); }
});

test('suspected_stall -> recovered 闭环：告警自动关闭并广播，再次卡顿重新打开', () => fixture('v3-recover', async (o, ctx) => {
  let opts, handle;
  o.engineManager.runTurn = input => { opts = input; return handle = deferredHandle(); };
  const events = [];
  const off = o.subscribe(e => events.push(e));
  try {
    const task = await o.delegateTask({ ...ctx, task: 'slow' });
    const incidentId = `health_${task.runId}_suspected_stall`;
    await tickUntil(() => o.db.getThread(task.threadId).meta.health?.state === 'suspected_stall', 'soft stall raised');
    await o.dismissHealthIncident({ incidentId, conversationId: ctx.conversationId });
    opts.onEvent({ type: 'message_delta', delta: 'still working' });
    assert.equal(o.db.getThread(task.threadId).meta.health.state, 'healthy');
    assert.equal(o.db.getHealthIncident(incidentId).status, 'resolved');
    const secondIncidentId = `${incidentId}_2`;
    await tickUntil(() => o.db.getHealthIncident(secondIncidentId)?.status === 'open', 'distinct second stall raised');
    assert.equal(o.db.getHealthIncident(incidentId).status, 'resolved');
    assert.equal(handle.cancels, 0);
    handle.resolve(completed);
    await tickUntil(() => o.db.getRun(task.runId)?.status === 'completed', 'run completes');
    assert.equal(o.db.getHealthIncident(secondIncidentId).status, 'resolved');
    const started = events.find(e => e.type === 'run_started' && e.runId === task.runId);
    assert.equal(started.thread.cancelCapability, 'stoppable');
  } finally { off(); }
}, { softStallMs: 30, hardStallMs: 60_000, pollIntervalMs: 5 }));

test('队列操作校验归属、hasActiveRuns 按会话作用域、跨引擎续聊不提权', () => fixture('v3-scope', async (o, ctx) => {
  const handles = [];
  const turns = [];
  o.engineManager.runTurn = input => { turns.push(input); const h = deferredHandle(); handles.push(h); return h; };
  const a = await o.delegateTask({ ...ctx, task: 'a' });
  const queued = await o.sendToThread({ threadId: a.threadId, message: 'later', mode: 'queue' });
  const b = await o.delegateTask({ ...ctx, conversationId: 'other-root', presetKey: 'executor_kimi', task: 'b' });
  await assert.rejects(o.manageQueue({ threadId: b.threadId, action: 'cancel', queueId: queued.queuedRunId }), /排队中的消息/);
  await assert.rejects(o.manageQueue({ threadId: a.threadId, action: 'cancel', queueId: a.runId }), /排队中的消息/);
  await assert.rejects(o.manageQueue({ threadId: b.threadId, action: 'edit', queueId: queued.queuedRunId, text: 'x' }), /排队中的消息/);
  assert.equal(o.db.getRun(a.runId).status, 'running');
  assert.equal((await o.manageQueue({ threadId: a.threadId, action: 'cancel', queueId: queued.queuedRunId })).queue.length, 0);
  handles[1].resolve(completed);
  await tickUntil(() => o.db.getRun(b.runId)?.status === 'completed', 'b completes');
  assert.equal((await o.getEvents({ conversationId: 'other-root' })).hasActiveRuns, false);
  assert.equal((await o.getEvents({ conversationId: ctx.conversationId })).hasActiveRuns, true);
  handles[0].resolve(completed);
  await tickUntil(() => o.db.getRun(a.runId)?.status === 'completed', 'a completes');
  assert.equal(turns[0].permissionMode, 'full-access');
  await o.sendToThread({ threadId: a.threadId, message: 'switch engine', provider: 'claude-code', model: 'claude-opus-5-5' });
  assert.equal(turns.at(-1).provider, 'claude-code');
  assert.equal(turns.at(-1).permissionMode, 'auto');
  handles.at(-1).resolve(completed);
}));

test('Worktree 运行中拒绝合入/清理，清理后线程回退主仓', () => fixture('v3-worktree', async (o, ctx) => {
  let handle;
  o.engineManager.runTurn = () => (handle = deferredHandle());
  const task = await o.delegateTask({ ...ctx, task: 'isolated', isolation: 'worktree' });
  const thread = o.db.getThread(task.threadId);
  assert.ok(thread.worktreePath);
  await assert.rejects(o.integrateWorktree({ threadId: task.threadId }), { code: 'WORKTREE_BUSY' });
  await assert.rejects(o.cleanupWorktree({ threadId: task.threadId }), { code: 'WORKTREE_BUSY' });
  handle.resolve(completed);
  await tickUntil(() => o.db.getRun(task.runId)?.status === 'completed', 'run completes');
  const removing = o.cleanupWorktree({ threadId: task.threadId, workspace: ctx.cwd });
  await assert.rejects(o.cleanupWorktree({ threadId: task.threadId, workspace: ctx.cwd }), { code: 'WORKTREE_BUSY' });
  const res = await removing;
  assert.equal(res.cleaned, true);
  const after = o.db.getThread(task.threadId);
  assert.ok(!after.worktreePath);
  assert.equal(path.resolve(after.cwd).toLowerCase(), path.resolve(ctx.cwd).toLowerCase());
  assert.equal(after.meta.worktreeCleaned, true);
}));

test('预设继承或显式 Worktree 创建失败时严禁静默降级回原目录执行', () => fixture('v3-worktree-fail-closed', async (o, ctx, dir) => {
  let turns = 0;
  o.engineManager.runTurn = () => { turns++; return deferredHandle(); };
  await o.saveSettings({
    workspace: ctx.cwd,
    presets: { executor_codex: { ...DEFAULT_ROLE_PRESETS.executor_codex, isolation: 'worktree' } },
  });
  await assert.rejects(
    o.delegateTask({ ...ctx, task: 'inherit-preset-bad-ref', baseRef: 'refs/heads/nonexistent' }),
    err => err?.code === 'WORKTREE_CREATE_FAILED' && /已拒绝退回原工作目录执行/.test(err.message),
  );
  await assert.rejects(
    o.launchThread({ ...ctx, message: 'launch-preset-bad-ref', baseRef: 'refs/heads/nonexistent' }),
    err => err?.code === 'WORKTREE_CREATE_FAILED' && /已拒绝退回原工作目录执行/.test(err.message),
  );
  const plainDir = path.join(dir, 'plain-no-git');
  fs.mkdirSync(plainDir, { recursive: true });
  await o.saveSettings({
    workspace: plainDir,
    defaultOrchestrationMode: 'complex',
    presets: { executor_codex: { ...DEFAULT_ROLE_PRESETS.executor_codex, isolation: 'worktree' } },
  });
  await assert.rejects(
    o.delegateTask({ cwd: plainDir, conversationId: 'root-plain', presetKey: 'executor_codex', task: 'plain-dir-must-fail' }),
    err => err?.code === 'WORKTREE_CREATE_FAILED' && /不是有效的 Git 仓库/.test(err.message) && /已拒绝退回原工作目录执行/.test(err.message),
  );
  assert.equal(turns, 0);
  assert.equal(o.db.listThreads().length, 0);
  assert.equal(o.db.listRuns().length, 0);
}));


test('显式路径校验无部分派发；控制面真实路径也拒绝', () => fixture('v3-root-fail-closed', async (o, ctx, dir) => {
  const bad = path.join(dir, 'missing');
  for (const cwd of ['', null, 0, bad]) {
    await assert.rejects(o.handleRpc('delegateTask', { ...ctx, cwd, workspace: ctx.cwd, task: 'reject' }), { code: 'CWD_REJECTED' });
  }
  await assert.rejects(o.delegateParallelBatch({ ...ctx, tasks: [{ task: 'valid' }, { cwd: bad, task: 'invalid' }] }), { code: 'CWD_REJECTED' });
  await assert.rejects(o.probeExtensionProvider({ cwd: bad, command: 'never-launched' }), { code: 'CWD_REJECTED' });
  assert.equal(o.db.listRuns().length, 0);
  const control = path.join(dir, 'control');
  const alias = path.join(dir, 'control-alias');
  fs.symlinkSync(control, alias, 'junction');
  assert.equal(rootRejection(control, alias), 'restricted');
  assert.equal(rootRejection(alias, control), 'restricted');
}));

test('引擎撤回审批后恢复运行与看门狗，过期回复不篡改请求状态', () => fixture('v3-control-cancel', async (o, ctx) => {
  const handle = deferredHandle();
  let opts;
  o.engineManager.runTurn = input => { opts = input; return handle; };
  const task = await o.delegateTask({ ...ctx, task: 'authorise' });
  try {
    opts.onPermissionRequest({ requestId: 'withdrawn', title: 'Approve?' });
    assert.equal(o.db.getRun(task.runId).status, 'waiting_approval');
    opts.onEvent({ type: 'runtime_request_cancelled', requestId: 'withdrawn' });
    assert.equal(o.db.getRun(task.runId).status, 'running');
    assert.equal(o.db.getRuntimeRequest('withdrawn').status, 'cancelled');
    await assert.rejects(o.respondRuntimeRequest({ requestId: 'withdrawn', decision: 'approve_once' }), { code: 'STALE_RUNTIME_REQUEST' });
    assert.deepEqual(o.db.listPendingRequests({ threadId: task.threadId }), []);
  } finally { handle.resolve(completed); await tickUntil(() => o.db.getRun(task.runId).status === 'completed', 'turn settles'); }
}));

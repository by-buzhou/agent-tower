import { readDaemonLease, resolveSharedDataDir, verifyDaemonLeaseOwner } from '../daemon-client.mjs';

const empty = () => process.stdout.write('{}\n');
if (process.env.AGENT_TOWER_MANAGED_AGY_ACP === '1') {
  empty();
  process.exit(0);
}

async function readInput() {
  const chunks = [];
  let size = 0;
  const timer = setTimeout(() => process.stdin.destroy(), 900);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 256 * 1024) throw new Error('Hook input too large');
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(timer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

try {
  const input = await readInput();
  const conversationId = typeof input?.conversationId === 'string' ? input.conversationId.trim() : '';
  const stop = input.hookEventName === 'Stop';
  if (!conversationId || (stop && (input.terminationReason !== 'NO_TOOL_CALL' || input.fullyIdle !== true || input.continuationActive === true ||
      input.isSubagent === true || (input.parentConversationId && input.parentConversationId !== conversationId)))) {
    empty();
    process.exit(0);
  }

  const lease = readDaemonLease(resolveSharedDataDir());
  if (!lease || !(await verifyDaemonLeaseOwner(lease, 500))) {
    empty();
    process.exit(0);
  }

  const workspacePaths = Array.isArray(input.workspacePaths)
    ? input.workspacePaths.filter(value => typeof value === 'string')
    : [];
  const call = (params, timeoutMs, method = 'getConversationPolicy') => fetch(`http://127.0.0.1:${lease.port}/rpc`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'X-Daemon-Token': lease.token,
    },
    body: JSON.stringify({ method, params }),
  });
  if (stop) {
    const response = await call({ action: 'stopHookCheck', conversationId, cwd: input.cwd || workspacePaths[0] }, 1400, 'specCuration');
    const result = response.ok ? (await response.json())?.result : null;
    if (result?.decision === 'continue' && typeof result.reason === 'string') {
      process.stdout.write(JSON.stringify({ decision: 'continue', reason: result.reason }) + '\n');
    } else empty();
  } else {
    const baseParams = {
      conversationId,
      workspace: workspacePaths[0] || input.cwd || '',
      syncHostPlaybook: true,
      initialNumSteps: input.initialNumSteps,
    };
    const response = await call({ ...baseParams, deferPlaybookCommit: true }, 2000);
    const payload = response.ok ? await response.json() : null;
    const result = payload?.ok ? payload.result : null;
    const playbook = result?.playbookInject;
    if (typeof playbook === 'string' && playbook) {
      const output = JSON.stringify({ injectSteps: [{ systemMessage: { systemMessage: playbook } }] }) + '\n';
      await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
      if (result.playbookCommitToken) {
        await call({ ...baseParams, confirmPlaybookToken: result.playbookCommitToken }, 400).catch(() => null);
      }
    } else {
      empty();
    }
  }
} catch {
  empty();
}

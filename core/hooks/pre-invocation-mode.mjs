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
  if (!conversationId) {
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
  const call = (params, timeoutMs) => fetch(`http://127.0.0.1:${lease.port}/rpc`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    redirect: 'error',
    headers: {
      'Content-Type': 'application/json',
      'X-Daemon-Token': lease.token,
    },
    body: JSON.stringify({ method: 'getConversationPolicy', params }),
  });
  const baseParams = {
    conversationId,
    workspace: workspacePaths[0] || input.cwd || '',
    syncHostPlaybook: true,
    initialNumSteps: input.initialNumSteps,
  };
  const response = await call({ ...baseParams, deferPlaybookCommit: true }, 2000);
  if (!response.ok) {
    empty();
    process.exit(0);
  }
  const payload = await response.json();
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
} catch {
  empty();
}

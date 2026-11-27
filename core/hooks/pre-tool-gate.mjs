import fs from 'node:fs';
import path from 'node:path';
import { readDaemonLease, resolveSharedDataDir, verifyDaemonLeaseOwner } from '../daemon-client.mjs';

const CONTROL_DIR = resolveSharedDataDir();
const guardedTools = new Set(['invoke_subagent', 'define_subagent', 'run_workflow', 'swarm']);
const allow = { decision: 'allow' };
const deny = {
  decision: 'deny',
  reason: '当前对话已在AgentTower关闭子 Agent 派发开关（含宿主自带 invoke_subagent / swarm / run_workflow）。请勿重试任何子 Agent 工具，直接在当前主会话内独立完成本轮请求；如需启用多 Agent 协作，可提醒用户在右侧AgentTower顶栏开启派发开关。',
};

if (process.env.AGENT_TOWER_MANAGED_AGY_ACP === '1') {
  process.stdout.write(JSON.stringify(allow) + '\n');
  process.exit(0);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function daemonPolicy(params) {
  try {
    const lease = readDaemonLease(CONTROL_DIR);
    if (!lease || !await verifyDaemonLeaseOwner(lease, 500)) return;
    const res = await fetch(new URL('/rpc', 'http://127.0.0.1:' + lease.port), {
      method: 'POST', signal: AbortSignal.timeout(800),
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Daemon-Token': lease.token },
      body: JSON.stringify({ method: 'getConversationPolicy', params }),
    });
    if (!res.ok) return;
    const { ok, result } = await res.json();
    if (ok && typeof result?.dispatchEnabled === 'boolean') return result;
  } catch {
    // Stale lease or offline daemon. Continue using the saved state.
  }
}

function findDb(seed) {
  if (typeof seed !== 'string' || !path.isAbsolute(seed)) return;
  let dir = path.resolve(seed);
  const linked = [...dir.matchAll(/[\\/]\.agent-tower[\\/]worktrees[\\/]/gi)].at(-1);
  const linkedRoot = linked && dir.slice(0, linked.index);
  while (true) {
    const candidate = path.join(dir, '.agent-tower', 'conversations', 'tower.sqlite');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (linkedRoot && parent === path.join(linkedRoot, ".agent-tower", "worktrees")) {
      dir = linkedRoot;
      continue;
    }
    if (parent === dir) return;
    dir = parent;
  }
}

async function offlinePolicy(conversationId, workspaces, hostToolName, hostToolArgs) {
  const [{ DatabaseSync }, { pathToFileURL }, { resolveConversationRoot }, { swarmMemberName }, { projectPathKey }, { resolveProjectRootSync }] = await Promise.all([
    import('node:sqlite'),
    import('node:url'),
    import('../engines/agy-native.mjs'),
    import('../catalog.mjs'),
    import('../orchestrator/helpers.mjs'),
    import('../global-settings.mjs'),
  ]);
  const settings = readJson(path.join(CONTROL_DIR, 'global-settings.json')) || {};
  const resolveRoster = seeds => {
    const profiles = settings.projectProfiles;
    if (!profiles || typeof profiles !== 'object') return settings;
    for (const seed of seeds) {
      if (typeof seed !== 'string' || !path.isAbsolute(seed)) continue;
      const resolved = resolveProjectRootSync(seed, profiles);
      const hit = resolved ? profiles[projectPathKey(resolved)]?.roster : null;
      if (hit) return hit;
    }
    return settings;
  };
  const defaultMode = String(settings.defaultOrchestrationMode || (settings.defaultDispatchEnabled ? 'relay' : 'direct')).trim();
  const withGate = (dispatchEnabled, mode, matchedRoot = '') => {
    const result = { dispatchEnabled };
    if (hostToolName !== 'swarm' || hostToolArgs?.action !== 'add') return result;
    const roster = resolveRoster(matchedRoot ? [matchedRoot] : workspaces);
    const name = String(hostToolArgs?.name || '').trim().toLowerCase();
    const presets = roster.presets || roster.rolePresets || {};
    const canonical = value => String(value || '').replace(/-/g, '_').toLowerCase();
    const key = Object.keys(presets).find(id => presets[id].provider === 'antigravity' &&
      [id, swarmMemberName(id)].some(value => canonical(value) === canonical(name)));
    if (!key) return result;
    const profile = roster.modeProfiles?.[mode] || {};
    const enabled = mode !== 'direct' && Object.entries(profile).some(([group, value]) =>
      (mode !== 'relay' || group === 'executor') && value?.stageEnabled !== false && value?.enabledKeys?.includes(key));
    if (!enabled) return { ...result, hostToolAllowed: false,
      hostToolReason: `宿主原生成员 ${name} 对应未启用预设 ${key}；Daemon 离线时无法核验待认领 handoffId，已拒绝 swarm add。` };
    return result;
  };
  if (!conversationId) return withGate(defaultMode !== 'direct' && settings.defaultDispatchEnabled !== false, defaultMode);
  const known = Array.isArray(settings.knownProjects) ? settings.knownProjects : [];
  const files = [...new Set([...workspaces, settings.defaultStudioRoot, ...known].map(findDb).filter(Boolean))];
  const stores = [];
  try {
    for (const file of files) {
      // A cleanly closed WAL database can be read without creating WAL side files.
      // If a writer already has the side files open, use normal SQLite read locking.
      const hasWalSideFiles = fs.existsSync(file + '-wal') && fs.existsSync(file + '-shm');
      const location = hasWalSideFiles ? file : pathToFileURL(file).href + '?immutable=1';
      let db;
      try {
        db = new DatabaseSync(location, { readOnly: true, timeout: 0 });
        const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        stores.push({ db, tables, root: path.resolve(file, '..', '..', '..') });
      } catch { db?.close(); } // One unavailable project must not mask another project's policy.
    }
    let root = conversationId;
    for (const { db, tables } of stores) {
      if (!tables.has('threads')) continue;
      const query = db.prepare(`SELECT id, parent_thread_id, host_conversation_id,
        json_extract(meta_json, '$.rootConversationId') AS root
        FROM threads WHERE id=? OR host_conversation_id=? COLLATE NOCASE OR native_session_id=? COLLATE NOCASE
        ORDER BY (id=?) DESC, (substr(id, 1, 11)='thr_native_') DESC LIMIT 1`);
      const seen = new Set();
      let id = conversationId;
      let mapped;
      while (id && !seen.has(id)) {
        seen.add(id);
        const row = query.get(id, id, id, id);
        if (!row) break;
        mapped = row.root || row.host_conversation_id || mapped;
        if (row.root) break;
        id = row.parent_thread_id;
      }
      if (mapped && mapped !== conversationId) { root = mapped; break; }
    }
    if (root === conversationId) root = resolveConversationRoot(conversationId);
    if (root === null) return withGate(false, "direct");
    for (const { db, tables, root: storeRoot } of stores) {
      if (!tables.has('conversation_policies')) continue;
      const row = db.prepare('SELECT orchestration_mode, dispatch_enabled FROM conversation_policies WHERE conversation_id=?').get(root);
      if (row) return withGate(row.orchestration_mode !== 'direct' && row.dispatch_enabled !== 0, row.orchestration_mode, storeRoot);
    }
    return withGate(defaultMode !== 'direct' && settings.defaultDispatchEnabled !== false, defaultMode);
  } finally {
    for (const { db } of stores) db.close();
  }
}

let decision = allow;
try {
  // Limit both waiting and input size, including when a host leaves stdin open.
  const chunks = [];
  let size = 0;
  const stdinDeadline = setTimeout(() => process.stdin.destroy(), 1000);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) throw new Error('Hook input too large');
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(stdinDeadline);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const toolName = input.toolCall?.name ?? input.toolCall?.toolName ?? input.toolCall?.function?.name;
  // The matcher also handles hosts that omit the tool name from the payload.
  if (!toolName || guardedTools.has(toolName)) {
    const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
    const workspacePaths = Array.isArray(input.workspacePaths) ? input.workspacePaths.filter(p => typeof p === 'string') : [];
    const hostToolArgs = input.toolCall?.input ?? input.toolCall?.args ?? input.toolCall?.arguments ?? input.toolCall?.params ?? {};
    const policy = await daemonPolicy({ conversationId, workspace: workspacePaths[0] || input.cwd, hostToolName: toolName, hostToolArgs }) ??
      await offlinePolicy(conversationId, [...workspacePaths, input.cwd].filter(Boolean), toolName, hostToolArgs);
    const enabled = typeof policy === 'object' ? policy.dispatchEnabled : policy;
    if (!enabled) decision = deny;
    else if (policy?.hostToolAllowed === false) decision = { decision: 'deny', reason: policy.hostToolReason };
  }
} catch {
  // The host contract requires one fail-open response even for malformed input/storage.
}
process.stdout.write(JSON.stringify(decision) + '\n');

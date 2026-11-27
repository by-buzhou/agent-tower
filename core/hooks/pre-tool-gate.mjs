import fs from 'node:fs';
import path from 'node:path';
import { readDaemonLease, resolveSharedDataDir, verifyDaemonLeaseOwner } from '../daemon-client.mjs';

const CONTROL_DIR = resolveSharedDataDir();
const guardedTools = new Set(['invoke_subagent', 'define_subagent', 'run_workflow', 'swarm']);
const writeTools = new Set(['write_file', 'edit_file']);
const specPath = /(?:^|[\\/])\.agent-tower[\\/]spec(?:-archive)?(?:[\\/]|$)/i;
const allow = { decision: 'allow' };
const deny = {
  decision: 'deny',
  reason: '当前对话已在AgentTower关闭子 Agent 派发开关（含宿主自带 invoke_subagent / swarm / run_workflow）。请勿重试任何子 Agent 工具，直接在当前主会话内独立完成本轮请求；如需启用多 Agent 协作，可提醒用户在右侧AgentTower顶栏开启派发开关。',
};

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
    if ([hostToolArgs?.Prompt, hostToolArgs?.brief].some(value => typeof value === 'string' &&
        value.startsWith('[AgentTower Curation Ticket #'))) {
      return { ...result, hostToolAllowed: false, hostToolReason: 'Daemon 离线，无法核验规范维护票据。' };
    }
    if (hostToolName === 'invoke_subagent') {
      const roster = resolveRoster(matchedRoot ? [matchedRoot] : workspaces);
      const label = String(hostToolArgs?.Role || '').trim().toLowerCase();
      if (label && Object.entries(roster.presets || roster.rolePresets || {}).some(([key, preset]) =>
        preset.group === 'curator' && preset.provider === 'antigravity' &&
        [key, preset.label, preset.title].some(value => String(value || '').toLowerCase() === label))) {
        return { ...result, hostToolAllowed: false, hostToolReason: 'Daemon 离线，无法核验规范维护票据。' };
      }
    }
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
      group !== 'curator' && (mode !== 'relay' || group === 'executor') && value?.stageEnabled !== false && value?.enabledKeys?.includes(key));
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

function protectedTarget(target, base) {
  const normalized = path.resolve(base, target);
  if (specPath.test(normalized)) return true;
  // New files may sit below a junction. Resolve the closest existing parent and reattach the missing suffix.
  let existing = normalized;
  while (true) {
    try {
      return specPath.test(path.join(fs.realpathSync.native(existing), path.relative(existing, normalized)));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return true;
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
  }
}

function mutationDecision(toolName, args, conversationId, cwd, workspacePaths) {
  if (writeTools.has(toolName)) {
    const targets = Object.entries(args).filter(([key]) =>
      /^(?:target|file|paths?|(?:target|file|destination|absolute|relative)_?paths?|(?:target|destination)_?file|filename)$/i.test(key))
      .flatMap(([, value]) => Array.isArray(value) ? value : [value]);
    for (const target of targets) {
      if (typeof target !== 'string') continue;
      const segments = target.replaceAll('\\', '/').split('/');
      const normalized = (process.platform === 'win32' ? segments.map(piece => piece.replace(/[ .]+$/, '') || piece) : segments).join('/');
      const bases = path.isAbsolute(normalized) ? [process.cwd()] : [...new Set([cwd, ...workspacePaths].filter(Boolean))];
      if (specPath.test(path.posix.normalize(normalized)) || (bases.length ? bases : [process.cwd()]).some(base => protectedTarget(normalized, base))) {
        return { decision: 'deny', reason: '项目规范只可经提案预检及 Studio 确认后写入。' };
      }
    }
  }
  if (writeTools.has(toolName) || toolName === 'run_command') {
    const guardPath = path.join(CONTROL_DIR, 'active-native-curators.json');
    if (fs.existsSync(guardPath)) {
      try {
        const state = readJson(guardPath);
        if (!state || (conversationId && !state.conversationIds.some(id => id.toLowerCase() === conversationId.toLowerCase()))) return allow;
      } catch { /* Active guard state is unreadable. Deny mutations until it can be read. */ }
      return { decision: 'deny', reason: '原生规范维护官仅可读取，不可写文件或运行命令。' };
    }
  }
  return allow;
}

let decision = allow;
try {
  // Limit both waiting and input size, including when a host leaves stdin open.
  const chunks = [];
  let size = 0;
  const unreadable = { decision: 'deny', reason: '工具请求未能完整读取，无法核验写入或派遣权限。' };
  const stdinDeadline = setTimeout(() => { decision = unreadable; process.stdin.destroy(); }, 1000);
  try {
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > 1024 * 1024) { decision = unreadable; throw new Error('Hook input too large'); }
      chunks.push(chunk);
    }
  } finally {
    clearTimeout(stdinDeadline);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const toolName = input.toolCall?.name ?? input.toolCall?.toolName ?? input.toolCall?.function?.name;
  const conversationId = typeof input.conversationId === 'string' ? input.conversationId.trim() : '';
  const workspacePaths = Array.isArray(input.workspacePaths) ? input.workspacePaths.filter(p => typeof p === 'string') : [];
  const rawArgs = input.toolCall?.input ?? input.toolCall?.args ?? input.toolCall?.arguments ?? input.toolCall?.params ??
    input.toolCall?.function?.arguments ?? {};
  let hostToolArgs = rawArgs;
  if (typeof rawArgs === 'string') {
    try { hostToolArgs = JSON.parse(rawArgs) || {}; }
    catch { hostToolArgs = {}; }
  }
  // The matcher also handles hosts that omit the tool name from the payload.
  if (!toolName || writeTools.has(toolName) || toolName === 'run_command') {
    decision = mutationDecision(toolName || 'write_file', hostToolArgs, conversationId, input.cwd, workspacePaths);
  }
  if (decision === allow && process.env.AGENT_TOWER_MANAGED_AGY_ACP !== '1' && (!toolName || guardedTools.has(toolName))) {
    const policy = await daemonPolicy({ conversationId, workspace: workspacePaths[0] || input.cwd, hostToolName: toolName, hostToolArgs }) ??
      await offlinePolicy(conversationId, [...workspacePaths, input.cwd].filter(Boolean), toolName, hostToolArgs).catch(() => false);
    const enabled = typeof policy === 'object' ? policy.dispatchEnabled : policy;
    if (policy?.hostToolAllowed === false) decision = { decision: 'deny', reason: policy.hostToolReason };
    else if (!enabled && policy?.curationTicketAllowed !== true) decision = deny;
  }
} catch {
  // The host contract requires one fail-open response even for malformed input/storage.
}
process.stdout.write(JSON.stringify(decision) + '\n');

/**
 * @fileoverview AgentTower — Core Daemon Discovery, Lifecycle & RPC/SSE Client.
 *
 * Strictly zero stdout output (safe for import inside Stdio MCP server `mcp-entry.mjs`)
 * and zero `sidecar_sdk` or external npm dependencies.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnNoWindow, safeEngineError } from './engines/proc-utils.mjs';
import { hasUpdateProbation, parseUpdateVersion, readUpdateRecord, updatePath, validateUpdateTarget } from './updater.mjs';
import { recoverInterruptedUpdate } from './update-worker.mjs';

export const PLUGIN_ID = 'agent-tower';
/** 本进程（Sidecar / MCP / CLI）启动时间戳：随 `X-Host-Context` 携带，Daemon 只采信最新启动客户端的 LS / CSRF。 */
export const CLIENT_STARTED_AT = Date.now();

const CORE_DIR = dirname(fileURLToPath(import.meta.url));
const DAEMON_ENTRY_PATH = join(CORE_DIR, 'daemon.mjs');
const PLUGIN_MANIFEST_PATH = join(dirname(CORE_DIR), 'plugin.json');
const LEASE_FILENAME = 'daemon-lease.json';
export const PLUGIN_VERSION = (() => {
  try {
    const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
    if (typeof parsed?.version === 'string' && parsed.version.trim()) return parsed.version.trim();
  } catch {}
  return '0.0.0';
})();
// The plugin and its independently mounted daemon share this protocol baseline.
export const STUDIO_PROTOCOL_REVISION = 1;
// `major.minor.patch` with an optional 4th hotfix segment (`0.2.7.1` -> [0, 2, 7, 1]; `0.2.7` -> [0, 2, 7, 0]).
const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
function parseSemverTuple(ver) {
  return /^v/i.test(String(ver || '').trim()) ? null : parseUpdateVersion(ver);
}
function isSameOrNewerDaemon(actual, expected) {
  if (actual === expected) return true;
  const a = parseSemverTuple(actual);
  const b = parseSemverTuple(expected);
  if (!a || !b) return false;
  for (let i = 0; i < 4; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return true;
}
/**
 * v0.2.6 C09②：Daemon `/healthz` 语义化版本兼容握手（替代写死的历史版本白名单）。
 * 协议修订一致且客户端期望版本为合法 `major.minor.patch` 且 `<=` Daemon 实际版本时回显客户端期望版本，否则返回实际版本。
 */
export function negotiateDaemonVersion(clientExpected, actualVersion, clientProtocolRevision = STUDIO_PROTOCOL_REVISION) {
  const expected = String(clientExpected || '').trim();
  const actual = String(actualVersion || '').trim();
  if (Number(clientProtocolRevision) !== STUDIO_PROTOCOL_REVISION) return actual;
  if (!VERSION_PATTERN.test(expected) || !parseSemverTuple(actual)) return actual;
  return isSameOrNewerDaemon(actual, expected) ? expected : actual;
}
function mountedRuntime(dataDir) {
  try {
    const install = readUpdateRecord(dataDir, 'install.json');
    if (!['dev', 'zip', 'git-clone'].includes(install?.origin) || !VERSION_PATTERN.test(install.version)) return null;
    const root = validateUpdateTarget(dataDir, install.targetDir ?? join(homedir(), '.gemini', 'config', 'plugins', PLUGIN_ID));
    if (!install.targetDir && !existsSync(join(root, 'plugin.json'))) return null;
    return { root, version: install.version };
  } catch { return null; }
}

function expectedVersion(dataDir) {
  const mount = dataDir && mountedRuntime(dataDir);
  const manifest = mount ? join(mount.root, 'plugin.json') : PLUGIN_MANIFEST_PATH;
  let disk;
  try { disk = JSON.parse(readFileSync(manifest, 'utf8')).version; } catch {}
  return VERSION_PATTERN.test(disk) ? disk : mount?.version || PLUGIN_VERSION;
}

function supportsStudioProtocol(data, dataDir) {
  return (
    !data?.shuttingDown &&
    // Read the negotiated `version` first (an echo of our expectation when the daemon is same/newer), so the
    // client is not coupled to the `releaseVersion` format (which may be a 3-segment compat value for old clients).
    isSameOrNewerDaemon(data?.version || data?.releaseVersion, expectedVersion(dataDir)) &&
    data.studioProtocolRevision === STUDIO_PROTOCOL_REVISION
  );
}
const SPAWN_LOCK_FILENAME = 'daemon-spawn.lock';

/**
 * Resolve the single shared persistent directory across MCP process, Sidecar Host, and CLI:
 * `~/.gemini/antigravity/plugin_data/agent-tower`
 */
export function resolveSharedDataDir(env = process.env) {
  // A bare `node --test` (or a hook/child it spawns) must never attach to the real user control plane.
  if (env.NODE_TEST_CONTEXT && !env.AGENT_TOWER_DATA_DIR && !env.AGENT_TOWER_TEST_ROOT) {
    throw Object.assign(new Error("Bare node --test refused: set AGENT_TOWER_DATA_DIR or run tests through scripts/test.mjs"),
      { code: "TEST_CONTROL_PLANE_REFUSED" });
  }
  if (env.AGENT_TOWER_DATA_DIR && !env.AGENT_TOWER_DATA_DIR.includes('${')) {
    const trimmed = env.AGENT_TOWER_DATA_DIR.trim();
    if (trimmed) return resolve(trimmed);
  }
  if (env.AGENT_TOWER_PLUGIN_DATA && !env.AGENT_TOWER_PLUGIN_DATA.includes('${')) {
    const trimmed = env.AGENT_TOWER_PLUGIN_DATA.trim();
    if (trimmed) return resolve(trimmed);
  }
  if (env.PLUGIN_DATA && !env.PLUGIN_DATA.includes('${')) {
    const trimmed = env.PLUGIN_DATA.trim();
    if (trimmed && basename(resolve(trimmed)) === PLUGIN_ID) return resolve(trimmed);
  }

  // Derive <appData>/plugin_data/agent-tower from Sidecar's <appData>/sidecar_data/agent-tower/...
  if (env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    let cur = resolve(env.ANTIGRAVITY_EXECUTABLE_DATA_DIR);
    for (let depth = 0; depth < 8; depth++) {
      if (basename(cur).toLowerCase() === 'sidecar_data') {
        return join(dirname(cur), 'plugin_data', PLUGIN_ID);
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }

  if (env.ANTIGRAVITY_APP_DATA_DIR?.trim()) {
    return join(resolve(env.ANTIGRAVITY_APP_DATA_DIR.trim()), 'plugin_data', PLUGIN_ID);
  }

  const geminiRoot = env.ANTIGRAVITY_GEMINI_DIR?.trim()
    ? resolve(env.ANTIGRAVITY_GEMINI_DIR.trim())
    : join(homedir(), '.gemini');
  const desktopAppData = join(geminiRoot, 'antigravity');
  const cliAppData = join(geminiRoot, 'antigravity-cli');

  if (existsSync(desktopAppData)) {
    return join(desktopAppData, 'plugin_data', PLUGIN_ID);
  }
  if (existsSync(cliAppData)) {
    return join(cliAppData, 'plugin_data', PLUGIN_ID);
  }
  return join(desktopAppData, 'plugin_data', PLUGIN_ID);
}

export const resolveSharedPluginDataDir = resolveSharedDataDir;

/**
 * Resolve the Antigravity host `<appDataDir>` (e.g. `C:\Users\<user>\.gemini\antigravity`)
 * where `brain/<conversationId>/.system_generated/logs/transcript.jsonl` lives.
 */
export function resolveHostAppDataDir(env = process.env) {
  if (env.ANTIGRAVITY_APP_DATA_DIR?.trim() && !env.ANTIGRAVITY_APP_DATA_DIR.includes('${')) {
    return resolve(env.ANTIGRAVITY_APP_DATA_DIR.trim());
  }
  if (env.ANTIGRAVITY_EXECUTABLE_DATA_DIR?.trim()) {
    let cur = resolve(env.ANTIGRAVITY_EXECUTABLE_DATA_DIR.trim());
    for (let depth = 0; depth < 8; depth++) {
      if (basename(cur).toLowerCase() === 'sidecar_data') {
        return dirname(cur);
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  const sharedDir = resolveSharedDataDir(env);
  if (basename(dirname(sharedDir)).toLowerCase() === 'plugin_data') {
    return dirname(dirname(sharedDir));
  }
  const geminiRoot = env.ANTIGRAVITY_GEMINI_DIR?.trim()
    ? resolve(env.ANTIGRAVITY_GEMINI_DIR.trim())
    : join(homedir(), '.gemini');
  return join(geminiRoot, 'antigravity');
}

/**
 * Collect host Antigravity environment variables injected into Sidecar / MCP processes
 * so the shared Core Daemon can bridge natively (`agentapi` + `brain/` transcripts) without spawning `agy.exe`!
 */
export function collectHostContext(env = process.env, { includeInternalIpcAuth = false, includeClientStartedAt = false } = {}) {
  const ctx = {};
  if (env.ANTIGRAVITY_AGENTAPI_EXE?.trim()) {
    ctx.agentApiExe = env.ANTIGRAVITY_AGENTAPI_EXE.trim();
  }
  const appDataDir = resolveHostAppDataDir(env);
  if (appDataDir) {
    ctx.appDataDir = appDataDir;
  }
  if (env.ANTIGRAVITY_PROJECT_ID?.trim()) {
    ctx.projectId = env.ANTIGRAVITY_PROJECT_ID.trim();
  }
  // Do NOT read or attach ANTIGRAVITY_CONVERSATION_ID from shared process env —
  // each browser iframe or MCP tool call provides its own exact conversationId!
  if (env.ANTIGRAVITY_CLI_ALIAS?.trim()) {
    ctx.cliAlias = env.ANTIGRAVITY_CLI_ALIAS.trim();
  }
  if (includeInternalIpcAuth) {
    if (env.ANTIGRAVITY_LS_ADDRESS?.trim()) {
      ctx.lsAddress = env.ANTIGRAVITY_LS_ADDRESS.trim();
    }
    if (env.ANTIGRAVITY_CSRF_TOKEN?.trim()) {
      ctx.csrfToken = env.ANTIGRAVITY_CSRF_TOKEN.trim();
    }
  }
  // 仅随请求头携带：Daemon 自身 ctx.hostContext 不保存该字段，避免以 Daemon 启动时刻误压更早启动的 Sidecar。
  if (includeClientStartedAt) ctx.clientStartedAt = CLIENT_STARTED_AT;
  return ctx;
}

function encodeHostContextHeader(env = process.env, includeInternalIpcAuth = false) {
  try {
    const ctx = collectHostContext(env, { includeInternalIpcAuth, includeClientStartedAt: true });
    if (Object.keys(ctx).length === 0) return '';
    return Buffer.from(JSON.stringify(ctx), 'utf8').toString('base64');
  } catch {
    return '';
  }
}

export function isPidAlive(pid) {
  const num = Number(pid);
  if (!Number.isInteger(num) || num <= 0) return false;
  try {
    process.kill(num, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function readDaemonLease(dataDir) {
  const leasePath = join(dataDir, LEASE_FILENAME);
  try {
    if (!existsSync(leasePath)) return null;
    const raw = JSON.parse(readFileSync(leasePath, 'utf8'));
    if (
      !raw ||
      typeof raw !== 'object' ||
      !Number.isInteger(raw.port) ||
      raw.port <= 0 || raw.port > 65535 ||
      !Number.isInteger(raw.pid) || raw.pid <= 0 ||
      !Number.isFinite(raw.startedAt) || raw.startedAt <= 0 ||
      typeof raw.token !== 'string' ||
      !raw.token
    ) {
      return null;
    }
    const host = '127.0.0.1';
    const lease = {
      host,
      port: raw.port,
      pid: Number(raw.pid || 0),
      studioUrl: `http://${host}:${raw.port}`,
      startedAt: raw.startedAt || 0,
      dataDir,
    };
    // Never trust a URL's authority from disk, or enumerate the protected launch URL in logs.
    const launch = new URL(lease.studioUrl);
    const credential = raw.studioUrl && new URL(raw.studioUrl).searchParams.get('auth');
    if (credential) launch.searchParams.set('auth', credential);
    Object.defineProperty(lease, 'studioUrl', { value: launch.href, enumerable: false });
    return Object.defineProperty(lease, 'token', { value: raw.token });
  } catch {
    return null;
  }
}

function httpJsonRequest({ host = '127.0.0.1', port, path, method = 'GET', token = '', body, timeoutMs = 0, expected = PLUGIN_VERSION }) {
  return new Promise((resolveReq, rejectReq) => {
    const bodyBuf =
      body !== undefined ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8') : null;

    const hostCtxB64 = encodeHostContextHeader(process.env, Boolean(token));
    const headers = {
      Accept: 'application/json',
      'X-Expected-Daemon-Version': expected,
      ...(token ? { 'X-Daemon-Token': token } : {}),
      ...(hostCtxB64 ? { 'X-Host-Context': hostCtxB64 } : {}),
      ...(bodyBuf
        ? {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': bodyBuf.length,
          }
        : {}),
    };

    const req = http.request(
      {
        host,
        port,
        path,
        method,
        headers,
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8'));
        });
        res.on('error', rejectReq);
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            parsed = { ok: false, error: `HTTP ${res.statusCode}` };
          }
          resolveReq({
            statusCode: res.statusCode || 0,
            data: parsed,
          });
        });
      }
    );

    if (timeoutMs > 0) {
      const timeout = setTimeout(() => {
        const error = new Error(`Daemon request timed out after ${timeoutMs}ms`);
        error.code = 'ETIMEDOUT';
        req.destroy(error);
      }, timeoutMs);
      req.once('close', () => clearTimeout(timeout));
    }

    req.on('error', rejectReq);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function inspectDaemonHealth(lease, timeoutMs = 6000) {
  if (!lease || !isPidAlive(lease.pid)) return { unreachable: true };
  try {
    // Health checks must not forward either credential to an unverified listener.
    const res = await httpJsonRequest({ port: lease.port, path: '/healthz', timeoutMs, expected: expectedVersion(lease.dataDir) });
    const data = res.data;
    if (res.statusCode === 200 && data?.ok === true && data.pid === lease.pid &&
        data.startedAt === lease.startedAt && typeof data.version === 'string') return { data };
    return { identityMismatch: true };
  } catch (err) {
    return { unreachable: err?.code === 'ECONNREFUSED' };
  }
}

export async function probeDaemonHealth(lease, timeoutMs) {
  const { data } = await inspectDaemonHealth(lease, timeoutMs);
  return supportsStudioProtocol(data, lease?.dataDir);
}

export async function verifyDaemonLeaseOwner(lease, timeoutMs) {
  const { data } = await inspectDaemonHealth(lease, timeoutMs);
  return Boolean(data);
}

function resolveCleanNodeExecutable() {
  if (!process.versions?.electron) {
    return { execPath: process.execPath, extraEnv: {} };
  }
  const pathDirs = String(process.env.PATH || process.env.Path || '').split(
    process.platform === 'win32' ? ';' : ':'
  );
  const binName = process.platform === 'win32' ? 'node.exe' : 'node';
  for (const dir of pathDirs) {
    const clean = dir.trim();
    if (!clean) continue;
    const candidate = join(clean, binName);
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return { execPath: candidate, extraEnv: {} };
      }
    } catch {}
  }
  return {
    execPath: process.execPath,
    extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

function buildSanitizedSpawnEnv(dataDir, extraEnv = {}) {
  const hostAppDataDir = resolveHostAppDataDir(process.env);
  const env = {
    ...process.env,
    ...(hostAppDataDir && !process.env.ANTIGRAVITY_APP_DATA_DIR
      ? { ANTIGRAVITY_APP_DATA_DIR: hostAppDataDir }
      : {}),
    ...extraEnv,
    AGENT_TOWER_DATA_DIR: dataDir,
  };
  if (typeof env.NODE_OPTIONS === 'string' && env.NODE_OPTIONS.includes('sidecar_sdk')) {
    const cleaned = env.NODE_OPTIONS.replace(/--import[=\s][^\s"']*sidecar_sdk[^\s"']*/gi, '').trim();
    if (cleaned) env.NODE_OPTIONS = cleaned;
    else delete env.NODE_OPTIONS;
  }
  return env;
}

function writeSpawnLock(lockPath, data, flags) {
  const fd = openSync(lockPath, flags);
  try { writeFileSync(fd, JSON.stringify(data), 'utf8'); }
  finally { closeSync(fd); }
}

function releaseSpawnLock(lockPath) {
  try { unlinkSync(lockPath); } catch {}
}

function isStaleSpawnLock(lockPath, observedPid) {
  try {
    const stat = statSync(lockPath);
    try {
      const { pid, childPid } = JSON.parse(readFileSync(lockPath, 'utf8'));
      if (pid || childPid) return !isPidAlive(pid) && (!isPidAlive(childPid) || childPid === observedPid);
    } catch {}
    return Date.now() - stat.mtimeMs > 30_000;
  } catch { return false; }
}

export function tryAcquireFileLock(lockPath, observedPid) {
  try {
    writeSpawnLock(lockPath, { pid: process.pid }, 'wx');
    return true;
  } catch {}
  if (!isStaleSpawnLock(lockPath, observedPid)) return false;

  // Reclaim holders only perform synchronous filesystem work; an abandoned guard must expire.
  const reclaim = `${lockPath}.reclaim`;
  const owner = { pid: process.pid, startedAt: Date.now() };
  try { writeSpawnLock(reclaim, owner, 'wx'); }
  catch (err) {
    if (err?.code !== 'EEXIST') return false;
    try {
      const observed = statSync(reclaim);
      let holder;
      try { holder = JSON.parse(readFileSync(reclaim, 'utf8')); } catch {}
      const stale = Date.now() - observed.mtimeMs > 10_000 || (holder?.pid && !isPidAlive(holder.pid));
      const current = statSync(reclaim);
      if (!stale || current.ino !== observed.ino || current.mtimeMs !== observed.mtimeMs) return false;
      unlinkSync(reclaim);
      writeSpawnLock(reclaim, owner, 'wx');
    } catch { return false; }
  }
  try {
    if (!isStaleSpawnLock(lockPath, observedPid)) return false;
    unlinkSync(lockPath);
    writeSpawnLock(lockPath, { pid: process.pid }, 'wx');
    return true;
  } catch { return false; }
  finally {
    try {
      const holder = JSON.parse(readFileSync(reclaim, 'utf8'));
      if (holder.pid === owner.pid && holder.startedAt === owner.startedAt) releaseSpawnLock(reclaim);
    } catch {}
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const HEALTH_LEASE_MS = 8000;
const healthLeases = new Map();
const inFlightEnsures = new Map();

function rememberHealthy(lease) {
  healthLeases.set(lease.dataDir, { lease, expected: expectedVersion(lease.dataDir), expiresAt: Date.now() + HEALTH_LEASE_MS });
  return lease;
}

function invalidateHealth(lease) {
  if (sameDaemon(healthLeases.get(lease.dataDir)?.lease, lease)) healthLeases.delete(lease.dataDir);
}

function sameDaemon(a, b) {
  return a && b && a.pid === b.pid && a.port === b.port && a.startedAt === b.startedAt && a.token === b.token;
}

/** Maintenance uses the same authenticated loopback transport as ordinary clients.
 * Never acquire a replacement daemon or expose the discovery object to the publisher. */
export async function shutdownWhenIdle(dataDir, timeoutMs = 600000) {
  const owner = readDaemonLease(dataDir);
  if (!owner) {
    if (existsSync(join(dataDir, LEASE_FILENAME))) throw Error('Unreadable daemon identity');
    return;
  }
  if (!isPidAlive(owner.pid)) return;
  const deadline = Date.now() + timeoutMs;
  const rpc = (method, params = { limit: 1 }) => daemonRpc(method, params, { dataDir, timeoutMs: 10000, pinnedOwner: owner });
  let legacy = false;
  while (true) {
    if (!sameDaemon(owner, readDaemonLease(dataDir)) || !await verifyDaemonLeaseOwner(owner)) throw Error('Daemon identity changed');
    let drained;
    if (!legacy) {
      try {
        const prepared = await rpc('__prepareCutover');
        if (typeof prepared?.quiescing !== 'boolean') throw Error('Cutover preparation not acknowledged');
        drained = prepared.quiescing;
      } catch (error) {
        if (error?.code !== 'METHOD_NOT_FOUND') throw error;
        legacy = true;
      }
    }
    if (legacy) {
      const status = await rpc('getEvents');
      if (typeof status?.hasActiveRuns !== 'boolean') throw Error('Invalid daemon status');
      drained = !status.hasActiveRuns;
    }
    if (drained) {
      try {
        const reply = await rpc('__shutdown', { requireCutover: !legacy });
        if (!reply?.shuttingDown) throw Error('Shutdown not acknowledged');
        break;
      } catch (error) {
        if (legacy || error?.code !== 'DAEMON_BUSY') throw error;
      }
    }
    if (Date.now() >= deadline) throw Error('Daemon did not drain');
    await sleep(1000);
  }
  while (isPidAlive(owner.pid)) {
    if (Date.now() >= deadline) throw Error('Daemon still owns its files');
    await sleep(150);
  }
}

/** Serialize new daemon startup without terminating a PID from a stale lease. */
export async function ensureDaemon({ dataDir, timeoutMs = 15_000 } = {}) {
  const resolvedDir = dataDir ? resolve(dataDir) : resolveSharedDataDir();
  const applyPath = updatePath(resolvedDir, 'apply.lock');
  const applyOwner = () => readUpdateRecord(resolvedDir, 'apply.lock');
  const applyLockActive = () => isPidAlive(applyOwner()?.pid);
  const requiresRecovery = () => !applyLockActive() && (existsSync(applyPath) || hasUpdateProbation(resolvedDir));
  const cached = healthLeases.get(resolvedDir);
  if (cached?.expiresAt > Date.now() && !requiresRecovery() && cached.expected === expectedVersion(resolvedDir) && isPidAlive(cached.lease.pid) &&
      sameDaemon(cached.lease, readDaemonLease(resolvedDir))) return cached.lease;
  if (cached) healthLeases.delete(resolvedDir);
  if (inFlightEnsures.has(resolvedDir)) return inFlightEnsures.get(resolvedDir);

  const task = (async () => {
    mkdirSync(resolvedDir, { recursive: true });
    const original = readDaemonLease(resolvedDir);
    const originalHealth = await inspectDaemonHealth(original);
    if (!requiresRecovery() && supportsStudioProtocol(originalHealth.data, resolvedDir) &&
        sameDaemon(original, readDaemonLease(resolvedDir))) return rememberHealthy(original);

    const lockPath = join(resolvedDir, SPAWN_LOCK_FILENAME);
    // A concurrent lock holder can be in the middle of three slow health checks.
    const lockDeadline = Date.now() + timeoutMs + 18_000;
    if (applyLockActive()) throw Object.assign(new Error('AgentTower update in progress'), { code: 'DAEMON_UPDATING' });
    while (!tryAcquireFileLock(lockPath, readDaemonLease(resolvedDir)?.pid)) {
      if (Date.now() >= lockDeadline) throw new Error('Timed out waiting for AgentTower Core Daemon startup lock');
      await sleep(120);
    }
    let child;
    let ready = false;
    try {
      if (applyLockActive()) throw Object.assign(new Error('AgentTower update in progress'), { code: 'DAEMON_UPDATING' });
      let preferredPort;
      if (requiresRecovery()) {
        preferredPort = await recoverInterruptedUpdate(resolvedDir);
      }
      const existing = readDaemonLease(resolvedDir);
      let preserveRunningState = false;
      if (existing && isPidAlive(existing.pid)) {
        let health = sameDaemon(original, existing) ? originalHealth : await inspectDaemonHealth(existing);
        if (!health.data && !health.identityMismatch && !health.unreachable) {
          health = await inspectDaemonHealth(existing);
        }
        if (!sameDaemon(existing, readDaemonLease(resolvedDir))) {
          throw new Error('AgentTower Core Daemon lease changed during recovery; retry the request');
        }
        if (supportsStudioProtocol(health.data, resolvedDir)) return rememberHealthy(existing);
        // If the previous daemon may still be running, do not mark its jobs as orphaned.
        preserveRunningState = !health.unreachable && !health.identityMismatch;
      }

      // Release the startup lock in finally so the installer can launch the successor.
      if (applyLockActive()) throw Object.assign(new Error('AgentTower update in progress'), { code: 'DAEMON_UPDATING' });
      if (existsSync(join(resolvedDir, 'state.sqlite'))) throw Error('Legacy storage is staged for explicit cutover');
      const { execPath, extraEnv } = resolveCleanNodeExecutable();
      const mount = mountedRuntime(resolvedDir);
      const entry = mount ? join(mount.root, 'core', 'daemon.mjs') : DAEMON_ENTRY_PATH;
      const args = ['--no-warnings', entry, `--data-dir=${resolvedDir}`];
      if (preserveRunningState) args.push('--preserve-running-state');
      if (preferredPort) args.push(`--prefer-port=${preferredPort}`);
      child = spawnNoWindow(execPath, args, {
        cwd: dirname(entry), env: buildSanitizedSpawnEnv(resolvedDir, extraEnv),
        detached: true, stdio: 'ignore',
      });
      let spawnFailed = false;
      child.once('error', () => { spawnFailed = true; });
      child.unref();
      if (child.pid) writeSpawnLock(lockPath, { pid: process.pid, childPid: child.pid }, 'w');
      const deadline = Date.now() + timeoutMs;
      while (!spawnFailed && child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        const candidate = readDaemonLease(resolvedDir);
        if (candidate?.pid === child.pid &&
            await probeDaemonHealth(candidate, Math.max(1, Math.min(6000, deadline - Date.now()))) &&
            sameDaemon(candidate, readDaemonLease(resolvedDir))) {
          ready = true;
          return rememberHealthy(candidate);
        }
        await sleep(120);
      }
      throw new Error('Failed to start or connect to AgentTower Core Daemon');
    } finally {
      // Only signal the process this invocation spawned, never a PID read from disk.
      if (!ready && child?.pid && child.exitCode === null && child.signalCode === null) {
        try { child.kill(); } catch {}
      }
      releaseSpawnLock(lockPath);
    }
  })();
  inFlightEnsures.set(resolvedDir, task);
  try { return await task; }
  finally { inFlightEnsures.delete(resolvedDir); }
}

export const ensureCoreDaemonClient = ensureDaemon;

function isTransientConnError(err) {
  const code = String(err?.code || '');
  return code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'EPIPE' || code === 'UND_ERR_SOCKET' || code === 'ETIMEDOUT' || code === 'ECONNABORTED';
}

async function requestWithHealth(dataDir, request, retryConnectionError, pinnedOwner) {
  for (let attempt = 0; ; attempt++) {
    const lease = pinnedOwner || await ensureDaemon({ dataDir });
    if (pinnedOwner && (!sameDaemon(lease, readDaemonLease(dataDir)) || !await verifyDaemonLeaseOwner(lease))) throw Error("Daemon owner changed during maintenance");
    try {
      const response = await httpJsonRequest({ ...request, host: lease.host, port: lease.port, token: lease.token,
        expected: expectedVersion(lease.dataDir) });
      if ([401, 403, 503].includes(response.statusCode)) invalidateHealth(lease);
      if (response.statusCode === 503 && attempt === 0) continue;
      return response;
    } catch (err) {
      if (isTransientConnError(err)) invalidateHealth(lease);
      if (attempt !== 0 || !retryConnectionError(err)) throw err;
    }
  }
}

/**
 * Call an RPC method on the Core Daemon (`POST /rpc`).
 * Returns the unwrapped `result` payload and throws an `Error` if `ok === false`.
 */
export async function daemonRpc(method, params = {}, opts = {}) {
  const dataDir = opts.dataDir ? resolve(opts.dataDir) : undefined;
  const req = { path: '/rpc', method: 'POST', body: { method, params }, timeoutMs: opts.timeoutMs ?? 0 };
  const response = await requestWithHealth(dataDir, req, err => err?.code === 'ECONNREFUSED', opts.pinnedOwner);

  const payload = response.data;
  if (response.statusCode >= 400 || payload?.ok === false) {
    const errMsg =
      typeof payload?.error === 'string'
        ? payload.error
        : payload?.error?.message || `Daemon RPC "${method}" failed (HTTP ${response.statusCode})`;
    const err = new Error(safeEngineError(errMsg, `Daemon request failed (HTTP ${response.statusCode})`));
    err.code = payload?.code || "RPC_ERROR";
    if (payload?.details !== undefined) err.details = payload.details;
    throw err;
  }

  return payload && typeof payload === 'object' && 'result' in payload ? payload.result : payload;
}

/**
 * Perform a read-only `GET` query against the Core Daemon (e.g. `/api/bootstrap?...` or `/api/events?...`).
 */
export async function daemonGet(pathAndQuery, opts = {}) {
  const dataDir = opts.dataDir ? resolve(opts.dataDir) : undefined;
  const cleanPath = String(pathAndQuery || '/').startsWith('/') ? String(pathAndQuery) : `/${pathAndQuery}`;
  const req = { path: cleanPath, method: 'GET', timeoutMs: opts.timeoutMs ?? 15_000 };
  const response = await requestWithHealth(dataDir, req, isTransientConnError);

  const payload = response.data;
  if (response.statusCode >= 400 || payload?.ok === false) {
    const errMsg =
      typeof payload?.error === 'string'
        ? payload.error
        : payload?.error?.message || `Daemon GET "${cleanPath}" failed (HTTP ${response.statusCode})`;
    throw new Error(safeEngineError(errMsg, `Daemon request failed (HTTP ${response.statusCode})`));
  }

  if (
    payload &&
    typeof payload === 'object' &&
    payload.ok === true &&
    payload.result !== undefined &&
    !('threads' in payload) &&
    !('events' in payload)
  ) {
    return payload.result;
  }
  return payload;
}

/**
 * Open a live Server-Sent Events (SSE) subscription to the Core Daemon (`/api/stream`).
 * Returns a `{ close() }` handle (compatible with both `handle.close()` and cleanup patterns).
 */
export async function openDaemonStream({
  sinceSeq = 0,
  workspace = '',
  conversationId = '',
  appDataDir = '',
  onData,
  onError,
  signal,
  dataDir,
} = {}) {
  const daemon = await ensureDaemon(dataDir ? { dataDir } : {});
  const qs = new URLSearchParams();
  qs.set('sinceSeq', String(Math.max(0, Math.floor(Number(sinceSeq) || 0))));
  if (workspace) qs.set('workspace', String(workspace));
  if (conversationId) qs.set('conversationId', String(conversationId));
  if (appDataDir) qs.set('appDataDir', String(appDataDir));

  let closed = false;
  let req = null;

  function close() {
    if (closed) return;
    closed = true;
    if (req) {
      try {
        req.destroy();
      } catch {}
      req = null;
    }
  }

  if (signal) {
    if (signal.aborted) {
      close();
      return { close };
    }
    signal.addEventListener('abort', close, { once: true });
  }

  req = http.request(
    {
      host: daemon.host,
      port: daemon.port,
      path: `/api/stream?${qs.toString()}`,
      method: 'GET',
      headers: {
        Accept: 'text/event-stream',
        'Cache-Control': 'no-cache',
        'X-Daemon-Token': daemon.token,
        ...(encodeHostContextHeader(process.env, true)
          ? { 'X-Host-Context': encodeHostContextHeader(process.env, true) }
          : {}),
      },
      agent: false,
    },
    (res) => {
      if (res.statusCode !== 200) {
        if (!closed) {
          onError?.(new Error(`Daemon SSE stream returned HTTP ${res.statusCode}`));
          close();
        }
        return;
      }

      res.setEncoding('utf8');
      let buffer = '';

      res.on('data', (chunk) => {
        if (closed) return;
        buffer += chunk;
        let boundaryIdx;
        while ((boundaryIdx = buffer.indexOf('\n\n')) >= 0) {
          const rawBlock = buffer.slice(0, boundaryIdx);
          buffer = buffer.slice(boundaryIdx + 2);
          if (!rawBlock.trim()) continue;

          const dataLines = [];
          for (const rawLine of rawBlock.split(/\r?\n/)) {
            if (rawLine.startsWith(':')) continue;
            if (rawLine.startsWith('data:')) {
              dataLines.push(rawLine.slice(5).trimStart());
            }
          }
          if (dataLines.length === 0) continue;

          const joined = dataLines.join('\n');
          try {
            const parsed = JSON.parse(joined);
            onData?.(parsed);
          } catch {
            onData?.(joined);
          }
        }
      });

      res.on('end', () => {
        if (!closed) {
          onError?.(new Error('Daemon SSE stream ended'));
          close();
        }
      });

      res.on('error', (err) => {
        if (isTransientConnError(err)) invalidateHealth(daemon);
        if (!closed) {
          onError?.(err);
          close();
        }
      });
    }
  );

  req.on('error', (err) => {
    if (isTransientConnError(err)) invalidateHealth(daemon);
    if (!closed) {
      onError?.(err);
      close();
    }
  });

  req.end();

  return { close };
}

/**
 * v0.2.6 C06①：Sidecar `/api/health` 的非阻塞 Daemon 快照——只读当前 lease 并做一次短超时 `/healthz` 探针，
 * 绝不拉起 / 等待 Daemon；Daemon 未起、繁忙或身份不符一律返回 `{ reachable: false }`，永不抛错。
 */
export async function peekDaemonHealth({ dataDir, timeoutMs = 300 } = {}) {
  try {
    const lease = readDaemonLease(dataDir ? resolve(dataDir) : resolveSharedDataDir());
    if (!lease) return { reachable: false };
    let timer;
    const deadline = new Promise((r) => { timer = setTimeout(() => r({ timedOut: true }), timeoutMs); });
    const health = await Promise.race([inspectDaemonHealth(lease, timeoutMs), deadline]).finally(() => clearTimeout(timer));
    const data = health?.data;
    if (!data) return { reachable: false, pid: lease.pid, port: lease.port, ...(health?.timedOut ? { busy: true } : {}) };
    return {
      reachable: true,
      pid: lease.pid,
      port: lease.port,
      version: String(data.releaseVersion || data.version || ''),
      compatible: supportsStudioProtocol(data, lease.dataDir),
    };
  } catch {
    return { reachable: false };
  }
}

/** 诊断分段：仅区分路由族，绝不保留 query / 动态片段（防 token / 会话 ID 落盘）。 */
export function classifySidecarRequestPath(rawUrl) {
  const pathname = String(rawUrl || '').split('?', 1)[0].split('#', 1)[0];
  if (pathname === '/api/rpc') return '/api/rpc';
  if (pathname.startsWith('/_sidecar/')) return /^\/_sidecar\/[a-z0-9-]{1,48}$/.test(pathname) ? pathname : '/_sidecar/*';
  if (pathname.startsWith('/api/')) return /^\/api\/[a-z0-9-]{1,32}$/.test(pathname) ? pathname : '/api/*';
  return '';
}

/**
 * v0.2.6 C07②：Sidecar 响应完成钩子的脱敏限频诊断 + 冷却自退护栏（纯函数工厂，全部依赖可注入便于单测）。
 * - 诊断：仅对 `/api/rpc`、`/_sidecar/*`、`/api/*` 的 401 / 500 / 503 与版本漂移计数，按窗口限频输出一行；
 *   只记录路由族、状态码、计数与耗时，严禁记录 URL query、token、Cookie、CSRF。
 * - 自退：距进程启动满冷却期（默认 5 分钟，防重启死循环）且窗口内（默认 30s）连续 ≥ 3 次「携带了 x-sidecar-token 却返回 401」
 *   时，打印一行脱敏告警并延迟 150ms 优雅退出，交由宿主 `restart_policy: "always"` 重拉刷新凭据；
 *   任何非 401 的带 token 响应会清零连续计数，未带 token 的 401 永不计入；`disabled` 时只诊断不退出。
 */
export function createSidecarRequestMonitor({
  startedAt = Date.now(),
  now = () => Date.now(),
  log = () => {},
  exit = () => {},
  schedule = (fn, ms) => setTimeout(fn, ms),
  disabled = false,
  cooldownMs = 5 * 60 * 1000,
  windowMs = 30_000,
  threshold = 3,
  exitDelayMs = 150,
  logIntervalMs = 60_000,
  isVersionDrifted = () => false,
} = {}) {
  const counts = new Map();
  let lastLogAt = 0;
  let tokenRejects = [];
  let exiting = false;
  let driftReported = false;

  function flushDiagnostics(at) {
    if (!counts.size || at - lastLogAt < logIntervalMs) return;
    lastLogAt = at;
    const summary = [...counts].map(([key, { n, maxMs }]) => `${key}×${n}${maxMs ? ` (max ${maxMs}ms)` : ''}`).join(', ');
    counts.clear();
    log(`[agent-tower/studio] sidecar http diagnostics: ${summary}`);
  }

  function observe({ url, status, hadSidecarToken = false, durationMs = 0 } = {}) {
    const route = classifySidecarRequestPath(url);
    const at = now();
    if (!route) return { route, exiting };
    const code = Number(status) || 0;
    if (code === 401 || code === 500 || code === 503) {
      const key = `${route} ${code}`;
      const prev = counts.get(key) || { n: 0, maxMs: 0 };
      counts.set(key, { n: prev.n + 1, maxMs: Math.max(prev.maxMs, Math.round(Number(durationMs) || 0)) });
    }
    if (!driftReported && isVersionDrifted()) {
      driftReported = true;
      counts.set('plugin.json version drift', { n: 1, maxMs: 0 });
      lastLogAt = 0;
    }
    flushDiagnostics(at);

    if (hadSidecarToken) {
      if (code === 401) tokenRejects = [...tokenRejects.filter((t) => at - t <= windowMs), at];
      else tokenRejects = [];
    }
    const cooled = at - startedAt >= cooldownMs;
    if (!disabled && !exiting && cooled && tokenRejects.length >= threshold) {
      exiting = true;
      log(`[agent-tower/studio] ${tokenRejects.length} consecutive sidecar-token 401 responses within ${Math.round(windowMs / 1000)}s; host token likely rotated, exiting for host restart`);
      schedule(() => exit(0), exitDelayMs);
    }
    return { route, exiting };
  }

  return { observe, get exiting() { return exiting; } };
}

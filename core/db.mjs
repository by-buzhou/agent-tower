import fs, { mkdirSync } from "node:fs";
import * as path from "node:path";

// Suppress Node's ExperimentalWarning for built-in `node:sqlite` without hiding real warnings
if (!globalThis.__AGENT_TOWER_SQLITE_WARN_FILTERED__) {
  globalThis.__AGENT_TOWER_SQLITE_WARN_FILTERED__ = true;
  const origEmitWarning = process.emitWarning;
  process.emitWarning = function filteredEmitWarning(warning, ...args) {
    const msg = typeof warning === "string" ? warning : warning?.message || "";
    if (msg.includes("SQLite is an experimental feature")) return;
    return origEmitWarning.call(process, warning, ...args);
  };
}

function getDatabaseSyncClass() {
  const sqliteMod = process.getBuiltinModule("node:sqlite");
  if (!sqliteMod || typeof sqliteMod.DatabaseSync !== "function") {
    throw new Error("Built-in node:sqlite DatabaseSync is unavailable in this Node runtime.");
  }
  return sqliteMod.DatabaseSync;
}

/* ---------- v0.2.7 gentle compaction: dual high-water marks + reserved free-page buffer ---------- */
export const DEFAULT_COMPACT_MIN_FREE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_COMPACT_MIN_FREE_RATIO = 0.5;
export const DEFAULT_COMPACT_RESERVE_FREE_BYTES = 28 * 1024 * 1024;
const EVENT_WINDOW = 1500;
const SQLITE_MAGIC = "SQLite format 3\0";

function compactThresholds(opts = {}) {
  const num = (v, d) => (v !== undefined && v !== null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
  return {
    minFreeBytes: num(opts.minFreeBytes, DEFAULT_COMPACT_MIN_FREE_BYTES),
    minFreeRatio: num(opts.minFreeRatio, DEFAULT_COMPACT_MIN_FREE_RATIO),
    reserveFreeBytes: num(opts.reserveFreeBytes, DEFAULT_COMPACT_RESERVE_FREE_BYTES),
  };
}

// Shared result shape of the header probe and the live-connection probe.
function summarizeStorage({ pageSize = 0, pageCount = 0, freelistCount = 0, autoVacuum = 0 } = {}, opts = {}, extra = {}) {
  const { minFreeBytes, minFreeRatio, reserveFreeBytes } = compactThresholds(opts);
  const freePages = Math.min(freelistCount, pageCount);
  const totalBytes = pageSize * pageCount;
  const freeBytes = pageSize * freePages;
  const freeRatio = pageCount > 0 ? freePages / pageCount : 0;
  const overWatermark = freeBytes > minFreeBytes && freeRatio > minFreeRatio;
  const reclaimableBytes = overWatermark ? (autoVacuum === 2 ? Math.max(0, freeBytes - reserveFreeBytes) : freeBytes) : 0;
  return { exists: true, ...extra, pageSize, pageCount, freelistCount, autoVacuum, totalBytes, freeBytes, freeRatio, overWatermark, reclaimableBytes };
}

/**
 * Strictly read-only SQLite page-header probe: reads the first 100 bytes only — never opens a SQLite
 * connection, never creates `-wal` / `-shm`, never writes logs. Pages still in an un-checkpointed WAL are not seen.
 */
export function inspectSqliteHeaderFile(filePath, opts = {}) {
  const empty = reason => ({ ...summarizeStorage({}, opts), exists: reason !== "missing", valid: false, reason });
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return empty("missing");
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return empty("not_file");
    const header = Buffer.alloc(100);
    if (fs.readSync(fd, header, 0, 100, 0) < 100 || header.toString("latin1", 0, 16) !== SQLITE_MAGIC) return empty("invalid_header");
    const rawPageSize = header.readUInt16BE(16);
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize;
    if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0) return empty("invalid_header");
    let pageCount = header.readUInt32BE(28);
    // The in-header page count is only trustworthy while the change counter matches "version-valid-for".
    if (pageCount === 0 || header.readUInt32BE(24) !== header.readUInt32BE(92)) pageCount = Math.floor(st.size / pageSize);
    const freelistCount = header.readUInt32BE(36);
    const autoVacuum = header.readUInt32BE(52) === 0 ? 0 : header.readUInt32BE(64) !== 0 ? 2 : 1;
    return summarizeStorage({ pageSize, pageCount, freelistCount, autoVacuum }, opts, { valid: true, source: "header" });
  } catch {
    return empty("read_failed");
  } finally {
    try { fs.closeSync(fd); } catch {}
  }
}

function safeJsonParse(str, fallback = null) {
  if (str === null || str === undefined || str === "") return fallback;
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

function normalizeWorkspaceKey(ws) {
  if (!ws || typeof ws !== "string") return "";
  return path.resolve(ws).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Pick a string field where passing `null` or `""` explicitly clears the field to `""`,
 * while `undefined` preserves `fallback`.
 */
function pickStr(val, fallback = "") {
  return val !== undefined ? String(val ?? "") : String(fallback ?? "");
}

const DEFAULT_USAGE = Object.freeze({
  inputTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  contextUsed: 0,
  contextLimit: 0,
});
const SAME_ORDER_INTENTS = new Set(["steer", "steering_restart", "follow_up", "continue", "chat"]);
const RUN_TOKEN_FIELDS = ["inputTokens", "cachedTokens", "reasoningTokens", "outputTokens", "totalTokens"];

// Hydrated threads retain access to their owning SQLite connection through the project-store facade.
const threadDbAccess = new WeakMap();
export const specLedgerForThread = thread => threadDbAccess.get(thread)?.specLedger;

export function summarizeThreadRunRollups(threads = []) {
  const threadsByReader = new Map();
  for (const thread of threads) {
    const readRollups = threadDbAccess.get(thread)?.summarizeThreadRunRollups;
    if (!readRollups) continue;
    if (!threadsByReader.has(readRollups)) threadsByReader.set(readRollups, []);
    threadsByReader.get(readRollups).push(thread);
  }
  const rollups = new Map();
  for (const [readRollups, projectThreads] of threadsByReader) {
    for (const [id, rollup] of readRollups(projectThreads)) rollups.set(id, rollup);
  }
  return rollups;
}

/**
 * Open and initialize the SQLite WAL database for AgentTower.
 * Zero external dependencies — powered by Node v22.5+/v24 built-in `node:sqlite`.
 *
 * @param {string} dbPath Absolute path to the `.sqlite` database file (or `:memory:`)
 */
function readSpecCuration(db) {
  const proposals = db.prepare("SELECT record_json FROM spec_proposals ORDER BY created_at DESC, rowid DESC LIMIT 20")
    .all().map(row => JSON.parse(row.record_json));
  const pending = db.prepare("SELECT record_json FROM spec_proposals WHERE status = 'pending' ORDER BY rowid DESC LIMIT 1").get();
  const state = db.prepare("SELECT value_json FROM settings WHERE key = 'spec_curation_state'").get();
  return { ...JSON.parse(state?.value_json || "{}"), proposals, pendingProposal: pending ? JSON.parse(pending.record_json) : null };
}

export function probeSpecCuration(dbPath) {
  const DatabaseSync = getDatabaseSyncClass();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'spec_proposals'").get()) return {};
    return readSpecCuration(db);
  } finally { db.close(); }
}

export function openOrchestratorDb(dbPath) {
  if (dbPath && dbPath !== ":memory:") {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const DatabaseSync = getDatabaseSyncClass();
  const db = new DatabaseSync(dbPath || ":memory:");

  db.exec("PRAGMA busy_timeout = 5000;");
  // Fresh databases start in INCREMENTAL auto-vacuum mode (only possible before the first table exists).
  if (Number(db.prepare("PRAGMA page_count").get()?.page_count) === 0) db.exec("PRAGMA auto_vacuum = INCREMENTAL;");
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS spec_ledger (
      provider TEXT NOT NULL,
      native_session_id TEXT NOT NULL,
      spec_key TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      tier TEXT NOT NULL,
      run_id TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, native_session_id, spec_key)
    );

    CREATE TABLE IF NOT EXISTS spec_proposals (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL UNIQUE,
      root_conversation_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      record_json TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_spec_proposals_status ON spec_proposals(status, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS command_receipts (
      command_id TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_policies (
      conversation_id TEXT PRIMARY KEY,
      orchestration_mode TEXT NOT NULL DEFAULT 'direct',
      dispatch_enabled INTEGER NOT NULL,
      policy_revision INTEGER NOT NULL DEFAULT 1,
      source TEXT NOT NULL DEFAULT 'explicit',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS health_incidents (
      id TEXT PRIMARY KEY,
      root_conversation_id TEXT NOT NULL DEFAULT '',
      thread_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'warning',
      status TEXT NOT NULL DEFAULT 'open',
      title TEXT NOT NULL DEFAULT '',
      detail TEXT NOT NULL DEFAULT '',
      action_taken TEXT NOT NULL DEFAULT '',
      retry_attempt INTEGER NOT NULL DEFAULT 0,
      notified_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_health_conversation ON health_incidents(root_conversation_id, status, updated_at);
    CREATE INDEX IF NOT EXISTS idx_health_thread ON health_incidents(thread_id, status);

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT '未命名任务线程',
      role TEXT NOT NULL DEFAULT 'general',
      preset_key TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'idle',
      work_state TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT 'kimi-code',
      model TEXT NOT NULL DEFAULT 'kimi-code/k3.1-pro',
      effort TEXT NOT NULL DEFAULT 'high',
      permission_mode TEXT NOT NULL DEFAULT 'auto',
      interaction_mode TEXT NOT NULL DEFAULT 'default',
      isolation TEXT NOT NULL DEFAULT 'shared',
      cwd TEXT NOT NULL DEFAULT '',
      workspace_key TEXT NOT NULL DEFAULT '',
      worktree_path TEXT NOT NULL DEFAULT '',
      worktree_id TEXT NOT NULL DEFAULT '',
      branch TEXT NOT NULL DEFAULT '',
      parent_thread_id TEXT,
      host_conversation_id TEXT NOT NULL DEFAULT '',
      root_conversation_id TEXT NOT NULL DEFAULT '',
      native_session_id TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      active_run_id TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      usage_json TEXT NOT NULL DEFAULT '{}',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_threads_parent ON threads(parent_thread_id);
    CREATE INDEX IF NOT EXISTS idx_threads_task ON threads(task_id);
    CREATE INDEX IF NOT EXISTS idx_threads_ws ON threads(workspace_key, updated_at DESC);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      root_conversation_id TEXT NOT NULL DEFAULT '',
      ordinal INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'queued',
      prompt TEXT NOT NULL DEFAULT '',
      input_intent TEXT NOT NULL DEFAULT 'turn_start',
      fresh_context INTEGER NOT NULL DEFAULT 0,
      queue_position INTEGER NOT NULL DEFAULT 0,
      provider TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      effort TEXT NOT NULL DEFAULT '',
      permission_mode TEXT NOT NULL DEFAULT '',
      interaction_mode TEXT NOT NULL DEFAULT '',
      native_session_id TEXT NOT NULL DEFAULT '',
      assistant_text TEXT NOT NULL DEFAULT '',
      reasoning_text TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      usage_json TEXT NOT NULL DEFAULT '{}',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_runs_thread ON runs(thread_id, ordinal ASC);
    CREATE INDEX IF NOT EXISTS idx_runs_queue ON runs(thread_id, status, queue_position ASC);

    CREATE TABLE IF NOT EXISTS turn_items (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL DEFAULT '',
      ordinal INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'completed',
      title TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      command TEXT NOT NULL DEFAULT '',
      output TEXT NOT NULL DEFAULT '',
      exit_code INTEGER,
      file_path TEXT NOT NULL DEFAULT '',
      additions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      diff TEXT NOT NULL DEFAULT '',
      entries_json TEXT NOT NULL DEFAULT '[]',
      raw_input_json TEXT,
      error TEXT NOT NULL DEFAULT '',
      input_intent TEXT NOT NULL DEFAULT '',
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_turn_items_thread ON turn_items(thread_id, ordinal ASC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_turn_items_run ON turn_items(run_id, ordinal ASC);

    CREATE TABLE IF NOT EXISTS runtime_requests (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL DEFAULT '',
      provider TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'approval',
      status TEXT NOT NULL DEFAULT 'pending',
      title TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      preview TEXT NOT NULL DEFAULT '',
      tool_call_id TEXT NOT NULL DEFAULT '',
      options_json TEXT NOT NULL DEFAULT '[]',
      questions_json TEXT,
      multi_select INTEGER NOT NULL DEFAULT 0,
      resolution_json TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_runtime_req_status ON runtime_requests(status, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_runtime_req_thread ON runtime_requests(thread_id, status);

    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      root_conversation_id TEXT NOT NULL DEFAULT '',
      run_id TEXT NOT NULL DEFAULT '',
      workspace_key TEXT NOT NULL DEFAULT '',
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_events_thread_seq ON events(thread_id, seq ASC);
    CREATE INDEX IF NOT EXISTS idx_events_ws_seq ON events(workspace_key, seq ASC);
  `);

  // Prepared statements for hot paths
  const policyModes = new Set(["direct", "relay", "complex"]);
  const normalizePolicyMode = value => {
    const raw = String(value || "");
    if (raw === "simple") return "relay";
    if (/^custom:[a-z0-9][a-z0-9_-]*$/.test(raw)) return "complex";
    return policyModes.has(raw) ? raw : "direct";
  };
  const isPolicyMode = value => policyModes.has(String(value || ""));
  function migrateRootConversationColumns() {
    for (const table of ["threads", "runs", "events"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
      if (!columns.includes("root_conversation_id")) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN root_conversation_id TEXT NOT NULL DEFAULT ''`);
      }
    }

    const threadRows = db.prepare(`SELECT id, parent_thread_id, host_conversation_id, root_conversation_id, meta_json FROM threads`).all();
    const threadsById = new Map(threadRows.map(row => [row.id, row]));
    const resolvedRoots = new Map();
    const resolving = new Set();
    function resolveThreadRoot(row) {
      if (!row) return "";
      const existing = String(row.root_conversation_id || "").trim();
      if (existing) {
        resolvedRoots.set(row.id, existing);
        return existing;
      }
      if (resolvedRoots.has(row.id)) return resolvedRoots.get(row.id);
      if (resolving.has(row.id)) return "";
      resolving.add(row.id);
      const meta = safeJsonParse(row.meta_json, {}) || {};
      let root = String(meta.rootConversationId || meta.parentConversationId || "").trim();
      if (!root && row.parent_thread_id) root = resolveThreadRoot(threadsById.get(row.parent_thread_id));
      if (!root && !row.parent_thread_id) root = String(row.host_conversation_id || "").trim();
      resolving.delete(row.id);
      resolvedRoots.set(row.id, root);
      return root;
    }
    const updateThreadRoot = db.prepare("UPDATE threads SET root_conversation_id=? WHERE id=? AND root_conversation_id=''");
    for (const row of threadRows) {
      const root = resolveThreadRoot(row);
      if (root) updateThreadRoot.run(root, row.id);
    }

    const updateRunRoot = db.prepare("UPDATE runs SET root_conversation_id=? WHERE id=? AND root_conversation_id=''");
    const runRows = db.prepare("SELECT id, thread_id, meta_json FROM runs WHERE root_conversation_id=''").all();
    for (const row of runRows) {
      const meta = safeJsonParse(row.meta_json, {}) || {};
      const root = String(meta.rootConversationId || meta.parentConversationId || resolvedRoots.get(row.thread_id) || "").trim();
      if (root) updateRunRoot.run(root, row.id);
    }

    const updateEventRoot = db.prepare("UPDATE events SET root_conversation_id=? WHERE seq=? AND root_conversation_id=''");
    const eventRows = db.prepare("SELECT seq, thread_id, payload_json FROM events WHERE root_conversation_id=''").all();
    for (const row of eventRows) {
      const payload = safeJsonParse(row.payload_json, {}) || {};
      const root = String(payload.rootConversationId || payload.swarm?.rootConversationId || resolvedRoots.get(row.thread_id) || "").trim();
      if (root) updateEventRoot.run(root, row.seq);
    }

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_threads_root_conv ON threads(root_conversation_id COLLATE NOCASE, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_threads_ws_role_root ON threads(workspace_key, role, root_conversation_id COLLATE NOCASE) WHERE archived_at IS NULL;
      CREATE INDEX IF NOT EXISTS idx_runs_root_conv ON runs(root_conversation_id COLLATE NOCASE, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_events_root_seq ON events(root_conversation_id COLLATE NOCASE, seq ASC);
    `);
  }
  const policyColumns = db.prepare("PRAGMA table_info(conversation_policies)").all().map(row => row.name);
  db.exec("BEGIN");
  try {
    migrateRootConversationColumns();
    if (!policyColumns.includes("orchestration_mode")) {
      db.exec("ALTER TABLE conversation_policies ADD COLUMN orchestration_mode TEXT NOT NULL DEFAULT 'direct'");
      db.exec("UPDATE conversation_policies SET orchestration_mode = CASE WHEN dispatch_enabled = 0 THEN 'direct' ELSE 'relay' END");
    } else {
      db.exec("UPDATE conversation_policies SET orchestration_mode = CASE WHEN dispatch_enabled = 0 THEN 'direct' ELSE 'relay' END WHERE orchestration_mode IS NULL OR orchestration_mode = ''");
    }
    // Migrate legacy names before validating the allowed three-mode enum.
    db.exec("UPDATE conversation_policies SET orchestration_mode = 'relay' WHERE orchestration_mode = 'simple'");
    db.exec("UPDATE conversation_policies SET orchestration_mode = 'complex' WHERE orchestration_mode LIKE 'custom:%'");
    const policyRows = db.prepare("SELECT conversation_id, orchestration_mode, dispatch_enabled FROM conversation_policies").all();
    const repair = db.prepare("UPDATE conversation_policies SET orchestration_mode=?, dispatch_enabled=? WHERE conversation_id=?");
    for (const row of policyRows) {
      const mode = normalizePolicyMode(row.orchestration_mode);
      if (!isPolicyMode(mode) || (mode === "direct" && Number(row.dispatch_enabled) !== 0)) repair.run("direct", 0, row.conversation_id);
      else repair.run(mode, mode === "direct" ? 0 : 1, row.conversation_id);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  const stmtGetReceipt = db.prepare(`SELECT method, result_json FROM command_receipts WHERE command_id = ?`);
  const stmtClaimReceipt = db.prepare(`
    INSERT INTO command_receipts (command_id, method, result_json, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(command_id) DO NOTHING
  `);
  const stmtReleaseReceipt = db.prepare(`
    DELETE FROM command_receipts WHERE command_id = ? AND result_json = ?
      AND NOT EXISTS (SELECT 1 FROM threads WHERE id = ?)
  `);
  const stmtSaveReceipt = db.prepare(`
    INSERT OR REPLACE INTO command_receipts (command_id, method, result_json, created_at)
    VALUES (?, ?, ?, ?)
  `);

  const stmtGetThread = db.prepare(`SELECT * FROM threads WHERE id = ?`);
  const stmtGetThreadByTask = db.prepare(`SELECT * FROM threads WHERE task_id = ? LIMIT 1`);
  const stmtUpsertThread = db.prepare(`
    INSERT INTO threads (
      id, title, role, preset_key, status, work_state,
      provider, model, effort, permission_mode, interaction_mode, isolation,
      cwd, workspace_key, worktree_path, worktree_id, branch,
      parent_thread_id, host_conversation_id, root_conversation_id, native_session_id, task_id, active_run_id,
      summary, error, usage_json, meta_json,
      created_at, started_at, updated_at, completed_at, duration_ms, archived_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      role = excluded.role,
      preset_key = excluded.preset_key,
      status = excluded.status,
      work_state = excluded.work_state,
      provider = excluded.provider,
      model = excluded.model,
      effort = excluded.effort,
      permission_mode = excluded.permission_mode,
      interaction_mode = excluded.interaction_mode,
      isolation = excluded.isolation,
      cwd = excluded.cwd,
      workspace_key = excluded.workspace_key,
      worktree_path = excluded.worktree_path,
      worktree_id = excluded.worktree_id,
      branch = excluded.branch,
      parent_thread_id = excluded.parent_thread_id,
      host_conversation_id = excluded.host_conversation_id,
      root_conversation_id = excluded.root_conversation_id,
      native_session_id = excluded.native_session_id,
      task_id = excluded.task_id,
      active_run_id = excluded.active_run_id,
      summary = excluded.summary,
      error = excluded.error,
      usage_json = excluded.usage_json,
      meta_json = excluded.meta_json,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      duration_ms = excluded.duration_ms,
      archived_at = COALESCE(threads.archived_at, excluded.archived_at)
  `);

  const stmtGetRun = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  const stmtNextRunOrdinal = db.prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ord FROM runs WHERE thread_id = ?`);
  const stmtNextQueuePos = db.prepare(`
    SELECT COALESCE(MAX(queue_position), 0) + 1 AS next_pos
    FROM runs WHERE thread_id = ? AND status = 'queued'
  `);
  const stmtUpsertRun = db.prepare(`
    INSERT INTO runs (
      id, thread_id, root_conversation_id, ordinal, status, prompt, input_intent, fresh_context, queue_position,
      provider, model, effort, permission_mode, interaction_mode, native_session_id,
      assistant_text, reasoning_text, error, usage_json, meta_json,
      created_at, started_at, updated_at, completed_at, duration_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      root_conversation_id = excluded.root_conversation_id,
      status = excluded.status,
      prompt = excluded.prompt,
      input_intent = excluded.input_intent,
      fresh_context = excluded.fresh_context,
      queue_position = excluded.queue_position,
      provider = excluded.provider,
      model = excluded.model,
      effort = excluded.effort,
      permission_mode = excluded.permission_mode,
      interaction_mode = excluded.interaction_mode,
      native_session_id = excluded.native_session_id,
      assistant_text = excluded.assistant_text,
      reasoning_text = excluded.reasoning_text,
      error = excluded.error,
      usage_json = excluded.usage_json,
      meta_json = excluded.meta_json,
      started_at = excluded.started_at,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      duration_ms = excluded.duration_ms
  `);

  const stmtGetTurnItem = db.prepare(`SELECT * FROM turn_items WHERE id = ?`);
  const stmtNextItemOrdinal = db.prepare(`SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ord FROM turn_items WHERE thread_id = ?`);
  const stmtUpsertTurnItem = db.prepare(`
    INSERT INTO turn_items (
      id, thread_id, run_id, ordinal, type, status, title, text,
      command, output, exit_code, file_path, additions, deletions, diff,
      entries_json, raw_input_json, error, input_intent, meta_json,
      created_at, updated_at, completed_at, duration_ms
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      run_id = excluded.run_id,
      type = excluded.type,
      status = excluded.status,
      title = excluded.title,
      text = excluded.text,
      command = excluded.command,
      output = excluded.output,
      exit_code = excluded.exit_code,
      file_path = excluded.file_path,
      additions = excluded.additions,
      deletions = excluded.deletions,
      diff = excluded.diff,
      entries_json = excluded.entries_json,
      raw_input_json = excluded.raw_input_json,
      error = excluded.error,
      input_intent = excluded.input_intent,
      meta_json = excluded.meta_json,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      duration_ms = excluded.duration_ms
  `);

  const stmtAppendItemDelta = db.prepare(`
    UPDATE turn_items
    SET
      text = CASE WHEN ? != '' THEN text || ? ELSE text END,
      output = CASE WHEN ? != '' THEN output || ? ELSE output END,
      diff = CASE WHEN ? IS NOT NULL THEN ? ELSE diff END,
      status = COALESCE(?, status),
      updated_at = ?
    WHERE id = ?
  `);

  const stmtGetRuntimeReq = db.prepare(`SELECT * FROM runtime_requests WHERE id = ?`);
  const stmtUpsertRuntimeReq = db.prepare(`
    INSERT INTO runtime_requests (
      id, thread_id, run_id, provider, kind, status, title, description, preview,
      tool_call_id, options_json, questions_json, multi_select, resolution_json,
      created_at, updated_at, resolved_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?, ?
    )
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      title = excluded.title,
      description = excluded.description,
      preview = excluded.preview,
      options_json = excluded.options_json,
      questions_json = excluded.questions_json,
      multi_select = excluded.multi_select,
      resolution_json = excluded.resolution_json,
      updated_at = excluded.updated_at,
      resolved_at = excluded.resolved_at
  `);

  const stmtInsertEvent = db.prepare(`
    INSERT INTO events (seq, type, thread_id, root_conversation_id, run_id, workspace_key, payload_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const stmtLatestSeq = db.prepare(`SELECT COALESCE(MAX(seq), 0) AS latest_seq FROM events`);
  // events only carries lightweight change signals: batch-trimmed to a rolling window (sinceSeq cursors stay valid).
  const stmtCutoffSeq = db.prepare(`SELECT seq FROM events ORDER BY seq DESC LIMIT 1 OFFSET ${EVENT_WINDOW}`);
  const stmtDeleteBeforeSeq = db.prepare("DELETE FROM events WHERE seq <= ?");
  let eventsSinceTrim = 0;
  function trimEvents() {
    eventsSinceTrim = 0;
    const cutoff = stmtCutoffSeq.get();
    return cutoff ? Number(stmtDeleteBeforeSeq.run(cutoff.seq).changes) : 0;
  }
  const shouldTrimEvents = (batchSize = 200) => eventsSinceTrim >= Math.max(1, Number(batchSize) || 200);

  function hydrateUsage(rawJson) {
    const parsed = safeJsonParse(rawJson, {}) || {};
    const inputTokens = Number(parsed.inputTokens ?? parsed.input_tokens ?? 0);
    const cachedTokens = Number(parsed.cachedTokens ?? parsed.cachedInputTokens ?? parsed.cachedReadTokens ?? 0);
    const reasoningTokens = Number(parsed.reasoningTokens ?? parsed.reasoningOutputTokens ?? parsed.thoughtTokens ?? 0);
    const outputTokens = Number(parsed.outputTokens ?? parsed.output_tokens ?? 0);
    const totalTokens = Number(parsed.totalTokens ?? parsed.total_tokens ?? (inputTokens + outputTokens));
    return {
      inputTokens,
      cachedTokens,
      reasoningTokens,
      outputTokens,
      totalTokens,
      contextUsed: Number(parsed.contextUsed ?? parsed.used ?? 0),
      contextLimit: Number(parsed.contextLimit ?? parsed.modelContextWindow ?? parsed.size ?? 0),
    };
  }

  function rowToThread(row, { includeQueue = true, includeItems = false } = {}) {
    if (!row) return null;
    const meta = safeJsonParse(row.meta_json, {}) || {};
    const usage = hydrateUsage(row.usage_json);
    const thread = {
      id: row.id,
      threadId: row.id,
      title: row.title,
      role: row.role,
      presetKey: row.preset_key,
      status: row.status,
      workState: row.work_state || "",
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      permissionMode: row.permission_mode,
      runtimeMode: row.permission_mode,
      interactionMode: row.interaction_mode,
      isolation: row.isolation,
      cwd: row.cwd,
      worktreePath: row.worktree_path || "",
      worktreeId: row.worktree_id || "",
      branch: row.branch || "",
      parentThreadId: row.parent_thread_id || null,
      hostConversationId: row.host_conversation_id || "",
      rootConversationId: row.root_conversation_id || "",
      nativeSessionId: row.native_session_id || "",
      isNativeHost: Boolean(meta.isNativeHost || String(row.id).startsWith("thr_native_") || (row.provider === "antigravity" && row.host_conversation_id)),
      source: meta.source || (meta.isNativeHost || row.host_conversation_id ? "host-transcript" : "delegate"),
      taskId: row.task_id || "",
      activeRunId: row.active_run_id || "",
      summary: row.summary || "",
      error: row.error || "",
      lastError: row.error || "",
      usage,
      meta,
      createdAt: row.created_at,
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? null,
      durationMs: row.duration_ms || 0,
      archived: Boolean(row.archived_at),
      archivedAt: row.archived_at ?? null,
    };
    if (includeQueue) {
      thread.queue = listQueuedRuns(row.id).map((r) => ({
        id: r.id,
        queuedRunId: r.id,
        runId: r.id,
        text: r.prompt,
        message: r.prompt,
        queuePosition: r.queuePosition,
        createdAt: r.createdAt,
      }));
    }
    if (includeItems) {
      thread.items = listTurnItems({ threadId: row.id });
    }
    threadDbAccess.set(thread, threadAccess);
    return thread;
  }

  function rowToRun(row) {
    if (!row) return null;
    const meta = safeJsonParse(row.meta_json, {}) || {};
    return {
      id: row.id,
      runId: row.id,
      threadId: row.thread_id,
      rootConversationId: row.root_conversation_id || "",
      ordinal: row.ordinal,
      status: row.status,
      prompt: row.prompt,
      text: row.prompt,
      inputIntent: row.input_intent,
      freshContext: Boolean(row.fresh_context),
      queuePosition: row.queue_position,
      provider: row.provider,
      model: row.model,
      effort: row.effort,
      permissionMode: row.permission_mode,
      interactionMode: row.interaction_mode,
      nativeSessionId: row.native_session_id,
      assistantText: row.assistant_text,
      reasoningText: row.reasoning_text,
      error: row.error,
      usage: hydrateUsage(row.usage_json),
      ...(meta.role ? { role: meta.role } : {}),
      meta,
      createdAt: row.created_at,
      startedAt: row.started_at ?? null,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? null,
      durationMs: row.duration_ms || 0,
    };
  }

  function rowToTurnItem(row) {
    if (!row) return null;
    return {
      id: row.id,
      threadId: row.thread_id,
      runId: row.run_id,
      ordinal: row.ordinal,
      type: row.type,
      status: row.status,
      title: row.title,
      text: row.text,
      command: row.command,
      output: row.output,
      exitCode: row.exit_code ?? null,
      filePath: row.file_path,
      additions: row.additions || 0,
      deletions: row.deletions || 0,
      diff: row.diff || "",
      entries: safeJsonParse(row.entries_json, []) || [],
      rawInput: safeJsonParse(row.raw_input_json, null),
      error: row.error || "",
      inputIntent: row.input_intent || "",
      meta: safeJsonParse(row.meta_json, {}) || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at ?? null,
      durationMs: row.duration_ms || 0,
    };
  }

  function rowToRuntimeRequest(row) {
    if (!row) return null;
    return {
      id: row.id,
      requestId: row.id,
      threadId: row.thread_id,
      runId: row.run_id,
      provider: row.provider,
      kind: row.kind,
      status: row.status,
      title: row.title,
      description: row.description,
      preview: row.preview,
      toolCallId: row.tool_call_id,
      options: safeJsonParse(row.options_json, []) || [],
      questions: safeJsonParse(row.questions_json, null),
      multiSelect: Boolean(row.multi_select),
      resolution: safeJsonParse(row.resolution_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      resolvedAt: row.resolved_at ?? null,
    };
  }

  function getCommandReceipt(commandId, method) {
    if (!commandId) return null;
    const row = stmtGetReceipt.get(String(commandId));
    if (row && method && row.method !== method) throw new Error("clientRequestId 已用于其他命令");
    return row ? safeJsonParse(row.result_json, null) : null;
  }

  function claimCommandReceipt(id, pending, method = "delegateTask") {
    return stmtClaimReceipt.run(id, method, JSON.stringify(pending), Date.now()).changes === 1;
  }

  function releaseCommandReceipt(id, pending) {
    if (pending?.status !== "pending") return false;
    return stmtReleaseReceipt.run(id, JSON.stringify(pending), pending.threadId || null).changes === 1;
  }

  function saveCommandReceipt(commandId, method, result) {
    if (!commandId) return;
    stmtSaveReceipt.run(String(commandId), String(method || ""), JSON.stringify(result ?? {}), Date.now());
  }

  function upsertThread(patch) {
    if (!patch || (!patch.id && !patch.threadId)) {
      throw new Error("upsertThread requires id or threadId");
    }
    const id = String(patch.id || patch.threadId);
    const existingRow = stmtGetThread.get(id);
    const prev = existingRow ? rowToThread(existingRow, { includeQueue: false, includeItems: false }) : null;
    const now = Date.now();

    const cwd = String(patch.cwd ?? patch.workspace ?? prev?.cwd ?? "");
    const wsSource = patch.workspace ?? prev?.meta?.workspace ?? cwd;
    const workspaceKey = normalizeWorkspaceKey(wsSource);

    const prevUsage = prev?.usage || DEFAULT_USAGE;
    const nextUsage = patch.usage
      ? {
          inputTokens: Number(patch.usage.inputTokens ?? patch.usage.input_tokens ?? prevUsage.inputTokens),
          cachedTokens: Number(
            patch.usage.cachedTokens ?? patch.usage.cachedInputTokens ?? patch.usage.cachedReadTokens ?? prevUsage.cachedTokens
          ),
          reasoningTokens: Number(
            patch.usage.reasoningTokens ?? patch.usage.reasoningOutputTokens ?? patch.usage.thoughtTokens ?? prevUsage.reasoningTokens
          ),
          outputTokens: Number(patch.usage.outputTokens ?? patch.usage.output_tokens ?? prevUsage.outputTokens),
          totalTokens: Number(patch.usage.totalTokens ?? patch.usage.total_tokens ?? prevUsage.totalTokens),
          contextUsed: Number(patch.usage.contextUsed ?? patch.usage.used ?? prevUsage.contextUsed),
          contextLimit: Number(
            patch.usage.contextLimit ?? patch.usage.modelContextWindow ?? patch.usage.size ?? prevUsage.contextLimit
          ),
        }
      : prevUsage;

    const parentThreadId = patch.parentThreadId !== undefined ? (patch.parentThreadId || null) : (prev?.parentThreadId ?? null);
    const hostConversationId = pickStr(patch.hostConversationId, prev?.hostConversationId);
    const parentRow = parentThreadId ? stmtGetThread.get(parentThreadId) : null;
    const rootConversationId = String(
      patch.rootConversationId !== undefined
        ? patch.rootConversationId ?? ""
        : prev?.rootConversationId || patch.meta?.rootConversationId || parentRow?.root_conversation_id ||
          parentRow?.host_conversation_id || (!parentThreadId ? hostConversationId : "") || ""
    ).trim();
    const mergedMeta = {
      ...(prev?.meta || {}),
      ...(patch.meta || {}),
      ...(patch.workspace ? { workspace: patch.workspace } : {}),
      ...(rootConversationId ? { rootConversationId } : {}),
    };

    const createdAt = Number(patch.createdAt ?? prev?.createdAt ?? now);
    const startedAt = Number(patch.startedAt ?? prev?.startedAt ?? createdAt);
    const completedAt =
      patch.completedAt !== undefined
        ? patch.completedAt
        : prev?.completedAt ?? null;
    const durationMs = Number(
      patch.durationMs ??
        (completedAt && startedAt ? Math.max(0, completedAt - startedAt) : prev?.durationMs ?? 0)
    );

    const rawThreadError = patch.error !== undefined ? patch.error : patch.lastError;
    const archivedAt =
      patch.archivedAt !== undefined
        ? patch.archivedAt
        : patch.archived !== undefined
          ? (patch.archived ? now : null)
          : (prev?.archivedAt ?? null);

    stmtUpsertThread.run(
      id,
      String(patch.title ?? prev?.title ?? "未命名任务线程"),
      String(patch.role ?? prev?.role ?? "general"),
      pickStr(patch.presetKey, prev?.presetKey),
      String(patch.status ?? prev?.status ?? "idle"),
      pickStr(patch.workState, prev?.workState),
      String(patch.provider ?? prev?.provider ?? "kimi-code"),
      String(patch.model ?? prev?.model ?? "kimi-code/k3.1-pro"),
      String(patch.effort ?? prev?.effort ?? "high"),
      String(patch.permissionMode ?? patch.runtimeMode ?? prev?.permissionMode ?? "auto"),
      String(patch.interactionMode ?? prev?.interactionMode ?? "default"),
      String(patch.isolation ?? prev?.isolation ?? "shared"),
      cwd,
      workspaceKey,
      pickStr(patch.worktreePath, prev?.worktreePath),
      pickStr(patch.worktreeId, prev?.worktreeId),
      pickStr(patch.branch, prev?.branch),
      parentThreadId,
      hostConversationId,
      rootConversationId,
      pickStr(patch.nativeSessionId, prev?.nativeSessionId),
      pickStr(patch.taskId, prev?.taskId),
      pickStr(patch.activeRunId, prev?.activeRunId),
      pickStr(patch.summary, prev?.summary),
      pickStr(rawThreadError, prev?.error),
      JSON.stringify(nextUsage),
      JSON.stringify(mergedMeta),
      createdAt,
      startedAt,
      Number(patch.updatedAt ?? now),
      completedAt,
      durationMs,
      archivedAt
    );

    return getThread(id);
  }

  function getThread(idOrTaskId, opts = {}) {
    if (!idOrTaskId) return null;
    const key = String(idOrTaskId);
    const row = stmtGetThread.get(key) || stmtGetThreadByTask.get(key);
    return rowToThread(row, {
      includeQueue: opts.includeQueue ?? true,
      includeItems: opts.includeItems ?? false,
    });
  }

  // Query the complete conversation roster, independent of UI pagination limits.
  const stmtRoleThreads = db.prepare(`SELECT * FROM threads
    WHERE workspace_key = ? AND role = ? AND archived_at IS NULL
      AND root_conversation_id = ? COLLATE NOCASE
    ORDER BY created_at, id`);
  function listRoleThreads(workspace, role, rootConversationId) {
    return stmtRoleThreads.all(normalizeWorkspaceKey(workspace), role, rootConversationId)
      .map(row => rowToThread(row, { includeQueue: false }));
  }

  function listThreads({
    workspace,
    statuses,
    parentThreadId,
    rootConversationId,
    includeSubagents = true,
    includeArchived = false,
    includeItems = false,
    includeQueue = true,
    limit = 200,
    offset = 0,
  } = {}) {
    const clauses = [];
    const params = [];

    if (!includeArchived) {
      clauses.push(`archived_at IS NULL`);
    }
    if (rootConversationId) {
      clauses.push(`root_conversation_id = ? COLLATE NOCASE`);
      params.push(String(rootConversationId));
    }
    if (workspace) {
      const wsKey = normalizeWorkspaceKey(workspace);
      if (wsKey) {
        clauses.push(`(workspace_key = ? OR workspace_key LIKE ? OR cwd LIKE ?)`);
        params.push(wsKey, `${wsKey}/%`, `${workspace}%`);
      }
    }
    if (Array.isArray(statuses) && statuses.length > 0) {
      const placeholders = statuses.map(() => `?`).join(", ");
      clauses.push(`status IN (${placeholders})`);
      params.push(...statuses.map(String));
    }
    if (parentThreadId !== undefined) {
      if (parentThreadId === null) {
        clauses.push(`parent_thread_id IS NULL`);
      } else {
        clauses.push(`parent_thread_id = ?`);
        params.push(String(parentThreadId));
      }
    } else if (!includeSubagents) {
      clauses.push(`parent_thread_id IS NULL`);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = `SELECT * FROM threads ${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
    params.push(Math.max(1, Math.min(1000, Number(limit) || 200)), Math.max(0, Number(offset) || 0));

    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => rowToThread(r, { includeQueue, includeItems }));
  }

  function searchThreads(query, { workspace, limit = 50 } = {}) {
    const q = String(query || "").trim();
    if (!q) return listThreads({ workspace, limit });
    const likePat = `%${q}%`;
    const wsKey = workspace ? normalizeWorkspaceKey(workspace) : "";

    const sql = wsKey
      ? `
        SELECT DISTINCT t.*
        FROM threads t
        LEFT JOIN turn_items ti ON ti.thread_id = t.id
        WHERE t.archived_at IS NULL
          AND (t.workspace_key = ? OR t.workspace_key LIKE ?)
          AND (t.title LIKE ? OR t.summary LIKE ? OR t.model LIKE ? OR ti.text LIKE ? OR ti.output LIKE ?)
        ORDER BY t.updated_at DESC
        LIMIT ?
      `
      : `
        SELECT DISTINCT t.*
        FROM threads t
        LEFT JOIN turn_items ti ON ti.thread_id = t.id
        WHERE t.archived_at IS NULL
          AND (t.title LIKE ? OR t.summary LIKE ? OR t.model LIKE ? OR ti.text LIKE ? OR ti.output LIKE ?)
        ORDER BY t.updated_at DESC
        LIMIT ?
      `;

    const args = wsKey
      ? [wsKey, `${wsKey}/%`, likePat, likePat, likePat, likePat, likePat, Number(limit) || 50]
      : [likePat, likePat, likePat, likePat, likePat, Number(limit) || 50];

    const rows = db.prepare(sql).all(...args);
    return rows.map((r) => rowToThread(r, { includeQueue: true, includeItems: false }));
  }

  function upsertRun(patch) {
    if (!patch || (!patch.id && !patch.runId)) {
      throw new Error("upsertRun requires id or runId");
    }
    const id = String(patch.id || patch.runId);
    const existingRow = stmtGetRun.get(id);
    const prev = rowToRun(existingRow);
    const threadId = String(patch.threadId ?? prev?.threadId ?? "");
    if (!threadId) {
      throw new Error("upsertRun requires threadId");
    }

    const now = Date.now();
    const ordinal = Number(patch.ordinal ?? prev?.ordinal ?? stmtNextRunOrdinal.get(threadId).next_ord);
    const status = String(patch.status ?? prev?.status ?? "queued");
    const queuePosition =
      patch.queuePosition !== undefined
        ? Number(patch.queuePosition)
        : prev?.queuePosition !== undefined
          ? prev.queuePosition
          : status === "queued"
            ? Number(stmtNextQueuePos.get(threadId).next_pos)
            : 0;

    const prevUsage = prev?.usage || DEFAULT_USAGE;
    const nextUsage = patch.usage ? { ...prevUsage, ...patch.usage } : prevUsage;
    const mergedMeta = { ...(prev?.meta || {}), ...(patch.meta || {}) };
    if (patch.role) mergedMeta.role = patch.role;
    // Stage timings arrive from different phases (prep, spawn, first event...); later patches must not erase earlier ones.
    const mergedTimings = prev?.meta?.timings || patch.meta?.timings
      ? { ...(prev?.meta?.timings || {}), ...(patch.meta?.timings || {}) } : undefined;
    if (mergedTimings) mergedMeta.timings = mergedTimings;
    const rootConversationId = String(
      patch.rootConversationId !== undefined
        ? patch.rootConversationId ?? ""
        : prev?.rootConversationId || mergedMeta.rootConversationId || stmtGetThread.get(threadId)?.root_conversation_id || ""
    ).trim();

    const createdAt = Number(patch.createdAt ?? prev?.createdAt ?? now);
    const startedAt =
      patch.startedAt !== undefined
        ? patch.startedAt
        : prev?.startedAt ?? (status === "running" ? now : null);
    const completedAt =
      patch.completedAt !== undefined
        ? patch.completedAt
        : prev?.completedAt ?? null;
    const durationMs = Number(
      patch.durationMs ??
        (completedAt && startedAt ? Math.max(0, completedAt - startedAt) : prev?.durationMs ?? 0)
    );

    const rawPrompt = patch.prompt !== undefined ? patch.prompt : patch.text;
    const rawRunError = patch.error !== undefined ? patch.error : patch.lastError;

    stmtUpsertRun.run(
      id,
      threadId,
      rootConversationId,
      ordinal,
      status,
      pickStr(rawPrompt, prev?.prompt),
      pickStr(patch.inputIntent, prev?.inputIntent || "turn_start"),
      patch.freshContext !== undefined ? (patch.freshContext ? 1 : 0) : (prev?.freshContext ? 1 : 0),
      queuePosition,
      pickStr(patch.provider, prev?.provider),
      pickStr(patch.model, prev?.model),
      pickStr(patch.effort, prev?.effort),
      pickStr(patch.permissionMode, prev?.permissionMode),
      pickStr(patch.interactionMode, prev?.interactionMode),
      pickStr(patch.nativeSessionId, prev?.nativeSessionId),
      pickStr(patch.assistantText, prev?.assistantText),
      pickStr(patch.reasoningText, prev?.reasoningText),
      pickStr(rawRunError, prev?.error),
      JSON.stringify(nextUsage),
      JSON.stringify(mergedMeta),
      createdAt,
      startedAt,
      Number(patch.updatedAt ?? now),
      completedAt,
      durationMs
    );

    return getRun(id);
  }

  function getRun(id) {
    if (!id) return null;
    return rowToRun(stmtGetRun.get(String(id)));
  }

  function listRuns({ rootConversationId, threadId, statuses, taskId, limit = 200, tail = false } = {}) {
    const clauses = [];
    const params = [];
    if (rootConversationId) {
      clauses.push(`root_conversation_id = ? COLLATE NOCASE`);
      params.push(String(rootConversationId));
    }
    if (threadId) {
      clauses.push(`thread_id = ?`);
      params.push(String(threadId));
    }
    if (taskId) {
      clauses.push("json_extract(meta_json, '$.taskId') = ?");
      params.push(String(taskId));
    }
    if (Array.isArray(statuses) && statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => `?`).join(", ")})`);
      params.push(...statuses.map(String));
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const sql = tail === true
      ? `SELECT * FROM (SELECT * FROM runs ${whereSql} ORDER BY ordinal DESC, created_at DESC LIMIT ?)
        ORDER BY ordinal ASC, created_at ASC`
      : `SELECT * FROM runs ${whereSql} ORDER BY ordinal ASC, created_at ASC LIMIT ?`;
    const rows = db.prepare(sql).all(...params, Number(limit) || 200);
    return rows.map(rowToRun);
  }

  function summarizeThreadRunRollups(threads = []) {
    const rollups = new Map();
    if (!threads.length) return rollups;

    const threadIds = [...new Set(threads.map((t) => t.id))];
    const runsByThread = new Map(threadIds.map((id) => [id, []]));
    const batchSize = 500;
    for (let i = 0; i < threadIds.length; i += batchSize) {
      const batch = threadIds.slice(i, i + batchSize);
      const rows = db.prepare(`
        SELECT id, thread_id, status, input_intent, prompt, native_session_id, usage_json, meta_json,
          started_at, completed_at, created_at
        FROM runs WHERE thread_id IN (${batch.map(() => "?").join(", ")})
          AND status NOT IN ('queued', 'cancelled')
        ORDER BY ordinal ASC, created_at ASC
      `).all(...batch);
      for (const row of rows) runsByThread.get(row.thread_id).push(row);
    }

    for (const t of threads) {
      const runs = runsByThread.get(t.id);
      if (!runs.length) {
        rollups.set(t.id, { currentRun: null, orderCount: 0, cumulativeUsage: t.usage });
        continue;
      }

      const current = runs.find((r) => r.id === t.activeRunId) || runs.at(-1);
      const meta = safeJsonParse(current.meta_json, {}) || {};
      const usage = hydrateUsage(current.usage_json);
      const currentRun = {
        id: current.id,
        status: current.status,
        inputIntent: current.input_intent || meta.inputIntent || "",
        prompt: current.prompt || "",
        title: meta.title || "",
        taskId: meta.taskId || "",
        usage,
        usageReported: Boolean(meta.usageReported || usage.totalTokens > 0 || usage.inputTokens > 0 || usage.outputTokens > 0),
        startedAt: current.started_at || current.created_at || 0,
        completedAt: current.completed_at || null,
        createdAt: current.created_at || 0,
      };
      const cumulativeUsage = { ...DEFAULT_USAGE, contextUsed: usage.contextUsed, contextLimit: usage.contextLimit };
      let orderCount = 0;
      // Scan newest-first so each Codex session contributes its latest cumulative report once.
      const codexSessions = new Set();
      for (let i = runs.length - 1; i >= 0; i--) {
        const run = runs[i];
        const intent = String(run.input_intent || safeJsonParse(run.meta_json, {})?.inputIntent || "");
        if (i === 0 || !SAME_ORDER_INTENTS.has(intent)) orderCount++;

        if (t.provider === "codex" && run.native_session_id) {
          if (codexSessions.has(run.native_session_id)) continue;
          codexSessions.add(run.native_session_id);
        }
        const runUsage = run === current ? usage : hydrateUsage(run.usage_json);
        for (const field of RUN_TOKEN_FIELDS) cumulativeUsage[field] += runUsage[field] || 0;
      }
      rollups.set(t.id, { currentRun, orderCount, cumulativeUsage });
    }
    return rollups;
  }

  function summarizeBoardRuns(threadId, limit = 30, getCachedSummary) {
    if (!threadId) return [];
    const runs = listRuns({ threadId, limit, tail: true });
    const summaries = new Map();
    const missing = runs.filter((run) => {
      const cached = getCachedSummary?.(run);
      if (!cached) return true;
      summaries.set(run.id, cached);
      return false;
    });
    if (missing.length) {
      // idx_turn_items_run supports the grouped lookup and the assistant-text fallback.
      const stats = db.prepare(`
        SELECT run_id, SUM(type = 'reasoning') AS reasoningCount,
          SUM(CASE WHEN type = 'reasoning' THEN duration_ms ELSE 0 END) AS reasoningMs,
          SUM(type IN ('tool_call', 'command_execution', 'file_change', 'dynamic_tool')) AS toolCount,
          SUM(type <> 'error' AND status = 'failed') AS failedToolCount
        FROM turn_items WHERE run_id IN (${missing.map(() => '?').join(', ')}) GROUP BY run_id
      `).all(...missing.map((run) => run.id));
      const byRun = new Map(stats.map(({ run_id, ...counts }) => [run_id, counts]));
      let assistantStmt;
      for (const run of missing) {
        let assistantText = run.assistantText;
        if (!assistantText?.trim()) {
          assistantStmt ??= db.prepare(`SELECT text FROM turn_items
            WHERE run_id = ? AND type = 'assistant_message' AND length(text) > 0
            ORDER BY ordinal ASC, created_at ASC`);
          assistantText = assistantStmt.all(run.id).map(({ text }) => text).join('\n\n').trim();
        }
        summaries.set(run.id, {
          reasoningCount: 0, reasoningMs: 0, toolCount: 0, failedToolCount: 0,
          ...byRun.get(run.id), assistantText,
        });
      }
    }
    return runs.map((run) => ({ run, summary: summaries.get(run.id) }));
  }

  function listQueuedRuns(threadId) {
    if (!threadId) return [];
    const rows = db
      .prepare(
        `SELECT * FROM runs WHERE thread_id = ? AND status = 'queued' ORDER BY queue_position ASC, created_at ASC`
      )
      .all(String(threadId));
    return rows.map(rowToRun);
  }

  function reorderQueuedRuns(threadId, orderedRunIds = []) {
    if (!threadId) return [];
    const current = listQueuedRuns(threadId);
    const byId = new Map(current.map((r) => [r.id, r]));
    const finalOrder = [];
    for (const rid of orderedRunIds) {
      const s = String(rid);
      if (byId.has(s)) {
        finalOrder.push(s);
        byId.delete(s);
      }
    }
    for (const leftoverId of byId.keys()) {
      finalOrder.push(leftoverId);
    }

    const stmtUpdatePos = db.prepare(`UPDATE runs SET queue_position = ?, updated_at = ? WHERE id = ?`);
    const now = Date.now();
    db.exec("BEGIN");
    try {
      finalOrder.forEach((rid, index) => {
        stmtUpdatePos.run(index + 1, now, rid);
      });
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    return listQueuedRuns(threadId);
  }

  function upsertTurnItem(patch) {
    if (!patch || !patch.id) {
      throw new Error("upsertTurnItem requires id");
    }
    const id = String(patch.id);
    const existingRow = stmtGetTurnItem.get(id);
    const prev = rowToTurnItem(existingRow);
    const threadId = String(patch.threadId ?? prev?.threadId ?? "");
    if (!threadId) {
      throw new Error("upsertTurnItem requires threadId");
    }

    const now = Date.now();
    const ordinal =
      patch.ordinal !== undefined
        ? Number(patch.ordinal)
        : prev?.ordinal ?? Number(stmtNextItemOrdinal.get(threadId).next_ord);

    const createdAt = Number(patch.createdAt ?? prev?.createdAt ?? now);
    const completedAt =
      patch.completedAt !== undefined
        ? patch.completedAt
        : prev?.completedAt ?? null;
    const durationMs = Number(
      patch.durationMs ??
        (completedAt && createdAt ? Math.max(0, completedAt - createdAt) : prev?.durationMs ?? 0)
    );

    const entries = patch.entries ?? patch.todos ?? patch.items ?? prev?.entries ?? [];
    const rawInput = patch.rawInput !== undefined ? patch.rawInput : (patch.input !== undefined ? patch.input : prev?.rawInput ?? null);
    const mergedMeta = { ...(prev?.meta || {}), ...(patch.meta || {}) };

    const rawItemText = patch.text !== undefined ? patch.text : patch.content;
    const rawItemError = patch.error !== undefined ? patch.error : patch.lastError;

    stmtUpsertTurnItem.run(
      id,
      threadId,
      pickStr(patch.runId, prev?.runId),
      ordinal,
      String(patch.type ?? prev?.type ?? "assistant_message"),
      String(patch.status ?? prev?.status ?? "completed"),
      pickStr(patch.title, prev?.title),
      pickStr(rawItemText, prev?.text),
      pickStr(patch.command, prev?.command),
      pickStr(patch.output, prev?.output),
      patch.exitCode !== undefined ? patch.exitCode : (prev?.exitCode ?? null),
      pickStr(patch.filePath, prev?.filePath),
      Number(patch.additions ?? prev?.additions ?? 0),
      Number(patch.deletions ?? prev?.deletions ?? 0),
      pickStr(patch.diff, prev?.diff),
      JSON.stringify(Array.isArray(entries) ? entries : []),
      rawInput !== null && rawInput !== undefined ? JSON.stringify(rawInput) : null,
      pickStr(rawItemError, prev?.error),
      pickStr(patch.inputIntent, prev?.inputIntent),
      JSON.stringify(mergedMeta),
      createdAt,
      Number(patch.updatedAt ?? now),
      completedAt,
      durationMs
    );

    return rowToTurnItem(stmtGetTurnItem.get(id));
  }

  function appendTurnItemDelta(itemId, {
    threadId,
    runId = "",
    type = "assistant_message",
    title = "",
    textDelta = "",
    outputDelta = "",
    diff,
    status,
  } = {}) {
    if (!itemId) return null;
    const id = String(itemId);
    const existing = stmtGetTurnItem.get(id);
    const now = Date.now();

    if (!existing) {
      if (!threadId) return null;
      return upsertTurnItem({
        id,
        threadId,
        runId,
        type,
        status: status || "streaming",
        title,
        text: textDelta || "",
        output: outputDelta || "",
        diff: diff || "",
        createdAt: now,
        updatedAt: now,
      });
    }

    stmtAppendItemDelta.run(
      textDelta ? "1" : "",
      textDelta || "",
      outputDelta ? "1" : "",
      outputDelta || "",
      diff !== undefined ? diff : null,
      diff !== undefined ? diff : null,
      status || null,
      now,
      id
    );
    return rowToTurnItem(stmtGetTurnItem.get(id));
  }

  function listTurnItems({
    threadId,
    runId,
    view = "activity",
    afterOrdinal = 0,
    limit = 500,
    maxCharsPerItem = 0,
    tail = false,
  } = {}) {
    if (!threadId && !runId) return [];
    const clauses = [];
    const params = [];

    if (threadId) {
      clauses.push(`thread_id = ?`);
      params.push(String(threadId));
    }
    if (runId) {
      clauses.push(`run_id = ?`);
      params.push(String(runId));
    }
    if (afterOrdinal > 0) {
      clauses.push(`ordinal > ?`);
      params.push(Number(afterOrdinal));
    }
    if (view === "last_assistant") clauses.push("type = 'assistant_message' AND length(trim(text)) > 0");
    if (view === "messages") {
      clauses.push(`type IN ('user_message', 'assistant_message', 'proposed_plan', 'error', 'subagent')`);
    }

    // tail: the newest `limit` matches, still returned oldest-first.
    const sql = tail
      ? `SELECT * FROM (SELECT * FROM turn_items WHERE ${clauses.join(" AND ")}
          ORDER BY ordinal DESC, created_at DESC LIMIT ?) ORDER BY ordinal ASC, created_at ASC`
      : `
      SELECT * FROM turn_items
      WHERE ${clauses.join(" AND ")}
      ORDER BY ordinal ASC, created_at ASC
      LIMIT ?
    `;
    params.push(Math.max(1, Math.min(2000, Number(limit) || 500)));

    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => {
      const item = rowToTurnItem(r);
      if (maxCharsPerItem > 0) {
        if (item.text.length > maxCharsPerItem) {
          item.text = `${item.text.slice(0, maxCharsPerItem)}\n...[truncated]`;
        }
        if (item.output.length > maxCharsPerItem) {
          item.output = `${item.output.slice(0, maxCharsPerItem)}\n...[truncated]`;
        }
      }
      return item;
    });
  }

  function getTurnItem(id) {
    if (!id) return null;
    const item = rowToTurnItem(stmtGetTurnItem.get(String(id)));
    if (item || !String(id).startsWith("report:")) return item;
    // A driver may assemble one final answer from several streamed items. Its run is already the full-text backing row.
    const run = getRun(String(id).slice(7));
    return run?.assistantText ? { id, threadId: run.threadId, runId: run.id, type: "assistant_message", role: "assistant", text: run.assistantText, status: run.status } : null;
  }

  function getLocalContinuation(threadId) {
    const lastUser = db.prepare(`SELECT text FROM turn_items
      WHERE thread_id = ? AND type = 'user_message' AND trim(text) <> ''
      ORDER BY ordinal DESC, created_at DESC LIMIT 1`).get(threadId);
    const assistant = `SELECT id, run_id, text FROM turn_items
      WHERE thread_id = ? AND type = 'assistant_message' AND trim(text) <> ''`;
    const latest = db.prepare(assistant + " ORDER BY ordinal DESC, created_at DESC LIMIT 1").get(threadId);
    const earlier = latest && db.prepare(assistant + `
      AND id <> ? AND (run_id = '' OR run_id <> ?)
      ORDER BY ordinal DESC, created_at DESC LIMIT 1`).get(threadId, latest.id, latest.run_id);
    const files = db.prepare(`SELECT file_path FROM turn_items WHERE thread_id = ? AND file_path <> ''
      GROUP BY file_path ORDER BY max(ordinal) DESC LIMIT 8`).all(threadId).map(row => row.file_path);
    return { lastUser, conclusions: [earlier, latest].filter(Boolean), files };
  }

  function upsertRuntimeRequest(patch) {
    if (!patch || (!patch.id && !patch.requestId)) {
      throw new Error("upsertRuntimeRequest requires id or requestId");
    }
    const id = String(patch.id || patch.requestId);
    const existingRow = stmtGetRuntimeReq.get(id);
    const prev = rowToRuntimeRequest(existingRow);
    const now = Date.now();

    const status = String(patch.status ?? prev?.status ?? "pending");
    const resolvedAt =
      patch.resolvedAt !== undefined
        ? patch.resolvedAt
        : status !== "pending" && !prev?.resolvedAt
          ? now
          : (prev?.resolvedAt ?? null);

    const previewVal =
      patch.preview !== undefined
        ? typeof patch.preview === "string"
          ? patch.preview
          : JSON.stringify(patch.preview, null, 2)
        : (prev?.preview ?? "");

    stmtUpsertRuntimeReq.run(
      id,
      String(patch.threadId ?? prev?.threadId ?? ""),
      String(patch.runId ?? prev?.runId ?? ""),
      String(patch.provider ?? prev?.provider ?? ""),
      String(patch.kind ?? prev?.kind ?? "approval"),
      status,
      String(patch.title ?? prev?.title ?? ""),
      String(patch.description ?? prev?.description ?? ""),
      previewVal,
      String(patch.toolCallId ?? prev?.toolCallId ?? ""),
      JSON.stringify(patch.options ?? prev?.options ?? []),
      patch.questions !== undefined
        ? JSON.stringify(patch.questions)
        : prev?.questions
          ? JSON.stringify(prev.questions)
          : null,
      (patch.multiSelect ?? prev?.multiSelect) ? 1 : 0,
      patch.resolution !== undefined
        ? JSON.stringify(patch.resolution)
        : prev?.resolution
          ? JSON.stringify(prev.resolution)
          : null,
      Number(patch.createdAt ?? prev?.createdAt ?? now),
      Number(patch.updatedAt ?? now),
      resolvedAt
    );

    return getRuntimeRequest(id);
  }

  function getRuntimeRequest(id) {
    if (!id) return null;
    return rowToRuntimeRequest(stmtGetRuntimeReq.get(String(id)));
  }

  function listPendingRequests({ threadId, workspace } = {}) {
    if (threadId) {
      const rows = db
        .prepare(`SELECT * FROM runtime_requests WHERE status = 'pending' AND thread_id = ? ORDER BY created_at ASC`)
        .all(String(threadId));
      return rows.map(rowToRuntimeRequest);
    }
    if (workspace) {
      const wsKey = normalizeWorkspaceKey(workspace);
      const rows = db
        .prepare(`
          SELECT r.*
          FROM runtime_requests r
          JOIN threads t ON t.id = r.thread_id
          WHERE r.status = 'pending'
            AND (t.workspace_key = ? OR t.workspace_key LIKE ?)
          ORDER BY r.created_at ASC
        `)
        .all(wsKey, `${wsKey}/%`);
      return rows.map(rowToRuntimeRequest);
    }
    const rows = db
      .prepare(`SELECT * FROM runtime_requests WHERE status = 'pending' ORDER BY created_at ASC`)
      .all();
    return rows.map(rowToRuntimeRequest);
  }

  function appendEvent(eventObj = {}, globalSeq = null) {
    const now = Date.now();
    const type = String(eventObj.type || "orch.event");
    const threadId = String(eventObj.threadId || "");
    const runId = String(eventObj.runId || "");
    const wsKey = normalizeWorkspaceKey(eventObj.workspace || eventObj.cwd || "");
    const rootConversationId = String(
      eventObj.rootConversationId || eventObj.swarm?.rootConversationId ||
      (threadId && stmtGetThread.get(threadId)?.root_conversation_id) ||
      (runId && stmtGetRun.get(runId)?.root_conversation_id) || ""
    ).trim();
    const payload = {
      ...eventObj,
      ...(rootConversationId && !eventObj.rootConversationId ? { rootConversationId } : {}),
      timestamp: eventObj.timestamp || now,
    };
    const info = stmtInsertEvent.run(
      globalSeq,
      type,
      threadId,
      rootConversationId,
      runId,
      wsKey,
      JSON.stringify(payload),
      now
    );
    const seq = Number(info.lastInsertRowid);
    eventsSinceTrim++;
    return {
      ...payload,
      seq,
      type,
      threadId,
      runId,
    };
  }

  function listEvents({ sinceSeq = 0, limit = 300, workspace, threadId, rootConversationId } = {}) {
    const clauses = [`seq > ?`];
    const params = [Number(sinceSeq) || 0];

    if (rootConversationId) {
      clauses.push(`(root_conversation_id = ? COLLATE NOCASE OR type IN ('settings_updated', 'spec_curation_updated', 'project_config_updated', 'system_update_changed'))`);
      params.push(String(rootConversationId));
    }
    if (threadId) {
      clauses.push(`thread_id = ?`);
      params.push(String(threadId));
    } else if (workspace) {
      const wsKey = normalizeWorkspaceKey(workspace);
      if (wsKey) {
        clauses.push(`(workspace_key = '' OR workspace_key = ? OR workspace_key LIKE ?)`);
        params.push(wsKey, `${wsKey}/%`);
      }
    }

    const sql = `SELECT seq, root_conversation_id, payload_json, created_at FROM events WHERE ${clauses.join(" AND ")} ORDER BY seq ASC LIMIT ?`;
    params.push(Math.max(1, Math.min(2000, Number(limit) || 300)));

    const rows = db.prepare(sql).all(...params);
    return rows.map((r) => {
      const payload = safeJsonParse(r.payload_json, {}) || {};
      return {
        ...payload,
        ...(r.root_conversation_id && !payload.rootConversationId ? { rootConversationId: r.root_conversation_id } : {}),
        seq: Number(r.seq),
        timestamp: payload.timestamp || r.created_at,
      };
    });
  }

  function getLatestSeq() {
    return Number(stmtLatestSeq.get()?.latest_seq || 0);
  }

  function getStats({ workspace } = {}) {
    const threads = listThreads({ workspace, includeSubagents: true, limit: 1000 });
    const pendingReqs = listPendingRequests({ workspace });

    let running = 0;
    let waiting = 0;
    let completed = 0;
    let failed = 0;
    let inputTokens = 0;
    let cachedTokens = 0;
    let reasoningTokens = 0;
    let outputTokens = 0;
    let totalTokens = 0;

    for (const t of threads) {
      const s = String(t.status || "").toLowerCase();
      if (s === "running" || s === "starting" || s === "preparing") running++;
      else if (s === "waiting_approval" || s === "waiting_input") waiting++;
      else if (s === "completed" || s === "waiting") completed++;
      else if (s === "failed") failed++;

      inputTokens += t.usage.inputTokens || 0;
      cachedTokens += t.usage.cachedTokens || 0;
      reasoningTokens += t.usage.reasoningTokens || 0;
      outputTokens += t.usage.outputTokens || 0;
      totalTokens += t.usage.totalTokens || 0;
    }

    return {
      totalThreads: threads.length,
      running,
      pending: Math.max(waiting, pendingReqs.length),
      waiting,
      completed,
      failed,
      inputTokens,
      cachedTokens,
      reasoningTokens,
      outputTokens,
      totalTokens,
    };
  }

  function conversationPolicyRecord(row) {
    return {
      conversationId: row.conversation_id,
      orchestrationMode: normalizePolicyMode(row.orchestration_mode || (row.dispatch_enabled ? "relay" : "direct")),
      dispatchEnabled: Boolean(row.dispatch_enabled),
      policyRevision: Number(row.policy_revision ?? 0),
      source: row.source,
      updatedAt: row.updated_at,
    };
  }

  function getConversationPolicyRecord(conversationId) {
    const row = db.prepare(`SELECT * FROM conversation_policies WHERE LOWER(conversation_id)=LOWER(?)
        ORDER BY policy_revision DESC, conversation_id LIMIT 1`).get(conversationId);
    return row ? conversationPolicyRecord(row) : null;
  }

  function listConversationPolicyRecords() {
    return db.prepare("SELECT * FROM conversation_policies").all().map(conversationPolicyRecord);
  }

  function setConversationPolicyRecord({ conversationId, orchestrationMode, dispatchEnabled, expectedPolicyRevision, source = "explicit" }, previousProjectPolicy = null) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const local = getConversationPolicyRecord(conversationId);
      const current = (previousProjectPolicy?.policyRevision ?? 0) > (local?.policyRevision ?? 0) ? previousProjectPolicy : local;
      const currentRevision = current?.policyRevision ?? 0;
      if (expectedPolicyRevision !== undefined && (!Number.isInteger(expectedPolicyRevision) || expectedPolicyRevision !== currentRevision)) {
        throw Object.assign(new Error("会话编排策略已被其他窗口更新，请合并最新策略后重试"), {
          code: "POLICY_REVISION_CONFLICT", details: { currentRevision },
        });
      }
      const hasMode = orchestrationMode !== undefined && orchestrationMode !== null;
      const hasDispatch = dispatchEnabled !== undefined && dispatchEnabled !== null;
      let mode;
      if (hasMode) mode = normalizePolicyMode(orchestrationMode);
      if (hasDispatch && typeof dispatchEnabled !== "boolean") throw Object.assign(new Error("dispatchEnabled 必须是布尔值"), { code: "ORCHESTRATION_POLICY_CONFLICT" });
      if (hasMode && hasDispatch && (mode === "direct") !== !dispatchEnabled) throw Object.assign(new Error("编排模式与派发开关语义冲突"), { code: "ORCHESTRATION_POLICY_CONFLICT" });
      if (!hasMode) {
        if (hasDispatch) mode = dispatchEnabled ? (current?.orchestrationMode && current.orchestrationMode !== "direct" ? normalizePolicyMode(current.orchestrationMode) : "relay") : "direct";
        else mode = current?.orchestrationMode || "direct";
      }
      const enabled = mode === "direct" ? 0 : 1;
      const now = Date.now();
      if (local) db.prepare("UPDATE conversation_policies SET orchestration_mode=?, dispatch_enabled=?, source=?, updated_at=?, policy_revision=? WHERE conversation_id=?").run(mode, enabled, source, now, currentRevision + 1, local.conversationId);
      else db.prepare("INSERT INTO conversation_policies(conversation_id, orchestration_mode, dispatch_enabled, policy_revision, source, updated_at) VALUES(?,?,?,?,?,?)").run(current?.conversationId || conversationId, mode, enabled, currentRevision + 1, source, now);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return getConversationPolicyRecord(conversationId);
  }

  const incidentFields = {
    id: 'id', rootConversationId: 'root_conversation_id', threadId: 'thread_id',
    runId: 'run_id', kind: 'kind', severity: 'severity', status: 'status',
    title: 'title', detail: 'detail', actionTaken: 'action_taken', retryAttempt: 'retry_attempt',
    notifiedAt: 'notified_at', createdAt: 'created_at', updatedAt: 'updated_at', resolvedAt: 'resolved_at',
  };
  const hydrateIncident = row => row && Object.fromEntries(
    Object.entries(incidentFields).map(([key, column]) => [key, row[column]]),
  );

  const getHealthIncident = id => hydrateIncident(db.prepare('SELECT * FROM health_incidents WHERE id=?').get(id));

  function upsertHealthIncident(patch) {
    const now = Date.now();
    const previous = getHealthIncident(patch.id);
    const incident = {
      rootConversationId: '', threadId: '', runId: '', severity: 'warning', status: 'open',
      title: '', detail: '', actionTaken: '', retryAttempt: 0, notifiedAt: null, createdAt: now, resolvedAt: null,
      ...previous, ...patch, updatedAt: now,
    };
    if (incident.status === 'resolved') incident.resolvedAt ??= now;
    const columns = Object.values(incidentFields);
    db.prepare(`INSERT INTO health_incidents(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})
      ON CONFLICT(id) DO UPDATE SET ${columns.slice(1).map(column => `${column}=excluded.${column}`).join(',')}`)
      .run(...Object.keys(incidentFields).map(key => incident[key]));
    return getHealthIncident(patch.id);
  }

  function listHealthIncidents({ rootConversationId, workspace, includeResolved = false } = {}) {
    const rows = db.prepare(`SELECT h.* FROM health_incidents h LEFT JOIN threads t ON t.id=h.thread_id
      WHERE (? IS NULL OR lower(h.root_conversation_id)=lower(?)) AND (? OR h.status='open')
        AND (? IS NULL OR t.workspace_key=? OR t.cwd=? OR json_extract(t.meta_json, '$.projectRoot')=?)
      ORDER BY h.updated_at DESC, h.id`)
      .all(rootConversationId ?? null, rootConversationId ?? null, Number(includeResolved),
        workspace || null, normalizeWorkspaceKey(workspace), workspace || '', workspace || '');
    return rows.map(hydrateIncident);
  }

  // Scope (conversation root, case-insensitive / workspace) is still enforced so another conversation can never
  // dismiss this one's incidents; a single id is resolved directly instead of relying on the open-list window.
  function dismissHealthIncident({ incidentId, rootConversationId, dismissAll, workspace } = {}) {
    if (!dismissAll && !incidentId) return 0;
    let matches;
    if (dismissAll) matches = listHealthIncidents({ rootConversationId, workspace });
    else {
      const row = getHealthIncident(incidentId);
      const inScope = row && row.status === 'open' &&
        (rootConversationId == null || String(row.rootConversationId || '').toLowerCase() === String(rootConversationId).toLowerCase()) &&
        (!workspace || rootConversationId != null || listHealthIncidents({ workspace }).some(item => item.id === row.id));
      matches = inScope ? [row] : [];
    }
    for (const row of matches) upsertHealthIncident({ id: row.id, status: 'resolved' });
    return matches.length;
  }

  let isClosed = false;
  const specLedger = {
    read(provider, sessionId) {
      if (!sessionId) return new Map();
      return new Map(db.prepare(`SELECT spec_key, sha256, tier FROM spec_ledger
        WHERE provider = ? AND native_session_id = ?`).all(provider, sessionId).map(row => [row.spec_key, row]));
    },
    acknowledge({ provider, sessionId, runId, threadId, delivered, injectedSpecs }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const upsert = db.prepare(`INSERT INTO spec_ledger (provider, native_session_id, spec_key, sha256, tier, run_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider, native_session_id, spec_key) DO UPDATE SET
            sha256 = excluded.sha256, tier = excluded.tier, run_id = excluded.run_id, updated_at = excluded.updated_at
          WHERE sha256 <> excluded.sha256 OR excluded.tier = 'inline' OR (tier <> 'inline' AND (tier = 'summary' OR excluded.tier = 'pointer_degraded'))`);
        const now = Date.now();
        for (const entry of delivered) upsert.run(provider, sessionId, entry.key, entry.sha256, entry.tier, runId, now);
        const meta = { injectedSpecs };
        upsertRun({ id: runId, threadId, meta });
        upsertTurnItem({ id: `item_user_${runId}`, threadId, runId, meta });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    prune(before = Date.now() - 30 * 24 * 60 * 60 * 1000, orphanBefore = Date.now() - 24 * 60 * 60 * 1000) {
      const expired = db.prepare(`DELETE FROM spec_ledger AS ledger WHERE updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.provider = ledger.provider
          AND t.native_session_id = ledger.native_session_id AND (t.archived_at IS NULL OR t.archived_at >= ?))
        AND NOT EXISTS (SELECT 1 FROM runs r JOIN threads t ON t.id = r.thread_id
          WHERE r.id = ledger.run_id AND (t.archived_at IS NULL OR t.archived_at >= ?))`).run(before, before, before).changes;
      // Sessions replaced by a fresh one (new work order / engine switch) are no longer any live thread's current
      // native session; once idle for 24h their rows can never be read again.
      const orphaned = db.prepare(`DELETE FROM spec_ledger AS ledger WHERE updated_at < ?
        AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.provider = ledger.provider
          AND t.native_session_id = ledger.native_session_id AND t.archived_at IS NULL)`).run(orphanBefore).changes;
      return expired + orphaned;
    },
  };

  const threadAccess = { specLedger, summarizeThreadRunRollups };
  const checkpointTruncate = () => db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  const pragmaNumber = name => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() || {})[0]) || 0;

  function inspectStorage(opts = {}) {
    return summarizeStorage({
      pageSize: pragmaNumber("page_size"),
      pageCount: pragmaNumber("page_count"),
      freelistCount: pragmaNumber("freelist_count"),
      autoVacuum: pragmaNumber("auto_vacuum"),
    }, opts, { valid: true, source: "connection" });
  }

  function availableDiskBytes(opts) {
    if (opts.availableDiskBytes !== undefined && opts.availableDiskBytes !== null) return Number(opts.availableDiskBytes);
    try {
      const st = fs.statfsSync(path.dirname(dbPath));
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return null; // unknown free space fails closed below
    }
  }

  // Gentle physical compaction. Never touches threads / runs / turn_items content; the caller owns the idle gate.
  function compactStorage(opts = {}) {
    const { reserveFreeBytes } = compactThresholds(opts);
    trimEvents();
    specLedger.prune();
    const checkpointed = !checkpointTruncate()?.busy;
    const before = inspectStorage(opts);
    const base = { ok: true, compacted: true, trimmed: true, checkpointed, vacuumed: false };
    const skip = (reason, more = {}) => ({ ...base, ...more, vacuumSkippedReason: reason, before, after: before, freedBytes: 0 });
    if (!before.overWatermark) return skip("below_watermark");
    if (dbPath && dbPath !== ":memory:") {
      const available = availableDiskBytes(opts);
      const required = before.totalBytes * 2 + 64 * 1024 * 1024;
      if (!(available >= required)) return skip("low_disk_space", { availableDiskBytes: available, requiredDiskBytes: required });
    }
    let integrity;
    try {
      integrity = String(Object.values(db.prepare("PRAGMA quick_check(1)").get() || {})[0] ?? "");
    } catch (error) {
      integrity = String(error?.message || error);
    }
    if (integrity !== "ok") return skip("integrity_check_failed", { integrity });

    // C02①: VACUUM / incremental_vacuum must never spill transient files into the system %TEMP%.
    db.exec("PRAGMA temp_store = MEMORY;");
    let vacuumMode = "";
    let reclaimedPages = 0;
    if (before.autoVacuum === 2) {
      const targetFreePages = Math.ceil(reserveFreeBytes / before.pageSize);
      reclaimedPages = Math.max(0, before.freelistCount - targetFreePages);
      if (reclaimedPages > 0) {
        db.exec(`PRAGMA incremental_vacuum(${reclaimedPages});`);
        checkpointTruncate();
        vacuumMode = "incremental";
      }
    } else if (before.autoVacuum === 0) {
      // One-off lossless upgrade of a legacy NONE database to INCREMENTAL, rebuilt without its dead pages.
      try {
        db.exec("PRAGMA journal_mode = DELETE; PRAGMA auto_vacuum = INCREMENTAL; VACUUM;");
        vacuumMode = "upgrade_incremental";
      } finally {
        try { db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;"); } catch {}
      }
    }
    if (!vacuumMode) return skip(before.autoVacuum === 1 ? "auto_vacuum_full" : "reserve_buffer_only");
    const after = inspectStorage(opts);
    if (vacuumMode !== "incremental") reclaimedPages = Math.max(0, before.pageCount - after.pageCount);
    return { ...base, vacuumed: true, vacuumMode, reclaimedPages, vacuumSkippedReason: "", before, after,
      freedBytes: Math.max(0, before.totalBytes - after.totalBytes) };
  }

  function close() {
    if (isClosed) return;
    isClosed = true;
    try {
      db.close();
    } catch {}
  }

  return {
    dbPath,
    eventClock(minimum, advance = 0) {
      db.prepare(`INSERT INTO settings(key,value_json,updated_at) VALUES('event_clock',?,0)
        ON CONFLICT(key) DO UPDATE SET value_json=MAX(CAST(value_json AS INTEGER),?) + ?`).run(minimum+advance,minimum,advance);
      return Number(db.prepare("SELECT value_json FROM settings WHERE key='event_clock'").get().value_json);
    },
    indexRows() {
      return {
        threads: db.prepare("SELECT id, task_id, provider, host_conversation_id, native_session_id, json_extract(meta_json, '$.isNativeHost') AS is_native_host FROM threads").all(),
        runs: db.prepare("SELECT id, json_extract(meta_json, '$.taskId') AS taskId FROM runs").all(),
        items: db.prepare('SELECT id FROM turn_items').all(),
        requests: db.prepare('SELECT id FROM runtime_requests').all(),
        policies: db.prepare('SELECT conversation_id AS id FROM conversation_policies').all(),
        incidents: db.prepare('SELECT id FROM health_incidents').all(),
        commands: db.prepare('SELECT command_id AS id FROM command_receipts').all(),
      };
    },
    trimEvents,
    shouldTrimEvents,
    specLedger,
    readSpecCuration: () => readSpecCuration(db),
    latestCurationWork(root) {
      const row = db.prepare(`SELECT id, completed_at AS completedAt FROM (
        SELECT runs.id, runs.completed_at FROM runs JOIN threads ON runs.thread_id = threads.id
          WHERE runs.root_conversation_id = ? COLLATE NOCASE AND runs.status = 'completed'
            AND COALESCE(json_extract(runs.meta_json, '$.role'), threads.role) IN ('executor', 'implementation', 'test', 'review', 'reviewer')
            AND COALESCE(json_extract(runs.meta_json, '$.executionIntent'), '') <> 'read'
            AND COALESCE(json_extract(runs.meta_json, '$.reviewSpec.readOnly'), 0) <> 1
        UNION ALL
        SELECT id, completed_at FROM threads WHERE root_conversation_id = ? COLLATE NOCASE
          AND status IN ('completed', 'waiting') AND json_extract(meta_json, '$.isNativeHost') = 1
          AND role IN ('executor', 'implementation', 'test', 'review', 'reviewer')
      ) WHERE completedAt > 0 ORDER BY completedAt DESC, id DESC LIMIT 1`).get(root, root);
      return row ? { ...row } : null;
    },
    getSpecProposal(id) {
      const row = db.prepare("SELECT record_json FROM spec_proposals WHERE id = ?").get(id);
      return row ? JSON.parse(row.record_json) : null;
    },
    putSpecProposal(record) {
      db.exec("BEGIN IMMEDIATE");
      try {
        if (record.status === "pending") {
          const resolvedAt = record.updatedAt || Date.now();
          const openRows = db.prepare("SELECT id, record_json FROM spec_proposals WHERE status = 'pending' AND id <> ?").all(record.id);
          const stmt = db.prepare("UPDATE spec_proposals SET status = 'superseded', record_json = ? WHERE id = ?");
          for (const row of openRows) {
            const parsed = safeJsonParse(row.record_json, null);
            if (!parsed) continue;
            stmt.run(JSON.stringify({ ...parsed, status: "superseded", updatedAt: resolvedAt, resolvedAt }), row.id);
          }
        }
        db.prepare(`INSERT INTO spec_proposals(id, run_id, root_conversation_id, status, created_at, record_json)
          VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status=excluded.status, record_json=excluded.record_json`)
          .run(record.id, record.runId, record.rootConversationId, record.status, record.createdAt, JSON.stringify(record));
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      return record;
    },
    patchSpecCurationState(patch) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const state = db.prepare("SELECT value_json FROM settings WHERE key = 'spec_curation_state'").get();
        db.prepare(`INSERT INTO settings(key, value_json, updated_at) VALUES ('spec_curation_state', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
          .run(JSON.stringify({ ...JSON.parse(state?.value_json || "{}"), ...patch }), Date.now());
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    checkpoint() {
      // compactProjectDb and periodic project maintenance: batch-trim events, prune the ledger, fold the WAL back.
      trimEvents();
      specLedger.prune();
      return checkpointTruncate();
    },
    inspectStorage,
    compactStorage,
    getLatestRun: threadId => rowToRun(db.prepare("SELECT * FROM runs WHERE thread_id=? ORDER BY ordinal DESC LIMIT 1").get(threadId)),
    getConversationPolicyRecord, listConversationPolicyRecords, setConversationPolicyRecord,
    listWorkCountsByThread: () => db.prepare(`SELECT thread_id AS threadId,
      COUNT(CASE WHEN status!='queued' THEN 1 END) AS runningCount,
      COUNT(CASE WHEN status='queued' THEN 1 END) AS queuedCount FROM runs
      WHERE status IN ('starting','running','waiting_approval','waiting_input','queued') GROUP BY thread_id`).all(),
    listThreadsWithQueuedRuns: () => db.prepare("SELECT DISTINCT thread_id FROM runs WHERE status='queued'").all().map(row => row.thread_id),
    getHealthIncident, upsertHealthIncident, listHealthIncidents, dismissHealthIncident,
    getCommandReceipt,
    saveCommandReceipt, claimCommandReceipt, releaseCommandReceipt,
    upsertThread, listRoleThreads,
    getThread,
    listThreads,
    searchThreads,
    upsertRun,
    getRun,
    listRuns,
    summarizeThreadRunRollups,
    summarizeBoardRuns,
    listQueuedRuns,
    reorderQueuedRuns,
    upsertTurnItem,
    appendTurnItemDelta,
    listTurnItems,
    getLocalContinuation,
    getTurnItem,
    upsertRuntimeRequest,
    getRuntimeRequest,
    listPendingRequests,
    appendEvent,
    listEvents,
    getLatestSeq,
    getStats,
    close,
  };
}

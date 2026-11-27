import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_COMPACT_MIN_FREE_BYTES,
  DEFAULT_COMPACT_MIN_FREE_RATIO,
  DEFAULT_COMPACT_RESERVE_FREE_BYTES,
  inspectSqliteHeaderFile,
  openOrchestratorDb,
} from "../../core/db.mjs";
import { openProjectStore } from "../../core/project-store.mjs";
import { resolveTranscriptPath } from "../../core/engines/agy-native.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { repoRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

// v0.2.7 小包 1：新库 INCREMENTAL、事件每 200 条批量裁剪（1500 滚动窗口不断 sinceSeq）、turn_items 零截断、
// 双高水位温和回收（存量 NONE 库一次性升级 / INCREMENTAL 库精准保留缓冲页）、四重门禁与运行缓存纯只读探针。
// 物理回收用例统一使用缩小阈值（256 KiB 水位 / 64 KiB 缓冲）秒级验真，生产默认常量单独断言。
const SMALL = { minFreeBytes: 256 * 1024, minFreeRatio: 0.5, reserveFreeBytes: 64 * 1024 };
const tower = (root) => path.join(root, ".agent-tower");
const dbFile = (root) => path.join(tower(root), "conversations", "tower.sqlite");
const listing = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

// Bloat a database with a ~2 MiB filler table and drop it: leaves ~500 free pages (> 256 KiB and > 50 %).
function bloat(file) {
  const raw = new DatabaseSync(file);
  try {
    raw.exec("PRAGMA busy_timeout = 2000; CREATE TABLE IF NOT EXISTS filler (blob BLOB);");
    const insert = raw.prepare("INSERT INTO filler (blob) VALUES (?)");
    for (let i = 0; i < 64; i++) insert.run(Buffer.alloc(32 * 1024, i));
    raw.exec("DROP TABLE filler; PRAGMA wal_checkpoint(TRUNCATE);");
  } finally {
    raw.close();
  }
}

// SQLite resolves its temp dir from the process environment: point it at a sandbox folder to prove zero spill.
function withSandboxTemp(dir) {
  const temp = path.join(dir, "sqlite-temp");
  fs.mkdirSync(temp, { recursive: true });
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  Object.assign(process.env, { TEMP: temp, TMP: temp, TMPDIR: temp });
  return { temp, restore: () => { for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
}

test("v0.2.7 生产默认常量：双高水位 64 MiB + 50%，预留缓冲 28 MiB", () => {
  assert.equal(DEFAULT_COMPACT_MIN_FREE_BYTES, 64 * 1024 * 1024);
  assert.equal(DEFAULT_COMPACT_MIN_FREE_RATIO, 0.5);
  assert.equal(DEFAULT_COMPACT_RESERVE_FREE_BYTES, 28 * 1024 * 1024);
});

test("v0.2.7 新库 INCREMENTAL、每 200 条批量裁剪保留 1500 窗口不断 sinceSeq、turn_items 长文本零截断", () =>
  withProjectSandbox("v027-trim", async (dir) => {
    const fresh = path.join(dir, "fresh.sqlite");
    const raw = openOrchestratorDb(fresh);
    try {
      assert.equal(raw.inspectStorage().autoVacuum, 2, "新建空库建表前开启 auto_vacuum = INCREMENTAL");
      for (let i = 0; i < 199; i++) raw.appendEvent({ type: "delta" }, i + 1);
      assert.equal(raw.shouldTrimEvents(), false);
      raw.appendEvent({ type: "delta" }, 200);
      assert.equal(raw.shouldTrimEvents(), true, "累计 200 条才触发批量裁剪");
      assert.equal(raw.trimEvents(), 0);
      assert.equal(raw.shouldTrimEvents(), false, "trimEvents 清零计数");
    } finally {
      raw.close();
    }
    assert.equal(inspectSqliteHeaderFile(fresh).autoVacuum, 2, "100 字节文件头探针同样识别 INCREMENTAL");

    const root = project(dir, "project");
    const store = openProjectStore(path.join(dir, "control"), root);
    try {
      const longText = "零截断".repeat(80_000);
      store.upsertThread({ id: "t-long", workspace: root, title: "long" });
      store.upsertTurnItem({ id: "item-long", threadId: "t-long", runId: "run-long", kind: "assistant", text: longText });
      const start = store.getLatestSeq();
      for (let i = 0; i < 1650; i++) store.appendEvent({ type: "delta", threadId: "t-long" });
      const count = () => store.listEvents({ sinceSeq: 0, limit: 5000 }).length;
      assert.ok(count() >= 1500 && count() < 1500 + 200, `批量裁剪后窗口维持在 [1500, 1700)：${count()}`);
      const cursor = store.getLatestSeq() - 100;
      store.compactProjectDb(root);
      assert.equal(count(), 1500, "checkpoint / compact 时裁剪到 1500 滚动窗口");
      const page = store.listEvents({ sinceSeq: cursor, limit: 500 });
      assert.deepEqual(page.map((e) => e.seq), Array.from({ length: 100 }, (_, i) => cursor + i + 1), "sinceSeq 游标连续不断");
      assert.ok(store.getLatestSeq() - start >= 1650);
      const stored = store.listTurnItems({ threadId: "t-long" }).find((it) => it.id === "item-long");
      assert.equal(stored.text.length, longText.length, "turn_items 历史正文 100% 保留");
      assert.equal(stored.text, longText);
      const result = store.compactProjectDb(root, { allowPhysicalVacuum: true, isIdle: true });
      assert.equal(result.vacuumSkippedReason, "below_watermark", "生产水位下几 MB 小库零物理搬移");
      assert.equal(result.vacuumed, false);
      assert.equal(store.listTurnItems({ threadId: "t-long" }).find((it) => it.id === "item-long").text, longText);
    } finally {
      store.close();
    }
  }));

test("v0.2.7 存量 auto_vacuum=0 旧库一次性无损升级 INCREMENTAL 并回收死页，系统 TEMP 零残留", () =>
  withProjectSandbox("v027-legacy", async (dir) => {
    const file = path.join(dir, "legacy.sqlite");
    const seed = new DatabaseSync(file);
    seed.exec("PRAGMA auto_vacuum = NONE; PRAGMA journal_mode = WAL; CREATE TABLE legacy_marker (x INTEGER);");
    seed.close();
    const { temp, restore } = withSandboxTemp(dir);
    const store = openOrchestratorDb(file);
    try {
      assert.equal(store.inspectStorage().autoVacuum, 0, "存量库保持原模式打开");
      store.upsertThread({ id: "t1", title: "keep", workspace: dir });
      store.upsertTurnItem({ id: "i1", threadId: "t1", runId: "r1", kind: "assistant", text: "历史".repeat(5000) });
      bloat(file);
      const probe = inspectSqliteHeaderFile(file, SMALL);
      assert.equal(probe.source, "header");
      assert.equal(probe.overWatermark, true);
      assert.equal(probe.reclaimableBytes, probe.freeBytes, "NONE 库超水位时整块空闲页可回收");
      const sizeBefore = fs.statSync(file).size;

      const below = store.compactStorage({});
      assert.equal(below.vacuumSkippedReason, "below_watermark", "默认 64 MiB 水位下不搬移");
      const res = store.compactStorage({ ...SMALL, availableDiskBytes: 10 * 1024 ** 3 });
      assert.equal(res.vacuumed, true, JSON.stringify(res.vacuumSkippedReason));
      assert.equal(res.vacuumMode, "upgrade_incremental");
      assert.equal(res.before.autoVacuum, 0);
      assert.equal(res.after.autoVacuum, 2, "VACUUM 后升级为 INCREMENTAL");
      assert.equal(res.after.freelistCount, 0);
      assert.ok(res.freedBytes > 1024 * 1024, `回收死页 ${res.freedBytes}`);
      assert.ok(fs.statSync(file).size < sizeBefore - 1024 * 1024, "主库文件物理缩小");
      assert.equal(store.getThread("t1").title, "keep");
      assert.equal(store.listTurnItems({ threadId: "t1" })[0].text, "历史".repeat(5000), "升级回收后历史详情零损");
      store.appendEvent({ type: "after_vacuum" }, 1);
      assert.ok(fs.existsSync(`${file}-wal`), "finally 恢复 WAL 模式");
      assert.deepEqual(listing(temp), [], "VACUUM 前已设 temp_store = MEMORY，沙盒 TEMP 零临时文件");
    } finally {
      store.close();
      restore();
    }
  }));

test("v0.2.7 INCREMENTAL 库精准保留 reserveFreeBytes 缓冲页，quick_check 与磁盘余量门禁", () =>
  withProjectSandbox("v027-incr", async (dir) => {
    const file = path.join(dir, "incr.sqlite");
    const { temp, restore } = withSandboxTemp(dir);
    const store = openOrchestratorDb(file);
    try {
      bloat(file);
      const before = store.inspectStorage(SMALL);
      assert.equal(before.autoVacuum, 2);
      assert.equal(before.overWatermark, true);
      assert.equal(before.reclaimableBytes, before.freeBytes - SMALL.reserveFreeBytes, "INCREMENTAL 可回收 = 空闲 - 预留缓冲");
      const header = inspectSqliteHeaderFile(file, SMALL);
      for (const key of ["pageSize", "pageCount", "freelistCount", "autoVacuum", "reclaimableBytes"]) assert.equal(header[key], before[key], `文件头探针 ${key} 与 PRAGMA 一致`);

      const low = store.compactStorage({ ...SMALL, availableDiskBytes: 1024 });
      assert.equal(low.vacuumSkippedReason, "low_disk_space");
      assert.equal(low.vacuumed, false);

      const res = store.compactStorage({ ...SMALL, availableDiskBytes: 10 * 1024 ** 3 });
      const reservePages = Math.ceil(SMALL.reserveFreeBytes / before.pageSize);
      assert.equal(res.vacuumMode, "incremental");
      assert.equal(res.reclaimedPages, before.freelistCount - reservePages);
      assert.equal(res.after.freelistCount, reservePages, "精准留下 reserveFreeBytes 空白缓冲页");
      assert.equal(res.after.autoVacuum, 2);
      assert.ok(res.freedBytes > 1024 * 1024);
      assert.equal(fs.statSync(file).size, res.after.totalBytes, "wal_checkpoint(TRUNCATE) 后主库文件物理截短");
      const again = store.compactStorage({ ...SMALL, availableDiskBytes: 10 * 1024 ** 3 });
      assert.equal(again.vacuumSkippedReason, "below_watermark", "回收后回落水位下，不再反复搬移");
      assert.deepEqual(listing(temp), []);
    } finally {
      store.close();
      restore();
    }
  }));

test("v0.2.7 运行缓存：未打开项目库纯只读探针、可回收计入、忙碌 active_tasks 与空闲手动温和压实", () =>
  withProjectSandbox("v027-cache", async (dir) => {
    const root = project(dir, "project");
    const other = project(dir, "other");
    const seeded = openOrchestratorDb(dbFile(other));
    seeded.upsertThread({ id: "t-other", workspace: other });
    seeded.checkpoint();
    seeded.close();
    bloat(dbFile(other));
    fs.writeFileSync(path.join(tower(other), ".gitignore"), "*\n");
    const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: root, catalogLoader: offlineCatalog, recoverStaleState: false });
    try {
      /* 未打开的项目库：仅读 100 字节文件头，零 -wal、零 tower.log、零新文件 */
      const otherBefore = listing(path.join(tower(other), "conversations"));
      const status = await o.getRuntimeCacheStatus({ workspace: other, _sqliteCompactOptions: SMALL });
      assert.deepEqual(listing(path.join(tower(other), "conversations")), otherBefore, "纯只读：不生成 -wal / -shm");
      assert.ok(!fs.existsSync(path.join(tower(other), "logs")), "纯只读：不写 tower.log");
      assert.equal(status.sqlite.source, "header");
      assert.equal(status.sqlite.overWatermark, true);
      assert.ok(status.sqlite.reclaimableBytes > 0 && status.reclaimableBytes >= status.sqlite.reclaimableBytes, "超水位死页计入 reclaimableBytes");
      const prod = await o.getRuntimeCacheStatus({ workspace: other });
      assert.equal(prod.sqlite.overWatermark, false, "生产默认水位下几 MB 库不计入可回收");
      assert.equal(prod.sqlite.reclaimableBytes, 0);

      /* 已打开的默认项目：忙碌时只 trim + checkpoint，标记 active_tasks */
      bloat(dbFile(root));
      // v0.2.7.1: a dead orphan would now be reaped, so model live work owned by another living process.
      o.db.upsertThread({ id: "t-run", title: "run", workspace: root, cwd: root, status: "running", activeRunId: "r-live" });
      o.db.upsertRun({ id: "r-live", threadId: "t-run", status: "running", meta: { ownerPid: process.ppid } });
      const busy = await o.cleanRuntimeCache({ workspace: root, _sqliteCompactOptions: SMALL });
      assert.equal(busy.sqliteCompaction.vacuumSkippedReason, "active_tasks");
      assert.equal(busy.sqliteCompaction.vacuumed, false);
      assert.equal(busy.sqliteCompaction.checkpointed, true);
      assert.equal(busy.status.sqlite.overWatermark, true, "忙碌时死页原样保留待下次空闲回收");

      o.db.upsertRuntimeRequest({ id: "req-1", threadId: "t-run", kind: "approval", status: "pending", workspace: root });
      o.db.upsertRun({ id: "r-live", threadId: "t-run", status: "completed" });
      o.db.upsertThread({ id: "t-run", status: "completed", activeRunId: null });
      assert.equal((await o.cleanRuntimeCache({ workspace: root, _sqliteCompactOptions: SMALL })).sqliteCompaction.vacuumSkippedReason, "active_tasks", "待介入请求同样拦截");
      o.db.upsertRuntimeRequest({ id: "req-1", threadId: "t-run", status: "resolved" });

      /* 全部空闲：手动清理触发温和压实，并保留缓冲页 */
      const idle = await o.cleanRuntimeCache({ workspace: root, _sqliteCompactOptions: SMALL });
      assert.equal(idle.sqliteCompaction.vacuumed, true, JSON.stringify(idle.sqliteCompaction.vacuumSkippedReason));
      assert.equal(idle.sqliteCompaction.vacuumMode, "incremental");
      assert.equal(idle.sqliteCompaction.after.freelistCount, Math.ceil(SMALL.reserveFreeBytes / idle.sqliteCompaction.before.pageSize));
      assert.equal(idle.status.sqlite.overWatermark, false);
      assert.equal(o.db.getThread("t-run").title, "run");

      /* 低磁盘与默认兼容：未授权物理回收时只做 trim + checkpoint */
      bloat(dbFile(root));
      const lowDisk = o.db.compactProjectDb(root, { ...SMALL, allowPhysicalVacuum: true, isIdle: true, availableDiskBytes: 1 });
      assert.equal(lowDisk.vacuumSkippedReason, "low_disk_space");
      const legacyCall = o.db.compactProjectDb(root);
      assert.deepEqual([legacyCall.trimmed, legacyCall.checkpointed, "vacuumed" in legacyCall], [true, true, false]);
      assert.equal(o.db.inspectProjectDb(root, SMALL).source, "connection");
    } finally {
      await o.shutdown();
    }
  }));

test("v0.2.7 Studio：运行缓存摘要展示可回收容量，清理提示说明运行中任务跳过物理压实", async () => {
  const studioDir = path.join(repoRoot, "sidecars", "studio");
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => { const t = realSetTimeout(fn, ms, ...args); t?.unref?.(); return t; };
  const els = new Map();
  const toasts = [];
  const el = (id) => {
    if (!els.has(id)) els.set(id, { id, innerHTML: "", textContent: "", hidden: false, disabled: false, classList: { toggle() {} }, setAttribute() {} });
    return els.get(id);
  };
  globalThis.location = { pathname: "/", search: "" };
  globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.document = {
    activeElement: null,
    getElementById: (id) => (id === "toast-container" ? { appendChild: (node) => toasts.push(node.textContent) } : el(id)),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({ className: "", textContent: "", remove() {} }),
  };
  const status = { ok: true, projectRoot: "F:/repo", exists: true, totalBytes: 12 * 1024 * 1024, reclaimableBytes: 3 * 1024 * 1024,
    bytesByArea: {}, worktreeCount: 0, idleWorktreeCount: 0, protectedWorktreeCount: 0, worktrees: [] };
  globalThis.window = { sidecar: { conversationId: "conv-1", fetch: async (url, init) => {
    const { method } = JSON.parse(init.body);
    const result = method === "cleanRuntimeCache"
      ? { ok: true, freedBytes: 0, removedWorktrees: [], skippedWorktrees: [], status: { ...status, reclaimableBytes: 0 },
          sqliteCompaction: { ok: true, vacuumed: false, vacuumSkippedReason: "active_tasks" } }
      : method === "getRuntimeCacheStatus" ? status : { worktrees: [] };
    return { ok: true, status: 200, json: async () => ({ ok: true, result }) };
  } } };
  try {
    const mod = (f) => import(pathToFileURL(path.join(studioDir, "ui", f)).href);
    const { state } = await mod("state.js");
    const cfg = await mod("config-view.js");
    state.runtimeCache.data = status;
    cfg.renderRuntimeCacheSection();
    assert.match(el("runtime-cache-summary").innerHTML, /当前项目运行缓存 12\.0 MB（含 0 个闲置工作树） <span class="rc-sub">· 可回收 3\.0 MB<\/span>/);
    state.runtimeCache.data = { ...status, reclaimableBytes: 0 };
    cfg.renderRuntimeCacheSection();
    assert.doesNotMatch(el("runtime-cache-summary").innerHTML, /可回收/, "零可回收时不展示");
    await cfg.handleCleanRuntimeCache();
    assert.ok(toasts.some((t) => /运行缓存清理完成：已释放 0 B.*有运行中任务，数据库物理压实已跳过/.test(t)), toasts.join("|"));
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

test("v0.2.7.1 手动清理：收割无转录幽灵原生行与死孤儿外部行，排除被动顶层宿主会话，真实运行中成员仍拦截，最终 VACUUM 缩小文件", () =>
  withProjectSandbox("v0271-unblock", async (dir) => {
    const root = project(dir, "project");
    const appDataDir = path.join(dir, "host");
    fs.mkdirSync(path.join(appDataDir, "brain"), { recursive: true });
    const hostRoot = "0cfd1bba-0000-4000-8000-0000000000aa";
    const member = "0cfd1bba-0000-4000-8000-0000000000bb";
    const phantomRoot = "12345678-0000-4000-8000-123456789abc";
    const phantomChild = "23456789-0000-4000-8000-123456789abc";
    for (const id of [hostRoot, member]) {
      const file = resolveTranscriptPath(id, appDataDir);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "");
    }
    const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: root, catalogLoader: offlineCatalog, recoverStaleState: false });
    try {
      await o.updateHostContext({ appDataDir });
      const native = (id, convId, extra = {}) => o.db.upsertThread({ id, title: id, provider: "antigravity", status: "running",
        workspace: root, cwd: root, hostConversationId: convId, nativeSessionId: convId,
        meta: { isNativeHost: true, projectRoot: root, ...extra.meta }, ...extra.fields });
      native(`thr_native_${hostRoot}`, hostRoot, { fields: { role: "commander" }, meta: { memberName: "coordinator" } });
      native(`thr_native_${member}`, member, { fields: { role: "executor", parentThreadId: `thr_native_${hostRoot}` }, meta: { memberName: "worker", isSwarmMember: true } });
      native(`thr_native_${phantomRoot}`, phantomRoot, { fields: { role: "commander" }, meta: { memberName: "coordinator" } });
      native(`thr_native_${phantomChild}`, phantomChild, { fields: { role: "advisor", parentThreadId: `thr_native_${phantomRoot}` }, meta: { memberName: "advisor_argon" } });
      o.db.upsertThread({ id: "t-dead", title: "dead external", provider: "claude-code", workspace: root, cwd: root, status: "running", activeRunId: "r-dead" });
      o.db.upsertRun({ id: "r-dead", threadId: "t-dead", status: "running", provider: "claude-code" });
      bloat(dbFile(root));

      /* 运行中的原生 Swarm 成员（有真实转录）属于真实在途工作：照常拦截物理压实 */
      const blocked = await o.cleanRuntimeCache({ workspace: root, _sqliteCompactOptions: SMALL });
      assert.equal(blocked.sqliteCompaction.vacuumSkippedReason, "active_tasks");
      assert.deepEqual([...blocked.reconciledThreads.phantomNative].sort(), [`thr_native_${phantomChild}`, `thr_native_${phantomRoot}`].sort());
      assert.deepEqual(blocked.reconciledThreads.orphanExternal, ["t-dead"]);
      for (const id of [phantomRoot, phantomChild]) {
        const t = o.db.getThread(`thr_native_${id}`);
        assert.equal(t.archived, true);
        assert.equal(t.status, "interrupted");
        assert.equal(t.meta.archivedMissingTranscript, true);
      }
      assert.equal(o.db.getThread("t-dead").status, "interrupted");
      assert.equal(o.db.getRun("r-dead").status, "interrupted");
      assert.equal(o.db.getThread(`thr_native_${hostRoot}`).archived, false, "有真实转录的宿主会话不得被收割");
      assert.equal(o.db.getThread(`thr_native_${member}`).status, "running");

      /* 成员收尾待命后：仅剩被动顶层宿主会话仍为 running，不再阻断 → 物理回收真实缩小文件 */
      o.db.upsertThread({ id: `thr_native_${member}`, status: "waiting" });
      const sizeBefore = fs.statSync(dbFile(root)).size;
      const idle = await o.cleanRuntimeCache({ workspace: root, _sqliteCompactOptions: SMALL });
      assert.equal(idle.sqliteCompaction.vacuumed, true, JSON.stringify(idle.sqliteCompaction));
      assert.ok(fs.statSync(dbFile(root)).size < sizeBefore, "物理文件真实缩小");
      assert.equal(o.db.getThread(`thr_native_${hostRoot}`).status, "running", "顶层宿主会话原样保留");
      assert.equal(idle.reconciledThreads, undefined, "无可收割行时不附带 reconciledThreads");
    } finally {
      await o.shutdown();
    }
  }));

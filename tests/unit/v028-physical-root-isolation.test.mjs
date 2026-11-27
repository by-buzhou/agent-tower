import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { openOrchestratorDb } from "../../core/db.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { openProjectStore } from "../../core/project-store.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

const databasePath = root => path.join(root, ".agent-tower", "conversations", "tower.sqlite");
const workspaceKey = root => path.resolve(root).replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

function seedLegacyDatabase(file, workspace) {
  const raw = new DatabaseSync(file);
  try {
    raw.exec(`
      CREATE TABLE threads (
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
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
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
      CREATE TABLE events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT NOT NULL,
        thread_id TEXT NOT NULL DEFAULT '',
        run_id TEXT NOT NULL DEFAULT '',
        workspace_key TEXT NOT NULL DEFAULT '',
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
    const insertThread = raw.prepare(`INSERT INTO threads
      (id, parent_thread_id, host_conversation_id, workspace_key, role, meta_json, created_at, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1)`);
    for (const row of [
      ["host", null, "Root-Host", "commander", { isNativeHost: true }],
      ["parent", "host", "", "executor", {}],
      ["child", "parent", "", "executor", {}],
      ["meta-root", null, "", "executor", { rootConversationId: "Root-Meta" }],
      ["meta-parent", null, "", "executor", { parentConversationId: "Root-Parent" }],
      ["cycle-a", "cycle-b", "", "executor", {}],
      ["cycle-b", "cycle-a", "", "executor", {}],
    ]) insertThread.run(row[0], row[1], row[2], workspaceKey(workspace), row[3], JSON.stringify(row[4]));
    const insertRun = raw.prepare("INSERT INTO runs (id, thread_id, meta_json, created_at, updated_at) VALUES (?, ?, ?, 1, 1)");
    insertRun.run("run-child", "child", "{}");
    insertRun.run("run-meta", "meta-root", "{}");
    insertRun.run("run-own", "missing", JSON.stringify({ rootConversationId: "Root-Run" }));
    const insertEvent = raw.prepare("INSERT INTO events (type, thread_id, payload_json, created_at) VALUES (?, ?, ?, 1)");
    insertEvent.run("legacy", "", JSON.stringify({ rootConversationId: "Root-Event" }));
    insertEvent.run("legacy", "", JSON.stringify({ swarm: { rootConversationId: "Root-Swarm" } }));
    insertEvent.run("legacy", "child", "{}");
    insertEvent.run("legacy", "", "{}");
  } finally {
    raw.close();
  }
}

function rootRows(file, table, key = "id") {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    return raw.prepare(`SELECT ${key} AS key, root_conversation_id AS root FROM ${table} ORDER BY ${key}`).all()
      .map(row => [row.key, row.root]);
  } finally {
    raw.close();
  }
}

function queryPlan(raw, sql, ...params) {
  return raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(row => row.detail).join(" | ");
}

async function withOrchestrator(name, action) {
  return withProjectSandbox(name, async dir => {
    const cwd = project(dir, "workspace");
    const orchestrator = createOrchestrator({
      dataDir: path.join(dir, "control"),
      defaultStudioRoot: cwd,
      catalogLoader: offlineCatalog,
      recoverStaleState: false,
      hostWakeSender: async () => ({ ok: true }),
    });
    try {
      await action(orchestrator, cwd, dir);
    } finally {
      await orchestrator.shutdown();
    }
  });
}

test("v0.2.8 旧三表同事务补列回填、四个物理索引命中、写入继承与重开幂等", () =>
  withProjectSandbox("v028-migration", dir => {
    const file = path.join(dir, "legacy.sqlite");
    seedLegacyDatabase(file, dir);
    let store = openOrchestratorDb(file);
    try {
      const raw = new DatabaseSync(file, { readOnly: true });
      try {
        for (const table of ["threads", "runs", "events"]) {
          assert.ok(raw.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === "root_conversation_id"), table);
        }
        assert.equal(raw.prepare("PRAGMA table_info(conversation_policies)").all().length, 6, "conversation_policies 保持六列");
        assert.match(queryPlan(raw, "SELECT * FROM threads WHERE root_conversation_id=? COLLATE NOCASE ORDER BY updated_at DESC", "Root-Host"), /idx_threads_root_conv/);
        assert.match(queryPlan(raw, "SELECT * FROM threads WHERE workspace_key=? AND role=? AND archived_at IS NULL AND root_conversation_id=? COLLATE NOCASE", workspaceKey(dir), "executor", "Root-Host"), /idx_threads_ws_role_root/);
        assert.match(queryPlan(raw, "SELECT * FROM runs WHERE root_conversation_id=? COLLATE NOCASE ORDER BY created_at DESC", "Root-Host"), /idx_runs_root_conv/);
        assert.match(queryPlan(raw, "SELECT * FROM events WHERE root_conversation_id=? COLLATE NOCASE AND seq>0 ORDER BY seq ASC", "Root-Host"), /idx_events_root_seq/);
      } finally {
        raw.close();
      }
      assert.deepEqual(rootRows(file, "threads"), [
        ["child", "Root-Host"], ["cycle-a", ""], ["cycle-b", ""], ["host", "Root-Host"],
        ["meta-parent", "Root-Parent"], ["meta-root", "Root-Meta"], ["parent", "Root-Host"],
      ]);
      assert.deepEqual(rootRows(file, "runs"), [["run-child", "Root-Host"], ["run-meta", "Root-Meta"], ["run-own", "Root-Run"]]);
      assert.deepEqual(rootRows(file, "events", "seq"), [[1, "Root-Event"], [2, "Root-Swarm"], [3, "Root-Host"], [4, ""]]);
    } finally {
      store.close();
    }

    const before = {
      threads: rootRows(file, "threads"), runs: rootRows(file, "runs"), events: rootRows(file, "events", "seq"),
    };
    store = openOrchestratorDb(file);
    try {
      assert.deepEqual({ threads: rootRows(file, "threads"), runs: rootRows(file, "runs"), events: rootRows(file, "events", "seq") }, before, "重复启动不重复改写历史归属");
      const child = store.upsertThread({ id: "new-child", parentThreadId: "child", workspace: dir, role: "executor" });
      assert.equal(child.rootConversationId, "Root-Host");
      assert.equal(child.meta.rootConversationId, "Root-Host");
      const run = store.upsertRun({ id: "new-run", threadId: child.id, status: "completed" });
      assert.equal(run.rootConversationId, "Root-Host");
      store.appendEvent({ type: "new_event", threadId: child.id }, 100);
      assert.deepEqual(store.listRuns({ rootConversationId: "root-host" }).map(row => row.id), ["run-child", "new-run"]);
      assert.ok(store.listThreads({ rootConversationId: "ROOT-HOST" }).some(row => row.id === child.id));
      assert.deepEqual(store.listEvents({ rootConversationId: "root-host" }).map(row => row.seq), [3, 100]);

      const raw = new DatabaseSync(file);
      try {
        assert.equal(raw.prepare("SELECT root_conversation_id AS root FROM events WHERE seq=100").get().root, "Root-Host");
        raw.prepare("UPDATE threads SET meta_json='{}' WHERE id=?").run(child.id);
      } finally {
        raw.close();
      }
      assert.deepEqual(store.listRoleThreads(dir, "executor", "ROOT-HOST").map(row => row.id), ["child", "parent", child.id], "花名册不再依赖 meta_json");
    } finally {
      store.close();
    }
  }));

test("v0.2.8 会话 B 400 条事件不挤丢会话 A 单页，空页游标仍单调推进", () =>
  withOrchestrator("v028-events", async (orchestrator, cwd) => {
    for (const [id, root] of [["thread-a", "conv-a"], ["thread-b", "conv-b"]]) {
      orchestrator.db.upsertThread({ id, workspace: cwd, cwd, role: "executor", meta: { rootConversationId: root, projectRoot: cwd } });
    }
    const first = orchestrator.db.appendEvent({ type: "marker", threadId: "thread-a", marker: "a" });
    for (let i = 0; i < 400; i++) orchestrator.db.appendEvent({ type: "marker", threadId: "thread-b", marker: `b-${i}` });
    const page = await orchestrator.getEvents({ conversationId: "conv-a", sinceSeq: 0, limit: 50 });
    assert.deepEqual(page.events.map(event => event.marker), ["a"]);
    assert.equal(page.nextSeq, page.latestSeq, "不相关的会话尾事件只推进游标，不进入本会话事件列表");
    assert.ok(page.nextSeq > first.seq);

    const latest = orchestrator.db.getLatestSeq();
    const empty = await orchestrator.getEvents({ conversationId: "conv-a", sinceSeq: latest, limit: 50 });
    assert.deepEqual(empty.events, []);
    assert.equal(empty.nextSeq, latest);
  }));

test("v0.2.8 listRoleThreads 对未初始化目录零建库零写盘，hasProjectDb 纯只读", () =>
  withProjectSandbox("v028-zero-touch", dir => {
    const root = project(dir, "workspace");
    const blank = path.join(dir, "blank");
    fs.mkdirSync(blank);
    const store = openProjectStore(path.join(dir, "control"), root);
    try {
      assert.equal(store.hasProjectDb(root), true);
      assert.equal(store.hasProjectDb(blank), false);
      assert.deepEqual(fs.readdirSync(blank), []);
      assert.deepEqual(store.listRoleThreads(blank, "executor", "conv-a"), []);
      assert.equal(store.hasProjectDb(blank), false);
      assert.deepEqual(fs.readdirSync(blank), [], "只读花名册不得创建 .agent-tower、SQLite 或日志");
    } finally {
      store.close();
    }
  }));

test("v0.2.8 单会话归档跳过被动宿主、拒绝不可停在途成员且不误伤同库会话 B", () =>
  withOrchestrator("v028-archive", async (orchestrator, cwd) => {
    const convA = "conv-a";
    const convB = "conv-b";
    const hostId = "thr_native_conv-a";
    orchestrator.db.upsertThread({
      id: hostId, provider: "antigravity", role: "commander", status: "running", workspace: cwd, cwd,
      hostConversationId: convA, nativeSessionId: convA,
      meta: { isNativeHost: true, memberName: "coordinator", projectRoot: cwd },
    });
    for (const [id, status] of [["a-blocked", "running"], ["a-done", "completed"]]) {
      orchestrator.db.upsertThread({ id, parentThreadId: hostId, role: "executor", status, workspace: cwd, cwd,
        activeRunId: id === "a-blocked" ? "run-a" : "", meta: { projectRoot: cwd } });
    }
    orchestrator.db.upsertRun({ id: "run-a", threadId: "a-blocked", status: "running", meta: { ownerPid: process.ppid } });
    orchestrator.db.upsertThread({ id: "b-running", role: "executor", status: "running", workspace: cwd, cwd,
      activeRunId: "run-b", meta: { rootConversationId: convB, projectRoot: cwd } });
    orchestrator.db.upsertRun({ id: "run-b", threadId: "b-running", status: "running", meta: { ownerPid: process.ppid } });

    await assert.rejects(orchestrator.deleteThread({ conversationId: convA, archiveConversation: true }), error => {
      assert.equal(error.code, "THREAD_STILL_RUNNING");
      return true;
    });
    for (const id of [hostId, "a-blocked", "a-done", "b-running"]) assert.equal(orchestrator.db.getThread(id).archived, false, id);
    assert.equal(orchestrator.db.getRun("run-b").status, "running");

    orchestrator.db.upsertRun({ id: "run-a", status: "completed" });
    orchestrator.db.upsertThread({ id: "a-blocked", status: "completed", activeRunId: null });
    const result = await orchestrator.deleteThread({ conversationId: convA, archiveConversation: true });
    assert.equal(result.deleted, true);
    assert.equal(result.rootConversationId, convA);
    assert.deepEqual(result.deletedIds.sort(), ["a-blocked", "a-done"]);
    assert.equal(orchestrator.db.getThread(hostId).archived, false, "被动顶层宿主不归档");
    assert.equal(orchestrator.db.getThread(hostId).status, "running", "被动顶层宿主不停止");
    assert.equal(orchestrator.db.getThread("b-running").archived, false);
    assert.equal(orchestrator.db.getThread("b-running").status, "running");
    assert.equal(orchestrator.db.getRun("run-b").status, "running");
  }));

test("v0.2.8 存量空 meta 与空事件载荷从物理列恢复根会话", () =>
  withProjectSandbox("v028-physical-fallback", async dir => {
    const cwd = project(dir, "workspace");
    const file = databasePath(cwd);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    seedLegacyDatabase(file, cwd);
    const orchestrator = createOrchestrator({
      dataDir: path.join(dir, "control"),
      defaultStudioRoot: cwd,
      catalogLoader: offlineCatalog,
      recoverStaleState: false,
      hostWakeSender: async () => ({ ok: true }),
    });
    try {
      const page = await orchestrator.getEvents({ conversationId: "root-host", sinceSeq: 0 });
      const legacy = page.events.find(event => event.seq === 3);
      assert.ok(legacy, "payload_json='{}' 的存量回填事件不得被二次过滤丢弃");
      assert.equal(legacy.rootConversationId, "Root-Host");
      const policy = await orchestrator.getConversationPolicy({ threadId: "child" });
      assert.equal(policy.rootConversationId, "Root-Host", "meta_json='{}' 时从线程物理列还原根会话");
    } finally {
      await orchestrator.shutdown();
    }
  }));

test("v0.2.8 强制归档等待异步收尾且不误伤同库会话 B", () =>
  withOrchestrator("v028-archive-settling", async (orchestrator, cwd) => {
    const handles = [];
    orchestrator.engineManager.runTurn = () => {
      let resolve;
      const handle = {
        result: new Promise(r => { resolve = r; }),
        cancels: 0,
        resolve: value => resolve(value),
        async cancel() { this.cancels++; resolve({ status: "interrupted" }); },
        async forceKill() { this.cancels++; setTimeout(() => resolve({ status: "interrupted" }), 15); },
        async respondPermission() {},
      };
      handles.push(handle);
      return handle;
    };
    await orchestrator.setConversationPolicy({ conversationId: "conv-a", orchestrationMode: "relay", workspace: cwd });
    await orchestrator.setConversationPolicy({ conversationId: "conv-b", orchestrationMode: "relay", workspace: cwd });
    const taskA = await orchestrator.delegateTask({ conversationId: "conv-a", cwd, workspace: cwd, presetKey: "executor_codex", task: "会话 A" });
    const taskB = await orchestrator.delegateTask({ conversationId: "conv-b", cwd, workspace: cwd, presetKey: "executor_codex", task: "会话 B" });

    const result = await orchestrator.deleteThread({ conversationId: "conv-a", archiveConversation: true, force: true });
    assert.deepEqual(result.deletedIds, [taskA.threadId]);
    assert.equal(handles[0].cancels, 1);
    assert.equal(orchestrator.db.getRun(taskA.runId).status, "interrupted");
    assert.equal(orchestrator.db.getThread(taskA.threadId).archived, true);
    assert.equal(handles[1].cancels, 0);
    assert.equal(orchestrator.db.getRun(taskB.runId).status, "running");
    assert.equal(orchestrator.db.getThread(taskB.threadId).archived, false);

    handles[1].resolve({ status: "completed" });
    for (let i = 0; i < 200 && orchestrator.db.getRun(taskB.runId)?.status === "running"; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(orchestrator.db.getRun(taskB.runId).status, "completed");
  }));

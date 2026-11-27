import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { offlineCatalog } from "../helpers/fixtures.mjs";
import { repoRoot, runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

const VERSION = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugin.json"), "utf8")).version;

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

const rpcReturns = {
  getBootstrap: { version: VERSION },
  getConversationPolicy: { dispatchEnabled: false },
  setConversationPolicy: { ok: true },
  listHealthIncidents: { incidents: [] },
  dismissHealthIncident: { dismissedCount: 0 },
  getCapabilities: { providers: [] },
  saveSettings: { providers: [] },
  listThreads: { threads: [] },
  listWorktrees: { worktrees: [] },
  listExtensionProviders: { customProviders: [] },
  updateHostContext: { ok: true },
  getEvents: { hasActiveRuns: false },
  systemUpdate: { state: "idle", currentVersion: VERSION },
};

// Validation paths reach the real handlers without starting engines or touching worktrees.
const rpcRejects = {
  listProjectSpecs: [{ cwd: "relative" }, { code: "CWD_REJECTED" }],
  initProjectSpecs: [{ cwd: "relative" }, { code: "CWD_REJECTED" }],
  specCuration: [{}, { code: "INVALID_SPEC_CURATION_ACTION", message: /specCuration/ }],
  delegateTask: [{ conversationId: "contract-validation", task: "" }, /delegateTask/],
  delegateParallelBatch: [{ conversationId: "contract-validation", tasks: [] }, /delegateParallelBatch/],
  getTaskStatus: [{}, /getTaskStatus/],
  cancelTask: [{ runId: "missing" }, /找不到要中断的任务或会话/],
  cancelThread: [{ runId: "missing" }, /找不到要中断的任务或会话/],
  launchThread: [{ cwd: "relative" }, { code: "CWD_REJECTED" }],
  deleteThread: [{}, /deleteThread/],
  archiveThread: [{}, /deleteThread/],
  readThread: [{}, /readThread/],
  sendToThread: [{ conversationId: "contract-validation" }, /sendToThread/],
  manageQueue: [{ conversationId: "contract-validation" }, /manageQueue/],
  configureThread: [{ conversationId: "contract-validation" }, /configureThread/],
  retryRun: [{ conversationId: "contract-validation" }, /retryRun/],
  respondRuntimeRequest: [{}, /找不到待处理的审批或提问请求/],
  runCodeReview: [{ conversationId: "contract-validation", worktreePath: "relative" }, /worktreePath/],
  reviewCode: [{ conversationId: "contract-validation", worktreePath: "relative" }, /worktreePath/],
  getWorktreeDiff: [{ worktreePath: "relative" }, /worktreePath/],
  integrateWorktree: [{ threadId: "missing" }, /拒绝从普通项目目录合并/],
  cleanupWorktree: [{ threadId: "missing" }, /拒绝清理普通项目目录/],
  getRuntimeCacheStatus: [{ workspace: "relative" }, { code: "CWD_REJECTED" }],
  cleanRuntimeCache: [{ cwd: "relative" }, { code: "CWD_REJECTED" }],
  probeExtensionProvider: [{}, /probeExtensionProvider/],
  saveExtensionProvider: [{}, /saveExtensionProvider/],
  removeExtensionProvider: [{}, /removeExtensionProvider/],
};

const facadeFunctions = [
  "hasActiveRuns", "setStudioUrl", "getStudioUrl", "resolveConversationRoot",
  "matchesEventConversation", "subscribe", "handleRpc", "shutdown",
];

function openOrchestrator(dir, name, options = {}) {
  const workspace = path.join(dir, name);
  fs.mkdirSync(workspace);
  const orchestrator = createOrchestrator({
    dataDir: path.join(workspace, "control"),
    defaultStudioRoot: workspace,
    catalogLoader: offlineCatalog,
    ...options,
  });
  orchestrator.updateHostContext({ appDataDir: workspace });
  return orchestrator;
}

test("orchestrator facade exposes all 40 RPC routes", () =>
  withProjectSandbox("orchestrator-contract", async dir => {
    const o = openOrchestrator(dir, "contract");
    try {
      const rpcNames = [...Object.keys(rpcReturns), ...Object.keys(rpcRejects)];
      assert.equal(rpcNames.length, 40);
      const methods = [...rpcNames, ...facadeFunctions];
      assert.deepEqual(Object.keys(o).sort(), [...methods, "version", "db", "engineManager"].sort());
      for (const name of methods) assert.equal(typeof o[name], "function", name);
      assert.equal(o.version, VERSION);
      assert.equal(typeof o.db.getThread, "function");
      assert.equal(typeof o.engineManager.shutdownAll, "function");
      assert.equal(o.cancelThread, o.cancelTask);
      assert.equal(o.reviewCode, o.runCodeReview);
      assert.equal(o.updateHostContext({}), undefined);
      assert.equal(o.hasActiveRuns(), false);

      for (const [method, expected] of Object.entries(rpcReturns)) {
        const params = {
          dismissHealthIncident: { dismissAll: true },
          listWorktrees: { conversationId: "contract-empty" },
          systemUpdate: { action: "status" },
        }[method];
        const actual = await o.handleRpc(method, params);
        for (const [key, value] of Object.entries(expected)) {
          assert.deepEqual(actual[key], value, `${method}.${key}`);
        }
      }
      await o.setConversationPolicy({ conversationId: "contract-validation", workspace: o.db.defaultStudioRoot, orchestrationMode: "complex" });
      for (const [method, [params, expected]] of Object.entries(rpcRejects)) {
        await assert.rejects(o.handleRpc(method, params), expected, method);
      }
      await assert.rejects(o.handleRpc("notARoute"), { code: "METHOD_NOT_FOUND" });
      await assert.rejects(o.handleRpc("systemUpdate"), { code: "INVALID_SYSTEM_UPDATE_ACTION", message: /systemUpdate/ });
    } finally {
      await o.shutdown();
    }
  }));

test("orchestrator instances do not share catalog, Studio URL, or event listeners", () =>
  withProjectSandbox("orchestrator-isolation", async dir => {
    const loads = [0, 0];
    const instances = [0, 1].map(index => openOrchestrator(dir, `instance-${index}`, {
      recoverStaleState: false,
      studioUrl: `initial-${index}`,
      catalogLoader: async () => {
        loads[index]++;
        return offlineCatalog();
      },
    }));
    const [a, b] = instances;
    const aEvents = [];
    const bEvents = [];
    const unsubscribe = [a.subscribe(event => aEvents.push(event.type)), b.subscribe(event => bEvents.push(event.type))];
    try {
      a.setStudioUrl("updated");
      await Promise.all(instances.map(o => o.getCapabilities()));
      assert.equal((await a.getBootstrap()).studioUrl, "updated");
      assert.equal((await b.getBootstrap()).studioUrl, "initial-1");
      assert.deepEqual(loads, [1, 1]);
      await a.saveSettings({ defaultDispatchEnabled: false });
      assert.deepEqual(aEvents, ["settings_updated"]);
      assert.deepEqual(bEvents, []);
      assert.equal(b.getConversationPolicy().dispatchEnabled, false);
    } finally {
      for (const off of unsubscribe) off();
      await Promise.all(instances.map(o => o.shutdown()));
    }
  }));

test("orchestrator is a thin composition root with no sibling module imports", () => {
  const core = path.resolve(import.meta.dirname, "../../core");
  const root = path.join(core, "orchestrator.mjs");
  const modules = path.join(core, "orchestrator");
  const source = fs.readFileSync(root, "utf8");
  assert.ok(source.trimEnd().split(/\r?\n/).length <= 300, "composition root exceeds 300 lines");

  const files = fs.readdirSync(modules).filter(file => file.endsWith(".mjs"));
  assert.ok(files.includes("helpers.mjs"));
  assert.ok(files.length > 1);
  const helper = path.join(modules, "helpers.mjs");
  const peers = new Set(files.map(file => path.join(modules, file)));
  for (const file of [root, ...peers]) {
    const text = fs.readFileSync(file, "utf8");
    const declarations = /^\s*(?:import\s+(?!\()|export\s+(?=[*{]))(?:(?:[\w*$,\s]|\{[^}]*\})+\s+from\s+)?(["'])([^"'\r\n]+)\1/gm;
    for (const [, , specifier] of text.matchAll(declarations)) {
      if (!specifier.startsWith(".")) continue;
      const target = path.resolve(path.dirname(file), specifier);
      assert.ok(fs.statSync(target, { throwIfNoEntry: false })?.isFile(), `${file}: missing ${specifier}`);
      if (file !== root) {
        assert.notEqual(target, root, `${file}: must not import the composition root`);
        if (peers.has(target)) {
          assert.ok(file !== helper && target === helper, `${file}: forbidden sibling import ${specifier}`);
        }
      }
    }
  }
});

test("host context updates do not affect the process or other orchestrators", () =>
  withProjectSandbox("host-context-isolation", async dir => {
    const a = openOrchestrator(dir, "first");
    const original = { ...process.env };
    let b;
    try {
      const appDataDir = path.join(dir, "host-a");
      fs.mkdirSync(appDataDir);
      a.updateHostContext({ appDataDir, agentApiExe: path.join(appDataDir, "agentapi"), projectId: "host-a" });
      for (const key of ["ANTIGRAVITY_APP_DATA_DIR", "ANTIGRAVITY_AGENTAPI_EXE", "ANTIGRAVITY_PROJECT_ID"]) {
        assert.equal(process.env[key], original[key], key);
      }
      b = openOrchestrator(dir, "second");
      assert.equal(a.engineManager.getHostContext().appDataDir, appDataDir);
      assert.notEqual(b.engineManager.getHostContext().appDataDir, appDataDir);
    } finally {
      await Promise.all([a, b].filter(Boolean).map(o => o.shutdown()));
    }
  }));

test("startup recovery preserves live foreign and native approvals but cancels stale requests", () =>
  withProjectSandbox("startup-recovery", async dir => {
    const workspace = path.join(dir, "recovery");
    const a = openOrchestrator(dir, "recovery", { recoverStaleState: false });
    try {
      for (const [id, ownerPid, isNativeHost] of [["foreign", process.ppid, false], ["native", undefined, true], ["stale", undefined, false]]) {
        const runId = `run-${id}`;
        a.db.upsertThread({ id, workspace, cwd: workspace, status: "waiting_approval", activeRunId: runId, meta: { isNativeHost } });
        a.db.upsertRun({ id: runId, threadId: id, status: "waiting_approval", meta: { ownerPid } });
        a.db.upsertRuntimeRequest({ id: `req-${id}`, threadId: id, runId, status: "pending" });
      }
    } finally {
      await a.shutdown();
    }
    const b = createOrchestrator({ dataDir: path.join(workspace, "control"), defaultStudioRoot: workspace, catalogLoader: offlineCatalog });
    try {
      for (const id of ["foreign", "native"]) {
        assert.equal(b.db.getThread(id).status, "waiting_approval");
        assert.equal(b.db.getRuntimeRequest(`req-${id}`).status, "pending");
      }
      assert.equal(b.db.getThread("stale").activeRunId, "");
      assert.equal(b.db.getRun("run-stale").status, "interrupted");
      assert.equal(b.db.getRuntimeRequest("req-stale").status, "cancelled");
    } finally {
      await b.shutdown();
    }
  }));

test("review prompts enforce engineering restraint against over-design and unrequested interceptors", () =>
  withProjectSandbox("review-restraint", async dir => {
    const o = openOrchestrator(dir, "review-restraint");
    o.db.saveSettings({ defaultOrchestrationMode: "complex" });
    const prompts = [];
    o.engineManager.runTurn = input => {
      prompts.push(input.prompt);
      return {
        result: Promise.resolve({ status: "completed", assistantText: "PASS" }),
        async cancel() {},
        async forceKill() {},
        async steer() { return { supported: false }; },
        async respondPermission() {},
      };
    };
    try {
      const cwd = path.join(dir, "review-restraint");
      await o.runCodeReview({ cwd, conversationId: "rev-conv", wait: true });
      await o.runCodeReview({ cwd, conversationId: "rev-conv", readOnly: true, provider: "codex", wait: true });
      assert.equal(prompts.length, 2);
      assert.match(prompts[0], /严禁过度设计/);
      assert.match(prompts[0], /防御性白名单/);
      assert.match(prompts[1], /over-engineered abstractions/i);
    } finally {
      await o.shutdown();
    }
  }));

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildInitialRosterFromProbe, buildAgyPinnedModelId, DEFAULT_ROLE_PRESETS, resolveRoleTarget, swarmMemberName } from "../../core/catalog.mjs";
import { execHostAgentApi, runAgyNativeTurn } from "../../core/engines/agy-native.mjs";
import { createEngineManager } from "../../core/engines/index.mjs";
import { globalSettings } from "../../core/global-settings.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";

const binary = { command: process.execPath, resolvedPath: process.execPath };
const agyModel = "gemini-4-argon";
const swarmAdvisor = { group: "advisor", label: "军师 D · Argon", provider: "antigravity", model: agyModel, effort: "high" };
const hostContext = agentApiExe => ({ agentApiExe, lsAddress: "fixture-address", csrfToken: "fixture-token" });
const normalPath = value => value.replaceAll("\\", "/");

function fakeAgentApi(dir) {
  const log = path.join(dir, "agentapi.log");
  const windows = process.platform === "win32";
  const exe = path.join(dir, windows ? "agentapi.cmd" : "agentapi");
  fs.writeFileSync(exe, windows ? `@echo off\necho %*>>"${log}"\n` : `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
  return { exe, calls: () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split(/\r?\n/) : [] };
}

test("host dispatch and review return native dual-mode actions before allocating worktrees or native threads", () => withProjectSandbox("v022-host-dispatch", async dir => {
  const cwd = project(dir, "repo");
  const agentApi = fakeAgentApi(dir);
  const tower = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  const presetKey = "advisor_argon_long_discovery_role";
  const conversationId = "host-dispatch-root";
  try {
    tower.engineManager.setHostContext(hostContext(agentApi.exe));
    assert.equal(tower.engineManager.getHostContext().hostBridgeAvailable, true);
    tower.engineManager.runTurn = () => ({ result: Promise.resolve({ status: "completed", assistantText: "external ok" }) });
    tower.db.saveSettings({
      presets: {
        [presetKey]: { ...swarmAdvisor, isolation: "worktree" },
        reviewer_agy: { ...swarmAdvisor, group: "reviewer", model: "inherit" },
      },
      modeProfiles: { complex: { advisor: { enabledKeys: [presetKey] }, reviewer: { enabledKeys: ["reviewer_agy"] } } },
    });
    await tower.setConversationPolicy({ conversationId, workspace: cwd, orchestrationMode: "complex" });
    const before = git(cwd, "--no-optional-locks", "worktree", "list", "--porcelain");
    const task = "核查边界";
    const delegated = await tower.delegateTask({ conversationId, cwd, presetKey, task });
    assert.equal(delegated.status, "waiting_host_dispatch");
    assert.equal(delegated.code, "HOST_DISPATCH_REQUIRED");
    assert.match(delegated.handoffId, /^hnd_/);
    assert.deepEqual(delegated.hostAction.args, { action: "add", name: swarmMemberName(presetKey), model: `${agyModel}-high`,
      workspace: "share", brief: `${task}\n\n完成独立盲评后向 @coordinator 发 \`@coordinator [done]\`，随后调用 swarm_wait；不要先读他人黑板。` });
    const review = await tower.runCodeReview({ conversationId, cwd, presetKey: "reviewer_agy", readOnly: true });
    assert.equal(review.nativeKind, "subagent");
    assert.equal(review.hostAction.tool, "invoke_subagent");
    assert.equal(review.hostAction.args.Model, "inherit");
    assert.equal(review.hostAction.args.Workspace, "inherit");
    const batch = await tower.delegateParallelBatch({ conversationId, cwd, tasks: [
      { presetKey: "executor_codex", task: "first" }, { presetKey, task },
    ] });
    assert.equal(batch.tasks[0].provider, "codex");
    assert.equal(batch.tasks[1].status, "waiting_host_dispatch");
    assert.equal(batch.hostActions.length, 1);
    const launched = await tower.launchThread({ conversationId, cwd, presetKey, message: task });
    assert.equal(launched.status, "waiting_host_dispatch");
    const threads = tower.db.listThreads({ includeSubagents: true });
    assert.equal(threads.length, 1);
    assert.equal(threads[0].provider, "codex");
    assert.equal(git(cwd, "--no-optional-locks", "worktree", "list", "--porcelain"), before);
    assert.deepEqual(agentApi.calls(), []);
  } finally { await tower.shutdown(); }
}));

test("native driver rejects an unbound session and standalone AGY uses the managed ACP protocol", () => withProjectSandbox("v022-acp", async dir => {
  const agentApi = fakeAgentApi(dir);
  const hostEnv = {
    ANTIGRAVITY_AGENTAPI_EXE: agentApi.exe,
    ANTIGRAVITY_LS_ADDRESS: "fixture-address",
    ANTIGRAVITY_CSRF_TOKEN: "fixture-token",
  };
  assert.throws(() => runAgyNativeTurn({ hostEnv }), { code: "HOST_TOPLEVEL_FORBIDDEN" });
  await assert.rejects(execHostAgentApi(["new-conversation", "test"], { hostEnv }), { code: "HOST_TOPLEVEL_FORBIDDEN" });
  assert.deepEqual(agentApi.calls(), []);
  const script = path.join(dir, "acp.mjs");
  fs.writeFileSync(script, `
    import readline from "node:readline";
    if (process.argv[2] !== "acp" || process.env.AGENT_TOWER_MANAGED_AGY_ACP !== "1") process.exit(1);
    for await (const line of readline.createInterface({ input: process.stdin })) {
      const { id, method } = JSON.parse(line);
      const results = {
        initialize: { protocolVersion: 1 },
        "session/new": { sessionId: "fake-acp-session", configOptions: [{ id: "model", currentValue: "gemini-4-hydrogen" }] },
        "session/resume": { sessionId: "fake-acp-session", configOptions: [{ id: "model", currentValue: "gemini-4-hydrogen" }] },
        "session/load": { sessionId: "fake-acp-session", configOptions: [{ id: "model", currentValue: "gemini-4-hydrogen" }] },
        "session/prompt": { stopReason: "end_turn" },
      };
      if (id != null) console.log(JSON.stringify({ jsonrpc: "2.0", id, result: results[method] || {} }));
    }
  `);
  const manager = createEngineManager({ hostEnv: { ANTIGRAVITY_LS_ADDRESS: "", ANTIGRAVITY_CSRF_TOKEN: "", GEMINI_API_KEY: "fixture-paid-key" } });
  assert.equal(manager.getHostContext().hostBridgeAvailable, false);
  const events = [];
  const result = await manager.runTurn({
    cwd: dir, provider: "antigravity", model: "inherit", effort: "inherit", prompt: "ACP", antigravityAcpMode: "api_key",
    resolveBinary: () => ({ ...binary, prefixArgs: [script] }), onEvent: event => events.push(event),
  }).result;
  assert.equal(result.status, "completed", result.error);
  assert.equal(result.nativeSessionId, "fake-acp-session");
  assert.equal(events.find(event => event.type === "session_bound")?.nativeSessionId, "fake-acp-session");
  const cwd = project(dir, "repo");
  const tower = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  try {
    tower.engineManager.setHostContext({ hostEnv: { GEMINI_API_KEY: "fixture-paid-key" } });
    const runTurn = tower.engineManager.runTurn.bind(tower.engineManager);
    tower.engineManager.runTurn = opts => {
      assert.equal(opts.forceAcp, true);
      assert.equal(opts.isNativeHost, false);
      return runTurn({ ...opts, resolveBinary: () => ({ ...binary, prefixArgs: [script] }) });
    };
    const specs = path.join(cwd, ".agent-tower", "spec", "02-coding");
    fs.mkdirSync(specs, { recursive: true });
    fs.writeFileSync(path.join(specs, "test.md"), "# ACP delivery\n\nKeep the spec on this managed session.\n");
    tower.db.saveSettings({ defaultOrchestrationMode: "relay", antigravityAcpMode: "api_key", presets: { executor_hydrogen: { model: "inherit" } } });
    const delegated = await tower.delegateTask({ cwd, conversationId: "v022-acp", presetKey: "executor_hydrogen", task: "Managed ACP", mode: "wait", persistSession: true });
    assert.equal(delegated.status, "completed", delegated.error);
    assert.equal(tower.db.getRun(delegated.runId).meta.injectedSpecs.ledgerState, "acknowledged");
    tower.engineManager.setHostContext(hostContext(agentApi.exe));
    const continued = await tower.sendToThread({ threadId: delegated.threadId, message: "now inside the host", wait: true });
    assert.equal(continued.status, "completed", JSON.stringify(continued));
  } finally { await tower.shutdown(); }
  assert.deepEqual(agentApi.calls(), []);
}));

test("native swarm sync claims exact, alias and truncated member keys and inherits the conversation project", () => withProjectSandbox("v022-host-claim", async dir => {
  const appDataDir = path.join(dir, "host");
  const cwd = project(dir, "repo");
  const conversationId = "12345678-0000-4000-8000-123456789abc";
  const advisor = "23456789-0000-4000-8000-123456789abc";
  const executor = "34567890-0000-4000-8000-123456789abc";
  const anonymous = "45678901-0000-4000-8000-123456789abc";
  const alias = "56789012-0000-4000-8000-123456789abc";
  const longKey = "executor_long_custom_swarm_role";
  const swarmDir = path.join(appDataDir, "brain", conversationId, ".system_generated", "swarm");
  fs.mkdirSync(swarmDir, { recursive: true });
  fs.writeFileSync(path.join(swarmDir, "members.json"), JSON.stringify({ title: "Native roster", members: {
    coordinator: { role: "coordinator", conversation_id: conversationId },
    advisor_argon: { role: "worker", conversation_id: advisor, applied_model: `${agyModel}-high` },
    [longKey.slice(0, 24).replaceAll("_", "-")]: { role: "worker", conversation_id: executor },
    executor_codex: { role: "worker", conversation_id: anonymous },
    "advisor-alt": { role: "worker", conversation_id: alias },
  } }));
  const tower = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  try {
    tower.db.saveSettings({ presets: {
      advisor_argon: swarmAdvisor,
      advisor_alt: { ...swarmAdvisor, effort: "medium" },
      [longKey]: { ...swarmAdvisor, group: "executor", model: "gemini-4-hydrogen" },
    } });
    await tower.setConversationPolicy({ conversationId, workspace: cwd, orchestrationMode: "complex" });
    const sibling = project(dir, "sibling");
    const snapshot = await tower.getBootstrap({ conversationId, appDataDir, workspace: sibling });
    for (const id of [conversationId, advisor, executor, anonymous, alias]) {
      const thread = tower.db.getThread(`thr_native_${id}`);
      assert.equal(snapshot.threads.find(t => t.id === thread?.id)?.workspace, normalPath(cwd));
      assert.equal(thread.meta.projectRoot, normalPath(cwd));
      assert.equal(thread.meta.rootConversationId, conversationId);
    }
    const thread = tower.db.getThread(`thr_native_${advisor}`);
    assert.deepEqual([thread.presetKey, thread.role, thread.title, thread.model, thread.effort],
      ["advisor_argon", "advisor", swarmAdvisor.label, `${agyModel}-high`, "high"]);
    assert.equal(tower.db.getThread(`thr_native_${alias}`).presetKey, "advisor_alt");
    const long = tower.db.getThread(`thr_native_${executor}`);
    assert.deepEqual([long.presetKey, long.model], [longKey, "gemini-4-hydrogen"]);
    for (const id of [conversationId, anonymous]) assert.equal(tower.db.getThread(`thr_native_${id}`).presetKey, "");
    tower.db.saveSettings({ deletePresets: ["advisor_argon"] });
    await tower.getBootstrap({ conversationId, appDataDir, workspace: dir });
    assert.equal(tower.db.getThread(`thr_native_${advisor}`).presetKey, "");
    assert.equal(tower.db.getThread(`thr_native_${advisor}`).meta.workspace, normalPath(cwd));
  } finally { await tower.shutdown(); }
}));

test("legacy sparse settings are materialized once with edits, tombstones and profiles preserved", () => withProjectSandbox("v022-materialize", dir => {
  const cwd = project(dir, "repo");
  const control = path.join(dir, "control");
  fs.mkdirSync(control);
  const file = path.join(control, "global-settings.json");
  const modeProfiles = {
    relay: { executor: { enabledKeys: ["executor_codex"], preferredKey: "executor_codex" } },
    complex: {
      curator: { enabledKeys: ["curator_codex"], preferredKey: "curator_codex" },
      advisor: { stageEnabled: false, enabledKeys: ["advisor_kimi", "custom_alpha"] },
      executor: { enabledKeys: ["executor_kimi"], preferredKey: "executor_kimi" },
      reviewer: { stageEnabled: true, enabledKeys: ["reviewer"], preferredKey: "reviewer" },
    },
  };
  const legacy = {
    presets: { executor_codex: { label: "Edited", effort: "medium" }, custom_alpha: swarmAdvisor },
    deletedPresets: ["custom_removed", "advisor_codex"], modeProfiles, presetRevision: 7,
  };
  fs.writeFileSync(file, JSON.stringify(legacy));
  for (const store of [globalSettings(control, cwd), globalSettings(path.join(dir, "inline"), cwd, undefined, { ...legacy, rolePresets: legacy.presets, presets: undefined })]) {
    const migrated = store.read();
    assert.equal(migrated.rosterVersion, 2);
    assert.equal(migrated.rosterSeeded, true);
    assert.deepEqual(migrated.modeProfiles, modeProfiles);
    assert.equal(migrated.presetRevision, 7);
    assert.deepEqual(migrated.deletedPresets, legacy.deletedPresets);
    assert.deepEqual([migrated.presets.executor_codex.label, migrated.presets.executor_codex.effort, migrated.presets.executor_codex.model],
      ["Edited", "medium", DEFAULT_ROLE_PRESETS.executor_codex.model]);
    assert.equal(migrated.presets.custom_alpha.model, agyModel);
    assert.equal(migrated.presets.advisor_codex, undefined);
    assert.ok(Object.values(migrated.presets).every(preset => preset.builtin === false && !Object.hasOwn(preset, "enabled")));
    store.save({});
  }
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).rosterVersion, 2);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).presets.executor_codex.provider, "codex");
}));

test("deleting every preset survives reopening and deleted threads keep their route snapshot", () => withProjectSandbox("v022-empty-roster", async dir => {
  const cwd = project(dir, "repo");
  const dataDir = path.join(dir, "control");
  const make = () => createOrchestrator({ dataDir, defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  const conversationId = "v022-deleted-continuation";
  const tower = make();
  let threadId;
  try {
    await tower.setConversationPolicy({ conversationId, workspace: cwd, orchestrationMode: "relay" });
    tower.engineManager.runTurn = opts => ({ result: Promise.resolve({ status: "completed", model: opts.model }) });
    ({ threadId } = await tower.delegateTask({ conversationId, cwd, presetKey: "executor_codex", task: "First turn", mode: "wait" }));
    const deletePresets = Object.keys(tower.db.getSettings().presets);
    for (const key of ["executor_codex", "advisor_kimi", "reviewer"]) assert.ok(deletePresets.includes(key));
    await tower.saveSettings({ deletePresets, modeProfiles: { relay: { executor: { enabledKeys: [] } }, complex: { executor: { enabledKeys: [] } } } });
  } finally { await tower.shutdown(); }
  assert.deepEqual(globalSettings(dataDir, cwd).read().presets, {});
  const reopened = make();
  try {
    assert.deepEqual((await reopened.getCapabilities()).presets, {});
    assert.deepEqual((await reopened.getBootstrap()).modeProfiles.relay.executor.enabledKeys, []);
    const driverCalls = [];
    reopened.engineManager.runTurn = opts => {
      driverCalls.push(opts);
      return { result: Promise.resolve({ status: "completed" }) };
    };
    const reply = await reopened.sendToThread({ threadId, message: "Continue after deletion", wait: true });
    assert.equal(reply.status, "completed");
    assert.deepEqual(driverCalls.map(({ provider, model }) => [provider, model]), [["codex", DEFAULT_ROLE_PRESETS.executor_codex.model]]);
    assert.throws(() => resolveRoleTarget({ role: "executor", presets: {} }), { code: "MEMBER_SELECTION_REQUIRED" });
  } finally { await reopened.shutdown(); }
}));

test("probe-based seeds include only available core binaries, bridged AGY and installed extensions", () => {
  assert.equal(buildAgyPinnedModelId("gemini-4-hydrogen-low", "high"), "gemini-4-hydrogen-low");
  assert.equal(swarmMemberName("advisor_long_shared_prefix_first").length, 24);
  assert.notEqual(swarmMemberName("advisor_long_shared_prefix_first"), swarmMemberName("advisor_long_shared_prefix_second"));
  const onlyCodex = buildInitialRosterFromProbe({ binaries: { codex: binary, "kimi-code": { command: "kimi" }, "claude-code": { ...binary, available: false } } });
  assert.deepEqual(Object.keys(onlyCodex.presets), ["advisor_codex", "executor_codex", "reviewer_codex", "curator_codex"]);
  assert.deepEqual(onlyCodex.modeProfiles.relay.executor.enabledKeys, ["executor_codex"]);
  const many = buildInitialRosterFromProbe({
    binaries: { codex: binary, "claude-code": binary }, hostBridgeAvailable: true,
    customProviders: [{ id: "opencode", command: "opencode", enabled: true }, { id: "disabled", command: "disabled", enabled: false }],
    catalog: { providers: [{ id: "opencode", isExtension: true, installed: true, models: [{ slug: "custom/model" }] }] },
  });
  assert.equal(Object.keys(many.presets).length, 15);
  assert.equal(many.presets.executor_agy.provider, "antigravity");
  assert.equal(many.presets.executor_opencode.model, "custom/model");
  assert.deepEqual(new Set(many.modeProfiles.complex.reviewer.enabledKeys), new Set(["reviewer_codex", "reviewer_claude", "reviewer_agy", "reviewer_opencode"]));
  assert.equal(buildInitialRosterFromProbe({ binaries: { agy: binary } }).presets.executor_agy.provider, "antigravity");
  const none = buildInitialRosterFromProbe();
  assert.deepEqual(none.presets, {});
  assert.deepEqual(none.modeProfiles.relay.executor, { enabledKeys: [], preferredKey: null });
  assert.equal(none.modeProfiles.complex.reviewer.stageEnabled, false);
});

test("capabilities and bootstrap seed a fresh roster once, including an empty probe result", () => withProjectSandbox("v022-probe-once", async dir => {
  const cwd = project(dir, "repo");
  const dataDir = path.join(dir, "control");
  const tower = createOrchestrator({ dataDir, defaultStudioRoot: cwd, catalogLoader: async () => ({ providers: [] }) });
  try {
    assert.equal(tower.db.getSettings().rosterSeeded, false);
    assert.ok(tower.db.getSettings().presets.executor_codex);
    tower.engineManager.probeBinaries = async () => ({});
    const [capabilities, bootstrap] = await Promise.all([tower.getCapabilities(), tower.getBootstrap()]);
    assert.deepEqual(capabilities.presets, {});
    assert.deepEqual(bootstrap.presets, {});
    const seeded = tower.db.getSettings();
    assert.equal(seeded.rosterSeeded, true);
    assert.equal(seeded.defaultOrchestrationMode, "direct");
    tower.engineManager.probeBinaries = async () => ({ codex: binary });
    assert.deepEqual((await tower.getCapabilities()).presets, {});
    assert.equal(tower.db.getSettings().presetRevision, seeded.presetRevision);
  } finally { await tower.shutdown(); }
  assert.deepEqual(globalSettings(dataDir, cwd).read().presets, {});
}));


test("probe completion preserves a roster edited through another settings connection", () => withProjectSandbox("v022-seed-race", async dir => {
  const cwd = project(dir, "repo");
  const dataDir = path.join(dir, "control");
  const tower = createOrchestrator({ dataDir, defaultStudioRoot: cwd, catalogLoader: async () => ({ providers: [] }) });
  try {
    let finish;
    tower.engineManager.probeBinaries = () => new Promise(resolve => { finish = resolve; });
    const loading = tower.getCapabilities();
    const stored = globalSettings(dataDir, cwd).save({ presets: { advisor_argon: swarmAdvisor }, deletePresets: ["executor_codex"] });
    finish({ codex: binary });
    const result = await loading;
    assert.deepEqual(result.presets, stored.presets);
    assert.deepEqual(result.modeProfiles, stored.modeProfiles);
    assert.equal(result.settings.presetRevision, stored.presetRevision);
  } finally { await tower.shutdown(); }
}));

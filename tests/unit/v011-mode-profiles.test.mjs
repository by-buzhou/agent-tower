import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withProjectSandbox } from "../helpers/sandbox.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { globalSettings } from "../../core/global-settings.mjs";
import { openOrchestratorDb } from "../../core/db.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import {
  DEFAULT_MODE_PROFILES,
  DEFAULT_ROLE_PRESETS,
  ORCHESTRATION_MODES,
  mergeActivePresets,
  normalizeModeProfiles,
  normalizeOrchestrationMode,
  buildModePlaybook,
} from "../../core/catalog.mjs";

function engineFixture(o, calls) {
  o.engineManager.runTurn = options => {
    calls.push(options);
    return {
      result: Promise.resolve({ status: "completed", assistantText: "fixture result", nativeSessionId: "fixture-session" }),
      async cancel() {},
      async forceKill() {},
      async steer() { return { supported: false }; },
      async respondPermission() {},
      async respondQuestion() {},
    };
  };
}

async function openSandbox(dir, name, mode = "complex") {
  const cwd = project(dir, name);
  const o = createOrchestrator({
    dataDir: path.join(dir, `${name}-control`),
    defaultStudioRoot: cwd,
    catalogLoader: offlineCatalog,
  });
  await o.saveSettings({ defaultOrchestrationMode: mode });
  return { o, cwd };
}

test("v0.1.1 三档模式与 SQLite 存量名称无损迁移", () => withProjectSandbox("v011-mode-migration", dir => {
  assert.deepEqual(ORCHESTRATION_MODES, ["direct", "relay", "complex"]);
  assert.equal(normalizeOrchestrationMode("simple"), "relay");
  assert.equal(normalizeOrchestrationMode("custom:review_first"), "complex");
  const legacySettings = globalSettings(path.join(dir, "settings-control"), project(dir, "settings-repo"), undefined, { defaultDispatchEnabled: true });
  assert.equal(legacySettings.read().defaultOrchestrationMode, "relay");

  const dbFile = path.join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(dbFile);
  legacy.exec("CREATE TABLE conversation_policies (conversation_id TEXT PRIMARY KEY, orchestration_mode TEXT NOT NULL, dispatch_enabled INTEGER NOT NULL, policy_revision INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'legacy', updated_at INTEGER NOT NULL); INSERT INTO conversation_policies VALUES ('simple', 'simple', 1, 1, 'legacy', 1); INSERT INTO conversation_policies VALUES ('custom', 'custom:alpha', 1, 1, 'legacy', 1);");
  legacy.close();
  const db = openOrchestratorDb(dbFile);
  try {
    assert.equal(db.getConversationPolicyRecord("simple").orchestrationMode, "relay");
    assert.equal(db.getConversationPolicyRecord("custom").orchestrationMode, "complex");
  } finally {
    db.close();
  }
}));

test("modeProfiles 默认迁移、分支增量合并、删除清理与执行组硬门禁", () => withProjectSandbox("v011-mode-profiles-settings", dir => {
  const settings = globalSettings(path.join(dir, "control"), project(dir, "repo"));
  const defaults = settings.read().modeProfiles;
  assert.deepEqual(defaults.relay.executor, DEFAULT_MODE_PROFILES.relay.executor);
  assert.deepEqual(defaults.complex.curator, { enabledKeys: ["curator_codex"], preferredKey: "curator_codex" });
  const changed = settings.save({ modeProfiles: { relay: { executor: { enabledKeys: ["executor_codex"], preferredKey: "executor_codex" } } } });
  assert.deepEqual(changed.modeProfiles.relay.executor.enabledKeys, ["executor_codex"]);
  assert.equal(changed.modeProfiles.complex.executor.preferredKey, "executor_claude");
  assert.throws(() => settings.save({ modeProfiles: { relay: { executor: { enabledKeys: [] } } } }), { code: "EXECUTOR_ROSTER_EMPTY" });

  const customKey = "custom_alpha";
  const withCustom = settings.save({ presets: { [customKey]: { group: "executor", provider: "codex", model: "gpt-6.2-sol", permissionMode: "full-access" } }, modeProfiles: { relay: { executor: { enabledKeys: ["executor_codex", customKey], preferredKey: customKey } } } });
  assert.ok(withCustom.modeProfiles.relay.executor.enabledKeys.includes(customKey));
  const afterDelete = settings.save({ deletePresets: [customKey] });
  assert.equal(afterDelete.modeProfiles.relay.executor.enabledKeys.includes(customKey), false);
  assert.equal(afterDelete.modeProfiles.relay.executor.preferredKey, "executor_codex");

  const active = mergeActivePresets({ executor_codex: { enabled: false } });
  const preserved = normalizeModeProfiles({ complex: { executor: { enabledKeys: ["executor_codex"], preferredKey: "executor_codex" } } }, active);
  assert.deepEqual(preserved.complex.executor.enabledKeys, ["executor_codex"]);
}));

test("activeMode 返回三档统一结构并保留关闭阶段的勾选", () => withProjectSandbox("v011-active-mode", async dir => {
  const { o, cwd } = await openSandbox(dir, "repo", "complex");
  try {
    await o.saveSettings({ modeProfiles: { complex: { advisor: { stageEnabled: false, enabledKeys: ["advisor_kimi"] }, reviewer: { stageEnabled: false, enabledKeys: ["reviewer"], preferredKey: "reviewer" } } } });
    const active = o.getConversationPolicy({ conversationId: "active-mode" }).activeMode;
    assert.equal(active.orchestrationMode, "complex");
    assert.deepEqual(active.stages, { advisor: false, executor: true, reviewer: false });
    assert.deepEqual(Object.keys(active.groups).sort(), ["advisor", "executor", "reviewer"]);
    assert.deepEqual(active.groups.advisor.enabledKeys, []);
    assert.deepEqual(active.groups.reviewer.enabledKeys, []);
    assert.deepEqual(active.modeProfiles.complex.advisor.enabledKeys, ["advisor_kimi"]);
    assert.deepEqual(active.modeProfiles.complex.reviewer.enabledKeys, ["reviewer"]);
    assert.equal(active.queueFrozen, false);
    const bootstrap = await o.getBootstrap({ conversationId: "active-mode", workspace: cwd });
    assert.deepEqual(bootstrap.modeProfiles, active.modeProfiles);
    await o.saveSettings({ defaultOrchestrationMode: "relay" });
    const relay = o.getConversationPolicy({ conversationId: "active-mode" }).activeMode;
    assert.deepEqual(relay.stages, { advisor: false, executor: true, reviewer: false });
    assert.equal(relay.groups.executor.preferredKey, relay.modeProfiles.relay.executor.preferredKey);
  } finally {
    await o.shutdown();
  }
}));

test("relay 严锁勾选池、默认写权限、显式只读、并发派发与评审禁用", () => withProjectSandbox("v011-relay-gates", async dir => {
  const { o, cwd } = await openSandbox(dir, "repo", "relay");
  const calls = [];
  engineFixture(o, calls);
  try {
    await o.saveSettings({ modeProfiles: { relay: { executor: { enabledKeys: ["executor_codex", "executor_claude"], preferredKey: "executor_codex" } } } });
    await assert.rejects(o.delegateTask({ conversationId: "relay-gates", cwd, presetKey: "executor_kimi", task: "blocked" }), { code: "PRESET_NOT_IN_MODE" });
    const named = await o.delegateTask({ conversationId: "relay-gates", cwd, presetKey: "executor_kimi", allowDisabledPreset: true, task: "explicit exception", mode: "wait" });
    assert.equal(o.db.getRun(named.runId).meta.temporaryOverride, true);
    assert.ok(!o.db.getSettings().modeProfiles.relay.executor.enabledKeys.includes("executor_kimi"));
    await assert.rejects(o.sendToThread({ threadId: named.threadId, message: "implicit", allowDisabledPreset: true }), { code: "PRESET_NOT_IN_MODE" });
    await assert.rejects(o.delegateTask({ conversationId: "relay-gates", cwd, provider: "kimi-code", model: "kimi-code/k3.1-pro", task: "blocked" }), { code: "PRESET_NOT_IN_MODE" });

    const write = await o.delegateTask({ conversationId: "relay-gates", cwd, task: "fix the issue", mode: "wait" });
    assert.notEqual(o.db.getRun(write.runId).permissionMode, "read-only");
    const read = await o.delegateTask({ conversationId: "relay-gates", cwd, task: "inspect the issue", executionIntent: "read", mode: "wait" });
    assert.equal(o.db.getRun(read.runId).permissionMode, "read-only");

    const batch = await o.delegateParallelBatch({ conversationId: "relay-gates", cwd, tasks: [
      { presetKey: "executor_codex", task: "first", executionIntent: "write" },
      { presetKey: "executor_claude", task: "second", executionIntent: "write" },
    ], mode: "wait_all" });
    assert.equal(batch.tasks.length, 2);
    assert.equal(calls.length, 5);
    await assert.rejects(o.runCodeReview({ conversationId: "relay-gates", cwd }), { code: "MODE_REVIEW_NOT_ALLOWED" });
  } finally {
    await o.shutdown();
  }
}));

test("complex 阶段开关与审核关闭软跳过", () => withProjectSandbox("v011-complex-stages", async dir => {
  const { o, cwd } = await openSandbox(dir, "repo", "complex");
  try {
    await o.saveSettings({ modeProfiles: { complex: {
      advisor: { stageEnabled: false, enabledKeys: ["advisor_kimi"] },
      executor: { enabledKeys: ["executor_codex"], preferredKey: "executor_codex" },
      reviewer: { stageEnabled: false, enabledKeys: ["reviewer"], preferredKey: "reviewer" },
    } } });
    await assert.rejects(o.delegateTask({ conversationId: "complex-stages", cwd, role: "advisor", task: "ask" }), { code: "STAGE_DISABLED" });
    const skipped = await o.runCodeReview({ conversationId: "complex-stages", cwd });
    assert.equal(skipped.ok, true);
    assert.equal(skipped.code, "review_stage_disabled");
    assert.equal(skipped.status, "bypassed_by_stage");
    assert.equal(skipped.hostSelfReviewRequired, true);
    await assert.rejects(o.saveSettings({ modeProfiles: { complex: { executor: { enabledKeys: [] } } } }), { code: "EXECUTOR_ROSTER_EMPTY" });
  } finally {
    await o.shutdown();
  }
}));

test("PreInvocation Playbook 包含动态阵容与自然融合白话汇报准则", () => {
  const presets = { ...DEFAULT_ROLE_PRESETS };
  const text = buildModePlaybook({ orchestrationMode: "relay", presets, modeProfiles: {
    relay: { executor: { enabledKeys: ["executor_codex", "executor_claude"], preferredKey: "executor_claude" } },
  }, presetRevision: 23 });
  assert.match(text, /mode="relay" rev="23"/);
  assert.match(text, /⚡ 简单模式/);
  assert.match(text, /★/);
  assert.match(text, /单派或并发派发/);
  assert.match(text, /自然融合白话汇报/);
  assert.ok(!text.includes("再附一段「白话解读」"));
  const complex = buildModePlaybook({ orchestrationMode: "complex", presets, modeProfiles: {
    complex: {
      advisor: { stageEnabled: false, enabledKeys: ["advisor_kimi"] },
      executor: { enabledKeys: ["executor_codex"], preferredKey: "executor_codex" },
      reviewer: { stageEnabled: false, enabledKeys: ["reviewer"], preferredKey: "reviewer" },
    },
  } });
  assert.match(complex, /军师阶段已关闭/);
  assert.match(complex, /独立审核阶段已关闭/);
  assert.match(complex, /自然融合白话汇报/);
  assert.ok(!complex.includes("再附一段「白话解读」"));
});

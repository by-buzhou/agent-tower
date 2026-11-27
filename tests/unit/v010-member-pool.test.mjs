import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { withProjectSandbox } from "../helpers/sandbox.mjs";
import { project } from "../helpers/fixtures.mjs";
import { globalSettings } from "../../core/global-settings.mjs";
import { openOrchestratorDb } from "../../core/db.mjs";
import {
  ORCHESTRATION_MODES,
  DEFAULT_MEMBER_POOL,
  validateCustomPresetKey,
  validatePresetKey,
  normalizeOrchestrationMode,
  mergeActivePresets,
  normalizeMemberPool,
  buildModePlaybook,
  assertPresetTarget,
  resolveRoleTarget,
} from "../../core/catalog.mjs";
import { buildEffectivePrompt, RELAY_READ_INTENT_TAG } from "../../core/orchestrator/helpers.mjs";

test("v0.1.0 默认模式与旧布尔配置迁移", () => withProjectSandbox("v010-settings-default", dir => {
  const fresh = globalSettings(path.join(dir, "fresh-control"), project(dir, "fresh"));
  assert.equal(fresh.read().defaultOrchestrationMode, "direct");
  assert.equal(fresh.read().defaultDispatchEnabled, false);
  const legacy = globalSettings(path.join(dir, "legacy-control"), project(dir, "legacy"), undefined, { defaultDispatchEnabled: true });
  assert.equal(legacy.read().defaultOrchestrationMode, "relay");
  assert.equal(legacy.read().defaultDispatchEnabled, true);
  assert.deepEqual(Object.keys(DEFAULT_MEMBER_POOL), ["advisor", "executor", "reviewer"]);
  assert.deepEqual(ORCHESTRATION_MODES, ["direct", "relay", "complex"]);
}));

test("成员键平权、显式重建、CAS 与原内置成员可删除", () => withProjectSandbox("v010-member-pool", dir => {
  const settings = globalSettings(path.join(dir, "control"), project(dir, "repo"));
  const key = "custom_alpha";
  assert.equal(validateCustomPresetKey(key), key);
  assert.equal(validateCustomPresetKey, validatePresetKey);
  for (const valid of ["bad", "advisor_argon", "executor_opencode", "reviewer", "advisor-argon"]) assert.equal(validatePresetKey(valid), valid);
  for (const invalid of ["ABc", "xy", "commander", "coordinator", "all", "__new_member__", "a?b"])
    assert.throws(() => validatePresetKey(invalid), { code: "INVALID_PRESET_KEY" });
  assert.throws(() => validatePresetKey(key, { existingKeys: [key] }), { code: "INVALID_PRESET_KEY" });
  let current = settings.save({ presets: { [key]: { label: "Alpha", title: "Alpha executor", group: "executor", provider: "codex", model: "gpt-6.2-sol", effort: "high", permissionMode: "full-access", interactionMode: "default", isolation: "shared", description: "custom" } }, memberPool: { executor: { strategy: "host_select_enabled" } } });
  assert.equal(current.presets[key].builtin, false);
  assert.equal(current.memberPool.executor.strategy, "host_select_enabled");
  const revision = current.presetRevision;
  assert.throws(() => settings.save({ expectedPresetRevision: revision - 1, presets: { [key]: { label: "stale" } } }), { code: "PRESET_REVISION_CONFLICT" });
  current = settings.save({ expectedPresetRevision: revision, deletePresets: [key] });
  assert.ok(current.deletedPresets.includes(key));
  assert.equal(current.presets[key], undefined);
  assert.throws(() => assertPresetTarget(key, current.presets, current.deletedPresets), { code: "PRESET_DELETED" });
  current = settings.save({ presets: { [key]: { label: "reborn", group: "executor", provider: "codex", model: "gpt-6.2-sol" } } });
  assert.ok(!current.deletedPresets.includes(key));
  assert.equal(current.presets[key].label, "reborn");
  current = settings.save({ deletePresets: ["executor_codex", "advisor_kimi", "reviewer"] });
  for (const removed of ["executor_codex", "advisor_kimi", "reviewer"]) {
    assert.ok(!Object.hasOwn(current.presets, removed));
    assert.ok(current.deletedPresets.includes(removed));
  }
  assert.equal(current.presets.executor_claude.builtin, false);
  assert.throws(() => settings.save({ modeProfiles: { relay: { executor: { enabledKeys: [] } } } }), { code: "EXECUTOR_ROSTER_EMPTY" });
}));

test("成员池归一化、三档手册与自定义模式归一化", () => {
  const active = mergeActivePresets({ custom_alpha: { group: "advisor", provider: "codex", model: "gpt-6.2-astra" } });
  const pool = normalizeMemberPool({ advisor: { strategy: "host_select_1_2", defaultPresetKey: "custom_alpha" }, executor: { strategy: "bad", defaultPresetKey: "missing" } }, active);
  assert.equal(pool.advisor.strategy, "host_select_1_2");
  assert.equal(pool.advisor.defaultPresetKey, "custom_alpha");
  assert.equal(pool.executor.strategy, "locked_default");
  for (const mode of ["direct", "relay", "complex"]) {
    const text = buildModePlaybook({ orchestrationMode: mode, presetRevision: 4, memberPool: pool, presets: active });
    assert.match(text, new RegExp(`mode="${mode}" rev="4"`));
    if (mode !== "direct") assert.match(text, /swarm:executor_hydrogen\/gemini-4-hydrogen-high/);
    assert.match(text, /<agent_tower_mode mode="[^"]+"[\s\S]*<\/agent_tower_mode>/);
    assert.ok(text.split("\n").length >= 6 && text.split("\n").length <= 8);
  }
  assert.match(buildModePlaybook({ orchestrationMode: "custom:alpha", customPipelines: { alpha: { identity: "I", dispatch: "D", review: "R", output: "O" } } }), /复杂自定义模式/);
  assert.equal(normalizeOrchestrationMode("simple"), "relay");
  assert.equal(normalizeOrchestrationMode("custom:alpha", "direct", { alpha: {} }), "complex");
  assert.equal(normalizeOrchestrationMode("custom:missing", "direct", {}), "complex");
});

test("未知与删除预设、relay 显式只读收敛和只读提示词", () => {
  const custom = { custom_alpha: { group: "executor", provider: "claude-code", model: "claude-opus-5-5", permissionMode: "bypassPermissions" } };
  assert.throws(() => assertPresetTarget("missing", custom), { code: "UNKNOWN_PRESET" });
  assert.throws(() => assertPresetTarget("custom_alpha", custom, ["custom_alpha"]), { code: "PRESET_DELETED" });
  const target = resolveRoleTarget({ presetKey: "custom_alpha", presets: custom, orchestrationMode: "relay", executionIntent: "read" });
  assert.equal(target.permissionMode, "plan");
  assert.equal(target.interactionMode, "plan");
  assert.equal(target.routing.executionIntent, "read");
  const write = resolveRoleTarget({ presetKey: "custom_alpha", presets: custom, orchestrationMode: "relay", executionIntent: "write" });
  assert.equal(write.permissionMode, "bypassPermissions");
  assert.equal(buildEffectivePrompt({ prompt: "检查问题", role: "advisor", orchestrationMode: "relay" }).includes(RELAY_READ_INTENT_TAG), false);
  assert.match(buildEffectivePrompt({ prompt: "检查问题", role: "advisor", orchestrationMode: "relay", executionIntent: "read" }), new RegExp(RELAY_READ_INTENT_TAG.trim()));
  assert.equal(buildEffectivePrompt({ prompt: "改代码", role: "executor", orchestrationMode: "relay", executionIntent: "write" }).includes(RELAY_READ_INTENT_TAG), false);
});

test("conversation_policies 双列迁移、自愈与 CAS", () => withProjectSandbox("v010-policy-db", dir => {
  const file = path.join(dir, "legacy.sqlite");
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE conversation_policies (conversation_id TEXT PRIMARY KEY, dispatch_enabled INTEGER NOT NULL, policy_revision INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'explicit', updated_at INTEGER NOT NULL); INSERT INTO conversation_policies VALUES ('old',1,2,'legacy',1); INSERT INTO conversation_policies VALUES ('bad',1,3,'legacy',1);");
  legacy.close();
  const db = openOrchestratorDb(file);
  try {
    assert.equal(db.getConversationPolicyRecord("old").orchestrationMode, "relay");
    assert.equal(db.getConversationPolicyRecord("old").dispatchEnabled, true);
    assert.equal(db.setConversationPolicyRecord({ conversationId: "old", orchestrationMode: "relay", expectedPolicyRevision: 2 }).orchestrationMode, "relay");
    assert.throws(() => db.setConversationPolicyRecord({ conversationId: "old", expectedPolicyRevision: 2, dispatchEnabled: false }), { code: "POLICY_REVISION_CONFLICT" });
    assert.throws(() => db.setConversationPolicyRecord({ conversationId: "conflict", orchestrationMode: "direct", dispatchEnabled: true }), { code: "ORCHESTRATION_POLICY_CONFLICT" });
    assert.equal(db.setConversationPolicyRecord({ conversationId: "bool", dispatchEnabled: true }).orchestrationMode, "relay");
  } finally { db.close(); }
}));
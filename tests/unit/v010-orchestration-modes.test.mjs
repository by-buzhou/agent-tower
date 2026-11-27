import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";

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

async function open(dir, name, mode = "complex") {
  const cwd = project(dir, name);
  const o = createOrchestrator({ dataDir: path.join(dir, `${name}-control`), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  await o.saveSettings({ defaultOrchestrationMode: mode });
  return { o, cwd };
}

test("direct 是新会话默认总闸，显式点名也零副作用，并返回 activeMode", () => withProjectSandbox("v010-direct-gate", async dir => {
  const { o, cwd } = await open(dir, "repo", "direct");
  try {
    const result = await o.delegateTask({ conversationId: "direct-conversation", cwd, presetKey: "executor_codex", task: "must be blocked" });
    assert.equal(result.code, "host_direct_only");
    assert.equal(result.sideEffects, false);
    assert.equal(result.activeMode.orchestrationMode, "direct");
    assert.equal(o.db.listThreads().filter(thread => thread.meta?.rootConversationId === "direct-conversation").length, 0);
    assert.equal(o.getConversationPolicy({ conversationId: "direct-conversation" }).dispatchEnabled, false);
  } finally {
    await o.shutdown();
  }
}));

test("relay 默认写权限，显式 read 才只读，续聊 restart 保留 freshContext", () => withProjectSandbox("v010-relay-intent", async dir => {
  const { o, cwd } = await open(dir, "repo", "relay");
  o.db.saveSettings({ defaultExternalSessionVisible: true });
  const calls = [];
  engineFixture(o, calls);
  try {
    const write = await o.delegateTask({ conversationId: "relay-conversation", cwd, task: "fix the diff", mode: "wait" });
    const writeRun = o.db.getRun(write.runId);
    assert.equal(writeRun.meta.executionIntent, undefined);
    assert.notEqual(writeRun.permissionMode, "read-only");
    assert.equal(calls[0].prompt.includes("agent_tower_intent mode=\"relay\" intent=\"read\""), false);

    const read = await o.delegateTask({ conversationId: "relay-conversation", cwd, task: "inspect the diff", executionIntent: "read", mode: "wait" });
    const readRun = o.db.getRun(read.runId);
    assert.equal(readRun.meta.executionIntent, "read");
    assert.equal(readRun.permissionMode, "plan");
    assert.match(calls[1].prompt, /agent_tower_intent mode="relay" intent="read"/);

    const threadId = "restart-thread";
    o.db.upsertThread({ id: threadId, conversationId: "relay-conversation", workspace: cwd, cwd, role: "executor", presetKey: "executor_codex", provider: "codex", model: "gpt-6.2-sol", effort: "high", permissionMode: "full-access", interactionMode: "default", status: "completed", nativeSessionId: "old-session", meta: { rootConversationId: "relay-conversation" } });
    await o.sendToThread({ threadId, conversationId: "relay-conversation", message: "fresh restart", mode: "restart", freshContext: true, executionIntent: "write" });
    assert.equal(calls.at(-1).nativeSessionId, undefined);
    assert.equal(o.db.getThread(threadId).nativeSessionId, "fixture-session");
  } finally {
    await o.shutdown();
  }
}));

test("成员池停用门控与评审池降级自审契约", () => withProjectSandbox("v010-member-gates", async dir => {
  const { o, cwd } = await open(dir, "repo", "complex");
  const calls = [];
  engineFixture(o, calls);
  try {
    await o.saveSettings({
      memberPool: {
        executor: { strategy: "host_select_enabled" },
        reviewer: { strategy: "host_select_enabled" },
      },
      presets: {
        executor_codex: { enabled: false },
        reviewer: { enabled: false },
      },
      modeProfiles: {
        complex: {
          executor: { enabledKeys: ["executor_claude"], preferredKey: "executor_claude" },
          reviewer: { stageEnabled: true, enabledKeys: [], preferredKey: null },
        },
      },
    });
    await assert.rejects(
      o.delegateTask({ conversationId: "pool-conversation", cwd, presetKey: "executor_codex", task: "disabled" }),
      { code: "PRESET_NOT_IN_MODE" },
    );
    await assert.rejects(
      o.delegateTask({ conversationId: "pool-conversation", cwd, provider: "codex", model: "gpt-6.2-sol", allowDisabledPreset: true, task: "unnamed" }),
      { code: "PRESET_NOT_IN_MODE" },
    );
    await assert.rejects(o.runCodeReview({ conversationId: "pool-conversation", cwd, wait: true }), { code: "REVIEW_POOL_EMPTY" });
    const degraded = await o.runCodeReview({ conversationId: "pool-conversation", cwd, degradeToHostSelfReview: true });
    assert.equal(degraded.status, "degraded_self_review");
    assert.equal(degraded.degradedReview, true);
    assert.equal(degraded.activeMode.groups.reviewer.enabledKeys.length, 0);
    assert.equal(calls.length, 0);
  } finally {
    await o.shutdown();
  }
}));

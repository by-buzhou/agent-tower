import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import {
  createEngineManager, probeCliProvider, resolveDshBinary, resolveZCodeBinary, runGenericAcpTurn, runGenericCliTurn,
} from "../../core/engines/index.mjs";
import { mapGenericModeFromPermission } from "../../core/engines/generic-acp.mjs";
import { buildCleanChildEnv, detectCommandOnSystem, flattenAcpOptions, redactSensitiveText, safeEngineError } from "../../core/engines/proc-utils.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";

function fixture(dir, relative = "mock.cjs") {
  const file = path.join(dir, relative);
  const log = path.join(dir, "rpc.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String.raw`
const assert = require("node:assert/strict");
const { appendFileSync } = require("node:fs");
const readline = require("node:readline");
const [engine, scenario] = process.argv.slice(2);
const zcode = engine === "app-server";
const dsh = engine === "--profile";
const behavior = process.env.FIXTURE_SCENARIO || scenario;
const log = process.env.FIXTURE_LOG;
const version = zcode ? {} : { jsonrpc: "2.0" };
const send = frame => console.log(JSON.stringify({ ...version, ...frame }));
const record = frame => appendFileSync(log, JSON.stringify(frame) + "\n");
const sessionId = "fixture-session";
const snapshot = {
  session: { sessionId, model: { providerId: "fixture", modelId: "first" } },
  protocol: { version: 1 },
  settings: {
    model: {
      available: [
        {
          ref: { providerId: "fixture", modelId: "first" },
          label: "first",
          providerLabel: "Fixture Channel A",
          contextWindow: 128000,
          maxOutputTokens: 8192,
          reasoning: { levels: [{ value: "low" }, { value: "high" }], defaultLevel: "high" },
        },
        {
          ref: { providerId: "fixture", modelId: "second" },
          label: "second",
          providerLabel: "Fixture Channel B",
          contextWindow: 200000,
          maxOutputTokens: 16384,
          reasoning: { levels: [{ value: "medium" }, { value: "xhigh" }], defaultLevel: "xhigh" },
        },
      ],
    },
    thoughtLevel: { available: [{ value: "high" }] },
  },
};
const event = (type, payload, sid = sessionId) => send({ method: "session/event", params: { sessionId: sid, type, payload } });
const reverse = (id, method, params) => send({ id, method, params: { sessionId, ...params } });
const configOptions = [{
  id: "model", category: "model", currentValue: '["deepseek","first"]',
  options: [{
    group: "deepseek-group",
    name: "DeepSeek Official",
    options: [
      { value: '["deepseek","first"]', name: "DeepSeek First", contextWindow: 128000, maxOutputTokens: 8192 },
      { value: '["deepseek","second"]', name: "DeepSeek Second" },
    ],
  }],
}];
if (behavior === "metadata-boundaries") {
  const model = snapshot.settings.model.available[0];
  model.providerLabel = "ZAI_API_KEY=fixture-private";
  model.contextWindow = true;
  model.maxOutputTokens = [8192];
  const acpModel = configOptions[0].options[0].options[0];
  acpModel.description = "ZAI_API_KEY=fixture-private";
  acpModel.efforts = ["medium", "xhigh"];
  acpModel.defaultEffort = "xhigh";
}
if (behavior === "dynamic-efforts") {
  configOptions[0].options[0].options.push({ value: '["deepseek","third"]', name: "DeepSeek NoReason" });
  configOptions[0].options[0].options.push({ value: '["deepseek","fourth"]', efforts: [] });
  configOptions.push({
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    currentValue: "high",
    options: ["off", "low", "high", "max"].map(value => ({ value, name: value })),
  });
  snapshot.settings.model.available[1].reasoning = { levels: [{ value: "disabled" }, { value: "enabled" }], defaultLevel: "enabled" };
}
if (behavior === "session-levels" || behavior === "empty-levels") {
  const model = snapshot.settings.model.available[0];
  if (behavior === "session-levels") delete model.reasoning;
  else model.reasoning = { levels: [] };
  snapshot.settings.thoughtLevel.available = ["disabled", "enabled"];
}
const acpSession = { sessionId, ...(dsh ? { configOptions } : behavior === "no-mode" ? {} : {
  modes: { currentModeId: "plan", availableModes: [{ id: "build" }, { id: "plan" }] },
}) };
record({ env: Object.fromEntries([
  "ANTIGRAVITY_CSRF_TOKEN", "ANTIGRAVITY_LS_ADDRESS", "AGENT_TOWER_CHILD_PROCESS", "DEEPSEEK_API_KEY",
  "ZAI_API_KEY", "OTHER_API_KEY", "OTHER_TOKEN", "OTHER_SECRET", "OTHER_PASSWORD", "FIXTURE_ALLOWED",
  "DSH_PERMISSION_MODE", "DSH_TELEMETRY_DISABLED", "ZCODE_BUILTIN_PROVIDER_CONFIG_FILE",
].map(key => [key, process.env[key]])), argv: process.argv.slice(2) });
let promptId;
let promptSessionId;
const zRequests = ["requestProviderRuntimeHeaders", "requestOfficialMcpAuthHeaders", "browserList", "browserExecute", "browserOther"];
readline.createInterface({ input: process.stdin }).on("line", line => {
  const frame = JSON.parse(line);
  record(frame);
  assert.equal(Object.hasOwn(frame, "jsonrpc"), !zcode);
  const { method, params, id } = frame;
  const reply = result => id === undefined || send({ id, result });
  const error = (code, message) => send({ id, error: { code, message } });
  if (!method) {
    if (id === 90 && dsh) replyAcpPrompt();
    if (zcode && id === 104 && behavior !== "cancel") {
      event("turn.completed", { usage: { outputTokens: 2, ...(behavior === "metadata-boundaries" ? { contextLimit: true } : {}) } });
    }
    return;
  }
  switch (method) {
    case "initialize":
      if (behavior === "auth") return error(-32602, "no API key configured");
      return reply({ protocolVersion: 1, agentCapabilities: behavior === "omitted" ? {} :
        { sessionCapabilities: { resume: true } } });
    case "session/new": return reply(acpSession);
    case "session/resume":
      if (behavior === "mismatch") return error(-32602, "session cwd does not match");
      if (behavior === "missing") return error(zcode ? -32004 : -32602, zcode ? "session not found" : "session is not resumable");
      if (behavior === "unimplemented") return error(-32601, "Method not found");
      if (behavior === "transient") return error(503, "server overloaded");
      return reply(zcode ? snapshot : acpSession);
    case "session/set_config_option":
      if (behavior === "switch-timeout" && params.value === '["deepseek","second"]') return;
      if (behavior === "dynamic-efforts") {
        const baseModel = { ...configOptions[0], currentValue: params.value };
        if (params.value === '["deepseek","second"]') {
          return reply({ configOptions: [baseModel, {
            id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", currentValue: "",
            options: ["", "off", "minimal", "low", "medium", "high"].map(value => ({ value, name: value })),
          }] });
        }
        if (params.value === '["deepseek","third"]') return reply({ configOptions: [baseModel] });
        if (params.value === '["deepseek","first"]') return reply({ configOptions });
      }
      if (behavior === "notify-efforts" && params.value === '["deepseek","second"]') {
        const notify = (sid, model, level) => send({ method: "session/update", params: { sessionId: sid, update: {
          sessionUpdate: "config_option_update", configOptions: [{ ...configOptions[0], currentValue: model },
            { id: "thinking", options: [{ value: level }] }],
        } } });
        notify("other-session", params.value, "foreign");
        notify(sessionId, configOptions[0].currentValue, "old");
        reply({});
        return setTimeout(() => notify(sessionId, params.value, "minimal"), 10);
      }
      if (params.value === configOptions[0].currentValue) {
        if (behavior === "restore-rejected") return error(-32602, "model restore refused");
        return reply({ configOptions });
      }
      if (params.value !== '["deepseek","second"]') return error(-32602, "Unknown model");
      return reply({ configOptions: [{ ...configOptions[0], currentValue: params.value }] });
    case "session/set_model":
      if (params.modelId !== "first") return error(-32602, "Unknown model sk-dummy-secret");
      return reply({});
    case "session/set_mode": return dsh ? error(-32601, "Method not found") : reply({});
    case "session/prompt":
      promptId = id;
      promptSessionId = params.sessionId;
      if (dsh) return reverse(90, "session/request_permission", {
        sessionId: promptSessionId,
        toolCall: { title: "Write file", kind: "edit" },
        options: ["allow-once", "reject-always", "reject-once"].map(kind => ({ optionId: kind, kind })),
      });
      return replyAcpPrompt();
    case "session/create": return reply(snapshot);
    case "session/subscribe": return reply({});
    case "session/setMode":
      if (behavior === "plan-rejected") return reply({ settings: { mode: { current: "build" } }, session: { planEnabled: false } });
      return reply({});
    case "session/setThoughtLevel":
    case "session/close": return reply({});
    case "session/setModel":
      assert.deepEqual(Object.keys(params.model).sort(), ["modelId", "providerId"]);
      if (params.model.modelId !== "second") return error(-32602, "Unknown model");
      return reply({ session: { sessionId, model: params.model } });
    case "session/send":
      reply({ accepted: true });
      if (behavior === "cancel") return;
      if (behavior === "exit") return process.exit(2);
      event("turn.started", { inputId: "old-input", turnId: "old-turn" });
      send({ method: "session/event", params: { sessionId, type: "turn.started", inputId: "old-input", turnId: "old-turn", payload: {} } });
      send({ method: "session/event", params: { sessionId, type: "turn.started", inputId: params.inputId, turnId: "current-turn", payload: {} } });
      send({ method: "session/event", params: { sessionId, type: "turn.completed", turnId: "old-turn", payload: {} } });
      event("turn.completed", {}, "other-session");
      if (behavior === "failed") return event("turn.failed", { error: { message: "ZAI_API_KEY=fixture-leak" } });
      event("model.streaming", { kind: "text_delta", delta: "discard" }, "other-session");
      event("model.streaming", { kind: "reasoning_delta", delta: "think" });
      event("model.streaming", { kind: "text_delta", delta: "done" });
      event("model.streaming", { kind: "tool_call", toolCallId: "t1", toolName: "Read", input: { path: "example.txt" } });
      event("tool.updated", { kind: "result", toolCallId: "t1", output: "read" });
      zRequests.forEach((name, i) => reverse(95 + i, "interaction/" + name, {}));
      reverse(103, "interaction/requestPermission", { toolName: "Write", options: [
        { kind: "allow_once", response: { decision: "allow" } }, { kind: "deny_once", response: { decision: "deny" } },
      ] });
      reverse(104, "interaction/requestUserInput", { questions: [{ question: "Colour?" }] });
      return;
    case "session/stop": return event("turn.completed", { stopReason: "cancelled" });
    default: return error(-32601, "Method not found");
  }
});
function replyAcpPrompt() {
  send({ method: "session/update", params: { sessionId: promptSessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "done" } } } });
  send({ id: promptId, result: { stopReason: "end_turn" } });
}
`);
  return {
    file,
    config: (args, behavior) => ({ command: file, args, env: { FIXTURE_LOG: log, FIXTURE_SCENARIO: behavior } }),
    calls: () => fs.readFileSync(log, "utf8").trim().split("\n").map(JSON.parse),
    reset: () => fs.writeFileSync(log, ""),
  };
}

async function finish(handle) {
  const result = await handle.result;
  await handle.closed;
  return result;
}

test("extension probe metadata types, privacy and per-model reasoning descriptors", () => withProjectSandbox("v035-model-boundaries", async dir => {
  const mock = fixture(dir);
  const manager = createEngineManager();
  try {
    const config = mock.config(undefined, "metadata-boundaries");
    const zcode = await manager.probeExtensionProvider({ ...config, id: "zcode", cwd: dir });
    const dsh = await manager.probeExtensionProvider({ ...config, id: "dsh", cwd: dir });
    const turn = await finish(manager.runTurn({
      provider: "zcode", providerConfig: config, cwd: dir, model: "fixture/second", prompt: "test",
    }));
    const model = dsh.models[0];
    const reasoning = model.optionDescriptors.find(d => d.role === "reasoning");
    assert.deepEqual({
      zcodeGroup: zcode.models[0].group, acpDescription: model.description,
      window: zcode.models[0].contextWindow, output: zcode.models[0].maxOutputTokens,
      usageLimit: turn.usage?.contextLimit,
      options: reasoning.options.map(o => o.id), defaultOption: reasoning.currentValue,
    }, {
      zcodeGroup: undefined, acpDescription: "", window: 0, output: undefined, usageLimit: 200000,
      options: ["medium", "xhigh"], defaultOption: "xhigh",
    });

    mock.reset();
    const dynCfg = mock.config(undefined, "dynamic-efforts");
    const dynDsh = await manager.probeExtensionProvider({ ...dynCfg, id: "dsh", cwd: dir });
    assert.deepEqual(dynDsh.models.map(m => [m.id, m.efforts, m.defaultEffort]), [
      ["deepseek/first", ["off", "low", "high", "max"], "high"],
      ["deepseek/second", ["off", "minimal", "low", "medium", "high"], "low"],
      ["deepseek/third", [], ""],
      ["deepseek/fourth", [], ""],
    ]);
    assert.deepEqual(dynDsh.efforts, ["off", "low", "high", "max", "minimal", "medium"]);
    assert.equal(mock.calls().filter(r => r.method === "session/set_config_option").at(-1)?.params?.value, '["deepseek","first"]');

    mock.reset();
    await finish(manager.runTurn({
      provider: "zcode", providerConfig: dynCfg, cwd: dir, model: "fixture/second", effort: "high", prompt: "test",
    }));
    assert.equal(mock.calls().find(r => r.method === "session/setThoughtLevel")?.params?.thoughtLevel, "enabled");
  } finally { await manager.shutdownAll(); }
}));

test("ACP matches delayed options to the probed session and model", () => withProjectSandbox("v035-probe-notify", async dir => {
  const mock = fixture(dir);
  const manager = createEngineManager();
  try {
    const probe = await manager.probeExtensionProvider({ ...mock.config(undefined, "notify-efforts"), id: "dsh", cwd: dir });
    assert.deepEqual(probe.models[1].efforts, ["minimal"]);
    assert.deepEqual(probe.models[0].efforts, []);
  } finally { await manager.shutdownAll(); }
}));

test("ACP restores the original model before closing after an unacknowledged switch", () => withProjectSandbox("v035-probe-timeout", async dir => {
  const mock = fixture(dir);
  const manager = createEngineManager();
  try {
    const probe = await manager.probeExtensionProvider({ ...mock.config(undefined, "switch-timeout"), id: "dsh", cwd: dir });
    assert.equal(probe.ok, true);
    assert.deepEqual(mock.calls().slice(-2).map(r => [r.method, r.params?.value]), [
      ["session/set_config_option", '["deepseek","first"]'], ["session/close", undefined],
    ]);
    mock.reset();
    const rejected = await manager.probeExtensionProvider({ ...mock.config(undefined, "restore-rejected"), id: "dsh", cwd: dir });
    assert.equal(rejected.ok, true);
    assert.ok(rejected.models.length > 0);
    assert.equal(mock.calls().at(-1).method, "session/close");
  } finally { await manager.shutdownAll(); }
}));

test("ZCode honors current session levels and skips models with explicitly empty levels", () => withProjectSandbox("v035-zcode-levels", async dir => {
  const mock = fixture(dir);
  const manager = createEngineManager();
  try {
    for (const [scenario, effort, expected] of [
      ["session-levels", "off", "disabled"], ["session-levels", "minimal", "enabled"], ["empty-levels", "high", undefined],
    ]) {
      mock.reset();
      const config = mock.config(undefined, scenario);
      const probe = await manager.probeExtensionProvider({ ...config, id: "zcode", cwd: dir });
      const turn = await finish(manager.runTurn({ provider: "zcode", providerConfig: config, cwd: dir, effort, prompt: "test" }));
      assert.equal(turn.status, "completed", turn.error);
      assert.deepEqual(mock.calls().filter(r => r.method === "session/setThoughtLevel").map(r => r.params.thoughtLevel),
        expected ? [expected] : []);
      assert.deepEqual(probe.models[0].efforts, expected ? ["disabled", "enabled"] : []);
    }
  } finally { await manager.shutdownAll(); }
}));

function mockEnv(t, vars) {
  for (const [key, value] of Object.entries(vars)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test("minimal and inherited environments strip bridge variables after overrides", t => {
  mockEnv(t, { OTHER_API_KEY: "key", OTHER_TOKEN: "token", OTHER_SECRET: "secret", OTHER_PASSWORD: "pass",
    DSH_FIXTURE: "prefix", FIXTURE_ALLOWED: "exact", https_proxy: "proxy" });
  const extra = { ANTIGRAVITY_CSRF_TOKEN: "dummy", antigravity_ls_address: "dummy", AGENT_TOWER_CHILD_PROCESS: "0",
    NODE_OPTIONS: '--require "C:/dir with spaces/sidecar_sdk.js" --trace-warnings --import=sidecar_sdk.mjs',
    EXPLICIT: "extra" };
  const env = buildCleanChildEnv(extra, { envPolicy: "minimal", allowedEnvKeys: ["dsh_*", "fixture_allowed"] });
  for (const key of ["OTHER_API_KEY", "OTHER_TOKEN", "OTHER_SECRET", "OTHER_PASSWORD", "ANTIGRAVITY_CSRF_TOKEN", "antigravity_ls_address"]) {
    assert.equal(env[key], undefined, key);
  }
  assert.equal(env.NODE_OPTIONS, "--trace-warnings");
  assert.equal(env.AGENT_TOWER_CHILD_PROCESS, "1");
  assert.equal(env.DSH_FIXTURE, "prefix");
  assert.equal(env.FIXTURE_ALLOWED, "exact");
  assert.equal(env.https_proxy, "proxy");
  assert.equal(env.EXPLICIT, "extra");
  assert.equal(buildCleanChildEnv(extra).OTHER_API_KEY, "key");
});

test("OpenCode switches build/plan, skips model placeholders and fails before a rejected explicit model", t => withProjectSandbox("v035-opencode", async dir => {
  mockEnv(t, { OTHER_API_KEY: "inherited-fixture" });
  for (const mode of ["default", "auto", "full-access"]) assert.equal(mapGenericModeFromPermission(mode, "", ["build", "plan"]), "build");
  assert.equal(mapGenericModeFromPermission("default", "", ["plan"]), undefined);
  for (const mode of ["code", "agent", "edit", "guarded"]) assert.equal(mapGenericModeFromPermission("auto", "", [mode, "plan"]), mode);
  const mock = fixture(dir);
  for (const [permissionMode, model, expected] of [
    ["default", "default", "build"], ["auto", "opencode/default", "build"], ["full-access", "first", "build"], ["plan", "default", "plan"],
  ]) {
    mock.reset();
    const events = [];
    const result = await finish(runGenericAcpTurn({ provider: "opencode", providerConfig: mock.config(["acp"]), cwd: dir,
      permissionMode, model, onEvent: event => events.push(event) }));
    assert.equal(result.status, "completed");
    const calls = mock.calls();
    assert.equal(calls[0].env.OTHER_API_KEY, "inherited-fixture");
    const mode = calls.find(row => row.method === "session/set_mode");
    assert.equal(mode?.params.modeId ?? "plan", expected);
    assert.equal(calls.some(row => row.method === "session/set_model"), model === "first");
    assert.deepEqual(events.filter(event => event.type === "message_delta").map(event => event.delta), ["done"]);
  }
  for (const [behavior, permissionMode, model, code] of [
    ["", "auto", "unknown", "ACP_MODEL_SWITCH_FAILED"], ["no-mode", "plan", undefined, "ACP_PLAN_MODE_UNSUPPORTED"],
    ["auth", "auto", undefined, "ACP_AUTH_REQUIRED"],
  ]) {
    mock.reset();
    const result = await finish(runGenericAcpTurn({ provider: "opencode", providerConfig: mock.config(["acp"], behavior), cwd: dir, permissionMode, model }));
    assert.equal(result.code, code);
    assert.ok(mock.calls().every(row => row.method !== "session/prompt"));
  }
}));

test("DSH uses ACP profile, scopes permissions and model IDs, resumes safely and closes hidden sessions", t => withProjectSandbox("v035-dsh", async dir => {
  mockEnv(t, { DEEPSEEK_API_KEY: "dsh-fixture", OTHER_API_KEY: "other-fixture" });
  const mock = fixture(dir, "node_modules/@deepseek-ai/dsh/lib/bin.js");
  const manager = createEngineManager();
  const config = mock.config(undefined);
  try {
    const probe = await manager.probeExtensionProvider({ ...config, id: "dsh", cwd: dir });
    assert.equal(probe.ok, true, probe.error);
    assert.equal(probe.defaultModel, "deepseek/first");
    assert.deepEqual(probe.modes, []);
    assert.deepEqual(probe.models.map(m => m.slug), ["deepseek/first", "deepseek/second"]);
    assert.equal(probe.models[0].group, "DeepSeek Official");
    assert.equal(probe.models[0].contextWindow, 128000);
    assert.equal(probe.models[0].maxOutputTokens, 8192);
    assert.equal(probe.models[1].group, "DeepSeek Official");
    assert.equal(probe.models[1].contextWindow, 0);
    const flattened = flattenAcpOptions([
      { name: "Channel X", options: [{ value: "a" }, { value: "b", group: "Own Group" }] },
      { group: "Channel Y", options: [{ value: "c" }] },
    ]);
    assert.deepEqual(flattened.map(x => [x.value, x.group]), [["a", "Channel X"], ["b", "Own Group"], ["c", "Channel Y"]]);
    assert.deepEqual(mock.calls()[0].argv, ["--profile", "acp"]);
    for (const [behavior, permissionMode, model, expectedPerm, expectedDecision] of [
      ["mismatch", "plan", "deepseek/second", "read-only", "reject-once"],
      ["missing", "default", "second", "workspace-write", "allow-once"],
      ["unimplemented", "auto", '["deepseek","second"]', "workspace-write", "allow-once"],
      ["omitted", "full-access", "second", "danger-full-access", "allow-once"],
      ["", "auto", "second", "workspace-write", "allow-once"],
    ]) {
      mock.reset();
      let asked = 0;
      const events = [];
      const result = await finish(manager.runTurn({
        provider: "dsh", providerConfig: { ...config, env: { ...config.env, DSH_PERMISSION_MODE: "danger-full-access", FIXTURE_SCENARIO: behavior } },
        permissionMode, cwd: dir, model, nativeSessionId: "old", prompt: "base", freshSessionPrompt: "fresh",
        onEvent: event => events.push(event), onPermissionRequest: () => { asked++; return "allow"; },
      }));
      assert.equal(result.status, "completed", result.error);
      assert.equal(result.effectiveModel, "deepseek/second");
      const calls = mock.calls();
      assert.equal(calls[0].env.DSH_PERMISSION_MODE, expectedPerm);
      assert.equal(calls[0].env.DSH_TELEMETRY_DISABLED, "1");
      assert.equal(calls[0].env.DEEPSEEK_API_KEY, "dsh-fixture");
      assert.equal(calls[0].env.OTHER_API_KEY, undefined);
      assert.equal(calls.some(row => row.method === "session/set_mode"), false);
      assert.equal(calls.find(row => row.method === "session/set_config_option").params.value, '["deepseek","second"]');
      assert.equal(calls.find(row => row.id === 90).result.outcome.optionId, expectedDecision);
      assert.equal(asked, ["auto", "default"].includes(permissionMode) ? 1 : 0);
      assert.equal(events.find(event => event.type === "session_bound").resumed, !behavior);
      assert.equal(calls.some(row => row.method === "session/resume"), behavior !== "omitted");
      assert.equal(calls.some(row => row.method === "session/new"), !!behavior);
      const text = calls.find(row => row.method === "session/prompt").params.prompt[0].text;
      assert.match(text, permissionMode === "plan" ? /只读规划[\s\S]*fresh/ : behavior ? /fresh/ : /^base$/);
    }
    mock.reset();
    const events = [];
    const result = await finish(manager.runTurn({ provider: "dsh", providerConfig: config, cwd: dir, nativeSessionId: "old",
      ephemeral: true, onEvent: event => events.push(event) }));
    assert.equal(result.status, "completed");
    assert.equal(result.nativeSessionId, undefined);
    assert.equal(events.find(event => event.type === "session_bound").nativeSessionId, undefined);
    assert.deepEqual(mock.calls().map(row => row.method).filter(method => /session\/(?:resume|new|close|delete)/.test(method)),
      ["session/new", "session/close"]);
    mock.reset();
    const unavailable = await finish(manager.runTurn({
      provider: "dsh", providerConfig: mock.config(undefined, "transient"), cwd: dir, nativeSessionId: "old",
    }));
    assert.equal(unavailable.status, "failed");
    assert.equal(unavailable.nativeSessionId, "old");
    assert.ok(mock.calls().every(row => !["session/new", "session/prompt"].includes(row.method)));
  } finally { await manager.shutdownAll(); }
}));

test("ZCode probe and turn use native frames, deny reverse credential RPCs, and expose no hidden session ID", t => withProjectSandbox("v035-zcode", async dir => {
  mockEnv(t, { ZAI_API_KEY: "zai-fixture", OTHER_TOKEN: "other-fixture" });
  const mock = fixture(dir, "ZCode/resources/glm/zcode.cjs");
  const configFile = path.join(dir, "ZCode/resources/config/provider/zcode-builtin.json");
  fs.mkdirSync(path.dirname(configFile), { recursive: true });
  fs.writeFileSync(configFile, "{}");
  const config = mock.config(undefined);
  const manager = createEngineManager();
  try {
    const probe = await manager.probeExtensionProvider({ ...config, id: "zcode", cwd: dir });
    assert.equal(probe.ok, true, probe.error);
    assert.equal(probe.protocol, "zcode");
    assert.equal(probe.defaultModel, "fixture/first");
    assert.deepEqual(probe.models.map(model => model.slug), ["fixture/first", "fixture/second"]);
    assert.equal(probe.models[0].contextWindow, 128000);
    assert.equal(probe.models[0].maxOutputTokens, 8192);
    assert.equal(probe.models[0].group, "Fixture Channel A");
    assert.deepEqual(probe.models[0].efforts, ["low", "high"]);
    assert.equal(probe.models[0].defaultEffort, "high");
    assert.equal(probe.models[1].contextWindow, 200000);
    assert.equal(probe.models[1].maxOutputTokens, 16384);
    assert.equal(probe.models[1].group, "Fixture Channel B");
    assert.deepEqual(probe.models[1].efforts, ["medium", "xhigh"]);
    assert.equal(probe.models[1].defaultEffort, "xhigh");
    assert.deepEqual(probe.efforts, ["high"]);
    assert.deepEqual(mock.calls()[0].argv, ["app-server", "--stdio"]);
    assert.equal(mock.calls()[0].env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, configFile);
    assert.deepEqual(mock.calls().slice(1).map(row => row.method), ["session/create", "session/close"]);
    mock.reset();
    const disabled = await finish(manager.runTurn({ provider: "zcode", providerConfig: { ...config, enabled: false }, cwd: dir }));
    assert.equal(disabled.stopReason, "unsupported_provider");
    assert.equal(fs.readFileSync(path.join(dir, "rpc.jsonl"), "utf8"), "");
    assert.equal((await manager.probeExtensionProvider({ ...config, id: "custom", driverKind: "zcode", cwd: dir })).protocol, "zcode");
    assert.equal((await manager.probeExtensionProvider({ ...config, id: "zcode", protocol: "acp", args: ["acp"], cwd: dir })).protocol, "acp");
    mock.reset();
    const events = [];
    const result = await finish(manager.runTurn({
      provider: "zcode", providerConfig: config, cwd: dir, nativeSessionId: "old", ephemeral: true,
      permissionMode: "plan", model: "fixture/second", effort: "high", prompt: "run",
      onPermissionRequest: () => assert.fail("plan must deny writes"), onQuestionRequest: () => ({ answers: { "Colour?": "blue" } }),
      onEvent: event => events.push(event),
    }));
    assert.equal(result.status, "completed", result.error);
    assert.equal(result.assistantText, "done");
    assert.equal(result.reasoningText, "think");
    assert.equal(result.effectiveModel, "fixture/second");
    assert.equal(result.usage?.contextLimit, 200000);
    assert.equal(events.find(e => e.type === "usage_updated")?.usage?.contextLimit, 200000);
    assert.equal(result.nativeSessionId, undefined);
    assert.equal(events.find(e => e.type === "session_bound").nativeSessionId, undefined);
    assert.deepEqual(events.filter(e => e.type === "tool_call").map(e => e.status), ["in_progress", "completed"]);
    const calls = mock.calls();
    assert.equal(calls[0].env.ZAI_API_KEY, "zai-fixture");
    assert.equal(calls[0].env.OTHER_TOKEN, undefined);
    assert.deepEqual(calls.map(row => row.method).filter(Boolean),
      ["session/create", "session/subscribe", "session/setMode", "session/setModel", "session/setThoughtLevel", "session/send", "session/close"]);
    for (const id of [95, 96, 97, 98, 99]) assert.deepEqual(calls.find(row => row.id === id).error, { code: -32601, message: "Method not found" });
    assert.deepEqual(calls.find(row => row.id === 103).result, { decision: "deny" });
    assert.deepEqual(calls.find(row => row.id === 104).result, { action: "accept", content: { answers: { "Colour?": "blue" } } });
  } finally { await manager.shutdownAll(); }
}));

test("ZCode resume, permission defaults, explicit model failure, errors and cancellation", () => withProjectSandbox("v035-zcode-turns", async dir => {
  const mock = fixture(dir);
  const manager = createEngineManager();
  try {
    for (const [behavior, permissionMode, expectedMode, decision] of [
      ["missing", "default", "guarded", undefined], ["", "accept-edits", "edit", "allow"],
      ["failed", "auto", "build", undefined], ["exit", "full-access", "yolo", undefined],
    ]) {
      mock.reset();
      const result = await finish(manager.runTurn({ provider: "zcode", providerConfig: mock.config(undefined, behavior),
        cwd: dir, nativeSessionId: "old", model: "zcode/default", permissionMode, onPermissionRequest: async () => decision,
      }));
      assert.equal(result.status, ["failed", "exit"].includes(behavior) ? "failed" : "completed");
      assert.doesNotMatch(result.error || "", /fixture-leak/);
      const calls = mock.calls();
      assert.equal(calls.some(row => row.method === "session/create"), behavior === "missing");
      assert.equal(calls.some(row => row.method === "session/setModel"), false);
      assert.equal(calls.find(row => row.method === "session/setMode").params.mode, expectedMode);
      if (result.status === "completed") assert.equal(calls.find(row => row.id === 103).result.decision, decision ?? "deny");
    }
    mock.reset();
    const failed = await finish(manager.runTurn({ provider: "zcode", providerConfig: mock.config(), cwd: dir, model: "fixture/missing" }));
    assert.equal(failed.code, "ZCODE_MODEL_SWITCH_FAILED");
    assert.equal(mock.calls().some(row => row.method === "session/send"), false);
    mock.reset();
    const wrongMode = await finish(manager.runTurn({ provider: "zcode", providerConfig: mock.config(undefined, "plan-rejected"), cwd: dir, permissionMode: "plan" }));
    assert.equal(wrongMode.status, "failed");
    assert.equal(mock.calls().some(row => row.method === "session/send"), false);
    mock.reset();
    const handle = manager.runTurn({ provider: "zcode", providerConfig: mock.config(undefined, "cancel"), cwd: dir,
      onEvent: event => { if (event.type === "effective_model") queueMicrotask(() => { void handle.cancel(); }); },
    });
    assert.equal((await finish(handle)).status, "interrupted");
    assert.deepEqual(mock.calls().map(row => row.method).filter(method => /session\/(?:send|stop|close)/.test(method)),
      ["session/send", "session/stop", "session/close"]);
  } finally { await manager.shutdownAll(); }
}));

test("binary discovery only touches install paths and leaves credential canaries unread", t => withProjectSandbox("v035-discovery", dir => {
  mockEnv(t, { PATH: path.join(dir, "bin"), HOME: dir, USERPROFILE: dir, APPDATA: dir, LOCALAPPDATA: dir,
    ZCODE_BINARY_PATH: undefined, ZCODE_BIN: undefined, ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: undefined });
  for (const dot of [".dsh", ".zcode", ".opencode"]) {
    fs.mkdirSync(path.join(dir, dot));
    fs.writeFileSync(path.join(dir, dot, "credentials.json"), '{"API_KEY":"canary-fixture"}');
  }
  fs.mkdirSync(path.join(dir, "bin"));
  const dsh = path.join(dir, "bin", "dsh");
  const elf = path.join(dir, "bin", "zcode");
  fs.writeFileSync(dsh, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(elf, "\u007fELF", { mode: 0o755 });
  const desktop = fixture(dir, "ZCode/resources/glm/zcode.cjs").file;
  const npm = fixture(dir, "lib/node_modules/@deepseek-ai/dsh/lib/bin.js").file;
  const bun = path.join(dir, ".bun", "bin", "opencode" + (process.platform === "win32" ? ".exe" : ""));
  fs.mkdirSync(path.dirname(bun), { recursive: true });
  fs.writeFileSync(bun, "", { mode: 0o755 });
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const nodeVersion = Object.getOwnPropertyDescriptor(process.versions, "node");
  const reads = [];
  const stubs = ["readFileSync", "openSync", "readdirSync", "existsSync", "statSync"].map(method => {
    const original = fs[method];
    return t.mock.method(fs, method, (file, ...args) => {
      if (/[\\/]\.(?:dsh|zcode|opencode)(?:[\\/]credentials\.json)?$/i.test(String(file))) reads.push(String(file));
      return original(file, ...args);
    });
  });
  syncBuiltinESMExports();
  try {
    assert.equal(detectCommandOnSystem("opencode").binaryPath, bun);
    assert.equal(resolveDshBinary([npm]).resolvedPath, npm);
    assert.equal(resolveZCodeBinary([desktop]).resolvedPath, desktop);
    assert.equal(resolveZCodeBinary([desktop]).env.ZCODE_BUILTIN_PROVIDER_CONFIG_FILE, undefined);
    assert.equal(resolveZCodeBinary([], desktop).resolvedPath, desktop);
    const runtime = path.resolve(path.dirname(desktop), process.platform === "win32" ? "../../ZCode.exe"
      : process.platform === "darwin" ? "../../MacOS/ZCode" : "../../zcode");
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.writeFileSync(runtime, "", { mode: 0o755 });
    Object.defineProperty(process.versions, "node", { ...nodeVersion, value: "20.0.0" });
    const lowNode = resolveZCodeBinary([desktop]);
    assert.equal(lowNode.command, runtime);
    assert.equal(lowNode.env.ELECTRON_RUN_AS_NODE, "1");
    Object.defineProperty(process.versions, "node", nodeVersion);
    // Apply Linux's identity rules to the same fixture paths on all CI hosts.
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    assert.notEqual(resolveDshBinary([dsh]).resolvedPath, dsh);
    assert.equal(resolveDshBinary([], dsh).resolvedPath, dsh);
    assert.notEqual(resolveZCodeBinary([elf]).resolvedPath, elf);
    assert.equal(reads.length, 0);
  } finally {
    Object.defineProperty(process, "platform", platform);
    Object.defineProperty(process.versions, "node", nodeVersion);
    for (const stub of stubs) stub.mock.restore();
    syncBuiltinESMExports();
  }
}));

test("CLI probe and runtime redact credentials and retain missing-key diagnostics", t => withProjectSandbox("v035-cli", async dir => {
  mockEnv(t, { OTHER_PASSWORD: "unrelated-fixture", FIXTURE_ALLOWED: "allowed-fixture" });
  const output = "no API key: OPENAI_API_KEY=plain-fixture PASSWORD='another fixture' AUTH_TOKEN=Bearer assigned-fixture Bearer bare-fixture "
    + "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signfixture abcd1234.longfixturesecret sk-fixture-secret\n"
    + "Full diagnostics:\ncanary-in-crash-block";
  assert.match(redactSensitiveText(output), /REDACTED/);
  assert.match(safeEngineError(output), /no API key/);
  const cli = path.join(dir, "cli.cjs");
  fs.writeFileSync(cli, "const assert = require('node:assert/strict');\n"
    + "assert.equal(process.env.OTHER_PASSWORD, undefined); assert.equal(process.env.FIXTURE_ALLOWED, 'allowed-fixture');\n"
    + "assert.equal(process.env.AGENT_TOWER_CHILD_PROCESS, '1');\n"
    + "console.log(JSON.stringify({ reasoning: 'Bearer reasoning-fixture', delta: 'sk-message-fixture' }));\n"
    + "console.log(" + JSON.stringify(output) + "); console.error(" + JSON.stringify(output) + "); process.exitCode = 1;");
  const config = { command: cli, envPolicy: "minimal", credentialEnvKeys: ["FIXTURE_ALLOWED"] };
  const probe = await probeCliProvider({ ...config, cwd: dir });
  assert.equal(probe.ok, false);
  const events = [];
  const result = await runGenericCliTurn({ providerConfig: config, cwd: dir, onEvent: e => events.push(e) }).result;
  assert.equal(result.status, "failed");
  assert.equal(result.category, "permission_error");
  assert.doesNotMatch(JSON.stringify([result, events]), /reasoning-fixture|sk-message-fixture|plain-fixture|canary-in-crash-block/);
  for (const text of [probe.versionOutput ?? probe.error, result.error, redactSensitiveText(output)]) {
    assert.match(text, /no API key/);
    assert.doesNotMatch(text, /plain-fixture|another fixture|assigned-fixture|bare-fixture|eyJ|longfixturesecret|sk-fixture-secret|canary-in-crash-block|Full diagnostics/);
  }
}));

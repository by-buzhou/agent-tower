import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { BUILTIN_EXTENSION_TEMPLATES, normalizeProviderId } from "../../core/catalog.mjs";
import { createEngineManager } from "../../core/engines/index.mjs";
import { resolveExternalCommand } from "../../core/engines/proc-utils.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";
import { within } from "../helpers/process.mjs";

const fakeEngine = String.raw`
import fs from "node:fs";
import readline from "node:readline";
const [log, engine, scenario, ...args] = process.argv.slice(2);
const record = data => fs.appendFileSync(log, JSON.stringify({ pid: process.pid, engine, ...data }) + "\n");
const send = data => console.log(JSON.stringify({ jsonrpc: "2.0", ...data }));
const update = (sessionId, update) => send({ method: "session/update", params: { sessionId, update } });
const grouped = (value, name) => [{ options: [{ options: [{ value, name }] }] }];
const model = engine === "agy"
  ? { id: "model", currentValue: "gemini-4-hydrogen", options: grouped("gemini-4-hydrogen", "Hydrogen") }
  : { id: "model", currentValue: "first", options: grouped("second", "Model Two") };
const effort = { id: "thought_level", currentValue: "low", options: grouped("high", "High") };
const mode = { id: "mode", currentValue: "default", options: grouped("default", "Default") };
record({ method: "spawn", args, cwd: process.cwd() });
if (engine === "claude") {
  if (args.includes("--help")) {
    await new Promise(resolve => setTimeout(resolve, 80));
    console.log("--strict-mcp-config");
  } else {
    console.log(JSON.stringify({ type: "result", session_id: "claude-session", result: "done" }));
  }
  process.exitCode = 0;
} else if (engine === "gemini" && args.includes("--acp")) {
  console.error("Unknown arguments: acp");
  process.exitCode = 1;
} else if (args.includes("review")) {
  console.log(JSON.stringify({ type: "turn.completed", usage: {} }));
} else {
  const lines = readline.createInterface({ input: process.stdin });
  for await (const line of lines) {
    const { id, method, params } = JSON.parse(line);
    record({ method, params });
    if (id == null) continue;
    let result = {}, error;
    if (method === "initialize" && engine !== "codex") {
      if (scenario === "hang-init" && process.cwd().endsWith("warm-cwd")) continue;
      result = { protocolVersion: scenario === "version" ? 2 : 1, authMethods: [
        { type: "terminal", name: "Sign in", command: "fixture-cli", args: ["login"] },
      ] };
      const capabilities = { sessionCapabilities: { close: {}, delete: {} } };
      if (scenario === "close-only") delete capabilities.sessionCapabilities.delete;
      if (scenario === "load") capabilities.loadSession = true;
      if (scenario === "resume") Object.assign(capabilities, { loadSession: true, sessionCapabilities: { resume: {} } });
      result[scenario === "load" ? "capabilities" : "agentCapabilities"] = capabilities;
      if (scenario === "omitted") delete result.agentCapabilities;
    }
    if (method === "session/new" || method === "session/load" || method === "session/resume") {
      if (scenario === "auth") error = { code: -32000, message: "Request failed" };
      result = { sessionId: params.sessionId || "session", configOptions: [model, effort, mode] };
    }
    if (method === "thread/start") result.thread = { id: "thread" };
    if (method === "turn/start") result.turn = { id: "turn" };
    if (method === "session/set_config_option" && params.configId === "model") {
      update(params.sessionId, { sessionUpdate: "config_option_update", configOptions: [
        { ...model, currentValue: params.value }, { ...effort, category: "thought_level", id: "next-effort" }, mode,
      ] });
      result.configOptions = [model, effort, mode];
    }
    if (method === "session/prompt") {
      if (scenario === "prompt-error") error = { code: -32603, message: "Prompt failed" };
      update("foreign", { sessionUpdate: "agent_message_chunk", content: { text: "wrong" } });
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { text: "done" } });
      update(params.sessionId, { sessionUpdate: "tool_call", toolCallId: "edit", content: [
        { type: "content", content: { type: "text", text: "changed" } },
        { type: "diff", path: "example.txt", oldText: "before", newText: "after" },
      ] });
      result.stopReason = "end_turn";
    }
    if (scenario === "hang-close" && method === "session/close") continue;
    if (scenario === "slow-delete" && method === "session/delete") await new Promise(resolve => setTimeout(resolve, 600));
    send(error ? { id, error } : { id, result });
    if (method === "turn/start") send({ method: "turn/completed", params: { threadId: "thread", turn: { id: "turn", status: "completed" } } });
  }
}
`;

function fixture(dir) {
  const script = path.join(dir, "fake-engine.mjs");
  const log = path.join(dir, "calls.ndjson");
  fs.writeFileSync(script, fakeEngine);
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").filter(Boolean)
    .flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }) : [];
  return {
    calls,
    binary: (engine, scenario = "ok", env) => () => ({
      command: process.execPath, resolvedPath: script, prefixArgs: [script, log, engine, scenario], env,
    }),
    config: (engine, scenario = "ok", args = []) => ({ command: script, args: [log, engine, scenario, ...args] }),
  };
}

async function until(read, title) {
  const until = Date.now() + 4000;
  do {
    const value = read();
    if (value) return value;
    await delay(15);
  } while (Date.now() < until);
  assert.fail(title);
}

const assertGone = pid => assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });

test("Codex and Kimi consume initialized spares once and bind the real workspace", () => withProjectSandbox("v034-warm", async dir => {
  const cli = fixture(dir);
  const cwd = fs.mkdirSync(path.join(dir, "project"), { recursive: true });
  const pluginDataDir = path.join(dir, "control");
  const neutral = path.join(pluginDataDir, "warm-cwd");
  const manager = createEngineManager({ pluginDataDir, warmPoolOptions: { enabled: true, allowInTest: true } });
  try {
    for (const [provider, engine, sessionMethod] of [["codex", "codex", "thread/start"], ["kimi-code", "kimi", "session/new"]]) {
      const events = [];
      const run = () => manager.runTurn({ provider, cwd, prompt: "test", resolveBinary: cli.binary(engine), onEvent: event => events.push(event) });
      const cold = run();
      assert.equal((await cold.result).warmHit, false);
      await cold.closed;
      const spawn = await until(() => cli.calls().find(row => row.engine === engine && row.cwd === neutral), "warm child spawned");
      await until(() => cli.calls().some(row => row.pid === spawn.pid && row.method === "initialize"), "warm child initialized");
      const warm = run();
      const result = await warm.result;
      assert.equal(result.status, "completed");
      assert.equal(result.warmHit, true);
      assert.equal(typeof result.initHandshakeMs, "number");
      assert.ok(events.some(event => event.type === "session_bound" && event.warmHit && event.initHandshakeMs === result.initHandshakeMs));
      await warm.closed;
      const consumed = cli.calls().filter(row => row.pid === spawn.pid);
      assert.equal(consumed.filter(row => row.method === "initialize").length, 1);
      if (engine === "codex") assert.equal(consumed.filter(row => row.method === "initialized").length, 1);
      assert.deepEqual(consumed.filter(row => row.method === sessionMethod).map(row => row.params.cwd), [cwd]);
      assertGone(spawn.pid);
    }
    await manager.shutdownAll();
    for (const row of cli.calls().filter(row => row.method === "spawn")) assertGone(row.pid);
  } finally { await manager.shutdownAll(); }
}));

test("warm pool test opt-in, idle expiry, and drain during initialize", () => withProjectSandbox("v034-drain", async dir => {
  const cli = fixture(dir);
  const run = (manager, scenario) => manager.runTurn({ provider: "kimi-code", cwd: dir, resolveBinary: cli.binary("kimi", scenario) });
  const disabled = createEngineManager({ pluginDataDir: path.join(dir, "disabled"), warmPoolOptions: { enabled: true } });
  try {
    await run(disabled, "ok").closed;
    assert.equal(cli.calls().filter(row => row.method === "spawn").length, 1);
  } finally { await disabled.shutdownAll(); }
  for (const scenario of ["ok", "hang-init"]) {
    const pluginDataDir = path.join(dir, scenario);
    const manager = createEngineManager({ pluginDataDir, warmPoolOptions: { enabled: true, allowInTest: true, idleTtlMs: 80 } });
    try {
      const handle = run(manager, scenario);
      const spawn = await until(() => cli.calls().find(row => row.cwd === path.join(pluginDataDir, "warm-cwd")), "warm child spawned");
      if (scenario === "hang-init") {
        await until(() => cli.calls().some(row => row.pid === spawn.pid && row.method === "initialize"), "pending initialize");
        await within(manager.drainWarmPool(), 6000, "drain pending initialize");
        assertGone(spawn.pid);
      } else {
        await until(() => {
          try { process.kill(spawn.pid, 0); return false; }
          catch (error) { return error.code === "ESRCH"; }
        }, "warm idle TTL expires");
      }
      assert.equal((await handle.result).status, "completed");
      await handle.closed;
    } finally { await manager.shutdownAll(); }
  }
}));

test("warm capacity counts pending initializations and keeps one spare per key", () => withProjectSandbox("v034-capacity", async dir => {
  const cli = fixture(dir);
  const pluginDataDir = path.join(dir, "control");
  const neutral = path.join(pluginDataDir, "warm-cwd");
  const manager = createEngineManager({ pluginDataDir, warmPoolOptions: { enabled: true, allowInTest: true } });
  try {
    const run = (provider, engine, scenario, inheritHostMcp = false) => manager.runTurn({
      provider, cwd: dir, resolveBinary: cli.binary(engine, scenario), inheritHostMcp,
    });
    const handles = [
      run("kimi-code", "kimi", "hang-init"),
      run("kimi-code", "kimi", "hang-init"),
      run("codex", "codex", "ok"),
      run("codex", "codex", "ok", true),
    ];
    await Promise.all(handles.map(handle => handle.closed));
    const spares = await until(() => {
      const rows = cli.calls().filter(row => row.cwd === neutral);
      return rows.length >= 2 && rows;
    }, "two warm slots initialized");
    assert.deepEqual(spares.map(row => row.engine).sort(), ["codex", "kimi"]);
    await manager.drainWarmPool();
    spares.forEach(row => assertGone(row.pid));
  } finally { await manager.shutdownAll(); }
}));

test("Codex disables global and project MCP keys, bypasses uncovered spares, and isolates reviews", () => withProjectSandbox("v034-mcp", async dir => {
  const cli = fixture(dir);
  const home = fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  const cwd = fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
  const neutral = path.join(dir, "control", "warm-cwd");
  const resolveBinary = cli.binary("codex", "ok", { CODEX_HOME: home });
  fs.writeFileSync(path.join(home, "config.toml"), [
    'instructions = """', "[mcp_servers.fake]", '"""',
    '[mcp_servers."slow.global" ] # comment', 'command = "fake"',
    '[mcp_servers.extra.env]', 'VALUE = "a#b"',
  ].join("\n"));
  const manager = createEngineManager({ pluginDataDir: path.dirname(neutral), warmPoolOptions: { enabled: true, allowInTest: true } });
  const run = inheritHostMcp => manager.runTurn({ provider: "codex", cwd, resolveBinary, inheritHostMcp });
  try {
    await run().closed;
    const spare = await until(() => cli.calls().find(row => row.cwd === neutral), "global warm spare");
    await until(() => cli.calls().some(row => row.pid === spare.pid && row.method === "initialized"), "warm Codex initialized");
    fs.mkdirSync(path.join(cwd, ".codex"));
    fs.writeFileSync(path.join(cwd, ".codex", "config.toml"), 'mcp_servers = { "inline.dotted".command = "slow", \'project key\' = { command = "fake" } }\n');
    const isolated = run();
    assert.equal((await isolated.result).warmHit, false);
    await isolated.closed;
    const inherited = run(true);
    await inherited.closed;
    const review = manager.runReview({ cwd, resolveBinary });
    assert.equal((await review.result).status, "completed");
    await review.closed;
    const local = cli.calls().filter(row => row.cwd === cwd);
    const overrides = row => row.args.filter(arg => arg.startsWith("mcp_servers"));
    const globalKeys = ['mcp_servers={"extra"={enabled=false},"slow.global"={enabled=false}}'];
    const allKeys = ['mcp_servers={"extra"={enabled=false},"slow.global"={enabled=false},"inline.dotted"={enabled=false},"project key"={enabled=false}}'];
    assert.deepEqual(local.map(overrides), [globalKeys, allKeys, [], allKeys]);
    assert.equal(cli.calls().some(row => row.pid === spare.pid && row.method === "thread/start"), false);
  } finally { await manager.shutdownAll(); }
}));

test("result settles while ACP close hangs and thread/path fences wait for exit", () => withProjectSandbox("v034-fence", async dir => {
  const cli = fixture(dir);
  const cwd = path.join(dir, "repo", "subdir");
  fs.mkdirSync(cwd, { recursive: true });
  const manager = createEngineManager();
  try {
    const handle = manager.runTurn({ provider: "qwen", threadId: "fenced", cwd, providerConfig: cli.config("qwen", "hang-close") });
    assert.equal((await handle.result).assistantText, "done");
    assert.equal(manager.getActiveCount(), 0);
    await assert.rejects(manager.waitForThreadClosed("fenced", 15), { code: "ENGINE_CLOSE_TIMEOUT" });
    await assert.rejects(manager.waitForPathClosed(path.dirname(cwd), 15), { code: "ENGINE_CLOSE_TIMEOUT" });
    await manager.waitForPathClosed(cwd + "-neighbor", 15);
    await manager.waitForThreadClosed("fenced");
    await manager.waitForPathClosed(cwd);
    await handle.closed;
    assertGone(cli.calls().find(row => row.method === "spawn").pid);
    fs.rmdirSync(cwd);
    const ephemeral = manager.runTurn({ provider: "qwen", cwd: dir, ephemeral: true, providerConfig: cli.config("qwen", "slow-delete") });
    assert.equal((await ephemeral.result).status, "completed");
    await ephemeral.closed;
    assert.equal(cli.calls().at(-1).method, "session/delete", "a slow successful deletion must finish without falling back to close");
  } finally { await manager.shutdownAll(); }
}));

test("ACP v1 negotiates resume, filters notifications, refreshes options, and returns auth instructions", () => withProjectSandbox("v034-protocol", async dir => {
  const cli = fixture(dir);
  const manager = createEngineManager();
  const mcpServers = [{ name: "fixture", command: "mock", args: [], env: [] }];
  try {
    for (const scenario of ["resume", "load", "unsupported", "omitted", "version", "auth"]) {
      const events = [];
      const providerConfig = cli.config(scenario, scenario);
      const handle = manager.runTurn({ provider: "qwen", providerConfig, cwd: dir, model: "second", effort: "high",
        nativeSessionId: ["resume", "load", "unsupported", "omitted"].includes(scenario) ? "old" : undefined,
        inheritHostMcp: scenario === "resume", mcpServers, onEvent: event => events.push(event) });
      const result = await handle.result;
      await handle.closed;
      const requests = cli.calls().filter(row => row.engine === scenario);
      if (!["resume", "load"].includes(scenario)) {
        assert.equal(result.code, { version: "ACP_PROTOCOL_UNSUPPORTED", auth: "ACP_AUTH_REQUIRED" }[scenario] || "ACP_SESSION_RESUME_UNSUPPORTED");
        if (scenario === "auth") assert.match(result.error, /fixture-cli login/);
        assert.equal(requests.some(row => /authenticate|session\/(?:resume|load|prompt)/.test(row.method)), false);
        continue;
      }
      assert.equal(result.status, "completed");
      assert.equal(result.assistantText, "done");
      assert.equal(result.effectiveModel, "second");
      assert.deepEqual(requests.filter(row => /session\/(?:new|resume|load)/.test(row.method)).map(row => row.method), ["session/" + scenario]);
      assert.deepEqual(requests.find(row => row.method === "session/" + scenario).params.mcpServers, scenario === "resume" ? mcpServers : []);
      assert.ok(requests.some(row => row.params?.configId === "next-effort" && row.params.value === "high"));
      assert.deepEqual(events.find(event => event.type === "tool_call")?.diff, { path: "example.txt", oldText: "before", newText: "after" });
    }
  } finally { await manager.shutdownAll(); }
}));

test("Kimi and AGY apply ACP authentication and ephemeral teardown contracts", () => withProjectSandbox("v034-kimi-agy", async dir => {
  const cli = fixture(dir);
  const manager = createEngineManager({ hostEnv: { GEMINI_API_KEY: "test-credential" } });
  try {
    for (const [provider, engine] of [["kimi-code", "kimi"], ["antigravity", "agy"]]) {
      const run = (scenario, onEvent) => manager.runTurn({ provider, cwd: dir, ephemeral: true, nativeSessionId: "old",
        antigravityAcpMode: "api_key", resolveBinary: cli.binary(engine, scenario), onEvent });
      const unauthorized = run("auth");
      assert.equal((await unauthorized.result).code, "ACP_AUTH_REQUIRED");
      await unauthorized.closed;
      const events = [];
      const ephemeral = run("ok", event => events.push(event));
      const result = await ephemeral.result;
      assert.equal(result.status, "completed");
      assert.equal(result.nativeSessionId, undefined);
      await ephemeral.closed;
      const calls = cli.calls().filter(row => row.engine === engine);
      assert.equal(calls.filter(row => row.method === "session/delete").length, 1);
      assert.ok(!calls.some(row => /authenticate|session\/(?:resume|load)/.test(row.method)));
      assert.equal(events.filter(event => event.type === "engine_teardown").length, 1);
      const failed = run("prompt-error");
      assert.equal((await failed.result).status, "failed");
      await failed.closed;
      const cancelled = run("close-only", event => {
        if (event.type === "session_bound") void cancelled.cancel();
      });
      assert.equal((await cancelled.result).status, "interrupted");
      await cancelled.closed;
      const finalCalls = cli.calls().filter(row => row.engine === engine);
      assert.equal(finalCalls.filter(row => row.method === "session/delete").length, 2);
      assert.equal(finalCalls.at(-1).method, "session/close");
    }
  } finally { await manager.shutdownAll(); }
}));

test("Gemini falls back once in probe and runtime, and Qwen is built in", () => withProjectSandbox("v034-gemini", async dir => {
  const cli = fixture(dir);
  const manager = createEngineManager();
  const providerConfig = cli.config("gemini", "ok", ["--acp"]);
  try {
    const catalog = await manager.probeExtensionProvider({ id: "gemini-cli", cwd: dir, ...providerConfig });
    assert.equal(catalog.ok, true, catalog.error);
    assert.deepEqual(catalog.models.map(model => [model.slug, model.name, model.efforts]), [["second", "Model Two", ["high"]]]);
    const turn = manager.runTurn({ provider: "gemini-cli", providerConfig, cwd: dir });
    assert.equal((await turn.result).status, "completed");
    await turn.closed;
    assert.deepEqual(cli.calls().filter(row => row.method === "spawn").map(row => row.args), [
      ["--acp"], ["--experimental-acp"], ["--acp"], ["--experimental-acp"],
    ]);
    assert.equal(normalizeProviderId("qwen"), "qwen-code");
    const qwen = BUILTIN_EXTENSION_TEMPLATES.find(item => item.id === "qwen-code");
    assert.deepEqual([qwen.command, qwen.args, qwen.defaultModels[0].slug], ["qwen", ["--acp"], "qwen3-coder-plus"]);
    assert.deepEqual(BUILTIN_EXTENSION_TEMPLATES.find(item => item.id === "gemini-cli").args, ["--acp"]);
  } finally { await manager.shutdownAll(); }
}));

test("six ACP providers complete the negotiated session through the engine manager", () => withProjectSandbox("v034-providers", async dir => {
  const cli = fixture(dir);
  const manager = createEngineManager();
  try {
    for (const provider of ["kimi-code", "gemini-cli", "opencode", "cursor", "goose", "qwen-code"]) {
      const handle = manager.runTurn({ provider, cwd: dir, nativeSessionId: "old", prompt: "test",
        providerConfig: cli.config(provider, "load"), resolveBinary: cli.binary(provider, "load") });
      const result = await handle.result;
      await handle.closed;
      assert.equal(result.status, "completed", provider);
      assert.equal(result.assistantText, "done", provider);
      const calls = cli.calls().filter(row => row.engine === provider);
      assert.deepEqual(calls.filter(row => /session\/(?:new|resume|load)/.test(row.method)).map(row => row.method), ["session/load"]);
    }
  } finally { await manager.shutdownAll(); }
}));

test("Claude coalesces asynchronous help probing and honors MCP opt-in", () => withProjectSandbox("v034-claude", async dir => {
  const cli = fixture(dir);
  const manager = createEngineManager();
  const resolveBinary = cli.binary("claude");
  const run = inheritHostMcp => manager.runTurn({ provider: "claude-code", cwd: dir, resolveBinary, inheritHostMcp });
  try {
    const handles = [run(), run(), run(true)];
    assert.deepEqual(cli.calls().filter(row => row.args?.includes("--help")), []);
    assert.ok((await Promise.all(handles.map(handle => handle.result))).every(result => result.status === "completed"));
    await Promise.all(handles.map(handle => handle.closed));
    const spawns = cli.calls().filter(row => row.method === "spawn");
    assert.equal(spawns.filter(row => row.args.includes("--help")).length, 1);
    assert.equal(spawns.filter(row => row.args.includes("--strict-mcp-config")).length, 2);
  } finally { await manager.shutdownAll(); }
}));

test("batch shims resolve %~dp0 for JavaScript and native executables", () => withProjectSandbox("v034-shims", dir => {
  const bin = path.join(dir, "bin folder");
  fs.mkdirSync(bin);
  const script = path.join(bin, "entry.mjs");
  fs.writeFileSync(script, "");
  const exe = path.join(bin, "entry.exe");
  fs.writeFileSync(exe, "", { mode: 0o755 });
  for (const [suffix, name, entry] of [["cmd", "entry.mjs", script], ["bat", "entry.exe", exe]]) {
    const wrapper = path.join(dir, "qwen." + suffix);
    fs.writeFileSync(wrapper, '@echo off\nif exist "%~dp0bin folder\\entry.exe" echo ready\n@"%~dp0bin folder\\' + name + '" %*\n', { mode: 0o755 });
    const resolved = resolveExternalCommand(wrapper, ["--acp"]);
    assert.equal(resolved.resolvedPath, entry);
    assert.deepEqual(resolved.args, suffix === "cmd" ? [script, "--acp"] : ["--acp"]);
  }
}));

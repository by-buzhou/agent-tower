import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DEFAULT_ROLE_PRESETS, inferProviderFromModel, isAllowedAgySubagentModel, loadProviderCatalogs, normalizeProviderId,
  probeAgyCatalog, resolveRoleTarget, splitAgyModelVariant } from "../../core/catalog.mjs";
import { runClaudeTurn } from "../../core/engines/claude-code.mjs";
import { runAgyTurn } from "../../core/engines/agy-acp.mjs";
import { buildAgyPinnedModelId, createEngineManager } from "../../core/engines/index.mjs";
import { spawnSupervised, within } from "../helpers/process.mjs";
import { withProjectSandbox, repoRoot } from "../helpers/sandbox.mjs";

function mockCli(dir, source, ...args) {
  const script = path.join(dir, `fixture-${args.join('-') || 'cli'}.mjs`);
  fs.writeFileSync(script, source);
  return () => ({ command: process.execPath, prefixArgs: [script, ...args], resolvedPath: script });
}

test("AGY routing is Gemini/Orchestrator-only; preset model is authoritative", () => {
  for (const alias of ["claude", "claude-code", "claude_code", "claudeagent", "claude-agent", "anthropic"]) {
    assert.equal(normalizeProviderId(alias), "claude-code");
  }
  for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-oss-120b-medium"]) {
    assert.equal(isAllowedAgySubagentModel(model), false);
    assert.throws(() => resolveRoleTarget({ target: { provider: "agy", model } }), { code: "UNSUPPORTED_AGY_MODEL" });
    assert.throws(() => createEngineManager().runTurn({ provider: "agy", model }), { code: "UNSUPPORTED_AGY_MODEL" });
  }
  assert.equal(inferProviderFromModel("gpt-oss-120b-medium", [{ id: "codex", models: ["gpt-oss-120b-medium"] }]), "");
  for (const model of ["gpt-oss-120b-medium", "unknown-model"])
    assert.throws(() => resolveRoleTarget({ target: { model } }), { code: "PROVIDER_REQUIRED" });
  assert.equal(inferProviderFromModel("claude-haiku-5-5"), "claude-code");
  assert.equal(inferProviderFromModel("Orchestrator (Neon)"), "antigravity");
  assert.equal(splitAgyModelVariant("Orchestrator (Neon)").model, "gemini-pro-orchestrator-neon");
  assert.equal(buildAgyPinnedModelId("Orchestrator (Neon)", "xhigh"), "gemini-pro-orchestrator-neon");
  assert.equal(Object.keys(DEFAULT_ROLE_PRESETS).length, 10);
  for (const [key, perm] of [["advisor_claude", "plan"], ["executor_claude", "bypassPermissions"]]) {
    const resolved = resolveRoleTarget({ presetKey: key });
    assert.deepEqual([resolved.provider, resolved.model, resolved.effort, resolved.permissionMode, resolved.routing.selectionSource],
      ["claude-code", "claude-opus-5-5", "xhigh", perm, "preset"]);
  }
  assert.equal(resolveRoleTarget({ role: "implementation" }).provider, "kimi-code");
  assert.equal(resolveRoleTarget({ role: "implementation", target: { provider: "codex" } }).model, "gpt-6.2-sol");
  assert.equal(resolveRoleTarget({ presetKey: "executor_codex" }).model, "gpt-6.2-sol");
  assert.equal(resolveRoleTarget({ presetKey: "executor_codex", target: { provider: "openai", model: " gpt-6.2-sol ", effort: "low" } }).effort, "low");
  assert.throws(() => resolveRoleTarget({ presetKey: "executor_codex", target: { model: "gpt-6.2-astra" } }), { code: "PRESET_TARGET_CONFLICT" });
  assert.equal(resolveRoleTarget({ target: { provider: "codex", model: "gpt-6.2-astra" } }).model, "gpt-6.2-astra");
});

const claudeFixture = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
const args = process.argv.slice(2);
const send = event => console.log(JSON.stringify({ session_id: 'claude-native', ...event }));
let started = false, prompt;
// --input-format stream-json: the first stdin line is the user frame; stdin stays open afterwards.
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type === 'control_request' && frame.request?.subtype === 'interrupt') {
    send({ type: 'result', subtype: 'error_during_execution', is_error: true });
    process.exit(0);
  }
  if (started || frame.type !== 'user') continue;
  started = true;
  prompt = frame.message.content[0].text;
  fs.writeFileSync('claude-args.json', JSON.stringify({ args, prompt, cwd: process.cwd() }));
  send({ type: 'system', subtype: 'init', model: 'alias' });
  send({ type: 'assistant', message: { model: 'claude-opus-effective', content: [
    { type: 'thinking', thinking: 'thinking' }, { type: 'text', text: 'answer' },
    { type: 'tool_use', id: 'tool-1', name: 'Edit', input: { file_path: 'x' } },
    { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'fixture' } },
  ] } });
  send({ type: 'user', message: { content: [
    { type: 'tool_result', tool_use_id: 'tool-1', content: 'done' },
    { type: 'tool_result', tool_use_id: 'tool-2', content: 'failed', is_error: true },
  ] } });
  if (prompt === 'hold') setInterval(() => {}, 1000);
  else send({ type: 'result', stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 4 } });
}
`;

test("Claude stream, permission, cwd, usage, resume and cancellation", () => withProjectSandbox("claude", async dir => {
  const resolveBinary = mockCli(dir, claudeFixture);
  const runTurn = opts => {
    const handle = runClaudeTurn(opts);
    return { result: within(handle.result, 5000, "Claude fixture").catch(async error => {
      await within(handle.forceKill(), 5000, "Claude cleanup");
      throw error;
    }) };
  };
  const events = [];
  const initial = await runTurn({ cwd: dir, model: "claude-opus-5-5", effort: "xhigh", permissionMode: "full-access", interactionMode: "plan",
    resolveBinary, prompt: "hello", onEvent: e => events.push(e) }).result;
  const readArgs = () => JSON.parse(fs.readFileSync(path.join(dir, "claude-args.json"), "utf8"));
  const streamArgs = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages"];
  assert.deepEqual(readArgs(), { cwd: dir, prompt: "hello", args: [...streamArgs, "--permission-mode", "plan", "--model", "claude-opus-5-5", "--effort", "xhigh"] });
  assert.equal(initial.nativeSessionId, "claude-native");
  assert.equal(initial.effectiveModel, "claude-opus-effective");
  assert.equal(initial.assistantText, "answer");
  assert.equal(initial.reasoningText, "thinking");
  assert.equal(initial.stopReason, "end_turn");
  assert.deepEqual(initial.usage, { inputTokens: 2, outputTokens: 3, cachedInputTokens: 4, totalTokens: 9 });
  assert.equal(events.filter(e => e.type === "session_bound").length, 1);
  assert.deepEqual(events.filter(e => e.type === "tool_call").map(e => [e.kind, e.status]),
    [["edit", "in_progress"], ["execute", "in_progress"], ["edit", "completed"], ["execute", "failed"]]);
  // `auto` stays Claude's classifier-reviewed auto mode; only explicit full-access aliases bypass approvals.
  for (const [permissionMode, cliMode] of [["plan", "plan"], ["full-access", "bypassPermissions"], ["auto", "auto"], ["yolo", "bypassPermissions"],
    ["danger-full-access", "bypassPermissions"], ["bypassPermissions", "bypassPermissions"], ["auto-accept-edits", "acceptEdits"],
    ["acceptEdits", "acceptEdits"], ["approval-required", "default"], ["on-request", "default"], ["always-proceed", "auto"],
    ["dontAsk", "dontAsk"], ["unknown-mode", "default"]]) {
    const turn = await runTurn({ cwd: dir, model: "inherit", effort: "inherit", permissionMode,
      nativeSessionId: initial.nativeSessionId, ephemeral: true, resolveBinary, prompt: "again" }).result;
    assert.equal(turn.status, "completed");
    assert.deepEqual(readArgs().args.slice(streamArgs.length), ["--permission-mode", cliMode,
      ...(cliMode === "default" ? ["--permission-prompts", "host"] : []), "--resume=claude-native", "--no-session-persistence"], permissionMode);
  }
  assert.throws(() => runClaudeTurn({ cwd: dir, permissionMode: "read-only", resolveBinary }), { code: "READ_ONLY_UNSUPPORTED" });
  for (const action of ["cancel", "forceKill"]) {
    let ready;
    const started = new Promise(resolve => { ready = resolve; });
    const handle = runClaudeTurn({ cwd: dir, resolveBinary, prompt: "hold", onEvent: e => { if (e.type === "session_bound") ready(); } });
    try {
      await within(started, 5000, "Claude fixture start");
      await within(handle[action](), 5000, "Claude fixture cancellation");
      assert.equal((await handle.result).status, "interrupted");
    } finally { await within(handle.forceKill(), 5000, "Claude cleanup"); }
  }
}));

const agyFixture = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
const [scenario, command] = process.argv.slice(2);
const neon = 'gemini-4-neon', orchestrator = 'Orchestrator (Neon)';
if (command === '--version') console.log('agy 1.6.3');
else if (command === 'models') console.log('| gemini-4-neon | Gemini 4 Neon |\n| Orchestrator (Neon) | Neon router |\n| gpt-oss-120b-medium | excluded |');
else for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  fs.appendFileSync(scenario + '.ndjson', JSON.stringify({ method, params }) + '\n');
  let result = {}, error;
  const options = [ { name: 'Google', options: [{ value: neon, name: 'Gemini 4 Neon' }, { value: orchestrator, name: 'Orchestrator (Neon)' }] }, { value: 'claude-opus-5-5' } ];
  const config = currentValue => [
    { id: 'model', currentValue, options },
    ...(scenario.startsWith('restore-default') ? [{ id: 'permission', category: 'mode', currentValue: 'accept-edits' }] : []),
    { id: 'thought_level', currentValue: 'high', options: [{ group: 'Levels', options: [{ value: 'high' }, { value: 'xhigh' }] }] },
  ];
  if (method === 'initialize') result = { protocolVersion: 1, agentInfo: { version: '1.6.2' } };
  if (method === 'session/new') {
    if (scenario === 'cli-only') error = { code: -32601, message: 'unsupported' };
    else result = { sessionId: 'agy-session', configOptions: config(scenario === 'inherit-claude' ? 'claude-opus-5-5' : neon) };
  }
  if (method === 'session/set_config_option' && params.configId === 'model') {
    if (scenario === 'reject') error = { code: -32602, message: 'model unavailable' };
    else result.configOptions = config(scenario === 'fallback' ? 'flash' : params.value);
  }
  if (method === 'session/set_config_option' && params.configId === 'permission' && scenario === 'restore-default-rejected') error = { code: -32602, message: 'refused' };
  if (method === 'session/prompt') result.stopReason = 'end_turn';
  if (id != null) console.log(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
}
`;
const calls = (dir, scenario) => fs.readFileSync(path.join(dir, scenario + ".ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));

test("agy discovery uses read-only CLI without ACP, then last successful cache and built-ins", () => withProjectSandbox("agy-catalog", async dir => {
  const live = await probeAgyCatalog({ resolveBinary: mockCli(dir, agyFixture, "discover"), cwd: dir });
  assert.deepEqual(live.models.map(m => [m.slug, m.efforts]), [["gemini-4-neon", ["low", "medium", "high", "xhigh"]], ["gemini-pro-orchestrator-neon", []]]);
  assert.equal(live.models[0].isDefault, false);
  assert.equal(live.version, "1.6.3");
  assert.equal(fs.existsSync(path.join(dir, "discover.ndjson")), false);
  const cli = await probeAgyCatalog({ resolveBinary: mockCli(dir, agyFixture, "cli-only"), cwd: dir });
  assert.deepEqual(cli.models.map(m => m.slug), ["gemini-4-neon", "gemini-pro-orchestrator-neon"]);
  assert.equal(cli.models[1].name, "Neon router");
  const agy = catalogs => catalogs.providers.find(p => p.id === "antigravity");
  const previousPath = process.env.PATH;
  // Do not let a real Codex/Kimi installation participate in this refresh test.
  process.env.PATH = path.dirname(process.execPath);
  try {
    let provider = agy(await loadProviderCatalogs({ cacheDir: dir, refresh: true, agyProbe: async () => live }));
    assert.equal(provider.catalogSource, "agy-live");
    assert.equal(provider.probedAt, live.probedAt);
    assert.deepEqual(provider.models[1].optionDescriptors, []);
    const cache = path.join(dir, "agy-catalog-cache.json");
    assert.ok(fs.existsSync(cache));
    provider = agy(await loadProviderCatalogs({ cacheDir: dir, refresh: true, agyProbe: async () => ({ models: [{ slug: "gemini-4-carbon" }], probedAt: 1, version: "1.5.9" }) }));
    assert.ok(provider.models.some(m => m.slug === "gemini-4-neon"));
    assert.ok(provider.models.some(m => m.slug === "gemini-pro-orchestrator-neon"));
    fs.writeFileSync(cache, JSON.stringify(live));
    provider = agy(await loadProviderCatalogs({ cacheDir: dir, refresh: true, agyProbe: async () => { throw Error("unavailable"); } }));
    assert.equal(provider.catalogSource, "agy-cache");
    assert.equal(provider.version, live.version);
    fs.writeFileSync(cache, JSON.stringify({ models: [{ slug: "claude-opus-5-5" }, { slug: "gpt-oss-120b-medium" }] }));
    provider = agy(await loadProviderCatalogs({ cacheDir: dir }));
    assert.equal(provider.catalogSource, "builtin");
    assert.ok(provider.models.every(m => isAllowedAgySubagentModel(m.slug)));
    assert.ok(provider.models.some(m => m.slug === "gemini-pro-orchestrator-neon"));
  } finally { process.env.PATH = previousPath; }
}));

test("agy rejects missing, rejected, downgraded and non-admitted default models before any prompt", () => withProjectSandbox("agy-strict", async dir => {
  for (const [scenario, model, code] of [["missing", "gemini-4-unknown", "MODEL_UNAVAILABLE"], ["reject", "gemini-4-neon", "MODEL_UNAVAILABLE"],
    ["fallback", "gemini-4-neon", "MODEL_UNAVAILABLE"], ["inherit-claude", "inherit", "UNSUPPORTED_AGY_MODEL"]]) {
    const events = [];
    const result = await runAgyTurn({ model, cwd: dir, resolveBinary: mockCli(dir, agyFixture, scenario),
      prompt: "never sent", onEvent: event => events.push(event) }).result;
    assert.equal(result.status, "failed");
    assert.equal(result.code, code);
    assert.equal(calls(dir, scenario).filter(o => o.method === "session/prompt").length, 0);
    assert.ok(calls(dir, scenario).some(o => o.method === "session/close"));
    assert.ok(!events.some(event => event.type === "effective_model"));
  }
  const events = [];
  const result = await runAgyTurn({ model: "Orchestrator (Neon)", cwd: dir, effort: "xhigh", resolveBinary: mockCli(dir, agyFixture, "ok"),
    prompt: "only after model validation", onEvent: event => events.push(event) }).result;
  assert.equal(result.status, "completed");
  assert.ok(events.some(e => e.type === "effective_model" && e.effectiveModel === "gemini-pro-orchestrator-neon"));
  assert.deepEqual(calls(dir, "ok").filter(o => o.method === "session/set_config_option").map(o => o.params.configId), ["model", "mode"]);
  assert.equal(calls(dir, "ok").filter(o => o.method === "session/prompt").length, 1);
}));

test("AGY restores the requested default mode before sending a prompt", () => withProjectSandbox("agy-mode-restore", async dir => {
  for (const scenario of ["restore-default", "restore-default-rejected"]) {
    const result = await runAgyTurn({ model: "gemini-4-neon", permissionMode: "default", cwd: dir,
      resolveBinary: mockCli(dir, agyFixture, scenario), prompt: "only in default mode" }).result;
    const requests = calls(dir, scenario);
    assert.ok(requests.some(r => r.method === "session/set_config_option" && r.params.configId === "permission" && r.params.value === "default"));
    assert.equal(result.status, scenario.endsWith("rejected") ? "failed" : "completed");
    assert.equal(requests.filter(r => r.method === "session/prompt").length, scenario.endsWith("rejected") ? 0 : 1);
  }
}));

test("git ignores .env variants but not .env.example", () => withProjectSandbox("git-ignore", cwd => {
  execFileSync("git", ["init", "-q"], { cwd });
  fs.copyFileSync(path.join(repoRoot, ".gitignore"), path.join(cwd, ".gitignore"));
  const checkIgnore = file => execFileSync("git", ["--no-optional-locks", "check-ignore", "--no-index", file], { cwd, stdio: "pipe", timeout: 5000 });
  assert.throws(() => checkIgnore(".env.example"), error => error.status === 1);
  assert.match(String(checkIgnore(".env.local")), /\.env\.local/);
}));


test("supervised timeout reaps a hung fixture process", () => withProjectSandbox("process-deadline", async cwd => {
  const child = spawnSupervised(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd, stdio: "ignore", timeoutMs: 300,
  });
  try {
    const result = await within(child.closed, 5000, "hung fixture cleanup");
    assert.equal(result.timeout, true);
    assert.throws(() => process.kill(child.proc.pid, 0), { code: "ESRCH" });
  } finally { await child.stop(); }
}));

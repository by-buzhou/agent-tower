import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildClaudeArgs, resolveClaudePermissionMode, runClaudeTurn } from "../../core/engines/claude-code.mjs";
import { resolveCodexSandboxAndApproval, runCodexTurn } from "../../core/engines/codex-driver.mjs";
import { resolveKimiAcpMode, runKimiTurn } from "../../core/engines/kimi-acp.mjs";
import { resolveAgyModeAndFlags } from "../../core/engines/agy-acp.mjs";
import { mapGenericModeFromPermission, normalizeGenericPermission, runGenericAcpTurn } from "../../core/engines/generic-acp.mjs";
import { isMissingSessionError } from "../../core/engines/proc-utils.mjs";
import { within } from "../helpers/process.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";

function mockCli(dir, name, source, ...args) {
  const script = path.join(dir, `${name}.mjs`);
  fs.writeFileSync(script, source);
  return () => ({ command: process.execPath, prefixArgs: [script, ...args], resolvedPath: script });
}

// Bidirectional stream-json Claude fixture: records every stdin frame and exits only on stdin EOF.
const claudeFixture = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
if (process.argv.includes('--help')) process.exit(0);
const scenario = process.argv[2];
const send = event => console.log(JSON.stringify({ session_id: 'claude-s', ...event }));
const log = frame => fs.appendFileSync(scenario + '-stdin.ndjson', JSON.stringify(frame) + '\n');
const result = () => send({ type: 'result', stop_reason: 'end_turn', result: 'final', usage: { input_tokens: 1, output_tokens: 1 } });
let users = 0, controls = 0;
const rl = readline.createInterface({ input: process.stdin });
rl.on('close', () => { fs.writeFileSync(scenario + '-stdin-closed', 'yes'); process.exit(0); });
for await (const line of rl) {
  const frame = JSON.parse(line);
  log(frame);
  if (frame.type === 'user') {
    users++;
    if (users === 1) {
      send({ type: 'system', subtype: 'init', model: 'claude-opus-5-5' });
      if (scenario === 'permission') {
        send({ type: 'control_request', request_id: 'req-allow', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, tool_use_id: 'tu-1' } });
        send({ type: 'control_request', request_id: 'req-deny', request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a.txt', content: 'x' } } });
        send({ type: 'control_request', request_id: 'req-hook', request: { subtype: 'hook_callback' } });
      } else if (scenario === 'withdraw') {
        send({ type: 'control_request', request_id: 'withdraw-me', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
        setTimeout(() => send({ type: 'control_cancel_request', request_id: 'withdraw-me' }), 80);
      } else if (scenario === 'unknown-decision') {
        send({ type: 'control_request', request_id: 'unknown-decision', request: { subtype: 'can_use_tool', tool_name: 'Write', input: {} } });
      } else if (scenario === 'question') {
        send({ type: 'control_request', request_id: 'req-q', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion',
          input: { questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] } } });
      } else if (scenario === 'stream') {
        const ev = event => send({ type: 'stream_event', event });
        ev({ type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-5-5' } });
        ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'thi' } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'nk' } });
        ev({ type: 'content_block_stop', index: 0 });
        ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hel' } });
        ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'lo' } });
        ev({ type: 'content_block_stop', index: 1 });
        ev({ type: 'message_stop' });
        // Claude Code may split one message into one assistant event per block (same message id).
        send({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: 'think' }] } });
        send({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: '' }] } });
        ev({ type: 'message_start', message: { id: 'no-id-partials' } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '-' } });
        send({ type: 'assistant', parent_tool_use_id: 'tool-s', message: { id: 'msg_1', content: [{ type: 'text', text: 'Helper' }] } });
        send({ type: 'assistant', message: { id: 'msg_1', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Hello' },
          { type: 'tool_use', id: 'tool-s', name: 'Read', input: { file_path: 'x' } }] } });
        // A later, non-streamed message must still be emitted in full.
        send({ type: 'assistant', message: { id: 'msg_2', model: 'claude-opus-5-5', content: [{ type: 'text', text: ' World' }] } });
        result();
      } else if (scenario === 'steer') {
        send({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'working' }] } });
      } else result();
    } else if (scenario === 'withdraw') result();
    else if (scenario === 'steer') {
      send({ type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: ' steered:' + frame.message.content[0].text }] } });
      result();
    }
  } else if (frame.type === 'control_response') {
    controls++;
    if ((scenario === 'permission' && controls === 3) || (['question', 'unknown-decision'].includes(scenario) && controls === 1)) result();
  }
}
`;

const frames = (dir, scenario) => fs.readFileSync(path.join(dir, scenario + "-stdin.ndjson"), "utf8").trim().split("\n").map(l => JSON.parse(l));

function startClaude(dir, scenario, opts = {}) {
  const events = [];
  const handle = runClaudeTurn({ cwd: dir, resolveBinary: mockCli(dir, "claude-v003", claudeFixture, scenario), prompt: "go",
    permissionMode: "approval-required", onEvent: e => events.push(e), ...opts });
  const result = within(handle.result, 8000, `Claude ${scenario}`).catch(async error => {
    await within(handle.forceKill(), 5000, "Claude cleanup");
    throw error;
  });
  return { handle, events, result };
}

test("Claude permission ladder never escalates and default mode routes prompts to the panel", () => {
  assert.equal(resolveClaudePermissionMode("auto"), "auto");
  assert.equal(resolveClaudePermissionMode("full-access"), "bypassPermissions");
  assert.equal(resolveClaudePermissionMode("always-proceed"), "auto");
  assert.equal(resolveClaudePermissionMode("approval-required"), "default");
  assert.equal(resolveClaudePermissionMode("auto", "plan"), "plan");
  assert.equal(resolveClaudePermissionMode(undefined), "default");
  assert.throws(() => resolveClaudePermissionMode("read-only"), { code: "READ_ONLY_UNSUPPORTED" });
  assert.deepEqual(buildClaudeArgs({ mode: "default", model: "claude-opus-5-5", effort: "high", nativeSessionId: "s", ephemeral: true }),
    ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-mode", "default", "--permission-prompts", "host", "--model", "claude-opus-5-5", "--effort", "high",
      "--resume=s", "--no-session-persistence"]);
  assert.ok(!buildClaudeArgs({ mode: "auto" }).includes("--permission-prompts"));
});

test("Claude can_use_tool approvals round-trip over stdin and stdin closes after result", () => withProjectSandbox("claude-approval", async dir => {
  const requests = [];
  let handle;
  const run = startClaude(dir, "permission", {
    onPermissionRequest: req => {
      requests.push(req);
      if (req.toolName === "Bash") void handle.respondPermission(req.requestId, { decision: "approve_once" });
      else void handle.respondPermission(req.requestId, { decision: "reject", feedback: "not now" });
    },
  });
  handle = run.handle;
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.deepEqual(requests.map(r => [r.provider, r.toolName, r.title]), [["claude-code", "Bash", "允许执行 Bash"], ["claude-code", "Write", "允许执行 Write"]]);
  assert.equal(requests[0].command, "npm test");
  assert.deepEqual(requests[1].filePaths, ["a.txt"]);
  assert.notEqual(requests[0].requestId, "req-allow", "panel ids are unique per run");
  const responses = frames(dir, "permission").filter(f => f.type === "control_response").map(f => f.response);
  assert.deepEqual(responses.find(r => r.request_id === "req-allow"),
    { subtype: "success", request_id: "req-allow", response: { behavior: "allow", updatedInput: { command: "npm test" } } });
  assert.deepEqual(responses.find(r => r.request_id === "req-deny"),
    { subtype: "success", request_id: "req-deny", response: { behavior: "deny", message: "not now", interrupt: false } });
  assert.equal(responses.find(r => r.request_id === "req-hook").subtype, "error");
  const first = frames(dir, "permission")[0];
  assert.deepEqual(first, { type: "user", message: { role: "user", content: [{ type: "text", text: "go" }] } });
  assert.equal(fs.readFileSync(path.join(dir, "permission-stdin-closed"), "utf8"), "yes");
  assert.deepEqual(await handle.steer("late"), { supported: false });
}));

test("Claude AskUserQuestion answers are written back as updatedInput.answers", () => withProjectSandbox("claude-question", async dir => {
  const asked = [];
  let handle;
  const run = startClaude(dir, "question", {
    onQuestionRequest: req => { asked.push(req); void handle.respondQuestion(req.requestId, { "Which?": "A" }); },
  });
  handle = run.handle;
  assert.equal((await run.result).status, "completed");
  assert.equal(asked[0].title, "Claude 提问");
  assert.equal(asked[0].questions[0].question, "Which?");
  const response = frames(dir, "question").find(f => f.type === "control_response").response;
  assert.equal(response.response.behavior, "allow");
  assert.deepEqual(response.response.updatedInput.answers, { "Which?": "A" });
  assert.equal(response.response.updatedInput.questions[0].header, "Pick");
}));

test("Claude live steer writes a user frame mid-turn", () => withProjectSandbox("claude-steer", async dir => {
  let ready;
  const working = new Promise(resolve => { ready = resolve; });
  const run = startClaude(dir, "steer", { permissionMode: "auto", onEvent: e => { if (e.type === "message_delta") ready(); } });
  await within(working, 5000, "Claude steer start");
  assert.deepEqual(await run.handle.steer("fix it"), { supported: true });
  const result = await run.result;
  assert.equal(result.status, "completed");
  assert.equal(result.assistantText, "working steered:fix it");
  const users = frames(dir, "steer").filter(f => f.type === "user");
  assert.deepEqual(users[1], { type: "user", message: { role: "user", content: [{ type: "text", text: "fix it" }] } });
}));

test("Claude partial-message deltas are not duplicated by the final assistant blocks", () => withProjectSandbox("claude-stream", async dir => {
  const run = startClaude(dir, "stream", { permissionMode: "auto" });
  const result = await run.result;
  assert.equal(result.assistantText, "Hello-Helper World");
  assert.equal(result.reasoningText, "think");
  assert.equal(run.events.filter(e => e.type === "message_delta").map(e => e.delta).join(""), "Hello-Helper World");
  assert.equal(run.events.filter(e => e.type === "reasoning_delta").map(e => e.delta).join(""), "think");
  assert.deepEqual(run.events.filter(e => e.type === "tool_call").map(e => [e.toolCallId, e.kind]), [["tool-s", "read"]]);
}));

test("Engine-native mode mapping keeps legacy values and never unlocks skip-all from foreign aliases", () => {
  assert.deepEqual(resolveCodexSandboxAndApproval("read-only"), { sandbox: "read-only", approvalPolicy: "never" });
  assert.deepEqual(resolveCodexSandboxAndApproval("full-access", "plan"), { sandbox: "read-only", approvalPolicy: "never" });
  assert.deepEqual(resolveCodexSandboxAndApproval("approval-required"), { sandbox: "workspace-write", approvalPolicy: "on-request" });
  assert.deepEqual(resolveCodexSandboxAndApproval("auto-accept-edits"), { sandbox: "workspace-write", approvalPolicy: "on-request" });
  assert.deepEqual(resolveCodexSandboxAndApproval("auto"),
    { sandbox: "workspace-write", approvalPolicy: "on-request", approvalsReviewer: "auto_review" });
  assert.deepEqual(resolveCodexSandboxAndApproval("full-access"), { sandbox: "danger-full-access", approvalPolicy: "never" });
  assert.deepEqual(resolveCodexSandboxAndApproval("bypassPermissions").sandbox, "workspace-write");

  assert.equal(resolveKimiAcpMode("plan"), "plan");
  assert.equal(resolveKimiAcpMode("auto", "plan"), "plan");
  assert.equal(resolveKimiAcpMode("approval-required"), "default");
  assert.equal(resolveKimiAcpMode("auto"), "auto");
  assert.equal(resolveKimiAcpMode("yolo"), "yolo");
  assert.equal(resolveKimiAcpMode("full-access"), "yolo");
  assert.equal(resolveKimiAcpMode("bypassPermissions"), "auto");

  assert.deepEqual(resolveAgyModeAndFlags("auto"), { acpMode: "accept-edits", skipPermissionsFlag: false });
  assert.deepEqual(resolveAgyModeAndFlags("accept-edits"), { acpMode: "accept-edits", skipPermissionsFlag: false });
  assert.deepEqual(resolveAgyModeAndFlags("default"), { acpMode: "default", skipPermissionsFlag: false });
  assert.deepEqual(resolveAgyModeAndFlags("plan"), { acpMode: "plan", skipPermissionsFlag: false });
  for (const skip of ["always-proceed", "full-access", "yolo", "danger-full-access"])
    assert.deepEqual(resolveAgyModeAndFlags(skip), { acpMode: "accept-edits", skipPermissionsFlag: true }, skip);
  assert.equal(resolveAgyModeAndFlags("bypassPermissions").skipPermissionsFlag, false);

  assert.equal(normalizeGenericPermission("opencode", "bypassPermissions"), "auto");
  assert.equal(normalizeGenericPermission("opencode", "yolo"), "full-access");
  assert.equal(mapGenericModeFromPermission("auto", "default", ["default", "yolo"]), "default");
  assert.equal(mapGenericModeFromPermission("default", "default", ["yolo"]), undefined);
  assert.equal(mapGenericModeFromPermission("full-access", "default", ["default", "yolo"]), "yolo");
});

test("missing-session detection separates gone sessions from transient failures", () => {
  for (const message of ["Session not found: abc", "session abc does not exist", "Unknown session id", "No such session", "no rollout found for thread id abc"])
    assert.equal(isMissingSessionError(new Error(message)), true, message);
  for (const message of ["RPC timeout (15000ms) waiting for session/resume", "Engine process exited (code=1, signal=null)", "Internal error",
    "HTTP 429 rate limit", "authentication required", "Engine network or transport request failed",
    "Resource not found", "Failed to load session; profile could not be read", "Cannot resume thread: already has an active writer"])
    assert.equal(isMissingSessionError(new Error(message)), false, message);
});

const acpFixture = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
const [scenario] = process.argv.slice(2);
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { id, method } = JSON.parse(line);
  fs.appendFileSync(scenario + '.ndjson', JSON.stringify({ method }) + '\n');
  let result = {}, error;
  if (method === 'initialize') result = { protocolVersion: 1 };
  if (method === 'session/resume') {
    if (scenario.endsWith('missing')) error = { code: -32603, message: 'Session not found: old-session' };
    else if (scenario.endsWith('transient')) error = { code: -32603, message: 'Internal error' };
    else if (scenario.endsWith('unsafe-mode')) result = { modes: { currentModeId: 'yolo', availableModes: [{ id: 'yolo', name: 'Unrestricted' }] } };
    else if (scenario.endsWith('load') || scenario.endsWith('unsupported')) error = { code: -32601, message: 'Method not found' };
    else result = { configOptions: [] };
  }
  if (method === 'session/load') {
    if (scenario.endsWith('unsupported')) error = { code: -32601, message: 'Method not found' };
    else result = { configOptions: [] };
  }
  if (method === 'session/new') result = { sessionId: 'new-session', configOptions: [] };
  if (method === 'session/prompt') result = { stopReason: 'end_turn' };
  if (id != null) console.log(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }));
}
`;
const acpCalls = (dir, scenario) => fs.readFileSync(path.join(dir, scenario + ".ndjson"), "utf8").trim().split("\n").map(l => JSON.parse(l).method);

test("Kimi and generic ACP resume only fork a new session when the old one is gone", () => withProjectSandbox("acp-resume", async dir => {
  const script = path.join(dir, "acp-fixture.mjs");
  fs.writeFileSync(script, acpFixture);
  const kimi = scenario => within(runKimiTurn({ cwd: dir, nativeSessionId: "old-session", prompt: "hi", permissionMode: "auto",
    resolveBinary: () => ({ command: process.execPath, prefixArgs: [script, scenario] }) }).result, 8000, `kimi ${scenario}`);
  const generic = scenario => within(runGenericAcpTurn({ cwd: dir, provider: "custom-acp", nativeSessionId: "old-session", prompt: "hi",
    providerConfig: { command: script, args: [scenario] } }).result, 8000, `generic ${scenario}`);

  let res = await kimi("kimi-missing");
  assert.equal(res.status, "completed");
  assert.equal(res.nativeSessionId, "new-session");
  assert.ok(acpCalls(dir, "kimi-missing").includes("session/new"));

  res = await kimi("kimi-transient");
  assert.equal(res.status, "failed");
  assert.equal(res.nativeSessionId, "old-session");
  assert.ok(!acpCalls(dir, "kimi-transient").includes("session/new"));
  assert.ok(!acpCalls(dir, "kimi-transient").includes("session/prompt"));

  res = await kimi("kimi-ok");
  assert.equal(res.status, "completed");
  assert.equal(res.nativeSessionId, "old-session");

  res = await generic("generic-load");
  assert.equal(res.status, "completed");
  assert.equal(res.nativeSessionId, "old-session");
  assert.deepEqual(acpCalls(dir, "generic-load").filter(m => m.startsWith("session/") && m !== "session/set_mode" && m !== "session/set_config_option").slice(0, 2),
    ["session/resume", "session/load"]);
  assert.ok(!acpCalls(dir, "generic-load").includes("session/new"));

  res = await generic("generic-unsafe-mode");
  assert.equal(res.status, "failed");
  assert.ok(!acpCalls(dir, "generic-unsafe-mode").includes("session/prompt"));

  res = await generic("generic-unsupported");
  assert.equal(res.status, "failed");
  assert.equal(res.nativeSessionId, "old-session");
  assert.ok(!acpCalls(dir, "generic-unsupported").includes("session/new"));

  res = await generic("generic-transient");
  assert.equal(res.status, "failed");
  assert.equal(res.nativeSessionId, "old-session");
  assert.ok(!acpCalls(dir, "generic-transient").includes("session/new"));

  res = await generic("generic-missing");
  assert.equal(res.status, "completed");
  assert.equal(res.nativeSessionId, "new-session");
}));


test("Claude withdrawn approvals settle locally without writing stale replies; unknown decisions deny", () => withProjectSandbox("claude-withdraw", async dir => {
  let request, notify;
  const withdrawal = new Promise(resolve => { notify = resolve; });
  const run = startClaude(dir, "withdraw", {
    onPermissionRequest: req => { request = req; },
    onEvent: evt => { if (evt.type === "runtime_request_cancelled") notify(evt); },
  });
  try {
    const evt = await within(withdrawal, 3000, "Claude approval withdrawal");
    assert.equal(evt.requestId, request.requestId);
    assert.equal(await run.handle.respondPermission(request.requestId, "approve_once"), false);
    assert.deepEqual(await run.handle.steer("finish"), { supported: true });
    assert.equal((await within(run.handle.result, 3000, "finish withdrawn approval")).status, "completed");
    assert.ok(!frames(dir, "withdraw").some(f => f.type === "control_response"));
  } finally { await run.handle.cancel(); }
  const unknown = startClaude(dir, "unknown-decision", { onPermissionRequest: () => "unrecognized" });
  try {
    await within(unknown.handle.result, 3000, "deny unknown Claude decision");
    assert.equal(frames(dir, "unknown-decision").find(f => f.type === "control_response").response.response.behavior, "deny");
  } finally { await unknown.handle.cancel(); }
}));

test("Codex active writer keeps the existing session and returns an explicit recovery hint", () => withProjectSandbox("codex-active-writer", async dir => {
  const fixture = String.raw`
import fs from 'node:fs';
import readline from 'node:readline';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const { method, id } = JSON.parse(line);
  fs.appendFileSync('calls.ndjson', method + '\n');
  if (id == null) continue;
  const body = method === 'thread/resume' ? { error: { code: -32603, message: 'thread old already has an active writer' } } : { result: {} };
  console.log(JSON.stringify({ jsonrpc: '2.0', id, ...body }));
}`;
  const handle = runCodexTurn({ cwd: dir, nativeSessionId: "old", prompt: "continue",
    resolveBinary: mockCli(dir, "codex-busy", fixture) });
  try {
    const result = await within(handle.result, 5000, "Codex refuses active writer");
    assert.equal(result.status, "failed");
    assert.equal(result.nativeSessionId, "old");
    assert.equal(result.code, "CODEX_ACTIVE_WRITER");
    assert.doesNotMatch(fs.readFileSync(path.join(dir, "calls.ndjson"), "utf8"), /thread\/start/);
  } finally { await handle.cancel(); }
}));

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";
import { check } from "../../scripts/check.mjs";
import { getCatalogConfigFingerprint, resetCatalogFingerprintCache } from "../../core/catalog.mjs";
import { resolveConversationRoot } from "../../core/engines/agy-native.mjs";
import { buildClaudeArgs, runClaudeTurn, supportsStrictMcpFlag } from "../../core/engines/claude-code.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { collectReviewGitSnapshot } from "../../core/worktree.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { spawnSupervised, within } from "../helpers/process.mjs";
import { repoRoot, runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

function commit(cwd, message) {
  git(cwd, "-c", "user.name=AgentTower Test", "-c", "user.email=test@invalid.local", "commit", "-m", message);
}

function openTower(dir, cwd) {
  const tower = createOrchestrator({
    dataDir: path.join(dir, "control"),
    defaultStudioRoot: cwd,
    catalogLoader: offlineCatalog,
    recoverStaleState: false,
  });
  tower.db.saveSettings({ defaultOrchestrationMode: "complex" });
  return tower;
}

async function runNode(args, input, env) {
  const child = spawnSupervised(process.execPath, args, {
    cwd: repoRoot,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    timeoutMs: 8000,
  });
  try {
    let stdout = "";
    let stderr = "";
    child.proc.stdout.setEncoding("utf8").on("data", text => { stdout += text; });
    child.proc.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    child.proc.stdin.on("error", () => {});
    child.proc.stdin.end(input);
    const result = await within(child.closed, 10_000, "v0.2.10 child process");
    if (result.spawnError) throw result.spawnError;
    assert.equal(result.timeout, false);
    assert.equal(result.code, 0, stderr);
    return JSON.parse(stdout);
  } finally {
    await child.stop();
  }
}

test("C06 无实验标志批量 check 校验 ESM/CJS 并保留语法错误位置", () => withProjectSandbox("v0210-check", async dir => {
  write(dir, "package.json", JSON.stringify({ type: "commonjs" }));
  write(dir, "valid.mjs", "export const answer = 42;\n");
  write(dir, "preload.js", "module.exports = { loaded: true };\n");
  assert.equal(check(dir), 2);
  const broken = write(dir, "broken.mjs", "const = ;\n");
  assert.throws(() => check(dir), error => {
    assert.match(error.message, /broken\.mjs/);
    assert.match(error.message, /broken\.mjs:1|1:7|1:6/);
    return true;
  });
  assert.ok(fs.existsSync(broken));
}));

test("C07/C11 评审快照不污染原任务，默认新会话、显式续聊、finalReport 与 timings 完整", () => withProjectSandbox("v0210-review", async dir => {
  const cwd = project(dir, "review");
  write(cwd, "src/base.mjs", "export const base = 1;\n");
  git(cwd, "add", "src/base.mjs");
  commit(cwd, "base");
  git(cwd, "checkout", "-b", "topic");
  write(cwd, "src/committed.mjs", "export const committed = true;\n");
  git(cwd, "add", "src/committed.mjs");
  commit(cwd, "topic");
  write(cwd, "src/base.mjs", "export const base = 2;\n");
  write(cwd, "src/staged.mjs", "export const staged = true;\n");
  git(cwd, "add", "src/staged.mjs");
  write(cwd, "src/untracked.mjs", "export const untracked = true;\n");

  // The index and working tree each changed even though the net diff against HEAD is empty.
  git(cwd, "add", "src/base.mjs");
  write(cwd, "src/base.mjs", "export const base = 1;\n");
  const uncommitted = await collectReviewGitSnapshot({ cwd });
  assert.deepEqual(uncommitted.changedPaths.filter(file => file.startsWith("src/")),
    ["src/base.mjs", "src/staged.mjs", "src/untracked.mjs"]);
  assert.match(uncommitted.summaryBlock, /src\/untracked\.mjs/);
  assert.deepEqual((await collectReviewGitSnapshot({ cwd, scope: "branch", baseBranch: "main" })).changedPaths,
    ["src/committed.mjs"]);
  assert.deepEqual((await collectReviewGitSnapshot({ cwd, scope: "commit", commitSha: "HEAD" })).changedPaths,
    ["src/committed.mjs"]);
  assert.deepEqual(await collectReviewGitSnapshot({ cwd: path.join(dir, "not-a-repo") }), { changedPaths: [], summaryBlock: "" });

  assert.doesNotMatch((await collectReviewGitSnapshot({ cwd, scope: "branch", baseBranch: "main" })).summaryBlock, /untracked/);
  const crowded = project(dir, "crowded");
  for (let index = 0; index < 90; index++) write(crowded, `src/${String(index).padStart(3, "0")}-${"long-name-".repeat(8)}.mjs`, "export {};\n");
  const capped = await collectReviewGitSnapshot({ cwd: crowded });
  assert.ok(Buffer.byteLength(`\n\n<agent_tower_review_files>\n${capped.summaryBlock}\n</agent_tower_review_files>`, "utf8") <= 2048);
  assert.match(capped.summaryBlock, /省略 \d+ 个文件/);
  assert.equal(capped.changedPaths.length, 90);

  const tower = openTower(dir, cwd);
  tower.db.saveSettings({ defaultExternalSessionVisible: true });
  const calls = [];
  const longReport = `终审结论：${"完整结果".repeat(2100)}`;
  try {
    tower.engineManager.runTurn = options => {
      calls.push(options);
      const nativeSessionId = options.nativeSessionId || `fresh-${calls.length}`;
      options.onEvent({ type: "session_bound", nativeSessionId, resumed: Boolean(options.nativeSessionId) });
      options.onEvent({ type: "message_delta", delta: "interim" });
      return { result: Promise.resolve({ status: "completed", assistantText: longReport, nativeSessionId }) };
    };
    const first = await tower.runCodeReview({ cwd, conversationId: "review-root", readOnly: true, prompt: "review this", wait: true });
    assert.match(calls[0].prompt, /<agent_tower_review_files>/);
    assert.match(calls[0].prompt, /src\/untracked\.mjs/);
    assert.equal(tower.db.getRun(first.runId).prompt, "review this");
    assert.equal(tower.db.listTurnItems({ threadId: first.threadId, runId: first.runId }).find(item => item.type === "user_message").text, "review this");
    assert.deepEqual(tower.db.getRun(first.runId).meta.reviewSpec.changedPaths.filter(file => file.startsWith("src/")),
      ["src/base.mjs", "src/staged.mjs", "src/untracked.mjs"]);
    assert.equal(first.finalReport.length, 8000);
    assert.equal(first.finalReportTruncated, true);
    assert.equal(first.finalReportTotalLength, longReport.length);
    assert.ok(first.itemId);
    const page = await tower.readThread({ threadId: first.threadId, itemId: first.itemId, textOffset: 8000 });
    assert.equal(first.finalReport + page.item.text, longReport);
    assert.equal(first.nextTextOffset, 8000);

    const second = await tower.runCodeReview({ cwd, conversationId: "review-root", readOnly: true, prompt: "fresh review", wait: true });
    assert.equal(second.threadId, first.threadId);
    assert.equal(calls[1].nativeSessionId, undefined, "新终审工单不得续用旧原生会话");
    const third = await tower.runCodeReview({ cwd, conversationId: "review-root", readOnly: true, prompt: "continue", continueSession: true, wait: true });
    assert.equal(calls[2].nativeSessionId, "fresh-2");
    assert.equal(third.threadId, first.threadId);
    const fourth = await tower.runCodeReview({ cwd, conversationId: "review-root", readOnly: true, prompt: "no report", includeReport: false, wait: true });
    assert.equal("finalReport" in fourth, false);
    assert.equal(typeof fourth.reviewText, "string");

    const timings = tower.db.getRun(third.runId).meta.timings;
    for (const key of ["queueWaitMs", "prepMs", "spawnMs", "sessionBoundMs", "firstEventMs", "firstTextMs", "totalMs",
      "planBytes", "specBytes", "effectivePromptBytes", "specInlineCount", "reusedSession"]) {
      assert.equal(typeof timings[key], "number", key);
      assert.ok(Number.isFinite(timings[key]), key);
    }
    assert.equal(timings.reusedSession, 1);
    assert.equal(tower.db.getRun(first.runId).meta.timings.reusedSession, 0);
    assert.ok(timings.effectivePromptBytes > 0);
    assert.equal(timings.transport, "stdin");
    assert.ok(tower.db.getRun(third.runId).meta.injectedSpecs);

    write(cwd, "src/new-after-review.mjs", "export {};\n");
    await tower.retryRun({ threadId: fourth.threadId, runId: fourth.runId, wait: true });
    assert.match(calls.at(-1).prompt, /src\/new-after-review\.mjs/);

    let nativePrompt = "";
    tower.engineManager.runReview = options => {
      nativePrompt = String(options.prompt);
      return { result: Promise.resolve({ status: "completed", reviewText: longReport, findings: [] }) };
    };
    const native = await tower.runCodeReview({ cwd, conversationId: "review-native", readOnly: true, reviewMode: "ephemeral", wait: true });
    assert.match(nativePrompt, /<agent_tower_review_files>/);
    assert.equal(native.reviewText, longReport);
    assert.ok(native.itemId);
    const rest = await tower.readThread({ threadId: native.threadId, itemId: native.itemId, textOffset: native.nextTextOffset });
    assert.equal(native.finalReport + rest.item.text, longReport);
  } finally {
    await tower.shutdown();
  }
}));

test("C08 Hook 仅离线懒加载，未核验 healthz 前绝不发送 Daemon 令牌", () => withProjectSandbox("v0210-hook", async dir => {
  const hookPath = path.join(repoRoot, "core", "hooks", "pre-tool-gate.mjs");
  const source = fs.readFileSync(hookPath, "utf8");
  const staticImports = source.match(/^import[\s\S]*?from\s+['"][^'"]+['"];?$/gm) || [];
  for (const forbidden of ["node:sqlite", "../engines/agy-native.mjs", "../catalog.mjs"]) {
    assert.ok(!staticImports.some(line => line.includes(forbidden)), forbidden);
    assert.ok(source.includes(`import('${forbidden}')`), `${forbidden} 应动态懒加载`);
  }
  assert.match(source, /verifyDaemonLeaseOwner\(lease, 500\)/);

  const control = path.join(dir, "control");
  fs.mkdirSync(control, { recursive: true });
  const observed = [];
  const server = http.createServer((request, response) => {
    observed.push([request.url, request.headers["x-daemon-token"]]);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, pid: -1, startedAt: -1, version: "0.0.0" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    write(control, "daemon-lease.json", JSON.stringify({
      host: "127.0.0.1", port: server.address().port, token: "must-not-leak", pid: process.pid, startedAt: 1,
    }));
    const before = fs.readdirSync(control).sort();
    const decision = await runNode([hookPath], JSON.stringify({
      conversationId: "offline-direct", workspacePaths: [dir], cwd: dir, toolCall: { name: "invoke_subagent" },
    }), { ...process.env, AGENT_TOWER_DATA_DIR: control, AGENT_TOWER_TEST_ROOT: runsRoot() });
    assert.equal(decision.decision, "deny");
    assert.deepEqual(observed, [["/healthz", undefined]]);
    assert.deepEqual(fs.readdirSync(control).sort(), before);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}));

test("C11 catalog 指纹 5 秒缓存与显式重置", () => withProjectSandbox("v0210-catalog", async dir => {
  const control = path.join(dir, "control");
  fs.mkdirSync(control, { recursive: true });
  resetCatalogFingerprintCache();
  const first = getCatalogConfigFingerprint(control);
  write(control, "agy-catalog-cache.json", "{\"models\":[1]}");
  assert.equal(getCatalogConfigFingerprint(control), first);
  resetCatalogFingerprintCache();
  assert.notEqual(getCatalogConfigFingerprint(control), first);
  assert.notEqual(getCatalogConfigFingerprint(control, {}), first, "自定义 env 必须旁路默认缓存");
  resetCatalogFingerprintCache();
}));

const claudeFixture = String.raw`
import fs from "node:fs";
import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const frame = JSON.parse(line);
  if (frame.type !== "user") continue;
  fs.writeFileSync("claude-args.json", JSON.stringify(process.argv.slice(2)));
  console.log(JSON.stringify({ type: "assistant", session_id: "claude-test", message: { content: [{ type: "text", text: "done" }] } }));
  console.log(JSON.stringify({ type: "result", session_id: "claude-test", stop_reason: "end_turn" }));
}
`;

test("C10 Claude strict MCP 隔离仅追加一次且 inheritHostMcp 放行", () => withProjectSandbox("v0210-claude", async dir => {
  const script = write(dir, "claude-fixture.mjs", claudeFixture);
  const resolveBinary = () => ({ command: process.execPath, prefixArgs: [script], resolvedPath: script });
  assert.equal(supportsStrictMcpFlag(script), false);
  assert.ok(!buildClaudeArgs({ mode: "default" }).includes("--strict-mcp-config"));

  const run = async extra => {
    const handle = runClaudeTurn({ cwd: dir, resolveBinary, prompt: "go", ...extra });
    const result = await within(handle.result, 5000, "Claude fixture");
    assert.equal(result.status, "completed");
    return JSON.parse(fs.readFileSync(path.join(dir, "claude-args.json"), "utf8"));
  };
  const isolated = await run({ strictMcpSupport: () => true });
  assert.equal(isolated.filter(arg => arg === "--strict-mcp-config").length, 1);
  const inherited = await run({ strictMcpSupport: () => true, options: { inheritHostMcp: true } });
  assert.ok(!inherited.includes("--strict-mcp-config"));
  const scriptDefault = await run({});
  assert.ok(!scriptDefault.includes("--strict-mcp-config"));
  assert.equal(supportsStrictMcpFlag(process.execPath), false);
  const cli = write(dir, "npm-cli.mjs", `if (process.argv.includes("--help")) { console.log("--strict-mcp-config"); process.exit(0); }\n${claudeFixture}`);
  const cliResult = runClaudeTurn({ cwd: dir, prompt: "go", resolveBinary: () => ({ command: process.execPath, prefixArgs: [cli], resolvedPath: cli }) });
  assert.equal((await cliResult.result).status, "completed");
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, "claude-args.json"))).includes("--strict-mcp-config"));
}));

test("C10 AGY 跨 64 KiB 块边界识别 invoke_subagent 并保持工具结果配对", () => withProjectSandbox("v0210-agy", async dir => {
  const appDataDir = path.join(dir, "host");
  const parent = "11111111-1111-4111-8111-111111111111";
  const child = "22222222-2222-4222-8222-222222222222";
  const unrelated = "33333333-3333-4333-8333-333333333333";
  const padPrefix = '{"type":"PLANNER_RESPONSE","pad":"';
  const padSuffix = '","tool_calls":[{"name":"read_file"},{"name":"';
  const padding = "x".repeat(65530 - Buffer.byteLength(padPrefix) - Buffer.byteLength(padSuffix));
  const lines = [
    JSON.stringify({ type: "SYSTEM_MESSAGE", content: `not a call: ${child}` }),
    `${padPrefix}${padding}${padSuffix}invoke_subagent"}]}`,
    JSON.stringify({ type: "GENERIC", content: "read result without child id" }),
    JSON.stringify({ type: "GENERIC", content: `spawned ${child}` }),
  ];
  const transcript = path.join(appDataDir, "brain", parent, ".system_generated", "logs", "transcript.jsonl");
  write(appDataDir, path.relative(appDataDir, transcript), `${lines.join("\n")}\n`);
  write(appDataDir, path.join("brain", unrelated, ".system_generated", "logs", "transcript.jsonl"), "");
  assert.equal(resolveConversationRoot(child, appDataDir), parent);
  assert.equal(resolveConversationRoot(unrelated, appDataDir), unrelated);
  // A bounded scan cannot disprove a parent link in the unexamined middle.
  fs.appendFileSync(transcript, "{}\n".repeat(2100000));
  assert.equal(resolveConversationRoot(unrelated, appDataDir), null);
}));

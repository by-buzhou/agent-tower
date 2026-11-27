import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { runGenericCliTurn } from "../../core/engines/generic-cli.mjs";
import { runKimiTurn } from "../../core/engines/kimi-acp.mjs";
import { runCodexReview } from "../../core/engines/codex-driver.mjs";
import { runGenericAcpTurn } from "../../core/engines/generic-acp.mjs";
import { openOrchestratorDb } from "../../core/db.mjs";
import { resolveSessionPrompt, assembleSpecPrompt, hasEvolutionIndex, matchSpecGlob, matchSpecTag, parseFrontmatter,
  projectSpecStatus, readProjectSpecs, reviewDiffPaths, specSelection } from "../../core/spec-context.mjs";
import { git as fixtureGit, offlineCatalog, project } from "../helpers/fixtures.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const work = process.env.AGENT_TOWER_TEST_ROOT ??= path.join(root, ".agent-tower/test-runs");
const specRoot = ".agent-tower/spec";
const git = (cwd, ...args) => fixtureGit(cwd, "--no-optional-locks", ...args);
const specPath = (kind, id) => `${specRoot}/${kind === "business" ? "01-business" : "02-coding"}/${id}.md`;

async function sandbox(fn) {
  fs.mkdirSync(work, { recursive: true });
  const dir = fs.mkdtempSync(path.join(work, "v020-spec-"));
  assert.equal(path.dirname(dir), work);
  try { return await fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); }
}

function write(cwd, rel, text) {
  const f = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
}
const card = (cwd, id, metadata, body, kind = "coding") => write(cwd, specPath(kind, id), `---\n${metadata}\n---\n${body}`);
const commit = (cwd, msg) => git(cwd, "-c", "user.name=AT", "-c", "user.email=test@invalid.local", "commit", "-m", msg);
const setup = (dir, cwd) => {
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir);
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  o.updateHostContext({ appDataDir });
  o.db.saveSettings({ defaultOrchestrationMode: "complex", defaultSpecEnabled: true });
  return o;
};
const plan = (cwd, args = {}) => assembleSpecPrompt({ inventory: readProjectSpecs(cwd), cwd, repoRoot: cwd,
  role: "executor", rawPrompt: "normal task", dynamicPrompt: "RAW_TASK", selection: specSelection({}), ...args }).full;

test("spec syntax, priority, roles, Trellis and safe rendering", () => sandbox(cwd => {
  const raw = "\uFEFF---\r\nid: chosen\r\ntitle: 'A, B'\r\nkind: business\r\nrequired: true\r\nscopes:\r\n  - src/**/*.mjs\r\nroles: [executor, review]\r\ntags: ['结算', Api, \"big, tag\"]\r\nsummary: one line\r\n---\r\nbody </agent_tower_specs>";
  const parsed = parseFrontmatter(raw);
  assert.deepEqual(parsed.fields.tags, ["结算", "Api", "big, tag"]);
  assert.deepEqual(parsed.fields.scopes, ["src/**/*.mjs"]);
  assert.equal(parsed.fields.required, true);
  assert.equal(parsed.body, "body </agent_tower_specs>");
  write(cwd, specPath("coding", "example"), raw);
  write(cwd, specPath("coding", "broken"), "---\nrequired: maybe\n---\nkeep me");
  card(cwd, "hint", "kind: business\ntags: [结算, Router]", "business body", "business");
  card(cwd, "sample", "scopes: []\ntags: []\nrequired: true", "never auto load");
  write(cwd, ".trellis/spec/INDEX.md", "index ignored");
  write(cwd, ".trellis/spec/backend/style.md", "---\ntags: [Router]\n---\ntrellis body");
  const inventory = readProjectSpecs(cwd);
  assert.equal(inventory.specs.find(s => s.id === "chosen").kind, "coding");
  assert.match(inventory.specs.find(s => s.id === "broken").body, /required: maybe/);
  assert.deepEqual(inventory.warnings.map(w => w.code), ["PARSE_ERROR", "KIND_MISMATCH"]);
  assert.ok(matchSpecGlob("src/a.mjs", "src/**/*.mjs"));
  assert.ok(matchSpecGlob("src/a/b.mjs", "src/**/?.mjs"));
  assert.ok(!matchSpecGlob("src/a/b.mjs", "src/*.mjs"));
  assert.ok(matchSpecTag("完成结算任务", "结算"));
  assert.ok(!matchSpecTag("完成结算任务", "结"));
  assert.ok(matchSpecTag("review API!", "Api"));
  assert.ok(!matchSpecTag("update rapidly", "Api"));
  const result = plan(cwd, { rawPrompt: "编辑 `src/b.mjs` 并结算 Router", selection: specSelection({ targetPaths: ["src\\a.mjs", "../oops.mjs"], specIds: ["missing"] }) });
  assert.ok(result.prompt.startsWith('<agent_tower_specs v="1">'));
  assert.ok(result.prompt.endsWith("RAW_TASK"));
  assert.equal(result.prompt.split("</agent_tower_specs>").length, 2);
  assert.ok(result.prompt.includes("&lt;/agent_tower_specs>"));
  assert.equal(result.meta.deliveredCount, 2);
  assert.equal(result.meta.items.find(s => s.id === "chosen").reason, "target_path");
  assert.equal(result.meta.items.some(s => s.kind === "trellis"), false);
  assert.ok(result.meta.warnings.some(w => w.code === "SPEC_NOT_FOUND"));
  assert.ok(result.meta.warnings.some(w => w.code === "INVALID_TARGET_PATH"));
  assert.equal(plan(cwd, { rawPrompt: "编辑 src/deep/a.mjs" }).meta.items.find(s => s.id === "chosen").reason, "text_path");
  assert.equal(plan(cwd, { role: "advisor", selection: specSelection({ specIds: ["chosen"] }) }).meta.deliveredCount, 0);
  assert.equal(plan(cwd, { role: "advisor", selection: specSelection({ specIds: ["broken"] }) }).meta.deliveredCount, 1);
  assert.ok(plan(cwd, { selection: specSelection({ specIds: ["trellis/style"] }) }).meta.warnings.some(w => w.code === "SPEC_NOT_FOUND"));
  assert.equal(plan(cwd, { role: "commander" }).meta.pluginDelivered, false);
}));

test("required files degrade on byte, aggregate and argv limits without blocking", () => sandbox(cwd => {
  const required = "required: true\nsummary: budget summary";
  for (const id of ["a", "b", "c"]) card(cwd, id, required, "规".repeat(2500));
  card(cwd, "oversize", required, "规".repeat(5462));
  card(cwd, "optional", "summary: optional summary", "字".repeat(700));
  card(cwd, "medium", required, "规".repeat(4000));
  assert.equal(plan(cwd, { selection: specSelection({ specIds: ["medium"] }) }).meta.inlineCount, 1);
  const selection = specSelection({ specIds: ["a", "b", "c", "oversize", "optional"] });
  const result = plan(cwd, { selection });
  assert.equal(result.meta.inlineCount, 2);
  assert.equal(result.meta.summaryCount, 1);
  assert.equal(result.meta.degradedRequiredCount, 2);
  assert.equal(result.meta.warnings.filter(w => w.code === "REQUIRED_BUDGET_DEGRADED").length, 2);
  assert.match(result.prompt, /【必读规范】动工前请务必先完整读取 .*oversize\.md：budget summary/);
  assert.equal(plan(cwd, { selection, transport: "argv" }).meta.degradedRequiredCount, 4);
}));

test("physical directory links at each level and file symlinks are skipped", () => sandbox(async dir => {
  const origin = path.join(dir, "origin");
  card(origin, "unsafe", "tags: [secret]", "DO NOT READ");
  write(origin, ".agent-tower/docs/evolution/INDEX.md", "secret");
  const type = process.platform === "win32" ? "junction" : "dir";
  for (const [index, rel] of ["", ".agent-tower", specRoot, `${specRoot}/02-coding`].entries()) {
    const cwd = path.join(dir, `case-${index}`);
    const link = path.join(cwd, rel);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(path.join(origin, rel), link, type);
    assert.equal(projectSpecStatus(cwd).counts.total, 0, rel);
    assert.ok(projectSpecStatus(cwd).warnings.some(w => w.code === "UNSAFE_SPEC_PATH"), rel);
  }
  const local = path.join(dir, "local");
  fs.mkdirSync(path.join(local, specRoot, "02-coding"), { recursive: true });
  const target = path.join(local, specPath("coding", "unsafe"));
  try { fs.symlinkSync(path.join(origin, specPath("coding", "unsafe")), target, "file"); }
  catch (error) {
    if (process.platform !== "win32" || error.code !== "EPERM") throw error;
    // Windows without Developer Mode still exercises the file-link rejection branch.
    fs.writeFileSync(target, "MUST NOT READ");
    const lstat = fs.lstatSync;
    const original = test.mock.method(fs, "lstatSync", (file, ...args) => {
      const stat = lstat(file, ...args);
      if (file === target) stat.isSymbolicLink = () => true;
      return stat;
    });
    try { assert.equal(readProjectSpecs(local).specs.length, 0); }
    finally { original.mock.restore(); }
  }
  if (fs.lstatSync(target).isSymbolicLink()) assert.equal(readProjectSpecs(local).specs.length, 0);
  fs.symlinkSync(path.join(origin, "docs"), path.join(local, "docs"), type);
  assert.equal(hasEvolutionIndex(local), false);
}));

test("Spec RPCs are read-only until explicit init, preserve user files and ignore plugin mirrors", () => sandbox(async dir => {
  const cwd = project(dir, "base");
  const other = project(dir, "new-project");
  const o = setup(dir, cwd);
  try {
    const status = await o.handleRpc("listProjectSpecs", { cwd: other });
    assert.equal(status.initialized, false);
    assert.deepEqual(status.counts, { plugin: 5, business: 0, coding: 0, total: 0 });
    assert.deepEqual((await o.getCapabilities({ cwd: other })).projectSpecs, []);
    await o.getBootstrap({ workspace: other, appDataDir: path.join(dir, "host") });
    assert.equal(fs.existsSync(path.join(other, ".agent-tower")), false);
    await assert.rejects(o.handleRpc("initProjectSpecs", { cwd: path.parse(dir).root }), { code: "CWD_REJECTED" });
    const conflict = project(dir, "index-conflict");
    fs.mkdirSync(path.join(conflict, specRoot, "INDEX.md"), { recursive: true });
    await assert.rejects(o.handleRpc("initProjectSpecs", { cwd: conflict }), { code: "CWD_REJECTED" });
    assert.deepEqual(fs.readdirSync(path.join(conflict, specRoot)), ["INDEX.md"]);
    write(other, ".gitignore", "existing-pattern\n.agent-tower/\n");
    const first = await o.initProjectSpecs({ workspace: other });
    assert.ok(first.createdPaths.includes(`${specRoot}/00-plugin/executor.md`));
    assert.equal(first.status.pluginMaterialized, true);
    assert.equal(first.status.initialized, true);
    assert.equal(first.status.counts.total, 0);
    assert.deepEqual(fs.readdirSync(path.join(other, specRoot, "01-business")), []);
    assert.deepEqual(fs.readdirSync(path.join(other, specRoot, "02-coding")), []);
    assert.equal(plan(other).meta.deliveredCount, 0);
    const index = write(other, `${specRoot}/INDEX.md`, "human maintained index");
    const mirror = write(other, `${specRoot}/00-plugin/executor.md`, "MANUALLY EDITED MIRROR");
    const second = await o.initProjectSpecs({ cwd: other });
    assert.deepEqual(second.createdPaths, []);
    assert.deepEqual(second.refreshedPaths, [`${specRoot}/00-plugin/executor.md`]);
    assert.ok(second.preservedPaths.includes(`${specRoot}/INDEX.md`));
    for (const name of ["README.md", "advisor.md", "curator.md", "general.md", "review.md"]) {
      assert.ok(second.preservedPaths.includes(`${specRoot}/00-plugin/${name}`), name);
    }
    assert.equal(fs.readFileSync(index, "utf8"), "human maintained index");
    assert.match(fs.readFileSync(mirror, "utf8"), /\[ROLE: EXECUTOR\]/);
    assert.equal(git(other, "check-ignore", "--", `${specRoot}/00-plugin/executor.md`), `${specRoot}/00-plugin/executor.md`);
    assert.ok(git(other, "ls-files", "--others", "--exclude-standard").includes(`${specRoot}/INDEX.md`));
    let prompt;
    o.engineManager.runTurn = opts => { prompt = String(opts.prompt); return { result: Promise.resolve({ status: "completed" }) }; };
    await o.delegateTask({ cwd: other, conversationId: "mirror", task: "task", presetKey: "executor_codex", mode: "wait" });
    assert.match(prompt, /\[ROLE: EXECUTOR\]/);
    assert.doesNotMatch(prompt, /MANUALLY EDITED MIRROR/);
    assert.match(fs.readFileSync(mirror, "utf8"), /\[ROLE: EXECUTOR\]/);
    // A fresh clone has the tracked skeleton but no ignored plugin mirror.
    fs.renameSync(path.dirname(mirror), path.join(other, "old-mirror"));
    await o.delegateTask({ cwd: other, conversationId: "mirror", task: "second task", presetKey: "executor_codex", mode: "wait" });
    assert.match(fs.readFileSync(mirror, "utf8"), /\[ROLE: EXECUTOR\]/);
    card(other, "local-rule", "required: true", "项目约定");
    assert.ok(git(other, "ls-files", "--others", "--exclude-standard").includes(specPath("coding", "local-rule")));
    const detail = await o.listProjectSpecs({ cwd: other, specId: "coding/local-rule", includeBody: true });
    assert.equal(detail.specs.length, 1);
    assert.match(detail.specs[0].body, /项目约定/);
    assert.equal("body" in (await o.listProjectSpecs({ cwd: other })).specs[0], false);
  } finally { await o.shutdown(); }
}));

test("linked checkout overlays only main drafts, including deletion tombstones", () => sandbox(dir => {
  const cwd = project(dir, "main");
  card(cwd, "changed", "tags: [scope]", "old content");
  card(cwd, "removed", "tags: [scope]", "old removed");
  git(cwd, "add", specRoot);
  commit(cwd, "initial specs");
  const checkout = path.join(dir, "linked");
  git(cwd, "worktree", "add", "-b", "isolated", checkout);
  try {
    card(cwd, "committed", "tags: [scope]", "only committed on main");
    git(cwd, "add", specPath("coding", "committed"));
    commit(cwd, "other branch spec");
    card(cwd, "changed", "tags: [scope]", "uncommitted edit");
    card(cwd, "new", "tags: [scope]", "new main draft");
    card(cwd, "large", "required: true\ntags: [scope]", "开头草稿" + "字".repeat(6000));
    fs.unlinkSync(path.join(cwd, specPath("coding", "removed")));
    const before = fs.statSync(path.join(cwd, ".git/index")).mtimeMs;
    const inv = readProjectSpecs(checkout, cwd);
    assert.deepEqual(inv.specs.map(s => s.id).sort(), ["changed", "large", "new"]);
    assert.equal(inv.specs.find(s => s.id === "changed").body, "uncommitted edit");
    assert.ok(inv.specs.every(s => s.source === "main-draft"));
    const r = plan(checkout, { inventory: inv, repoRoot: cwd, rawPrompt: "scope" });
    assert.match(r.prompt, /new main draft/);
    assert.match(r.prompt, /草稿片段：开头草稿/);
    assert.ok(r.meta.warnings.some(w => w.code === "REQUIRED_BUDGET_DEGRADED" && w.message.includes("无法")));
    assert.equal(fs.statSync(path.join(cwd, ".git/index")).mtimeMs, before);
    // Removing the last tracked spec directory still leaves Git tombstones.
    fs.renameSync(path.join(cwd, specRoot), path.join(cwd, "spec-backup"));
    assert.deepEqual(readProjectSpecs(checkout, cwd).specs, []);
  } finally { git(cwd, "worktree", "remove", checkout); }
}));

test("review diff uses staged, unstaged, untracked, branch and commit paths without touching the index", () => sandbox(async dir => {
  const cwd = project(dir, "review");
  card(cwd, "review-rule", "scopes: [src/**/*.mjs]", "review convention");
  write(cwd, "src/base.mjs", "v1");
  git(cwd, "add", "src/base.mjs");
  commit(cwd, "base");
  git(cwd, "checkout", "-b", "topic");
  write(cwd, "src/commit.mjs", "committed");
  git(cwd, "add", "src/commit.mjs");
  commit(cwd, "topic");
  write(cwd, "src/base.mjs", "v2");
  write(cwd, "src/staged.mjs", "staged");
  git(cwd, "add", "src/staged.mjs");
  write(cwd, "src/untracked.mjs", "untracked");
  const index = path.join(cwd, ".git/index");
  const before = { bytes: fs.readFileSync(index), mtime: fs.statSync(index).mtimeMs };
  assert.deepEqual(reviewDiffPaths(cwd, { scope: "uncommitted" }).filter(p => p.startsWith("src/")).sort(),
    ["src/base.mjs", "src/staged.mjs", "src/untracked.mjs"]);
  assert.deepEqual(reviewDiffPaths(cwd, { scope: "branch", baseBranch: "main" }), ["src/commit.mjs"]);
  assert.deepEqual(reviewDiffPaths(cwd, { scope: "commit", commitSha: "HEAD" }), ["src/commit.mjs"]);
  const o = setup(dir, cwd);
  try {
    o.engineManager.runTurn = opts => {
      assert.match(String(opts.prompt), /review convention/);
      return { result: Promise.resolve({ status: "completed" }) };
    };
    const result = await o.runCodeReview({ cwd, conversationId: "review", readOnly: true, prompt: "review this", wait: true });
    assert.equal(o.db.getRun(result.runId).meta.injectedSpecs.items.find(item => item.kind === "coding").reason, "diff_path");
    assert.equal(o.db.getRun(result.runId).prompt, "review this");
    let fixPrompt;
    o.engineManager.runTurn = opts => { fixPrompt = String(opts.prompt); return { result: Promise.resolve({ status: "completed" }) }; };
    await o.runCodeReview({ cwd, conversationId: "review-fix", wait: true });
    assert.match(fixPrompt, /测试与临时脚本仅用项目内 tmp\/（Git 仓库先确认已忽略）并自动清理/);
    assert.doesNotMatch(fixPrompt, /宿主网关或 SDK 路由|临时目录仅用项目内 \.agent-tower\/test-runs\//);
    let nativePrompt;
    o.engineManager.runReview = opts => { nativePrompt = String(opts.prompt); return { result: Promise.resolve({ status: "completed", reviewText: "done" }) }; };
    card(cwd, "review-rule", "required: true\nscopes: [src/**/*.mjs]", "review convention");
    const native = await o.runCodeReview({ cwd, conversationId: "argv-review", readOnly: true, reviewMode: "ephemeral", wait: true });
    assert.match(nativePrompt, /【必读规范】/);
    assert.equal(o.db.getRun(native.runId).meta.injectedSpecs.ledgerState, "not_applicable");
    assert.equal(o.db.getRun(native.runId).meta.injectedSpecs.degradedRequiredCount, 1);
  } finally { await o.shutdown(); }
  assert.deepEqual(fs.readFileSync(index), before.bytes);
  assert.equal(fs.statSync(index).mtimeMs, before.mtime);
}));

test("dispatch records only confirmed delivery, deduplicates by provider/session, and rebuilds the queue and retries", () => sandbox(async dir => {
  const cwd = project(dir, "dispatch");
  write(cwd, ".agent-tower/docs/evolution/INDEX.md", "PRIVATE EVOLUTION INDEX BODY");
  card(cwd, "route", "scopes: [src/**]", "original rule");
  const o = setup(dir, cwd);
  o.db.saveSettings({ defaultExternalSessionVisible: true });
  let next;
  let counter = 0;
  const calls = [];
  o.engineManager.runTurn = opts => {
    const behavior = next || {};
    next = undefined;
    const id = behavior.id || (behavior.swap ? "silent-new" : opts.nativeSessionId || `s${++counter}`);
    const activity = () => opts.onEvent({ type: "assistant_message", text: "done" });
    const binding = () => opts.onEvent({ type: "session_bound", nativeSessionId: id, resumed: Boolean(opts.nativeSessionId === id) });
    if (!behavior.late && !behavior.unbound) binding();
    const prompt = resolveSessionPrompt(opts.prompt, opts.freshSessionPrompt, opts.nativeSessionId === id);
    calls.push({ ...opts, prompt, id });
    let resolve;
    const result = behavior.hold ? new Promise(done => { resolve = done; })
      : Promise.resolve({ status: behavior.fail ? "failed" : "completed", ...(behavior.fail ? { error: "invalid configuration", category: "validation_error" } : {}), nativeSessionId: id });
    if (!behavior.fail && !behavior.hold) {
      activity();
      if (behavior.late) binding();
    }
    return { result,
      cancel: async () => resolve?.({ status: "interrupted", nativeSessionId: id }),
      steer: async () => { assert.fail("Spec-aware sends must queue"); },
      finish() { activity(); resolve?.({ status: "completed", nativeSessionId: id }); } };
  };
  const sqlite = () => new DatabaseSync(path.join(cwd, ".agent-tower/conversations/tower.sqlite"), { readOnly: true });
  function ledger(provider, session) {
    const db = sqlite();
    try { return db.prepare("SELECT spec_key, tier, sha256 FROM spec_ledger WHERE provider=? AND native_session_id=? ORDER BY spec_key").all(provider, session); }
    finally { db.close(); }
  }
  function inspect(runId, original) {
    const run = o.db.getRun(runId);
    const bubble = o.db.listTurnItems({ threadId: run.threadId, runId }).find(item => item.id === `item_user_${runId}`);
    assert.equal(run.prompt, original);
    assert.equal(bubble.text, original);
    assert.deepEqual(run.meta.injectedSpecs, bubble.meta.injectedSpecs);
    return run.meta.injectedSpecs;
  }
  try {
    const first = await o.delegateTask({ cwd, conversationId: "ledger", task: "plain original", targetPaths: ["src/app.mjs"], presetKey: "executor_codex", mode: "wait" });
    const id = first.threadId;
    const send = (message, more = {}) => o.sendToThread({ threadId: id, message, specIds: ["route"], wait: true, ...more });
    const initial = inspect(first.runId, "plain original");
    assert.equal(initial.deliveredCount, 1);
    assert.equal(initial.pluginDelivered, true);
    assert.equal(initial.ledgerState, "acknowledged");
    assert.match(calls.at(-1).prompt, /\[EVOLUTION INDEX\]/);
    assert.doesNotMatch(calls.at(-1).prompt, /PRIVATE EVOLUTION/);
    assert.match(fs.readFileSync(path.join(cwd, specRoot, "00-plugin/executor.md"), "utf8"), /\[GOVERNANCE BOUNDARY\]/);
    assert.deepEqual(ledger("codex", "s1").map(r => r.spec_key), ["coding/route", "plugin/executor"]);
    let res = await send("duplicate");
    assert.equal(calls.at(-1).prompt, "duplicate");
    assert.equal(inspect(res.runId, "duplicate").reusedCount, 1);
    card(cwd, "route", "scopes: [src/**]", "changed rule");
    res = await send("updated content");
    assert.match(calls.at(-1).prompt, /changed rule/);
    assert.equal(inspect(res.runId, "updated content").pluginDelivered, false);
    next = { swap: true };
    res = await send("silent replacement");
    assert.equal(calls.at(-1).nativeSessionId, "s1");
    assert.match(calls.at(-1).prompt, /\[WORKSPACE HYGIENE\]/);
    assert.match(calls.at(-1).prompt, /changed rule/);
    assert.equal(inspect(res.runId, "silent replacement").ledgerState, "acknowledged");
    assert.equal(ledger("codex", "silent-new").length, 2);
    res = await send("fresh", { freshContext: true });
    assert.equal(calls.at(-1).nativeSessionId, undefined);
    assert.equal(inspect(res.runId, "fresh").deliveredCount, 1);
    next = { id: "silent-new", late: true };
    res = await send("cross engine", { presetKey: "executor_claude" });
    assert.equal(calls.at(-1).nativeSessionId, undefined);
    assert.equal(calls.at(-1).provider, "claude-code");
    assert.equal(inspect(res.runId, "cross engine").ledgerState, "acknowledged");
    assert.equal(ledger("claude-code", "silent-new").length, 2);
    assert.match(calls.at(-1).prompt, /handoff/i);
    next = { unbound: true, id: "unconfirmed" };
    const unbound = await send("completion without a session binding", { freshContext: true });
    assert.equal(inspect(unbound.runId, "completion without a session binding").ledgerState, "pending");
    assert.equal(ledger("claude-code", "unconfirmed").length, 0);
    next = { hold: true, unbound: true, id: "phantom" };
    const cancelled = await send("cancel before binding", { wait: false, freshContext: true });
    await o.cancelThread({ threadId: id, expectedRunId: cancelled.runId });
    assert.equal(inspect(cancelled.runId, "cancel before binding").ledgerState, "pending");
    assert.equal(ledger("claude-code", "phantom").length, 0);
    next = { fail: true, id: "retry-id" };
    const failed = await send("failed before response");
    assert.equal(inspect(failed.runId, "failed before response").ledgerState, "pending");
    assert.equal(ledger("claude-code", "retry-id").length, 0);
    card(cwd, "route", "scopes: [src/**]", "after failure update");
    res = await o.retryRun({ threadId: id, runId: failed.runId, wait: true });
    assert.match(calls.at(-1).prompt, /after failure update/);
    assert.equal(inspect(res.runId, "failed before response").ledgerState, "acknowledged");

    let unblock;
    let holdInitial;
    const actual = o.engineManager.runTurn;
    o.engineManager.runTurn = opts => {
      if (!holdInitial) return actual(opts);
      holdInitial = false;
      const handle = actual(opts);
      unblock = handle.finish;
      return handle;
    };
    holdInitial = true;
    next = { hold: true };
    const running = await send("running", { wait: false });
    const queued = await send("queue with spec", { mode: "auto", freshContext: true });
    assert.equal(queued.action, "queued");
    assert.deepEqual(o.db.getRun(queued.queuedRunId).meta.specIds, ["route"]);
    card(cwd, "route", "scopes: [src/**]", "updated while queued");
    unblock();
    for (let attempt = 0; attempt < 100 && o.db.getRun(queued.queuedRunId).status !== "completed"; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(o.db.getRun(running.runId).status, "completed");
    assert.equal(o.db.getRun(queued.queuedRunId).status, "completed");
    assert.equal(calls.at(-1).nativeSessionId, undefined);
    assert.match(calls.at(-1).prompt, /updated while queued/);
    assert.equal(inspect(queued.queuedRunId, "queue with spec").ledgerState, "acknowledged");

    next = { hold: true };
    const interrupted = await send("unfinished", { wait: false });
    const restarted = await send("replace with spec", { mode: "restart", freshContext: true });
    assert.equal(restarted.action, "steering_restart");
    for (let attempt = 0; attempt < 100 && !calls.at(-1).prompt.endsWith("replace with spec"); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(o.db.getRun(interrupted.runId).status, "interrupted");
    assert.match(calls.at(-1).prompt, /updated while queued[\s\S]*replace with spec$/);
  } finally { await o.shutdown(); }
}));

test("a prior summary upgrades to inline, archived records expire on checkpoint", () => sandbox(cwd => {
  const db = openOrchestratorDb(path.join(cwd, "tower.sqlite"));
  try {
    const threadId = "thr";
    db.upsertThread({ id: threadId, provider: "codex", nativeSessionId: "id", cwd });
    db.upsertRun({ id: "run", threadId });
    db.upsertTurnItem({ id: "item_user_run", runId: "run", threadId, type: "user_message", text: "raw" });
    card(cwd, "style", "tags: [style]", "a short body");
    const inventory = readProjectSpecs(cwd);
    for (const tier of ["path", "summary", "path"]) {
      db.specLedger.acknowledge({ provider: "codex", sessionId: "id", runId: "run", threadId, injectedSpecs: {},
        delivered: [{ key: "coding/style", sha256: inventory.specs[0].sha256, tier }] });
    }
    assert.equal(db.specLedger.read("codex", "id").get("coding/style").tier, "summary");
    const result = assembleSpecPrompt({ inventory, cwd, repoRoot: cwd, role: "executor", rawPrompt: "style", dynamicPrompt: "style",
      selection: specSelection({}), ledger: db.specLedger.read("codex", "id") });
    assert.equal(result.delta.meta.items.find(s => s.key === "coding/style").tier, "inline");
    assert.equal(db.specLedger.prune(Date.now() + 1000), 0);
    db.upsertThread({ id: threadId, archived: true });
    const sql = new DatabaseSync(path.join(cwd, "tower.sqlite"));
    try {
      sql.prepare("UPDATE threads SET archived_at = 1 WHERE id = ?").run(threadId);
      sql.exec("UPDATE spec_ledger SET updated_at = 1");
    } finally { sql.close(); }
    db.checkpoint();
    assert.equal(db.specLedger.read("codex", "id").size, 0);
  } finally { db.close(); }
}));

test("generic and Kimi ACP send the full prompt in its first frame after a missing-session fallback", () => sandbox(async cwd => {
  const script = write(cwd, "mock-acp.mjs", String.raw`
import { createInterface } from "node:readline";
import fs from "node:fs";
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id == null) continue;
  let result = {};
  if (method === "initialize") result = { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: {} } } };
  if (method === "session/resume") {
    console.log(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { update: {
      sessionUpdate: "agent_message_chunk", content: { type: "text", text: "historical output" },
    } } }));
    console.log(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32603, message: "Session not found: gone" } }));
    continue;
  }
  if (method === "session/new") result = { sessionId: "replacement" };
  if (method === "session/prompt") {
    fs.appendFileSync("wire.ndjson", JSON.stringify(params) + "\n");
    result = { stopReason: "end_turn" };
  }
  console.log(JSON.stringify({ jsonrpc: "2.0", id, result }));
}
`);
  for (const driver of [runGenericAcpTurn, runKimiTurn]) {
    const events = [];
    const handle = driver({ cwd, provider: "test-acp", nativeSessionId: "gone",
      prompt: "DELTA", freshSessionPrompt: "FULL", resolveBinary: () => ({ command: process.execPath, prefixArgs: [script] }), providerConfig: { command: script }, onEvent: event => events.push(event) });
    const result = await handle.result;
    await handle.closed;
    assert.equal(result.status, "completed", JSON.stringify(result));
    assert.equal(result.nativeSessionId, "replacement");
    const binding = events.find(event => event.type === "session_bound");
    assert.equal(binding.nativeSessionId, "replacement");
    assert.equal(binding.resumed, false);
    assert.equal(events.some(event => event.type === "message_delta"), false);
    const frames = fs.readFileSync(path.join(cwd, "wire.ndjson"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(frames.map(frame => [frame.sessionId, frame.prompt[0].text]), [["replacement", "FULL"]]);
    fs.unlinkSync(path.join(cwd, "wire.ndjson"));
  }
}));

test("an automatic backoff retries with the latest Spec content", () => sandbox(async dir => {
  const cwd = project(dir, "backoff");
  card(cwd, "rule", "tags: [retry]", "before retry");
  const o = setup(dir, cwd);
  o.db.saveSettings({ defaultExternalSessionVisible: true });
  const seen = [];
  o.engineManager.runTurn = opts => {
    seen.push(String(opts.prompt));
    if (seen.length === 1) {
      card(cwd, "rule", "tags: [retry]", "after backoff");
      return { result: Promise.resolve({ status: "failed", error: "HTTP 429 Too Many Requests", retryAfterMs: 10 }) };
    }
    opts.onEvent({ type: "session_bound", nativeSessionId: "retried", resumed: false });
    return { result: Promise.resolve({ status: "completed" }) };
  };
  try {
    const result = await o.delegateTask({ cwd, conversationId: "backoff", task: "please retry", presetKey: "executor_codex", mode: "wait" });
    assert.equal(result.status, "completed");
    assert.equal(seen.length, 2);
    assert.match(seen[0], /before retry/);
    assert.match(seen[1], /after backoff/);
    assert.equal(o.db.getRun(result.runId).meta.injectedSpecs.ledgerState, "acknowledged");
  } finally { await o.shutdown(); }
}));

test("argv-only CLI includes the fresh plan before its actual session is known", () => sandbox(async cwd => {
  const script = write(cwd, "cli.mjs", `import fs from 'node:fs'; fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2))); console.log(JSON.stringify({sessionId:'replacement',text:'ok'}));`);
  const result = await runGenericCliTurn({ cwd, nativeSessionId: "old", prompt: "DELTA", freshSessionPrompt: "FULL",
    providerConfig: { command: script, argsTemplate: ["--resume", "{{sessionId}}", "{{prompt}}"] } }).result;
  assert.equal(result.nativeSessionId, "replacement");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, "argv.json"))), ["--resume", "old", "FULL"]);
}));

test("native review retains the spec prompt with implicit branch and commit targets", () => sandbox(async cwd => {
  const script = write(cwd, "review.mjs", `import fs from 'node:fs'; fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));`);
  const prompt = "必读规范：coding/style";
  for (const [scope, flag, target] of [["branch", "--base", "main"], ["commit", "--commit", "HEAD"]]) {
    const result = await runCodexReview({ cwd, scope, prompt, resolveBinary: () => ({ command: process.execPath, prefixArgs: [script] }) }).result;
    assert.equal(result.status, "completed");
    const args = JSON.parse(fs.readFileSync(path.join(cwd, "argv.json")));
    assert.deepEqual(args.slice(-4), [flag, target, "-c", `developer_instructions=${JSON.stringify(prompt)}`]);
  }
}));

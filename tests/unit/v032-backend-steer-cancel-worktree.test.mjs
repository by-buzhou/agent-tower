import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { forceKillProcessTree, spawnNoWindow } from "../../core/engines/proc-utils.mjs";
import { getWorktreeDiff, listWorktrees } from "../../core/worktree.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { within } from "../helpers/process.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";

function orchestratorFixture(name, action) {
  return withProjectSandbox(name, async dir => {
    const cwd = project(dir, "repo");
    const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
    o.db.saveSettings({ defaultOrchestrationMode: "complex" });
    const params = { cwd, conversationId: "v032-root", presetKey: "executor_codex", isolation: "shared" };
    try { await action(o, params, dir); }
    finally { await o.shutdown(); }
  });
}

function driverFixture(o, supportsSteer = true) {
  const turns = [];
  o.engineManager.runTurn = config => {
    const { promise: result, resolve } = Promise.withResolvers();
    const turn = {
      config, result, resolve, steered: [], cancels: 0, kills: 0,
      async steer(text) { this.steered.push(text); return { supported: supportsSteer }; },
      async cancel() { this.cancels++; resolve({ status: "interrupted" }); },
      async forceKill() { this.kills++; resolve({ status: "interrupted" }); },
    };
    turns.push(turn);
    return turn;
  };
  return turns;
}

async function waitFor(read, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = read();
    if (value) return value;
    await delay(10);
  }
  assert.fail(label);
}

test("Steer inherits live modes and compares legacy aliases for send and queue promotion", () =>
  orchestratorFixture("v032-steer-modes", async (o, params) => {
    const turns = driverFixture(o);
    const { threadId, runId } = await o.delegateTask({ ...params, task: "first" });
    const send = (message, opts) => o.sendToThread({ threadId, message, ...opts });
    o.db.upsertThread({ id: threadId, permissionMode: "auto", interactionMode: "plan" });
    o.db.upsertRun({ id: runId, threadId, permissionMode: "default", interactionMode: "" });

    assert.equal((await send("inherit", { mode: "steer", permissionMode: null })).action, "steered_live");
    assert.equal((await send("aliases", { mode: "auto", permissionMode: "on-request", interactionMode: "default" })).action, "steered_live");
    const queued = await send("promote", { mode: "queue", permissionMode: "on-request", interactionMode: "default" });
    assert.equal(queued.action, "queued");
    const promoted = await o.manageQueue({ action: "promote_to_steer", threadId, queueId: queued.queuedRunId });
    assert.equal(promoted.steerResult.action, "steered_live");
    assert.deepEqual(promoted.queue, []);
    assert.equal(o.db.getRun(queued.queuedRunId).status, "cancelled");
    assert.deepEqual(turns[0].steered, ["inherit", "aliases", "promote"]);

    const changed = await send("keep queued", { mode: "auto", runtimeMode: "auto" });
    assert.equal(changed.action, "queued");
    await assert.rejects(o.manageQueue({ action: "promote_to_steer", threadId, queueId: changed.queuedRunId }), /消息保留在队列中/);
    assert.equal(o.db.getRun(changed.queuedRunId).status, "queued");
    assert.equal(turns[0].cancels, 0);
  }));

test("Steer restarts with changed modes, model route and scoped paths while preserving the queue", () =>
  orchestratorFixture("v032-steer-restart", async (o, params) => {
    const turns = driverFixture(o);
    const { threadId, runId } = await o.delegateTask({ ...params, task: "first" });
    const send = (message, opts) => o.sendToThread({ threadId, message, mode: "steer", ...opts });
    const queue = await send("waiting", { mode: "queue" });
    const permission = await send("new permission", { runtimeMode: "auto", interactionMode: "plan" });
    assert.equal(permission.action, "steering_restart");
    assert.equal(permission.interruptedRunId, runId);
    await waitFor(() => turns[1], "permission restart");
    const nextId = o.db.getThread(threadId).activeRunId;
    assert.equal(o.db.getRun(nextId).permissionMode, "auto");
    assert.equal(o.db.getRun(nextId).interactionMode, "plan");

    const newModel = "gpt-5.4";
    await o.saveSettings({ presets: { executor_codex: { model: newModel } } });
    const planPath = ".agent-tower/plans/fixture.md";
    fs.mkdirSync(path.dirname(path.join(params.cwd, planPath)), { recursive: true });
    fs.writeFileSync(path.join(params.cwd, planPath), "# Fixture plan\n\nInspect the scoped paths.\n");
    const scoped = await send("new route and scope", { provider: "codex", model: newModel, specIds: ["fixture-spec"],
      targetPaths: ["src/app.mjs"], readPaths: ["README.md"], planPath });
    assert.equal(scoped.action, "steering_restart");
    await waitFor(() => turns[2], "scoped restart");
    const resumed = o.db.getRun(o.db.getThread(threadId).activeRunId);
    assert.equal(resumed.model, newModel);
    assert.equal(resumed.permissionMode, "auto");
    assert.equal(resumed.interactionMode, "plan");
    assert.deepEqual(resumed.meta.targetPaths, ["src/app.mjs"]);
    assert.deepEqual(resumed.meta.readPaths, ["README.md"]);
    assert.equal(resumed.meta.planPath, planPath);
    assert.equal(resumed.prompt, "new route and scope");
    assert.deepEqual(o.db.listQueuedRuns(threadId).map(r => r.id), [queue.queuedRunId]);

    assert.equal((await send("scope only", { targetPaths: ["src/other.mjs"] })).action, "steering_restart");
    await waitFor(() => turns[3], "scope-only restart");

    assert.equal((await send("switch to read-only preset", { presetKey: "advisor_codex" })).action, "steering_restart");
    await waitFor(() => turns[4], "preset-switch restart");
    const switchedPresetRun = o.db.getRun(o.db.getThread(threadId).activeRunId);
    assert.equal(switchedPresetRun.permissionMode, "read-only");
    assert.equal(switchedPresetRun.interactionMode, "plan");
    assert.equal(o.db.getThread(threadId).presetKey, "advisor_codex");
    assert.deepEqual(turns.map(turn => turn.steered), [[], [], [], [], []]);
  }));

test("Steer restarts when live injection is unsupported and reports a failed cancellation", () =>
  orchestratorFixture("v032-steer-unsupported", async (o, params) => {
    const turns = driverFixture(o, false);
    const { threadId, runId } = await o.delegateTask({ ...params, task: "first" });
    const send = (message, opts) => o.sendToThread({ threadId, message, mode: "steer", ...opts });
    const cancel = turns[0].cancel;
    turns[0].cancel = async () => { throw new Error("cancel failed"); };
    await assert.rejects(send("failed"), /cancel failed/);
    assert.equal(o.db.getRun(runId).status, "running");
    assert.deepEqual(o.db.listQueuedRuns(threadId), []);
    const { promise: gate, resolve: release } = Promise.withResolvers();
    turns[0].cancel = async function () {
      await gate;
      await cancel.call(this);
    };
    o.db.upsertThread({ id: threadId, permissionMode: "on-request" });
    const retry = send("retry");
    try {
      await waitFor(() => turns[0].steered.length === 2, "replacement requested");
      await assert.rejects(send("concurrent Steer"), { code: "STEER_TURN_STARTING" });
      assert.deepEqual(o.db.listQueuedRuns(threadId), []);
    } finally {
      release();
    }
    assert.equal((await retry).action, "steering_restart");
    await waitFor(() => turns[1], "unsupported driver's restart");
    assert.equal(o.db.getRun(o.db.getThread(threadId).activeRunId).permissionMode, "full-access");
  }));

test("a first stop follows queue rollover and force remains bound to the original run", () =>
  orchestratorFixture("v032-stop-race", async (o, params) => {
    const turns = driverFixture(o);
    const { threadId, runId } = await o.delegateTask({ ...params, task: "first" });
    const queued = await o.sendToThread({ threadId, message: "next", mode: "queue" });
    turns[0].resolve({ status: "completed" });
    await waitFor(() => turns[1], "queued turn launched");
    assert.equal(o.db.getThread(threadId).activeRunId, queued.queuedRunId);
    const staleForce = await o.cancelTask({ threadId, expectedRunId: runId, force: true });
    assert.equal(staleForce.cancelState, "stale_run");
    assert.equal(turns[1].kills, 0);
    const stop = await o.cancelTask({ threadId, expectedRunId: runId });
    assert.equal(stop.cancelled, true);
    assert.equal(stop.runId, queued.queuedRunId);
    assert.equal(turns[1].cancels, 1);
    await waitFor(() => !o.db.getThread(threadId).activeRunId, "cancelled turn settles");
    const idle = await o.cancelTask({ threadId, expectedRunId: queued.queuedRunId });
    assert.equal(idle.cancelState, "stale_run");
    assert.equal(idle.alreadyFinished, true);
  }));

test("worktree totals include local and committed changes against the common base", () =>
  withProjectSandbox("v032-worktree-stats", async dir => {
    const cwd = project(dir, "repo");
    const write = (root, name, content) => fs.writeFileSync(path.join(root, name), content);
    const commit = (root, message) => git(root, "-c", "user.name=Fixture", "-c", "user.email=test@invalid.local", "commit", "-m", message);
    const readGit = (root, ...args) => git(root, "--no-optional-locks", ...args);
    write(cwd, ".gitignore", "ignored.txt\n");
    write(cwd, "tracked.txt", "keep\nremove\n");
    git(cwd, "add", ".");
    commit(cwd, "common base");
    const base = readGit(cwd, "rev-parse", "HEAD");
    const worktreePath = path.join(dir, "isolated");
    const cleanPath = path.join(dir, "clean");
    git(cwd, "worktree", "add", "-b", "isolated", worktreePath);
    git(cwd, "worktree", "add", "--detach", cleanPath);
    write(cwd, "main-only.txt", "on main\n");
    git(cwd, "add", "main-only.txt");
    commit(cwd, "main diverges");

    write(worktreePath, "branch.txt", "branch\n");
    git(worktreePath, "add", "branch.txt");
    commit(worktreePath, "branch diverges");
    const [cleanBranch] = (await listWorktrees({ cwd })).filter(w => w.branch === "isolated");
    assert.deepEqual([cleanBranch.dirty, cleanBranch.changedFilesCount, cleanBranch.additions, cleanBranch.deletions],
      [false, 1, 1, 0]);

    write(worktreePath, "tracked.txt", "keep\n");
    git(worktreePath, "add", "tracked.txt");
    write(worktreePath, "branch.txt", "branch\nunstaged\n");
    write(worktreePath, "新文件.txt", "untracked\nno final newline");
    write(worktreePath, "binary.dat", Buffer.from([0, 1, 2, 10]));
    write(worktreePath, "ignored.txt", "ignored\n");
    const indexBefore = readGit(worktreePath, "ls-files", "--stage");
    const stagedBefore = readGit(worktreePath, "diff", "--cached");
    const objectsBefore = readGit(cwd, "count-objects", "-v");
    const listed = await listWorktrees({ workspace: worktreePath });
    const listedFromMain = await listWorktrees({ cwd, includeMain: true });
    assert.equal(listed.length, 2);
    const isolated = listed.find(w => w.branch === "isolated");
    const clean = listed.find(w => w.id !== isolated?.id);
    assert.deepEqual([isolated.dirty, isolated.changedFilesCount, isolated.additions, isolated.deletions], [true, 4, 4, 1]);
    assert.deepEqual([clean.dirty, clean.changedFilesCount, clean.additions, clean.deletions], [false, 0, 0, 0]);
    assert.equal(listedFromMain.filter(w => w.isMain).length, 1);
    const working = await getWorktreeDiff({ worktreePath });
    assert.equal(working.baseSha, base);
    assert.deepEqual([working.changedFilesCount, working.additions, working.deletions], [4, 4, 1]);
    assert.ok(working.files.some(file => file.path === "新文件.txt"));
    assert.ok(working.files.every(file => !["main-only.txt", "ignored.txt"].includes(file.path)));
    for (const mode of ["branch_range", "committed_only"]) {
      const changed = await getWorktreeDiff({ worktreePath, mode });
      assert.equal(changed.baseSha, base);
      assert.deepEqual(changed.files.map(f => f.path), ["branch.txt"]);
      assert.deepEqual([changed.additions, changed.deletions], [1, 0]);
    }
    assert.equal(readGit(worktreePath, "ls-files", "--stage"), indexBefore);
    assert.equal(readGit(worktreePath, "diff", "--cached"), stagedBefore);
    assert.equal(readGit(cwd, "count-objects", "-v"), objectsBefore);
    await assert.rejects(getWorktreeDiff({ worktreePath: path.join(dir, "missing") }), /Worktree 路径不存在/);
  }));

test("review gates block before Git snapshot and an enabled review still captures changes", () =>
  orchestratorFixture("v032-review-gates", async (o, { cwd }, dir) => {
    const traceFile = path.join(dir, "git-trace.log").replaceAll("\\", "/");
    const previousTrace = process.env.GIT_TRACE;
    const readTrace = () => fs.existsSync(traceFile) ? fs.readFileSync(traceFile, "utf8") : "";
    const snapshotGit = /built-in: git (?:status|diff)\b/;
    fs.writeFileSync(path.join(cwd, "review.txt"), "review this\n");
    o.engineManager.runTurn = () => ({ result: Promise.resolve({ status: "completed" }) });
    process.env.GIT_TRACE = traceFile;
    try {
      await o.saveSettings({ defaultOrchestrationMode: "relay" });
      await assert.rejects(o.runCodeReview({ cwd, conversationId: "v032-relay" }), { code: "MODE_REVIEW_NOT_ALLOWED" });
      await o.saveSettings({ defaultOrchestrationMode: "complex", modeProfiles: { complex: {
        reviewer: { stageEnabled: false, enabledKeys: ["reviewer"], preferredKey: "reviewer" },
      } } });
      const disabled = await o.runCodeReview({ cwd, conversationId: "v032-disabled" });
      assert.equal(disabled.code, "review_stage_disabled");
      await o.saveSettings({ modeProfiles: { complex: { reviewer: { stageEnabled: true, enabledKeys: [], preferredKey: null } } } });
      await assert.rejects(o.runCodeReview({ cwd, conversationId: "v032-empty" }), { code: "REVIEW_POOL_EMPTY" });
      const degraded = await o.runCodeReview({ cwd, conversationId: "v032-empty", degradeToHostSelfReview: true });
      assert.equal(degraded.status, "degraded_self_review");
      assert.match(readTrace(), /built-in: git rev-parse/);
      assert.doesNotMatch(readTrace(), snapshotGit);
      await o.saveSettings({ modeProfiles: { complex: {
        reviewer: { stageEnabled: true, enabledKeys: ["reviewer"], preferredKey: "reviewer" },
      } } });
      const review = await o.runCodeReview({ cwd, conversationId: "v032-enabled", wait: true });
      assert.ok(review.runId);
      assert.ok(o.db.getRun(review.runId).meta.reviewSpec.changedPaths.includes("review.txt"));
      assert.match(readTrace(), snapshotGit);
    } finally {
      if (previousTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = previousTrace;
    }
  }));

test("force kill cleans up real descendants after the parent has exited", () =>
  withProjectSandbox("v032-exited-parent", async cwd => {
    const middleCode = `
      const { spawn } = require("node:child_process");
      const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 15000)"],
        { stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
      grandchild.once("spawn", () => {
        console.log([process.pid, grandchild.pid].join(" "));
        process.send("ready");
      });
      setTimeout(() => {}, 15000);
    `;
    const parent = spawnNoWindow(process.execPath, ["-e", `
      const { spawn } = require("node:child_process");
      const middle = spawn(process.execPath, ["-e", process.argv[1]],
        { stdio: ["ignore", "inherit", "inherit", "ipc"], windowsHide: true });
      middle.once("message", () => process.exit(0));
    `, middleCode], { cwd, detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const exited = once(parent, "exit");
    const closed = once(parent, "close");
    const pids = [];
    try {
      const [chunk] = await within(once(parent.stdout, "data"), 5000, "descendant PIDs");
      pids.push(...String(chunk).trim().split(" ").map(Number));
      assert.equal(pids.length, 2);
      for (const pid of pids) {
        assert.ok(pid > 0);
        assert.doesNotThrow(() => process.kill(pid, 0));
      }
      assert.deepEqual(await within(exited, 5000, "parent exit"), [0, null]);
      await forceKillProcessTree(parent, { processGroup: true });
      await within(closed, 5000, "descendant pipes closed");
      if (process.platform === "win32") {
        for (const pid of pids) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
      }
      await forceKillProcessTree(parent, { processGroup: true });
    } finally {
      for (const pid of pids) {
        if (pid > 0) try { process.kill(pid, "SIGKILL"); } catch {}
      }
      await forceKillProcessTree(parent, { processGroup: true });
    }
  }));

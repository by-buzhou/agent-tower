import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test from "node:test";
import { openOrchestratorDb } from "../../core/db.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { createScopePolicyModule } from "../../core/orchestrator/scope-policy.mjs";
import { createSpecsModule } from "../../core/orchestrator/specs.mjs";
import { assemblePlanPrompt, assembleSpecPrompt, readPlanDocument, readProjectSpecs, specSelection } from "../../core/spec-context.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";

const specDir = ".agent-tower/spec";
const planPath = ".agent-tower/plans/task.md";
const executorMirror = `${specDir}/00-plugin/executor.md`;
const specIndex = `${specDir}/INDEX.md`;
const evolutionIndex = ".agent-tower/docs/evolution/INDEX.md";
const write = (cwd, rel, text) => {
  const file = path.join(cwd, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const card = (cwd, id, meta, body = `BODY ${id}`) =>
  write(cwd, `${specDir}/02-coding/${id}.md`, `---\nid: ${id}\nsummary: SUMMARY ${id}\n${meta}\n---\n${body}`);
const assemble = (cwd, options = {}) => assembleSpecPrompt({ cwd, repoRoot: cwd, inventory: readProjectSpecs(cwd),
  role: "executor", rawPrompt: "", dynamicPrompt: "RAW_TASK", selection: {}, ...options }).full;
const item = (result, id) => result.meta.items.find(entry => entry.id === id);

function countOpens(t, onOpen) {
  const openSync = fs.openSync;
  return t.mock.method(fs, "openSync", (file, ...args) => {
    if (typeof file === "string") onOpen(path.normalize(file));
    return openSync(file, ...args);
  });
}

test("readPaths 安全导航，显式范围下按强弱命中投递", () => withProjectSandbox("v0210-readpaths", dir => {
  const cwd = project(dir, "repo");
  const outside = write(dir, "outside/ref.mjs", "outside");
  fs.symlinkSync(path.dirname(outside), path.join(cwd, "linked"), "junction");
  card(cwd, "reference", "scopes: [src/ref.mjs]");
  card(cwd, "strong", "scopes: [src/main.mjs]");
  card(cwd, "diff", "scopes: [src/diff.mjs]");
  card(cwd, "weak-tag", "required: true\ntags: [touchpoint]");
  card(cwd, "weak-path", "scopes: [src/outside.mjs]");
  const selection = {
    targetPaths: ["src/main.mjs"],
    readPaths: ["./src\\ref.mjs", "src/ref.mjs", "src/diff.mjs", "linked/ref.mjs", ".agent-tower/councils/secret.md", outside, "../outside/ref.mjs", "C:outside", ".git/config"],
  };
  assert.deepEqual(specSelection(selection, { cwd }).readPaths, ["src/ref.mjs", "src/diff.mjs"]);
  const rawPrompt = "查看 src/ref.mjs 和 src/diff.mjs 和 src/outside.mjs，检查 touchpoint";
  const result = assemble(cwd, { rawPrompt, selection, review: { changedPaths: ["src\\diff.mjs", "../invalid"] } });
  assert.match(result.prompt, /\[READ-ONLY REFERENCES\] "src\/ref\.mjs", "src\/diff\.mjs"/);
  assert.doesNotMatch(result.prompt, /linked\/ref|councils\/secret|BODY weak|BODY reference/);
  assert.deepEqual([item(result, "reference").reason, item(result, "reference").tier], ["read_path", "summary"]);
  assert.deepEqual([item(result, "strong").tier, item(result, "diff").reason], ["inline", "diff_path"]);
  assert.deepEqual([item(result, "weak-path").tier, item(result, "weak-tag").tier], ["summary", "summary"]);
  assert.match(result.prompt, /【若涉及此模块必读】.*weak-tag\.md/);
  assert.ok(!result.meta.warnings.some(({ code }) => code === "REQUIRED_BUDGET_DEGRADED"));
  assert.ok(result.meta.warnings.some(({ code, key }) => code === "INVALID_READ_PATH" && key === "linked/ref.mjs"));
  assert.ok(result.meta.warnings.some(({ code, key }) => code === "INVALID_READ_PATH" && key === ".agent-tower/councils/secret.md"));
  assert.ok(result.delivered.every(({ key }) => !key.includes("src/ref.mjs")));
  const both = assemble(cwd, { rawPrompt, selection: { targetPaths: ["src/ref.mjs"], readPaths: ["src/ref.mjs"] } });
  assert.equal(item(both, "reference").reason, "target_path");
  const bare = assemble(cwd, { rawPrompt });
  for (const id of ["reference", "weak-path", "weak-tag"]) assert.equal(item(bare, id).tier, "inline");
  const invalidOnly = assemble(cwd, { rawPrompt, selection: { readPaths: ["linked/ref.mjs"] } });
  assert.equal(item(invalidOnly, "weak-tag").tier, "inline");
  const onlyRead = assemble(cwd, { rawPrompt, selection: { readPaths: ["src/ref.mjs"] } });
  assert.deepEqual([item(onlyRead, "reference").reason, item(onlyRead, "reference").tier], ["read_path", "summary"]);
  assert.equal(item(onlyRead, "weak-tag").tier, "inline");
}));

test("演进按指定检索列筛选，快测仅精确匹配执行和评审的目标词干", () => withProjectSandbox("v0210-navigation", dir => {
  const cwd = project(dir, "repo");
  const rows = [
    "| `v0.2.1` | targetword | `X` |",
    "| `v0.2.10` | alpha | `core/router.mjs` |",
    `| v0.2.11 | ${"长".repeat(170)} | router |`,
    "| v0.2.12 | beta | `targetword` |",
    "| v0.2.13 | gamma | `targetword` |",
    "| v0.2.14 | delta | `targetword` |",
    "| v0.2.15 | epsilon | 探测、成员池 |",
  ];
  write(cwd, evolutionIndex, ["| 版本 | 主题 | 关键模块与检索关键词 |", "| --- | --- | --- |", ...rows].join("\n"));
  write(cwd, "tests/unit/router.test.mjs", "");
  write(cwd, "tests/integration/route.test.mjs", "");
  write(cwd, "tests/integration/router-extra.test.mjs", "");
  const options = { cwd, inventory: readProjectSpecs(cwd), role: "executor", dynamicPrompt: "RAW_TASK",
    rawPrompt: "targetword X，核对 v0.2.10", selection: { targetPaths: ["core/router.mjs"] } };
  const { full: result } = assembleSpecPrompt(options);
  assert.equal(result.prompt.match(/^\[EVOLUTION INDEX\]$/gm)?.length, 1);
  const matchesHeading = `[EVOLUTION MATCHES] ${evolutionIndex}`;
  assert.ok(result.prompt.split("\n").includes(matchesHeading));
  const selected = result.prompt.split("\n").filter(line => line.startsWith("|"));
  assert.deepEqual(selected, [rows[1], rows[3], rows[4]]);
  assert.ok(Buffer.byteLength(selected.join("\n")) <= 500);
  assert.match(result.prompt, /关联快测：node scripts\/test\.mjs router\r?\n/);
  assert.doesNotMatch(assemble(cwd, { ...options, role: "advisor" }).prompt, /关联快测/);
  assert.match(assemble(cwd, { ...options, role: "review" }).prompt, /关联快测/);
  const miss = assemble(cwd, { rawPrompt: "探测 X", selection: { targetPaths: ["core/outer.mjs"] } });
  assert.equal(miss.prompt.match(/^\[EVOLUTION INDEX\]$/gm)?.length, 1);
  assert.doesNotMatch(miss.prompt, /^\| |\[EVOLUTION MATCHES\]|关联快测/m);
  const chineseMatch = assemble(cwd, { rawPrompt: "检查成员池" });
  assert.deepEqual(chineseMatch.prompt.split("\n").filter(line => line.startsWith("|")), [rows.at(-1)]);
  const ledger = new Map(result.delivered.map(receipt => [receipt.key, receipt]));
  const { delta } = assembleSpecPrompt({ ...options, ledger });
  assert.doesNotMatch(delta.prompt, /\[EVOLUTION INDEX\]/);
  assert.ok(delta.prompt.split("\n").includes(matchesHeading));
}));

test("prepareTurn 单次读规划，argv 共享预算，预取跳过 Git，Worktree 无规划镜像", t => withProjectSandbox("v0210-worktree", dir => {
  const cwd = project(dir, "repo");
  const checkout = path.join(cwd, ".agent-tower/worktrees/branch");
  git(cwd, "worktree", "add", "--detach", checkout);
  const planFile = write(cwd, planPath, "规划正文\n- [ ] 完整检查");
  const draftPath = `${specDir}/02-coding/main-draft.md`;
  card(cwd, "main-draft", "tags: [onlydraft]");
  card(checkout, "review-diff", "scopes: [src/changed.mjs]");
  write(checkout, "src/changed.mjs", "export {};");
  const persisted = [];
  const specs = createSpecsModule({ db: { isProjectSpecEnabled: () => true, getProjectSpec: () => ({}),
    upsertRun: data => persisted.push(data), upsertTurnItem: data => persisted.push(data) } });
  const run = { id: "run", provider: "codex", prompt: "RAW_TASK", meta: {
    planPath, specIds: ["main-draft"], targetPaths: ["src/changed.mjs"], readPaths: ["ref/reader.md"],
    reviewSpec: { customPrompt: "RAW_TASK", changedPaths: ["src/changed.mjs"] },
  } };
  let planReads = 0;
  let gitCalls = 0;
  const reads = countOpens(t, file => { if (file === planFile) planReads++; });
  const spawn = childProcess.spawnSync;
  const gitMock = t.mock.method(childProcess, "spawnSync", (command, ...args) => {
    if (command === "git") gitCalls++;
    return spawn(command, ...args);
  });
  syncBuiltinESMExports();
  try {
    const prepare = transport => specs.prepareTurn({ thread: { id: "thread", workspace: cwd, role: "executor" }, run,
      cwd: path.join(checkout, "src"), preloadedTop: checkout, preloadedMainDrafts: `?? ${draftPath}\0`, transport });
    const small = prepare("argv");
    assert.match(small.freshSessionPrompt, /<agent_tower_plan.*\n规划正文/);
    assert.equal(small.freshSessionPrompt, small.deltaPrompt);
    assert.equal(planReads, 1);
    write(cwd, planPath, `- [ ] ${"大".repeat(470)}\n最后一条检查`);
    const degraded = prepare("argv");
    assert.equal(planReads, 2);
    assert.ok(degraded.deltaPrompt.includes(planFile));
    assert.doesNotMatch(degraded.deltaPrompt, /最后一条检查|<agent_tower_plan/);
    const prefix = degraded.deltaPrompt.split("[READ-ONLY REFERENCES]")[0];
    assert.ok(Buffer.byteLength(prefix) <= 2048);
    assert.ok(persisted.at(-1).meta.injectedSpecs.warnings.some(w => w.key === "plan/task" && w.code === "REQUIRED_BUDGET_DEGRADED"));
    assert.equal(item({ meta: persisted.at(-1).meta.injectedSpecs }, "review-diff").reason, "target_path");
    assert.match(prepare("stdin").deltaPrompt, /BODY main-draft/);
    assert.equal(gitCalls, 0);
    assert.equal(run.prompt, "RAW_TASK");
    assert.ok(persisted.every(data => !Object.hasOwn(data, "prompt") && !Object.hasOwn(data, "text")));
    assert.equal(fs.existsSync(path.join(checkout, ".agent-tower/plans")), false);
  } finally {
    reads.mock.restore();
    gitMock.mock.restore();
    syncBuiltinESMExports();
  }
  const huge = "字".repeat(8193);
  write(cwd, planPath, huge);
  const planDoc = readPlanDocument({ cwd: checkout, repoRoot: cwd, planPath });
  fs.unlinkSync(planFile);
  const result = assemblePlanPrompt({ cwd: checkout, repoRoot: cwd, planDoc, transport: "stdin" });
  assert.equal(result.item.tier, "pointer_degraded");
  assert.ok(result.prompt.includes(planFile));
  assert.equal(result.warnings[0].code, "REQUIRED_BUDGET_DEGRADED");
}));

test("全新与续聊变体共用一个规划快照，续聊只跳过已确认的正文", t => withProjectSandbox("v0210-plan-session", dir => {
  const cwd = project(dir, "repo");
  const file = write(cwd, planPath, "PLAN_BODY");
  const planDoc = readPlanDocument({ cwd, planPath });
  const db = openOrchestratorDb(path.join(dir, "spec.sqlite"));
  const source = { id: "thread", workspace: cwd, role: "executor", provider: "codex" };
  const run = { id: "run", threadId: source.id, provider: source.provider, prompt: "RAW_TASK", meta: { planPath } };
  let reads = 0;
  const opened = countOpens(t, name => { if (name === file) reads++; });
  try {
    db.upsertThread(source);
    db.upsertRun(run);
    db.specLedger.acknowledge({ provider: source.provider, sessionId: "old", runId: run.id, threadId: source.id,
      delivered: [{ key: "plan/task", sha256: planDoc.sha256, tier: "inline" }], injectedSpecs: {} });
    const turn = createSpecsModule({ db: { ...db, isProjectSpecEnabled: () => true, getProjectSpec: () => ({}) } }).prepareTurn({ thread: db.getThread(source.id), run, cwd, expectedSessionId: "old" });
    assert.doesNotMatch(turn.deltaPrompt, /PLAN_BODY/);
    assert.match(turn.freshSessionPrompt, /PLAN_BODY/);
    assert.equal(turn.sessionPrompt.forSession(false), turn.freshSessionPrompt);
    assert.equal(reads, 1);
  } finally {
    opened.mock.restore();
    db.close();
  }
}));

test("脚手架快路跳过镜像正文，删除 executor.md 或 INDEX.md 后自愈", t => withProjectSandbox("v0210-scaffold", dir => {
  const cwd = project(dir, "repo");
  card(cwd, "style", "");
  const module = createSpecsModule({ db: { isProjectSpecEnabled: () => true, getProjectSpec: () => ({}), upsertRun() {}, upsertTurnItem() {} } });
  const prepare = () => module.prepareTurn({ thread: { id: "thread", workspace: cwd, role: "executor" }, run: { id: "run", prompt: "task" }, cwd });
  const mirrored = path.join(cwd, executorMirror);
  const indexFile = path.join(cwd, specIndex);
  prepare();
  let mirrorReads = 0;
  const reads = countOpens(t, file => { if (file === mirrored) mirrorReads++; });
  try {
    prepare();
    assert.equal(mirrorReads, 0);
    fs.unlinkSync(mirrored);
    prepare();
    assert.equal(fs.existsSync(mirrored), true);
    fs.unlinkSync(indexFile);
    prepare();
    assert.match(fs.readFileSync(indexFile, "utf8"), /style\.md/);
  } finally { reads.mock.restore(); }
}));

test("主会话快路保留门禁和活跃宿主，设置、入口、规范和 /compact 可触发重算", t => withProjectSandbox("v0210-policy", async dir => {
  const cwd = project(dir, "repo");
  const dataDir = path.join(dir, "control");
  const tower = createOrchestrator({ dataDir, defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  tower.updateHostContext({ appDataDir: dir });
  const spec = card(cwd, "routing", "");
  const planIndex = ".agent-tower/plans/INDEX.md";
  const originalCount = tower.db.listWorkCountsByThread;
  const counts = t.mock.method(tower.db, "listWorkCountsByThread", () => originalCount());
  let specReads = 0;
  const reads = countOpens(t, file => { if (file === spec) specReads++; });
  const sync = (initialNumSteps, params) => tower.getConversationPolicy({ conversationId: "root", workspace: cwd,
    appDataDir: dir, syncHostPlaybook: true, initialNumSteps, ...params });
  try {
    tower.db.saveSettings({ defaultOrchestrationMode: "relay",
      presets: {
        executor_disabled: { provider: "antigravity", model: "inherit", group: "executor", label: "Disabled" },
        executor_enabled: { provider: "codex", model: "gpt-test", group: "executor", label: "Enabled" },
      },
      modeProfiles: { relay: { executor: { enabledKeys: ["executor_enabled"] } } } });
    const first = sync(2);
    assert.match(first.playbookInject, /agent_tower_mode/);
    const before = specReads;
    const countBefore = counts.mock.callCount();
    const gate = { hostToolName: "swarm", hostToolArgs: { action: "add", name: "executor_disabled" } };
    const hot = sync(40, gate);
    assert.equal(hot.playbookInject, null);
    assert.equal(hot.hostToolAllowed, false);
    assert.deepEqual(hot.activeMode, first.activeMode);
    assert.equal(counts.mock.callCount() - countBefore, 1);
    assert.equal(specReads, before);
    assert.match(sync(4).playbookInject, /agent_tower_mode/);
    assert.equal(specReads, before + 1);

    const stored = path.join(dataDir, "global-settings.json");
    const settings = JSON.parse(fs.readFileSync(stored, "utf8"));
    settings.defaultOrchestrationMode = "complex";
    write(dataDir, "global-settings.json", JSON.stringify(settings));
    assert.match(sync(5).playbookInject, /mode="complex"/);
    assert.equal(specReads, before + 2);
    write(cwd, planIndex, "# plans");
    assert.match(sync(6).playbookInject, /plans\/INDEX\.md/);
    assert.equal(specReads, before + 3);
    assert.equal(sync(7).playbookInject, null);
    const trellis = write(cwd, ".trellis/spec/nested/style.md", "# trellis");
    assert.equal(sync(8).playbookInject, null);
    assert.equal(specReads, before + 3);
    fs.writeFileSync(trellis, "# trellis updated");
    assert.equal(sync(9).playbookInject, null);
    assert.equal(specReads, before + 3);
    card(cwd, "routing", "", "updated");
    assert.match(sync(10).playbookInject, /coding\/routing/);
    assert.equal(sync(11).playbookInject, null);
  } finally {
    reads.mock.restore();
    counts.mock.restore();
    await tower.shutdown();
  }
}));

test("原生 PreInvocation 私密规划和评审快照，按所认领的 handoffId 去重并提示读失败", () => withProjectSandbox("v0210-native", dir => {
  const cwd = project(dir, "repo");
  write(cwd, planPath, "PLAN_SENTINEL\n- [ ] private");
  card(cwd, "raw", "tags: [taskword]");
  card(cwd, "plan-only", "tags: [PLAN_SENTINEL]");
  const child = "native-child";
  const thread = { id: "thread", role: "review", rootConversationId: "root", presetKey: "reviewer_sandbox",
    meta: { isSwarmMember: true, memberName: "reviewer-sandbox" } };
  let claimed = { handoffId: "first", planPath, role: "review", rawTask: "taskword",
    brief: "<agent_tower_plan>PLAN_SENTINEL</agent_tower_plan>", reviewFilesBlock: "<agent_tower_review_files>src/a.mjs</agent_tower_review_files>" };
  let claimCalls = 0;
  const scope = createScopePolicyModule({
    dataDir: path.join(dir, "control"), playbookFingerprints: new Map(), activeRuns: new Map(),
    latestSwarmSnapshots: new Map([["root", { members: [{ conversation_id: child, name: "reviewer-sandbox", state: "waiting" }] }]]),
    hostSync: { findThreadByHostConversationId: () => thread },
    dispatch: { findNativeHandoff: () => assert.fail("claim result should take priority"), claimNativeHandoff: params => {
      assert.equal(params.presetKey, "reviewer_sandbox");
      assert.equal(params.conversationId, child);
      claimCalls++;
      return claimed;
    } },
    db: {
      getThread: id => id === child ? thread : null, getConversationThread: () => null, isManagedChildSession: () => false,
      getConversationPolicyRecord: () => null, getSettings: () => ({ defaultOrchestrationMode: "complex" }),
      getProjectRoster: () => ({ presets: {} }), isProjectSpecEnabled: () => true, listWorkCountsByThread: () => [],
    },
  });
  const sync = () => scope.getConversationPolicy({ conversationId: child, workspace: cwd, syncHostPlaybook: true, initialNumSteps: 2 }).playbookInject;
  const first = sync();
  assert.equal(first.match(/<agent_tower_plan\b/g).length, 1);
  assert.match(first, /agent_tower_review_files>src\/a\.mjs/);
  assert.match(first, /BODY raw/);
  assert.doesNotMatch(first, /BODY plan-only|agent_tower_mode/);
  assert.equal(sync(), null);
  claimed = { ...claimed, handoffId: "second" };
  assert.equal(sync(), first, "同一成员认领新工单时，完全相同的内容也应重新投递");
  claimed = { ...claimed, handoffId: "third", planPath: ".agent-tower/plans/missing.md" };
  assert.match(sync(), /【规划读取告警】PLAN_NOT_FOUND/);
  assert.equal(sync(), null);
  assert.equal(claimCalls, 5);
}));

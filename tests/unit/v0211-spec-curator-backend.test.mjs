import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { buildInitialRosterFromProbe, mergeActivePresets } from "../../core/catalog.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { assembleSpecPrompt, buildCuratorStaticProbe, pluginSpec, readProjectSpecs } from "../../core/spec-context.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";
import { within } from "../helpers/process.mjs";

const specRoot = ".agent-tower/spec";
const business = specRoot + "/01-business/rule.md";
const coding = specRoot + "/02-coding/check.md";
const markdown = (id, body, extra = "") => `---\nid: ${id}\ntitle: ${id}\n${extra}---\n${body}\n`;
const write = (root, rel, contents) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
};
const report = data => "梳理结果\n\n```agent-tower-spec-proposal\n" + JSON.stringify(data) + "\n```\n";
const none = report({ status: "no_change", reason: "无需改动" });
const draft = (...changes) => report({ status: "propose", summary: "规则更新", changes });
const document = (action, rel, content) => ({ action, path: rel, why: "长期规则", changeSummary: "调整", mergedOrRemoved: "合并旧文", impactAndTests: "验证", content });
const completed = assistantText => ({ status: "completed", assistantText, nativeSessionId: "curator-fixture-session" });
const cases = [];
const specTest = (name, fn, { sequential = false } = {}) => cases.push({ name, fn, sequential });

function open(dir, root) {
  const tower = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: root, catalogLoader: offlineCatalog });
  tower.db.saveSettings({ defaultSpecEnabled: true });
  return tower;
}

function plainProject(dir, name) {
  const root = path.join(dir, name);
  fs.mkdirSync(root);
  return root;
}

function driver(o, result) {
  const calls = [];
  o.engineManager.runTurn = options => {
    calls.push(options);
    return { result: Promise.resolve().then(() => result(options)), cancel: async () => {}, forceKill: async () => {} };
  };
  return calls;
}

specTest("维护官角色卡独家注入，首装预填外部引擎，窄 argv 拒绝超预算", () => withProjectSandbox("c-card", dir => {
  write(dir, business, markdown("rule", "PROJECT_SPEC_ONLY", "roles: [curator]\nscopes: ['**']\n"));
  write(dir, ".trellis/spec/rule.md", markdown("rule", "TRELLIS_ONLY", "roles: [curator]\n"));
  const card = pluginSpec("curator", { withEvolution: true });
  assert.ok(card.bytes <= 1536, card.bytes);
  assert.match(card.body, /\[EVOLUTION INDEX\]/);
  assert.match(card.body, /【盲测四问】[\s\S]*【容量置换】[\s\S]*One-In-One-Out/);
  assert.doesNotMatch(card.body, /councils|HYGIENE|ROADMAP ISOLATION|GOVERNANCE BOUNDARY/);
  const opts = { cwd: dir, inventory: readProjectSpecs(dir), role: "curator", rawPrompt: "rule",
    dynamicPrompt: "task", selection: { specIds: ["rule"], targetPaths: [business] } };
  const { full } = assembleSpecPrompt(opts);
  assert.equal(full.meta.inlineCount, 0);
  assert.equal(full.meta.summaryCount, 0);
  assert.deepEqual(full.meta.items.map(item => item.key), ["plugin/curator"]);
  assert.doesNotMatch(full.prompt, /PROJECT_SPEC_ONLY|TRELLIS_ONLY|\[EVOLUTION INDEX\]|\[EVOLUTION MATCHES\]|docs\/evolution\/INDEX\.md/);
  write(dir, ".agent-tower/docs/evolution/INDEX.md", "| 版本 | 关键模块与检索关键词 |\n| --- | --- |\n| v1.0.0 | rule |");
  const withIndex = assembleSpecPrompt(opts).full.prompt;
  assert.equal(withIndex.match(/^\[EVOLUTION INDEX\]$/gm)?.length, 1);
  assert.match(withIndex, /docs\/evolution\/INDEX\.md/);
  assert.doesNotMatch(withIndex, /\[EVOLUTION MATCHES\]/);
  assert.equal(assembleSpecPrompt({ ...opts, transport: "argv" }).full.meta.pluginDelivered, true);
  assert.throws(() => assembleSpecPrompt({ ...opts, transport: "argv", dynamicPrompt: "x".repeat(2048) }),
    { code: "CURATOR_ARGV_BUDGET_EXCEEDED" });
  const available = { command: "fixture", resolvedPath: "fixture" };
  const { presets, modeProfiles } = buildInitialRosterFromProbe({
    binaries: { codex: available, "claude-code": available, "kimi-code": available, antigravity: available },
  });
  assert.deepEqual(modeProfiles.complex.curator.enabledKeys.sort(), ["curator_claude", "curator_codex", "curator_kimi"]);
  assert.equal(modeProfiles.complex.curator.preferredKey, "curator_codex");
  assert.equal(presets.curator_codex.permissionMode, "read-only");
  assert.equal(presets.curator_claude.permissionMode, "plan");
  const native = mergeActivePresets({ curator_agy: { group: "curator", provider: "antigravity" } }).curator_agy;
  assert.deepEqual([native.permissionMode, native.interactionMode, native.isolation], ["plan", "plan", "shared"]);
}));

specTest("状态和开关按项目隔离，Studio 可在 direct 启动且 no_change 无确认卡", () => withProjectSandbox("c-zero", async dir => {
  const root = plainProject(dir, "r"), blank = plainProject(dir, "b");
  const o = open(dir, root);
  const calls = driver(o, () => completed(none));
  const events = [];
  const stop = o.subscribe(event => events.push(event));
  try {
    const revision = o.db.getSettings().presetRevision;
    assert.equal(o.listProjectSpecs({ cwd: blank }).curation.autoTrigger, false);
    assert.equal((await o.specCuration({ action: "status", cwd: blank })).curation.pendingProposal, null);
    assert.equal((await o.specCuration({ action: "setAuto", cwd: blank, autoTrigger: true })).curation.autoTrigger, true);
    assert.equal((await o.specCuration({ action: "status", cwd: root })).curation.autoTrigger, false);
    assert.equal(o.db.getSettings().presetRevision, revision);
    assert.equal(fs.existsSync(path.join(blank, ".agent-tower")), false);
    assert.ok(events.some(event => event.type === "spec_curation_updated" && event.curation.autoTrigger));
    const result = await o.specCuration({ action: "trigger", cwd: blank, conversationId: "curator-direct", mode: "wait" });
    assert.equal(result.status, "completed");
    assert.equal(result.curation.pendingProposal, null);
    assert.deepEqual(result.curation.recentProposals, []);
    assert.equal(result.curation.lastNoChange.reason, "无需改动");
    assert.equal(calls[0].permissionMode, "read-only");
    assert.equal(calls[0].interactionMode, "plan");
    assert.doesNotMatch(calls[0].prompt, /\[EVOLUTION INDEX\]|docs\/evolution\/INDEX\.md/);
    assert.equal(fs.existsSync(path.join(blank, specRoot)), false);
    assert.equal((await o.getBootstrap({ workspace: blank, conversationId: "curator-direct" })).specCuration.autoTrigger, true);
    await o.saveSettings({ modeProfiles: { complex: { curator: { enabledKeys: [] } } } });
    await assert.rejects(o.specCuration({ action: "setAuto", cwd: root, autoTrigger: true }), { code: "CURATOR_ROSTER_EMPTY" });
  } finally { stop(); await o.shutdown(); }
}));

specTest("外部引擎及排队、配置和重试的锁定，越权写盘作废", () => withProjectSandbox("c-lock", async dir => {
  const root = plainProject(dir, "r");
  const o = open(dir, root);
  let release;
  const calls = driver(o, options => {
    if (calls.length === 1) return new Promise(resolve => { release = resolve; });
    if (calls.length === 4) write(root, business, markdown("rule", "私改"));
    assert.equal(options.onPermissionRequest, undefined);
    return completed(calls.length === 4 ? draft(document("create", coding, markdown("check", "skip"))) : none);
  });
  try {
    await o.saveSettings({ defaultOrchestrationMode: "relay", presets: {
      curator_claude: { group: "curator", provider: "claude-code", model: "claude-opus-5-5", permissionMode: "bypassPermissions" },
    }, modeProfiles: { complex: { curator: { enabledKeys: ["curator_codex", "curator_claude"] } } } });
    const first = await o.delegateTask({ cwd: root, role: "curator", provider: "claude-code",
      permissionMode: "bypassPermissions", interactionMode: "default", isolation: "worktree", task: "inspect" });
    const key = { threadId: first.threadId };
    assert.equal(o.db.getThread(first.threadId).isolation, "shared");
    await assert.rejects(o.specCuration({ action: "trigger", cwd: root }), { code: "CURATOR_ALREADY_RUNNING" });
    const queued = await o.sendToThread({ ...key, mode: "queue", message: "queued", permissionMode: "bypassPermissions" });
    assert.equal(o.db.getRun(queued.queuedRunId).permissionMode, "plan");
    const finishQueue = new Promise(resolve => {
      const stop = o.subscribe(event => {
        if (event.type === "run_completed" && event.runId === queued.queuedRunId) { stop(); resolve(); }
      });
    });
    release(completed(none));
    await finishQueue;
    const { thread } = await o.configureThread({ ...key, role: "executor", permissionMode: "bypassPermissions", isolation: "worktree" });
    assert.equal(thread.role, "curator");
    assert.equal(thread.permissionMode, "plan");
    assert.equal(thread.isolation, "shared");
    await o.retryRun({ ...key, wait: true, permissionMode: "bypassPermissions" });
    assert.ok(calls.every(call => call.permissionMode === "plan" && call.interactionMode === "plan"));
    const violated = await o.specCuration({ action: "trigger", cwd: root, mode: "wait" });
    assert.equal(violated.status, "failed");
    assert.equal(o.db.getRun(violated.runId).meta.errorCode, "CURATOR_SPEC_WRITE_DETECTED");
    assert.equal(violated.curation.pendingProposal, null);
  } finally { release?.(completed(none)); await o.shutdown(); }
}));

specTest("提案出卡预检、跨重启保留、CAS 整组冲突及重拟续聊后落盘", () => withProjectSandbox("c-cas", async dir => {
  const root = plainProject(dir, "r");
  const args = { cwd: root, conversationId: "curator-proposals" };
  const previous = markdown("rule", "old");
  write(root, business, previous);
  write(root, "tests/unit/existing.test.mjs", "");
  let o = open(dir, root);
  const firstDraft = draft(document("update", business, markdown("rule", "new", "tests: [existing]\n")),
    document("create", coding, markdown("check", "first")));
  try {
    driver(o, () => completed(firstDraft));
    const { curation } = await o.specCuration({ ...args, action: "trigger", mode: "wait" });
    const first = curation.pendingProposal;
    assert.equal(first.status, "pending");
    assert.equal(first.changes[0].oldContent, previous);
    assert.match(first.changes[0].diffPreview, /-old[\s\S]*\+new/);
    assert.equal(first.changes[0].baseSha256.length, 64);
    assert.equal(first.changes[1].baseSha256, null);
    await o.shutdown();
    o = open(dir, root);
    assert.equal((await o.specCuration({ ...args, action: "status" })).curation.pendingProposal.id, first.id);
    write(root, business, markdown("rule", "external edit"));
    await assert.rejects(o.specCuration({ ...args, action: "confirm", proposalId: first.id }), { code: "SPEC_PROPOSAL_CONFLICT" });
    assert.equal(fs.existsSync(path.join(root, coding)), false);
    assert.match(fs.readFileSync(path.join(root, business), "utf8"), /external edit/);
    await assert.rejects(o.specCuration({ ...args, action: "revise", proposalId: first.id, feedback: " " }), { code: "CURATOR_FEEDBACK_REQUIRED" });
    const calls = driver(o, () => completed(draft(document("delete", business), document("create", coding, markdown("check", "final")))));
    const revised = await o.specCuration({ ...args, action: "revise", proposalId: first.id, feedback: "合并到工程规范" });
    assert.equal(revised.threadId, first.threadId);
    assert.equal(calls[0].nativeSessionId, undefined);
    assert.equal(calls[0].ephemeral, true);
    assert.match(String(calls[0].prompt), /\[Local Continuation Context\][\s\S]*Latest Conclusion/);
    assert.match(calls[0].prompt, /合并到工程规范/);
    const current = (await o.specCuration({ ...args, action: "status" })).curation;
    assert.equal(current.recentProposals.find(item => item.id === first.id).status, "superseded");
    const confirm = await o.specCuration({ ...args, action: "confirm", proposalId: current.pendingProposal.id });
    assert.equal(confirm.status, "applied");
    assert.equal(fs.existsSync(path.join(root, business)), false);
    assert.match(fs.readFileSync(path.join(root, specRoot, "INDEX.md"), "utf8"), /02-coding\/check\.md/);
    assert.match(fs.readFileSync(path.join(root, specRoot, "00-plugin/curator.md"), "utf8"), /SPEC CURATOR/);

    driver(o, () => completed(draft(document("create", business, markdown("rule", "x".repeat(2049), "roles: [curator, ghost_role]\ntests: [missing]\n")),
      document("create", specRoot + "/00-plugin/blocked.md", markdown("blocked", "blocked")))));
    const invalid = (await o.specCuration({ ...args, action: "trigger", mode: "wait" })).curation.recentProposals[0];
    assert.equal(invalid.status, "invalid");
    assert.match(invalid.changes[0].preflightIssues.join(" "), /2048 B.*curator.*ghost_role.*missing/);
    assert.equal(invalid.changes[1].preflightOk, false);
    const dismissed = await o.specCuration({ ...args, action: "dismiss", proposalId: invalid.id });
    assert.equal(dismissed.proposal.status, "dismissed");
    assert.equal(calls.length, 1);
  } finally { await o.shutdown(); }
}));

specTest("非宿主复杂模式只在无在途时依新完结水位触发一次", () => withProjectSandbox("c-auto", async dir => {
  const root = plainProject(dir, "r");
  const o = open(dir, root);
  const conversationId = "curator-auto";
  let release;
  const calls = driver(o, options => options.prompt.includes("[ROLE: SPEC CURATOR]") ? completed(none)
    : calls.length === 1 ? new Promise(resolve => { release = resolve; }) : completed("work finished"));
  try {
    await o.setConversationPolicy({ cwd: root, conversationId, orchestrationMode: "complex" });
    await o.specCuration({ action: "setAuto", cwd: root, conversationId, autoTrigger: true });
    await o.delegateTask({ cwd: root, conversationId, presetKey: "executor_codex", task: "long work" });
    await o.delegateTask({ cwd: root, conversationId, presetKey: "executor_kimi", task: "short work", mode: "wait" });
    await delay(285);
    assert.equal(calls.length, 2);
    const auto = new Promise(resolve => {
      const stop = o.subscribe(event => {
        if (event.type === "spec_curation_updated" && event.curation.lastNoChange?.triggerSource === "auto") {
          stop(); resolve(event);
        }
      });
    });
    release(completed("done"));
    await Promise.race([auto, delay(850)]);
    assert.equal(calls.length, 3);
    assert.match(calls[2].prompt, /SPEC CURATOR/);
    await delay(285);
    assert.equal(calls.length, 3);
  } finally { release?.(completed("done")); await o.shutdown(); }
}));

specTest("工作树合入对工作区修改与已提交修改均拒绝绕过提案", () => withProjectSandbox("c-wt", async dir => {
  const root = project(dir, "r");
  const wt = path.join(dir, "w");
  git(root, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-b", "fixture", wt);
  const o = open(dir, root);
  try {
    write(wt, business, markdown("rule", "worktree edit"));
    const target = { cwd: root, worktreePath: wt };
    await assert.rejects(o.integrateWorktree(target), { code: "SPEC_WRITE_FORBIDDEN_IN_WORKTREE" });
    git(wt, "add", business);
    git(wt, "-c", "user.name=Test", "-c", "user.email=test@invalid.local", "commit", "-m", "spec");
    await assert.rejects(o.integrateWorktree(target), { code: "SPEC_WRITE_FORBIDDEN_IN_WORKTREE" });
    assert.equal(fs.existsSync(path.join(root, business)), false);
  } finally { await o.shutdown(); }
}));

specTest("原生宿主尚未 isSettled 时阻断自动维护，收尾后触发", () => withProjectSandbox("c-host", async dir => {
  const root = plainProject(dir, "r"), appDataDir = plainProject(dir, "h");
  const o = open(dir, root);
  const conversationId = "11111111-1111-4111-8111-111111111111";
  const params = { cwd: root, workspace: root, appDataDir, conversationId };
  const transcript = `brain/${conversationId}/.system_generated/logs/transcript.jsonl`;
  const step = (type, step_index, extra) => JSON.stringify({ type, step_index, created_at: new Date().toISOString(), ...extra }) + "\n";
  write(appDataDir, transcript, step("USER_INPUT", 1, { content: "work" }) +
    step("PLANNER_RESPONSE", 2, { status: "DONE", tool_calls: [{ name: "read_file", args: { path: "a" } }] }));
  const calls = driver(o, options => completed(options.prompt.includes("[ROLE: SPEC CURATOR]") ? none : "done"));
  try {
    await o.setConversationPolicy({ ...params, orchestrationMode: "complex" });
    await o.specCuration({ ...params, action: "setAuto", autoTrigger: true });
    await o.getBootstrap(params);
    await o.delegateTask({ ...params, presetKey: "executor_codex", task: "inspect", mode: "wait" });
    await delay(260);
    assert.equal(calls.length, 1);
    fs.appendFileSync(path.join(appDataDir, transcript), step("GENERIC", 3, { status: "DONE", content: "read" }) +
      step("PLANNER_RESPONSE", 4, { status: "DONE", content: "finished", tool_calls: [] }));
    const auto = new Promise(resolve => {
      const stop = o.subscribe(event => {
        if (event.type === "spec_curation_updated" && event.curation.lastNoChange?.triggerSource === "auto") {
          stop(); resolve(event);
        }
      });
    });
    await o.getBootstrap(params);
    await within(auto, 5000, "settled host auto-curation");
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /SPEC CURATOR/);
  } finally { await o.shutdown(); }
}));

specTest("整组提交途中写入失败会恢复已替换文件，原提案可重试", () => withProjectSandbox("c-rb", async dir => {
  const root = plainProject(dir, "r");
  const o = open(dir, root);
  const original = markdown("rule", "old");
  write(root, business, original);
  write(root, coding, markdown("check", "old check"));
  driver(o, () => completed(draft(document("update", business, markdown("rule", "new")),
    document("update", coding, markdown("check", "new check")))));
  try {
    const launched = await o.specCuration({ cwd: root, action: "trigger", mode: "wait" });
    const proposalId = launched.curation.pendingProposal.id;
    const confirm = { cwd: root, action: "confirm", proposalId };
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      if (to === path.join(root, coding)) throw new Error("injected rename failure");
      return rename(from, to);
    };
    try {
      await assert.rejects(o.specCuration(confirm), /injected rename failure/);
    } finally { fs.renameSync = rename; }
    assert.equal(fs.readFileSync(path.join(root, business), "utf8"), original);
    assert.deepEqual(fs.readdirSync(path.join(root, specRoot, "01-business")), ["rule.md"]);
    assert.equal((await o.specCuration({ cwd: root, action: "status" })).curation.pendingProposal.id, proposalId);
    assert.equal((await o.specCuration(confirm)).proposal.status, "applied");
  } finally { await o.shutdown(); }
}), { sequential: true });

specTest("新有效提案替换旧 pending，no_change 与 invalid 不误杀待确认提案，直出重拟不残留权限后门", () => withProjectSandbox("c-race", async dir => {
  const root = plainProject(dir, "r"), other = plainProject(dir, "o");
  const o = open(dir, root);
  let seq = 0;
  driver(o, () => {
    seq += 1;
    if (seq === 1) return completed(draft(document("create", business, markdown("rule", "v1"))));
    if (seq === 2) return completed(draft(document("create", business, markdown("rule", "v2"))));
    if (seq === 3) return completed(none);
    if (seq === 4) return completed(draft(document("create", business, markdown("rule", "v4"))));
    return completed(draft(
      document("create", ".agent-tower/spec/01-business/INDEX.md", markdown("idx", "bad")),
      document("create", ".agent-tower/spec/01-business/.hidden.md", markdown("hid", "bad")),
    ));
  });
  try {
    const convA = "aaaa1111-1111-4111-8111-111111111111";
    const convB = "bbbb2222-2222-4222-8222-222222222222";
    const convOther = "cccc3333-3333-4333-8333-333333333333";
    await o.setConversationPolicy({ conversationId: convA, workspace: root, orchestrationMode: "complex" });
    await o.setConversationPolicy({ conversationId: convB, workspace: root, orchestrationMode: "relay" });
    await o.setConversationPolicy({ conversationId: convOther, workspace: other, orchestrationMode: "complex" });

    // 1) Run #1 -> pending sprop_1; Run #2 -> pending sprop_2 supersedes sprop_1 (dismissing sprop_2 leaves no zombie pending)
    const r1 = await o.specCuration({ cwd: root, conversationId: convA, action: "trigger", mode: "wait" });
    const p1 = r1.curation.pendingProposal.id;
    const r2 = await o.specCuration({ cwd: root, conversationId: convA, action: "trigger", mode: "wait" });
    const p2 = r2.curation.pendingProposal.id;
    assert.notEqual(p1, p2);
    assert.equal(o.db.getSpecProposal(root, p1).status, "superseded");

    // 2) Run #3 (delegate curator) -> no_change preserves unconfirmed pending p2!
    const sinceBefore = o.db.getLatestSeq();
    await o.delegateTask({ cwd: root, workspace: root, conversationId: convA, role: "curator", task: "check", mode: "wait" });
    assert.equal(o.db.getSpecProposal(root, p2).status, "pending");
    assert.equal((await o.specCuration({ cwd: root, action: "status" })).curation.pendingProposal.id, p2);

    // Run #4 (delegate) -> valid p4 supersedes p2; switch convA to direct and revise without mutating persistent triggerSource!
    await o.setConversationPolicy({ conversationId: convA, workspace: root, orchestrationMode: "complex" });
    await o.delegateTask({ cwd: root, workspace: root, conversationId: convA, role: "curator", task: "propose", mode: "wait" });
    assert.equal(o.db.getSpecProposal(root, p2).status, "superseded");
    const p4 = (await o.specCuration({ cwd: root, action: "status" })).curation.pendingProposal.id;
    await o.setConversationPolicy({ conversationId: convA, workspace: root, orchestrationMode: "direct" });
    const revised = await o.specCuration({ cwd: root, conversationId: convA, action: "revise", proposalId: p4, feedback: "检查路径安全" });
    assert.equal(revised.supersededProposalId, p4);
    assert.notEqual(o.db.getThread(revised.threadId).meta?.triggerSource, "manual");
    await delay(80);
    const afterRevise = (await o.specCuration({ cwd: root, action: "status" })).curation;
    assert.equal(afterRevise.pendingProposal, null);
    assert.equal(afterRevise.recentProposals[0].status, "invalid");
    assert.equal(afterRevise.recentProposals[0].changes.every(c => !c.preflightOk), true);

    // 3) Same-project convB receives spec_curation_updated via getEvents; cross-project convOther does NOT
    const pageB = await o.getEvents({ conversationId: convB, workspace: root, sinceSeq: sinceBefore });
    const pageOther = await o.getEvents({ conversationId: convOther, workspace: other, sinceSeq: sinceBefore });
    assert.ok(pageB.events.some(ev => ev.type === "spec_curation_updated" && ev.curation));
    assert.equal(pageOther.events.some(ev => ev.type === "spec_curation_updated"), false);

    // 4) review_code rejects curator preset with PRESET_NOT_IN_MODE
    await o.setConversationPolicy({ conversationId: convB, workspace: root, orchestrationMode: "complex" });
    await assert.rejects(
      o.runCodeReview({ cwd: root, workspace: root, conversationId: convB, presetKey: "curator_codex", scope: "uncommitted" }),
      { code: "PRESET_NOT_IN_MODE" },
    );
  } finally { await o.shutdown(); }
}));

specTest("原生 Swarm 协调者会话收口后不会死锁复杂模式自动维护", () => withProjectSandbox("c-swarm", async dir => {
  const root = project(dir, "s");
  const appDataDir = plainProject(dir, "appdata");
  const o = open(dir, root);
  const conversationId = "dddd4444-4444-4444-8444-444444444444";
  const workerConvId = "eeee5555-5555-4555-8555-555555555555";
  const params = { cwd: root, workspace: root, appDataDir, conversationId };
  const step = (type, step_index, extra) => JSON.stringify({ type, step_index, created_at: new Date().toISOString(), ...extra }) + "\n";
  write(appDataDir, `brain/${conversationId}/.system_generated/swarm/members.json`, JSON.stringify({
    title: "Swarm Auto Curate",
    members: {
      coordinator: { role: "coordinator", conversation_id: conversationId },
      executor_hydrogen: { role: "worker", conversation_id: workerConvId, wake_mode: "mentions" },
    },
  }));
  write(appDataDir, `brain/${conversationId}/.system_generated/logs/transcript.jsonl`,
    step("USER_INPUT", 1, { content: "run swarm" }) +
    step("PLANNER_RESPONSE", 2, { status: "DONE", content: "all done", tool_calls: [] }));
  write(appDataDir, `brain/${workerConvId}/.system_generated/logs/transcript.jsonl`,
    step("USER_INPUT", 1, { content: "worker brief" }) +
    step("PLANNER_RESPONSE", 2, { status: "DONE", tool_calls: [{ name: "swarm_wait", args: { since: 1 } }] }) +
    step("GENERIC", 3, { status: "DONE", content: "parked" }));
  const calls = driver(o, options => completed(options.prompt.includes("[ROLE: SPEC CURATOR]") ? none : "done"));
  try {
    await o.setConversationPolicy({ ...params, orchestrationMode: "complex" });
    await o.specCuration({ ...params, action: "setAuto", autoTrigger: true });
    const auto = new Promise(resolve => {
      const stop = o.subscribe(event => {
        if (event.type === "spec_curation_updated" && event.curation.lastNoChange?.triggerSource === "auto") {
          stop();
          resolve(event);
        }
      });
    });
    await o.getBootstrap(params);
    await within(auto, 5000, "settled swarm auto-curation");
    assert.equal(calls.length, 1);
    assert.match(calls[0].prompt, /SPEC CURATOR/);
  } finally { await o.shutdown(); }
}));

specTest("静态漂移探针识别改动撞域、跨语言 tests、死符号、总水位与高水位，且隔离会审目录与正文", () => withProjectSandbox("c-probe", dir => {
  const root = project(dir, "p");
  write(root, "src/order.mjs", "export const ok = 1;\n");
  write(root, "tests/py/test_orders.py", "def test_ok(): pass\n");
  write(root, ".agent-tower/councils/2026-11-25-secret.md", "SECRET_COUNCIL");
  write(root, ".agent-tower/spec/01-business/orders.md",
    markdown("orders", "ORDER_BODY_ `legacy_dead_flag` " + "x".repeat(1630), 'scopes: ["src/order.mjs"]\ntests: ["tests/py/test_orders.py"]\n'));
  write(root, ".agent-tower/spec/02-coding/stale.md",
    markdown("stale", "STALE_BODY_TEXT", 'scopes: ["src/deleted-module.mjs"]\ntests: ["missing-suite"]\n'));
  const probe = buildCuratorStaticProbe(root);
  assert.match(probe, /\[CURATOR STATIC PROBE\]/);
  assert.match(probe, /规范总水位：共 2 篇/);
  assert.match(probe, /近期变更文件.*src\/order\.mjs/);
  assert.match(probe, /疑似漂移规范.*business\/orders \(\.agent-tower\/spec\/01-business\/orders\.md\) <= src\/order\.mjs/);
  assert.match(probe, /失效死路标告警.*coding\/stale.*scopes=\["src\/deleted-module\.mjs"\].*tests=\["missing-suite"\]/);
  assert.doesNotMatch(probe, /失效死路标告警[^\n]*test_orders\.py/);
  assert.match(probe, /疑似失效代码符号.*business\/orders => `legacy_dead_flag`/);
  assert.match(probe, /高水位容量预警.*business\/orders \(\d+B\/2048B\)/);
  assert.doesNotMatch(probe, /councils|SECRET_COUNCIL|ORDER_BODY_|STALE_BODY_TEXT/);
  const { full } = assembleSpecPrompt({ cwd: root, repoRoot: root, inventory: readProjectSpecs(root),
    role: "curator", rawPrompt: "check", dynamicPrompt: "检查规范" });
  assert.match(full.prompt, /\[CURATOR STATIC PROBE\]/);
  assert.doesNotMatch(full.prompt, /ORDER_BODY_|STALE_BODY_TEXT|councils/);
  const narrow = assembleSpecPrompt({ cwd: root, repoRoot: root, inventory: readProjectSpecs(root),
    role: "curator", rawPrompt: "check", dynamicPrompt: "检查规范", transport: "argv" });
  assert.doesNotMatch(narrow.full.prompt, /\[CURATOR STATIC PROBE\]/);

  // 干活子 Agent 零命中时自动附带 <=1536B 的 [SPEC ROUTING CATALOG]，同会话续聊按账本去重
  const inv = readProjectSpecs(root);
  const zeroHit = assembleSpecPrompt({ cwd: root, repoRoot: root, inventory: inv, role: "executor", rawPrompt: "无关任务", dynamicPrompt: "WORK" });
  assert.equal(zeroHit.full.meta.deliveredCount, 0);
  assert.match(zeroHit.full.prompt, /\[SPEC ROUTING CATALOG\][\s\S]*business\/orders[\s\S]*coding\/stale/);
  assert.doesNotMatch(zeroHit.full.prompt, /ORDER_BODY_|STALE_BODY_TEXT/);
  const ledger = new Map(zeroHit.full.delivered.map(d => [d.key, d]));
  const zeroHitResumed = assembleSpecPrompt({ cwd: root, repoRoot: root, inventory: inv, role: "executor", rawPrompt: "第二轮无关任务", dynamicPrompt: "WORK2", ledger });
  assert.doesNotMatch(zeroHitResumed.delta.prompt, /\[SPEC ROUTING CATALOG\]/);
}));

specTest("按项目独立设置单篇与总上限（setLimits）：空白仓零写盘、参数护栏、动态复核提案与 16KiB 单次注入隔离", () => withProjectSandbox("c-limits", async dir => {
  const projA = project(dir, "proj-a");
  const projB = project(dir, "proj-b");
  const blank = plainProject(dir, "blank-proj");
  const o = open(dir, projA);
  write(projA, "tests/unit/v0211-spec-curator-backend.test.mjs", "// ok\n");
  try {
    // 1. 空白项目设置配额：仅写控制目录 global-settings.json，目标空白目录保持 0 文件写入
    const blankRes = await o.specCuration({ action: "setLimits", cwd: blank, workspace: blank, singleMaxKb: 4, totalMaxKb: 32 });
    assert.deepEqual([blankRes.singleMaxKb, blankRes.totalMaxKb], [4, 32]);
    assert.deepEqual(fs.readdirSync(blank), [], "空白项目修改规范配额严禁落地任何目录或 SQLite");

    // 2. 参数护栏：越界或 totalMaxKb < singleMaxKb * 2 直接报 INVALID_SPEC_LIMITS
    for (const bad of [{ singleMaxKb: 0, totalMaxKb: 16 }, { singleMaxKb: 9, totalMaxKb: 32 }, { singleMaxKb: 4, totalMaxKb: 4 }, { singleMaxKb: 2, totalMaxKb: 256 }, { singleMaxKb: 2.5, totalMaxKb: 16 }]) {
      await assert.rejects(() => o.specCuration({ action: "setLimits", cwd: projA, workspace: projA, ...bad }), { code: "INVALID_SPEC_LIMITS" });
    }

    // 3. 项目间严格独立：projA 默认 2KB/16KB 拦下 3250B 新规范，调高至 4KB/48KB 后既有 invalid 提案原地转正为 pending，而 projB 仍为 2KB/16KB
    const bigBody = "规则正文_".repeat(250); // ~3251 B (> 2048 B, <= 4096 B)
    let mode = "propose";
    const calls = driver(o, () => completed(mode === "propose" ? draft({
      action: "create",
      path: ".agent-tower/spec/01-business/domain-a.md",
      why: "沉淀大模块业务规则",
      changeSummary: "新增 domain-a",
      mergedOrRemoved: "",
      impactAndTests: "v0211-spec-curator-backend",
      content: markdown("domain-a", bigBody, 'tests: ["v0211-spec-curator-backend"]\n'),
    }) : none));
    await o.specCuration({ action: "trigger", cwd: projA, workspace: projA, mode: "wait" });
    let stA = (await o.specCuration({ action: "status", cwd: projA, workspace: projA })).curation;
    assert.deepEqual([stA.singleMaxKb, stA.totalMaxKb, stA.pendingProposal], [2, 16, null]);
    assert.equal(stA.recentProposals[0].status, "invalid");
    assert.match(stA.recentProposals[0].changes[0].preflightIssues.join(";"), /正文超过 2048 B/);

    // 调高 projA 配额至 4KB / 48KB -> 原 invalid 提案无需重跑 LLM 直接复核转正为 pending，且可正常 confirm 落盘
    const raised = await o.specCuration({ action: "setLimits", cwd: projA, workspace: projA, singleMaxKb: 4, totalMaxKb: 48 });
    assert.deepEqual([raised.curation.singleMaxKb, raised.curation.totalMaxKb], [4, 48]);
    assert.ok(raised.curation.pendingProposal?.preflightOk, "调高上限后仅因字数超限的提案应自动复核通过");
    const stB = (await o.specCuration({ action: "status", cwd: projB, workspace: projB })).curation;
    assert.deepEqual([stB.singleMaxKb, stB.totalMaxKb], [2, 16], "另一项目保持独立默认配额");

    await o.specCuration({ action: "confirm", cwd: projA, workspace: projA, proposalId: raised.curation.pendingProposal.id });
    const listA = o.listProjectSpecs({ cwd: projA, workspace: projA });
    assert.equal(listA.warnings.length, 0, "4KB 上限下 3.4KB 规范零超限告警");
    assert.equal(listA.specLimits.singleMaxBytes, 4096);

    // 4. 维护官角色卡与静态探针动态读取 4096B / 80%(3277B) / 49152B；切换 autoTrigger 不冲掉已存配额
    mode = "none";
    await o.specCuration({ action: "setAuto", cwd: projA, workspace: projA, autoTrigger: true });
    assert.deepEqual([(await o.specCuration({ action: "status", cwd: projA, workspace: projA })).curation.singleMaxKb,
      (await o.specCuration({ action: "status", cwd: projA, workspace: projA })).curation.totalMaxKb], [4, 48]);
    await o.specCuration({ action: "trigger", cwd: projA, workspace: projA, mode: "wait" });
    assert.match(calls.at(-1).prompt, /正文 <= 4096 B[\s\S]*>= 3277 B/);
    assert.match(calls.at(-1).prompt, /总正文 \d+B \/ 49152B/);

    // 5. 存量总上限放宽至 48KB 后，单次子 Agent 注入包仍严格受 16KiB 护栏保护（超预算选读规范自动降级 summary）
    for (let i = 1; i <= 6; i++) {
      write(projA, `.agent-tower/spec/02-coding/mod-${i}.md`,
        markdown(`mod-${i}`, `MOD_${i}_` + "y".repeat(3600), 'kind: coding\nrequired: false\ntags: ["bulk_hit"]\n'));
    }
    const bundle = assembleSpecPrompt({
      cwd: projA, repoRoot: projA, inventory: readProjectSpecs(projA), role: "executor",
      rawPrompt: "处理 bulk_hit 相关逻辑", dynamicPrompt: "WORK", specLimits: { singleMaxKb: 4, totalMaxKb: 48 },
    });
    assert.ok(bundle.full.meta.specBytes <= 18_500 && bundle.full.meta.inlineCount >= 3 && bundle.full.meta.summaryCount >= 2,
      `存量扩容后单次注入仍受 16KiB 护栏约束: inline=${bundle.full.meta.inlineCount}, summary=${bundle.full.meta.summaryCount}, bytes=${bundle.full.meta.specBytes}`);
  } finally { await o.shutdown(); }
}));

specTest("主会话在三种模式只提交提案，按会话隔离并在打回后重新取准则", () => withProjectSandbox("c-host-main", async dir => {
  const cwd = plainProject(dir, "r");
  const o = open(dir, cwd);
  const args = { cwd, conversationId: "main", sessionId: "main-session" };
  const curate = (action, params = {}) => o.specCuration({ ...args, ...params, action });
  try {
    await o.saveSettings({ modeProfiles: { complex: { curator: { enabledKeys: [] } } } });
    await assert.rejects(curate("submit", { status: "no_change", reason: "none" }), { code: "CURATOR_SESSION_NOT_FOUND" });
    for (const orchestrationMode of ["direct", "relay", "complex"]) {
      await o.setConversationPolicy({ ...args, orchestrationMode });
      const initial = await curate("begin");
      assert.match(initial.prompt, /ROLE: SPEC CURATOR/);
      assert.equal(initial.curation.activeExecutorKind, "host_main");
      assert.equal((await curate("begin")).runId, initial.runId);
      await assert.rejects(curate("submit", { sessionId: "other", rawText: none }), { code: "CURATOR_SESSION_NOT_FOUND" });
      await assert.rejects(curate("submit", { status: "propose", changes: [] }), { code: "CURATOR_INVALID_PROPOSAL" });
      assert.equal((await curate("submit", { status: "no_change", reason: "none" })).status, "no_change");
    }
    await curate("begin");
    const pending = await curate("submit", { status: "propose", summary: "prior",
      changes: [document("create", business, markdown("rule", "new"))] });
    assert.equal(pending.proposal.executorKind, "host_main");
    assert.equal(pending.status, "pending");
    assert.equal(fs.existsSync(path.join(cwd, business)), false);
    const revise = await curate("revise", { proposalId: pending.proposal.id, feedback: "clarify" });
    assert.equal(revise.status, "waiting_host_dispatch");
    assert.equal(revise.curation.awaitingHost, true);
    assert.match(revise.hostAction.hostPrompt, /AgentTower Curation Ticket.*spec_curation/);
    const revisionBegin = JSON.parse(/spec_curation\((\{.*?\})\)/.exec(revise.hostAction.hostPrompt)[1]);
    assert.match((await o.specCuration(revisionBegin)).prompt, /prior[\s\S]*clarify/);
    write(cwd, business, markdown("rule", "changed elsewhere"));
    await assert.rejects(curate("submit", { sessionId: revisionBegin.sessionId, rawText: none }), { code: "CURATOR_SPEC_WRITE_DETECTED" });
    assert.equal((await curate("status")).curation.running, false);
    await curate("begin");
    assert.equal((await curate("cancelTicket")).cancelled, true);
    const next = await curate("begin");
    assert.equal((await curate("cancelTicket", { runId: pending.runId })).cancelled, false);
    assert.equal((await curate("status")).curation.activeRunId, next.runId);
    await curate("cancelTicket");
    await curate("begin");
    const replacement = await curate("submit", { rawText: draft(document("update", business, markdown("rule", "new"))) });
    const ticket = await curate("revise", { proposalId: replacement.proposal.id, feedback: "redo" });
    const beginArgs = JSON.parse(/spec_curation\((\{.*?\})\)/.exec(ticket.hostAction.hostPrompt)[1]);
    await curate("cancelTicket", { runId: ticket.runId });
    await assert.rejects(o.specCuration(beginArgs), { code: "CURATOR_SESSION_NOT_FOUND" });
    await curate("setEnabled", { enabled: false });
    await assert.rejects(curate("begin"), { code: "SPEC_DISABLED_FOR_PROJECT" });
  } finally { await o.shutdown(); }
}));

specTest("原生 research 票据单次放行，注入用户上下文并通过实时转录幂等结算", () => withProjectSandbox("c-native-research", async dir => {
  const cwd = plainProject(dir, "r"), appDataDir = plainProject(dir, "h");
  const o = open(dir, cwd);
  const conversationId = "de100000-1111-4111-8111-111111111111";
  const child = "de200000-1111-4111-8111-111111111111";
  const args = { cwd, workspace: cwd, conversationId, appDataDir };
  const transcript = id => `brain/${id}/.system_generated/logs/transcript.jsonl`;
  const step = (type, step_index, content) => JSON.stringify({
    type, step_index, content, status: "DONE", created_at: new Date().toISOString(),
  }) + "\n";
  write(appDataDir, transcript(conversationId), step("USER_INPUT", 1, "真实规范原话") +
    step("USER_INPUT", 2, "[AgentTower Curation Ticket] 控制消息甲") +
    step("USER_INPUT", 3, "[AgentTower Auto-Curation] 控制消息乙") +
    step("USER_INPUT", 4, "请执行宿主原生派遣票据 #hnd_fixture 控制消息丙"));
  o.updateHostContext({ appDataDir });
  const curate = (action, extra = {}) => o.specCuration({ ...args, action, ...extra });
  try {
    await o.saveSettings({ presets: { curator_agy: { group: "curator", provider: "antigravity", model: "flash" } },
      modeProfiles: { complex: { curator: { enabledKeys: ["curator_agy"] } } } });
    await o.getBootstrap(args);
    const expired = await curate("trigger", { ticketTtlMs: 35 });
    assert.equal(expired.curation.awaitingHost, true);
    await delay(60);
    assert.equal((await curate("status")).curation.running, false);
    const started = await curate("trigger");
    assert.equal(started.hostAction.tool, "invoke_subagent");
    assert.equal(started.hostAction.args.TypeName, "research");
    assert.match(started.runId, /^run_cur_/);
    assert.notEqual(started.runId, expired.runId);
    const gate = { ...args, hostToolName: started.hostAction.tool, hostToolArgs: started.hostAction.args };
    assert.equal(o.getConversationPolicy({ ...gate, hostToolArgs: { ...gate.hostToolArgs, TypeName: "self" } }).hostToolAllowed, false);
    assert.equal(o.getConversationPolicy(gate).curationTicketAllowed, true);
    assert.equal(o.getConversationPolicy(gate).hostToolAllowed, false);
    const unrelated = "de250000-1111-4111-8111-111111111111";
    o.db.upsertThread({ id: "thr_native_" + unrelated, hostConversationId: unrelated, workspace: cwd,
      meta: { isNativeHost: true, rootConversationId: conversationId } });
    const otherPlaybook = o.getConversationPolicy({ ...args, conversationId: unrelated, syncHostPlaybook: true });
    assert.doesNotMatch(otherPlaybook.playbookInject || "", /ROLE: SPEC CURATOR/);
    assert.equal((await curate("status")).curation.awaitingHost, true);
    write(appDataDir, transcript(child), "");
    fs.appendFileSync(path.join(appDataDir, transcript(conversationId)), JSON.stringify({
      type: "PLANNER_RESPONSE", step_index: 5, status: "DONE", created_at: new Date().toISOString(),
      tool_calls: [{ name: "invoke_subagent", args: started.hostAction.args }],
    }) + "\n" + step("GENERIC", 6, `invoke_subagent spawned ${child}`));
    await o.getBootstrap(args);
    const playbook = (await o.getConversationPolicy({ ...args, conversationId: child,
      syncHostPlaybook: true, deferPlaybookCommit: true })).playbookInject;
    assert.match(playbook, /SPEC CURATOR[\s\S]*真实规范原话/);
    assert.doesNotMatch(playbook, /控制消息[甲乙丙]/);
    const guardPath = path.join(dir, "control", "active-native-curators.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(guardPath, "utf8")).conversationIds, [child]);
    assert.equal((await curate("status")).curation.awaitingHost, false);
    assert.equal((await curate("cancelTicket")).cancelled, false);
    fs.appendFileSync(path.join(appDataDir, transcript(child)), step("USER_INPUT", 1, "执行票据") +
      step("PLANNER_RESPONSE", 2, draft(document("create", business, markdown("rule", "native")))));
    await o.getBootstrap(args);
    const state = (await curate("status")).curation;
    assert.equal(state.running, false);
    assert.equal(state.pendingProposal.executorKind, "antigravity_subagent");
    assert.equal(state.pendingProposal.runId, started.runId);
    assert.equal(fs.existsSync(guardPath), false);
    assert.equal(fs.existsSync(path.join(cwd, business)), false);
    await o.getBootstrap(args);
    assert.equal((await curate("status")).curation.pendingProposal.id, state.pendingProposal.id);
    const revision = await curate("revise", { proposalId: state.pendingProposal.id, feedback: "again" });
    assert.match(revision.hostAction.args.Prompt, /上版提案摘要[\s\S]*上版问题[\s\S]*again/);
    assert.equal((await curate("cancelTicket")).cancelled, true);
  } finally { await o.shutdown(); }
}));

specTest("锁模维护官从 Swarm 黑板结算，驻留成员再派只认新一轮回复", () => withProjectSandbox("c-native-swarm", async dir => {
  const cwd = plainProject(dir, "r"), appDataDir = plainProject(dir, "h");
  const wakes = [];
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog,
    hostWakeSender: async message => { wakes.push(message); return { ok: true }; } });
  o.db.saveSettings({ defaultSpecEnabled: true });
  o.updateHostContext({ appDataDir });
  const conversationId = "de300000-1111-4111-8111-111111111111";
  const child = "de400000-1111-4111-8111-111111111111";
  const args = { cwd, workspace: cwd, conversationId, appDataDir };
  const systemDir = `brain/${conversationId}/.system_generated`;
  const putRoster = (name, wake_mode) => write(appDataDir, `${systemDir}/swarm/members.json`, JSON.stringify({ members: {
    coordinator: { role: "coordinator", conversation_id: conversationId },
    [name]: { role: "worker", conversation_id: child, wake_mode, applied_model: "gemini-4-argon" },
  } }));
  const board = (seq, name, status) => JSON.stringify({ seq, agent: name, time: new Date().toISOString(), text: "@coordinator [done] " + status }) + "\n";
  const curate = (action, extra = {}) => o.specCuration({ ...args, action, ...extra });
  write(appDataDir, `${systemDir}/logs/transcript.jsonl`, [
    { type: "USER_INPUT", step_index: 1, content: "work" },
    { type: "PLANNER_RESPONSE", step_index: 2, status: "DONE", content: "completed" },
  ].map(step => JSON.stringify({ ...step, created_at: new Date().toISOString() })).join("\n") + "\n");
  try {
    await o.saveSettings({ presets: { curator_agy: { group: "curator", provider: "antigravity", model: "gemini-4-argon" } },
      modeProfiles: { complex: { curator: { enabledKeys: ["curator_agy"] } } } });
    await o.getBootstrap(args);
    const started = await curate("trigger", { _standalone: true });
    assert.equal(started.hostAction.tool, "swarm");
    assert.match(started.hostAction.args.brief, /严禁改写[\s\S]*agent-tower-spec-proposal[\s\S]*swarm_wait/);
    assert.equal(wakes.at(-1)?.message, started.hostAction.hostPrompt);
    const gate = { ...args, hostToolName: "swarm", hostToolArgs: started.hostAction.args };
    assert.equal(o.getConversationPolicy(gate).curationTicketAllowed, true);
    const name = started.hostAction.args.name;
    putRoster(name, "manual");
    await o.getBootstrap(args);
    assert.equal((await curate("status")).curation.awaitingHost, false);
    putRoster(name, "mentions");
    const boardPath = `${systemDir}/swarm/board.jsonl`;
    const first = board(1, name, draft(document("create", business, markdown("rule", "swarm"))));
    write(appDataDir, boardPath, first);
    await o.getBootstrap(args);
    const proposal = (await curate("status")).curation.pendingProposal;
    assert.equal(proposal.runId, started.runId);
    const revision = await curate("revise", { proposalId: proposal.id, feedback: "按新要求核验" });
    assert.equal(revision.hostAction.tool, "post_message");
    assert.match(revision.hostAction.args.text, /上版问题[\s\S]*按新要求核验/);
    await o.getBootstrap(args);
    assert.equal((await curate("status")).curation.awaitingHost, true);
    write(appDataDir, boardPath, first + board(2, name, none));
    await o.getBootstrap(args);
    const state = (await curate("status")).curation;
    assert.equal(state.running, false);
    assert.equal(state.pendingProposal, null);
    assert.equal(state.lastNoChange.runId, revision.runId);
    assert.equal((await o.getBootstrap(args)).specCuration.lastNoChange.runId, revision.runId);
    const removed = await curate("trigger");
    assert.equal(removed.hostAction.tool, "post_message");
    putRoster(name, "manual");
    await o.getBootstrap(args);
    assert.equal((await curate("status")).curation.awaitingHost, false);
    write(appDataDir, `${systemDir}/swarm/members.json`, JSON.stringify({ members: {
      coordinator: { role: "coordinator", conversation_id: conversationId },
    } }));
    await o.getBootstrap(args);
    assert.equal((await curate("status")).curation.running, false);
    assert.equal(fs.existsSync(path.join(dir, "control", "active-native-curators.json")), false);
    await o.setConversationPolicy({ ...args, orchestrationMode: "complex" });
    await curate("setAuto", { autoTrigger: true });
    driver(o, () => completed("done"));
    await o.delegateTask({ ...args, presetKey: "executor_codex", task: "work", mode: "wait" });
    putRoster("worker", "manual");
    await o.getBootstrap(args);
    assert.deepEqual(await curate("stopHookCheck"), {});
    putRoster("worker", "mentions");
    const stops = await Promise.all([curate("stopHookCheck"), curate("stopHookCheck")]);
    assert.equal(stops.filter(result => result.decision === "continue").length, 1);
    assert.equal((await curate("cancelTicket")).cancelled, true);
    assert.deepEqual(await curate("stopHookCheck"), {});
  } finally { await o.shutdown(); }
}));

test("v0.2.11 后端规范维护契约", { concurrency: 8 }, async t => {
  const parallel = cases.filter(c => !c.sequential);
  const sequential = cases.filter(c => c.sequential);
  await Promise.all(parallel.map(({ name, fn }) => t.test(name, fn)));
  for (const { name, fn } of sequential) await t.test(name, fn);
});

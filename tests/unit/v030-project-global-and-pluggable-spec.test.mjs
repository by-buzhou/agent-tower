import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { startCoreDaemon } from "../../core/daemon.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { globalSettings, resolveProjectRootSync } from "../../core/global-settings.mjs";
import { projectPathKey } from "../../core/orchestrator/helpers.mjs";
import { assembleSpecPrompt, readProjectSpecs } from "../../core/spec-context.mjs";
import { createIsolatedWorktree } from "../../core/worktree.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { repoRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

const spec = ".agent-tower/spec";
const archive = ".agent-tower/spec-archive";
const card = "02-coding/rule.md";
const rule = "---\nscopes: [src/**]\n---\nPROJECT_RULE";
const preset = label => ({ group: "executor", provider: "codex", model: "gpt-5", label });

function write(root, rel, data) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}
function open(dir, root) {
  const tower = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: root, catalogLoader: offlineCatalog });
  tower.updateHostContext({ appDataDir: dir });
  return tower;
}

test("v3 迁移冻结旧项目的阵容和规范状态，新项目纯读继承模板", () => withProjectSandbox("v030-migrate", dir => {
  const active = project(dir, "active");
  const legacy = project(dir, "legacy");
  const blank = project(dir, "blank");
  const control = path.join(dir, "control");
  write(active, `${spec}/${card}`, rule);
  write(control, "global-settings.json", JSON.stringify({
    rosterVersion: 2, presetRevision: 7, defaultStudioRoot: blank, knownProjects: [active, blank],
    presets: { executor_test: preset("before") },
    specCurationByProject: { [projectPathKey(legacy)]: { autoTrigger: true, singleMaxKb: 3, totalMaxKb: 24 } },
  }));
  const settings = globalSettings(control, blank);
  assert.equal(settings.read().configSchemaVersion, 3);
  assert.equal(settings.read().specCurationByProject, undefined);
  assert.equal(settings.getProjectRoster(active).rosterRevision, 7);
  assert.equal(settings.isProjectSpecEnabled(active), true);
  assert.deepEqual(settings.getProjectSpec(legacy), { enabled: true, autoTrigger: true, singleMaxKb: 3, totalMaxKb: 24 });
  assert.equal(settings.getProjectRoster(blank).source, "global_template");
  assert.equal(settings.isProjectSpecEnabled(blank), false);
  assert.equal(fs.existsSync(path.join(blank, ".agent-tower")), false);

  settings.save({ presets: { executor_test: preset("after") }, defaultSpecEnabled: true });
  assert.equal(settings.getProjectRoster(active).presets.executor_test.label, "before");
  assert.equal(settings.getProjectRoster(blank).presets.executor_test.label, "after");
  assert.equal(settings.isProjectSpecEnabled(blank), true);
}));

test("按项目的设置响应、阵容 CAS、批次路由与模板同步相互隔离", () => withProjectSandbox("v030-roster", async dir => {
  const a = project(dir, "project-a");
  const b = project(dir, "project-b");
  const c = project(dir, "project-c");
  const tower = open(dir, b);
  const events = [];
  const stop = tower.subscribe(event => events.push(event));
  try {
    const global = await tower.saveSettings({ presets: { executor_test: preset("global") }, defaultOrchestrationMode: "complex" });
    assert.equal(global.projectConfig.rosterSource, "unbound");
    assert.equal(global.settings.defaultSpecEnabled, false);
    const blank = await tower.getBootstrap({ workspace: a });
    assert.equal(blank.projectConfig.rosterSource, "global_template");
    assert.equal(fs.existsSync(path.join(a, ".agent-tower")), false);
    const aSettings = await tower.saveSettings({ workspace: a, presets: { executor_test: { label: "A", model: "gpt-5-a" } },
      modeProfiles: { complex: { executor: { enabledKeys: ["executor_test"] } } }, expectedPresetRevision: global.presetRevision });
    assert.equal(aSettings.projectConfig.projectKey, projectPathKey(a));
    assert.equal(aSettings.projectConfig.rosterCustomized, true);
    assert.equal(aSettings.settings.presets.executor_test.label, "A");
    assert.equal(aSettings.globalTemplate.presets.executor_test.label, "global");
    assert.equal(aSettings.globalTemplate.counts.total, Object.keys(global.presets).length);
    assert.ok(events.some(event => event.type === "project_config_updated" && event.projectConfig.projectKey === projectPathKey(a)));
    assert.equal(events.filter(event => event.type === "settings_updated").length, 1);
    await assert.rejects(tower.saveSettings({ scope: "project", workspace: a, expectedPresetRevision: 0, presets: {} }), {
      code: "PRESET_REVISION_CONFLICT", details: { currentRevision: aSettings.presetRevision, settings: aSettings.settings },
    });
    const aEvt = events.find(event => event.type === "project_config_updated" && event.projectConfig.projectKey === projectPathKey(a));
    await tower.setConversationPolicy({ conversationId: "conv-bound-a", workspace: a, orchestrationMode: "complex" });
    await tower.setConversationPolicy({ conversationId: "conv-bound-b", workspace: b, orchestrationMode: "complex" });
    assert.equal(tower.matchesEventConversation(aEvt, "conv-bound-a"), true);
    assert.equal(tower.matchesEventConversation(aEvt, "conv-bound-b"), false);
    assert.equal(tower.matchesEventConversation(aEvt, "conv-unbound"), false);
    assert.ok(!(await tower.getEvents({ workspace: b })).events.some(event => event.type === "project_config_updated"));
    assert.ok((await tower.getEvents({ workspace: a, conversationId: "config-view" })).events.some(event => event.type === "project_config_updated"));
    const sub = path.join(a, "src");
    fs.mkdirSync(sub);
    assert.equal((await tower.getCapabilities({ cwd: sub })).presets.executor_test.label, "A");

    await tower.specCuration({ action: "setEnabled", workspace: a, enabled: true });
    await tower.specCuration({ action: "setLimits", workspace: a, singleMaxKb: 4, totalMaxKb: 20 });
    const eventsBeforeSync = events.length;
    const synced = await tower.saveSettings({ action: "syncProjectToGlobal", workspace: a });
    assert.equal(synced.globalTemplate.presets.executor_test.label, "A");
    assert.equal(synced.settings.defaultSpecEnabled, false);
    assert.equal((await tower.getBootstrap({ workspace: b })).presets.executor_test.label, "global");
    assert.equal((await tower.getBootstrap({ workspace: c })).projectConfig.specEnabled, false);
    // syncProjectToGlobal 冻结老项目 B 后，在全局 settings_updated 之后为 B 补发 project_config_updated
    const syncEvents = events.slice(eventsBeforeSync);
    const globalIdx = syncEvents.findIndex(e => e.type === "settings_updated");
    const frozenBIdx = syncEvents.findIndex(e => e.type === "project_config_updated" && e.projectConfig?.projectKey === projectPathKey(b));
    assert.ok(globalIdx >= 0 && frozenBIdx > globalIdx, "冻结老项目须在全局事件之后补发 project_config_updated");

    // 混合作用域冲突拒绝 + 失效 workspace 不阻断纯全局保存
    await assert.rejects(tower.saveSettings({ scope: "project", workspace: a, defaultSpecEnabled: true }), { code: "SETTINGS_SCOPE_CONFLICT" });
    const deletedDir = path.join(dir, "removed-project");
    const globalWithStaleWs = await tower.saveSettings({ scope: "global", defaultSpecEnabled: true, workspace: deletedDir });
    assert.equal(globalWithStaleWs.settings.defaultSpecEnabled, true);
    assert.equal(globalWithStaleWs.projectConfig.workspace, null);
    assert.equal(globalWithStaleWs.projectConfig.rosterSource, "unbound");
    await tower.saveSettings({ scope: "global", defaultSpecEnabled: false });

    await tower.saveSettings({ workspace: b, presets: { executor_test: { label: "B", model: "gpt-5-b" } },
      modeProfiles: { complex: { executor: { enabledKeys: ["executor_test"] } } } });
    tower.engineManager.runTurn = () => ({ result: Promise.resolve({ status: "completed", assistantText: "done" }) });
    const result = await tower.delegateParallelBatch({ conversationId: "mixed-batch", mode: "wait_all", tasks: [
      { cwd: a, presetKey: "executor_test", task: "first" },
      { cwd: b, presetKey: "executor_test", task: "second" },
    ] });
    assert.ok(result);
    assert.deepEqual(tower.db.listThreads({ includeSubagents: true }).filter(thread => thread.presetKey === "executor_test")
      .map(thread => thread.model).sort(), ["gpt-5-a", "gpt-5-b"]);

    // 单项目批派与直出拦截的 activeMode.rosterRevision 透传当前项目修订号（不落回全局）
    const singleBatch = await tower.delegateParallelBatch({ conversationId: "mixed-batch", mode: "wait_all", tasks: [
      { cwd: b, presetKey: "executor_test", task: "only-b" },
    ] });
    assert.equal(singleBatch.activeMode.rosterRevision, tower.db.getProjectRoster(b).rosterRevision);
    await tower.setConversationPolicy({ conversationId: "direct-conv-b", workspace: b, orchestrationMode: "direct" });
    const bypassed = await tower.delegateTask({ conversationId: "direct-conv-b", cwd: b, presetKey: "executor_test", task: "blocked" });
    assert.equal(bypassed.bypassed, true);
    assert.equal(bypassed.activeMode.rosterRevision, tower.db.getProjectRoster(b).rosterRevision);

    // resetProjectToGlobal 真正恢复 global_template 跟随态且保持 rosterRevision 单调不降
    const bBefore = (await tower.getCapabilities({ workspace: b })).presetRevision;
    const reset = await tower.saveSettings({ action: "resetProjectToGlobal", workspace: b });
    assert.equal(reset.presets.executor_test.label, "A");
    assert.equal(reset.projectConfig.rosterSource, "global_template");
    assert.equal(reset.projectConfig.rosterCustomized, false);
    assert.ok(reset.presetRevision > bBefore);
    assert.equal(tower.db.getProjectSpec(b).singleMaxKb, 2);
    // 恢复后再次修改全局模板，项目 B 实时跟随且 rosterRevision 仍不低于 floor
    await tower.saveSettings({ scope: "global", presets: { executor_test: { label: "Global-V2" } } });
    const bFollowing = await tower.getCapabilities({ workspace: b });
    assert.equal(bFollowing.presets.executor_test.label, "Global-V2");
    assert.equal(bFollowing.projectConfig.rosterSource, "global_template");
    assert.ok(bFollowing.presetRevision >= reset.presetRevision);
  } finally { stop(); await tower.shutdown(); }
}));

test("Spec 停用封锁维护官，保留原文件、项目文档与只读审查", () => withProjectSandbox("v030-switch", async dir => {
  const root = project(dir, "repo");
  const blank = project(dir, "blank");
  const tower = open(dir, root);
  const specFile = write(root, `${spec}/${card}`, rule);
  write(root, "docs/evolution/INDEX.md", "ROOT_DOC");
  write(root, ".agent-tower/plans/INDEX.md", "local plans");
  const params = { workspace: root, conversationId: "switch-spec" };
  const prompts = [];
  let finish;
  let started;
  const curatorStarted = new Promise(resolve => { started = resolve; });
  tower.engineManager.runTurn = options => {
    if (options.permissionMode === "read-only" && /维护提案/.test(String(options.prompt))) {
      const result = new Promise(resolve => { finish = resolve; });
      started();
      return { result, cancel: () => finish({ status: "interrupted" }) };
    }
    const nativeSessionId = options.nativeSessionId || "fixture-native";
    options.onEvent({ type: "session_bound", nativeSessionId, resumed: Boolean(options.nativeSessionId) });
    prompts.push(String(options.prompt));
    return { result: Promise.resolve({ status: "completed", assistantText: "done", nativeSessionId }) };
  };
  try {
    assert.equal((await tower.getCapabilities({ workspace: blank })).projectConfig.specEnabled, false);
    await assert.rejects(tower.handleRpc("initProjectSpecs", { workspace: blank }), { code: "SPEC_DISABLED_FOR_PROJECT" });
    await tower.specCuration({ ...params, action: "setAuto", autoTrigger: true });
    const curator = await tower.specCuration({ ...params, action: "trigger" });
    await curatorStarted;
    const originalSpec = fs.readFileSync(specFile, "utf8");
    await tower.saveSettings({ defaultOrchestrationMode: "complex" });
    const first = await tower.delegateTask({ ...params, presetKey: "executor_codex", task: "Check src/index.mjs", mode: "wait" });
    assert.match(prompts.at(-1), /PROJECT_RULE/);
    const off = await tower.specCuration({ ...params, action: "setEnabled", enabled: false });
    assert.equal(off.curation.specEnabled, false);
    assert.equal(off.curation.autoTrigger, false);
    assert.equal(off.curation.archive.hasActiveSpecs, true);
    assert.equal(fs.readFileSync(specFile, "utf8"), originalSpec);
    assert.equal(tower.db.getRun(curator.runId).status, "interrupted");
    for (const action of ["trigger", "confirm", "revise", "setAuto", "setLimits"]) {
      await assert.rejects(tower.specCuration({ ...params, action }), { code: "SPEC_DISABLED_FOR_PROJECT" });
    }
    await assert.rejects(tower.handleRpc("initProjectSpecs", params), { code: "SPEC_DISABLED_FOR_PROJECT" });
    await assert.rejects(tower.delegateTask({ ...params, role: "curator", task: "blocked" }), { code: "SPEC_DISABLED_FOR_PROJECT" });
    await assert.rejects(tower.launchThread({ ...params, role: "curator" }), { code: "SPEC_DISABLED_FOR_PROJECT" });
    await assert.rejects(tower.manageQueue({ threadId: curator.threadId, action: "enqueue", text: "blocked" }), { code: "SPEC_DISABLED_FOR_PROJECT" });
    await assert.rejects(tower.sendToThread({ threadId: curator.threadId, message: "blocked", mode: "queue" }), { code: "SPEC_DISABLED_FOR_PROJECT" });
    await assert.rejects(tower.retryRun({ threadId: curator.threadId }), { code: "SPEC_DISABLED_FOR_PROJECT" });
    const specs = await tower.listProjectSpecs(params);
    assert.deepEqual(specs.counts, { plugin: 5, business: 0, coding: 0, total: 0 });
    assert.deepEqual(specs.specs, []);
    assert.equal(specs.totalProjectBytes, 0);
    const host = tower.getConversationPolicy({ ...params, syncHostPlaybook: true }).playbookInject;
    assert.match(host, /plans\/INDEX\.md/);
    assert.doesNotMatch(host, /coding\/rule|【规范维护】|ROOT_DOC/);

    await tower.sendToThread({ threadId: first.threadId, message: "check again", wait: true });
    assert.equal(prompts.at(-1).match(/【项目规范已停用】/g)?.length, 1);
    assert.doesNotMatch(prompts.at(-1), /PROJECT_RULE|SPEC ROUTING CATALOG|维护官|\.agent-tower\/spec\/\*\*/);
    await tower.sendToThread({ threadId: first.threadId, message: "one more", wait: true });
    assert.doesNotMatch(prompts.at(-1), /【项目规范已停用】/);
    const review = await tower.runCodeReview({ ...params, readOnly: true, wait: true });
    assert.equal(review.status, "completed");
  } finally { await tower.shutdown(); }
}));

test("归档与恢复校验 SHA、链接和冲突，Git 可见且恢复开关按参数生效", t => withProjectSandbox("v030-archive", async dir => {
  const root = project(dir, "repo");
  const tower = open(dir, root);
  const act = (action, params = {}) => tower.specCuration({ action, workspace: root, ...params });
  const activeFile = write(root, `${spec}/${card}`, rule);
  const index = "User-maintained index\n";
  write(root, `${spec}/INDEX.md`, index);
  write(root, `${spec}/00-plugin/review.md`, "mirror");
  try {
    let busyAttempts = 0;
    const sourceLink = fs.linkSync;
    const busy = t.mock.method(fs, "linkSync", (source, destination) => {
      if (source === activeFile) {
        busyAttempts++;
        throw Object.assign(new Error("occupied"), { code: "EBUSY" });
      }
      return sourceLink(source, destination);
    });
    try { await assert.rejects(act("archive"), { code: "SPEC_ARCHIVE_BUSY" }); }
    finally { busy.mock.restore(); }
    assert.equal(busyAttempts, 4);
    assert.equal(fs.readFileSync(activeFile, "utf8"), rule);
    assert.equal(fs.existsSync(path.join(root, archive)), false);
    assert.equal((await act("status")).curation.specEnabled, true);

    const archived = await act("archive");
    assert.equal(archived.curation.specEnabled, false);
    assert.equal(archived.curation.archive.fileCount, 2);
    assert.equal(fs.existsSync(path.join(root, spec)), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, archive, "manifest.json"), "utf8"));
    assert.equal(manifest.files.find(entry => entry.path === card).sha256, createHash("sha256").update(rule).digest("hex"));
    assert.match(git(root, "ls-files", "--others", "--exclude-standard", "--", archive), /spec-archive\/manifest\.json/);
    await assert.rejects(act("archive"), { code: "SPEC_ARCHIVE_ALREADY_EXISTS" });
    write(root, `${archive}/${card}`, "tampered");
    await assert.rejects(act("restore"), { code: "SPEC_ARCHIVE_CORRUPTED" });
    assert.equal(fs.existsSync(activeFile), false);
    write(root, `${archive}/${card}`, rule);
    write(root, `${spec}/${card}`, "new active");
    assert.deepEqual((await act("status")).curation.archive.conflictPaths, [card]);
    await assert.rejects(act("restore", { enableAfterRestore: true }), { code: "SPEC_RESTORE_CONFLICT" });
    assert.equal(fs.readFileSync(activeFile, "utf8"), "new active");
    fs.unlinkSync(activeFile);
    assert.equal((await act("restore")).curation.specEnabled, false);
    assert.equal(fs.readFileSync(activeFile, "utf8"), rule);
    assert.equal(fs.readFileSync(path.join(root, spec, "INDEX.md"), "utf8"), index);
    assert.equal(fs.existsSync(path.join(root, archive)), false);
    assert.equal(fs.existsSync(path.join(root, spec, "00-plugin/review.md")), false, "enableAfterRestore: false 保持停用时不生成 00-plugin/ 镜像");
    await assert.rejects(act("restore"), { code: "SPEC_ARCHIVE_NOT_FOUND" });

    const outside = path.join(dir, "outside");
    fs.mkdirSync(outside);
    const link = path.join(root, spec, "02-coding", "link");
    fs.symlinkSync(outside, link, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(act("archive"), /Linked path refused/);
    assert.equal(fs.readFileSync(activeFile, "utf8"), rule);
    fs.rmdirSync(link);
    await act("archive");
    // Windows core.autocrlf=true 检出后 CRLF 换行仍通过 SHA-256 校验正常恢复
    const archivedCard = path.join(root, archive, card);
    fs.writeFileSync(archivedCard, rule.replace(/\n/g, "\r\n"));
    assert.equal((await act("status")).curation.archive.fileCount, 2);
    assert.equal((await act("restore", { enableAfterRestore: true })).curation.specEnabled, true);
    assert.equal(fs.existsSync(path.join(root, spec, "00-plugin/review.md")), true, "enableAfterRestore: true 开启时同步生成 00-plugin/ 镜像");

    // 两阶段回滚安全：Phase 2 删源失败且逆向恢复某文件失败时，跳过删除对应目标文件并记录 rollbackErrors，确保零丢数
    write(root, `${spec}/${card}`, rule);
    const realUnlink = fs.unlinkSync;
    const realLink = fs.linkSync;
    const indexFile = path.join(root, spec, "INDEX.md");
    let unlinkedFirst = "";
    const mockUnlink = t.mock.method(fs, "unlinkSync", target => {
      if (target === activeFile || target === indexFile) {
        if (!unlinkedFirst) { unlinkedFirst = target; return realUnlink(target); }
        throw Object.assign(new Error("unlink failed"), { code: "EACCES" });
      }
      return realUnlink(target);
    });
    const mockLink = t.mock.method(fs, "linkSync", (src, dst) => {
      if (dst === unlinkedFirst) throw Object.assign(new Error("restore source failed"), { code: "EACCES" });
      return realLink(src, dst);
    });
    let rollbackErr;
    try { await act("archive"); } catch (err) { rollbackErr = err; }
    finally { mockUnlink.mock.restore(); mockLink.mock.restore(); }
    assert.ok(rollbackErr?.details?.rollbackErrors?.length >= 1, "应记录 rollbackErrors");
    const preservedRel = unlinkedFirst === activeFile ? card : "INDEX.md";
    assert.equal(fs.existsSync(path.join(root, archive, preservedRel)), true, "恢复源失败时目标归档副本必须保留");
    assert.equal(fs.existsSync(unlinkedFirst === activeFile ? indexFile : activeFile), true, "未删除的第二个源文件保持完好");
    fs.rmSync(path.join(root, archive), { recursive: true, force: true });
    write(root, `${spec}/${card}`, rule);
    write(root, `${spec}/INDEX.md`, index);

    // 已提交进 Git 的 .agent-tower/spec-archive/ 不阻塞干净闲置 Worktree 的一键安全清理
    await act("archive");
    git(root, "add", ".gitignore", ".agent-tower/spec-archive");
    git(root, "-c", "user.name=T", "-c", "user.email=t@invalid.local", "commit", "-m", "commit spec-archive");
    const wt = await createIsolatedWorktree({ cwd: root, taskSlug: "clean-with-archive" });
    assert.equal(fs.existsSync(path.join(wt.worktreePath, archive, "manifest.json")), true);
    const cacheStatus = await tower.getRuntimeCacheStatus({ workspace: root });
    const wtEntry = cacheStatus.worktrees.find(w => w.worktreePath === wt.worktreePath);
    assert.equal(wtEntry?.cleanable, true, "已入 Git 的干净 spec-archive 不得锁死闲置 Worktree 清理");
    const cleaned = await tower.cleanRuntimeCache({ workspace: root });
    assert.ok(cleaned.removedWorktrees.some(w => w.worktreePath === wt.worktreePath));
    assert.equal(fs.existsSync(path.join(root, archive, "manifest.json")), true, "主仓 spec-archive 永久保留");
  } finally { await tower.shutdown(); }
}));

test("历史 Trellis 账本静默退役、根 docs 不参与提示词，零命中 plugin/spec-catalog 停用后撤销", () => withProjectSandbox("v030-legacy-ledger", root => {
  write(root, ".trellis/spec/legacy.md", "LEGACY_BODY");
  write(root, "docs/ROADMAP.md", "ROOT_ROADMAP");
  write(root, "docs/evolution/INDEX.md", "ROOT_EVOLUTION");
  const ledger = new Map([["trellis/legacy", { tier: "inline", sha256: "old" }]]);
  const result = assembleSpecPrompt({ cwd: root, role: "executor", inventory: readProjectSpecs(root),
    rawPrompt: "task", dynamicPrompt: "task", ledger }).delta;
  assert.doesNotMatch(result.prompt, /trellis|LEGACY_BODY|EVOLUTION INDEX|ROADMAP ISOLATION/i);
  assert.deepEqual(result.delivered.find(item => item.key === "trellis/legacy"),
    { key: "trellis/legacy", sha256: "revoked", tier: "revoked" });

  // 此前仅收到零命中兜底目录卡（plugin/spec-catalog）的旧会话，停用后收到一次单行撤销提示并标 revoked
  write(root, `${spec}/${card}`, rule);
  const first = assembleSpecPrompt({ cwd: root, role: "executor", inventory: readProjectSpecs(root),
    rawPrompt: "unrelated question", dynamicPrompt: "unrelated question", specEnabled: true }).full;
  const catalogReceipt = first.delivered.find(item => item.key === "plugin/spec-catalog");
  assert.ok(catalogReceipt && catalogReceipt.tier === "inline");
  const catalogLedger = new Map(first.delivered.map(item => [item.key, item]));
  const afterDisable = assembleSpecPrompt({ cwd: root, role: "executor", inventory: readProjectSpecs(root),
    rawPrompt: "follow up", dynamicPrompt: "follow up", ledger: catalogLedger, specEnabled: false }).delta;
  assert.equal(afterDisable.prompt.match(/【项目规范已停用】/g)?.length, 1);
  assert.deepEqual(afterDisable.delivered.find(item => item.key === "plugin/spec-catalog"),
    { key: "plugin/spec-catalog", sha256: "revoked", tier: "revoked" });
  const revokedLedger = new Map([...catalogLedger, ...afterDisable.delivered.map(item => [item.key, item])]);
  const thirdTurn = assembleSpecPrompt({ cwd: root, role: "executor", inventory: readProjectSpecs(root),
    rawPrompt: "another turn", dynamicPrompt: "another turn", ledger: revokedLedger, specEnabled: false }).delta;
  assert.doesNotMatch(thirdTurn.prompt, /【项目规范已停用】/);
}));

test("实时 SSE 仅带 conversationId 时按绑定项目推送 project_config_updated，离线 pre-tool-gate 支持子目录与工作树解析项目阵容", () =>
  withProjectSandbox("v030-sse-and-offline-gate", async dir => {
    const a = project(dir, "proj-a");
    const b = project(dir, "proj-b");
    const control = path.join(dir, "control");
    const daemon = await startCoreDaemon({ dataDir: control, defaultStudioRoot: b, catalogLoader: offlineCatalog, token: "tok-v030" });
    const ac = new AbortController();
    try {
      await daemon.orchestrator.setConversationPolicy({ conversationId: "sse-conv-a", workspace: a, orchestrationMode: "complex" });
      await daemon.orchestrator.saveSettings({
        scope: "global",
        presets: { advisor_carbon: { group: "advisor", provider: "antigravity", model: "gemini-4-carbon", label: "Carbon" } },
        modeProfiles: { complex: { advisor: { stageEnabled: true, enabledKeys: ["advisor_carbon"] } } },
      });
      await daemon.orchestrator.saveSettings({
        workspace: a,
        modeProfiles: { complex: { advisor: { stageEnabled: true, enabledKeys: [] } } },
      });

      const res = await fetch(`http://127.0.0.1:${daemon.port}/api/stream?conversationId=sse-conv-a&sinceSeq=${daemon.orchestrator.db.getLatestSeq()}`, {
        headers: { "X-Daemon-Token": "tok-v030" },
        signal: ac.signal,
      });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      const waitFrame = async predicate => {
        for (let i = 0; i < 40; i++) {
          for (const chunk of buf.split("\n\n")) {
            const dataLine = chunk.split("\n").find(l => l.startsWith("data: "));
            if (!dataLine) continue;
            const parsed = JSON.parse(dataLine.slice(6));
            if (predicate(parsed)) return parsed;
          }
          const next = await reader.read();
          if (next.done) break;
          buf += dec.decode(next.value, { stream: true });
        }
        throw new Error("SSE 未收到预期帧");
      };
      await waitFrame(f => Array.isArray(f.events));

      await daemon.orchestrator.saveSettings({ workspace: b, presets: { executor_codex: { label: "B-only" } } });
      await daemon.orchestrator.saveSettings({ workspace: a, presets: { executor_codex: { label: "A-live" } } });
      const liveFrame = await waitFrame(f => f.type === "project_config_updated");
      assert.equal(liveFrame.projectConfig.projectKey, projectPathKey(a));
      assert.equal(liveFrame.presets.executor_codex.label, "A-live");
      assert.ok(!buf.includes("B-only"), "SSE 会话流不得混入其他项目的 project_config_updated");
      ac.abort();
    } finally {
      ac.abort();
      await daemon.shutdown();
    }

    // 冷启动在线同步定位（repoRootCache 为空）+ 嵌套独立 Git 仓库在 .git 边界止步
    const subDir = path.join(a, "packages", "web");
    const wtDir = path.join(a, ".agent-tower", "worktrees", "thr_1", "sub");
    const nested = project(a, "nested-repo");
    const nestedSub = path.join(nested, "src");
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(wtDir, { recursive: true });
    fs.mkdirSync(nestedSub, { recursive: true });

    const coldTower = open(dir, b);
    try {
      await coldTower.saveSettings({ scope: "global", defaultOrchestrationMode: "complex" });
      await coldTower.setConversationPolicy({ conversationId: "sse-conv-b", workspace: b, orchestrationMode: "complex" });
      const onlineSubPolicy = coldTower.getConversationPolicy({
        conversationId: "sse-conv-a",
        workspace: subDir,
        hostToolName: "swarm",
        hostToolArgs: { action: "add", name: "advisor_carbon" },
      });
      assert.equal(onlineSubPolicy.hostToolAllowed, false, "冷启动未命中 repoRootCache 时子目录在线门禁须与离线一致");
      // 嵌套独立 Git 仓库（未独立定制）必须在自身 .git 边界止步，不得穿透到外层项目 A
      assert.equal(projectPathKey(resolveProjectRootSync(nestedSub, coldTower.db.getSettings().projectProfiles)), projectPathKey(nested));
      const onlineNestedPolicy = coldTower.getConversationPolicy({
        conversationId: "sse-conv-nested",
        workspace: nestedSub,
        hostToolName: "swarm",
        hostToolArgs: { action: "add", name: "advisor_carbon" },
      });
      assert.equal(onlineNestedPolicy.hostToolAllowed, true, "嵌套独立 Git 仓库须在 .git 止步，继承全局而非外层 A 定制");
    } finally {
      await coldTower.shutdown();
    }

    // Daemon 已关闭（离线门禁分支）：子目录与隔离工作树均须命中项目 A 的独立阵容（advisor_carbon 已被 A 取消勾选）
    const gateScript = path.join(repoRoot, "core", "hooks", "pre-tool-gate.mjs");
    const runGate = payload => JSON.parse(execFileSync(process.execPath, [gateScript], {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENT_TOWER_DATA_DIR: control },
      encoding: "utf8",
    }).trim());
    const fromSub = runGate({
      conversationId: "sse-conv-a",
      workspacePaths: [subDir],
      toolCall: { name: "swarm", input: { action: "add", name: "advisor_carbon" } },
    });
    assert.equal(fromSub.decision, "deny");
    assert.match(fromSub.reason, /advisor_carbon/);

    const fromWtNoWs = runGate({
      conversationId: "sse-conv-a",
      cwd: wtDir,
      toolCall: { name: "swarm", input: { action: "add", name: "advisor_carbon" } },
    });
    assert.equal(fromWtNoWs.decision, "deny");

    // 离线门禁：命中 matchedRoot(B) 时仅用 [B] 解析阵容，绝不穿透扫描共存工作区 A；嵌套仓库同样在 .git 止步
    const convBWithCoexistingA = runGate({
      conversationId: "sse-conv-b",
      workspacePaths: [a, b],
      toolCall: { name: "swarm", input: { action: "add", name: "advisor_carbon" } },
    });
    assert.equal(convBWithCoexistingA.decision, "allow", "已匹配 B 的会话不得串读共存工作区 A 的禁用阵容");

    const fromNested = runGate({
      conversationId: "sse-conv-nested",
      workspacePaths: [nestedSub],
      toolCall: { name: "swarm", input: { action: "add", name: "advisor_carbon" } },
    });
    assert.equal(fromNested.decision, "allow", "离线门禁在嵌套仓库 .git 边界止步，不继承外层 A 禁用");
  }));

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { createScopePolicyModule } from "../../core/orchestrator/scope-policy.mjs";
import { DEFAULT_ROLE_PRESETS, MODE_PLAYBOOK_REVISION, buildModePlaybook } from "../../core/catalog.mjs";
import { ensureStorageIgnoreRules } from "../../core/storage-paths.mjs";
import {
  ROLE_SYSTEM_PREFIXES, assembleSpecPrompt, hasCouncilsIndex, projectSpecStatus, readProjectSpecs, specSelection,
} from "../../core/spec-context.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { repoRoot, runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

// v0.2.5：军师同题原话盲评、四段式裁决汇总与 .agent-tower/councils/ 专属归档保护。
process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();
const studioDir = path.join(repoRoot, "sidecars", "studio");
const write = (file, content) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const OLD_ANGLES = /模块化架构|状态机流转|前后端贯通|全面审阅当前项目的代码架构/;

/* ---------- Studio 军师入口：最小 window / document 桩驱动真实 ui 模块 ---------- */
const toasts = [];
const rpcLog = [];
const elements = new Map();
let councilChecked = [];
const element = (id, extra = {}) => {
  const el = { id, value: "", innerHTML: "", hidden: false, focused: false, dataset: {}, focus() { this.focused = true; }, ...extra };
  elements.set(id, el);
  return el;
};
globalThis.location = { pathname: "/", search: "" };
globalThis.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.requestAnimationFrame = () => 0;
globalThis.document = {
  activeElement: null,
  getElementById: (id) => (id === "toast-container" ? { appendChild: (el) => toasts.push(el.textContent) } : elements.get(id) || null),
  querySelector: () => null,
  querySelectorAll: (selector) => (selector.includes("data-council-member")
    ? councilChecked.map((key) => ({ dataset: { councilMember: key } })) : []),
  createElement: () => ({ className: "", textContent: "", remove() {} }),
};
globalThis.window = {
  sidecar: {
    conversationId: "conv-v025",
    fetch: async (url, init) => {
      const { method, params } = JSON.parse(init.body);
      rpcLog.push({ method, params });
      return { ok: true, status: 200, json: async () => ({ result: { threads: [] } }) };
    },
  },
};
const ui = (f) => import(pathToFileURL(path.join(studioDir, "ui", f)).href);
const S = await ui("state.js");
const modals = await ui("modals.js");
const { state } = S;

function resetStudio() {
  state.presets = {};
  for (const slot of S.ROLE_SLOT_META) state.presets[slot.key] = S.seedPreset(slot.key);
  for (const k of ["dirtyPresets", "editedPresets", "committedPresets", "dirtyModeProfiles", "pendingDeletes", "pendingResets"]) state[k].clear();
  state.modeProfiles = structuredClone(S.DEFAULT_MODE_PROFILES);
  state.conversationPolicy = { conversationId: "conv-v025", orchestrationMode: "complex", dispatchEnabled: true };
  state.bootstrapLoaded = true;
  elements.clear();
  for (const id of ["council-topic-input", "disp-prompt", "batch-rows-container", "council-modal-backdrop"]) element(id);
  councilChecked = [...S.DEFAULT_MODE_PROFILES.complex.advisor.enabledKeys];
  rpcLog.length = 0;
  toasts.length = 0;
}

test("v0.2.5 submitCouncilSummon：空议题 0 RPC 拦截并聚焦，非空原话下全体军师 task/prompt 逐字一致", async () => {
  resetStudio();
  elements.get("council-topic-input").value = "   ";
  await modals.submitCouncilSummon();
  assert.equal(rpcLog.length, 0, "空议题不得发出任何 RPC（含预设冲刷）");
  assert.ok(toasts.includes("请先填写希望军师讨论的原始诉求或议题"));
  assert.equal(elements.get("council-topic-input").focused, true);
  assert.equal(elements.get("council-modal-backdrop").hidden, false, "拦截时不得关闭弹窗");

  resetStudio();
  const topic = "请保持用户原意评估会话隔离方案\n约束：不改 SQLite Schema";
  elements.get("council-topic-input").value = `  ${topic}  `;
  await modals.submitCouncilSummon();
  const batches = rpcLog.filter((r) => r.method === "delegateParallelBatch");
  assert.equal(batches.length, 1);
  const { tasks } = batches[0].params;
  assert.deepEqual(tasks.map((t) => t.presetKey), ["advisor_kimi", "advisor_codex", "advisor_claude"]);
  const brief = `【用户原话 / 会审议题】\n${topic}\n\n【盲评要求】请仅基于上述用户原意与当前仓库已核实的客观代码事实独立判断，不预设倾向，严禁修改任何文件。`;
  for (const t of tasks) {
    assert.equal(t.task, brief);
    assert.equal(t.prompt, brief);
    assert.equal(t.isolation, "shared");
    assert.doesNotMatch(t.task, OLD_ANGLES);
    assert.doesNotMatch(t.task, /军师团独立方案评审 [ABC]/);
  }
  assert.equal(new Set(tasks.map((t) => t.title)).size, 3, "标题仍保留各自名称");
  assert.equal(elements.get("council-topic-input").value, "", "派发成功后清空议题");
});

test("v0.2.5 fillBatchTemplate('council')：无草稿 prompt 为空串，有草稿全员同题且无旧 3 角度诱导词", () => {
  resetStudio();
  modals.fillBatchTemplate("council");
  assert.equal(state.batchDrafts.length, 3);
  assert.deepEqual(state.batchDrafts.map((d) => d.prompt), ["", "", ""]);
  assert.match(elements.get("batch-rows-container").innerHTML, /军师团盲评请粘贴相同的用户原话/);

  resetStudio();
  elements.get("council-topic-input").value = "弹窗议题兜底";
  modals.fillBatchTemplate("council");
  assert.deepEqual(state.batchDrafts.map((d) => d.prompt), ["弹窗议题兜底", "弹窗议题兜底", "弹窗议题兜底"]);

  resetStudio();
  elements.get("disp-prompt").value = "  请保持用户原意评估会话隔离方案  ";
  elements.get("council-topic-input").value = "被抽屉草稿覆盖";
  modals.fillBatchTemplate("council");
  assert.deepEqual(state.batchDrafts.map((d) => d.presetKey), ["advisor_kimi", "advisor_codex", "advisor_claude"]);
  for (const d of state.batchDrafts) {
    assert.equal(d.prompt, "请保持用户原意评估会话隔离方案");
    assert.doesNotMatch(d.prompt, OLD_ANGLES);
  }
  const modalsSource = fs.readFileSync(path.join(studioDir, "ui", "modals.js"), "utf8");
  assert.doesNotMatch(modalsSource, OLD_ANGLES);
  assert.doesNotMatch(modalsSource, /prompts\[i % prompts\.length\]/);
  const html = fs.readFileSync(path.join(studioDir, "index.html"), "utf8");
  assert.match(html, />填入：军师团（同题原意盲评）</);
  assert.match(html, /用户原意与会审议题（必填）/);
  assert.match(html, /军师会审纪要（councils\/）/);
});

test("无军师或空白批量题面时保留脏预设，异步等候期间切会话取消派发", async () => {
  resetStudio();
  state.dirtyPresets.set("advisor_codex", new Map([["label", 1]]));
  elements.get("council-topic-input").value = "用户原话";
  councilChecked = [];
  await modals.submitCouncilSummon();
  assert.deepEqual(rpcLog.map(r => r.method), []);
  state.dispatchMode = "batch";
  elements.get("council-topic-input").value = "";
  modals.fillBatchTemplate("council");
  await modals.submitDispatchDrawer();
  assert.deepEqual(rpcLog.map(r => r.method), []);
  assert.ok(state.dirtyPresets.size);
  resetStudio();
  elements.get("council-topic-input").value = "原会话议题";
  councilChecked = ["advisor_kimi"];
  let release;
  state.bootstrapLoaded = false;
  state.bootstrapPromise = new Promise(resolve => { release = resolve; });
  state.dirtyPresets.set("advisor_codex", new Map([["label", 2]]));
  const inFlight = modals.submitCouncilSummon();
  state.conversationEpoch++;
  release();
  await inFlight;
  assert.deepEqual(rpcLog, []);
  state.dirtyPresets.clear();
  state.bootstrapLoaded = true;
  state.bootstrapPromise = null;
  await modals.submitCouncilSummon();
  assert.deepEqual(rpcLog[0].params.tasks.map(t => t.presetKey), councilChecked);
});

test("批量模板生成后撤销军师勾选，派发不回退该成员的裸路由", async () => {
  resetStudio();
  state.dispatchMode = "batch";
  elements.get("disp-prompt").value = "共同议题";
  modals.fillBatchTemplate("council");
  state.modeProfiles.complex.advisor.enabledKeys = ["advisor_kimi"];
  await modals.submitDispatchDrawer();
  const { tasks } = rpcLog.find(r => r.method === "delegateParallelBatch").params;
  assert.deepEqual(tasks.map(t => t.presetKey), ["advisor_kimi"]);
});

/* ---------- Playbook 修订号、complex 军师行与旧指纹重注 ---------- */
function tenMemberRoster() {
  const presets = { ...DEFAULT_ROLE_PRESETS,
    executor_extra: { group: "executor", provider: "codex", model: "gpt-6.2-sol", effort: "high", label: "额外执行", description: "负责脚本与数据迁移" },
    advisor_extra: { group: "advisor", provider: "kimi-code", model: "kimi-code/k3.1-pro", effort: "max", label: "额外军师" },
  };
  const group = (name) => Object.entries(presets).filter(([, p]) => p.group === name).map(([key]) => key);
  const modeProfiles = { complex: {
    advisor: { stageEnabled: true, enabledKeys: group("advisor") },
    executor: { enabledKeys: group("executor"), preferredKey: "executor_claude" },
    reviewer: { stageEnabled: true, enabledKeys: group("reviewer"), preferredKey: "reviewer" },
  } };
  return { presets, modeProfiles, keys: Object.values(modeProfiles.complex).flatMap((g) => g.enabledKeys) };
}

test("v0.2.5 Playbook：修订号 5，complex/relay 按需路由至 council 与 plan 技能，10 成员保留全部路由且 <= 1536 B", () => {
  assert.equal(MODE_PLAYBOOK_REVISION, 5);
  const { presets, modeProfiles, keys } = tenMemberRoster();
  assert.equal(keys.length, 10);
  const complex = buildModePlaybook({ orchestrationMode: "complex", presets, modeProfiles });
  assert.ok(complex.includes("2. L3 军师阶段开启：仅用户要求讨论或有方案分歧时读 agent-tower-council 技能盲评。军师："));
  assert.match(complex, /L1 单域强耦合\(含单测\)选 1 人 shared，禁拆源码与单测；L2 多独立低耦合模块读 agent-tower-plan/);
  assert.doesNotMatch(complex, />=6文件/);
  assert.doesNotMatch(complex, /共同决断|councils/);
  assert.ok(Buffer.byteLength(complex) <= 1536, `${Buffer.byteLength(complex)} B`);
  for (const key of keys) assert.ok(complex.includes(key), `10 人预算内仍须保留成员 ${key}`);
  assert.doesNotMatch(complex, /orchestrator_capabilities/);
  assert.doesNotMatch(complex, /curator_codex|业务规范、/);
  assert.doesNotMatch(complex, /\[\]|、、/);
  const closed = buildModePlaybook({ orchestrationMode: "complex", presets, modeProfiles: { complex: {
    ...modeProfiles.complex, advisor: { ...modeProfiles.complex.advisor, stageEnabled: false } } } });
  assert.match(closed, /2\. 军师阶段已关闭，不调军师。/);
  assert.doesNotMatch(closed, /agent-tower-council|councils/);
  for (const mode of ["direct", "relay"]) assert.doesNotMatch(buildModePlaybook({ orchestrationMode: mode, presets, modeProfiles }), /agent-tower-council|councils/);
});

test("v0.2.5 modeFingerprint：v0.2.4 修订号的旧指纹触发单次重注新版 complex Playbook，次轮返回 null", () => withProjectSandbox("v025-fingerprint", async (dir) => {
  const blank = project(dir, "blank");
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir);
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: blank, catalogLoader: offlineCatalog });
  try {
    o.updateHostContext({ appDataDir });
    await o.setConversationPolicy({ conversationId: "council-conv", workspace: blank, orchestrationMode: "complex" });
    const settings = o.db.getSettings();
    const current = buildModePlaybook({
      orchestrationMode: "complex", presetRevision: settings.presetRevision || 0, presets: settings.presets || settings.rolePresets,
      memberPool: settings.memberPool, modeProfiles: settings.modeProfiles, relayTargetPresetKey: settings.relayTargetPresetKey,
      customPipelines: settings.customPipelines,
    });
    const hash = createHash("sha256").update(current).digest("hex").slice(0, 12);
    // Same rendered content, but recorded by a v0.2.4 daemon (revision 2): the revision alone must force a re-inject.
    const staleMode = `2:complex:${settings.presetRevision || 0}:${hash}`;
    const playbookFingerprints = new Map([["council-conv", { fingerprint: `${staleMode}:`, modeFingerprint: staleMode, contextHash: "", lastInitialNumSteps: 3 }]]);
    const scope = createScopePolicyModule({
      db: o.db, dataDir: path.join(dir, "control"), repoRootCache: new Map(), activeRuns: new Map(), playbookFingerprints,
      hostContext: { appDataDir }, hostSync: { buildHostEnvForDriver: () => ({}), findThreadByHostConversationId: () => null },
    });
    const sync = () => scope.getConversationPolicy({ conversationId: "council-conv", workspace: blank, syncHostPlaybook: true, initialNumSteps: 3 }).playbookInject;
    const injected = sync();
    assert.equal(injected, current);
    assert.match(injected, /agent-tower-council/);
    assert.equal(playbookFingerprints.get("council-conv").modeFingerprint, `${MODE_PLAYBOOK_REVISION}:complex:${settings.presetRevision || 0}:${hash}`);
    assert.equal(sync(), null);
  } finally {
    await o.shutdown();
  }
}));

/* ---------- councils/ 归档：Git 忽略、缓存保留、治理边界与主会话目录卡 ---------- */
const checkIgnore = (cwd, rel) => {
  try {
    execFileSync("git", ["check-ignore", "-q", rel], { cwd, windowsHide: true, stdio: "ignore" });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
};

test("v0.2.5 ensureStorageIgnoreRules：无根 .gitignore 的仓库默认忽略 councils/，放行业务规范且重复调用幂等", () => withProjectSandbox("v025-ignore", async (dir) => {
  const root = project(dir, "external");
  assert.equal(fs.existsSync(path.join(root, ".gitignore")), false);
  ensureStorageIgnoreRules(root);
  const ignoreFile = path.join(root, ".agent-tower", ".gitignore");
  const first = fs.readFileSync(ignoreFile, "utf8");
  assert.match(first, /^tmp\/\r?\ncouncils\/\r?\n/m);
  write(path.join(root, ".agent-tower", "councils", "2026-11-23-demo.md"), "# 会审纪要\n");
  write(path.join(root, ".agent-tower", "spec", "01-business", "a.md"), "---\nid: a\n---\n正文");
  assert.equal(checkIgnore(root, ".agent-tower/councils/2026-11-23-demo.md"), true);
  assert.equal(checkIgnore(root, ".agent-tower/councils/INDEX.md"), true);
  assert.equal(checkIgnore(root, ".agent-tower/spec/01-business/a.md"), false);
  write(path.join(root, ".agent-tower", "spec", "02-coding", "test.md"), "# Spec");
  assert.equal(checkIgnore(root, ".agent-tower/spec/02-coding/test.md"), false);
  ensureStorageIgnoreRules(root);
  ensureStorageIgnoreRules(root);
  const again = fs.readFileSync(ignoreFile, "utf8");
  assert.equal(again, first, "重复调用必须逐字节幂等");
  assert.doesNotMatch(again, /(\r?\n){3,}/);
  assert.equal(again.split(/\r?\n/).filter((line) => line === "councils/").length, 1);
}));

test("v0.2.5 councils/ 不计入运行缓存体积，cleanRuntimeCache 后逐字节完好保留", () => withProjectSandbox("c", async (dir) => {
  const root = project(dir, "r");
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: root, catalogLoader: offlineCatalog, recoverStaleState: false });
  try {
    const memo = write(path.join(root, ".agent-tower", "councils", "2026-11-23-demo.md"), "# 会审纪要\n".repeat(64));
    const index = write(path.join(root, ".agent-tower", "councils", "INDEX.md"), "| 日期 | 议题 |\n");
    write(path.join(root, ".agent-tower", "tmp", "scratch.bin"), "x".repeat(32));
    const worktreePath = path.join(root, ".agent-tower", "worktrees", "w");
    git(root, "-c", "worktree.useRelativePaths=true", "worktree", "add", "-b", "archive", worktreePath);
    ensureStorageIgnoreRules(worktreePath);
    const localMemo = write(path.join(worktreePath, ".agent-tower", "councils", "private.md"), "draft");
    const before = await o.getRuntimeCacheStatus({ workspace: root });
    fs.appendFileSync(memo, "z".repeat(8192));
    fs.appendFileSync(localMemo, "y".repeat(8192));
    const grown = await o.getRuntimeCacheStatus({ workspace: root });
    assert.equal(grown.totalBytes, before.totalBytes, "councils/ 体积变化不得影响运行缓存统计");
    assert.equal(grown.worktrees.find(w => w.name === path.basename(worktreePath)).cleanable, false);
    const memoBytes = fs.readFileSync(memo);
    const indexBytes = fs.readFileSync(index);
    const cleaned = await o.cleanRuntimeCache({ workspace: root });
    assert.equal(cleaned.ok, true);
    assert.equal(fs.existsSync(path.join(root, ".agent-tower", "tmp", "scratch.bin")), false, "tmp/ 仍按运行缓存清理");
    assert.equal(fs.readFileSync(localMemo, "utf8"), "draft" + "y".repeat(8192));
    assert.ok(fs.readFileSync(memo).equals(memoBytes));
    assert.ok(fs.readFileSync(index).equals(indexBytes));
  } finally {
    await o.shutdown();
  }
}));

test("v0.2.5 治理边界与目录卡：子 Agent 禁改且不投递 councils/**，主会话按需附单行索引，空白项目 0 注入", () => withProjectSandbox("v025-context", async (dir) => {
  const blank = project(dir, "blank");
  const withCouncils = project(dir, "with-councils");
  write(path.join(withCouncils, ".agent-tower", "councils", "INDEX.md"), "| 日期 | 议题 |\n| 2026-11-23 | demo |\n");
  write(path.join(withCouncils, ".agent-tower", "councils", "2026-11-23-demo.md"), "COUNCIL_SECRET_MARKER 主会话主观评价");
  assert.equal(hasCouncilsIndex(withCouncils), true);
  assert.equal(hasCouncilsIndex(blank), false);

  // 子 Agent：规范扫描与装配绝不读取 councils/**，治理边界明确禁擅改。
  const inventory = readProjectSpecs(withCouncils);
  assert.deepEqual(inventory.specs, []);
  const prompt = assembleSpecPrompt({ cwd: withCouncils, repoRoot: withCouncils, inventory, role: "executor", rawPrompt: "councils 会审",
    dynamicPrompt: "原始任务", selection: specSelection({}) });
  const assembled = JSON.stringify(prompt);
  assert.match(assembled, /\.agent-tower\/councils\/\*\*/);
  assert.doesNotMatch(assembled, /COUNCIL_SECRET_MARKER|2026-11-23-demo/);
  assert.equal(fs.readFileSync(path.join(repoRoot, "core", "spec-context.mjs"), "utf8").includes("不得擅自新建或修改 .agent-tower/spec/**、.agent-tower/councils/**"), true);

  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir);
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: project(dir, "default"), catalogLoader: offlineCatalog });
  try {
    o.updateHostContext({ appDataDir });
    const sync = (conversationId, workspace) => o.getConversationPolicy({ conversationId, workspace, syncHostPlaybook: true, initialNumSteps: 3 }).playbookInject;
    assert.equal(sync("blank-direct", blank), null);
    assert.equal(fs.existsSync(path.join(blank, ".agent-tower")), false, "空白项目 0 写盘");
    o.db.upsertThread({ id: "thr_native_child", hostConversationId: "swarm-child", nativeSessionId: "swarm-child",
      provider: "antigravity", workspace: withCouncils, meta: { isNativeHost: true, isSwarmMember: true, rootConversationId: "council-direct" } });
    const nativeChild = sync("swarm-child", withCouncils);
    assert.match(nativeChild, /\[ROLE: GENERAL\]/);
    assert.doesNotMatch(nativeChild, /agent_tower_mode|COUNCIL_SECRET_MARKER|agent_tower_project_context/);
    const card = sync("council-direct", withCouncils);
    assert.match(card, /^<agent_tower_project_context sha="[0-9a-f]+">/);
    assert.match(card, /\n- \.agent-tower\/councils\/INDEX\.md · 军师会审纪要索引（续议同题可查阅，新会审按四段式归档）。\n/);
    assert.doesNotMatch(card, /agent_tower_mode|COUNCIL_SECRET_MARKER/);
    assert.ok(Buffer.byteLength(card) <= 1536);
    assert.equal(sync("council-direct", withCouncils), null);
  } finally {
    await o.shutdown();
  }

  assert.deepEqual(readProjectSpecs(repoRoot).warnings, []);
  assert.equal(projectSpecStatus(repoRoot, { specLimits: { totalMaxKb: 24 } }).warnings.length, 0);
  for (const prefix of Object.values(ROLE_SYSTEM_PREFIXES)) assert.doesNotMatch(prefix, /councils/);
}));

test("v0.2.5 随包规则与文档去重指向按需技能，完整会审/规划/发版 SOP 收归各自 SKILL.md", () => {
  const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const version = JSON.parse(read("plugin.json")).version;
  for (const rel of ["rules/AGENTS.md", "skills/agent-tower/SKILL.md", "README.md"]) {
    const doc = read(rel);
    assert.ok(doc.includes(`AgentTower v${version}`), `${rel} 版本标识须与 plugin.json (${version}) 一致`);
  }
  for (const rel of ["rules/AGENTS.md", "skills/agent-tower/SKILL.md"]) {
    const doc = read(rel);
    assert.match(doc, /自然融合白话/);
    assert.match(doc, /agent-tower-council/);
    assert.match(doc, /agent-tower-plan/);
    assert.match(doc, /\.agent-tower\/councils\//);
    assert.doesNotMatch(doc, /共同决断 \/ 分歧点|YYYY-MM-DD-<topic>\.md|<agent_tower_plan>/, `${rel} 仍残留已抽离技能的展开细则`);
  }
  const councilSkill = read("skills/agent-tower-council/SKILL.md");
  assert.match(councilSkill, /同题原话盲评/);
  assert.match(councilSkill, /共同决断 \/ 分歧点 \+ 主会话看法 \/ 各军师独特看法 \+ 主会话评价 \/ 拍板与待确认/);
  assert.match(councilSkill, /\.agent-tower\/councils\/YYYY-MM-DD-<topic>\.md/);
  const planSkill = read("skills/agent-tower-plan/SKILL.md");
  assert.match(planSkill, /\.agent-tower\/plans\/YYYY-MM-DD-<slug>\.md/);
  assert.match(planSkill, /planPath/);
  assert.match(planSkill, /worktree_diff/);
  assert.match(planSkill, /Checklist/);
  if (fs.existsSync(path.join(repoRoot, ".agents/skills/release-cutover/SKILL.md"))) {
    const releaseSkill = read(".agents/skills/release-cutover/SKILL.md");
    assert.match(releaseSkill, /--stage-only/);
    assert.match(releaseSkill, /--cutover-only/);
    assert.match(releaseSkill, /AGENT_TOWER_VALIDATE_STAGE_IN_REPO/);
  }
  const readme = read("README.md");
  assert.match(readme, /AGPL-3\.0/);
  assert.doesNotMatch(readme, /AGENT_TOWER_VALIDATE_STAGE_IN_REPO/);
  assert.doesNotMatch(readme, /[A-Za-z]:[\\/]Users[\\/](?!<user>)/);
  if (fs.existsSync(path.join(repoRoot, ".agent-tower/docs/STORAGE_AND_TESTING.md"))) {
    assert.match(read(".agent-tower/docs/STORAGE_AND_TESTING.md"), /release-cutover/);
  }
  assert.match(read("sidecars/studio/mcp-entry.mjs"), /军师会审请保持用户原话同题派发/);
  if (fs.existsSync(path.join(repoRoot, ".agent-tower/spec/02-coding/storage-and-git.md"))) {
    assert.match(read(".agent-tower/spec/02-coding/storage-and-git.md"), /永远保留 `spec\/\*\*`.*`councils\/\*\*`、`plans\/\*\*`、`\.gitignore`/);
  }
});

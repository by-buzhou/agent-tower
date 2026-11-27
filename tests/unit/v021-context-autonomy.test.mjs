import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import {
  assembleSpecPrompt, buildDerivedSpecIndex, hasEvolutionIndex, hasRoadmapDoc,
  projectSpecStatus, readProjectSpecs, specSelection, syncProjectSpecScaffold,
} from "../../core/spec-context.mjs";
import { git, offlineCatalog, project } from "../helpers/fixtures.mjs";
import { runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();
const specRoot = ".agent-tower/spec";
const indexPath = `${specRoot}/INDEX.md`;
const specPath = (kind, id) => `${specRoot}/${kind === "business" ? "01-business" : "02-coding"}/${id}.md`;
const write = (root, rel, content) => {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const card = (root, kind, id, meta = "", body = "规范正文") => write(root, specPath(kind, id), `---\nid: ${id}\n${meta}\n---\n${body}`);
const assemble = (root, options = {}) => assembleSpecPrompt({ cwd: root, repoRoot: root, inventory: readProjectSpecs(root),
  role: "executor", rawPrompt: "targetword", dynamicPrompt: "原始任务", selection: specSelection({}), ...options });

async function withOrchestrator(dir, cwd, action) {
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  const appDataDir = path.join(dir, "host");
  fs.mkdirSync(appDataDir);
  o.updateHostContext({ appDataDir });
  try { await action(o); }
  finally { await o.shutdown(); }
}

test("direct 首轮只发索引，按内容和模式分别去重，压缩补发且只读", () => withProjectSandbox("v021-direct", async dir => {
  const cwd = project(dir, "default");
  const external = project(dir, "external");
  const blank = project(dir, "blank");
  card(cwd, "business", "default-only");
  const meta = "title: 对账红线\nrequired: true\nscopes: [core/**]\nsummary: 不能进入索引的摘要";
  card(external, "business", "settlement", meta, "不能进入索引的正文");
  await withOrchestrator(dir, cwd, async o => {
    const sync = (params = {}) => o.getConversationPolicy({ conversationId: "direct", workspace: external,
      syncHostPlaybook: true, initialNumSteps: 5, ...params }).playbookInject;
    assert.match(sync(), /^<agent_tower_project_context sha="[0-9a-f]+">\n- business\/settlement \[必读\] · scopes: core\/\*\*/);
    assert.equal(sync(), null);
    card(external, "business", "settlement", meta, "只改正文也应重推");
    const changed = sync();
    assert.match(changed, /· 对账红线 \(\.agent-tower\/spec\/01-business\/settlement\.md\)/);
    assert.match(changed, /【规范维护】主会话与干活成员只读消费项目规范，由专职规范维护官提案，经用户确认后落盘。/);
    assert.doesNotMatch(changed, /agent_tower_mode|不能进入索引|只改正文|default-only/);
    assert.equal(sync(), null);
    const blankParams = { workspace: blank, conversationId: "blank" };
    assert.equal(sync(blankParams), null);
    assert.equal(sync({ ...blankParams, initialNumSteps: 1 }), null);
    assert.equal(sync({ workspace: path.join(dir, "typo"), conversationId: "unknown" }), null);
    assert.equal(sync({ workspace: undefined, conversationId: "default" }), null);
    await o.setConversationPolicy({ conversationId: "bound", workspace: external, orchestrationMode: "direct" });
    assert.match(sync({ workspace: undefined, conversationId: "bound" }), /business\/settlement/);
    await o.setConversationPolicy({ conversationId: "bound-no-workspace", orchestrationMode: "direct" });
    assert.equal(sync({ workspace: path.join(dir, "missing"), conversationId: "bound-no-workspace" }), null);
    assert.equal(sync({ workspace: blank, conversationId: "bound-no-workspace" }), null);
    o.db.upsertThread({ id: "thr_native_root", hostConversationId: "bound-thread", workspace: external,
      title: "Bound", provider: "antigravity", meta: { projectRoot: external } });
    assert.match(sync({ workspace: path.join(dir, "missing"), conversationId: "bound-thread" }), /business\/settlement/);
    await o.setConversationPolicy({ conversationId: "direct", orchestrationMode: "relay" });
    const modeOnly = sync();
    assert.match(modeOnly, /^<agent_tower_mode mode="relay"/);
    assert.doesNotMatch(modeOnly, /agent_tower_project_context/);
    assert.match(sync({ initialNumSteps: 1 }), /<\/agent_tower_mode>\s+<agent_tower_project_context/);
    o.db.saveSettings({ defaultOrchestrationMode: "relay" });
    const firstRelay = sync({ conversationId: "first-relay", initialNumSteps: 1, workspace: undefined });
    assert.match(firstRelay, /^<agent_tower_mode mode="relay"/);
    assert.doesNotMatch(firstRelay, /agent_tower_project_context|default-only/);
    assert.equal(exists(blank, ".agent-tower"), false);
    assert.equal(exists(blank, ".gitignore"), false);
    assert.equal(exists(cwd, indexPath), false);
    assert.equal(exists(external, indexPath), false);
  });
}));

test("direct 绑定项目在守护进程重启后仍用于宿主错拼路径", () => withProjectSandbox("v021-bound-restart", async dir => {
  const base = project(dir, "default"), target = project(dir, "bound");
  card(base, "coding", "default-only");
  card(target, "business", "bound-only");
  const make = () => createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: base, catalogLoader: offlineCatalog });
  const first = make();
  try { await first.setConversationPolicy({ conversationId: "bound", orchestrationMode: "direct", workspace: target }); }
  finally { await first.shutdown(); }
  const reopened = make();
  try {
    const result = reopened.getConversationPolicy({ conversationId: "bound", workspace: path.join(dir, "typo"), syncHostPlaybook: true });
    assert.match(result.playbookInject, /business\/bound-only/);
    assert.doesNotMatch(result.playbookInject, /coding\/default-only/);
  } finally { await reopened.shutdown(); }
}));

test("主会话索引最多 1536 UTF-8 字节，保留文档入口与防忘钩子", () => withProjectSandbox("v021-index-limit", async dir => {
  const cwd = project(dir, "index");
  for (let i = 0; i < 30; i++) card(cwd, "business", `spec-${i}`, `scopes: [${"中文".repeat(15)}/**]`);
  write(cwd, ".agent-tower/docs/ROADMAP.md", "ROADMAP_SECRET");
  write(cwd, ".agent-tower/docs/evolution/INDEX.md", "EVOLUTION_SECRET");
  await withOrchestrator(dir, cwd, o => {
    const result = o.getConversationPolicy({ conversationId: "limited", cwd, syncHostPlaybook: true }).playbookInject;
    assert.ok(Buffer.byteLength(result) <= 1536);
    assert.match(result, /另有 \d+ 份规范，查阅 \.agent-tower\/spec\/INDEX\.md/);
    assert.match(result, /docs\/ROADMAP\.md[\s\S]+docs\/evolution\/INDEX\.md[\s\S]+【规范维护】/);
    assert.doesNotMatch(result, /_SECRET|规范正文/);
    assert.equal(exists(cwd, indexPath), false);
  });
}));

test("首份业务规范触发 prepareTurn 自动补齐双层忽略、目录和派生索引", () => withProjectSandbox("v021-scaffold", async dir => {
  const base = project(dir, "base");
  const cwd = project(dir, "target");
  write(cwd, ".gitignore", "keep-me/\r\n.agent-tower/*\r\nkeep-last/\r\n");
  card(cwd, "business", "billing", "title: 结算规则\nrequired: true");
  await withOrchestrator(dir, base, async o => {
    const status = await o.handleRpc("listProjectSpecs", { cwd });
    assert.equal(status.counts.business, 1);
    assert.equal(status.initialized, false);
    assert.equal(exists(cwd, ".agent-tower/.gitignore"), false);
    assert.equal(exists(cwd, indexPath), false);
    o.db.saveSettings({ defaultOrchestrationMode: "complex" });
    o.engineManager.runTurn = () => ({ result: Promise.resolve({ status: "completed" }) });
    await o.delegateTask({ cwd, conversationId: "autoscaffold", presetKey: "executor_codex", task: "verify", mode: "wait" });
    assert.match(read(cwd, ".gitignore"), /^keep-me\/\r\n# >>> agent-tower[^\n]+\r\n\.agent-tower\/\*/);
    assert.match(read(cwd, ".gitignore"), /# <<< agent-tower\r\nkeep-last\/\r\n$/);
    assert.match(read(cwd, ".agent-tower/.gitignore"), /# >>> agent-tower-runtime/);
    assert.match(read(cwd, indexPath), /\[结算规则\]\(01-business\/billing\.md\) · 必读/);
    assert.deepEqual(fs.readdirSync(path.join(cwd, specRoot, "02-coding")), []);
    assert.match(read(cwd, `${specRoot}/00-plugin/executor.md`), /\[GOVERNANCE BOUNDARY\]/);
    const untracked = git(cwd, "--no-optional-locks", "ls-files", "--others", "--exclude-standard").split("\n");
    assert.ok(untracked.includes(indexPath));
    assert.ok(untracked.includes(specPath("business", "billing")));
    assert.ok(!untracked.some(f => f.includes("00-plugin") || f.includes("tower.sqlite")));
    const index = path.join(cwd, indexPath);
    const before = fs.statSync(index).mtimeMs;
    syncProjectSpecScaffold(cwd, "0.2.0");
    assert.equal(fs.statSync(index).mtimeMs, before);
    card(cwd, "coding", "arch", "title: 架构红线\nscopes: [core/**]\ntags: [targetword]");
    const advisor = assemble(cwd, { role: "advisor" }).full;
    assert.ok(advisor.meta.items.some(({ key, reason }) => key === "coding/arch" && reason === "tag"));
    assert.ok(assemble(cwd, { role: "advisor", rawPrompt: "inspect `core/entry.mjs`" }).full.meta.items
      .some(({ key, reason }) => key === "coding/arch" && reason === "text_path"));
    syncProjectSpecScaffold(cwd, "0.2.0");
    assert.match(read(cwd, indexPath), /\[架构红线\]\(02-coding\/arch\.md\) · 选读/);
    assert.ok(!fs.readdirSync(path.join(cwd, specRoot)).some(file => file.endsWith(".tmp")));
  });
}));

test("精确略过 v0.2.0 空壳，保留同名用户规范，拒绝链接写入", () => withProjectSandbox("v021-legacy", async dir => {
  const cwd = project(dir, "legacy");
  const original = kind => `---\nid: example\ntitle: ${kind} 规范示例\nkind: ${kind}\nrequired: false\nscopes: []\ntags: []\nsummary: 填写适用范围和项目规则。\n---\n\n请在此填写项目约定。\n`;
  for (const kind of ["business", "coding"]) write(cwd, specPath(kind, "example"), original(kind));
  assert.deepEqual(readProjectSpecs(cwd), { specs: [], warnings: [] });
  assert.match(buildDerivedSpecIndex([]), /01-business\/.*\n.*02-coding\//);
  syncProjectSpecScaffold(cwd, "0.2.1");
  assert.equal(exists(cwd, indexPath), false);
  assert.equal(exists(cwd, ".gitignore"), false);
  write(cwd, specPath("coding", "example"), original("coding") + "手写约定\n");
  const status = projectSpecStatus(cwd, { specId: "coding/example", includeBody: true });
  assert.equal(status.counts.total, 1);
  assert.match(status.specs[0].body, /手写约定/);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(cwd, specRoot, "00-plugin"), process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => syncProjectSpecScaffold(cwd, "0.2.1"), /Linked path refused/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(exists(cwd, indexPath), false);
  assert.equal(read(cwd, specPath("business", "example")), original("business"));
}));

test("summary 的完整条目按 UTF-8 封顶，其余保留路径，规范数量只告警", () => withProjectSandbox("v021-summary", async cwd => {
  const summary = "中文摘要".repeat(40);
  for (const [kind, count] of [["business", 17], ["coding", 11]]) {
    for (let i = 0; i < count; i++) card(cwd, kind, `rule-${i}`, `tags: [targetword]\nsummary: ${summary}`, "大".repeat(1000));
  }
  const result = assemble(cwd).full;
  assert.deepEqual(result.meta.warnings.filter(({ code }) => code === "SPEC_COUNT_SOFT_LIMIT").map(({ key }) => key), ["business", "coding"]);
  assert.equal(result.meta.warnings.filter(({ code }) => code === "SUMMARY_BUDGET_CAPPED").length, 1);
  assert.equal(result.meta.summaryCount, 28);
  const full = [...result.prompt.matchAll(/^(### .+\n中文摘要.+)\n\n/gm)].map(match => match[0]);
  assert.ok(full.length > 0 && full.length < 28);
  assert.ok(Buffer.byteLength(full.join("")) <= 4096);
  const summaries = result.prompt.slice(result.prompt.indexOf("### "), result.prompt.indexOf("</agent_tower_specs>"));
  assert.ok(Buffer.byteLength(summaries) <= 4096);
  for (const item of result.meta.items.filter(item => item.kind !== "plugin")) assert.ok(summaries.includes(item.relPath));
  assert.doesNotMatch(result.prompt, /大{2}/);
}));

test("规范删除后同一原生会话只收到一次废止提示并落账", () => withProjectSandbox("v021-revoked", async dir => {
  const cwd = project(dir, "ledger");
  const file = card(cwd, "coding", "retire", "tags: [targetword]", "生效中的规则");
  await withOrchestrator(dir, cwd, async o => {
    o.db.saveSettings({ defaultOrchestrationMode: "complex", defaultExternalSessionVisible: true });
    const prompts = [];
    o.engineManager.runTurn = options => {
      const nativeSessionId = "revoke-session";
      options.onEvent({ type: "session_bound", nativeSessionId, resumed: Boolean(options.nativeSessionId) });
      prompts.push(String(options.prompt));
      return { result: Promise.resolve({ status: "completed", assistantText: "PASS", nativeSessionId }) };
    };
    const first = await o.delegateTask({ cwd, conversationId: "retire", task: "targetword", presetKey: "executor_codex", mode: "wait" });
    assert.match(prompts[0], /生效中的规则/);
    await o.sendToThread({ threadId: first.threadId, message: "unrelated", wait: true });
    assert.doesNotMatch(prompts[1], /规范已废止/);
    fs.unlinkSync(file);
    await o.sendToThread({ threadId: first.threadId, message: "继续", wait: true });
    assert.match(prompts[2], /^<agent_tower_specs v="1">\n【规范已废止】coding\/retire 已从项目活跃规范中移除，本轮起不再适用。\n/);
    const db = new DatabaseSync(path.join(cwd, ".agent-tower/conversations/tower.sqlite"), { readOnly: true });
    try {
      const row = db.prepare("SELECT tier, sha256 FROM spec_ledger WHERE native_session_id = ? AND spec_key = ?").get("revoke-session", "coding/retire");
      assert.deepEqual({ ...row }, { tier: "revoked", sha256: "revoked" });
    } finally { db.close(); }
    assert.doesNotMatch(read(cwd, indexPath), /retire\.md/);
    await o.sendToThread({ threadId: first.threadId, message: "继续下一轮", wait: true });
    assert.doesNotMatch(prompts[3], /规范已废止/);
  });
}));

test("ROADMAP 与 evolution 独立探测，角色卡元数据和正文按需返回", () => withProjectSandbox("v021-docs", async dir => {
  const roadmap = project(dir, "roadmap");
  const evolution = project(dir, "evolution");
  write(roadmap, ".agent-tower/docs/ROADMAP.md", "ROADMAP_SECRET");
  write(evolution, ".agent-tower/docs/evolution/INDEX.md", "EVOLUTION_SECRET");
  assert.equal(hasRoadmapDoc(roadmap), true);
  assert.equal(hasRoadmapDoc(evolution), false);
  assert.equal(hasEvolutionIndex(roadmap), false);
  assert.equal(hasEvolutionIndex(evolution), true);
  const executorPrompt = assemble(roadmap).full.prompt;
  assert.match(executorPrompt, /Only implement the requested scope — do not speculatively add future hooks or over-engineer\./);
  assert.doesNotMatch(executorPrompt, /\[EVOLUTION INDEX\]|\[ROADMAP ISOLATION\]|ROADMAP\.md|ROADMAP_SECRET/);
  assert.match(assemble(evolution).full.prompt, /\[EVOLUTION INDEX\]/);
  assert.doesNotMatch(assemble(evolution).full.prompt, /ROADMAP\.md|\[ROADMAP ISOLATION\]|\[EVOLUTION MATCHES\]|EVOLUTION_SECRET/);
  const { pluginSpecs } = projectSpecStatus(roadmap, { specId: "plugin/general", includeBody: true });
  assert.equal(pluginSpecs.length, 5);
  assert.ok(pluginSpecs.every(({ kind, summary, relPath, materialized }) => kind === "plugin" && summary && relPath && !materialized));
  assert.deepEqual(pluginSpecs.filter(spec => Object.hasOwn(spec, "body")).map(({ id }) => id), ["general"]);
  const general = pluginSpecs.find(({ id }) => id === "general");
  assert.doesNotMatch(general.body, /\[GOVERNANCE BOUNDARY\]|\[ROADMAP ISOLATION\]|ROADMAP\.md/);
  assert.doesNotMatch(assemble(roadmap, { role: "general" }).full.prompt, /\[ROADMAP ISOLATION\]|ROADMAP\.md|ROADMAP_SECRET/);
  assert.equal(general.bytes, Buffer.byteLength(general.body));
  for (const role of ["advisor", "review", "research"]) {
    const { prompt } = assemble(roadmap, { role }).full;
    assert.match(prompt, /\[GOVERNANCE BOUNDARY\]/);
    assert.doesNotMatch(prompt, /\[ROADMAP ISOLATION\]/);
  }
  const linked = path.join(dir, "linked");
  fs.symlinkSync(roadmap, linked, process.platform === "win32" ? "junction" : "dir");
  assert.equal(hasRoadmapDoc(linked), false);
  await withOrchestrator(dir, roadmap, o => {
    const query = (conversationId, workspace) => o.getConversationPolicy({ conversationId, workspace, syncHostPlaybook: true }).playbookInject;
    const roadmapContext = query("roadmap-only", roadmap);
    const evolutionContext = query("evolution-only", evolution);
    assert.match(roadmapContext, /docs\/ROADMAP\.md/);
    assert.doesNotMatch(roadmapContext, /docs\/evolution\/INDEX\.md|ROADMAP_SECRET/);
    assert.match(evolutionContext, /docs\/evolution\/INDEX\.md/);
    assert.doesNotMatch(evolutionContext, /docs\/ROADMAP\.md|EVOLUTION_SECRET/);
    assert.equal(query("linked-root", linked), null);
  });
}));

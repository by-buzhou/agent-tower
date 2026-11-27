import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { buildInitialRosterFromProbe, DEFAULT_ROLE_PRESETS, inferProviderFromModel, loadProviderCatalogs } from "../../core/catalog.mjs";
import { runGenericAcpTurn } from "../../core/engines/generic-acp.mjs";
import { captureNoWindow, mapAcpPermissionOutcome, resolveCodexBinary, safePathBinary } from "../../core/engines/proc-utils.mjs";
import { assembleSpecPrompt, readProjectSpecs } from "../../core/spec-context.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { MAIN_ROOT, nativePath, resolveMainRoot } from "../../core/storage-paths.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { within } from "../helpers/process.mjs";
import { repoRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

function write(file, contents = "") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents, { mode: 0o755 });
}

test("source root is dynamic and a mounted plugin creates its fallback only on consumption outside tests", () => withProjectSandbox("v031-root", async dir => {
  assert.equal(MAIN_ROOT, nativePath(repoRoot));
  const home = path.join(dir, "home");
  const mounted = path.join(home, ".gemini", "config", "plugins", "agent-tower");
  const script = path.join(mounted, "core", "storage-paths.mjs");
  write(script, fs.readFileSync(new URL("../../core/storage-paths.mjs", import.meta.url)));
  const fallback = nativePath(path.join(home, ".agent-tower", "workspace"));
  assert.equal(resolveMainRoot(repoRoot, home), nativePath(repoRoot));
  assert.equal(resolveMainRoot(mounted, home), fallback);
  const mcp = JSON.parse(fs.readFileSync(new URL("../../mcp_config.json", import.meta.url), "utf8"));
  assert.equal(mcp.mcpServers.orchestrator.env.AGENT_TOWER_DEFAULT_ROOT, undefined);

  const env = { ...process.env, HOME: home, USERPROFILE: home };
  delete env.NODE_TEST_CONTEXT;
  delete env.AGENT_TOWER_TEST_ROOT;
  const run = (body, flags) => captureNoWindow(process.execPath, ["--input-type=module", "-e",
    "import { MAIN_ROOT, ensureMainRoot, safeRoot } from " + JSON.stringify(pathToFileURL(script).href) + "; " + body],
    { cwd: dir, env: { ...env, ...flags } });
  const { stdout } = await run("console.log(MAIN_ROOT)");
  assert.equal(stdout.trim(), fallback);
  assert.equal(fs.existsSync(fallback), false);
  for (const flags of [{ NODE_TEST_CONTEXT: "child-v8" }, { AGENT_TOWER_TEST_ROOT: dir }]) {
    const { stdout } = await run("console.log(ensureMainRoot())", flags);
    assert.equal(stdout.trim(), fallback);
    assert.equal(fs.existsSync(fallback), false);
  }
  const consumed = await run("console.log(safeRoot(MAIN_ROOT, MAIN_ROOT))");
  assert.equal(consumed.stdout.trim(), fallback);
  assert.equal(fs.statSync(fallback).isDirectory(), true);
}));

test("ACP permissions select only an offered option with explicit approval", () => {
  const options = [
    { optionId: "permanent", kind: "allow_always" },
    { optionId: "no", kind: "reject_once" },
    { optionId: "yes", kind: "allow_once" },
    { optionId: "unsupported", kind: "unknown" },
  ];
  const selected = optionId => ({ outcome: "selected", optionId });
  for (const decision of [undefined, null, "", " ", "unknown", "timeout", "reject", "deny", "cancelled",
    "unsupported", {}, true, { optionId: "missing" }, { optionId: "unsupported" },
    { decision: "deny", optionId: "yes" }, { cancelled: true, optionId: "yes" }, { action: "cancel" },
    { decision: "approve_once", optionId: "permanent" }]) {
    assert.deepEqual(mapAcpPermissionOutcome(decision, options), selected("no"), JSON.stringify(decision));
  }
  for (const decision of ["approve_once", "approve", "allow", "allow_once", "accept", "yes",
    { action: "allow" }, { optionId: "yes" }]) {
    assert.deepEqual(mapAcpPermissionOutcome(decision, options), selected("yes"));
  }
  for (const decision of ["approve_always", "allow_always", "permanent", { optionId: "permanent" }]) {
    assert.deepEqual(mapAcpPermissionOutcome(decision, options), selected("permanent"));
  }
  assert.deepEqual(mapAcpPermissionOutcome(undefined, [{ optionId: "deny" }]), selected("deny"));
  assert.deepEqual(mapAcpPermissionOutcome("approve", [options[0]]), { outcome: "cancelled" });
  assert.deepEqual(mapAcpPermissionOutcome("allow", [options[3]]), { outcome: "cancelled" });
  assert.deepEqual(mapAcpPermissionOutcome("allow", []), { outcome: "cancelled" });
  assert.deepEqual(mapAcpPermissionOutcome("timeout", [undefined, options[2]]), { outcome: "cancelled" });
});

const acpFixture = [
  'import fs from "node:fs";',
  'import readline from "node:readline";',
  'const scenario = process.argv[2];',
  'const send = frame => console.log(JSON.stringify({ jsonrpc: "2.0", ...frame }));',
  'let promptId;',
  'for await (const line of readline.createInterface({ input: process.stdin })) {',
  '  const { id, method, result } = JSON.parse(line);',
  '  fs.appendFileSync(scenario + ".jsonl", line + "\\n");',
  '  if (id === "perm") {',
  '    send({ id: promptId, result: { stopReason: "end_turn" } });',
  '  } else if (method === "session/new") {',
  '    send({ id, result: { sessionId: "s", modes: { currentModeId: "default" }, configOptions: [',
  '      { id: "model", category: "model", currentValue: "current", options: [{ value: "requested" }] }',
  '    ] } });',
  '  } else if (method === "session/set_config_option" || (method === "session/set_model" && scenario === "failure")) {',
  '    send({ id, error: { code: -32602, message: "Unsupported model" } });',
  '  } else if (method === "session/prompt") {',
  '    promptId = id;',
  '    send({ id: "perm", method: "session/request_permission", params: { options: [',
  '      { optionId: "yes", kind: "allow_once" }, { optionId: "no", kind: "reject_once" }',
  '    ] } });',
  '  } else if (id !== undefined) send({ id, result: {} });',
  '}',
].join("\n");

test("generic ACP retries model selection, warns when both calls fail and denies unresolved permissions", () => withProjectSandbox("v031-acp", async dir => {
  const script = path.join(dir, "acp.mjs");
  write(script, acpFixture);
  for (const [scenario, model, expectedModelCalls, expectedWarning, expectedOption] of [
    ["failure", "requested", ["session/set_config_option", "session/set_model"], true, "no"],
    ["fallback", "requested", ["session/set_config_option", "session/set_model"], false, "yes"],
    ["inherited", "inherit", [], false, "no"],
  ]) {
    const events = [];
    let handle;
    const onPermissionRequest = scenario === "failure" ? req => { void handle.respondPermission(req.requestId, undefined); } :
      scenario === "fallback" ? () => "allow" : undefined;
    handle = runGenericAcpTurn({ cwd: dir, provider: "fixture-acp", providerConfig: { command: script, args: [scenario] },
      prompt: "test", model, permissionMode: "default", onPermissionRequest, onEvent: event => events.push(event) });
    try { assert.equal((await within(handle.result, 8000, scenario)).status, "completed"); }
    finally { await handle.forceKill(); }
    const frames = fs.readFileSync(path.join(dir, scenario + ".jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(frames.map(f => f.method).filter(m => ["session/set_config_option", "session/set_model"].includes(m)), expectedModelCalls);
    assert.deepEqual(frames.find(f => f.id === "perm").result, { outcome: { outcome: "selected", optionId: expectedOption } });
    const warning = events.find(evt => evt.itemId === "acp-model-warning");
    assert.equal(Boolean(warning), expectedWarning);
    if (warning) assert.match(warning.delta, /requested.*当前模型/);
  }
}));

test("catalog reports disk and host installation evidence and keeps offline models", t => withProjectSandbox("v031-catalog", async dir => {
  const fakeHome = path.join(dir, "home");
  const binDir = path.join(dir, "path");
  const env = { HOME: fakeHome, USERPROFILE: fakeHome, APPDATA: fakeHome, LOCALAPPDATA: fakeHome,
    CODEX_HOME: path.join(fakeHome, ".codex"), PATH: binDir, ANTIGRAVITY_APP_DATA_DIR: "",
    ANTIGRAVITY_LS_ADDRESS: "", ANTIGRAVITY_AGENTAPI_EXE: "", npm_config_prefix: "" };
  const original = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, env);
  const absent = () => ({ command: "missing", resolvedPath: "", available: false });
  const options = { cacheDir: dir, agyResolveBinary: absent, kimiResolveBinary: absent, codexResolveBinary: absent };
  const catalog = async overrides => Object.fromEntries((await loadProviderCatalogs({ ...options, ...overrides })).providers.map(p => [p.id, p]));
  const providerIds = ["kimi-code", "codex", "antigravity"];
  const offline = await catalog();
  for (const id of providerIds) {
    const entry = offline[id];
    assert.equal(entry.installed, false, id);
    assert.equal(entry.status, "not_installed", id);
    assert.equal(entry.enabled, true, id);
    assert.ok(entry.models.length, id);
  }
  assert.ok(offline["kimi-code"].models.every(m => m.slug.startsWith("kimi-code/")));
  assert.equal(inferProviderFromModel("kimi-code/fixture"), "kimi-code");
  assert.equal(inferProviderFromModel("custom-gateway/fixture"), "");
  assert.equal(inferProviderFromModel("custom-gateway/fixture", [{ id: "custom-gateway" }]), "custom-gateway");

  const win = process.platform === "win32";
  const executable = name => name + (win ? ".exe" : "");
  const probeName = "agent-tower-v031-fixture";
  const kimiPath = path.join(fakeHome, ".local", "bin", executable(probeName));
  const codexPath = path.join(fakeHome, ".npm-global", "bin", executable("codex"));
  const agyPath = path.join(binDir, executable("agy"));
  fs.mkdirSync(kimiPath, { recursive: true });
  assert.equal(safePathBinary(probeName).available, false);
  assert.equal(safePathBinary(probeName).resolvedPath, "");
  fs.rmdirSync(kimiPath);
  write(kimiPath);
  if (!win) {
    fs.chmodSync(kimiPath, 0o644);
    assert.equal(safePathBinary(probeName).available, false);
    fs.chmodSync(kimiPath, 0o755);
  }
  assert.equal(safePathBinary(probeName).resolvedPath, kimiPath);
  write(codexPath);
  write(agyPath);
  const platforms = { win32: "pc-windows-msvc", darwin: "apple-darwin", linux: "unknown-linux-musl" };
  const arches = { x64: "x86_64", arm64: "aarch64" };
  if (platforms[process.platform] && arches[process.arch]) {
    const prefix = path.join(fakeHome, ".npm-global");
    const npmRoot = win ? prefix : path.join(prefix, "lib");
    const packageName = ["codex", process.platform, process.arch].join("-");
    const triple = [arches[process.arch], platforms[process.platform]].join("-");
    const nativeCodex = path.join(npmRoot, "node_modules", "@openai", packageName, "vendor", triple, "bin", executable("codex"));
    write(nativeCodex);
    assert.equal(resolveCodexBinary().resolvedPath, nativeCodex);
  }
  const installed = await catalog({ agyResolveBinary: undefined, kimiResolveBinary: () => safePathBinary(probeName), codexResolveBinary: undefined });
  for (const id of providerIds) {
    assert.equal(installed[id].installed, true, id);
    assert.equal(installed[id].status, "ready", id);
  }
  assert.equal((await catalog({ agyProbe: async () => undefined })).antigravity.installed, true);
  assert.equal((await catalog({ hostBridgeAvailable: true })).antigravity.installed, true);
  process.env.ANTIGRAVITY_APP_DATA_DIR = dir;
  assert.equal((await catalog()).antigravity.installed, true);
  process.env.ANTIGRAVITY_APP_DATA_DIR = "";
  write(path.join(dir, "agy-catalog-cache.json"), '{"models":[{"slug":"gemini-4-neon"}]}');
  assert.equal((await catalog()).antigravity.installed, true);

  write(path.join(fakeHome, ".kimi-code", "config.toml"), 'default_model = "custom-gateway/fixture"\n[models."custom-gateway/fixture"]\nmodel = "Fixture"\n');
  write(path.join(fakeHome, ".codex", "config.toml"), 'model = "gpt-fixture"\nmodel_catalog_json = "models.json"\n');
  write(path.join(fakeHome, ".codex", "models.json"), '{"models":[{"slug":"gpt-fixture"}]}');
  const configured = await catalog();
  assert.equal(configured.codex.catalogSource, "local-config-catalog");
  assert.equal(configured.codex.configDefaultModel, "gpt-fixture");
  assert.equal(configured["kimi-code"].models[0].slug, "custom-gateway/fixture");

  // Orchestrator ensureCatalog forwards dynamic hostContext to loadProviderCatalogs and invalidates cold cache on attach
  const ws = path.join(dir, "orch-catalog");
  fs.mkdirSync(ws, { recursive: true });
  const orch = createOrchestrator({
    dataDir: path.join(dir, "orch-control"),
    defaultStudioRoot: ws,
    catalogLoader: opts => loadProviderCatalogs({ ...options, cacheDir: path.join(dir, "orch-control"), hostBridgeAvailable: opts.hostBridgeAvailable }),
  });
  try {
    const coldCaps = await orch.getCapabilities({ workspace: ws });
    assert.equal(coldCaps.providers.find(p => p.id === "antigravity").installed, false);
    orch.updateHostContext({ agentApiExe: agyPath, lsAddress: "127.0.0.1:9999", csrfToken: "tok" });
    const warmCaps = await orch.getCapabilities({ workspace: ws });
    assert.equal(warmCaps.providers.find(p => p.id === "antigravity").installed, true);
  } finally {
    await orch.shutdown();
  }
}));

test("first-run roster uses configured and live models before static presets", () => {
  const found = { command: "cli", resolvedPath: "resolved" };
  const binaries = { codex: found, "kimi-code": found };
  const { presets } = buildInitialRosterFromProbe({ binaries, hostBridgeAvailable: true, catalog: { providers: [
    { id: "codex", catalogSource: "local-config-catalog", configDefaultModel: "gpt-configured", models: [{ slug: "gpt-first" }] },
    { id: "kimi-code", catalogSource: "kimi-acp-live", models: [{ slug: "kimi-code/live", defaultEffort: "low" }] },
    { id: "antigravity", catalogSource: "agy-live", models: [{ id: "gemini-4-neon" }] },
  ] } });
  assert.equal(presets.executor_codex.model, "gpt-configured");
  assert.equal(presets.curator_codex.model, "gpt-configured");
  assert.equal(presets.curator_codex.permissionMode, "read-only");
  assert.equal(presets.executor_kimi.model, "kimi-code/live");
  assert.equal(presets.advisor_agy.model, "gemini-4-neon");
  assert.equal(presets.curator_agy.model, "gemini-4-neon");
  assert.equal(presets.curator_agy.isolation, "shared");
  const fallback = buildInitialRosterFromProbe({ binaries, catalog: { providers: [
    { id: "codex", catalogSource: "builtin", models: [{ slug: "gpt-unprobed" }] },
  ] } }).presets;
  assert.equal(fallback.executor_codex.model, DEFAULT_ROLE_PRESETS.executor_codex.model);
});

test("obsolete ledger prefixes retire silently and supported keys still deliver revocations", () => withProjectSandbox("v031-ledger", dir => {
  const ledger = new Map(["retired/card", "business/removed", "plugin/rules", "plan/work"].map(key => [key, { tier: "inline", sha256: "old" }]));
  const { delta } = assembleSpecPrompt({
    cwd: dir, role: "executor", inventory: readProjectSpecs(dir), rawPrompt: "task", dynamicPrompt: "task", ledger,
  });
  assert.doesNotMatch(delta.prompt, /retired\/card/);
  assert.match(delta.prompt, /business\/removed/);
  for (const key of ["retired/card", "business/removed"]) {
    assert.deepEqual(delta.delivered.find(item => item.key === key), { key, sha256: "revoked", tier: "revoked" });
  }
  assert.equal(delta.delivered.some(item => item.key === "plugin/rules" || item.key === "plan/work"), false);
}));

test("orchestrator respondRuntimeRequest defaults empty permission decisions to reject", () => withProjectSandbox("v031-perm-rpc", async dir => {
  const cwd = project(dir, "repo");
  const o = createOrchestrator({ dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, catalogLoader: offlineCatalog });
  o.db.saveSettings({ defaultOrchestrationMode: "complex" });
  try {
    let forwarded = null;
    let finishTurn;
    o.engineManager.runTurn = opts => {
      queueMicrotask(() => {
        void opts.onPermissionRequest?.({ requestId: "perm_empty_v031", title: "Run shell", options: [{ optionId: "no", kind: "reject_once" }] });
      });
      return {
        result: new Promise(resolve => { finishTurn = resolve; }),
        cancel: async () => finishTurn?.({ status: "interrupted" }),
        forceKill: async () => finishTurn?.({ status: "interrupted" }),
        respondPermission: async (id, payload) => {
          forwarded = { id, payload };
          queueMicrotask(() => finishTurn?.({ status: "completed", assistantText: "done" }));
          return true;
        },
      };
    };
    const launched = await o.delegateTask({ cwd, conversationId: "root-perm-v031", presetKey: "executor_codex", task: "perm check", wait: false });
    const deadline = Date.now() + 2000;
    while (!o.db.getRuntimeRequest("perm_empty_v031") && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 10));
    }
    const res = await o.respondRuntimeRequest({ requestId: "perm_empty_v031" });
    assert.equal(res.decision, "reject");
    assert.equal(forwarded?.payload?.decision, "reject");
    assert.deepEqual(o.db.getRuntimeRequest("perm_empty_v031")?.resolution, { decision: "reject" });
    await o.getTaskStatus({ taskId: launched.taskId, waitSeconds: 2 });
  } finally {
    await o.shutdown();
  }
}));

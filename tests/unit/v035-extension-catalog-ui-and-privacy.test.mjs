import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BUILTIN_EXTENSION_TEMPLATES,
  getExtensionCandidatePaths,
  listExtensionTemplates,
  loadProviderCatalogs,
  normalizeEffortForTarget,
  normalizeProviderId,
  sanitizeExtensionProviderConfig,
} from "../../core/catalog.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { MCP_TOOLS, executeMcpToolCall } from "../../sidecars/studio/mcp-entry.mjs";
import { BUILTIN_EXTENSION_TEMPLATES_UI, state as studioState } from "../../sidecars/studio/ui/state.js";
import { normalizeExtensionList, normalizeProvidersCatalog } from "../../sidecars/studio/ui/normalize.js";
import { presetOptions } from "../../sidecars/studio/ui/options.js";
import { quickEnableTemplateProvider, renderExtRowHtml, toggleExtensionEnvPolicy } from "../../sidecars/studio/ui/config-view.js";
import { openExtensionWizard, probeWizardExtension, saveWizardExtension } from "../../sidecars/studio/ui/modals.js";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { spawnSupervised, within } from "../helpers/process.mjs";
import { repoRoot, runsRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

process.env.AGENT_TOWER_TEST_ROOT ??= runsRoot();

function write(root, relative, text) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
  return file;
}

function openTower(dir, cwd) {
  return createOrchestrator({
    dataDir: path.join(dir, "control"),
    defaultStudioRoot: cwd,
    catalogLoader: offlineCatalog,
    recoverStaleState: false,
  });
}

test("v0.3.5 Honeyfile Canary：零点目录触碰，绝不读取 ~/.dsh / ~/.zcode / ~/.opencode 诱饵密钥且脱敏主目录路径", () => withProjectSandbox("v035-honeyfile", async dir => {
  const fakeHome = path.join(dir, "fake-home");
  const fakeAppData = path.join(fakeHome, "AppData", "Roaming");
  const fakeLocalAppData = path.join(fakeHome, "AppData", "Local");
  const workDir = project(dir, "canary-ws");

  // Plant honeyfile credential files in dot directories
  write(fakeHome, ".dsh/auth.json", JSON.stringify({ api_key: "sk-canary-dsh-secret" }));
  write(fakeHome, ".zcode/v2/config.json", JSON.stringify({ apiKey: "canary-id.zcode-secret" }));
  write(fakeHome, ".opencode/auth.json", JSON.stringify({ token: "fixture-opencode-canary" }));

  // Plant a fake ZCode desktop bundle script inside fakeLocalAppData so binary detection & home masking are tested too
  const fakeZCodeCjs = write(
    fakeLocalAppData,
    "Programs/ZCode/resources/glm/zcode.cjs",
    "#!/usr/bin/env node\nconsole.log('zcode stub');\n"
  );
  if (process.platform !== "win32") fs.chmodSync(fakeZCodeCjs, 0o755);

  const probeScript = write(dir, "canary-runner.mjs", `
import fs from "node:fs";
import fsp from "node:fs/promises";
import moduleApi from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

const honeyFiles = [
  "/.dsh/auth.json",
  "/.zcode/v2/config.json",
  "/.opencode/auth.json",
];
const forbiddenDotDirs = ["/.dsh", "/.zcode", "/.opencode"];
const honeyTouches = [];
const normalize = (p) => String(p || "").replace(/\\\\/g, "/").replace(/\\/+$/, "").toLowerCase();
const recordIfHoney = (op, target) => {
  const s = normalize(target);
  if (!s) return;
  if (honeyFiles.some((f) => s.endsWith(f))) {
    honeyTouches.push({ op, target: String(target), kind: "honeyfile" });
    return;
  }
  if (forbiddenDotDirs.some((d) => s.endsWith(d))) {
    honeyTouches.push({ op, target: String(target), kind: "dotdir_root" });
    return;
  }
  // Allow only proc-utils executable lookup inside ~/.opencode/bin/<exe>; forbid any other dotdir traversal/read
  if (s.includes("/.dsh/") || s.includes("/.zcode/") || (s.includes("/.opencode/") && !s.includes("/.opencode/bin/"))) {
    honeyTouches.push({ op, target: String(target), kind: "dotdir_child" });
  }
};

for (const name of ["readFileSync", "existsSync", "statSync", "lstatSync", "realpathSync", "readdirSync", "accessSync", "openSync"]) {
  const orig = fs[name];
  if (typeof orig !== "function") continue;
  const wrapped = function wrapped(target, ...rest) {
    recordIfHoney("fs." + name, target);
    return orig.call(this, target, ...rest);
  };
  if (typeof orig.native === "function") {
    const origNative = orig.native;
    wrapped.native = function wrappedNative(target, ...rest) {
      recordIfHoney("fs." + name + ".native", target);
      return origNative.call(this, target, ...rest);
    };
  }
  fs[name] = wrapped;
}
for (const name of ["readFile", "stat", "lstat", "realpath", "readdir", "access", "open"]) {
  const orig = fsp[name];
  if (typeof orig !== "function") continue;
  fsp[name] = function wrapped(target, ...rest) {
    recordIfHoney("fsp." + name, target);
    return orig.call(this, target, ...rest);
  };
}
moduleApi.syncBuiltinESMExports();

const repo = process.env.CANARY_REPO_ROOT;
const catalog = await import(pathToFileURL(path.join(repo, "core", "catalog.mjs")).href);
const orchMod = await import(pathToFileURL(path.join(repo, "core", "orchestrator.mjs")).href);

const templates = catalog.listExtensionTemplates();
const loaded = await catalog.loadProviderCatalogs({
  customProviders: [
    { id: "dsh", command: "dsh", protocol: "acp", enabled: true },
    { id: "zcode", command: "zcode", protocol: "zcode", enabled: true },
    { id: "opencode", command: "opencode", protocol: "acp", enabled: true },
  ],
  cacheDir: path.join(process.env.CANARY_DIR, "cache"),
  cwd: process.env.CANARY_WS,
});

const tower = orchMod.createOrchestrator({
  dataDir: path.join(process.env.CANARY_DIR, "control"),
  defaultStudioRoot: process.env.CANARY_WS,
  catalogLoader: async ({ customProviders }) => ({
    providers: loaded.providers,
    extensionTemplates: catalog.listExtensionTemplates({ customProviders }),
  }),
  recoverStaleState: false,
});
try {
  await tower.saveExtensionProvider({
    id: "zcode",
    name: "ZCode (Z.ai / 智谱)",
    protocol: "zcode",
    driverKind: "zcode",
    command: "zcode",
    args: ["app-server", "--stdio"],
    envPolicy: "minimal",
    enabled: true,
  });
  const listed = await tower.listExtensionProviders();
  process.stdout.write(JSON.stringify({
    honeyTouches,
    templates,
    listedTemplates: listed.templates,
    zcodeProvider: loaded.providers.find((p) => p.id === "zcode") || null,
    dshProvider: loaded.providers.find((p) => p.id === "dsh") || null,
  }));
} finally {
  await tower.shutdown();
}
`);

  const child = spawnSupervised(process.execPath, [probeScript], {
    cwd: dir,
    env: {
      ...process.env,
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      APPDATA: fakeAppData,
      LOCALAPPDATA: fakeLocalAppData,
      PATH: "",
      CANARY_REPO_ROOT: repoRoot,
      CANARY_DIR: dir,
      CANARY_WS: workDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeoutMs: 12_000,
  });

  try {
    let stdout = "";
    let stderr = "";
    child.proc.stdout.setEncoding("utf8").on("data", chunk => { stdout += chunk; });
    child.proc.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
    const res = await within(child.closed, 15_000, "v035 honeyfile canary");
    assert.equal(res.code, 0, stderr);
    const out = JSON.parse(stdout);

    assert.deepEqual(out.honeyTouches, [], `检测到触碰第三方点目录/诱饵密钥: ${JSON.stringify(out.honeyTouches)}`);
    for (const tpl of out.templates) {
      assert.equal(tpl.directoryDetected, false, `${tpl.id} directoryDetected 必须恒为 false`);
      assert.equal(tpl.directoryPath, null, `${tpl.id} directoryPath 必须恒为 null`);
      assert.equal("homeSubdir" in tpl, false, `${tpl.id} 不得暴露 homeSubdir`);
    }
    const serialized = JSON.stringify(out.listedTemplates);
    assert.doesNotMatch(serialized, /\.dsh[\\/]|auth\.json|\.zcode[\\/]|canary-id/i, "返回对象不得泄露任何点目录或诱饵路径");

    if (process.platform === "win32") {
      const zTpl = out.templates.find(t => t.id === "zcode");
      assert.equal(zTpl?.detected, true, "Windows 桌面路径下的 zcode.cjs 应被自动发现");
      assert.match(String(zTpl?.binaryPath || ""), /^~[\\/]/, "binaryPath 中的用户主目录前缀必须脱敏为 ~");
      assert.ok(!String(zTpl?.binaryPath || "").toLowerCase().includes(fakeHome.toLowerCase()), "binaryPath 不得暴露原始主目录路径");
    }

    assert.equal(out.dshProvider?.authenticated, false, "未安装/未握手扩展不得标为 authenticated: true");
  } finally {
    await child.stop();
  }
}));

test("v0.3.5 目录模板契约：dsh/zcode/opencode 字段、别名归一与 sanitizeExtensionProviderConfig", () => {
  for (const tpl of BUILTIN_EXTENSION_TEMPLATES) {
    assert.equal("homeSubdir" in tpl, false, `模板 ${tpl.id} 不得再声明 homeSubdir`);
  }

  const dsh = BUILTIN_EXTENSION_TEMPLATES.find(t => t.id === "dsh");
  assert.ok(dsh);
  assert.equal(dsh.protocol, "acp");
  assert.equal(dsh.driverKind, "generic-acp");
  assert.equal(dsh.command, "dsh");
  assert.deepEqual([...dsh.args], ["--profile", "acp"]);
  assert.equal(dsh.envPolicy, "minimal");
  assert.deepEqual([...dsh.credentialEnvKeys], ["DEEPSEEK_API_KEY"]);
  assert.equal(dsh.ephemeralSupport, "close-only");
  assert.deepEqual([...dsh.efforts], ["off", "low", "high", "max"]);

  const zcode = BUILTIN_EXTENSION_TEMPLATES.find(t => t.id === "zcode");
  assert.ok(zcode);
  assert.equal(zcode.protocol, "zcode");
  assert.equal(zcode.driverKind, "zcode");
  assert.equal(zcode.command, "zcode");
  assert.deepEqual([...zcode.args], ["app-server", "--stdio"]);
  assert.equal(zcode.envPolicy, "minimal");
  assert.deepEqual([...zcode.credentialEnvKeys], ["ZAI_API_KEY", "ZHIPU_API_KEY"]);
  assert.equal(zcode.ephemeralSupport, "close-only");

  const opencode = BUILTIN_EXTENSION_TEMPLATES.find(t => t.id === "opencode");
  assert.ok(opencode);
  assert.equal(opencode.envPolicy, "inherit");
  assert.equal(opencode.defaultModels[0].slug, "default");
  assert.ok(opencode.credentialEnvKeys.includes("OPENCODE_API_KEY"));

  assert.equal(normalizeProviderId("dsh"), "dsh");
  assert.equal(normalizeProviderId("deepseek-harness"), "dsh");
  assert.equal(normalizeProviderId("zcode"), "zcode");
  assert.equal(normalizeProviderId("z-code"), "zcode");
  assert.equal(normalizeProviderId("zai-zcode"), "zcode");

  const sanitizedZCode = sanitizeExtensionProviderConfig({
    id: "zcode",
    protocol: "zcode",
    command: "zcode",
    env: { ZAI_API_KEY: "secret-should-not-echo" },
  });
  assert.equal(sanitizedZCode.protocol, "zcode", "sanitizeExtensionProviderConfig 必须保留 protocol=zcode");
  assert.equal(sanitizedZCode.driverKind, "zcode");
  assert.equal(sanitizedZCode.envPolicy, "minimal");
  assert.equal(sanitizedZCode.ephemeralSupport, "close-only");
  assert.deepEqual(sanitizedZCode.envKeys, ["ZAI_API_KEY"]);
  assert.equal("env" in sanitizedZCode, false, "不得明文回显 env 凭据");

  const sanitizedCustom = sanitizeExtensionProviderConfig({
    id: "my-custom-acp",
    command: "my-agent",
    envPolicy: "minimal",
  });
  assert.equal(sanitizedCustom.protocol, "acp");
  assert.equal(sanitizedCustom.envPolicy, "minimal");
  assert.equal(sanitizeExtensionProviderConfig({ id: "zcode", protocol: "acp" }).driverKind, "generic-acp");
  assert.deepEqual(sanitizeExtensionProviderConfig({ id: "custom", extraCandidatePaths: ["fixture.cjs"] }).extraCandidatePaths, ["fixture.cjs"]);

  const zcodeCandidates = getExtensionCandidatePaths("zcode");
  assert.ok(zcodeCandidates.some(p => /zcode\.cjs$/i.test(p)), "zcode 应包含桌面包 resources/glm/zcode.cjs 候选路径");

  const listed = listExtensionTemplates();
  assert.ok(listed.some(t => t.id === "dsh" && t.envPolicy === "minimal"));
  assert.ok(listed.some(t => t.id === "zcode" && t.protocol === "zcode" && t.ephemeralSupport === "close-only"));
});

test("v0.3.5 catalog-settings 探针委托、候选路径透传与二进制指纹缓存", () => withProjectSandbox("v035-probe-cache", async dir => {
  const cwd = project(dir, "probe-repo");
  const fakeBin = write(dir, "stub-zcode.cjs", "// stub v1\n");
  const tower = openTower(dir, cwd);
  try {
    const seen = [];
    tower.engineManager.probeExtensionProvider = async (cfg) => {
      seen.push(cfg);
      return {
        ok: true,
        protocol: cfg.protocol,
        binaryPath: fakeBin,
        models: [{ id: "glm-5", name: "GLM-5" }],
        efforts: ["low", "medium", "high"],
      };
    };

    const first = await tower.probeExtensionProvider({
      id: "zcode",
      command: fakeBin,
      cwd,
    });
    assert.equal(first.ok, true);
    assert.equal(first.protocol, "zcode");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].protocol, "zcode");
    assert.equal(seen[0].driverKind, "zcode");
    assert.equal(seen[0].envPolicy, "minimal");
    assert.ok(Array.isArray(seen[0].extraCandidatePaths) && seen[0].extraCandidatePaths.length > 0);
    assert.deepEqual(seen[0].credentialEnvKeys, ["ZAI_API_KEY", "ZHIPU_API_KEY"]);

    // Second identical probe hits fingerprint cache (no duplicate session/new)
    const second = await tower.probeExtensionProvider({
      id: "zcode",
      command: fakeBin,
      cwd,
    });
    assert.equal(second.cached, true);
    assert.equal(seen.length, 1, "同指纹重复探测必须命中内存缓存");

    // Explicit force: true bypasses cache
    const forced = await tower.probeExtensionProvider({
      id: "zcode",
      command: fakeBin,
      cwd,
      force: true,
    });
    assert.equal(Boolean(forced.cached), false);
    assert.equal(seen.length, 2, "force=true 必须跳过探针缓存");
    const otherCwd = project(dir, "other-repo");
    await Promise.all([1, 2].map(() => tower.probeExtensionProvider({ id: "zcode", command: fakeBin, cwd: otherCwd })));
    assert.equal(seen.length, 3, "同项目并发握手合并，不同项目独立探测");
    fs.appendFileSync(fakeBin, "// updated");
    await tower.probeExtensionProvider({ id: "zcode", command: fakeBin, cwd: otherCwd });
    assert.equal(seen.length, 4, "入口文件升级后重新探测");
  } finally {
    await tower.shutdown();
  }
}));

test("v0.3.5 MCP：manage_providers 支持 zcode/envPolicy 且 AGENT_TOWER_CHILD_PROCESS=1 阻断递归派单", async () => {
  const manage = MCP_TOOLS.find(t => t.name === "manage_providers");
  assert.ok(manage);
  assert.deepEqual(manage.inputSchema.properties.protocol.enum, ["acp", "cli", "zcode"]);
  assert.deepEqual(manage.inputSchema.properties.envPolicy.enum, ["minimal", "inherit"]);
  assert.equal(manage.inputSchema.properties.command.type, "string", "保持 manage_providers 自定义 command 支持");

  const prev = process.env.AGENT_TOWER_CHILD_PROCESS;
  try {
    process.env.AGENT_TOWER_CHILD_PROCESS = "1";
    for (const tool of ["delegate_task", "delegate_parallel_batch", "thread_launch", "thread_send", "review_code"]) {
      const res = await executeMcpToolCall(tool, { task: "recursive attempt" });
      assert.equal(res.isError, true, `${tool} 在子进程内必须被阻断`);
      assert.match(res.content[0].text, /CHILD_RECURSIVE_DISPATCH_FORBIDDEN/);
    }
    for (const action of ["enqueue", "promote_to_steer"]) {
      const res = await executeMcpToolCall("thread_queue", { action });
      assert.match(res.content[0].text, /CHILD_RECURSIVE_DISPATCH_FORBIDDEN/);
    }
  } finally {
    if (prev === undefined) delete process.env.AGENT_TOWER_CHILD_PROCESS;
    else process.env.AGENT_TOWER_CHILD_PROCESS = prev;
  }
});

test("v0.3.5 Studio UI：模板/弹窗 zcode + envPolicy、列表一键切换、CSS 规范与开源文档同步", async () => {
  const html = fs.readFileSync(path.join(repoRoot, "sidecars", "studio", "index.html"), "utf8");
  assert.match(html, /<select id="ext-protocol"[\s\S]*?<option value="zcode">ZCode 官方协议 \(app-server stdio\)<\/option>/);
  assert.match(html, /<select id="ext-env-policy"[\s\S]*?<option value="minimal">[\s\S]*?<option value="inherit">/);

  assert.ok(BUILTIN_EXTENSION_TEMPLATES_UI.some(t => t.id === "dsh" && t.envPolicy === "minimal" && t.ephemeralSupport === "close-only"));
  assert.ok(BUILTIN_EXTENSION_TEMPLATES_UI.some(t => t.id === "zcode" && t.protocol === "zcode" && t.envPolicy === "minimal"));
  assert.ok(BUILTIN_EXTENSION_TEMPLATES_UI.some(t => t.id === "opencode" && t.envPolicy === "inherit"));

  const normalized = normalizeExtensionList(
    [{ id: "zcode", protocol: "zcode", driverKind: "zcode", envPolicy: "minimal", ephemeralSupport: "close-only", detected: true }],
    [{ id: "zcode", protocol: "zcode", driverKind: "zcode", envPolicy: "minimal", ephemeralSupport: "close-only", enabled: true }]
  );
  const zCust = normalized.customProviders.find(c => c.id === "zcode");
  assert.equal(zCust?.protocol, "zcode");
  assert.equal(zCust?.envPolicy, "minimal");
  assert.equal(zCust?.ephemeralSupport, "close-only");

  const rowHtml = renderExtRowHtml({
    id: "zcode",
    name: "ZCode (Z.ai / 智谱)",
    protocol: "zcode",
    command: "zcode",
    args: ["app-server", "--stdio"],
    envPolicy: "minimal",
    ephemeralSupport: "close-only",
    enabled: true,
    detected: true,
  });
  assert.match(rowHtml, /data-ext-env-policy="zcode"/);
  assert.match(rowHtml, /极简环境/);
  assert.match(rowHtml, /本地保留历史/);

  // Test toggleExtensionEnvPolicy, quickEnableTemplateProvider, and wizard protocol/envPolicy roundtrip
  const rpcCalls = [];
  const toasts = [];
  const elements = new Map();
  const makeEl = (id, init = {}) => {
    const listeners = new Map();
    const el = {
      id,
      value: "",
      checked: false,
      hidden: true,
      readOnly: false,
      disabled: false,
      textContent: "",
      innerHTML: "",
      dataset: {},
      className: "",
      style: {},
      addEventListener(type, fn) { listeners.set(type, fn); },
      dispatchEvent(evt) { listeners.get(evt.type)?.(evt); },
      appendChild(child) { toasts.push(child.textContent); },
      remove() {},
      ...init,
    };
    elements.set(id, el);
    return el;
  };
  for (const id of [
    "toast-container", "ext-modal-backdrop", "ext-modal-title", "ext-id", "ext-name",
    "ext-protocol", "ext-env-policy", "ext-enabled", "ext-command", "ext-args",
    "ext-models", "ext-efforts", "ext-env", "ext-probe-result", "btn-ext-remove",
  ]) makeEl(id);

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevTemplates = studioState.extensionTemplates;
  const prevCustom = studioState.customProviders;
  try {
    globalThis.requestAnimationFrame = () => 0;
    globalThis.document = {
      activeElement: null,
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ className: "", textContent: "", style: {}, remove() {} }),
    };
    globalThis.window = {
      sidecar: {
        conversationId: "conv-v035",
        fetch: async (_url, init) => {
          const { method, params } = JSON.parse(init.body);
          rpcCalls.push({ method, params });
          if (method === "probeExtensionProvider") {
            return { ok: true, status: 200, json: async () => ({ result: { ok: true, defaultModel: "glm-6", capabilities: { sessionCapabilities: { delete: false } }, models: [{ id: "glm-5", name: "GLM-5" }, { id: "glm-6" }], efforts: ["low", "high"] } }) };
          }
          if (method === "listExtensionProviders") {
            return { ok: true, status: 200, json: async () => ({ result: { templates: studioState.extensionTemplates, customProviders: studioState.customProviders } }) };
          }
          return { ok: true, status: 200, json: async () => ({ result: { ok: true } }) };
        },
      },
    };

    studioState.extensionTemplates = normalized.templates;
    studioState.customProviders = normalized.customProviders;

    // 1. One-click envPolicy toggle on list row (minimal -> inherit)
    const toggled = await toggleExtensionEnvPolicy("zcode");
    assert.equal(toggled, true);
    const saveToggle = rpcCalls.find(c => c.method === "saveExtensionProvider");
    assert.equal(saveToggle?.params?.id, "zcode");
    assert.equal(saveToggle?.params?.models, undefined, "快捷切换只修改策略，保留已保存的模型与协议");
    assert.equal(saveToggle?.params?.envPolicy, "inherit");

    // 2. Quick-enable template probes first and backfills live models while preserving zcode protocol + minimal envPolicy
    rpcCalls.length = 0;
    await quickEnableTemplateProvider("zcode");
    assert.equal(rpcCalls[0]?.method, "probeExtensionProvider");
    assert.equal(rpcCalls[0]?.params?.protocol, "zcode");
    const saveEnable = rpcCalls.find(c => c.method === "saveExtensionProvider");
    assert.equal(saveEnable?.params?.protocol, "zcode");
    assert.equal(saveEnable?.params?.driverKind, "zcode");
    assert.equal(saveEnable?.params?.envPolicy, "minimal");
    assert.equal(saveEnable?.params?.models?.[0]?.id, "glm-5");
    assert.equal(saveEnable.params.defaultModel, "glm-6");

    // 3. Wizard modal protocol change to zcode auto-fills app-server --stdio and saves envPolicy
    rpcCalls.length = 0;
    openExtensionWizard("");
    assert.equal(elements.get("ext-protocol").value, "acp");
    assert.equal(elements.get("ext-args").value, "acp");
    elements.get("ext-protocol").value = "zcode";
    elements.get("ext-protocol").dispatchEvent({ type: "change" });
    assert.equal(elements.get("ext-args").value, "app-server --stdio");
    elements.get("ext-id").value = "my-zcode";
    elements.get("ext-name").value = "My ZCode";
    elements.get("ext-command").value = "zcode";
    elements.get("ext-env-policy").value = "minimal";
    await saveWizardExtension();
    const wizardSave = rpcCalls.find(c => c.method === "saveExtensionProvider");
    assert.equal(wizardSave?.params?.protocol, "zcode");
    assert.equal(wizardSave?.params?.driverKind, "zcode");
    assert.equal(wizardSave?.params?.envPolicy, "minimal");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    studioState.extensionTemplates = prevTemplates;
    studioState.customProviders = prevCustom;
  }

  // CSS token compliance & narrow-layout wrap
  const css = fs.readFileSync(path.join(repoRoot, "sidecars", "studio", "styles.css"), "utf8");
  const extBlock = css.slice(css.indexOf(".ext-row-top"), css.indexOf(".set-mini-btn {"));
  assert.match(extBlock, /flex-wrap:\s*wrap;/);
  const envBlock = css.slice(css.indexOf(".ext-cap-badge"), css.indexOf(".set-mini-btn {"));
  const vars = [...envBlock.matchAll(/var\((--[a-z0-9-]+)\)/g)].map(m => m[1]);
  assert.ok(vars.length > 0);
  for (const token of vars) {
    assert.match(token, /^--(?:sw|r|text)-/, `非法 CSS 变量 ${token}`);
  }

  // README.md & SECURITY.md alignment
  const readme = fs.readFileSync(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /默认关闭.*本地保留历史/);
  assert.match(readme, /DeepSeek Harness \(DSH\)/);
  assert.match(readme, /ZCode/);
  assert.match(readme, /envPolicy/);

  const security = fs.readFileSync(path.join(repoRoot, "SECURITY.md"), "utf8");
  assert.match(security, /Zero Dotfile Touch/);
  assert.match(security, /envPolicy/);
  assert.match(security, /interaction\/requestProviderRuntimeHeaders/);
  assert.match(security, /CHILD_RECURSIVE_DISPATCH_FORBIDDEN/);
});

test("目录保存与 Studio 不把布尔值和数组当作模型 token 上限", () => {
  const entry = { id: "custom", models: [{ id: "one", contextWindow: true, maxOutputTokens: [8192] }] };
  const direct = sanitizeExtensionProviderConfig(entry);
  const studio = normalizeExtensionList([], [entry]).customProviders[0];
  const fromCatalog = normalizeProvidersCatalog([entry], [])[0];
  const fromSettings = normalizeProvidersCatalog([], [entry])[0];
  for (const provider of [direct, studio, fromCatalog, fromSettings]) {
    assert.deepEqual([provider.models[0].contextWindow, provider.models[0].maxOutputTokens], [0, undefined]);
  }
});

test("重探期间保存其他平台后，下次普通读取仍返回新模型目录", () => withProjectSandbox("v035-refresh-cache", async dir => {
  const cwd = project(dir, "repo");
  const tower = createOrchestrator({
    dataDir: path.join(dir, "control"), defaultStudioRoot: cwd, recoverStaleState: false,
    catalogLoader: async function offlineCatalog({ customProviders }) {
      return { providers: customProviders, extensionTemplates: [] };
    },
  });
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  try {
    await tower.saveExtensionProvider({ id: "custom", protocol: "acp", command: process.execPath, models: ["old"] });
    await tower.saveExtensionProvider({ id: "other", protocol: "acp", command: process.execPath });
    const probed = [];
    tower.engineManager.probeExtensionProvider = async ({ id }) => {
      probed.push(id);
      started.resolve();
      await release.promise;
      return { ok: true, models: ["live"] };
    };
    const refresh = tower.getCapabilities({ refresh: true });
    await started.promise;
    await tower.saveExtensionProvider({ id: "other", enabled: false });
    release.resolve();
    await refresh;
    assert.deepEqual(probed, ["custom"], "等待前一个探针时已停用的平台不应再启动进程");
    const read = await tower.getCapabilities();
    for (const list of [read.customProviders, read.providers]) {
      const provider = list.find(p => p.id === "custom");
      assert.equal(provider.models[0].id, "live");
      assert.equal(provider.defaultModel, "live");
    }
  } finally {
    release.resolve();
    await tower.shutdown();
  }
}));

test("v0.3.5 扩展模型元数据透传（真实 contextWindow / group / 每模型 efforts）、刷新重探与 Studio 合并", () => withProjectSandbox("v035-ext-meta", async dir => {
  const cwd = project(dir, "meta-repo");
  const fakeZCode = write(dir, "ZCode/resources/glm/zcode.cjs", "// zcode stub\n");

  // 1. sanitizeExtensionProviderConfig & loadProviderCatalogs: never hardcode 262144; keep per-model metadata
  const sanitized = sanitizeExtensionProviderConfig({
    id: "zcode",
    protocol: "zcode",
    command: fakeZCode,
    defaultModel: "zai/glm-5",
    efforts: ["low", "medium", "high"],
    models: [
      {
        id: "zai/glm-5",
        name: "GLM-5",
        group: "Z.ai Official",
        description: "Flagship model",
        contextWindow: 200000,
        maxOutputTokens: 16384,
        efforts: ["low", "high", "xhigh"],
        defaultEffort: "xhigh",
      },
      {
        id: "zai/glm-air",
        name: "GLM-Air",
        group: "Z.ai Fast",
      },
      { id: "zai/no-thinking", efforts: [] },
    ],
  });
  assert.equal(sanitized.models[0].contextWindow, 200000);
  assert.equal(sanitized.models[0].maxOutputTokens, 16384);
  assert.equal(sanitized.models[0].group, "Z.ai Official");
  assert.equal(sanitized.models[0].description, "Flagship model");
  assert.deepEqual(sanitized.models[0].efforts, ["low", "high", "xhigh"]);
  assert.equal(sanitized.models[0].defaultEffort, "xhigh");
  assert.equal(sanitized.models[1].contextWindow, 0, "未知窗口不得硬编码 262144");
  assert.equal(sanitized.models[1].group, "Z.ai Fast");

  const loaded = await loadProviderCatalogs({
    customProviders: [sanitized],
    cacheDir: path.join(dir, "cache"),
    cwd,
  });
  const zProv = loaded.providers.find(p => p.id === "zcode");
  assert.ok(zProv);
  const m1 = zProv.models.find(m => m.id === "zai/glm-5");
  const m2 = zProv.models.find(m => m.id === "zai/glm-air");
  assert.equal(m1.contextWindow, 200000);
  assert.equal(m1.maxOutputTokens, 16384);
  assert.equal(m1.group, "Z.ai Official");
  assert.equal(m1.description, "Flagship model");
  assert.deepEqual(m1.efforts, ["low", "high", "xhigh"]);
  assert.equal(m1.defaultEffort, "xhigh");
  assert.equal(m1.optionDescriptors?.[0]?.currentValue, "xhigh");
  assert.equal(m2.contextWindow, 0, "loadProviderCatalogs 不得回退硬编码 262144");
  assert.deepEqual(m2.efforts, ["low", "medium", "high"]);
  assert.deepEqual(sanitized.models[2].efforts, []);
  const noThinking = zProv.models[2];
  assert.deepEqual([noThinking.efforts, noThinking.defaultEffort, noThinking.optionDescriptors], [[], "", []]);
  assert.equal(normalizeEffortForTarget("zcode", noThinking.id, "high", noThinking.efforts), "inherit");
  const asDefault = { ...sanitized, defaultModel: noThinking.id };
  const local = normalizeExtensionList([], [asDefault]).customProviders;
  const previous = studioState.providers;
  try {
    for (const providers of [[], [{ ...zProv, configDefaultModel: noThinking.id }]]) {
      studioState.providers = normalizeProvidersCatalog(providers, local);
      for (const model of [noThinking.id, "__default__"]) {
        const options = presetOptions({ provider: "zcode", model }, "effort");
        assert.deepEqual(options.map(o => o.value), ["inherit"]);
      }
    }
  } finally { studioState.providers = previous; }

  // 2. ensureCatalog({ refresh: true }) auto-probes enabled extensions with detected binary, while non-refresh skips probing
  const tower = openTower(dir, cwd);
  try {
    const probedIds = [];
    tower.engineManager.probeExtensionProvider = async (cfg) => {
      probedIds.push(cfg.id);
      return {
        ok: true,
        protocol: "zcode",
        binaryPath: fakeZCode,
        defaultModel: "zai/glm-5-pro",
        efforts: ["low", "high"],
        models: [
          {
            id: "zai/glm-5-pro",
            slug: "zai/glm-5-pro",
            name: "GLM-5 Pro",
            group: "Z.ai Live",
            contextWindow: 131072,
            maxOutputTokens: 8192,
            efforts: ["low", "high"],
            defaultEffort: "high",
            isDefault: true,
          },
        ],
      };
    };

    await tower.saveExtensionProvider({
      id: "zcode",
      name: "ZCode",
      protocol: "zcode",
      driverKind: "zcode",
      command: fakeZCode,
      models: [{ id: "zai/old", name: "Old" }],
      enabled: true,
    });
    await tower.saveExtensionProvider({
      id: "missing-acp",
      name: "Missing ACP",
      protocol: "acp",
      command: "definitely-nonexistent-binary-v035-xyz",
      models: [{ id: "m0", name: "M0" }],
      enabled: true,
    });
    assert.deepEqual(probedIds, [], "saveExtensionProvider 不应额外触发自动重探");

    await tower.getCapabilities({ refresh: false });
    assert.deepEqual(probedIds, [], "非 refresh 的 ensureCatalog() 绝不自动起子进程探测");

    const refreshed = await tower.getCapabilities({ refresh: true });
    assert.deepEqual(probedIds, ["zcode"], "refresh=true 仅对已启用且本机存在的 acp/zcode 扩展自动重探");
    const savedZ = refreshed.customProviders.find(c => c.id === "zcode");
    assert.equal(savedZ?.defaultModel, "zai/glm-5-pro");
    assert.equal(savedZ?.models?.[0]?.id, "zai/glm-5-pro");
    assert.equal(savedZ?.models?.[0]?.contextWindow, 131072);
    assert.equal(savedZ?.models?.[0]?.maxOutputTokens, 8192);
    assert.equal(savedZ?.models?.[0]?.group, "Z.ai Live");

    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    tower.engineManager.probeExtensionProvider = async () => {
      started.resolve();
      await release.promise;
      return { ok: true, models: [{ id: "outdated" }] };
    };
    const pendingRefresh = tower.getCapabilities({ refresh: true });
    await started.promise;
    try {
      await tower.saveExtensionProvider({ id: "zcode", enabled: false, envPolicy: "inherit" });
    } finally {
      release.resolve();
    }
    await pendingRefresh;
    const latest = (await tower.listExtensionProviders()).customProviders.find(p => p.id === "zcode");
    assert.deepEqual([latest.enabled, latest.envPolicy, latest.models[0].id], [false, "inherit", "zai/glm-5-pro"]);
  } finally {
    await tower.shutdown();
  }

  // 3. Studio normalizeExtensionList / normalizeProvidersCatalog / quickEnable / wizard probe->save merge
  const normExt = normalizeExtensionList(
    [{ id: "zcode", protocol: "zcode", driverKind: "zcode", detected: true }],
    [{
      id: "zcode",
      protocol: "zcode",
      driverKind: "zcode",
      enabled: true,
      defaultModel: "zai/glm-5",
      models: [{
        id: "zai/glm-5",
        name: "GLM-5",
        group: "Z.ai Official",
        description: "desc",
        contextWindow: 200000,
        maxOutputTokens: 16384,
        efforts: ["low", "xhigh"],
        defaultEffort: "xhigh",
        isDefault: true,
      }],
    }]
  );
  const normModel = normExt.customProviders[0].models[0];
  assert.equal(normModel.contextWindow, 200000);
  assert.equal(normModel.maxOutputTokens, 16384);
  assert.equal(normModel.group, "Z.ai Official");
  assert.equal(normModel.defaultEffort, "xhigh");

  const catalogNorm = normalizeProvidersCatalog(
    [
      {
        id: "zcode",
        isExtension: true,
        models: [
          { id: "zai/glm-5", name: "GLM-5", contextWindow: 262144 },
          { id: "zai/glm-5", name: "GLM-5", group: "Z.ai Official", contextWindow: 0, maxOutputTokens: 8192, defaultEffort: "high" },
        ],
      },
    ],
    normExt.customProviders
  );
  const zCat = catalogNorm.find(p => p.id === "zcode");
  assert.equal(zCat.models[0].contextWindow, 0, "扩展平台显式 contextWindow=0 不得回退保留旧 262144");
  assert.equal(zCat.models[0].group, "Z.ai Official");
  assert.equal(zCat.models[0].maxOutputTokens, 8192);

  // Wizard probe -> edit display name -> save merges rich metadata back
  const rpcCalls = [];
  const elements = new Map();
  const makeEl = (id) => {
    const listeners = new Map();
    const el = {
      id, value: "", checked: false, hidden: true, readOnly: false, disabled: false,
      textContent: "", innerHTML: "", dataset: {}, className: "", style: {},
      addEventListener(type, fn) { listeners.set(type, fn); },
      dispatchEvent(evt) { listeners.get(evt.type)?.(evt); },
      appendChild() {}, remove() {},
    };
    elements.set(id, el);
    return el;
  };
  for (const id of [
    "toast-container", "ext-modal-backdrop", "ext-modal-title", "ext-id", "ext-name",
    "ext-protocol", "ext-env-policy", "ext-enabled", "ext-command", "ext-args",
    "ext-models", "ext-efforts", "ext-env", "ext-probe-result", "btn-ext-remove", "btn-ext-probe",
  ]) makeEl(id);

  const prevDoc = globalThis.document;
  const prevWin = globalThis.window;
  const prevRaf = globalThis.requestAnimationFrame;
  const prevTemplates = studioState.extensionTemplates;
  const prevCustom = studioState.customProviders;
  try {
    globalThis.requestAnimationFrame = () => 0;
    globalThis.document = {
      activeElement: null,
      getElementById: (id) => elements.get(id) || null,
      querySelector: () => null,
      querySelectorAll: () => [],
      createElement: () => ({ className: "", textContent: "", style: {}, remove() {} }),
    };
    globalThis.window = {
      sidecar: {
        conversationId: "conv-meta",
        fetch: async (_url, init) => {
          const { method, params } = JSON.parse(init.body);
          rpcCalls.push({ method, params });
          if (method === "probeExtensionProvider") {
            return {
              ok: true,
              status: 200,
              json: async () => ({
                result: {
                  ok: true,
                  defaultModel: "zai/glm-5",
                  efforts: ["low", "high"],
                  models: [
                    {
                      id: "zai/glm-5",
                      name: "GLM-5",
                      group: "Z.ai Pro",
                      description: "Live probed",
                      contextWindow: 128000,
                      maxOutputTokens: 8192,
                      efforts: ["low", "high", "xhigh"],
                      defaultEffort: "xhigh",
                      isDefault: true,
                    },
                    { id: "zai/no-thinking", efforts: [] },
                  ],
                },
              }),
            };
          }
          if (method === "listExtensionProviders") {
            return { ok: true, status: 200, json: async () => ({ result: { templates: studioState.extensionTemplates, customProviders: studioState.customProviders } }) };
          }
          return { ok: true, status: 200, json: async () => ({ result: { ok: true } }) };
        },
      },
    };
    studioState.extensionTemplates = normExt.templates;
    studioState.customProviders = normExt.customProviders;

    // quickEnableTemplateProvider preserves metadata
    await quickEnableTemplateProvider("zcode");
    const quickSave = rpcCalls.find(c => c.method === "saveExtensionProvider");
    assert.equal(quickSave?.params?.models?.[0]?.contextWindow, 128000);
    assert.equal(quickSave?.params?.models?.[0]?.maxOutputTokens, 8192);
    assert.equal(quickSave?.params?.models?.[0]?.group, "Z.ai Pro");
    assert.deepEqual(quickSave?.params?.models?.[0]?.efforts, ["low", "high", "xhigh"]);
    assert.deepEqual(quickSave.params.models[1].efforts, []);
    assert.equal(quickSave?.params?.models?.[0]?.defaultEffort, "xhigh");

    // Wizard open -> probe -> user customizes label -> save preserves probed metadata
    rpcCalls.length = 0;
    openExtensionWizard("zcode");
    await probeWizardExtension();
    elements.get("ext-models").value = "zai/glm-5 | GLM-5 Renamed\nzai/no-thinking";
    await saveWizardExtension();
    const wizSave = rpcCalls.find(c => c.method === "saveExtensionProvider");
    assert.equal(wizSave?.params?.defaultModel, "zai/glm-5");
    assert.equal(wizSave?.params?.models?.[0]?.name, "GLM-5 Renamed");
    assert.equal(wizSave?.params?.models?.[0]?.contextWindow, 128000);
    assert.equal(wizSave?.params?.models?.[0]?.maxOutputTokens, 8192);
    assert.equal(wizSave?.params?.models?.[0]?.group, "Z.ai Pro");
    assert.equal(wizSave?.params?.models?.[0]?.description, "Live probed");
    assert.deepEqual(wizSave?.params?.models?.[0]?.efforts, ["low", "high", "xhigh"]);
    assert.deepEqual(wizSave.params.models[1].efforts, []);
    assert.equal(wizSave?.params?.models?.[0]?.defaultEffort, "xhigh");
    assert.equal(rpcCalls.some(c => c.method === "getCapabilities" && c.params.refresh), false,
      "保存后强制重探会立刻覆盖用户刚改的模型名称");

    rpcCalls.length = 0;
    openExtensionWizard("");
    elements.get("ext-id").value = "platform-a";
    elements.get("ext-command").value = "custom-agent";
    await probeWizardExtension();
    elements.get("ext-id").value = "platform-b";
    await saveWizardExtension();
    const renamed = rpcCalls.find(c => c.method === "saveExtensionProvider").params;
    assert.equal(renamed.models[0].group, undefined);
    assert.equal(renamed.defaultModel, undefined);

    openExtensionWizard("zcode");
    const previousProbe = probeWizardExtension();
    openExtensionWizard("");
    elements.get("ext-id").value = "platform-b";
    await previousProbe;
    assert.equal(elements.get("ext-models").value, "default | 默认旗舰模型");
  } finally {
    globalThis.document = prevDoc;
    globalThis.window = prevWin;
    globalThis.requestAnimationFrame = prevRaf;
    studioState.extensionTemplates = prevTemplates;
    studioState.customProviders = prevCustom;
  }
}));

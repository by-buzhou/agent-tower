import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Script } from "node:vm";
import { pathToFileURL } from "node:url";
import { frontendAssetHash, listStudioAssetPaths, readStudioAsset, resolveStudioAsset, studioRequestPath } from "../../core/frontend-assets.mjs";
import { repoRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

const studioDir = path.join(repoRoot, "sidecars", "studio");
const uiDir = path.join(studioDir, "ui");
const JS_TYPE = "application/javascript; charset=utf-8";
const uiFiles = fs.readdirSync(uiDir).filter((f) => f.endsWith(".js")).sort();
const moduleFiles = [path.join(studioDir, "app.js"), ...uiFiles.map((f) => path.join(uiDir, f))];
const rel = (file) => path.relative(studioDir, file).split(path.sep).join("/");

// 去掉注释与字符串后的「代码视图」，避免把文档注释里的 import 字样误判为语句
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

function importSpecifiers(src) {
  const code = stripCommentsAndStrings(src);
  const specs = [];
  for (const m of code.matchAll(/^\s*(?:import|export)\s[^;]*?\sfrom\s+(['"])([^'"]+)\1/gm)) specs.push(m[2]);
  for (const m of code.matchAll(/^\s*import\s+(['"])([^'"]+)\1/gm)) specs.push(m[2]);
  for (const m of code.matchAll(/\bimport\s*\(\s*(['"`])([^'"`]*)\1/g)) specs.push(m[2]);
  return specs;
}

test("v0.0.4 前端模块：全部 import 为显式 .js 相对路径且目标文件真实存在", () => {
  assert.ok(uiFiles.length >= 10, `ui/*.js 子模块数量异常：${uiFiles.length}`);
  for (const f of uiFiles) assert.match(f, /^[a-z0-9-]+\.js$/, `ui/${f} 文件名不在静态白名单规则内`);
  let total = 0;
  for (const file of moduleFiles) {
    const src = fs.readFileSync(file, "utf8");
    for (const spec of importSpecifiers(src)) {
      total++;
      assert.match(spec, /^\.\.?\/[\w./-]+\.js$/, `${rel(file)} 存在非相对 / 无 .js 后缀的说明符 ${spec}`);
      const target = path.resolve(path.dirname(file), spec);
      assert.ok(target.startsWith(studioDir + path.sep), `${rel(file)} 的 ${spec} 越出 sidecars/studio`);
      assert.ok(fs.existsSync(target) && fs.statSync(target).isFile(), `${rel(file)} 的 ${spec} 指向不存在的文件`);
    }
    const code = stripCommentsAndStrings(src);
    assert.doesNotMatch(code, /^export\s+let\s/m, `${rel(file)} 禁止 export let 可变绑定`);
    assert.doesNotMatch(code, /^await\s/m, `${rel(file)} 禁止顶层 await`);
    assert.doesNotMatch(code, /\brequire\s*\(|from\s+['"]node:/, `${rel(file)} 禁止 Node 内置模块 / require`);
  }
  assert.ok(total > 50, "模块间 import 数量异常偏少");

  // 叶子权限模块零 window / document 依赖，可被 Node 单测直接 import
  const perm = stripCommentsAndStrings(fs.readFileSync(path.join(uiDir, "permissions.js"), "utf8"));
  assert.doesNotMatch(perm, /\b(window|document|location|sessionStorage|localStorage)\b/);
  assert.equal(importSpecifiers(perm).length, 0, "permissions.js 必须是叶子模块");

  // ui 子模块顶层零副作用：顶层只允许 import / export / 声明 / 注释
  for (const f of uiFiles) {
    const code = stripCommentsAndStrings(fs.readFileSync(path.join(uiDir, f), "utf8"));
    const offenders = code.split("\n").filter((line) => line.trim() && !/^\s/.test(line)
      && !/^(import |export |async function |function |const |let |[}\])]|`)/.test(line));
    assert.deepEqual(offenders, [], `ui/${f} 顶层存在可执行语句`);
    assert.doesNotMatch(code, /^(?:document|window)\./m, `ui/${f} 顶层直接操作 DOM`);
  }

  // index.html：preload.js 为经典同步脚本在前，app.js 为经典 IIFE 脚本；无内联脚本 / importmap
  const html = fs.readFileSync(path.join(studioDir, "index.html"), "utf8");
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
  assert.deepEqual(scripts.map((m) => m[1].trim()), ['src="./preload.js"', 'src="./app.js"']);
  assert.ok(scripts.every((m) => !m[2].trim()), "index.html 不得包含内联脚本");
  assert.doesNotMatch(html, /importmap/);
});

test("v0.0.4 前端模块依赖图为 DAG（零循环 import）", () => {
  const graph = new Map();
  for (const file of moduleFiles) {
    const deps = importSpecifiers(fs.readFileSync(file, "utf8")).map((spec) => rel(path.resolve(path.dirname(file), spec)));
    graph.set(rel(file), deps);
  }
  const state = new Map(); // 1 = visiting, 2 = done
  const order = [];
  const visit = (node, trail) => {
    if (state.get(node) === 2) return;
    assert.notEqual(state.get(node), 1, `检测到循环依赖：${[...trail, node].join(" -> ")}`);
    state.set(node, 1);
    for (const dep of graph.get(node) || []) visit(dep, [...trail, node]);
    state.set(node, 2);
    order.push(node);
  };
  for (const node of graph.keys()) visit(node, []);
  assert.equal(order.at(-1), "app.js", "app.js 应为唯一组合根（拓扑序最后）");
  for (const [node, deps] of graph) {
    if (node !== "app.js") assert.ok(!deps.includes("app.js"), `${node} 不得反向 import app.js`);
  }
  // 自绘下拉只接收注入回调，不反向 import 配置视图或动作模块
  assert.deepEqual(graph.get("ui/custom-select.js"), []);
  assert.ok(!graph.get("ui/render.js").some((d) => /-view\.js$|composer\.js$|modals\.js$/.test(d)), "render.js 不得 import 具体视图");
});

test("Studio serves a single classic IIFE with dependencies before the entry", () => {
  const bundle = resolveStudioAsset("/app.js").content.toString();
  assert.match(bundle, /^\(function \(\) \{\n'use strict';/);
  assert.doesNotMatch(bundle, /^(?:import|export)\s/m);
  assert.doesNotThrow(() => new Script(bundle));
  assert.equal(bundle.match(/^\/\/ ui\/[a-z0-9-]+\.js$/gm)?.length, 23);
  assert.ok(bundle.indexOf("// ui/state.js") < bundle.indexOf("// app.js"));
  assert.ok(bundle.indexOf("// app.js") < bundle.indexOf("bootStudio();"));
});

test("v0.0.4 统一白名单静态解析器：ui/*.js 全部可读且 MIME 严格为 JavaScript", () => {
  const paths = listStudioAssetPaths();
  assert.deepEqual(paths.slice(0, 4), ["/", "/index.html", "/styles.css", "/app.js"]);
  assert.deepEqual(paths.slice(4), uiFiles.map((f) => `/ui/${f}`));
  for (const f of uiFiles) {
    const asset = resolveStudioAsset(`/ui/${f}`);
    assert.ok(asset, `/ui/${f} 未被白名单解析`);
    assert.equal(asset.contentType, JS_TYPE);
    assert.ok(asset.content.equals(fs.readFileSync(path.join(uiDir, f))), `/ui/${f} 内容不一致`);
    assert.ok(readStudioAsset(`ui/${f}`).equals(asset.content));
  }
  assert.equal(resolveStudioAsset("/app.js").contentType, JS_TYPE);
  assert.equal(resolveStudioAsset("/styles.css").contentType, "text/css; charset=utf-8");
  const index = resolveStudioAsset("/");
  assert.equal(index.contentType, "text/html; charset=utf-8");
  assert.equal(index.name, "index.html");
  assert.ok(index.content.toString("utf8").includes(`content="${frontendAssetHash()}"`), "index.html 需注入当前资产哈希");
  for (const bad of ["/ui/../app.js", "/ui/..%2fapp.js", "/ui/%2e%2e/app.js", "/ui\\state.js", "/ui/State.js", "/ui/state.mjs",
    "/ui/", "/ui/missing-module.js", "/ui/nested/state.js", "//ui/state.js", "/preload.js", "/main.mjs", "/mcp-entry.mjs",
    "/api/rpc", "/api/bootstrap", "ui/state.js", "/package.json", "/sidecar.json", ""]) {
    assert.equal(resolveStudioAsset(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.throws(() => readStudioAsset("../package.json"), /Unknown Studio asset/);
  assert.throws(() => readStudioAsset("main.mjs"), /Unknown Studio asset/);
});

async function assetFixture(dir) {
  const core = path.join(dir, "core");
  const studio = path.join(dir, "sidecars", "studio");
  const ui = path.join(studio, "ui");
  fs.mkdirSync(core);
  fs.mkdirSync(ui, { recursive: true });
  const entry = path.join(core, "frontend-assets.mjs");
  fs.copyFileSync(path.join(repoRoot, "core", "frontend-assets.mjs"), entry);
  fs.writeFileSync(path.join(studio, "index.html"), '<meta content="__AGENT_TOWER_ASSET_HASH__">');
  fs.writeFileSync(path.join(studio, "app.js"), 'export const entry = true;');
  fs.writeFileSync(path.join(studio, "styles.css"), '');
  return { studio, ui, api: await import(pathToFileURL(entry).href) };
}

test("v0.0.4 增删改任一 ui/*.js 立即改变总资产哈希", () => withProjectSandbox("asset-hash", async dir => {
  const { ui, api } = await assetFixture(dir);
  const probe = path.join(ui, "zz-v004-hash-probe.js");
  const before = api.frontendAssetHash();
  assert.match(before, /^[a-f0-9]{64}$/);
  assert.equal(api.frontendAssetHash(), before);
  fs.writeFileSync(probe, "export const probe = 1;\n");
  const added = api.frontendAssetHash();
  fs.writeFileSync(path.join(ui, "..", "app.js"), 'import { probe } from "./ui/zz-v004-hash-probe.js";\nexport const entry = probe;\n');
  const imported = api.frontendAssetHash();
  const firstBundle = api.readStudioAsset("app.js").toString();
  assert.match(firstBundle, /const probe = 1;/);
  assert.notEqual(added, before);
  assert.ok(api.listStudioAssetPaths().includes("/ui/zz-v004-hash-probe.js"));
  fs.writeFileSync(probe, "export const probe = 22;\n");
  assert.notEqual(api.frontendAssetHash(), imported);
  assert.match(api.readStudioAsset("app.js").toString(), /const probe = 22;/);
  const bytes = api.readStudioAsset("ui/zz-v004-hash-probe.js");
  bytes.fill(0);
  assert.equal(api.readStudioAsset("ui/zz-v004-hash-probe.js").toString(), "export const probe = 22;\n");
  fs.writeFileSync(path.join(ui, "..", "app.js"), 'export const entry = true;');
  fs.rmSync(probe);
  assert.equal(api.frontendAssetHash(), before);
  assert.equal(api.resolveStudioAsset("/ui/zz-v004-hash-probe.js"), null);
}));

test("v0.0.4 原始请求路径先校验；查询参数保持可转义", () => {
  assert.equal(studioRequestPath("/api/bootstrap?workspace=some%20project"), "/api/bootstrap");
  assert.equal(studioRequestPath("/ui/state.js?v=1"), "/ui/state.js");
  for (const invalid of ["/ui/../app.js", "/ui/%2e%2e/app.js", "/ui\\state.js", "/ui/./state.js", "//app.js"]) {
    assert.equal(studioRequestPath(invalid), null, invalid);
  }
});

test("v0.0.4 白名单不读取越界链接，不回退到已缓存字节", () => withProjectSandbox("asset-links", async dir => {
  const { studio, ui, api } = await assetFixture(dir);
  const outside = path.join(dir, "outside");
  fs.mkdirSync(outside);
  const external = path.join(outside, "probe.js");
  fs.writeFileSync(external, "export const outside = true;");
  const app = path.join(studio, "app.js");
  const original = api.frontendAssetHash();
  assert.ok(api.resolveStudioAsset("/app.js"));
  let fileLinksSupported = true;
  const link = path.join(ui, "probe.js");
  try {
    fs.symlinkSync(external, link, "file");
  } catch (error) {
    if (process.platform !== "win32" || !["EACCES", "EPERM"].includes(error.code)) throw error;
    fileLinksSupported = false;
  }
  if (fileLinksSupported) {
    assert.equal(api.resolveStudioAsset("/ui/probe.js"), null);
    assert.equal(api.frontendAssetHash(), original);
    fs.unlinkSync(link);
    fs.unlinkSync(app);
    fs.symlinkSync(external, app, "file");
    assert.equal(api.resolveStudioAsset("/app.js"), null);
    assert.throws(() => api.readStudioAsset("app.js"), /Unknown Studio asset/);
    assert.ok(!api.listStudioAssetPaths().includes("/app.js"));
    assert.ok(api.resolveStudioAsset("/styles.css"));
    fs.unlinkSync(app);
    fs.writeFileSync(app, 'export const entry = true;');
  }
  fs.writeFileSync(link, "export const inside = true;");
  assert.ok(api.resolveStudioAsset("/ui/probe.js"));
  fs.renameSync(ui, path.join(dir, "old-ui"));
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(outside, ui, linkType);
  assert.equal(api.resolveStudioAsset("/ui/probe.js"), null);
  assert.equal(api.frontendAssetHash(), original);
  fs.renameSync(studio, path.join(dir, "old-studio"));
  fs.symlinkSync(outside, studio, linkType);
  assert.deepEqual(api.listStudioAssetPaths(), []);
  assert.equal(api.resolveStudioAsset("/"), null);
}));

test("v0.0.4 app.js 瘦身为组合入口（<= 300 行）", () => {
  const app = fs.readFileSync(path.join(studioDir, "app.js"), "utf8");
  const lines = app.split("\n").length;
  assert.ok(lines <= 300, `app.js 共 ${lines} 行`);
  for (const call of ["installInnerHtmlNoopGuard()", "initCustomSelect({", "registerViews({", "bindGlobalEvents()", "window.__AT_BOOTED = true"]) {
    assert.ok(app.includes(call), `app.js 缺少组合步骤 ${call}`);
  }
});

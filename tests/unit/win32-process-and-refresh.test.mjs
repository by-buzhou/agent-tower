import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { loadProviderCatalogs } from "../../core/catalog.mjs";
import { captureNoWindow, forceKillProcessTree, noWindowSpawnOptions, spawnNoWindow } from "../../core/engines/proc-utils.mjs";
import { runGit } from "../../core/worktree.mjs";
import { once } from "node:events";
import { within } from "../helpers/process.mjs";
import { withProjectSandbox } from "../helpers/sandbox.mjs";
import { project } from "../helpers/fixtures.mjs";

test("Win32 no-window launches preserve pipes, exit codes and process-tree cleanup", () => withProjectSandbox("no-console", async cwd => {
  assert.deepEqual(noWindowSpawnOptions({ stdio: "ignore", detached: false, shell: true }, "win32"),
    { stdio: "ignore", detached: true, windowsHide: true, shell: false });
  assert.equal(noWindowSpawnOptions({ detached: false }, "linux").detached, false);
  assert.equal(noWindowSpawnOptions({ detached: true }, "linux").detached, true);
  const echo = spawnNoWindow(process.execPath, ["-e", "process.stdin.pipe(process.stdout);process.stderr.write('err');process.exitCode=7"],
    { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const closed = once(echo, "close");
  let out = "", err = "";
  echo.stdout.setEncoding("utf8").on("data", chunk => { out += chunk; });
  echo.stderr.setEncoding("utf8").on("data", chunk => { err += chunk; });
  echo.stdin.on("error", () => {});
  echo.stdin.end("pipe works");
  try { assert.deepEqual(await within(closed, 5000, "piped child"), [7, null]); }
  finally { await forceKillProcessTree(echo); }
  assert.deepEqual([out, err], ["pipe works", "err"]);
  await assert.rejects(captureNoWindow(process.execPath, ["-e", "process.stderr.write('failed');process.exitCode=9"], { cwd }),
    { code: 9, stdout: "", stderr: "failed" });
  await assert.rejects(captureNoWindow(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd, timeoutMs: 250 }),
    { code: "ETIMEDOUT" });
  if (process.platform === "win32") {
    const parent = spawnNoWindow(process.execPath, ["-e", `
      const { spawn } = require('node:child_process');
      const kid = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { detached: true, windowsHide: true, stdio: 'ignore' });
      kid.on('spawn', () => console.log(kid.pid));
      setInterval(()=>{},1000);`], { cwd, stdio: ["ignore", "pipe", "ignore"] });
    const exited = once(parent, "close");
    try {
      const [chunk] = await within(once(parent.stdout, "data"), 5000, "grandchild launch");
      const pid = Number(String(chunk).trim());
      assert.ok(pid > 0);
      assert.doesNotThrow(() => process.kill(pid, 0));
      await forceKillProcessTree(parent);
      await within(exited, 5000, "process-tree exit");
      assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    } finally { await forceKillProcessTree(parent); }
  }
  const checkout = project(cwd, "checkout");
  const { stdout } = await runGit(["rev-parse", "--show-toplevel"], { cwd: checkout });
  assert.equal(fs.realpathSync(path.resolve(stdout.trim())), fs.realpathSync(checkout));
  await assert.rejects(runGit(["rev-parse", "--show-toplevel"], { cwd, env: { GIT_CEILING_DIRECTORIES: path.dirname(cwd) } }),
    error => error.code === 128 && /not a git repository/i.test(error.stderr));
}));

test("configured refresh is spawn-free; AGY binary successes and failures are remembered", t => withProjectSandbox("refresh-cached", async dir => {
  const home = path.join(dir, "home");
  const codex = path.join(home, ".codex"), kimi = path.join(home, ".kimi-code");
  fs.mkdirSync(codex, { recursive: true });
  fs.mkdirSync(kimi, { recursive: true });
  const writeConfig = revision => {
    fs.writeFileSync(path.join(codex, "config.toml"), `model = "gpt-fixture-${revision}"\nmodel_catalog_json = "models.json"`);
    fs.writeFileSync(path.join(codex, "models.json"), JSON.stringify({ models: [{ slug: `gpt-fixture-${revision}`, display_name: "Codex fixture" }] }));
    fs.writeFileSync(path.join(kimi, "config.toml"), `default_model = "kimi-code/fixture-${revision}"\n[models."kimi-code/fixture-${revision}"]\nmodel = "Fixture"`);
  };
  const marker = path.join(dir, "commands.txt");
  const cli = path.join(dir, "fake-agy.mjs");
  const writeBinary = fail => fs.writeFileSync(cli, `import fs from 'node:fs';\nconst name=process.argv[2]; fs.appendFileSync('commands.txt', name + '\\n');\n${fail ? 'process.exit(1);' : `if (name === 'models') console.log('gemini-4-neon | Neon'); else if (name === '--version') console.log('agy 1.5.9'); else process.exit(1);`}`);
  const restore = Object.fromEntries(["HOME", "USERPROFILE", "CODEX_HOME"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: codex });
  const options = { cwd: dir, cacheDir: dir, refresh: true,
    codexProbe: () => assert.fail("Configured Codex must not spawn"), kimiProbe: () => assert.fail("Configured Kimi must not spawn"),
    agyResolveBinary: () => ({ command: process.execPath, prefixArgs: [cli], resolvedPath: cli }),
  };
  const provider = (catalog, id) => catalog.providers.find(p => p.id === id);
  const commands = () => fs.readFileSync(marker, "utf8").trim().split("\n").sort();
  try {
    writeConfig("one");
    writeBinary(false);
    const [first, concurrent] = await Promise.all([loadProviderCatalogs(options), loadProviderCatalogs(options)]);
    assert.equal(provider(first, "antigravity").catalogSource, "agy-live");
    assert.equal(provider(concurrent, "antigravity").catalogSource, "agy-live");
    assert.deepEqual(commands(), ["--version", "models"]);
    writeConfig("two");
    const start = performance.now();
    const cached = await loadProviderCatalogs(options);
    const elapsed = performance.now() - start;
    t.diagnostic(`Cached refresh with configured Codex/Kimi: ${elapsed.toFixed(1)} ms`);
    assert.ok(elapsed < 1500, `Cached refresh unexpectedly took ${elapsed}ms`);
    assert.deepEqual(commands(), ["--version", "models"]);
    assert.equal(provider(cached, "antigravity").catalogSource, "agy-cache");
    assert.ok(provider(cached, "antigravity").models.some(m => m.slug === "gemini-pro-orchestrator-neon"));
    assert.ok(provider(cached, "codex").models.some(m => m.slug === "gpt-fixture-two"));
    assert.ok(provider(cached, "kimi-code").models.some(m => m.slug === "kimi-code/fixture-two"));
    writeBinary(true);
    assert.equal(provider(await loadProviderCatalogs(options), "antigravity").catalogSource, "agy-cache");
    const attempted = ["--version", "models", "models"];
    assert.deepEqual(commands(), attempted);
    await loadProviderCatalogs(options);
    assert.deepEqual(commands(), attempted);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "agy-catalog-cache.json"), "utf8"));
    assert.deepEqual(saved.attempts.map(a => a.status), ["ok", "failed"]);
    assert.notEqual(saved.attempts[0].fingerprint, saved.attempts[1].fingerprint);
    assert.ok(saved.models.some(m => m.slug === "gemini-4-neon"));
  } finally {
    for (const [k, v] of Object.entries(restore)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}));

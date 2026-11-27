import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withProjectSandbox, runsRoot } from "../helpers/sandbox.mjs";
import { DEFAULT_ROLE_PRESETS } from "../../core/catalog.mjs";
import { rotateLog, child, safeRoot, ensureStorageIgnoreRules, studioDir, specDir } from "../../core/storage-paths.mjs";
import { execFileSync } from "node:child_process";

test("三个常驻执行角色默认共享目录", () => {
  for (const role of ["executor_kimi", "executor_codex", "executor_hydrogen"])
    assert.equal(DEFAULT_ROLE_PRESETS[role].isolation, "shared");
});
test("PASS 立即清除，五次模拟失败只保留最新三个", async () => {
  let outer;
  await withProjectSandbox("retention", async (dir) => {
    outer = dir;
    const base = path.join(dir, "cases");
    let passed;
    await withProjectSandbox(
      "ok",
      (p) => {
        passed = p;
      },
      base,
    );
    assert.ok(!fs.existsSync(passed));
    for (let i = 0; i < 5; i++)
      await assert.rejects(
        withProjectSandbox(
          `fail-${i}`,
          () => {
            throw Error("expected");
          },
          base,
        ),
      );
    assert.deepEqual(
      fs
        .readdirSync(base)
        .map((s) => s.slice(0, 6))
        .sort(),
      ["fail-2", "fail-3", "fail-4"],
    );
    assert.throws(() => child(runsRoot(), "..", "outside"));
  });
  assert.ok(!fs.existsSync(outer));
});
test("日志超过 5 MiB 覆盖单份备份，敏感目录回退", () =>
  withProjectSandbox("logs", (dir) => {
    const file = path.join(dir, ".agent-tower", "logs", "tower.log");
    rotateLog(dir, "tower.log", "start");
    fs.truncateSync(file, 5 * 1024 * 1024);
    rotateLog(dir, "tower.log", "rotated");
    assert.equal(fs.statSync(file + ".1").size, 5 * 1024 * 1024);
    assert.match(fs.readFileSync(file, "utf8"), /rotated/);
    assert.equal(safeRoot(process.env.TEMP, dir), dir);
  }));


test("双层 agent-tower gitignore 迁移、白名单和幂等写入", () => withProjectSandbox("storage-ignore", async dir => {
  const make = (name, rootIgnore, runtimeIgnore) => {
    const root = path.join(dir, name);
    fs.mkdirSync(root, { recursive: true });
    if (rootIgnore !== null) fs.writeFileSync(path.join(root, ".gitignore"), rootIgnore);
    fs.mkdirSync(path.join(root, ".agent-tower"), { recursive: true });
    if (runtimeIgnore !== undefined) fs.writeFileSync(path.join(root, ".agent-tower", ".gitignore"), runtimeIgnore);
    return root;
  };
  const old = make("old", ".agent-tower/\nother/\n");
  ensureStorageIgnoreRules(old);
  assert.match(fs.readFileSync(path.join(old, ".gitignore"), "utf8"), /# >>> agent-tower \(managed/);
  const noRoot = make("no-root", null, "*\n");
  ensureStorageIgnoreRules(noRoot);
  assert.equal(fs.existsSync(path.join(noRoot, ".gitignore")), false);
  const crlf = make("crlf", "# user\r\n.agent-tower/\r\nrule/\r\n", "# custom\r\n*\r\n");
  ensureStorageIgnoreRules(crlf);
  assert.match(fs.readFileSync(path.join(crlf, ".gitignore"), "utf8"), /\r\n/);
  assert.match(fs.readFileSync(path.join(crlf, ".agent-tower", ".gitignore"), "utf8"), /!spec\/01-business\/\*\*/);
  const idempotent = make("idempotent", ".agent-tower/\n", "*\n");
  ensureStorageIgnoreRules(idempotent);
  const runtime = path.join(idempotent, ".agent-tower", ".gitignore");
  const before = fs.statSync(runtime, { bigint: true }).mtimeNs;
  const content = fs.readFileSync(runtime, "utf8");
  await new Promise(resolve => setTimeout(resolve, 10));
  ensureStorageIgnoreRules(idempotent);
  ensureStorageIgnoreRules(idempotent);
  assert.equal(fs.statSync(runtime, { bigint: true }).mtimeNs, before);
  assert.equal(fs.readFileSync(runtime, "utf8"), content, "重复写入不得逐次追加空行");
  // 历史版本累积的尾部空行被一次性收敛，之后保持稳定
  fs.writeFileSync(runtime, content + "\n\n\n");
  ensureStorageIgnoreRules(idempotent);
  assert.equal(fs.readFileSync(runtime, "utf8"), content);
  studioDir(idempotent, "logs");
  assert.equal(path.basename(specDir(idempotent)), "spec");

  const gitRoot = make("git", ".agent-tower/\n");
  execFileSync("git", ["init", "-q"], { cwd: gitRoot, stdio: "ignore" });
  ensureStorageIgnoreRules(gitRoot);
  const files = [
    [".agent-tower/spec/INDEX.md", "index"], [".agent-tower/spec/01-business/a.md", "business"], [".agent-tower/spec/02-coding/b.md", "coding"],
    [".agent-tower/conversations/tower.sqlite", "db"], [".agent-tower/logs/x.log", "log"], [".agent-tower/worktrees/w", "worktree"],
    [".agent-tower/test-runs/t", "run"], [".agent-tower/tmp/p", "tmp"], [".agent-tower/spec/00-plugin/role.md", "plugin"], [".agent-tower/spec/other.md", "other"],
  ];
  for (const [relative, value] of files) { const target = path.join(gitRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); }
  const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: gitRoot, encoding: "utf8" });
  assert.match(status, /spec\/INDEX\.md/);
  assert.match(status, /spec\/01-business\/a\.md/);
  assert.match(status, /spec\/02-coding\/b\.md/);
  for (const relative of [".agent-tower/conversations/tower.sqlite", ".agent-tower/logs/x.log", ".agent-tower/worktrees/w", ".agent-tower/test-runs/t", ".agent-tower/tmp/p", ".agent-tower/spec/00-plugin/role.md", ".agent-tower/spec/other.md", ".agent-tower/.gitignore"]) {
    assert.doesNotThrow(() => execFileSync("git", ["check-ignore", "--no-index", relative], { cwd: gitRoot, stdio: "pipe" }));
  }
}));

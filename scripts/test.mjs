import fs from "node:fs";
import path from "node:path";
import { spawnSupervised, within } from "../tests/helpers/process.mjs";
import { withProjectSandbox, repoRoot } from "../tests/helpers/sandbox.mjs";
import { startSharedEdge, stopSharedEdge } from "../tests/helpers/edge.mjs";

// 用法：
//   node scripts/test.mjs                        全量（纯 Node unit/integration + 独立低并发 edge）
//   node scripts/test.mjs fast                   纯 Node 单元快测（跳过无头 Edge，秒级完赛）
//   node scripts/test.mjs unit|integration|edge  指定套件
//   node scripts/test.mjs v004 unit/v025 tests/unit/v001-studio-dom.test.mjs
//     任意文件路径 / 文件名 / 子串关键词（文件名精确命中优先于子串）；任一参数未命中即报错退出。
const SUITES = { unit: 4, integration: 2 }; // 套件 → 纯 Node --test-concurrency
const EDGE_CONCURRENCY = 2;
const catalog = Object.keys(SUITES).flatMap((suite) => {
  const suiteDir = path.join(repoRoot, "tests", suite);
  if (!fs.existsSync(suiteDir)) return [];
  return fs
    .readdirSync(suiteDir)
    .filter((f) => f.endsWith(".test.mjs"))
    .sort()
    .map((f) => {
      const file = path.join(suiteDir, f);
      return {
        suite,
        file,
        rel: `${suite}/${f}`,
        stem: f.slice(0, -".test.mjs".length),
        usesEdge: fs.readFileSync(file, "utf8").includes("helpers/edge.mjs"),
      };
    });
});

function resolveArg(arg) {
  if (arg === "fast") return catalog.filter((t) => t.suite === "unit" && !t.usesEdge);
  if (arg === "edge") return catalog.filter((t) => t.usesEdge);
  if (Object.hasOwn(SUITES, arg)) return catalog.filter((t) => t.suite === arg);
  for (const base of [process.cwd(), repoRoot]) {
    const abs = path.resolve(base, arg);
    const hit = catalog.filter((t) => t.file === abs || path.dirname(t.file) === abs);
    if (hit.length) return hit;
  }
  const key = arg.replace(/\\/g, "/").replace(/^(?:\.\/)?(?:tests\/)?/, "").replace(/\.test\.mjs$|\.mjs$/, "").toLowerCase();
  if (!key) return [];
  const exact = catalog.filter((t) => t.stem.toLowerCase() === key || t.rel.slice(0, -".test.mjs".length).toLowerCase() === key);
  return exact.length ? exact : catalog.filter((t) => t.rel.toLowerCase().includes(key));
}

const rawArgs = process.argv.slice(2);
const listOnly = rawArgs.includes("--list");
const args = rawArgs.filter((a) => a !== "--list");
const selected = new Set(args.length ? [] : catalog);
const unmatched = [];
for (const arg of args) {
  const hits = resolveArg(arg);
  if (!hits.length) unmatched.push(arg);
  for (const t of hits) selected.add(t);
}
if (unmatched.length || !selected.size) {
  console.error(`未匹配到任何 .test.mjs 测试文件：${(unmatched.length ? unmatched : args).join(", ") || "(空)"}`);
  console.error("可用参数：fast | unit | integration | edge | 测试文件路径 | 文件名 | 子串关键词（如 v004、unit/v025）");
  process.exit(2);
}
if (listOnly) {
  for (const t of selected) console.log(t.rel);
  process.exit(0);
}

await withProjectSandbox("runner", async (dir) => {
  const temp = path.join(dir, "temp");
  fs.mkdirSync(temp);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(systemroot|windir|comspec|pathext|path|systemdrive|number_of_processors|agent_tower_edge_path)$/i.test(
        key,
      ),
    ),
  );
  Object.assign(env, {
    AGENT_TOWER_DISABLE_UPDATE_CHECK: "1",
    AGENT_TOWER_TEST_ROOT: path.join(repoRoot, ".agent-tower", "test-runs"),
    HOME: dir,
    USERPROFILE: dir,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    APPDATA: dir,
    LOCALAPPDATA: dir,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"),
    ANTIGRAVITY_APP_DATA_DIR: dir,
    AGENT_TOWER_DEFAULT_ROOT: dir,
    AGENT_TOWER_DATA_DIR: path.join(dir, "control"),
  });
  // 跨测试文件进程共享单个无头 Edge：仅当所选文件引用 helpers/edge.mjs 时预热 1 个父级实例并通过环境变量透传。
  const needsEdge = [...selected].some((t) => t.usesEdge);
  const sharedEdge = needsEdge ? await startSharedEdge().catch(() => null) : null;
  if (sharedEdge) {
    env.AGENT_TOWER_SHARED_EDGE_PORT = String(sharedEdge.port);
    env.AGENT_TOWER_SHARED_EDGE_WS = sharedEdge.browserWs;
  }
  // 分层批次：先按高并发跑纯 Node 单元与集成套件，再将无头 Edge 文件收拢到低并发独立批次串行收尾，根治多进程抢 CDP 超时。
  const batches = [
    ...Object.entries(SUITES).map(([suite, concurrency]) => ({
      label: suite,
      concurrency,
      files: catalog.filter((t) => t.suite === suite && !t.usesEdge && selected.has(t)).map((t) => t.file),
    })),
    {
      label: "edge",
      concurrency: EDGE_CONCURRENCY,
      files: catalog.filter((t) => t.usesEdge && selected.has(t)).map((t) => t.file),
    },
  ];
  const failures = [];
  try {
    for (const { label, concurrency, files } of batches) {
      if (!files.length) continue;
      const timeoutMs = 240_000;
      const started = Date.now();
      const effectiveConcurrency = Math.min(concurrency, files.length);
      const run = spawnSupervised(process.execPath, ["--test", `--test-concurrency=${effectiveConcurrency}`, ...files], {
        cwd: repoRoot, env, stdio: "inherit", timeoutMs,
      });
      try {
        const res = await within(run.closed, timeoutMs + 7000, "test runner cleanup");
        if (res.spawnError) throw res.spawnError;
        console.log(`[test.mjs] ${label}: ${files.length} 个文件，并发 ${effectiveConcurrency}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s，退出码 ${res.code}`);
        if (res.timeout) throw Error(`${label} 测试运行超时，已终止测试进程树并保留失败沙盒`);
        if (res.code !== 0) failures.push(label);
      } finally { await run.stop(); }
    }
  } finally {
    stopSharedEdge();
  }
  if (failures.length) throw Error(`测试失败（${failures.join(", ")}），沙盒已保留`);
});

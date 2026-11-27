import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { check, repo } from "./check.mjs";
import { child, studioDir, atomicJson } from "../core/storage-paths.mjs";
import { globalSettings } from "../core/global-settings.mjs";
import { compareVersions, createUpdater, parseUpdateVersion, RUNTIME_WHITELIST, RUNTIME_JUNK, runtimeTreeHash, updateError } from "../core/updater.mjs";
import { daemonRpc, readDaemonLease, verifyDaemonLeaseOwner } from "../core/daemon-client.mjs";

export { RUNTIME_WHITELIST, RUNTIME_JUNK, runtimeTreeHash };
const whitelist = RUNTIME_WHITELIST;
const junk = RUNTIME_JUNK;
const PLUGIN_ID = "agent-tower";

export function compareSemver(a, b) {
  const pa = parseUpdateVersion(a);
  const pb = parseUpdateVersion(b);
  return pa && pb ? compareVersions(pa, pb) : 0;
}

export function detectInstallOrigin(source) {
  if (fs.existsSync(child(source, ".agents", "skills", "release-cutover", "SKILL.md"))) {
    return "dev";
  }
  if (fs.existsSync(child(source, ".git"))) return "git-clone";
  return "zip";
}

export function validatePublishPaths({ target, control, project }) {
  for (const dir of [target, control, project]) {
    if (!path.isAbsolute(dir)) throw Error("Expected absolute publish path");
    child(path.parse(dir).root, dir);
  }
  if ([target, control].some(dir => path.basename(dir) !== PLUGIN_ID)) throw Error("Unexpected plugin destination");
}

const production = {
  source: repo,
  project: repo,
  target: path.join(
    homedir(),
    ".gemini",
    "config",
    "plugins",
    PLUGIN_ID,
  ),
  control: path.join(
    homedir(),
    ".gemini",
    "antigravity",
    "plugin_data",
    PLUGIN_ID,
  ),
};
const digest = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
function manifest(root) {
  const files = new Map();
  function visit(rel) {
    const file = child(root, rel),
      stat = fs.lstatSync(file);
    if (stat.isFile()) files.set(rel, digest(file));
    else if (stat.isDirectory())
      for (const leaf of fs.readdirSync(file).sort()) {
        if (!junk.test(leaf)) visit(path.join(rel, leaf));
      }
    else throw Error("Unsupported runtime file");
  }
  whitelist.forEach(visit);
  return files;
}
function publishFiles(entries, scratch) {
  if (!entries.length) return;
  // rename is atomic on a single volume. Windows mounts commonly live on C:
  // while the only permitted scratch area lives on F:.
  if (process.platform === "win32" && entries.some(([, dest]) => path.parse(dest).root !== path.parse(scratch).root)) {
    const sources = entries.map(([src]) => src);
    const destinations = entries.map(([, dest]) => dest);
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
      path.join(import.meta.dirname, "stage-files.ps1")], {
      input: JSON.stringify({ sources, destinations }), windowsHide: true, timeout: 30_000,
      env: { ...process.env, TMP: scratch, TEMP: scratch },
    });
    return;
  }
  for (const [src, dest] of entries) {
    const tmp = child(scratch, randomUUID());
    fs.copyFileSync(src, tmp);
    try {
      fs.renameSync(tmp, dest);
    } catch (error) {
      if (error.code !== "EXDEV") throw error;
      fs.copyFileSync(tmp, dest);
      fs.unlinkSync(tmp);
    }
  }
}
function mirror(source, target, files, scratch) {
  fs.mkdirSync(target, { recursive: true });
  const dirs = new Set();
  const changed = [];
  for (const [rel, hash] of files) {
    const dest = child(target, rel);
    for (let p = path.dirname(rel); p !== "."; p = path.dirname(p)) dirs.add(p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && digest(dest) === hash) continue;
    changed.push([child(source, rel), dest]);
  }
  publishFiles(changed, scratch);
  function prune(parent = "") {
    for (const leaf of fs.readdirSync(path.join(target, parent))) {
      const rel = path.join(parent, leaf),
        dest = child(target, rel);
      if (dirs.has(rel)) prune(rel);
      else if (!files.has(rel))
        fs.rmSync(dest, { recursive: true, force: true });
    }
  }
  prune();
}
const hashManifest = (files) =>
  createHash("sha256")
    .update(JSON.stringify([...files]))
    .digest("hex");
function record(options, name) {
  return child(studioDir(options.project, "logs"), name + ".json");
}
export function stage(options = production) {
  validatePublishPaths(options);
  const scratchRoot = studioDir(options.project, "test-runs");
  const scratch = fs.mkdtempSync(child(scratchRoot, "stage-"));
  try {
    const updatesDir = child(options.control, "updates");
    fs.mkdirSync(updatesDir, { recursive: true });
    const lockFile = child(updatesDir, "apply.lock");
    try {
      fs.writeFileSync(lockFile, JSON.stringify({ id: randomUUID(), pid: process.pid, phase: "publishing" }), { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code === "EEXIST") throw updateError("UPDATE_IN_PROGRESS", "System update in progress");
      throw error;
    }
    try { return stageInSandbox(options, scratch); }
    finally { fs.unlinkSync(lockFile); }
  }
  finally { fs.rmSync(child(scratchRoot, path.basename(scratch)), { recursive: true, force: true }); }
}

// v0.3.3 ships the drain and probation gates, but has no apply RPC or update worker.
export async function startOnlineUpdate({ control, target } = production, feedUrl) {
  const owner = readDaemonLease(control);
  if (!owner || !await verifyDaemonLeaseOwner(owner)) throw Error("Online update requires the installed daemon to be running");
  const status = await daemonRpc("systemUpdate", { action: "status" }, { dataDir: control, pinnedOwner: owner });
  const updater = createUpdater({ dataDir: control, currentVersion: status.currentVersion, feedUrl,
    existingDaemon: { pid: owner.pid, targetDir: target }, autoCheck: () => false });
  try {
    await updater.check();
    return await updater.apply();
  } finally { updater.close(); }
}
export function validateStageInRepo() {
  const root = studioDir(repo, "test-runs");
  const dir = fs.mkdtempSync(child(root, "pre-mount-"));
  try {
    const staged = stage({ source: repo, project: dir, target: child(dir, "plugins", PLUGIN_ID),
      control: child(dir, "plugin_data", PLUGIN_ID) });
    return { ...staged, validationOnly: true };
  } finally {
    fs.rmSync(child(root, path.basename(dir)), { recursive: true, force: true });
  }
}
function sourceCommit(source, version) {
  if (!fs.existsSync(child(source, ".git"))) return `nogit-${version}`;
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8", timeout: 5000,
    }).trim();
  } catch (error) {
    if (!fs.existsSync(child(source, ".git"))) return `nogit-${version}`;
    throw error;
  }
}
function stageInSandbox(options, scratch) {
  const { source, target, control, project } = options;
  validatePublishPaths(options);
  const writeJson = (dest, obj) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const src = child(scratch, randomUUID());
    fs.writeFileSync(src, JSON.stringify(obj) + "\n", { mode: 0o600 });
    publishFiles([[src, dest]], scratch);
  };
  const checked = check(source);
  const version = JSON.parse(fs.readFileSync(child(source, "plugin.json"), "utf8")).version;
  const targetPluginFile = child(target, "plugin.json");
  if (fs.existsSync(targetPluginFile)) {
    let installedVersion = "";
    try {
      installedVersion = JSON.parse(fs.readFileSync(targetPluginFile, "utf8")).version || "";
    } catch {}
    const allowDowngrade = options.allowDowngrade === true;
    if (installedVersion && compareSemver(installedVersion, version) > 0 && !allowDowngrade) {
      throw Object.assign(
        new Error(`Refusing to downgrade installed plugin from ${installedVersion} to ${version} (pass --allow-downgrade to override)`),
        { code: "DOWNGRADE_REFUSED", installedVersion, sourceVersion: version },
      );
    }
  }
  const files = manifest(source);
  if (!fs.existsSync(child(control, "global-settings.json"))) {
    globalSettings(control, project, writeJson, {});
  }
  mirror(source, target, files, scratch);
  const hash = runtimeTreeHash(files);
  if (runtimeTreeHash(manifest(target)) !== hash)
    throw Error("Mounted runtime hash mismatch");
  const commit = sourceCommit(source, version);
  const stagedAt = new Date().toISOString();
  const receipt = {
    status: "STAGED",
    version,
    checked,
    files: files.size,
    hash,
    commit,
    stagedAt,
  };
  writeJson(child(control, "updates", "install.json"), {
    origin: detectInstallOrigin(source),
    targetDir: path.resolve(target),
    version,
    commit,
    treeHash: hash,
    installedAt: stagedAt,
  });
  writeJson(record(options, "publish-stage"), receipt);
  return receipt;
}
export async function cutover(options = production, delayMs = 0) {
  validatePublishPaths(options);
  await delay(delayMs);
  const started = Date.now();
  const { control, target } = options;
  const receipt = record(options, "publish-receipt");
  let phase = "verify-stage";
  try {
    const staged = JSON.parse(
      fs.readFileSync(record(options, "publish-stage"), "utf8"),
    );
    const mounted = manifest(target);
    if (runtimeTreeHash(mounted) !== staged.hash && hashManifest(mounted) !== staged.hash)
      throw Error("Staged files changed");
    const client = await import(
      pathToFileURL(child(target, "core", "daemon-client.mjs")).href
    );
    const permitted = new Set([
      "global-settings.json",
      "agy-catalog-cache.json",
      "daemon-lease.json",
      "daemon-spawn.lock",
      "updates",
    ]);
    const garbage =
      /^(state\.sqlite(?:-(?:shm|wal|journal))?|daemon\.log(?:\.1)?|worktrees|archive-legacy|.*\.tmp)$/i;
    const assertNoUpdateInProgress = () => {
      if (fs.existsSync(child(control, "updates", "apply.lock"))) {
        throw Object.assign(new Error("System update in progress"), { code: "UPDATE_IN_PROGRESS" });
      }
    };
    function checkNames() {
      for (const n of fs.readdirSync(control))
        if (!permitted.has(n) && !garbage.test(n))
          throw Error("Unexpected control entry");
    }
    assertNoUpdateInProgress();
    checkNames();
    phase = "wait-for-idle-and-exit";
    await client.shutdownWhenIdle(control);
    phase = "clean-control";
    const spawnLock = child(control, "daemon-spawn.lock");
    const reclaimLock = child(control, "daemon-spawn.lock.reclaim");
    const lockDeadline = Date.now() + 15_000;
    while ((fs.existsSync(spawnLock) || fs.existsSync(reclaimLock)) && Date.now() < lockDeadline) {
      await delay(80);
    }
    assertNoUpdateInProgress();
    checkNames();
    if (fs.existsSync(spawnLock))
      throw Error("Concurrent daemon startup");
    for (const n of fs.readdirSync(control))
      if (garbage.test(n))
        fs.rmSync(child(control, n), {
          recursive: true,
          force: true,
          maxRetries: 8,
          retryDelay: 150,
        });
    phase = "start-and-probe";
    const { pid, port } = await client.ensureDaemon({ dataDir: control });
    const health = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(5000),
    }).then((r) => r.json());
    const files = fs.readdirSync(control).sort();
    const reportedVersion = health.releaseVersion || health.version;
    if (
      health.pid !== pid ||
      reportedVersion !== staged.version ||
      health.version !== staged.version ||
      health.studioProtocolRevision !== 1 ||
      health.shuttingDown ||
      files.filter(name => name !== "agy-catalog-cache.json" && name !== "updates").join("|") !== "daemon-lease.json|global-settings.json"
    )
      throw Error("New daemon verification failed");
    const result = {
      status: "PASS",
      pid,
      port,
      version: reportedVersion,
      protocol: health.studioProtocolRevision,
      commit: staged.commit,
      files,
      elapsedMs: Date.now() - started,
      completedAt: new Date().toISOString(),
    };
    atomicJson(receipt, result);
    return result;
  } catch (error) {
    atomicJson(receipt, {
      status: "FAIL",
      phase,
      code: error.code || "CHECK_FAILED",
      elapsedMs: Date.now() - started,
      completedAt: new Date().toISOString(),
    });
    throw error;
  }
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = new Set(process.argv.slice(2));
    if ([...args].some(arg => !["--status", "--stage-only", "--cutover-only", "--allow-downgrade", "--online-update"].includes(arg) && !/^--delay-ms=\d+$/.test(arg)) ||
        (args.has("--online-update") && args.size !== 1) ||
        ["--status", "--stage-only", "--cutover-only"].filter(arg => args.has(arg)).length > 1) throw Error("Invalid publish options");
    if (process.env.AGENT_TOWER_VALIDATE_STAGE_IN_REPO === "1") {
      if (args.size !== 1 || !args.has("--stage-only")) throw Error("Repository-only validation requires --stage-only");
      console.log(JSON.stringify(validateStageInRepo()));
    } else if (args.has("--online-update")) {
      console.log(JSON.stringify(await startOnlineUpdate()));
    } else if (args.has("--status")) {
      const stageFile = record(production, "publish-stage"),
        receiptFile = record(production, "publish-receipt");
      const staged = fs.existsSync(stageFile)
        ? JSON.parse(fs.readFileSync(stageFile, "utf8"))
        : null;
      const receipt = fs.existsSync(receiptFile)
        ? JSON.parse(fs.readFileSync(receiptFile, "utf8"))
        : null;
      let live = false;
      if (receipt?.status === "PASS")
        try {
          const h = await fetch(`http://127.0.0.1:${receipt.port}/healthz`, {
            signal: AbortSignal.timeout(2000),
          }).then((r) => r.json());
          live =
            h.pid === receipt.pid &&
            (h.releaseVersion || h.version) === receipt.version &&
            !h.shuttingDown;
        } catch {}
      console.log(JSON.stringify({ staged, receipt, live }));
    } else {
      const stageOpts = args.has("--allow-downgrade") ? { ...production, allowDowngrade: true } : production;
      if (!args.has("--cutover-only")) console.log(JSON.stringify(stage(stageOpts)));
      if (!args.has("--stage-only"))
        console.log(
          JSON.stringify(
            await cutover(
              production,
              Number(
                [...args]
                  .find((a) => a.startsWith("--delay-ms="))
                  ?.split("=")[1],
              ) || 0,
            ),
          ),
        );
    }
  } catch (err) {
    console.error("发布未完成", err.code || err.message);
    process.exitCode = 1;
  }
}

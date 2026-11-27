import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { atomicJson, child, inside } from "./storage-paths.mjs";
import { daemonRpc, isPidAlive, readDaemonLease, verifyDaemonLeaseOwner } from "./daemon-client.mjs";
import { checkedRuntime, installedRuntime, hasUpdateProbation, readUpdateRecord, replaceRuntime,
  updateError, updatePath, validateUpdateTarget, writeUpdateRecord } from "./updater.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const operationError = message => updateError("DAEMON_UPDATING", message);
const updateFile = (dataDir, name) => child(path.parse(dataDir).root, dataDir, name);
const remove = (dataDir, name) => fs.rmSync(updatePath(dataDir, name),
  { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
const rpc = (owner, method, params = {}) => daemonRpc(method, params,
  { dataDir: owner.dataDir, pinnedOwner: owner, timeoutMs: 4000 });

function saveResult(dataDir, lock, status, message) {
  const restoring = status === "auto_rolled_back";
  writeUpdateRecord(dataDir, "state.json", {
    ...readUpdateRecord(dataDir, "state.json"),
    lastResult: {
      id: lock.id, status, fromVersion: restoring ? lock.toVersion : lock.fromVersion,
      toVersion: restoring ? lock.fromVersion : lock.toVersion, at: Date.now(), message,
    },
  });
}

function cleanup(dataDir, id) {
  for (const name of ["staging", "transaction", "cancel.json", "probation.json"]) remove(dataDir, name);
  if (!id || readUpdateRecord(dataDir, "apply.lock")?.id === id) remove(dataDir, "apply.lock");
}

async function notify(owner, id) {
  if (!owner || !id) return;
  try { await rpc(owner, "__finishUpdate", { updateId: id }); }
  catch (error) {
    if (error.code === "METHOD_NOT_FOUND") await rpc(owner, "systemUpdate", { action: "cancelCutover" }).catch(() => {});
  }
}

function recordSettings(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile()) throw Error("Invalid global settings file");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try { return fs.readFileSync(fd); } finally { fs.closeSync(fd); }
}

function backupRuntime(dataDir, install, rollbackSafe) {
  const directory = updatePath(dataDir, "transaction", "original");
  fs.mkdirSync(directory, { recursive: true });
  replaceRuntime(install.targetDir, child(directory, "runtime"), install.version, install.treeHash);
  const settings = recordSettings(updateFile(dataDir, "global-settings.json"));
  if (settings) fs.writeFileSync(child(directory, "global-settings.bak.json"), settings, { mode: 0o600, flag: "wx" });
  atomicJson(child(directory, "backup-meta.json"), {
    version: install.version, treeHash: install.treeHash, install,
    backedUpAt: new Date().toISOString(), rollbackSafe, settingsSha256: settings ? hash(settings) : null,
  });
}

function verifiedBackup(dataDir, parts) {
  const meta = readUpdateRecord(dataDir, ...parts, "backup-meta.json");
  const runtime = updatePath(dataDir, ...parts, "runtime");
  if (!meta || meta.install?.version !== meta.version || meta.install.treeHash !== meta.treeHash) throw Error("Invalid update backup");
  checkedRuntime(runtime, meta.version, meta.treeHash);
  const settings = recordSettings(updatePath(dataDir, ...parts, "global-settings.bak.json"));
  if (meta.settingsSha256 !== undefined && (settings ? hash(settings) : null) !== meta.settingsSha256) {
    throw Error("Global settings backup failed verification");
  }
  return { meta, runtime, settings };
}

function restoreBackup(dataDir, target, { meta, runtime, settings }, rolledBackFrom) {
  replaceRuntime(runtime, target, meta.version, meta.treeHash);
  const file = updateFile(dataDir, "global-settings.json");
  if (settings) {
    const temp = child(dataDir, `global-settings.${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temp, settings, { mode: 0o600, flag: "wx" });
      fs.renameSync(temp, file);
    } finally { fs.rmSync(temp, { force: true }); }
  } else if (meta.settingsSha256 === null) fs.rmSync(file, { force: true });
  writeUpdateRecord(dataDir, "install.json", { ...meta.install, targetDir: target,
    ...(rolledBackFrom ? { rolledBackFrom } : {}) });
}

function finishCommitted(dataDir, status) {
  if (status === "applied") {
    const original = updatePath(dataDir, "transaction", "original");
    const slot = updatePath(dataDir, "rollback");
    if (fs.existsSync(original)) {
      if (fs.existsSync(slot)) fs.renameSync(slot, updatePath(dataDir, "transaction", "retired"));
      fs.renameSync(original, slot);
    }
  } else if (status === "rolled_back") remove(dataDir, "rollback");
}

async function waitForExit(pid) {
  const deadline = Date.now() + 15_000;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw Error("Daemon did not release its runtime");
    await delay(100);
  }
}

async function drain(dataDir, lock, owner) {
  for (;;) {
    if (readUpdateRecord(dataDir, "cancel.json")?.id === lock.id) return false;
    const prepared = await rpc(owner, "__prepareCutover");
    if (prepared.quiescing) {
      try { return (await rpc(owner, "__commitUpdate", { updateId: lock.id })).committed; }
      catch (error) {
        // The first update-capable installer can also drain the original v0.3.3 daemon.
        if (error.code !== "METHOD_NOT_FOUND") throw error;
        if (readUpdateRecord(dataDir, "cancel.json")?.id === lock.id) return false;
        writeUpdateRecord(dataDir, "apply.lock", { ...lock, phase: "applying" });
        return true;
      }
    }
    await delay(250);
  }
}

async function probe(owner, version) {
  const url = `http://127.0.0.1:${owner.port}`;
  const get = route => fetch(url + route, { redirect: "error", signal: AbortSignal.timeout(2500) });
  const health = await get("/healthz");
  const data = health.status === 200 && await health.json();
  if (!data?.ok || data.pid !== owner.pid || data.startedAt !== owner.startedAt ||
      data.version !== version || data.studioProtocolRevision !== 1 || data.shuttingDown) throw Error("Daemon health probe failed");
  const app = await get("/app.js");
  if (app.status !== 200 || !(await app.arrayBuffer()).byteLength) throw Error("Studio asset probe failed");
  const current = readDaemonLease(owner.dataDir);
  if (current?.pid !== owner.pid || current.startedAt !== owner.startedAt || current.token !== owner.token ||
      !await verifyDaemonLeaseOwner(owner, 2500)) throw Error("Daemon lease changed during probing");
  const reply = await fetch(url + "/rpc", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(2500),
    headers: { "Content-Type": "application/json", "X-Daemon-Token": owner.token },
    body: JSON.stringify({ method: "getEvents", params: { limit: 1 } }),
  });
  if (reply.status !== 200 || (await reply.json())?.ok !== true) throw Error("Daemon RPC probe failed");
}

async function startAndProbe(dataDir, lock, version, port) {
  const legacyPort = !fs.existsSync(child(lock.targetDir, "core", "update-worker.mjs"));
  const args = [child(lock.targetDir, "core", "daemon.mjs"), `--data-dir=${dataDir}`, `--${legacyPort ? "port" : "prefer-port"}=${port}`];
  if (hasUpdateProbation(dataDir)) args.push(`--update-operation=${lock.id}`);
  const daemon = spawn(process.execPath, args, { cwd: dataDir, detached: true, windowsHide: true, stdio: "ignore" });
  let spawnError;
  daemon.on("error", error => { spawnError = error; });
  try {
    if (daemon.pid && hasUpdateProbation(dataDir)) {
      writeUpdateRecord(dataDir, "probation.json", { ...readUpdateRecord(dataDir, "probation.json"), candidatePid: daemon.pid });
    }
    const deadline = Date.now() + 15_000;
    while (!spawnError && daemon.exitCode === null && daemon.signalCode === null && Date.now() < deadline) {
      const owner = readDaemonLease(dataDir);
      if (owner?.pid === daemon.pid) {
        await probe(owner, version);
        daemon.unref();
        return owner;
      }
      await delay(80);
    }
    if (legacyPort && port && daemon.exitCode !== null) return await startAndProbe(dataDir, lock, version, 0);
    throw Error("Daemon failed to start");
  } catch (error) {
    if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) daemon.kill();
    if (daemon.pid) await waitForExit(daemon.pid);
    throw error;
  }
}

async function stopTrial(dataDir, probation) {
  const owner = readDaemonLease(dataDir);
  if (owner && owner.pid !== probation.daemonPid && isPidAlive(owner.pid)) {
    if (!await verifyDaemonLeaseOwner(owner, 2000)) throw operationError("Unable to verify the trial daemon");
    await rpc(owner, "__shutdown");
    await waitForExit(owner.pid);
  } else if (isPidAlive(probation.candidatePid) && probation.candidatePid !== probation.daemonPid) {
    // A trial process may still be starting. Wait for its verified lease before sending shutdown.
    const deadline = Date.now() + 15_000;
    while (isPidAlive(probation.candidatePid)) {
      const candidate = readDaemonLease(dataDir);
      if (candidate?.pid === probation.candidatePid) return stopTrial(dataDir, probation);
      if (Date.now() >= deadline) throw operationError("Trial daemon has not released its runtime");
      await delay(100);
    }
  }
}

/** Called under the daemon startup lock after the update coordinator is gone. */
export async function recoverInterruptedUpdate(dataDir) {
  const lock = readUpdateRecord(dataDir, "apply.lock");
  const probation = readUpdateRecord(dataDir, "probation.json");
  if (isPidAlive(lock?.pid)) throw operationError("System update in progress");
  if (lock?.id && probation?.id && lock.id !== probation.id) throw operationError("Update recovery records disagree");
  if (!lock && !probation) {
    if (hasUpdateProbation(dataDir) || fs.existsSync(updatePath(dataDir, "apply.lock"))) {
      throw operationError("Update recovery record is unreadable");
    }
    return;
  }
  const result = readUpdateRecord(dataDir, "state.json")?.lastResult;
  const committed = lock?.id && result?.id === lock.id && ["applied", "rolled_back", "auto_rolled_back"].includes(result.status);
  const journal = probation || lock;
  const original = fs.existsSync(updatePath(dataDir, "transaction", "original", "backup-meta.json"));
  let restore = Boolean(probation || original);
  if (!committed && !restore && ["applying", "rolling_back"].includes(lock?.phase)) {
    const install = readUpdateRecord(dataDir, "install.json");
    try { checkedRuntime(validateUpdateTarget(dataDir, lock.targetDir), lock.fromVersion, install?.treeHash); }
    catch { restore = true; }
  }
  if (committed) finishCommitted(dataDir, result.status);
  else if (restore) {
    const backup = verifiedBackup(dataDir, original ? ["transaction", "original"] : ["rollback"]);
    if (journal.fromVersion && backup.meta.version !== journal.fromVersion) {
      throw operationError("Backup does not match the interrupted update");
    }
    const installed = readUpdateRecord(dataDir, "install.json");
    const target = validateUpdateTarget(dataDir, journal.targetDir || installed?.targetDir);
    await stopTrial(dataDir, { ...journal, daemonPid: journal.daemonPid || lock?.daemonPid });
    restoreBackup(dataDir, target, backup);
    saveResult(dataDir, { ...lock, ...journal, fromVersion: backup.meta.version }, "auto_rolled_back",
      `Restored v${backup.meta.version} after an interrupted update`);
    if (!original) remove(dataDir, "rollback");
  }
  cleanup(dataDir, lock?.id);
  await notify(readDaemonLease(dataDir), lock?.id);
  return journal.oldPort;
}

async function runWorker(dataDir, id) {
  if (process.env.AGENT_TOWER_TEST_ROOT && !inside(process.env.AGENT_TOWER_TEST_ROOT, dataDir)) throw Error("Update path outside test sandbox");
  const deadline = Date.now() + 5000;
  let lock;
  do {
    lock = readUpdateRecord(dataDir, "apply.lock");
    if (lock?.id === id && lock.pid === process.pid) break;
    if (Date.now() >= deadline) return;
    await delay(40);
  } while (true);

  const owner = readDaemonLease(dataDir);
  let active = owner;
  let shutdownRequested = false;
  let committed = false;
  let step = "drain";
  try {
    if (owner?.pid !== lock.daemonPid || !await verifyDaemonLeaseOwner(owner)) throw Error("Update initiator is no longer running");
    lock.oldPort = owner.port;
    writeUpdateRecord(dataDir, "apply.lock", lock);
    const stage = lock.mode === "apply" ? updatePath(dataDir, "staging", lock.toVersion) : null;
    const release = stage && readUpdateRecord(dataDir, "staging", lock.toVersion, "release.json");
    const rollback = stage ? null : verifiedBackup(dataDir, ["rollback"]);
    if (stage) {
      if (!release) throw Error("Verified release receipt is missing");
      checkedRuntime(child(stage, "runtime"), lock.toVersion, release.treeHash);
    }
    if (!stage && (rollback.meta.version !== lock.toVersion || rollback.meta.rollbackSafe === false)) throw Error("Rollback changed");
    if (!await drain(dataDir, lock, owner)) {
      saveResult(dataDir, lock, "cancelled", "System update cancelled before cutover");
    } else {
      const install = installedRuntime(dataDir, lock.fromVersion, lock.targetDir);
      if (path.relative(lock.targetDir, install.targetDir) !== "") throw Error("Update target changed");
      step = "shutdown";
      shutdownRequested = true;
      const reply = await rpc(owner, "__shutdown", { requireCutover: true, updateId: id });
      if (!reply.shuttingDown) throw Error("Shutdown was not acknowledged");
      await waitForExit(owner.pid);
      active = null;
      step = "backup";
      backupRuntime(dataDir, install, release?.rollbackSafe !== false);
      writeUpdateRecord(dataDir, "probation.json", { ...lock, phase: stage ? "applying" : "rolling_back", oldPort: owner.port });
      step = "runtime replacement";
      if (stage) replaceRuntime(child(stage, "runtime"), lock.targetDir, lock.toVersion, release.treeHash);
      else restoreBackup(dataDir, lock.targetDir, rollback, lock.fromVersion);
      step = "health checks";
      active = await startAndProbe(dataDir, lock, lock.toVersion, owner.port);
      step = "commit";
      if (stage) {
        writeUpdateRecord(dataDir, "install.json", { origin: install.origin, targetDir: install.targetDir,
          version: release.version, commit: release.commit, treeHash: release.treeHash, installedAt: new Date().toISOString() });
      }
      const status = stage ? "applied" : "rolled_back";
      saveResult(dataDir, lock, status, stage ? `Updated to v${lock.toVersion}` : `Rolled back to v${lock.toVersion}`);
      committed = true;
      finishCommitted(dataDir, status);
    }
  } catch (error) {
    if (committed) return; // Startup recovery finishes the committed transaction.
    if (!shutdownRequested) {
      saveResult(dataDir, lock, "failed", error.code
        ? `System update stopped before cutover (${error.code})` : "System update stopped before cutover");
    } else {
      const probation = readUpdateRecord(dataDir, "probation.json");
      if (probation) {
        await stopTrial(dataDir, probation);
        restoreBackup(dataDir, lock.targetDir, verifiedBackup(dataDir, ["transaction", "original"]));
      }
      if (!await verifyDaemonLeaseOwner(owner, 1500) || !isPidAlive(owner.pid)) {
        await waitForExit(owner.pid);
        active = await startAndProbe(dataDir, lock, lock.fromVersion, owner.port);
      } else {
        // A lost shutdown response can precede the owner's exit.
        const health = await fetch(`http://127.0.0.1:${owner.port}/healthz`, { signal: AbortSignal.timeout(2000) }).then(r => r.json());
        if (health.shuttingDown) {
          await waitForExit(owner.pid);
          active = await startAndProbe(dataDir, lock, lock.fromVersion, owner.port);
        } else active = owner;
      }
      const reason = error.code ? `${step}, ${error.code}` : step;
      saveResult(dataDir, lock, "auto_rolled_back", `Restored v${lock.fromVersion} after ${reason} failed`);
    }
  }
  cleanup(dataDir, id);
  await notify(active, id);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , dataDir, id] = process.argv;
  if (dataDir && id) void runWorker(path.resolve(dataDir), id).catch(() => { process.exitCode = 1; });
}

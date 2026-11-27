import { spawn } from "node:child_process";
import { forceKillProcessTree } from "../../core/engines/proc-utils.mjs";

export async function within(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export function spawnSupervised(command, args, { timeoutMs, ...options }) {
  const processGroup = process.platform !== "win32";
  const proc = spawn(command, args, { ...options, detached: processGroup, windowsHide: true });
  let timeout = false, spawnError;
  let killing;
  const stop = () => killing ||= forceKillProcessTree(proc, { processGroup });
  const timer = setTimeout(() => { timeout = true; void stop(); }, timeoutMs);
  proc.once("error", error => { spawnError = error; });
  const closed = new Promise(resolve => proc.once("close", (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal, timeout, spawnError });
  }));
  return { proc, closed, async stop() { await stop(); return within(closed, 5000, "child cleanup"); } };
}

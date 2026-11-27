import { mkdir, readdir } from "node:fs/promises";
import { resolveSharedDataDir } from "../daemon-client.mjs";
import { child } from "../storage-paths.mjs";

export function createWarmPool({ pluginDataDir, enabled, allowInTest, idleTtlMs = 180_000 } = {}) {
  const inTest = Boolean(process.env.NODE_TEST_CONTEXT);
  const active = inTest ? enabled === true && allowInTest === true : enabled !== false;
  const slots = new Map();
  let draining;

  async function getWarmCwd() {
    const root = pluginDataDir || resolveSharedDataDir();
    const cwd = child(root, "warm-cwd");
    await mkdir(cwd, { recursive: true });
    if ((await readdir(cwd)).length) throw new Error("Warm engine directory must be empty.");
    return child(root, "warm-cwd");
  }

  function dispose(key, slot) {
    clearTimeout(slot.timer);
    slot.disposing ??= (async () => {
      // Close an in-flight initialize immediately rather than waiting for its RPC deadline.
      await slot.process?.close(0);
      await slot.ready;
      await slot.process?.close(0);
      if (slots.get(key) === slot) slots.delete(key);
    })().catch(() => {});
    return slot.disposing;
  }

  function replenish(key, spawn, initialize) {
    if (slots.has(key) || slots.size >= 2) return;
    const slot = {};
    slots.set(key, slot);
    slot.ready = (async () => {
      const cwd = await getWarmCwd();
      if (slot.disposing) return;
      slot.process = spawn(cwd);
      const started = performance.now();
      const initialized = await initialize(slot.process.rpc);
      if (slot.disposing) return;
      slot.process.initHandshakeMs = Math.round(performance.now() - started);
      slot.process.initialized = initialized;
      slot.available = true;
      slot.timer = setTimeout(() => void dispose(key, slot), idleTtlMs);
      slot.timer.unref();
      void slot.process.exited.then(() => {
        if (slots.get(key) === slot) void dispose(key, slot);
      });
    })().catch(() => {
      void dispose(key, slot);
    });
  }

  return {
    acquire(provider, binaryFingerprint, mcpIsolationKey, spawn, initialize, eligible = true) {
      if (!active || draining || (provider !== "codex" && provider !== "kimi-code")) return;
      const key = JSON.stringify([provider, binaryFingerprint, mcpIsolationKey]);
      const slot = slots.get(key);
      let spare;
      if (eligible && slot?.available && !slot.disposing && !slot.process.rpc.closed) {
        clearTimeout(slot.timer);
        slots.delete(key);
        spare = slot.process;
      }
      replenish(key, spawn, initialize);
      return spare;
    },
    drain() {
      return draining ??= Promise.all([...slots].map(([key, slot]) => dispose(key, slot)))
        .then(() => {}).finally(() => { draining = undefined; });
    },
  };
}

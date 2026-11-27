import assert from "node:assert/strict";
import fs from "node:fs";
import { once } from "node:events";
import { Worker } from "node:worker_threads";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { assertPresetStrictFields, resolveRoleTarget } from "../../core/catalog.mjs";
import { globalSettings } from "../../core/global-settings.mjs";
import { createOrchestrator } from "../../core/orchestrator.mjs";
import { MCP_TOOLS } from "../../sidecars/studio/mcp-entry.mjs";
import { offlineCatalog, project } from "../helpers/fixtures.mjs";
import { repoRoot, withProjectSandbox } from "../helpers/sandbox.mjs";

test("globalSettings reloads external disk updates and merges per-role saves without clobbering", () =>
  withProjectSandbox("v005-global-settings", async (dir) => {
    const control = path.join(dir, "control");
    const repo = project(dir, "repo");
    const gsA = globalSettings(control, repo);
    const gsB = globalSettings(control, repo);

    gsA.save({
      presets: {
        advisor_kimi: { effort: "max", permissionMode: "auto", interactionMode: "default" },
      },
    });

    // Wait >2ms or bump mtime if filesystem resolution is coarse, though size changed too
    const readB = gsB.read();
    assert.equal(readB.presets.advisor_kimi.effort, "max");
    assert.equal(readB.presets.advisor_kimi.permissionMode, "auto");
    assert.equal(readB.presetRevision, 1);

    // Instance B saves a different role; must NOT clobber Instance A's advisor_kimi edit
    gsB.save({
      presets: {
        executor_codex: { model: "gpt-6.2-astra", effort: "xhigh" },
      },
    });

    const readA = gsA.read();
    assert.equal(readA.presets.advisor_kimi.effort, "max");
    assert.equal(readA.presets.executor_codex.model, "gpt-6.2-astra");
    assert.equal(readA.presets.executor_codex.effort, "xhigh");
    assert.equal(readA.presetRevision, 2);
  }));

test("overlapping settings writers keep all revisions and both roles", () =>
  withProjectSandbox("v005-settings-race", async dir => {
    const control = path.join(dir, "control");
    const store = globalSettings(control, dir);
    const signal = new SharedArrayBuffer(4);
    const workers = ["advisor_codex", "executor_codex"].map(slot => new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      (async () => {
        const { globalSettings } = await import(workerData.url);
        const store = globalSettings(workerData.control, workerData.dir);
        parentPort.postMessage('ready');
        Atomics.wait(new Int32Array(workerData.signal), 0, 0);
        for (let i = 0; i < 16; i++) store.save({ presets: { [workerData.slot]: { model: workerData.slot + i } } });
      })();`, { eval: true, execArgv: [], workerData: { signal, dir, control, slot, url: new URL("../../core/global-settings.mjs", import.meta.url).href } }));
    try {
      const exits = workers.map(worker => once(worker, "exit"));
      await Promise.all(workers.map(worker => once(worker, "message")));
      Atomics.store(new Int32Array(signal), 0, 1);
      Atomics.notify(new Int32Array(signal), 0);
      assert.deepEqual(await Promise.all(exits), [[0], [0]]);
      const settings = store.read();
      assert.equal(settings.presetRevision, 32);
      for (const key of ["advisor_codex", "executor_codex"]) assert.equal(settings.presets[key].model, key + "15");
    } finally { await Promise.all(workers.map(worker => worker.terminate())); }
  }));

test("ROLE_TO_PRESET_KEY executor/advisor read customized activePresets; assertPresetStrictFields rejects stray effort/permission/interaction", async () => {
  const catalog = await offlineCatalog();
  const presets = {
    executor_kimi: { provider: "kimi-code", model: "kimi-code/k3.1-pro", effort: "max", permissionMode: "yolo", interactionMode: "default" },
    advisor_claude: { provider: "claude-code", model: "claude-opus-5-5", effort: "xhigh", permissionMode: "auto", interactionMode: "default" },
  };

  // Default role="executor" (used by delegateTask when role omitted) must read customized activePresets.executor_kimi
  const resolvedExec = resolveRoleTarget({ role: "executor", presets, catalog });
  assert.equal(resolvedExec.effort, "max");
  assert.equal(resolvedExec.permissionMode, "yolo");

  assert.throws(() => assertPresetStrictFields("executor_hydrogen", {
    executor_hydrogen: { provider: "antigravity", model: "gemini-4-hydrogen", effort: "high" },
  }, catalog, { model: "gemini-4-hydrogen-low" }), { code: "PRESET_TARGET_CONFLICT" });

  // Matching explicit fields pass assertPresetStrictFields
  assert.ok(
    assertPresetStrictFields("advisor_claude", presets, catalog, {
      provider: "claude-code",
      model: "claude-opus-5-5",
      effort: "xhigh",
      permissionMode: "auto",
      interactionMode: "default",
    })
  );

  // Conflicting effort / permissionMode / interactionMode alongside presetKey must fail with PRESET_TARGET_CONFLICT
  for (const conflict of [
    { effort: "low" },
    { permissionMode: "plan" },
    { interactionMode: "plan" },
  ]) {
    assert.throws(
      () => assertPresetStrictFields("advisor_claude", presets, catalog, conflict),
      { code: "PRESET_TARGET_CONFLICT" }
    );
  }

  // MCP schema must no longer mislead host LLM into passing interactionMode: "plan" alongside advisor presetKey
  const delegateTool = MCP_TOOLS.find((t) => t.name === "delegate_task");
  assert.ok(delegateTool);
  const imodeDesc = delegateTool.inputSchema.properties.interactionMode.description;
  assert.ok(!imodeDesc.includes("军师只读规划传"), `interactionMode description still contains misleading prompt: ${imodeDesc}`);
  assert.match(imodeDesc, /PRESET_TARGET_CONFLICT/);
});

test("preset-bound threads dynamically sync updated presets on delegate reuse, thread_send, retryRun, queue drain, and review_code while respecting manual detachment", () =>
  withProjectSandbox("v005-orchestrator-sync", async (dir) => {
    const cwd = project(dir, "repo");
    const o = createOrchestrator({
      dataDir: path.join(dir, "control"),
      defaultStudioRoot: cwd,
      catalogLoader: offlineCatalog,
    });
    await o.saveSettings({ defaultOrchestrationMode: "complex" });
    const launches = [];
    let holdTurnResolve = null;
    o.engineManager.runTurn = (opts) => {
      launches.push(opts);
      opts.onEvent({ type: "effective_model", effectiveModel: opts.model });
      if (opts.prompt?.includes("[HOLD_TURN]")) {
        return {
          steer: async () => ({ supported: false }),
          cancel: async () => {
            holdTurnResolve?.({ status: "interrupted", nativeSessionId: `native-${opts.provider}` });
          },
          result: new Promise((resolve) => {
            holdTurnResolve = resolve;
          }),
        };
      }
      return {
        result: Promise.resolve({ status: "completed", nativeSessionId: `native-${opts.provider}` }),
      };
    };

    const ctx = { conversationId: "conv-v005", cwd, mode: "wait" };
    try {
      // 1. Initial dispatch with default advisor_claude (effort: xhigh, permissionMode: plan, interactionMode: plan)
      const first = await o.delegateTask({ ...ctx, presetKey: "advisor_claude", task: "round 1" });
      assert.equal(launches.at(-1).effort, "xhigh");
      assert.equal(launches.at(-1).permissionMode, "plan");
      assert.equal(launches.at(-1).interactionMode, "plan");

      // Stray interactionMode / effort alongside presetKey is rejected at RPC boundary
      await assert.rejects(
        o.delegateTask({ ...ctx, presetKey: "advisor_claude", effort: "low", task: "bad override" }),
        { code: "PRESET_TARGET_CONFLICT" }
      );

      await assert.rejects(o.retryRun({ threadId: first.threadId, presetKey: "advisor_claude", model: "wrong" }),
        { code: "PRESET_TARGET_CONFLICT" });
      await assert.rejects(o.delegateParallelBatch({ ...ctx, tasks: [
        { presetKey: "advisor_claude", task: "must not launch" },
        { presetKey: "advisor_claude", task: "invalid", effort: "low" },
      ] }), { code: "PRESET_TARGET_CONFLICT" });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(launches.length, 1);

      // 2. User edits advisor_claude in Studio panel: effort -> medium, permissionMode -> auto, interactionMode -> default, model -> claude-sonnet-5-5
      await o.saveSettings({
        presets: {
          advisor_claude: {
            provider: "claude-code",
            model: "claude-sonnet-5-5",
            effort: "medium",
            permissionMode: "auto",
            interactionMode: "default",
          },
        },
      });

      // 3. Plain thread_send({ threadId, message }) WITHOUT presetKey must dynamically apply updated preset while keeping selectionSource: "thread_resume"
      const resumed = await o.sendToThread({ threadId: first.threadId, message: "round 2", wait: true });
      assert.equal(launches.at(-1).model, "claude-sonnet-5-5");
      assert.equal(launches.at(-1).effort, "medium");
      assert.equal(launches.at(-1).permissionMode, "auto");
      assert.equal(launches.at(-1).interactionMode, "default");
      assert.equal(o.db.getRun(resumed.runId).meta.selectionSource, "thread_resume");
      assert.equal(o.db.getThread(first.threadId).model, "claude-sonnet-5-5");

      // 4. User edits advisor_claude again (effort -> high), then triggers retryRun -> must use new effort ("high"), NOT stale sourceRun ("medium")
      await o.saveSettings({
        presets: {
          advisor_claude: {
            provider: "claude-code",
            model: "claude-sonnet-5-5",
            effort: "high",
            permissionMode: "auto",
            interactionMode: "default",
          },
        },
      });
      await o.retryRun({ threadId: first.threadId, wait: true });
      assert.equal(launches.at(-1).effort, "high");

      // 5. Queued run picks up preset edit made while previous turn is still in flight
      const running = await o.delegateTask({
        conversationId: "conv-v005-q",
        cwd,
        mode: "async",
        presetKey: "executor_codex",
        task: "[HOLD_TURN] work 1",
      });
      // Queue follow-up before changing preset
      const qRes = await o.sendToThread({ threadId: running.threadId, message: "work 2 queued", mode: "queue" });
      assert.equal(qRes.action, "queued");
      // User changes executor_codex preset while work 1 is still running!
      await o.saveSettings({
        presets: {
          executor_codex: {
            provider: "codex",
            model: "gpt-6.2-astra",
            effort: "xhigh",
            permissionMode: "auto",
            interactionMode: "default",
          },
        },
      });
      // Finish work 1 -> queued work 2 drains and must pick up gpt-6.2-astra / xhigh / auto!
      holdTurnResolve({ status: "completed", nativeSessionId: "native-codex" });
      for (let i = 0; i < 40 && launches.at(-1)?.model !== "gpt-6.2-astra"; i++) {
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(launches.at(-1).model, "gpt-6.2-astra");
      assert.equal(launches.at(-1).effort, "xhigh");
      assert.equal(launches.at(-1).permissionMode, "auto");

      // An explicit queue route changes the binding when started, just like an immediate send.
      const held = await o.delegateTask({ conversationId: "queued-rebind", cwd, mode: "async", presetKey: "advisor_claude", task: "[HOLD_TURN] rebind" });
      await o.sendToThread({ threadId: held.threadId, mode: "queue", presetKey: "executor_codex", message: "queued rebind" });
      await o.saveSettings({ presets: { executor_codex: { model: "gpt-6.2-sol" } } });
      holdTurnResolve({ status: "completed" });
      for (let i = 0; i < 40 && o.db.getThread(held.threadId).presetKey !== "executor_codex"; i++) await new Promise(r => setTimeout(r, 25));
      assert.equal(o.db.getThread(held.threadId).presetKey, "executor_codex");
      assert.equal(o.db.getThread(held.threadId).model, "gpt-6.2-sol");

      // 6. Manual per-thread configureThread detaches presetKey when effort/permission customized, preserving manual choice across future sends
      await o.configureThread({ threadId: first.threadId, effort: "low" });
      assert.equal(o.db.getThread(first.threadId).presetKey, "");
      await o.saveSettings({
        presets: { advisor_claude: { effort: "xhigh" } },
      });
      await o.sendToThread({ threadId: first.threadId, message: "detached custom effort", wait: true });
      assert.equal(launches.at(-1).effort, "low");

      // Re-attaching presetKey via configureThread restores dynamic preset tracking
      await o.configureThread({ threadId: first.threadId, presetKey: "advisor_claude" });
      assert.equal(o.db.getThread(first.threadId).presetKey, "advisor_claude");
      assert.equal(o.db.getThread(first.threadId).effort, "xhigh");

      // 7. review_code respects updated reviewer preset (model, effort, permissionMode) while readOnly still forces read-only
      await o.saveSettings({
        presets: {
          reviewer: {
            provider: "codex",
            model: "gpt-6.2-sol",
            effort: "medium",
            permissionMode: "auto",
            interactionMode: "default",
          },
        },
      });
      const rev = await o.runCodeReview({ conversationId: "conv-v005", cwd, wait: true });
      assert.ok(rev);
      assert.equal(launches.at(-1).model, "gpt-6.2-sol");
      assert.equal(launches.at(-1).effort, "medium");
      assert.equal(launches.at(-1).permissionMode, "auto");

      const readonly = await o.runCodeReview({ conversationId: "conv-v005", cwd, readOnly: true, wait: true });
      assert.equal(launches.at(-1).model, "gpt-6.2-sol");
      assert.equal(launches.at(-1).permissionMode, "read-only");
      await o.retryRun({ threadId: readonly.threadId, wait: true });
      assert.equal(launches.at(-1).permissionMode, "read-only");
      await o.sendToThread({ threadId: readonly.threadId, message: "inspect again", wait: true });
      assert.equal(launches.at(-1).permissionMode, "read-only");
    } finally {
      await o.shutdown();
    }
  }));

test("Studio UI presetDispatchRoute compares full preset tuple and syncBoundDraftsWithPresets updates unmodified drafts", async () => {
  const studioUiDir = path.join(repoRoot, "sidecars", "studio", "ui");
  globalThis.window ??= { location: { search: "", pathname: "/" } };
  globalThis.location ??= { search: "", pathname: "/" };
  globalThis.document ??= { getElementById: () => null, querySelector: () => null };
  const { state, ROLE_SLOT_META } = await import(pathToFileURL(path.join(studioUiDir, "state.js")).href);
  const { presetDispatchRoute } = await import(pathToFileURL(path.join(studioUiDir, "normalize.js")).href);
  const { syncBoundDraftsWithPresets } = await import(pathToFileURL(path.join(studioUiDir, "presets.js")).href);

  for (const slot of ROLE_SLOT_META) state.presets[slot.key] = { ...slot.defaults };

  // Matching all fields returns { presetKey }
  assert.deepEqual(
    presetDispatchRoute("executor_codex", {
      provider: "codex",
      model: "gpt-6.2-sol",
      effort: "high",
      permissionMode: "full-access",
    }),
    { presetKey: "executor_codex" }
  );

  // Changing ONLY effort or permissionMode detaches from presetKey into explicit route
  assert.deepEqual(
    presetDispatchRoute("executor_codex", {
      provider: "codex",
      model: "gpt-6.2-sol",
      effort: "low",
      permissionMode: "full-access",
    }),
    { provider: "codex", model: "gpt-6.2-sol" }
  );
  assert.deepEqual(
    presetDispatchRoute("executor_codex", {
      provider: "codex",
      model: "gpt-6.2-sol",
      effort: "high",
      permissionMode: "auto",
    }),
    { provider: "codex", model: "gpt-6.2-sol" }
  );

  // Bind Composer, Dispatch Drawer, and Batch Drafts, then mutate state.presets and sync
  state.composer.presetKey = "advisor_kimi";
  state.selectedPresetChip = "executor_codex";
  state.dispatchPresetDetached = false;
  state.batchDrafts = [
    { presetKey: "advisor_kimi", provider: "kimi-code", model: "kimi-code/k3.1-pro", effort: "high", permissionMode: "plan", customizedFields: {} },
    { presetKey: "executor_codex", provider: "codex", model: "gpt-6.2-sol", effort: "low", permissionMode: "full-access", customizedFields: { effort: true } },
  ];

  state.presets.advisor_kimi = {
    provider: "kimi-code",
    model: "kimi-code/k3",
    effort: "max",
    permissionMode: "auto",
    interactionMode: "default",
    isolation: "shared",
  };
  state.presets.executor_codex = {
    provider: "codex",
    model: "gpt-6.2-astra",
    effort: "xhigh",
    permissionMode: "auto",
    interactionMode: "default",
    isolation: "shared",
  };

  syncBoundDraftsWithPresets();

  assert.equal(state.composer.model, "kimi-code/k3");
  assert.equal(state.composer.effort, "max");
  assert.equal(state.composer.permissionMode, "auto");

  assert.equal(state.dispatchSelection.model, "gpt-6.2-astra");
  assert.equal(state.dispatchSelection.effort, "xhigh");
  assert.equal(state.dispatchSelection.permissionMode, "auto");

  // Batch row 0 (unmodified) synced completely; Batch row 1 synced model & permission while preserving customized effort="low"
  assert.equal(state.batchDrafts[0].model, "kimi-code/k3");
  assert.equal(state.batchDrafts[0].effort, "max");
  assert.equal(state.batchDrafts[0].permissionMode, "auto");
  assert.equal(state.batchDrafts[1].model, "gpt-6.2-astra");
  assert.equal(state.batchDrafts[1].effort, "low");
  assert.equal(state.batchDrafts[1].permissionMode, "auto");
});

test("a late save acknowledgement reveals the newer committed preset after clearing the local draft", async t => {
  globalThis.window ??= { location: { search: "" } };
  globalThis.document ??= { getElementById: () => null };
  const { state } = await import("../../sidecars/studio/ui/state.js");
  const { saveAllRolePresets, mergeRemotePresets } = await import("../../sidecars/studio/ui/presets.js");
  const key = "executor_codex";
  let finishSave;
  t.mock.method(globalThis, "fetch", () => new Promise(resolve => { finishSave = resolve; }));
  const cfg = { ...state.presets[key], model: "local" };
  state.presets[key] = cfg;
  state.dirtyPresets.set(key, new Map([["model", 1]]));
  state.renderScheduled = true;
  const saving = saveAllRolePresets();
  mergeRemotePresets({ presetRevision: 2, presets: { [key]: { ...cfg, model: "newer" } } });
  assert.equal(state.presets[key].model, "local");
  finishSave({ ok: true, json: async () => ({ settings: { presetRevision: 1 }, presets: { [key]: cfg } }) });
  await saving;
  assert.equal(state.dirtyPresets.size, 0);
  assert.equal(state.presets[key].model, "newer");
  state.pendingDeletes.add(key);
  const deleting = saveAllRolePresets();
  mergeRemotePresets({ presetRevision: 4, presets: { [key]: { ...cfg, model: "recreated" } } });
  finishSave({ ok: true, json: async () => ({ presetRevision: 3, presets: {} }) });
  await deleting;
  assert.equal(state.presets[key].model, "recreated");
});

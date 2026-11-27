import { loadProviderCatalogs } from "./catalog.mjs";
import { sendWakeAlertToHostConversation } from "./engines/agy-native.mjs";
import { createWatchdog } from "./watchdog.mjs";
import { VERSION } from "./orchestrator/helpers.mjs";
import { createContext, createContextModule } from "./orchestrator/context.mjs";
import { createScopePolicyModule } from "./orchestrator/scope-policy.mjs";
import { createCatalogSettingsModule } from "./orchestrator/catalog-settings.mjs";
import { createHealthModule } from "./orchestrator/health.mjs";
import { createHostSyncModule } from "./orchestrator/host-sync.mjs";
import { createExecutionModule } from "./orchestrator/execution.mjs";
import { createCancellationModule } from "./orchestrator/cancellation.mjs";
import { createTurnsModule } from "./orchestrator/turns.mjs";
import { createDispatchModule } from "./orchestrator/dispatch.mjs";
import { createWorktreesModule } from "./orchestrator/worktrees.mjs";
import { createReviewModule } from "./orchestrator/review.mjs";
import { createSpecsModule } from "./orchestrator/specs.mjs";
import { createQueriesModule } from "./orchestrator/queries.mjs";
import { createUpdatesModule } from "./orchestrator/updates.mjs";

export function createOrchestrator({
  dataDir,
  defaultStudioRoot,
  catalogLoader = loadProviderCatalogs,
  studioUrl = "",
  log = () => {},
  recoverStaleState = true,
  watchdogOptions,
  feedUrl,
  fetchImpl,
  hostWakeSender = sendWakeAlertToHostConversation,
} = {}) {
  const ctx = createContext({
    dataDir,
    defaultStudioRoot,
    catalogLoader,
    studioUrl,
    hostWakeSender,
    log,
    watchdogOptions,
  });
  ctx.watchdog = createWatchdog({
    ...watchdogOptions,
    onSignal: (state, signal) => ctx.health.handleWatchdogSignal(state, signal),
    onStallRecovered: (state, info) => ctx.health.handleStallRecovered(state, info),
  });

  // Factories only bind methods; cross-domain calls happen after assembly.
  ctx.context = createContextModule(ctx);
  ctx.scopePolicy = createScopePolicyModule(ctx);
  ctx.catalogSettings = createCatalogSettingsModule(ctx);
  ctx.health = createHealthModule(ctx);
  ctx.hostSync = createHostSyncModule(ctx);
  ctx.execution = createExecutionModule(ctx);
  ctx.cancellation = createCancellationModule(ctx);
  ctx.turns = createTurnsModule(ctx);
  ctx.dispatch = createDispatchModule(ctx);
  ctx.worktrees = createWorktreesModule(ctx);
  ctx.review = createReviewModule(ctx);
  ctx.queries = createQueriesModule(ctx);
  ctx.specs = createSpecsModule(ctx);
  ctx.updates = createUpdatesModule(ctx, { currentVersion: VERSION, feedUrl, fetchImpl });

  const rpcHandlers = {
    getBootstrap: ctx.queries.getBootstrap,
    getConversationPolicy: ctx.scopePolicy.getConversationPolicy,
    setConversationPolicy: ctx.scopePolicy.setConversationPolicy,
    listHealthIncidents: ctx.health.listHealthIncidents,
    dismissHealthIncident: ctx.health.dismissHealthIncident,
    getCapabilities: async (p = {}) => ({ ...await ctx.catalogSettings.getCapabilities(p), ...ctx.specs.projectSpecsSummary(p) }),
    listProjectSpecs: ctx.specs.listProjectSpecs,
    initProjectSpecs: ctx.specs.initProjectSpecs,
    specCuration: ctx.specs.specCuration,
    saveSettings: ctx.catalogSettings.saveSettings,
    delegateTask: ctx.dispatch.delegateTask,
    delegateParallelBatch: ctx.dispatch.delegateParallelBatch,
    getTaskStatus: ctx.dispatch.getTaskStatus,
    cancelTask: ctx.cancellation.cancelTask,
    cancelThread: ctx.cancellation.cancelTask,
    launchThread: ctx.dispatch.launchThread,
    listThreads: ctx.queries.listThreads,
    deleteThread: ctx.cancellation.deleteThread,
    archiveThread: ctx.hostSync.archiveThread,
    readThread: ctx.queries.readThread,
    sendToThread: ctx.turns.sendToThread,
    manageQueue: ctx.turns.manageQueue,
    configureThread: ctx.turns.configureThread,
    retryRun: ctx.turns.retryRun,
    respondRuntimeRequest: ctx.turns.respondRuntimeRequest,
    runCodeReview: ctx.review.runCodeReview,
    reviewCode: ctx.review.runCodeReview,
    listWorktrees: ctx.worktrees.listWorktrees,
    getWorktreeDiff: ctx.worktrees.getWorktreeDiff,
    integrateWorktree: ctx.worktrees.integrateWorktree,
    cleanupWorktree: ctx.worktrees.cleanupWorktree,
    getRuntimeCacheStatus: ctx.worktrees.getRuntimeCacheStatus,
    cleanRuntimeCache: ctx.worktrees.cleanRuntimeCache,
    listExtensionProviders: ctx.catalogSettings.listExtensionProviders,
    probeExtensionProvider: ctx.catalogSettings.probeExtensionProvider,
    saveExtensionProvider: ctx.catalogSettings.saveExtensionProvider,
    removeExtensionProvider: ctx.catalogSettings.removeExtensionProvider,
    updateHostContext: async (p) => {
      ctx.context.updateHostContext(p);
      return { ok: true };
    },
    getEvents: async (p) => ctx.queries.getEvents(p),
    systemUpdate: ctx.updates.systemUpdate,
  };
  ctx.updates.guardRoutes(rpcHandlers);

  async function handleRpc(method, params = {}) {
    if (params && typeof params === "object") {
      if (params.appDataDir || params.agentApiExe || params.projectId) {
        ctx.context.updateHostContext({
          appDataDir: params.appDataDir,
          agentApiExe: params.agentApiExe,
          projectId: params.projectId,
        });
      }
    }
    const fn = Object.hasOwn(rpcHandlers, method) && rpcHandlers[method];
    if (!fn) {
      const err = new Error(`Unknown orchestrator RPC method: "${method}"`);
      err.code = "METHOD_NOT_FOUND";
      throw err;
    }
    return fn(params || {});
  }

  async function shutdown() {
    ctx.flags.shuttingDown = true;
    ctx.updates.close();
    ctx.specs.stopAutoCuration();
    ctx.watchdog.close();
    const backoffs = [...ctx.activeRuns.values()].filter(entry => entry.retryPending);
    await Promise.allSettled(backoffs.map(entry => entry.handle.cancel()));
    log("Shutting down orchestrator active engines, native watchers, and SQLite WAL...");
    ctx.hostSync.stopNativeWatchers();
    await ctx.engineManager.shutdownAll().catch(() => {});
    ctx.flags.dbClosed = true;
    ctx.db.close();
  }

  // Initialize the host bridge before recovery can publish any events.
  ctx.context.updateHostContext(ctx.hostContext);
  // Keep the v0.0.3 truthy check, including explicit false and legacy falsy inputs.
  if (recoverStaleState) ctx.execution.recoverStaleStateOnStartup();
  ctx.updates.schedule();

  return {
    ...rpcHandlers,
    version: VERSION,
    db: ctx.db,
    engineManager: ctx.engineManager,
    updateHostContext: ctx.context.updateHostContext,
    hasActiveRuns: () => ctx.activeRuns.size > 0 || ctx.pendingTurnStartLocks.size > 0,
    setStudioUrl(url) {
      ctx.flags.currentStudioUrl = url;
    },
    getStudioUrl() {
      return ctx.flags.currentStudioUrl;
    },
    getBootstrap: ctx.queries.getBootstrap,
    getEvents: ctx.queries.getEvents,
    resolveConversationRoot: (conversationId, appDataDir) => ctx.scopePolicy.policyRoot({ conversationId, appDataDir }),
    matchesEventConversation: ctx.context.matchesEventConversation,
    subscribe: ctx.context.subscribe,
    handleRpc,
    shutdown,
  };
}

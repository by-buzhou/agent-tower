import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import {
  BUILTIN_EXTENSION_TEMPLATES,
  buildInitialRosterFromProbe,
  curatorRestrictions,
  detectExtensionBinary,
  getCatalogConfigFingerprint,
  getExtensionCandidatePaths,
  assertPresetStrictFields,
  listExtensionTemplates,
  maskHomePrefix,
  mergeActivePresets,
  normalizeModeProfiles,
  normalizeOrchestrationMode,
  normalizeCustomProvidersList,
  normalizeProviderId,
  resolveRoleTarget,
  roleMemberGroup,
} from "../catalog.mjs";
import { resolveProjectRootSync, settingsWriteScope } from "../global-settings.mjs";
import { resolveExternalCommand } from "../engines/proc-utils.mjs";
import {
  VERSION,
  enrichExtensionTemplates,
  projectPathKey,
  sanitizeCustomProviderForPublic,
} from "./helpers.mjs";

export function createCatalogSettingsModule(ctx) {
  function toPublicSettings(rawSettings = {}) {
    const cloned = {
      ...rawSettings,
      defaultOrchestrationMode: rawSettings.defaultOrchestrationMode || (rawSettings.defaultDispatchEnabled ? "relay" : "direct"),
      defaultDispatchEnabled: rawSettings.defaultDispatchEnabled === true,
      defaultSpecEnabled: rawSettings.defaultSpecEnabled === true,
      defaultExternalSessionVisible: rawSettings.defaultExternalSessionVisible === true,
      autoCheckUpdates: rawSettings.autoCheckUpdates !== false,
      presetRevision: rawSettings.presetRevision || 0,
      memberPool: rawSettings.memberPool || {},
      modeProfiles: rawSettings.modeProfiles || {},
      relayTargetPresetKey: rawSettings.modeProfiles?.relay?.executor?.preferredKey ?? null,
      deletedPresets: Array.isArray(rawSettings.deletedPresets) ? [...rawSettings.deletedPresets] : [],
      customPipelines: rawSettings.customPipelines || {},
      presets: rawSettings.presets || rawSettings.rolePresets || {},
    };
    delete cloned._extensionEnvVault;
    delete cloned.rosterMigrationPending;
    delete cloned.projectProfiles;
    delete cloned.specCurationByProject;
    cloned.customProviders = normalizeCustomProvidersList(rawSettings.customProviders).map(
      sanitizeCustomProviderForPublic
    );
    return cloned;
  }

  function configPayload(workspace, global = ctx.db.getSettings()) {
    const resolvedWorkspace = workspace ? resolveProjectRootSync(workspace, global.projectProfiles) : "";
    const roster = ctx.db.getProjectRoster(resolvedWorkspace, global);
    const { source, customized, rosterRevision, updatedAt, ...effective } = roster;
    const settings = toPublicSettings({ ...global, ...effective, rolePresets: effective.presets, presetRevision: rosterRevision });
    const counts = { advisor: 0, executor: 0, reviewer: 0, curator: 0, total: 0 };
    for (const preset of Object.values(global.presets)) {
      const group = roleMemberGroup(preset.group || preset.role);
      if (group && Object.hasOwn(counts, group)) counts[group]++;
      counts.total++;
    }
    const key = projectPathKey(resolvedWorkspace);
    const { mode: externalSessionMode } = ctx.db.getProjectExternalSessions(resolvedWorkspace, global);
    return {
      settings, presets: settings.presets, modeProfiles: settings.modeProfiles, memberPool: settings.memberPool,
      presetRevision: settings.presetRevision,
      projectConfig: {
        workspace: resolvedWorkspace || null, projectKey: key, rosterSource: resolvedWorkspace ? source : "unbound",
        rosterCustomized: customized, rosterRevision, specEnabled: Boolean(resolvedWorkspace && ctx.db.isProjectSpecEnabled(resolvedWorkspace, global)),
        specCustomized: Boolean(resolvedWorkspace && global.projectProfiles?.[key]?.spec),
        externalSessionMode,
        externalSessionVisible: ctx.db.isProjectExternalSessionVisible(resolvedWorkspace, global),
        externalSessionCustomized: externalSessionMode !== "inherit",
      },
      globalTemplate: { presetRevision: global.presetRevision, presets: global.presets, modeProfiles: global.modeProfiles, deletedPresets: global.deletedPresets, counts },
    };
  }

  function getRuntimeCustomProvidersList(rawSettings = ctx.db.getSettings()) {
    const vault =
      rawSettings?._extensionEnvVault && typeof rawSettings._extensionEnvVault === "object"
        ? rawSettings._extensionEnvVault
        : {};
    return normalizeCustomProvidersList(rawSettings?.customProviders).map((cfg) => {
      const clean = sanitizeCustomProviderForPublic(cfg);
      const secretEnv = vault[clean.id] && typeof vault[clean.id] === "object" ? vault[clean.id] : undefined;
      return secretEnv ? { ...clean, env: { ...secretEnv } } : clean;
    });
  }

  const probeCache = new Map();

  function findTemplate(rawId) {
    const pid = normalizeProviderId(String(rawId || "")).toLowerCase();
    const raw = String(rawId || "").trim().toLowerCase();
    return BUILTIN_EXTENSION_TEMPLATES.find(
      (t) => t.id.toLowerCase() === pid || t.id.toLowerCase() === raw ||
        (Array.isArray(t.aliases) && (t.aliases.includes(pid) || t.aliases.includes(raw)))
    ) || null;
  }

  function getRuntimeProviderConfig(providerId, rawSettings = ctx.db.getSettings()) {
    const pid = normalizeProviderId(String(providerId || "")).toLowerCase();
    if (!pid) return undefined;
    const tpl = findTemplate(pid);
    const runtimeList = getRuntimeCustomProvidersList(rawSettings);
    const matched = runtimeList.find((c) => normalizeProviderId(c.id).toLowerCase() === pid || c.id.toLowerCase() === pid);
    const extraCandidatePaths = getExtensionCandidatePaths(tpl?.id || pid, matched?.extraCandidatePaths || tpl?.extraCandidatePaths || []);
    if (matched) {
      return {
        ...matched,
        driverKind: matched.driverKind || tpl?.driverKind || (matched.protocol === "zcode" ? "zcode" : matched.protocol === "cli" ? "generic-cli" : "generic-acp"),
        extraCandidatePaths,
        envPolicy: matched.envPolicy || tpl?.envPolicy || "inherit",
        credentialEnvKeys: matched.credentialEnvKeys?.length ? matched.credentialEnvKeys : [...(tpl?.credentialEnvKeys || [])],
        ephemeralSupport: matched.ephemeralSupport || tpl?.ephemeralSupport || "delete",
      };
    }
    if (tpl) {
      return {
        id: tpl.id,
        displayName: tpl.displayName,
        protocol: tpl.protocol,
        driverKind: tpl.driverKind || (tpl.protocol === "zcode" ? "zcode" : tpl.protocol === "cli" ? "generic-cli" : "generic-acp"),
        command: tpl.command,
        args: [...tpl.args],
        argsTemplate: tpl.argsTemplate,
        extraCandidatePaths,
        envPolicy: tpl.envPolicy || "inherit",
        credentialEnvKeys: [...(tpl.credentialEnvKeys || [])],
        ephemeralSupport: tpl.ephemeralSupport || "delete",
        efforts: Array.isArray(tpl.efforts) ? [...tpl.efforts] : ["low", "medium", "high"],
        defaultModel: tpl.defaultModels?.[0]?.slug || "default",
      };
    }
    return undefined;
  }

  async function refreshEnabledExtensionProviders(initialList, pending) {
    if (typeof ctx.engineManager?.probeExtensionProvider !== "function") return initialList;
    const updates = new Map();
    for (const ext of initialList) {
      if (!ext || ext.enabled === false) continue;
      const proto = String(ext.protocol || "").trim().toLowerCase();
      if (proto !== "acp" && proto !== "zcode") continue;
      const currentEntry = normalizeCustomProvidersList(ctx.db.getSettings().customProviders).find(entry => entry.id === ext.id);
      if (!isDeepStrictEqual(currentEntry, ext)) continue;
      const candidates = getExtensionCandidatePaths(ext.id, ext.extraCandidatePaths);
      const binCheck = detectExtensionBinary(ext.id, ext.command, candidates, proto);
      if (!binCheck.detected) continue;
      try {
        const probed = await probeExtensionProvider({ id: ext.id, force: true });
        if (probed?.ok && Array.isArray(probed.models) && probed.models.length > 0) {
          updates.set(ext.id, { original: ext, probed });
        }
      } catch {
        // Keep previously persisted models if live refresh probe fails.
      }
    }
    const latestList = normalizeCustomProvidersList(ctx.db.getSettings().customProviders);
    let changed = false;
    const mergedList = latestList.map(entry => {
      const update = updates.get(entry.id);
      if (!update || !isDeepStrictEqual(entry, update.original)) return entry;
      const { probed } = update;
      const previousDefaultAvailable = probed.models.some(model =>
        (typeof model === "string" ? model : model.slug || model.id) === entry.defaultModel);
      changed = true;
      return sanitizeCustomProviderForPublic({
        ...entry, models: probed.models,
        defaultModel: probed.defaultModel || (previousDefaultAvailable ? entry.defaultModel : undefined),
        ...(Array.isArray(probed.efforts) && probed.efforts.length ? { efforts: probed.efforts } : {}),
        ...(probed.ephemeralSupport ? { ephemeralSupport: probed.ephemeralSupport } : {}),
        updatedAt: Date.now(),
      });
    });
    if (changed) {
      ctx.db.saveSettings({ customProviders: mergedList });
      // A concurrent save may already have loaded a catalog using the previous models.
      if (ctx.flags.catalogLoad !== pending) ctx.flags.catalogLoad = ctx.flags.cachedCatalog = null;
    }
    return mergedList;
  }

  async function ensureCatalog({ refresh = false, skipExtensionProbe = false } = {}) {
    const settings = ctx.db.getSettings();
    const customProviders = normalizeCustomProvidersList(settings.customProviders);
    const customSig = customProviders.map((c) => `${c.id}:${c.enabled !== false}`).join(",");
    const hostBridgeAvailable = Boolean(ctx.engineManager.getHostContext?.()?.hostBridgeAvailable);
    const makeKey = () => `${customSig}|${hostBridgeAvailable ? 1 : 0}|${getCatalogConfigFingerprint(ctx.dataDir)}`;
    const cacheKey = makeKey();
    const current = ctx.flags.catalogLoad;
    if (current?.key === cacheKey && (!refresh || (current.refresh && current.skipExtensionProbe === skipExtensionProbe))) return current.promise;
    if (!refresh && ctx.flags.cachedCatalog && ctx.flags.cachedCatalogKey === cacheKey && Date.now() - ctx.flags.cachedCatalogAt < 45000) {
      return ctx.flags.cachedCatalog;
    }
    const pending = { key: cacheKey, refresh, skipExtensionProbe };
    pending.promise = (async () => {
      const effectiveCustomProviders = refresh && !skipExtensionProbe
        ? await refreshEnabledExtensionProviders(customProviders, pending)
        : customProviders;
      const loaded = await (0, ctx.catalogLoader)({
        customProviders: effectiveCustomProviders,
        refresh,
        cacheDir: ctx.dataDir,
        cwd: ctx.defaultStudioRoot,
        hostBridgeAvailable,
      });
      if (ctx.flags.catalogLoad === pending) {
        ctx.flags.cachedCatalog = loaded;
        ctx.flags.cachedCatalogKey = makeKey();
        ctx.flags.cachedCatalogAt = Date.now();
      }
      return loaded;
    })().finally(() => {
      if (ctx.flags.catalogLoad === pending) ctx.flags.catalogLoad = undefined;
    });
    ctx.flags.catalogLoad = pending;
    return pending.promise;
  }

  async function resolveEffectiveTarget({
    role,
    presetKey,
    provider,
    model,
    effort,
    modelSelection,
    permissionMode,
    runtimeMode,
    interactionMode,
    isolation,
    workspaceStrategy,
    workspace,
    target,
    orchestrationMode,
    executionIntent,
    allowDisabledPreset = false,
  } = {}, batchCatalog) {
    const catalog = batchCatalog ?? await ensureCatalog();
    await ensureInitialRoster({ catalog });
    const settings = ctx.db.getSettings(workspace);
    if (role === "curator" || (presetKey && settings.presets[presetKey]?.group === "curator")) ctx.specs.assertSpecEnabled(workspace);
    const deletedPresets = Array.isArray(settings.deletedPresets) ? settings.deletedPresets : [];
    const activePresets = mergeActivePresets(settings.presets || settings.rolePresets || {}, deletedPresets, { rosterVersion: 2 });
    const mode = orchestrationMode ? normalizeOrchestrationMode(orchestrationMode, "direct", settings.customPipelines) : "";
    const customProviders = normalizeCustomProvidersList(settings.customProviders);
    const modeProfiles = normalizeModeProfiles(settings.modeProfiles, activePresets, {
      memberPool: settings.memberPool,
      relayTargetPresetKey: settings.relayTargetPresetKey,
    });

    const mergedTarget = {
      ...(target && typeof target === "object" ? target : {}),
      ...(modelSelection && typeof modelSelection === "object" ? modelSelection : {}),
    };
    if (provider !== undefined) mergedTarget.provider = provider;
    if (model !== undefined) mergedTarget.model = model;
    if (effort !== undefined) mergedTarget.effort = effort;
    const perm = permissionMode ?? runtimeMode ?? mergedTarget.permissionMode;
    if (perm !== undefined) mergedTarget.permissionMode = perm;
    if (interactionMode !== undefined) mergedTarget.interactionMode = interactionMode;

    let iso = isolation ?? mergedTarget.isolation;
    if (!iso && workspaceStrategy && typeof workspaceStrategy === "object") {
      iso = workspaceStrategy.type === "worktree" ? "worktree" : "local";
    }
    if (iso !== undefined) mergedTarget.isolation = iso;

    let selectedPresetKey = String(presetKey || "").trim();
    let temporaryOverride = false;
    const explicitTarget = Boolean(selectedPresetKey || provider || model || mergedTarget.provider || mergedTarget.model);
    const roleName = String(role || "executor").toLowerCase();
    const requestedPresetGroup = activePresets[selectedPresetKey]?.group;
    if ((roleName === "review" || roleName === "reviewer") && requestedPresetGroup === "curator") {
      throw Object.assign(new Error("代码终审仅允许选用审核组成员"), {
        code: "PRESET_NOT_IN_MODE",
        details: { mode, group: requestedPresetGroup, presetKey: selectedPresetKey },
      });
    }
    const curator = requestedPresetGroup === "curator" || roleMemberGroup(roleName) === "curator";
    const group = curator ? "curator" : requestedPresetGroup || roleMemberGroup(roleName);
    const profile = curator ? modeProfiles.complex.curator : mode === "relay"
      ? (group === "executor" ? modeProfiles.relay.executor : null)
      : mode === "complex" ? modeProfiles.complex[group] : null;
    const enabledKeys = Array.isArray(profile?.enabledKeys) ? profile.enabledKeys : [];
    const modeError = (message, code, details) => Object.assign(new Error(message), { code, details });
    if (curator) curatorRestrictions(mergedTarget.provider || mergedTarget.driverKind || mergedTarget.providerInstanceId || mergedTarget.instanceId);
    const assertModeGroup = () => {
      if (curator || !mode || mode === "direct") return;
      if (mode === "relay" && group !== "executor") {
        throw modeError("当前简单模式只允许执行组成员", "PRESET_NOT_IN_MODE", { mode, group, presetKey: selectedPresetKey || undefined });
      }
      if (mode === "complex" && profile?.stageEnabled === false) {
        throw modeError("当前复杂自定义模式已关闭该阶段", "STAGE_DISABLED", { mode, group, presetKey: selectedPresetKey || undefined });
      }
    };
    const choosePreset = key => {
      selectedPresetKey = String(key || "");
      const selected = activePresets[selectedPresetKey];
      if (!selected) throw modeError("成员预设不可用", "UNKNOWN_PRESET", { presetKey: selectedPresetKey });
      if (curator && selected.group !== "curator") throw modeError("请选择规范维护组成员", "PRESET_NOT_IN_MODE");
      if (curator || mode === "relay" || mode === "complex") {
        assertModeGroup();
        if (!enabledKeys.includes(selectedPresetKey)) {
          if (allowDisabledPreset === true && presetKey === selectedPresetKey) {
            temporaryOverride = true;
            return;
          }
          throw modeError("成员未被当前模式勾选", "PRESET_NOT_IN_MODE", {
            mode,
            group: selected.group,
            presetKey: selectedPresetKey,
            enabledKeys,
          });
        }
      }
    };

    if (selectedPresetKey) {
      // Strict field validation runs before mode-roster validation so deleted, unknown, and conflicting routes keep their contracts.
      assertPresetStrictFields(selectedPresetKey, activePresets, catalog, { deletedPresets, orchestrationMode: mode, executionIntent }, target, modelSelection, {
        provider,
        model,
        effort,
        permissionMode: permissionMode ?? runtimeMode,
        interactionMode,
      });
      if (!activePresets[selectedPresetKey]) {
        if (deletedPresets.map(String).includes(selectedPresetKey)) throw modeError(`角色预设已删除：${selectedPresetKey}`, "PRESET_DELETED", { presetKey: selectedPresetKey });
        throw modeError(`未知角色预设：${selectedPresetKey}`, "UNKNOWN_PRESET", { presetKey: selectedPresetKey });
      }
      choosePreset(selectedPresetKey);
    } else if (curator || mode === "relay" || mode === "complex") {
      assertModeGroup();
      if (explicitTarget) {
        const explicitProvider = normalizeProviderId(mergedTarget.provider || "");
        const explicitModel = String(mergedTarget.model || "").trim();
        const canonical = value => String(value || "").trim().toLowerCase();
        const matches = enabledKeys.filter(key => {
          const candidate = activePresets[key];
          if (!candidate) return false;
          if (explicitProvider && normalizeProviderId(candidate.provider) !== explicitProvider) return false;
          return !explicitModel || canonical(candidate.model) === canonical(explicitModel);
        });
        if (!matches.length) {
          throw modeError("裸 provider/model 未匹配当前模式已勾选成员", "PRESET_NOT_IN_MODE", { mode, group, enabledKeys });
        }
        // 裸 provider/model 只做当前模式勾选池校验，保持显式路由语义与成员身份，
        // 不能把它改写成某个 presetKey，否则会破坏跨引擎复用和路由审计。
      } else {
        if (!enabledKeys.length) {
          throw modeError(mode === "relay" && group === "executor" ? "当前执行组没有可用成员" : "当前成员组没有可用成员",
            curator ? "CURATOR_ROSTER_EMPTY" : mode === "relay" && group === "executor" ? "EXECUTOR_ROSTER_EMPTY" : "MEMBER_POOL_EMPTY", { mode, group, enabledKeys });
        }
        choosePreset(profile.preferredKey || enabledKeys[0]);
      }
    }

    const resolved = resolveRoleTarget({
      catalog,
      role: curator ? "curator" : role,
      presetKey: selectedPresetKey || undefined,
      target: mergedTarget,
      presets: activePresets,
      deletedPresets,
      modeProfiles,
      customProviders,
      orchestrationMode: mode,
      executionIntent,
    });
    if (temporaryOverride) resolved.routing.temporaryOverride = true;
    if (!presetKey && !explicitTarget && mode) resolved.routing.selectionSource = "role_default";
    return resolved;
  }

  function resolveCuratorTarget(params = {}) {
    return resolveEffectiveTarget({ ...params, role: "curator" });
  }

  async function ensureInitialRoster({ catalog, binaries } = {}) {
    if (ctx.updates.isUpdating()) return;
    const canSeed = settings => settings.rosterSeeded === false && (settings.presetRevision || 0) === 0;
    const initial = ctx.db.getSettings();
    if (initial.rosterMigrationPending) ctx.db.saveSettings({});
    if (ctx.catalogLoader.name === "offlineCatalog" || !canSeed(initial)) return;
    if (ctx.flags.initialRosterLoad) return ctx.flags.initialRosterLoad;
    const pending = (async () => {
      const [loaded, probed] = await Promise.all([catalog ?? ensureCatalog(), binaries ?? ctx.engineManager.probeBinaries()]);
      const current = ctx.db.getSettings();
      if (ctx.updates.isUpdating() || !canSeed(current)) return;
      const roster = buildInitialRosterFromProbe({
        binaries: probed,
        catalog: loaded,
        hostBridgeAvailable: Boolean(ctx.engineManager.getHostContext?.()?.hostBridgeAvailable),
        customProviders: current.customProviders,
      });
      try {
        ctx.db.saveSettings({ ...roster, expectedPresetRevision: 0, rosterSeeded: true });
      } catch (error) {
        if (error?.code !== "PRESET_REVISION_CONFLICT") throw error;
      }
    })();
    ctx.flags.initialRosterLoad = pending;
    try { await pending; } finally { ctx.flags.initialRosterLoad = undefined; }
  }

  async function getCapabilities({ search, refresh = false, ...params } = {}) {
    const [catalog, binaries] = await Promise.all([
      ensureCatalog({ refresh }),
      ctx.engineManager.probeBinaries(),
    ]);
    await ensureInitialRoster({ catalog, binaries });
    const rawSettings = ctx.db.getSettings();
    const workspace = await ctx.scopePolicy.resolveConfigWorkspace(params);
    const config = configPayload(workspace, rawSettings);

    let providers = catalog.providers;
    if (search && String(search).trim()) {
      const q = String(search).trim().toLowerCase();
      providers = providers
        .map((p) => ({
          ...p,
          models: (p.models || []).filter(
            (m) =>
              p.id.toLowerCase().includes(q) ||
              String(m.id || "").toLowerCase().includes(q) ||
              String(m.name || "").toLowerCase().includes(q) ||
              String(m.description || "").toLowerCase().includes(q)
          ),
        }))
        .filter((p) => p.id.toLowerCase().includes(q) || p.models.length > 0);
    }

    const extensionTemplates = enrichExtensionTemplates(
      catalog.extensionTemplates ||
        listExtensionTemplates({ customProviders: rawSettings.customProviders })
    );

    return {
      version: VERSION,
      studioUrl: ctx.flags.currentStudioUrl,
      providers,
      extensionTemplates,
      ...config,
      customProviders: config.settings.customProviders,
      binaries,
      activeMode: ctx.scopePolicy.getActiveModeSummary({ ...params, workspace }),
    };
  }

  async function saveSettings(patch = {}) {
    const safePatch = { ...(patch || {}) };
    delete safePatch._extensionEnvVault;
    delete safePatch.rosterSeeded;

    if (safePatch.customProviders !== undefined) {
      safePatch.customProviders = normalizeCustomProvidersList(safePatch.customProviders).map(
        sanitizeCustomProviderForPublic
      );
    }

    const rawWorkspace = safePatch.cwd || safePatch.workspace || "";
    const scope = settingsWriteScope(safePatch, rawWorkspace);
    const needsExplicitRoot = scope === "project" || Boolean(safePatch.action);
    let workspace = "";
    if (needsExplicitRoot) {
      const explicit = ctx.scopePolicy.explicitExecutionRoot(safePatch);
      if (safePatch.action && !explicit) throw Object.assign(new Error("需要提供有效的项目目录"), { code: "CWD_REJECTED" });
      workspace = await ctx.scopePolicy.resolveConfigWorkspace(safePatch);
    } else {
      const hasRawWorkspace = safePatch.workspace !== undefined || safePatch.cwd !== undefined;
      const validExplicit = hasRawWorkspace ? ctx.scopePolicy.normalizeHostWorkspace(safePatch.workspace || safePatch.cwd) : "";
      if (!hasRawWorkspace || validExplicit) {
        try {
          workspace = await ctx.scopePolicy.resolveConfigWorkspace(hasRawWorkspace ? { ...safePatch, workspace: validExplicit, cwd: undefined } : safePatch);
        } catch {
          workspace = "";
        }
      }
    }
    let updatedRaw;
    const saveMeta = {};
    try {
      updatedRaw = ctx.db.saveSettings({
        ...safePatch,
        scope,
        workspace: needsExplicitRoot ? workspace : undefined,
        cwd: undefined,
      }, saveMeta);
    } catch (error) {
      if (error.code === "PRESET_REVISION_CONFLICT") error.details.settings = toPublicSettings(error.details.settings);
      throw error;
    }
    const catalogChanged = safePatch.customProviders !== undefined;
    if (catalogChanged) ctx.flags.catalogLoad = ctx.flags.cachedCatalog = null;
    if (safePatch.autoCheckUpdates !== undefined) ctx.updates.schedule();

    const config = configPayload(workspace, updatedRaw);
    const eventConfig = scope === "project" ? config : configPayload("", updatedRaw);
    const catalog = await ensureCatalog({ refresh: catalogChanged, skipExtensionProbe: true });
    const extensionTemplates = enrichExtensionTemplates(
      catalog.extensionTemplates ||
        listExtensionTemplates({ customProviders: updatedRaw.customProviders })
    );

    ctx.context.emitEvent({

      type: scope === "project" ? "project_config_updated" : "settings_updated",
      scope,
      ...(scope === "project" ? { workspace } : {}),
      ...eventConfig,
      customProviders: eventConfig.settings.customProviders,
      extensionTemplates,
    });
    for (const frozenWorkspace of saveMeta.frozenWorkspaces || []) {
      const frozenConfig = configPayload(frozenWorkspace, updatedRaw);
      ctx.context.emitEvent({
        type: "project_config_updated",
        scope: "project",
        workspace: frozenWorkspace,
        ...frozenConfig,
        customProviders: frozenConfig.settings.customProviders,
        extensionTemplates,
      });
    }
    return {
      ok: true,
      ...config,
      activeMode: ctx.scopePolicy.getActiveModeSummary({ ...patch, workspace: workspace || undefined, cwd: undefined }),
      providers: catalog.providers,
      customProviders: config.settings.customProviders,
      extensionTemplates,
    };
  }

  async function listExtensionProviders() {
    const rawSettings = ctx.db.getSettings();
    const customProviders = normalizeCustomProvidersList(rawSettings.customProviders).map(
      sanitizeCustomProviderForPublic
    );
    const templates = enrichExtensionTemplates(
      listExtensionTemplates({ customProviders: rawSettings.customProviders })
    );
    return {
      templates,
      extensionTemplates: templates,
      customProviders,
    };
  }

  function probeBinaryFingerprint(id, protocol, command, extraCandidatePaths) {
    const found = detectExtensionBinary(id, command, extraCandidatePaths, protocol);
    if (!found.binaryPath) return "missing";
    try {
      const file = /\.(?:bat|cmd)$/i.test(found.binaryPath)
        ? resolveExternalCommand(found.binaryPath).resolvedPath : found.binaryPath;
      const st = statSync(file);
      return `${file}:${st.mtimeMs}:${st.size}`;
    } catch {
      return `${found.binaryPath}:unknown`;
    }
  }

  function invalidateProbeCache(targetId) {
    const norm = normalizeProviderId(targetId).toLowerCase();
    for (const [key, entry] of probeCache.entries()) {
      if (entry.id === norm) probeCache.delete(key);
    }
  }

  async function probeExtensionProvider(params = {}) {
    const rawId = String(params.id || "probe-agent").trim();
    const id = normalizeProviderId(rawId) || rawId;
    const rawSettings = ctx.db.getSettings();
    const tpl = findTemplate(id);
    const savedRuntime = getRuntimeProviderConfig(id, rawSettings);
    const rawProto = String(
      params.protocol ||
        (params.driverKind === "zcode" ? "zcode" : params.driverKind === "generic-cli" ? "cli" : savedRuntime?.protocol || tpl?.protocol || "acp")
    ).trim().toLowerCase();
    const protocol = rawProto === "zcode" ? "zcode" : rawProto === "cli" ? "cli" : "acp";
    const driverKind = protocol === "zcode" ? "zcode" : protocol === "cli" ? "generic-cli" : "generic-acp";
    const command = String(params.command || savedRuntime?.command || tpl?.command || "").trim();
    if (!command) {
      throw new Error("probeExtensionProvider 需要提供可执行命令 (command)");
    }

    const savedVaultEnv =
      rawSettings?._extensionEnvVault && typeof rawSettings._extensionEnvVault[id] === "object"
        ? rawSettings._extensionEnvVault[id]
        : rawSettings?._extensionEnvVault && typeof rawSettings._extensionEnvVault[rawId] === "object"
          ? rawSettings._extensionEnvVault[rawId]
          : {};
    const incomingEnv = params.env && typeof params.env === "object" ? params.env : {};
    const mergedEnv = { ...savedVaultEnv, ...incomingEnv };
    const rawEnvPolicy = String(params.envPolicy || "").trim().toLowerCase();
    const envPolicy = rawEnvPolicy === "minimal" || rawEnvPolicy === "inherit"
      ? rawEnvPolicy
      : savedRuntime?.envPolicy || tpl?.envPolicy || "inherit";
    const credentialEnvKeys = Array.isArray(params.credentialEnvKeys)
      ? params.credentialEnvKeys.map(String).filter(Boolean)
      : savedRuntime?.credentialEnvKeys || [...(tpl?.credentialEnvKeys || [])];
    const extraCandidatePaths = getExtensionCandidatePaths(
      tpl?.id || id,
      Array.isArray(params.extraCandidatePaths)
        ? params.extraCandidatePaths
        : savedRuntime?.extraCandidatePaths || tpl?.extraCandidatePaths || []
    );
    const cwd = ctx.scopePolicy.executionRoot(params);
    const args = protocol === "cli"
      ? (Array.isArray(params.probeArgs) && params.probeArgs.length > 0
        ? params.probeArgs.map(String)
        : ["--version"])
      : (Array.isArray(params.args)
        ? params.args.map(String)
        : typeof params.args === "string" && params.args.trim()
          ? params.args.trim().split(/\s+/)
          : savedRuntime?.args?.length && savedRuntime.protocol === protocol
            ? [...savedRuntime.args]
            : tpl?.args?.length && tpl.protocol === protocol
              ? [...tpl.args]
              : protocol === "zcode"
                ? ["app-server", "--stdio"]
                : ["acp"]);

    const envFingerprint = createHash("sha256")
      .update(JSON.stringify([envPolicy, credentialEnvKeys, Object.entries(mergedEnv).sort(([a], [b]) => a.localeCompare(b))]))
      .digest("hex");
    const binaryMtimeSize = probeBinaryFingerprint(id, protocol, command, extraCandidatePaths);
    const cacheKey = JSON.stringify([id.toLowerCase(), protocol, command, cwd, args, envFingerprint, binaryMtimeSize]);
    if (params.force !== true && probeCache.has(cacheKey)) {
      return { ...await probeCache.get(cacheKey).result, cached: true };
    }

    const result = ctx.engineManager.probeExtensionProvider({
      id,
      templateId: tpl?.id || id,
      protocol,
      driverKind,
      command,
      args,
      probeArgs: protocol === "cli" ? args : undefined,
      argsTemplate: params.argsTemplate,
      env: mergedEnv,
      envPolicy,
      credentialEnvKeys,
      extraCandidatePaths,
      cwd,
      timeoutMs: Number(params.timeoutMs) || (protocol === "cli" ? 5000 : 12000),
    }).then(res => ({
      ...res,
      id,
      binaryPath: maskHomePrefix(res?.binaryPath),
      protocol: res?.protocol || protocol,
      ...(res?.ok ? { ephemeralSupport: res.capabilities?.sessionCapabilities?.delete ? "delete" : "close-only" } : {}),
      reachable: Boolean(res?.ok),
      available: Boolean(res?.ok),
      models: Array.isArray(res?.models) && res.models.length > 0
        ? res.models
        : protocol === "cli"
          ? tpl?.defaultModels || []
          : Array.isArray(res?.models)
            ? res.models
            : [],
    }));
    probeCache.delete(cacheKey);
    probeCache.set(cacheKey, { id: id.toLowerCase(), result });
    if (probeCache.size > 64) probeCache.delete(probeCache.keys().next().value);
    try {
      const normalized = await result;
      if (!normalized.ok && probeCache.get(cacheKey)?.result === result) probeCache.delete(cacheKey);
      return normalized;
    } catch (err) {
      if (probeCache.get(cacheKey)?.result === result) probeCache.delete(cacheKey);
      throw err;
    }
  }

  async function saveExtensionProvider(config = {}) {
    const rawId = String(config.id || config.provider || "").trim();
    const cleanId = rawId.replace(/[^a-zA-Z0-9._-]/g, "-").toLowerCase();
    if (!cleanId) {
      throw new Error("saveExtensionProvider 需要有效的平台标识 ID");
    }
    const coreReserved = new Set(["kimi-code", "codex", "antigravity", "claude-code"]);
    if (coreReserved.has(normalizeProviderId(cleanId))) {
      throw new Error(`"${cleanId}" 为内置核心引擎标识，请使用其他自定义 ID`);
    }

    const rawSettings = ctx.db.getSettings();
    const currentList = normalizeCustomProvidersList(rawSettings.customProviders);
    const prevEntry = currentList.find((c) => String(c.id || c.provider).toLowerCase() === cleanId);
    const command = String(config.command ?? prevEntry?.command ?? "").trim();
    if (!command) throw new Error("saveExtensionProvider 需要提供可执行命令 (command)");

    const nextVault = {
      ...(rawSettings._extensionEnvVault && typeof rawSettings._extensionEnvVault === "object"
        ? rawSettings._extensionEnvVault
        : {}),
    };

    let envKeys = Array.isArray(prevEntry?.envKeys) ? [...prevEntry.envKeys] : [];
    if (config.env && typeof config.env === "object" && Object.keys(config.env).length > 0) {
      const cleanEnv = {};
      for (const [k, v] of Object.entries(config.env)) {
        const keyTrim = String(k || "").trim();
        if (keyTrim && v !== undefined && v !== null && String(v) !== "") {
          cleanEnv[keyTrim] = String(v);
        }
      }
      nextVault[cleanId] = { ...(nextVault[cleanId] || {}), ...cleanEnv };
      envKeys = Object.keys(nextVault[cleanId]);
    } else if (config.clearEnv === true) {
      delete nextVault[cleanId];
      envKeys = [];
    }

    const sanitizedEntry = sanitizeCustomProviderForPublic({
      ...(prevEntry || {}),
      ...config,
      id: cleanId,
      env: undefined,
      envKeys,
      updatedAt: Date.now(),
    });

    const filtered = currentList
      .filter((c) => String(c.id || c.provider).toLowerCase() !== cleanId)
      .map(sanitizeCustomProviderForPublic);
    const nextCustomProviders = [...filtered, sanitizedEntry];

    const updatedRaw = ctx.db.saveSettings({
      customProviders: nextCustomProviders,
      _extensionEnvVault: nextVault,
    });
    ctx.flags.catalogLoad = ctx.flags.cachedCatalog = null;
    invalidateProbeCache(cleanId);

    const publicSettings = toPublicSettings(updatedRaw);
    const catalog = await ensureCatalog({ refresh: true, skipExtensionProbe: true });
    const extensionTemplates = enrichExtensionTemplates(
      catalog.extensionTemplates || listExtensionTemplates({ customProviders: nextCustomProviders })
    );

    ctx.context.emitEvent({
      type: "settings_updated",
      scope: "global",
      ...configPayload("", updatedRaw),
      presets: publicSettings.presets,
      customProviders: publicSettings.customProviders,
      extensionTemplates,
    });

    return {
      ok: true,
      provider: sanitizedEntry,
      customProviders: publicSettings.customProviders,
      templates: extensionTemplates,
      extensionTemplates,
      providers: catalog.providers,
    };
  }

  async function removeExtensionProvider(params = {}) {
    const targetId = String(params.id || params.providerId || "").trim().toLowerCase();
    if (!targetId) {
      throw new Error("removeExtensionProvider 需要提供平台 ID");
    }

    const rawSettings = ctx.db.getSettings();
    const nextCustomProviders = normalizeCustomProvidersList(rawSettings.customProviders)
      .filter((c) => String(c.id || c.provider).toLowerCase() !== targetId)
      .map(sanitizeCustomProviderForPublic);

    const nextVault = {
      ...(rawSettings._extensionEnvVault && typeof rawSettings._extensionEnvVault === "object"
        ? rawSettings._extensionEnvVault
        : {}),
    };
    delete nextVault[targetId];

    const updatedRaw = ctx.db.saveSettings({
      customProviders: nextCustomProviders,
      _extensionEnvVault: nextVault,
    });
    ctx.flags.catalogLoad = ctx.flags.cachedCatalog = null;
    invalidateProbeCache(targetId);

    const publicSettings = toPublicSettings(updatedRaw);
    const catalog = await ensureCatalog({ refresh: true, skipExtensionProbe: true });
    const extensionTemplates = enrichExtensionTemplates(
      catalog.extensionTemplates || listExtensionTemplates({ customProviders: nextCustomProviders })
    );

    ctx.context.emitEvent({
      type: "settings_updated",
      scope: "global",
      ...configPayload("", updatedRaw),
      presets: publicSettings.presets,
      customProviders: publicSettings.customProviders,
      extensionTemplates,
    });

    return {
      ok: true,
      removedId: targetId,
      customProviders: publicSettings.customProviders,
      templates: extensionTemplates,
      extensionTemplates,
      providers: catalog.providers,
    };
  }

  return {
    ensureCatalog,
    ensureInitialRoster,
    getCapabilities,
    getRuntimeCustomProvidersList,
    getRuntimeProviderConfig,
    listExtensionProviders,
    probeExtensionProvider,
    removeExtensionProvider,
    resolveCuratorTarget,
    resolveEffectiveTarget,
    saveExtensionProvider,
    saveSettings,
    toPublicSettings,
    configPayload,
  };
}

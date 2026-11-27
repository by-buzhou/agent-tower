import fs from "node:fs";
import path from "node:path";
import { tryAcquireFileLock } from "./daemon-client.mjs";
import {
  DEFAULT_ROLE_PRESETS,
  dispatchEnabledForMode,
  mergeActivePresets,
  normalizeMemberPool,
  normalizeModeProfiles,
  normalizeOrchestrationMode,
  validatePresetKey,
} from "./catalog.mjs";
import { MAIN_ROOT, nativePath, safeRoot, child, inside, atomicJson } from "./storage-paths.mjs";
import { hasActiveProjectSpecs, inspectSpecPath, normalizeSpecQuotaLimits, readOnlyGit } from "./spec-context.mjs";
import { normalizeProjectPath, projectPathKey } from "./orchestrator/helpers.mjs";

const keys = [
  "presets", "presetRevision", "customProviders", "_extensionEnvVault", "defaultStudioRoot", "knownProjects",
  "defaultMode", "defaultIsolation", "defaultDispatchEnabled", "defaultOrchestrationMode", "memberPool",
  "relayTargetPresetKey", "deletedPresets", "customPipelines", "modeProfiles", "rosterVersion", "rosterSeeded",
  "antigravityAcpMode", "specCurationByProject", "projectProfiles", "configSchemaVersion", "defaultSpecEnabled", "themeMode",
  "defaultExternalSessionVisible", "autoCheckUpdates",
];
function selected(data = {}) { return Object.fromEntries(keys.filter(k => data[k] !== undefined).map(k => [k, data[k]])); }
function migrateReviewer(presets) {
  const reviewer = presets?.reviewer;
  for (const key of ["permissionMode", "runtimeMode"]) if (reviewer?.[key] === "approval-required") delete reviewer[key];
}
function uniqueStrings(value) { return [...new Set((Array.isArray(value) ? value : []).map(String))]; }
function mergeModeProfilesPatch(current = {}, patch = {}) {
  const result = structuredClone(current && typeof current === "object" ? current : {});
  for (const [mode, modePatch] of Object.entries(patch || {})) {
    if (!modePatch || typeof modePatch !== "object") continue;
    result[mode] = { ...(result[mode] || {}) };
    for (const [group, groupPatch] of Object.entries(modePatch)) {
      if (!groupPatch || typeof groupPatch !== "object") continue;
      result[mode][group] = { ...(result[mode][group] || {}), ...structuredClone(groupPatch) };
    }
  }
  return result;
}
const rosterV2 = { rosterVersion: 2 };
const rosterFields = ["presets", "deletedPresets", "memberPool", "modeProfiles", "relayTargetPresetKey"];
const rosterPatchFields = ["presets", "rolePresets", "deletePresets", "resetPresets", "memberPool", "relayTargetPresetKey", "modeProfiles"];
const globalOnlyFields = ["defaultOrchestrationMode", "defaultDispatchEnabled", "defaultSpecEnabled", "customProviders", "customPipelines", "themeMode", "antigravityAcpMode", "defaultExternalSessionVisible", "autoCheckUpdates"];
const externalSessionModes = new Set(["inherit", "hidden", "visible"]);
function projectExternalSessions(settings, workspace) {
  const resolved = resolveProjectRootSync(workspace, settings.projectProfiles);
  const entry = settings.projectProfiles?.[projectPathKey(resolved)]?.externalSessions;
  return { mode: externalSessionModes.has(entry?.mode) ? entry.mode : "inherit", updatedAt: entry?.updatedAt || 0 };
}
const rosterValues = settings => Object.fromEntries(rosterFields.map(key => [key, settings[key]]));
const snapshot = (settings, rosterRevision) => structuredClone({ ...rosterValues(settings), rosterRevision, updatedAt: Date.now() });

export function resolveProjectRootSync(workspace, projectProfiles = null) {
  if (typeof workspace !== "string" || !workspace.trim()) return "";
  if (!path.isAbsolute(workspace)) return normalizeProjectPath(workspace);
  let dir = path.resolve(workspace);
  const linked = [...dir.matchAll(/[\\/]\.agent-tower[\\/]worktrees[\\/]/gi)].at(-1);
  if (linked && !/[\\/]\.agent-tower[\\/]test-runs(?:[\\/]|$)/i.test(dir.slice(linked.index))) {
    const stripped = dir.slice(0, linked.index);
    if (stripped) dir = stripped;
  }
  const profiles = projectProfiles && typeof projectProfiles === "object" ? projectProfiles : null;
  const start = normalizeProjectPath(dir);
  if (profiles && Object.hasOwn(profiles, projectPathKey(dir))) return start;
  const sandbox = process.env.AGENT_TOWER_TEST_ROOT ? path.resolve(process.env.AGENT_TOWER_TEST_ROOT) : "";
  const inSandbox = Boolean(sandbox && inside(sandbox, dir));
  let towerRoot = "";
  let cur = dir;
  while (true) {
    if (inSandbox && path.relative(sandbox, cur) === "") break;
    if (profiles && Object.hasOwn(profiles, projectPathKey(cur))) return normalizeProjectPath(cur);
    try {
      if (fs.existsSync(path.join(cur, ".git"))) return towerRoot || normalizeProjectPath(cur);
      if (!towerRoot && fs.existsSync(path.join(cur, ".agent-tower"))) towerRoot = normalizeProjectPath(cur);
    } catch { break; }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return towerRoot || start;
}

function projectRoster(settings, workspace) {
  const resolved = resolveProjectRootSync(workspace, settings.projectProfiles);
  const profile = settings.projectProfiles?.[projectPathKey(resolved)];
  const roster = profile?.roster;
  return roster ? { ...structuredClone(roster), source: "project", customized: true } : {
    ...structuredClone(rosterValues(settings)),
    rosterRevision: Math.max(profile?.rosterRevisionFloor || 0, settings.presetRevision || 0),
    source: "global_template", customized: false,
  };
}
function projectSpecEnabled(settings, workspace) {
  const resolved = resolveProjectRootSync(workspace, settings.projectProfiles);
  const key = projectPathKey(resolved);
  const enabled = settings.projectProfiles?.[key]?.spec?.enabled;
  if (typeof enabled === "boolean") return enabled;
  return Boolean(settings.specCurationByProject?.[key] || (resolved && hasActiveProjectSpecs(resolved)) || settings.defaultSpecEnabled);
}
function withRoster(settings, workspace) {
  const roster = projectRoster(settings, workspace);
  return { ...settings, ...rosterValues(roster), rolePresets: roster.presets, presetRevision: roster.rosterRevision };
}
function hasProjectDatabase(workspace) {
  try { return Boolean(inspectSpecPath(path.join(workspace, ".agent-tower/conversations/tower.sqlite"))?.isFile()); }
  catch { return false; }
}
function projectWorkspace(workspace, control) {
  const root = safeRoot(workspace, "", control);
  if (!root) return "";
  const common = (readOnlyGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]) || "").trim();
  const main = common && path.basename(common).toLowerCase() === ".git" ? path.dirname(common) : root;
  return normalizeProjectPath(safeRoot(main, root, control));
}
export function settingsWriteScope(patch, workspace) {
  const hasGlobalField = globalOnlyFields.some(key => patch[key] !== undefined);
  if (patch.scope === "project" && hasGlobalField) {
    throw Object.assign(new Error("项目级保存请求不能同时携带全局专属设置字段"), { code: "SETTINGS_SCOPE_CONFLICT" });
  }
  if (patch.action === "resetProjectToGlobal") return "project";
  if (patch.action === "syncProjectToGlobal" || patch.scope === "global" || hasGlobalField) return "global";
  return patch.scope === "project" || (workspace && rosterPatchFields.some(key => patch[key] !== undefined)) ? "project" : "global";
}

const legacyRosterFields = ["presets", "rolePresets", "deletedPresets", "modeProfiles", "presetRevision"];

function normalizeInitialData(raw = {}, fromDisk = false) {
  const data = selected(raw);
  const legacy = !(raw.rosterVersion >= 2);
  const legacyRoster = fromDisk || legacyRosterFields.some(key => Object.hasOwn(raw, key));
  const stored = structuredClone(raw.presets || raw.rolePresets || {});
  if (legacy) migrateReviewer(stored);
  data.deletedPresets = uniqueStrings(data.deletedPresets);
  data.configSchemaVersion = 3;
  data.defaultSpecEnabled = raw.defaultSpecEnabled === true;
  data.defaultExternalSessionVisible = raw.defaultExternalSessionVisible === true;
  data.autoCheckUpdates = raw.autoCheckUpdates !== false;
  data.projectProfiles = structuredClone(raw.projectProfiles || {});
  data.customPipelines = data.customPipelines && typeof data.customPipelines === "object" ? data.customPipelines : {};
  data.antigravityAcpMode = data.antigravityAcpMode === "api_key" ? "api_key" : "off";
  if (data.defaultOrchestrationMode !== undefined) data.defaultOrchestrationMode = normalizeOrchestrationMode(data.defaultOrchestrationMode, "direct", data.customPipelines);
  else data.defaultOrchestrationMode = data.defaultDispatchEnabled === true ? "relay" : "direct";
  data.defaultDispatchEnabled = dispatchEnabledForMode(data.defaultOrchestrationMode);

  const active = mergeActivePresets(stored, data.deletedPresets, legacy ? undefined : rosterV2);
  data.memberPool = normalizeMemberPool(data.memberPool, active);
  data.modeProfiles = normalizeModeProfiles(data.modeProfiles, active, {
    memberPool: data.memberPool,
    relayTargetPresetKey: data.relayTargetPresetKey,
  });
  data.presets = mergeActivePresets(active, data.deletedPresets, rosterV2);
  data.rosterVersion = legacy ? 2 : raw.rosterVersion;
  data.rosterSeeded = legacy ? legacyRoster : raw.rosterSeeded !== false;
  data.relayTargetPresetKey = data.modeProfiles.relay.executor.preferredKey;
  return data;
}

function migrateProjects(data, raw, control) {
  const legacySpec = new Map(Object.entries(raw.specCurationByProject || {}).map(([workspace, spec]) => [projectPathKey(workspace), spec]));
  for (const candidate of [...(raw.knownProjects || []), ...Object.keys(raw.specCurationByProject || {})]) {
    const workspace = projectWorkspace(candidate, control);
    if (!workspace) continue;
    const key = projectPathKey(workspace);
    const previous = data.projectProfiles[key] || {};
    const oldSpec = legacySpec.get(projectPathKey(candidate)) ?? legacySpec.get(key);
    const enabled = Boolean(oldSpec || hasActiveProjectSpecs(workspace));
    if (!enabled && !hasProjectDatabase(workspace)) continue;
    const spec = enabled ? {
      enabled: true, autoTrigger: oldSpec?.autoTrigger === true,
      ...normalizedQuotas(oldSpec), updatedAt: oldSpec?.updatedAt || Date.now(),
    } : undefined;
    data.projectProfiles[key] = { workspace, roster: snapshot(data, Math.max(1, raw.presetRevision || 1)), ...(spec ? { spec } : {}), ...previous };
  }
  delete data.specCurationByProject;
}
function normalizedQuotas(entry) {
  const { singleMaxKb, totalMaxKb } = normalizeSpecQuotaLimits(entry);
  return { singleMaxKb, totalMaxKb };
}
function conflictError(currentRevision, settings) {
  return Object.assign(new Error("预设配置已被其他窗口更新，请合并最新配置后重试"), { code: "PRESET_REVISION_CONFLICT", currentRevision, details: { currentRevision, settings } });
}
function policyConflict() { return Object.assign(new Error("编排模式与派发开关语义冲突"), { code: "ORCHESTRATION_POLICY_CONFLICT" }); }
export function globalSettings(control, specifiedRoot, writeJson = atomicJson, initialSettings = {}) {
  fs.mkdirSync(control, { recursive: true });
  const file = child(control, "global-settings.json");
  const statStamp = () => { try { const st = fs.statSync(file, { bigint: true }); return `${st.dev}:${st.ino}:${st.ctimeNs}:${st.mtimeNs}:${st.size}`; } catch { return ""; } };
  let diskStamp = statStamp();
  const exists = Boolean(diskStamp);
  const raw = exists ? JSON.parse(fs.readFileSync(file, "utf8")) : initialSettings;
  let data = normalizeInitialData(raw, exists);
  let configMigrationPending = exists && !(raw.configSchemaVersion >= 3);
  if (configMigrationPending) migrateProjects(data, raw, control);
  let rosterMigrationPending = exists && !(raw.rosterVersion >= 2);
  const root = safeRoot(specifiedRoot || process.env.AGENT_TOWER_DEFAULT_ROOT || data.defaultStudioRoot || MAIN_ROOT, nativePath(MAIN_ROOT), control);
  const persist = () => { try { writeJson(file, data); configMigrationPending = false; rosterMigrationPending = false; } finally { diskStamp = ""; } };
  const syncFromDisk = () => {
    const nextStamp = statStamp();
    if (!nextStamp || nextStamp === diskStamp) return;
    try {
      const stored = JSON.parse(fs.readFileSync(file, "utf8"));
      data = normalizeInitialData(stored, true);
      configMigrationPending = !(stored.configSchemaVersion >= 3);
      if (configMigrationPending) migrateProjects(data, stored, control);
      rosterMigrationPending = !(stored.rosterVersion >= 2);
      diskStamp = nextStamp;
    } catch {}
  };
  const read = (workspace) => {
    syncFromDisk();
    const activePresets = structuredClone(data.presets);
    const settings = {
      defaultMode: "async", defaultIsolation: "shared", presetRevision: 0, customProviders: [], antigravityAcpMode: "off",
      ...structuredClone(data),
      ...(rosterMigrationPending ? { rosterMigrationPending: true } : {}),
      defaultOrchestrationMode: normalizeOrchestrationMode(data.defaultOrchestrationMode, "direct", data.customPipelines),
      defaultDispatchEnabled: dispatchEnabledForMode(data.defaultOrchestrationMode),
      deletedPresets: uniqueStrings(data.deletedPresets),
      memberPool: normalizeMemberPool(data.memberPool, activePresets),
      modeProfiles: normalizeModeProfiles(data.modeProfiles, activePresets, { memberPool: data.memberPool, relayTargetPresetKey: data.relayTargetPresetKey }),
      presets: activePresets,
      rolePresets: activePresets,
    };
    return workspace ? withRoster(settings, workspace) : settings;
  };
  const lockPath = child(control, "global-settings.lock");
  const waitWord = new Int32Array(new SharedArrayBuffer(4));
  function update(change) {
    const deadline = Date.now() + 5000;
    while (!tryAcquireFileLock(lockPath)) { if (Date.now() >= deadline) throw Error("等待全局设置写入超时"); Atomics.wait(waitWord, 0, 0, 10); }
    try {
      syncFromDisk();
      const previous = structuredClone(data);
      try {
        if (change() !== false || configMigrationPending) persist();
      } catch (error) {
        data = previous;
        throw error;
      }
      return read();
    } finally { try { fs.unlinkSync(lockPath); } catch {} }
  }
  // Merely starting a daemon must leave the previous mount intact during stage-only publishing.
  if (!exists || data.defaultStudioRoot !== root || !data.knownProjects?.includes(root)) update(() => { data = { ...data, defaultStudioRoot: root, knownProjects: [...new Set([root, ...(data.knownProjects || [])])] }; });
  function setProjectProfile(workspace, change) {
    const key = projectPathKey(workspace);
    data.projectProfiles[key] = { ...data.projectProfiles[key], workspace: normalizeProjectPath(workspace), ...change };
  }
  function setExternalSessionMode(workspace, mode) {
    if (!externalSessionModes.has(mode)) {
      throw Object.assign(new Error("外部会话模式须为 inherit、hidden 或 visible"), { code: "INVALID_EXTERNAL_SESSION_MODE" });
    }
    setProjectProfile(workspace, { externalSessions: { mode, updatedAt: Date.now() } });
  }
  function setSpec(workspace, patch) {
    const key = projectPathKey(workspace);
    const previous = data.projectProfiles[key]?.spec || data.specCurationByProject?.[key] || {};
    const enabled = patch.enabled ?? projectSpecEnabled(data, workspace);
    setProjectProfile(workspace, { spec: {
      ...normalizedQuotas(previous), autoTrigger: previous.autoTrigger === true, ...patch,
      enabled, ...(!enabled ? { autoTrigger: false } : {}), updatedAt: Date.now(),
    } });
  }
  return {
    root,
    read,
    getProjectRoster(workspace, settings = read()) { return projectRoster(settings, workspace); },
    getProjectExternalSessions(workspace, settings = read()) { return projectExternalSessions(settings, workspace); },
    isProjectExternalSessionVisible(workspace, settings = read()) {
      const { mode } = projectExternalSessions(settings, workspace);
      return mode === "inherit" ? settings.defaultExternalSessionVisible === true : mode === "visible";
    },
    setProjectExternalSessionMode(workspace, mode) {
      const resolved = projectWorkspace(workspace, control);
      if (!resolved) throw Object.assign(new Error("需要提供有效的项目目录"), { code: "CWD_REJECTED" });
      return update(() => setExternalSessionMode(resolved, mode));
    },
    isProjectSpecEnabled(workspace, settings = read()) { return projectSpecEnabled(settings, workspace); },
    getProjectSpec(workspace) {
      const settings = read();
      const resolved = resolveProjectRootSync(workspace, settings.projectProfiles);
      const key = projectPathKey(resolved);
      const entry = settings.projectProfiles[key]?.spec || settings.specCurationByProject?.[key];
      const enabled = projectSpecEnabled(settings, resolved);
      return { ...normalizedQuotas(entry), enabled, autoTrigger: enabled && entry?.autoTrigger === true };
    },
    setProjectSpecEnabled(workspace, enabled) { return update(() => setSpec(workspace, { enabled })); },
    setSpecCurationAuto(workspace, autoTrigger) {
      return update(() => {
        if (autoTrigger && !projectRoster(data, workspace).modeProfiles.complex.curator.enabledKeys.length) {
          throw Object.assign(new Error("请先启用至少一名规范维护官"), { code: "CURATOR_ROSTER_EMPTY" });
        }
        setSpec(workspace, { autoTrigger });
      });
    },
    setSpecCurationLimits(workspace, { singleMaxKb, totalMaxKb } = {}) {
      if (!Number.isInteger(singleMaxKb) || singleMaxKb < 1 || singleMaxKb > 8) {
        throw Object.assign(new Error("单篇规范上限需为 1～8 KB 的整数"), { code: "INVALID_SPEC_LIMITS" });
      }
      if (!Number.isInteger(totalMaxKb) || totalMaxKb < 8 || totalMaxKb > 128) {
        throw Object.assign(new Error("项目规范总上限需为 8～128 KB 的整数"), { code: "INVALID_SPEC_LIMITS" });
      }
      if (totalMaxKb < singleMaxKb * 2) {
        throw Object.assign(new Error(`项目规范总上限（${totalMaxKb} KB）至少需为单篇上限（${singleMaxKb} KB）的 2 倍`), { code: "INVALID_SPEC_LIMITS" });
      }
      return update(() => setSpec(workspace, { singleMaxKb, totalMaxKb }));
    },
    remember(p) { syncFromDisk(); if (!data.knownProjects?.includes(p)) update(() => { data.knownProjects = [...new Set([...(data.knownProjects || []), p])]; }); },
    save(patch = {}, meta = null) {
      const workspace = patch.workspace || patch.cwd;
      const scope = settingsWriteScope(patch, workspace);
      const key = projectPathKey(workspace);
      if ((scope === "project" || patch.action) && !workspace) {
        throw Object.assign(new Error("需要提供有效的项目目录"), { code: "CWD_REJECTED" });
      }
      return update(() => {
        const current = read(scope === "project" || patch.action ? workspace : undefined);
        if (patch.action === "syncProjectToGlobal") {
          const frozenWorkspaces = [];
          for (const candidate of data.knownProjects || []) {
            const other = projectWorkspace(candidate, control);
            const otherKey = projectPathKey(other);
            if (!other || otherKey === key || data.projectProfiles[otherKey]?.roster || !hasProjectDatabase(other)) continue;
            const otherRev = Math.max(data.projectProfiles[otherKey]?.rosterRevisionFloor || 0, data.presetRevision || 0);
            setProjectProfile(other, { roster: snapshot(data, otherRev) });
            frozenWorkspaces.push(other);
          }
          if (meta && typeof meta === "object") meta.frozenWorkspaces = frozenWorkspaces;
          data = { ...data, ...rosterValues(projectRoster(data, workspace)), rosterSeeded: true, presetRevision: (data.presetRevision || 0) + 1 };
          return;
        }
        if (patch.action === "resetProjectToGlobal") {
          const prevProfile = data.projectProfiles[key];
          const prevRoster = prevProfile?.roster;
          const revision = Math.max((prevRoster?.rosterRevision || prevProfile?.rosterRevisionFloor || 0) + 1, data.presetRevision || 1);
          const nextProfile = { ...prevProfile, workspace: normalizeProjectPath(workspace), rosterRevisionFloor: revision };
          delete nextProfile.roster;
          data.projectProfiles[key] = nextProfile;
          return;
        }
        const expected = patch.expectedPresetRevision;
        if (expected !== undefined && expected !== null && (!Number.isInteger(expected) || expected !== current.presetRevision)) throw conflictError(current.presetRevision, current);
        const relevant = [...rosterPatchFields, "customPipelines"];
        const changedPresetConfig = relevant.some(k => patch[k] !== undefined);
        const seeding = patch.rosterSeeded === true;
        if (seeding && (data.rosterSeeded || (data.presetRevision || 0) !== 0)) return;
        const changesExternalSessions = scope === "project" && patch.projectExternalSessionMode !== undefined;
        if (changesExternalSessions) setExternalSessionMode(workspace, patch.projectExternalSessionMode);
        if (scope === "project" && !changedPresetConfig) return changesExternalSessions;
        const deleted = new Set(current.deletedPresets);
        const merged = seeding ? {} : structuredClone(current.presets);
        const incoming = patch.presets || patch.rolePresets;
        for (const [key, value] of Object.entries(incoming || {})) {
          if (!value || typeof value !== "object") continue;
          validatePresetKey(key);
          deleted.delete(key);
          Object.defineProperty(merged, key, {
            value: { ...(Object.hasOwn(merged, key) ? merged[key] : {}), ...structuredClone(value), key },
            enumerable: true, configurable: true, writable: true,
          });
        }
        for (const key of uniqueStrings(patch.deletePresets)) {
          validatePresetKey(key);
          delete merged[key];
          deleted.add(key);
        }
        for (const key of uniqueStrings(patch.resetPresets)) {
          if (Object.hasOwn(merged, key) && Object.hasOwn(DEFAULT_ROLE_PRESETS, key)) {
            merged[key] = structuredClone(DEFAULT_ROLE_PRESETS[key]);
          }
        }
        const activePresets = mergeActivePresets(merged, [...deleted], rosterV2);
        const memberPool = normalizeMemberPool({ ...current.memberPool, ...patch.memberPool }, activePresets);
        const customPipelines = patch.customPipelines === undefined ? data.customPipelines || {} : patch.customPipelines || {};
        const rawModeProfiles = seeding ? patch.modeProfiles : mergeModeProfilesPatch(current.modeProfiles, patch.modeProfiles);
        for (const mode of ["relay", "complex"]) {
          const executorPatch = patch.modeProfiles?.[mode]?.executor;
          if (!seeding && Array.isArray(executorPatch?.enabledKeys) && executorPatch.enabledKeys.length === 0 &&
              Object.values(activePresets).some(preset => preset.group === "executor")) {
            throw Object.assign(new Error("执行组至少需要保留 1 名启用成员"), { code: "EXECUTOR_ROSTER_EMPTY" });
          }
        }
        const modeProfiles = normalizeModeProfiles(rawModeProfiles, activePresets, {
          memberPool,
          relayTargetPresetKey: patch.relayTargetPresetKey ?? current.relayTargetPresetKey,
        });
        const roster = {
          presets: activePresets, deletedPresets: [...deleted].sort(), memberPool, modeProfiles,
          relayTargetPresetKey: modeProfiles.relay.executor.preferredKey,
        };
        if (scope === "project") {
          setProjectProfile(workspace, { roster: snapshot(roster, current.presetRevision + 1) });
          return;
        }
        let mode = data.defaultOrchestrationMode;
        const hasMode = patch.defaultOrchestrationMode !== undefined;
        const hasDispatch = patch.defaultDispatchEnabled !== undefined;
        if (hasMode) mode = normalizeOrchestrationMode(patch.defaultOrchestrationMode, "direct", customPipelines);
        if (hasDispatch && typeof patch.defaultDispatchEnabled !== "boolean") throw policyConflict();
        if (hasMode && hasDispatch && dispatchEnabledForMode(mode) !== patch.defaultDispatchEnabled) throw policyConflict();
        if (!hasMode && hasDispatch) mode = patch.defaultDispatchEnabled ? "relay" : "direct";
        const passthrough = selected(patch);
        for (const key of ["specCurationByProject", "projectProfiles", "configSchemaVersion"]) delete passthrough[key];
        if (patch.defaultSpecEnabled !== undefined) passthrough.defaultSpecEnabled = patch.defaultSpecEnabled === true;
        if (patch.defaultExternalSessionVisible !== undefined) passthrough.defaultExternalSessionVisible = patch.defaultExternalSessionVisible === true;
        if (patch.autoCheckUpdates !== undefined) passthrough.autoCheckUpdates = patch.autoCheckUpdates !== false;
        for (const key of [...relevant, "presetRevision", "deletedPresets", "rosterSeeded", "rosterVersion", "defaultOrchestrationMode", "defaultDispatchEnabled", "antigravityAcpMode"]) {
          delete passthrough[key];
        }
        const antigravityAcpMode = patch.antigravityAcpMode === undefined
          ? (data.antigravityAcpMode === "api_key" ? "api_key" : "off")
          : (patch.antigravityAcpMode === "api_key" ? "api_key" : "off");
        data = {
          ...data, ...passthrough,
          antigravityAcpMode,
          ...roster, customPipelines,
          rosterSeeded: data.rosterSeeded || changedPresetConfig || seeding,
          defaultOrchestrationMode: mode, defaultDispatchEnabled: dispatchEnabledForMode(mode),
          presetRevision: (data.presetRevision || 0) + (changedPresetConfig ? 1 : 0),
          defaultStudioRoot: root, knownProjects: data.knownProjects || [root],
        };
      });
    },
    migrate(raw) {
      return update(() => {
        if (data.rosterSeeded) return;
        const migrated = normalizeInitialData(raw, true);
        data = { ...data, ...rosterValues(migrated), presetRevision: migrated.presetRevision || 0, rosterSeeded: migrated.rosterSeeded };
      });
    },
  };
}

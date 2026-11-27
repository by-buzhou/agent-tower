/**
 * AgentTower Studio — 动态成员池草稿、远端合并、乐观并发与自动保存 (`ui/presets.js`)
 * 字段编辑版本号保护在途修改；持久化 presetRevision 为 bootstrap / SSE / RPC 回执排序，
 * 保存携带 expectedPresetRevision，遇 PRESET_REVISION_CONFLICT 按 presetKey 粒度重基合并后自动重试。
 */
import { normalizePermissionForProvider } from './permissions.js';
import { setText } from './dom-guards.js';
import { projectPathKey } from './format.js';
import { DEFAULT_MEMBER_POOL, MEMBER_DRAFT_KEY, MEMBER_GROUPS, MEMBER_GROUP_IDS, MODE_PROFILE_GROUPS, MODE_PROFILE_IDS, MODE_PROFILE_LABELS, PRESET_CREATE_FIELDS, PRESET_KEY_PATTERN, PRESET_ROUTE_FIELDS, RESERVED_PRESET_KEYS, applySpecCurationPayload, currentProjectConfig, currentProjectKey, currentProjectWorkspace, currentSpecCuration, isCuratorBlockedProvider, normalizeGlobalTemplate, normalizeProjectConfig, isPoolGroup, isStatusActive, normalizeClientModeProfiles, presetDisplayLabel, listPoolMembers, preferredGroupPreset, preferredModeMember, seedPreset, state } from './state.js';
import { scheduleRender } from './render.js';
import { checkAssetUpdate, describeRpcError, rpcCall, showToast } from './net.js';
import { normalizeProviderId } from './normalize.js';

/** 代码终审默认评审官：复杂阵容审核阶段的首选 ★ 优先，其次首个勾选评审成员，最后兜底评审组首个成员（组为空时 null）。 */
export function defaultReviewerPreset() {
  return preferredModeMember('complex', 'reviewer') || listPoolMembers('reviewer')[0] || null;
}

export function syncBoundDraftsWithPresets() {
  for (const t of state.threadsMap.values()) {
    if (!t || t.isNativeHost || !t.presetKey || isStatusActive(t.status)) continue;
    const cfg = state.presets[t.presetKey];
    if (!cfg) continue;
    const provider = normalizeProviderId(cfg.provider);
    const perm = normalizePermissionForProvider(provider, cfg.permissionMode || cfg.runtimeMode);
    t.provider = provider;
    t.model = cfg.model;
    t.effort = cfg.effort;
    t.permissionMode = perm;
    t.interactionMode = perm === 'plan' ? 'plan' : cfg.interactionMode || 'default';
  }
  const compKey = state.composer.presetKey;
  if (compKey && state.presets[compKey]) {
    const cfg = state.presets[compKey];
    const provider = normalizeProviderId(cfg.provider);
    const activeThread = state.selectedThreadId ? state.threadsMap.get(state.selectedThreadId) : null;
    state.composer.provider = provider;
    state.composer.model = cfg.model;
    state.composer.effort = cfg.effort;
    if (!activeThread?.isNativeHost) {
      const perm = normalizePermissionForProvider(provider, cfg.permissionMode || cfg.runtimeMode);
      state.composer.permissionMode = perm;
      state.composer.interactionMode = perm === 'plan' ? 'plan' : cfg.interactionMode || 'default';
    }
    if (!activeThread && !state.composer.isolationCustomized) {
      state.composer.isolation = cfg.isolation || 'shared';
    }
  }
  if (!state.dispatchPresetDetached && state.selectedPresetChip && state.presets[state.selectedPresetChip]) {
    const cfg = state.presets[state.selectedPresetChip];
    const provider = normalizeProviderId(cfg.provider);
    const isoSelect = document.getElementById('disp-isolation');
    if (isoSelect && !state.dispatchSelection.isolationCustomized) isoSelect.value = cfg.isolation || 'shared';
    state.dispatchSelection.provider = provider;
    state.dispatchSelection.model = cfg.model;
    state.dispatchSelection.effort = cfg.effort;
    state.dispatchSelection.permissionMode = normalizePermissionForProvider(provider, cfg.permissionMode || cfg.runtimeMode);
  }
  if (Array.isArray(state.batchDrafts)) {
    for (const row of state.batchDrafts) {
      if (!row?.presetKey || !state.presets[row.presetKey]) continue;
      const cfg = state.presets[row.presetKey];
      const custom = row.customizedFields || {};
      const provider = custom.provider ? normalizeProviderId(row.provider) : normalizeProviderId(cfg.provider);
      row.provider = provider;
      if (!custom.model) row.model = cfg.model;
      if (!custom.effort) row.effort = cfg.effort;
      if (!custom.isolation) row.isolation = cfg.isolation || 'shared';
      if (!custom.permissionMode) {
        row.permissionMode = normalizePermissionForProvider(provider, cfg.permissionMode || cfg.runtimeMode);
        row.interactionMode = row.permissionMode === 'plan' ? 'plan' : cfg.interactionMode || 'default';
      }
    }
  }
  const rev = defaultReviewerPreset();
  if (!state.reviewDraftCustomized && rev && state.reviewDraft) {
    state.reviewDraft.presetKey = rev.key;
    if (state.reviewDraft.reviewMode !== 'read_only' || normalizeProviderId(rev.provider) === 'codex') {
      state.reviewDraft.provider = normalizeProviderId(rev.provider);
      state.reviewDraft.model = rev.model || 'gpt-6.2-astra';
    }
    state.reviewDraft.effort = rev.effort || 'xhigh';
  }
}

/* ---------- 新增成员：草稿基线与键名生成（v0.2.2 全成员平权，不再加 custom_ 前缀） ---------- */
/** 成员组 → 默认职能 role（新增草稿 / 切换草稿所属组共用）。 */
export function roleForMemberGroup(group) {
  return group === 'reviewer' ? 'review' : group === 'advisor' ? 'design' : group === 'curator' ? 'curator' : 'implementation';
}
/**
 * v0.2.11 规范维护组只读硬锁：引擎排除宿主原生（回落 codex）、权限跟随引擎锁定 read-only（Codex）/ plan（其余外部引擎）、
 * Plan 交互、共享目录；返回被修正的字段名（服务端在启动 / 排队 / 续聊全链路同样强制锁定，前端仅做一致展示）。
 */
export function applyCuratorLocks(preset) {
  if (!preset) return [];
  const before = { provider: preset.provider, model: preset.model, permissionMode: preset.permissionMode, interactionMode: preset.interactionMode, isolation: preset.isolation };
  if (isCuratorBlockedProvider(preset.provider)) { preset.provider = 'codex'; preset.model = ''; }
  preset.permissionMode = normalizePermissionForProvider(preset.provider, 'read-only');
  preset.interactionMode = 'plan';
  preset.isolation = 'shared';
  if (Object.hasOwn(preset, 'runtimeMode')) preset.runtimeMode = preset.permissionMode;
  return Object.keys(before).filter((f) => before[f] !== preset[f]);
}
export function newCustomPresetBase(group, key = MEMBER_DRAFT_KEY, scope = 'project') {
  const groupMeta = MEMBER_GROUPS.find((g) => g.id === group) || MEMBER_GROUPS[1];
  const tpl = (scope === 'global' ? listPoolMembers(groupMeta.id, 'global')[0] : (preferredGroupPreset(groupMeta.id) || listPoolMembers(groupMeta.id)[0])) || seedPreset(groupMeta.keys[0]) || {};
  const base = {
    key, label: '', title: '', group: groupMeta.id,
    role: roleForMemberGroup(groupMeta.id),
    enabled: true, builtin: false,
    provider: normalizeProviderId(tpl.provider || 'codex'), model: tpl.model || '', effort: tpl.effort || 'high',
    permissionMode: tpl.permissionMode || 'default', interactionMode: tpl.interactionMode || 'default', isolation: 'shared', description: '',
  };
  if (groupMeta.id === 'curator') applyCuratorLocks(base);
  return base;
}
/** 成员键校验：3~64 位、匹配 PRESET_KEY_PATTERN，且不是系统保留词。 */
export function isValidCustomPresetKey(key) {
  const value = String(key || '');
  return value.length >= 3 && value.length <= 64 && PRESET_KEY_PATTERN.test(value) && !RESERVED_PRESET_KEYS.has(value);
}
export const isValidPresetKey = isValidCustomPresetKey;
/**
 * 显示名 + 组名 → 语义化成员键：ASCII 标签 "Argon" @ advisor → advisor_argon（标签已含组前缀不重复拼）；
 * 含中文等非 ASCII 字符的标签回落 <group>_member_N；自动避开当前成员池已有键。group 缺省取「+ 添加」草稿所属组。
 */
export function suggestCustomPresetKey(label, group, scope = 'project') {
  const presets = scope === 'global' ? state.globalPresets : state.presets;
  const resolvedGroup = group !== undefined ? group : presets[MEMBER_DRAFT_KEY]?.group;
  const prefix = isPoolGroup(resolvedGroup) ? resolvedGroup : 'executor';
  const raw = String(label || '').trim();
  // 仅纯 ASCII 标签转语义 slug；含中文等非 ASCII 字符（如「军师D」）一律回落 <group>_member_N，避免截出残缺键名
  const slug = /^[\x20-\x7e]*$/.test(raw) ? raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48).replace(/_+$/, '') : '';
  // 已删除键允许同名重建（后端会自动移除墓碑），只需避开当前成员池
  const taken = (k) => Boolean(presets[k]);
  const fallback = `${prefix}_member`;
  let base = !slug ? fallback : slug === prefix || slug.startsWith(`${prefix}_`) ? slug : `${prefix}_${slug}`;
  if (!isValidCustomPresetKey(base)) base = fallback;
  if (base !== fallback && !taken(base)) return base;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${base.slice(0, 64 - String(n).length - 1)}_${n}`;
    if (!taken(candidate) && isValidCustomPresetKey(candidate)) return candidate;
  }
  return `${prefix}_m${Date.now().toString(36)}`;
}

/* ---------- 草稿持久化（sessionStorage，Webview 受限时静默跳过）；v0.3.0 键名附带项目键，跨项目草稿互不串台 ---------- */
function presetDraftKey(projectKey = state.presetEditTarget?.projectKey ?? currentProjectKey()) {
  const base = 'at-preset-field-drafts:' + location.pathname;
  return projectKey ? `${base}|${projectKey}` : base;
}
/** 首次编辑时捕获保存目标（有工作区 → 按项目保存；无工作区 → 回退全局，兼容纯独立无工作区场景）。 */
function capturePresetEditTarget() {
  if (state.presetEditTarget) return state.presetEditTarget;
  const workspace = currentProjectWorkspace();
  state.presetEditTarget = { workspace, projectKey: workspace ? currentProjectKey() || projectPathKey(workspace) : '' };
  return state.presetEditTarget;
}
function dirtyPatch(key) {
  const preset = state.presets[key];
  const fields = state.dirtyPresets.get(key);
  if (!preset || !fields) return {};
  return Object.fromEntries([...fields.keys()].map(field => [field, preset[field]]));
}
/* ---------- v0.1.1 分模式阵容 modeProfiles：键为 "mode.group"，值为编辑版本号 ---------- */
function splitProfileKey(id) {
  const [mode, group] = String(id).split('.');
  return MODE_PROFILE_GROUPS[mode]?.includes(group) ? [mode, group] : null;
}
function modeProfilesPatch(ids) {
  const out = {};
  for (const id of ids) {
    const parts = splitProfileKey(id);
    if (!parts) continue;
    const [mode, group] = parts;
    (out[mode] ||= {})[group] = structuredClone(state.modeProfiles[mode][group]);
  }
  return out;
}
/** 以当前成员池重新归一化阵容（剔除已删除 / 跨组的键、修复 ★、执行组至少 1 名）；返回被修正的 "mode.group"。 */
function renormalizeModeProfiles() {
  const before = JSON.stringify(state.modeProfiles);
  const next = normalizeClientModeProfiles(state.modeProfiles, livePresetsForProfiles());
  const changed = [];
  for (const mode of MODE_PROFILE_IDS) {
    for (const group of MODE_PROFILE_GROUPS[mode]) {
      if (JSON.stringify(next[mode][group]) !== JSON.stringify(state.modeProfiles?.[mode]?.[group])) changed.push(`${mode}.${group}`);
    }
  }
  if (before !== JSON.stringify(next)) state.modeProfiles = next;
  return changed;
}
/** 归一化阵容时使用的成员目录：排除「+ 添加」草稿与待删除成员。 */
function livePresetsForProfiles() {
  return Object.fromEntries(Object.entries(state.presets).filter(([k, p]) => p && k !== MEMBER_DRAFT_KEY && !state.pendingDeletes.has(k)));
}
function storePresetDrafts() {
  try {
    const drafts = Object.fromEntries([...state.dirtyPresets.keys()].filter(k => state.presets[k]).map(k => [k, dirtyPatch(k)]));
    if (state.dirtyModeProfiles.size) drafts.__modeProfiles = modeProfilesPatch(state.dirtyModeProfiles.keys());
    if (!Object.keys(drafts).length) return sessionStorage.removeItem(presetDraftKey());
    sessionStorage.setItem(presetDraftKey(), JSON.stringify(drafts));
  } catch { /* Storage is optional in restricted Webviews. */ }
}
export function restorePresetDrafts() {
  try {
    const drafts = JSON.parse(sessionStorage.getItem(presetDraftKey()) || '{}');
    for (const [key, patch] of Object.entries(drafts)) {
      if (key.startsWith('__') || !patch || typeof patch !== 'object') continue;
      if (!state.presets[key]) {
        // 仅恢复「完整提交」的新成员；部分字段草稿缺少基线时丢弃
        if (!isValidCustomPresetKey(key) || !isPoolGroup(patch.group)) continue;
        state.presets[key] = newCustomPresetBase(patch.group, key);
      }
      const fields = Object.keys(patch).filter(f => PRESET_CREATE_FIELDS.includes(f) && ['string', 'boolean'].includes(typeof patch[f]));
      if (!fields.length) continue;
      for (const field of fields) state.presets[key][field] = patch[field];
      state.editedPresets.add(key);
      state.dirtyPresets.set(key, new Map(fields.map(f => [f, ++state.presetVersion])));
    }
    // v0.1.0 旧草稿（__memberPool / __relayTarget）已无对应编辑入口，直接丢弃
    const profiles = drafts.__modeProfiles;
    if (profiles && typeof profiles === 'object') {
      const restored = normalizeClientModeProfiles({ ...state.modeProfiles, ...Object.fromEntries(MODE_PROFILE_IDS.map((m) => [m, { ...state.modeProfiles[m], ...(profiles[m] || {}) }])) }, livePresetsForProfiles());
      for (const mode of MODE_PROFILE_IDS) {
        for (const group of MODE_PROFILE_GROUPS[mode]) {
          if (!profiles[mode]?.[group]) continue;
          state.modeProfiles[mode][group] = restored[mode][group];
          state.dirtyModeProfiles.set(`${mode}.${group}`, ++state.presetVersion);
        }
      }
    }
  } catch { /* Ignore malformed drafts. */ }
  if (hasPendingPresetChanges()) setPresetSaveStatus('dirty', '已恢复待保存修改');
  syncBoundDraftsWithPresets();
}

/* ---------- 远端合并：Bootstrap / settings_updated / saveSettings 回执 / 冲突重基共用 ---------- */
function normalizeIncomingPreset(key, raw) {
  const seed = seedPreset(key) || {};
  const provider = normalizeProviderId(raw.provider || raw.driverKind || seed.provider);
  return {
    ...seed, ...raw, key, provider,
    effort: raw.effort || raw.thinking || seed.effort,
    // 旧版持久化的通用值（approval-required / auto-accept-edits / full-access…）显示为该引擎原生等价档
    permissionMode: normalizePermissionForProvider(provider, raw.permissionMode || raw.runtimeMode || seed.permissionMode),
    group: raw.group !== undefined ? raw.group : seed.group ?? null,
    enabled: raw.enabled !== false,
  };
}
/**
 * 远端阵容并入本地。v0.3.0：data.projectConfig 标明阵容所属项目，与当前已加载项目不同 → 先隔离旧项目草稿并重置 revision 基线；
 * opts.skipRoster：只吸收全局摘要，不改动当前项目成员池（项目已独立定制时收到的全局 settings_updated）。
 */
export function mergeRemotePresets(data, opts = {}) {
  if (!data || typeof data !== 'object') return;
  // v0.2.11：Bootstrap 顺带下发当前项目规范维护快照（bootstrap.specCuration），与成员表同一入口吸收
  if (data?.specCuration && typeof data.specCuration === 'object') applySpecCurationPayload(data.specCuration);
  const settings = data.settings || {};
  const prevKey = state.presetProjectKey;
  const remoteKey = absorbProjectScope(data, settings, !opts.skipRoster);
  if (opts.skipRoster) return;
  const restoreDrafts = remoteKey !== undefined && prevKey === null && Boolean(remoteKey) && !hasPendingPresetChanges();
  if (remoteKey !== undefined) switchPresetProject(remoteKey);
  const incoming = data.presets || settings.presets || settings.rolePresets;
  const remotePool = data.memberPool || settings.memberPool;
  const remoteProfiles = data.modeProfiles || settings.modeProfiles;
  if (!incoming && !remotePool && !remoteProfiles) return;
  const revision = data.presetRevision ?? settings.presetRevision;
  if ((revision ?? -1) < state.serverPresetRevision) return;
  state.serverPresetRevision = revision ?? -1;
  if (incoming && typeof incoming === 'object') {
    const deleted = settings.deletedPresets ?? data.deletedPresets;
    if (Array.isArray(deleted)) state.deletedPresets = deleted.map(String);
    const remoteKeys = new Set();
    for (const [key, v] of Object.entries(incoming)) {
      if (!v || typeof v !== 'object' || key === MEMBER_DRAFT_KEY) continue;
      remoteKeys.add(key);
      const committed = normalizeIncomingPreset(key, v);
      state.committedPresets.set(key, committed);
      if (revision == null && state.editedPresets.has(key)) continue;
      const local = state.dirtyPresets.has(key) ? dirtyPatch(key) : {};
      state.presets[key] = { ...committed, ...local };
    }
    // 远端成员表为权威来源（全成员平权）：远端已不含的成员一律移除，绝不以离线种子复活已删成员；
    // 远端合法空表 {}（0 成员）同样清空离线种子。仅保留「+ 添加」草稿与待提交的新成员。
    for (const key of Object.keys(state.presets)) {
      if (remoteKeys.has(key) || key === MEMBER_DRAFT_KEY) continue;
      if (state.dirtyPresets.get(key)?.has('group')) continue;
      delete state.presets[key];
      state.committedPresets.delete(key);
      state.dirtyPresets.delete(key);
      state.pendingDeletes.delete(key);
      if (state.openMemberKey === key) state.openMemberKey = '';
    }
  }
  // v0.1.0 旧版组策略 / 翻译目标：只读基线，仅在远端尚无 modeProfiles 时用于无感迁移
  if (remotePool && typeof remotePool === 'object') {
    state.committedMemberPool = structuredClone(remotePool);
    for (const g of MEMBER_GROUP_IDS) {
      if (!DEFAULT_MEMBER_POOL[g]) continue;
      state.memberPool[g] = { ...DEFAULT_MEMBER_POOL[g], ...(remotePool[g] && typeof remotePool[g] === 'object' ? remotePool[g] : {}) };
    }
  }
  const relay = data.relayTargetPresetKey ?? settings.relayTargetPresetKey;
  if (typeof relay === 'string' && relay) {
    state.committedRelayTarget = relay;
    state.relayTargetPresetKey = relay;
  }
  if (remoteProfiles && typeof remoteProfiles === 'object') applyRemoteModeProfiles(remoteProfiles, 'settings');
  else if (incoming) applyRemoteModeProfiles(state.committedModeProfilesFromServer ? state.committedModeProfiles : null, state.committedModeProfilesFromServer ? 'settings' : 'legacy');
  // 首次确定所属项目（宿主内嵌启动时工作区随 Bootstrap 才下发）：补恢复该项目键下的未保存草稿
  if (restoreDrafts) restorePresetDrafts();
  else syncBoundDraftsWithPresets();
}

/**
 * 远端阵容并入本地：未在编辑中的 "mode.group" 采用远端值，正在编辑的保留本地乐观值。
 * source：'settings'（settings.modeProfiles，权威来源）/ 'activeMode'（仅在尚未收到 settings 阵容时兜底）/
 * 'legacy'（远端尚无 modeProfiles 的旧版守护进程 / 存量设置：由旧版启停 + 锁定 ★ + 翻译目标无感迁移）。
 */
function applyRemoteModeProfiles(rawProfiles, source) {
  if (source === 'activeMode' && state.committedModeProfilesFromServer) return;
  const legacy = source === 'legacy';
  const committed = normalizeClientModeProfiles(legacy ? null : rawProfiles, livePresetsForProfiles(),
    legacy ? state.committedMemberPool : null, legacy ? state.committedRelayTarget : '');
  state.committedModeProfiles = committed;
  if (source === 'settings') state.committedModeProfilesFromServer = true;
  for (const mode of MODE_PROFILE_IDS) {
    for (const group of MODE_PROFILE_GROUPS[mode]) {
      if (state.dirtyModeProfiles.has(`${mode}.${group}`)) continue;
      state.modeProfiles[mode][group] = structuredClone(committed[mode][group]);
    }
  }
  renormalizeModeProfiles();
}

/**
 * activeMode 快照（setConversationPolicy 回执 / 策略事件 / 轮询）：原样保存；
 * 其中的 modeProfiles 仅在尚未收到 settings.modeProfiles 时作为阵容兜底基线（settings 才是阵容的权威来源）。
 */
export function applyActiveModePayload(raw) {
  if (!raw || typeof raw !== 'object') return;
  state.activeMode = raw;
  if (raw.modeProfiles && typeof raw.modeProfiles === 'object') applyRemoteModeProfiles(raw.modeProfiles, 'activeMode');
}

function sameFieldValue(field, a, b) {
  if (field === 'provider') return normalizeProviderId(a) === normalizeProviderId(b);
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
const LINKED_PRESET_FIELDS = [['label', 'title'], ['provider', 'model', 'effort', 'permissionMode', 'interactionMode', 'runtimeMode']];
/**
 * PRESET_REVISION_CONFLICT 无损合并：以 err.details.settings 为新基线；
 * 同一 presetKey 同一字段两端都改过 → 采用最新配置并提示；其余本地修改保留，随后自动重试保存。
 */
function rebaseOnPresetConflict(details) {
  const settings = details?.settings && typeof details.settings === 'object' ? details.settings : {};
  const remote = settings.presets && typeof settings.presets === 'object' ? settings.presets : {};
  const conflicted = new Set();
  for (const [key, fields] of [...state.dirtyPresets.entries()]) {
    // 内置种子成员尚无远端基线时（离线首屏），以黄金默认为基线比较
    const base = state.committedPresets.get(key) || (seedPreset(key) ? normalizeIncomingPreset(key, {}) : null);
    const theirs = remote[key] ? normalizeIncomingPreset(key, remote[key]) : null;
    if (!base || !theirs) {
      // 新成员键已被其他窗口占用，或该成员已被其他窗口删除
      if (base ? !theirs : theirs) { conflicted.add(key); state.dirtyPresets.delete(key); }
      continue;
    }
    for (const field of [...fields.keys()]) {
      if (!sameFieldValue(field, base[field], theirs[field])) {
        // 联动字段整体让位（显示名 + 标题、引擎 + 模型 + 强度 + 权限），避免拼出半新半旧的非法组合
        const linked = LINKED_PRESET_FIELDS.find((g) => g.includes(field)) || [field];
        for (const f of linked) fields.delete(f);
        conflicted.add(key);
      }
    }
    if (!fields.size) state.dirtyPresets.delete(key);
  }
  // 阵容：同一 "mode.group" 两端都改过 → 采用最新配置并提示；其余本地勾选保留，随后自动重试
  const remoteProfiles = settings.modeProfiles && typeof settings.modeProfiles === 'object' ? settings.modeProfiles : null;
  if (remoteProfiles) {
    const theirs = normalizeClientModeProfiles(remoteProfiles, livePresetsForProfiles());
    for (const id of [...state.dirtyModeProfiles.keys()]) {
      const parts = splitProfileKey(id);
      if (!parts) { state.dirtyModeProfiles.delete(id); continue; }
      const [mode, group] = parts;
      const base = state.committedModeProfiles?.[mode]?.[group];
      if (base && JSON.stringify(base) !== JSON.stringify(theirs[mode][group])) {
        state.dirtyModeProfiles.delete(id);
        conflicted.add(`${MODE_PROFILE_LABELS[mode]}·${MEMBER_GROUPS.find((x) => x.id === group)?.title || group}`);
      }
    }
  }
  for (const key of [...state.pendingDeletes]) if (!remote[key]) state.pendingDeletes.delete(key);
  // 提示文案用最新（远端）显示名，用户看到的就是合并后的结果
  const labels = [...conflicted].map((k) => remote[k]?.label || (state.presets[k] ? presetDisplayLabel(k) : k));
  state.serverPresetRevision = -1;
  mergeRemotePresets({ settings, presetRevision: details?.currentRevision ?? settings.presetRevision });
  storePresetDrafts();
  if (labels.length) {
    showToast(`其他窗口已修改「${labels.join('、')}」，已采用最新配置；其余未冲突的修改已自动合并重试`, 'info');
  }
}

/* ---------- 待保存队列 ---------- */
export function hasPendingPresetChanges() {
  return Boolean(state.dirtyPresets.size || state.dirtyModeProfiles.size || state.pendingDeletes.size || state.pendingResets.size);
}
function schedulePresetSave() {
  capturePresetEditTarget();
  storePresetDrafts();
  syncBoundDraftsWithPresets();
  setPresetSaveStatus('dirty');
  clearTimeout(state.presetTimer);
  state.presetTimer = setTimeout(saveAllRolePresets, 300);
}
export function markPresetDirty(key, fields = PRESET_ROUTE_FIELDS) {
  // 「+ 添加」草稿在用户确认前只改本地，不入保存队列
  if (key === MEMBER_DRAFT_KEY) { syncBoundDraftsWithPresets(); return; }
  const changes = new Map(state.dirtyPresets.get(key));
  for (const field of fields) changes.set(field, ++state.presetVersion);
  state.dirtyPresets.set(key, changes);
  state.editedPresets.add(key);
  schedulePresetSave();
}
/** 阵容（勾选 / 阶段开关 / ★ 首选）修改：先就地归一化，再与成员修改合并进同一轮 300ms 防抖保存。 */
export function markModeProfileDirty(mode, group) {
  if (!MODE_PROFILE_GROUPS[mode]?.includes(group)) return;
  for (const id of [`${mode}.${group}`, ...renormalizeModeProfiles()]) state.dirtyModeProfiles.set(id, ++state.presetVersion);
  schedulePresetSave();
}
/** 删除成员（全成员平权，任何成员均可删）：同步从全部阵容移除并修复 ★（执行组被清空时自动回落另一名执行官）。 */
export function queuePresetDelete(key) {
  if (!state.presets[key] || key === MEMBER_DRAFT_KEY) return;
  state.dirtyPresets.delete(key);
  state.editedPresets.delete(key);
  state.pendingDeletes.add(key);
  if (state.openMemberKey === key) state.openMemberKey = '';
  for (const mode of MODE_PROFILE_IDS) {
    for (const group of MODE_PROFILE_GROUPS[mode]) {
      const entry = state.modeProfiles[mode][group];
      if (!entry.enabledKeys.includes(key) && entry.preferredKey !== key) continue;
      entry.enabledKeys = entry.enabledKeys.filter((k) => k !== key);
      if (entry.preferredKey === key) entry.preferredKey = entry.enabledKeys[0] || null;
      state.dirtyModeProfiles.set(`${mode}.${group}`, ++state.presetVersion);
    }
  }
  for (const id of renormalizeModeProfiles()) state.dirtyModeProfiles.set(id, ++state.presetVersion);
  schedulePresetSave();
}
/**
 * 新增成员确认：草稿改为正式成员键，完整对象一次性进入保存队列；
 * 同时自动勾选进当前配置页正在编辑的阵容（state.editingModeProfile）对应组，与成员对象同一次 saveSettings 提交。
 */
export function commitMemberDraft(finalKey, mode = state.editingModeProfile) {
  const draft = state.presets[MEMBER_DRAFT_KEY];
  if (!draft) return false;
  delete state.presets[MEMBER_DRAFT_KEY];
  const label = String(draft.label || '').trim();
  state.presets[finalKey] = { ...draft, key: finalKey, label, title: label, builtin: false, enabled: true };
  state.memberDraftKeyTouched = false;
  state.openMemberKey = '';
  const scope = MODE_PROFILE_IDS.includes(mode) ? mode : 'relay';
  const entry = state.modeProfiles[scope]?.[draft.group];
  if (entry && !entry.enabledKeys.includes(finalKey)) {
    entry.enabledKeys = [...entry.enabledKeys, finalKey];
    state.dirtyModeProfiles.set(`${scope}.${draft.group}`, ++state.presetVersion);
  }
  markPresetDirty(finalKey, PRESET_CREATE_FIELDS);
  return true;
}

/** 把当前待保存队列打包为一次 saveSettings 请求（成员字段补丁 + 阵容整体 + 删除 / 重置队列 + 乐观并发 revision）。 */
function buildPresetSaveBatch(target) {
  const batch = new Map();
  const presets = {};
  for (const [key, fields] of [...state.dirtyPresets.entries()]) {
    if (!state.presets[key]) { state.dirtyPresets.delete(key); continue; }
    batch.set(key, new Map(fields));
    presets[key] = dirtyPatch(key);
  }
  const profileBatch = new Map(state.dirtyModeProfiles);
  const deletes = [...state.pendingDeletes];
  const resets = [...state.pendingResets];
  const params = {};
  if (Object.keys(presets).length) params.presets = presets;
  // 阵容整体提交（relay + complex 精确结构），配合 expectedPresetRevision 乐观并发，不会覆盖其他窗口的修改
  if (profileBatch.size) params.modeProfiles = structuredClone(state.modeProfiles);
  if (deletes.length) params.deletePresets = deletes;
  if (resets.length) params.resetPresets = resets;
  params.expectedPresetRevision = state.serverPresetRevision >= 0 ? state.serverPresetRevision : undefined;
  // v0.3.0：有工作区时只写当前项目独立阵容（按该项目 rosterRevision 校验），workspace 固定为编辑发起时捕获的项目；
  // 未绑定项目时显式写入 scope: 'global' 并清除 workspace/cwd，防止 net.js 默认注入的 getEffectiveCwd() 误串写进具体项目。
  if (target?.workspace) Object.assign(params, { scope: 'project', workspace: target.workspace });
  else Object.assign(params, { scope: 'global', workspace: undefined, cwd: undefined });
  return { batch, presets, profileBatch, deletes, resets, params };
}

/**
 * 切换项目前隔离未保存修改：按捕获的旧项目目标单次提交（不合并回执，绝不触碰新项目阵容）；
 * 保留旧项目最后已知的 expectedPresetRevision（在途保存完成后采用其最新已知修订号），遇冲突放弃盲写并提示。
 */
function flushDetachedPresetChanges() {
  clearTimeout(state.presetTimer);
  delete state.presets[MEMBER_DRAFT_KEY];
  if (!hasPendingPresetChanges()) return;
  const target = state.presetEditTarget || { workspace: '', projectKey: state.presetProjectKey || '' };
  state.presetEditTarget = target;
  storePresetDrafts();
  const draftKey = presetDraftKey(target.projectKey);
  const { params } = buildPresetSaveBatch(target);
  const inflight = state.presetSavePromise;
  const submit = (latestRev) => {
    if (Number.isInteger(latestRev) && latestRev >= 0) params.expectedPresetRevision = latestRev;
    return rpcCall('saveSettings', params);
  };
  void (inflight ? inflight.then(submit, () => submit()) : submit()).then(
    () => { try { sessionStorage.removeItem(draftKey); } catch { /* Storage is optional. */ } },
    (err) => {
      const conflict = err?.code === 'PRESET_REVISION_CONFLICT';
      const msg = conflict
        ? '其他窗口已更新原项目成员池，已放弃覆盖他人新改动（原草稿已按原项目暂存）'
        : `切换项目前未保存的成员池修改提交失败（草稿已按原项目暂存）：${describeRpcError(err)}`;
      showToast(msg, conflict ? 'info' : 'error');
    },
  );
}

/**
 * v0.3.0 切换项目（会话切换 / 服务端下发的 projectConfig.projectKey 变化）：隔离旧项目草稿并重置按项目的 revision 基线。
 * presetProjectKey 为 null（尚未收到任何项目配置）时直接采用新键，不做隔离；返回是否发生了项目切换。
 */
export function switchPresetProject(nextKey = '') {
  const key = String(nextKey || '');
  if (state.presetProjectKey === key) return false;
  const first = state.presetProjectKey === null;
  state.presetProjectKey = key;
  if (first) return false;
  flushDetachedPresetChanges();
  state.presetProjectEpoch++;
  state.presetEditTarget = null;
  state.dirtyPresets.clear();
  state.dirtyModeProfiles.clear();
  state.pendingDeletes.clear();
  state.pendingResets.clear();
  state.editedPresets.clear();
  state.committedPresets.clear();
  state.committedModeProfiles = null;
  state.committedModeProfilesFromServer = false;
  state.serverPresetRevision = -1;
  state.openMemberKey = '';
  state.presetSaving = false;
  setPresetSaveStatus('idle');
  return true;
}

/** 吸收项目 / 全局配置摘要（projectConfig / globalTemplate / defaultSpecEnabled）；返回远端阵容所属项目键（未下发为 undefined）。 */
function absorbProjectScope(data, settings, withProject = true) {
  const rawCfg = data.projectConfig ?? settings.projectConfig;
  const tpl = data.globalTemplate ?? settings.globalTemplate;
  if (tpl !== undefined) mergeRemoteGlobalTemplate(tpl);
  const defSpec = settings.defaultSpecEnabled ?? data.defaultSpecEnabled;
  if (typeof defSpec === 'boolean') state.defaultSpecEnabled = defSpec;
  if (rawCfg === undefined || !withProject) return undefined;
  const cfg = normalizeProjectConfig(rawCfg);
  if (cfg && cfg.projectKey === state.projectConfig?.projectKey && cfg.rosterRevision < state.projectConfig.rosterRevision) {
    return cfg.projectKey;
  }
  state.projectConfig = cfg;
  // 项目配置携带的 specEnabled 同步进当前项目规范快照（不改写补拉标记，status 仍按需补拉）
  if (cfg && typeof cfg.specEnabled === 'boolean') {
    const cur = currentSpecCuration();
    const ws = cur.workspace || cfg.workspace;
    if (cur.specEnabled !== cfg.specEnabled && ws) state.specCuration = { ...cur, workspace: ws, specEnabled: cfg.specEnabled };
  }
  return cfg ? cfg.projectKey || '' : '';
}

/** 全局切换 defaultSpecEnabled 后，联动刷新未单独固定 spec.enabled 的当前项目 specEnabled 显示态。 */
export function syncCurrentProjectSpecFromGlobal(remoteProjectConfig, nextDefaultSpec) {
  if (state.conversationUnbound) return;
  const curKey = currentProjectKey();
  if (remoteProjectConfig && typeof remoteProjectConfig === 'object') {
    const cfg = normalizeProjectConfig(remoteProjectConfig);
    if (cfg && cfg.projectKey && (!curKey || cfg.projectKey === curKey)) {
      state.projectConfig = cfg;
      if (typeof cfg.specEnabled === 'boolean') {
        const cur = currentSpecCuration();
        const ws = cur.workspace || cfg.workspace || currentProjectWorkspace();
        if (ws && cur.specEnabled !== cfg.specEnabled) {
          state.specCuration = { ...cur, workspace: ws, specEnabled: cfg.specEnabled };
          state.projectSpecs.loadedForWorkspace = '';
        }
      }
      return;
    }
  }
  if (typeof nextDefaultSpec !== 'boolean') return;
  const cfg = currentProjectConfig();
  if (!cfg?.workspace || cfg.specCustomized !== false) return;
  const cur = currentSpecCuration();
  if (!nextDefaultSpec && cur.archive?.hasActiveSpecs) return;
  cfg.specEnabled = nextDefaultSpec;
  const ws = cur.workspace || cfg.workspace;
  if (ws && cur.specEnabled !== nextDefaultSpec) {
    state.specCuration = { ...cur, workspace: ws, specEnabled: nextDefaultSpec };
    state.projectSpecs.loadedForWorkspace = '';
  }
}

async function runPresetSaveLoop() {
  let rebases = 0;
  const epoch = state.presetProjectEpoch;
  const target = capturePresetEditTarget();
  let lastRevision = state.serverPresetRevision >= 0 ? state.serverPresetRevision : undefined;
  while (hasPendingPresetChanges() && epoch === state.presetProjectEpoch) {
    const { batch, presets, profileBatch, deletes, resets, params } = buildPresetSaveBatch(target);
    state.presetSaving = true;
    setPresetSaveStatus('saving');
    try {
      const reply = await rpcCall('saveSettings', params);
      const rawRevision = reply?.presetRevision ?? reply?.settings?.presetRevision;
      if (Number.isInteger(rawRevision) && rawRevision >= 0) lastRevision = rawRevision;
      // 保存期间已切换项目：旧项目回执一律丢弃，绝不覆盖新项目阵容
      if (epoch !== state.presetProjectEpoch) return lastRevision;
      for (const [k, fields] of batch) {
        const current = state.dirtyPresets.get(k);
        for (const [field, ver] of fields) if (current?.get(field) === ver) current.delete(field);
        if (!current?.size) state.dirtyPresets.delete(k);
      }
      for (const [id, ver] of profileBatch) if (state.dirtyModeProfiles.get(id) === ver) state.dirtyModeProfiles.delete(id);
      for (const k of deletes) {
        state.pendingDeletes.delete(k);
        if (rawRevision != null && rawRevision < state.serverPresetRevision) continue;
        delete state.presets[k];
        state.committedPresets.delete(k);
        if (!state.deletedPresets.includes(k)) state.deletedPresets.push(k);
      }
      for (const k of resets) state.pendingResets.delete(k);
      storePresetDrafts();
      if (rawRevision == null) {
        // 回执未携带 revision / 设置快照：把已确认的补丁并入远端基线（供后续冲突比对），绝不回退本地已确认修改
        for (const [k, patch] of Object.entries(presets)) {
          if (state.presets[k]) state.committedPresets.set(k, { ...(state.committedPresets.get(k) || state.presets[k]), ...patch });
        }
        if (params.modeProfiles) state.committedModeProfiles = structuredClone(params.modeProfiles);
      } else if (rawRevision < state.serverPresetRevision) {
        // A newer settings event may already be hidden underneath the just-acknowledged local edit.
        mergeRemotePresets({ presets: Object.fromEntries(state.committedPresets), presetRevision: state.serverPresetRevision });
      } else mergeRemotePresets(reply || {});
      setPresetSaveStatus(hasPendingPresetChanges() ? 'dirty' : 'saved');
    } catch (err) {
      if (epoch !== state.presetProjectEpoch) return lastRevision;
      if (err.code === 'PRESET_REVISION_CONFLICT' && rebases < 3) {
        rebases++;
        rebaseOnPresetConflict(err.details);
        continue;
      }
      setPresetSaveStatus('error', '保存失败', describeRpcError(err));
      throw err;
    } finally {
      state.presetSaving = false;
      scheduleRender();
      checkAssetUpdate();
    }
  }
  if (epoch === state.presetProjectEpoch && !hasPendingPresetChanges()) state.presetEditTarget = null;
  return lastRevision;
}
export async function saveAllRolePresets(manual = false) {
  clearTimeout(state.presetTimer);
  if (!hasPendingPresetChanges() && !state.presetSavePromise) {
    if (manual) showToast('成员池配置已同步，无待保存修改', 'success');
    return;
  }
  if (!state.presetSavePromise) {
    state.presetSavePromise = runPresetSaveLoop().finally(() => {
      state.presetSavePromise = null;
    });
  }
  try {
    await state.presetSavePromise;
    if (manual && !hasPendingPresetChanges()) showToast('成员池配置已保存', 'success');
  } catch (err) {
    if (manual) showToast(describeRpcError(err), 'error');
  }
}
/** 派单前确保成员池与阵容已落盘；保存失败时提示并拒绝派单。 */
export async function ensurePresetsSaved() {
  if (!currentProjectConfig()?.rosterCustomized && (hasPendingGlobalPresetChanges() || state.globalPresetSavePromise)) {
    await saveAllGlobalRolePresets();
    if (hasPendingGlobalPresetChanges()) {
      showToast('全局默认成员池保存未完成，请检查连接后重试', 'error');
      return false;
    }
  }
  if (hasPendingPresetChanges() || state.presetSavePromise) {
    await saveAllRolePresets();
    if (hasPendingPresetChanges()) {
      showToast('角色预设 / 阵容保存未完成，请检查连接后重试', 'error');
      return false;
    }
  }
  syncBoundDraftsWithPresets();
  return true;
}

const PRESET_SAVE_LABELS = { idle: '自动保存', dirty: '待保存…', saving: '保存中…', saved: '已保存 ✓', error: '保存失败', blocked: '待处理 ★' };

export function syncSavePillVisibility() {
  const pill = document.getElementById('preset-save-status');
  if (pill) pill.hidden = state.settingsPane !== 'roles' && pill.dataset.state !== 'error' && pill.dataset.state !== 'blocked';
}
function setPresetSaveStatus(kind, text = '', detail = '') {
  const pill = document.getElementById('preset-save-status');
  if (!pill) return;
  const label = text || PRESET_SAVE_LABELS[kind] || '';
  pill.dataset.state = kind;
  pill.title = detail ? `${label}：${detail}` : kind === 'idle' ? '修改即时自动保存' : label;
  setText('preset-save-text', label);
  const retry = document.getElementById('btn-save-presets');
  if (retry) {
    retry.hidden = kind !== 'error';
    retry.title = detail ? `重试保存（${detail}）` : '重试保存';
  }
  clearTimeout(state.presetSaveIdleTimer);
  if (kind === 'saved') {
    state.presetSaveIdleTimer = setTimeout(() => {
      if (pill.dataset.state === 'saved') setPresetSaveStatus('idle');
    }, 2400);
  }
  syncSavePillVisibility();
}

/* ========================================================================
 * v0.3.2 全局默认成员池独立同步与保存闭环（scope: 'global'，绝不串写项目配置）
 * ======================================================================== */
function globalDirtyPatch(key) {
  const preset = state.globalPresets[key];
  const fields = state.globalDirtyPresets.get(key);
  if (!preset || !fields) return {};
  return Object.fromEntries([...fields.keys()].map((field) => [field, preset[field]]));
}

function liveGlobalPresetsForProfiles() {
  return Object.fromEntries(Object.entries(state.globalPresets).filter(([k, p]) => p && k !== MEMBER_DRAFT_KEY && !state.globalPendingDeletes.has(k)));
}

function renormalizeGlobalModeProfiles() {
  const before = JSON.stringify(state.globalModeProfiles);
  const next = normalizeClientModeProfiles(state.globalModeProfiles, liveGlobalPresetsForProfiles());
  const changed = [];
  for (const mode of MODE_PROFILE_IDS) {
    for (const group of MODE_PROFILE_GROUPS[mode]) {
      if (JSON.stringify(next[mode][group]) !== JSON.stringify(state.globalModeProfiles?.[mode]?.[group])) changed.push(`${mode}.${group}`);
    }
  }
  if (before !== JSON.stringify(next)) state.globalModeProfiles = next;
  return changed;
}

function syncInheritedRosterFromGlobal() {
  const tpl = state.globalTemplate;
  if (!tpl || state.projectConfig?.rosterCustomized || hasPendingPresetChanges()) return;
  mergeRemotePresets({ ...tpl, presetRevision: Math.max(state.serverPresetRevision, tpl.presetRevision) });
}

/** 吸收远端 globalTemplate（Bootstrap / settings_updated / saveSettings(scope:'global')），保护本地未保存修改。 */
export function mergeRemoteGlobalTemplate(raw, { force = false } = {}) {
  if (!raw || typeof raw !== 'object') {
    if (raw === null) state.globalTemplate = null;
    return;
  }
  const source = raw.globalTemplate && typeof raw.globalTemplate === 'object'
    ? raw.globalTemplate
    : raw.settings && typeof raw.settings === 'object' && !raw.presets
      ? { ...raw.settings, presetRevision: raw.presetRevision ?? raw.settings.presetRevision }
      : raw;
  const tpl = normalizeGlobalTemplate(source);
  if (!tpl) return;
  const rawRev = source.presetRevision ?? raw.presetRevision;
  const rev = Number.isFinite(Number(rawRev)) ? Number(rawRev) : null;
  if (rev != null && rev < state.globalServerRevision) return;
  if (!state.globalTemplate || rev == null || rev >= state.globalTemplate.presetRevision) state.globalTemplate = tpl;
  // 广播可能早于保存回执，编辑中的 CAS 基线只由回执或冲突重基推进。
  if (!force && hasPendingGlobalPresetChanges() && rev !== state.globalServerRevision) return;
  if (rev != null) state.globalServerRevision = rev;
  if (Array.isArray(tpl.deletedPresets)) state.globalDeletedPresets = [...tpl.deletedPresets];
  const hasIncomingPresets = Boolean(source.presets && typeof source.presets === 'object');
  if (hasIncomingPresets) {
    const remoteKeys = new Set();
    for (const [key, v] of Object.entries(tpl.presets)) {
      if (!v || typeof v !== 'object' || key === MEMBER_DRAFT_KEY) continue;
      remoteKeys.add(key);
      const committed = normalizeIncomingPreset(key, v);
      state.globalCommittedPresets.set(key, committed);
      if (rev == null && state.globalEditedPresets.has(key)) continue;
      const local = state.globalDirtyPresets.has(key) ? globalDirtyPatch(key) : {};
      state.globalPresets[key] = { ...committed, ...local };
    }
    for (const key of Object.keys(state.globalPresets)) {
      if (remoteKeys.has(key) || key === MEMBER_DRAFT_KEY) continue;
      if (state.globalDirtyPresets.get(key)?.has('group')) continue;
      delete state.globalPresets[key];
      state.globalCommittedPresets.delete(key);
      state.globalDirtyPresets.delete(key);
      state.globalPendingDeletes.delete(key);
      if (state.globalOpenMemberKey === key) state.globalOpenMemberKey = '';
    }
  }
  if (tpl.modeProfiles && typeof tpl.modeProfiles === 'object') {
    const committed = normalizeClientModeProfiles(tpl.modeProfiles, tpl.presets);
    state.globalCommittedModeProfiles = committed;
    for (const mode of MODE_PROFILE_IDS) {
      for (const group of MODE_PROFILE_GROUPS[mode]) {
        if (state.globalDirtyModeProfiles.has(`${mode}.${group}`)) continue;
        state.globalModeProfiles[mode][group] = structuredClone(committed[mode][group]);
      }
    }
    renormalizeGlobalModeProfiles();
  } else if (hasIncomingPresets) {
    renormalizeGlobalModeProfiles();
  }
}

export function hasPendingGlobalPresetChanges() {
  return Boolean(state.globalDirtyPresets.size || state.globalDirtyModeProfiles.size || state.globalPendingDeletes.size);
}

function scheduleGlobalPresetSave() {
  setGlobalPresetSaveStatus('dirty');
  clearTimeout(state.globalPresetTimer);
  state.globalPresetTimer = setTimeout(saveAllGlobalRolePresets, 300);
}

export function markGlobalPresetDirty(key, fields = PRESET_ROUTE_FIELDS) {
  if (key === MEMBER_DRAFT_KEY) return;
  const changes = new Map(state.globalDirtyPresets.get(key));
  for (const field of fields) changes.set(field, ++state.presetVersion);
  state.globalDirtyPresets.set(key, changes);
  state.globalEditedPresets.add(key);
  scheduleGlobalPresetSave();
}

export function markGlobalModeProfileDirty(mode, group) {
  if (!MODE_PROFILE_GROUPS[mode]?.includes(group)) return;
  for (const id of [`${mode}.${group}`, ...renormalizeGlobalModeProfiles()]) state.globalDirtyModeProfiles.set(id, ++state.presetVersion);
  scheduleGlobalPresetSave();
}

export function queueGlobalPresetDelete(key) {
  if (!state.globalPresets[key] || key === MEMBER_DRAFT_KEY) return;
  state.globalDirtyPresets.delete(key);
  state.globalEditedPresets.delete(key);
  state.globalPendingDeletes.add(key);
  if (state.globalOpenMemberKey === key) state.globalOpenMemberKey = '';
  for (const mode of MODE_PROFILE_IDS) {
    for (const group of MODE_PROFILE_GROUPS[mode]) {
      const entry = state.globalModeProfiles[mode][group];
      if (!entry.enabledKeys.includes(key) && entry.preferredKey !== key) continue;
      entry.enabledKeys = entry.enabledKeys.filter((k) => k !== key);
      if (entry.preferredKey === key) entry.preferredKey = entry.enabledKeys[0] || null;
      state.globalDirtyModeProfiles.set(`${mode}.${group}`, ++state.presetVersion);
    }
  }
  for (const id of renormalizeGlobalModeProfiles()) state.globalDirtyModeProfiles.set(id, ++state.presetVersion);
  scheduleGlobalPresetSave();
}

export function commitGlobalMemberDraft(finalKey, mode = state.globalEditingModeProfile) {
  const draft = state.globalPresets[MEMBER_DRAFT_KEY];
  if (!draft) return false;
  delete state.globalPresets[MEMBER_DRAFT_KEY];
  const label = String(draft.label || '').trim();
  state.globalPresets[finalKey] = { ...draft, key: finalKey, label, title: label, builtin: false, enabled: true };
  state.globalMemberDraftKeyTouched = false;
  state.globalOpenMemberKey = '';
  const scope = MODE_PROFILE_IDS.includes(mode) ? mode : 'complex';
  const entry = state.globalModeProfiles[scope]?.[draft.group];
  if (entry && !entry.enabledKeys.includes(finalKey)) {
    entry.enabledKeys = [...entry.enabledKeys, finalKey];
    state.globalDirtyModeProfiles.set(`${scope}.${draft.group}`, ++state.presetVersion);
  }
  markGlobalPresetDirty(finalKey, PRESET_CREATE_FIELDS);
  return true;
}

function buildGlobalPresetSaveBatch() {
  const batch = new Map();
  const presets = {};
  for (const [key, fields] of [...state.globalDirtyPresets.entries()]) {
    if (!state.globalPresets[key]) { state.globalDirtyPresets.delete(key); continue; }
    batch.set(key, new Map(fields));
    presets[key] = globalDirtyPatch(key);
  }
  const profileBatch = new Map(state.globalDirtyModeProfiles);
  const deletes = [...state.globalPendingDeletes];
  const params = { scope: 'global', workspace: undefined, cwd: undefined };
  if (Object.keys(presets).length) params.presets = presets;
  if (profileBatch.size) params.modeProfiles = structuredClone(state.globalModeProfiles);
  if (deletes.length) params.deletePresets = deletes;
  params.expectedPresetRevision = Math.max(0, state.globalServerRevision);
  return { batch, presets, profileBatch, deletes, params };
}

function rebaseOnGlobalPresetConflict(details) {
  const settings = details?.settings && typeof details.settings === 'object' ? details.settings : {};
  const remote = settings.presets && typeof settings.presets === 'object' ? settings.presets : {};
  const conflicted = new Set();
  for (const [key, fields] of [...state.globalDirtyPresets.entries()]) {
    const base = state.globalCommittedPresets.get(key) || (seedPreset(key) ? normalizeIncomingPreset(key, {}) : null);
    const theirs = remote[key] ? normalizeIncomingPreset(key, remote[key]) : null;
    if (!base || !theirs) {
      if (base ? !theirs : theirs) { conflicted.add(key); state.globalDirtyPresets.delete(key); }
      continue;
    }
    for (const field of [...fields.keys()]) {
      const linked = LINKED_PRESET_FIELDS.find((g) => g.includes(field)) || [field];
      if (linked.some(f => !sameFieldValue(f, base[f], theirs[f]))) {
        for (const f of linked) fields.delete(f);
        conflicted.add(key);
      }
    }
    if (!fields.size) state.globalDirtyPresets.delete(key);
  }
  const remoteProfiles = settings.modeProfiles && typeof settings.modeProfiles === 'object' ? settings.modeProfiles : null;
  if (remoteProfiles) {
    const theirs = normalizeClientModeProfiles(remoteProfiles, remote);
    for (const id of [...state.globalDirtyModeProfiles.keys()]) {
      const parts = splitProfileKey(id);
      if (!parts) { state.globalDirtyModeProfiles.delete(id); continue; }
      const [mode, group] = parts;
      const base = state.globalCommittedModeProfiles?.[mode]?.[group];
      if (base && JSON.stringify(base) !== JSON.stringify(theirs[mode][group])) {
        state.globalDirtyModeProfiles.delete(id);
        conflicted.add(`${MODE_PROFILE_LABELS[mode]}·${MEMBER_GROUPS.find((x) => x.id === group)?.title || group}`);
      }
    }
  }
  for (const key of [...state.globalPendingDeletes]) if (!remote[key]) state.globalPendingDeletes.delete(key);
  const labels = [...conflicted].map((k) => remote[k]?.label || (state.globalPresets[k] ? presetDisplayLabel(k, 'global') : k));
  mergeRemoteGlobalTemplate({ settings, presetRevision: details?.currentRevision ?? settings.presetRevision }, { force: true });
  if (labels.length) {
    showToast(`其他窗口已修改全局模板「${labels.join('、')}」，已采用最新配置；其余未冲突的修改已自动合并重试`, 'info');
  }
}

async function runGlobalPresetSaveLoop() {
  let rebases = 0;
  while (hasPendingGlobalPresetChanges()) {
    const { batch, presets, profileBatch, deletes, params } = buildGlobalPresetSaveBatch();
    state.globalPresetSaving = true;
    setGlobalPresetSaveStatus('saving');
    try {
      const reply = await rpcCall('saveSettings', params);
      const rawRevision = reply?.globalTemplate?.presetRevision ?? reply?.presetRevision ?? reply?.settings?.presetRevision;
      for (const [k, fields] of batch) {
        const current = state.globalDirtyPresets.get(k);
        for (const [field, ver] of fields) if (current?.get(field) === ver) current.delete(field);
        if (!current?.size) state.globalDirtyPresets.delete(k);
      }
      for (const [id, ver] of profileBatch) if (state.globalDirtyModeProfiles.get(id) === ver) state.globalDirtyModeProfiles.delete(id);
      for (const k of deletes) {
        if (!state.globalPendingDeletes.delete(k)) continue; // 在途删除后已同键重建
        if (rawRevision != null && rawRevision < state.globalServerRevision) continue;
        delete state.globalPresets[k];
        state.globalCommittedPresets.delete(k);
        if (!state.globalDeletedPresets.includes(k)) state.globalDeletedPresets.push(k);
      }
      if (rawRevision != null && Number.isFinite(Number(rawRevision))) {
        state.globalServerRevision = Math.max(state.globalServerRevision, Number(rawRevision));
      }
      const hasReplySnapshot = Boolean(reply?.globalTemplate || reply?.presets || reply?.settings?.presets || reply?.modeProfiles || reply?.settings?.modeProfiles);
      if (!hasReplySnapshot) {
        for (const [k, patch] of Object.entries(presets)) {
          if (state.globalPresets[k]) state.globalCommittedPresets.set(k, { ...(state.globalCommittedPresets.get(k) || state.globalPresets[k]), ...patch });
        }
        if (params.modeProfiles) state.globalCommittedModeProfiles = structuredClone(params.modeProfiles);
        if (!state.globalTemplate || state.globalTemplate.presetRevision <= state.globalServerRevision) {
          state.globalTemplate = normalizeGlobalTemplate({ presetRevision: state.globalServerRevision,
            presets: Object.fromEntries(state.globalCommittedPresets), modeProfiles: state.globalCommittedModeProfiles, deletedPresets: state.globalDeletedPresets });
        }
      } else {
        mergeRemoteGlobalTemplate(reply, { force: true });
      }
      if (state.globalTemplate?.presetRevision > state.globalServerRevision) mergeRemoteGlobalTemplate(state.globalTemplate);
      // 仅当当前项目未独立定制且无待保存项目草稿时，继承刷新当前项目展示；已独立定制的项目绝对不受影响
      syncInheritedRosterFromGlobal();
      setGlobalPresetSaveStatus(hasPendingGlobalPresetChanges() ? 'dirty' : 'saved');
    } catch (err) {
      if (err?.code === 'PRESET_REVISION_CONFLICT' && err.details?.settings?.presets && rebases < 3) {
        rebases++;
        rebaseOnGlobalPresetConflict(err.details);
        if (!hasPendingGlobalPresetChanges()) {
          mergeRemoteGlobalTemplate(state.globalTemplate);
          setGlobalPresetSaveStatus('saved');
        }
        syncInheritedRosterFromGlobal();
        continue;
      }
      setGlobalPresetSaveStatus('error', '保存失败', describeRpcError(err));
      throw err;
    } finally {
      state.globalPresetSaving = false;
      scheduleRender();
      checkAssetUpdate();
    }
  }
}

export async function saveAllGlobalRolePresets(manual = false) {
  clearTimeout(state.globalPresetTimer);
  if (!hasPendingGlobalPresetChanges() && !state.globalPresetSavePromise) {
    if (manual) showToast('全局默认成员池已同步，无待保存修改', 'success');
    return;
  }
  if (!state.globalPresetSavePromise) {
    state.globalPresetSavePromise = runGlobalPresetSaveLoop().finally(() => {
      state.globalPresetSavePromise = null;
    });
  }
  try {
    await state.globalPresetSavePromise;
    if (manual && !hasPendingGlobalPresetChanges()) showToast('全局默认成员池已保存', 'success');
  } catch (err) {
    if (manual) showToast(describeRpcError(err), 'error');
  }
}

export function syncGlobalSavePillVisibility() {
  const pill = document.getElementById('global-preset-save-status');
  if (pill) pill.hidden = state.settingsPane !== 'global-roles' && pill.dataset.state !== 'error' && pill.dataset.state !== 'blocked';
}

function setGlobalPresetSaveStatus(kind, text = '', detail = '') {
  const pill = document.getElementById('global-preset-save-status');
  if (!pill) return;
  const label = text || PRESET_SAVE_LABELS[kind] || '';
  pill.dataset.state = kind;
  pill.title = detail ? `${label}：${detail}` : kind === 'idle' ? '修改即时自动保存' : label;
  setText('global-preset-save-text', label);
  const retry = document.getElementById('btn-save-global-presets');
  if (retry) {
    retry.hidden = kind !== 'error';
    retry.title = detail ? `重试保存（${detail}）` : '重试保存';
  }
  clearTimeout(state.globalPresetSaveIdleTimer);
  if (kind === 'saved') {
    state.globalPresetSaveIdleTimer = setTimeout(() => {
      if (pill.dataset.state === 'saved') setGlobalPresetSaveStatus('idle');
    }, 2400);
  }
  syncGlobalSavePillVisibility();
}

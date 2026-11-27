/**
 * AgentTower Studio — 配置页：分模式阵容（简单模式 / 复杂自定义）单层勾选、模型目录手风琴、编排模式默认值、界面外观主题与扩展平台 (`ui/config-view.js`)
 */
import { deriveInteractionMode } from './permissions.js';
import { escapeHtml, formatCatalogSourceLabel, formatTimeShort, normalizeProjectPath, pathToFileUri, shortenModelName, shortenPath } from './format.js';
import { isUserInteractingWithin, setText } from './dom-guards.js';
import { CUSTOM_MODEL_PROMPT_VALUE, GLOBAL_SETTINGS_PANES, MEMBER_DRAFT_KEY, MEMBER_GROUPS, MEMBER_GROUP_IDS, MODE_PROFILE_GROUPS, MODE_PROFILE_IDS, MODE_PROFILE_LABELS, ORCHESTRATION_MODE_META, PRESET_FIELD_LABELS, PROJECT_SETTINGS_PANES, ROLE_SHORT_TITLES, SETTINGS_PANES, SETTINGS_SCOPES, SETTINGS_SCOPE_DEFAULT_PANE, SPEC_CURATION_CHANGE_LABELS, actionableSpecProposal, applySpecCurationPayload, currentOrchestrationMode, currentProjectConfig, currentProjectWorkspace, currentSpecCuration, getEffectiveConversationId, getEffectiveCwd, isCuratorBlockedProvider, isModeStageEnabled, isProjectSpecEnabled, isStatusActive, listPoolMembers, modeEnabledMembers, modeGroupProfile, modeProfileIssues, normalizeModeId, normalizeSpecArchive, orchestrationModeMeta, preferredCuratorMember, presetDisplayLabel, settingsPaneKey, settingsScopeOf, specCurationWorkspace, state } from './state.js';
import { scheduleRender } from './render.js';
import { armOrConfirm, copyPlainText, describeRpcError, relayToHostConversation, rpcCall, showToast } from './net.js';
import { isSystemUpdateTransitionState, normalizeExtensionList, normalizeProviderId, normalizeProvidersCatalog } from './normalize.js';
import { SPEC_KIND_LABELS, SPEC_WARNING_LABELS, engClass, formatCtx, formatModelDisplay, formatSpecBytes, roleTitle } from './widgets.js';
import { applyCuratorLocks, commitGlobalMemberDraft, commitMemberDraft, ensurePresetsSaved, isValidCustomPresetKey, markGlobalModeProfileDirty, markGlobalPresetDirty, markModeProfileDirty, markPresetDirty, mergeRemotePresets, newCustomPresetBase, queueGlobalPresetDelete, queuePresetDelete, roleForMemberGroup, suggestCustomPresetKey, syncCurrentProjectSpecFromGlobal, syncGlobalSavePillVisibility, syncSavePillVisibility } from './presets.js';
import { presetOptions, presetTrigger, reconcileModelSelection, remapPermissionOnProviderChange, syncComposerSelects } from './options.js';
import { openCustomModelModal } from './custom-model.js';
import { isConversationDispatchEnabled } from './stream.js';
import { refreshWorktreesList } from './worktree-view.js';

/* ========================================================================
 * 9. 🧩 AgentTower 开放平台扩展中心
 * ======================================================================== */
export async function refreshExtensionProviders(silent = false) {
  try {
    const res = await rpcCall('listExtensionProviders', {});
    const rawTpls = Array.isArray(res)
      ? res
      : res?.templates || res?.extensionTemplates || res?.builtinTemplates || state.extensionTemplates;
    const rawCustom = res?.customProviders || res?.savedProviders || state.customProviders;
    const norm = normalizeExtensionList(rawTpls, rawCustom);
    state.extensionTemplates = norm.templates;
    state.customProviders = norm.customProviders;
    state.providers = normalizeProvidersCatalog(state.providers, state.customProviders);
    syncComposerSelects();
    scheduleRender();
    if (!silent) showToast('已刷新本地 CLI 扩展探测状态', 'success');
  } catch (err) {
    if (!silent) showToast(err.message, 'error');
  }
}

export function parseArgsInput(str) {
  const s = String(str || '').trim();
  if (!s) return [];
  const tokens = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = regex.exec(s)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

export function parseModelsTextarea(text, defaultEfforts = ['low', 'medium', 'high']) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split('|').map((s) => s.trim());
    const id = parts[0];
    if (!id) continue;
    out.push({ id, name: parts[1] || id, efforts: [...defaultEfforts] });
  }
  return out;
}

export function parseEnvInput(str) {
  const env = {};
  for (const line of String(str || '').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq > 0) {
      const k = t.slice(0, eq).trim();
      const v = t.slice(eq + 1).trim();
      if (k) env[k] = v;
    }
  }
  return env;
}

export async function quickEnableTemplateProvider(tplId) {
  const tpl = state.extensionTemplates.find((t) => t.id === tplId);
  if (!tpl) return;
  try {
    await rpcCall('saveExtensionProvider', {
      id: tpl.id,
      name: tpl.name,
      displayName: tpl.name,
      protocol: tpl.protocol,
      driverKind: tpl.protocol === 'cli' ? 'generic-cli' : 'generic-acp',
      command: tpl.command,
      args: tpl.args || [],
      argsTemplate: tpl.argsTemplate || undefined,
      models: tpl.defaultModels || [{ id: 'default', name: `${tpl.name} 默认模型` }],
      efforts: tpl.efforts || ['low', 'medium', 'high'],
      enabled: true,
    });
    await refreshExtensionProviders(true);
    const caps = await rpcCall('getCapabilities', { refresh: true }).catch(() => null);
    if (caps?.providers) {
      state.providers = normalizeProvidersCatalog(caps.providers, state.customProviders);
    }
    syncComposerSelects();
    scheduleRender();
    showToast(`✅ 已启用扩展平台 ${tpl.name}，立即生效于控制台下拉框`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export async function removeOrDisableExtension(extId) {
  if (!extId) return;
  try {
    await rpcCall('removeExtensionProvider', { id: extId });
    document.getElementById('ext-modal-backdrop').hidden = true;
    state.customProviders = state.customProviders.filter((c) => c.id !== extId);
    const tpl = state.extensionTemplates.find((t) => t.id === extId);
    if (tpl) tpl.enabled = false;
    const caps = await rpcCall('getCapabilities', { refresh: true }).catch(() => null);
    state.providers = normalizeProvidersCatalog(caps?.providers || null, state.customProviders);
    syncComposerSelects();
    scheduleRender();
    showToast(`已停用扩展平台 ${extId}`, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function rosterCtx(scope = 'project') {
  if (scope === 'global') {
    return {
      scope: 'global',
      presets: state.globalPresets,
      modeProfiles: state.globalModeProfiles,
      pendingDeletes: state.globalPendingDeletes,
      collapsedGroups: state.globalCollapsedGroups,
      getEditingMode: () => (MODE_PROFILE_IDS.includes(state.globalEditingModeProfile) ? state.globalEditingModeProfile : 'complex'),
      setEditingMode: (m) => { state.globalEditingModeProfile = m; },
      getOpenMemberKey: () => state.globalOpenMemberKey,
      setOpenMemberKey: (k) => { state.globalOpenMemberKey = k; },
      getDraftKeyTouched: () => state.globalMemberDraftKeyTouched,
      setDraftKeyTouched: (v) => { state.globalMemberDraftKeyTouched = v; },
      markPresetDirty: markGlobalPresetDirty,
      markModeProfileDirty: markGlobalModeProfileDirty,
      queuePresetDelete: queueGlobalPresetDelete,
      commitMemberDraft: commitGlobalMemberDraft,
      idPrefix: 'global-',
      fkPrefix: 'global:',
      confirmPrefix: 'global-member-del:',
    };
  }
  return {
    scope: 'project',
    presets: state.presets,
    modeProfiles: state.modeProfiles,
    pendingDeletes: state.pendingDeletes,
    collapsedGroups: state.collapsedGroups,
    getEditingMode: () => editingModeProfile(),
    setEditingMode: (m) => { state.editingModeProfile = m; },
    getOpenMemberKey: () => state.openMemberKey,
    setOpenMemberKey: (k) => { state.openMemberKey = k; },
    getDraftKeyTouched: () => state.memberDraftKeyTouched,
    setDraftKeyTouched: (v) => { state.memberDraftKeyTouched = v; },
    markPresetDirty,
    markModeProfileDirty,
    queuePresetDelete,
    commitMemberDraft,
    idPrefix: '',
    fkPrefix: '',
    confirmPrefix: 'member-del:',
  };
}

export function editRolePreset(key, field, value, scope = 'project') {
  if (field === 'label') {
    setMemberLabel(key, value, scope);
    return;
  }
  const ctx = rosterCtx(scope);
  const cfg = ctx.presets[key];
  if (!cfg || !presetOptions(cfg, field).some(o => o.value === value && !o.disabled)) return;
  const curator = cfg.group === 'curator';
  if (curator && field === 'provider' && isCuratorBlockedProvider(value)) {
    showToast('该引擎标识不可用于规范维护组，请选择外部 CLI 或宿主原生引擎', 'error');
    return;
  }
  if (curator && (field === 'permissionMode' || field === 'isolation')) {
    showToast('规范维护官恒为只读提案：权限与目录隔离跟随引擎自动锁定', 'info');
    return;
  }
  const commit = (next) => {
    const current = ctx.presets[key];
    if (!current) return;
    const previous = { ...current };
    if (field === 'provider' && current.provider !== next) current.model = '';
    current[field] = next;
    // 换引擎：权限按跨引擎安全映射携带（绝不自动落到高危档）；改权限：同步 Plan 交互
    if (field === 'provider') remapPermissionOnProviderChange(current, previous.provider);
    if (field === 'permissionMode') {
      current.interactionMode = deriveInteractionMode(current.permissionMode);
      if (Object.hasOwn(current, 'runtimeMode')) current.runtimeMode = current.permissionMode;
    }
    reconcileModelSelection(current);
    // 规范维护组：换引擎后权限重新锁定为该引擎的只读档（Codex read-only / 其余 plan）+ Plan 交互 + 共享目录
    if (current.group === 'curator') applyCuratorLocks(current);
    ctx.markPresetDirty(key, Object.keys(current).filter(f => previous[f] !== current[f]));
    scheduleRender();
  };
  if (field === 'model' && value === CUSTOM_MODEL_PROMPT_VALUE) {
    const provider = cfg.provider;
    openCustomModelModal({ providerId: provider, previousModel: cfg.model, onApply: id => {
      if (ctx.presets[key]?.provider === provider) commit(id);
      else showToast('引擎已变化，请重新选择自定义模型', 'error');
    } });
  } else commit(value);
}
export function editGlobalRolePreset(key, field, value) {
  return editRolePreset(key, field, value, 'global');
}
/* ---------- 配置视图（项目配置 3 子页 + 全局配置 4 子页） ----------
 * 渲染约束：
 * 1. 每次 scheduleRender 都会进入这里；innerHTML 护栏让"字符串不变即跳过"，因此展开 / 过滤这类
 *    纯视图态在每次渲染后由 applyCatalogFilter / applyExtLibState 重新施加到 DOM（也能触发 CSS 过渡）。
 * 2. 焦点在 INPUT/SELECT/TEXTAREA（目录搜索框 / 成员显示名）时只刷新二级导航，不重写分区内容。
 * 3. 分区内容被重写时，借 data-fk 把焦点还给"同一个"控件，键盘用户不会丢焦点。
 */
/* ---------- v0.1.1 分模式阵容：单层勾选 / ★ 首选 / 阶段总开关 / ⋯ 共享参数抽屉 / 新增与删除 ----------
 * v0.2.2 全成员平权：不再区分内置 / 自定义，任何成员均可删除，不再提供「恢复默认」黄金等级。 */
function groupMetaOf(group) {
  return MEMBER_GROUPS.find((g) => g.id === group) || null;
}
const GROUP_NOUNS = { advisor: '军师', executor: '执行官', reviewer: '评审官', curator: '维护官' };
/** 配置页当前编辑的阵容：首次进入时当前对话为复杂模式则编辑复杂阵容，否则编辑简单模式阵容（纯 UI 态，不改对话模式）。 */
export function editingModeProfile() {
  if (!MODE_PROFILE_IDS.includes(state.editingModeProfile)) {
    state.editingModeProfile = currentOrchestrationMode() === 'complex' ? 'complex' : 'relay';
  }
  return state.editingModeProfile;
}
export function editingGlobalModeProfile() {
  if (!MODE_PROFILE_IDS.includes(state.globalEditingModeProfile)) {
    state.globalEditingModeProfile = 'complex';
  }
  return state.globalEditingModeProfile;
}
export function setEditingModeProfile(mode, scope = 'project') {
  const ctx = rosterCtx(scope);
  if (!MODE_PROFILE_IDS.includes(mode) || ctx.getEditingMode() === mode) return;
  ctx.setEditingMode(mode);
  ctx.setOpenMemberKey('');
  // 切换阵容时丢弃另一阵容里未确认的新增草稿所属组（简单模式只有执行组）
  const draft = ctx.presets[MEMBER_DRAFT_KEY];
  if (draft && !MODE_PROFILE_GROUPS[mode].includes(draft.group)) delete ctx.presets[MEMBER_DRAFT_KEY];
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}scope:${mode}`] };
  scheduleRender();
}
export function setGlobalEditingModeProfile(mode) {
  return setEditingModeProfile(mode, 'global');
}
/** 单层勾选：控制 modeProfiles[mode][group].enabledKeys；执行组保护最后 1 名勾选成员。 */
export function toggleModeMember(mode, group, key, scope = 'project') {
  const ctx = rosterCtx(scope);
  const entry = ctx.modeProfiles?.[mode]?.[group];
  const p = ctx.presets[key];
  if (!entry || !p || key === MEMBER_DRAFT_KEY) return;
  const checked = entry.enabledKeys.includes(key);
  if (checked && group === 'executor' && modeEnabledMembers(mode, group, scope).length <= 1) {
    showToast('至少保留 1 名执行官', 'error');
    return;
  }
  entry.enabledKeys = checked ? entry.enabledKeys.filter((k) => k !== key) : [...entry.enabledKeys, key];
  if (checked && entry.preferredKey === key) entry.preferredKey = entry.enabledKeys[0] || null;
  if (!checked && group !== 'advisor' && !entry.preferredKey) entry.preferredKey = key;
  // 旧版全局停用的成员被勾选进阵容时同步恢复启用，避免守护进程按旧语义拒派
  if (!checked && p.enabled === false) {
    p.enabled = true;
    ctx.markPresetDirty(key, ['enabled']);
  }
  ctx.markModeProfileDirty(mode, group);
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}check:${mode}:${key}`] };
  scheduleRender();
}
export function toggleGlobalModeMember(mode, group, key) {
  return toggleModeMember(mode, group, key, 'global');
}
/** ★ 首选：仅已勾选成员可设（执行组 / 评审组）。 */
export function setModePreferred(mode, group, key, scope = 'project') {
  const ctx = rosterCtx(scope);
  const entry = ctx.modeProfiles?.[mode]?.[group];
  if (!entry || !groupMetaOf(group)?.starrable || entry.preferredKey === key) return;
  if (!entry.enabledKeys.includes(key)) {
    showToast('仅已勾选成员可设为首选 ★，请先勾选该成员', 'error');
    return;
  }
  entry.preferredKey = key;
  ctx.markModeProfileDirty(mode, group);
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}star:${mode}:${key}`] };
  scheduleRender();
  showToast(`${scope === 'global' ? '全局默认模板 · ' : ''}${MODE_PROFILE_LABELS[mode]}·${groupMetaOf(group).title}首选 ★ 已改为「${presetDisplayLabel(key, scope)}」`, 'success');
}
export function setGlobalModePreferred(mode, group, key) {
  return setModePreferred(mode, group, key, 'global');
}
/** 复杂阵容军师 / 审核阶段总开关：关闭仅跳过该阶段，组内勾选状态原样保留。 */
export function toggleModeStage(mode, group, scope = 'project') {
  const ctx = rosterCtx(scope);
  const entry = ctx.modeProfiles?.[mode]?.[group];
  if (mode !== 'complex' || group === 'executor' || !entry) return;
  entry.stageEnabled = entry.stageEnabled === false;
  ctx.markModeProfileDirty(mode, group);
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}stage:${group}`, `${ctx.fkPrefix}flow:${group}`] };
  scheduleRender();
}
export function toggleGlobalModeStage(mode, group) {
  return toggleModeStage(mode, group, 'global');
}
export function toggleMemberDrawer(key, scope = 'project') {
  const ctx = rosterCtx(scope);
  ctx.setOpenMemberKey(ctx.getOpenMemberKey() === key ? '' : key);
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}more:${key}`] };
  scheduleRender();
}
export function toggleGlobalMemberDrawer(key) {
  return toggleMemberDrawer(key, 'global');
}
export function togglePoolGroup(group, scope = 'project') {
  const ctx = rosterCtx(scope);
  if (ctx.collapsedGroups.has(group)) ctx.collapsedGroups.delete(group);
  else ctx.collapsedGroups.add(group);
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}pool-toggle:${group}`] };
  scheduleRender();
}
export function toggleGlobalPoolGroup(group) {
  return togglePoolGroup(group, 'global');
}
export function setMemberLabel(key, value, scope = 'project') {
  const ctx = rosterCtx(scope);
  const p = ctx.presets[key];
  const label = String(value || '').trim().slice(0, 40);
  if (!p || !label || p.label === label) return;
  p.label = label;
  p.title = label;
  ctx.markPresetDirty(key, ['label', 'title']);
  scheduleRender();
}
export function setGlobalMemberLabel(key, value) {
  return setMemberLabel(key, value, 'global');
}
export function deleteCustomMember(key, scope = 'project') {
  const ctx = rosterCtx(scope);
  const p = ctx.presets[key];
  if (!p) return;
  const suffix = scope === 'global' ? '（仅影响全局默认模板，不影响已独立定制的项目）' : '（在途与历史线程保留原引擎 / 模型快照）';
  if (!armOrConfirm(`${ctx.confirmPrefix}${key}`, `再次点击确认删除「${p.label || key}」${suffix}`)) return;
  ctx.queuePresetDelete(key);
  scheduleRender();
  showToast(`已删除${scope === 'global' ? '全局模板' : ''}成员「${p.label || key}」`, 'success');
}
export function deleteGlobalCustomMember(key) {
  return deleteCustomMember(key, 'global');
}
export function startAddMember(group, scope = 'project') {
  if (!groupMetaOf(group)) return;
  const ctx = rosterCtx(scope);
  const mode = ctx.getEditingMode();
  const target = MODE_PROFILE_GROUPS[mode].includes(group) ? group : 'executor';
  ctx.presets[MEMBER_DRAFT_KEY] = { ...newCustomPresetBase(target, MEMBER_DRAFT_KEY, scope), draftKey: suggestCustomPresetKey('', target, scope) };
  ctx.setDraftKeyTouched(false);
  ctx.collapsedGroups.delete(target);
  ctx.setOpenMemberKey('');
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}draft:label`], scroll: true };
  scheduleRender();
}
export function startAddGlobalMember(group) {
  return startAddMember(group, 'global');
}
/** 草稿表单内输入框仍持有焦点时，配置页会暂停重绘（isUserInteractingWithin）；提交 / 取消前先释放焦点。 */
function releaseDraftFocus() {
  const ae = document.activeElement;
  if (ae && ae.closest?.('[data-member-draft]')) ae.blur();
}
export function cancelAddMember(scope = 'project') {
  const ctx = rosterCtx(scope);
  releaseDraftFocus();
  delete ctx.presets[MEMBER_DRAFT_KEY];
  ctx.setDraftKeyTouched(false);
  scheduleRender();
}
export function cancelAddGlobalMember() {
  return cancelAddMember('global');
}
/** 草稿输入：显示名驱动键名自动生成（用户手动改过键名后不再覆盖）；只改 state 与草稿区 DOM，不触发整页重绘。 */
export function updateMemberDraftField(field, value, scope = 'project') {
  const ctx = rosterCtx(scope);
  const draft = ctx.presets[MEMBER_DRAFT_KEY];
  if (!draft) return;
  if (field === 'label') {
    draft.label = String(value || '').slice(0, 40);
    if (!ctx.getDraftKeyTouched()) {
      draft.draftKey = suggestCustomPresetKey(draft.label, draft.group, scope);
      const keyInput = document.getElementById(`${ctx.idPrefix}member-draft-key`);
      if (keyInput && keyInput.value !== draft.draftKey) keyInput.value = draft.draftKey;
    }
  } else if (field === 'key') {
    ctx.setDraftKeyTouched(true);
    draft.draftKey = String(value || '').trim().toLowerCase();
  }
  const errEl = document.getElementById(`${ctx.idPrefix}member-draft-error`);
  if (errEl) errEl.hidden = true;
}
export function updateGlobalMemberDraftField(field, value) {
  return updateMemberDraftField(field, value, 'global');
}
export function setMemberDraftGroup(group, scope = 'project') {
  const ctx = rosterCtx(scope);
  const draft = ctx.presets[MEMBER_DRAFT_KEY];
  const meta = groupMetaOf(group);
  if (!draft || !meta || draft.group === group || !MODE_PROFILE_GROUPS[ctx.getEditingMode()].includes(group)) return;
  draft.group = group;
  draft.role = roleForMemberGroup(group);
  if (group === 'curator') {
    applyCuratorLocks(draft);
    reconcileModelSelection(draft);
  }
  // 键名跟随组前缀（用户手动改过键名后不再覆盖）
  if (!ctx.getDraftKeyTouched()) draft.draftKey = suggestCustomPresetKey(draft.label, group, scope);
  ctx.collapsedGroups.delete(group);
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}draft-group:${group}`] };
  scheduleRender();
}
export function setGlobalMemberDraftGroup(group) {
  return setMemberDraftGroup(group, 'global');
}
function memberDraftError(draft, scope = 'project') {
  const ctx = rosterCtx(scope);
  const label = String(draft.label || '').trim();
  const key = String(draft.draftKey || '');
  if (!label) return '请填写成员显示名';
  if (!isValidCustomPresetKey(key)) return '成员键需以小写字母开头，仅含小写字母/数字/下划线/连字符（3~64 位），且不可使用系统保留词';
  if (ctx.presets[key] && !ctx.pendingDeletes.has(key)) return `成员键 ${key} 已存在，请换一个`;
  if (!draft.provider || !draft.model) return '请选择引擎与模型';
  if (draft.group === 'curator' && isCuratorBlockedProvider(draft.provider)) return '该引擎标识不可用于规范维护组，请选择外部 CLI 或宿主原生引擎';
  return '';
}
export function confirmAddMember(scope = 'project') {
  const ctx = rosterCtx(scope);
  const draft = ctx.presets[MEMBER_DRAFT_KEY];
  if (!draft) return;
  const error = memberDraftError(draft, scope);
  if (error) {
    const errEl = document.getElementById(`${ctx.idPrefix}member-draft-error`);
    if (errEl) { errEl.textContent = error; errEl.hidden = false; }
    showToast(error, 'error');
    return;
  }
  const key = draft.draftKey;
  const group = draft.group;
  const mode = ctx.getEditingMode();
  releaseDraftFocus();
  ctx.pendingDeletes.delete(key);
  delete draft.draftKey;
  // 确认即自动勾选进当前编辑阵容对应组，与成员对象同一次 saveSettings 提交
  ctx.commitMemberDraft(key, mode);
  state.pendingSettingsFocus = { keys: [`${ctx.fkPrefix}check:${mode}:${key}`], scroll: true };
  scheduleRender();
  showToast(`已新增${scope === 'global' ? '全局模板' : ''}${groupMetaOf(group)?.title || ''}成员「${ctx.presets[key]?.label || key}」，并勾选进${MODE_PROFILE_LABELS[mode]}`, 'success');
}
export function confirmAddGlobalMember() {
  return confirmAddMember('global');
}


/** 切换二级面板：同步作用域与顶层配置视图（roles/project/cache → settings，general/global-roles/extensions/catalog → global）。 */
export function setSettingsPane(pane, { resetScroll = true } = {}) {
  if (!SETTINGS_PANES.includes(pane)) return;
  state.settingsPane = pane;
  state.settingsScope = settingsScopeOf(pane);
  state.settingsScopePanes[state.settingsScope] = pane;
  if (state.activeView === 'settings' || state.activeView === 'global') {
    const targetView = state.settingsScope === 'global' ? 'global' : 'settings';
    state.activeView = targetView;
    const appEl = document.getElementById('studio-app');
    if (appEl && appEl.dataset.view !== targetView) appEl.dataset.view = targetView;
    const vs = document.getElementById('view-settings');
    const vg = document.getElementById('view-global');
    if (vs) vs.hidden = targetView !== 'settings';
    if (vg) vg.hidden = targetView !== 'global';
  }
  try { sessionStorage.setItem(settingsPaneKey(), pane); } catch { /* Storage is optional. */ }
  if (resetScroll) {
    state.mainScrollResetPending = true;
    const area = document.getElementById('studio-main');
    if (area) area.scrollTop = 0;
  }
  renderSettingsSubnav();
  scheduleRender();
}
/** 一级作用域切换（兼容保留）：回到该作用域上次停留的二级面板（默认 roles / general）。 */
export function setSettingsScope(scope, opts) {
  if (!SETTINGS_SCOPES.includes(scope)) return;
  const remembered = state.settingsScopePanes[scope];
  setSettingsPane(settingsScopeOf(remembered) === scope ? remembered : SETTINGS_SCOPE_DEFAULT_PANE[scope], opts);
}
/** 「前往项目规范」：切到 project 面板并把项目规范卡片滚入视野（等置顶复位之后）。 */
export function gotoProjectSpecsSection() {
  setSettingsPane('project', { resetScroll: false });
  const scrollIn = () => document.getElementById('project-specs-section')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  requestAnimationFrame(() => requestAnimationFrame(scrollIn));
}
export function gotoRolePreset(key) {
  const group = state.presets[key]?.group;
  if (group) state.collapsedGroups.delete(group);
  // 简单模式阵容只有执行组：跳转军师 / 评审成员时切到复杂阵容编辑
  if (group && !MODE_PROFILE_GROUPS[editingModeProfile()].includes(group)) state.editingModeProfile = 'complex';
  state.openMemberKey = key;
  state.pendingSettingsFocus = { keys: [`ps:${key}:model`, `ps:${key}:provider`, `more:${key}`], scroll: true };
  setSettingsPane('roles', { resetScroll: false });
}

function setHtmlKeepingFocus(el, html, afterSet) {
  const ae = document.activeElement;
  const key = ae && ae !== document.body && el.contains(ae) ? ae.dataset?.fk || '' : '';
  el.innerHTML = html;
  afterSet?.();
  if (key && !el.contains(document.activeElement)) {
    el.querySelector(`[data-fk="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }
}
function flushPendingSettingsFocus() {
  if (!state.pendingSettingsFocus) return;
  const { keys, scroll } = state.pendingSettingsFocus;
  state.pendingSettingsFocus = null;
  const roots = state.activeView === 'global' ? ['#view-global', '#view-settings'] : ['#view-settings', '#view-global'];
  for (const key of keys) {
    for (const root of roots) {
      const el = document.querySelector(`${root} [data-fk="${CSS.escape(key)}"]`);
      if (!el || el.closest('[hidden]')) continue;
      el.focus({ preventScroll: true });
      if (scroll) (el.closest('.pool-drawer, .pool-draft, .pool-row') || el).scrollIntoView?.({ block: 'center' });
      return;
    }
  }
}

export function renderSettingsView() {
  if (state.activeView === 'global' || GLOBAL_SETTINGS_PANES.includes(state.settingsPane)) {
    renderGlobalSettingsView();
    return;
  }
  if (!PROJECT_SETTINGS_PANES.includes(state.settingsPane)) {
    const remembered = state.settingsScopePanes.project;
    state.settingsPane = PROJECT_SETTINGS_PANES.includes(remembered) ? remembered : 'roles';
    state.settingsScope = 'project';
    state.settingsScopePanes.project = state.settingsPane;
  }
  renderSettingsSubnav();
  if (isUserInteractingWithin(document.getElementById('view-settings'))) return;
  if (state.settingsPane === 'project') renderProjectPane();
  else if (state.settingsPane === 'cache') renderCachePane();
  else renderRolesPane();
  flushPendingSettingsFocus();
}

export function renderGlobalSettingsView() {
  if (!GLOBAL_SETTINGS_PANES.includes(state.settingsPane)) {
    const remembered = state.settingsScopePanes.global;
    state.settingsPane = GLOBAL_SETTINGS_PANES.includes(remembered) ? remembered : 'general';
    state.settingsScope = 'global';
    state.settingsScopePanes.global = state.settingsPane;
  }
  renderSettingsSubnav();
  if (isUserInteractingWithin(document.getElementById('view-global'))) return;
  if (state.settingsPane === 'global-roles') renderGlobalRolesPane();
  else if (state.settingsPane === 'extensions') renderExtensionsPane();
  else if (state.settingsPane === 'catalog') renderCatalogPane();
  else renderGeneralPane();
  flushPendingSettingsFocus();
}

/** 当前项目名徽标文案（未绑定对话 / 无工作区时提示未绑定）。 */
function projectNameInfo() {
  const ws = currentProjectWorkspace();
  if (!ws) return { bound: false, name: '未绑定项目', title: '当前对话未绑定项目目录：成员池修改将写入全局默认模板' };
  const name = ws.split('/').filter(Boolean).pop() || ws;
  return { bound: true, name, title: ws };
}

function renderSettingsSubnav() {
  const pane = state.settingsPane;
  const scope = settingsScopeOf(pane);
  state.settingsScope = scope;

  const badge = document.getElementById('settings-scope-project-name');
  if (badge) {
    const info = projectNameInfo();
    setText('settings-scope-project-name', info.name);
    badge.title = info.title;
    badge.classList.toggle('is-unbound', !info.bound);
  }
  document.querySelectorAll('#settings-subnav [data-settings-pane]').forEach((btn) => {
    if (!PROJECT_SETTINGS_PANES.includes(btn.dataset.settingsPane)) return;
    const on = btn.dataset.settingsPane === pane;
    btn.setAttribute('aria-pressed', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll('#global-settings-subnav [data-settings-pane]').forEach((btn) => {
    if (!GLOBAL_SETTINGS_PANES.includes(btn.dataset.settingsPane)) return;
    const on = btn.dataset.settingsPane === pane;
    btn.setAttribute('aria-pressed', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  for (const p of SETTINGS_PANES) {
    const el = document.getElementById(`settings-pane-${p}`);
    if (el) el.hidden = p !== pane;
  }
  const count = document.getElementById('settings-catalog-count');
  if (count) {
    setText('settings-catalog-count', String(state.providers.length));
    count.hidden = !state.providers.length;
  }
  const dot = document.getElementById('settings-general-dot');
  if (dot) dot.hidden = isConversationDispatchEnabled();
  syncSavePillVisibility();
  syncGlobalSavePillVisibility();
}

/* ----- 【项目配置】子页 1：分模式阵容（简单模式阵容 | 复杂自定义阵容），按项目独立保存 ----- */
function renderRolesGridForScope(gridId, scope) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  const ctx = rosterCtx(scope);
  const mode = ctx.getEditingMode();
  if (grid.dataset.scope !== mode) grid.dataset.scope = mode;
  const issues = modeProfileIssues(mode, scope);
  const groupHtml = (id) => renderPoolGroupHtml(groupMetaOf(id), mode, issues.filter((i) => i.group === id), scope);
  // 三阶段派发组并排；规范维护组（复杂阵容第 4 组）为会后只读收尾，独占下方整行，不挤占三栏
  const columns = MODE_PROFILE_GROUPS[mode].filter((id) => id !== 'curator').map(groupHtml).join('');
  const curatorRow = MODE_PROFILE_GROUPS[mode].includes('curator')
    ? `<div class="pool-curator-row" data-scope="${mode}">${groupHtml('curator')}</div>`
    : '';
  if (scope === 'project' && curatorRow) ensureSpecCurationStatus();
  setHtmlKeepingFocus(grid, `${renderModeScopeBarHtml(mode, scope)}${renderModeFlowHtml(mode, scope)}<div class="pool-columns" data-scope="${mode}">${columns}</div>${curatorRow}`);
}

function renderRolesPane() {
  renderRolesGridForScope('role-presets-grid', 'project');
  // v0.2.2 已废除内置黄金默认等级：「恢复全部默认」常驻隐藏
  const resetBtn = document.getElementById('btn-reset-presets');
  if (resetBtn && !resetBtn.hidden) resetBtn.hidden = true;
  renderRosterSourceHead();
}

/* ----- 【全局配置】子页 2：默认成员池（直接可编辑分组卡片，保存至 scope: 'global'） ----- */
function renderGlobalRolesPane() {
  renderGlobalRosterTemplateSection();
  renderRolesGridForScope('global-role-presets-grid', 'global');
}

/**
 * 成员池面板头：阵容来源徽标（独立项目阵容 / 全局默认模板初值 / 未绑定项目）+ 同步为全局默认 / 恢复为全局默认（均二次确认）。
 * 旧守护进程未下发 projectConfig 时按工作区推断为「全局默认模板初值」。
 */
function renderRosterSourceHead() {
  const cfg = currentProjectConfig();
  const info = projectNameInfo();
  const source = !info.bound ? 'unbound' : cfg?.rosterSource === 'project' || cfg?.rosterCustomized ? 'project' : 'global_template';
  const badge = document.getElementById('project-roster-source-badge');
  if (badge) {
    const label = { project: '独立项目阵容', global_template: '全局默认模板初值', unbound: '未绑定项目' }[source];
    setText('project-roster-source-badge', label);
    badge.className = `set-source-badge is-${source === 'global_template' ? 'template' : source}`;
    badge.title = source === 'project'
      ? `「${info.name}」已保存独立成员池与阵容，与其他项目互不影响`
      : source === 'global_template'
        ? `「${info.name}」尚未独立定制，当前沿用全局默认模板；首次修改即保存为本项目独立阵容`
        : '当前未绑定项目目录：成员池修改将写入全局默认模板';
  }
  const busy = state.rosterActionBusy;
  const syncBtn = document.getElementById('btn-sync-roster-to-global');
  if (syncBtn) {
    const armed = (state.pendingConfirms.get('roster:sync-global') || 0) > Date.now();
    syncBtn.hidden = !info.bound;
    syncBtn.disabled = Boolean(busy);
    syncBtn.classList.toggle('is-armed', armed);
    const label = busy === 'sync' ? '同步中…' : armed ? '确认同步为全局默认？' : '⬆ 同步为全局默认配置';
    if (syncBtn.textContent !== label) syncBtn.textContent = label;
  }
  const resetRoster = document.getElementById('btn-reset-roster-to-global');
  if (resetRoster) {
    const armed = (state.pendingConfirms.get('roster:reset-global') || 0) > Date.now();
    resetRoster.hidden = !info.bound || source !== 'project';
    resetRoster.disabled = Boolean(busy);
    resetRoster.classList.toggle('is-armed', armed);
    const label = busy === 'reset' ? '恢复中…' : armed ? '确认恢复为全局默认？' : '↺ 恢复为全局默认';
    if (resetRoster.textContent !== label) resetRoster.textContent = label;
  }
}

/** ⬆ 同步为全局默认 / ↺ 恢复为全局默认：仅成员池与模式阵容（不含 Spec 开关 / 配额 / 凭据），二次确认后经 saveSettings action 执行。 */
async function runRosterTemplateAction(kind) {
  if (state.rosterActionBusy) return false;
  const workspace = currentProjectWorkspace();
  if (!workspace) {
    showToast('当前未绑定项目目录，无法同步 / 恢复项目阵容', 'info');
    return false;
  }
  const sync = kind === 'sync';
  const confirmKey = sync ? 'roster:sync-global' : 'roster:reset-global';
  const prompt = sync
    ? '再次点击确认：将本项目成员池与阵容同步为全局默认模板（仅供之后新项目继承，不覆盖其他已独立配置的项目，不含项目规范开关与配额）'
    : '再次点击确认：丢弃本项目独立成员池，恢复为当前全局默认模板';
  if (!armOrConfirm(confirmKey, prompt)) {
    renderRosterSourceHead();
    return false;
  }
  state.rosterActionBusy = kind;
  renderRosterSourceHead();
  try {
    // 先把本项目待保存修改落盘，避免同步 / 恢复与在途草稿交错
    if (!(await ensurePresetsSaved())) return false;
    const res = await rpcCall('saveSettings', { action: sync ? 'syncProjectToGlobal' : 'resetProjectToGlobal', workspace, cwd: workspace });
    if (currentProjectWorkspace() === workspace) mergeRemotePresets(res || {});
    showToast(sync ? '已将本项目成员池与阵容同步为全局默认模板，之后的新项目将以此为初值' : '已恢复为全局默认模板（本项目独立阵容已重置）', 'success');
    return true;
  } catch (err) {
    showToast(`${sync ? '同步为全局默认' : '恢复为全局默认'}失败：${describeRpcError(err)}`, 'error');
    return false;
  } finally {
    state.rosterActionBusy = '';
    scheduleRender();
  }
}
export function handleSyncRosterToGlobal() {
  return runRosterTemplateAction('sync');
}
export function handleResetRosterToGlobal() {
  return runRosterTemplateAction('reset');
}

function renderModeScopeBarHtml(mode, scope = 'project') {
  const ctx = rosterCtx(scope);
  const live = scope === 'project' ? currentOrchestrationMode() : '';
  const btns = MODE_PROFILE_IDS.map((id) => `<button type="button" class="seg-btn" role="radio" aria-checked="${id === mode}" tabindex="${id === mode ? 0 : -1}" data-mode-scope="${id}" data-fk="${ctx.fkPrefix}scope:${id}">${escapeHtml(MODE_PROFILE_LABELS[id])}${id === live ? '<span class="mode-scope-live" title="当前对话正在使用该模式">使用中</span>' : ''}</button>`).join('');
  const hint = scope === 'global' ? '配置新项目默认继承的成员与阵容' : '切换下方编辑的阵容，不改变当前对话模式';
  return `<div class="mode-scope-bar">
      <div class="seg seg--scope" role="radiogroup" aria-label="编辑哪套阵容" title="${escapeHtml(hint)}">${btns}</div>
    </div>`;
}

function renderModeFlowHtml(mode, scope = 'project') {
  const ctx = rosterCtx(scope);
  if (mode === 'relay') return '';
  const stage = (group) => {
    const meta = groupMetaOf(group);
    const on = isModeStageEnabled('complex', group, scope);
    return `<button type="button" class="mode-flow-stage${on ? ' is-on' : ' is-off'}" data-mode-stage-toggle="${group}" data-fk="${ctx.fkPrefix}flow:${group}" aria-pressed="${on}" title="${escapeHtml(`${meta.stageTitle}：${on ? '已开启（点击关闭，组内勾选保留）' : '已跳过（点击开启）'}`)}">${escapeHtml(meta.stageTitle)} <span class="mode-flow-state">${on ? '开' : '关'}</span></button>`;
  };
  let curation;
  if (scope === 'global') {
    curation = '<span class="mode-flow-stage is-curation is-fixed" title="新项目开启项目规范后继承本组维护官；自动维护开关按项目独立设置">规范维护 <span class="mode-flow-state">按项目</span></span>';
  } else {
    const cur = currentSpecCuration();
    const autoOn = cur.autoTrigger;
    const autoBusy = state.specCurationUi.busy === 'auto';
    curation = !isProjectSpecEnabled()
      ? `<button type="button" class="mode-flow-stage is-curation is-off is-spec-off" data-curation-auto-toggle data-fk="flow:curator" aria-pressed="false" disabled aria-disabled="true"
          title="本项目未开启项目规范（Spec），规范维护官已停用 · 前往「项目规范」开启">规范维护<span class="mode-flow-scope">（本项目）</span> <span class="mode-flow-state">已停用</span></button>`
      : `<button type="button" class="mode-flow-stage is-curation${autoOn ? ' is-on' : ' is-off'}" data-curation-auto-toggle data-fk="flow:curator" aria-pressed="${autoOn}"${autoBusy ? ' disabled aria-busy="true"' : ''}
          title="${escapeHtml(`规范维护（本项目）：自动维护${autoOn ? '已开启（点击关闭，手动「✨ 维护规范」不受影响）' : '已关闭（点击开启：宿主收口后有新干活时自动只读梳理 1 次）'}`)}">规范维护<span class="mode-flow-scope">（本项目）</span> <span class="mode-flow-state">${autoOn ? '自动' : '手动'}</span></button>`;
  }
  return `<div class="mode-flow" data-mode-flow="complex" role="group" aria-label="复杂自定义三阶段可用上限与会后规范维护">
      ${stage('advisor')}<span class="mode-flow-arrow" aria-hidden="true">→</span>
      <span class="mode-flow-stage is-fixed">执行阶段 <span class="mode-flow-state">按需</span></span><span class="mode-flow-arrow" aria-hidden="true">→</span>
      ${stage('reviewer')}<span class="mode-flow-arrow" aria-hidden="true">→</span>
      ${curation}
    </div>`;
}

/** 规范维护组卡头 / 阶段栏共用的「自动维护（本项目）」开关：读写同一项目级状态 currentSpecCuration().autoTrigger。 */
function curationAutoSwitchHtml(fk) {
  const specOn = isProjectSpecEnabled();
  const on = specOn && currentSpecCuration().autoTrigger;
  const busy = state.specCurationUi.busy === 'auto';
  const title = !specOn ? '本项目未开启项目规范（Spec），自动维护不可用' : on ? '本项目自动维护已开启（点击关闭）' : '本项目自动维护已关闭（点击开启）';
  return `<button type="button" class="set-switch pool-stage-switch ps-curation-switch${on ? ' is-on' : ''}" role="switch" aria-checked="${on}" data-curation-auto-toggle data-fk="${fk}"${busy || !specOn ? ' disabled' : ''}${busy ? ' aria-busy="true"' : ''}
        aria-label="本项目自动维护规范" title="${escapeHtml(title)}"><span class="set-switch-track" aria-hidden="true"><span class="set-switch-thumb"></span></span></button>`;
}

function renderCuratorGroupHtml(group, mode, issues, scope = 'project') {
  const ctx = rosterCtx(scope);
  const members = listPoolMembers(group.id, scope);
  const checkedCount = modeEnabledMembers(mode, group.id, scope).length;
  const collapsed = ctx.collapsedGroups.has(group.id);
  const gid = escapeHtml(group.id);
  const draft = ctx.presets[MEMBER_DRAFT_KEY];
  if (scope === 'global') {
    const draftHere = draft && draft.group === group.id;
    const bodyHtml = collapsed ? '' : `${draftHere ? renderMemberDraftHtml(draft, mode, scope) : ''}
      <div class="set-group pool-list">${members.length ? members.map((p) => renderMemberRowHtml(p, group, mode, checkedCount, scope)).join('') : '<p class="pool-curator-empty">暂无规范维护官：点击「+ 添加」选择外部 CLI 或宿主原生引擎，恒为只读提案</p>'}</div>`;
    return `<section class="pool-group pool-group--curator${collapsed ? ' is-collapsed' : ''}" data-role-group="${gid}" data-pool-group="${gid}" data-mode-scope-group="${mode}" aria-label="${escapeHtml(group.title)}">
        <div class="pool-group-head">
          <button type="button" class="pool-group-toggle" data-pool-toggle="${gid}" data-fk="${ctx.fkPrefix}pool-toggle:${gid}" aria-expanded="${!collapsed}" title="${escapeHtml(group.hint)}">
            <span class="cat-caret" aria-hidden="true"></span>
            <span class="pool-group-title">${escapeHtml(group.title)}</span>
            <span class="pool-group-count num" data-pool-count="${gid}">已启用 ${checkedCount} / ${members.length} 名维护官</span>
          </button>
          <button type="button" class="set-mini-btn pool-add-btn" data-pool-add="${gid}" data-fk="${ctx.fkPrefix}pool-add:${gid}" aria-label="${escapeHtml(`向${group.title}添加成员`)}">+ 添加</button>
        </div>
        ${bodyHtml}
      </section>`;
  }
  const cur = currentSpecCuration();
  const specOn = isProjectSpecEnabled();
  const draftHere = specOn && draft && draft.group === group.id;
  const pending = actionableSpecProposal(cur);
  const runningHtml = cur.running
    ? `<p class="pool-curation-hint" data-curation-hint>${cur.awaitingHost ? '等待宿主执行维护票据…' : '维护官梳理中…'}</p>`
    : '';
  const pendingHtml = pending
    ? `<button type="button" class="pool-curation-pending" data-goto-spec-proposal data-fk="curation:goto">📝 有 1 份规范维护提案待确认（${pending.changes.length} 处变更）→ 前往确认</button>`
    : '';
  const issuesHtml = specOn ? issues.map((i) => `<div class="pool-issue is-blocking" role="alert" data-pool-issue="${escapeHtml(i.kind)}">${escapeHtml(i.message)}</div>`).join('') : '';
  // 本项目未接入项目规范：维护组置灰收起，只展示停用引导（成员定义保留，开启项目规范后恢复）
  const offHtml = '<p class="pool-curation-off" data-curation-spec-off>本项目未开启项目规范，规范维护官已停用 <button type="button" class="set-mini-btn" data-goto-project-pane data-fk="curation:goto-project">前往「项目规范」开启</button></p>';
  const bodyHtml = collapsed ? '' : !specOn ? offHtml : `${runningHtml}${pendingHtml}
      ${draftHere ? renderMemberDraftHtml(draft, mode, scope) : ''}
      <div class="set-group pool-list">${members.length ? members.map((p) => renderMemberRowHtml(p, group, mode, checkedCount, scope)).join('') : '<p class="pool-curator-empty">暂无规范维护官：点击「+ 添加」选择外部 CLI 或宿主原生引擎，恒为只读提案</p>'}</div>`;
  return `<section class="pool-group pool-group--curator${collapsed ? ' is-collapsed' : ''}${specOn ? '' : ' is-spec-off'}" data-role-group="${gid}" data-pool-group="${gid}" data-mode-scope-group="${mode}" aria-label="${escapeHtml(group.title)}">
      <div class="pool-group-head">
        <button type="button" class="pool-group-toggle" data-pool-toggle="${gid}" data-fk="pool-toggle:${gid}" aria-expanded="${!collapsed}" title="${escapeHtml(group.hint)}">
          <span class="cat-caret" aria-hidden="true"></span>
          <span class="pool-group-title">${escapeHtml(group.title)}</span>
          <span class="pool-group-count num" data-pool-count="${gid}">${specOn ? `已启用 ${checkedCount} / ${members.length} 名维护官` : '已停用'}</span>
        </button>
        <span class="pool-curation-auto-lbl" aria-hidden="true">自动</span>
        ${curationAutoSwitchHtml('stage:curator')}
        <button type="button" class="set-mini-btn pool-add-btn" data-pool-add="${gid}" data-fk="pool-add:${gid}" aria-label="${escapeHtml(`向${group.title}添加成员`)}"${specOn ? '' : ' disabled'}>+ 添加</button>
      </div>
      ${issuesHtml}
      ${bodyHtml}
    </section>`;
}

function renderPoolGroupHtml(group, mode, issues, scope = 'project') {
  if (group.id === 'curator') return renderCuratorGroupHtml(group, mode, issues, scope);
  const ctx = rosterCtx(scope);
  const members = listPoolMembers(group.id, scope);
  const checkedCount = modeEnabledMembers(mode, group.id, scope).length;
  const collapsed = ctx.collapsedGroups.has(group.id);
  const gid = escapeHtml(group.id);
  const noun = GROUP_NOUNS[group.id] || '成员';
  const stageable = mode === 'complex' && group.id !== 'executor';
  const stageOn = isModeStageEnabled(mode, group.id, scope);
  const draft = ctx.presets[MEMBER_DRAFT_KEY];
  const draftHere = draft && draft.group === group.id;
  const issuesHtml = issues.map((i) => `<div class="pool-issue is-blocking" role="alert" data-pool-issue="${escapeHtml(i.kind)}">${escapeHtml(i.message)}</div>`).join('');
  const stageCtl = group.id === 'executor'
    ? '<span class="pool-stage-tag is-required" title="执行阶段常驻，至少保留 1 名执行官">必选阶段</span>'
    : stageable
    ? `<button type="button" class="set-switch pool-stage-switch${stageOn ? ' is-on' : ''}" role="switch" aria-checked="${stageOn}" data-mode-stage-toggle="${gid}" data-fk="${ctx.fkPrefix}stage:${gid}"
        aria-label="${escapeHtml(`${group.stageTitle}总开关`)}" title="${escapeHtml(stageOn ? `${group.stageTitle}已开启（点击跳过本阶段，勾选保留）` : `${group.stageTitle}已跳过（点击开启）`)}"><span class="set-switch-track" aria-hidden="true"><span class="set-switch-thumb"></span></span></button>`
    : '';
  let bodyHtml = '';
  if (!collapsed) {
    const list = stageable && !stageOn
      ? `<p class="pool-stage-skipped" data-stage-skipped="${gid}">本阶段已跳过 · 已保留 ${checkedCount} 名勾选${escapeHtml(noun)}（开启后恢复）</p>`
      : `<div class="set-group pool-list">${members.length ? members.map((p) => renderMemberRowHtml(p, group, mode, checkedCount, scope)).join('') : '<p class="pool-empty">本组暂无成员，点击「+ 添加」按已探测引擎定义成员</p>'}</div>`;
    bodyHtml = (draftHere ? renderMemberDraftHtml(draft, mode, scope) : '') + list;
  }
  return `<section class="pool-group${collapsed ? ' is-collapsed' : ''}${stageable && !stageOn ? ' is-stage-off' : ''}" data-role-group="${gid}" data-pool-group="${gid}" data-mode-scope-group="${mode}" aria-label="${escapeHtml(group.title)}">
      <div class="pool-group-head">
        <button type="button" class="pool-group-toggle" data-pool-toggle="${gid}" data-fk="${ctx.fkPrefix}pool-toggle:${gid}" aria-expanded="${!collapsed}" title="${escapeHtml(group.hint)}">
          <span class="cat-caret" aria-hidden="true"></span>
          <span class="pool-group-title">${escapeHtml(group.title)}</span>
          <span class="pool-group-count num" data-pool-count="${gid}">已启用 ${checkedCount} / ${members.length} 名${escapeHtml(noun)}</span>
        </button>
        ${stageCtl}
        <button type="button" class="set-mini-btn pool-add-btn" data-pool-add="${gid}" data-fk="${ctx.fkPrefix}pool-add:${gid}" aria-label="${escapeHtml(`向${group.title}添加成员`)}">+ 添加</button>
      </div>
      ${stageable && stageOn ? issuesHtml : group.id === 'executor' ? issuesHtml : ''}
      ${bodyHtml}
    </section>`;
}

function renderMemberRowHtml(p, group, mode, checkedCount, scope = 'project') {
  const ctx = rosterCtx(scope);
  const key = escapeHtml(p.key);
  const entry = modeGroupProfile(mode, group.id, scope);
  const checked = (entry.enabledKeys || []).includes(p.key);
  const lastGuard = checked && group.id === 'executor' && checkedCount <= 1;
  const isStar = group.starrable && checked && entry.preferredKey === p.key;
  const open = ctx.getOpenMemberKey() === p.key;
  const label = p.label || p.key;
  const model = formatModelDisplay(p.model) || '跟随默认';
  const drawerId = `${ctx.idPrefix}pool-drawer-${key}`;
  const check = `<button type="button" class="pool-check${checked ? ' is-on' : ''}" role="checkbox" aria-checked="${checked}" data-mode-member-check="${key}" data-mode-group="${escapeHtml(group.id)}" data-fk="${ctx.fkPrefix}check:${mode}:${key}"${lastGuard ? ' aria-disabled="true"' : ''}
        aria-label="${escapeHtml(`${checked ? '取消勾选' : '勾选'}${GROUP_NOUNS[group.id] || '成员'}：${label}`)}" title="${escapeHtml(lastGuard ? '至少保留 1 名执行官' : checked ? `已勾选进${MODE_PROFILE_LABELS[mode]}（点击取消）` : `勾选进${MODE_PROFILE_LABELS[mode]}`)}"><span class="pool-check-box" aria-hidden="true"></span></button>`;
  const star = group.starrable
    ? `<button type="button" class="pool-icon-btn pool-star${isStar ? ' is-on' : ''}" data-mode-member-star="${key}" data-mode-group="${escapeHtml(group.id)}" data-fk="${ctx.fkPrefix}star:${mode}:${key}" aria-pressed="${isStar}"${checked ? '' : ' aria-disabled="true"'}
        aria-label="${escapeHtml(`${isStar ? '当前首选 ★' : '设为首选 ★'}：${label}`)}" title="${escapeHtml(isStar ? `${group.title}首选 ★` : checked ? `设为${group.title}首选 ★` : '仅已勾选成员可设为首选 ★')}">${isStar ? '★' : '☆'}</button>`
    : '';
  return `<div class="pool-row${checked ? ' is-checked' : ' is-unchecked'}${open ? ' is-open' : ''}" data-slot-key="${key}" data-member-key="${key}">
      ${check}
      <span class="eng-dot ${engClass(p.provider)}" aria-hidden="true"></span>
      <span class="pool-row-name" title="${escapeHtml(`${label} · ${p.model || ''}`)}"><span class="pool-row-label">${escapeHtml(label)}</span><span class="pool-row-model"> · ${escapeHtml(model)}</span></span>
      ${star}
      <button type="button" class="pool-icon-btn pool-more" data-member-more="${key}" data-fk="${ctx.fkPrefix}more:${key}" aria-expanded="${open}" aria-controls="${drawerId}" aria-label="${escapeHtml(`编辑成员：${label}`)}" title="${scope === 'global' ? '编辑引擎 / 模型 / 思考强度 / 权限 / 隔离（全局默认模板配置）' : '编辑引擎 / 模型 / 思考强度 / 权限 / 隔离（本项目成员共享配置）'}">⋯</button>
    </div>${open ? renderMemberDrawerHtml(p, scope) : ''}`;
}

function renderMemberDrawerHtml(p, scope = 'project') {
  const ctx = rosterCtx(scope);
  const key = escapeHtml(p.key);
  const armed = (state.pendingConfirms.get(`${ctx.confirmPrefix}${p.key}`) || 0) > Date.now();
  // 全成员平权：所有成员统一提供「删除成员」（二次确认）
  const footer = `<button type="button" class="set-mini-btn is-danger${armed ? ' is-armed' : ''}" data-member-delete="${key}" data-fk="${ctx.fkPrefix}delete:${key}" aria-label="${escapeHtml(armed ? `确认删除成员「${p.label || p.key}」` : `删除成员「${p.label || p.key}」`)}">${armed ? '确认删除？' : '删除成员'}</button>`;
  const sharedHint = scope === 'global'
    ? '模型与权限为全局默认模板成员共享配置（新项目首次协作时继承）'
    : '模型与权限为本项目成员共享配置（简单模式与复杂阵容共用）';
  return `<div class="pool-drawer" id="${ctx.idPrefix}pool-drawer-${key}" data-member-drawer="${key}">
      <label class="pool-field pool-field--wide"><span class="pool-field-lbl">显示名</span>
        <input type="text" class="text-input pool-label-input" data-member-label="${key}" data-fk="${ctx.fkPrefix}label:${key}" value="${escapeHtml(p.label || '')}" maxlength="40" autocomplete="off" spellcheck="false" />
      </label>
      ${presetFieldsGridHtml(p, scope)}
      <p class="pool-shared-hint">${sharedHint}</p>
      <div class="pool-drawer-foot">
        <code class="pool-key" title="成员键（创建后不可修改）">${key}</code>
        ${footer}
      </div>
    </div>`;
}

function presetFieldsGridHtml(p, scope = 'project') {
  if (p.group === 'curator') return curatorFieldsGridHtml(p, scope);
  return `<div class="pool-drawer-grid">
        <div class="pool-field"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.provider}</span>${presetTrigger(p, p, 'provider', { scope })}</div>
        <div class="pool-field"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.model}</span>${presetTrigger(p, p, 'model', { scope })}</div>
        <div class="pool-field"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.effort}</span>${presetTrigger(p, p, 'effort', { scope })}</div>
        <div class="pool-field"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.permissionMode}</span>${presetTrigger(p, p, 'permissionMode', { scope })}</div>
      </div>
      <div class="pool-field pool-field--row"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.isolation}</span>${isolationSegHtml(p, p, scope)}</div>`;
}

/** 规范维护组可选引擎：放行宿主原生（antigravity）、全部外部 CLI 与已启用扩展平台。 */
export function curatorProviderOptions() {
  return state.providers.filter((x) => x && !isCuratorBlockedProvider(x.id)).map((x) => ({ value: x.id, label: x.name || x.id }));
}

/**
 * 规范维护官抽屉：引擎为原生 <select>（支持外部 CLI 与宿主原生引擎），
 * 模型 / 思考强度自由选择；权限与隔离为跟随引擎自动锁定的只读提示（read-only / plan + 共享目录）。
 */
function curatorFieldsGridHtml(p, scope = 'project') {
  const ctx = rosterCtx(scope);
  const key = escapeHtml(p.key);
  const provider = normalizeProviderId(p.provider);
  const opts = curatorProviderOptions();
  if (!opts.some((o) => o.value === provider)) opts.unshift({ value: provider, label: `${provider}（不可用于规范维护）` });
  const selectId = `${ctx.idPrefix}ps-${key}-provider`;
  const select = `<select class="compact-select ps-curator-provider" data-curator-provider="${key}" id="${selectId}" name="curator-provider" data-fk="${ctx.fkPrefix}ps:${key}:provider" aria-label="${escapeHtml(`${p.label || p.key} · ${PRESET_FIELD_LABELS.provider}`)}">${opts
    .map((o) => `<option value="${escapeHtml(o.value)}"${o.value === provider ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}</select>`;
  const perm = provider === 'antigravity'
    ? '只读沙盒 / Hook 门禁 (plan)'
    : (presetOptions(p, 'permissionMode').find((o) => o.value === p.permissionMode)?.label || p.permissionMode || '');
  return `<div class="pool-drawer-grid">
        <div class="pool-field"><label class="pool-field-lbl" for="${selectId}">${PRESET_FIELD_LABELS.provider}</label>${select}</div>
        <div class="pool-field"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.model}</span>${presetTrigger(p, p, 'model', { scope })}</div>
        <div class="pool-field"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.effort}</span>${presetTrigger(p, p, 'effort', { scope })}</div>
        <div class="pool-field"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.permissionMode}</span><span class="pool-locked-field" data-curator-locked="permissionMode" title="规范维护官恒为只读提案，权限跟随引擎自动锁定">🔒 ${escapeHtml(String(perm).replace(/\s*·\s*高危$/, ''))}</span></div>
      </div>
      <div class="pool-field pool-field--row"><span class="pool-field-lbl">${PRESET_FIELD_LABELS.isolation}</span><span class="pool-locked-field" data-curator-locked="isolation" title="只读梳理不需要隔离 Worktree">🔒 共享目录（只读）</span></div>
      <p class="pool-shared-hint">规范维护官只读梳理并输出提案，落盘须经「项目规范」卡片整组确认</p>`;
}

function renderMemberDraftHtml(draft, mode, scope = 'project') {
  const ctx = rosterCtx(scope);
  const groups = MODE_PROFILE_GROUPS[mode] || ['executor'];
  const groupSeg = groups.length > 1
    ? `<div class="pool-field pool-field--row"><span class="pool-field-lbl">所属组</span><div class="seg seg--group" role="radiogroup" aria-label="所属组">${groups.map((id) => {
      const g = groupMetaOf(id);
      return `<button type="button" class="seg-btn" role="radio" aria-checked="${draft.group === id}" tabindex="${draft.group === id ? 0 : -1}" data-member-draft-group="${escapeHtml(id)}" data-fk="${ctx.fkPrefix}draft-group:${escapeHtml(id)}">${escapeHtml(g.title)}</button>`;
    }).join('')}</div></div>`
    : '';
  return `<div class="pool-draft" data-member-draft>
      <div class="pool-draft-head">新增${escapeHtml(GROUP_NOUNS[draft.group] || '成员')} · 保存后自动勾选进${escapeHtml(MODE_PROFILE_LABELS[mode] || '')}</div>
      <label class="pool-field pool-field--wide"><span class="pool-field-lbl">显示名</span>
        <input type="text" id="${ctx.idPrefix}member-draft-label" class="text-input" data-member-draft-field="label" data-fk="${ctx.fkPrefix}draft:label" value="${escapeHtml(draft.label || '')}" maxlength="40" placeholder="例如：安全终审官" autocomplete="off" />
      </label>
      <label class="pool-field pool-field--wide"><span class="pool-field-lbl">成员键</span>
        <input type="text" id="${ctx.idPrefix}member-draft-key" class="text-input mono-area" data-member-draft-field="key" data-fk="${ctx.fkPrefix}draft:key" value="${escapeHtml(draft.draftKey || '')}" maxlength="64" placeholder="advisor_argon" autocomplete="off" spellcheck="false" />
      </label>
      ${groupSeg}
      ${presetFieldsGridHtml(draft, scope)}
      <p id="${ctx.idPrefix}member-draft-error" class="pool-draft-err" role="alert" hidden></p>
      <div class="pool-drawer-foot">
        <button type="button" class="set-mini-btn" data-member-draft-cancel data-fk="${ctx.fkPrefix}draft:cancel">取消</button>
        <button type="button" class="set-mini-btn is-primary" data-member-draft-save data-fk="${ctx.fkPrefix}draft:save">保存成员</button>
      </div>
    </div>`;
}


function isolationSegHtml(slot, cfg, scope = 'project') {
  const ctx = rosterCtx(scope);
  const key = escapeHtml(slot.key);
  const current = cfg.isolation === 'worktree' ? 'worktree' : 'shared';
  const opts = [
    { value: 'shared', long: '共享目录', short: '共享', aria: '共享项目目录', tip: '共享项目目录（默认，常驻会话可续聊）' },
    { value: 'worktree', long: 'Worktree', short: 'WT', aria: '独立 Worktree', tip: '独立 Git Worktree 沙盒' },
  ];
  return `<div class="seg seg--iso" role="radiogroup" aria-label="${escapeHtml(`${cfg.label || roleTitle(slot.key)} · ${PRESET_FIELD_LABELS.isolation}`)}">${opts
    .map((o) => `<button type="button" class="seg-btn" role="radio" aria-checked="${current === o.value}" tabindex="${current === o.value ? 0 : -1}" aria-label="${o.aria}" title="${escapeHtml(o.tip)}" data-ps-seg="${key}" data-value="${o.value}" data-fk="${ctx.fkPrefix}seg:${key}:${o.value}"><span class="seg-long">${o.long}</span><span class="seg-short" aria-hidden="true">${o.short}</span></button>`)
    .join('')}</div>`;
}

/* ----- 分区 2：引擎目录 ----- */
function buildPresetUsageIndex() {
  const usage = new Map();
  for (const group of MEMBER_GROUP_IDS) {
    for (const cfg of listPoolMembers(group)) {
      const k = `${normalizeProviderId(cfg.provider)}\n${cfg.model}`;
      if (!usage.has(k)) usage.set(k, []);
      usage.get(k).push(cfg.key);
    }
  }
  return usage;
}

function renderCatalogPane() {
  const providers = state.providers;
  const totalModels = providers.reduce((sum, p) => sum + (p.models?.length || 0), 0);
  setText('catalog-sync-subtitle', `${providers.length} 个引擎 · ${totalModels} 款模型`);
  const box = document.getElementById('catalog-providers-container');
  if (!box) return;
  if (!state.catalogOpenInitialized && providers.length) {
    state.catalogOpenInitialized = true;
    if (providers.length === 1) state.catalogOpen.add(providers[0].id);
  }
  const usage = buildPresetUsageIndex();
  setHtmlKeepingFocus(box, providers.map((p) => renderCatalogProviderHtml(p, usage)).join(''), applyCatalogFilter);
}

function renderCatalogProviderHtml(p, usage) {
  const id = String(p.id);
  const eid = escapeHtml(id);
  const source = formatCatalogSourceLabel(p.catalogSource);
  const defModelId = p.configDefaultModel || p.models.find((m) => m.isDefault)?.id || '';
  const defModel = p.models.find((m) => m.id === defModelId);
  const defName = defModel ? defModel.name.replace(/\s*\(.*\)$/, '') : shortenModelName(defModelId);
  const defEffort = p.configDefaultEffort || defModel?.defaultEffort || '';
  const seats = MEMBER_GROUP_IDS.flatMap((g) => listPoolMembers(g)).filter((p) => normalizeProviderId(p.provider) === id).length;
  const line2 = [
    defName ? `默认 ${defName}${defEffort ? ' · ' + defEffort : ''}` : '',
    p.probedAt > 0 ? `探测于 ${formatTimeShort(p.probedAt)}` : '',
    seats ? `${seats} 席在用` : '',
  ].filter(Boolean).join(' · ');

  const groups = [];
  for (const m of p.models) {
    const g = m.group && m.group !== id ? m.group : '';
    let bucket = groups.find((x) => x.name === g);
    if (!bucket) groups.push((bucket = { name: g, models: [] }));
    bucket.models.push(m);
  }
  const labelGroups = groups.length > 1 || Boolean(groups[0]?.name);
  const baseName = p.name.replace(/\s*\(.*\)$/, '');
  const modelsHtml = groups
    .map((g) => `<div class="cat-group">${labelGroups ? `<div class="cat-group-label">${escapeHtml(g.name || baseName)}</div>` : ''}${g.models
      .map((m) => renderCatalogModelHtml(p, m, usage, defModelId))
      .join('')}</div>`)
    .join('');

  return `<div class="cat-acc" data-cat-id="${eid}">
      <h3 class="cat-acc-h"><button type="button" class="cat-acc-head" data-cat-toggle="${eid}" data-fk="cat:${eid}" aria-expanded="false">
        <span class="cat-caret" aria-hidden="true"></span>
        <span class="cat-acc-main">
          <span class="cat-acc-line1">
            <span class="eng-dot ${engClass(id)}" aria-hidden="true"></span>
            <span class="cat-acc-name">${escapeHtml(p.name)}</span>
            ${source ? `<span class="catalog-source-tag">${escapeHtml(source)}</span>` : ''}
            ${p.version ? `<span class="cat-meta-tag num">v${escapeHtml(p.version)}</span>` : ''}
            ${p.installed === false ? '<span class="cat-meta-tag is-warn">未检测到</span>' : ''}
            <span class="cat-count num">${p.models.length} 款</span>
          </span>
          ${line2 ? `<span class="cat-acc-line2">${escapeHtml(line2)}</span>` : ''}
        </span>
      </button></h3>
      <div class="cat-acc-body"><div class="cat-acc-inner">${modelsHtml}</div></div>
    </div>`;
}

function renderCatalogModelHtml(p, m, usage, defModelId) {
  const ctx = formatCtx(m.contextWindow);
  const efforts = Array.isArray(m.efforts) ? m.efforts : [];
  const effHtml = efforts.map((e) => (e === m.defaultEffort ? `<b>${escapeHtml(e)}</b>` : escapeHtml(e))).join('·');
  const users = usage.get(`${p.id}\n${m.id}`) || [];
  const search = [m.name, m.id, m.group, p.name, p.id].filter(Boolean).join(' ').toLowerCase();
  const usedHtml = users.length
    ? `<div class="cat-model-used"><span class="cat-used-lbl">在用</span>${users
        .map((k) => `<button type="button" class="cat-used" data-goto-role="${escapeHtml(k)}" title="${escapeHtml(`被「${roleTitle(k)}」使用 · 点击前往角色路由`)}">${escapeHtml(ROLE_SHORT_TITLES[k] || roleTitle(k))}</button>`)
        .join('')}</div>`
    : '';
  return `<div class="cat-model" data-model-id="${escapeHtml(m.id)}" data-search="${escapeHtml(search)}">
      <div class="cat-model-top">
        <span class="cat-model-name">${escapeHtml(m.name)}</span>
        ${m.id === defModelId ? '<span class="cat-tag is-default">默认</span>' : ''}
        ${ctx ? `<span class="cat-tag num" title="上下文窗口">${ctx}</span>` : ''}
        ${effHtml ? `<span class="cat-efforts" title="思考档位（加粗为默认）">${effHtml}</span>` : ''}
      </div>
      <div class="cat-model-bottom">
        <code class="cat-model-id" title="${escapeHtml(m.id)}">${escapeHtml(m.id)}</code>
        <button type="button" class="cat-copy-btn" data-copy-model="${escapeHtml(m.id)}" aria-label="${escapeHtml(`复制模型 ID ${m.id}`)}">复制</button>
      </div>
      ${usedHtml}
    </div>`;
}

// 纯 DOM 过滤：搜索框聚焦时整页不重绘，这里直接切 hidden / is-open，不触发 innerHTML 重写。
export function applyCatalogFilter() {
  const box = document.getElementById('catalog-providers-container');
  if (!box) return;
  const query = state.catalogQuery.trim();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  let total = 0;
  for (const acc of box.querySelectorAll('.cat-acc')) {
    const id = acc.dataset.catId;
    let hits = 0;
    for (const row of acc.querySelectorAll('.cat-model')) {
      const ok = !searching || terms.every((t) => row.dataset.search.includes(t));
      row.hidden = !ok;
      if (ok) hits++;
    }
    for (const g of acc.querySelectorAll('.cat-group')) g.hidden = searching && !g.querySelector('.cat-model:not([hidden])');
    const open = searching ? hits > 0 && !state.catalogSearchCollapsed.has(id) : state.catalogOpen.has(id);
    acc.hidden = searching && hits === 0;
    acc.classList.toggle('is-open', open);
    acc.querySelector('.cat-acc-head')?.setAttribute('aria-expanded', String(open));
    total += hits;
  }
  box.hidden = searching && total === 0;
  const empty = document.getElementById('catalog-empty-hint');
  if (empty) {
    empty.hidden = !searching || total > 0;
    if (searching && !total) setText('catalog-empty-hint', `没有匹配「${query}」的模型`);
  }
}
export function toggleCatalogProvider(id) {
  const set = state.catalogQuery.trim() ? state.catalogSearchCollapsed : state.catalogOpen;
  if (set.has(id)) set.delete(id);
  else set.add(id);
  applyCatalogFilter();
}

export async function copyText(text, trigger) {
  const ok = await copyPlainText(text);
  trigger?.focus({ preventScroll: true });
  showToast(ok ? `已复制 ${text}` : '复制失败，请手动选择模型 ID', ok ? 'success' : 'error');
}

/* ----- 【项目配置】子页 2：项目规范（Spec）与专职维护官 ----- */
function renderProjectPane() {
  ensureProjectSpecsLoaded();
  // 项目规范列表未回传 curation（旧守护进程）时补拉一次规范维护状态
  if (state.projectSpecs.data && !state.projectSpecs.loading) ensureSpecCurationStatus();
  renderProjectSpecsSection();
}

/* ----- 【项目配置】子页 3：当前对话编排派发 + 运行缓存安全清理 ----- */
function renderCachePane() {
  const dispEnabled = isConversationDispatchEnabled();
  const modeMeta = orchestrationModeMeta(currentOrchestrationMode());
  const convBadge = document.getElementById('settings-conv-dispatch-badge');
  if (convBadge) {
    convBadge.className = dispEnabled ? 'health-mini-badge ok' : 'health-mini-badge warn';
    setText('settings-conv-dispatch-badge', dispEnabled ? `${modeMeta.name} · 已开启` : '直出 · 已关闭');
  }
  const convSwitch = document.getElementById('btn-settings-toggle-dispatch');
  if (convSwitch) {
    // 只改属性与类名，不写 textContent，否则会清掉内部轨道 / 滑块节点
    convSwitch.setAttribute('aria-checked', String(dispEnabled));
    convSwitch.classList.toggle('is-on', dispEnabled);
    convSwitch.title = dispEnabled ? '切为直出模式（关闭当前对话的子 Agent 派发）' : `恢复「${orchestrationModeMeta(state.lastNonDirectMode).name}」模式`;
  }
  renderProjectExternalSessionSection();
  ensureRuntimeCacheLoaded();
  renderRuntimeCacheSection();
}

/* ----- 【全局配置】子页 1：新对话与新项目默认策略、界面外观主题、插件角色底线模板与关于 ----- */
function renderGeneralPane() {
  const shownDefault = normalizeModeId(state.defaultDispatchSaving ?? state.defaultOrchestrationMode);
  const defSelect = document.getElementById('sel-default-dispatch-mode');
  if (defSelect && document.activeElement !== defSelect && state.defaultDispatchSaving == null) {
    defSelect.value = ORCHESTRATION_MODE_META.some((m) => m.id === state.defaultOrchestrationMode) ? state.defaultOrchestrationMode : 'direct';
  }
  document.querySelectorAll('#default-dispatch-seg [data-default-mode]').forEach((btn) => {
    const on = btn.dataset.defaultMode === shownDefault;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? 0 : -1;
  });
  renderDefaultSpecSwitch();
  renderDefaultExternalSessionSwitch();
  renderSystemUpdateSection();
  setText('settings-about-version', `AgentTower v${state.version}`);
  renderPluginSpecTemplateSection();
}

/* ----- 【全局配置】子页 3：扩展平台 ----- */
function renderExtensionsPane() {
  renderExtensionHub();
}

export function renderDefaultExternalSessionSwitch() {
  const sw = document.getElementById('btn-default-external-session-visible');
  if (!sw) return;
  const saving = state.defaultExternalSessionSaving;
  const on = typeof saving === 'boolean' ? saving : state.defaultExternalSessionVisible === true;
  sw.setAttribute('aria-checked', String(on));
  sw.classList.toggle('is-on', on);
  sw.disabled = typeof saving === 'boolean';
  sw.setAttribute('aria-busy', String(typeof saving === 'boolean'));
  sw.title = on ? '默认在外部客户端保留会话（点击关闭）' : '默认隐藏外部会话（点击开启）';
}

export function renderProjectExternalSessionSection() {
  const cfg = currentProjectConfig();
  const bound = Boolean(currentProjectWorkspace());
  const mode = ['inherit', 'hidden', 'visible'].includes(cfg?.externalSessionMode) ? cfg.externalSessionMode : 'inherit';
  const visible = typeof cfg?.externalSessionVisible === 'boolean' ? cfg.externalSessionVisible : state.defaultExternalSessionVisible === true;
  const customized = typeof cfg?.externalSessionCustomized === 'boolean' ? cfg.externalSessionCustomized : mode !== 'inherit';
  const badge = document.getElementById('project-external-session-badge');
  if (badge) {
    badge.textContent = !bound ? '未绑定项目' : `${customized ? '本项目' : '跟随全局'} · ${visible ? '保留调试' : '已隐藏'}`;
    badge.className = `set-source-badge ${!bound ? 'is-unbound' : customized ? 'is-project' : 'is-template'}`;
  }
  document.querySelectorAll('#project-external-session-seg [data-ext-session-mode]').forEach((btn) => {
    const on = btn.dataset.extSessionMode === mode;
    btn.setAttribute('aria-checked', String(on));
    btn.tabIndex = on ? 0 : -1;
    btn.disabled = !bound || Boolean(state.projectExternalSessionSaving);
  });
}

function formatUpdateBytes(bytes) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KB`;
  return `${Math.round(value)} B`;
}

function describeInstallOrigin(update) {
  const origin = update?.installOrigin || 'unknown';
  if (origin === 'dev') return '开发仓挂载（仅提示；请通过命令行执行发布热切，面板不自动覆盖）';
  if (origin === 'git-clone') return update?.autoUpdateSupported ? 'Git 克隆挂载（支持在线热更新）' : 'Git 克隆挂载（仅提示）';
  if (origin === 'zip') return update?.autoUpdateSupported ? '标准安装包挂载（支持在线热更新）' : '标准挂载（仅提示）';
  return '安装形态未知（仅提示）';
}

function describeUpdateLastResult(lastResult) {
  const status = String(lastResult?.status || '');
  if (!status) return '';
  const fromVer = String(lastResult?.fromVersion || '').replace(/^v/, '');
  const toVer = String(lastResult?.toVersion || '').replace(/^v/, '');
  const msg = String(lastResult?.message || '').trim();
  const suffix = msg ? `：${msg}` : '';
  if (status === 'auto_rolled_back') {
    const target = toVer ? ` v${toVer}` : (fromVer ? ` v${fromVer}` : '上一稳定版本');
    return `新版本启动探活失败，已自动回滚至${target}${suffix}`;
  }
  if (status === 'applied') return `已热更新至${toVer ? ` v${toVer}` : '最新版本'}${suffix}`;
  if (status === 'rolled_back') return `已回滚至${toVer ? ` v${toVer}` : '上一版本'}${suffix}`;
  if (status === 'cancelled') return `已取消本次热更新${suffix}`;
  return msg || `更新结果：${status}`;
}

export function renderSystemUpdateSection() {
  const update = state.systemUpdate;
  const st = String(update?.state || 'idle');
  const inTransition = isSystemUpdateTransitionState(st);
  const progress = update?.progress || {};
  const rollback = update?.rollback || {};
  const lastResult = update?.lastResult || {};
  const latestVer = String(update?.latestVersion || '').replace(/^v/, '');
  const hasPercent = typeof progress.percent === 'number' && Number.isFinite(progress.percent);
  const clampedPercent = hasPercent ? Math.max(0, Math.min(100, progress.percent)) : null;

  setText('system-update-current-version', `v${String(update?.currentVersion || state.version || '未知').replace(/^v/, '')}`);
  setText('system-update-install-origin', describeInstallOrigin(update));

  const busy = state.systemUpdateCancelPending ? 'cancelCutover' : state.systemUpdateBusy;
  const progressMsg = String(progress.message || '').trim();
  const status = busy === 'check' || st === 'checking' ? '正在检测新版本…'
    : st === 'downloading' ? (progressMsg || (hasPercent ? `正在下载新版本（${Math.round(clampedPercent)}%）…` : '正在下载新版本…'))
    : st === 'verifying' ? (progressMsg || '正在校验安装包完整性与沙盒预检…')
    : st === 'quiescing' ? (progressMsg || '正在等待在途任务自然排空…')
    : st === 'applying' ? (progressMsg || '正在切换并验证新版本守护进程…')
    : st === 'rolling_back' ? (progressMsg || '正在回滚至上一稳定版本…')
    : st === 'unavailable' ? `暂时无法检测${update?.error ? `：${update.error}` : ''}`
    : update?.hasUpdate ? (update.installOrigin === 'dev' ? `发现新版 v${latestVer}（开发仓请使用命令行发布热切）` : `发现新版 v${latestVer}`)
    : st === 'up_to_date' ? '当前已是最新版'
    : '尚未检测更新';
  setText('system-update-status-text', status);

  const progressWrap = document.getElementById('system-update-progress-wrap');
  const progressEl = document.getElementById('system-update-progress');
  const progressMeta = document.getElementById('system-update-progress-meta');
  if (progressWrap) progressWrap.hidden = !inTransition;
  if (progressEl) {
    if (inTransition && hasPercent) {
      progressEl.value = clampedPercent;
      progressEl.setAttribute('value', String(clampedPercent));
    } else {
      progressEl.removeAttribute('value');
    }
  }
  if (progressMeta) {
    const parts = [];
    if (hasPercent) parts.push(`${Math.round(clampedPercent)}%`);
    if (progress.totalBytes > 0) {
      parts.push(`${formatUpdateBytes(progress.downloadedBytes)} / ${formatUpdateBytes(progress.totalBytes)}`);
    } else if (progress.downloadedBytes > 0) {
      parts.push(`已下载 ${formatUpdateBytes(progress.downloadedBytes)}`);
    }
    const metaText = inTransition ? parts.join(' · ') : '';
    if (progressMeta.textContent !== metaText) progressMeta.textContent = metaText;
    progressMeta.hidden = !metaText;
  }

  const resultEl = document.getElementById('system-update-result');
  if (resultEl) {
    const resultStatus = !inTransition ? String(lastResult.status || '') : '';
    const resultText = resultStatus ? describeUpdateLastResult(lastResult) : '';
    if (resultText) {
      resultEl.dataset.status = resultStatus;
      resultEl.setAttribute('role', resultStatus === 'auto_rolled_back' || resultStatus === 'failed' ? 'alert' : 'status');
      if (resultEl.textContent !== resultText) resultEl.textContent = resultText;
      resultEl.hidden = false;
    } else {
      resultEl.dataset.status = '';
      resultEl.setAttribute('role', 'status');
      if (resultEl.textContent !== '') resultEl.textContent = '';
      resultEl.hidden = true;
    }
  }

  const auto = document.getElementById('btn-auto-check-updates');
  if (auto) {
    const saving = state.autoCheckUpdatesSaving;
    const on = typeof saving === 'boolean' ? saving : state.autoCheckUpdates !== false;
    auto.setAttribute('aria-checked', String(on));
    auto.classList.toggle('is-on', on);
    auto.disabled = typeof saving === 'boolean';
    auto.setAttribute('aria-busy', String(typeof saving === 'boolean'));
  }
  const check = document.getElementById('btn-check-updates-now');
  if (check) {
    check.disabled = Boolean(busy) || inTransition;
    check.textContent = busy === 'check' ? '检测中…' : '↻ 立即检测';
  }
  const applyBtn = document.getElementById('btn-apply-system-update');
  if (applyBtn) {
    const showApply = update?.hasUpdate === true && update?.autoUpdateSupported === true && update?.installOrigin !== 'dev' && !inTransition;
    const armed = (state.pendingConfirms.get('system-update-apply') || 0) > Date.now();
    applyBtn.hidden = !showApply;
    applyBtn.disabled = Boolean(busy) || inTransition;
    applyBtn.classList.toggle('is-armed', armed);
    const label = busy === 'apply' ? '启动更新中…' : armed ? '确认下载并热更新？' : '⬇ 下载并热更新';
    if (applyBtn.textContent !== label) applyBtn.textContent = label;
  }
  const cancelBtn = document.getElementById('btn-cancel-system-update');
  if (cancelBtn) {
    cancelBtn.hidden = update?.cancellable !== true;
    cancelBtn.disabled = busy === 'cancelCutover';
    const label = busy === 'cancelCutover' ? '取消中…' : '取消更新';
    if (cancelBtn.textContent !== label) cancelBtn.textContent = label;
  }
  const rollbackBtn = document.getElementById('btn-rollback-system-update');
  if (rollbackBtn) {
    const rbVer = String(rollback.version || '').replace(/^v/, '');
    const showRollback = rollback.available === true && Boolean(rbVer) && rollback.rollbackSafe !== false && !inTransition;
    const armed = (state.pendingConfirms.get('system-update-rollback') || 0) > Date.now();
    rollbackBtn.hidden = !showRollback;
    rollbackBtn.disabled = Boolean(busy) || inTransition;
    rollbackBtn.classList.toggle('is-armed', armed);
    const label = busy === 'rollback' ? '回滚中…' : armed ? `确认回滚至 v${rbVer}？` : `↺ 回滚至 v${rbVer}`;
    if (rollbackBtn.textContent !== label) rollbackBtn.textContent = label;
  }
  const link = document.getElementById('link-system-update-release');
  if (link) {
    link.hidden = !update?.hasUpdate || !update.releaseUrl;
    if (update?.releaseUrl) link.href = update.releaseUrl;
    else link.removeAttribute('href');
  }
  const dismiss = document.getElementById('btn-dismiss-update');
  if (dismiss) {
    dismiss.hidden = !update?.hasUpdate || !update.latestVersion || inTransition;
    dismiss.disabled = Boolean(busy) || inTransition;
  }
  const notes = document.getElementById('system-update-notes');
  if (notes) {
    const text = update?.hasUpdate ? String(update.releaseNotes || '') : '';
    if (notes.textContent !== text) notes.textContent = text;
    notes.hidden = !text;
  }
}

/** 全局「新项目默认开启项目规范（Spec）」开关：只改属性与类名，不覆盖轨道节点。 */
function renderDefaultSpecSwitch() {
  const sw = document.getElementById('btn-default-spec-enabled');
  if (!sw) return;
  const saving = state.defaultSpecSaving;
  const on = typeof saving === 'boolean' ? saving : state.defaultSpecEnabled === true;
  sw.setAttribute('aria-checked', String(on));
  sw.classList.toggle('is-on', on);
  sw.disabled = typeof saving === 'boolean';
  sw.setAttribute('aria-busy', String(typeof saving === 'boolean'));
  sw.title = on ? '新项目默认接入项目规范（点击关闭）' : '新项目默认不接入项目规范（点击开启）';
}

export async function toggleDefaultSpecEnabled() {
  if (typeof state.defaultSpecSaving === 'boolean') return false;
  const next = !(state.defaultSpecEnabled === true);
  const statusEl = document.getElementById('default-spec-save-status');
  state.defaultSpecSaving = next;
  if (statusEl) statusEl.textContent = '保存中…';
  renderDefaultSpecSwitch();
  try {
    const res = await rpcCall('saveSettings', { scope: 'global', defaultSpecEnabled: next });
    const saved = res?.settings?.defaultSpecEnabled ?? res?.defaultSpecEnabled;
    state.defaultSpecEnabled = typeof saved === 'boolean' ? saved : next;
    if (res && typeof res === 'object') {
      mergeRemotePresets({ globalTemplate: res.globalTemplate, settings: { defaultSpecEnabled: state.defaultSpecEnabled } }, { skipRoster: true });
      syncCurrentProjectSpecFromGlobal(res.projectConfig, state.defaultSpecEnabled);
    }
    if (statusEl) statusEl.textContent = '已保存 ✓';
    showToast(state.defaultSpecEnabled ? '新项目将默认接入项目规范（已有项目不受影响）' : '新项目将默认不接入项目规范（已有项目不受影响）', 'success');
    return true;
  } catch (err) {
    if (statusEl) statusEl.textContent = `保存失败：${describeRpcError(err)}`;
    showToast(describeRpcError(err), 'error');
    return false;
  } finally {
    state.defaultSpecSaving = null;
    renderDefaultSpecSwitch();
    scheduleRender();
  }
}

/** 全局默认成员池模板实时摘要：版本修订号 + 四组成员数，直接跟随可编辑全局成员池同步刷新。 */
const TEMPLATE_GROUPS = [['advisor', '军师'], ['executor', '执行'], ['reviewer', '评审'], ['curator', '维护']];
function renderGlobalRosterTemplateSection() {
  const summary = document.getElementById('global-roster-template-summary');
  if (!summary) return;
  const tpl = state.globalTemplate;
  const liveCount = (group) => listPoolMembers(group, 'global').length;
  const liveCounts = Object.fromEntries(TEMPLATE_GROUPS.map(([g]) => [g, liveCount(g)]));
  const liveTotal = Object.values(liveCounts).reduce((a, b) => a + b, 0);
  if (!tpl && liveTotal === 0) {
    const fallback = '全局默认模板 · 当前守护进程未下发模板摘要（升级后显示）';
    if (summary.textContent !== fallback) summary.textContent = fallback;
    return;
  }
  const useLive = liveTotal > 0 || state.globalPendingDeletes.size > 0 || !tpl?.counts;
  const counts = useLive ? liveCounts : tpl.counts;
  const total = useLive ? liveTotal : (Number(tpl.counts.total) || 0);
  const rev = state.globalServerRevision >= 0 ? state.globalServerRevision : (Number(tpl?.presetRevision) || 0);
  const text = `全局默认模板 r${rev} · ${TEMPLATE_GROUPS.map(([g, n]) => `${n} ${Number(counts[g]) || 0}`).join(' · ')} · 共 ${total} 名`;
  if (summary.textContent !== text) summary.textContent = text;
}

function extCommandPreview(ext) {
  const args = ext.argsTemplate || (Array.isArray(ext.args) ? ext.args.join(' ') : '');
  return `${ext.command || ext.id} ${args}`.trim();
}
function renderExtensionHub() {
  const grid = document.getElementById('extension-hub-grid');
  if (!grid) return;
  const merged = [];
  const seen = new Set();
  for (const tpl of state.extensionTemplates) {
    seen.add(tpl.id);
    merged.push({ ...tpl, isBuiltinTemplate: true });
  }
  for (const cust of state.customProviders) {
    if (!seen.has(cust.id)) merged.push({ ...cust, isBuiltinTemplate: false });
  }
  const connected = merged.filter((e) => e.enabled || e.detected).sort((a, b) => Number(Boolean(b.enabled)) - Number(Boolean(a.enabled)));
  const library = merged.filter((e) => !e.enabled && !e.detected);
  const connectedHtml = connected.length
    ? `<div class="set-group">${connected.map(renderExtRowHtml).join('')}</div>`
    : '<div class="set-group"><p class="ext-empty">本机暂未检测到第三方 CLI，可从模板库接入，或点击「+ 自定义」</p></div>';
  const libHtml = library.length
    ? `<div class="ext-lib" data-ext-lib>
          <h3 class="ext-lib-h"><button type="button" class="ext-lib-toggle" data-ext-lib-toggle data-fk="ext-lib" aria-expanded="false"><span class="cat-caret" aria-hidden="true"></span>可接入模板库 · ${library.length}<span class="ext-lib-hint">配置路径后接入</span></button></h3>
          <div class="ext-lib-body"><div class="set-group">${library.map(renderExtLibRowHtml).join('')}</div></div>
        </div>`
    : '';
  setHtmlKeepingFocus(grid, `<div class="ext-block"><div class="ext-block-label">已接入 · ${connected.length}</div>${connectedHtml}</div>${libHtml}`, applyExtLibState);
}
export function applyExtLibState() {
  const lib = document.querySelector('#extension-hub-grid [data-ext-lib]');
  if (!lib) return;
  lib.classList.toggle('is-open', state.extLibOpen);
  lib.querySelector('[data-ext-lib-toggle]')?.setAttribute('aria-expanded', String(state.extLibOpen));
}
function renderExtRowHtml(ext) {
  const id = escapeHtml(ext.id);
  const name = ext.name || ext.id;
  const cmd = extCommandPreview(ext);
  const stateTag = ext.enabled ? '<span class="ext-state is-enabled">已启用</span>' : '<span class="ext-state is-detected">本机已检测</span>';
  const primary = ext.enabled
    ? `<button type="button" class="set-mini-btn is-danger" data-ext-disable="${id}" data-fk="ext-off:${id}" aria-label="${escapeHtml(`停用 ${name}`)}">停用</button>`
    : ext.isBuiltinTemplate
    ? `<button type="button" class="set-mini-btn is-primary" data-ext-enable="${id}" data-fk="ext-on:${id}" aria-label="${escapeHtml(`启用 ${name}`)}">启用</button>`
    : '';
  return `<div class="ext-row${ext.enabled ? ' is-enabled' : ''}">
      <div class="ext-row-top"><span class="ext-row-name">${escapeHtml(name)}</span><span class="ext-proto-tag">${escapeHtml((ext.protocol || 'acp').toUpperCase())}</span>${stateTag}</div>
      <div class="ext-row-sub is-cmd" title="${escapeHtml(ext.binaryPath || cmd)}">${escapeHtml(cmd)}</div>
      <div class="ext-row-actions">${primary}<button type="button" class="set-mini-btn" data-ext-edit="${id}" data-fk="ext-edit:${id}" aria-label="${escapeHtml(`配置 ${name}`)}">配置</button></div>
    </div>`;
}
function renderExtLibRowHtml(ext) {
  const id = escapeHtml(ext.id);
  const name = ext.name || ext.id;
  const sub = ext.description || extCommandPreview(ext);
  return `<div class="ext-row">
      <div class="ext-row-top"><span class="ext-row-name">${escapeHtml(name)}</span><span class="ext-proto-tag">${escapeHtml((ext.protocol || 'acp').toUpperCase())}</span></div>
      <div class="ext-row-sub" title="${escapeHtml(sub)}">${escapeHtml(sub)}</div>
      <div class="ext-row-actions"><button type="button" class="set-mini-btn" data-ext-edit="${id}" data-fk="ext-edit:${id}" aria-label="${escapeHtml(`配置 ${name}`)}">配置</button></div>
    </div>`;
}

/* ========================================================================
 * 10. v0.1.2 运行缓存清理：按需只读统计 + 四重安全锁保护的一键清理（零定时轮询）
 * ======================================================================== */
export function formatCacheBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function runtimeCacheScopeKey() {
  return `${getEffectiveConversationId() || ''}|${getEffectiveCwd() || ''}`;
}

// 切入「会话与缓存」子页面（或会话 / 工作区变化后仍停留在该子页面）时只拉取一次
function ensureRuntimeCacheLoaded() {
  const rc = state.runtimeCache;
  if (state.activeView !== 'settings' || state.settingsPane !== 'cache') return;
  const key = runtimeCacheScopeKey();
  if (rc.loading || rc.cleaning || rc.loadedForWorkspace === key) return;
  if (rc.loadedForWorkspace) {
    rc.data = null;
    rc.lastResult = null;
  }
  void refreshRuntimeCacheStatus({ silent: true });
}

export async function refreshRuntimeCacheStatus({ silent = false } = {}) {
  const rc = state.runtimeCache;
  if (rc.loading) return rc.data;
  const key = runtimeCacheScopeKey();
  rc.loading = true;
  rc.loadedForWorkspace = key;
  rc.error = '';
  renderRuntimeCacheSection();
  try {
    const data = await rpcCall('getRuntimeCacheStatus', {});
    // 请求期间切换了会话 / 工作区：丢弃旧结果，并在旧请求收尾后重新拉取新范围。
    if (runtimeCacheScopeKey() === key) {
      rc.data = data && typeof data === 'object' ? data : null;
      return rc.data;
    }
    return null;
  } catch (err) {
    if (runtimeCacheScopeKey() === key) {
      rc.error = describeRpcError(err);
      if (!silent) showToast(`运行缓存统计失败：${rc.error}`, 'error');
    }
    return null;
  } finally {
    const stale = runtimeCacheScopeKey() !== key;
    rc.loading = false;
    if (stale) {
      rc.loadedForWorkspace = '';
      rc.data = null;
      rc.lastResult = null;
      rc.error = '';
    }
    renderRuntimeCacheSection();
    if (stale) ensureRuntimeCacheLoaded();
  }
}

export async function handleCleanRuntimeCache() {
  const rc = state.runtimeCache;
  if (rc.cleaning) return;
  const key = runtimeCacheScopeKey();
  rc.cleaning = true;
  renderRuntimeCacheSection();
  let cleaned = false;
  try {
    const res = await rpcCall('cleanRuntimeCache', {});
    if (runtimeCacheScopeKey() === key) {
      rc.lastResult = res || null;
      if (res?.status) {
        rc.data = res.status;
        rc.loadedForWorkspace = key;
      }
      const removed = Array.isArray(res?.removedWorktrees) ? res.removedWorktrees.length : 0;
      const kept = protectedCacheWorktrees().length;
      const parts = [`已释放 ${formatCacheBytes(res?.freedBytes)}`];
      if (removed) parts.push(`清理 ${removed} 个闲置工作树`);
      if (kept) parts.push(`${kept} 个受保护工作树已保留`);
      const sqlite = res?.sqliteCompaction;
      if (sqlite?.vacuumed && Number(sqlite.freedBytes) > 0) parts.push(`数据库温和压实回收 ${formatCacheBytes(sqlite.freedBytes)}`);
      else if (sqlite?.vacuumSkippedReason === 'active_tasks') parts.push('有运行中任务，数据库物理压实已跳过（仅裁剪事件并折叠 WAL）');
      showToast(`运行缓存清理完成：${parts.join('，')}`, 'success');
      cleaned = true;
    }
  } catch (err) {
    if (runtimeCacheScopeKey() === key) showToast(`运行缓存清理失败：${describeRpcError(err)}`, 'error');
  } finally {
    const stale = runtimeCacheScopeKey() !== key;
    rc.cleaning = false;
    if (stale) {
      rc.loadedForWorkspace = '';
      rc.data = null;
      rc.lastResult = null;
      rc.error = '';
    }
    renderRuntimeCacheSection();
  }
  await refreshRuntimeCacheStatus({ silent: true });
  if (cleaned) void refreshWorktreesList({ silent: true });
}

// 受保护工作树 = 当前统计中不可清理项 ∪ 刚执行完清理的跳过项（按路径去重）
function protectedCacheWorktrees() {
  const rc = state.runtimeCache;
  const seen = new Map();
  const add = (w) => {
    if (!w || w.cleanable) return;
    const key = String(w.worktreePath || w.worktreeId || w.name || '').toLowerCase();
    if (key && !seen.has(key)) seen.set(key, w);
  };
  for (const w of rc.data?.worktrees || []) add(w);
  for (const w of rc.lastResult?.skippedWorktrees || []) add({ ...w, cleanable: false });
  return [...seen.values()];
}

export function renderRuntimeCacheSection() {
  const summary = document.getElementById('runtime-cache-summary');
  if (!summary) return;
  const rc = state.runtimeCache;
  const data = rc.data;
  let html;
  if (data) {
    const prot = Math.max(Number(data.protectedWorktreeCount) || 0, protectedCacheWorktrees().length);
    html = `当前项目运行缓存 ${escapeHtml(formatCacheBytes(data.totalBytes))}（含 ${Number(data.idleWorktreeCount) || 0} 个闲置工作树）`
      + (Number(data.reclaimableBytes) > 0 ? ` <span class="rc-sub">· 可回收 ${escapeHtml(formatCacheBytes(data.reclaimableBytes))}</span>` : '')
      + (prot ? ` <span class="rc-sub">· ${prot} 个受保护保留</span>` : '');
  } else if (rc.error) {
    html = '当前项目运行缓存 <span class="rc-sub">统计失败</span>';
  } else {
    html = '当前项目运行缓存 <span class="rc-sub">统计中…</span>';
  }
  if (summary.innerHTML !== html) summary.innerHTML = html;

  const busy = rc.cleaning || rc.loading;
  const cleanBtn = document.getElementById('btn-clean-runtime-cache');
  if (cleanBtn) {
    cleanBtn.disabled = busy;
    cleanBtn.setAttribute('aria-busy', String(rc.cleaning));
    const label = rc.cleaning ? '清理中…' : '一键安全清理';
    if (cleanBtn.textContent !== label) cleanBtn.textContent = label;
  }
  const refreshBtn = document.getElementById('btn-refresh-runtime-cache');
  if (refreshBtn) refreshBtn.disabled = busy;

  const hint = document.getElementById('runtime-cache-protected-hint');
  if (!hint) return;
  const kept = protectedCacheWorktrees();
  let text = '';
  if (rc.error && !data) {
    text = `统计失败：${rc.error}`;
  } else if (kept.length) {
    const shown = kept.slice(0, 3).map((w) => {
      const why = (Array.isArray(w.reasons) ? w.reasons : []).map((r) => r?.label).filter(Boolean).join('、');
      return `${w.name || w.branch || w.worktreeId || '工作树'}${why ? `（${why}）` : ''}`;
    });
    text = `已保护保留 ${kept.length} 个工作树：${shown.join('；')}${kept.length > shown.length ? ` 等` : ''}`;
  }
  hint.classList.toggle('is-error', Boolean(rc.error && !data));
  if (hint.textContent !== text) hint.textContent = text;
  hint.hidden = !text;
}

/* ========================================================================
 * 11. 项目规范（Spec）：[插件自带] / [业务规范] / [工程红线] 三组常亮只读清单 + 单条懒加载只读预览（免手动初始化、不做在线编辑器、零定时轮询）
 * ======================================================================== */
// 与运行缓存共用作用域键（会话 | 工作区）：切换后丢弃在途旧响应并重拉
function resetProjectSpecsData(ps) {
  ps.data = null;
  ps.error = '';
  ps.openKey = '';
  ps.bodies = {};
  ps.bodyLoading = '';
  ps.bodyError = '';
}

function ensureProjectSpecsLoaded() {
  const ps = state.projectSpecs;
  if (state.activeView !== 'settings' || state.settingsPane !== 'project') return;
  const key = runtimeCacheScopeKey();
  if (ps.loading || ps.initializing || ps.loadedForWorkspace === key) return;
  void refreshProjectSpecs({ silent: true });
}

export async function refreshProjectSpecs({ silent = false } = {}) {
  const ps = state.projectSpecs;
  if (ps.loading) return ps.data;
  const key = runtimeCacheScopeKey();
  if (ps.loadedForWorkspace !== key) resetProjectSpecsData(ps);
  ps.loading = true;
  ps.loadedForWorkspace = key;
  ps.error = '';
  renderProjectSpecsSection();
  try {
    const data = await rpcCall('listProjectSpecs', {});
    // 请求期间切换了会话 / 工作区：丢弃旧结果，并在旧请求收尾后重新拉取新范围。
    if (runtimeCacheScopeKey() === key) {
      ps.data = data && typeof data === 'object' ? data : null;
      // v0.2.11：列表回执顺带当前项目规范维护快照（listProjectSpecs.curation）
      if (ps.data?.curation) applySpecCurationPayload(ps.data.curation);
      // v0.3.0：列表顶层 specEnabled / archive 快照同步进当前项目规范状态
      absorbSpecListState(ps.data);
      // 列表刷新后只保留仍存在条目的正文缓存与展开态
      const alive = new Set(allProjectSpecs(ps.data).map((s) => s.key));
      for (const k of Object.keys(ps.bodies)) if (!alive.has(k)) delete ps.bodies[k];
      if (ps.openKey && !alive.has(ps.openKey)) ps.openKey = '';
      return ps.data;
    }
    return null;
  } catch (err) {
    if (runtimeCacheScopeKey() === key) {
      ps.error = describeRpcError(err);
      if (!silent) showToast(`项目规范读取失败：${ps.error}`, 'error');
    }
    return null;
  } finally {
    const stale = runtimeCacheScopeKey() !== key;
    ps.loading = false;
    if (stale) {
      ps.loadedForWorkspace = '';
      resetProjectSpecsData(ps);
    }
    renderProjectSpecsSection();
    if (stale) ensureProjectSpecsLoaded();
  }
}

/** 手动 ↻：清空正文缓存后重读（磁盘上的规范可能已被编辑）。 */
export function reloadProjectSpecs() {
  const ps = state.projectSpecs;
  if (ps.loading || ps.initializing) return;
  ps.bodies = {};
  ps.bodyLoading = '';
  ps.bodyError = '';
  void refreshProjectSpecs({ silent: false }).then(() => {
    if (ps.openKey) void loadProjectSpecBody(ps.openKey);
  });
}

/** v0.3.0：listProjectSpecs 顶层 specEnabled / archive 并入当前项目规范快照（不改写 status 补拉标记）。 */
function absorbSpecListState(data) {
  if (!data || typeof data !== 'object' || state.conversationUnbound) return;
  const patch = {};
  if (typeof data.specEnabled === 'boolean') patch.specEnabled = data.specEnabled;
  if (data.archive && typeof data.archive === 'object') patch.archive = normalizeSpecArchive(data.archive);
  if (!Object.keys(patch).length) return;
  const cur = currentSpecCuration();
  state.specCuration = { ...cur, workspace: cur.workspace || normalizeProjectPath(data.workspace || '') || specCurationWorkspace(), ...patch };
}

async function runProjectSpecsInitialization(globalSync) {
  const ps = state.projectSpecs;
  if (ps.initializing || ps.loading) return;
  const currentData = ps.loadedForWorkspace === runtimeCacheScopeKey() ? ps.data : null;
  if (globalSync && (state.conversationUnbound || (!getEffectiveCwd() && !currentData?.workspace))) {
    showToast('当前未绑定项目目录，无法同步插件规范模板', 'info');
    return false;
  }
  if (!isProjectSpecEnabled()) {
    showToast(SPEC_CURATION_ERRORS.SPEC_DISABLED_FOR_PROJECT, 'info');
    return false;
  }
  const key = runtimeCacheScopeKey();
  ps.initializing = true;
  renderProjectSpecsSection();
  try {
    const res = await rpcCall('initProjectSpecs', {});
    if (runtimeCacheScopeKey() === key) {
      const n = (v) => (Array.isArray(v) ? v.length : 0);
      const parts = [`新建 ${n(res?.createdPaths)} 项`];
      if (n(res?.refreshedPaths)) parts.push(`同步 ${n(res.refreshedPaths)} 项插件镜像`);
      if (n(res?.preservedPaths)) parts.push(`保留已有 ${n(res.preservedPaths)} 项`);
      showToast(globalSync ? `插件规范模板同步完成：${parts.join('，')}` : `项目规范骨架已就绪：${parts.join('，')}`, 'success');
    }
  } catch (err) {
    if (runtimeCacheScopeKey() === key) showToast(globalSync ? `插件规范模板同步失败：${describeSpecCurationError(err)}` : `项目规范初始化失败：${describeSpecCurationError(err)}`, 'error');
  } finally {
    ps.initializing = false;
    renderProjectSpecsSection();
  }
  await refreshProjectSpecs({ silent: true });
}

export function handleInitProjectSpecs() {
  return runProjectSpecsInitialization(false);
}

export function handleSyncPluginSpecTemplates() {
  return runProjectSpecsInitialization(true);
}

export async function openProjectSpecInEditor(relPath, baseDir = '') {
  const rawPath = String(relPath || '').trim();
  const normalized = rawPath.replace(/\\/g, '/');
  if (/(^|\/)(?:\.agent-tower\/spec\/)?00-plugin(?:\/|$)/.test(normalized)) {
    showToast('插件自带模板为只读，不可直接编辑；如需更新镜像请点项目规范顶栏「同步 00-plugin/ 镜像」', 'info');
    return false;
  }
  if (!rawPath || normalized.split('/').includes('..') || /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('/') || rawPath.startsWith('file://')) {
    showToast('规范路径为空、越界或使用绝对路径，已拒绝打开', 'info');
    return false;
  }
  const fullPath = baseDir
    ? `${String(baseDir).replace(/[\\/]+$/, '')}/${rawPath.replace(/^(\.[\\/])+/, '').replace(/^[\\/]+/, '')}`
    : rawPath;
  if (globalThis.window?.sidecar?.ui?.toggleAuxPane) {
    try {
      await globalThis.window.sidecar.ui.toggleAuxPane({ tabType: 'fileView', uri: pathToFileUri(fullPath) });
      showToast(`已在宿主编辑器打开 ${shortenPath(rawPath)}（保存后可点 ↻ 刷新）`, 'success');
      return true;
    } catch (err) {
      showToast(`宿主编辑器打开失败：${describeRpcError(err)}`, 'error');
      return false;
    }
  }
  const ok = await copyPlainText(fullPath);
  showToast(ok ? `独立浏览器模式：已复制规范路径 ${fullPath}` : `独立浏览器模式：复制失败，规范路径 ${fullPath}`, ok ? 'success' : 'error');
  return ok;
}

/** 点开 / 收起单条规范；首次展开时懒加载只读正文（listProjectSpecs + includeBody）。 */
export function toggleProjectSpec(specKey) {
  const ps = state.projectSpecs;
  if (!specKey) return;
  ps.openKey = ps.openKey === specKey ? '' : specKey;
  ps.bodyError = '';
  renderProjectSpecsSection();
  if (ps.openKey) void loadProjectSpecBody(specKey);
}

async function loadProjectSpecBody(specKey) {
  const ps = state.projectSpecs;
  if (ps.bodies[specKey] || ps.bodyLoading === specKey) return;
  const key = runtimeCacheScopeKey();
  const bodies = ps.bodies;
  ps.bodyLoading = specKey;
  renderProjectSpecsSection();
  try {
    const res = await rpcCall('listProjectSpecs', { specId: specKey, includeBody: true });
    if (bodies === ps.bodies && runtimeCacheScopeKey() === key) {
      // 插件自带条目由 res.pluginSpecs 返回；后端暂未带 body 时详情回退为内存模板说明
      const found = allProjectSpecs(res).find((s) => s.key === specKey);
      if (found) ps.bodies[specKey] = found;
      else if (ps.openKey === specKey) ps.bodyError = describeRpcError({ code: 'SPEC_NOT_FOUND' });
    }
  } catch (err) {
    if (bodies === ps.bodies && runtimeCacheScopeKey() === key && ps.openKey === specKey) ps.bodyError = describeRpcError(err);
  } finally {
    if (bodies === ps.bodies && ps.bodyLoading === specKey) ps.bodyLoading = '';
    renderProjectSpecsSection();
  }
}

function projectSpecList(data) {
  return (Array.isArray(data?.specs) ? data.specs : []).filter((s) => s && typeof s === 'object' && s.key);
}

const PLUGIN_SPEC_DIR = '.agent-tower/spec/00-plugin';

function pluginSpecList(data) {
  return (Array.isArray(data?.pluginSpecs) ? data.pluginSpecs : [])
    .filter((s) => s && typeof s === 'object' && s.key)
    .map((s) => ({ ...s, kind: 'plugin', relPath: s.relPath || `${PLUGIN_SPEC_DIR}/${s.id || String(s.key).replace(/^plugin\//, '')}.md` }));
}

function allProjectSpecs(data) {
  return [...pluginSpecList(data), ...projectSpecList(data)];
}

function specKindLabel(kind) {
  return kind === 'plugin' ? '插件自带' : SPEC_KIND_LABELS[kind] || kind || '规范';
}

function specScopesText(spec, limit = 2) {
  const scopes = Array.isArray(spec.scopes) ? spec.scopes.map(String).filter(Boolean) : [];
  if (!scopes.length) return '';
  return scopes.slice(0, limit).join(', ') + (scopes.length > limit ? ` +${scopes.length - limit}` : '');
}

function renderSpecWarningsHtml(warnings, cls = 'spec-warn-list') {
  const list = (Array.isArray(warnings) ? warnings : []).filter((w) => w && typeof w === 'object');
  if (!list.length) return '';
  return `<ul class="${cls}" role="alert">${list.map((w) => `<li><strong>${escapeHtml(SPEC_WARNING_LABELS[w.code] || w.code || '告警')}</strong>${w.key ? ` <code>${escapeHtml(w.key)}</code>` : ''}${w.message ? `：${escapeHtml(w.message)}` : ''}</li>`).join('')}</ul>`;
}

function renderProjectSpecRowHtml(spec, open) {
  const key = String(spec.key);
  const kind = specKindLabel(spec.kind);
  const warnCount = Array.isArray(spec.warnings) ? spec.warnings.length : 0;
  const scopes = specScopesText(spec);
  return `<button type="button" class="ps-row-btn" data-spec-open="${escapeHtml(key)}" data-fk="ps:${escapeHtml(key)}" aria-expanded="${open}" title="${escapeHtml(spec.relPath || key)}">
      <span class="spec-kind-tag" data-kind="${escapeHtml(spec.kind)}">${escapeHtml(kind)}</span>
      <span class="ps-row-name">${escapeHtml(spec.title || spec.id || key)}</span>
      ${spec.required ? '<span class="spec-req-tag">必读</span>' : ''}
      ${scopes ? `<span class="ps-row-scope">${escapeHtml(scopes)}</span>` : ''}
      <span class="spec-meta-faint">${escapeHtml(formatSpecBytes(spec.bytes))}</span>
      ${warnCount ? `<span class="spec-tier-tag is-danger">⚠ ${warnCount}</span>` : ''}
    </button>`;
}

function renderProjectSpecDetailHtml(spec) {
  const ps = state.projectSpecs;
  const full = ps.bodies[spec.key] || spec;
  const chips = (arr) => (Array.isArray(arr) ? arr : []).map(String).filter(Boolean).map((x) => `<code class="ps-chip">${escapeHtml(x)}</code>`).join('');
  const scopes = chips(full.scopes);
  const tags = chips(full.tags);
  const plugin = spec.kind === 'plugin';
  let bodyHtml = '';
  if (typeof full.body === 'string') {
    bodyHtml = full.body.trim() ? `<pre class="ps-body-pre">${escapeHtml(full.body)}</pre>` : '<p class="ps-muted">正文为空</p>';
  } else if (ps.bodyLoading === spec.key) {
    bodyHtml = '<p class="ps-muted">正文加载中…</p>';
  } else if (plugin) {
    // 后端未随 pluginSpecs 返回 body 时的回退说明（不报错）
    bodyHtml = `<p class="ps-muted">路径: ${escapeHtml(full.relPath || spec.relPath)} · 由插件内存模板实时装配注入</p>`;
  } else if (ps.bodyError && ps.openKey === spec.key) {
    bodyHtml = `<p class="ps-muted is-error">正文加载失败：${escapeHtml(ps.bodyError)}</p>`;
  }
  const scopeHint = plugin ? '按角色自动注入塔台外部子 Agent' : '未限定（仅点名 / 关键词命中）';
  const relPath = full.relPath || spec.relPath || '';
  const baseDir = ps.data?.workspace || getEffectiveCwd() || '';
  const hasHostEditor = Boolean(globalThis.window?.sidecar?.ui?.toggleAuxPane);
  const toolbar = plugin
    ? '<div class="ps-detail-toolbar is-readonly" data-spec-readonly="plugin"><span class="ps-lock-badge">只读模板</span><span class="ps-lock-hint">只读，顶栏可同步镜像</span></div>'
    : `<div class="ps-detail-toolbar" data-spec-actions="${escapeHtml(spec.key)}"><button type="button" class="ghost-xs-btn ps-open-editor-btn" data-spec-open-editor="${escapeHtml(relPath)}" data-base-dir="${escapeHtml(baseDir)}" data-fk="ps-edit:${escapeHtml(spec.key)}">${hasHostEditor ? '在编辑器中打开' : '复制规范路径'}</button><span class="ps-lock-hint">保存后点 ↻ 刷新</span></div>`;
  return `<div class="ps-detail">
      ${full.summary ? `<p class="ps-summary-text">${escapeHtml(full.summary)}</p>` : ''}
      <dl class="ps-kv">
        <dt>路径</dt><dd><code>${escapeHtml(full.relPath || spec.relPath || spec.key)}</code></dd>
        <dt>范围</dt><dd>${scopes || `<span class="ps-muted">${scopeHint}</span>`}</dd>
        ${tags ? `<dt>标签</dt><dd>${tags}</dd>` : ''}
      </dl>
      ${toolbar}
      ${renderSpecWarningsHtml(full.warnings)}
      ${bodyHtml}
    </div>`;
}

/** 全局「插件角色底线模板」底部轻量状态行。 */
export function renderPluginSpecTemplateSection() {
  const summary = document.getElementById('plugin-spec-template-summary');
  if (!summary) return;
  const ps = state.projectSpecs;
  const data = ps.loadedForWorkspace === runtimeCacheScopeKey() ? ps.data : null;
  const n = pluginSpecList(data).length || 5;
  const text = `内置 ${n} 套角色底线模板（只读自动生效）`;
  if (summary.textContent !== text) summary.textContent = text;
}

/** 项目规范顶栏「同步 00-plugin/ 镜像」：仅本项目接入规范时可用，标题提示当前镜像状态。 */
function renderPluginMirrorSyncButton(data, unbound, specOn) {
  const syncBtn = document.getElementById('btn-sync-plugin-spec-templates');
  if (!syncBtn) return;
  const ps = state.projectSpecs;
  syncBtn.hidden = !specOn;
  syncBtn.disabled = unbound || !specOn || ps.loading || ps.initializing;
  syncBtn.setAttribute('aria-busy', String(ps.initializing));
  const label = ps.initializing ? '同步中…' : '同步 00-plugin/ 镜像';
  if (syncBtn.textContent !== label) syncBtn.textContent = label;
  syncBtn.title = unbound
    ? '当前未绑定项目目录'
    : data?.pluginMirrorUpToDate === true
      ? '本项目 00-plugin/ 镜像已是最新（再次同步不改动业务与编码规范）'
      : '将最新插件角色底线模板同步写入本项目 .agent-tower/spec/00-plugin/；已有项目业务与编码规范保留不动';
}

/** 本项目规范接入总开关：只改属性与类名，不覆盖轨道节点。 */
function renderSpecEnabledSwitch(specOn, unbound) {
  const sw = document.getElementById('btn-project-spec-enabled');
  if (!sw) return;
  const busy = state.specCurationUi.busy === 'enable';
  sw.setAttribute('aria-checked', String(specOn));
  sw.classList.toggle('is-on', specOn);
  sw.disabled = unbound || Boolean(state.specCurationUi.busy);
  sw.setAttribute('aria-busy', String(busy));
  sw.title = unbound ? '当前未绑定项目目录' : specOn ? '本项目已接入项目规范（点击停用：仅停止注入与维护，不搬动任何文件）' : '本项目未接入项目规范（点击开启）';
}

/** 停用横幅 + 归档 / 恢复按钮（二次确认文案随 armed 态切换）。 */
function renderSpecArchiveRow(data, specOn, unbound) {
  const row = document.getElementById('project-specs-state-row');
  if (!row) return;
  const cur = currentSpecCuration();
  const archive = cur.archive || {};
  const ui = state.specCurationUi;
  const busy = Boolean(ui.busy);
  const hasSpecs = projectSpecList(data).some((s) => s.kind === 'business' || s.kind === 'coding');
  const canArchive = !unbound && !archive.exists && (specOn ? hasSpecs || archive.hasActiveSpecs : archive.hasActiveSpecs || hasSpecs);
  const canRestore = !unbound && archive.exists;
  const setBtn = (id, show, idleLabel, busyKey, confirmKey) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const armed = (state.pendingConfirms.get(confirmKey) || 0) > Date.now();
    btn.hidden = !show;
    btn.disabled = busy;
    btn.classList.toggle('is-armed', armed);
    btn.setAttribute('aria-busy', String(ui.busy === busyKey));
    const label = ui.busy === busyKey ? '处理中…' : armed ? `确认${idleLabel}？` : idleLabel;
    if (btn.textContent !== label) btn.textContent = label;
  };
  setBtn('btn-archive-project-specs', canArchive, '归档规范', 'archive', 'spec-archive');
  setBtn('btn-restore-project-specs', canRestore, '恢复归档', 'restore', 'spec-restore');
  setBtn('btn-restore-enable-project-specs', canRestore && !specOn, '恢复并开启', 'restore-enable', 'spec-restore-enable');
  const banner = document.getElementById('project-specs-disabled-banner');
  if (banner) banner.hidden = specOn || unbound;
  const hint = document.getElementById('project-specs-archive-hint');
  let hintText = '';
  if (!unbound && archive.exists) {
    hintText = `已归档 ${archive.fileCount || 0} 篇至 .agent-tower/spec-archive/${archive.archivedAt ? ` · ${formatTimeShort(archive.archivedAt)}` : ''}`;
    if (archive.conflictPaths?.length) hintText += ` · ${archive.conflictPaths.length} 处同名冲突需先处理后再恢复`;
  }
  if (hint) {
    if (hint.textContent !== hintText) hint.textContent = hintText;
    hint.hidden = !hintText;
  }
  row.classList.toggle('is-disabled', !specOn && !unbound);
  row.hidden = unbound || (specOn && !canArchive && !canRestore);
}

export function renderProjectSpecsSection() {
  const ps = state.projectSpecs;
  const current = ps.loadedForWorkspace === runtimeCacheScopeKey();
  const data = current ? ps.data : null;
  const unbound = specCurationUnbound();
  const specOn = isProjectSpecEnabled();
  renderPluginSpecTemplateSection();
  renderSpecEnabledSwitch(specOn, unbound);
  renderPluginMirrorSyncButton(data, unbound, specOn);
  renderSpecArchiveRow(data, specOn, unbound);
  // 本项目未接入：折叠自动维护 / ✨ 维护规范 / 配额栏 / 规范清单
  const autoWrap = document.getElementById('spec-curation-auto-wrap');
  if (autoWrap) autoWrap.hidden = !specOn;
  const trigBtn = document.getElementById('btn-spec-curation-trigger');
  if (trigBtn) trigBtn.hidden = !specOn;
  const quota = document.getElementById('project-specs-quota-bar');
  if (quota) quota.hidden = !specOn;
  const summary = document.getElementById('project-specs-summary');
  if (!summary) return;
  const counts = data?.counts || {};
  const num = (v) => Math.max(0, Number(v) || 0);
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
  const plugins = pluginSpecList(data);
  let html;
  if (!specOn && !unbound) {
    html = `项目规范 <span class="rc-sub">未接入 · 仅生效 ${num(counts.plugin ?? plugins.length) || 5} 套内置角色底线</span>`;
  } else if (data) {
    html = `插件自带 ${num(counts.plugin ?? plugins.length)} · 业务 ${num(counts.business)} · 编码 ${num(counts.coding)}`
      + (warnings.length ? ` <span class="ps-warn-count">· ⚠ ${warnings.length} 条告警</span>` : '');
  } else if (current && ps.error) {
    html = '项目规范 <span class="rc-sub">读取失败</span>';
  } else {
    html = '项目规范 <span class="rc-sub">读取中…</span>';
  }
  if (summary.innerHTML !== html) summary.innerHTML = html;

  const busy = ps.loading || ps.initializing;
  const refreshBtn = document.getElementById('btn-refresh-project-specs');
  if (refreshBtn) refreshBtn.disabled = busy;
  // 免手动初始化：业务规范由主会话从用户拍板结论沉淀，不再引导生成空壳示例
  const initBtn = document.getElementById('btn-init-project-specs');
  if (initBtn) initBtn.hidden = true;
  renderSpecCurationSection();

  const body = document.getElementById('project-specs-body');
  if (!body) return;
  let inner = '';
  if (!specOn) {
    inner = '';
  } else if (current && ps.error && !data) {
    inner = `<p class="rc-hint is-error">读取失败：${escapeHtml(ps.error)}</p>`;
  } else if (data) {
    const warnHtml = renderSpecWarningsHtml(warnings, 'spec-warn-list ps-global-warn');
    const specs = projectSpecList(data);
    const groups = [
      { label: '[插件自带]', items: plugins, empty: '' },
      { label: '[业务规范]', items: specs.filter((s) => s.kind === 'business'), empty: '对话中拍板的业务规则由专职规范维护官只读提案、经你确认后沉淀至 01-business/' },
      { label: '[工程红线]', items: specs.filter((s) => s.kind === 'coding'), empty: '工程红线置于 02-coding/' },
    ];
    const open = groups.flatMap((g) => g.items).find((s) => s.key === ps.openKey) || null;
    // 窄栏：明细紧跟所在行原位展开；宽屏由右侧只读预览栏呈现（CSS 隐藏行内副本）
    const rowHtml = (s) => {
      const isOpen = open?.key === s.key;
      return `<li class="ps-item${isOpen ? ' is-open' : ''}">${renderProjectSpecRowHtml(s, isOpen)}${isOpen ? `<div class="ps-inline-detail">${renderProjectSpecDetailHtml(s)}</div>` : ''}</li>`;
    };
    const rows = groups.map((g) => `<li class="ps-group-head">${escapeHtml(g.label)}<span class="spec-meta-faint">${g.items.length}</span></li>`
      + (g.items.length ? g.items.map(rowHtml).join('') : g.empty ? `<li class="ps-group-empty">${escapeHtml(g.empty)}</li>` : '')).join('');
    const preview = open
      ? `<div class="ps-preview-head"><span class="spec-kind-tag" data-kind="${escapeHtml(open.kind)}">${escapeHtml(specKindLabel(open.kind))}</span><span class="ps-row-name">${escapeHtml(open.title || open.id || open.key)}</span></div>${renderProjectSpecDetailHtml(open)}`
      : '<p class="ps-muted ps-preview-empty">点击左侧规范查看摘要、适用范围与只读正文</p>';
    inner = `${warnHtml}<div class="ps-layout"><ul class="ps-list">${rows}</ul><aside class="ps-preview" aria-label="规范只读预览">${preview}</aside></div>`;
  }
  setHtmlKeepingFocus(body, inner);
  body.hidden = !inner;
}

/* ----- v0.3.0 可插拔项目规范：总开关与双向手动归档 / 恢复（全部经 Studio 专用 specCuration RPC） ----- */
/** 回执优先采用服务端 curation 快照；未回传时按动作结果做最小乐观合并（含 specEnabled / archive）。 */
function absorbSpecToggleReply(res, patch) {
  if (res?.curation && applySpecCurationPayload(res.curation)) {
    absorbSpecListState(res);
    return;
  }
  const next = { ...patch };
  if (typeof res?.specEnabled === 'boolean') next.specEnabled = res.specEnabled;
  if (res?.archive && typeof res.archive === 'object') next.archive = res.archive;
  if (typeof res?.autoTrigger === 'boolean') next.autoTrigger = res.autoTrigger;
  applySpecCurationPayload({ ...currentSpecCuration(), workspace: res?.workspace || currentSpecCuration().workspace || specCurationWorkspace(), ...next });
}

/** 切换后统一刷新：列表 / 配额 / 阵容页维护组与成员页提醒。 */
async function afterSpecStateChange() {
  const ps = state.projectSpecs;
  ps.bodies = {};
  ps.openKey = '';
  await refreshProjectSpecs({ silent: true });
}

export async function toggleProjectSpecEnabled() {
  const ui = state.specCurationUi;
  if (ui.busy) return false;
  if (specCurationUnbound()) {
    showToast('当前未绑定项目目录，无法切换本项目规范', 'info');
    return false;
  }
  const next = !isProjectSpecEnabled();
  ui.busy = 'enable';
  ui.triggerOpen = false;
  rerenderSpecCuration();
  try {
    const res = await rpcCall('specCuration', { action: 'setEnabled', ...specCurationParams(), enabled: next });
    // 停用时服务端同步关闭自动维护并中断在途维护官
    absorbSpecToggleReply(res, next ? { specEnabled: true } : { specEnabled: false, autoTrigger: false, running: false, activeThreadId: null, activeRunId: null });
    showToast(next
      ? '已接入本项目规范：子 Agent 按需注入 .agent-tower/spec/ 业务与编码红线'
      : '已停用本项目规范：仅注入插件角色底线，零读写 .agent-tower/spec/（磁盘文件原样保留，可随时重新开启或归档）', 'success');
    await afterSpecStateChange();
    return true;
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
    return false;
  } finally {
    ui.busy = '';
    state.pendingSettingsFocus = { keys: ['spec:enabled'] };
    rerenderSpecCuration();
  }
}

async function runSpecArchiveAction(kind) {
  const ui = state.specCurationUi;
  if (ui.busy) return false;
  if (specCurationUnbound()) {
    showToast('当前未绑定项目目录，无法归档 / 恢复项目规范', 'info');
    return false;
  }
  const archive = kind === 'archive';
  const enable = kind === 'restore-enable';
  const confirmKey = archive ? 'spec-archive' : enable ? 'spec-restore-enable' : 'spec-restore';
  const prompt = archive
    ? '再次点击确认归档：01-business/、02-coding/ 与 INDEX.md 将移入 .agent-tower/spec-archive/ 并停用本项目规范（可随时恢复）'
    : enable
      ? '再次点击确认：从 .agent-tower/spec-archive/ 恢复规范并重新接入本项目规范'
      : '再次点击确认：从 .agent-tower/spec-archive/ 恢复规范（保持当前开关状态）';
  if (!armOrConfirm(confirmKey, prompt)) {
    renderProjectSpecsSection();
    return false;
  }
  ui.busy = kind;
  rerenderSpecCuration();
  try {
    const params = archive
      ? { action: 'archive', ...specCurationParams() }
      : { action: 'restore', ...specCurationParams(), enableAfterRestore: enable };
    const res = await rpcCall('specCuration', params);
    const patch = archive
      ? { specEnabled: false, autoTrigger: false, archive: { exists: true, fileCount: Number(res?.fileCount ?? res?.archivedCount) || 0, archivedAt: Date.now(), hasActiveSpecs: false, conflictPaths: [] } }
      : { archive: { exists: false, fileCount: 0, archivedAt: 0, hasActiveSpecs: true, conflictPaths: [] }, ...(enable ? { specEnabled: true } : {}) };
    absorbSpecToggleReply(res, patch);
    showToast(archive
      ? '已归档本项目规范至 .agent-tower/spec-archive/（可随 Git 提交，随时可恢复），本项目规范已停用'
      : enable ? '已恢复归档并重新接入本项目规范' : '已恢复归档至 .agent-tower/spec/（开关状态保持不变）', 'success');
    await afterSpecStateChange();
    return true;
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
    if (['SPEC_ARCHIVE_ALREADY_EXISTS', 'SPEC_ARCHIVE_NOT_FOUND', 'SPEC_RESTORE_CONFLICT', 'SPEC_ARCHIVE_EMPTY'].includes(err?.code)) void refreshSpecCurationStatus({ silent: true });
    return false;
  } finally {
    ui.busy = '';
    rerenderSpecCuration();
  }
}
export function handleArchiveProjectSpecs() {
  return runSpecArchiveAction('archive');
}
export function handleRestoreProjectSpecs(enableAfterRestore = false) {
  return runSpecArchiveAction(enableAfterRestore ? 'restore-enable' : 'restore');
}

/* ========================================================================
 * 12. v0.2.11 专职规范维护官：按项目双向联动自动开关、手动只读梳理与整组提案确认卡
 *     全部写操作只经 Studio 专用 specCuration RPC（不进 MCP 工具集）；本区严禁 <textarea>，单行输入一律 <input type="text">。
 * ======================================================================== */
const SPEC_CURATION_ERRORS = {
  CURATOR_ROSTER_EMPTY: '规范维护组尚未勾选成员：请在「成员池 → 复杂自定义阵容 → 规范维护组」勾选至少 1 名维护官',
  CURATOR_ALREADY_RUNNING: '本项目已有维护官在梳理中，请等待其完成后再试',
  SPEC_PROPOSAL_CONFLICT: '提案生成后规范文件已被外部修改（基线校验不一致），本提案已标记冲突、未写入任何文件；请重新发起维护',
  CURATOR_FEEDBACK_REQUIRED: '请先填写打回修改意见',
  INVALID_SPEC_LIMITS: '规范上限无效：单篇需为 1～8 KB 整数，总上限需为 8～128 KB 整数且不低于单篇的 2 倍',
  INVALID_SPEC_CURATION_ACTION: '规范维护操作无效（守护进程版本可能过旧，请升级后重试）',
  SPEC_DISABLED_FOR_PROJECT: '本项目未开启项目规范（Spec）：请先在「项目规范」打开「接入项目规范」开关',
  SPEC_ARCHIVE_PENDING_PROPOSAL: '本项目还有待确认的规范维护提案：请先确认或放弃提案后再归档',
  SPEC_ARCHIVE_ALREADY_EXISTS: '本项目已有归档（.agent-tower/spec-archive/），请先恢复或手动清理旧归档后再归档',
  SPEC_ARCHIVE_EMPTY: '本项目暂无可归档的业务 / 编码规范',
  SPEC_ARCHIVE_BUSY: '规范文件正被其他程序占用（已重试 3 次），请关闭占用的编辑器或进程后重试',
  SPEC_ARCHIVE_NOT_FOUND: '未找到本项目规范归档（.agent-tower/spec-archive/），可能已被恢复或删除',
  SPEC_ARCHIVE_CORRUPTED: '归档校验失败（manifest.json 摘要不一致），为安全起见未恢复任何文件，请检查归档目录',
  SPEC_RESTORE_CONFLICT: '恢复冲突：.agent-tower/spec/ 下已存在同名规范文件，为避免覆盖未恢复任何文件，请先处理冲突文件',
};
const SPEC_CURATION_SOURCES = { manual: '手动触发', auto: '自动维护', delegate: '主会话代调', host_main: '主会话提案' };

function extractCurationHostPrompt(res) {
  const list = Array.isArray(res?.hostActions) ? res.hostActions : [];
  const prompts = list
    .map((item) => (typeof item === 'string' ? item : String(item?.hostPrompt || item?.prompt || '').trim()))
    .filter(Boolean);
  if (prompts.length) return prompts.join('\n\n');
  return String(res?.hostAction?.hostPrompt || res?.hostPrompt || '').trim();
}

async function relayCurationHostActions(res, kind = 'trigger') {
  const prompt = extractCurationHostPrompt(res);
  if (!prompt) {
    showToast(kind === 'revise' ? '已生成宿主重拟票据，请在当前主对话执行维护指令' : '已生成宿主维护票据，请在当前主对话执行维护指令', 'info');
    return 'failed';
  }
  const delivered = await relayToHostConversation(prompt);
  if (delivered === 'sent') {
    showToast(kind === 'revise' ? '已将修改意见发送至当前主对话重拟提案' : '已发送至当前主对话启动只读梳理，完成后提案会出现在本卡片待你确认', 'success');
  } else if (delivered === 'copied') {
    showToast(kind === 'revise' ? '已复制重拟维护指令，请粘贴到主对话执行' : '已复制维护指令，请粘贴到主对话执行', 'info');
  } else {
    showToast('未能自动发送维护指令至主对话，请手动在主对话触发规范维护', 'error');
  }
  return delivered;
}

export function describeSpecCurationError(err) {
  return SPEC_CURATION_ERRORS[err?.code] || describeRpcError(err);
}

function specCurationParams() {
  const workspace = specCurationWorkspace();
  return { cwd: getEffectiveCwd() || workspace || undefined, workspace: workspace || undefined };
}

function specCurationUnbound() {
  return state.conversationUnbound || !specCurationWorkspace();
}

/** 回执优先采用服务端 curation 快照；旧守护进程未回传时按动作结果做最小乐观合并。 */
function absorbSpecCurationReply(res, patch = null) {
  if (res?.curation && applySpecCurationPayload(res.curation)) return;
  if (patch) applySpecCurationPayload({ ...currentSpecCuration(), workspace: res?.workspace || currentSpecCuration().workspace, ...patch });
}

function rerenderSpecCuration() {
  renderSpecCurationSection();
  scheduleRender();
}

/** 复杂阵容页打开时补拉一次当前项目快照（Bootstrap / 项目规范列表已下发则跳过；旧守护进程不支持时静默）。 */
export function ensureSpecCurationStatus() {
  const ui = state.specCurationUi;
  const ws = specCurationWorkspace();
  if (!ws || state.conversationUnbound || ui.statusLoading || ui.statusLoadedFor === ws.toLowerCase()) return;
  void refreshSpecCurationStatus({ silent: true });
}

export async function refreshSpecCurationStatus({ silent = true } = {}) {
  const ui = state.specCurationUi;
  const ws = specCurationWorkspace();
  if (!ws || ui.statusLoading) return null;
  ui.statusLoading = true;
  try {
    const res = await rpcCall('specCuration', { action: 'status', ...specCurationParams() });
    if (specCurationWorkspace() === ws) absorbSpecCurationReply(res);
    return res;
  } catch (err) {
    if (!silent) showToast(`规范维护状态读取失败：${describeSpecCurationError(err)}`, 'error');
    return null;
  } finally {
    ui.statusLoading = false;
    // 无论成功与否本工作区只补拉一次，避免旧守护进程反复报错
    if (specCurationWorkspace() === ws) ui.statusLoadedFor = ws.toLowerCase();
    rerenderSpecCuration();
  }
}

/**
 * 「复杂自定义阶段栏 / 规范维护组卡头 / 项目规范顶栏」三处自动维护开关的唯一入口：
 * 读写同一项目级 currentSpecCuration().autoTrigger（不进 toggleModeStage、不改 modeProfiles、不递增 presetRevision）。
 */
export async function toggleSpecCurationAuto() {
  const ui = state.specCurationUi;
  if (ui.busy) return;
  if (specCurationUnbound()) {
    showToast('当前未绑定项目目录，无法设置本项目自动维护', 'info');
    return;
  }
  if (!isProjectSpecEnabled()) {
    showToast(SPEC_CURATION_ERRORS.SPEC_DISABLED_FOR_PROJECT, 'info');
    return;
  }
  const on = currentSpecCuration().autoTrigger;
  if (!on && !preferredCuratorMember()) {
    showToast(SPEC_CURATION_ERRORS.CURATOR_ROSTER_EMPTY, 'error');
    return;
  }
  ui.busy = 'auto';
  rerenderSpecCuration();
  try {
    // 开启前确保阵容勾选已落盘（服务端以已保存的 enabledKeys 判定 CURATOR_ROSTER_EMPTY）
    if (!on && !(await ensurePresetsSaved())) return;
    const res = await rpcCall('specCuration', { action: 'setAuto', ...specCurationParams(), autoTrigger: !on });
    absorbSpecCurationReply(res, { autoTrigger: typeof res?.autoTrigger === 'boolean' ? res.autoTrigger : !on });
    showToast(!on ? '已开启本项目自动维护：复杂模式宿主收口后有新干活时自动只读梳理' : '已关闭本项目自动维护（仍可手动「✨ 维护规范」）', 'success');
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
  } finally {
    ui.busy = '';
    state.pendingSettingsFocus = { keys: ['flow:curator', 'stage:curator', 'curation:auto'] };
    rerenderSpecCuration();
  }
}

function syncSpecLimitInputs(cur = currentSpecCuration(), unbound = specCurationUnbound(), force = false) {
  const ui = state.specCurationUi;
  const singleEl = document.getElementById('inp-spec-single-kb');
  const totalEl = document.getElementById('inp-spec-total-kb');
  const usedEl = document.getElementById('spec-quota-used');
  if (singleEl) {
    singleEl.disabled = unbound || ui.busy === 'limits' || cur.specEnabled === false;
    if (force || document.activeElement !== singleEl) singleEl.value = String(cur.singleMaxKb);
  }
  if (totalEl) {
    totalEl.disabled = unbound || ui.busy === 'limits' || cur.specEnabled === false;
    if (force || document.activeElement !== totalEl) totalEl.value = String(cur.totalMaxKb);
  }
  if (usedEl) {
    const ps = state.projectSpecs;
    const data = ps.loadedForWorkspace && !unbound ? ps.data : null;
    if (data) {
      const usedBytes = Number.isFinite(Number(data.totalProjectBytes))
        ? Math.max(0, Number(data.totalProjectBytes))
        : (Array.isArray(data.specs) ? data.specs : [])
            .filter((s) => s && (s.kind === 'business' || s.kind === 'coding'))
            .reduce((sum, s) => sum + Math.max(0, Number(s.bytes) || 0), 0);
      const kbText = (usedBytes / 1024).toFixed(1).replace(/\.0$/, '');
      const text = `已用 ${kbText} KB`;
      if (usedEl.textContent !== text) usedEl.textContent = text;
      usedEl.classList.toggle('is-over', usedBytes > cur.totalMaxKb * 1024);
      usedEl.hidden = false;
    } else {
      usedEl.textContent = '';
      usedEl.classList.remove('is-over');
      usedEl.hidden = true;
    }
  }
}

/** 按项目独立保存单篇规范上限（1～8 KB）与总存量上限（8～128 KB，至少为单篇的 2 倍）。 */
export async function saveSpecCurationLimits(changedField = '', rawSingle, rawTotal) {
  const ui = state.specCurationUi;
  if (ui.busy) return false;
  if (specCurationUnbound()) {
    showToast('当前未绑定项目目录，无法设置本项目规范上限', 'info');
    syncSpecLimitInputs(currentSpecCuration(), true, true);
    return false;
  }
  if (!isProjectSpecEnabled()) {
    showToast(SPEC_CURATION_ERRORS.SPEC_DISABLED_FOR_PROJECT, 'info');
    return false;
  }
  const cur = currentSpecCuration();
  const sStr = String(rawSingle ?? document.getElementById('inp-spec-single-kb')?.value ?? '').trim();
  const tStr = String(rawTotal ?? document.getElementById('inp-spec-total-kb')?.value ?? '').trim();
  const single = Number(sStr);
  let total = Number(tStr);
  if (!sStr || !Number.isInteger(single) || single < 1 || single > 8) {
    showToast('单篇规范上限需为 1～8 KB 的整数', 'error');
    syncSpecLimitInputs(cur, false, true);
    return false;
  }
  if (!tStr || !Number.isInteger(total) || total < 8 || total > 128) {
    showToast('项目规范总上限需为 8～128 KB 的整数', 'error');
    syncSpecLimitInputs(cur, false, true);
    return false;
  }
  if (total < single * 2) {
    if (changedField === 'single') {
      total = Math.min(128, Math.max(8, single * 2));
    } else {
      showToast(`项目规范总上限（${total} KB）至少需为单篇上限（${single} KB）的 2 倍`, 'error');
      syncSpecLimitInputs(cur, false, true);
      return false;
    }
  }
  if (single === cur.singleMaxKb && total === cur.totalMaxKb) {
    syncSpecLimitInputs(cur, false, true);
    return false;
  }
  ui.busy = 'limits';
  syncSpecLimitInputs(cur, false, false);
  try {
    const res = await rpcCall('specCuration', { action: 'setLimits', ...specCurationParams(), singleMaxKb: single, totalMaxKb: total });
    absorbSpecCurationReply(res, { singleMaxKb: single, totalMaxKb: total });
    syncSpecLimitInputs(currentSpecCuration(), false, true);
    await refreshProjectSpecs({ silent: true });
    showToast(`已更新本项目规范上限：单篇 ${single} KB · 总上限 ${total} KB`, 'success');
    return true;
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
    syncSpecLimitInputs(currentSpecCuration(), false, true);
    return false;
  } finally {
    ui.busy = '';
    rerenderSpecCuration();
  }
}

export function toggleSpecCurationTriggerBar(force) {
  const ui = state.specCurationUi;
  const cur = currentSpecCuration();
  if (cur.running || ui.busy === 'trigger') return;
  if (!isProjectSpecEnabled()) {
    ui.triggerOpen = false;
    showToast(SPEC_CURATION_ERRORS.SPEC_DISABLED_FOR_PROJECT, 'info');
    rerenderSpecCuration();
    return;
  }
  ui.triggerOpen = typeof force === 'boolean' ? force : !ui.triggerOpen;
  if (ui.triggerOpen) state.pendingSettingsFocus = { keys: ['curation:note'] };
  rerenderSpecCuration();
}

/** 单行输入只写状态仓（输入框聚焦期间配置页暂停重绘，失焦后补渲染时以 state 回填 value）。 */
export function updateSpecCurationDraft(field, value) {
  const ui = state.specCurationUi;
  if (field === 'note') ui.note = String(value ?? '').slice(0, 300);
  else if (field === 'feedback') ui.feedback = String(value ?? '').slice(0, 500);
}

function releaseCurationFocus() {
  const ae = document.activeElement;
  if (ae && ae.closest?.('#spec-curation-panel')) ae.blur();
}

/** 启动只读梳理：direct / relay / complex 任一模式均可（服务端豁免派发总闸，走 resolveCuratorTarget）。 */
export async function submitSpecCurationTrigger() {
  const ui = state.specCurationUi;
  const cur = currentSpecCuration();
  if (ui.busy || cur.running) return false;
  if (specCurationUnbound()) {
    showToast('当前未绑定项目目录，无法发起规范维护', 'info');
    return false;
  }
  if (!isProjectSpecEnabled()) {
    showToast(SPEC_CURATION_ERRORS.SPEC_DISABLED_FOR_PROJECT, 'info');
    return false;
  }
  const curator = preferredCuratorMember();
  if (!curator) {
    showToast(SPEC_CURATION_ERRORS.CURATOR_ROSTER_EMPTY, 'error');
    return false;
  }
  releaseCurationFocus();
  ui.busy = 'trigger';
  rerenderSpecCuration();
  try {
    if (!(await ensurePresetsSaved())) return false;
    const note = ui.note.trim();
    const res = await rpcCall('specCuration', { action: 'trigger', ...specCurationParams(), conversationId: getEffectiveConversationId() || undefined, note: note || undefined });
    const hasHostActions = Array.isArray(res?.hostActions) && res.hostActions.length > 0;
    const awaitingHost = res?.status === 'waiting_host_dispatch' || hasHostActions;
    absorbSpecCurationReply(res, {
      running: true,
      awaitingHost,
      activeHandoffId: res?.handoffId || null,
      activeExecutorKind: awaitingHost ? 'antigravity_subagent' : null,
      activeThreadId: res?.threadId || null,
      activeRunId: res?.runId || null,
    });
    ui.note = '';
    ui.watchRun = '';
    ui.triggerOpen = false;
    if (hasHostActions) {
      await relayCurationHostActions(res, 'trigger');
    } else {
      showToast(`已启动只读梳理（${curator.label || curator.key}），完成后提案会出现在本卡片待你确认`, 'success');
    }
    return true;
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
    if (err?.code === 'CURATOR_ALREADY_RUNNING') void refreshSpecCurationStatus({ silent: true });
    return false;
  } finally {
    ui.busy = '';
    rerenderSpecCuration();
  }
}

function actionableProposalById(proposalId) {
  const p = actionableSpecProposal(currentSpecCuration());
  return p && p.id === proposalId ? p : null;
}

/** 整组确认落盘（预检未通过或冲突时禁用）：服务端 CAS 基线校验后原子写入并刷新 INDEX.md / 00-plugin 镜像。 */
export async function confirmSpecProposal(proposalId) {
  const ui = state.specCurationUi;
  const proposal = actionableProposalById(proposalId);
  if (!proposal || ui.busy) return false;
  if (proposal.status !== 'pending' || !proposal.preflightOk) {
    showToast(proposal.status === 'conflict' ? SPEC_CURATION_ERRORS.SPEC_PROPOSAL_CONFLICT : '提案预检未通过，不能确认落盘：请打回修改或放弃', 'error');
    return false;
  }
  ui.busy = 'confirm';
  rerenderSpecCuration();
  try {
    const res = await rpcCall('specCuration', { action: 'confirm', proposalId, ...specCurationParams() });
    absorbSpecCurationReply(res, { pendingProposal: null, recentProposals: [] });
    showToast(`已确认更新 ${proposal.changes.length} 处项目规范，INDEX.md 已同步刷新`, 'success');
    const ps = state.projectSpecs;
    ps.bodies = {};
    await refreshProjectSpecs({ silent: true });
    return true;
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
    if (err?.code === 'SPEC_PROPOSAL_CONFLICT') void refreshSpecCurationStatus({ silent: true });
    return false;
  } finally {
    ui.busy = '';
    rerenderSpecCuration();
  }
}

export function toggleSpecProposalRevise(force) {
  const ui = state.specCurationUi;
  if (ui.busy) return;
  ui.reviseOpen = typeof force === 'boolean' ? force : !ui.reviseOpen;
  if (ui.reviseOpen) state.pendingSettingsFocus = { keys: ['curation:feedback'] };
  else {
    ui.feedback = '';
    releaseCurationFocus();
  }
  rerenderSpecCuration();
}

/** 带修改意见打回：旧卡标 superseded，服务端续聊原维护官重拟（新提案到达前显示梳理中）。 */
export async function submitSpecProposalRevise(proposalId) {
  const ui = state.specCurationUi;
  const proposal = actionableProposalById(proposalId);
  if (!proposal || ui.busy) return false;
  const feedback = ui.feedback.trim();
  if (!feedback) {
    showToast(SPEC_CURATION_ERRORS.CURATOR_FEEDBACK_REQUIRED, 'error');
    state.pendingSettingsFocus = { keys: ['curation:feedback'] };
    rerenderSpecCuration();
    return false;
  }
  releaseCurationFocus();
  ui.busy = 'revise';
  rerenderSpecCuration();
  try {
    const res = await rpcCall('specCuration', { action: 'revise', proposalId, feedback, ...specCurationParams() });
    const hasHostActions = Array.isArray(res?.hostActions) && res.hostActions.length > 0;
    const awaitingHost = res?.status === 'waiting_host_dispatch' || hasHostActions;
    absorbSpecCurationReply(res, {
      pendingProposal: null,
      recentProposals: [],
      running: true,
      awaitingHost,
      activeHandoffId: res?.handoffId || null,
      activeExecutorKind: awaitingHost ? (res?.activeExecutorKind || 'antigravity_subagent') : null,
      activeThreadId: res?.threadId || (awaitingHost ? null : proposal.threadId || null),
      activeRunId: res?.runId || null,
    });
    ui.feedback = '';
    ui.watchRun = '';
    ui.reviseOpen = false;
    if (hasHostActions) {
      await relayCurationHostActions(res, 'revise');
    } else {
      showToast('已打回修改意见，原维护官正在按意见重拟提案', 'success');
    }
    return true;
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
    return false;
  } finally {
    ui.busy = '';
    rerenderSpecCuration();
  }
}

/** 整组放弃（二次确认）：零 Token 结单，不调用模型。 */
export async function dismissSpecProposal(proposalId) {
  const ui = state.specCurationUi;
  const proposal = actionableProposalById(proposalId);
  if (!proposal || ui.busy) return false;
  if (!armOrConfirm(`spec-proposal-dismiss:${proposalId}`, '再次点击「确认放弃」整组丢弃本提案（不写入任何规范文件）')) {
    renderSpecCurationSection();
    return false;
  }
  ui.busy = 'dismiss';
  rerenderSpecCuration();
  try {
    const res = await rpcCall('specCuration', { action: 'dismiss', proposalId, ...specCurationParams() });
    absorbSpecCurationReply(res, { pendingProposal: null, recentProposals: [] });
    showToast('已放弃本次规范维护提案（未写入任何文件）', 'success');
    return true;
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
    return false;
  } finally {
    ui.busy = '';
    rerenderSpecCuration();
  }
}

/** 取消未认领的宿主原生维护票据（或未提交的主会话维护锁），释放等待态。 */
export async function cancelSpecCurationTicket() {
  const ui = state.specCurationUi;
  const cur = currentSpecCuration();
  if (ui.busy || !(cur.awaitingHost || cur.running && cur.activeExecutorKind === 'host_main')) return false;
  if (specCurationUnbound()) {
    showToast('当前未绑定项目目录，无法取消维护等待', 'info');
    return false;
  }
  ui.busy = 'cancel-ticket';
  rerenderSpecCuration();
  try {
    const res = await rpcCall('specCuration', { action: 'cancelTicket', ...specCurationParams(), runId: cur.activeRunId || undefined });
    if (res?.cancelled === false) {
      absorbSpecCurationReply(res);
      showToast('维护状态已变化，请查看当前进度', 'info');
      return false;
    }
    absorbSpecCurationReply(res, {
      running: false,
      awaitingHost: false,
      activeHandoffId: null,
      activeExecutorKind: null,
      activeRunId: null,
    });
    showToast('已取消宿主规范维护等待', 'success');
    return true;
  } catch (err) {
    showToast(describeSpecCurationError(err), 'error');
    return false;
  } finally {
    ui.busy = '';
    rerenderSpecCuration();
  }
}

export function setSpecCurationDetailOpen(key, open) {
  const set = state.specCurationUi.openDetails;
  if (!key) return;
  if (open) set.add(key);
  else set.delete(key);
}

/** 待办提醒「前往确认」：切到配置页「项目规范与缓存」并把规范维护提案区滚入视野（等 setActiveView 的置顶复位之后）。 */
export function revealSpecCurationPanel() {
  const scrollIn = () => document.getElementById('spec-curation-panel')?.closest('section')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  requestAnimationFrame(() => requestAnimationFrame(scrollIn));
}

/**
 * 自愈兜底（零定时轮询）：维护官线程已完结而快照仍显示梳理中（例如 spec_curation_updated 事件丢失）时，
 * 按 activeRunId / threadId 各补拉一次 status。
 */
function selfHealSpecCurationRunning(cur) {
  const ui = state.specCurationUi;
  if (!cur.running || !cur.activeThreadId || ui.statusLoading) return;
  const t = state.threadsMap.get(cur.activeThreadId);
  if (!t || isStatusActive(t.status)) return;
  const mark = `${cur.activeThreadId}:${cur.activeRunId || ''}:${Number(t.updatedAt) || 0}`;
  if (ui.watchRun === mark) return;
  ui.watchRun = mark;
  void refreshSpecCurationStatus({ silent: true });
}

function curationTextBlock(label, text) {
  const v = String(text || '').trim();
  return `<dt>${escapeHtml(label)}</dt><dd>${v ? escapeHtml(v) : '<span class="ps-muted">（未说明）</span>'}</dd>`;
}

function curationDetailsHtml(key, summary, body) {
  const open = state.specCurationUi.openDetails.has(key);
  return `<details class="ps-curation-details" data-curation-details="${escapeHtml(key)}"${open ? ' open' : ''}><summary>${escapeHtml(summary)}</summary><pre class="ps-curation-pre">${escapeHtml(body)}</pre></details>`;
}

function renderCurationChangeHtml(c, i) {
  const op = SPEC_CURATION_CHANGE_LABELS[c.action] || c.action;
  const bytes = c.bodyBytes == null ? '' : `<span class="spec-meta-faint">正文 ${escapeHtml(formatSpecBytes(c.bodyBytes))}</span>`;
  const issues = c.preflightIssues.length
    ? `<ul class="spec-warn-list ps-curation-issues" role="alert">${c.preflightIssues.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`
    : '';
  const diff = c.diffPreview ? curationDetailsHtml(`diff:${i}`, '查看 Diff', c.diffPreview) : '';
  const content = c.action !== 'delete' && c.content ? curationDetailsHtml(`content:${i}`, '查看完整新内容', c.content) : '';
  return `<li class="ps-curation-change" data-curation-change="${escapeHtml(c.action)}">
      <div class="ps-curation-change-head">
        <span class="ps-curation-op is-${escapeHtml(c.action)}">${escapeHtml(op)}</span>
        <code class="ps-curation-path" title="${escapeHtml(c.path)}">${escapeHtml(c.path || '（缺少路径）')}</code>
        ${bytes}
        ${c.preflightOk ? '' : '<span class="spec-tier-tag is-danger">预检未通过</span>'}
      </div>
      ${c.title ? `<p class="ps-curation-change-title">${escapeHtml(c.title)}</p>` : ''}
      <dl class="ps-curation-kv">
        ${curationTextBlock('为什么改', c.why)}
        ${curationTextBlock('具体改了什么', c.changeSummary)}
        ${curationTextBlock('合并 / 删减的旧话', c.mergedOrRemoved)}
        ${curationTextBlock('影响模块与守护测试', c.impactAndTests)}
      </dl>
      ${issues}${diff}${content}
    </li>`;
}

function renderSpecProposalCardHtml(p) {
  const ui = state.specCurationUi;
  const id = escapeHtml(p.id);
  const busy = Boolean(ui.busy);
  const isConflict = p.status === 'conflict';
  const specOn = isProjectSpecEnabled();
  const canConfirm = specOn && p.status === 'pending' && p.preflightOk;
  const issues = [
    ...(isConflict ? ['目标规范文件自提案生成后已被外部修改，请打回重拟或放弃'] : []),
    ...(p.parseError ? [`解析失败：${p.parseError}`] : []),
    ...p.preflightIssues,
  ];
  if (!p.changes.length && !p.parseError) issues.push('提案未包含任何规范变更');
  const badgeState = isConflict ? 'conflict' : p.preflightOk ? 'ok' : 'bad';
  const badgeText = isConflict ? '基线冲突' : p.preflightOk ? '预检通过' : '预检未通过';
  const confirmTitle = canConfirm
    ? '整组原子写入并刷新 INDEX.md（写入前校验文件未被外部改动）'
    : !specOn ? '本项目未开启项目规范，不能确认落盘（可放弃本提案）' : isConflict ? '文件已被外部修改，不能确认落盘' : '预检未通过，不能确认落盘';
  const armed = (state.pendingConfirms.get(`spec-proposal-dismiss:${p.id}`) || 0) > Date.now();
  const feedbackInputId = `inp-curation-feedback-${id}`;
  const revise = specOn
    ? `<div class="ps-curation-inline" data-curation-revise-bar>
        <label class="pool-field-lbl" for="${feedbackInputId}">修改建议</label>
        <input type="text" class="text-input ps-curation-input" data-curation-input="feedback" id="${feedbackInputId}" name="curation-feedback" data-fk="curation:feedback" data-at-draft value="${escapeHtml(ui.feedback)}" maxlength="500" autocomplete="off" placeholder="可选：哪里不满意或怎么改（如：删掉第 2 条、措辞再短些）" aria-label="打回修改意见"${busy ? ' disabled' : ''} />
      </div>`
    : '';
  return `<div class="ps-curation-card" data-spec-proposal="${id}" role="region" aria-label="规范维护提案待确认">
      <div class="ps-curation-card-head">
        <span class="ps-curation-title">📝 规范维护提案 · 待你确认</span>
        <span class="ps-curation-badge ${canConfirm ? 'is-ok' : 'is-bad'}" data-curation-preflight="${badgeState}">${badgeText}</span>
        <span class="spec-meta-faint">${p.changes.length} 处变更 · ${escapeHtml(SPEC_CURATION_SOURCES[p.triggerSource] || p.triggerSource)}${p.createdAt ? ` · ${escapeHtml(formatTimeShort(p.createdAt))}` : ''}</span>
      </div>
      ${p.summary ? `<p class="ps-curation-summary">${escapeHtml(p.summary)}</p>` : ''}
      ${issues.length ? `<ul class="spec-warn-list ps-curation-issues" role="alert">${issues.map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>` : ''}
      ${p.changes.length ? `<ol class="ps-curation-changes">${p.changes.map(renderCurationChangeHtml).join('')}</ol>` : ''}
      ${revise}
      <div class="ps-curation-actions">
        <button type="button" class="ghost-xs-btn is-accent" data-curation-confirm="${id}" data-fk="curation:confirm"${canConfirm && !busy ? '' : ' disabled'} title="${escapeHtml(confirmTitle)}">${ui.busy === 'confirm' ? '写入中…' : '确认更新规范'}</button>
        <button type="button" class="ghost-xs-btn" data-curation-revise-submit="${id}" data-fk="curation:revise-submit"${busy || !specOn ? ' disabled' : ''} title="${specOn ? '按上方填写的修改建议打回给维护官重新拟定' : '本项目未开启项目规范，不能打回重拟'}">${ui.busy === 'revise' ? '提交中…' : '按意见打回重拟'}</button>
        <button type="button" class="ghost-xs-btn${armed ? ' is-armed danger-txt' : ''}" data-curation-dismiss="${id}" data-fk="curation:dismiss"${busy ? ' disabled' : ''}>${ui.busy === 'dismiss' ? '放弃中…' : armed ? '确认放弃？' : '放弃'}</button>
      </div>
    </div>`;
}

/** 项目规范卡片顶栏（自动维护开关 + ✨ 维护规范）与顶部提案确认区。 */
export function renderSpecCurationSection() {
  const ui = state.specCurationUi;
  const cur = currentSpecCuration();
  const activeProposal = actionableSpecProposal(cur);
  const unbound = specCurationUnbound();
  const awaitingHost = cur.awaitingHost === true;
  const running = cur.running || awaitingHost || ui.busy === 'trigger';
  const autoBtn = document.getElementById('btn-spec-curation-auto');
  if (autoBtn) {
    autoBtn.setAttribute('aria-checked', String(cur.autoTrigger));
    autoBtn.classList.toggle('is-on', cur.autoTrigger);
    autoBtn.disabled = unbound || ui.busy === 'auto' || !cur.specEnabled;
    autoBtn.setAttribute('aria-busy', String(ui.busy === 'auto'));
    autoBtn.title = unbound ? '当前未绑定项目目录' : cur.autoTrigger ? '本项目自动维护已开启（点击关闭）' : '本项目自动维护已关闭（点击开启）';
  }
  const trigBtn = document.getElementById('btn-spec-curation-trigger');
  if (trigBtn) {
    trigBtn.disabled = unbound || running || !cur.specEnabled;
    trigBtn.setAttribute('aria-busy', String(running));
    trigBtn.setAttribute('aria-expanded', String(ui.triggerOpen && !running));
    const label = awaitingHost ? '等待宿主…' : running ? '梳理中…' : '✨ 维护规范';
    if (trigBtn.textContent !== label) trigBtn.textContent = label;
  }
  syncSpecLimitInputs(cur, unbound, false);
  const panel = document.getElementById('spec-curation-panel');
  if (!panel) return;
  selfHealSpecCurationRunning(cur);
  const parts = [];
  const specOn = isProjectSpecEnabled();
  if (ui.triggerOpen && !running && !unbound && specOn) {
    parts.push(`<div class="ps-curation-inline" data-curation-trigger-bar>
        <input type="text" class="text-input ps-curation-input" data-curation-input="note" name="curation-note" data-fk="curation:note" data-at-draft value="${escapeHtml(ui.note)}" maxlength="300" autocomplete="off" placeholder="可选：补充本次想沉淀或删改的规范方向" aria-label="规范维护补充说明（可选）" />
        <button type="button" class="ghost-xs-btn is-accent" data-curation-trigger-submit data-fk="curation:trigger-submit"${ui.busy ? ' disabled' : ''}>启动只读梳理</button>
        <button type="button" class="ghost-xs-btn" data-curation-trigger-cancel data-fk="curation:trigger-cancel">取消</button>
      </div>`);
  }
  if (specOn && (awaitingHost || cur.running && cur.activeExecutorKind === 'host_main')) {
    parts.push(`<div class="ps-curation-status ps-curation-status--row" role="status" ${awaitingHost ? 'data-curation-awaiting-host' : 'data-curation-running'}>
        <span>${awaitingHost ? '⏳ 等待宿主执行维护票据…' : '主会话正在梳理规范，等待提交提案…'}</span>
        <button type="button" class="ghost-xs-btn" data-curation-cancel-ticket data-fk="curation:cancel-ticket"${ui.busy === 'cancel-ticket' ? ' disabled' : ''}>${ui.busy === 'cancel-ticket' ? '取消中…' : awaitingHost ? '取消等待' : '取消梳理'}</button>
      </div>`);
  } else if (running && specOn) {
    parts.push('<p class="ps-curation-status" role="status" data-curation-running>⏳ 规范维护官只读梳理中…完成后提案会出现在这里，确认前不会改动任何规范文件</p>');
  } else if (!activeProposal && cur.lastNoChange && specOn) {
    parts.push(`<p class="ps-curation-status is-muted" role="status" data-curation-nochange>上次梳理结论：无需改动${cur.lastNoChange.reason ? ` · ${escapeHtml(cur.lastNoChange.reason)}` : ''}</p>`);
  }
  if (activeProposal) parts.push(renderSpecProposalCardHtml(activeProposal));
  const html = parts.join('');
  setHtmlKeepingFocus(panel, html);
  panel.hidden = !html;
}

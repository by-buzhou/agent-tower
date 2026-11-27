/**
 * AgentTower Studio — 联动下拉选项构建与 Composer 下拉同步 (`ui/options.js`)
 * 引擎 / 模型 / 思考档位 / 权限档位选项、角色预设自绘下拉触发器与跨引擎权限重映射。
 */
import { HOST_DEFAULT_PERMISSION, deriveInteractionMode, isDangerPermissionFor, normalizePermissionForProvider, permissionLadderOf } from './permissions.js';
import { escapeHtml, shortenModelName } from './format.js';
import { CUSTOM_MODEL_PROMPT_VALUE, EFFORT_LABELS, FALLBACK_PROVIDERS, INHERIT_EFFORT, PRESET_FIELD_LABELS, ROUTER_DEFAULT_MODEL, state } from './state.js';
import { isAllowedAgySubagentModel, normalizeProviderId } from './normalize.js';
import { engClass, engineShortName, roleTitle, stripLeadingIcon } from './widgets.js';

/* ========================================================================
 * 11. 底部紧凑配置胶囊 Composer 渲染 & 联动脉冲选择器
 * ======================================================================== */
export function syncComposerSelects() {
  const provEl = document.getElementById('comp-provider');
  const modEl = document.getElementById('comp-model');
  const effEl = document.getElementById('comp-effort');
  const permEl = document.getElementById('comp-perm-mode');
  const isoEl = document.getElementById('comp-isolation');

  populateLinkedSelectTrio(provEl, modEl, effEl, state.composer);
  // 原生权限档位随引擎动态渲染；旧版通用值（approval-required / full-access…）按同引擎语义显示为原生等价档
  state.composer.permissionMode = normalizePermissionForProvider(state.composer.provider, state.composer.permissionMode);
  state.composer.interactionMode = deriveInteractionMode(state.composer.permissionMode);
  if (permEl) {
    const hostTarget = isComposerNativeHostTarget();
    permEl.innerHTML = buildPermissionOptionsHtml(state.composer.provider, state.composer.permissionMode, { isNativeHost: hostTarget });
    permEl.disabled = hostTarget;
    permEl.classList.toggle('is-danger', !hostTarget && isDangerPermissionFor(state.composer.provider, state.composer.permissionMode));
  }
  if (isoEl) isoEl.value = state.composer.isolation || 'shared';
}

// 底栏目标为宿主原生桥接线程：权限由宿主主窗口管理，仅展示禁用的 host-default
export function isComposerNativeHostTarget() {
  const t = state.selectedThreadId ? state.threadsMap.get(state.selectedThreadId) : null;
  return Boolean(t?.isNativeHost) && normalizeProviderId(state.composer.provider) === 'antigravity';
}

/** 权限下拉选项：优先使用目录下发的原生档位，宿主原生线程只给禁用的 host-default。 */
function permissionOptionsFor(providerId, { isNativeHost = false } = {}) {
  const pid = normalizeProviderId(providerId);
  const p = state.providers.find((x) => x.id === pid);
  if (isNativeHost && pid === 'antigravity') {
    const host = Array.isArray(p?.hostPermissionModes) && p.hostPermissionModes[0] ? p.hostPermissionModes[0] : HOST_DEFAULT_PERMISSION;
    return [{ value: host.value || HOST_DEFAULT_PERMISSION.value, label: host.label || HOST_DEFAULT_PERMISSION.label, danger: false, disabled: true }];
  }
  const ladder = Array.isArray(p?.permissionModes) && p.permissionModes.length ? p.permissionModes : permissionLadderOf(pid);
  return ladder.map((m) => ({
    value: m.value,
    label: m.danger ? `${m.label} · 高危` : m.label,
    danger: Boolean(m.danger),
    disabled: false,
  }));
}
export function buildPermissionOptionsHtml(providerId, selected, opts = {}) {
  const options = permissionOptionsFor(providerId, opts);
  const value = opts.isNativeHost && normalizeProviderId(providerId) === 'antigravity' ? options[0].value : selected;
  return optionsHtml(options, value);
}
/** 切换引擎：按跨引擎安全映射保留语义相近档位，绝不自动提权到高危档。 */
export function remapPermissionOnProviderChange(target, previousProvider) {
  if (!target) return;
  const crossEngine = normalizeProviderId(previousProvider) !== normalizeProviderId(target.provider);
  target.permissionMode = normalizePermissionForProvider(target.provider, target.permissionMode, { crossEngine });
  target.interactionMode = deriveInteractionMode(target.permissionMode);
  if (Object.hasOwn(target, 'runtimeMode')) target.runtimeMode = target.permissionMode;
}

/* ========================================================================
 * 12. 联动脉冲选择器 & 派发抽屉 / 重试弹窗
 * ======================================================================== */
function providerOptions() {
  return state.providers.map(p => ({ value: p.id,
    label: p.name }));
}
function modelOptions(providerId, selectedModel) {
  const p = state.providers.find(p => p.id === normalizeProviderId(providerId));
  if (!p) return [];
  const options = [];
  if (p.id !== 'antigravity') options.push({ value: ROUTER_DEFAULT_MODEL, label: '🔗 跟随客户端默认' +
    (p.configDefaultModel ? ` (当前: ${shortenModelName(p.configDefaultModel)})` : ' (CC Switch / config.toml)') });
  if (selectedModel && (p.id !== 'antigravity' || isAllowedAgySubagentModel(selectedModel)) &&
      ![ROUTER_DEFAULT_MODEL, CUSTOM_MODEL_PROMPT_VALUE].includes(selectedModel) && !p.models.some(m => m.id === selectedModel)) {
    options.push({ value: selectedModel, label: `📌 自定义: ${selectedModel}` });
  }
  options.push(...p.models.map(m => ({ value: m.id, label: m.name, group: m.group })),
    { value: CUSTOM_MODEL_PROMPT_VALUE, label: '✏️ 手动输入自定义模型 ID...' });
  return options;
}
function optionsHtml(options, selected) {
  let group;
  let html = '';
  for (const o of options) {
    if (o.group !== group) {
      if (group) html += '</optgroup>';
      group = o.group;
      if (group) html += `<optgroup label="${escapeHtml(group)}">`;
    }
    html += `<option value="${escapeHtml(o.value)}" ${o.value === selected ? 'selected' : ''} ${o.disabled ? 'disabled' : ''}>${escapeHtml(o.label)}</option>`;
  }
  return html + (group ? '</optgroup>' : '');
}
export function buildProviderOptionsHtml(id) { return optionsHtml(providerOptions(), normalizeProviderId(id)); }
export function buildModelOptionsHtml(id, model) { return optionsHtml(modelOptions(id, model), model); }

function getAvailableEffortsForSelection(prov, modelId) {
  if (!prov) return ['low', 'medium', 'high'];
  if (modelId === ROUTER_DEFAULT_MODEL) {
    const defMod = prov.configDefaultModel ? prov.models.find((m) => m.id === prov.configDefaultModel) : null;
    return defMod?.efforts?.length ? defMod.efforts : ['low', 'medium', 'high', 'xhigh', 'max'];
  }
  const mod = prov.models.find((m) => m.id === modelId);
  if (Array.isArray(mod?.efforts)) return mod.efforts.length ? mod.efforts : [INHERIT_EFFORT];
  if (prov.id === 'codex' || prov.id === 'kimi-code') return ['low', 'medium', 'high', 'xhigh', 'max'];
  return prov.models[0]?.efforts?.length ? prov.models[0].efforts : ['low', 'medium', 'high'];
}

function effortOptions(id, model) {
  const p = state.providers.find(p => p.id === normalizeProviderId(id));
  const options = getAvailableEffortsForSelection(p, model).map(e => ({ value: e, label: EFFORT_LABELS[e] || e }));
  if (p && p.id !== 'antigravity' && !options.some(o => o.value === INHERIT_EFFORT)) options.unshift({ value: INHERIT_EFFORT, label: '🔗 跟随默认' + (p.configDefaultEffort ? ` (当前: ${p.configDefaultEffort})` : '') });
  return options;
}
export function buildEffortOptionsHtml(id, model, effort) { return optionsHtml(effortOptions(id, model), effort); }
export function presetOptions(cfg, field) {
  if (field === 'provider') return providerOptions();
  if (field === 'model') return modelOptions(cfg.provider, cfg.model);
  if (field === 'effort') return effortOptions(cfg.provider, cfg.model);
  if (field === 'permissionMode') return permissionOptionsFor(cfg.provider);
  return [{ value: 'shared', label: '共享项目目录（默认，常驻会话可续聊）' }, { value: 'worktree', label: '独立 Git Worktree 沙盒' }];
}
// 角色行触发器：保留自绘下拉契约（.at-select-trigger + role=combobox + data-ps-key/field + value），
// 引擎变体为带专属色点的胶囊，强度只显示档位值，完整文案放在 title。
export function presetTrigger(slot, cfg, field, { scope = 'project' } = {}) {
  const fieldLabel = PRESET_FIELD_LABELS[field] || field;
  const full = stripLeadingIcon(presetOptions(cfg, field).find(o => o.value === cfg[field])?.label || cfg[field] || '');
  let variant = field, text = full, extraCls = '', lead = '';
  if (field === 'provider') {
    variant = 'engine';
    text = engineShortName(cfg.provider);
    extraCls = ` eng-chip ${engClass(cfg.provider)}`;
    lead = '<span class="eng-dot" aria-hidden="true"></span>';
  } else if (field === 'effort') {
    text = cfg.effort === INHERIT_EFFORT ? '默认' : String(cfg.effort || '');
  } else if (field === 'permissionMode') {
    // 胶囊只显示中文档位名（去掉「(原生值)」与高危后缀），完整文案在 title；高危档加 is-danger 色标
    variant = 'perm';
    text = full.replace(/\s*·\s*高危$/, '').replace(/\s*\([^)]*\)\s*$/, '') || String(cfg.permissionMode || '');
    if (isDangerPermissionFor(cfg.provider, cfg.permissionMode)) extraCls = ' is-danger';
  }
  const key = escapeHtml(slot.key);
  const label = scope === 'global' ? (cfg.label || slot.key) : roleTitle(slot.key);
  const scopeAttr = scope === 'global' ? ' data-ps-scope="global"' : '';
  const fkPrefix = scope === 'global' ? 'global:' : '';
  return `<button type="button" class="at-select-trigger ps-trg ps-trg--${variant}${extraCls}" role="combobox" aria-haspopup="listbox" aria-expanded="false"
        aria-label="${escapeHtml(`${label} · ${fieldLabel}`)}" title="${escapeHtml(`${fieldLabel}：${full}`)}"
        data-ps-key="${key}" data-ps-field="${field}"${scopeAttr} data-fk="${fkPrefix}ps:${key}:${field}" value="${escapeHtml(cfg[field] ?? '')}">${lead}<span class="trg-v">${escapeHtml(text)}</span></button>`;
}

function isBuiltinModelOfOtherProvider(currentProviderId, modelId) {
  if (!modelId) return false;
  const normPid = normalizeProviderId(currentProviderId);
  for (const p of state.providers) {
    if (p.id !== normPid && p.models.some((m) => m.id === modelId)) return true;
  }
  for (const fb of FALLBACK_PROVIDERS) {
    if (fb.id !== normPid && fb.models.some((m) => m.id === modelId)) return true;
  }
  return false;
}

export function reconcileModelSelection(targetObj) {
  if (!targetObj) return null;
  let prov = state.providers.find((p) => p.id === normalizeProviderId(targetObj.provider));
  if (!prov) prov = state.providers[0];
  if (!prov) return null;
  targetObj.provider = prov.id;

  const isExternal = prov.id !== 'antigravity';
  const rawModel = String(targetObj.model || '').trim();
  const matchedMod = prov.models.find((m) => m.id === rawModel);

  if (rawModel === ROUTER_DEFAULT_MODEL && isExternal) {
    targetObj.model = ROUTER_DEFAULT_MODEL;
  } else if (matchedMod) {
    targetObj.model = matchedMod.id;
  } else if (
    rawModel &&
    rawModel !== ROUTER_DEFAULT_MODEL &&
    rawModel !== CUSTOM_MODEL_PROMPT_VALUE &&
    (prov.id !== 'antigravity' || isAllowedAgySubagentModel(rawModel)) &&
    !isBuiltinModelOfOtherProvider(prov.id, rawModel)
  ) {
    targetObj.model = rawModel;
  } else {
    const fallbackMod =
      prov.models.find((m) => m.isDefault) || prov.models[0];
    if (fallbackMod) targetObj.model = fallbackMod.id;
  }

  const effs = getAvailableEffortsForSelection(prov, targetObj.model);
  const resolvedMod = prov.models.find((m) => m.id === targetObj.model);
  if (isExternal && targetObj.effort === INHERIT_EFFORT) {
    targetObj.effort = INHERIT_EFFORT;
  } else if (!effs.includes(targetObj.effort)) {
    if (isExternal && targetObj.model === ROUTER_DEFAULT_MODEL) {
      targetObj.effort = INHERIT_EFFORT;
    } else {
      targetObj.effort = resolvedMod?.defaultEffort || effs[Math.min(1, effs.length - 1)] || 'high';
    }
  }
  return prov;
}

export function populateLinkedSelectTrio(provEl, modEl, effEl, targetObj) {
  if (!provEl || !modEl || !effEl) return;
  if (!reconcileModelSelection(targetObj)) return;

  provEl.innerHTML = buildProviderOptionsHtml(targetObj.provider);
  modEl.innerHTML = buildModelOptionsHtml(targetObj.provider, targetObj.model);
  effEl.innerHTML = buildEffortOptionsHtml(targetObj.provider, targetObj.model, targetObj.effort);
}

/**
 * AgentTower Studio — 数据归一化、扩展平台合并与模型目录辅助 (`ui/normalize.js`)
 * 把守护进程快照 / 实时事件中的线程、发言、协作边、待批请求、Worktree 与目录统一归一化为前端结构。
 */
import { HOST_DEFAULT_PERMISSION, normalizePermissionForProvider, permissionLadderOf, permissionTierOf } from './permissions.js';
import { basenameOfPath, isWorktreeOrTempPath, normalizeProjectPath } from './format.js';
import { BUILTIN_EXTENSION_TEMPLATES_UI, FALLBACK_PROVIDERS, currentProjectKey, isPresetInActivePool, isStatusActive, normalizeProjectConfig, normalizeStatus, state } from './state.js';

/* ========================================================================
 * 4. 数据归一化、扩展平台合并与模型目录辅助函数
 * ======================================================================== */
const SYSTEM_UPDATE_STATES = new Set([
  'idle',
  'checking',
  'up_to_date',
  'available',
  'unavailable',
  'downloading',
  'verifying',
  'quiescing',
  'applying',
  'rolling_back',
]);
const SYSTEM_UPDATE_TRANSITION_STATES = new Set([
  'downloading',
  'verifying',
  'quiescing',
  'applying',
  'rolling_back',
]);
const INSTALL_ORIGINS = new Set(['dev', 'git-clone', 'zip', 'unknown']);

export function isSystemUpdateTransitionState(status) {
  return SYSTEM_UPDATE_TRANSITION_STATES.has(String(status || ''));
}

export function normalizeSystemUpdate(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  let releaseUrl = '';
  try {
    const url = new URL(String(value.releaseUrl || ''));
    if (url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password) releaseUrl = url.href;
  } catch { /* Remote release links are optional and must remain safe. */ }
  const checkedAt = Number(value.lastCheckedAt);
  const rawProgress = value.progress && typeof value.progress === 'object' ? value.progress : {};
  const rawPercent = rawProgress.percent;
  const percent = typeof rawPercent === 'number' && Number.isFinite(rawPercent)
    ? Math.max(0, Math.min(100, rawPercent))
    : null;
  const downloadedBytes = Number(rawProgress.downloadedBytes);
  const totalBytes = Number(rawProgress.totalBytes);
  const rawRollback = value.rollback && typeof value.rollback === 'object' ? value.rollback : {};
  const rawLastResult = value.lastResult && typeof value.lastResult === 'object' ? value.lastResult : {};
  const lastResultAt = Number(rawLastResult.at);
  return {
    state: SYSTEM_UPDATE_STATES.has(value.state) ? value.state : 'idle',
    currentVersion: String(value.currentVersion || ''),
    latestVersion: String(value.latestVersion || ''),
    hasUpdate: value.hasUpdate === true,
    dismissedVersion: String(value.dismissedVersion || ''),
    releaseUrl,
    releaseNotes: String(value.releaseNotes || ''),
    assetSha256: String(value.assetSha256 || ''),
    installOrigin: INSTALL_ORIGINS.has(value.installOrigin) ? value.installOrigin : 'unknown',
    autoUpdateSupported: value.autoUpdateSupported === true,
    cancellable: value.cancellable === true,
    lastCheckedAt: Number.isFinite(checkedAt) && checkedAt > 0 ? checkedAt : 0,
    error: String(value.error || ''),
    progress: {
      phase: String(rawProgress.phase || ''),
      percent,
      downloadedBytes: Number.isFinite(downloadedBytes) && downloadedBytes > 0 ? downloadedBytes : 0,
      totalBytes: Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0,
      message: String(rawProgress.message || ''),
    },
    rollback: {
      available: rawRollback.available === true,
      version: String(rawRollback.version || ''),
      backedUpAt: String(rawRollback.backedUpAt || ''),
      rollbackSafe: rawRollback.rollbackSafe !== false,
    },
    lastResult: {
      status: String(rawLastResult.status || ''),
      fromVersion: String(rawLastResult.fromVersion || ''),
      toVersion: String(rawLastResult.toVersion || ''),
      at: Number.isFinite(lastResultAt) && lastResultAt > 0 ? lastResultAt : 0,
      message: String(rawLastResult.message || ''),
    },
  };
}

export function applySessionAndUpdatePayload(payload) {
  if (!payload || typeof payload !== 'object') return false;
  let changed = false;
  const data = payload.payload && typeof payload.payload === 'object' ? { ...payload, ...payload.payload } : payload;
  const settings = data.settings && typeof data.settings === 'object' ? data.settings : {};
  for (const field of ['defaultExternalSessionVisible', 'autoCheckUpdates']) {
    const value = settings[field] ?? data[field];
    if (typeof value === 'boolean' && state[field] !== value) {
      state[field] = value;
      if (field === 'defaultExternalSessionVisible' && state.projectConfig?.externalSessionMode === 'inherit') {
        state.projectConfig = { ...state.projectConfig, externalSessionVisible: value };
      }
      changed = true;
    }
  }
  const type = String(data.type || data.event || '');
  const rawUpdate = data.systemUpdate || (type === 'system_update_changed' ? data : null);
  if (rawUpdate && typeof rawUpdate === 'object') {
    const update = normalizeSystemUpdate(rawUpdate);
    if (state.systemUpdate?.latestVersion !== update.latestVersion) state.pendingConfirms.delete('system-update-apply');
    if (state.systemUpdate?.rollback?.version !== update.rollback.version) state.pendingConfirms.delete('system-update-rollback');
    state.systemUpdate = update;
    changed = true;
  }
  if (data.projectConfig && typeof data.projectConfig === 'object') {
    const cfg = normalizeProjectConfig(data.projectConfig);
    const currentKey = currentProjectKey();
    const eventKey = String(data.projectKey || cfg?.projectKey || '');
    const foreign = state.conversationUnbound || !eventKey || eventKey !== currentKey;
    const stale = cfg && state.projectConfig?.projectKey === cfg.projectKey && cfg.rosterRevision < state.projectConfig.rosterRevision;
    if (cfg && !foreign && !stale) {
      state.projectConfig = cfg;
      changed = true;
    }
  }
  return changed;
}

export function normalizeProviderId(rawId) {
  const s = String(rawId || '').trim();
  if (!s) return 'kimi-code';
  const low = s.toLowerCase();
  if (low === 'kimi' || low === 'kimi-cli' || low === 'kimi_code') return 'kimi-code';
  if (['claude-agent', 'claude_agent', 'claude', 'claude-code', 'claude_code', 'claudeagent', 'anthropic'].includes(low)) return 'claude-code';
  if (low === 'agy' || low === 'host' || low === 'antigravity-host') return 'antigravity';
  if (low === 'dsh' || low === 'deepseek-harness') return 'dsh';
  if (low === 'zcode' || low === 'z-code' || low === 'zai-zcode') return 'zcode';
  return s;
}

export function isAllowedAgySubagentModel(model) {
  return /^(?:gemini-[a-z0-9][a-z0-9.-]{0,146}|Orchestrator \([a-z0-9][a-z0-9-]*\)|pro|flash|flash_lite)$/i.test(String(model || '').trim());
}

/**
 * 成员键 → 派发路由：参数与成员共享配置一致时按 presetKey 派发，否则按自定义引擎 / 模型派发。
 * options.activePoolOnly：新建派发（底栏新会话 / 派发抽屉 / 批量行）严锁当前对话模式的阵容勾选池，
 * 未勾选成员一律不以 presetKey 派发（v0.1.1 起不再附加停用成员放行标记）。
 */
export function presetDispatchRoute(key, selection, options = {}) {
  if (!key) return { provider: selection.provider, model: selection.model };
  if (options.activePoolOnly && !isPresetInActivePool(key)) return { provider: selection.provider, model: selection.model };
  // 不再以离线种子兜底：已删除的成员键绝不按 presetKey 派发（全成员平权，远端成员表为准）
  const bound = state.presets[key] || state.committedPresets.get(key);
  if (!bound) return { provider: selection.provider, model: selection.model };
  const sameProvider = normalizeProviderId(bound.provider) === normalizeProviderId(selection.provider);
  const sameModel = String(bound.model || '') === String(selection.model || '');
  const sameEffort = selection.effort == null || String(bound.effort || '') === String(selection.effort || '');
  const boundPerm = normalizePermissionForProvider(bound.provider, bound.permissionMode || bound.runtimeMode);
  const selPerm = selection.permissionMode != null
    ? normalizePermissionForProvider(selection.provider, selection.permissionMode)
    : boundPerm;
  const samePerm = options.ignorePermission ? true : boundPerm === selPerm;
  return sameProvider && sameModel && sameEffort && samePerm
    ? { presetKey: key }
    : { provider: selection.provider, model: selection.model };
}

function normalizeExtProtocol(rawProtocol, driverKind, fallback = 'acp') {
  const p = String(rawProtocol || '').trim().toLowerCase();
  if (p === 'zcode' || p === 'cli' || p === 'acp') return p;
  if (driverKind === 'zcode') return 'zcode';
  if (driverKind === 'generic-cli') return 'cli';
  return fallback === 'zcode' || fallback === 'cli' ? fallback : 'acp';
}

function normalizeExtEnvPolicy(rawPolicy, fallback = 'inherit') {
  const p = String(rawPolicy || '').trim().toLowerCase();
  if (p === 'minimal' || p === 'inherit') return p;
  return fallback === 'minimal' ? 'minimal' : 'inherit';
}

export function normalizeModelTokenLimit(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

export function normalizeExtensionList(rawTemplates, rawCustom) {
  const tplMap = new Map();
  for (const b of BUILTIN_EXTENSION_TEMPLATES_UI) {
    tplMap.set(b.id, {
      ...b,
      driverKind: b.driverKind || (b.protocol === 'zcode' ? 'zcode' : b.protocol === 'cli' ? 'generic-cli' : 'generic-acp'),
      envPolicy: normalizeExtEnvPolicy(b.envPolicy, 'inherit'),
      ephemeralSupport: b.ephemeralSupport || 'delete',
      detected: false,
      binaryPath: '',
      enabled: false,
    });
  }

  const incomingTpls = Array.isArray(rawTemplates)
    ? rawTemplates
    : rawTemplates && typeof rawTemplates === 'object'
    ? Object.entries(rawTemplates).map(([id, v]) => ({ id, ...v }))
    : [];

  for (const rt of incomingTpls) {
    const id = String(rt.id || rt.key || '').trim();
    if (!id) continue;
    const prev = tplMap.get(id) || {};
    const protocol = normalizeExtProtocol(rt.protocol, rt.driverKind, prev.protocol || 'acp');
    const driverKind = String(rt.driverKind || prev.driverKind || (protocol === 'zcode' ? 'zcode' : protocol === 'cli' ? 'generic-cli' : 'generic-acp'));
    tplMap.set(id, {
      ...prev,
      ...rt,
      id,
      name: rt.name || rt.displayName || prev.name || id,
      protocol,
      driverKind,
      command: rt.command || prev.command || id,
      args: Array.isArray(rt.args) ? rt.args : prev.args || [],
      argsTemplate: rt.argsTemplate || prev.argsTemplate || '',
      envPolicy: normalizeExtEnvPolicy(rt.envPolicy, prev.envPolicy || 'inherit'),
      credentialEnvKeys: Array.isArray(rt.credentialEnvKeys) ? rt.credentialEnvKeys : prev.credentialEnvKeys || [],
      ephemeralSupport: rt.ephemeralSupport === 'close-only' || rt.ephemeralSupport === 'delete'
        ? rt.ephemeralSupport
        : prev.ephemeralSupport || 'delete',
      description: rt.description || prev.description || '外部编程 Agent 扩展通道',
      detected: Boolean(rt.detected ?? rt.installed ?? rt.available ?? prev.detected),
      binaryPath: String(rt.binaryPath || rt.resolvedCommand || prev.binaryPath || ''),
      defaultModels: Array.isArray(rt.models || rt.defaultModels) ? (rt.models || rt.defaultModels) : prev.defaultModels || [],
      efforts: Array.isArray(rt.efforts) && rt.efforts.length ? rt.efforts : prev.efforts || ['low', 'medium', 'high'],
    });
  }

  const customArr = [];
  const rawCustomList = Array.isArray(rawCustom)
    ? rawCustom
    : rawCustom && typeof rawCustom === 'object'
    ? Object.entries(rawCustom).map(([id, v]) => ({ id, ...v }))
    : [];

  for (const rc of rawCustomList) {
    if (!rc || typeof rc !== 'object') continue;
    const id = String(rc.id || rc.providerId || '').trim();
    if (!id) continue;
    const tplRef = tplMap.get(id);
    const protocol = normalizeExtProtocol(rc.protocol, rc.driverKind, tplRef?.protocol || 'acp');
    const driverKind = String(rc.driverKind || tplRef?.driverKind || (protocol === 'zcode' ? 'zcode' : protocol === 'cli' ? 'generic-cli' : 'generic-acp'));
    const envPolicy = normalizeExtEnvPolicy(rc.envPolicy, tplRef?.envPolicy || 'inherit');
    const ephemeralSupport = rc.ephemeralSupport === 'close-only' || rc.ephemeralSupport === 'delete'
      ? rc.ephemeralSupport
      : tplRef?.ephemeralSupport || 'delete';
    const normModels = (Array.isArray(rc.models) ? rc.models : []).map((m) => {
      if (typeof m === 'string') return { id: m, name: m };
      const mid = String(m.id || m.slug || m.value || 'default');
      const maxOut = normalizeModelTokenLimit(m.maxOutputTokens);
      return {
        id: mid,
        name: m.name || m.displayName || mid,
        ...(m.group ? { group: String(m.group) } : {}),
        ...(m.description ? { description: String(m.description) } : {}),
        contextWindow: normalizeModelTokenLimit(m.contextWindow ?? m.maxContextTokens),
        ...(maxOut ? { maxOutputTokens: maxOut } : {}),
        efforts: Array.isArray(m.efforts) ? m.efforts : rc.efforts || tplRef?.efforts || ['low', 'medium', 'high'],
        ...(m.defaultEffort ? { defaultEffort: String(m.defaultEffort) } : {}),
        ...(m.isDefault !== undefined ? { isDefault: Boolean(m.isDefault) } : {}),
      };
    });
    const entry = {
      id,
      name: rc.name || rc.displayName || tplRef?.name || id,
      protocol,
      driverKind,
      command: rc.command || tplRef?.command || id,
      args: Array.isArray(rc.args) ? rc.args : tplRef?.args || [],
      argsTemplate: rc.argsTemplate || tplRef?.argsTemplate || '',
      envPolicy,
      credentialEnvKeys: Array.isArray(rc.credentialEnvKeys) ? rc.credentialEnvKeys : tplRef?.credentialEnvKeys || [],
      ephemeralSupport,
      enabled: rc.enabled !== false,
      configured: true,
      detected: Boolean(rc.detected ?? tplRef?.detected),
      binaryPath: String(rc.binaryPath || tplRef?.binaryPath || ''),
      ...(rc.defaultModel ? { defaultModel: String(rc.defaultModel) } : {}),
      models: normModels.length > 0 ? normModels : tplRef?.defaultModels || [{ id: 'default', name: '默认模型' }],
      efforts: Array.isArray(rc.efforts) && rc.efforts.length ? rc.efforts : tplRef?.efforts || ['low', 'medium', 'high'],
      envKeys: Array.isArray(rc.envKeys) ? rc.envKeys : rc.env && typeof rc.env === 'object' ? Object.keys(rc.env) : [],
    };
    customArr.push(entry);

    if (tplMap.has(id)) {
      const t = tplMap.get(id);
      t.enabled = entry.enabled;
      t.configured = true;
      t.protocol = entry.protocol;
      t.driverKind = entry.driverKind;
      t.command = entry.command;
      t.args = entry.args;
      t.argsTemplate = entry.argsTemplate;
      t.envPolicy = entry.envPolicy;
      t.ephemeralSupport = entry.ephemeralSupport;
      t.defaultModels = entry.models;
      t.efforts = entry.efforts;
      t.envKeys = entry.envKeys;
    }
  }

  return {
    templates: Array.from(tplMap.values()),
    customProviders: customArr,
  };
}

export function normalizeProvidersCatalog(rawProviders, customProviders = state.customProviders) {
  const incomingList = [];
  if (Array.isArray(rawProviders)) {
    incomingList.push(...rawProviders);
  } else if (rawProviders && typeof rawProviders === 'object') {
    for (const [k, val] of Object.entries(rawProviders)) {
      if (val && typeof val === 'object') {
        incomingList.push({ id: k, ...val });
      }
    }
  }

  const byProvider = new Map();
  if (!rawProviders) {
    for (const fb of FALLBACK_PROVIDERS) {
      byProvider.set(fb.id, {
        id: fb.id,
        name: fb.name,
        available: fb.available !== false,
        isNativeHost: Boolean(fb.isNativeHost),
        isExtension: false,
        catalogSource: 'fallback',
        configDefaultModel: '',
        configDefaultEffort: '',
        probedAt: 0,
        version: '',
        installed: fb.available !== false,
        modelsMap: new Map(fb.models.map((m) => [m.id, { ...m }])),
      });
    }
  }

  for (const rawP of incomingList) {
    const pid = normalizeProviderId(rawP.id || rawP.provider || rawP.driverKind);
    if (!byProvider.has(pid)) {
      byProvider.set(pid, {
        id: pid,
        name: rawP.name || rawP.displayName || pid,
        available: rawP.available !== false && rawP.enabled !== false,
        isNativeHost: Boolean(rawP.isNativeHost || pid === 'antigravity'),
        isExtension: Boolean(rawP.isExtension || rawP.isCustom || !['kimi-code', 'codex', 'antigravity', 'claude-code'].includes(pid)),
        catalogSource: String(rawP.catalogSource || ''),
        configDefaultModel: String(rawP.configDefaultModel || ''),
        configDefaultEffort: String(rawP.configDefaultEffort || ''),
        probedAt: Number(rawP.probedAt || 0),
        version: String(rawP.version || ''),
        installed: rawP.installed !== false,
        modelsMap: new Map(),
      });
    }
    const targetP = byProvider.get(pid);
    if (pid === 'antigravity') {
      targetP.name = 'Antigravity (宿主原生)';
      targetP.isNativeHost = true;
    } else if (rawP.name || rawP.displayName) {
      targetP.name = rawP.name || rawP.displayName;
    }
    if (rawP.available !== undefined) targetP.available = Boolean(rawP.available);
    targetP.catalogSource = String(rawP.catalogSource || '');
    targetP.configDefaultModel = String(rawP.configDefaultModel || '');
    targetP.configDefaultEffort = String(rawP.configDefaultEffort || '');
    targetP.probedAt = Number(rawP.probedAt || 0);
    targetP.version = String(rawP.version || '');
    targetP.installed = rawP.installed !== false;
    if (Array.isArray(rawP.permissionModes) && rawP.permissionModes.length) targetP.permissionModes = rawP.permissionModes;
    if (Array.isArray(rawP.hostPermissionModes) && rawP.hostPermissionModes.length) targetP.hostPermissionModes = rawP.hostPermissionModes;

    const rawModels = Array.isArray(rawP.models) ? rawP.models : [];
    if (rawModels.length > 0) {
      targetP.modelsMap = new Map();
    }
    for (const rm of rawModels) {
      const mid = String(rm.id || rm.slug || rm.model || rm.value || '').trim();
      if (!mid || (pid === 'antigravity' && !isAllowedAgySubagentModel(mid))) continue;
      const existing = targetP.modelsMap.get(mid) || {};
      let efforts =
        rm.efforts ||
        rm.thinkingLevels ||
        rm.thoughtLevels ||
        rm.supportedEfforts ||
        existing.efforts;
      if (!Array.isArray(efforts)) {
        if (pid === 'kimi-code') efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
        else if (pid === 'codex') efforts = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
        else if (mid.includes('hydrogen')) efforts = ['low', 'medium', 'high', 'xhigh'];
        else efforts = ['low', 'medium', 'high'];
      }
      const rawCw = rm.contextWindow !== undefined ? rm.contextWindow : rm.maxContextTokens;
      const contextWindow = targetP.isExtension && rawCw !== undefined
        ? normalizeModelTokenLimit(rawCw)
        : Number(rawCw || existing.contextWindow || 0);
      const rawMaxOut = normalizeModelTokenLimit(rm.maxOutputTokens ?? existing.maxOutputTokens);
      targetP.modelsMap.set(mid, {
        ...existing,
        id: mid,
        name: rm.name || rm.displayName || existing.name || mid,
        group: rm.group || rm.providerGroup || (mid.includes('/') ? mid.split('/')[0] : existing.group || ''),
        ...(rm.description || existing.description ? { description: String(rm.description || existing.description) } : {}),
        efforts: [...efforts],
        defaultEffort: efforts.length ? rm.defaultEffort || existing.defaultEffort || efforts[Math.min(1, efforts.length - 1)] : '',
        contextWindow,
        ...(rawMaxOut ? { maxOutputTokens: rawMaxOut } : {}),
        isDefault: Boolean(rm.isDefault ?? existing.isDefault),
      });
    }
  }

  for (const ext of customProviders || []) {
    if (!ext || ext.enabled === false) continue;
    const pid = normalizeProviderId(ext.id);
    if (!byProvider.has(pid)) {
      byProvider.set(pid, {
        id: pid,
        name: `${ext.name || pid} (${(ext.protocol || 'acp').toUpperCase()})`,
        available: true,
        isNativeHost: false,
        isExtension: true,
        catalogSource: 'extension',
        configDefaultModel: '',
        configDefaultEffort: '',
        probedAt: 0,
        version: '',
        installed: Boolean(ext.detected ?? true),
        modelsMap: new Map(),
      });
    }
    const pEntry = byProvider.get(pid);
    if (!pEntry.configDefaultModel) pEntry.configDefaultModel = ext.defaultModel || '';
    pEntry.available = true;
    pEntry.isExtension = !['kimi-code', 'codex', 'antigravity', 'claude-code'].includes(pid);
    if (!pEntry.catalogSource) pEntry.catalogSource = 'extension';
    const extModels = Array.isArray(ext.models) && ext.models.length
      ? ext.models
      : [{ id: 'default', name: `${ext.name || pid} 默认模型` }];
    for (const em of extModels) {
      const mid = String(em.id || em.slug || em || 'default');
      if (!pEntry.modelsMap.has(mid)) {
        const effs = Array.isArray(em.efforts) ? em.efforts : ext.efforts || ['low', 'medium', 'high'];
        const maxOut = normalizeModelTokenLimit(em.maxOutputTokens);
        pEntry.modelsMap.set(mid, {
          id: mid,
          name: em.name || mid,
          group: em.group || em.providerGroup || (mid.includes('/') ? mid.split('/')[0] : ''),
          ...(em.description ? { description: String(em.description) } : {}),
          efforts: [...effs],
          defaultEffort: effs.length ? em.defaultEffort || effs[Math.min(1, effs.length - 1)] : '',
          contextWindow: normalizeModelTokenLimit(em.contextWindow ?? em.maxContextTokens),
          ...(maxOut ? { maxOutputTokens: maxOut } : {}),
          isDefault: Boolean(em.isDefault),
        });
      }
    }
  }

  const out = [];
  for (const p of byProvider.values()) {
    const models = Array.from(p.modelsMap.values());
    if (models.length === 0 && p.id === 'antigravity') models.push(...FALLBACK_PROVIDERS.find(p => p.id === 'antigravity').models);
    if (models.length === 0) {
      models.push({
        id: 'default',
        name: `${p.name} Default`,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',

      });
    }
    out.push({
      id: p.id,
      name: p.name,
      available: p.available,
      isNativeHost: Boolean(p.isNativeHost),
      isExtension: Boolean(p.isExtension),

      catalogSource: p.catalogSource || '',
      configDefaultModel: p.configDefaultModel || '',
      configDefaultEffort: p.configDefaultEffort || '',
      probedAt: Number(p.probedAt || 0),
      version: p.version || '',
      installed: p.installed !== false,
      permissionModes: sanitizePermissionModeList(p.permissionModes, p.id),
      hostPermissionModes: sanitizePermissionModeList(p.hostPermissionModes, p.id, true),
      models,
    });
  }
  return out;
}

// 后端目录下发的原生档位优先；缺失或畸形时回退本地同构档位表（FALLBACK_PROVIDERS / 旧守护进程）。
function sanitizePermissionModeList(raw, providerId, host = false) {
  const list = (Array.isArray(raw) ? raw : [])
    .filter((m) => m && typeof m === 'object' && typeof m.value === 'string' && m.value.trim())
    .map((m) => ({
      value: m.value.trim(),
      label: String(m.label || m.value),
      tier: String(m.tier || permissionTierOf(m.value) || ''),
      danger: Boolean(m.danger),
      disabled: Boolean(host || m.disabled),
    }));
  if (list.length) return list;
  return host ? [{ ...HOST_DEFAULT_PERMISSION }] : permissionLadderOf(providerId).map((m) => ({ ...m, disabled: false }));
}

export function normalizeTurnItem(raw, idx = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const rawType = String(raw.type || raw.kind || raw.itemType || 'assistant_message');
  let type = rawType;
  if (rawType === 'user' || rawType === 'userMessage' || rawType === 'prompt' || rawType === 'USER_INPUT') type = 'user_message';
  else if (rawType === 'assistant' || rawType === 'agentMessage' || rawType === 'agent_message' || rawType === 'message' || rawType === 'PLANNER_RESPONSE') type = 'assistant_message';
  else if (rawType === 'thought' || rawType === 'thinking') type = 'reasoning';
  else if (rawType === 'commandExecution' || rawType === 'execute') type = 'command_execution';
  else if (rawType === 'fileChange' || rawType === 'edit' || rawType === 'patch') type = 'file_change';
  else if (rawType === 'tool_call' || rawType === 'tool' || rawType === 'mcpToolCall' || rawType === 'dynamic_tool') {
    const k = String(raw.toolKind || raw.category || raw.kind || '').toLowerCase();
    const tn = String(raw.toolName || raw.name || raw.title || '').toLowerCase();
    if (k === 'execute' || tn.includes('bash') || tn.includes('command') || tn.includes('terminal') || raw.command) {
      type = 'command_execution';
    } else if (k === 'edit' || tn.includes('edit') || tn.includes('write') || raw.diff || raw.changes) {
      type = 'file_change';
    } else {
      type = 'tool_call';
    }
  } else if (rawType === 'plan' || rawType === 'todo' || rawType === 'todo_list') {
    type = 'todo_list';
  }

  const id = String(raw.id || raw.turnItemId || raw.toolCallId || raw.itemId || `item_${idx}_${raw.createdAt || 0}`);
  const status = normalizeStatus(raw.status || (raw.completedAt ? 'completed' : 'completed'));
  const createdAt = Number(raw.createdAt || raw.startedAt || raw.timestampMs || raw.timestamp || Date.now());
  const completedAt = raw.completedAt || raw.endedAt ? Number(raw.completedAt || raw.endedAt) : null;

  return {
    id,
    type,
    status,
    runId: raw.runId || '',
    toolCallId: raw.toolCallId || '',
    title: raw.title || raw.toolName || raw.name || '',
    text: raw.text ?? raw.content ?? raw.message ?? raw.summary ?? '',
    command: raw.command || raw.rawInput?.command || raw.rawInput?.CommandLine || raw.input?.command || (typeof raw.input === 'string' ? raw.input : ''),
    output: raw.output ?? raw.aggregatedOutput ?? raw.rawOutput ?? '',
    exitCode: raw.exitCode ?? raw.exit_code ?? null,
    filePath:
      raw.filePath ||
      raw.fileName ||
      raw.path ||
      raw.rawInput?.path ||
      raw.rawInput?.Path ||
      raw.locations?.[0]?.path ||
      raw.changes?.[0]?.path ||
      '',
    additions: Number(raw.additions ?? 0),
    deletions: Number(raw.deletions ?? 0),
    diff: raw.diff || raw.diffStr || raw.changes?.map((c) => c.diff || '').join('\n') || '',
    entries: Array.isArray(raw.entries || raw.todos || raw.items) ? (raw.entries || raw.todos || raw.items) : [],
    error: raw.error || raw.errorMessage || '',
    inputIntent: raw.inputIntent || '',
    rawInput: raw.rawInput || raw.args || raw.input || null,
    // v0.2.0：保留后端 turn_item.meta（含 injectedSpecs 规范注入回执），不丢字段
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
    createdAt,
    updatedAt: Number(raw.updatedAt || completedAt || createdAt),
    completedAt,
    durationMs: Number(raw.durationMs || (completedAt && createdAt ? Math.max(0, completedAt - createdAt) : 0)),
  };
}

/**
 * v0.2.0 规范注入回执归一：`item.meta.injectedSpecs || run.meta.injectedSpecs` → 计数为非负整数、items / warnings 恒为数组。
 * 无回执或「本轮零投递 + 零沿用 + 零告警」时返回 null（未启用项目 Spec 的普通仓库零噪音）。
 */
export function normalizeInjectedSpecs(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const count = (v) => Math.max(0, Math.floor(Number(v) || 0));
  const items = (Array.isArray(raw.items) ? raw.items : [])
    .filter((it) => it && typeof it === 'object')
    .map((it) => ({
      key: String(it.key || ''),
      id: String(it.id || ''),
      title: String(it.title || ''),
      kind: String(it.kind || ''),
      tier: String(it.tier || ''),
      required: Boolean(it.required),
      reason: String(it.reason || ''),
      bytes: count(it.bytes),
      sha: String(it.sha || ''),
      relPath: String(it.relPath || ''),
    }));
  const warnings = (Array.isArray(raw.warnings) ? raw.warnings : [])
    .filter((w) => w && typeof w === 'object')
    .map((w) => ({ code: String(w.code || ''), key: String(w.key || ''), message: String(w.message || '') }));
  const spec = {
    v: count(raw.v) || 1,
    deliveredCount: count(raw.deliveredCount),
    inlineCount: count(raw.inlineCount),
    summaryCount: count(raw.summaryCount),
    reusedCount: count(raw.reusedCount),
    degradedRequiredCount: count(raw.degradedRequiredCount),
    pluginDelivered: Boolean(raw.pluginDelivered),
    ledgerState: String(raw.ledgerState || ''),
    items,
    warnings,
  };
  if (spec.deliveredCount === 0 && spec.reusedCount === 0 && warnings.length === 0) return null;
  return spec;
}

export function normalizeQueueItem(q, idx = 0) {
  if (!q) return null;
  if (typeof q === 'string') {
    return { id: `q_${idx}`, text: q, createdAt: Date.now() };
  }
  return {
    id: String(q.id || q.queueId || q.queuedRunId || q.runId || `q_${idx}`),
    text: String(q.text || q.message || q.prompt || ''),
    createdAt: Number(q.createdAt || Date.now()),
  };
}

function normalizeUsageSnapshot(raw = {}, fallback = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const inputTokens = Number(source.inputTokens ?? source.input_tokens ?? base.inputTokens ?? 0);
  const cachedTokens = Number(source.cachedTokens ?? source.cachedInputTokens ?? source.cachedReadTokens ?? base.cachedTokens ?? 0);
  const reasoningTokens = Number(source.reasoningTokens ?? source.reasoningOutputTokens ?? source.thoughtTokens ?? base.reasoningTokens ?? 0);
  const outputTokens = Number(source.outputTokens ?? source.output_tokens ?? base.outputTokens ?? 0);
  return {
    inputTokens,
    cachedTokens,
    reasoningTokens,
    outputTokens,
    totalTokens: Number(source.totalTokens ?? source.total_tokens ?? base.totalTokens ?? (inputTokens + outputTokens + reasoningTokens)),
    contextUsed: Number(source.contextUsed ?? source.used ?? base.contextUsed ?? 0),
    contextLimit: Number(source.contextLimit ?? source.modelContextWindow ?? source.size ?? base.contextLimit ?? 0),
  };
}

export function normalizeThread(raw, existing = null) {
  if (!raw || typeof raw !== 'object') return existing;
  const id = String(raw.id || raw.threadId || raw.thread_id || existing?.id || '');
  if (!id) return existing;

  const ms = raw.modelSelection || {};
  const provider = normalizeProviderId(
    raw.provider || raw.driverKind || raw.driver || ms.provider || ms.instanceId || existing?.provider || 'kimi-code'
  );
  // 宿主原生仅认线程自身标记；provider === 'antigravity' 的预设 / 线程（如托管 agy 子成员）不因引擎而被盖成宿主原生
  const ownNativeHost = raw.isNativeHost ?? raw.meta?.isNativeHost;
  const isNativeHost = Boolean(
    raw.isNativeHost || raw.meta?.isNativeHost || id.startsWith('thr_native_') ||
    (ownNativeHost === undefined && existing?.isNativeHost)
  );
  const model = String(
    raw.model || ms.model || existing?.model || (provider === 'antigravity' ? 'gemini-4-carbon' : 'kimi-code/k3.1-pro')
  );
  const optEffort = Array.isArray(ms.options)
    ? ms.options.find((o) => o.id === 'effort' || o.id === 'thinking' || o.id === 'thought_level')?.value
    : undefined;
  const effort = String(raw.effort || raw.thinking || optEffort || ms.effort || existing?.effort || 'high');

  const parentThreadId =
    raw.parentThreadId ??
    raw.parent_thread_id ??
    raw.lineage?.parentThreadId ??
    existing?.parentThreadId ??
    null;

  const rawItems = raw.items || raw.turnItems || raw.activity || raw.timeline;
  let items = existing?.items ? [...existing.items] : [];
  if (Array.isArray(rawItems)) {
    const normalized = rawItems.map((it, idx) => normalizeTurnItem(it, idx)).filter(Boolean);
    if (normalized.length > 0 || items.length === 0) {
      items = normalized;
    }
  }

  const rawQueue = raw.queue || raw.queuedRuns || raw.queuedMessages;
  const queue = Array.isArray(rawQueue)
    ? rawQueue.map((q, i) => normalizeQueueItem(q, i)).filter(Boolean)
    : existing?.queue || [];

  const usage = raw.usage || raw.tokenUsage || existing?.usage || {};
  const normalizedUsage = normalizeUsageSnapshot(usage, existing?.usage);
  const { inputTokens, cachedTokens, reasoningTokens, outputTokens, totalTokens } = normalizedUsage;
  const recentRuns = raw.recentRuns || existing?.recentRuns || [];
  const rawCurrentRun = Object.hasOwn(raw, 'currentRun') ? raw.currentRun : existing?.currentRun;
  const currentRun = rawCurrentRun && typeof rawCurrentRun === 'object' ? (() => {
    const runUsage = normalizeUsageSnapshot(rawCurrentRun.usage);
    return {
      id: String(rawCurrentRun.id || rawCurrentRun.runId || ''),
      status: normalizeStatus(rawCurrentRun.status || 'idle'),
      inputIntent: String(rawCurrentRun.inputIntent || rawCurrentRun.meta?.inputIntent || ''),
      prompt: String(rawCurrentRun.prompt || ''),
      title: String(rawCurrentRun.title || rawCurrentRun.meta?.title || ''),
      taskId: String(rawCurrentRun.taskId || rawCurrentRun.meta?.taskId || ''),
      usage: runUsage,
      timings: rawCurrentRun.timings || rawCurrentRun.meta?.timings || null,
      preparationStage: rawCurrentRun.preparationStage || rawCurrentRun.meta?.preparationStage || null,
      usageReported: Boolean(rawCurrentRun.usageReported ?? rawCurrentRun.meta?.usageReported ?? (runUsage.totalTokens > 0)),
      startedAt: Number(rawCurrentRun.startedAt || 0),
      completedAt: rawCurrentRun.completedAt ? Number(rawCurrentRun.completedAt) : null,
      createdAt: Number(rawCurrentRun.createdAt || 0),
    };
  })() : null;
  const cumulativeUsage = normalizeUsageSnapshot(
    Object.hasOwn(raw, 'cumulativeUsage') ? raw.cumulativeUsage : existing?.cumulativeUsage || usage,
    normalizedUsage
  );

  const createdAt = Number(raw.createdAt || raw.created_at || existing?.createdAt || Date.now());
  const startedAt = Number(raw.startedAt || raw.activeRunStartedAt || existing?.startedAt || createdAt);
  const updatedAt = Number(raw.updatedAt || raw.updated_at || Date.now());
  const completedAt = Object.hasOwn(raw, 'completedAt') ? (raw.completedAt ? Number(raw.completedAt) : null) : existing?.completedAt || null;

  const nativeSessionId = String(raw.nativeSessionId ?? raw.sessionId ?? existing?.nativeSessionId ?? '');
  const hostConversationId = String(
    raw.hostConversationId ??
      (isNativeHost ? nativeSessionId || raw.conversationId || '' : '') ??
      existing?.hostConversationId ??
      ''
  );

  const cwdRaw = String(raw.cwd || existing?.cwd || '');
  const rawProjRoot =
    raw.projectRoot ||
    raw.repoRoot ||
    existing?.projectRoot ||
    raw.workspace ||
    (!isWorktreeOrTempPath(cwdRaw) ? cwdRaw : '') ||
    existing?.workspace ||
    '';
  const projectRoot = normalizeProjectPath(rawProjRoot);
  const projectName = String(raw.projectName || existing?.projectName || basenameOfPath(projectRoot) || '未归类项目');

  const meta = raw.meta && typeof raw.meta === 'object' ? { ...existing?.meta, ...raw.meta } : existing?.meta || {};
  const effectiveModel = String(
    raw.effectiveModel || raw.effective_model || meta.effectiveModel || existing?.effectiveModel || ''
  );
  const effectiveEffort = String(
    raw.effectiveEffort || raw.effective_effort || meta.effectiveEffort || existing?.effectiveEffort || ''
  );

  return {
    recentRuns,
    currentRun,
    orderCount: Math.max(0, Number(raw.orderCount ?? existing?.orderCount ?? recentRuns.filter((run) =>
      !['queued', 'cancelled'].includes(String(run?.status)) &&
      !['steer', 'steering_restart', 'follow_up', 'continue', 'chat'].includes(String(run?.inputIntent || run?.meta?.inputIntent || ''))
    ).length) || 0),
    cumulativeUsage,
    usageReported: Boolean(raw.usageReported ?? raw.currentRun?.usageReported ?? raw.meta?.usageReported ?? existing?.usageReported ?? (totalTokens > 0)),
    id,
    title: String(raw.title || raw.name || existing?.title || (isNativeHost ? 'Antigravity 宿主原生会话' : '未命名任务线程')),
    memberName: String(raw.memberName || raw.meta?.memberName || existing?.memberName || ''),
    isSwarmMember: Boolean(raw.isSwarmMember ?? existing?.isSwarmMember ?? false),
    swarmRootId: String(raw.swarmRootId || raw.rootConversationId || existing?.swarmRootId || ''),
    modelDisplayName: String(raw.modelDisplayName || raw.model_display_name || existing?.modelDisplayName || ''),
    effectiveModel,
    effectiveEffort,
    meta,
    steps: Number(raw.steps ?? existing?.steps ?? 0),
    posts: Number(raw.posts ?? existing?.posts ?? 0),
    role: String(raw.role || raw.presetKey || existing?.role || (parentThreadId ? 'implementation' : 'commander')),
    presetKey: String((Object.hasOwn(raw, 'presetKey') ? raw.presetKey : existing?.presetKey) || ''),
    status: normalizeStatus(raw.status || raw.runStatus || existing?.status || 'idle'),
    workState: raw.workState || existing?.workState || '',
    provider,
    isNativeHost,
    model,
    effort,
    permissionMode: String(raw.permissionMode || raw.runtimeMode || existing?.permissionMode || 'auto'),
    interactionMode: String(raw.interactionMode || existing?.interactionMode || 'default'),
    isolation: String(raw.isolation || (raw.worktreePath ? 'worktree' : existing?.isolation || 'shared')),
    cwd: cwdRaw || projectRoot,
    workspace: normalizeProjectPath(raw.workspace || projectRoot || existing?.workspace || ''),
    projectRoot,
    projectName,
    archived: Boolean(raw.archived ?? existing?.archived ?? false),
    worktreePath: String(raw.worktreePath ?? raw.worktree_path ?? existing?.worktreePath ?? ''),
    worktreeId: String(raw.worktreeId ?? existing?.worktreeId ?? ''),
    branch: String(raw.branch ?? existing?.branch ?? ''),
    parentThreadId: parentThreadId ? String(parentThreadId) : null,
    hostConversationId,
    rootConversationId: String(raw.rootConversationId || raw.swarmRootId || existing?.rootConversationId || ''),
    nativeSessionId,
    taskId: String(raw.taskId ?? raw.delegatedTaskId ?? existing?.taskId ?? ''),
    // 服务端快照显式给出 activeRunId: null 表示回合已结束，必须清空（否则两阶段中断会绑定到陈旧回合）
    activeRunId: String((Object.hasOwn(raw, 'activeRunId') ? raw.activeRunId : raw.runId ?? existing?.activeRunId) ?? ''),
    // 后端下发：'stoppable' | 'reconcilable_orphan' | 'host_only' | 'none'（缺失时由 threadCancelCapability 推断）
    cancelCapability: String(raw.cancelCapability ?? existing?.cancelCapability ?? ''),
    summary: String(raw.summary ?? raw.result ?? existing?.summary ?? ''),
    error: String(raw.error ?? raw.lastError ?? existing?.error ?? ''),
    items,
    queue,
    usage: normalizedUsage,
    createdAt,
    startedAt,
    updatedAt,
    completedAt,
    durationMs: Number((Object.hasOwn(raw, 'durationMs') ? raw.durationMs : existing?.durationMs) || 0),
    hydrated: Boolean(Array.isArray(rawItems) || existing?.hydrated),
  };
}

const WORK_ORDER_CONTINUE_INTENTS = new Set(['steer', 'steering_restart', 'follow_up', 'continue', 'chat']);
const WORK_ORDER_PROCESS_TYPES = new Set(['reasoning', 'tool_call', 'command_execution', 'file_change', 'todo_list']);

function workOrderRunIntent(run) {
  return String(run?.inputIntent || run?.meta?.inputIntent || '');
}

function isSubstantiveProcessItem(item) {
  if (!WORK_ORDER_PROCESS_TYPES.has(item?.type)) return false;
  if (item.type === 'tool_call' && /^(?:default_api:)?swarm_wait$/i.test(String(item.title || '').trim())) return false;
  return true;
}

function mergeSwarmBoardItemsForWorker(thread, rawItems, memberName) {
  const memberLower = String(memberName || '').toLowerCase();
  const isSwarmWorker = Boolean(
    (thread.isSwarmMember || thread.meta?.isSwarmMember) &&
    memberLower &&
    !['coordinator', 'commander'].includes(memberLower) &&
    String(thread.role || '').toLowerCase() !== 'commander'
  );
  if (!isSwarmWorker || !Array.isArray(state.boardMessages) || state.boardMessages.length === 0) return rawItems;
  const activeRoot = String(thread.rootConversationId || state.rootConversationId || state.activeConversationId || '').toLowerCase();
  const existingUserPrefixes = new Set(
    rawItems.filter((it) => it.type === 'user_message' && it.text).map((it) => String(it.text).replace(/\s+/g, ' ').trim().slice(0, 48))
  );
  const existingAssistPrefixes = new Set(
    rawItems.filter((it) => it.type === 'assistant_message' && it.text).map((it) => String(it.text).replace(/\s+/g, ' ').trim().slice(0, 48))
  );
  const synth = [];
  state.boardMessages.forEach((m, idx) => {
    if (!m || m.source !== 'native-swarm') return;
    if (activeRoot && m.rootConversationId && m.rootConversationId.toLowerCase() !== activeRoot) return;
    const senderLower = String(m.agent || '').toLowerCase();
    const cleanText = String(m.text || '').replace(/^(\s*@[A-Za-z0-9_.-]+[,:]?)+\s*/, '').trim() || String(m.text || '').trim();
    if (!cleanText) return;
    const prefix = cleanText.replace(/\s+/g, ' ').slice(0, 48);
    const mentioned = (Array.isArray(m.mentions) && m.mentions.some((x) => String(x || '').toLowerCase() === memberLower)) || Boolean(m.all);
    if (senderLower !== memberLower && mentioned && !existingUserPrefixes.has(prefix)) {
      const ts = Number(m.ts || 0);
      synth.push({
        item: normalizeTurnItem({
          id: `swarm_in_${m.seq || idx}`,
          type: 'user_message',
          status: 'completed',
          text: cleanText,
          createdAt: ts,
          updatedAt: ts,
          meta: { fromBoardSeq: m.seq || 0, sender: m.agent || 'coordinator' },
        }),
        sortTs: ts,
        rank: -1000 + idx,
      });
    } else if (senderLower === memberLower && !existingAssistPrefixes.has(prefix)) {
      const ts = Number(m.ts || 0);
      synth.push({
        item: normalizeTurnItem({
          id: `swarm_out_${m.seq || idx}`,
          type: 'assistant_message',
          status: 'completed',
          text: cleanText,
          createdAt: ts,
          updatedAt: ts,
          completedAt: ts,
          meta: { fromBoardSeq: m.seq || 0, isBoardReply: true },
        }),
        sortTs: ts,
        rank: 100000 + idx,
      });
    }
  });
  if (!synth.length) return rawItems;
  const combined = [
    ...rawItems.map((item, idx) => ({ item, sortTs: Number(item.createdAt || 0), rank: idx })),
    ...synth,
  ];
  combined.sort((a, b) => a.sortTs - b.sortTs || a.rank - b.rank);
  return combined.map((entry) => entry.item);
}

export function groupThreadWorkOrders(thread) {
  if (!thread) return [];
  const memberName = shortMemberName(thread);
  const rawItems = Array.isArray(thread.items) ? thread.items : [];
  const items = mergeSwarmBoardItemsForWorker(thread, rawItems, memberName);
  const runs = (Array.isArray(thread.recentRuns) ? thread.recentRuns : [])
    .filter((run) => run && !['queued', 'cancelled'].includes(String(run.status || '')))
    .map((run, index) => ({ run, index }))
    .sort((a, b) => Number(a.run.ordinal || 0) - Number(b.run.ordinal || 0) ||
      Number(a.run.createdAt || a.run.startedAt || 0) - Number(b.run.createdAt || b.run.startedAt || 0) || a.index - b.index)
    .map(({ run }) => run);
  const native = Boolean(thread.isSwarmMember || thread.isNativeHost ||
    items.some((item) => String(item.runId || '').startsWith('run_native_')) ||
    runs.some((run) => String(run.id || run.runId || '').startsWith('run_native_')));
  const orders = [];
  const byRunId = new Map();

  const addOrder = (run = null, key = '') => {
    const runId = String(run?.id || run?.runId || '');
    const order = {
      key: key || (runId ? `run:${runId}` : ''),
      orderNo: 0,
      runIds: runId ? [runId] : [],
      primaryRunId: runId,
      title: '',
      status: normalizeStatus(run?.status || 'idle'),
      startedAt: Number(run?.startedAt || run?.createdAt || 0),
      completedAt: run?.completedAt ? Number(run.completedAt) : null,
      usage: normalizeUsageSnapshot(run?.usage),
      usageReported: Boolean(run?.usageReported ?? run?.meta?.usageReported ?? false),
      promptItem: null,
      steerItems: [],
      processItems: [],
      intermediateNotes: [],
      conclusionItems: [],
      errorItems: [],
      isCurrent: false,
      items: [],
      runs: run ? [run] : [],
    };
    orders.push(order);
    if (runId) byRunId.set(runId, order);
    return order;
  };
  const mergeRun = (order, run) => {
    const runId = String(run?.id || run?.runId || '');
    if (runId && !order.runIds.includes(runId)) order.runIds.push(runId);
    order.primaryRunId ||= runId;
    if (run && !order.runs.some((existing) => String(existing.id || existing.runId || '') === runId)) order.runs.push(run);
    if (runId) byRunId.set(runId, order);
    return order;
  };

  for (const run of runs) {
    const continuation = WORK_ORDER_CONTINUE_INTENTS.has(workOrderRunIntent(run));
    const previous = orders.at(-1);
    if (continuation && previous) mergeRun(previous, run);
    else addOrder(run);
  }

  for (const item of items) {
    const runId = String(item.runId || '');
    const intent = String(item.inputIntent || byRunId.get(runId)?.runs.find((run) => String(run.id || run.runId || '') === runId && workOrderRunIntent(run)) || '');
    const continuation = WORK_ORDER_CONTINUE_INTENTS.has(intent) || item.meta?.live === true;
    let order = (!native && runId) ? byRunId.get(runId) : null;
    if (item.type === 'user_message') {
      if (native && !continuation) {
        const last = orders.at(-1);
        const lastHasPrompt = Boolean(last?.items.some((entry) => entry.type === 'user_message' &&
          !WORK_ORDER_CONTINUE_INTENTS.has(String(entry.inputIntent || '')) && entry.meta?.live !== true));
        if (lastHasPrompt || (order && order.items.some((entry) => entry.type === 'user_message'))) {
          order = addOrder(null, `native:${item.id}`);
        } else order ||= last || addOrder(null, `native:${item.id}`);
      } else if (continuation) {
        order ||= orders.at(-1) || addOrder(runId ? { id: runId, status: item.status } : null);
      } else if (!order) {
        const last = orders.at(-1);
        const startsNewRun = Boolean(runId && last && !last.runIds.includes(runId));
        const startsNewPrompt = Boolean(last && !runId && (last.promptItem || last.items.some((entry) => entry.type === 'user_message' && !WORK_ORDER_CONTINUE_INTENTS.has(String(entry.inputIntent || '')) && entry.meta?.live !== true)));
        if (startsNewRun || startsNewPrompt || !last) order = addOrder(runId ? { id: runId, status: item.status } : null);
        else order = last;
      }
    } else if (native) {
      order = orders.at(-1) || addOrder(runId ? { id: runId, status: item.status } : null);
    } else if (!order) {
      const last = orders.at(-1);
      if (runId && last && last.runIds.length === 0) order = mergeRun(last, { id: runId, status: item.status });
      else if (runId && (!last || !last.runIds.includes(runId))) {
        const activeContinuation = runId === String(thread.activeRunId || '') && WORK_ORDER_CONTINUE_INTENTS.has(workOrderRunIntent(thread.currentRun));
        if (activeContinuation && last) order = mergeRun(last, { id: runId, status: item.status });
        else order = addOrder({ id: runId, status: item.status });
      } else order ||= last || addOrder(runId ? { id: runId, status: item.status } : null);
    }
    order ||= orders.at(-1) || addOrder();
    if (runId) mergeRun(order, byRunId.get(runId)?.runs.find((run) => String(run.id || run.runId || '') === runId) || { id: runId, status: item.status });
    order.items.push(item);
  }

  const activeRunId = String(thread.activeRunId || thread.currentRun?.id || '');
  if (!native && isStatusActive(thread.status) && activeRunId) {
    const activeRun = runs.find((run) => String(run.id || run.runId || '') === activeRunId) || thread.currentRun || { id: activeRunId, status: thread.status };
    if (!['queued', 'cancelled'].includes(String(activeRun.status || ''))) {
      let order = byRunId.get(activeRunId);
      if (!order) {
        const last = orders.at(-1);
        const continuation = WORK_ORDER_CONTINUE_INTENTS.has(workOrderRunIntent(activeRun));
        if (last && (continuation || last.runIds.length === 0)) order = mergeRun(last, activeRun);
        else order = addOrder(activeRun);
      }
      const index = orders.indexOf(order);
      if (index >= 0 && index !== orders.length - 1) {
        orders.splice(index, 1);
        orders.push(order);
      }
      order.status = normalizeStatus(thread.status);
      order.startedAt ||= Number(thread.currentRun?.startedAt || thread.startedAt || 0);
    }
  } else if (native && isStatusActive(thread.status) && orders.length > 0) {
    orders.at(-1).status = normalizeStatus(thread.status);
  }

  const placeholders = new Set(['未命名任务线程', 'New Session', 'Agent Task']);
  orders.forEach((order, index) => {
    order.orderNo = index + 1;
    order.isCurrent = index === orders.length - 1;
    order.promptItem = order.items.find((item) => item.type === 'user_message' &&
      !WORK_ORDER_CONTINUE_INTENTS.has(String(item.inputIntent || '')) && item.meta?.live !== true) || null;
    if (!order.promptItem) {
      const seedRun = order.runs[0] || (order.isCurrent ? thread.currentRun : null);
      const fallbackPrompt = String(seedRun?.prompt || '').trim();
      if (fallbackPrompt && fallbackPrompt !== 'Native Antigravity Host Conversation') {
        order.promptItem = normalizeTurnItem({
          id: `run_prompt_${seedRun?.id || order.key || index}`,
          type: 'user_message',
          status: 'completed',
          runId: String(seedRun?.id || order.primaryRunId || ''),
          inputIntent: workOrderRunIntent(seedRun) || 'delegate',
          text: fallbackPrompt,
          meta: seedRun?.meta && typeof seedRun.meta === 'object' ? seedRun.meta : {},
          createdAt: Number(seedRun?.createdAt || seedRun?.startedAt || order.startedAt || thread.createdAt || 0),
        });
      }
    }
    order.steerItems = order.items.filter((item) => item.type === 'user_message' && item !== order.promptItem);
    order.processItems = order.items.filter((item) => WORK_ORDER_PROCESS_TYPES.has(item.type));
    let lastProcessIndex = -1;
    let lastProcessTime = 0;
    order.items.forEach((item, itemIndex) => {
      if (isSubstantiveProcessItem(item)) {
        lastProcessIndex = itemIndex;
        const tMs = Math.max(Number(item.completedAt || 0), Number(item.updatedAt || 0), Number(item.createdAt || 0));
        if (tMs > lastProcessTime) lastProcessTime = tMs;
      }
    });
    const intermediateNotes = [];
    const conclusionItems = [];
    order.items.forEach((item, itemIndex) => {
      if (item.type !== 'assistant_message') return;
      const itemUpdated = Math.max(Number(item.updatedAt || 0), Number(item.completedAt || 0));
      const isAfterProcess = lastProcessIndex < 0 || itemIndex > lastProcessIndex ||
        item.meta?.isBoardReply === true ||
        (lastProcessTime > 0 && itemUpdated > lastProcessTime);
      if (isAfterProcess) conclusionItems.push(item);
      else intermediateNotes.push(item);
    });
    const settled = !order.isCurrent ? true : !isStatusActive(thread.status);
    if (conclusionItems.length === 0 && intermediateNotes.length > 0 && settled) {
      conclusionItems.push(intermediateNotes.pop());
    }
    order.intermediateNotes = intermediateNotes;
    order.conclusionItems = conclusionItems;
    order.errorItems = order.items.filter((item) => item.type === 'error');
    const latestRun = order.runs.at(-1) || runs.find((run) => String(run.id || run.runId || '') === order.primaryRunId) || null;
    order.startedAt ||= Number(order.promptItem?.createdAt || order.items[0]?.createdAt || latestRun?.startedAt || latestRun?.createdAt || 0);
    order.completedAt ||= latestRun?.completedAt ? Number(latestRun.completedAt) : null;
    if (!order.isCurrent) order.status = normalizeStatus(latestRun?.status || (order.errorItems.length ? 'failed' : order.items.some((item) => item.status === 'running') ? 'running' : 'completed'));
    const currentUsage = order.isCurrent && thread.currentRun && order.runIds.includes(thread.currentRun.id)
      ? thread.currentRun.usage
      : order.isCurrent ? thread.usage : latestRun?.usage;
    order.usage = normalizeUsageSnapshot(currentUsage || order.usage);
    order.usageReported = order.isCurrent && thread.currentRun && order.runIds.includes(thread.currentRun.id)
      ? Boolean(thread.currentRun.usageReported || order.usage.totalTokens > 0)
      : Boolean(order.isCurrent ? (thread.usageReported || order.usage.totalTokens > 0) : (latestRun?.usageReported ?? latestRun?.meta?.usageReported ?? order.usage.totalTokens > 0));
    let title = String((!native ? latestRun?.meta?.title || latestRun?.title : '') || (order.isCurrent && !native ? thread.title : '') || '').replace(/\s+/g, ' ').trim();
    if (!title || title === memberName || placeholders.has(title)) {
      title = String(order.promptItem?.text || '').split(/\r?\n/, 1)[0].replace(/\s+/g, ' ').trim().slice(0, 36);
    }
    order.title = title;
    order.key ||= `items:${order.promptItem?.id || order.items[0]?.id || order.primaryRunId || index}`;
  });
  return orders;
}

/** 中断能力：严格以后端 cancelCapability 为准；旧守护进程缺字段时按宿主原生 / 活跃态推断。 */
export function threadCancelCapability(t) {
  if (!t || !isStatusActive(t.status)) return 'none';
  const cap = String(t.cancelCapability || '');
  if (cap === 'stoppable' || cap === 'reconcilable_orphan' || cap === 'host_only') return cap;
  // 'none' 只可能来自空闲态快照；本地事件已把状态推进为活跃时按线程类型推断，避免吞掉中断入口。
  return t.isNativeHost ? 'host_only' : 'stoppable';
}

/** 合并服务端线程快照（保留本地时间线 / 队列），返回最新对象。 */
export function upsertLocalThread(rawThread) {
  if (!rawThread || typeof rawThread !== 'object' || rawThread.archived) return null;
  const tid = String(rawThread.id || rawThread.threadId || '');
  if (!tid || state.archivedThreadIds.has(tid)) return null;
  const merged = normalizeThread(rawThread, state.threadsMap.get(tid));
  if (merged) state.threadsMap.set(tid, merged);
  return merged;
}

export function shortMemberName(t) {
  if (!t) return 'agent';
  if (t.memberName && String(t.memberName).trim()) return String(t.memberName).trim();
  const raw = String(t.title || '').trim();
  if (raw && raw.length <= 24 && !/\n/.test(raw) && !raw.includes('...')) return raw;
  if (t.presetKey) return t.presetKey;
  if (t.role && t.role !== 'implementation' && t.role !== 'worker') return t.role;
  if (raw) return raw.slice(0, 18) + '…';
  return t.provider || 'agent';
}

const PASTEL_AVATARS = [
  '#d7e3f4',
  '#d8ead7',
  '#f3e3cd',
  '#eadcf2',
  '#f4d9df',
  '#d5ecea',
  '#ebe7cf',
  '#dde2f4',
  '#e4ead5',
  '#f2dfd3',
];

export function agentPastelColor(name) {
  const s = String(name || 'agent');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return PASTEL_AVATARS[Math.abs(h) % PASTEL_AVATARS.length];
}

export function normalizeBoardMessage(raw, idx = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const seq = Number(raw.seq || idx + 1);
  const agent = String(raw.agent || raw.memberName || 'agent').trim();
  return {
    seq,
    agent,
    mentions: Array.isArray(raw.mentions) ? raw.mentions.map((x) => String(x)) : [],
    all: Boolean(raw.all),
    text: String(raw.text || ''),
    time: String(raw.time || ''),
    ts: Number(raw.ts || (raw.time ? Date.parse(String(raw.time).replace(' ', 'T')) : 0) || 0),
    threadId: String(raw.threadId || ''),
    runId: String(raw.runId || ''),
    projectRoot: normalizeProjectPath(raw.projectRoot || raw.workspace || ''),
    rootConversationId: String(raw.rootConversationId || raw.conversationId || ''),
    provider: String(raw.provider || ''),
    model: String(raw.model || ''),
    modelDisplayName: String(raw.modelDisplayName || raw.model_display_name || ''),
    effectiveModel: String(raw.effectiveModel || raw.effective_model || raw.meta?.effectiveModel || ''),
    meta: raw.meta && typeof raw.meta === 'object' ? raw.meta : {},
    reasoningSummary: String(raw.reasoningSummary || ''),
    toolCount: Number(raw.toolCount || 0),
    hasError: Boolean(raw.hasError),
    errorText: String(raw.errorText || ''),
    failedToolCount: Number(raw.failedToolCount || 0),
    source: String(raw.source || 'native-swarm'),
  };
}

export function normalizeCollaborationEdge(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const from = String(raw.from || '').trim();
  const to = String(raw.to || '').trim();
  if (!from || !to || from === to) return null;
  return {
    from,
    to,
    kind: String(raw.kind || 'mention'),
    count: Math.max(1, Number(raw.count || (Number(raw.direct || 0) + Number(raw.viaAll || 0)) || 1)),
    direct: Number(raw.direct || 0),
    viaAll: Number(raw.viaAll || 0),
  };
}

export function normalizeRuntimeRequest(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.requestId || raw.runtimeRequestId || raw.reqId || '');
  if (!id) return null;
  const kind = String(raw.kind || raw.type || (raw.questions || raw.multiSelect ? 'question' : 'approval'));
  return {
    id,
    threadId: String(raw.threadId || raw.thread_id || ''),
    rootConversationId: String(raw.rootConversationId || raw.conversationId || ''),
    runId: String(raw.runId || ''),
    kind: kind.includes('question') || kind.includes('elicitation') || kind.includes('input') ? 'question' : 'approval',
    status: String(raw.status || 'pending'),
    title: String(raw.title || raw.prompt || raw.question || (kind === 'question' ? '子 Agent 请求补充决策' : '敏感工具执行权限审批')),
    description: String(raw.description || raw.reason || ''),
    preview: String(raw.preview || raw.command || raw.diff || (raw.toolCall ? JSON.stringify(raw.toolCall, null, 2) : '') || ''),
    options: Array.isArray(raw.options) ? raw.options : [],
    questions: Array.isArray(raw.questions) ? raw.questions : null,
    multiSelect: Boolean(raw.multiSelect || raw.isMultiSelect),
    createdAt: Number(raw.createdAt || Date.now()),
  };
}

export function normalizeWorktree(raw, idx = 0) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || raw.worktreeId || raw.path || raw.worktreePath || `wt_${idx}`);
  const wtPath = String(raw.path || raw.worktreePath || '');
  const repoRoot = normalizeProjectPath(raw.projectRoot || raw.repoRoot || (!isWorktreeOrTempPath(raw.cwd) ? raw.cwd : '') || '');
  const projName = String(raw.projectName || basenameOfPath(repoRoot) || '默认项目');
  return {
    id,
    threadId: String(raw.threadId || raw.ownerThreadId || ''),
    rootConversationId: String(raw.rootConversationId || raw.conversationId || ''),
    threadTitle: String(raw.threadTitle || raw.ownerTitle || ''),
    branch: String(raw.branch || raw.branchName || 'worktree'),
    path: wtPath,
    cwd: String(raw.cwd || raw.repoRoot || repoRoot || ''),
    projectRoot: repoRoot,
    projectName: projName,
    dirty: Boolean(raw.dirty ?? raw.hasChanges ?? true),
    additions: Number(raw.additions ?? 0),
    deletions: Number(raw.deletions ?? 0),
    filesCount: Number(raw.filesCount ?? raw.changedFilesCount ?? (Array.isArray(raw.files) ? raw.files.length : 0)),
    updatedAt: Number(raw.updatedAt || Date.now()),
  };
}

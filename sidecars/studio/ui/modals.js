/**
 * AgentTower Studio — 派发抽屉、批量模板、动态军师团、代码终审（评审组降级确认）、重试与扩展向导弹窗 (`ui/modals.js`)

 */
import { deriveInteractionMode, isDangerPermissionFor, normalizePermissionForProvider } from './permissions.js';
import { escapeHtml } from './format.js';
import { setText } from './dom-guards.js';
import { EMPTY_MEMBER_FALLBACK, PRESET_ROUTE_FIELDS, activeGroupMembers, currentOrchestrationMode, fallbackGroupPreset, getEffectiveCwd, isModeStageEnabled, isPresetInActivePool, listDispatchablePresets, preferredGroupPreset, recomputeScopedStats, state } from './state.js';
import { scheduleRender } from './render.js';
import { describeRpcError, relayToHostConversation, rpcCall, showToast } from './net.js';
import { normalizeModelTokenLimit, normalizeProviderId, normalizeProvidersCatalog, normalizeThread, presetDispatchRoute } from './normalize.js';
import { formatEffortDisplay, formatModelDisplay, formatProviderBadge, getRoleIcon } from './widgets.js';
import { buildEffortOptionsHtml, buildModelOptionsHtml, buildPermissionOptionsHtml, buildProviderOptionsHtml, populateLinkedSelectTrio, syncComposerSelects } from './options.js';
import { ensureDispatchAllowedInteractive, refreshThreadsList } from './stream.js';
import { parseArgsInput, parseEnvInput, parseModelsTextarea, refreshExtensionProviders, setSettingsPane } from './config-view.js';
import { setActiveView } from './nav.js';
import { openMemberDrawer } from './members-view.js';
import { showDispatchBypassedToast, stageGateMessage } from './composer.js';
import { defaultReviewerPreset, ensurePresetsSaved, syncBoundDraftsWithPresets } from './presets.js';

async function ensurePresetsReadyForDispatch() {
  const epoch = state.conversationEpoch;
  if (!state.bootstrapLoaded && state.bootstrapPromise) {
    await Promise.race([state.bootstrapPromise, new Promise(r => setTimeout(r, 1500))]).catch(() => {});
  }
  return epoch === state.conversationEpoch && ensurePresetsSaved();
}

/* ========================================================================
 * v0.2.6 宿主原生成员代派桥接（C07③ / C08 / C12③）
 * ======================================================================== */
export const NATIVE_DISPATCH_HINT_TEXT = '含宿主原生成员，提交后将发送至当前主对话自动代派';

function isNativeProvider(provider) {
  return normalizeProviderId(provider) === 'antigravity';
}

/** 各弹窗当前选择是否包含 Antigravity 宿主原生成员（只读状态 / DOM，不触发任何请求）。 */
function modalSelectsNativeMember(backdropId) {
  if (backdropId === 'dispatch-drawer-backdrop') {
    if (state.dispatchMode === 'batch') return state.batchDrafts.some(d => isNativeProvider(d.provider || state.presets[d.presetKey]?.provider));
    return isNativeProvider(state.dispatchSelection?.provider);
  }
  if (backdropId === 'council-modal-backdrop') {
    return [...document.querySelectorAll('#council-members-list [data-council-member]:checked')]
      .some(el => isNativeProvider(state.presets[el.dataset.councilMember]?.provider));
  }
  if (backdropId === 'review-modal-backdrop') return isNativeProvider(state.reviewDraft?.provider);
  return false;
}

const NATIVE_HINT_SUBMIT_BUTTONS = Object.freeze({
  'dispatch-drawer-backdrop': 'btn-submit-dispatch',
  'council-modal-backdrop': 'btn-confirm-council',
  'review-modal-backdrop': 'btn-confirm-review',
});

/** 在提交按钮所在底栏左侧渲染 / 隐藏一行温和内联小字提示（不弹二次确认框）。 */
export function syncNativeDispatchHints() {
  for (const [backdropId, buttonId] of Object.entries(NATIVE_HINT_SUBMIT_BUTTONS)) {
    const foot = document.getElementById(buttonId)?.parentElement;
    if (!foot) continue;
    let hint = foot.querySelector('[data-native-dispatch-hint]');
    const show = modalSelectsNativeMember(backdropId);
    if (!show) {
      if (hint) hint.hidden = true;
      continue;
    }
    if (!hint) {
      hint = document.createElement('span');
      hint.setAttribute('data-native-dispatch-hint', '1');
      hint.setAttribute('role', 'note');
      hint.style.cssText = 'flex:1 1 0;min-width:0;align-self:center;font-size:11px;line-height:1.35;color:var(--sw-fg-muted);overflow-wrap:anywhere;';
      hint.textContent = NATIVE_DISPATCH_HINT_TEXT;
      foot.insertBefore(hint, foot.firstChild);
    }
    hint.hidden = false;
  }
}

/** 弹窗内任意选择变化（芯片 / 引擎下拉 / 勾选军师）后刷新提示；每个弹窗只挂一次监听。 */
function bindNativeHintRefresh(backdropId) {
  const backdrop = document.getElementById(backdropId);
  if (!backdrop || backdrop.dataset.atNativeHint) return;
  backdrop.dataset.atNativeHint = '1';
  const refresh = () => setTimeout(syncNativeDispatchHints, 0);
  backdrop.addEventListener('change', refresh);
  backdrop.addEventListener('click', refresh);
}

/**
 * 处理派发结果中的宿主原生代派票据 `hostActions`（`[{ handoffId, presetKey, label, role, nativeKind, tool, args, hostPrompt }]`）：
 * 宿主内经 `window.sidecar.agent.sendMessage` 投递至当前主对话，独立浏览器降级复制。返回已投递的票据数。
 */
export async function relayHostActions(res) {
  const actions = Array.isArray(res?.hostActions) ? res.hostActions : [];
  if (!actions.length) return 0;
  const promptText = actions.map(a => a?.hostPrompt).filter(Boolean).join('\n\n');
  if (!promptText) return 0;
  await relayHostPrompt(promptText);
  return actions.length;
}

async function relayHostPrompt(promptText) {
  const outcome = await relayToHostConversation(promptText);
  if (outcome === 'sent') showToast('已发送至当前主对话自动代派原生成员', 'info');
  else if (outcome === 'copied') showToast('已复制宿主原生代派指令，请粘贴到主对话执行', 'info');
  else showToast('宿主原生代派指令发送失败，请在主对话手动调用原生 swarm 派遣', 'error');
  return outcome;
}

/** 兼容旧版 Daemon：抛出 AGY_SWARM_DISPATCH_REQUIRED 时提取其中的原生 swarm 指令同样代派；返回是否已处理。 */
async function relayLegacySwarmError(err) {
  if (err?.code !== 'AGY_SWARM_DISPATCH_REQUIRED') return false;
  const swarm = err?.details?.swarm;
  const promptText = swarm && typeof swarm === 'object'
    ? `请在当前主对话直接调用原生 swarm(${JSON.stringify(swarm)}) 派遣该 Antigravity 成员，塔台会自动认领并同步至成员面板。`
    : String(err?.message || '').trim();
  if (!promptText) return false;
  await relayHostPrompt(promptText);
  return true;
}

/** 当前对话模式下有效启用的军师（复杂阵容军师阶段开启时的勾选成员；简单模式 / 阶段关闭时为空）。 */
function enabledAdvisors() {
  return activeGroupMembers('advisor', currentOrchestrationMode());
}
/** 军师 / 审核阶段在当前对话模式下不可用（简单模式、复杂模式阶段关闭）时给出友好说明并拒绝打开入口。 */
function stageUnavailable(group) {
  const mode = currentOrchestrationMode();
  if (mode !== 'relay' && (mode !== 'complex' || isModeStageEnabled('complex', group))) return false;
  showToast(stageGateMessage(group, mode), 'info');
  return true;
}

function councilBrief(topic) {
  return `【用户原话 / 会审议题】\n${topic}\n\n【盲评要求】请仅基于上述用户原意与当前仓库已核实的客观代码事实独立判断，不预设倾向，严禁修改任何文件。`;
}

export async function submitCouncilSummon() {
  const topicInput = document.getElementById('council-topic-input');
  const topic = (topicInput?.value || '').trim();
  if (!topic) {
    showToast('请先填写希望军师讨论的原始诉求或议题', 'error');
    topicInput?.focus();
    return;
  }
  const epoch = state.conversationEpoch;
  const selection = '#council-members-list [data-council-member]:checked';
  if (!document.querySelectorAll(selection).length) {
    showToast(enabledAdvisors().length ? '请至少勾选一名军师' : stageGateMessage('advisor') || '当前阵容没有可用的军师，请到「配置 › 角色路由」勾选', 'error');
    return;
  }
  if (!(await ensurePresetsReadyForDispatch()) || epoch !== state.conversationEpoch) return;
  if (document.getElementById('council-modal-backdrop')?.hidden) return;
  const checked = new Set([...document.querySelectorAll(selection)].map(el => el.dataset.councilMember));
  const advisors = enabledAdvisors().filter(p => checked.has(p.key));
  if (!advisors.length) {
    showToast('当前勾选的军师已不可用，请重新选择', 'error');
    return;
  }
  const cwd = getEffectiveCwd();
  const brief = councilBrief(topic);

  try {
    const res = await rpcCall('delegateParallelBatch', {
      mode: 'async',
      cwd: cwd || undefined,
      workspace: cwd || undefined,
      parentThreadId: state.selectedThreadId || undefined,

      // Every advisor receives the identical brief: the user's own words, no per-member angle or injected bias.
      tasks: advisors.map((p) => ({
        title: `🧠 ${p.label || p.key} · 方案评审`,
        role: p.role || 'design',
        presetKey: p.key,
        isolation: 'shared',
        task: brief,
        prompt: brief,
      })),
    });
    if (epoch !== state.conversationEpoch) return;
    if (res?.bypassed) {
      showDispatchBypassedToast(res);
      return;
    }
    if (topicInput) topicInput.value = '';
    closeCouncilModal();
    setActiveView('board');
    const relayedNative = await relayHostActions(res);
    if (epoch !== state.conversationEpoch) return;
    if (relayedNative < advisors.length) showToast('🧠 已并发召唤军师团！请在看板或成员列表实时盯盘', 'success');
    if (Array.isArray(res?.threads)) {
      for (const t of res.threads) {
        const nt = normalizeThread(t);
        if (nt) state.threadsMap.set(nt.id, nt);
      }
      scheduleRender();
    } else {
      await refreshThreadsList();
      if (epoch !== state.conversationEpoch) return;
    }
  } catch (err) {
    if (await relayLegacySwarmError(err)) return;
    showToast(describeRpcError(err), 'error');
  }
}

/**
 * 审核阶段已开启但未勾选评审官：打开弹窗时预告，遇 REVIEW_POOL_EMPTY / PRESET_DISABLED 时给出一键选择
 * （去配置勾选评审官 / 确认降级为主会话自审），绝不静默伪装已完成独立终审；v0.1.1 起不再放行未勾选成员。
 */
function renderReviewPoolHint(fromError = false) {
  const hint = document.getElementById('review-pool-hint');
  if (!hint) return;
  if (activeGroupMembers('reviewer').length && !fromError) {
    hint.hidden = true;
    hint.innerHTML = '';
    return;
  }
  hint.hidden = false;
  hint.innerHTML = `<div class="review-pool-msg">${fromError ? '当前阵容没有可用的评审官，独立终审需要你明确选择：' : '复杂阵容审核阶段尚未勾选评审官：终审时将提示确认降级为主会话自审。'}</div>
      <div class="review-pool-actions">
        <button type="button" class="ghost-xs-btn" data-review-pool="goto">去配置勾选评审官</button>
        <button type="button" class="ghost-xs-btn danger-txt" data-review-pool="degrade">确认降级为主会话自审</button>
      </div>`;
}

/** 终审弹窗评审官芯片：只列复杂阵容审核阶段已勾选的评审官（全界面严锁勾选池）。 */
export function renderReviewMemberChips() {
  const box = document.getElementById('review-member-chips');
  const wrap = document.getElementById('review-member-wrap');
  if (!box) return;
  const members = activeGroupMembers('reviewer');
  if (wrap) wrap.hidden = members.length === 0;
  box.innerHTML = members.map((p) => `<button type="button" class="preset-chip-btn${state.reviewDraft?.presetKey === p.key ? ' active' : ''}" data-review-member="${escapeHtml(p.key)}" aria-pressed="${state.reviewDraft?.presetKey === p.key}" title="${escapeHtml(`${p.label || p.key} · ${formatProviderBadge(normalizeProviderId(p.provider))}/${formatModelDisplay(p.model)}`)}">${getRoleIcon(p.role, p.key)} ${escapeHtml(String(p.label || p.key).split(' ')[0])}</button>`).join('');
}
export function selectReviewMember(key) {
  const p = activeGroupMembers('reviewer').find((m) => m.key === key);
  if (!p || !state.reviewDraft) return;
  state.reviewDraftCustomized = false;
  Object.assign(state.reviewDraft, { presetKey: p.key, provider: normalizeProviderId(p.provider), model: p.model || 'gpt-6.2-astra', effort: p.effort || 'xhigh' });
  populateLinkedSelectTrio(document.getElementById('review-provider'), document.getElementById('review-model'), document.getElementById('review-effort'), state.reviewDraft);
  renderReviewModalState();
  renderReviewMemberChips();
}

export async function handleReviewPoolAction(action) {
  if (action === 'goto') {
    closeCodeReviewModal();
    state.editingModeProfile = 'complex';
    setActiveView('settings');
    setSettingsPane('roles');
  } else if (action === 'degrade') {
    const draft = state.reviewDraft || {};
    try {
      const result = await rpcCall('runCodeReview', {
        cwd: draft.cwd || getEffectiveCwd() || undefined,
        workspace: draft.cwd || getEffectiveCwd() || undefined,
        parentThreadId: draft.parentThreadId || state.selectedThreadId || undefined,
        degradeToHostSelfReview: true,
      });
      closeCodeReviewModal();
      showToast(
        result?.summary || result?.instruction || '已确认降级：本轮由主会话自行审查改动，终审结论需标注「主会话代审」',
        'info'
      );
      return result;
    } catch (err) {
      if (err?.code === 'REVIEW_POOL_EMPTY') renderReviewPoolHint(true);
      showToast(describeRpcError(err), 'error');
      return null;
    }
  }
  return null;
}

export function renderReviewModalState() {
  const readOnly = state.reviewDraft.reviewMode === 'read_only';
  for (const button of document.querySelectorAll('[data-review-mode]')) {
    const active = button.dataset.reviewMode === state.reviewDraft.reviewMode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  }
  const branchWrap = document.getElementById('review-branch-wrap');
  if (branchWrap) branchWrap.hidden = (state.reviewDraft?.scope || 'uncommitted') !== 'branch';

  const revProvEl = document.getElementById('review-provider');
  const revModEl = document.getElementById('review-model');
  const revEffEl = document.getElementById('review-effort');
  if (readOnly) {
    if (state.reviewDraft && state.reviewDraft.provider !== 'codex') {
      state.reviewDraft.provider = 'codex';
      populateLinkedSelectTrio(revProvEl, revModEl, revEffEl, state.reviewDraft);
    }
    if (revProvEl) {
      revProvEl.value = 'codex';
      revProvEl.disabled = true;
      revProvEl.title = '仅 Codex 支持强制只读沙盒';
    }
  } else if (revProvEl) {
    revProvEl.disabled = false;
    revProvEl.title = '';
  }
  syncNativeDispatchHints();
}

function openCodeReviewModal(customCwd = '', labelSuffix = '当前项目改动', parentThreadIdOverride = '') {
  if (!ensureDispatchAllowedInteractive()) return;
  if (stageUnavailable('reviewer')) return;
  syncBoundDraftsWithPresets();
  // 默认跟随复杂阵容审核阶段的首选 ★ / 首个勾选评审官 / 评审组首个成员；评审组被删空时以空占位走自定义路由
  const rev = defaultReviewerPreset() || { key: '' };
  const targetCwd = String(customCwd || getEffectiveCwd() || '').trim();
  const safeLabel = String(labelSuffix || '当前项目改动').trim();
  state.reviewDraftCustomized = false;
  state.reviewDraft = {
    reviewMode: 'review_and_fix',
    scope: 'uncommitted',
    baseBranch: 'main',
    presetKey: rev.key,
    provider: normalizeProviderId(rev.provider || 'codex'),
    model: rev.model || 'gpt-6.2-astra',
    effort: rev.effort || 'xhigh',
    cwd: targetCwd,
    labelSuffix: safeLabel,
    parentThreadId: String(parentThreadIdOverride || state.selectedThreadId || ''),
  };
  renderReviewPoolHint(false);
  renderReviewMemberChips();

  populateLinkedSelectTrio(
    document.getElementById('review-provider'),
    document.getElementById('review-model'),
    document.getElementById('review-effort'),
    state.reviewDraft
  );

  const subEl = document.getElementById('review-target-subtitle');
  if (subEl) {
    subEl.textContent = targetCwd ? `审查目标：${safeLabel} · ${targetCwd}` : `审查目标：${safeLabel}`;
  }
  const cwdEl = document.getElementById('review-cwd-input');
  if (cwdEl) cwdEl.value = targetCwd;
  const scopeEl = document.getElementById('review-scope-select');
  if (scopeEl) scopeEl.value = 'uncommitted';
  const branchEl = document.getElementById('review-base-branch');
  if (branchEl && !branchEl.value.trim()) branchEl.value = 'main';
  const focusEl = document.getElementById('review-focus-input');
  if (focusEl) focusEl.value = '';

  renderReviewModalState();
  bindNativeHintRefresh('review-modal-backdrop');
  const backdrop = document.getElementById('review-modal-backdrop');
  if (backdrop) backdrop.hidden = false;
}

export function closeCodeReviewModal() {
  const backdrop = document.getElementById('review-modal-backdrop');
  if (backdrop) backdrop.hidden = true;
}

export async function submitCodeReviewModal() {
  const epoch = state.conversationEpoch;
  if (!(await ensurePresetsReadyForDispatch()) || epoch !== state.conversationEpoch) return;
  const d = state.reviewDraft;

  const reviewMode = d.reviewMode;
  const readOnly = reviewMode === 'read_only';
  const scope = document.getElementById('review-scope-select')?.value === 'branch' ? 'branch' : 'uncommitted';
  const baseBranch = document.getElementById('review-base-branch')?.value.trim() || '';
  const targetCwd = document.getElementById('review-cwd-input')?.value.trim() || d.cwd || getEffectiveCwd();
  const focus = document.getElementById('review-focus-input')?.value.trim() || '';

  if (scope === 'branch' && !baseBranch) {
    showToast('对比基点分支时请填写基点分支名称', 'error');
    document.getElementById('review-base-branch')?.focus();
    return;
  }

  const revKey = d.presetKey && state.presets[d.presetKey] ? d.presetKey : defaultReviewerPreset()?.key || '';
  const revPreset = state.presets[revKey];
  const matchesReviewerPreset = Boolean(
    revPreset &&
    isPresetInActivePool(revKey) &&
    normalizeProviderId(d.provider) === normalizeProviderId(revPreset.provider) &&
    String(d.model || '') === String(revPreset.model || '') &&
    String(d.effort || '') === String(revPreset.effort || '')
  );
  const reviewRoute = matchesReviewerPreset
    ? { presetKey: revKey }
    : { provider: d.provider, model: d.model, effort: d.effort };

  const confirmBtn = document.getElementById('btn-confirm-review');
  if (confirmBtn) confirmBtn.disabled = true;
  try {
    const modeTag = readOnly ? '只读诊断' : '审改一体闭环';
    const res = await rpcCall('runCodeReview', {
      title: `🔍 ${matchesReviewerPreset ? revPreset.label || '评审官' : '终审'} (${modeTag}) · ${d.labelSuffix || '当前项目改动'}`,
      reviewMode,
      readOnly,
      scope,
      uncommitted: scope === 'uncommitted',
      baseBranch: scope === 'branch' ? baseBranch : undefined,
      focus: focus || undefined,
      prompt: focus || undefined,
      ...reviewRoute,
      cwd: targetCwd || undefined,
      workspace: targetCwd || undefined,
      parentThreadId: d.parentThreadId || state.selectedThreadId || undefined,

    });
    if (epoch !== state.conversationEpoch) return;
    document.getElementById('review-focus-input').value = '';
    document.querySelectorAll('#review-modal-backdrop [data-at-draft]').forEach(el => delete el.dataset.atDraft);
    closeCodeReviewModal();
    const relayedNative = await relayHostActions(res);
    if (epoch !== state.conversationEpoch) return;
    if (!relayedNative) showToast(`已启动${modeTag}。`, 'success');
    await refreshThreadsList();
    if (epoch !== state.conversationEpoch) return;
    const tid = String(res?.threadId || res?.thread?.id || res?.id || '');
    if (tid) openMemberDrawer(tid);
    else setActiveView('board');
  } catch (err) {
    if (err?.code === 'REVIEW_POOL_EMPTY' || (err?.code === 'PRESET_DISABLED' && state.presets[revKey]?.group === 'reviewer')) {
      renderReviewPoolHint(true);
    }
    if (await relayLegacySwarmError(err)) return;
    showToast(describeRpcError(err), 'error');
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

export function triggerAstraCodeReview(customCwd = '', labelSuffix = '当前项目改动', parentThreadIdOverride = '') {
  openCodeReviewModal(customCwd, labelSuffix, parentThreadIdOverride);
}

function normalizeWizardExtProtocol(rawProto, driverKind) {
  const p = String(rawProto || '').trim().toLowerCase();
  if (p === 'zcode' || p === 'cli' || p === 'acp') return p;
  if (driverKind === 'zcode') return 'zcode';
  if (driverKind === 'generic-cli') return 'cli';
  return 'acp';
}

function wizardExtDriverKind(protocol) {
  if (protocol === 'zcode') return 'zcode';
  if (protocol === 'cli') return 'generic-cli';
  return 'generic-acp';
}

function cacheWizardModelMeta(wizard, id, models, defaultModel) {
  wizard.id = id;
  wizard.defaultModel = defaultModel || '';
  wizard.models.clear();
  for (const m of Array.isArray(models) ? models : []) {
    if (!m || typeof m !== 'object') continue;
    const mid = String(m.id || m.slug || m.value || '').trim();
    if (!mid) continue;
    const maxOut = normalizeModelTokenLimit(m.maxOutputTokens);
    wizard.models.set(mid, {
      ...(m.group ? { group: String(m.group) } : {}),
      ...(m.description ? { description: String(m.description) } : {}),
      contextWindow: normalizeModelTokenLimit(m.contextWindow ?? m.maxContextTokens),
      ...(maxOut ? { maxOutputTokens: maxOut } : {}),
      ...(Array.isArray(m.efforts) ? { efforts: m.efforts.map(String) } : {}),
      ...(m.defaultEffort ? { defaultEffort: String(m.defaultEffort) } : {}),
      ...(m.isDefault !== undefined ? { isDefault: Boolean(m.isDefault) } : {}),
    });
  }
}

export function openExtensionWizard(extId = '') {
  const backdrop = document.getElementById('ext-modal-backdrop');
  const titleEl = document.getElementById('ext-modal-title');
  const idEl = document.getElementById('ext-id');
  const nameEl = document.getElementById('ext-name');
  const protoEl = document.getElementById('ext-protocol');
  const envPolicyEl = document.getElementById('ext-env-policy');
  const enabledEl = document.getElementById('ext-enabled');
  const cmdEl = document.getElementById('ext-command');
  const argsEl = document.getElementById('ext-args');
  const modelsEl = document.getElementById('ext-models');
  const effortsEl = document.getElementById('ext-efforts');
  const envEl = document.getElementById('ext-env');
  const probeBox = document.getElementById('ext-probe-result');
  const removeBtn = document.getElementById('btn-ext-remove');
  if (!backdrop) return;

  if (protoEl && !protoEl.dataset.atProtoBound) {
    protoEl.dataset.atProtoBound = '1';
    protoEl.addEventListener('change', () => {
      const argsInput = document.getElementById('ext-args');
      if (!argsInput) return;
      const val = String(argsInput.value || '').trim();
      if (protoEl.value === 'zcode' && (!val || val === 'acp')) {
        argsInput.value = 'app-server --stdio';
      } else if (protoEl.value === 'acp' && (!val || val === 'app-server --stdio')) {
        argsInput.value = 'acp';
      }
    });
  }

  state.editingExtId = extId || '';
  const wizard = state.extensionWizard = { id: extId, models: new Map(), defaultModel: '' };
  const probeBtn = document.getElementById('btn-ext-probe');
  if (probeBtn) probeBtn.disabled = false;
  if (probeBox) {
    probeBox.hidden = true;
    probeBox.textContent = '';
  }

  const custom = state.customProviders.find((c) => c.id === extId);
  const tpl = state.extensionTemplates.find((t) => t.id === extId);
  const src = custom || tpl;

  if (src) {
    if (titleEl) titleEl.textContent = `配置扩展平台：${src.name || src.id}`;
    if (idEl) {
      idEl.value = src.id;
      idEl.readOnly = Boolean(custom || tpl);
    }
    if (nameEl) nameEl.value = src.name || src.id;
    if (protoEl) protoEl.value = normalizeWizardExtProtocol(src.protocol, src.driverKind);
    if (envPolicyEl) envPolicyEl.value = src.envPolicy === 'minimal' ? 'minimal' : 'inherit';
    if (enabledEl) enabledEl.checked = custom ? custom.enabled !== false : true;
    if (cmdEl) cmdEl.value = src.command || src.id;
    if (argsEl) argsEl.value = src.argsTemplate || (Array.isArray(src.args) ? src.args.join(' ') : '');
    const mList = src.models || src.defaultModels || [];
    cacheWizardModelMeta(wizard, extId, mList, src.defaultModel);
    if (modelsEl) {
      modelsEl.value = mList.map(m => {
        const id = m.id || m.slug;
        return m.name && m.name !== id ? `${id} | ${m.name}` : id;
      }).join('\n');
    }
    if (effortsEl) effortsEl.value = (src.efforts || ['low', 'medium', 'high']).join(', ');
    if (envEl) envEl.value = Array.isArray(src.envKeys) && src.envKeys.length ? src.envKeys.map((k) => `${k}=`).join('\n') : '';
    if (removeBtn) removeBtn.hidden = !custom;
  } else {
    if (titleEl) titleEl.textContent = '接入自定义 Agent 引擎（ACP / ZCode / CLI）';
    if (idEl) {
      idEl.value = '';
      idEl.readOnly = false;
    }
    if (nameEl) nameEl.value = '';
    if (protoEl) protoEl.value = 'acp';
    if (envPolicyEl) envPolicyEl.value = 'inherit';
    if (enabledEl) enabledEl.checked = true;
    if (cmdEl) cmdEl.value = '';
    if (argsEl) argsEl.value = 'acp';
    if (modelsEl) modelsEl.value = 'default | 默认旗舰模型';
    if (effortsEl) effortsEl.value = 'low, medium, high';
    if (envEl) envEl.value = '';
    if (removeBtn) removeBtn.hidden = true;
  }

  backdrop.hidden = false;
}

export async function probeWizardExtension() {
  const idEl = document.getElementById('ext-id');
  const id = idEl?.value.trim() || '';
  const wizard = state.extensionWizard;
  const isCurrent = () => state.extensionWizard === wizard && idEl?.value.trim() === id;
  const protocol = normalizeWizardExtProtocol(document.getElementById('ext-protocol')?.value);
  const envPolicy = document.getElementById('ext-env-policy')?.value === 'minimal' ? 'minimal' : 'inherit';
  const command = document.getElementById('ext-command')?.value.trim() || '';
  const argsRaw = document.getElementById('ext-args')?.value.trim() || '';
  const envObj = parseEnvInput(document.getElementById('ext-env')?.value || '');
  const probeBox = document.getElementById('ext-probe-result');
  const modelsEl = document.getElementById('ext-models');
  const effortsEl = document.getElementById('ext-efforts');
  const probeBtn = document.getElementById('btn-ext-probe');

  if (!command) {
    showToast('请先填写可执行命令或路径', 'error');
    return;
  }
  if (probeBtn) probeBtn.disabled = true;
  if (probeBox) {
    probeBox.hidden = false;
    probeBox.textContent = `正在启动 ${command} 执行 ${protocol.toUpperCase()} 协议握手探测...`;
  }

  try {
    const res = await rpcCall('probeExtensionProvider', {
      id: id || 'probe-agent',
      protocol,
      driverKind: wizardExtDriverKind(protocol),
      envPolicy,
      command,
      args: parseArgsInput(argsRaw),
      argsTemplate: protocol === 'cli' ? argsRaw : undefined,
      env: envObj,
      cwd: getEffectiveCwd() || undefined,
      force: true,
    });

    if (!isCurrent()) return;
    const ok = res?.ok !== false && res?.reachable !== false && res?.available !== false && !res?.error;
    const models = Array.isArray(res?.models) ? res.models : [];
    if (ok && models.length > 0) {
      cacheWizardModelMeta(wizard, id, models, res?.defaultModel);
    }
    if (models.length > 0 && modelsEl) {
      modelsEl.value = models
        .map((m) => {
          if (typeof m === 'string') return m;
          const mid = m.id || m.slug || m.value || '';
          const mname = m.name || m.displayName || '';
          return mname && mname !== mid ? `${mid} | ${mname}` : mid;
        })
        .filter(Boolean)
        .join('\n');
    }
    if (Array.isArray(res?.efforts) && res.efforts.length > 0 && effortsEl) {
      effortsEl.value = res.efforts.join(', ');
    }
    const agentLabel = res?.agentInfo?.name
      ? `${res.agentInfo.name} ${res.agentInfo.version || ''}`
      : res?.binaryPath || command;
    if (probeBox) {
      if (ok) wizard.ephemeralSupport = { id, value: res.ephemeralSupport };
      probeBox.textContent = ok
        ? `✅ 握手探测成功！引擎: ${agentLabel}\n发现模型数: ${models.length}${models.length ? '（已自动填入下方模型列表）' : ''}`
        : `⚠️ 探测返回提示: ${res?.error || res?.message || '未检测到有效响应，请核对路径或参数'}`;
    }
    if (ok) showToast(`⚡ 握手成功，拉取到 ${models.length} 款模型`, 'success');
  } catch (err) {
    if (!isCurrent()) return;
    if (probeBox) probeBox.textContent = `❌ 握手探测失败: ${err.message}`;
    showToast(describeRpcError(err), 'error');
  } finally {
    if (probeBtn && state.extensionWizard === wizard) probeBtn.disabled = false;
  }
}

export async function saveWizardExtension() {
  const rawId = document.getElementById('ext-id')?.value.trim() || '';
  const id = rawId.replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  const name = document.getElementById('ext-name')?.value.trim() || id;
  const protocol = normalizeWizardExtProtocol(document.getElementById('ext-protocol')?.value);
  const envPolicy = document.getElementById('ext-env-policy')?.value === 'minimal' ? 'minimal' : 'inherit';
  const enabled = Boolean(document.getElementById('ext-enabled')?.checked);
  const command = document.getElementById('ext-command')?.value.trim() || '';
  const argsRaw = document.getElementById('ext-args')?.value.trim() || '';
  const efforts = String(document.getElementById('ext-efforts')?.value || 'low, medium, high')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const effectiveEfforts = efforts.length > 0 ? efforts : ['low', 'medium', 'high'];
  const parsedModels = parseModelsTextarea(document.getElementById('ext-models')?.value || '', effectiveEfforts);
  const wizard = state.extensionWizard;
  const sameProvider = wizard?.id === rawId;
  const models = parsedModels.map((m) => {
    const meta = sameProvider && wizard.models.get(m.id);
    if (!meta) return m;
    return {
      ...meta,
      id: m.id,
      name: m.name,
      efforts: meta.efforts ?? m.efforts,
    };
  });
  const defaultModel = sameProvider && models.some((m) => m.id === wizard.defaultModel)
    ? wizard.defaultModel
    : undefined;
  const env = parseEnvInput(document.getElementById('ext-env')?.value || '');

  if (!id || !command) {
    showToast('平台标识 ID 与可执行命令不能为空', 'error');
    return;
  }

  try {
    const saved = await rpcCall('saveExtensionProvider', {
      id,
      name,
      displayName: name,
      protocol,
      driverKind: wizardExtDriverKind(protocol),
      envPolicy,
      command,
      args: parseArgsInput(argsRaw),
      argsTemplate: protocol === 'cli' ? argsRaw : undefined,
      models,
      ...(defaultModel ? { defaultModel } : {}),
      ...(wizard?.ephemeralSupport?.id === rawId ? { ephemeralSupport: wizard.ephemeralSupport.value } : {}),
      efforts: effectiveEfforts,
      env: Object.keys(env).length > 0 ? env : undefined,
      enabled,
    });
    if (state.extensionWizard === wizard) document.getElementById('ext-modal-backdrop').hidden = true;
    await refreshExtensionProviders(true);
    if (saved?.providers) {
      state.providers = normalizeProvidersCatalog(saved.providers, state.customProviders);
    }
    syncComposerSelects();
    scheduleRender();
    showToast(`🧩 扩展平台「${name}」已保存，可直接在控制台及调度面板选用`, 'success');
  } catch (err) {
    showToast(describeRpcError(err), 'error');
  }
}

export function openDispatchDrawer(mode = 'single', presetKey = '') {
  if (!ensureDispatchAllowedInteractive()) return;
  const backdrop = document.getElementById('dispatch-drawer-backdrop');
  if (!backdrop) return;
  state.dispatchMode = mode;
  if (presetKey) state.selectedPresetChip = presetKey;
  if (!isPresetInActivePool(state.selectedPresetChip)) state.selectedPresetChip = activeDispatchFallbackKey();

  const cwdEl = document.getElementById('disp-cwd');
  if (cwdEl) cwdEl.value = getEffectiveCwd();
  const ephChk = document.getElementById('disp-ephemeral-chk');
  if (ephChk) ephChk.checked = false;

  renderDispatchPresetChips();
  applyPresetToDispatchForm(state.selectedPresetChip);
  renderDispatchDrawerMode();
  if (mode === 'batch' && state.batchDrafts.length === 0) fillBatchTemplate('council');
  else syncBoundDraftsWithPresets();
  renderBatchDraftRows();
  bindNativeHintRefresh('dispatch-drawer-backdrop');
  syncNativeDispatchHints();
  backdrop.hidden = false;
}

export function renderDispatchDrawerMode() {
  document.querySelectorAll('#dispatch-mode-tabs .seg-mini-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.dmode === state.dispatchMode);
  });
  const singlePane = document.getElementById('dispatch-single-pane');
  const batchPane = document.getElementById('dispatch-batch-pane');
  const roleWrap = document.getElementById('disp-role-wrap');
  const chipsWrap = document.getElementById('dispatch-preset-chips-wrap');
  const titleEl = document.getElementById('dispatch-drawer-title');

  if (state.dispatchMode === 'batch') {
    if (singlePane) singlePane.hidden = true;
    if (batchPane) batchPane.hidden = false;
    if (titleEl) titleEl.textContent = '🚀 并发批量派发多 Agent 任务组';
  } else {
    if (singlePane) singlePane.hidden = false;
    if (batchPane) batchPane.hidden = true;
    if (roleWrap) roleWrap.hidden = state.dispatchMode === 'thread';
    if (chipsWrap) chipsWrap.hidden = state.dispatchMode === 'thread';
    if (titleEl) titleEl.textContent = state.dispatchMode === 'thread' ? '新建顶层交互会话' : '派发异步子 Agent 任务';
  }
  syncNativeDispatchHints();
}

/** 派发默认成员：当前模式阵容执行组首选 ★，其次阵容内首位成员，再次执行组 / 任意首个成员，全部删光时为空键。 */
function activeDispatchFallbackKey() {
  return preferredGroupPreset('executor')?.key || listDispatchablePresets()[0]?.key || fallbackGroupPreset('executor')?.key || '';
}

function renderDispatchPresetChips() {
  const box = document.getElementById('dispatch-preset-chips');
  if (!box) return;
  // 全界面严锁勾选池：只列当前对话模式阵容中有效启用的成员（简单模式仅执行官）
  box.innerHTML = listDispatchablePresets()
    .map(
      (p) =>
        `<button type="button" class="preset-chip-btn ${state.selectedPresetChip === p.key ? 'active' : ''}" data-preset-chip="${escapeHtml(p.key)}" title="${escapeHtml(p.label || p.key)}">${getRoleIcon(p.role, p.key)} ${escapeHtml(String(p.label || p.key).split(' ')[0])}</button>`
    )
    .join('');
}

export function applyPresetToDispatchForm(slotKey) {
  const key = isPresetInActivePool(slotKey) ? slotKey : activeDispatchFallbackKey();
  state.selectedPresetChip = key;
  state.dispatchPresetDetached = false;
  state.dispatchSelection.isolationCustomized = false;
  const cfg = state.presets[key] || fallbackGroupPreset('executor') || EMPTY_MEMBER_FALLBACK;
  state.dispatchSelection.provider = cfg.provider;
  state.dispatchSelection.model = cfg.model;
  state.dispatchSelection.effort = cfg.effort;
  // 预设自带同引擎档位：按同引擎语义归一（旧版通用值显示为原生等价档），不是跨引擎切换
  state.dispatchSelection.permissionMode = normalizePermissionForProvider(cfg.provider, cfg.permissionMode || cfg.runtimeMode);

  populateLinkedSelectTrio(
    document.getElementById('disp-provider'),
    document.getElementById('disp-model'),
    document.getElementById('disp-effort'),
    state.dispatchSelection
  );
  renderDispatchPermSelect();

  const roleEl = document.getElementById('disp-role');
  const isoEl = document.getElementById('disp-isolation');
  if (roleEl) roleEl.value = cfg.role || 'implementation';
  if (isoEl) isoEl.value = cfg.isolation || 'shared';
  renderDispatchPresetChips();
  syncNativeDispatchHints();
}

export function renderDispatchPermSelect() {
  const permEl = document.getElementById('disp-perm');
  state.dispatchSelection.permissionMode = normalizePermissionForProvider(state.dispatchSelection.provider, state.dispatchSelection.permissionMode);
  if (!permEl) return;
  permEl.innerHTML = buildPermissionOptionsHtml(state.dispatchSelection.provider, state.dispatchSelection.permissionMode);
  permEl.value = state.dispatchSelection.permissionMode;
  permEl.classList.toggle('is-danger', isDangerPermissionFor(state.dispatchSelection.provider, state.dispatchSelection.permissionMode));
  syncNativeDispatchHints();
}

/** 批量子任务草稿：只取成员的路由字段（不把显示名 / 组 / 启停等元数据混入派发参数）。 */
export function batchRowFromPreset(p, extra = {}) {
  const route = Object.fromEntries(PRESET_ROUTE_FIELDS.map((f) => [f, p[f]]));
  return { title: p.label || p.key, role: p.role || 'implementation', presetKey: p.key, ...route, customizedFields: {}, prompt: '', ...extra };
}

export function fillBatchTemplate(kind) {
  if (kind === 'council' && stageUnavailable('advisor')) return;
  if (kind === 'council') {
    // Same-topic blind review: reuse the user's draft verbatim for every advisor and never prefill a default angle;
    // an empty draft stays empty so submitDispatchDrawer's empty-task guard blocks the batch.
    const sharedTopic = document.getElementById('disp-prompt')?.value.trim() || document.getElementById('council-topic-input')?.value.trim() || '';
    state.batchDrafts = enabledAdvisors().map((p) => batchRowFromPreset(p, {
      title: `${p.label || p.key} · 方案评审`, role: p.role || 'design', prompt: sharedTopic, council: true,
    }));
  } else {
    state.batchDrafts = activeGroupMembers('executor').map((p) => batchRowFromPreset(p, {
      title: `${p.label || p.key} · 并行开发`, isolation: 'worktree', customizedFields: { isolation: true },
    }));
  }
  if (!state.batchDrafts.length) showToast(kind === 'council' ? '当前阵容尚未勾选军师，无法生成军师团模板' : '当前阵容尚未勾选执行官，无法生成并行开发模板', 'error');
  renderBatchDraftRows();
}

export function renderBatchDraftRows() {
  const box = document.getElementById('batch-rows-container');
  if (!box) return;
  box.innerHTML = state.batchDrafts
    .map(
      (d, idx) => `
      <div class="batch-task-card" data-batch-idx="${idx}">
        <div class="ps-head">
          <strong>子任务 #${idx + 1}</strong>
          <button type="button" class="ghost-xs-btn danger-txt" data-batch-remove="${idx}">移除</button>
        </div>
        <div class="form-row-2">
          <div class="form-group">
            <label class="form-label">子任务名称</label>
            <input type="text" class="text-input" data-b-field="title" data-b-idx="${idx}" value="${escapeHtml(d.title)}" />
          </div>
          <div class="form-group">
            <label class="form-label">目录隔离</label>
            <select class="text-select" data-b-field="isolation" data-b-idx="${idx}">
              <option value="worktree" ${d.isolation === 'worktree' ? 'selected' : ''}>独立 Worktree</option>
              <option value="shared" ${d.isolation === 'shared' ? 'selected' : ''}>共享工作区</option>
            </select>
          </div>
        </div>
        <div class="form-row-3">
          <div class="form-group">
            <label class="form-label">引擎</label>
            <select class="text-select" data-b-field="provider" data-b-idx="${idx}">${buildProviderOptionsHtml(d.provider)}</select>
          </div>
          <div class="form-group">
            <label class="form-label">模型</label>
            <select class="text-select" data-b-field="model" data-b-idx="${idx}">${buildModelOptionsHtml(d.provider, d.model)}</select>
          </div>
          <div class="form-group">
            <label class="form-label">思考强度</label>
            <select class="text-select" data-b-field="effort" data-b-idx="${idx}">${buildEffortOptionsHtml(d.provider, d.model, d.effort)}</select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">${d.council ? '军师共同议题（同步至本批军师）' : '专属指令 Prompt'}</label>
          <textarea class="text-area" rows="2" data-b-field="prompt" data-b-idx="${idx}" placeholder="输入子任务指令（军师团盲评请粘贴相同的用户原话）...">${escapeHtml(d.prompt)}</textarea>
        </div>
      </div>`
    )
    .join('');
  syncNativeDispatchHints();
}

export async function submitDispatchDrawer() {
  const epoch = state.conversationEpoch;
  try {
    if (state.dispatchMode === 'batch' && !state.batchDrafts.some(t => t.prompt.trim())) {
      showToast('请至少填写一条有效子任务 Prompt 指令', 'error');
      return;
    }
    if (!(await ensurePresetsReadyForDispatch()) || epoch !== state.conversationEpoch) return;
    const effectiveCwd = document.getElementById('disp-cwd')?.value.trim() || getEffectiveCwd();
    const ephemeral = Boolean(document.getElementById('disp-ephemeral-chk')?.checked);
    if (state.dispatchMode === 'batch') {
      const advisors = new Set(enabledAdvisors().map(p => p.key));
      const validTasks = state.batchDrafts.filter(t => t.prompt.trim() && (!t.council || advisors.has(t.presetKey)));
      if (validTasks.length === 0) {
        showToast('请填写任务议题，并确认模板成员仍在已勾选阵容中', 'error');
        return;
      }
      const batchRes = await rpcCall('delegateParallelBatch', {
        mode: 'async',
        ...(ephemeral ? { ephemeral: true } : {}),
        cwd: effectiveCwd || undefined,
        workspace: effectiveCwd || undefined,
        parentThreadId: state.selectedThreadId || undefined,

        tasks: validTasks.map((t) => {
          const prompt = t.council ? councilBrief(t.prompt.trim()) : t.prompt.trim();
          const tPerm = normalizePermissionForProvider(
            t.provider,
            t.permissionMode || t.runtimeMode || state.presets[t.presetKey]?.permissionMode
          );
          const tImode = t.interactionMode || deriveInteractionMode(tPerm);
          const route = presetDispatchRoute(t.presetKey, { ...t, permissionMode: tPerm }, { activePoolOnly: true });
          return {
            title: t.title || t.prompt.slice(0, 40),
            role: t.role || 'implementation',
            ...route,
            ...(route.presetKey ? {} : {
              effort: t.effort,
              permissionMode: tPerm,
              runtimeMode: tPerm,
              interactionMode: tImode,
            }),
            isolation: t.isolation,
            ...(ephemeral ? { ephemeral: true } : {}),
            task: prompt,
            prompt,
          };
        }),
      });
      // P1-5：派发闸门直出 → 保留抽屉与全部草稿，不清空任何输入
      if (epoch !== state.conversationEpoch) return;
      if (batchRes?.bypassed) {
        showDispatchBypassedToast(batchRes);
        return;
      }
      state.batchDrafts = [];
      delete document.getElementById('disp-cwd').dataset.atDraft;
      document.getElementById('dispatch-drawer-backdrop').hidden = true;
      setActiveView('board');
      // 混合批次：外部 CLI 成员已后台并发启动，宿主原生成员按 hostActions 投递主对话代派
      const relayedNative = await relayHostActions(batchRes);
      if (epoch !== state.conversationEpoch) return;
      await refreshThreadsList();
      if (epoch !== state.conversationEpoch) return;
      const externalCount = Math.max(0, validTasks.length - relayedNative);
      if (externalCount) showToast(`🚀 已并发派出 ${externalCount} 个子 Agent`, 'success');
      return;
    }

    const title = document.getElementById('disp-title')?.value.trim() || '';
    const role = document.getElementById('disp-role')?.value || 'implementation';
    const perm = normalizePermissionForProvider(state.dispatchSelection.provider, document.getElementById('disp-perm')?.value || state.dispatchSelection.permissionMode);
    const imode = deriveInteractionMode(perm);
    const isolation = document.getElementById('disp-isolation')?.value || 'shared';
    const prompt = document.getElementById('disp-prompt')?.value.trim() || '';

    if (!prompt) {
      showToast('请填写任务指令内容', 'error');
      return;
    }

    const singleRoute = presetDispatchRoute(state.selectedPresetChip, { ...state.dispatchSelection, permissionMode: perm }, { activePoolOnly: true });
    const explicitFields = singleRoute.presetKey ? {} : {
      effort: state.dispatchSelection.effort,
      permissionMode: perm,
      runtimeMode: perm,
      interactionMode: imode,
    };

    if (state.dispatchMode === 'thread') {
      const res = await rpcCall('launchThread', {
        title: title || prompt.slice(0, 44),
        message: prompt,
        prompt,
        role,
        ...singleRoute,
        ...explicitFields,
        isolation,
        workspaceStrategy: isolation === 'worktree' ? { type: 'worktree' } : { type: 'root' },
        ...(ephemeral ? { ephemeral: true } : {}),
        cwd: effectiveCwd || undefined,
        workspace: effectiveCwd || undefined,

      });
      if (epoch !== state.conversationEpoch) return;
      if (res?.bypassed) {
        showDispatchBypassedToast(res);
        return;
      }
      for (const id of ['disp-prompt','disp-title']) document.getElementById(id).value = '';
      delete document.getElementById('disp-cwd').dataset.atDraft;
      document.getElementById('dispatch-drawer-backdrop').hidden = true;
      document.getElementById('disp-prompt').value = '';
      const tid = String(res?.threadId || res?.thread?.id || res?.id || '');
      if (tid) state.selectedThreadId = tid;
      setActiveView('board');
      const relayedNative = await relayHostActions(res);
      if (epoch !== state.conversationEpoch) return;
      await refreshThreadsList();
      if (epoch !== state.conversationEpoch) return;
      if (!relayedNative) showToast('已创建并启动顶层会话', 'success');
    } else {
      const res = await rpcCall('delegateTask', {
        title: title || prompt.slice(0, 44),
        task: prompt,
        prompt,
        role,
        mode: 'async',
        isolation,
        ...(ephemeral ? { ephemeral: true } : {}),
        ...singleRoute,
        ...explicitFields,
        cwd: effectiveCwd || undefined,
        workspace: effectiveCwd || undefined,
        parentThreadId: state.selectedThreadId || undefined,

      });
      if (epoch !== state.conversationEpoch) return;
      if (res?.bypassed) {
        showDispatchBypassedToast(res);
        return;
      }
      for (const id of ['disp-prompt','disp-title']) document.getElementById(id).value = '';
      delete document.getElementById('disp-cwd').dataset.atDraft;
      document.getElementById('dispatch-drawer-backdrop').hidden = true;
      document.getElementById('disp-prompt').value = '';
      const childTid = String(res?.childThreadId || res?.threadId || res?.thread?.id || '');
      if (childTid) state.selectedThreadId = childTid;
      setActiveView('board');
      const relayedNative = await relayHostActions(res);
      if (epoch !== state.conversationEpoch) return;
      await refreshThreadsList();
      if (epoch !== state.conversationEpoch) return;
      if (!relayedNative) showToast('⚡ 子任务已委派启动', 'success');
    }
  } catch (err) {
    if (await relayLegacySwarmError(err)) return;
    showToast(describeRpcError(err), 'error');
  }
}

export function openRetryModal(threadId) {
  const t = state.threadsMap.get(threadId);
  if (!t) return;
  state.retryContext = { threadId, provider: t.provider, model: t.model, effort: t.effort };
  populateLinkedSelectTrio(
    document.getElementById('retry-provider'),
    document.getElementById('retry-model'),
    document.getElementById('retry-effort'),
    state.retryContext
  );
  document.getElementById('retry-modal-backdrop').hidden = false;
}

export async function executeRetry(threadId, overrideCfg = null) {
  if (!ensureDispatchAllowedInteractive()) return;
  if (!(await ensurePresetsReadyForDispatch())) return;
  const t = state.threadsMap.get(threadId);
  if (!t) return;
  try {
    const payload = { threadId };
    if (overrideCfg) {
      payload.provider = overrideCfg.provider;
      payload.model = overrideCfg.model;
      payload.effort = overrideCfg.effort;
    }
    const res = await rpcCall('retryRun', payload);
    if (res?.bypassed) {
      showDispatchBypassedToast(res);
      return;
    }
    if (overrideCfg) {
      t.provider = overrideCfg.provider;
      t.model = overrideCfg.model;
      t.effort = overrideCfg.effort;
    }
    t.status = 'running';
    t.error = '';
    t.startedAt = Date.now();
    recomputeScopedStats();
    scheduleRender();
    showToast('🔄 已重新发起执行', 'success');
  } catch (err) {
    showToast(describeRpcError(err), 'error');
  }
}

export function openCouncilModal() {
  if (!ensureDispatchAllowedInteractive()) return;
  if (stageUnavailable('advisor')) return;
  const backdrop = document.getElementById('council-modal-backdrop');
  if (!backdrop) return;
  const advisors = enabledAdvisors();
  const list = document.getElementById('council-members-list');
  if (list) {
    list.innerHTML = advisors.length
      ? advisors.map((p) => `<label class="council-member-box">
          <input type="checkbox" data-council-member="${escapeHtml(p.key)}" checked />
          <span class="council-member-main"><strong>${escapeHtml(p.label || p.key)}</strong>
          <span>${escapeHtml(formatProviderBadge(normalizeProviderId(p.provider)))} / ${escapeHtml(formatModelDisplay(p.model))} (${escapeHtml(formatEffortDisplay(p.effort))})</span></span>
        </label>`).join('')
      : '<p class="council-empty">复杂阵容军师阶段尚未勾选任何军师：请先到「配置 › 角色路由 › 复杂自定义阵容」勾选至少一名军师。</p>';
  }
  setText('council-dialog-note', '将向已勾选军师并发下发同一份原始诉求进行只读独立盲评（保持用户原意、零倾向注入，可取消勾选）：');
  const confirm = document.getElementById('btn-confirm-council');
  if (confirm) confirm.disabled = !advisors.length;
  bindNativeHintRefresh('council-modal-backdrop');
  syncNativeDispatchHints();
  backdrop.hidden = false;
}

export function closeCouncilModal() {
  const el = document.getElementById('council-modal-backdrop');
  if (el) el.hidden = true;
}

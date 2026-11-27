/**
 * AgentTower Studio — 自定义模型 ID 弹窗 (`ui/custom-model.js`)
 * 被 Composer、派发抽屉、重试、代码终审与角色预设共用；通过 onApply / onCancel 回调回写调用方。
 */
import { CUSTOM_MODEL_PROMPT_VALUE, ROUTER_DEFAULT_MODEL, state } from './state.js';
import { showToast } from './net.js';
import { isAllowedAgySubagentModel, normalizeProviderId } from './normalize.js';
import { formatProviderBadge } from './widgets.js';

export function openCustomModelModal({ providerId, previousModel, onApply, onCancel }) {
  const backdrop = document.getElementById('custom-model-modal-backdrop');
  const input = document.getElementById('custom-model-id-input');
  const hint = document.getElementById('custom-model-hint');
  if (!backdrop || !input) return;

  state.customModelPrompt = { providerId, previousModel, onApply, onCancel };
  if (hint) {
    hint.textContent = `当前引擎：${formatProviderBadge(providerId)}（请输入完整模型 ID，确认后将写入并保持选中）。`;
  }
  const seed =
    previousModel && previousModel !== ROUTER_DEFAULT_MODEL && previousModel !== CUSTOM_MODEL_PROMPT_VALUE
      ? previousModel
      : '';
  input.value = seed;
  backdrop.hidden = false;
  setTimeout(() => {
    input.focus();
    input.select?.();
  }, 10);
}

export function cancelCustomModelModal() {
  const ctx = state.customModelPrompt;
  state.customModelPrompt = null;
  const backdrop = document.getElementById('custom-model-modal-backdrop');
  if (backdrop) backdrop.hidden = true;
  ctx?.onCancel?.(ctx.previousModel);
}

export function confirmCustomModelModal() {
  const ctx = state.customModelPrompt;
  const input = document.getElementById('custom-model-id-input');
  const val = String(input?.value || '').trim();
  if (!val) {
    showToast('请输入有效的自定义模型 ID', 'error');
    input?.focus();
    return;
  }
  if (val === CUSTOM_MODEL_PROMPT_VALUE) {
    showToast('请输入具体的模型标识符', 'error');
    input?.focus();
    return;
  }
  if (ctx && normalizeProviderId(ctx.providerId) === 'antigravity' && !isAllowedAgySubagentModel(val)) {
    showToast('Antigravity 子 Agent 只支持 Gemini 和 Google Orchestrator。', 'error');
    return;
  }
  state.customModelPrompt = null;
  const backdrop = document.getElementById('custom-model-modal-backdrop');
  if (backdrop) backdrop.hidden = true;
  ctx?.onApply?.(val);
}

export function handleModelSelectChange(selectEl, targetObj, onCommit, onCancel) {
  if (!selectEl || !targetObj) return;
  if (selectEl.value === CUSTOM_MODEL_PROMPT_VALUE) {
    const prevModel = targetObj.model;
    openCustomModelModal({
      providerId: targetObj.provider,
      previousModel: prevModel,
      onApply: (customId) => {
        targetObj.model = customId;
        onCommit?.(customId);
      },
      onCancel: () => {
        onCancel?.(prevModel);
      },
    });
    return;
  }
  targetObj.model = selectEl.value;
  onCommit?.(selectEl.value);
}

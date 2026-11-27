/**
 * AgentTower Studio — 跨视图共享的展示标签与小组件 (`ui/widgets.js`)
 * 引擎色标 / 简称、模型与思考档位展示、健康徽标、中断按钮文案与待批请求卡片等纯 HTML 片段。
 */
import { escapeHtml, formatDurationMs, formatTimeShort, shortenModelName } from './format.js';
import { INHERIT_EFFORT, ROLE_ROW_TITLES, ROLE_SLOT_META, ROUTER_DEFAULT_MODEL, isStatusActive, state } from './state.js';
import { normalizeInjectedSpecs, normalizeProviderId, threadCancelCapability } from './normalize.js';

export function renderThreadHealthBadgeHtml(t) {
  const h = t?.meta?.health;
  if (!h || !h.state || h.state === 'healthy') return '';
  if (h.incidentId && state.dismissedIncidentIds.has(String(h.incidentId))) return '';
  if (h.state === 'suspected_stall') {
    return `<span class="health-mini-badge warn" title="${escapeHtml(h.detail || '长时间未收到引擎事件')}">⚠ 疑似卡顿</span>`;
  }
  if (h.state === 'retrying' || h.state === 'transient_retry') {
    return `<span class="health-mini-badge info" title="${escapeHtml(h.detail || '瞬时限流退避自愈中')}">↻ 限流自愈</span>`;
  }
  if (h.state === 'doom_loop') {
    return `<span class="health-mini-badge err" title="${escapeHtml(h.detail || '连续同指纹失败已熔断')}">⛔ 死循环熔断</span>`;
  }
  if (h.state === 'stall_terminated') {
    return `<span class="health-mini-badge err" title="${escapeHtml(h.detail || '无响应超时已自动终止')}">⛔ 超时终止</span>`;
  }
  if (h.state === 'quota_exhausted') {
    return `<span class="health-mini-badge err" title="${escapeHtml(h.detail || '引擎额度已耗尽')}">⛔ 额度耗尽</span>`;
  }
  return '';
}

/** 中断按钮文案：按 cancelCapability 与两阶段状态统一生成（成员行 / 抽屉 / 底栏共用）。 */
export function cancelButtonLabel(t, { long = false } = {}) {
  const capability = threadCancelCapability(t);
  if (capability === 'reconcilable_orphan') return long ? '⟲ 收割失联运行态' : '⟲ 收割失联';
  if (state.cancelInFlight.has(t.id)) return '中断中...';
  const trk = state.interruptTracker.get(t.id);
  if (trk?.escalated) return '⚡ 强制终止';
  if (trk) return '中断中...';
  return long ? '■ 中断执行' : '■ 中断';
}

export function engClass(pid) {
  const id = normalizeProviderId(pid);
  return ['kimi-code', 'codex', 'claude-code', 'antigravity'].includes(id) ? id : 'ext-provider';
}
export function engineShortName(pid) {
  const id = normalizeProviderId(pid);
  if (id === 'kimi-code') return 'Kimi';
  if (id === 'codex') return 'Codex';
  if (id === 'claude-code') return 'Claude';
  if (id === 'antigravity') return 'Antigravity';
  const found = state.providers.find((p) => p.id === id);
  return found ? found.name.replace(/\s*\(.*\)$/, '') : id;
}
export function stripLeadingIcon(label) {
  return String(label || '').replace(/^[\p{Extended_Pictographic}\u{FE0F}\u{200D}\s]+/u, '');
}
export function formatCtx(tokens) {
  const n = Number(tokens || 0);
  if (!n) return '';
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M`;
  return `${Math.round(n / 1000)}K`;
}
export function roleTitle(key) {
  return ROLE_ROW_TITLES[key] || state.presets[key]?.label || ROLE_SLOT_META.find((s) => s.key === key)?.label || key;
}

/** 线程最新一轮运行（优先当前 activeRunId，其次最新创建时间）。 */
function latestThreadRun(t) {
  const runs = Array.isArray(t?.recentRuns) ? t.recentRuns.filter(Boolean) : [];
  if (!runs.length) return null;
  return runs.find((r) => r.id && r.id === t.activeRunId) ||
    runs.reduce((best, r) => (Number(r.createdAt || r.startedAt || 0) >= Number(best.createdAt || best.startedAt || 0) ? r : best), runs[0]);
}
/** v0.1.0 模式徽标：本轮临时点将（非直出模式点名停用成员）/ 主会话代审（评审组全停用降级）。 */
export function renderThreadModeBadgesHtml(t) {
  if (!t) return '';
  const run = latestThreadRun(t);
  const metas = [t.meta, run?.meta, run].filter((m) => m && typeof m === 'object');
  const temporary = metas.some((m) => m.temporaryOverride === true);
  const degraded = metas.some((m) => m.degradedReview === true);
  return (temporary ? '<span class="mode-mini-badge is-override" title="该成员已在成员池停用，本轮由对话点名临时调用">本轮临时点将</span>' : '') +
    (degraded ? '<span class="mode-mini-badge is-degraded" title="评审组已全部停用，经确认由主会话代为终审">主会话代审</span>' : '');
}

/* ---------- v0.2.0 项目规范（Spec）注入徽标：看板用户派单卡片 + 成员详情抽屉用户消息气泡共用 ---------- */
export const SPEC_KIND_LABELS = { business: '业务', coding: '编码', plugin: '插件底线' };
// 投递层级 / 命中原因同时兼容契约文案与后端实际枚举（pointer_degraded / diff_path / text_path / tag / role）
export const SPEC_TIER_LABELS = { inline: '全文内联', summary: '摘要指引', reused: '会话沿用', pointer_degraded: '超限降级指引', degraded: '超限降级指引', skipped: '预算略过', budget_skipped: '预算略过' };
export const SPEC_REASON_LABELS = { explicit: '点名', target_path: '目标路径', diff_path: '评审改动', review_diff: '评审改动', text_path: '目标路径', tag: '关键词', keyword: '关键词', role: '角色底线', role_baseline: '角色底线' };
export const SPEC_WARNING_LABELS = { REQUIRED_BUDGET_DEGRADED: '必读规范超限降级', SPEC_NOT_FOUND: '点名规范不存在', PARSE_ERROR: '规范头解析失败', KIND_MISMATCH: '分类与目录不一致', DUPLICATE_SPEC_ID: '规范 ID 重复', INVALID_SPEC_ID: '规范 ID 非法', UNSAFE_SPEC_PATH: '规范路径不安全', INVALID_TARGET_PATH: '目标路径非法', SPEC_GIT_UNAVAILABLE: 'Git 不可用，改动匹配跳过' };

export function formatSpecBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 用户消息条目的注入回执：优先 item.meta.injectedSpecs，其次同 runId 的 run.meta.injectedSpecs；无噪音时返回 null。 */
export function resolveInjectedSpecs(item, thread) {
  const own = item?.meta?.injectedSpecs;
  if (own) return normalizeInjectedSpecs(own);
  if (item?.meta?.live) return null; // Live steer shares a runId but sends only the user text.
  const runId = item?.runId;
  const run = runId && Array.isArray(thread?.recentRuns) ? thread.recentRuns.find((r) => r && r.id === runId) : null;
  return normalizeInjectedSpecs(run?.meta?.injectedSpecs);
}

function renderSpecItemRowHtml(it) {
  const kind = SPEC_KIND_LABELS[it.kind] || it.kind || '规范';
  const tier = SPEC_TIER_LABELS[it.tier] || it.tier || '';
  const reason = SPEC_REASON_LABELS[it.reason] || it.reason || '';
  const name = it.title || it.id || it.key || '未命名规范';
  const degraded = it.tier === 'pointer_degraded' || it.tier === 'degraded';
  return `<li class="spec-inject-row${degraded ? ' is-danger' : ''}" title="${escapeHtml(it.relPath || it.key)}">
      <span class="spec-kind-tag" data-kind="${escapeHtml(it.kind)}">${escapeHtml(kind)}</span>
      <span class="spec-inject-name">${escapeHtml(name)}</span>
      ${it.required ? '<span class="spec-req-tag">必读</span>' : ''}
      ${tier ? `<span class="spec-tier-tag${degraded ? ' is-danger' : it.tier === 'reused' ? ' is-soft' : ''}">${escapeHtml(tier)}</span>` : ''}
      ${reason ? `<span class="spec-meta-faint">${escapeHtml(reason)}</span>` : ''}
      <span class="spec-meta-faint">${escapeHtml(formatSpecBytes(it.bytes))}</span>
    </li>`;
}

/**
 * 注入徽标 + 原位折叠明细。`key` 为展开态键（state.expandedSpecBadges）；明细节点恒渲染、以 hidden 控制，
 * 便于事件层原位切换而不整块重绘（保持键盘焦点）。
 */
export function renderSpecBadgeHtml(spec, key) {
  if (!spec) return '';
  const danger = spec.degradedRequiredCount > 0 || spec.warnings.length > 0;
  let label;
  let tone = '';
  if (spec.deliveredCount > 0) {
    label = `Spec ×${spec.deliveredCount}${spec.reusedCount > 0 ? ` · 沿用 ${spec.reusedCount}` : ''}`;
  } else if (spec.reusedCount > 0) {
    label = `Spec 沿用 ×${spec.reusedCount}`;
    tone = ' is-soft';
  } else {
    label = `Spec 告警 ×${spec.warnings.length}`;
  }
  if (danger) {
    label = `⚠ ${label}`;
    tone = ' is-danger';
  }
  const open = state.expandedSpecBadges.has(key);
  const panelId = `spec-panel-${String(key).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  const tip = spec.deliveredCount > 0
    ? `本轮向子 Agent 注入 ${spec.deliveredCount} 条项目规范（全文 ${spec.inlineCount} · 摘要 ${spec.summaryCount}${spec.reusedCount ? ` · 沿用 ${spec.reusedCount}` : ''}）`
    : spec.reusedCount > 0
    ? `本轮未重发规范 Token，直接沿用原生会话上下文中的 ${spec.reusedCount} 条规范`
    : '本轮规范注入存在告警';
  const warnHtml = spec.warnings.length
    ? `<ul class="spec-warn-list" role="alert">${spec.warnings.map((w) => `<li><strong>${escapeHtml(SPEC_WARNING_LABELS[w.code] || w.code || '告警')}</strong>${w.key ? ` <code>${escapeHtml(w.key)}</code>` : ''}${w.message ? `：${escapeHtml(w.message)}` : ''}</li>`).join('')}</ul>`
    : '';
  const rowsHtml = spec.items.length
    ? `<ul class="spec-inject-list">${spec.items.map(renderSpecItemRowHtml).join('')}</ul>`
    : '<p class="spec-inject-empty">本轮无逐条明细</p>';
  const foot = spec.pluginDelivered ? '<p class="spec-inject-foot">已附带插件角色底线</p>' : '';
  return `<div class="spec-inject">
      <button type="button" class="spec-badge${tone}" data-spec-toggle="${escapeHtml(key)}" aria-expanded="${open}" aria-controls="${escapeHtml(panelId)}" title="${escapeHtml(tip)}">${escapeHtml(label)}<span class="spec-caret" aria-hidden="true">${open ? '▾' : '▸'}</span></button>
      <div class="spec-inject-panel${danger ? ' is-danger' : ''}" id="${escapeHtml(panelId)}"${open ? '' : ' hidden'}>${warnHtml}${rowsHtml}${foot}</div>
    </div>`;
}

export function setTimelineHtml(root, html) {
  const focused = document.activeElement;
  const key = focused?.dataset?.specToggle;
  const restore = key && root.contains(focused);
  root.innerHTML = html;
  if (restore && !focused.isConnected) {
    root.querySelector(`[data-spec-toggle="${CSS.escape(key)}"]`)?.focus({ preventScroll: true });
  }
}

/** 事件层原位切换徽标展开态（不触发整块重绘，焦点保留在按钮上）。 */
export function toggleSpecBadge(btn) {
  const key = btn?.dataset?.specToggle;
  if (!key) return false;
  const open = !state.expandedSpecBadges.has(key);
  if (open) state.expandedSpecBadges.add(key);
  else state.expandedSpecBadges.delete(key);
  btn.setAttribute('aria-expanded', String(open));
  const caret = btn.querySelector('.spec-caret');
  if (caret) caret.textContent = open ? '▾' : '▸';
  const panel = btn.parentElement?.querySelector('.spec-inject-panel');
  if (panel) panel.hidden = !open;
  return true;
}
export function renderRuntimeRequestCard(req) {
  const thread = state.threadsMap.get(req.threadId);
  const threadLabel = thread ? thread.title : req.threadId || '子 Agent';

  if (req.kind === 'question') {
    const qList = req.questions && req.questions.length ? req.questions : [{ question: req.title, options: req.options, multiSelect: req.multiSelect }];
    const firstQ = qList[0] || {};
    const opts = Array.isArray(firstQ.options) ? firstQ.options : req.options || [];
    const inputType = firstQ.multiSelect || req.multiSelect ? 'checkbox' : 'radio';

    return `
        <div class="request-card" data-req-id="${escapeHtml(req.id)}">
          <div class="req-header">
            <span>❓ 待补充决策 · ${escapeHtml(threadLabel)}</span>
            <span style="font-size:11px;font-weight:400;">${formatTimeShort(req.createdAt)}</span>
          </div>
          <div style="font-size:12.5px;">${escapeHtml(firstQ.question || req.title)}</div>
          <div class="question-options-list">
            ${opts
            .map((opt, idx) => {
              const label = typeof opt === 'string' ? opt : opt.label || opt.value || opt.text || `选项 ${idx + 1}`;
              const val = typeof opt === 'string' ? opt : opt.value ?? opt.label ?? label;
              return `<label class="q-opt-label"><input type="${inputType}" name="qopt_${escapeHtml(req.id)}" value="${escapeHtml(String(val))}" /><span>${escapeHtml(label)}</span></label>`;
            })
            .join('')}
          </div>
          <div style="display:flex;gap:6px;">
            <input type="text" class="text-input req-free-input" data-req-input="${escapeHtml(req.id)}" placeholder="或直接输入补充说明..." />
            <button type="button" class="hdr-primary-btn" data-req-action="answer" data-req-id="${escapeHtml(req.id)}">提交回复</button>
          </div>
        </div>
      `;
  }

  return `
      <div class="request-card" data-req-id="${escapeHtml(req.id)}">
        <div class="req-header">
          <span>⚠️ 敏感操作审批 · ${escapeHtml(threadLabel)}</span>
          <span style="font-size:11px;font-weight:400;">${formatTimeShort(req.createdAt)}</span>
        </div>
        <div style="font-size:12.5px;">${escapeHtml(req.title)}</div>
        ${req.preview ? `<pre class="req-preview">${escapeHtml(req.preview)}</pre>` : ''}
        <div class="req-btn-row">
          <button type="button" class="hdr-primary-btn" data-req-action="approve_once" data-req-id="${escapeHtml(req.id)}">✓ 批准本次</button>
          <button type="button" class="ghost-xs-btn" data-req-action="approve_session" data-req-id="${escapeHtml(req.id)}">✓✓ 本会话自动放行</button>
          <button type="button" class="ghost-xs-btn danger-txt" data-req-action="reject" data-req-id="${escapeHtml(req.id)}">✗ 拒绝并打回</button>
        </div>
      </div>
    `;
}

export function formatProviderBadge(pid) {
  if (pid === 'kimi-code') return 'Kimi';
  if (pid === 'codex') return 'Codex';
  if (pid === 'antigravity') return '宿主原生';
  const found = state.providers.find((p) => p.id === pid);
  return found ? found.name.replace(/\s*\(.*\)$/, '') : pid;
}

export function getRoleIcon(role, presetKey = '') {
  const group = state.presets[presetKey]?.group;
  if (group === 'advisor' || presetKey.startsWith('advisor') || role === 'design' || role === 'research') return '🧠';
  if (group === 'reviewer' || presetKey === 'reviewer' || role === 'review') return '🔍';
  if (role === 'test') return '🧪';
  return '⚡';
}

export function formatModelDisplay(modelId, effectiveModel = '', modelDisplayName = '') {
  const rawId = String(modelId || '');
  if (rawId === ROUTER_DEFAULT_MODEL) {
    return effectiveModel ? `跟随默认 (${shortenModelName(effectiveModel)})` : '跟随默认';
  }
  const label = String(modelDisplayName || rawId);
  return label ? shortenModelName(label) : '';
}

export function formatEffortDisplay(effort, effectiveEffort = '') {
  const e = String(effort || '');
  if (e === INHERIT_EFFORT) {
    return effectiveEffort ? `默认思考 (${effectiveEffort})` : '默认思考';
  }
  return e;
}

export function formatThreadElapsed(t) {
  if (!t) return '0.0s';
  if (isStatusActive(t.status)) return formatDurationMs(Date.now() - (t.startedAt || t.createdAt));
  if (t.durationMs > 0) return formatDurationMs(t.durationMs);
  if (t.completedAt && t.startedAt) return formatDurationMs(t.completedAt - t.startedAt);
  return '—';
}

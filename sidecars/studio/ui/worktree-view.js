/**
 * AgentTower Studio — Worktree 与 Diff 视图 (`ui/worktree-view.js`)
 * Diff 请求以递增序号防乱序；合入 / 清理均需二次确认。
 */
import { escapeHtml, parseUnifiedDiffIntoFiles, renderUnifiedDiffHtml, shortenPath } from './format.js';
import { getEffectiveConversationId, getEffectiveCwd, getScopedWorktrees, state } from './state.js';
import { scheduleRender } from './render.js';
import { armOrConfirm, rpcCall, showToast } from './net.js';
import { normalizeWorktree } from './normalize.js';
import { removeLocalWorktreeByPath } from './stream.js';

export async function refreshWorktreesList() {
  try {
    const convId = getEffectiveConversationId();
    if (!convId) return;
    const epoch = state.conversationEpoch;
    const res = await rpcCall('listWorktrees', { conversationId: convId || undefined });
    if (epoch !== state.conversationEpoch || convId !== getEffectiveConversationId()) return;
    const list = Array.isArray(res) ? res : res?.worktrees || [];
    state.worktrees = list.map((w, i) => normalizeWorktree(w, i)).filter(Boolean);
    const scopedWt = getScopedWorktrees();
    if (scopedWt.length > 0 && (!state.selectedWorktreeId || !scopedWt.some((w) => w.id === state.selectedWorktreeId))) {
      await selectWorktree(scopedWt[0].id);
    } else if (state.selectedWorktreeId && scopedWt.some((w) => w.id === state.selectedWorktreeId)) {
      await loadSelectedWorktreeDiff();
    } else {
      state.selectedWorktreeId = '';
      state.currentWorktreeDiff = null;
    }
    scheduleRender();
  } catch {}
}

export async function selectWorktree(wtId) {
  state.selectedWorktreeId = wtId;
  state.selectedDiffFile = '';
  await loadSelectedWorktreeDiff();
  scheduleRender();
}

// P2-2：递增请求序号；切换 Worktree / 模式时旧请求的迟到响应一律丢弃，杜绝乱序覆盖
export async function loadSelectedWorktreeDiff() {
  const seq = ++state.worktreeDiffSeq;
  const wt = getScopedWorktrees().find((w) => w.id === state.selectedWorktreeId);
  if (!wt) {
    state.currentWorktreeDiff = null;
    state.loadingDiff = false;
    return;
  }
  const mode = state.diffMode || 'working_tree';
  state.loadingDiff = true;
  scheduleRender();
  try {
    const res = await rpcCall('getWorktreeDiff', {
      worktreeId: wt.id,
      threadId: wt.threadId || undefined,
      worktreePath: wt.path || undefined,
      path: wt.path || undefined,
      mode,
    });
    if (seq !== state.worktreeDiffSeq || state.selectedWorktreeId !== wt.id) return;
    const files = Array.isArray(res?.files) ? res.files : [];
    state.currentWorktreeDiff = {
      files,
      diff: String(res?.diff ?? res?.patch ?? res?.unifiedDiff ?? ''),
      branch: res?.branch || wt.branch,
    };
    if (mode === 'working_tree') {
      wt.additions = files.reduce((sum, file) => sum + Number(file?.additions || 0), 0);
      wt.deletions = files.reduce((sum, file) => sum + Number(file?.deletions || 0), 0);
      wt.filesCount = files.length;
    }
  } catch (err) {
    if (seq !== state.worktreeDiffSeq || state.selectedWorktreeId !== wt.id) return;
    state.currentWorktreeDiff = { files: [], diff: '', error: err.message };
  } finally {
    if (seq === state.worktreeDiffSeq) {
      state.loadingDiff = false;
      scheduleRender();
    }
  }
}

const WORKTREE_INTEGRATE_LABELS = { apply_unstaged: '应用补丁到主工作区', squash: 'Squash 合并到主分支' };
function worktreeIntegrateConfirmKey(wt, strategy) {
  return `wt-int:${wt.id}:${strategy}`;
}

export async function handleIntegrateWorktree(strategy) {
  const wt = getScopedWorktrees().find((w) => w.id === state.selectedWorktreeId);
  if (!wt) return;
  const label = WORKTREE_INTEGRATE_LABELS[strategy] || strategy;
  // P1-3：合入会改写主工作区 / 主分支，一律二次确认
  if (!armOrConfirm(worktreeIntegrateConfirmKey(wt, strategy), `请再次点击确认「${label}」（分支 ${wt.branch}）`)) return;
  const cwd = wt.projectRoot || getEffectiveCwd();
  try {
    const res = await rpcCall('integrateWorktree', {
      worktreeId: wt.id,
      threadId: wt.threadId || undefined,
      worktreePath: wt.path || undefined,
      strategy,
      workspace: cwd || undefined,
      cwd: cwd || undefined,
      cleanupAfter: false,
    });
    if (res?.cleanupError) {
      const detail = typeof res.cleanupError === 'string' ? res.cleanupError : res.cleanupError?.message || '未知错误';
      showToast(`已完成「${label}」，但清理 Worktree 失败：${detail}`, 'error');
    } else {
      showToast(`✓ 已成功执行「${label}」${res?.noChanges ? '（无改动可合入）' : ''}`, 'success');
    }
    await refreshWorktreesList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

export async function handleCleanupWorktree() {
  const wt = getScopedWorktrees().find((w) => w.id === state.selectedWorktreeId);
  if (!wt) return;
  const isDirtyForce = Boolean(wt.dirty);
  if (!armOrConfirm(`wt:${wt.id}:${isDirtyForce ? 'force' : 'clean'}`, `${isDirtyForce ? '该隔离分支仍有未提交改动！' : ''}请再次点击确认安全清理 Worktree「${wt.branch}」`)) {
    return;
  }
  const cwd = wt.projectRoot || getEffectiveCwd();
  try {
    await rpcCall('cleanupWorktree', {
      worktreeId: wt.id,
      threadId: wt.threadId || undefined,
      worktreePath: wt.path || undefined,
      cwd: cwd || undefined,
      force: isDirtyForce,
      deleteBranch: false,
    });
    showToast('🗑 Worktree 已安全清理', 'success');
    removeLocalWorktreeByPath(wt.path || wt.id);
    state.worktrees = state.worktrees.filter((w) => w.id !== wt.id);
    state.selectedWorktreeId = '';
    state.currentWorktreeDiff = null;
    await refreshWorktreesList();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/* ---------- Tab 3: 变更 (Worktree & Unified Diff) ---------- */
export function renderDiffView() {
  const wtSelect = document.getElementById('wt-select-dropdown');
  const diffModeSelect = document.getElementById('wt-diff-mode-select');
  if (diffModeSelect) diffModeSelect.value = state.diffMode || 'working_tree';
  const actionBar = document.getElementById('wt-action-bar');
  const metaStrip = document.getElementById('wt-meta-strip');
  const filesStrip = document.getElementById('wt-changed-files');
  const diffViewer = document.getElementById('wt-diff-viewer');

  const scopedWorktrees = getScopedWorktrees();
  if (wtSelect) {
    if (scopedWorktrees.length === 0) {
      wtSelect.innerHTML = '<option value="">当前对话暂无隔离 Worktree 分支</option>';
      wtSelect.disabled = true;
    } else {
      wtSelect.disabled = false;
      wtSelect.innerHTML = scopedWorktrees
        .map((wt) => `<option value="${escapeHtml(wt.id)}">${escapeHtml(wt.branch)} · ${escapeHtml(wt.threadTitle || wt.projectName)} (+${wt.additions}/-${wt.deletions})</option>`)
        .join('');
      if (state.selectedWorktreeId && scopedWorktrees.some((w) => w.id === state.selectedWorktreeId)) {
        wtSelect.value = state.selectedWorktreeId;
      } else {
        state.selectedWorktreeId = scopedWorktrees[0].id;
        wtSelect.value = state.selectedWorktreeId;
      }
    }
  }

  const activeWt = scopedWorktrees.find((w) => w.id === state.selectedWorktreeId);
  if (!activeWt) {
    if (actionBar) actionBar.hidden = true;
    if (metaStrip) metaStrip.hidden = true;
    if (filesStrip) filesStrip.hidden = true;
    if (diffViewer) {
      diffViewer.innerHTML = `<div class="empty-stage-box"><p>当子 Agent 使用「独立 Worktree」策略修改当前对话所属工作区时，所有待审分支与补丁将在此统一展示。</p></div>`;
    }
    return;
  }

  if (actionBar) actionBar.hidden = false;
  const cleanBtn = document.getElementById('btn-wt-cleanup');
  if (cleanBtn) {
    const armedKey = `wt:${activeWt.id}:${activeWt.dirty ? 'force' : 'clean'}`;
    const armed = (state.pendingConfirms.get(armedKey) || 0) > Date.now();
    cleanBtn.textContent = armed ? '确认清理?' : '🗑 清理';
  }
  for (const [btnId, strategy, idleText] of [['btn-wt-apply', 'apply_unstaged', '应用补丁到主工作区'], ['btn-wt-squash', 'squash', 'Squash 合并']]) {
    const btn = document.getElementById(btnId);
    if (!btn) continue;
    const armed = (state.pendingConfirms.get(worktreeIntegrateConfirmKey(activeWt, strategy)) || 0) > Date.now();
    btn.textContent = armed ? `确认${strategy === 'squash' ? ' Squash' : '应用'}?` : idleText;
    btn.classList.toggle('danger-txt', armed);
  }

  if (metaStrip) {
    metaStrip.hidden = false;
    metaStrip.textContent = `分支: ${activeWt.branch} · 项目: ${activeWt.projectName} · 路径: ${activeWt.path || activeWt.cwd}`;
  }

  if (state.loadingDiff) {
    if (filesStrip) filesStrip.hidden = true;
    if (diffViewer) diffViewer.innerHTML = '<div class="empty-stage-box"><p>正在加载 Unified Diff...</p></div>';
    return;
  }

  const diffData = state.currentWorktreeDiff;
  if (!diffData) {
    if (filesStrip) filesStrip.hidden = true;
    if (diffViewer) diffViewer.innerHTML = '<div class="empty-stage-box"><p>点击「↻ 刷新」加载变更补丁明细。</p></div>';
    return;
  }

  if (diffData.error) {
    if (filesStrip) filesStrip.hidden = true;
    if (diffViewer) diffViewer.innerHTML = `<div class="error-inline-box">读取 Diff 失败：${escapeHtml(diffData.error)}</div>`;
    return;
  }

  const fileChunks = parseUnifiedDiffIntoFiles(diffData.diff, diffData.files);
  if (fileChunks.length === 0) {
    if (filesStrip) filesStrip.hidden = true;
    if (diffViewer) diffViewer.innerHTML = `<div class="empty-stage-box"><p>当前隔离分支工作区干净，暂无未合入改动。</p></div>`;
    return;
  }

  if (!state.selectedDiffFile || !fileChunks.some((f) => f.path === state.selectedDiffFile)) {
    state.selectedDiffFile = '__ALL__';
  }

  if (filesStrip) {
    filesStrip.hidden = false;
    filesStrip.innerHTML = [
      `<button type="button" class="changed-file-pill ${state.selectedDiffFile === '__ALL__' ? 'active' : ''}" data-diff-file="__ALL__">全部文件 (${fileChunks.length})</button>`,
      ...fileChunks.map(
        (fc) => `
          <button type="button" class="changed-file-pill ${state.selectedDiffFile === fc.path ? 'active' : ''}" data-diff-file="${escapeHtml(fc.path)}">
            <span>${escapeHtml(fc.status)}</span>
            <span>${escapeHtml(shortenPath(fc.path))}</span>
            <span class="stat-add">+${fc.additions}</span>
            <span class="stat-del">-${fc.deletions}</span>
          </button>`
      ),
    ].join('');
  }

  const visibleChunks =
    state.selectedDiffFile === '__ALL__' ? fileChunks : fileChunks.filter((fc) => fc.path === state.selectedDiffFile);

  if (diffViewer) {
    diffViewer.innerHTML = visibleChunks
      .map(
        (fc) => `
        <div class="diff-file-block">
          <div class="diff-file-header">
            <span>${escapeHtml(fc.path)} (+${fc.additions} / -${fc.deletions})</span>
            <button type="button" class="file-link-btn" data-open-file="${escapeHtml(fc.path)}" data-base-dir="${escapeHtml(activeWt.path || activeWt.cwd || '')}">打开文件</button>
          </div>
          ${renderUnifiedDiffHtml(fc.chunk)}
        </div>`
      )
      .join('');
  }
}

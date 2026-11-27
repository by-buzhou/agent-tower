/**
 * AgentTower Studio — 宿主桥接、HTTP / RPC、Toast、二次确认与前端热刷新 (`ui/net.js`)
 * 惰性读取 preload.js 注入的 `window.sidecar`（模块加载时不触碰宿主对象、不发起任何请求）。
 */
import { MEMBER_DRAFT_KEY, getEffectiveConversationId, getEffectiveCwd, state } from './state.js';
import { scheduleRender } from './render.js';

/* ========================================================================
 * 1. 运行表面检测与安全通信桥接封装（惰性读取 preload.js 注入的 window.sidecar）
 * ======================================================================== */
/** 仅以 preload.js 注入的 window.sidecar 判定宿主内嵌；普通 / 测试 iframe 仍按独立网页端处理（可用 SSE）。 */
export function isEmbeddedHost() {
  return Boolean(typeof window !== 'undefined' && window.sidecar);
}

/** 通用剪贴板：优先 navigator.clipboard（1s 超时），失败降级隐藏 textarea + execCommand('copy')；返回是否成功。 */
export async function copyPlainText(text) {
  const value = String(text ?? '');
  if (!value) return false;
  try {
    if (!navigator.clipboard?.writeText) throw Error('clipboard unavailable');
    await Promise.race([
      navigator.clipboard.writeText(value),
      new Promise((_, reject) => setTimeout(() => reject(Error('clipboard timeout')), 1000)),
    ]);
    return true;
  } catch {
    let ok = false;
    const prevFocus = document.activeElement;
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.append(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
    prevFocus?.focus?.({ preventScroll: true });
    return ok;
  }
}

function apiFetch(...args) {
  const impl =
    typeof window !== 'undefined' && window.sidecar?.fetch
      ? window.sidecar.fetch.bind(window.sidecar)
      : fetch.bind(globalThis);
  return impl(...args);
}

/* ========================================================================
 * 6. HTTP / RPC / SSE + 非重叠轮询引擎
 * ======================================================================== */
/** v0.2.6 C06①：只读 GET 默认硬超时（Bootstrap 8s，其余 5s），守护服务繁忙 / 重启时绝不无限挂起。 */
const GET_TIMEOUT_MS = 5000;
const BOOTSTRAP_TIMEOUT_MS = 8000;

function timeoutError(label, timeoutMs) {
  const err = new Error(`${label} 请求超时（${timeoutMs}ms），编排守护服务可能繁忙或正在重启，稍后将自动重试`);
  err.code = 'REQUEST_TIMEOUT';
  return err;
}

export async function httpGetJson(relPath, query = {}, opts = {}) {
  const cleanPath = String(relPath || '').replace(/^\/+/, '');
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const url = qs.toString() ? `${cleanPath}?${qs.toString()}` : cleanPath;
  const requested = Number(opts?.timeoutMs);
  const timeoutMs = requested > 0 ? requested : cleanPath === 'api/bootstrap' ? BOOTSTRAP_TIMEOUT_MS : GET_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  // 宿主 sidecar.fetch 未必透传 signal：用竞速 Promise 兜底保证硬截止，同时尽力 abort 底层请求
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      try { controller?.abort(); } catch {}
      reject(timeoutError(`GET ${cleanPath}`, timeoutMs));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([apiFetch(url, { method: 'GET', ...(controller ? { signal: controller.signal } : {}) }), deadline]);
    if (!res.ok) {
      const err = new Error(`GET ${cleanPath} 失败 (${res.status})`);
      err.status = res.status;
      throw err;
    }
    const body = await Promise.race([res.json(), deadline]);
    if (body && typeof body === 'object' && body.ok === true && body.result && !body.threads && !body.events) {
      return body.result;
    }
    return body;
  } catch (err) {
    if (err?.name === 'AbortError' || err?.name === 'TimeoutError') throw timeoutError(`GET ${cleanPath}`, timeoutMs);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP 层失败（非业务错误码）分类：401 凭据失效 / 503 守护服务不可用 / 超时 / 断连。 */
function classifyTransportFailure(method, status, cause) {
  if (cause?.name === 'AbortError' || cause?.name === 'TimeoutError') {
    return { code: 'REQUEST_TIMEOUT', message: `操作 ${method} 请求超时，编排守护服务可能繁忙或正在重启，请稍后重试` };
  }
  if (cause) return { code: 'SIDECAR_UNREACHABLE', message: `操作 ${method} 无法连接AgentTower服务，请稍后重试或重新打开侧栏` };
  if (status === 401) return { code: 'SIDECAR_UNAUTHORIZED', message: `操作 ${method} 被拒绝（HTTP 401）：面板凭据已失效，请关闭并重新打开AgentTower侧栏` };
  if (status === 503) return { code: 'DAEMON_UNAVAILABLE', message: `操作 ${method} 暂不可用（HTTP 503）：编排守护服务正在重启或升级，请稍后重试` };
  return null;
}

export async function rpcCall(method, params = {}) {
  const convId = getEffectiveConversationId();
  const defaultCwd = getEffectiveCwd();
  const mergedParams = {
    conversationId: convId || undefined,
    workspace: defaultCwd || undefined,
    ...params,
  };
  const payload = { method, params: mergedParams };
  let res;
  try {
    res = await apiFetch('api/rpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    const failure = classifyTransportFailure(method, 0, cause);
    throw Object.assign(new Error(failure.message), { code: failure.code });
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.ok === false) {
    const transport = !res.ok && !data?.code && !data?.error?.code ? classifyTransportFailure(method, res.status, null) : null;
    const errText =
      typeof data?.error === 'string'
        ? data.error
        : data?.error?.message || data?.message || transport?.message || `操作 ${method} 失败 (HTTP ${res.status})`;
    // v0.1.0：透传结构化错误码与详情（PRESET_REVISION_CONFLICT / LOCKED_DEFAULT_UNAVAILABLE / REVIEW_POOL_EMPTY …）
    const err = new Error(errText);
    err.code = data?.code ?? data?.error?.code ?? transport?.code;
    err.details = data?.details ?? data?.error?.details;
    err.status = res.status;
    throw err;
  }
  return data?.result !== undefined ? data.result : data;
}

/** 结构化错误码 → 面向用户的中文提示（未知错误码回落原始错误文案）。 */
const RPC_ERROR_HINTS = {
  PRESET_REVISION_CONFLICT: '成员配置已被其他窗口更新，已合并最新配置',
  LOCKED_DEFAULT_UNAVAILABLE: '首选 ★ 成员不可用：请在配置页「角色路由」阵容中勾选并点选另一名成员为 ★',
  BUILTIN_PRESET_DELETE_FORBIDDEN: '守护进程版本较旧，暂不支持删除该成员：请升级AgentTower后重试，或先在阵容中取消勾选',
  INVALID_PRESET_KEY: '成员键需以小写字母开头，仅含小写字母/数字/下划线/连字符（3~64 位），且不可使用系统保留词',
  MEMBER_SELECTION_REQUIRED: '当前阵容需要主会话显式点选成员：请传入已勾选成员的 presetKey，或在配置页勾选并设置 ★ 首选',
  AGY_SWARM_DISPATCH_REQUIRED: 'Antigravity 角色成员需在宿主会话内调用原生 swarm({ action: "add", name, model }) 派遣，塔台会自动认领并投屏至成员面板',
  HOST_TOPLEVEL_FORBIDDEN: '禁止在宿主内另开顶层会话（agentapi new-conversation），请改用宿主原生 swarm 派遣 Antigravity 角色成员',
  REVIEW_POOL_EMPTY: '复杂阵容审核阶段未勾选评审官：请在配置页勾选评审官，或确认降级为主会话自审',
  MODE_SINGLE_MEMBER_REQUIRED: '当前模式仅允许单线派发 1 名成员，如需并行批派请切换为「简单模式」或「复杂自定义」',
  MODE_REVIEW_NOT_ALLOWED: '当前模式由主会话自行验收，如需独立终审请切换为「复杂自定义」并开启审核阶段',
  PRESET_DISABLED: '所选成员未勾选进当前模式阵容，请在配置页「角色路由」勾选或改选其他成员',
  POLICY_REVISION_CONFLICT: '对话模式已在其他窗口变更，已刷新为最新状态',
  host_direct_only: '当前对话处于 ⚡ 直出模式，已拦截派发',
  // v0.2.0 项目规范（Spec）
  SPEC_NOT_FOUND: '未找到该项目规范，可能已被删除或改名，请点击 ↻ 刷新列表',
  SPEC_BUDGET_EXCEEDED: '规范正文超出 16 KiB 内联预算，已降级为必读路径指引',
  UNSAFE_SPEC_PATH: '规范路径指向符号链接 / Junction 等不安全位置，已拒绝读取或写入',
  CWD_REJECTED: '当前工作区被安全策略拒绝（插件挂载 / 控制面 / 敏感或相对目录），请在项目根目录打开面板后重试',
  // v0.3.3.1 在线热更新与回滚
  DAEMON_UPDATING: 'AgentTower 正在执行热更新或回滚切换，暂不接受新派单，请稍候数秒后重试',
  UPDATE_UNSUPPORTED_INSTALL: '当前安装形态不支持面板内自动覆盖更新（开发仓请使用命令行发版热切，或改用标准安装包）',
  UPDATE_NOT_AVAILABLE: '当前没有可安装的新版本，请先点击「立即检测」刷新版本状态',
  UPDATE_TARGET_MODIFIED: '检测到已安装插件目录存在手工改动，为避免覆盖本地修改已拦截自动更新',
  UPDATE_CHECKSUM_MISMATCH: '安装包 SHA-256 校验未通过，已自动清理临时文件并中止更新，线上运行未受影响',
  UPDATE_INTEGRITY_FAILED: '安装包完整性或安全路径校验未通过，已自动中止更新并清理临时文件',
  UPDATE_PREFLIGHT_FAILED: '新版本沙盒预检未通过，已中止热更新并保留当前稳定版本运行',
  UPDATE_ROLLBACK_UNAVAILABLE: '当前没有可用的上一版本回滚备份，或该版本不支持自动回滚',
  UPDATE_IN_PROGRESS: '已有版本更新或回滚任务正在进行中，请等待当前操作完成',
  UPDATE_ALREADY_COMMITTING: '更新已进入切换落盘阶段，当前已无法取消，请等待新守护进程完成启动',
};
export function describeRpcError(err) {
  return RPC_ERROR_HINTS[err?.code] || err?.message || String(err || '操作失败');
}

export function armOrConfirm(confirmKey, promptMsg) {
  const now = Date.now();
  const expiry = state.pendingConfirms.get(confirmKey) || 0;
  if (now < expiry) {
    state.pendingConfirms.delete(confirmKey);
    return true;
  }
  state.pendingConfirms.set(confirmKey, now + 4500);
  showToast(promptMsg, 'info');
  scheduleRender();
  setTimeout(() => {
    const cur = state.pendingConfirms.get(confirmKey) || 0;
    if (cur && Date.now() >= cur) {
      state.pendingConfirms.delete(confirmKey);
      scheduleRender();
    }
  }, 4600);
  return false;
}

/** 存在未发送草稿 / 未保存配置 / 正在输入或刷新已开始时禁止热刷新（重载会丢失用户输入）。 */
function assetReloadBlocked() {
  const unsent = ['comp-prompt-input','disp-title','disp-prompt','council-topic-input','review-focus-input'].some(id => document.getElementById(id)?.value.trim()) ||
    state.batchDrafts.some(row => row.title?.trim() || row.prompt?.trim()) ||
    [...document.querySelectorAll('[data-at-draft]')].some(el => el.value.trim());
  // dirtyMemberPool 为历史遗留字段（状态仓从未初始化）：必须可选链读取，否则新哈希到达时抛 TypeError 连带 Bootstrap 应用失败
  return Boolean(unsent || state.latestAssetHash === state.loadedAssetHash || state.reloadStarted || state.uiRenderFrozen || state.dirtyPresets.size || state.dirtyModeProfiles.size || state.dirtyMemberPool?.size || state.dirtyRelayTarget || state.pendingDeletes.size || state.pendingResets.size || state.presetSaving ||
      state.presets[MEMBER_DRAFT_KEY] || state.globalPresets[MEMBER_DRAFT_KEY] ||
      state.globalDirtyPresets.size || state.globalDirtyModeProfiles.size || state.globalPendingDeletes.size || state.globalPresetSaving ||
      state.customModelPrompt || document.activeElement?.matches('input,textarea,[contenteditable="true"]'));
}

/**
 * v0.2.6 C09①：检测到新资产哈希后先单飞探活 `api/health`，仅当服务端已就绪且返回的 `frontendAssetHash`
 * 与新哈希一致时才写 `sessionStorage('at-reload:' + pathname)` 防循环锁并执行单次 `reload()`；
 * 探活失败 / 哈希仍不一致（如 `--stage-only` 间隙旧进程提前推送哈希）时不写锁，等待下一次推送重试。
 */
export function checkAssetUpdate(hash) {
  if (hash) state.latestAssetHash = hash;
  if (!state.latestAssetHash) return;
  if (!/^[a-f0-9]{64}$/.test(state.loadedAssetHash)) state.loadedAssetHash = state.latestAssetHash;
  // 热刷新判定绝不能让调用方（Bootstrap / 流式快照应用）因异常中断
  try { if (assetReloadBlocked()) return; } catch { return; }
  const key = 'at-reload:' + location.pathname;
  try {
    if (sessionStorage.getItem(key) === state.latestAssetHash) return;
  } catch { return; } // Without a loop guard do not destructively reload.
  if (state.assetProbeInFlight) return;
  state.assetProbeInFlight = true;
  const target = state.latestAssetHash;
  void httpGetJson('api/health', {}, { timeoutMs: 2500 })
    .then((health) => {
      let blocked = true;
      try { blocked = assetReloadBlocked(); } catch {}
      if (health?.ok === false || health?.frontendAssetHash !== target || state.latestAssetHash !== target || blocked) return;
      try {
        if (sessionStorage.getItem(key) === target) return;
        sessionStorage.setItem(key, target);
      } catch { return; }
      state.reloadStarted = true;
      window.location.reload();
    })
    .catch(() => {})
    .finally(() => { state.assetProbeInFlight = false; });
}

/**
 * v0.2.6 C07③：把宿主原生代派 / 成员控制指令投递到当前主对话——宿主内经 `window.sidecar.agent.sendMessage` 直接发送，
 * 独立浏览器（或发送失败）降级为复制到剪贴板。返回 `'sent' | 'copied' | 'failed'`。
 */
export async function relayToHostConversation(text) {
  const message = String(text ?? '').trim();
  if (!message) return 'failed';
  const send = typeof window !== 'undefined' ? window.sidecar?.agent?.sendMessage : undefined;
  if (typeof send === 'function') {
    try {
      await send.call(window.sidecar.agent, message, getEffectiveConversationId());
      return 'sent';
    } catch { /* Fall back to the clipboard below. */ }
  }
  return (await copyPlainText(message)) ? 'copied' : 'failed';
}

export function showToast(message, kind = 'info') {
  const box = document.getElementById('toast-container');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast-item ${kind}`;
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => el.remove(), 3600);
}

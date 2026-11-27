/**
 * AgentTower Studio — 各引擎原生权限档位与跨引擎安全归一化 (`ui/permissions.js`)
 * 叶子纯模块：零 window / document 依赖，Node 单测可直接 import 并与 core/catalog.mjs 逐值对照。
 * tier 阶梯 plan < ask < edits < auto < full；未知值落到 ask；跨引擎切换绝不落到 full（高危）档。
 */
/* ========================================================================
 * 2.1 各引擎原生权限档位表 + 跨引擎安全归一化（v0.0.3）
 *     与 core/catalog.mjs PROVIDER_PERMISSION_MODES / normalizePermissionModeForProvider 语义一致：
 *     tier 阶梯 plan < ask < edits < auto < full；未知值落到 ask；跨引擎切换绝不落到 full（高危）档。
 *     本段为自包含纯函数（不依赖外部作用域），单测会直接抽取求值。
 * ======================================================================== */
/* AT_PERMISSION_MODULE_START */
export const PERMISSION_LADDERS = {
  'claude-code': [
    { value: 'plan', label: '规划模式 (plan)', tier: 'plan', danger: false },
    { value: 'default', label: '请求批准 (default)', tier: 'ask', danger: false },
    { value: 'acceptEdits', label: '自动接受编辑 (acceptEdits)', tier: 'edits', danger: false },
    { value: 'auto', label: '自动安全审查 (auto)', tier: 'auto', danger: false },
    { value: 'bypassPermissions', label: '跳过全部审批 (bypassPermissions)', tier: 'full', danger: true },
  ],
  codex: [
    { value: 'read-only', label: '只读沙盒 (read-only)', tier: 'plan', danger: false },
    { value: 'on-request', label: '请求批准 (on-request)', tier: 'ask', danger: false },
    { value: 'auto', label: '自动审查放行 (auto)', tier: 'auto', danger: false },
    { value: 'full-access', label: '完全访问 (full-access)', tier: 'full', danger: true },
  ],
  'kimi-code': [
    { value: 'plan', label: '规划模式 (plan)', tier: 'plan', danger: false },
    { value: 'default', label: '请求批准 (default)', tier: 'ask', danger: false },
    { value: 'auto', label: '自动安全放行 (auto)', tier: 'auto', danger: false },
    { value: 'yolo', label: '全自动免审 (yolo)', tier: 'full', danger: true },
  ],
  antigravity: [
    { value: 'plan', label: '规划模式 (plan)', tier: 'plan', danger: false },
    { value: 'default', label: '常规审查 (default)', tier: 'ask', danger: false },
    { value: 'accept-edits', label: '自动接受编辑 (accept-edits)', tier: 'edits', danger: false },
    { value: 'always-proceed', label: '跳过工具审批 (always-proceed)', tier: 'full', danger: true },
  ],
  generic: [
    { value: 'plan', label: '规划模式 (plan)', tier: 'plan', danger: false },
    { value: 'default', label: '请求批准 (default)', tier: 'ask', danger: false },
    { value: 'auto', label: '自动放行 (auto)', tier: 'auto', danger: false },
    { value: 'full-access', label: '完全访问 (full-access)', tier: 'full', danger: true },
  ],
};
export const HOST_DEFAULT_PERMISSION = { value: 'host-default', label: '由宿主主窗口管理 (host-default)', tier: 'ask', danger: false, disabled: true };
export const PERMISSION_BY_TIER = {
  'claude-code': { plan: 'plan', ask: 'default', edits: 'acceptEdits', auto: 'auto', full: 'bypassPermissions' },
  codex: { plan: 'read-only', ask: 'on-request', edits: 'on-request', auto: 'auto', full: 'full-access' },
  'kimi-code': { plan: 'plan', ask: 'default', edits: 'default', auto: 'auto', full: 'yolo' },
  antigravity: { plan: 'plan', ask: 'default', edits: 'accept-edits', auto: 'accept-edits', full: 'always-proceed' },
  generic: { plan: 'plan', ask: 'default', edits: 'default', auto: 'auto', full: 'full-access' },
};
export const PERMISSION_ALIAS_TIER = {
  plan: 'plan', 'read-only': 'plan', readonly: 'plan',
  default: 'ask', 'approval-required': 'ask', 'on-request': 'ask', manual: 'ask', ask: 'ask', untrusted: 'ask',
  'host-default': 'ask', dontask: 'ask',
  acceptedits: 'edits', 'accept-edits': 'edits', 'auto-accept-edits': 'edits',
  auto: 'auto', 'workspace-write': 'auto', 'auto-review': 'auto',
  bypasspermissions: 'full', 'full-access': 'full', yolo: 'full', 'danger-full-access': 'full', 'always-proceed': 'full',
  'dangerously-skip-permissions': 'full',
};
export const EXPLICIT_FULL_ACCESS_ALIASES = ['full-access', 'yolo', 'danger-full-access'];
export function permissionProfileOf(providerId) {
  const id = String(providerId || '').trim().toLowerCase();
  if (['claude', 'claude-code', 'claude_code', 'claude-agent', 'claude_agent', 'claudeagent', 'anthropic'].includes(id)) return 'claude-code';
  if (id === 'codex') return 'codex';
  if (['kimi', 'kimi-cli', 'kimi_code', 'kimi-code'].includes(id)) return 'kimi-code';
  if (['agy', 'host', 'antigravity-host', 'antigravity'].includes(id)) return 'antigravity';
  return 'generic';
}
export function permissionTierOf(mode) {
  const key = String(mode ?? '').trim().toLowerCase();
  return Object.hasOwn(PERMISSION_ALIAS_TIER, key) ? PERMISSION_ALIAS_TIER[key] : '';
}
export function permissionLadderOf(providerId) {
  return PERMISSION_LADDERS[permissionProfileOf(providerId)];
}
/**
 * 把任意引擎原生值或旧版通用值映射为目标引擎原生值，绝不提权：
 * - 空 / 未知 → 目标引擎 ask 档；非 Codex 的 read-only → plan（前端无法强制只读沙盒）；
 * - 他引擎专属的「跳过全部」值（如 Claude bypassPermissions 落到 Codex）不解锁目标 full 档；
 * - crossEngine（切换引擎时携带档位）永不落到 full 高危档，降为目标引擎 auto 档。
 */
export function normalizePermissionForProvider(providerId, mode, { crossEngine = false } = {}) {
  const profile = permissionProfileOf(providerId);
  const ladder = PERMISSION_BY_TIER[profile];
  const lower = String(mode ?? '').trim().toLowerCase();
  if (!lower || lower === 'inherit') return ladder.ask;
  if (lower === 'read-only' || lower === 'readonly') return ladder.plan;
  const native = PERMISSION_LADDERS[profile].find((m) => m.value.toLowerCase() === lower);
  const tier = native ? native.tier : permissionTierOf(lower);
  if (!tier) return ladder.ask;
  if (tier === 'full') {
    if (crossEngine) return ladder.auto;
    return native || EXPLICIT_FULL_ACCESS_ALIASES.includes(lower) ? ladder.full : ladder.auto;
  }
  return native ? native.value : ladder[tier];
}
export function isDangerPermissionFor(providerId, mode) {
  const value = normalizePermissionForProvider(providerId, mode);
  return PERMISSION_LADDERS[permissionProfileOf(providerId)].some((m) => m.value === value && m.danger);
}
/** 仅「规划模式」驱动 Plan 交互；其余档位统一 default（后端与 MCP 仍兼容 interactionMode）。 */
export function deriveInteractionMode(permissionMode) {
  return String(permissionMode || '').trim() === 'plan' ? 'plan' : 'default';
}
/* AT_PERMISSION_MODULE_END */

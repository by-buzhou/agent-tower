/**
 * AgentTower Studio — 全局状态仓、角色槽位常量与纯状态选择器 (`ui/state.js`)
 * `state` 为全局唯一可变单例：原 app.js 顶层散落的可变标量统一收归为其属性（禁止 export let）。
 * 依赖宿主 / 浏览器环境的初值（工作区、会话、连接模式、配置分区、资产哈希）由 app.js 启动时写入。
 */
import { fileUriToPath, isWorktreeOrTempPath, normalizeProjectPath, projectPathKey } from './format.js';

export const STUDIO_FRONTEND_BUILD = 'v026-native-dual-selfheal';
export const DEFAULT_SPEC_SINGLE_KB = 2;
export const DEFAULT_SPEC_TOTAL_KB = 16;
/** 宿主硬锁定会话 ID：仅读取 preload.js 注入的 window.sidecar.conversationId（网页 URL 参数不算锁定）。 */
export function getHostConversationId() {
  if (typeof window === 'undefined') return '';
  return String(window.sidecar?.conversationId || '').trim();
}

/** 独立网页端首屏会话：仅作为初始绑定值读取 ?conversationId=，此后可经顶栏下拉自由切换。 */
export function getInitialQueryConversationId() {
  try {
    if (window.sidecar) return '';
    return String(new URLSearchParams(window.location.search).get('conversationId') || '').trim();
  } catch {
    return '';
  }
}

export function getInitialQueryWorkspace() {
  try {
    if (window.sidecar) return '';
    const ws = new URLSearchParams(window.location.search).get('workspace') || '';
    return ws ? fileUriToPath(ws) : '';
  } catch {
    return '';
  }
}

/* ========================================================================
 * 2. 内置模型目录、9 大黄金角色预设与 7 大主流扩展平台模板基线
 * ======================================================================== */
export const ROUTER_DEFAULT_MODEL = '__default__';
export const INHERIT_EFFORT = 'inherit';
export const CUSTOM_MODEL_PROMPT_VALUE = '__custom_input__';

export const FALLBACK_PROVIDERS = [
  {
    id: 'kimi-code',
    name: 'Kimi Code',
    available: true,
    models: [
      { id: 'kimi-code/k3.1-pro', name: 'K3.1 Pro (1M 主力旗舰)', group: 'kimi-code', efforts: ['low', 'high', 'max'], defaultEffort: 'max', contextWindow: 1048576, isDefault: true },
      { id: 'kimi-code/k3.1-pro-highspeed', name: 'K3.1 Pro Highspeed (2x)', group: 'kimi-code', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 1048576 },
      { id: 'kimi-code/kimi-for-coding', name: 'K2.8 Preview', group: 'kimi-code', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 262144 },
      { id: 'kimi-code/kimi-for-coding-highspeed', name: 'K2.7 Code Highspeed', group: 'kimi-code', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 262144 },
      { id: 'kimi-code/k3', name: 'K3 标准版', group: 'kimi-code', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 262144 },
      { id: 'kimi-code/k3-256k', name: 'K3-256k', group: 'kimi-code', efforts: ['low', 'high', 'max'], defaultEffort: 'high', contextWindow: 262144 },
    ],
  },
  {
    id: 'codex',
    name: 'Codex',
    available: true,
    models: [
      { id: 'gpt-6.2-astra', name: 'GPT-6.2 Astra (深度架构/终审王牌)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', contextWindow: 475000, isDefault: true },
      { id: 'gpt-6.2-sol', name: 'GPT-6.2 Sol (主力工程实现)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high', contextWindow: 475000 },
      { id: 'gpt-6-astra', name: 'GPT-6 Astra (深度架构/终审经典)', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'xhigh', contextWindow: 475000 },
      { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol (工程实现经典)', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'high', contextWindow: 475000 },
      { id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra (高吞吐均衡)', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium', contextWindow: 475000 },
      { id: 'gpt-6-luna', name: 'GPT-6 Luna (轻量极速)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium', contextWindow: 475000 },
      { id: 'gpt-6-sol', name: 'GPT-6 Sol (Legacy)', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
      { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol (Legacy)', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'low' },
      { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra (Legacy)', efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], defaultEffort: 'medium' },
      { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna (Legacy)', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
      { id: 'gpt-5.5', name: 'GPT-5.5 (Legacy)', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' },
    ],
  },
  {
    id: 'antigravity',
    name: 'Antigravity (宿主原生)',
    available: true,
    isNativeHost: true,
    models: [
      { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon (宿主总指挥首选)', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', contextWindow: 1048576, isDefault: true },
      { id: 'gemini-4-argon', name: 'Gemini 4 Argon (深度统筹备选)', efforts: ['low', 'medium', 'high'], defaultEffort: 'high', contextWindow: 1048576 },
      { id: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen (宿主前端/全栈王牌)', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', contextWindow: 1048576 },
      { id: 'gemini-4-neon', name: 'Gemini 4 Neon', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high' },
      { id: 'gemini-pro-orchestrator-neon', name: 'Orchestrator (Neon)', efforts: [] },
      { id: 'gemini-pro-orchestrator', name: 'Orchestrator (Carbon)', efforts: [] },
      { id: 'gemini-pro-orchestrator-argon', name: 'Orchestrator (Argon)', efforts: [] },
      { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    ],
  },
  {
    id: 'claude-code', name: 'Claude Code', available: true,
    models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'xhigh', isDefault: true },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'high' },
      { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    ],
  },
];

export const BUILTIN_EXTENSION_TEMPLATES_UI = [
  {
    id: 'opencode',
    name: 'OpenCode CLI',
    protocol: 'acp',
    driverKind: 'generic-acp',
    command: 'opencode',
    args: ['acp'],
    argsTemplate: 'acp',
    envPolicy: 'inherit',
    ephemeralSupport: 'delete',
    description: '开源多模型编程终端 Agent，支持原生 ACP 双向流式会话与本地工具直执。',
    defaultModels: [{ id: 'default', name: 'OpenCode 默认模型' }],
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'dsh',
    name: 'DeepSeek Harness (DSH)',
    protocol: 'acp',
    driverKind: 'generic-acp',
    command: 'dsh',
    args: ['--profile', 'acp'],
    argsTemplate: '--profile acp',
    envPolicy: 'minimal',
    ephemeralSupport: 'close-only',
    description: 'DeepSeek 官方终端 Agent Harness，支持标准 ACP 协议与默认极简环境隔离。',
    defaultModels: [{ id: 'default', name: 'DSH 默认模型' }],
    efforts: ['off', 'low', 'high', 'max'],
  },
  {
    id: 'zcode',
    name: 'ZCode (Z.ai / 智谱)',
    protocol: 'zcode',
    driverKind: 'zcode',
    command: 'zcode',
    args: ['app-server', '--stdio'],
    argsTemplate: 'app-server --stdio',
    envPolicy: 'minimal',
    ephemeralSupport: 'close-only',
    description: '智谱 Z.ai 官方编程 Agent，支持 app-server stdio 官方协议与桌面端自动发现。',
    defaultModels: [{ id: 'default', name: 'ZCode 默认模型' }],
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    protocol: 'acp',
    driverKind: 'generic-acp',
    command: 'gemini',
    args: ['--acp'],
    envPolicy: 'inherit',
    ephemeralSupport: 'delete',
    description: 'Google 官方 Gemini CLI 标准 ACP 协议接口，支持流式思维链与工具调用。',
    defaultModels: [{ id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro' }],
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    protocol: 'acp',
    driverKind: 'generic-acp',
    command: 'qwen',
    args: ['--acp'],
    envPolicy: 'inherit',
    ephemeralSupport: 'delete',
    description: '通义 Qwen Code 编程终端 Agent，支持标准 ACP 双向流式会话与本地工具直执。',
    defaultModels: [{ id: 'qwen3-coder-plus', name: 'Qwen3 Coder Plus' }],
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    protocol: 'acp',
    command: 'cursor-agent',
    args: ['acp'],
    description: 'Cursor 命令行 Agent ACP 模式，支持复用本地索引与多轮代码编辑。',
    defaultModels: [{ id: 'auto', name: 'Cursor Auto' }],
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'grok',
    name: 'Grok CLI',
    protocol: 'acp',
    command: 'grok',
    args: ['acp'],
    description: 'xAI Grok 编程 CLI 标准 ACP 接入通道。',
    defaultModels: [{ id: 'grok-code-fast-1', name: 'Grok Code' }],
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    protocol: 'acp',
    command: 'kiro-cli',
    args: ['acp'],
    description: 'AWS Kiro 规范驱动编程 CLI (ACP 标准流模式)。',
    defaultModels: [{ id: 'default', name: 'Kiro Default' }],
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'goose',
    name: 'Goose Agent',
    protocol: 'acp',
    command: 'goose',
    args: ['acp'],
    description: 'Block 开源可扩展开发 Agent，原生支持 ACP JSON-RPC 2.0。',
    defaultModels: [{ id: 'default', name: 'Goose Default' }],
    efforts: ['low', 'medium', 'high'],
  },
  {
    id: 'aider',
    name: 'Aider CLI',
    protocol: 'cli',
    command: 'aider',
    args: ['--model', '{{model}}', '--yes-always', '--message', '{{prompt}}'],
    argsTemplate: '--model {{model}} --yes-always --message {{prompt}}',
    description: '经典 Git 结对编程 CLI，通过通用参数占位符模板非交互式驱动。',
    defaultModels: [{ id: 'sonnet', name: 'Aider Default' }],
    efforts: ['low', 'medium', 'high'],
  },
];

export const ROLE_SLOT_META = [
  {
    key: 'commander',
    label: '总指挥 (Commander · 宿主原生)',
    role: 'general',
    desc: '运行于 Antigravity 宿主主会话，负责拆解需求、调度外部军师/执行器与最终把关。',
    defaults: { provider: 'antigravity', model: 'gemini-4-carbon', effort: 'high', permissionMode: 'always-proceed', interactionMode: 'default', isolation: 'shared' },
  },
  {
    key: 'advisor_kimi',
    label: '军师 A · 全景架构 (Kimi)',
    role: 'design',
    desc: '依托 K3.1 Pro 1M 超长上下文通读全仓，输出全局架构方案与模块边界。',
    defaults: { provider: 'kimi-code', model: 'kimi-code/k3.1-pro', effort: 'max', permissionMode: 'plan', interactionMode: 'plan', isolation: 'shared' },
  },
  {
    key: 'advisor_codex',
    label: '军师 B · GPT-6.2 Astra',
    role: 'research',
    desc: '依托 GPT-6.2 Astra 深度推理，交叉审视状态机漏洞、并发竞态与算法边界。',
    defaults: { provider: 'codex', model: 'gpt-6.2-astra', effort: 'xhigh', permissionMode: 'read-only', interactionMode: 'plan', isolation: 'shared' },
  },
  {
    key: 'advisor_claude', label: '军师 C · Claude Opus 5.5', role: 'design',
    desc: '全栈与产品架构军师。',
    defaults: { provider: 'claude-code', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'plan', interactionMode: 'plan', isolation: 'shared' },
  },
  {
    key: 'executor_kimi',
    label: '执行主力 · 跨文件贯通 (Kimi)',
    role: 'implementation',
    desc: '擅长多文件联动修改、协议适配、脚本工程与高质量中文文档落地。',
    defaults: { provider: 'kimi-code', model: 'kimi-code/k3.1-pro', effort: 'high', permissionMode: 'auto', interactionMode: 'default', isolation: 'shared' },
  },
  {
    key: 'executor_codex',
    label: '执行攻坚 · GPT-6.2 Sol',
    role: 'implementation',
    desc: '擅长复杂系统核心状态机、数据库存储、后端服务构建与严密单测闭环。',
    defaults: { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high', permissionMode: 'full-access', interactionMode: 'default', isolation: 'shared' },
  },
  {
    key: 'executor_claude', label: '全能执行 · Claude Opus 5.5', role: 'implementation',
    desc: '前后端小全能执行官。',
    defaults: { provider: 'claude-code', model: 'claude-opus-5-5', effort: 'xhigh', permissionMode: 'bypassPermissions', interactionMode: 'default', isolation: 'shared' },
  },
  {
    key: 'executor_hydrogen',
    label: '执行王牌 · 前端与推演 (宿主 Hydrogen)',
    role: 'implementation',
    desc: '通过宿主原生 invoke_subagent / agentapi 调度 Gemini 4 Hydrogen，免外部 CLI 套娃。',
    defaults: { provider: 'antigravity', model: 'gemini-4-hydrogen', effort: 'high', permissionMode: 'accept-edits', interactionMode: 'default', isolation: 'shared' },
  },
  {
    key: 'reviewer',
    label: '审改终审官 · GPT-6.2 Astra',
    role: 'review',
    desc: '严查缺陷，当场修复、自测并汇报主会话。',
    defaults: { provider: 'codex', model: 'gpt-6.2-astra', effort: 'xhigh', permissionMode: 'full-access', interactionMode: 'default', isolation: 'shared' },
  },
  {
    key: 'curator_codex',
    label: '规范维护官 · GPT-6.2 Astra',
    role: 'curator',
    desc: '只读梳理对话拍板结论，提案新增 / 合并 / 删除项目规范，经用户整组确认后才落盘。',
    defaults: { provider: 'codex', model: 'gpt-6.2-astra', effort: 'high', permissionMode: 'read-only', interactionMode: 'plan', isolation: 'shared' },
  },
];

/* v0.1.0 三组弹性成员池：组归属来自每个预设的 group 字段（v0.2.2 起全成员平权，无内置 / custom_* 之分），
   ROLE_SLOT_META 只作离线种子；keys 仅列出离线种子成员，用于排序与离线兜底（远端成员表到达后以远端为准）。
   v0.1.1：选人改由 modeProfiles 分模式单层勾选决定（不再有组选人策略 / ⇄ 单目标）。 */
export const MEMBER_GROUPS = [
  { id: 'advisor', title: '军师组', stageTitle: '军师阶段', hint: '只读规划 · 方案对撞', starrable: false, keys: ['advisor_kimi', 'advisor_codex', 'advisor_claude'] },
  { id: 'executor', title: '执行组', stageTitle: '执行阶段', hint: '改码落地', starrable: true, required: true, keys: ['executor_kimi', 'executor_codex', 'executor_claude', 'executor_hydrogen'] },
  { id: 'reviewer', title: '评审组', stageTitle: '审核阶段', hint: '独立终审', starrable: true, keys: ['reviewer'] },
  { id: 'curator', title: '规范维护组', stageTitle: '规范维护', hint: '只读提案 · 确认落盘', starrable: true, keys: ['curator_codex'] },
];
export const MEMBER_GROUP_IDS = ['advisor', 'executor', 'reviewer', 'curator'];
/** v0.2.11 可派发三组：规范维护组不是派发阶段（仅由「✨ 维护规范」/ 项目级自动维护拉起），不进入派发勾选池。 */
export const DISPATCH_GROUP_IDS = ['advisor', 'executor', 'reviewer'];
/** 规范维护组引擎校验：放行外部 CLI 与宿主原生（antigravity / agy），仅拦截宿主内部伪 ID。 */
export function isCuratorBlockedProvider(provider) {
  const id = String(provider || '').trim().toLowerCase();
  return !id || ['host', 'antigravity-host', 'commander', 'coordinator'].includes(id);
}
/** v0.1.0 旧版组策略 / 翻译目标：仅作存量设置迁移到 modeProfiles 的只读输入（v0.1.1 起前端不再编辑、不再提交）。 */
export const DEFAULT_MEMBER_POOL = {
  advisor: { strategy: 'all_enabled', defaultPresetKey: null },
  executor: { strategy: 'locked_default', defaultPresetKey: 'executor_claude' },
  reviewer: { strategy: 'locked_default', defaultPresetKey: 'reviewer' },
};
export const DEFAULT_RELAY_TARGET = 'executor_codex';
/** v0.2.2 全成员平权：成员键以小写字母开头，仅含小写字母 / 数字 / 下划线 / 连字符，3~64 位（不再强制 custom_ 前缀）。 */
export const PRESET_KEY_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
/** 兼容旧内部引用的别名。 */
export const CUSTOM_PRESET_KEY_PATTERN = PRESET_KEY_PATTERN;
/** 成员键系统保留词：角色 / 职能 / 宿主通配名与草稿占位键不可用作成员键。 */
export const RESERVED_PRESET_KEYS = new Set(['commander', 'coordinator', 'advisor', 'executor', 'design', 'research', 'review', 'implementation', 'test', 'general', 'host', 'all', 'curator', '__new_member__']);
/** 配置页「+ 添加」的本地草稿成员占位键（不入存储、不入派发列表，确认后改为正式成员键）。 */
export const MEMBER_DRAFT_KEY = '__new_member__';
/** 预设可编辑字段（草稿与保存只提交被改动的字段）；新建成员时提交完整对象。 */
export const PRESET_EDIT_FIELDS = ['label', 'title', 'enabled', 'provider', 'model', 'effort', 'permissionMode', 'interactionMode', 'isolation'];
export const PRESET_CREATE_FIELDS = ['key', 'label', 'title', 'group', 'role', 'enabled', 'builtin', 'provider', 'model', 'effort', 'permissionMode', 'interactionMode', 'isolation', 'description'];
export const PRESET_ROUTE_FIELDS = ['provider', 'model', 'effort', 'permissionMode', 'interactionMode', 'isolation'];

/* v0.1.1 三档内置编排模式（顶栏胶囊 + 单列浮层 + 配置页「新对话默认」共用同一份元数据） */
export const ORCHESTRATION_MODE_META = [
  { id: 'direct', short: '直出', name: '直出模式', option: '直出（默认关闭派发）', desc: '主会话独立直答 · 冻结并关闭子 Agent', cls: 'mode-direct dispatch-off' },
  { id: 'relay', short: '简单', name: '简单模式', option: '简单模式', desc: '确认意图 · 自选执行官单派/并派 · 主会话合并汇报', cls: 'mode-relay dispatch-on' },
  { id: 'complex', short: '复杂', name: '复杂自定义', option: '复杂自定义', desc: '军师/审核阶段可开关 · 三组角色自由勾选', cls: 'mode-complex dispatch-on' },
];
/** 旧模式无感归一：simple → relay、custom:* → complex；三档原样返回，其余回退 fallback。 */
export function normalizeModeId(raw, fallback = 'direct') {
  const value = String(raw ?? '').trim();
  if (value === 'simple') return 'relay';
  if (/^custom:[a-z0-9][a-z0-9_-]*$/.test(value)) return 'complex';
  if (ORCHESTRATION_MODE_META.some((m) => m.id === value)) return value;
  return fallback;
}
export function orchestrationModeMeta(mode) {
  const id = normalizeModeId(mode);
  return ORCHESTRATION_MODE_META.find((m) => m.id === id) || ORCHESTRATION_MODE_META[0];
}

/* v0.1.1 分模式阵容 modeProfiles（与后端 settings.modeProfiles / activeMode.modeProfiles 字段一字不差） */
export const MODE_PROFILE_IDS = ['relay', 'complex'];
export const MODE_PROFILE_GROUPS = { relay: ['executor'], complex: ['advisor', 'executor', 'reviewer', 'curator'] };
export const MODE_PROFILE_LABELS = { relay: '简单模式阵容', complex: '复杂自定义阵容' };
export const DEFAULT_MODE_PROFILES = {
  relay: {
    executor: { enabledKeys: ['executor_kimi', 'executor_codex', 'executor_claude', 'executor_hydrogen'], preferredKey: 'executor_claude' },
  },
  complex: {
    advisor: { stageEnabled: true, enabledKeys: ['advisor_kimi', 'advisor_codex', 'advisor_claude'] },
    executor: { enabledKeys: ['executor_kimi', 'executor_codex', 'executor_claude', 'executor_hydrogen'], preferredKey: 'executor_claude' },
    reviewer: { stageEnabled: true, enabledKeys: ['reviewer'], preferredKey: 'reviewer' },
    // 规范维护组：阵容全局共用；自动维护开关按项目独立保存于 specCurationByProject（不在此处、无 stageEnabled）
    curator: { enabledKeys: ['curator_codex'], preferredKey: 'curator_codex' },
  },
};
/** 阵容微摘要里的成员短名（内置成员取引擎 / 模型代号，自定义成员截断显示名）。 */
export const ROLE_CHIP_NAMES = {
  advisor_kimi: 'Kimi', advisor_codex: 'Astra', advisor_claude: 'Claude',
  executor_kimi: 'Kimi', executor_codex: 'Sol', executor_claude: 'Claude', executor_hydrogen: 'Hydrogen',
  reviewer: 'Astra', curator_codex: 'Astra',
};
function uniqueStrings(list) {
  return [...new Set((Array.isArray(list) ? list : []).map((k) => String(k || '').trim()).filter(Boolean))];
}
function groupMembersInOrder(group, presets) {
  const entries = Object.entries(presets || {}).filter(([key, p]) => p && key !== MEMBER_DRAFT_KEY && (p.group !== undefined ? p.group : seedGroupOf(key)) === group);
  const seedIndex = (key) => { const i = ROLE_SLOT_META.findIndex((s) => s.key === key); return i >= 0 ? i : ROLE_SLOT_META.length; };
  return entries.sort(([a, pa], [b, pb]) => seedIndex(a) - seedIndex(b) || String(pa.label || a).localeCompare(String(pb.label || b), 'zh-CN')).map(([key, p]) => ({ key, p }));
}
/**
 * modeProfiles 离线 / 存量兜底归一化：
 * - 远端结构优先；缺失时由 v0.1.0 旧版成员池（启停 enabled + 锁定 ★ + 翻译目标 ⇄）无感迁移；
 * - enabledKeys 去重、只保留当前成员池中真实属于该组的成员（成员池尚未加载时按内置种子组归属放行）；
 * - 执行组至少保留 1 名；preferredKey 必须在 enabledKeys 内，否则回落首位；stageEnabled 缺省 true。
 */
export function normalizeClientModeProfiles(rawProfiles, presets, legacyMemberPool, legacyRelayTarget) {
  const raw = rawProfiles && typeof rawProfiles === 'object' ? rawProfiles : null;
  const known = presets && typeof presets === 'object' && Object.keys(presets).length > 0 ? presets : null;
  const belongs = (key, group) => {
    const p = known?.[key];
    if (p) return (p.group !== undefined ? p.group : seedGroupOf(key)) === group;
    return !known && seedGroupOf(key) === group;
  };
  const pool = legacyMemberPool && typeof legacyMemberPool === 'object' ? legacyMemberPool : null;
  const legacyEnabled = (group) => (known
    ? groupMembersInOrder(group, known).filter(({ p }) => p.enabled !== false).map(({ key }) => key)
    : null);
  const out = {};
  for (const mode of MODE_PROFILE_IDS) {
    out[mode] = {};
    for (const group of MODE_PROFILE_GROUPS[mode]) {
      const base = DEFAULT_MODE_PROFILES[mode][group];
      const src = raw?.[mode]?.[group] && typeof raw[mode][group] === 'object' ? raw[mode][group] : null;
      let enabledKeys;
      let preferredKey;
      let stageEnabled = true;
      if (src) {
        enabledKeys = uniqueStrings(src.enabledKeys);
        preferredKey = src.preferredKey;
        if (typeof src.stageEnabled === 'boolean') stageEnabled = src.stageEnabled;
      } else {
        // 旧版迁移：仍启用的成员即本模式勾选池；锁定 ★ / 翻译目标 ⇄ 迁为首选
        enabledKeys = legacyEnabled(group) ?? [...base.enabledKeys];
        const legacyStar = pool?.[group]?.defaultPresetKey;
        preferredKey = mode === 'relay' && legacyRelayTarget ? legacyRelayTarget : legacyStar || base.preferredKey;
        if (!enabledKeys.length && group !== 'executor') stageEnabled = false;
      }
      enabledKeys = enabledKeys.filter((k) => belongs(k, group) && !(known && group === 'curator' && isCuratorBlockedProvider(known[k]?.provider)));
      if (group === 'executor' && !enabledKeys.length) {
        const fallback = [preferredKey, base.preferredKey, ...(known ? groupMembersInOrder(group, known).map(({ key }) => key) : base.enabledKeys)]
          .find((k) => k && belongs(k, group));
        if (fallback) enabledKeys = [fallback];
      }
      const entry = {};
      if (group === 'advisor' || group === 'reviewer') entry.stageEnabled = stageEnabled;
      entry.enabledKeys = enabledKeys;
      if (group !== 'advisor') entry.preferredKey = enabledKeys.includes(preferredKey) ? preferredKey : enabledKeys[0] || null;
      out[mode][group] = entry;
    }
  }
  return out;
}
export const ROLE_ROW_TITLES = {
  advisor_kimi: '军师 A · 全景架构',
  advisor_codex: '军师 B · 严密推演',
  advisor_claude: '军师 C · 产品架构',
  executor_kimi: '执行 · 跨文件贯通',
  executor_codex: '执行 · 系统攻坚',
  executor_claude: '执行 · 全栈全能',
  executor_hydrogen: '执行 · 前端推演（宿主）',
  reviewer: '终审官 · 审改一体',
  curator_codex: '规范维护官 · 只读提案',
};
export const ROLE_ROW_DESCS = {
  advisor_kimi: '超长上下文通读全仓，输出全局架构方案与模块边界',
  advisor_codex: '交叉审视状态机漏洞、并发竞态与算法边界',
  advisor_claude: '全栈与产品视角的架构方案',
  executor_kimi: '多文件联动修改、协议适配、脚本工程与中文文档',
  executor_codex: '核心状态机、数据存储、后端服务与严密单测闭环',
  executor_claude: '前后端小全能执行',
  executor_hydrogen: '经宿主原生 invoke_subagent 调度，免外部 CLI 套娃',
  reviewer: '严查缺陷，当场修复、自测并汇报主会话',
  curator_codex: '只读梳理拍板结论，提案增删合并项目规范，确认后落盘',
};
export const ROLE_SHORT_TITLES = {
  advisor_kimi: '军师 A',
  advisor_codex: '军师 B',
  advisor_claude: '军师 C',
  executor_kimi: '跨文件执行',
  executor_codex: '攻坚执行',
  executor_claude: '全能执行',
  executor_hydrogen: '前端执行',
  reviewer: '终审官',
  curator_codex: '维护官',
};
export const PRESET_FIELD_LABELS = { provider: '执行引擎', model: '指派模型', effort: '思考强度', permissionMode: '权限策略', isolation: '目录隔离' };
/**
 * v0.3.2 双顶层配置拆分：项目配置（roles / project / cache）与全局配置（general / global-roles / extensions / catalog）。
 */
export const PROJECT_SETTINGS_PANES = ['roles', 'project', 'cache'];
export const GLOBAL_SETTINGS_PANES = ['general', 'global-roles', 'extensions', 'catalog'];
export const SETTINGS_PANES = [...PROJECT_SETTINGS_PANES, ...GLOBAL_SETTINGS_PANES];
export const SETTINGS_SCOPES = ['project', 'global'];
export const SETTINGS_PANE_SCOPE = {
  roles: 'project',
  project: 'project',
  cache: 'project',
  general: 'global',
  'global-roles': 'global',
  extensions: 'global',
  catalog: 'global',
};
export const SETTINGS_SCOPE_DEFAULT_PANE = { project: 'roles', global: 'general' };
export function settingsScopeOf(pane) {
  return SETTINGS_PANE_SCOPE[pane] || 'project';
}
export function settingsPaneKey() {
  return 'at-settings-pane:' + location.pathname;
}
export const RESET_ALL_PRESETS_CONFIRM = 'presets:reset-all';
export function readStoredSettingsPane() {
  try {
    const pane = sessionStorage.getItem(settingsPaneKey());
    return SETTINGS_PANES.includes(pane) ? pane : 'roles';
  } catch {
    return 'roles';
  }
}

// v0.2.10.2 看板窗口化渲染：工具栏档位 20 / 50 / 全部（localStorage 持久化，存储受限时回退默认 20）
export const BOARD_PAGE_SIZES = ['20', '50', 'all'];
export const BOARD_PAGE_SIZE_STORAGE_KEY = 'at_board_page_size';
export const MEMBERS_INACTIVE_DEFAULT_LIMIT = 15;
export function boardLimitFor(size) {
  return size === 'all' ? Infinity : Number(size) || 20;
}
export function readStoredBoardPageSize() {
  try {
    const size = localStorage.getItem(BOARD_PAGE_SIZE_STORAGE_KEY);
    return BOARD_PAGE_SIZES.includes(size) ? size : '20';
  } catch {
    return '20';
  }
}
export function storeBoardPageSize(size) {
  try {
    localStorage.setItem(BOARD_PAGE_SIZE_STORAGE_KEY, size);
  } catch {}
}
/** 切换对话 / 重置看板水位时：可见窗口回到当前档位、成员折叠回到默认 15 位、看板签名作废。 */
export function resetBoardWindowState() {
  state.boardSig = '';
  state.boardVisibleLimit = boardLimitFor(state.boardPageSize);
  state.membersInactiveLimit = MEMBERS_INACTIVE_DEFAULT_LIMIT;
  state.boardChipsExpanded = false;
}

export const EFFORT_LABELS = {
  inherit: '🔗 跟随默认',
  off: '关闭 (Off)',
  disabled: 'disabled (关闭思考)',
  enabled: 'enabled (开启思考)',
  minimal: 'minimal (极轻)',
  low: 'low (轻量)',
  medium: 'medium (均衡)',
  high: 'high (深入)',
  xhigh: 'xhigh (极高)',
  max: 'max (满血)',
  ultra: 'ultra (超阶推演)',
};

export const STATUS_LABELS = {
  preparing: '准备 Worktree',
  queued: '队列等待',
  starting: '启动中',
  running: '工作中',
  // v0.2.6：`waiting` 专指原生 Swarm 成员 swarm_wait 待命（中性完成态）；等待人工输入统一归一为 `waiting_input`
  waiting: '待命中',
  waiting_host_dispatch: '待宿主派遣',
  pending_approval: '待审批',
  waiting_input: '待输入',
  completed: '已完成',
  interrupted: '已中断',
  cancelled: '已取消',
  failed: '执行失败',
  idle: '等待中',
};

/* ========================================================================
 * 3. 全局响应式状态仓 (State Store)
 * ======================================================================== */
export const state = {
  version: '__STUDIO_VERSION__',
  studioUrl: '',
  workspace: '', // app.js initState(): getInitialQueryWorkspace()
  projectName: '',
  themeMode: 'auto',

  // 单会话物理级独立隔离态（绑定当前对话 conversationId）
  activeConversationId: '', // app.js initState(): getHostConversationId() || getInitialQueryConversationId()
  rootConversationId: '',
  conversationTitle: '',
  availableConversations: [],
  // 独立网页端裸打开且无法自动绑定时为 true：会话事件一律忽略、写操作拦截，顶栏胶囊显示「未选对话」
  conversationUnbound: false,
  suggestedConversationId: '', // Bootstrap 下发的插件当前活跃会话提示
  conversationEpoch: 0, // 切换绑定时递增，作废旧会话的在途读取
  bootstrapSeq: 0, // Bootstrap 请求递增序号（防旧请求乱序覆盖）

  // v0.1.0：新开对话默认 direct（关闭派发），dispatchEnabled 仅为 orchestrationMode 的派生兼容列
  defaultDispatchEnabled: false,
  defaultOrchestrationMode: 'direct',
  // v0.3.0 全局「新项目默认开启项目规范（Spec）」（出厂 false）；defaultSpecSaving 为保存中的乐观值
  defaultSpecEnabled: false,
  defaultSpecSaving: null,
  defaultExternalSessionVisible: false,
  defaultExternalSessionSaving: null,
  autoCheckUpdates: true,
  autoCheckUpdatesSaving: null,
  systemUpdate: null,
  systemUpdateBusy: '',
  systemUpdateCancelPending: false,
  projectExternalSessionSaving: '',
  // v0.3.0 当前项目配置摘要（bootstrap / saveSettings / project_config_updated 下发）与全局默认成员池模板摘要
  projectConfig: null, // { workspace, projectKey, rosterSource, rosterCustomized, rosterRevision, specEnabled }
  globalTemplate: null, // { presetRevision, presets, modeProfiles, deletedPresets, counts }
  rosterActionBusy: '', // 'sync' | 'reset'：同步为全局默认 / 恢复为全局默认在途锁
  activeMode: null,
  conversationPolicy: {
    conversationId: '',
    rootConversationId: '',
    orchestrationMode: 'direct',
    dispatchEnabled: false,
    defaultOrchestrationMode: 'direct',
    defaultDispatchEnabled: false,
    policyRevision: 0,
    source: 'default',
    runningCount: 0,
    queuedCount: 0,
    updatedAt: null,
  },
  healthIncidents: [],
  // 已被用户「忽略 / 全部已读」的告警 ID：乐观隐藏，过滤迟到的在途 api/events 快照，杜绝横幅闪回
  dismissedIncidentIds: new Set(),

  providers: [],
  presets: {}, // 动态成员池：key → 完整预设（全成员平权；离线种子仅在远端成员表到达前兜底）
  memberPool: structuredClone(DEFAULT_MEMBER_POOL),
  relayTargetPresetKey: DEFAULT_RELAY_TARGET,
  deletedPresets: [],
  extensionTemplates: [...BUILTIN_EXTENSION_TEMPLATES_UI],
  customProviders: [],
  editingExtId: '',
  reviewDraft: {
    reviewMode: 'review_and_fix',
    scope: 'uncommitted',
    baseBranch: 'main',
    provider: 'codex',
    model: 'gpt-6.2-astra',
    effort: 'xhigh',
    cwd: '',
    labelSuffix: '当前项目改动',
    parentThreadId: '',
  },
  customModelPrompt: null,

  threadsMap: new Map(),
  archivedThreadIds: new Set(),
  boardMessages: [],
  collaborationEdges: [],
  boardSig: '', // 最近一次 api/events / Bootstrap 下发的看板签名；轮询回传，未变时后端省略看板大数组
  worktrees: [],
  pendingRequests: new Map(),
  stats: {
    running: 0,
    pending: 0,
    completed: 0,
    failed: 0,
    inputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  },

  latestSeq: 0,
  connMode: 'connecting', // app.js initState(): 宿主内嵌为 'poll'
  sse: null,
  pollTimer: null,
  pollInFlight: false,
  sseReconnectTimer: null,

  // Swarm 5 大核心视图状态
  activeView: 'board', // 'board' | 'members' | 'diff' | 'settings' | 'global'
  selectedThreadId: '',
  manualTarget: false,
  detailDrawerThreadId: '',
  drawerLastThreadId: '',

  // 看板过滤与折叠持久化状态
  boardSearch: '',
  boardFiltersOpen: false,
  boardFollow: true,
  boardUserScrolledUp: false,
  boardMemberFilters: new Set(),
  boardPageSize: '20', // app.js initState(): readStoredBoardPageSize()；'20' | '50' | 'all'
  boardVisibleLimit: 20, // 当前可见窗口条数（加载更早时递增，Infinity 表示全部）
  boardChipsExpanded: false,
  expandedTraces: new Set(),
  expandedToolIds: new Set(),
  expandedBodies: new Set(),
  expandedSpecBadges: new Set(), // v0.2.0 对话气泡「Spec ×N」徽标展开明细（键：看板 postId / 抽屉 md:<threadId>:<itemId>）
  expandedPrompts: new Set(),

  // 成员视图 & 拓扑视图过滤
  membersStatusFilter: 'all', // 'all' | 'active' | 'completed'
  membersInactiveLimit: 15, // 非活跃成员默认只渲染最近 15 位，其余折叠
  graphHideIdle: false,

  // Worktree & Diff 状态
  selectedWorktreeId: '',
  selectedDiffFile: '',
  diffMode: 'working_tree',
  currentWorktreeDiff: null,
  loadingDiff: false,

  // Composer 状态
  composerPopoverOpen: false,
  composer: {
    presetKey: '',
    provider: 'kimi-code',
    model: 'kimi-code/k3.1-pro',
    effort: 'high',
    permissionMode: 'auto',
    interactionMode: 'default',
    isolation: 'shared',
  },

  interruptTracker: new Map(), // threadId -> { escalated, timer, runId }（runId 绑定首击回合，作 expectedRunId）
  cancelInFlight: new Set(), // 防连击：同一线程同一时刻只允许一个 cancelTask 在途
  pendingConfirms: new Map(), // Inline 2-click safety confirm map: key -> expiryTs
  hydratingThreadIds: new Set(),

  dispatchMode: 'single',
  selectedPresetChip: 'executor_codex',
  dispatchPresetDetached: false,
  reviewDraftCustomized: false,
  batchDrafts: [],
  retryContext: null,

  renderScheduled: false,
  boardNeedsAutoScroll: false,

  // 配置页纯 UI 态（不入存储结构、不入 RPC）
  settingsPane: 'roles', // app.js initState(): readStoredSettingsPane()；'roles' | 'project' | 'cache' | 'general' | 'global-roles' | 'extensions' | 'catalog'
  settingsScope: 'project', // 配置作用域（由 settingsPane 派生）：'project' | 'global'
  settingsScopePanes: { project: 'roles', global: 'general' }, // 各配置视图上次停留的子页面
  // v0.3.2 全局默认成员池独立编辑状态（全部挂在 state 单例上，零 export let，与项目成员池物理隔离）
  globalPresets: {},
  globalModeProfiles: structuredClone(DEFAULT_MODE_PROFILES),
  globalEditingModeProfile: 'complex',
  globalOpenMemberKey: '',
  globalCollapsedGroups: new Set(),
  globalDirtyPresets: new Map(),
  globalDirtyModeProfiles: new Map(),
  globalEditedPresets: new Set(),
  globalCommittedPresets: new Map(),
  globalCommittedModeProfiles: null,
  globalPendingDeletes: new Set(),
  globalDeletedPresets: [],
  globalServerRevision: -1,
  globalPresetTimer: undefined,
  globalPresetSaving: false,
  globalPresetSavePromise: null,
  globalPresetSaveIdleTimer: 0,
  globalMemberDraftKeyTouched: false,
  catalogOpen: new Set(), // 引擎目录手风琴展开集合
  catalogQuery: '',
  catalogSearchCollapsed: new Set(), // 搜索期间被手动收起的引擎
  extLibOpen: false, // 扩展「可接入模板库」折叠态
  // v0.1.2 运行缓存清理：按需拉取（切入「全局与扩展」或会话 / 工作区变化后），不做定时轮询
  runtimeCache: { loading: false, cleaning: false, loadedForWorkspace: '', data: null, lastResult: null, error: '' },
  // v0.2.0 项目规范（Spec）：与运行缓存同款按需只读拉取；bodies 为点开单条后懒加载的只读正文（key → spec）
  projectSpecs: { loading: false, initializing: false, loadedForWorkspace: '', data: null, error: '', openKey: '', bodies: {}, bodyLoading: '', bodyError: '' },
  // v0.2.11 规范维护（按项目）：服务端快照（bootstrap.specCuration / listProjectSpecs.curation / SSE spec_curation_updated）
  specCuration: emptySpecCuration(),
  // 规范维护纯 UI 态：在途动作锁、手动触发工具条与打回意见输入（不入存储、不入 RPC 快照）
  specCurationUi: { busy: '', triggerOpen: false, note: '', reviseOpen: false, feedback: '', statusLoadedFor: '', statusLoading: false, watchRun: '', openDetails: new Set() },

  // ---- 原 app.js 顶层可变标量（v0.0.4 统一收归状态仓，禁止 export let） ----
  uiRenderFrozen: false, // 自绘下拉展开期间冻结整页重绘
  uiRenderDeferred: false, // 冻结期间有被延后的重绘
  worktreeDiffSeq: 0, // Diff 请求递增序号（防迟到响应乱序覆盖）
  // 角色预设：槽位编辑版本号保护在途修改；持久化 revision 为 bootstrap / SSE / RPC 回执排序
  dirtyPresets: new Map(),
  dirtyMemberPool: new Map(),
  editedPresets: new Set(),
  committedPresets: new Map(),
  presetVersion: 0,
  serverPresetRevision: -1,
  // v0.3.0 按项目隔离：presetProjectKey 为当前已加载阵容所属项目键（'' = 未绑定 / 全局模板）；
  // presetEditTarget 为首次编辑时捕获的保存目标 { workspace, projectKey }；presetProjectEpoch 在切换项目时递增，作废在途保存回执
  presetProjectKey: null, // null = 尚未收到任何项目配置（首次下发时直接采用，不做隔离）
  presetEditTarget: null,
  presetProjectEpoch: 0,
  presetTimer: undefined,
  presetSaving: false,
  presetSavePromise: null,
  presetSaveIdleTimer: 0,
  // 成员池：删除与恢复默认队列；v0.1.0 旧版组策略 / 翻译目标只读基线（仅供 modeProfiles 迁移）
  pendingDeletes: new Set(),
  pendingResets: new Set(),
  committedMemberPool: null,
  committedRelayTarget: '',
  committedModeProfilesFromServer: false, // 已收到 settings.modeProfiles（此后 activeMode 中的阵容只作快照、不再覆盖）
  // v0.1.1 分模式阵容：本地乐观值 / 远端基线 / 待保存的 "mode.group" → version
  modeProfiles: structuredClone(DEFAULT_MODE_PROFILES),
  committedModeProfiles: null,
  dirtyModeProfiles: new Map(),
  editingModeProfile: '', // 配置页当前编辑的阵容（纯 UI 态）：'relay' | 'complex'，首次进入配置页时按当前对话模式决定
  memberDraftKeyTouched: false, // 新增成员草稿：用户手动改过键名后不再随显示名自动生成
  openMemberKey: '', // 配置页当前展开内联抽屉的成员
  collapsedGroups: new Set(),
  // 顶栏模式胶囊
  modePopoverOpen: false,
  modeSwitching: null, // 乐观切换中的目标模式
  lastNonDirectMode: 'relay',
  bootstrapLoaded: false,
  bootstrapInFlight: false, // v0.2.6：Bootstrap 补拉单飞锁（断线恢复 / 可见性唤醒幂等重拉）
  bootstrapPromise: null,
  // 前端资产热刷新
  loadedAssetHash: '', // app.js initState(): <meta name="agent-tower-asset-hash">
  latestAssetHash: '',
  reloadStarted: false,
  assetProbeInFlight: false, // v0.2.6：新资产哈希刷新前 api/health 探活单飞锁
  // 配置页渲染辅助态
  mainScrollResetPending: false,
  pendingSettingsFocus: null, // { keys: string[], scroll?: boolean }
  catalogOpenInitialized: false,
  defaultDispatchSaving: null, // 「新开对话默认」保存中的乐观模式值
  // 派发抽屉当前联动选择
  dispatchSelection: { provider: 'codex', model: 'gpt-6.2-sol', effort: 'high', permissionMode: 'full-access' },
};

export function normalizeStatus(rawStatus) {
  const s = String(rawStatus || 'idle').toLowerCase();
  if (s === 'in_progress' || s === 'inprogress' || s === 'active' || s === 'working') return 'running';
  if (s === 'waiting_approval' || s === 'approval_requested') return 'pending_approval';
  if (s === 'waiting_question' || s === 'waiting_input') return 'waiting_input';
  if (s === 'succeeded' || s === 'success' || s === 'done') return 'completed';
  if (s === 'error' || s === 'errored') return 'failed';
  if (s === 'canceled' || s === 'aborted' || s === 'stopped') return 'interrupted';
  return s;
}

export function isStatusActive(status) {
  const s = normalizeStatus(status);
  return s === 'preparing' || s === 'queued' || s === 'starting' || s === 'running' || s === 'waiting_input' || s === 'pending_approval';
}

/** v0.2.6：原生 Swarm 待命（waiting）与待宿主派遣（waiting_host_dispatch）为中性非活跃态，不计入工作中 / 待介入。 */
export function isStatusStandby(status) {
  const s = normalizeStatus(status);
  return s === 'waiting' || s === 'waiting_host_dispatch';
}

export function isStatusPendingIntervention(thread) {
  const s = normalizeStatus(thread?.status);
  if (s === 'waiting_input' || s === 'pending_approval') return true;
  for (const req of state.pendingRequests.values()) {
    if (req.threadId === thread?.id && req.status === 'pending') return true;
  }
  return false;
}

/* ========================================================================
 * 5. 单一可信数据源：单会话物理级独立隔离选择器
 * ======================================================================== */
export function getEffectiveConversationId() {
  return typeof window !== 'undefined' && window.sidecar ? getHostConversationId() : state.activeConversationId || '';
}

export function getEffectiveCwd() {
  for (const t of getScopedThreads()) {
    const candidate = t.projectRoot || (!isWorktreeOrTempPath(t.cwd) ? t.cwd : '');
    if (candidate) return normalizeProjectPath(candidate);
  }
  return state.workspace ? normalizeProjectPath(state.workspace) : '';
}

export function getScopedThreads() {
  const activeRoot = state.rootConversationId || state.activeConversationId || getHostConversationId();
  const all = Array.from(state.threadsMap.values()).filter((t) => {
    if (t.archived) return false;
    if (activeRoot && t.rootConversationId && t.rootConversationId.toLowerCase() !== activeRoot.toLowerCase()) return false;
    return true;
  });
  return all.sort((a, b) => memberPriority(a) - memberPriority(b) || b.updatedAt - a.updatedAt);
}

export function memberPriority(t) {
  if (isStatusPendingIntervention(t)) return 0;
  if (isStatusActive(t.status)) return !t.isNativeHost || t.parentThreadId ? 1 : 2;
  return t.status === 'failed' ? 3 : 4;
}

export function getScopedWorktrees() {
  const activeRoot = state.rootConversationId || state.activeConversationId || getHostConversationId();
  const scopedIds = new Set(getScopedThreads().map((t) => t.id));
  return state.worktrees.filter((w) => {
    if (activeRoot && w.rootConversationId && w.rootConversationId.toLowerCase() !== activeRoot.toLowerCase()) return false;
    if (w.threadId) {
      return scopedIds.has(w.threadId);
    }
    return !activeRoot || Boolean(w.rootConversationId && w.rootConversationId.toLowerCase() === activeRoot.toLowerCase());
  });
}

export function getScopedRequests() {
  const activeRoot = state.rootConversationId || state.activeConversationId || getHostConversationId();
  const scopedIds = new Set(getScopedThreads().map((t) => t.id));
  const list = [];
  for (const req of state.pendingRequests.values()) {
    if (req.status !== 'pending') continue;
    if (activeRoot && req.rootConversationId && req.rootConversationId.toLowerCase() !== activeRoot.toLowerCase()) continue;
    if (req.threadId) {
      if (scopedIds.has(req.threadId)) list.push(req);
    } else if (!activeRoot || (req.rootConversationId && req.rootConversationId.toLowerCase() === activeRoot.toLowerCase())) {
      list.push(req);
    }
  }
  return list;
}

export function isConversationCollaborationEmpty(threads = getScopedThreads(), boardMsgs = state.boardMessages) {
  if (Array.isArray(boardMsgs) && boardMsgs.length > 0) return false;
  if (threads.length === 0) return true;
  if (
    threads.length === 1 &&
    threads[0].isNativeHost &&
    !threads[0].isSwarmMember &&
    !threads[0].error &&
    !threads[0].parentThreadId
  ) {
    return true;
  }
  return false;
}

export function recomputeScopedStats() {
  const threads = getScopedThreads();
  let running = 0;
  let completed = 0;
  let failed = 0;
  let inputTokens = 0;
  let cachedTokens = 0;
  let reasoningTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;

  for (const t of threads) {
    const s = normalizeStatus(t.status);
    if (isStatusActive(s)) running++;
    else if (s === 'completed' || s === 'waiting') completed++;
    else if (s === 'failed') failed++;

    const usage = t.cumulativeUsage || t.usage || {};
    inputTokens += usage.inputTokens || 0;
    cachedTokens += usage.cachedTokens || 0;
    reasoningTokens += usage.reasoningTokens || 0;
    outputTokens += usage.outputTokens || 0;
    totalTokens += usage.totalTokens || 0;
  }

  const pending = getScopedRequests().length;
  state.stats = {
    running,
    pending,
    completed,
    failed,
    inputTokens,
    cachedTokens,
    reasoningTokens,
    outputTokens,
    totalTokens,
  };
}

export function syncActiveTargetThread() {
  const scoped = getScopedThreads();
  const current = scoped.find(t => t.id === state.selectedThreadId);
  const top = scoped[0];
  if (state.manualTarget && (!state.selectedThreadId || (current && memberPriority(current) <= 2))) return;
  const next = top && memberPriority(top) <= 2 ? top : current || top;
  if (current && current === next) return;
  state.manualTarget = false;
  state.selectedThreadId = next?.id || '';
  if (next) applyThreadToComposerConfig(next);
}

/* ========================================================================
 * 6. v0.1.1 三档编排模式、三组弹性成员池与分模式阵容 modeProfiles 纯选择器
 * ======================================================================== */
/** 当前对话生效模式：乐观切换中的目标优先，其次服务端策略，缺省 direct（旧布尔 true → relay）。 */
export function currentOrchestrationMode() {
  if (state.modeSwitching) return normalizeModeId(state.modeSwitching);
  const policy = state.conversationPolicy || {};
  if (policy.orchestrationMode) return normalizeModeId(policy.orchestrationMode);
  return policy.dispatchEnabled === true ? 'relay' : 'direct';
}

export function seedGroupOf(key) {
  return MEMBER_GROUPS.find((g) => g.keys.includes(key))?.id || null;
}

/** 离线种子成员的完整预设（远端成员表到达前的本地兜底；v0.2.2 全成员平权，统一 builtin: false）。 */
export function seedPreset(key) {
  const slot = ROLE_SLOT_META.find((s) => s.key === key);
  if (!slot) return null;
  return { key, label: slot.label, title: slot.label, group: seedGroupOf(key), role: slot.role, enabled: true, builtin: false, description: slot.desc, ...slot.defaults };
}

export function isPoolGroup(group) {
  return MEMBER_GROUP_IDS.includes(group);
}

export function isPresetEnabled(preset) {
  return Boolean(preset) && preset.enabled !== false;
}

/** 成员所属组：显式 group 优先；旧版仅含路由字段的内置种子草稿按种子组归属。 */
export function presetGroupOf(key, preset = state.presets[key]) {
  return preset && preset.group !== undefined ? preset.group : seedGroupOf(key);
}

function presetOrderIndex(p) {
  const i = ROLE_SLOT_META.findIndex((s) => s.key === p.key);
  return i >= 0 ? i : ROLE_SLOT_META.length;
}

/** 某组全部成员（成员目录，与模式无关）：离线种子键按种子顺序在前，其余成员按显示名排序。 */
export function listPoolMembers(group, scope = 'project') {
  const presets = scope === 'global' ? state.globalPresets : state.presets;
  const deletes = scope === 'global' ? state.globalPendingDeletes : state.pendingDeletes;
  return Object.entries(presets)
    .filter(([key, p]) => p && key !== MEMBER_DRAFT_KEY && presetGroupOf(key, p) === group && !deletes.has(key))
    .map(([key, p]) => (p.key === key && p.group !== undefined ? p : { ...p, key, group }))
    .sort((a, b) => presetOrderIndex(a) - presetOrderIndex(b) || String(a.label || a.key).localeCompare(String(b.label || b.key), 'zh-CN'));
}

/** 删光默认成员后的空安全回退：对应组首个成员 → 任意三组成员 → 成员池中任意成员 → null（不再假设固定键必定存在）。 */
export function fallbackGroupPreset(group) {
  const live = (p) => p && p.key && p.key !== MEMBER_DRAFT_KEY && !state.pendingDeletes.has(p.key);
  return (isPoolGroup(group) ? listPoolMembers(group)[0] : null)
    || DISPATCH_GROUP_IDS.flatMap((g) => listPoolMembers(g))[0]
    || Object.values(state.presets).find(live)
    || null;
}
/** 成员池完全为空时供派发表单 / 批量行使用的最小占位路由（不携带 presetKey）。 */
export const EMPTY_MEMBER_FALLBACK = Object.freeze({ key: '', label: '', role: 'implementation', provider: 'codex', model: '', effort: 'high', permissionMode: 'default', interactionMode: 'default', isolation: 'shared' });

export function presetDisplayLabel(key, scope = 'project') {
  const presets = scope === 'global' ? state.globalPresets : state.presets;
  const p = presets[key];
  return String(p?.label || ROLE_SLOT_META.find((s) => s.key === key)?.label || key || '');
}

/** 阵容微摘要短名：离线种子键取模型代号，其余成员截断显示名。 */
export function memberChipName(key) {
  if (ROLE_CHIP_NAMES[key]) return ROLE_CHIP_NAMES[key];
  const label = presetDisplayLabel(key);
  return label.length > 8 ? `${label.slice(0, 7)}…` : label;
}

/** 某模式某组的阵容条目（缺失时按默认结构兜底，不返回 undefined）。 */
export function modeGroupProfile(mode, group, scope = 'project') {
  const m = MODE_PROFILE_IDS.includes(mode) ? mode : 'relay';
  const profiles = scope === 'global' ? state.globalModeProfiles : state.modeProfiles;
  return profiles?.[m]?.[group] || DEFAULT_MODE_PROFILES[m]?.[group] || { enabledKeys: [] };
}

/** 阶段是否参与该模式：执行阶段常驻；简单模式无军师 / 审核阶段；复杂模式按 stageEnabled；规范维护组不是派发阶段。 */
export function isModeStageEnabled(mode, group, scope = 'project') {
  if (group === 'executor') return true;
  if (group === 'curator') return false;
  if (!MODE_PROFILE_GROUPS[mode]?.includes(group)) return false;
  return modeGroupProfile(mode, group, scope).stageEnabled !== false;
}

/** 阵容中已勾选的真实成员（按成员目录顺序；待删除 / 已不存在的键自动忽略）。 */
export function modeEnabledMembers(mode, group, scope = 'project') {
  if (!MODE_PROFILE_GROUPS[mode]?.includes(group)) return [];
  const keys = new Set(modeGroupProfile(mode, group, scope).enabledKeys || []);
  return listPoolMembers(group, scope).filter((p) => keys.has(p.key));
}

/** 派发面板按哪套阵容筛选：非直出 = 当前模式；直出时（派发已关闭）沿用上次的非直出模式仅作展示。 */
export function effectiveDispatchMode(mode = currentOrchestrationMode()) {
  if (mode !== 'direct') return mode;
  const last = normalizeModeId(state.lastNonDirectMode, 'relay');
  return last === 'direct' ? 'relay' : last;
}

/** 当前对话模式下某组有效启用成员：阶段关闭（或简单模式无此阶段）时为空。 */
export function activeGroupMembers(group, mode = effectiveDispatchMode()) {
  return isModeStageEnabled(mode, group) ? modeEnabledMembers(mode, group) : [];
}

/** 全界面严锁勾选池：当前对话模式下有效启用的全部成员（三组顺序）。 */
export function listDispatchablePresets(mode = effectiveDispatchMode()) {
  return DISPATCH_GROUP_IDS.flatMap((group) => activeGroupMembers(group, mode));
}

export function isPresetInActivePool(key, mode = effectiveDispatchMode()) {
  return Boolean(key) && listDispatchablePresets(mode).some((p) => p.key === key);
}

/** 阵容首选 ★：preferredKey 仍在勾选池内优先，否则勾选池首位。 */
export function preferredModeMember(mode, group) {
  const members = activeGroupMembers(group, mode);
  const key = modeGroupProfile(mode, group).preferredKey;
  return members.find((p) => p.key === key) || members[0] || null;
}

/** 组内默认派发对象（当前对话模式的阵容 ★）。 */
export function preferredGroupPreset(group, mode = effectiveDispatchMode()) {
  return preferredModeMember(mode, group);
}

/**
 * 阵容防呆：复杂模式军师 / 审核阶段已开启但勾选池为空 → 醒目的内联告警（不阻断保存，派单时由对应入口拦截）。
 * 执行组在交互层保护最后 1 名勾选成员，正常情况下不会为空。
 */
export function modeProfileIssues(mode, scope = 'project') {
  const issues = [];
  for (const group of MODE_PROFILE_GROUPS[mode] || []) {
    const meta = MEMBER_GROUPS.find((g) => g.id === group);
    const empty = modeEnabledMembers(mode, group, scope).length === 0;
    if (group === 'curator') {
      if (scope === 'project' && empty && currentSpecCuration().specEnabled && currentSpecCuration().autoTrigger) {
        issues.push({ mode, group, kind: 'curator_empty', blocking: false, message: '本项目已开启自动维护，但规范维护组未勾选任何成员：请勾选至少 1 名维护官，或关闭自动维护' });
      }
    } else if (group === 'executor' && empty) {
      issues.push({ mode, group, kind: 'executor_empty', blocking: false, message: '执行组至少保留 1 名执行官，请勾选一名成员' });
    } else if (group !== 'executor' && isModeStageEnabled(mode, group, scope) && empty) {
      issues.push({ mode, group, kind: 'stage_empty', blocking: false,
        message: `${meta?.stageTitle || group}已开启但未勾选任何成员：请勾选至少 1 名${meta?.title || ''}成员，或关闭该阶段` });
    }
  }
  return issues;
}

/** 顶栏模式浮层的阵容微摘要（简单模式：已选执行官；复杂：军师 → 执行 → 审核）。 */
export function modeRosterSummary(mode) {
  if (mode === 'relay') {
    const star = modeGroupProfile('relay', 'executor').preferredKey;
    // ★ 首选排在最前，其余按成员目录顺序
    const members = modeEnabledMembers('relay', 'executor').sort((a, b) => Number(b.key === star) - Number(a.key === star));
    return members.length
      ? `已选执行官：${members.map((p) => `${memberChipName(p.key)}${p.key === star ? '★' : ''}`).join(' · ')}`
      : '尚未勾选执行官';
  }
  if (mode === 'complex') {
    const stage = (group, label) => {
      const n = modeEnabledMembers('complex', group).length;
      return isModeStageEnabled('complex', group) ? `${label} 开(${n})` : `${label} 关`;
    };
    return `${stage('advisor', '军师')} → 执行(${modeEnabledMembers('complex', 'executor').length}) → ${stage('reviewer', '审核')}`;
  }
  return '';
}

export function applyThreadToComposerConfig(thread) {
  if (!thread) return;
  const presetCfg = !thread.isNativeHost && thread.presetKey && !isStatusActive(thread.status)
    ? state.presets[thread.presetKey]
    : null;
  state.composer.presetKey = thread.isNativeHost ? '' : String(thread.presetKey || '');
  state.composer.provider = presetCfg?.provider || thread.provider;
  state.composer.model = presetCfg?.model || thread.model;
  state.composer.effort = presetCfg?.effort || thread.effort;
  state.composer.permissionMode = thread.isNativeHost
    ? thread.permissionMode
    : (presetCfg?.permissionMode || thread.permissionMode);
  state.composer.interactionMode = thread.isNativeHost
    ? thread.interactionMode
    : (presetCfg?.interactionMode || thread.interactionMode);
  state.composer.isolation = thread.isolation;
}

/* ========================================================================
 * 7. v0.2.11 规范维护（Spec Curator）：按项目快照归一化与纯选择器
 *    自动维护开关按项目独立保存（缺省 false）；提案经 Studio 专用 specCuration RPC 整组确认 / 打回 / 放弃。
 * ======================================================================== */
export const SPEC_CURATION_CHANGE_LABELS = { create: '新增', update: '修改', delete: '删除' };
/** v0.3.0 归档快照（.agent-tower/spec-archive/）：exists / fileCount / archivedAt / hasActiveSpecs / conflictPaths。 */
export function emptySpecArchive() {
  return { exists: false, fileCount: 0, archivedAt: 0, hasActiveSpecs: false, conflictPaths: [] };
}
export function normalizeSpecArchive(raw) {
  const base = emptySpecArchive();
  if (!raw || typeof raw !== 'object') return base;
  const n = Number(raw.fileCount);
  const at = raw.archivedAt;
  return {
    exists: raw.exists === true,
    fileCount: Number.isFinite(n) && n > 0 ? Math.floor(n) : 0,
    archivedAt: typeof at === 'number' ? at : Number(at) || (typeof at === 'string' && at ? Date.parse(at) || 0 : 0),
    hasActiveSpecs: raw.hasActiveSpecs === true,
    conflictPaths: (Array.isArray(raw.conflictPaths) ? raw.conflictPaths : []).map(String).filter(Boolean).slice(0, 20),
  };
}
/** specEnabled 缺省 true：旧守护进程 / 旧测试桩未下发该字段时保持既有规范面板行为。 */
export function emptySpecCuration(workspace = '') {
  return {
    workspace, specEnabled: true, archive: emptySpecArchive(), autoTrigger: false,
    singleMaxKb: DEFAULT_SPEC_SINGLE_KB, totalMaxKb: DEFAULT_SPEC_TOTAL_KB,
    running: false, awaitingHost: false, activeHandoffId: null, activeExecutorKind: null,
    activeThreadId: null, activeRunId: null, lastNoChange: null, pendingProposal: null, recentProposals: [],
  };
}
function curationText(v) {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}
function curationIssues(list) {
  return (Array.isArray(list) ? list : []).map((i) => (typeof i === 'string' ? i : curationText(i?.message || i?.code))).filter(Boolean);
}
function normalizeCurationChange(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const bytes = Number(raw.bodyBytes);
  return {
    action: ['create', 'update', 'delete'].includes(raw.action) ? raw.action : 'update',
    path: curationText(raw.path), title: curationText(raw.title), why: curationText(raw.why),
    changeSummary: curationText(raw.changeSummary), mergedOrRemoved: curationText(raw.mergedOrRemoved), impactAndTests: curationText(raw.impactAndTests),
    content: curationText(raw.content), diffPreview: curationText(raw.diffPreview),
    bodyBytes: raw.bodyBytes != null && Number.isFinite(bytes) ? Math.max(0, bytes) : null,
    preflightOk: raw.preflightOk !== false, preflightIssues: curationIssues(raw.preflightIssues),
  };
}
/** 提案记录归一化：只保留 UI 需要的字段，变更集逐条归一；任一条预检未通过、解析失败或变更集为空都会拉低整组 preflightOk。 */
export function normalizeSpecProposal(raw) {
  if (!raw || typeof raw !== 'object' || !raw.id) return null;
  const changes = (Array.isArray(raw.changes) ? raw.changes : []).map(normalizeCurationChange).filter(Boolean);
  const parseError = curationText(raw.parseError);
  return {
    id: String(raw.id), status: curationText(raw.status) || 'pending', summary: curationText(raw.summary),
    threadId: curationText(raw.threadId), runId: curationText(raw.runId), triggerSource: curationText(raw.triggerSource) || 'manual',
    executorKind: curationText(raw.executorKind),
    changes, preflightIssues: curationIssues(raw.preflightIssues), parseError,
    preflightOk: raw.preflightOk !== false && !parseError && changes.length > 0 && changes.every((c) => c.preflightOk),
    createdAt: Number(raw.createdAt) || 0, updatedAt: Number(raw.updatedAt) || 0, resolvedAt: Number(raw.resolvedAt) || 0,
  };
}
export function normalizeSpecCuration(raw, fallbackWorkspace = '') {
  const base = emptySpecCuration(normalizeProjectPath(fallbackWorkspace));
  if (!raw || typeof raw !== 'object') return base;
  const pending = normalizeSpecProposal(raw.pendingProposal);
  const noChange = raw.lastNoChange && typeof raw.lastNoChange === 'object' ? raw.lastNoChange : null;
  const sKb = Number(raw.singleMaxKb);
  const singleMaxKb = Number.isInteger(sKb) && sKb >= 1 && sKb <= 8 ? sKb : DEFAULT_SPEC_SINGLE_KB;
  const tKb = Number(raw.totalMaxKb);
  const totalBase = Number.isInteger(tKb) && tKb >= 8 && tKb <= 128 ? tKb : DEFAULT_SPEC_TOTAL_KB;
  const totalMaxKb = Math.min(128, Math.max(totalBase, singleMaxKb * 2));
  return {
    ...base,
    workspace: normalizeProjectPath(curationText(raw.workspace)) || base.workspace,
    specEnabled: typeof raw.specEnabled === 'boolean' ? raw.specEnabled : true,
    archive: normalizeSpecArchive(raw.archive),
    autoTrigger: raw.autoTrigger === true,
    singleMaxKb,
    totalMaxKb,
    running: raw.running === true,
    awaitingHost: raw.awaitingHost === true,
    activeHandoffId: raw.activeHandoffId ? String(raw.activeHandoffId) : null,
    activeExecutorKind: raw.activeExecutorKind ? String(raw.activeExecutorKind) : null,
    activeThreadId: raw.activeThreadId ? String(raw.activeThreadId) : null,
    activeRunId: raw.activeRunId ? String(raw.activeRunId) : null,
    lastNoChange: noChange ? { reason: curationText(noChange.reason), at: Number(noChange.at || noChange.completedAt || noChange.createdAt) || 0 } : null,
    pendingProposal: pending && pending.status === 'pending' ? pending : null,
    recentProposals: (Array.isArray(raw.recentProposals) ? raw.recentProposals : []).map(normalizeSpecProposal).filter(Boolean).slice(0, 10),
  };
}
/** 当前项目目录（项目规范列表回执优先，其次当前对话工作区）。 */
export function specCurationWorkspace() {
  return normalizeProjectPath(state.projectSpecs?.data?.workspace || '') || getEffectiveCwd() || '';
}
function sameCurationProject(snapshotWs, activeWs) {
  const x = normalizeProjectPath(snapshotWs).toLowerCase();
  const y = normalizeProjectPath(activeWs).toLowerCase();
  if (!x) return true;
  return Boolean(y) && x === y;
}
/** 当前项目待人工决策的提案：pending 优先；预检未通过（invalid）或基线冲突（conflict）的最新提案同样允许打回重拟或放弃。 */
export function actionableSpecProposal(cur = currentSpecCuration()) {
  if (!cur || typeof cur !== 'object') return null;
  if (cur.pendingProposal) return cur.pendingProposal;
  if (cur.running) return null;
  const latest = Array.isArray(cur.recentProposals) ? cur.recentProposals[0] : null;
  if (!latest || (latest.status !== 'invalid' && latest.status !== 'conflict')) return null;
  const latestAt = latest.updatedAt || latest.createdAt || 0;
  const noChangeAt = cur.lastNoChange?.at || 0;
  if (noChangeAt > 0 && latestAt > 0 && noChangeAt >= latestAt) return null;
  return latest;
}
/**
 * 吸收服务端规范维护快照：其他项目的快照一律丢弃（双向开关只读写当前项目）；返回是否已采用。
 * 来源：bootstrap.specCuration / listProjectSpecs.curation / SSE spec_curation_updated / specCuration RPC 回执。
 */
export function applySpecCurationPayload(raw) {
  if (!raw || typeof raw !== 'object' || state.conversationUnbound) return false;
  const current = specCurationWorkspace();
  const next = normalizeSpecCuration(raw, current);
  if (!sameCurationProject(next.workspace, current)) return false;
  const prevActive = actionableSpecProposal(state.specCuration)?.id || '';
  state.specCuration = next;
  const ui = state.specCurationUi;
  ui.statusLoadedFor = normalizeProjectPath(next.workspace || current).toLowerCase();
  // 提案已换卡（确认 / 打回 / 放弃 / 新提案）：收起打回输入框并清空折叠展开记录
  if ((actionableSpecProposal(next)?.id || '') !== prevActive) {
    ui.reviseOpen = false;
    ui.feedback = '';
    ui.openDetails.clear();
  }
  return true;
}
/** 当前项目的规范维护快照：未绑定对话或快照属于其他项目（切换对话 / 工作区后尚未刷新）时回落缺省（自动维护关）。 */
export function currentSpecCuration() {
  const ws = specCurationWorkspace();
  if (state.conversationUnbound) return emptySpecCuration('');
  const cur = state.specCuration;
  return cur && sameCurationProject(cur.workspace, ws) ? cur : emptySpecCuration(ws);
}
/** 手动触发 / 自动维护默认拉起的维护官：复杂阵容规范维护组 ★ 优先，其次首个勾选成员。 */
export function preferredCuratorMember() {
  const members = modeEnabledMembers('complex', 'curator');
  const key = modeGroupProfile('complex', 'curator').preferredKey;
  return members.find((p) => p.key === key) || members[0] || null;
}

/* ========================================================================
 * 8. v0.3.0 全局 / 项目配置解耦：项目配置摘要、全局默认模板摘要与按项目选择器
 * ======================================================================== */
const ROSTER_SOURCES = ['project', 'global_template', 'unbound'];
/** projectConfig 归一化（缺字段的旧守护进程返回 null，前端回退旧版全局语义）。 */
export function normalizeProjectConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const workspace = normalizeProjectPath(curationText(raw.workspace));
  const source = ROSTER_SOURCES.includes(raw.rosterSource) ? raw.rosterSource : workspace ? (raw.rosterCustomized === true ? 'project' : 'global_template') : 'unbound';
  const rev = Number(raw.rosterRevision);
  const hasExternalSession = raw.externalSessionMode !== undefined || raw.externalSessionVisible !== undefined || raw.externalSessionCustomized !== undefined;
  const externalSessionMode = ['inherit', 'hidden', 'visible'].includes(raw.externalSessionMode) ? raw.externalSessionMode : 'inherit';
  return {
    workspace,
    projectKey: curationText(raw.projectKey) || projectPathKey(workspace),
    rosterSource: source,
    rosterCustomized: raw.rosterCustomized === true || source === 'project',
    rosterRevision: Number.isFinite(rev) ? rev : 0,
    specEnabled: typeof raw.specEnabled === 'boolean' ? raw.specEnabled : null,
    ...(typeof raw.specCustomized === 'boolean' ? { specCustomized: raw.specCustomized } : {}),
    ...(hasExternalSession ? {
      externalSessionMode,
      externalSessionVisible: typeof raw.externalSessionVisible === 'boolean' ? raw.externalSessionVisible : externalSessionMode === 'visible',
      externalSessionCustomized: typeof raw.externalSessionCustomized === 'boolean' ? raw.externalSessionCustomized : externalSessionMode !== 'inherit',
    } : {}),
  };
}
function countTemplateGroups(presets) {
  const counts = { advisor: 0, executor: 0, reviewer: 0, curator: 0, total: 0 };
  for (const p of Object.values(presets || {})) {
    if (!p || typeof p !== 'object' || !Object.hasOwn(counts, p.group)) continue;
    counts[p.group]++;
    counts.total++;
  }
  return counts;
}
/** globalTemplate 归一化：counts 缺省时按 presets.group 现算。 */
export function normalizeGlobalTemplate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const presets = raw.presets && typeof raw.presets === 'object' ? raw.presets : {};
  const rev = Number(raw.presetRevision);
  const computed = countTemplateGroups(presets);
  const counts = raw.counts && typeof raw.counts === 'object'
    ? Object.fromEntries(Object.keys(computed).map((k) => [k, Math.max(0, Number(raw.counts[k]) || 0)]))
    : computed;
  return {
    presetRevision: Number.isFinite(rev) ? rev : 0,
    presets,
    modeProfiles: raw.modeProfiles && typeof raw.modeProfiles === 'object' ? raw.modeProfiles : null,
    deletedPresets: Array.isArray(raw.deletedPresets) ? raw.deletedPresets.map(String) : [],
    counts,
  };
}
/** 当前项目的配置摘要：projectConfig 属于其他项目（切换对话 / 工作区后尚未刷新）时返回 null（子目录工作区视为同一主仓）。 */
export function currentProjectConfig() {
  const cfg = state.projectConfig;
  if (!cfg || state.conversationUnbound) return null;
  const ws = projectPathKey(getEffectiveCwd());
  const own = projectPathKey(cfg.workspace);
  if (!ws || !own) return own || ws ? null : cfg;
  return ws === own || ws === cfg.projectKey || ws.startsWith(`${own}/`) ? cfg : null;
}
/** 配置页「当前项目」工作区（未绑定对话或无工作区时为空）。 */
export function currentProjectWorkspace() {
  if (state.conversationUnbound) return '';
  return getEffectiveCwd() || normalizeProjectPath(currentProjectConfig()?.workspace || '') || '';
}
/** 当前项目键：优先采用服务端 projectConfig.projectKey（规范化主仓路径），否则按有效工作区现算。 */
export function currentProjectKey() {
  if (state.conversationUnbound) return '';
  return currentProjectConfig()?.projectKey || projectPathKey(getEffectiveCwd());
}
/** 本项目是否接入项目规范（Spec）：以规范维护快照为准（缺省 true 兼容旧守护进程）。 */
export function isProjectSpecEnabled() {
  return currentSpecCuration().specEnabled !== false;
}

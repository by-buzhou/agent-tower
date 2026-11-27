/**
 * @fileoverview AgentTower v0.2.0 — MCP Stdio JSON-RPC 2.0 服务入口 (`mcp-entry.mjs`)。
 *
 * 核心特性：
 * 1. 纯净 stdout 协议层防护：启动首行即将 `console.log/info/debug/warn` 重定向至 `stderr`，
 *    并静默过滤 Node 24 实验特性提示，确保 `stdout` 100% 仅输出合法 JSON-RPC 2.0 协议帧；
 * 2. 双模帧自动探测与兼容：无缝支持换行分隔 JSON（NDJSON）与 LSP `Content-Length` 头帧格式；
 * 3. 完整注册 **16 个** 跨平台多 Agent 编排、线程操控、代码终审、Git Worktree 闭环与
 *    开放平台扩展中心（`manage_providers`）MCP 工具，底层统一委托给单实例常驻 `Core Daemon`。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 0. Stdout 纯净度硬隔离（必须在加载任何业务模块前执行）
// ---------------------------------------------------------------------------
const rawStdoutWrite = process.stdout.write.bind(process.stdout);
const writeStderrLine = (...args) => {
  try {
    const text = args
      .map((item) => (typeof item === 'string' ? item : JSON.stringify(item)))
      .join(' ');
    process.stderr.write(`[agent-tower-mcp] ${text}\n`);
  } catch {
    // 忽略 stderr 写入异常
  }
};
console.log = writeStderrLine;
console.info = writeStderrLine;
console.debug = writeStderrLine;
console.warn = writeStderrLine;

const origEmitWarning = process.emitWarning;
if (typeof origEmitWarning === 'function') {
  process.emitWarning = function filteredWarning(warning, ...rest) {
    const msg = typeof warning === 'string' ? warning : String(warning?.message || '');
    if (/SQLite is an experimental feature/i.test(msg)) return;
    return origEmitWarning.call(this, warning, ...rest);
  };
}

const STUDIO_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(dirname(STUDIO_DIR));
const PLUGIN_MANIFEST_PATH = join(PLUGIN_ROOT, 'plugin.json');
export const SIDECAR_PILL_MARKDOWN = '[AgentTower](sidecar://agent-tower/studio/)';

const SUPPORTED_MCP_VERSIONS = new Set([
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]);
const DEFAULT_MCP_VERSION = '2025-03-26';

let daemonClientModPromise = null;
function getDaemonClientModule() {
  if (!daemonClientModPromise) {
    daemonClientModPromise = import('../../core/daemon-client.mjs');
  }
  return daemonClientModPromise;
}

export function readPluginVersion() {
  try {
    if (existsSync(PLUGIN_MANIFEST_PATH)) {
      const parsed = JSON.parse(readFileSync(PLUGIN_MANIFEST_PATH, 'utf8'));
      if (typeof parsed?.version === 'string' && parsed.version.trim()) {
        return parsed.version.trim();
      }
    }
  } catch {}
  return '0.0.0';
}

// ---------------------------------------------------------------------------
// 1. 16 个核心编排与扩展中心 MCP 工具完整 Schema 定义
// ---------------------------------------------------------------------------

const SPEC_SELECTION_PROPERTIES = {
  specIds: { type: 'array', items: { type: 'string' }, description: '显式选择项目规范 ID 或 kind/id。' },
  targetPaths: { type: 'array', items: { type: 'string' }, description: '用于匹配规范范围的仓库内路径。' },
  planPath: { type: 'string', description: '可选定稿施工规划，仅接受项目根目录下 .agent-tower/plans/*.md 相对路径；派单或终审时安全内联并按会话去重。' },
  readPaths: { type: 'array', items: { type: 'string' }, description: '仅供只读取证或背景参考的仓库内路径，不触发项目规范全文内联。' },
};

const SESSION_REPORT_PROPERTIES = {
  inheritHostMcp: { type: "boolean", description: "允许本轮外部引擎继承宿主 MCP 配置，默认关闭。" },
  continueSession: {
    type: 'boolean',
    default: false,
    description: '默认 false 复用空闲成员但开干净会话；返工续接上一单上下文时传 true。',
  },
  includeReport: {
    type: 'boolean',
    default: true,
    description: '默认 true 结算附 finalReport（单单 8,000 / 批量合计 16,000 字，超长凭 itemId + nextTextOffset 经 thread_read 续读）。',
  },
};

const EXECUTION_INTENT_DESCRIPTION = 'relay 模式下本轮执行意图：省略时默认可写 write，仅显式传 read 才启用只读约束。';

const DELEGATE_TASK_PROPERTIES = {
  ...SPEC_SELECTION_PROPERTIES,
  ...SESSION_REPORT_PROPERTIES,
  task: {
    type: 'string',
    description:
      '委派给外部异构子 Agent 的完整任务指令。子线程拥有干净独立的上下文，请明确提供背景、目标文件范围与验收标准。',
  },
  title: {
    type: 'string',
    description: '任务简短可读标题（显示在监控面板与族谱树中）。',
  },
  cwd: {
    type: 'string',
    description: '目标项目工作区的绝对路径（强烈建议显式传入当前项目根目录）。',
  },
  conversationId: {
    type: 'string',
    description:
      '传入当前 <user_information> 中的 Conversation ID，使子任务严格归属当前对话独立看板（防跨窗口串台）。',
  },
  createNewThread: { type: 'boolean', description: '强制新建成员，默认复用同角色空闲成员。' },
  presetKey: {
    type: 'string',
    description:
      '常规派单仅传 presetKey：传入当前会话模式 modeProfiles 已勾选阵容中的成员 presetKey（全成员同权，按用户点名 → ★ 首选（单兵默认选 ★；多路并派主力轨必含 ★，其余并发轨再按专长/空闲复用补位）选人，多路拆单严禁绕开已标 ★ 的宿主原生成员），引擎、模型、思考强度、权限与交互模式均完全以用户在面板保存的成员配置为准，请勿同时传 provider / model / effort / permissionMode / interactionMode；仅在临时自定义配置时不传 presetKey。',
  },
  role: {
    type: 'string',
    enum: ['implementation', 'research', 'review', 'design', 'test', 'general', 'curator'],
    description: '任务职能角色分类（默认按 presetKey 自动匹配，或 general）。',
  },
  provider: {
    type: 'string',
    description:
      '仅在未传 presetKey 的自定义路由下显式指定引擎或扩展平台 ID（如 "kimi-code"、"codex"、"claude-code" 或自定义平台 ID；已传 presetKey 时请省略，冲突会报 PRESET_TARGET_CONFLICT）。',
  },
  model: {
    type: 'string',
    description:
      '仅在未传 presetKey 的自定义路由下填写目标模型 ID（已传 presetKey 时请省略 model，冲突会报 PRESET_TARGET_CONFLICT）；显式传 "__default__" 启用 Router Passthrough，跟随客户端默认配置。',
  },
  effort: {
    type: 'string',
    description:
      '仅在未传 presetKey 的自定义路由下指定思考强度（已传 presetKey 时请省略 effort，完全跟随用户在面板保存的角色预设强度；冲突会报 PRESET_TARGET_CONFLICT）。显式传 "inherit" 跟随客户端默认强度。',
  },
  permissionMode: {
    type: 'string',
    description:
      '仅在未传 presetKey 的自定义路由下指定引擎原生权限档位（已传 presetKey 时请省略 permissionMode，完全跟随面板角色预设权限；冲突会报 PRESET_TARGET_CONFLICT）：Claude Code "plan" | "default" | "acceptEdits" | "auto" | "bypassPermissions"；Codex "read-only" | "on-request" | "auto" | "full-access"；Kimi Code "plan" | "default" | "auto" | "yolo"；托管 agy "plan" | "default" | "accept-edits" | "always-proceed"；扩展引擎 "plan" | "default" | "auto" | "full-access"。"auto" 始终是带审查的自动档，跨引擎不会自动升级到全放行。',
  },
  interactionMode: {
    type: 'string',
    enum: ['default', 'plan', 'inherit'],
    description: '仅在未传 presetKey 的自定义路由下指定交互模式（已传 presetKey 时请省略 interactionMode，以面板角色预设为准；冲突会报 PRESET_TARGET_CONFLICT）。',
  },
  isolation: {
    type: 'string',
    enum: ['shared', 'worktree'],
    description:
      '工作区隔离策略："shared" 默认共用项目目录（常驻会话、单路写入与只读分析）；"worktree" 自动创建独立 Git Worktree 分支（多子任务并行改代码必选）。',
  },
  mode: {
    type: 'string',
    enum: ['async', 'wait'],
    description:
      '"async" 立即返回 taskId 后台非阻塞执行；"wait" 同步等待子任务完成或遇到审批/提问/超时后直接返回总结。',
  },
  executionIntent: {
    type: 'string',
    enum: ['read', 'write'],
    description: EXECUTION_INTENT_DESCRIPTION,
  },
  allowDisabledPreset: {
    type: 'boolean',
    description: '允许本轮临时点名使用已停用成员。',
  },
  target: {
    type: 'object',
    description: '兼容 AgentTower 结构的显式模型路由对象（不要与预设冲突） { provider?, driverKind?, model?, effort?, options? }。',
    properties: {
      provider: { type: 'string' },
      driverKind: { type: 'string' },
      model: { type: 'string' },
      effort: { type: 'string' },
      options: { type: 'object' },
    },
  },
  timeoutMs: {
    type: 'number',
    description: 'mode="wait" 时的最大同步等待毫秒数（超时不杀子任务，仍可继续通过 task_status 查询）。',
  },
  ephemeral: {
    type: 'boolean',
    description:
      '无痕临时会话开关：默认 false（保留连贯上下文以便多轮续聊）；设为 true 则执行完毕后不在外部客户端留存历史记录。',
  },
  parentThreadId: {
    type: 'string',
    description: '可选父编排线程 ID。',
  },
  clientRequestId: {
    type: 'string',
    description: '可选幂等请求标识，防止重试重复创建任务。',
  },
};

// Batch items accept every delegate_task field; keep the property shells (type / enum / items) but not the long copy.
const BATCH_TASK_PROPERTIES = Object.fromEntries(Object.entries(DELEGATE_TASK_PROPERTIES).map(([key, schema]) => {
  const shell = { type: schema.type };
  for (const field of ['enum', 'items', 'default', 'properties']) if (schema[field] !== undefined) shell[field] = schema[field];
  return [key, { ...shell, description: key === 'task' ? schema.description : '同 delegate_task 同名字段。' }];
}));

export const MCP_TOOLS = Object.freeze([
  {
    name: 'spec_curation',
    description: '仅在用户明确要求维护项目规范时调用。begin 获取只读准则，submit 送交 Studio 预检及用户确认。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['begin', 'submit'] },
        cwd: { type: 'string' },
        conversationId: { type: 'string' },
        sessionId: { type: 'string' },
        note: { type: 'string' },
        status: { type: 'string', enum: ['propose', 'no_change'] },
        summary: { type: 'string' },
        reason: { type: 'string' },
        changes: { type: 'array', items: { type: 'object' } },
        rawText: { type: 'string' },
      },
      required: ['action', 'cwd'],
      additionalProperties: false,
    },
  },
  {
    name: 'orchestrator_capabilities',
    description:
      '查询本机核心引擎（Kimi Code / Codex / Claude Code / Antigravity）及开放扩展平台的可用状态、完整脱敏模型目录与成员池预设；仅在需要核对引擎、模型或阵容时调用。',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '可选项目目录，用于附带只读项目规范摘要。' },
        search: { type: 'string', description: '按关键词过滤引擎或模型名称。' },
        refresh: {
          type: 'boolean',
          description: '是否强制重新探测本机引擎目录；等同点击「↻ 重新探测引擎目录」，仅以只读 CLI 输出同步 agy 可选模型，不启动 agy acp。',
        },
      },
    },
  },
  {
    name: 'delegate_task',
    description:
      '向外部异构编程平台（Kimi Code、Codex、Claude Code 及开放扩展平台）派发单个子 Agent 任务，支持绑定当前启用阵容中的成员 presetKey（全成员同权）、Git Worktree 隔离以及 async/wait 模式。（注：外部引擎成员通过 delegate_task / delegate_parallel_batch 派发；Antigravity 成员同样走统一入口，塔台按预设返回 swarm / invoke_subagent 的 hostActions 代派卡并自动认领（严禁调用 agentapi new-conversation））。',
    inputSchema: {
      type: 'object',
      properties: DELEGATE_TASK_PROPERTIES,
      required: ['task'],
    },
  },
  {
    name: 'delegate_parallel_batch',
    description:
      '单次调用并行扇出多个外部异构子 Agent 任务（例如同时派出当前阵容已勾选的多名军师会审方案，或同时启动多个独立 Worktree 执行模块）；每项传入当前启用阵容中的成员 presetKey（全成员同权）；军师会审请保持用户原话同题派发，各军师 task 逐字一致、不注入预设倾向。Antigravity 成员与外部 CLI 可混合拆轨，外部任务正常启动，原生任务通过批次 hostActions 返回待宿主派遣卡（严禁调用 agentapi new-conversation）。',
    inputSchema: {
      type: 'object',
      properties: {
        allowLargeBatch: { type: 'boolean', default: false, description: '允许单批超过 6 个任务。' },
        cwd: {
          type: 'string',
          description: '批次默认工作区根目录绝对路径（子项未单独指定 cwd 时自动继承）。',
        },
        conversationId: {
          type: 'string',
          description:
            '传入当前 <user_information> 中的 Conversation ID，使整批子任务严格归属当前对话独立看板。',
        },
        planPath: SPEC_SELECTION_PROPERTIES.planPath,
        readPaths: SPEC_SELECTION_PROPERTIES.readPaths,
        continueSession: SESSION_REPORT_PROPERTIES.continueSession,
        includeReport: SESSION_REPORT_PROPERTIES.includeReport,
        mode: {
          type: 'string',
          enum: ['async', 'wait_all', 'wait'],
          description: '"async" 立即返回全部 taskId 后台并发运行；"wait_all" 等待全部子任务结算后汇总返回。',
        },
        timeoutMs: {
          type: 'number',
          description: '等待全部任务完成的最大毫秒数。',
        },
        parentThreadId: {
          type: 'string',
          description: '可选父线程 ID。',
        },
        tasks: {
          type: 'array',
          minItems: 1,
          description: '并行派发的子任务数组。',
          items: {
            type: 'object',
            properties: BATCH_TASK_PROPERTIES,
            required: ['task'],
          },
        },
      },
      required: ['tasks'],
    },
  },
  {
    name: 'task_status',
    description:
      '查询委派子任务的实时状态、三态 workState（working / waiting_for_children / result_available）、Token 用量、挂起审批/提问及最终产出总结。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'delegate_task 返回的子任务 ID。' },
        threadId: { type: 'string', description: '可选按子线程 ID 查询。' },
        wait: { type: 'boolean', description: '若任务仍在运行，是否阻塞等待其结算。' },
        timeoutMs: { type: 'number', description: 'wait=true 时的最大等待毫秒数。' },
        includeReport: SESSION_REPORT_PROPERTIES.includeReport,
      },
      required: ['taskId'],
    },
  },
  {
    name: 'task_cancel',
    description:
      '中断或强制终止正在运行/排队中的子任务及其下属进程树（支持优雅取消及超时自动升级 taskkill /T /F 强杀）。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '要取消的子任务 ID。' },
        threadId: { type: 'string', description: '可选直接按线程 ID 终止。' },
        force: { type: 'boolean', description: '是否立即强制强杀整棵子进程树（默认先尝试优雅中断）。' },
        expectedRunId: { type: 'string', description: '可选：只中断该回合；若成员已结束该回合或进入新回合，返回 cancelState "stale_run" 而不会误杀下一轮。' },
        reason: { type: 'string', description: '取消原因备注。' },
        clientRequestId: { type: 'string', description: '可选幂等请求 ID。' },
      },
    },
  },
  {
    name: 'thread_launch',
    description:
      '创建并可选立即启动一个顶层独立会话线程（支持绑定独立 Git Worktree 与任意已启用引擎/扩展平台）。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SPEC_SELECTION_PROPERTIES,
        title: { type: 'string', description: '会话线程标题。' },
        message: { type: 'string', description: '可选首轮立即发送的指令文本。' },
        cwd: { type: 'string', description: '项目工作区根目录路径。' },
        conversationId: {
          type: 'string',
          description: '传入当前 <user_information> 中的 Conversation ID，将该线程绑定到当前对话看板。',
        },
        presetKey: { type: 'string', description: '可选切换到当前模式已勾选的成员 presetKey（规则同 delegate_task）。' },
        role: { type: 'string', description: '可选角色分类。' },
        provider: { type: 'string', description: '目标引擎或扩展平台 ID。' },
        model: {
          type: 'string',
          description: '模型 ID，如 "gpt-6.2-sol" 或 "gpt-6.2-astra"；省略时使用角色预设模型；显式传 "__default__" 跟随客户端 / CC Switch 默认配置（Router Passthrough）。',
        },
        effort: {
          type: 'string',
          description: '思考/推理强度；省略时使用角色预设强度；显式传 "inherit" 跟随客户端默认强度，Kimi 支持 "medium" / "xhigh" 等模型原生五档。',
        },
        permissionMode: { type: 'string', description: '权限/沙盒模式。' },
        interactionMode: { type: 'string', enum: ['default', 'plan'] },
        isolation: { type: 'string', enum: ['shared', 'worktree'] },
        workspaceStrategy: {
          type: 'object',
          description: '可选高级工作区策略 { type: "root"|"existing_worktree"|"worktree", worktreePath?, baseRef?, branch? }。',
        },
        mode: { type: 'string', enum: ['async', 'wait'] },
        ephemeral: {
          type: 'boolean',
          description:
            '无痕临时会话开关：默认 false（连贯持久化以便续聊）；设为 true 则不在外部客户端留存历史记录。',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'thread_list',
    description: '列出或全文检索主/子 Agent 线程列表（含自动纳管的宿主原生对话与外部引擎线程），支持按状态、工作区与关键词过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        statuses: {
          type: 'array',
          items: { type: 'string' },
          description: '按状态列表过滤，如 ["running", "waiting", "completed", "failed"]。',
        },
        status: { type: 'string', description: '单个状态过滤简写。' },
        conversationId: {
          type: 'string',
          description: '传入当前 Conversation ID，仅列出归属当前对话独立看板的主/子线程。',
        },
        workspace: { type: 'string', description: '按工作区路径过滤。' },
        includeSubagents: {
          type: 'boolean',
          description: '是否包含委派的子 Agent 线程（默认 true）。',
        },
        query: { type: 'string', description: '搜索标题或消息内容的关键词。' },
        limit: { type: 'number', description: '返回数量上限（默认 50）。' },
        cursor: { type: 'number', description: '分页偏移游标。' },
      },
    },
  },
  {
    name: 'thread_read',
    description:
      '分页读取指定主/子线程的时间线内容：messages 视图仅看对话结论，activity 视图包含完整思维链（Reasoning）、命令输出与文件 Diff 卡片。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '目标线程 ID（childThreadId 或顶层 threadId）。' },
        view: {
          type: 'string',
          enum: ['messages', 'activity', 'full'],
          description: '读取粒度：默认 "messages"（仅对话结论）；需要思维链、命令输出与 Diff 卡片时传 "activity"。',
        },
        afterPosition: { type: 'number', description: '增量读取起始序号（传入后按正序向后翻页）。' },
        limit: { type: 'number', description: '最大返回条目数（默认最近 20 条，按时间正序）。' },
        maxCharsPerItem: { type: 'number', description: '单条文本截断上限字符数（默认 8000）。' },
        itemId: { type: 'string', description: '针对单条超长条目（如 finalReport 截断返回的 itemId）精确切片读取的条目 ID。' },
        textOffset: { type: 'number', description: '配合 itemId 使用的字符偏移量。' },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'thread_send',
    description:
      '向空闲或运行中的子 Agent 线程发送后续指令：空闲时通过原生 Session Resume 多轮无损续聊；运行中支持 Steer 即时纠偏、Queue 排入队列或 Restart 重启。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SPEC_SELECTION_PROPERTIES,
        threadId: { type: 'string', description: '目标线程 ID。' },
        presetKey: { type: 'string', description: '可选切换到当前模式已勾选的成员 presetKey（规则同 delegate_task）。' },
        message: { type: 'string', description: '发送给该线程的指令文本。' },
        mode: {
          type: 'string',
          enum: ['auto', 'steer', 'queue', 'restart'],
          description:
            '"auto"（空闲启动续聊，运行中优先 Steer 否则入队）、"steer"（运行中动态插话纠偏）、"queue"（排入下一轮队列）、"restart"（中断当前轮并以新指令重跑）。',
        },
        wait: { type: 'boolean', description: '是否同步等待本轮执行完毕后返回回复。' },
        timeoutMs: { type: 'number', description: 'wait=true 时的超时毫秒数。' },
        freshContext: {
          type: 'boolean',
          description: '是否清空底层原生会话上下文重新开启新会话（默认 false 保留完整记忆）。',
        },
        provider: { type: 'string', description: '可选跨引擎接力切换目标引擎或扩展平台 ID。' },
        model: {
          type: 'string',
          description: '可选切换本轮及后续模型，如 "gpt-6.2-sol" / "gpt-6.2-astra"；传 "__default__" 跟随客户端 / CC Switch 默认配置。',
        },
        effort: {
          type: 'string',
          description: '可选切换本轮及后续思考强度；传 "inherit" 跟随客户端默认值，Kimi 支持 "medium" / "xhigh" 等模型原生五档。',
        },
        executionIntent: { type: 'string', enum: ['read', 'write'], description: EXECUTION_INTENT_DESCRIPTION },
        allowDisabledPreset: { type: 'boolean', description: '允许本轮临时点名使用已停用成员。' },
      },
      required: ['threadId', 'message'],
    },
  },
  {
    name: 'thread_queue',
    description:
      '管理指定线程的待办排队消息（查看队列、修改文案、调整顺序、取消排队项、或一键 promote_to_steer 立即插队注入当前活跃轮次）。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '目标线程 ID。' },
        action: {
          type: 'string',
          enum: ['list', 'read', 'enqueue', 'edit', 'cancel', 'reorder', 'promote_to_steer', 'clear'],
          description: '队列管理操作类型。',
        },
        queueId: { type: 'string', description: '目标队列项 ID（兼容别名 queuedRunId）。' },
        queuedRunId: { type: 'string', description: '目标队列项 ID 别名。' },
        text: { type: 'string', description: 'edit 或 enqueue 时的消息文本。' },
        beforeRunId: { type: 'string', description: 'reorder 时移动到该队列项之前（空则移至末尾）。' },
        position: { type: 'number', description: 'reorder 时的目标索引位置（0-based）。' },
      },
      required: ['threadId', 'action'],
    },
  },
  {
    name: 'thread_configure',
    description:
      '动态调整线程绑定的引擎/扩展平台（Provider）、模型（Model）、思考强度（Effort）或权限/规划模式；省略的字段保持原值；跨引擎切换时自动准备上下文交接摘要。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '目标线程 ID。' },
        title: { type: 'string', description: '可选更新线程标题。' },
        presetKey: { type: 'string', description: '可选切换到当前模式已勾选的成员 presetKey（规则同 delegate_task）。' },
        provider: { type: 'string', description: '新引擎或扩展平台 ID。' },
        model: {
          type: 'string',
          description: '新模型 ID，如 "gpt-6.2-sol" / "gpt-6.2-astra"；省略则保持原值；显式传 "__default__" 跟随客户端 / CC Switch 默认配置（Router Passthrough）。',
        },
        effort: {
          type: 'string',
          description: '新思考强度；省略则保持原值；显式传 "inherit" 跟随客户端默认值，Kimi 支持 "medium" / "xhigh" 等模型原生五档。',
        },
        permissionMode: { type: 'string', description: '新权限/沙盒模式。' },
        interactionMode: { type: 'string', enum: ['default', 'plan'] },
      },
      required: ['threadId'],
    },
  },
  {
    name: 'review_code',
    description:
      '默认审改一体闭环。relay 模式禁止外部评审，complex 模式按已勾选审核官与阶段开关执行。终审官直接修复缺陷并自测后汇报主会话，无缺陷则报告 PASS。显式只读时仅输出诊断。',
    inputSchema: {
      type: 'object',
      properties: {
        ...SPEC_SELECTION_PROPERTIES,
        cwd: { type: 'string', description: '被审查的 Git 仓库或 Worktree 绝对路径。' },
        conversationId: {
          type: 'string',
          description: '传入当前 <user_information> 中的 Conversation ID，使终审结果归属当前对话独立看板。',
        },
        threadId: { type: 'string', description: '可选传入子任务线程 ID，自动定位其关联 Worktree 目录。' },
        worktreeId: { type: 'string', description: '可选传入隔离 Worktree ID。' },
        reviewMode: {
          type: 'string', enum: ['review_and_fix', 'read_only', 'ephemeral', 'persistent'], default: 'review_and_fix',
          description: '默认复用持久终审成员。ephemeral 指定单次无痕，persistent 兼容持久会话。',
        },
        readOnly: { type: 'boolean', default: false, description: '强制只读沙盒，仅 Codex 支持。' },
        presetKey: { type: 'string', description: '指定评审成员 presetKey：传入复杂阵容审核阶段已勾选的评审成员（全成员同权），省略时默认 ★ 首选评审成员。' },
        degradeToHostSelfReview: { type: 'boolean', description: '评审组为空时确认降级为主会话自行审查。' },
        allowModeOverride: { type: 'boolean', description: '兼容旧参数。relay 模式始终禁止外部评审，complex 模式按审核阶段开关处理。' },
        allowDisabledPreset: { type: 'boolean', description: '允许本轮临时点名使用已停用评审成员。' },
        provider: { type: 'string', description: '终审引擎，默认跟随所选评审成员配置。' },
        permissionMode: { type: 'string', description: '覆盖终审权限，read-only 强制只读。' },
        ephemeral: { type: 'boolean', default: false, description: '仅本轮无痕，不复用成员。' },
        scope: {
          type: 'string',
          enum: ['uncommitted', 'branch', 'commit'],
          description: '审查范围：默认 "uncommitted" 审查未提交改动；"branch" 对比基准分支；"commit" 审查特定提交。',
        },
        baseBranch: { type: 'string', description: 'scope="branch" 时的基准分支名（如 "main"）。' },
        commitSha: { type: 'string', description: 'scope="commit" 时的目标 Commit SHA。' },
        model: {
          type: 'string',
          description: '终审模型（省略时使用终审角色预设，出厂为 "gpt-6.2-astra"）；显式传 "__default__" 跟随客户端 / CC Switch 默认配置（Router Passthrough）。',
        },
        effort: {
          type: 'string',
          description: '终审思考强度（省略时使用终审角色预设，出厂为 "xhigh"）；显式传 "inherit" 跟随客户端默认值，Kimi 支持 "medium" / "xhigh" 等模型原生五档。',
        },
        prompt: { type: 'string', description: '可选附加审查重点提示词。' },
        mode: {
          type: 'string',
          enum: ['async', 'wait'],
          default: 'async',
          description: '默认 "async" 立即返回 taskId 后台执行（避免长终审触发 MCP 3 分钟超时），随后用 task_status 等待结算；传 "wait" 同步等待完成（可配 timeoutMs）。',
        },
        timeoutMs: {
          type: 'number',
          description: 'mode="wait" 时的最大同步等待毫秒数（超时不中断终审，仍可继续通过 task_status 查询）。',
        },
        ...SESSION_REPORT_PROPERTIES,
      },
    },
  },
  {
    name: 'worktree_diff',
    description:
      '查看隔离 Git Worktree 的变更文件列表、增删行数统计与完整 Unified Diff（传 listOnly=true 可列出所有托管 Worktrees）。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '关联该 Worktree 的线程 ID。' },
        worktreeId: { type: 'string', description: 'Worktree 记录 ID。' },
        worktreePath: { type: 'string', description: '可选直接指定 Worktree 目录路径。' },
        cwd: { type: 'string', description: '主仓库路径（用于 listOnly 过滤）。' },
        filePath: { type: 'string', description: '可选仅查看指定相对路径单文件的 Diff。' },
        listOnly: { type: 'boolean', description: '设为 true 时仅列出活跃 Worktrees 摘要列表。' },
      },
    },
  },
  {
    name: 'worktree_integrate',
    description:
      '将子 Agent 在独立 Git Worktree 中完成的修改经冲突预检后一键合入主工作区（支持 apply_unstaged 补丁应用、squash_merge、merge_noff 及安全清理 Worktree）。',
    inputSchema: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '关联该 Worktree 的线程 ID。' },
        worktreeId: { type: 'string', description: '目标 Worktree ID。' },
        worktreePath: { type: 'string', description: '可选直接传入 Worktree 路径。' },
        cwd: { type: 'string', description: '主工作区 Git 仓库路径。' },
        strategy: {
          type: 'string',
          enum: ['apply_unstaged', 'squash_merge', 'merge_noff', 'cherry_pick', 'cleanup_only'],
          description:
            '合入方式：默认 "apply_unstaged"（不切换主分支直接应用补丁）；"squash_merge"（压缩合并提交）；"merge_noff"（保留分支历史合并）；"cleanup_only"（仅安全卸载清理 Worktree）。',
        },
        targetBranch: { type: 'string', description: '分支合并策略下的目标分支。' },
        commitMessage: { type: 'string', description: '自动提交或 Squash 时的提交信息。' },
        cleanupAfter: {
          type: 'boolean',
          description: '合入成功后是否自动执行 Windows NTFS Junction 安全清理移除该 Worktree（默认 false）。',
        },
        forceCleanup: {
          type: 'boolean',
          description: 'strategy="cleanup_only" 时是否允许强制移除含未合入修改的 Worktree。',
        },
      },
    },
  },
  {
    name: 'studio_status',
    description:
      '查询 AgentTower 守护进程健康状况、当前活跃运行数、三档编排模式与分模式阵容、已接入扩展平台数量、独立浏览器监控台 URL（studioUrl）以及右侧面板一键唤起胶囊链接。',
    inputSchema: {
      type: 'object',
      properties: {
        conversationId: {
          type: 'string',
          description: '传入当前 <user_information> 中的 Conversation ID，查询该独立对话看板的实时统计。',
        },
        workspace: { type: 'string', description: '可选按项目工作区过滤统计。' },
      },
    },
  },
  {
    name: 'manage_providers',
    description:
      '开放平台扩展中心（Provider & ACP Extension Hub）管理工具：支持列出内置 7 大扩展平台预设（OpenCode / Gemini CLI / Cursor / Grok / Kiro / Goose / Aider）及本机探测状态（list_templates）、真机握手探测并自动拉取模型列表（probe）、保存/启用自定义 ACP 或 CLI 平台（save）、以及停用移除平台（remove）。',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_templates', 'probe', 'save', 'remove'],
          description:
            '"list_templates" 查看内置模板与已接入平台；"probe" 实时握手探测平台支持的模型与模式；"save" 保存并启用扩展平台；"remove" 移除扩展平台。',
        },
        id: {
          type: 'string',
          description: '扩展平台唯一标识 ID（如 "opencode"、"gemini-cli"、"cursor"、"grok"、"kiro"、"goose"、"aider" 或自定义 ID）。',
        },
        name: {
          type: 'string',
          description: '平台显示名称（save 时使用，如 "OpenCode ACP"）。',
        },
        protocol: {
          type: 'string',
          enum: ['acp', 'cli'],
          description: '接入协议类型："acp" 为标准 JSON-RPC 2.0 over Stdio ACP 协议；"cli" 为命令行占位符模板模式。',
        },
        command: {
          type: 'string',
          description: '可执行文件名称或绝对路径（如 "opencode"、"gemini"、"aider"）。',
        },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'ACP 启动参数数组（如 ["acp"] 或 ["--experimental-acp"]）。',
        },
        argsTemplate: {
          type: 'array',
          items: { type: 'string' },
          description:
            'CLI 模板参数数组（支持占位符 {{model}}、{{effort}}、{{prompt}}、{{cwd}}，如 ["--model", "{{model}}", "--yes-always", "--message", "{{prompt}}"]）。',
        },
        env: {
          type: 'object',
          description: '可选自定义环境变量键值对（服务端仅持久化并回显脱敏键名，绝不明文回显敏感值）。',
        },
        cwd: {
          type: 'string',
          description: 'probe 探测时使用的工作目录路径。',
        },
        models: {
          type: 'array',
          items: { type: 'object' },
          description: 'save 时可选传入的模型列表（若省略可由 probe 结果或默认模型自动填充）。',
        },
        defaultModel: {
          type: 'string',
          description: '该扩展平台的默认模型 ID。',
        },
        enabled: {
          type: 'boolean',
          description: 'save 时是否立即启用该平台（默认 true）。',
        },
        timeoutMs: {
          type: 'number',
          description: 'probe 握手探测超时毫秒数（默认 6000）。',
        },
        config: {
          type: 'object',
          description: 'save 操作时可选嵌套传入的完整平台配置对象。',
        },
      },
      required: ['action'],
    },
  },
]);

// ---------------------------------------------------------------------------
// 2. 工具调用路由分发（MCP Tool -> Core Daemon RPC）
// ---------------------------------------------------------------------------

function withHostContext(rawArgs) {
  const args = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? { ...rawArgs } : {};
  const hostAppData = process.env.ANTIGRAVITY_APP_DATA_DIR || '';
  const hostAgentApiExe = process.env.ANTIGRAVITY_AGENTAPI_EXE || '';
  const hostProjectId = process.env.ANTIGRAVITY_PROJECT_ID || '';

  // 注意：不可用 process.env.ANTIGRAVITY_CONVERSATION_ID 去覆盖未传 conversationId 的 MCP 调用，
  // 否则全局复用进程会把新窗口调用误绑到首个启动对话上；由 orchestrator.mjs 自动溯源或接收显式 conversationId。
  if (args.conversationId && !args.parentConversationId) {
    args.parentConversationId = args.conversationId;
  }
  if (hostAppData && !args.appDataDir) {
    args.appDataDir = hostAppData;
  }
  if (hostAgentApiExe && !args.agentApiExe) {
    args.agentApiExe = hostAgentApiExe;
  }
  if (hostProjectId && !args.projectId) {
    args.projectId = hostProjectId;
  }
  return args;
}

// High-frequency action tools only need the mode gate, not the whole roster (that stays on capabilities / studio_status).
const SLIM_ACTIVE_MODE_TOOLS = new Set(['delegate_task', 'delegate_parallel_batch', 'task_status', 'thread_send',
  'thread_read', 'thread_launch', 'review_code']);

function slimActiveMode(activeMode) {
  if (!activeMode || typeof activeMode !== 'object') return activeMode;
  const { orchestrationMode, dispatchEnabled, policyRevision, rosterRevision, stages, queueFrozen } = activeMode;
  return { orchestrationMode, dispatchEnabled, policyRevision, rosterRevision, stages, ...(queueFrozen ? { queueFrozen } : {}) };
}

// A native dispatch card already carries tool + args; the host-facing prompt must not repeat the whole brief again.
function slimHostAction(action) {
  if (!action || typeof action !== 'object' || !action.handoffId || !action.tool) return action;
  const prefix = action.role === 'curator' ? `[AgentTower Curation Ticket #${action.handoffId}]\n` : '';
  return { ...action, hostPrompt: `${prefix}请执行宿主原生派遣票据 #${action.handoffId}：按 args 调用 ${action.tool}。严禁调用 agentapi new-conversation 或 agy acp。` };
}

function slimDispatchResult(result, { keepCards = true } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const out = { ...result };
  if ('activeMode' in out) out.activeMode = slimActiveMode(out.activeMode);
  if (out.code === 'HOST_DISPATCH_REQUIRED' || Array.isArray(out.hostActions)) {
    const cards = (out.hostActions || []).map(slimHostAction);
    if (out.hostAction && cards.some(card => card?.handoffId === out.hostAction.handoffId)) delete out.hostAction;
    else if (out.hostAction) out.hostAction = slimHostAction(out.hostAction);
    if (keepCards) out.hostActions = cards;
    else delete out.hostActions;
  }
  return out;
}

// Each model lists its option descriptors at the top level and again under capabilities; MCP only needs one copy.
function dropNestedOptionDescriptors(value) {
  if (Array.isArray(value)) return value.map(dropNestedOptionDescriptors);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) out[key] = dropNestedOptionDescriptors(child);
  if (out.optionDescriptors && out.capabilities && typeof out.capabilities === 'object' && 'optionDescriptors' in out.capabilities) {
    const { optionDescriptors, ...restCaps } = out.capabilities;
    if (Object.keys(restCaps).length) out.capabilities = restCaps;
    else delete out.capabilities;
  }
  return out;
}

export function slimMcpPayload(toolName, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return payload;
  if (toolName === 'orchestrator_capabilities') return dropNestedOptionDescriptors(payload);
  if (!SLIM_ACTIVE_MODE_TOOLS.has(toolName)) return payload;
  const out = slimDispatchResult(payload);
  if (Array.isArray(out.tasks)) out.tasks = out.tasks.map(task => slimDispatchResult(task, { keepCards: false }));
  if (toolName === 'thread_read') {
    delete out.memberPool;
    delete out.modeProfiles;
  }
  return out;
}

export function formatToolSuccess(payload, toolName = '') {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(slimMcpPayload(toolName, payload)),
      },
    ],
  };
}

/** MCP thread_read default: newest 20 conversation messages, oldest-first; explicit cursors and itemId reads untouched. */
export function threadReadArgs(args = {}) {
  if (args.itemId) return args;
  const next = { ...args };
  if (next.view === undefined) next.view = 'messages';
  if (next.limit === undefined) next.limit = 20;
  if (next.maxCharsPerItem === undefined) next.maxCharsPerItem = 8000;
  if (next.afterPosition === undefined && next.afterOrdinal === undefined && next.tail === undefined) next.tail = true;
  return next;
}

function formatMcpToolError(message) {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Error: ${message}`,
      },
    ],
  };
}

export async function executeMcpToolCall(toolName, rawArgs = {}) {
  const client = await getDaemonClientModule();
  const { ensureDaemon } = client;
  const daemonRpc = (method, params) => client.daemonRpc(method, { ...params, _agentTowerSurface: 'mcp' });
  const args = withHostContext(rawArgs);
  const formatMcpToolSuccess = (payload) => formatToolSuccess(payload, toolName);

  switch (toolName) {
    case 'spec_curation': {
      if (!['begin', 'submit'].includes(args.action) || typeof args.cwd !== 'string' || !args.cwd.trim()) {
        return formatMcpToolError('spec_curation 需要 begin 或 submit 及项目 cwd');
      }
      const { port, token } = await ensureDaemon();
      const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', 'X-Daemon-Token': token, 'X-Agent-Tower-Surface': 'mcp' },
        body: JSON.stringify({ method: 'specCuration', params: args }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        return formatMcpToolError([payload.code, payload.error || `HTTP ${response.status}`].filter(Boolean).join(': '));
      }
      return formatMcpToolSuccess(payload.result);
    }
    case 'orchestrator_capabilities': {
      const res = await daemonRpc('getCapabilities', args);
      return formatMcpToolSuccess(res);
    }

    case 'delegate_task': {
      const res = await daemonRpc('delegateTask', args);
      if (res?.bypassed) return formatMcpToolSuccess(res);
      return formatMcpToolSuccess({
        ...(res && typeof res === 'object' ? res : { result: res }),
        sidecarPill: SIDECAR_PILL_MARKDOWN,
      });
    }

    case 'delegate_parallel_batch': {
      const topConv = args.conversationId || args.parentConversationId || '';
      const rawTasks = Array.isArray(args.tasks) ? args.tasks : [];
      const tasks = rawTasks.map((item) => {
        const t = item && typeof item === 'object' ? { ...item } : {};
        if (topConv && !t.conversationId) t.conversationId = topConv;
        if (topConv && !t.parentConversationId) {
          t.parentConversationId = topConv;
        }
        return t;
      });
      const normalizedMode = args.mode === 'wait' ? 'wait_all' : args.mode;
      const res = await daemonRpc('delegateParallelBatch', {
        ...args,
        ...(normalizedMode ? { mode: normalizedMode } : {}),
        tasks,
      });
      if (res?.bypassed) return formatMcpToolSuccess(res);
      return formatMcpToolSuccess({
        ...(res && typeof res === 'object' ? res : { result: res }),
        sidecarPill: SIDECAR_PILL_MARKDOWN,
      });
    }

    case 'task_status': {
      const res = await daemonRpc('getTaskStatus', args);
      return formatMcpToolSuccess(res);
    }

    case 'task_cancel': {
      const res = await daemonRpc('cancelTask', args);
      return formatMcpToolSuccess(res);
    }

    case 'thread_launch': {
      if (args.workspace && !args.cwd) args.cwd = args.workspace;
      if (args.message && !args.prompt) args.prompt = args.message;
      if (args.prompt && !args.message) args.message = args.prompt;
      const res = await daemonRpc('launchThread', args);
      if (res?.bypassed) return formatMcpToolSuccess(res);
      return formatMcpToolSuccess({
        ...(res && typeof res === 'object' ? res : { result: res }),
        sidecarPill: SIDECAR_PILL_MARKDOWN,
      });
    }

    case 'thread_list': {
      if (args.cwd && !args.workspace) args.workspace = args.cwd;
      const res = await daemonRpc('listThreads', args);
      return formatMcpToolSuccess(res);
    }

    case 'thread_read': {
      const res = await daemonRpc('readThread', threadReadArgs(args));
      return formatMcpToolSuccess(res);
    }

    case 'thread_send': {
      if (!args.message && (args.prompt || args.text)) {
        args.message = args.prompt || args.text;
      }
      const res = await daemonRpc('sendToThread', args);
      return formatMcpToolSuccess(res);
    }

    case 'thread_queue': {
      if (args.queuedRunId && !args.queueId) args.queueId = args.queuedRunId;
      if (args.queueId && !args.queuedRunId) args.queuedRunId = args.queueId;
      if (args.message && !args.text) args.text = args.message;
      const res = await daemonRpc('manageQueue', args);
      return formatMcpToolSuccess(res);
    }

    case 'thread_configure': {
      const res = await daemonRpc('configureThread', args);
      return formatMcpToolSuccess(res);
    }

    case 'review_code': {
      if (args.workspace && !args.cwd) args.cwd = args.workspace;
      const reviewArgs = (args.mode === undefined && args.wait === undefined)
        ? { ...args, mode: 'async' }
        : args;
      const res = await daemonRpc('runCodeReview', reviewArgs);
      if (res?.bypassed) return formatMcpToolSuccess(res);
      return formatMcpToolSuccess({
        ...(res && typeof res === 'object' ? res : { result: res }),
        sidecarPill: SIDECAR_PILL_MARKDOWN,
      });
    }

    case 'worktree_diff': {
      if (args.listOnly) {
        const listRes = await daemonRpc('listWorktrees', args);
        return formatMcpToolSuccess(listRes);
      }
      const res = await daemonRpc('getWorktreeDiff', args);
      return formatMcpToolSuccess(res);
    }

    case 'worktree_integrate': {
      if (args.strategy === 'cleanup_only') {
        const cleanRes = await daemonRpc('cleanupWorktree', {
          ...args,
          force: Boolean(args.forceCleanup ?? args.force),
        });
        return formatMcpToolSuccess(cleanRes);
      }
      const res = await daemonRpc('integrateWorktree', args);
      return formatMcpToolSuccess(res);
    }

    case 'studio_status': {
      const daemon = await ensureDaemon();
      const boot = await daemonRpc('getBootstrap', {
        workspace: args.workspace || args.cwd || '',
        conversationId: args.conversationId || args.parentConversationId || '',
        appDataDir: args.appDataDir || '',
        agentApiExe: args.agentApiExe || '',
        projectId: args.projectId || '',
      });
      const launch = await daemonRpc('studioStatus', {
        conversationId: boot?.rootConversationId || args.conversationId || args.parentConversationId || '',
        workspace: boot?.workspace || args.workspace || args.cwd || '',
      });
      const studioUrl = new URL(launch.launchUrl || launch.studioUrl);
      // Older daemons may return the legacy auth URL even on a successful RPC.
      studioUrl.searchParams.delete('auth');
      const activeRuns = Array.isArray(boot?.activeRuns) ? boot.activeRuns : [];
      const threads = Array.isArray(boot?.threads) ? boot.threads : [];
      const worktrees = Array.isArray(boot?.worktrees) ? boot.worktrees : [];
      const pendingRequests = Array.isArray(boot?.pendingRequests) ? boot.pendingRequests : [];
      const customProviders = Array.isArray(boot?.customProviders) ? boot.customProviders : [];
      return formatMcpToolSuccess({
        ok: true,
        plugin: 'agent-tower',
        version: boot?.version || readPluginVersion(),
        studioUrl: studioUrl.href,
        sidecarPill: SIDECAR_PILL_MARKDOWN,
        customizationLink: '[AgentTower](customization://agent-tower)',
        daemon: {
          host: daemon.host,
          port: daemon.port,
          pid: daemon.pid,
        },
        conversationPolicy: boot?.conversationPolicy,
        activeMode: boot?.activeMode,
        memberPool: boot?.memberPool,
        modeProfiles: boot?.modeProfiles,
        presetRevision: boot?.presetRevision,
        openIncidentsCount: boot?.healthIncidents?.length ?? 0,
        customProvidersCount: customProviders.length,
        stats: boot?.stats || {
          activeRuns: activeRuns.length,
          threads: threads.length,
          worktrees: worktrees.length,
          pendingRequests: pendingRequests.length,
        },
        activeRuns: activeRuns.slice(0, 12).map((r) => ({
          runId: r.id || r.runId,
          threadId: r.threadId,
          title: r.title,
          provider: r.provider,
          model: r.model,
          effort: r.effort,
          status: r.status,
        })),
      });
    }

    case 'manage_providers': {
      const action = String(args.action || '').trim();
      if (action === 'list_templates' || action === 'list') {
        const res = await daemonRpc('listExtensionProviders', {
          cwd: args.cwd || args.workspace || '',
        });
        return formatMcpToolSuccess(res);
      }
      if (action === 'probe') {
        const res = await daemonRpc('probeExtensionProvider', {
          id: args.id,
          protocol: args.protocol,
          command: args.command,
          args: args.args,
          argsTemplate: args.argsTemplate,
          env: args.env,
          cwd: args.cwd,
          workspace: args.workspace,
          timeoutMs: args.timeoutMs,
        });
        return formatMcpToolSuccess(res);
      }
      if (action === 'save') {
        const mergedConfig = {
          ...(args.config && typeof args.config === 'object' ? args.config : {}),
          ...args,
        };
        delete mergedConfig.action;
        delete mergedConfig.config;
        delete mergedConfig.parentConversationId;
        delete mergedConfig.appDataDir;
        delete mergedConfig.agentApiExe;
        delete mergedConfig.projectId;
        if (mergedConfig.enabled === undefined) {
          mergedConfig.enabled = true;
        }
        const res = await daemonRpc('saveExtensionProvider', mergedConfig);
        return formatMcpToolSuccess(res);
      }
      if (action === 'remove') {
        const targetId = String(args.id || args.providerId || '').trim();
        if (!targetId) {
          return formatMcpToolError('manage_providers(action="remove") requires "id"');
        }
        const res = await daemonRpc('removeExtensionProvider', { id: targetId });
        return formatMcpToolSuccess(res);
      }
      return formatMcpToolError(
        `Unsupported manage_providers action "${action}". Expected "list_templates" | "probe" | "save" | "remove".`
      );
    }

    default:
      return formatMcpToolError(`Unknown tool: ${toolName}`);
  }
}

// ---------------------------------------------------------------------------
// 3. JSON-RPC 2.0 协议分发与双帧（Line / Content-Length）流解析器
// ---------------------------------------------------------------------------

export async function handleMcpJsonRpcMessage(msg, serverVersion = readPluginVersion()) {
  if (!msg || typeof msg !== 'object') return null;
  const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
  if (!hasId) {
    // JSON-RPC Notification（如 notifications/initialized、notifications/cancelled）无需响应帧
    return null;
  }

  const id = msg.id;
  const method = String(msg.method || '');

  if (method === 'initialize') {
    const requested = String(msg.params?.protocolVersion || '').trim();
    const protocolVersion = SUPPORTED_MCP_VERSIONS.has(requested)
      ? requested
      : DEFAULT_MCP_VERSION;
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion,
        capabilities: {
          tools: { listChanged: false },
        },
        serverInfo: {
          name: 'agent-tower',
          version: serverVersion,
        },
      },
    };
  }

  if (method === 'ping') {
    return { jsonrpc: '2.0', id, result: {} };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: MCP_TOOLS,
      },
    };
  }

  if (method === 'tools/call') {
    const toolName = String(msg.params?.name || '').trim();
    if (!toolName) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: 'Missing required parameter: name' },
      };
    }
    try {
      const result = await executeMcpToolCall(toolName, msg.params?.arguments || {});
      return { jsonrpc: '2.0', id, result };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: formatMcpToolError(err?.message || String(err)),
      };
    }
  }

  if (method === 'resources/list') {
    return { jsonrpc: '2.0', id, result: { resources: [] } };
  }

  if (method === 'resources/templates/list') {
    return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
  }

  if (method === 'prompts/list') {
    return { jsonrpc: '2.0', id, result: { prompts: [] } };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not found: ${method}`,
    },
  };
}

export function startMcpStdioServer() {
  const serverVersion = readPluginVersion();
  let framingMode = 'line';
  let rawBuffer = Buffer.alloc(0);
  let shuttingDown = false;

  // 异步后台预热 Core Daemon（失败不阻塞 initialize 与 tools/list 握手）
  getDaemonClientModule()
    .then((mod) => mod.ensureDaemon?.())
    .catch((err) => {
      writeStderrLine(`daemon background prewarm skipped: ${err?.message || err}`);
    });

  function writeJsonRpcPayload(payload, mode) {
    const serialized = JSON.stringify(payload);
    if (mode === 'lsp') {
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      rawStdoutWrite(`Content-Length: ${byteLen}\r\n\r\n${serialized}`);
    } else {
      rawStdoutWrite(`${serialized}\n`);
    }
  }

  async function dispatchParsedPayload(parsed, mode) {
    try {
      if (Array.isArray(parsed)) {
        const batchResults = (
          await Promise.all(parsed.map((item) => handleMcpJsonRpcMessage(item, serverVersion)))
        ).filter(Boolean);
        if (batchResults.length > 0) {
          writeJsonRpcPayload(batchResults, mode);
        }
        return;
      }
      const single = await handleMcpJsonRpcMessage(parsed, serverVersion);
      if (single) {
        writeJsonRpcPayload(single, mode);
      }
    } catch (err) {
      writeStderrLine(`dispatch error: ${err?.message || err}`);
    }
  }

  function drainInputBuffer() {
    while (rawBuffer.length > 0) {
      const preview = rawBuffer.subarray(0, Math.min(rawBuffer.length, 64)).toString('utf8');
      if (/^Content-Length:/i.test(preview.trimStart())) {
        framingMode = 'lsp';
        const sepCrlf = rawBuffer.indexOf('\r\n\r\n');
        const sepLf = sepCrlf < 0 ? rawBuffer.indexOf('\n\n') : -1;
        const headerEnd = sepCrlf >= 0 ? sepCrlf : sepLf;
        const sepLen = sepCrlf >= 0 ? 4 : 2;
        if (headerEnd < 0) return;

        const headerStr = rawBuffer.subarray(0, headerEnd).toString('utf8');
        const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
        if (!lenMatch) {
          rawBuffer = rawBuffer.subarray(headerEnd + sepLen);
          continue;
        }
        const contentLen = Number(lenMatch[1]);
        const totalFrameLen = headerEnd + sepLen + contentLen;
        if (rawBuffer.length < totalFrameLen) return;

        const bodyStr = rawBuffer.subarray(headerEnd + sepLen, totalFrameLen).toString('utf8');
        rawBuffer = rawBuffer.subarray(totalFrameLen);
        try {
          void dispatchParsedPayload(JSON.parse(bodyStr), 'lsp');
        } catch (err) {
          writeStderrLine(`invalid LSP JSON frame: ${err?.message || err}`);
        }
        continue;
      }

      const nlIdx = rawBuffer.indexOf(0x0a);
      if (nlIdx < 0) return;
      const lineStr = rawBuffer.subarray(0, nlIdx).toString('utf8').trim();
      rawBuffer = rawBuffer.subarray(nlIdx + 1);
      if (!lineStr) continue;
      try {
        void dispatchParsedPayload(JSON.parse(lineStr), framingMode);
      } catch (err) {
        writeStderrLine(`invalid NDJSON line: ${err?.message || err}`);
      }
    }
  }

  function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exit(0);
  }

  process.stdin.on('data', (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    rawBuffer = rawBuffer.length === 0 ? buf : Buffer.concat([rawBuffer, buf]);
    drainInputBuffer();
  });

  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.stdin.resume();
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  startMcpStdioServer();
}

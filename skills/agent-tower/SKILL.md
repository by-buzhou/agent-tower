---
name: agent-tower
description: 在AgentTower中调度当前宿主会话的外部 Agent、跟踪任务、审查并修复代码，或使用隔离工作树并行开发。
---

# AgentTower v0.3.5

通过宿主加载的 `agent-tower_orchestrator` 工具组工作。需要展示实时进度时，在回复中附上面板入口。[AgentTower](sidecar://agent-tower/studio/)

- 收到 `host_direct_only` 或派发门禁的 `PreToolUse` 拒绝时，主会话直接独立完成。严禁重试派单或绕道调用 `invoke_subagent`、`define_subagent`、`run_workflow` 或 `swarm`。
- 主会话保留协调职责，统一调 `delegate_task` / `delegate_parallel_batch` 显式传 `conversationId`、`cwd` 与 `presetKey`。`antigravity` 成员按返回的 `hostActions` 代派：指定模型/思考档位或具名驻留走原生 `swarm({ action: "add", name, model })`（待命同名成员用 `post_message` 唤醒并自动认领新票据），`inherit` 或 `pro / flash / flash_lite` 粗档位单次走 `invoke_subagent`。混合批次无损拆轨；严禁调用 `agentapi new-conversation`，严禁向用户输出宿主官方 Swarm 看板链接。
- 单路执行用 `isolation: "shared"`，并发冲突写改用独立工作树（合入前检查 `worktree_diff`，保留未合入用户改动）。新派工单复用同对话同项目的空闲成员卡（`threadId`）并默认开启干净外部原生会话；返工追问走 `thread_send` 或传 `continueSession: true`。任务结算默认直回 `finalReport`，超长凭 `itemId + nextTextOffset` 经 `thread_read` 续读。
- 常规派单只传 `presetKey`，按当前项目在当前模式 `modeProfiles` 的单层 `enabledKeys` 选人（全成员平权可删，禁同传冲突目标参数，临时自定义时省略 `presetKey`；仅用户本轮明确点名未勾选成员时传 `allowDisabledPreset: true`）。常规编制 1～4 人、单批最多 6 项（超限传 `allowLargeBatch: true`），禁无故开启失控六人 `/swarm` 或重复派审。
- 终审调 `review_code` 执行 `review_and_fix`（默认 `mode: "async"` 立即返回 `taskId` 后台执行，经 `task_status` 查结算防长终审撞 3 分钟 MCP 超时；传 `mode: "wait"` 支持同步等待及 `timeoutMs`）：无缺陷报 PASS，有缺陷当场修复自测；只修可复现逻辑、并发与契约缺陷，严禁过度设计；只读诊断选 Codex 传 `readOnly: true`。权限使用各引擎原生档位（`auto` 为带审查自动档，跨引擎不提权至全放行），非法或敏感 `cwd` 直接报错。
- 测试与临时脚本限在当前项目目录内执行（临时目录用已忽略的 `tmp/`，收尾清理，禁写系统目录或桌面）。中途只跑语法快检与关联定向单测（复用既有夹具，禁为局部小改新建重型服务或无头浏览器脚本），全量回归仅发版前跑 1 次。
- 三档模式为 `direct`（直出，新对话默认，`dispatchEnabled: false`）/ `relay`（简单，默认可写，仅传 `executionIntent: "read"` 才只读）/ `complex`（复杂自定义）。已勾选阵容与阶段开关为可用上限池，主会话先判意图：问答与核心源码 `<= 4` 个文件明确改动（顺带改断言的单测不计入拆单门槛）走 0 派直答（自改并跑快检快测） / 单领域强耦合改动（含前端 HTML/JS/CSS 与对应单测）优先单兵同目录改完跑绿，严禁把源码与单测或强耦合样式劈进隔离 Worktree 盲写 / 仅当存在 2 个及以上接口清晰、彼此低耦合的独立模块时再加载 `agent-tower-plan` 技能并派（每轨自带本层单测） / 召集军师会审或复盘时先加载 `agent-tower-council` 技能；纯讨论轮次不调 `review_code`。按点名 → ★ 首选（单兵默认选 ★；多路并派主力轨必含 ★，其余并发轨再按专长/空闲复用补位）选人；多路拆单时严禁为图外部 `worktree_integrate` 合入省事而绕开已标 ★ 的宿主原生成员（原生成员正常走 `hostActions` + `workspace: "share"` 混编拆轨）。主会话分点汇报采用自然融合白话文风：以人话直观效果打头，顺畅带出机制、文件与验证/风险（禁段末白话块与机械口头禅，简短确认与子 Agent 豁免）。
- 配置页分「当前项目 / 全局默认」双作用域：默认编排模式与新项目默认 Spec 开关（`defaultSpecEnabled`，默认关）归全局；成员池四组（含支持外部 CLI 与宿主原生的只读 `curator`）与 `modeProfiles` 归当前项目 `projectProfiles`（空白项目零写盘，支持同步或恢复全局模板）。
- 项目规范（`.agent-tower/spec/`）按项目可插拔且支持双向手动归档至 `spec-archive/`；仅识别 `.agent-tower/docs/**` 演进文档，`.agent-tower/councils/` 严禁投递给子 Agent。未开启 Spec 时子 Agent 仅注入裁剪后的角色底线、停用 `curator` 而保留 `reviewer`。开启 Spec 时主会话与干活成员严禁直接写删 `spec/`；仅在用户要求时委派 `delegate_task({ role: "curator" })`（支持外部与宿主原生维护官）或由主会话按需调 `spec_curation({ action: "begin" | "submit" })` 提交提案，经用户在 Studio 确认后原子落盘；`targetPaths` / `specIds` 声明写审目标，`readPaths` 声明只读导航。
- 主会话按需维护轻量项目记忆：用户要求记录重大否决方案或避坑决策时，写入 `<projectRoot>/.agent-tower/docs/evolution/<slug>.md`，正文只保留 `## 1. 背景与痛点 (Why)` 与 `## 2. 核心决策与否决方案 (Trade-offs & Rejected)` 两节（不抄提交号与现行红线），并登记同目录 `INDEX.md`（表头含 `版本` 与 `关键模块与检索关键词`）；用户要求维护路线图时，在 `.agent-tower/docs/ROADMAP.md` 维护版本演进与待交付规划（零正文注入）。平时零打扰，命中相关模块时才按关键词导航查阅。

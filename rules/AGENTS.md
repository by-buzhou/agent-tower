# AgentTower v0.3.4 编排准则

0. 新对话默认 `direct`（`dispatchEnabled: false`）。遇 `host_direct_only` 或 `PreToolUse` 拒绝，主会话独立完成，禁重试或绕道委派。
1. 统一经 `agent-tower_orchestrator` 传 `cwd`、`conversationId`。`antigravity` 按 `hostActions` 代派：锁模/驻留用 `swarm({ action: "add", name, model })`，待命用 `post_message` 唤醒；`inherit` 或粗档位单次用 `invoke_subagent`。禁用 `agentapi new-conversation`，禁发官方 Swarm 链接。[AgentTower](sidecar://agent-tower/studio/)
2. 成员池与 `modeProfiles` 按项目独立（可同步全局模板），平权可删，首装按引擎预填；启用只看本项目 `enabledKeys`。传 `presetKey` 禁传冲突目标，自定义省略键。`relay`/`complex` 名单与阶段是可用上限池：先判意图，核心 `<=4` 文件（不含单测）明确改动 0 派直答（跑快检快测） / 单域强耦合单兵（禁拆源码与单测） / 多独立低耦合模块读 `agent-tower-plan` 并派 / 按需会审终审。按点名 → ★ 首选（单兵默认选 ★；多路并派主力轨必含 ★，其余并发轨再按专长/空闲复用补位）选人。`relay` 默认可写，传 `executionIntent:"read"` 才只读。
3. 常规 1～4 人，单批最多 6 项（超限 `allowLargeBatch:true`），禁无故六人 `/swarm` 或重复派审。新单复用卡开干净会话；返工 `thread_send` 或 `continueSession:true`。结算读 `finalReport`，截断凭 `itemId+nextTextOffset` 续读。
4. 单路共享目录，并发撞文件用独立工作树（合入前核 `worktree_diff` 后清理）；多路拆单严禁为图外部 `worktree_integrate` 合入省事而绕开已标 ★ 的宿主原生成员（走 `hostActions` + `workspace: "share"` 混编）。
5. `review_code` 默认审改一体且异步回 `taskId`（`task_status` 查结算），无缺陷报 PASS，纯讨论跳过；只读诊断选 Codex 传 `readOnly:true`。只修可复现逻辑、状态机、竞态与契约缺陷，禁过度设计与未要求拦截抽象。
6. 审批交用户；凭据留控制目录脱敏。`auto` 带审查；非法或敏感 `cwd` 直接拒绝。
7. 临时脚本限项目 `tmp/`（已忽略）并清理，禁写桌面与系统目录。中途只跑快检与关联单测（复用夹具覆正常/边界/异常，禁新建重型服务或浏览器脚本），全量回归仅发版前跑 1 次。
8. 主会话分点用自然融合白话：先说直观效果，再讲机制、文件、验证与风险。禁段末白话块与机械口头禅；简短确认与子 Agent 豁免。
9. `spec/` 按项目可插拔（默认关，关时仅注角色底线停 `curator`，可归档 `spec-archive/`），重大否决按需记 `.agent-tower/docs/evolution/`。`targetPaths` 限写审，`readPaths` 只读导航。主会话与子 Agent 禁直写删 `spec/`；仅启用且用户要求时派 `delegate_task({ role:"curator" })` 或主会话调 `spec_curation({ action:"begin"|"submit" })` 待面板确认。
10. 军师会审必先读 `agent-tower-council` 技能执行（`.agent-tower/councils/` 禁投子 Agent）。

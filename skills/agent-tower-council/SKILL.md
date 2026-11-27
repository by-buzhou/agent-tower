---
name: agent-tower-council
description: >-
  在AgentTower中召集多模型军师团执行同题原话盲评、跨引擎混编并发派发、完赛点名核验、四段式自然融合白话裁决汇总，并归档正式会审纪要至 .agent-tower/councils/。当用户要求军师团评审、多模型会审、方案盲评或架构复盘时激活。
---

# AgentTower · 军师团盲评与四段式裁决 SOP

当用户要求召集军师评审方案、多方对比路线或对已落地改动做多模型复盘时，按以下 5 步执行。

## 1. 模式门禁与参评阵容确认

1. **检查派发总闸**：若当前会话处于 `direct` 直出模式并收到 `host_direct_only` 或 `PreToolUse` 拦截，直接说明当前处于直出模式并由主会话独立分析，严禁重试派单或绕道调用宿主原生委派工具。
2. **读取本项目军师名单**：按当前项目 `modeProfiles.complex.advisor.enabledKeys` 召集参评成员（全成员平权，不硬编码固定预设 ID）。
   - 用户未点名具体成员时，默认齐发全部已启用军师；
   - 仅当用户本轮明确点名某个未勾选成员时，对该成员显式传 `allowDisabledPreset: true`。

## 2. 第一铁律：同题原话盲评（零诱导污染）

1. **逐字同题**：发给每一位参评军师的核心议题 `task` 必须**逐字一致**（直接保留用户原话或忠实还原客观问题）。
2. **严禁倾向注入**：
   - 严禁在题面中透露主会话的预设偏好、草拟结论或引导性暗示；
   - 严禁按成员人为拆分不同视角（如让 A 只看性能、B 只看安全），所有军师面对同一完整问题独立盲评；
   - 仅允许附加已核实的客观代码路径、提交哈希与硬性边界条件（通过 `readPaths` 传入只读参考导航路径，**严禁传入 `.agent-tower/councils/**`**）。
3. **强制只读边界**：军师阶段严禁修改业务文件（外部 Codex 走 `read-only` 或 `readOnly: true`，Claude / Kimi 走 `plan`，宿主原生 `swarm` 在 `brief` 明确声明只读盲评禁改文件）。

## 3. 混编真并发派发与完赛点名核验

1. **单批并派**：调用一次 `delegate_parallel_batch` 提交全部参评军师（统一传 `role: "advisor"`、逐字一致的 `task` 与客观 `readPaths`）。
2. **宿主原生无损拆轨**：若返回 `hostActions`（含 `antigravity` 渠道军师），在**同一轮并行工具调用**中同步下发全部 `hostActions`：
   - 未驻留成员调 `swarm({ action: "add", name, model, brief })`；
   - 已在看板 `waiting` 待命的同名成员调 `post_message({ text: "@<name> ..." })` 唤醒；
   - 严禁调用 `agentapi new-conversation`，严禁输出宿主官方 Swarm 看板链接，仅附 `[AgentTower](sidecar://agent-tower/studio/)`。
3. **收齐与续读**：外部批次通过 `task_status({ wait: true, timeoutMs: 140000 })` 收取 `finalReport`；若 `finalReportTruncated: true`，凭 `itemId + nextTextOffset` 经 `thread_read` 补齐全文。
4. **完赛点名红线**：汇总前逐一清点实到有效报告数。若有成员超时、报错或中断缺席，必须点名标注「某成员超时/异常缺席」，**严禁将缺席成员计入共识分母**（如 5 派 4 到记为 `4/4 完赛共识（1 缺席）`）。

## 4. 四段式自然融合白话裁决汇报

面向用户的裁决报告固定分为以下四段（每点采用自然融合白话：先讲人话直观判断与实际影响，再顺畅带出机制、可点击 `file://` 文件链接与风险，禁段末白话块与机械口头禅）：

`共同决断 / 分歧点 + 主会话看法 / 各军师独特看法 + 主会话评价 / 拍板与待确认`

1. **共同决断**：完赛军师一致认定的核心结论、高危漏洞或必改项。
2. **分歧点 + 主会话看法**：军师间路线冲突之处，主会话必须结合真实源码给出明确倾向与取舍依据，不做和事佬复读。
3. **各军师独特看法 + 主会话评价**：提炼单名军师独有且有价值的盲区发现，逐条给出「采纳 / 延后 / 驳回（如过度设计或未复现假设）」的主会话客观评价。
4. **拍板与待确认**：输出可直接落地的执行路线；仅对涉及产品语义、默认开关或用户体验的分叉列出清晰选项请用户拍板。

## 5. 正式会审纪要归档（主会话独占）

1. **落盘路径**：主会话将正式会审写入 `<projectRoot>/.agent-tower/councils/YYYY-MM-DD-<topic>.md`，并在同目录 `<projectRoot>/.agent-tower/councils/INDEX.md` 追加索引行（日期、议题、参评阵容与完赛率、核心拍板结论）。
2. **纪要必备段落**：元信息头（日期、`conversationId`、原话题面、参评成员与模型清单）→ 四段式裁决正文 → 后续施工图或待办衔接说明。
3. **永久隔离红线**：`.agent-tower/councils/` 默认 Git 忽略且缓存清理永久保留；**严禁通过 `planPath`、`targetPaths`、`readPaths` 或 Prompt 粘贴投递给任何干活子 Agent**。

## 6. 按需 ADR 与待开发路线图（主会话）

用户明确要求记录重大否决方案或避坑决策时，主会话在 `<projectRoot>/.agent-tower/docs/evolution/<slug>.md` 写入两节 ADR：`## 1. 背景与痛点 (Why)` 与 `## 2. 核心决策与否决方案 (Trade-offs & Rejected)`，不抄提交号与现行红线；随后登记同目录 `INDEX.md`，表头须含 `版本` 与 `关键模块与检索关键词`。用户要求维护路线图时，在 `.agent-tower/docs/ROADMAP.md` 维护版本演进与待交付规划（零正文注入）。

# 安全说明

## 本地数据与凭据边界

AgentTower 默认在本机运行。项目任务、会话索引、项目规范及隔离工作树位于 `<projectRoot>/.agent-tower/`；插件控制数据位于 `~/.gemini/antigravity/plugin_data/agent-tower/`。这些目录可能包含对话内容、工作区路径、数据库和运行日志，不应上传或提交到公开仓库。

扩展平台的环境变量保存在控制目录的 `_extensionEnvVault` 中，当前为**本地明文存储**。请勿把控制目录、`global-settings.json`、`.env` 文件、访问令牌或其他凭据复制进源码仓、公开导出目录、问题附件或截图。公开仓库不应包含任何真实账户配置。

## 零点目录触碰与环境变量隔离（Zero Dotfile Touch）

- **不扫描第三方凭据目录**：安装检测只查 PATH 和已知安装入口（包括 `~/.opencode/bin/opencode`），不会遍历第三方配置目录、通过点目录是否存在推断安装状态或读取其中的凭据。展示给前端的二进制路径将用户主目录前缀缩写为 `~`。
- **分策略环境变量隔离（`envPolicy`）**：所有扩展平台支持在 Studio 扩展面板或配置中切换 `minimal`（极简隔离）与 `inherit`（继承系统）。`dsh` 与 `zcode` 默认启用 `minimal`，启动子进程时仅透传操作系统基础运行/代理变量、本平台声明的 `credentialEnvKeys` 与用户在扩展中心显式配置的环境变量，自动剥离宿主机中无关厂商的 `*_API_KEY` / `*_TOKEN` / `*_SECRET` 与 Antigravity 宿主内部令牌。
- **ZCode 反向凭据与浏览器 RPC 拒答**：直连 ZCode `app-server --stdio` 协议时，对来自子进程的 `interaction/requestProviderRuntimeHeaders`、`interaction/requestOfficialMcpAuthHeaders`、`interaction/browser*` 等反向请求一律返回 `-32601` 拒答，避免越权索取宿主凭据或唤起外部浏览器。
- **防子进程递归派单**：外部引擎继承 `AGENT_TOWER_CHILD_PROCESS=1` 标记。MCP 入口对带标记进程的派单、评审、续聊、排队派发和插话提升返回 `CHILD_RECURSIVE_DISPATCH_FORBIDDEN`。读取队列与代配扩展仍可用。

## 权限边界

ACP 权限请求采用默认拒绝策略：只有用户明确选择允许选项时才放行；空决策、未知决策、超时或无法识别的响应都会被拒绝或取消。自动权限模式不代表无限制授权，各引擎仍应遵循自身的文件系统、命令执行与凭据访问边界。

AgentTower 通过公开本地接口调度第三方引擎。请同时审阅所使用引擎的安全设置，并避免在不可信目录中启用高权限自动执行。

## 报告安全问题

请通过项目公开仓库的 Security Advisory 私密报告入口反馈安全问题；若该项目尚未启用此入口，请使用仓库维护者公布的私密安全联系方式。不要在公开 Issue 中粘贴令牌、个人路径、完整配置、私有对话或可利用的敏感细节。

报告时请提供受影响版本、可复现步骤、预期与实际行为，以及已脱敏的日志。维护者确认问题后，可与报告者协调修复和披露时间。

# 精工Agent——Claude Agent SDK Runtime 接入需求方案 V1.0

> 文档类型：产品需求方案（PRD 补充模块）  
> 产品：精工Agent（Windows 桌面客户端）  
> 版本：V1.0  
> 状态：供 Codex 研发实施  
> 日期：2026-11-09  
> 适用范围：在现有多 Runtime 架构中新增 Claude Agent SDK Runtime，不替换现有 Runtime，不改变默认 Runtime。

---

## 1. 项目背景

精工Agent当前规划/已具备以下 Runtime：

1. **Codex Runtime**：当前默认 Runtime，继续保持默认和现有使用体验。
2. **Jinggong Runtime**：精工自研/改造的 Agent Runtime，用户可以主动选择。
3. **Claude Agent SDK Runtime**：本次新增的可选 Runtime，通过 Anthropic 官方 Claude Agent SDK 接入 Claude Code 的 Agent 能力。

平台同时具备或正在建设多仓库工作区能力。一个工作区由多个独立 Git 仓库组成，例如前端、后端、公共组件和集成服务仓库。用户希望在一次 Agent 会话中，让 AI 理解并协同修改多个仓库。

本次需求目标是在不破坏现有功能的前提下，新增 Claude Agent SDK Runtime，并使三个 Runtime 使用统一的工作区、会话、任务、权限、审批、Diff 和测试体验。

## 2. 产品目标

### 2.1 核心目标

- 将 Claude Agent SDK 纳入平台 Runtime 可选列表。
- 新增 Claude Runtime 后，Codex Runtime 仍然是新安装默认值和当前平台默认值。
- 用户可在全局设置、工作区或新建会话时选择 Runtime；具体生效优先级由产品统一规则确定。
- Claude Runtime 可以在 Windows 桌面客户端中运行，不要求用户单独安装 Claude Code CLI；平台负责随应用分发并管理 SDK 所需的匹配原生二进制。
- Claude Runtime 能在多仓库工作区中读取、分析、修改代码，并输出按仓库拆分的变更和测试结果。
- Jira、MES5、MES6、WMS 知识库、项目记忆、开发规范等平台能力可以通过统一上下文和工具接口提供给 Claude Runtime。
- 使用官方许可允许的认证方式和商业方式，不复用 Claude.ai/Pro/Max 订阅登录或额度作为第三方产品服务。

### 2.2 非目标

- 不开发或训练 Claude 基础模型。
- 不把 Claude Runtime 设为默认值。
- 不替换 Codex Runtime 或 Jinggong Runtime。
- 不承诺 Claude 原生会话可以迁移或恢复为 Codex/Jinggong 会话，反之亦然。
- 不在本期实现多个 Runtime 同时修改同一个工作区的并发协作。
- 不允许平台代用户共享 Claude.ai 登录态、订阅额度、Cookie 或 OAuth Session Token。
- 不以简单执行 `claude -p` 命令代替 Claude Agent SDK 集成。

## 3. 用户角色

| 角色 | 权限与职责 |
|---|---|
| 开发人员 | 配置自己的 Claude API 凭据；选择 Runtime 和模型；在授权工作区内发起、停止和恢复任务；查看审批、Diff、测试结果 |
| 技术负责人 | 配置项目/团队推荐 Runtime、工作区约束、默认模型建议、代码变更审批策略和研发规范 |
| 平台管理员 | 管理 SDK 版本、Runtime 可用状态、安装包分发、诊断日志策略和安全策略 |

首版允许单机个人使用，不要求平台账号服务器。多用户统一凭据管理和集中审计属于后续企业版能力。

## 4. Runtime 统一产品规则

### 4.1 Runtime 列表

| Runtime 标识 | 显示名称 | 默认状态 | 说明 |
|---|---|---|---|
| `codex` | Codex Runtime | 默认 | 沿用现有实现和现有默认配置 |
| `jinggong` | Jinggong Runtime | 可选 | 精工自研/改造 Runtime |
| `claude_agent_sdk` | Claude Agent SDK Runtime | 可选 | 通过 Anthropic 官方 Agent SDK 接入 |

### 4.2 选择与优先级

建议采用以下优先级：

1. 当前会话显式选择的 Runtime。
2. 当前工作区保存的 Runtime 偏好（若产品现有设计支持）。
3. 用户全局默认 Runtime。
4. 系统默认 Codex Runtime。

具体落地时必须兼容现有设置模型，不得因新增 Claude Runtime 覆盖用户原来的 Codex 默认设置。

### 4.3 运行期间切换

- 正在执行的任务不得热切换 Runtime。
- 用户要求切换时，先提示停止/等待当前任务结束。
- 切换后创建该 Runtime 的新原生会话；平台把统一任务摘要、用户补充要求、工作区仓库清单、已完成步骤和当前 Diff 状态作为交接上下文。
- 不把另一 Runtime 的原生 session ID 传给 Claude SDK 的 `resume`。
- 对同一任务工作区加互斥锁，避免两个 Runtime 同时修改同一工作树。

## 5. Claude Runtime 配置需求

### 5.1 配置入口

在“设置 > Runtime 管理 > Claude Agent SDK Runtime”提供以下配置：

- 启用/禁用 Claude Runtime。
- SDK/底层 Claude Code Binary 版本信息（由应用管理，普通用户不应随意混搭版本）。
- 认证方式和连接状态。
- Anthropic API Key 或受支持云服务凭据配置。
- 可选的 Anthropic API 兼容服务地址（只有通过协议验证且满足提供方条款时才允许启用）。
- 模型 ID、默认模型和可选模型列表。
- 请求超时、最大任务时长、最大重试次数等安全范围内的参数。
- Runtime 诊断与连接测试。

### 5.2 认证要求

- 使用 Claude Console API Key，或 Anthropic 官方支持的云服务凭据。
- API Key 由用户自己配置；平台不代用户购买、汇总、转售或共享调用额度。
- 禁止通过精工平台提供 Claude.ai 登录、Pro/Max/Ultra 订阅额度、Cookie、OAuth Session Token 或其他 claude.ai 凭据中转。
- 密钥应使用 Windows Credential Manager/DPAPI 等安全能力加密保存；不得明文写入 SQLite、配置文件、日志或错误报告。
- 每次启动 Claude 子进程时，只把当前任务需要的凭据临时注入进程环境；结束后不持久化到任务记录。
- “测试连接”只验证鉴权和模型可用性，不输出密钥内容。

### 5.3 模型配置

- Claude Runtime 使用 Anthropic/对应兼容提供方的模型 ID，不与 Codex 模型 ID 混用。
- 允许按会话选择模型，但必须验证模型是否可由当前凭据/服务访问。
- 不保证任意 OpenAI-compatible 中转站可以直接用于 Claude Agent SDK。
- 自定义服务地址必须是 Anthropic API 协议兼容端点；如需支持 `ANTHROPIC_BASE_URL` 等环境变量，必须先由技术验证确认 SDK/底层 Claude Code 版本确实支持，再在界面开放。
- 记录模型 ID、提供方、请求耗时、用量/费用信息（若 SDK 可提供），不记录密钥。

## 6. 工作区与多仓库需求

### 6.1 工作区定义

工作区是多个独立 Git 仓库的逻辑集合，不是把多个仓库合并为一个 Git 仓库。

示例：

```text
MES 生产执行系统工作区
├── mes-web          前端 Git 仓库
├── mes-api          后端 Git 仓库
├── mes-common       公共组件 Git 仓库
└── mes-integration  集成服务 Git 仓库
```

每个仓库都必须保留独立的：
- Git 根目录、远程地址、当前分支和基线 Commit。
- Runtime 工作目录映射。
- Git Worktree/任务工作副本（若启用隔离开发）。
- Diff、测试命令、提交记录和回滚边界。

### 6.2 Claude Runtime 多仓库访问

- 将一个选定仓库作为 Claude SDK `cwd`。
- 其他已授权仓库通过 SDK `additionalDirectories` 提供访问。
- 平台为 Claude 提供工作区清单，说明仓库名称、用途、路径、技术栈、依赖关系和可执行测试命令。
- 每个仓库在会话前执行路径存在性、Git 根目录、权限、分支和工作树状态检查。
- Runtime 只能读写工作区明确授权的仓库/任务工作树。
- 不允许通过额外目录把整个磁盘或用户主目录暴露给 Agent。

### 6.3 跨仓库开发场景

示例需求：“新增工单报工字段，后端提供接口，前端增加录入和展示”。

期望执行流程：

1. Agent 分析需求并识别需要修改的仓库。
2. 输出跨仓库开发计划，标明前端、后端、公共模块的任务依赖。
3. 读取相关接口、数据模型和现有组件代码。
4. 在多个仓库中实施修改。
5. 分仓库执行构建、单元测试、静态检查。
6. 展示工作区级变更总览和仓库级 Diff。
7. 用户逐仓库查看变更、批准或撤销。
8. 各仓库独立提交；首版默认不自动提交、不自动推送、不自动合并。

## 7. 会话与任务需求

### 7.1 统一会话体验

Claude Runtime 必须接入平台统一会话界面：
- 流式显示文本响应和状态更新。
- 展示正在执行的工具名称、状态和简要结果。
- 展示任务计划、阶段进度、待用户审批事项。
- 支持停止、取消和错误重试。
- 支持在同一 Claude 原生会话内继续/恢复。
- 显示当前 Runtime、模型、工作区和参与仓库。
- 显示使用量/费用信息（SDK 或服务能提供时）。

不得向用户界面暴露模型内部隐式推理链或系统提示词。可以显示可解释的计划、任务状态和工具摘要。

### 7.2 会话持久化

平台保存：
- 平台会话 ID。
- Runtime 类型和 Runtime 版本。
- Claude 原生 Session ID。
- 模型和提供方标识。
- 关联工作区及仓库清单。
- 用户消息、助手可展示回复、工具摘要、审批记录、错误和任务状态。
- 任务交接摘要。

Claude 原生会话只允许由 Claude Runtime 自己恢复。跨 Runtime 切换时建立新原生会话，使用平台生成的上下文交接包。

## 8. 工具、知识库与企业规范

Claude Runtime 应遵循平台统一工具接口，并按能力适配：

- 文件读取、搜索、编辑和 Patch/Diff。
- Git 状态、分支、Diff、Worktree 管理。
- 终端命令和各仓库测试命令。
- Jira 任务读取（由平台连接器提供必要信息，或经 MCP 工具暴露）。
- MES5、MES6、WMS 数据字典检索。
- 开发规范检索、代码检查规则和测试用例生成。
- 平台项目记忆检索与写入建议。

知识库与记忆应由平台统一管理，不应依赖某一个 Runtime 的私有会话记忆。运行时只接收本次任务授权范围内的检索结果。

平台可使用 Claude Agent SDK 支持的 MCP、自定义工具和 Hook 接口，但所有工具必须经过统一权限策略；不能因为 Claude Runtime 有原生工具就绕开平台审批。

## 9. 权限和安全要求

### 9.1 默认权限

- 默认使用交互审批/安全权限模式。
- 文件写入仅限工作区授权仓库或隔离 Worktree。
- 命令执行按风险等级审批；构建、测试命令可由用户显式授权为工作区级白名单。
- 禁止未经审批执行删除大目录、修改系统配置、访问凭据目录、上传源码到非授权站点、Git Push、合并和生产发布。
- 禁止启用 `bypassPermissions` 作为产品默认模式；设置页不得提供一键无限制运行。
- 高风险操作必须由平台统一审批 UI 处理，并记录审计事件。

### 9.2 多仓库边界

- Agent 可访问的目录清单与工作区配置严格绑定。
- 增删仓库后，必须更新 Claude SDK 目录权限配置。
- 不允许访问未加入工作区的相邻目录。
- 多仓库任务的变更按仓库显示，避免 Diff 混淆。

### 9.3 敏感信息保护

- 默认拒绝读取 `.env`、私钥、SSH key、云凭据、生产连接配置等文件；如确有测试需要，必须单次显式授权。
- 工具参数、输出、会话摘要中进行密钥脱敏。
- 审计日志只记录必要元数据，不完整保存凭据和敏感环境变量。

## 10. 错误状态与用户提示

| 状态 | 用户提示/平台动作 |
|---|---|
| Claude Runtime 未安装/二进制缺失 | 提示修复或更新组件，不回退到其他 Runtime |
| API Key 缺失 | 引导用户在设置中配置，不显示空凭据异常栈 |
| API 鉴权失败 | 提示检查密钥、组织权限或服务地址 |
| 模型不可用 | 提示当前凭据无法访问该模型，允许用户重新选择 |
| 网络/限流/超时 | 支持按策略重试，保留会话状态 |
| Shell 不可用 | 运行环境诊断，提示 Git Bash/PowerShell 组件问题 |
| 仓库路径不存在 | 标识失败仓库，不允许静默跳过并声称全部完成 |
| SDK 子进程退出 | 保存错误和可恢复信息，允许用户重试或换 Runtime |
| Claude 原生会话恢复失败 | 提示创建新会话并载入平台任务摘要 |

发生 Claude Runtime 错误时不得静默自动切换到 Codex 或 Jinggong Runtime。用户必须明确选择替代 Runtime。

## 11. 页面与交互需求

### 11.1 Runtime 管理页

增加 Claude Agent SDK Runtime 卡片：
- 启用状态。
- SDK/内置 Binary 版本。
- 认证状态和连接测试。
- API Key 配置入口。
- API 兼容服务地址配置（验证通过后显示）。
- 默认模型和模型选择。
- 环境诊断按钮。

### 11.2 新建会话/工作区会话页

Runtime 下拉列表增加 Claude Agent SDK Runtime。显示：
- Runtime 名称和图标。
- 是否可用/是否完成认证。
- 当前模型。
- 会话使用的工作区和仓库。

### 11.3 运行中会话页

- 保持现有统一聊天界面。
- 增加工具执行状态、权限审批卡片和仓库级进度。
- Diff 页面按仓库分组。
- 不向用户暴露 Claude 子进程内部非必要调试内容。

## 12. 优先级

| 优先级 | 需求 |
|---|---|
| P0 | Claude Agent SDK Runtime 注册、选择、API Key 配置、SDK 调用、流式输出、工具执行、会话保存/恢复、工作区多仓库访问、统一权限审批、仓库级 Diff |
| P1 | MCP 集成、Subagent、项目 CLAUDE.md/技能加载策略、成本统计、连接诊断、运行时性能对比 |
| P2 | Runtime 间任务交接优化、更多企业工具、工作区任务模板、企业集中策略 |

## 13. 验收标准

1. 新安装仍默认 Codex Runtime；新增 Claude 后不改变原默认值。
2. 用户可在设置页启用 Claude Agent SDK Runtime，配置有效 API Key，并通过连接测试。
3. 用户在新建会话时可选择 Claude Agent SDK Runtime。
4. 不要求用户单独安装 `claude` CLI；应用安装包包含经验证的 SDK Windows x64 依赖和底层原生二进制。
5. Claude Runtime 能在会话界面流式输出文字、工具状态和最终结果。
6. Claude Runtime 能在一个包含至少前端和后端两个 Git 仓库的工作区中读取两个仓库。
7. Claude Runtime 能完成一次跨仓库实际修改；两个仓库各自显示正确 Diff 和 Git 状态。
8. Agent 运行目录仅包含工作区明确授权的仓库/Worktree。
9. 危险命令、工作区外写入和 Git Push 必须经过平台审批或拒绝。
10. 可以取消当前任务；取消后不再继续写入文件。
11. Claude 原生 Session ID 保存后可以恢复同 Runtime 会话。
12. 切换到 Codex/Jinggong 后创建新的原生会话，不尝试跨 Runtime 原生 Resume。
13. API Key 不会出现在 SQLite 明文字段、日志、异常栈、导出文件或进程调试日志中。
14. 未配置 API Key、鉴权失败、网络超时、模型不可用、SDK 子进程崩溃和 Windows shell 缺失均有清晰提示。
15. Claude Runtime 错误不会导致静默回退到 Codex Runtime。
16. 原 Codex Runtime 和 Jinggong Runtime 的既有功能回归测试全部通过。
17. 许可证、Anthropic 商业条款和所用依赖的合规检查通过后，才允许对外分发。

## 14. 研发交付物

- Claude Runtime 用户流程和设置页。
- Claude Runtime Adapter。
- Claude SDK Windows PoC 与版本兼容报告。
- 多仓库工作区运行与权限测试。
- 会话持久化/恢复测试。
- 安全测试报告。
- 安装包集成测试。
- 许可证和服务条款核查记录。
- Codex/Jinggong Runtime 回归测试报告。

## 15. 官方资料与实现依据

以下均为官方或项目原始资料，实施前应再次核对最新版本：

1. Claude Agent SDK 总览：https://code.claude.com/docs/en/agent-sdk/overview
2. Claude Agent SDK TypeScript API：https://code.claude.com/docs/en/agent-sdk/typescript
3. Claude Agent SDK 权限：https://code.claude.com/docs/en/agent-sdk/permissions
4. Claude Agent SDK Sessions：https://code.claude.com/docs/en/agent-sdk/sessions
5. Claude Agent SDK MCP：https://code.claude.com/docs/en/agent-sdk/mcp
6. Anthropic 法律与合规：https://code.claude.com/docs/en/legal-and-compliance
7. Claude Agent SDK TypeScript 官方仓库：https://github.com/anthropics/claude-agent-sdk-typescript

**重要依据：** 官方文档说明 Agent SDK 提供与 Claude Code 相同的 Agent Loop、工具和上下文管理；SDK 会运行 Claude Code 原生二进制。第三方产品需要使用 Claude Console API Key 或受支持的云服务凭据，不得向第三方应用提供 Claude.ai 登录或转接 Free/Pro/Max/Ultra 订阅额度。Claude Agent SDK 受 Anthropic Commercial Terms of Service 约束。

# 精工智能开发平台——Grok Runtime 中转站接入需求方案 V1.0

> 文档类型：产品需求方案（PRD）  
> 产品：精工智能开发平台（Windows 桌面客户端）  
> 功能：Grok Build ACP Runtime + 第三方模型中转站  
> 版本：V1.0  
> 状态：供 Codex 研发实施  
> 日期：2026-11-11  
> 核心原则：不强制使用 xAI API Key；用户可以配置一个或多个第三方模型中转站及其模型，通过 Grok Build ACP 作为 Agent 执行引擎。

---

## 1. 需求背景

精工智能开发平台目前规划/支持 Codex Runtime、Jinggong Runtime、Claude Agent SDK Runtime。为了扩展模型和 Agent 执行引擎选择，新增 Grok Build ACP Runtime。

本需求特别要求：Grok Runtime 不得把 xAI 官方 API Key 作为唯一认证方式。用户希望沿用当前使用的第三方模型中转站，通过自定义 Base URL、模型 ID 和中转站 API Key 调用模型，同时保留 Grok Build 的 Agent Harness、工具调用、会话及 ACP 能力。

需要明确区分：

- **Grok Build Runtime**：负责任务执行、Agent Loop、工具、会话、MCP、Subagents 等的 Agent Harness。
- **模型服务商/中转站**：负责实际模型推理请求；可以是 xAI 官方，也可以是符合兼容协议的第三方服务。
- **模型 ID**：中转站实际要求传递的模型标识，不一定与 Grok Build 内置模型名相同。

本项目首期只要求第三方中转站模式可用，不要求接入 xAI 官方账号登录或 xAI API Key。

## 2. 产品目标

1. 在精工智能开发平台中增加 Grok Build ACP Runtime。
2. 用户可以配置多个模型中转站，不需要 xAI API Key。
3. 每个中转站支持配置多个模型。
4. 模型协议支持按中转站能力配置：OpenAI Chat Completions、OpenAI Responses、Anthropic Messages。
5. 由精工平台自动启动 Grok Agent ACP 进程，用户无需手动打开终端或启动 Grok TUI。
6. 在现有会话界面中使用 Grok Runtime，显示流式文本、工具调用、审批请求、执行状态和错误。
7. 复用现有工作区、多个 Git 仓库、Skills、MCP、企业知识、会话记忆、Diff 和测试能力；实际支持范围需通过 PoC 验证。
8. Codex Runtime 仍然是平台默认 Runtime，不因新增 Grok Runtime 改变默认值。
9. Grok Runtime 的模型请求必须严格走当前会话选定的中转站，不允许静默回退至 xAI 官方服务。

## 3. 用户角色

| 角色 | 权限 |
|---|---|
| 普通开发人员 | 选择已启用 Grok Runtime、选择已授权中转站/模型、执行会话 |
| Runtime 管理员 | 增删改中转站、模型配置、凭据、默认模型和兼容性状态 |
| 平台管理员 | 管理 Grok Runtime 版本、安装组件、执行策略和全局安全配置 |

首期以单机 Windows 用户为主。无需服务端账号体系。

## 4. 核心用户场景

### UC-01：添加 Grok 模型中转站

1. 用户打开“全局设置 - Runtime 与模型服务”。
2. 选择新增“Grok Runtime 模型服务”。
3. 输入服务商名称、Base URL、中转站 API Key。
4. 选择 API 协议，默认 OpenAI Chat Completions。
5. 输入模型 ID、显示名称、上下文窗口和最大输出 Token。
6. 点击“测试连接”。
7. 系统执行协议与工具调用能力测试，并显示可用性结果。
8. 用户保存配置。

### UC-02：一个中转站添加多个模型

同一 Base URL/API Key 下可以添加多个模型，例如快速模型、复杂推理模型、代码模型。各模型可分别设置模型 ID、协议、上下文窗口、最大输出 Token、reasoning 参数。

### UC-03：会话选择 Grok Runtime

1. 用户在会话底部 Runtime 选择器中选择 Grok Build Runtime。
2. 选择中转站及模型。
3. 精工自动准备隔离配置并启动 Grok ACP 进程。
4. ACP 初始化成功后创建会话。
5. 用户输入任务，Grok Runtime 通过所选中转站执行 Agent 任务。

### UC-04：切换 Grok 中转站或模型

用户可以在新会话选择其他中转站/模型。已运行会话的模型切换能力必须以 ACP `session/set_config_option` 和 Grok 配置能力的 PoC 为准；若不支持安全切换，提示用户新建会话，不得伪造切换成功。

### UC-05：中转站不兼容

若中转站只支持普通文本聊天，不支持 Agent 必需的工具调用/流式输出，测试结果必须标记为“不适合 Grok Runtime Agent 开发”，但可保留配置，禁止误标为可用。

### UC-06：中转站密钥变更

用户可更新或删除中转站 API Key。密钥只写入 Windows 安全凭据存储，配置文件和 SQLite 仅保存凭据引用。

### UC-07：中转站请求失败

出现 401/403、模型不存在、协议不匹配、429、余额不足、超时或服务商 5xx 时，平台应显示可理解的错误类别和建议。默认不自动切换其他中转站、其他模型或 Runtime；自动回退必须由用户明确启用并显示。

## 5. 功能需求

### FR-01：Grok Runtime 注册

- Runtime 类型标识：`grok_build_acp`。
- 通过现有 Runtime Adapter/Registry 注册，不得绕过统一 Runtime 管理器。
- 不修改 Codex Runtime 默认配置。
- Grok Runtime 初始默认关闭，配置并完成健康检查后可启用。
- Runtime 显示名称统一为“Grok Build Runtime”，避免与“Grok 模型”混淆。

### FR-02：中转站管理

支持新增、编辑、删除、启用、禁用、测试连接、复制配置和设置默认中转站。

每个中转站至少包含：

- `providerId`
- `displayName`
- `baseUrl`
- `apiKeyCredentialRef`
- `authMode`（首期至少支持 Bearer/API Key 环境变量模式；自定义请求头按技术 PoC 决定）
- `enabled`
- `createdAt`、`updatedAt`

Base URL 必须为 HTTPS；仅开发调试模式可允许 localhost HTTP，并需要明确风险提示。

### FR-03：模型管理

每个中转站可以配置多个模型。模型字段至少包含：

- `modelProfileId`
- `providerId`
- `modelId`：实际发送给中转站的模型 ID
- `displayName`
- `apiBackend`：`chat_completions` / `responses` / `messages`
- `contextWindow`
- `maxCompletionTokens`
- `supportsTools`（测试结果）
- `supportsStreaming`（测试结果）
- `supportsParallelToolCalls`（测试结果，未知时标记 unknown）
- `reasoningSummary`（适用时）
- `enabled`

不要将模型别名误当成上游 model ID。UI 要同时展示“平台显示名称”和“上游模型 ID”。

### FR-04：API 协议选择

- OpenAI Chat Completions：`api_backend = "chat_completions"`。
- OpenAI Responses：`api_backend = "responses"`。
- Anthropic Messages：`api_backend = "messages"`。
- 默认值为 Chat Completions，但必须让用户可选。
- 不因 Base URL 的形式自动猜测协议；允许系统给出建议，但用户/测试结果确认后才保存为已验证。
- 不承诺协议兼容就等于 Agent 工具调用兼容。

### FR-05：中转站 API Key 安全存储

- 使用 Windows Credential Manager 或现有 Credential Vault。
- SQLite 只保存 `credentialRef`，不保存明文。
- Grok 子进程只在运行期间通过指定环境变量接收密钥。
- 不将密钥放入命令行参数、URL Query、TOML 明文或日志。
- 删除中转站时提供是否同时删除密钥的确认。

### FR-06：每个配置使用独立 Grok 配置目录

- 使用 `GROK_HOME` 指定平台管理的隔离目录。
- 每个 Runtime Provider Profile 具有独立目录，防止污染用户已有 `%USERPROFILE%\.grok` 配置。
- 精工生成受控的 `config.toml`，其中只包含 Base URL、model ID、api_backend、env_key 等非敏感信息。
- `config.toml` 禁止写入真实 API Key。
- 不覆盖、不删除用户原有 Grok 配置。
- 默认使用静态模型配置，不依赖需要 `XAI_API_KEY` 的 `GROK_MODELS_BASE_URL` 自动模型发现方式。

### FR-07：ACP 自动启动

- 精工负责检测 Grok Build 可执行文件。
- 用户无需打开 Grok TUI 或手动执行命令。
- 自动启动 `grok agent stdio`（最终参数以锁定版本 PoC 为准）。
- ACP 通过 JSON-RPC over stdio 通信。
- 进程 stdout 只用于 ACP 协议解析；stderr 写入脱敏诊断日志。
- 支持进程健康检测、退出码、异常关闭、任务取消和资源释放。
- 不默认使用 `--always-approve`、`--yolo` 或 `yoloMode=true`。

### FR-08：会话体验

- 复用现有精工会话窗口。
- 展示 Grok Runtime 名称、中转站、模型和协议。
- 展示文本流、工具调用、工具结果、计划/进度、审批请求、错误和最终结果。
- Runtime 原生事件由 Adapter 转换成平台统一事件。
- 不向 UI 展示敏感环境变量、完整密钥或隐藏推理内容。

### FR-09：运行时模型绑定

- 创建 ACP Session 前，确认 Grok 配置中的默认模型映射到当前选择的模型 Profile。
- 若当前 ACP 会话支持模型配置切换，可用 ACP 标准能力更新；必须由能力协商结果决定。
- 如果切换需要重启 Agent 进程或新建 Session，UI 应明确提示。
- 模型切换必须确保后续请求仍访问当前模型 Profile 的 Base URL。

### FR-10：连接与兼容性测试

测试至少分为：

1. URL 可达性。
2. 鉴权有效性。
3. 模型 ID 有效性。
4. 协议兼容性。
5. 流式输出。
6. 工具调用请求/响应。
7. 连续两轮工具调用。
8. 上下文长度/最大输出设置是否被服务端接受。
9. 429、5xx、超时错误分类。

只完成文本测试不得标记为 Agent 兼容。

### FR-11：不自动回退

- 中转站请求失败时，不得静默切换 xAI 官方 API。
- 不得隐式使用现有 xAI 登录态、Session Token 或全局 `XAI_API_KEY`。
- 不得自动换到其他模型或服务商。
- 未来如支持用户配置的故障转移策略，必须独立开关、可审计并明确提示。

### FR-12：与现有能力集成

优先复用：
- Workspace/多仓库管理。
- Git Worktree、Diff、状态和测试服务。
- Plugin Manager、Skills、MCP 管理。
- 企业知识库、Jira Context Bundle 和项目记忆。
- Permission Broker 和操作审计。
- 企业微信会话完成通知。

具体功能由 Grok ACP 能力协商和 PoC 确认，不支持的能力要显示 unsupported，不得虚假显示已接入。

## 6. 页面与交互需求

### 6.1 全局设置 - Runtime - Grok 中转站

页面区块：

1. Runtime 安装状态（Grok Build 版本、可执行文件路径、健康状态）。
2. 模型中转站列表。
3. 新增/编辑中转站表单。
4. API 协议选择。
5. API Key 输入与凭据状态。
6. 连接测试及能力检测报告。
7. 模型配置列表。
8. 默认中转站和默认模型。

### 6.2 会话底部选择器

选择流程：

`Runtime = Grok Build Runtime` → `Provider = 已配置中转站` → `Model = 对应模型`。

会话中清晰显示：`Grok Build Runtime / 中转站名 / 模型显示名`。

### 6.3 任务运行状态

需显示：准备 Runtime、连接 ACP、创建 Session、调用模型、工具执行、审批等待、完成/失败/取消。

## 7. 非功能需求

- Windows 10/11 x64 优先；其他架构通过 PoC 再支持。
- 不新增服务器依赖，不新增必须由用户手动安装的数据库服务。
- 应用本地配置、日志和 Runtime 数据存储于精工平台用户数据目录。
- 进程启动和停止必须可控，不留下孤儿 Agent 进程。
- 配置迁移向后兼容，不影响原 Codex/Claude/Jinggong Runtime。
- 中转站 API Key 不得进入崩溃报告或诊断包。
- 支持网络代理环境（如现有平台具备代理配置则复用）。
- 中转站超时、限流、断网时 UI 不得假死。

## 8. MVP 范围

### P0 必须完成

- Grok Build ACP 自动启动。
- 自定义中转站 Base URL、API Key、模型 ID。
- Chat Completions / Responses / Anthropic Messages 三种协议配置入口。
- 静态模型注册，避免依赖 xAI Key 的模型列表发现。
- 每个 Provider 隔离 `GROK_HOME`。
- 真实流式 Agent 会话。
- 工具调用和工具审批。
- 错误诊断和不自动回退。
- 至少验证一个第三方中转站和一个 Grok 模型 ID。
- Codex Runtime 默认值保持不变。

### P1 后续增强

- 多个中转站的会话级快速切换。
- 多模型能力标签和兼容矩阵。
- 用户自定义 Header/Query 参数（密钥只能使用安全环境注入）。
- 连接健康监控、用量/成本统计（中转站提供时）。
- 用户自定义故障转移策略。
- 模型自动发现（仅在中转站认证方式及接口验证后启用）。

## 9. 验收标准

### AT-01：无 xAI API Key 启动

干净 Windows 环境没有 xAI API Key、没有 Grok 登录 Session。用户只配置第三方中转站 API Key，精工能够通过 Grok Build ACP 成功创建会话并调用模型。

### AT-02：请求实际走中转站

通过中转站日志或网络诊断确认请求 Host、模型 ID 和鉴权头正确；不得请求 `api.x.ai` 或 `cli-chat-proxy.grok.com` 作为推理回退路径。

### AT-03：多模型

同一中转站下两个模型分别配置，创建会话后实际请求携带对应模型 ID。

### AT-04：多 Provider 隔离

两个中转站使用各自 Base URL 和 API Key；切换会话后不串用 API Key、Base URL 或模型 ID。

### AT-05：工具调用

完成至少一次真实文件读取、一次文件修改和一次测试命令执行，ACP 事件正确显示。

### AT-06：多轮工具调用

Agent 能完成至少两轮“工具调用 → 工具结果 → 继续推理 → 工具调用/结束”的闭环。

### AT-07：失败分类

错误凭据、错误模型 ID、429、服务端 5xx、网络超时都能正确展示，不自动回退 xAI。

### AT-08：凭据安全

SQLite、配置文件、日志、命令行参数均不存在明文 API Key。

### AT-09：Runtime 隔离

新增 Grok Runtime 不改变 Codex 默认值，不影响其他 Runtime 的配置和会话。

### AT-10：Windows 重启

关闭并重新打开精工平台后，Provider/模型配置保留，密钥仍通过凭据库读取，能够再次启动 Grok ACP。

## 10. 待确认项

- 当前项目实际使用的 Grok Build 版本及 Windows 安装/分发方式。
- 第一家实际中转站的 Base URL、认证 Header 规则、模型 ID、协议。
- 中转站是否支持工具调用、并行工具调用、流式事件及上下文上限。
- 当前精工 Runtime Adapter 对 ACP 的现有复用程度。
- 第三方中转站的数据保留和源代码处理条款。

## 11. 官方依据

以下为方案编制时查阅的官方资料，Codex 实施时必须再核对当前锁定版本：

1. Grok Build Overview：https://docs.x.ai/build/overview
2. Grok Build Custom Models：https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md
3. Grok Build Agent Mode / ACP：https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md
4. Grok Build Settings：https://docs.x.ai/build/settings
5. Grok Build Subagents：https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md

重要事实：Grok Build 的 `[model.<name>]` 支持 `model`、`base_url`、`api_key`/`env_key`、`api_backend` 等自定义模型设置；支持 `chat_completions`、`responses`、`messages` 三种 API backend。Credential Resolution 中 `env_key` 优先于已登录 Session Token 和全局 `XAI_API_KEY`。`GROK_MODELS_BASE_URL` 动态模型目录方式仍要求 `XAI_API_KEY`，因此本需求 P0 使用静态 `[model.<name>]` 配置。

---

## 12. 给 Codex 的实施指令

请在现有精工智能开发平台代码库中完成本需求。先检查项目当前 Runtime Adapter、Grok Build 相关代码、SQLite、凭据库、ACP 通信、Windows 打包方式，不得另起一套平行架构。

### 第一步：现状盘点

1. 找出现有 Runtime Registry/Adapter、Provider 配置、Credential Vault、ACP/JSON-RPC 组件。
2. 确认 Grok Build 可执行文件安装/检测/版本锁定策略。
3. 确认当前 SQLite 迁移框架和数据表。
4. 输出影响文件、差距清单和 PoC 方案。

### 第二步：独立 PoC

1. 建立独立 `GROK_HOME`。
2. 生成只含静态自定义模型的 `config.toml`。
3. 配置 `base_url`、`model`、`api_backend`、`env_key`。
4. 将用户 API Key 从 Credential Vault 读取后仅注入 Grok 子进程环境。
5. 清理子进程中的 `XAI_API_KEY`、`GROK_CODE_XAI_API_KEY` 和不需要的 xAI 登录环境，防止误回退。
6. 启动 `grok agent stdio`，完成 ACP initialize/session/new/session/prompt 测试。
7. 验证实际 HTTP 请求走中转站。
8. 验证工具调用闭环。

### 第三步：正式实现

PoC 通过后实现 FR-01 至 FR-12，使用现有 Runtime Adapter 和统一设置/会话 UI。

### 严格禁止

- 禁止要求用户输入或配置 xAI API Key 才能使用第三方中转站。
- 禁止把 API Key 明文写入 `config.toml`、SQLite、日志或命令行参数。
- 禁止使用 `GROK_MODELS_BASE_URL` 动态模型目录功能作为中转站静态配置的前置条件。
- 禁止静默回退到 xAI 官方 API、其他中转站、其他模型或其他 Runtime。
- 禁止默认启用 `--always-approve`、`--yolo` 或 `yoloMode`。
- 禁止修改 Codex Runtime 默认值。
- 禁止用普通 Chat API 返回一段代码冒充 Grok Agent Runtime。
- 禁止在未验证工具调用前将 Provider 标为“Agent 兼容”。

### 交付物

1. 现状盘点报告。
2. PoC 代码和测试报告。
3. Runtime Adapter 实现。
4. Provider/Model 配置界面。
5. SQLite migration。
6. Credential Vault 接入。
7. ACP 生命周期管理和事件归一化。
8. Windows 干净环境启动测试。
9. 至少一条真实中转站 Agent 开发任务验收记录。
10. 变更文件清单、未完成事项和风险报告。

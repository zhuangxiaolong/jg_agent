# 精工智能开发平台——Grok Runtime 中转站接入技术方案 V1.0

> 文档类型：技术架构与实施方案  
> 产品：精工智能开发平台（Windows 桌面客户端）  
> 功能：Grok Build ACP Runtime + 第三方模型中转站  
> 版本：V1.0  
> 状态：供 Codex 研发实施  
> 日期：2026-11-11  
> 目标：通过 Grok Build ACP 接入 Agent Harness；模型推理通过用户配置的第三方 Base URL 和 API Key 完成，不强制 xAI API Key。

---

## 1. 技术目标、边界与关键结论

### 1.1 技术目标

- 将 Grok Build 作为独立 Runtime 接入精工平台。
- 通过 ACP JSON-RPC over stdio 管理 Grok Agent 进程。
- 通过 Grok Build 自定义模型配置 `[model.<name>]` 将推理请求路由到第三方中转站。
- 支持同一 Provider 多模型、多个 Provider 并存。
- 不改动 Codex/Claude/Jinggong Runtime 的现有调度和默认值。
- 使用独立 `GROK_HOME`、配置文件和子进程环境隔离每个 Provider Profile。

### 1.2 核心技术事实

Grok Build 自定义模型配置支持：

- `model`：实际传给上游接口的模型 ID。
- `base_url`：第三方中转站 API Base URL。
- `api_key` 或 `env_key`：凭据来源。
- `api_backend`：`chat_completions`、`responses`、`messages`。
- `context_window`、`max_completion_tokens` 等模型参数。
- `extra_headers`、`env_http_headers`、`query_params` 等网关特殊配置。

凭据优先级为：模型配置中的 `api_key` → `env_key` 指定的环境变量 → Grok 登录 Session Token → 全局 `XAI_API_KEY`（及兼容变量）。

因此，精工必须为中转站模型显式设置 `env_key`，并在启动 Grok 子进程时提供相应密钥。为防止不符合预期的凭据回退，子进程环境中不得继承不需要的 xAI 凭据和登录配置。

**不要使用 `GROK_MODELS_BASE_URL` 作为第三方中转站接入的基础方案。** 当前官方文档说明该模型目录发现路径要求 `XAI_API_KEY`；本方案使用静态 `[model.<alias>]` 声明模型，避免 xAI Key 依赖。

### 1.3 必须区分 Runtime 与 Model Provider

`Grok Build ACP Runtime` 是执行引擎，`Relay Provider` 是推理服务地址，`Model Profile` 是该 Provider 下的模型定义。三者不可合并为一个配置实体。

---

## 2. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│               精工智能开发平台 Windows Desktop               │
│ Runtime Picker / Provider Settings / Model Picker / Chat UI   │
└──────────────────────────────┬───────────────────────────────┘
                               │ IPC
┌──────────────────────────────▼───────────────────────────────┐
│                    Runtime Orchestrator                      │
│ Runtime Registry / Session Manager / Workspace / Permission  │
└───────────────┬──────────────────────────────────────────────┘
                │
        ┌───────▼─────────────────────────────────────────────┐
        │               GrokBuildRuntimeAdapter               │
        │ Provider Resolver / Config Generator / ACP Client   │
        │ Process Lifecycle / Event Normalizer / Health Check │
        └───────────────┬─────────────────────────────────────┘
                        │ spawn grok agent stdio
        ┌───────────────▼─────────────────────────────────────┐
        │                  Grok Build Process                  │
        │                  ACP JSON-RPC stdio                 │
        └───────────────┬─────────────────────────────────────┘
                        │
        ┌───────────────▼─────────────────────────────────────┐
        │            Grok Build Custom Model Router           │
        │ config.toml [model.<alias>] / api_backend / env_key │
        └───────────────┬─────────────────────────────────────┘
                        │ HTTPS inference requests
        ┌───────────────▼─────────────────────────────────────┐
        │          User-selected third-party model relay      │
        │ Base URL + API Key + model ID + supported protocol  │
        └─────────────────────────────────────────────────────┘

Shared platform services:
Workspace / Git Worktree / Diff / Permission Broker / MCP
Skills / Jira / MES5-MES6-WMS Knowledge / Memory / Audit
Credential Vault / Notification / SQLite
```

原则：UI 不直接管理 Grok 配置文件，不直接写环境变量，不直接解析 ACP；所有调用经 Adapter 和 Process Manager。

## 3. 接入模式与配置策略

### 3.1 静态模型配置（P0 默认）

每个已保存模型 Profile 生成一个唯一 `model` 配置段。示例仅说明格式：

```toml
[models]
default = "jinggong-relay-model-01"

[model.jinggong-relay-model-01]
model = "provider-model-id"
base_url = "https://relay.example.com/v1"
name = "团队 Grok Relay"
api_backend = "chat_completions"
env_key = "JINGGONG_GROK_RELAY_01_API_KEY"
context_window = 128000
max_completion_tokens = 8192
```

说明：
- `jinggong-relay-model-01` 是 Grok 内部配置别名，不是上游模型 ID。
- `provider-model-id` 是中转站要求传入的真实模型 ID。
- `env_key` 仅存环境变量名称，不存密钥。
- Base URL 必须由用户提供并经过 HTTPS 校验。
- `context_window`、`max_completion_tokens` 必须使用中转站公布或实测值，不允许盲目套用 256K。

如果中转站需要自定义 Header：

```toml
[model.jinggong-relay-model-01]
model = "provider-model-id"
base_url = "https://relay.example.com/v1"
api_backend = "chat_completions"
env_key = "JINGGONG_GROK_RELAY_01_API_KEY"
env_http_headers = { "X-Tenant-Token" = "JINGGONG_GROK_RELAY_01_TENANT" }
```

`env_http_headers` 中只允许保存 Header 到环境变量名称的映射。实际 Header 值从 Credential Vault 读取，运行期注入。

### 3.2 API Backend 映射

| 精工设置值 | Grok config | 接口路径类别 | 适用条件 |
|---|---|---|---|
| OpenAI Chat Completions | `chat_completions` | `/v1/chat/completions` | 中转站实现 OpenAI Chat Completions |
| OpenAI Responses | `responses` | `/v1/responses` | 中转站实现 Responses API |
| Anthropic Messages | `messages` | `/v1/messages` | 中转站实现 Anthropic Messages API |

默认 `chat_completions`，用户可选择其他协议。协议选择只说明 HTTP API 格式，不代表所有 Agent 工具功能都兼容。

### 3.3 不使用动态模型列表作为必要条件

官方 `GROK_MODELS_BASE_URL` 会从 `{base_url}/models` 获取模型列表，当前配置说明仍要求 `XAI_API_KEY`；因此首期不使用它。

P0 使用静态 Model Profile。P1 如要自动发现模型列表，必须先通过不依赖 xAI Key 的认证 PoC，不能将其作为第三方 Provider 的默认方案。

---

## 4. 多租户概念（本地 Profile 隔离）

单机桌面场景不引入服务器多租户，但需要隔离多个中转站配置。

建议实体：

- Runtime：`grok_build_acp`
- Provider Profile：一个中转站服务地址和鉴权配置。
- Model Profile：一个 Provider 下的模型定义。
- Runtime Installation：本机 Grok Build 程序版本和安装路径。
- Runtime Session：绑定 Provider Profile、Model Profile 和 Grok 原生 Session。

同一 Provider 可有多个模型；多个 Provider 可配置同名模型 ID，但 Profile ID 必须唯一。

## 5. 进程与配置文件隔离

### 5.1 独立 GROK_HOME

Grok Build 默认用户配置目录为 `%USERPROFILE%\.grok`，并支持通过 `GROK_HOME` 改变配置目录。

精工首期应为每个 Provider Profile + Model Profile 分配独立执行目录，例如：

```text
%LOCALAPPDATA%/Jinggong/Runtime/Grok/
  installations/
    stable-x64/
  profiles/
    {provider-profile-id}/
      {model-profile-id}/
        config.toml
        sessions/
        logs/
        cache/
```

具体目录结构需用锁定版本 Grok Build 实际验证。不得直接假设所有目录都由 `GROK_HOME` 创建；启动 PoC 时检查实际落盘文件。

### 5.2 config.toml 生成

- 使用 TOML 库生成，不得字符串拼接模型名、URL 和 Header。
- 写文件采用临时文件 + 原子替换。
- 使用 UTF-8。
- 配置文件 ACL 仅允许当前 Windows 用户访问。
- 配置文件不得含明文 API Key、Tenant Token 或 Authorization 值。
- 默认模型指向当前 Provider Profile 的默认 Model Profile。
- 每个 Provider Profile + Model Profile 执行目录之间互不覆盖；该目录的 `[models].default` 固定指向唯一模型别名，确保会话请求不会串用模型。

### 5.3 子进程环境变量

启动环境由“必要的最小父环境 + Provider 凭据环境”构造。不得无差别继承整份系统环境。

必须：
- 注入 `GROK_HOME=<provider-profile-dir>`。
- 注入 `[model.*].env_key` 指定的 API Key 环境变量。
- 如有 `env_http_headers`，注入对应环境变量。
- 清除 `XAI_API_KEY`、`GROK_CODE_XAI_API_KEY` 等不需要的全局凭据变量。
- 检查是否存在 Grok 登录 Session 文件；隔离 `GROK_HOME` 可防止读取用户默认登录态。
- 不写入 `api_key` 配置字段。

注意：如果 Grok 对特定 endpoint 仍尝试触发 xAI 认证流程，PoC 必须发现并阻断，不允许假装成功。

## 6. Runtime Adapter 设计

先检查现有抽象接口，以下是概念接口，不要求照搬命名：

```ts
export type RuntimeKind =
  | "codex"
  | "jinggong"
  | "claude_agent_sdk"
  | "grok_build_acp";

export interface GrokProviderProfile {
  id: string;
  displayName: string;
  baseUrl: string;
  credentialRef: string;
  enabled: boolean;
}

export interface GrokModelProfile {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
  apiBackend: "chat_completions" | "responses" | "messages";
  contextWindow?: number;
  maxCompletionTokens?: number;
  reasoningSummary?: "none" | "auto" | "concise" | "detailed";
  enabled: boolean;
}

export interface GrokBuildRuntimeAdapter extends RuntimeAdapter {
  validateInstallation(): Promise<GrokInstallationHealth>;
  validateProvider(providerId: string): Promise<ProviderHealthReport>;
  startSession(request: RuntimeSessionRequest & {
    providerProfileId: string;
    modelProfileId: string;
  }): Promise<RuntimeSessionHandle>;
}
```

不要在会话 UI 内写 Grok 专属业务逻辑。Runtime Adapter 负责将 ACP 消息转换为现有平台统一事件。

## 7. Grok ACP Process Manager

### 7.1 启动

默认启动形态：

```powershell
grok agent stdio
```

准确命令需按锁定版本验证，概念上应是 `grok agent stdio`。如需要指定模型、权限策略或 Agent Profile，使用该版本官方支持的 CLI 参数，但不要使用始终批准模式。

启动参数与环境：
- executable：平台安装/受控组件目录中的 grok 可执行文件。
- args：`agent stdio` 及经过核验的非敏感参数。
- cwd：当前 Workspace 任务主仓库 Worktree。
- env：独立 `GROK_HOME`、中转站密钥变量、代理配置。
- stdin/stdout：ACP JSON-RPC。
- stderr：脱敏诊断日志。

不使用 `shell: true`。Windows 优先直接启动受信任可执行文件，避免命令行注入。

### 7.2 生命周期

- `starting`：创建进程并等待 initialize 响应。
- `ready`：ACP initialize 成功并完成协议能力协商。
- `session_opening`：创建 Session。
- `running`：处理 Prompt/事件。
- `cancelling`：发送受支持取消消息；如当前 Grok ACP 版本没有可用取消请求，则使用受控中断策略。
- `exited`：正常结束或用户关闭。
- `failed`：初始化、进程或协议错误。

### 7.3 进程复用

P0 建议进程按 Provider Profile + Model Profile + 工作区安全边界隔离；同一 Provider 下不同 Model Profile 可分别启动独立进程，保证每个进程的静态默认模型唯一。后续只有在 ACP 会话模型切换能力经过契约测试后，才可考虑同进程切换模型以降低启动开销。不得为了复用进程导致不同 Provider 的 API Key/Base URL/模型 ID 串用。

### 7.4 ACP JSON-RPC 客户端

必须实现：
- 消息 ID 生成与并发请求路由。
- JSON-RPC response / notification / error 分发。
- stdout 按行/协议流安全解析，不假设一行一定完整或永远不会分片。
- stderr 独立处理。
- 请求超时、进程关闭、意外 EOF 和异常 JSON 处理。
- 背压及大输出保护。
- 未知 ACP 扩展事件保留元数据但安全忽略。
- 会话事件绑定 platformSessionId / runtimeSessionId。

官方 ACP 流程包括 `initialize`、`session/new`、`session/prompt` 和 `session/update`。实现必须按实际 ACP schema 和 Grok 版本核对，不可照抄不完整的示例客户端。

## 8. Provider/Model 连接测试

### 8.1 分层测试

| 测试等级 | 内容 | 可以得出的结论 |
|---|---|---|
| L0 | URL 格式、HTTPS、DNS/TCP | 网络可达性 |
| L1 | 简单请求/鉴权 | 凭据与模型名有效性 |
| L2 | 流式文本 | 流式兼容性 |
| L3 | Function/Tool Calling | 单轮工具调用兼容性 |
| L4 | 多轮 Tool Calling | Agent 工具闭环兼容性 |
| L5 | ACP Agent 实际工作区操作 | Grok Runtime 可用性 |

只有 L4 和 L5 通过，才可以显示“Agent 兼容”。

### 8.2 测试模型调用

不要让精工自己额外构造与 Grok Build 不同的模型请求并以此替代实际 Agent 测试。优先使用 Grok Build 通过当前 Provider Profile 发起的真实 Agent 测试任务，保证测试路径与生产一致。

### 8.3 错误归一化

映射：
- `401/403` → 凭据无效/服务商拒绝。
- `404` → Base URL 或模型路径/模型 ID 错误。
- `400/422` → 请求协议或参数不兼容。
- `429` → 限流/额度/并发限制。
- `5xx` → 上游中转站异常。
- Timeout / Connection reset / DNS → 网络或服务不可用。
- Tool call parse error → 工具调用格式兼容问题。
- ACP process exit → Runtime 进程故障。

需要同时展示用户可理解的建议和脱敏技术详情。

## 9. SQLite 数据模型

先检查现有 Runtime/Model Provider 表，能够扩展就不要重复创建相同职责表。

建议新增/扩展：

### 9.1 `grok_provider_profile`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | Profile ID |
| display_name | TEXT | 服务商显示名称 |
| base_url | TEXT | API Base URL |
| credential_ref | TEXT | Windows Vault 引用 |
| auth_mode | TEXT | bearer/env/custom header |
| enabled | INTEGER | 是否启用 |
| is_default | INTEGER | 默认 Provider |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### 9.2 `grok_model_profile`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | Model Profile ID |
| provider_id | TEXT FK | Provider |
| model_id | TEXT | 上游实际模型 ID |
| display_name | TEXT | UI 名称 |
| api_backend | TEXT | chat_completions/responses/messages |
| context_window | INTEGER | 上下文窗口 |
| max_completion_tokens | INTEGER | 最大输出 |
| reasoning_summary | TEXT | Responses 选项 |
| enabled | INTEGER | 是否启用 |
| capability_status_json | TEXT | 实测能力结果 |
| created_at | TEXT | 创建时间 |
| updated_at | TEXT | 更新时间 |

### 9.3 `grok_runtime_installation`

| 字段 | 说明 |
|---|---|
| id | 主键 |
| version | Grok Build 版本 |
| executable_path | 可执行文件路径 |
| architecture | Windows x64 等 |
| checksum | 校验值 |
| signature_status | 签名状态 |
| installed_at | 安装时间 |

### 9.4 `grok_runtime_process`

仅记录受控进程元数据：pid、provider_profile_id、groK_home、启动时间、退出码、状态。不得保存进程环境变量明文。

### 9.5 `grok_runtime_session_binding`

保存 platform session ID、ACP session ID、provider profile ID、model profile ID、Runtime 版本和状态。

### 9.6 数据约束

- API Key 不入 SQLite。
- `base_url` 不包含密钥或用户敏感 query 参数。
- 日志不记录完整请求 Header。
- Provider 删除前检查会话引用；历史 Session 不因删除 Provider 而丢失。
- migration 必须向后兼容现有会话和 Runtime 设置。

## 10. 凭据安全

### 10.1 Credential Vault

复用平台现有 Windows Credential Manager/DPAPI 实现。

推荐 Credential Target：

`Jinggong/GrokProvider/{providerProfileId}/ApiKey`

如自定义 Header 还需要 Tenant Token，使用独立 Credential Target。

### 10.2 安全规则

- `api_key` 永不写入生成的 TOML。
- 优先用 `env_key` 将变量名指向对应环境变量。
- 自定义 Header Secret 使用 `env_http_headers`，不使用明文 `extra_headers`。
- 禁止将 API Key 放到 URL、query string、命令行参数。
- 子进程环境白名单化；过滤 `XAI_API_KEY`、`GROK_CODE_XAI_API_KEY` 和用户默认 Grok 登录数据。
- 错误响应、stderr、崩溃报告必须脱敏。
- 不对中转站做静默自动重试导致重复扣费；对可安全重试的请求按幂等/请求状态判断。

### 10.3 凭据注入示例

```ts
const childEnv = buildMinimalRuntimeEnvironment();
childEnv.GROK_HOME = providerHome;
childEnv.JINGGONG_GROK_RELAY_01_API_KEY = apiKeyFromVault;

// 防止不需要的 xAI 凭据回退
 delete childEnv.XAI_API_KEY;
 delete childEnv.GROK_CODE_XAI_API_KEY;

spawn(grokExecutable, ["agent", "stdio"], {
  cwd: taskWorkingDirectory,
  env: childEnv,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});
```

示例仅表达安全原则，变量名须由模型配置生成并与 TOML `env_key` 一致。

## 11. ACP 能力映射

| ACP/Grok 能力 | 精工平台映射 |
|---|---|
| `initialize` | Runtime 初始化、能力协商 |
| `session/new` | 创建平台 Session 绑定 |
| `session/load` | 恢复会话（先验证支持） |
| `session/prompt` | 用户发送任务 |
| `session/update` | 文本/工具/计划/进度事件 |
| permission request | 平台 Permission Broker |
| tool call/update | 会话工具执行时间线 |
| model config option | 模型选择/推理等级（按能力显示） |
| cancel/stop | 停止任务（按协议版本和能力实现） |

Grok ACP 包含部分 `x.ai/*` 扩展方法，必须通过 `initialize` 响应能力发现，不应把非标准扩展当作跨版本稳定保证。

## 12. Workspace 与多仓库

### 12.1 首期策略

Grok ACP 的 `session/new` 以 `cwd` 指定主工作目录。首期将当前任务的主仓库 Worktree 作为 `cwd`。

其他仓库访问必须通过经过授权的路径暴露、精工 MCP Workspace 工具或已验证的 Grok 附加目录能力。由于公开 ACP 核心 `session/new` 示例只明确给出单个 `cwd`，Codex 不得直接声称多仓库已原生支持。

### 12.2 多仓库 PoC

必须验证：
- 主仓库文件可读取/写入。
- 第二仓库通过选定方案可读取/写入。
- 每个仓库 Diff 独立。
- Agent 无法写入工作区外目录。
- 两个不同 Runtime 不能同时持有同一任务工作树写锁。

若采用 MCP Workspace 工具：
- 工具服务由精工本机进程提供。
- 工具参数必须携带 workspaceId/repositoryId。
- 所有路径由服务端做 canonical path 校验。
- 禁止 `../`、符号链接逃逸、UNC 未授权目录和盘符绕行。
- 文件写入只允许指定任务 Worktree。

## 13. ACP Permission 和安全执行

- 不用 `--always-approve`、`--yolo` 或 `yoloMode=true` 作为默认。
- `session/new` 采用默认 Ask/受审批模式；实际字段以 ACP 版本核对。
- ACP 权限请求映射到平台 Permission Broker。
- 读取授权 Worktree 可按安全策略放行。
- 写文件、执行命令、安装依赖、网络访问按风险级别决定审批。
- Git push、merge、release 默认拒绝或高等级审批。
- Windows 下 Grok 沙箱边界必须独立验证；Agent 工具权限不等于 OS 级隔离。
- 如无法保证 Windows 对工作区外文件访问的强制限制，高风险动作必须由精工自定义工具代理，或在安全策略下禁用。

## 14. UI 技术要求

### Provider 管理页

- 服务商名称。
- Base URL。
- API Key（掩码显示，保存到 Vault）。
- 默认认证方式。
- 协议选择。
- 自定义 Header（可选，Secret 引用，不显示明文）。
- 连接测试。
- Agent 能力测试结果。

### Model 管理页

- 上游 Model ID。
- UI 显示名称。
- API Backend。
- Context Window。
- Max Completion Tokens。
- Reasoning Summary（适用时）。
- 工具调用/流式/并行调用能力测试状态。

### 会话选择器

- Runtime：Grok Build Runtime。
- Provider：选择已启用 Provider。
- Model：该 Provider 下已验证或未验证的模型（未验证模型需显示警告）。
- 会话标签显示 Provider + Model。

## 15. 日志、监控和成本

记录：
- Provider Profile ID / Model Profile ID。
- Base URL Host（可配置脱敏）。
- Runtime 版本、ACP session ID。
- 请求开始/结束时间、延迟类别、错误类别。
- 上游 usage（如果 ACP/中转站可获得）。
- 工具调用数、子 Agent 数量（如果事件可获得）。

不记录：API Key、完整 Authorization、完整环境、用户文件原文、敏感 Prompt（除非用户明确启用本地诊断保存）。

## 16. 版本和安装包

- Grok Build 版本必须固定，不自动追随 latest。
- 安装包或首次初始化器获取官方发行版时校验签名/哈希。
- 不从未验证镜像下载执行文件。
- 更新前运行 ACP Smoke Test，失败回滚旧版本。
- 使用用户本地的 Grok Build 安装时，先检测版本和路径，不覆盖用户安装。
- 精工自带 Runtime 版本采用隔离安装目录，不依赖用户 PATH。

## 17. 实施阶段

### Sprint 0：现状盘点和最小 PoC

1. 检查 Runtime Adapter、ACP、Credential Vault、SQLite。
2. 确认 Grok Build 当前稳定版本和 Windows x64 安装包。
3. 创建独立临时 `GROK_HOME`。
4. 配置一个静态 custom model，使用 `env_key`。
5. 不提供 xAI Key、不使用 Grok login。
6. 启动 `grok agent stdio` 并完成 ACP 初始化。
7. 发起真实 Prompt，检查中转站服务端日志/请求记录。
8. 完成流式输出和至少两轮工具调用。
9. 验证 API Key 不落盘。
10. 形成 PoC 结论；核心条件失败则暂停主程序集成。

### Sprint 1：Provider 和 Model 管理

1. SQLite migration。
2. Provider CRUD。
3. Model CRUD。
4. Credential Vault 集成。
5. TOML Generator。
6. 连接测试和能力检测。

### Sprint 2：ACP Runtime Adapter

1. Process Manager。
2. ACP JSON-RPC Client。
3. Session Manager。
4. Event Normalizer。
5. 工具审批和取消。
6. 断线/退出处理。

### Sprint 3：Workspace/插件/企业能力

1. 单仓库基线。
2. 多仓库访问 PoC。
3. Workspace MCP 工具（如有必要）。
4. Skills/MCP 注入。
5. 企业知识和 Jira Context Bundle。
6. Git Diff、测试和通知。

### Sprint 4：Windows 发布和回归

1. 干净 Windows x64 安装测试。
2. Grok Runtime 版本检测。
3. 配置/凭据/Session 重启恢复。
4. Codex、Claude、Jinggong 回归。
5. 性能基线和异常回退测试。

## 18. 测试计划

### 18.1 协议兼容测试矩阵

至少测试：
- Chat Completions + 工具调用 + SSE。
- Responses + 工具调用 + 流式（仅当中转站支持）。
- Anthropic Messages + tools + stream（仅当中转站支持）。

每一种组合单独记录测试结果，不允许“服务商整体兼容”掩盖某个模型/协议组合不支持。

### 18.2 Agent 真实任务

- 只读分析一个仓库。
- 修改一个文件并展示 Diff。
- 修改两个文件并运行测试。
- 工具调用两轮以上。
- 工具权限审批。
- 错误 API Key。
- 无效模型 ID。
- 429/5xx/超时。
- 无 xAI 登录态和无 xAI Key。
- 双 Provider 并发会话隔离。

### 18.3 通过标准

必须全部满足：
- 第三方 Relay 正确收到请求。
- 真实请求模型 ID 正确。
- 真实鉴权凭据正确且无泄漏。
- 不依赖 xAI Key/Session。
- Agent 工具调用闭环成功。
- Runtime 进程退出可回收。
- Codex Runtime 默认不变。

## 19. 风险清单

| 风险 | 影响 | 缓解方式 |
|---|---|---|
| Relay 只支持文本聊天 | Agent 无法调用工具 | L3/L4 测试，不通过则禁止 Agent 标识 |
| Relay 协议有私有差异 | 请求被拒绝 | 单独配置 backend、headers、参数；按模型验证 |
| Grok 自动回退 xAI 认证 | 可能绕过用户预期/误计费 | env_key 显式绑定，清理 xAI env，独立 GROK_HOME |
| 动态模型发现要求 XAI Key | 中转站模式无法初始化 | 使用静态模型配置 |
| Windows 沙箱能力不完整 | 文件安全风险 | Permission Broker + Worktree + OS 限制 PoC |
| Grok ACP 扩展变化 | 版本升级故障 | 锁版本、能力发现、契约测试 |
| 多仓库只支持单 cwd | 跨仓库能力不足 | Workspace MCP 或实证附加路径方案 |
| API Key 写入 config | 密钥泄漏 | env_key/env_http_headers + Credential Vault |

## 20. Codex 开发指令

请基于当前精工智能开发平台实际代码进行增量开发。不要重建 Runtime 系统。

### Phase A：架构盘点

- 输出当前 Runtime Adapter/Provider/Model/Session/Workspace/Credential/ACP 的代码结构。
- 识别可复用模块。
- 识别需要的数据库 migration。
- 确认 Grok Build 当前版本、Windows Binary 路径和官方安装方式。

### Phase B：PoC（必须先做）

- 通过 `GROK_HOME` 建立独立配置目录。
- 写入静态 `[model.<alias>]` 配置：Base URL、model ID、api_backend、env_key。
- 从 Credential Vault 获取第三方 API Key，仅注入子进程环境。
- 子进程环境禁止继承 xAI Key 和默认用户 Grok 登录态。
- 不调用 `GROK_MODELS_BASE_URL`。
- 启动 `grok agent stdio`，完成 ACP initialize/session/new/prompt。
- 检查中转站请求 Host、model ID、auth header。
- 完成流式响应和至少两轮真实工具调用。
- 输出 PoC 测试证据。

### Phase C：正式开发

PoC 通过后按 Sprint 1-4 实施。

### 不允许

- 不得要求用户配置 xAI API Key。
- 不得依赖用户 `grok login` 的浏览器认证态。
- 不得把密钥写入 TOML、SQLite、日志或命令行。
- 不得将 `GROK_MODELS_BASE_URL` 当作第三方中转站无 xAI Key 的模型发现方案。
- 不得默认使用 always-approve/yolo。
- 不得将文本对话测试当成 Agent 工具调用通过。
- 不得失败后静默回退到 xAI 官方 API/其他 Provider/其他 Runtime。
- 不得影响 Codex Runtime 默认值。

### 交付物

1. 架构盘点报告。
2. PoC 源码、配置样例（无真实密钥）和测试报告。
3. Provider/Model UI。
4. SQLite migration。
5. Credential Vault 集成。
6. Grok ACP Process Manager/Client/Adapter。
7. 事件映射和权限审批。
8. Windows 安装及运行验证。
9. 一次真实中转站 Grok Agent 代码修改任务报告。
10. 变更文件清单、测试结果和已知限制。

---

## 21. 官方资料

1. Grok Build Overview：https://docs.x.ai/build/overview
2. Custom Models：https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/11-custom-models.md
3. Agent Mode / ACP：https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/15-agent-mode.md
4. Settings：https://docs.x.ai/build/settings
5. Subagents：https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/16-subagents.md

实施时以所锁定 Grok Build 版本的当前官方文档、实际 `grok inspect` 输出和 PoC 为准。不要把 GitHub main 分支的配置字段未经版本校验直接带入生产。

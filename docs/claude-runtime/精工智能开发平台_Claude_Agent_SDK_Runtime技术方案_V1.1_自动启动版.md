# 精工Agent——Claude Agent SDK Runtime 技术方案 V1.1（自动启动版）

> 文档类型：技术架构与实施方案  
> 产品：精工Agent（Windows 桌面客户端）  
> 版本：V1.1（自动启动版）  
> 状态：供 Codex 研发实施  
> 日期：2026-11-09  
> 设计原则：增量改造现有平台，不推倒重来；Codex Runtime 继续默认；Jinggong Runtime 和 Claude Agent SDK Runtime 均为可选；用户无需单独安装、登录或手动启动 Claude Code，Claude Runtime 由精工平台自动检测、初始化并通过 SDK 启动底层执行进程。

---

## V1.1 修订说明

本版本在 V1.0 基础上补充 Claude Runtime 的自动启动和免手工操作要求：
- 用户只需启动精工Agent，不需要单独启动 Claude Code 桌面程序或 CLI。
- 精工平台按需初始化 Claude Agent SDK；SDK 自动管理其依赖的 Claude Code 原生 Binary 进程。
- 安装包负责携带并校验 SDK 与 Windows 原生依赖；缺失时通过平台修复，不让用户手动安装 Claude Code。
- 增加无全局 Claude CLI 的干净 Windows 验收场景，以及进程回收、预检和真实连接测试边界。

---

## 1. 技术目标与约束

### 1.1 技术目标

在现有精工Agent中增加 `ClaudeAgentSdkRuntimeAdapter`，通过官方 `@anthropic-ai/claude-agent-sdk` 将 Claude Code Agent 能力接入平台。

新增能力必须复用平台已有的：
- Runtime 选择和调度。
- 多仓库 Workspace/Repository 管理。
- Git Worktree 和 Diff 管理。
- 平台会话、任务状态与上下文交接。
- 统一权限审批、工具审计和敏感信息脱敏。
- Jira、MES5/MES6/WMS 知识库和项目记忆服务。
- Windows 安装、版本检查和自动升级体系。

### 1.2 非目标

- 不通过 shell 手动调用 `claude -p` 作为集成主方案。
- 不要求用户单独安装 Claude Code 桌面程序或全局 CLI。
- 不要求用户在使用精工平台前手动打开 Claude Code、运行 `claude` 命令或保持 Claude Code 窗口常驻。
- 不自行实现 Claude Agent Loop。
- 不把 Claude SDK 包装成与 Codex/Jinggong 完全相同的内部会话协议；仅在平台边界做能力归一化。
- 不允许用户把 Claude.ai/Pro/Max 登录态或订阅额度作为平台 API 凭据。
- 不假设任何 OpenAI-compatible 中转站都兼容 Anthropic Agent SDK。

### 1.3 前提约束

- 首发目标 Windows 10/11 需由 Codex 在当前项目中验证；产品推荐 Windows 11 x64。
- 当前主应用的实际框架、目录和 Runtime 抽象必须由 Codex 先盘点，技术方案不强制替换现有 Electron/Tauri 或其他技术栈。
- 本方案默认采用 TypeScript SDK，因为它适合与 Electron/Node 桌面主进程集成；若现有工程技术栈不支持 Node SDK，再由 Codex评估独立 Node Worker，不得直接引入 Python 服务器。
- SDK 官方 TypeScript 包带有平台可选原生依赖；Windows x64 应使用对应 Windows 包并验证安装包确实包含 `claude.exe`。该二进制是 SDK 的内部运行依赖，不是要求用户单独安装或手动启动的 Claude Code 产品。
- Claude Runtime 采用按需懒启动：用户选择 Claude Runtime 或首次提交 Claude 任务时，由精工平台完成预检并初始化 SDK；SDK 在执行任务时自动管理底层 Claude Code 原生子进程。不得要求用户先启动 Claude Code GUI/CLI。

## 2. 关键事实与集成边界

### 2.1 Claude Agent SDK 不等于纯 HTTP 模型 SDK

官方说明：Claude Agent SDK 将 Claude Code 的 Agent Loop、工具和上下文管理作为可编程能力提供；SDK 本身会运行 Claude Code 原生二进制，并提供 Node/TypeScript 或 Python API。

因此，精工平台应使用 SDK API（如 `query()`）创建、控制 Agent 任务，而不是自己拼 shell 参数调用 `claude -p`。不过，SDK 内部仍会启动并管理随 SDK 提供的 Claude Code 原生进程。**用户不需要启动 Claude Code 桌面程序，也不需要在终端执行 `claude` 命令**；精工平台只需在需要执行 Claude 任务时调用 SDK，底层进程由 SDK 自动管理。

必须区分三件事：
- **用户侧产品启动**：用户只启动精工Agent。
- **平台侧 SDK 初始化**：由精工 Runtime Adapter/Worker 自动完成。
- **SDK 内部执行进程**：SDK 根据任务调用自动启动、管理和释放随包分发的 Claude Code Binary。

这一自动启动链路必须在 PoC、进程隔离和最终安装包测试中验证，不能以开发机已安装全局 Claude CLI 作为成功条件。

### 2.2 SDK 包与 Windows 原生二进制

官方 TypeScript 安装方式：

```bash
npm install @anthropic-ai/claude-agent-sdk
```

官方文档说明 SDK 会通过平台可选依赖携带对应 Claude Code Binary。Windows x64 对应包路径示例：

```text
@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe
```

实现要求：
- 锁定 `@anthropic-ai/claude-agent-sdk` 版本。
- 锁定与 SDK 版本匹配的 Windows 原生可选依赖。
- 不依赖用户全局安装 Claude Code，也不依赖 PATH 中存在 `claude` 命令。
- 不要求用户手工下载、安装或更新 Claude Code。
- 打包阶段验证 optionalDependencies 没有被裁剪。
- 对 Electron ASAR 打包，检查 SDK 查找原生二进制的路径；必要时将二进制通过 `asarUnpack` 或独立 runtime 目录释放到真实文件路径，并通过 `pathToClaudeCodeExecutable` 显式传入。
- 应用启动时执行 Binary 版本/签名/哈希检查；不得静默下载未知可执行文件。
- 安装包更新时 SDK 与 Binary 成对升级，保留可回退版本。
- SDK 所需 Binary 缺失、损坏或版本不匹配时，由精工平台显示“修复 Claude Runtime”操作；不得要求用户改为手工安装 Claude Code。修复包只能来自受信任的官方/受控分发源，并验证签名或哈希。

### 2.3 Windows Shell 依赖

官方 SDK 参考中存在 Windows `shell_tool_missing` 情况：当 Git Bash 不可用，且 PowerShell 工具被关闭时，Shell 工具不可用。

实施要求：
- 首次运行诊断 PowerShell 和 Git Bash 可用性。
- 验证 SDK 在精工目标 Windows 镜像上的实际行为。
- 不以“SDK 包安装成功”代替终端工具可用性测试。
- 优先复用现有已安装的 Git for Windows / PowerShell；如果产品必须真正做到安装即用，则单独评估随安装包分发 Git Bash 运行组件的许可、大小和升级成本。
- 对 shell 命令执行仍由统一审批与工作区目录约束管理。
- PowerShell/Git Bash 是 Agent 执行 Shell 工具时可能需要的系统运行环境，与“是否需要用户启动 Claude Code”无关。平台必须在预检中分别报告 Shell 能力；不能把缺少 Shell 依赖误报为需要用户启动 Claude Code。若产品承诺干净 Windows 安装即用，应在安装包层面解决必要 Shell 依赖或明确列出系统最低要求。

## 3. 总体架构

```text
┌───────────────────────────────────────────────────────────┐
│              精工Agent Windows Desktop             │
│  Runtime选择 / 会话 / Workspace / Jira / 知识库 / Diff      │
└─────────────────────────────┬─────────────────────────────┘
                              │ IPC（应用内）
┌─────────────────────────────▼─────────────────────────────┐
│                 Runtime Orchestrator                       │
│ Runtime Registry / Session Manager / Workspace Lock        │
│ Task Context Builder / Permission Broker / Event Normalizer│
└────────────┬──────────────────┬─────────────────┬──────────┘
             │                  │                 │
     ┌───────▼──────┐    ┌──────▼───────┐  ┌──────▼────────────┐
     │ Codex Adapter│    │Jinggong      │  │Claude SDK Adapter │
     │  默认         │    │Runtime       │  │可选               │
     └──────────────┘    └──────────────┘  └────────┬─────────┘
                                                   │ SDK API
                                          ┌────────▼─────────┐
                                          │ @anthropic-ai/   │
                                          │ claude-agent-sdk │
                                          └────────┬─────────┘
                                                   │ SDK 管理子进程
                                          ┌────────▼─────────┐
                                          │ Claude Code      │
                                          │ native binary    │
                                          └──────────────────┘

┌───────────────────────────────────────────────────────────┐
│ 共用平台服务                                                │
│ Workspace Registry / Git Worktree / Diff / Knowledge       │
│ Jira Connector / Memory / Audit / Credential Vault         │
└───────────────────────────────────────────────────────────┘
```

原则：每个 Runtime 通过 Adapter 接口接入平台，不让 UI 直接依赖某一家 SDK 的数据结构。

## 4. Runtime Adapter 统一接口

先检查现有项目是否已有 Runtime 抽象。若已有，优先扩展；不得平行新增第二套调度器。

建议接口（按现有语言/类型调整）：

```ts
export type RuntimeKind =
  | "codex"
  | "jinggong"
  | "claude_agent_sdk";

export interface RuntimeCapabilities {
  streaming: boolean;
  cancel: boolean;
  resume: boolean;
  approval: boolean;
  multiRepository: boolean;
  subagents?: boolean;
  mcp?: boolean;
  usage?: boolean;
}

export interface RuntimeSessionRequest {
  platformSessionId: string;
  workspaceId: string;
  taskId?: string;
  prompt: string;
  model?: string;
  repositoryIds: string[];
  permissionProfileId: string;
  contextBundle: RuntimeContextBundle;
}

export interface RuntimeAdapter {
  kind: RuntimeKind;
  getCapabilities(): RuntimeCapabilities;
  validateConfig(): Promise<RuntimeHealth>;
  startSession(req: RuntimeSessionRequest): Promise<RuntimeSessionHandle>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  resume(sessionId: string): Promise<RuntimeSessionHandle>;
  dispose(sessionId: string): Promise<void>;
}
```

不要假定每个 Runtime 都支持完全相同的能力。由 `getCapabilities()` 返回能力，UI 根据能力展示/禁用按钮，并给出原因。

## 5. Claude Agent SDK Adapter 设计

### 5.1 运行方式

- SDK 由平台 Node 主进程或独立 Node Worker 调用。
- 在 Electron 项目中，优先考虑 Electron `utilityProcess` 或受控 Node Worker 运行 SDK，避免长任务和 SDK 子进程生命周期影响 UI 主进程。
- SDK 使用 TypeScript `query()` 返回的异步消息流，将消息转换为平台统一事件。
- 通过 `AbortController` 或 SDK 支持的取消机制停止执行。
- 由 SDK 管理 Claude Code 原生子进程；平台不得再额外创建 `claude -p` 的 shell 包装链。
- 用户不需要预先启动 Claude Code GUI/CLI；精工平台必须在 Claude 任务启动时自动初始化 SDK，由 SDK 自动拉起所需原生执行进程。
- 不建议在精工平台每次启动时无条件常驻启动 Claude 原生进程；采用按需懒启动，减少空闲资源占用。
- Runtime Adapter 负责 SDK Worker 的启动/复用策略，SDK 负责其内部 Claude Code Binary 的具体启动与生命周期；不得绕过 SDK 自行拼接原生命令行。

TypeScript 伪代码（仅说明集成方向；以当前锁定 SDK 类型为准）：

```ts
import { query } from "@anthropic-ai/claude-agent-sdk";

const abortController = new AbortController();

const stream = query({
  prompt: taskPrompt,
  options: {
    cwd: primaryRepositoryPath,
    additionalDirectories: otherAuthorizedRepositoryPaths,
    model: selectedClaudeModel,
    abortController,
    settingSources: [],
    permissionMode: "default",
    pathToClaudeCodeExecutable: resolvedBundledClaudeBinary,
    canUseTool: async (toolName, input, context) => {
      return permissionBroker.evaluate({
        runtime: "claude_agent_sdk",
        toolName,
        input,
        workspaceId,
        taskId,
        context,
      });
    },
  },
});

for await (const message of stream) {
  eventNormalizer.publish(message);
}
```

上面是结构示例，Codex 实施前必须对照锁定 SDK 版本核对字段名称、类型和支持程度。不要未经核对复制代码进入生产。该调用应由精工 Runtime Worker 自动执行，不应要求用户先启动 Claude Code。

### 5.1.1 Claude Runtime 自动启动流程（新增）

**目标体验：用户只打开精工Agent，选择 Claude Agent SDK Runtime 并提交任务；无需另行打开 Claude Code 桌面程序或命令行。**

启动时序：

1. 用户在精工平台选择 `Claude Agent SDK Runtime`，或新建任务时选择该 Runtime。
2. Runtime Orchestrator 检查该 Runtime 是否启用，并读取用户选定的 Provider、模型、工作区和权限配置。
3. `ClaudeAgentSdkRuntimeAdapter.validateConfig()` 执行本地预检：SDK 包、Windows 原生 Binary、版本/哈希、路径、Shell 能力和凭据引用是否齐全。此步骤默认不调用模型、不产生模型 Token 费用。
4. 预检通过后，平台从 Credential Vault 读取当前用户授权的 API Key/云凭据，仅在内存中构造最小化 `env`。
5. Adapter 启动或复用受控 Node Worker/Electron `utilityProcess`，并通过 IPC 发送任务参数。
6. Worker 调用 SDK `query()`；SDK 使用已配置的 `pathToClaudeCodeExecutable` 或自身解析路径，自动启动并管理随 SDK 分发的 Claude Code Binary。
7. Worker 将 SDK 消息流转换为平台统一事件，前端展示文本、工具进度、权限审批和任务状态。
8. 用户取消任务时，平台触发 `AbortController`/SDK 取消机制；SDK 结束对应执行，Worker 回收会话资源。应用退出时先优雅关闭 Worker，超时后再按受控进程树策略清理残留进程。

启动状态建议：

```text
NOT_INSTALLED -> CHECKING -> READY -> STARTING_WORKER
                                  -> SDK_STARTING_AGENT
                                  -> RUNNING -> STOPPING -> STOPPED
任意检查/启动步骤失败 -> ERROR_NEEDS_REPAIR 或 ERROR_NEEDS_CONFIG
```

实现约束：
- **不要求用户启动 Claude Code GUI/CLI**，也不以检测到全局 `claude` 命令作为 Claude Runtime 可用条件。
- 不能在 UI 启动时提示用户“请先打开 Claude Code”；应显示精工自己的 SDK/Binary/Shell/凭据检查结果。
- `validateConfig()` 与“测试连接”分开：本地预检不调用模型；用户主动点击“测试连接”时才进行真实 API 请求，并明确可能产生费用。
- 若 SDK 或 Binary 不完整，显示“Claude Runtime 组件缺失/损坏”和平台内修复入口；不得退化成普通聊天 API，也不得静默切换 Codex Runtime。
- 若 Shell 环境缺失，明确提示具体缺少 PowerShell 或 Git Bash 能力；不得提示用户启动 Claude Code。
- 只有用户主动选择 Claude Runtime 时才启动对应 Worker；不因平台默认 Runtime 为 Codex 而预先启动 Claude Agent。

### 5.2 SDK Options 策略

| SDK 能力/参数 | 平台策略 |
|---|---|
| `cwd` | 使用工作区的主仓库或任务主仓库路径 |
| `additionalDirectories` | 只传入本任务授权的其他仓库/Worktree 目录 |
| `model` | 使用 Claude Runtime 单独配置的模型 ID |
| `abortController` | 绑定平台取消按钮和任务生命周期 |
| `permissionMode` | 默认使用需要审批的安全模式；不开放无限制模式作为默认 |
| `canUseTool` | 对待审批工具调用转接平台统一 Permission Broker |
| `allowedTools` | 仅用于明确预授权工具，不把它误认为工具白名单 |
| `disallowedTools` | 用于硬禁用高风险工具，但仍需配合 hooks/Permission Broker |
| `settingSources` | 默认 `[]`，避免自动继承用户/项目/本地 Claude 设置造成规则越权；经项目信任和策略审查后可选加载 `project` |
| `mcpServers` | 仅提供平台审核过的 MCP 服务器，不自动继承个人全局 MCP |
| `agents` | P1，平台后续按任务模板定义受控 Subagents |
| `resume` | 只用于 Claude 自己的原生 Session ID |
| `pathToClaudeCodeExecutable` | 指向应用安装目录中的受信任 Claude 原生二进制真实路径 |
| `env` | 通过安全凭据库按任务注入最小环境变量，不持久化到日志 |

特别注意：官方文档说明 `allowedTools` 是自动预批准列表，不代表其余工具都会被禁止；如果需要禁止工具，要使用 `disallowedTools`、permission rules、hooks 和 `canUseTool`。严禁将 `bypassPermissions` 作为默认模式。

## 6. 认证与模型配置

### 6.1 支持的认证方式

优先支持：
1. Claude Console API Key。
2. Anthropic 官方支持的云服务商凭据（例如当前官方支持的云托管方式，具体范围由 Codex 查询最新官方文档确认）。
3. 经验证的 Anthropic API 协议兼容服务凭据（须满足服务商自身授权条款和 Anthropic 商业条款）。

禁止：
- 在精工应用内收集 Claude.ai 用户名/密码。
- 收集或中转 Claude.ai OAuth Token、Cookie、Session Token。
- 将 Pro/Max/Ultra 订阅配额作为第三方平台 API 服务转接。
- 为多个用户共享平台所有者的个人凭据并隐藏实际计费主体。

### 6.2 凭据存储

建议抽象统一凭据接口：

```ts
interface CredentialVault {
  setSecret(key: string, value: string): Promise<void>;
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
}
```

Windows 实现：
- 优先 Windows Credential Manager；或使用 DPAPI CurrentUser 保护加密数据。
- SQLite 只保存 credential reference，不保存明文。
- 注入 SDK 子进程环境时只在内存中构造必要的环境对象。
- 日志统一遮蔽 `ANTHROPIC_API_KEY`、云服务凭据和 Authorization Header。
- 测试连接、错误报告和诊断导出不得输出密钥。

### 6.3 Anthropic 兼容服务/中转站

- Claude Agent SDK 并不等同于通用 OpenAI-compatible API 客户端。
- 只有提供 Anthropic Messages API/Claude Code 所需协议兼容能力的服务，才可尝试接入。
- 自定义 Base URL、环境变量（例如 `ANTHROPIC_BASE_URL`）是否能被当前 Agent SDK 内置 Binary 读取，必须做独立 PoC 验证。
- 不在未验证前将任意 OpenAI 中转站展示为 Claude Runtime 可用渠道。
- 为每个渠道配置单独的 `providerId`、`baseUrl`、`credentialRef` 和允许模型列表。
- 不将 API Key 或 Base URL 拼到命令行参数中；使用 SDK `env` 或受支持的环境注入配置。

## 7. 多仓库 Workspace 适配

### 7.1 目录映射

平台现有工作区模型应包含：

```ts
interface WorkspaceRepository {
  id: string;
  workspaceId: string;
  name: string;
  role: "frontend" | "backend" | "common" | "integration" | "database" | "other";
  rootPath: string;
  taskWorktreePath?: string;
  branch?: string;
  baseCommit?: string;
  techStack?: string[];
  testCommands?: string[];
  buildCommands?: string[];
  enabled: boolean;
}
```

### 7.2 Claude SDK 目录注入

- 选择一个主仓库作为 `cwd`。
- 其他仓库授权路径加入 `additionalDirectories`。
- 目录都必须是规范化绝对路径，Windows 路径大小写/盘符和符号链接需统一处理。
- 只允许工作区中已启用仓库；不允许传工作区父目录或整个盘符。
- 对每个路径执行真实路径解析、存在性校验、仓库根目录确认和是否越过工作区边界检查。
- 若某仓库没有授权或校验失败，启动前阻断任务并说明缺失仓库；不得将“少了一个仓库”的情况当成完整工作区执行。

### 7.3 多仓库任务工作树

- 使用平台现有 Git Worktree 管理逻辑（若有）为各仓库创建同任务隔离工作树。
- 各仓库 Worktree 与主仓库路径分别绑定。
- 在会话上下文中明确每个仓库的路径、用途、分支、基线 Commit。
- 平台提供自定义工具/接口用于获取工作区 Repo Manifest、查看每仓库 Git Status、运行指定仓库测试。
- 不允许 Runtime 跨越工作区写入路径。
- 同一任务下的多个 Runtime 只能串行获得工作区写锁。

### 7.4 跨仓库开发

推荐：Claude SDK Agent 负责总体计划和工具调度；平台执行服务负责仓库发现、Worktree、测试命令和 Git 操作的边界校验。

不能只依赖提示词说“不要修改其他仓库”。实际工具路径和命令执行都必须经过平台权限校验。

## 8. 平台上下文、知识库与规范注入

### 8.1 RuntimeContextBundle

建议平台统一构造上下文包：

```ts
interface RuntimeContextBundle {
  taskSummary: string;
  jiraIssue?: { key: string; summary: string; description?: string; attachmentRefs?: string[] };
  workspaceManifest: WorkspaceRepository[];
  dependencyMap?: string;
  mes5Knowledge?: string[];
  mes6Knowledge?: string[];
  wmsKnowledge?: string[];
  developmentRules?: string[];
  memorySnippets?: string[];
  acceptanceCriteria?: string[];
}
```

上下文按需检索，不要把全量字典和所有仓库文件一次性注入模型。

### 8.2 项目规则文件

- 默认 `settingSources: []`，避免自动加载用户全局、项目和本地 Claude 配置。
- 平台可读取受控的 `AGENTS.md`、`CLAUDE.md` 或工作区规则文件作为项目说明，但应先标明来源并作为不可信项目内容处理；规则不能覆盖系统级安全策略。
- 如产品提供“启用仓库 Claude 项目配置”选项，必须明确提示该操作可能加载仓库 `.claude/settings.json`、Skills、Commands 和 Subagents；用户信任后才允许启用。
- 若设置来源选择 `project`，须对多仓库所有项目级设置执行审查，避免未审查 Hook、MCP、工具 allow/deny 等进入执行环境。

### 8.3 MCP

- 平台 MCP Server 注册表是唯一授权来源。
- Claude Runtime 创建 SDK 会话时，只传递已启用且经过管理员/用户授权的 MCP 配置。
- MCP 工具调用一样要经过审计和必要的审批。
- 禁止自动导入机器上的全部 Claude CLI MCP 配置。

## 9. 权限和安全架构

### 9.1 Permission Broker

平台统一权限服务输入：
- Runtime 类型。
- Session/Task/Workspace ID。
- 工具名称和原始参数。
- 文件读写路径、命令、网络目标。
- 当前 Permission Profile。

返回：
- `allow`：策略明确允许。
- `deny`：策略明确拒绝。
- `ask`：显示 UI 审批，用户操作后返回批准/拒绝。

Claude SDK 的 `canUseTool`、Hooks（例如 PreToolUse）和 permission rules 均需要映射到平台 Permission Broker。

### 9.2 默认策略

- 读取授权仓库文件：允许，但敏感文件默认拒绝。
- 写入授权 Worktree：按当前模式决定自动允许或审批；默认至少在首次使用/高风险目录变更时审批。
- 写入非授权目录：拒绝。
- `git status`、`git diff`：允许。
- `git checkout -b` / Worktree 创建：由平台 Git 服务执行或审批。
- `git commit`：默认审批。
- `git push`、合并、发布：默认拒绝，需单独高等级审批。
- 安装依赖、执行构建/测试：按命令白名单/风险等级审批。
- 访问网络、上传源码、访问生产数据库：默认拒绝或严格审批。
- 禁止 `bypassPermissions`。

注意：SDK `allowedTools` 只表示自动批准指定工具，不能理解为只允许这些工具。必须综合使用 disallowed tools、权限规则、hooks、canUseTool 和操作系统级隔离。

### 9.3 OS 级隔离

SDK 工具权限不能被视为完整的操作系统沙箱。Codex 必须验证 Claude Runtime 在 Windows 下的真实隔离边界。

最低要求：
- 不使用管理员权限运行 Runtime。
- SDK 子进程以当前普通用户权限运行。
- 工作目录只开放已授权工作树。
- 对命令执行建立进程树追踪、超时和取消机制。
- 对工作区外文件访问进行可验证的拒绝测试。
- 若 Windows 下无法对所有 Shell 子命令执行强制文件系统/网络隔离，应在产品中明确风险，必要时将高风险命令改为平台自定义工具执行。

## 10. Session 与跨 Runtime 状态

### 10.1 平台 Session 与原生 Session 分离

建议新增/扩展字段：

```text
platform_session
- id
- runtime_kind
- runtime_version
- workspace_id
- task_id
- selected_model
- status
- created_at
- updated_at

runtime_session_binding
- id
- platform_session_id
- runtime_kind
- native_session_id
- runtime_metadata_json
- created_at
- last_resumed_at
```

- `native_session_id` 对 Claude SDK 保存 SDK 返回的 Claude Session ID。
- 只有 `runtime_kind=claude_agent_sdk` 的会话才允许调用 Claude SDK `resume`。
- 会话恢复需要原工作区路径和同一工作区身份；仓库根目录已变更时先做兼容性检查。

### 10.2 跨 Runtime 交接

跨 Runtime 不能共享原生上下文，采用平台交接包：
- 用户原始需求和验收标准。
- 当前任务状态与计划摘要。
- 已完成文件修改摘要。
- 各仓库分支、基线 Commit 和当前 Diff 摘要。
- 未完成事项、已发现问题和已执行测试结果。
- 知识库引用的 ID/版本，而不是盲目复制所有知识正文。

切换时新建目标 Runtime Session，并显式向用户说明这是新会话接续任务，不是原会话原样迁移。

## 11. 事件归一化

Claude SDK 异步消息流要映射到平台现有事件协议。建议至少覆盖：

| 平台事件 | Claude SDK 来源/处理 |
|---|---|
| `session.started` | SDK 初始化完成并取得 Session ID |
| `assistant.delta` | 可展示的 Assistant 文本增量 |
| `assistant.completed` | Assistant 最终响应 |
| `tool.started` | 工具开始事件/工具调用块 |
| `tool.progress` | SDK 工具进度消息 |
| `tool.completed` | 工具结果消息 |
| `permission.requested` | canUseTool 回调等待平台审批 |
| `permission.resolved` | 平台批准/拒绝并回复 SDK |
| `task.progress` | Todo/Task/Agent 进度事件（若 SDK 有提供） |
| `session.usage` | 模型用量/费用统计（若可取得） |
| `session.error` | SDK 错误、限流、进程异常 |
| `session.cancelled` | 用户取消/AbortController |
| `session.completed` | 正常结束 |

不向 UI 透传完整隐藏推理内容、系统提示词、密钥和敏感环境变量。工具输出需要按平台规则脱敏。

## 12. 数据库变更建议

先检查现有表结构并增量迁移。建议涉及：

### 12.1 `runtime_provider_config`

| 字段 | 说明 |
|---|---|
| id | 主键 |
| runtime_kind | `claude_agent_sdk` |
| provider_id | anthropic / supported_cloud / compatible_provider |
| display_name | 显示名称 |
| base_url | 兼容服务地址（可空） |
| credential_ref | 凭据库引用，不存密钥 |
| default_model | 默认模型 ID |
| enabled | 启用状态 |
| created_at / updated_at | 时间 |

### 12.2 `runtime_session_binding`

保存平台 Session 与 Claude 原生 Session 的映射，不在通用表内硬编码厂商私有字段。

### 12.3 `runtime_installation`

保存 SDK/Binary 的版本、路径、平台架构、哈希、签名状态和校验时间。

### 12.4 `runtime_event`

保存归一化事件的必要元数据，敏感工具参数要脱敏/摘要化。

### 12.5 数据库原则

- API Key 不进 SQLite。
- 不保存完整的认证环境变量。
- 不把 Claude 原生 Session 文件目录硬编码为用户界面配置；平台记录 Session ID 和 SDK 管理的 Session 路径/元数据。
- 本地数据库迁移必须向后兼容，不破坏已有 Codex/Jinggong 会话。

## 13. Windows 安装与更新

### 13.1 安装包

- Claude Agent SDK 和 Windows x64 原生 Binary 随精工安装包或受控组件包分发。
- 不要求最终用户全局安装 Claude Code。
- 不要求最终用户手动启动 Claude Code 桌面程序或运行 `claude` CLI。
- 不在启动时无提示下载可执行文件。
- 原生 Binary 建议放在应用受控 Runtime 目录，不放在用户可随意修改的工作区中。
- 若 Electron 使用 ASAR，确认原生 Binary 能被 SDK 以真实路径访问；必要时 `asarUnpack` 或安装到独立目录。
- SDK/Binary 版本、哈希、签名信息写入 manifest，版本不匹配则阻止启动并显示修复选项。
- 应用通过 SDK API 按需触发底层进程启动；不能让用户直接操作 Claude Code Binary。

### 13.2 首次启动检测

检查：
1. Windows 版本和 CPU 架构。
2. SDK JS 包是否存在。
3. Claude 原生 Binary 是否存在、可执行、版本匹配。
4. PowerShell/Git Bash Shell 工具是否可用。
5. Runtime Worker 是否能启动。
6. 代理/网络是否可达（只做必要连接检查）。
7. 是否已配置有效凭据。

本地预检只检查凭据引用是否存在和格式是否满足本地规则，不应在应用启动时自动发起计费模型请求。真实连接测试必须由用户主动触发。

### 13.3 更新和回滚

- SDK 与 Binary 作为原子版本单元升级。
- 更新前校验数字签名/哈希。
- 更新失败恢复旧版本。
- 不自动变更用户选定 Runtime。
- SDK 更新后运行 P0 Smoke Test，再开放使用。

### 13.4 用户侧启动体验（新增）

- 用户只需启动精工Agent，不需要启动 Claude Code 桌面程序、终端窗口或常驻服务。
- Claude Runtime 采用按需初始化：首次选择 Claude Runtime/提交 Claude 任务时执行本地预检，任务开始后由 SDK 自动启动底层原生进程。
- 平台设置页应显示 Claude Runtime 组件状态：`未安装/检查中/就绪/运行中/需要修复/需要配置凭据`。
- 正常任务执行过程中，Claude 原生进程由 SDK 内部管理；精工平台只负责 SDK Worker 和任务生命周期。
- 进程启动失败时展示清晰错误码、原因和修复动作，不要求用户打开命令行手工执行 Claude 命令。
- Claude Runtime 关闭或任务结束后，平台应按 SDK 支持的方式释放资源；不得留下无主的 Claude 子进程。

## 14. 可观测性、成本和日志

- 记录 SDK 版本、Binary 版本、模型 ID、提供方 ID、开始/结束时间、任务状态、错误分类和可用 usage 数据。
- 支持按 Runtime 统计任务数量、成功率、平均耗时、Token/费用（若数据可得）。
- 日志中不存 API Key、Authorization Header、完整用户环境变量和敏感文件内容。
- 对 SDK 子进程崩溃记录退出码、运行时版本和脱敏错误摘要。
- 默认本地日志；导出诊断前提示用户并自动脱敏。

## 15. 研发阶段与任务拆分

### Sprint 0：现状盘点与官方 SDK 验证

1. 检查现有 Runtime Manager、Adapter、会话和 Workspace 实现。
2. 检查 Electron/Tauri 和 Node 版本、打包工具、Windows 目标架构。
3. 从官方文档/官方 NPM 包确认最新 SDK 版本及对应 Windows Binary。
4. 建立独立小型 PoC，调用 `query()` 完成只读分析。
5. 测试 Windows x64、Shell、流式事件、取消、Session ID、API Key。
6. 测试 `cwd + additionalDirectories` 访问两个 Git 仓库。
7. 在没有全局 Claude Code/CLI 的干净 Windows 环境验证精工平台自动启动 SDK 和底层 Binary；不允许先手工启动 Claude Code。
8. 验证应用启动时只做本地预检，用户主动测试连接/提交任务后才发生模型 API 调用。
9. 记录原生 Binary 包含/解包/启动方案。
10. 输出 PoC 结论，不满足条件时停止进入主程序集成。

### Sprint 1：Runtime Adapter 和配置

1. 注册 `claude_agent_sdk` Runtime。
2. Runtime 配置页与启用/禁用。
3. 凭据库适配和 API Key 配置。
4. 模型和可选兼容 Base URL 配置。
5. Health Check、连接测试、错误码归一化。

### Sprint 2：会话执行和事件

1. Worker 启动与关闭。
2. `query()` 调用。
3. 流式事件归一化。
4. 停止/取消。
5. 原生 Session ID 持久化与恢复。
6. 工具事件和权限审批 UI。

### Sprint 3：多仓库工作区

1. 主仓库 `cwd` 和附加仓库 `additionalDirectories`。
2. Repo Manifest 注入。
3. 多仓库路径权限验证。
4. 多仓库读写与任务隔离。
5. 分仓库 Diff、Git 状态和测试命令执行。

### Sprint 4：企业能力与安全

1. Jira Context Bundle 注入。
2. MES5/MES6/WMS 知识检索。
3. 企业开发规范注入。
4. MCP 受控注册。
5. Hook/Permission Broker。
6. 敏感信息保护和安全测试。

### Sprint 5：安装包与回归

1. Windows 安装包集成。
2. Runtime Binary 完整性验证。
3. 干净 Windows 环境安装测试。
4. Codex/Jinggong 回归。
5. 安装升级、回滚和错误恢复。
6. 条款、许可证与交付检查。

## 16. PoC 验收清单

在进入正式集成前，至少通过：

- [ ] 在 Windows x64 上通过 TypeScript SDK `query()` 启动 Agent。
- [ ] SDK 原生 Binary 随应用依赖可用，不依赖全局 `claude` 命令。
- [ ] 在没有安装 Claude Code 桌面程序、没有全局 `claude` CLI、PATH 中不存在 `claude` 命令的干净 Windows x64 环境中，精工平台仍能启动 Claude Runtime。
- [ ] 用户只启动精工Agent，不需要手动启动 Claude Code GUI/CLI。
- [ ] 用户提交 Claude 任务后，SDK 自动启动并管理底层 Claude Code 原生执行进程。
- [ ] Runtime 本地预检不自动发起模型调用；主动连接测试才发起真实 API 请求。
- [ ] SDK/Binary 缺失或损坏时显示精工平台内修复入口，不要求用户手工安装 Claude Code。
- [ ] 通过合法 Claude Console API Key 或受支持云凭据认证。
- [ ] 可流式获取文本和工具事件。
- [ ] 可以取消长任务。
- [ ] 可以保存并恢复 Claude 原生 Session。
- [ ] `cwd` + `additionalDirectories` 能覆盖至少两个独立 Git 仓库。
- [ ] 不能读写未授权工作区路径。
- [ ] 工具权限请求能转接平台审批 UI。
- [ ] 关闭/重启应用后平台会话元数据保留。
- [ ] 不读取未经允许的用户级 Claude 配置/MCP。
- [ ] 认证凭据不出现在明文数据库和日志。
- [ ] 安装包内原生 Binary 的版本、哈希和路径校验通过。

## 17. 正式验收场景

### 场景 A：Claude 单仓库分析

1. 选择 Claude Agent SDK Runtime。
2. 选择一个测试仓库。
3. 输入“分析项目结构，不要修改文件”。
4. Agent 完成项目分析，界面显示流式状态和结果。
5. Git 状态无变化。

### 场景 B：Claude 多仓库跨端修改

1. 工作区包含 `web` 和 `api` 两个仓库。
2. 选择 Claude Runtime，输入“给设备列表增加设备状态筛选，前端和后端一起修改”。
3. Agent 能读取两个仓库的实现。
4. Agent 在两个仓库分别修改代码。
5. 平台显示两个仓库的独立 Diff、分仓库测试结果。
6. 任何未授权路径写入都被拒绝。

### 场景 C：审批

1. Agent 请求运行一个未加入白名单的构建/安装命令。
2. 平台显示命令、工作目录、风险和批准/拒绝操作。
3. 用户拒绝后，命令不执行。
4. 用户批准后，只执行这一次或所选择的授权范围。

### 场景 D：会话恢复

1. Claude 会话完成一部分工作后关闭应用。
2. 重新打开并恢复 Claude 原生会话。
3. SDK 继续该会话，平台工作区状态保持一致。
4. 切换到 Codex 后必须创建 Codex 原生会话，并展示交接摘要。

### 场景 E：默认 Runtime 不变

1. 安装/升级精工平台。
2. 检查全局默认仍是 Codex Runtime。
3. 选择 Claude 完成一次任务。
4. 新建另一会话时默认仍按用户全局配置（未改过时为 Codex）。

### 场景 F：无需手动启动 Claude Code（新增）

1. 在一台未安装 Claude Code 桌面程序、未安装全局 Claude CLI 的 Windows x64 测试机上安装精工Agent。
2. 配置合法 Claude Console API Key 或受支持云凭据。
3. 不打开 Claude Code GUI，不执行 `claude` 命令。
4. 启动精工平台，选择 Claude Agent SDK Runtime。
5. 平台自动完成本地 SDK/Binary/Shell/凭据预检。
6. 提交一个只读代码分析任务。
7. 验证 SDK 自动启动底层 Claude 原生进程并返回真实流式结果。
8. 取消任务或关闭平台，验证相关进程按策略退出，无残留无主进程。
9. 检查日志、SQLite 和诊断包中没有明文密钥。

## 18. 风险与处理

| 风险 | 处理 |
|---|---|
| SDK/Binary 版本不一致 | 锁版本、manifest 校验、配套升级 |
| Windows Shell 不可用 | PoC 验证 PowerShell/Git Bash；启动前诊断 |
| 多仓库路径越权 | `cwd`/`additionalDirectories` 白名单、平台路径校验、OS 级隔离测试 |
| SDK 原生 Binary 无法在 ASAR 运行 | `asarUnpack`/外置 Runtime 目录/显式 Binary Path |
| Claude.ai 订阅凭据不合规 | 仅用 Console API Key 或官方支持云凭据；禁止代理订阅额度 |
| 自定义中转协议不兼容 | 仅接入 Anthropic-compatible API，单独 PoC |
| SDK 原生会话不可跨 Runtime 恢复 | 平台统一任务摘要和交接包 |
| SDK 私有工具事件升级变化 | 适配层做版本隔离、契约测试和回归 |
| Windows 进程无法完全沙箱化 | OS 级验证，高风险操作走平台自定义工具/审批 |

## 19. Codex 实施指令

请 Codex 在当前精工Agent代码库中，先阅读本技术方案和配套需求文档，然后按以下要求执行。

### 阶段一：现状盘点

1. 检查现有三个 Runtime 相关实现，确认 Codex Runtime 默认逻辑。
2. 检查 Runtime Adapter 接口、Workspace/Repository 数据模型、会话持久化、Git Worktree、Diff、权限审批和安装打包结构。
3. 以代码证据列出新增 Claude Runtime 的影响文件和调用路径。
4. 检查目前 Windows x64 安装包实际打包方式和 SDK 运行依赖。
5. 验证用户无需安装/启动 Claude Code GUI/CLI，精工平台可通过 SDK 自动启动随包 Binary。
6. 列出需求与现状差距，不得未经审查重构现有主架构。

### 阶段二：先做独立 PoC

1. 固定并安装当前官方 `@anthropic-ai/claude-agent-sdk` 版本。
2. 使用 Windows x64 对应 native optional dependency。
3. 编写只读查询任务验证 `query()`、流式输出、取消、Session ID、API Key。
4. 验证 `cwd + additionalDirectories` 的两个独立仓库读取。
5. 验证 SDK 原生 Claude Binary 随桌面安装包分发。
6. 在没有全局 Claude Code/CLI 的干净 Windows 环境验证精工平台可自动启动 SDK 和底层 Binary；不允许测试人员先手动启动 Claude Code。
7. 验证 Runtime 本地预检不自动调用模型，主动连接测试或提交任务时才发起真实 API 请求。
8. 验证 PowerShell/Git Bash 能力，并区分 Shell 依赖与 Claude Code GUI/CLI 启动要求。
9. 记录 SDK Worker、原生 Binary 的启动、取消、退出及异常回收行为。
10. 输出 PoC 测试报告和阻塞项。

### 阶段三：正式接入

PoC 通过后，按 Sprint 1-5 集成。所有新实现通过现有 Runtime Adapter，不得让 UI 直接调用 SDK。

### 质量要求

- 每个阶段提交可运行代码、测试和变更说明。
- 不使用 Mock 冒充真实 Claude Agent 执行。
- 不要求测试人员预先启动 Claude Code GUI/CLI；自动启动链路必须在干净 Windows 环境中验证。
- 不把“检测到系统已安装 Claude CLI”作为 SDK Runtime 的成功验收条件。
- 不在源码、SQLite 或日志写入任何真实凭据。
- 不引入 Claude.ai 登录/订阅 OAuth 凭据接管。
- 禁止默认 `bypassPermissions`。
- 不允许 Claude Runtime 错误自动切换 Codex Runtime。
- 不破坏 Codex Runtime 默认值和 Jinggong Runtime。
- 不允许多个 Runtime 同时对同一个任务工作树写入。
- 未通过 PoC 不得声称已完成 Claude Runtime。

### 阶段交付汇报

每个阶段汇报：
1. 实际完成的功能。
2. 涉及的代码文件。
3. 编译和测试结果。
4. Windows 真实运行结果。
5. 未完成事项和技术风险。
6. 下一阶段计划。

## 20. 官方资料与实现依据

1. Claude Agent SDK Overview：https://code.claude.com/docs/en/agent-sdk/overview
2. TypeScript SDK Reference：https://code.claude.com/docs/en/agent-sdk/typescript
3. Permissions：https://code.claude.com/docs/en/agent-sdk/permissions
4. Sessions：https://code.claude.com/docs/en/agent-sdk/sessions
5. MCP：https://code.claude.com/docs/en/agent-sdk/mcp
6. Legal and Compliance：https://code.claude.com/docs/en/legal-and-compliance
7. Official TypeScript SDK repository：https://github.com/anthropics/claude-agent-sdk-typescript

### 重要实施事实

- 官方 Agent SDK 使用 Claude Code Agent Loop、工具和上下文管理；它是以库方式运行 Claude Code Agent 的集成方式，但底层会执行 Claude Code Binary。精工平台通过 SDK API 触发该执行，不需要用户单独启动 Claude Code GUI/CLI。
- SDK 会附带对应平台的原生可选依赖。Windows x64 的 Binary 路径示例为 `@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe`。
- TypeScript SDK 支持 `cwd`、`additionalDirectories`、`query()`、`abortController`、`resume`、`settingSources`、`canUseTool`、MCP 等能力；字段与版本要求以锁定版本文档为准。
- 官方文档提醒：Windows 环境可能因 Git Bash 缺失且 PowerShell 工具关闭而出现 `shell_tool_missing`。
- SDK 权限配置中 `allowedTools` 是预批准列表，不是完整 denylist；高风险管控必须组合 permission rules、`disallowedTools`、hooks、`canUseTool` 和平台/OS 隔离。
- 除非 Anthropic 另行批准，第三方产品不得提供 Claude.ai 登录或转接 Free/Pro/Max/Ultra 订阅额度；应使用 Claude Console API Key 或受支持云服务凭据。
- Claude Agent SDK 受 Anthropic Commercial Terms of Service 约束。对外分发前必须完成法律、条款和依赖许可核查。

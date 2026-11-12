# 精工Agent——插件管理与 Jinggong Runtime 兼容 P1 技术方案 V1.0

> 文档类型：技术架构与实施方案  
> 产品：精工Agent（Windows 桌面客户端）  
> 优先级：P1  
> 依赖：P0 Plugin Manager、Plugin Store、Skill Catalog、MCP 配置库  
> 日期：2026-11-09  
> 状态：供 Codex 研发实施

---

## 1. 技术目标

在 P0 Plugin Manager 上增加 Jinggong Runtime 插件执行适配层，使已安装的 Codex 插件包可在 Jinggong Runtime 下复用 Skills、MCP 和受信任 Hooks。

核心技术模块：
- `JinggongSkillLoader`：Skills 发现、元数据注册和渐进加载。
- `JinggongMcpClientManager`：MCP 连接、工具发现、工具调用和生命周期管理。
- `PluginHookParser`：解析 Plugin Hooks。
- `JinggongHookEngine`：把插件 Hook 事件映射到 Jinggong Agent 生命周期。
- `HookTrustService`：插件/Hook Hash 绑定的信任授权。
- `PluginPermissionAdapter`：Hook/MCP/Skill Script 接入平台 Permission Broker。
- `PluginCompatibilityService`：按 Runtime 能力生成兼容性矩阵。

## 2. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│                     Plugin Manager (P0)                      │
│ Plugin Store / Manifest / Skills Catalog / MCP Registry       │
│ Trust / Version / Credential Ref / Session Snapshot           │
└──────────────────────────────┬──────────────────────────────┘
                               │ PluginSessionContext
                 ┌─────────────▼────────────────┐
                 │ Runtime Plugin Orchestrator  │
                 │ Compatibility / Policy       │
                 └────────┬──────────────┬───────┘
                          │              │
                ┌─────────▼───────┐ ┌────▼────────────────┐
                │ Codex Runtime  │ │ Jinggong Runtime    │
                │ Native Plugin  │ │ Skill Loader        │
                │ MCP + Hooks    │ │ MCP Client          │
                │                │ │ Hook Engine         │
                └────────────────┘ │ Permission Adapter  │
                                   └─────────┬────────────┘
                                             │
                                    ┌────────▼─────────┐
                                    │ Permission Broker│
                                    │ Trust / Audit    │
                                    │ Sandboxing       │
                                    └──────────────────┘
```

Codex Runtime 继续走原生插件机制，精工不再额外执行同一套 Hooks；Jinggong Runtime 走自研兼容层。共享的是插件包和权限/凭据元数据，不共享 Runtime 原生 Session 或工具进程状态。

## 3. P0 代码依赖与接口检查

实施前必须检查并复用：
- `PluginManager` / `PluginStore`。
- `PluginManifestParser` / `SkillCatalog`。
- `McpConfigRegistry`。
- `CredentialVault`。
- `PermissionBroker`。
- `RuntimeAdapter` / `JinggongRuntimeAdapter`。
- `WorkspaceRepository` / `SessionManager`。
- `AuditLogger` / `ProcessManager`。

如果 P0 还未交付，先让 P0 设计稳定，不要在 P1 中复制其数据模型。

## 4. 运行时上下文模型

```ts
interface PluginSessionContext {
  sessionId: string;
  runtimeKind: "jinggong";
  workspaceId: string;
  pluginSnapshotId: string;
  plugins: Array<{
    pluginId: string;
    version: string;
    contentHash: string;
    installPath: string;
    trustStatus: "trusted" | "untrusted" | "revoked";
    enabledSkillIds: string[];
    enabledMcpServerIds: string[];
    enabledHookIds: string[];
  }>;
  permissionProfileId: string;
}
```

上下文创建后不可被插件后台升级直接变更；升级需新会话读取新 Snapshot。

## 5. Jinggong Skill Loader

### 5.1 设计目标

Skill 是工作流指导与随附资源，不是任意可执行插件。采用渐进披露，减少上下文消耗。

### 5.2 扫描与验证

从 P0 Skill Catalog 读取，启动会话前只提供：
- name
- description
- skillId
- Skill File Path（内部引用，不向模型暴露未授权绝对路径）
- plugin/version/hash

触发 Skill 时：
1. 验证插件版本 Hash 与 Session Snapshot 匹配。
2. 读取 `SKILL.md`。
3. 解析允许的相对资源链接。
4. 将完整指令和有限引用内容加入 Agent Context。
5. 保留来源信息，供 UI 展示和审计。

### 5.3 资源 Resolver

```ts
interface PluginResourceResolver {
  readSkill(skillId: string, sessionId: string): Promise<SkillContent>;
  readReference(skillId: string, relativePath: string, sessionId: string): Promise<ResourceContent>;
  getAsset(skillId: string, relativePath: string, sessionId: string): Promise<ResourceRef>;
  listResources(skillId: string, sessionId: string): Promise<ResourceDescriptor[]>;
}
```

所有路径：
- 使用 `realpath`/Windows 对应 API 解析最终路径。
- 检查最终路径在 Plugin Root 内。
- 拒绝 UNC、盘符跳转、`..` 越界和不允许的符号链接。
- 设置单文件和总读取大小上限。
- 不允许读取用户凭据库和应用私有敏感文件。

### 5.4 Skill 资源脚本

P1 不自动执行 Skill 的 `scripts/`。

当模型请求运行脚本时，必须：
- 确认脚本来自已信任插件版本；
- 执行前进入 Permission Broker；
- 在授权的 Workspace/Plugin Data 范围执行；
- 对运行命令、参数、环境变量和文件变更审计。

## 6. Jinggong MCP Client Manager

### 6.1 传输支持

首期支持：
- `stdio`：在本机启动 MCP Server 子进程。
- `streamable-http`：连接远端 MCP Server。

传输适配必须使用标准 MCP SDK/实现，不自定义私有协议。实施时核对当前所选 MCP SDK 的协议版本和 Windows 支持情况。

### 6.2 连接架构

```text
Jinggong Session
  └── MCP Client Registry
        ├── Plugin A / Server X
        │      └── MCP Client Session
        └── Plugin B / Server Y
               └── MCP Client Session
```

建议每个 Runtime Session 创建独立 MCP Client session。对 stdio Server 是否跨会话复用进程，先不默认开启；如未来启用，必须有明确用户隔离、引用计数和环境变量隔离方案。

### 6.3 接口

```ts
interface McpClientManager {
  connect(serverId: string, session: PluginSessionContext): Promise<McpConnection>;
  listTools(connectionId: string): Promise<McpToolDescriptor[]>;
  callTool(input: {
    connectionId: string;
    toolName: string;
    arguments: unknown;
    sessionId: string;
  }): Promise<McpToolResult>;
  disconnect(connectionId: string): Promise<void>;
  healthCheck(serverId: string): Promise<McpHealthResult>;
}
```

### 6.4 工具命名空间

统一名称：

```text
plugin__<plugin_slug>__<server_slug>__<tool_slug>
```

生成时：
- 小写化并过滤非法字符。
- 限制长度。
- 冲突时附加稳定短 Hash。
- 保留原始 tool name、title、description 和 JSON Schema。
- Runtime Tool Registry 中禁止覆盖内置工具。

### 6.5 输入输出检查

- 调用前校验 JSON Schema。
- 对字符串、数组、深度和总尺寸设限。
- 高风险工具调用前经过 Permission Broker。
- 结果按统一 `McpToolResult` 输出；对二进制/图像/Resource 输出做明确兼容或降级。
- 工具输出需要防止 Prompt Injection：作为工具返回内容标识为不可信数据。

### 6.6 错误与重连

- `MCP_CONNECT_TIMEOUT`
- `MCP_INITIALIZE_FAILED`
- `MCP_TOOLS_DISCOVERY_FAILED`
- `MCP_TOOL_CALL_FAILED`
- `MCP_SERVER_EXITED`
- `MCP_AUTH_REQUIRED`
- `MCP_SCHEMA_INVALID`

有限重试：首次失败后最多按指数退避重试 2 次；用户取消时不重试。进程意外退出时停止把该 Server 的工具暴露给模型，并向会话发送 `plugin.mcp.disconnected` 事件。

## 7. Hooks 架构

### 7.1 模块划分

```text
src/main/plugin/hooks/
├── hook-parser.ts
├── hook-registry.ts
├── hook-event-adapter.ts
├── hook-matcher.ts
├── hook-trust-service.ts
├── hook-executor.ts
├── hook-output-validator.ts
├── hook-audit.ts
└── hook-policy.ts
```

### 7.2 支持配置来源

按当前插件规范解析：
- 根 `plugin.json` 中 `extensions.com.openai.hooks`；
- `hooks/hooks.json` 默认位置；
- `.codex-plugin/plugin.json` 兼容声明。

如果显式 `extensions.com.openai.hooks` 覆盖默认发现，则按规范处理；不要把两处内容无条件合并。对相对路径解析至 Plugin Root，并确认不越界。

### 7.3 事件映射

```ts
type JinggongPluginEvent =
  | "session.started"
  | "user.prompt.submitting"
  | "tool.beforeExecute"
  | "permission.requested"
  | "tool.afterExecute"
  | "session.turn.stopping"
  | "session.interrupted"
  | "context.compacting"
  | "context.compacted"
  | "subagent.started"
  | "subagent.stopped";
```

Codex Hook Event 映射表由 `HookEventAdapter` 管理。每种事件必须定义：
- 触发时机；
- 是否可阻断；
- 输入 JSON Schema；
- 输出 JSON Schema；
- 超时；
- 错误策略。

未支持的事件不能映射到“最接近”的事件继续运行，必须标记 `UNSUPPORTED_EVENT`。

### 7.4 PreToolUse 执行链路

```text
Agent Tool Call Planned
        │
        ▼
Hook Matcher
        │
        ▼
Hook Trust Gate ── untrusted/revoked ──> Block/Skip by explicit policy
        │ trusted
        ▼
Hook Executor (PreToolUse)
        │
        ├── deny/block ───────────────> Tool not executed
        │
        ├── invalid/timeout ──────────> Hook failure policy
        │
        ▼
Permission Broker
        │
        ├── deny ─────────────────────> Tool not executed
        ├── ask ──────────────────────> UI approval
        └── allow
                │
                ▼
            Runtime Tool
                │
                ▼
          PostToolUse Hook
```

Hook 的 allow 只能说明 Hook 未反对，不能直接替用户授权，也不能覆盖系统/用户 Deny。

### 7.5 Hook 失败策略

配置 `failMode`：
- `fail_closed`：Hook 异常、超时、输出非法时阻止原操作；适用于安全/准入 Hook。
- `fail_open`：Hook 异常时允许主操作继续；仅适用于明确标记为非安全、非阻断型通知 Hook，并须用户明确选择。

默认：`PreToolUse`、安全 Hook 为 `fail_closed`；`PostToolUse`/Stop 观察类 Hook 可按策略 `fail_open`，但必须记录失败。

### 7.6 Hook 输出协议

只接受官方兼容 JSON 的有限字段，并由 Adapter 转为平台内部标准结构：

```ts
interface NormalizedHookDecision {
  outcome: "continue" | "deny" | "modify" | "inform";
  reason?: string;
  additionalContext?: string;
  updatedInput?: unknown;
  systemMessage?: string;
}
```

- `updatedInput` 只允许对已定义的可修改字段生效。
- 不支持的字段丢弃并记录 Schema Error；关键策略事件不得因非法结果自动 Allow。
- 不把 Hook stdout/stderr 原样作为可信 Agent 指令。

## 8. Hook 进程执行安全

### 8.1 命令选择

Windows 下优先读取 Hook 配置提供的 `command_windows`，否则评估 `command` 是否兼容。执行前解析 executable、args 和 cwd；禁止拼接命令字符串到 `cmd.exe /c`。

推荐支持顺序：
1. 可执行文件 + argv。
2. 应用自带 Node Runtime 执行 `.js/.mjs`。
3. PowerShell Script：使用系统 `powershell.exe`/`pwsh.exe` 并校验脚本路径及系统策略；不默认使用 `-ExecutionPolicy Bypass`。
4. `.py` 只在用户已配置受信任 Python Runtime 时启用；没有 Python 不得静默下载/安装。
5. Bash Hook 只有在已配置且可信的 Git Bash 时才启用；否则报告 `HOOK_RUNTIME_MISSING`。

### 8.2 进程隔离

- 普通用户权限。
- 固定 cwd：插件安装目录只读，PLUGIN_DATA 可写；工作区访问仅通过受控路径授权。
- 进程树追踪，可取消，可超时。
- 资源限制：最大运行时间、stdout/stderr 大小、最大子进程数。
- 环境变量使用 allowlist；不继承所有主进程变量。
- 凭据不默认注入 Hook。
- 网络访问默认拒绝或需要单独授权；平台必须明确自身 OS 沙箱能力边界。

### 8.3 环境变量

```text
PLUGIN_ROOT=<immutable plugin version directory>
PLUGIN_DATA=<plugin writable data directory>
JINGGONG_PLUGIN_ID=<plugin id>
JINGGONG_PLUGIN_VERSION=<version>
JINGGONG_RUNTIME_KIND=jinggong
JINGGONG_SESSION_ID=<platform session id>
JINGGONG_WORKSPACE_ID=<workspace id>
```

Codex 原生 Hook 的 `PLUGIN_ROOT`/`PLUGIN_DATA` 环境由 Codex 自身管理；Jinggong 不覆盖 Codex Runtime 的环境。

## 9. Trust Service 与 Hash 绑定

信任记录最少包含：
- Plugin ID。
- Plugin version。
- Plugin content hash。
- Hook config hash。
- 每个脚本文件 hash。
- 已审查事件集合。
- 审批的权限集合。
- 审批时间/用户。
- 信任状态。

任何以下变化必须撤销原 Trust 并重新审核：
- 插件版本变化；
- Hook 命令/参数变化；
- Hook 脚本内容变化；
- 脚本引用资源变化；
- 所需能力范围扩大。

信任范围不允许从“只读/通知”自动升级到“执行命令/写文件/网络访问”。

## 10. Permission Broker 扩展

输入：

```ts
interface PluginPermissionRequest {
  sessionId: string;
  runtimeKind: "jinggong";
  pluginId: string;
  pluginVersion: string;
  pluginContentHash: string;
  source: "mcp_tool" | "hook" | "skill_script";
  action: string;
  target?: string;
  argumentsSummary?: Record<string, unknown>;
  requestedCapabilities: string[];
}
```

决策顺序：
1. System Security Policy。
2. User/Workspace deny rules。
3. Plugin Trust + 已批准 capabilities。
4. Session Permission Profile。
5. 交互审批。

原则：
- deny 不可被 Hook allow 覆盖。
- 用户取消审批等同 Deny。
- 没有 Trust 的 Hook 不运行。
- 允许某个 Hook 执行，不等于允许该 Plugin 所有脚本执行。
- 会话结束时过期一次性授权。

## 11. 数据库增量设计

沿用 P0 表，新增：

### `plugin_hook_definitions`
- `id` TEXT PK
- `plugin_id` TEXT FK
- `hook_event` TEXT
- `matcher` TEXT
- `command` TEXT
- `command_windows` TEXT
- `timeout_ms` INTEGER
- `status_message` TEXT
- `config_hash` TEXT
- `supported` INTEGER
- `unsupported_reason` TEXT

### `plugin_hook_trust`
- `id` TEXT PK
- `plugin_id` TEXT FK
- `plugin_version` TEXT
- `plugin_hash` TEXT
- `hook_config_hash` TEXT
- `script_hashes_json` TEXT
- `approved_events_json` TEXT
- `approved_capabilities_json` TEXT
- `trust_status` TEXT
- `approved_at` TEXT
- `revoked_at` TEXT NULL

### `plugin_hook_runs`
- `id` TEXT PK
- `session_id` TEXT
- `plugin_id` TEXT
- `hook_id` TEXT
- `event_id` TEXT
- `started_at` TEXT
- `finished_at` TEXT
- `exit_code` INTEGER NULL
- `outcome` TEXT
- `error_code` TEXT NULL
- `output_summary_redacted` TEXT

### `runtime_plugin_capabilities`
- `id` TEXT PK
- `runtime_kind` TEXT
- `plugin_id` TEXT
- `plugin_version` TEXT
- `capabilities_json` TEXT
- `unsupported_json` TEXT
- `checked_at` TEXT

### `plugin_mcp_runtime_bindings`
- `id` TEXT PK
- `session_id` TEXT
- `server_id` TEXT
- `runtime_kind` TEXT
- `connection_id` TEXT
- `status` TEXT
- `tools_hash` TEXT
- `last_error` TEXT NULL

### `plugin_permission_profiles`
- `id` TEXT PK
- `plugin_id` TEXT
- `runtime_kind` TEXT
- `scope_json` TEXT
- `revision` INTEGER
- `updated_at` TEXT

索引：`session_id`、`plugin_id`、`event_id`、`trust_status`。对运行日志设置保留天数和总容量限制。

## 12. 内部事件与接口

### 12.1 Runtime Plugin Event Bus

```ts
interface PluginRuntimeEvent {
  eventId: string;
  eventName: JinggongPluginEvent;
  sessionId: string;
  workspaceId: string;
  timestamp: string;
  runtimeKind: "jinggong";
  payload: Record<string, unknown>;
}
```

### 12.2 Service API

```ts
interface JinggongPluginRuntimeApi {
  buildSessionPluginContext(sessionId: string): Promise<PluginSessionContext>;
  loadSkill(skillId: string, sessionId: string): Promise<SkillContent>;
  connectMcpServers(sessionId: string): Promise<McpConnectionSummary[]>;
  getMcpTools(sessionId: string): Promise<JinggongToolDefinition[]>;
  dispatchPluginEvent(event: PluginRuntimeEvent): Promise<PluginEventResult>;
  approveHookTrust(input: HookTrustApproval): Promise<void>;
  revokeHookTrust(pluginId: string, version: string): Promise<void>;
  getCompatibility(pluginId: string, runtimeKind: RuntimeKind): Promise<PluginCompatibility>;
}
```

## 13. 错误码

- `PLUGIN_RUNTIME_UNSUPPORTED`
- `PLUGIN_SKILL_LOAD_FAILED`
- `PLUGIN_RESOURCE_PATH_DENIED`
- `MCP_CONNECT_TIMEOUT`
- `MCP_INITIALIZE_FAILED`
- `MCP_TOOLS_DISCOVERY_FAILED`
- `MCP_TOOL_CALL_FAILED`
- `MCP_SERVER_EXITED`
- `MCP_AUTH_REQUIRED`
- `HOOK_CONFIG_INVALID`
- `HOOK_EVENT_UNSUPPORTED`
- `HOOK_NOT_TRUSTED`
- `HOOK_HASH_CHANGED`
- `HOOK_RUNTIME_MISSING`
- `HOOK_EXEC_TIMEOUT`
- `HOOK_EXEC_FAILED`
- `HOOK_OUTPUT_INVALID`
- `PLUGIN_PERMISSION_DENIED`

## 14. 测试方案

### 14.1 Skill
- Skill Metadata 读取。
- 按需加载完整 SKILL.md。
- references 访问、路径越界拒绝。
- Skill Hash 改变后会话使用新 Snapshot；旧会话保持旧版本或提示版本不可用。

### 14.2 MCP
- stdio 启动、initialize、tools/list、tools/call、关闭。
- Streamable HTTP 连接、认证、超时和错误恢复。
- 工具命名冲突与 namespace。
- MCP 工具调用被 Permission Broker 拒绝时不发送给 Server。
- Server 崩溃时工具下架、会话提示。

### 14.3 Hooks
- 未信任插件不执行。
- Trust 后执行指定 Hook。
- Hash 改变自动撤销 Trust。
- PreToolUse deny 阻止工具实际执行。
- Permission Broker deny 不可被 Hook allow 覆盖。
- Hook timeout、invalid JSON、非零退出码行为符合 failMode。
- PostToolUse 只在工具实际执行后触发。
- 工作区外文件写入、环境变量泄露、网络访问均有拒绝测试。
- Windows `command_windows`、PowerShell、Node、Git Bash 缺失场景测试。

### 14.4 回归
- Codex Runtime 原生插件仅执行一次，不被 Jinggong Hook Engine 二次执行。
- Jinggong Runtime 不影响 Codex 默认 Runtime。
- Claude Runtime 不因 P1 插件结构变化被误加载。
- 多仓库工作区、Diff、Git Worktree、会话恢复、企业微信通知通过。

## 15. 性能与可靠性目标

- Plugin Catalog 元数据查询 P95 < 300ms（本地数据库，不含磁盘首次扫描）。
- Skill Metadata 首次扫描按需后台完成，不阻塞应用启动。
- Skill 正文按需加载，避免启动时读入所有资源。
- MCP 连接测试有超时；默认连接超时建议 10 秒，可配置。
- Hook 执行默认超时 10 秒；用户可按 Hook 类别配置，上限受安全策略约束。
- Hook 输出默认最大 1MB，MCP Tool 输出按平台统一上限控制；超限截断并记录。
- Hook 不应阻塞 UI 主线程。
- MCP/Hook 失败必须可观测，不允许让主应用崩溃。

以上为产品目标值，实施时根据真实 Windows 测试校准。

## 16. P1 实施计划

Sprint 0：现状与扩展点验证。
- 检查 Jinggong Agent Loop、Tool Registry、事件总线、Permission Broker 和沙箱。
- 检查 P0 Plugin Store 数据模型和真实样例插件。
- 对比 Codex Hook Schema 与 Jinggong 内部事件语义。

Sprint 1：Skill Loader。
- Skill metadata injection。
- Lazy load。
- Resource Resolver。
- Path/security tests。

Sprint 2：MCP Client。
- STDIO client。
- Streamable HTTP client。
- Tool discovery and mapping。
- Credential/Permission integration。

Sprint 3：Hooks parser + trust。
- Parse supported events。
- Review UI。
- Hash-based trust。
- Compatibility matrix。

Sprint 4：Hook execution.
- Event Adapter。
- Hook Executor。
- Pre/Post Tool pipeline。
- Fail mode and audit。

Sprint 5：Security/release。
- Security tests。
- Runtime regression。
- Windows package tests。
- Feature flag rollout。

## 17. 上线策略

- Feature Flag：`plugin.jinggong.skills`、`plugin.jinggong.mcp`、`plugin.jinggong.hooks` 分别控制。
- 初始默认开启 Skills；MCP 和 Hooks 由用户逐项启用。
- Hooks 功能初次发布默认关闭，完成测试后允许用户显式启用。
- 不为已有插件自动授予 Hook Trust。
- 每个版本可单独回滚，不回滚 P0 Plugin Store 的原始插件文件。

## 18. Codex 研发实施指令

请在当前项目实现 P1：

1. 先读取 P1 需求方案、P0 需求/技术方案和当前代码。
2. 输出代码现状盘点和改造文件清单。
3. 先确认 Jinggong Runtime 是有可插入的 Tool Registry/事件总线/权限审批点；如果没有，先设计最小适配接口，不要重写 Agent Loop。
4. 第一阶段仅实现 Skills Loader，并用 MES/WMS 测试 Skill 验收。
5. 第二阶段实现 MCP Client，使用一个真实本地 stdio 测试 Server 和一个真实 Streamable HTTP 测试 Server。
6. 第三阶段实现 Hooks Parser/Trust UI；暂不开启命令执行。
7. 第四阶段实现 Hook Executor、Permission Broker 和审计；先支持 SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop 这组核心事件。
8. 所有执行必须受 Windows 权限、进程超时和路径检查约束。
9. P1 不能破坏 Codex Runtime 原生插件和 Hooks；Codex Hook 只由 Codex 运行，Jinggong Hook 只由 Jinggong 运行。
10. 每个阶段提交测试和安全证据，不允许仅凭 UI 显示成功。

## 19. 官方资料

- Plugin architecture：https://developers.openai.com/plugins/concepts/plugins
- Package your plugin：https://developers.openai.com/plugins/build/plugins
- Hooks：https://learn.chatgpt.com/docs/hooks
- Skills：https://developers.openai.com/plugins/concepts/skills
- MCP：https://learn.chatgpt.com/docs/extend/mcp
- Plugin guidelines/security：https://developers.openai.com/plugins/plugin-guidelines

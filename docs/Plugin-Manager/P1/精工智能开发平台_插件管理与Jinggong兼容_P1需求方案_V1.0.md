# 精工Agent——插件管理与 Jinggong Runtime 兼容 P1 需求方案 V1.0

> 文档类型：产品需求方案（PRD）  
> 产品：精工Agent（Windows 桌面客户端）  
> 优先级：P1（建立在 P0 Plugin Manager/Plugin Catalog 之上）  
> 适用 Runtime：Jinggong Runtime；同时完善 Codex Runtime Hooks 状态展示  
> 日期：2026-11-09  
> 状态：供 Codex 研发实施

---

## 1. 背景与目标

P0 已建立统一 Plugin Manager，能够导入 Codex 插件、管理 Skills、解析 MCP，并通过 Codex 官方插件机制供 Codex Runtime 使用。

P1 的目标是让 Jinggong Runtime 也能复用同一批插件资源，实现：

1. Jinggong Runtime 读取和使用 Codex 插件中的 Skills。
2. Jinggong Runtime 连接插件声明的 MCP Server，并将 MCP Tools 注册为 Agent 工具。
3. Jinggong Runtime 实现 Codex Hooks 的受控兼容层，让已审查的插件生命周期脚本在 Jinggong 会话中运行。
4. 在插件详情和会话中显示 Codex/Jinggong 兼容能力矩阵。
5. 通过平台统一权限、审批和审计控制插件行为。

P1 不意味着任意 Codex 插件自动完全兼容 Jinggong。每种能力、事件和扩展都必须经过适配和声明。

## 2. 产品目标与非目标

### 2.1 目标

- 同一个插件包在 Codex Runtime 与 Jinggong Runtime 下共享插件源文件、Skills、MCP 配置和元数据。
- Runtime 不支持的能力必须显示为“不支持/部分支持”，不静默忽略。
- Jinggong 具备原生 Skill Loader、MCP Client、Hook Executor 和统一 Permission Broker 接入。
- Hook/脚本默认不信任，经过查看、授权后才能执行。
- 插件升级后若内容 Hash 改变，重新触发信任审核。

### 2.2 非目标

- 不保证兼容 Codex 专属 UI 扩展、ChatGPT Apps UI 或其他专有交互。
- 不保证 Codex 所有未来 Hook 事件都能即时支持；采用显式能力矩阵。
- 不让插件 Hooks 绕过 Runtime/OS 沙箱或 Permission Broker。
- 不在 P1 实现插件云市场、企业远程分发中心。
- 不改变 Codex Runtime 为默认 Runtime 的产品设置。

## 3. 角色与典型场景

### 场景 A：同一 Skill 切换 Runtime

用户安装“MES 数据库开发 Skill”，在 Codex Runtime 完成一次任务；新会话切换 Jinggong Runtime 后，继续选择相同 Skill。平台从同一个 Plugin Store 读取 Skill，并通过 Jinggong Skill Loader 加载，不要求重复安装。

### 场景 B：同一个 MCP Server 跨 Runtime 使用

用户安装一个 Git/MES MCP 插件。Codex Runtime 由 Codex 原生 MCP 连接；Jinggong Runtime 由 Jinggong MCP Client 连接。两侧使用同一 Server 配置来源与凭据引用，但连接进程、工具状态和授权会话按 Runtime 隔离。

### 场景 C：Hook 保护代码修改

插件声明 `PreToolUse` Hook，在 Agent 执行写文件或 Shell 工具前检查命令和路径。Jinggong Runtime 发生工具调用时，平台先调用 Hook，再经过 Permission Broker；Hook 拒绝或平台权限拒绝时，工具不得执行。

### 场景 D：Hook 自动整理会话结果

插件配置 `Stop` Hook，在会话停止时生成摘要或记录任务状态。Hook 只能访问平台授予的 Session/Workspace 数据，不能直接读取全盘或访问未授权密钥。

## 4. P1 功能范围

| 编号 | 功能 | 优先级 | 说明 |
|---|---|---|---|
| P1-01 | Jinggong Skill Loader | P1 | 发现、选择、渐进加载 Skills |
| P1-02 | Skills 统一目录 | P1 | Codex/Jinggong 共用同一 Plugin Store |
| P1-03 | Jinggong MCP Client | P1 | stdio 与 streamable HTTP |
| P1-04 | MCP Tool Registry | P1 | 工具发现、命名空间、工具调用与返回归一化 |
| P1-05 | MCP 凭据共享 | P1 | 共用 Credential Vault 引用，不共享运行进程环境 |
| P1-06 | Hooks 解析器 | P1 | 读取插件 Hooks 配置和事件定义 |
| P1-07 | Hooks 信任审核 | P1 | 查看脚本、Hash、命令、触发点后授权 |
| P1-08 | Jinggong Hook Executor | P1 | 受控运行 Hook 脚本 |
| P1-09 | Hook Event Adapter | P1 | Codex 事件到 Jinggong 生命周期事件映射 |
| P1-10 | Permission Broker | P1 | Hooks、MCP、Skills 脚本共用权限判断 |
| P1-11 | 兼容性矩阵 | P1 | 插件/技能/MCP/Hooks 按 Runtime 显示状态 |
| P1-12 | Hook 执行日志 | P1 | 参数摘要、耗时、结果、错误和阻断原因 |
| P1-13 | 插件版本信任 | P1 | Hash 变化后重新审核 |
| P1-14 | 多 Runtime 回归 | P1 | 确保 Codex 和 Jinggong 的行为边界一致 |

## 5. 兼容性原则

### 5.1 插件兼容等级

| 等级 | 含义 | 会话行为 |
|---|---|---|
| Full | Skills、MCP、Hooks 的所需能力均支持 | 可正常启用 |
| Partial | 有能力不支持或需要额外配置 | 显示缺失项，用户确认后使用可用能力 |
| MetadataOnly | 只能读取元数据，不能运行某些扩展 | 只展示，不暴露不可用工具 |
| Unsupported | Manifest 无法识别或安全校验不通过 | 禁止启用 |

### 5.2 能力不等同原则

- Skills：跨 Runtime 共享文件和内容，但由各 Runtime 自己决定何时加载；精工统一控制路径与来源。
- MCP：共享 Server 配置和凭据引用，但每个 Runtime 单独建立连接和工具会话。
- Hooks：共享原始 Hook 定义和脚本，但需经 Jinggong Hook Adapter 解释和执行；不直接调用 Codex Hook Runtime。
- 插件 UI：Codex/OpenAI 专属 UI 在 Jinggong 中不执行，显示“不支持该扩展”。

## 6. Skills 在 Jinggong 中的行为

- 读取 P0 已导入 Skill Catalog。
- 会话开始时只提供已启用 Skills 的 name、description 和简短定位。
- 触发某 Skill 后加载完整 `SKILL.md`。
- 当 Skill 引用 `references/`、`scripts/`、`assets/` 时，通过 Plugin Resource Resolver 按相对路径读取。
- 对资源路径做真实路径检查，禁止跳出插件目录。
- Skill 内容视为不可信指令；不能覆盖系统提示、安全规则和用户权限。
- Skill scripts 只有在用户信任插件、脚本 Hash 符合已授权版本且通过执行审批后才能运行。
- Skill 元数据和全文加载都记录来源 Plugin ID/Version/Hash。

## 7. MCP 在 Jinggong 中的行为

### 7.1 支持传输

- P1 首期支持 MCP `stdio`。
- P1 首期支持 `streamable-http`。
- 其他传输或厂商私有认证先显示不支持。

### 7.2 工具注册

- 启动会话前读取本会话所选插件的 MCP Server 配置。
- 连接 Server 并执行 MCP initialize、工具列表发现。
- 生成工具名命名空间：`plugin__<pluginName>__<serverName>__<toolName>`，避免跨插件冲突。
- 工具 schema 原样校验后映射到 Jinggong Runtime 工具系统。
- 工具调用输入/输出按平台事件模型归一化。
- Server 不可用时不向模型暴露虚假工具；会话中断时显示对应 MCP 错误。

### 7.3 连接生命周期

- 按 Runtime Session 创建独立 MCP Client session；可复用同一 Server 进程的前提是隔离与协议实现安全且不串用户上下文。
- 用户停止会话时释放客户端连接；对于平台托管的 stdio 进程按引用计数决定是否停止。
- MCP Server 崩溃可按策略重启，限制重试次数，避免无限重启。
- 每个 Server 单独配置 timeout、最大并发、最大输出大小。

### 7.4 认证

- 共用 P0 Credential Vault 中的凭据引用。
- Runtime Worker 通过最小化环境变量或 HTTP Header 注入凭据。
- 不把凭据传入 Prompt、Skill、工具参数、命令行参数或日志。
- OAuth 流程由平台统一授权管理；如果当前 MCP Server 的 OAuth 需要 Runtime 原生交互，必须通过显式接口适配，不能退回明文 Token 配置。

## 8. Hooks 生命周期兼容

### 8.1 首期支持事件

按 Codex Hooks 官方事件模型选择与 Jinggong 生命周期最接近的事件：

| Codex Hook Event | Jinggong Event | P1 支持策略 |
|---|---|---|
| `SessionStart` | `session.started` | 支持 |
| `UserPromptSubmit` | `user.prompt.submitting` | 支持 |
| `PreToolUse` | `tool.beforeExecute` | 支持，可阻止工具 |
| `PermissionRequest` | `permission.requested` | 支持，可补充审批上下文，不可绕过平台策略 |
| `PostToolUse` | `tool.afterExecute` | 支持 |
| `Stop` | `session.turn.stopping` | 支持 |
| `Interrupt` | `session.interrupted` | 先 PoC；确认事件数据后支持 |
| `PreCompact` / `PostCompact` | `context.compacting` / `context.compacted` | 若 Jinggong 有上下文压缩能力则支持 |
| `SubagentStart` / `SubagentStop` | `subagent.started` / `subagent.stopped` | 仅 Jinggong 实际启用子 Agent 时支持 |

禁止把不等价事件强行映射。每个 Hook 需显示其事件是否在当前 Runtime 支持。

### 8.2 配置来源

P1 兼容读取：
- 根 `plugin.json` 的 `extensions.com.openai.hooks`。
- `hooks/hooks.json` 默认发现路径。
- Codex 兼容 Manifest 中的 hooks 字段。

多配置文件行为按当前插件规范处理；如果显式 Manifest 配置覆盖默认文件发现，则按照规范执行，不擅自合并。

### 8.3 Hook 命令格式

支持：
- `type: command`。
- `command`、`command_windows`、`args`（若定义格式支持）。
- `timeout`。
- `statusMessage`。
- Hook matchers。
- 脚本 JSON 输入/输出。

未支持的 Hook 类型（例如 MCP Tool Hook 或未来新类型）显示为不支持，不允许将其当作普通命令猜测执行。

### 8.4 Hook 执行顺序

对工具调用执行：

1. Runtime 生成准备执行的工具调用事件。
2. Hook Engine 查找匹配的 `PreToolUse` Hook。
3. Hook 脚本运行前先经过 Trust Gate 和安全策略。
4. Hook 返回允许/拒绝/修改支持字段的结果。
5. Permission Broker 最终做权限决策。
6. 仅当 Hook 未阻断且 Permission Broker 决定 Allow 时，才执行原始工具。
7. 工具完成后执行 `PostToolUse`。
8. 记录 Hook 与工具事件关联 ID。

重要：Hook 不能把 Permission Broker 的 `deny` 改成 `allow`，也不能绕开用户审批。

## 9. Hook 安全与信任要求

- 所有导入插件的 Hook 默认为未信任。
- 用户信任前，显示 Hook 事件、匹配条件、命令、脚本内容、执行路径、所需环境变量、网络/文件访问范围。
- 信任记录绑定插件版本与脚本内容 Hash；Hash 改变后撤销信任并要求重新审核。
- 执行目录固定在插件安装目录或插件隔离工作目录；工作数据写入独立 `PLUGIN_DATA`。
- 定义标准环境变量：`PLUGIN_ROOT`、`PLUGIN_DATA`、`JINGGONG_PLUGIN_ID`、`JINGGONG_RUNTIME_KIND`、`JINGGONG_SESSION_ID`、`JINGGONG_WORKSPACE_ID`。
- 支持 `command_windows` 优先用于 Windows；命令通过 CreateProcess/安全参数数组调用，禁止字符串拼接到 Shell。
- Runtime 使用普通用户权限，不使用管理员权限。
- Hook 超时、输出大小、进程数量、CPU/内存限制需要配置。
- Hook stdout 只接受符合约定的 JSON/文本字段；超限/非法格式进入 HookFailed。
- Hook stderr 做敏感字段脱敏，写入本地审计。
- 默认禁止 Hook 直接访问未授权网络、用户凭据库、生产数据库和工作区外路径。

## 10. 权限模型

### 10.1 Plugin Permission Profile

每个插件可声明/申请能力：
- `read_workspace`
- `write_workspace`
- `execute_command`
- `start_mcp_server`
- `network_access`
- `read_project_memory`
- `write_project_memory`
- `access_secrets`（原则上不向插件脚本暴露明文；仅允许受控引用）

插件声明的能力是申请，不是授权。用户审核后形成实际授权集合。

### 10.2 工具权限

MCP Tool、Hook 和 Skill Script 都要接入统一 Permission Broker：
- `allow`：策略明确允许。
- `deny`：策略明确禁止。
- `ask`：用户审批。

系统安全策略优先级最高：System Policy > User Deny > Plugin Trust/Permission > Session Approval > Runtime Defaults。任何插件 Hook 不得提升自身权限。

## 11. UI 需求

### 11.1 插件兼容性矩阵

每个插件显示：

| 能力 | Codex Runtime | Jinggong Runtime |
|---|---|---|
| Skills | 原生支持状态 | 兼容状态 |
| MCP | 原生连接状态 | Jinggong Client 状态 |
| Hooks | Codex 原生状态 | Jinggong Hook Adapter 状态 |
| UI Extensions | 依插件能力 | 不支持/未来适配 |

### 11.2 Hook 审核页

展示：
- Hook 名称、事件、matcher。
- Windows 实际执行命令。
- Hook 脚本内容与 Hash。
- 所需权限与环境变量。
- 超时和资源限制。
- 信任/拒绝按钮。

### 11.3 会话插件面板

用户选择 Jinggong Runtime 时：
- 展示可兼容插件。
- 默认不勾选需要新信任的插件。
- 仅展示当前 Runtime 支持的 Skills/MCP/Hooks。
- 有不兼容能力时列出原因。
- 会话启动时冻结插件版本与授权快照。

## 12. 数据需求

在 P0 数据模型上增量新增：

- `plugin_hook_definitions`：Plugin ID、Hook event、matcher、command、platform command、timeout、config hash。
- `plugin_hook_trust`：Plugin ID、version、script hash、trust status、approved capabilities、approved by、timestamp。
- `plugin_hook_runs`：Session ID、Hook ID、event ID、start/end、exit code、result、blocked reason、redacted output。
- `runtime_plugin_capabilities`：Runtime kind、Plugin ID、supported capabilities、unsupported reasons、detected version。
- `plugin_mcp_runtime_bindings`：Runtime Session、Server ID、connection ID、tool list hash、health status。
- `plugin_permission_profiles`：Plugin ID、permission set、scope、revision。

不得将凭据明文落库；所有 JSON 日志脱敏。

## 13. 验收标准

1. 同一插件的 Skill 在 Codex Runtime 和 Jinggong Runtime 均可发现，全文按需加载。
2. Skill 内引用资源只能访问插件根目录内路径。
3. 同一个 MCP 插件在两个 Runtime 中都能连接同一测试 Server，但会话连接彼此隔离。
4. MCP Tool 在 Jinggong 工具列表中可见，调用输入/输出正确映射。
5. Hook 配置可解析，支持事件显示和兼容性矩阵。
6. 未信任 Hook 不会执行。
7. 用户批准特定版本后，匹配 Hook 可以执行；插件升级/Hash 改变后重新要求信任。
8. `PreToolUse` Hook 返回拒绝时，工具实际执行次数为 0。
9. Hook 允许不能绕过 Permission Broker 的拒绝。
10. Hook 超时/异常不会造成 Runtime 假成功；按配置失败策略处理并显示错误。
11. Hook 不能访问未授权仓库、用户凭据或工作区外目录。
12. `PostToolUse` 只在工具真实执行后触发，且包含对应 event ID。
13. Codex Runtime 仍使用自身原生 Hook 执行，不重复运行同一插件 Hook，避免双重触发。
14. 对 Codex 专属 UI 或未支持事件显示 Partial/Unsupported，不默默忽略。
15. 三 Runtime 和已有 Workspace、会话、通知功能回归通过。

## 14. P1 开发阶段

- Sprint 0：盘点 P0 交付，验证当前 Jinggong Runtime 的 Skill/MCP/Hook 插件扩展点。
- Sprint 1：Skill Loader 与资源 Resolver。
- Sprint 2：Jinggong MCP Client 与 Tool Registry。
- Sprint 3：Hook Parser、Trust UI 和 Hook Event Adapter。
- Sprint 4：Hook Executor、Permission Broker 集成、脚本安全。
- Sprint 5：兼容性矩阵、审计、回归和 Windows 发布。

## 15. 给 Codex 的实施指令

1. 先完整阅读配套 P1 技术方案和 P0 插件管理代码。
2. 以 P0 Plugin Store/Catalog/数据库为唯一插件源，不另建第二份插件安装目录。
3. 检查 Jinggong Runtime Agent Loop、Tool Registry、Session Event、Permission Broker、沙箱和会话恢复能力。
4. 先完成 Skill Loader 和 MCP Client 的独立集成测试，再实现 Hooks。
5. Hook 执行必须最后开发；在 Trust Gate、Permission Broker、进程隔离未通过安全测试前，不允许启用执行开关。
6. 不要把 Codex Hook 逻辑简单复制为 shell runner；必须映射事件语义和输入/输出协议。
7. 不支持的事件/能力必须明确报告，不可伪装成功。
8. 每个 Sprint 提交实际代码、测试结果、Windows 真实运行日志和安全测试报告。

## 16. 官方资料

- Plugin architecture：https://developers.openai.com/plugins/concepts/plugins
- Plugin package/hooks：https://developers.openai.com/plugins/build/plugins
- Codex Hooks：https://learn.chatgpt.com/docs/hooks
- Skills：https://developers.openai.com/plugins/concepts/skills
- MCP：https://learn.chatgpt.com/docs/extend/mcp
- Plugin security guidelines：https://developers.openai.com/plugins/plugin-guidelines

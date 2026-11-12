# 精工Agent：双 Runtime 技术改造方案 V1.0

> **用途：** 提供给 Codex，基于现有 Windows 桌面项目实施技术升级。  
> **产品名称：** 精工Agent  
> **方案路线：** 方案 B——基于 OpenAI Codex 开源 Harness Fork/改造，构建自有 Jinggong Runtime。  
> **关键产品决策：** 平台同时支持 **Jinggong Runtime** 和 **Codex Runtime** 两种执行引擎；**默认使用 Jinggong Runtime**，用户可以在设置中主动切换。  
> **文档版本：** V1.0  
> **编制日期：** 2026-11-07

---

## 1. 项目背景与改造目标

当前精工Agent的代码开发能力主要通过调用 Codex CLI 实现。这种方式可以较快形成产品，但平台核心执行能力仍依赖外部 Codex 命令及其安装、升级和运行环境，平台对 Agent 执行过程、能力边界、版本和企业研发流程的掌控有限。

本次改造不推翻现有 Windows 桌面客户端，不重写已经可用的 Jira、模型配置、知识库、记忆和界面功能，而是将 Agent 执行层抽象出来，建立统一 Runtime 接口，并增加基于 Codex 开源 Harness 改造的 Jinggong Runtime。

### 1.1 总体目标

1. 建立平台自己的 Agent Runtime 产品组件：`jinggong-runtime.exe`。
2. 不再要求最终用户单独安装 Codex CLI 才能使用默认的 Jinggong Runtime。
3. 同时保留 Codex Runtime，作为用户可选的兼容执行引擎。
4. 设置中的默认 Runtime 为 Jinggong Runtime。
5. 两种 Runtime 使用同一套精工Agent界面、任务入口、模型配置入口、知识库、记忆、审批和审计能力。
6. 保持 Windows 桌面软件形态：安装即用，不要求用户部署服务端、数据库服务器或浏览器 localhost 服务。
7. 通过渐进迁移替换现有 Codex CLI 耦合，不破坏现有可用功能。

### 1.2 明确不属于本次目标的事项

- 不训练或自建 GPT、Claude 等基础大模型。
- 不在第一阶段从零实现一个完整代码 Agent。
- 不推倒重写现有桌面 UI、Jira、Git、知识库和模型配置模块。
- 不要求首版支持多人集中式服务器部署。
- 不在未经验证的情况下承诺与官方 Codex 所有功能完全一致。

### 1.3 产品定义

精工Agent是独立的 Windows AI 编程桌面产品。平台通过统一 Runtime 接口管理不同 Agent 执行引擎，其中 Jinggong Runtime 为默认引擎，Codex Runtime 为可选兼容引擎。平台自研的差异化能力包括 MES5/MES6/WMS 企业知识、Jira 任务驱动开发、企业开发规范、测试用例、项目记忆、模型中转站管理和研发流程治理。

---

## 2. Runtime 双引擎产品要求

### 2.1 用户可选的两种 Runtime

| Runtime | 产品定位 | 默认状态 | 运行方式 | 主要用途 |
|---|---|---:|---|---|
| Jinggong Runtime | 精工自有/改造版 Agent 执行引擎 | **默认** | 平台随安装包分发 `jinggong-runtime.exe`，由桌面主进程启动并通过本机 IPC/stdio 通信 | 日常开发、企业知识增强、长期主线 |
| Codex Runtime | 官方 Codex 运行时兼容模式 | 可选 | 调用本机已安装且版本受支持的 Codex Runtime/App Server；现有 CLI 能力只作为迁移兼容，不作为新架构主接口 | 对比效果、兼容旧会话、故障排查或用户主动选择 |

**重要术语说明：**

- **Jinggong Runtime 不是简单把 `codex.exe` 改名。** 它应从 OpenAI Codex 开源仓库的 Harness/App Server 相关源码构建独立发行物，固定上游基线、应用精工补丁、独立版本编号，并由精工Agent随包安装、启动和管理。
- 第一阶段可以继续复用 Codex Harness 内部成熟的 Agent Loop、工具执行、上下文管理、审批和沙箱实现。该阶段属于“基于开源 Harness 的精工改造版”，不应宣传为从零自研的完整 Agent 引擎。
- **Codex Runtime** 是用户选择使用的官方兼容运行模式。优先通过官方 App Server 协议集成；如果现有项目目前只有 CLI 调用，则先通过适配器保留旧能力，再逐步迁移至 App Server。不得把 `codex exec` 命令拼接作为新 Runtime 架构的核心接口。

### 2.2 默认值与切换规则

1. 新安装默认选择 `jinggong`。
2. 设置页面的 Runtime 下拉选择默认展示 Jinggong Runtime。
3. 用户切换到 Codex Runtime 后，保存选择；下次启动继续使用该选择。
4. 用户切回 Jinggong Runtime 后，同样持久化选择。
5. Runtime 不可用时必须显示明确状态和原因，不得静默切换到另一 Runtime。
6. 用户可以通过设置页主动执行“检查 Runtime”“重新检测”“切换 Runtime”。
7. 新安装的默认设置必须为 Jinggong Runtime，即使 Jinggong Runtime 启动失败，也不能后台无提示地使用 Codex Runtime。
8. 现有版本升级：执行配置迁移，将 Runtime 默认值设为 `jinggong`；保留原 Codex CLI 路径、历史会话映射和用户原有模型配置。若 Jinggong Runtime 尚未随安装包完成部署，应显示“Jinggong Runtime 尚未就绪”，允许用户主动选择 Codex Runtime 暂时工作。
9. Runtime 选择首期按全局设置生效；可预留项目级和会话级覆盖字段，但未经产品确认不要增加复杂的三层优先级。
10. 运行中的会话不允许直接热切换底层 Runtime。用户切换 Runtime 时，应提示“新建会话后生效”；如需要切换当前任务，创建新会话并将用户可见上下文摘要带入，不得假装底层执行状态已无损迁移。

### 2.3 Runtime 设置页面

页面建议：设置 → Agent 执行引擎。

必须显示：

- 当前 Runtime：Jinggong Runtime / Codex Runtime。
- 默认 Runtime：Jinggong Runtime。
- 运行状态：正常、未安装、版本不兼容、启动失败、检测中。
- 版本号、构建号、上游 Codex commit（仅 Jinggong Runtime 展示）。
- Runtime 能力清单：流式响应、任务中断、工具调用、审批、文件修改、终端执行、恢复会话、Windows 沙箱等。
- “检查 Runtime”按钮。
- “切换到 Jinggong Runtime”按钮。
- “切换到 Codex Runtime”按钮。
- 错误日志导出入口（脱敏后导出）。

页面提示文案：

> Jinggong Runtime 是精工Agent默认执行引擎；Codex Runtime 是可选兼容引擎。切换 Runtime 仅影响新建会话，当前运行中的任务不会自动迁移。

---

## 3. 技术路线与上游基线

### 3.1 采用方案 B

Fork/OpenAI Codex 开源仓库并基于 Rust 代码体系进行改造。先定位上游 Harness、App Server、模型 provider、工具系统、会话、审批和沙箱模块，选取适合产品集成的模块，构建 `jinggong-runtime.exe`。

上游仓库：

- GitHub：<https://github.com/openai/codex>
- Codex App Server 文档：<https://learn.chatgpt.com/docs/app-server>
- Codex as a platform：<https://developers.openai.com/blog/codex-as-a-platform>
- Windows 使用与沙箱文档：<https://learn.chatgpt.com/docs/app/windows>

官方资料说明，Codex App Server 是富客户端集成接口，支持会话、审批、流式 Agent 事件等交互；默认 stdio 传输使用 JSON-RPC 风格 JSONL 消息。WebSocket 在官方文档中仍标记为 experimental/unsupported，因此本项目首版采用 stdio，不开放 localhost WebSocket 服务。上游 Codex GitHub 仓库标示 Apache-2.0 许可证，但交付产品仍须保留许可文件、NOTICE 并核查各第三方依赖许可证。

### 3.2 上游版本固定与补丁管理

不得直接长期跟随上游 `main` 自动升级。

每个 Jinggong Runtime 构建必须保存：

- `upstream_repo`：`https://github.com/openai/codex`
- `upstream_commit`：完整 commit SHA
- `jinggong_patch_version`：精工补丁版本
- `runtime_version`：精工 Runtime 版本
- `rust_toolchain_version`
- `build_target`：首期 `x86_64-pc-windows-msvc`
- 依赖锁定文件和构建时间

建议分支策略：

```text
upstream/openai-codex       # 上游只读镜像分支
jinggong/main               # 精工维护主分支
jinggong/patches            # 可选：精工补丁集
release/runtime-v0.x        # 内部发行分支
```

上游更新必须走评估流程：更新 commit → 依赖和许可证扫描 → 编译 → Runtime 自动化测试 → 双 Runtime 回归 → 人工批准发布。

### 3.3 Windows 目标策略

- 首期支持 Windows 11 x64，优先验证 Windows 10 22H2 的可用性，但未通过完整测试前不承诺正式支持。
- 首期构建目标：`x86_64-pc-windows-msvc`。
- ARM64 作为后续验证目标，不作为首版阻塞条件。
- 不把 WSL2 设为默认依赖；桌面产品默认在 Windows 原生环境运行。
- 需要实际验证 Codex Harness 的 PowerShell 执行、子进程管理、路径处理、文件权限和沙箱能力。
- Windows 沙箱不能只依赖 Prompt。优先复用上游已经实现并经过测试的 Windows sandbox 能力，并对其实际生效情况做验收。

**风险提示：** 上游代码存在 Windows 支持和平台差异，不能仅凭仓库存在 Windows 构建目标就认定所有沙箱和工具行为均已兼容。PoC 必须在干净 Windows 测试机验证。

---

## 4. 总体架构

```text
┌──────────────────────────────────────────────────────────────┐
│              精工Agent Windows Desktop                 │
│                                                              │
│  React/Vue UI（沿用现有技术栈，不无理由重写）                 │
│  Jira任务 | Agent会话 | 模型管理 | 知识库 | 记忆 | Diff审核    │
└──────────────────────────────┬───────────────────────────────┘
                               │ Desktop IPC
┌──────────────────────────────▼───────────────────────────────┐
│                    Desktop Main Process                      │
│                                                              │
│  Runtime Manager                                             │
│  ├─ Runtime Selector（默认 Jinggong）                        │
│  ├─ Runtime Health Check                                     │
│  ├─ Jinggong Runtime Adapter                                 │
│  └─ Codex Runtime Adapter                                    │
│                                                              │
│  Shared Services                                             │
│  ├─ Session/Task Service                                     │
│  ├─ Model Profile Service                                    │
│  ├─ Jira/Git Connectors                                      │
│  ├─ Knowledge & Memory Service                               │
│  ├─ Approval & Policy Service                                │
│  ├─ Local Data Repository                                    │
│  └─ Audit/Diagnostics                                        │
└───────────────┬────────────────────────────┬─────────────────┘
                │ stdio JSONL / local IPC    │ stdio JSONL / protocol
┌───────────────▼──────────────┐  ┌──────────▼─────────────────┐
│      Jinggong Runtime        │  │       Codex Runtime        │
│      jinggong-runtime.exe    │  │ official compatible        │
│                              │  │ App Server / supported     │
│ Forked Codex Harness         │  │ installed runtime          │
│ + 精工 patches                │  │                             │
│ + 精工 tool extensions        │  │ existing CLI adapter only  │
│ + 精工 model adapter (if req)│  │ for migration compatibility│
└───────────────┬──────────────┘  └────────────┬────────────────┘
                │                              │
                └──────────────┬───────────────┘
                               │
              ┌────────────────▼─────────────────┐
              │ Windows Local Workspace          │
              │ Git / Worktree / Files / Tests    │
              │ MES5 / MES6 / WMS project sources │
              └──────────────────────────────────┘

External services: Jira / remote Git / model gateways
Local storage: SQLite + local knowledge files/indexes
```

### 4.1 分层原则

1. UI 不直接启动或调用 Codex CLI/Runtime；一律通过 Desktop Main Process 的 Runtime Manager。
2. Runtime Manager 负责选择、检测、启动、停止、版本校验和事件路由。
3. 两种 Runtime 必须实现共同的 `AgentRuntimeAdapter` 接口。
4. Jira、Git、模型配置、知识库、记忆和审计由精工平台公共服务管理，不能复制成两套。
5. Runtime 只负责 Agent 执行及其原生能力，不应该拥有精工平台全部业务数据的最终所有权。
6. 本地数据优先沿用当前项目已经稳定使用的数据存储；若尚未建立可靠本地存储，才按 PRD 采用 SQLite。不得为本次改造无理由引入 PostgreSQL/Redis/服务器。
7. 桌面应用与 Runtime 使用 stdio/受控 IPC，不开放未经授权的本机 HTTP 端口。

---

## 5. 统一 Runtime 抽象层

### 5.1 设计目标

平台所有 Agent 功能通过统一接口访问执行引擎，保证 UI 不感知具体 Runtime 实现。Runtime 选择影响执行引擎，不影响用户界面和精工公共业务功能。

建议接口定义（伪代码，按当前语言栈适配）：

```ts
export type RuntimeKind = "jinggong" | "codex";

export interface RuntimeCapabilities {
  streaming: boolean;
  interrupt: boolean;
  resumeThread: boolean;
  toolCalling: boolean;
  approval: boolean;
  fileChanges: boolean;
  terminalExecution: boolean;
  windowsSandbox: boolean | "partial";
  imageInput: boolean | "partial";
  modelSelection: boolean | "runtime-managed";
}

export interface AgentRuntimeAdapter {
  readonly kind: RuntimeKind;

  detect(): Promise<RuntimeHealth>;
  getVersion(): Promise<RuntimeVersionInfo>;
  getCapabilities(): Promise<RuntimeCapabilities>;
  start(): Promise<void>;
  stop(): Promise<void>;

  createThread(input: CreateThreadInput): Promise<RuntimeThreadRef>;
  resumeThread(input: ResumeThreadInput): Promise<RuntimeThreadRef>;
  sendTurn(input: SendTurnInput): Promise<void>;
  interrupt(input: InterruptInput): Promise<void>;
  respondApproval(input: ApprovalResponseInput): Promise<void>;

  onEvent(handler: (event: NormalizedAgentEvent) => void): Unsubscribe;
  dispose(): Promise<void>;
}
```

以上为接口方向，不要求照搬类型名称。Codex Runtime 和 Jinggong Runtime 的底层协议可能不同，必须在 Adapter 内做协议转换。

### 5.2 统一事件模型

将 Runtime 原始事件转为精工统一事件：

- `thread.started`
- `turn.started`
- `assistant.message.delta`
- `assistant.message.completed`
- `reasoning.status`（只展示允许展示的状态，不暴露隐藏推理内容）
- `tool.started`
- `tool.output.delta`
- `tool.completed`
- `file.changed`
- `diff.available`
- `approval.required`
- `turn.interrupted`
- `turn.completed`
- `turn.failed`
- `runtime.warning`

每个事件必须带：`runtimeKind`、`runtimeThreadId`、`sessionId`、`turnId`、时间戳、事件版本和脱敏后的 payload。

### 5.3 能力差异与 UI 行为

- 两个 Runtime 的能力不能假定完全一致。
- 每次 Runtime 初始化后获取 capability set。
- UI 根据能力清单启用或禁用相关功能，并显示明确原因。
- 例如某 Runtime 暂不支持图像输入，界面应提示当前 Runtime 不支持，而不是请求后静默丢弃。
- 平台不可将不支持的审批能力伪装为已审批，也不可绕过 Runtime 的安全限制。

---

## 6. Jinggong Runtime 设计

### 6.1 目标

构建精工Agent自带的 `jinggong-runtime.exe`，默认运行在 Windows 本机。第一版以 Codex 开源 Harness 为执行底座，通过精工补丁、统一配置和发行方式形成精工维护的 Runtime。

### 6.2 进程和通信

- Runtime 为平台安装包内的受控可执行文件。
- Desktop Main Process 通过固定绝对路径启动 Runtime。
- Runtime 使用 stdin/stdout JSONL 或官方 App Server stdio 协议与主进程通信。
- stderr 用于诊断日志，不得将日志文本混入 JSONL 协议输出。
- 首版不使用 WebSocket、localhost HTTP 服务或公网回连。
- 必须支持进程异常退出检测、超时、强制终止、优雅退出和重启保护。
- 对每次启动记录 Runtime 版本、进程 ID、启动耗时和结果。

### 6.3 精工补丁范围

优先采用最小补丁原则，先验证/改造下列位置：

1. Runtime 启动参数与产品化配置。
2. 模型 Provider 配置和模型选择同步。
3. Windows 路径、PowerShell 和本机进程管理。
4. Runtime 元信息、版本输出和能力输出。
5. 精工自定义工具/MCP 扩展接口。
6. Jira 任务上下文注入接口（Jira API 调用仍由精工平台 Connector 负责）。
7. MES/WMS 知识检索上下文接口（知识库检索仍由精工 Knowledge Service 负责）。
8. 统一的会话事件与审批接口。

不得为了添加精工业务能力而深度改写上游核心 Agent Loop；优先使用受支持的工具扩展、配置和外部服务注入。

### 6.4 模型接入

模型配置由精工平台的 Model Profile Service 统一管理，至少包含：

- Provider ID、Provider 名称。
- API Base URL。
- API 协议类型。
- API Key 引用（不得明文落盘）。
- Model ID、显示名称。
- 允许的能力：文本、图像、工具调用、流式输出等。
- 推理等级/温度等可选参数。
- 超时和重试策略。

Jinggong Runtime 接收经过验证的运行配置，不自行维护一份与精工平台不一致的 Provider 清单。

必须区分：

- 上游 Harness 原生支持的 Provider/协议。
- 通过兼容层可支持的 Provider/协议。
- 需要开发适配器才能支持的协议。

对“OpenAI 兼容”中转站不能仅依据 URL 判断兼容，必须用真实模型完成工具调用、流式输出、上下文长度和错误处理测试。

### 6.5 Runtime 版本与资源目录

建议安装目录：

```text
安装目录/
  JinggongDevPlatform.exe
  resources/
    runtimes/
      jinggong/
        x64/
          jinggong-runtime.exe
          runtime-manifest.json
          LICENSES/
          NOTICE
      codex/
        adapter-config.json
    app.asar 或应用资源目录
    resources/
      app-icons/
```

建议用户数据目录：

```text
%LOCALAPPDATA%/JinggongDevPlatform/
  config/
  database/
  sessions/
  memory/
  knowledge/
  workspaces/
  logs/
  runtime-cache/
```

Runtime Manifest 示例：

```json
{
  "runtimeId": "jinggong",
  "displayName": "Jinggong Runtime",
  "runtimeVersion": "0.1.0",
  "upstream": "openai/codex",
  "upstreamCommit": "<full-commit-sha>",
  "patchVersion": "jg-patch-001",
  "platform": "windows-x64",
  "protocol": "app-server-stdio-jsonl",
  "minPlatformVersion": "0.1.0"
}
```

---

## 7. Codex Runtime 设计

### 7.1 目标

保留用户主动切换至 Codex Runtime 的能力。Codex Runtime 不能影响 Jinggong Runtime 的默认地位，也不能让平台业务功能依赖 Codex Runtime 才能工作。

### 7.2 集成优先级

1. 优先通过官方 Codex App Server 集成；它面向富客户端，提供会话、审批、流式事件等产品集成能力。
2. App Server 以 stdio 模式运行，禁止首版暴露 WebSocket/HTTP 端口。
3. 现有 Codex CLI 调用可以保留为过渡兼容层，但要标记为 Legacy，不新增业务依赖。
4. 如果用户机器上的 Codex 版本不符合支持范围，显示“不兼容版本”，提供检测说明，不执行未知参数。

### 7.3 Codex Runtime 的边界

- 由用户主动选择，不作为默认执行引擎。
- 不强制要求 Jinggong Runtime 与 Codex Runtime 共用底层账号认证。
- 不能直接复制用户的 Codex 登录凭据到精工数据库。
- 不应把 Codex Runtime 内部私有会话状态当作精工平台通用会话格式。
- 不能假定该 Runtime 对所有第三方模型中转站均可用；模型和工具能力以实际检测结果为准。

---

## 8. 会话、任务和 Runtime 切换的数据策略

### 8.1 会话归属

每个精工会话必须保存：

- `session_id`
- `runtime_kind` (`jinggong` / `codex`)
- `runtime_thread_id`
- `runtime_version`
- `model_profile_id`
- `project_id`
- `workspace_path`
- `created_at` / `updated_at`
- `session_status`

### 8.2 Runtime 切换

- 新建会话时读取当前全局 Runtime 设置。
- 会话开始后锁定 `runtime_kind`，中途不允许直接更改。
- 用户切换全局 Runtime 只影响后续新建会话。
- 已存在的会话仍由创建它的 Runtime 恢复。
- 如果原 Runtime 不可用，应提示用户修复/切换，并说明切换 Runtime 不等于恢复原生内部状态。
- 如用户选择“使用另一 Runtime 继续”，创建新会话，将历史对话摘要、已批准文件列表、当前 Git diff、未完成事项作为迁移上下文；保留原会话只读，不做虚假无损迁移。

### 8.3 历史数据迁移

- 不删除旧版 Codex CLI 生成的历史记录。
- 识别旧会话时尽量保存其原始来源、路径、会话 ID 和时间。
- 可继续通过 Codex Runtime 恢复的旧会话仍按原方式恢复。
- Jinggong Runtime 不应直接读取或篡改旧版 Codex 私有数据库，除非有明确官方兼容接口。
- 对无法迁移的会话，提供只读浏览或导出，不得静默丢弃。

---

## 9. 安全与本机执行边界

### 9.1 基本原则

- 代码执行必须有明确工作区边界和审批策略。
- 默认禁止无审批地访问工作区之外的敏感路径。
- 默认禁止未经授权的网络访问；按任务需要显式批准。
- 对写文件、运行终端命令、安装依赖、删除文件、Git push、提交、发布等操作实施分级策略。
- Runtime 进程以普通用户权限运行，不默认要求管理员权限。
- 运行时进程只能从安装目录的受信任位置启动。
- 所有子进程必须可追踪并能在任务取消时终止。

### 9.2 Windows 沙箱 PoC 必测

1. Agent 能否读取选定工作区内文件。
2. 未经批准能否写入工作区外文件（预期：拒绝）。
3. 未经批准能否访问网络（按策略预期：拒绝）。
4. 用户批准后是否只放开指定路径/命令。
5. PowerShell 子进程是否继承正确权限边界。
6. 取消任务时子进程是否全部退出。
7. 符号链接、junction、路径穿越和 UNC 路径是否能绕过工作区限制。
8. 高权限命令是否必须经过审批。

如果上游 Windows 沙箱在某种安装环境下未启用，必须显示安全降级状态；不允许仍标记“沙箱正常”。

### 9.3 凭据保护

- API Key、Jira Token、Git 凭据不写入源码、日志、普通配置文件或会话内容。
- Windows 使用 Credential Manager / DPAPI 等受保护机制存储密钥。
- 日志自动脱敏 Authorization、Token、Cookie、密码和查询参数。
- 不复用此前在聊天或文档中暴露的 Jira 密码；正式环境应先轮换凭据。

---

## 10. 现有项目渐进迁移方案

### 阶段 0：代码盘点（不改代码）

Codex 必须先分析当前项目并形成清单：

- 当前桌面框架及版本。
- 入口和主进程结构。
- 现有 `codex` / `codex exec` / `codex app-server` 调用点。
- Runtime 输出解析逻辑。
- 模型配置和鉴权逻辑。
- 会话表/本地数据结构。
- Jira、Git、知识库、记忆与 Runtime 的依赖关系。
- 现有构建和安装包流程。
- 测试现状与 Windows 目标环境。

交付：`docs/runtime-migration/current-state-inventory.md`。

### 阶段 1：统一 Runtime 接口

- 新增 `RuntimeManager`。
- 新增 `AgentRuntimeAdapter` 接口。
- 将当前 CLI 调用封装为 `CodexRuntimeAdapter` 的 Legacy 实现。
- UI 不再直接调用 CLI。
- 实现全局 Runtime 设置，默认 `jinggong`。
- 在 Jinggong Runtime 尚未接入时，开发环境允许显示“未就绪”，但不得把 Codex CLI 伪装成 Jinggong Runtime。

交付：Runtime Manager 和双 Runtime 选择 UI 的最小实现及测试。

### 阶段 2：Codex Runtime Adapter

- 先将现有 Codex 调用点收敛到一个 Adapter。
- 研究并实现官方 App Server stdio JSON-RPC 集成。
- 统一事件流、审批、取消和恢复接口。
- 对 Legacy CLI 逻辑进行标识，禁止新模块直接依赖。

交付：Codex Runtime 可作为用户主动选择的执行引擎工作。

### 阶段 3：Jinggong Runtime PoC

- Fork 上游仓库，固定 commit。
- 完成 Windows x64 编译环境和依赖锁定。
- 构建独立 `jinggong-runtime.exe`。
- 启动 App Server stdio 通信。
- 实现 `JinggongRuntimeAdapter`。
- 运行真实代码分析、修改、Diff、测试、审批和中断验证。
- 记录能力差异、性能和资源占用。

交付：独立可运行 Runtime PoC，不要求完整产品功能。

### 阶段 4：Jinggong Runtime 默认化

- 把 `jinggong-runtime.exe` 纳入 Windows 安装包。
- 安装后自动检测 Runtime 版本和完整性。
- 默认 Runtime 设置为 Jinggong。
- 完成双 Runtime 切换及会话归属规则。
- 实现异常诊断和手动切换。

交付：新安装默认 Jinggong Runtime 的内部测试安装包。

### 阶段 5：企业能力集成

在 Runtime 主流程稳定后接入或加强：

- Jira 日报日期（`cf[11116]`）任务查询、任务选择和附件上下文。
- Git 项目、分支和 Worktree 管理。
- MES5/MES6/WMS 生产字典检索。
- 企业开发规范、规则校验、测试用例生成。
- 项目记忆与长期记忆。
- 模型中转站和模型选择。

企业知识和 Jira Connector 应通过精工平台工具接口提供给两种 Runtime，避免重复开发两套连接器。

---

## 11. 研发任务拆分

| ID | 任务 | 优先级 | 产出 | 验收标准 |
|---|---|---|---|---|
| RT-001 | 现有项目技术盘点 | P0 | 当前架构与调用清单 | 找全现有 Codex 调用点和相关模块 |
| RT-002 | 统一 Runtime 接口设计 | P0 | Adapter 接口和事件模型 | UI 不直接调用 Codex CLI |
| RT-003 | Runtime 设置及默认值 | P0 | 设置页、持久化配置 | 新安装默认 Jinggong，可切换 Codex |
| RT-004 | Codex Runtime Adapter | P0 | Codex App Server/兼容 Adapter | 现有开发能力通过 Adapter 可用 |
| RT-005 | 上游 Codex Harness 评估 | P0 | Fork 技术报告 | 明确 crate、协议、Windows 构建与许可 |
| RT-006 | Windows Runtime 编译 PoC | P0 | jinggong-runtime.exe | 干净 Win11 x64 可启动 |
| RT-007 | Jinggong Runtime Adapter | P0 | Adapter 实现 | 创建会话、发送任务、接收事件、审批和中断 |
| RT-008 | Runtime 版本/能力检测 | P1 | Manifest、健康检查 | 可显示版本、兼容状态和能力清单 |
| RT-009 | Windows 沙箱验证 | P0 | 安全测试报告 | 越权写入、网络、子进程等测试通过 |
| RT-010 | Runtime 随包分发 | P1 | Windows 安装包 | 用户不需另装 Codex CLI 即可启动默认 Jinggong |
| RT-011 | 会话迁移策略 | P1 | 数据迁移和 UX | 旧会话保留，跨 Runtime 不虚假无损迁移 |
| RT-012 | 企业工具接口 | P1 | Jira/Git/知识库 Tool Provider | 两个 Runtime 可按能力使用公共工具 |
| RT-013 | 自动化回归 | P1 | Runtime 测试集 | 双 Runtime 核心场景通过 |
| RT-014 | 许可证与供应链合规 | P0 | LICENSE/NOTICE/SBOM | 上游和依赖许可证核查完成 |

---

## 12. PoC 验收标准

### 12.1 基础启动

- Windows 11 x64 测试机可启动精工Agent。
- 不要求安装 PostgreSQL、Redis、Docker、Python、Node.js 或 Codex CLI。
- 默认 Runtime 显示 Jinggong Runtime。
- Jinggong Runtime 版本和健康状态可显示。

### 12.2 Agent 开发闭环

在一个可丢弃的测试 Git 仓库执行：

1. 选择项目目录。
2. 创建 Agent 会话。
3. 输入一个明确的小型代码修改任务。
4. Runtime 能够读取代码并输出流式状态。
5. Runtime 能够调用文件/搜索/终端工具。
6. 真实修改文件并生成 Diff。
7. 执行项目测试命令。
8. 展示测试结果和修改摘要。
9. 支持用户中断任务。
10. 应用重启后会话记录仍可查看。

### 12.3 双 Runtime 验收

| 测试场景 | 预期结果 |
|---|---|
| 首次安装 | 默认 Jinggong Runtime |
| 设置切换至 Codex | 新会话由 Codex Runtime 执行 |
| 设置切回 Jinggong | 新会话由 Jinggong Runtime 执行 |
| 当前会话运行时切换 | 提示新建会话后生效，不热迁移 |
| Jinggong 未安装/损坏 | 明确报错，不静默切 Codex |
| Codex Runtime 不可用 | 仍可选择/运行 Jinggong（若其健康） |
| Runtime 进程异常退出 | 会话错误可见、日志可导出，可安全重试 |
| 旧版配置升级 | 旧数据保留，Runtime 默认迁移到 Jinggong |
| 旧会话 | 可按来源恢复或只读，不丢失 |

### 12.4 安全验收

- 工作区外未授权文件写入被阻止。
- 敏感路径访问遵守审批策略。
- 用户取消任务后，运行中的子进程被妥善终止。
- 密钥不出现在日志、数据库明文配置和导出诊断包中。
- Runtime 只能从签名/校验通过的安装位置启动。
- Runtime 安全能力的实际状态与 UI 显示一致。

### 12.5 性能与稳定性建议目标

以下是首期建议目标，需在实际 Windows 测试机测量后确认：

- 桌面应用启动后 Runtime 首次启动耗时有明确诊断数据。
- Runtime 启动失败时应用主窗口仍可使用设置和诊断功能。
- Agent 流式事件不应阻塞 UI。
- 长会话和大文件场景不得导致主进程明显卡死。
- 连续执行 20 次小型开发任务不发生资源泄漏或进程残留。

---

## 13. 风险及控制措施

| 风险 | 影响 | 控制措施 |
|---|---|---|
| 上游 Harness 内部 API 变化 | Fork 合并和升级成本高 | 固定 commit、补丁最小化、定期上游合并 |
| App Server 协议演进 | Adapter 兼容问题 | 协议版本探测、契约测试、事件模型隔离 |
| Windows 原生沙箱不完整 | 文件或命令越权风险 | PoC 安全测试，不通过则不默认开放高风险工具 |
| 第三方模型工具调用协议差异 | 部分模型无法执行工具 | Model Profile 能力声明与真实测试，不兼容模型禁用工具模式 |
| 两个 Runtime 内部状态不同 | 会话无法无损切换 | 会话固定 Runtime，跨 Runtime 用摘要创建新会话 |
| 自定义补丁过多 | 后续维护困难 | 优先外部工具扩展，限制深度修改上游核心 |
| Runtime 打包体积增加 | 安装包较大 | 评估压缩、增量更新和按架构打包 |
| 旧 CLI 调用未完全替换 | 功能路径混乱 | 搜索调用点、静态检查、禁止新模块直接 spawn codex |
| 用户误以为两 Runtime 完全等价 | 功能和模型差异引发问题 | Capability 检测、UI 标注差异 |
| 开源许可证处理不完整 | 商用分发合规风险 | 保存 LICENSE、NOTICE、SBOM，逐依赖审查 |

---

## 14. Codex 实施指令（复制本节给 Codex）

```text
你现在负责升级现有的「精工Agent」Windows 桌面项目。
本次任务不是新建一个项目，也不是推翻现有 UI，而是在现有代码上做双 Runtime 架构升级。

一、必须先理解的决策
1. 产品正式名称统一为「精工Agent」。
2. 平台同时支持两种 Agent Runtime：
   - Jinggong Runtime：基于 OpenAI Codex 开源 Harness Fork/改造形成的精工 Runtime，必须是默认 Runtime。
   - Codex Runtime：官方 Codex Runtime/App Server 兼容模式，由用户主动选择。
3. 设置中必须可以选择 Runtime。默认值必须是 jinggong。
4. 两种 Runtime 必须共用平台 UI、Jira、Git、模型配置、知识库、记忆和公共业务服务。
5. 不得静默切换 Runtime。
6. 运行中的会话不能热切换 Runtime；切换只对新会话生效。跨 Runtime 继续任务需新建会话并携带上下文摘要。
7. 产品形态为 Windows 桌面客户端，不建设服务器端 Web 平台，不开放 localhost HTTP/WebSocket 服务。

二、开始前必须先盘点现有项目
请检查：
- 项目实际桌面框架与版本；
- 当前所有 codex/codex exec/codex app-server 调用点；
- 现有会话、模型、Jira、Git、知识库和记忆实现；
- 当前 Windows 构建/安装包方式；
- 现有测试及代码质量状态。

不要假设当前项目技术栈。沿用已经存在且稳定的技术栈，不要无理由重写 UI。
先输出：docs/runtime-migration/current-state-inventory.md。

三、技术研究
研究 https://github.com/openai/codex 的当前源码和许可证，重点检查：
- codex-rs 与 App Server；
- Agent Loop、Tools、Context、Approvals、Sandbox；
- Windows x64 编译和运行；
- 当前模型 Provider 与配置方式；
- 许可、NOTICE 和第三方依赖。
必须固定一个上游 commit SHA，禁止无版本控制地跟随 main。

四、先完成统一 Runtime 层
实现 RuntimeManager、AgentRuntimeAdapter、RuntimeCapabilities、NormalizedAgentEvent。
把现有 Codex CLI 实现封装为 CodexRuntimeAdapter 的 Legacy 兼容实现；禁止 UI 和业务模块直接调用 codex 命令。
增加 Runtime 设置页，提供 Jinggong Runtime / Codex Runtime 选项，默认 Jinggong Runtime。

五、再做 Jinggong Runtime PoC
Fork 或工作区集成 Codex 开源 Harness，构建独立 jinggong-runtime.exe。
不要只是复制/改名官方 codex.exe。
首版优先使用 App Server stdio JSONL 或经过源码验证的本机 IPC，不开放网络端口。
实现 JinggongRuntimeAdapter，完成：启动、健康检查、版本查询、创建会话、发送任务、流式事件、工具调用、文件修改、Diff、测试命令、审批、中断和退出。

六、双 Runtime 行为
- 新安装默认 jinggong。
- 用户可以主动切换 codex。
- 用户选择持久化。
- 每个会话固定 runtime_kind、runtime_thread_id、runtime_version。
- 当前会话不能热切换。
- Jinggong 不可用时显示错误，不得偷偷回落到 Codex。
- Codex 不可用时应说明原因，不能影响健康的 Jinggong Runtime。
- 已有历史数据不得删除。

七、Windows 与安全
以 Windows 11 x64 为首期目标。
验证 Windows 原生执行、PowerShell、子进程终止、路径边界和沙箱。
不得声称沙箱已生效，除非完成测试。
API Key、Jira Token、Git 凭据不得明文存储；使用 Windows Credential Manager/DPAPI 等安全存储。
Runtime 不默认管理员权限运行。

八、必须分阶段执行
阶段 0：现有项目盘点和风险报告。
阶段 1：Runtime 抽象层、Runtime 选择器和 Codex 兼容 Adapter。
阶段 2：Jinggong Runtime 源码 Fork、Windows 编译与运行 PoC。
阶段 3：双 Runtime 会话、事件、审批、取消和 Diff 回归。
阶段 4：安装包集成、默认 Jinggong、升级迁移。
阶段 5：再接入/增强 Jira、MES5/MES6/WMS 知识、开发规范和记忆。

每个阶段都必须实际修改代码、运行测试、记录结果。不要只输出设计方案。
每阶段结束时提供：改动文件、测试命令、测试结果、未解决问题和下一阶段计划。
如果关键技术验证失败，先给出证据和替代路径，不得伪造测试通过。

九、交付文件
至少生成：
- docs/runtime-migration/current-state-inventory.md
- docs/runtime-migration/architecture.md
- docs/runtime-migration/runtime-api.md
- docs/runtime-migration/capability-matrix.md
- docs/runtime-migration/windows-sandbox-test.md
- docs/runtime-migration/license-compliance.md
- docs/runtime-migration/migration-plan.md
- docs/runtime-migration/acceptance-report.md

现在开始阶段 0：检查项目、盘点现状、核对 Codex 开源源码和 Windows 构建条件。阶段 0 完成后，继续实现阶段 1；不要未经验证就一次性重写整个项目。
```

---

## 15. 推荐验收顺序

不要先看界面是否像 Codex。按以下顺序验收：

1. Runtime 选择逻辑正确：默认 Jinggong，用户可切 Codex。
2. Jinggong Runtime 确实由安装包携带并独立启动，不依赖用户安装 Codex CLI。
3. Runtime 通信可靠：流式事件、错误、取消和审批正确。
4. 真实代码开发闭环可用：读取、修改、Diff、测试。
5. Windows 权限边界经过测试。
6. 现有 Jira、Git、知识库、模型配置和记忆功能没有回归。
7. 最后才验收安装包体积、界面表现和自动升级。

**最终产品目标：** 用户只安装「精工Agent」，默认使用 Jinggong Runtime；需要时可以在设置中主动切换 Codex Runtime。平台的业务能力和用户数据由精工Agent管理，Agent 执行引擎通过统一 Adapter 接入和切换。

---

## 16. 参考资料

以下官方资料用于技术实现核对，Codex 相关接口和版本会持续变化，实施时应以当前仓库固定 commit 和官方文档为准。

1. OpenAI Developers — Codex as a platform: build on the open agent harness（2026-08-19）  
   <https://developers.openai.com/blog/codex-as-a-platform>
2. OpenAI / ChatGPT Learn — Codex App Server  
   <https://learn.chatgpt.com/docs/app-server>
3. OpenAI — Unlocking the Codex harness: how we built the App Server  
   <https://openai.com/index/unlocking-the-codex-harness/>
4. OpenAI GitHub — Codex source repository and Apache-2.0 license  
   <https://github.com/openai/codex>
5. OpenAI / ChatGPT Learn — Windows app, native execution and sandbox guidance  
   <https://learn.chatgpt.com/docs/app/windows>
6. OpenAI / ChatGPT Learn — Agent approvals and security  
   <https://learn.chatgpt.com/docs/agent-approvals-security>


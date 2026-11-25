# P0：Codex 原生 Multi-Agent 与精工专家协作

> 目标版本：精工 Agent 0.9.8  
> 基线：Codex App Server 0.156.1  
> 优先级：P0，属于 P1 上下文检索与 Skills 集成的基础能力

## 1. 背景与问题

精工 Agent 当前基于 Codex App Server 执行开发任务，但 `packages/agent-runtime/src/index.ts` 的 `runtimeConfigOverrides()` 显式关闭了 `features.multi_agent` 和 `features.multi_agent_v2`。因此 Codex 原生协作工具没有正常向模型开放。

与此同时，精工已经开发了独立的治理型子任务机制：

- `apps/desktop/src/main/agent-orchestration.ts` 向主 Runtime 提供 `platform_agent_create_task`、`platform_agent_list_tasks`、`platform_agent_wait_tasks`、取消和修订等工具。
- `apps/desktop/src/main/agent-tasks.ts` 通过 `AgentTaskRunner` 创建受控分析 Runtime，管理任务契约、预算、只读工具、证据记录、重试和审计。
- `packages/expert-engine/src/index.ts` 通过 `resolveExpert()` 识别需求、后端、前端、测试、交付等专家角色，并生成 `expertInstructions()`。

问题不是精工没有 Agent，而是目前有两套能力尚未分层：Codex 原生协作被关闭；精工任务编排与专家中心尚未形成统一的协作策略；某些任务存在自动拆分和模型再次拆分的重复风险。

## 2. 产品目标

1. 开放固定版本 Codex App Server 的原生 Multi-Agent V2 能力。
2. 让精工专家中心决定“任务适合哪些专业视角、先核实什么、交付什么”，让 Codex 原生 Agent 决定“何时拆分、创建哪些子 Agent、如何等待和汇总”。
3. 保留精工治理型子任务的价值，供需要任务契约、预算、审计和严格只读工具网关的场景使用。
4. 同一会话同一轮只能由一种委派机制接管。
5. 第一阶段原生子 Agent 主要负责独立只读分析，主 Agent 负责代码修改和最终验证。

## 3. 非目标

本次不做：

- 不重新实现 `spawn_agent`、`wait_agent`、子 Agent 生命周期和模型工具调用。
- 不改用 OpenAI Agents API，不新建 Responses API 主推理循环。
- 不把 `AgentTaskRunner` 删除或改写为 Codex 原生子 Agent。
- 不在第一阶段允许原生子 Agent 并行修改同一个工作区。
- 不新增跨 Runtime 通用的任意代码执行沙箱。
- 不承诺所有中转站、所有模型都支持原生 Multi-Agent；必须以实际运行能力为准。

## 4. 当前代码事实与需要改造的位置

### 4.1 Runtime 配置

文件：`packages/agent-runtime/src/index.ts`

现有：

```ts
'features.multi_agent': false,
'features.multi_agent_v2': false,
```

`runtimeConfigOverrides()` 当前只接受 `RuntimeOptions` 的部分字段，需要扩展为明确的 Multi-Agent 配置输入，而不是把新配置散落到 `index.ts` 的字符串常量中。

Codex 0.156.1 官方源码基线：

- `codex-rs/core/config.schema.json`，Tag `rust-v0.156.1`
- `codex-rs/features/src/feature_configs.rs`，Tag `rust-v0.156.1`
- `MultiAgentV2ConfigToml` 在该版本中包含 `enabled`、`max_concurrent_threads_per_session`、等待超时、`tool_namespace`、`wait_agent_enabled`、`expose_spawn_agent_model_overrides`、`non_code_mode_only` 等字段。
- 该版本的 `features.multi_agent_v2` 可配置为布尔值或配置对象；本项目应使用带 `enabled` 的配置对象，以便固定并发和等待行为。

参考：

- https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/config.schema.json
- https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/features/src/feature_configs.rs
- https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/config/mod.rs
- https://developers.openai.com/blog/codex-as-a-platform

注意：不要套用 Agents API 的 `agent.multi_agent.enabled` 字段。本项目是 Codex App Server，必须使用本项目固定版本的 Codex config schema。

### 4.2 Runtime 选项和进程复用

- `packages/agent-runtime/src/index.ts`：`RuntimeOptions`、`runtimeConfigOverrides()`、`CodexRuntime`。
- `apps/desktop/src/main/runtime-reuse.ts`：`codexIdentity()`、`codexRuntimeProcessKey()`、`codexRuntimeReuseKey()`。
- `apps/desktop/src/main/codex-app-server-prewarm.ts`：Codex App Server 预热。
- `apps/desktop/src/main/index.ts`：`getRuntime()`、`prewarmCodexSession()` 和 `runtimeOptions`。

新委派模式、Multi-Agent 开关和并发配置必须进入 Runtime 进程身份指纹。否则不同模式可能错误复用同一 App Server，造成一个会话需要 native、另一个会话需要 governed/off，但实际沿用同一个进程配置。

### 4.3 专家和现有任务机制

- `packages/expert-engine/src/index.ts`：`resolveExpert()`、`expertInstructions()`。
- `apps/desktop/src/main/expert-center.ts`：专家选择、专家运行记录、来源记录。
- `apps/desktop/src/main/agent-orchestration.ts`：治理型工具 Provider。
- `apps/desktop/src/main/agent-tasks.ts`：治理型子任务执行器与自动任务拆分。
- `apps/desktop/src/main/index.ts`：组装 `orchestrationProvider` 并传给 Runtime。

开发前必须定位当前发送一轮消息时 `inferAutomaticAgentTaskPlan()` 和 `createAgentOrchestrationProvider()` 的实际调用条件，不可只修改 Runtime 配置而漏掉重复拆分路径。

## 5. 功能需求

### FR-01：原生 Multi-Agent V2 开关

在 Codex Runtime 设置中启用原生 Multi-Agent V2。默认新建 Codex 会话开启；用户可以在会话设置中关闭或切换委派方式。

建议新增统一枚举：

```ts
type AgentDelegationMode = 'native' | 'governed' | 'off';
```

字段可以持久化在 Session，也可以持久化在单独的会话能力配置对象中；优先复用现有 Session 持久化和迁移机制，避免另建第二套会话配置表。

默认规则：

- 旧 Codex 会话：迁移后默认 `native`，但仅在 Runtime 能力探测成功时启用；能力不足时明确提示并降级为 `off`，不得悄悄启用 governed 并重复拆分。
- 新建 Codex 会话：默认 `native`。
- Jinggong / Claude / Grok：保留现有行为，不因为新增枚举而改变既有委派方式。

### FR-02：委派模式互斥

| 模式 | Codex 原生 Multi-Agent | `platform_agent_*` Provider | 自动精工子任务计划 | 说明 |
|---|---|---|---|---|
| `native` | 开启 V2 | 不注入 | 不自动生成 | 默认协作路径 |
| `governed` | 关闭 | 按现有条件注入 | 保留现有治理路径 | 需要预算、契约、审计时使用 |
| `off` | 关闭 | 不注入 | 不生成 | 单 Agent 执行 |

具体实现要求：

1. 在 `getRuntime()` 组装 `RuntimeOptions` 前解析最终模式。
2. 只有 `governed` 模式才创建/注入 `orchestrationProvider`。
3. 只有 `governed` 模式才允许本轮自动生成新的 `AgentTask`。
4. `native` 模式不得在同一轮同时创建 `AUTOMATIC_AGENT_TASK_PREFIX` 任务。
5. `off` 模式无论用户任务包含多少工作面，都不得创建平台子任务或启用原生子 Agent。
6. 现有已经创建的治理任务应按原契约继续执行或安全收尾，不得因模式迁移被删除。
7. 不要移除任务中心查看历史任务、查看审计和取消任务的能力。

### FR-03：原生 V2 连接配置

对 Codex `0.156.1`，native 模式建议使用以下配置结构。实际 `-c` 参数键路径和序列化方式必须经过本机固定版本启动测试：

```ts
const multiAgentV2 = {
  enabled: true,
  max_concurrent_threads_per_session: 4,
  min_wait_timeout_ms: 10_000,
  max_wait_timeout_ms: 3_600_000,
  default_wait_timeout_ms: 30_000,
  tool_namespace: 'collaboration',
  hide_spawn_agent_metadata: true,
  expose_spawn_agent_model_overrides: false,
  wait_agent_enabled: true,
  non_code_mode_only: false,
};
```

配套设置：

- `features.multi_agent = true`：保留 V1 兼容路径，但 V2 已显式启用时应以 V2 为准。
- `features.multi_agent_v2 = multiAgentV2`：明确开启 V2。
- `agents.enabled = true`：允许 Agent 角色配置；必须按 0.156.1 Schema 核验。

`max_concurrent_threads_per_session` 采用固定版本默认值 4 作为初始值。该字段的实际并发解释以 0.156.1 源码与集成测试为准，不要将其直接解释成“4 个子 Agent”。如果界面展示“最多并发子 Agent 数”，必须以真实创建结果和 Runtime 语义校准。

非 native 模式：

- `features.multi_agent = false`
- `features.multi_agent_v2 = { enabled: false }` 或按 0.156.1 Schema 使用明确关闭值
- `agents.enabled = false`

不要添加该固定版本 Schema 不存在的配置项。开发时逐项核验，不能直接照抄 Codex 主分支后来新增的字段。

### FR-04：能力检测与降级

App Server 初始化成功不等于当前模型一定能够完成原生子 Agent 调用。增加真实能力验证：

1. 校验 Codex 二进制版本必须等于 `CODEX_RUNTIME_VERSION`。
2. 校验 App Server 的配置没有因未知字段被拒绝或忽略。
3. 在隔离测试会话中请求 Codex 使用一个最小子 Agent 完成只读文件定位任务。
4. 子 Agent 返回结果后，主 Agent 能够继续并完成最终总结。
5. 对实际失败分类：Runtime 不支持 / 模型不支持 / 中转站不支持所需调用 / 配置无效 / 进程异常 / 任务超时。
6. 能力检测结果按 Runtime 版本、模型和 Provider 记录，不能仅按“Codex Runtime 已启动”判断 Multi-Agent 可用。
7. 真实会话不应为了健康检测自动额外消耗模型额度；首次显式使用或用户点击测试时运行实际验证。一般会话启动只进行无模型请求的配置与版本校验。

发生不支持时：

- 当前轮降级为单 Agent 继续，不自动创建 governed 子任务。
- 在会话中显示“原生多 Agent 当前不可用，本轮由主 Agent 单独执行”。
- 用户可主动切换到 governed 模式后重新发起任务。

### FR-05：专家驱动原生协作

将现有 `resolveExpert()` 和 `expertInstructions()` 作为专家唯一入口，不另建一套独立专家路由器。

新增一个纯函数，建议命名：

```ts
buildExpertCollaborationGuidance(
  resolution: Resolution,
  delegationMode: AgentDelegationMode,
  capabilities: NativeAgentCapabilities,
): string;
```

该函数根据当前专家档案、系统类型、任务内容和 native 能力生成协作指引。它不直接调用模型、不创建任务、不写数据库。

当 `delegationMode === 'native'` 且能力可用时，指导主 Agent：

- 先判断任务是否有至少两个相互独立的分析工作面。
- 只有有实际并行收益时才创建子 Agent；简单问题由主 Agent 自己处理。
- 优先拆分需求、架构、后端、前端、测试、审查等不同工作面。
- 每个子 Agent 必须获得单一明确目标、必要项目上下文、输出字段和证据要求。
- 子 Agent 默认只读分析，不修改项目文件，不提交 Git，不部署。
- 主 Agent 负责汇总、消除冲突、修改代码、构建和测试。
- 不允许两个子 Agent 同时负责修改相同文件。
- 子 Agent 的证据必须来自真实读取的当前工作区文件，给出相对路径和行号；不得编造 Hash 或文件内容。
- 子 Agent 不得扩大当前项目、文件、网络和操作权限。
- 默认不覆盖子 Agent 的模型与推理档位，继承父 Agent 当前模型/配置；只有用户明确要求才开放模型覆盖。

当 native 工具未出现在模型可用工具中时：

- 不要编造 `spawn_agent` 调用。
- 不要偷偷改用 `platform_agent_create_task`。
- 主 Agent 自己执行，并向用户说明“当前模型/中转站未开放原生协作工具”。

### FR-06：默认专业协作模板

现有内置专家不需要全部改成固定 Agent 名称。优先由 Expert Profile 的 `steps`、`sources`、`skillTags`、`workflowId` 动态生成子任务指导。

建议初始映射如下：

| 专家角色 | 可选并行分析视角 | 主 Agent 最终责任 |
|---|---|---|
| 需求分析专家 | 业务流程/边界、数据字段/状态、验收场景 | 统一需求基线与验收标准 |
| 后端开发专家 | 调用链、数据库/事务、性能/兼容 | 修改后端、构建与测试 |
| 前端开发专家 | 页面组件、交互/状态、接口契约/异常态 | 修改前端、构建与界面验证 |
| 全栈开发专家 | 前端、后端、接口契约、回归风险 | 协调实现和联调 |
| 测试质量专家 | 测试设计、影响面、边界/异常场景 | 确定并执行正式验证 |
| 项目经理/总监专家 | 计划、客户依赖、风险、回款与验收 | 统一经营口径和行动计划 |
| 实施工程师专家 | 操作手册、配置、日志/复现路径 | 给出可执行操作步骤和现场确认项 |

上表是协作建议，不表示每个任务都必须创建所有角色。

### FR-07：原生 Agent 活动可观察

如 0.156.1 App Server 事件协议能提供可靠的原生子 Agent 生命周期事件：

- 解析真实事件，不通过模型回复文本中的“已创建 Agent”推断。
- 在当前会话中展示子 Agent 名称/角色、状态、启动/完成时间、输出摘要和失败原因。
- 记录到现有 Runtime 事件/性能追踪，不要冒充 `AgentTask` 治理记录。

如果固定版本的事件没有提供足够结构化信息：

- 暂时展示 Codex 实际发出的工具活动和最终汇总。
- 不虚构每个子 Agent 的状态、Token、成本和耗时。
- 将细粒度 Agent 面板列为后续迭代，不阻塞 P0 的原生执行能力。

## 6. 技术设计

### 6.1 类型和配置

建议新增：

```ts
export type AgentDelegationMode = 'native' | 'governed' | 'off';

export interface NativeAgentSettings {
  enabled: boolean;
  maxConcurrentThreadsPerSession: number;
  waitTimeoutMs: number;
  version: number;
}
```

`Session` 中新增可选 `agentDelegationMode`，或使用现有会话设置扩展字段。选择方案时必须遵循当前 Domain/Storage 的版本迁移模式。

RuntimeOptions 增加：

```ts
nativeMultiAgent?: {
  enabled: boolean;
  maxConcurrentThreadsPerSession: number;
  minWaitTimeoutMs?: number;
  maxWaitTimeoutMs?: number;
  defaultWaitTimeoutMs?: number;
};
```

不要让 `RuntimeOptions` 直接接收未经校验的任意 TOML 对象。采用 Zod/明确接口做值域校验。

### 6.2 Runtime 配置组装

将 `runtimeConfigOverrides()` 改成纯函数，输入包含 `nativeMultiAgent`，输出稳定对象。

测试要求：

- native：V2 enabled，V1 fallback 明确，namespace、等待与并发参数正确。
- governed：原生 V2 关闭，`agents.enabled` 关闭，平台工具仍可注入。
- off：原生 V2 关闭，平台 Provider 不注入。
- 未知模式、非法并发、超范围超时必须拒绝，不可静默调整。
- 只允许写入 Codex 0.156.1 Schema 中真实存在的配置字段。

### 6.3 Runtime 复用与预热

`codexIdentity()` 至少增加：

- `nativeMultiAgent.enabled`
- `nativeMultiAgent.maxConcurrentThreadsPerSession`
- 等待时限和其他会改变 App Server 行为的选项
- 实际能力版本

预热参数必须与真实会话完全一致。native 和 governed 的 Codex 进程配置不同，不得共用预热进程。

如果 `CodexAppServerPrewarm` 不能安全预热不同模式，应先只预热默认 native 会话，其他模式冷启动；不要为提高速度牺牲配置正确性。

### 6.4 会话发送和工具注入

在 `apps/desktop/src/main/index.ts` 统一解析模式：

```ts
const delegationMode = resolveDelegationMode(session, kind);
const nativeMultiAgentEnabled = kind === 'codex' && delegationMode === 'native';
const governedDelegationEnabled = delegationMode === 'governed';
```

再据此决定：

- Runtime 的 `nativeMultiAgent` 配置；
- 是否创建 `createAgentOrchestrationProvider()`；
- 是否调用 `inferAutomaticAgentTaskPlan()`；
- 是否在 RuntimeOptions 中提供 `platformToolProvider`。

禁止在不同代码分支分别猜测模式，避免 UI 显示 native、实际却注册 governed Provider。

### 6.5 专家协作上下文

保留现有 `expertInstructions()`。在调用 Runtime 前由一个纯函数组合：

1. 必须遵守的项目规范与安全规则；
2. 当前专家档案及工作步骤；
3. 产品范围和产品版本；
4. 已确认项目事实/决策和资料引用；
5. 可用原生协作能力与协作约束；
6. 当前轮可匹配的 Skills 元数据（P1-2 完成后接入）。

专家协作指引不能覆盖 Runtime 固定的开发规范、开发工具路径边界、验证要求和用户权限选择。

### 6.6 事件与可观察性

先阅读 Codex 0.156.1 `generate-ts` 的事件类型和实际事件样例，再决定是否新增 NativeAgentActivity 事件。

可复用现有 `RuntimeEvent`、`RuntimeEventBatcher` 和 `PerformanceTelemetry`。若新增事件类型，应确保：

- 旧事件解析仍兼容；
- 未识别事件不会导致 App Server 子进程被杀；
- 事件不包含 API Key、Token、完整敏感路径或未经脱敏的凭据；
- UI 事件顺序稳定；
- 子 Agent 的模型 Token/成本未知时显示“未知”，不能估算后冒充真实值。

## 7. UI 需求

在 Codex 会话设置中新增“任务协作模式”：

- Codex 原生多 Agent（推荐）：模型自主创建并管理原生子 Agent。
- 精工受控任务：使用精工任务契约、预算、只读工具与审计。
- 单 Agent：不拆分任务。

显示约束：

- 仅 Codex Runtime 显示三个选项；其他 Runtime 继续沿用现有行为。
- 当前模式明确展示，不允许仅在后台静默变更。
- native 不可用时展示具体状态：Runtime 版本不匹配、模型不支持、Provider/中转站不支持、配置错误或测试尚未完成。
- 切换模式必须在当前任务停止/结束后进行；切换后建立匹配配置的新 Runtime 进程或 Thread，不在活动轮次中热改配置。
- 若当前会话有正在运行的 governed 子任务，切换前必须提示并阻止造成任务孤儿的切换。

不强制第一版增加独立“Agent Command Center”。如果已有任务活动区域可以容纳原生协作事件，先复用当前布局。

## 8. 数据迁移

- 新增 Session 字段必须有默认值迁移。
- 旧 Codex Session 默认设置为 native，但真实能力不可用时显示单 Agent 回退状态。
- 旧 Jinggong/Claude Session 原值不变。
- 不删除 `AgentTask`、`TaskContract`、审计事件和已有运行记录。
- 不把 native Agent 虚构为 `AgentTask`，两种记录模型保持各自语义。
- 变更 schema version、migration 测试和备份恢复测试必须同时完成。

## 9. 失败场景与处理

| 场景 | 预期行为 |
|---|---|
| Codex App Server 版本不匹配 | 禁止启用原生协作，按现有 Runtime 健康检查报错 |
| 配置字段被固定版本拒绝 | 记录脱敏 stderr，native 能力标为不可用，不自动切 governed |
| 模型没有原生协作工具 | 主 Agent 单独完成，明确说明原因 |
| 子 Agent 超时 | 主 Agent 可继续汇总已完成结果，并说明缺失工作面 |
| 子 Agent 失败 | 保留可用结果和失败状态，不自动无限重试 |
| 主会话取消 | Codex 原生负责其内部 Agent 取消；宿主按协议取消当前主 Turn，不编造子 Agent 结果 |
| native 切换 governed | 当前 Turn 结束后切换进程/Thread，不在活动 Turn 过程中修改配置 |
| 旧任务仍在运行 | 保持原 governed 生命周期，禁止被切换逻辑丢弃 |
| Runtime 复用键不一致 | 放弃复用，安全冷启动 |

## 10. 测试要求

### 单元测试

- `runtimeConfigOverrides()` 三种模式配置快照测试。
- Multi-Agent 配置边界测试。
- `resolveDelegationMode()` 旧会话/新会话/不同 Runtime 的兼容测试。
- `codexRuntimeProcessKey()` 在模式/并发变化后必须变化。
- Expert collaboration guidance 对需求、后端、前端、测试、实施等专家输出符合预期。
- native 模式不会创建 automatic AgentTask，也不暴露 `platform_agent_*`。
- governed 模式仍保持现有任务治理能力。
- off 模式不创建任何子任务。

### 集成测试

在隔离 Codex Home / 临时工作区 / 受控 API 配置下测试：

1. App Server 0.156.1 启动。
2. `initialize` 成功。
3. `thread/start` 成功。
4. 主 Agent 发起一个明确的只读子 Agent 工作任务。
5. 子 Agent 真实完成并将结果交给主 Agent。
6. 主 Agent 完成汇总。
7. 取消、超时、失败和恢复路径可控。

如果中转站或模型不支持 Multi-Agent，测试必须标为环境不支持，不能把“Runtime 启动成功”当作原生 Multi-Agent 已验收。

### 回归测试

- 不启用插件时 Codex 原有会话能持续对话。
- 启用 Codex Plugin 时，现有 Profile 同步仍正常。
- Jinggong Runtime 的 Skill Loader 保持不变。
- `AgentTaskRunner` 的预算、审计、只读工具、重试和取消测试全部保留。
- Codex Worktree 与 Git Diff、构建验证、任务完成通知不受影响。

## 11. 验收标准

全部满足才算 P0 完成：

- Codex Runtime 0.156.1 在 native 模式真实出现并使用原生多 Agent 能力。
- native/governed/off 三种模式互斥并持久化。
- native 模式不创建重复的精工自动子任务，不暴露治理型工具。
- governed 模式原有任务治理能力无退化。
- 当前专家档案能影响子 Agent 分工、输入、来源范围和结果格式。
- 主 Agent 保留最终代码修改和验证责任。
- 进程复用、预热、Thread 恢复和旧数据迁移没有模式串线。
- 不可用时有明确降级，绝不虚报“原生多 Agent 已启用”。

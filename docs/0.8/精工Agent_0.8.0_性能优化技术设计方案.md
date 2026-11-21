# 精工 Agent 0.8.0 性能优化技术设计方案

> 文档类型：技术设计 / 实施方案（TDD）  
> 产品：精工 Agent（Windows Desktop）  
> 版本：0.8.0  
> 主题：Codex Runtime 性能优化  
> 目标分支：`develop/desktop-poc`（以实施时仓库实际状态为准）  
> 关联文档：[精工 Agent 0.8.0 性能优化需求规格说明书](./精工Agent_0.8.0_性能优化需求规格说明书.md)

---

## 1. 技术设计原则

1. **沿用 Codex，不重造 Codex。** 继续使用当前 Codex Runtime 和 Codex App Server；优化外围生命周期、上下文和应用层工具链。
2. **先测量，再优化。** 所有性能改动必须能通过指标和固定任务集验证。
3. **同会话复用优先。** 先减少重复创建进程，不在没有充分隔离证据前跨会话共享 Runtime。
4. **上下文按需加载。** 不把所有 MES/WMS 字典和项目资料无差别塞入每轮请求。
5. **并发必须有安全元数据。** 默认串行，只对显式标记为只读、幂等、无依赖的工具开放并发。
6. **流式实时、渲染批量。** 不延迟 Runtime/传输层的 Token，只优化 UI 更新频率。
7. **失败可回退。** 每项优化有开关和原有路径回退机制。
8. **不扩大权限。** 不改变现有执行权限、审批策略和项目访问边界。

## 2. 当前架构基线与核对清单

此前检查到的关键代码入口如下。Codex 开始实施时必须重新读取这些路径，并通过 `rg` 搜索实际引用；文件可能在分支更新后发生变化。

| 模块 | 此前检查的路径 | 本次关注点 |
|---|---|---|
| Runtime 导出与 Adapter | `packages/agent-runtime/src/index.ts` | Codex/Jinggong Adapter、运行时构造入口 |
| Runtime 管理 | `packages/agent-runtime/src/manager.ts` | 创建、销毁、取消、状态流转 |
| 会话 Runtime 生命周期 | `apps/desktop/src/main/session-runtimes.ts` | 空闲实例、TTL、并发与回收 |
| 主进程入口 | `apps/desktop/src/main/index.ts` | `getRuntime()`、会话创建/发送/关闭流程 |
| Runtime 复用 Key | `apps/desktop/src/main/runtime-reuse.ts` | 配置指纹与兼容性判断 |
| 能力声明 | `packages/agent-orchestrator/src/runtime-capabilities.ts` | Codex/Jinggong 能力矩阵 |
| 运行时构建脚本 | `scripts/build-jinggong-runtime.mjs` | 仅用于确认现有构建边界，不要求修改 |
| 本地性能基线 | `scripts/performance-baseline.ts` | 参考现有基准框架，补齐 Runtime 端到端测试 |
| 复用相关测试 | `tests/runtime-reuse.test.ts`、`tests/session-runtimes.test.ts` | 复用 Key、TTL、清理和异常测试 |
| Runtime 集成测试 | `tests/runtime.test.ts` | App Server 协议、恢复、Windows 兼容 |

### 2.1 当前架构判断

- Codex 与 Jinggong 当前共享底层 `CodexRuntime` 实现，不应误以为 Jinggong 是另一套已经独立优化的执行引擎。
- Codex App Server 通过 stdio JSONL 与桌面主进程通信。
- 模型服务调用和模型推理耗时受中转站/模型服务影响；本地 Runtime 优化主要减少进程启动、上下文准备、工具调度和界面渲染等待。
- 当前已有 Codex 复用基础，0.8 应优先补齐边界、配置指纹、生命周期测试和观测，而不是另写一套进程池。
- 现有 `performance-baseline.ts` 不能代表 Runtime 全链路性能，需新增 Runtime 真实任务基准。

## 3. 总体架构

```text
React Renderer
  ├─ Chat UI / Message List
  ├─ Streaming View Scheduler
  └─ Performance Diagnostics View
          │ IPC
          ▼
Electron Main Process
  ├─ Session Orchestrator
  ├─ Runtime Lifecycle Manager
  │    ├─ Runtime Reuse Policy
  │    ├─ Idle TTL / LRU Cleanup
  │    └─ Runtime Prewarm Coordinator
  ├─ Context Builder
  │    ├─ Core Rules
  │    ├─ Project Context
  │    ├─ Task Context
  │    ├─ Knowledge Retrieval
  │    └─ History Summary
  ├─ Platform Tool Executor
  │    ├─ Tool Safety Metadata
  │    ├─ Bounded Read-only Scheduler
  │    └─ Scoped Cache
  └─ Performance Telemetry
          │ stdio JSONL
          ▼
Codex App Server / Codex Runtime
  ├─ Thread / Turn lifecycle
  ├─ Model Provider (Responses API)
  └─ Native tools / Agent execution
          │
          ▼
Configured Model Relay / Model Service
```

**边界说明：** 本次不替换 Codex App Server 内部的 Agent 调度。工具并发只针对精工 Agent 自行管理的平台工具；Codex 原生工具仍由 Codex 自己管理。

## 4. Runtime 生命周期优化设计

### 4.1 目标状态机

```text
COLD
  │ create
  ▼
STARTING ── initialize success ──> READY
  │                                │ send turn
  │ failure                        ▼
  ▼                              BUSY
FAILED                              │ turn completed
  │                                 ▼
  └─ retry / recreate              IDLE
                                      │
                 ┌────────────────────┼─────────────────────┐
                 │ within TTL         │ TTL / cap exceeded  │ app/session close
                 ▼                    ▼                     ▼
               READY/BUSY           CLOSING               CLOSING
                                      │                     │
                                      ▼                     ▼
                                    CLOSED                CLOSED
```

状态名称可映射现有实现，不要求为了状态机图重写代码。关键在于状态转换必须集中管理，避免 `index.ts`、`session-runtimes.ts` 和 `manager.ts` 各自维护互相矛盾的状态。

### 4.2 复用范围

0.8 默认实现**同一逻辑会话内的进程复用**：

- 一轮任务结束，实例转为 `IDLE`。
- 同一会话再次发送任务且配置兼容、TTL 未到期时，取回该实例。
- 其他会话不得直接继承该会话的 Thread、消息、工具状态或上下文。
- 不把“相同模型/相同 API 配置”误判为可以跨会话共享全部 Runtime 状态。

若现有 `SessionRuntimeRegistry` 实际上还支持跨会话进程共享，Codex 必须先画出 Thread 与 Runtime 的映射关系，再决定是否保留。任何共享都必须证明 Thread ID、会话历史、工作目录、插件和工具上下文严格隔离。

### 4.3 RuntimeReuseKey 设计

建议复用现有 `codexRuntimeReuseKey()`，集中构建稳定指纹，而不是另建平行 Key 系统。

建议 Key 包含：

| 字段 | 目的 |
|---|---|
| `runtimeKind` | 区分 codex / jinggong 等 Runtime |
| `runtimeVersion` | 防止二进制/协议版本不同仍复用 |
| `binaryIdentity` | 可执行文件路径、文件大小、修改时间或 manifest hash |
| `cwd` | 绑定工作目录 |
| `providerBaseUrl` | 区分不同模型服务端点 |
| `model` | 区分模型 |
| `reasoningEffort` | 配置差异时重建 |
| `developerInstructionsHash` | 开发者指令变化时重建，不记录全文 |
| `dictionaryVersionHash` | MES5/MES6/WMS 词典版本变化时重建 |
| `pluginSnapshotHash` | 插件启用状态及配置变化时重建 |
| `toolsetHash` | 平台工具定义变化时重建 |
| `readAccessHash` | 读权限或目录授权变化时重建 |
| `relevantEnvHash` | 仅纳入确实影响 Runtime 的环境变量摘要 |

要求：

1. API Key 不得进入可读日志或持久化 Key。若现有逻辑必须区分不同凭据，可在内存中做安全摘要比较，不输出摘要原值。
2. 对象字段排序后再序列化，避免无意义的属性顺序导致 Key 变化。
3. 未知/缺失的重要配置应保守处理，不能默认视为兼容。
4. 对 Key 的每个字段都必须有测试：变化后 Key 改变，不相关展示字段变化不改变 Key。
5. 插件配置只在 Codex 当前实际支持的范围内参与 Key；不得因为加入复用而绕过现有插件校验。

### 4.4 生命周期管理器

优先扩展 `session-runtimes.ts` 现有管理能力，建议明确以下职责：

```ts
interface RuntimeReusePolicy {
  enabled: boolean;
  idleTtlMs: number;
  maxIdleInstances: number;
}

interface RuntimeLifecycleTelemetry {
  traceId: string;
  sessionId: string;
  runtimeKind: string;
  coldOrWarm: 'cold' | 'warm';
  reuseMissReason?: string;
}
```

具体类型以现有项目类型体系为准，不要求逐字照搬。

处理规则：

- 每个 Runtime 实例需要记录创建时间、最近使用时间、状态和对应会话标识。
- 只能清理 `IDLE` 实例；不能清理 `BUSY` / `STARTING`。
- 到达最大空闲实例数时，按最近最少使用（LRU）回收空闲实例。
- TTL 检查使用单调时钟。
- `closeSession()` 必须等待或安全中止进程关闭，不能只删除 Map 记录。
- 关闭操作幂等；多次调用不会导致重复错误或孤儿进程。
- 同一会话同一时刻只有一个 turn 操作进入 Runtime。
- 进程意外退出时，将实例标为失效并清除关联复用记录。

默认配置建议：`idleTtlMs = 5 * 60 * 1000`、`maxIdleInstances = 3`。两项必须可配置并有合理上下限；默认值不要在多个文件分别硬编码。

### 4.5 预热设计

将已有的 `RuntimePrewarmService`（如当前仍存在）与真正的 App Server 预启动解耦：

- `componentCheck`：校验本地二进制、依赖、文件完整性。
- `appServerPrewarm`：启动 Codex App Server，完成本地协议初始化。
- `modelWarmup`：本次不实现；除非用户明确开启未来实验，否则不得发模型生成请求。

建议触发时机：用户创建/打开一个 Codex 会话并且当前模型配置可用后，后台触发 `appServerPrewarm`。若现有 App Server 协议要求必须先创建 Thread，则只做安全的本地初始化，Thread 延迟到用户发送第一条消息时再创建；不得创建会话后遗弃的空 Thread。

预热管理要求：

1. 相同 RuntimeReuseKey 同时只能有一个预热任务。
2. 预热进程与真实会话绑定前应处于 `WARMING` / `READY_UNBOUND` 等明确状态。
3. 绑定会话后只能服务目标会话。
4. 超时、失败、用户切换 Runtime 或关闭应用时，按策略清理。
5. 预热失败只记日志，不弹出阻断性错误；用户发消息时仍走正常冷启动。
6. 不执行模型推理，不计入用户 Token 消耗。

## 5. 上下文分层和按需检索设计

### 5.1 Context Builder 管道

```text
User Task / JIRA Task
        │
        ▼
Task Intent & Project Resolve
        │
        ├─ Core Rules (always)
        ├─ Project Context (project scoped)
        ├─ Task Context (current turn)
        ├─ Knowledge Retrieval (MES5 / MES6 / WMS)
        └─ History Summary (when needed)
        │
        ▼
Deduplicate / Rank / Budget
        │
        ▼
Context Manifest + Prompt Sections
        │
        ▼
Codex Runtime
```

建议新增或整理成清晰的模块边界，例如：

- `ContextPackBuilder`：负责组织上下文，不直接执行模型请求。
- `ContextSourceProvider`：读取项目资料、规范、字典和 JIRA 摘要。
- `KnowledgeRetriever`：基于现有索引/关键词能力检索相关片段。
- `ContextCache`：管理按项目/文件版本划分的缓存。
- `ContextBudgeter`：排序、去重和控制注入规模。

具体文件位置遵循仓库现有 package 边界，不要为了抽象而大量搬迁目录。

### 5.2 各层内容

**L0 核心规则**

只包含必须始终生效的规则，例如：遵循项目编码规范、修改前分析现有代码、优先复用现有功能、运行相关测试、禁止输出或记录密钥。把长篇 MES/WMS 产品知识移出 L0。

**L1 项目概览**

包括仓库结构、技术栈、关键模块入口、数据库和构建测试命令等。项目切换时重新加载；同一项目可缓存。

**L2 当前任务**

包括用户当轮输入、JIRA 任务正文、任务附件清单与必要摘要。任务变化必须更新，不能把上一条 JIRA 的要求遗留到下一任务。

**L3 按需知识**

根据任务线索或模型/工具发起的检索，加载相关字典条目、业务规则、接口定义和测试案例。应保留原始来源定位，模型需要时可继续读取原文件。

**L4 历史摘要**

包含当前任务的目标、已确认约束、已修改文件、测试结果、尚未完成事项和关键决策。不要只做普通对话压缩；要保留工程执行状态。

### 5.3 检索与排序

第一阶段先使用现有源码索引、文档索引和关键词搜索。可以按以下信号评分：

- 文件/模块与当前仓库及产品线的匹配程度。
- 任务关键字、业务对象、字段、接口名称的命中程度。
- 文件类型（数据字典、开发规范、接口文档、测试用例等）。
- 来源新鲜度和版本有效性。
- 是否为当前项目明确引用的资料。

不要只按文件名匹配。检索片段需包含来源路径、章节或行号、摘要及必要的原文范围。无法确认相关性的资料不应自动注入。

### 5.4 Context Manifest

建议每轮生成可诊断的上下文清单：

```ts
interface ContextManifestEntry {
  layer: 'core' | 'project' | 'task' | 'knowledge' | 'history';
  sourceId: string;
  sourcePath?: string;
  sourceVersion?: string;
  section?: string;
  startLine?: number;
  endLine?: number;
  charCount: number;
  relevanceScore?: number;
  cacheHit: boolean;
}
```

Manifest 用于诊断和测试，不应将敏感全文写进普通日志。真实类型按项目风格调整。

### 5.5 上下文缓存

缓存分为：

1. **文件读取缓存**：键为规范化路径 + mtime + size；大文件必要时增加内容 hash。
2. **知识检索缓存**：键为 projectId + productLine + query signature + dictionary/index version。
3. **项目概览缓存**：键为 project root + 项目配置版本 + 相关文件版本。
4. **历史摘要缓存**：键为 sessionId + 最近消息版本/最后消息 ID。

失效场景：

- 文件被外部修改或 Agent 修改。
- 项目根目录或分支发生变化（按现有项目身份策略判断）。
- 字典/规范文件版本更新。
- 用户改变产品线或项目上下文。
- JIRA 任务内容或附件发生变化。

禁止跨项目缓存命中。缓存必须提供显式清理能力。不要将 API Key、密码或访问令牌放入上下文缓存。

### 5.6 Token 预算

- 先统计字符数；如 Runtime 有可信 Token 使用数据，使用真实 Token 数据校准。
- 不得把 `字符数 / 4` 等粗略估值显示成真实 Token 用量，只能标注为估算值。
- 预算优先级：核心规则 > 当前任务 > 必要项目背景 > 高相关知识 > 历史摘要。
- 达到预算时，先去重和压缩重复内容，再降低低相关片段数量；不能截断安全规则或当前任务关键约束。
- 被省略的知识片段应保留可检索路径，允许 Codex 通过工具进一步读取。

## 6. 平台工具受控并发设计

### 6.1 适用范围

只优化精工 Agent 自己注册和执行的平台工具。Codex 内建工具、Shell 命令、文件写入、Git 操作、数据库写入、部署命令等，不纳入本次自动并发范围。

### 6.2 工具元数据

建议为平台工具增加可选元数据：

```ts
interface PlatformToolExecutionPolicy {
  readOnly: boolean;
  idempotent: boolean;
  concurrencyGroup?: string;
  cacheTtlMs?: number;
  cacheScope?: 'session' | 'project';
  maxConcurrency?: number;
}
```

默认策略必须保守：未声明的工具视为不可并发、不可缓存。

### 6.3 调度规则

- 只有 `readOnly && idempotent` 的工具可并发。
- 全局并发默认上限 3；单一 `concurrencyGroup` 可设置更低上限。
- 同一资源存在依赖关系时必须串行，例如先获取项目上下文再读取其依赖资料。
- 对同一路径的读取可合并重复请求，但应保证调用方获得一致结果。
- 写操作、删除、文件修改、命令执行、授权变更始终走串行路径。
- 任务取消时，取消尚未开始的队列项；运行中的工具需根据工具本身的取消能力处理。
- 返回值顺序按原始调用 ID 对齐，不应按完成先后改变调用语义。

### 6.4 缓存策略

只对纯只读、幂等、结果确定的查询缓存。缓存键需包含工具名、参数规范化摘要、项目/会话作用域和必要的资源版本。不得缓存用户权限变化前的结果供权限变化后使用。

### 6.5 不建议的实现

- 不要对所有工具统一使用 `Promise.all()`。
- 不要并发执行多个可能修改同一文件的操作。
- 不要并发执行多个 Shell 命令后假定它们有确定顺序。
- 不要吞掉单个工具错误并返回“全部成功”。
- 不要将 Codex 自己的工具调度结果再次包装一层造成双重并发调度。

## 7. 流式输出与 React 渲染优化

### 7.1 数据流

```text
Codex App Server event
    │
    ▼
Main Process Runtime Event Handler
    │  及时接收、解析、持久化关键状态
    ▼
IPC Stream
    │
    ▼
Renderer Stream Store
    │  合并高频文本增量，保留事件顺序
    ▼
Message Component
```

### 7.2 优化策略

- 保持主进程接收和转发实时性，不用固定延迟阻塞 Token。
- 渲染层可使用批处理队列，默认 16～50ms 刷新一次；任务结束/取消/错误时立即 flush。
- 对同一条流式消息做局部更新，避免每个 delta 更新整份消息列表。
- 对工具事件和状态事件按类型更新，避免把所有事件都转成文本渲染。
- 对历史消息使用稳定 key 和必要的 memoization；只有在测量确认存在重渲染问题时再优化组件结构。
- 关闭会话时取消订阅并清空 pending queue，防止事件泄漏到新会话。

### 7.3 完整性要求

测试需比较 Runtime 原始 delta 序列与最终 UI 文本，验证：

- 字符顺序一致。
- 无丢失、无重复。
- Unicode、中文、换行和代码块边界正确。
- 结束事件能够 flush 最后一个增量。
- 快速切换会话不会串消息。

## 8. 性能遥测设计

### 8.1 事件模型

建议统一使用结构化事件，示例：

```ts
interface PerformanceEvent {
  traceId: string;
  sessionId?: string;
  runtimeKind?: string;
  eventName: string;
  timestampMonotonicMs: number;
  durationMs?: number;
  attributes?: Record<string, string | number | boolean | null>;
}
```

`timestampMonotonicMs` 仅用于计算耗时；需要展示日期时另行记录普通时间戳。不要混用系统墙上时间计算持续时间。

### 8.2 关键埋点顺序

```text
user_submit
  -> runtime_lookup_start
  -> runtime_reuse_hit | runtime_spawn_start
  -> app_server_initialized
  -> thread_start_or_resume
  -> context_build_start
  -> context_build_end
  -> turn_start
  -> first_assistant_text_delta
  -> first_ui_render
  -> tool_call_start / tool_call_end (0..n)
  -> turn_completed | turn_failed | turn_cancelled
  -> runtime_idle | runtime_closed
```

埋点名称可以按现有日志规范调整，但必须保留各时间段的可计算性。

### 8.3 TTFT 定义

同时记录两个值，避免概念混淆：

- `ttft_runtime_ms`：用户提交到第一个助手文本 delta 被主进程收到的时间。
- `ttft_ui_ms`：用户提交到第一个助手文本实际显示在渲染层的时间。

工具状态、思考状态、空事件不计为第一个助手文本 Token。

### 8.4 数据存储

优先使用现有日志系统。若需本地持久化：

- 使用独立的诊断记录表或滚动日志，不与业务会话正文混在一起。
- 设置保留天数/最大容量并定期清理。
- 导出前脱敏。
- 默认不上传云端。

### 8.5 诊断导出格式

建议导出单轮 JSON，内容包含：测试环境、应用版本、Runtime 版本、模型标识、配置摘要、任务类别、各阶段耗时、工具耗时汇总、上下文大小和结果状态。不得包含模型密钥、完整提示词、完整客户资料或源代码全文。

## 9. 性能基准测试设计

### 9.1 基线分层

建立两套测试：

**A. Mock/自动化测试**

- 验证生命周期、复用 Key、TTL、并发限制、缓存失效、UI delta 完整性。
- 在 CI 执行，不连接真实模型、不产生 Token 费用。

**B. 真实 Runtime 性能测试**

- 用户主动运行固定任务集。
- 固定模型、服务端点、推理等级、项目快照和任务输入。
- 冷启动和热启动分别测试。
- 每个任务建议至少 5 次，报告 P50/P95、平均值、失败次数。
- 记录测试环境硬件、Windows 版本、应用版本、Runtime 版本和网络条件。

### 9.2 固定任务集

| ID | 任务 | 主要验证点 |
|---|---|---|
| T01 | 根据项目规范回答一个简单问题 | 轻任务、基础 TTFT |
| T02 | 定位指定业务功能的入口和调用链 | 代码搜索、文件读取 |
| T03 | 修改一个小功能并执行关联测试 | 工具链和总耗时 |
| T04 | 根据 MES/WMS 字典分析一个字段的使用位置 | 按需检索、上下文体积 |
| T05 | 同一会话连续两轮不同任务 | 热复用有效性 |
| T06 | 长文本流式输出 | UI 渲染、delta 完整性 |

任务必须具有可检查的完成条件，例如指定文件、指定测试、指定字段位置或人工评审结果。不能只用“模型回答看起来不错”作为唯一标准。

### 9.3 报告指标

- 冷启动 P50 / P95。
- 热复用 P50 / P95。
- Runtime TTFT P50 / P95。
- UI 首屏 P50 / P95。
- Context Build P50 / P95。
- 工具总耗时、调用次数和并发峰值。
- Task Total P50 / P95。
- 输入/输出 Token（仅真实可得时）。
- 失败率、取消率、重试率。
- Runtime 子进程和主进程 CPU/内存（系统可可靠采集时）。

### 9.4 对比口径

0.7 与 0.8 对比时，不能同时更换模型、中转站、推理等级、仓库状态和任务输入。若某项变化无法避免，必须在报告中列为干扰变量。性能提升报告应区分：

- 本地启动等待减少。
- 上下文准备时间减少。
- 模型服务 TTFT 变化。
- 工具执行时间变化。
- UI 首屏和持续渲染变化。

不能把中转站网络改善描述成 Runtime 本身提速。

## 10. 配置设计

配置命名遵循现有配置 schema。下面是逻辑示意：

```ts
interface AgentPerformanceConfig {
  runtimeReuse: {
    enabled: boolean;
    idleTtlMs: number;
    maxIdleInstances: number;
  };
  runtimePrewarm: {
    enabled: boolean;
    onCodexSessionOpen: boolean;
  };
  contextOptimization: {
    enabled: boolean;
    retrievalEnabled: boolean;
    maxContextChars?: number;
    historySummaryEnabled: boolean;
  };
  platformToolExecution: {
    readOnlyConcurrency: number;
    cacheEnabled: boolean;
  };
  streaming: {
    uiFlushIntervalMs: number;
  };
  telemetry: {
    enabled: boolean;
    diagnosticsEnabled: boolean;
  };
}
```

校验建议：

- `idleTtlMs`：建议范围 30 秒～30 分钟，默认 5 分钟。
- `maxIdleInstances`：建议范围 1～5，默认 3。
- `readOnlyConcurrency`：建议范围 1～5，默认 3。
- `uiFlushIntervalMs`：建议范围 16～50ms，默认 30ms。
- 非法值使用默认值并输出脱敏配置警告。

如果现有设置系统不支持这么多配置，本次先把核心选项作为内部常量/Feature Flag 管理，避免为了少量性能参数构建复杂设置页。

## 11. 错误处理与回退

| 异常 | 处理方式 |
|---|---|
| 复用实例已退出 | 标记失效、清理记录、重新创建 Runtime |
| Runtime 初始化超时 | 结束异常进程、记录指标、允许下一次重试 |
| 预热失败 | 释放预热资源，首次请求走普通冷启动 |
| 配置指纹生成失败 | 保守地不复用，不得默认判定兼容 |
| 上下文检索失败 | 回退到现有文件读取/上下文方案，记录错误 |
| 上下文缓存过期 | 丢弃缓存并重新读取 |
| 并发只读工具单项失败 | 保留其他结果并明确标记失败项，不伪装全部成功 |
| 工具取消 | 取消队列，尽可能中止可取消任务，回收资源 |
| UI 批处理异常 | 立即 flush 或回退为逐事件更新，确保文本不丢失 |
| 遥测写入失败 | 不影响任务执行；忽略或写入轻量错误日志 |

## 12. 测试设计

### 12.1 单元测试

- RuntimeReuseKey：每个关键字段变化的命中/未命中测试。
- TTL：未过期可复用、过期清理、LRU 清理。
- 并发：同一会话重复发送、多个会话独立、忙碌实例不可回收。
- 预热：单飞机制、超时、失败回退、应用退出清理。
- Context Builder：分层加载、去重、排序、预算、来源 Manifest。
- Cache：mtime/size/hash 变化后失效；项目作用域隔离。
- Tool Scheduler：并发上限、只读白名单、写操作串行、取消与部分失败。
- Stream Scheduler：事件顺序、完整性、结束 flush、切换会话隔离。
- Telemetry：时间差、traceId 贯穿、脱敏。

### 12.2 集成测试

- Codex 会话连续两轮请求复用同一 App Server 进程。
- 修改模型或项目配置后重新创建实例。
- 预热成功后发送消息无需再次启动进程。
- 预热失败后仍能正常启动。
- 取消任务、关闭会话、退出应用时不残留子进程。
- MES5/MES6/WMS 字典按需加载并且来源可追溯。
- 平台工具并发执行不影响写操作顺序。
- 长文本流式输出与最终持久化消息一致。

### 12.3 回归测试

至少覆盖：

- 新建/恢复/删除会话。
- 切换项目和工作目录。
- 切换模型、Base URL、推理等级。
- Codex 插件启用和禁用。
- Codex 与 Jinggong Runtime 选择及切换。
- Runtime 安装、校验、更新和异常恢复。
- Windows 打包启动和应用升级。

## 13. 实施阶段与建议顺序

### 阶段 0：代码核对与基线（先做）

1. 确认分支、依赖版本和实际工作区状态。
2. 梳理 Runtime 创建、发送、完成、复用、关闭完整调用链。
3. 画出 `sessionId -> Runtime instance -> App Server process -> Thread ID` 的关系。
4. 运行现有测试并记录结果。
5. 建立 T01～T06 的 0.7 基线；若暂时无法运行真实模型，先把自动化测试和遥测框架完成，并明确标记真实基线缺失。

**阶段交付：** 当前代码映射表、风险列表、基线报告。

### 阶段 1：Runtime 复用与预热（P0）

1. 收敛 Runtime 生命周期管理入口。
2. 补齐兼容 Key 和安全指纹。
3. 完成同会话空闲复用、TTL、LRU 和资源清理。
4. 增加后台 App Server 预热。
5. 补充异常退出、并发发送和关闭场景测试。

**阶段交付：** 可运行的 Runtime 生命周期优化和测试。

### 阶段 2：遥测与性能基准（P0）

1. 增加统一 traceId 和阶段时间戳。
2. 记录启动、上下文、TTFT、工具和总耗时。
3. 将真实性能测试与 Mock CI 测试分离。
4. 输出 0.7 / 0.8 对比报告。

**阶段交付：** 可定位性能瓶颈的数据链路。

### 阶段 3：上下文按需加载（P0）

1. 梳理现有开发者指令、字典、JIRA 内容和历史摘要组装入口。
2. 设计 Context Manifest 与层级结构。
3. 将大体量字典改为检索加载。
4. 加入缓存失效、来源追溯和预算控制。
5. 使用 T04 验证正确率和上下文规模。

**阶段交付：** 上下文优化与效果对比。

### 阶段 4：工具并发和流式 UI（P1）

1. 工具增加安全元数据。
2. 实现只读工具限流调度及安全缓存。
3. 流式 UI 按批次局部刷新。
4. 补齐取消、错误和完整性测试。

**阶段交付：** 平台工具及交互层优化。

### 阶段 5：发布验证

1. 完成 Windows 安装包、升级、退出清理和数据兼容验证。
2. 检查开关和回退路径。
3. 输出测试与性能报告。
4. 更新 README、版本说明和开发文档。

## 14. 代码修改边界建议

建议优先沿用现有目录和模块，不要求严格新增下列文件名；Codex 应先看当前代码结构再决定：

| 能力 | 推荐代码归属 |
|---|---|
| Runtime 生命周期、TTL、实例回收 | `apps/desktop/src/main/session-runtimes.ts` 或现有 Runtime 管理模块 |
| Runtime 兼容性指纹 | `apps/desktop/src/main/runtime-reuse.ts` |
| 主进程会话调度 | `apps/desktop/src/main/index.ts` 或现有会话服务 |
| 预热协调 | 现有 `runtime-prewarm` 相关模块，或新增独立 App Server Prewarm Service |
| 上下文组装 | 当前 RuntimeOptions / developer instructions / dictionary context 相关模块 |
| 平台工具并发 | 现有平台工具注册和执行层，不修改 Codex 内部调度 |
| 流式 UI | Renderer 的事件订阅、消息 Store 和消息组件 |
| 性能指标 | 现有日志/诊断基础设施；避免建立第二套日志体系 |
| 测试 | 现有 `tests/` 测试结构和脚本规范 |

## 15. 实施时禁止事项

- 禁止以“提高性能”为理由直接把 `multi_agent` / `multi_agent_v2` 改成 `true`。
- 禁止在未证明隔离的情况下跨会话共用 Runtime Thread 或上下文。
- 禁止将 API Key、客户数据或完整提示词写入性能日志。
- 禁止对所有平台工具使用无差别并发。
- 禁止把 Shell、文件写入、数据库修改、Git 写操作或部署纳入只读并发。
- 禁止为了预热发送真实模型生成请求。
- 禁止把字符数估算标成真实 Token 数。
- 禁止把预热服务描述为模型推理预热。
- 禁止在本迭代混入 Codex 上游版本升级、协议更换或模型服务商迁移。
- 禁止只提交“性能看起来更快”的主观结论；必须附基准数据和测试条件。

## 16. Codex 开发执行提示

把本文件和需求规格说明书一并交给 Codex，要求它按以下流程执行：

1. 先检查当前仓库状态和代码，不要立即改代码。
2. 输出“现状能力 / 需求缺口 / 影响文件 / 风险 / 实施顺序”映射表。
3. 先完成阶段 0，并运行现有测试。
4. 按阶段 1 至阶段 5 实施，每个阶段完成后执行相关测试并汇报。
5. 不确定 App Server 是否允许某种预热或复用方式时，先通过当前依赖源码、类型定义和测试验证，不得猜测 API。
6. 遇到需求与当前代码冲突时，优先保证会话隔离、数据正确和可回滚，并说明调整点。
7. 不得只输出方案；要完成代码实现、自动化测试、类型检查、Lint 和构建。
8. 最终交付：变更清单、关键实现说明、测试结果、性能对比、遗留风险和 0.8.0 发布说明。


# 精工 Agent 0.9.8：P0–P1 开发包说明

> 文档基线：2026-11-25  
> 代码基线：`zhuangxiaolong/jg_agent` / `develop/desktop-poc` / README 标注版本 `0.9.7`  
> 当前 Codex 运行时：仓库固定 `CODEX_RUNTIME_VERSION = 0.156.1`，`package.json` 中 `@openai/codex = 0.156.1`

## 1. 本开发包的目标

在不重写 Codex Runtime、不替换现有精工 Runtime、不推翻精工专家中心和现有任务治理的前提下，完成四项能力：

| 优先级 | 模块 | 目标 |
|---|---|---|
| P0 | Codex 原生 Multi-Agent | 启用固定版本 Codex App Server 的原生 Multi-Agent V2 |
| P0 | 专家与原生 Agent 协作 | 精工专家负责专业路由和工作方法，Codex 原生子 Agent 负责独立分析协作 |
| P1 | MES/WMS 项目上下文检索 2.0 | 提高项目资料、字典、手册、代码、记忆和决策的命中率与证据质量 |
| P1 | Codex 原生 Skills 集成 | 把精工 Skill 管理、专家标签、可信校验和 Codex 原生 Skill 运行打通 |

## 2. 当前代码基线与关键事实

本方案依据以下实际代码结构制定，Codex 开发前必须重新读取当前分支文件，确认没有发生路径或实现变动：

| 现有模块 | 主要位置 | 当前职责 |
|---|---|---|
| Codex Runtime | `packages/agent-runtime/src/index.ts` | `CodexRuntime`、App Server JSON-RPC、`thread/start`、`turn/start`、动态工具、运行时事件 |
| Runtime 适配器 | `packages/agent-runtime/src/manager.ts` | Codex、Jinggong、Claude 等 Runtime 适配器 |
| Runtime 创建与会话发送 | `apps/desktop/src/main/index.ts` | `getRuntime()`、`runtimeOptions`、专家选择、上下文构建、运行时复用 |
| Runtime 复用 | `apps/desktop/src/main/runtime-reuse.ts` | Codex 进程身份指纹与复用键 |
| Codex 预热 | `apps/desktop/src/main/codex-app-server-prewarm.ts` | App Server 初始化预热，不创建 Thread、不发送模型请求 |
| 精工任务编排 | `apps/desktop/src/main/agent-orchestration.ts` | `platform_agent_*` 平台工具，创建/等待/取消治理型子任务 |
| 精工任务执行 | `apps/desktop/src/main/agent-tasks.ts` | `AgentTaskRunner`、任务契约、受控分析 Runtime、只读证据与审计 |
| 专家引擎 | `packages/expert-engine/src/index.ts` | `resolveExpert()`、内置专家、`expertInstructions()` |
| 专家中心 | `apps/desktop/src/main/expert-center.ts` | 专家档案、会话选择、运行记录、评测与反馈 |
| 插件/Skill 管理 | `apps/desktop/src/main/plugin-manager.ts` | 插件导入、信任、Skill 版本、范围、Codex Profile 同步、Jinggong Skill Loader |
| Skill 匹配 | `packages/plugin-manager/src/skill-matcher.ts` | `matchSkills()` 关键词/标签匹配 |
| Skill 兼容性 | `packages/domain/src/skill-intelligence.ts` | 当前 Codex Skill 兼容状态标为 `Partial`，Jinggong 标为 `Full` |
| 上下文候选 | `apps/desktop/src/main/context-sources.ts` | 用户记忆、项目字典、操作手册候选 |
| 上下文排序 | `packages/performance/src/context-retrieval.ts` | `ContextRetrievalPlanner`、来源过滤、排序、去重和数量上限 |
| 上下文优化 | `apps/desktop/src/main/performance-service.ts` | 工作区索引检索、上下文预算、缓存、可解释统计 |
| 工作区代码索引 | `packages/performance/src/workspace-index.ts` | 本地增量索引、Git 文件范围、文件 Hash、关键词候选和片段返回 |
| 项目上下文 | `apps/desktop/src/main/iteration-ipc.ts` | `assembleProjectContext()`、项目资源、已确认事实与决策 |

当前 Codex Runtime 配置在 `runtimeConfigOverrides()` 中显式关闭：

- `features.multi_agent = false`
- `features.multi_agent_v2 = false`

当前 `package.json` 与 `packages/agent-runtime/src/index.ts` 固定 Codex 版本均为 `0.156.1`。开发必须以该版本的配置 Schema 和实际 App Server 行为为准，不得把其他产品的 API 参数直接套用进来。

## 3. 必须遵守的架构原则

### 3.1 不重复造 Codex

Codex Runtime 继续使用本机固定版本的 Codex App Server。不得用 Responses API 手工再写一套主 Agent 循环，不得新建另一套 native `spawn_agent` RPC 调度器，也不得复制 Codex 的工具调用、Thread 管理和模型请求循环。

### 3.2 两种子 Agent 机制分工，不得重复调度

精工目前已经有一套治理型任务系统：`AgentTaskRunner` + `platform_agent_*`。它提供任务契约、预算、审计、只读工具网关、状态转换与重试治理，不应删除。

新增 Codex 原生 Multi-Agent 后，必须提供互斥的委派模式：

| 委派模式 | 适用 Runtime | 使用方式 | 是否注入 `platform_agent_*` |
|---|---|---|---|
| `native` | Codex | Codex 原生 Multi-Agent V2 | 否 |
| `governed` | Codex / Jinggong / Claude 中当前已有支持的模式 | 精工 `AgentTaskRunner` 治理型任务 | 是，仅在具备完整 Provider 时 |
| `off` | Codex | 不允许拆分子 Agent，由主 Agent 完成 | 否 |

Codex 会话默认使用 `native`；用户可以切换为 `governed` 或 `off`。非 Codex Runtime 保留现有行为，不做无关迁移。

**同一会话的同一轮任务，只允许一种委派体系接管。** `native` 模式不能再由 `inferAutomaticAgentTaskPlan()` 自动创建重复的精工子任务，也不能向模型同时暴露 `platform_agent_create_task` 等工具。

### 3.3 原生子 Agent 第一阶段只做并行分析

当前 Codex 会话使用 `danger-full-access`，没有 Windows 原生 OS 沙箱。P0 第一阶段的原生子 Agent 默认承担需求分析、架构分析、代码定位、测试设计和代码审查等只读分析工作；主 Agent 统一负责文件修改、构建、测试、Git 提交。

只读要求目前主要由 Agent 指令约束，不要虚称已对 Codex 原生子 Agent 建立系统级只读隔离。任何后续让子 Agent 直接修改代码的能力，必须单独设计 Worktree 隔离、文件冲突处理和验证责任，不属于本次 P0。

### 3.4 可信知识与代码权限分离

项目资料、Jira、数据字典、操作手册、Skill 正文和检索片段均是业务证据，不得因为其内容写着“请执行某操作”就自动扩大权限。项目范围、系统范围、产品版本、来源 Hash、可信状态必须继续校验。

### 3.5 检索必须可解释、可退化

所有可选上下文必须保留来源、版本、Hash、命中理由、范围和预算信息。索引不可用、Skill 不兼容或手册读取失败时，应降级回现有安全路径并明确记录，不能静默伪装为已检索或已加载。

## 4. 建议实施顺序

不要并行让多个 Codex 子 Agent 修改同一核心文件。按下面顺序实施，每一阶段完成构建和针对性测试后再进入下一阶段。

| 阶段 | 内容 | 依赖 | 主要验收 |
|---|---|---|---|
| 0 | 代码盘点与现有测试基线 | 无 | 记录现有 Runtime 配置、关键调用链和测试结果 |
| 1 | P0-1 原生 Multi-Agent V2 启用与能力检测 | 阶段 0 | Codex App Server 可启动，原生子 Agent 可真实创建、等待、结束 |
| 2 | P0-2 委派模式互斥与精工专家协作 | 阶段 1 | native / governed / off 三种模式互斥，专家能指导原生协作 |
| 3 | P1-1 上下文检索 2.0 | 阶段 0 | 多来源命中、项目隔离、版本/Hash 校验、预算和解释正常 |
| 4 | P1-2 Codex Skills 与专家中心打通 | 阶段 2、3 | Codex 原生识别并使用已授权 Skill，专家记录真实来源 |
| 5 | 完整回归与安装包验证 | 阶段 1–4 | 全量测试、桌面冒烟、安装包 Runtime 探测 |

建议开发过程中使用独立分支或分阶段提交；禁止将未验证的中间代码直接发布为正式安装包。

## 5. 交付文件清单

1. `P0_原生Multi-Agent与专家协作_需求技术方案.md`：P0 功能需求、配置、架构、流程、模式互斥、安全边界和验收。
2. `P1_MES-WMS智能上下文检索2.0_需求技术方案.md`：多来源检索、检索评分、分段、预算、缓存、可解释性和回退策略。
3. `P1_Codex原生Skills与专家中心打通_需求技术方案.md`：Codex 原生 Skill、插件快照、专家标签匹配、可信验证和使用记录。
4. `Codex_分阶段开发总指令.md`：可直接交给 Codex 的执行总提示词。
5. `验收测试矩阵.md`：关键功能、回归、安全和性能验收项目。

## 6. 总体完成标准

- 不修改或替换 Codex 官方执行引擎；保持 `CODEX_RUNTIME_VERSION` 与 `@openai/codex` 版本一致。
- 不破坏 Jinggong Runtime、Claude Runtime、Grok Build Runtime 及现有 Codex 直连模型中转配置。
- 新旧会话均可恢复；旧 SQLite 数据自动迁移且不丢失历史记录、专家档案、插件、Skill、项目资料和会话状态。
- native / governed / off 不会混用或重复创建同轮任务。
- 专家能力不会覆盖项目开发规范、权限设置和任务契约。
- 上下文不跨项目、不跨系统、不混用 MES5/MES6；所有可选资料均有来源说明。
- 只有真实确认 Codex 加载了 Skill 才能记为“已加载”；仅推荐、仅注入 Skill 元数据或仅同步插件不得计作已使用。
- `npm run build`、`npm test`、`npm run test:runtime-contract`、`npm run test:desktop` 按项目现有可运行情况通过；不可运行项必须报告具体原因和未验证边界。

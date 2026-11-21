# 精工 Agent 0.9.0 需求文档

## Autonomous Multi-Agent Orchestration：基于现有 Subagents 的自主协作闭环

- 版本：0.9.0
- 文档类型：产品需求文档（PRD）
- 适用分支：`develop/desktop-poc`
- 需求基线 Commit：`ee5a9e36e7aaaba53e4a08aa36a6ffc23373c224`
- 基线核对日期：2026-11-19
- 目标平台：Windows 桌面端（Electron）
- 主要 Runtime：Codex Runtime、Jinggong Runtime
- 实施原则：扩展现有 AgentTask / AgentTaskRunner / Orchestrator / Task Engineering / Worktree，不另起一套多 Agent 子系统。

---

## 1. 项目背景与版本定位

精工 Agent 当前已经拥有可运行的 Subagents 基础设施。本版本不是重新建设 Agent 管理平台，而是在现有基础上补齐“主 Agent 自主委派—子 Agent 执行—状态与证据回传—主 Agent 决策—必要时返工”的协作闭环。

0.9.0 的核心目标是让主 Agent 能够在一次开发任务中按需调用平台已有子 Agent，不再完全依赖主进程在发送模型请求前通过关键词规则拆分任务。主 Agent 应能够决定是否委派、委派哪些工作面、等待或检查结果、根据结果追加修订任务，并负责最终整合和真实验证。

### 1.1 当前代码基线（必须先复用）

以下能力已经存在，Codex 不得按新模块重建：

| 现有能力 | 当前代码 | 0.9.0 处理方式 |
|---|---|---|
| AgentTask 数据模型、角色、父子关系、状态、结果 | `packages/domain/src/index.ts` | 扩展必要字段，不创建第二套 Task 模型 |
| Task Contract、预算、生命周期、证据模型 | `packages/domain/src/engineering.ts` | 继续复用 |
| DAG 校验、依赖状态、并发槽位 | `packages/agent-orchestrator/src/index.ts` | 继续复用并补测试 |
| Runtime 能力矩阵和治理门禁 | `packages/agent-orchestrator/src/runtime-capabilities.ts`、`governance.ts` | 修正能力认证与实测状态，不绕过门禁 |
| 子任务 Runtime 启动、调度、超时、取消、重试、事件 | `apps/desktop/src/main/agent-tasks.ts` | 扩展现有 Runner，不另建 Runner |
| 主进程任务 IPC、自动规则拆分流程 | `apps/desktop/src/main/index.ts` | 增加主 Agent 内部工具入口，调整旧自动拆分流程 |
| 任务持久化、审计、乐观并发控制 | `packages/storage/src/index.ts` | 通过迁移增量扩展 |
| 任务契约、真实验证、人工验收 | `apps/desktop/src/main/task-engineering.ts` | 继续复用 |
| Worktree 创建、映射、差异检查、集成预检 | `packages/git-connector/src/task-workspace.ts`、`apps/desktop/src/main/task-workspaces.ts` | 补齐写入执行前置与工作树差异闭环 |
| 子 Agent 任务面板 | `apps/desktop/src/renderer/AgentTasksPanel.tsx` | 在现有面板上增强，不重新设计整套 UI |
| TaskWorkspace / TaskEngineering UI | `TaskWorkspacePanel.tsx`、`TaskEngineeringPanel.tsx` | 继续复用 |

### 1.2 当前已存在但不能视为已完成的能力

1. 当前存在 `inferAutomaticAgentTaskPlan()`，可以根据关键词自动生成最多 3 个只读分析工作面；这属于规则驱动的预先拆分，不等于主 Agent 自主委派。
2. 当前 `sendSessionTurn` 会先等待自动生成的子 Agent 结束，再将摘要追加给主 Agent。它不是主 Agent 在执行过程中动态创建、查询和管理 Agent。
3. 当前新契约任务在 `runtime-capabilities.ts` 中因 `controlledGovernanceValidated = false` 而无法通过严格治理门禁；`automaticAgentTaskAvailability()` 会拒绝自动委派。不能通过把常量改为 `true` 来假装完成。
4. 当前 `ControlledAnalysisRuntime` 已有平台 Responses 请求循环、模型请求预算回调、工具网关及只读文件/字典工具，但能力认证仍保持未通过状态，必须补齐自动化和真实环境验证。
5. 当前 Worktree 能创建、检查和生成集成预检，但 `AgentTaskRunner.buildRuntime()` 与执行入口明确拒绝 `workspaceMode='worktree'`；主进程手动创建任务 IPC 也拒绝 Worktree 模式。
6. 当前 Worktree 集成预检要求已提交成果且源工作区 clean；这与“Agent 不应未经用户要求自动 commit”的现有执行要求存在冲突，0.9.0 必须设计可审查的未提交变更快照，不得擅自自动提交或推送。
7. Codex `features.multi_agent` 和 `features.multi_agent_v2` 当前关闭。本版本不默认依赖 Codex 原生多 Agent，也不将上游能力当作精工 Agent 已接入能力。

---

## 2. 产品目标

### 2.1 核心目标

- 主 Agent 可通过平台提供的受控动态工具创建、查询、等待、取消和要求修订子任务。
- 子 Agent 继续由平台 AgentTaskRunner 启动独立 Runtime 会话，保持独立上下文和独立任务预算。
- 任务状态、工具调用、预算消耗、证据和失败原因均由平台记录，不允许模型自行伪造。
- 主 Agent 能够根据真实任务结果进行下一步决策，而不是仅在初始阶段收取一份静态摘要。
- 现有 Task Contract、TaskEvidence、TaskWorkspace、Verification Service 和人工验收流程保持统一。
- Runtime 能力不满足要求时失败关闭，UI 明确显示不支持/未认证，不绕过治理。

### 2.2 成功标准

一个典型开发任务可以按以下流程运行：

1. 用户向主 Agent 提出 MES/WMS 开发任务。
2. 主 Agent 分析任务，判断是否值得委派。
3. 主 Agent 调用 `create_agent_task` 创建需求分析、影响分析或测试分析任务。
4. 平台根据默认预算、权限、上下文和 Runtime 能力创建 Task Contract，并将任务交给现有 AgentTaskRunner。
5. 多个子 Agent 按 DAG 和并发上限独立执行。
6. 主 Agent 通过 `get_agent_task`、`list_agent_tasks`、`wait_agent_tasks` 获取真实结果。
7. 主 Agent 发现结果不完整时调用 `request_task_revision` 创建修订任务，或者补充任务继续分析。
8. 主 Agent 完成代码实现和验证；只有真实验证证据通过，才可报告构建/测试通过。
9. 用户可以在现有子 Agent 面板中查看任务树、状态、事件、结果、预算和证据。

### 2.3 不作为 0.9.0 目标

- 不重建 Agent Registry、Agent Definition Market、独立 Agent Session、Message Bus 或全新任务数据库。
- 不启用 Codex 原生 `features.multi_agent` / `multi_agent_v2` 作为平台主方案。
- 不把 Claude Agent SDK 或 Grok Build ACP 宣称为已支持自主子 Agent；未完成能力认证时明确不可用。
- 不支持子 Agent 无限递归创建子 Agent。0.9.0 默认只有主会话主 Agent 可以委派；嵌套委派作为后续版本。
- 不自动 Git push、PR、merge、部署或发布。
- 不自动将模型输出中的“测试通过”当作验证证据。
- 不将未知 Token/成本统计估算成真实值。
- 不因 0.9.0 而重构整个桌面端 IDE 界面；本版本只改造子 Agent 面板必要区域。

---

## 3. 用户角色与使用场景

### 3.1 用户角色

- 开发人员：通过主 Agent 处理 MES/WMS 项目代码、接口、业务规则和测试任务。
- 技术负责人：查看任务拆分、Agent 执行状态、风险、代码差异和测试证据。
- 平台管理员：配置 Runtime、模型供应商、项目开发规范和任务预算。

### 3.2 核心场景

**场景 A：复杂任务自动委派**

用户：“MES 增加工序完工校验，检查是否影响报工、物料消耗和工单状态。”

主 Agent 可自行创建需求/业务影响分析 Agent、代码链路分析 Agent、测试范围分析 Agent，并在结果返回后决定开发方式。

**场景 B：按需查询，不必每次阻塞等待**

主 Agent 创建任务后可继续分析其他内容；必要时短时间等待任务状态，未完成则稍后再次查询。等待超时不得自动取消子 Agent。

**场景 C：修订不合格结果**

主 Agent 发现分析任务缺少证据路径，可创建一个修订任务，引用原任务结果与缺失项，形成可追踪的父子任务关系。

**场景 D：写入型 Agent 隔离开发（P1，受门禁控制）**

在受控开发 Runtime、Worktree 文件写入和命令执行边界经过验证后，主 Agent 可创建独立 Worktree 开发任务。不同写入 Agent 不共享可写工作目录，成果先以 Diff/快照形式展示，用户审核后才可集成。

---

## 4. 版本范围与优先级

### P0：受控只读子 Agent 自主委派闭环（0.9.0 必须完成）

| 编号 | 需求 | 验收重点 |
|---|---|---|
| P0-01 | 主 Runtime 动态工具扩展 | `thread/start` 与 `thread/resume` 均正确注册平台工具；工具调用能路由至主进程服务 |
| P0-02 | 主 Agent 委派工具 | 支持创建、查询、列表、等待、取消、修订任务 |
| P0-03 | 复用 AgentTaskRunner | 所有任务仍由现有 Runner 调度，禁止新增第二套任务执行器 |
| P0-04 | 运行时能力认证 | 受控分析必须通过模型请求、工具权限、请求预算和数据隔离测试；未通过则不可启动 |
| P0-05 | Task Contract 自动生成 | 服务端生成预算、权限、Allowed/Denied Paths、Runtime 选择及验收条件；模型不得自行提高权限 |
| P0-06 | Orchestration Run 关联 | 子任务可关联当前主会话/主轮次，支持按本轮筛选和取消 |
| P0-07 | 非破坏性等待 | 等待超时返回当前状态，不取消任务、不重置任务状态 |
| P0-08 | 结构化结果 | 分析结论、证据文件、风险、未解决项经平台 Schema 校验后持久化 |
| P0-09 | 修订任务 | 可创建引用原任务的修订子任务，保留原任务和审计历史 |
| P0-10 | 面板增强 | 显示本轮任务分组、父子关系、等待/执行/失败/阻塞状态、结果与证据 |
| P0-11 | 旧自动规划兼容 | 旧规则拆分不与主 Agent 新工具重复执行；提供开关和回退策略 |
| P0-12 | 取消与恢复 | 主轮次取消时取消其未完成任务；进程中断不自动重放结果未知的工具调用 |

**P0 限制**：所有自动委派子 Agent 仅开放只读项目文件与字典工具，不执行 Shell、不写入文件、不访问网络、不运行 Git 命令。写入型 Agent 不得伪装成只读能力开放。

### P1：隔离写入型 Agent（通过独立门禁后启用）

| 编号 | 需求 | 验收重点 |
|---|---|---|
| P1-01 | Worktree 执行链路 | 创建 Task Worktree 后，将 Runtime cwd 与任务绑定目录一致 |
| P1-02 | 受控开发 Runtime | 文件读写、删除、命令执行均由平台工具注册和网关控制，不直接开放任意 Shell |
| P1-03 | 命令白名单 | 仅允许项目登记/用户确认的构建、测试、代码生成命令；禁止任意可执行文件与参数绕过 |
| P1-04 | 多写 Agent 隔离 | 不同任务使用不同 Worktree，验证仓库身份、路径、链接和分支映射 |
| P1-05 | 未提交变更快照 | 支持 tracked、untracked、staged、unstaged 变更的真实 Diff 和内容指纹；不要求 Agent 自动 commit |
| P1-06 | 集成审批 | 预检后必须由用户确认；执行集成前重新检查源/目标指纹、HEAD、dirty 状态和冲突 |
| P1-07 | 验证证据 | 使用 Verification Service 的真实进程退出码、报告和代码指纹 |
| P1-08 | 失败保留 | 任务取消/失败/预检阻塞时保留 Worktree 和审计，不自动删除 |

P1 的写入执行必须由单独的 `controlled_development` 能力认证放行。不可因为 `worktree_support=true` 就推断 Runtime 具备安全写入能力。

---

## 5. 主 Agent 工具需求

### 5.1 工具列表

工具由主 Runtime 在会话启动/恢复时注册，仅对主会话主 Agent 开放。子 Agent 默认不注册委派工具，防止递归创建和预算绕过。

| 工具名 | 用途 | 核心参数 | 返回内容 |
|---|---|---|---|
| `create_agent_task` | 创建子 Agent 任务 | `name`、`role`、`description`、`input`、`dependencyIds`、`outputExpectations`、`acceptanceCriteria` | `taskId`、任务状态、实际 Runtime 能力摘要 |
| `list_agent_tasks` | 查询本轮任务列表 | 可选状态筛选 | 任务 ID、名称、角色、状态、父任务、简要结果 |
| `get_agent_task` | 查询单个任务 | `taskId` | 状态、结果、错误、预算摘要、证据引用、最近事件摘要 |
| `wait_agent_tasks` | 等待一组任务短时间更新 | `taskIds`、`waitMs` | 已终态任务与仍运行任务的快照 |
| `cancel_agent_task` | 取消子任务 | `taskId` | 真实取消结果和最终状态 |
| `request_task_revision` | 对已完成/失败任务发起修订 | `taskId`、`revisionGoal`、`missingEvidence` | 新修订任务 ID、父子关系、依赖关系 |

### 5.2 工具安全约束

1. 工具参数不得包含 `requiredPermission`、`allowedTools`、`allowedPaths`、API Key、Runtime home、任意 workspace path、执行文件路径或可提高预算的字段。
2. `sessionId`、`projectId`、`orchestrationId`、模型配置、Runtime 类型、Task Contract 权限和预算由主进程根据当前会话及项目设置生成。
3. `create_agent_task` 的 P0 `workspaceMode` 固定为 `read`。模型请求 Worktree 模式时必须拒绝或返回明确不支持，不允许静默降权后仍报告写入任务已创建。
4. 只能查询当前 Session 与当前 Orchestration Run 下的任务；不得通过传入外部 taskId 跨项目查询。
5. 通过主进程验证当前活动 Run Ticket、Runtime threadId、turnId 和工具 requestId；过期轮次的调用必须拒绝。
6. 所有工具调用进入平台审计；请求参数只保存规范化 Hash 与必要的非敏感元数据，不把完整敏感内容写入日志。
7. 工具执行失败必须返回可识别错误码；不能将阻塞、超时或未知结果包装成成功。

### 5.3 `wait_agent_tasks` 的等待语义

- `waitMs` 默认 15 秒，允许范围 0–90 秒。
- 等待超时仅返回当前状态，不取消任务。
- 不得直接复用当前 `AgentTaskRunner.waitForTasks()` 的超时取消语义而不做调整；现有方法会在超时后取消剩余任务。
- 可新增 `waitForTaskUpdates()` 或同等非破坏性 API；内部可复用 Task Waiters / EventEmitter。
- 任务完成、失败、取消、阻塞或进程恢复时唤醒等待者。
- 禁止主 Agent 无限等待。模型应根据返回状态决定后续操作。

### 5.4 修订语义

- P0 通过创建新的 revision AgentTask 实现，不覆盖原 Task Result、不清空旧审计。
- 修订任务 `parentTaskId` 指向原任务；`dependencyIds` 至少包含原任务 ID；输入引用原任务的结构化结果及用户/主 Agent 指定的缺失项。
- 原任务状态和证据保持不变；修订任务使用独立 Task Contract 和新的预算。
- 当前不要求实现运行中即时 steer；如后续支持，必须使用 RuntimeAdapter 明确的 `steerTurn` 能力并增加独立测试，不得把新任务伪装为旧任务继续运行。

---

## 6. 任务策略与运行边界

### 6.1 默认 Agent 角色

继续复用现有 `AgentTaskRole`：

- `requirement`：需求与验收条件分析。
- `architecture`：技术架构、数据和调用链影响分析。
- `developer`：P0 仅做代码定位/影响分析；P1 才允许隔离写入。
- `review`：风险、规范和兼容性分析。
- `testing`：测试范围和已有测试覆盖分析；P1 才可运行已登记命令。
- `documentation`：开发文档和变更说明分析。
- `custom`：受限自定义任务。

### 6.2 上下文

公共上下文只包含当前项目必要信息、对应产品系统、已启用开发规范、已授权字典和明确引用的项目知识。私有上下文包含当前 Task Contract、任务输入、该子 Agent 自己的事件与结果。

禁止将主 Agent 全部聊天历史复制给子 Agent；禁止将其他项目的记忆、文件、凭据和会话混入当前任务。

### 6.3 并发和预算

- 保留全局最大并发 3 的硬上限，0.9.0 不因 UI 配置放大该上限。
- 继续使用当前项目/父任务/子任务预算继承规则，取更严格的有效预算。
- 每个子任务独立计时、模型请求计数、工具调用计数和重试次数。
- 对 Token/费用：只有 Runtime 或供应商提供真实可核验 usage 才采集；当前不可获得的指标继续显示 `unknown`。
- 同一项目的并发数同时受 Runner 全局上限和项目预算约束。
- 限流、网络错误使用已有分类重试规则；不得自动重放已提交的模型轮次或存在未知副作用的工具调用。

### 6.4 Runtime 支持矩阵

| Runtime | 0.9.0 P0 委派 | 说明 |
|---|---|---|
| Codex Runtime | 受控分析认证通过后支持 | 使用平台 AgentTask 管理子任务；不依赖原生 multi-agent |
| Jinggong Runtime | 受控分析认证通过后支持 | 复用现有 Codex Runtime/App Server 适配和平台 Orchestrator |
| Claude Agent SDK | 暂不支持 | 当前不具备相同的受控工具/模型请求预算边界，不得假装可用 |
| Grok Build ACP | 暂不支持 | 当前能力矩阵明确不支持严格工具权限拦截和模型请求拦截 |

Runtime 能力必须同时展示“代码声明能力”和“实际认证结果”。认证状态至少有 `not_run`、`passed`、`failed`、`unsupported`、`unknown`，不得仅凭代码里有 Adapter 就标记通过。

---

## 7. UI 需求

沿用现有右侧 AgentTasksPanel，不新增重复的任务中心。

P0 必须展示：

1. 当前主会话/本轮 Orchestration Run 的任务分组。
2. 子任务名称、角色、状态、Runtime、模型、运行时间、尝试次数。
3. `parentTaskId` 父子任务层级；修订任务显示“修订自任务 X”。
4. DAG 依赖关系与等待原因。
5. 当前任务结果、结构化结论、证据文件路径、风险和未解决项。
6. 预算上限、已消耗模型请求/工具调用、Token/费用未知状态。
7. Runtime 能力门禁阻塞原因和实测状态。
8. 单任务取消、本轮任务取消；取消后保留审计。
9. 旧自动规则拆分与新主 Agent 动态委派不得重复展示或重复执行。

P1 增加：

- Worktree 路径、分支、冻结基准、稳定性状态。
- 变更文件 Diff、文件级审核、潜在冲突项。
- 集成预检和人工批准入口。
- 测试执行记录、报告引用和代码指纹。

UI 不得展示隐藏推理、模型内部思考或未被 Runtime 公开的“Agent 正在思考”伪状态。进度必须来自真实 Task/Runtime 事件。

---

## 8. 验收标准

### 8.1 P0 功能验收

- 主 Agent 在一次会话中可以调用 `create_agent_task`，平台生成 Task/Contract 并进入现有 Runner。
- 同一轮创建 2–3 个独立子 Agent 时，实际并发不超过 3；依赖不满足的任务不会提前执行。
- 主 Agent 可在任务运行期间查询状态和事件；等待超时不会取消任务。
- 主 Agent 可取消单个任务；取消父会话主轮次时，本轮未完成子任务会被取消或按明确策略中断。
- 主 Agent 可针对已完成任务创建修订任务，原任务及其证据不可变。
- 所有 Task 均保留项目/会话隔离、Task Contract、预算、审计和状态版本检查。
- 当前 Runtime 能力认证失败时，不创建或启动受控子 Agent；状态明确为 BLOCKED/UNSUPPORTED，attempt 不增加。
- 自动规则规划与模型动态委派不会对同一轮重复创建同类任务。

### 8.2 P0 安全与真实性验收

- 模型发起未注册工具、写入工具、Shell、网络、插件或未知工具时必须被拒绝。
- 工具调用跨 session、project、thread、turn 或已结束 Run Ticket 时必须被拒绝。
- 所有模型 HTTP 请求均经过 `modelRequestGateway`，预算预留发生在真实发送前。
- 预算超限后请求不发送，工具调用不执行。
- 中断后结果未知的调用被标记 `unknown_outcome`，恢复不得重放。
- SSE 在完成事件前断流不能判定完成。
- 真实 Token/费用不可用时保持 unknown。
- 真实测试/构建没有执行时，结果不得标记验证通过。

### 8.3 P1 写入型 Agent 验收

- `workspaceMode='worktree'` 仅在 controlled-development 认证通过时可创建和调度。
- Agent 的工作目录必须等于平台为该 task 创建并验证过的 Task Worktree 路径。
- 写入工具只能访问该 Worktree 下 Contract 允许路径；拒绝路径穿越、符号链接、junction、硬链接和特殊文件绕过。
- 不提供任意 Shell；命令必须使用预登记命令 ID/参数 Schema，并由主进程在 Worktree cwd 下以 `shell:false` 执行。
- 多个写 Agent 不得共享同一个可写目录。
- 子 Agent 不得 push、merge、部署或操作父会话工作区。
- Worktree 差异支持未提交文件快照，不要求 Agent 自动 commit。
- 集成必须人工批准并在执行前重新校验两侧状态指纹；禁止自动 merge/push。
- 失败、取消或预检阻塞时保留工作区和证据，不清理现场。

### 8.4 测试要求

- 单元测试：工具 Schema、范围校验、DAG、Revision、等待语义、预算、状态转换、结果 Schema。
- 集成测试：主 Runtime 工具注册/恢复/工具回调、Orchestration Service、AgentTaskRunner 和 SQLite。
- ControlledAnalysisRuntime：Fake Fetch 覆盖 JSON/SSE、断流、HTTP 429/500、Abort、重复 call_id、非法 JSON、未知工具和超预算。
- 真实 Runtime Smoke Test：针对每种供应商/模型/backend 运行最小只读工具任务，记录实际认证结果。
- 安全测试：跨项目路径、符号链接、junction、路径大小写、拒绝目录、恶意工具参数和过期 turn。
- 回归测试：原有 AgentTask 面板、Task Contract、Task Evidence、TaskWorkspace、自动规则任务和现有主会话执行。
- P1 另增加写入隔离、命令白名单、Worktree 文件系统攻击用例及人工集成审批测试。

---

## 9. 交付物

1. 现有 AgentTask 模块的增量代码实现，不得复制新建 Orchestrator。
2. 主 Runtime 平台工具注册与调用路由。
3. Orchestration Run 关联和必要的 SQLite 增量迁移。
4. 受控 Runtime 能力认证与测试报告。
5. 子 Agent 结果 Schema 和证据关联。
6. 现有 AgentTasksPanel 的增量 UI。
7. 自动化测试、集成测试和 Windows 桌面运行验证记录。
8. 更新后的 README/技术说明，记录当前支持的 Runtime、能力状态和已知限制。

---

## 10. 给 Codex 的执行要求

1. 开始前读取当前分支实际代码和 `AGENTS.md`，确认分支仍为 `develop/desktop-poc`；如果 HEAD 已变化，以工作区当前版本为准。
2. 先提交《现有实现复核与差异清单》，逐条列出将复用的类、函数、IPC、表结构和 UI，禁止直接按本文从零搭建。
3. 本版本 P0 优先完成；P1 写入型 Agent 必须等 P0 和单独安全认证通过后再实施。
4. 不得简单把 `controlledGovernanceValidated` 改为 `true`；必须通过可复现的测试与运行时认证结果驱动能力门禁。
5. 不得打开 Codex `features.multi_agent` / `multi_agent_v2` 充当平台实现。
6. 不得绕过 `agent-task:create` 的当前运行检查而直接暴露不受控 IPC；主 Agent 工具应走主进程 Orchestration Service，并校验当前 Run Ticket。
7. 不得把 `waitForTasks()` 当前的超时取消语义直接暴露给主 Agent；必须提供非破坏性等待 API。
8. 不得将普通 Runtime 的 `danger-full-access`、`approval_policy=never` 视为任务级工具权限控制。
9. 不得开放未经验证的 Worktree 写入 Agent；Git Worktree 只是目录隔离，不是系统级沙箱。
10. 每一批改动执行真实类型检查、测试、构建和 Windows 启动验证；未执行项明确标记，不得把静态检查说成运行通过。
11. 保留现有用户改动、历史审计、失败任务和 Worktree；禁止为通过测试而清理或重置用户数据。
12. 每个 P0/P1 条目完成后提供代码路径、测试名称、命令、退出码和实际结果。


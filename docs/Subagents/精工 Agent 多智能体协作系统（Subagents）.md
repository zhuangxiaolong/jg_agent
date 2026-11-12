# 精工 Agent 多智能体协作系统（Subagents）

## P0/P1 需求方案与技术方案

版本：V1.0
适用平台：精工Agent
开发对象：Codex Runtime、精工 Runtime
目标：将精工 Agent 从单智能体编程助手升级为支持多智能体并行协作的 AI 开发平台。

# 一、项目目标

实现主 Agent + 多个专业子 Agent 的协作开发机制。

主 Agent 负责需求理解、任务拆解、调度、结果汇总；子 Agent 负责独立的专业任务。

必须遵循以下原则：

1. 两种 Runtime 使用统一的 Agent 管理界面。
2. Codex Runtime 优先复用 Codex 原生 Subagents 能力。
3. 精工 Runtime 自主实现多智能体调度机制。
4. 每个子 Agent 拥有独立上下文。
5. 所有 Agent 的执行过程可观察、可追踪、可干预。
6. 所有开发结果必须经过真实测试和质量门禁。
7. 不允许通过 Agent 自我声明代替真实执行证据。

# 二、产品功能设计

## 2.1 主 Agent

主 Agent 是整个多智能体协作系统的调度中心。

主要职责：

- 接收用户开发需求。
- 分析需求并拆分子任务。
- 判断任务之间的依赖关系。
- 创建和分配子 Agent。
- 控制并行执行数量。
- 监控子 Agent 执行状态。
- 接收子 Agent 执行结果。
- 对结果进行整合和检查。
- 发现问题时要求子 Agent 修复。
- 最终向用户提交开发结果。

主 Agent 不应简单地将任务拆分后全部并行执行，必须考虑任务依赖和代码修改冲突。

## 2.2 子 Agent

第一阶段提供以下专业 Agent：

| Agent               | 职责                               |
| ------------------- | ---------------------------------- |
| Requirement Agent   | 需求分析、需求完整性检查、验收标准 |
| Architecture Agent  | 技术架构、数据库设计、影响分析     |
| Developer Agent     | 代码开发、功能修改、代码实现       |
| Code Review Agent   | 代码审查、规范检查、缺陷识别       |
| Testing Agent       | 测试用例、自动化测试、测试证据     |
| Documentation Agent | 技术文档、开发记录、变更说明       |

要求：

- 支持主 Agent 动态创建子 Agent。
- 支持指定子 Agent 的名称、角色、任务和输入。
- 支持子 Agent 独立上下文。
- 支持子 Agent 使用项目知识库。
- 支持子 Agent 使用授权的工具。
- 支持子 Agent 向主 Agent 返回结构化结果。
- 支持子 Agent 执行失败、超时和取消。

## 2.3 Agent 执行状态

统一状态定义：

- PENDING：等待执行
- RUNNING：正在执行
- COMPLETED：执行完成
- FAILED：执行失败
- CANCELLED：已取消
- WAITING：等待依赖任务
- BLOCKED：执行受阻

状态必须由 Runtime 实际执行情况驱动，不允许模型自行编造执行状态。

# 三、P0 需求：基础多智能体协作

## P0-1 主 Agent 创建子 Agent

用户提出复杂开发任务后，主 Agent 可以动态创建多个子 Agent。

创建参数：

- Agent ID
- Agent 名称
- Agent 类型
- 任务描述
- 输入上下文
- 模型配置
- 工具权限
- 超时时间
- 父 Agent ID
- 任务依赖关系

要求：

1. 一个主 Agent 可以创建多个子 Agent。
2. 子 Agent 必须绑定当前会话和项目。
3. 子 Agent 必须有独立的任务 ID。
4. 子 Agent 不得越权访问其他项目。
5. 子 Agent 的工具权限由平台统一控制。

## P0-2 并行执行

支持多个子 Agent 同时运行。

第一阶段默认最大并发数为 3，可配置。

支持：

- 并行任务。
- 串行任务。
- 依赖任务。
- 任务等待。
- 任务失败处理。

示例：

用户需求：MES 增加生产订单批量导入功能。

任务拆解：

1. Requirement Agent：分析业务需求。
2. Architecture Agent：设计技术实现方案。
3. Developer Agent：根据确认的方案开发。
4. Code Review Agent：检查代码。
5. Testing Agent：执行测试。
6. Documentation Agent：整理开发文档。

其中需求分析与部分架构分析可以并行；开发依赖设计结果；审查和测试必须依赖代码完成。

## P0-3 独立上下文

每个子 Agent 维护独立上下文。

上下文分为：

公共上下文：

- 当前项目基本信息。
- 项目开发规范。
- MES/WMS 数据字典。
- 项目技术架构。
- 用户明确授权的公共知识。

私有上下文：

- 当前 Agent 的任务描述。
- 当前 Agent 的执行历史。
- 当前 Agent 的工具调用记录。
- 当前 Agent 的中间结果。

禁止无条件将全部主会话历史复制给每个子 Agent。

## P0-4 结果回传

子 Agent 执行完成后，向主 Agent 返回标准结果：

- 任务状态。
- 执行摘要。
- 修改文件列表。
- 代码变更摘要。
- 测试执行情况。
- 遗留问题。
- 错误信息。
- 执行日志引用。

主 Agent 根据子 Agent 的结果决定下一步操作。

## P0-5 前端展示

在精工 Agent 会话界面增加子 Agent 管理面板。

展示内容：

- 当前主 Agent。
- 子 Agent 名称。
- 子 Agent 任务。
- 执行状态。
- 当前运行时间。
- 使用模型。
- 执行摘要。
- 任务依赖关系。

支持：

- 展开子 Agent 详情。
- 查看执行日志。
- 查看任务输入输出。
- 查看执行结果。
- 手动停止子 Agent。

建议采用右侧抽屉或侧边面板，不改变现有主要对话操作习惯。

## P0-6 异常处理

必须支持：

- Agent 执行超时。
- 模型请求失败。
- 工具执行失败。
- 子 Agent 异常退出。
- 用户取消任务。
- 父 Agent 取消任务时向下传递取消信号。
- 有限次数自动重试。

重试必须避免重复写入代码、重复提交 Git 操作等副作用。

## P0-7 代码工作区隔离

对于多个可能修改代码的子 Agent：

- 默认采用独立 Git Worktree。
- 每个工作区绑定独立任务。
- 禁止多个写入型 Agent 无约束地修改同一工作目录。
- 子 Agent 完成后输出变更文件和差异。
- 主 Agent 负责冲突检查和集成。
- 集成前必须保留原始代码状态。
- 不允许未经授权自动推送远程仓库。

只读型 Agent 可以共享只读项目上下文。

# 四、P1 需求：智能体管理与增强

## P1-1 自定义 Agent

允许用户创建自定义 Agent。

配置内容：

- Agent 名称。
- Agent 角色。
- Agent 系统提示词。
- Agent 适用场景。
- Agent 默认模型。
- Agent 工具权限。
- Agent 知识库。
- Agent 执行约束。

支持编辑、复制、启用、停用和删除。

## P1-2 Agent 独立模型配置

允许不同 Agent 选择不同模型。

例如：

- Requirement Agent：高推理模型。
- Architecture Agent：高推理模型。
- Developer Agent：代码能力较强的模型。
- Code Review Agent：高推理模型。
- Documentation Agent：低成本模型。

模型配置继承平台现有模型中转站配置。

不重复建设模型供应商管理模块。

## P1-3 多层级 Agent

允许子 Agent 在授权范围内创建自己的子 Agent。

例如：

主 Agent

- 开发 Agent
  - 后端开发 Agent
  - 前端开发 Agent
- 测试 Agent
  - 接口测试 Agent
  - 功能测试 Agent

必须支持最大层级、总 Agent 数量和并发数限制。

## P1-4 Agent 模板市场

提供可复用模板：

- MES 开发团队。
- WMS 开发团队。
- 需求分析团队。
- 代码审查团队。
- 自动化测试团队。
- 数据库优化团队。

允许用户导入、复制和修改模板。

## P1-5 人工干预与审批

支持：

- 用户向指定 Agent 追加指令。
- 用户暂停任务。
- 用户恢复任务。
- 用户终止任务。
- 重要操作要求人工确认。
- 主 Agent 请求用户确认关键技术方案。

# 五、技术架构

## 5.1 总体架构

前端统一 Agent 管理界面。

后端统一 Agent 管理服务。

底层通过 Runtime Adapter 适配不同运行引擎。

Codex Runtime：
优先调用 Codex 原生 Subagents 能力。

精工 Runtime：
使用自研 Agent Orchestrator 实现多智能体调度。

## 5.2 Runtime Adapter

定义统一接口：

- createAgent()
- startAgent()
- getAgentStatus()
- sendAgentMessage()
- stopAgent()
- waitAgent()
- getAgentResult()
- listAgents()

具体方法名以现有项目技术栈为准。

Codex Adapter 负责把统一接口转换为 Codex Runtime 实际支持的操作。

精工 Adapter 负责调用自研 Orchestrator。

注意：必须先检查当前 Codex Runtime 的版本、SDK/API 能力和插件接口，不得假定所有原生能力都能通过现有集成层直接调用。

如果当前 Runtime 无法访问某项原生能力，必须明确列出限制，不得用伪实现冒充。

## 5.3 精工 Runtime 核心模块

### Agent Registry

负责 Agent 注册、配置、角色、模型和权限管理。

### Agent Orchestrator

负责任务拆解、子 Agent 创建、调度和结果汇总。

### Task Scheduler

负责并行任务、依赖关系、优先级和并发限制。

### Agent Executor

负责模型调用、工具执行和任务运行。

### Context Manager

负责公共上下文和独立上下文管理。

### Message Bus

负责主 Agent 与子 Agent 之间的消息传递。

### Workspace Manager

负责项目工作区、Git Worktree 和文件隔离。

### Result Aggregator

负责结果收集、结构化处理和主 Agent 汇总。

### Execution Monitor

负责运行状态、日志、Token 用量和异常监控。

# 六、数据模型建议

建议至少包含以下实体：

1. agent_definition：Agent 定义。
2. agent_session：Agent 运行实例。
3. agent_task：任务信息。
4. agent_task_dependency：任务依赖关系。
5. agent_message：Agent 消息。
6. agent_execution_log：执行日志。
7. agent_result：执行结果。
8. agent_workspace：工作区信息。
9. agent_usage：模型调用和资源用量。

关键字段：

agent_task：

- id
- session_id
- parent_agent_id
- agent_id
- task_description
- status
- priority
- timeout
- retry_count
- started_at
- completed_at
- result_id

具体字段类型、索引、关联关系应根据现有数据库规范设计。

# 七、安全与质量控制

1. 子 Agent 只能使用被授权的工具。
2. 项目代码、知识库必须按项目权限隔离。
3. 不允许子 Agent 绕过平台权限直接访问其他项目。
4. 敏感工具操作必须经过审批。
5. 执行日志必须可追踪。
6. Token 使用量必须可统计。
7. 必须有并发限制和预算限制。
8. 必须避免任务无限递归。
9. 必须支持任务取消和资源释放。
10. Agent 的成功状态不能代替实际代码和测试证据。

# 八、验收标准

## P0 验收

1. 一个主 Agent 能成功创建至少 3 个子 Agent。
2. 多个子 Agent 能够独立并行运行。
3. 子 Agent 能够维护独立上下文。
4. 子 Agent 能够向主 Agent 回传结果。
5. 主 Agent 能够根据依赖关系调度任务。
6. 前端能够实时展示子 Agent 状态。
7. 用户能够停止指定子 Agent。
8. 任务异常时能够正确记录错误。
9. 多个写入型 Agent 的工作区相互隔离。
10. Codex Runtime 和精工 Runtime 均能通过统一前端管理。
11. 能够真实执行一次 MES/WMS 多 Agent 协作开发。
12. 测试结果有真实执行记录，不允许模型虚构测试通过。

## P1 验收

1. 用户可以自定义 Agent。
2. 不同 Agent 可以配置不同模型。
3. 支持多层级 Agent。
4. 支持 Agent 模板。
5. 支持人工审批和中途干预。
6. 支持资源消耗统计。

# 九、Codex 开发要求

开发前必须先检查精工 Agent 当前代码结构。

重点检查：

1. 当前 Codex Runtime 的接入方式。
2. 当前精工 Runtime 的执行机制。
3. 当前会话管理方式。
4. 当前工具调用体系。
5. 当前模型中转配置。
6. 当前项目知识库机制。
7. 当前 Git 项目管理方式。
8. 当前前端会话页面结构。

不要直接推翻现有架构。

开发顺序：

第一阶段：

- 现有架构调研。
- 输出技术差距分析。
- 确认统一 Agent 接口。
- 明确 Codex 原生能力的可复用范围。

第二阶段：

- 实现 Agent Registry。
- 实现统一 Runtime Adapter。
- 实现精工 Runtime Orchestrator。
- 实现基础任务调度。

第三阶段：

- 接入 Codex 原生 Subagents。
- 实现独立上下文。
- 实现结果回传。
- 实现状态管理。

第四阶段：

- 实现前端 Agent 管理面板。
- 实现工作区隔离。
- 实现异常处理。

第五阶段：

- 完成 P0 自动化测试。
- 使用真实 MES/WMS 开发任务验收。
- 再开展 P1 功能。

特别要求：

- 不得为了统一接口而削弱 Codex Runtime 原生能力。
- 不得虚构 Codex Runtime 的能力。
- 不得将简单的多轮模型调用包装成真正的子 Agent。
- 不得以模拟状态代替真实任务执行。
- 不得破坏现有单 Agent 会话功能。
- 所有新功能必须兼容现有模型中转配置和项目知识库。

# 十、最终交付物

1. 现有架构调研报告。
2. 多智能体系统详细设计文档。
3. 数据库变更脚本。
4. Runtime Adapter 实现。
5. 精工 Runtime Orchestrator。
6. Codex Runtime Subagents 接入。
7. 前端 Agent 管理面板。
8. 自动化测试代码。
9. 测试执行报告。
10. 部署及升级说明。

最终目标：

让精工 Agent 同时具备 Codex 原生多智能体协作能力和独立的精工多智能体执行能力，形成可扩展、可管理、可审计的企业级 AI 软件开发平台。
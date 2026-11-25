# Codex 执行总指令：精工 Agent P0–P1（目标版本 0.9.8）

> 用法：在精工 Agent 仓库根目录打开 Codex，将本文件及同目录的三份需求技术方案、`验收测试矩阵.md` 一并提供给 Codex。要求 Codex 按阶段实际修改代码、运行验证并形成结果，不要只输出计划。
>
> 目标仓库：`zhuangxiaolong/jg_agent`  
> 基线分支：`develop/desktop-poc`  
> 文档基线：2026-11-25  
> 代码基线：README 0.9.7；Codex Runtime 固定版本 0.156.1  
> 本次目标：完成 P0 + P1，形成可验证的 0.9.8 开发结果。

---

## 0. 你的角色与交付要求

你是本项目的资深 Electron / TypeScript / Codex App Server 架构工程师。你需要直接在当前仓库中完成以下开发任务：

1. P0：启用并集成 Codex 原生 Multi-Agent V2。
2. P0：把精工专家中心与 Codex 原生 Multi-Agent 协作打通。
3. P1：升级 MES/WMS 智能上下文检索，提高检索命中质量、证据定位和上下文预算利用率。
4. P1：把精工 Skill 管理、专家 `skillTags`、Codex Plugin Profile 和 Codex 原生 Skills 连接起来。
5. 完成旧数据兼容、UI、自动化测试、桌面端回归和开发结果报告。

**必须实施，不要只给建议、伪代码或技术评审。** 允许在实施中根据当前源码调整文件路径和实现细节，但不得改变本文与三份方案文档约定的产品行为、安全边界和验收标准。

按以下文件作为本次需求真源：

- `P0_原生Multi-Agent与专家协作_需求技术方案.md`
- `P1_MES-WMS智能上下文检索2.0_需求技术方案.md`
- `P1_Codex原生Skills与专家中心打通_需求技术方案.md`
- `验收测试矩阵.md`
- `README_开发包说明.md`

如果文件不在仓库内，先在当前 Codex 会话附件中查找；仍不可见时，明确指出缺失文件，不得编造其内容。对可以从现有源码确定的工作继续完成，不要因为单个非关键资料缺失而停止全部工作。

## 1. 开发前必须完成的现状核对

先读取：

- 根目录 `AGENTS.md`、`README.md`、`package.json`
- `packages/agent-runtime/src/index.ts`
- `packages/agent-runtime/src/manager.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/main/runtime-reuse.ts`
- `apps/desktop/src/main/codex-app-server-prewarm.ts`
- `apps/desktop/src/main/agent-orchestration.ts`
- `apps/desktop/src/main/agent-tasks.ts`
- `packages/expert-engine/src/index.ts`
- `apps/desktop/src/main/expert-center.ts`
- `apps/desktop/src/main/plugin-manager.ts`
- `packages/plugin-manager/src/skill-matcher.ts`
- `packages/domain/src/skill-intelligence.ts`
- `apps/desktop/src/main/context-sources.ts`
- `packages/performance/src/context-retrieval.ts`
- `packages/performance/src/workspace-index.ts`
- `apps/desktop/src/main/performance-service.ts`
- `apps/desktop/src/main/iteration-ipc.ts`
- 与上面模块相关的 domain、storage、IPC、renderer、测试文件。

执行 `git status --short`、确认当前分支和 HEAD。**不得覆盖、清理或撤销用户现有未提交修改。** 不得执行 `git reset --hard`、`git clean -fd`、批量删除、强制覆盖或其他破坏性命令。

先运行当前仓库已有的构建与测试，记录基线结果。若基线已失败，区分原有失败和本次新增失败，不得把已有失败归咎于本次改动。

现有实现与本文不一致时：以当前源码、根目录 `AGENTS.md`、固定 Codex Runtime 的实际协议为准；调整方案必须保留目标行为，并在最终报告列明偏差。

## 2. 关键架构约束（不可违反）

### 2.1 不重写 Codex

- 继续通过现有 `CodexRuntime` 和固定版本 Codex App Server 执行模型与工具调用。
- 不新建基于 Responses API 的第二套 Agent 推理循环。
- 不在精工 Agent 内自行实现一套 `spawn_agent` / `wait_agent` 协议模拟器。
- 不替换 `@openai/codex` 或 Runtime 二进制版本；除非当前仓库事实证明版本已经变化，否则保持 0.156.1。
- 不将 Codex Agents API、Chat Completions tool call 或其他产品协议字段误当成 App Server 配置。

### 2.2 两种子 Agent 机制必须互斥

现有 `AgentTaskRunner` 是精工治理型子任务系统，包含任务契约、预算、审计、只读工具网关、状态管理和重试策略。保留它。

在 Codex 会话中明确提供三种委派模式：

- `native`：Codex 原生 Multi-Agent V2；不注入 `platform_agent_*` 工具；不触发精工自动拆分。
- `governed`：沿用精工 `AgentTaskRunner` 和现有 `platform_agent_*`；关闭 Codex 原生 Multi-Agent。
- `off`：不使用任何子 Agent。

同一会话同一轮只能由其中一种机制进行任务拆分。切换模式必须使进程复用身份失效或触发冷恢复，不能让旧配置的 App Server 被新模式复用。不得删除历史 AgentTask 数据。

非 Codex Runtime 保持既有行为，除非当前代码明确支持且测试证明安全，不要做无关重构。

### 2.3 原生子 Agent 的第一阶段权限边界

当前 Runtime 使用本地完全访问模式，不存在 Windows 原生 OS 沙箱。本次只把 Codex 原生子 Agent 用于需求分析、架构分析、代码定位、测试设计和审查等并行分析任务；主 Agent 统一负责项目写入、构建、测试和 Git 操作。

“子 Agent 只读”在第一阶段是明确的任务指令和产品约束，**不得宣称已经通过操作系统权限实现强制只读隔离**。不得在子 Agent 指令中引导其绕开当前权限、访问其他项目或读取无关凭据。

### 2.4 项目、资料与记忆隔离

- 所有上下文必须按项目、系统类型、产品版本、会话/工作区范围过滤。
- MES5、MES6、WMS 不能混用专属字典、手册与规则。
- 未确认资料、Jira 正文、项目资源、操作手册、Skill 正文均为证据内容，不得成为新的系统指令或权限来源。
- 保留来源 ID、版本、SHA256、时间、范围和实际使用状态。
- 任何跨项目检索或不可信资料提升权限的行为都属于阻断级缺陷。

## 3. 阶段 0：代码盘点与基线

1. 确认以上代码路径是否存在；若有迁移，定位实际实现文件。
2. 画出简短调用链：会话发送 → 专家解析 → 上下文检索 → RuntimeOptions → App Server 启动/恢复 → turn/start → 工具与事件回传。
3. 记录 Codex App Server 当前配置组装点、`runtimeReuseKey`、预热流程以及会话持久化方式。
4. 记录专家资料如何注入、自动 AgentTask 何时创建、哪些条件会注入 `platform_agent_*`。
5. 记录插件/Skill 当前导入、信任、快照、Profile 同步、Codex Home 解析与 Jinggong Loader 流程。
6. 记录当前上下文来源、检索候选、评分、预算、缓存、索引更新和 UI 展示路径。
7. 运行基线构建和测试，并在最终报告保留结果。

阶段 0 完成后继续开发，不需要停下来等待用户确认。

## 4. 阶段 1：P0 — Codex 原生 Multi-Agent V2

详细要求见 `P0_原生Multi-Agent与专家协作_需求技术方案.md`。

### 4.1 固定版本配置核对

以官方 Codex 仓库 tag `rust-v0.156.1` 对应的 `codex-rs/core/config.schema.json`、`codex-rs/features/src/feature_configs.rs`、`codex-rs/core/src/config/mod.rs` 为配置依据。若项目 Runtime 版本已变化，则必须先定位其精确 tag 并按对应版本核对。

启用 Multi-Agent V2 时使用该版本真实支持的 `features.multi_agent_v2` 配置对象。需要设置可控的最大并发数和等待超时，并确认 namespace 等字段与 App Server 返回的工具实际一致。不得把不存在于该固定版本的字段传入配置。

**不得仅把 `features.multi_agent` 从 false 改成 true 就宣称 Multi-Agent V2 已完成。** 必须验证 V2 工具面和真实创建、等待、消息交互、取消行为。

### 4.2 委派模式数据模型

实现 `native | governed | off` 三态模式。确定默认值、旧会话迁移、缺省字段兼容、会话级设置持久化和 UI 控件。

配置变更后必须：

- 校验会话空闲状态；运行中不得无提示热切换。
- 按模式关闭不匹配的 Agent 工具面。
- 将委派模式纳入 Codex Runtime 进程身份/复用键。
- 使预热实例和正式会话 Runtime 配置完全一致，否则废弃预热实例。
- 在事件中可观察当前模式和是否真正启用原生 Multi-Agent。

### 4.3 互斥与回退

- `native`：V2 on；`platform_agent_*` 不可见；禁止自动创建治理型子任务。
- `governed`：V2 off；使用现有治理 Provider；保留预算、证据、审计和任务状态。
- `off`：V2 off；不注入治理 Provider；不自动拆分。
- 能力不可用时不能静默切到另一机制。显示明确状态和原因，由用户选择是否切换。

### 4.4 运行验证

至少验证：App Server 初始化成功、V2 工具暴露、原生子 Agent 创建、并行任务执行、`wait_agent`/消息收发、取消、主 Agent 汇总、会话恢复、Runtime 关闭与异常退出清理。

若当前中转站/模型不支持所需原生能力，不能伪造“已验证”。完成静态配置和协议单测，保留集成测试入口，并把真实模型端到端测试标为未执行及原因。

## 5. 阶段 2：P0 — 专家中心与原生 Agent 协作

详细要求见 P0 方案中的“专家驱动原生协作”和“默认专业协作模板”。

1. 复用 `resolveExpert()`、现有 `ExpertProfile`、`workflowId`、`steps`、`sources`、`skillTags`、`output`、`checks`，不要复制出另一套专家资料库。
2. 新增纯函数/服务，将专家配置转换成 Codex 原生子 Agent 的协作指导：职责划分、推荐角色、并行任务建议、输出格式、证据要求和最终汇总责任。
3. 由主 Agent 根据任务复杂度与专家指导自行使用 Codex 原生 Multi-Agent 工具；不要由主进程再重复创建同一批 `AgentTask`。
4. 并行任务应具有独立分析面，例如需求/架构/后端/前端/测试/审查；禁止多个子 Agent 无边界地重复读取同一资料或互相冲突地修改同一代码。
5. 子 Agent 默认只输出结构化分析、证据路径/行号、风险与未解决项；主 Agent 对证据进行复核，负责代码实施与最终验证。
6. 专家运行记录必须保存实际路由的专家版本、Hash、工作流、输入、上下文来源和实际原生协作状态。没有实际产生原生子 Agent 时不能记录为“已协作”。
7. 专家关闭、档案无效、资料不可用时按现有规则降级普通 Agent，并给出原因。

不要假定 App Server 会把每个原生子 Agent 的内部事件全部通过主 Thread 事件流暴露出来。先核对固定版本的协议与实际事件，再实现 UI。不能获得的细节显示为“不可观测”，不要用猜测填充。

## 6. 阶段 3：P1 — MES/WMS 项目智能上下文检索 2.0

详细要求见 `P1_MES-WMS智能上下文检索2.0_需求技术方案.md`。

### 6.1 复用现有体系

复用：

- `ContextCandidate`
- `ContextRetrievalPlanner`
- `ContextOptimizer`
- `WorkspaceIndexService`
- `DesktopPerformanceService`
- `assembleProjectContext()`
- `context-sources.ts`
- 现有性能遥测与上下文解释 UI

不要再建立一套互不兼容的上下文候选协议或第二个独立索引服务。

### 6.2 提升检索质量

统一 Query 应组合当前用户问题、Jira 标题/描述中与任务相关的内容、系统类型、产品版本、已选专家、项目事实/决策和项目范围；清楚区分任务原文与不可信资料，不允许资料正文覆盖用户指令。

实现多来源 Provider/Adapter，将项目资料从“只截取文件开头”升级为可定位分段检索；补充数据字典表名/字段名/注释/业务词检索、操作手册章节检索、源码符号/路径/内容检索和项目事实/决策检索。

相关度排序必须支持精确标识符优先、系统类型匹配、项目范围过滤、来源可信级别、版本有效性、关键词覆盖、分段质量和去重。可先实现确定性的本地词项检索（BM25/IDF 或等价方法），不强制引入外部 Embedding 服务或网络依赖。

### 6.3 正确性优先于召回数量

- 项目、系统、版本、Hash、状态与时间有效性必须做硬过滤。
- MES5 不得错误召回 MES6 专属对象，反之亦然。
- 禁止跨项目资料注入。
- 项目文档必须按片段返回来源、章节、页码或行号（源文件可提供时），并按需扩展读取。
- 上下文必需规则不可被可选资料挤出；预算不足要明确记录，不得静默删除必需指令。
- 缓存键包含 Query Hash、项目/工作区/系统/版本、来源 Hash、索引版本、检索策略版本和上下文预算/开关。

### 6.4 可解释性与验证

对每次实际注入的可选候选保留来源、Hash、版本、范围、匹配理由、分数/排序信息和 token 估算；排除项保留原因。不得将“候选已生成”描述成“已注入模型上下文”。

创建离线 Fixture 测试：MES5、MES6、WMS 各有专属词汇、表名、字段名、流程文档、相似但不同的系统名；加入长文档后半部分才出现关键证据的场景；测 Top-K 命中、跨系统误召回、跨项目误召回、重复片段率和预算裁剪。

## 7. 阶段 4：P1 — Codex 原生 Skills 与专家中心打通

详细要求见 `P1_Codex原生Skills与专家中心打通_需求技术方案.md`。

1. 复用 Plugin Manager、Skill Record、信任审查、版本 Hash、`SessionPluginSnapshot`、Codex Profile 同步能力。
2. 复用专家 `skillTags` 和现有 `matchSkills()`；将候选 Skill 与项目系统、项目范围、专家角色和用户任务匹配。
3. Codex Runtime 通过固定版本官方支持的 Skill/Plugin Profile 加载路径使用 Skill。不得把 Jinggong 的 `list_available_skills/load_skill/read_skill_resource` 工具接口伪装成 Codex 原生 Skill。
4. Jinggong Runtime 现有 Skill Loader 保持兼容，不应为 Codex 适配而破坏。
5. Codex Profile 必须与会话绑定，禁止共享写入用户默认 `~/.codex` 或其他不属于精工管理的数据目录。检查 profile home、marketplace、plugin cache 和 Skill 目录的路径边界与符号链接。
6. 仅启用、信任、版本 Hash 匹配、项目范围匹配且兼容状态允许的 Skill 可参与推荐和加载。
7. 推荐、同步、加载必须有不同状态。只有真实验证 Codex 已加载或实际调用该 Skill 时才能标记为“已加载/已使用”；不能仅因插件同步成功就记为使用。
8. Plugin、Skill、资源中的脚本/hooks 不在本次范围内自动执行；禁止默默扩大执行权限。
9. Codex Skill 正文按原生机制由 Codex 自行按需读取；精工可以提供候选、元数据和来源管理，但不得额外把全部 Skill 正文塞入每轮 developer instructions。
10. Codex Skill 原生兼容性只有通过真实版本验证后才能从 `Partial` 提升为 `Full`；否则保持 `Partial` 并写明支持范围。

## 8. UI 与用户体验

- 所有新设置沿用当前 Electron/React 组件体系、主题、字号、间距和现有设计规范。
- 展示当前会话 Runtime、委派模式、原生 Multi-Agent 可用状态、专家路由、上下文检索来源/排除原因和 Skill 状态。
- 状态必须真实、可解释；不可观测信息不做假进度或假 Agent 卡片。
- 运行中改变委派模式、插件 Profile、Skill 快照或关键权限时，要求先停止/等待当前任务结束，不能对正在执行的进程悄悄生效。
- 窄屏、宽屏、空数据、加载、失败、禁用状态均应检查。

## 9. 测试、质量与执行规则

### 9.1 每阶段完成都执行

- 对新增纯函数、Runtime 配置、迁移、匹配、检索、缓存键和状态流转添加单元测试。
- 对 IPC 与持久化增加集成测试。
- 用 fake adapter/fixture 测试任务流程，不要让普通 CI 测试依赖外网或产生实际模型费用。
- 只有真实配置可用时才进行真实 App Server / 中转站端到端验证；不能把 mocked test 描述为真实模型集成测试。
- 每阶段完成后运行相关测试和 `npm run build`。

### 9.2 最终回归命令

按项目当前 `package.json` 可用脚本运行：

```powershell
npm run build
npm test
npm run test:runtime-contract
npm run test:desktop
```

必要时运行：

```powershell
npm run benchmark:context
npm run runtime:probe
```

如果命令不可运行，报告命令、退出码、原因和受影响范围；不能把未运行描述为通过。

### 9.3 安全与版本规则

- 不记录或输出 API Key、Token、密码或连接串。
- 不把任何凭据写入文档、测试夹具、截图或日志。
- 对工作区文件的读写遵守现有路径验证、Hash、symlink/hardlink 检查和主进程写入校验。
- 不执行插件脚本和项目内不可信脚本，除非当前用户任务明确要求且现有安全策略许可。
- 不要通过降低校验强度来让测试通过。
- 不得删除当前既有能力、历史记录或迁移兼容性。
- 不得改动与本次目标无关的大量代码；必要重构应控制范围并补测试。
- 不得提交、推送、发布或部署，除非用户另行明确要求。

## 10. 执行节奏

按以下顺序完成，禁止把所有工作一次性并行修改同一核心文件：

1. 盘点与基线。
2. P0 原生 Multi-Agent V2 配置、能力检测和模式互斥。
3. P0 专家协作上下文和运行记录。
4. P1 上下文 Provider、检索、评分、分段、缓存与解释。
5. P1 Skill 推荐、Codex Profile 快照、原生加载验证和专家来源记录。
6. UI、迁移、测试、完整回归。

每阶段开始前读取依赖代码；阶段结束后检查 diff、运行相关测试、构建。不要在构建失败时继续叠加大量后续改动；先定位并修复本阶段引入的问题。

如果一个阶段涉及大量可并行、互不重叠的文件，可以使用 Codex 原生子 Agent 做只读代码盘点、测试设计或代码审查；**涉及修改同一文件或数据库迁移时只能由一个执行者负责**。未完成的子 Agent 必须等待或取消，不能遗留后台任务。

## 11. 最终交付报告

完成后在聊天中输出，并在仓库 `docs/development/` 或现有开发报告目录保存 Markdown 报告。报告必须包含：

1. 本次实现功能清单，按 P0/P1 分组。
2. 关键架构变更与数据迁移说明。
3. 新增/修改的主要文件清单及用途。
4. native / governed / off 三种委派模式的真实行为。
5. 原生 Multi-Agent V2 是否完成真实 App Server 验证；若没有，明确未验证原因。
6. MES5/MES6/WMS 检索质量测试结果及数据；没有量化结果就不能声称检索准确率提升了多少。
7. Codex Skill 原生发现/加载验证结果；推荐、同步、加载、实际使用要分开报告。
8. 执行过的所有测试命令、通过/失败/未运行结果、退出码。
9. 发现的回归风险、已知限制和后续建议。
10. Git diff 变更统计；确认没有意外修改其他无关文件。

**完成定义：** 代码真实落地；关键行为有自动化测试；可运行的构建与回归结果如实报告；所有未验证边界明确标注。不能以“代码已写完”代替“功能已验证”。

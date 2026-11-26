# 精工 Agent 1.6 产品设计与技术方案

版本：1.6 设计稿  
状态：产品设计阶段，尚未进入生产代码开发  
基线：本地 develop/desktop-poc 分支，提交 092af6b；对照 docs/1.5 产品方案  
配套原型：精工Agent_1.6_双中心可交互原型.html

## 1. 结论

1.6 不重建两个模块的底层。项目交付继续以 DeliveryProject 为唯一主数据，现场诊断继续以 DiagnosticCase、DiagnosticRun、DiagnosticStep、DiagnosticEvidence、DiagnosticHypothesis、DiagnosticResolution 和 DiagnosticKnowledgeCase 为独立业务记录。两个中心共享项目 ID、项目资料、知识检索、专家定义和 Runtime 配置，不读取聊天历史作为项目或诊断事实。

本次升级补齐三类缺口：

- 交付经营管理：项目组别、验收与回款计划、工作量、产能、交付组产值口径和可核验的 PM 履责视图。
- 主动诊断编排：案件受理后形成资料缺口、专家路由、分阶段排查、证据引用、根因验证、修复复测和案例沉淀的可追踪运行记录。
- 经营与质量巡检：基于已保存业务数据生成带来源的异常发现和分析草稿，人工确认后才更新业务状态或形成正式报告。

经营数值必须区分“计划”“已确认”“已发生”和“缺失”。人员视图是透明的工作量与履责事实，不生成不可解释的个人总分。交付产值以有来源的验收确认金额统计，不代表财务入账、利润或回款。AI 结果始终标记为草稿或待核验。

## 2. 审查基线与差距

### 2.1 审查范围和可信边界

已核对项目交付与现场诊断的 Renderer、Domain、Main/IPC、Preload、SQLite schema、Runtime 调用、专家中心、知识检索和 1.5 产品方案。主要实现入口如下：

- 项目交付：apps/desktop/src/renderer/DeliveryWorkbenchPage.tsx、apps/desktop/src/renderer/delivery-workbench/DeliveryDashboard.tsx、packages/domain/src/delivery-workbench.ts、packages/delivery-workbench/src/index.ts、apps/desktop/src/main/delivery-workbench-ipc.ts。
- 现场诊断：apps/desktop/src/renderer/DiagnosticsPage.tsx、packages/domain/src/diagnostics.ts、apps/desktop/src/main/diagnostics-ipc.ts。
- 公共能力：apps/desktop/src/renderer/App.tsx、apps/desktop/src/preload/index.ts、packages/storage/src/index.ts、packages/domain/src/expert.ts、apps/desktop/src/main/expert-center.ts、apps/desktop/src/main/expert-collaboration.ts、packages/domain/src/knowledge.ts。

审查基于当前本地分支 HEAD 092af6b。工作区已有未提交的 diagnostics-ipc.ts 修改、新增 quick-chat.ts 和 diagnostics-output.test.ts，以及未跟踪的 docs/1.5 设计文件。未提交内容不作为已验收行为，方案仅把当前已提交代码当作稳定基线。开发阶段应先审阅作者现有改动，再决定是否整合。

### 2.2 当前能力、1.5 目标与 1.6 差距

| 领域 | 当前代码已具备 | 1.5 已规划或已完成的产品方向 | 1.6 的实际差距与设计 |
| --- | --- | --- | --- |
| 项目主数据 | DeliveryProject 包含客户、MES5/MES6/WMS、产品版本、阶段、状态、项目经理、成员、计划日期、Jira Key、本地代码项目关联 | 唯一项目主数据、作战总览、台账和项目作战舱 | 没有交付组字段、身份目录或可验证的项目经营数据；增加可手工维护的交付组标签和来源明确的计划记录 |
| 项目交付记录 | 里程碑、任务、问题/风险、会议、资料、报告、活动均已有数据模型及主进程接口 | 项目异常/行动闭环与跨模块诊断入口 | 没有预计/实际工时、容量、验收明细和收款计划；增加最小 JSON 负载记录表与汇总 DTO |
| 当前项目总览 | 有健康规则、项目进度、任务/问题/里程碑聚合、异常与近期活动 | 作战中心首页和项目组合视图 | 当前只显示执行层状态，不支持第二战区经营、人员负荷、验收和回款；扩展为分角色可筛选的经营首页 |
| 当前健康算法 | Critical 问题、阻塞项、逾期里程碑会标红；逾期 High 任务、7 天内里程碑、High 问题、超过 7 天未更新会标黄；计划数据不足显示灰色 | 健康、风险和原因透明 | 保留事实规则并增加验收/回款/容量“数据缺失”提示，不把未知值误判为正常，不让 AI 直接改健康状态 |
| 项目与诊断关联 | DiagnosticCase 保存 deliveryProjectId 与可选 deliveryIssueId；新建时校验项目，关联问题须属于同一项目；工单导入有复用逻辑 | 项目级双向导航和诊断聚合 | 关系能力已存在，不重复加项目表或以聊天关联；强化案件工作区中的项目上下文和关联一致性校验 |
| 独立诊断 | 诊断记录和运行独立于 Session；当前 Runtime 调用保留模型、输入输出哈希、来源和状态；支持取消 | 项目级独立诊断运行 | 已具备稳定骨架，但界面依次运行分诊/计划/根因等单项任务；没有专家团队的阶段化运行视图和可恢复的子阶段结果 |
| 排查证据 | 有文件导入、hash、脱敏、解析状态、步骤反馈、假设和解决验证 | 证据中心与根因闭环 | 现有事实分散在工作区各区块；新增统一证据目录、来源定位和根因证据关系，保留当前安全文件处理路径 |
| 专家中心 | ExpertProfile 有角色、版本、步骤、来源、技能标签、输出与检查要求；现有 expert-collaboration 使用 Session/Agent Task 协作 | 诊断使用专家配置但不依赖聊天 Session | 复用 ExpertProfile 定义和版本快照，不直接复用 Session 型协作实例；新增诊断专长标签和独立协调器 |
| 知识库 | 有操作手册、项目知识、检索命中和审核通过的诊断案例 | 项目知识和去敏案例检索 | 现有运行上下文可引用手册、已确认项目知识、关联工单与审核案例；原始项目附件不自动全部索引或发送；1.6 增加来源选择、范围标记和引用覆盖 |
| AI 巡检 | 有规则型健康、周报和风险数据草稿；不是 AI 经营分析 | 1.5 以明确数据汇总和人工复核为边界 | 增加只读巡检运行、可确认发现项和经营分析草稿，不把旧规则型报告包装成 AI 结果 |
| 经营数据 | 项目金额、验收计划、收款计划、工作日志和人员容量均不存在 | 1.5 明确不虚构财务、工时、负荷指标 | 由授权人员维护业务原始事实和来源，缺失即显示未记录；不接入财务或 HR 系统作为默认前提 |
| 用户身份与责任 | 负责人、项目经理和参与人是字符串标签；没有可信身份目录或基于身份的权限 | 1.5 已说明角色视图不是访问控制 | 继续把页面角色预设作为筛选；明确显示“姓名标签，非登录授权”。绩效只展示透明指标及数据完整度 |

### 2.3 1.6 设计约束

1. DeliveryProject 是两个中心共享的唯一交付项目主数据。诊断记录通过 deliveryProjectId 关联项目，工单通过 deliveryIssueId 与项目工单关联。
2. 不新增聊天历史外键，不从会话标题、客户名、路径或内容猜项目关系。无项目的旧案件进入“待关联项目”队列，由用户选择项目。
3. 交付计划、商业计划与诊断记录分别保留自己的生命周期。业务跳转传递实体 ID，回到来源页面时定位具体记录。
4. 默认不连接客户生产数据库，不执行 SQL、Shell、PowerShell、写接口或配置修改。SQL、日志、API、配置和代码均以用户提供或已授权索引的只读证据分析。
5. AI 的专家选择、来源、阶段状态、调用参数摘要、模型请求数、取消/失败结果均可追溯。密钥不进入 Renderer、业务快照或导出文件。
6. 人员、项目组和金额没有外部主数据时显式录入，并保存来源。没有数字就显示“未记录”，不使用 0 代替未知。

## 3. 1.6 总体架构

### 3.1 产品逻辑图

    精工 Agent
    ├── 项目交付作战中心
    │   ├── 经营总览、项目台账、项目作战舱
    │   ├── 人员与交付组负荷
    │   ├── 验收与回款计划
    │   └── AI 巡检、经营分析
    ├── MES/WMS 现场智能诊断中心
    │   ├── 诊断队列、问题工作区
    │   ├── 独立诊断运行与专家协作
    │   ├── 证据、假设、根因、修复验证
    │   └── 案例审核与知识沉淀
    └── 共享能力
        ├── DeliveryProject 项目主数据
        ├── Runtime 与现有模型供应商配置
        ├── ExpertProfile 与专家中心
        ├── 操作手册、项目知识、诊断案例
        └── Main/IPC、Preload、LocalStore

Renderer 负责页面、筛选、编辑草稿、进度展示与确认。Preload 暴露窄类型化接口。Main/IPC 负责权限范围校验、项目关系校验、知识上下文组装、文件脱敏、Runtime 调用、专家路由、输出校验和持久化。Domain 定义增量契约与汇总规则。LocalStore 继续使用 SQLite 及 JSON payload 的既有模式。

### 3.2 数据域边界

| 数据域 | 归属与唯一来源 | 共享方式 |
| --- | --- | --- |
| 项目与交付 | DeliveryProject 及其现有里程碑、任务、问题、会议、资料、报告 | 按 deliveryProjectId 汇总，项目主数据不复制到诊断表 |
| 经营计划 | 验收项、回款计划、工作日志、产能计划 | 各自绑定 deliveryProjectId；如人员身份尚不存在，以姓名标签和来源记录 |
| 现场诊断 | DiagnosticCase、DiagnosticRun、DiagnosticStep、DiagnosticEvidence、DiagnosticHypothesis、DiagnosticResolution、DiagnosticKnowledgeCase | 独立于项目任务与聊天；通过显式项目 ID 和可选问题 ID 关联 |
| AI 运行审计 | 每个 DiagnosticRun / DeliveryInspectionRun 保存执行快照、配置标识、版本、哈希、来源和状态 | 可供两个中心读取摘要；不将原始聊天内容带入诊断上下文 |
| 知识 | 现有手册、已确认项目知识、审核案例和代码索引 | 通过明确检索请求返回带信任、版本、定位和 hash 的来源引用 |
| Session/Agent Task | 研发工作台既有会话域 | 不承载交付或诊断事实；诊断转研发只创建可编辑任务草稿，人工确认后可关联现有工程项目或 Jira 流程 |

### 3.3 主数据与跨中心关系

    DeliveryProject 1 ─ N 现有交付记录
    DeliveryProject 1 ─ N DeliveryAcceptancePlan
    DeliveryProject 1 ─ N DeliveryCollectionPlan
    DeliveryProject 1 ─ N DeliveryWorkLog
    DeliveryProject 1 ─ N DiagnosticCase
    DeliveryIssue 0 ─ 1 DiagnosticCase（允许一张交付问题对应一份诊断档案）
    DiagnosticCase 1 ─ N DiagnosticRun
    DiagnosticRun 1 ─ N AI 阶段记录 / 来源引用 / 假设
    DiagnosticCase 1 ─ N DiagnosticEvidence / Resolution / KnowledgeCase

项目归档继续保留历史关系。归档项目不可新建诊断或修改计划，但可以查看历史诊断、报告和验收/回款结果。若现有项目物理删除触发案件外键置空，案件保留并进入“待关联”，不得级联删除诊断证据。

## 4. 角色与指标口径

### 4.1 使用角色

- 第二战区负责人：看项目组合健康、按期交付、验收与回款计划偏差、资源负荷和需拍板事项。
- 交付组负责人：看组内项目、组产值确认、未分配任务、人员周负荷和外部依赖。
- 项目经理：看本项目范围、进度、延期原因、客户依赖、验收回款、待决策和巡检发现。
- 实施工程师：受理现场问题、补证据、执行手工排查、反馈结果和复测。
- 研发/测试：接收经人工确认的开发任务草稿，查看关联证据、复现步骤和验收条件。
- 知识审核人：检查脱敏、版本适用性和复现/验证信息，批准项目内或跨项目案例。

角色预设只影响筛选、默认排序和首页布局。当前没有登录用户身份或组织权限服务，因此本方案不定义真实权限隔离和个人访问控制。

### 4.2 交付经营口径

| 指标 | 口径 | 无数据时 |
| --- | --- | --- |
| 计划进度 | 沿用当前完成非取消任务数 ÷ 非取消任务总数；项目无任务时另显示里程碑状态，不合并成伪精确百分比 | 未建立计划 |
| 项目健康 | 沿用 packages/delivery-workbench 当前红/黄/绿/灰规则；新增经营风险作为并列标签和原因，不覆盖原始健康算法 | 数据不足 |
| 延期风险 | 计划结束日已过且项目未完成；或里程碑/任务逾期；按责任方和阻塞原因分解 | 缺截止日期时列入“日期缺失” |
| 负荷率 | 选定周期内任务剩余估算工时 ÷ 人员可用工时；工时与容量必须由人员/负责人显式维护 | 分子或分母缺失时显示“无法计算” |
| 工作效率 | 只展示已记录工时、完成任务与验证结论的组合趋势，不以任务数直接推断效率，不做未经校准的跨角色排名 | 数据覆盖率不足时显示不完整 |
| 交付组产值 | 选定期间、按实际验收日期汇总已确认验收金额，按验收记录创建时的交付组标签归属；与计划金额分栏 | 未录入验收金额或来源时不计入确认产值 |
| 验收进度 | 按验收项状态和验收金额分别展示计划、已确认、延期、取消 | 未建立验收项 |
| 回款进度 | 每个回款计划记录计划金额、已收金额、日期、凭据来源；支持分批到账 | 未建立计划或实际到账未确认 |
| PM 履责视图 | 展示计划更新及时率、逾期事项数、未分配项、依赖等待龄期、验收/回款计划完整度和确认动作 | 逐项显示数据覆盖率，不汇总成 AI 个人评分 |

金额使用整数最小货币单位和 ISO 4217 币种标识；跨币种不直接求和。系统不宣称收入确认、开票、利润或财务到账凭证。回款实际额必须由用户附来源标签或文件引用。

## 5. 完整业务流程

### 5.1 项目交付流程

1. 项目建档。项目经理创建或校准 DeliveryProject，维护客户、系统版本、阶段、计划日期、交付组标签、经理和成员。系统提示未录入字段，不阻止先建立交付计划。
2. 建立计划。项目经理录入里程碑、任务、负责人、截止日期和估算工时。必要时维护项目验收项、回款分期、合同金额与来源。计划与来源记录均保留更新时间和操作人标签。
3. 执行与反馈。项目成员更新任务状态、阻塞原因、关联交付问题、会议决议和工时。外部依赖明确标为客户/供应商/内部研发/待确认，等待中事项不从项目延期数据中隐藏。
4. 日常作战。首页以红黄例外、临期里程碑、等待依赖、待验收、回款偏差和人员超载组织队列。每行能打开原始记录，并允许负责人确认、改期或补充原因。
5. 周/月经营复盘。按第二战区、交付组、客户、系统、项目经理和周期筛选。产值只统计确认验收金额，回款只显示实际登记到账金额。分析文本附指标口径、来源快照和数据覆盖率。
6. AI 巡检。选择项目或项目组合与巡检范围，先预览数据范围和缺失字段，再运行只读规则/AI 分析。发现项具有证据定位、建议动作、严重度、置信度和审核状态。负责人逐项接受、驳回或转成任务/风险/验收行动。
7. 验收及收款闭环。按验收计划、实际签收证据、收款计划和分批收款记录跟踪偏差。合同、验收和回款附件继续走现有受管文件导入，不自动发客户、不对接财务系统。
8. 项目关闭。确认交付项完成、未关闭问题有归属、验收状态和剩余回款明确。关闭项目后保留历史数据和诊断关联，不能删除过程记录。

### 5.2 现场智能诊断流程

1. 受理。工程师从诊断中心新建，或从项目/交付问题进入。项目 ID 必填；系统自动带入系统类型、版本、客户、项目阶段及可用项目知识。记录现象、期望/实际、复现步骤、时间、频次和影响面。
2. AI 主动补问。分诊专家识别信息缺口，将问题整理为少量可回答的问题。工程师可以逐项回答、标记不适用或暂缓，不能让模型把缺失信息编成事实。
3. 上下文确认。Main 组装问题事实、人工挑选的附件、脱敏后的解析内容、项目已确认资料、相关操作手册、同项目知识和已审核案例。界面按来源显示范围、版本、定位、信任级别和预览，工程师可剔除非必要来源。
4. 自动路由。系统按产品、模块、问题类别、证据类型和 ExpertProfile 能力标签推荐主专家。显示选择理由、适配度、配置版本和可用 Runtime；负责人可切换专家，结果中保留自动选择或人工覆盖记录。
5. 分阶段排查。主诊断专家输出可验证计划；按证据类型顺序调用最多两个只读专项专家，初始版本串行执行以控制 Runtime 生命周期、成本和结果可追踪性；协调器完成证据交叉核对和下一步建议。每阶段保存运行状态、输入 hash、来源和结构化输出。
6. 工程师验证。工程师逐步提交正常/异常/不确定/受阻结果，关联证据并记录环境、时间和操作人。AI 根据新增证据生成下一轮计划，不能覆盖已执行步骤或修改已确认事实。
7. 根因判定。根因面板按假设列出支持证据、反证、置信等级和下一项验证。只有工程师确认后状态才转为已验证根因；证据冲突时允许保留多个假设或标记未知。
8. 开发任务。对需要研发的问题，AI 根据已确认事实生成标题、复现步骤、影响范围、技术证据、验收条件和回归建议。工程师复核并手动导出或关联 Jira，不自动创建外部工单。
9. 修复验证。录入修复版本、变更说明、测试/现场验证方法、结果、验证人和时间。失败可重开并沿用历史运行，不覆盖原始根因和修复记录。
10. 案例沉淀。系统生成脱敏案例草稿，展示将共享的字段和来源。提交后由人工审核，跨项目可见只适用于已批准、已脱敏、产品版本适配的案例。

### 5.3 AI 巡检与经营分析流程

1. 操作者选择时间范围、项目组、客户或单个项目，以及规则巡检、经营摘要、延期原因、验收回款偏差或负荷分析。
2. 系统生成预检快照，展示数据来源、计数、缺失率、跨币种分组、时间范围和将进入 Runtime 的文本摘要。
3. Main 对快照做脱敏与长度限制，生成 snapshotHash。运行记录固定规则版本、Runtime/模型、提示词版本和数据来源。
4. 规则层先生成可复算事实；AI 只解释异常、提出待确认原因和行动建议。所有结论都要引用事实记录，缺少来源时标为假设。
5. 结果在巡检工作台分为事实、AI 假设、待补数据和建议动作。操作者可转为已有任务/问题/回款计划更新草稿，最终保存必须二次确认。
6. 报告草稿保留来源快照与生成时间，过期时提示重新运行。发布和导出不改变项目业务状态。

## 6. 信息架构和页面交互

### 6.1 一级导航

    精工 Agent
    ├── 研发任务工作台（保留）
    ├── 项目交付作战中心
    │   ├── 经营总览
    │   ├── 项目台账
    │   ├── 项目作战舱
    │   ├── 人员与交付组
    │   ├── 验收与回款
    │   ├── AI 巡检
    │   └── 经营分析
    ├── MES/WMS 现场智能诊断中心
    │   ├── 诊断队列
    │   ├── 诊断工作区
    │   ├── 证据中心
    │   ├── 根因与修复验证
    │   └── 案例与知识
    ├── 专家中心（复用）
    ├── 操作手册/知识库（复用）
    └── 设置（复用）

模块名称从“交付工作台”改为“项目交付作战中心”，从“现场问题排查中心”改为“MES/WMS 现场智能诊断中心”。旧路由做兼容跳转，避免收藏和已有入口失效。

### 6.2 项目交付作战中心

| 页面 | 首屏信息 | 关键操作和状态 |
| --- | --- | --- |
| 经营总览 | 时间范围、第二战区/交付组筛选；项目数、红黄项目、延期项、待验收金额、计划/实际回款、负荷超限数；例外队列和经营趋势 | KPI 点击下钻到对应台账筛选；“数据完整度”展开未录入金额/工时/负责人；任何异常行可定位项目和记录；页面保留规则健康与 AI 发现两种标记 |
| 项目台账 | 项目/客户/系统版本/组别/阶段/经理/健康/进度/延期/验收/回款/最近更新 | 多条件筛选、列显隐、保存常用筛选；创建项目；打开项目作战舱；批量变更只允许经确认字段，归档需确认；未建立商业数据显示“未记录” |
| 项目作战舱 | 项目基本信息、健康原因、计划偏差、未关闭问题、关联诊断、待验收/回款、组别和责任人 | 顶部固定项目上下文；标签页：总览、里程碑与任务、问题与风险、现场诊断、会议决策、资料知识、验收回款、报告活动；行级新增、编辑、关联和跨中心跳转 |
| 人员与交付组 | 交付组切换、周期、人员任务数、剩余估算工时、可用工时、负荷率、缺工时数、项目分布、已确认验收产值 | 从人员行进入工作日志或任务；容量计划按人/周录入；负荷仅有完整分子分母时显示百分比；支持“未分配”和“数据不全”筛选 |
| 验收与回款 | 验收事项、计划/实际日期、计划/确认金额、证据来源；回款分期、应收计划、实收流水、逾期天数、剩余金额 | 分段筛选、录入验收/收款、登记分笔到账、附来源、从项目打开；确认事实与 AI 推测分离；改金额/日期保留活动记录 |
| AI 巡检 | 巡检范围和数据预览、最近运行、事实发现项、待确认项、缺失数据项 | 先预览后运行；可取消；发现项接受/驳回/暂缓；接受后创建业务草稿再人工保存；失败和 stale 显示原因与重跑入口 |
| 经营分析 | 按周期、交付组、经理、客户、产品筛选的进度、延期、验收、回款、工时和产能趋势 | 公式/口径查看；切换计划/已确认/实际；缺失数据可展开；生成带 hash 的草稿报告，编辑、保存、导出；不做未校准排名 |

### 6.3 人员工作台与责任显示

人员筛选视图分为“项目经理履责”“实施工作负荷”“交付组产值/容量”三个固定标签，避免把多种指标合并成一个分数。

- 项目经理履责：所负责项目的健康变化、到期里程碑、责任未明确项、超过约定周期未更新项目、客户等待、验收计划覆盖率、回款计划覆盖率、已处理巡检发现数。
- 实施工作负荷：周期任务数、剩余估算工时、已登记工时、可用工时、跨项目分布、阻塞时长、等待客户/研发时长。
- 交付组产值与资源：确认验收金额按实际验收日期归组、计划验收额、组容量、负荷区间、未分配工作。项目组调整应记录生效日，不追溯篡改已经确认的历史归属。

人员标签相同但可能是不同人的情况下，提供手工身份备注和去重提醒，不合并其数据。后续接入用户目录属于独立架构决策。

### 6.4 现场智能诊断中心

| 页面 | 首屏信息 | 关键操作和状态 |
| --- | --- | --- |
| 诊断队列 | 诊断编号、问题摘要、项目/客户、MES5/MES6/WMS与版本、优先级、队列状态、负责人、当前阶段、等待时长、最近证据 | 按项目、产品、状态、优先级、负责人、阶段筛选；新建案件；从 DeliveryIssue 导入复用；无项目历史案件列入待关联 |
| 诊断工作区 | 固定问题摘要与项目上下文；左侧排查步骤，中部 AI 运行阶段，右侧证据/根因快照 | 补充问题、选择来源、切换专家、预览执行快照、开始/取消/重试阶段；步骤反馈直接进入证据关系；离开页面后运行在后台可恢复 |
| AI 排查过程 | 受理、资料收集、分诊、专家路由、主专家计划、专项专家、交叉验证、下一步生成各阶段状态和输出摘要 | 展开阶段查看专家/Runtime/模型标识、来源、耗时、请求数、输入输出 hash；失败阶段可重试；无需输入时暂停等待工程师 |
| 证据中心 | 文件名、证据类型、来源、项目/案件、hash、脱敏/解析状态、上传人标签、关联步骤/假设/修复 | 导入、脱敏预览、补充文字、打开/删除、挂接到步骤/假设；SQL、日志、API、配置、代码摘录采用只读文本证据类型 |
| 根因分析 | 根因假设及置信度、支持证据、反证、缺口、验证步骤、工程师确认状态 | 添加反证、建立验证步骤、确认/驳回/标记未知；确认人和时间写入审计；未验证假设不能显示成根因结论 |
| 修复验证与开发任务 | 已确认根因、修复方案、版本、开发草稿、复现步骤、测试方法、验证结果、回归建议 | 生成草稿、人工编辑/导出；选择构建、测试、现场复测记录；失败重开；关闭前要求根因状态和验证风险均可见 |
| 案例与知识 | 草稿、审核中、已批准、退回；产品/版本/项目范围、脱敏状态、引用来源 | 从诊断结案生成案例；共享范围选择；审核人校验复现和验证证据；审核通过后进入现有知识检索 |

### 6.5 跨中心交互规则

- 从项目作战舱打开诊断时，传 deliveryProjectId；从交付问题打开时再传 deliveryIssueId。
- 从诊断工作区返回项目时，恢复项目 ID、工单 ID、原页面标签和筛选条件。
- 诊断转开发草稿时携带案件 ID、项目 ID、确认根因、已审查证据和修复验收条件。外部 Jira 或研发 Session 只在用户确认关联后创建。
- 人员、项目、经营摘要跳转都使用稳定 ID。禁止把 UI 名称和聊天历史作为关联键。
- AI 巡检发现如“里程碑日期缺失”可以生成任务草稿，但不能静默更新计划、实际验收或回款记录。

## 7. AI 专家协作与工具调用

### 7.1 专家路由

路由候选来自启用且通过 Runtime 兼容性检查的 ExpertProfile。版本、contentHash、工作流、步骤、来源、skillTags、输出契约和检查要求进入运行快照。

匹配顺序：

1. 项目产品类型及具体版本范围。
2. 问题模块、业务流程、问题类别。
3. 证据类型：SQL/数据、日志/性能、API/集成、配置/环境、代码/缺陷。
4. ExpertProfile 诊断能力标签和已有 skillTags。
5. 专家角色和 profile checks 对应阶段。

无显式能力标签的旧 ExpertProfile 可由规则基于现有名称、技能标签和配置内容给出弱匹配。界面需显示匹配依据、命中规则和不确定性，并支持人工覆写。开发阶段应避免把对专家名称的关键词匹配误当成稳定领域契约；由专家中心维护可编辑的产品/领域/阶段标签。

### 7.2 有界协作流程

| 阶段 | 调用者 | 输入 | 输出 |
| --- | --- | --- | --- |
| 情况梳理 | 主诊断专家 | 用户描述、项目/版本、关联问题、已选证据 | 结构化事实、缺失问题、影响范围、初始假设 |
| 排查计划 | 主诊断专家 | 确认事实、手册与已审核知识 | 3–8 个只读或人工执行步骤、预期正常/异常信号、分支条件 |
| 专项分析 | 最多两个适用的专项专家，按需串行 | 对应类型证据的最小上下文 | SQL 静态审查、日志模式、API 契约/响应、配置差异或代码调用链发现 |
| 交叉审查 | 主专家或验证专家 | 专项发现、来源 refs、反证 | 冲突点、证据缺口、可信度变化和下一步验证 |
| 结论与任务草稿 | 主诊断专家 | 已确认的人类反馈、有效证据、审核案例 | 根因候选/未知、修复建议、开发任务草稿、现场验证标准 |

初始产品每次运行最多一个主专家、两个专项专家、一个结论审查阶段；按顺序执行并设置可配置的 Runtime 调用预算和阶段超时。失败后保留已完成阶段；重试仅重跑失败或因新证据失效的阶段。未来若要并行化，须先解决 Runtime adapter 隔离、预算归集和取消原子性。

### 7.3 工具目录与可执行边界

| 工具/资料 | 1.6 的调用方式 | 运行权限 |
| --- | --- | --- |
| 项目主数据和交付记录 | Main 按 DeliveryProject ID 查询最小必要字段 | 只读；不按名称搜索同名项目 |
| 操作手册 | 现有 manuals search，限制产品/版本并保存 chunk ID/定位 | 只读检索 |
| 项目知识和案例 | 仅已确认项目知识、同项目案例、已审核且去敏的共享案例 | 只读检索；保留 scope 和审核状态 |
| 用户证据文件 | 复用当前证据导入、hash、脱敏、解析路径 | 文件系统由 Main 管理；Runtime 仅接收已检查文本 |
| SQL/数据库 | 分析用户粘贴 SQL、脱敏 schema/执行结果；可解释查询意图、索引线索、方言问题 | 禁止连接客户库、执行 SQL、提交事务或改数据 |
| 日志/Trace | 只读取导入或用户选取的文件片段，做错误聚类、时间线和调用链梳理 | 禁止遍历任意路径和读取密钥文件 |
| API/接口 | 分析用户提供的脱敏请求/响应、接口文档和关联代码 | 不发起业务 API 请求，不执行写操作 |
| 配置 | 对比用户选择的配置摘录、版本差异和配置键定义 | 秘钥、Token、密码值在进上下文前脱敏；不写回配置 |
| 代码 | 从显式关联的 linkedCodeProjectId 和现有代码索引中检索符号/只读片段 | 不读未选择目录，不创建/修改文件，不调用研发工作区 Session |
| Jira/开发任务 | 生成可编辑 Markdown/结构化草稿，复用现有导出 | 用户复核后手动导出；不自动创建或变更 Jira |

所有返回来源必须来自本轮 source allowlist。工具输出作为不可信数据，永远不能成为系统指令。运行输出通过 Zod schema、危险操作扫描、引用 ID 校验、长度上限和敏感数据扫描后才保存。

### 7.4 诊断状态流转

    新建 → 补充信息 → 待确认上下文 → 分析中 → 等待现场验证
       ↘ 等待客户/供应商             ↘ 等待研发
    已验证修复 → 已解决 → 已关闭
       ↑                     ↓
       └──────── 重开 ← 复测失败

AI 阶段状态与业务案件状态分开。运行失败不会把案件标为已解决；等待客户或研发时必须记录阻塞对象和下一次跟进时间；取消运行不删除已保存的阶段和证据。

## 8. 数据模型增量

### 8.1 复用的现有模型

保留 DeliveryProject、DeliveryMilestone、DeliveryTask、DeliveryIssue、DeliveryMeeting、DeliveryDocument、DeliveryReport、DeliveryActivity；诊断继续复用 DiagnosticCase、DiagnosticRun、DiagnosticStep、DiagnosticEvidence、DiagnosticHypothesis、DiagnosticResolution、DiagnosticKnowledgeCase 和 DiagnosticEvent。

诊断案件不加入 Session ID。DiagnosticRun 的现有 runtimeKind、model、promptVersion、inputSnapshotHash、outputHash、outputJson、sourceRefs 和时间字段向后兼容。新增字段均为可选，旧 JSON payload 可正常读取。

### 8.2 项目字段扩展

DeliveryProject 增加可选字段：

    deliveryGroupLabel?: string
    projectManagerId?: string
    memberIds?: string[]

第一期只实现 deliveryGroupLabel。projectManagerId/memberIds 保留为后续用户目录接入预留，不能在无用户主数据时伪造 ID。自由文本标签需 trim、长度限制、列表建议和变更审计。

### 8.3 新增业务对象

#### DeliveryAcceptancePlan

    id: string
    deliveryProjectId: string
    title: string
    plannedDate?: string
    plannedAmountMinor?: number
    acceptedDate?: string
    acceptedAmountMinor?: number
    currency?: string
    status: 'planned' | 'ready' | 'accepted' | 'delayed' | 'waived'
    sourceRefs: DeliverySourceRef[]
    deliveryGroupLabelAtAcceptance?: string
    note?: string
    createdAt: string
    updatedAt: string
    acceptedByLabel?: string

验证规则：accepted 时需有日期、确认金额或明确标注“金额不适用”，并至少有一条验收来源或人工确认说明。已确认金额修改生成活动记录并保留前后值。

#### DeliveryCollectionPlan

    id: string
    deliveryProjectId: string
    title: string
    plannedDate?: string
    plannedAmountMinor?: number
    currency?: string
    status: 'planned' | 'due' | 'partially_collected' | 'collected' | 'overdue' | 'cancelled'
    receipts: Array<{ id: string; receivedDate: string; amountMinor: number; sourceRefs: DeliverySourceRef[]; note?: string }>
    sourceRefs: DeliverySourceRef[]
    note?: string
    createdAt: string
    updatedAt: string

剩余计划额 = max(计划金额 − 已登记收款分笔金额之和, 0)。收款额超出计划额时允许保存并显著提示，不静默截断；需人工复核币种、冲销或计划变更。

#### DeliveryWorkLog

    id: string
    deliveryProjectId: string
    taskId?: string
    personLabel: string
    deliveryGroupLabel?: string
    workDate: string
    hours: number
    workType: 'implementation' | 'development' | 'testing' | 'customer_support' | 'travel' | 'other'
    summary: string
    source: 'manual' | 'task_estimate_adjustment'
    createdAt: string
    updatedAt: string

工时按 0.25 小时步长，必须为正数并限制单日总量异常提示。该记录是人工登记工时，不是考勤或薪酬数据。

#### DeliveryCapacityPlan

    id: string
    personLabel: string
    deliveryGroupLabel?: string
    weekStartDate: string
    availableHours: number
    sourceRefs: DeliverySourceRef[]
    note?: string
    createdAt: string
    updatedAt: string

负责人按周维护可投入交付时数。没有容量计划时不计算负荷率，不能拿标准工时或日历日估算代替。

#### DeliveryInspectionRun

    id: string
    scope: 'portfolio' | 'project'
    deliveryProjectId?: string
    inspectionType: 'rules' | 'business_summary' | 'delay' | 'acceptance_collection' | 'capacity'
    status: 'preview' | 'running' | 'succeeded' | 'stale' | 'failed' | 'cancelled'
    runtimeKind?: RuntimeKind
    providerId?: string
    model?: string
    promptVersion: string
    rulesVersion: string
    snapshotHash: string
    sources: Array<{ entityType: string; entityId: string; label: string; updatedAt?: string }>
    findings: Array<{
      id: string
      category: string
      severity: 'critical' | 'high' | 'medium' | 'low' | 'info'
      statement: string
      basis: 'rule' | 'ai_hypothesis'
      sourceRefs: string[]
      confidence?: 'high' | 'medium' | 'low'
      suggestedAction?: string
      status: 'open' | 'accepted' | 'dismissed' | 'resolved'
      reviewNote?: string
      reviewedByLabel?: string
      reviewedAt?: string
    }>
    startedAt: string
    completedAt?: string
    errorSummary?: string

### 8.4 SQLite 与迁移策略

当前 LocalStore schemaVersion 为 25，交付和诊断数据已采用关系索引列加 JSON value 的方式。增量建议：

- 版本 26：新增 delivery_acceptance_plans、delivery_collection_plans、delivery_work_logs、delivery_capacity_plans、delivery_inspection_runs。每张表至少包括 id、project_id、updated_at、value；按常见筛选增加 group/person/date/status 索引。
- 保留现有主键和外键模式，新增项目子记录表对 delivery_projects 使用外键；归档不删除。确认删除策略前不得改变既有 ON DELETE 行为。
- 版本 27（按需）：扩展诊断阶段/工具事件索引。如果阶段状态仅存 DiagnosticRun JSON 且查询和恢复可满足需求，则不建新表。
- 物理列只用于列表筛选、排序、幂等和约束，领域对象完整字段继续放在 JSON payload。迁移必须在现有旧数据库副本上验证，包含 schema 25 和存在历史无项目案件的样本。
- 对每条记录执行项目存在、未归档可写、同项目 task/issue 关系校验；多人并发或 IPC 重试时使用稳定 idempotencyKey 防止重复创建。

## 9. 接口契约增量

所有接口保留当前 deliveryWorkbench 与 diagnostics 命名空间，通过 Preload 暴露最小 API。输入使用 Zod strict schema；Renderer 不访问 SQLite、模型密钥或任意文件路径。

### 9.1 交付接口

    deliveryWorkbench.portfolioSnapshot({
      startDate?: string,
      endDate?: string,
      deliveryGroupLabel?: string,
      projectManager?: string,
      systemType?: 'MES5' | 'MES6' | 'WMS' | 'OTHER'
    }) -> DeliveryPortfolioSnapshot

    deliveryWorkbench.getPeopleCapacity({
      startDate: string,
      endDate: string,
      deliveryGroupLabel?: string
    }) -> DeliveryPeopleCapacitySnapshot

    deliveryWorkbench.listAcceptancePlans({ deliveryProjectId?: string, status?: string }) -> DeliveryAcceptancePlan[]
    deliveryWorkbench.saveAcceptancePlan(projectId, input) -> DeliveryAcceptancePlan
    deliveryWorkbench.listCollectionPlans({ deliveryProjectId?: string, status?: string }) -> DeliveryCollectionPlan[]
    deliveryWorkbench.saveCollectionPlan(projectId, input) -> DeliveryCollectionPlan
    deliveryWorkbench.addCollectionReceipt(projectId, planId, input) -> DeliveryCollectionPlan
    deliveryWorkbench.listWorkLogs(filter) -> DeliveryWorkLog[]
    deliveryWorkbench.saveWorkLog(projectId, input) -> DeliveryWorkLog
    deliveryWorkbench.listCapacityPlans(filter) -> DeliveryCapacityPlan[]
    deliveryWorkbench.saveCapacityPlan(input) -> DeliveryCapacityPlan

    deliveryWorkbench.previewInspection(input) -> DeliveryInspectionPreview
    deliveryWorkbench.runInspection(previewHash) -> DeliveryInspectionRun
    deliveryWorkbench.listInspectionRuns(filter) -> DeliveryInspectionRun[]
    deliveryWorkbench.reviewInspectionFinding(runId, findingId, decision) -> DeliveryInspectionRun

DeliveryPortfolioSnapshot 必须同时返回原始计数、分母、缺失项数量、计算时间和筛选条件；负荷、产值、回款等指标附口径版本与来源覆盖率。不得只返回格式化后的 KPI 字符串。

### 9.2 诊断接口

    diagnostics.executionOptions(product) -> {
      runtimes: Array<{ runtimeKind, providerId, providerName, models, available, reason? }>,
      experts: Array<{ profileId, name, version, contentHash, compatible, matchReasons, confidence }>
    }

    diagnostics.previewOrchestration(caseId, selection) -> {
      inputSnapshotHash,
      selectedExperts: Array<{ profileId, version, contentHash, role, reason }>,
      stages: Array<{ stageId, title, expertProfileId, sourceRefs, estimatedRequests }>,
      sources: Array<{ id, title, locator?, version?, trust, excerpt, selected }>,
      missingInformation: string[],
      warnings: string[],
      runtime: { runtimeKind, providerId, providerName, model }
    }

    diagnostics.startOrchestration(caseId, inputSnapshotHash) -> { runId, status }
    diagnostics.getRun(runId) -> DiagnosticRunDetails
    diagnostics.cancelRun(runId) -> { runId, status }
    diagnostics.retryStage(runId, stageId, inputSnapshotHash) -> { runId, stageId, status }
    diagnostics.subscribeRunEvents(listener) -> unsubscribe
    diagnostics.saveDeveloperTaskDraft(caseId, input) -> DiagnosticDeveloperTaskDraft
    diagnostics.recordVerification(caseId, input) -> DiagnosticResolution

现有 previewAnalysis/runAnalysis 保留兼容，作为新编排入口的旧单阶段适配。不能为了新工作区移除旧档案运行记录。新 run 的每个阶段均持久化专家快照、来源、输入/输出 hash、状态、耗时和错误摘要；运行事件不携带密钥和原始未脱敏附件内容。

### 9.3 事件契约与错误

    DiagnosticRunEvent = {
      runId, caseId, sequence, stageId,
      status: 'queued' | 'running' | 'succeeded' | 'needs_input' | 'failed' | 'cancelled',
      occurredAt, title, safeSummary?, sourceRefs?, errorCode?
    }

事件通过 IPC 订阅并以 sequence 去重。Renderer 重连后调用 getRun 拉取持久态，再订阅新事件。运行完成、取消、失败都应写终态；重复 start 使用客户端 requestId 幂等。stale 预览不能执行，原因包括项目、案件、来源、专家 profile hash 或 Runtime 配置变化。

## 10. 旧功能处理清单

| 旧功能/入口 | 处理方式 | 1.6 说明 |
| --- | --- | --- |
| 交付工作台 | 改名并重组为项目交付作战中心 | 保留稳定 URL/IPC 兼容入口，默认首页改成经营总览 |
| 项目概览总览卡 | 改造 | 现有事实 KPI 保留，增加明确数据覆盖、验收回款和容量指标 |
| 项目台账 | 保留并扩展 | 增加交付组、商业计划摘要、责任与延期状态 |
| 项目作战舱 | 保留并扩展 | 新增验收回款、工时和诊断摘要入口，现有会议/资料/报告不迁移 |
| 里程碑、任务、问题、会议 | 保留 | 扩展任务估算工时、依赖分类需单独评估，不复制一套计划对象 |
| 工作量视图 | 新增 | 只读取显式估算、日志与容量数据 |
| 验收和回款 | 新增 | 计划追踪功能，不声称替代财务/ERP/合同系统 |
| AI 巡检 | 新增 | 规则事实与 AI 假设分层，保留人工确认 |
| 周报和风险报告 | 改造 | 复用 DeliveryReport；增加经营模板和 snapshotHash，标记报告草稿与数据截止时间 |
| 现场问题排查中心 | 改名并重组 | 旧路由可跳转，旧过滤和案件入口保留 |
| 诊断队列 | 保留并增强 | 增加当前阶段、等待时长、项目/交付组筛选 |
| 诊断工作区 | 改造 | 由单一任务按钮变为可恢复的 AI 分阶段编排 |
| 分诊、计划、重计划、根因分析 | 保留兼容并纳入编排 | 旧 DiagnosticRunKind 可映射到编排阶段，不删历史 |
| 证据、步骤、假设、解决记录 | 保留并统一呈现 | 继续复用文件安全、hash、脱敏、来源引用和人工确认 |
| 开发草稿 | 改造 | 生成结构化草稿，人工编辑后导出，不自动创建 Jira 或 Session |
| 案例审核与知识搜索 | 保留 | 继续只跨项目检索批准且脱敏的案例 |
| ExpertProfile | 保留并扩展元数据 | 增加产品/诊断域/阶段能力标签，不另建专家目录 |
| ExpertCollaboration | 现状保留，诊断运行不直接调用 | 它依赖 Session/Agent Task；独立诊断由专用协调器复用 ExpertProfile 定义 |
| 聊天历史项目关联 | 废弃为业务关联来源 | 不从标题、路径和会话摘要推断项目或问题 |
| 自动生产 SQL/API/服务器操作 | 废弃 | 只提供经过风险约束的分析和人工操作步骤 |
| 无来源的 AI 经营数值与个人总分 | 废弃 | 每个数字提供公式、分母、来源及覆盖率 |
| 项目/诊断第二套主数据 | 废弃 | 两中心共享 DeliveryProject，以稳定 ID 显式关联 |

## 11. 分阶段开发路线

每阶段独立可验收，先有数据口径和可读体验，再加 AI 编排。阶段之间通过新增兼容 DTO 和 API 渐进实现，不一次性替换现有页面或数据库。

### 阶段 0：规格确认与样本清点

目标：把原型中的业务字段、项目样本、指标来源和权限边界落实到开发任务。

范围：

- 检查当前 HEAD、现有未提交诊断改动、1.5 方案及 schema 25。
- 由业务负责人确认交付组命名、金额来源、验收状态、收款记录口径、工时粒度和周产能维护角色。
- 形成字段映射与旧数据兼容测试样例。

验收：不改生产逻辑；完成确认表和样例 JSON；明确缺失字段显示策略。

Codex 开发指令：

    仅开展设计确认工作，不改生产代码。检查本仓库当前分支和工作区，逐项核对 docs/1.6 产品设计与技术方案.md 中的指标口径、DeliveryAcceptancePlan、DeliveryCollectionPlan、DeliveryWorkLog、DeliveryCapacityPlan 字段与现有项目数据。输出一份开发前字段决策记录，列出必须由产品/交付负责人确认的问题和可直接实现的默认值。不要改写 1.5/1.6 文档，不要覆盖工作区已有修改。

### 阶段 1：项目经营基础数据与汇总

目标：增量落地交付组、验收/回款计划、工时和容量数据，不引入 AI。

范围：

- DeliveryProject 增加可选 deliveryGroupLabel。
- schema 26 增加验收、收款计划、工时日志和容量计划 JSON 表及必要索引。
- 新增严格 Zod IPC、Preload 类型接口、领域模型和表单校验。
- 保持原项目页面和诊断页面正常工作；迁移时老项目默认组别为空，不补造金额和工时。

验收：

- schema 25 数据原样升级；回滚或重复启动不重复迁移。
- 新增记录校验项目、日期、币种、金额和工时边界。
- 归档项目可读历史但不可新增记录；并发重复提交有幂等保护。
- 新增领域规则测试覆盖分笔收款、超计划收款、跨币种拆分、零容量、缺失容量和已归档项目。

Codex 开发指令：

    按 docs/1.6 产品设计与技术方案.md 阶段 1 实施。先检查现有 DeliveryProject、LocalStore schema 迁移、delivery IPC、Preload、领域测试各 2 至 3 个同类实现，并保留所有工作区已有修改。只新增 deliveryGroupLabel、验收计划、回款计划/分笔收款、工作日志、周容量计划及对应窄接口，不做页面大改、不引入登录系统、不接外部财务或 HR。按现有 JSON value + 必要索引方式迁移 schema 25。补齐严格校验、活动记录、幂等处理、旧数据兼容测试。运行目标测试和 npm run build，报告实际结果、影响文件和未解决项。

### 阶段 2：经营总览、台账与人员负荷

目标：让第二战区和交付组可按来源数据管理项目组合。

范围：

- 新经营总览与台账筛选、可解释 KPI、未录入数据面板。
- 项目作战舱增加商业计划和工时摘要。
- 人员/交付组视图与产值、负荷公式。
- 保留活动记录、报表导出；加日期周期和筛选快照。

验收：

- 所有 KPI 能下钻到源记录；交叉币种不求和；空分母不显示 0%。
- 已确认验收产值按实际验收日期和验收时组别标签归属。
- 项目经理履责不生成综合 AI 分数，外部依赖显示分类和等待龄期。
- 1366×768 和窄窗口页面无横向溢出，长中文文本不覆盖按钮。

Codex 开发指令：

    按 docs/1.6 产品设计与技术方案.md 阶段 2 重新组织交付中心 Renderer。先读取当前 DeliveryWorkbenchPage、DeliveryDashboard、样式和相关 smoke tests，沿用现有 React/TypeScript 模式。以现有 API 与阶段 1 数据为事实源，实现经营总览、项目台账、人员/交付组负荷和项目作战舱增量页面。每项金额、工时和比例显示口径、来源覆盖率并可下钻。不要用 mock 数据补生产缺失项，不做个人总分或自动排期。补充交互测试及桌面 smoke 检查，运行 npm test、npm run build、npm run test:desktop，并说明未覆盖项。

### 阶段 3：AI 巡检与经营分析

目标：基于可复算事实输出带来源的巡检发现和分析草稿。

范围：

- 先实现规则巡检，再在预览快照中加入 AI 摘要和待验证解释。
- 巡检记录、finding 状态、snapshotHash、prompt/rule 版本与人工审核动作。
- findings 转任务/风险的用户确认流程。

验收：

- AI 不能写回 DeliveryProject 或商业计划；只有用户确认的业务保存 API 执行写入。
- 缺数据、超预算、Runtime 不可用、取消、stale 与失败有明确状态。
- 报告可复现来源范围和时间；运行失败不丢失预览快照。

Codex 开发指令：

    按 docs/1.6 产品设计与技术方案.md 阶段 3 实施 DeliveryInspectionRun。先检查现有 deliveryReportDraft 和 diagnostics preview/hash 模式，复用主进程 Runtime 与模型配置，不读取聊天记录。先做确定性规则，再做只读 AI 解释。实现来源 allowlist、脱敏预览、长度/调用预算、结构化 schema、运行取消/stale/错误持久化和人工 finding 审核。AI 结果只能生成编辑草稿，不得直接修改任务、项目或验收回款。补齐规则、输入快照变更、危险输出和旧 schema 测试，运行 npm test 与 npm run build。

### 阶段 4：诊断运行工作区与专家自动选择

目标：先把现有单阶段诊断组织成独立、可见、可恢复的诊断运行。

范围：

- 专家能力标签与推荐原因、Runtime/provider/model 选项和预览确认。
- DiagnosticRun 阶段状态和事件、断线重连、取消及失败阶段重试。
- 新工作区显示资料选择、专家/模型、阶段过程和已存在证据。
- 第一版默认主专家 + 至多两个专项专家串行协作。

验收：

- 不创建或读取 Session，不使用 expert-collaboration 的 Session 型运行对象。
- 诊断每阶段结果可持久恢复，旧运行仍能显示。
- 运行预览 hash 覆盖专家版本、Runtime、案件和来源；变化后拒绝 stale 执行。
- 专家自动选择展示原因，可人工改选，运行留痕。

Codex 开发指令：

    按 docs/1.6 产品设计与技术方案.md 阶段 4 实施独立诊断编排。先检查 ExpertProfile、expert-center、expert-collaboration 与 diagnostics-ipc 当前源码和未提交差异。复用 ExpertProfile 版本、工作流、技能标签、输出/检查要求、现有 manuals/知识检索、Runtime adapter 和受控输出校验。诊断编排不得依赖 Session、聊天历史或 AgentTask。增加可选诊断能力标签、ExecutionOptions、previewOrchestration、阶段持久化/事件、幂等启动、取消和失败重试。专家串行调用并有调用预算；每阶段保存 source refs 和 hash。保留旧 previewAnalysis/runAnalysis 兼容。不得触碰用户未提交代码语义，先理解并共同工作。补充旧 schema、stale hash、取消重启和来源引用测试，运行完整测试与 build。

### 阶段 5：证据、根因、修复验证与案例闭环

目标：让实施工程师从问题描述走到可审查的修复与案例。

范围：

- 证据中心分类、来源定位、步骤/假设/修复关系。
- 专家根据新增反馈生成后续步骤；人类逐步确认根因。
- 开发任务草稿、验证记录、重开与案例脱敏审核。
- SQL、日志、API、配置和代码分析采用用户提供/明确授权的只读来源。

验收：

- AI 假设不能自动变成已验证根因；无证据时可结案为未知但须记录原因。
- 删除附件后所有引用显示 tombstone 状态，不导致运行历史损坏。
- 复测失败可重开且保留每次运行、根因和验证历史。
- 共享案例跨项目检索必须已审核、去敏、产品版本匹配。

Codex 开发指令：

    按 docs/1.6 产品设计与技术方案.md 阶段 5 改造 DiagnosticsPage。复用现有案件、步骤、证据、假设、resolution、developer draft、案例审核和受管文件逻辑，建立证据中心、根因工作区、修复验证和案例页面。只增加必要的证据类型元数据和关系，不复制文件存储。每个根因必须区分 AI 假设与工程师确认，验证失败支持 reopen 并保留历史。SQL/日志/API/配置/代码只能分析用户提供或明确选择的只读内容，不连接现场库、不执行命令或 API。补充 IPC 契约测试、附件删除、敏感字段脱敏和案件闭环测试，运行完整测试、build 和 desktop smoke。

### 阶段 6：试点、指标校验和逐步替换

目标：用一个交付组和受控诊断样本验证工作流程和指标，再逐模块替换旧界面。

范围：

- 真实样本脱敏后校验指标公式和数据覆盖率。
- 观察 AI 路由命中率、人工改派率、无效证据率、建议采纳率、诊断闭环时间。
- 与业务负责人共同校验 PM/实施/组别显示不构成考核误用。
- 保留旧页面短期并提供回退开关，迁移稳定后移除旧入口组件但保留数据/API 兼容。

验收：

- 用交付组、项目经理、实施三种视图分别核对同一批数据和公式。
- 诊断能在无 Session 的新建、重开、长时间暂停、取消后重试路径中完成。
- 无重复项目主数据和无聊天历史依赖的回归测试。

Codex 开发指令：

    按 docs/1.6 产品设计与技术方案.md 阶段 6 执行受控试点。不得导入未脱敏的客户现场数据到测试仓库，不得改变生产记录。准备可删除的本地样本库，对照人工核算验收、回款、负荷和延期指标。检查无 Session 的诊断新建、断线恢复、取消重试、跨模块项目关联和审核案例检索。输出试点缺陷与公式偏差报告。只有产品负责人确认可替换后，才移除旧页面入口，旧 API/数据保留兼容。

## 12. 开发与验收共同准则

- React/Electron/TypeScript 写法跟随仓库现有模块；先看同类组件、Zod、IPC 和迁移实现。
- 生产逻辑迭代以最小增量为原则，避免大规模搬迁、格式化或删除旧接口。
- 所有项目与诊断操作校验 ID 和归档状态；涉及跨项目操作必须由 Main 重新校验。
- 金额、工时、比例和健康状态有公式、分母、来源、时间窗口和数据完整度。
- 单元测试覆盖业务公式、schema 迁移、IPC 校验、幂等、取消、stale、脱敏、来源 allowlist 和历史 JSON。
- UI 测试覆盖筛选/跳转/确认/取消/重开/空状态/错误状态和 1366×768 布局。
- 开发阶段至少执行 npm test、npm run build 与 npm run test:desktop。外部 Runtime 未真实配置时，不以模拟输出宣称 Runtime 端到端验证通过。
- 原型演示数据均为静态样例，不能导入生产数据库。

## 13. 原型操作说明

打开配套 HTML 文件即可浏览，无需开发服务器或依赖安装。左侧可切换交付中心与诊断中心的核心页面；页面控件演示筛选、项目切换、巡检、工作区标签、诊断阶段、证据查看、根因确认、修复验证、开发草稿和案例审核。原型内数字均为交互演示样例，不是当前仓库或第二战区真实经营数据。

## 14. 已知决策与待业务确认

方案先采用“交付组手工标签、以已确认验收金额作为交付产值、手工登记分笔收款、按周维护可用工时”的最小可行口径。真实登录身份、财务凭证集成、合同金额自动导入和自动排期没有当前代码基础，暂不假定已存在。

进入阶段 1 前需要业务负责人确认：

1. 第二战区是否采用固定交付组字典，还是允许受控自由标签。
2. 验收金额是否能代表内部交付产值，是否需要单独的产值认定字段。
3. 收款计划是否需要区分开票、应收、到账、冲销等状态。
4. 工时最小粒度、填报周期、人员/项目经理审核责任。
5. 项目组别调整时，历史产值是按验收时归属还是按当前归属展示。

在确认前，原型和数据契约使用上述最小口径并显式保留来源字段，不将其描述为财务正式报表。

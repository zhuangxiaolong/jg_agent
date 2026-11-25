# 现场问题诊断中心：项目关联与独立 Runtime 改造方案

**目标分支：** `develop/desktop-poc`  
**改造性质：** 在现有诊断中心基础上做项目主线整合，不重写现有诊断引擎。  
**核心要求：** 诊断中心以交付项目为业务入口；项目数据与交付工作台保持同源；诊断 AI 独立运行，不依赖历史聊天会话。

---

## 1. 改造目标与原则

本次改造要让现场问题诊断中心成为交付工作台的一个专业诊断能力，而不是另一个独立的问题台账，也不是聊天会话的附属功能。

必须遵守以下原则：

1. **项目为主线。** 每一条新建的现场项目问题必须选择一个交付工作台中的项目。历史上没有项目归属的诊断档案保留原状，标记为“待关联项目”，由用户补关联，不允许系统擅自猜测项目。
2. **项目数据同源。** 诊断中心只能引用交付工作台的项目 ID 和项目问题 ID。不得另建一套诊断项目表，不得复制一份项目主数据。
3. **双向入口。** 用户既可以从诊断中心进入项目，也可以从交付工作台的项目/问题台账直接进入诊断中心。
4. **工单关联清晰。** 诊断档案应同时展示项目名称和关联的问题台账标题；内部保存 ID，界面不要求用户手工识别 UUID。
5. **Runtime 独立。** 现场诊断分析不选择、不创建、不依赖研发聊天会话；诊断任务只使用独立的诊断 Runtime 配置，并把执行历史保存在当前诊断档案中。
6. **沿用现有安全边界。** 保留受控分析、发送内容预览、敏感信息扫描、来源引用校验、模型输出校验、禁止现场写操作等现有安全机制。

## 2. 当前实现盘点

当前代码已经具备部分基础，不要重复开发：

- `packages/domain/src/diagnostics.ts`：`DiagnosticCase` 已有 `deliveryProjectId`、`deliveryIssueId`。
- `apps/desktop/src/main/diagnostics-ipc.ts`：创建、更新诊断档案时，已经校验交付项目存在，并校验工单属于所选项目；诊断项目列表从 `store.listDeliveryProjects(false)` 读取。
- `apps/desktop/src/main/delivery-workbench-ipc.ts`：交付工作台项目列表同样从 `store.listDeliveryProjects(...)` 读取。因此两边底层使用同一份项目数据。
- `apps/desktop/src/renderer/DiagnosticsPage.tsx`：新建和编辑弹窗里已经存在“交付项目”选择，但它默认允许不关联，且位置偏后；“项目问题进度”只显示已有诊断档案的项目。
- `apps/desktop/src/renderer/App.tsx`：已有从诊断档案跳转到交付工作台项目/问题台账的单向入口。
- `apps/desktop/src/renderer/DeliveryWorkbenchPage.tsx`：目前项目页签没有“现场诊断”入口，也没有从具体交付问题直接发起诊断的动作。
- 诊断分析目前通过 `listSessions()` 选择一个已有会话，并借用该 Session 的 Runtime、模型、推理强度和凭据配置。分析本身会在 `dataRoot/diagnostics/runtime/<runId>` 下启动独立 Runtime 运行目录，没有必要让用户选择聊天历史。

**结论：** 这是项目关联体验和 Runtime 配置耦合方式的问题，不是底层完全没有项目数据。应复用现有 `LocalStore` 和诊断数据模型，补齐 UI、导航和配置解耦。

## 3. 目标业务流程

### 3.1 从交付工作台进入诊断中心

项目详情页增加明显的“现场诊断”入口，显示当前项目的诊断概况：

- 未关闭问题数
- 严重/高优先级问题数
- 等待客户数
- 等待开发数
- 待验证数

点击入口，打开现场问题诊断中心，并自动传入当前 `deliveryProjectId`。诊断中心默认进入当前项目的问题列表，不要求用户再次搜索或选择项目。

在交付工作台的“问题与风险”台账中，每条问题增加“发起现场诊断”操作：

- 若该 DeliveryIssue 尚无诊断档案：调用现有 `importDeliveryIssue(projectId, issueId)` 创建诊断档案。
- 若已经有关联诊断档案：直接打开已有档案，不重复创建。
- 打开诊断中心时同时传入 `initialProjectId` 和 `initialIssueId`，选中对应项目和问题。

### 3.2 在诊断中心直接登记现场问题

新建问题时，表单第一部分必须是“项目归属”，放在问题标题和现象之前或紧邻其后，不能藏在表单最底部。

项目选择器展示：

- 项目编号（如有）
- 项目名称
- 客户名称
- 产品系统（MES5 / MES6 / WMS / OTHER）
- 项目阶段
- 项目经理

支持按项目编号、项目名称、客户名称搜索。

选择项目后：

- 产品系统默认从项目 `systemType` 带出；项目已经确定产品系统时，不允许出现项目为 WMS、诊断档案却默认 MES6 的错配。
- 可以选择该项目“问题与风险”台账中的具体工单。
- 工单选择器显示工单标题、类型、优先级、状态；前端提交真实 `issue.id`，不让用户手工输入 UUID。
- 允许只关联项目、不关联具体工单，因为现场发现的问题不一定已经登记在交付台账中。
- 新建项目现场问题时必须选择项目；不再默认提供“不关联项目”作为普通选项。

若项目级/产品级通用问题确实需要脱离具体项目，后续应作为明确的“产品级问题”范围单独设计，不得用一个默认空项目字段混淆现场项目问题。

### 3.3 诊断档案详情

在问题详情顶部或右侧增加独立的“项目归属”信息卡，至少展示：

- 项目编号、项目名称、客户名称
- 产品系统、项目阶段、项目经理
- 关联交付问题标题（如有）
- 项目当前状态

操作入口：

- “打开交付项目”：进入交付工作台对应项目。
- “打开项目问题”：当档案关联了具体 DeliveryIssue 时，进入对应项目并定位到该问题。
- “更换关联”：允许有权限的用户更换项目，并清除原来不属于新项目的 `deliveryIssueId`。

不应只在侧栏的一行文字中显示项目名。项目归属是诊断档案的重要业务属性，应当在详情页显著展示。

### 3.4 诊断中心的项目总览

“项目”页面必须展示交付工作台中的全部可用项目，而不只是已经存在诊断档案的项目。

每个项目卡片/行显示：

- 项目名称、客户、系统类型、阶段、项目经理
- 诊断问题总数、未关闭数、严重/高优先级数
- 等待客户、等待开发、待验证数量
- 最近问题更新时间

没有诊断档案的项目也要展示，指标为 0，并提供“登记现场问题”入口。

项目选择和项目总览的数据来源必须是交付工作台的 DeliveryProject 主数据。诊断统计通过 `deliveryProjectId` 聚合，不得创建另一套项目实体。

---

## 4. 项目与诊断档案的数据关系

### 4.1 关系定义

建议保持现有模型，不引入重复表：

```text
DeliveryProject (交付工作台项目主数据)
  id
  name
  customerName
  systemType
  stage
  projectManager
  status
      |
      | 1:N，通过 DiagnosticCase.deliveryProjectId 关联
      v
DiagnosticCase (现场问题诊断档案)
  id
  code
  deliveryProjectId   必须指向真实 DeliveryProject.id
  deliveryIssueId     可选，必须指向同一项目下真实 DeliveryIssue.id
  title
  symptom
  ...
      |
      | 1:N
      v
DiagnosticRun / DiagnosticStep / DiagnosticEvidence / DiagnosticResolution
```

### 4.2 类型和接口调整

检查并调整：

- `packages/domain/src/diagnostics.ts`
  - 新建档案的 `DiagnosticCreateCaseInput.deliveryProjectId` 改为必填。
  - `DiagnosticCase.deliveryProjectId` 暂时保留可选，以兼容历史数据；历史数据为空时前端显示“待关联项目”。
  - `DiagnosticCasePatch.deliveryProjectId` 仍支持更新，但新建校验必须要求项目 ID。
  - `DiagnosticApi.listProjects()` 返回丰富的 DeliveryProject 信息及项目工单摘要，不再只返回 `{ id, name, product, issues }` 的简化对象。优先复用 `DeliveryProject`、`DeliveryIssue` 类型。
- `apps/desktop/src/main/diagnostics-ipc.ts`
  - 项目读取继续使用 `LocalStore` 中的 DeliveryProject 主数据。
  - 对新建诊断档案强制校验 `deliveryProjectId` 必填、项目未归档。
  - `deliveryIssueId` 如填写，必须校验工单属于 `deliveryProjectId`。
  - 项目变更时，如果旧 `deliveryIssueId` 不属于新项目，必须清空并要求重新选择，不能保留错误关联。
  - 项目列表要区分“可新建关联的未归档项目”和“仅用于展示历史关联的已归档项目”。已归档项目不能用于新建档案，但历史诊断档案仍要能正确显示原项目名称。
- `apps/desktop/src/main/delivery-workbench-ipc.ts`
  - 不复制项目数据；继续使用同一套 `LocalStore` 读写。
  - 如需提供项目诊断统计，按 `deliveryProjectId` 聚合 `DiagnosticCase`，返回统计结果，不改变项目实体。

### 4.3 历史数据兼容

- 不删除或重置现有诊断档案。
- 不自动根据标题、客户名称猜测历史档案应该属于哪个项目。
- 历史档案 `deliveryProjectId` 为空时标记为“待关联项目”，提供编辑关联入口。
- 历史档案关联的项目后来被归档时，仍然显示项目名称和原关联关系；只是禁止新建档案再关联已归档项目。

---

## 5. 移除聊天会话依赖，建立独立诊断 Runtime

### 5.1 必须移除的内容

从诊断中心完整移除以下会话历史依赖：

- `DiagnosticsPage` 中的 `sessions`、`sessionId` 状态。
- `api.listSessions()` 调用和 `诊断运行会话` 下拉框。
- `DiagnosticApi.listSessions()` 类型定义。
- Preload 中的 `diagnostics.listSessions()` 暴露方法。
- IPC 中的 `diagnostics:sessions` Handler。
- `previewAnalysis(caseId, task, sessionId)` 和 `runAnalysis(caseId, task, sessionId, previewHash)` 对 sessionId 的参数依赖。
- `options.session(sessionValue)` 对已有聊天 Session 的读取依赖。

诊断中心任何页面、接口、数据库记录都不应要求一个聊天 `sessionId` 才能开展诊断。

### 5.2 独立 Runtime 配置

新增诊断专用运行配置概念，例如：

```ts
interface DiagnosticRuntimeProfile {
  runtimeKind: 'codex' | 'jinggong';
  model: string;
  reasoningEffort?: ReasoningEffort;
  credentialProfileId?: string;
}
```

要求：

- 从现有全局 AI 提供商/凭据设置中复用安全的凭据管理能力，不复制 API Key，不把密钥暴露给 Renderer。
- 诊断 Runtime 可以使用全局默认模型，也可以在诊断设置中单独指定模型；配置来源不是聊天会话。
- IPC 主进程根据 `DiagnosticRuntimeProfile` 解析凭据并启动 Runtime。
- Renderer 只能拿到 Runtime 类型、模型名称等非敏感配置。
- 不能把诊断 Runtime 配置保存在某个聊天 Session 中。
- 诊断中心打开时无需先创建或选择聊天会话。

需要先检查现有 `SettingsService`、运行时凭据解析和 Runtime 配置能力，尽量复用现有实现。不要为了诊断中心再复制一份 API Key 管理体系。

### 5.3 独立运行及运行历史

保留当前诊断引擎的独立运行方式：

- 每次分析仍然创建独立 `runId`。
- 运行目录继续位于 `dataRoot/diagnostics/runtime/<runId>`。
- 每轮分析仍保存为当前 `DiagnosticCase` 下的 `DiagnosticRun`。
- 详情页“分析记录”展示诊断任务、Runtime、模型、运行时间、状态。
- 分析只读取当前诊断档案、现场证据、项目资料、操作手册和已审核案例。
- 不读取任何聊天记录或聊天附件，不向聊天历史写入消息，不创建聊天 Session。

**重要：** “不关联会话历史”不等于删除诊断分析记录。诊断分析记录是诊断档案的一部分，必须保留并可追溯。

### 5.4 调用接口建议

将当前接口：

```ts
previewAnalysis(caseId, task, sessionId)
runAnalysis(caseId, task, sessionId, previewHash)
```

调整为：

```ts
getRuntimeProfile(): Promise<DiagnosticRuntimeProfile>
previewAnalysis(caseId, task, runtimeProfile?): Promise<DiagnosticAnalysisPreview>
runAnalysis(caseId, task, previewHash, runtimeProfile?): Promise<DiagnosticCaseDetails>
```

如果产品决定诊断中心只使用一个已配置的默认 Runtime，则可进一步简化为：

```ts
previewAnalysis(caseId, task)
runAnalysis(caseId, task, previewHash)
```

由主进程从诊断 Runtime 设置中读取配置。优先采用第二种简单方式，除非现有产品设置明确需要诊断页临时切换模型。

---

## 6. 需要重点改造的代码位置

| 文件 | 改造内容 |
|---|---|
| `apps/desktop/src/renderer/DiagnosticsPage.tsx` | 项目上下文、必选项目、新建/编辑项目工单选择、项目卡片、项目总览、移除会话选择 |
| `apps/desktop/src/renderer/DeliveryWorkbenchPage.tsx` | 项目详情增加现场诊断入口；问题与风险台账每条问题增加发起/打开诊断入口 |
| `apps/desktop/src/renderer/App.tsx` | 增加诊断中心与交付工作台之间的双向路由参数，保留返回时的项目和工单定位 |
| `apps/desktop/src/main/diagnostics-ipc.ts` | 项目必填校验、项目/工单信息读取、独立 Runtime Profile、移除 Session 读取 |
| `apps/desktop/src/main/delivery-workbench-ipc.ts` | 如需统计，增加按项目聚合诊断数据的只读接口；继续复用原项目存储 |
| `apps/desktop/src/preload/index.ts` | 更新 diagnostics API，移除 listSessions，增加 Runtime Profile 接口（如需要） |
| `packages/domain/src/diagnostics.ts` | 修改新建输入的项目必填约束、项目摘要类型、诊断 API 方法签名 |
| `packages/domain/src/delivery-workbench.ts` | 仅在需要项目统计/入口参数类型时调整，不复制诊断项目模型 |
| 相关 CSS 文件 | 更新项目选择器、项目归属卡片、项目概览与双向入口样式 |
| 相关测试 | 补充项目关联、工单导入幂等、Runtime 独立性和历史数据兼容测试 |

实现前先检查当前项目实际导出和 IPC 注册方式，按现有架构修改，不要凭本说明臆造函数名或重写已有功能。

---

## 7. 验收标准

### 项目关联

- [ ] 诊断中心项目页能看到交付工作台中的全部未归档项目，包括还没有诊断问题的项目。
- [ ] 新建现场问题必须选择交付项目。
- [ ] 选择项目后能看到其真实项目问题台账，并按标题选择工单。
- [ ] 保存后的诊断档案展示项目名称、客户、系统、项目经理和关联工单标题。
- [ ] 项目问题总览按真实 `deliveryProjectId` 统计，不出现重复项目主数据。
- [ ] 从项目详情点击“现场诊断”后，诊断中心自动进入该项目。
- [ ] 从项目问题台账点击“发起现场诊断”后，自动创建或打开对应诊断档案。
- [ ] 从诊断档案点击“打开交付项目/项目问题”后，准确返回对应项目和工单。
- [ ] 同一 DeliveryIssue 重复发起诊断，不会重复创建诊断档案。
- [ ] 历史无项目档案仍可查看、编辑并补充项目关联；归档项目的历史关联仍可正确显示。

### 独立 Runtime

- [ ] 诊断中心打开时不需要创建或选择聊天会话。
- [ ] 诊断页面不再出现“运行会话”下拉框。
- [ ] 诊断分析可以仅依靠诊断 Runtime 配置运行。
- [ ] 诊断分析不会读取聊天记录或聊天附件。
- [ ] 诊断分析不会向任何聊天 Session 写入消息。
- [ ] 不会因运行诊断而在左侧会话历史中生成新会话。
- [ ] 每次分析仍有独立 `DiagnosticRun`，并可在诊断档案中追溯。
- [ ] 现有敏感信息扫描、受控分析、模型输出校验和工具访问限制全部保留。

### 回归

- [ ] 原有诊断分诊、排查计划、根因分析、证据管理、处理结论、案例审核功能正常。
- [ ] 原有交付工作台项目、里程碑、任务、问题与风险、会议、资料和报告功能正常。
- [ ] 项目归档、项目切换、工单删除/变更等边界条件有校验，不产生悬空工单关联。

---

## 8. 给 Codex 的开发指令

请基于当前仓库 `zhuangxiaolong/jg_agent` 的 `develop/desktop-poc` 分支，直接实现本文件定义的“现场问题诊断中心项目关联与独立 Runtime 改造”。

执行要求：

1. 先阅读 `AGENTS.md`、`packages/domain/src/diagnostics.ts`、`packages/domain/src/delivery-workbench.ts`、`apps/desktop/src/renderer/DiagnosticsPage.tsx`、`apps/desktop/src/renderer/DeliveryWorkbenchPage.tsx`、`apps/desktop/src/renderer/App.tsx`、`apps/desktop/src/main/diagnostics-ipc.ts`、`apps/desktop/src/main/delivery-workbench-ipc.ts`、`apps/desktop/src/preload/index.ts`。
2. 先梳理现有项目数据、工单数据、Runtime 配置和凭据解析方式，复用同一套 DeliveryProject 主数据及已有安全能力。
3. 不允许新建第二套项目主数据表；不允许将项目名称作为关联主键；必须使用稳定的项目 ID 和工单 ID。
4. 不允许用 Session ID 作为诊断分析运行的前置条件；不允许通过读取聊天历史来构造诊断上下文；不允许把诊断结果写入聊天历史。
5. 不允许删除现有诊断档案、诊断分析记录、现场证据和处理结论。历史档案无项目 ID 时按“待关联项目”兼容。
6. 保持现有受控 Runtime、安全扫描、只读工具网关、发送预览、来源引用校验等安全机制，不得为了独立运行而放宽权限。
7. 按“项目关联与双向导航 → 独立 Runtime → 测试与回归”的顺序实施。每个阶段完成后运行相关 TypeScript 检查和测试。
8. 修复所有由接口签名变更引起的调用点和测试，不要只改 UI 造成编译不通过。
9. 最终给出修改文件清单、关键实现说明、测试命令和真实测试结果。未执行的测试必须明确标注，不能声称已通过。

完成标准：第 7 节所有验收项均有对应实现或测试；若发现现有架构限制导致某项无法完成，先给出具体阻塞位置和最小兼容方案，不得静默降级。

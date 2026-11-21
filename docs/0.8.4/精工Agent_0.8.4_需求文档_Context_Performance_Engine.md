# 精工 Agent 0.8.4 需求文档：Context & Performance Engine

版本：0.8.4  
前置版本：0.8.1 Memory Engine、0.8.2 Skill Intelligence Engine、0.8.3 Agent Learning Engine  
目标：把已有 Workspace Index、Context Optimizer、Performance Telemetry 升级为统一上下文检索、预算、缓存、解释和评测体系。

## 1. 背景

精工 Agent 当前已经有 Performance Engine，而不是从零开始：

- `WorkspaceIndexService`：工作区增量扫描、文件元数据和检索。
- `ContextOptimizer`：必需文本不裁剪、可选片段去重和预算裁剪。
- `PerformanceTelemetry`：Runtime、模型首字、工具、检索、上下文构建等耗时统计。
- `SafeParallelScheduler`：受控只读并行。
- `DesktopPerformanceService`：把索引、上下文优化和 Telemetry 接入会话。

但当前上下文来源仍相对分散：开发要求、Memory、项目事实/决策、数据字典、代码片段、Skill 内容和任务历史各自注入或检索，缺少统一的来源优先级、作用域控制、预算分配和诊断解释。

## 2. 产品目标

1. 形成统一 Context Retrieval Pipeline，按当前任务检索相关 Memory、Project Fact/Decision、Skill、Dictionary、Project Resource 和代码片段。
2. 保持必需安全规则和开发规范完整，不因预算裁剪掉。
3. 只加载当前任务相关的 Skill 和项目资料，减少无关上下文。
4. 对相同工作区、Hash 和检索查询复用安全缓存，减少重复扫描和解析。
5. 让用户知道本轮上下文来自哪里、为什么加入、哪些被裁剪、预算估算是多少。
6. 通过真实性能指标和对照任务集验证优化效果。
7. 遥测不存储模型全文、隐藏推理、完整工具参数或凭据。

## 3. 非目标

- 不更换 Runtime，也不承诺改变模型本身的生成速度。
- 不引入强制云端向量数据库或每轮自动调用 Embedding API。
- 不把估算 Token 当作 Provider 实际 Token 用量。
- 不为追求短上下文而裁剪安全规范、当前用户指令或必须保留的项目约束。
- 不把全部历史会话拼接到 Prompt。
- 不改变业务执行权限、文件权限和 Skill Trust 规则。

## 4. 统一 Context 来源和优先级

### 必须完整保留（Required）

- 系统安全规则与执行边界。
- 当前会话开发要求/强制规范。
- 当前用户本轮任务。
- 当前任务契约、验收标准和显式授权。

以上内容不得由检索预算裁剪。超预算时显示 `requiredOverBudget` 并要求缩小可选上下文，不能静默截断 Required。

### 按需检索（Relevant Optional）

- 当前 Skill Snapshot 中可用 Skill 的 metadata 和本轮已加载 Skill 正文。
- 当前项目已确认的事实与决策。
- 用户全局偏好、当前项目相关 Memory。
- 当前项目/工作区关联资料。
- 当前 MES5/MES6/WMS 数据字典片段。
- 当前工作区代码片段、符号、配置和测试片段。
- 当前任务相关历史任务结果与验证证据引用。

### 默认不注入

- 其他项目的资料/Memory。
- 旧任务完整对话。
- 未确认或已 superseded 的项目事实/决策（只在明确询问历史时作为历史信息出现）。
- 未选择 Skill 的全文。
- 完整数据字典、全仓代码或完整插件包。
- 其他会话的 Runtime events。

## 5. 关键功能

### P0-01 统一检索入口

根据 `sessionId + projectId + workspaceId + runtimeKind + currentPrompt + taskContract` 构建 Context Request。各数据源提供统一的候选接口，返回：sourceType、sourceId、scope、contentHash、updatedAt、trustLevel、status、relevanceScore、reason 和有限文本片段。

### P0-02 相关性排序

首期使用本地可解释的混合排序，不引入远程 Embedding：

- 当前项目/工作区范围匹配。
- 当前系统类型（MES5/MES6/WMS）匹配。
- 精确关键字、术语和标识符命中。
- Skill tags/description 与当前任务相关性。
- 项目事实/决策状态（confirmed > proposed；superseded/rejected 不作为当前结论）。
- Memory 的全局/项目作用域和更新时间。
- 代码索引路径、符号、Hash 和行范围。
- 用户显式选择的 Skill/资料最高优先级。

每个结果必须能说明“为什么被选中”。

### P0-03 Context Budget

- 全局 Token 预算沿用 Performance Settings `contextBudgetTokens`。
- Required 内容独立统计，不参与 Optional 裁剪。
- Optional 按来源类别设置子预算和最大条数。
- 同一来源、同一 Hash、重叠行范围去重。
- 优先保留显式选中项、项目确认事实和高相关片段。
- 预算不足时返回被排除清单和原因，不静默省略。
- 当前估算方法可沿用 `ContextOptimizer` 的 UTF-8 字节近似；统计字段必须标记 `estimated`。

### P0-04 缓存

- Workspace Index 继续使用现有增量扫描。
- 增加检索结果缓存：Key 至少含 workspace/repository/worktree identity、indexVersion、query fingerprint、exclude policy、project scope。
- Skill 正文缓存 Key 含 Plugin ID、Plugin Version、Content Hash、Skill ID。
- Project Fact/Decision 缓存 Key 含 revision/updatedAt；Memory 缓存 Key 含 memory ID/updatedAt/hash。
- 会话结束、项目切换、版本 Hash 变化、用户删除 Memory、Skill revoke 或安全策略更新时正确失效。
- 默认只做进程内缓存；不把完整业务文本和秘密写入持久化 Cache。

### P0-05 上下文可解释性

每轮任务提供 Context Summary：

- Required 内容大小与估算 Token。
- 来源类型计数。
- 实际加入的候选和理由。
- 被去重/裁剪/拒绝的候选和理由。
- Cache hit/miss。
- 检索、读取、组装各阶段耗时。
- 代码片段 Hash 和行范围。
- Skill version/Hash。

UI 可放在现有右侧执行监控或上下文详情区，不另做独立大页面。

### P0-06 性能与质量度量

保留已有指标：Runtime spawn/initialize、Workspace index check/update、search、file read、context retrieve/build、model queue/first token/response、tool queue/execute、command/test、retry、finalize。

新增或完善：Skill metadata scan、Skill match、Skill load、Resource read、Memory retrieval、Project facts retrieval、Dictionary retrieval、context cache hit/miss、context source count、budget trimming。

如 Runtime/Provider 未提供权威 Token Usage，字段必须为 unknown；不得根据字符长度推算并标成真实 Token。

### P0-07 对照评测

提供人工可维护的脱敏 Benchmark Set：MES5、MES6、WMS 和通用工程任务，至少覆盖需求理解、代码定位、接口修改、数据字典查找、缺陷诊断和代码审查。

同一任务对比：

- 原始上下文路径（优化关闭）。
- 新 Context Engine 路径（优化开启）。

对比总耗时、上下文准备耗时、首字延迟、估算上下文 Token、工具事件、重复读取、构建/测试结果和人工纠正次数。模型/Runtime/Provider/项目工作区/代码版本必须记录，不能跨不同模型直接比较后宣称优化效果。

## 6. 用户体验

- 性能面板显示 Context Build 详情和来源。
- 用户可以关闭某类上下文来源或关闭优化，回到旧执行路径。
- 出现 Required Over Budget 时明确提示，不得自动降低开发要求。
- 可查看本轮实际加载的 Skill、Memory 和 Project Facts。
- 可重建索引；索引失败时回退原有 Runtime 工具，并明确显示“索引不可用”。

## 7. 验收标准

1. 当前项目的上下文不会混入其他项目数据。
2. Required 文本永不被可选预算裁剪。
3. 无关 Skill 正文不进入 Prompt。
4. 代码检索片段均带文件路径、Hash 和行范围。
5. 缓存命中不绕过 Hash/权限校验。
6. 数据源删除/更新/revoke 后相应 Cache 失效。
7. 关闭 Context Optimization 时原执行路径保持可用。
8. 检索/组装异常不会导致任务失败，回退原始上下文。
9. Context Summary 与实际装入文本一致。
10. Token Usage 不可得时显示 unknown；不伪造成本。
11. 冷启动和热缓存分别有基准结果。
12. 对照任务集能复现并导出测量结果，测试结果包括构建/验证事实。

## 8. 发布策略

Feature Flags：`context.unified_retrieval`、`context.skill_metadata`、`context.memory_retrieval`、`context.project_assertions`、`context.retrieval_cache`、`context.explainability`。

先在本地试点项目开启。所有新能力支持关闭并回退到当前 `DesktopPerformanceService.augmentContext` 逻辑。不得在一次升级中删除旧索引或遥测历史。

## 9. Codex 实施要求

- 先核对现有 `packages/performance`、`DesktopPerformanceService`、`assembleProjectContext`、`buildDeveloperContext` 与 Skill Loader 的代码，不从零重写 Index/Optimizer/Telemetry。
- 先做统一接口适配，再逐个迁移来源。
- 不引入向量数据库和远程 Embedding 服务，除非另有需求批准。
- 任何性能收益均需实测；无基线不写“提速 xx%”。

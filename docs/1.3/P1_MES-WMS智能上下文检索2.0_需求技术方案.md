# P1：MES/WMS 智能上下文检索 2.0

> 目标版本：精工 Agent 0.9.8  
> 前置：保留 0.9.7 已有 Context Retrieval、Workspace Index、专家中心和项目上下文功能

## 1. 背景

精工 Agent 已有多来源上下文，不需要从零搭建 RAG：

- `context-sources.ts`：用户记忆、数据字典、操作手册候选。
- `iteration-ipc.ts`：项目基本信息、已确认事实、已确认决策和项目资源候选。
- `performance-service.ts`：工作区增量索引查询、上下文来源合并、缓存和预算。
- `workspace-index.ts`：本地代码/文档索引，具备 Git 文件范围、敏感文件排除、文件 Hash 和变化检查。
- `context-retrieval.ts`：来源范围、安全状态、系统类型过滤、排序、去重和来源数量限制。
- `ContextOptimizer`：必需上下文与可选上下文的预算分配。

当前检索仍有明显提升空间：

1. 数据字典候选以简单字符串 `indexOf` 寻找命中，按关键词拿前几个片段，容易拿到第一个命中而非最相关字段。
2. Workspace Index 以文件路径命中加正文命中次数进行简单评分，片段只返回首个命中行附近内容，多个业务命中容易遗漏。
3. 项目资源在 `assembleProjectContext()` 中对每个文件读取后只取前 4000 字符用于候选，长需求文档、实施方案、接口文档的后半部分容易检索不到。
4. 专家档案、Jira 摘要、产品版本、模块和业务同义词没有统一进入同一检索查询对象。
5. 手册检索、Skill 匹配、代码索引、项目事实/决策各自有不同的触发条件，检索结果缺少统一质量评价。
6. 虽然 Planner 已能说明排除原因，但召回阶段较弱时，排序器无法挽回没有进入候选集的正确资料。

## 2. 目标与非目标

### 2.1 目标

- 对同一任务构建统一的检索 Query 和上下文请求。
- 在当前项目、当前系统、当前产品版本范围内，从项目资料、确认事实、确认决策、数据字典、操作手册、工作区源码、记忆和 Skill 中召回真正相关内容。
- 提高中文 MES/WMS 业务词、数据库表名、字段名、类名、方法名、模块名、产品版本和 Jira 关键词的检索精度。
- 使用确定性本地检索；结果可解释、可复现、可测试。
- 保留当前上下文预算、缓存、来源 Hash、权限边界和降级机制。

### 2.2 非目标

- 本阶段不引入云端向量数据库或第三方 RAG 服务。
- 不默认调用 Embedding API，不增加每轮额外模型费用。
- 不让 LLM 自己决定资料权限和项目范围。
- 不把整个项目仓库、所有字典和所有操作手册正文一次性注入模型。
- 不改变用户确认事实、决策及项目资源的现有确认流程。

后续可以在现有接口上增加可选本地 Embedding，但不属于本次 P1。

## 3. 设计原则

1. 先确定范围，再检索内容。
2. 用户显式选择的资料优先级最高。
3. 同一项目、同一产品系统、同一产品版本优先；禁止跨项目资料泄漏。
4. 代码证据、用户确认事实和正式开发规范不能被低可信文档覆盖。
5. 精确业务标识符（表名、字段名、类名、方法名、接口地址、Jira Key）应高于模糊自然语言匹配。
6. 资料分段后排序，不能只按文件整体得分。
7. 只有经过 SHA256/版本确认的内容才能作为稳定证据。
8. 必需规则不参加可选检索预算竞争；上下文不足时明确说明。

## 4. 统一检索架构

```text
用户 Prompt / Jira 任务 / 当前专家 / 项目系统与版本
                    │
                    ▼
            Query 规范化与扩展
                    │
                    ▼
              统一 ContextRequest
                    │
        ┌───────────┼────────────┐
        ▼           ▼            ▼
    项目资料      产品资料      工作区代码
  事实/决策      手册/字典     Workspace Index
        │           │            │
        ├───────────┼────────────┤
        ▼           ▼            ▼
          统一候选 ContextCandidate
                    │
                    ▼
       范围/可信/版本/Hash/有效期过滤
                    │
                    ▼
          确定性相关度评分与重排
                    │
                    ▼
         去重 + 来源配额 + Token 预算
                    │
                    ▼
         Context Bundle + 来源解释 + Hash
                    │
                    ▼
      注入 Runtime Developer Context / Expert
```

沿用现有 `ContextCandidate`、`ContextRetrievalPlanner`、`ContextOptimizer` 和 `ContextBundle`；可以扩展字段和实现，但不得再并行创造第二套上下文候选协议。

## 5. Query 规范化与扩展

建议新增纯模块，例如：

- `packages/performance/src/context-query.ts`
- `ContextQueryBuilder`
- `ContextQuery`

### 5.1 Query 输入

```ts
interface ContextQueryInput {
  prompt: string;
  jira?: { key?: string; summary?: string; description?: string; issueType?: string };
  expert?: { profileId: string; name: string; role?: string; workflowId: string; skillTags: string[]; sources: string[] };
  project?: { projectId: string; systemType?: string; productVersions: string[]; stage?: string };
  explicitResourceIds?: string[];
}
```

不得把与当前任务无关的完整历史对话作为默认检索 Query。只允许用户当前任务、与任务直接相关的 Jira 摘要、当前专家定义和当前项目元数据进入 Query。

### 5.2 标准化

- 使用 NFKC 规范化，大小写统一。
- 中文保留字词和二元词组；英文、数字、下划线、点号、斜杠等标识符作为整体保留。
- 不拆坏数据库对象标识符，如 `ProductOperation`、`IMES.ProductionManagement`、`JZ.IMS.Services`、`TENANT_ID`、`MES6`、`WMS`。
- 清理无意义停用词，但不得删除 `不允许`、`禁止`、`异常`、`失败`、`未完成` 等改变业务语义的词。
- 限制 Query 最大长度、Token 数和扩展词数量，避免大型 Jira 正文造成检索阻塞。

### 5.3 制造业同义词与术语表

增加本地、可版本化的同义词配置，不要在各来源 Provider 中重复维护。

首批建议：

| 主词 | 可检索关联词（示例） |
|---|---|
| 报工 | 工序报工、工单报工、完工、产量上报 |
| 过站 | 产品过站、工序流转、工艺路线、ProductOperation |
| 上料 | 物料上料、备料、投料、物料绑定 |
| 工单 | 生产工单、制造订单、MO |
| 批次 | LOT、批号、批次号 |
| 序列号 | SN、条码、产品序列号 |
| 仓库 | 仓储、库位、库存、WMS |
| 出库 | 发料、领料、拣货、出库单 |
| 入库 | 收货、上架、入库单 |
| 库存 | 在库、库存余额、库存明细 |
| 设备 | 机台、设备台账、设备状态、PLC |

术语扩展只增加召回线索，不代表这些词可以互相替代业务定义。实际结论仍需引用真实项目资料。

### 5.4 系统识别

优先使用当前项目登记的 `session.system`、项目上下文 `systemType` 和产品版本。只有当当前会话没有项目绑定时才根据明确的 Prompt/Jira 任务识别。不可凭“MES”一词猜 MES5 或 MES6。

识别规则必须复用现有 `detectProductSystem`、`manualProductScope` 等逻辑，不要再造一套冲突的系统识别结果。

## 6. 多来源 Provider

统一 Provider 输出 `ContextCandidate[]`，并统一进行安全过滤与排序。

### 6.1 项目基础信息 / 事实 / 决策

来源：`assembleProjectContext()`。

规则：

- 只检索当前 `projectId`。
- 只将 `confirmed` 且有效期内的 ProjectFact 纳入有效事实。
- 被 `supersedesFactId` 替代的事实不得继续以有效事实参与排序。
- 只将 `confirmed` ProjectDecision 纳入当前决策；被后续决策替代的内容降低为历史来源或直接排除，按现有业务语义处理。
- `proposed`、`rejected`、`superseded` 不得当作当前事实注入。
- Workspace 基本信息作为项目元数据候选，不得覆盖用户确认事实。

### 6.2 项目资源分段检索

当前实现对资源文本取前 4000 字符，必须改为按文档结构分段检索。

建议：

- 继续使用 `readDocumentTextFile()` 和现有大小限制。
- 先核对文件 SHA256 与 `ProjectResourceLink.sourceSha256`；不匹配时标为 unavailable，不允许使用旧缓存文本。
- Markdown 按标题、段落切分；文本按段落/长度切分；SQL/CSV/JSON 按可理解的记录边界切分。
- 每个 Chunk 保存 resourceId、文件 Hash、段落/页码/行号、标题路径、内容 Hash、更新时间。
- Chunk 不得跨越两个不同项目资源拼接。
- 按当前 Query 评分，取少量最相关片段，不再默认只注入文档开头。
- Chunk 缓存以 resourceId + sourceSha256 + parserVersion 为键；文件 Hash 变化自动失效。
- 资源正文是 `untrusted_project_data`，引用必须注明文件名、版本和段落/页码/行号。

### 6.3 数据字典

当前 `dictionaryContextCandidates()` 通过简单 `indexOf` 取前几个命中片段。升级为：

- 保留表名、字段名、注释、数据类型、主外键、模块、系统类型等结构化字段（如原始字典已经提供这些信息）。
- 对表名、字段名、类名和业务注释分别评分。
- 精确标识符命中显著高于普通正文匹配。
- 同一个 Query 最多返回受控数量的表/字段候选，并优先返回同一个表的字段定义、关联键、注释和实际项目系统版本。
- 支持按表名读取详情、按字段名读取详情和相关表关系；如果当前字典格式不支持结构解析，则按原始文本分段并保留行号，不能伪造结构关系。
- 继续沿用 `search_dictionary` / `read_dictionary` 工具和 Hash 校验，不将所有字典正文直接注入。

### 6.4 操作手册

来源：`OperationManualLibrary.search()` 和 `operationManualContextCandidates()`。

规则：

- 不应只在用户明显说“怎么操作”时才检索；根据专家 `sources`、业务动作、模块和当前 Query 判断是否相关。
- 如果专家要求“产品手册”，必须尝试检索，不能只把专家名字写进 Prompt。
- 优先当前项目产品类型和产品版本；版本不一致的手册不能伪装成当前版本标准。
- 继续使用当前手册引用格式，不得虚构 PDF 页码、章节或菜单路径。
- 检索无命中时明确说明“本轮未命中相关手册”，不把推断写成手册事实。

### 6.5 工作区源码 / 文档

来源：`WorkspaceIndexService.search()`。

当前索引已具备文件 Hash、Git 文件范围、敏感路径排除和缓存。升级重点在查询评分与片段生成，而不是重写整个索引。

建议改进：

- 当前按文件名命中 + 正文命中次数评分；新增 BM25/IDF 或等价的确定性排序，降低通用词在大量文件中命中的权重。
- 精确类名、方法名、表名、字段名、路由地址和命名空间提高权重。
- 对同一文件的多个独立命中返回多个片段；合并重叠片段，避免重复上下文。
- 片段必须包含相对路径、起止行号、文件 Hash 和索引版本。
- 先返回高相关的源码/测试/配置片段，再根据任务需要追加调用链或关联测试文件。
- 保留 `indexablePath()` 安全排除规则；不得因为检索升级而索引 `.env`、密钥、凭据、认证配置、`appsettings*.json` 等现有限制路径。
- 索引刷新、文件 Hash 变化和 Git 文件集合变化时，缓存键必须正确失效。

### 6.6 用户记忆

沿用 `memoryContextCandidates()` 和现有敏感信息扫描：

- 只取已启用记忆。
- 只注入当前用户全局记忆和当前项目记忆。
- 普通聊天内容、模型回答和一次性项目任务不能被当作长期记忆。
- 保留敏感信息检测和用户可见删除机制。
- 记忆优先级低于用户当前明确指令、必需开发规范和项目确认决策。

### 6.7 Skill Metadata / Skill Body

P1-2 统一后纳入 Provider：

- Skill 元数据用于召回和专家匹配。
- Skill 正文只有在已验证可信、符合项目范围、专家需要且 Native Runtime 可用时才加载。
- 不将所有 Skill 正文一次性放进上下文。
- Codex 原生 Skill 和 Jinggong Skill Loader 的加载机制不同，必须保留各自执行路径。

## 7. 相关度评分

继续使用现有 `ContextRetrievalPlanner` 作为统一排序入口，补充更细粒度评分字段。建议分层：

### 7.1 硬过滤（不参与分数）

- 来源类型已关闭。
- 状态不是 active/confirmed。
- projectId、workspaceId、sessionId 不匹配。
- systemType 与当前系统不匹配。
- 项目资源 Hash/Skill Hash/插件版本无效。
- 记忆被停用或敏感信息扫描未通过。
- 手册版本不符合当前适用范围。

硬过滤优先于所有相关度得分，不能通过高分越权。

### 7.2 软评分建议

建议初始评分采用可配置权重，开发时用离线样例测试调整：

| 因素 | 方向 |
|---|---|
| 用户显式选择 | 最高优先级，除非硬过滤失败 |
| 标识符精确匹配 | 高权重：表名/字段/类/方法/Jira Key/接口路径 |
| 标题、文件名、章节标题命中 | 高权重 |
| 专家角色/Skill 标签匹配 | 中高权重 |
| 当前项目和产品系统版本匹配 | 正向加权，不匹配时硬过滤或明显降权 |
| 业务同义词命中 | 中等加权，低于精确标识符 |
| 正文 BM25/词频逆文档频率 | 主要相关度得分 |
| 最近更新时间 | 小幅加权；不能让刚更新的无关资料排在准确证据前面 |
| 可信度 | 作为排序偏好；硬权限和来源状态仍独立判断 |

必须保留每个候选得分的解释项，例如：`exact_identifier`、`title_match`、`body_bm25`、`system_match`、`expert_tag_match`、`freshness`。不展示隐藏的模型推理。

### 7.3 排序稳定性

- 相同输入和相同来源版本必须产生稳定排序。
- 排序分数相同，按候选 ID 稳定排序。
- 去重身份继续包含 scope、projectId、sourceType、sourceId、contentHash。
- 不同来源指向同一个 Hash 的内容可做内容去重，但需要保留更可信的引用定位。

## 8. Token 预算和上下文拼装

继续使用 `ContextOptimizer` 和现有 PerformanceSettings：

- `contextBudgetTokens`
- `contextSources`
- `maxSkillContexts`
- `maxMemoryItems`
- `maxProjectAssertions`
- `retrievalCacheEnabled`
- `contextExplainabilityEnabled`

要求：

1. 必需开发规范、系统安全要求和用户本轮明确约束属于 required context，不能被可选资料挤掉。
2. 可选来源按统一得分和来源配额进入预算。
3. 超预算时先删除低分可选资料，不得静默裁剪必需规范。
4. 记录 `estimatedTokens`，明确这是估算值，不得显示为模型实际 Token 计费。
5. 统计候选数、选中数、排除数、重复数、预算占用、各来源耗时和缓存命中。
6. 若 required context 本身超预算，阻止任务启动并说明哪些硬性上下文超预算；不得静默删掉开发规则。

## 9. 可解释性和 UI

在现有上下文/性能面板中展示：

- 本轮 Query 关键词与识别的系统/产品版本。
- 各来源检索状态、命中数、最终选中数。
- 已选来源：标题、类型、版本、文件路径/页码/行号、Hash 摘要和命中原因。
- 排除来源：排除原因（范围不匹配、状态无效、版本冲突、未命中关键词、超过配额、预算不足等）。
- 索引状态：ready / indexing / failed / unavailable。
- 手册、字典或 Skill 来源不可用时展示真实状态。

不得把可解释性面板变成展示完整敏感文件正文的入口。来源预览仍须使用现有权限和脱敏路径。

## 10. 缓存与索引版本

缓存键至少包含：

- sessionId / projectId / workspace identity；
- 当前系统类型和产品版本；
- Query Hash；
- requiredText Hash；
- 候选 sourceId、contentHash、updatedAt、scope、status、trust、version；
- 索引版本；
- 来源开关、最大数量和 Token 预算；
- 同义词/检索策略版本。

任一重要输入变化都必须使缓存失效。缓存不得跨项目、跨 Session 或跨 worktree 复用未校验的上下文。

## 11. 安全与质量边界

- 资源读取继续验证路径、文件类型、大小、符号链接和 SHA256。
- Workspace Index 继续限制在当前已授权 Worktree。
- 任何检索候选的正文都视为不可信业务资料，不能覆盖开发规范或权限指令。
- 不扩大 `RuntimeOptions` 的文件访问权限。
- 不把手册、项目文档或数据字典内容作为 Shell 命令直接执行。
- 检索失败不能让任务失败；安全必需上下文缺失或 required budget 超限除外。
- 不能将“模型没看到某个文件”伪装成“项目不存在该功能”。

## 12. 测试需求

构建可复现的本地测试 Fixtures：

- MES5：`JZ.IMS.sln`、`JZ.IMS.Services`、Oracle SQL、`DbOpion` 等词。
- MES6：`.NET 10`、`Furion`、`SqlSugar`、`IMES.*`、`ProductionManagement`、`ProductOperation` 等词。
- WMS：入库、上架、拣货、库存、库位、批次等词。
- 项目资源：长文档，相关段落位于文档中后段；验证不只返回前 4000 字符。
- 字典：表名、字段名、字段注释、外键/关系；验证精确标识符优先。
- 代码索引：同一文件多个命中、同名符号、路径命中、无关通用词、文件 Hash 变化。
- 多项目隔离：MES5 项目不得读取另一个 MES6/WMS 项目的事实或资源。
- 版本隔离：手册和 Skill 版本不匹配时不得当作当前版本依据。
- 缓存：Query、来源 Hash、索引版本、预算和设置变化均正确失效。
- 预算：必需规范保持完整，可选资料按排名截取。

## 13. 验收标准

- 同一个任务的 Query 能综合 Prompt、Jira、专家、项目系统与版本。
- 对表名、字段名、类名和方法名的精确检索明显优于普通词命中。
- 长项目资源可检索后半部分内容并返回定位信息。
- 字典候选不仅返回第一处 `indexOf` 结果。
- 同一个文件多处相关片段可以召回，并避免重叠重复。
- 操作手册触发逻辑与专家 sources 联动。
- 不跨项目、不跨系统、不混淆 MES5/MES6。
- 预算、Hash、来源可解释性、缓存失效和安全回退均有自动化测试。
- 检索失败或索引不可用时仍能退回现有文件工具；不会静默把未检索资料宣称为已检索。

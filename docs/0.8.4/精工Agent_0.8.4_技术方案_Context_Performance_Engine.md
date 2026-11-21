# 精工 Agent 0.8.4 技术方案：Context & Performance Engine

版本：0.8.4  
目标：在已有 Performance Engine 上形成统一、可解释、可度量和可回退的上下文流水线。

## 1. 现有性能模块（必须复用）

- `packages/performance/src/workspace-index.ts`：Git 工作区索引、增量扫描、文件 Hash、索引检索和 watcher。
- `packages/performance/src/context-optimizer.ts`：Required Text 保留、Context Fragment 去重、预算和缓存。
- `packages/performance/src/telemetry.ts`：Trace/Span、Runtime/Tool 事件、指标白名单和持久化。
- `packages/performance/src/scheduler.ts`：只读并行调度。
- `apps/desktop/src/main/performance-service.ts`：DesktopPerformanceService、索引、上下文增强和 Trace 接入。
- `apps/desktop/src/renderer/PerformancePanel.tsx`：性能策略、索引状态、任务耗时和统计展示。

不得再新建第二个 WorkspaceIndex、Telemetry 或 ContextOptimizer。

## 2. 建议架构

```text
Session + Prompt + Task Contract + Skill Snapshot
                       │
                       ▼
              ContextRequestBuilder
                       │
                       ▼
              ContextSourceRegistry
       ┌───────────────┼────────────────┐
       ▼               ▼                ▼
   MemorySource   ProjectSource     SkillSource
       │               │                │
       ├───────────────┼────────────────┤
       ▼               ▼                ▼
   DictionarySource  WorkspaceCodeSource  TaskEvidenceSource
                       │
                       ▼
             ContextRetrievalPlanner
                       │ candidates + scores + reasons
                       ▼
             ContextBudgetAllocator
                       │
                       ▼
       Existing ContextOptimizer / ContextBundle
                       │
                       ▼
                 Runtime Instructions
                       │
                       ▼
          PerformanceTelemetry + Context Summary
```

## 3. 统一类型

建议新增 `packages/performance/src/context-types.ts` 或相邻模块：

```ts
export type ContextSourceType =
  | 'required_rule' | 'current_task' | 'memory' | 'project_fact'
  | 'project_decision' | 'skill_metadata' | 'skill_body'
  | 'dictionary' | 'project_resource' | 'workspace_code' | 'task_evidence';
export type ContextTrust = 'platform_required' | 'user_confirmed' | 'managed_skill' | 'user_memory' | 'untrusted_project_data';
export interface ContextCandidate {
  id: string;
  sourceType: ContextSourceType;
  sourceId: string;
  projectId?: string;
  workspaceId?: string;
  contentHash: string;
  updatedAt?: string;
  trust: ContextTrust;
  scope: 'global' | 'project' | 'workspace' | 'session';
  title: string;
  text: string;
  relevance: number;
  reasons: string[];
  required: boolean;
  estimatedTokens: number;
}
export interface ContextSelection {
  selected: ContextCandidate[];
  excluded: Array<{ candidateId: string; reason: string }>;
  stats: ContextBuildStats;
  contextHash: string;
}
```

不要把以上示例字段原样重复到当前已存在的 ContextFragment/ContextBuildStats 中；Codex 应先对齐现有类型，增量扩展。

## 4. ContextSource Registry

各来源实现统一接口：

```ts
interface ContextSourceProvider {
  readonly sourceType: ContextSourceType;
  query(request: ContextRequest, signal?: AbortSignal): Promise<ContextCandidate[]>;
}
```

Providers：

- `RequiredContextProvider`：系统/平台规则、当前用户任务、Task Contract 和用户明确选择的资料。
- `MemoryContextProvider`：调用 0.8.1 Memory API，只返回作用域匹配且有效的记忆。
- `ProjectContextProvider`：读取 `ProjectFact`、`ProjectDecision`，confirmed 优先，superseded/rejected 不作为当前事实。
- `SkillContextProvider`：读取 0.8.2 Snapshot metadata；仅在用户选中或自动匹配并授权后加载正文。
- `DictionaryContextProvider`：复用现有 dictionary broker，按 MES5/MES6/WMS 系统过滤。
- `WorkspaceCodeProvider`：复用 `WorkspaceIndexService.search`，返回文件 Hash、行范围和索引版本。
- `TaskEvidenceProvider`：读取当前项目相关的摘要/证据引用，不注入其他项目完整任务历史。
- `ProjectResourceProvider`：复用 `assembleProjectContext` 的受控资料路径、Hash 校验和资源元数据。

所有 Provider 都必须实施 scope filter，不能在统一排序后才尝试隔离其他项目。

## 5. Context Retrieval Planner

本地规则首期排序，避免每轮额外模型调用。

建议计算：

`score = scopeWeight + explicitWeight + systemWeight + exactTermWeight + keywordWeight + freshnessWeight + trustWeight`

规则：

- Explicit selected/required 走固定优先级，不参加普通打分竞争。
- 当前项目确认事实/决策高于旧历史经验。
- 被 superseded 的事实不能与当前事实并列为有效结论；如需保留，只作为明确标注的历史背景。
- Skill metadata 可先进入提示；Skill body 只有在 0.8.2 Loader 确认加载时才进入上下文。
- Memory 全局偏好可跨项目；项目事实和项目记忆不可跨项目。
- 用户禁用某来源或 Skill 后不得自动恢复。
- 搜索失败、空结果、索引不可用均回退到原有文件工具。

首期保留现有 workspace index 搜索能力，可对新来源使用标准化关键词/标签。BM25 可作为后续本地优化，但必须有测试集证实增益；不加远程 Embedding。

## 6. Budget Allocator 与 ContextOptimizer

保持 Required / Optional 两条路径：

1. `requiredText` 先组装，完整保留。
2. Optional candidates 按 trust、explicit、relevance、source priority 排序。
3. 对同一 source/hash/重叠行范围去重。
4. 依据当前 Context Budget 和每来源硬上限选取。
5. 将 excluded 候选及 reason 保留在 Context Summary，不注入 Prompt。
6. 调用现有 `ContextOptimizer.build()` 产生最终 bundle，或扩展它接受 `ContextCandidate`。

现有 Token Estimation 是字节/3 的估算，并且类型明确标记 `tokenMeasurement: 'estimated'`。本版保留这一语义。若 Provider 将来返回权威 usage，另行保存 `actualInputTokens/actualOutputTokens`，缺失时保持 undefined/unknown。

## 7. Cache 设计

### 7.1 Cache 级别

- Workspace Index：沿用现有本地元数据和增量扫描。
- Retrieval Cache：进程内 LRU，缓存候选 ID/排序结果，不缓存越权资源。
- Content Cache：按内容 Hash 保存已经通过校验的 Skill/Project Source 解析结果；默认内存缓存。
- Context Bundle Cache：只有 Required hash、Optional source hashes、project scope、runtime 和 budget 全部一致时才能命中。

### 7.2 Cache Key 示例

`hash(sessionScope, projectId, workspaceIdentity, indexVersion, promptFingerprint, requiredHash, selectedSkillHashes, memoryRevision, projectFactRevision, dictionaryDigests, budget, optimizerVersion)`。

Cache 不能替代权限检查。每次从 Cache 返回前仍需验证：当前 Session、项目 scope、Snapshot、Plugin trust、当前 Hash、source status。

### 7.3 失效

- Skill/Plugin 更新、revoke、禁用。
- Memory 修改/删除。
- Project Fact/Decision 更新或 supersede。
- 数据字典替换/禁用。
- Workspace Index version 更新。
- Session 取消/项目切换/权限策略更新。

## 8. Context Snapshot 与审计

每轮保存轻量 `ContextBuildRecord`（可沿用现有 ProjectContextSnapshot 或新增统一 Snapshot，不要混淆 Project Context 与全部 Context）：

- contextHash、builderVersion、createdAt。
- 选中 source type/id/hash/scope/reason。
- excluded source ID/reason（只保存安全标识，不保存敏感全文）。
- estimatedTokens、预算、裁剪数量、去重数量、cacheHits。
- runtimeKind、providerId、modelId。

为避免 DB 过大，只保留近 N 个会话 Context Build 记录；大文本不重复存储，使用 source ref 和 Hash。

## 9. Telemetry 扩展

当前 PerformanceStage 已有 runtime、workspace、search、file、context、model、tool、command、test、retry 和 finalize。按当前类型扩展细粒度 stage：

- `skill.match`
- `skill.load`
- `skill.resource_read`
- `context.memory_retrieve`
- `context.project_retrieve`
- `context.skill_retrieve`
- `context.dictionary_retrieve`
- `context.cache_lookup`
- `context.budget_allocate`

如 stage 类型增长过多，可用稳定的 operation 字段区分；保持 UI 分组可读。

Telemetry 仅记录白名单统计：耗时、itemCount、byteCount、estimatedTokens、cacheHits、sourceCount、errorCode。不得记录 Skill 正文、Memory 内容、代码片段全文、模型提示或隐藏推理。

## 10. UI 实现

在现有 PerformancePanel 增加 Context Details：

- Context 预算/估算 Token（明确显示“估算”）。
- Required 与 Optional 的数量和大小。
- 各 Source type 数量。
- 本轮加载 Skill 的名称/版本/Hash。
- Memory/Project Facts 标题及作用域。
- 被裁剪项及理由。
- Cache hit/miss 和耗时。
- “查看来源”跳转到已有 Memory/Plugin/Project 页面。

不得在 Context 面板内直接显示凭据或完整大段客户数据。

## 11. 基准评测

增加一个离线 Benchmark Harness，读取本地脱敏任务案例：

- case ID、系统类型、任务类型、prompt fingerprint、repository commit/fixture hash、Runtime、Provider/Model、优化设置。
- 记录准备阶段：index update、retrieval、context build、cache hit。
- 记录执行阶段：first token、total duration、tool events、retry count。
- 记录结果阶段：build/test evidence status、人工纠正数量（如有）。

同一个 case 应先跑优化关闭的 baseline，再跑新引擎；尽可能固定 Runtime、模型、Provider、仓库快照和推理强度。任何环境差异必须放进报告限制。不能只用不同任务的平均耗时得出性能提升结论。

## 12. 配置和开关

扩展现有 `PerformanceSettings` 时使用 schema migration 和默认值：

- `unifiedContextEnabled`
- `contextSources`（按来源开关）
- `retrievalCacheEnabled`
- `contextExplainabilityEnabled`
- `maxSkillContexts`
- `maxMemoryItems`
- `maxProjectAssertions`

数值范围严格校验；不可信输入不能通过 IPC 修改其他未声明的设置字段。

## 13. 测试

- Provider scope isolation。
- Required no-trim invariant。
- Project Fact status and superseded filtering。
- Memory global/project scope。
- Skill Snapshot/hash/revoke validation。
- Dictionary system filter。
- Workspace index stale detection and fallback。
- Cache invalidation for each source.
- Concurrent retrieval cancellation and no stale response after turn ends.
- Context Summary matches actual assembled content/hash.
- Telemetry excludes sensitive strings and content bodies.
- Benchmark deterministic fixture repeatability.

## 14. 实施阶段

1. 现有 Context/Performance 模块基线测量。
2. ContextSource interface 与 Required/Memory/Project providers。
3. Skill/Dictionary/Workspace providers。
4. Budget Allocator 与 Context Snapshot。
5. Cache 与失效机制。
6. Telemetry 和 PerformancePanel。
7. Benchmark Harness、回归、Windows 实测。

## 15. Codex 实施要求

先证明当前 Performance Engine 的每个已有能力，再决定需要修改的范围。不得新建第二套索引/优化器/遥测；不做云端向量数据库；不以估算 Token 冒充 Provider Usage；检索异常必须回退原路径。完成时提供冷缓存/热缓存实测结果和同任务对照报告。

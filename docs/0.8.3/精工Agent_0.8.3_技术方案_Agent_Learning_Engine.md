# 精工 Agent 0.8.3 技术方案：Agent Learning Engine

版本：0.8.3  
依赖：0.8.1 Memory Engine、0.8.2 Skill Intelligence Engine。  
核心复用：AgentTask/TaskContract/TaskEvidence、Verification Service、PluginManagerService、Plugin Store、Skill Loader、Credential Vault、内容脱敏服务。

## 1. 代码现状和复用映射

| 已有模块 | 当前基础 | 本版扩展 |
|---|---|---|
| `packages/domain/src/engineering.ts` | Task Contract、TaskEvidenceRecord、TaskLifecycleEvent、预算/状态模型 | 作为学习来源和证据引用，不重写任务模型 |
| `apps/desktop/src/main/task-engineering.ts` | 真实 Verification Run 关联、代码指纹、证据完整性与人工验收 | 提供 Candidate eligibility 判断和证据读取 |
| `apps/desktop/src/main/agent-tasks.ts` | 子任务执行、事件、结果、契约、预算审计 | 提供任务完成事件和候选来源 |
| `apps/desktop/src/main/verification-service.ts` / `verification-history.ts` | 验证记录与制品路径 | 查询真实运行状态和报告 Hash |
| `apps/desktop/src/main/plugin-manager.ts` | 受控 Plugin import/store/trust/version | 发布内部学习插件，不另建 Skill Catalog |
| `packages/plugin-manager/src/index.ts` | Plugin manifest/Skill Frontmatter/资源安全解析 | 复用 validator |
| 0.8.2 Skill Loader | Skill 使用记录与 Snapshot | 记录 learned Skill 的实际加载和使用事件 |
| `apps/desktop/src/main/settings.ts` | 文本校验、脱敏、凭据服务 | 复用敏感信息扫描与主进程数据边界 |

## 2. 架构

```text
Completed Task + Contract + Evidence + Skill Usage
                     │
                     ▼
             LearningEligibilityService
                     │ eligible / blocked + reasons
                     ▼
             LearningCandidateService
                     │ deterministic draft skeleton
           (optional user-triggered AI drafting)
                     ▼
              Candidate Review UI
                     │ user approval
                     ▼
        Safety Scan + Skill Package Validator
                     │
                     ▼
     PluginManagerService / Internal Plugin Store
                     │
                     ▼
          Existing Skill Loader (0.8.2)
                     │
                     ▼
            Skill Outcome / Usage Metrics
```

## 3. 新增领域模型

建议放在 `packages/domain/src/learning.ts`，避免将大块 Learning 数据塞入主 `index.ts`。

```ts
export type LearningCandidateStatus =
  | 'draft' | 'needs_review' | 'approved' | 'published' | 'rejected' | 'superseded';
export type LearningEvidenceKind = 'task' | 'contract' | 'verification' | 'acceptance' | 'skill_usage' | 'user_selection';
export interface LearningEvidenceRef {
  kind: LearningEvidenceKind;
  refId: string;
  contentHash?: string;
  contractVersion?: number;
  status?: string;
}
export interface LearningCandidate {
  id: string;
  title: string;
  suggestedSkillName: string;
  description: string;
  systemScope: Array<'MES5' | 'MES6' | 'WMS' | 'GENERAL'>;
  status: LearningCandidateStatus;
  sourceTaskIds: string[];
  evidence: LearningEvidenceRef[];
  draftSkillMarkdown: string;
  resourceRefs: Array<{ kind: string; refId: string; hash: string }>;
  safetyFindings: Array<{ code: string; severity: 'warning' | 'block'; message: string }>;
  createdAt: string;
  updatedAt: string;
  publishedPluginId?: string;
  publishedSkillId?: string;
  publishedVersion?: string;
}
export interface LearningSkillUsage {
  id: string;
  sessionId: string;
  taskId?: string;
  skillId: string;
  pluginId: string;
  version: string;
  contentHash: string;
  runtimeKind: RuntimeKind;
  loaded: boolean;
  usedEvidence?: string;
  taskStatus?: string;
  verificationStatus?: string;
  acceptanceStatus?: string;
  feedback?: 'helpful' | 'not_helpful' | 'incorrect' | 'not_rated';
  createdAt: string;
}
```

若 0.8.2 已建立更完整的 SkillUsage Event 模型，应复用并增加学习评价字段，不得重复创建同义表。

## 4. Learning Eligibility Service

入口：`evaluateTaskForLearning(sessionId, taskId)`。

检查：

1. task/session/project 存在且一致。
2. task execution status 为 completed。
3. 当前契约版本存在，且 TaskEvidence 的 contractVersion 与当前契约一致。
4. 修改代码的任务要求真实验证 passed、integrityVerified=true、代码指纹与当前工作区一致；验证信息可通过现有 `TaskEngineeringService` / `trustedVerification` 查询。
5. 人工 acceptance 状态独立记录，不把“执行完成”误当作“用户验收”。
6. 对纯分析/文档任务，候选标记 `evidenceLevel='review_only'`，用户明确选择来源后方可生成。
7. 失败/中断任务仅允许 `lesson_type='failure_lesson'` 草稿，必须说明失败证据和适用边界，不能标成成功 Skill。
8. 已被拒绝或过期的 evidence 不允许重用。

返回结构应包含 `eligible`、`candidateTypes`、`blockReasons`、`warnings`、`evidenceRefs`，前端不得仅通过任务 status 自行判断可学习。

## 5. 候选生成

### 5.1 本地草稿骨架

默认只在本地进行：

- 从 Contract 读取 goal、taskType、outputExpectations、acceptanceCriteria。
- 从 Verification 读取命令、退出码、耗时、测试数量、报告引用、代码指纹。
- 从 Skill Usage 读取本次加载过的 Skill 与版本。
- 用户选择需要包含的任务步骤/片段。
- 生成空白的 `SKILL.md` Frontmatter 和结构化章节。

不得把所有 `events` 的 message/delta 拼成一个 Skill 全文。

### 5.2 AI 整理

用户点击“AI 整理草稿”后，主进程：

1. 构建脱敏输入包，只包括用户勾选的 task/contract/evidence/selected excerpts。
2. 展示输入摘要和数据发送说明。
3. 调用当前会话/用户指定 Provider 的标准模型请求，不读取或输出其他 Credential。
4. 把模型输出作为 `draftSkillMarkdown` 保存为候选；不自动发布。
5. 对模型提出但无证据支撑的内容标记 `inferred=true` 或要求用户确认。
6. 请求失败时保留本地骨架和原数据，不能丢失候选。

AI 整理的模型调用不能放在 AgentTaskRunner 的完成回调里，不得增加用户当前任务的完成延迟。

## 6. 敏感信息扫描与 Skill Package 发布

### 6.1 Scanner

- 复用现有 `redactContent`、`cleanPerformanceText`、插件包 Validator。
- 增加结构化密钥模式：Bearer、`sk-*`、API_KEY、PASSWORD、SECRET、连接串、JWT、私钥块等。
- 扫描 Frontmatter、Skill 正文、references、scripts、assets 的文件名和可解析文本。
- 命中 `block` 级内容时禁止发布；UI 只显示类型和位置，不显示原始秘密。
- 对客户名/员工姓名/电话/订单号等行业数据采用规则提示 + 用户审核；不能宣称正则覆盖全部敏感数据。

### 6.2 内部插件目录

建议目录：

```text
<dataRoot>/plugins/learned/<candidateId>/<version>/
  plugin.json
  skills/<skill-slug>/SKILL.md
  skills/<skill-slug>/references/...
```

发布必须通过插件现有 Inspector/Validator；不能直接在 DB 写一条 PluginSkillRecord 绕过完整性检查。

### 6.3 统一目录模型

建议扩展 `PluginRecord`：

```ts
origin?: 'external' | 'builtin' | 'learned';
sourceCandidateId?: string;
createdBy?: string;
```

如迁移风险过高，可先以现有 `sourceType='folder'` 导入内部包，同时在 metadata/extension table 保存 `origin='learned'`。但 UI 和安全策略必须能区分学习包，不可仅根据文件路径推断信任。

发布流程：

1. 对 candidate 锁定 revision。
2. 写入临时 staging 目录。
3. 生成规范 Manifest/Skill 文件。
4. 完整校验文件路径、Hash、Frontmatter 和安全扫描。
5. 使用 Plugin Manager 受控 Import/Commit API 注册。
6. 成功后把 candidate 标记 published，并记录 Plugin/Skill/version/Hash。
7. 出错则删除 staging，不删除旧版本或用户源文件。

每次修改发布 Skill 都创建新 PluginVersion/Skill Hash；不原位覆盖旧版本。

## 7. 存储迁移

新增表建议：

- `learning_candidates(id, status, created_at, updated_at, value_json)`
- `learning_candidate_evidence(candidate_id, sequence, kind, ref_id, content_hash, contract_version, status)`
- `learning_skill_usage(id, skill_id, plugin_id, version, content_hash, runtime_kind, created_at, value_json_redacted)`（如 0.8.2 已有使用事件表则直接扩展）
- 可选 `learning_skill_feedback(id, usage_id, feedback, comment_redacted, created_at)`

索引：status/updated_at、source task ID、skillId/version/createdAt。

所有 JSON 需经过 schema 校验；保存时不得落库 Provider Key、原始 Authorization Header、未脱敏凭据或完整模型对话。

## 8. IPC / UI

新增 `LearningApi`：

- `eligibility(sessionId, taskId)`
- `createCandidate(input)`
- `generateLocalDraft(candidateId, selectedEvidenceRefs)`
- `generateAiDraft(candidateId, selectedEvidenceRefs, provider/model)`（仅用户显式触发）
- `updateCandidate(candidateId, expectedRevision, patch)`
- `validateCandidate(candidateId)`
- `publishCandidate(candidateId, expectedRevision, scope)`
- `rejectCandidate(candidateId, reason)`
- `listCandidates(filter)`
- `listSkillUsage(skillId, range)`
- `submitSkillFeedback(usageId, feedback)`

所有 API 必须通过 preload 白名单；发布、拒绝和更改版本需校验 expectedRevision 防止并发覆盖。

UI 页面：

1. 任务详情“可沉淀经验”状态。
2. Skill Candidate 列表。
3. Candidate 编辑/审核页。
4. 发布确认对话框（显示 scope、内容 Hash、扫描结果和来源证据）。
5. Skill 详情页的版本历史和使用统计。

## 9. 效果统计方法

核心指标：

- `candidate_created / approved / published` 转化率。
- 每项 Skill 的推荐数、加载数、被使用数。
- 使用后任务完成率和真实验证通过率。
- 用户 helpful / not helpful / incorrect 反馈。
- 加载失败率、版本冲突率、Skill 被禁用或回滚次数。

禁止：

- 将 Skill loaded 计为 Skill used。
- 将 AgentTask COMPLETED 计为 verification passed。
- 将任务通过简单对比就宣称是 Skill 导致提升。

要做效果对比，应按系统类型、任务类型、难度和 Runtime 分组；样本小于 5 时显示“样本不足”，至少 5 个同类使用样本后才展示描述性趋势，不使用因果措辞。

## 10. 测试与实施顺序

1. Eligibility 单元测试：完成/失败/中断、缺少证据、旧 contract、代码 fingerprint 变化。
2. Candidate 本地骨架和事件来源测试。
3. AI Draft 隐私/显式触发/失败恢复测试。
4. 安全扫描测试：合成 API Key、JWT、连接串、私钥、客户数据提示。
5. Internal Plugin 发布、版本递增、rollback 和 Hash 不变式测试。
6. Skill Loader 加载 published Skill 的端到端测试。
7. 跨 Runtime usage 事件、统计和人工反馈测试。
8. 既有 Plugin Manager、Task Engineering、Memory、Verification、备份/迁移和 Windows 回归。

## 11. Codex 实施要求

- 先核实 0.8.1/0.8.2 实际代码 API，不根据本文档盲目新增重复模型。
- 不在任务终态回调中调用 LLM。
- 不自动发布候选。
- 所有 Skill 发布必须经过同一 Plugin Manager Validator/Trust 流程。
- 所有效果评价必须基于真实事件和证据；unknown 保持 unknown。

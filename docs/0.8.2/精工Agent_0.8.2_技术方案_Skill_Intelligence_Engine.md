# 精工 Agent 0.8.2 技术方案：Skill Intelligence Engine

版本：0.8.2  
依赖：0.8.1 Memory Engine；现有 Plugin Manager P0；现有 Plugin Manager ↔ Jinggong P1 方案。  
技术基线：TypeScript、Electron、React、SQLite WASM、Codex App Server、Claude Agent SDK、Grok ACP。  
本方案仅落地 Skill 能力，不实现 P1 MCP/Hooks 全量能力。

## 1. 当前代码证据与改造边界

### 已有代码，必须复用

| 模块 | 当前职责 | 0.8.2 策略 |
|---|---|---|
| `packages/plugin-manager/src/index.ts` | 插件包解析、安全检查、Manifest、Skill Frontmatter/资源发现 | 复用解析器；必要时扩展 metadata，不复制实现 |
| `apps/desktop/src/main/plugin-manager.ts` | 插件安装、校验、预览、信任、Codex Profile 同步 | 在现有 Service 上增量增加 Skill Context/Loader API |
| `packages/domain/src/index.ts` | PluginSkillRecord、SessionPluginSnapshot、PluginManagerApi | 以向后兼容方式扩展能力和 Snapshot 字段 |
| `packages/storage/src/index.ts` | Plugin、Skill、Snapshot、审计记录 SQLite 持久化 | 只新增必要表/字段和 schema migration |
| `apps/desktop/src/main/index.ts` | Session 执行前构建 developerInstructions、RuntimeOptions、IPC | 在单一会话入口装配 Skill Snapshot 与工具服务 |
| `packages/agent-runtime/src/index.ts` | `thread/start/resume` 动态工具注册、`toolGateway` 回调 | 增加 Skill 动态工具定义和路由；保持协议封装在 Runtime 层 |
| `apps/desktop/src/renderer/PluginManagerPanel.tsx` | 插件/Skill 预览 UI | 扩展，不另建重复 UI |

### 必须先解决的现状差异

`PluginSkillRecord` 当前以 Plugin 为归属。插件解析的 Skill `supportedRuntimes` 当前为 Codex；`SessionPluginSnapshot` 有 `skillIds`，但同步逻辑按 Plugin 安装。`syncSelectedLocked` 复制插件目录并通过 Codex Plugin 命令安装整个插件；它没有单独过滤插件中的 Skill 文件。因此“快照写入了 Skill ID”不等于“Codex 只加载了该 Skill”。

另外，`RuntimeOptions` 当前未提供通用 `dynamicTools` 字段；`CodexRuntime.startSession()` 和 `resumeSession()` 内部组装 `dynamicTools` 数组，工具返回由 `toolGateway` 代理。0.8.2 应在这里增加平台 Skills 工具，不能从 Renderer 直接访问 Plugin 文件。

## 2. 目标架构

```text
User Prompt + Project Scope
          │
          ▼
SkillMatchingService（本地、确定性、无模型调用）
          │ candidates + reasons
          ▼
Session Skill Snapshot（冻结 Plugin/Skill Version/Hash/Runtime）
          │
          ├── Codex Runtime：官方 Plugin/Skill 机制 + 精工 Session Profile
          │
          └── Jinggong Runtime：SkillMetadata + Dynamic Tools
                                  │
                           SkillRuntimeGateway
                                  │
                           SkillLoaderService
                                  │
                      PluginResourceResolver
                                  │
                     Plugin Store / Skill Files
```

## 3. 新增/扩展模块

建议新增到 `apps/desktop/src/main/`：

- `skill-matching.ts`：任务关键词、项目系统类型、标签匹配；输出候选和解释理由。
- `skill-loader.ts`：校验 Session Snapshot 并加载 SKILL.md。
- `plugin-resource-resolver.ts`：读取 Skill 引用资源；统一路径、Hash、大小和编码检查。
- `skill-runtime-context.ts`：构建 Runtime 所需 Skill metadata 和动态工具集合。

建议在 `packages/domain/src/` 新增 `skill.ts` 或扩展已有 Plugin domain：

```ts
export type SkillCompatibility = 'full' | 'partial' | 'metadata_only' | 'unsupported' | 'invalid';
export type SkillSelectionSource = 'user' | 'automatic' | 'workspace_default' | 'project_default';
export interface SkillRuntimeCapability {
  runtimeKind: RuntimeKind;
  status: SkillCompatibility;
  reason?: string;
  testedAt?: string;
  testRunId?: string;
}
export interface SessionSkillEntry {
  skillId: string;
  pluginId: string;
  pluginVersion: string;
  pluginContentHash: string;
  skillContentHash: string;
  selectionSource: SkillSelectionSource;
  compatibility: SkillCompatibility;
}
export interface SessionSkillSnapshot {
  sessionId: string;
  runtimeKind: RuntimeKind;
  revision: number;
  entries: SessionSkillEntry[];
  snapshotHash: string;
  createdAt: string;
}
```

如果现有 `SessionPluginSnapshot` 足以承载数据，应扩展现有结构，不要同时创建两个互相竞争的 Snapshot。上述接口仅用于说明字段边界。

## 4. SkillMatchingService

### 输入

```ts
interface SkillMatchInput {
  prompt: string;
  runtimeKind: RuntimeKind;
  projectId?: string;
  systemType?: 'MES5' | 'MES6' | 'WMS' | 'OTHER';
  workspaceId?: string;
  explicitSkillIds?: string[];
  disabledSkillIds?: string[];
}
```

### 输出

```ts
interface SkillMatchCandidate {
  skillId: string;
  score: number;
  reasons: string[];
  compatibility: SkillCompatibility;
  recommended: boolean;
}
```

### 排序规则

- 用户显式选择：固定最高优先级；明确禁用优先于自动匹配。
- 系统类型完全匹配：加权最高；通用 Skill 次之；其他系统不匹配时默认排除。
- name/description/tags 的精确词命中高于模糊子串。
- 项目/工作区范围匹配高于全局范围。
- 只对 enabled、trusted、Hash 正确且当前 Runtime 兼容的 Skill 打分。
- Top 3 为初始建议，可配置但不能超过硬上限。
- 匹配结果必须可解释；不调用模型，不产生 API 费用。

首期可采用规范化词项和权重打分，暂不引入 Embedding、远程向量数据库或新型检索服务。0.8.4 再统一上下文检索排序。

## 5. PluginResourceResolver 安全边界

接口：

```ts
interface PluginResourceResolver {
  loadSkill(input: { sessionId: string; threadId: string; turnId: string; skillId: string }): Promise<SkillContent>;
  readReference(input: { sessionId: string; threadId: string; turnId: string; skillId: string; relativePath: string; offset?: number; limit?: number }): Promise<SkillResourceContent>;
  listResources(input: { sessionId: string; skillId: string }): Promise<SkillResourceDescriptor[]>;
}
```

校验顺序：

1. Session 存在且处于可用状态。
2. 当前 thread/turn 与正在执行的 Session 绑定。
3. Skill ID 存在于该 Session 的冻结 Snapshot。
4. Plugin 当前未 revoked；信任状态与 Snapshot 规则相符。
5. Plugin version、plugin contentHash、skill contentHash 与 Snapshot 完全一致。
6. `realpath/lstat` 校验 Plugin root、Skill directory 和文件每一层；拒绝符号链接、目录联接、硬链接、路径越界、绝对路径、Windows ADS。
7. 仅接受 UTF-8 文本；限制单文件大小、单次输出和累计读取量。
8. 结果通过现有 `settings.redactContent` / `redactRuntimeText` 做敏感信息处理；发现高风险凭据模式时拒绝返回，不以简单替换作为唯一安全措施。
9. 对正文和引用均返回 source ID、relativePath、Hash、truncated、offset/nextOffset。

Skill 内容属于不可信数据，必须在返回模型时加清楚的来源边界说明；其中的指令不能提升权限、覆盖当前用户请求或改变系统规则。

## 6. Jinggong Runtime 动态工具接入

`CodexRuntime` 已在 `thread/start` 和 `thread/resume` 中构造 `dynamicTools`，并在 `handleServerRequest` 中识别平台动态工具后执行 `toolGateway`。实施方式：

- 增加 `skillTools?: SkillDynamicToolProvider` 或等价的 RuntimeOptions 能力提供器。
- `startSession/resumeSession` 组合现有项目工具、字典工具、浏览器/电脑工具和 Skill 工具；工具名稳定且不与内置工具冲突。
- 每次 `setTurnContext/rebindTurnContext` 更新本轮 Gateway 回调，但禁止在活动 turn 中替换工具集。
- 建议工具：`list_available_skills`、`load_skill`、`read_skill_resource`。
- Runtime 层只负责协议注册和回调；应用主进程负责 Snapshot、授权、Resolver、审计。
- 对动态工具调用使用当前 `threadId + turnId + requestId` 校验，并检查任务取消/结束状态。
- 受控分析模式是否支持同一工具必须以其 tool registry 真实实现为准；未接通时能力矩阵标为不支持，不要默认共享原生工具实现。

Jinggong 与 Codex 底层适配器都基于 Codex App Server，但 Jinggong Loader 只在 `runtimeKind === 'jinggong'` 且会话显式启用 Skills 时注册。Codex Runtime 已由官方 Plugin Manager 加载的 Skill 不要再次注入正文，避免重复。

## 7. Codex Skill 粒度与 Profile 镜像

在实施之前实测当前锁定 Runtime 的插件安装粒度和 Skill 选择能力：

- 若官方命令支持按 Skill 选择：调用官方接口并回读实际状态。
- 若只支持插件级：为每个 Session Profile 建立精工托管的过滤后插件镜像，镜像仅包含已选 Skill、所需 references 和合法 Manifest；原始 Plugin Store 不可修改。
- 如果 Codex 会从用户全局目录发现额外 Skills，必须在配置/隔离层阻止混入，或在 UI 中明确无法实现严格单 Skill 隔离。
- 镜像目录使用版本路径和 Hash；更新只创建新目录，不覆盖正在运行的会话资源。
- 同一个 Plugin 被多个 Session Profile 使用时不得交叉清理或覆盖。
- Marketplace 更新必须保留当前已有的备份、回滚、读回校验和 Profile Lock。

不允许仅因 Snapshot 包含 `skillIds` 就把 UI 标记为“仅选中 Skill 生效”。

## 8. Claude / Grok 边界

- Claude Agent SDK 当前可配置 `additionalSystemPrompt`、`additionalDirectories` 和 SDK tools，但尚无精工统一 Skill Runtime Context；本版不默认启用。
- Grok ACP 当前没有统一插件/Skill 工具注册路径，明确不支持。
- 后续可通过 Adapter capability interface 扩展，但必须具备真实端到端加载测试才改为 `Full`。

## 9. 存储与迁移

优先扩展现有 `plugin_skills`、`session_plugin_snapshots` 和 Plugin Audit；如需单独 Skill 使用事件表，建议新增：

`skill_usage_events(id, session_id, task_id, skill_id, plugin_id, plugin_version, content_hash, runtime_kind, event_type, result, reason_code, created_at, metadata_json_redacted)`。

索引：`session_id + created_at`、`skill_id + created_at`、`task_id`。禁止存储明文 API Key、凭据、完整对话和不必要 Skill 全文。

SQLite schema migration：

- 当前 Schema 版本必须从实际 checkout 读取，禁止假定本文档核对时版本仍一致。
- 迁移前沿用 LocalStore 自动备份机制。
- migration 在事务中执行，`PRAGMA quick_check` 通过后才完成升级。
- 新字段均可从旧记录推导默认值；旧 Snapshot 缺少 Skill hash 时标记为 legacy/needs-review，不伪造 Hash。
- 回滚通过功能开关关闭新 Loader；旧数据保留。

## 10. IPC / API

新增 API 应放在现有 `PluginManagerApi` 或独立 `SkillApi`，Renderer 仍只经过 preload 白名单。

建议 API：

```ts
interface SkillApi {
  match(input: SkillMatchInput): Promise<SkillMatchCandidate[]>;
  createSessionSnapshot(input: { sessionId: string; runtimeKind: RuntimeKind; skillIds: string[]; source: SkillSelectionSource }): Promise<SessionSkillSnapshot>;
  getSessionSnapshot(sessionId: string): Promise<SessionSkillSnapshot | null>;
  listUsage(sessionId: string): Promise<SkillUsageEvent[]>;
  setScope(input: { skillId: string; scope: 'global' | 'project' | 'workspace' | 'disabled'; projectId?: string; workspaceId?: string }): Promise<void>;
}
```

Runtime 动态工具不通过 Renderer 暴露调用，必须由主进程内 SkillRuntimeGateway 处理。

## 11. 性能预算

- Skill Catalog 元数据查询 P95 < 300ms（本地 SQLite，不含首次目录全量扫描）。
- Skill matcher P95 < 50ms，测试数据不少于 500 个 Skill 条目。
- Snapshot 建立 P95 < 200ms（不含 Codex 官方 Profile 同步）。
- 单个 `SKILL.md` 在本地文件已打开且 Hash 已验证时加载 P95 < 150ms；大文件按限制返回。
- 所有首次全量扫描放在后台，不阻塞 Electron 主窗口首屏。
- 加载失败和索引缺失均回退原 Runtime 行为。

以上是验收目标，不是未经实测的性能声明。

## 12. 测试方案

### 单元
- Frontmatter 兼容、空字段、重复名称、版本/hash。
- Matcher 系统类型过滤、精确命中、用户手选/禁用优先级、无命中。
- Resource Resolver 目录联接、符号链接、硬链接、ADS、路径穿越、超大文件、非 UTF-8。
- Snapshot 不可变、跨项目隔离、Plugin 被撤销、Hash 变化。

### Runtime 集成
- Codex 原生 Skill 确认实际生效状态。
- Jinggong `list_available_skills -> load_skill -> read_skill_resource` 完整闭环。
- 当前 turn 取消后迟到工具调用被拒绝。
- 旧会话恢复时按旧 Snapshot 校验，不静默切换新 Skill 版本。

### 回归
- Plugin import/trust/install/disable/uninstall/sync。
- Memory、项目事实/决策、数据字典和 Runtime prewarm。
- Jira、Git Worktree、Claude、Grok、子 Agent 和性能统计不回退。

## 13. 实施顺序

1. 差异盘点与 Runtime 能力 PoC。
2. Skill Snapshot 与兼容矩阵。
3. Matching Service。
4. Resource Resolver。
5. Jinggong 动态工具与 Skill Loader。
6. Codex 粒度实测与安全 Profile 镜像（若官方粒度不足）。
7. UI、事件追踪、测试和 Windows 验收。

## 14. Codex 必须遵守

先读取需求与方案；核对当前分支和未提交修改；按最小改动复用 Plugin Manager 和 Runtime Adapter。不得同时开发 Learning Engine、Context Engine、MCP/Hooks 或多 Agent 委派。功能未接通前，UI 不得显示成功状态。最终提交需包含迁移说明、测试命令/退出码、Runtime 实测结果和已知限制。

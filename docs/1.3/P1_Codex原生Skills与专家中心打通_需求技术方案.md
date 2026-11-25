# P1：Codex 原生 Skills 与精工专家中心打通

> 目标版本：精工 Agent 0.9.8  
> 前置：P0 native delegation mode 已完成；上下文检索 2.0 已建立统一候选协议

## 1. 背景与当前差距

精工 Agent 已有插件和 Skill 管理能力：

- `apps/desktop/src/main/plugin-manager.ts`：插件导入、插件内容 Hash、版本、信任、Skill 元数据、Skill 范围、Codex Profile 同步。
- `packages/plugin-manager/src/skill-matcher.ts`：按名称、说明、标签、项目系统和用户任务匹配 Skill。
- `packages/domain/src/skill-intelligence.ts`：Skill 兼容性状态和使用事件。
- Jinggong Runtime 已有 `list_available_skills`、`load_skill`、`read_skill_resource` 工具，加载前核对插件版本与内容 Hash。
- `packages/expert-engine/src/index.ts` 的 ExpertProfile 已有 `skillTags`，但当前主要作为标签数据，尚未在 Codex 原生 Skill 体系中形成完整闭环。

当前 `skillCompatibilityStatus()` 对 Codex 返回 `Partial`；`PluginManagerService.contextSkillCandidates()` 目前只对 Jinggong 会话返回 Skill 候选；`handleSkillTool()` 也明确只接受 Jinggong Runtime。Codex 会话虽然已有插件 Profile 同步流程，但专家匹配、Skill 来源记录、运行时验证没有完全打通。

## 2. 目标

1. 精工插件/Skill Store 仍是唯一可信来源，不创建第二套 Skill 数据库。
2. Codex Runtime 使用 Codex 0.156.1 原生支持的 Skills/Plugins 加载方式。
3. 专家 Profile 的 `skillTags` 能影响当前任务的 Skill 召回。
4. 只将已启用、已信任、当前项目范围匹配且 Hash/版本一致的 Skill 提供给 Codex。
5. Jinggong Runtime 保留现有三种 Skill 工具方式，不受影响。
6. 专家运行记录能够区分“推荐、已同步到 Runtime、实际加载、加载失败”，不得把推荐当成已使用。
7. Context Retrieval 2.0 可以统一检索 Skill Metadata 和 Skill Body，但不把全部 Skill 正文提前注入。

## 3. 非目标

- 不重新实现 Codex Skill loader。
- 不把 Jinggong 的 `list_available_skills/load_skill` 工具伪装成 Codex 原生 Skill。
- 不在本期执行插件包中的任意脚本、Hooks 或未知安装命令。
- 不跳过插件信任、安装授权、版本、Hash 或资源路径校验。
- 不把所有 Skill 全局安装到用户的 `.codex` 目录造成跨项目污染。

## 4. 必须复用的现有模块

| 模块 | 路径 | 复用职责 |
|---|---|---|
| PluginManagerService | `apps/desktop/src/main/plugin-manager.ts` | 插件 Store、版本、信任、Skill 资源验证、Codex Profile 安装 |
| Skill Matcher | `packages/plugin-manager/src/skill-matcher.ts` | 专家标签与用户任务匹配 |
| Skill Intelligence | `packages/domain/src/skill-intelligence.ts` | 兼容性状态、Skill 使用事件 |
| Expert Engine | `packages/expert-engine/src/index.ts` | ExpertProfile、`skillTags`、`resolveExpert()` |
| Expert Center | `apps/desktop/src/main/expert-center.ts` | 专家运行记录、来源快照与反馈 |
| Runtime 创建 | `apps/desktop/src/main/index.ts` | Codex Profile Home 选择、插件同步、Developer Context 组合 |

## 5. 设计原则：Codex 原生、精工管理

### 5.1 两种 Runtime 的加载方式不同

| Runtime | Skill 加载方式 | 本次要求 |
|---|---|---|
| Codex Runtime | Codex 官方 Skills/Plugins 发现与加载机制 | 让精工已经审核的 Skill 通过官方支持路径可见；不得注册 Jinggong 的 Skill Loader 工具代替 |
| Jinggong Runtime | 精工自己的 Skill 工具 | 保留 `list_available_skills`、`load_skill`、`read_skill_resource` 和当前 Hash 校验 |
| Claude/Grok | 现有兼容机制 | 不在本期扩大能力承诺；仍按真实兼容状态显示 |

Codex Skills 标准基于 `SKILL.md` 文件和可选资源，官方文档：

- https://developers.openai.com/api/docs/guides/tools-skills
- https://developers.openai.com/cookbook/examples/codex/iterating-development-workflows-with-codex

### 5.2 优先复用精工现有 Codex Plugin Profile

当前 `getRuntime()` 在 Codex Session 具有 `SessionPluginSnapshot` 时会：

1. 通过 `pluginManager.syncCodexProfile(selectedPlugins.profileId)` 同步 Profile；
2. 校验安装数量和错误；
3. 使用 `pluginManager.homeForProfile(selectedPlugins.profileId)` 作为 Runtime Home；
4. 在 Runtime 配置中根据 `selectedPlugins` 开启 Codex Plugin 能力。

这个 Profile Home 已经为 Session 级隔离提供基础。P1 应扩展此路径，不得把项目 Skill 随意复制到公共用户 Codex Home。

开发前重点检查：

- `updateSessionPluginSelection()`；
- `syncCodexProfile()`；
- `buildMarketplace()`；
- `homeForProfile()`；
- 当前插件包中 Skill 文件是否按 Codex 官方插件格式被同步；
- Codex 0.156.1 实际能否发现已安装插件中的 Skill。

若原有安装链路已支持 Skill 文件，则补齐快照、范围和专家联动，不重复复制文件。若未支持，应按 0.156.1 官方插件/Skill 目录协议扩展现有 Profile 同步。

## 6. 功能需求

### FR-01：统一 Skill 候选检索

扩展 `PluginManagerService.contextSkillCandidates()`：

- 允许读取 Codex Session 的有效 `SessionPluginSnapshot`。
- 保留 Jinggong 当前逻辑。
- 通过 Runtime 类型选择最终兼容性状态，但不得复用一份不区分 Runtime 的假兼容结果。
- 必须验证 plugin enabled、skill enabled、trustStatus、install 授权、插件版本、插件 Hash、Skill Hash、插件和 Skill 归属关系。
- 必须验证当前 Session Snapshot 与当前 Session Runtime/项目关联一致。
- 只选择 `global` 或当前 `projectId` 范围的 Skill；不得使用其他项目 Skill。
- 通过 `matchSkills()` 对用户 Prompt、专家 Profile `skillTags`、项目系统和可选显式 Skill ID 做匹配。
- 返回 `ContextCandidate`，以便 Context Retrieval 2.0 排名和预算分配。

建议扩展输入：

```ts
interface SkillCandidateRequest {
  sessionId: string;
  runtimeKind: RuntimeKind;
  userPrompt: string;
  expertProfile?: { id: string; skillTags: string[]; sources: string[]; role?: string };
  projectId?: string;
  projectSystem?: string;
}
```

### FR-02：Codex Skill 兼容性

当前 `skillCompatibilityStatus()` 对 Codex 返回 `Partial`。只有在下列全部验证通过后，才允许将有效的 Codex 原生 Skill 状态标为 `Full`：

1. Skill 文件遵循 Codex 支持的 `SKILL.md` / Agent Skills 格式。
2. 通过 Codex 0.156.1 官方插件/Skill 路径完成 Profile 同步。
3. Codex App Server 能在真实 Thread 中发现并使用该 Skill。
4. Skill 资源路径和正文 Hash 与精工 Store 一致。
5. 版本和范围校验没有绕过。

如果只完成元数据推荐或 Profile 文件同步，尚未完成真实 Native Skill 加载验证，不能直接把兼容状态改为 Full。必要时保留 `Partial` 并通过状态说明具体缺口。

### FR-03：专家标签驱动 Skill 推荐

专家 Profile `skillTags` 是匹配输入之一，但不是安全授权。

匹配逻辑：

- 读取 `resolveExpert()` 返回的当前 Expert Profile。
- 将 `profile.skillTags` 与当前用户任务、Jira 摘要、项目系统、模块词拼接为 Query。
- 调用 `matchSkills()`，匹配数量默认不超过 3 个。
- 只有已经通过精工授权和范围校验的 Skill 能进入候选集合。
- 用户显式选择的 Skill 可以提高排序优先级，但不能覆盖 disabled、untrusted、Hash mismatch、项目范围不匹配等硬约束。
- 记录 Skill 推荐原因和得分。

建议内置专家与 Skill 标签示例：

| 专家 | 推荐标签 |
|---|---|
| 需求分析专家 | 需求分析、流程建模、验收标准、MES、WMS |
| 后端开发专家 | 后端、数据库、SQL、事务、API、性能 |
| 前端开发专家 | 前端、React、Vue、组件、交互、UI |
| 全栈开发专家 | 前后端、接口契约、联调、端到端 |
| 测试质量专家 | 测试、回归、边界、异常、自动化 |
| 实施工程师专家 | 产品手册、部署、配置、现场排障、数据导入 |

内置标签用于提升匹配，不表示对应 Skill 一定存在。

### FR-04：Codex 原生 Skill 注入

Codex Runtime 只使用 Codex 官方原生方式发现和加载 Skill：

- 复用当前 Session 专属 `profileId = session-${sessionId}` 与 `homeForProfile()`；
- 复用当前已审核插件的 Marketplace 和版本快照；
- 只同步当前 Session 已选择且通过校验的插件与 Skill；
- 在 `features.plugins` 与插件 Profile 配置方面继续沿用当前实现；
- 如果某 Skill 不是 Plugin 结构，而是独立 Skill 文件，应按 Codex 0.156.1 实际支持的 Skill 目录放入 Session Profile 的受控范围，不直接写入用户公共 Codex Home；
- 对同名 Skill 冲突使用确定性命名或阻止同步，不允许覆盖用户现有文件；
- Profile 同步完成后重新校验清单、Hash、Skill 文件路径和版本。

不要通过把 Skill 正文一律追加到 `developerInstructions` 的方式冒充原生 Skill。正文注入只能作为明确标记的降级方案，并受上下文 Token 预算控制。

### FR-05：Jinggong Skill Loader 保持原样

- `SKILL_RUNTIME_TOOL_DEFINITIONS` 只在 Jinggong Runtime 注册。
- `pluginManager.handleSkillTool()` 继续验证 Jinggong Session、Thread、Turn 和当前推荐集合。
- `verifiedSkillFiles()`、`rememberLoadedSkill()`、`scriptsExecutable: false` 和资源路径校验保持有效。
- Codex Runtime 不新增 `list_available_skills/load_skill/read_skill_resource` 同名平台工具。

### FR-06：专家运行记录和来源追踪

扩展 `ExpertRun.sources` 或在对应结构中记录：

- Skill ID、名称；
- Plugin ID、版本、Plugin Hash；
- Skill Hash；
- Scope（global/project）和 projectId；
- 推荐原因、匹配分数、显式或自动选择；
- Runtime 类型；
- 状态：recommended / staged / loaded / failed / skipped；
- 状态来源和真实事件引用。

状态语义：

| 状态 | 含义 | 是否可计为已使用 |
|---|---|---|
| recommended | 精工匹配器推荐 | 否 |
| staged | Skill 已同步至 Codex Profile / Runtime 可发现 | 否 |
| loaded | 有真实协议事件或可验证的 Skill Loader 证据确认加载正文 | 是 |
| failed | 校验、Profile 同步或 Runtime 加载失败 | 否 |
| skipped | 已推荐但主 Agent/模型决定未使用 | 否 |

如果 Codex 0.156.1 没有可验证的“Skill 已加载”事件：只记录 recommended/staged，不得推断 loaded。专家对照评测中也应区分“专家提示包含 Skill 名称”和“模型真实加载了 Skill”。

### FR-07：Skill Body 只按需进入上下文

- Skill Metadata 可以先进入统一检索候选。
- Skill 正文只有在专家匹配、任务相关、来源通过验证且 Context Budget 有余量时才提供。
- 对 Codex 原生 Skill，优先让 Codex 自身按 Native Skill 机制读取正文。
- 如果为了检索解释性而需要将 Skill 正文片段提前放入上下文，应标记为 `skill_body` 来源并记录 Hash，不得记录为 Native Skill loaded。
- 脚本和可执行资源不自动执行。

## 7. 技术实现建议

### 7.1 SessionPluginSnapshot 扩展

检查当前 Domain 中的 `SessionPluginSnapshot`。如果 Codex snapshot 目前只含 `pluginIds`、`skillIds`、`plugins`，而 Jinggong snapshot 有更细的 `skillEntries`，建议统一到可校验的快照结构：

```ts
interface SessionSkillSnapshotEntry {
  skillId: string;
  pluginId: string;
  pluginVersion: string;
  pluginHash: string;
  skillHash: string;
  selectionSource: 'scope' | 'manual';
  scope: 'global' | 'project';
  projectId?: string;
}
```

同一 Domain 类型可供 Codex/Jinggong 使用，但 `runtimeKind` 不同意味着加载方式不同。

快照继续不可变。创建后若想更改插件/Skill 选择，应明确建立新 Revision 或新快照，不得原地覆盖旧快照。

### 7.2 Codex Profile 同步

扩展现有 `syncCodexProfile(profileId)`：

- 使用 Profile 锁防止同一 Session 同时安装/卸载。
- 插件安装采用 staging + rename + rollback 的现有模式。
- 同步后对 marketplace manifest 和 Native Skill 目录进行读取校验。
- 禁止符号链接、路径穿越、越权覆盖和脚本自动执行。
- Runtime Home 按当前 Session Profile 隔离。
- 变更后重建 Runtime/Thread，避免热加载未验证的配置。

如果 Codex Profile 的文件布局会影响已有会话 rollout，必须先验证 Thread 恢复；不能因为更新 Profile 就清理既有 Home。

### 7.3 Skill 匹配入口

把专家/Skill 匹配集中在 `getRuntime()` 上下文构建之前，避免 UI、Expert Center、Plugin Manager 各自做一份不同推荐。

建议新增纯函数：

```ts
buildSkillContextRequest({
  session,
  expertResolution,
  prompt,
  pluginSnapshot,
})
```

再调用统一的 PluginManager Service 获取已授权候选，最后把候选交给 `ContextRetrievalPlanner`。

### 7.4 Expert Instructions

在现有 `expertInstructions()` 后追加明确的 Skill 指引：

- 仅使用本轮已通过验证并显示为可用的 Skill。
- 当任务符合 Skill 描述时优先按其流程执行。
- Skill 资料仅作为工作流程补充，不得覆盖项目 `AGENTS.md`、用户当前指令、任务权限和安全规范。
- Skill 内容缺失或版本不符时，继续执行专家通用流程并说明未使用该 Skill。
- 不得声称已加载未发生真实加载的 Skill。

## 8. UI 需求

专家中心/专家会话详情增加“本轮技能”区域：

- 已匹配 Skill；
- 适用产品/项目范围；
- 推荐原因；
- 插件及 Skill 版本；
- Runtime 兼容状态；
- Profile 同步状态；
- 是否有证据确认真实加载。

状态文案必须区分：

- “推荐”不是“已加载”；
- “已同步到 Codex Profile”不是“已使用”；
- “已加载”必须有真实证据。

对不兼容/不可信/停用/Hash 不匹配的 Skill，说明原因且不让模型加载。

## 9. 兼容与数据迁移

- 保留旧 Jinggong `SessionPluginSnapshot` 数据；缺少新字段时按旧结构读取并做兼容转换。
- 老 Codex Plugin Profile 仍可启动；不要因为新字段不存在就判定已有插件无效。
- `skillCompatibilityStatus()` 只有在真实原生支持和集成测试完成后才将 Codex 标为 Full。
- Skill usage event 增加新状态时必须保持旧状态解析兼容；若当前 EventType 是固定枚举，使用版本迁移或扩展联合类型。
- 旧专家档案的 `skillTags` 不丢失；内置专家新增标签不覆盖用户复制/自定义专家。

## 10. 测试要求

### 单元测试

- Codex Session snapshot 中只含已选择 Skill。
- Plugin hash、version 或 Skill hash 不匹配时拒绝加载。
- 当前项目之外的 project-scoped Skill 不会被推荐。
- disabled、untrusted、invalid、unsupported Skill 不进入候选。
- 专家 `skillTags` 能提升相关 Skill 排名。
- explicit selection 只改变相关度排序，不覆盖硬性安全限制。
- Codex Compatibility 状态与真实协议能力一致。
- Jinggong 原有 Loader 和资源读取路径不退化。

### 集成测试

- 创建 Codex Session Profile。
- 同步一个受信任插件与其中一个 `SKILL.md`。
- 启动 Codex App Server 0.156.1。
- 在隔离测试工作区请求完成该 Skill 描述的任务。
- 使用真实事件/日志/文件读取证据确认 Skill 发现与使用；如协议无可确认事件，应只断言 Profile staging，不断言 loaded。
- 更换 Skill 版本后旧快照不得读取新版本正文。
- 取消/卸载/撤销信任后，新 Runtime 不得继续提供旧 Skill。

## 11. 验收标准

- Codex Runtime 可以通过官方支持方式发现和使用已授权 Skill。
- 精工插件 Store 仍是唯一可信来源。
- ExpertProfile `skillTags` 对候选匹配和来源记录生效。
- Codex / Jinggong 使用不同的真实加载方式，不混用平台工具。
- Skill 内容和插件版本 Hash 校验有效。
- 不跨项目注入 project Skill。
- 不把推荐或同步状态统计为真实加载。
- 未成功接入 Native Skill 的内容继续明确显示 Partial，不虚假升级兼容状态。
- 专家运行记录可定位实际使用的 Skill 版本和来源。

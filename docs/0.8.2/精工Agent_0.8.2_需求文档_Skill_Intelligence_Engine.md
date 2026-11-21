# 精工 Agent 0.8.2 需求文档：Skill Intelligence Engine

版本：0.8.2  
产品形态：Windows 桌面端精工 Agent  
前置版本：0.8.1 Memory Engine  
需求定位：在现有 Plugin Manager / Skill Catalog 上增加智能检索、任务匹配、渐进加载与 Jinggong Runtime Skill Loader。  
原则：复用既有 P0/P1 插件设计，不重做 Plugin Manager，不把“已登记 Skill”误报为“当前 Runtime 已加载”。

## 1. 背景与问题

当前仓库已经具备插件导入和 Skill Catalog 基础：可扫描插件内的 `SKILL.md`，解析名称、描述和 Frontmatter，记录文件 Hash 和资源清单，提供 Skill 预览、插件信任管理、Codex Profile 同步及会话插件快照。

但目前存在以下差距：

1. Skill Catalog 更接近“导入、登记和预览”，还没有平台级任务识别和 Skill 推荐。
2. 当前 `PluginSkillRecord` 的 `supportedRuntimes` 在发现逻辑中固定为 Codex；Jinggong Skill Loader 尚未在实际 Runtime 任务链路中落地。
3. Session Snapshot 虽然记录 `skillIds`，但现有 Profile 同步主要按插件粒度安装完整插件包，不能仅凭 Snapshot 就证明指定 Skill 被单独隔离和加载。
4. 没有统一的 Skill 调用、加载、跳过和失败事件，无法判断模型是否真正使用了某项 Skill。
5. Skill 文本和资源尚未通过一个统一、带 Session/Plugin/Hash 校验的 Resource Resolver 按需读取。

0.8.2 的目标是将已有 Skill 管理能力升级为真正可被 Agent 使用的 Skill Intelligence Engine。

## 2. 产品目标

- 一个 Skill 只维护一份受控源文件，在支持的 Runtime 中复用。
- 用户可手动指定 Skill，也可让 Agent 根据当前任务自动推荐。
- Agent 启动时只得到与当前会话授权范围相符的 Skill 元数据；需要时再加载完整 `SKILL.md` 和引用资源。
- Skill 内容有来源、版本、Hash、信任状态和有效范围。
- Codex Runtime 保留官方插件/Skills机制；Jinggong Runtime 通过平台 Skill Loader 使用相同 Plugin Store 内容。
- UI 能显示 Skill 的推荐理由、加载状态、实际版本和本轮使用情况。
- 无匹配 Skill、加载失败或 Runtime 不支持时，Agent 仍能使用原执行路径，不得伪造已加载状态。

## 3. 非目标

0.8.2 不做以下工作：

- 不从任务历史自动生成新 Skill；这是 0.8.3 Agent Learning Engine。
- 不做自动 Dreaming、后台模型总结或模型微调。
- 不重写 Plugin Manager、插件导入器、信任体系和 Credential Vault。
- 不在本版本实现 MCP Client、Hooks Executor 或完整插件市场；已有 P1 文档中的这些内容继续独立管理。
- 不强行将 Claude/Grok Runtime 宣称为已支持 Skill。仅在实际接入和验证通过后开放相应能力；首期支持范围为 Codex 和 Jinggong。
- 不因为 Skill 加载而放宽当前 Runtime 的代码、网络、命令和文件权限。

## 4. 用户角色与核心场景

### 4.1 开发人员

选择 MES5/MES6/WMS 项目后，发起“新增接口、修改报工逻辑、排查库存差异”等任务。精工 Agent 自动检索相应 Skill，展示命中项和理由；用户可以保留、取消或手动补充。

### 4.2 技术负责人

查看 Skill 内容、来源、版本、Hash、兼容 Runtime、使用记录和失效状态；决定某个 Skill 是否启用、是否可供项目/工作区使用。

### 4.3 核心场景

**场景 A：任务自动匹配**

用户说：“MES6 增加生产报工接口”。平台根据任务文本、项目系统类型、当前工作区和已授权 Skill 的元数据进行本地匹配，给出例如“MES6 接口开发规范”“生产报工业务流程”等候选。自动匹配不得触发额外模型调用。

**场景 B：按需加载**

Runtime 首先得到 Skill 名称、描述、标签、适用系统、版本和受控 Skill ID。模型通过受控动态工具请求加载完整 Skill。平台校验当前 Session Snapshot、Plugin 信任、Skill Hash、路径和权限后才返回正文。

**场景 C：加载参考资料**

Skill 正文引用 `references/` 内文件时，Runtime 只能通过 Resource Resolver 读取该 Skill 目录下的相对路径；禁止路径越界、符号链接逃逸和读取未授权凭据。

**场景 D：Runtime 切换**

同一个项目分别使用 Codex 和 Jinggong Runtime。Codex 使用官方原生 Skills/插件方式；Jinggong 使用平台 Loader。两边共享来源、版本和内容，但执行能力、加载状态分别记录。

## 5. 功能需求

### P0-01 Skill 能力与兼容性矩阵

每个 Skill 显示以下状态：

- `Full`：当前 Runtime 可检索、可加载正文和引用资源。
- `Partial`：仅支持部分能力，必须列出缺少项。
- `MetadataOnly`：只能展示元数据，不能向 Runtime 加载正文。
- `Unsupported`：当前 Runtime 或插件版本不支持，禁止声称可用。
- `Invalid`：Hash、Frontmatter、路径或信任校验失败，禁止加载。

兼容性按 `runtimeKind + runtimeVersion + pluginVersion + skillHash` 计算，并保留实测状态；不得仅按模型名称推断。

### P0-02 任务与 Skill 匹配

输入信号：

- 用户当前任务文本（只使用本轮用户输入，不把历史模型输出当成用户意图）。
- 当前项目系统类型：MES5、MES6、WMS、OTHER。
- 当前项目/工作区 ID。
- 用户显式选中的 Skill。
- Skill name、description、tags、适用系统、语言和关键词。
- Skill 在当前项目或工作区的启用范围。

匹配逻辑首期采用本地确定性算法，不调用模型：系统类型匹配、关键词命中、标签命中、精确 Skill ID、用户手选优先。返回 Top N 候选和可解释的匹配理由。

规则：

- 用户手选 Skill 优先级最高。
- 用户显式禁用的 Skill 不得自动加载。
- 不同项目之间的项目级 Skill 必须隔离；全局 Skill 仅在用户明确设为全局时适用。
- 没有可靠匹配时返回空列表，不能为了凑数推荐。
- 初始自动推荐不超过 3 个，防止过多 Skill 造成上下文膨胀。
- 推荐不等于加载；UI 必须区分“推荐”“已选择”“已加载”“加载失败”。

### P0-03 Skill 渐进加载

- 会话准备阶段只向模型提供已授权 Skill 的必要元数据和加载工具说明。
- 模型请求某个 Skill 后，平台读取完整 `SKILL.md`。
- 引用资源采用独立读取动作，不默认将所有 references 全文装入上下文。
- 资源加载返回来源 Skill ID、Plugin ID、版本、Hash、相对路径和截断状态。
- 单次 Skill 正文和资源有大小上限；超限需明确提示并提供分页/分块读取。
- 不把 Skill 中的任意脚本作为自动执行命令；脚本执行仍按现有插件信任与权限规则处理。

### P0-04 Runtime 集成

**Codex Runtime**

- 继续使用 Codex 官方 Plugin/Skill 机制，不在同一会话重复注入同一 Skill 正文。
- 修正当前 `skillIds` 快照与实际 Profile 安装粒度之间的差异。
- 实施前先确认锁定 Codex Runtime 是否原生支持插件内部单个 Skill 选择。如果不支持，使用精工托管的 Session Profile 镜像，仅复制所选 Skill 目录和必要 Manifest，不修改用户源插件，并在 UI 显示真实生效范围。
- 如果镜像策略不可安全实现，必须明确显示“按插件粒度生效”，不能宣称单 Skill 隔离。

**Jinggong Runtime**

- 实现 `JinggongSkillLoader`，读取同一 Plugin Store。
- 在 `thread/start` 和 `thread/resume` 注册平台动态 Skill 工具；Codex App Server 的动态工具回调沿用当前 `RuntimeOptions.toolGateway` 和工具请求归属校验模式。
- 至少提供 `list_available_skills`、`load_skill`、`read_skill_resource` 三类工具或等价能力。
- 每次工具调用都绑定当前 `threadId + turnId + sessionId`，不允许跨会话读取。
- 不开启或依赖 Codex 原生多 Agent、Hooks、MCP 功能来实现 Skill Loader。

**Claude / Grok Runtime**

- 本版本默认标记为 `MetadataOnly` 或 `Unsupported`。
- 只有在相应 Adapter 有真实的动态工具/上下文注入实现和端到端测试后，才能将状态提升为 `Full` 或 `Partial`。

### P0-05 会话 Skill Snapshot

- Snapshot 固化选中的 Skill ID、Plugin ID、Plugin 版本、内容 Hash、Runtime kind、创建时间和匹配来源。
- Snapshot 是不可变会话事实；插件升级不会静默修改正在运行/已有会话的 Skill 内容。
- 新版本 Skill 在新会话生效；旧 Snapshot 对应内容不可用时显示过期并要求用户处理。
- Snapshot 内 Skill ID 必须全部属于已选插件或平台内置 Skill。

### P0-06 Skill 使用记录

记录最小事件：

- `skill.recommended`
- `skill.selected`
- `skill.load_requested`
- `skill.loaded`
- `skill.load_failed`
- `skill.resource_read`
- `skill.skipped`

事件字段至少有 sessionId、taskId（可选）、skillId、pluginId、version、contentHash、runtimeKind、timestamp、result 和原因代码。不得保存密钥或不必要的 Skill 全文。

### P0-07 UI

在现有插件/Skill 管理界面和会话详情中扩展：

- Skill 来源、版本、Hash、兼容 Runtime、信任状态。
- 推荐、手选、已加载和加载失败状态。
- 推荐理由和不兼容原因。
- 本轮使用记录及相关事件。
- 用户可以在会话创建时手选或关闭自动推荐。
- 用户可以在设置中为全局、项目、工作区配置 Skill 可用范围。

不另建一个重复的插件管理界面。

## 6. 验收标准

1. 一个有效插件导入后，现有 Skill Catalog 数据不丢失。
2. 自动匹配为本地逻辑，不产生模型 API 请求。
3. MES5、MES6、WMS 的相同关键词不会错误跨系统推荐；用户明确手选可覆盖推荐规则。
4. 用户禁用、未信任、Hash 不匹配、已撤销或不属于当前 Snapshot 的 Skill 均无法加载。
5. `load_skill` 仅可读取当前 Session Snapshot 内的 Skill。
6. references 路径穿越、符号链接、硬链接、ADS、绝对路径和目录联接逃逸均被拒绝。
7. Codex 的显示状态与真实 Profile 回读一致；不支持单 Skill 隔离时不能显示“单 Skill 生效”。
8. Jinggong Skill Loader 能完成元数据发现、加载正文、读取一个 reference 文件的真实端到端流程。
9. Claude/Grok 未完成适配时展示不支持，不影响原会话执行。
10. 取消会话、切换项目、恢复旧会话、插件更新时，不会使用其他会话的 Skill Snapshot。
11. 加载失败时回退原 Runtime 能力，且记录明确错误。
12. 既有插件导入、安装、卸载、信任、MCP 元数据和会话恢复测试全部通过。

## 7. 验收示例

测试 Skill：

- `mes6-api-development`：description 包含 MES6 服务接口、DTO、校验和 API 流程。
- `wms-inventory-adjustment`：description 包含 WMS 库存调整、批次、库位和库存流水。
- `generic-code-review`：通用代码审查。

输入“MES6 增加生产报工接口”时应优先命中 MES6 API Skill；不能误命中 WMS 库存 Skill。点击加载后只读取已选择的 Skill。新会话切换 Jinggong Runtime 后仍能加载同一 Skill，但事件中的 Runtime kind 必须显示 Jinggong。

## 8. 发布与回滚

- Feature Flags：`skills.matching`、`skills.jinggong_loader`、`skills.codex_granular_selection` 分开控制。
- 初期仅对内部试点开启 Jinggong Loader；Codex 原生路径保持现有行为，直到新 Profile 行为回归通过。
- 数据库迁移须事务执行，并在升级前按既有 LocalStore 机制备份。
- 回滚时关闭 Skill Loader 功能开关，不删除原插件文件、Skill 文件和已有 Snapshot。
- 不自动升级已有 Skill 内容。

## 9. Codex 实施要求

1. 先重新检查当前代码，尤其是 `plugin-manager.ts` 中 `updateSessionPluginSelection`、`syncSelectedLocked`、`syncCodexProfile`，以及 `CodexRuntime.startSession/resumeSession` 动态工具注册和 `toolGateway` 处理。
2. 先输出“已实现/部分实现/未实现”差异表，禁止重写 Plugin Manager。
3. 先做 Skill Loader 的本地 PoC 和 Runtime 工具协议测试，再接 UI。
4. 只实现 Skills，不把 P1 的 MCP Client、Hooks Executor 顺带纳入。
5. 代码修改必须有单元、集成、安全和 Windows 实测；任何 Runtime 未实测能力标记为未验证。

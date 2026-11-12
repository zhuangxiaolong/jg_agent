# 精工Agent——插件管理与 Codex 插件复用 P0 需求方案 V1.0

> 文档类型：产品需求方案（PRD）  
> 产品：精工Agent（Windows 桌面客户端）  
> 优先级：P0（首期必须交付）  
> 适用 Runtime：Codex Runtime（P0）；Jinggong Runtime 兼容列入 P1  
> 日期：2026-11-09  
> 状态：供 Codex 研发实施

---

## 1. 背景与目标

当前精工Agent已经规划 Codex Runtime、Jinggong Runtime、Claude Agent SDK Runtime，以及多仓库 Workspace。用户希望在选择 Codex Runtime 或 Jinggong Runtime 时复用 Codex 插件，而不是为每个 Runtime 重复安装、维护 Skills 和 MCP 配置。

本文件定义 P0 首期范围：

1. 在精工平台中导入、检查、安装和管理 Codex 插件包。
2. 复用 Codex 插件中的 Skills（技能目录及其参考资料、脚本和资源）。
3. 解析并管理插件携带的 MCP Server 配置，并在 Codex Runtime 中使用。
4. 在创建会话时选择本次会话需要启用的插件/技能；插件变更按 Codex 实际能力在新会话或受控 Runtime Profile 生效。
5. 插件安装、启用、停用、卸载、更新和错误状态在精工客户端统一呈现。

P0 不要求 Jinggong Runtime 执行 Codex Hooks，也不要求 Jinggong Runtime 已具备完整插件兼容能力；该部分属于 P1。

## 2. 产品目标与非目标

### 2.1 产品目标

- 用户只通过精工Agent的插件管理界面操作，不需要手工编辑 Codex 配置文件。
- Codex Runtime 可通过 Codex 官方插件机制加载符合规范的插件。
- Skills 不被复制粘贴进提示词，而是作为结构化文件按需发现和加载。
- MCP 连接具备启停、健康检查、凭据管理、工具清单和权限提示。
- 插件来源、版本、信任状态和运行结果可追溯。
- 不破坏现有 Codex Runtime、Jinggong Runtime、Claude Runtime、Workspace、会话及 Git 功能。

### 2.2 非目标

- P0 不实现精工自有公开插件市场或云端插件分发中心。
- P0 不实现 Jinggong Runtime 的 Hooks 执行引擎。
- P0 不实现 Claude Runtime 插件兼容，后续单独评估。
- P0 不运行未经用户信任的插件脚本或 MCP Server。
- P0 不复制/转移用户的 Codex 登录凭据，不绕过 Codex 原有授权。
- P0 不承诺所有 Codex 插件都能在精工中完整运行；带有 Codex 专属 UI、未支持认证或特殊宿主依赖的插件必须显示兼容性限制。

## 3. 术语

| 术语 | 定义 |
|---|---|
| Plugin | 插件包，可包含 Skills、MCP Server 配置、Hooks、资源及可选 UI 元数据 |
| Skill | 以 `SKILL.md` 为核心的可复用工作流说明，可附带 references、scripts、assets |
| MCP Server | 通过 Model Context Protocol 向 Agent 提供工具/资源的服务进程或远端服务 |
| Hook | Agent 生命周期事件触发的命令脚本或工具调用，P0 只识别和展示，不由 Jinggong 执行 |
| Plugin Manager | 精工平台统一插件登记、安装、启停、版本和信任管理模块 |
| Runtime Profile | 某个 Runtime 实际使用的一组插件和运行配置 |
| Session Plugin Binding | 会话与插件/技能选择之间的绑定记录 |

## 4. 用户与使用场景

### 4.1 用户角色

- 开发人员：导入插件、选择会话技能、使用 MCP 工具。
- 技术负责人：审核插件来源、批准高风险 MCP、管理推荐插件。
- 平台管理员（本地单机首期可由用户本人兼任）：管理 Runtime 集成、凭据与安全策略。

### 4.2 典型场景

**场景 A：导入一个 Codex 插件**

用户在“插件管理”点击“导入插件”，选择 ZIP 文件或本地插件目录。平台解析 Manifest、Skills、MCP 和 Hooks 清单，展示权限风险；用户确认信任后安装。对于 Codex Runtime，平台将插件登记到受控本地 Marketplace，并通过 Codex 官方插件命令完成安装。

**场景 B：会话中启用 Skills**

用户创建新会话，选择 Codex Runtime，再勾选“代码审查”“MES 数据库开发”等插件/Skills。平台将所选插件配置应用到本次新会话使用的 Codex Runtime Profile。若 Codex 当前版本只能以 Runtime Profile/主机配置级生效，界面必须说明生效范围，禁止伪称已实现真正的单会话隔离。

**场景 C：使用插件 MCP 工具**

用户安装一个包含 MCP Server 的插件。精工展示服务类型、命令/URL、所需凭据和工具列表。用户信任并启用后，Codex Runtime 使用 Codex 官方 MCP 配置机制接入。需要 OAuth 的服务由 Codex/服务方支持的授权流程完成；不支持的认证方式标记为暂不兼容。

**场景 D：禁用或卸载插件**

用户禁用插件后，新会话不再加载该插件。卸载只删除精工管理的插件安装/Marketplace 项；不得删除用户原始插件源文件或其他 Marketplace。

## 5. P0 功能范围

| 编号 | 功能 | 优先级 | 说明 |
|---|---|---|---|
| P0-01 | 插件导入 | P0 | 支持 ZIP 与本地目录 |
| P0-02 | Manifest 识别 | P0 | 支持新标准与 Codex 兼容布局 |
| P0-03 | 包安全检查 | P0 | 路径穿越、压缩炸弹、符号链接、文件覆盖检查 |
| P0-04 | 插件列表与详情 | P0 | 元数据、版本、来源、能力、状态 |
| P0-05 | Skills 发现 | P0 | 扫描 `skills/<skill-name>/SKILL.md` |
| P0-06 | Skills 内容查看 | P0 | 显示元数据、说明、关联资源，不自动执行脚本 |
| P0-07 | Codex Runtime 安装桥接 | P0 | 通过官方 Marketplace/Plugin 命令安装、查询和卸载 |
| P0-08 | MCP 配置解析 | P0 | 解析 stdio 与 streamable HTTP 基础配置 |
| P0-09 | MCP 连接管理 | P0 | 启用、禁用、健康检查、工具清单、错误反馈 |
| P0-10 | 凭据引用 | P0 | 凭据存 Windows Credential Manager/DPAPI，数据库只存引用 |
| P0-11 | 会话插件选择 | P0 | 创建新会话时选择插件/Skills，展示真实生效范围 |
| P0-12 | 信任确认 | P0 | 首次启用插件及启动本地 MCP 前明确确认 |
| P0-13 | 插件操作审计 | P0 | 记录导入、信任、安装、启停、卸载、连接测试 |
| P0-14 | Codex 原生状态同步 | P0 | 展示 Codex 安装/启用/不可用状态及错误 |

## 6. 插件包兼容要求

### 6.1 首期支持布局

支持以下两类包结构：

**A. 新版 Portable Plugin 布局（优先）**

```text
plugin-folder/
├── plugin.json
├── skills/
│   └── skill-name/
│       ├── SKILL.md
│       ├── references/
│       ├── scripts/
│       └── assets/
├── mcp.json                 # 可选
├── hooks/                   # 可选；P0 只解析，不执行
└── assets/                  # 可选
```

**B. Codex 兼容布局**

```text
plugin-folder/
├── .codex-plugin/
│   └── plugin.json
├── .mcp.json                # 可选
├── skills/
├── hooks/                   # 可选；P0 只解析，不执行
├── scripts/
└── assets/
```

新版根目录 `plugin.json` 是首选；若缺少根 Manifest，可回退读取 `.codex-plugin/plugin.json`。MCP 配置优先读取 `mcp.json`，兼容读取 `.mcp.json`。若两份都存在且内容冲突，必须提示冲突，不允许静默覆盖。

### 6.2 Manifest 必需字段

至少校验：
- `name`：稳定标识，建议 kebab-case。
- `version`：版本字符串。
- `description`：用途描述。
- `author`：可选但建议提供。
- `skills`、`mcpServers`、`extensions` 等其他字段按当前官方 Schema 处理。

路径必须为相对插件根目录的安全路径；禁止 `..` 越界路径。未知字段应保留，不得因精工当前不使用就改写原始包。

### 6.3 插件类型兼容状态

平台对每个插件显示能力矩阵：
- Skills：支持/不支持/解析异常。
- MCP：支持/需要认证/不支持的传输类型。
- Hooks：已识别，P0 不执行（等待 P1）。
- UI 扩展：已识别但 P0 不渲染。
- 其他扩展：未知能力，不执行。

## 7. Skills 需求

### 7.1 发现与校验

- 扫描插件根目录 `skills/` 下的一级 Skill 目录。
- Skill 目录需包含 `SKILL.md`。
- YAML Frontmatter 至少需要 `name` 和 `description`。
- 校验 Skill 名称、描述非空；同一插件内 Skill 名称冲突需报错。
- 保留 Skill 目录内的 references、scripts、assets 原始相对路径。

### 7.2 使用方式

- 插件安装完成后，Skills 进入精工 Skill Catalog。
- 会话创建时可选择整个插件或单个 Skill（具体粒度由 Codex 原生机制能力决定）。
- 不将所有 Skill 全文一次性拼接到 System Prompt。
- 应采用“先提供 name/description 元数据，模型/Runtime 需要时再加载完整 SKILL.md 与引用文件”的渐进加载方式。
- 用户可预览 Skill 内容及其要求的文件/命令访问范围。
- Skill 内的脚本视为可执行内容，P0 不因为安装 Skill 就自动运行脚本。

### 7.3 P0 Runtime 范围

- Codex Runtime：通过 Codex 原生插件/Skill 机制使用。
- Jinggong Runtime：P0 只登记并展示兼容状态，不承诺执行；真正的 Skill Loader 在 P1。
- Claude Runtime：暂不支持。

## 8. MCP 需求

### 8.1 P0 支持类型

- 本地 `stdio` MCP Server。
- 远端 `streamable-http` MCP Server。
- 需要 OAuth、动态客户端注册或专属 UI 的服务，按当前 Codex 官方能力检查；不能完成授权时显示“需在 Codex 中完成认证”或“不支持”，不得伪造连接成功。

### 8.2 MCP 管理

- 展示 Server 名称、描述、传输类型、命令/URL、凭据需求和状态。
- 用户可以启用/禁用 Server。
- 可以执行连接测试、读取工具列表和错误信息。
- 本地 stdio Server 启动命令、参数、工作目录均要做白名单和风险提示。
- 远端服务必须使用 HTTPS（本地开发例外需明确提示）。
- MCP 工具实际执行由 Codex Runtime 原生 MCP Client 负责；P0 不重复开发 Jinggong MCP Client。

### 8.3 凭据

- 不允许将 API Key、Bearer Token 写入 `plugin.json`、`mcp.json`、SQLite 或日志。
- 插件包中的 `${ENV_VAR}`、`env_vars` 等只作为变量引用，运行时从凭据库或用户授权环境安全注入。
- 对来源不明的环境变量引用提示用户确认。

## 9. 会话交互要求

### 9.1 新建会话

新建会话步骤：
1. 选择 Runtime（默认仍为 Codex Runtime）。
2. 选择 Workspace/Repositories。
3. 选择本次会话希望使用的插件/Skills（默认继承用户已启用集合，可修改）。
4. 平台显示每个插件的 Codex 兼容状态及 MCP Server 状态。
5. 点击开始会话后冻结本次会话插件清单快照。

### 9.2 会话中变更

- 已开始的 Codex 会话不保证动态发现新安装插件。
- 用户在会话中添加/移除插件时，平台提示“配置将在新会话生效”，除非实际 PoC 证明当前 Codex Host 可安全热更新。
- 现有会话插件快照不能被后台插件升级静默修改。

### 9.3 Runtime Profile 边界

Codex 的原生插件启用状态可能属于用户/项目/Host 级，而不是单一会话级。Codex 研发必须先验证当前 CLI/Host 是否支持安全的项目级或独立 Profile 配置。

若不能实现真正的逐会话隔离，P0 采用“Codex Runtime Profile 级插件集合 + 会话快照”的方式，并在界面明确显示影响范围；不得通过同时修改共享配置来伪装成会话隔离。

## 10. UI 页面

### 10.1 插件管理

- 已安装插件列表。
- 导入插件按钮（ZIP/目录）。
- 插件详情页：简介、版本、作者、来源、能力、Skills、MCP、Hooks 状态。
- 启用/禁用/卸载/重新验证。
- 信任状态和权限摘要。

### 10.2 Skill 管理

- 列出 Skill 名称、描述、所属插件。
- 查看 SKILL.md 和资源文件列表。
- 显示是否已提供给 Codex Runtime。

### 10.3 MCP 管理

- 列表、启用状态、连接状态。
- Server 详情、工具清单、认证状态。
- 测试连接、查看错误、编辑非敏感配置。
- 密钥仅支持“设置/替换/删除”，不可回显。

### 10.4 会话插件面板

- 显示可选插件与 Skill。
- 显示选中状态和兼容状态。
- 显示需要新会话生效的提示。
- 会话创建后显示本次插件快照。

## 11. 数据与状态需求

精工本地 SQLite 增量存储（具体表名可结合现有项目调整）：

- 插件主记录：id、name、version、description、author、source、manifest_path、content_hash、status、trust_status。
- 插件版本记录：plugin_id、version、install_path、hash、installed_at。
- Skill 记录：plugin_id、skill_name、description、relative_path、content_hash、enabled。
- MCP Server 记录：plugin_id、server_name、transport、config_json（删除秘密值后）、credential_ref、enabled、health_status。
- Runtime 绑定：plugin_id、runtime_kind、install_state、native_plugin_id、native_path、last_sync_at、last_error。
- Session 绑定：session_id、plugin_id、selected_skill_names、profile_id、snapshot_json。
- 插件审计：action、actor、target、timestamp、result、detail_json（敏感字段脱敏）。

必须增量迁移并兼容已有数据，不得重建数据库。

## 12. 安全与信任要求

- 导入 ZIP 防止 Zip Slip、Zip Bomb、路径穿越、重复路径覆盖和符号链接越界。
- 插件默认未信任；安装不等于允许执行。
- 用户查看来源、Manifest、MCP 命令/URL、Skills 和脚本清单后再确认信任。
- P0 不执行 Hooks/插件脚本；MCP stdio 首次启动必须确认。
- 插件安装目录由平台管理，运行期只读；插件数据目录与插件程序目录分离。
- 凭据使用 Windows Credential Manager 或 DPAPI；SQLite 仅存引用。
- 不以管理员权限启动 Runtime 或 MCP Server。
- 禁止向模型上下文传递凭据原文。

## 13. 验收标准

1. 能导入合规 ZIP 和本地目录插件。
2. 能识别新版 `plugin.json` 与旧版 `.codex-plugin/plugin.json`。
3. 能解析 `mcp.json` 与 `.mcp.json`，并报告冲突。
4. 能发现多个 Skills 并读取 Frontmatter。
5. 能阻断路径穿越、Zip Slip、非法 Manifest 和损坏 ZIP。
6. 能将本地插件目录生成有效 Marketplace，并通过 Codex 官方命令安装。
7. `codex plugin list --json` 的结果能映射到精工界面；安装/卸载结果和真实状态一致。
8. 能配置并连接一个 stdio MCP Server 和一个 streamable HTTP MCP Server（实际测试服务）。
9. MCP 凭据不出现在 SQLite、插件文件和日志。
10. 新建 Codex 会话时能选择插件/Skills，插件生效范围与 UI 声明一致。
11. 禁用/卸载插件不删除原始导入源，不影响其他 Marketplace。
12. 不改变 Codex Runtime 默认设置，不影响 Jinggong/Claude Runtime 原有运行。
13. P0 不执行插件 Hooks；界面明确显示“P1 支持”。

## 14. P0 开发阶段

- Sprint 0：盘点当前 Codex Runtime 版本、Codex CLI 插件命令和现有 Runtime Profile；形成 PoC 报告。
- Sprint 1：插件包导入、Manifest 解析、安全检查、插件目录与数据库。
- Sprint 2：Skills 发现、详情预览、插件管理 UI。
- Sprint 3：本地 Marketplace 生成与 Codex 原生安装/卸载/状态同步。
- Sprint 4：MCP 配置解析、凭据引用、Codex MCP 配置同步与健康检查。
- Sprint 5：会话插件选择、配置快照、回归和 Windows 安装包验证。

## 15. 给 Codex 的实施指令

请在当前精工Agent代码库中实施 P0，不要新建与现有架构平行的插件系统。

1. 先检查现有 Runtime Adapter、Codex CLI 版本、CODEX_HOME/配置目录、Workspace、Session、SQLite、Credential Vault 和 Windows 打包方案。
2. 阅读最新 OpenAI Codex Plugin、Marketplace、Skills、MCP 官方文档，并核对当前安装 Codex CLI 的实际命令能力。
3. 先做 PoC：创建最小本地 Marketplace 和一个仅含 Skill 的测试插件，执行 `codex plugin marketplace add`、`codex plugin add`、`codex plugin list --json`、`codex plugin remove`，验证真实结果。
4. 只有 PoC 通过，才实施 Plugin Manager 和 UI。
5. 默认通过 Codex 官方 CLI 插件命令集成，不直接手改用户全局 `config.toml`。如果现有 Runtime 使用独立 CODEX_HOME/配置目录，先确认它的所有权和认证机制，再决定 Marketplace 绑定方式。
6. 对 per-session 插件隔离做单独 PoC。不能安全隔离时，采用 Runtime Profile 级配置并在 UI 明确告知，不得误报为会话级隔离。
7. MCP 配置的密钥必须安全注入，不能落地到 JSON 配置或命令行参数。
8. 每个 Sprint 输出实际代码、编译结果、测试报告、变更文件清单和未完成项。
9. 不用 Mock 代替真实 Codex CLI / MCP 集成测试。
10. 不实现 P1 Hooks 执行，不提前触发未经信任的插件脚本。

## 16. 官方资料

- Plugin development：https://developers.openai.com/plugins
- Plugin architecture：https://developers.openai.com/plugins/concepts/plugins
- Package your plugin：https://developers.openai.com/plugins/build/plugins
- Skills：https://developers.openai.com/plugins/concepts/skills
- Codex CLI reference：https://learn.chatgpt.com/docs/cli/reference
- MCP：https://learn.chatgpt.com/docs/extend/mcp
- Plugin security/guidelines：https://developers.openai.com/plugins/plugin-guidelines

说明：官方插件格式和 CLI 命令可能迭代。实施时以当前锁定 Codex CLI 版本与官方文档为准，必须保留版本检测和兼容性测试。

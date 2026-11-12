# 精工Agent——插件管理与 Codex 插件复用 P0 技术方案 V1.0

> 文档类型：技术架构与实施方案  
> 产品：精工Agent（Windows 桌面客户端）  
> 优先级：P0  
> 目标 Runtime：Codex Runtime  
> 日期：2026-11-09  
> 状态：供 Codex 研发实施

---

## 1. 技术目标

在现有精工Agent中构建本地 Plugin Manager，使 Codex Runtime 能通过 Codex 官方插件机制复用插件包中的 Skills 和 MCP Server。

P0 技术交付：
- 插件包导入/校验/安装目录管理。
- 新旧 Codex Plugin Manifest 解析。
- Skills 元数据扫描及内容预览。
- 生成受控本地 Marketplace。
- 通过 Codex 官方 CLI 管理 Marketplace 和 Plugin。
- MCP Server 配置解析、Credential Vault 引用、Codex 配置桥接。
- 会话插件选择与 Runtime Profile 绑定。
- SQLite 数据、审计、日志与错误处理。

P0 不执行 Plugin Hooks，不实现 Jinggong Runtime 的 Skill/MCP 执行层。

## 2. 技术事实与约束

### 2.1 当前官方插件包格式

优先兼容根目录 Portable 布局：
- `plugin.json`
- `skills/`
- `mcp.json`
- `hooks/`（P0 只解析）
- `assets/`

兼容 Codex 过渡布局：
- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/`
- `hooks/`

当根 `plugin.json` 存在时优先作为主 Manifest；`.codex-plugin/plugin.json` 可作为 OpenAI/Codex 兼容 Overlay。不得把两个 Manifest 不加判断地深度合并，需按官方规则判断 OpenAI extension 的覆盖语义；无法确认时提示兼容性冲突。

### 2.2 Codex CLI 官方插件命令

当前官方 CLI 文档列出：

```powershell
codex plugin marketplace add <source>
codex plugin marketplace list --json
codex plugin marketplace upgrade [marketplace-name]
codex plugin marketplace remove <marketplace-name>
codex plugin add <plugin[@marketplace]> --json
codex plugin list --json
codex plugin remove <plugin[@marketplace]> --json
```

本地 Marketplace 目录可由精工生成；Marketplace JSON 的 `plugins[].source.path` 指向插件目录，且相对 Marketplace 根目录解析。`codex plugin add --json`、`codex plugin list --json` 用于机器可读状态同步。

实施时必须先运行当前本机 Codex CLI 的 `codex --version` 和 `codex plugin --help`，不能只根据文档推断 CLI 已安装或版本支持。

### 2.3 Codex MCP

Codex 支持 STDIO 和 Streamable HTTP MCP。STDIO 可配置 command、args、env/env_vars、cwd；HTTP 可使用 URL、认证配置。P0 以 Codex 原生 MCP 配置和连接能力为主，不在精工中另造一套 MCP Client。

## 3. 总体架构

```text
┌─────────────────────────────────────────────────────────────┐
│               Jinggong Desktop UI                            │
│ Plugin Center / Skill Catalog / MCP / Session Plugin Picker   │
└──────────────────────────────┬──────────────────────────────┘
                               │ IPC
┌──────────────────────────────▼──────────────────────────────┐
│                       Plugin Manager                          │
│ Importer / Manifest Parser / Validator / Trust / Installer    │
│ Skill Catalog / MCP Config Registry / Version Manager         │
└───────────────┬───────────────────┬──────────────────────────┘
                │                   │
        ┌───────▼────────┐   ┌──────▼────────────────┐
        │ Plugin Store   │   │ Codex Plugin Bridge   │
        │ immutable files│   │ Marketplace + CLI     │
        └────────────────┘   └──────────┬─────────────┘
                                       │ official commands
                              ┌────────▼─────────┐
                              │ Codex Runtime    │
                              │ Skills + MCP     │
                              └──────────────────┘

Shared: SQLite / Credential Vault / Audit / Workspace / Session
```

原则：
- UI 不直接解析插件文件、不直接执行 Codex 命令。
- `PluginManager` 负责插件数据和文件生命周期。
- `CodexPluginBridge` 负责和 Codex CLI/Marketplace 交互。
- `CodexMcpBridge` 负责 MCP 配置生成、凭据安全注入和验证。
- P1 Jinggong Adapter 以后复用 PluginManager 的 Catalog 和安全策略。

## 4. 推荐模块边界

结合现有项目技术栈实施；以下为逻辑模块名，不要求创建平行后端：

```text
src/main/plugin/
├── plugin-manager.ts
├── plugin-importer.ts
├── plugin-validator.ts
├── plugin-manifest-parser.ts
├── plugin-store.ts
├── plugin-trust-service.ts
├── skill-catalog.ts
├── mcp-config-registry.ts
├── plugin-session-binding.ts
├── plugin-audit-service.ts
├── bridges/
│   ├── codex-plugin-bridge.ts
│   └── codex-mcp-bridge.ts
├── security/
│   ├── archive-validator.ts
│   ├── path-policy.ts
│   └── credential-resolver.ts
└── types/
    ├── plugin.ts
    ├── skill.ts
    ├── mcp.ts
    └── runtime-binding.ts
```

## 5. 插件存储目录

采用 Windows 用户目录下的应用数据区，路径按当前应用名称/升级策略确定。示例：

```text
%LOCALAPPDATA%/JinggongIntelligentDevPlatform/
├── plugins/
│   ├── store/
│   │   └── <plugin-name>/
│   │       └── <version>/                 # 只读安装内容
│   ├── staging/                           # 导入临时目录
│   ├── marketplace/
│   │   └── codex-local/
│   │       ├── .agents/plugins/marketplace.json
│   │       └── plugins/<plugin-name>/     # Marketplace 引用/副本
│   └── plugin-data/<plugin-id>/            # 插件可写数据，和程序文件分离
└── logs/plugin/
```

建议先复制验证后的版本到受控 Store；Marketplace 中再创建 junction/link 或受控副本。为兼容 Windows 权限和 Codex 缓存行为，PoC 必须确认 symlink/junction 可用性；若不可靠，使用真实文件副本并通过内容 Hash 保证一致。

插件 Store 的已安装版本不可由插件自身任意修改。插件可写数据存入独立 `plugin-data`。

## 6. Manifest 解析与校验

### 6.1 支持的清单

- Portable: `<root>/plugin.json`。
- Codex compatibility: `<root>/.codex-plugin/plugin.json`。
- Portable MCP: `<root>/mcp.json`。
- Compatibility MCP: `<root>/.mcp.json`。

如果同时存在多个同类文件：
- 按官方规定读取；
- 内容冲突时记录诊断信息；
- 不静默丢弃 MCP Server、Skills、Hooks 或认证字段。

### 6.2 Manifest 类型

```ts
interface PluginManifestNormalized {
  name: string;
  version: string;
  description: string;
  author?: { name?: string; email?: string; url?: string };
  homepage?: string;
  repository?: string;
  sourceManifest: "portable" | "codex-compat";
  rootPath: string;
  skillsRoot?: string;
  mcpConfigPath?: string;
  hooksConfigPaths: string[];
  hasOptionalUi: boolean;
  unknownExtensions: string[];
  rawManifestHash: string;
}
```

### 6.3 安全校验

导入 ZIP 时：
- 拒绝绝对路径、`..`、盘符、UNC 路径和规范化后越界路径。
- 拒绝重复目标路径覆盖。
- 限制压缩包最大大小、解压后总大小、文件数、单文件大小和压缩比。
- 默认拒绝符号链接、硬链接及特殊文件。
- 拒绝可执行文件自动运行；允许保留文件但标注为可执行资源。
- 解压到随机 Staging 目录，校验完成后原子移动到 Store。

导入目录时：
- Resolve real path，检查符号链接最终目标不越过根目录。
- 防止插件目录在验证后被替换（使用 Hash/文件锁/只读安装副本）。

Manifest 路径检查：
- 任何引用路径必须规范化后仍位于 Plugin Root。
- 不允许远程 URL 作为本地脚本路径。
- 不允许路径使用 `..`；若官方 Schema 某些字段支持不同规则，以具体字段规范为准并单独校验。

## 7. Skills Catalog

### 7.1 扫描规则

扫描 `<pluginRoot>/skills/*/SKILL.md`。读取 YAML Frontmatter：
- `name` 必填。
- `description` 必填。
- 可记录 `license`、`compatibility`、`metadata`、`allowed-tools` 等扩展字段，但不应私自执行其中的声明。

Skill 记录示例：

```ts
interface SkillDescriptor {
  id: string;
  pluginId: string;
  name: string;
  description: string;
  skillDir: string;
  skillFile: string;
  contentHash: string;
  resources: Array<{ kind: "reference" | "script" | "asset"; relativePath: string }>;
  supportedRuntimes: RuntimeKind[];
}
```

### 7.2 加载策略

- 初始只向 Runtime 提供 Skill name/description/路径（或 Codex 原生插件安装状态）。
- 完整内容在 Skill 被选中/触发时加载。
- 限制元数据总 token/字符预算；对超限 Skills 做分页/过滤或显示警告。
- SKILL.md、references 作为不可信任务资料，不得覆盖系统安全策略。
- Skill scripts 仅记录路径和风险，P0 不由 Plugin Manager 执行。

## 8. 本地 Marketplace 生成

### 8.1 目录与 JSON

为精工导入的本地插件生成一个受控 Marketplace 根：

```text
codex-local/
├── .agents/plugins/marketplace.json
└── plugins/
    └── mes-dev-helper/
        ├── plugin.json
        ├── skills/
        ├── mcp.json
        └── ...
```

Marketplace 示例：

```json
{
  "name": "jinggong-local",
  "interface": {
    "displayName": "精工本地插件"
  },
  "plugins": [
    {
      "name": "mes-dev-helper",
      "source": {
        "source": "local",
        "path": "./plugins/mes-dev-helper"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Engineering"
    }
  ]
}
```

Marketplace name 必须稳定且唯一；Plugin name 冲突时按 ID/来源处理，不允许覆盖同名第三方 Marketplace。

### 8.2 Codex Bridge 命令

使用 child process spawn（数组参数，无 Shell 拼接）执行：

```powershell
codex --version
codex plugin --help
codex plugin marketplace add <marketplace-root> --json
codex plugin marketplace list --json
codex plugin add <plugin-name>@jinggong-local --json
codex plugin list --json
codex plugin remove <plugin-name>@jinggong-local --json
codex plugin marketplace remove jinggong-local --json
```

如果当前 CLI 版本不支持某个命令/JSON 输出：
- 返回 `CODEX_PLUGIN_COMMAND_UNSUPPORTED`；
- 显示 Runtime 版本升级提示；
- 不尝试静默编辑 Codex 私有配置文件作为替代。

命令运行约束：
- 使用绝对路径定位 Codex 可执行文件；
- 传入受控 `cwd`；
- 使用固定 timeout；
- 捕获 exit code/stdout/stderr；
- JSON parse 失败保存脱敏原始摘要；
- 不把凭据写入命令参数；
- 只允许管理 `jinggong-local` Marketplace 自己创建的项目。

### 8.3 CODEX_HOME/配置隔离

先盘点当前 Codex Runtime 实现：
- 如果精工已有应用专用 `CODEX_HOME`，在该隔离配置下管理插件。
- 如果使用用户默认 Codex Home，必须只使用官方命令管理精工自己的 Marketplace/Plugin，不覆盖其他配置；安装前保存可回滚快照。
- 不复制、导出、解析、改写用户认证 token。
- 任何配置文件写入必须有原子更新、文件锁、备份和冲突检测。

## 9. MCP 配置桥接

### 9.1 NormalizedMcpServer

```ts
interface NormalizedMcpServer {
  id: string;
  pluginId: string;
  name: string;
  transport: "stdio" | "streamable-http";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  envRefs?: Record<string, string>; // 环境变量名 -> CredentialVault key
  httpHeaderRefs?: Record<string, string>;
  enabled: boolean;
  requiresUserTrust: boolean;
}
```

### 9.2 配置映射

- STDIO：映射为 Codex 的本地 MCP Server 配置，命令/参数/工作目录来自插件配置，但必须在用户信任后启用。
- Streamable HTTP：映射 URL 和受支持认证方式。
- OAuth、DCR、应用注册型认证：由 Codex 官方运行时支持时使用原生授权流程；否则标记为待支持。
- `${ENV_VAR}` 解析必须仅取变量名，并从 Vault/受控进程环境取值；禁止将变量引用当成密钥明文。

MCP Server 工具清单以 Codex 运行时真实发现结果为准。平台展示 Server 连接状态和最后错误，不能只根据配置存在就显示“已连接”。

### 9.3 同步策略

建议按 Runtime Profile 生成插件/MCP 快照；新会话启动时验证配置版本。如果活动会话使用旧配置，提示新会话生效，不要在活动任务中热修改共享 MCP 配置。

## 10. 会话与 Runtime Profile

```ts
interface RuntimePluginProfile {
  id: string;
  runtimeKind: "codex";
  name: string;
  enabledPluginIds: string[];
  enabledMcpServerIds: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

interface SessionPluginSnapshot {
  sessionId: string;
  profileId: string;
  profileRevision: number;
  pluginVersions: Array<{ pluginId: string; version: string; hash: string }>;
  selectedSkillIds: string[];
  mcpServerIds: string[];
  createdAt: string;
}
```

### P0 生效规则

Codex 原生插件启用可能按用户/项目/Host 配置生效，不保证任意 Runtime 都支持单个 Conversation 的独立插件集。PoC 必须验证：
1. 同一个 Codex CLI Profile 是否支持项目级插件 enable/disable；
2. 是否支持会话工作目录级别隔离；
3. 多会话并发时配置变更是否相互影响。

能安全实现逐会话隔离时，Session Snapshot 绑定独立 profile；否则采用 Runtime Profile 级生效，UI 明确提示“本配置对该 Codex Profile 的新会话生效”。不允许通过并发修改一份共享 config.toml 做伪隔离。

## 11. 数据库增量设计

结合现有 SQLite schema 增量创建以下表（名称可按项目约定调整）：

### `plugins`
- `id` TEXT PK
- `name` TEXT
- `version` TEXT
- `description` TEXT
- `author_json` TEXT NULL
- `source_type` TEXT（zip/folder/local_marketplace）
- `source_path` TEXT NULL
- `install_path` TEXT
- `manifest_format` TEXT
- `content_hash` TEXT
- `trust_status` TEXT（untrusted/reviewed/trusted/revoked）
- `enabled` INTEGER
- `created_at` TEXT
- `updated_at` TEXT

### `plugin_versions`
- `id` TEXT PK
- `plugin_id` TEXT FK
- `version` TEXT
- `install_path` TEXT
- `content_hash` TEXT
- `installed_at` TEXT
- `is_active` INTEGER

### `plugin_skills`
- `id` TEXT PK
- `plugin_id` TEXT FK
- `name` TEXT
- `description` TEXT
- `skill_dir` TEXT
- `skill_file` TEXT
- `content_hash` TEXT
- `metadata_json` TEXT
- `enabled` INTEGER

### `plugin_mcp_servers`
- `id` TEXT PK
- `plugin_id` TEXT FK
- `server_name` TEXT
- `transport` TEXT
- `config_redacted_json` TEXT
- `credential_refs_json` TEXT
- `enabled` INTEGER
- `health_status` TEXT
- `last_checked_at` TEXT
- `last_error` TEXT

### `runtime_plugin_bindings`
- `id` TEXT PK
- `plugin_id` TEXT FK
- `runtime_kind` TEXT
- `profile_id` TEXT
- `native_plugin_id` TEXT NULL
- `install_state` TEXT
- `last_sync_at` TEXT
- `last_error` TEXT

### `session_plugin_snapshots`
- `session_id` TEXT PK/FK
- `profile_id` TEXT
- `profile_revision` INTEGER
- `snapshot_json` TEXT
- `created_at` TEXT

### `plugin_audit_logs`
- `id` TEXT PK
- `action` TEXT
- `plugin_id` TEXT NULL
- `runtime_kind` TEXT NULL
- `result` TEXT
- `detail_redacted_json` TEXT
- `created_at` TEXT

敏感凭据不进入上述表；仅存 Credential Vault reference。

## 12. API / IPC 设计

根据当前桌面端 IPC 规范接入，不新增 localhost HTTP Server。

建议服务接口：

```ts
interface PluginManagerApi {
  importPlugin(input: { path: string; sourceType: "zip" | "folder" }): Promise<PluginImportResult>;
  listPlugins(): Promise<PluginSummary[]>;
  getPluginDetail(pluginId: string): Promise<PluginDetail>;
  validatePlugin(pluginId: string): Promise<PluginValidationResult>;
  trustPlugin(pluginId: string, trustScope: "install" | "execute_mcp"): Promise<void>;
  installForCodex(pluginId: string, profileId: string): Promise<RuntimeBindingResult>;
  uninstallFromCodex(pluginId: string, profileId: string): Promise<void>;
  enablePlugin(pluginId: string, enabled: boolean): Promise<void>;
  listSkills(pluginId?: string): Promise<SkillDescriptor[]>;
  previewSkill(skillId: string): Promise<SkillPreview>;
  listMcpServers(pluginId?: string): Promise<McpServerSummary[]>;
  testMcpServer(serverId: string): Promise<McpHealthResult>;
  updateSessionPluginSelection(input: { sessionId?: string; profileId: string; pluginIds: string[]; skillIds: string[] }): Promise<SessionPluginSnapshot>;
  syncCodexProfile(profileId: string): Promise<RuntimeSyncResult>;
}
```

必须有统一错误结构：`code`、`message`、`details`、`retryable`、`suggestedAction`。

## 13. 错误码

- `PLUGIN_ARCHIVE_INVALID`
- `PLUGIN_ARCHIVE_LIMIT_EXCEEDED`
- `PLUGIN_PATH_TRAVERSAL_BLOCKED`
- `PLUGIN_MANIFEST_MISSING`
- `PLUGIN_MANIFEST_INVALID`
- `PLUGIN_MANIFEST_CONFLICT`
- `PLUGIN_SKILL_INVALID`
- `PLUGIN_DUPLICATE_NAME`
- `PLUGIN_NOT_TRUSTED`
- `CODEX_RUNTIME_NOT_FOUND`
- `CODEX_PLUGIN_COMMAND_UNSUPPORTED`
- `CODEX_MARKETPLACE_ADD_FAILED`
- `CODEX_PLUGIN_INSTALL_FAILED`
- `CODEX_PLUGIN_STATE_MISMATCH`
- `MCP_CONFIG_INVALID`
- `MCP_SERVER_START_FAILED`
- `MCP_AUTH_REQUIRED`
- `MCP_CONNECTION_TIMEOUT`
- `CREDENTIAL_NOT_FOUND`

## 14. 测试策略

- 单元测试：Manifest 解析、Skills Frontmatter、MCP Config 映射、路径校验、ZIP 安全。
- 集成测试：真实 Codex CLI Marketplace/Plugin 命令，真实 stdio MCP 测试服务，真实 HTTP MCP 测试服务。
- UI 测试：导入/预览/信任/安装/启用/卸载/会话选择。
- 并发测试：多会话同时创建、Marketplace 同步锁、升级期间启动会话。
- 回归测试：Codex Runtime 默认值、Jinggong Runtime、Claude Runtime、Workspace、Jira、企业微信通知、已有会话。
- Windows 干净机器测试：无开发工具环境的最终安装包测试，至少验证 Codex Runtime 已具备可用条件。

## 15. 迁移和回滚

- 数据库迁移使用版本号和事务。
- 插件安装使用版本目录，不覆盖旧版本；更新成功后切换 active 指针。
- Codex Marketplace 更新失败时恢复之前的 Marketplace JSON/受管目录。
- 卸载只撤销精工登记的 Marketplace/plugin，不删除用户自行添加的其他 Marketplace。
- 回滚后保留插件源和数据目录，用户可以重新安装。

## 16. 交付任务

Sprint 0：
- Codex CLI 版本及命令能力检查。
- Local Marketplace PoC。
- 插件包格式双布局 PoC。
- MCP stdio/HTTP 配置 PoC。
- 会话/Runtime Profile 隔离可行性结论。

Sprint 1：Plugin Importer、Validator、Store、SQLite Migration。

Sprint 2：Skill Catalog 和插件管理 UI。

Sprint 3：CodexPluginBridge / Marketplace 安装、列表、卸载、状态同步。

Sprint 4：MCP Config Registry、Vault 注入、连接健康检查。

Sprint 5：Session Plugin Snapshot、错误提示、Windows 打包、回归。

## 17. Codex 开发提示

严格按顺序执行：
1. 先阅读配套 P0 需求方案和当前源代码。
2. 不要推倒现有 Runtime Manager 或 Session Manager。
3. 以本文件模块边界映射到现有代码结构，复用现有数据库、Credential Vault、IPC 和日志。
4. 先输出代码证据和技术差距报告。
5. 先完成 Sprint 0 PoC；如果当前 Codex CLI 没有官方命令支持，停止并给出可验证的替代路径，不允许私改内部缓存格式。
6. PoC 通过后逐阶段提交实际代码、测试、构建及 Windows 运行验证。
7. 不得将 Hooks 标记为可运行，不得假装 Jinggong 已支持插件执行。
8. 不得在日志、SQLite、命令行参数和插件配置中泄露凭据。

## 18. 官方资料

- Plugin architecture：https://developers.openai.com/plugins/concepts/plugins
- Package your plugin：https://developers.openai.com/plugins/build/plugins
- Skills：https://developers.openai.com/plugins/concepts/skills
- Codex CLI reference：https://learn.chatgpt.com/docs/cli/reference
- MCP：https://learn.chatgpt.com/docs/extend/mcp
- Marketplace metadata and local plugins：https://developers.openai.com/plugins/build/plugins

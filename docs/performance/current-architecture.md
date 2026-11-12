# 执行效率优化：现状盘点（2026-11-11）

本次仓库为 Electron 45、React 19、TypeScript 5.9 客户端，不是 MES5/MES6 后端。以下是本次改造前实际代码证据。

- `package.json`：`build` 为 TypeScript 类型检查加 esbuild；测试使用 `tsx --test tests/*.test.ts`。
- `packages/storage/src/index.ts`：本地使用 sql.js SQLite，现有 schema 版本 10，已有会话、事件、任务审计、验证执行表。性能模块应通过既有数据库的持久化回调保存数据，不另起数据库。
- `apps/desktop/src/main/index.ts:getRuntime`：每轮关闭旧 adapter，检查 Runtime、加载文档/Jira/历史、拼接 developerInstructions，再创建并绑定当前会话 adapter。
- `packages/agent-runtime/src/manager.ts`：Codex、Jinggong 共用现有 Codex App Server 适配协议，Jinggong 使用独立可执行文件及版本；Claude 使用独立 SDK adapter，不应混淆模型 Provider 与 Runtime。
- `packages/agent-runtime/src/index.ts:RuntimeEvent`：公开事件只有 threadId/type/text/requestId。命令原生事件有 started/completed，但平台原有文本事件没有统一 item ID 和持续时间。模型内部等待、token 用量、工具排队等无法从当前事件可靠还原。
- `packages/agent-runtime/src/project-read-broker.ts`：现有授权根目录、祖先链接检查、凭据/构建目录排除、分页读取和 hash 校验应继续使用。原有 listFiles 每次递归扫描，未见跨轮工作区增量索引。
- `packages/policy/src/index.ts:buildDeveloperContext`：文档与记忆生成 developer context；`main/index.ts` 另追加 Jira JSON、共享上下文及升级历史。无按文件版本的检索缓存或统一 token 预算。
- `packages/agent-orchestrator/src/index.ts` 与 `apps/desktop/src/main/agent-tasks.ts`：已有有依赖关系的子任务调度、最大 3 并发、取消和治理；新增性能策略不能绕过这些门禁。
- `apps/desktop/src/main/verification-service.ts`、`packages/verification/src/index.ts`：已有真实进程执行、退出码、JUnit、工作区指纹和证据链。不能另用模型文字替代验证通过。既有预设是 TypeScript typecheck 和全部 tests，未见项目登记命令的分级选择器。

最小改造路径：新增平台公共 Trace/Span 与可关闭的索引/上下文/调度/测试建议服务；主进程接入 IPC 和现有数据库，侧栏展示。保留 Runtime loop、权限验证和既有验证执行器。无原生数据的指标明确为 unavailable。

兼容性事实：Codex/Jinggong 当前配置 `wire_api=responses`；Claude 由 SDK `relayBaseUrl` 接入。配置能保存不等于服务端协议已通过真实请求；跨协议模型不得仅凭下拉项判定兼容。

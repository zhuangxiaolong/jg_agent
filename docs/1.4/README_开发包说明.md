# 精工 Agent Runtime 可观测性中心 1.0｜开发包说明

**目标版本：** 精工 Agent 0.9.x 后续迭代（建议标记为 0.9.8 或按项目当前版本号递增）  
**目标分支：** `develop/desktop-poc`  
**开发方式：** 基于现有代码增量升级，由 Codex 先审查、再分阶段实施。  
**仓库：** https://github.com/zhuangxiaolong/jg_agent/tree/develop/desktop-poc

## 文档清单

| 文件 | 用途 |
|---|---|
| `01_需求规格说明.md` | 产品目标、范围、场景、功能要求和当前实现基线 |
| `02_技术架构与数据模型.md` | 现有架构复用、事件模型、Token 口径、关联规则、存储和 IPC 设计 |
| `03_UI与交互规范.md` | 右侧「上下文」和「执行监控」两块面板的界面、状态和交互规范 |
| `04_分阶段开发计划.md` | Codex 实施顺序、每阶段任务、边界和交付物 |
| `05_测试与验收矩阵.md` | 单元、集成、UI、数据迁移、安全和性能验收标准 |
| `06_Codex开发总指令.md` | 可直接粘贴给 Codex 的总提示词及分阶段执行方法 |

## 重要实施原则

1. **不重写 Runtime。** Codex App Server、Claude Agent SDK、Jinggong Runtime、Grok Build ACP 继续由各自 Adapter 执行任务。
2. **不重复造性能系统。** 当前仓库已经有 `packages/performance`、`DesktopPerformanceService`、`PerformanceTelemetry`、`PerformancePanel` 和 `performance:*` IPC。本项目是在这些基础上补齐关联、数据模型和 UI。
3. **先解决数据关联，再做 UI。** 一次用户提交对应一个 Trace；Trace 绑定 Session、Turn/Run、Project、Workspace/Worktree。当前项目必须按当前 Session 的 `projectId` 解析，不能误用左侧当前选中的项目。
4. **实测、估算、不可用必须区分。** 应用侧上下文估算不能冒充模型真实输入 Token；工具事件通知数不能冒充工具调用次数；没有稳定关联 ID 就不能虚构调用耗时。
5. **不记录模型隐藏推理、完整消息正文、完整工具参数/输出、凭据或环境变量。** 只保存必要的白名单摘要和计量数据。
6. **不要把会话历史作为 Context Source。** 本功能展示本轮实际构造/加载的上下文来源，不把历史聊天记录当作项目知识来源或项目上下文来源。
7. **保留现有工作区和安全策略。** 索引只服务已关联且已授权的工作区；没有项目时明确显示独立会话，不自动扫描任意目录。

## 建议执行顺序

按 `06_Codex开发总指令.md` 执行：先只读审查；再完成 P0 数据关联和上下文快照；再完成上下文面板；再完成执行追踪；最后集成回归。不要让多个 Agent 同时修改 `App.tsx`、`PerformancePanel.tsx`、`performance-service.ts`、`telemetry.ts` 等共享文件。

## 当前源码基线说明

本开发包编写时对 `develop/desktop-poc` 分支进行过只读核对。仓库 README 标记版本为 0.9.7。已确认存在以下实现：

- `packages/performance/src/types.ts`：`PerformanceTrace`、`PerformanceSpan`、`ContextBuildStats`、`PerformanceState` 等类型。
- `packages/performance/src/telemetry.ts`：Trace/Span 采集、Runtime 事件处理、上下文统计、性能报告、日志保留。
- `packages/performance/src/context-retrieval.ts`：候选上下文排序、过滤、来源范围检查和排除原因。
- `packages/performance/src/context-optimizer.ts`：上下文预算、去重、来源 Token 估算、选中/排除明细。
- `apps/desktop/src/main/performance-service.ts`：工作区索引、上下文检索、Trace 关联和 Runtime 遥测入口。
- `apps/desktop/src/renderer/PerformancePanel.tsx` 与 `performance.css`：当前执行监控面板。
- `apps/desktop/src/renderer/App.tsx`：右侧有「执行监控」和「上下文」两个 Tab；当前「上下文」主要展示项目、运行时、模型、中转站、已启用资料和本机环境信息。
- `apps/desktop/src/preload/index.ts`、`packages/domain/src/index.ts`、`apps/desktop/src/main/index.ts`：已有 `performance:*` IPC 与 `DesktopApi.performance`。
- `packages/agent-runtime/src/index.ts`：`RuntimeEvent.performance` 已公开 `callId`、`phase`、`operation`、`stage`、可选 `exitCode`，但不同 Runtime 是否提供完整事件仍需按实际能力展示。

**Codex 开发前必须重新读取目标分支的当前源码。** 本开发包不是对之后仓库变动的保证；如文件结构、类型或函数已变化，以实际源码为准，先更新实施方案再改代码。

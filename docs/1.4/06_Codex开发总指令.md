# 06｜Codex 开发总指令

以下内容可直接复制给 Codex。建议先让 Codex 只读审查，再按阶段执行，不要一次性要求它并行重构所有模块。

---

## Codex 总提示词（可直接使用）

你现在负责精工 Agent《Runtime 可观测性中心 1.0》研发。

GitHub 仓库：
`https://github.com/zhuangxiaolong/jg_agent`

目标分支：
`develop/desktop-poc`

本机工作区以当前实际打开的仓库为准。先确认当前分支、HEAD、工作区是否有未提交改动。不要覆盖用户已有修改。

### 一、先阅读开发文档

完整阅读本开发包：

1. `README_开发包说明.md`
2. `01_需求规格说明.md`
3. `02_技术架构与数据模型.md`
4. `03_UI与交互规范.md`
5. `04_分阶段开发计划.md`
6. `05_测试与验收矩阵.md`

### 二、必须先审查现有源码

重点阅读但不限于：

- `packages/performance/src/types.ts`
- `packages/performance/src/telemetry.ts`
- `packages/performance/src/context-retrieval.ts`
- `packages/performance/src/context-optimizer.ts`
- `packages/performance/src/workspace-index.ts`
- `apps/desktop/src/main/performance-service.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/src/renderer/App.tsx`
- `apps/desktop/src/renderer/PerformancePanel.tsx`
- `apps/desktop/src/renderer/performance.css`
- `apps/desktop/src/preload/index.ts`
- `packages/domain/src/index.ts`
- `packages/storage` 中 PerformanceState 存储与迁移实现
- RunLifecycle、AgentTaskRunner、Verification 相关模块
- 各 Runtime Adapter 对 RuntimeEvent.performance 和 Token Usage 的实际支持

这些路径是开发包编写时的基线，不保证当前工作区没有变化。若实际路径或实现不同，以当前源码为准。

### 三、第一步只读审查，禁止改代码

先输出《Runtime 可观测性中心 1.0 源码差距审查报告》，报告内容：

1. 当前版本、分支、HEAD SHA、工作区状态。
2. 已有能力与本次新增需求的对应关系。
3. 每项缺失能力具体缺在哪个文件/函数。
4. 每个 Runtime 当前真正能提供的事件字段与 Token Usage 字段。
5. Run/Turn/Project/Workspace/Worktree 关联链路。
6. PerformanceState 当前版本、存储实现、迁移风险。
7. `performance:report` 是否足以返回新数据；是否真的需要新增 IPC。
8. 最小改动文件清单和推荐分阶段实现顺序。
9. 每阶段 build/test 入口和可能的回归风险。

不要因为文档中列出了示意接口，就不检查当前代码。文档类型只是设计目标，以最小兼容修改为原则。

### 四、不可违反的技术边界

1. 不重写 Codex App Server Runtime。
2. 不重写 Claude Agent SDK Adapter。
3. 不新建第二套 Runtime Manager、Agent Scheduler 或 Task Runner。
4. 不重写 ContextRetrievalPlanner、ContextOptimizer 和 WorkspaceIndexService；优先扩展已有能力。
5. 不删除现有 PerformanceSettings、索引、导出、诊断导出、测试计划能力。
6. 不把独立会话的工作目录显示成 Git 项目根目录。
7. 当前 Session 绑定 Project 必须通过 `session.projectId` 精确查找；禁止使用左侧当前选中 Project 代替。
8. 本轮 Trace 必须与其他 Session、本 Session 历史轮次隔离；不得从聊天历史补造上下文来源。
9. 不持久化完整 prompt、聊天内容、模型隐藏推理、完整工具参数/输出、命令 stdout/stderr 或任何凭据。
10. 估算 Token 只能标记为 estimated；不允许当成模型实际 Input Token 或模型窗口占用率。
11. 工具通知数与工具调用次数分开。没有稳定 callId 和配对事件时不虚构调用数/耗时。
12. AgentTask 或验证记录没有 runId/turnId/orchestrationId 等明确关联时，不得混入当前轮。
13. Mock 只用于纯单元测试，不允许用 Mock 作为真实 Runtime 集成验收。
14. 不允许在目标项目源码目录里写入测试报告、运行日志、临时脚本和测试结果文件；按仓库现有验证工作流写入应用 dataRoot verification 目录。
15. 不要未经用户要求执行 commit、push、merge、发布或部署。

### 五、开发顺序

严格按以下阶段执行；每阶段结束先汇报，再等待我明确要求进入下一阶段，避免跨阶段扩大修改范围。

**阶段 0：只读审查。** 完成差距审查报告，不修改代码。

**阶段 1：Trace 身份、项目绑定、上下文快照。** 只改数据模型、Telemetry、PerformanceService、存储兼容、相关 IPC 类型/数据返回和测试。确保一轮一 Trace、Project/Workspace/Worktree 真实关联、上下文 selected/excluded 快照、Token 估算口径。

**阶段 2：Context Inspector UI。** 只改右侧 Context Tab、相关新组件和样式。正确处理项目会话、独立会话、项目记录缺失、尚无 Trace、采集关闭等状态。

**阶段 3：Execution Monitor 工具事件。** 补全 callId 工具配对、异常事件处理、时间线和指标可信度展示。保留现有设置、导出和测试计划功能。

**阶段 4：Agent 执行树与验证摘要。** 仅展示与当前 Trace/Run 明确关联的 AgentTask 和验证结果。

**阶段 5：集成与回归。** 执行 build/test/desktop tests，按验收矩阵跑真实 Runtime 冒烟测试，输出未执行项和已知限制。

### 六、UI 特别要求

- 不要直接把整个 `App.tsx` 右侧重写；先明确拆分范围。
- 保留顶部的「执行监控」「上下文」两个入口。
- 上下文面板呈现当前 Session 绑定、Runtime 身份、Context Budget、来源分类、已选/排除明细。
- 执行监控呈现本轮概览、阶段时间线、工具调用、当前轮 Agent、构建测试验证、不可采集指标。
- 深蓝主题沿用项目现有 tokens/CSS variables，不要引入新的设计系统。
- 宽度 320/420/840px 都必须可用；320px 时表格改成纵向卡片，不横向溢出。
- 空状态必须真实；不能放固定演示数字。

### 七、每个阶段的工作流程

1. 先阅读阶段相关源码和测试。
2. 给出本阶段将改哪些文件、为什么。
3. 修改代码。
4. 增加/更新单元与集成测试。
5. 执行实际 build/test；记录命令、退出码和关键日志位置。
6. 检查 Git diff，确认无无关变更、无临时产物、无敏感信息。
7. 对照 `05_测试与验收矩阵.md` 更新通过/失败/未执行状态。
8. 汇报本阶段完成情况、限制和下一阶段依赖。

### 八、交付报告格式

每阶段输出：

- 阶段：
- 实际修改文件：
- 核心实现：
- 新增/修改测试：
- 实际执行命令：
- 退出码和结果：
- 已通过验收项：
- 未通过/未执行项及原因：
- 数据采集能力限制：
- Git diff 摘要：
- 是否建议进入下一阶段：

现在请从**阶段 0：只读审查**开始，禁止修改任何代码。

---

## 阶段 0 审查完成后的阶段 1 单独指令

当只读审查报告确认方案可行后，使用以下指令：

> 按《精工 Agent Runtime 可观测性中心 1.0》文档执行阶段 1。只实现 Trace 身份、Project/Workspace/Worktree 关联、Context Snapshot、Token 口径标记和存储兼容。不要做 UI 改版，不要实现工具调用列表。先更新阶段实施计划，再修改代码。必须保留现有性能设置和 Runtime fallback。阶段完成后执行受影响测试、build、test，并汇报真实结果；不要自动进入阶段 2。

## 后续阶段指令模板

阶段 N 完成后，使用：

> 按《精工 Agent Runtime 可观测性中心 1.0》文档执行阶段 N。先检查上一阶段 Git diff 和测试结果，确认没有未解决问题；只实现当前阶段目标，不顺手扩展下一阶段。文件边界、真实数据口径、安全规则和验收矩阵必须遵守。执行测试并输出阶段交付报告，完成后停止。

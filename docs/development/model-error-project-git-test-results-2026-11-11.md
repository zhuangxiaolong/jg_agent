# 模型选择、报错提示与项目 Git 测试结果

日期：2026-11-11。范围：本次请求第 2、5、7 项。

## 结果

实现完成，专项单元测试 24/24 通过，两项真实 Electron 桌面烟测通过。使用隔离临时数据、本机 HTTPS 模型列表和临时 Git 裸仓库，没有向外部中转站发送推理请求，也没有拉取、推送用户生产仓库。

## 修改与代码依据

- `SettingsPanel.tsx`：增加“全选”“反选”和已启用数量；启用列、模型 ID、模型名称改为语义表格，使用独立 `provider-models.css`，修复旧 `label` 行被通用表单 flex 样式覆盖导致的错位。
- `use-transient-error.ts`：常用操作错误显示 3 秒自动清除；每次触发单独计时，相同错误文本再次出现也重置计时，组件卸载时清理计时器。
- `App.tsx`、Settings、Git、项目/会话行、插件与 Jira 操作错误接入共享 hook。Runtime 事件、任务失败历史、验证报告及图片/目录不可用的事实状态继续保留。
- `App.tsx`：Git 入口按左侧选中项目启用；没有项目会话或当前为独立会话时，直接显示该项目的 Git 管理。会话绑定与隔离分支仍按原有路径处理。
- `ProjectGitPanel.tsx`：保留 `sessionId` 调用，新增注册项目 `{ projectId }` 目标，与主进程扩展的项目 Git 接口对应；获取、拉取、推送仍使用现有确认、快进和本地修改保护。
- `scripts/provider-settings-smoke.mjs`、`scripts/project-git-smoke.mjs`：扩展真实 UI/IPC 回归验证。

## 已执行验证

1. `npx tsx --test tests/provider-models.test.ts tests/git.test.ts`：24/24 通过，包括模型凭据边界、脱敏、真实 Worktree 隔离、快进拉取、脏目录/分叉/链接/危险远端保护。
2. `node scripts/build.mjs`：通过，生成供专项桌面验收使用的开发产物。完整最终集成构建以总报告为准。
3. `node scripts/provider-settings-smoke.mjs`：通过。真实本机 HTTPS 获取列表，全选、全部反选、部分反选与保存后的模型 ID 一致；1600×900 和 1366×768 表头/数据列像素位置一致，无横向溢出。
4. 同一模型烟测：HTTP 503 错误 3 秒后消失；再次触发相同错误、在可见期间重试，旧计时器不会提前清除新错误；全程不需点击关闭。
5. `node scripts/project-git-smoke.mjs`：通过。左侧只选择项目即可启用 Git 并真实快进拉取，当前独立会话不被绑定；无效项目 ID 拒绝。会话项目的获取、取消确认、拉取、推送、脏目录/分叉阻断、切换项目与无远程状态均通过。
6. `npx tsc --noEmit`：本轮最终检查通过。早期并行编辑期间曾遇到治理模块类型导入未完成，后续已消除，不计为最终失败。
7. 两个 smoke 脚本 `node --check` 与相关文件 `git diff --check`：通过。

## 桌面证据

- `test-results/provider-settings-smoke.json`
- `test-results/provider-model-columns-1366x768.png`
- `test-results/provider-model-columns-1600x900.png`
- `test-results/project-git-smoke.json`
- `test-results/project-git-smoke.md`
- `test-results/project-git-1366x768.png`
- `test-results/project-git-1600x900.png`

已读取检查模型列与 Git 主面板的 1366×768 截图，按钮、列标题、模型值和项目目录均可见。首次项目 Git 烟测的新无效 ID 样本用了 UUID，而实际项目 ID 为 24 位十六进制，因此测试预期文字不匹配；已改成合法格式的不存在 ID，重新执行全项通过。

## 边界

- 本次未对真实远端凭据、生产仓库及外部模型服务进行验收。
- 未打包安装器；本报告证明专项代码、开发构建与隔离桌面路径，不代表已部署到用户当前运行的可执行程序。
- 全量测试和最终性能集成后的构建/回归结果由本次总报告记录。

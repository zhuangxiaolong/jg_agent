# Git diff 默认收起与高度调整测试报告

- 日期：2026-11-11（Asia/Shanghai）
- 结论：构建、385 项现有测试及真实 Electron 专项交互验收通过。
- 项目：精工 Agent，Electron / React / TypeScript 客户端；本次不修改 MES5 / MES6 后端。

## 实现范围

- “代码变更”中的文件差异详情默认收起，保留标题栏；点击文件或标题可展开，再点标题可收起。
- 展开后可拖动详情上方的水平分隔条调整高度，上拖增高、下拖缩小。
- 双击分隔条恢复默认 320px；上下方向键调整高度，Shift 加大步长，Home 恢复默认，End 调至最大。
- 最大高度随面板可用空间变化，保留文件树的操作空间；文件树与差异正文分别滚动。
- 切换会话恢复收起；当前会话内收起再展开保留已调整高度，刷新页面恢复默认。
- 右键保留文件选择行为，“查看对比”展开对应文件；保留二进制和大文件截断提示。
- 拖动中通过键盘收起详情时清理 pointer capture 与全局拖动状态。

## 实际验证

1. `npm run build`：通过，包括 TypeScript 类型检查和打包构建；最后一次构建已包含拖动清理修复。
2. `npm test`：385 项通过，0 失败、0 跳过。
3. `node scripts/diff-preview-smoke.mjs`：通过，8 组检查覆盖默认收起、标题切换、刷新、文件选择、右键菜单、鼠标拖动上下限、键盘、双击复位、拖动中收起、会话切换、页面刷新、清空差异和原项目保护。
4. 1366×768、1600×900、1000×700 三种窗口尺寸：通过，详情不越出面板，文件树与正文均有可用空间，无页面横向溢出。
5. 人工查看折叠截图及 1000×700 最大展开截图：标题、拖动条、滚动区域和文件树显示正常。
6. `node --check scripts/diff-preview-smoke.mjs` 与本次修改的已有文件 `git diff --check`：通过。

首次专项执行发现测试假定默认选中文件为 README.md，但实际 Git 返回的首个文件是中文新增文件；已改为读取实际选中文件后验证，再显式选择 README.md。修正后的完整专项通过。

## 证据与边界

- 专项机器结果：`test-results/diff-preview-smoke.json`。
- 专项明细：`test-results/diff-preview-smoke.md`。
- 截图：`test-results/diff-preview-collapsed.png`、`test-results/diff-preview-expanded.png`、`test-results/diff-preview-expanded-1366x768.png`、`test-results/diff-preview-expanded-1600x900.png`、`test-results/diff-preview-expanded-1000x700.png`。
- 专项使用真实开发 Electron、临时本地 Git 仓库及隔离数据目录；没有连接用户项目、模型或远程 Git 服务。
- 改动仅涉及 renderer 详情交互、样式及专项验收脚本；没有变更 Git 命令、暂存/提交逻辑或持久化布局格式。仓库原有未提交修改保留。
- 本次完成源码和开发构建验证，未生成新的安装包，未替换正在运行的安装版，也未提交或推送代码。

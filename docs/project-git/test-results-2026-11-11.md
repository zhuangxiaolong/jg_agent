# 主界面项目 Git 操作测试报告

日期：2026-11-11（Asia/Shanghai）

## 结果

会话绑定本地项目后，可以在主界面右侧“Git → 项目仓库”直接获取远程更新、拉取项目代码、推送项目当前分支、刷新状态和查看提交历史。操作区显示已绑定项目的实际目录及当前分支；原有会话隔离分支、提交和验证功能保留。

构建通过；Git 专项 19/19 通过；最终代码新增项目场景独立复测 4/4 通过；真实 Electron 桌面验收 11 项通过。全量测试 384/385 通过，唯一失败为 Runtime 图片协议测试中原生命令的 15 秒超时；该测试文件未修改，随后独立复测 2/2 通过。不能将首次全量运行表述为全部通过。

## 改动与操作边界

- 新增项目 Git 状态、获取、拉取和推送 IPC，项目目录由主进程通过会话绑定的已登记项目解析，不接受前端任意目录。
- Git 面板顶部展示项目仓库操作，切换会话或重新绑定项目时重新读取状态；尚未应用输入区项目选择时，提示先绑定或切换项目，避免操作旧项目。
- 项目操作与会话 Git、验证及 Agent 任务沿用主进程互锁；原生确认框显示实际项目目录、当前分支与远程目标，确认后再次检查项目绑定、分支、HEAD 和目录状态。
- 获取只更新所选远程的跟踪分支；拉取只接受当前同名分支的快进更新，不自动合并、暂存或重置；推送不强制覆盖远程。
- 项目有本地修改、分离 HEAD 或分支分歧时拒绝相关写操作；复用原有远程协议、Hook/Filter、链接、忽略文件和工作区身份保护。
- 项目仓库操作更新项目原目录，不自动同步会话隔离目录；界面对此有明确提示。

## 构建和自动化测试

1. `npm run build`：通过，包含 TypeScript 类型检查与 Electron 主进程、preload、renderer 构建。日志：`test-results/project-git-build.log`。
2. `npx tsx --test tests/git.test.ts`：19/19 通过，覆盖原 15 项 Git 回归和新增 4 项项目仓库操作。
3. `npx tsx --test --test-name-pattern="项目" tests/git.test.ts`：最终代码 4/4 通过。日志：`test-results/project-git-targeted-tests.log`。
4. `npm test`：385 项中 384 通过、1 失败。日志：`test-results/project-git-full-tests.log`。失败命令为固定 Windows Runtime 的 `app-server generate-ts`，测试的 15 秒命令超时触发 SIGTERM，无标准错误输出。
5. `npx tsx --test tests/runtime-images.test.ts`：2/2 通过，其中原失败场景耗时约 2.47 秒；未改动 Runtime 或原测试。日志：`test-results/project-git-runtime-images-retest.log`。
6. `node --check scripts/project-git-smoke.mjs`、本次涉及的受跟踪文件 `git diff --check`：通过。

## 真实桌面验收

执行：`node scripts/project-git-smoke.mjs`。使用真实开发 Electron 和临时本地 Bare 远程、项目仓库及远端副本，不连接真实项目、模型或网络服务。

验收结果 11/11 通过：

1. 独立会话禁用 Git，项目 Git IPC 拒绝未绑定会话。
2. 绑定后主界面显示实际项目目录、`main` 分支和三项远程操作入口。
3. 获取真实更新 `origin/main`，项目 HEAD、文件及会话目录保持不变。
4. 取消原生拉取确认后项目 HEAD 和文件保持不变，确认框含项目目录和分支。
5. 确认拉取后真实项目 `main` 快进，项目文件更新，会话隔离分支 HEAD 和内容保持不变。
6. 项目有未跟踪文件时 UI 禁用拉取和推送，直接调用 IPC 同样拒绝，文件保留。
7. 推送真实更新项目远程 `main`，不推送或修改会话 Agent 分支。
8. 本地和远程分歧时停止，不创建合并、冲突文件或移动本地 HEAD。
9. 同一会话切换项目后改用新项目目录及 `release` 分支，旧错误清空，无远程时禁用操作。
10. 切换到独立会话后不能遗留上个会话的项目操作目标。
11. 1366×768、1600×900 均无横向溢出，项目操作按钮可见；已人工查看两张截图。

记录：`test-results/project-git-smoke.json`、`test-results/project-git-smoke.md`、`test-results/project-git-desktop.log`。

截图：`test-results/project-git-1366x768.png`、`test-results/project-git-1600x900.png`。

验收脚本初次运行遇到默认断言超时、Windows 短路径与规范路径不一致，以及返回折叠项目下会话的定位问题；已修正脚本等待、路径规范化和展开项目步骤，最终完整重跑通过。这些修正未放宽 Git 操作断言。

## 未覆盖事项

- 尚未验证真实私有 HTTPS/SSH 远程、账户权限和网络故障恢复；原有 HTTPS 凭据未接入限制保持不变。
- 本次生成开发构建，未重新打包安装程序或替换已安装版本。
- 工作区原先已有多项未提交改动，本次保留，不将其归入本需求。

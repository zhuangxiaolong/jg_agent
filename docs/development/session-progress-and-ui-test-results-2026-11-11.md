# 会话实时进度与界面修复测试结果

日期：2026-11-11（Asia/Shanghai）

## 结论与测试程序

本轮会话进度改动已完成。源码构建、全量测试、显示专项测试和实际打包程序桌面冒烟均通过。测试包沿用应用版本 0.6.8，通过独立目录区分本次构建。

启动程序：`D:\jinggong-agent\release\test-20261111-progress-fixed\win-unpacked\JinggongAgent.exe`

请保留 `win-unpacked` 完整目录，直接运行其中的程序。该程序为免安装测试包，非新发布的在线更新安装包。打包快照时间为 2026-11-11 21:03:26（本地时间）；后续共享工作区中的修改不改变此测试包。

## 本轮调整

- 运行中的提示展示当前轮最新的工具、状态、错误或回复进展，连续文本增量合并为一条摘要。
- 点击进度行可展开/收起最近 5 条可读事件；新一轮运行默认收起，上一轮进度不会带入新一轮。
- 搜索、读取等日常命令可以在进度区显示当前活动，主消息时间线继续压缩内部工具噪声。
- 完成提示使用 3 秒自动消失逻辑；隐藏会话插件快照和内部“代码变更核验”消息。
- 保留前序 Git 拉取免确认、无凭据 HTTP 地址支持、HTTP(S) 错误脱敏，以及 Runtime 定位/Grok 下一版本兼容说明。
- 实际桌面回归发现首次空 Codex 插件 Profile 会无意义调用 Marketplace 卸载。本轮修正为：确认无插件、无绑定和既有 Marketplace 时直接完成空同步，仍保留独立 Home；已有 Profile 的卸载、失败和回滚检查保持有效。

## 验证结果

- `npm run build`：通过，含 TypeScript 检查和桌面源码构建。
- `npm test`：436/436 通过，0 失败、0 跳过，耗时约 341 秒。
- `npx tsx --test tests/running-indicator.test.ts tests/event-display.test.ts tests/plugin-snapshot-display.test.ts`：8/8 通过。
- 插件服务定向测试：14/14 通过，含首次空 Profile、独立 Home、已有目录/历史绑定及失败回滚。
- `node scripts/stage-runtime.mjs`：通过，校验并准备 Codex 0.156.1、Jinggong 0.1.0、Claude Agent SDK 0.3.319 / Binary 2.1.319。
- electron-builder Windows x64 目录打包：通过，使用与仓库正式配置相同的文件过滤和 Runtime 资源列表，独立输出测试目录。
- `JINGGONG_TEST_EXE=<上述程序> npm run test:desktop`：通过，31 项实际 Electron 窗口检查。
- `git diff --check`：通过。

实际测试包检查覆盖：实时事件驱动摘要更新、连续文本合并、点击展开/收起、终态移除、新一轮清空旧进度且默认收起、完成横幅自动消失、独立/项目会话创建、隔离 Worktree/Diff、剪贴板、三类 Runtime 清单、DPAPI 和退出重启读回。运行进度事件使用离线测试注入，未调用外部模型。

桌面测试结果：`test-results/desktop-packaged-smoke.json`

进度展开截图：`test-results/desktop-running-progress.png`

## 测试包指纹

- `JinggongAgent.exe` SHA-256：`0d902476aec5b1d91a42e937ac4367844f63bfb6526062d81d8188acacd8eef7`
- `resources/app.asar` SHA-256：`9521b7c2936e3ee8d21efabab9bf6621ab2a0cc2cb5c85298a1f63e0a6160aef`
- `resources/app.asar` 大小：99,354,081 字节。
- 随包 Codex/Jinggong/Claude Runtime manifest、数据字典 manifest 和 SQLite wasm 均存在，并通过实际程序启动回归。

## 实测范围与遗留事项

真实模型长时间运行、用户项目远程 HTTP(S)/SSH 的认证及拉取、实际业务任务的速度提升幅度，仍需使用本测试程序确认；本报告不将离线事件注入当作真实模型执行。

首次临时打包配置未包含正式文件过滤，产生异常中间目录 `D:\jinggong-agent\release\test-20261111-progress`，该目录不作为测试产物。自动审批拒绝删除该目录及其异常 app.asar 的操作，已保留原状。后续已按完整正式配置成功重新打包，交付目录为带 `-fixed` 后缀的目录。临时构建配置文件已移除。

# 精工 Agent

Windows 桌面研发 Agent PoC。正式依据为 docs 内三份 V1.1，运行时固定 Codex CLI 0.156.1。无应用服务器、无 localhost API、无 Docker/PostgreSQL/Python 依赖。

V0.5.0 已安装并通过 **96/96 模块测试**和安装版 **35 类验收**：新会话默认隔离开发，Jira 在右侧按账户时区当天自动抓取，左侧/右侧/底部面板支持隐藏、恢复及本地持久化。旧只读会话保持原模式，升级保留原 SQLite 和三份 DPAPI 文件。完整证据见 [V0.5 验收记录](docs/development/v0.5-docked-workspace.md)。交付分支为 [develop/desktop-poc](https://github.com/zhuangxiaolong/jg_agent/tree/develop/desktop-poc)，远程推送结果另行登记，不提交或推送主分支。

实际用户 Jira 也已验证：按 `Asia/Shanghai` 的 2026-11-05 自动查询成功返回 0 条，并保存真实本地记录；中央会话、右侧 Jira 和底部面板同时可见，原2项目、4会话及配置/事件保留。该结果只对应当天默认筛选，不代表账号没有其他任务；无会话创建、模型请求或 Jira 写入，见 [real-workspace-v050.json](test-results/real-workspace-v050.json)。隔离合成接口的35类验收与此次真实只读验证分别记录。

## 开发运行

开发机需要 Windows x64、Node 24、npm 和 Git for Windows。最终安装用户不需 Node。

```powershell
npm ci
node node_modules/electron/install.js
node scripts/stage-runtime.mjs
npm run build
npm test
npm run test:desktop
npm start
```

本机 npm 策略如跳过 Electron 安装脚本，第二条命令会从官方源准备 Electron。没有全局环境变量或软件升级。

## 安装包

```powershell
npm run dist
```

当前 **V0.5.0 已安装并验证**。安装包为 `release/JinggongAgent-Setup-0.5.0-x64.exe`，245058988 字节，SHA256 为 `E95163D052885C0BB522EABDAE1CA966551DB13BFFA063E38177478FD32FCF2A`。NSIS 安装 0.5.0.0 退出码 0，升级前备份完成，原 SQLite 和全部三份 DPAPI 摘要一致，schema 仍为 2；安装版基础11类、Jira/要求6类、V0.4工作流9类、新增9类均通过。Jira 使用明确合成 HTTP 验收，无真实模型调用，详见 [V0.5 验收记录](docs/development/v0.5-docked-workspace.md)。V0.4.1 的真实五图、原生 Alt+F4 与二次启动历史证据见 [V0.4 记录](docs/development/v0.4-desktop-workflow.md)。测试包暂未代码签名。安装包携带 Electron、SQLite WASM、固定 Codex 0.156.1 原生文件和精工 Logo；当前需要 Git for Windows，缺失会在界面提示。

V0.4 支持项目显示名称、会话别名与推理强度、新主题、Jira 本地记录与图片、Git 快进拉取及系统托盘。V0.4.1 兼容真实 JPEG 被错标 PNG 的附件，按结构去除 EOI 后有界尾内容，仅规范化本地缓存，不改源附件；真实安装版五图已显示并在重启后保持缓存 SHA256 一致。生产菜单经 Menu.popup 弹出后的原生鼠标打开/退出已通过，未直接点击系统托盘图标。推理档位实际支持由模型和中转站决定，本地 Runtime 协议通过不代表真实视觉模型已执行。

## 使用

打开设置，可管理外观、多个模型中转站与模型列表、Jira 域名/账号/密码、本地记忆、按 MES5/MES6/WMS 分类的生产字典。独立“开发要求与规范”入口支持上传文件、直接输入与编辑标题和完整正文、查看、启停及删除。模型需要兼容 HTTPS Responses API 与流式工具调用；凭据由用户独立配置，应用不读取现有 Codex 登录。

Jira 连接支持 HTTP/HTTPS 和项目页地址自动归一，项目 Key、日报日期字段可设置。V0.3.2 增加项目范围选择，默认“全部可访问项目 + 日报日期 + 仅我的任务”，也可选择具体 Jira 项目、取消本人筛选或查询不限日报日期的最近任务。“全部可访问项目”仍受当前账号权限和其余筛选条件约束。查看需求与附件清单后可关联本地项目创建会话，任务快照带入 Agent 上下文，由用户点击发送。V0.4 增加图片的受控下载、缓存预览与会话原生输入；非图片附件当前仍仅展示来源元数据，通用下载解析另行验收。

旧查询固定在 `NEWDEVGROUP`，此前该项目的一条任务诊断不能代表全账号情况。V0.3.2 真实安装版使用原保存凭据读取到 171 个可访问项目；在 2026-11-04、仅本人条件下，全部项目和 `CD` 均返回截图中的 2 条目标任务，`NEWDEVGROUP` 返回 0，切回全部项目仍为 2。两条任务详情概要与 API 一致，分别显示 2/3 条附件元数据，旧查询条件改变后禁止继续操作旧结果。证据 `test-results/real-jira-installed-v032.json`；未新增用户会话或写入设置，模型请求和 Jira 写入均为 0。会话创建与重启持久化使用隔离的合成 Jira/真实 Git/SQLite 验证，不代表用户生产仓库或模型开发已验收；十个工作日人工核对仍未完成。详见 [V0.3 Jira 联调记录](docs/development/v0.3-jira-requirements.md)。

选择有提交的本地 Git 仓库并创建会话，应用建立独立 Worktree，默认“隔离开发”；旧只读会话保持原模式。会话顶部选择中转站、模型、适用系统及执行模式，点击“应用设置”。右侧 Jira 按账号时区当天自动读取本人任务，与中央会话同时使用；左侧、右侧和底部可通过顶部按钮隐藏恢复，显示状态在重启后保留。隔离开发支持受控文本文件新增、修改和删除；每次写入先校验开发规则。当前不执行任意 Shell 或项目构建命令，Windows 原生沙箱和真实模型自动构建测试仍待后续验收。

右侧 Git 页可查看最近 50 条记录、按真实 Diff 生成中文提交说明、检查开发要求、提交和推送当前 agent 分支。提交和推送由用户点击并确认，不自动操作主分支；推送支持已可无交互认证的 SSH 与本地 Bare 仓库，HTTPS 凭据接入尚待完善。

资料支持 UTF-8 MD/TXT/JSON/CSV/SQL、DOCX 和 XLSX。V0.2.1 修复大型生产字典导入：允许用户选择的普通硬链接文件作为只读快照来源，支持合法的样式空单元格；字典上限为 200 万字符、25 万单元格、256 个工作表和 32 MiB 文件。来源不写入，正文完整保存至 SQLite；分页和关键词检索用于查看全文。SQL/CLR 结构中的 Password 等字段名可作为字典元数据，真实凭据赋值和密钥仍拒绝。

字典通过 `search_dictionary` 检索和 `read_dictionary` 偏移分块工具按需读取，只开放当前适用系统和已启用资料；上下文保留目录与来源说明。开发要求仍保持单份 8 万字符及完整注入，JSON 机器规则会阻断违规写入与提交，自然语言要求提交前需人工逐份复核。动态工具协议、桌面断管错误处理及安装版实际导入复测已通过，结果见 [V0.2.1 字典修复记录](docs/development/v0.2.1-dictionary-fix.md)。一般使用方式见 [设置和受控开发说明](docs/architecture/settings-and-development.md)，本次容量变更以 V0.2.1 记录为准。

V0.2 功能基线见 [V0.2 验收记录](docs/development/v0.2-acceptance.md)，V0.1 基线见 [第一阶段记录](docs/development/poc-acceptance.md)。V0.2.1 编译、50 项完整测试、11 类安装版桌面回归、两份真实工作簿 144 页完整导入与重启持久化、真实断管存活及安装升级均通过。真实模型任务、原生沙箱和干净 Windows 环境仍需分别验收。

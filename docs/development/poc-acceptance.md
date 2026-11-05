# 第一阶段 PoC 验收记录

本文件保留 V0.1 历史基线。V0.2 已新增设置、资料导入、多模型、受控代码写入和 Git 操作；当前状态见 [V0.2 验收记录](v0.2-acceptance.md)。

日期：2026-11-04；版本：0.1.0；仓库分支：develop/desktop-poc（未自动提交）。

结论：Windows 桌面基础链路已可运行，完整 Agent 自动开发 PoC 尚未通过。真实模型推理需用户在新应用独立配置凭据；Windows 原生沙箱未配置，开发写入和命令执行未开放。不能把下列协议/Git/SQLite 测试当作 Agent 已完成修改或业务测试。

## 第一阶段十项任务

1. 环境检查：通过。Windows 11 x64、Node、Git、.NET、VS、固定 Codex 已实测；Rust 未安装。详见 environment-assessment。
2. 桌面技术选型：完成。采用 Electron/React/TypeScript；Tauri/.NET 的代价和备选条件写入 ADR-001。
3. Runtime 集成：真实 stdio 初始化、线程创建、版本核对、无凭据拒绝和进程关闭通过。真实模型鉴权、流式推理和有活动 turn 的取消仍未验收。
4. 目录结构：完成。UI/Main/preload/domain/storage/git/runtime 分层；Jira/知识/规则/模型和记忆后续模块已定义边界与任务。
5. 项目骨架：完成。固定依赖、lockfile、构建/测试/打包命令、运行时清单与许可。
6. Windows 桌面界面：通过。实际 Electron 窗口，本地 file 页面，界面截图已生成。
7. 主进程与 Runtime 通信：通过到真实协议边界。使用独立 CODEX_HOME、stdio JSONL，无本地 HTTP/WebSocket 服务。
8. 最小 Agent 会话/流式输出：代码已实现，真实推理待配置。UI 处理真实 delta/completed/failed/interrupted；没有模拟响应代替成功。当前用户选择自行在应用中配置模型凭据。
9. 目录选择与 Diff：通过。原生目录选择入口、真实 Worktree/分支、真实新增/修改/删除/staged/untracked/二进制差异；源 main 未改。自动化仅替换原生选择对话框的返回路径，不替换 Git/文件数据。截图中的差异来自测试脚本对临时仓库的修改，不是模型生成成果。
10. 本地持久化：通过。SQLite 事务、落盘、重开、失败/中断状态、损坏/高版本保护、备份；DPAPI 在真实 Electron 进程加解密成功，数据库没有测试密钥明文。

## 已执行验证与证据

- npm run build：TypeScript 与实际 UI/Main/preload 构建通过。
- npm test：SQLite、Git、Runtime 协议、IPC 参数、取消生命周期与只读工具测试；最终数量见本文件末尾记录。
- npm run test:desktop：真实 Electron 两次启动，Renderer 无 require/process，Node Integration 关闭、Context Isolation/Sandbox 开启；其他窗口调用同样 preload 仍被主进程拒绝；目录/Worktree/Diff/凭据/备份/重启恢复验证。
- 打包程序在应用 PATH 移除 Node.js 后运行同样验证通过。测试脚本自身由开发机 Node 驱动；此检查证明应用本体使用内置 Node，不能替代干净 Windows 账户验收。
- npm run dist：已生成 NSIS x64 安装包；第一次本机静默安装退出码 0，安装目录 release/installed-poc 存在真实桌面 EXE。最终包变更后重新安装和复测结果补充在末尾。
- npm audit --omit=dev：生产依赖 0 漏洞。只表示当前依赖审计结果，不替代产品安全评审。
- 证据：test-results/desktop-welcome.png、desktop-workspace.png、desktop-smoke.json、desktop-packaged-smoke.json；真实 Runtime 探针原始结果 docs/development/runtime-probe-results.json。

## 尚未验收的退出条件

- 独立模型网关真实鉴权、连续 delta、真实工具调用、活动取消/失败恢复、重启后继续已有模型会话。
- 配置并验证 Windows 原生沙箱；在受控样本 Worktree 完成模型修改、实际执行构建/测试，再检查源仓库、网络与文件越界。
- 干净普通 Windows 用户环境的安装/升级/卸载、无 Node/Python/Docker/PostgreSQL 启动；当前开发机安装不可等同干净机器。
- Git 缺失的可信安装引导/Portable Git、完整数据备份恢复、跨用户 ACL、主进程硬崩溃后的子树回收、长时间和并发资源测试。
- 安装包暂未签名；正式分发前完成签名与第三方许可/供应链审查。

PoC 完整通过前，不将 Jira、知识库、规范、多模型认证或长期记忆标记为已实现。后续任务与逐项验收标准见 desktop-backlog.md。

## 最终复测记录

- npm run build：通过。
- npm test：20/20 通过，无跳过；日志 test-results/unit-tests.txt。
- 开发版桌面冒烟：7 类检查通过，包括未知窗口 IPC 拒绝、更换网关密钥隔离和损坏凭据恢复。
- 真实 Runtime 注册两个受控只读文件工具，启动和每个任务设置 environments=[]；已核验该固定版本在无执行环境时不注册 Shell/apply_patch。真实模型调用这两个工具仍未执行。
- 最终应用内容安装后，在去除 Node.js 路径的应用环境中执行相同桌面冒烟，7 类检查通过；证据 desktop-packaged-smoke.json 指向 release/installed-poc 下的实际安装程序。
- 已安装目录的内置 Codex 再次执行真实协议探针，10 项检查均通过，包括动态工具注册、无内置执行环境、持久化用户输入的恢复和正常 EOF；探针没有生成或注入任何模型答复。
- 安装脚本另明确区分升级、静默卸载和交互卸载：升级及静默卸载保留数据；交互卸载默认保留，选择清除时才删除。此保护不等于完整升级/卸载场景全部验收。
- 最终安装/覆盖升级退出码 0，本地数据保留标记验证通过；安装目录 app.asar 与构建产物 SHA256 一致。记录见 test-results/installer-verification.json。
- 交付安装包约 233.2 MiB，SHA256：D57E0A957888A21F0A8AE40EF42F6851E7F8F24F177BE7BF9310521FD3ED7C3E。安装程序未签名，交付定位为本机 PoC 测试包。

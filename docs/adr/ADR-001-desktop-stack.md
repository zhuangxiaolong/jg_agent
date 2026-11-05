# ADR-001：Windows 桌面 PoC 技术栈

状态：已采用；日期：2026-11-04；依据：docs 下三份 V1.1 正式需求及本次启动指令。

决定采用 Electron 45.2.2 + React 19.3.1 + TypeScript 5.9.3，Node 主进程调用固定 Codex CLI 0.156.1 的 app-server stdio。使用 sql.js 1.15.2 的真实 SQLite WASM，数据写回本地数据库文件；无需最终用户预装 Node 或数据库服务。打包使用 electron-builder 26.18.0 / NSIS，固定版本与 lockfile。

## 选型依据

- Electron：当前已有 Node/npm 开发环境；child_process、受限 preload IPC、safeStorage 和 NSIS 可直接覆盖本轮关键链路。代价是较大的安装包和 Chromium 内存占用，需严格隔离渲染进程。
- Tauri 2：可通过 Rust Command 管理原生 codex.exe，支持 NSIS/MSI 和 capability 权限；预期资源更少。但当前无 Rust/cargo，需要增加工具链和 sidecar 生命周期/分发验证。保留为资源优化备选，本轮未构建 Tauri 对照二进制，不声称性能测量优于 Electron。
- .NET WPF/WinUI：本机有 .NET 与 Visual Studio，原生 Windows 集成可行；但需额外桥接 JSON-RPC 和 Web 代码 Diff 交互。团队熟悉程度尚未确认，不作为本轮主选。

原生 Codex 可执行文件并不依赖 Electron/Tauri；本次选择源于集成路径和环境，非 Runtime 只能在 Electron 中运行。

## 安全边界

nodeIntegration=false、contextIsolation=true、sandbox=true、webSecurity=true。窗口只 loadFile 本地构建产物；CSP 禁远程脚本和网络请求；拒绝导航、新窗口与浏览器权限。preload 只暴露列举的业务方法，主进程复核调用页面、主 frame、UUID、字符串长度和 HTTPS URL。所有进程使用参数数组，shell=false。

## 有意保留的 PoC 限制

SQLite WASM 在每次提交后原子导出快照，适合当前单进程小数据 PoC；大量 delta 事件会造成写放大，后续应批量写入或迁移原生 SQLite 并保留 schema。单实例锁避免同一用户并行写数据库。没有引入 Python 服务或监听端口。

本机原生 Windows 沙箱 readiness 为 notConfigured，不能把 Worktree 或提示词当作系统安全隔离。当前 Runtime 禁用命令执行并拒绝工具权限升级，只提供分析会话；开发写入模式必须在完成沙箱越界测试后启用。这是尚未验收的需求，不是删除需求。

## 核验来源

- [Electron 安全基线](https://www.electronjs.org/docs/latest/tutorial/security)
- [Tauri 开发先决条件](https://v2.tauri.app/start/prerequisites/)
- [Codex App Server](https://learn.chatgpt.com/docs/app-server)
- [electron-builder NSIS](https://www.electron.build/nsis/)

需求技术方案中的示例启动提示要求“仅方案后停止”，本轮用户明确要求实际编码与验证，故继续实施；没有修改三份正式需求原文。

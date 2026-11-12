# 双 Runtime 改造：现状盘点

盘点日期：2026-11-09

## 项目指纹

当前仓库不是 MES5/MES6 后端仓库，没有 `.sln` 或 `.csproj`。它是 Windows Electron + React + TypeScript 桌面应用：Electron 45.2.2、React 19.3.1、TypeScript 5.9.3，入口由 `apps/desktop/src/main/index.ts`、`apps/desktop/src/preload/index.ts` 和 `apps/desktop/src/renderer/App.tsx` 组成。

## Runtime 现状

- `packages/agent-runtime/src/index.ts` 中的 `CodexRuntime` 启动固定版本 `@openai/codex 0.156.1` 的 `app-server --listen stdio://`，通过 JSONL JSON-RPC 通信。
- 主进程曾直接创建 `CodexRuntime`，负责健康检查、启动、thread 创建/恢复、turn 发送、中断、事件落库和完成收尾。
- 安装资源位于 `apps/desktop/resources/runtime`，`manifest.json` 对每个文件做 SHA-256 校验，入口为 `bin/codex.exe`。该资源是官方 Codex 包，不能视为 Jinggong Runtime。
- 当前执行配置明确使用 `danger-full-access` 和 `approval_policy=never`。这只能表示当前 Codex 配置，不表示已通过 Windows 原生沙箱验收。
- 没有 Rust/Cargo/MSVC 工具链，因此本机不能直接完成 Codex Harness Fork 的 Windows 编译 PoC。

## 数据与业务依赖

- `packages/storage` 使用 sql.js SQLite，当前 schema version 为 2。会话、事件、项目、模型配置、资料和记忆均由 `LocalStore` 管理。
- 旧会话只有 `runtimeThreadId` 和能力版本，没有 Runtime 类型；迁移读取时按 Codex 兼容会话处理，保存新会话时固定 Runtime 类型。
- API Key 在主进程通过 DPAPI 文件读取，Renderer 只接收 `hasKey`，Jira、Git、知识库和记忆均由主进程拼接为 Runtime 的开发上下文。
- UI 通过 `DesktopApi` 调用 IPC，设置面板已具备模型、Jira、资料、记忆和更新管理能力。

## 构建与测试

- `npm run build`：TypeScript 检查后执行 Electron 主进程、preload 和 renderer 打包。
- `npm test`：运行 `tests/*.test.ts`，包含存储、策略、会话、Runtime 协议和桌面管理测试。
- `npm run test:desktop`：Electron/Playwright 桌面冒烟测试。
- `npm run pack` / `npm run dist`：先构建并执行 `scripts/stage-runtime.mjs`，再由 electron-builder 打包。

## 改造边界

阶段 1 先完成 Runtime 契约、选择持久化、会话绑定和双 Runtime UI。Jinggong Runtime 的真实 Fork、独立二进制、Windows 沙箱验收和安装包默认可运行需要 Rust 工具链、固定源码补丁和干净 Windows 测试机，不能用现有 `codex.exe` 代替。

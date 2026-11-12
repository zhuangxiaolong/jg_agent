# 双 Runtime 架构

## 运行链路

```text
Renderer
  -> DesktopApi / IPC
  -> Electron Main Process
  -> RuntimeManager
      -> CodexRuntimeAdapter -> 官方 Codex App Server stdio
      -> JinggongRuntimeAdapter -> 独立 Fork 构建的 jinggong-runtime.exe
```

RuntimeManager 是唯一的 Runtime 选择入口。业务代码只依赖 `AgentRuntimeAdapter`，不直接 spawn、拼接 CLI 参数或解析 Runtime 原始协议。两种 Runtime 统一输出 `RuntimeEvent`，再由主进程完成凭据脱敏、会话状态更新和 SQLite 事件落库。

## 选择和会话规则

- 全局设置默认值为 `jinggong`，旧配置缺少该键时写入 `jinggong`。
- 旧会话没有类型时按 `codex` 兼容读取，避免把历史 thread 误恢复到另一种 Runtime。
- 新建会话记录创建时的 `runtimeKind`；首次启动后记录 `runtimeVersion` 和能力版本。
- Runtime 选择只影响新建会话。已有会话的类型不可被设置切换改写；切换后必须新建会话。
- Jinggong 不可用时返回明确错误，RuntimeManager 不静默回退 Codex。

## 安全边界

Runtime 从独立资源目录启动，按 Manifest 中的相对路径和 SHA-256 校验二进制。Jinggong 来源锁定到固定上游提交、精工补丁和 Cargo.lock，二进制名称、版本与 App Server User-Agent 均标识 Jinggong。

当前 agent 执行策略仍使用 `danger-full-access`、`approval_policy=never`，对当前任务的执行审批自动接受；运行环境也继承本机大部分变量。它保留既有开发行为，但不满足方案中的工作区沙箱、逐项审批和凭据最小传递要求。设置页与清单保持“安全能力待验收”，不能将协议探针通过解释为 OS 沙箱通过。发布前必须完成审批流程、环境变量 allowlist 和 Windows 原生边界验证。

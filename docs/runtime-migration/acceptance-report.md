# 双 Runtime 阶段验收报告

日期：2026-11-09

## 已完成

- 默认 Runtime 持久化为 Jinggong；用户可主动切换 Codex，切换只影响新会话。
- 会话保存 `runtimeKind`、`runtimeVersion`、`runtimeThreadId`，已创建会话禁止更换 Runtime。
- Desktop Main Process 统一通过 Adapter 管理两个 app-server stdio Runtime；UI 不直接启动 CLI。
- Jinggong 使用独立 Fork 构建物，不是重命名 Codex 二进制；安装资源包含版本、上游 commit、补丁、许可证和逐文件 SHA-256 清单。
- Runtime 清单校验会拒绝空清单、路径穿越、符号链接、缺失 helper、额外未列文件和哈希篡改。
- 审批采用一次性令牌、当前任务绑定、超时、取消、终态和窗口关闭自动拒绝；审批内容不写入会话事件。
- API Key 使用 DPAPI/safeStorage，Runtime 子进程只继承白名单环境并排除密钥模式。

## 当前证据

| 项目 | 结果 |
|---|---|
| TypeScript/应用构建 | `npm run build` 通过 |
| 单元测试 | 最终命令结果见 `test-results/agent-test-results-*.md` |
| 独立 Jinggong 协议 | `initialize`、start/resume、工作区读写、外部写拒绝、凭据过滤、EOF 通过 |
| Codex 协议 | 同上 |
| Runtime 完整性 | 成品 staging 后由 manifest 和 `runtime-integrity` 双重校验 |
| Windows 网络沙箱 | 未通过 raw loopback；见 `windows-sandbox-test.md` |
| 真实模型闭环 | 未执行，未使用真实凭据 |
| 干净 Windows/普通用户 | 未执行 |

## 结论

双 Runtime 的代码接入、独立 Jinggong 构建、随包资源、会话切换和审批边界已经落地。当前可交付为内部验证包；由于 `unelevated + networkAccess=false` 的原始 TCP loopback 测试失败，不能把 Windows 沙箱标记为完整通过，也不能把本次探针描述为真实模型开发闭环。发布前必须补齐硬性网络策略或明确降级策略，并在干净 Windows 普通用户环境复测。

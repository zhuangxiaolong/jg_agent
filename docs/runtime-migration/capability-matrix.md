# Runtime 能力矩阵

| 能力 | Codex Runtime | Jinggong Runtime | 证据与限制 |
|---|---|---|---|
| stdio JSONL | 已实现 | 独立 Fork 已实现 | 两个实际 Windows 二进制完成协议探针；不开放 localhost HTTP/WebSocket |
| 创建/恢复会话 | 已接通 | 已接通 | 协议 start/resume 通过；真实模型闭环待凭据回归 |
| 流式事件 | Adapter 已接通 | Adapter 已接通 | 未执行真实模型流式推理 |
| 任务中断 | Adapter 已接通 | Adapter 已接通 | 活跃模型 turn 的取消待真实模型回归 |
| 文件、Diff、终端 | 平台主流程已接通 | 平台主流程已接通 | 真实模型驱动修改和测试待回归 |
| 用户审批 | 单次令牌、超时、取消、关闭拒绝 | 同一实现 | 协议审批请求进入桌面 ApprovalBroker；本探针未伪造模型审批 UI |
| 工作区边界 | 工作区读写通过，外部写入被拒绝 | 同上 | 原生 Windows 边界通过当前探针 |
| 网络边界 | 部分 | 部分 | `networkAccess=false` 下 raw loopback 仍可达，不能宣称硬性禁网 |
| 版本完整性 | 0.156.1 + SHA-256 清单 | 0.1.0 + 独立 SHA-256 清单 | Jinggong 固定上游 commit、补丁、Cargo.lock 和构建元数据 |

两个 Runtime 都由统一设置、会话归属和 Adapter 管理；不可用时显示明确错误，不静默回落到另一 Runtime。安全能力状态仍为 `sandbox: unverified`。

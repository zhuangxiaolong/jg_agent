# Windows 沙箱验证记录

状态：部分通过，网络硬隔离未通过（2026-11-09）。

验证环境为当前 Windows x64 开发机（系统版本 `10.0.26200`，账户为 Administrator），不是干净安装机，也不是普通权限专用测试账户。探针不读取真实模型凭据，不发起模型请求，结果分别保存于 `test-results/runtime-probe-jinggong.json` 和 `test-results/runtime-probe-codex.json`。

## 已通过

- 两个 Runtime 均完成 `initialize`、`account/read`、`thread/start`、`thread/resume` 和 stdio JSONL EOF 退出。
- 两个 Runtime 都回显 `sandbox=workspace-write`、`approval_policy=on-request`、`approvals_reviewer=user`、`networkAccess=false` 和 `windows.sandbox=unelevated`。
- 工作区内 PowerShell 读写成功；工作区外写入返回非零退出且目标文件不存在。
- 受测子进程没有拿到测试注入的哨兵变量或模型密钥名。
- readiness 返回 `ready`，但这只是 Runtime 自报状态，不作为越权边界证明。

## 未通过与边界

`command/exec-blocks-raw-loopback-network` 在两个 Runtime 均失败：父 Node 进程先对临时 `127.0.0.1` listener 建立正向连接，之后受测 PowerShell 在 `networkAccess=false` 下仍然连接成功（`baselineHits=1`、`networkHits=1`）。因此当前 Windows `unelevated` 路径不能宣称操作系统级原始 TCP 禁网。

根因是上游 `windows-sandbox-rs` 的 legacy/unelevated 路径主要通过环境变量和代理离线设置限制网络；原始 TCP 不经过代理。若产品要求硬性禁网，需要验证 Elevated/WFP backend 或引入受控网络代理并补充其真实闭环测试。在此之前，UI 和发布验收必须保持“沙箱待验收/部分能力”状态，不能显示为完整安全通过。

探针通过 app-server `command/exec` 直接发送命令，不经过桌面逐项审批回调；审批 UI 由 `ApprovalBroker` 的单次令牌、超时、取消和关闭拒绝测试覆盖，不能把本探针结果描述为模型驱动的审批 UI 验收。未完成的项目还包括干净 Windows、普通用户、符号链接/junction/UNC 绕过、取消后的完整进程树和连续 20 次资源稳定性。

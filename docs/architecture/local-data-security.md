# 本地数据与安全

位置：%LOCALAPPDATA%\JinggongAgent。测试通过 JINGGONG_TEST_DATA 指向单独临时目录，与真实用户数据分离。

- database/jinggong-agent.db：真实 SQLite，项目、会话、事件、Provider/Jira 非敏感元数据、主题、记忆和导入资料；有 schema v2 迁移、事务、原子落盘和完整性校验。
- config/secrets/<provider-id>.dpapi、jira.dpapi：独立 Electron safeStorage/Windows DPAPI 凭据，绑定服务域名（Jira 另绑定账号）。原 config/model-key.dpapi 保留供 V0.1 配置兼容；数据库只记录是否已配置。Renderer 只在输入时传入新值，之后不提供密钥查看接口。
- workspaces/：用户所选 Git 仓库的隔离 Worktree；不自动清理未提交代码。
- runtime/home/：独立 CODEX_HOME，不复制原用户配置、认证。API Key 只注入当前 Runtime 子进程环境。
- 字典和开发要求：原文件 SHA256、名称、提取正文、系统分类保存于 SQLite，尚不保留原始二进制附件；knowledge/、attachments/ 目录预留。
- exports/：数据库备份；当前备份不包含代码 Worktree、Runtime rollout、附件或凭据，不具备完整跨机恢复能力。

IPC 使用主进程来源校验和参数 schema；拒绝 HTTP 模型端点、URL 内密码/查询 Token。Renderer 内容不解释为 HTML。错误与事件写入前脱敏当前模型密钥和常见 Bearer/sk 格式。

Worktree 是代码工作目录分离，不是进程沙箱；同用户子进程环境变量也不是对恶意工具的凭据保险箱。精工 Agent 的实际 turn 默认使用 `danger-full-access`，允许命令、网络和数据库操作；主进程仍以会话 Worktree、路径、hash、凭据和开发规则校验作为业务门禁。Windows 原生沙箱尚未配置，不能把当前策略宣称为系统级恶意工具隔离。普通用户 ACL、多账户隔离、崩溃报告和提示注入仍需专项验证。

密钥不进入数据库备份；应用不提供明文查看密钥接口。用户自己发送的任意业务资料仍可能包含其他敏感数据，后续需要数据分类/扫描，不能声称通用脱敏已覆盖所有格式。

交互卸载时询问是否保留应用数据，默认保留；升级与静默卸载始终保留数据，不进入删除分支。恢复功能、自动更新、签名更新源尚未实现。禁止静默删除工作区或自动运行生产脚本。

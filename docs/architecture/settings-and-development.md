# 设置与受控开发（V0.6）

依据：三份正式 V1.1 文档，以及本次用户提出的设置、多模型、可修改代码、Git 操作和精工 Logo 补充需求。本文件补充实现决策，不改写正式需求文档。

## 设置和存储

- 支持精工/极简两种风格，深色/浅色/跟随系统三种主题；偏好写入 SQLite，重启保留。
- 多个中转站分别保存名称、HTTPS Base URL、模型列表；每个中转站独立 DPAPI 文件。API Key 只写不回显，密钥绑定服务地址，变更地址必须重新输入。
- Jira 域名、账号为元数据，密码独立 DPAPI 加密，绑定域名和账号。此阶段实现配置，不冒充已完成 Jira 查询/任务写回。
- 本地记忆由用户新增、查看、删除；开发上下文使用当前仍存在的记忆。本阶段是全局用户记忆，不自动提炼长期记忆，也不声称删除后已从历史 Runtime rollout/旧备份中抹除。
- SQLite v1 自动迁移为 v2，保留原项目、会话、事件、Provider，旧密钥文件原位兼容。数据库备份仍不包含 DPAPI 凭据、代码或 Runtime rollout。
- 凭据输入不会写入文档或代码。新任务正文、记忆标题/正文、文档名称/正文等持久化文本会检查已知密钥与常见凭据形式；检测到时明确拒绝，不能承诺识别未知格式的一切秘密。

## 字典与开发要求

资料按通用/MES5/MES6/WMS 分类，支持查看内容、启用/停用、删除。会话按代码指纹自动识别 MES5/MES6/WMS 并只加载通用及匹配系统资料；无法识别时保持通用，不猜测加载，避免把两代 MES 的表结构和实现方式混用。

支持 UTF-8 `.md/.txt/.json/.csv/.sql`，以及本地解析 `.docx/.xlsx`，无 Python、Office 或服务器依赖。Office 不执行宏、公式或外部链接；XLSX 保留单元格原始值/已有公式缓存，不进行 Excel 日期/样式格式化。每份文件不超过 8 MiB、提取文本不超过 80,000 字符；启用上下文总计不超过 180,000 字符，超过时拒绝开始任务，不静默裁剪开发要求。

导入后记录原文件 SHA256、文件名、系统、提取文本和时间，数据存于 SQLite。当前不保存原始二进制附件，也不提供全量语义检索/版本审批。

普通文字要求会在每轮完整注入 developerInstructions，并明确要求 Agent 遵守已启用规范，遇到冲突或无法核验时暂停说明。任意自然语言是否满足不能用简单文本匹配证明，因此提交前必须逐份人工确认。机器可判定要求可上传 JSON，例如：

```json
{
  "instructions": "遵循当前仓库的分层和注释习惯，真实执行后才可报告测试通过。",
  "rules": [
    { "type": "forbid-text", "glob": "**/*.cs", "text": "async void" },
    { "type": "require-text", "glob": "src/services/*.ts", "text": "export " },
    { "type": "require-file", "path": "README.md" }
  ]
}
```

规则为字面文本匹配，默认不区分大小写，可设 `caseSensitive: true`；glob 支持 `*`、`?` 和独立目录段 `**`，不接收正则或脚本。forbid/require-text 针对本次修改的匹配文件；require-file 阻断删除必需文件，在提交时检查其存在。JSON 含 instructions 时，机器规则通过后仍需审核正文。错误格式的规则拒绝导入，不能降级成“已校验”。

写入工具在实际落盘前执行规则回调；提交前再次检查工作树及 Git 规范化后的真实暂存 blob。路径统一为工作区相对路径、按 Windows 大小写语义比较；glob 使用有界动态规划，避免用户规则造成正则回溯阻塞。

## Runtime 写入与恢复

采用固定 Codex 0.156.1 app-server，不另造 Agent 推理循环。精工 Agent 默认使用 `sandbox=danger-full-access`、`approvalPolicy=never`，允许模型在当前会话 Worktree 内直接读取和修改代码、执行 Shell 命令、构建测试、访问网络/API，以及使用项目已有配置连接本地数据库。运行时没有配置 Windows 原生 OS 沙箱，因此 Worktree、开发规范和主进程校验是工程门禁，不应宣称为恶意进程的系统级安全隔离。

- 主进程仍对动态项目文件工具、敏感路径、链接/硬链接、文件大小、SHA256、开发要求和提交范围执行校验。
- 工作目录限定在已登记会话的独立 Worktree，源项目和主分支不直接作为 Agent 工作目录。
- 完成、取消或切换配置后按协议关闭/恢复 Runtime；新配置会创建匹配能力的新线程，SQLite 历史消息保留。

固定版本跨 Runtime 进程 `thread/resume` 会重新传入完整开发策略；`turn/start` 每轮明确传入 `sandboxPolicy: { type: 'dangerFullAccess' }` 和 `approvalPolicy: 'never'`。适用系统、模型或能力版本变化时新建 Runtime thread，同配置续聊恢复原 thread。实验性 API 的集成依据为 [OpenAI Docs App Server](https://learn.chatgpt.com/docs/app-server)，具体字段以固定 Runtime 的 generate-ts 和真实协议测试为准。

## Git 操作

只操作 `workspaces/<session>/` 下且身份仍为 `agent/<session>` 的分支，源项目和主分支保持独立。提交前显式枚举待提交路径，拒绝敏感文件、链接、冲突和意外暂存夹带；禁用仓库 Hook、Filter、外部 Diff/Textconv 和签名脚本，保证平台检查不会触发仓库任意程序。

提交说明由真实变更文件与新增/修改/删除数量生成中文初稿，可编辑；此本地生成不依赖模型，不伪称 AI 理解了业务含义。提交、推送均显示明确分支并经用户确认。推送固定当前 agent 分支同名远程 ref，不 force、不跟随 tags、不递归子模块、不合并主分支。HTTPS 认证当前不调用仓库自定义 helper；需要 SSH Agent 或本地 Bare 目标，完整 HTTPS/GCM 接入后续实现。

## 品牌资源

原图来自用户提供的精工logo.png、精工logo2.png，原样保存在 `apps/desktop/resources/branding/`。界面使用标志图；窗口、EXE、安装与卸载程序使用按原标志缩放生成的多尺寸 ICO，未重新设计 Logo。

## 在线更新

桌面安装版使用 electron-updater 从公开 GitHub Release 检查更新并自动下载 NSIS 更新包，electron-updater 校验下载哈希并匹配 Windows Authenticode 发布者。用户确认“重启并更新”后，应用先收尾 Runtime 与 SQLite，再静默安装并重新启动；用户数据库与 DPAPI 凭据保留。缺少发布者配置时关闭更新检查和安装；开发版不访问更新源。仓库标签 `v*` 触发 `.github/workflows/release.yml`，发布 NSIS 安装程序及 `latest.yml` 更新元数据；Workflow 要求 `WINDOWS_CERTIFICATE_BASE64`、`WINDOWS_CERTIFICATE_PASSWORD`、`WINDOWS_CERTIFICATE_PUBLISHER` 三个 Secret。发布后才能验证客户端下载闭环；请先用隔离账户验证跨版本覆盖和用户数据保留。

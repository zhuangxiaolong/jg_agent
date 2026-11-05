# 设置与受控开发（V0.2）

依据：三份正式 V1.1 文档，以及本次用户提出的设置、多模型、可修改代码、Git 操作和精工 Logo 补充需求。本文件补充实现决策，不改写正式需求文档。

## 设置和存储

- 支持精工/极简两种风格，深色/浅色/跟随系统三种主题；偏好写入 SQLite，重启保留。
- 多个中转站分别保存名称、HTTPS Base URL、模型列表；每个中转站独立 DPAPI 文件。API Key 只写不回显，密钥绑定服务地址，变更地址必须重新输入。
- Jira 域名、账号为元数据，密码独立 DPAPI 加密，绑定域名和账号。此阶段实现配置，不冒充已完成 Jira 查询/任务写回。
- 本地记忆由用户新增、查看、删除；开发上下文使用当前仍存在的记忆。本阶段是全局用户记忆，不自动提炼长期记忆，也不声称删除后已从历史 Runtime rollout/旧备份中抹除。
- SQLite v1 自动迁移为 v2，保留原项目、会话、事件、Provider，旧密钥文件原位兼容。数据库备份仍不包含 DPAPI 凭据、代码或 Runtime rollout。
- 凭据输入不会写入文档或代码。新任务正文、记忆标题/正文、文档名称/正文等持久化文本会检查已知密钥与常见凭据形式；检测到时明确拒绝，不能承诺识别未知格式的一切秘密。

## 字典与开发要求

资料按通用/MES5/MES6/WMS 分类，支持查看内容、启用/停用、删除。会话只加载通用及所选系统资料，避免把两代 MES 的表结构和实现方式混用。

支持 UTF-8 `.md/.txt/.json/.csv/.sql`，以及本地解析 `.docx/.xlsx`，无 Python、Office 或服务器依赖。Office 不执行宏、公式或外部链接；XLSX 保留单元格原始值/已有公式缓存，不进行 Excel 日期/样式格式化。每份文件不超过 8 MiB、提取文本不超过 80,000 字符；启用上下文总计不超过 180,000 字符，超过时拒绝开始任务，不静默裁剪开发要求。

导入后记录原文件 SHA256、文件名、系统、提取文本和时间，数据存于 SQLite。当前不保存原始二进制附件，也不提供全量语义检索/版本审批。

普通文字要求在每轮完整注入 developerInstructions。任意自然语言是否满足不能用简单文本匹配证明，因此提交前必须逐份人工确认。机器可判定要求可上传 JSON，例如：

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

采用固定 Codex 0.156.1 app-server，不另造 Agent 推理循环。当前 Windows 原生沙箱未完成配置，所以所有实际 turn 都带 `environments: []`，内置 Shell/apply_patch、插件和权限升级关闭。开发模式通过主进程拥有的受控文件工具完成真实修改：

- 新增 UTF-8 文本文件、读取后凭 SHA256 修改/删除，单文件上限 128 KiB；已有文件必须传最新 hash。
- 路径限定在已登记会话的独立 Worktree，拒绝 Git 元数据、凭据文件、目录联接、符号链接和硬链接。
- 开发要求在写入前校验；回调未绑定则拒绝写入。不会因启用开发模式而开放任意本机命令。

固定版本跨 Runtime 进程 `thread/resume` 可能返回默认环境的静态描述，但 resume 不执行任务。实际 `turn/start` 明确传空 environments 并更新该 turn 的环境；每轮都重新绑定空环境与 readOnly/no network。更换模式、模型或适用系统时新建 Runtime thread，SQLite 历史消息保留；同配置续聊恢复原 thread。实验性 API 的集成依据为 [OpenAI Docs App Server](https://learn.chatgpt.com/docs/app-server)，具体字段以固定 Runtime 的 generate-ts 和真实协议测试为准。

## Git 操作

只操作 `workspaces/<session>/` 下且身份仍为 `agent/<session>` 的分支，源项目和主分支保持独立。提交前显式枚举待提交路径，拒绝敏感文件、链接、冲突和意外暂存夹带；禁用仓库 Hook、Filter、外部 Diff/Textconv 和签名脚本，保证平台检查不会触发仓库任意程序。

提交说明由真实变更文件与新增/修改/删除数量生成中文初稿，可编辑；此本地生成不依赖模型，不伪称 AI 理解了业务含义。提交、推送均显示明确分支并经用户确认。推送固定当前 agent 分支同名远程 ref，不 force、不跟随 tags、不递归子模块、不合并主分支。HTTPS 认证当前不调用仓库自定义 helper；需要 SSH Agent 或本地 Bare 目标，完整 HTTPS/GCM 接入后续实现。

## 品牌资源

原图来自用户提供的精工logo.png、精工logo2.png，原样保存在 `apps/desktop/resources/branding/`。界面使用标志图；窗口、EXE、安装与卸载程序使用按原标志缩放生成的多尺寸 ICO，未重新设计 Logo。

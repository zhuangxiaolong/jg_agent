# Codex Runtime 集成验证

日期：2026-11-04。需求依据为 docs 下三份 V1.1 文档；本次交付限桌面 PoC。接入层采用真实 Codex App Server 子进程和本机 stdio，未创建 HTTP 或 WebSocket 监听服务。

## 运行时版本和分发

- 固定 `@openai/codex` 版本 `0.156.1`，Windows x64 原生包版本 `0.156.1-win32-x64`。启动前必须检查 `codex --version` 精确匹配；不随用户 PATH 上的版本漂移。
- npm 包的 JS 启动脚本只是原生程序选择器。安装包直接携带原生 vendor 目录，用户无需预装 Node.js 或 Codex 桌面应用。
- 保留 vendor 相对布局：`bin/codex.exe`、`bin/codex-code-mode-host.exe`、`codex-path/rg.exe`、`codex-resources/`（包括 Windows 沙箱辅助程序及其余资源）。不能只复制一个 EXE 后宣称完整运行时已经分发。
- 本机读取 `Get-AuthenticodeSignature` 的 `codex.exe` 签名结果为 `Valid`。本次二进制 SHA256 为 `70bcb05f9bf1a4e7306edd0cd1b57d02af3267ad02a34b26f45c8c4bb20a3301`。构建脚本为所有运行时文件生成清单；正式分发仍需验证安装包自身签名、供应链及干净终端兼容性。
- 包元数据声明 Apache-2.0。`installer/licenses/codex-LICENSE`、`codex-NOTICE` 来自上游固定 `rust-v0.156.1` 标签，stage 脚本检查其固定 SHA256 后复制进安装包；vendor 中附带的第三方许可证亦保留。此记录不替代正式商业分发前的完整第三方许可审查。

## 进程边界和凭据

`packages/agent-runtime/src/index.ts` 封装协议，业务/UI 不直接构造 JSON-RPC。主进程按参数数组启动原生 EXE，`shell:false`、`windowsHide:true`，通过 stdin/stdout 交换 JSONL。

Runtime 使用应用自己的 `CODEX_HOME`，从不复制、读取或修改用户全局 `.codex/config.toml` 与认证文件。子进程环境采用操作系统变量白名单，模型 Key 仅以内存中的 `JINGGONG_MODEL_API_KEY` 传入本次子进程，不写入命令行或配置文件。Provider 固定为 `responses` 协议；API Base URL 与模型 ID 通过非敏感 `-c` 参数提供；禁用 WebSocket 模型传输。供应商错误先按精确 Key、Bearer 和常见敏感字段进行脱敏，再向 UI 返回。

真实模型推理需要用户在本应用中配置 HTTPS 模型服务、模型 ID 和新授权的 Key。本次没有用户提供的专用模型凭据，不能复用运行当前 Codex 的全局登录态，也未作真实外部模型调用。缺少 Key 时在主进程明确拒绝发送任务，不生成伪响应或成功状态。

## 协议和事件

本机以 `codex app-server generate-ts --out <临时目录>` 提取选定版本 schema。上线锁定原生版本并保留协议回归测试，升级时重新生成和比较。

1. `initialize` 发送 clientInfo 和 `capabilities.experimentalApi:true`，成功后发送无 ID 的 `initialized` 通知，每个连接只初始化一次。动态工具及环境字段来自固定版本的 experimental schema。
2. `thread/start` 指定 `cwd`、`model`、`modelProvider`、`sandbox:'danger-full-access'`、`approvalPolicy:'never'`；开发会话注册项目文件、代码方案、数据字典和浏览器等业务工具。必须确认返回 `sandbox.type='dangerFullAccess'`、`approvalPolicy='never'`，且线程环境已启用。
3. `turn/start` 的 `input` 形如 `[{type:'text',text:'用户任务',text_elements:[]}]`；逐 turn 再固定 `sandboxPolicy:{type:'dangerFullAccess'}` 和 `approvalPolicy:'never'`。
4. `item/agentMessage/delta` 为流式增量，包含 threadId、turnId、itemId、delta；无增量但收到完整 agentMessage 时显示完整文本。
5. `turn/started` 建立运行状态；`turn/completed` 的 `turn.status` 必须区分 completed、failed、interrupted，只有 completed 可显示完成。
6. `turn/interrupt` 必须携带真实 threadId 和 turnId；取消提交不等同取消完成。桌面主进程可关闭本次 Runtime 以确保取消收尾。
7. `thread/resume` 恢复已有 rollout。实测仅创建而未发过首个 turn 的空线程没有 rollout，会返回 `no rollout found for thread id ...`；适配器仅对该错误创建新 Runtime thread，返回新 ID，应用自身会话和事件仍由 SQLite 保存。

注意选定版本的 schema 仍列出 `untrusted` approval 值，但在 CLI 全局配置使用它会真实报错：`approval_policy = "untrusted" is no longer supported`。因此必须以实际运行证据选用 `never`，不能仅根据类型声明推断可用性。

## 执行权限现状

本机 `windowsSandbox/readiness` 仍可能返回 `notConfigured`，这只表示没有额外的 OS 沙箱边界，不影响精工 Agent 默认的完整开发执行策略。真实 Runtime 测试已验证固定版本、完整开发会话、命令执行、HTTP、SQLite、旧会话恢复和 CLI 独立调用。

所有 turn 的原生执行策略固定为完整访问；CLI 显式开启 Shell，关闭 Code Mode、子 Agent、插件、Hooks、Apps、Computer Use、图像、全局记忆和工作区依赖功能，并关闭 web_search。当前 turn 的命令和文件变更请求按完整开发配置接受；动态项目工具仍受主进程的 Worktree、规则、路径和凭据检查约束。

跨进程 `thread/resume` 会重新传入完整访问参数；`turn/start` 每轮覆盖为 `dangerFullAccess`，不能因旧会话或旧配置回落到只读。已加入真实跨进程恢复与发送字段回归。

## 受控代码工具

V0.6.4 在普通与 Jira 会话中注册 `publish_change_plan`，由 Runtime 检查目标、逐文件改法、影响风险、验证计划和相对路径后，先写入 Markdown 会话事件，再记录当前 thread/turn 的完整方案。受控写入与删除只允许当前方案明确包含的文件；新任务、终态或取消清除方案，不能跨会话复用。发布新方案覆盖当前方案，不自动取得写入权限；只读 broker 仍拒绝写入。旧会话的工具能力版本不符时创建新版 Runtime 线程，SQLite 历史保留，不展示内部兼容通知。

主进程 broker 分析模式公开 `list_project_files`、`read_project_file`，开发模式另有 `write_project_file`、`delete_project_file`。通过真实 `thread/start.dynamicTools` 注册，由服务端 `item/tool/call` 回调，仅接受当前线程/turn 的固定工具名，返回完整 inputText JSON 工具结果。写入限定真实隔离 Worktree、单文件 128 KiB、UTF-8、非敏感普通文件；已有内容必须带读取到的 SHA256，落盘前执行强制规则回调并复查并发。详见 settings-and-development.md。

broker 绑定准确的 threadId、活动 turnId 和本次 cwd；对原始项目根目录及所有祖先（直到盘根）执行 lstat，不能先 realpath 后默许根目录联接。对相对路径逐级 lstat、realpath 校验，拒绝目录联接、符号链接、硬链接、路径越界、绝对路径、Windows ADS、`.git`、`.codex`、`.env`、常见凭据文件和证书私钥格式。采用代码扩展名白名单，文件最大 128 KiB、只接受 UTF-8 文本；列表最多 500 个文件、扫描最多 5000 个条目、深度最多 12 层，并显式报告截断。文本和文件列表均在序列化前按 24000 字符 JSON 总预算裁剪，保留完整 JSON 且标记 truncated。文件打开后复核 inode/device/链接数，读取后再次校验原始根路径。检测到常见明文凭据模式则拒绝向模型传递。该检测不能识别任意业务自定义秘密；正式试点仍须选择已授权、完成敏感数据检查的仓库。当前不支持项目根或祖先使用 OneDrive/其他目录联接，需选择真实磁盘目录。

`thread/resume` schema 没有 dynamicTools 替换参数；沿用原线程工具定义并重新绑定受控 broker。更改模式时主进程清除 Runtime thread ID，创建匹配工具清单的新线程，保留 SQLite 历史。真实探针持久化实际本地测试用户输入（不注入模型答复、不触发推理）验证同进程/跨进程恢复；实际模型调用动态工具仍需专用凭据，不能以恢复 RPC 成功宣称推理闭环通过。

完整命令执行已默认开放。Windows 原生沙箱尚未配置，因此不能把当前策略描述成系统级恶意代码隔离；规则、路径、hash 和提交校验仍是业务门禁。仅 Prompt 无法形成强约束。

## 生命周期和故障处理

JSONL 解码器处理跨行分帧，UTF-8 由流解码保证字符边界；单行限制 4 MiB。RPC 默认超时 20 秒，turn 默认运行时限 30 分钟（测试可通过 `runTimeoutMs` 覆盖）。原先 180 秒硬超时会取消超过三分钟的正常长任务；超时处理现在先发出错误和 `interrupted` 终态，再关闭本次 Runtime，避免界面持续显示运行中。进程退出拒绝全部挂起 RPC。已完成 turn ID 防止同一 stdout 批次先收到终态、后处理 RPC Promise 微任务时错误重建活动任务。关闭时先结束 stdin，等待正常退出；超时在 Windows 对本次子进程 PID 执行 `taskkill /T /F`，不对用户其他 Codex 进程操作。

该策略覆盖正常退出和应用主动取消。主进程被操作系统强制终止、突然断电等场景仍需 Windows Job Object 或守护清理等专项验证，不能以正常 EOF 退出测试替代崩溃验收。

## 已执行验证

- `node scripts/probes/runtime-probe.mjs`：真实原生程序 initialize、独立未登录状态、中文与空格路径 thread/start、空活动取消错误、无 rollout 恢复行为、独立只读命令的 stdout 流和 stdin EOF 退出。原始不含凭据结果保存为 `docs/development/runtime-probe-results.json`。
- `npx tsx --test tests/runtime.test.ts tests/runtime-execution.test.ts`：JSONL 分帧/超限、凭据脱敏与环境隔离、真实固定版本/完整开发会话/旧线程重启恢复/缺 Key 拒绝/退出、命令/HTTP/SQLite、CLI 独立调用、无固定时限任务和终态竞态；16 项通过。
- `npx tsx --test tests/project-read-broker.test.ts`：真实项目文件读写边界、中文代码读取、凭据/二进制/大文件拒绝、越界与根/祖先/内部目录联接及硬链接拒绝、列表截断、序列化总预算；4 项通过。
- `npx tsc --noEmit`：编译检查通过。

未验收：真实外部模型文本流、模型工具调用与代码修改、真实活动 turn 的 interrupt 终态、Windows 原生沙箱攻击边界、主进程硬崩溃清理、干净 Windows 账户安装运行。这些均须继续验证，不能纳入当前 PoC 全链路通过结论。

## 官方依据

- [OpenAI App Server 文档](https://learn.chatgpt.com/docs/app-server)：stdio JSONL、初始化、thread/turn 生命周期、事件和取消；当前官方页面标明 WebSocket 为 experimental/unsupported，本机 CLI 将 app-server tooling 标记 experimental。
- [OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)：自定义 Provider、Shell 工具开关、只读 sandbox 和项目配置可信度。
- [上游固定版本 LICENSE](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/LICENSE) 与 [NOTICE](https://raw.githubusercontent.com/openai/codex/rust-v0.156.1/NOTICE)：安装包携带的许可原文来源。
- [固定版本工具注册源代码](https://github.com/openai/codex/blob/rust-v0.156.1/codex-rs/core/src/tools/spec_plan.rs)：无 environment 时不注册 Shell 和 ApplyPatchHandler 的实际条件；后续 Runtime 升级必须重新核验。

# 精工 Agent

精工 Agent 是面向 MES5、MES6、WMS、前端等项目的 Windows 桌面研发工具。当前仓库版本为 0.6.9，应用源码位于 `apps/desktop/`，核心模块位于 `packages/`。

## 能力

- 使用 Codex、Claude Agent SDK 或精工 Runtime 执行开发任务；每个会话可单独选择运行时、模型和推理强度。
- 可在会话中选择 Grok Build ACP Runtime、中转站与模型，直接复用【模型中转站】中的 HTTPS 地址、凭据和模型；运行时设置只显示组件状态，无需另行启用、绑定模型或配置协议。
- Grok 会话空闲时可中途更换中转站和模型，聊天记录保留；下一轮按新配置重建连接并携带历史摘录，往返切换使用独立绑定目录。运行中仍需等待或停止后再修改。
- Grok 简单联网查询优先一次获取结构化数据，提供 Windows PowerShell 5.1 兼容指引，减少重复取数、格式和编码纠错轮次；保留用户选择的推理强度，旧会话通过规则版本迁移应用新指引。
- Grok 和未启用插件的原生 Codex 连续对话，在组件、模型、凭据、推理强度、权限与开发上下文一致时复用已就绪进程；两者共享最多 3 个空闲实例，空闲 2 分钟自动回收。配置变化、失败或取消后重新建立连接，Codex 插件会话仍冷恢复。
- 所有 Runtime 首字即时显示、后续文本增量合并写盘；发送任务前的组件完整性验证采用异步全量校验。Claude 合并同一轮内重复的 SDK 加载与启动预检，仍按官方 SDK 单轮 query 方式运行，不宣称已实现原生进程保活。
- Claude 通过官方 `systemPrompt` preset 追加开发要求与执行指引，冷恢复使用当前规则；简单项目初读先给结构、技术栈和入口概览，批量读取独立资料，明确要求深入分析或修改时保留完整执行能力。原生子 Agent 正文不再混入主会话。
- Claude 推理强度随会话传给 SDK：`none` 关闭扩展思考，`low/medium/high/xhigh` 原值传递；`minimal` 使用 SDK 最低原生档 `low` 并在会话提示，模型默认保持不覆盖。最终支持情况仍由中转站和所选模型决定。
- 启动界面加载后，独立 Worker 延迟 1.5 秒开始逐个预热本地 Runtime，优先当前选择；组件校验、SDK 加载和本地协议握手不占用主线程，健康结果在本次运行期间复用，手动刷新可重检。预热不调用模型；有任务时暂缓后续预热，发送任务仍执行完整性校验，退出时回收 Worker 和预检子进程。Claude SDK 的 Worker 模块缓存不等于正式会话的原生进程保活。
- 会话可关联本地项目，也可作为独立会话运行。开发任务可直接修改当前会话工作区，运行期间可继续发送补充指令。
- 空白会话在离开、新建会话或打开设置时自动清理；已输入草稿、附件、消息或运行中任务的会话会保留。
- 左侧项目/会话栏与右侧详情面板可拖动调整宽度，右侧在宽屏下最高可到 840px，方便阅读 Git Diff。会话列表展示名称、模型和推理强度。
- 内置 Jira 任务查看和流转、Git 变更审阅、项目规范与数据字典、内置浏览器、Windows 主屏截图与受控鼠标键盘操作、子 Agent 和任务完成提醒。computer-use 目前提供给 Codex 与精工 Runtime。
- Jira 按任务类型执行：需求先在会话中输出需求方案和代码修改方案，再继续实施；优化、缺陷直接定位修改并构建测试。Codex、精工和 Claude 使用相同流程，执行期间右侧 Git 自动刷新当前会话的文件变更。
- 自动记忆只保留可复用的偏好、约束、决策和经验，不把普通对话整段生成记忆；记忆可在设置中查看和删除。
- Codex、精工、Claude Agent SDK 和 Grok Build 四种 Runtime 的普通会话默认完整访问：可按任务读取、创建、修改和删除工作区内外文件，直接执行本机命令，无需逐次审批，权限上限为当前 Windows 用户。历史资料目录选择不再限制普通会话权限；文档解析工具自身仍只读，显式受控分析与只读子 Agent 仍按任务契约执行。
- 项目创建时按仓库指纹识别 MES5、MES6、WMS 或前端；前端识别读取仓库根目录 `package.json` 及根级 Vite、React、Vue、Angular、Next、Nuxt、Svelte 等配置，同时保留明确后端系统指纹的优先级。

## 构建与验证

代码修改只有在固定构建成功后才能报告为通过。可识别的构建入口为唯一的 `.sln`/`.slnx`，或根目录 `package.json` 中的 `scripts.build`。MES5 依项目要求构建 `JZ.IMS.sln`；其他项目按其唯一解决方案或正式构建脚本执行。

构建、测试和接口验证的日志与 Markdown 报告保存在本机数据目录 `%LOCALAPPDATA%\JinggongAgent\verification\<项目或独立会话>\<会话>\<运行>\`，不写进目标项目工作区。WMS/MES 等受授权接口测试需要用户在会话中提供当前有效的系统授权 Token；没有 Token 时必须标记接口测试未执行，不能将其描述为通过。

## 开发运行

开发环境需要 Windows x64、Node.js 24、npm 和 Git for Windows。

```powershell
npm ci
node node_modules/electron/install.js
node scripts/stage-runtime.mjs
npm run build
npm test
npm run test:desktop
npm start
```

生成 Windows 安装包：

```powershell
npm run dist
```

## 文档

- [当前构建操作手册（2026-11-12）](docs/操作手册-当前构建-2026-11-12.md)
- [0.6.9 使用说明](docs/使用说明-0.6.9.md)
- [项目开发规范](AGENTS.md)
- [开发与受控操作说明](docs/architecture/settings-and-development.md)
- [更新发布工作流](.github/workflows/release.yml)

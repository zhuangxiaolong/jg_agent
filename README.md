# 精工 Agent

精工 Agent 是面向 MES5、MES6、WMS、前端等项目的 Windows 桌面研发工具。当前仓库版本为 0.6.8，应用源码位于 `apps/desktop/`，核心模块位于 `packages/`。

## 能力

- 使用 Codex、Claude Agent SDK 或精工 Runtime 执行开发任务；每个会话可单独选择运行时、模型和推理强度。
- 会话可关联本地项目，也可作为独立会话运行。开发任务可直接修改当前会话工作区，运行期间可继续发送补充指令。
- 空白会话在离开、新建会话或打开设置时自动清理；已输入草稿、附件、消息或运行中任务的会话会保留。
- 左侧项目/会话栏与右侧详情面板可拖动调整宽度，右侧在宽屏下最高可到 840px，方便阅读 Git Diff。会话列表展示名称、模型和推理强度。
- 内置 Jira 任务查看和流转、Git 变更审阅、项目规范与数据字典、内置浏览器、子 Agent 和任务完成提醒。
- 自动记忆只保留可复用的偏好、约束、决策和经验，不把普通对话整段生成记忆；记忆可在设置中查看和删除。
- Claude Runtime 优先启用 SDK 沙箱；按用户授权，Windows 沙箱不可用时允许 SDK 无沙箱运行。无沙箱时 Claude 进程使用当前 Windows 用户权限，工作区路径检查不能替代操作系统隔离。
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
- [0.6.8 使用说明](docs/使用说明-0.6.8.md)
- [项目开发规范](AGENTS.md)
- [开发与受控操作说明](docs/architecture/settings-and-development.md)
- [更新发布工作流](.github/workflows/release.yml)

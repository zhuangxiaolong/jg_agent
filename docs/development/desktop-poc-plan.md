# 第一阶段任务与验收

依据：2026-11-04 用户启动指令及三份 V1.1 文档。优先完成 Windows 桌面最小链路，未达到退出条件不宣称 PoC 全部通过。

1. 环境：实际输出系统/工具版本，检查 Codex 可执行与 Windows 沙箱状态；不泄漏凭据。
2. 技术栈：ADR 明确 Electron 主推、Tauri/.NET 备选与取舍；不拿预估当性能实测。
3. 桌面：编译后从 exe 启动本地 UI，无浏览器和 localhost 服务；安全 preload/API 白名单验证。
4. Runtime：固定 0.156.1 及 SHA256，真实 stdio 初始化、创建线程、取消/关闭；模型推理必须接入独立凭据并收到真实 delta 与 completed。
5. 项目/Diff：选择真实 Git 根目录，创建独立分支 Worktree；测试真实新增/修改/删除/staged/untracked Diff，源仓库不变。
6. 持久化：真实 SQLite 文件签名、事务和 integrity_check；重启后恢复项目/会话/事件；中断任务不误记成功。
7. 凭据：在真实 Electron safeStorage 中加密测试值，磁盘和数据库不含测试明文，主进程可解密、Renderer 无读取接口。
8. 安装：生成 x64 NSIS；本机安装启动与全新普通 Windows 用户环境分别验收；最终用户无需 Node/Python/Docker/PostgreSQL。
9. 沙箱与真实开发：配置原生沙箱后执行越界写/网络拦截；经授权模型在样本 Worktree 修改并跑构建测试。不能用人工样例文件或协议事件替代 Agent 验收。

模块开发后运行对应测试；集成后执行 npm run build、npm test、npm run test:desktop、npm run dist。测试输出与截图归档到 test-results（不入 Git）；最终结果写验收记录，明确已通过、未执行和环境受阻。

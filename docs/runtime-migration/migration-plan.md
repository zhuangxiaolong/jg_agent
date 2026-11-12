# 双 Runtime 迁移计划

## 已完成：阶段 0、阶段 1 与 Jinggong 独立构建 PoC

- 已盘点主进程、preload、Renderer、Runtime、存储、凭据、打包和测试入口。
- 已抽象 Runtime 类型、健康检查和事件适配边界。
- 已将默认设置、会话 Runtime 归属和旧会话兼容规则接入本地存储。
- 已加入 Runtime 设置页；Jinggong 未就绪时显示诊断，不自动回落 Codex。
- 已锁定 Codex 上游 tag/commit，提交身份与版本隔离 Fork 补丁、Rust MSVC 工具链构建脚本及独立资源 Manifest。
- Jinggong App Server stdio Adapter 已接通；打包命令先构建 Fork，再准备 Codex/Jinggong 双资源。
- 协议探针严格核对初始化身份、read-only session 策略、沙箱 readiness、真实 command/exec 输出及失败退出码。

## 尚待完成

1. 完成本机 Windows x64 Release 编译和真实二进制协议探针。
2. 生成并测试携带两种 Runtime 的桌面安装包。
3. 双 Runtime 真实模型回归：分析、修改、Diff、测试、流式事件、取消、恢复。
4. 将高权限、自动审批和环境变量全量继承改为满足方案要求的权限/凭据隔离策略。
5. 执行 Windows 沙箱越权、网络、子进程和干净安装验收，完成第三方许可证与 SBOM 审核。

构建或协议探针通过仅说明 Fork 身份与部分 stdio 协议可运行；不能据此标记安全、真实模型开发闭环或正式安装发行已验收。

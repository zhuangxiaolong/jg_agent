# Runtime 许可证与供应链记录

双 Runtime 资源分别来自 npm 包 `@openai/codex` 0.156.1 与独立 Windows Cargo Fork。Fork 基线为 `https://github.com/openai/codex` 标签 `rust-v0.156.1`、提交 `81e8e29b2956dfe9b092c63953a9ed282781e77c`，源码归档 SHA-256 固定在 `scripts/build-jinggong-runtime.mjs`。精工补丁、Cargo.lock、Rust 工具链版本、构建命令和二进制 SHA-256 写入构建资源 Manifest。

Fork 资源保留上游 Apache-2.0 `LICENSE` 和 `NOTICE`。当前尚未生成依赖许可证归档或 SBOM；依赖合规审核完成前不应作为公开发行包发布。构建元数据也不等于安全审计或沙箱验收。

# Jinggong Runtime Fork

该目录记录随精工Agent构建的独立 Runtime 来源和补丁，不保存第三方构建目录或未审计的二进制。

- 上游仓库：`https://github.com/openai/codex.git`
- 固定标签：`rust-v0.156.1`
- 固定提交：`81e8e29b2956dfe9b092c63953a9ed282781e77c`
- Jinggong Runtime 版本：`0.1.0`
- 目标：`x86_64-pc-windows-msvc`
- 协议：App Server stdio JSONL
- 补丁：[0001-jinggong-runtime-identity.patch](../../patches/0001-jinggong-runtime-identity.patch)，由构建脚本通过 `git apply` 应用并记录 SHA-256。

使用 `scripts/build-jinggong-runtime.mjs` 构建。脚本只接受固定 tag 的官方源码包，校验源码归档 SHA-256 后才应用补丁和执行 `cargo build --locked --release`；找不到 Rust/MSVC 工具链时直接失败，不会把 `codex.exe` 改名或复制成 Jinggong。

构建产物位于 `apps/desktop/resources/runtime/jinggong/bin/jinggong-runtime.exe`，同时生成独立的 `manifest.json`、上游 LICENSE/NOTICE 和依赖清单。发布前仍需在干净 Windows 11 x64 机器执行 `npm run runtime:probe` 和沙箱验收。

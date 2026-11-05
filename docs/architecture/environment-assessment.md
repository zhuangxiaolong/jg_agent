# 开发环境实测

日期：2026-11-04，当前项目 D:\jinggong-agent。

- Windows 11 专业版 x64，10.0.26200。
- Intel i9-13900HX，物理内存约 63.8 GiB；D 盘可用约 1.24 TiB。
- Node 24.19.0，npm 11.17.0，Git for Windows 2.53.0.windows.2。
- .NET SDK 含 3.1.422、8.0.206、10.0.401 等；Visual Studio Community 2026 已安装。
- PATH 未发现 rustc/cargo。未安装 Rust，未升级或修改全局开发工具。
- 系统 Codex CLI 0.156.1 可启动。项目另通过 npm 固定同版本，不依赖已安装 Codex 桌面客户端。
- 起始目录只有三份需求文档，无解决方案/源码/已有 Git，因此不属于 MES5/MES6 仓库；项目初始化到 develop/desktop-poc 分支，无自动提交。
- npm 依赖安装仅影响本项目。Electron 二进制通过官方安装脚本下载并按包内校验值验证；未安装 Docker、Python、PostgreSQL 等产品前置环境。

没有读取、复制或打印用户原有 Codex 配置、认证 Token。用户选择在新应用独立填写模型凭据，因此真实推理需要该操作后再验收。

本机是开发环境，不能替代干净 Windows 普通用户机器验收。安装包运行、无预装 Node 的验证应分别记录。

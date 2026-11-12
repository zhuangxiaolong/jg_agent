# 性能核心模块测试结果（2026-11-11）

结论：新增公共性能核心的 10 项回归测试全部通过，与 RuntimeEventBatcher 合并运行共 12 项通过，TypeScript 全项目类型检查通过；真实源码的本地索引微基准已执行。三个 Runtime 的真实开发任务端到端提速仍未验收。

## 实际执行

- `npx tsx --test tests/performance.test.ts tests/runtime-event-batcher.test.ts`：退出码 0，12 项通过（性能核心 10 项、事件合并 2 项），0 失败、0 跳过。首次测试曾因测试代码 Promise.all 入参错误失败，已修复并重新完整执行通过。
- `npx tsc --noEmit --pretty false`：退出码 0，无诊断。
- `npx tsx scripts/performance-baseline.ts`：退出码 0，3 次实际索引重复运行，原始数据见 `local-index-baseline.json`，结论与限制见 `baseline-report.md`。

## 测试覆盖

1. 单调时间戳、首个可见响应、结构化工具边界、端点脱敏；不保存模型正文、命令参数或工具正文。
2. 缺少开始边界不造耗时，未知退出码不标成功，完成时未结算阶段标记中断。
3. 崩溃恢复不靠墙钟补造持续时间，总开关与 Runtime/工作区覆盖规则有效。
4. Git 原生 ignore、生效文件过滤、单文件增量解析、删除检测、跨重启元数据/基础符号复用；磁盘不保存源码正文。
5. 检索命中前复核文件 hash，排除敏感文件、意外硬编码密钥和链接目录。
6. 需求/安全/验收文本完整保留，可选片段去重、预算裁剪，缓存按工作区/工作树/hash/索引版本隔离。
7. 独立只读操作并行，同一工作树写操作等待读完成，跨会话标识不能绕同一实例内锁。
8. 取消和超时使用 AbortSignal；执行尚未实际退出不释放锁；排队背压和真实失败通过 Promise 显式传播。
9. 分级测试只推荐已登记命令，顺序为快速验证到全量；用户要求 full 时不因文档或模块路径而降级；所有未执行结果为 not_run。
10. 重启后正文和注释 unique 词、中文二字仍能全文命中；stat 变化后的新词/hash 即时更新、旧词不命中；新 ignore 立即生效。磁盘仅保存非明文候选 Bloom，不存注释或正文。

## 文件与集成边界

- 新增 `packages/performance/src/{types,telemetry,workspace-index,context-optimizer,scheduler,test-policy,index}.ts`。
- 新增 `tests/performance.test.ts`、`scripts/performance-baseline.ts` 及本目录盘点/瓶颈/基线报告。
- Telemetry 通过调用方提供的 load/save 回调复用既有 SQLite；200ms 合并写入、终态立即落盘。
- 索引由已授权主进程提供根目录；Git 文件清单无法取得时明确回退原文件工具。重启后复用元数据、基础符号与每文件固定 512 字节的非明文全文候选位，按需复核可能匹配文件正文，不重新全量解析。旧 metadata 格式进行一次版本升级重建。
- SafeParallelScheduler 不新增 Shell 能力；调用方仍需提供授权后的执行回调，并在多个会话共享目录时共用调度器和规范化工作树标识。
- Test policy 不新增第二套验证执行器；实际执行和结构化证据仍由已有 VerificationRunService 承接。

## 未验收和剩余限制

- 未运行 10 个同条件真实业务任务各 3 次；不得声称达到整体 15%–25% 提速或 95% 阶段完整率。
- 当前 Runtime 不公开的模型首 token、内部等待、Provider token 用量仍为不可用。
- 未因性能策略主动执行未登记命令、真实生产数据库、网络发布或收费模型任务。
- 本报告只覆盖性能核心；桌面 IPC、面板、三个 Runtime 和全项目构建回归由本次主任务统一验证并另记结果。

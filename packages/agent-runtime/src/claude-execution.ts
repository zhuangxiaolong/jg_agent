import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ReasoningEffort } from '../../domain/src';
import { buildRuntimeExecutionInstructions } from './execution-instructions';

/** 只约束泛化项目初读；明确的深入分析、排错、开发和验证仍按用户要求执行。 */
export function buildClaudeExecutionInstructions(instructions?: string, platform = process.platform): string {
  const overview = '【项目初读效率】当用户仅要求“读一下项目”“了解这个仓库”等概览，且没有要求深入分析、审查、排错或修改时，先读适用的 AGENTS.md/开发规范、根目录与构建清单，再按需选取少量入口和代表性文件；已有依据足以说明项目类型、技术栈、主要模块、入口及后续定位方法时，就给出简洁概览并结束。默认由主会话完成这类初读，不额外启动 Explore/Agent，不自行扩展为全仓文件统计、逐业务追踪到 SQL 或完整架构审计。相互独立的读取和搜索应在同一轮批量或并行调用，限定检索目录与返回范围，复用已读结果，不逐个文件反复进行模型往返。只给一份最终总结，过程更新保持简短。用户明确要求详细阅读、调用链、代码修复或正式验证时，以该要求为准，不能用概览规则省略必要工作。';
  const windowsBash = '【Windows Claude Bash 与轻量联网】使用 Claude 原生 Bash 工具时，先按当前 Bash 和 PATH 的实际情况判断可用命令（例如 command -v curl、command -v node），只发送 Bash 语法；不要把 PowerShell 命令交给 Bash，不要假设 python3 可用，也不要假设 /tmp 映射到 Windows 临时目录。天气等小型 JSON HTTP 响应优先用 curl 设置合理超时后直接通过管道交给 Node 解析，不写临时文件；确需临时文件时用 Node 的 os.tmpdir() 获取路径，并在同一工具环境中创建和读取。命令失败后依据错误核对一次命令、工具和路径是否可用；不要反复重试无效命令或混用其他 Shell 语法，仍失败就说明无法取数或改用明确的备用来源。';
  return `${buildRuntimeExecutionInstructions(instructions, platform)}\n${overview}${platform === 'win32' ? `\n${windowsBash}` : ''}`;
}

/** 保留用户所选档位；minimal 映射到 SDK 最低原生档 low，由适配器明确提示。 */
export function claudeReasoningOptions(effort?: ReasoningEffort): Pick<Options, 'effort' | 'thinking'> {
  if (effort === undefined) return {};
  if (effort === 'none') return { thinking: { type: 'disabled' } };
  if (effort === 'minimal') return { effort: 'low' };
  if (['low', 'medium', 'high', 'xhigh'].includes(effort)) return { effort: effort as Options['effort'] };
  throw new Error('Claude Runtime 思考强度无效');
}

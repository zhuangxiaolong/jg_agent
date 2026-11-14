import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { ReasoningEffort } from '../../domain/src';
import { buildRuntimeExecutionInstructions } from './execution-instructions';

/** 只约束泛化项目初读；明确的深入分析、排错、开发和验证仍按用户要求执行。 */
export function buildClaudeExecutionInstructions(instructions?: string): string {
  const overview = '【项目初读效率】当用户仅要求“读一下项目”“了解这个仓库”等概览，且没有要求深入分析、审查、排错或修改时，先读适用的 AGENTS.md/开发规范、根目录与构建清单，再按需选取少量入口和代表性文件；已有依据足以说明项目类型、技术栈、主要模块、入口及后续定位方法时，就给出简洁概览并结束。默认由主会话完成这类初读，不额外启动 Explore/Agent，不自行扩展为全仓文件统计、逐业务追踪到 SQL 或完整架构审计。相互独立的读取和搜索应在同一轮批量或并行调用，限定检索目录与返回范围，复用已读结果，不逐个文件反复进行模型往返。只给一份最终总结，过程更新保持简短。用户明确要求详细阅读、调用链、代码修复或正式验证时，以该要求为准，不能用概览规则省略必要工作。';
  return `${buildRuntimeExecutionInstructions(instructions)}\n${overview}`;
}

/** 保留用户所选档位；minimal 映射到 SDK 最低原生档 low，由适配器明确提示。 */
export function claudeReasoningOptions(effort?: ReasoningEffort): Pick<Options, 'effort' | 'thinking'> {
  if (effort === undefined) return {};
  if (effort === 'none') return { thinking: { type: 'disabled' } };
  if (effort === 'minimal') return { effort: 'low' };
  if (['low', 'medium', 'high', 'xhigh'].includes(effort)) return { effort: effort as Options['effort'] };
  throw new Error('Claude Runtime 思考强度无效');
}

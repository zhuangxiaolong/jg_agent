import type { RuntimeKind } from '../../../../packages/domain/src';

/** 根据当前选择的模型标识或显示名称推断默认 Runtime。 */
export function runtimeForSelectedModel(modelId: string, modelName?: string): RuntimeKind | undefined {
  const identity = `${modelId} ${modelName ?? ''}`;
  if (/(?:^|[^a-z])claude(?=$|[^a-z])/i.test(identity)) return 'claude_agent_sdk';
  if (/(?:^|[^a-z])gpt(?=$|[^a-z])/i.test(identity)) return 'codex';
  return undefined;
}

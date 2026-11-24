export const MODEL_ROUTE_TASKS = [
  { id: 'simple_question', name: '简单问答 / 代码定位' },
  { id: 'code_change', name: '普通代码修改' },
  { id: 'architecture', name: '复杂架构分析' },
  { id: 'long_context', name: '长上下文任务' },
  { id: 'code_review', name: '代码审查' },
  { id: 'document', name: '文档生成' },
] as const;

export type ModelRouteTaskType = typeof MODEL_ROUTE_TASKS[number]['id'];
export interface ModelRoutingRule { taskType: ModelRouteTaskType; providerId: string; modelId: string; runtimeKind: import('./index').RuntimeKind }
export interface ModelRoutingPolicy { rules: ModelRoutingRule[] }

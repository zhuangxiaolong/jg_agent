import type { ContextSourceType } from '../../../../packages/performance/src/types';

export const contextSourceNames: Record<ContextSourceType, string> = { memory: '用户记忆', project_fact: '项目事实', project_decision: '项目决策', skill_metadata: 'Skill 元数据', skill_body: 'Skill 正文', dictionary: '数据字典', operation_manual: '产品操作手册', project_resource: '项目资源', workspace_code: '工作区代码', task_evidence: '任务证据' };

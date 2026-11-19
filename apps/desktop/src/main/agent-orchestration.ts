import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createAgentTask, createTaskContract, MAX_AGENT_TASKS_PER_SESSION, taskContentHash } from '../../../../packages/agent-orchestrator/src';
import type { RuntimePlatformToolDefinition, RuntimePlatformToolProvider, RuntimeToolInvocation } from '../../../../packages/agent-runtime/src';
import type { AgentTask, RuntimeKind, Session } from '../../../../packages/domain/src';
import type { LocalStore } from '../../../../packages/storage/src';
import type { AgentTaskRunner } from './agent-tasks';

const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const taskSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.enum(['requirement', 'architecture', 'developer', 'review', 'testing', 'documentation', 'custom']),
  description: z.string().trim().min(1).max(8000),
  input: z.string().max(20000).optional(),
  dependencyIds: z.array(idSchema).max(20).optional(),
  outputExpectations: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
  acceptanceCriteria: z.array(z.string().trim().min(1).max(1000)).min(1).max(12),
  timeoutMs: z.number().int().min(1000).max(30 * 60 * 1000).optional(),
}).strict();

const definitions: RuntimePlatformToolDefinition[] = [
  { type: 'function', name: 'platform_agent_create_task', description: '创建本轮只读分析子 Agent 任务；任务必须有清晰目标、输出与验收标准。', inputSchema: { type: 'object', properties: { name: { type: 'string', maxLength: 120 }, role: { type: 'string', enum: ['requirement', 'architecture', 'developer', 'review', 'testing', 'documentation', 'custom'] }, description: { type: 'string', maxLength: 8000 }, input: { type: 'string', maxLength: 20000 }, dependencyIds: { type: 'array', items: { type: 'string' }, maxItems: 20 }, outputExpectations: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 12 }, acceptanceCriteria: { type: 'array', items: { type: 'string', maxLength: 1000 }, minItems: 1, maxItems: 12 }, timeoutMs: { type: 'integer', minimum: 1000, maximum: 1800000 } }, required: ['name', 'role', 'description', 'outputExpectations', 'acceptanceCriteria'], additionalProperties: false } },
  { type: 'function', name: 'platform_agent_list_tasks', description: '列出当前会话、本轮编排的子 Agent 任务及状态。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'platform_agent_get_task', description: '查看当前本轮子 Agent 任务的状态与结构化结果。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { type: 'function', name: 'platform_agent_wait_tasks', description: '等待当前编排中任务状态变化；超时只返回最新快照，不取消任务。', inputSchema: { type: 'object', properties: { taskIds: { type: 'array', items: { type: 'string' }, maxItems: 20 }, waitMs: { type: 'integer', minimum: 0, maximum: 90000 } }, additionalProperties: false } },
  { type: 'function', name: 'platform_agent_cancel_task', description: '取消当前编排内指定子 Agent 任务。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' } }, required: ['taskId'], additionalProperties: false } },
  { type: 'function', name: 'platform_agent_cancel_children', description: '取消当前编排内尚未结束的所有子 Agent 任务。', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { type: 'function', name: 'platform_agent_revise_task', description: '基于已结束任务创建新修订任务；原任务保持不变，新任务只读并依赖原任务。', inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, focus: { type: 'string', minLength: 1, maxLength: 4000 } }, required: ['taskId', 'focus'], additionalProperties: false } },
];

function taskView(task: AgentTask): Record<string, unknown> {
  return { taskId: task.id, name: task.name, role: task.role, status: task.status, attempt: task.attempt, maxAttempts: task.maxAttempts, dependencyIds: task.dependencyIds, ...(task.result?.summary ? { summary: task.result.summary.slice(0, 4000) } : {}), ...(task.result?.structuredResult ? { structuredResult: task.result.structuredResult } : {}), ...(task.error ? { error: task.error.slice(0, 2000) } : {}) };
}
export function createAgentOrchestrationProvider(options: {
  store: LocalStore;
  runner: AgentTaskRunner;
  session: Session;
  orchestrationId: string;
  runtimeKind: RuntimeKind;
  assertCurrent: (request: RuntimeToolInvocation) => void;
  audit?: (toolName: string, requestHash: string, resultHash: string, success: boolean) => void;
}): RuntimePlatformToolProvider {
  const list = () => options.store.listAgentTasks(options.session.id, options.orchestrationId);
  const find = (id: string) => list().find(task => task.id === id);
  const createTask = (input: z.infer<typeof taskSchema>, parent?: AgentTask): AgentTask => {
    const tasks = list();
    if (!options.session.projectId) throw new Error('当前会话没有关联项目，不能创建子 Agent');
    if (tasks.length >= 20 || options.store.listAgentTasks(options.session.id).length >= MAX_AGENT_TASKS_PER_SESSION) throw new Error('本轮或本会话子任务数量达到上限');
    const dependencies = [...new Set([...(input.dependencyIds ?? []), ...(parent ? [parent.id] : [])])];
    if (dependencies.some(id => !tasks.some(task => task.id === id))) throw new Error('依赖任务必须属于当前会话和编排轮次');
    const task = createAgentTask({ id: randomUUID(), sessionId: options.session.id, projectId: options.session.projectId, orchestrationId: options.orchestrationId, ...(parent ? { parentTaskId: parent.id } : {}), name: input.name, role: input.role, description: input.description, input: input.input, dependencyIds: dependencies, timeoutMs: input.timeoutMs, model: options.session.model, runtimeKind: options.runtimeKind, workspaceMode: 'read' });
    const requiredInputs = parent?.result?.structuredResult ? `\n\n上游任务结构化结果（仅作待核实线索）：\n${JSON.stringify(parent.result.structuredResult)}` : '';
    const contract = createTaskContract(task, { createdBy: 'main-runtime', inputRefs: parent ? [{ type: 'agent_task', ref: parent.id }] : [], outputExpectations: input.outputExpectations, acceptanceCriteria: input.acceptanceCriteria, description: `${task.description}${requiredInputs}` });
    options.store.saveAgentTaskContract(task, contract, 0, 'main-runtime');
    void options.runner.startForSession(options.session.id);
    return task;
  };

  return {
    listTools: () => definitions,
    execute: async request => {
      options.assertCurrent(request);
      const toolCallId = request.toolCallId ?? String(request.requestId);
      const requestHash = taskContentHash(request.arguments);
      const replay = options.store.beginOrchestrationToolCall({ sessionId: options.session.id, orchestrationId: options.orchestrationId, toolCallId, toolName: request.toolName, requestHash });
      if (replay.state === 'completed' && replay.result) return replay.result;
      if (replay.state === 'unknown_outcome') throw new Error('该工具调用结果未知，已拒绝重放；请使用新的 tool call ID 查询任务状态');
      let result: Record<string, unknown>;
      try {
        switch (request.toolName) {
          case 'platform_agent_create_task': result = taskView(createTask(taskSchema.parse(request.arguments))); break;
          case 'platform_agent_list_tasks': z.object({}).strict().parse(request.arguments); result = { tasks: list().map(taskView) }; break;
          case 'platform_agent_get_task': {
            const input = z.object({ taskId: idSchema }).strict().parse(request.arguments);
            const task = find(input.taskId); if (!task) throw new Error('任务不属于当前会话和编排轮次'); result = taskView(task); break;
          }
          case 'platform_agent_wait_tasks': {
            const input = z.object({ taskIds: z.array(idSchema).max(20).optional(), waitMs: z.number().int().min(0).max(90000).optional() }).strict().parse(request.arguments);
            const tasks = await options.runner.waitForTaskUpdates(options.session.id, options.orchestrationId, input.taskIds, input.waitMs ?? 15000);
            options.assertCurrent(request); result = { tasks: tasks.map(taskView) }; break;
          }
          case 'platform_agent_cancel_task': {
            const input = z.object({ taskId: idSchema }).strict().parse(request.arguments);
            if (!find(input.taskId)) throw new Error('任务不属于当前会话和编排轮次');
            await options.runner.cancel(options.session.id, input.taskId); result = { taskId: input.taskId, cancelled: true }; break;
          }
          case 'platform_agent_cancel_children': {
            z.object({}).strict().parse(request.arguments);
            const active = list().filter(task => !['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(task.status));
            for (const task of active) await options.runner.cancel(options.session.id, task.id);
            result = { cancelledTaskIds: active.map(task => task.id) }; break;
          }
          case 'platform_agent_revise_task': {
            const input = z.object({ taskId: idSchema, focus: z.string().trim().min(1).max(4000) }).strict().parse(request.arguments);
            const parent = find(input.taskId);
            if (!parent || !['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(parent.status)) throw new Error('只能修订本轮已结束的任务');
            const revision = createTask({ name: `${parent.name.slice(0, 96)}（修订）`, role: parent.role, description: `${parent.description}\n\n修订目标：${input.focus}`, input: input.focus, dependencyIds: [], outputExpectations: ['给出补充结论、核验过的证据及未解决项'], acceptanceCriteria: ['不得修改原任务或伪造上游结论；证据须来自本轮实际读取文件'] }, parent);
            result = taskView(revision); break;
          }
          default: throw new Error('未授权的平台编排工具');
        }
        options.store.completeOrchestrationToolCall({ sessionId: options.session.id, orchestrationId: options.orchestrationId, toolCallId, requestHash, result });
        options.audit?.(request.toolName, taskContentHash(request.arguments), taskContentHash(result), true);
        return result;
      } catch (error) {
        options.store.markOrchestrationToolCallUnknown({ sessionId: options.session.id, orchestrationId: options.orchestrationId, toolCallId, requestHash });
        options.audit?.(request.toolName, taskContentHash(request.arguments), taskContentHash({ error: error instanceof Error ? error.message : String(error) }), false);
        throw error;
      }
    },
  };
}

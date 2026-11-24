import { randomUUID } from 'node:crypto';
import type { AgentTask, AgentTaskRole, ExpertCollaborationAggregate, ExpertCollaborationConflict, ExpertCollaborationMode, ExpertCollaborationPlan, ExpertCollaborationTaskResult, ExpertPermissionTier, ExpertPlannerContext, ExpertTaskSpec, ProductSystem } from '../../domain/src';
import type { ExpertScope } from '../../domain/src/expert';

const ROLE_PROFILES: Array<{ role: AgentTaskRole; profileId: string; name: string; pattern: RegExp }> = [
  { role: 'requirement', profileId: 'mes-wms-requirements', name: '需求分析专家', pattern: /需求|方案|验收|业务规则|流程/ },
  { role: 'developer', profileId: 'mes-wms-backend', name: '后端开发专家', pattern: /后端|服务端|接口|数据库|SQL|事务|性能/ },
  { role: 'developer', profileId: 'mes-wms-frontend', name: '前端开发专家', pattern: /前端|页面|界面|组件|交互|样式|React|Vue/i },
  { role: 'testing', profileId: 'mes-wms-quality', name: '测试质量专家', pattern: /测试|回归|验证|用例|质量/ },
  { role: 'review', profileId: 'mes-wms-engineering', name: '研发工程专家', pattern: /审查|评审|风险|兼容|安全|架构/ },
];

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const EXPERT_PERMISSION_TIERS: readonly ExpertPermissionTier[] = ['read_only', 'workspace_write', 'command_execute', 'external_access', 'high_risk'];

function clean(value: string, maximum: number): string {
  const result = value.trim();
  if (!result || result.length > maximum || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) throw new Error('专家协作文本格式无效');
  return result;
}

function scopeOf(system?: ProductSystem): ExpertScope[] {
  if (system === 'MES5' || system === 'MES6' || system === 'WMS') return [system];
  return ['auto'];
}

function profileFor(role: AgentTaskRole, prompt: string, profiles: readonly ExpertPlannerContext[], preferredProfileId?: string): ExpertPlannerContext {
  const preferred = preferredProfileId ? profiles.find(profile => profile.id === preferredProfileId && profile.enabled) : undefined;
  if (preferred) return preferred;
  const candidate = ROLE_PROFILES.find(item => item.role === role && item.pattern.test(prompt));
  const fallback = role === 'testing' ? 'mes-wms-quality' : role === 'review' ? 'mes-wms-engineering' : role === 'requirement' ? 'mes-wms-requirements' : 'mes-wms-fullstack';
  const selected = profiles.find(profile => profile.id === candidate?.profileId && profile.enabled) ?? profiles.find(profile => profile.id === fallback && profile.enabled) ?? profiles.find(profile => profile.enabled);
  if (!selected) throw new Error('没有可用的启用专家');
  return selected;
}

function taskFor(input: { taskKey: string; role: AgentTaskRole; profileId?: string; objective: string; prompt: string; sessionId: string; projectId?: string; system?: ProductSystem; profiles: readonly ExpertPlannerContext[]; dependencyKeys?: string[] }): ExpertTaskSpec {
  const profile = profileFor(input.role, input.prompt, input.profiles, input.profileId);
  return {
    taskKey: input.taskKey,
    expertId: profile.id,
    expertName: profile.name,
    role: input.role,
    objective: clean(input.objective, 4000),
    sessionId: input.sessionId,
    ...(input.projectId ? { projectId: input.projectId } : {}),
    ...(input.system ? { system: input.system } : {}),
    scope: scopeOf(input.system),
    constraints: ['只读取当前项目和已绑定知识来源', '不得修改工作区、提交或推送 Git', '不得执行命令、写入数据库或访问外部系统', '结论必须引用实际证据并区分事实与推断'],
    expectedOutput: ['结构化结论', '实际文件证据和行号', '风险、未解决项与下一步'],
    acceptanceCriteria: ['至少引用一条可复核证据', '未执行的验证必须明确标注', '失败或资料不足不得表述为完成'],
    dependencyKeys: [...(input.dependencyKeys ?? [])],
    permissionTier: 'read_only',
    workspaceMode: 'read',
  };
}

export function createExpertCollaborationPlan(input: { sessionId: string; projectId?: string; system?: ProductSystem; prompt: string; profiles: readonly ExpertPlannerContext[]; now?: string }): ExpertCollaborationPlan {
  const prompt = clean(input.prompt, 50000);
  const tasks: ExpertTaskSpec[] = [];
  for (const item of ROLE_PROFILES) {
    if (!item.pattern.test(prompt)) continue;
    const role = item.role;
    if (tasks.some(task => task.role === role && task.expertId === item.profileId)) continue;
    tasks.push(taskFor({ taskKey: `${role}-${tasks.length + 1}`, role, profileId: item.profileId, objective: `${item.name}围绕本轮需求分析“${prompt.slice(0, 240)}”，输出可交付的专业结论。`, prompt, sessionId: input.sessionId, projectId: input.projectId, system: input.system, profiles: input.profiles }));
  }
  // 只读协作计划与调度器的单轮并发上限保持一致，超出工作面留给后续计划或主 Agent 复核。
  if (tasks.length > 3) tasks.splice(3);
  if (!tasks.length && /子\s*Agent|专家|并行分析|协作|拆分/.test(prompt)) tasks.push(taskFor({ taskKey: 'requirements-1', role: 'requirement', objective: `拆解本轮需求“${prompt.slice(0, 240)}”，明确边界、依赖和验收条件。`, prompt, sessionId: input.sessionId, projectId: input.projectId, system: input.system, profiles: input.profiles }));
  const sequential = tasks.length > 1 && /先.{0,30}(再|后)|然后|完成后|依赖|串行|顺序/.test(prompt);
  if (sequential) for (let index = 1; index < tasks.length; index += 1) tasks[index].dependencyKeys = [tasks[index - 1].taskKey];
  const classification: ExpertCollaborationMode = tasks.length <= 1 ? 'simple' : sequential ? 'sequential' : 'parallel';
  const plan: ExpertCollaborationPlan = { id: `expert-plan-${randomUUID()}`, sessionId: input.sessionId, ...(input.projectId ? { projectId: input.projectId } : {}), prompt, classification, reason: tasks.length ? (sequential ? '识别到有前后依赖的多个专业工作面' : tasks.length === 1 ? '识别到一个明确专业工作面' : '识别到多个可并行的独立专业工作面') : '当前需求不需要拆分专家任务', status: tasks.length ? 'review' : 'completed', maxConcurrency: tasks.length > 1 && !sequential ? Math.min(3, tasks.length) : 1, tasks, createdAt: input.now ?? new Date().toISOString(), updatedAt: input.now ?? new Date().toISOString() };
  assertExpertCollaborationPlan(plan);
  return plan;
}

export function assertExpertCollaborationPlan(plan: ExpertCollaborationPlan): void {
  if (!ID.test(plan.id) || !ID.test(plan.sessionId) || plan.projectId !== undefined && !ID.test(plan.projectId)) throw new Error('专家协作计划标识无效');
  clean(plan.prompt, 50000); clean(plan.reason, 2000);
  if (!['simple', 'sequential', 'parallel'].includes(plan.classification) || !['review', 'confirmed', 'executing', 'completed', 'partial', 'conflicted', 'rejected', 'cancelled', 'failed'].includes(plan.status)) throw new Error('专家协作计划状态无效');
  if (!Number.isInteger(plan.maxConcurrency) || plan.maxConcurrency < 1 || plan.maxConcurrency > 3) throw new Error('专家协作并发上限必须在 1 到 3 之间');
  if (plan.tasks.length > 20) throw new Error('单个专家协作计划最多包含 20 个任务');
  const byKey = new Map<string, ExpertTaskSpec>();
  for (const task of plan.tasks) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(task.taskKey) || byKey.has(task.taskKey)) throw new Error('专家任务标识必须唯一且格式正确');
    if (!ID.test(task.expertId) || !ID.test(task.sessionId) || task.sessionId !== plan.sessionId || task.projectId !== plan.projectId) throw new Error('专家任务归属与计划不一致');
    clean(task.expertName, 120); clean(task.objective, 4000);
    if (!task.constraints.length || !task.expectedOutput.length || !task.acceptanceCriteria.length) throw new Error('专家任务必须包含约束、输出和验收标准');
    if (!EXPERT_PERMISSION_TIERS.includes(task.permissionTier)) throw new Error('专家权限档位无效');
    if (task.permissionTier === 'read_only' && task.workspaceMode !== 'read') throw new Error('只读专家必须使用只读工作区');
    if (task.permissionTier !== 'read_only' && task.workspaceMode !== 'worktree') throw new Error('具有副作用的专家必须使用隔离工作区');
    byKey.set(task.taskKey, task);
  }
  const readOnly = plan.tasks.filter(task => task.permissionTier === 'read_only').length;
  const writes = plan.tasks.filter(task => task.permissionTier !== 'read_only').length;
  if (readOnly > 3) throw new Error('只读专家并发任务最多 3 个');
  if (writes > 1) throw new Error('同一协作计划最多允许 1 个写入型专家');
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (key: string): void => {
    if (visiting.has(key)) throw new Error('专家协作计划存在依赖环');
    if (visited.has(key)) return;
    visiting.add(key);
    const task = byKey.get(key)!;
    for (const dependency of task.dependencyKeys) { if (!byKey.has(dependency) || dependency === key) throw new Error('专家任务依赖不存在'); visit(dependency); }
    visiting.delete(key); visited.add(key);
  };
  for (const key of byKey.keys()) visit(key);
  if (plan.classification === 'parallel' && plan.tasks.some(task => task.dependencyKeys.length)) throw new Error('并行专家计划不能包含依赖');
}

function structuredFindings(task: AgentTask): ExpertCollaborationTaskResult['findings'] {
  const findings = task.result?.structuredResult?.findings ?? [];
  return findings.map(finding => ({ title: finding.title, detail: finding.detail, evidence: finding.evidence.map(item => ({ path: item.path, sha256: item.sha256, ...(item.lineStart !== undefined ? { lineStart: item.lineStart, lineEnd: item.lineEnd } : {}) })) }));
}

export function aggregateExpertTaskResults(plan: ExpertCollaborationPlan, tasks: readonly AgentTask[], now = new Date().toISOString()): ExpertCollaborationAggregate {
  assertExpertCollaborationPlan(plan);
  const byId = new Map(tasks.map(task => [task.id, task]));
  const results: ExpertCollaborationTaskResult[] = plan.tasks.map(spec => {
    const task = spec.agentTaskId ? byId.get(spec.agentTaskId) : undefined;
    return { taskKey: spec.taskKey, ...(spec.agentTaskId ? { agentTaskId: spec.agentTaskId } : {}), expertId: spec.expertId, expertName: spec.expertName, status: task?.status ?? 'PENDING', ...(task?.result?.summary ? { summary: task.result.summary.slice(0, 5000) } : {}), findings: task ? structuredFindings(task) : [], ...(task?.error ? { error: task.error.slice(0, 2000) } : {}) };
  });
  const conflicts: ExpertCollaborationConflict[] = [];
  const evidenceByPath = new Map<string, Array<{ sha256: string; taskKey: string }>>();
  const findingsByTitle = new Map<string, Array<{ detail: string; taskKey: string }>>();
  for (const result of results) for (const finding of result.findings) {
    for (const evidence of finding.evidence) evidenceByPath.set(evidence.path, [...(evidenceByPath.get(evidence.path) ?? []), { sha256: evidence.sha256, taskKey: result.taskKey }]);
    findingsByTitle.set(finding.title, [...(findingsByTitle.get(finding.title) ?? []), { detail: finding.detail, taskKey: result.taskKey }]);
  }
  for (const [path, entries] of evidenceByPath) {
    const hashes = [...new Set(entries.map(entry => entry.sha256))];
    if (hashes.length > 1) conflicts.push({ kind: 'evidence_hash', subject: path, taskKeys: [...new Set(entries.map(entry => entry.taskKey))], details: hashes.map(hash => `SHA256 ${hash}`) });
  }
  for (const [title, entries] of findingsByTitle) {
    const details = [...new Set(entries.map(entry => entry.detail))];
    if (details.length > 1) conflicts.push({ kind: 'finding_detail', subject: title, taskKeys: [...new Set(entries.map(entry => entry.taskKey))], details: details.map(detail => detail.slice(0, 1000)) });
  }
  const evidence = [...evidenceByPath.entries()].map(([path, entries]) => ({ path, sha256: entries[0].sha256, taskKeys: [...new Set(entries.map(entry => entry.taskKey))] }));
  const terminal = results.every(result => ['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(result.status));
  const failed = results.some(result => ['FAILED', 'CANCELLED', 'BLOCKED'].includes(result.status))
    || results.some(result => ['failed', 'blocked'].includes(tasks.find(task => task.id === result.agentTaskId)?.result?.structuredResult?.outcome ?? ''));
  const partial = results.some(result => tasks.find(task => task.id === result.agentTaskId)?.result?.structuredResult?.outcome === 'partial');
  const status = conflicts.length ? 'conflicted' : !terminal ? 'pending' : failed || partial ? 'partial' : 'completed';
  const summary = status === 'conflicted' ? `专家结果已汇总，但发现 ${conflicts.length} 项冲突，需人工复核。` : status === 'partial' ? '专家结果部分完成，失败、取消或阻塞项已保留。' : status === 'completed' ? '专家结果全部完成，证据已汇总。' : '专家任务尚未全部结束。';
  return { planId: plan.id, status, summary, results, conflicts, evidence, createdAt: now };
}

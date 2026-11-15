import { useEffect, useState } from 'react';
import type { Project, TaskCheckpoint, TaskGovernancePlanInput, TaskGovernanceRecoveryAssessment, TaskPlan, TaskPlanStep, TaskPlanStepStatus } from '../../../../packages/domain/src';
import './task-governance.css';

type PlanView = { plan: TaskPlan; steps: TaskPlanStep[] };
type EditableStep = TaskGovernancePlanInput['steps'][number];
export interface TaskGovernancePanelProps {
  project?: Project;
  taskId?: string;
  runActive?: boolean;
  onExecuteStep?: (input: { taskId: string; planId: string; stepId: string; prompt: string }) => Promise<void>;
  onResume?: (input: { checkpointId: string; taskId: string; projectId?: string; prompt: string; revalidationOnly?: boolean }) => Promise<void> | void;
}

const stepLabels: Record<TaskPlanStepStatus, string> = { pending: '等待前置阶段', ready: '可执行', running: '执行中／待核对', succeeded: '已核对完成', failed: '失败', skipped: '已跳过', blocked: '阻塞', invalidated: '已失效' };
const planLabels: Record<TaskPlan['status'], string> = { draft: '草稿', review: '待确认', confirmed: '已确认', executing: '执行中', completed: '已完成', superseded: '已被替代' };
const recoveryLabels: Record<TaskGovernanceRecoveryAssessment['status'], string> = { safe_to_resume: '可进行平台级任务恢复', resume_with_revalidation: '必须先重新验证', manual_reconciliation_required: '需人工核对变更', cannot_resume: '当前不能恢复', not_checked: '尚未检查' };
const lines = (value: string) => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const failure = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const newStep = (index: number): EditableStep => ({ stepKey: `step-${index + 1}`, title: '', description: '', order: index, dependsOn: [], required: true });

/** 阶段执行委派现有会话，不把发送成功或模型自评当作步骤完成证据。 */
export function TaskGovernancePanel({ project, taskId, runActive = false, onExecuteStep, onResume }: TaskGovernancePanelProps) {
  const api = window.jinggong.taskGovernance;
  const [plans, setPlans] = useState<PlanView[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [checkpoints, setCheckpoints] = useState<TaskCheckpoint[]>([]);
  const [assessments, setAssessments] = useState<Record<string, TaskGovernanceRecoveryAssessment>>({});
  const [goal, setGoal] = useState('');
  const [criteria, setCriteria] = useState('');
  const [assumptions, setAssumptions] = useState('');
  const [revisionReason, setRevisionReason] = useState('');
  const [steps, setSteps] = useState<EditableStep[]>([newStep(0)]);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState('');
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const selected = plans.find(item => item.plan.id === selectedId) ?? plans[0];

  useEffect(() => {
    let active = true;
    setPlans([]); setSelectedId(''); setCheckpoints([]); setAssessments({}); setFeedback('');
    setGoal(''); setCriteria(''); setAssumptions(''); setRevisionReason(''); setSteps([newStep(0)]); setEditing(false); setSummaries({}); setEvidence({});
    if (api && taskId) void Promise.all([api.listPlans(taskId), api.listCheckpoints(taskId)]).then(([nextPlans, nextCheckpoints]) => {
      if (!active) return;
      const sorted = nextPlans.sort((a, b) => b.plan.revision - a.plan.revision);
      setPlans(sorted); setSelectedId(sorted[0]?.plan.id ?? ''); setCheckpoints(nextCheckpoints); setEditing(!sorted.length);
    }).catch(reason => { if (active) setFeedback(failure(reason)); });
    return () => { active = false; };
  }, [api, project?.id, taskId]);

  async function reload() {
    if (!api || !taskId) return;
    const [nextPlans, nextCheckpoints] = await Promise.all([api.listPlans(taskId), api.listCheckpoints(taskId)]);
    setPlans(nextPlans.sort((a, b) => b.plan.revision - a.plan.revision)); setCheckpoints(nextCheckpoints);
  }
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key); setFeedback('');
    try { await action(); } catch (reason) { setFeedback(failure(reason)); }
    finally { setBusy(''); }
  }
  function editPlan() {
    if (selected) {
      setGoal(selected.plan.goal); setCriteria(selected.plan.acceptanceCriteria.join('\n')); setAssumptions(selected.plan.assumptions.join('\n'));
      setSteps(selected.steps.slice().sort((a, b) => a.order - b.order).map(step => ({ stepKey: step.stepKey, title: step.title, description: step.description, order: step.order, dependsOn: step.dependsOn, required: step.required })));
    }
    setRevisionReason(''); setEditing(true);
  }
  async function savePlan() {
    if (!api || !taskId || !project) return;
    if (plans.length && !revisionReason.trim()) throw new Error('请填写计划修订原因');
    const created = await api.createPlan({ taskId, projectId: project.id, goal, acceptanceCriteria: lines(criteria), assumptions: [...lines(assumptions), ...(revisionReason.trim() ? [`计划修订原因：${revisionReason.trim()}`] : [])], steps: steps.map((step, index) => ({ ...step, order: index })) });
    setSelectedId(created.plan.id); setEditing(false); await reload(); setFeedback('计划版本已保存，请检查依赖和验收标准后确认。');
  }
  async function execute(step: TaskPlanStep) {
    if (!api || !selected || !taskId || !onExecuteStep) return;
    await api.transitionStep({ planId: selected.plan.id, stepId: step.id, next: 'running' });
    await reload();
    try {
      await onExecuteStep({ taskId, planId: selected.plan.id, stepId: step.id, prompt: [
        `执行已确认任务计划的当前阶段。Task=${taskId}；Plan=${selected.plan.id}；Revision=${selected.plan.revision}；Step=${step.id}。`,
        `任务目标：${selected.plan.goal}`, `当前阶段：${step.title}`, `阶段说明：${step.description || '按当前项目规范完成本阶段。'}`,
        `验收标准：\n${selected.plan.acceptanceCriteria.map(item => `- ${item}`).join('\n')}`,
        '只执行当前阶段，在安全边界停止并汇总实际产出、文件变更、真实命令退出码和验证证据。未经用户确认不要自动开始后续阶段。不能用模型自评冒充构建、测试或交付成功。',
      ].join('\n\n') });
      setFeedback('本阶段已交给当前 Runtime。结束后请核对实际产出和验证记录，再记录阶段结果。');
    } catch (reason) {
      await api.transitionStep({ planId: selected.plan.id, stepId: step.id, next: 'failed', outputSummary: `阶段调用失败：${failure(reason)}` });
      await reload(); throw reason;
    }
  }
  async function transition(step: TaskPlanStep, next: TaskPlanStepStatus) {
    if (!api || !selected) return;
    if (runActive) throw new Error('当前 Runtime 仍在运行，请等待结束后核对阶段结果');
    const summary = summaries[step.id]?.trim();
    if (['succeeded', 'failed', 'blocked'].includes(next) && !summary) throw new Error('请填写本阶段实际产出或失败原因');
    await api.transitionStep({ planId: selected.plan.id, stepId: step.id, next, outputSummary: summary, evidenceRefs: lines(evidence[step.id] ?? '') });
    await reload();
    if (['succeeded', 'skipped'].includes(next)) {
      const latest = await api.listPlans(selected.plan.taskId);
      if (latest.find(item => item.plan.id === selected.plan.id)?.plan.status !== 'completed') await api.refreshReadySteps(selected.plan.id);
      await reload();
    }
    setFeedback(next === 'succeeded' ? '已记录人工核对后的阶段结果。构建与测试状态仍以真实验证记录为准。' : '阶段状态已更新。');
  }
  async function checkpoint(step: TaskPlanStep) {
    if (!api || !selected || !project || !taskId) return;
    if (runActive) throw new Error('请等待当前 Runtime 阶段结束');
    const snapshot = await window.jinggong.iteration?.buildProjectContext(project.id, taskId);
    await api.createCheckpoint({ taskId, projectId: project.id, planId: selected.plan.id, stepId: step.id, ...(snapshot ? { contextSnapshotId: snapshot.snapshot.id } : {}), checkpointSummary: step.outputSummary?.trim() || `${step.title}：${stepLabels[step.status]}`, completedActions: selected.steps.filter(item => item.status === 'succeeded').map(item => `${item.title}：${item.outputSummary ?? ''}`), pendingActions: selected.steps.filter(item => !['succeeded', 'skipped'].includes(item.status)).map(item => `${item.title}（${stepLabels[item.status]}）`), evidenceRefs: step.evidenceRefs });
    await reload(); setFeedback('已在安全阶段边界保存检查点；源代码不复制入库。');
  }
  async function resume(checkpoint: TaskCheckpoint) {
    if (!onResume) return;
    const checked = await api!.assessRecovery(checkpoint.id);
    setAssessments(current => ({ ...current, [checkpoint.id]: checked }));
    if (!checked.canStartPlatformResume && !checked.requiresRevalidation) throw new Error(checked.reasons.join('；'));
    const revalidationOnly = checked.requiresRevalidation;
    await onResume({ checkpointId: checkpoint.id, taskId: checkpoint.taskId, projectId: checkpoint.projectId, revalidationOnly, prompt: [
      '平台级任务恢复：在新执行会话中读取旧检查点，不恢复原 Runtime 进程，不重放旧工具调用。',
      `父 Task：${checkpoint.taskId}；原 Plan：${checkpoint.planId}；原 Step：${checkpoint.stepId}；Checkpoint：${checkpoint.id}。`,
      `检查点摘要：${checkpoint.checkpointSummary}`, `原分支：${checkpoint.branch ?? '未知'}；HEAD：${checkpoint.headSha ?? '未知'}`,
      `已完成动作：${checkpoint.completedActionsJson}`, `待办动作：${checkpoint.pendingActionsJson}`, `证据引用：${checkpoint.evidenceRefsJson}`,
      `恢复审查：${checked.reasons.join('；')}`,
      revalidationOnly ? '本次只重新读取相关文件并执行必要的构建/测试，汇总真实结果后停止，等待用户确认；不得继续修改业务代码或开始后续阶段。' : '先核对检查点与当前文件，按当前已确认计划继续下一安全阶段；发现新改动或资料变化立即停止并告知用户。',
    ].join('\n\n') });
    setFeedback(revalidationOnly ? '已创建用于重新验证的平台恢复会话。验证完成后需重新检查恢复条件。' : '已创建平台级恢复会话，原计划与检查点历史已保留。');
  }

  if (!project || !taskId) return <div className="inspector-empty"><strong>选择项目会话后管理任务计划</strong><p>简单任务仍可直接在对话中执行。</p></div>;
  if (!api) return <div className="inspector-empty"><strong>任务计划服务尚未加载</strong><p>请重新启动最新版本。</p></div>;
  const mutable = !!selected && ['confirmed', 'executing'].includes(selected.plan.status);
  const blocked = !!busy || runActive;
  return <div className="task-governance-panel iteration-body">
    {feedback && <div className="iteration-feedback" role="status">{feedback}</div>}
    <section><div className="iteration-section-heading"><h4>任务计划与阶段执行</h4><button className="secondary-button" disabled={!!busy} onClick={() => void run('refresh', reload)}>刷新</button></div><p className="iteration-muted">计划范围：当前会话。阶段由现有 Runtime 执行，完成状态需核对实际产出；不会因发送成功自动记为通过。</p>{plans.length > 0 && <label>计划版本<select value={selected?.plan.id ?? ''} onChange={event => { setSelectedId(event.target.value); setEditing(false); }}>{plans.map(item => <option key={item.plan.id} value={item.plan.id}>第 {item.plan.revision} 版 · {planLabels[item.plan.status]}</option>)}</select></label>}<button className="secondary-button" disabled={blocked} onClick={editPlan}>{plans.length ? '编辑并建立新版本' : '制定任务计划'}</button></section>
    {editing && <section><h4>编辑计划</h4><label>任务目标<textarea rows={3} value={goal} onChange={event => setGoal(event.target.value)} maxLength={8000} /></label><label>验收标准（每行一项）<textarea rows={3} value={criteria} onChange={event => setCriteria(event.target.value)} maxLength={12000} /></label><label>前置假设与约束（每行一项）<textarea value={assumptions} onChange={event => setAssumptions(event.target.value)} maxLength={12000} /></label>{plans.length > 0 && <label>修订原因<input value={revisionReason} onChange={event => setRevisionReason(event.target.value)} maxLength={1000} /></label>}{steps.map((step, index) => <div className="governance-edit-step" key={index}><strong>阶段 {index + 1}</strong><label>阶段标识<input value={step.stepKey} onChange={event => setSteps(current => current.map((item, row) => row === index ? { ...item, stepKey: event.target.value } : item))} maxLength={100} /></label><label>阶段名称<input value={step.title} onChange={event => setSteps(current => current.map((item, row) => row === index ? { ...item, title: event.target.value } : item))} maxLength={200} /></label><label>说明、预期产出与失败处理<textarea value={step.description} onChange={event => setSteps(current => current.map((item, row) => row === index ? { ...item, description: event.target.value } : item))} maxLength={4000} /></label><label>依赖阶段标识（逗号分隔）<input value={step.dependsOn?.join(', ') ?? ''} onChange={event => setSteps(current => current.map((item, row) => row === index ? { ...item, dependsOn: event.target.value.split(/[,，]/).map(value => value.trim()).filter(Boolean) } : item))} /></label><label className="governance-checkbox"><input type="checkbox" checked={step.required !== false} onChange={event => setSteps(current => current.map((item, row) => row === index ? { ...item, required: event.target.checked } : item))} />必须完成</label><div className="iteration-export-actions"><button className="secondary-button" disabled={index === 0} onClick={() => setSteps(current => { const next = [...current]; [next[index - 1], next[index]] = [next[index], next[index - 1]]; return next; })}>上移</button><button className="secondary-button" disabled={steps.length === 1} onClick={() => setSteps(current => current.filter((_, row) => row !== index))}>删除阶段</button></div></div>)}<div className="iteration-export-actions"><button className="secondary-button" disabled={steps.length >= 100} onClick={() => setSteps(current => [...current, { ...newStep(current.length), stepKey: `step-${Date.now()}` }])}>添加阶段</button><button className="primary-button" disabled={blocked || !goal.trim() || !lines(criteria).length || steps.some(step => !step.title.trim() || !step.stepKey.trim())} onClick={() => void run('save', savePlan)}>保存待确认计划</button><button className="secondary-button" disabled={!!busy} onClick={() => setEditing(false)}>取消编辑</button></div></section>}
    {selected && !editing && <section><h4>{selected.plan.goal}</h4><p className="iteration-muted">第 {selected.plan.revision} 版 · {planLabels[selected.plan.status]} · {new Date(selected.plan.createdAt).toLocaleString()}</p><ul>{selected.plan.acceptanceCriteria.map((item, index) => <li key={index}>{item}</li>)}</ul>{selected.plan.assumptions.length > 0 && <details><summary>前置假设与修订说明</summary><ul>{selected.plan.assumptions.map((item, index) => <li key={index}>{item}</li>)}</ul></details>}{['draft', 'review'].includes(selected.plan.status) && <button className="primary-button" disabled={blocked} onClick={() => void run('confirm', async () => { await api.confirmPlan(selected.plan.id); await api.refreshReadySteps(selected.plan.id); await reload(); setFeedback('计划已确认，可按依赖逐阶段执行。'); })}>确认计划</button>}{selected.steps.slice().sort((a, b) => a.order - b.order).map(step => <div className="governance-step" key={step.id}><div className="iteration-section-heading"><strong>{step.order + 1}. {step.title}</strong><small>{stepLabels[step.status]}</small></div><p>{step.description}</p><small>依赖：{step.dependsOn.join('、') || '无'}{step.required ? ' · 必须完成' : ' · 可选'}{step.startedAt ? ` · 开始 ${new Date(step.startedAt).toLocaleString()}` : ''}{step.completedAt ? ` · 结束 ${new Date(step.completedAt).toLocaleString()}` : ''}</small>{step.outputSummary && <pre className="iteration-context-preview">{step.outputSummary}</pre>}{step.evidenceRefs.length > 0 && <small>已关联证据：{step.evidenceRefs.join('；')}</small>}{mutable && <><div className="iteration-export-actions">{step.status === 'ready' && <button className="primary-button" disabled={blocked || !onExecuteStep} onClick={() => void run(`execute-${step.id}`, () => execute(step))}>执行本阶段</button>}{['failed', 'blocked', 'invalidated'].includes(step.status) && <button className="secondary-button" disabled={blocked} onClick={() => void run(`ready-${step.id}`, () => transition(step, 'ready'))}>重新检查前置条件</button>}{step.status === 'ready' && !step.required && <button className="secondary-button" disabled={blocked} onClick={() => void run(`skip-${step.id}`, () => transition(step, 'skipped'))}>跳过可选阶段</button>}</div>{step.status === 'running' && <><label>实际产出摘要／失败原因<textarea rows={3} value={summaries[step.id] ?? ''} onChange={event => setSummaries(current => ({ ...current, [step.id]: event.target.value }))} maxLength={8000} /></label><label>真实验证 Run／文件／日志引用（每行一项）<textarea value={evidence[step.id] ?? ''} onChange={event => setEvidence(current => ({ ...current, [step.id]: event.target.value }))} maxLength={12000} /></label><div className="iteration-export-actions"><button className="primary-button" disabled={blocked} onClick={() => void run(`success-${step.id}`, () => transition(step, 'succeeded'))}>核对产出并记录完成</button><button className="secondary-button" disabled={blocked} onClick={() => void run(`failed-${step.id}`, () => transition(step, 'failed'))}>记录失败</button><button className="secondary-button" disabled={blocked} onClick={() => void run(`blocked-${step.id}`, () => transition(step, 'blocked'))}>记录阻塞</button></div></>}</>}{['succeeded', 'failed', 'blocked', 'skipped'].includes(step.status) && selected.plan.status !== 'superseded' && <button className="secondary-button" disabled={blocked} onClick={() => void run(`checkpoint-${step.id}`, () => checkpoint(step))}>保存阶段检查点</button>}</div>)}{!onExecuteStep && <p className="iteration-muted">当前入口未绑定执行会话，请在会话中打开任务计划。</p>}</section>}
    <section><h4>检查点与平台级任务恢复</h4><p className="iteration-muted">恢复前检查真实分支、HEAD、文件指纹、资料版本、验证证据和 Runtime。新用户改动需人工核对，不会自动覆盖。</p>{checkpoints.length === 0 && <p className="iteration-muted">暂无检查点。请在阶段结束后的安全边界保存。</p>}{checkpoints.map(item => <div className="governance-step" key={item.id}><strong>{item.checkpointSummary}</strong><small>{new Date(item.createdAt).toLocaleString()} · {item.branch ?? '分支未知'} · {item.headSha?.slice(0, 10) ?? 'HEAD 未知'}</small><button className="secondary-button" disabled={blocked} onClick={() => void run(`assess-${item.id}`, async () => { const result = await api.assessRecovery(item.id); setAssessments(current => ({ ...current, [item.id]: result })); })}>检查恢复条件</button>{assessments[item.id] && <><strong>{recoveryLabels[assessments[item.id].status]}</strong><ul>{assessments[item.id].reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>{onResume && (assessments[item.id].canStartPlatformResume || assessments[item.id].requiresRevalidation) && <button className="primary-button" disabled={blocked} onClick={() => void run(`resume-${item.id}`, () => resume(item))}>{assessments[item.id].requiresRevalidation ? '新建会话重新验证' : '新建会话进行平台恢复'}</button>}</>}</div>)}</section>
  </div>;
}

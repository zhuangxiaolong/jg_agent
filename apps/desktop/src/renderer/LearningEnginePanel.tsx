import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentTask, LearningCandidate, LearningEngineApi, LearningEligibility, LearningValidationResult } from '../../../../packages/domain/src';
import './learning-engine.css';

const statusNames: Record<LearningCandidate['status'], string> = { draft: '草稿', needs_review: '待审核', approved: '已批准', published: '已发布', rejected: '已拒绝', superseded: '已替代' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function LearningEnginePanel({ api, sessionId, task, onError }: { api: LearningEngineApi; sessionId: string; task: AgentTask; onError: (message: string) => void }) {
  const [eligibility, setEligibility] = useState<LearningEligibility>();
  const [candidates, setCandidates] = useState<LearningCandidate[]>([]);
  const [candidateId, setCandidateId] = useState('');
  const [selectedEvidence, setSelectedEvidence] = useState<string[]>([]);
  const [manualConfirmation, setManualConfirmation] = useState(false);
  const [candidate, setCandidate] = useState<LearningCandidate>();
  const [validation, setValidation] = useState<LearningValidationResult>();
  const [aiProviders, setAiProviders] = useState<Awaited<ReturnType<LearningEngineApi['listAiProviders']>>>([]);
  const [aiProviderId, setAiProviderId] = useState('');
  const [aiModel, setAiModel] = useState('');
  const [aiEvidenceIds, setAiEvidenceIds] = useState<string[]>([]);
  const [selectedExcerpt, setSelectedExcerpt] = useState('');
  const [scope, setScope] = useState<'disabled' | 'project'>('disabled');
  const [usage, setUsage] = useState<Awaited<ReturnType<LearningEngineApi['listUsage']>>>([]);
  const [busy, setBusy] = useState(false);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const refresh = useCallback(async () => {
    const [result, rows, events] = await Promise.all([api.eligibility(sessionId, task.id), api.listCandidates(sessionId), api.listUsage(sessionId)]);
    setEligibility(result);
    setCandidates(rows);
    setUsage(events);
    setSelectedEvidence(current => current.filter(id => result.evidenceRefs.some(item => item.kind === 'task_evidence' && item.refId === id)));
  }, [api, sessionId, task.id]);

  useEffect(() => { void refresh().catch(error => onErrorRef.current(errorText(error))); }, [refresh]);
  useEffect(() => {
    const selected = candidates.find(item => item.id === candidateId);
    setCandidate(selected);
    setAiEvidenceIds(selected?.evidence.filter(item => item.kind === 'task_evidence').map(item => item.refId) ?? []);
    setSelectedExcerpt('');
    setValidation(undefined);
  }, [candidateId, candidates]);
  useEffect(() => { void api.listAiProviders().then(providers => { setAiProviders(providers); if (providers[0]) { setAiProviderId(providers[0].id); setAiModel(providers[0].models[0] ?? ''); } }).catch(error => onErrorRef.current(errorText(error))); }, [api]);

  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try { await action(); await refresh(); }
    catch (error) { onErrorRef.current(errorText(error)); }
    finally { setBusy(false); }
  }

  const patchCandidate = (patch: Partial<Pick<LearningCandidate, 'title' | 'suggestedSkillName' | 'description' | 'draftSkillMarkdown'>>) => {
    if (candidate) setCandidate({ ...candidate, ...patch });
  };

  return <section className="learning-engine-panel" aria-label="经验沉淀与 Skill 学习">
    <p>仅根据所选契约与验证证据生成本地草稿；不会在任务完成时调用模型。加载记录不等同于实际使用或任务验证通过。</p>
    {eligibility && <div className="learning-eligibility">
      <strong>{eligibility.eligible ? '可进入候选流程' : '暂不可沉淀'}</strong>
      {eligibility.blockReasons.map((reason, index) => <span key={`b${index}`} className="learning-block">{reason}</span>)}
      {eligibility.warnings.map((warning, index) => <span key={`w${index}`} className="learning-warning">{warning}</span>)}
    </div>}
    {eligibility?.eligible && <div className="learning-create">
      <strong>选择候选来源</strong>
      {eligibility.evidenceRefs.filter(item => item.kind === 'task_evidence').map(item => <label key={item.refId}><input type="checkbox" checked={selectedEvidence.includes(item.refId)} onChange={event => setSelectedEvidence(current => event.target.checked ? [...current, item.refId] : current.filter(id => id !== item.refId))} /> 验证证据 · {item.status ?? '状态未知'} · {item.refId.slice(0, 24)}</label>)}
      {eligibility.requiresManualConfirmation && <label><input type="checkbox" checked={manualConfirmation} onChange={event => setManualConfirmation(event.target.checked)} /> 我已确认这是人工复核材料，草稿不代表代码验证通过</label>}
      <div><button disabled={busy} onClick={() => void run(async () => { const kind = eligibility.candidateTypes.includes('skill') ? 'skill' : 'failure_lesson'; const created = await api.createCandidate({ sessionId, taskId: task.id, candidateType: kind, selectedEvidenceIds: selectedEvidence, manualConfirmation }); setCandidateId(created.id); setCandidate(created); })}>生成本地草稿</button></div>
    </div>}
    {candidates.length > 0 && <label className="learning-select">候选草稿
      <select value={candidateId} onChange={event => setCandidateId(event.target.value)}><option value="">请选择候选</option>{candidates.map(item => <option key={item.id} value={item.id}>{item.title} · {statusNames[item.status]} · r{item.revision}</option>)}</select>
    </label>}
    {candidate && <div className="learning-candidate">
      <div className="learning-candidate-heading"><strong>{candidate.title} · {statusNames[candidate.status]}</strong><span>{candidate.evidenceLevel === 'verified' ? '真实验证证据' : candidate.evidenceLevel === 'failure_lesson' ? '问题复盘（不可发布）' : '人工复核级（非代码验证）'}</span></div>
      <label>标题<input value={candidate.title} onChange={event => patchCandidate({ title: event.target.value })} /></label>
      <label>Skill 名称（slug）<input value={candidate.suggestedSkillName} onChange={event => patchCandidate({ suggestedSkillName: event.target.value })} /></label>
      <label>描述<input value={candidate.description} onChange={event => patchCandidate({ description: event.target.value })} /></label>
      <label>适用系统<select value={candidate.systemScope[0] ?? 'GENERAL'} onChange={event => setCandidate({ ...candidate, systemScope: [event.target.value as LearningCandidate['systemScope'][number]] })}>{['MES5', 'MES6', 'WMS', 'GENERAL'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>
      <label>草稿正文<textarea rows={14} value={candidate.draftSkillMarkdown} onChange={event => patchCandidate({ draftSkillMarkdown: event.target.value })} /></label>
      <small>证据引用：{candidate.evidence.map(item => `${item.kind}:${item.refId}`).join('；') || '无'} · Hash {validation?.contentHash.slice(0, 16) ?? '校验后生成'}</small>
      {!aiProviders.length && <small>尚无可用 AI 模型；请先配置已保存凭据且包含模型的中转站。</small>}
      {candidate.evidence.some(item => item.kind === 'task_evidence') && <fieldset className="learning-ai-sources"><legend>AI 整理时明确选择发送的验证证据</legend>{candidate.evidence.filter(item => item.kind === 'task_evidence').map(item => <label key={item.refId}><input type="checkbox" checked={aiEvidenceIds.includes(item.refId)} onChange={event => setAiEvidenceIds(current => event.target.checked ? [...current, item.refId] : current.filter(id => id !== item.refId))} /> {item.status ?? '状态未知'} · {item.refId.slice(0, 24)}</label>)}</fieldset>}
      <label>手动选择的任务片段（可选，最多 8000 字）<textarea rows={4} maxLength={8000} value={selectedExcerpt} onChange={event => setSelectedExcerpt(event.target.value)} placeholder="仅粘贴希望 AI 整理的片段；不会自动发送完整会话或任务记录" /></label>
      <div className="learning-actions">
        <button disabled={busy || ['published', 'rejected', 'superseded'].includes(candidate.status)} onClick={() => void run(async () => { const updated = await api.updateCandidate({ candidateId: candidate.id, expectedRevision: candidate.revision, title: candidate.title, suggestedSkillName: candidate.suggestedSkillName, description: candidate.description, draftSkillMarkdown: candidate.draftSkillMarkdown, systemScope: candidate.systemScope }); setCandidate(updated); setCandidateId(updated.id); })}>保存修改</button>
        <label className="learning-ai-provider">AI 服务商<select value={aiProviderId} disabled={busy || aiProviders.length === 0} onChange={event => { const provider = aiProviders.find(item => item.id === event.target.value); setAiProviderId(event.target.value); setAiModel(provider?.models[0] ?? ''); }}>{aiProviders.map(provider => <option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label>
        <label className="learning-ai-provider">模型<select value={aiModel} disabled={busy || !aiProviders.find(item => item.id === aiProviderId)?.models.length} onChange={event => setAiModel(event.target.value)}>{(aiProviders.find(item => item.id === aiProviderId)?.models ?? []).map(model => <option key={model} value={model}>{model}</option>)}</select></label>
        <button disabled={busy || !aiProviderId || !aiModel || ['published', 'rejected', 'superseded'].includes(candidate.status) || candidate.evidenceLevel === 'failure_lesson'} onClick={() => {
          const provider = aiProviders.find(item => item.id === aiProviderId);
          const excerptPreview = selectedExcerpt.trim() ? `\n\n手动片段预览：\n${selectedExcerpt.trim().slice(0, 600)}${selectedExcerpt.trim().length > 600 ? '…' : ''}` : '\n\n手动片段：无';
          const confirmed = window.confirm(`AI 可能产生模型费用。将发送给 ${provider?.name ?? '所选服务商'} / ${aiModel}：候选标题与描述、当前任务契约摘要、你勾选的验证证据摘要、本地草稿，以及手动选择的片段。不会发送完整日志或整个代码仓库。请确认所选内容已获授权并适合发送。${excerptPreview}\n\n继续生成 AI 草稿？`);
          if (!confirmed) return;
          void run(async () => {
            const saved = await api.updateCandidate({ candidateId: candidate.id, expectedRevision: candidate.revision, title: candidate.title, suggestedSkillName: candidate.suggestedSkillName, description: candidate.description, draftSkillMarkdown: candidate.draftSkillMarkdown, systemScope: candidate.systemScope });
            const updated = await api.generateAiDraft({ candidateId: saved.id, expectedRevision: saved.revision, providerId: aiProviderId, model: aiModel, selectedEvidenceIds: aiEvidenceIds, ...(selectedExcerpt.trim() ? { selectedExcerpt: selectedExcerpt.trim() } : {}) });
            setCandidate(updated); setCandidateId(updated.id);
          });
        }}>AI 整理草稿</button>
        <button disabled={busy || candidate.evidenceLevel === 'failure_lesson'} onClick={() => void run(async () => setValidation(await api.validateCandidate(candidate.id)))}>格式与隐私校验</button>
        <button disabled={busy || candidate.status === 'approved' || candidate.evidenceLevel === 'failure_lesson'} onClick={() => void run(async () => { const updated = await api.approveCandidate({ candidateId: candidate.id, expectedRevision: candidate.revision }); setCandidate(updated); setCandidateId(updated.id); })}>人工批准</button>
        <button disabled={busy || candidate.status !== 'approved'} onClick={() => void run(async () => { const updated = await api.publishCandidate({ candidateId: candidate.id, expectedRevision: candidate.revision, scope }); setCandidate(updated); setCandidateId(updated.id); })}>发布到 Plugin Manager</button>
        <button disabled={busy || ['published', 'rejected', 'superseded'].includes(candidate.status)} onClick={() => void run(async () => { const updated = await api.rejectCandidate({ candidateId: candidate.id, expectedRevision: candidate.revision }); setCandidate(updated); setCandidateId(updated.id); })}>拒绝候选</button>
      </div>
      {candidate.status === 'approved' && <label>发布范围<select value={scope} onChange={event => setScope(event.target.value as 'disabled' | 'project')}><option value="disabled">发布但保持禁用</option><option value="project">仅当前项目启用</option></select></label>}
      {validation && <div className="learning-findings"><strong>{validation.valid ? '格式可用；仍需人工审阅' : '存在阻断项'}</strong>{validation.findings.map((item, index) => <span key={`${item.code}-${index}`} className={item.severity === 'block' ? 'learning-block' : 'learning-warning'}>{item.code} · {item.message}（位置 {item.position}）</span>)}</div>}
    </div>}
    <div className="learning-usage"><strong>Skill 使用事件 · {usage.length} 条（仅加载不表示实际使用）</strong>
      {usage.length > 0 && usage.map(event => <article key={event.eventId}><span>{event.eventType} · {event.skillId} · {new Date(event.createdAt).toLocaleString()}</span>{event.feedback ? <small>评价：{event.feedback}</small> : <div>{(['helpful', 'not_helpful', 'incorrect'] as const).map(value => <button key={value} disabled={busy} onClick={() => void run(async () => { await api.submitFeedback({ eventId: event.eventId, feedback: value }); })}>{value === 'helpful' ? '有帮助' : value === 'not_helpful' ? '无帮助' : '不正确'}</button>)}</div>}</article>)}
      {usage.length > 0 && usage.length < 5 && <small>样本不足 5 条，不展示效果趋势。</small>}
      {!usage.length && <small>当前会话暂无 Skill 使用事件。</small>}
    </div>
  </section>;
}

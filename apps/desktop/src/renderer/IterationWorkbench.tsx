import { useEffect, useState } from 'react';
import type { FieldMapping, MappingConversionResult, MappingJobSelection, MappingJobView, MappingParseOptions, MappingRun, MappingSourcePreview, Project, ProjectAssertionStatus, ProjectContextSnapshot, ProjectDecision, ProjectFact, ProjectResourceLink, ProjectWorkspaceContext, Session } from '../../../../packages/domain/src';
import { Icon } from './ui';
import { TaskGovernancePanel, type TaskGovernancePanelProps } from './TaskGovernancePanel';
import { ImpactAnalysisPanel } from './ImpactAnalysisPanel';
import { DeliveryPanel } from './DeliveryPanel';
import './iteration-workbench.css';

type Pane = 'context' | 'mapping' | 'plan' | 'impact' | 'delivery';
type ContextData = { workspace?: ProjectWorkspaceContext; resources: ProjectResourceLink[]; facts: ProjectFact[]; decisions: ProjectDecision[] };
type Props = { project?: Project; session?: Session; runActive?: boolean; initialPane?: Pane; initialMappingSelection?: MappingJobSelection; launchKey?: number; onExecuteStep?: TaskGovernancePanelProps['onExecuteStep']; onResume?: TaskGovernancePanelProps['onResume'] };
const assertionLabels: Record<ProjectAssertionStatus, string> = { proposed: '草稿待确认', confirmed: '已确认', rejected: '已驳回', superseded: '已被替代' };
const resourceLabels: Record<ProjectResourceLink['status'], string> = { active: '有效', superseded: '已有新版本', unavailable: '来源失效／待重新关联', archived: '已归档' };
const ruleKeys = new Set(['trim', 'uppercase', 'lowercase', 'prefix', 'suffix', 'replaceFrom', 'replaceTo', 'constant', 'defaultValue', 'joinKeys', 'separator', 'splitDelimiter', 'splitIndex', 'enumMap', 'multiplier', 'decimals', 'type', 'required', 'maxLength', 'min', 'max', 'allowedValues', 'unique', 'skipReason']);

/** 项目切换时卸载内部状态，防止旧客户源文件和映射留在另一个项目中。 */
export function IterationWorkbench(props: Props) {
  if (!props.project) return <div className="inspector-empty"><strong>选择本地项目后使用 0.7 工作台</strong><p>资料、规则与转换历史按当前项目隔离保存。</p></div>;
  return <ProjectWorkbench key={`${props.project.id}-${props.launchKey ?? 0}`} {...props} project={props.project} />;
}
function ProjectWorkbench({ project, session, runActive, initialPane, initialMappingSelection, onExecuteStep, onResume }: Props & { project: Project }) {
  const api = window.jinggong.iteration;
  const [pane, setPane] = useState<Pane>(initialPane ?? 'context');
  const [busy, setBusy] = useState('');
  const [feedback, setFeedback] = useState('');
  const [context, setContext] = useState<ContextData | null>(null);
  const [contextText, setContextText] = useState('');
  const [snapshot, setSnapshot] = useState<ProjectContextSnapshot>();
  const [form, setForm] = useState({ name: project.name, customerName: '', systemType: 'MES6' as ProjectWorkspaceContext['systemType'], versions: '', stage: '需求分析', owner: '', projectCode: '', description: '' });
  const [factTitle, setFactTitle] = useState('');
  const [factContent, setFactContent] = useState('');
  const [decisionTitle, setDecisionTitle] = useState('');
  const [decisionText, setDecisionText] = useState('');
  const [selection, setSelection] = useState<MappingJobSelection>(initialMappingSelection ?? { systemType: 'MES6', dataType: '' });
  const [jobId, setJobId] = useState('');
  const [source, setSource] = useState<MappingSourcePreview | null>(null);
  const [template, setTemplate] = useState<MappingSourcePreview | null>(null);
  const [mappings, setMappings] = useState<FieldMapping[]>([]);
  const [ruleDrafts, setRuleDrafts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<MappingConversionResult>();
  const [warningsConfirmed, setWarningsConfirmed] = useState(false);
  const [history, setHistory] = useState<Array<{ job: MappingJobView; runs: MappingRun[] }>>([]);

  function acceptContext(value: ContextData) {
    setContext(value);
    if (value.workspace) {
      const item = value.workspace;
      setForm({ name: item.name, customerName: item.customerName ?? '', systemType: item.systemType, versions: item.productVersions.join(', '), stage: item.stage, owner: item.owner ?? '', projectCode: item.projectCode ?? '', description: item.description ?? '' });
      if (!jobId && !initialMappingSelection) setSelection(current => ({ ...current, ...(item.systemType !== 'OTHER' ? { systemType: item.systemType } : {}), productVersion: item.productVersions[0] ?? '' }));
    }
  }
  useEffect(() => {
    let alive = true;
    if (!api) return;
    void Promise.all([api.getProjectContext(project.id), api.mappingHistory(project.id)]).then(([value, items]) => { if (alive) { acceptContext(value); setHistory(items); } }).catch(reason => { if (alive) setFeedback(errorText(reason)); });
    return () => { alive = false; };
  }, [api, project.id]);
  const warnings = [...(source?.warnings ?? []).map(item => `源文件：${item}`), ...(template?.warnings ?? []).map(item => `目标模板：${item}`)];
  async function run(key: string, action: () => Promise<void>) {
    setBusy(key); setFeedback('');
    try { await action(); } catch (reason) { setFeedback(errorText(reason)); }
    finally { setBusy(''); }
  }
  async function refreshContext() { if (api) acceptContext(await api.getProjectContext(project.id)); }
  async function refreshHistory() { if (api) setHistory(await api.mappingHistory(project.id)); }
  async function saveWorkspace(status = context?.workspace?.status ?? 'active') {
    if (!api) return;
    const { versions, ...input } = form;
    const saved = await api.saveProjectContext(project.id, { ...input, name: form.name.trim() || project.name, stage: form.stage.trim() || '未设置', productVersions: versions.split(/[,，\n]/).map(value => value.trim()).filter(Boolean), status });
    setContext(current => ({ resources: current?.resources ?? [], facts: current?.facts ?? [], decisions: current?.decisions ?? [], workspace: saved }));
    setFeedback(status === 'archived' ? '项目上下文已归档，历史任务与交付证据保留。' : '项目工作区信息已保存。');
  }
  async function addFact(status: ProjectAssertionStatus) {
    if (!api) return;
    await api.saveProjectFact(project.id, { title: factTitle.trim(), content: factContent.trim(), category: '用户录入', status, sourceRefs: [], ...(status === 'confirmed' ? { confirmedAt: new Date().toISOString() } : {}) });
    setFactTitle(''); setFactContent(''); await refreshContext(); setFeedback(status === 'confirmed' ? '用户已确认项目事实入库。' : '事实草稿已保存，不会默认注入上下文。');
  }
  async function factStatus(fact: ProjectFact, status: ProjectAssertionStatus) {
    if (!api) return;
    const { projectId, createdAt, updatedAt, ...input } = fact;
    await api.saveProjectFact(project.id, { ...input, status, confirmedAt: status === 'confirmed' ? new Date().toISOString() : undefined });
    await refreshContext(); setContextText(''); setSnapshot(undefined);
  }
  async function addDecision(status: ProjectAssertionStatus) {
    if (!api) return;
    await api.saveProjectDecision(project.id, { title: decisionTitle.trim(), decision: decisionText.trim(), status, sourceRefs: [], ...(status === 'confirmed' ? { decisionAt: new Date().toISOString() } : {}) });
    setDecisionTitle(''); setDecisionText(''); await refreshContext(); setFeedback(status === 'confirmed' ? '用户已确认项目决策入库。' : '决策草稿已保存，不会默认注入上下文。');
  }
  async function decisionStatus(decision: ProjectDecision, status: ProjectAssertionStatus) {
    if (!api) return;
    const { projectId, createdAt, updatedAt, ...input } = decision;
    await api.saveProjectDecision(project.id, { ...input, status, decisionAt: status === 'confirmed' ? new Date().toISOString() : undefined });
    await refreshContext(); setContextText(''); setSnapshot(undefined);
  }
  async function resourceStatus(resource: ProjectResourceLink, status: ProjectResourceLink['status']) {
    if (!api) return;
    await api.saveProjectResource(project.id, { id: resource.id, resourceType: resource.resourceType, resourceId: resource.resourceId, displayName: resource.displayName, versionLabel: resource.versionLabel, sourceSha256: resource.sourceSha256, status });
    await refreshContext();
  }
  function resetMappings() { setMappings([]); setRuleDrafts({}); setResult(undefined); setWarningsConfirmed(false); }
  function acceptMappings(items: FieldMapping[]) { setMappings(items); setRuleDrafts(Object.fromEntries(items.map(item => [item.id, JSON.stringify(item.transformDsl, null, 2)]))); setResult(undefined); }
  function parsedRules(mapping: FieldMapping): Record<string, unknown> {
    const text = ruleDrafts[mapping.id] ?? JSON.stringify(mapping.transformDsl);
    if (text.length > 24000) throw new Error(`字段“${mapping.targetFieldLabel}”规则过长`);
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new Error(`字段“${mapping.targetFieldLabel}”的规则不是有效 JSON`); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('转换规则必须是 JSON 对象');
    for (const key of Object.keys(value)) if (!ruleKeys.has(key)) throw new Error(`字段“${mapping.targetFieldLabel}”包含不支持的规则：${key}`);
    return value as Record<string, unknown>;
  }
  function materializeMappings() { return mappings.map(item => ({ ...item, transformDsl: parsedRules(item) })); }
  function confirmMappings() {
    setMappings(materializeMappings().map(item => ({ ...item, status: item.sourceColumnKey || item.transformDsl.constant !== undefined || item.transformDsl.defaultValue !== undefined || item.transformDsl.joinKeys || item.transformDsl.skipReason ? 'confirmed' : 'unmapped' })));
    setFeedback('已确认有源列或独立规则的映射；未匹配且无规则的字段仍阻止导出。');
  }
  async function selectSource() {
    if (!api) return;
    const selected = await api.selectMappingSource({ ...selection, projectId: project.id });
    if (!selected) return;
    setJobId(selected.job.id); setSource(selected.preview); setTemplate(null); resetMappings(); await refreshHistory();
  }
  async function selectTemplate() {
    if (!api || !jobId) return;
    const selected = await api.selectMappingTemplate(jobId);
    if (!selected) return;
    setTemplate(selected.preview); resetMappings(); setFeedback(`已读取真实模板的 ${selected.preview.columns.length} 个目标字段。`);
  }
  async function reparse(kind: 'source' | 'template', options: MappingParseOptions) {
    if (!api || !jobId) return;
    const preview = await api.reparseMapping({ jobId, kind, options });
    if (kind === 'source') setSource(preview); else setTemplate(preview);
    resetMappings(); setFeedback('已重新解析所选工作表与行号，旧映射已清空，请重新核对。');
  }
  async function convert(format: 'csv' | 'xlsx') {
    if (!api || !jobId) return;
    const applied = materializeMappings();
    const converted = await api.convertMapping({ jobId, mappings: applied, format, warningsConfirmed });
    setMappings(applied); setResult(converted); await refreshHistory();
    setFeedback(converted.run.status === 'passed' && converted.run.outputPath ? `转换完成：${converted.run.successCount}/${converted.run.rowCount} 行，可打开结果目录。` : `校验存在 ${converted.run.errorCount} 项错误，未生成导入文件，错误明细与规则报告已保留。`);
  }
  if (!api) return <div className="inspector-empty"><strong>第二迭代 IPC 尚未就绪</strong><p>请重新启动最新应用。</p></div>;
  const tabs: Array<{ key: Pane; label: string }> = [{ key: 'context', label: '项目上下文' }, { key: 'mapping', label: '数据映射' }, { key: 'plan', label: '任务计划' }, { key: 'impact', label: '影响审查' }, { key: 'delivery', label: '交付包' }];
  return <div className="iteration-workbench">
    <header className="iteration-heading"><h3>0.7 工作台</h3><p>{project.name}{context?.workspace?.status === 'archived' ? ' · 上下文已归档' : ''}</p></header>
    <div className="iteration-tabs" role="group" aria-label="0.7工作台功能">{tabs.map(tab => <button key={tab.key} className={pane === tab.key ? 'active' : ''} aria-pressed={pane === tab.key} onClick={() => { setPane(tab.key); setFeedback(''); }}>{tab.label}</button>)}</div>
    {feedback && <div className="iteration-feedback" role="status">{feedback}</div>}
    {pane === 'context' && <div className="iteration-body">
      <section><h4>项目工作区</h4>{([{ key: 'name', label: '项目名称', max: 160 }, { key: 'customerName', label: '客户名称', max: 160 }, { key: 'versions', label: '产品版本（逗号分隔）', max: 1000 }, { key: 'stage', label: '当前阶段', max: 80 }, { key: 'projectCode', label: '项目编号', max: 100 }, { key: 'owner', label: '负责人', max: 120 }] as const).map(field => <label key={field.key}>{field.label}<input value={form[field.key]} onChange={event => setForm(current => ({ ...current, [field.key]: event.target.value }))} maxLength={field.max} /></label>)}<label>系统<select value={form.systemType} onChange={event => setForm(current => ({ ...current, systemType: event.target.value as ProjectWorkspaceContext['systemType'] }))}><option value="MES5">MES5</option><option value="MES6">MES6</option><option value="WMS">WMS</option><option value="OTHER">其他</option></select></label><label>项目说明<textarea value={form.description} onChange={event => setForm(current => ({ ...current, description: event.target.value }))} maxLength={4000} /></label><div className="iteration-export-actions"><button className="primary-button" disabled={!!busy} onClick={() => void run('workspace', () => saveWorkspace())}>保存项目资料</button>{context?.workspace && <button className="secondary-button" disabled={!!busy} onClick={() => void run('archive', () => saveWorkspace(context.workspace?.status === 'archived' ? 'active' : 'archived'))}>{context.workspace.status === 'archived' ? '恢复项目上下文' : '归档项目上下文'}</button>}<button className="secondary-button" disabled={!!busy || !context?.workspace} onClick={() => void run('export-config', async () => { if (await api.exportProjectConfig(project.id)) setFeedback('配置 JSON 已导出，不含客户原始文件。'); })}>导出配置 JSON</button><button className="secondary-button" disabled={!!busy} onClick={() => void run('import-config', async () => { const value = await api.importProjectConfig(project.id); if (value) { await refreshContext(); setFeedback(`已导入待确认副本：事实 ${value.facts}、决策 ${value.decisions}、资料 ${value.resources}。资料需重新关联。`); } })}>导入配置副本</button></div></section>
      <section><div className="iteration-section-heading"><h4>当前项目资料</h4><button className="secondary-button" disabled={!!busy} onClick={() => void run('resource', async () => { if (await api.selectProjectResource(project.id)) { await refreshContext(); setFeedback('资料已按 SHA256 关联到当前项目。'); } })}>关联本地资料</button></div>{!context?.resources.length && <p className="iteration-muted">暂无资料。关联后保留来源与指纹，默认只用于本项目。</p>}{context?.resources.map(resource => <div className="iteration-record" key={resource.id}><strong>{resource.displayName}</strong><small>{resource.resourceType} · {resource.versionLabel ?? '未标记版本'} · {resourceLabels[resource.status]}</small>{resource.sourceSha256 && <code className="iteration-hash">SHA256 {resource.sourceSha256}</code>}<select aria-label={`${resource.displayName}的资料状态`} disabled={!!busy || resource.status === 'unavailable'} value={resource.status} onChange={event => void run(`resource-${resource.id}`, () => resourceStatus(resource, event.target.value as ProjectResourceLink['status']))}>{Object.entries(resourceLabels).map(([status, label]) => <option key={status} value={status} disabled={status === 'unavailable'}>{label}</option>)}</select>{resource.status === 'unavailable' && <small>源文件丢失、内容变化或导入后未绑定，请重新关联正确文件。</small>}</div>)}</section>
      <section><h4>项目事实与决策台账</h4><p className="iteration-muted">草稿、驳回和被替代记录不默认注入上下文；只有用户明确确认后生效。</p><label>事实标题<input value={factTitle} onChange={event => setFactTitle(event.target.value)} maxLength={240} /></label><label>事实内容<textarea rows={2} value={factContent} onChange={event => setFactContent(event.target.value)} maxLength={12000} /></label><div className="iteration-export-actions"><button className="secondary-button" disabled={!!busy || !factTitle.trim() || !factContent.trim()} onClick={() => void run('fact-draft', () => addFact('proposed'))}>保存事实草稿</button><button className="secondary-button" disabled={!!busy || !factTitle.trim() || !factContent.trim()} onClick={() => void run('fact-confirm', () => addFact('confirmed'))}>确认事实入库</button></div>{context?.facts.map(fact => <div className="iteration-record" key={fact.id}><strong>{fact.title}</strong><span>{fact.content}</span><select aria-label={`${fact.title}的事实状态`} disabled={!!busy} value={fact.status} onChange={event => void run(`fact-${fact.id}`, () => factStatus(fact, event.target.value as ProjectAssertionStatus))}>{Object.entries(assertionLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select><small>更新 {new Date(fact.updatedAt).toLocaleString()}</small></div>)}<label>决策标题<input value={decisionTitle} onChange={event => setDecisionTitle(event.target.value)} maxLength={240} /></label><label>决策内容<textarea rows={2} value={decisionText} onChange={event => setDecisionText(event.target.value)} maxLength={12000} /></label><div className="iteration-export-actions"><button className="secondary-button" disabled={!!busy || !decisionTitle.trim() || !decisionText.trim()} onClick={() => void run('decision-draft', () => addDecision('proposed'))}>保存决策草稿</button><button className="secondary-button" disabled={!!busy || !decisionTitle.trim() || !decisionText.trim()} onClick={() => void run('decision-confirm', () => addDecision('confirmed'))}>确认决策入库</button></div>{context?.decisions.map(decision => <div className="iteration-record" key={decision.id}><strong>{decision.title}</strong><span>{decision.decision}</span><select aria-label={`${decision.title}的决策状态`} disabled={!!busy} value={decision.status} onChange={event => void run(`decision-${decision.id}`, () => decisionStatus(decision, event.target.value as ProjectAssertionStatus))}>{Object.entries(assertionLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></div>)}</section>
      <section><div className="iteration-section-heading"><h4>实际加载的上下文与来源</h4><button className="secondary-button" disabled={!!busy || !context?.workspace || context.workspace.status === 'archived'} onClick={() => void run('context', async () => { const value = await api.buildProjectContext(project.id, session?.id); setContextText(value.text); setSnapshot(value.snapshot); await refreshContext(); setFeedback(`已核验来源并保存上下文快照，实际选中 ${value.snapshot.selectedSources.length} 个来源。`); })}>刷新来源与上下文</button></div>{contextText ? <pre className="iteration-context-preview">{contextText}</pre> : <p className="iteration-muted">保存项目资料后可预览。预算不足的资料不会进入本次快照。</p>}{snapshot && <details><summary>实际来源与修订（{snapshot.selectedSources.length}）</summary>{snapshot.selectedSources.map((item, index) => <div className="iteration-record" key={index}><strong>{item.sourceType} · {item.sourceId}</strong><span>{item.reason}</span><small>修订 {item.revisionId ?? '未知'} · {item.anchor ?? '无章节锚点'}</small>{item.sha256 && <code className="iteration-hash">{item.sha256}</code>}</div>)}</details>}</section>
    </div>}
    {pane === 'mapping' && <div className="iteration-body">
      <section><h4>1. 选择源数据文件</h4><label>系统<select value={selection.systemType} disabled={!!jobId} onChange={event => setSelection(current => ({ ...current, systemType: event.target.value as MappingJobSelection['systemType'] }))}><option value="MES5">MES5</option><option value="MES6">MES6</option><option value="WMS">WMS</option></select></label><label>产品版本<input value={selection.productVersion ?? ''} disabled={!!jobId} onChange={event => setSelection(current => ({ ...current, productVersion: event.target.value }))} /></label><label>资料类型<input value={selection.dataType} disabled={!!jobId} onChange={event => setSelection(current => ({ ...current, dataType: event.target.value }))} placeholder="例如：物料主数据" maxLength={120} /></label><div className="iteration-export-actions"><button className="secondary-button" disabled={!!busy || !selection.dataType.trim()} onClick={() => void run('source', selectSource)}><Icon name="file" />选择 CSV/XLSX 源文件</button>{jobId && <button className="secondary-button" disabled={!!busy} onClick={() => { setJobId(''); setSource(null); setTemplate(null); resetMappings(); }}>新建转换任务</button>}</div>{source && <FilePreview preview={source} kind="source" busy={!!busy} onReparse={options => void run('source-reparse', () => reparse('source', options))} />}</section>
      <section><h4>2. 使用真实目标模板</h4><p className="iteration-muted">目标字段与顺序来自客户或项目提供的实际模板。</p><button className="secondary-button" disabled={!!busy || !jobId} onClick={() => void run('template', selectTemplate)}><Icon name="file" />选择并解析目标模板</button>{template && <FilePreview preview={template} kind="template" busy={!!busy} onReparse={options => void run('template-reparse', () => reparse('template', options))} />}</section>
      {source && template && <section><div className="iteration-section-heading"><h4>3. 核对映射与转换规则</h4><button className="secondary-button" disabled={!!busy} onClick={() => void run('suggest', async () => { acceptMappings((await api.suggestMappings(jobId)).map(item => item.mapping)); setFeedback('已按字段名相似度生成规则建议，请人工核对后确认。'); })}>生成映射建议</button>{mappings.length > 0 && <button className="secondary-button" disabled={!!busy} onClick={() => void run('confirm-mappings', async () => confirmMappings())}>确认可用建议</button>}</div><p className="iteration-muted">规则仅为受限 JSON 数据，不接受 JavaScript、SQL 或表达式。</p>{mappings.map((mapping, index) => <div className="iteration-rule-card" key={mapping.id}><div className="iteration-mapping-row"><div><strong>{mapping.targetFieldLabel}</strong><small>{mapping.rationale ?? '人工指定'}{mapping.confidence !== undefined ? ` · ${Math.round(mapping.confidence * 100)}%` : ''}</small></div><select aria-label={`${mapping.targetFieldLabel} 的源列`} disabled={!!busy} value={mapping.sourceColumnKey} onChange={event => { const value = event.target.value; setMappings(current => current.map((item, row) => row === index ? { ...item, sourceColumnKey: value, sourceColumnLabel: source.columns.find(column => column.key === value)?.label ?? '', status: 'suggested' } : item)); setResult(undefined); }}><option value="">无源列／独立规则</option>{source.columns.map(column => <option key={column.key} value={column.key}>{column.label} ({column.key})</option>)}</select><select aria-label={`${mapping.targetFieldLabel} 的映射状态`} disabled={!!busy} value={mapping.status} onChange={event => setMappings(current => current.map((item, row) => row === index ? { ...item, status: event.target.value as FieldMapping['status'] } : item))}><option value="suggested">待确认</option><option value="confirmed">人工确认</option><option value="unmapped">未映射</option><option value="rejected">拒绝</option><option value="conflict">有冲突</option></select></div><details><summary>编辑转换与校验规则</summary><p className="iteration-muted">constant 常量；defaultValue 默认；required 必填；type=text/number/integer/date；maxLength 长度；unique 唯一；allowedValues 允许值；enumMap 枚举；joinKeys 拼接源列 key；separator 分隔符；splitDelimiter 拆分符；splitIndex 从 0 起；multiplier 倍数；decimals 小数位；skipReason 明确说明为何跳过。</p><pre className="iteration-rule-example">{'示例：{"trim":true,"required":true,"type":"text","maxLength":40,"unique":true}\n拼接：{"joinKeys":["c1","c2"],"separator":"-"}\n枚举：{"enumMap":{"启用":"1","停用":"0"}}\n常量：{"constant":"KG"}；换算：{"type":"number","multiplier":1000,"decimals":2}'}</pre><textarea aria-label={`${mapping.targetFieldLabel} 的规则 JSON`} className="iteration-rule-json" rows={6} disabled={!!busy} value={ruleDrafts[mapping.id] ?? '{}'} onChange={event => { setRuleDrafts(current => ({ ...current, [mapping.id]: event.target.value })); setMappings(current => current.map(item => item.id === mapping.id ? { ...item, status: 'suggested' } : item)); setResult(undefined); }} spellCheck={false} /><button className="secondary-button" disabled={!!busy} onClick={() => void run(`rule-${mapping.id}`, async () => { const transformDsl = parsedRules(mapping); setMappings(current => current.map(item => item.id === mapping.id ? { ...item, transformDsl, status: 'suggested' } : item)); setFeedback('已检查 JSON 语法与规则名称；执行前主进程会严格校验值类型，请重新确认映射。'); })}>检查并应用规则</button></details></div>)}{warnings.length > 0 && <div className="iteration-warning"><strong>文件解析警告</strong><ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul><label className="iteration-checkbox"><input type="checkbox" checked={warningsConfirmed} onChange={event => setWarningsConfirmed(event.target.checked)} />我已核对并接受以上解析警告</label></div>}{mappings.length > 0 && <div className="iteration-export-actions"><button className="primary-button" disabled={!!busy || warnings.length > 0 && !warningsConfirmed} onClick={() => void run('convert-xlsx', () => convert('xlsx'))}>{busy === 'convert-xlsx' ? '校验转换中…' : '校验并导出 XLSX'}</button><button className="secondary-button" disabled={!!busy || warnings.length > 0 && !warningsConfirmed} onClick={() => void run('convert-csv', () => convert('csv'))}>校验并导出 CSV</button></div>}</section>}
      {result && <section><div className="iteration-section-heading"><h4>转换结果与校验报告</h4><button className="secondary-button" disabled={!!busy} onClick={() => void run('open-output', () => api.revealMapping(result.run.id))}>打开结果／错误报告目录</button></div><p className="iteration-muted">成功 {result.run.successCount}/{result.run.rowCount} 行 · 错误 {result.run.errorCount} 项 · 警告 {result.run.warningCount} 项 · 规则版本 {result.run.ruleSetVersion} · {result.run.outputPath ? '已输出导入文件' : '未输出导入文件'}</p>{result.run.outputSha256 && <code className="iteration-hash">输出 SHA256 {result.run.outputSha256}</code>}<SampleTable headers={result.headers} rows={result.preview} label="转换结果预览" />{result.issues.length > 0 && <ul className="iteration-issues">{result.issues.slice(0, 100).map(issue => <li key={issue.id}>{issue.sheetName ? `${issue.sheetName} · ` : ''}{issue.sourceRow ? `源第 ${issue.sourceRow} 行 · ` : ''}{issue.targetField ? `${issue.targetField}：` : ''}{issue.message}</li>)}</ul>}{result.issues.length > 100 && <p className="iteration-muted">仅显示前 100 项，完整问题见错误报告。</p>}</section>}
      <section><div className="iteration-section-heading"><h4>当前项目转换历史</h4><button className="secondary-button" disabled={!!busy} onClick={() => void run('history', refreshHistory)}>刷新历史</button></div>{!history.length && <p className="iteration-muted">暂无转换任务。</p>}{history.map(item => <div className="iteration-record" key={item.job.id}><strong>{item.job.sourceFileName}</strong><small>{item.job.dataType} · {item.job.systemType} · {item.job.status} · {new Date(item.job.updatedAt).toLocaleString()}</small><button className="secondary-button" disabled={!!busy} onClick={() => void run(`restore-${item.job.id}`, async () => { const restored = await api.restoreMapping(item.job.id); setJobId(restored.job.id); setSelection({ projectId: project.id, systemType: restored.job.systemType, dataType: restored.job.dataType, productVersion: restored.job.productVersion }); setSource(restored.source); setTemplate(restored.template ?? null); acceptMappings(restored.mappings); setWarningsConfirmed(false); setFeedback('已重新读取历史任务源文件与模板，请核对指纹、解析警告和映射后导出。'); })}>恢复任务与规则</button>{item.job.id !== jobId && <button className="secondary-button" disabled={!!busy || !jobId || !template} onClick={() => void run(`reuse-${item.job.id}`, async () => { acceptMappings(await api.reuseMappings({jobId,ruleJobId:item.job.id})); setFeedback('已按相同项目、系统、资料类型和模板指纹复用已确认规则，请核对新源列后重新确认。'); })}>复用规则到当前任务</button>}{item.runs.map(record => <div className="iteration-history-run" key={record.id}><span>版本 {record.ruleSetVersion} · {record.successCount}/{record.rowCount} 行 · 错误 {record.errorCount} · {record.status}</span><button className="secondary-button" disabled={!!busy || !record.reportPath && !record.outputPath} onClick={() => void run(`reveal-${record.id}`, () => api.revealMapping(record.id))}>打开本次结果</button></div>)}</div>)}</section>
    </div>}
    {pane === 'plan' && <TaskGovernancePanel key={session?.id ?? 'no-session'} project={project} taskId={session?.id} runActive={runActive ?? (session?.status === 'running' || session?.status === 'waiting-approval')} onExecuteStep={onExecuteStep} onResume={onResume} />}
    {pane === 'impact' && <ImpactAnalysisPanel key={`${project.id}:${session?.id ?? ''}`} project={project} sessionId={session?.id} api={window.jinggong.impactReview} />}
    {pane === 'delivery' && <DeliveryPanel key={`${project.id}:${session?.id ?? ''}`} project={project} session={session} />}
  </div>;
}
function FilePreview({ preview, kind, busy, onReparse }: { preview: MappingSourcePreview; kind: 'source' | 'template'; busy: boolean; onReparse: (options: MappingParseOptions) => void }) {
  const [sheetName, setSheetName] = useState(preview.sheetName);
  const [headerRow, setHeaderRow] = useState((preview.headerRow ?? 0) + 1);
  const [dataStartRow, setDataStartRow] = useState((preview.dataStartRow ?? 1) + 1);
  useEffect(() => { setSheetName(preview.sheetName); setHeaderRow((preview.headerRow ?? 0) + 1); setDataStartRow((preview.dataStartRow ?? 1) + 1); }, [preview]);
  return <div className="iteration-file-preview"><strong>{preview.fileName}</strong><code className="iteration-hash">SHA256 {preview.digest}</code><small>{preview.sheetName} · {preview.totalRows} 行 · {preview.columns.length} 列 · 忽略隐藏行 {preview.hiddenRowsIgnored}</small><details><summary>工作表、表头与数据起始行</summary><label>工作表<select value={sheetName} disabled={busy} onChange={event => setSheetName(event.target.value)}>{(preview.sheets?.length ? preview.sheets : [{ name: preview.sheetName, hidden: false }]).map(sheet => <option key={sheet.name} value={sheet.name} disabled={sheet.hidden}>{sheet.name}{sheet.hidden ? '（隐藏）' : ''}</option>)}</select></label><label>表头所在行（从 1 起）<input type="number" min={1} max={10000} value={headerRow} onChange={event => setHeaderRow(Number(event.target.value))} /></label><label>数据起始行（从 1 起）<input type="number" min={headerRow + 1} max={100000} value={dataStartRow} onChange={event => setDataStartRow(Number(event.target.value))} /></label><button className="secondary-button" disabled={busy || !Number.isInteger(headerRow) || !Number.isInteger(dataStartRow) || headerRow < 1 || dataStartRow <= headerRow} onClick={() => onReparse({ sheetName, headerRow: headerRow - 1, dataStartRow: dataStartRow - 1 })}>重新解析{kind === 'source' ? '源文件' : '目标模板'}</button><p className="iteration-muted">重新解析会清空旧映射，防止列位置变化后误用规则。</p></details>{preview.warnings?.length ? <ul className="iteration-preview-warnings">{preview.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul> : null}<SampleTable headers={preview.columns.map(column => `${column.label} (${column.key})`)} rows={preview.rows} sourceRows={preview.sourceRowNumbers} label={kind === 'source' ? '源数据样本' : '模板样本'} /></div>;
}
function SampleTable({ headers, rows, sourceRows, label }: { headers: string[]; rows: string[][]; sourceRows?: number[]; label: string }) {
  return <details className="iteration-sample"><summary>{label}（前 {Math.min(rows.length, 20)} 行{headers.length > 40 ? '、前 40 列' : ''}）</summary><div className="iteration-table-scroll"><table><thead><tr>{sourceRows && <th>源行</th>}{headers.slice(0, 40).map((header, index) => <th key={index}>{header}</th>)}</tr></thead><tbody>{rows.slice(0, 20).map((row, index) => <tr key={index}>{sourceRows && <td>{sourceRows[index] ?? '未知'}</td>}{headers.slice(0, 40).map((_, column) => <td key={column}>{row[column] ?? ''}</td>)}</tr>)}</tbody></table></div>{rows.length === 0 && <p className="iteration-muted">没有业务样本行，模板仍可读取表头字段。</p>}</details>;
}
function errorText(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }

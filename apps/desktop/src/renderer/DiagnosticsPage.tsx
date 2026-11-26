import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DiagnosticAnalysisPreview, DiagnosticApi, DiagnosticCase, DiagnosticCaseDetails, DiagnosticCaseStatus, DiagnosticCategory, DiagnosticKnowledgeCase, DiagnosticPriority, DiagnosticProduct, DiagnosticRunKind, DiagnosticStep, DiagnosticStepStatus, DiagnosticTriageConfirmation } from '../../../../packages/domain/src/diagnostics';
import { Icon } from './ui';
import './diagnostics.css';

type View = 'overview' | 'cases' | 'knowledge';
const statusLabels: Record<DiagnosticCaseStatus, string> = { new: '新建', triaging: '分诊中', awaiting_input: '待补充信息', diagnosing: '排查中', awaiting_customer: '等待客户', awaiting_development: '等待开发', pending_verification: '待验证', resolved: '已解决', closed: '已关闭', reopened: '已重开', cancelled: '已取消' };
const productLabels: Record<DiagnosticProduct, string> = { MES5: 'MES5', MES6: 'MES6', WMS: 'WMS', OTHER: '其他系统' };
const priorityLabels: Record<DiagnosticPriority, string> = { critical: '严重', high: '高', medium: '中', low: '低' };
const categoryLabels: Record<DiagnosticCategory, string> = { business: '业务流程', configuration: '配置', data: '基础数据', permission: '权限', integration: '接口集成', defect: '程序缺陷', performance: '性能', environment: '环境部署', operation: '操作', other: '其他', unknown: '未知' };
const stepStatusLabels: Record<DiagnosticStepStatus, string> = { pending: '待处理', in_progress: '处理中', confirmed_normal: '确认正常', confirmed_abnormal: '确认异常', inconclusive: '结果不确定', not_applicable: '不适用', blocked: '阻塞' };
const runTaskLabels: Record<DiagnosticRunKind, string> = { triage: '智能分诊', plan: '生成排查计划', replan: '根据反馈调整计划', root_cause: '分析根因候选' };
const allowedTransitions: Record<DiagnosticCaseStatus, DiagnosticCaseStatus[]> = {
  new: ['triaging', 'cancelled'], triaging: ['awaiting_input', 'diagnosing', 'new', 'cancelled'], awaiting_input: ['triaging', 'diagnosing', 'cancelled', 'reopened'],
  diagnosing: ['awaiting_input', 'awaiting_customer', 'awaiting_development', 'pending_verification', 'resolved', 'cancelled', 'reopened'],
  awaiting_customer: ['diagnosing', 'pending_verification', 'cancelled', 'reopened'], awaiting_development: ['diagnosing', 'pending_verification', 'cancelled', 'reopened'],
  pending_verification: ['resolved', 'diagnosing', 'reopened', 'cancelled'], resolved: ['closed', 'reopened', 'diagnosing'], closed: ['reopened'],
  reopened: ['triaging', 'diagnosing', 'cancelled'], cancelled: ['reopened'],
};
const optionalValue = (data: FormData, key: string) => String(data.get(key) ?? '').trim() || undefined;
const dateLabel = (value: string) => new Date(value).toLocaleString();
const byteLabel = (value: number) => value >= 1024 * 1024 ? `${(value / 1024 / 1024).toFixed(1)} MiB` : `${Math.max(1, Math.round(value / 1024))} KiB`;
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '操作失败，请重试';

export function DiagnosticsPage({ api, onClose }: { api: DiagnosticApi; onClose: () => void }) {
  const [view, setView] = useState<View>('overview');
  const [overview, setOverview] = useState<Awaited<ReturnType<DiagnosticApi['overview']>> | null>(null);
  const [cases, setCases] = useState<DiagnosticCase[]>([]);
  const [details, setDetails] = useState<DiagnosticCaseDetails | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const selectedIdRef = useRef('');
  const listSequence = useRef(0);
  const detailSequence = useRef(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<DiagnosticCaseStatus | 'all'>('all');
  const [productFilter, setProductFilter] = useState<DiagnosticProduct | 'all'>('all');
  const [priorityFilter, setPriorityFilter] = useState<DiagnosticPriority | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<DiagnosticCategory | 'all'>('all');
  const [moduleFilter, setModuleFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [reporterFilter, setReporterFilter] = useState('');
  const [sortBy, setSortBy] = useState<'updated' | 'priority'>('updated');
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [triageConfirmOpen, setTriageConfirmOpen] = useState(false);
  const [section, setSection] = useState<'summary' | 'steps' | 'evidence' | 'root' | 'handoff' | 'timeline'>('summary');
  const [analysisTask, setAnalysisTask] = useState<DiagnosticRunKind>('triage');
  const [preview, setPreview] = useState<DiagnosticAnalysisPreview | null>(null);
  const [evidencePreview, setEvidencePreview] = useState<{ name: string; content: string } | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeResults, setKnowledgeResults] = useState<DiagnosticKnowledgeCase[]>([]);
  const caseListInput = () => ({ query: query.trim() || undefined, status: statusFilter, product: productFilter, priority: priorityFilter, issueCategory: categoryFilter,
    module: moduleFilter.trim() || undefined, assigneeLabel: assigneeFilter.trim() || undefined, reporterLabel: reporterFilter.trim() || undefined,
    sortBy, limit: 100 });

  async function loadList() {
    const request = ++listSequence.current;
    try {
      const [nextOverview, nextCases] = await Promise.all([
        api.overview(), api.listCases(caseListInput()),
      ]);
      if (request !== listSequence.current) return;
      setOverview(nextOverview); setCases(nextCases);
    } catch (reason) { setError(errorText(reason)); }
    finally { if (request === listSequence.current) setLoading(false); }
  }

  useEffect(() => { void loadList(); }, [query, statusFilter, productFilter, priorityFilter, categoryFilter, moduleFilter, assigneeFilter, reporterFilter, sortBy]);
  useEffect(() => {
    if (!selectedId) { setDetails(null); setEditOpen(false); return; }
    const request = ++detailSequence.current;
    void api.getCase(selectedId).then(next => { if (request === detailSequence.current && selectedIdRef.current === selectedId) setDetails(next); })
      .catch(reason => { if (request === detailSequence.current) setError(errorText(reason)); });
  }, [selectedId]);

  async function reload(selected = selectedId) {
    const [nextOverview, nextCases] = await Promise.all([
      api.overview(), api.listCases(caseListInput()),
    ]);
    setOverview(nextOverview); setCases(nextCases);
    if (selected && selectedIdRef.current === selected) setDetails(await api.getCase(selected));
  }

  async function perform(action: () => Promise<unknown>, message?: string, refresh = true) {
    setBusy(true); setError(''); setNotice('');
    try { await action(); if (refresh) await reload(); if (message) setNotice(message); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  function selectCase(id: string) {
    selectedIdRef.current = id; setSelectedId(id); setPreview(null); setEvidencePreview(null); setTriageConfirmOpen(false); setError(''); setNotice(''); setView('cases'); setSection('summary');
  }

  function openCreate() {
    setCreateOpen(true);
  }

  async function createCase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const occurredAt = optionalValue(data, 'occurredAt');
    const input = {
      title: String(data.get('title') ?? '').trim(), symptom: String(data.get('symptom') ?? '').trim(),
      expectedResult: optionalValue(data, 'expectedResult'), actualResult: optionalValue(data, 'actualResult'), reproduceSteps: optionalValue(data, 'reproduceSteps'),
      product: String(data.get('product')) as DiagnosticProduct, productVersion: optionalValue(data, 'productVersion'), module: optionalValue(data, 'module'),
      businessProcess: optionalValue(data, 'businessProcess'), issueCategory: String(data.get('issueCategory') ?? 'unknown') as DiagnosticCategory,
      priority: String(data.get('priority') ?? 'medium') as DiagnosticPriority, occurredAt: occurredAt ? new Date(occurredAt).toISOString() : undefined,
      frequency: optionalValue(data, 'frequency'), impactScope: optionalValue(data, 'impactScope'), environment: optionalValue(data, 'environment'),
      assigneeLabel: optionalValue(data, 'assigneeLabel'), reporterLabel: optionalValue(data, 'reporterLabel'),
    };
    setBusy(true); setError('');
    try {
      const created = await api.createCase(input);
      setCreateOpen(false); selectedIdRef.current = created.id; setSelectedId(created.id); setView('cases');
      await reload(created.id); setNotice(`已创建 ${created.code}`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function saveEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!details) return;
    const data = new FormData(event.currentTarget), occurredAt = optionalValue(data, 'occurredAt');
    const patch = {
      title: String(data.get('title') ?? '').trim(), symptom: String(data.get('symptom') ?? '').trim(), expectedResult: optionalValue(data, 'expectedResult'),
      actualResult: optionalValue(data, 'actualResult'), reproduceSteps: optionalValue(data, 'reproduceSteps'), product: String(data.get('product') ?? details.case.product) as DiagnosticProduct,
      productVersion: optionalValue(data, 'productVersion'), module: optionalValue(data, 'module'), businessProcess: optionalValue(data, 'businessProcess'),
      issueCategory: String(data.get('issueCategory') ?? details.case.issueCategory) as DiagnosticCategory, priority: String(data.get('priority') ?? details.case.priority) as DiagnosticPriority,
      occurredAt: occurredAt ? new Date(occurredAt).toISOString() : undefined, frequency: optionalValue(data, 'frequency'), impactScope: optionalValue(data, 'impactScope'), environment: optionalValue(data, 'environment'),
      assigneeLabel: optionalValue(data, 'assigneeLabel'), reporterLabel: optionalValue(data, 'reporterLabel'),
    };
    await perform(() => api.updateCase(details.case.id, patch), '问题信息已保存');
    setEditOpen(false);
  }

  async function confirmTriage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!details) return;
    const data = new FormData(event.currentTarget), input: DiagnosticTriageConfirmation = {};
    if (data.get('apply_product') === 'on') input.product = String(data.get('product')) as DiagnosticProduct;
    if (data.get('apply_productVersion') === 'on') input.productVersion = String(data.get('productVersion') ?? '').trim();
    if (data.get('apply_module') === 'on') input.module = String(data.get('module') ?? '').trim();
    if (data.get('apply_businessProcess') === 'on') input.businessProcess = String(data.get('businessProcess') ?? '').trim();
    if (data.get('apply_issueCategory') === 'on') input.issueCategory = String(data.get('issueCategory')) as DiagnosticCategory;
    if (data.get('apply_priority') === 'on') input.priority = String(data.get('priority')) as DiagnosticPriority;
    if (data.get('apply_impactScope') === 'on') input.impactScope = String(data.get('impactScope') ?? '').trim();
    if (!Object.keys(input).length) { setError('请至少勾选一个需要应用的字段'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await api.applyTriage(details.case.id, input);
      setTriageConfirmOpen(false); await reload(details.case.id); setNotice('已应用人工确认的分诊字段');
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function transition(status: DiagnosticCaseStatus) {
    if (!details) return;
    let reason: string | undefined;
    if (status === 'reopened') { reason = window.prompt('请输入重开原因（至少 10 个字符）') ?? undefined; if (!reason) return; }
    if (status === 'resolved' && !window.confirm('确认将此问题标记为已解决？请确认处理和验证记录完整。')) return;
    if (status === 'closed' && !window.confirm('确认关闭此问题？')) return;
    if (status === 'cancelled' && !window.confirm('确认取消此问题？')) return;
    await perform(() => api.transitionCase(details.case.id, status, reason), `状态已更新为${statusLabels[status]}`);
  }

  async function requestAnalysisPreview(task = analysisTask) {
    if (!details) return;
    setBusy(true); setError(''); setPreview(null);
    try { setPreview(await api.previewAnalysis(details.case.id, task)); }
    catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  async function runAnalysis() {
    if (!details || !preview) return;
    setAnalyzing(true); setError(''); setNotice('');
    try {
      const result = await api.runAnalysis(details.case.id, preview.task, preview.inputSnapshotHash);
      if (selectedIdRef.current === result.case.id) setDetails(result);
      setPreview(null); await reload(result.case.id); setNotice(`${runTaskLabels[preview.task]}已完成`);
    } catch (reason) { setError(errorText(reason)); }
    finally { setAnalyzing(false); }
  }

  async function searchKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const term = knowledgeQuery.trim(); if (!term) return;
    setBusy(true); setError('');
    try {
      const product = details?.case.product ?? (productFilter === 'all' ? 'MES6' : productFilter);
      setKnowledgeResults(await api.searchKnowledgeCases({ product, query: term, deliveryProjectId: details?.case.deliveryProjectId }));
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  const activeCases = cases.filter(item => !['closed', 'cancelled'].includes(item.status));

  return <main className="diagnostics-page">
    <header className="diagnostics-header">
      <div className="diagnostics-brand"><button type="button" className="diagnostics-icon-button" onClick={onClose} title="返回研发工作台" aria-label="返回研发工作台"><Icon name="arrow" /></button><span className="diagnostics-mark"><Icon name="shield" /></span><div><strong>现场问题诊断中心</strong><span>MES · WMS · 现场交付问题</span></div></div>
      <nav className="diagnostics-nav" aria-label="诊断中心视图">
        <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}>总览</button>
        <button className={view === 'cases' ? 'active' : ''} onClick={() => setView('cases')}>问题档案 <span>{cases.length}</span></button>
        <button className={view === 'knowledge' ? 'active' : ''} onClick={() => { setView('knowledge'); setSelectedId(''); selectedIdRef.current = ''; }}>案例库</button>
      </nav>
      <div className="diagnostics-header-actions"><button className="diagnostics-primary" onClick={() => openCreate()}><Icon name="plus" />新建问题</button><button className="diagnostics-icon-button" onClick={() => void loadList()} title="刷新数据" aria-label="刷新数据"><Icon name="refresh" /></button></div>
    </header>
    {(error || notice) && <div className={`diagnostics-feedback ${error ? 'error' : 'success'}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'alert' : 'check'} /><span>{error || notice}</span><button onClick={() => { setError(''); setNotice(''); }} aria-label="关闭提示"><Icon name="close" /></button></div>}
    <div className="diagnostics-body">
      <aside className="diagnostics-rail">
        <div className="diagnostics-rail-heading"><strong>问题档案</strong><span>{cases.length}</span><button className="diagnostics-icon-button" onClick={() => openCreate()} title="创建问题" aria-label="创建问题"><Icon name="plus" /></button></div>
        <label className="diagnostics-search"><Icon name="search" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索编号、标题、现象" /></label>
        <div className="diagnostics-rail-filters">
          <select aria-label="按状态筛选" value={statusFilter} onChange={event => setStatusFilter(event.target.value as DiagnosticCaseStatus | 'all')}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="按产品筛选" value={productFilter} onChange={event => setProductFilter(event.target.value as DiagnosticProduct | 'all')}><option value="all">全部产品</option>{Object.entries(productLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="按优先级筛选" value={priorityFilter} onChange={event => setPriorityFilter(event.target.value as DiagnosticPriority | 'all')}><option value="all">全部优先级</option>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="按问题类别筛选" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value as DiagnosticCategory | 'all')}><option value="all">全部类别</option>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="问题排序" value={sortBy} onChange={event => setSortBy(event.target.value as 'updated' | 'priority')}><option value="updated">最近更新</option><option value="priority">严重程度</option></select>
          <input aria-label="按模块筛选" value={moduleFilter} onChange={event => setModuleFilter(event.target.value)} placeholder="模块" />
          <input aria-label="按负责人筛选" value={assigneeFilter} onChange={event => setAssigneeFilter(event.target.value)} placeholder="负责人" />
          <input aria-label="按创建人筛选" value={reporterFilter} onChange={event => setReporterFilter(event.target.value)} placeholder="创建人" />
        </div>
        <div className="diagnostics-rail-list">
          {loading && <div className="diagnostics-empty">正在读取问题档案…</div>}
          {!loading && !cases.length && <div className="diagnostics-empty">暂无符合条件的问题</div>}
          {cases.map(item => <button key={item.id} className={`diagnostics-case-row ${selectedId === item.id ? 'selected' : ''}`} onClick={() => selectCase(item.id)}>
            <span className={`priority-mark ${item.priority}`} /><span className="diagnostics-case-row-main"><strong>{item.title}</strong><span>{item.code} · {productLabels[item.product]}{item.module ? ` · ${item.module}` : ''}</span><span>{statusLabels[item.status]}</span></span><span className={`status-dot ${item.status}`} title={statusLabels[item.status]} />
          </button>)}
        </div>
        <div className="diagnostics-rail-footer"><span>未关闭</span><strong>{overview?.open ?? 0}</strong><span>严重 / 高</span><strong>{overview?.criticalOrHigh ?? 0}</strong></div>
      </aside>
      <section className="diagnostics-content">
        {view === 'overview' && <Overview overview={overview} cases={activeCases} onSelect={selectCase} onCreate={() => openCreate()} />}
        {view === 'cases' && (details ? <CaseDetail
          api={api} details={details} section={section} setSection={setSection} busy={busy} analyzing={analyzing} preview={preview}
          analysisTask={analysisTask} setAnalysisTask={setAnalysisTask}
          requestAnalysisPreview={requestAnalysisPreview} runAnalysis={runAnalysis} setPreview={setPreview} perform={perform} reload={reload}
          onEdit={() => setEditOpen(true)} onConfirmTriage={() => setTriageConfirmOpen(true)} onTransition={transition} onEvidencePreview={(value) => setEvidencePreview(value)}
          setError={setError} setNotice={setNotice} /> : <div className="diagnostics-empty-panel"><Icon name="file" /><strong>选择一个问题查看诊断记录</strong><button className="diagnostics-primary" onClick={() => openCreate()}><Icon name="plus" />新建问题</button></div>)}
        {view === 'knowledge' && <section className="diagnostics-knowledge-view"><div className="diagnostics-page-title"><div><span>案例库</span><h1>已审核知识案例</h1></div><span>{knowledgeResults.length} 条结果</span></div><form className="diagnostics-knowledge-search" onSubmit={searchKnowledge}><input value={knowledgeQuery} onChange={event => setKnowledgeQuery(event.target.value)} placeholder="输入症状、模块、错误码或根因" /><select aria-label="案例产品" value={productFilter === 'all' ? 'MES6' : productFilter} onChange={event => setProductFilter(event.target.value as DiagnosticProduct)}>{Object.entries(productLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><button className="diagnostics-primary" disabled={busy || !knowledgeQuery.trim()}><Icon name="search" />检索</button></form>{knowledgeResults.length ? <div className="diagnostics-knowledge-results">{knowledgeResults.map(item => <KnowledgeCard key={item.id} item={item} />)}</div> : <div className="diagnostics-empty-panel"><Icon name="search" /><strong>输入关键词检索已审核案例</strong></div>}</section>}
      </section>
    </div>
    {createOpen && <CreateDialog busy={busy} onClose={() => setCreateOpen(false)} onSubmit={createCase} />}
    {editOpen && details && <EditDialog item={details.case} busy={busy} onClose={() => setEditOpen(false)} onSubmit={saveEdit} />}
    {triageConfirmOpen && details?.case.triage && <TriageConfirmDialog item={details.case} busy={busy} onClose={() => setTriageConfirmOpen(false)} onSubmit={confirmTriage} />}
    {evidencePreview && <div className="diagnostics-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setEvidencePreview(null); }}><section className="diagnostics-modal diagnostics-preview-modal" role="dialog" aria-modal="true" aria-labelledby="diagnostics-evidence-preview-title"><header><h2 id="diagnostics-evidence-preview-title">脱敏文本预览 · {evidencePreview.name}</h2><button className="diagnostics-icon-button" onClick={() => setEvidencePreview(null)} aria-label="关闭"><Icon name="close" /></button></header><pre>{evidencePreview.content}</pre></section></div>}
  </main>;
}

function Overview({ overview, cases, onSelect, onCreate }: { overview: Awaited<ReturnType<DiagnosticApi['overview']>> | null; cases: DiagnosticCase[]; onSelect: (id: string) => void; onCreate: () => void }) {
  return <div className="diagnostics-overview">
    <div className="diagnostics-page-title"><div><span>现场问题诊断</span><h1>诊断总览</h1></div><button className="diagnostics-primary" onClick={onCreate}><Icon name="plus" />新建问题</button></div>
    <div className="diagnostics-metrics"><Metric label="全部问题" value={overview?.total ?? 0} tone="neutral" /><Metric label="未关闭" value={overview?.open ?? 0} tone="green" /><Metric label="严重 / 高优先级" value={overview?.criticalOrHigh ?? 0} tone="red" /><Metric label="等待客户" value={overview?.awaitingCustomer ?? 0} tone="amber" /><Metric label="等待开发" value={overview?.awaitingDevelopment ?? 0} tone="blue" /><Metric label="待验证" value={overview?.pendingVerification ?? 0} tone="violet" /></div>
    <section className="diagnostics-usage-flow" aria-label="现场问题诊断使用流程"><strong>使用流程</strong><ol><li><span>01</span><div><b>登记问题</b><small>选择产品系统，描述现场问题和影响范围</small></div></li><li><span>02</span><div><b>补充现场信息</b><small>完善现象、复现步骤、预期与实际结果，并整理证据</small></div></li><li><span>03</span><div><b>分析并核验</b><small>查看发送预览后运行分析，按建议补充验证结果</small></div></li><li><span>04</span><div><b>记录结论</b><small>更新处理状态，审核可复用的问题案例</small></div></li></ol></section>
    <div className="diagnostics-overview-columns"><section className="diagnostics-section"><header><div><strong>最近处理</strong><span>按最后更新时间</span></div><button className="diagnostics-text-button" onClick={() => cases[0] && onSelect(cases[0].id)}>打开问题列表</button></header>{overview?.recent.length ? <CaseTable items={overview.recent} onSelect={onSelect} /> : <EmptyInline text="暂无记录" />}</section><section className="diagnostics-section"><header><div><strong>最近关闭</strong><span>可整理为复用案例</span></div></header>{overview?.recentClosed.length ? <CaseTable items={overview.recentClosed} onSelect={onSelect} /> : <EmptyInline text="暂无已关闭问题" />}</section></div>
    <div className="diagnostics-overview-bottom"><span>待审核案例</span><strong>{overview?.knowledgeReview ?? 0}</strong><span>当前筛选下问题</span><strong>{cases.length}</strong></div>
  </div>;
}

function deliveryIssueStatusLabel(value: string): string {
  return ({ open: '未解决', in_progress: '处理中', pending_customer: '等待客户', resolved: '已解决', closed: '已关闭' } as Record<string, string>)[value] ?? value;
}

function deliveryProjectStatusLabel(value: string): string {
  return ({ active: '进行中', on_hold: '暂停', completed: '已完成', archived: '已归档' } as Record<string, string>)[value] ?? value;
}

function Metric({ label, value, tone }: { label: string; value: number; tone: string }) { return <div className={`diagnostics-metric ${tone}`}><span>{label}</span><strong>{value}</strong></div>; }
function EmptyInline({ text }: { text: string }) { return <div className="diagnostics-empty-inline">{text}</div>; }
function CaseTable({ items, onSelect }: { items: DiagnosticCase[]; onSelect: (id: string) => void }) { return <div className="diagnostics-table">{items.map(item => <button key={item.id} onClick={() => onSelect(item.id)}><span className={`priority-mark ${item.priority}`} /><span><strong>{item.title}</strong><small>{item.code} · {productLabels[item.product]} · {statusLabels[item.status]}</small></span><small>{dateLabel(item.updatedAt)}</small></button>)}</div>; }

function CaseDetail({ api, details, section, setSection, busy, analyzing, preview, analysisTask, setAnalysisTask, requestAnalysisPreview, runAnalysis, setPreview, perform, reload, onEdit, onConfirmTriage, onTransition, onEvidencePreview, setError, setNotice }: {
  api: DiagnosticApi; details: DiagnosticCaseDetails; section: 'summary' | 'steps' | 'evidence' | 'root' | 'handoff' | 'timeline'; setSection: (value: 'summary' | 'steps' | 'evidence' | 'root' | 'handoff' | 'timeline') => void;
  busy: boolean; analyzing: boolean; preview: DiagnosticAnalysisPreview | null; analysisTask: DiagnosticRunKind; setAnalysisTask: (value: DiagnosticRunKind) => void;
  requestAnalysisPreview: (task?: DiagnosticRunKind) => Promise<void>; runAnalysis: () => Promise<void>; setPreview: (value: DiagnosticAnalysisPreview | null) => void;
  perform: (action: () => Promise<unknown>, message?: string, refresh?: boolean) => Promise<void>; reload: (selected?: string) => Promise<void>; onEdit: () => void; onConfirmTriage: () => void; onTransition: (status: DiagnosticCaseStatus) => Promise<void>;
  onEvidencePreview: (value: { name: string; content: string }) => void; setError: (value: string) => void; setNotice: (value: string) => void;
}) {
  const item = details.case;
  const currentSteps = details.steps.filter(step => step.planRevision === item.planRevision);
  const resolution = details.resolutions[0];
  const evidence = details.evidence.filter(file => file.status !== 'deleted');
  const currentKnowledge = details.knowledgeCases[0];


  async function analyzeAfterFeedback() {
    const result = await api.previewAnalysis(item.id, 'replan');
    setAnalysisTask('replan'); setPreview(result);
  }

  async function submitStep(event: FormEvent<HTMLFormElement>, step: DiagnosticStep) {
    event.preventDefault(); const data = new FormData(event.currentTarget), status = String(data.get('status')) as DiagnosticStepStatus;
    await perform(() => api.submitStepResult(item.id, step.id, { status, resultText: optionalValue(data, 'resultText'), resultBy: optionalValue(data, 'resultBy'), reason: optionalValue(data, 'reason'), evidenceIds: data.getAll('evidenceIds').map(String) }), '现场反馈已保存');
  }

  async function submitHypothesis(event: FormEvent<HTMLFormElement>, hypothesisId: string) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    await perform(() => api.updateHypothesis(item.id, hypothesisId, { status: String(data.get('status')) as DiagnosticCaseDetails['hypotheses'][number]['status'], confirmedBy: optionalValue(data, 'confirmedBy') }), '根因候选状态已更新');
  }

  async function submitResolution(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const data = new FormData(event.currentTarget);
    const verificationResult = String(data.get('verificationResult')) as NonNullable<typeof resolution>['verificationResult'];
    if (verificationResult === 'not_run' && data.get('acceptRisk') === 'on' && !window.confirm('确认接受未验证风险？该选择将记录到问题审计。')) return;
    const value = {
      rootCauseSummary: String(data.get('rootCauseSummary') ?? '').trim(), rootCauseStatus: String(data.get('rootCauseStatus')) as NonNullable<typeof resolution>['rootCauseStatus'], rootCauseUnknownReason: optionalValue(data, 'rootCauseUnknownReason'),
      resolutionType: String(data.get('resolutionType')) as NonNullable<typeof resolution>['resolutionType'], actionSummary: String(data.get('actionSummary') ?? '').trim(),
      verificationMethod: String(data.get('verificationMethod') ?? '').trim(), verificationResult, verificationNotes: optionalValue(data, 'verificationNotes'), verifiedBy: optionalValue(data, 'verifiedBy'),
      verifiedAt: verificationResult === 'passed' ? new Date().toISOString() : undefined, acceptedUnverifiedRisk: data.get('acceptRisk') === 'on', acceptedRiskReason: optionalValue(data, 'acceptedRiskReason'),
    };
    await perform(() => api.saveResolution(item.id, value), '处理与验证记录已保存');
  }

  async function selectEvidence() { await perform(() => api.selectEvidence(item.id), '证据已添加'); }
  async function showEvidencePreview(file: DiagnosticCaseDetails['evidence'][number]) {
    try { onEvidencePreview({ name: file.originalName, content: await api.readEvidencePreview(item.id, file.id) }); }
    catch (reason) { setError(errorText(reason)); }
  }

  async function saveKnowledgeDraft() {
    const result = await api.prepareKnowledgeCase(item.id);
    await reload(item.id); setNotice('已生成脱敏案例草稿，可在提交前复核');
    if (result.case.id !== item.id) setError('案例草稿与问题档案不匹配');
  }

  const { legacyProject: project, legacyIssue: linkedIssue } = details;
  return <div className="diagnostics-detail">
    <header className="diagnostics-detail-heading"><div><div className="diagnostics-breadcrumb">问题档案 <Icon name="chevron" /> {item.code}</div><h1>{item.title}</h1><div className="diagnostics-detail-meta"><span className={`diagnostics-badge status ${item.status}`}>{statusLabels[item.status]}</span><span className={`diagnostics-badge priority ${item.priority}`}>{priorityLabels[item.priority]}</span><span>{productLabels[item.product]} {item.productVersion || ''}</span>{item.module && <span>{item.module}</span>}<span>更新于 {dateLabel(item.updatedAt)}</span></div></div><div className="diagnostics-detail-actions"><select aria-label="问题状态" value="" disabled={busy || analyzing} onChange={event => { if (event.target.value) void onTransition(event.target.value as DiagnosticCaseStatus); }}><option value="">状态流转…</option>{allowedTransitions[item.status].map(status => <option key={status} value={status}>{statusLabels[status]}</option>)}</select><button className="diagnostics-secondary" onClick={onEdit} disabled={busy || analyzing}><Icon name="edit" />编辑问题</button></div></header>
    <nav className="diagnostics-section-tabs" aria-label="问题详情分类">{[['summary', '概况'], ['steps', `排查步骤 ${currentSteps.length || ''}`], ['evidence', `现场证据 ${evidence.length || ''}`], ['root', '根因与验证'], ['handoff', '开发升级与案例'], ['timeline', '操作时间线']].map(([value, label]) => <button key={value} className={section === value ? 'active' : ''} onClick={() => setSection(value as typeof section)}>{label}</button>)}</nav>
    <div className="diagnostics-detail-workspace"><aside className="diagnostics-detail-aside"><section><h3>问题信息</h3><dl><dt>问题编号</dt><dd>{item.code}</dd><dt>产品系统</dt><dd>{productLabels[item.product]} {item.productVersion || '版本未填写'}</dd><dt>业务模块</dt><dd>{item.module || '未分类'}</dd><dt>业务环节</dt><dd>{item.businessProcess || '未填写'}</dd><dt>问题类型</dt><dd>{categoryLabels[item.issueCategory]}</dd><dt>负责人</dt><dd>{item.assigneeLabel || '未分配'}</dd><dt>创建人</dt><dd>{item.reporterLabel || '未填写'}</dd></dl></section>{project ? <section><h3>历史项目</h3><dl><dt>项目名称</dt><dd>{project.name}</dd><dt>项目编号</dt><dd>{project.code || '未设置'}</dd><dt>客户</dt><dd>{project.customerName}</dd><dt>系统与版本</dt><dd>{project.systemType} · {project.productVersions.join('、') || '未记录'}</dd><dt>阶段</dt><dd>{project.stage}</dd><dt>项目状态</dt><dd>{deliveryProjectStatusLabel(project.status)}</dd><dt>项目经理</dt><dd>{project.projectManager || '未分配'}</dd><dt>交付问题</dt><dd>{linkedIssue ? `${linkedIssue.title} · ${deliveryIssueStatusLabel(linkedIssue.status)}` : item.deliveryIssueId ? '原交付问题已不存在' : '未关联具体交付问题'}</dd></dl></section> : item.deliveryProjectId ? <section><h3>历史项目</h3><p>原项目资料不可用。</p></section> : null}<section><h3>处理流程</h3><div className="diagnostics-run-list">{details.runs.slice(0, 5).map(run => <div key={run.id}><span className={`run-state ${run.status}`} /><span><strong>{runTaskLabels[run.kind]}</strong><small>{run.model || run.runtimeKind || 'Runtime 未知'} · {dateLabel(run.startedAt)}</small></span></div>)}{!details.runs.length && <small>暂无分析记录</small>}</div></section></aside>
      <section className="diagnostics-detail-main">
        {section === 'summary' && <div className="diagnostics-section-stack"><section className="diagnostics-section"><header><div><strong>问题现象</strong><span>现场提交信息</span></div></header><p className="diagnostics-preserve-text">{item.symptom}</p><div className="diagnostics-description-grid"><div><small>期望结果</small><p>{item.expectedResult || '未填写'}</p></div><div><small>实际结果</small><p>{item.actualResult || '未填写'}</p></div><div><small>复现步骤</small><p>{item.reproduceSteps || '未填写'}</p></div><div><small>影响范围</small><p>{item.impactScope || '未填写'}</p></div></div></section>
          {item.triage && <section className="diagnostics-section"><header><div><strong>AI 分诊结果</strong><span>草稿 · 与档案字段分开保存</span></div><button className="diagnostics-secondary" disabled={busy || analyzing} onClick={onConfirmTriage}>核对并应用字段</button></header><p>{item.triage.summary}</p><div className="diagnostics-chip-row"><span>{item.triage.product === 'unknown' ? '产品待确认' : productLabels[item.triage.product]}</span><span>{categoryLabels[item.triage.issueCategory]}</span><span>{item.triage.module || '模块待确认'}</span><span>{item.triage.prioritySuggestion === 'unknown' ? '优先级待确认' : priorityLabels[item.triage.prioritySuggestion]}</span></div>{item.triage.knownFacts.map((fact, index) => <p className="diagnostics-fact" key={index}><Icon name="check" />{fact.text}</p>)}{item.triage.missingInformation.map((missing, index) => <div className="diagnostics-missing" key={index}><strong>待补充 · {missing.question}</strong><span>{missing.whyItMatters}</span></div>)}{item.triage.hypotheses.map((hypothesis, index) => <p className="diagnostics-hypothesis-note" key={index}>假设 · {hypothesis.title}（{hypothesis.confidence}）</p>)}</section>}
          <section className="diagnostics-section"><header><div><strong>相似案例</strong><span>按产品系统检索可见案例</span></div></header><RelatedKnowledge api={api} item={item} cases={details.knowledgeCases} busy={busy} onUse={setNotice} onError={setError} /></section>
        </div>}
        {section === 'steps' && <div className="diagnostics-section-stack"><div className="diagnostics-section-header"><div><strong>排查计划 · 修订 {item.planRevision || 0}</strong><span>当前计划按步骤记录现场结果</span></div><button className="diagnostics-primary" disabled={busy || analyzing} onClick={() => void analyzeAfterFeedback()}><Icon name="refresh" />调整计划</button></div>{!currentSteps.length ? <div className="diagnostics-empty-panel"><Icon name="file" /><strong>尚无排查步骤</strong><span>运行“生成排查计划”后，当前问题的检查步骤会显示在这里。</span><button className="diagnostics-primary" disabled={busy || analyzing} onClick={() => { setAnalysisTask('plan'); void requestAnalysisPreview('plan'); }}><Icon name="plus" />生成排查计划</button></div> : currentSteps.map(step => <form className="diagnostics-step" key={step.id} onSubmit={event => void submitStep(event, step)}><header><span className="diagnostics-step-order">{step.order}</span><div><strong>{step.title}</strong><span>{stepStatusLabels[step.status]} · {step.safetyLevel === 'read_only_ui' ? '只读页面' : step.safetyLevel === 'read_only_evidence' ? '只读证据' : '授权人员手动检查'}</span></div></header><p>{step.purpose}</p><div className="diagnostics-step-detail"><div><small>检查说明</small><p>{step.instructions}</p></div><div><small>前置条件</small><p>{step.preconditions.join('；') || '无'}</p></div><div><small>正常表现</small><p>{step.expectedNormal}</p></div><div><small>异常信号</small><p>{step.abnormalSignals.join('；') || '未提供'}</p></div><div><small>需要记录</small><p>{step.requestedEvidence.join('；') || '现场观察结果'}</p></div></div><div className="diagnostics-source-line">来源：{step.sourceRefs.map(id => details.runs.find(run => run.id === step.runId)?.sourceRefs.find(source => source.sourceId === id)?.sourceName ?? id).join('；') || '未引用内部资料'}</div><div className="diagnostics-step-feedback"><select name="status" aria-label="现场反馈状态" defaultValue={step.status === 'pending' ? 'in_progress' : step.status}>{Object.entries(stepStatusLabels).filter(([value]) => value !== 'pending').map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select><input name="resultBy" defaultValue={step.resultBy} placeholder="工程师姓名" /><input name="resultText" defaultValue={step.resultText} placeholder="实际观察或检查结果" /><input name="reason" defaultValue={step.blockedReason || step.notApplicableReason} placeholder="阻塞 / 不适用原因（如适用）" /><div className="diagnostics-evidence-checks">{evidence.map(file => <label key={file.id}><input type="checkbox" name="evidenceIds" value={file.id} defaultChecked={step.evidenceIds.includes(file.id)} />{file.originalName}</label>)}</div><button className="diagnostics-secondary" disabled={busy}>保存现场反馈</button></div>{step.nextBranches.length > 0 && <div className="diagnostics-branches"><small>下一步分支</small>{step.nextBranches.map((branch, index) => <p key={index}><strong>{branch.when}</strong><span>{branch.nextAction}</span></p>)}</div>}</form>)}</div>}
        {section === 'evidence' && <div className="diagnostics-section-stack"><section className="diagnostics-section"><header><div><strong>现场证据</strong><span>附件原件在本机受管存储，模型只读取脱敏文本副本</span></div><button className="diagnostics-primary" disabled={busy || analyzing || ['closed', 'cancelled'].includes(item.status)} onClick={() => void selectEvidence()}><Icon name="plus" />选择附件</button></header><p className="diagnostics-limit-note">支持 PNG、JPG、JPEG、WEBP、TXT、LOG、MD、JSON、XML、CSV、PDF、DOCX、XLSX。单文件最大 20 MiB，每次最多 10 个文件，单问题总量最大 100 MiB。图片保留为附件，目前不进行图像识别。</p>{evidence.length ? <div className="diagnostics-evidence-list">{evidence.map(file => <article key={file.id}><span className={`evidence-type ${file.kind}`}>{file.extension.slice(1).toUpperCase()}</span><div className="diagnostics-evidence-main"><strong>{file.originalName}</strong><span>{byteLabel(file.size)} · SHA-256 {file.sha256.slice(0, 16)}… · {dateLabel(file.createdAt)}</span><small>{file.parseSummary || '等待解析'}{file.redactionSummary ? ` · ${file.redactionSummary}` : ''}</small></div><span className={`evidence-state ${file.status}`}>{file.status === 'redacted' ? '已脱敏' : file.status === 'stored' ? '仅附件' : '解析失败'}</span>{file.redactedStorageKey && <button className="diagnostics-secondary" onClick={() => void showEvidencePreview(file)}>脱敏预览</button>}<button className="diagnostics-icon-button danger" title="删除证据" aria-label={`删除 ${file.originalName}`} disabled={busy || analyzing} onClick={() => { if (window.confirm(`删除证据“${file.originalName}”？`)) void perform(() => api.deleteEvidence(item.id, file.id), '证据已删除'); }}><Icon name="close" /></button></article>)}</div> : <EmptyInline text="尚未添加现场证据" />}</section></div>}
        {section === 'root' && <div className="diagnostics-section-stack"><section className="diagnostics-section"><header><div><strong>根因候选</strong><span>候选根因需要工程师验证后才可作为已确认根因</span></div><button className="diagnostics-secondary" disabled={busy || analyzing} onClick={() => { setAnalysisTask('root_cause'); void requestAnalysisPreview('root_cause'); }}><Icon name="refresh" />分析候选</button></header>{details.hypotheses.length ? <div className="diagnostics-hypothesis-list">{details.hypotheses.map(hypothesis => <form key={hypothesis.id} onSubmit={event => void submitHypothesis(event, hypothesis.id)}><div className="hypothesis-title"><strong>{hypothesis.title}</strong><span>{hypothesis.confidence} · {hypothesis.category}</span></div><p>支持证据：{hypothesis.supportingRefs.join('、') || '暂无'}<br />反向证据：{hypothesis.contradictingRefs.join('、') || '暂无'}<br />建议验证：{hypothesis.nextVerification || '未提供'}</p><div className="diagnostics-inline-form"><select name="status" defaultValue={hypothesis.status}><option value="suspected">疑似</option><option value="under_verification">验证中</option><option value="verified_by_engineer">工程师已验证</option><option value="rejected">已排除</option><option value="unknown">未知</option></select><input name="confirmedBy" defaultValue={hypothesis.confirmedBy} placeholder="确认工程师姓名" /><button className="diagnostics-secondary" disabled={busy}>保存状态</button></div></form>)}</div> : <EmptyInline text="尚无根因候选" />}</section><ResolutionForm resolution={resolution} disabled={busy || analyzing} onSubmit={submitResolution} /></div>}
        {section === 'handoff' && <div className="diagnostics-section-stack"><section className="diagnostics-section"><header><div><strong>开发问题单草稿</strong><span>生成、编辑和导出 Markdown，不会写入 Jira</span></div></header><DeveloperDraft api={api} item={item} onExport={markdown => perform(async () => { const file = await api.saveDraftFile(item.id, markdown); if (file) setNotice(`开发问题单已导出到 ${file}`); else setNotice('已取消导出'); }, undefined, false)} disabled={busy} /></section><section className="diagnostics-section"><header><div><strong>案例沉淀与审核</strong><span>仅已解决或关闭的问题可提交案例</span></div><button className="diagnostics-secondary" disabled={busy || !['resolved', 'closed'].includes(item.status)} onClick={() => void perform(saveKnowledgeDraft, '脱敏案例草稿已生成')}>生成脱敏草稿</button></header>{currentKnowledge ? <KnowledgeReviewCard api={api} item={item} knowledge={currentKnowledge} busy={busy} perform={perform} /> : <EmptyInline text="尚未生成案例草稿" />}</section></div>}
        {section === 'timeline' && <section className="diagnostics-section"><header><div><strong>操作时间线</strong><span>诊断记录、人工验证和状态变更</span></div></header><div className="diagnostics-timeline">{[...details.events].reverse().map(value => <article key={value.id}><span /><div><strong>{value.summary}</strong><small>{value.eventType} · {dateLabel(value.createdAt)}</small></div></article>)}{!details.events.length && <EmptyInline text="暂无操作记录" />}</div></section>}
      </section>
      <aside className="diagnostics-assistant"><header><span className="diagnostics-assistant-mark"><Icon name="layers" /></span><div><strong>诊断助手</strong><small>建议内容需现场工程师确认</small></div></header><AnalysisBox task={analysisTask} setTask={setAnalysisTask} preview={preview} busy={busy} analyzing={analyzing} setPreview={setPreview} onPreview={requestAnalysisPreview} onRun={runAnalysis} onCancel={() => void api.cancelAnalysis().catch(reason => setError(errorText(reason)))} compact /><section><h3>本轮资料</h3>{details.runs[0]?.sourceRefs.length ? details.runs[0].sourceRefs.slice(0, 6).map(source => <div className="diagnostics-assistant-source" key={`${source.sourceType}:${source.sourceId}`}><strong>{source.sourceName}</strong><small>{source.locator || source.sourceType}</small></div>) : <p>尚无分析引用。运行分析前可在预览中核对发送内容。</p>}</section>{details.runs[0] && <section><h3>最近分析</h3><p>{runTaskLabels[details.runs[0].kind]} · {details.runs[0].status}</p><small>{details.runs[0].model || details.runs[0].runtimeKind} · {dateLabel(details.runs[0].startedAt)}</small></section>}</aside>
    </div>
  </div>;
}

function AnalysisBox({ task, setTask, preview, busy, analyzing, setPreview, onPreview, onRun, onCancel, compact = false }: {
  task: DiagnosticRunKind; setTask: (value: DiagnosticRunKind) => void;
  preview: DiagnosticAnalysisPreview | null; busy: boolean; analyzing: boolean; setPreview: (value: DiagnosticAnalysisPreview | null) => void; onPreview: () => Promise<void>; onRun: () => Promise<void>; onCancel: () => void; compact?: boolean;
}) {
  return <section className={`diagnostics-analysis-box ${compact ? 'compact' : ''}`}><header><div><strong>运行诊断分析</strong><span>先核对发送预览，再确认运行</span></div></header><div className="diagnostics-analysis-controls"><label className="diagnostics-analysis-field"><span>分析任务</span><select aria-label="分析任务" value={task} onChange={event => { setTask(event.target.value as DiagnosticRunKind); setPreview(null); }}>{Object.entries(runTaskLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><button className="diagnostics-secondary" disabled={busy || analyzing} onClick={() => void onPreview()}><Icon name="eye" />查看发送预览</button></div>{analyzing ? <div className="diagnostics-analysis-running"><span className="diagnostics-spinner" />诊断分析运行中<button className="diagnostics-secondary" onClick={onCancel}>取消</button></div> : null}{preview && <div className="diagnostics-analysis-preview"><div className="diagnostics-preview-meta">{preview.runtimeKind === 'codex' ? 'Codex Runtime' : 'Jinggong Runtime'} · {preview.model}</div>{preview.warnings.map((warning, index) => <p className="diagnostics-preview-warning" key={index}><Icon name="alert" />{warning}</p>)}<div className="diagnostics-preview-sources">{preview.sources.length ? preview.sources.map(source => <details key={source.id}><summary>{source.name}</summary><pre>{source.preview}</pre></details>) : <p>未找到适用的内部资料，本轮只包含问题描述和现场反馈。</p>}</div><div className="diagnostics-preview-actions"><button className="diagnostics-text-button" onClick={() => setPreview(null)}>返回修改</button><button className="diagnostics-primary" disabled={busy || analyzing} onClick={() => void onRun()}>确认并运行</button></div></div>}</section>;
}

function ResolutionForm({ resolution, disabled, onSubmit }: { resolution?: DiagnosticCaseDetails['resolutions'][number]; disabled: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void> }) {
  return <form className="diagnostics-resolution-form" onSubmit={event => void onSubmit(event)}><header><div><strong>处理方案与验证记录</strong><span>验证通过后才能标记已解决</span></div></header><label>根因描述<input name="rootCauseSummary" required defaultValue={resolution?.rootCauseSummary} /></label><div className="diagnostics-form-grid"><label>根因状态<select name="rootCauseStatus" defaultValue={resolution?.rootCauseStatus ?? 'suspected'}><option value="suspected">疑似</option><option value="verified_by_engineer">工程师已验证</option><option value="unknown">未知</option></select></label><label>处理类型<select name="resolutionType" defaultValue={resolution?.resolutionType ?? 'workaround'}><option value="workaround">临时绕行</option><option value="permanent_fix">永久修复</option><option value="prevention">预防措施</option><option value="development_required">需要开发修复</option><option value="customer_or_vendor_action">客户或第三方处理</option></select></label></div><label>根因未知原因<input name="rootCauseUnknownReason" defaultValue={resolution?.rootCauseUnknownReason} placeholder="根因未知时填写至少 10 个字符" /></label><label>处理说明<textarea name="actionSummary" required rows={3} defaultValue={resolution?.actionSummary} /></label><label>验证方法<textarea name="verificationMethod" required rows={2} defaultValue={resolution?.verificationMethod} /></label><div className="diagnostics-form-grid"><label>验证结果<select name="verificationResult" defaultValue={resolution?.verificationResult ?? 'not_run'}><option value="not_run">未验证</option><option value="partial">部分通过</option><option value="failed">未通过</option><option value="passed">通过</option></select></label><label>确认工程师<input name="verifiedBy" defaultValue={resolution?.verifiedBy} placeholder="通过时必填" /></label></div><label>验证备注<textarea name="verificationNotes" rows={2} defaultValue={resolution?.verificationNotes} /></label><label className="diagnostics-check-label"><input type="checkbox" name="acceptRisk" defaultChecked={resolution?.acceptedUnverifiedRisk} />接受未验证风险</label><label>接受风险的原因<input name="acceptedRiskReason" defaultValue={resolution?.acceptedRiskReason} placeholder="接受风险时填写至少 10 个字符" /></label><button className="diagnostics-primary" disabled={disabled}>保存处理与验证</button></form>;
}

function DeveloperDraft({ api, item, onExport, disabled }: { api: DiagnosticApi; item: DiagnosticCase; onExport: (markdown: string) => Promise<void>; disabled: boolean }) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  useEffect(() => { let current = true; void api.exportDeveloperDraft(item.id).then(value => { if (current) setDraft(value ?? ''); }).catch(reason => { if (current) setError(errorText(reason)); }); return () => { current = false; }; }, [api, item.id, item.updatedAt]);
  return <div className="diagnostics-draft"><textarea aria-label="开发问题单 Markdown 草稿" value={draft} onChange={event => setDraft(event.target.value)} placeholder="生成的开发问题单草稿将在此显示，可继续编辑。" /><div className="diagnostics-draft-actions">{error && <small className="diagnostics-inline-error">{error}</small>}<button className="diagnostics-primary" disabled={disabled || !draft.trim()} onClick={() => void onExport(draft)}><Icon name="download" />导出 Markdown</button></div></div>;
}

function RelatedKnowledge({ api, item, cases, busy, onUse, onError }: { api: DiagnosticApi; item: DiagnosticCase; cases: DiagnosticKnowledgeCase[]; busy: boolean; onUse: (value: string) => void; onError: (value: string) => void }) {
  const [results, setResults] = useState<DiagnosticKnowledgeCase[]>([]);
  useEffect(() => {
    let current = true;
    const query = `${item.title} ${item.symptom} ${item.module ?? ''}`.trim();
    void api.searchKnowledgeCases({ product: item.product, query, deliveryProjectId: item.deliveryProjectId }).then(value => { if (current) setResults(value); }).catch(reason => { if (current) onError(errorText(reason)); });
    return () => { current = false; };
  }, [api, item.id, item.updatedAt]);
  return <div className="diagnostics-related-knowledge">{results.map(record => <KnowledgeCard item={record} key={record.id} />)}{cases.filter(record => record.status !== 'approved').map(record => <KnowledgeCard item={record} key={record.id} />)}{!results.length && !cases.length && <EmptyInline text={busy ? '正在检索…' : '未找到适用的已审核案例'} />}{results.length > 0 && <button className="diagnostics-text-button" onClick={() => onUse(`找到 ${results.length} 条已审核案例`)}>已审核案例仅供参考，仍需核对版本和现场条件</button>}</div>;
}

function KnowledgeCard({ item }: { item: DiagnosticKnowledgeCase }) { return <article className="diagnostics-knowledge-card"><header><strong>{item.title}</strong><span>{productLabels[item.product]}{item.productVersionRange ? ` · ${item.productVersionRange}` : ''}</span></header><p>{item.symptom}</p><dl><dt>根因</dt><dd>{item.rootCause}</dd><dt>处理</dt><dd>{item.resolution}</dd><dt>验证</dt><dd>{item.verification}</dd></dl><small>{item.status === 'approved' ? (item.sharedAcrossProjects ? '已审核 · 已共享' : '已审核 · 限原范围') : item.status === 'pending_review' ? '待审核' : item.status === 'rejected' ? '已退回' : '档案草稿'}</small></article>; }

function KnowledgeReviewCard({ api, item, knowledge, busy, perform }: { api: DiagnosticApi; item: DiagnosticCase; knowledge: DiagnosticKnowledgeCase; busy: boolean; perform: (action: () => Promise<unknown>, message?: string, refresh?: boolean) => Promise<void> }) {
  const [shared, setShared] = useState(false);
  return <article className="diagnostics-knowledge-draft"><KnowledgeCard item={knowledge} /><p>脱敏内容哈希：{knowledge.anonymizedContentHash}</p>{knowledge.status === 'draft' && <form onSubmit={event => { event.preventDefault(); if (shared && !window.confirm('确认申请将此脱敏案例共享到案例库？提交后仍需人工审核。')) return; void perform(() => api.submitKnowledgeCase(item.id, knowledge.id, { sharedAcrossProjects: shared }), '脱敏案例已提交审核'); }}><label className="diagnostics-check-label"><input type="checkbox" checked={shared} onChange={event => setShared(event.target.checked)} />允许其他诊断档案检索此脱敏案例</label><button className="diagnostics-primary" disabled={busy}>提交审核</button></form>}{knowledge.status === 'pending_review' && <form className="diagnostics-review-form" onSubmit={event => { event.preventDefault(); const data = new FormData(event.currentTarget); void perform(() => api.reviewKnowledgeCase(item.id, knowledge.id, { status: String(data.get('status')) as 'approved' | 'rejected', reviewerLabel: String(data.get('reviewerLabel') ?? '').trim(), reviewNote: String(data.get('reviewNote') ?? '').trim() }), '案例审核记录已保存'); }}><label>审核结果<select name="status"><option value="approved">批准</option><option value="rejected">退回</option></select></label><label>审核人<input name="reviewerLabel" required /></label><label>审核意见<input name="reviewNote" required /></label><button className="diagnostics-secondary" disabled={busy}>保存审核结果</button></form>}</article>;
}

function CreateDialog({ busy, onClose, onSubmit }: { busy: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  return <div className="diagnostics-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="diagnostics-modal diagnostics-form-modal" role="dialog" aria-modal="true" aria-labelledby="diagnostics-create-title" onSubmit={onSubmit}>
      <header><div><span>诊断档案</span><h2 id="diagnostics-create-title">新建现场问题</h2></div><button type="button" className="diagnostics-icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></header>
      <div className="diagnostics-modal-body">
        <label>问题标题 <em>必填</em><input name="title" required maxLength={200} /></label>
        <label>问题现象 <em>必填，至少 10 字</em><textarea name="symptom" required minLength={10} maxLength={20000} rows={5} placeholder="请描述发生场景、操作条件、期望结果和实际结果。" /></label>
        <div className="diagnostics-form-grid">
          <label>产品系统<select name="product" required defaultValue=""><option value="" disabled>选择产品系统</option>{Object.entries(productLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>优先级<select name="priority" defaultValue="medium">{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>产品版本<input name="productVersion" /></label><label>业务模块<input name="module" /></label><label>业务环节<input name="businessProcess" /></label>
          <label>问题类型<select name="issueCategory" defaultValue="unknown">{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>发生时间<input name="occurredAt" type="datetime-local" /></label><label>发生频率<input name="frequency" placeholder="每次、偶发、首次发生…" /></label>
          <label>期望结果<textarea name="expectedResult" rows={2} /></label><label>实际结果<textarea name="actualResult" rows={2} /></label>
          <label>复现步骤<textarea name="reproduceSteps" rows={3} /></label><label>影响范围<textarea name="impactScope" rows={3} /></label>
          <label>环境信息<textarea name="environment" rows={2} placeholder="请勿填写密码或访问令牌" /></label>
          <label>负责人<input name="assigneeLabel" /></label><label>创建人<input name="reporterLabel" /></label>
        </div>
      </div>
      <footer><button type="button" className="diagnostics-secondary" onClick={onClose}>取消</button><button className="diagnostics-primary" disabled={busy}>保存问题</button></footer>
    </form>
  </div>;
}

function TriageConfirmDialog({ item, busy, onClose, onSubmit }: { item: DiagnosticCase; busy: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const triage = item.triage!;
  const suggestion = (value: string | undefined) => value && value !== 'unknown' ? value : undefined;
  const changed = (value: string | undefined, current: string | undefined) => value !== undefined && value !== current;
  const details = (current: string | undefined, proposed: string | undefined) => `档案：${current || '未填写'} · 本次建议：${proposed || '无可用建议'}`;
  const product = triage.product === 'unknown' ? undefined : triage.product;
  const productVersion = suggestion(triage.productVersion);
  const module = suggestion(triage.module);
  const businessProcess = suggestion(triage.businessProcess);
  const issueCategory = triage.issueCategory === 'unknown' ? undefined : triage.issueCategory;
  const priority = suggestion(triage.prioritySuggestion);
  const impactScope = suggestion(triage.impactScopeSuggestion);
  return <div className="diagnostics-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="diagnostics-modal diagnostics-form-modal diagnostics-triage-modal" role="dialog" aria-modal="true" aria-labelledby="diagnostics-triage-title" onSubmit={onSubmit}>
      <header><div><span>{item.code}</span><h2 id="diagnostics-triage-title">确认分诊字段</h2></div><button type="button" className="diagnostics-icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></header>
      <div className="diagnostics-modal-body">
        <p className="diagnostics-triage-note">核对当前档案与本次 AI 建议。勾选字段才会写入，取消勾选可保留原值。</p>
        <div className="diagnostics-triage-grid">
          <div className="diagnostics-triage-field"><label className="diagnostics-check-label"><input type="checkbox" name="apply_product" defaultChecked={changed(product, item.product)} /><span>应用产品系统</span></label><small>{details(productLabels[item.product], product ? productLabels[product] : undefined)}</small><label>产品系统<select name="product" defaultValue={product ?? item.product}>{Object.entries(productLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <div className="diagnostics-triage-field"><label className="diagnostics-check-label"><input type="checkbox" name="apply_productVersion" defaultChecked={changed(productVersion, item.productVersion)} /><span>应用产品版本</span></label><small>{details(item.productVersion, productVersion)}</small><label>产品版本<input name="productVersion" defaultValue={productVersion ?? item.productVersion ?? ''} /></label></div>
          <div className="diagnostics-triage-field"><label className="diagnostics-check-label"><input type="checkbox" name="apply_module" defaultChecked={changed(module, item.module)} /><span>应用业务模块</span></label><small>{details(item.module, module)}</small><label>业务模块<input name="module" defaultValue={module ?? item.module ?? ''} /></label></div>
          <div className="diagnostics-triage-field"><label className="diagnostics-check-label"><input type="checkbox" name="apply_businessProcess" defaultChecked={changed(businessProcess, item.businessProcess)} /><span>应用业务环节</span></label><small>{details(item.businessProcess, businessProcess)}</small><label>业务环节<input name="businessProcess" defaultValue={businessProcess ?? item.businessProcess ?? ''} /></label></div>
          <div className="diagnostics-triage-field"><label className="diagnostics-check-label"><input type="checkbox" name="apply_issueCategory" defaultChecked={changed(issueCategory, item.issueCategory)} /><span>应用问题分类</span></label><small>{details(categoryLabels[item.issueCategory], issueCategory ? categoryLabels[issueCategory] : undefined)}</small><label>问题分类<select name="issueCategory" defaultValue={issueCategory ?? item.issueCategory}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <div className="diagnostics-triage-field"><label className="diagnostics-check-label"><input type="checkbox" name="apply_priority" defaultChecked={changed(priority, item.priority)} /><span>应用优先级</span></label><small>{details(priorityLabels[item.priority], priority ? priorityLabels[priority as DiagnosticPriority] : undefined)}</small><label>优先级<select name="priority" defaultValue={priority ?? item.priority}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <div className="diagnostics-triage-field wide"><label className="diagnostics-check-label"><input type="checkbox" name="apply_impactScope" defaultChecked={changed(impactScope, item.impactScope)} /><span>应用影响范围</span></label><small>{details(item.impactScope, impactScope)}</small><label>影响范围<textarea name="impactScope" rows={2} defaultValue={impactScope ?? item.impactScope ?? ''} /></label></div>
        </div>
      </div>
      <footer><button type="button" className="diagnostics-secondary" onClick={onClose}>取消</button><button className="diagnostics-primary" disabled={busy}>确认并应用所选字段</button></footer>
    </form>
  </div>;
}

function EditDialog({ item, busy, onClose, onSubmit }: { item: DiagnosticCase; busy: boolean; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void }) {
  const occurredAt = item.occurredAt ? new Date(item.occurredAt) : undefined;
  const occurredAtValue = occurredAt && !Number.isNaN(occurredAt.valueOf())
    ? new Date(occurredAt.valueOf() - occurredAt.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : '';
  return <div className="diagnostics-modal-backdrop" role="presentation">
    <form className="diagnostics-modal diagnostics-form-modal" role="dialog" aria-modal="true" aria-labelledby="diagnostics-edit-title" onSubmit={onSubmit}>
      <header><div><span>{item.code}</span><h2 id="diagnostics-edit-title">编辑问题</h2></div><button type="button" className="diagnostics-icon-button" onClick={onClose} aria-label="关闭"><Icon name="close" /></button></header>
      <div className="diagnostics-modal-body">
        <label>问题标题<input name="title" required maxLength={200} defaultValue={item.title} /></label>
        <label>问题现象<textarea name="symptom" required minLength={10} maxLength={20000} rows={5} defaultValue={item.symptom} /></label>
        <div className="diagnostics-form-grid">
          <label>产品系统<select name="product" defaultValue={item.product}>{Object.entries(productLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>优先级<select name="priority" defaultValue={item.priority}>{Object.entries(priorityLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>产品版本<input name="productVersion" defaultValue={item.productVersion} /></label><label>业务模块<input name="module" defaultValue={item.module} /></label>
          <label>业务环节<input name="businessProcess" defaultValue={item.businessProcess} /></label>
          <label>问题类型<select name="issueCategory" defaultValue={item.issueCategory}>{Object.entries(categoryLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>发生时间<input name="occurredAt" type="datetime-local" defaultValue={occurredAtValue} /></label>
          <label>发生频率<input name="frequency" defaultValue={item.frequency} /></label><label>负责人<input name="assigneeLabel" defaultValue={item.assigneeLabel} /></label>
          <label>创建人<input name="reporterLabel" defaultValue={item.reporterLabel} /></label>
          <label>影响范围<textarea name="impactScope" rows={2} defaultValue={item.impactScope} /></label><label>环境信息<textarea name="environment" rows={2} defaultValue={item.environment} /></label>
          <label>期望结果<textarea name="expectedResult" rows={2} defaultValue={item.expectedResult} /></label><label>实际结果<textarea name="actualResult" rows={2} defaultValue={item.actualResult} /></label>
          <label>复现步骤<textarea name="reproduceSteps" rows={3} defaultValue={item.reproduceSteps} /></label>
        </div>
      </div>
      <footer><button type="button" className="diagnostics-secondary" onClick={onClose}>取消</button><button className="diagnostics-primary" disabled={busy}>保存修改</button></footer>
    </form>
  </div>;
}

import { Fragment, useEffect, useMemo, useState } from 'react';
import type { ExpertApi, ExpertCase, ExpertComparison, ExpertGrade, ExpertProfile } from '../../../../packages/domain/src/expert';
import type { Session } from '../../../../packages/domain/src';
import { formatLocalDateTime } from './message-timing';
import { Icon } from './ui';
import './expert-center.css';
import { ExpertAvatar } from './ExpertAvatar';

const dimensions = ['任务理解', '产品版本', '引用质量', '专业完整度', '可执行性', '风险边界', '交付可用性'];
const matrixDimensions = ['需求理解', '产品知识', '技术实现', '质量验证', '现场交付', '风险边界'];
const average = (scores: number[]) => scores.reduce((sum, n) => sum + n, 0) / scores.length;
const pct = (n: number, d: number) => d ? Math.round(100 * n / d) + '%' : '—';
const matrixScores: Record<string, number[]> = {
  'mes-wms-engineering': [5, 5, 4, 4, 4, 5],
  'project-delivery': [4, 4, 4, 4, 5, 5],
  'mes-wms-requirements': [5, 5, 4, 5, 4, 4],
  'mes-wms-backend': [4, 5, 5, 4, 5, 5],
  'mes-wms-frontend': [4, 5, 5, 4, 4, 4],
  'mes-wms-fullstack': [5, 5, 5, 4, 5, 5],
  'mes-wms-quality': [4, 5, 3, 5, 4, 5],
  'project-director': [4, 4, 3, 4, 5, 5],
  'project-manager': [4, 4, 3, 4, 5, 5],
  'implementation-engineer': [4, 5, 4, 4, 5, 4],
};

function scoreFor(profile: ExpertProfile, index: number) {
  return matrixScores[profile.id]?.[index] ?? 4;
}

function familyLabel(profile: ExpertProfile) {
  return profile.familyId === 'project-delivery' ? '项目交付' : '研发工程';
}

function Review({ run, arm, save }: { run: ExpertComparison; arm: 'baseline' | 'expert'; save: (value: ExpertGrade) => void }) {
  const result = run[arm];
  const [draft, set] = useState<ExpertGrade>(result.grade ?? { scores: Array(7).fill(-1), citation: '不适用', complete: false, mismatch: false, notes: '' });
  return <details className="eval-result">
    <summary><span>{arm === 'baseline' ? '普通 Agent' : '专家策略'}</span><small>{result.status} · {result.grade ? average(result.grade.scores).toFixed(2) + ' 分' : '未评分'}</small></summary>
    <pre>{result.answer || result.error || result.status}</pre>
    {result.status === 'completed' && <>
      <div className="expert-scores">{dimensions.map((label, index) => <label key={label}>{label}<select value={draft.scores[index]} onChange={event => set({ ...draft, scores: draft.scores.map((value, item) => index === item ? Number(event.target.value) : value) })}><option value="-1">未评</option>{[0, 1, 2, 3, 4, 5].map(value => <option key={value}>{value}</option>)}</select></label>)}</div>
      <label>引用准确性<select value={draft.citation} onChange={event => set({ ...draft, citation: event.target.value as ExpertGrade['citation'] })}>{['正确', '错误', '不适用'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label className="check-label"><input type="checkbox" checked={draft.mismatch} onChange={event => set({ ...draft, mismatch: event.target.checked })} />产品错配</label>
      <label className="check-label"><input type="checkbox" checked={draft.complete} onChange={event => set({ ...draft, complete: event.target.checked })} />关键项完整</label>
      <label>评审备注<textarea value={draft.notes} onChange={event => set({ ...draft, notes: event.target.value })} /></label>
      <button type="button" className="expert-action-button expert-action-button-primary" disabled={draft.scores.includes(-1)} onClick={() => save(draft)}><Icon name="check" />保存人工评分</button>
    </>}
  </details>;
}

function MatrixHeader({ profile, index, selected, onSelect }: { profile: ExpertProfile; index: number; selected: boolean; onSelect: () => void }) {
  return <button type="button" className={`matrix-profile matrix-profile-row ${selected ? 'is-selected' : ''}`} aria-pressed={selected} onClick={onSelect}>
    <span className="matrix-profile-index">{String(index + 1).padStart(2, '0')}</span>
    <ExpertAvatar id={profile.id} size={44} />
    <span className="matrix-profile-copy"><strong>{profile.name}</strong><small>{familyLabel(profile)} · v{profile.version}</small></span>
    <span className={`profile-state ${profile.enabled ? 'online' : 'offline'}`}>{profile.enabled ? '启用' : '停用'}</span>
  </button>;
}

export function ExpertCenter({ api, sessions }: { api: ExpertApi; sessions: Session[] }) {
  const [profiles, setProfiles] = useState<ExpertProfile[]>([]);
  const [cases, setCases] = useState<ExpertCase[]>([]);
  const [records, setRecords] = useState<ExpertComparison[]>([]);
  const [tab, setTab] = useState<'matrix' | 'eval'>('matrix');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState('mes-wms-engineering');
  const [editing, setEditing] = useState<ExpertProfile>();
  const [query, setQuery] = useState('');
  const [family, setFamily] = useState<'all' | 'engineering' | 'delivery'>('all');
  const [role, setRole] = useState('');
  const [product, setProduct] = useState('');
  const [draft, setCase] = useState<ExpertCase>();
  const [sessionId, setSession] = useState(sessions[0]?.id ?? '');
  const [evalProfile, setEvalProfile] = useState('');
  const [comparing, setComparing] = useState(false);
  const roles = profiles.filter(profile => profile.role);
  const profile = profiles.find(item => item.id === selected);
  const visibleProfiles = useMemo(() => profiles.filter(item => {
    const matchesQuery = !query.trim() || `${item.name} ${item.skillTags.join(' ')} ${familyLabel(item)}`.toLowerCase().includes(query.trim().toLowerCase());
    const matchesFamily = family === 'all' || (family === 'delivery' ? item.familyId === 'project-delivery' : item.familyId !== 'project-delivery');
    return matchesQuery && matchesFamily;
  }), [family, profiles, query]);
  const filteredCases = cases.filter(item => (!role || item.profileId === role) && (!product || item.product === product));
  const visibleRecords = records.filter(item => (!role || item.case.profileId === role) && (!product || item.case.product === product));
  const comparisonGroups = new Map<string, ExpertComparison[]>();
  for (const record of visibleRecords) {
    const key = JSON.stringify([record.case.profileId, record.runtime, record.provider, record.model, record.effort, record.strategy, record.profileHash]);
    comparisonGroups.set(key, [...(comparisonGroups.get(key) ?? []), record]);
  }

  async function refresh() {
    const [nextProfiles, nextCases, nextRecords] = await Promise.all([api.profiles(), api.cases(), api.comparisons()]);
    setProfiles(nextProfiles);
    setCases(nextCases);
    setRecords(nextRecords);
  }

  useEffect(() => { void refresh().catch(error => setMessage(String(error))); }, [api]);

  async function act(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage('');
    try { await work(); await refresh(); }
    catch (error) { setMessage(String(error)); }
    finally { setBusy(false); }
  }

  async function change(action: Parameters<ExpertApi['profile']>[0]) {
    if (!profile) return;
    await act(async () => {
      const list = await api.profile(action, profile.id, action === 'edit' && editing ? { name: editing.name, output: editing.output, steps: editing.steps, version: editing.version } : undefined);
      if (action === 'copy') setSelected(list.find(item => !profiles.some(old => old.id === item.id))?.id ?? profile.id);
      if (action === 'delete') { setSelected('mes-wms-engineering'); setEditing(undefined); }
    });
  }

  useEffect(() => {
    if (!comparing) return undefined;
    const timer = setInterval(() => void api.comparisons().then(setRecords).catch(error => setMessage(String(error))), 1500);
    return () => clearInterval(timer);
  }, [api, comparing]);

  const editingCase = draft && cases.find(item => item.id === draft.id);
  const savedCase = draft && editingCase && (Object.keys(draft) as Array<keyof ExpertCase>).every(key => draft[key] === editingCase[key]);
  const matrixColumns = `minmax(270px, 1.35fr) repeat(${Math.max(matrixDimensions.length, 1)}, minmax(126px, .6fr))`;

  return <section className="expert-center expert-workbench">
    <header className="expert-workbench-header">
      <div className="expert-heading">
        <span className="expert-eyebrow"><span className="signal-dot" /> EXPERT OPERATIONS / 01</span>
        <div><h3>专家能力工作台</h3><p>面向 MES / WMS 研发与交付的角色编排、能力对比和质量评测。</p></div>
      </div>
      <div className="expert-header-status"><span className="status-pulse" />本地配置已同步<span className="status-divider" />v0.9.6</div>
    </header>
    <div className="expert-metric-strip" aria-label="专家中心概览">
      <div><span>专家角色</span><strong>{profiles.length || 10}</strong><small>已加载配置</small></div>
      <div><span>能力维度</span><strong>06</strong><small>统一评价口径</small></div>
      <div><span>产品知识域</span><strong>03</strong><small>MES5 · MES6 · WMS</small></div>
      <div><span>可追溯状态</span><strong className="metric-good">100%</strong><small>来源和版本可定位</small></div>
    </div>
    {message && <p className="form-error expert-form-error" role="alert"><Icon name="alert" />{message}</p>}
    <div className="expert-toolbar">
      <div className="expert-segmented" role="tablist" aria-label="专家中心视图">
        <button type="button" role="tab" aria-selected={tab === 'matrix'} onClick={() => setTab('matrix')}><Icon name="layers" />能力矩阵</button>
        <button type="button" role="tab" aria-selected={tab === 'eval'} onClick={() => setTab('eval')}><Icon name="branch" />评测工作台</button>
      </div>
      {tab === 'matrix' ? <>
        <div className="expert-filter-group" role="group" aria-label="专家家族筛选">
          {([['all', '全部'], ['engineering', '研发工程'], ['delivery', '项目交付']] as const).map(item => <button type="button" key={item[0]} className={family === item[0] ? 'active' : ''} onClick={() => setFamily(item[0])}>{item[1]}</button>)}
        </div>
        <label className="expert-search"><Icon name="eye" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索角色、技能标签" aria-label="搜索专家" /></label>
      </> : <div className="toolbar-spacer" />}
      <button type="button" className="icon-button expert-refresh" onClick={() => void act(refresh)} disabled={busy} title="刷新专家配置" aria-label="刷新专家配置"><Icon name="refresh" /></button>
    </div>

    {tab === 'matrix' && <>
      <div className="matrix-intro"><div><strong>专家能力矩阵</strong><span>专家为行、技能为列，交叉单元显示该专家的技能分数</span></div><span className="matrix-legend"><i className="legend-high" />强项 <i className="legend-mid" />可协同 <i className="legend-low" />待补充</span></div>
      <div className="expert-matrix-shell">
        <div className="expert-matrix" style={{ gridTemplateColumns: matrixColumns }}>
          <div className="matrix-corner"><span>专家角色</span><small>EXPERT / SCORE</small></div>
          {matrixDimensions.map((label, index) => <div className="matrix-axis-header" key={label}><span>{String(index + 1).padStart(2, '0')}</span><strong>{label}</strong><small>技能分数</small></div>)}
          {visibleProfiles.map((item, index) => <Fragment key={item.id}>
            <MatrixHeader profile={item} index={index} selected={item.id === selected} onSelect={() => { setSelected(item.id); setEditing(undefined); }} />
            {matrixDimensions.map((label, dimensionIndex) => { const score = scoreFor(item, dimensionIndex); return <button type="button" key={`${item.id}-${label}`} className={`matrix-score ${item.id === selected ? 'is-selected' : ''} score-${score}`} onClick={() => setSelected(item.id)} title={`${item.name} · ${label} ${score}/5`}><span>{score}</span><i /><i /><i /><i /><i /></button>; })}
          </Fragment>)}
        </div>
        {!visibleProfiles.length && <div className="matrix-empty"><Icon name="eye-off" /><strong>没有匹配的专家</strong><span>调整家族筛选或搜索关键词后重试。</span></div>}
      </div>
      {profile && <div className="expert-inspector-grid">
        <article className="expert-profile-panel">
          <div className="panel-kicker">SELECTED PROFILE / 选中角色</div>
          <div className="profile-hero"><ExpertAvatar id={profile.id} size={64} /><div><h4>{profile.name}</h4><p>{familyLabel(profile)} · {profile.role ?? '总专家'} · v{profile.version}</p></div><span className={`profile-state large ${profile.enabled ? 'online' : 'offline'}`}>{profile.enabled ? '运行中' : '已停用'}</span></div>
          <div className="profile-stat-grid"><div><span>工作流</span><strong>{profile.workflowId}</strong></div><div><span>知识范围</span><strong>{profile.familyId === 'project-delivery' ? '项目交付域' : 'MES / WMS 产品域'}</strong></div><div><span>技能标签</span><strong>{profile.skillTags.length || '按任务匹配'}</strong></div></div>
          <p className="profile-output"><span>输出契约</span>{profile.output}</p>
          <div className="expert-actions expert-profile-actions"><button type="button" className="expert-action-button expert-action-button-primary" disabled={busy} onClick={() => void change('copy')}><Icon name="copy" />复制档案</button><button type="button" className="expert-action-button" disabled={busy || !profile.enabled || profile.isDefault} onClick={() => void change('default')}><Icon name="check" />设为默认</button><button type="button" className="expert-action-button" disabled={busy || profile.isDefault} onClick={() => void change('toggle')}><Icon name={profile.enabled ? 'eye-off' : 'eye'} />{profile.enabled ? '停用角色' : '启用角色'}</button>{profile.builtin ? <button type="button" className="expert-action-button" disabled={busy} onClick={() => void change('restore')}><Icon name="refresh" />恢复内置</button> : <><button type="button" className="expert-action-button" disabled={busy} onClick={() => setEditing(profile)}><Icon name="edit" />编辑</button><button type="button" className="expert-action-button expert-action-button-danger" disabled={busy || profile.isDefault} onClick={() => void change('delete')}><Icon name="close" />删除档案</button></>}</div>
          {editing && <div className="expert-edit-form"><label>角色名称<input value={editing.name} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label><label>工作步骤<textarea value={editing.steps.join('\n')} onChange={event => setEditing({ ...editing, steps: event.target.value.split('\n') })} /></label><label>输出规范<textarea value={editing.output} onChange={event => setEditing({ ...editing, output: event.target.value })} /></label><button type="button" className="expert-action-button expert-action-button-primary" disabled={busy} onClick={() => void change('edit')}><Icon name="check" />保存档案</button></div>}
        </article>
        <article className="expert-workflow-panel"><div className="panel-kicker">WORKFLOW TRACE / 执行链路</div><h4>工作步骤</h4><ol className="workflow-list">{profile.steps.map((step, index) => <li key={step}><span>{String(index + 1).padStart(2, '0')}</span><p>{step}</p></li>)}</ol><div className="workflow-meta"><div><span>知识来源</span><strong>{profile.sources.join(' · ')}</strong></div><div><span>验收边界</span><strong>{profile.checks}</strong></div></div></article>
      </div>}
    </>}

    {tab === 'eval' && <div className="eval-workbench">
      <div className="eval-header"><div><span className="panel-kicker">CONTROL ROOM / 评测控制台</span><h4>普通 Agent × 专家策略</h4><p>在同一输入、模型和知识范围下，复核角色策略带来的质量差异。</p></div><div className="eval-live"><span className={comparing ? 'live-dot active' : 'live-dot'} />{comparing ? '评测运行中' : '评测待命'}</div></div>
      <div className="eval-control-grid">
        <div className="eval-case-panel"><div className="control-title"><span>01</span><strong>案例与范围</strong></div><div className="control-row"><label>岗位<select value={role} onChange={event => { setRole(event.target.value); setCase(undefined); }}><option value="">全部岗位</option>{roles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>产品<select value={product} onChange={event => { setProduct(event.target.value); setCase(undefined); }}><option value="">全部产品</option>{['MES5', 'MES6', 'WMS'].map(value => <option key={value}>{value}</option>)}</select></label></div><label>评测案例 <span className="field-count">{filteredCases.length} 条</span><select aria-label="评测案例" value={draft?.id ?? ''} onChange={event => setCase(cases.find(item => item.id === event.target.value))}><option value="">选择案例</option>{filteredCases.map(item => <option key={item.id} value={item.id}>{item.product} · {item.prompt}</option>)}</select></label><button type="button" className="expert-action-button" onClick={() => setCase({ id: crypto.randomUUID(), product: 'MES5', profileId: role || roles[0]?.id || 'mes-wms-requirements', prompt: '', expected: '', reference: '' })}><Icon name="plus" />新增案例</button></div>
        <div className="eval-run-panel"><div className="control-title"><span>02</span><strong>运行配置</strong></div><label>对照配置<select value={sessionId} onChange={event => setSession(event.target.value)}><option value="">选择已配置模型的会话</option>{sessions.map(item => <option key={item.id} value={item.id}>{item.title} · {item.runtimeKind ?? 'codex'} · {item.model}</option>)}</select></label><label>对照专家<select value={evalProfile} onChange={event => setEvalProfile(event.target.value)}><option value="">使用案例预期角色</option>{profiles.filter(item => item.enabled).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><div className="run-summary"><span>同输入</span><span>同模型</span><span>双臂结果</span></div><button type="button" className="expert-action-button expert-action-button-primary run-button" disabled={busy || !sessionId || !savedCase} onClick={() => void act(async () => { setComparing(true); try { await api.compare(sessionId, draft!.id, evalProfile || draft!.profileId); } finally { setComparing(false); } })}><Icon name="branch" />运行普通与专家对照</button><button type="button" className="expert-action-button expert-action-button-danger" disabled={!comparing && !records.some(item => item.baseline.status === 'running' || item.expert.status === 'running')} onClick={() => void api.stop().catch(error => setMessage(String(error)))}><Icon name="stop" />停止评测</button></div>
      </div>
      {draft && <div className="case-editor"><div className="control-title"><span>03</span><strong>案例内容</strong><small>保存后才能启动对照</small></div><div className="control-row"><label>案例产品<select value={draft.product} onChange={event => setCase({ ...draft, product: event.target.value as ExpertCase['product'] })}>{['MES5', 'MES6', 'WMS'].map(value => <option key={value}>{value}</option>)}</select></label><label>预期角色<select value={draft.profileId} onChange={event => setCase({ ...draft, profileId: event.target.value })}>{roles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label></div><div className="case-fields"><label>任务输入<textarea value={draft.prompt} onChange={event => setCase({ ...draft, prompt: event.target.value })} /></label><label>预期关键点<textarea value={draft.expected} onChange={event => setCase({ ...draft, expected: event.target.value })} /></label><label>评审依据<textarea value={draft.reference} onChange={event => setCase({ ...draft, reference: event.target.value })} /></label></div><div className="expert-actions"><button type="button" className="expert-action-button expert-action-button-primary" disabled={busy} onClick={() => void act(() => api.saveCase(draft))}><Icon name="check" />保存案例</button><button type="button" className="expert-action-button expert-action-button-danger" disabled={busy || !editingCase} onClick={() => void act(async () => { await api.deleteCase(draft.id); setCase(undefined); })}><Icon name="close" />删除案例</button></div></div>}
      <div className="eval-results"><div className="eval-results-heading"><div><span className="panel-kicker">04 / QUALITY SIGNALS</span><h4>对照结果与人工评审</h4></div><div className="expert-actions"><button type="button" className="expert-action-button" onClick={() => void act(() => api.export('json'))}><Icon name="download" />导出 JSON</button><button type="button" className="expert-action-button" onClick={() => void act(() => api.export('md'))}><Icon name="download" />导出 Markdown</button></div></div><p className="eval-note">七项各 0–5 分，平均分达到 4 分计为达标。引用准确率仅统计适用项。</p>{[...comparisonGroups].map(([key, group]) => { const sample = group[0]; return <article className="comparison-group" key={key}><strong>{profiles.find(item => item.id === sample.case.profileId)?.name ?? sample.case.profileId}</strong><span className="comparison-meta">{sample.runtime} · {sample.provider} · {sample.model} · {sample.effort ?? '默认强度'}</span>{(['baseline', 'expert'] as const).map(arm => { const grades = group.flatMap(item => item[arm].grade ? [item[arm].grade] : []); const scores = grades.map(item => average(item.scores)); return <div className="comparison-line" key={arm}><span className="comparison-arm">{arm === 'expert' ? '专家策略' : '普通 Agent'}</span><b>{scores.length ? average(scores).toFixed(2) : '—'}</b><span>已评 {grades.length}/{group.length}</span><span>达标 {pct(scores.filter(value => value >= 4).length, scores.length)}</span><span>引用正确 {pct(grades.filter(item => item.citation === '正确').length, grades.filter(item => item.citation !== '不适用').length)}</span><span>完整 {pct(grades.filter(item => item.complete).length, grades.length)}</span></div>; })}</article>; })}{visibleRecords.map(record => <details className="comparison-record" key={record.id}><summary><span>{record.case.product} · {record.case.prompt}</span><small>{record.baseline.status} / {record.expert.status}</small></summary><p>本地时间 {formatLocalDateTime(record.createdAt)} · {record.runtime} · {record.provider} · {record.model}</p><p>预期 · {record.case.expected}</p><p>参考 · {record.case.reference}</p><p>检索来源 · {record.sources.map(source => source.label).join('、') || '无'}</p>{(['baseline', 'expert'] as const).map(arm => <Review key={arm} run={record} arm={arm} save={grade => void act(() => api.grade(record.id, arm, grade))} />)}</details>)}{!visibleRecords.length && <div className="eval-empty"><Icon name="branch" /><strong>当前筛选范围尚无评测结果</strong><span>保存一个案例并运行对照评测，结果会出现在这里。</span></div>}</div>
    </div>}
  </section>;
}

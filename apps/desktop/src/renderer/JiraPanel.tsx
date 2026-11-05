import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { DesktopApi, JiraIssue, JiraProject, JiraSavedQuery, JiraSearchPage, JiraSettings, Project } from '../../../../packages/domain/src';
import { readableError } from './dictionary-index';
import { JiraIssueDetails } from './JiraIssueDetails';
import { cachedTodayQuery, jiraDateAt, JiraAutoRefreshGate, todayJiraInput } from './jira-auto';
import { Icon } from './ui';
import './jira-dock.css';

function today() { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
interface QuerySelection { date: string; onlyMine: boolean; scope: 'daily' | 'recent'; projectKey: string; projectLabel: string }
export function JiraPanel({ api, settings, projects, projectId, onProjectChange, onAddProject, onConfigure, onCreateIssue, creating, compact = false }: {
  api: DesktopApi; settings: JiraSettings; projects: Project[]; projectId: string;
  onProjectChange: (id: string) => void; onAddProject: () => void; onConfigure: () => void;
  onCreateIssue: (key: string, jiraProjectKey: string) => Promise<void>; creating: boolean; compact?: boolean;
}) {
  const configured = !!settings.baseUrl && !!settings.account && settings.hasPassword;
  const [date, setDate] = useState(today);
  const [dateEdited, setDateEdited] = useState(false);
  const [timeZone, setTimeZone] = useState('');
  const [timeZoneLoading, setTimeZoneLoading] = useState(configured);
  const [timeZoneError, setTimeZoneError] = useState('');
  const [scope, setScope] = useState<'daily' | 'recent'>('daily');
  const [onlyMine, setOnlyMine] = useState(true);
  const [jiraProjectKey, setJiraProjectKey] = useState('*');
  const [jiraProjects, setJiraProjects] = useState<JiraProject[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState('');
  const [result, setResult] = useState<JiraSearchPage | null>(null);
  const [queries, setQueries] = useState<JiraSavedQuery[]>([]);
  const [queryId, setQueryId] = useState('');
  const [historyLoading, setHistoryLoading] = useState(false), [historyError, setHistoryError] = useState('');
  const [searched, setSearched] = useState<(QuerySelection & { timeZone: string }) | null>(null);
  const [filtersDirty, setFiltersDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selected, setSelected] = useState('');
  const [issue, setIssue] = useState<JiraIssue | null>(null);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [autoStatus, setAutoStatus] = useState('正在准备今日任务');
  const [autoFailed, setAutoFailed] = useState(false);
  const [automatic, setAutomatic] = useState(true);
  const sequence = useRef(0), detailSequence = useRef(0);
  const timeZoneSequence = useRef(0), projectSequence = useRef(0), contextSequence = useRef(0), dateTouched = useRef(false), filtersTouched = useRef(false);
  const autoGate = useRef(new JiraAutoRefreshGate()), knownTimeZone = useRef(''), initializing = useRef(false), busy = useRef(false);
  const automaticCheck = useRef(() => {});
  const filterRevision = useRef(0);
  const cachedSelection = useRef<QuerySelection | null>(null);
  const projectOptions = new Map<string, string>();
  const configuredProject = settings.projectKey?.toUpperCase();
  if (configuredProject) projectOptions.set(configuredProject, `${configuredProject}（默认项目）`);
  jiraProjects.forEach(item => { const key = item.key.toUpperCase(); if (key !== '*') projectOptions.set(key, `${key} · ${item.name}${key === configuredProject ? '（默认）' : ''}`); });
  if (jiraProjectKey !== '*' && !projectOptions.has(jiraProjectKey)) projectOptions.set(jiraProjectKey, `${jiraProjectKey}（当前选择）`);
  const selectedProjectLabel = jiraProjectKey === '*' ? '全部可访问项目' : projectOptions.get(jiraProjectKey) || jiraProjectKey;
  const changed = !!searched && (filtersDirty || searched.projectKey !== jiraProjectKey || searched.scope !== scope || scope === 'daily' && searched.date !== date || searched.onlyMine !== onlyMine);
  const currentRecord = queries.find(item => item.id === queryId);
  function markFiltersChanged(dirty = true) {
    filterRevision.current += 1;
    filtersTouched.current = true; autoGate.current.pause(); setAutomatic(false); setAutoFailed(false);
    setAutoStatus('已暂停自动抓取，保留您选择的查询条件。');
    if (dirty && searched) setFiltersDirty(true);
  }
  function restoreQuery(record: JiraSavedQuery, manual = false) {
    sequence.current += 1; detailSequence.current += 1;
    busy.current = false;
    if (manual) markFiltersChanged();
    const key = record.input.projectKey ?? settings.projectKey ?? '*';
    const recordScope = record.input.scope ?? 'daily';
    const projectLabel = key === '*' ? '全部可访问项目' : projectOptions.get(key) || key;
    cachedSelection.current = { date: record.input.date, onlyMine: record.input.onlyMine ?? false, scope: recordScope, projectKey: key, projectLabel };
    setDate(record.input.date); setDateEdited(manual); dateTouched.current = manual;
    setScope(recordScope); setOnlyMine(record.input.onlyMine ?? false); setJiraProjectKey(key);
    setResult(record.page); setSearched({ date: record.input.date, onlyMine: record.input.onlyMine ?? false, scope: recordScope, projectKey: key, projectLabel, timeZone: record.page.timeZone });
    setQueryId(record.id); setFiltersDirty(false); setLoading(false); setIssue(null); setSelected(''); setDetailLoading(false);
    setError(''); setDetailError(''); setTimeZone(record.page.timeZone);
  }
  useEffect(() => {
    const context = ++contextSequence.current;
    const revision = ++filterRevision.current;
    sequence.current += 1; detailSequence.current += 1; timeZoneSequence.current += 1;
    const metadataRequest = timeZoneSequence.current;
    autoGate.current = new JiraAutoRefreshGate(); knownTimeZone.current = ''; cachedSelection.current = null; busy.current = false; initializing.current = configured;
    filtersTouched.current = false; dateTouched.current = false;
    setAutomatic(true); setAutoFailed(false); setAutoStatus('正在确认 Jira 时区并读取本地缓存…');
    setResult(null); setSearched(null); setIssue(null); setSelected(''); setFiltersDirty(false);
    setLoading(false); setDetailLoading(false); setError(''); setDetailError('');
    setQueries([]); setQueryId(''); setHistoryError(''); setTimeZone(''); setTimeZoneError('');
    setDate(today()); setDateEdited(false); setScope('daily'); setOnlyMine(true); setJiraProjectKey('*');
    setHistoryLoading(configured); setTimeZoneLoading(configured);
    if (configured) {
      const history = api.listJiraQueries().then(records => {
        if (context !== contextSequence.current) return [];
        setQueries(records);
        const cached = cachedTodayQuery(records) || records[0];
        if (cached && !filtersTouched.current && revision === filterRevision.current) restoreQuery(cached);
        return records;
      }).catch(reason => {
        if (context === contextSequence.current) setHistoryError(`读取本地抓取记录失败：${readableError(reason)}`);
        return [];
      }).finally(() => { if (context === contextSequence.current) setHistoryLoading(false); });
      const connection = api.testJiraConnection().then(value => {
        // 在边界处验证账户时区，不能用电脑本地日期替代失败的 Jira 元数据。
        jiraDateAt(value.timeZone);
        return value;
      }).catch(reason => {
        if (context === contextSequence.current && revision === filterRevision.current) {
          setTimeZoneError(`未能确认 Jira 时区：${readableError(reason)}。可手动选择日期后抓取，或重试“使用 Jira 今日”。`);
          if (!filtersTouched.current) { setAutoFailed(true); setAutoStatus('自动抓取失败，已有本地记录仍可查看。请手动重试。'); }
        }
        return null;
      }).finally(() => { if (context === contextSequence.current && metadataRequest === timeZoneSequence.current) setTimeZoneLoading(false); });
      void Promise.all([history, connection]).then(([records, value]) => {
        if (context !== contextSequence.current || revision !== filterRevision.current) return;
        initializing.current = false;
        if (!value) return;
        knownTimeZone.current = value.timeZone;
        if (filtersTouched.current || !autoGate.current.active) return;
        setTimeZone(value.timeZone); setTimeZoneError('');
        const currentDate = jiraDateAt(value.timeZone);
        const cached = cachedTodayQuery(records, new Date(), value.timeZone);
        if (cached) restoreQuery(cached);
        void automaticSearch(currentDate);
      });
    }
    return () => { contextSequence.current += 1; sequence.current += 1; detailSequence.current += 1; timeZoneSequence.current += 1; };
  }, [api, configured, settings.baseUrl, settings.account, settings.projectKey, settings.dateFieldId]);
  useEffect(() => {
    const request = ++projectSequence.current;
    setJiraProjects([]); setProjectsError('');
    if (!configured) { setProjectsLoading(false); return; }
    setProjectsLoading(true);
    api.listJiraProjects().then(items => { if (request === projectSequence.current) setJiraProjects(items); })
      .catch(reason => { if (request === projectSequence.current) setProjectsError(`项目列表读取失败：${readableError(reason)}。仍可选择全部可访问项目或已配置默认项目查询。`); })
      .finally(() => { if (request === projectSequence.current) setProjectsLoading(false); });
    return () => { projectSequence.current += 1; };
  }, [configured, settings.baseUrl, settings.account, settings.projectKey]);
  async function loadJiraToday() {
    markFiltersChanged();
    const revision = filterRevision.current;
    const context = contextSequence.current;
    const request = ++timeZoneSequence.current;
    setTimeZoneLoading(true); setTimeZoneError('');
    try {
      const connection = await api.testJiraConnection();
      const currentDate = jiraDateAt(connection.timeZone);
      if (request !== timeZoneSequence.current || context !== contextSequence.current || revision !== filterRevision.current) return;
      knownTimeZone.current = connection.timeZone;
      setTimeZone(connection.timeZone);
      setDate(currentDate); dateTouched.current = false; setDateEdited(false);
    } catch (reason) { if (request === timeZoneSequence.current) setTimeZoneError(`未能确认 Jira 时区：${readableError(reason)}。可手动选择日期后抓取，或重试“使用 Jira 今日”。`); }
    finally { if (request === timeZoneSequence.current) setTimeZoneLoading(false); }
  }
  async function performSearch(query: QuerySelection, startAt = 0, automaticRequest = false) {
    const context = contextSequence.current;
    const request = ++sequence.current;
    busy.current = true;
    detailSequence.current += 1;
    setLoading(true); setError(''); setDetailError(''); setIssue(null); setSelected(''); setDetailLoading(false);
    try {
      const next = await api.searchJiraIssues({ date: query.date, startAt, onlyMine: query.onlyMine, scope: query.scope, projectKey: query.projectKey });
      if (request !== sequence.current || context !== contextSequence.current) return;
      setResult(next); setSearched({ ...query, timeZone: next.timeZone }); setFiltersDirty(false); setTimeZone(next.timeZone); setTimeZoneError('');
      cachedSelection.current = query;
      knownTimeZone.current = next.timeZone;
      if (automaticRequest) { setAutoFailed(false); setAutoStatus(`已自动更新 ${query.date} 的本人任务 · ${next.timeZone}`); }
      try {
        const records = await api.listJiraQueries();
        if (request !== sequence.current || context !== contextSequence.current) return;
        setQueries(records); setHistoryError('');
        const record = records.find(item => item.input.date === query.date && (item.input.startAt ?? 0) === startAt && (item.input.projectKey ?? settings.projectKey) === query.projectKey && (item.input.scope ?? 'daily') === query.scope && !!item.input.onlyMine === query.onlyMine);
        setQueryId(record?.id || '');
      } catch (reason) { if (request === sequence.current) setHistoryError(`抓取已完成，本地记录读取失败：${readableError(reason)}`); }
    } catch (reason) {
      if (request === sequence.current && context === contextSequence.current) {
        setError(`${automaticRequest ? '自动抓取失败：' : ''}${readableError(reason)}。已有本地记录将保留，可手动重试。`);
        if (automaticRequest) {
          setAutoFailed(true); setAutoStatus('今日自动抓取失败，已有缓存仍保留；不会自动重复重试。');
          // 自动刷新失败仍允许查阅原缓存，日期和条件显示为缓存自身的快照。
          const cached = cachedSelection.current;
          if (cached) { setDate(cached.date); setScope(cached.scope); setOnlyMine(cached.onlyMine); setJiraProjectKey(cached.projectKey); setFiltersDirty(false); }
        }
      }
    } finally { if (request === sequence.current && context === contextSequence.current) { busy.current = false; setLoading(false); } }
  }
  function search(startAt = 0) {
    markFiltersChanged(false);
    return performSearch({ date, onlyMine, scope, projectKey: jiraProjectKey, projectLabel: selectedProjectLabel }, startAt);
  }
  function automaticSearch(currentDate: string, force = false) {
    if (!autoGate.current.claim(currentDate, force)) return;
    const input = todayJiraInput(currentDate);
    setDate(input.date); setScope('daily'); setOnlyMine(true); setJiraProjectKey('*');
    setDateEdited(false); dateTouched.current = false; setFiltersDirty(false);
    setAutoFailed(false); setAutoStatus(`正在自动抓取 ${currentDate} 的本人任务…`);
    return performSearch({ date: currentDate, onlyMine: true, scope: 'daily', projectKey: '*', projectLabel: '全部可访问项目' }, 0, true);
  }
  async function resumeAutomatic() {
    filterRevision.current += 1;
    const context = contextSequence.current;
    const request = ++timeZoneSequence.current;
    autoGate.current.resume(); filtersTouched.current = false; setAutomatic(true); setAutoFailed(false); setError('');
    initializing.current = true; setTimeZoneLoading(true); setTimeZoneError(''); setAutoStatus('正在重新确认 Jira 今日…');
    try {
      const connection = await api.testJiraConnection();
      const currentDate = jiraDateAt(connection.timeZone);
      if (request !== timeZoneSequence.current || context !== contextSequence.current || !autoGate.current.active) return;
      knownTimeZone.current = connection.timeZone; setTimeZone(connection.timeZone);
      await automaticSearch(currentDate, true);
    } catch (reason) {
      if (request === timeZoneSequence.current && context === contextSequence.current && autoGate.current.active) {
        setTimeZoneError(`未能确认 Jira 时区：${readableError(reason)}`); setAutoFailed(true);
        setAutoStatus('自动抓取失败，已有本地记录仍可查看。请手动重试。');
      }
    } finally { if (request === timeZoneSequence.current && context === contextSequence.current) { initializing.current = false; setTimeZoneLoading(false); } }
  }
  automaticCheck.current = () => {
    if (!configured || initializing.current || busy.current || !autoGate.current.active || !knownTimeZone.current) return;
    void automaticSearch(jiraDateAt(knownTimeZone.current));
  };
  useEffect(() => {
    const check = () => { if (!document.hidden) automaticCheck.current(); };
    window.addEventListener('focus', check); document.addEventListener('visibilitychange', check);
    const timer = window.setInterval(check, 60000);
    return () => { window.removeEventListener('focus', check); document.removeEventListener('visibilitychange', check); window.clearInterval(timer); };
  }, []);
  async function read(key: string) {
    if (!searched || changed || loading) return;
    const request = ++detailSequence.current;
    setSelected(key); setIssue(null); setDetailError(''); setDetailLoading(true);
    try { const next = await api.getJiraIssue(key, searched.projectKey); if (request === detailSequence.current) setIssue(next); }
    catch (reason) { if (request === detailSequence.current) setDetailError(readableError(reason)); }
    finally { if (request === detailSequence.current) setDetailLoading(false); }
  }
  function submit(event: FormEvent) { event.preventDefault(); void search(); }
  return <section className={`jira-page${compact ? ' jira-dock' : ''}`} aria-label={compact ? 'Jira 任务面板' : 'Jira 任务工作台'}>
    <div className="jira-page-header"><div><span className="jira-eyebrow">需求进入研发工作区</span><h1>Jira 任务</h1><p>抓取项目任务，核对需求后关联本地项目。</p></div><button className="secondary-button" onClick={onConfigure}><Icon name="settings" />Jira 连接设置</button></div>
    {!configured && <div className="jira-setup-notice"><Icon name="settings" /><span>请先配置 Jira 地址、账号和密码，保存后将自动读取今日分配给您的任务。</span><button className="text-button" onClick={onConfigure}>配置 Jira 连接</button></div>}
    {configured && <>
    <div className={`jira-auto-status${autoFailed ? ' failed' : ''}`} aria-label="Jira 自动抓取状态" role="status"><span><Icon name={autoFailed ? 'alert' : 'refresh'} />{autoStatus}</span>{(!automatic || autoFailed) && <button className="secondary-button" disabled={loading || timeZoneLoading} onClick={() => void resumeAutomatic()}>{autoFailed && automatic ? '重试自动抓取' : '恢复今日自动抓取'}</button>}</div>
    <p className="jira-query-snapshot" aria-label="Jira 查询条件快照"><strong>{searched ? '本次结果' : '待查询'}：</strong>项目：{searched?.projectLabel || selectedProjectLabel} · {((searched?.scope || scope) === 'daily') ? `日报日期：${searched?.date || date}（${searched?.timeZone || timeZone || 'Jira 时区待确认'}）` : '最近任务（不限日报日期）'} · 负责人：{(searched?.onlyMine ?? onlyMine) ? '仅本人' : '全部'}</p>
    <details className="jira-query-controls" open={!compact}><summary>查询条件与历史</summary>
    <div className="jira-query-history"><label>本地抓取记录<select aria-label="Jira 抓取记录" value={queryId} disabled={historyLoading || loading} onChange={event => { const record = queries.find(item => item.id === event.target.value); if (record) restoreQuery(record, true); }}><option value="">{historyLoading ? '正在读取本地记录…' : queries.length ? '选择已保存的抓取记录' : '暂无本地记录，首次使用请抓取任务'}</option>{queries.map(item => <option key={item.id} value={item.id}>{new Date(item.savedAt).toLocaleString('zh-CN')} · {item.input.projectKey === '*' ? '全部项目' : item.input.projectKey || settings.projectKey} · {item.input.scope === 'recent' ? '最近任务' : item.input.date} · {item.input.onlyMine ? '本人' : '全部负责人'} · {item.page.startAt + 1} 起</option>)}</select></label><button className="secondary-button" disabled={!configured || loading || changed || !result} onClick={() => search(result?.startAt || 0)}><Icon name="refresh" />刷新当前查询</button>{currentRecord && <p role="status">已恢复本地记录 · 保存于 {new Date(currentRecord.savedAt).toLocaleString('zh-CN')}。可直接查看任务，或刷新获取 Jira 最新数据。</p>}</div>
    {historyError && <p className="jira-project-error" role="alert">{historyError}</p>}
    <form className="jira-filters" onSubmit={submit}>
      <label className="jira-filter-field jira-project-filter">Jira 项目范围<select aria-label="Jira 项目范围" value={jiraProjectKey} onChange={event => { markFiltersChanged(); setJiraProjectKey(event.target.value); }} disabled={loading}><option value="*">全部可访问项目</option>{[...projectOptions].map(([key, label]) => <option value={key} key={key}>{label}</option>)}</select></label>
      <label className="jira-filter-field">查询范围<select aria-label="Jira 查询范围" value={scope} onChange={event => { markFiltersChanged(); setScope(event.target.value as 'daily' | 'recent'); }} disabled={loading}><option value="daily">日报日期</option><option value="recent">最近任务（不限日报日期）</option></select></label>
      <label className="jira-filter-field">日报日期<input aria-label="Jira 任务日期" type="date" required={scope === 'daily'} value={date} onChange={event => { markFiltersChanged(); dateTouched.current = true; setDateEdited(true); setDate(event.target.value); }} disabled={loading || scope !== 'daily'} /></label>
      <button className="secondary-button jira-today-button" type="button" disabled={!configured || timeZoneLoading || loading || scope !== 'daily'} onClick={() => loadJiraToday()}>{timeZoneLoading && scope === 'daily' ? '正在确认 Jira 时区…' : '使用 Jira 今日'}</button>
      <label className="jira-only-mine"><input aria-label="仅我的 Jira 任务" type="checkbox" checked={onlyMine} onChange={event => { markFiltersChanged(); setOnlyMine(event.target.checked); }} disabled={loading} />仅我的任务</label>
      <button className="primary-button" disabled={!configured || loading || scope === 'daily' && (!date || !dateEdited && (!timeZone || timeZoneLoading))}><Icon name={loading ? 'refresh' : 'download'} />{loading ? '正在抓取…' : '抓取任务'}</button>
    </form>
    <p className="jira-query-hint">{scope === 'recent' ? '最近任务不限日报日期，按更新时间排序。' : result || timeZone ? `查询日期按 Jira 账户时区 ${result?.timeZone || timeZone} 解释。` : timeZoneLoading ? '正在读取 Jira 账户时区，以确认默认日期。手动选择的日期将保持原样。' : '查询日期按 Jira 账户时区解释，请先配置连接或手动选择日期。'}{projectsLoading && ' 正在读取可访问项目列表。'}</p>
    </details>
    {changed && <div className="jira-setup-notice jira-stale-notice" role="status"><Icon name="alert" /><span>查询条件已更改，以下结果尚未刷新。请重新抓取后查看任务或创建会话。</span></div>}
    {projectsError && <p className="jira-project-error" role="alert">{projectsError}</p>}
    {scope === 'daily' && timeZoneError && <div className="form-error" role="alert"><Icon name="alert" />{timeZoneError}</div>}
    {error && <div className="form-error" role="alert"><Icon name="alert" />{error}</div>}
    <div className="jira-browser">
      <section className="jira-results" aria-label="Jira 任务列表"><div className="jira-list-heading"><strong>{loading ? '正在读取 Jira' : result ? `共 ${result.total.toLocaleString('zh-CN')} 项任务` : '待抓取任务'}</strong>{result && <span>{result.issues.length ? `${result.startAt + 1}–${result.startAt + result.issues.length}` : '0'} / {result.total}</span>}</div>
        {loading && !result ? <div className="jira-empty" role="status"><Icon name="refresh" /><strong>正在抓取任务</strong><p>通过已保存的 Jira 连接查询真实数据。</p></div> : result?.issues.length ? <div className="jira-issue-list">{result.issues.map(item => <button key={item.id || item.key} className={`jira-issue-row ${selected === item.key ? 'selected' : ''}`} aria-label={`查看 Jira 任务 ${item.key}`} aria-pressed={selected === item.key} disabled={changed || loading} onClick={() => read(item.key)}><div><strong>{item.key}</strong><span>{item.status}</span></div><b>{item.summary}</b><small>项目 {item.key.replace(/-\d+$/, '')} · {item.issueType} · {item.assignee || '未分配'}{item.priority ? ` · ${item.priority}` : ''}</small></button>)}</div> : <div className="jira-empty"><Icon name="file" /><strong>{result ? searched?.scope === 'daily' ? '该日期没有匹配任务' : '当前条件没有匹配任务' : '选择查询范围后抓取 Jira 任务'}</strong><p>{result ? '请检查项目范围、日期和负责人条件，调整后重新抓取。' : '无需先添加本地项目，即可查看需求。'}</p></div>}
        {result && <div className="jira-pagination"><button className="secondary-button" aria-label="Jira 任务上一页" disabled={loading || changed || result.startAt <= 0} onClick={() => search(Math.max(0, result.startAt - result.maxResults))}>上一页</button><span>每页 {result.maxResults} 项</span><button className="secondary-button" aria-label="Jira 任务下一页" disabled={loading || changed || result.isLast || result.startAt + result.issues.length >= result.total} onClick={() => search(result.startAt + result.maxResults)}>下一页</button></div>}
      </section>
      <section className="jira-detail-panel" aria-label="任务详情与本地项目">
        {detailLoading ? <div className="jira-empty" role="status"><Icon name="refresh" /><strong>正在读取 {selected}</strong><p>获取任务描述与附件元数据。</p></div> : detailError ? <div className="jira-detail-error"><div className="form-error" role="alert"><Icon name="alert" />{detailError}</div><button className="secondary-button" disabled={changed || loading} onClick={() => read(selected)}>重试任务详情</button></div> : issue ? <><JiraIssueDetails issue={issue} compact={compact} /><div className="jira-create-session"><label>关联本地项目<select aria-label="Jira 关联本地项目" value={projectId} onChange={event => onProjectChange(event.target.value)} disabled={creating}><option value="">请选择本地 Git 项目</option>{projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><button className="secondary-button" onClick={onAddProject} disabled={creating}><Icon name="folder" />添加本地项目</button><button className="primary-button" onClick={() => { if (searched && !changed) void onCreateIssue(issue.key, searched.projectKey); }} disabled={!projectId || creating || changed || loading || !searched}><Icon name="plus" />{creating ? '正在创建隔离会话…' : '从此任务创建会话'}</button><p>创建时重新读取 Jira 任务并保存真实快照，准备任务内容后由您点击发送。</p></div></> : <div className="jira-empty"><Icon name="chat" /><strong>选择一项任务查看详情</strong><p>描述、附件与原始链接会显示在这里。</p></div>}
      </section>
    </div>
    {result && <details className="jira-query-details"><summary>查看本次查询信息</summary><code>{result.jql}</code><span>读取于 {new Date(result.fetchedAt).toLocaleString('zh-CN')}</span></details>}
    </>}
  </section>;
}

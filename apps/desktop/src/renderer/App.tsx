import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { AgentEvent, AgentMode, Bootstrap, FileDiff, LayoutPreferences, ProductSystem, ReasoningEffort, SessionStatus, SettingsSnapshot } from '../../../../packages/domain/src';
import { Icon, Mark } from './ui';
import { SettingsPanel, type SettingsTab } from './SettingsPanel';
import { GitPanel } from './GitPanel';
import { JiraPanel } from './JiraPanel';
import { JiraIssueDetails, jiraTaskPrompt } from './JiraIssueDetails';
import { engineText, engineVersion, toolPlatformText } from './branding';
import { ProjectRow } from './ProjectRow';
import { SessionRow } from './SessionRow';


const statusLabels: Record<SessionStatus, string> = { idle: '就绪', running: '运行中', 'waiting-approval': '等待审批', completed: '已完成', failed: '失败', interrupted: '已中断' };
const defaultLayout: LayoutPreferences = { leftVisible: true, rightVisible: true, bottomVisible: true };
function time(value: string) { return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
function message(error: unknown) { return engineText(error instanceof Error ? error.message : String(error)); }
function mergeEvents(a: AgentEvent[], b: AgentEvent[]) {
  const events = new Map(a.map(event => [event.id, event]));
  b.forEach(event => events.set(event.id, event));
  return [...events.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}
function timeline(events: AgentEvent[]) {
  const rows: { id: string; type: AgentEvent['type']; text: string; createdAt: string }[] = [];
  for (const event of events) {
    const last = rows[rows.length - 1];
    if (event.type === 'delta' && last?.type === 'delta') last.text += event.text;
    else if (event.type === 'message' && last?.type === 'delta' && last.text.trim() === event.text.trim()) last.type = 'message';
    else rows.push({ ...event });
  }
  return rows;
}
function diffLines(value: string) {
  let oldLine = 0, newLine = 0;
  return value.split('\n').map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, kind: 'hunk', old: '', next: '' }; }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('new file') || text.startsWith('deleted file') || text.startsWith('\\')) return { text, kind: 'meta', old: '', next: '' };
    if (text.startsWith('+')) return { text, kind: 'addition', old: '', next: newLine++ };
    if (text.startsWith('-')) return { text, kind: 'deletion', old: oldLine++, next: '' };
    if (text.startsWith(' ') && (oldLine || newLine)) return { text, kind: '', old: oldLine++, next: newLine++ };
    return { text, kind: 'meta', old: '', next: '' };
  });
}

export function App() {
  const api = window.jinggong;
  const [data, setData] = useState<Bootstrap | null>(null);
  const [projectId, setProjectId] = useState('');
  const [jiraLocalProjectId, setJiraLocalProjectId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState('');
  const [diffBusy, setDiffBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('providers');
  const [inspector, setInspector] = useState<'jira' | 'diff' | 'context' | 'git'>('jira');
  const [layout, setLayout] = useState<LayoutPreferences>(defaultLayout);
  const [activityTab, setActivityTab] = useState<'output' | 'tools'>('output');
  const [draftProvider, setDraftProvider] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftMode, setDraftMode] = useState<AgentMode>('develop');
  const [draftSystem, setDraftSystem] = useState<ProductSystem>('通用');
  const [draftReasoning, setDraftReasoning] = useState<ReasoningEffort | ''>('');
  const [sending, setSending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const selectedSessionRef = useRef('');
  const diffSequence = useRef(0);
  const layoutRef = useRef<LayoutPreferences>(defaultLayout);
  const savedLayoutRef = useRef<LayoutPreferences>(defaultLayout);
  const layoutQueue = useRef<Promise<void>>(Promise.resolve());
  const activityEndRef = useRef<HTMLDivElement>(null);
  const project = data?.projects.find(item => item.id === projectId);
  const jiraAssociationId = data?.projects.some(item => item.id === jiraLocalProjectId) ? jiraLocalProjectId : projectId;
  const session = data?.sessions.find(item => item.id === sessionId);
  const sessionTitle = session?.alias ?? session?.title;
  const status = sessionId ? statuses[sessionId] || session?.status || 'idle' : 'idle';
  const running = status === 'running' || status === 'waiting-approval' || sending;
  const sessionEvents = events[sessionId] || [];
  const rows = useMemo(() => timeline(sessionEvents), [sessionEvents]);
  const activityEvents = useMemo(() => sessionEvents.filter(event => activityTab === 'tools' ? event.type === 'tool' || event.type === 'approval' : ['tool', 'approval', 'status', 'error'].includes(event.type)), [sessionEvents, activityTab]);
  const activeDiff = diffs.find(file => file.path === selectedFile) || diffs[0];
  const configuredProvider = data?.settings?.providers.find(item => item.id === session?.providerId) || (!session?.providerId ? data?.settings?.providers[0] : undefined);
  const selectedProvider = data?.settings?.providers.find(item => item.id === draftProvider);
  const modeLabel = session ? session.mode === 'develop' ? '隔离开发' : '只读分析' : '隔离开发';
  const configurationChanged = !!session && (draftProvider !== (session.providerId || data?.settings?.providers[0]?.id || '') || draftModel !== session.model || draftMode !== (session.mode || 'read') || draftSystem !== (session.system || '通用') || draftReasoning !== (session.reasoningEffort || ''));

  async function refresh() {
    const next = await api.bootstrap();
    setData(next);
    return next;
  }
  function settingsChanged(settings: SettingsSnapshot) {
    setData(current => current ? { ...current, settings } : current);
    void refresh().catch(reason => setError(message(reason)));
  }
  function openSettings(tab: typeof settingsTab = 'providers') { setSettingsTab(tab); setShowSettings(true); }
  function changeLayout(patch: Partial<LayoutPreferences>) {
    const next = { ...layoutRef.current, ...patch };
    layoutRef.current = next; setLayout(next);
    layoutQueue.current = layoutQueue.current.catch(() => {}).then(async () => {
      try {
        const saved = await api.saveLayout(next); savedLayoutRef.current = saved;
        setData(current => current ? { ...current, layout: saved } : current);
      } catch (reason) {
        if (layoutRef.current === next) { layoutRef.current = savedLayoutRef.current; setLayout(savedLayoutRef.current); }
        setError(`布局保存失败：${message(reason)}`);
      }
    });
  }
  function showJira() {
    setInspector('jira');
    if (!layoutRef.current.rightVisible) changeLayout({ rightVisible: true });
  }
  useEffect(() => {
    const preferences = data?.settings?.preferences;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    function apply() {
      document.documentElement.dataset.theme = !preferences || preferences.theme === 'system' ? query.matches ? 'dark' : 'light' : preferences.theme;
      document.documentElement.dataset.style = preferences?.style || 'jinggong';
    }
    apply(); query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [data?.settings?.preferences]);
  useEffect(() => {
    setDraftProvider(session?.providerId || data?.settings?.providers[0]?.id || '');
    setDraftModel(session?.model || data?.settings?.providers[0]?.models[0] || '');
    setDraftMode(session ? session.mode || 'read' : 'develop');
    setDraftSystem(session?.system || '通用');
    setDraftReasoning(session?.reasoningEffort || '');
  }, [session?.id, session?.providerId, session?.model, session?.mode, session?.system, session?.reasoningEffort, data?.settings?.providers]);
  async function configure() {
    if (!session || !draftProvider || !draftModel) return;
    setBusy('configure'); setError('');
    try {
      await api.configureSession(session.id, { providerId: draftProvider, model: draftModel, mode: draftMode, system: draftSystem, reasoningEffort: draftReasoning || undefined });
      await refresh(); setNotice('会话配置已更新。');
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function refreshDiff(id = sessionId) {
    const sequence = ++diffSequence.current;
    if (!id) { setDiffs([]); return; }
    setDiffBusy(true);
    try {
      const next = await api.getDiff(id);
      if (sequence !== diffSequence.current) return;
      setDiffs(next);
      setSelectedFile(current => next.some(file => file.path === current) ? current : next[0]?.path || '');
    } catch (reason) { if (sequence === diffSequence.current) setError(message(reason)); }
    finally { if (sequence === diffSequence.current) setDiffBusy(false); }
  }

  useEffect(() => {
    let alive = true;
    if (!api) { setError('桌面桥接未就绪，请通过精工 Agent 桌面程序打开。'); return; }
    api.bootstrap().then(next => {
      if (!alive) return;
      setData(next);
      layoutRef.current = next.layout; savedLayoutRef.current = next.layout; setLayout(next.layout);
      const recent = next.sessions[0];
      setProjectId(recent?.projectId || next.projects[0]?.id || '');
      setSessionId(recent?.id || '');
    }).catch(reason => alive && setError(message(reason)));
    const off = api.onEvent(event => {
      if (!alive) return;
      setEvents(current => ({ ...current, [event.sessionId]: mergeEvents(current[event.sessionId] || [], [event]) }));
      if (event.type === 'status' && event.text in statusLabels) {
        setStatuses(current => ({ ...current, [event.sessionId]: event.text as SessionStatus }));
      }
    });
    return () => { alive = false; off(); };
  }, [api]);

  useEffect(() => {
    selectedSessionRef.current = sessionId;
    if (!sessionId || !api) { setDiffs([]); return; }
    let alive = true;
    setError('');
    api.getEvents(sessionId).then(next => {
      if (alive) setEvents(current => ({ ...current, [sessionId]: mergeEvents(next, current[sessionId] || []) }));
    }).catch(reason => alive && setError(message(reason)));
    void refreshDiff(sessionId);
    return () => { alive = false; };
  }, [sessionId]);

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }); }, [sessionEvents.length, rows[rows.length - 1]?.text]);
  useEffect(() => { if (layout.bottomVisible) activityEndRef.current?.scrollIntoView({ block: 'end' }); }, [activityEvents.length, layout.bottomVisible]);
  useEffect(() => {
    if (sessionId && !running) void refreshDiff(sessionId);
  }, [status]);

  async function addProject(keepConversation = false) {
    setBusy('project'); setError(''); setNotice('');
    try {
      const selected = await api.selectProject();
      if (!selected) return;
      await refresh();
      if (keepConversation) setJiraLocalProjectId(selected.id);
      else { setProjectId(selected.id); setSessionId(''); }
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function newSession() {
    if (!projectId) return;
    setBusy('session'); setError(''); setNotice('');
    try {
      const created = await api.createSession(projectId);
      await refresh();
      setSessionId(created.id);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function sessionFromJira(key: string, jiraProjectKey: string) {
    if (!jiraAssociationId) return;
    setBusy('jira-session'); setError(''); setNotice('');
    try {
      const created = await api.createSession(jiraAssociationId, key, jiraProjectKey);
      await refresh(); setProjectId(created.projectId); setSessionId(created.id);
      if (created.jiraIssue) { setPrompt(jiraTaskPrompt(created.jiraIssue)); setNotice(`已关联 ${created.jiraIssue.key} 并准备任务内容，请核对后点击发送。`); }
      else { setPrompt(''); setError('会话已创建，但未返回 Jira 任务快照，请检查任务关联后再发送。'); }
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!prompt.trim() || !session || running) return;
    if (!configuredProvider?.hasKey) { openSettings(); return; }
    if (configurationChanged) { setError('请先应用会话设置，再发送任务。'); return; }
    const text = prompt.trim();
    const id = session.id;
    setError(''); setNotice(''); setSending(true);
    setStatuses(current => ({ ...current, [id]: 'running' }));
    setPrompt('');
    try {
      await api.sendTurn(id, text);
      const next = await refresh();
      const latest = next.sessions.find(item => item.id === id);
      if (latest) setStatuses(current => ({ ...current, [id]: latest.status }));
      const saved = await api.getEvents(id);
      setEvents(current => ({ ...current, [id]: mergeEvents(saved, current[id] || []) }));
    } catch (reason) {
      setError(message(reason));
      setStatuses(current => ({ ...current, [id]: 'failed' }));
      if (selectedSessionRef.current === id) setPrompt(current => current || text);
    } finally { setSending(false); }
  }
  async function cancel() {
    if (!sessionId) return;
    try { await api.cancelRun(sessionId); setNotice('取消请求已发送，正在等待精工 Agent 引擎停止。'); }
    catch (reason) { setError(message(reason)); }
  }
  async function backup() {
    setBusy('backup'); setError('');
    try { const path = await api.backup(); if (path) setNotice(`本地数据已备份至：${path}`); }
    catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  function inputKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  }

  return <div className={`app-shell dock-layout ${layout.leftVisible ? '' : 'left-panel-hidden'} ${layout.rightVisible ? '' : 'right-panel-hidden'} ${layout.bottomVisible ? '' : 'bottom-panel-hidden'}`}>
    <aside id="project-sidebar" className="sidebar" aria-label="项目和会话" hidden={!layout.leftVisible} inert={showSettings} aria-hidden={showSettings || undefined}>
      <div className="brand"><Mark /><div><strong>精工 Agent</strong><span>研发工作空间</span></div><span className="version">PoC</span></div>
      <div className="sidebar-section top-nav"><button className={`nav-item ${inspector !== 'jira' || !layout.rightVisible ? 'active' : ''}`} onClick={() => document.getElementById('agent-conversation')?.focus()}><Icon name="chat" />Agent 工作台{(inspector !== 'jira' || !layout.rightVisible) && <span className="active-dot" />}</button><button className={`nav-item ${inspector === 'jira' && layout.rightVisible ? 'active' : ''}`} onClick={showJira} disabled={!data}><Icon name="branch" />Jira 任务{inspector === 'jira' && layout.rightVisible && <span className="active-dot" />}</button><button className="nav-item" onClick={() => openSettings('documents')} disabled={!data}><Icon name="file" />生产字典</button><button className="nav-item" onClick={() => openSettings('requirements')} disabled={!data}><Icon name="shield" />开发要求与规范</button><button className="nav-item" onClick={() => openSettings('memories')} disabled={!data}><Icon name="layers" />本地记忆</button></div>
      <div className="sidebar-section projects-heading"><span>本地项目</span><button className="icon-button" onClick={() => { void addProject(); }} disabled={!!busy} title="添加项目目录" aria-label="添加项目目录"><Icon name="plus" /></button></div>
      <div className="project-list">
        {!data?.projects.length && <div className="sidebar-empty">添加 Git 项目，开始一段会话。</div>}
        {data?.projects.map(item => <ProjectRow key={item.id} project={item} selected={item.id === projectId} disabled={!!busy || running} onSelect={() => { setProjectId(item.id); setSessionId(data.sessions.find(s => s.projectId === item.id)?.id || ''); }} onRenamed={async () => { await refresh(); }} />)}
      </div>
      <div className="sidebar-section sessions-heading"><span>项目会话</span><button className="icon-button" onClick={newSession} disabled={!projectId || !!busy} title="新建会话" aria-label="新建会话"><Icon name="plus" /></button></div>
      <div className="session-list">
        {data?.sessions.filter(item => item.projectId === projectId).map(item => <SessionRow key={item.id} session={item} status={statuses[item.id] || item.status} selected={item.id === sessionId} disabled={!!busy || running} onSelect={() => { setSessionId(item.id); setPrompt(''); }} onRenamed={async () => { await refresh(); }} />)}
        {projectId && !data?.sessions.some(item => item.projectId === projectId) && <div className="sidebar-empty">此项目还没有会话。<button className="text-button" onClick={newSession} disabled={!!busy}>创建第一个会话</button></div>}
      </div>
      <div className="sidebar-footer">
        <div className={`runtime-summary ${data?.runtime.compatible ? 'ready' : ''}`} title={engineText(data?.runtime.detail)}><span className="connection-dot" /><span>{data ? data.runtime.compatible ? '精工 Agent 引擎已就绪' : '精工 Agent 引擎需要检查' : error ? '启动检查失败' : '正在检查本机环境…'}</span><span className="runtime-version">{engineVersion(data?.runtime.version)}</span></div>
        <div className="sidebar-actions"><button onClick={() => openSettings()} disabled={!data}><Icon name="settings" />模型设置</button><button onClick={backup} disabled={!data || !!busy} title="备份本地数据" aria-label="备份本地数据"><Icon name="download" /></button></div>
        <div className="local-caption"><Icon name="shield" />数据保存在当前 Windows 用户本机</div>
      </div>
    </aside>

    <div className="workspace" inert={showSettings} aria-hidden={showSettings || undefined}>
      <header className="workspace-header">
        <div className="breadcrumbs"><span>工作空间</span><Icon name="chevron" /><strong>{project?.name || '欢迎使用'}</strong>{session && <><Icon name="chevron" /><span className="breadcrumb-session">{sessionTitle}</span></>}</div>
        <div className="header-actions"><div className="panel-toggles" role="group" aria-label="工作区面板显示"><button className={`icon-button ${layout.leftVisible ? 'panel-visible' : ''}`} aria-label={layout.leftVisible ? '隐藏项目侧栏' : '显示项目侧栏'} title={layout.leftVisible ? '隐藏项目侧栏' : '显示项目侧栏'} aria-controls="project-sidebar" aria-expanded={layout.leftVisible} disabled={!data} onClick={() => changeLayout({ leftVisible: !layoutRef.current.leftVisible })}><Icon name="panel-left" /></button><button className={`icon-button ${layout.rightVisible ? 'panel-visible' : ''}`} aria-label={layout.rightVisible ? '隐藏右侧面板' : '显示右侧面板'} title={layout.rightVisible ? '隐藏右侧面板' : '显示右侧面板'} aria-controls="right-panel" aria-expanded={layout.rightVisible} disabled={!data} onClick={() => changeLayout({ rightVisible: !layoutRef.current.rightVisible })}><Icon name="panel-right" /></button><button className={`icon-button ${layout.bottomVisible ? 'panel-visible' : ''}`} aria-label={layout.bottomVisible ? '隐藏底部面板' : '显示底部面板'} title={layout.bottomVisible ? '隐藏底部面板' : '显示底部面板'} aria-controls="bottom-panel" aria-expanded={layout.bottomVisible} disabled={!data} onClick={() => changeLayout({ bottomVisible: !layoutRef.current.bottomVisible })}><Icon name="panel-bottom" /></button></div><span className="mode-badge"><Icon name="shield" />{modeLabel}</span><button className="icon-button" title="模型设置" aria-label="打开模型设置" onClick={() => openSettings()} disabled={!data}><Icon name="settings" /></button></div>
      </header>
      {(error || notice) && <div className={`banner ${error ? 'error' : 'notice'}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'alert' : 'check'} /><span>{error || notice}</span><button className="icon-button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}><Icon name="close" /></button></div>}
      <div className={`workspace-body ${inspector === 'git' ? 'with-git-inspector' : ''} ${inspector === 'jira' ? 'with-jira-inspector' : ''}`}>
        <main id="agent-conversation" className="conversation" tabIndex={-1} aria-label="Agent 会话工作区">
          {session ? <>
            <div className="conversation-topline"><span><Icon name="chat" />{sessionTitle}</span><span className={`status-label ${status}`}><span className="status-dot" />{statusLabels[status]}</span></div>
            <div className="session-configuration" aria-label="会话配置">
              <label>中转站<select aria-label="会话中转站" value={draftProvider} disabled={running || !!busy} onChange={e => { const profile = data?.settings.providers.find(item => item.id === e.target.value); setDraftProvider(e.target.value); setDraftModel(profile?.models[0] || ''); }}>{!draftProvider && <option value="">请先配置中转站</option>}{draftProvider && !selectedProvider && <option value={draftProvider}>原中转站已删除</option>}{data?.settings?.providers.map(item => <option value={item.id} key={item.id}>{item.name}{item.hasKey ? '' : '（未配置密钥）'}</option>)}</select></label>
              <label>模型<select aria-label="会话模型" value={draftModel} disabled={running || !!busy || !selectedProvider} onChange={e => setDraftModel(e.target.value)}>{!draftModel && <option value="">请选择模型</option>}{draftModel && !selectedProvider?.models.includes(draftModel) && <option value={draftModel}>{draftModel}（不在当前列表）</option>}{selectedProvider?.models.map(item => <option key={item}>{item}</option>)}</select></label>
              <label>系统<select aria-label="会话适用系统" value={draftSystem} disabled={running || !!busy} onChange={e => setDraftSystem(e.target.value as ProductSystem)}>{['通用', 'MES5', 'MES6', 'WMS'].map(item => <option key={item}>{item}</option>)}</select></label>
              <label>模式<select aria-label="会话执行模式" value={draftMode} disabled={running || !!busy} onChange={e => setDraftMode(e.target.value as AgentMode)}><option value="read">只读分析</option><option value="develop">隔离开发</option></select></label>
              <label>推理强度<select aria-label="推理强度" value={draftReasoning} disabled={running || !!busy} onChange={event => setDraftReasoning(event.target.value as ReasoningEffort | '')}>{([{ value: '', label: '模型默认' }, { value: 'none', label: '无' }, { value: 'minimal', label: '最低' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '超高' }] as const).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <button className="secondary-button" disabled={running || !!busy || !configurationChanged || !draftProvider || !draftModel} onClick={configure}>{busy === 'configure' ? '应用中…' : '应用设置'}</button>
            </div>
            {session.jiraIssue && <details className="session-jira-link"><summary><Icon name="branch" /><strong>{session.jiraIssue.key}</strong><span>{session.jiraIssue.summary}</span><small>查看关联任务</small></summary><JiraIssueDetails issue={session.jiraIssue} sessionId={session.id} compact /></details>}
            <div className="messages" aria-live="polite" aria-label="会话消息">
              {!rows.length && <div className="session-welcome"><Mark /><h1>一起理解这个项目</h1><p>描述您要分析的问题、代码或需求。<br />当前为{session.system || '通用'} · {modeLabel}，Agent 使用独立工作区。</p><div className="suggestions">{['梳理项目架构与主要模块', '检查潜在缺陷并说明影响范围', '分析现有测试与构建方式'].map(text => <button key={text} onClick={() => setPrompt(text)}>{text}<Icon name="arrow" /></button>)}</div></div>}
              {rows.map(row => row.type === 'status' ? <div className="event-status" key={row.id}><span /><span>{row.text in statusLabels ? statusLabels[row.text as SessionStatus] : engineText(row.text)}</span></div> : row.type === 'tool' || row.type === 'approval' ? <div className="tool-event" key={row.id}><Icon name={row.type === 'approval' ? 'shield' : 'terminal'} /><div><span>{row.type === 'approval' ? '执行策略' : '工具事件'}</span><pre>{toolPlatformText(row.text)}</pre></div><time>{time(row.createdAt)}</time></div> : <article className={`message ${row.type === 'user' ? 'user' : row.type === 'error' ? 'error' : 'agent'}`} key={row.id}><div className="message-avatar">{row.type === 'user' ? '我' : row.type === 'error' ? <Icon name="alert" /> : <Mark small />}</div><div className="message-content"><div className="message-meta"><strong>{row.type === 'user' ? '您' : row.type === 'error' ? '运行错误' : '精工 Agent'}</strong><time>{time(row.createdAt)}</time></div><div className="message-text">{row.type === 'error' ? engineText(row.text) : row.text}</div></div></article>)}
              {running && <div className="working-indicator"><span /><span /><span /><span className="working-text">Agent 正在处理任务</span></div>}
              <div ref={endRef} />
            </div>
            <div className="composer-container">
              {!configuredProvider?.hasKey && <button className="setup-notice" onClick={() => openSettings()}><Icon name="settings" /><span>配置独立模型凭据后即可开始真实会话</span><Icon name="chevron" /></button>}
              <form className={`composer ${running ? 'is-running' : ''}`} onSubmit={send}>
                <textarea aria-label="输入任务" placeholder="向精工 Agent 描述您的任务…" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={inputKey} disabled={running} rows={3} maxLength={32000} />
                <div className="composer-toolbar"><div className="composer-context"><span title={session.branch}><Icon name="branch" />{session.branch}</span><span className="model-label" title={`${configuredProvider?.name || '未配置中转站'} / ${session.model}`}><Icon name="box" />{session.model || '未配置模型'}</span></div>{running ? <button className="cancel-button" type="button" onClick={cancel}><Icon name="stop" />停止</button> : <button className="send-button" type="submit" disabled={!prompt.trim() || !data?.runtime.compatible || configurationChanged} aria-label="发送任务" title={configurationChanged ? '请先应用会话设置' : '发送任务（Enter）'}><Icon name="arrow" /></button>}</div>
              </form>
              <div className="composer-caption"><span>Enter 发送 · Shift + Enter 换行</span><span>AI 输出需人工核实</span></div>
            </div>
          </> : <div className="welcome-screen"><div className="welcome-content"><div className="welcome-eyebrow"><span />本地优先 · 精工研发</div><Mark /><h1>让想法，进入代码。</h1><p>从本地项目开启一段 Agent 会话，<br />在清晰的上下文中分析代码、审查变更。</p><button className="primary-button" onClick={() => { void (projectId ? newSession() : addProject()); }} disabled={!!busy || !data}><Icon name={projectId ? 'plus' : 'folder'} />{busy === 'session' ? '正在创建隔离工作区…' : busy === 'project' ? '正在选择项目…' : projectId ? '新建 Agent 会话' : '选择本地项目'}<Icon name="chevron" /></button><div className="welcome-steps"><div><span>01</span><strong>选择项目</strong><p>连接本地 Git 仓库</p></div><div><span>02</span><strong>配置模型</strong><p>使用您授权的中转站</p></div><div><span>03</span><strong>开始分析</strong><p>流式查看执行过程</p></div></div></div><div className="welcome-bottom"><Icon name="shield" /><span>每个会话独立工作区，提交与推送均由您确认。</span></div></div>}
        </main>

        <aside id="right-panel" className="inspector" aria-label="右侧任务与代码面板" hidden={!layout.rightVisible}>
          <div className="inspector-tabs" role="group" aria-label="右侧面板分类"><button id="jira-panel-tab" className={inspector === 'jira' ? 'active' : ''} aria-pressed={inspector === 'jira'} aria-controls="jira-panel" onClick={() => setInspector('jira')}>Jira</button><button id="diff-panel-tab" className={inspector === 'diff' ? 'active' : ''} aria-pressed={inspector === 'diff'} aria-controls="diff-panel" onClick={() => setInspector('diff')}>代码变更{diffs.length > 0 && <span>{diffs.length}</span>}</button><button id="git-panel-tab" className={inspector === 'git' ? 'active' : ''} aria-pressed={inspector === 'git'} aria-controls="git-panel" onClick={() => setInspector('git')}>Git</button><button id="context-panel-tab" className={inspector === 'context' ? 'active' : ''} aria-pressed={inspector === 'context'} aria-controls="context-panel" onClick={() => setInspector('context')}>上下文</button><button className={`icon-button ${diffBusy ? 'spinning' : ''}`} onClick={() => refreshDiff()} disabled={!sessionId || diffBusy} title="刷新代码差异" aria-label="刷新代码差异"><Icon name="refresh" /></button></div>
          <div id="jira-panel" className="inspector-panel jira-inspector-panel" role="region" aria-label="右侧 Jira 任务" hidden={inspector !== 'jira'}>{data?.settings && <JiraPanel compact api={api} settings={data.settings.jira} projects={data.projects} projectId={jiraAssociationId} onProjectChange={setJiraLocalProjectId} onAddProject={() => { void addProject(true); }} onConfigure={() => openSettings('jira')} onCreateIssue={sessionFromJira} creating={!!busy || running} />}</div>
          <div id="diff-panel" className="inspector-panel" role="region" aria-labelledby="diff-panel-tab" hidden={inspector !== 'diff'}>
            {diffs.length ? <div className="diff-content"><div className="file-list">{diffs.map(file => <button className={file.path === activeDiff?.path ? 'selected' : ''} key={file.path} onClick={() => setSelectedFile(file.path)} title={file.path}><Icon name="file" /><span>{file.path}</span><b className={`file-status status-${file.status.charAt(0)}`}>{file.status}</b></button>)}</div>{activeDiff && <div className="diff-view"><div className="diff-file-heading"><Icon name="file" /><span>{activeDiff.path}</span></div>{activeDiff.binary && <div className="diff-note">二进制文件发生变更，无法显示文本差异。</div>}{activeDiff.truncated && <div className="diff-note">文件差异较大，当前仅显示部分内容。</div>}<pre aria-label="文件代码差异">{diffLines(activeDiff.diff).map((line, index) => <div key={index} className={`diff-line ${line.kind}`}><span className="diff-line-number">{line.old}</span><span className="diff-line-number">{line.next}</span><span>{line.text || ' '}</span></div>)}</pre></div>}</div> : <div className="inspector-empty"><div className="empty-icon"><Icon name="layers" /></div><strong>{diffBusy ? '正在读取 Git 差异' : session ? '工作区暂无变更' : '代码差异将在这里显示'}</strong><p>{session ? '此处展示隔离工作区与基准提交的真实差异。' : '选择项目并创建会话，即可查看工作区文件变更。'}</p></div>}
            <div className="inspector-footnote"><Icon name="branch" /><span>{session ? '隔离工作区 · 原始项目保持独立' : '每个会话使用独立 Git Worktree'}</span></div>
          </div>
          <div id="git-panel" className="inspector-panel" role="region" aria-labelledby="git-panel-tab" hidden={inspector !== 'git'}>{sessionId ? <GitPanel key={`${sessionId}-${session?.system}-${session?.mode}`} sessionId={sessionId} documents={data?.settings?.documents || []} running={running} onChanged={async () => { await refresh(); await refreshDiff(sessionId); }} /> : <div className="inspector-empty"><div className="empty-icon"><Icon name="branch" /></div><strong>创建会话后管理 Git</strong><p>查看历史、检查开发要求，再由您确认提交和推送。</p></div>}</div>
          <div id="context-panel" className="inspector-panel" role="region" aria-labelledby="context-panel-tab" hidden={inspector !== 'context'}><div className="context-content"><div className="context-label">当前项目</div><strong>{project?.name || '尚未选择'}</strong><code>{project?.path || '通过左侧 + 添加本地 Git 项目'}</code><div className="context-label">会话工作区</div><code>{session?.workspacePath || '新建会话后创建独立工作区'}</code><div className="context-label">适用系统与执行模式</div><div className="context-value"><Icon name="shield" />{session?.system || '通用'} · {modeLabel}</div><p className="context-hint">只加载通用及当前系统资料。隔离开发的写入限于任务工作区，工具能力以运行时策略为准。</p><div className="context-label">模型中转站</div><div className="context-value">{configuredProvider?.name || '未选择'} · Responses</div><code>{configuredProvider?.baseUrl || '尚未配置中转站'}</code><div className="context-label">已启用资料</div>{data?.settings?.documents.filter(item => item.enabled && (item.system === '通用' || item.system === (session?.system || '通用'))).map(item => <div className="context-document" key={item.id}><Icon name="file" /><span>{item.name}<small>{item.system} · {item.kind === 'dictionary' ? '生产字典' : '开发要求'}</small></span></div>)}<button className="text-button" onClick={() => openSettings('documents')} disabled={!data}>管理生产字典</button><button className="text-button" onClick={() => openSettings('requirements')} disabled={!data}>管理开发要求与规范</button><div className="context-label">本机环境</div><div className="environment-row"><span>精工 Agent 引擎</span><b>{engineVersion(data?.runtime.version) || '检查中'}</b></div><div className="environment-row"><span>Git</span><b>{data?.gitVersion || '未检测到'}</b></div><div className="context-label">本地数据目录</div><code>{data?.dataDirectory || '正在初始化'}</code></div></div>
        </aside>
      </div>
      <section id="bottom-panel" className="activity-panel" aria-label="运行输出和工具活动" hidden={!layout.bottomVisible}>
        <div className="activity-panel-header"><div role="group" aria-label="运行活动分类"><button id="activity-output-tab" className={activityTab === 'output' ? 'active' : ''} aria-pressed={activityTab === 'output'} aria-controls="activity-events" onClick={() => setActivityTab('output')}><Icon name="terminal" />运行输出</button><button id="activity-tools-tab" className={activityTab === 'tools' ? 'active' : ''} aria-pressed={activityTab === 'tools'} aria-controls="activity-events" onClick={() => setActivityTab('tools')}>工具活动</button></div><span>{session ? `${activityEvents.length} 条事件` : '尚未选择会话'}</span></div>
        <div id="activity-events" className="activity-events" role="region" aria-labelledby={activityTab === 'output' ? 'activity-output-tab' : 'activity-tools-tab'} tabIndex={0}>{activityEvents.length ? activityEvents.map(event => <div key={event.id} className={`activity-event activity-${event.type}`}><time dateTime={event.createdAt}>{time(event.createdAt)}</time><span>{event.type === 'tool' ? '工具' : event.type === 'approval' ? '审批' : event.type === 'error' ? '错误' : '状态'}</span><pre>{event.type === 'tool' || event.type === 'approval' ? toolPlatformText(event.text) : event.type === 'status' && event.text in statusLabels ? statusLabels[event.text as SessionStatus] : engineText(event.text)}</pre></div>) : <div className="activity-empty"><Icon name="terminal" /><span>{session ? activityTab === 'tools' ? '当前会话尚无工具活动，执行后的真实工具事件会显示在这里。' : '当前会话尚无运行输出，状态、错误与工具事件会显示在这里。' : '选择会话后查看真实运行输出与工具活动。'}</span></div>}<div ref={activityEndRef} /></div>
      </section>
      <footer className="statusbar"><div><span className="statusbar-dot" />本地工作空间<span className="statusbar-separator">/</span><Icon name="shield" />{modeLabel}</div><div><span>Windows 桌面 PoC</span><span className="statusbar-separator">·</span><span>{configuredProvider?.hasKey || !session && data?.settings?.providers.some(item => item.hasKey) ? '模型凭据已加密保存' : '模型凭据待配置'}</span></div></footer>
    </div>
    {showSettings && data?.settings && <SettingsPanel settings={data.settings} initialTab={settingsTab} onClose={() => setShowSettings(false)} onChanged={settingsChanged} />}
  </div>;
}


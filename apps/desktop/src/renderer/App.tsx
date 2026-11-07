import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type UIEvent } from 'react';
import type { AgentEvent, AgentMode, Bootstrap, CompletionSound, ConversationAttachment, FileDiff, LayoutPreferences, ProductSystem, ReasoningEffort, SessionStatus, SettingsSnapshot } from '../../../../packages/domain/src';
import { Icon, Mark } from './ui';
import { SettingsPanel, type SettingsTab } from './SettingsPanel';
import { MarkdownContent } from './MarkdownContent';
import { playCompletionSound } from './completion-sound';
import { GitPanel } from './GitPanel';
import { JiraPanel } from './JiraPanel';
import { JiraIssueDetails, jiraReadiness, jiraTaskPrompt } from './JiraIssueDetails';
import { compactAgentEvent, engineText, engineVersion, sessionDisplayName, toolPlatformText } from './branding';
import { isSessionRunActive } from './session-run-state';
import { isJiraSessionCreating } from './jira-create-state';
import { ProjectRow } from './ProjectRow';
import { SessionRow } from './SessionRow';


const statusLabels: Record<SessionStatus, string> = { idle: '就绪', running: '运行中', 'waiting-approval': '等待审批', completed: '已完成', failed: '失败', interrupted: '已中断' };
const defaultLayout: LayoutPreferences = { leftVisible: true, rightVisible: true, bottomVisible: true, leftWidth: 244, rightWidth: 420, bottomHeight: 180 };
type ResizeKind = 'left' | 'right' | 'bottom' | 'composer';
interface PanelResizeDrag { kind: ResizeKind; startX: number; startY: number; startValue: number; latest: number; pointerId: number; handle: HTMLButtonElement }
interface FileContextMenu { file: FileDiff; x: number; y: number }
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
    const compactText = compactAgentEvent(event);
    if (compactText === null) continue;
    const last = rows[rows.length - 1];
    const display = { ...event, text: compactText };
    if (display.type === 'delta' && last?.type === 'delta') last.text += display.text;
    else if (display.type === 'message' && last?.type === 'delta' && last.text.trim() === display.text.trim()) last.type = 'message';
    else if (display.type === 'tool' && last?.type === 'tool' && last.text === display.text) { /* 合并连续分页读取 */ }
    else rows.push(display);
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
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenu | null>(null);
  const [fileAction, setFileAction] = useState('');
  const [prompt, setPrompt] = useState('');
  const [conversationAttachments, setConversationAttachments] = useState<ConversationAttachment[]>([]);
  const [busy, setBusy] = useState('');
  const [diffBusy, setDiffBusy] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [unread, setUnread] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [showReturnLatest, setShowReturnLatest] = useState(false);
  const [updateDownloadedVersion, setUpdateDownloadedVersion] = useState('');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('providers');
  const [inspector, setInspector] = useState<'jira' | 'diff' | 'context' | 'git'>('jira');
  const [layout, setLayout] = useState<LayoutPreferences>(defaultLayout);
  const [activityTab, setActivityTab] = useState<'output' | 'tools'>('output');
  const [draftProvider, setDraftProvider] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftMode, setDraftMode] = useState<AgentMode>('develop');
  const [draftSystem, setDraftSystem] = useState<ProductSystem>('通用');
  const [draftReasoning, setDraftReasoning] = useState<ReasoningEffort | ''>('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const sessionSettingsRef = useRef<HTMLDivElement>(null);
  const sessionSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const followLatest = useRef(true);
  const completionSoundRef = useRef<CompletionSound>('chime');
  const selectedSessionRef = useRef('');
  const diffSequence = useRef(0);
  const layoutRef = useRef<LayoutPreferences>(defaultLayout);
  const savedLayoutRef = useRef<LayoutPreferences>(defaultLayout);
  const layoutQueue = useRef<Promise<void>>(Promise.resolve());
  const resizeDrag = useRef<PanelResizeDrag | null>(null);
  const runningSessions = useRef(new Set<string>());
  const sessionNames = useRef(new Map<string, string>());
  const activityEndRef = useRef<HTMLDivElement>(null);
  const project = data?.projects.find(item => item.id === projectId);
  const jiraAssociationId = data?.projects.some(item => item.id === jiraLocalProjectId) ? jiraLocalProjectId : projectId;
  const session = data?.sessions.find(item => item.id === sessionId);
  const sessionTitle = session ? sessionDisplayName(session) : '';
  const status = sessionId ? statuses[sessionId] || session?.status || 'idle' : 'idle';
  // status 是持久化展示状态，异常退出后可能仍为 running；输入锁定只看当前进程实际活动任务。
  const running = isSessionRunActive(sessionId, runningSessions.current, sending);
  const sessionEvents = events[sessionId] || [];
  const rows = useMemo(() => timeline(sessionEvents), [sessionEvents]);
  const activityEvents = useMemo(() => {
    const compacted: AgentEvent[] = [];
    for (const event of sessionEvents) {
      const compactText = compactAgentEvent(event);
      if (compactText === null) continue;
      if (activityTab === 'tools' ? event.type !== 'tool' && event.type !== 'approval' : !['tool', 'approval', 'status', 'error'].includes(event.type)) continue;
      const display = { ...event, text: compactText };
      const previous = compacted[compacted.length - 1];
      if (display.type === 'tool' && previous?.type === 'tool' && previous.text === display.text) continue;
      compacted.push(display);
    }
    return compacted;
  }, [sessionEvents, activityTab]);
  const activeDiff = diffs.find(file => file.path === selectedFile) || diffs[0];
  const configuredProvider = data?.settings?.providers.find(item => item.id === session?.providerId) || (!session?.providerId ? data?.settings?.providers[0] : undefined);
  completionSoundRef.current = data?.settings?.preferences.completionSound ?? 'chime';
  const selectedProvider = data?.settings?.providers.find(item => item.id === draftProvider);
  const modeLabel = '开发';
  const configurationChanged = !!session && (draftProvider !== (session.providerId || data?.settings?.providers[0]?.id || '') || draftModel !== session.model || draftMode !== (session.mode || 'develop') || draftSystem !== (session.system || '通用') || draftReasoning !== (session.reasoningEffort || ''));
  sessionNames.current = new Map(data?.sessions.map(item => [item.id, sessionDisplayName(item)]) ?? []);

  async function toggleProject(id: string) {
    const item = data?.projects.find(candidate => candidate.id === id);
    if (!item) return;
    const collapsed = item.collapsed === false;
    setData(current => current ? { ...current, projects: current.projects.map(candidate => candidate.id === id ? { ...candidate, collapsed } : candidate) } : current);
    try { await api.setProjectCollapsed(id, collapsed); }
    catch (reason) { await refresh(); setError(message(reason)); }
  }
  function readSession(id: string) {
    const completionId = unread[id];
    if (!completionId) return;
    setUnread(current => { const next = { ...current }; delete next[id]; return next; });
    setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === id ? { ...item, unreadCompletionId: undefined } : item) } : current);
    void api.markSessionRead(id, completionId).catch(reason => setError(message(reason)));
  }
  async function importSharing() {
    setBusy('share'); setError('');
    try {
      const result = await api.importShare(projectId || undefined);
      if (result) { const next = await refresh(); if (result.sessionId) { const imported = next.sessions.find(item => item.id === result.sessionId); if (imported) { setProjectId(imported.projectId); setSessionId(imported.id); } } }
    } catch (error) { setError(message(error)); }
    finally { setBusy(''); }
  }
  async function refresh() {
    const next = await api.bootstrap();
    setData(next);
    return next;
  }
  function settingsChanged(settings: SettingsSnapshot) {
    setData(current => current ? { ...current, settings } : current);
    void api.bootstrap().then(next => setData(current => current ? { ...current, sessions: next.sessions, provider: next.provider } : current)).catch(reason => setError(message(reason)));
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
  function beginResize(kind: ResizeKind, event: ReactPointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const current = layoutRef.current;
    const startValue = resizeValue(kind, current);
    const handle = event.currentTarget;
    resizeDrag.current = { kind, startX: event.clientX, startY: event.clientY, startValue, latest: startValue, pointerId: event.pointerId, handle };
    handle.dataset.resizing = 'true';
    document.body.dataset.resizing = kind === 'left' || kind === 'right' ? 'column' : 'row';
    handle.setPointerCapture(event.pointerId);
  }
  function resizeValue(kind: ResizeKind, current: LayoutPreferences) {
    return kind === 'left' ? current.leftWidth ?? 244 : kind === 'right' ? current.rightWidth ?? 420 : kind === 'composer' ? current.composerHeight ?? 110 : current.bottomHeight ?? 180;
  }
  function resizePatch(kind: ResizeKind, value: number): Partial<LayoutPreferences> {
    return kind === 'left' ? { leftWidth: value } : kind === 'right' ? { rightWidth: value } : kind === 'composer' ? { composerHeight: value } : { bottomHeight: value };
  }
  function resizeBounds(kind: ResizeKind) {
    const current = layoutRef.current;
    const min = kind === 'left' ? 180 : kind === 'right' ? 260 : kind === 'composer' ? 80 : 100;
    let max = kind === 'left' ? 520 : kind === 'right' ? 680 : kind === 'composer' ? 400 : 480;
    if (kind === 'left' || kind === 'right') {
      const other = kind === 'left' ? current.rightVisible ? current.rightWidth ?? 420 : 0 : current.leftVisible ? current.leftWidth ?? 244 : 0;
      max = Math.min(max, window.innerWidth - other - 360);
    } else {
      const available = document.querySelector(kind === 'composer' ? '.conversation' : '.workspace')?.clientHeight ?? window.innerHeight;
      max = Math.min(max, Math.round(available * (kind === 'composer' ? .5 : .55)));
    }
    return { min, max: Math.max(min, max) };
  }
  function adjustResize(kind: ResizeKind, event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Home') { event.preventDefault(); changeLayout(resizePatch(kind, kind === 'left' ? 244 : kind === 'right' ? 420 : kind === 'composer' ? 110 : 180)); return; }
    const step = event.shiftKey ? 40 : 12;
    let delta = 0;
    if (kind === 'left') delta = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    else if (kind === 'right') delta = event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0;
    else delta = event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0;
    if (!delta) return;
    event.preventDefault();
    const current = layoutRef.current;
    const value = resizeValue(kind, current);
    const { min, max } = resizeBounds(kind);
    const next = Math.max(min, Math.min(max, value + delta));
    changeLayout(resizePatch(kind, next));
  }
  function showJira() {
    setInspector('jira');
    if (!layoutRef.current.rightVisible) changeLayout({ rightVisible: true });
  }
  useEffect(() => {
    const preferences = data?.settings?.preferences;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    function apply() {
      document.documentElement.dataset.theme = !preferences ? 'dark' : preferences.theme === 'system' ? query.matches ? 'dark' : 'light' : preferences.theme;
      document.documentElement.dataset.style = preferences?.style || 'jinggong';
    }
    apply(); query.addEventListener('change', apply);
    return () => query.removeEventListener('change', apply);
  }, [data?.settings?.preferences]);
  useEffect(() => {
    setDraftProvider(session?.providerId || data?.settings?.providers[0]?.id || '');
    setDraftModel(session?.model || data?.settings?.providers[0]?.models[0] || '');
    setDraftMode('develop');
    setDraftSystem(session?.system || '通用');
    setDraftReasoning(session?.reasoningEffort || '');
  }, [session?.id, session?.providerId, session?.model, session?.mode, session?.system, session?.reasoningEffort, data?.settings?.providers[0]?.id, data?.settings?.providers[0]?.models[0]]);
  useEffect(() => {
    let alive = true;
    const target = data?.projects.find(item => item.id === projectId);
    if (!target) { setBranchOptions([]); setBaseBranch(''); return () => { alive = false; }; }
    setBranchLoading(true);
    api.listProjectBranches(target.id).then(branches => {
      if (!alive) return;
      const options = [...new Set(branches.filter(value => value.trim()))];
      setBranchOptions(options);
      setBaseBranch(current => current && options.includes(current) ? current : options.includes(target.branch) ? target.branch : options[0] || target.branch);
    }).catch(() => {
      if (!alive) return;
      setBranchOptions(target.branch && target.branch !== '(detached)' ? [target.branch] : []);
      setBaseBranch(target.branch === '(detached)' ? '' : target.branch);
    }).finally(() => { if (alive) setBranchLoading(false); });
    return () => { alive = false; };
  }, [api, projectId, data?.projects]);
  async function configure() {
    if (!session || !draftProvider || !draftModel) return;
    setBusy('configure'); setError('');
    try {
      await api.configureSession(session.id, { providerId: draftProvider, model: draftModel, mode: draftMode, system: draftSystem, reasoningEffort: draftReasoning || undefined });
      await refresh(); setNotice('会话配置已更新。');
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function switchSessionBranch(value: string) {
    if (!session || !value || value === session.baseBranch || running) return;
    setBusy('branch'); setError(''); setNotice('');
    try {
      const updated = await api.switchSessionBranch(session.id, value);
      setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === updated.id ? updated : item) } : current);
      setEvents(current => ({ ...current, [updated.id]: [] }));
      await refreshDiff(updated.id);
      setNotice(`已切换到基准分支 ${value}，请重新发送任务。`);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function pickConversationAttachments() {
    if (!session || running) return;
    setBusy('attachments'); setError(''); setNotice('');
    try {
      const added = await api.pickAttachments(session.id);
      if (added.length) setConversationAttachments(current => [...current, ...added]);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function refreshDiff(id = sessionId) {
    const sequence = ++diffSequence.current;
    if (!id) { setDiffs([]); return; }
    setDiffBusy(true); setDiffError('');
    try {
      const next = await api.getDiff(id);
      if (sequence !== diffSequence.current) return;
      setDiffs(next);
      setSelectedFile(current => next.some(file => file.path === current) ? current : next[0]?.path || '');
    } catch (reason) { if (sequence === diffSequence.current) { setDiffs([]); setDiffError(message(reason)); } }
    finally { if (sequence === diffSequence.current) setDiffBusy(false); }
  }

  async function runFileAction(action: 'stage' | 'unstage' | 'discard', file: FileDiff) {
    setFileContextMenu(null); setFileAction(`${action}:${file.path}`); setError(''); setNotice('');
    try {
      if (action === 'stage') await api.stageFile(sessionId, file.path);
      else if (action === 'unstage') await api.unstageFile(sessionId, file.path);
      else await api.discardFile(sessionId, file.path);
      await refreshDiff(sessionId); await refresh();
      setNotice(action === 'stage' ? `已暂存文件：${file.path}` : action === 'unstage' ? `已取消暂存：${file.path}` : `已撤销文件变更：${file.path}`);
    } catch (reason) { setError(message(reason)); }
    finally { setFileAction(''); }
  }

  useEffect(() => {
    let alive = true;
    if (!api) { setError('桌面桥接未就绪，请通过精工 Agent 桌面程序打开。'); return; }
    api.bootstrap().then(next => {
      if (!alive) return;
      setData(next);
      setUnread(Object.fromEntries(next.sessions.filter(item => item.unreadCompletionId).map(item => [item.id, item.unreadCompletionId!])));
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
      if (event.type === 'status' && event.text === 'running') runningSessions.current.add(event.sessionId);
      else if (event.type === 'status' && ['completed', 'failed', 'interrupted'].includes(event.text)) {
        const wasRunning = runningSessions.current.delete(event.sessionId);
        if (wasRunning && event.text === 'completed') {
          void refreshDiff(event.sessionId);
          setUnread(current => ({ ...current, [event.sessionId]: event.id }));
          setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === event.sessionId ? { ...item, status: 'completed', unreadCompletionId: event.id } : item) } : current);
          void api.getSettings().then(settings => setData(current => current ? { ...current, settings } : current)).catch(() => {});
          const name = sessionNames.current.get(event.sessionId) || '当前会话';
          setNotice(`会话「${name}」已完成。`);
          void api.notifyCompletion(name.length > 120 ? `${name.slice(0, 119)}…` : name).catch(() => {});
          playCompletionSound(completionSoundRef.current);
        }
      }
    });
    const offUpdate = api.onUpdateStatus(status => {
      if (!alive) return;
      setData(current => current ? { ...current, settings: { ...current.settings, update: status } } : current);
      if (status.state === 'downloaded') { setUpdateDownloadedVersion(status.version ?? ''); setNotice(`精工 Agent ${status.version ?? ''} 更新已下载，可立即重启完成静默更新。`); }
    });
    return () => { alive = false; off(); offUpdate(); };
  }, [api]);

  useEffect(() => {
    function move(event: PointerEvent) {
      const drag = resizeDrag.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const delta = drag.kind === 'left' ? event.clientX - drag.startX : drag.kind === 'right' ? drag.startX - event.clientX : drag.startY - event.clientY;
      const { min, max } = resizeBounds(drag.kind);
      drag.latest = Math.max(min, Math.min(max, Math.round(drag.startValue + delta)));
      const variable = drag.kind === 'left' ? '--sidebar-width' : drag.kind === 'right' ? '--inspector-width' : drag.kind === 'composer' ? '--composer-height' : '--activity-height';
      document.querySelector<HTMLElement>('.dock-layout')?.style.setProperty(variable, `${drag.latest}px`);
    }
    function finish(event: PointerEvent) {
      const drag = resizeDrag.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      resizeDrag.current = null;
      delete drag.handle.dataset.resizing;
      delete document.body.dataset.resizing;
      if (drag.handle.hasPointerCapture(event.pointerId)) drag.handle.releasePointerCapture(event.pointerId);
      changeLayout(resizePatch(drag.kind, drag.latest));
    }
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('lostpointercapture', finish);
    return () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); window.removeEventListener('lostpointercapture', finish); };
  }, []);

  useEffect(() => {
    selectedSessionRef.current = sessionId;
    followLatest.current = true;
    setShowReturnLatest(false);
    setSessionSettingsOpen(false);
    setConversationAttachments([]);
    if (!sessionId || !api) { setDiffs([]); return; }
    let alive = true;
    setError('');
    api.getEvents(sessionId).then(next => {
      if (alive) setEvents(current => ({ ...current, [sessionId]: mergeEvents(next, current[sessionId] || []) }));
    }).catch(reason => alive && setError(message(reason)));
    void refreshDiff(sessionId);
    return () => { alive = false; };
  }, [sessionId]);

  useEffect(() => {
    const element = messagesRef.current;
    if (!element) return;
    if (followLatest.current) element.scrollTop = element.scrollHeight;
    else if (rows.length) setShowReturnLatest(true);
  }, [sessionId, rows.length, rows[rows.length - 1]?.text, running]);
  useEffect(() => {
    if (!sessionSettingsOpen) return;
    const closeOnOutside = (event: PointerEvent) => { if (event.target instanceof Node && !sessionSettingsRef.current?.contains(event.target)) setSessionSettingsOpen(false); };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setSessionSettingsOpen(false); sessionSettingsTriggerRef.current?.focus(); } };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [sessionSettingsOpen]);

  useEffect(() => {
    if (!fileContextMenu) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.file-context-menu')) return;
      setFileContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setFileContextMenu(null); } };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [fileContextMenu]);
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
  async function resolveBaseBranch(targetProjectId: string): Promise<string | undefined> {
    const target = data?.projects.find(item => item.id === targetProjectId);
    if (!target) return undefined;
    if (targetProjectId === projectId && baseBranch) return baseBranch;
    try {
      const options = await api.listProjectBranches(targetProjectId);
      return options.includes(target.branch) ? target.branch : options[0] || undefined;
    } catch { return target.branch === '(detached)' ? undefined : target.branch; }
  }
  async function newSession(targetProjectId = projectId) {
    if (!targetProjectId) return;
    setBusy('session'); setError(''); setNotice('');
    try {
      const created = await api.createSession(targetProjectId, undefined, undefined, await resolveBaseBranch(targetProjectId));
      await api.setProjectCollapsed(targetProjectId, false);
      await refresh(); setProjectId(targetProjectId);
      setSessionId(created.id);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function sessionFromJira(key: string, jiraProjectKey: string) {
    if (!jiraAssociationId) return;
    setBusy('jira-session'); setError(''); setNotice('');
    try {
      const created = await api.createSession(jiraAssociationId, key, jiraProjectKey, await resolveBaseBranch(jiraAssociationId));
      await refresh(); setProjectId(created.projectId); setSessionId(created.id);
      if (created.jiraIssue) { setPrompt(jiraTaskPrompt(created.jiraIssue)); const missing = jiraReadiness(created.jiraIssue); const unavailable = created.jiraIssue.attachments.filter(item => item.imageWarning).length; setNotice((missing.length ? `已关联 ${created.jiraIssue.key}。开发条件预检提示：${missing.join('、')}。AI 将先结合代码和规范补充，无法确认时会明确警示。` : `已关联 ${created.jiraIssue.key} 并准备任务内容，请核对后点击发送。`) + (unavailable ? ` 会话已创建，${unavailable} 张图片未能带入；可以继续发送任务，也可在关联任务详情中重试图片。` : '')); }
      else { setPrompt(''); setError('会话已创建，但未返回 Jira 任务快照，请检查任务关联后再发送。'); }
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if ((!prompt.trim() && !conversationAttachments.length) || !session || running) return;
    if (!configuredProvider?.hasKey) { setSessionSettingsOpen(true); setError('请先在当前会话设置中选择已配置密钥的中转站，或管理中转站凭据。'); return; }
    if (configurationChanged) { setError('请先应用会话设置，再发送任务。'); return; }
    const text = prompt.trim() || '请分析本轮上传的附件。';
    const attachmentIds = conversationAttachments.map(item => item.id);
    const id = session.id;
    runningSessions.current.add(id);
    setError(''); setNotice(''); setSending(true);
    setStatuses(current => ({ ...current, [id]: 'running' }));
    setPrompt('');
    try {
      await api.sendTurn(id, text, attachmentIds);
      setConversationAttachments([]);
      const next = await refresh();
      const latest = next.sessions.find(item => item.id === id);
      if (latest) setStatuses(current => ({ ...current, [id]: latest.status }));
      const saved = await api.getEvents(id);
      setEvents(current => ({ ...current, [id]: mergeEvents(saved, current[id] || []) }));
    } catch (reason) {
      runningSessions.current.delete(id);
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
  async function restartToUpdate() {
    try { await api.installUpdate(); }
    catch (reason) { setError(message(reason)); }
  }
  function inputKey(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
  }
  function handleMessagesScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const atLatest = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    followLatest.current = atLatest;
    if (atLatest) setShowReturnLatest(false);
  }
  function returnToLatest() {
    const element = messagesRef.current;
    if (!element) return;
    followLatest.current = true;
    setShowReturnLatest(false);
    element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
  }

  const layoutStyle = {
    '--sidebar-width': `${layout.leftWidth ?? 244}px`,
    '--inspector-width': `${layout.rightWidth ?? 420}px`,
    '--activity-height': `${layout.bottomHeight ?? 180}px`,
    '--composer-height': `${layout.composerHeight ?? 110}px`
  } as CSSProperties;
  return <div className={`app-shell dock-layout ${layout.leftVisible ? '' : 'left-panel-hidden'} ${layout.rightVisible ? '' : 'right-panel-hidden'} ${layout.bottomVisible ? '' : 'bottom-panel-hidden'}`} style={layoutStyle}>
    <aside id="project-sidebar" className="sidebar" aria-label="项目和会话" hidden={!layout.leftVisible} inert={showSettings} aria-hidden={showSettings || undefined}>
      <div className="brand"><Mark /><div><strong>精工 Agent</strong><span>研发工作空间</span></div><span className="version">v{data?.settings.appVersion || "…"}</span></div>
      <div className="sidebar-section top-nav"><button className={`nav-item ${inspector !== 'jira' || !layout.rightVisible ? 'active' : ''}`} onClick={() => document.getElementById('agent-conversation')?.focus()}><Icon name="chat" />Agent 工作台{(inspector !== 'jira' || !layout.rightVisible) && <span className="active-dot" />}</button><button className={`nav-item ${inspector === 'jira' && layout.rightVisible ? 'active' : ''}`} onClick={showJira} disabled={!data}><Icon name="branch" />Jira 任务{inspector === 'jira' && layout.rightVisible && <span className="active-dot" />}</button><button className="nav-item" onClick={() => openSettings('documents')} disabled={!data}><Icon name="file" />数据字典</button><button className="nav-item" onClick={() => openSettings('requirements')} disabled={!data}><Icon name="shield" />开发要求与规范</button><button className="nav-item" onClick={() => openSettings('memories')} disabled={!data}><Icon name="layers" />本地记忆</button></div>
      <div className="sidebar-section projects-heading"><span>本地项目</span><button className="icon-button" onClick={() => { void addProject(); }} disabled={!!busy} title="添加项目目录" aria-label="添加项目目录"><Icon name="plus" /></button></div>
      <div className="project-list">
        {!data?.projects.length && <div className="sidebar-empty">添加 Git 项目，开始一段会话。</div>}
        {data?.projects.map(item => <section className="project-group" key={item.id} aria-label={`项目 ${item.name}`}>
          <ProjectRow project={item} selected={item.id === projectId} disabled={!!busy || running} unread={data.sessions.some(candidate => candidate.projectId === item.id && !!unread[candidate.id])} onSelect={() => { void toggleProject(item.id); }} onRenamed={async () => { await refresh(); }} onDeleted={async () => { const next = await refresh(); if (projectId === item.id) { const replacement = next.projects[0]; setProjectId(replacement?.id || ''); setSessionId(next.sessions.find(s => s.projectId === replacement?.id)?.id || ''); } }} />
          <div id={`project-sessions-${item.id}`} hidden={item.collapsed !== false}>
            {data.sessions.filter(sessionItem => sessionItem.projectId === item.id).map(sessionItem => <SessionRow key={sessionItem.id} session={sessionItem} status={statuses[sessionItem.id] || sessionItem.status} selected={sessionItem.id === sessionId} disabled={!!busy || running} unread={!!unread[sessionItem.id]} onSelect={() => { readSession(sessionItem.id); setProjectId(item.id); setSessionId(sessionItem.id); setPrompt(''); }} onRenamed={async () => { await refresh(); }} onDeleted={async () => { const next = await refresh(); if (sessionId === sessionItem.id) setSessionId(next.sessions.find(candidate => candidate.projectId === item.id)?.id || ''); }} />)}
            <button className="project-new-session text-button" disabled={!!busy} onClick={() => { void newSession(item.id); }}><Icon name="plus" />新建会话</button>
          </div>
        </section>)}
      </div>
      <div className="sidebar-section sessions-heading"><span>当前项目会话</span>{projectId && <label className="base-branch-picker" title="新会话使用的基准分支"><Icon name="branch" /><select aria-label="新会话基准分支" value={baseBranch} onChange={event => setBaseBranch(event.target.value)} disabled={!!busy || branchLoading || !branchOptions.length}><option value="">{branchLoading ? '读取分支…' : '默认分支'}</option>{branchOptions.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label>}<button className="icon-button" aria-label="导入会话或记忆" title="导入会话或记忆" disabled={!!busy} onClick={() => void importSharing()}><Icon name="download" /></button><button className="icon-button" onClick={() => { void newSession(); }} disabled={!projectId || !!busy} title="新建会话" aria-label="新建会话"><Icon name="plus" /></button></div>
      {projectId && !data?.sessions.some(item => item.projectId === projectId) && <div className="sidebar-empty">此项目还没有会话。<button className="text-button" onClick={() => { void newSession(); }} disabled={!!busy}>创建第一个会话</button></div>}
      <div className="sidebar-footer">
        <div className={`runtime-summary ${data?.runtime.compatible ? 'ready' : ''}`} title={engineText(data?.runtime.detail)}><span className="connection-dot" /><span>{data ? data.runtime.compatible ? '精工 Agent 引擎已就绪' : '精工 Agent 引擎需要检查' : error ? '启动检查失败' : '正在检查本机环境…'}</span><span className="runtime-version">{engineVersion(data?.runtime.version)}</span></div>
        <div className="sidebar-actions"><button onClick={() => openSettings()} disabled={!data}><Icon name="settings" />全局设置</button><button onClick={backup} disabled={!data || !!busy} title="备份本地数据" aria-label="备份本地数据"><Icon name="download" /></button></div>
        <div className="local-caption"><Icon name="shield" />数据保存在当前 Windows 用户本机</div>
      </div>
      <button type="button" className="panel-resize-handle sidebar-resize-handle" role="separator" aria-label="调整项目和会话栏宽度" aria-orientation="vertical" aria-valuemin={180} aria-valuemax={520} aria-valuenow={layout.leftWidth ?? 244} title="拖动调整项目和会话栏宽度" onPointerDown={event => beginResize('left', event)} onKeyDown={event => adjustResize('left', event)} onDoubleClick={() => changeLayout({ leftWidth: 244 })} />
    </aside>

    <div className="workspace" inert={showSettings} aria-hidden={showSettings || undefined}>
      <header className="workspace-header">
        <div className="breadcrumbs"><span>工作空间</span><Icon name="chevron" /><strong>{project?.name || '欢迎使用'}</strong>{session && <><Icon name="chevron" /><span className="breadcrumb-session">{sessionTitle}</span></>}</div>
        <div className="header-actions"><button className="icon-button" title="打开会话浏览器" aria-label="打开会话浏览器" disabled={!session} onClick={() => { if (session) void api.openBrowser(session.id).catch(error => setError(message(error))); }}><Icon name="box" /></button><div className="panel-toggles" role="group" aria-label="工作区面板显示"><button className={`icon-button ${layout.leftVisible ? 'panel-visible' : ''}`} aria-label={layout.leftVisible ? '隐藏项目侧栏' : '显示项目侧栏'} title={layout.leftVisible ? '隐藏项目侧栏' : '显示项目侧栏'} aria-controls="project-sidebar" aria-expanded={layout.leftVisible} disabled={!data} onClick={() => changeLayout({ leftVisible: !layoutRef.current.leftVisible })}><Icon name="panel-left" /></button><button className={`icon-button ${layout.rightVisible ? 'panel-visible' : ''}`} aria-label={layout.rightVisible ? '隐藏右侧面板' : '显示右侧面板'} title={layout.rightVisible ? '隐藏右侧面板' : '显示右侧面板'} aria-controls="right-panel" aria-expanded={layout.rightVisible} disabled={!data} onClick={() => changeLayout({ rightVisible: !layoutRef.current.rightVisible })}><Icon name="panel-right" /></button><button className={`icon-button ${layout.bottomVisible ? 'panel-visible' : ''}`} aria-label={layout.bottomVisible ? '隐藏底部面板' : '显示底部面板'} title={layout.bottomVisible ? '隐藏底部面板' : '显示底部面板'} aria-controls="bottom-panel" aria-expanded={layout.bottomVisible} disabled={!data} onClick={() => changeLayout({ bottomVisible: !layoutRef.current.bottomVisible })}><Icon name="panel-bottom" /></button></div><span className="mode-badge"><Icon name="shield" />{modeLabel}</span><button className="icon-button" title="全局设置" aria-label="打开全局设置" onClick={() => openSettings()} disabled={!data}><Icon name="settings" /></button></div>
      </header>
      {(error || notice) && <div className={`banner ${error ? 'error' : 'notice'}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'alert' : 'check'} /><span>{error || notice}</span>{updateDownloadedVersion && notice.includes('更新已下载') && <button className="secondary-button update-restart" onClick={() => { void restartToUpdate(); }}>重启并更新</button>}<button className="icon-button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); }}><Icon name="close" /></button></div>}
      <div className={`workspace-body ${inspector === 'git' ? 'with-git-inspector' : ''} ${inspector === 'jira' ? 'with-jira-inspector' : ''}`}>
        <main id="agent-conversation" className="conversation" tabIndex={-1} aria-label="Agent 会话工作区">
          {session ? <>

            {session.jiraIssue && <details className="session-jira-link"><summary><Icon name="branch" /><strong>{session.jiraIssue.key}</strong><span>{session.jiraIssue.summary}</span><small>查看关联任务</small></summary><JiraIssueDetails issue={session.jiraIssue} sessionId={session.id} compact /></details>}
            <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll} aria-live="polite" aria-label="会话消息">
              {!rows.length && <div className="session-welcome"><Mark /><h1>一起理解这个项目</h1><p>描述您要分析的问题、代码或需求。<br />当前为{session.system || '通用'} · {modeLabel}，Agent 使用独立工作区。</p><div className="suggestions">{['梳理项目架构与主要模块', '检查潜在缺陷并说明影响范围', '分析现有测试与构建方式'].map(text => <button key={text} onClick={() => setPrompt(text)}>{text}<Icon name="arrow" /></button>)}</div></div>}
              {rows.map(row => row.type === 'status' ? <div className="event-status" key={row.id}><span /><span>{row.text in statusLabels ? statusLabels[row.text as SessionStatus] : engineText(row.text)}</span></div> : row.type === 'tool' || row.type === 'approval' ? <div className="tool-event" key={row.id}><Icon name={row.type === 'approval' ? 'shield' : 'terminal'} /><div><span>{row.type === 'approval' ? '执行策略' : '工具事件'}</span><pre>{toolPlatformText(row.text)}</pre></div><time>{time(row.createdAt)}</time></div> : <article className={`message ${row.type === 'user' ? 'user' : row.type === 'error' ? 'error' : 'agent'}`} key={row.id}><div className="message-avatar">{row.type === 'user' ? '我' : row.type === 'error' ? <Icon name="alert" /> : <Mark small />}</div><div className="message-content"><div className="message-meta"><strong>{row.type === 'user' ? '您' : row.type === 'error' ? '运行错误' : '精工 Agent'}</strong><time>{time(row.createdAt)}</time></div><div className="message-text">{row.type === 'user' ? row.text : <MarkdownContent text={row.type === 'error' ? engineText(row.text) : row.text} />}</div></div></article>)}
              {running && <div className="working-indicator"><span /><span /><span /><span className="working-text">Agent 正在处理任务</span></div>}
              <div className="messages-jump-wrap">{showReturnLatest && <button type="button" className="messages-jump" onClick={returnToLatest}><Icon name="arrow" />回到最新消息</button>}</div>
            </div>
            <div className="composer-container">
              <button type="button" className="panel-resize-handle composer-resize-handle" role="separator" aria-label="调整输入框高度" aria-orientation="horizontal" aria-valuemin={80} aria-valuemax={400} aria-valuenow={layout.composerHeight ?? 110} title="拖动调整输入框高度，双击恢复" onPointerDown={event => beginResize('composer', event)} onKeyDown={event => adjustResize('composer', event)} onDoubleClick={() => changeLayout({ composerHeight: 110 })} />
              {!configuredProvider?.hasKey && <button className="setup-notice" onClick={() => setSessionSettingsOpen(true)}><Icon name="settings" /><span>当前会话尚未配置中转站凭据</span><Icon name="chevron" /></button>}
              <form className={`composer ${running ? 'is-running' : ''}`} onSubmit={send}>
                <textarea aria-label="输入任务" placeholder="向精工 Agent 描述您的任务…" value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={inputKey} disabled={running} rows={3} maxLength={32000} />
                {conversationAttachments.length > 0 && <div className="composer-attachments" aria-label="待发送附件">{conversationAttachments.map(attachment => <span className="composer-attachment" key={attachment.id} title={`${attachment.name}（${attachment.size} 字节）`}><Icon name={attachment.kind === 'image' ? 'box' : 'file'} /><span>{attachment.name}</span><button type="button" aria-label={`移除附件 ${attachment.name}`} title="移除附件" disabled={running} onClick={() => setConversationAttachments(current => current.filter(item => item.id !== attachment.id))}><Icon name="close" /></button></span>)}</div>}
                <div className="composer-toolbar"><div className="composer-context"><button className="attachment-button" type="button" onClick={() => { void pickConversationAttachments(); }} disabled={running || !!busy} title="上传图片或文件"><Icon name="file" />{busy === 'attachments' ? '选择中…' : '添加附件'}</button><label className="session-branch-picker" title="选择当前会话的基准分支"><Icon name="branch" /><select aria-label="当前会话基准分支" value={session.baseBranch || project?.branch || ''} onChange={event => { void switchSessionBranch(event.target.value); }} disabled={running || !!busy || branchLoading || !branchOptions.length}>{!branchOptions.length && <option value={session.baseBranch || project?.branch || ''}>{session.baseBranch || project?.branch || '读取分支中…'}</option>}{branchOptions.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label></div>{running ? <button className="cancel-button" type="button" onClick={cancel}><Icon name="stop" />停止</button> : <button className="send-button" type="submit" disabled={(!prompt.trim() && !conversationAttachments.length) || !data?.runtime.compatible || configurationChanged} aria-label="发送任务" title={configurationChanged ? '请先应用会话设置' : '发送任务（Enter）'}><Icon name="arrow" /></button>}</div>
              </form>
              <div className="composer-caption"><div className="composer-caption-controls"><span className="composer-shortcuts">Enter 发送 · Shift + Enter 换行</span><div className="session-settings-anchor" ref={sessionSettingsRef}><button ref={sessionSettingsTriggerRef} className="session-settings-trigger" type="button" aria-label="打开当前会话设置" title={(configuredProvider?.name || '选择中转站') + ' / ' + (session.model || '选择模型')} aria-expanded={sessionSettingsOpen} aria-controls="session-configuration" onClick={() => setSessionSettingsOpen(value => !value)}><Icon name="box" /><span>{configuredProvider?.name || '选择中转站'} · {session.model || '选择模型'}</span><Icon name="chevron" /></button>
            {sessionSettingsOpen && <div id="session-configuration" role="region" className="session-configuration" aria-label="会话设置">
              <div className="session-settings-heading"><strong>会话设置</strong><button type="button" className="icon-button" aria-label="关闭会话设置" onClick={() => { setSessionSettingsOpen(false); sessionSettingsTriggerRef.current?.focus(); }}><Icon name="close" /></button></div>
              <label>中转站<select aria-label="会话中转站" value={draftProvider} disabled={running || !!busy} onChange={e => { const profile = data?.settings.providers.find(item => item.id === e.target.value); setDraftProvider(e.target.value); setDraftModel(profile?.models[0] || ''); }}>{!draftProvider && <option value="">请先配置中转站</option>}{draftProvider && !selectedProvider && <option value={draftProvider}>原中转站已删除</option>}{data?.settings?.providers.map(item => <option value={item.id} key={item.id}>{item.name}{item.hasKey ? '' : '（未配置密钥）'}</option>)}</select></label>
              <label>模型<select aria-label="会话模型" value={draftModel} disabled={running || !!busy || !selectedProvider} onChange={e => setDraftModel(e.target.value)}>{!draftModel && <option value="">请选择模型</option>}{draftModel && !selectedProvider?.models.includes(draftModel) && <option value={draftModel}>{draftModel}（不在当前列表）</option>}{selectedProvider?.models.map(item => <option key={item}>{item}</option>)}</select></label>
              <label>系统<select aria-label="会话适用系统" value={draftSystem} disabled={running || !!busy} onChange={e => setDraftSystem(e.target.value as ProductSystem)}>{['通用', 'MES5', 'MES6', 'WMS'].map(item => <option key={item}>{item}</option>)}</select></label>
              <label>模式<select aria-label="会话执行模式" value={draftMode} disabled={running || !!busy} onChange={e => setDraftMode(e.target.value as AgentMode)}><option value="develop">开发（读写 / 命令 / 网络 / 数据库）</option></select></label>
              <label>推理强度<select aria-label="推理强度" value={draftReasoning} disabled={running || !!busy} onChange={event => setDraftReasoning(event.target.value as ReasoningEffort | '')}>{([{ value: '', label: '模型默认' }, { value: 'none', label: '无' }, { value: 'minimal', label: '最低' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '超高' }] as const).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              <button className="secondary-button" disabled={running || !!busy || !configurationChanged || !draftProvider || !draftModel} onClick={configure}>{busy === 'configure' ? '应用中…' : '应用设置'}</button>
              <button className="text-button session-provider-manage" type="button" onClick={() => openSettings('providers')}>管理中转站与凭据</button>
              <p className="session-requirements-note"><Icon name="shield" />开发任务将严格执行 {data?.settings.documents.filter(item => item.enabled && item.kind === 'requirement' && (item.system === '通用' || item.system === (session.system || '通用'))).length ?? 0} 份当前系统开发要求；支持代码修改、命令、网络和数据库操作；提交前检查规范并人工复核。</p>
            </div>}
</div></div><span className={'status-label ' + status}><span className="status-dot" />{statusLabels[status]}</span></div>
            </div>
          </> : <div className="welcome-screen"><div className="welcome-content"><div className="welcome-eyebrow"><span />本地优先 · 精工研发</div><Mark /><h1>让想法，进入代码。</h1><p>从本地项目开启一段 Agent 会话，<br />在清晰的上下文中分析代码、审查变更。</p><button className="primary-button" onClick={() => { void (projectId ? newSession() : addProject()); }} disabled={!!busy || !data}><Icon name={projectId ? 'plus' : 'folder'} />{busy === 'session' ? '正在创建会话…' : busy === 'project' ? '正在选择项目…' : projectId ? '新建 Agent 会话' : '选择本地项目'}<Icon name="chevron" /></button><div className="welcome-steps"><div><span>01</span><strong>选择项目</strong><p>连接本地 Git 仓库</p></div><div><span>02</span><strong>配置模型</strong><p>使用您授权的中转站</p></div><div><span>03</span><strong>开始分析</strong><p>流式查看执行过程</p></div></div></div><div className="welcome-bottom"><Icon name="shield" /><span>每个会话独立工作区，提交与推送均由您确认。</span></div></div>}
        </main>

        <aside id="right-panel" className="inspector" aria-label="右侧任务与代码面板" hidden={!layout.rightVisible}>
          <button type="button" className="panel-resize-handle inspector-resize-handle" role="separator" aria-label="调整右侧面板宽度" aria-orientation="vertical" aria-valuemin={260} aria-valuemax={680} aria-valuenow={layout.rightWidth ?? 420} title="拖动调整右侧面板宽度" onPointerDown={event => beginResize('right', event)} onKeyDown={event => adjustResize('right', event)} onDoubleClick={() => changeLayout({ rightWidth: 420 })} />
          <div className="inspector-tabs" role="group" aria-label="右侧面板分类"><button id="jira-panel-tab" className={inspector === 'jira' ? 'active' : ''} aria-pressed={inspector === 'jira'} aria-controls="jira-panel" onClick={() => setInspector('jira')}>Jira</button><button id="diff-panel-tab" className={inspector === 'diff' ? 'active' : ''} aria-pressed={inspector === 'diff'} aria-controls="diff-panel" onClick={() => setInspector('diff')}>代码变更{diffs.length > 0 && <span>{diffs.length}</span>}</button><button id="git-panel-tab" className={inspector === 'git' ? 'active' : ''} aria-pressed={inspector === 'git'} aria-controls="git-panel" onClick={() => setInspector('git')}>Git</button><button id="context-panel-tab" className={inspector === 'context' ? 'active' : ''} aria-pressed={inspector === 'context'} aria-controls="context-panel" onClick={() => setInspector('context')}>上下文</button><button className={`icon-button ${diffBusy ? 'spinning' : ''}`} onClick={() => refreshDiff()} disabled={!sessionId || diffBusy} title="刷新代码差异" aria-label="刷新代码差异"><Icon name="refresh" /></button></div>
          <div id="jira-panel" className="inspector-panel jira-inspector-panel" role="region" aria-label="右侧 Jira 任务" hidden={inspector !== 'jira'}>{data?.settings && <JiraPanel compact api={api} settings={data.settings.jira} projects={data.projects} projectId={jiraAssociationId} onProjectChange={setJiraLocalProjectId} onAddProject={() => { void addProject(true); }} onConfigure={() => openSettings('jira')} onCreateIssue={sessionFromJira} creating={isJiraSessionCreating(busy)} />}</div>
          <div id="diff-panel" className="inspector-panel" role="region" aria-labelledby="diff-panel-tab" hidden={inspector !== 'diff'}>
            {diffs.length ? <div className="diff-content"><div className="file-list">{diffs.map(file => <button className={file.path === activeDiff?.path ? 'selected' : ''} key={file.path} onClick={() => setSelectedFile(file.path)} onContextMenu={event => { event.preventDefault(); setSelectedFile(file.path); setFileContextMenu({ file, x: event.clientX, y: event.clientY }); }} title={`${file.path}（右键打开 Git 操作）`}><Icon name="file" /><span>{file.path}</span><b className={`file-status status-${file.status.charAt(0)}`}>{file.status}</b></button>)}</div>{activeDiff && <div className="diff-view"><div className="diff-file-heading"><Icon name="file" /><span>{activeDiff.path}</span></div>{activeDiff.binary && <div className="diff-note">二进制文件发生变更，无法显示文本差异。</div>}{activeDiff.truncated && <div className="diff-note">文件差异较大，当前仅显示部分内容。</div>}<pre aria-label="文件代码差异">{diffLines(activeDiff.diff).map((line, index) => <div key={index} className={`diff-line ${line.kind}`}><span className="diff-line-number">{line.old}</span><span className="diff-line-number">{line.next}</span><span>{line.text || ' '}</span></div>)}</pre></div>}</div> : <div className="inspector-empty"><div className="empty-icon"><Icon name="layers" /></div><strong>{diffBusy ? '正在读取 Git 差异' : session ? diffError ? '工作区暂不可用' : '工作区暂无变更' : '代码差异将在这里显示'}</strong><p>{session ? diffError || '此处展示隔离工作区与基准提交的真实差异。' : '选择项目并创建会话，即可查看工作区文件变更。'}</p></div>}
            {fileContextMenu && <div className="file-context-menu" role="menu" aria-label={`文件 Git 操作：${fileContextMenu.file.path}`} style={{ left: Math.min(fileContextMenu.x, Math.max(8, window.innerWidth - 230)), top: Math.min(fileContextMenu.y, Math.max(8, window.innerHeight - 210)) }}>
              <div className="file-context-heading">{fileContextMenu.file.path}</div>
              <button role="menuitem" onClick={() => { setSelectedFile(fileContextMenu.file.path); setFileContextMenu(null); }}><Icon name="layers" />查看对比</button>
              <button role="menuitem" onClick={() => { void api.copyText(fileContextMenu.file.path).then(() => { setFileContextMenu(null); setNotice('文件路径已复制。'); }).catch(reason => setError(message(reason))); }}><Icon name="copy" />复制文件路径</button>
              <button role="menuitem" onClick={() => { const file = fileContextMenu.file; setFileContextMenu(null); void api.openChangedFile(sessionId, file.path).catch(reason => setError(message(reason))); }}><Icon name="file" />用系统编辑器打开</button>
              {!fileContextMenu.file.staged && <button role="menuitem" disabled={!!fileAction} onClick={() => { void runFileAction('stage', fileContextMenu.file); }}><Icon name="check" />暂存此文件</button>}
              {fileContextMenu.file.staged && <button role="menuitem" disabled={!!fileAction} onClick={() => { void runFileAction('unstage', fileContextMenu.file); }}><Icon name="arrow" />取消暂存</button>}
              <button role="menuitem" className="danger-menu-item" disabled={!!fileAction} onClick={() => { void runFileAction('discard', fileContextMenu.file); }}><Icon name="close" />撤销此文件更改</button>
              <button role="menuitem" onClick={() => { setInspector('git'); setFileContextMenu(null); }}><Icon name="branch" />在 Git 面板中处理</button>
            </div>}
            <div className="inspector-footnote"><Icon name="branch" /><span>{session ? '隔离工作区 · 原始项目保持独立' : '每个会话使用独立 Git Worktree'}</span></div>
          </div>
          <div id="git-panel" className="inspector-panel" role="region" aria-labelledby="git-panel-tab" hidden={inspector !== 'git'}>{sessionId ? <GitPanel key={`${sessionId}-${session?.system}-${session?.mode}`} sessionId={sessionId} jiraUrl={session?.jiraIssue?.url} documents={data?.settings?.documents || []} running={running} onChanged={async () => { await refresh(); await refreshDiff(sessionId); }} /> : <div className="inspector-empty"><div className="empty-icon"><Icon name="branch" /></div><strong>创建会话后管理 Git</strong><p>查看历史、检查开发要求，再由您确认提交和推送。</p></div>}</div>
          <div id="context-panel" className="inspector-panel" role="region" aria-labelledby="context-panel-tab" hidden={inspector !== 'context'}><div className="context-content"><div className="context-label">当前项目</div><strong>{project?.name || '尚未选择'}</strong><code>{project?.path || '通过左侧 + 添加本地 Git 项目'}</code><div className="context-label">会话工作区</div><code>{session?.workspacePath || '新建会话后创建独立工作区'}</code><div className="context-label">适用系统与执行模式</div><div className="context-value"><Icon name="shield" />{session?.system || '通用'} · {modeLabel}</div><p className="context-hint">只加载通用及当前系统资料。支持直接修改代码、执行构建和测试、访问网络及连接数据库。</p><div className="context-label">模型中转站</div><div className="context-value">{configuredProvider?.name || '未选择'} · Responses</div><code>{configuredProvider?.baseUrl || '尚未配置中转站'}</code><div className="context-label">已启用资料</div>{data?.settings?.documents.filter(item => item.enabled && (item.system === '通用' || item.system === (session?.system || '通用'))).map(item => <div className="context-document" key={item.id}><Icon name="file" /><span>{item.name}<small>{item.system} · {item.kind === 'dictionary' ? '数据字典' : '开发要求'}</small></span></div>)}<button className="text-button" onClick={() => openSettings('documents')} disabled={!data}>管理数据字典</button><button className="text-button" onClick={() => openSettings('requirements')} disabled={!data}>管理开发要求与规范</button><div className="context-label">本机环境</div><div className="environment-row"><span>精工 Agent 引擎</span><b>{engineVersion(data?.runtime.version) || '检查中'}</b></div><div className="environment-row"><span>Git</span><b>{data?.gitVersion || '未检测到'}</b></div><div className="context-label">本地数据目录</div><code>{data?.dataDirectory || '正在初始化'}</code></div></div>
        </aside>
      </div>
      <section id="bottom-panel" className="activity-panel" aria-label="运行输出和工具活动" hidden={!layout.bottomVisible}>
        <button type="button" className="panel-resize-handle activity-resize-handle" role="separator" aria-label="调整会话输出栏高度" aria-orientation="horizontal" aria-valuemin={100} aria-valuemax={480} aria-valuenow={layout.bottomHeight ?? 180} title="拖动调整会话输出栏高度" onPointerDown={event => beginResize('bottom', event)} onKeyDown={event => adjustResize('bottom', event)} onDoubleClick={() => changeLayout({ bottomHeight: 180 })} />
        <div className="activity-panel-header"><div role="group" aria-label="运行活动分类"><button id="activity-output-tab" className={activityTab === 'output' ? 'active' : ''} aria-pressed={activityTab === 'output'} aria-controls="activity-events" onClick={() => setActivityTab('output')}><Icon name="terminal" />运行输出</button><button id="activity-tools-tab" className={activityTab === 'tools' ? 'active' : ''} aria-pressed={activityTab === 'tools'} aria-controls="activity-events" onClick={() => setActivityTab('tools')}>工具活动</button></div><span>{session ? `${activityEvents.length} 条事件` : '尚未选择会话'}</span></div>
        <div id="activity-events" className="activity-events" role="region" aria-labelledby={activityTab === 'output' ? 'activity-output-tab' : 'activity-tools-tab'} tabIndex={0}>{activityEvents.length ? activityEvents.map(event => <div key={event.id} className={`activity-event activity-${event.type}`}><time dateTime={event.createdAt}>{time(event.createdAt)}</time><span>{event.type === 'tool' ? '工具' : event.type === 'approval' ? '审批' : event.type === 'error' ? '错误' : '状态'}</span><pre>{event.type === 'tool' || event.type === 'approval' ? toolPlatformText(event.text) : event.type === 'status' && event.text in statusLabels ? statusLabels[event.text as SessionStatus] : engineText(event.text)}</pre></div>) : <div className="activity-empty"><Icon name="terminal" /><span>{session ? activityTab === 'tools' ? '当前会话尚无工具活动，执行后的真实工具事件会显示在这里。' : '当前会话尚无运行输出，状态、错误与工具事件会显示在这里。' : '选择会话后查看真实运行输出与工具活动。'}</span></div>}<div ref={activityEndRef} /></div>
      </section>
      <footer className="statusbar"><div><span className="statusbar-dot" />本地工作空间<span className="statusbar-separator">/</span><Icon name="shield" />{modeLabel}</div><div><span>Windows 桌面 PoC</span><span className="statusbar-separator">·</span><span>{configuredProvider?.hasKey || !session && data?.settings?.providers.some(item => item.hasKey) ? '模型凭据已加密保存' : '模型凭据待配置'}</span></div></footer>
    </div>
    {showSettings && data?.settings && <SettingsPanel settings={data.settings} initialTab={settingsTab} onClose={() => setShowSettings(false)} onChanged={settingsChanged} />}
  </div>;
}


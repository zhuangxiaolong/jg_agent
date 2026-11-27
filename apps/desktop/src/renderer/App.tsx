import { useTransientError } from './use-transient-error';
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type CSSProperties, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactElement, type SetStateAction, type UIEvent } from 'react';
import type { AgentDelegationMode, AgentEvent, Bootstrap, BrowserPanelState, CompletionSound, ConversationAttachment, DeliveryTaskProject, FileDiff, LayoutPreferences, ProductSystem, ReasoningEffort, RequirementResolutionAction, RuntimeHealth, RuntimeKind, Session, SessionStatus, SettingsSnapshot, UserProfile, WorkMode } from '../../../../packages/domain/src';
import { requiresRequirementAdmission } from '../../../../packages/domain/src/jira-requirements';
import { isGrokModel } from '../../../../packages/domain/src/runtime-compatibility';
import { Icon, Mark } from './ui';
import { SettingsPanel, type SettingsTab } from './SettingsPanel';
import { ExpertSession } from './ExpertSession';
import { ExpertAvatar } from './ExpertAvatar';
import { JiraInlineImagePreview, jiraWikiImageAttachments, MarkdownContent, removeJiraWikiImageAttachment } from './MarkdownContent';
import { ConversationImagePreview } from './ConversationImagePreview';
import { ConversationFilePreview } from './ConversationFilePreview';
import { playCompletionSound } from './completion-sound';
import { GitPanel } from './GitPanel';
import { ProjectGitPanel } from './ProjectGitPanel';
import { DiffPreview } from './DiffPreview';
import { JiraPanel } from './JiraPanel';
import { jiraTaskPrompt } from './JiraIssueDetails';
import { RequirementAdmissionPanel } from './RequirementAdmissionPanel';
import { compactAgentEvent, engineText, engineVersion, hidesRuntimeToolEvents, sessionDisplayName, toolPlatformText } from './branding';
import { isSessionRunActive } from './session-run-state';
import { isJiraSessionCreating } from './jira-create-state';
import { ProjectRow } from './ProjectRow';
import { GitChangesResizeHandle } from './GitChangesResizeHandle';
import { SessionRow } from './SessionRow';
import { AgentTasksPanel } from './AgentTasksPanel';
import { TaskWorkbench } from './TaskWorkbench';
import { DeliveryTaskWorkbench } from './DeliveryTaskWorkbench';
import { IterationWorkbench } from './IterationWorkbench';
import { agentTasksToReveal } from './agent-task-state';
import { useSessionAgentTasks } from './use-session-agent-tasks';
import { PerformancePanel } from './PerformancePanel';
import { ContextInspector } from './ContextInspector';
import './context-inspector.css';
import { RunRecoveryPanel } from './RunRecoveryPanel';
import { latestRunningIndicator, runningIndicatorDetails } from './running-indicator';
import { BrowserPanel } from './BrowserPanel';
import { ProjectFilesPanel } from './ProjectFilesPanel';
import { pendingRuntimeApprovals, sessionProviderChoices } from './grok-ui-state';
import { runtimeForSelectedModel } from './session-runtime-selection';
import { assistantMessageDurations, formatClockTime, formatDuration } from './message-timing';
import './runtime-approval.css';


const statusLabels: Record<SessionStatus, string> = { idle: '就绪', running: '运行中', 'waiting-approval': '等待审批', completed: '已完成', failed: '失败', interrupted: '已中断' };
const reasoningLabels: Record<ReasoningEffort, string> = { none: '无', minimal: '最低', low: '低', medium: '中', high: '高', xhigh: '超高' };
const defaultUserProfile: UserProfile = { name: '您', avatar: 'preset-green', profession: '' };
const defaultLayout: LayoutPreferences = { leftVisible: true, rightVisible: true, bottomVisible: false, leftWidth: 220, rightWidth: 420, bottomHeight: 180 };
type ResizeKind = 'left' | 'right' | 'bottom' | 'composer' | 'standalone';
interface PanelResizeDrag { kind: ResizeKind; startX: number; startY: number; startValue: number; latest: number; pointerId: number; handle: HTMLButtonElement }
interface FileContextMenu { file: FileDiff; x: number; y: number }
type MessageFileContextMenu = { kind: 'project'; path: string; x: number; y: number } | { kind: 'attachment'; sessionId: string; attachment: ConversationAttachment; x: number; y: number };
interface SessionDraft { prompt: string; attachments: ConversationAttachment[] }
interface ModeSelection { projectId: string; sessionId: string }
interface DiffTreeNode { name: string; path: string; children: DiffTreeNode[]; file?: FileDiff }
function time(value: string) { return formatClockTime(value); }
function message(error: unknown) { return engineText(error instanceof Error ? error.message : String(error)); }
function runtimeLabel(kind?: RuntimeKind): string { return kind === 'grok_build_acp' ? 'Grok Runtime' : kind === 'jinggong' ? 'Jinggong Runtime' : kind === 'claude_agent_sdk' ? 'Claude Agent SDK Runtime' : 'Codex Runtime'; }
function reasoningLabel(value?: ReasoningEffort): string { return value ? reasoningLabels[value] : '模型默认'; }
function displayUserMessageText(text: string): string {
  return text.replace(/\r?\n\r?\n【本轮上传附件(?:；[^】]*)?】[\s\S]*$/, '').trim();
}
function userAvatar(profile: UserProfile) {
  if (profile.avatar.startsWith('data:image/')) return <img src={profile.avatar} alt="" />;
  const glyphs: Record<string, string> = { 'preset-blue': '🧑‍💻', 'preset-orange': '🛠️', 'preset-purple': '📊' };
  return <span>{glyphs[profile.avatar] ?? '👤'}</span>;
}
function buildDiffTree(files: FileDiff[]): DiffTreeNode[] {
  const roots: DiffTreeNode[] = [];
  for (const file of files) {
    const parts = file.path.replace(/\\/g, '/').split('/').filter(Boolean);
    let siblings = roots;
    let parentPath = '';
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      const path = parentPath ? `${parentPath}/${name}` : name;
      let node = siblings.find(item => item.name === name);
      if (!node) { node = { name, path, children: [] }; siblings.push(node); }
      if (index === parts.length - 1) node.file = file;
      else siblings = node.children;
      parentPath = path;
    }
  }
  const sort = (nodes: DiffTreeNode[]) => {
    nodes.sort((a, b) => Number(!!a.file) - Number(!!b.file) || a.name.localeCompare(b.name));
    nodes.forEach(node => sort(node.children));
  };
  sort(roots);
  return roots;
}
function diffStatusTone(status: string): string {
  const code = status.charAt(0).toUpperCase();
  return code === 'A' || code === '?' ? 'added' : code === 'D' ? 'deleted' : code === 'R' || code === 'C' ? 'renamed' : code === '!' ? 'warning' : 'modified';
}
function mergeEvents(a: AgentEvent[], b: AgentEvent[]) {
  if (!a.length) return [...b];
  if (!b.length) return a;
  const lastCreatedAt = a[a.length - 1]?.createdAt ?? '';
  const appendOnly = b.every((event, index) => event.createdAt >= (index === 0 ? lastCreatedAt : b[index - 1].createdAt));
  if (appendOnly && !b.some(event => a[a.length - 1]?.id === event.id)) return [...a, ...b];
  const events = new Map(a.map(event => [event.id, event]));
  b.forEach(event => events.set(event.id, event));
  return [...events.values()].sort((x, y) => x.createdAt.localeCompare(y.createdAt));
}

function rendererEvents(events: AgentEvent[], runtimeKind?: RuntimeKind): AgentEvent[] {
  return hidesRuntimeToolEvents(runtimeKind) ? events.filter(event => event.type !== 'tool') : events;
}
function mergeRendererEvents(saved: AgentEvent[], current: AgentEvent[], runtimeKind?: RuntimeKind): AgentEvent[] {
  return mergeEvents(rendererEvents(saved, runtimeKind), rendererEvents(current, runtimeKind));
}
function timeline(events: AgentEvent[], runtimeKind?: RuntimeKind) {
  const rows: { id: string; type: AgentEvent['type'] | 'tool-group'; text: string; createdAt: string; expert?: AgentEvent['expert']; durationMs?: number; attachments?: ConversationAttachment[]; toolEvents?: AgentEvent[] }[] = [];
  const durations = assistantMessageDurations(events);
  let currentToolGroup: (typeof rows)[number] | undefined;
  for (const event of events) {
    if (event.type === 'approval') {
      if (event.approval && event.approval.state !== 'pending') rows.push({ ...event, type: 'status', text: `工具审批${event.approval.state === 'allowed' ? '已允许一次' : event.approval.state === 'expired' ? '已过期' : '已拒绝'}：${event.approval.title}` });
      continue;
    }
    if (event.type === 'message' && /^### (?:代码变更(?:已)?核验|构建、测试与报告核验)/.test(event.text.trim())) continue;
    if (event.type === 'status' && ['running', 'completed'].includes(event.text)) continue;
    const compactText = compactAgentEvent(event, runtimeKind);
    if (compactText === null) continue;
    const last = rows[rows.length - 1];
    const display = { ...event, text: compactText, ...(durations.has(event.id) ? { durationMs: durations.get(event.id) } : {}) };
    if (display.type === 'tool') {
      if (!currentToolGroup) {
        currentToolGroup = { ...display, type: 'tool-group', toolEvents: [{ ...event, text: display.text }] };
        rows.push(currentToolGroup);
      } else {
        if (currentToolGroup.toolEvents?.at(-1)?.text !== display.text) currentToolGroup.toolEvents?.push({ ...event, text: display.text });
        currentToolGroup.createdAt = display.createdAt;
      }
      continue;
    }
    if (display.type === 'user' || (display.type === 'status' && ['completed', 'failed', 'interrupted'].includes(display.text))) currentToolGroup = undefined;
    if (display.type === 'delta' && last?.type === 'delta' && last.expert?.id === display.expert?.id) {
      last.text += display.text;
      if (display.durationMs !== undefined) last.durationMs = display.durationMs;
    }
    else if (display.type === 'message' && last?.type === 'delta' && last.expert?.id === display.expert?.id && last.text.trim() === display.text.trim()) {
      last.type = 'message';
      if (display.durationMs !== undefined) last.durationMs = display.durationMs;
    }
    else rows.push(display);
  }
  return rows;
}
export function App() {
  const [mode, setMode] = useState<WorkMode>(() => window.localStorage.getItem('jinggong-work-mode') === 'delivery' ? 'delivery' : 'development');
  function changeMode(next: WorkMode) {
    window.localStorage.setItem('jinggong-work-mode', next);
    setMode(next);
  }
  return <ModeApp mode={mode} onModeChange={changeMode} />;
}

function ModeApp({ mode, onModeChange }: { mode: WorkMode; onModeChange: (mode: WorkMode) => void }) {
  const api = window.jinggong;
  const [data, setData] = useState<Bootstrap | null>(null);
  const modeSnapshots = useRef<Partial<Record<WorkMode, Bootstrap>>>({});
  const modeBootstrapRequests = useRef<Partial<Record<WorkMode, Promise<Bootstrap>>>>({});
  const modeSelections = useRef<Partial<Record<WorkMode, ModeSelection>>>({});
  const modeSwitching = useRef(false);
  const modeSwitchSequence = useRef(0);
  const alternateModePrefetched = useRef(false);
  const [modeTransitioning, setModeTransitioning] = useState(false);
  const [deliveryProjectDialogOpen, setDeliveryProjectDialogOpen] = useState(false);
  const [deliveryProjectName, setDeliveryProjectName] = useState('');
  const runtimeHealthUpdates = useRef({ version: 0, values: new Map<RuntimeKind, { version: number; health: RuntimeHealth }>() });
  const visibleSessionIds = useRef(new Set<string>());
  const [projectId, setProjectId] = useState('');
  const [jiraLocalProjectId, setJiraLocalProjectId] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [events, setEvents] = useState<Record<string, AgentEvent[]>>({});
  const [statuses, setStatuses] = useState<Record<string, SessionStatus>>({});
  const [diffs, setDiffs] = useState<FileDiff[]>([]);
  const [selectedFile, setSelectedFile] = useState('');
  const [diffExpanded, setDiffExpanded] = useState(false);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenu | null>(null);
  const [filePreviewPath, setFilePreviewPath] = useState('');
  const [fileAction, setFileAction] = useState('');
  const [messageFileContextMenu, setMessageFileContextMenu] = useState<MessageFileContextMenu | null>(null);
  const [sessionDrafts, setSessionDrafts] = useState<Record<string, SessionDraft>>({});
  const prompt = sessionDrafts[sessionId]?.prompt || '';
  const conversationAttachments = sessionDrafts[sessionId]?.attachments || [];
  function setPrompt(value: SetStateAction<string>) {
    setSessionDrafts(current => {
      const draft = current[sessionId] ?? { prompt: '', attachments: [] };
      return { ...current, [sessionId]: { ...draft, prompt: typeof value === 'function' ? value(draft.prompt) : value } };
    });
  }
  function setConversationAttachments(value: SetStateAction<ConversationAttachment[]>) {
    setSessionDrafts(current => {
      const draft = current[sessionId] ?? { prompt: '', attachments: [] };
      return { ...current, [sessionId]: { ...draft, attachments: typeof value === 'function' ? value(draft.attachments) : value } };
    });
  }

  useEffect(() => {
    visibleSessionIds.current = new Set(data?.sessions.map(item => item.id) ?? []);
  }, [data?.sessions]);
  useEffect(() => {
    if (data?.mode === mode) {
      modeSnapshots.current[mode] = data;
      modeSelections.current[mode] = { projectId, sessionId };
    }
  }, [data, mode, projectId, sessionId]);
  const [busy, setBusy] = useState('');
  const [approvalBusy, setApprovalBusy] = useState<ReadonlySet<string>>(new Set());
  const [approvalSubmitted, setApprovalSubmitted] = useState<ReadonlySet<string>>(new Set());
  const [requirementBusy, setRequirementBusy] = useState(false);
  const [diffBusy, setDiffBusy] = useState(false);
  const [gitDiffHeight, setGitDiffHeight] = useState<number | null>(null);
  const [diffError, setDiffError] = useState('');
  const [unread, setUnread] = useState<Record<string, string>>({});
  const [error, setError] = useTransientError();
  const [notice, setNotice] = useTransientError();
  const [showSettings, setShowSettings] = useState(false);
  const [newSessionMenu, setNewSessionMenu] = useState<{ x: number; y: number } | null>(null);
  const [browserStates, setBrowserStates] = useState<Record<string, BrowserPanelState>>({});
  const [sessionSettingsOpen, setSessionSettingsOpen] = useState(false);
  const [showReturnLatest, setShowReturnLatest] = useState(false);
  const [updateDownloadedVersion, setUpdateDownloadedVersion] = useState('');
  const [updateAvailableVersion, setUpdateAvailableVersion] = useState('');
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('providers');
  const [inspector, setInspector] = useState<'jira' | 'context' | 'git' | 'files' | 'agents' | 'performance' | 'iteration' | 'knowledge' | 'manuals'>(mode === 'delivery' ? 'knowledge' : 'jira');
  const [expandedProjectSessions, setExpandedProjectSessions] = useState<Record<string, boolean>>({});
  const [layout, setLayout] = useState<LayoutPreferences>(defaultLayout);
  const [activityTab, setActivityTab] = useState<'output' | 'tools'>('output');
  const [workingExpanded, setWorkingExpanded] = useState(false);
  const uiRenderMarkedSessions = useRef(new Set<string>());
  const pendingUiRenderSessions = useRef(new Set<string>());
  const runtimeKindsRef = useRef(new Map<string, RuntimeKind>());
  for (const item of data?.sessions ?? []) runtimeKindsRef.current.set(item.id, item.runtimeKind ?? 'codex');

  useEffect(() => {
    if (sessionId) void api.prewarmSession(sessionId).catch(() => undefined);
  }, [api, sessionId]);

  useEffect(() => {
    if (pendingUiRenderSessions.current.has(sessionId) && sessionId && !uiRenderMarkedSessions.current.has(sessionId) && api.performance) {
      pendingUiRenderSessions.current.delete(sessionId);
      uiRenderMarkedSessions.current.add(sessionId);
      void api.performance.markFirstUiRender(sessionId).catch(() => { uiRenderMarkedSessions.current.delete(sessionId); });
    }
  }, [api, events, sessionId]);
  const [draftProvider, setDraftProvider] = useState('');
  const [draftModel, setDraftModel] = useState('');
  const [draftSystem, setDraftSystem] = useState<ProductSystem>('通用');
  const [draftReasoning, setDraftReasoning] = useState<ReasoningEffort | ''>('');
  const [bindProjectId, setBindProjectId] = useState('');
  const [bindDeliveryProjectId, setBindDeliveryProjectId] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [branchOptions, setBranchOptions] = useState<string[]>([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [sendingSessions, setSendingSessions] = useState<ReadonlySet<string>>(new Set());
  const pendingSendCounts = useRef(new Map<string, number>());
  const sessionDraftsRef = useRef<Record<string, SessionDraft>>({});
  const currentSessionIdRef = useRef('');
  const sendingSessionIdsRef = useRef<ReadonlySet<string>>(new Set());
  const emptySessionCleanup = useRef(new Set<string>());
  const messagesRef = useRef<HTMLDivElement>(null);
  const sessionSettingsRef = useRef<HTMLDivElement>(null);
  const sessionSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const newSessionButtonRef = useRef<HTMLButtonElement>(null);
  const newSessionMenuRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const completionSoundRef = useRef<CompletionSound>('chime');
  const selectedSessionRef = useRef('');
  const diffSequence = useRef(0);
  const diffInFlight = useRef(new Map<string, number>());
  const layoutRef = useRef<LayoutPreferences>(defaultLayout);
  const savedLayoutRef = useRef<LayoutPreferences>(defaultLayout);
  const settingsRefreshSequence = useRef(0);
  const layoutQueue = useRef<Promise<void>>(Promise.resolve());
  const resizeDrag = useRef<PanelResizeDrag | null>(null);
  const runningSessions = useRef(new Set<string>());
  const sessionNames = useRef(new Map<string, string>());
  const activityEndRef = useRef<HTMLDivElement>(null);
  const project = data?.projects.find(item => item.id === projectId);
  const deliveryProject = data?.deliveryProjects?.find(item => item.id === projectId);
  const jiraAssociationId = data?.projects.some(item => item.id === jiraLocalProjectId) ? jiraLocalProjectId : projectId;
  const session = data?.sessions.find(item => item.id === sessionId);
  const jiraIssue = session?.jiraIssue;
  const jiraDraftImageAttachments = jiraIssue ? jiraWikiImageAttachments(prompt, jiraIssue) : [];
  const agentTasks = useSessionAgentTasks(api, mode === 'development' ? sessionId : '', text => setError(message(text)));
  const hasAgentTasks = mode === 'development' && !!session;
  const currentInspector = inspector === 'agents' && !hasAgentTasks ? 'jira' : inspector;
  const revealedAgentTasks = useRef(new Set<string>());
  const browserState = browserStates[sessionId];
  const browserOpen = mode === 'development' && !!session && !!browserState?.visible;
  const sessionProject = data?.projects.find(item => item.id === session?.projectId);
  const sessionRuntimeKind = session?.runtimeKind ?? 'codex';
  const assistantName = '精工Agent';
  const userProfile = data?.settings.preferences.userProfile ?? defaultUserProfile;
  const sessionRuntimeHealth = sessionRuntimeKind === 'grok_build_acp' ? data?.runtimes?.grok_build_acp : data?.runtimes?.[sessionRuntimeKind] ?? data?.runtime;
  const sessionTitle = session ? sessionDisplayName(session) : '';
  const status = sessionId ? statuses[sessionId] || session?.status || 'idle' : 'idle';
  // status 是持久化展示状态，异常退出后可能仍为 running；输入锁定只看当前进程实际活动任务。
  const running = isSessionRunActive(sessionId, runningSessions.current, sendingSessions);
  const sessionEvents = events[sessionId] || [];
  const latestTurnExpert = useMemo(() => {
    for (let index = sessionEvents.length - 1; index >= 0; index -= 1) {
      const event = sessionEvents[index];
      if (event.type === 'user') break;
      if ((event.type === 'message' || event.type === 'delta') && event.expert) return event.expert;
    }
    return undefined;
  }, [sessionEvents]);
  const runtimeApprovals = useMemo(() => pendingRuntimeApprovals(sessionEvents, sessionId, running), [sessionEvents, sessionId, running]);
  const rows = useMemo(() => timeline(sessionEvents, sessionRuntimeKind), [sessionEvents, sessionRuntimeKind]);
  const workingDetails = useMemo(() => runningIndicatorDetails(sessionEvents, 5, sessionRuntimeKind), [sessionEvents, sessionRuntimeKind]);
  const latestWorkingInfo = useMemo(() => latestRunningIndicator(sessionEvents, sessionRuntimeKind), [sessionEvents, sessionRuntimeKind]);
  const activityEvents = useMemo(() => {
    const compacted: AgentEvent[] = [];
    for (const event of sessionEvents) {
      const compactText = compactAgentEvent(event, sessionRuntimeKind);
      if (compactText === null) continue;
      if (event.type === 'status' && ['running', 'completed'].includes(event.text)) continue;
      if (activityTab === 'tools' ? event.type !== 'tool' : !['tool', 'status', 'error'].includes(event.type)) continue;
      const display = { ...event, text: compactText };
      const previous = compacted[compacted.length - 1];
      if (display.type === 'tool' && previous?.type === 'tool' && previous.text === display.text) continue;
      compacted.push(display);
    }
    return compacted;
  }, [sessionEvents, activityTab]);
  useEffect(() => {
    if (!newSessionMenu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && (newSessionMenuRef.current?.contains(event.target) || newSessionButtonRef.current?.contains(event.target))) return;
      setNewSessionMenu(null);
    };
    const dismiss = () => setNewSessionMenu(null);
    document.addEventListener('pointerdown', close);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); };
  }, [newSessionMenu]);
  const activeDiff = diffs.find(file => file.path === selectedFile);
  const providerChoices = useMemo(() => sessionProviderChoices(data?.settings, sessionRuntimeKind), [data?.settings, sessionRuntimeKind]);
  const defaultProvider = providerChoices.find(item => item.enabled && item.models.some(model => model.enabled));
  const configuredProvider = providerChoices.find(item => item.id === session?.providerId) || (!session?.providerId ? defaultProvider : undefined);
  const configuredModel = configuredProvider?.models.find(item => item.id === session?.model);
  const configuredBackend = configuredModel?.backend || (sessionRuntimeKind === 'grok_build_acp' ? 'Responses' : sessionRuntimeKind === 'claude_agent_sdk' ? 'Anthropic Messages' : 'Responses');
  const claudeGrokSelection = sessionRuntimeKind === 'claude_agent_sdk' && !!configuredProvider && !!session?.model && isGrokModel(configuredProvider, session.model);
  const grokProviderReady = providerChoices.some(provider => provider.enabled && provider.hasKey && provider.models.some(model => model.enabled));
  const grokSelectable = Boolean((data?.runtimes?.grok_build_acp?.compatible || data?.runtimes?.grok_build_acp?.warmingUp) && grokProviderReady);
  completionSoundRef.current = data?.settings?.preferences.completionSound ?? 'chime';
  const selectedProvider = providerChoices.find(item => item.id === draftProvider);
  const projectBindingChanged = !!session && (mode === 'development' ? bindProjectId !== (session.projectId || '') : bindDeliveryProjectId !== (session.deliveryProjectId || ''));
  sessionNames.current = new Map(data?.sessions.map(item => [item.id, sessionDisplayName(item)]) ?? []);
  sessionDraftsRef.current = sessionDrafts;
  currentSessionIdRef.current = sessionId;
  sendingSessionIdsRef.current = sendingSessions;

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
  async function importedShare(sessionId?: string) {
    const next = await refresh();
    if (!sessionId) return;
    const imported = next.sessions.find(item => item.id === sessionId);
    if (imported) { setProjectId(mode === 'delivery' ? imported.deliveryProjectId || '' : imported.projectId || ''); setSessionId(imported.id); }
  }
  async function refresh() {
    const next = await loadModeSnapshot(mode);
    setData(next);
    return next;
  }
  function loadModeSnapshot(targetMode: WorkMode): Promise<Bootstrap> {
    const active = modeBootstrapRequests.current[targetMode];
    if (active) return active;
    const request = api.bootstrap(targetMode).then(snapshot => {
      const next = mergeRuntimeSnapshot(snapshot, runtimeHealthUpdates.current.version);
      modeSnapshots.current[targetMode] = next;
      return next;
    }).finally(() => {
      if (modeBootstrapRequests.current[targetMode] === request) delete modeBootstrapRequests.current[targetMode];
    });
    modeBootstrapRequests.current[targetMode] = request;
    return request;
  }
  function applyModeSnapshot(next: Bootstrap, targetMode: WorkMode) {
    visibleSessionIds.current = new Set(next.sessions.map(item => item.id));
    setData(next);
    setUnread(Object.fromEntries(next.sessions.filter(item => item.unreadCompletionId).map(item => [item.id, item.unreadCompletionId!])));
    layoutRef.current = next.layout; savedLayoutRef.current = next.layout; setLayout(next.layout);
    const remembered = modeSelections.current[targetMode];
    const rememberedSession = next.sessions.find(item => item.id === remembered?.sessionId);
    const projects = targetMode === 'delivery' ? next.deliveryProjects ?? [] : next.projects;
    const rememberedProject = projects.some(item => item.id === remembered?.projectId) ? remembered?.projectId : undefined;
    setProjectId(rememberedProject ?? (rememberedSession ? targetMode === 'delivery' ? rememberedSession.deliveryProjectId || '' : rememberedSession.projectId || '' : projects[0]?.id || ''));
    setSessionId(rememberedSession?.id ?? '');
  }
  function mergeRuntimeSnapshot(next: Bootstrap, healthVersion: number): Bootstrap {
    const runtimes = { ...next.runtimes };
    // 请求发出后的状态推送比旧快照更新，启动和刷新时都不能把已就绪覆盖成预热中。
    for (const [kind, update] of runtimeHealthUpdates.current.values) {
      if (update.version > healthVersion) runtimes[kind] = update.health;
    }
    const kind = next.runtime.kind ?? next.settings.runtimeKind ?? 'codex';
    return { ...next, runtimes, runtime: runtimes[kind] ?? next.runtime };
  }
  async function discardEmptySession(id: string, allowSelected = false) {
    if (!id || emptySessionCleanup.current.has(id)) return;
    const target = data?.sessions.find(item => item.id === id);
    if (!target) return;
    const draft = sessionDraftsRef.current[id];
    if (draft?.prompt.trim() || draft?.attachments.length) return;
    if (isSessionRunActive(id, runningSessions.current, sendingSessionIdsRef.current) || pendingSendCounts.current.has(id)) return;
    if (!allowSelected && currentSessionIdRef.current === id) return;
    emptySessionCleanup.current.add(id);
    try {
      const savedEvents = await api.getEvents(id);
      if (savedEvents.some(event => ['user', 'message', 'delta', 'tool', 'error', 'approval'].includes(event.type))) return;
      if (sessionDraftsRef.current[id]?.prompt.trim() || sessionDraftsRef.current[id]?.attachments.length) return;
      if (isSessionRunActive(id, runningSessions.current, sendingSessionIdsRef.current) || pendingSendCounts.current.has(id)) return;
      if (!allowSelected && currentSessionIdRef.current === id) return;
      await api.deleteSession(id);
      setData(current => current ? { ...current, sessions: current.sessions.filter(item => item.id !== id) } : current);
      setEvents(current => { const next = { ...current }; delete next[id]; return next; });
      setSessionDrafts(current => { const next = { ...current }; delete next[id]; return next; });
      setUnread(current => { const next = { ...current }; delete next[id]; return next; });
      setStatuses(current => { const next = { ...current }; delete next[id]; return next; });
      setBrowserStates(current => { const next = { ...current }; delete next[id]; return next; });
      sessionNames.current.delete(id);
      runtimeKindsRef.current.delete(id);
      if (currentSessionIdRef.current === id) setSessionId('');
    } catch (reason) {
      setError(message(reason));
    } finally {
      emptySessionCleanup.current.delete(id);
    }
  }
  function updateSession(updated: Session) {
    setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === updated.id ? updated : item) } : current);
  }
  async function refreshRequirementAdmission() {
    if (!session || !requiresRequirementAdmission(session.jiraIssue) || requirementBusy || running) return;
    setRequirementBusy(true); setError(''); setNotice('');
    try {
      const updated = await api.refreshRequirementAdmission(session.id);
      updateSession(updated);
      setNotice(requiresRequirementAdmission(updated.jiraIssue)
        ? updated.requirementAdmission?.status === 'error' ? 'Jira 快照获取失败；可检查 Jira 连接后重试，开发会话仍可继续。' : 'Jira 快照已刷新，需求准入提示已更新。'
        : 'Jira 快照已刷新。');
    } catch (reason) { setError(message(reason)); }
    finally { setRequirementBusy(false); }
  }
  async function resolveRequirementItem(itemId: string, action: RequirementResolutionAction, valueText?: string, reason?: string) {
    if (!session || !requiresRequirementAdmission(session.jiraIssue) || requirementBusy || running) return;
    setRequirementBusy(true); setError(''); setNotice('');
    try {
      const updated = await api.resolveRequirementItem(session.id, itemId, action, valueText, reason);
      updateSession(updated);
      setNotice('需求记录已保存，准入提示已更新；该提示不阻断开发。');
    } catch (reason) { setError(message(reason)); }
    finally { setRequirementBusy(false); }
  }
  const runtimeChecked = useCallback((kind: RuntimeKind, health: RuntimeHealth) => {
    runtimeHealthUpdates.current.values.set(kind, { version: ++runtimeHealthUpdates.current.version, health });
    setData(current => current ? { ...current, runtimes: { ...current.runtimes, [kind]: health }, runtime: (current.runtime.kind ?? current.settings.runtimeKind) === kind ? health : current.runtime } : current);
  }, []);
  function settingsChanged(settings: SettingsSnapshot) {
    const sequence = ++settingsRefreshSequence.current;
    const healthVersion = runtimeHealthUpdates.current.version;
    setData(current => current ? { ...current, settings } : current);
    void api.bootstrap(mode).then(snapshot => {
      if (sequence !== settingsRefreshSequence.current) return;
      const next = mergeRuntimeSnapshot(snapshot, healthVersion);
      setData(current => current ? { ...current, settings: next.settings, projects: next.projects, deliveryProjects: next.deliveryProjects, sessions: next.sessions, provider: next.provider, runtime: next.runtime, runtimes: next.runtimes } : current);
    }).catch(reason => setError(message(reason)));
  }
  function openSettings(tab: typeof settingsTab = 'providers') { if (sessionId) void discardEmptySession(sessionId, true); setSettingsTab(tab); setShowSettings(true); }
  async function closeBrowser() {
    if (!sessionId) return;
    try { await api.closeBrowser(sessionId); setBrowserStates(current => current[sessionId] ? { ...current, [sessionId]: { ...current[sessionId], visible: false } } : current); }
    catch (reason) { setError(message(reason)); }
  }
  useEffect(() => api.onBrowserState(state => { setBrowserStates(current => ({ ...current, [state.sessionId]: state })); }), [api]);
  useEffect(() => {
    const tasks = agentTasksToReveal(agentTasks.tasks, sessionId, revealedAgentTasks.current, agentTasks.events);
    if (!tasks.length) return;
    tasks.forEach(task => revealedAgentTasks.current.add(task.id));
    setInspector('agents');
    if (!layoutRef.current.rightVisible) changeLayout({ rightVisible: true });
  }, [agentTasks.tasks, agentTasks.events, sessionId]);
  useEffect(() => {
    if (!hasAgentTasks) setInspector(current => current === 'agents' ? 'jira' : current);
  }, [hasAgentTasks, sessionId]);
  useEffect(() => {
    if (!sessionId) return;
    let disposed = false;
    void api.browserState(sessionId).then(state => { if (!disposed) setBrowserStates(current => current[sessionId] ? current : { ...current, [sessionId]: state }); }).catch(reason => { if (!disposed) setError(message(reason)); });
    return () => { disposed = true; void api.setBrowserViewport({ sessionId, visible: false }).catch(() => {}); };
  }, [api, sessionId]);
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
    return kind === 'left' ? current.leftWidth ?? 220 : kind === 'right' ? current.rightWidth ?? 420 : kind === 'composer' ? current.composerHeight ?? 110 : kind === 'standalone' ? current.standaloneSessionsHeight ?? 30 : current.bottomHeight ?? 180;
  }
  function resizePatch(kind: ResizeKind, value: number): Partial<LayoutPreferences> {
    return kind === 'left' ? { leftWidth: value } : kind === 'right' ? { rightWidth: value } : kind === 'composer' ? { composerHeight: value } : kind === 'standalone' ? { standaloneSessionsHeight: value } : { bottomHeight: value };
  }
  function resizeBounds(kind: ResizeKind) {
    const current = layoutRef.current;
    const min = kind === 'left' ? 200 : kind === 'right' ? 320 : kind === 'composer' ? 80 : kind === 'standalone' ? 15 : 100;
    let max = kind === 'left' ? 520 : kind === 'right' ? 840 : kind === 'composer' ? 400 : kind === 'standalone' ? 75 : 480;
    if (kind === 'left' || kind === 'right') {
      const responsiveMax = kind === 'left'
        ? 520
        : window.innerWidth <= 1199 ? 600 : window.innerWidth <= 1439 ? 720 : 840;
      max = Math.min(max, responsiveMax);
      const other = kind === 'left' ? current.rightVisible ? current.rightWidth ?? 420 : 0 : current.leftVisible ? current.leftWidth ?? 220 : 0;
      max = Math.min(max, window.innerWidth - other - 360);
    } else if (kind !== 'standalone') {
      const available = document.querySelector(kind === 'composer' ? '.conversation' : '.workspace')?.clientHeight ?? window.innerHeight;
      max = Math.min(max, Math.round(available * (kind === 'composer' ? .5 : .55)));
    }
    return { min, max: Math.max(min, max) };
  }
  function adjustResize(kind: ResizeKind, event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Home') { event.preventDefault(); changeLayout(resizePatch(kind, kind === 'left' ? 220 : kind === 'right' ? 420 : kind === 'composer' ? 110 : kind === 'standalone' ? 30 : 180)); return; }
    const step = kind === 'standalone' ? (event.shiftKey ? 10 : 5) : event.shiftKey ? 40 : 12;
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
    setDraftProvider(session?.providerId || defaultProvider?.id || '');
    setDraftModel(session?.model || defaultProvider?.models.find(model => model.enabled)?.id || '');
    setDraftSystem(session?.system || '通用');
    setDraftReasoning(session?.reasoningEffort || '');
    setBindProjectId(session?.projectId || '');
    setBindDeliveryProjectId(session?.deliveryProjectId || '');
  }, [session?.id, session?.projectId, session?.deliveryProjectId, session?.providerId, session?.model, session?.system, session?.reasoningEffort, sessionRuntimeKind, defaultProvider?.id, defaultProvider?.models.find(model => model.enabled)?.id]);
  useEffect(() => {
    let alive = true;
    const target = data?.projects.find(item => item.id === (session ? bindProjectId : projectId));
    if (!target) { setBranchOptions([]); setBaseBranch(''); setBranchLoading(false); return () => { alive = false; }; }
    setBranchOptions([]); setBaseBranch(''); setBranchLoading(true);
    api.listProjectBranches(target.id).then(branches => {
      if (!alive) return;
      const options = [...new Set(branches.filter(value => value.trim()))];
      setBranchOptions(options);
      const preferredBranch = target.id === session?.projectId ? session.baseBranch || target.branch : target.branch;
      setBaseBranch(options.includes(preferredBranch) ? preferredBranch : options[0] || preferredBranch);
    }).catch(() => {
      if (!alive) return;
      setBranchOptions(target.branch && target.branch !== '(detached)' ? [target.branch] : []);
      setBaseBranch(target.branch === '(detached)' ? '' : target.branch);
    }).finally(() => { if (alive) setBranchLoading(false); });
    return () => { alive = false; };
  }, [api, projectId, bindProjectId, session?.id, session?.projectId, session?.baseBranch, data?.projects]);
  async function configure(patch: { providerId?: string; model?: string; system?: ProductSystem; reasoningEffort?: ReasoningEffort; runtimeKind?: RuntimeKind; delegationMode?: AgentDelegationMode }, successNotice?: string) {
    if (!session || running || busy) return;
    setBusy('configure'); setError(''); setNotice('');
    let updated: Session;
    try {
      updated = await api.configureSession(session.id, patch);
    }
    catch (reason) {
      if ('reasoningEffort' in patch) setDraftReasoning(session.reasoningEffort || '');
      setError(message(reason));
      setBusy('');
      return;
    }
    updateSession(updated);
    try {
      await refresh();
      updateSession(updated);
      if (successNotice) setNotice(successNotice);
    } catch (reason) {
      setError(`会话设置已保存，但界面刷新失败：${message(reason)}`);
    } finally { setBusy(''); }
  }
  function configureSelectedModel(providerId: string, model: { id: string; name: string }) {
    const preferredRuntime = runtimeForSelectedModel(model.id, model.name);
    const runtimeKind = preferredRuntime && preferredRuntime !== sessionRuntimeKind ? preferredRuntime : undefined;
    setDraftProvider(providerId);
    setDraftModel(model.id);
    void configure(
      { providerId, model: model.id, ...(runtimeKind ? { runtimeKind } : {}) },
      runtimeKind ? `已根据所选模型自动切换到 ${runtimeLabel(runtimeKind)}。` : undefined,
    );
  }
  function selectSessionProvider(providerId: string) {
    const provider = providerChoices.find(item => item.id === providerId);
    const model = provider?.models.find(item => item.id === draftModel && item.enabled) || provider?.models.find(item => item.enabled);
    if (model) configureSelectedModel(providerId, model);
    else setDraftProvider(providerId);
  }
  async function switchSessionRuntime(kind: RuntimeKind) {
    if (!session || kind === sessionRuntimeKind || running || busy) return;
    if (kind === 'grok_build_acp') { setError('该运行时已隐藏，请新建会话选择其他运行时。'); return; }
    if (session.runtimeThreadId && sessionRuntimeKind === 'grok_build_acp') { setError('此会话已建立 Runtime 绑定，无法切换运行时。'); return; }
    const choices = sessionProviderChoices(data?.settings, kind);
    const usableProvider = (item: typeof choices[number]) => item.enabled && item.hasKey && item.models.some(model => model.enabled);
    const provider = choices.find(item => item.id === session.providerId && usableProvider(item)) || choices.find(usableProvider);
    if (kind === 'claude_agent_sdk' && !provider) { setSessionSettingsOpen(true); setError('Claude Runtime 不支持 Grok 模型，请先配置带有效凭据的非 Grok 模型。'); return; }
    setBusy('runtime'); setError(''); setNotice('');
    try {
      const model = provider?.models.find(item => item.id === session.model && item.enabled) || provider?.models.find(item => item.enabled);
      const updated = await api.configureSession(session.id, { runtimeKind: kind, ...(provider && model ? { providerId: provider.id, model: model.id } : {}) });
      setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === updated.id ? updated : item) } : current);
      setNotice(`当前会话已切换为 ${runtimeLabel(kind)}。`);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function respondApproval(requestId: string, decision: 'allow_once' | 'reject_once' | 'full') {
    const targetSessionId = sessionId;
    const marker = `${targetSessionId}:${requestId}`;
    if (!api.respondRuntimeApproval || approvalBusy.has(marker) || approvalSubmitted.has(marker) || !runtimeApprovals.some(event => event.approval?.requestId === requestId)) return;
    setApprovalBusy(current => new Set(current).add(marker));
    try {
      await api.respondRuntimeApproval(targetSessionId, requestId, decision);
      setApprovalSubmitted(current => new Set(current).add(marker));
      if (decision === 'full') {
        setData(current => current ? { ...current, settings: { ...current.settings, runtimeAccess: 'full' } } : current);
        setNotice('已允许本次操作，所有会话从下一轮起使用完全访问。');
      }
      const saved = await api.getEvents(targetSessionId);
      setEvents(current => ({ ...current, [targetSessionId]: mergeRendererEvents(saved, current[targetSessionId] || [], sessionRuntimeKind) }));
    } catch (reason) { setError(message(reason)); }
    finally { setApprovalBusy(current => { const next = new Set(current); next.delete(marker); return next; }); }
  }
  async function bindCurrentSession(targetProjectId = bindProjectId) {
    if (!session || targetProjectId === (session.projectId || '') || running || busy) return;
    const targetProjectName = data?.projects.find(item => item.id === targetProjectId)?.name;
    setBusy('bind-project'); setError(''); setNotice('');
    try {
      const targetBaseBranch = targetProjectId ? await resolveBaseBranch(targetProjectId) : undefined;
      const updated = await api.bindSessionProject(session.id, targetProjectId, targetBaseBranch);
      await refresh();
      setProjectId(updated.projectId || '');
      setSessionId(updated.id);
      setSessionSettingsOpen(false);
      // refresh() 更新 React 状态是异步的，差异直接按接口返回的项目绑定读取。
      try {
        const nextDiffs = updated.projectId ? await api.getDiff(updated.id) : [];
        setDiffs(nextDiffs);
        setSelectedFile('');
        setDiffExpanded(false);
        setDiffError('');
      } catch (reason) {
        setDiffs([]); setSelectedFile(''); setDiffError(message(reason));
      }
      if (targetProjectId) setNotice(`会话已切换到项目「${targetProjectName}」。`);
      const savedEvents = await api.getEvents(updated.id);
      setEvents(current => ({ ...current, [updated.id]: mergeRendererEvents(savedEvents, current[updated.id] || [], updated.runtimeKind) }));
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function bindCurrentDeliveryProject(deliveryProjectId: string) {
    if (!session || mode !== 'delivery' || deliveryProjectId === (session.deliveryProjectId || '') || running || busy) return;
    setBusy('bind-project'); setError(''); setNotice('');
    try {
      const updated = await api.bindSessionDeliveryProject(session.id, deliveryProjectId);
      await refresh();
      setProjectId(updated.deliveryProjectId || '');
      setSessionId(updated.id);
      const name = data?.deliveryProjects?.find(item => item.id === deliveryProjectId)?.name;
      setNotice(deliveryProjectId ? `会话已归入交付项目「${name || '项目'}」。` : '会话已移出交付项目。');
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function switchSessionBranch(value: string) {
    if (!session?.projectId || !value || value === session.baseBranch || running) return;
    setBusy('branch'); setError(''); setNotice('');
    try {
      const updated = await api.switchSessionBranch(session.id, value);
      setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === updated.id ? updated : item) } : current);
      setEvents(current => ({ ...current, [updated.id]: [] }));
      setSelectedFile('');
      setDiffExpanded(false);
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
  async function pasteConversationAttachments(files: File[]) {
    if (!session || !files.length) return;
    if (running || busy) { setError('当前会话暂不能添加附件，请等待正在进行的操作完成。'); return; }
    setBusy('attachments'); setError(''); setNotice('');
    try {
      const added = await api.addConversationAttachments(session.id, files);
      if (added.length) {
        setConversationAttachments(current => [...current, ...added]);
        setNotice(`已添加 ${added.length} 个附件，可检查后发送。`);
      }
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  function handleComposerPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    const files = Array.from(event.clipboardData.files);
    if (!files.length) return;
    const clipboardText = event.clipboardData.getData('text/plain');
    const target = event.currentTarget;
    event.preventDefault();
    event.stopPropagation();
    if (clipboardText) {
      const start = target.selectionStart;
      const end = target.selectionEnd;
      const available = Math.max(0, 32000 - target.value.length + end - start);
      const inserted = clipboardText.slice(0, available);
      setPrompt(target.value.slice(0, start) + inserted + target.value.slice(end));
      window.requestAnimationFrame(() => { target.focus(); target.setSelectionRange(start + inserted.length, start + inserted.length); });
    }
    void pasteConversationAttachments(files);
  }
  function handleComposerDragOver(event: ReactDragEvent<HTMLFormElement>) {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
  function handleComposerDrop(event: ReactDragEvent<HTMLFormElement>) {
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) return;
    event.preventDefault();
    event.stopPropagation();
    void pasteConversationAttachments(files);
  }
  async function refreshDiff(id = sessionId, background = false) {
    if (id !== selectedSessionRef.current) return;
    if (background && diffInFlight.current.has(id)) return;
    const sequence = ++diffSequence.current;
    const targetSession = data?.sessions.find(item => item.id === id);
    if (!id || (targetSession && !targetSession.projectId) || (session?.id === id && !session.projectId)) { setDiffs([]); setSelectedFile(''); setDiffError(''); setDiffBusy(false); return; }
    diffInFlight.current.set(id, sequence);
    if (!background) setDiffBusy(true);
    setDiffError('');
    try {
      const next = await api.getDiff(id);
      if (sequence !== diffSequence.current || id !== selectedSessionRef.current) return;
      setDiffs(next);
      setSelectedFile(current => next.some(file => file.path === current) ? current : '');
    } catch (reason) { if (sequence === diffSequence.current && id === selectedSessionRef.current) { setDiffs([]); setDiffError(message(reason)); } }
    finally {
      if (diffInFlight.current.get(id) === sequence) diffInFlight.current.delete(id);
      if (sequence === diffSequence.current) setDiffBusy(false);
    }
  }

  async function runFileAction(action: 'stage' | 'unstage' | 'discard', file: FileDiff) {
    if (!session?.projectId) return;
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
    let bootstrapping = true;
    const observedRunStatuses = new Set<string>();
    if (!api) { setError('桌面桥接未就绪，请通过精工Agent桌面程序打开。'); return; }
    const healthVersion = runtimeHealthUpdates.current.version;
    if (!alternateModePrefetched.current) {
      alternateModePrefetched.current = true;
      const alternateMode: WorkMode = mode === 'delivery' ? 'development' : 'delivery';
      void loadModeSnapshot(alternateMode).catch(() => undefined);
    }
    const offRuntime = api.onRuntimeHealthChanged?.(health => {
      if (alive) runtimeChecked(health.kind, health);
    });
    const cached = modeSnapshots.current[mode];
    if (cached) {
      bootstrapping = false;
      applyModeSnapshot(cached, mode);
    }
    loadModeSnapshot(mode).then(snapshot => {
      if (!alive) return;
      const next = mergeRuntimeSnapshot(snapshot, healthVersion);
      for (const id of next.activeSessionIds ?? []) {
        if (!observedRunStatuses.has(id)) runningSessions.current.add(id);
      }
      bootstrapping = false;
      modeSnapshots.current[mode] = next;
      applyModeSnapshot(next, mode);
    }).catch(reason => alive && setError(message(reason)));
    let pendingEvents: AgentEvent[] = [];
    let frame: number | undefined;
    const flushEvents = () => {
      frame = undefined;
      if (!alive || pendingEvents.length === 0) return;
      const batch = pendingEvents;
      pendingEvents = [];
      const visibleSessions = batch.filter(event => (event.type === 'delta' || event.type === 'message') && event.text.trim()).map(event => event.sessionId);
      for (const id of visibleSessions) pendingUiRenderSessions.current.add(id);
      setEvents(current => {
        const next = { ...current };
        const grouped = new Map<string, AgentEvent[]>();
        for (const event of batch) {
          const runtimeKind = runtimeKindsRef.current.get(event.sessionId);
          if (event.type === 'tool' && hidesRuntimeToolEvents(runtimeKind)) continue;
          const sessionEvents = grouped.get(event.sessionId);
          if (sessionEvents) sessionEvents.push(event);
          else grouped.set(event.sessionId, [event]);
        }
        for (const [id, sessionBatch] of grouped) {
          const runtimeKind = runtimeKindsRef.current.get(id);
          next[id] = mergeEvents(rendererEvents(next[id] || [], runtimeKind), sessionBatch);
        }
        return next;
      });
    };
    const off = api.onEvent(event => {
      if (!alive) return;
      if (!visibleSessionIds.current.has(event.sessionId)) return;
      pendingEvents.push(event);
      if (event.type === 'status' && event.text in statusLabels) {
        setStatuses(current => ({ ...current, [event.sessionId]: event.text as SessionStatus }));
        if (bootstrapping && ['running', 'waiting-approval', 'completed', 'failed', 'interrupted'].includes(event.text)) observedRunStatuses.add(event.sessionId);
      }
      if (event.type === 'status' && ['running', 'waiting-approval'].includes(event.text)) {
        if (event.text === 'running') { uiRenderMarkedSessions.current.delete(event.sessionId); pendingUiRenderSessions.current.delete(event.sessionId); }
        runningSessions.current.add(event.sessionId);
        if (event.sessionId === selectedSessionRef.current) setWorkingExpanded(false);
      }
      else if (event.type === 'status' && ['completed', 'failed', 'interrupted'].includes(event.text)) {
        const wasRunning = runningSessions.current.delete(event.sessionId);
        if (wasRunning && event.text === 'completed') {
          if (mode === 'development') void refreshDiff(event.sessionId);
          setUnread(current => ({ ...current, [event.sessionId]: event.id }));
          setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === event.sessionId ? { ...item, status: 'completed', unreadCompletionId: event.id } : item) } : current);
          void api.getSettings(mode).then(settings => setData(current => current ? { ...current, settings } : current)).catch(() => {});
          const name = sessionNames.current.get(event.sessionId) || '当前会话';
          setNotice(`会话「${name}」已完成。`);
          void api.notifyCompletion(name.length > 120 ? `${name.slice(0, 119)}…` : name).catch(() => {});
          playCompletionSound(completionSoundRef.current);
        }
      }
      if (event.type === 'status' && ['completed', 'failed', 'interrupted'].includes(event.text)) flushEvents();
      else if (frame === undefined) frame = window.requestAnimationFrame(flushEvents);
    });
    const offTitle = api.onSessionTitleChanged(updated => {
      if (!alive) return;
      if (!visibleSessionIds.current.has(updated.id)) return;
      setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === updated.id ? { ...item, title: updated.title, titleSource: updated.titleSource } : item) } : current);
    });
    const offReadAccess = api.onSessionReadAccessChanged?.(updated => {
      if (!alive) return;
      if (!visibleSessionIds.current.has(updated.id)) return;
      setData(current => current ? { ...current, sessions: current.sessions.map(item => item.id === updated.id ? { ...item, readAccess: updated.readAccess } : item) } : current);
    });
    const offUpdate = api.onUpdateStatus(status => {
      if (!alive) return;
      setData(current => current ? { ...current, settings: { ...current.settings, update: status } } : current);
      if (status.state === 'available') { setUpdateAvailableVersion(status.version ?? ''); setNotice(`发现精工Agent ${status.version ?? ''} 更新，自动更新正在后台下载。`); }
      if (status.state === 'downloaded') { setUpdateAvailableVersion(''); setUpdateDownloadedVersion(status.version ?? ''); setNotice(`精工Agent ${status.version ?? ''} 更新已下载，可立即重启完成静默更新。`); }
    });
    return () => {
      alive = false;
      pendingEvents = [];
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      off(); offTitle(); offReadAccess?.(); offRuntime?.(); offUpdate();
    };
  }, [api, mode]);

  useEffect(() => {
    function move(event: PointerEvent) {
      const drag = resizeDrag.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      const { min, max } = resizeBounds(drag.kind);
      if (drag.kind === 'standalone') {
        const sidebarHeight = document.querySelector<HTMLElement>('#project-sidebar')?.clientHeight ?? window.innerHeight;
        const deltaPercent = sidebarHeight > 0 ? (drag.startY - event.clientY) / sidebarHeight * 100 : 0;
        drag.latest = Math.max(min, Math.min(max, Math.round(drag.startValue + deltaPercent)));
      } else {
        const delta = drag.kind === 'left' ? event.clientX - drag.startX : drag.kind === 'right' ? drag.startX - event.clientX : drag.startY - event.clientY;
        drag.latest = Math.max(min, Math.min(max, Math.round(drag.startValue + delta)));
      }
      const variable = drag.kind === 'left' ? '--sidebar-width' : drag.kind === 'right' ? '--inspector-width' : drag.kind === 'composer' ? '--composer-height' : drag.kind === 'standalone' ? '--standalone-height' : '--activity-height';
      const unit = drag.kind === 'standalone' ? '%' : 'px';
      document.querySelector<HTMLElement>('.dock-layout')?.style.setProperty(variable, `${drag.latest}${unit}`);
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
    setSelectedFile('');
    setDiffExpanded(false);
    setWorkingExpanded(false);
    if (!sessionId || !api) { setDiffs([]); return; }
    let alive = true;
    setError('');
    api.getEvents(sessionId).then(next => {
      if (alive) setEvents(current => ({ ...current, [sessionId]: mergeRendererEvents(next, current[sessionId] || [], sessionRuntimeKind) }));
    }).catch(reason => alive && setError(message(reason)));
    void refreshDiff(sessionId);
    return () => { alive = false; };
  }, [sessionId, mode]);

  useEffect(() => {
    const leavingSessionId = sessionId;
    return () => {
      if (modeSwitching.current) return;
      if (leavingSessionId) void discardEmptySession(leavingSessionId);
    };
  }, [sessionId, mode, api]);

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
    if (!fileContextMenu && !messageFileContextMenu) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.file-context-menu')) return;
      setFileContextMenu(null);
      setMessageFileContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); setFileContextMenu(null); setMessageFileContextMenu(null); } };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => { document.removeEventListener('pointerdown', closeOnOutside); document.removeEventListener('keydown', closeOnEscape); };
  }, [fileContextMenu, messageFileContextMenu]);
  useEffect(() => { if (layout.bottomVisible) activityEndRef.current?.scrollIntoView({ block: 'end' }); }, [activityEvents.length, layout.bottomVisible]);
  useEffect(() => {
    if (sessionId && !running) void refreshDiff(sessionId);
  }, [sessionId, status, running]);

  useEffect(() => {
    if (!running || !sessionId || !session?.projectId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      await refreshDiff(sessionId, true);
      if (!stopped) timer = setTimeout(() => { void poll(); }, 2000);
    };
    timer = setTimeout(() => { void poll(); }, 1000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [sessionId, session?.projectId, running]);

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
  function openDeliveryProjectDialog() {
    setDeliveryProjectName('');
    setDeliveryProjectDialogOpen(true);
  }
  async function addDeliveryProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = deliveryProjectName.trim();
    if (!name) return;
    setBusy('project'); setError(''); setNotice('');
    try {
      const created = await api.createDeliveryProject(name);
      await refresh();
      setProjectId(created.id);
      setSessionId('');
      modeSelections.current.delivery = { projectId: created.id, sessionId: '' };
      setDeliveryProjectDialogOpen(false);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function switchWorkMode(next: WorkMode) {
    if (next === mode || modeSwitching.current) return;
    const sequence = ++modeSwitchSequence.current;
    modeSwitching.current = true;
    if (data) modeSnapshots.current[mode] = data;
    modeSelections.current[mode] = { projectId, sessionId };
    setSessionSettingsOpen(false);
    setNewSessionMenu(null);
    setError('');
    const target = modeSnapshots.current[next];
    try {
      const snapshot = target ?? await loadModeSnapshot(next);
      if (sequence !== modeSwitchSequence.current) return;
      setModeTransitioning(true);
      const transitionMs = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150;
      if (transitionMs) await new Promise(resolve => window.setTimeout(resolve, transitionMs));
      if (sequence !== modeSwitchSequence.current) return;
      applyModeSnapshot(snapshot, next);
      setInspector(next === 'delivery' ? 'agents' : 'jira');
      onModeChange(next);
      if (transitionMs) await new Promise(resolve => window.requestAnimationFrame(() => resolve(undefined)));
      if (sequence === modeSwitchSequence.current) {
        modeSwitching.current = false;
        setModeTransitioning(false);
      }
    } catch (reason) {
      if (sequence !== modeSwitchSequence.current) return;
      modeSwitching.current = false;
      setModeTransitioning(false);
      setError(message(reason));
    }
  }
  async function resolveBaseBranch(targetProjectId: string): Promise<string | undefined> {
    const target = data?.projects.find(item => item.id === targetProjectId);
    if (!target) return undefined;
    if (targetProjectId === (session ? bindProjectId : projectId) && baseBranch) return baseBranch;
    try {
      const options = await api.listProjectBranches(targetProjectId);
      return options.includes(target.branch) ? target.branch : options[0] || undefined;
    } catch { return target.branch === '(detached)' ? undefined : target.branch; }
  }
  function openCreateSession(targetProjectId = projectId) {
    const availableProjects = mode === 'delivery' ? data?.deliveryProjects : data?.projects;
    const selectedProjectId = targetProjectId && availableProjects?.some(item => item.id === targetProjectId) ? targetProjectId : undefined;
    if (sessionId) void discardEmptySession(sessionId, true);
    setSessionSettingsOpen(false);
    void newSession(selectedProjectId);
  }
  function openIndependentSession() {
    if (sessionId) void discardEmptySession(sessionId, true);
    setSessionSettingsOpen(false);
    setNewSessionMenu(null);
    void newSession(undefined);
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey || event.key.toLowerCase() !== 'n') return;
      event.preventDefault();
      if (!data || busy) return;
      setShowSettings(false);
      setSessionSettingsOpen(false);
      openCreateSession();
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [data, busy, projectId, bindProjectId, baseBranch, sessionId, sessionRuntimeKind]);
  async function newSession(targetProjectId?: string) {
    const availableProjects = mode === 'delivery' ? data?.deliveryProjects : data?.projects;
    const selectedProjectId = targetProjectId && availableProjects?.some(item => item.id === targetProjectId) ? targetProjectId : undefined;
    setBusy('session'); setError(''); setNotice('');
    try {
      const created = await api.createSession(mode === 'delivery'
        ? { workMode: mode, ...(selectedProjectId ? { deliveryProjectId: selectedProjectId } : {}), runtimeKind: session?.runtimeKind ?? data?.settings.runtimeKind ?? 'codex' }
        : { workMode: mode, ...(selectedProjectId ? { projectId: selectedProjectId, baseBranch: await resolveBaseBranch(selectedProjectId) } : {}), runtimeKind: session?.runtimeKind ?? data?.settings.runtimeKind ?? 'codex' });
      if (selectedProjectId && mode === 'development') await api.setProjectCollapsed(selectedProjectId, false);
      if (selectedProjectId && mode === 'delivery') await api.setDeliveryProjectCollapsed(selectedProjectId, false);
      await refresh(); setProjectId(created.projectId || created.deliveryProjectId || '');
      setSessionId(created.id);
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function sessionFromJira(key: string, jiraProjectKey: string) {
    if (!jiraAssociationId) return undefined;
    setBusy('jira-session'); setError(''); setNotice('');
    try {
      const created = await api.createSession({ workMode: 'development', projectId: jiraAssociationId, jiraIssueKey: key, jiraProjectKey, baseBranch: await resolveBaseBranch(jiraAssociationId), runtimeKind: session?.runtimeKind ?? 'claude_agent_sdk' });
      await refresh(); setProjectId(created.projectId || ''); setSessionId(created.id);
      if (created.jiraIssue) {
        setSessionDrafts(current => ({ ...current, [created.id]: { prompt: jiraTaskPrompt(created.jiraIssue!), attachments: [] } }));
        const unavailable = created.jiraIssue.attachments.filter(item => item.imageWarning).length;
        const status = created.requirementAdmission?.status;
        const admissionNotice = requiresRequirementAdmission(created.jiraIssue)
          ? `需求准入提示：${status === 'ready' ? '检查完成' : status === 'blocked' ? '存在待确认项' : status === 'error' ? '检查失败' : status === 'stale' ? '需求已变化' : '尚待检查'}，仅供实施参考，不阻断开发。`
          : '';
        setNotice(`已关联 ${created.jiraIssue.key}。${admissionNotice}${unavailable ? ` ${unavailable} 张图片未能带入，可在关联任务详情中重试。` : ''}`);
      }
      else { setError('会话已创建，但未返回 Jira 任务快照，请检查任务关联后再发送。'); }
      return created;
    } catch (reason) { setError(message(reason)); }
    finally { setBusy(''); }
  }
  async function send(event?: FormEvent) {
    event?.preventDefault();
    if ((!prompt.trim() && !conversationAttachments.length) || !session || busy) return;
    if (claudeGrokSelection) { setSessionSettingsOpen(true); setError('Claude Runtime 不支持 Grok 模型，请在会话设置中选择其他模型后应用。'); return; }
    if (!configuredProvider?.hasKey) { setSessionSettingsOpen(true); setError('请先在当前会话设置中选择已配置密钥的中转站，或管理中转站凭据。'); return; }
    if (sessionRuntimeKind === 'grok_build_acp' && (!configuredProvider.enabled || !configuredModel?.enabled || !grokSelectable)) { setError('当前会话运行时或模型不可用，请检查运行时组件状态和会话模型选择。'); return; }
    if (projectBindingChanged) { setError('请先应用本地项目选择，再发送任务。'); return; }
    const text = prompt.trim() || '请分析本轮上传的附件。';
    const attachmentIds = conversationAttachments.map(item => item.id);
    const id = session.id;
    const wasRunning = isSessionRunActive(id, runningSessions.current, sendingSessions);
    pendingSendCounts.current.set(id, (pendingSendCounts.current.get(id) ?? 0) + 1);
    runningSessions.current.add(id);
    setWorkingExpanded(false);
    setError(''); setNotice(''); setSendingSessions(current => new Set(current).add(id));
    setStatuses(current => ({ ...current, [id]: 'running' }));
    setSessionDrafts(current => ({ ...current, [id]: { prompt: '', attachments: [] } }));
    try {
      const result = await api.sendTurn(id, text, attachmentIds);
      if (selectedSessionRef.current === id && result?.queued) setNotice('补充任务已排队，将在当前任务结束后依次执行。');
      else if (selectedSessionRef.current === id && result?.steered) setNotice('补充任务已发送到当前运行任务。');
      const next = await refresh();
      const latest = next.sessions.find(item => item.id === id);
      if (latest) setStatuses(current => ({ ...current, [id]: latest.status }));
      const saved = await api.getEvents(id);
      setEvents(current => ({ ...current, [id]: mergeRendererEvents(saved, current[id] || [], runtimeKindsRef.current.get(id)) }));
    } catch (reason) {
      if (!wasRunning) runningSessions.current.delete(id);
      if (selectedSessionRef.current === id) setError(message(reason));
      if (!wasRunning) setStatuses(current => ({ ...current, [id]: 'failed' }));
      setSessionDrafts(current => {
        const draft = current[id] ?? { prompt: '', attachments: [] };
        return { ...current, [id]: { prompt: draft.prompt ? `${text}\n\n${draft.prompt}` : text, attachments: [...conversationAttachments.filter(item => !draft.attachments.some(existing => existing.id === item.id)), ...draft.attachments] } };
      });
    } finally {
      const remaining = (pendingSendCounts.current.get(id) ?? 1) - 1;
      if (remaining > 0) pendingSendCounts.current.set(id, remaining);
      else {
        pendingSendCounts.current.delete(id);
        setSendingSessions(current => { const next = new Set(current); next.delete(id); return next; });
      }
    }
  }
  async function sendGovernancePrompt(targetSessionId: string, text: string) {
    if (isSessionRunActive(targetSessionId, runningSessions.current, sendingSessionIdsRef.current) || pendingSendCounts.current.has(targetSessionId)) {
      throw new Error('当前会话已有任务运行，请等待结束后再执行计划阶段');
    }
    pendingSendCounts.current.set(targetSessionId, 1);
    runningSessions.current.add(targetSessionId);
    setSendingSessions(current => new Set(current).add(targetSessionId));
    setStatuses(current => ({ ...current, [targetSessionId]: 'running' }));
    let dispatched = false;
    try {
      await api.sendTurn(targetSessionId, text);
      dispatched = true;
      const next = await refresh();
      const latest = next.sessions.find(item => item.id === targetSessionId);
      if (latest) setStatuses(current => ({ ...current, [targetSessionId]: latest.status }));
      const saved = await api.getEvents(targetSessionId);
      setEvents(current => ({ ...current, [targetSessionId]: mergeRendererEvents(saved, current[targetSessionId] || [], runtimeKindsRef.current.get(targetSessionId)) }));
    } catch (reason) {
      if (!dispatched) {
        runningSessions.current.delete(targetSessionId);
        setStatuses(current => ({ ...current, [targetSessionId]: 'failed' }));
      }
      if (selectedSessionRef.current === targetSessionId) setError(message(reason));
      throw reason;
    } finally {
      pendingSendCounts.current.delete(targetSessionId);
      setSendingSessions(current => { const next = new Set(current); next.delete(targetSessionId); return next; });
    }
  }
  async function executeGovernanceStep(input: { taskId: string; prompt: string }) {
    if (busy || running) throw new Error('当前会话仍在处理其他操作');
    setBusy('task-plan'); setError(''); setNotice('');
    try { await sendGovernancePrompt(input.taskId, input.prompt); }
    finally { setBusy(''); }
  }
  async function resumeGovernedTask(input: { projectId?: string; prompt: string }) {
    if (!input.projectId) throw new Error('检查点未关联项目，无法创建恢复会话');
    if (busy || running) throw new Error('当前会话仍在处理其他操作');
    setBusy('task-resume'); setError(''); setNotice('');
    try {
      const created = await api.createSession({ projectId: input.projectId, baseBranch: await resolveBaseBranch(input.projectId), runtimeKind: sessionRuntimeKind });
      let target = created;
      try {
        target = await api.configureSession(created.id, {
          runtimeKind: sessionRuntimeKind,
          ...(session?.providerId ? { providerId: session.providerId } : {}),
          ...(session?.model ? { model: session.model } : {}),
          ...(session?.system ? { system: session.system } : {}),
          ...(session?.reasoningEffort ? { reasoningEffort: session.reasoningEffort } : {}),
        });
      } catch (reason) {
        await api.deleteSession(created.id).catch(() => undefined);
        throw reason;
      }
      runtimeKindsRef.current.set(target.id, target.runtimeKind ?? 'codex');
      await refresh();
      setProjectId(target.projectId ?? '');
      setSessionId(target.id);
      setInspector('iteration');
      if (!layoutRef.current.rightVisible) changeLayout({ rightVisible: true });
      await sendGovernancePrompt(target.id, input.prompt);
      setNotice('已在新会话启动平台级任务恢复。');
    } finally { setBusy(''); }
  }
  async function cancel() {
    if (!sessionId) return;
    try { await api.cancelRun(sessionId); setNotice('取消请求已发送，正在等待精工Agent引擎停止。'); }
    catch (reason) { setError(message(reason)); }
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
  const openMessageFile = useCallback((filePath: string) => {
    const candidate = sessionProject?.path || project?.path;
    if (!candidate) { setError('请先选择项目后查看文件'); return; }
    const normalized = filePath.replace(/\\/g, '/');
    const root = candidate.replace(/\\/g, '/').replace(/\/$/, '');
    const relative = normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : filePath;
    setFilePreviewPath(relative.replace(/^\.\//, ''));
    setInspector('files');
  }, [project?.path, sessionProject?.path]);
  const showMessageFileContextMenu = useCallback((filePath: string, x: number, y: number) => {
    setFileContextMenu(null);
    setMessageFileContextMenu({ kind: 'project', path: filePath, x, y });
  }, []);
  function showConversationAttachmentContextMenu(attachment: ConversationAttachment, x: number, y: number) {
    setFileContextMenu(null);
    setMessageFileContextMenu({ kind: 'attachment', sessionId, attachment, x, y });
  }
  function messageProjectFile(filePath: string) {
    const targetProject = sessionProject || project;
    if (!targetProject) return undefined;
    const normalized = filePath.replace(/\\/g, '/');
    const root = targetProject.path.replace(/\\/g, '/').replace(/\/$/, '');
    const relative = normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`) ? normalized.slice(root.length + 1) : normalized;
    return { path: relative.replace(/^\.\//, ''), target: sessionProject ? sessionId : { projectId: targetProject.id } };
  }
  function openMessageContextFile() {
    const menu = messageFileContextMenu;
    setMessageFileContextMenu(null);
    if (!menu) return;
    if (menu.kind === 'project') {
      const file = messageProjectFile(menu.path);
      if (!file) { setError('请先选择项目后打开文件'); return; }
      void api.openProjectFile(file.target, file.path).catch(reason => setError(message(reason)));
      return;
    }
    void api.openConversationAttachment(menu.sessionId, menu.attachment.id).catch(reason => setError(message(reason)));
  }
  function revealMessageContextFile() {
    const menu = messageFileContextMenu;
    setMessageFileContextMenu(null);
    if (!menu) return;
    if (menu.kind === 'attachment') {
      void api.revealConversationAttachment(menu.sessionId, menu.attachment.id).catch(reason => setError(message(reason)));
      return;
    }
    const file = messageProjectFile(menu.path);
    if (!file) { setError('请先选择项目后打开文件所在位置'); return; }
    void api.revealProjectFile(file.target, file.path).catch(reason => setError(message(reason)));
  }

  function renderProjectGroup(item: NonNullable<typeof data>['projects'][number]) {
    const projectSessions = data?.sessions.filter(sessionItem => sessionItem.projectId === item.id) ?? [];
    const expanded = !!expandedProjectSessions[item.id];
    const visibleSessions = expanded ? projectSessions : projectSessions.slice(0, 3);
    return <section className="project-group" key={item.id} aria-label={`项目 ${item.name}`}>
      <ProjectRow project={item} selected={item.id === projectId} disabled={!!busy || running} createDisabled={!!busy} unread={data?.sessions.some(candidate => candidate.projectId === item.id && !!unread[candidate.id]) ?? false} onSelect={() => { setProjectId(item.id); void toggleProject(item.id); }} onCreateSession={() => openCreateSession(item.id)} onRenamed={async () => { await refresh(); }} onDeleted={async () => { const next = await refresh(); if (projectId === item.id) { const replacement = next.projects[0]; setProjectId(replacement?.id || ''); setSessionId(next.sessions.find(candidate => candidate.projectId === replacement?.id)?.id || ''); } }} />
      <div id={`project-sessions-${item.id}`} hidden={item.collapsed !== false}>
        {visibleSessions.map(sessionItem => <SessionRow key={sessionItem.id} session={sessionItem} status={statuses[sessionItem.id] || sessionItem.status} running={isSessionRunActive(sessionItem.id, runningSessions.current, sendingSessions)} selected={sessionItem.id === sessionId} disabled={!!busy || running} unread={!!unread[sessionItem.id]} onSelect={() => { readSession(sessionItem.id); setProjectId(item.id); setSessionId(sessionItem.id); }} onRenamed={async () => { await refresh(); }} onDeleted={async () => { const next = await refresh(); if (sessionId === sessionItem.id) setSessionId(next.sessions.find(candidate => candidate.projectId === item.id)?.id || ''); }} />)}
        {projectSessions.length > 3 && <button type="button" className="project-more-sessions text-button" onClick={() => setExpandedProjectSessions(current => ({ ...current, [item.id]: !expanded }))}>{expanded ? '收起会话' : `… 还有 ${projectSessions.length - 3} 个会话`}</button>}
      </div>
    </section>;
  }

  async function toggleDeliveryProject(id: string) {
    const item = data?.deliveryProjects?.find(candidate => candidate.id === id);
    if (!item) return;
    const collapsed = item.collapsed !== true;
    setData(current => current ? { ...current, deliveryProjects: current.deliveryProjects?.map(candidate => candidate.id === id ? { ...candidate, collapsed } : candidate) } : current);
    try { await api.setDeliveryProjectCollapsed(id, collapsed); }
    catch (reason) { await refresh(); setError(message(reason)); }
  }

  function renderDeliveryProjectGroup(item: DeliveryTaskProject) {
    const projectSessions = data?.sessions.filter(sessionItem => sessionItem.deliveryProjectId === item.id) ?? [];
    const expanded = !!expandedProjectSessions[item.id];
    const visibleSessions = expanded ? projectSessions : projectSessions.slice(0, 3);
    return <section className="project-group delivery-project-group" key={item.id} aria-label={`交付项目 ${item.name}`}>
      <div className="delivery-sidebar-project-row">
        <button type="button" className={`delivery-sidebar-project ${item.id === projectId ? 'selected' : ''}`} aria-expanded={!item.collapsed} onClick={() => { setProjectId(item.id); void toggleDeliveryProject(item.id); }}><Icon name="chevron" className={item.collapsed ? '' : 'expanded'} /><Icon name="folder" /><span>{item.name}</span><small>{projectSessions.length}</small></button>
        <button type="button" className="icon-button" title={`在${item.name}中新建会话`} aria-label={`在${item.name}中新建会话`} onClick={() => openCreateSession(item.id)} disabled={!!busy}><Icon name="plus" /></button>
      </div>
      <div id={`delivery-project-sessions-${item.id}`} hidden={item.collapsed === true}>
        {visibleSessions.map(sessionItem => <SessionRow key={sessionItem.id} session={sessionItem} status={statuses[sessionItem.id] || sessionItem.status} running={isSessionRunActive(sessionItem.id, runningSessions.current, sendingSessions)} selected={sessionItem.id === sessionId} disabled={!!busy || running} unread={!!unread[sessionItem.id]} onSelect={() => { readSession(sessionItem.id); setProjectId(item.id); setSessionId(sessionItem.id); }} onRenamed={async () => { await refresh(); }} onDeleted={async () => { const next = await refresh(); if (sessionId === sessionItem.id) setSessionId(next.sessions.find(candidate => candidate.deliveryProjectId === item.id)?.id || ''); }} />)}
        {projectSessions.length > 3 && <button type="button" className="project-more-sessions text-button" onClick={() => setExpandedProjectSessions(current => ({ ...current, [item.id]: !expanded }))}>{expanded ? '收起会话' : `… 还有 ${projectSessions.length - 3} 个会话`}</button>}
      </div>
    </section>;
  }

  const layoutStyle = {
    '--sidebar-width': `${layout.leftWidth ?? 220}px`,
    '--inspector-width': `${layout.rightWidth ?? 420}px`,
    '--activity-height': `${layout.bottomHeight ?? 180}px`,
    '--composer-height': `${layout.composerHeight ?? 110}px`,
    '--standalone-height': `${layout.standaloneSessionsHeight ?? 30}%`
  } as CSSProperties;
  const standaloneSessions = data?.sessions.filter(item => mode === 'delivery' ? !item.deliveryProjectId : !item.projectId) ?? [];
  return <div className={`app-shell dock-layout ${layout.leftVisible ? '' : 'left-panel-hidden'} ${layout.rightVisible ? '' : 'right-panel-hidden'} ${layout.bottomVisible ? '' : 'bottom-panel-hidden'} ${modeTransitioning ? 'mode-transitioning' : ''}`} style={layoutStyle}>
    <aside id="project-sidebar" className="sidebar" aria-label="项目和会话" hidden={!layout.leftVisible} inert={showSettings} aria-hidden={showSettings || undefined}>
       <div className="brand"><Mark /><div><strong>精工Agent</strong><span>{mode === 'delivery' ? '交付助手' : '研发助手'}</span></div><span className="version">v{data?.settings.appVersion || "…"}</span></div>
        <div className="work-mode-switch" role="group" aria-label="工作模式"><button type="button" className={mode === 'delivery' ? 'active' : ''} aria-pressed={mode === 'delivery'} onClick={() => switchWorkMode('delivery')}>交付模式</button><button type="button" className={mode === 'development' ? 'active' : ''} aria-pressed={mode === 'development'} onClick={() => switchWorkMode('development')}>开发模式</button></div>
        <div className="sidebar-section top-nav"><button ref={newSessionButtonRef} className="nav-item" disabled={!data || !!busy} onContextMenu={(event: ReactMouseEvent<HTMLButtonElement>) => { event.preventDefault(); event.stopPropagation(); setNewSessionMenu({ x: event.clientX, y: event.clientY }); }} onClick={() => { setSessionSettingsOpen(false); openCreateSession(); }} title="新建会话 (Ctrl+N)" aria-keyshortcuts="Control+N"><Icon name="plus" />新建会话</button><button type="button" className={`nav-item ${!session ? 'active' : ''}`} disabled={!data || !!busy} onClick={() => { setSessionSettingsOpen(false); setSessionId(''); }}><Icon name="layers" />{mode === 'delivery' ? '交付任务工作台' : '研发任务工作台'}</button></div>
      {newSessionMenu && <div ref={newSessionMenuRef} className="new-session-menu" role="menu" aria-label="新建会话方式" style={{ left: newSessionMenu.x, top: newSessionMenu.y }} onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}><button type="button" role="menuitem" disabled={!data || !!busy} onClick={openIndependentSession}><Icon name="chat" />新建独立会话</button>{projectId && <button type="button" role="menuitem" disabled={!data || !!busy} onClick={() => { setNewSessionMenu(null); openCreateSession(projectId); }}><Icon name="folder" />新建项目会话</button>}</div>}
      <div className="project-list">
        <div className="sidebar-section projects-heading"><span>{mode === 'delivery' ? '交付项目' : '本地项目'}</span><button className="icon-button" onClick={() => { if (mode === 'delivery') openDeliveryProjectDialog(); else void addProject(); }} disabled={!!busy} title={mode === 'delivery' ? '新建交付项目' : '添加 Git 项目'} aria-label={mode === 'delivery' ? '新建交付项目' : '添加 Git 项目'}><Icon name="plus" /></button></div>
        {mode === 'development' && !data?.projects.length && <div className="sidebar-empty">可以添加 Git 项目，也可以直接创建独立会话。</div>}
        {mode === 'delivery' && !data?.deliveryProjects?.length && <div className="sidebar-empty">创建交付项目后，可将交付会话归入项目。</div>}
        {mode === 'development' && data?.projects.map(item => renderProjectGroup(item))}
        {mode === 'delivery' && data?.deliveryProjects?.map(item => renderDeliveryProjectGroup(item))}
      </div>
      {!!standaloneSessions.length && <><button type="button" className="panel-resize-handle standalone-resize-handle" role="separator" aria-label="调整独立会话区域高度" aria-orientation="horizontal" aria-valuemin={15} aria-valuemax={75} aria-valuenow={layout.standaloneSessionsHeight ?? 30} title="上下拖动调整独立会话区域高度" onPointerDown={event => beginResize('standalone', event)} onKeyDown={event => adjustResize('standalone', event)} onDoubleClick={() => changeLayout({ standaloneSessionsHeight: 30 })} /><section className="standalone-sessions" aria-label="独立会话"><div className="standalone-sessions-heading">独立会话</div>{standaloneSessions.map(sessionItem => <SessionRow key={sessionItem.id} session={sessionItem} status={statuses[sessionItem.id] || sessionItem.status} running={isSessionRunActive(sessionItem.id, runningSessions.current, sendingSessions)} selected={sessionItem.id === sessionId} disabled={!!busy || running} unread={!!unread[sessionItem.id]} onSelect={() => { readSession(sessionItem.id); setProjectId(mode === 'delivery' ? sessionItem.deliveryProjectId || '' : sessionItem.projectId || ''); setSessionId(sessionItem.id); }} onRenamed={async () => { await refresh(); }} onDeleted={async () => { const next = await refresh(); if (sessionId === sessionItem.id) setSessionId(next.sessions.find(candidate => mode === 'delivery' ? !candidate.deliveryProjectId : !candidate.projectId)?.id || ''); }} />)}</section></>}
      <div className="sidebar-footer">
        <div className="sidebar-actions"><button onClick={() => openSettings()} disabled={!data}><Icon name="settings" />全局设置</button></div>
        <div className="local-caption"><Icon name="shield" />数据保存在当前 Windows 用户本机</div>
      </div>
       <button type="button" className="panel-resize-handle sidebar-resize-handle" role="separator" aria-label="调整项目和会话栏宽度" aria-orientation="vertical" aria-valuemin={200} aria-valuemax={520} aria-valuenow={Math.min(layout.leftWidth ?? 220, 520)} title="拖动调整项目和会话栏宽度" onPointerDown={event => beginResize('left', event)} onKeyDown={event => adjustResize('left', event)} onDoubleClick={() => changeLayout({ leftWidth: 220 })} />
    </aside>

    <div className="workspace" inert={showSettings} aria-hidden={showSettings || undefined}>
      <header className="workspace-header">
        <div className="breadcrumbs"><strong>{session ? mode === 'delivery' ? deliveryProject?.name || '未归属交付项目' : project?.name || '独立会话' : mode === 'delivery' ? '交付任务工作台' : '研发任务工作台'}</strong>{session && <><Icon name="chevron" /><span className="breadcrumb-session">{sessionTitle}</span></>}</div>
        <div className="header-actions">{mode === 'development' && <button className={`icon-button ${browserOpen ? 'panel-visible' : ''}`} title="打开会话浏览器" aria-label="打开会话浏览器" aria-controls="browser-panel" aria-expanded={browserOpen} disabled={!session} onClick={() => { if (session) void api.openBrowser(session.id).catch(error => setError(message(error))); }}><Icon name="box" /></button>}<div className="panel-toggles" role="group" aria-label="面板显示"><button className={`icon-button ${layout.leftVisible ? 'panel-visible' : ''}`} aria-label={layout.leftVisible ? '隐藏项目侧栏' : '显示项目侧栏'} title={layout.leftVisible ? '隐藏项目侧栏' : '显示项目侧栏'} aria-controls="project-sidebar" aria-expanded={layout.leftVisible} disabled={!data} onClick={() => changeLayout({ leftVisible: !layoutRef.current.leftVisible })}><Icon name="panel-left" /></button>{(mode === 'development' || mode === 'delivery') && <button className={`icon-button ${layout.rightVisible || browserOpen ? 'panel-visible' : ''}`} aria-label={browserOpen ? '隐藏浏览器面板' : layout.rightVisible ? '隐藏右侧面板' : '显示右侧面板'} title={browserOpen ? '隐藏浏览器面板' : layout.rightVisible ? '隐藏右侧面板' : '显示右侧面板'} aria-controls={browserOpen ? 'browser-panel' : 'right-panel'} aria-expanded={layout.rightVisible || browserOpen} disabled={!data} onClick={() => { if (browserOpen) void closeBrowser(); else changeLayout({ rightVisible: !layoutRef.current.rightVisible }); }}><Icon name="panel-right" /></button>}<button className={`icon-button ${layout.bottomVisible ? 'panel-visible' : ''}`} aria-label={layout.bottomVisible ? '隐藏底部面板' : '显示底部面板'} title={layout.bottomVisible ? '隐藏底部面板' : '显示底部面板'} aria-controls="bottom-panel" aria-expanded={layout.bottomVisible} disabled={!data} onClick={() => changeLayout({ bottomVisible: !layoutRef.current.bottomVisible })}><Icon name="panel-bottom" /></button></div></div>
      </header>
      {(error || notice) && <div className={`banner ${error ? 'error' : 'notice'}`} role={error ? 'alert' : 'status'}><Icon name={error ? 'alert' : 'check'} /><span>{error || notice}</span>{updateAvailableVersion && !updateDownloadedVersion && <button className="secondary-button update-restart" onClick={() => { void api.downloadUpdate().then(status => { if (status.state === 'error') setError(status.message ?? '更新下载失败'); }).catch(reason => setError(message(reason))); }}>下载更新</button>}{updateDownloadedVersion && notice.includes('更新已下载') && <button className="secondary-button update-restart" onClick={() => { void restartToUpdate(); }}>重启并更新</button>}<button className="icon-button" aria-label="关闭提示" onClick={() => { setError(''); setNotice(''); setUpdateAvailableVersion(''); }}><Icon name="close" /></button></div>}
      <div className={`workspace-body ${browserOpen ? 'with-browser' : ''} ${inspector === 'git' ? 'with-git-inspector' : ''} ${inspector === 'jira' ? 'with-jira-inspector' : ''}`}>
        <main id="agent-conversation" className="conversation" tabIndex={-1} aria-label="Agent 会话">
          {session ? <>

            {mode === 'development' && requiresRequirementAdmission(session.jiraIssue) && <RequirementAdmissionPanel admission={session.requirementAdmission} historyHint={session.imported ? '导入会话无准入快照；不会补造历史结论' : '历史任务/尚未执行需求检查'} onRefresh={() => refreshRequirementAdmission()} refreshing={requirementBusy} disabled={running || !!busy || requirementBusy} resolveAvailable={session.requirementAdmission?.status !== 'stale' && session.requirementAdmission?.status !== 'error'} onResolve={(itemId, action, valueText, reason) => resolveRequirementItem(itemId, action, valueText, reason)} />}
            <RunRecoveryPanel api={api} session={session} disabled={running || !!busy} onError={reason => setError(message(reason))} />
            <div className="messages" ref={messagesRef} onScroll={handleMessagesScroll} aria-live="polite" aria-label="会话消息">
               {!rows.length && <div className="session-welcome"><Mark /><h1>{project ? '一起理解这个项目' : '开始新的对话'}</h1><p>{project ? '描述您要分析的问题、代码或需求。' : '描述您的问题，也可以添加文本和附件进行分析。'}<br />当前为{session.system || '通用'}，Agent 直接使用所选项目目录。</p><div className="suggestions">{(project ? ['梳理项目架构与主要模块', '检查潜在缺陷并说明影响范围', '分析现有测试与构建方式'] : ['帮我整理这份资料的重点', '帮我起草一份工作计划', '分析这个问题并给出建议']).map(text => <button key={text} onClick={() => setPrompt(text)}>{text}<Icon name="arrow" /></button>)}</div></div>}
               {rows.map(row => row.type === 'status' ? <div className="event-status" key={row.id}><span /><span>{row.text in statusLabels ? statusLabels[row.text as SessionStatus] : engineText(row.text)}</span></div> : row.type === 'tool-group' ? <details className="tool-event tool-event-group" key={row.id}><summary><Icon name="terminal" /><span>工具事件（{row.toolEvents?.length ?? 1} 项）</span><time>{time(row.createdAt)}</time><span className="tool-event-expand">点击展开</span></summary><div className="tool-event-list">{row.toolEvents?.map((tool, index) => <pre key={`${tool.id}-${index}`}>{toolPlatformText(tool.text)}</pre>)}</div></details> : <article className={`message ${row.type === 'user' ? 'user' : row.type === 'error' ? 'error' : 'agent'}`} key={row.id}><div className={`message-avatar ${row.type === 'user' ? 'user-avatar' : ''}`}>{row.type === 'user' ? userAvatar(userProfile) : row.type === 'error' ? <Icon name="alert" /> : row.expert ? <ExpertAvatar id={row.expert.id} /> : <Mark small />}</div><div className="message-content"><div className="message-meta"><strong>{row.type === 'user' ? userProfile.name : row.expert?.name ?? assistantName}</strong>{row.type !== 'user' && row.durationMs !== undefined && <span className="message-duration" title={`本轮处理用时 ${formatDuration(row.durationMs)}`}>用时 {formatDuration(row.durationMs)}<Icon name="chevron" /></span>}<time>{time(row.createdAt)}</time></div><div className="message-text">{row.type === 'user' ? session?.jiraIssue ? <MarkdownContent text={displayUserMessageText(row.text)} jiraIssue={session.jiraIssue} sessionId={sessionId} onFilePath={openMessageFile} onFileContextMenu={showMessageFileContextMenu} /> : displayUserMessageText(row.text) : <MarkdownContent text={row.type === 'error' ? engineText(row.text) : row.text} onFilePath={openMessageFile} onFileContextMenu={showMessageFileContextMenu} />}</div>{row.type === 'user' && row.attachments?.length ? <div className="message-images" aria-label="消息附件">{row.attachments.map(attachment => attachment.kind === 'image' ? <ConversationImagePreview key={attachment.id} sessionId={sessionId} attachment={attachment} /> : <ConversationFilePreview key={attachment.id} attachment={attachment} onContextMenu={(x, y) => showConversationAttachmentContextMenu(attachment, x, y)} />)}</div> : null}</div></article>)}
              {runtimeApprovals.map(event => {
                const approval = event.approval!;
                const marker = `${sessionId}:${approval.requestId}`;
                const decided = approvalSubmitted.has(marker);
                return <section className="runtime-approval" aria-label="运行时工具审批" key={event.id}>
                  <strong>{approval.title || '工具执行请求'}</strong><p>{approval.toolName} · {runtimeLabel(sessionRuntimeKind)}</p>
                  <pre>{approval.input}</pre><p>选择「完全访问」将允许本次操作，并为本机所有会话保存此设置。</p>
                  <div className="runtime-approval-actions">
                    {([{ decision: 'allow_once', label: '允许一次' }, { decision: 'reject_once', label: '拒绝' }, { decision: 'full', label: '完全访问' }] as const).map(({ decision, label }) =>
                      <button key={decision} type="button" className={decision === 'allow_once' ? 'primary-button' : 'secondary-button'}
                        disabled={!api.respondRuntimeApproval || approvalBusy.has(marker) || decided}
                        onClick={() => { void respondApproval(approval.requestId, decision); }}>{label}</button>)}
                  </div>
                </section>;
              })}
              {running && <div className={`working-indicator ${workingExpanded ? 'expanded' : ''}`}>
                <button type="button" className="working-summary" aria-expanded={workingExpanded} aria-controls="working-details" onClick={() => setWorkingExpanded(value => !value)}>
                  <span className="working-dots" aria-hidden="true"><span /><span /><span /></span>
                  <span className="working-text">{assistantName} 正在处理任务</span>
                  <span className="working-latest" title={latestWorkingInfo}>{latestWorkingInfo}</span>
                  <Icon name="chevron" className={`working-chevron ${workingExpanded ? 'expanded' : ''}`} />
                </button>
                {workingExpanded && <div id="working-details" className="working-details" role="status" aria-live="polite">
                  {workingDetails.length ? workingDetails.map(item => <div className={`working-detail working-detail-${item.type}`} key={item.id}><span>{item.type === 'error' ? '错误' : item.type === 'tool' ? '工具' : item.type === 'response' ? '回复' : '状态'}</span><p>{item.text}</p><time>{time(item.createdAt)}</time></div>) : <p className="working-detail-empty">正在等待运行时返回最新进度…</p>}
                </div>}
              </div>}
              <div className="messages-jump-wrap">{showReturnLatest && <button type="button" className="messages-jump" onClick={returnToLatest}><Icon name="arrow" />回到最新消息</button>}</div>
            </div>
            <div className="composer-container">
              <button type="button" className="panel-resize-handle composer-resize-handle" role="separator" aria-label="调整输入框高度" aria-orientation="horizontal" aria-valuemin={80} aria-valuemax={400} aria-valuenow={layout.composerHeight ?? 110} title="拖动调整输入框高度，双击恢复" onPointerDown={event => beginResize('composer', event)} onKeyDown={event => adjustResize('composer', event)} onDoubleClick={() => changeLayout({ composerHeight: 110 })} />
              {!configuredProvider?.hasKey && <button className="setup-notice" onClick={() => setSessionSettingsOpen(true)}><Icon name="settings" /><span>当前会话尚未配置中转站凭据</span><Icon name="chevron" /></button>}
              {sessionRuntimeHealth?.warmingUp && <p className="field-hint" role="status">本地组件后台预热中，可直接发送任务。</p>}
              <ExpertSession key={session.id} session={session} running={running} latestExpert={latestTurnExpert} open={()=>{setSettingsTab('experts');setShowSettings(true);}} />
              <form className={`composer ${running ? 'is-running' : ''}`} onSubmit={send} onDragOver={handleComposerDragOver} onDrop={handleComposerDrop}>
                <textarea aria-label="输入任务" placeholder={`向 ${assistantName} 描述您的任务…`} value={prompt} onChange={event => setPrompt(event.target.value)} onKeyDown={inputKey} onPaste={handleComposerPaste} rows={3} maxLength={32000} />
                {(jiraDraftImageAttachments.length > 0 || conversationAttachments.length > 0) && <div className="composer-attachments" aria-label="待发送附件">
                  {jiraIssue && jiraDraftImageAttachments.map(attachment => <JiraInlineImagePreview key={attachment.id} issueKey={jiraIssue.key} attachment={attachment} sessionId={sessionId} onRemove={() => setPrompt(current => removeJiraWikiImageAttachment(current, jiraIssue, attachment.id))} />)}
                  {conversationAttachments.map(attachment => attachment.kind === 'image' ? <ConversationImagePreview key={attachment.id} sessionId={sessionId} attachment={attachment} onRemove={() => setConversationAttachments(current => current.filter(item => item.id !== attachment.id))} /> : <span className="composer-attachment" key={attachment.id} title={`${attachment.name}（${attachment.size} 字节）`}><Icon name="file" /><span>{attachment.name}</span><button type="button" aria-label={`移除附件 ${attachment.name}`} title="移除附件" disabled={running} onClick={() => setConversationAttachments(current => current.filter(item => item.id !== attachment.id))}><Icon name="close" /></button></span>)}
                </div>}
               <div className="composer-toolbar"><div className="composer-context"><button className="attachment-button" type="button" onClick={() => { void pickConversationAttachments(); }} disabled={running || !!busy} title="上传图片或文件"><Icon name="file" />{busy === 'attachments' ? '选择中…' : '添加附件'}</button>{mode === 'development' ? <><label className="session-branch-picker" title="选择当前会话的本地项目"><Icon name="branch" /><select aria-label="当前会话本地项目" value={bindProjectId} onChange={event => { void bindCurrentSession(event.target.value); }} disabled={running || !!busy}><option value="">不关联项目</option>{data?.projects.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{bindProjectId && !session?.projectId && <label className="session-branch-picker" title="选择当前会话的基准分支"><Icon name="branch" /><select aria-label="当前会话基准分支" value={baseBranch} onChange={event => setBaseBranch(event.target.value)} disabled={running || !!busy || branchLoading || !branchOptions.length}>{!branchOptions.length && <option value="">{branchLoading ? '读取分支…' : '默认分支'}</option>}{branchOptions.map(branch => <option key={branch} value={branch}>{branch}</option>)}</select></label>}</> : <label className="session-branch-picker" title="选择当前会话的交付项目"><Icon name="folder" /><select aria-label="当前会话交付项目" value={bindDeliveryProjectId} onChange={event => { void bindCurrentDeliveryProject(event.target.value); }} disabled={running || !!busy}><option value="">不归属项目</option>{data?.deliveryProjects?.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>}</div>{running && <button className="cancel-button" type="button" onClick={cancel}><Icon name="stop" />停止</button>}<button className="send-button" type="submit" disabled={(!prompt.trim() && !conversationAttachments.length) || !(sessionRuntimeHealth?.compatible || sessionRuntimeHealth?.warmingUp) || projectBindingChanged || claudeGrokSelection || !!busy} aria-label="发送任务" title={claudeGrokSelection ? 'Claude Runtime 不支持当前 Grok 模型，请更换模型' : projectBindingChanged ? '请先应用项目选择' : running ? sessionRuntimeKind === 'claude_agent_sdk' ? '补充当前任务（Enter；引导本轮）' : '补充当前任务（Enter；不支持即时补充时排队执行）' : '发送任务（Enter）'}><Icon name="arrow" /></button></div>
              </form>
              <div className="composer-caption"><div className="composer-caption-controls"><span className="composer-shortcuts">Enter 发送 · Shift + Enter 换行 · Ctrl + V 粘贴文件</span><div className="session-settings-anchor" ref={sessionSettingsRef}><button ref={sessionSettingsTriggerRef} className="session-settings-trigger" type="button" aria-label="打开当前会话设置" title={(configuredProvider?.name || '选择中转站') + ' / ' + (session.model || '选择模型') + ' / ' + configuredBackend} aria-expanded={sessionSettingsOpen} aria-controls="session-configuration" onClick={() => setSessionSettingsOpen(value => !value)}><Icon name="box" /><span>{configuredProvider?.name || '选择中转站'} · {session.model || '选择模型'} · {configuredBackend}</span><Icon name="chevron" /></button>
            {sessionSettingsOpen && <div id="session-configuration" role="region" className="session-configuration" aria-label="会话设置">
              <div className="session-settings-heading"><strong>会话设置</strong><button type="button" className="icon-button" aria-label="关闭会话设置" onClick={() => { setSessionSettingsOpen(false); sessionSettingsTriggerRef.current?.focus(); }}><Icon name="close" /></button></div>
              <label>中转站<select aria-label="会话中转站" value={draftProvider} disabled={running || !!busy} onChange={e => selectSessionProvider(e.target.value)}>{!draftProvider && <option value="">请先配置中转站</option>}{draftProvider && !selectedProvider && <option value={draftProvider}>原中转站已删除</option>}{providerChoices.map(item => <option value={item.id} key={item.id} disabled={!item.enabled}>{item.name}{!item.enabled ? '（已停用）' : item.hasKey ? '' : '（未配置密钥）'}</option>)}</select></label>
              <label>模型<select aria-label="会话模型" value={draftModel} disabled={running || !!busy || !selectedProvider} onChange={e => { const modelId = e.target.value; const model = selectedProvider?.models.find(item => item.id === modelId); if (model) configureSelectedModel(draftProvider, model); else { setDraftModel(modelId); void configure({ providerId: draftProvider, model: modelId }); } }}>{!draftModel && <option value="">请选择模型</option>}{draftModel && !selectedProvider?.models.some(model => model.id === draftModel) && <option value={draftModel}>{draftModel}（不在当前列表）</option>}{selectedProvider?.models.map(item => <option key={item.id} value={item.id} disabled={!item.enabled}>{item.name || item.id}{item.name && item.name !== item.id ? ` · ${item.id}` : ''}{item.backend ? ` · ${item.backend}` : ''}{item.unavailableReason === 'claude-grok' ? '（Claude Runtime 不支持）' : item.enabled ? '' : '（已停用）'}</option>)}</select></label>
              <p className="field-hint">选择 GPT 或 Claude 模型会自动匹配 Runtime，也可在右侧手动切换。</p>
              {claudeGrokSelection && <p className="grok-session-note">Claude Runtime 不支持 Grok 模型。请选择其他模型后再发送。</p>}
              <label>系统<select aria-label="会话适用系统" value={draftSystem} disabled={running || !!busy} onChange={e => { const system = e.target.value as ProductSystem; setDraftSystem(system); void configure({ system }); }}>{['通用', 'MES5', 'MES6', 'WMS', '前端'].map(item => <option key={item}>{item}</option>)}</select></label>
              <label>推理强度<select aria-label="推理强度" value={draftReasoning} disabled={running || !!busy} onChange={event => { const value = event.target.value as ReasoningEffort | ''; setDraftReasoning(value); void configure({ reasoningEffort: value || undefined }); }}>{([{ value: '', label: '模型默认' }, { value: 'none', label: '无' }, { value: 'minimal', label: '最低' }, { value: 'low', label: '低' }, { value: 'medium', label: '中' }, { value: 'high', label: '高' }, { value: 'xhigh', label: '超高' }] as const).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
              {sessionRuntimeKind === 'codex' && <label>任务协作<select aria-label="任务协作模式" value={session?.delegationMode ?? 'native'} disabled={running || !!busy} onChange={event => { const mode = event.target.value as AgentDelegationMode; void configure({ delegationMode: mode }, `已切换为${mode === 'native' ? ' Codex 原生 Multi-Agent' : mode === 'governed' ? ' 精工受控任务' : ' 单 Agent'}。`); }}><option value="native">Codex 原生 Multi-Agent</option><option value="governed">精工受控任务</option><option value="off">单 Agent</option></select></label>}
              <button className="text-button session-provider-manage" type="button" onClick={() => openSettings('providers')}>管理中转站与凭据</button>
              <p className="session-requirements-note"><Icon name="shield" />开发任务将参考 {data?.settings.documents.filter(item => item.enabled && item.kind === 'requirement' && (item.system === '通用' || item.system === (session.system || '通用'))).length ?? 0} 份当前系统开发要求；执行时遵循当前 Runtime 配置和本机安全策略；提交前检查规范。</p>
            </div>}
</div><span className="session-reasoning-indicator" aria-label={`当前会话推理强度：${reasoningLabel(draftReasoning || undefined)}`} title="当前会话推理强度">推理 {reasoningLabel(draftReasoning || undefined)}</span>{sessionRuntimeKind === 'grok_build_acp' ? <span className="session-runtime-picker" aria-label="当前会话运行时" title="当前会话运行时"><Icon name="terminal" />当前引擎</span> : <label className="session-runtime-picker"><Icon name="terminal" /><select aria-label="当前会话运行时" title="仅切换当前会话的 Runtime" value={sessionRuntimeKind} disabled={running || !!busy} onChange={event => { void switchSessionRuntime(event.target.value as RuntimeKind); }}><option value="claude_agent_sdk">Claude Runtime</option><option value="codex">Codex Runtime</option><option value="jinggong">Jinggong Runtime</option></select></label>}</div></div>
            </div>
          </> : data ? mode === 'delivery'
            ? <DeliveryTaskWorkbench api={api} projects={data.deliveryProjects ?? []} sessions={data.sessions} statuses={statuses} onOpenSession={item => { readSession(item.id); setProjectId(item.deliveryProjectId ?? ''); setSessionId(item.id); }} onCreateSession={targetProjectId => openCreateSession(targetProjectId || projectId)} onCreateProject={openDeliveryProjectDialog} />
            : <TaskWorkbench api={api} projects={data.projects} sessions={data.sessions} statuses={statuses} onOpenSession={item => { readSession(item.id); setProjectId(item.projectId ?? ''); setSessionId(item.id); }} onCreateSession={targetProjectId => openCreateSession(targetProjectId || projectId)} onAddProject={() => { void addProject(); }} onOpenJira={() => { setInspector('jira'); if (!layoutRef.current.rightVisible) changeLayout({ rightVisible: true }); }} onOpenIteration={() => { setInspector('iteration'); if (!layoutRef.current.rightVisible) changeLayout({ rightVisible: true }); }} onOpenExperts={() => openSettings('experts')} onOpenKnowledge={() => openSettings('knowledge')} /> : <div className="welcome-screen"><span>正在载入本地项目与会话…</span></div>}
        </main>

        {messageFileContextMenu && <div className="file-context-menu message-file-context-menu" role="menu" aria-label={`会话文件操作：${messageFileContextMenu.kind === 'project' ? messageFileContextMenu.path : messageFileContextMenu.attachment.name}`} style={{ left: Math.min(messageFileContextMenu.x, Math.max(8, window.innerWidth - 230)), top: Math.min(messageFileContextMenu.y, Math.max(8, window.innerHeight - 120)) }} onPointerDown={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
          <div className="file-context-heading">{messageFileContextMenu.kind === 'project' ? messageFileContextMenu.path : messageFileContextMenu.attachment.name}</div>
          <button type="button" role="menuitem" onClick={openMessageContextFile}><Icon name="file" />打开文件</button>
          <button type="button" role="menuitem" onClick={revealMessageContextFile}><Icon name="folder" />在资源管理器打开</button>
        </div>}
        {mode === 'development' && browserOpen && browserState && <BrowserPanel key={sessionId} api={api} state={browserState} suspended={showSettings || sessionSettingsOpen || !!fileContextMenu || !!messageFileContextMenu} onClose={() => { void closeBrowser(); }} onError={reason => setError(message(reason))} />}
        {mode === 'development' && <aside id="right-panel" className="inspector" aria-label="右侧任务与代码面板" hidden={!layout.rightVisible || browserOpen}>
       <button type="button" className="panel-resize-handle inspector-resize-handle" role="separator" aria-label="调整右侧面板宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={840} aria-valuenow={Math.min(layout.rightWidth ?? 420, 840)} title="拖动调整右侧面板宽度" onPointerDown={event => beginResize('right', event)} onKeyDown={event => adjustResize('right', event)} onDoubleClick={() => changeLayout({ rightWidth: 420 })} />
          <div className="inspector-tabs" role="group" aria-label="右侧面板分类">{mode === 'development' && <button id="jira-panel-tab" className={currentInspector === 'jira' ? 'active' : ''} aria-pressed={currentInspector === 'jira'} aria-controls="jira-panel" onClick={() => setInspector('jira')}>Jira</button>}{hasAgentTasks && <button id="agents-panel-tab" className={currentInspector === 'agents' ? 'active' : ''} aria-pressed={currentInspector === 'agents'} aria-controls="agents-panel" onClick={() => setInspector('agents')}>子 Agent</button>}{mode === 'development' && <><button id="iteration-panel-tab" className={currentInspector === 'iteration' ? 'active' : ''} aria-pressed={currentInspector === 'iteration'} aria-controls="iteration-panel" disabled={!project && !sessionProject} onClick={() => setInspector('iteration')}>项目工作台</button><button id="git-panel-tab" className={currentInspector === 'git' ? 'active' : ''} aria-pressed={currentInspector === 'git'} aria-controls="git-panel" disabled={!project && !sessionProject} onClick={() => setInspector('git')}>Git{diffs.length > 0 && <span>{diffs.length}</span>}</button><button id="files-panel-tab" className={currentInspector === 'files' ? 'active' : ''} aria-pressed={currentInspector === 'files'} aria-controls="files-panel" disabled={!project && !sessionProject} onClick={() => setInspector('files')}>项目文件</button></>}<button id="performance-panel-tab" className={currentInspector === 'performance' ? 'active' : ''} aria-pressed={currentInspector === 'performance'} aria-controls="performance-panel" onClick={() => setInspector('performance')}>执行监控</button>{mode === 'development' && <><button id="context-panel-tab" className={currentInspector === 'context' ? 'active' : ''} aria-pressed={currentInspector === 'context'} aria-controls="context-panel" onClick={() => setInspector('context')}>上下文</button><button className={`icon-button ${diffBusy ? 'spinning' : ''}`} onClick={() => refreshDiff()} disabled={!session?.projectId || diffBusy} title="刷新代码差异" aria-label="刷新代码差异"><Icon name="refresh" /></button></>}</div>
          {mode === 'development' && <div id="jira-panel" className="inspector-panel jira-inspector-panel" role="region" aria-label="右侧 Jira 任务" hidden={currentInspector !== 'jira'}>{data?.settings && <JiraPanel compact api={api} settings={data.settings.jira} projects={data.projects} projectId={jiraAssociationId} onProjectChange={setJiraLocalProjectId} onConfigure={() => openSettings('jira')} onCreateIssue={sessionFromJira} creating={isJiraSessionCreating(busy)} />}</div>}
          {hasAgentTasks && <div id="agents-panel" className="inspector-panel" role="region" aria-labelledby="agents-panel-tab" hidden={currentInspector !== 'agents'}><AgentTasksPanel api={api} session={session} tasks={agentTasks.tasks} events={agentTasks.events} refreshTasks={agentTasks.refreshTasks} onError={text => setError(message(text))} /></div>}
          {mode === 'development' && <div id="iteration-panel" className="inspector-panel" role="region" aria-labelledby="iteration-panel-tab" hidden={currentInspector !== 'iteration'}>{(sessionProject || project) ? <IterationWorkbench project={sessionProject || project} session={session} runActive={running} onExecuteStep={executeGovernanceStep} onResume={resumeGovernedTask} /> : <div className="inspector-empty"><strong>选择项目后打开项目工作台</strong></div>}</div>}
          <div id="performance-panel" className="inspector-panel" role="region" aria-label="执行监控" hidden={currentInspector !== 'performance'}>{currentInspector === 'performance' && <PerformancePanel api={api} session={session} />}</div>
          <div id="git-panel" className="inspector-panel" role="region" aria-labelledby="git-panel-tab" hidden={currentInspector !== 'git'} style={{ '--git-diff-flex': gitDiffHeight === null ? '3 1 0' : `0 1 ${gitDiffHeight}px` } as CSSProperties}>
             {diffs.length ? <div id="diff-panel" className="diff-content"><GitChangesTree files={diffs} selectedPath={activeDiff?.path || ''} onSelect={path => { setSelectedFile(path); setDiffExpanded(true); }} onContextMenu={(file, x, y) => { setFileContextMenu({ file, x, y }); }} />{activeDiff && <DiffPreview key={sessionId} file={activeDiff} expanded={diffExpanded} onToggle={() => setDiffExpanded(value => !value)} />}</div> : <div id="diff-panel" className="inspector-empty"><div className="empty-icon"><Icon name="layers" /></div><strong>{diffBusy ? '正在读取 Git 差异' : session ? diffError ? '项目目录暂不可用' : '本次会话暂无代码变更' : '代码差异将在这里显示'}</strong><p>{session ? diffError || '仅展示本会话任务产生的修改；历史未采集修改不推断归属。' : '选择项目并创建会话，即可查看文件变更。'}</p></div>}
            {fileContextMenu && <div className="file-context-menu" role="menu" aria-label={`文件 Git 操作：${fileContextMenu.file.path}`} style={{ left: Math.min(fileContextMenu.x, Math.max(8, window.innerWidth - 230)), top: Math.min(fileContextMenu.y, Math.max(8, window.innerHeight - 340)) }}>
              <div className="file-context-heading">{fileContextMenu.file.path}</div>
              <button role="menuitem" onClick={() => { setSelectedFile(fileContextMenu.file.path); setDiffExpanded(true); setFileContextMenu(null); }}><Icon name="layers" />查看对比</button>
              <button role="menuitem" onClick={() => { void api.copyText(fileContextMenu.file.path).then(() => { setFileContextMenu(null); setNotice('文件路径已复制。'); }).catch(reason => setError(message(reason))); }}><Icon name="copy" />复制文件路径</button>
              <button role="menuitem" onClick={() => { const file = fileContextMenu.file; setFileContextMenu(null); void api.openChangedFile(sessionId, file.path).catch(reason => setError(message(reason))); }}><Icon name="file" />用系统编辑器打开</button>
              <button role="menuitem" onClick={() => { const file = fileContextMenu.file; setFileContextMenu(null); void api.revealProjectFile(sessionId, file.path).catch(reason => setError(message(reason))); }}><Icon name="folder" />使用资源管理器打开</button>
              {!fileContextMenu.file.staged && <button role="menuitem" disabled={!!fileAction} onClick={() => { void runFileAction('stage', fileContextMenu.file); }}><Icon name="check" />暂存此文件</button>}
              {fileContextMenu.file.staged && <button role="menuitem" disabled={!!fileAction} onClick={() => { void runFileAction('unstage', fileContextMenu.file); }}><Icon name="arrow" />取消暂存</button>}
              <button role="menuitem" className="danger-menu-item" disabled={!!fileAction} onClick={() => { void runFileAction('discard', fileContextMenu.file); }}><Icon name="close" />撤销此文件更改</button>
              <button role="menuitem" onClick={() => { setInspector('git'); setFileContextMenu(null); }}><Icon name="branch" />在 Git 面板中处理</button>
            </div>}
             <GitChangesResizeHandle height={gitDiffHeight} onResize={setGitDiffHeight} />
             <div className="inspector-footnote"><Icon name="branch" /><span>{session ? '仅展示本次会话任务产生的代码修改' : '选择会话后查看 Git 状态'}</span></div>
             <div className="git-panel-unified"><div className="git-session-changes-heading"><strong>本次会话代码变更</strong><span>{diffs.length} 个文件</span></div>{sessionProject && !projectBindingChanged ? <GitPanel key={`${sessionId}-${sessionProject.id}-${session?.workspacePath}-${session?.system}`} sessionId={sessionId} project={sessionProject} jiraUrl={session?.jiraIssue?.url} running={running} onChanged={async () => { await refresh(); await refreshDiff(sessionId); }} /> : !session && project ? <ProjectGitPanel key={`project-${project.id}`} project={project} disabled={running || !!busy} onChanged={async () => { await refresh(); }} /> : null}</div>
          </div>
          <div id="files-panel" className="inspector-panel" role="region" aria-labelledby="files-panel-tab" hidden={currentInspector !== 'files'}>{(project || sessionProject) ? <ProjectFilesPanel project={project || sessionProject!} sessionId={sessionProject ? sessionId : undefined} initialPath={filePreviewPath} onError={reason => setError(message(reason))} /> : <div className="inspector-empty"><strong>选择项目查看文件</strong></div>}</div>
          <div id="context-panel" className="inspector-panel" role="region" aria-labelledby="context-panel-tab" hidden={currentInspector !== 'context'}>
            {currentInspector === 'context' && layout.rightVisible && !browserOpen && !showSettings && (session && data
              ? <ContextInspector key={JSON.stringify([session.id, session.projectId, session.workspaceId, session.workspacePath, sessionRuntimeKind])}
                  api={api} session={session} project={sessionProject} running={running} runtimeName={runtimeLabel(sessionRuntimeKind)}
                  provider={configuredProvider} reasoning={reasoningLabel(session.reasoningEffort)} backend={configuredBackend}
                  documents={data.settings?.documents ?? []} dataDirectory={data.dataDirectory} gitVersion={data.gitVersion}
                  engine={engineVersion(data.runtime.version)} onManage={openSettings} />
              : <p className="inspector-empty">选择会话后查看上下文。</p>)}
          </div>

        </aside>}
        {mode === 'delivery' && <aside id="right-panel" className="inspector" aria-label="右侧信息面板" hidden={!layout.rightVisible}>
       <button type="button" className="panel-resize-handle inspector-resize-handle" role="separator" aria-label="调整右侧面板宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={840} aria-valuenow={Math.min(layout.rightWidth ?? 420, 840)} title="拖动调整右侧面板宽度" onPointerDown={event => beginResize('right', event)} onKeyDown={event => adjustResize('right', event)} onDoubleClick={() => changeLayout({ rightWidth: 420 })} />
          <div className="inspector-tabs" role="group" aria-label="右侧面板分类"><button id="knowledge-panel-tab" className={currentInspector === 'knowledge' ? 'active' : ''} aria-pressed={currentInspector === 'knowledge'} aria-controls="knowledge-panel" onClick={() => setInspector('knowledge')}>知识中心</button><button id="context-panel-tab" className={currentInspector === 'context' ? 'active' : ''} aria-pressed={currentInspector === 'context'} aria-controls="context-panel" onClick={() => setInspector('context')}>会话与数据</button><button id="manuals-panel-tab" className={currentInspector === 'manuals' ? 'active' : ''} aria-pressed={currentInspector === 'manuals'} aria-controls="manuals-panel" onClick={() => setInspector('manuals')}>产品手册</button><button id="performance-panel-tab" className={currentInspector === 'performance' ? 'active' : ''} aria-pressed={currentInspector === 'performance'} aria-controls="performance-panel" onClick={() => setInspector('performance')}>执行监控</button></div>
          <div id="knowledge-panel" className="inspector-panel" role="region" aria-labelledby="knowledge-panel-tab" hidden={currentInspector !== 'knowledge'}><div className="inspector-empty"><div className="empty-icon"><Icon name="layers" /></div><strong>知识中心</strong><p>管理产品与开发知识库</p></div></div>
          <div id="context-panel" className="inspector-panel" role="region" aria-labelledby="context-panel-tab" hidden={currentInspector !== 'context'}>
            {currentInspector === 'context' && layout.rightVisible && !showSettings && (session && data
              ? <ContextInspector key={JSON.stringify([session.id, session.deliveryProjectId, session.workspaceId, session.workspacePath, sessionRuntimeKind])}
                  api={api} session={session} project={undefined} running={running} runtimeName={runtimeLabel(sessionRuntimeKind)}
                  provider={configuredProvider} reasoning={reasoningLabel(session.reasoningEffort)} backend={configuredBackend}
                  documents={data.settings?.documents ?? []} dataDirectory={data.dataDirectory} gitVersion={data.gitVersion}
                  engine={engineVersion(data.runtime.version)} onManage={openSettings} />
              : <p className="inspector-empty">选择会话后查看会话与数据。</p>)}
          </div>
          <div id="manuals-panel" className="inspector-panel" role="region" aria-labelledby="manuals-panel-tab" hidden={currentInspector !== 'manuals'}><div className="inspector-empty"><div className="empty-icon"><Icon name="file" /></div><strong>产品手册</strong><p>查看操作手册和产品文档</p></div></div>
          <div id="performance-panel" className="inspector-panel" role="region" aria-label="执行监控" hidden={currentInspector !== 'performance'}>{currentInspector === 'performance' && <PerformancePanel api={api} session={session} />}</div>
        </aside>}
      </div>
      <section id="bottom-panel" className="activity-panel" aria-label="运行输出和工具活动" hidden={!layout.bottomVisible}>
        <button type="button" className="panel-resize-handle activity-resize-handle" role="separator" aria-label="调整会话输出栏高度" aria-orientation="horizontal" aria-valuemin={100} aria-valuemax={480} aria-valuenow={layout.bottomHeight ?? 180} title="拖动调整会话输出栏高度" onPointerDown={event => beginResize('bottom', event)} onKeyDown={event => adjustResize('bottom', event)} onDoubleClick={() => changeLayout({ bottomHeight: 180 })} />
        <div className="activity-panel-header"><div role="group" aria-label="运行活动分类"><button id="activity-output-tab" className={activityTab === 'output' ? 'active' : ''} aria-pressed={activityTab === 'output'} aria-controls="activity-events" onClick={() => setActivityTab('output')}><Icon name="terminal" />运行输出</button><button id="activity-tools-tab" className={activityTab === 'tools' ? 'active' : ''} aria-pressed={activityTab === 'tools'} aria-controls="activity-events" onClick={() => setActivityTab('tools')}>工具活动</button></div><span>{session ? `${activityEvents.length} 条事件` : '尚未选择会话'}</span></div>
        <div id="activity-events" className="activity-events" role="region" aria-labelledby={activityTab === 'output' ? 'activity-output-tab' : 'activity-tools-tab'} tabIndex={0}>{activityEvents.length ? activityEvents.map(event => <div key={event.id} className={`activity-event activity-${event.type}`}><time dateTime={event.createdAt}>{time(event.createdAt)}</time><span>{event.type === 'tool' ? '工具' : event.type === 'error' ? '错误' : '状态'}</span><pre>{event.type === 'tool' ? toolPlatformText(event.text) : event.type === 'status' && event.text in statusLabels ? statusLabels[event.text as SessionStatus] : engineText(event.text)}</pre></div>) : <div className="activity-empty"><Icon name="terminal" /><span>{session ? activityTab === 'tools' ? '当前会话尚无工具活动，执行后的真实工具事件会显示在这里。' : '当前会话尚无运行输出，状态、错误与工具事件会显示在这里。' : '选择会话后查看真实运行输出与工具活动。'}</span></div>}<div ref={activityEndRef} /></div>
      </section>
    </div>
    {showSettings && data?.settings && <SettingsPanel mode={mode} settings={data.settings} sessions={data.sessions} projects={data.projects} currentProjectId={projectId} onImportCompleted={importedShare} onRuntimeChecked={runtimeChecked} initialTab={settingsTab} onClose={() => setShowSettings(false)} onChanged={settingsChanged} />}
    {deliveryProjectDialogOpen && <div className="modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setDeliveryProjectDialogOpen(false); }}><form className="settings-modal delivery-project-modal" onSubmit={event => void addDeliveryProject(event)}><div className="modal-heading"><span className="modal-icon"><Icon name="folder" /></span><div><h2>新建交付项目</h2><p>填写项目名称以开始归档交付会话</p></div><button type="button" className="icon-button" aria-label="关闭" disabled={!!busy} onClick={() => setDeliveryProjectDialogOpen(false)}><Icon name="close" /></button></div><label htmlFor="delivery-project-name">项目名称</label><input id="delivery-project-name" name="name" autoFocus maxLength={120} placeholder="例如：佛山工厂 MES 上线" value={deliveryProjectName} onChange={event => setDeliveryProjectName(event.target.value)} disabled={!!busy} />{error && <div className="form-error" role="alert"><Icon name="alert" />{error}</div>}<div className="modal-actions"><button type="button" className="secondary-button" disabled={!!busy} onClick={() => setDeliveryProjectDialogOpen(false)}>取消</button><button type="submit" className="primary-button" disabled={!deliveryProjectName.trim() || !!busy}>{busy === 'project' ? '正在创建…' : '创建项目'}</button></div></form></div>}
  </div>;
}

function GitChangesTree({ files, selectedPath, onSelect, onContextMenu }: { files: FileDiff[]; selectedPath: string; onSelect: (path: string) => void; onContextMenu: (file: FileDiff, x: number, y: number) => void }) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const tree = useMemo(() => buildDiffTree(files), [files]);
  function fileCount(node: DiffTreeNode): number { return node.file ? 1 : node.children.reduce((total, child) => total + fileCount(child), 0); }
  function tones(node: DiffTreeNode): string[] {
    if (node.file) return [diffStatusTone(node.file.status)];
    return [...new Set(node.children.flatMap(tones))].slice(0, 3);
  }
  function render(nodes: DiffTreeNode[], depth = 0): ReactElement[] {
    return nodes.map(node => {
      if (node.file) {
        const file = node.file;
        const tone = diffStatusTone(file.status);
        return <button type="button" key={node.path} className={`diff-tree-row diff-file-row status-${tone}${file.staged ? ' staged' : ''}${file.path === selectedPath ? ' selected' : ''}`} style={{ paddingLeft: 10 + depth * 15 }} onClick={() => onSelect(file.path)} onContextMenu={event => { event.preventDefault(); onContextMenu(file, event.clientX, event.clientY); }} title={`${file.path}${file.staged ? '（含暂存变更）' : ''}（右键打开 Git 操作）`}><Icon name="file" /><span className="diff-tree-name">{node.name}</span>{file.staged && <small className="diff-file-stage">已暂存</small>}<b className={`file-status status-${tone}`}>{file.status}</b></button>;
      }
      const isCollapsed = !!collapsed[node.path];
      const folderTones = tones(node);
      return <div className="diff-tree-folder" key={node.path}><button type="button" className="diff-tree-row diff-folder-row" style={{ paddingLeft: 8 + depth * 15 }} aria-expanded={!isCollapsed} onClick={() => setCollapsed(current => ({ ...current, [node.path]: !current[node.path] }))} title={node.path}><Icon name="chevron" className={`diff-tree-chevron${isCollapsed ? '' : ' expanded'}`} /><Icon name="folder" /><span className="diff-tree-name">{node.name}</span><span className="diff-folder-markers" aria-hidden="true">{folderTones.map(tone => <i key={tone} className={`status-${tone}`} />)}</span><small className="diff-folder-count">{fileCount(node)}</small></button>{!isCollapsed && node.children.length > 0 && <div className="diff-tree-children">{render(node.children, depth + 1)}</div>}</div>;
    });
  }
  return <div className="file-list" aria-label="已更改的文件">{render(tree)}</div>;
}


import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { CompletionSound, DesktopApi, DesktopWorkspace, JiraConnectionResult, ManagedDocument, Preferences, ProductSystem, Project, ProviderModel, ProviderProfile, RuntimeHealth, RuntimeKind, Session, SettingsSnapshot, UpdateStatus } from '../../../../packages/domain/src';
import { Icon } from './ui';
import { DictionaryPreview } from './DictionaryPreview';
import { readableError } from './dictionary-index';
import { playCompletionSound } from './completion-sound';
import { RequirementsSyncPanel } from './RequirementsSyncPanel';
import { PluginManagerPanel } from './PluginManagerPanel';
import { SessionDataSettings } from './SessionDataSettings';

export type SettingsTab = 'providers' | 'appearance' | 'jira' | 'documents' | 'requirements' | 'memories' | 'updates' | 'runtime' | 'wecom' | 'workspaces' | 'plugins' | 'sessions';
type Tab = SettingsTab;
const tabs: { id: Tab; name: string; icon: 'box' | 'layers' | 'branch' | 'file' | 'chat' | 'shield' | 'refresh' | 'terminal' }[] = [
  { id: 'providers', name: '模型中转站', icon: 'box' }, { id: 'appearance', name: '外观', icon: 'layers' },
  { id: 'jira', name: 'Jira 连接', icon: 'branch' }, { id: 'runtime', name: '运行时', icon: 'terminal' }, { id: 'plugins', name: '插件管理', icon: 'box' }, { id: 'workspaces', name: '多仓库工作区', icon: 'branch' }, { id: 'sessions', name: '会话与数据', icon: 'chat' }, { id: 'wecom', name: '企业微信通知', icon: 'chat' }, { id: 'updates', name: '更新', icon: 'refresh' }, { id: 'documents', name: '数据字典', icon: 'file' }, { id: 'requirements', name: '开发要求与规范', icon: 'shield' }, { id: 'memories', name: '记忆', icon: 'chat' },
];
const failure = readableError;
type SuccessNotice = string | (() => string);
function validateUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('请输入不含认证信息、查询参数的 HTTPS 地址。');
  return value.trim().replace(/\/$/, '');
}
export function SettingsPanel({ settings, sessions, projects, currentProjectId, onImportCompleted, onChanged, onClose, initialTab = 'providers' }: {
  settings: SettingsSnapshot; sessions: Session[]; projects: Project[]; currentProjectId?: string; onImportCompleted?: (sessionId?: string) => Promise<void>; onChanged: (settings: SettingsSnapshot) => void; onClose: () => void; initialTab?: Tab;
}) {
  const api = window.jinggong;
  const [snapshot, setSnapshot] = useState(settings);
  const [tab, setTab] = useState<Tab>(initialTab);
  useEffect(() => setSnapshot(settings), [settings]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => previous?.focus();
  }, []);
  async function act(work: () => Promise<unknown>, success: SuccessNotice = '已保存。') {
    setPending(true); setError(''); setNotice('');
    try {
      await work();
      const next = await api.getSettings(); setSnapshot(next); onChanged(next); setNotice(typeof success === 'function' ? success() : success);
      return true;
    } catch (reason) { setError(failure(reason)); return false; }
    finally { setPending(false); }
  }
  function key(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' && !pending) { event.preventDefault(); onClose(); }
    if (event.key !== 'Tab') return;
    const nodes = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[tabindex="0"]');
    if (!nodes?.length) return;
    const first = nodes[0], last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <div className="modal-backdrop"><div className="settings-shell" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="settings-title" onKeyDown={key}>
    <header className="settings-header"><div><h2 id="settings-title">设置</h2><p>管理本地研发环境与个人偏好</p></div><button className="icon-button" aria-label="关闭设置" title="关闭设置" onClick={onClose} disabled={pending}><Icon name="close" /></button></header>
    <div className="settings-body"><nav className="settings-navigation" aria-label="设置分类">{tabs.map(item => <button key={item.id} className={item.id === tab ? 'selected' : ''} onClick={() => { setTab(item.id); setError(''); setNotice(''); }} disabled={pending}><Icon name={item.icon} />{item.name}</button>)}</nav>
      <div className="settings-content">
        {error && <div className="form-error" role="alert"><Icon name="alert" />{error}</div>}{notice && <div className="settings-notice" role="status"><Icon name="check" />{notice}</div>}
        {tab === 'providers' && <Providers profiles={snapshot.providers} pending={pending} act={act} api={api} onSaved={onClose} />}
        {tab === 'appearance' && <Appearance preferences={snapshot.preferences} pending={pending} act={act} api={api} />}
        {tab === 'jira' && <Jira snapshot={snapshot} pending={pending} act={act} api={api} />}
        {tab === 'runtime' && <RuntimeSettings snapshot={snapshot} pending={pending} act={act} api={api} />}
        {tab === 'plugins' && (api.pluginManager ? <PluginManagerPanel api={api.pluginManager} /> : <p className="settings-empty">插件管理能力当前不可用，请重启应用后重试。</p>)}
         {tab === 'workspaces' && <Workspaces pending={pending} act={act} api={api} />}
         {tab === 'sessions' && <SessionDataSettings sessions={sessions} projects={projects} currentProjectId={currentProjectId} onImportCompleted={onImportCompleted} pending={pending} act={act} api={api} />}
        {tab === 'wecom' && <WeComSettings snapshot={snapshot} pending={pending} act={act} api={api} />}
        {tab === 'updates' && <Updates snapshot={snapshot} pending={pending} act={act} api={api} />}
        {tab === 'requirements' && <RequirementsSyncPanel api={api} state={snapshot.requirementsSync} pending={pending} act={act} />}
        {(tab === 'documents' || tab === 'requirements') && <Documents key={tab} kind={tab === 'documents' ? 'dictionary' : 'requirement'} onKindChange={kind => { setTab(kind === 'dictionary' ? 'documents' : 'requirements'); setError(''); setNotice(''); }} documents={snapshot.documents} pending={pending} act={act} api={api} />}
        {tab === 'memories' && <Memories snapshot={snapshot} pending={pending} act={act} api={api} />}
      </div>
    </div>
  </div></div>;
}
interface Operations { api: DesktopApi; pending: boolean; act: (work: () => Promise<unknown>, success?: SuccessNotice) => Promise<boolean> }

function updateText(status: UpdateStatus): string {
  return status.message || ({ disabled: '在线更新不可用', idle: '等待检查', checking: '正在检查更新…', available: '发现新版本', downloading: '正在下载更新…', downloaded: '更新已下载', 'not-available': '当前已是最新版本', error: '更新检查失败' } as Record<string, string>)[status.state];
}

const runtimeOptions: { kind: RuntimeKind; name: string; description: string }[] = [
  { kind: 'jinggong', name: 'Jinggong Runtime', description: '精工维护的独立执行引擎，可选使用。' },
  { kind: 'codex', name: 'Codex Runtime', description: '兼容现有 Codex App Server 会话，可在会话中选择。' },
  { kind: 'claude_agent_sdk', name: 'Claude Agent SDK Runtime', description: '通过官方 Claude Agent SDK 运行，使用模型中转站中的地址、模型和凭据。' },
];

function RuntimeSettings({ snapshot, api, pending }: Operations & { snapshot: SettingsSnapshot }) {
  const [health, setHealth] = useState<Partial<Record<RuntimeKind, RuntimeHealth>>>({});
  const [checking, setChecking] = useState<RuntimeKind | ''>('');

  async function check(kind: RuntimeKind) {
    setChecking(kind);
    try {
      const result = await api.checkRuntime(kind);
      setHealth(current => ({ ...current, [kind]: result }));
    } catch (reason) {
      const detail = failure(reason);
      setHealth(current => ({ ...current, [kind]: { available: false, compatible: false, version: '', detail } }));
    } finally {
      setChecking('');
    }
  }
  async function testClaudeConnection() {
    setChecking('claude_agent_sdk');
    try {
      const result = await api.testClaudeConnection();
      setHealth(current => ({ ...current, claude_agent_sdk: result }));
    } catch (reason) {
      const detail = failure(reason);
      setHealth(current => ({ ...current, claude_agent_sdk: { available: false, compatible: false, version: '', detail } }));
    } finally { setChecking(''); }
  }
  useEffect(() => {
    let active = true;
    void Promise.all(runtimeOptions.map(async option => {
      try {
        const result = await api.checkRuntime(option.kind);
        if (active) setHealth(current => ({ ...current, [option.kind]: result }));
      } catch (reason) {
        if (active) setHealth(current => ({ ...current, [option.kind]: { available: false, compatible: false, version: '', detail: failure(reason) } }));
      }
    }));
    return () => { active = false; };
  }, [api]);

  function healthText(value?: RuntimeHealth) {
    if (!value) return '正在检查运行时…';
    if (value.compatible) return `可用 · ${value.version || '版本未知'}${value.buildNumber ? ` · 构建 ${value.buildNumber}` : ''}${value.sandbox === 'unverified' ? ' · 沙箱待验收' : ''}`;
    return value.detail || '运行时不可用';
  }
  return <section aria-label="Runtime 设置">
    <div className="section-heading"><div><h3>Runtime 组件状态</h3><p>Runtime 按会话独立选择。请在输入区模型旁或新建会话窗口选择运行时。</p></div></div>
    <div className="runtime-options">
      {runtimeOptions.map(option => {
        const current = health[option.kind];
        return <div className="runtime-choice" key={option.kind}>
          <span className="runtime-choice-body"><strong>{option.name}</strong><small>{option.description}</small><span className={`runtime-health ${current?.compatible ? 'ready' : 'unready'}`}><span className="status-dot" />{healthText(current)}</span>{current?.upstreamCommit && <small className="runtime-provenance">上游 commit：{current.upstreamCommit}</small>}</span>
          <button type="button" className="icon-button runtime-check" aria-label={`检查 ${option.name}`} title={`检查 ${option.name}`} disabled={pending || checking === option.kind} onClick={event => { event.preventDefault(); void check(option.kind); }}><Icon name="refresh" /></button>
        </div>;
      })}
    </div>
    <div className="runtime-note"><Icon name="shield" /><p>运行时不会静默回退。运行时未就绪时，新会话会明确提示原因；请先检查对应组件和凭据后再创建新会话。</p></div>
    <div className="settings-form" aria-label="Claude 连接测试">
      <h4>Claude Agent SDK 连接测试</h4><p className="field-hint">连接测试使用默认中转站“{snapshot.providers[0]?.name || '未配置'}”的地址、首个模型和 API Key。实际会话使用该会话选择的中转站配置。</p>
      <div className="settings-actions"><button type="button" disabled={pending || checking === 'claude_agent_sdk' || !snapshot.providers[0]?.models[0] || !snapshot.providers[0]?.hasKey} onClick={() => void testClaudeConnection()}>{checking === 'claude_agent_sdk' ? '正在测试…' : '测试 Claude 连接'}<Icon name="refresh" /></button></div>
    </div>
  </section>;
}

function WeComSettings({ snapshot, api, act, pending }: Operations & { snapshot: SettingsSnapshot }) {
  const settings = snapshot.wecom ?? { targets: [], deliveries: [] };
  const [selectedId, setSelectedId] = useState('');
  const current = settings.targets.find(target => target.id === selectedId);
  const [name, setName] = useState(''); const [purpose, setPurpose] = useState<'private_group' | 'team_group'>('private_group');
  const [webhookUrl, setWebhookUrl] = useState(''); const [enabled, setEnabled] = useState(true);
  const [users, setUsers] = useState(''); const [mobiles, setMobiles] = useState('');
  const [workspaceIds, setWorkspaceIds] = useState<string[]>([]); const [runtimeKinds, setRuntimeKinds] = useState<RuntimeKind[]>([]);
  const [policy, setPolicy] = useState({ onCompleted: true, onFailed: true, onError: true, onCancelled: false, onInterrupted: true });
  useEffect(() => {
    if (!current) { setName(''); setPurpose('private_group'); setWebhookUrl(''); setEnabled(true); setUsers(''); setMobiles(''); setWorkspaceIds([]); setRuntimeKinds([]); setPolicy({ onCompleted: true, onFailed: true, onError: true, onCancelled: false, onInterrupted: true }); return; }
    setName(current.name); setPurpose(current.purpose); setWebhookUrl(''); setEnabled(current.enabled); setUsers(current.mentionedUserIds?.join('\n') ?? ''); setMobiles(current.mentionedMobiles?.join('\n') ?? ''); setWorkspaceIds(current.workspaceIds ?? []); setRuntimeKinds(current.runtimeKinds ?? []); setPolicy(current.eventPolicy);
  }, [selectedId, snapshot.wecom]);
  async function save(event: FormEvent) {
    event.preventDefault();
    const saved = await act(() => api.saveWeComTarget({ ...(current ? { id: current.id } : {}), name: name.trim(), purpose, ...(webhookUrl.trim() ? { webhookUrl: webhookUrl.trim() } : {}), enabled, ...(purpose === 'team_group' ? { mentionedUserIds: users.split(/[\n,;]+/).map(value => value.trim()).filter(Boolean), mentionedMobiles: mobiles.split(/[\n,;]+/).map(value => value.trim()).filter(Boolean) } : {}), workspaceIds, runtimeKinds, eventPolicy: policy }), '企业微信通知目标已保存，Webhook 不会回显。');
    if (saved) setWebhookUrl('');
  }
  return <section aria-label="企业微信通知设置">
    <div className="section-heading"><div><h3>企业微信群机器人</h3><p>通知由本机主进程发送，失败不会改变会话结果。Webhook 密钥使用 Windows 凭据保护。</p></div><button className="secondary-button" disabled={pending} onClick={() => setSelectedId('')}><Icon name="plus" />新增目标</button></div>
    <div className="credential-note"><Icon name="shield" /><p>机器人只能向其所在群发消息，不支持直达个人聊天。专属通知请创建仅包含目标人员的专属群；普通群可填写成员 UserID 或手机号进行 @。</p></div>
    <div className="managed-list">{!settings.targets.length && <div className="settings-empty">尚未配置企业微信群机器人。</div>}{settings.targets.map(target => <div className={`managed-row ${target.id === selectedId ? 'selected' : ''}`} key={target.id}><button className="managed-select" onClick={() => setSelectedId(target.id)}><Icon name="chat" /><span><strong>{target.name}</strong><small>{target.purpose === 'private_group' ? '专属通知群' : '普通群聊'} · {target.hasCredential ? '凭据已保存' : '缺少 Webhook'} · {target.enabled ? '已启用' : '已停用'}</small></span></button><button className="secondary-button" disabled={pending || !target.enabled || !target.hasCredential} onClick={() => void act(async () => { const result = await api.testWeComTarget(target.id); if (result.status !== 'sent') throw new Error(result.errorSummary || '测试消息未发送成功'); }, '测试消息已发送；请确认目标群实际收到。')}>测试发送</button></div>)}</div>
    <form className="settings-form" onSubmit={save}><h4>{current ? '编辑通知目标' : '新增通知目标'}</h4><label htmlFor="wecom-name">目标名称</label><input id="wecom-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required disabled={pending} placeholder="例如：我的个人通知群" />
      <label htmlFor="wecom-purpose">用途</label><select id="wecom-purpose" value={purpose} onChange={event => setPurpose(event.target.value as typeof purpose)} disabled={pending}><option value="private_group">专属通知群</option><option value="team_group">普通群聊</option></select>
      <label htmlFor="wecom-webhook">群机器人 Webhook{current?.hasCredential && <span className="saved-secret"><Icon name="check" />已安全保存</span>}</label><input id="wecom-webhook" type="password" autoComplete="new-password" value={webhookUrl} onChange={event => setWebhookUrl(event.target.value)} disabled={pending} required={!current?.hasCredential} placeholder={current?.hasCredential ? '留空保留，输入新 Webhook 以替换' : 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…'} />
      <label className="checkbox-row"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} disabled={pending} />启用该通知目标</label>
      {purpose === 'team_group' && <><label htmlFor="wecom-users">@成员 UserID（每行或逗号分隔）</label><textarea id="wecom-users" rows={3} value={users} onChange={event => setUsers(event.target.value)} disabled={pending} placeholder="企业微信内部 UserID" /><label htmlFor="wecom-mobiles">@成员手机号（可选）</label><textarea id="wecom-mobiles" rows={2} value={mobiles} onChange={event => setMobiles(event.target.value)} disabled={pending} placeholder="仅填写用户主动提供且属于目标群的手机号" /></>}
      <fieldset className="settings-form"><legend>适用项目/工作区（全不选表示全部）</legend>{(snapshot.notificationWorkspaces ?? []).map(workspace => <label className="checkbox-row" key={workspace.id}><input type="checkbox" checked={workspaceIds.includes(workspace.id)} onChange={event => setWorkspaceIds(values => event.target.checked ? [...values, workspace.id] : values.filter(id => id !== workspace.id))} disabled={pending} />{workspace.name}</label>)}{!(snapshot.notificationWorkspaces ?? []).length && <p className="field-hint">尚无已配置项目；当前空范围表示全部。</p>}</fieldset>
      <fieldset className="settings-form"><legend>适用 Runtime（全不选表示全部）</legend>{([['codex', 'Codex'], ['jinggong', 'Jinggong'], ['claude_agent_sdk', 'Claude Agent SDK']] as const).map(([kind, label]) => <label className="checkbox-row" key={kind}><input type="checkbox" checked={runtimeKinds.includes(kind)} onChange={event => setRuntimeKinds(values => event.target.checked ? [...values, kind] : values.filter(value => value !== kind))} disabled={pending} />{label}</label>)}</fieldset>
      <fieldset className="settings-form"><legend>默认通知事件</legend>{([['onCompleted', '会话完成'], ['onFailed', '会话失败'], ['onError', '会话异常'], ['onInterrupted', '会话中断'], ['onCancelled', '用户取消']] as const).map(([key, label]) => <label className="checkbox-row" key={key}><input type="checkbox" checked={policy[key]} onChange={event => setPolicy(value => ({ ...value, [key]: event.target.checked }))} disabled={pending} />{label}</label>)}</fieldset>
      <div className="settings-actions">{current && <><button className="secondary-button" type="button" disabled={pending || !current.enabled || !current.hasCredential} onClick={() => void act(async () => { const result = await api.testWeComTarget(current.id); if (result.status !== 'sent') throw new Error(result.errorSummary || '测试消息未发送成功'); }, '测试消息已发送；请确认目标群实际收到。')}>发送测试</button><button className="danger-button" type="button" disabled={pending} onClick={async () => { if (await act(() => api.deleteWeComTarget(current.id), '目标与本机 Webhook 凭据已删除。')) setSelectedId(''); }}>删除目标</button></>}<button className="primary-button" type="submit" disabled={pending || !name.trim()}>{pending ? '正在保存…' : '保存目标'}<Icon name="check" /></button></div>
    </form>
    <h4>通知历史（最近 {settings.deliveries.length} 条）</h4><div className="managed-list">{!settings.deliveries.length && <div className="settings-empty">暂无通知发送记录。</div>}{settings.deliveries.map(item => <div className="managed-row" key={item.id}><div className="managed-select"><Icon name={item.status === 'sent' ? 'check' : 'alert'} /><span><strong>{item.targetName} · {item.status === 'sent' ? '已发送' : item.status === 'sending' ? '发送中' : '失败'}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN')} · {item.kind === 'test' ? '测试' : item.kind === 'manual_retry' ? '手动重试' : item.eventType ?? '终态通知'} · 尝试 {item.attempts} 次</small><small>{item.errorSummary || item.content.replace(/\n/g, ' · ')}</small></span></div>{item.status === 'failed' && <button className="secondary-button" disabled={pending} onClick={() => void act(async () => { const result = await api.retryWeComDelivery(item.id); if (result.status !== 'sent') throw new Error(result.errorSummary || '重试未发送成功'); }, '重试操作已完成；请确认目标群实际收到。')}>重试</button>}</div>)}</div>
  </section>;
}

function Updates({ snapshot, api, act, pending }: Operations & { snapshot: SettingsSnapshot }) {
  const [status, setStatus] = useState<UpdateStatus>(snapshot.update);
  const [url, setUrl] = useState(snapshot.updateUrl);
  useEffect(() => setUrl(snapshot.updateUrl), [snapshot.updateUrl]);
  useEffect(() => setStatus(snapshot.update), [snapshot.update]);
  useEffect(() => api.onUpdateStatus(next => setStatus(next)), [api]);
  async function check() { await act(async () => setStatus(await api.checkForUpdate()), '更新检查已完成。'); }
  async function download() { await act(async () => setStatus(await api.downloadUpdate()), '更新下载已开始。'); }
  const mode = snapshot.preferences.updateMode ?? 'automatic';
  const updating = ['checking', 'downloading', 'downloaded'].includes(status.state);
  const changed = url.trim() !== snapshot.updateUrl;
  return <section aria-label="更新设置">
    <div className="section-heading"><div><h3>应用更新</h3><p>自动模式启动后静默检查并下载；手动模式由你发起检查。</p></div><strong className="app-version" aria-label="当前应用版本">当前版本 v{snapshot.appVersion}</strong></div>
    <form className="settings-form update-source-form" onSubmit={event => { event.preventDefault(); void act(() => api.saveUpdateUrl(url.trim()), '更新地址已保存。'); }}>
      <label htmlFor="update-url">更新地址</label><input id="update-url" type="url" aria-label="更新地址" value={url} onChange={event => setUrl(event.target.value)} disabled={pending || updating} required maxLength={2000} />
      <p className="field-hint">支持 GitHub 仓库地址（包括 .git）或提供 latest.yml 的 HTTPS 更新目录。保存后生效。</p>
      <div className="settings-actions"><button className="secondary-button" type="submit" disabled={pending || updating || !changed}>保存更新地址</button></div>
    </form>
    <h4>更新方式</h4><div className="update-mode-options">
      <label><input type="radio" name="update-mode" checked={mode === 'automatic'} disabled={pending} onChange={() => { void act(() => api.savePreferences({ ...snapshot.preferences, updateMode: 'automatic' }), '已切换为自动更新。'); }} />自动更新</label>
      <label><input type="radio" name="update-mode" checked={mode === 'manual'} disabled={pending} onChange={() => { void act(() => api.savePreferences({ ...snapshot.preferences, updateMode: 'manual' }), '已切换为手动更新。'); }} />手动更新</label>
    </div>
    <div className="update-status-box"><strong>{updateText(status)}</strong>{status.version && status.version !== snapshot.appVersion && <span>可用版本 {status.version}</span>}{status.progress !== undefined && <progress max="100" value={status.progress} />}</div>
    <div className="settings-actions"><button className="secondary-button" disabled={pending || updating || changed} onClick={() => { void check(); }}><Icon name="refresh" />检查更新</button>{status.state === 'available' && <button className="primary-button" disabled={pending || changed} onClick={() => { void download(); }}>下载更新</button>}{status.state === 'downloaded' && <button className="primary-button" disabled={pending} onClick={() => { void api.installUpdate(); }}>重启并更新</button>}</div>
    <p className="section-description">更新下载完成后重启生效，项目、会话和配置会保留。</p>
  </section>;
}

function Providers({ profiles, pending, act, api, onSaved }: Operations & { profiles: ProviderProfile[]; onSaved: () => void }) {
  const [selected, setSelected] = useState(profiles[0]?.id || '');
  const initial = profiles.find(item => item.id === selected);
  const [name, setName] = useState(initial?.name || '默认中转站');
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl || '');
  const [models, setModels] = useState(initial?.models.join('\n') || '');
  const [catalog, setCatalog] = useState<ProviderModel[]>(initial?.modelCatalog || initial?.models.map(id => ({ id, name: id })) || []);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [key, setKey] = useState('');
  const [deleting, setDeleting] = useState(false);
  function choose(profile?: ProviderProfile) { setSelected(profile?.id || ''); setName(profile?.name || ''); setBaseUrl(profile?.baseUrl || ''); setModels(profile?.models.join('\n') || ''); setCatalog(profile?.modelCatalog || profile?.models.map(id => ({ id, name: id })) || []); setKey(''); setDeleting(false); }
  async function fetchModels() {
    if (!selected) throw new Error('请先保存中转站配置，再获取模型列表。');
    setFetchingModels(true);
    try { const rows = await api.fetchProviderModels(selected); setCatalog(rows); setModels(rows.map(item => item.id).join('\n')); }
    finally { setFetchingModels(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    const ok = await act(async () => {
      const url = validateUrl(baseUrl);
      const ids = [...new Set(models.split(/[\r\n,]+/).map(item => item.trim()).filter(Boolean))];
      if (!name.trim()) throw new Error('请填写中转站名称。');
      if (!ids.length) throw new Error('请至少填写一个模型 ID。');
      if ((!initial?.hasKey || url !== initial.baseUrl.replace(/\/$/, '')) && !key.trim()) throw new Error('新增或更换中转站地址时，请填写独立 API Key。');
      await api.saveModelProvider({ ...(selected ? { id: selected } : {}), name: name.trim(), baseUrl: url, models: ids, modelCatalog: catalog.filter(item => ids.includes(item.id)), ...(key.trim() ? { apiKey: key.trim() } : {}) });
    }, '模型配置已保存。');
    setKey(''); if (ok) onSaved();
  }
  return <section aria-label="模型中转站管理"><div className="section-heading"><div><h3>连接您的模型</h3><p>为不同中转站分别配置模型与加密凭据。</p></div><button className="secondary-button" onClick={() => choose()} disabled={pending}><Icon name="plus" />新增中转站</button></div>
    {profiles.length > 0 && <div className="provider-pills" aria-label="已配置中转站">{profiles.map(profile => <button key={profile.id} className={selected === profile.id ? 'selected' : ''} onClick={() => choose(profile)} disabled={pending}>{profile.name}<span>{profile.models.length} 个模型</span></button>)}</div>}
    <form className="settings-form" onSubmit={save}><label htmlFor="provider-name">中转站名称</label><input id="provider-name" value={name} onChange={e => setName(e.target.value)} required maxLength={80} disabled={pending} autoComplete="off" placeholder="例如：研发主中转" />
      <label htmlFor="provider-url">API Base URL<span>HTTPS</span></label><input id="provider-url" type="url" value={baseUrl} onChange={e => setBaseUrl(e.target.value)} placeholder="https://gateway.example/v1" autoComplete="off" required disabled={pending} /><p className="field-hint">需支持 OpenAI Responses API 和流式输出。</p>
      <label htmlFor="provider-model">模型 ID<span>每行一个，可配置多个</span></label><textarea id="provider-model" value={models} onChange={e => { setModels(e.target.value); setCatalog(e.target.value.split(/[\r\n,]+/).map(id => id.trim()).filter(Boolean).map(id => ({ id, name: catalog.find(item => item.id === id)?.name || id }))); }} rows={3} required disabled={pending} placeholder="填写实际模型 ID，每行一个" />
      <div className="settings-actions model-fetch-actions"><button type="button" className="secondary-button" onClick={() => void act(fetchModels, '已从中转站获取模型列表，默认已全选。')} disabled={pending || fetchingModels || !selected || !initial?.hasKey}>{fetchingModels ? '正在获取模型…' : '从中转站获取模型列表'}<Icon name="refresh" /></button></div>
      {catalog.length > 0 && <div className="provider-model-table" aria-label="模型列表"><div className="provider-model-row provider-model-header"><span>启用</span><span>模型 ID</span><span>模型名称</span></div>{catalog.map(item => { const checked = models.split(/[\r\n,]+/).map(value => value.trim()).includes(item.id); return <label className="provider-model-row" key={item.id}><input type="checkbox" checked={checked} onChange={event => { const ids = new Set(models.split(/[\r\n,]+/).map(value => value.trim()).filter(Boolean)); event.target.checked ? ids.add(item.id) : ids.delete(item.id); const next = [...ids]; setModels(next.join('\n')); }} disabled={pending} /><code>{item.id}</code><span>{item.name}</span></label>; })}</div>}
      <label htmlFor="provider-key">API Key{initial?.hasKey && <span className="saved-secret"><Icon name="check" />已加密保存</span>}</label><input id="provider-key" type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="new-password" spellCheck={false} required={!initial?.hasKey} disabled={pending} placeholder={initial?.hasKey ? '留空保留密钥；更换地址时必须重新填写' : '请输入独立 API Key'} />
      <div className="credential-note"><Icon name="shield" /><p>密码和密钥只写入安全存储，保存后不回显。模型是否支持完整 Agent 能力，需通过真实会话验证。</p></div>
      <div className="settings-actions">{selected && <button type="button" className="danger-button" onClick={() => setDeleting(true)} disabled={pending}>删除中转站</button>}<button className="primary-button" type="submit" disabled={pending}>{pending ? '正在保存…' : '保存配置'}<Icon name="check" /></button></div>
      {deleting && <div className="delete-confirm"><span>确认删除“{initial?.name}”？历史会话仍保留来源记录。</span><button type="button" onClick={() => setDeleting(false)} disabled={pending}>保留</button><button type="button" className="danger-button" disabled={pending} onClick={async () => { if (await act(() => api.deleteModelProvider(selected), '中转站已删除。')) choose(); }}>确认删除</button></div>}
    </form>
  </section>;
}

function Appearance({ preferences, api, pending, act }: Operations & { preferences: Preferences }) {
  const sounds: { value: CompletionSound; label: string; detail: string }[] = [
    { value: 'chime', label: '清脆提示', detail: '默认' },
    { value: 'bright', label: '明亮提示', detail: '三声上扬' },
    { value: 'soft', label: '柔和提示', detail: '轻柔双音' },
    { value: 'off', label: '关闭声音', detail: '仅显示通知' },
  ];
  return <section><div className="section-heading"><div><h3>外观</h3><p>选择适合您的界面风格与主题。</p></div></div><h4>界面风格</h4><div className="style-options">{([{ id: 'jinggong', name: '精工风格', description: '品牌配色与研发工作台' }, { id: 'minimal', name: '极简风格', description: '中性色彩与精简装饰' }] as const).map(option => <button className={`style-choice ${preferences.style === option.id ? 'selected' : ''}`} key={option.id} aria-pressed={preferences.style === option.id} disabled={pending} onClick={() => act(() => api.savePreferences({ ...preferences, style: option.id }), '界面风格已保存。')}><div className={`style-preview preview-${option.id}`}><span /><span /><span /></div><strong>{option.name}</strong><p>{option.description}</p>{preferences.style === option.id && <Icon name="check" />}</button>)}</div><h4>主题</h4><div className="theme-options">{([{ value: 'dark', label: '深色' }, { value: 'light', label: '浅色' }, { value: 'system', label: '跟随系统' }, { value: 'purple', label: '紫色' }, { value: 'black', label: '黑色' }, { value: 'sky', label: '天空蓝' }, { value: 'grass', label: '草绿色' }] as const).map(option => <button className={preferences.theme === option.value ? 'selected' : ''} key={option.value} aria-pressed={preferences.theme === option.value} disabled={pending} onClick={() => act(() => api.savePreferences({ ...preferences, theme: option.value }), '主题已保存。')}>{option.label}{preferences.theme === option.value && <Icon name="check" />}</button>)}</div><h4>会话完成提示音</h4><div className="completion-sounds" aria-label="会话完成提示音">{sounds.map(sound => <button type="button" className={preferences.completionSound === sound.value ? 'selected' : ''} key={sound.value} aria-pressed={preferences.completionSound === sound.value} disabled={pending} onClick={() => act(() => api.savePreferences({ ...preferences, completionSound: sound.value }), '完成提示音已保存。')}><span><strong>{sound.label}</strong><small>{sound.detail}</small></span>{preferences.completionSound === sound.value && <Icon name="check" />}</button>)}</div><button type="button" className="secondary-button sound-preview" disabled={pending} onClick={() => playCompletionSound(preferences.completionSound)}>试听当前提示音</button><p className="section-description">偏好保存在本机，重新启动后仍然生效。提示音在会话完成时播放。</p></section>;
}

function Jira({ snapshot, api, act, pending }: Operations & { snapshot: SettingsSnapshot }) {
  const [url, setUrl] = useState(snapshot.jira.baseUrl);
  const [account, setAccount] = useState(snapshot.jira.account);
  const [password, setPassword] = useState('');
  const [projectKey, setProjectKey] = useState(snapshot.jira.projectKey || 'NEWDEVGROUP');
  const [dateFieldId, setDateFieldId] = useState(snapshot.jira.dateFieldId || '11116');
  const [testing, setTesting] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    const saved = await act(async () => {
      let address: URL;
      try { address = new URL(url.trim()); } catch { throw new Error('请输入有效的 Jira HTTP 或 HTTPS 地址。'); }
      if (!['http:', 'https:'].includes(address.protocol) || address.username || address.password) throw new Error('Jira 地址须使用 HTTP 或 HTTPS，且不能包含账号密码。');
      if (!account.trim()) throw new Error('请填写 Jira 账号。');
      if (!snapshot.jira.hasPassword && !password) throw new Error('请填写 Jira 密码。');
      await api.saveJira({ baseUrl: url.trim(), account: account.trim(), projectKey: projectKey.trim() || 'NEWDEVGROUP', dateFieldId: dateFieldId.trim() || '11116', ...(password ? { password } : {}) });
    }, 'Jira 配置已保存，可测试连接或到 Jira 任务页抓取需求。');
    if (saved) setPassword('');
  }
  async function test() {
    setTesting(true);
    let connection: JiraConnectionResult | null = null;
    try { await act(async () => { connection = await api.testJiraConnection(); }, () => connection ? `连接成功：${connection.displayName} · 时区 ${connection.timeZone} · 日报字段 ${connection.fieldName}（${connection.fieldType === 'date' ? '日期' : '日期时间'}）。` : '连接测试完成。'); }
    finally { setTesting(false); }
  }
  return <section><div className="section-heading"><div><h3>Jira 连接</h3><p>保存 Jira 地址和账号，按日报日期抓取真实任务。可直接粘贴 Jira 项目页地址。</p></div></div><form className="settings-form" onSubmit={save}>
    <label htmlFor="jira-url">Jira 域名或项目页地址</label><input id="jira-url" type="url" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://jira.example.com/projects/NEWDEVGROUP" required disabled={pending} autoComplete="off" />
    {/^http:/i.test(url.trim()) && <p className="field-hint jira-http-hint">HTTP 传输未加密，请在可信网络使用。</p>}
    {snapshot.jira.baseUrl && <p className="field-hint">已保存连接：{snapshot.jira.baseUrl}</p>}
    <label htmlFor="jira-account">Jira 账号</label><input id="jira-account" value={account} onChange={e => setAccount(e.target.value)} required disabled={pending} autoComplete="off" />
    <label htmlFor="jira-password">Jira 密码{snapshot.jira.hasPassword && <span className="saved-secret"><Icon name="check" />已安全保存</span>}</label><input id="jira-password" type="password" value={password} onChange={e => setPassword(e.target.value)} required={!snapshot.jira.hasPassword} disabled={pending} autoComplete="new-password" placeholder={snapshot.jira.hasPassword ? '留空保留，更换地址或账号时重新填写' : '输入密码，保存后不回显'} />
    <div className="jira-settings-fields"><div><label htmlFor="jira-project-key">默认 Jira 项目（可在任务页切换）</label><input id="jira-project-key" value={projectKey} onChange={e => setProjectKey(e.target.value)} maxLength={80} disabled={pending} placeholder="NEWDEVGROUP" /></div><div><label htmlFor="jira-date-field">日报日期字段 ID</label><input id="jira-date-field" value={dateFieldId} onChange={e => setDateFieldId(e.target.value)} maxLength={80} disabled={pending} placeholder="11116" /></div></div>
    <p className="field-hint">项目页地址只用于提取默认项目，不限制整个任务工作台。默认日期字段 11116；测试连接会核对字段类型与 Jira 账户时区。</p>
    <div className="credential-note"><Icon name="shield" /><p>密码由 Windows 保护。修改连接地址或账号时需重新填写密码。</p></div>
    <div className="settings-actions"><button className="secondary-button" type="button" disabled={pending || !snapshot.jira.hasPassword} onClick={test}>{testing ? '正在测试…' : '测试已保存连接'}</button><button className="primary-button" type="submit" disabled={pending}>保存 Jira 配置<Icon name="check" /></button></div>
  </form></section>;
}

function Workspaces({ api, act, pending }: Operations) {
  const [items, setItems] = useState<DesktopWorkspace[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const selected = items.find(item => item.id === selectedId);
  async function reload() {
    setLoading(true);
    try { const next = await api.listWorkspaces(); setItems(next); setSelectedId(current => next.some(item => item.id === current) ? current : next[0]?.id ?? ''); }
    catch (error) { throw error; }
    finally { setLoading(false); }
  }
  useEffect(() => { void reload().catch(() => undefined); }, []);
  useEffect(() => { setName(selected?.name ?? ''); setDescription(selected?.description ?? ''); }, [selected?.id]);
  async function create() {
    if (!name.trim()) return;
    if (await act(async () => { const created = await api.createWorkspace({ name: name.trim(), description: description.trim() || undefined, access: 'read' }); if (created) { setItems(current => [...current, created]); setSelectedId(created.id); } }, '工作区已创建，可直接新建会话；Git 仓库按需添加。')) await reload();
  }
  async function save() {
    if (!selected || !name.trim()) return;
    if (await act(async () => { const updated = await api.updateWorkspace(selected.id, { name: name.trim(), description: description.trim() || undefined, system: selected.system, instructions: selected.instructions }); setItems(current => current.map(item => item.id === updated.id ? updated : item)); }, '工作区信息已保存。')) await reload();
  }
  async function addRepository() {
    if (!selected) return;
    if (await act(async () => { const updated = await api.addWorkspaceRepository(selected.id, { access: 'read' }); if (updated) setItems(current => current.map(item => item.id === updated.id ? updated : item)); }, '仓库已加入工作区。')) await reload();
  }
  async function setPrimary(repositoryId: string) {
    if (!selected || selected.primaryRepositoryId === repositoryId) return;
    if (await act(async () => { const updated = await api.setPrimaryWorkspaceRepository(selected.id, repositoryId); setItems(current => current.map(item => item.id === updated.id ? updated : item)); }, '主仓库已更新。')) await reload();
  }
  async function removeRepository(repositoryId: string) {
    if (!selected || !window.confirm('只解除工作区关联，不会删除仓库文件。继续？')) return;
    if (await act(async () => { const updated = await api.removeWorkspaceRepository(selected.id, repositoryId); setItems(current => current.map(item => item.id === updated.id ? updated : item)); }, '仓库已从工作区移除。')) await reload();
  }
  async function deleteWorkspace() {
    if (!selected || !window.confirm('只删除工作区元数据，不会删除任何仓库文件。继续？')) return;
    if (await act(() => api.deleteWorkspace(selected.id), '工作区已删除。')) { setItems(current => current.filter(item => item.id !== selected.id)); setSelectedId(''); }
  }
  return <section aria-label="多仓库工作区管理"><div className="section-heading"><div><h3>多仓库工作区</h3><p>工作区用于归类项目与会话，可以不关联 Git 仓库。按需添加的仓库只管理元数据和只读状态，不会扩大 Runtime 授权。</p></div></div>
    <div className="document-controls"><label>已有工作区<select aria-label="选择工作区" value={selected?.id ?? ''} onChange={event => setSelectedId(event.target.value)} disabled={pending || loading}><option value="">{loading ? '正在读取…' : items.length ? '请选择' : '暂无工作区'}</option>{items.map(item => <option value={item.id} key={item.id}>{item.name}（{item.repositories.length} 个仓库）</option>)}</select></label><button className="primary-button" type="button" onClick={() => { setSelectedId(''); setName(''); setDescription(''); }} disabled={pending}>新建工作区</button></div>
    {!selected && <form className="settings-form" onSubmit={event => { event.preventDefault(); void create(); }}><h4>新建工作区</h4><label htmlFor="workspace-name">名称</label><input id="workspace-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={pending} placeholder="例如：MES6 跨仓库开发" /><label htmlFor="workspace-description">说明</label><textarea id="workspace-description" rows={3} value={description} onChange={event => setDescription(event.target.value)} maxLength={4000} disabled={pending} placeholder="例如：日常事务、业务分析或跨项目协作。" /><div className="settings-actions"><button className="primary-button" type="submit" disabled={pending || !name.trim()}>创建工作区</button></div></form>}
    {selected && <><form className="settings-form" onSubmit={event => { event.preventDefault(); void save(); }}><h4>工作区信息</h4><label htmlFor="workspace-edit-name">名称</label><input id="workspace-edit-name" value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={pending} /><label htmlFor="workspace-edit-description">说明</label><textarea id="workspace-edit-description" rows={3} value={description} onChange={event => setDescription(event.target.value)} maxLength={4000} disabled={pending} /><div className="settings-actions"><button className="primary-button" type="submit" disabled={pending || !name.trim()}>保存工作区</button><button className="danger-button" type="button" onClick={() => void deleteWorkspace()} disabled={pending}>删除元数据</button></div></form><div className="managed-list"><div className="section-heading"><div><h4>仓库列表</h4><p>主仓库和读写意图只保存为元数据；实际 Runtime 授权仍由现有会话边界决定。</p></div><button className="secondary-button" type="button" onClick={() => void addRepository()} disabled={pending}>添加 Git 仓库</button></div>{selected.repositories.map(repository => <div className="managed-row" key={repository.id}><div className="managed-select"><Icon name="branch" /><span><strong>{repository.alias}{repository.primary ? ' · 主仓库' : ''}</strong><small>{repository.role} · {repository.access} · {repository.status ?? '未刷新'}</small><code>{repository.rootPath}</code></span></div><div className="settings-actions"><button className="secondary-button" type="button" onClick={() => void act(async () => { const updated = await api.refreshWorkspaceRepository(selected.id, repository.id); setItems(current => current.map(item => item.id === updated.id ? updated : item)); }, '仓库状态已刷新。')} disabled={pending}>刷新</button>{!repository.primary && <button className="secondary-button" type="button" onClick={() => void setPrimary(repository.id)} disabled={pending}>设为主仓库</button>}<button className="danger-button" type="button" onClick={() => void removeRepository(repository.id)} disabled={pending}>移除关联</button></div></div>)}</div></>}
  </section>;
}

function Documents({ documents, api, act, pending, kind, onKindChange }: Operations & {
  documents: ManagedDocument[]; kind: ManagedDocument['kind']; onKindChange: (kind: ManagedDocument['kind']) => void;
}) {
  const [system, setSystem] = useState<ProductSystem>(kind === 'requirement' ? '通用' : 'MES5');
  const [selected, setSelected] = useState('');
  const [deleting, setDeleting] = useState('');
  const [importing, setImporting] = useState(false);
  const [editingId, setEditingId] = useState('');
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const editorRef = useRef<HTMLDivElement>(null);
  const list = documents.filter(item => item.system === system && item.kind === kind);
  const doc = list.find(item => item.id === selected) || list[0];
  const requirements = kind === 'requirement';
  function resetEditor() { setEditingId(''); setTitle(''); setContent(''); }
  function edit(document: ManagedDocument) { setEditingId(document.id); setTitle(document.name); setContent(document.content); editorRef.current?.scrollIntoView({ block: 'start' }); }
  async function importFile() {
    let result: ManagedDocument | null = null;
    setImporting(true);
    try {
      await act(async () => { result = await api.importDocument({ kind, system }); if (result) { setSelected(result.id); if (requirements) { setEditingId(result.id); setTitle(result.name); setContent(result.content); } } },
        () => result ? `已导入「${result.name}」 · ${result.system} · ${result.content.length.toLocaleString('zh-CN')} 字符（全文已保存）。` : '已取消导入，未新增资料。');
    } finally { setImporting(false); }
  }
  async function saveRequirement(event: FormEvent) {
    event.preventDefault();
    let saved: ManagedDocument | null = null;
    await act(async () => {
      if (!title.trim() || !content.trim()) throw new Error('请填写要求标题和正文。');
      if (content.length > 80000) throw new Error('开发要求正文最多 80,000 字符，请拆分后保存。');
      saved = await api.saveRequirement({ ...(editingId ? { id: editingId } : {}), title: title.trim(), content, system });
      setSelected(saved.id); setEditingId(saved.id); setTitle(saved.name); setContent(saved.content);
    }, () => saved ? `已保存「${saved.name}」 · ${saved.system} · ${saved.content.length.toLocaleString('zh-CN')} 字符。` : '开发要求已保存。');
  }
  return <section aria-label={requirements ? '开发要求与规范管理' : '数据字典管理'}>
    <div className="section-heading"><div><h3>{requirements ? '开发要求与规范' : '数据字典'}</h3><p>{requirements ? '上传文件或直接输入要求，按系统启用，并应用到任务开发与提交检查。' : '按系统维护本地字典，完整资料参与 Agent 全文检索。'}</p></div>{requirements && <button className="secondary-button" disabled={pending} onClick={() => { resetEditor(); editorRef.current?.scrollIntoView({ block: 'start' }); }}><Icon name="plus" />新增要求</button>}</div>
    <div className="document-controls"><label>适用系统<select aria-label="文档适用系统" value={system} onChange={e => { setSystem(e.target.value as ProductSystem); setSelected(''); setDeleting(''); resetEditor(); }} disabled={pending}>{['MES5', 'MES6', 'WMS', '通用'].map(value => <option key={value}>{value}</option>)}</select></label><label>资料类型<select aria-label="文档类型" value={kind} onChange={e => onKindChange(e.target.value as ManagedDocument['kind'])} disabled={pending}><option value="dictionary">数据字典</option><option value="requirement">开发要求与规范</option></select></label><button className="primary-button" disabled={pending} onClick={importFile}><Icon name="plus" />{importing ? '正在导入…' : '上传资料'}</button></div>
    <p className="field-hint">{requirements ? '支持上传 TXT、MD、JSON、CSV、SQL、XLSX、DOCX，或在下方直接输入。正文最多 80,000 字符。JSON 机器规则自动阻断违规，其他正文在提交前逐份人工确认。' : '支持 TXT、MD、JSON、CSV、SQL、XLSX、DOCX。大字典按工作表分页，全文保留并可检索。'}</p>
    <div className="managed-list">{!list.length && <div className="settings-empty">暂无{system}{requirements ? '开发要求与规范，请上传文件或直接输入。' : '数据字典，请上传当前有效版本。'}</div>}{list.map(item => <div className={`managed-row ${item.id === doc?.id ? 'selected' : ''}`} key={item.id}><button className="managed-select" aria-label={`查看文档 ${item.name}`} onClick={() => setSelected(item.id)}><Icon name="file" /><span><strong>{item.name}</strong><small>{new Date(item.createdAt).toLocaleString('zh-CN')}</small></span></button><button className="toggle-button" role="switch" aria-checked={item.enabled} aria-label={`${item.enabled ? '停用' : '启用'} ${item.name}`} disabled={pending} onClick={() => act(() => api.setDocumentEnabled(item.id, !item.enabled), item.enabled ? '资料已停用。' : '资料已启用。')}><span />{item.enabled ? '已启用' : '已停用'}</button><button className="danger-button" disabled={pending} onClick={() => setDeleting(item.id)} aria-label={`删除文档 ${item.name}`}>删除</button></div>)}</div>
    {deleting && <div className="delete-confirm"><span>确认删除此资料？已有历史记录仍保留原引用。</span><button onClick={() => setDeleting('')} disabled={pending}>保留</button><button className="danger-button" disabled={pending} onClick={async () => { if (await act(() => api.deleteDocument(deleting), '资料已删除。')) { if (editingId === deleting) resetEditor(); setDeleting(''); } }}>确认删除</button></div>}
    {doc && <div className="document-preview"><div className="preview-heading"><strong>{doc.name}</strong><span>{doc.system} · {doc.enabled ? '已启用' : '已停用'}</span></div><p className="document-digest" title={doc.digest}>校验摘要：{doc.digest.slice(0, 24)}…</p>{doc.kind === 'dictionary' ? <DictionaryPreview key={doc.id} name={doc.name} content={doc.content} /> : <><pre aria-label="文档内容预览">{doc.content}</pre><div className="requirement-preview-actions"><span>{doc.content.length.toLocaleString('zh-CN')} 字符</span><button className="secondary-button" disabled={pending} onClick={() => edit(doc)}>编辑此要求</button></div></>}</div>}
    {requirements && <div className="requirement-editor" ref={editorRef}><form className="settings-form" onSubmit={saveRequirement}><h4>{editingId ? '编辑已有要求' : '直接输入要求'}</h4>{editingId && <p className="field-hint">保存会更新同一份要求，保留其资料 ID。</p>}<label htmlFor="requirement-title">要求标题</label><input id="requirement-title" aria-label="开发要求标题" value={title} onChange={e => setTitle(e.target.value)} disabled={pending} maxLength={200} required placeholder="例如：MES5 开发规范.md" /><p className="field-hint">未填写扩展名时自动保存为 .md；以 .json 结尾时按机器规则格式校验。</p><label htmlFor="requirement-content">要求正文<span>{content.length.toLocaleString('zh-CN')} / 80,000 字符</span></label><textarea id="requirement-content" aria-label="开发要求正文" rows={9} value={content} onChange={e => setContent(e.target.value)} disabled={pending} maxLength={80000} required placeholder="填写项目规范、开发限制和验收要求。" /><div className="settings-actions"><button className="secondary-button" type="button" disabled={pending} onClick={resetEditor}>清空并新建</button><button className="primary-button" disabled={pending || !title.trim() || !content.trim()} type="submit"><Icon name="check" />{pending ? '正在保存…' : '保存开发要求'}</button></div></form></div>}
  </section>;
}

function Memories({ snapshot, api, act, pending }: Operations & { snapshot: SettingsSnapshot }) {
  const [title, setTitle] = useState(''); const [content, setContent] = useState('');
  const [selected, setSelected] = useState(''); const [deleting, setDeleting] = useState('');
  const memory = snapshot.memories.find(item => item.id === selected);
  async function save(event: FormEvent) { event.preventDefault(); if (await act(() => api.saveMemory({ title: title.trim(), content: content.trim() }), '记忆已保存。')) { setTitle(''); setContent(''); } }
  return <section aria-label="记忆管理"><div className="section-heading"><div><h3>本地记忆</h3><p>任务完成后自动保存任务与结果摘录，同一会话持续更新；后续会话参考同项目最近记忆。可查看来源、手动补充或删除。</p></div></div><div className="settings-actions"><button className="secondary-button" disabled={pending || !snapshot.memories.length} onClick={() => void act(() => api.exportShare({ kind: 'memories' }), '记忆导出操作已完成。')}>导出全部记忆</button><button className="secondary-button" disabled={pending} onClick={() => void act(() => api.importShare(), '记忆导入操作已完成，重复记忆自动跳过。')}>导入记忆</button>{memory && <button className="secondary-button" disabled={pending} onClick={() => void act(() => api.exportShare({ kind: 'memories', memoryIds: [memory.id] }), '所选记忆导出操作已完成。')}>导出所选记忆</button>}</div><div className="managed-list">{!snapshot.memories.length && <div className="settings-empty">暂无本地记忆。完成会话任务后会自动生成，也可手动添加。</div>}{snapshot.memories.map(item => <div className={`managed-row ${selected === item.id ? 'selected' : ''}`} key={item.id}><button className="managed-select" aria-label={`查看记忆 ${item.title}`} onClick={() => setSelected(selected === item.id ? '' : item.id)} aria-expanded={selected === item.id}><Icon name="chat" /><span><strong>{item.title}</strong><small>{item.source === 'session' ? '会话自动生成 · ' : '手动添加 · '}{new Date(item.createdAt).toLocaleString('zh-CN')}</small></span></button><button className="danger-button" onClick={() => setDeleting(item.id)} disabled={pending} aria-label={`删除记忆 ${item.title}`}>删除</button></div>)}</div>{memory && <div className="memory-preview"><strong>{memory.title}</strong><pre aria-label="已保存的记忆内容">{memory.content}</pre></div>}{deleting && <div className="delete-confirm"><span>确认删除这条记忆？</span><button onClick={() => setDeleting('')} disabled={pending}>保留</button><button className="danger-button" disabled={pending} onClick={async () => { if (await act(() => api.deleteMemory(deleting), '记忆已删除。')) { setDeleting(''); setSelected(''); } }}>确认删除</button></div>}<form className="settings-form memory-form" onSubmit={save}><h4>新增记忆</h4><label htmlFor="memory-title">记忆标题</label><input id="memory-title" value={title} onChange={e => setTitle(e.target.value)} required disabled={pending} maxLength={200} placeholder="例如：某项目的构建要求" /><label htmlFor="memory-content">记忆内容</label><textarea id="memory-content" rows={5} value={content} onChange={e => setContent(e.target.value)} required disabled={pending} maxLength={32000} placeholder="填写已确认的信息，避免保存密码或 Token。" /><div className="settings-actions"><button className="primary-button" type="submit" disabled={pending || !title.trim() || !content.trim()}>新增记忆<Icon name="plus" /></button></div></form></section>;
}

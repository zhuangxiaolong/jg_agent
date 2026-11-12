import { useTransientError } from './use-transient-error';
import { useEffect, useRef, useState } from 'react';
import type { GitState, ManagedDocument, Project, RequirementResult, VerificationProfileId, VerificationRunDetail, VerificationRunSummary } from '../../../../packages/domain/src';
import { Icon } from './ui';
import { ProjectGitPanel } from './ProjectGitPanel';

export function GitPanel({ sessionId, project, running, onChanged, documents, jiraUrl }: { sessionId: string; project: Project; running: boolean; onChanged: () => Promise<void>; documents: ManagedDocument[]; jiraUrl?: string }) {
  const api = window.jinggong;
  const [state, setState] = useState<GitState | null>(null);
  const [message, setMessage] = useState('');
  const [remote, setRemote] = useState('');
  const [pullRemote, setPullRemote] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [requirements, setRequirements] = useState<RequirementResult[]>([]);
  const [reviewed, setReviewed] = useState<string[]>([]);
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState('');
  const [projectBusy, setProjectBusy] = useState(false);
  const [error, setError] = useTransientError();
  const [notice, setNotice] = useState('');
  const [verificationRuns, setVerificationRuns] = useState<VerificationRunSummary[]>([]);
  const [verificationBusy, setVerificationBusy] = useState(false);
  const [verificationPending, setVerificationPending] = useState(false);
  const [activeVerificationRun, setActiveVerificationRun] = useState('');
  const [verificationReport, setVerificationReport] = useState<VerificationRunDetail | null>(null);
  const [verificationArtifact, setVerificationArtifact] = useState('');
  const [verificationError, setVerificationError] = useTransientError();
  const current = useRef(sessionId);
  current.current = sessionId;
  const blocked = requirements.some(item => item.status === 'fail');
  const missingReview = requirements.some(item => item.status === 'review' && !reviewed.includes(item.documentId));
  const disabled = !!pending || projectBusy || running || verificationBusy || verificationPending;
  async function load() {
    const next = await api.getGitState(sessionId);
    if (current.current !== sessionId) return;
    setState(next);
    setRemote(value => next.remotes.includes(value) ? value : next.remotes[0] || '');
    setPullRemote(value => next.remotes.includes(value) ? value : next.remotes[0] || '');
    return next;
  }
  useEffect(() => {
    let alive = true;
    setState(null); setMessage(''); setRequirements([]); setReviewed([]); setChecked(false); setError(''); setNotice('');
    api.getGitState(sessionId).then(next => { if (alive) { setState(next); setRemote(next.remotes[0] || ''); setPullRemote(next.remotes[0] || ''); } }).catch(reason => alive && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { alive = false; };
  }, [sessionId, api]);
  useEffect(() => {
    let alive = true;
    setVerificationRuns([]); setVerificationBusy(false); setVerificationPending(false); setActiveVerificationRun(''); setVerificationReport(null); setVerificationArtifact(''); setVerificationError('');
    const refresh = () => api.listVerificationRuns(sessionId).then(items => { if (alive && current.current === sessionId) setVerificationRuns(items); }).catch(reason => { if (alive && current.current === sessionId) setVerificationError(reason instanceof Error ? reason.message : String(reason)); });
    void refresh();
    const unsubscribe = api.onVerification(event => {
      if (!alive || event.sessionId !== sessionId || current.current !== sessionId) return;
      if (event.state === 'started') { setVerificationBusy(true); setActiveVerificationRun(event.runId); }
      else {
        setVerificationBusy(false); setActiveVerificationRun('');
        void refresh();
        if (event.status === 'passed') setNotice('真实验证已通过，证据报告已保存。');
        else if (event.status) setNotice(`真实验证结束：${verificationStatusLabel(event.status)}。`);
      }
    });
    return () => { alive = false; unsubscribe(); };
  }, [sessionId, api]);
  const documentVersion = documents.map(item => `${item.id}:${item.digest}:${item.enabled}`).join('|');
  useEffect(() => { setChecked(false); setReviewed([]); setRequirements([]); }, [documentVersion, running]);
  useEffect(() => {
    if (!running) void load().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [running]);
  async function act(action: string, work: () => Promise<void>) {
    setPending(action); setError(''); setNotice('');
    try { await work(); }
    catch (reason) { if (current.current === sessionId) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current.current === sessionId) setPending(''); }
  }
  async function startVerification(profileId: VerificationProfileId) {
    setVerificationPending(true); setVerificationError(''); setVerificationArtifact('');
    try {
      const { runId } = await api.startVerification(sessionId, profileId);
      if (current.current !== sessionId) return;
      setActiveVerificationRun(runId); setVerificationBusy(true);
      setNotice(profileId === 'tests' ? '测试已启动，等待真实命令结果。' : '类型检查已启动，等待真实命令结果。');
    } catch (reason) { if (current.current === sessionId) setVerificationError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current.current === sessionId) setVerificationPending(false); }
  }
  async function cancelVerification() {
    if (!activeVerificationRun) return;
    setVerificationError('');
    try { await api.cancelVerification(sessionId, activeVerificationRun); setNotice('已请求取消验证，正在等待进程退出并保存报告。'); }
    catch (reason) { setVerificationError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function openVerificationRun(runId: string) {
    setVerificationError(''); setVerificationArtifact('');
    try { const detail = await api.getVerificationRun(sessionId, runId); if (current.current === sessionId) setVerificationReport(detail); }
    catch (reason) { if (current.current === sessionId) setVerificationError(reason instanceof Error ? reason.message : String(reason)); }
  }
  async function openVerificationArtifact(runId: string, artifact: 'stdout.log' | 'stderr.log') {
    setVerificationError('');
    try { const output = await api.readVerificationArtifact(sessionId, runId, artifact); if (current.current === sessionId) setVerificationArtifact(output || '（文件为空）'); }
    catch (reason) { if (current.current === sessionId) setVerificationError(reason instanceof Error ? reason.message : String(reason)); }
  }
  return <div className="git-panel" aria-label="Git 管理">
    <ProjectGitPanel sessionId={sessionId} project={project} disabled={disabled} onBusyChange={setProjectBusy} onChanged={onChanged} />
    <div className="git-section-label">会话工作区<span>隔离分支</span></div>
    <div className="git-panel-heading"><span><Icon name="branch" />{state?.branch || '读取分支中…'}</span><button className="icon-button" aria-label="刷新 Git 状态" disabled={disabled} onClick={() => act('refresh', async () => { await load(); setChecked(false); setReviewed([]); await onChanged(); })}><Icon name="refresh" /></button></div>
    {error && <div className="form-error" role="alert"><Icon name="alert" />{error}</div>}{notice && <div className="settings-notice" role="status"><Icon name="check" />{notice}</div>}
    <section className="verification-section" aria-label="真实验证证据">
      <div className="git-section-label">真实验证证据<span>{verificationBusy ? '执行中' : `${verificationRuns.length} 条历史记录`}</span></div>
      <p className="git-hint">由桌面主进程执行固定的类型检查或测试命令并采集结果；Agent 文本不作为验证证据。</p>
      {verificationError && <div className="form-error" role="alert"><Icon name="alert" />{verificationError}</div>}
      <div className="verification-actions">
        <button className="secondary-button" disabled={disabled} onClick={() => void startVerification('typecheck')}>{verificationPending ? '正在启动…' : '运行类型检查'}</button>
        <button className="secondary-button" disabled={disabled} onClick={() => void startVerification('tests')}>{verificationPending ? '正在启动…' : '运行测试'}</button>
        {verificationBusy && <button className="text-button" disabled={verificationPending} onClick={() => void cancelVerification()}>取消验证</button>}
      </div>
      {verificationRuns.length > 0 && <div className="verification-history" aria-label="验证历史">{verificationRuns.map(run => <button className={`verification-history-item${verificationReport?.summary.runId === run.runId ? ' selected' : ''}`} key={run.runId} onClick={() => void openVerificationRun(run.runId)}><span><strong>{run.runType === 'test' ? '测试' : '类型检查'}</strong><em className={`verification-status status-${run.status}`}>{verificationStatusLabel(run.status)}</em></span><time>{new Date(run.startedAt).toLocaleString('zh-CN')}</time><small>{run.processStatus === 'running' ? '执行中' : `退出码 ${run.exitCode ?? '无'}`} · {Math.round(run.durationMs / 1000)} 秒</small></button>)}</div>}
      {verificationReport && <div className="verification-report"><div className="verification-report-heading"><strong>验证报告</strong><span>{verificationStatusLabel(verificationReport.summary.status)} · {verificationReport.summary.runId.slice(0, 8)}</span></div><div className="verification-artifacts"><button className="text-button" onClick={() => void openVerificationArtifact(verificationReport.summary.runId, 'stdout.log')}>查看标准输出</button><button className="text-button" onClick={() => void openVerificationArtifact(verificationReport.summary.runId, 'stderr.log')}>查看错误输出</button></div><pre>{verificationArtifact || verificationReport.markdown}</pre></div>}
      {verificationBusy && <p className="git-hint">运行 ID：{activeVerificationRun || '正在分配'}。验证完成后会自动保存历史报告。</p>}
      {!verificationRuns.length && !verificationBusy && <p className="git-hint">尚无真实验证记录。</p>}
    </section>
    <div className="git-commit-section"><div className="git-section-label">提交本地修改<span>{state ? state.dirty ? '有未提交变更' : '没有未提交修改' : '正在读取'}</span></div>
      <button className="secondary-button generate-message" disabled={disabled || !state?.dirty} onClick={() => act('generate', async () => { const value = await api.generateCommitMessage(sessionId); if (current.current === sessionId) setMessage(value); })}><Icon name="file" />{pending === 'generate' ? '正在分析真实 Diff…' : '根据 Diff 生成提交说明'}</button>
      <label htmlFor="commit-message">提交说明</label><textarea id="commit-message" aria-label="提交说明" value={message} onChange={e => setMessage(e.target.value)} rows={3} maxLength={4000} disabled={disabled} placeholder="输入或生成中文提交说明" />
      {jiraUrl && <p className="git-hint">提交时自动附加 Jira 地址：{jiraUrl}</p>}
      <details className="author-settings"><summary>提交作者（可选）</summary><label htmlFor="commit-author-name">作者姓名</label><input id="commit-author-name" value={authorName} onChange={e => setAuthorName(e.target.value)} disabled={disabled} placeholder="留空使用 Git 配置" /><label htmlFor="commit-author-email">作者邮箱</label><input id="commit-author-email" type="email" value={authorEmail} onChange={e => setAuthorEmail(e.target.value)} disabled={disabled} placeholder="留空使用 Git 配置" /></details>
      <div className="requirement-heading"><strong>开发要求检查</strong><button className="text-button" disabled={disabled || !state?.dirty} onClick={() => act('check', async () => { const result = await api.checkRequirements(sessionId); if (current.current !== sessionId) return; setRequirements(result); setReviewed([]); setChecked(true); })}>{pending === 'check' ? '正在检查…' : checked ? '重新检查' : '检查开发要求'}</button></div>
      {!checked && <p className="git-hint">提交前执行机器规则检查，并逐份确认需要人工审核的开发要求。</p>}
      {checked && !requirements.length && <p className="git-hint">当前没有启用的开发要求。请确认本次变更符合项目约定。</p>}
      <div className="requirement-results">{requirements.map(item => <div key={item.documentId} className={`requirement-result result-${item.status}`}><div><span className="result-badge">{item.status === 'pass' ? '通过' : item.status === 'fail' ? '阻断' : '待人工审核'}</span><strong>{item.name}</strong></div>{item.details.map((detail, index) => <p key={index}>{detail}</p>)}{documents.find(doc => doc.id === item.documentId) && <details className="requirement-original"><summary>查看开发要求原文</summary><pre>{documents.find(doc => doc.id === item.documentId)?.content}</pre></details>}{item.status === 'review' && <label className="review-checkbox"><input type="checkbox" checked={reviewed.includes(item.documentId)} disabled={disabled} onChange={e => setReviewed(value => e.target.checked ? [...value, item.documentId] : value.filter(id => id !== item.documentId))} />我已逐项核对“{item.name}”</label>}</div>)}</div>
      <button className="primary-button git-submit" disabled={disabled || !state?.dirty || !message.trim() || !checked || blocked || missingReview} onClick={() => act('commit', async () => { const hash = await api.commitChanges(sessionId, { message: message.trim(), reviewedDocumentIds: reviewed, ...(authorName.trim() ? { authorName: authorName.trim() } : {}), ...(authorEmail.trim() ? { authorEmail: authorEmail.trim() } : {}) }); if (current.current !== sessionId) return; setNotice(`已提交：${hash.slice(0, 12)}`); setMessage(''); setChecked(false); setRequirements([]); setReviewed([]); await load(); await onChanged(); })}><Icon name="check" />{pending === 'commit' ? '正在提交…' : '审核并提交'}</button>
      {blocked && <p className="git-hint blocked-hint">存在阻断项，请修复后重新检查。</p>}
      <p className="git-hint">提交和推送需要您在系统确认框中再次确认；拉取会自动执行快进检查。</p>
    </div>
    <div className="git-push-section"><div className="git-section-label">推送当前分支</div><div className="push-controls"><select aria-label="推送远程仓库" value={remote} onChange={e => setRemote(e.target.value)} disabled={disabled || !state?.remotes.length}>{!state?.remotes.length && <option value="">未配置远程仓库</option>}{state?.remotes.map(value => <option key={value}>{value}</option>)}</select><button className="secondary-button" disabled={disabled || !remote || !state || state.dirty} title={state?.dirty ? '请先提交本地修改' : '推送当前会话分支'} onClick={() => act('push', async () => { await api.pushChanges(sessionId, remote); if (current.current !== sessionId) return; setNotice('当前分支已推送。'); await load(); })}><Icon name="arrow" />{pending === 'push' ? '推送中…' : '推送分支'}</button></div></div>
    <div className="git-push-section"><div className="git-section-label">拉取当前分支</div><div className="push-controls"><select aria-label="拉取远程仓库" value={pullRemote} onChange={e => setPullRemote(e.target.value)} disabled={disabled || !state?.remotes.length}>{!state?.remotes.length && <option value="">未配置远程仓库</option>}{state?.remotes.map(value => <option key={value}>{value}</option>)}</select><button className="secondary-button" disabled={disabled || !pullRemote || !state || state.dirty} title={state?.dirty ? '请先提交本地修改' : '快进拉取远程同名 Agent 分支'} onClick={() => act('pull', async () => { await api.pullChanges(sessionId, pullRemote); if (current.current !== sessionId) return; setNotice('已快进拉取远程同名 Agent 分支。'); setChecked(false); setReviewed([]); setRequirements([]); await load(); await onChanged(); })}><Icon name="download" />{pending === 'pull' ? '拉取中…' : '拉取分支'}</button></div><p className="git-hint">仅从 {pullRemote || '所选远程'}/{state?.branch || '当前 Agent 分支'} 快进更新（ff-only）。分支出现分歧时会停止，请人工处理。</p></div>
    <div className="git-history"><div className="git-section-label">提交历史<span>{state?.commits.length || 0} 条</span></div>{state && !state.commits.length && <p className="git-hint">暂无提交历史。</p>}{state?.commits.map(commit => <article className="commit-entry" key={commit.hash}><span className="commit-point" /><div><strong>{commit.message}</strong><p><code title={commit.hash}>{commit.shortHash}</code><span>{commit.author}</span></p><time>{new Date(commit.date).toLocaleString('zh-CN')}</time></div></article>)}</div>
  </div>;
}

function verificationStatusLabel(status: VerificationRunSummary['status']): string {
  return status === 'passed' ? '通过' : status === 'failed' ? '失败' : status === 'stale' ? '证据已过期' : status === 'not_run' ? '未执行' : '无法判定';
}

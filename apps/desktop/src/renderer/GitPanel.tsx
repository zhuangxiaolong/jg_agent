import { useTransientError } from './use-transient-error';
import { useEffect, useRef, useState } from 'react';
import type { GitState, Project } from '../../../../packages/domain/src';
import { Icon } from './ui';

export function GitPanel({ sessionId, project, running, onChanged, jiraUrl }: { sessionId: string; project: Project; running: boolean; onChanged: () => Promise<void>; jiraUrl?: string }) {
  const api = window.jinggong;
  const [state, setState] = useState<GitState | null>(null);
  const [message, setMessage] = useState('');
  const [remote, setRemote] = useState('');
  const [pullRemote, setPullRemote] = useState('');
  const [authorName, setAuthorName] = useState('');
  const [authorEmail, setAuthorEmail] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useTransientError();
  const [notice, setNotice] = useState('');
  const current = useRef(sessionId);
  current.current = sessionId;
  const disabled = !!pending || running;
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
    setState(null); setMessage(''); setError(''); setNotice('');
    api.getGitState(sessionId).then(next => { if (alive) { setState(next); setRemote(next.remotes[0] || ''); setPullRemote(next.remotes[0] || ''); } }).catch(reason => alive && setError(reason instanceof Error ? reason.message : String(reason)));
    return () => { alive = false; };
  }, [sessionId, api]);
  useEffect(() => {
    if (!running) void load().catch(reason => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [running]);
  async function act(action: string, work: () => Promise<void>) {
    setPending(action); setError(''); setNotice('');
    try { await work(); }
    catch (reason) { if (current.current === sessionId) setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { if (current.current === sessionId) setPending(''); }
  }
  async function submit(push: boolean) {
    await act(push ? 'commit-push' : 'commit', async () => {
      let hash = '';
      try {
        hash = await api.commitChanges(sessionId, { message: message.trim(), ...(authorName.trim() ? { authorName: authorName.trim() } : {}), ...(authorEmail.trim() ? { authorEmail: authorEmail.trim() } : {}) });
        if (current.current !== sessionId) return;
        setNotice(`已提交：${hash.slice(0, 12)}`); setMessage('');
        await load(); await onChanged();
        if (push) {
          await api.pushChanges(sessionId, remote);
          if (current.current !== sessionId) return;
          setNotice(`已提交并推送：${hash.slice(0, 12)}`); await load();
        }
      } catch (reason) {
        if (hash) throw new Error(`本地提交 ${hash.slice(0, 12)} 已完成；${push ? '推送未完成' : '状态刷新未完成'}：${reason instanceof Error ? reason.message : String(reason)}${push ? '。可点击“推送分支”重试，无需重复提交。' : ''}`);
        throw reason;
      }
    });
  }
  return <div className="git-panel" aria-label="Git 管理">
    <p className="git-hint">提交本会话变更；存在原有代码依赖时，连同相关文件在会话快照中的完整内容提交（含任务前的未提交修改）。无关文件保持原样。</p>
    <div className="git-section-label">项目目录<span>当前分支</span></div>
    <div className="git-panel-heading"><span><Icon name="branch" />{state?.branch || '读取分支中…'}</span><button className="icon-button" aria-label="刷新 Git 状态" disabled={disabled} onClick={() => act('refresh', async () => { await load(); await onChanged(); })}><Icon name="refresh" /></button></div>
    {error && <div className="form-error" role="alert"><Icon name="alert" />{error}</div>}{notice && <div className="settings-notice" role="status"><Icon name="check" />{notice}</div>}
    <div className="git-commit-section"><div className="git-section-label">提交本地修改<span>{state ? state.dirty ? '有未提交变更' : '没有未提交修改' : '正在读取'}</span></div>
      <button className="secondary-button generate-message" disabled={disabled || !state?.dirty} onClick={() => act('generate', async () => { const value = await api.generateCommitMessage(sessionId); if (current.current === sessionId) setMessage(value); })}><Icon name="file" />{pending === 'generate' ? '正在分析真实 Diff…' : '根据 Diff 生成提交说明'}</button>
      <label htmlFor="commit-message">提交说明</label><textarea id="commit-message" aria-label="提交说明" value={message} onChange={e => setMessage(e.target.value)} rows={3} maxLength={4000} disabled={disabled} placeholder="输入或生成中文提交说明" />
      {jiraUrl && <p className="git-hint">提交时自动附加 Jira 地址：{jiraUrl}</p>}
      <details className="author-settings"><summary>提交作者（可选）</summary><label htmlFor="commit-author-name">作者姓名</label><input id="commit-author-name" value={authorName} onChange={e => setAuthorName(e.target.value)} disabled={disabled} placeholder="留空使用 Git 配置" /><label htmlFor="commit-author-email">作者邮箱</label><input id="commit-author-email" type="email" value={authorEmail} onChange={e => setAuthorEmail(e.target.value)} disabled={disabled} placeholder="留空使用 Git 配置" /></details>
      <div className="git-commit-actions">
        <button className="primary-button git-submit git-commit-only" disabled={disabled || !state?.dirty || !message.trim()} onClick={() => void submit(false)}><Icon name="check" />{pending === 'commit' ? '正在提交…' : '提交代码'}</button>
        <button className="primary-button git-submit git-commit-push" disabled={disabled || !state?.dirty || !message.trim() || !remote} title={remote ? `提交后推送到 ${remote}/${state?.branch || '当前分支'}` : '请先配置并选择推送远程仓库'} onClick={() => void submit(true)}><Icon name="arrow" />{pending === 'commit-push' ? '提交并推送中…' : '提交并推送'}</button>
      </div>
      <p className="git-hint">点击即执行提交或提交并推送；拉取会自动执行快进检查。</p>
    </div>
    <div className="git-push-section"><div className="git-section-label">推送当前分支</div><div className="push-controls"><select aria-label="推送远程仓库" value={remote} onChange={e => setRemote(e.target.value)} disabled={disabled || !state?.remotes.length}>{!state?.remotes.length && <option value="">未配置远程仓库</option>}{state?.remotes.map(value => <option key={value}>{value}</option>)}</select><button className="secondary-button" disabled={disabled || !remote || !state || state.dirty} title={state?.dirty ? '请先提交本地修改' : '推送当前会话分支'} onClick={() => act('push', async () => { await api.pushChanges(sessionId, remote); if (current.current !== sessionId) return; setNotice('当前分支已推送。'); await load(); })}><Icon name="arrow" />{pending === 'push' ? '推送中…' : '推送分支'}</button></div></div>
    <div className="git-push-section"><div className="git-section-label">拉取当前分支</div><div className="push-controls"><select aria-label="拉取远程仓库" value={pullRemote} onChange={e => setPullRemote(e.target.value)} disabled={disabled || !state?.remotes.length}>{!state?.remotes.length && <option value="">未配置远程仓库</option>}{state?.remotes.map(value => <option key={value}>{value}</option>)}</select><button className="secondary-button" disabled={disabled || !pullRemote || !state || state.dirty} title={state?.dirty ? '请先提交本地修改' : '快进拉取远程同名 Agent 分支'} onClick={() => act('pull', async () => { await api.pullChanges(sessionId, pullRemote); if (current.current !== sessionId) return; setNotice('已快进拉取远程同名 Agent 分支。'); await load(); await onChanged(); })}><Icon name="download" />{pending === 'pull' ? '拉取中…' : '拉取分支'}</button></div><p className="git-hint">仅从 {pullRemote || '所选远程'}/{state?.branch || '当前 Agent 分支'} 快进更新（ff-only）。分支出现分歧时会停止，请人工处理。</p></div>
    <div className="git-history"><div className="git-section-label">提交历史<span>{state?.commits.length || 0} 条</span></div>{state && !state.commits.length && <p className="git-hint">暂无提交历史。</p>}{state?.commits.map(commit => <article className="commit-entry" key={commit.hash}><span className="commit-point" /><div><strong>{commit.message}</strong><p><code title={commit.hash}>{commit.shortHash}</code><span>{commit.author}</span></p><time>{new Date(commit.date).toLocaleString('zh-CN')}</time></div></article>)}</div>
  </div>;
}

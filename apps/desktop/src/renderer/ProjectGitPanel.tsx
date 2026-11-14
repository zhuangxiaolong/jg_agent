import { useTransientError } from './use-transient-error';
import { useEffect, useRef, useState } from 'react';
import type { GitState, Project } from '../../../../packages/domain/src';
import { Icon } from './ui';
import './project-git.css';

export function ProjectGitPanel({ sessionId, project, disabled, onBusyChange, onChanged }: {
  sessionId?: string; project: Project; disabled: boolean;
  onBusyChange?: (busy: boolean) => void; onChanged: () => Promise<void>;
}) {
  const api = window.jinggong;
  const [state, setState] = useState<GitState | null>(null);
  const [remote, setRemote] = useState('');
  const [pending, setPending] = useState('');
  const [error, setError] = useTransientError();
  const [notice, setNotice] = useState('');
  const alive = useRef(false);
  const busy = useRef(false);
  const revision = useRef(0);
  const target = sessionId || { projectId: project.id };

  async function load() {
    const request = ++revision.current;
    const next = await api.getProjectGitState(target);
    if (!alive.current || request !== revision.current) return;
    setState(next);
    setRemote(value => next.remotes.includes(value) ? value : next.remotes.includes('origin') ? 'origin' : next.remotes[0] || '');
  }
  useEffect(() => {
    let active = true;
    alive.current = true;
    void load().catch(reason => { if (active && alive.current) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; alive.current = false; revision.current += 1; };
  }, [sessionId, project.id]);

  async function act(action: string, work?: () => Promise<void>) {
    if (disabled || busy.current) return;
    busy.current = true; setPending(action); onBusyChange?.(true); setError(''); setNotice('');
    try {
      await work?.();
      if (alive.current && work) setNotice(action === 'fetch' ? '已获取项目远程更新。' : action === 'pull' ? '项目代码已快进拉取。' : '项目当前分支已推送。');
      if (alive.current) await onChanged();
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      // 失败和取消后同样重读状态，避免继续使用操作前的分支信息。
      if (alive.current) {
        try { await load(); }
        catch (reason) { if (alive.current) { setState(null); setError(reason instanceof Error ? reason.message : String(reason)); } }
      }
      busy.current = false;
      if (alive.current) { setPending(''); onBusyChange?.(false); }
    }
  }

  const locked = disabled || !!pending;
  const unavailable = locked || !state || !remote;
  const detached = state?.branch === '(detached)';
  return <section className="project-git-section" aria-label="项目仓库 Git" aria-busy={!!pending}>
    <div className="git-panel-heading"><strong>项目仓库</strong><button className="icon-button" aria-label="刷新项目 Git 状态" title="刷新项目 Git 状态" disabled={locked} onClick={() => void act('refresh')}><Icon name="refresh" /></button></div>
    <div className="project-git-context"><strong>{project.name}</strong><code title={project.path}>{project.path}</code><span><Icon name="branch" />{state?.branch || (error ? '项目分支暂不可用' : '读取项目分支中…')}{state && <small>{state.dirty ? '有未提交变更' : '工作目录干净'}</small>}</span></div>
    {error && <div className="form-error" role="alert"><Icon name="alert" />{error}</div>}
    {notice && <div className="settings-notice" role="status"><Icon name="check" />{notice}</div>}
    <div className="push-controls"><select aria-label="项目远程仓库" value={remote} onChange={event => setRemote(event.target.value)} disabled={locked || !state?.remotes.length}>{!state?.remotes.length && <option value="">{state ? '未配置远程仓库' : '读取远程仓库…'}</option>}{state?.remotes.map(value => <option key={value}>{value}</option>)}</select><button className="secondary-button" disabled={unavailable} onClick={() => void act('fetch', () => api.fetchProjectChanges(target, remote))}><Icon name="refresh" />{pending === 'fetch' ? '获取中…' : '获取远程更新'}</button></div>
    <div className="project-git-actions"><button className="secondary-button" disabled={unavailable || state?.dirty || detached} title={state?.dirty ? '请先提交或整理项目目录的本地修改' : detached ? '请先在项目仓库检出本地分支' : `快进拉取 ${remote}/${state?.branch || ''} 到项目目录`} onClick={() => void act('pull', () => api.pullProjectChanges(target, remote))}><Icon name="download" />{pending === 'pull' ? '拉取中…' : '拉取项目代码'}</button><button className="secondary-button" disabled={unavailable || state?.dirty || detached} title={state?.dirty ? '请先提交或整理项目目录的本地修改' : detached ? '请先在项目仓库检出本地分支' : `推送项目当前分支到 ${remote}/${state?.branch || ''}`} onClick={() => void act('push', () => api.pushProjectChanges(target, remote))}><Icon name="arrow" />{pending === 'push' ? '推送中…' : '推送项目分支'}</button></div>
    <p className="git-hint">操作上方项目目录的实际当前分支。拉取仅接受快进更新；推送前需确认。项目会话直接使用此目录，Git 状态实时同步。</p>
    {state?.dirty && <p className="git-hint blocked-hint">项目有未提交变更，可先获取远程更新；整理本地修改后再拉取或推送。</p>}
    {detached && <p className="git-hint blocked-hint">项目处于分离 HEAD 状态，请先在项目仓库检出本地分支。</p>}
    <details className="project-git-history"><summary>项目提交历史（{state?.commits.length || 0} 条）</summary>{state?.commits.map(commit => <article className="commit-entry" key={commit.hash}><span className="commit-point" /><div><strong>{commit.message}</strong><p><code title={commit.hash}>{commit.shortHash}</code><span>{commit.author}</span></p><time>{new Date(commit.date).toLocaleString('zh-CN')}</time></div></article>)}</details>
  </section>;
}

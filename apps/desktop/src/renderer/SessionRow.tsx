import { useTransientError } from './use-transient-error';
import { useState, type FormEvent } from 'react';
import type { RuntimeKind, Session, SessionStatus } from '../../../../packages/domain/src';
import { readableError } from './dictionary-index';
import { Icon } from './ui';
import { useRowActions } from './RowActionsMenu';
import { sessionDisplayName } from './branding';

const runtimeLabels: Record<RuntimeKind, string> = {
  jinggong: 'JG',
  claude_agent_sdk: 'claude',
  codex: 'codex',
};

function runtimeLabel(value?: RuntimeKind): string {
  return runtimeLabels[value ?? 'codex'];
}

export function SessionRow({ session, status, running, selected, disabled, unread, onSelect, onRenamed, onDeleted }: {
  session: Session; status: SessionStatus; running: boolean; selected: boolean; disabled: boolean; unread: boolean; onSelect: () => void; onRenamed: () => Promise<void>; onDeleted: () => Promise<void>;
}) {
  const display = sessionDisplayName(session);
  const [editing, setEditing] = useState(false), [alias, setAlias] = useState(session.alias || '');
  const [pending, setPending] = useState(false), [error, setError] = useTransientError();
  const actions = useRowActions({ kind: '会话', name: display, disabled: disabled || pending, onRename: () => { setAlias(session.alias || ''); setError(''); setEditing(true); }, onDelete: () => { void remove(); } });
  async function save(event: FormEvent) {
    event.preventDefault(); setPending(true); setError('');
    try { await window.jinggong.renameSession(session.id, alias.trim()); await onRenamed(); setEditing(false); }
    catch (reason) { setError(readableError(reason)); }
    finally { setPending(false); }
  }
  async function remove() {
    if (pending) return;
    if (!window.confirm(`确认删除会话“${display}”？\n\n会话及消息记录将被删除，代码文件会保留。`)) return;
    setPending(true); setError('');
    try { await window.jinggong.deleteSession(session.id); await onDeleted(); }
    catch (reason) { setError(readableError(reason)); }
    finally { setPending(false); }
  }
  return <div className="session-row" onContextMenu={editing ? undefined : actions.onContextMenu} onKeyDown={editing ? undefined : actions.onKeyDown}>
    {editing ? <form className="project-rename-form session-rename-form" onSubmit={save}><input aria-label="会话别名" value={alias} onChange={event => setAlias(event.target.value)} autoFocus maxLength={100} disabled={pending} placeholder={sessionDisplayName({ title: session.title, titleSource: session.titleSource, jiraIssue: session.jiraIssue })} onKeyDown={event => { if (event.key === 'Escape' && !pending) setEditing(false); }} /><div><span>留空恢复默认标题。</span><button className="icon-button" type="submit" disabled={pending} aria-label="保存会话别名"><Icon name="check" /></button><button className="icon-button" type="button" disabled={pending} onClick={() => setEditing(false)} aria-label="取消修改会话别名"><Icon name="close" /></button></div>{error && <p role="alert">{error}</p>}</form> : <><button className={`session-item ${selected ? 'selected' : ''}`} onClick={onSelect} aria-haspopup="menu" title={`${display} · Runtime ${runtimeLabel(session.runtimeKind)}`}><span className="session-indicator">{running ? <span className="session-spinner" role="status" aria-label="会话进行中" title="会话进行中" /> : <span className={`session-dot ${status}`} />}</span><span className="session-content"><span className="session-name">{display}</span><span className="session-meta"><span className="session-runtime">{runtimeLabel(session.runtimeKind)}</span></span></span>{unread && <span className="completion-dot" aria-label="会话已完成，尚未查看" title="已完成，点击查看" />}<span className="session-time">{new Date(session.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span></button>{error && <span className="row-error" role="alert">{error}</span>}</>}
    {actions.menu}
  </div>;
}

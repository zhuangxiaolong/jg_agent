import { useState, type FormEvent } from 'react';
import type { Session, SessionStatus } from '../../../../packages/domain/src';
import { readableError } from './dictionary-index';
import { Icon } from './ui';

export function SessionRow({ session, status, selected, disabled, onSelect, onRenamed }: {
  session: Session; status: SessionStatus; selected: boolean; disabled: boolean; onSelect: () => void; onRenamed: () => Promise<void>;
}) {
  const display = session.alias ?? session.title;
  const [editing, setEditing] = useState(false), [alias, setAlias] = useState(session.alias || '');
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setPending(true); setError('');
    try { await window.jinggong.renameSession(session.id, alias.trim()); await onRenamed(); setEditing(false); }
    catch (reason) { setError(readableError(reason)); }
    finally { setPending(false); }
  }
  return <div className="session-row">
    {editing ? <form className="project-rename-form session-rename-form" onSubmit={save}><input aria-label="会话别名" value={alias} onChange={event => setAlias(event.target.value)} autoFocus maxLength={100} disabled={pending} placeholder={session.title} onKeyDown={event => { if (event.key === 'Escape' && !pending) setEditing(false); }} /><div><span>留空恢复默认标题。</span><button className="icon-button" type="submit" disabled={pending} aria-label="保存会话别名"><Icon name="check" /></button><button className="icon-button" type="button" disabled={pending} onClick={() => setEditing(false)} aria-label="取消修改会话别名"><Icon name="close" /></button></div>{error && <p role="alert">{error}</p>}</form> : <><button className={`session-item ${selected ? 'selected' : ''}`} onClick={onSelect} title={display}><span className={`session-dot ${status}`} /><span className="session-name">{display}</span><span className="session-time">{new Date(session.createdAt).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })}</span></button><button className="icon-button session-rename-button" disabled={disabled} aria-label={`修改会话别名 ${display}`} title="修改会话别名" onClick={() => { setAlias(session.alias || ''); setError(''); setEditing(true); }}><Icon name="edit" /></button></>}
  </div>;
}

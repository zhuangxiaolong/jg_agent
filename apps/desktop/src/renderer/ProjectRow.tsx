import { useTransientError } from './use-transient-error';
import { useState, type FormEvent } from 'react';
import type { Project } from '../../../../packages/domain/src';
import { readableError } from './dictionary-index';
import { Icon } from './ui';
import { useRowActions } from './RowActionsMenu';

export function ProjectRow({ project, selected, disabled, createDisabled, unread, onSelect, onCreateSession, onRenamed, onDeleted }: {
  project: Project; selected: boolean; disabled: boolean; createDisabled: boolean; unread: boolean; onSelect: () => void; onCreateSession: () => void; onRenamed: () => Promise<void>; onDeleted: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false), [error, setError] = useTransientError();
  const actions = useRowActions({ kind: '项目', name: project.name, disabled: disabled || pending, createDisabled: createDisabled || pending, onCreateSession, onRename: () => { setName(project.name); setError(''); setEditing(true); }, onDelete: () => { void remove(); } });
  async function save(event: FormEvent) {
    event.preventDefault(); setPending(true); setError('');
    try { await window.jinggong.renameProject(project.id, name.trim()); await onRenamed(); setEditing(false); }
    catch (reason) { setError(readableError(reason)); }
    finally { setPending(false); }
  }
  async function remove() {
    if (!window.confirm(`确认删除项目“${project.name}”？项目下必须没有会话，源代码目录不会被删除。`)) return;
    setPending(true); setError('');
    try { await window.jinggong.deleteProject(project.id); await onDeleted(); }
    catch (reason) { setError(readableError(reason)); }
    finally { setPending(false); }
  }
  return <div className="project-row" onContextMenu={editing ? undefined : actions.onContextMenu} onKeyDown={editing ? undefined : actions.onKeyDown}>
    {editing ? <form className="project-rename-form" onSubmit={save}><input aria-label="项目显示名称" value={name} onChange={event => setName(event.target.value)} autoFocus required maxLength={100} disabled={pending} onKeyDown={event => { if (event.key === 'Escape' && !pending) setEditing(false); }} /><div><span>仅修改显示名称，目录保持原样。</span><button className="icon-button" type="submit" disabled={pending || !name.trim()} aria-label="保存项目显示名称"><Icon name="check" /></button><button className="icon-button" type="button" disabled={pending} onClick={() => setEditing(false)} aria-label="取消修改项目名称"><Icon name="close" /></button></div>{error && <p role="alert">{error}</p>}</form> : <><button className={`project-item ${selected ? 'selected' : ''}`} onClick={onSelect} aria-haspopup="menu" aria-expanded={project.collapsed === false} aria-controls={`project-sessions-${project.id}`} title={project.path}><Icon name="folder" /><span>{project.name}</span>{unread && <span className="completion-dot" aria-label="项目有已完成会话" />}<span className={`project-chevron ${project.collapsed === false ? "expanded" : ""}`}><Icon name="chevron" /></span></button>{error && <span className="row-error" role="alert">{error}</span>}</>}
    {actions.menu}
  </div>;
}

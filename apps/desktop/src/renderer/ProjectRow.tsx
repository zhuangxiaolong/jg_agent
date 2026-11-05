import { useState, type FormEvent } from 'react';
import type { Project } from '../../../../packages/domain/src';
import { readableError } from './dictionary-index';
import { Icon } from './ui';

export function ProjectRow({ project, selected, disabled, onSelect, onRenamed }: {
  project: Project; selected: boolean; disabled: boolean; onSelect: () => void; onRenamed: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false), [name, setName] = useState(project.name);
  const [pending, setPending] = useState(false), [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setPending(true); setError('');
    try { await window.jinggong.renameProject(project.id, name.trim()); await onRenamed(); setEditing(false); }
    catch (reason) { setError(readableError(reason)); }
    finally { setPending(false); }
  }
  return <div className="project-row">
    {editing ? <form className="project-rename-form" onSubmit={save}><input aria-label="项目显示名称" value={name} onChange={event => setName(event.target.value)} autoFocus required maxLength={100} disabled={pending} onKeyDown={event => { if (event.key === 'Escape' && !pending) setEditing(false); }} /><div><span>仅修改显示名称，目录保持原样。</span><button className="icon-button" type="submit" disabled={pending || !name.trim()} aria-label="保存项目显示名称"><Icon name="check" /></button><button className="icon-button" type="button" disabled={pending} onClick={() => setEditing(false)} aria-label="取消修改项目名称"><Icon name="close" /></button></div>{error && <p role="alert">{error}</p>}</form> : <><button className={`project-item ${selected ? 'selected' : ''}`} onClick={onSelect} title={project.path}><Icon name="folder" /><span>{project.name}</span><Icon name="chevron" /></button><button className="icon-button project-rename-button" disabled={disabled} aria-label={`修改项目显示名称 ${project.name}`} title="修改显示名称" onClick={() => { setName(project.name); setError(''); setEditing(true); }}><Icon name="edit" /></button></>}
  </div>;
}

import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import type { JiraAssignee } from '../../../../packages/domain/src';
import { readableError } from './dictionary-index';

export function JiraAssigneePicker({ issueKey, projectKey, users, selected, disabled, onChange, onUnresolvedChange }: {
  issueKey: string; projectKey?: string; users: JiraAssignee[]; selected?: JiraAssignee; disabled: boolean;
  onChange: (user: JiraAssignee | undefined) => void; onUnresolvedChange: (unresolved: boolean) => void;
}) {
  const listId = useId(), request = useRef(0);
  const [query, setQuery] = useState(''), [open, setOpen] = useState(false), [loading, setLoading] = useState(false);
  const [results, setResults] = useState(users), [error, setError] = useState(''), [active, setActive] = useState(-1);
  const unresolved = !!query.trim() && !selected;
  useEffect(() => onUnresolvedChange(unresolved), [unresolved, onUnresolvedChange]);
  useEffect(() => {
    const version = ++request.current;
    let current = true;
    setActive(-1); setError('');
    if (selected || !query.trim()) { setResults(users); setLoading(false); return; }
    const keyword = query.trim();
    setResults(users.filter(user => `${user.displayName} ${user.id}`.toLocaleLowerCase().includes(keyword.toLocaleLowerCase())));
    setLoading(true);
    const timer = setTimeout(() => {
      void window.jinggong.searchJiraAssignees(issueKey, keyword, projectKey).then(result => {
        if (current && request.current === version) setResults(result);
      }).catch(error => {
        if (current && request.current === version) { setResults([]); setError(readableError(error)); }
      }).finally(() => { if (current && request.current === version) setLoading(false); });
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [query, selected, users, issueKey, projectKey]);
  function choose(user?: JiraAssignee) {
    request.current++; onChange(user); setQuery(user?.displayName ?? ''); setLoading(false); setError(''); setOpen(false); setActive(-1);
  }
  function key(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); return; }
    if (event.key === 'Enter' && open) { event.preventDefault(); if (!loading && active >= 0 && results[active]) choose(results[active]); return; }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault(); setOpen(true);
    if (!results.length || loading) return;
    setActive(index => event.key === 'ArrowDown' ? (index + 1) % results.length : index <= 0 ? results.length - 1 : index - 1);
  }
  useEffect(() => { if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' }); }, [active, listId]);
  return <div className="assignee-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false); }}>
    <label htmlFor={`${listId}-input`}>经办人</label>
    <div className="assignee-search-input"><input id={`${listId}-input`} aria-label="搜索经办人" role="combobox" aria-autocomplete="list" aria-expanded={open && !disabled} aria-controls={listId} aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined} autoComplete="off" value={query} maxLength={100} placeholder="输入姓名或账号搜索" disabled={disabled} onFocus={() => setOpen(true)} onChange={event => { request.current++; setQuery(event.target.value); onChange(undefined); setOpen(true); }} onKeyDown={key} />{(query || selected) && <button type="button" className="icon-button" aria-label="清除经办人选择" title="保持当前经办人" disabled={disabled} onClick={() => choose()}>×</button>}</div>
    {selected ? <small className="assignee-selection">已选择：{selected.displayName} · {selected.id}</small> : !query.trim() ? <small className="assignee-selection">不选择则保持当前经办人</small> : <small className="assignee-selection">请从搜索结果中选择经办人</small>}
    {open && !disabled && <div className="assignee-search-results"><div id={listId} role="listbox" aria-label="经办人搜索结果" aria-busy={loading}>
      {!loading && !error && results.map((user, index) => <button id={`${listId}-${index}`} key={`${user.field}:${user.id}`} type="button" role="option" tabIndex={-1} aria-selected={selected?.id === user.id && selected.field === user.field} className={active === index ? 'active' : ''} onMouseDown={event => event.preventDefault()} onClick={() => choose(user)}><strong>{user.displayName}</strong><span>{user.id}</span></button>)}
    </div>{loading ? <div className="assignee-search-message" role="status">正在搜索经办人…</div> : error ? <div className="assignee-search-message" role="alert">{error}</div> : !results.length ? <div className="assignee-search-message" role="status">未找到可分配的经办人，请更换姓名或账号。</div> : <div className="assignee-search-message">{query.trim() && !selected ? `找到 ${results.length} 人` : '输入姓名或账号查找更多人员'}</div>}</div>}
  </div>;
}

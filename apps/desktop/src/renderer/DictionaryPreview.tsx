import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { findOccurrences, indexDictionary, pageForOffset } from './dictionary-index';

const number = (value: number) => value.toLocaleString('zh-CN');
export function DictionaryPreview({ name, content }: { name: string; content: string }) {
  const { sections, pages } = useMemo(() => indexDictionary(content, /\.xlsx$/i.test(name)), [content, name]);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageInput, setPageInput] = useState('1');
  const [searchInput, setSearchInput] = useState('');
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const previewRef = useRef<HTMLPreElement>(null);
  const matches = useMemo(() => findOccurrences(content, query), [content, query]);
  const current = pages[Math.min(pageIndex, pages.length - 1)];
  const excerpt = content.slice(current.start, current.end);
  const selectedMatch = query ? matches[activeMatch] : undefined;
  const highlighted = selectedMatch !== undefined && selectedMatch >= current.start && selectedMatch < current.end;
  const highlightStart = highlighted ? selectedMatch - current.start : 0;
  const highlightEnd = highlighted ? Math.min(highlightStart + query.length, excerpt.length) : 0;
  useEffect(() => { setPageInput(String(pageIndex + 1)); }, [pageIndex]);
  useEffect(() => {
    const preview = previewRef.current;
    if (!preview) return;
    preview.scrollTop = 0;
    const mark = preview.querySelector('mark');
    if (mark) preview.scrollTop = mark.getBoundingClientRect().top - preview.getBoundingClientRect().top - 35;
  }, [pageIndex, activeMatch, query]);
  function find(event: FormEvent) {
    event.preventDefault();
    const value = searchInput.trim();
    setQuery(value); setActiveMatch(0);
    const index = value ? content.indexOf(value) : -1;
    if (index >= 0) setPageIndex(pageForOffset(pages, index));
  }
  function match(index: number) { setActiveMatch(index); setPageIndex(pageForOffset(pages, matches[index])); }
  function jump(event: FormEvent) {
    event.preventDefault();
    const page = Number(pageInput);
    if (Number.isSafeInteger(page) && page >= 1 && page <= pages.length) setPageIndex(page - 1);
    else setPageInput(String(pageIndex + 1));
  }
  return <div className="dictionary-reader">
    <div className="dictionary-summary">全文已保存：{number(content.length)} 字符 · {sections.length} 个{sections.length > 1 || /\.xlsx$/i.test(name) ? '工作表/章节' : '章节'} · {number(pages.length)} 页</div>
    <div className="dictionary-sheet-select"><label htmlFor="dictionary-sheet">工作表/章节</label><select id="dictionary-sheet" aria-label="字典工作表" value={current.section} onChange={event => { const section = Number(event.target.value); setPageIndex(pages.findIndex(page => page.section === section)); }}>{sections.map((section, index) => <option key={index} value={index}>{section.name}</option>)}</select></div>
    <form className="dictionary-search" onSubmit={find}><input aria-label="字典全文关键词" value={searchInput} onChange={event => setSearchInput(event.target.value)} maxLength={256} placeholder="检索全文中的表名、字段或关键词" /><button type="submit" className="secondary-button">全文检索</button>{query && <button type="button" className="text-button" onClick={() => { setQuery(''); setSearchInput(''); setActiveMatch(0); }}>清除</button>}</form>
    {query && <div className="dictionary-search-status" role="status"><span>{matches.length ? `全文找到 ${number(matches.length)} 处，当前第 ${number(activeMatch + 1)} 处` : '全文未找到匹配内容'}</span><button type="button" className="text-button" disabled={!matches.length || activeMatch === 0} onClick={() => match(activeMatch - 1)}>上个匹配</button><button type="button" className="text-button" disabled={!matches.length || activeMatch >= matches.length - 1} onClick={() => match(activeMatch + 1)}>下个匹配</button></div>}
    <div className="dictionary-page-meta" aria-live="polite">第 {number(pageIndex + 1)} / {number(pages.length)} 页 · 显示全文第 {number(current.start + (current.end > current.start ? 1 : 0))}–{number(current.end)} 字符</div>
    <pre ref={previewRef} aria-label="文档内容预览" data-page-start={current.start} data-page-end={current.end}>{highlighted ? <>{excerpt.slice(0, highlightStart)}<mark>{excerpt.slice(highlightStart, highlightEnd)}</mark>{excerpt.slice(highlightEnd)}</> : excerpt}</pre>
    <div className="dictionary-pagination"><button type="button" className="secondary-button" aria-label="字典首页" disabled={pageIndex === 0} onClick={() => setPageIndex(0)}>首页</button><button type="button" className="secondary-button" aria-label="字典上一页" disabled={pageIndex === 0} onClick={() => setPageIndex(value => value - 1)}>上一页</button><form onSubmit={jump}><input aria-label="跳转到字典页" type="number" min={1} max={pages.length} value={pageInput} onChange={event => setPageInput(event.target.value)} /><button className="text-button" type="submit">跳转</button></form><button type="button" className="secondary-button" aria-label="字典下一页" disabled={pageIndex >= pages.length - 1} onClick={() => setPageIndex(value => value + 1)}>下一页</button><button type="button" className="secondary-button" aria-label="字典末页" disabled={pageIndex >= pages.length - 1} onClick={() => setPageIndex(pages.length - 1)}>末页</button></div>
    <p className="dictionary-reader-note">按全文顺序分页，每页最多 150 行、32,000 字符；所有页面与全文检索均可访问完整内容。</p>
  </div>;
}

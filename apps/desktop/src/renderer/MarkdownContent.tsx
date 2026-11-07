import { createElement, useEffect, useState, type ReactNode } from 'react';
import { Icon } from './ui';

function isDevelopmentWarning(line: string): boolean { return /需求不完整[，,:：、\s]*暂不修改/.test(line); }

function CodeBlock({ code, language }: { code: string; language: string }) {
  const [result, setResult] = useState<{ code: string; status: 'copied' | 'failed' }>();
  const status = result?.code === code ? result.status : 'idle';
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [result]);
  async function copy() {
    try { await window.jinggong.copyText(code); setResult({ code, status: 'copied' }); }
    catch { setResult({ code, status: 'failed' }); }
  }
  return <div className="markdown-code"><div className="markdown-code-toolbar"><span>{language || '代码'}</span><button type="button" className="markdown-code-copy" aria-label="复制代码" title="复制代码" data-copy-status={status} onClick={() => void copy()}><Icon name={status === 'copied' ? 'check' : 'copy'} /><span role="status" aria-live="polite">{status === 'copied' ? '已复制' : status === 'failed' ? '复制失败，请重试' : '复制'}</span></button></div><pre className="markdown-code-content"><code data-language={language || undefined}>{code}</code></pre></div>;
}

function inline(value: string, keyPrefix: string): ReactNode[] {
  const output: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*|https?:\/\/[^\s<>]+|(?:[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]+|(?:\.\.?\/)?(?:[\w.@+-]+\/)+[\w.@+-]+(?:\.[\w.@+-]+)?))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) output.push(value.slice(cursor, index));
    const token = match[0];
    if (token.startsWith('**')) output.push(<strong key={`${keyPrefix}-${index}`}>{token.slice(2, -2)}</strong>);
    else if (token.startsWith('`')) {
      const code = token.slice(1, -1);
      const isPath = /(?:^[A-Za-z]:\\|^\.\.?\/|[\\/])/.test(code) && !/\s/.test(code);
      output.push(<code className={isPath ? 'markdown-path' : undefined} key={`${keyPrefix}-${index}`}>{code}</code>);
    }
    else if (token.startsWith('*')) output.push(<em key={`${keyPrefix}-${index}`}>{token.slice(1, -1)}</em>);
    else if (/^https?:\/\//i.test(token)) {
      const href = token.replace(/[),.;，。；]+$/, '');
      output.push(<a key={`${keyPrefix}-${index}`} href={href} target="_blank" rel="noreferrer">{href}</a>);
      if (href.length < token.length) output.push(token.slice(href.length));
    } else output.push(<code className="markdown-path" key={`${keyPrefix}-${index}`}>{token}</code>);
    cursor = index + token.length;
  }
  if (cursor < value.length) output.push(value.slice(cursor));
  return output;
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index] ?? '';
  return isDevelopmentWarning(line) || /^\s*```/.test(line) || /^#{1,6}\s/.test(line) || /^\s*(?:[-*+]\s+|\d+[.)]\s+)/.test(line) || /^\s*>/.test(line) || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line) || (index + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1]));
}

export function MarkdownContent({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index++; continue; }
    const fence = /^\s*```([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const start = index;
      const code: string[] = [];
      index++;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index++;
      blocks.push(<CodeBlock key={`code-${start}`} code={code.join('\n')} language={fence[1]} />);
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (isDevelopmentWarning(line)) {
      const level = heading ? heading[1].length : 6;
      const title = (heading ? heading[2] : line).replace(/^\s*>\s*/, '').replace(/^\s*[⚠\uFE0F\s]+/, '');
      const details: string[] = [];
      index++;
      while (index < lines.length) {
        const nextHeading = /^(#{1,6})\s+/.exec(lines[index]);
        if (nextHeading && nextHeading[1].length <= level || /^\s*(?:```|---+|___+|\*\*\*+)\s*/.test(lines[index]) || isDevelopmentWarning(lines[index])) break;
        details.push(lines[index++]);
      }
      blocks.push(<section className="markdown-warning" role="alert" aria-label="开发条件警告" key={`warning-${index}`}><div className="markdown-warning-title"><Icon name="alert" />{createElement(heading ? `h${level}` : 'strong', null, ...inline(title, `warning-${index}`))}</div>{details.some(value => value.trim()) && <MarkdownContent text={details.join('\n')} />}</section>);
      continue;
    }
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      blocks.push(createElement(Tag, { className: 'markdown-heading', key: `heading-${index}` }, ...inline(heading[2], `heading-${index}`)));
      index++;
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { blocks.push(<hr key={`rule-${index++}`} />); continue; }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      blocks.push(<blockquote key={`quote-${index}`}>{inline(quote.join(' '), `quote-${index}`)}</blockquote>);
      continue;
    }
    if (index + 1 < lines.length && line.includes('|') && /^\s*\|?\s*:?-{3,}/.test(lines[index + 1])) {
      const cells = (row: string) => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const headers = cells(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) rows.push(cells(lines[index++]));
      blocks.push(<div className="markdown-table-wrap" key={`table-${index}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell, `table-head-${index}-${cellIndex}`)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] || '', `table-${index}-${rowIndex}-${cellIndex}`)}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }
    const listMatch = /^\s*([-*+]\s+|\d+[.)]\s+)(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /^\d/.test(listMatch[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*([-*+]\s+|\d+[.)]\s+)(.+)$/.exec(lines[index]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        items.push(item[2]); index++;
      }
      const List = ordered ? 'ol' : 'ul';
      blocks.push(<List className="markdown-list" key={`list-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item, `list-${index}-${itemIndex}`)}</li>)}</List>);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines, index)) paragraph.push(lines[index++]);
    if (paragraph.length) {
      blocks.push(<p key={`paragraph-${index}`}>{inline(paragraph.join(' '), `paragraph-${index}`)}</p>);
    } else {
      blocks.push(<p key={`paragraph-${index}`}>{inline(lines[index], `paragraph-${index}`)}</p>); index++;
    }
  }
  return <div className="markdown-content">{blocks}</div>;
}


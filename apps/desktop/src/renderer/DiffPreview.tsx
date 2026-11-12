import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { FileDiff } from '../../../../packages/domain/src';
import { Icon } from './ui';

const defaultHeight = 320;
interface PreviewDrag { pointerId: number; startY: number; startHeight: number; handle: HTMLButtonElement }

export function DiffPreview({ file, expanded, onToggle }: { file: FileDiff; expanded: boolean; onToggle: () => void }) {
  const preview = useRef<HTMLDivElement>(null);
  const drag = useRef<PreviewDrag | null>(null);
  const [preferredHeight, setPreferredHeight] = useState(defaultHeight);
  const [maxHeight, setMaxHeight] = useState(defaultHeight);
  const minHeight = Math.min(160, maxHeight);
  const height = Math.max(minHeight, Math.min(maxHeight, preferredHeight));
  const lines = useMemo(() => diffLines(file.diff).map((line, index) => <div key={index} className={`diff-line ${line.kind}`}><span className="diff-line-number">{line.old}</span><span className="diff-line-number">{line.next}</span><span>{line.text || ' '}</span></div>), [file.diff]);

  useEffect(() => {
    const container = preview.current?.parentElement;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      // 面板隐藏时保留尺寸，重新展开后再按可用空间约束。
      if (container.clientHeight > 0) setMaxHeight(Math.max(0, container.clientHeight - 80));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => {
    const current = drag.current;
    if (current) {
      drag.current = null;
      delete current.handle.dataset.resizing;
      delete document.body.dataset.resizing;
      if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
    }
  }, [expanded]);

  function beginResize(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height, handle: event.currentTarget };
    event.currentTarget.dataset.resizing = 'true';
    document.body.dataset.resizing = 'row';
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveResize(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    setPreferredHeight(Math.max(minHeight, Math.min(maxHeight, Math.round(current.startHeight + current.startY - event.clientY))));
  }
  function finishResize(event: PointerEvent<HTMLButtonElement>) {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    delete current.handle.dataset.resizing;
    delete document.body.dataset.resizing;
    if (current.handle.hasPointerCapture(event.pointerId)) current.handle.releasePointerCapture(event.pointerId);
  }
  function adjustResize(event: KeyboardEvent<HTMLButtonElement>) {
    const step = event.shiftKey ? 40 : 12;
    const next = event.key === 'Home' ? defaultHeight : event.key === 'End' ? maxHeight : event.key === 'ArrowUp' ? height + step : event.key === 'ArrowDown' ? height - step : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setPreferredHeight(Math.max(minHeight, Math.min(maxHeight, next)));
  }

  return <div ref={preview} className={`diff-preview${expanded ? ' expanded' : ''}`} style={expanded ? { height } : undefined}>
    {expanded && <button type="button" className="panel-resize-handle diff-resize-handle" role="separator" aria-label="调整代码差异高度" aria-orientation="horizontal" aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={height} aria-controls="file-diff-content" title="拖动调整代码差异高度，双击恢复" onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize} onKeyDown={adjustResize} onDoubleClick={() => setPreferredHeight(defaultHeight)} />}
    <button type="button" className="diff-file-heading diff-preview-toggle" aria-label={expanded ? '收起文件代码差异' : '展开文件代码差异'} aria-expanded={expanded} aria-controls="file-diff-content" title={file.path} onClick={onToggle}><Icon name="chevron" className={expanded ? 'expanded' : ''} /><Icon name="file" /><span>{file.path}</span><small>{expanded ? '收起' : '展开'}</small></button>
    {expanded && <div id="file-diff-content" className="diff-view" key={file.path}>
      {file.binary && <div className="diff-note">二进制文件发生变更，无法显示文本差异。</div>}
      {file.truncated && <div className="diff-note">文件差异较大，当前仅显示部分内容。</div>}
      <pre aria-label="文件代码差异">{lines}</pre>
    </div>}
  </div>;
}

function diffLines(value: string) {
  let oldLine = 0, newLine = 0;
  return value.split('\n').map(text => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) { oldLine = Number(hunk[1]); newLine = Number(hunk[2]); return { text, kind: 'hunk', old: '', next: '' }; }
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('new file') || text.startsWith('deleted file') || text.startsWith('\\')) return { text, kind: 'meta', old: '', next: '' };
    if (text.startsWith('+')) return { text, kind: 'addition', old: '', next: newLine++ };
    if (text.startsWith('-')) return { text, kind: 'deletion', old: oldLine++, next: '' };
    if (text.startsWith(' ') && (oldLine || newLine)) return { text, kind: '', old: oldLine++, next: newLine++ };
    return { text, kind: 'meta', old: '', next: '' };
  });
}

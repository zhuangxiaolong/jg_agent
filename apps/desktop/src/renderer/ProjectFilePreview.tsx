import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { Icon } from './ui';

interface PreviewDrag { pointerId: number; startY: number; startHeight: number; handle: HTMLButtonElement }

export function ProjectFilePreview({ file, expanded, onToggle, onReveal }: {
  file: { path: string; absolutePath: string; content: string }; expanded: boolean;
  onToggle: () => void; onReveal: () => void;
}) {
  const preview = useRef<HTMLDivElement>(null), drag = useRef<PreviewDrag | null>(null);
  const [preferredHeight, setPreferredHeight] = useState<number | null>(null);
  const [maxHeight, setMaxHeight] = useState(360);
  const minHeight = Math.min(160, maxHeight);
  const height = Math.max(minHeight, Math.min(maxHeight, preferredHeight ?? Math.round(maxHeight * 0.65)));

  useEffect(() => {
    const container = preview.current?.parentElement;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      if (container.clientHeight <= 0) return;
      const heading = container.querySelector('.project-files-heading')?.getBoundingClientRect().height ?? 0;
      const root = container.querySelector('.project-files-root')?.getBoundingClientRect().height ?? 0;
      setMaxHeight(Math.max(0, container.clientHeight - heading - root - 120));
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => () => {
    const current = drag.current;
    if (!current) return;
    drag.current = null;
    delete document.body.dataset.resizing;
    if (current.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId);
  }, [expanded]);

  function beginResize(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { pointerId: event.pointerId, startY: event.clientY, startHeight: height, handle: event.currentTarget };
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
    delete document.body.dataset.resizing;
    if (current.handle.hasPointerCapture(event.pointerId)) current.handle.releasePointerCapture(event.pointerId);
  }
  function adjustResize(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Home') { event.preventDefault(); setPreferredHeight(null); return; }
    const step = event.shiftKey ? 40 : 12;
    const next = event.key === 'End' ? maxHeight : event.key === 'ArrowUp' ? height + step : event.key === 'ArrowDown' ? height - step : undefined;
    if (next === undefined) return;
    event.preventDefault();
    setPreferredHeight(Math.max(minHeight, Math.min(maxHeight, next)));
  }

  return <div ref={preview} className={`project-file-preview${expanded ? ' expanded' : ''}`} style={expanded ? { height } : undefined}>
    {expanded && <button type="button" className="panel-resize-handle project-file-resize-handle" role="separator" aria-label="调整项目文件预览高度" aria-orientation="horizontal" aria-valuemin={minHeight} aria-valuemax={maxHeight} aria-valuenow={height} aria-controls="project-file-preview-content" title="拖动调整文件预览高度，双击恢复" onPointerDown={beginResize} onPointerMove={moveResize} onPointerUp={finishResize} onPointerCancel={finishResize} onLostPointerCapture={finishResize} onKeyDown={adjustResize} onDoubleClick={() => setPreferredHeight(null)} />}
    <div className="project-file-preview-heading"><button type="button" className="project-file-preview-toggle" aria-label={expanded ? '收起项目文件预览' : '展开项目文件预览'} aria-expanded={expanded} aria-controls="project-file-preview-content" title={file.path} onClick={onToggle}><Icon name="chevron" className={expanded ? 'expanded' : ''} /><strong>{file.path}</strong><small>{expanded ? '收起' : '展开'}</small></button><button type="button" className="text-button" onClick={onReveal}>在资源管理器打开</button></div>
    {expanded && <div id="project-file-preview-content" className="project-file-preview-content"><code className="project-file-absolute">{file.absolutePath}</code><pre aria-label="项目文件预览内容">{file.content}</pre></div>}
  </div>;
}

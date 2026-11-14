import { useRef, type PointerEvent } from 'react';

export function GitChangesResizeHandle({ height, onResize }: { height: number | null; onResize: (height: number | null) => void }) {
  const drag = useRef<{ y: number; height: number } | null>(null);
  function clamp(value: number, handle: HTMLElement) {
    const available = handle.parentElement?.clientHeight ?? 800;
    return Math.round(Math.max(100, Math.min(Math.max(100, available - 180), value)));
  }
  function finish(event: PointerEvent<HTMLButtonElement>) {
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  }
  function currentHeight(handle: HTMLElement) {
    return handle.parentElement?.querySelector('#diff-panel')?.getBoundingClientRect().height ?? height ?? 100;
  }
  return <button type="button" className="git-changes-resize-handle" role="separator" aria-label="调整本次会话代码变更区域高度" aria-orientation="horizontal" aria-valuemin={100} aria-valuenow={height ?? undefined} title="上下拖动调整本次会话代码变更区域，双击恢复 70% / 30%" onPointerDown={event => {
    if (event.button !== 0) return;
    event.preventDefault();
    drag.current = { y: event.clientY, height: currentHeight(event.currentTarget) };
    event.currentTarget.setPointerCapture(event.pointerId);
  }} onPointerMove={event => {
    if (drag.current) onResize(clamp(drag.current.height + event.clientY - drag.current.y, event.currentTarget));
  }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={() => { drag.current = null; }} onKeyDown={event => {
    if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    onResize(event.key === 'Home' ? null : clamp(currentHeight(event.currentTarget) + (event.key === 'ArrowUp' ? -20 : 20), event.currentTarget));
  }} onDoubleClick={() => onResize(null)}><span /></button>;
}

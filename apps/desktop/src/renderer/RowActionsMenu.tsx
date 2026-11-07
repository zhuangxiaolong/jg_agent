import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './ui';

interface MenuPosition { x: number; y: number; trigger: HTMLElement }

export function useRowActions({ kind, name, disabled, onRename, onDelete, onExport }: {
  kind: '项目' | '会话'; name: string; disabled: boolean; onRename: () => void; onDelete: () => void;
  onExport?: () => void;
}) {
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const close = (restoreFocus = false) => { setPosition(null); if (restoreFocus) position?.trigger.focus(); };
  function onContextMenu(event: MouseEvent<HTMLDivElement>) {
    event.preventDefault(); event.stopPropagation();
    const trigger = event.currentTarget.querySelector('button');
    if (trigger) setPosition({ x: event.clientX, y: event.clientY, trigger });
  }
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
    event.preventDefault(); event.stopPropagation();
    const trigger = event.currentTarget.querySelector('button');
    if (trigger) { const box = trigger.getBoundingClientRect(); setPosition({ x: box.left + 12, y: box.bottom, trigger }); }
  }
  return { onContextMenu, onKeyDown, menu: position && <RowActionsMenu position={position} kind={kind} name={name} disabled={disabled} onClose={close} onRename={onRename} onDelete={onDelete} onExport={onExport} /> };
}

function RowActionsMenu({ position, kind, name, disabled, onClose, onRename, onDelete, onExport }: {
  position: MenuPosition; kind: '项目' | '会话'; name: string; disabled: boolean; onClose: (restoreFocus?: boolean) => void; onRename: () => void; onDelete: () => void;
  onExport?: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [location, setLocation] = useState({ x: position.x, y: position.y });
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const box = menu.getBoundingClientRect();
    setLocation({ x: Math.max(6, Math.min(position.x, innerWidth - box.width - 6)), y: Math.max(6, Math.min(position.y, innerHeight - box.height - 6)) });
    (menu.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu).focus();
  }, [position]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose(); };
    const dismiss = () => onClose();
    document.addEventListener('pointerdown', outside);
    document.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); window.removeEventListener('blur', dismiss); };
  }, [onClose]);
  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape' || event.key === 'Tab') { event.preventDefault(); onClose(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!buttons.length) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus();
  }
  return createPortal(<div ref={menuRef} className="row-actions-menu" role="menu" aria-label={`${kind} ${name} 操作`} tabIndex={-1} style={{ left: location.x, top: location.y }} onKeyDown={navigate} onContextMenu={event => event.preventDefault()}>
    <button type="button" role="menuitem" disabled={disabled} onClick={() => { onClose(true); onRename(); }}><Icon name="edit" />修改名称</button>
    {onExport && <button type="button" role="menuitem" disabled={disabled} onClick={() => { onClose(true); onExport(); }}><Icon name="download" />导出会话</button>}
    <button type="button" role="menuitem" className="row-action-delete" disabled={disabled} onClick={() => { onClose(true); onDelete(); }}><Icon name="close" />删除{kind}</button>
  </div>, document.body);
}

import { Check } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocale } from './locale';

export type SidebarEntry =
  | { id: string; kind: 'label'; label: string }
  | { id: string; kind: 'separator' }
  | {
      id: string;
      kind: 'action';
      label: string;
      icon?: ReactNode;
      // A defined checked state is a destination choice, rather than an ordinary action.
      checked?: boolean;
      disabled?: boolean;
      onSelect: () => unknown;
    };

export interface SidebarAnchor {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function SidebarMenu({
  label,
  anchor,
  focusId,
  items,
  onClose,
}: {
  label: string;
  anchor: SidebarAnchor;
  focusId: string;
  items: SidebarEntry[];
  onClose: (restoreFocus: boolean) => unknown;
}) {
  useLocale();
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: anchor.left, top: anchor.bottom });
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    setPosition({
      left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(anchor.bottom + 4, window.innerHeight - height - 8)),
    });
    element.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [anchor]);
  useEffect(() => {
    function outside(event: PointerEvent) {
      if (!(event.target instanceof Node)) return;
      if (
        ref.current?.contains(event.target) ||
        document.getElementById(focusId)?.contains(event.target)
      )
        return;
      onClose(false);
    }
    const resize = () => onClose(true);
    document.addEventListener('pointerdown', outside);
    window.addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      window.removeEventListener('resize', resize);
    };
  }, [focusId, onClose]);
  function action(item: Extract<SidebarEntry, { kind: 'action' }>) {
    const props = {
      type: 'button' as const,
      disabled: item.disabled,
      onClick: () => {
        item.onSelect();
        onClose(true);
      },
      children: (
        <>
          {item.icon}
          <span>{item.label}</span>
          {item.checked && <Check className="menu-check" aria-hidden="true" />}
        </>
      ),
    };
    return item.checked === undefined ? (
      <button key={item.id} role="menuitem" {...props} />
    ) : (
      <button key={item.id} role="menuitemradio" aria-checked={item.checked} {...props} />
    );
  }
  return createPortal(
    <div
      ref={ref}
      role="menu"
      aria-label={label}
      className="sidebar-menu"
      style={position}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose(true);
        } else if (event.key === 'Tab') {
          document.getElementById(focusId)?.focus();
          onClose(false);
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          const buttons = [
            ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || []),
          ];
          const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? buttons.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }
      }}
    >
      {items.map((item) =>
        item.kind === 'separator' ? (
          <hr key={item.id} className="sidebar-menu-separator" />
        ) : item.kind === 'label' ? (
          <div key={item.id} className="sidebar-menu-label">
            {item.label}
          </div>
        ) : (
          action(item)
        ),
      )}
    </div>,
    document.body,
  );
}

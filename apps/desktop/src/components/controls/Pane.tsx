import { type CSSProperties, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { clientCache } from '../../app/cache';
import { t } from '../../i18n/locale';

function measure(pane: HTMLElement | null) {
  if (!pane?.parentElement || !pane.offsetWidth) return;
  const style = getComputedStyle(pane);
  const min = Number.parseFloat(style.getPropertyValue('--pane-min')) || 0;
  const reserve = Number.parseFloat(style.getPropertyValue('--pane-reserve')) || 0;
  const cap = Number.parseFloat(style.getPropertyValue('--pane-cap')) || Infinity;
  return {
    width: pane.offsetWidth,
    min,
    max: Math.max(min, Math.min(cap, pane.parentElement.clientWidth - reserve)),
  };
}

export function Pane({
  id,
  label,
  className,
  bodyClass,
  edge = 'left',
  resizable = true,
  children,
}: {
  id: string;
  label: string;
  className: string;
  bodyClass?: string;
  edge?: 'left' | 'right';
  resizable?: boolean;
  children: ReactNode;
}) {
  const key = `daban-pane-width:${id}`;
  const [width, setWidth] = useState(() => {
    try {
      const saved = Number(clientCache().getItem(key));
      return Number.isFinite(saved) && saved > 0 ? saved : undefined;
    } catch {
      return undefined;
    }
  });
  const pane = useRef<HTMLElement>(null);
  const drag = useRef<{ pointer: number; x: number; initial: number; width?: number }>(null);
  const [range, setRange] = useState<ReturnType<typeof measure>>();
  const direction = edge === 'right' ? 1 : -1;

  useLayoutEffect(() => {
    const element = pane.current;
    if (!resizable || !element?.parentElement) return;
    const update = () => setRange(measure(element));
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    // The available range also changes when the adjacent content is resized.
    observer.observe(element.parentElement);
    return () => observer.disconnect();
  }, [resizable]);

  function save(value: number) {
    try {
      clientCache().setItem(key, String(value));
    } catch {
      // Resizing still works for the current view when the cache is unavailable.
    }
  }

  function finish(pointer: number) {
    const current = drag.current;
    if (!current || current.pointer !== pointer) return;
    drag.current = null;
    if (current.width !== undefined) save(current.width);
  }

  return (
    <aside
      id={id}
      ref={pane}
      aria-label={label}
      className={`pane ${className}`}
      style={{ '--pane-width': width === undefined ? undefined : `${width}px` } as CSSProperties}
    >
      {resizable && (
        <hr
          tabIndex={0}
          aria-label={t('layout.resizePane', { 0: label })}
          aria-orientation="vertical"
          aria-controls={id}
          aria-valuemin={range?.min}
          aria-valuemax={range?.max}
          aria-valuenow={range?.width}
          className={`pane-divider pane-divider-${edge}`}
          onPointerDown={(event) => {
            const bounds = measure(pane.current);
            if (event.button !== 0 || drag.current || !bounds) return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture?.(event.pointerId);
            drag.current = { pointer: event.pointerId, x: event.clientX, initial: bounds.width };
          }}
          onPointerMove={(event) => {
            const current = drag.current;
            if (!current || current.pointer !== event.pointerId) return;
            const bounds = measure(pane.current);
            if (!bounds) return;
            const next = current.initial + direction * (event.clientX - current.x);
            current.width = Math.min(bounds.max, Math.max(bounds.min, next));
            setWidth(current.width);
          }}
          onPointerUp={(event) => finish(event.pointerId)}
          onPointerCancel={(event) => finish(event.pointerId)}
          onLostPointerCapture={(event) => finish(event.pointerId)}
          onKeyDown={(event) => {
            const bounds = measure(pane.current);
            if (!bounds || drag.current) return;
            let next: number;
            switch (event.key) {
              case 'ArrowLeft':
                next = bounds.width - direction * 16;
                break;
              case 'ArrowRight':
                next = bounds.width + direction * 16;
                break;
              case 'Home':
                next = bounds.min;
                break;
              case 'End':
                next = bounds.max;
                break;
              default:
                return;
            }
            event.preventDefault();
            const value = Math.min(bounds.max, Math.max(bounds.min, next));
            setWidth(value);
            save(value);
          }}
        />
      )}
      {bodyClass ? <div className={bodyClass}>{children}</div> : children}
    </aside>
  );
}

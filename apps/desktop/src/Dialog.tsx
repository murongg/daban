// biome-ignore-all lint/a11y/noStaticElementInteractions: The backdrop only handles pointer dismissal; the dialog provides Escape and focus management.
import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';
import { useDialogMotion } from './motion';

// A closed native disclosure is still keyboard-focusable; result readers must not trap Tab before it.
const focusable =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], details > summary, [tabindex="0"]';
const topDialog = (exclude?: HTMLElement | null) =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-daban-dialog]'))
    .filter((element) => element !== exclude)
    .at(-1);
const openers = new WeakMap<HTMLElement, { current: HTMLElement | null }>();
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
  className = '',
  active = true,
  motion = false,
}: {
  title: string;
  onClose: () => unknown;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  active?: boolean;
  motion?: boolean;
}) {
  const label = useId();
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const dismiss = useDialogMotion(ref, backdrop, motion, active, onClose);
  const previous = useRef<HTMLElement | null>(null);
  const attach = useCallback((element: HTMLDivElement | null) => {
    ref.current = element;
    if (element) openers.set(element, previous);
  }, []);
  const close = useRef(dismiss);
  close.current = dismiss;
  useEffect(() => {
    if (!active) return;
    // Suspension retains the original opener, rather than replacing it with a child dialog's control.
    previous.current ??= document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    if (root) root.inert = true;
    const element = ref.current;
    (
      element?.querySelector<HTMLElement>('[data-autofocus]') ||
      element?.querySelector<HTMLElement>(focusable)
    )?.focus();
    function handle(event: KeyboardEvent) {
      if (topDialog() !== element) return;
      // Portalled controls own their keyboard layer until their popup has closed.
      if (document.querySelector('[data-daban-popup]')) return;
      if (event.key === 'Escape') {
        // A controlled remote screen owns Escape until it moves focus back to the surrounding dialog.
        if (
          event.target instanceof Element &&
          event.target.closest('[data-remote-keyboard="true"]')
        )
          return;
        if (event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        event.stopPropagation();
        close.current();
      }
      if (event.key !== 'Tab') return;
      const items = Array.from(element?.querySelectorAll<HTMLElement>(focusable) || []).filter(
        // Custom controls retain hidden native form inputs; those must never become Tab endpoints.
        (el) =>
          !el.hidden &&
          !el.closest('[hidden], [aria-hidden="true"], [inert]') &&
          !el.matches('input[type="hidden"]') &&
          !(el.hasAttribute('tabindex') && el.tabIndex < 0),
      );
      const first = items[0],
        last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    document.addEventListener('keydown', handle, true);
    return () => {
      document.removeEventListener('keydown', handle, true);
      // A child closing must leave its still-open parent in charge of the background and focus.
      const remaining = topDialog(element);
      if (root) root.inert = !!remaining;
      const target = previous.current;
      // Peer replacement keeps the logical opener without briefly focusing the locked background.
      if (
        !element?.isConnected &&
        remaining &&
        target?.isConnected &&
        !remaining.contains(target)
      ) {
        const next = openers.get(remaining);
        const current = next?.current;
        if (
          next &&
          (!current?.isConnected || current === document.body || remaining.contains(current))
        )
          next.current = target;
      }
      if (
        target?.isConnected &&
        !target.closest('[hidden], [inert], [aria-hidden="true"]') &&
        (!remaining || remaining.contains(target))
      )
        target.focus();
    };
  }, [active]);
  return createPortal(
    <div
      ref={backdrop}
      className="backdrop"
      hidden={!active}
      inert={!active}
      role="presentation"
      onMouseDown={(e) => {
        if (active && topDialog() === ref.current && e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        ref={attach}
        className={`dialog ${wide ? 'wide' : ''} ${className}`}
        {...(active
          ? {
              role: 'dialog',
              'aria-modal': true,
              'aria-labelledby': label,
              'data-daban-dialog': '',
            }
          : {})}
      >
        <header className="dialog-header">
          <h2 id={label}>{title}</h2>
          <IconButton label="关闭对话框" onClick={dismiss}>
            <X />
          </IconButton>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

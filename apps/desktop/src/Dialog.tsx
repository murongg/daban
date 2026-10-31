// biome-ignore-all lint/a11y/noStaticElementInteractions: The backdrop only handles pointer dismissal; the dialog provides Escape and focus management.
import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { IconButton } from './Button';

// A closed native disclosure is still keyboard-focusable; result readers must not trap Tab before it.
const focusable =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], details > summary, [tabindex="0"]';
export function Dialog({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string;
  onClose: () => unknown;
  children: ReactNode;
  wide?: boolean;
}) {
  const label = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const root = document.getElementById('root');
    if (root) root.inert = true;
    const element = ref.current;
    (
      element?.querySelector<HTMLElement>('[data-autofocus]') ||
      element?.querySelector<HTMLElement>(focusable)
    )?.focus();
    function handle(event: KeyboardEvent) {
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
        onClose();
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
      if (root) root.inert = false;
      if (previous?.isConnected) previous.focus();
    };
  }, [onClose]);
  return createPortal(
    <div
      className="backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={label}
      >
        <header className="dialog-header">
          <h2 id={label}>{title}</h2>
          <IconButton label="关闭对话框" onClick={onClose}>
            <X />
          </IconButton>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

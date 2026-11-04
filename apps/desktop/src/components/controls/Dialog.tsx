// biome-ignore-all lint/a11y/noStaticElementInteractions: The backdrop only handles pointer dismissal; the dialog provides Escape and focus management.
import { X } from 'lucide-react';
import { type ReactNode, useCallback, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { t, useLocale } from '../../i18n/locale';
import { IconButton } from './Button';
import { useDialogMotion } from './motion';

// A closed native disclosure is still keyboard-focusable; result readers must not trap Tab before it.
const focusable =
  'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], details > summary, [tabindex="0"]';
function visible(element: HTMLElement) {
  if (element.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const visibility = getComputedStyle(element).visibility;
  if (visibility === 'hidden' || visibility === 'collapse') return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    if (getComputedStyle(ancestor).display === 'none') return false;
    // Closed details expose only their first summary, even though descendants still match selectors.
    if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
      const summary = Array.from(ancestor.children).find((child) => child.tagName === 'SUMMARY');
      if (!summary?.contains(element)) return false;
    }
  }
  return true;
}
function tabStops(element: HTMLElement | null) {
  // Match after traversal: some DOM implementations group compound selector results by tag.
  return Array.from(element?.querySelectorAll<HTMLElement>('*') || []).filter(
    // Custom controls retain hidden native form inputs; those must never become Tab endpoints.
    (item) =>
      item.matches(focusable) &&
      visible(item) &&
      !item.matches('input[type="hidden"]') &&
      !(item.hasAttribute('tabindex') && item.tabIndex < 0),
  );
}
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
  closeDisabled = false,
}: {
  title: string;
  onClose: () => unknown;
  children: ReactNode;
  wide?: boolean;
  className?: string;
  active?: boolean;
  motion?: boolean;
  closeDisabled?: boolean;
}) {
  useLocale();
  const label = useId();
  const ref = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const animateDismiss = useDialogMotion(ref, backdrop, motion, active, onClose);
  const dismiss = useCallback(() => {
    if (!closeDisabled) animateDismiss();
  }, [closeDisabled, animateDismiss]);
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
    const autofocus = element?.querySelector<HTMLElement>('[data-autofocus]');
    (autofocus && visible(autofocus) ? autofocus : tabStops(element)[0])?.focus();
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
      const items = tabStops(element);
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
      if (target?.isConnected && visible(target) && (!remaining || remaining.contains(target)))
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
          <IconButton label={t('dialog.closeDialog')} onClick={dismiss} disabled={closeDisabled}>
            <X />
          </IconButton>
        </header>
        <div className="dialog-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

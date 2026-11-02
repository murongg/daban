import {
  cloneElement,
  type HTMLAttributes,
  type ReactElement,
  type RefAttributes,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { useOverlayPosition } from 'react-aria/useOverlayPosition';
import { createPortal } from 'react-dom';
import { useLocale } from '../../i18n/locale';
import './controls.css';

type Trigger = ReactElement<
  HTMLAttributes<HTMLElement> & RefAttributes<HTMLElement> & { disabled?: boolean }
>;
export function Tooltip({ label, children }: { label?: string; children: Trigger }) {
  useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const id = useId();
  const disabled = !label || children.props.disabled === true;
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);
  const { overlayProps } = useOverlayPosition({
    targetRef: trigger,
    overlayRef: overlay,
    isOpen: open && !disabled,
    placement: 'top',
    offset: 6,
    shouldFlip: true,
    onClose: close,
  });
  useEffect(() => {
    if (disabled) close();
  }, [disabled, close]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!open) return;
    // Hints may dismiss on Escape, but must never consume the remote screen's keyboard event.
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('keydown', key, true);
    return () => document.removeEventListener('keydown', key, true);
  }, [open, close]);
  const childRef = children.props.ref;
  const attach = useCallback(
    (element: HTMLElement | null) => {
      trigger.current = element;
      if (typeof childRef === 'function') return childRef(element);
      if (childRef) childRef.current = element;
    },
    [childRef],
  );
  return (
    <>
      {cloneElement(children, {
        ref: attach,
        'aria-describedby':
          [children.props['aria-describedby'], open && !disabled ? id : undefined]
            .filter(Boolean)
            .join(' ') || undefined,
        onPointerEnter(event) {
          children.props.onPointerEnter?.(event);
          if (!disabled && event.pointerType !== 'touch')
            timer.current = setTimeout(() => setOpen(true), 500);
        },
        onPointerLeave(event) {
          children.props.onPointerLeave?.(event);
          close();
        },
        onPointerDown(event) {
          children.props.onPointerDown?.(event);
          close();
        },
        onFocus(event) {
          children.props.onFocus?.(event);
          if (!disabled && event.currentTarget.matches(':focus-visible')) setOpen(true);
        },
        onBlur(event) {
          children.props.onBlur?.(event);
          close();
        },
      })}
      {open &&
        !disabled &&
        createPortal(
          <div {...overlayProps} ref={overlay} id={id} role="tooltip" className="control-tooltip">
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

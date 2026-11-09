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
export function Tooltip({
  label,
  children,
  showOnPress = false,
}: {
  label?: string;
  children: Trigger;
  showOnPress?: boolean;
}) {
  useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const keyboardFocus = useRef(false);
  const hovered = useRef(false);
  const id = useId();
  const disabled = !label || children.props.disabled === true;
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setOpen(false);
  }, []);
  const leave = () => {
    hovered.current = false;
    clearTimeout(timer.current);
    // A small gap separates the portalled hint from its trigger; keep it reachable by pointer.
    if (!keyboardFocus.current) timer.current = setTimeout(close, 150);
  };
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
          if (!disabled && event.pointerType !== 'touch') {
            hovered.current = true;
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setOpen(true), 500);
          }
        },
        onPointerLeave(event) {
          children.props.onPointerLeave?.(event);
          leave();
        },
        onPointerDown(event) {
          children.props.onPointerDown?.(event);
          if (!showOnPress) close();
        },
        onClick(event) {
          children.props.onClick?.(event);
          if (showOnPress && !disabled) setOpen(true);
        },
        onFocus(event) {
          children.props.onFocus?.(event);
          keyboardFocus.current = event.currentTarget.matches(':focus-visible');
          if (!disabled && keyboardFocus.current) {
            clearTimeout(timer.current);
            setOpen(true);
          }
        },
        onBlur(event) {
          children.props.onBlur?.(event);
          keyboardFocus.current = false;
          if (!hovered.current) close();
        },
      })}
      {open &&
        !disabled &&
        createPortal(
          <div
            {...overlayProps}
            ref={overlay}
            id={id}
            role="tooltip"
            className="control-tooltip"
            onPointerEnter={() => {
              hovered.current = true;
              clearTimeout(timer.current);
            }}
            onPointerLeave={leave}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}

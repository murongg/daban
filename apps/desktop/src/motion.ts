import { type RefObject, useCallback, useLayoutEffect, useRef } from 'react';

const reducedMotion = () =>
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

export function useDialogMotion(
  surface: RefObject<HTMLElement | null>,
  backdrop: RefObject<HTMLElement | null>,
  enabled: boolean,
  active: boolean,
  onClose: () => unknown,
) {
  const close = useRef(onClose);
  close.current = onClose;
  const animations = useRef<Animation[]>([]);
  const ticket = useRef(0);
  const closing = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = undefined;
    for (const animation of animations.current) {
      animation.onfinish = null;
      animation.cancel();
    }
    animations.current = [];
  }, []);
  useLayoutEffect(() => {
    const element = surface.current;
    const background = backdrop.current;
    if (enabled && active && !reducedMotion() && element?.animate && background?.animate) {
      try {
        animations.current.push(
          background.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 180,
            easing: 'ease-out',
          }),
        );
        animations.current.push(
          element.animate(
            [
              { opacity: 0, transform: 'translateY(8px) scale(0.98)' },
              { opacity: 1, transform: 'none' },
            ],
            { duration: 180, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' },
          ),
        );
      } catch {
        cancel();
      }
    }
    return () => {
      ticket.current++;
      closing.current = false;
      cancel();
    };
  }, [surface, backdrop, enabled, active, cancel]);
  return useCallback(() => {
    if (!active || closing.current) return;
    const element = surface.current;
    const background = backdrop.current;
    if (!enabled || reducedMotion() || !element?.animate || !background?.animate) {
      cancel();
      close.current();
      return;
    }
    closing.current = true;
    const current = ++ticket.current;
    const finish = () => {
      // Suspension, replacement and unmount retire old animation callbacks before they can close newer UI.
      if (ticket.current !== current) return;
      ticket.current++;
      clearTimeout(timer.current);
      timer.current = undefined;
      // Cancelling here restores opacity before React removes the modal, producing a one-frame flash.
      // Hold both exit effects until the owner's unmount/suspension cleanup cancels them.
      for (const animation of animations.current) animation.onfinish = null;
      close.current();
    };
    const style = getComputedStyle(element);
    const start = { opacity: style.opacity || '1', transform: style.transform || 'none' };
    const opacity = getComputedStyle(background).opacity || '1';
    cancel();
    try {
      animations.current.push(
        background.animate([{ opacity }, { opacity: 0 }], { duration: 140, fill: 'forwards' }),
      );
      animations.current.push(
        element.animate([start, { opacity: 0, transform: 'translateY(4px) scale(0.985)' }], {
          duration: 140,
          easing: 'ease-in',
          fill: 'forwards',
        }),
      );
      animations.current.at(-1)!.onfinish = finish;
      // Background tabs and interrupted compositor events must never leave a modal locked onscreen.
      timer.current = setTimeout(finish, 220);
    } catch {
      finish();
    }
  }, [surface, backdrop, enabled, active, cancel]);
}

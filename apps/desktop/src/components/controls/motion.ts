import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from 'react';

export const reducedMotionQuery = '(prefers-reduced-motion: reduce)';

export function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia?.(query).matches === true);
  useLayoutEffect(() => {
    const media = window.matchMedia?.(query);
    const sync = () => setMatches(media?.matches === true);
    sync();
    media?.addEventListener?.('change', sync);
    return () => media?.removeEventListener?.('change', sync);
  }, [query]);
  return matches;
}

export function useDialogMotion(
  surface: RefObject<HTMLElement | null>,
  backdrop: RefObject<HTMLElement | null>,
  enabled: boolean,
  active: boolean,
  blocked: boolean,
  onClose: () => unknown,
) {
  const close = useRef(onClose);
  close.current = onClose;
  const allowEntry = useRef(enabled);
  allowEntry.current = enabled;
  const animations = useRef<Animation[]>([]);
  const entry = useRef<'new' | 'shown' | 'resumed'>('new');
  const finishExit = useRef<() => unknown>(undefined);
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
    if (!active) {
      if (entry.current === 'shown') entry.current = 'resumed';
      return;
    }
    const element = surface.current;
    const background = backdrop.current;
    const preference = window.matchMedia?.(reducedMotionQuery);
    const firstAppearance = entry.current !== 'resumed';
    if (firstAppearance) entry.current = 'shown';
    if (
      allowEntry.current &&
      firstAppearance &&
      !preference?.matches &&
      element?.animate &&
      background?.animate
    ) {
      try {
        animations.current.push(
          background.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 180,
            easing: 'ease-out',
          }),
        );
        animations.current.push(
          // Native browser views use the final DOM bounds while the dialog is appearing.
          element.animate([{ opacity: 0 }, { opacity: 1 }], {
            duration: 180,
            easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
          }),
        );
      } catch {
        cancel();
      }
    }
    const reduce = () => {
      if (!preference?.matches) return;
      if (finishExit.current) finishExit.current();
      else if (!element?.hasAttribute('inert')) cancel();
    };
    preference?.addEventListener?.('change', reduce);
    return () => {
      preference?.removeEventListener?.('change', reduce);
      finishExit.current = undefined;
      element?.removeAttribute('inert');
      cancel();
    };
  }, [surface, backdrop, active, cancel]);
  useLayoutEffect(() => {
    if ((enabled && !blocked) || !finishExit.current) return;
    finishExit.current = undefined;
    cancel();
    surface.current?.removeAttribute('inert');
  }, [blocked, enabled, cancel, surface]);

  return useCallback(() => {
    const element = surface.current;
    const background = backdrop.current;
    if (!active || blocked || element?.hasAttribute('inert')) return;
    if (
      !enabled ||
      window.matchMedia?.(reducedMotionQuery).matches ||
      !element?.animate ||
      !background?.animate
    ) {
      cancel();
      close.current();
      return;
    }
    // The backdrop still owns the modal layer until unmount, but its controls lose input immediately.
    element.setAttribute('inert', '');
    const finish = () => {
      // Suspension, replacement and unmount retire old animation callbacks before they can close newer UI.
      if (finishExit.current !== finish) return;
      finishExit.current = undefined;
      clearTimeout(timer.current);
      timer.current = undefined;
      // Cancelling here restores opacity before React removes the modal, producing a one-frame flash.
      // Hold both exit effects until the owner's unmount/suspension cleanup cancels them.
      for (const animation of animations.current) animation.onfinish = null;
      close.current();
    };
    finishExit.current = finish;
    const start = getComputedStyle(element).opacity || '1';
    const opacity = getComputedStyle(background).opacity || '1';
    cancel();
    try {
      animations.current.push(
        background.animate([{ opacity }, { opacity: 0 }], { duration: 140, fill: 'forwards' }),
      );
      animations.current.push(
        element.animate([{ opacity: start }, { opacity: 0 }], {
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
  }, [surface, backdrop, enabled, active, blocked, cancel]);
}

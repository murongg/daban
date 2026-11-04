import { defaultRangeExtractor, type Range } from '@tanstack/react-virtual';
import {
  type FocusEvent,
  type PointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useState,
} from 'react';

const none: readonly string[] = [];
function rowFor(target: EventTarget | null) {
  return target instanceof Element ? target.closest<HTMLElement>('[data-window-key]') : null;
}
export function useRetention(
  root: RefObject<HTMLElement | null>,
  keys: readonly string[],
  persistent: readonly string[] = none,
) {
  const [focused, setFocused] = useState({ id: '' });
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = (row: HTMLElement) => {
      const id = row.dataset.windowKey;
      if (!id) return;
      const open = !!row.querySelector('details[open], [aria-expanded="true"]');
      setExpanded((current) => {
        if (current.has(id) === open) return current;
        const next = new Set(current);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      });
    };
    // Attribute observation also covers custom expanders, whose state must survive a row leaving the viewport.
    const observer = new MutationObserver((records) => {
      const rows = new Set(
        records.flatMap((record) => {
          const row = rowFor(record.target);
          return row ? [row] : [];
        }),
      );
      for (const row of rows) update(row);
    });
    observer.observe(element, {
      subtree: true,
      attributes: true,
      attributeFilter: ['open', 'aria-expanded'],
    });
    for (const row of element.querySelectorAll<HTMLElement>('[data-window-key]'))
      if (row.querySelector('details[open], [aria-expanded="true"]')) update(row);
    return () => observer.disconnect();
  }, [root]);
  const rangeExtractor = useCallback(
    (range: Range) => {
      const indexes = new Set(defaultRangeExtractor(range));
      const retained = new Set([...persistent, ...expanded, focused.id]);
      keys.forEach((key, index) => {
        if (retained.has(key)) indexes.add(index);
      });
      return [...indexes].sort((a, b) => a - b);
    },
    [keys, persistent, expanded, focused],
  );
  return {
    rangeExtractor,
    onFocusCapture: (event: FocusEvent<HTMLElement>) =>
      setFocused({ id: rowFor(event.target)?.dataset.windowKey || '' }),
    onPointerDownCapture: (event: PointerEvent<HTMLElement>) =>
      setFocused({ id: rowFor(event.target)?.dataset.windowKey || '' }),
    onBlurCapture: (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setFocused({ id: '' });
    },
  };
}

import { useVirtualizer } from '@tanstack/react-virtual';
import {
  type CSSProperties,
  cloneElement,
  createElement,
  type HTMLAttributes,
  isValidElement,
  type ReactElement,
  type Ref,
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRetention } from './retention';

interface Props<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  renderItem: (item: T) => ReactElement;
  scope: string;
  tag?: 'div' | 'ul' | 'ol' | 'section';
  className?: string;
  label?: string;
  estimate?: number;
  persistentKeys?: readonly string[];
}
interface RowProps extends HTMLAttributes<HTMLElement> {
  style?: CSSProperties;
  ref?: Ref<HTMLElement>;
  'data-index'?: number;
  'data-window-key'?: string;
}
function parentFor(root: HTMLElement) {
  const scrollable = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    return /auto|scroll/.test(`${style.overflowY} ${style.overflow}`);
  };
  if (scrollable(root) && root.scrollHeight > root.clientHeight) return root;
  let parent = root.parentElement;
  while (parent && !scrollable(parent)) parent = parent.parentElement;
  return parent || (document.scrollingElement as HTMLElement) || document.documentElement;
}
function List<T>({
  items,
  getKey,
  renderItem,
  tag = 'div',
  className,
  label,
  estimate = 104,
  persistentKeys,
}: Props<T>) {
  const root = useRef<HTMLElement | null>(null);
  const scroller = useRef<HTMLElement | null>(null);
  const [margin, setMargin] = useState(0);
  const enabled = items.length > 80;
  const keys = useMemo(() => items.map(getKey), [items, getKey]);
  const retained = useRetention(root, keys, persistentKeys);
  const { rangeExtractor, ...interactionProps } = retained;
  const attach = useCallback((element: HTMLElement | null) => {
    root.current = element;
    scroller.current = element ? parentFor(element) : null;
  }, []);
  const virtualizer = useVirtualizer<HTMLElement, HTMLElement>({
    count: items.length,
    enabled,
    getScrollElement: () => scroller.current,
    estimateSize: () => estimate,
    getItemKey: (index) => keys[index]!,
    rangeExtractor,
    overscan: 4,
    scrollMargin: margin,
    useFlushSync: false,
  });
  useLayoutEffect(() => {
    if (!enabled || !root.current) return;
    const element = root.current;
    const viewport = parentFor(element);
    scroller.current = viewport;
    const update = () => {
      const value =
        viewport === element
          ? 0
          : element.getBoundingClientRect().top -
            viewport.getBoundingClientRect().top +
            viewport.scrollTop;
      setMargin((current) => (Math.abs(current - value) < 0.1 ? current : value));
    };
    update();
    let content = element;
    while (content.parentElement && content.parentElement !== viewport)
      content = content.parentElement;
    if (typeof ResizeObserver === 'undefined') return;
    // Shared scroll panes may contain several lists; their offsets change when a sibling is measured or expanded.
    const observer = new ResizeObserver(update);
    observer.observe(content);
    return () => observer.disconnect();
  }, [enabled]);
  useLayoutEffect(() => {
    if (!enabled || !root.current || !scroller.current) return;
    const value =
      root.current === scroller.current
        ? 0
        : root.current.getBoundingClientRect().top -
          scroller.current.getBoundingClientRect().top +
          scroller.current.scrollTop;
    if (Math.abs(value - margin) >= 0.1) setMargin(value);
  });
  const visible = enabled
    ? virtualizer.getVirtualItems()
    : items.map((item, index) => ({ key: getKey(item), index, start: 0 }));
  const children = visible.map((row) => {
    const element = renderItem(items[row.index]!);
    if (!isValidElement<RowProps>(element) || typeof element.type !== 'string')
      throw new Error('WINDOW_LIST_REQUIRES_ELEMENT');
    const original = element.props.ref;
    const measure = original
      ? (node: HTMLElement | null) => {
          virtualizer.measureElement(node);
          if (typeof original === 'function') original(node);
          else original.current = node;
        }
      : virtualizer.measureElement;
    return cloneElement(element, {
      key: row.key,
      'data-index': row.index,
      'data-window-key': keys[row.index],
      ...(element.type === 'li'
        ? { 'aria-setsize': items.length, 'aria-posinset': row.index + 1 }
        : {}),
      ref: enabled ? measure : original,
      style: enabled
        ? {
            ...element.props.style,
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${row.start - margin}px)`,
            ...(element.type === 'li' ? { display: 'flow-root' } : {}),
          }
        : element.props.style,
    });
  });
  if (enabled)
    children.unshift(
      createElement(tag === 'ul' || tag === 'ol' ? 'li' : 'div', {
        key: 'window-spacer',
        'aria-hidden': true,
        style: {
          height: virtualizer.getTotalSize(),
          pointerEvents: 'none',
          padding: 0,
          margin: 0,
          gridColumn: '1 / -1',
        },
      }),
    );
  return createElement(
    tag,
    {
      ref: attach,
      className,
      'aria-label': label,
      role: tag === 'ul' || tag === 'ol' ? 'list' : undefined,
      'data-window-list': true,
      style: enabled ? { position: 'relative', overflowAnchor: 'none' } : undefined,
      ...interactionProps,
    },
    children,
  );
}
export function WindowList<T>(props: Props<T>) {
  return <List key={props.scope} {...props} />;
}

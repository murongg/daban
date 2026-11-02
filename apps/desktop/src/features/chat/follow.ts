import { type UIEvent, useCallback, useLayoutEffect, useRef } from 'react';

export function useFollow(scope: string, request = '') {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const attention = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const position = useRef(0);
  const selection = useRef(scope);
  const previousRequest = useRef('');
  const update = useCallback(() => {
    const element = viewport.current;
    if (!element || !following.current) return;
    element.scrollTop = element.scrollHeight;
    position.current = element.scrollTop;
  }, []);
  const resume = useCallback(() => {
    following.current = true;
    update();
  }, [update]);

  // Follow actual rendered height, including final replies that replace the same message.
  useLayoutEffect(() => {
    const changed = selection.current !== scope;
    if (changed || (previousRequest.current && !request)) following.current = true;
    if (request && (changed || previousRequest.current !== request)) {
      following.current = false;
      attention.current?.scrollIntoView?.({ block: 'start' });
      position.current = viewport.current?.scrollTop || 0;
    } else update();
    selection.current = scope;
    previousRequest.current = request;
  });

  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    // The scroll box stays the same size when Markdown or a disclosure grows inside it.
    if (viewport.current) observer.observe(viewport.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [update]);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    // Growth can emit scroll events without the reader moving upward. Keep following in that case.
    if (element.scrollTop < position.current || nearBottom) following.current = nearBottom;
    position.current = element.scrollTop;
  }

  return { viewport, content, attention, onScroll, resume };
}

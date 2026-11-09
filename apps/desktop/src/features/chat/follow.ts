import { type UIEvent, useCallback, useLayoutEffect, useRef, useState } from 'react';

const atLatest = (element: HTMLDivElement) =>
  element.scrollHeight - element.scrollTop - element.clientHeight < 80;

export function useFollow(scope: string, request = '') {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const attention = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const position = useRef(0);
  const selection = useRef(scope);
  const previousRequest = useRef('');
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const update = useCallback(() => {
    const element = viewport.current;
    if (!element) return;
    if (following.current) {
      element.scrollTop = element.scrollHeight;
      position.current = element.scrollTop;
    }
    setAwayFromLatest(!following.current && !atLatest(element));
  }, []);
  const resume = useCallback(() => {
    following.current = true;
    update();
  }, [update]);
  const pause = useCallback(() => {
    following.current = false;
  }, []);
  const isFollowing = useCallback(() => following.current, []);

  // Follow actual rendered height, including final replies that replace the same message.
  useLayoutEffect(() => {
    const changed = selection.current !== scope;
    if (changed || (previousRequest.current && !request)) following.current = true;
    if (request && (changed || previousRequest.current !== request)) {
      following.current = false;
      attention.current?.scrollIntoView?.({ block: 'start' });
      position.current = viewport.current?.scrollTop || 0;
    }
    update();
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
    const nearBottom = atLatest(element);
    // Growth can emit scroll events without the reader moving upward. Keep following in that case.
    if (element.scrollTop < position.current || nearBottom) following.current = nearBottom;
    position.current = element.scrollTop;
    setAwayFromLatest(!following.current && !nearBottom);
  }

  return { viewport, content, attention, onScroll, resume, pause, isFollowing, awayFromLatest };
}

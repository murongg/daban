import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown } from 'lucide-react';
import { type ReactNode, useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { useRetention } from '../../components/collection/retention';
import { reducedMotionQuery } from '../../components/controls/motion';
import { t } from '../../i18n/locale';
import type { useFollow } from './follow';

export interface TranscriptEntry {
  id: string;
  content: ReactNode;
  persistent?: boolean;
  anchor?: boolean;
  bubbleKey?: string;
}

function Window({
  entries,
  scroll,
  loading = false,
}: {
  entries: readonly TranscriptEntry[];
  scroll: ReturnType<typeof useFollow>;
  loading?: boolean;
}) {
  const previous = useRef(entries);
  const motion = useRef({ initialized: false, loading, seen: new Set<string>() });
  const reading = useRef<{ id: string; offset: number } | undefined>(undefined);
  const keys = useMemo(() => entries.map((entry) => entry.id), [entries]);
  const persistent = useMemo(
    () => entries.filter((entry) => entry.persistent).map((entry) => entry.id),
    [entries],
  );
  const retained = useRetention(scroll.viewport, keys, persistent);
  const contentRef = useCallback(
    (element: HTMLDivElement | null) => {
      scroll.content.current = element;
    },
    [scroll.content],
  );
  const getItemKey = useCallback((index: number) => entries[index]!.id, [entries]);
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: entries.length,
    enabled: entries.length > 80,
    getScrollElement: () => scroll.viewport.current,
    estimateSize: () => 160,
    initialOffset: () => (entries.length > 80 ? entries.length * 160 : 0),
    getItemKey,
    rangeExtractor: retained.rangeExtractor,
    overscan: 5,
    anchorTo: 'end',
    followOnAppend: false,
    // Keep keyed prepend anchoring, but disable bottom pinning while the reader inspects content.
    scrollEndThreshold: scroll.isFollowing() ? 80 : -1,
    // The existing scroll box has 31px top padding; item coordinates include that inset.
    scrollMargin: 31,
    useFlushSync: false,
  });
  const items = virtualizer.getVirtualItems();
  useLayoutEffect(() => {
    const old = previous.current;
    const first = old.findIndex((entry) => entry.anchor !== false);
    const firstId = old[first]?.id;
    const shifted = firstId ? entries.findIndex((entry) => entry.id === firstId) : -1;
    const viewport = scroll.viewport.current;
    let corrected = false;
    if (
      viewport &&
      reading.current &&
      !scroll.isFollowing() &&
      entries.length > old.length &&
      shifted > first
    ) {
      const anchor = reading.current;
      const index = entries.findIndex((entry) => entry.id === anchor.id);
      const offset = index >= 0 ? virtualizer.getOffsetForIndex(index, 'start')?.[0] : undefined;
      if (offset !== undefined) {
        // Loading controls can be the library's first anchor at the top. Preserve the actual message instead.
        virtualizer.scrollToOffset(offset - anchor.offset);
        corrected = true;
      }
    }
    previous.current = entries;
    if (!viewport || corrected) return;
    const bounds = viewport.getBoundingClientRect();
    for (const row of viewport.querySelectorAll<HTMLElement>('[data-transcript-entry]')) {
      const index = Number(row.dataset.index);
      const boundsRow = row.getBoundingClientRect();
      if (
        entries[index]?.anchor !== false &&
        boundsRow.bottom > bounds.top &&
        boundsRow.top < bounds.bottom
      ) {
        reading.current = { id: entries[index]!.id, offset: boundsRow.top - bounds.top };
        break;
      }
    }
  });
  useLayoutEffect(() => {
    const state = motion.current;
    const animate =
      state.initialized &&
      !state.loading &&
      !loading &&
      scroll.isFollowing() &&
      !window.matchMedia?.(reducedMotionQuery).matches;
    state.initialized = true;
    state.loading = loading;
    // Rows inserted before the first seen bubble are older history, even if loading settled in the same commit.
    const firstSeen = entries.findIndex(({ bubbleKey }) => bubbleKey && state.seen.has(bubbleKey));
    // A run keeps its bubble key through streaming and finalization, including virtual remounts.
    entries.forEach(({ bubbleKey }, index) => {
      if (!bubbleKey || state.seen.has(bubbleKey)) return;
      state.seen.add(bubbleKey);
      if (!animate || index < firstSeen) return;
      const bubble = scroll.viewport.current?.querySelector(
        `[data-index="${index}"] .message > .bubble`,
      );
      bubble?.animate?.(
        [
          {
            transform: 'translateY(5px) scale(0.976)',
            opacity: 0.72,
            easing: 'cubic-bezier(0.18, 0.75, 0.24, 1)',
          },
          { transform: 'translateY(-1px) scale(1.008)', opacity: 1, offset: 0.62 },
          { transform: 'none', opacity: 1 },
        ],
        270,
      );
    });
  }, [entries, loading, scroll.isFollowing, scroll.viewport]);
  const measured = items.length > 0;
  const visible = measured
    ? items
    : entries.length <= 80
      ? entries.map((entry, index) => ({ key: entry.id, index, start: 31 }))
      : [];
  return (
    <div className="transcript-area">
      <div
        className="transcript"
        role="log"
        tabIndex={-1}
        aria-label={t('chat.conversationRecords')}
        aria-live={virtualizer.isScrolling ? 'off' : 'polite'}
        ref={scroll.viewport}
        onScroll={scroll.onScroll}
        onPointerDownCapture={(event) => {
          scroll.pause();
          retained.onPointerDownCapture(event);
          virtualizer.cancelScroll();
        }}
        onFocusCapture={(event) => {
          scroll.pause();
          virtualizer.cancelScroll();
          retained.onFocusCapture(event);
        }}
        onBlurCapture={retained.onBlurCapture}
      >
        <div
          className={`transcript-content${measured ? ' transcript-window' : ''}`}
          ref={contentRef}
          style={
            measured || entries.length > 80
              ? { height: virtualizer.getTotalSize(), position: 'relative' }
              : undefined
          }
        >
          {visible.map((item) => {
            const entry = entries[item.index]!;
            return (
              <div
                key={item.key}
                data-index={item.index}
                data-transcript-entry={entry.id}
                data-window-key={entry.id}
                ref={measured ? virtualizer.measureElement : undefined}
                className="transcript-row"
                style={
                  measured
                    ? {
                        position: 'absolute',
                        top: 0,
                        left: 0,
                        width: '100%',
                        transform: `translateY(${item.start - 31}px)`,
                      }
                    : undefined
                }
              >
                {entry.content}
              </div>
            );
          })}
        </div>
      </div>
      {scroll.awayFromLatest && (
        <button
          type="button"
          className="secondary transcript-return"
          onClick={() => {
            // Keep keyboard focus in the transcript when this button disappears.
            scroll.viewport.current?.focus({ preventScroll: true });
            scroll.resume();
          }}
        >
          <ArrowDown aria-hidden="true" />
          {t('chat.returnToLatest')}
        </button>
      )}
    </div>
  );
}

export function Transcript(props: {
  scope: string;
  loading?: boolean;
  entries: readonly TranscriptEntry[];
  scroll: ReturnType<typeof useFollow>;
}) {
  return <Window key={props.scope} entries={props.entries} scroll={props.scroll} />;
}

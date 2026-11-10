import { useEffect, useMemo, useState } from 'react';
import type { View } from './state';

export type Destination = { view: View; bot?: string };

function same(left: Destination, right: Destination) {
  return left.view === right.view && left.bot === right.bot;
}

export function useNavigation(view: View, selected: string, bots: readonly { id: string }[]) {
  const current = useMemo(
    () => ({ view, ...(view === 'chat' ? { bot: selected } : {}) }),
    [view, selected],
  );
  // History holds destinations only: going back must never roll back drafts, tasks or permissions.
  const [history, setHistory] = useState({ entries: [current], index: 0 });
  useEffect(() => {
    setHistory((previous) => {
      if (same(previous.entries[previous.index]!, current)) return previous;
      const entries = [...previous.entries.slice(0, previous.index + 1), current].slice(-100);
      return { entries, index: entries.length - 1 };
    });
  }, [current]);

  function find(direction: -1 | 1) {
    for (
      let index = history.index + direction;
      index >= 0 && index < history.entries.length;
      index += direction
    ) {
      const entry = history.entries[index]!;
      // Deleted Bots cannot be reopened; retained archived conversations remain readable.
      if (!entry.bot || bots.some((bot) => bot.id === entry.bot)) return index;
    }
    return -1;
  }
  const previous = find(-1);
  const next = find(1);
  function move(index: number): Destination | undefined {
    if (index < 0) return;
    setHistory({ ...history, index });
    return history.entries[index];
  }
  return {
    canBack: previous >= 0,
    canForward: next >= 0,
    back: () => move(previous),
    forward: () => move(next),
  };
}

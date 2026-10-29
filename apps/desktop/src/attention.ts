import { agentId } from '@daban/protocol';
import { type Dispatch, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { noticeCandidates, noticeKey } from '../notifications';
import type { AttentionEvent } from './organization';
import { useRuntime } from './Runtime';
import type { Action, State } from './state';

export function useAttention(state: State, dispatch: Dispatch<Action>, blocked: boolean) {
  const runtime = useRuntime();
  const snapshot = runtime.snapshot;
  const active = useRef({ bot: state.selected, view: state.view, blocked });
  useLayoutEffect(() => {
    active.current = { bot: state.selected, view: state.view, blocked };
  }, [state.selected, state.view, blocked]);
  const previous = useRef<string | undefined>(undefined);
  const ready =
    runtime.enabled && snapshot.phase === 'ready' && snapshot.notices?.available === true;
  const { notices, interactions } = snapshot;
  const events = useMemo(
    () =>
      noticeCandidates({ notices, interactions }).flatMap((target): AttentionEvent[] => {
        if (target.kind === 'settings') return [];
        const group =
          target.kind === 'group' ? target.group : 'group' in target ? target.group : undefined;
        const bot = state.bots.find((item) =>
          group
            ? !!item.members && item.id === group
            : !item.members && 'bot' in target && agentId(item.id) === target.bot,
        );
        // Unknown identities are still baselined; later profile hydration must not invent new arrivals.
        return [{ key: noticeKey(target), ...(bot ? { bot: bot.id } : {}) }];
      }),
    [notices, interactions, state.bots],
  );
  const signature = JSON.stringify(events);
  const visibleBot = useCallback(() => {
    const current = active.current;
    return current.view === 'chat' &&
      !current.blocked &&
      !document.hidden &&
      document.hasFocus() &&
      !document.getElementById('root')?.inert
      ? current.bot
      : undefined;
  }, []);
  useEffect(() => {
    if (!ready || previous.current === signature) return;
    previous.current = signature;
    dispatch({ type: 'attention', events, visible: visibleBot() });
  }, [ready, signature, events, dispatch, visibleBot]);
  useEffect(() => {
    function read() {
      const bot = visibleBot();
      if (bot) dispatch({ type: 'bot-read', bot, unread: false });
    }
    window.addEventListener('focus', read);
    document.addEventListener('visibilitychange', read);
    return () => {
      window.removeEventListener('focus', read);
      document.removeEventListener('visibilitychange', read);
    };
  }, [dispatch, visibleBot]);
}

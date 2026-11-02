import { agentId, type Group } from '@daban/protocol';
import { type Dispatch, useEffect, useRef } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import type { Action, State } from '../../app/state';

export function useGroups(
  state: State,
  dispatch: Dispatch<Action>,
  notify: (text: string) => unknown,
) {
  const runtime = useRuntime();
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (!runtime.enabled || runtime.snapshot.phase !== 'ready') {
      attempted.current.clear();
      return;
    }
    if (runtime.snapshot.protocolVersion < 15 || !runtime.snapshot.groups?.available) return;
    const known = runtime.snapshot.groups.items;
    dispatch({ type: 'groups', groups: known });
    for (const bot of state.bots) {
      // Confirmed copies may precede the next snapshot; they already own their backend identities.
      if (
        !bot.members ||
        bot.archived ||
        known.some((group) => group.id === bot.id) ||
        state.groupRevisions[bot.id] > 0
      )
        continue;
      const input = { id: bot.id, name: bot.name, members: bot.members.map(agentId) };
      if (
        !input.members.every((id) =>
          runtime.snapshot.profiles?.some((profile) => profile.id === id),
        )
      )
        continue;
      const key = JSON.stringify(input);
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      runtime
        .command<Group>({ type: 'group.register', group: input })
        .then((group) => dispatch({ type: 'groups', groups: [group] }))
        .catch((error) => notify(runtimeError(error)));
    }
  }, [
    runtime.enabled,
    runtime.snapshot,
    runtime.command,
    state.bots,
    state.groupRevisions,
    dispatch,
    notify,
  ]);
}

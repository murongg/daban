import { agentId, type BotProfileInput } from '@daban/protocol';
import { type Dispatch, useEffect, useRef } from 'react';
import { runtimeError, useRuntime } from './Runtime';
import type { Action, Bot, State } from './state';

export function profileInput(bot: Bot, memory: string): BotProfileInput {
  return {
    id: agentId(bot.id),
    name: bot.name,
    instructions: bot.role,
    memory,
    color: bot.color,
    ...(bot.model ? { model: bot.model } : {}),
  };
}
export function useProfiles(
  state: State,
  dispatch: Dispatch<Action>,
  notify: (message: string) => unknown,
) {
  const runtime = useRuntime();
  const attempted = useRef(new Set<string>());
  useEffect(() => {
    if (
      runtime.enabled &&
      runtime.snapshot.phase === 'ready' &&
      runtime.snapshot.protocolVersion >= 3
    )
      dispatch({ type: 'profiles', profiles: runtime.snapshot.profiles || [] });
  }, [runtime.enabled, runtime.snapshot, dispatch]);
  useEffect(() => {
    if (!runtime.enabled || runtime.snapshot.phase !== 'ready') {
      attempted.current.clear();
      return;
    }
    if (runtime.snapshot.protocolVersion < 3) return;
    const profiles = runtime.snapshot.profiles || [];
    const known = new Set(profiles.map((profile) => profile.id));
    for (const bot of state.bots) {
      // A confirmed copy/import can arrive before the next status snapshot; it already owns its ID.
      if (
        bot.members ||
        bot.archived ||
        known.has(agentId(bot.id)) ||
        state.profileRevisions[agentId(bot.id)] > 0
      )
        continue;
      const profile = profileInput(bot, state.memories[bot.id]);
      const key = JSON.stringify(profile);
      if (attempted.current.has(key)) continue;
      attempted.current.add(key);
      runtime
        .command({ type: 'bot.register', profile })
        .catch((error) => notify(runtimeError(error)));
    }
  }, [
    runtime.enabled,
    runtime.snapshot,
    runtime.command,
    state.bots,
    state.memories,
    state.profileRevisions,
    notify,
  ]);
}

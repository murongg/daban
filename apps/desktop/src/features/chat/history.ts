import { agentId, isChatPage, type RuntimeTaskSummary, validAgentId } from '@daban/protocol';
import { useEffect, useMemo, useRef, useState } from 'react';
import { runtimeError, useRuntime } from '../../app/Runtime';
import { type Message, reduce, type State, type WorkspaceFile } from '../../app/state';

interface Page {
  scope: string;
  messages: Message[];
  files: WorkspaceFile[];
  records: RuntimeTaskSummary[];
  cursor?: string;
  more: boolean;
  busy: boolean;
  error: string;
}
const empty = (scope: string): Page => ({
  scope,
  messages: [],
  files: [],
  records: [],
  more: true,
  busy: false,
  error: '',
});

export function useHistory(state: State, bot: string, revision: number, enabled: boolean) {
  const { command } = useRuntime();
  const scope = `${bot}:${revision}`;
  const selected = useRef(scope);
  selected.current = scope;
  const currentState = useRef(state);
  currentState.current = state;
  const mounted = useRef(true);
  const flight = useRef<{ scope: string } | undefined>(undefined);
  const [saved, setSaved] = useState(() => empty(scope));
  const page = useMemo(() => (saved.scope === scope ? saved : empty(scope)), [saved, scope]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  async function load() {
    if (!enabled || !page.more || flight.current?.scope === scope) return;
    const ticket = { scope };
    flight.current = ticket;
    setSaved({ ...page, busy: true, error: '' });
    const cached = currentState.current.messages[bot].flatMap((message) => {
      if ((message.chatRevision ?? 0) !== revision || !message.id.startsWith('runtime-result:'))
        return [];
      const id = message.id.slice('runtime-result:'.length);
      return validAgentId(id) ? [id] : [];
    });
    const before = [...cached, ...(page.cursor ? [page.cursor] : [])].sort()[0];
    try {
      const value = await command({ type: 'chat.history', bot: agentId(bot), revision, before });
      if (!mounted.current || selected.current !== scope) return;
      if (
        !isChatPage(value) ||
        value.bot !== agentId(bot) ||
        value.revision !== revision ||
        (before && value.items.some((item) => item.runId >= before))
      )
        throw new Error('INVALID_CHAT_HISTORY');
      const source = currentState.current;
      // Reuse normal task projection in an isolated view: reading history must never acknowledge a live send or clear a draft.
      let projected: State = {
        ...source,
        messages: { ...source.messages, [bot]: [] },
        runtimeRequests: { ...source.runtimeRequests, [bot]: undefined },
      };
      for (const record of value.items)
        projected = reduce(projected, { type: 'runtime-task', bot, task: record });
      const ids = new Set(source.files.map((file) => file.id));
      setSaved((current) => {
        const previous = current.scope === scope ? current : empty(scope);
        return {
          scope,
          messages: [
            ...new Map(
              [...projected.messages[bot], ...previous.messages].map((message) => [
                message.id,
                message,
              ]),
            ).values(),
          ],
          files: [
            ...new Map(
              [...previous.files, ...projected.files.filter((file) => !ids.has(file.id))].map(
                (file) => [file.id, file],
              ),
            ).values(),
          ],
          records: [
            ...new Map(
              [...value.items, ...previous.records].map((record) => [record.runId, record]),
            ).values(),
          ],
          cursor: value.nextBefore,
          more: !!value.nextBefore,
          busy: false,
          error: '',
        };
      });
    } catch (error) {
      if (mounted.current && selected.current === scope)
        setSaved((current) => ({
          ...(current.scope === scope ? current : empty(scope)),
          busy: false,
          error: runtimeError(error),
        }));
    } finally {
      if (flight.current === ticket) flight.current = undefined;
    }
  }
  return { ...page, more: enabled && page.more, load };
}

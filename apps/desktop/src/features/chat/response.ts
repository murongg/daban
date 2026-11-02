import type { RunInsert, RuntimeTask } from '@daban/protocol';
import type { Message } from '../../app/state';

export interface DisplayMessage extends Message {
  streaming?: boolean;
}
// Accepted inserts that never became a turn have no saved bubble, so a restored task must show them from its own state.
export function pendingInserts(task: RuntimeTask): RunInsert[] {
  const turns = new Set((task.turns || []).map((turn) => turn.id));
  return (task.inserts || []).filter((insert) => !insert.done && !turns.has(insert.id));
}
export function visibleMessages(messages: Message[], task?: RuntimeTask): DisplayMessage[] {
  if (!task?.runId) return messages;
  let entries: DisplayMessage[] = messages;
  for (const insert of pendingInserts(task)) {
    const id = `inserted:${insert.id}`;
    if (entries.some((message) => message.id === id)) continue;
    entries = [...entries, { id, role: 'user', text: insert.text }];
  }
  const resultId = `runtime-result:${task.runId}`;
  if (task.phase === 'completed')
    return task.result && !entries.some((message) => message.id === resultId)
      ? [...entries, { id: resultId, role: 'bot', text: task.result }]
      : entries;
  if (!task.response?.text) return entries;
  const current = task.turns?.at(-1);
  const attributed = task.response.turnId;
  // A response without a turn id is inferred: a settled one belongs to the previous turn while the current one waits.
  if (
    !attributed &&
    task.running &&
    current &&
    !current.result &&
    task.response.state === 'settled'
  )
    return entries;
  // Text attributed to an earlier turn is already rendered from that turn's saved reply.
  if (attributed && current && attributed !== current.id) return entries;
  const incomplete = ['failed', 'stopped', 'interrupted'].includes(task.phase) || !task.running;
  const id = incomplete ? `runtime-partial:${task.runId}` : resultId;
  if (entries.some((message) => message.id === id)) return entries;
  const response: DisplayMessage = {
    id,
    role: 'bot',
    text: task.response.text,
    ...(incomplete ? { incomplete: true } : { streaming: true }),
  };
  // The reply belongs to its own turn, so it stays before inserts that were accepted but not executed yet.
  const owner = attributed ?? current?.id;
  const userId =
    owner === undefined
      ? undefined
      : owner === task.requestId
        ? task.requestId
        : `inserted:${owner}`;
  const start = userId ? entries.findIndex((message) => message.id === userId) : -1;
  let index = entries.findIndex((message) => message.id === resultId);
  if (index < 0 && start >= 0)
    index = entries.findIndex((message, position) => position > start && message.role === 'user');
  if (index < 0) index = entries.length;
  return [...entries.slice(0, index), response, ...entries.slice(index)];
}

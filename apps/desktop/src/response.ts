import type { RuntimeTask } from '@daban/protocol';
import type { Message } from './state';

export interface DisplayMessage extends Message {
  streaming?: boolean;
}
export function visibleMessages(messages: Message[], task?: RuntimeTask): DisplayMessage[] {
  if (!task?.runId) return messages;
  const resultId = `runtime-result:${task.runId}`;
  if (task.phase === 'completed')
    return task.result && !messages.some((message) => message.id === resultId)
      ? [...messages, { id: resultId, role: 'bot', text: task.result }]
      : messages;
  if (!task.response?.text) return messages;
  const incomplete = ['failed', 'stopped', 'interrupted'].includes(task.phase) || !task.running;
  const id = incomplete ? `runtime-partial:${task.runId}` : resultId;
  if (messages.some((message) => message.id === id)) return messages;
  const response: DisplayMessage = {
    id,
    role: 'bot',
    text: task.response.text,
    ...(incomplete ? { incomplete: true } : { streaming: true }),
  };
  const index = messages.findIndex((message) => message.id === resultId);
  return index >= 0
    ? [...messages.slice(0, index), response, ...messages.slice(index)]
    : [...messages, response];
}

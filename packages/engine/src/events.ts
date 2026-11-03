import { isTaskPlan, type TaskPlan } from '@daban/protocol';
import type { ToolRun, ToolTrace } from './computer-tools.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function observeTools(run: ToolRun, session: string, onPlan?: (plan: TaskPlan) => unknown) {
  const calls = new Map<string, ToolTrace>();
  return (note: unknown) => {
    if (
      !record(note) ||
      note.method !== 'session.event' ||
      !record(note.params) ||
      note.params.sessionId !== session ||
      !record(note.params.event)
    )
      return;
    const event = note.params.event;
    if (!record(event.data)) return;
    const data = event.data;
    if (event.type === 'todo/write' && isTaskPlan(data.todos))
      onPlan?.(structuredClone(data.todos));
    if (
      event.type === 'tool/call' &&
      [
        'web_fetch',
        'web_search',
        'ask_user_question',
        'todo_write',
        'skill',
        'get_goal',
        'create_goal',
        'update_goal',
      ].includes(String(data.name)) &&
      typeof data.callId === 'string' &&
      data.callId.length <= 200 &&
      !calls.has(data.callId)
    ) {
      // Only public execution metadata crosses into client status; URLs, page bodies and SDK payloads stay private.
      const trace: ToolTrace = {
        name: String(data.name),
        surface: ['web_fetch', 'web_search'].includes(String(data.name))
          ? 'web'
          : ['get_goal', 'create_goal', 'update_goal'].includes(String(data.name))
            ? 'goal'
            : data.name === 'skill'
              ? 'skill'
              : data.name === 'todo_write'
                ? 'plan'
                : 'human',
        phase: 'running',
        at: new Date().toISOString(),
      };
      calls.set(data.callId, trace);
      run.trace.push(trace);
      if (++run.toolCount > run.limit) run.onLimit?.();
    } else if (
      event.type === 'tool/result' &&
      record(data.message) &&
      typeof data.message.toolCallId === 'string'
    ) {
      if (data.message.isError === true && record(data.error) && data.error.code === 'TOOL_LIMIT')
        run.onLimit?.();
      const trace = calls.get(data.message.toolCallId);
      if (trace?.phase !== 'running') return;
      trace.phase = data.message.isError ? 'rejected' : 'settled';
      if (
        record(data.error) &&
        typeof data.error.code === 'string' &&
        /^[A-Z][A-Z0-9_]{0,80}$/.test(data.error.code)
      )
        trace.code = data.error.code;
    }
  };
}

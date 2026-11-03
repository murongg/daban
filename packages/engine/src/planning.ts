export const name = 'daban-planning';
export const inject = ['agents', 'tools', 'planMode'];
interface Agent {
  id: string;
}
interface Context {
  agents: { roots(): Agent[] };
  planMode: {
    set(agent: Agent, active: boolean): unknown;
    get(agent: Agent): { active: boolean; pending?: boolean };
  };
  on(event: 'agent/created', listener: (payload: { agent: Agent }) => unknown): unknown;
  tools: {
    guard(
      check: (exec: { agent?: Agent; name: string; arguments?: unknown }) => string | undefined,
    ): unknown;
  };
}
export function planningCommand(prompt: string) {
  const text = prompt.trimStart();
  if (!/^\/plan(?:\s|$)/.test(text)) return;
  return !/^\/plan\s+off(?:\s|$)/.test(text);
}
export function projectPlanning(value: unknown, session: string) {
  const note = value as {
    method?: string;
    params?: { sessionId?: string; event?: { type?: string; data?: { active?: unknown } } };
  } | null;
  if (
    note?.method === 'session.event' &&
    note.params?.sessionId === session &&
    note.params.event?.type === 'plan/mode' &&
    typeof note.params.event.data?.active === 'boolean'
  )
    return note.params.event.data.active;
}
const reads = new Set([
  'web_search',
  'web_fetch',
  'skill',
  'todo_write',
  'ask_user_question',
  'exit_plan_mode',
  ...[
    'list_files',
    'read_file',
    'read_image',
    'screenshot',
    'browser_snapshot',
    'bot_history_search',
    'bot_history_read',
    'bot_tool_result_read',
    'bot_memory_read',
    'bot_knowledge_search',
    'bot_knowledge_read',
    'bot_notes_list',
    'bot_notes_read',
    'work_list',
    'work_read',
    'bot_schedule_list',
    'task_catalog',
  ].map((name) => `mcp__computer__${name}`),
]);
export function apply(ctx: Context, config: { active: boolean }) {
  ctx.on('agent/created', ({ agent }) => {
    if (ctx.agents.roots()[0] === agent) ctx.planMode.set(agent, config.active);
  });
  ctx.tools.guard((exec) => {
    const roots = ctx.agents.roots();
    if (roots.length !== 1 || !exec.agent) return 'PLAN_CONTEXT_UNAVAILABLE';
    const state = ctx.planMode.get(roots[0]);
    // Approval queues exit for the next step. Calls remaining in its original batch must stay read-only.
    if (!state.active && state.pending !== true) return;
    if (exec.name === 'exit_plan_mode') {
      const args = exec.arguments;
      if (
        args &&
        typeof args === 'object' &&
        'plan' in args &&
        typeof args.plan === 'string' &&
        args.plan.length > 4000
      )
        return 'PLAN_REVIEW_TOO_LONG';
    }
    return reads.has(exec.name) ? undefined : 'PLAN_MODE_READ_ONLY';
  });
}

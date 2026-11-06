export const name = 'daban-delegation';
export const inject = ['agents', 'tools', 'subagents'];
interface Agent {
  id: string;
}
interface Execution {
  agent?: Agent;
  name: string;
  arguments?: unknown;
}
interface Context {
  agents: {
    roots(): Agent[];
    get(id: string): Agent | undefined;
    isOwnedBy(id: string, owner: Agent): boolean;
  };
  subagents: { waitForChildren(agent: Agent): Promise<boolean> };
  on(
    event: 'agent/turn-stopping',
    listener: (payload: { agent: Agent; signal: AbortSignal }) => Promise<unknown>,
  ): unknown;
  tools: { guard(check: (exec: Execution) => string | undefined): unknown };
}
const reads = new Set([
  'web_search',
  'web_fetch',
  'todo_write',
  'skill',
  ...[
    'list_files',
    'read_file',
    'read_image',
    'bot_history_search',
    'bot_history_read',
    'bot_tool_result_read',
    'bot_knowledge_search',
    'bot_knowledge_read',
    'bot_memory_read',
    'work_list',
    'work_read',
    'bot_notes_list',
    'bot_notes_read',
    'task_catalog',
  ].map((name) => `mcp__computer__${name}`),
]);
export function apply(ctx: Context) {
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (ctx.agents.roots()[0] !== agent || signal.aborted) return;
    // SDK run() settles at root idle. Join readers before that boundary so its finalizer cannot cancel unfinished children.
    await ctx.subagents.waitForChildren(agent);
    signal.throwIfAborted();
  });
  // A monotonic guard runs after extensible approval hooks; no later listener can re-enable a delegated write.
  ctx.tools.guard((exec) => {
    const roots = ctx.agents.roots(),
      agent = exec.agent;
    if (roots.length !== 1 || !agent || ctx.agents.get(agent.id) !== agent)
      return 'DELEGATION_OWNER_UNAVAILABLE';
    const root = roots[0];
    if (agent === root) return;
    if (!ctx.agents.isOwnedBy(agent.id, root)) return 'DELEGATION_OWNER_UNAVAILABLE';
    const args = exec.arguments;
    if (
      exec.name === 'send_message' &&
      args &&
      typeof args === 'object' &&
      'agent_id' in args &&
      args.agent_id === root.id
    )
      return;
    return reads.has(exec.name) ? undefined : 'DELEGATION_READ_ONLY';
  });
}

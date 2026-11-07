export const name = 'daban-delegation';
export const inject = ['agents', 'tools', 'subagents'];
interface Agent {
  id: string;
  session?: { id: string };
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
function ownedRoot(agents: Context['agents'], candidate: unknown) {
  const roots = agents.roots();
  if (
    roots.length !== 1 ||
    !candidate ||
    typeof candidate !== 'object' ||
    !('id' in candidate) ||
    typeof candidate.id !== 'string' ||
    agents.get(candidate.id) !== candidate
  )
    return undefined;
  const root = roots[0];
  if (agents.get(root.id) !== root) return undefined;
  return candidate === root || agents.isOwnedBy(candidate.id, root) ? root : undefined;
}
export function readOwner(agents: Context['agents'], candidate: unknown, tool: string) {
  // Root-session mapping carries read authority only; the real execution agent keeps its write guard.
  return reads.has(tool) ? ownedRoot(agents, candidate) : undefined;
}
export function apply(ctx: Context) {
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (ctx.agents.roots()[0] !== agent || signal.aborted) return;
    // SDK run() settles at root idle. Join readers before that boundary so its finalizer cannot cancel unfinished children.
    await ctx.subagents.waitForChildren(agent);
    signal.throwIfAborted();
  });
  // A monotonic guard runs after extensible approval hooks; no later listener can re-enable a delegated write.
  ctx.tools.guard((exec) => {
    const agent = exec.agent;
    const root = ownedRoot(ctx.agents, agent);
    if (!root || !agent) return 'DELEGATION_OWNER_UNAVAILABLE';
    if (agent === root) return;
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

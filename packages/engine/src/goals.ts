import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { type GoalProgress, isGoalProgress } from '@daban/protocol';
import { type BridgeConfig, callBridge } from './bridge.js';
import { runtimeRequire } from './dsh.js';

export const name = 'daban-goals';
export const inject = ['agents', 'goals', 'sessions', 'tools'];
type Command =
  | { action: 'create'; objective: string }
  | { action: 'resume' | 'pause' | 'status' | 'clear' };
export function goalCommand(prompt: string): Command | undefined {
  const text = prompt.trimStart().replace(/^\/ptc\s+/, '');
  if (!/^\/goal(?:\s|$)/.test(text)) return;
  const body = text.replace(/^\/goal\s*/, '').trim();
  const control = /^(resume|pause|status|clear)(?:\s|$)/.exec(body)?.[1];
  if (control) return { action: control as 'resume' | 'pause' | 'status' | 'clear' };
  const objective = body.replace(/^create(?:\s|$)/, '').trim();
  return objective ? { action: 'create', objective } : { action: 'status' };
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function goalView(
  value: unknown,
  clean: (text: string) => string,
): GoalProgress | undefined {
  if (!object(value) || typeof value.objective !== 'string') return;
  const reason =
    object(value.blockedReason) && typeof value.blockedReason.message === 'string'
      ? value.blockedReason.message
      : undefined;
  const row = {
    id: value.id,
    revision: value.revision,
    // Redact complete strings before clipping; clipping first can expose a known credential's prefix.
    objective: Array.from(clean(value.objective)).slice(0, 500).join(''),
    phase: value.phase,
    activation: value.activation,
    rounds: value.roundsStarted,
    limit: value.maxGoalRounds,
    ...(reason ? { reason: Array.from(clean(reason)).slice(0, 500).join('') } : {}),
  };
  return isGoalProgress(row) ? row : undefined;
}
export function goalOperation(note: unknown, session: string) {
  if (
    !object(note) ||
    note.method !== 'session.event' ||
    !object(note.params) ||
    note.params.sessionId !== session ||
    !object(note.params.event) ||
    note.params.event.type !== 'goal/change' ||
    !object(note.params.event.data)
  )
    return;
  return note.params.event.data.operation;
}
export function projectGoal(
  note: unknown,
  session: string,
  previous: GoalProgress | undefined,
  clean: (text: string) => string,
): GoalProgress | null | undefined {
  if (
    !object(note) ||
    note.method !== 'session.event' ||
    !object(note.params) ||
    note.params.sessionId !== session ||
    !object(note.params.event) ||
    !object(note.params.event.data)
  )
    return;
  const event = note.params.event,
    data = event.data as Record<string, unknown>;
  if (event.type === 'goal/change') {
    if (data.operation === 'clear') return null;
    if (!object(data.goal)) return;
    return goalView(
      {
        ...data.goal,
        roundsStarted: data.roundsStarted,
        activation: ['create', 'resume'].includes(String(data.operation))
          ? 'armed'
          : data.goal.phase === 'active'
            ? (previous?.activation ?? 'disarmed')
            : 'disarmed',
      },
      clean,
    );
  }
  if (
    event.type === 'user/message' &&
    previous &&
    object(data.source) &&
    data.source.kind === 'goal' &&
    Number(data.source.round) > 0 &&
    data.source.goalId === previous.id &&
    data.source.revision === previous.revision &&
    Number.isSafeInteger(data.source.round) &&
    Number(data.source.round) <= previous.limit
  )
    return { ...previous, rounds: Number(data.source.round) };
}
interface Message {
  id: string;
  content: unknown;
  source: { kind: string; goalId?: string; revision?: number; round?: number };
}
interface Agent {
  id: string;
  session: { id: string };
  ctx: { tools: { restrict(filter: { deny: string[] }): unknown } };
  inbox: {
    nextStep: readonly Message[];
    nextTurn: readonly Message[];
    prepend(target: 'next-step', message: Message): unknown;
    remove(id: string): unknown;
  };
  followup(message: Message): unknown;
}
interface View {
  id: string;
  revision: number;
  objective: string;
  phase: string;
  activation: string;
  roundsStarted: number;
  maxGoalRounds: number;
}
type Decision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: Message[]; startsRequestSeries?: true };
interface Context {
  agents: { roots(): Agent[]; get(id: string): Agent | undefined };
  goals: {
    get(agent: Agent): View | undefined;
    disarm(agent: Agent): unknown;
    resume(agent: Agent, ref: View): unknown;
    pause(agent: Agent, ref: View): unknown;
    clear(agent: Agent, ref: View): unknown;
    block(agent: Agent, ref: View, reason: { code: string; message: string }): unknown;
  };
  sessions: { flush(session: Agent['session']): Promise<unknown> };
  tools: {
    guard(
      check: (exec: { agent?: Agent; name: string; arguments?: unknown }) => string | undefined,
    ): unknown;
  };
  on(event: 'agent/created', callback: (payload: { agent: Agent }) => unknown): unknown;
  on(
    event: 'agent/pre-step',
    callback: (
      payload: { agent: Agent; messages: Message[]; signal: AbortSignal },
      next: () => Promise<Decision>,
    ) => Promise<Decision>,
  ): unknown;
  on(
    event: 'agent/turn-stopping',
    callback: (payload: { agent: Agent; signal: AbortSignal }) => Promise<unknown>,
  ): unknown;
  effect(factory: () => () => unknown): unknown;
  get(name: string): { waitForChildren(agent: Agent): Promise<boolean> } | undefined;
}
export async function apply(
  ctx: Context,
  config: BridgeConfig & { sdkFile: string; command?: Command; retry?: boolean },
) {
  const runtime = runtimeRequire(config.sdkFile);
  const { createUserMessage } = await import(
    pathToFileURL(runtime.resolve('@deepseek-ai/dsh-llm')).href
  );
  const { renderGoalRoundPrompt } = await import(
    pathToFileURL(runtime.resolve('@deepseek-ai/dsh-goal-round-driver')).href
  );
  const pending = new Map<Agent, Message>();
  let attempted = false,
    cleared = false;
  const root = (agent: Agent) =>
    ctx.agents.roots().length === 1 &&
    ctx.agents.roots()[0] === agent &&
    ctx.agents.get(agent.id) === agent;
  const continuing = config.command?.action === 'create' || config.command?.action === 'resume';
  ctx.on('agent/created', ({ agent }) => {
    if (!root(agent) || !continuing || config.retry)
      agent.ctx.tools.restrict({ deny: ['create_goal', 'update_goal'] });
    else if (config.command?.action === 'resume')
      agent.ctx.tools.restrict({ deny: ['create_goal'] });
  });
  ctx.tools.guard((exec) => {
    if (config.retry && config.command && !['get_goal', 'ask_user_question'].includes(exec.name))
      return 'GOAL_RETRY_READ_ONLY';
    if (!['create_goal', 'update_goal'].includes(exec.name)) return;
    if (!exec.agent || !root(exec.agent) || !config.command) return 'GOAL_HUMAN_COMMAND_REQUIRED';
    const args = object(exec.arguments) ? exec.arguments : {};
    if (
      args.max_goal_rounds !== undefined &&
      (!Number.isSafeInteger(args.max_goal_rounds) ||
        Number(args.max_goal_rounds) < 1 ||
        Number(args.max_goal_rounds) > 3)
    )
      return 'GOAL_ROUND_LIMIT';
    if (exec.name === 'create_goal') {
      if (config.command.action !== 'create') return 'GOAL_HUMAN_COMMAND_REQUIRED';
      if (
        typeof args.objective !== 'string' ||
        args.objective.trim() !== config.command.objective ||
        args.objective.includes('\0')
      )
        return 'GOAL_OBJECTIVE_MISMATCH';
      // Admission may be followed by an uncertain SDK/storage failure. Never blindly create again in this accepted task.
      if (attempted) return 'GOAL_ALREADY_ATTEMPTED';
      attempted = true;
      return;
    }
    const action = args.action;
    if (continuing && ['complete', 'blocked'].includes(String(action))) return;
    return 'GOAL_HUMAN_COMMAND_REQUIRED';
  });
  const restore = (agent: Agent, messages: Message[]) => {
    for (const message of [...messages].reverse())
      if (
        message.source.kind !== 'goal' &&
        ![...agent.inbox.nextStep, ...agent.inbox.nextTurn].some((item) => item.id === message.id)
      )
        agent.inbox.prepend('next-step', message);
  };
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next): Promise<Decision> => {
    if (!root(agent)) return next();
    const submitted = messages.find(
      (message) => message.source.kind === 'goal' && Number(message.source.round) > 0,
    );
    const valid = () => {
      const owned = pending.get(agent),
        goal = ctx.goals.get(agent);
      return (
        continuing &&
        !config.retry &&
        !!owned &&
        !!submitted &&
        owned.id === submitted.id &&
        isDeepStrictEqual(owned.content, submitted.content) &&
        isDeepStrictEqual(owned.source, submitted.source) &&
        goal?.phase === 'active' &&
        goal.activation === 'armed' &&
        goal.id === submitted.source.goalId &&
        goal.revision === submitted.source.revision &&
        submitted.source.round === goal.roundsStarted + 1
      );
    };
    if (submitted && !valid()) {
      pending.delete(agent);
      ctx.goals.disarm(agent);
      restore(agent, messages);
      return { kind: 'reject' };
    }
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    if (submitted && (!valid() || signal.aborted)) {
      pending.delete(agent);
      restore(agent, decision.messages ?? []);
      return { kind: 'reject' };
    }
    if (submitted) pending.delete(agent);
    if (
      config.command &&
      ['clear', 'pause', 'resume'].includes(config.command.action) &&
      !config.retry &&
      !cleared &&
      messages.some((message) => message.source.kind === 'user')
    ) {
      cleared = true;
      const current = ctx.goals.get(agent);
      if (current) {
        if (config.command.action === 'clear') ctx.goals.clear(agent, current);
        else if (config.command.action === 'pause') ctx.goals.pause(agent, current);
        else ctx.goals.resume(agent, current);
      }
    }
    // A fresh canonical observation keeps stopped goals recoverable without treating the client cache as goal authority.
    await callBridge(
      config,
      'goal.observe',
      { sessionId: agent.session.id, goal: ctx.goals.get(agent) ?? null },
      signal,
    );
    return submitted ? { ...decision, startsRequestSeries: true } : decision;
  });
  ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
    if (!root(agent) || !continuing || config.retry || signal.aborted || pending.has(agent)) return;
    await ctx.get('subagents')?.waitForChildren(agent);
    if (agent.inbox.nextStep.length || agent.inbox.nextTurn.length) return;
    const before = ctx.goals.get(agent);
    if (!before || before.phase !== 'active' || before.activation !== 'armed') return;
    await ctx.sessions.flush(agent.session);
    signal.throwIfAborted();
    const goal = ctx.goals.get(agent);
    if (
      !root(agent) ||
      !goal ||
      goal.id !== before.id ||
      goal.revision !== before.revision ||
      goal.phase !== 'active' ||
      goal.activation !== 'armed'
    )
      return;
    if (goal.roundsStarted >= Math.min(goal.maxGoalRounds, 3)) {
      ctx.goals.block(agent, goal, {
        code: 'round-limit',
        message: 'The accepted task reached its configured goal continuation limit.',
      });
      return;
    }
    const message = createUserMessage({
      content: renderGoalRoundPrompt(goal, goal.roundsStarted + 1),
      source: {
        kind: 'goal',
        goalId: goal.id,
        revision: goal.revision,
        round: goal.roundsStarted + 1,
      },
    }) as Message;
    pending.set(agent, message);
    // Unlike the standalone idle driver, this follow-up inherits the SDK request owner and must finish before ModelRuns closes it.
    await agent.followup(message);
  });
  ctx.effect(() => () => {
    for (const [agent, message] of pending)
      if (ctx.agents.get(agent.id) === agent) {
        ctx.goals.disarm(agent);
        agent.inbox.remove(message.id);
      }
    pending.clear();
  });
}

import { randomUUID } from 'node:crypto';
import {
  type Interaction,
  type InteractionInput,
  isInteraction,
  isInteractionInput,
  publicUrl,
} from '@daban/protocol';
import { type BridgeConfig as Config, callBridge, type BridgeFetch as Fetch } from './bridge.js';
export async function waitForReply(
  config: Config,
  input: InteractionInput,
  signal: AbortSignal,
  request: Fetch = fetch,
): Promise<Interaction> {
  if (!isInteractionInput(input)) throw new Error('INVALID_INTERACTION');
  const call = async (method: string, params: unknown) => {
    const value = { result: await callBridge(config, method, params, signal, request) };
    if (
      !isInteraction(value.result) ||
      value.result.id !== input.id ||
      value.result.sessionId !== input.sessionId ||
      value.result.bot !== new URL(config.url).pathname.split('/').at(-1)
    )
      throw new Error('INVALID_INTERACTION');
    const {
      bot: _bot,
      runId: _run,
      status: _status,
      reply: _reply,
      createdAt: _created,
      updatedAt: _updated,
      conversationId: _conversation,
      decisionSource: _source,
      ...original
    } = value.result;
    if (JSON.stringify(original) !== JSON.stringify(input)) throw new Error('INVALID_INTERACTION');
    return value.result;
  };
  let current = await call('interaction.open', input);
  const run = current.runId;
  const conversation = current.conversationId;
  while (current.status === 'pending') {
    current = await call('interaction.wait', { id: input.id });
    // Scope is server-owned metadata; pin it with the run so a late response cannot cross conversations.
    if (current.runId !== run || current.conversationId !== conversation)
      throw new Error('INVALID_INTERACTION');
  }
  return current;
}
export const name = 'daban-human';
export const inject = ['userQuestions', 'approval'];
interface Context {
  on: (event: string, callback: (request: unknown) => Promise<unknown>) => unknown;
}
interface Request {
  agent?: { session: { id: string } };
  questions?: unknown;
  signal?: AbortSignal;
  toolName?: string;
  reason?: string;
}
export function apply(ctx: Context, config: Config) {
  ctx.on('user-questions/request', async (value) => {
    const request = value as Request;
    const input: unknown = {
      id: randomUUID(),
      sessionId: request.agent?.session.id,
      kind: 'question',
      questions: request.questions,
    };
    if (!isInteractionInput(input)) throw new Error('INVALID_INTERACTION');
    const result = await waitForReply(
      config,
      input,
      request.signal || new AbortController().signal,
    );
    if (result.status !== 'resolved' || result.reply?.kind !== 'answer')
      throw new Error('ASK_ABORTED');
    return { answers: result.reply.answers };
  });
  ctx.on('approval/request', async (value) => {
    const request = value as Request;
    if (request.toolName !== 'web_fetch' || !request.agent?.session.id) return 'unavailable';
    let reason: unknown;
    try {
      reason = JSON.parse(request.reason || 'null');
    } catch {
      return 'unavailable';
    }
    if (
      !reason ||
      typeof reason !== 'object' ||
      !('url' in reason) ||
      Object.keys(reason).length !== 1 ||
      !publicUrl(reason.url)
    )
      return 'unavailable';
    const input: InteractionInput = {
      id: randomUUID(),
      sessionId: request.agent.session.id,
      kind: 'approval',
      tool: 'web_fetch',
      url: reason.url,
    };
    const result = await waitForReply(
      config,
      input,
      request.signal || new AbortController().signal,
    );
    return result.status === 'resolved' && result.reply?.kind === 'decision'
      ? result.reply.allow
        ? 'allowed-once'
        : 'rejected'
      : 'cancelled';
  });
}

import { createHash } from 'node:crypto';
import { isBotProfileInput, validAgentId } from '@daban/protocol';
import type { AgentToolRun } from './agent-tools.js';
import { Fault } from './control.js';
import type { BotProfiles } from './profiles.js';

export class BotTools {
  readonly surface = 'bot';
  readonly fields: Record<string, string[]> = { bot_create: ['name', 'instructions', 'color'] };
  readonly list = [
    {
      name: 'bot_create',
      description:
        'Create one ordinary persistent Bot only when the current Human asks for a new assistant. Supply its name and role; optional color defaults to violet. No private memory, model override, skills, computer authority, task dispatch or gallery publication is copied. The sidebar receives the saved profile. Exact retries in this task return the same identity, including later Human edits; changed arguments conflict. An archived result stays archived. Gallery template installation uses its own workflow.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 30 },
          instructions: { type: 'string', maxLength: 4000 },
          color: { type: 'string', enum: ['mint', 'violet', 'orange', 'blue', 'teal', 'pink'] },
        },
        required: ['name', 'instructions'],
        additionalProperties: false,
      },
    },
  ];
  constructor(readonly profiles: BotProfiles) {}
  async invoke(run: AgentToolRun, name: string, args: Record<string, unknown>) {
    run.abort.signal.throwIfAborted();
    const intent = run.intentId ?? run.id;
    if (!run.task || !validAgentId(run.id) || !validAgentId(intent) || !validAgentId(run.bot))
      throw new Fault('MODEL_RUN_UNKNOWN');
    if (
      name !== 'bot_create' ||
      !args ||
      typeof args !== 'object' ||
      Array.isArray(args) ||
      Object.keys(args).some((key) => !this.fields.bot_create.includes(key))
    )
      throw new Fault('INVALID_TOOL_ARGS', 400);
    // The durable intent survives physical run retries; names must not generate a second identity.
    const id = `bot-${createHash('sha256')
      .update(JSON.stringify([run.bot, run.conversationId ?? null, intent]))
      .digest('hex')
      .slice(0, 60)}`;
    const input = {
      id,
      name: args.name,
      instructions: args.instructions,
      memory: '',
      color: args.color === undefined ? 'violet' : args.color,
    };
    if (!isBotProfileInput(input)) throw new Fault('INVALID_TOOL_ARGS', 400);
    input.name = input.name.trim();
    const profile = await this.profiles.register(input, {
      bot: run.bot,
      signal: run.abort.signal,
      origin: { id, sha256: createHash('sha256').update(JSON.stringify(input)).digest('hex') },
    });
    // A retry can observe later Human edits; never return that Bot's private memory or model settings.
    return {
      id: profile.id,
      name: profile.name,
      instructions: profile.instructions,
      color: profile.color,
      revision: profile.revision,
      archived: profile.archived ?? false,
    };
  }
}

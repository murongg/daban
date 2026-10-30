import { createHash } from 'node:crypto';
import { validAgentId } from '@daban/protocol';
import type { AgentToolRun } from './agent-tools.js';
import { Fault } from './control.js';

export function effectId(
  run: Pick<AgentToolRun, 'bot' | 'id' | 'intentId'>,
  domain: 'work' | 'note',
  kind: 'item' | 'operation',
  key: string,
) {
  const intent = run.intentId ?? run.id;
  if (!validAgentId(run.bot) || !validAgentId(intent)) throw new Fault('INVALID_TOOL_ARGS', 400);
  // The Work tuple predates this shared helper; preserve it so accepted effects keep their old IDs.
  return `${domain}-${createHash('sha256')
    .update(JSON.stringify([`daban.${domain}.model.v1`, kind, run.bot, intent, key]))
    .digest('hex')}`;
}

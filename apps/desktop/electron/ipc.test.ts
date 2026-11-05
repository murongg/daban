import { expect, it } from 'vitest';
import { parseCommand } from './ipc';

it('requires explicit confirmation for an Agent upgrade and rejects restart paths or process IDs', () => {
  expect(parseCommand({ type: 'agent.upgrade', confirmed: true })).toEqual({
    type: 'agent.upgrade',
    confirmed: true,
  });
  for (const input of [
    { type: 'agent.upgrade' },
    { type: 'agent.upgrade', confirmed: false },
    { type: 'agent.upgrade', confirmed: true, pid: 424242 },
  ])
    expect(() => parseCommand(input)).toThrow();
});

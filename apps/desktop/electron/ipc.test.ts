import { expect, it } from 'vitest';
import { parseCommand } from './ipc';

it('accepts bounded explicit preflight commands without widening old diagnostics', () => {
  const read = { id: 'mock-preflight', digest: 'a'.repeat(64) };
  for (const command of [
    { type: 'preflight.options', query: { bot: 'mock-bot' } },
    {
      type: 'preflight.inspect',
      query: {
        id: 'mock-preflight',
        bot: 'mock-bot',
        requirements: [{ kind: 'model', vision: false, tools: true }],
      },
    },
    { type: 'preflight.preview', query: read },
    { type: 'preflight.export', query: read },
  ])
    expect(() => parseCommand(command)).not.toThrow();
  expect(parseCommand({ type: 'runtime.inspect' })).toEqual({ type: 'runtime.inspect' });
  expect(() => parseCommand({ type: 'runtime.inspect', query: read })).toThrow('INVALID_COMMAND');
});

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

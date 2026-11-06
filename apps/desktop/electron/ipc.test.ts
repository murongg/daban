import { expect, it } from 'vitest';
import { parseCommand } from './ipc';

it('accepts validated template commands while rejecting added fields and unsafe sources', () => {
  const command = { type: 'gallery.sources' };
  expect(parseCommand(command)).toEqual(command);
  expect(() => parseCommand({ ...command, path: '/SYNTHETIC' })).toThrow();
  expect(() =>
    parseCommand({ type: 'gallery.source.save', origin: 'file:///SYNTHETIC' }),
  ).toThrow();
});

it('accepts an explicit Bot approval-rule listing without accepting authority from the renderer', () => {
  const input: unknown = {
    type: 'approval.rules.list',
    scope: { kind: 'bot', bot: 'mock-bot' },
  };
  expect(parseCommand(input)).toEqual(input);
  expect(() => parseCommand({ ...(input as object), decisionSource: 'rule' })).toThrow(
    'INVALID_COMMAND',
  );
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

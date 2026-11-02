import { expect, it } from 'vitest';
import { isUpdateMessage, parseUpdateCommand } from './updates';

it('allows only finite update commands and validated state snapshots', () => {
  expect(parseUpdateCommand({ type: 'check' })).toEqual({ type: 'check' });
  for (const value of [
    { type: 'install', url: 'https://models.example.test/payload' },
    { type: 'shell' },
    { type: 'saved', id: 'wrong', success: true },
  ])
    expect(() => parseUpdateCommand(value)).toThrow();
  expect(
    isUpdateMessage({
      type: 'status',
      status: { phase: 'downloading', version: '1.0.0', percent: 42 },
    }),
  ).toBe(true);
  expect(
    isUpdateMessage({
      type: 'status',
      status: { phase: 'downloading', version: '1.0.0', percent: Infinity },
    }),
  ).toBe(false);
});

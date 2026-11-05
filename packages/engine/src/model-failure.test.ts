import { expect, test } from 'vitest';
import { modelFailure, turnFailure } from './model-failure.js';

test('model failure routes only structured provider facts and never a message or stop reason', () => {
  for (const [value, expected] of [
    [{ code: 'AUTH' }, 'auth'],
    [{ code: 'QUOTA' }, 'quota'],
    [{ code: 'ACCOUNT_QUOTA' }, 'quota'],
    [{ code: 'RATE_LIMIT' }, 'rate-limit'],
    [{ code: 'SERVER' }, 'unavailable'],
    [{ code: 'TIMEOUT' }, 'timeout'],
    [{ status: 401 }, 'auth'],
    [{ status: 402 }, 'quota'],
    [{ status: 429 }, 'rate-limit'],
    [{ status: 503 }, 'unavailable'],
    [{ code: 'ABORTED', status: 503 }, 'unknown'],
    [{ code: 'INVALID_REQUEST', status: 503 }, 'unknown'],
    [{ code: 'TOOL_LIMIT' }, 'unknown'],
    [{ code: 'MODEL_TIME_LIMIT' }, 'unknown'],
    [{ message: 'Synthetic 401 quota timeout' }, 'unknown'],
    [{ code: 'PI_AI_ERROR' }, 'unknown'],
  ] as const)
    expect(modelFailure(value)).toBe(expected);
});

test('turn failures use the last owned structured terminal event rather than text or a previously recovered failure', () => {
  const failed = {
    type: 'turn/end',
    data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'Synthetic failure' } } },
  };
  expect(modelFailure(turnFailure({ events: [failed] }))).toBe('auth');
  expect(
    turnFailure({
      events: [failed, { type: 'turn/end', data: { reason: { kind: 'completed' } } }],
    }),
  ).toBeUndefined();
  expect(
    modelFailure(
      turnFailure({ events: [{ type: 'assistant/message', data: { content: 'AUTH' } }] }),
    ),
  ).toBe('unknown');
});

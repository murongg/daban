import { isRemoteRpcRequest } from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';

it('remote SDK app reads never turn a claimed interactive mutation into authority', () => {
  const envelope = {
    type: 'request',
    id: 'mock-request',
    host: 'a'.repeat(64),
    workspace: 'mock-workspace',
  };
  expect(
    isRemoteRpcRequest({ ...envelope, method: 'app.catalog', params: { bot: 'mock-bot' } }),
  ).toBe(true);
  for (const method of ['app.oauth.start', 'app.oauth.cancel', 'app.disconnect'])
    expect(isRemoteRpcRequest({ ...envelope, method, params: { interactive: true } })).toBe(false);
  expect(
    isRemoteRpcRequest({
      ...envelope,
      method: 'app.oauth.start',
      params: {
        input: {
          bot: 'mock-bot',
          connection: 'mock-app',
          revision: 0,
          requestId: 'mock-start',
          app: 'notion',
          name: 'Synthetic App',
        },
      },
    }),
  ).toBe(false);
});

it('uses the canonical parser for closed app commands without accepting claimed interaction authority', () => {
  for (const command of [
    { type: 'app.catalog', bot: 'mock-bot' },
    {
      type: 'app.oauth.start',
      input: {
        bot: 'mock-bot',
        connection: 'mock-app',
        revision: 0,
        requestId: 'mock-start',
        app: 'notion',
        name: 'Synthetic App',
      },
    },
  ]) {
    expect(parseCommand(command)).toEqual(command);
    expect(() => parseCommand({ ...command, interactive: true })).toThrow('INVALID_COMMAND');
    expect(() => parseCommand({ ...command, local: true })).toThrow('INVALID_COMMAND');
  }
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

import {
  appDirectoryProtocol,
  appProviders,
  isAppCatalog,
  isAppDirectory,
  parseRuntimeCommand,
} from '@daban/protocol';
import { expect, test } from 'vitest';

test.each(['linear', 'sentry', 'todoist', 'miro', 'monday'])(
  '%s uses the versioned native connect command without changing the legacy Notion contract',
  (app) => {
    const command = {
      type: 'app.oauth.connect',
      input: {
        app,
        bot: 'mock-bot',
        connection: 'mock-connection',
        revision: 0,
        requestId: 'mock-connect',
        name: 'Synthetic account',
      },
    };
    expect(parseRuntimeCommand(command)).toEqual(command);
    expect(parseRuntimeCommand({ type: 'app.directory', bot: 'mock-bot' })).toEqual({
      type: 'app.directory',
      bot: 'mock-bot',
    });
    expect(() => parseRuntimeCommand({ ...command, interactive: true })).toThrow('INVALID_COMMAND');
    expect(() =>
      parseRuntimeCommand({ ...command, input: { ...command.input, scope: 'admin' } }),
    ).toThrow('INVALID_COMMAND');
    expect(() => parseRuntimeCommand({ ...command, type: 'app.oauth.start' })).toThrow(
      'INVALID_COMMAND',
    );
  },
);

test('the expanded directory is closed, provider-bound metadata and never the old two-entry catalog', () => {
  const value = {
    protocol: appDirectoryProtocol,
    bot: 'mock-bot',
    apps: [
      ...appProviders.map((provider) => ({
        id: provider.id,
        publisher: provider.publisher,
        origin: new URL(provider.resource).origin,
        auth: 'oauth',
        available: provider.id !== 'notion',
        ...(provider.id === 'notion' ? { reason: 'OAUTH_NOT_VERIFIED' } : {}),
        scope: provider.scope,
        adminApproval: provider.adminApproval,
      })),
      { id: 'custom-mcp', publisher: 'Custom MCP', auth: 'bearer', available: true },
    ],
    connections: [
      {
        app: 'linear',
        connection: 'mock-app',
        revision: 1,
        name: 'Synthetic account',
        state: 'connected',
      },
    ],
    attempts: [],
    attemptsMore: false,
  };
  expect(isAppDirectory(value)).toBe(true);
  expect(isAppCatalog(value)).toBe(false);
  expect(isAppDirectory({ ...value, apps: [...value.apps, value.apps[0]] })).toBe(false);
  expect(
    isAppDirectory({
      ...value,
      apps: value.apps.map((entry) =>
        entry.id === 'linear' ? { ...entry, origin: 'https://other.example.test' } : entry,
      ),
    }),
  ).toBe(false);
  expect(
    isAppDirectory({
      ...value,
      connections: [{ ...value.connections[0], clientId: 'synthetic-private' }],
    }),
  ).toBe(false);
  expect(
    isAppDirectory({ ...value, connections: [{ ...value.connections[0], app: 'unreviewed' }] }),
  ).toBe(false);
});

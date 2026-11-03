import { expect, test } from 'vitest';
import { sdkPatch } from './model.js';

test('only exact live task-owned readers can use delegated tools', async () => {
  const { apply } = await import(new URL('./delegation.js', import.meta.url).href);
  const root = { id: 'mock-root' },
    child = { id: 'mock-child' },
    foreign = { id: 'mock-foreign' };
  const live = new Map([
    [root.id, root],
    [child.id, child],
    [foreign.id, foreign],
  ]);
  let guard!: (exec: {
    agent?: { id: string };
    name: string;
    arguments?: unknown;
  }) => string | undefined;
  apply({
    on: () => undefined,
    subagents: { waitForChildren: async () => false },
    agents: {
      roots: () => [root],
      get: (id: string) => live.get(id),
      isOwnedBy: (id: string, owner: object) => id === child.id && owner === root,
    },
    tools: {
      guard: (check: typeof guard) => {
        guard = check;
      },
    },
  });
  expect(guard({ agent: root, name: 'mcp__computer__write_file' })).toBeUndefined();
  for (const name of [
    'web_search',
    'web_fetch',
    'mcp__computer__read_file',
    'mcp__computer__bot_history_read',
  ])
    expect(guard({ agent: child, name })).toBeUndefined();
  for (const name of [
    'subagent',
    'send_message',
    'ask_user_question',
    'mcp__computer__write_file',
    'mcp__computer__shell',
    'mcp__computer__act',
    'mcp__computer__software_install',
    'mcp__computer__work_update',
    'mcp__other__read_file',
  ])
    expect(guard({ agent: child, name })).toBe('DELEGATION_READ_ONLY');
  expect(guard({ agent: foreign, name: 'web_search' })).toBe('DELEGATION_OWNER_UNAVAILABLE');
  expect(guard({ agent: { id: child.id }, name: 'web_search' })).toBe(
    'DELEGATION_OWNER_UNAVAILABLE',
  );
  expect(
    guard({
      agent: child,
      name: 'send_message',
      arguments: { agent_id: root.id, message: 'SYNTHETIC RESULT' },
    }),
  ).toBeUndefined();
  expect(
    guard({
      agent: child,
      name: 'send_message',
      arguments: { agent_id: foreign.id, message: 'SYNTHETIC RESULT' },
    }),
  ).toBe('DELEGATION_READ_ONLY');
  live.delete(child.id);
  expect(guard({ agent: child, name: 'web_search' })).toBe('DELEGATION_OWNER_UNAVAILABLE');
});

test('native delegation has one level and a bounded shared activation pool', () => {
  const patch = sdkPatch('http://127.0.0.1:12345', 'mock-bot', 'mock-capability', {
    requestId: 'mock-delegate',
    prompt: 'Synthetic task',
  });
  const rows = patch.flatMap((row) => ('insert' in row ? row.insert : [])) as {
    id: string;
    config?: unknown;
  }[];
  expect(rows.find((row) => row.id === 'subagent')?.config).toStrictEqual({
    maxDepth: 1,
    maxActiveSubagents: 2,
  });
  expect(rows.find((row) => row.id === 'tool-subagent')?.config).toMatchObject({
    provider: 'spawn',
    maxDepth: 1,
  });
  expect(rows.some((row) => row.id === 'delegation-policy')).toBe(true);
});

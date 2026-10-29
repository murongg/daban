import { isSkillBinding, isSkillCatalog, isSkillDocument, isSkillEntry } from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const entry = {
  id: 'mock-skill-id',
  name: 'mock-summary',
  description: '合成说明',
  revision: 1,
  size: 80,
  deleted: false,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  invocation: { modelInvocable: true, userInvocable: true },
  enabled: false,
  bindingRevision: 0,
};
it('accepts only closed skill metadata, native invocation policy and revision-bound Bot changes', () => {
  expect(isSkillEntry(entry)).toBe(true);
  expect(isSkillEntry({ ...entry, name: '../escape' })).toBe(false);
  expect(isSkillEntry({ ...entry, permission: 'full-access' })).toBe(false);
  expect(isSkillEntry({ ...entry, invocation: { ...entry.invocation, shell: true } })).toBe(false);
  expect(isSkillEntry({ ...entry, enabled: true, deleted: true })).toBe(false);
  expect(isSkillCatalog({ revision: 1, items: [entry] })).toBe(true);
  expect(isSkillCatalog({ revision: 1, items: [entry, entry] })).toBe(false);
  const { enabled: _enabled, bindingRevision: _binding, ...summary } = entry;
  expect(isSkillDocument({ ...summary, size: 15, content: 'SYNTHETIC-SKILL' })).toBe(true);
  expect(isSkillDocument({ ...summary, content: 'x'.repeat(200001) })).toBe(false);
  expect(isSkillBinding({ id: entry.id, revision: 1, bindingRevision: 0, enabled: true })).toBe(
    true,
  );
  expect(isSkillBinding({ id: entry.id, revision: 0, bindingRevision: 0, enabled: true })).toBe(
    false,
  );
});

it('versions skill IPC, rejects extra authority fields and validates exact response identity', async () => {
  const command = {
    type: 'skill.bind',
    bot: 'mock-a',
    binding: { id: entry.id, revision: entry.revision, bindingRevision: 0, enabled: true },
  };
  expect(parseCommand(command)).toEqual(command);
  expect(() => parseCommand({ ...command, path: '/private' })).toThrow('INVALID_COMMAND');
  expect(() =>
    parseCommand({ ...command, binding: { ...command.binding, tools: ['shell'] } }),
  ).toThrow('INVALID_COMMAND');
  expect(() =>
    parseCommand({ type: 'skill.import', bot: 'mock-a', content: 'x'.repeat(200001) }),
  ).toThrow('INVALID_COMMAND');
  const posted: unknown[] = [];
  const bound = { ...entry, enabled: true, bindingRevision: 1 };
  let protocol = 19,
    returned: unknown = bound;
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-skill-token">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          configured: true,
          revision: 0,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
        });
      if (init?.method === 'POST') {
        posted.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
        return Response.json(returned);
      }
      return Response.json({
        clientProtocol: protocol,
        mode: 'agent',
        sharedLogin: false,
        bots: {},
        computers: { available: true, revision: 0, limit: 2, items: [] },
        skills: { available: true, revision: 1 },
        model: { available: true, bots: {} },
      });
    },
  });
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posted).toEqual([]);
  protocol = 20;
  expect((await client.status()).skills?.available).toBe(true);
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { bot: command.bot, entry: bound };
  expect(await client.invoke(parseCommand(command))).toEqual(bound);
  expect(posted.at(-1)).toEqual({
    path: '/api/skills/bind',
    body: { bot: command.bot, binding: command.binding },
  });
  returned = { bot: 'mock-wrong-bot', entry: bound };
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { bot: command.bot, entry: { ...bound, id: 'mock-foreign-skill' } };
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { bot: command.bot, entry: { ...bound, enabled: false } };
  await expect(client.invoke(parseCommand(command))).rejects.toThrow('INVALID_RUNTIME_STATE');
  const catalog = { revision: 1, items: [entry] };
  returned = { bot: 'mock-wrong-bot', catalog };
  await expect(
    client.invoke(parseCommand({ type: 'skill.list', bot: command.bot })),
  ).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { bot: command.bot, catalog };
  expect(await client.invoke(parseCommand({ type: 'skill.list', bot: command.bot }))).toEqual(
    catalog,
  );
  const { enabled: _enabled, bindingRevision: _binding, ...summary } = entry;
  const content = '---\nname: mock-summary\ndescription: 合成说明\n---\nSYNTHETIC-SOURCE';
  const document = { ...summary, content, size: new TextEncoder().encode(content).length };
  const input = { type: 'skill.import', bot: command.bot, content };
  returned = document;
  expect(await client.invoke(parseCommand(input))).toEqual(document);
  returned = { ...document, content: `${content}-FOREIGN`, size: document.size + 8 };
  await expect(client.invoke(parseCommand(input))).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { ...document, deleted: true };
  await expect(client.invoke(parseCommand(input))).rejects.toThrow('INVALID_RUNTIME_STATE');
  returned = { ...document, revision: 1 };
  await expect(
    client.invoke(
      parseCommand({ type: 'skill.update', bot: command.bot, id: entry.id, revision: 3, content }),
    ),
  ).rejects.toThrow('INVALID_RUNTIME_STATE');
});

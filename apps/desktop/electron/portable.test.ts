import {
  type BotBundle,
  botBundleText,
  disconnected,
  isBotBundle,
  isBotExportRequest,
  isBotImportHeader,
  isBotImportReceipt,
  parseBotJSON,
} from '@daban/protocol';
import { describe, expect, it, vi } from 'vitest';

const bundle = (): BotBundle => ({
  format: 'daban.bot',
  version: 1,
  profile: { name: '合成研究员', instructions: '整理合成资料', color: 'violet' },
  preferences: '仅用于合成测试的工作偏好',
  skills: [
    {
      name: 'mock-outline',
      content:
        '---\nname: mock-outline\ndescription: Synthetic outline\n---\nWrite a synthetic outline.',
    },
  ],
  knowledge: [{ path: 'mock/notes.md', content: 'SYNTHETIC KNOWLEDGE' }],
});
describe('portable content protocol', () => {
  it('accepts only portable content and canonicalizes key order without including local identity or authority', () => {
    const data = bundle();
    expect(isBotBundle(data)).toBe(true);
    expect(isBotBundle({ ...data, preferences: 'SYNTHETIC 😀' })).toBe(true);
    expect(isBotBundle({ ...data, knowledge: [{ path: 'mock.md', content: '\ud800' }] })).toBe(
      false,
    );
    expect(botBundleText(data)).toBe(
      botBundleText({
        ...data,
        profile: {
          color: 'violet',
          instructions: data.profile.instructions,
          name: data.profile.name,
        },
      }),
    );
    for (const extra of [
      'id',
      'model',
      'apiKey',
      'credentials',
      'connections',
      'permissions',
      'schedule',
      'browser',
      'history',
    ]) {
      expect(isBotBundle({ ...data, [extra]: 'SYNTHETIC FORBIDDEN FIELD' })).toBe(false);
      expect(
        isBotBundle({
          ...data,
          profile: { ...data.profile, [extra]: 'SYNTHETIC FORBIDDEN FIELD' },
        }),
      ).toBe(false);
    }
  });
  it('rejects unknown versions, duplicate names/paths, sparse arrays, traversal and oversized content', () => {
    const data = bundle();
    expect(isBotBundle({ ...data, version: 2 })).toBe(false);
    expect(isBotBundle({ ...data, skills: [data.skills[0], data.skills[0]] })).toBe(false);
    expect(isBotBundle({ ...data, knowledge: [data.knowledge[0], data.knowledge[0]] })).toBe(false);
    expect(
      isBotBundle({
        ...data,
        knowledge: [{ path: '../model/credentials.json', content: 'SYNTHETIC' }],
      }),
    ).toBe(false);
    expect(isBotBundle({ ...data, skills: Array(2) })).toBe(false);
    expect(
      isBotBundle({
        ...data,
        knowledge: [{ path: 'mock.txt', content: 'a'.repeat(200 * 1024 + 1) }],
      }),
    ).toBe(false);
    expect(isBotBundle({ ...data, preferences: 'x'.repeat(12001) })).toBe(false);
    expect(
      isBotBundle({
        ...data,
        knowledge: [{ ...data.knowledge[0], original: { name: 'mock.exe', data: 'YWJj' } }],
      }),
    ).toBe(false);
  });
  it('binds export selections and import receipts to bounded, explicit identities and revisions', () => {
    const query = {
      bot: 'mock-bot',
      revision: 1,
      memory: true,
      skills: [{ id: 'mock-skill', revision: 1 }],
      knowledge: [],
    };
    expect(isBotExportRequest(query)).toBe(true);
    expect(isBotExportRequest({ ...query, originals: true })).toBe(true);
    expect(isBotExportRequest({ ...query, originals: 'yes' })).toBe(false);
    expect(isBotExportRequest({ ...query, skills: [...query.skills, ...query.skills] })).toBe(
      false,
    );
    expect(isBotExportRequest({ ...query, bot: '../other' })).toBe(false);
    const header = { id: 'mock-import', sha256: 'a'.repeat(64), size: 100 };
    expect(isBotImportHeader(header)).toBe(true);
    expect(isBotImportHeader({ ...header, size: 101 * 1024 ** 2 })).toBe(false);
    expect(isBotImportReceipt({ id: header.id, state: 'unknown' })).toBe(true);
    expect(isBotImportReceipt({ id: header.id, state: 'complete', sha256: header.sha256 })).toBe(
      false,
    );
    expect(isBotImportReceipt({ id: '../other', state: 'unknown' })).toBe(false);
  });
});

it('bounds JSON structure before allocation while preserving quoted brackets and escapes', () => {
  const data = { profile: 'SYNTHETIC [ { " ] }', preferences: 'SYNTHETIC' };
  expect(parseBotJSON(JSON.stringify(data))).toEqual(data);
  expect(() => parseBotJSON('['.repeat(16) + '0' + ']'.repeat(16))).toThrow();
  expect(() => parseBotJSON(JSON.stringify(Array.from({ length: 5000 }, () => ({}))))).toThrow();
  expect(() => parseBotJSON('{"unfinished":"SYNTHETIC')).toThrow();
});

it('admits only narrowly shaped bundle IPC and validates import acknowledgements against the captured payload', async () => {
  const { parseCommand } = await import('./ipc');
  const { RuntimeClient } = await import('./runtime');
  const data = bundle();
  expect(
    parseCommand({ type: 'bot.import.submit', id: 'mock-import', bundle: data }),
  ).toMatchObject({ type: 'bot.import.submit' });
  expect(() =>
    parseCommand({
      type: 'bot.import.submit',
      id: 'mock-import',
      bundle: data,
      hostPath: '/mock/private',
    }),
  ).toThrow('INVALID_COMMAND');
  const headers = { id: 'mock-import', sha256: 'a'.repeat(64), size: 100 };
  expect(parseCommand({ type: 'bot.import.begin', header: headers })).toEqual({
    type: 'bot.import.begin',
    header: headers,
  });
  const calls: string[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18799',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url) => {
      calls.push(new URL(url).pathname);
      const route = new URL(url).pathname;
      if (route === '/api/state')
        return Response.json({
          clientProtocol: 27,
          bots: {},
          model: { available: false, bots: {} },
          profiles: [],
        });
      if (route === '/api/model/settings') return Response.json({ configured: false });
      return Response.json({ id: 'mock-wrong-import', state: 'awaiting', sha256: headers.sha256 });
    },
  });
  const ready = disconnected('ready');
  ready.protocolVersion = 27;
  vi.spyOn(client, 'status').mockResolvedValue(ready);
  await expect(client.invoke({ type: 'bot.import.begin', header: headers })).rejects.toThrow(
    'INVALID_BOT_IMPORT_ACK',
  );
  expect(calls).toContain('/api/bundles/begin');
});

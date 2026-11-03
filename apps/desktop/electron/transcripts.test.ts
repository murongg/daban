import {
  isTranscriptContent,
  isTranscriptItem,
  isTranscriptPage,
  isTranscriptScope,
  recoveryReader,
} from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

const scope = { bot: 'mock-alpha', runId: 'mock-run', chatRevision: 0 };
const item = {
  seq: 1,
  kind: 'call',
  at: '2026-01-01T00:00:00Z',
  name: 'web_search',
  callId: 'mock-call',
  characters: 8,
};

it('strict transcript projections bind private/group scope, immutable event metadata and progressing text pages', () => {
  expect(isTranscriptScope(scope)).toBe(true);
  expect(
    isTranscriptScope({ bot: scope.bot, runId: scope.runId, conversationId: 'mock-group' }),
  ).toBe(true);
  for (const invalid of [
    { ...scope, chatRevision: -1 },
    { ...scope, conversationId: 'mock-group' },
    { bot: scope.bot, runId: scope.runId },
    { ...scope, extra: 'private' },
  ])
    expect(isTranscriptScope(invalid)).toBe(false);
  expect(isTranscriptItem(item)).toBe(true);
  expect(isTranscriptItem({ ...item, source: 'mock-private-native-session' })).toBe(false);
  expect(isTranscriptItem({ ...item, code: 'MOCK_FAILURE' })).toBe(false);
  expect(isTranscriptItem({ ...item, isError: true, code: 'MOCK_FAILURE' })).toBe(true);
  const page = { ...scope, state: 'recording', items: [item], nextAfter: 1 };
  expect(isTranscriptPage(page)).toBe(true);
  expect(isTranscriptPage({ ...page, nextAfter: 2 })).toBe(false);
  expect(isTranscriptPage({ ...page, items: [item, item] })).toBe(false);
  expect(isTranscriptPage({ ...page, state: 'unavailable' })).toBe(false);
  const content = { ...scope, seq: 1, offset: 0, text: '合成😀', total: 6, nextOffset: 4 };
  expect(isTranscriptContent(content)).toBe(true);
  for (const invalid of [
    { ...content, nextOffset: 3 },
    { ...content, nextOffset: undefined },
    { ...content, text: '' },
    { ...content, offset: 7 },
    { ...content, total: 4 },
    { ...content, text: 'x'.repeat(32001) },
  ])
    expect(isTranscriptContent(invalid)).toBe(false);
  expect(isTranscriptContent({ ...scope, seq: 1, offset: 0, text: '', total: 0 })).toBe(true);
});

it('transcript IPC and HTTP reads gate before old-runtime calls and reject cross-scope or stale replies', async () => {
  const list = parseCommand({ type: 'transcript.list', query: { scope, after: 0 } });
  const read = parseCommand({ type: 'transcript.content', query: { scope, seq: 1, offset: 0 } });
  const statistics = parseCommand({ type: 'transcript.statistics', query: { scope } });
  expect(recoveryReader(statistics)).toBe(true);
  expect(recoveryReader(list)).toBe(true);
  expect(recoveryReader(read)).toBe(true);
  for (const value of [
    { type: 'transcript.list', query: { scope, after: -1 } },
    { type: 'transcript.list', query: { scope, extra: 'private' } },
    { type: 'transcript.content', query: { scope, seq: 0 } },
    { type: 'transcript.content', query: { scope, seq: 1, offset: -1 } },
    {
      type: 'transcript.content',
      query: { scope: { ...scope, conversationId: 'mock-group' }, seq: 1 },
    },
  ])
    expect(() => parseCommand(value)).toThrow('INVALID_COMMAND');
  let protocol = 32;
  let reply: unknown = { ...scope, state: 'complete', items: [item] };
  const posts: { path: string; body: unknown }[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="mock-transport-capability">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: false,
          revision: 0,
        });
      if (init?.method === 'POST') {
        posts.push({ path: new URL(url).pathname, body: JSON.parse(String(init.body)) });
        return Response.json(reply);
      }
      return Response.json({
        mode: 'agent',
        clientProtocol: protocol,
        bots: {},
        computers: { available: true, revision: 0, limit: 2, items: [] },
        recovery: { available: true, revision: 0 },
        skills: { available: true, revision: 0 },
        mcp: { available: true, revision: 0 },
        chats: { available: true, revision: 0, items: [] },
        model: {
          available: true,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          bots: {},
        },
      });
    },
  });
  await expect(client.invoke(list)).rejects.toThrow('RUNTIME_TOO_OLD');
  await expect(client.invoke(read)).rejects.toThrow('RUNTIME_TOO_OLD');
  expect(posts).toHaveLength(0);
  await expect(client.invoke(statistics)).rejects.toThrow('RUNTIME_TOO_OLD');
  protocol = 33;
  expect(await client.invoke(list)).toEqual(reply);
  const pageReply = reply;
  reply = {
    ...scope,
    stats: {
      turns: 1,
      steps: 2,
      llmMs: 50,
      toolMs: 20,
      ttftMs: 10,
      ttftSteps: 1,
      decodeMs: 40,
      decodeTokens: 8,
    },
  };
  expect(await client.invoke(statistics)).toEqual(reply);
  expect(posts.at(-1)?.path).toBe('/api/transcripts/statistics');
  reply = { ...scope, bot: 'mock-other', stats: {} };
  await expect(client.invoke(statistics)).rejects.toThrow('INVALID_STATISTICS');
  reply = pageReply;
  await client.invoke(list);
  expect(posts.at(-1)).toEqual({ path: '/api/transcripts/list', body: { scope, after: 0 } });
  reply = { ...scope, bot: 'mock-other', state: 'complete', items: [item] };
  await expect(client.invoke(list)).rejects.toThrow('INVALID_TRANSCRIPT_PAGE');
  reply = { ...scope, state: 'complete', items: [item] };
  await expect(
    client.invoke(parseCommand({ type: 'transcript.list', query: { scope, after: 1 } })),
  ).rejects.toThrow('INVALID_TRANSCRIPT_PAGE');
  reply = { ...scope, seq: 1, offset: 0, total: 8, text: 'SYNTHETI' };
  expect(await client.invoke(read)).toEqual(reply);
  expect(posts.at(-1)?.path).toBe('/api/transcripts/content');
  for (const invalid of [
    { ...(reply as object), offset: 1 },
    { ...(reply as object), seq: 2 },
    { ...(reply as object), chatRevision: 1 },
    { ...(reply as object), rawSession: 'mock-private' },
  ]) {
    reply = invalid;
    await expect(client.invoke(read)).rejects.toThrow('INVALID_TRANSCRIPT_CONTENT');
  }
});

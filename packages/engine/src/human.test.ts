import type { InteractionInput } from '@daban/protocol';
import { expect, test } from 'vitest';
import { apply, waitForReply } from './human.js';

test('human bridge uses the per-run capability only in HTTP headers and validates the exact request response', async () => {
  const input = {
    id: 'mock-human',
    sessionId: 'mock-session',
    kind: 'question' as const,
    questions: [{ id: 'format', question: '合成格式？' }],
  };
  const payloads: unknown[] = [];
  const pending = {
    ...input,
    bot: 'mock-bot',
    runId: 'mock-run',
    status: 'pending',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  };
  const fetcher = async (_url: string, options: RequestInit) => {
    expect(new Headers(options.headers).get('authorization')).toBe('Bearer mock-capability');
    const rpc = JSON.parse(String(options.body));
    payloads.push(rpc);
    return Response.json({
      result:
        rpc.method === 'interaction.open'
          ? pending
          : {
              ...pending,
              status: 'resolved',
              reply: {
                kind: 'answer',
                answers: [{ id: 'format', selected: [], custom: '合成回复' }],
              },
            },
    });
  };
  const result = await waitForReply(
    { url: 'http://127.0.0.1:12345/mcp/mock-bot', capability: 'mock-capability' },
    input,
    new AbortController().signal,
    fetcher,
  );
  expect(result.status).toBe('resolved');
  expect(JSON.stringify(payloads).includes('mock-capability')).toBe(false);
  await expect(
    waitForReply(
      { url: 'http://127.0.0.1:12345/mcp/mock-bot', capability: 'mock-capability' },
      input,
      new AbortController().signal,
      async () => Response.json({ result: { ...pending, id: 'foreign-request' } }),
    ),
  ).rejects.toThrowError(/INVALID_INTERACTION/);
});
test('approval bridge never grants unknown actions or missing agent identity', async () => {
  const handlers = new Map<string, (request: unknown) => Promise<unknown>>();
  apply(
    {
      on: (event, callback) => {
        handlers.set(event, callback);
      },
    },
    { url: 'http://127.0.0.1:12345/mcp/mock-bot', capability: 'mock-capability' },
  );
  expect(await handlers.get('approval/request')!({ toolName: 'shell', reason: '{}' })).toBe(
    'unavailable',
  );
  await expect(
    handlers.get('user-questions/request')!({
      questions: [{ id: 'mock', question: '合成问题？' }],
    }),
  ).rejects.toThrowError(/INVALID_INTERACTION/);
});

test('human question and approval bridges retain a server-owned conversation scope and refuse scope changes while waiting', async () => {
  for (const input of [
    {
      id: 'mock-scoped-question',
      sessionId: 'mock-scoped-session',
      kind: 'question',
      questions: [{ id: 'format', question: '合成格式？' }],
    },
    {
      id: 'mock-scoped-approval',
      sessionId: 'mock-scoped-session',
      kind: 'approval',
      tool: 'web_fetch',
      url: 'https://example.test/mock',
    },
  ] satisfies InteractionInput[]) {
    const config = {
      url: 'http://127.0.0.1:12345/mcp/mock-bot',
      capability: 'mock-scoped-capability',
    };
    const pending = {
      ...input,
      conversationId: 'mock-group',
      bot: 'mock-bot',
      runId: 'mock-scoped-run',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const fetcher = (changed: boolean) => async (_url: string, options: RequestInit) => {
      const rpc = JSON.parse(String(options.body));
      expect('conversationId' in rpc.params).toBe(false);
      return Response.json({
        result:
          rpc.method === 'interaction.open'
            ? pending
            : {
                ...pending,
                conversationId: changed ? 'mock-other-group' : pending.conversationId,
                status: 'resolved',
                reply:
                  input.kind === 'question'
                    ? {
                        kind: 'answer',
                        answers: [{ id: 'format', selected: [], custom: '合成回复' }],
                      }
                    : { kind: 'decision', allow: true },
              },
      });
    };
    const result = await waitForReply(config, input, new AbortController().signal, fetcher(false));
    expect(result.conversationId).toBe('mock-group');
    expect(result.status).toBe('resolved');
    await expect(
      waitForReply(config, input, new AbortController().signal, fetcher(true)),
    ).rejects.toThrowError(/INVALID_INTERACTION/);
  }
});

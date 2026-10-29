import { expect, it } from 'vitest';
import { RuntimeClient } from './runtime';

it('decodes public completion metadata and degrades only the notice feed when its schema is invalid', async () => {
  let notices: unknown = {
    available: true,
    items: [{ kind: 'task', id: 'mock-run', bot: 'mock-bot', chatRevision: 2, phase: 'completed' }],
  };
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url) => {
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="synthetic-capability">');
      if (url.endsWith('/api/model/settings'))
        return Response.json({
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          configured: false,
          revision: 0,
        });
      return Response.json({
        mode: 'agent',
        clientProtocol: 30,
        bots: {},
        computers: { available: true, revision: 0, limit: 2, items: [] },
        recovery: { available: true, revision: 0 },
        skills: { available: true, revision: 0 },
        mcp: { available: true, revision: 0 },
        chats: { available: true, revision: 0, items: [] },
        notices,
        model: {
          available: true,
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          bots: {},
        },
      });
    },
  });
  expect((await client.status()).notices).toEqual(notices);
  notices = {
    available: true,
    items: [
      {
        kind: 'task',
        id: 'mock-run',
        bot: 'mock-bot',
        chatRevision: 2,
        phase: 'completed',
        prompt: 'SYNTHETIC PRIVATE',
      },
    ],
  };
  const state = await client.status();
  expect(state.phase).toBe('ready');
  expect(state.notices).toMatchObject({ available: false, items: [] });
});

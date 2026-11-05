import { expect, test, vi } from 'vitest';
import { apply } from './usage.js';

for (const strict of [false, true])
  test(`explicit Host rejection never falls through to a provider send (strict=${strict})`, async () => {
    const root = { id: 'synthetic-root', session: { id: 'synthetic-root' } };
    const config = {
      url: 'http://127.0.0.1:12345/mcp/mock-bot',
      capability: 'synthetic-token',
      scope: { budgetId: 'synthetic-budget', revision: 1 },
      runId: 'synthetic-run',
      modelAttemptId: 'synthetic-model-attempt',
      routeKey: 'synthetic-route',
      provider: 'synthetic-provider',
      api: 'openai-completions' as const,
      baseURL: 'https://models.example.test/v1',
      model: 'synthetic-model',
      strict,
    };
    type Context = Parameters<typeof apply>[0];
    let stream: Parameters<Context['on']>[1] | undefined;
    let close: () => Promise<unknown> = async () => {};
    let sent = 0;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (new Request(input, init).url === config.url)
        return Response.json({ error: 'SYNTHETIC_HOST_REJECTED' }, { status: 403 });
      sent++;
      return new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    apply(
      {
        agents: { roots: () => [root], get: () => root, isOwnedBy: () => false },
        on: (_event, listener) => {
          stream = listener;
        },
        effect: (factory) => {
          close = factory();
        },
      },
      config,
    );
    try {
      const consume = async () => {
        expect(stream).toBeTypeOf('function');
        const output = stream!(
          { provider: config.provider, model: config.model, sessionId: root.session.id },
          async function* () {
            await fetch(`${config.baseURL}/chat/completions`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ model: config.model, messages: [] }),
            });
            yield {};
          },
        );
        for await (const _chunk of output) {
          /* Drain the synthetic model request. */
        }
      };
      await expect(consume()).rejects.toThrow();
      expect(sent).toBe(0);
    } finally {
      await close();
      vi.unstubAllGlobals();
    }
  });

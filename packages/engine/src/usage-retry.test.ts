import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultBudgetPolicy } from '@daban/protocol';
import { expect, test } from 'vitest';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

test.each([
  ['openai-completions', 1],
  ['openai-completions', 2],
  ['openai-responses', 1],
  ['openai-responses', 2],
] as const)(
  'real SDK %s recovery admits every physical send and enforces shared request limit %i',
  { timeout: 60000 },
  async (api, limit) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-budget-retry-'));
    let models: ModelRuns | undefined;
    let sends = 0,
      dispatches = 0;
    const observations: number[] = [];
    const server = createServer(async (request, response) => {
      try {
        if (request.method === 'GET') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ data: [{ id: 'synthetic-model' }] }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const part of request) chunks.push(Buffer.from(part));
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (request.url === '/mcp/mock-bot') {
          const result = await models!.rpc('mock-bot', request.headers.authorization, body);
          if (
            body &&
            typeof body === 'object' &&
            'method' in body &&
            body.method === 'budget.dispatched' &&
            result &&
            typeof result === 'object' &&
            'result' in result &&
            result.result &&
            typeof result.result === 'object' &&
            'send' in result.result &&
            result.result.send === true
          )
            dispatches++;
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(result));
          return;
        }
        expect(request.url).toBe(
          api === 'openai-responses' ? '/v1/responses' : '/v1/chat/completions',
        );
        sends++;
        observations.push(dispatches);
        if (sends === 1) {
          response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' });
          response.end(
            JSON.stringify({
              error: { message: 'SYNTHETIC RATE LIMIT', type: 'rate_limit_error' },
            }),
          );
          return;
        }
        if (api === 'openai-completions') {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.end(
            `data: ${JSON.stringify({ id: 'synthetic-response', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'SYNTHETIC RETRY COMPLETE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } })}\n\ndata: [DONE]\n\n`,
          );
        } else {
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          const item = {
            id: 'msg_synthetic',
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'SYNTHETIC RETRY COMPLETE', annotations: [] }],
          };
          for (const event of [
            { type: 'response.created', response: { id: 'resp_synthetic', status: 'in_progress' } },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
            {
              type: 'response.output_text.delta',
              output_index: 0,
              content_index: 0,
              delta: 'SYNTHETIC RETRY COMPLETE',
            },
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id: 'resp_synthetic',
                status: 'completed',
                output: [item],
                usage: {
                  input_tokens: 10,
                  output_tokens: 2,
                  total_tokens: 12,
                  input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
                },
              },
            },
          ])
            response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          response.end();
        }
      } catch {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'SYNTHETIC_ADMISSION_REFUSED' }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    expect.assert(address && typeof address !== 'string');
    const origin = `http://127.0.0.1:${address.port}`;
    try {
      const settings = new ModelSettings(path.join(root, 'credentials.json'));
      await settings.configure({
        revision: 0,
        requestId: 'synthetic-config',
        apiKey: 'synthetic-retry-key',
        model: 'provider:synthetic-provider:synthetic-model',
        connection: {
          id: 'synthetic-provider',
          name: 'Synthetic provider',
          api,
          baseURL: `${origin}/v1`,
          models: [
            {
              id: 'synthetic-model',
              name: 'Synthetic model',
              vision: false,
              contextWindow: 64000,
              maxTokens: 2048,
            },
          ],
        },
      });
      const sdkFile = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client');
      type Constructor = NonNullable<ConstructorParameters<typeof ModelRuns>[0]['Harness']>;
      const native = (await import(pathToFileURL(sdkFile).href)) as {
        DeepSeekHarness: Constructor;
      };
      const patch = path.join(root, 'synthetic-retry.patch.yml');
      await writeFile(
        patch,
        JSON.stringify([
          {
            insert: [
              {
                id: 'synthetic-retry',
                name: new URL('./usage-retry-fixture.js', import.meta.url).href,
              },
            ],
          },
        ]),
      );
      class RetryingHarness extends native.DeepSeekHarness {
        constructor(options: ConstructorParameters<Constructor>[0]) {
          super({ ...options, patches: [...options.patches, patch] });
        }
      }
      models = new ModelRuns({
        settings,
        origin,
        dir: path.join(root, 'models'),
        workspace: path.join(root, 'workspace'),
        sdkFile,
        Harness: RetryingHarness,
      });
      await models.ready;
      models.budgets.configure(
        0,
        { ...defaultBudgetPolicy, mode: 'strict', maxRequests: limit },
        [],
        'synthetic-budget-settings',
      );
      await models.start('mock-bot', {
        requestId: 'synthetic-request',
        prompt: 'Synthetic fixture: reply directly without tools.',
      });
      const job = models.jobs.get('mock-bot')!;
      await job.done;
      const budget = models.budgets.view(job.budget!.budgetId);
      expect(
        sends,
        JSON.stringify({ phase: job.phase, error: job.error, attempts: job.attemptSummary }),
      ).toBe(limit);
      expect(budget.requests).toBe(sends);
      expect(
        budget.receipts.every((receipt) => receipt.scope.budgetId === job.budget!.budgetId),
      ).toBe(true);
      expect(budget.receipts.every((receipt) => receipt.routeKey.includes(api))).toBe(true);
      expect(observations).toEqual(Array.from({ length: sends }, (_, index) => index + 1));
      expect(budget.unknownCount).toBe(1);
      if (limit === 1) {
        expect(job.phase).toBe('failed');
        expect(budget.state).toBe('limit-reached');
      } else {
        expect(job.phase, job.error).toBe('completed');
        expect(budget.reported.outputTokens).toBe(2);
      }
    } finally {
      await models?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    }
  },
);

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  defaultBudgetPolicy,
  isBudgetSettings,
  isBudgetView,
  managedProtocol,
} from '@daban/protocol';
import { startNativeAgent } from './host-server.js';
import { privateClientOptions } from './private-channel.js';

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
test('native Host HTTP quota continuation is scoped, durable and single-effect without a VM or live provider', {
  timeout: 60000,
}, async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'synthetic-budget-http-'));
  const root = path.join(temporary, 'private');
  let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
  let sends = 0;
  const provider = createServer(async (request, response) => {
    try {
      if (request.method === 'GET') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ data: [{ id: 'synthetic-model' }] }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(object(input) && Array.isArray(input.tools));
      sends++;
      const tool = input.tools.find(
        (entry: unknown) =>
          object(entry) &&
          object(entry.function) &&
          typeof entry.function.name === 'string' &&
          entry.function.name.endsWith('bot_memory_read'),
      );
      assert.ok(object(tool) && object(tool.function) && typeof tool.function.name === 'string');
      const delta =
        sends === 1
          ? {
              role: 'assistant',
              content: 'SYNTHETIC FIRST STEP',
              tool_calls: [
                {
                  index: 0,
                  id: 'synthetic-memory-call',
                  type: 'function',
                  function: { name: tool.function.name, arguments: '{}' },
                },
              ],
            }
          : { role: 'assistant', content: 'SYNTHETIC COMPLETE' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({ id: 'synthetic-response', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: sends === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } })}\n\ndata: [DONE]\n\n`,
      );
    } catch {
      response.writeHead(500);
      response.end('SYNTHETIC_PROVIDER_FAILURE');
    }
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  try {
    const scope = createHash('sha256').update(root).digest('hex');
    const socketPath =
      process.platform === 'win32'
        ? String.raw`\\.\pipe\daban-budget-${scope.slice(0, 24)}`
        : path.join(root, 'a.sock');
    agent = await startNativeAgent({
      dataRoot: root,
      socketPath,
      scope,
      nativeWorkspace: path.join(root, 'workspace'),
      sdkFile: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
    });
    const token = (await readFile(path.join(root, 'model/control-token'), 'utf8')).trim();
    const tls = await privateClientOptions(path.join(root, 'model/control-certificate.pem'));
    const call = (action: string, value: unknown = {}) =>
      new Promise<{ status: number; value: unknown }>((resolve, reject) => {
        const send = process.platform === 'win32' ? httpsRequest : httpRequest;
        const request = send(
          {
            ...tls,
            socketPath,
            path: `/api/budgets/${action}`,
            method: 'POST',
            headers: {
              host: '127.0.0.1:8766',
              'x-prototype-token': token,
              'x-daban-client-protocol': String(managedProtocol),
              'content-type': 'application/json',
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.once('error', reject);
            response.once('end', () => {
              try {
                resolve({
                  status: response.statusCode ?? 0,
                  value: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown,
                });
              } catch (error) {
                reject(error);
              }
            });
          },
        );
        request.once('error', reject);
        request.end(JSON.stringify(value));
      });
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    await agent.models.settings.configure({
      revision: 0,
      requestId: 'synthetic-model-config',
      apiKey: 'synthetic-model-key',
      model: 'provider:synthetic-provider:synthetic-model',
      connection: {
        id: 'synthetic-provider',
        name: 'Synthetic provider',
        baseURL: `http://127.0.0.1:${address.port}/v1`,
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
    await agent.models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic Bot',
      instructions: '',
      memory: 'SYNTHETIC MEMORY',
      color: 'mint',
    });
    const settings = await call('settings');
    assert.equal(settings.status, 200);
    assert.ok(isBudgetSettings(settings.value));
    const configured = await call('configure', {
      scope: settings.value.scope,
      id: 'synthetic-defaults',
      revision: 0,
      policy: { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 1 },
      prices: [],
    });
    assert.equal(configured.status, 200);
    assert.equal(sends, 0);
    await agent.models.start('mock-bot', {
      requestId: 'synthetic-task',
      approvalMode: 'ask',
      prompt: 'Read the synthetic memory, then finish.',
    });
    const first = agent.models.jobs.get('mock-bot')!;
    await first.done;
    assert.equal(sends, 1);
    assert.equal(agent.models.budgets.view(first.budget!.budgetId).state, 'limit-reached');
    const owner = { bot: 'mock-bot', runId: first.id, chatRevision: 0 };
    const increase = {
      budgetId: first.budget!.budgetId,
      id: 'synthetic-human-continue',
      scope: owner,
      revision: 1,
      policy: { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 3 },
    };
    const raised = await call('increase', increase);
    assert.equal(raised.status, 200);
    assert.ok(isBudgetView(raised.value));
    assert.equal(raised.value.state, 'stopped');
    assert.equal(agent.models.running('mock-bot'), false);
    assert.equal(sends, 1);
    const continued = { scope: owner, budget: raised.value.scope, id: increase.id };
    const started = await call('continue', continued);
    assert.equal(started.status, 200);
    const last = agent.models.jobs.get('mock-bot')!;
    await last.done;
    assert.equal(last.phase, 'completed', last.error);
    assert.equal(
      last.task?.approvalMode,
      'ask',
      'Increasing a budget cannot widen the accepted approval policy',
    );
    assert.equal(last.budget!.budgetId, first.budget!.budgetId);
    assert.equal(sends, 2);
    const repeated = await call('continue', continued);
    assert.deepEqual(repeated, started);
    assert.equal(sends, 2);
    const view = await call('read', { scope: owner });
    assert.equal(view.status, 200);
    assert.ok(isBudgetView(view.value));
    assert.equal(view.value.requests, 2);
    assert.equal(view.value.reported.inputTokens, 20);
    assert.equal(view.value.unknownCount, 0);
    assert.ok(!JSON.stringify(view.value).includes('synthetic-model-key'));
  } finally {
    await agent?.close();
    provider.closeAllConnections();
    await new Promise((resolve) => provider.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  }
});

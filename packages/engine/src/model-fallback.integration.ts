import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { defaultSdkFile } from './dsh.js';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

const sdkFile = process.env.DABAN_TEST_SDK || defaultSdkFile;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

for (const scenario of ['ordinary', 'clean', 'partial'] as const)
  test(`native API ${scenario} execution uses a real SDK process and an entirely synthetic provider`, {
    skip: !existsSync(sdkFile),
    timeout: 60000,
  }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-native-fallback-'));
    const calls: string[] = [];
    const errors: string[] = [];
    const methods: { method: string; goal?: boolean }[] = [];
    let models: ModelRuns | undefined;
    let prefixDelivered: () => unknown = () => undefined;
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          const value = Buffer.from(chunk);
          bytes += value.length;
          assert.ok(bytes <= 2 * 1024 * 1024);
          chunks.push(value);
        }
        if (request.url === '/v1/models') {
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify({ data: [{ id: 'mock-primary' }, { id: 'mock-fallback' }] }));
          return;
        }
        const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (request.url === '/mcp/mock-bot') {
          assert.ok(models);
          if (object(body) && typeof body.method === 'string')
            methods.push({
              method: body.method,
              ...(body.method === 'goal.observe' && object(body.params)
                ? { goal: body.params.goal !== null }
                : {}),
            });
          const result = await models.rpc(
            'mock-bot',
            typeof request.headers.authorization === 'string'
              ? request.headers.authorization
              : undefined,
            body,
          );
          if (
            object(body) &&
            body.method === 'response.update' &&
            object(body.params) &&
            body.params.text === 'SYNTHETIC PARTIAL REPLY'
          )
            prefixDelivered();
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(result));
          return;
        }
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer synthetic-native-fallback-key');
        assert.ok(object(body) && typeof body.model === 'string' && body.stream === true);
        calls.push(body.model);
        assert.ok(calls.length <= 2);
        if (body.model === 'mock-primary' && scenario !== 'ordinary') {
          if (scenario === 'partial') {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            const delivered = new Promise<boolean>((resolve) => {
              const timeout = setTimeout(() => resolve(false), 5000);
              prefixDelivered = () => {
                clearTimeout(timeout);
                resolve(true);
              };
            });
            response.write(
              `data: ${JSON.stringify({ id: 'mock-partial-response', object: 'chat.completion.chunk', created: 1800000000, model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'SYNTHETIC PARTIAL REPLY' }, finish_reason: null }] })}\n\n`,
            );
            if (!(await delivered))
              errors.push('Synthetic prefix was not published before disconnect');
            response.destroy();
            return;
          }
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              error: { message: 'Synthetic unauthorized request', type: 'authentication_error' },
            }),
          );
          return;
        }
        assert.equal(body.model, scenario === 'ordinary' ? 'mock-primary' : 'mock-fallback');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const emit = (delta: object, finishReason: string | null) =>
          response.write(
            `data: ${JSON.stringify({ id: 'mock-native-response', object: 'chat.completion.chunk', created: 1800000000, model: body.model, choices: [{ index: 0, delta, finish_reason: finishReason }] })}\n\n`,
          );
        emit(
          {
            role: 'assistant',
            content:
              scenario === 'ordinary' ? 'SYNTHETIC DIRECT COMPLETE' : 'SYNTHETIC FALLBACK COMPLETE',
          },
          null,
        );
        emit({}, 'stop');
        response.end('data: [DONE]\n\n');
      } catch (error) {
        if (request.url?.startsWith('/mcp/')) {
          response.writeHead(503, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'SYNTHETIC_BRIDGE_REJECTED' }));
        } else {
          errors.push(error instanceof Error ? error.message : 'SYNTHETIC_PROVIDER_FAILURE');
          response.writeHead(500);
          response.end('SYNTHETIC_PROVIDER_FAILURE');
        }
      }
    });
    try {
      await new Promise<undefined>((resolve) =>
        server.listen(0, '127.0.0.1', () => resolve(undefined)),
      );
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      const origin = `http://127.0.0.1:${address.port}`;
      const settings = new ModelSettings(path.join(root, 'credentials.json'));
      await settings.configure({
        model: 'provider:mock-native:mock-primary',
        apiKey: 'synthetic-native-fallback-key',
        revision: 0,
        requestId: 'mock-native-config',
        connection: {
          id: 'mock-native',
          name: 'Synthetic provider',
          baseURL: `${origin}/v1`,
          models: ['mock-primary', 'mock-fallback'].map((id) => ({
            id,
            name: id,
            vision: false,
            contextWindow: 64000,
            maxTokens: 2048,
            capabilities: { toolCall: true },
          })),
        },
      });
      await settings.fallback({
        scope: (await settings.status(true)).modelAccess!.scope,
        revision: 1,
        requestId: 'mock-native-backup',
        model: 'provider:mock-native:mock-fallback',
      });
      models = new ModelRuns({
        settings,
        sdkFile,
        origin,
        dir: path.join(root, 'model'),
        workspace: path.join(root, 'workspace'),
      });
      const accepted = await models.start('mock-bot', {
        requestId: 'mock-native-request',
        prompt: 'Synthetic local integration fixture. Reply directly without using tools.',
      });
      await models.jobs.get('mock-bot')!.done;
      const result = models.status().bots['mock-bot'];
      assert.equal(result.runId, accepted.runId);
      assert.equal(result.requestId, 'mock-native-request');
      if (scenario === 'ordinary') {
        assert.equal(result.phase, 'completed', result.error || 'Synthetic direct task failed');
        assert.equal(result.result, 'SYNTHETIC DIRECT COMPLETE');
        assert.deepEqual(calls, ['mock-primary']);
        assert.equal(result.attemptSummary?.length, 1);
      } else if (scenario === 'clean') {
        assert.equal(
          result.phase,
          'completed',
          JSON.stringify({ error: result.error, attempts: result.attemptSummary, calls, methods }),
        );
        assert.equal(result.result, 'SYNTHETIC FALLBACK COMPLETE');
        assert.deepEqual(calls, ['mock-primary', 'mock-fallback']);
        assert.equal(result.attemptSummary?.length, 2);
        assert.equal(result.attemptSummary[0].failure, 'auth');
      } else {
        assert.equal(result.phase, 'failed');
        assert.equal(result.response?.text, 'SYNTHETIC PARTIAL REPLY');
        assert.deepEqual(calls, ['mock-primary']);
        assert.equal(result.attemptSummary?.length, 1);
        assert.equal(result.attemptSummary[0].fence, 'output');
      }
      assert.equal((await settings.status()).model, 'provider:mock-native:mock-primary');
      assert.deepEqual(errors, []);
    } finally {
      await models?.close();
      server.closeAllConnections();
      await new Promise<undefined>((resolve) => server.close(() => resolve(undefined)));
      await rm(root, { recursive: true, force: true });
    }
  });

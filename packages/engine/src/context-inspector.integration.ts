import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ModelRuns } from './model.js';
import { ModelSettings } from './settings.js';

async function listen(server: Server) {
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
}

const sdkFile =
  process.env.DABAN_TEST_SDK ||
  '/opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js';
test('the locked real SDK publishes public projections through the actual Host bridge with a local synthetic provider', {
  skip: !existsSync(sdkFile),
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-native-context-'));
  let models: ModelRuns | undefined;
  let requests = 0;
  const keys = new Set<string>();
  const errors: string[] = [];
  const rejectedUpdates: { activeTurn: boolean }[] = [];
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(
        input &&
          typeof input === 'object' &&
          'model' in input &&
          input.model === 'mock-context-model',
      );
      assert.ok('tools' in input && Array.isArray(input.tools));
      for (const tool of input.tools) {
        assert.ok(tool && typeof tool === 'object' && 'function' in tool);
        const definition = tool.function as { name?: string };
        assert.doesNotMatch(
          definition.name ?? '',
          /^(shell|write_file|read_file|browser_|screenshot|act$|open_app)/,
        );
      }
      assert.equal(request.headers.authorization, 'Bearer mock-local-provider-key');
      assert.ok(++requests <= 2);
      if (requests === 2) await new Promise((resolve) => setTimeout(resolve, 1200));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (choices: unknown[], usage?: object) =>
        response.write(
          `data: ${JSON.stringify({ id: 'mock-context-response', object: 'chat.completion.chunk', created: 1800000000, model: 'mock-context-model', choices, ...(usage ? { usage } : {}) })}\n\n`,
        );
      if (requests === 1) {
        emit([
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'mock-plan-call',
                  type: 'function',
                  function: {
                    name: 'todo_write',
                    arguments: JSON.stringify({
                      todos: [{ content: 'SYNTHETIC READ-ONLY PLAN', status: 'completed' }],
                    }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ]);
        emit([{ index: 0, delta: {}, finish_reason: 'tool_calls' }]);
      } else {
        emit([
          {
            index: 0,
            delta: { role: 'assistant', content: 'SYNTHETIC SDK RESULT' },
            finish_reason: null,
          },
        ]);
        emit([{ index: 0, delta: {}, finish_reason: 'stop' }]);
      }
      emit([], { prompt_tokens: 123, completion_tokens: 5, total_tokens: 128 });
      response.end('data: [DONE]\n\n');
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500);
      response.end('SYNTHETIC PROVIDER REJECTED');
    }
  });
  const bridge = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(models);
      if (
        value &&
        typeof value === 'object' &&
        'method' in value &&
        value.method === 'context.update' &&
        'params' in value
      ) {
        const params = value.params as { key?: string };
        if (params.key) keys.add(params.key);
      }
      const reply = await models.rpc('a', request.headers.authorization, value);
      response.writeHead(reply === null ? 204 : 200, { 'content-type': 'application/json' });
      response.end(reply === null ? undefined : JSON.stringify(reply));
    } catch (error) {
      const code = error instanceof Error ? error.message : String(error);
      if (code === 'INVALID_CONTEXT_UPDATE')
        rejectedUpdates.push({ activeTurn: !!models?.jobs.get('a')?.context?.activeTurn });
      else errors.push(code);
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'SYNTHETIC BRIDGE REJECTED' }));
    }
  });
  try {
    const baseURL = `${await listen(provider)}/v1`;
    const origin = await listen(bridge);
    const settings = new ModelSettings(path.join(root, 'credentials.json'), async () =>
      Response.json({ data: [{ id: 'mock-context-model' }] }),
    );
    await settings.configure({
      revision: 0,
      requestId: 'mock-configure',
      apiKey: 'mock-local-provider-key',
      model: 'provider:mock-local:mock-context-model',
      connection: {
        id: 'mock-local',
        name: 'Synthetic local provider',
        baseURL,
        models: [
          {
            id: 'mock-context-model',
            name: 'Synthetic context model',
            vision: false,
            contextWindow: 128000,
            maxTokens: 512,
          },
        ],
      },
    });
    models = new ModelRuns({
      settings,
      origin,
      sdkFile,
      nativeOnly: true,
      workspace: path.join(root, 'workspace'),
      dir: path.join(root, 'model'),
    });
    await models.start('a', {
      requestId: 'mock-native-turn',
      prompt: 'Return the fixed synthetic result without tools.',
    });
    const job = models.jobs.get('a')!;
    await job.done;
    assert.equal(job.phase, 'completed', job.error);
    assert.equal(job.result, 'SYNTHETIC SDK RESULT');
    assert.equal(requests, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      rejectedUpdates.filter((update) => update.activeTurn),
      [],
    );
    assert.ok(keys.has('contextPressure'), 'actual SDK contextPressure must reach the bridge');
    assert.ok(keys.has('contextBreakdown'), 'actual SDK contextBreakdown must reach the bridge');
    const scope = { bot: 'a', runId: job.id, chatRevision: 0 };
    const view = await models.inspectContext({ scope });
    assert.equal(view.state, 'captured');
    if (view.state !== 'captured') throw Error('SYNTHETIC CAPTURE MISSING');
    assert.equal(view.selected.pressure?.pressureTokens, 123);
    assert.ok(view.selected.breakdown);
    assert.ok(
      (view.selected.sources.find((source) => source.category === 'tools')?.hostTokens ?? 0) > 0,
      'Host tool schema estimates must come from the catalog actually served to this SDK',
    );
    assert.equal(JSON.stringify(view).includes('mock-local-provider-key'), false);
    assert.equal(JSON.stringify(view).includes('Return the fixed'), false);
  } finally {
    await models?.close();
    await close(bridge);
    await close(provider);
    await rm(root, { recursive: true, force: true });
  }
});

// The injected Harness exercises lifecycle failures deterministically; it never runs real tools or inference.
test('prune and committed summary keep visible originals readable after capture retention and Host restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-context-lifecycle-'));
  const text = 'SYNTHETIC VISIBLE 😀\n'.repeat(5000);
  let runs = 0;
  class Harness {
    async start() {}
    async close() {}
    async resumeSession(_id: string) {
      return this.session();
    }
    session() {
      return {
        id: 'mock-sdk-session',
        run: async (_input: unknown, observer: { onNotification(note: unknown): unknown }) => {
          runs++;
          const emit = (type: string, seq: number, data: unknown, extra: object = {}) =>
            observer.onNotification({
              method: 'session.event',
              params: {
                sessionId: 'mock-sdk-session',
                event: { type, seq, time: 1800000000000 + seq, data, ...extra },
              },
            });
          emit('tool/call', 1, { callId: 'mock-call', name: 'mock_read', arguments: '{}' });
          emit('tool/result', 2, {
            message: { toolCallId: 'mock-call', content: [{ type: 'text', text }] },
          });
          for (let index = 0; index < 25; index++) {
            const seq = 3 + index * 2;
            emit('compaction/prune', seq, {
              shadowedRange: { start: 2, end: 2 },
              shadowedSeqs: [2],
            });
            emit(
              'tool/result',
              seq + 1,
              {
                message: {
                  toolCallId: 'mock-call',
                  content: [{ type: 'text', text: 'SYNTHETIC PRUNED' }],
                },
              },
              { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 }, sourceEventSeqs: [2] },
            );
          }
          emit('compaction/start', 100, { compactionId: 'mock-summary', turn: 1 });
          emit('compaction/summary', 101, {
            compactionId: 'mock-summary',
            summary: [{ type: 'text', text: 'SYNTHETIC SUMMARY' }],
            rawOutput: 'SYNTHETIC PRIVATE',
            shadowedRange: { start: 2, end: 1 },
            shadowedSeqs: [2, 1],
          });
          emit(
            'user/message',
            102,
            {},
            { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 1 }, sourceEventSeqs: [100, 101] },
          );
          emit('compaction/end', 103, { compactionId: 'mock-summary', turn: 1 });
          return { sessionId: 'mock-sdk-session', finalResponse: 'SYNTHETIC RESULT' };
        },
      };
    }
  }
  const settings = new ModelSettings(path.join(root, 'credentials.json'));
  await settings.save({ apiKey: 'mock-lifecycle-key' });
  const options = {
    settings,
    origin: 'http://127.0.0.1:12345',
    Harness,
    workspace: path.join(root, 'workspace'),
    dir: path.join(root, 'model'),
  };
  let models = new ModelRuns(options);
  try {
    await models.start('a', { requestId: 'mock-turn', prompt: 'SYNTHETIC REQUEST' });
    const job = models.jobs.get('a')!;
    await job.done;
    assert.equal(job.phase, 'completed', job.error);
    const scope = { bot: 'a', runId: job.id, chatRevision: 0 };
    const view = await models.inspectContext({ scope });
    assert.equal(view.state, 'captured');
    if (view.state !== 'captured') throw Error('SYNTHETIC CAPTURE MISSING');
    assert.ok(view.revisions[0] > 1);
    assert.ok(view.revisions.length <= 20);
    assert.deepEqual(view.selected.boundary, {
      kind: 'summary',
      endSeq: 103,
      shadowedSeqs: [2, 1],
      omittedSeqs: 0,
    });
    assert.equal(JSON.stringify(view).includes('SYNTHETIC PRIVATE'), false);
    const ref = view.selected.sources.find((source) => source.category === 'toolResults')!.refs[1];
    assert.ok(ref);
    await models.close();
    models = new ModelRuns(options);
    let offset = 0,
      recovered = '';
    for (;;) {
      const page = await models.contextSource({
        scope,
        revision: view.selected.revision,
        ref,
        offset,
      });
      recovered += page.text;
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    }
    assert.equal(recovered, text);
    await assert.rejects(models.inspectContext({ scope, revision: 1 }), {
      code: 'CONTEXT_CAPTURE_EXPIRED',
    });
    assert.equal(runs, 1);
    assert.equal(models.jobs.get('a')?.running, false);
  } finally {
    await models.close();
    await rm(root, { recursive: true, force: true });
  }
});

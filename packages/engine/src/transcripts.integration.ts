import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { projectThinking, projectTranscript, Transcripts } from './transcripts.js';

const sdkFile =
  process.env.DABAN_TEST_SDK ||
  '/opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js';
interface NativeHarness {
  start: () => Promise<unknown>;
  close: () => Promise<unknown>;
  session: () => {
    id: string;
    run: (
      input: string,
      options: { onNotification: (note: unknown) => unknown },
    ) => Promise<{ finalResponse: string }>;
  };
}

test('the installed native SDK records its actual tool, plan and reply events using only a synthetic local provider', {
  skip: !existsSync(sdkFile),
  timeout: 60000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-native-transcript-'));
  const log = new Transcripts(path.join(root, 'transcripts.sqlite'));
  const scope = { bot: 'mock-native-bot', runId: 'mock-native-run', chatRevision: 0 };
  let requests = 0;
  const providerErrors: string[] = [];
  const diagnostics: unknown[] = [];
  const provider = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(input.stream, true);
      assert.equal(input.model, 'mock-transcript-model');
      assert.equal(request.headers.authorization, 'Bearer mock-local-provider-key');
      assert.ok(++requests <= 2);
      if (requests === 1)
        assert.ok(
          input.tools.some(
            (tool: { function?: { name: string } }) => tool.function?.name === 'todo_write',
          ),
        );
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const emit = (delta: object, finish_reason: string | null) =>
        response.write(
          `data: ${JSON.stringify({
            id: `mock-response-${requests}`,
            object: 'chat.completion.chunk',
            created: 1800000000,
            model: 'mock-transcript-model',
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      emit({ role: 'assistant', reasoning_content: `合成原生思考 ${requests}` }, null);
      if (requests === 1) {
        emit(
          {
            role: 'assistant',
            tool_calls: [
              {
                index: 0,
                id: 'mock-native-call',
                type: 'function',
                function: {
                  name: 'todo_write',
                  arguments: JSON.stringify({
                    todos: [{ content: '合成原生检查', status: 'completed' }],
                  }),
                },
              },
            ],
          },
          null,
        );
        emit({}, 'tool_calls');
      } else {
        emit({ role: 'assistant', content: '合成原生SDK完成' }, null);
        emit({}, 'stop');
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      providerErrors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500);
      response.end('SYNTHETIC PROVIDER REJECTED');
    }
  });
  let harness: NativeHarness | undefined;
  try {
    await new Promise<unknown>((resolve) =>
      provider.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = provider.address();
    assert.ok(address && typeof address !== 'string');
    const patch = path.join(root, 'mock.patch.yml');
    await writeFile(
      patch,
      JSON.stringify([
        ...[
          'tool-fs',
          'tool-working-directory',
          'pty',
          'terminal-bash',
          'terminal-pwsh',
          'persistent-bash',
          'persistent-pwsh',
          'llm-deepseek',
        ].map((id) => ({ id, disabled: true })),
        {
          insert: [
            {
              id: 'mock-todo',
              name: '@deepseek-ai/dsh-tool-todo',
              config: { allowParallelInProgress: false },
            },
            {
              id: 'mock-local-provider',
              name: '@deepseek-ai/dsh-llm-pi-ai',
              config: {
                providers: {
                  'mock-local': {
                    apiKeyEnv: 'MOCK_PROVIDER_KEY',
                    api: 'openai-completions',
                    baseURL: `http://127.0.0.1:${address.port}/v1`,
                    retryPolicy: { mode: 'normal', maxRetries: 0 },
                    models: [
                      {
                        id: 'mock-transcript-model',
                        input: ['text'],
                        contextWindow: 32000,
                        maxTokens: 512,
                        reasoningEfforts: false,
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      ]),
    );
    const { DeepSeekHarness } = (await import(pathToFileURL(sdkFile).href)) as {
      DeepSeekHarness: new (options: object) => NativeHarness;
    };
    harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      patches: [patch],
      dshHome: path.join(root, 'dsh'),
      processCwd: root,
      cwd: root,
      provider: 'mock-local',
      model: 'mock-transcript-model',
      maxTokens: 512,
      initializeTimeoutMs: 15000,
      env: {
        PATH: process.env.PATH,
        LANG: 'C.UTF-8',
        MOCK_PROVIDER_KEY: 'mock-local-provider-key',
        DSH_SYSTEM_PROMPT: 'Synthetic local SDK fixture only.',
      },
    });
    await log.ready;
    log.begin(scope);
    await harness.start();
    const session = harness.session();
    const result = await session.run('执行合成计划后回复合成原生SDK完成。', {
      onNotification: (note) => {
        const thinking = projectThinking(note, session.id, (text) =>
          text.replaceAll('mock-local-provider-key', '[credential redacted]'),
        );
        if (thinking) log.append(scope, thinking);
        if (note && typeof note === 'object' && 'params' in note) {
          const params = note.params as { event?: { type: string }; status?: unknown };
          if (/error|failed|turn\/end/.test(params.event?.type ?? '') || params.status)
            diagnostics.push(note);
        }
        const entry = projectTranscript(note, session.id, (text) =>
          text.replaceAll('mock-local-provider-key', '[credential redacted]'),
        );
        if (entry) log.append(scope, entry);
      },
    });
    log.finish(scope);
    assert.equal(
      result.finalResponse,
      '合成原生SDK完成',
      JSON.stringify({ requests, providerErrors, diagnostics }),
    );
    assert.equal(requests, 2);
    const page = log.page(scope);
    assert.equal(page.state, 'complete');
    assert.ok(page.items.some((item) => item.kind === 'call' && item.name === 'todo_write'));
    assert.ok(
      page.items.some((item) => item.kind === 'result' && item.callId === 'mock-native-call'),
    );
    assert.ok(page.items.some((item) => item.kind === 'plan'));
    assert.ok(page.items.some((item) => item.kind === 'assistant'));
    assert.equal(page.items.filter((item) => item.kind === 'thinking').length, 2);
    assert.ok(
      page.items.filter((item) => item.kind === 'thinking').every((item) => item.thinkingId),
    );
    const content = page.items.map((item) => log.content(scope, item.seq).text).join('\n');
    assert.ok(content.includes('合成原生检查'));
    assert.ok(content.includes('合成原生思考 1'));
    assert.equal(content.includes('mock-local-provider-key'), false);
  } finally {
    try {
      await harness?.close();
    } finally {
      try {
        await log.close();
      } finally {
        provider.closeAllConnections();
        await new Promise<unknown>((resolve) => provider.close(() => resolve(undefined)));
        await rm(root, { recursive: true, force: true });
      }
    }
  }
});

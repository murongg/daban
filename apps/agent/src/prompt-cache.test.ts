import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startNativeAgent } from '@daban/engine/agent';
import type { ModelApi } from '@daban/protocol';
import { expect, test } from 'vitest';
import { resolveSdk } from './sdk.js';

test('real DSH keeps conversation cache identity across tasks/restarts and preserves all four provider protocols', {
  timeout: 60000,
}, async (t) => {
  const started = performance.now();
  const root = await mkdtemp(path.join(tmpdir(), 'mock-prompt-cache-'));
  let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
  const captures: { path: string; session?: string; body: Record<string, unknown> }[] = [];
  let currentApi: ModelApi | undefined;
  let currentBot: string | undefined;
  let sequence = 0;
  let currentTask: number | undefined;
  let currentGroup = false;
  let currentChatRevision = 0;
  let catalogs = 0;
  let emitted = 0;
  let active = { name: 'fixture', since: started };
  const safeCode = (error: unknown) => {
    const candidate = error instanceof Error && 'code' in error ? error.code : error;
    return typeof candidate === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidate)
      ? candidate
      : error
        ? 'UNCLASSIFIED'
        : undefined;
  };
  const report = (phase: string, event: string, since: number, error?: unknown) => {
    // Bound diagnostic volume, but always retain the timeout and final snapshots.
    if (emitted >= 160 && event !== 'test.abort' && event !== 'test.finished') return;
    emitted++;
    const job = currentBot ? agent?.models.jobs.get(currentBot) : undefined;
    const current = job?.task?.requestId === `mock-cache-${currentTask}` ? job : undefined;
    const now = performance.now();
    // Vitest hides passing-test console output by default; keep these bounded timing records visible.
    process.stderr.write(
      `[prompt-cache-phase] ${JSON.stringify({
        event,
        phase,
        elapsedMs: Math.round(now - started),
        phaseMs: Math.round(now - since),
        api: currentApi,
        task: currentTask,
        group: currentGroup,
        chatRevision: currentChatRevision,
        catalogs,
        requests: captures.length,
        jobPhase: current?.phase,
        jobRunning: current?.running,
        jobError: safeCode(current?.error),
        errorCode: safeCode(error),
        aborted: t.signal.aborted,
        testState: t.task.result?.state,
      })}\n`,
    );
  };
  const phase = async <T>(name: string, operation: () => T | Promise<T>) => {
    const since = performance.now();
    active = { name, since };
    report(name, 'begin', since);
    try {
      const result = await operation();
      report(name, 'end', since);
      return result;
    } catch (error) {
      report(name, 'error', since, error);
      throw error;
    }
  };
  const aborted = () => report(active.name, 'test.abort', active.since, t.signal.reason);
  t.signal.addEventListener('abort', aborted, { once: true });
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') {
      catalogs++;
      report(active.name, 'provider.catalog', active.since);
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          data: [{ id: 'mock-model' }],
          type: 'model',
          id: 'mock-model',
          name: 'models/mock-model',
          supportedGenerationMethods: ['generateContent'],
          models: [{ name: 'models/mock-model', supportedGenerationMethods: ['generateContent'] }],
        }),
      );
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    const pathname = req.url!.split('?')[0];
    captures.push({ path: req.url!, session: req.headers.session_id as string | undefined, body });
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frames: unknown[] = [];
    const text = 'SYNTHETIC COMPLETE';
    if (pathname.endsWith('/chat/completions')) {
      const frame = {
        id: 'mock-completion',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'mock-model',
      };
      frames.push(
        {
          ...frame,
          choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
        },
        {
          ...frame,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: {
            prompt_tokens: 24000,
            completion_tokens: 10,
            total_tokens: 24010,
            prompt_tokens_details: { cached_tokens: captures.length > 1 ? 23000 : 0 },
          },
        },
      );
    } else if (pathname.endsWith('/responses')) {
      const item = {
        id: 'mock-message',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      };
      frames.push(
        {
          type: 'response.created',
          response: { id: 'mock-response', model: 'mock-model', status: 'in_progress', output: [] },
        },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        {
          type: 'response.content_part.added',
          output_index: 0,
          content_index: 0,
          part: { type: 'output_text', text: '', annotations: [] },
        },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: text },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'mock-response',
            model: 'mock-model',
            status: 'completed',
            output: [item],
            usage: {
              input_tokens: 24000,
              output_tokens: 10,
              total_tokens: 24010,
              input_tokens_details: { cached_tokens: 23000 },
            },
          },
        },
      );
    } else if (pathname.endsWith('/messages')) {
      frames.push(
        {
          type: 'message_start',
          message: {
            id: 'mock-message',
            type: 'message',
            model: 'mock-model',
            role: 'assistant',
            content: [],
            usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 23000 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: 10 },
        },
        { type: 'message_stop' },
      );
    } else {
      frames.push({
        candidates: [
          { index: 0, finishReason: 'STOP', content: { role: 'model', parts: [{ text }] } },
        ],
        usageMetadata: {
          promptTokenCount: 24000,
          candidatesTokenCount: 10,
          totalTokenCount: 24010,
          cachedContentTokenCount: 23000,
        },
      });
    }
    res.end(
      frames
        .map((frame) => {
          const type = (frame as { type?: string }).type;
          return `${type ? `event: ${type}\n` : ''}data: ${JSON.stringify(frame)}\n\n`;
        })
        .join('') + (req.url?.includes('/chat/completions') ? 'data: [DONE]\n\n' : ''),
    );
    report(active.name, 'provider.response', active.since);
  });
  t.onTestFinished(async () => {
    report(active.name, 'test.finished', active.since, t.task.result?.errors?.[0]);
    t.signal.removeEventListener('abort', aborted);
    await phase('cleanup.agent.stop', () => agent?.close());
    model.closeAllConnections();
    if (model.listening)
      await phase('cleanup.provider.stop', () => new Promise((resolve) => model.close(resolve)));
    await phase('cleanup.directory', () => rm(root, { recursive: true, force: true }));
  });
  model.listen(0, '127.0.0.1');
  await phase('provider.listen', () => once(model, 'listening'));
  const port = (model.address() as { port: number }).port;
  const scope = createHash('sha256').update(root).digest('hex');
  const options = {
    dataRoot: root,
    socketPath:
      process.platform === 'win32'
        ? String.raw`\\.\pipe\daban-agent-${scope.slice(0, 24)}`
        : path.join(root, 'a.sock'),
    scope,
    sdkFile: resolveSdk(),
    nativeWorkspace: path.join(root, 'workspace'),
  };
  agent = await phase('agent.start', () => startNativeAgent(options));
  const run = async (bot: string, chatRevision = 0, conversationId?: string) => {
    currentBot = bot;
    currentTask = sequence + 1;
    currentGroup = conversationId !== undefined;
    currentChatRevision = chatRevision;
    await phase('task.start', () =>
      agent!.models.start(
        bot,
        {
          requestId: `mock-cache-${++sequence}`,
          prompt: 'SYNTHETIC: reply briefly without tools.',
          ...(conversationId ? {} : { chatRevision }),
        },
        conversationId ? { id: conversationId, context: 'SYNTHETIC GROUP' } : undefined,
      ),
    );
    const job = agent!.models.jobs.get(bot)!;
    await phase('task.wait', () => job.done);
    expect(job.phase, `${bot}: ${job.error}; ${captures.at(-1)?.path}`).toBe('completed');
    expect(job.result).toBe('SYNTHETIC COMPLETE');
    return captures.at(-1)!;
  };
  const apis: ModelApi[] = [
    'openai-completions',
    'openai-responses',
    'anthropic-messages',
    'google-generative-ai',
  ];
  let revision = 0;
  for (const api of apis) {
    const bot = `mock-${api}`;
    currentApi = api;
    currentBot = bot;
    currentTask = undefined;
    currentGroup = false;
    currentChatRevision = 0;
    await phase('provider.configure', () =>
      agent!.models.settings.configure({
        model: `provider:${bot}:mock-model`,
        revision: revision++,
        requestId: `mock-config-${api}`,
        apiKey: 'synthetic-model-key',
        connection: {
          id: bot,
          name: bot,
          api,
          baseURL: `http://127.0.0.1:${port}${api === 'anthropic-messages' ? '' : api === 'google-generative-ai' ? '/v1beta' : '/v1'}`,
          models: [
            {
              id: 'mock-model',
              name: 'Mock',
              vision: false,
              contextWindow: 500000,
              maxTokens: 8192,
            },
          ],
        },
      }),
    );
    await phase('profile.register', () =>
      agent!.models.profiles.register({
        id: bot,
        name: bot,
        color: 'mint',
        instructions: '',
        memory: '',
      }),
    );
    const first = await run(bot);
    const second = await run(bot);
    const events = await phase('cache.read', async () => {
      const sessionRoot = path.join(agent!.models.dir, 'dsh', bot);
      const sessions = (await readdir(sessionRoot, { recursive: true })).filter((file) =>
        file.endsWith('session.v4.jsonl'),
      );
      return (
        await Promise.all(sessions.map((file) => readFile(path.join(sessionRoot, file), 'utf8')))
      )
        .join('\n')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    });
    const usage = events.filter((event) => event.type === 'assistant/message').at(-1)?.data.usage;
    expect(usage?.cacheReadTokens, `${api} must preserve native cache usage`).toBe(23000);
    if (api.startsWith('openai-')) {
      const key = first.body.prompt_cache_key;
      expect(String(key)).toMatch(/^daban-[a-f0-9]{48}$/);
      expect(first.session).toBe(key);
      expect(second.body.prompt_cache_key).toBe(key);
      expect(second.session).toBe(key);
      expect(second.body.tools).toStrictEqual(first.body.tools);
      const field = api === 'openai-completions' ? 'messages' : 'input';
      const prefix = first.body[field] as unknown[];
      expect((second.body[field] as unknown[]).slice(0, prefix.length)).toStrictEqual(prefix);
      await phase('agent.restart.stop', () => agent!.close());
      agent = await phase('agent.restart.start', () => startNativeAgent(options));
      expect((await run(bot)).body.prompt_cache_key).toBe(key);
      expect((await run(bot, 0, 'mock-group')).body.prompt_cache_key).not.toBe(key);
      await phase('conversation.renew', () =>
        agent!.models.chats.renew({ id: `mock-renew-${api}`, bot, revision: 0 }),
      );
      expect((await run(bot, 1)).body.prompt_cache_key).not.toBe(key);
    } else {
      expect(first.body.prompt_cache_key).toBe(undefined);
      expect(first.session).toBe(undefined);
      expect(second.body.prompt_cache_key).toBe(undefined);
      expect(second.session).toBe(undefined);
      expect.assert(api === 'anthropic-messages' ? first.body.messages : first.body.contents);
    }
  }
});

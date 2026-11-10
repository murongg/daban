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
  const root = await mkdtemp(path.join(tmpdir(), 'mock-prompt-cache-'));
  let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
  const captures: { path: string; session?: string; body: Record<string, unknown> }[] = [];
  const model = createServer(async (req, res) => {
    if (req.method === 'GET') {
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
  });
  t.onTestFinished(async () => {
    await agent?.close();
    model.closeAllConnections();
    if (model.listening) await new Promise((resolve) => model.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
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
  agent = await startNativeAgent(options);
  let sequence = 0;
  const run = async (bot: string, chatRevision = 0, conversationId?: string) => {
    await agent!.models.start(
      bot,
      {
        requestId: `mock-cache-${++sequence}`,
        prompt: 'SYNTHETIC: reply briefly without tools.',
        ...(conversationId ? {} : { chatRevision }),
      },
      conversationId ? { id: conversationId, context: 'SYNTHETIC GROUP' } : undefined,
    );
    const job = agent!.models.jobs.get(bot)!;
    await job.done;
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
    await agent.models.settings.configure({
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
          { id: 'mock-model', name: 'Mock', vision: false, contextWindow: 500000, maxTokens: 8192 },
        ],
      },
    });
    await agent.models.profiles.register({
      id: bot,
      name: bot,
      color: 'mint',
      instructions: '',
      memory: '',
    });
    const first = await run(bot);
    const request = JSON.stringify(first.body);
    expect(request, `${api} must send Daban's file routing policy`).toContain(
      'Omit offset and limit on the first read',
    );
    expect(request, `${api} must send the matching todo tool description`).toContain(
      'Skip routine file tasks such as reading known inputs',
    );
    const second = await run(bot);
    const sessionRoot = path.join(agent.models.dir, 'dsh', bot);
    const sessions = (await readdir(sessionRoot, { recursive: true })).filter((file) =>
      file.endsWith('session.v4.jsonl'),
    );
    const events = (
      await Promise.all(sessions.map((file) => readFile(path.join(sessionRoot, file), 'utf8')))
    )
      .join('\n')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
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
      await agent.close();
      agent = await startNativeAgent(options);
      expect((await run(bot)).body.prompt_cache_key).toBe(key);
      expect((await run(bot, 0, 'mock-group')).body.prompt_cache_key).not.toBe(key);
      await agent.models.chats.renew({ id: `mock-renew-${api}`, bot, revision: 0 });
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

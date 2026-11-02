import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startNativeAgent } from '@daban/engine/agent';
import { resolveSdk } from './sdk.js';

test('real DSH preserves a reusable conversation below the model compaction budget', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-compaction-'));
  let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
  let model: ReturnType<typeof createServer> | undefined;
  t.after(async () => {
    await agent?.close();
    model?.closeAllConnections();
    if (model?.listening) await new Promise((resolve) => model!.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  let calls = 0;
  let summaries = 0;
  const requests: {
    key?: string;
    session?: string;
    tools: unknown;
    messages: unknown[];
  }[] = [];
  model = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'mock-model' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      tools?: { function?: { name?: string } }[];
      max_tokens?: number;
      max_completion_tokens?: number;
      prompt_cache_key?: string;
      messages: unknown[];
    };
    requests.push({
      key: input.prompt_cache_key,
      session: req.headers.session_id as string | undefined,
      tools: input.tools,
      messages: input.messages,
    });
    calls += 1;
    if (calls > 8) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Synthetic request limit' } }));
      return;
    }
    // DSH reuses the task's tools for summaries; the separate output budget identifies that call.
    const summary = (input.max_tokens ?? input.max_completion_tokens) === 2048;
    if (summary) summaries += 1;
    const name = input.tools?.find((tool) => tool.function?.name?.endsWith('bot_memory_read'))
      ?.function?.name;
    const tool = calls === 1 && name;
    const message = tool
      ? {
          role: 'assistant',
          // A tail larger than retainTokens lets an early compactor select the preceding history.
          content: 'SYNTHETIC PLAN. '.repeat(3000),
          tool_calls: [
            {
              index: 0,
              id: 'mock-memory-call',
              type: 'function',
              function: { name, arguments: '{}' },
            },
          ],
        }
      : {
          role: 'assistant',
          content: summary ? 'SYNTHETIC SUMMARY' : 'SYNTHETIC TASK COMPLETE',
        };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = {
      id: 'mock-completion',
      object: 'chat.completion.chunk',
      created: 1,
      model: 'mock-model',
    };
    const delta = {
      ...frame,
      choices: [{ index: 0, delta: message, finish_reason: null }],
    };
    const end = {
      ...frame,
      choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: {
        prompt_tokens: 24000,
        completion_tokens: tool ? 12000 : 10,
        total_tokens: tool ? 36000 : 24010,
      },
    };
    res.end(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`);
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const port = (model.address() as { port: number }).port;
  const scope = createHash('sha256').update(root).digest('hex');
  agent = await startNativeAgent({
    dataRoot: root,
    socketPath:
      process.platform === 'win32'
        ? String.raw`\\.\pipe\daban-agent-${scope.slice(0, 24)}`
        : path.join(root, 'a.sock'),
    scope,
    sdkFile: resolveSdk(),
    nativeWorkspace: path.join(root, 'workspace'),
  });
  await agent.models.settings.configure({
    model: 'provider:mock-provider:mock-model',
    revision: 0,
    requestId: 'mock-setup',
    apiKey: 'synthetic-model-key',
    connection: {
      id: 'mock-provider',
      name: 'Synthetic provider',
      baseURL: `http://127.0.0.1:${port}/v1`,
      models: [
        {
          id: 'mock-model',
          name: 'Synthetic model',
          vision: false,
          contextWindow: 500000,
          maxTokens: 16384,
        },
      ],
    },
  });
  await agent.models.profiles.register({
    id: 'mock-bot',
    name: 'Synthetic Bot',
    color: 'mint',
    instructions: '',
    memory: '',
  });
  await agent.models.start('mock-bot', {
    requestId: 'mock-compaction-request',
    prompt: 'Read the synthetic memory once, then finish.',
    chatRevision: 0,
  });
  const until = Date.now() + 45000;
  while (agent.models.jobs.get('mock-bot')?.running && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const job = agent.models.jobs.get('mock-bot')!;
  await job.done;
  assert.equal(summaries, 0, 'ample context must not cause extra summarization requests');
  assert.equal(job.phase, 'completed', job.error);
  assert.equal(calls, 2, 'one tool call and one answer must suffice');
  assert.match(job.result, /SYNTHETIC TASK COMPLETE/);
  assert.match(requests[0].key ?? '', /^daban-[a-f0-9]{48}$/);
  assert.equal(requests[0].session, requests[0].key);
  assert.equal(requests[1].key, requests[0].key);
  assert.equal(requests[1].session, requests[0].session);
  assert.deepEqual(requests[1].tools, requests[0].tools);
  assert.deepEqual(
    requests[1].messages.slice(0, requests[0].messages.length),
    requests[0].messages,
    'a tool step must append to the previous prefix rather than rewrite it',
  );
});

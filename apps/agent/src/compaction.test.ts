import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startNativeAgent } from '@daban/engine/agent';
import { expect, test } from 'vitest';
import { resolveSdk } from './sdk.js';

test('real DSH preserves a reusable conversation below the model compaction budget', {
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-compaction-'));
  let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
  let model: ReturnType<typeof createServer> | undefined;
  t.onTestFinished(async () => {
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
        prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
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
  expect(summaries, 'ample context must not cause extra summarization requests').toBe(0);
  expect(job.phase, job.error).toBe('completed');
  expect(calls, 'one tool call and one answer must suffice').toBe(2);
  expect(job.result).toMatch(/SYNTHETIC TASK COMPLETE/);
  expect(requests[0].key ?? '').toMatch(/^daban-[a-f0-9]{48}$/);
  expect(requests[0].session).toBe(requests[0].key);
  expect(requests[1].key).toBe(requests[0].key);
  expect(requests[1].session).toBe(requests[0].session);
  expect(requests[1].tools).toStrictEqual(requests[0].tools);
  expect(
    requests[1].messages.slice(0, requests[0].messages.length),
    'a tool step must append to the previous prefix rather than rewrite it',
  ).toStrictEqual(requests[0].messages);
});

for (const needsSummary of [false, true])
  test(`real DSH ${needsSummary ? 'summarizes' : 'prunes without summarizing'} and recovers exact saved tool output`, {
    timeout: 90000,
  }, async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-context-loop-'));
    let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
    const requests: { max: number; messages: { role: string; content: unknown }[] }[] = [];
    let normal = 0,
      summaries = 0,
      readSeq: number | undefined,
      pruned = false,
      recovered = false;
    const label = 'EXACT_MIDDLE_73';
    const memory = 'SYNTHETIC_MEMORY '.repeat(300) + label + ' SYNTHETIC_MEMORY '.repeat(300);
    const server = createServer(async (req, res) => {
      try {
        if (req.method === 'GET') {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ data: [{ id: 'mock-context-model' }] }));
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          tools: { function: { name: string } }[];
          messages: { role: string; content: unknown }[];
          max_tokens?: number;
          max_completion_tokens?: number;
        };
        const max = input.max_tokens ?? input.max_completion_tokens ?? 0;
        requests.push({ max, messages: input.messages });
        const summary = max < 8192;
        if (summary) summaries++;
        else normal++;
        if (requests.length > 12) throw Error('SYNTHETIC_REQUEST_LIMIT');
        const toolName = (suffix: string) => {
          const name = input.tools?.find((tool) => tool.function.name.endsWith(suffix))?.function
            .name;
          if (!name) throw Error('SYNTHETIC_TOOL_MISSING');
          return name;
        };
        let call: { name: string; arguments: string } | undefined;
        if (!summary && normal === 1) call = { name: toolName('bot_memory_read'), arguments: '{}' };
        else if (!summary && normal === 2) {
          const output = input.messages.filter((message) => message.role === 'tool').at(-1);
          const text = String(output?.content ?? '');
          pruned = text.length < memory.length && !text.includes(label);
          call = { name: toolName('bot_tool_result_read'), arguments: '{}' };
        } else if (!summary && normal === 3) {
          const output = input.messages.filter((message) => message.role === 'tool').at(-1);
          const page = JSON.parse(String(output?.content ?? '')) as { results: { seq: number }[] };
          if (page.results.length !== 1) throw Error('SYNTHETIC_DUPLICATE_PROJECTION');
          readSeq = page.results[0]?.seq;
          if (!readSeq) throw Error('SYNTHETIC_RESULT_REFERENCE_MISSING');
          call = {
            name: toolName('bot_tool_result_read'),
            arguments: JSON.stringify({ seq: readSeq, query: label, limit: 300 }),
          };
        } else if (!summary && normal === 4) {
          const output = input.messages.filter((message) => message.role === 'tool').at(-1);
          const page = JSON.parse(String(output?.content ?? '')) as { content: string };
          recovered = page.content.includes(label);
        }
        const content = summary
          ? 'SYNTHETIC PORTABLE CHECKPOINT: preserve mock reference 73 and finish the current task.'
          : normal === 1
            ? needsSummary
              ? 'SYNTHETIC_PROGRESS_73 '.repeat(1800)
              : 'SYNTHETIC PROGRESS'
            : 'SYNTHETIC CONTEXT COMPLETE';
        const message = {
          role: 'assistant',
          content,
          ...(call
            ? {
                tool_calls: [
                  { index: 0, id: `mock-context-call-${normal}`, type: 'function', function: call },
                ],
              }
            : {}),
        };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const frame = {
          id: 'mock-context-completion',
          object: 'chat.completion.chunk',
          created: 1,
          model: 'mock-context-model',
        };
        const promptTokens = summary ? 4000 : normal === 1 && !needsSummary ? 49500 : 40000;
        const completionTokens = normal === 1 && !summary && needsSummary ? 12000 : 40;
        res.end(
          `data: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ ...frame, choices: [{ index: 0, delta: {}, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } })}\n\ndata: [DONE]\n\n`,
        );
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'SYNTHETIC_PROVIDER_PROTOCOL_ERROR' } }));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.onTestFinished(async () => {
      await agent?.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
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
    const connection = {
      id: 'mock-context',
      name: 'Synthetic context model',
      baseURL: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
      models: [
        {
          id: 'mock-context-model',
          name: 'Synthetic',
          vision: false,
          contextWindow: 64000,
          maxTokens: 8192,
        },
      ],
    };
    await agent.models.settings.configure({
      model: 'provider:mock-context:mock-context-model',
      revision: 0,
      requestId: 'mock-context-setup',
      apiKey: 'synthetic-context-key',
      connection,
    });
    await agent.models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic context Bot',
      instructions: '',
      memory,
      color: 'mint',
    });
    await agent.models.start('mock-bot', {
      requestId: 'mock-pressure',
      prompt:
        'Read the synthetic memory, recover the exact middle marker from the saved tool output, then finish.',
    });
    const first = agent.models.jobs.get('mock-bot')!;
    await first.done;
    expect(first.phase, first.error).toBe('completed');
    expect.assert(pruned, 'the normal continuation must see the pruned result');
    expect.assert(recovered, 'the marker must remain readable from the original saved tool output');
    expect(summaries > 0).toBe(needsSummary);
    const budget = agent.models.budgets.view(first.budget!.budgetId);
    expect(budget.requests).toBe(requests.length);
    expect(budget.receipts.filter((receipt) => receipt.purpose === 'compaction')).toHaveLength(
      summaries,
    );
    expect(
      budget.unknownCount,
      JSON.stringify(
        budget.receipts.map((receipt) => ({ phase: receipt.phase, usage: receipt.usage })),
      ),
    ).toBe(0);
    expect(budget.availability).toBe('recorded');
    expect(normal).toBe(4);
    const saved = await agent.models.journal.read('mock-bot', first.id);
    if (needsSummary)
      expect(saved?.checkpoint?.text ?? '').toMatch(/SYNTHETIC PORTABLE CHECKPOINT/);
    else expect(saved?.checkpoint).toBe(undefined);
    await agent.close();
    agent = undefined;
    agent = await startNativeAgent(options);
    await agent.models.settings.configure({
      model: 'provider:mock-context:mock-context-model',
      revision: (await agent.models.settings.status()).revision!,
      requestId: 'mock-context-new-key',
      apiKey: 'synthetic-context-key-v2',
      connection,
    });
    await agent.models.start('mock-bot', {
      requestId: 'mock-after-restart',
      prompt: 'Continue the synthetic task using its saved checkpoint.',
    });
    const last = agent.models.jobs.get('mock-bot')!;
    await last.done;
    expect(last.phase, last.error).toBe('completed');
    expect(JSON.stringify(requests.at(-1)?.messages)).toMatch(
      needsSummary ? /SYNTHETIC PORTABLE CHECKPOINT/ : /Read the synthetic memory/,
    );
  });

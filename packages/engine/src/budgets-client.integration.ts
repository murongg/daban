import assert from 'node:assert/strict';
import { type ChildProcess, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { defaultBudgetPolicy, isBudgetView } from '@daban/protocol';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { startAgent } from './host-server.js';

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function client(socketPath: string, token: string, route: string, body: unknown) {
  const child = fork(fileURLToPath(new URL('./budgets-client.fixture.js', import.meta.url)), [], {
    execArgv: [],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString('utf8');
  });
  const response = once(child, 'message', { signal: AbortSignal.timeout(15000) }).then(
    ([value]: unknown[]) => {
      assert.ok(object(value) && typeof value.status === 'number', errors);
      return value;
    },
  );
  child.send({ socketPath, token, path: route, body });
  return {
    child,
    response,
    async close() {
      assert.equal(child.exitCode, null, errors);
      const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
      child.send('close');
      const [code] = await exited;
      assert.equal(code, 0, errors);
      assert.equal(child.connected, false);
    },
  };
}

test('accepted SDK task and real POSIX execution keep the same budget after a control client exits', {
  timeout: 60000,
}, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'synthetic-budget-client-'));
  let guest: Awaited<ReturnType<typeof startExecutor>> | undefined;
  let host: Awaited<ReturnType<typeof startAgent>> | undefined;
  const children: ChildProcess[] = [];
  const errors: string[] = [];
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
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.ok(object(body) && Array.isArray(body.tools));
      sends++;
      assert.ok(sends <= 2);
      const shell = body.tools.find(
        (tool: unknown) =>
          object(tool) &&
          object(tool.function) &&
          typeof tool.function.name === 'string' &&
          tool.function.name.endsWith('shell'),
      );
      assert.ok(object(shell) && object(shell.function) && typeof shell.function.name === 'string');
      if (sends === 2) assert.ok(JSON.stringify(body).includes('SYNTHETIC SHELL COMPLETE'));
      const delta =
        sends === 1
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: 'synthetic-shell',
                  type: 'function',
                  function: {
                    name: shell.function.name,
                    arguments: JSON.stringify({
                      command:
                        "printf STARTED >> started.txt; while [ ! -f release.txt ]; do sleep 0.05; done; uname -s > kernel.txt; printf 'SYNTHETIC SHELL COMPLETE' >> complete.txt; cat complete.txt",
                    }),
                  },
                },
              ],
            }
          : { role: 'assistant', content: 'SYNTHETIC TASK COMPLETE' };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify({ id: `synthetic-${sends}`, object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta, finish_reason: sends === 1 ? 'tool_calls' : 'stop' }], ...(sends === 2 ? { usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } } : {}) })}\n\ndata: [DONE]\n\n`,
      );
    } catch (error) {
      errors.push(error instanceof Error ? error.message : 'SYNTHETIC_PROVIDER_FAILURE');
      response.writeHead(500);
      response.end('SYNTHETIC_PROVIDER_FAILURE');
    }
  });
  t.after(async () => {
    const closed: PromiseSettledResult<unknown>[] = await Promise.allSettled(
      children.map(async (child) => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const exited = once(child, 'exit', { signal: AbortSignal.timeout(10000) });
        child.kill('SIGTERM');
        await exited;
      }),
    );
    // Drain the Host first, but a cleanup failure must not leave the other test owners running.
    for (const dispose of [
      () => host?.close(),
      () => guest?.close(),
      async () => {
        provider.closeAllConnections();
        await new Promise<unknown>((resolve, reject) =>
          provider.close((error) => (error ? reject(error) : resolve(undefined))),
        );
      },
      () => rm(temporary, { recursive: true, force: true }),
    ])
      closed.push(...(await Promise.allSettled([Promise.resolve().then(dispose)])));
    const failure = closed.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  });
  provider.listen(0, '127.0.0.1');
  await once(provider, 'listening');
  guest = await startExecutor({
    directory: path.join(temporary, 'guest'),
    port: 0,
    boot: 'synthetic-client-boot',
  });
  const execution = new RemoteExecutor({
    url: `${guest.origin}/exec`,
    token: (await readFile(path.join(temporary, 'guest/token'), 'utf8')).trim(),
  });
  await execution.ready;
  const root = path.join(temporary, 'host');
  host = await startAgent({
    dataRoot: root,
    socketPath: path.join(root, 'a.sock'),
    scope: createHash('sha256').update(root).digest('hex'),
    execution,
    sdkFile: createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client'),
  });
  const address = provider.address();
  assert.ok(address && typeof address !== 'string');
  await host.models.settings.configure({
    revision: 0,
    requestId: 'synthetic-config',
    apiKey: 'synthetic-provider-key',
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
  await host.models.profiles.register({
    id: 'mock-bot',
    name: 'Synthetic Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  const route = await host.models.settings.capture();
  const price = {
    id: 'synthetic-price-before',
    routeKey: JSON.stringify([
      route.primary.provider,
      route.primary.api,
      route.primary.apiModel,
      route.revision,
    ]),
    currency: 'USD',
    createdAt: '2026-01-01T00:00:00Z',
    input: 1000000,
    output: 1000000,
    cacheRead: 1000000,
    cacheWrite: 1000000,
  };
  host.models.budgets.configure(
    0,
    { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 2 },
    [price],
    'synthetic-budget',
  );
  const accepted = client(host.socketPath, host.token, '/api/bots/mock-bot/model', {
    running: true,
    task: {
      requestId: 'synthetic-task',
      approvalMode: 'full',
      prompt: 'Run the synthetic shell and finish.',
    },
  });
  children.push(accepted.child);
  const receipt = await accepted.response;
  assert.equal(receipt.status, 200, JSON.stringify(receipt));
  const job = host.models.jobs.get('mock-bot');
  assert.ok(job?.budget);
  assert.ok(object(receipt.value));
  assert.equal(receipt.value.runId, job.id);
  const until = Date.now() + 15000;
  while (
    Date.now() < until &&
    !(await readFile(path.join(job.workdir, 'started.txt'), 'utf8').catch(() => ''))
  )
    await delay(25);
  assert.equal(await readFile(path.join(job.workdir, 'started.txt'), 'utf8'), 'STARTED');
  assert.equal(
    await readFile(path.join(job.workdir, 'complete.txt'), 'utf8').catch(() => undefined),
    undefined,
  );
  const before = host.models.budgets.view(job.budget.budgetId);
  assert.equal(before.requests, 1);
  assert.equal(before.unknownCount, 1);
  const session = job.sessionId;
  const lease = job.executionId;
  assert.equal(typeof session, 'string');
  assert.equal(typeof lease, 'string');
  // Release the real shell only after the control process has exited, so completion cannot race ahead of disconnection.
  await accepted.close();
  assert.equal(job.running, true);
  assert.equal(sends, 1);
  host.models.budgets.configure(
    1,
    { ...defaultBudgetPolicy, mode: 'strict', maxRequests: 2 },
    [{ ...price, id: 'synthetic-price-after', input: 9000000 }],
    'synthetic-default-change',
  );
  await writeFile(path.join(job.workdir, 'release.txt'), 'SYNTHETIC RELEASE AFTER CLIENT EXIT');
  await job.done;
  assert.equal(job.phase, 'completed', JSON.stringify({ error: job.error, errors }));
  assert.equal(host.models.jobs.get(job.bot), job);
  assert.equal(job.sessionId, session);
  assert.equal(job.executionId, lease);
  assert.equal(job.requestId, 'synthetic-task');
  assert.equal(job.toolCount, 1);
  assert.equal(job.task?.approvalMode, 'full');
  assert.equal(await readFile(path.join(job.workdir, 'started.txt'), 'utf8'), 'STARTED');
  assert.equal(
    await readFile(path.join(job.workdir, 'complete.txt'), 'utf8'),
    'SYNTHETIC SHELL COMPLETE',
  );
  const kernel = (await readFile(path.join(job.workdir, 'kernel.txt'), 'utf8')).trim();
  assert.equal(kernel, process.platform === 'linux' ? 'Linux' : 'Darwin');
  const reconnected = client(host.socketPath, host.token, '/api/budgets/read', {
    scope: { bot: job.bot, runId: job.id, chatRevision: job.chatRevision ?? 0 },
  });
  children.push(reconnected.child);
  const read = await reconnected.response;
  assert.equal(read.status, 200, JSON.stringify(read));
  const view = read.value;
  assert.ok(isBudgetView(view));
  assert.equal(view.scope.budgetId, before.scope.budgetId);
  assert.equal(view.rootId, before.rootId);
  assert.equal(view.requests, 2);
  assert.equal(view.unknownCount, 1);
  assert.equal(view.reservedTokens, before.reservedTokens);
  assert.ok(view.reservedTokens > 0);
  assert.equal(view.reported.inputTokens, 10);
  assert.equal(view.reported.outputTokens, 2);
  assert.ok(view.receipts.every((receipt) => receipt.runId === job.id));
  assert.ok(view.receipts.every((receipt) => receipt.rootSessionId === session));
  assert.ok(view.receipts.every((receipt) => receipt.price?.id === price.id));
  await reconnected.close();
  assert.equal(sends, 2);
  assert.deepEqual(errors, []);
  const unauthorized = client(host.socketPath, 'synthetic-invalid-token', '/api/budgets/read', {
    scope: { bot: job.bot, runId: job.id, chatRevision: job.chatRevision ?? 0 },
  });
  children.push(unauthorized.child);
  assert.equal((await unauthorized.response).status, 403);
  await unauthorized.close();
  assert.equal(host.models.budgets.view(job.budget.budgetId).requests, 2);
  console.log(
    'Budget client exit acceptance',
    JSON.stringify({
      kernel,
      clientExit: accepted.child.exitCode,
      sameBudget: view.scope.budgetId === before.scope.budgetId,
      requestsBeforeExit: before.requests,
      requestsAfterExit: view.requests,
      unknown: view.unknownCount,
      priceUnchanged: true,
      toolCount: job.toolCount,
      modelPhase: job.phase,
      unauthorizedStatus: 403,
    }),
  );
});

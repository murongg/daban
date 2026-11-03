import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LocalComputerClient, localComputerPaths, startNativeAgent } from '@daban/engine/agent';
import { privateServer, secureDirectory } from '@daban/engine/local-computer';
import { expect, test } from 'vitest';
import { resolveSdk } from './sdk.js';

test('real DSH dispatches vision tools to the selected native bridge without a VM or a real provider', {
  timeout: 60000,
}, async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-native-loop-'));
  const root = path.join(temporary, 'private');
  await secureDirectory(root);
  const locations = localComputerPaths(root),
    key = 'a'.repeat(64);
  if (process.platform !== 'win32') await mkdir(path.dirname(locations.socket), { mode: 0o700 });
  await writeFile(locations.token, key, { mode: 0o600 });
  let local: Awaited<ReturnType<typeof privateServer>>['server'] | undefined;
  let model: import('node:http').Server | undefined;
  let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
  t.onTestFinished(async () => {
    await agent?.close();
    for (const server of [local, model]) {
      server?.closeAllConnections();
      if (server?.listening) await new Promise((resolve) => server.close(resolve));
    }
    if (process.platform !== 'win32')
      await rm(path.dirname(locations.socket), { recursive: true, force: true });
    await rm(temporary, { recursive: true, force: true });
  });
  const nativeCalls: string[] = [];
  let observation = 'mock-observation-0';
  const channel = await privateServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    let value: unknown = {};
    if (input.method === 'status')
      value = {
        platform: process.platform === 'win32' ? 'win32' : 'darwin',
        available: true,
        permissions: { screen: true, accessibility: true },
        shortcut: true,
        session: {
          id: 'mock-native-session',
          bot: 'mock-bot',
          revision: 1,
          owner: 'agent',
          model: 'provider:mock-provider:mock-vision',
          modelRevision: 1,
        },
      };
    if (input.method === 'screenshot' || input.method === 'act') {
      expect(input.bot).toBe('mock-bot');
      expect(input.session).toBe('mock-native-session');
      if (input.method === 'act') expect(input.observation).toBe(observation);
      nativeCalls.push(String(input.method));
      observation = `mock-observation-${nativeCalls.length}`;
      value = {
        session: 'mock-native-session',
        observation,
        bot: input.bot,
        runId: input.runId,
        width: 800,
        height: 600,
        image: 'data:image/jpeg;base64,AA==',
      };
    }
    res.end(JSON.stringify({ ok: true, value }));
  }, locations.certificate);
  local = channel.server;
  local.listen(locations.socket);
  await once(local, 'listening');
  await channel.publish();
  if (process.platform !== 'win32') await chmod(locations.socket, 0o600);
  let modelCalls = 0;
  model = createServer(async (req, res) => {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'mock-vision' }] }));
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      tools?: { function?: { name?: string } }[];
    };
    const kind = modelCalls++ === 0 ? 'screenshot' : modelCalls === 2 ? 'act' : undefined;
    const name = kind
      ? input.tools?.find((tool) => tool.function?.name?.endsWith(kind))?.function?.name
      : undefined;
    const message = name
      ? {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: `mock-call-${modelCalls}`,
              type: 'function',
              function: {
                name,
                arguments: JSON.stringify(
                  kind === 'screenshot'
                    ? { surface: 'desktop' }
                    : {
                        surface: 'desktop',
                        actions: [{ type: 'text', text: 'SYNTHETIC NATIVE INPUT' }],
                      },
                ),
              },
            },
          ],
        }
      : { role: 'assistant', content: 'SYNTHETIC NATIVE LOOP COMPLETE' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(
      `data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock-vision', choices: [{ index: 0, delta: message, finish_reason: null }] })}\n\n`,
    );
    res.write(
      `data: ${JSON.stringify({ id: 'mock-completion', object: 'chat.completion.chunk', created: 1, model: 'mock-vision', choices: [{ index: 0, delta: {}, finish_reason: name ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    );
    res.end();
  });
  model.listen(0, '127.0.0.1');
  await once(model, 'listening');
  const port = (model.address() as { port: number }).port;
  const socketPath =
    process.platform === 'win32'
      ? String.raw`\\.\pipe\daban-agent-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`
      : path.join(root, 'a.sock');
  agent = await startNativeAgent({
    dataRoot: root,
    socketPath,
    scope: createHash('sha256').update(root).digest('hex'),
    sdkFile: resolveSdk(),
    nativeWorkspace: path.join(root, 'workspace'),
    localComputer: new LocalComputerClient(root),
  });
  await agent.models.settings.configure({
    model: 'provider:mock-provider:mock-vision',
    revision: 0,
    requestId: 'mock-setup',
    apiKey: 'synthetic-model-key',
    connection: {
      id: 'mock-provider',
      name: 'Synthetic model',
      baseURL: `http://127.0.0.1:${port}/v1`,
      models: [
        {
          id: 'mock-vision',
          name: 'Synthetic vision',
          vision: true,
          contextWindow: 64000,
          maxTokens: 2048,
        },
      ],
    },
  });
  await agent.models.profiles.register({
    id: 'mock-bot',
    name: 'Synthetic native Bot',
    color: 'mint',
    instructions: '',
    memory: '',
  });
  await agent.models.start('mock-bot', {
    requestId: 'mock-native-request',
    prompt: 'Use the native screen and type SYNTHETIC NATIVE INPUT, then finish.',
    chatRevision: 0,
  });
  const until = Date.now() + 45000;
  while (agent.models.jobs.get('mock-bot')?.running && Date.now() < until)
    await new Promise((resolve) => setTimeout(resolve, 50));
  const job = agent.models.jobs.get('mock-bot')!;
  await job.done;
  expect(job.phase, job.error).toBe('completed');
  expect(nativeCalls).toStrictEqual(['screenshot', 'act']);
  expect(job.result).toMatch(/SYNTHETIC NATIVE LOOP COMPLETE/);
  const transcript = await agent.models.statistics({
    bot: job.bot,
    runId: job.id,
    chatRevision: 0,
  });
  expect(transcript.stats).toMatchObject({ turns: 1, steps: 3 });
  expect(transcript.stats!.llmMs).toBeGreaterThanOrEqual(0);
  expect(transcript.stats!.toolMs).toBeGreaterThanOrEqual(0);

  const log = await readFile(path.join(agent.models.dir, 'dsh-startup.log'), 'utf8');
  const records = log
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const ready = records.find(
    (record) => record.runId === job.id && record.stage === 'initialize-ready',
  );
  expect(ready?.snapshot?.stage).toBe('initialized');
  expect.assert(ready.snapshot.entry.includes('@deepseek-ai/dsh/'));
  expect.assert(Array.isArray(ready.snapshot.resources));
  expect(log.includes('synthetic-model-key')).toBe(false);
  expect(log.includes('SYNTHETIC NATIVE INPUT')).toBe(false);
  await expect(
    readFile(path.join(agent.models.dir, 'runs', job.id, 'mock-bot', 'dsh-startup.json')),
  ).rejects.toMatchObject({ code: 'ENOENT' });
});

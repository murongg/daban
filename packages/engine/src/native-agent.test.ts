import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type TestContext, test } from 'vitest';
import { startNativeAgent } from './host-server.js';
import { privateClientOptions } from './private-channel.js';

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-native-agent-'));
  const root = path.join(temporary, 'private');
  const socketPath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\daban-agent-${createHash('sha256').update(root).digest('hex').slice(0, 24)}`
      : path.join(root, 'a.sock');
  let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
  t.onTestFinished(async () => {
    await agent?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  agent = await startNativeAgent({
    dataRoot: root,
    nativeWorkspace: path.join(root, 'workspace'),
    socketPath,
    sdkFile: fileURLToPath(import.meta.url),
    scope: createHash('sha256').update(root).digest('hex'),
  });
  const token = (await readFile(path.join(root, 'model/control-token'), 'utf8')).trim();
  const tls = await privateClientOptions(path.join(root, 'model/control-certificate.pem'));
  function call(route: string, data?: object, auth = token) {
    return new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
      const send = process.platform === 'win32' ? httpsRequest : httpRequest;
      const request = send(
        {
          ...tls,
          socketPath,
          path: route,
          method: data === undefined ? 'GET' : 'POST',
          headers: {
            host: '127.0.0.1:8766',
            'x-prototype-token': auth,
            'content-type': 'application/json',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve({
                status: res.statusCode ?? 0,
                value: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.end(data === undefined ? undefined : JSON.stringify(data));
    });
  }
  return { agent, root, call };
}

test('native-only agent starts without a Linux executor or VM and reports its real capability boundary', async (t) => {
  const { call } = await fixture(t);
  const { status, value: raw } = await call('/api/state');
  expect(status).toBe(200);
  expect(raw.agent).toStrictEqual({
    location: 'host',
    execution: 'local-workspace',
    privilege: 'workspace',
    approvals: 'host',
  });
  expect(
    (raw.knowledge as { documentParsing?: boolean }).documentParsing,
    'document parser support must be reported separately from a working knowledge store',
  ).toBe(process.platform === 'linux');
});

test('native startup advertises an idle managed browser without launching it and closes the host request boundary', async (t) => {
  const { agent, call } = await fixture(t);
  const state = await call('/api/state');
  expect(state.value.hostBrowser).toEqual({ available: true, connections: [] });
  await agent.models.profiles.register({
    id: 'mock-browser-bot',
    name: 'Synthetic browser Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  expect(
    await call('/api/host-browser', {
      action: 'open',
      bot: 'mock-browser-bot',
      executablePath: '/mock/forged',
    }),
  ).toMatchObject({ status: 400, value: { error: 'INVALID_BROWSER_REQUEST' } });
  expect(
    await call('/api/host-browser', { action: 'open', bot: 'mock-browser-bot' }, 'mock-invalid'),
  ).toMatchObject({ status: 403, value: { error: 'UNAUTHORIZED' } });
  expect(
    await call('/api/host-browser', { action: 'open', bot: 'mock-unregistered' }),
  ).toMatchObject({ status: 404, value: { error: 'BOT_PROFILE_NOT_FOUND' } });
});

test('native knowledge remains readable without advertising an unavailable workspace export', async (t) => {
  const { agent, root } = await fixture(t);
  const tools = agent.models.tools;
  await agent.models.profiles.register({
    id: 'mock-a',
    name: 'Synthetic Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  const document = await agent.models.knowledge.write('mock-a', {
    path: 'synthetic.md',
    revision: 0,
    content: 'SYNTHETIC KNOWLEDGE',
  });
  const run: Parameters<typeof tools.invoke>[0] = {
    id: 'mock-native-run',
    bot: 'mock-a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: path.join(root, 'workspace'),
    canonicalRoot: await realpath(path.join(root, 'workspace')),
  };
  expect(tools.list('mock-a').map((tool) => tool.name)).not.toContain('bot_knowledge_export');
  expect(await tools.invoke(run, 'bot_knowledge_read', { id: document.id })).not.toHaveProperty(
    'isError',
    true,
  );
  const exported = await tools.invoke(run, 'bot_knowledge_export', {
    id: document.id,
    revision: 1,
    target: 'output.md',
  });
  expect(exported).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: 'KNOWLEDGE_EXPORT_UNAVAILABLE' }],
  });
  expect(await readdir(path.join(root, 'workspace'))).not.toContain('output.md');
  expect((await agent.models.knowledge.read('mock-a', document.id)).content).toBe(
    'SYNTHETIC KNOWLEDGE',
  );
});

test('VM-only Bot routes report an unavailable Linux capability in native mode and retain authentication', async (t) => {
  const { agent, call } = await fixture(t);
  await agent.models.profiles.register({
    id: 'mock-a',
    name: 'Synthetic Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  for (const action of ['frame', 'browser-frame', 'browser-state', 'browser-view']) {
    expect(await call(`/api/bots/mock-a/${action}`), action).toStrictEqual({
      status: 503,
      value: { error: 'LOCAL_VM_UNAVAILABLE' },
    });
  }
  for (const action of ['control', 'input', 'app', 'browser-command', 'browser-input']) {
    expect(await call(`/api/bots/mock-a/${action}`, {}), action).toStrictEqual({
      status: 503,
      value: { error: 'LOCAL_VM_UNAVAILABLE' },
    });
  }
  expect(
    await call('/api/bots/mock-a/browser-state', undefined, 'mock-invalid-token'),
  ).toStrictEqual({ status: 403, value: { error: 'UNAUTHORIZED' } });
});

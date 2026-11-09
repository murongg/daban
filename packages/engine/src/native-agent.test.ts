import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ExecutionSnapshot,
  executionCapabilities,
  skillPackageCapability,
} from '@daban/protocol';
import { expect, type TestContext, test } from 'vitest';
import { startNativeAgent } from './host-server.js';
import { privateClientOptions } from './private-channel.js';

const linuxSnapshot: ExecutionSnapshot = {
  role: 'executor',
  version: 1,
  boot: 'mock-linux-boot',
  nonce: 'mock-linux-nonce',
  capabilities: [...executionCapabilities, skillPackageCapability],
  computer: {
    mode: 'agent',
    sharedLogin: false,
    viewport: { width: 1280, height: 800 },
    environment: {
      platform: 'linux',
      arch: 'arm64',
      kernel: 'synthetic',
      node: 'synthetic',
      browser: '',
    },
    events: [],
    bots: {},
  },
  status: { available: true, revision: 0, limit: 2, items: [] },
};

async function fixture(
  t: TestContext,
  execution?: Parameters<typeof startNativeAgent>[0]['execution'],
) {
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
    ...(execution ? { execution } : {}),
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

test('native composition does not resolve the Linux ready promise or open a guest lease for ordinary files', async (t) => {
  const calls: string[] = [];
  const execution = {
    get ready(): Promise<import('@daban/protocol').ExecutionSnapshot> {
      throw new Error('SYNTHETIC_UNEXPECTED_VM_WAKE');
    },
    available: async () => true,
    refresh: async (): Promise<import('@daban/protocol').ExecutionSnapshot> => {
      throw new Error('SYNTHETIC_VM_STOPPED');
    },
    call: async (method: string) => {
      calls.push(method);
      throw new Error('SYNTHETIC_UNEXPECTED_VM_CALL');
    },
  };
  const { agent, call } = await fixture(t, execution);
  expect((await call('/api/state')).status).toBe(200);
  const task = await agent.models.tools.workspace.create(['mock-native-only']);
  await task.write('input.txt', 'SYNTHETIC LOCAL INPUT');
  const run = {
    id: 'mock-run',
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 5,
    seen: {},
    trace: [],
    workdir: task.path,
    canonicalRoot: task.canonical,
  };
  await task.close();
  await agent.models.tools.open(run);
  expect(
    await agent.models.tools.invoke(run, 'read_file', { path: 'input.txt' }),
  ).not.toHaveProperty('isError', true);
  await agent.models.tools.drain(run);
  expect(calls).toEqual([]);
});

test('the first Linux shell prepares only captured inputs and uses the existing approval and guest lease', async (t) => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let approved = 0;
  const execution = {
    get ready(): Promise<import('@daban/protocol').ExecutionSnapshot> {
      throw new Error('SYNTHETIC_UNEXPECTED_VM_WAKE');
    },
    available: async () => true,
    snapshot: linuxSnapshot,
    refresh: async () => linuxSnapshot,
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'workspace.base') return '/synthetic-linux/shared';
      if (method === 'workspace.create')
        return {
          root: '/synthetic-linux/shared',
          path: '/synthetic-linux/shared/mock-task',
          canonical: '/synthetic-linux/shared/mock-task',
          handleId: 'mock-handle',
        };
      if (method === 'tools.open')
        return {
          tools: [
            {
              name: 'shell',
              description: 'Synthetic Linux shell',
              inputSchema: { type: 'object' },
            },
          ],
        };
      if (method === 'tools.invoke') {
        expect(approved).toBe(1);
        return {
          phase: 'settled',
          result: { content: [{ type: 'text', text: 'SYNTHETIC LINUX RESULT' }] },
        };
      }
      return { ok: true };
    },
  };
  const { agent } = await fixture(t, execution);
  const tools = agent.models.tools;
  tools.executeRemote = async (run, name, args, wireId, dispatch) => {
    expect(run.workdir).toBe('/synthetic-linux/shared/mock-task');
    expect(name).toBe('shell');
    expect(args).toEqual({ command: 'cat input.csv' });
    expect(wireId).toBe('mock-wire');
    approved++;
    return dispatch();
  };
  const task = await tools.workspace.create(['mock-linux-inputs']);
  await task.write('input.csv', 'kind,total\nsynthetic,9\n');
  await task.write('unrelated.txt', 'SYNTHETIC UNRELATED FILE');
  const run = {
    id: 'mock-run',
    bot: 'mock-bot',
    inputs: ['input.csv'],
    sessionId: 'mock-session',
    abort: new AbortController(),
    toolCount: 0,
    limit: 5,
    seen: {},
    trace: [],
    workdir: task.path,
    canonicalRoot: task.canonical,
  };
  await task.close();
  await tools.open(run);
  expect(calls).toEqual([]);
  expect(tools.list(run.bot).map((tool) => tool.name)).toContain('shell');
  expect(
    await tools.invoke(run, 'shell', { command: 'cat input.csv' }, 'mock-wire'),
  ).not.toHaveProperty('isError', true);
  expect(
    calls.filter((call) => call.method === 'workspace.write').map((call) => call.params.name),
  ).toEqual(['input.csv']);
  expect(calls.filter((call) => call.method === 'tools.invoke')).toHaveLength(1);
  expect(run.toolCount).toBe(1);
  expect(run.workdir).toBe(task.path);
  await tools.drain(run);
  expect(calls.filter((call) => call.method === 'tools.drain')).toHaveLength(1);
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
  const permission = { action: 'autoStart', bot: 'mock-browser-bot' };
  expect(await call('/api/host-browser', permission)).toMatchObject({
    status: 200,
    value: { bot: permission.bot, enabled: false },
  });
  expect(
    await call('/api/host-browser', { ...permission, enabled: true }, 'mock-invalid'),
  ).toMatchObject({ status: 403, value: { error: 'UNAUTHORIZED' } });
  expect(await call('/api/host-browser', { ...permission, enabled: true })).toMatchObject({
    status: 200,
    value: { bot: permission.bot, enabled: true },
  });
  expect((await call('/api/state')).value.hostBrowser).toEqual(state.value.hostBrowser);
  expect(await call('/api/host-browser', { ...permission, enabled: false })).toMatchObject({
    status: 200,
    value: { bot: permission.bot, enabled: false },
  });
});

test('native knowledge exports into the owned task workspace without a Linux executor', async (t) => {
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
  expect(tools.list('mock-a').map((tool) => tool.name)).toContain('bot_knowledge_export');
  expect(await tools.invoke(run, 'bot_knowledge_read', { id: document.id })).not.toHaveProperty(
    'isError',
    true,
  );
  const exported = await tools.invoke(run, 'bot_knowledge_export', {
    id: document.id,
    revision: 1,
    target: 'output.md',
  });
  expect(exported.isError, JSON.stringify(exported)).not.toBe(true);
  expect(await readdir(path.join(root, 'workspace'))).toContain('output.md');
  expect(await readFile(path.join(root, 'workspace/output.md'), 'utf8')).toBe(
    'SYNTHETIC KNOWLEDGE',
  );
  expect((await agent.models.knowledge.read('mock-a', document.id)).content).toBe(
    'SYNTHETIC KNOWLEDGE',
  );
});

test('native file tools read and write owned inputs without exposing a host shell or unrelated paths', async (t) => {
  const { agent, root } = await fixture(t);
  const task = await agent.models.tools.workspace.create(['mock-task']);
  await task.write('input.csv', 'category,total\nmock,7\n');
  const run: Parameters<typeof agent.models.tools.invoke>[0] = {
    id: 'mock-files',
    bot: 'mock-bot',
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: task.path,
    canonicalRoot: task.canonical,
  };
  await task.close();
  const offered = agent.models.tools.list(run.bot).map((tool) => tool.name);
  expect(offered).toContain('read_file');
  expect(offered).toContain('write_file');
  expect(offered).not.toContain('shell');
  expect(
    await agent.models.tools.invoke(run, 'read_file', { path: 'input.csv' }),
  ).not.toHaveProperty('isError', true);
  expect(
    await agent.models.tools.invoke(run, 'write_file', {
      path: 'output.md',
      content: 'Synthetic result: 7',
    }),
  ).not.toHaveProperty('isError', true);
  expect(await readFile(path.join(task.path, 'output.md'), 'utf8')).toBe('Synthetic result: 7');
  expect(
    await agent.models.tools.invoke(run, 'read_file', {
      path: path.join(root, 'model/control-token'),
    }),
  ).toHaveProperty('isError', true);
  expect(
    await agent.models.tools.invoke(run, 'write_file', {
      path: '../escape.txt',
      content: 'synthetic',
    }),
  ).toHaveProperty('isError', true);
  expect(await agent.models.tools.invoke(run, 'shell', { command: 'synthetic' })).toHaveProperty(
    'isError',
    true,
  );
});

test('retained Linux output links keep their origin after native-first upgrade while file listing stays native', async (t) => {
  const calls: string[] = [];
  const output = 'model-runs/mock-old/mock-bot/report.txt';
  const execution = {
    get ready(): Promise<import('@daban/protocol').ExecutionSnapshot> {
      throw new Error('SYNTHETIC_UNEXPECTED_VM_WAKE');
    },
    available: async () => true,
    refresh: async (): Promise<import('@daban/protocol').ExecutionSnapshot> => {
      throw new Error('EXECUTOR_OFFLINE');
    },
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push(method);
      expect(method).toBe('workspace.read');
      expect(params.path).toBe(output);
      return {
        path: output,
        name: 'report.txt',
        size: 16,
        modified: '2026-01-01T00:00:00Z',
        content: 'SYNTHETIC OUTPUT',
      };
    },
  };
  const { agent, call } = await fixture(t, execution);
  await agent.models.journal.put({
    bot: 'mock-bot',
    runId: 'mock-old',
    prompt: 'Synthetic previous task',
    phase: 'completed',
    running: false,
    result: '',
    error: '',
    trace: [],
    outputDirectory: '/synthetic-linux/shared/model-runs/mock-old/mock-bot',
    files: [{ path: output, name: 'report.txt', size: 16, modified: '2026-01-01T00:00:00Z' }],
  });
  expect((await call('/api/files')).status).toBe(200);
  expect(calls).toEqual([]);
  expect(await call('/api/files/read', { path: output })).toMatchObject({
    status: 200,
    value: { content: 'SYNTHETIC OUTPUT' },
  });
  expect(calls).toEqual(['workspace.read']);
});

test('an explicitly requested Linux skill stays separate from an authorized native desktop', async (t) => {
  const execution = {
    get ready(): Promise<ExecutionSnapshot> {
      throw new Error('SYNTHETIC_UNEXPECTED_VM_WAKE');
    },
    available: async () => true,
    snapshot: linuxSnapshot,
    refresh: async () => linuxSnapshot,
    call: async (method: string, params: Record<string, unknown>) => {
      if (method === 'workspace.base') return '/synthetic-linux/shared';
      if (method === 'workspace.create')
        return {
          root: '/synthetic-linux/shared',
          path: '/synthetic-linux/shared/task',
          canonical: '/synthetic-linux/shared/task',
          handleId: 'mock-directory',
        };
      if (method === 'workspace.skill') return `${params.root}/.skills-mock`;
      return { ok: true };
    },
  };
  const { agent } = await fixture(t, execution);
  const tools = agent.models.tools;
  tools.localComputer = {
    list: [],
    selected: () => true,
    prepare: async () => true,
    invoke: async () => {
      throw new Error('SYNTHETIC_UNREQUESTED_DESKTOP_ACTION');
    },
    cancel: async () => {},
  };
  const skill = await agent.models.skills.import(
    '---\nname: mock-linux-skill\ndescription: Synthetic Linux skill\n---\nSynthetic instructions.',
  );
  await agent.models.skills.bind('mock-bot', {
    id: skill.id,
    revision: skill.revision,
    bindingRevision: 0,
    enabled: true,
  });
  const task = await tools.workspace.create(['mock-skill-task']);
  await task.close();
  const run = {
    id: 'mock-run',
    bot: 'mock-bot',
    skills: await agent.models.skills.capture('mock-bot'),
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: task.path,
    canonicalRoot: task.canonical,
  };
  await tools.open(run);
  expect(tools.localSelected(run.bot, run)).toBe(true);
  const result = await tools.invoke(run, 'skill_prepare', {
    skill: 'mock-linux-skill',
    target: 'linux',
  });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(JSON.parse((result.content[0] as { type: 'text'; text: string }).text)).toMatchObject({
    execution: 'linux-workspace',
    directory: '/synthetic-linux/shared/task/.skills-mock',
  });
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

import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, type TestContext, test } from 'vitest';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { LinuxTools } from './linux-tools.js';
import { NativeWorkspace } from './native-workspace.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-linux-tools-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const workspace = new NativeWorkspace(root);
  await workspace.prepare();
  const directory = await workspace.create(['mock-task']);
  await directory.write('input.csv', 'group,total\nmock,4\n');
  await directory.close();
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const files = new Map<string, Buffer>();
  let prepare: () => Promise<unknown> = async () => {};
  const execution = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === 'workspace.base') return '/synthetic-linux/shared';
      if (method === 'workspace.create') {
        await prepare();
        return {
          root: '/synthetic-linux/shared',
          path: '/synthetic-linux/shared/task',
          canonical: '/synthetic-linux/shared/task',
          handleId: 'mock-directory',
        };
      }
      if (method === 'workspace.write') {
        const name = String(params.name);
        if (files.has(name)) throw Object.assign(new Error('exists'), { code: 'EEXIST' });
        files.set(name, Buffer.from(String(params.data), 'base64'));
      }
      if (method === 'workspace.download') {
        const name = String(params.path),
          bytes = files.get(name)!;
        return {
          path: name,
          name,
          size: bytes.length,
          data: bytes.toString('base64'),
          sha256: createHash('sha256').update(bytes).digest('hex'),
          modified: '2026-01-01T00:00:00Z',
        };
      }
      if (method === 'tools.open')
        return { tools: [{ name: 'shell', description: 'synthetic', inputSchema: {} }] };
      if (method === 'tools.invoke')
        return { phase: 'settled', result: { content: [{ type: 'text', text: 'synthetic' }] } };
      return { ok: true };
    },
  };
  const tools = new AgentTools(undefined, workspace, { nativeOnly: true });
  tools.linux = new LinuxTools(execution, workspace, tools);
  tools.linux.enabled = true;
  tools.executeRemote = async (_run, _name, _args, _wire, dispatch) => dispatch();
  const run: AgentToolRun = {
    id: 'mock-run',
    bot: 'mock-bot',
    inputs: ['input.csv'],
    abort: new AbortController(),
    toolCount: 0,
    limit: 10,
    seen: {},
    trace: [],
    workdir: directory.path,
    canonicalRoot: directory.canonical,
  };
  return {
    tools,
    run,
    files,
    calls,
    gate: (value: () => Promise<unknown>) => {
      prepare = value;
    },
  };
}

test('Linux transfers preserve origins, verify downloaded bytes and never overwrite native outputs', async (t) => {
  const { tools, run, files, calls } = await fixture(t);
  expect(await tools.invoke(run, 'linux_upload', { path: '../outside.txt' })).toHaveProperty(
    'isError',
    true,
  );
  expect(calls).toEqual([]);
  await tools.invoke(run, 'write_file', { path: 'extra.txt', content: 'SYNTHETIC EXTRA' });
  expect(await tools.invoke(run, 'linux_upload', { path: 'extra.txt' })).not.toHaveProperty(
    'isError',
    true,
  );
  expect(files.get('input.csv')?.toString()).toContain('mock,4');
  expect(files.get('extra.txt')?.toString()).toBe('SYNTHETIC EXTRA');
  files.set('report.csv', Buffer.from('result\n9\n'));
  expect(await tools.invoke(run, 'linux_download', { path: 'report.csv' })).not.toHaveProperty(
    'isError',
    true,
  );
  const output = path.join(run.workdir, 'linux-outputs/report.csv');
  expect(await readFile(output, 'utf8')).toBe('result\n9\n');
  files.set('report.csv', Buffer.from('SYNTHETIC REPLACEMENT'));
  expect(await tools.invoke(run, 'linux_download', { path: 'report.csv' })).toHaveProperty(
    'isError',
    true,
  );
  expect(await readFile(output, 'utf8')).toBe('result\n9\n');
  expect(calls.some((call) => call.method === 'tools.invoke')).toBe(false);
});

test('cancellation during Linux preparation never opens a command lease or dispatches a command', async (t) => {
  const { tools, run, calls, gate } = await fixture(t);
  let release: () => unknown = () => {};
  const pending = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  gate(() => pending);
  const operation = tools.invoke(run, 'shell', { command: 'synthetic-command' }, 'mock-wire');
  while (!calls.some((call) => call.method === 'workspace.create'))
    await new Promise((resolve) => setImmediate(resolve));
  run.abort.abort();
  await tools.cancel(run);
  release();
  expect(await operation).toMatchObject({
    isError: true,
    content: [{ type: 'text', text: 'MODEL_CANCELLED' }],
  });
  await tools.drain(run);
  expect(calls.some((call) => ['tools.open', 'tools.invoke'].includes(call.method))).toBe(false);
});

test('an exhausted task and an unconnected screen cannot wake Linux', async (t) => {
  const { tools, run, calls } = await fixture(t);
  expect(await tools.invoke(run, 'screenshot', { surface: 'desktop' })).toHaveProperty(
    'isError',
    true,
  );
  run.toolCount = run.limit;
  expect(
    await tools.invoke(run, 'shell', { command: 'synthetic-command' }, 'mock-wire'),
  ).toMatchObject({ isError: true, content: [{ type: 'text', text: 'TOOL_LIMIT' }] });
  expect(calls).toEqual([]);
});

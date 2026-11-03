import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, type TestContext, test, vi } from 'vitest';
import { ProcessManager } from './processes.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-execution-process-'));
  const manager = new ProcessManager({ directory: path.join(root, 'receipts'), boot: 'mock-boot' });
  await manager.ready;
  t.onTestFinished(async () => {
    await manager.close();
    await rm(root, { recursive: true, force: true });
  });
  return { root, manager };
}

async function settled(manager: ProcessManager, id: string) {
  for (let count = 0; count < 100; count++) {
    const state = await manager.poll(id);
    if (state.phase !== 'running' && state.phase !== 'starting') return state;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic process did not finish');
}

test('guest shell preserves exact receipts, accepts input once, and never inherits host secrets', async (t) => {
  const { root, manager } = await fixture(t);
  const command =
    'read -r value; if [ -z "$SYNTHETIC_HOST_SECRET" ]; then printf "%s:unset" "$value"; fi; printf x >> marker';
  const before = process.env.SYNTHETIC_HOST_SECRET;
  process.env.SYNTHETIC_HOST_SECRET = 'SYNTHETIC-PRIVATE';
  t.onTestFinished(() => {
    if (before === undefined) delete process.env.SYNTHETIC_HOST_SECRET;
    else process.env.SYNTHETIC_HOST_SECRET = before;
  });
  const request = { id: 'mock-input', command, cwd: root };
  await manager.start(request);
  await manager.start(request);
  await manager.start({ command, cwd: root, id: request.id });
  await expect(manager.start({ ...request, command: 'printf duplicate' })).rejects.toMatchObject({
    code: 'PROCESS_REQUEST_CONFLICT',
  });
  await manager.input({ id: request.id, requestId: 'mock-write', data: 'SYNTHETIC\n' });
  await manager.input({ id: request.id, requestId: 'mock-write', data: 'SYNTHETIC\n' });
  await expect(
    manager.input({ id: request.id, requestId: 'mock-write', data: 'different\n' }),
  ).rejects.toMatchObject({ code: 'PROCESS_REQUEST_CONFLICT' });
  const state = await settled(manager, request.id);
  expect(state.stdout).toBe('SYNTHETIC:unset');
  expect(state.exitCode).toBe(0);
  expect(await readFile(path.join(root, 'marker'), 'utf8')).toBe('x');
  expect(await manager.start(request)).toStrictEqual(state);
});

test('process output is bounded and cancellation terminates its process group', async (t) => {
  const { root, manager } = await fixture(t);
  await manager.start({
    id: 'mock-output',
    command: 'while :; do printf 0123456789; done',
    cwd: root,
  });
  const state = await settled(manager, 'mock-output');
  expect(state.phase).toBe('failed');
  expect(state.error).toBe('PROCESS_OUTPUT_LIMIT');
  expect.assert(Buffer.byteLength(state.stdout) + Buffer.byteLength(state.stderr) <= 65536);
  await manager.start({ id: 'mock-group', command: 'sleep 30 & wait', cwd: root });
  const cancelled = await manager.cancel({ id: 'mock-group', requestId: 'mock-cancel' });
  expect(cancelled.phase).toBe('cancelled');
  expect(await manager.cancel({ id: 'mock-group', requestId: 'mock-cancel' })).toStrictEqual(
    cancelled,
  );
});

test('a new service instance reports an old running receipt unknown and does not rerun it', async (t) => {
  const { root, manager } = await fixture(t);
  const request = { id: 'mock-restart', command: 'printf x >> marker; sleep 30', cwd: root };
  await manager.start(request);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const restarted = new ProcessManager({
    directory: path.join(root, 'receipts'),
    boot: 'mock-new-boot',
  });
  await restarted.ready;
  t.onTestFinished(async () => {
    await restarted.close();
  });
  expect((await restarted.start(request)).phase).toBe('unknown');
  expect(await readFile(path.join(root, 'marker'), 'utf8')).toBe('x');
});

test('binary command output cannot expand past the UTF-8 response byte limit', async (t) => {
  const { root, manager } = await fixture(t);
  await manager.start({
    id: 'mock-binary',
    command: "while :; do printf '\\377'; done",
    cwd: root,
  });
  const state = await settled(manager, 'mock-binary');
  expect(state.error).toBe('PROCESS_OUTPUT_LIMIT');
  expect.assert(Buffer.byteLength(state.stdout) + Buffer.byteLength(state.stderr) <= 65536);
});

test('shutdown cancels a process whose valid external id already uses the full length', async (t) => {
  const { root, manager } = await fixture(t);
  const id = `mock-${'x'.repeat(75)}`;
  await manager.start({ id, command: 'sleep 0.3', cwd: root });
  await manager.close();
  expect((await manager.poll(id)).phase).toBe('cancelled');
});

test('concurrent process admission counts durable claims that have not spawned yet', async (t) => {
  const { root, manager } = await fixture(t);
  const results = await Promise.allSettled(
    Array.from({ length: 17 }, (_value, index) =>
      manager.start({ id: `mock-capacity-${index}`, command: 'sleep 0.5', cwd: root }),
    ),
  );
  expect(results.filter((result) => result.status === 'fulfilled').length).toBe(16);
  const rejection = results.find((result) => result.status === 'rejected');
  expect.assert(rejection?.status === 'rejected' && rejection.reason.code === 'PROCESS_CAPACITY');
});

test('UTF-8 command output preserves a character split across pipe reads', async (t) => {
  const { root, manager } = await fixture(t);
  await manager.start({
    id: 'mock-unicode',
    command: 'printf "\\344"; sleep 0.03; printf "\\270\\255"',
    cwd: root,
  });
  expect((await settled(manager, 'mock-unicode')).stdout).toBe('中');
});

test('more than256 terminal receipts stay queryable and cannot replay while new commands remain available', async (t) => {
  const { root } = await fixture(t);
  const directory = path.join(root, 'receipts');
  const request = { command: 'printf REPLAY >> must-not-exist', cwd: root, id: 'mock-history-0' };
  await Promise.all(
    Array.from({ length: 300 }, (_value, index) => {
      const id = `mock-history-${index}`;
      const digest = createHash('sha256')
        .update(JSON.stringify({ command: request.command, cwd: root, id }))
        .digest('hex');
      return writeFile(
        path.join(directory, `${id}.json`),
        JSON.stringify({
          version: 1,
          digest,
          snapshot: {
            id,
            boot: 'mock-previous',
            phase: 'exited',
            stdout: 'SYNTHETIC-OLD-RESULT',
            stderr: '',
            exitCode: 0,
          },
          mutations: [],
        }),
        { mode: 0o600 },
      );
    }),
  );
  const history = new ProcessManager({ directory, boot: 'mock-current' });
  await history.ready;
  t.onTestFinished(async () => {
    await history.close();
  });
  expect((await history.start(request)).stdout).toBe('SYNTHETIC-OLD-RESULT');
  await history.start({ id: 'mock-after-history', command: 'printf SYNTHETIC-NEW', cwd: root });
  expect((await settled(history, 'mock-after-history')).stdout).toBe('SYNTHETIC-NEW');
  const restarted = new ProcessManager({ directory, boot: 'mock-next' });
  await restarted.ready;
  t.onTestFinished(async () => {
    await restarted.close();
  });
  expect((await restarted.start(request)).stdout).toBe('SYNTHETIC-OLD-RESULT');
  await expect(readFile(path.join(root, 'must-not-exist'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
});

test('a save failure after spawn reports queryable uncertainty without replaying the command', async (t) => {
  const { root, manager } = await fixture(t);
  const target = manager as unknown as { persist: (receipt: unknown) => Promise<unknown> };
  const persist = target.persist.bind(manager);
  let writes = 0;
  vi.spyOn(target, 'persist').mockImplementation(async (receipt: unknown) => {
    if (++writes < 2) return persist(receipt);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await readFile(path.join(root, 'effect'), 'utf8').then(
          (value) => value === 'x',
          () => false,
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    throw Object.assign(new Error('SYNTHETIC-SAVE-FAILURE'), { code: 'ENOSPC' });
  });
  const request = { id: 'mock-save-failure', command: 'printf x >> effect', cwd: root };
  const result = await manager.start(request);
  expect(result.phase).toBe('unknown');
  expect(result.error).toBe('PROCESS_OUTCOME_UNKNOWN');
  expect((await manager.poll(request.id)).phase).toBe('unknown');
  expect(await readFile(path.join(root, 'effect'), 'utf8')).toBe('x');
  const restarted = new ProcessManager({
    directory: path.join(root, 'receipts'),
    boot: 'mock-after-save-failure',
  });
  await restarted.ready;
  t.onTestFinished(async () => {
    await restarted.close();
  });
  expect((await restarted.start(request)).phase).toBe('unknown');
  expect(await readFile(path.join(root, 'effect'), 'utf8')).toBe('x');
});

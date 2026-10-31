import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ProcessManager } from './processes.js';

async function fixture(t: { after: (action: () => unknown) => unknown }) {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-execution-process-'));
  const manager = new ProcessManager({ directory: path.join(root, 'receipts'), boot: 'mock-boot' });
  await manager.ready;
  t.after(async () => {
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
  t.after(() => {
    if (before === undefined) delete process.env.SYNTHETIC_HOST_SECRET;
    else process.env.SYNTHETIC_HOST_SECRET = before;
  });
  const request = { id: 'mock-input', command, cwd: root };
  await manager.start(request);
  await manager.start(request);
  await manager.start({ command, cwd: root, id: request.id });
  await assert.rejects(manager.start({ ...request, command: 'printf duplicate' }), {
    code: 'PROCESS_REQUEST_CONFLICT',
  });
  await manager.input({ id: request.id, requestId: 'mock-write', data: 'SYNTHETIC\n' });
  await manager.input({ id: request.id, requestId: 'mock-write', data: 'SYNTHETIC\n' });
  await assert.rejects(
    manager.input({ id: request.id, requestId: 'mock-write', data: 'different\n' }),
    { code: 'PROCESS_REQUEST_CONFLICT' },
  );
  const state = await settled(manager, request.id);
  assert.equal(state.stdout, 'SYNTHETIC:unset');
  assert.equal(state.exitCode, 0);
  assert.equal(await readFile(path.join(root, 'marker'), 'utf8'), 'x');
  assert.deepEqual(await manager.start(request), state);
});

test('process output is bounded and cancellation terminates its process group', async (t) => {
  const { root, manager } = await fixture(t);
  await manager.start({
    id: 'mock-output',
    command: 'while :; do printf 0123456789; done',
    cwd: root,
  });
  const state = await settled(manager, 'mock-output');
  assert.equal(state.phase, 'failed');
  assert.equal(state.error, 'PROCESS_OUTPUT_LIMIT');
  assert.ok(Buffer.byteLength(state.stdout) + Buffer.byteLength(state.stderr) <= 65536);
  await manager.start({ id: 'mock-group', command: 'sleep 30 & wait', cwd: root });
  const cancelled = await manager.cancel({ id: 'mock-group', requestId: 'mock-cancel' });
  assert.equal(cancelled.phase, 'cancelled');
  assert.deepEqual(await manager.cancel({ id: 'mock-group', requestId: 'mock-cancel' }), cancelled);
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
  t.after(() => restarted.close());
  assert.equal((await restarted.start(request)).phase, 'unknown');
  assert.equal(await readFile(path.join(root, 'marker'), 'utf8'), 'x');
});

test('binary command output cannot expand past the UTF-8 response byte limit', async (t) => {
  const { root, manager } = await fixture(t);
  await manager.start({
    id: 'mock-binary',
    command: "while :; do printf '\\377'; done",
    cwd: root,
  });
  const state = await settled(manager, 'mock-binary');
  assert.equal(state.error, 'PROCESS_OUTPUT_LIMIT');
  assert.ok(Buffer.byteLength(state.stdout) + Buffer.byteLength(state.stderr) <= 65536);
});

test('shutdown cancels a process whose valid external id already uses the full length', async (t) => {
  const { root, manager } = await fixture(t);
  const id = `mock-${'x'.repeat(75)}`;
  await manager.start({ id, command: 'sleep 0.3', cwd: root });
  await manager.close();
  assert.equal((await manager.poll(id)).phase, 'cancelled');
});

test('concurrent process admission counts durable claims that have not spawned yet', async (t) => {
  const { root, manager } = await fixture(t);
  const results = await Promise.allSettled(
    Array.from({ length: 17 }, (_value, index) =>
      manager.start({ id: `mock-capacity-${index}`, command: 'sleep 0.5', cwd: root }),
    ),
  );
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 16);
  const rejection = results.find((result) => result.status === 'rejected');
  assert.ok(rejection?.status === 'rejected' && rejection.reason.code === 'PROCESS_CAPACITY');
});

test('UTF-8 command output preserves a character split across pipe reads', async (t) => {
  const { root, manager } = await fixture(t);
  await manager.start({
    id: 'mock-unicode',
    command: 'printf "\\344"; sleep 0.03; printf "\\270\\255"',
    cwd: root,
  });
  assert.equal((await settled(manager, 'mock-unicode')).stdout, '中');
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
  t.after(() => history.close());
  assert.equal((await history.start(request)).stdout, 'SYNTHETIC-OLD-RESULT');
  await history.start({ id: 'mock-after-history', command: 'printf SYNTHETIC-NEW', cwd: root });
  assert.equal((await settled(history, 'mock-after-history')).stdout, 'SYNTHETIC-NEW');
  const restarted = new ProcessManager({ directory, boot: 'mock-next' });
  await restarted.ready;
  t.after(() => restarted.close());
  assert.equal((await restarted.start(request)).stdout, 'SYNTHETIC-OLD-RESULT');
  await assert.rejects(readFile(path.join(root, 'must-not-exist')), { code: 'ENOENT' });
});

test('a save failure after spawn reports queryable uncertainty without replaying the command', async (t) => {
  const { root, manager } = await fixture(t);
  const target = manager as unknown as { persist: (receipt: unknown) => Promise<unknown> };
  const persist = target.persist.bind(manager);
  let writes = 0;
  t.mock.method(target, 'persist', async (receipt: unknown) => {
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
  assert.equal(result.phase, 'unknown');
  assert.equal(result.error, 'PROCESS_OUTCOME_UNKNOWN');
  assert.equal((await manager.poll(request.id)).phase, 'unknown');
  assert.equal(await readFile(path.join(root, 'effect'), 'utf8'), 'x');
  const restarted = new ProcessManager({
    directory: path.join(root, 'receipts'),
    boot: 'mock-after-save-failure',
  });
  await restarted.ready;
  t.after(() => restarted.close());
  assert.equal((await restarted.start(request)).phase, 'unknown');
  assert.equal(await readFile(path.join(root, 'effect'), 'utf8'), 'x');
});

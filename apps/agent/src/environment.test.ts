import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { writeSetupRecord } from './bootstrap.js';
import { Environment } from './environment.js';

const vm = {
  limactl: '/synthetic/tools/limactl',
  limaHome: '/synthetic/lima',
  vm: 'execution',
  port: 19876,
};
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-optional-environment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'private'),
    vmConfigFile = path.join(root, 'runtime.json');
  await mkdir(dataRoot, { mode: 0o700 });
  return { root, dataRoot, vmConfigFile };
}
test('ordinary Agent startup never provisions Linux and an explicit request runs only once', async (t) => {
  const f = await fixture(t);
  let calls = 0,
    release: () => unknown = () => {};
  const pending = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const options = {
    ...f,
    prepare: async () => {
      calls++;
      await pending;
      await writeSetupRecord(f.vmConfigFile, vm);
    },
  };
  const owner = new Environment(options);
  await owner.resumePending();
  assert.equal(calls, 0);
  assert.deepEqual(await owner.status(), { required: true, target: 'linux', phase: 'available' });
  await owner.start();
  await owner.start();
  assert.equal(calls, 1);
  assert.equal(owner.busy, true);
  release();
  await owner.settled;
  assert.deepEqual(await owner.status(), { required: false, target: 'linux', phase: 'complete' });
  assert.equal(owner.busy, false);
  const reopened = new Environment(options);
  await reopened.resumePending();
  assert.equal(calls, 1);
  await reopened.close();
  await owner.close();
});
test('restoring progress alone never grants installation permission; interrupted authorized work can resume', async (t) => {
  const f = await fixture(t);
  await writeSetupRecord(path.join(f.dataRoot, 'progress.json'), {
    required: true,
    phase: 'downloading',
    downloaded: 5,
    total: 100,
  });
  let calls = 0;
  const options = {
    ...f,
    prepare: async () => {
      calls++;
      await writeSetupRecord(f.vmConfigFile, vm);
    },
  };
  const observer = new Environment(options);
  await observer.resumePending();
  assert.equal(calls, 0);
  await observer.close();
  await writeSetupRecord(path.join(f.dataRoot, 'environment-request.json'), { requested: true });
  const restarted = new Environment(options);
  await restarted.resumePending();
  await restarted.settled;
  assert.equal(calls, 1);
  assert.equal((await restarted.status()).required, false);
  await restarted.close();
});
test('pause retains user work and requires an explicit continuation across restart', async (t) => {
  const f = await fixture(t);
  const userFile = path.join(f.dataRoot, 'synthetic-user-work.txt');
  await writeFile(userFile, 'SYNTHETIC USER WORK');
  let calls = 0;
  const options = {
    ...f,
    prepare: async (signal: AbortSignal) => {
      calls++;
      if (calls === 1)
        await new Promise<unknown>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
        );
      else await writeSetupRecord(f.vmConfigFile, vm);
    },
  };
  const first = new Environment(options);
  await first.start();
  await first.cancel();
  await first.settled;
  assert.equal((await first.status()).phase, 'cancelled');
  assert.equal(await readFile(userFile, 'utf8'), 'SYNTHETIC USER WORK');
  await first.close();
  const reopened = new Environment(options);
  await reopened.resumePending();
  assert.equal(calls, 1);
  await reopened.start();
  await reopened.settled;
  assert.equal(calls, 2);
  assert.equal((await reopened.status()).phase, 'complete');
  await reopened.close();
});

test('a pause arriving during start is ordered after that start and survives restart', async (t) => {
  const f = await fixture(t);
  const owner = new Environment({
    ...f,
    prepare: async (signal) => {
      await new Promise<unknown>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
  });
  try {
    await Promise.all([owner.start(), owner.cancel()]);
    assert.ok(
      ['cancelling', 'cancelled'].includes((await owner.status()).phase),
      'a newer pause must survive start',
    );
    await owner.settled;
    assert.equal((await owner.status()).phase, 'cancelled');
  } finally {
    await owner.close();
  }
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, type TestContext, test } from 'vitest';
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
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
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
  expect(calls).toBe(0);
  expect(await owner.status()).toStrictEqual({
    required: true,
    target: 'linux',
    phase: 'available',
  });
  await owner.start();
  await owner.start();
  expect(calls).toBe(1);
  expect(owner.busy).toBe(true);
  release();
  await owner.settled;
  expect(await owner.status()).toStrictEqual({
    required: false,
    target: 'linux',
    phase: 'complete',
  });
  expect(owner.busy).toBe(false);
  const reopened = new Environment(options);
  await reopened.resumePending();
  expect(calls).toBe(1);
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
  expect(calls).toBe(0);
  await observer.close();
  await writeSetupRecord(path.join(f.dataRoot, 'environment-request.json'), { requested: true });
  const restarted = new Environment(options);
  await restarted.resumePending();
  await restarted.settled;
  expect(calls).toBe(1);
  expect((await restarted.status()).required).toBe(false);
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
  expect((await first.status()).phase).toBe('cancelled');
  expect(await readFile(userFile, 'utf8')).toBe('SYNTHETIC USER WORK');
  await first.close();
  const reopened = new Environment(options);
  await reopened.resumePending();
  expect(calls).toBe(1);
  await reopened.start();
  await reopened.settled;
  expect(calls).toBe(2);
  expect((await reopened.status()).phase).toBe('complete');
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
    expect.assert(
      ['cancelling', 'cancelled'].includes((await owner.status()).phase),
      'a newer pause must survive start',
    );
    await owner.settled;
    expect((await owner.status()).phase).toBe('cancelled');
  } finally {
    await owner.close();
  }
});

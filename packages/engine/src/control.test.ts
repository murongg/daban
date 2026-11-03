import { expect, test } from 'vitest';
import { Control } from './control.js';

type DynamicControl = Control & {
  register(id: string): unknown;
  activate(id: string): { epoch: number; owner: string };
  revoke(id: string): Promise<unknown>;
};

test('a logical computer lease stays monotonic across explicit attach and detach', async () => {
  let now = 0;
  const control = new Control([], () => now) as DynamicControl;
  control.register('mock-dynamic');
  await expect(
    control.execute('mock-dynamic', 'agent', 0, () => expect.unreachable()),
  ).rejects.toMatchObject({ code: 'COMPUTER_NOT_CONNECTED' });
  now = 500;
  const first = control.activate('mock-dynamic');
  now = 530;
  expect(control.activeMilliseconds('mock-dynamic')).toBe(30);
  await control.revoke('mock-dynamic');
  now = 900;
  expect(control.activeMilliseconds('mock-dynamic')).toBe(30);
  control.register('mock-dynamic');
  const next = control.activate('mock-dynamic');
  expect.assert(next.epoch > first.epoch);
  await expect(
    control.execute('mock-dynamic', 'agent', first.epoch, () => expect.unreachable()),
  ).rejects.toMatchObject({ code: 'STALE_CONTROL' });
  expect(await control.execute('mock-dynamic', 'agent', next.epoch, () => 'SYNTHETIC-47')).toBe(
    'SYNTHETIC-47',
  );
});

test('revoking one computer fences queued effects before drain without blocking another Bot', async () => {
  const control = new Control(['mock-a', 'mock-b']) as DynamicControl;
  let release!: () => unknown, entered!: () => unknown;
  const started = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const current = control.execute('mock-a', 'agent', 0, () => {
    entered();
    return gate;
  });
  await started;
  const rejected = expect(
    control.execute('mock-a', 'agent', 0, () => expect.unreachable('retired input ran')),
  ).rejects.toMatchObject({ code: 'COMPUTER_NOT_CONNECTED' });
  const revoking = control.revoke('mock-a');
  expect(await control.execute('mock-b', 'agent', 0, () => 'OTHER-BOT')).toBe('OTHER-BOT');
  release();
  await current;
  await rejected;
  await revoking;
});

test('handoff drains in-flight work, rejects queued work, and does not block the other Bot', async () => {
  const control = new Control(['a', 'b']);
  let finish!: () => unknown;
  let started!: () => unknown;
  const ready = new Promise<unknown>((resolve) => {
    started = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    finish = () => resolve(undefined);
  });
  const first = control.execute('a', 'agent', 0, async () => {
    started();
    await gate;
    return 'finished';
  });
  await ready;
  const queued = control.execute('a', 'agent', 0, () =>
    expect.unreachable('stale queued action ran'),
  );
  const rejected = expect(queued).rejects.toMatchObject({ code: 'STALE_CONTROL' });
  const transfer = control.transfer('a', 0, 'human');
  expect(control.state('a').owner).toBe('handoff');
  expect(await control.execute('b', 'agent', 0, () => 'b progressed')).toBe('b progressed');
  finish();
  expect(await first).toBe('finished');
  await rejected;
  expect(await transfer).toStrictEqual({ owner: 'human', epoch: 1 });
  expect(await control.execute('a', 'human', 1, () => 'manual')).toBe('manual');
});

test('returning a Bot rejects late human packets and resumes only its Agent', async () => {
  const control = new Control(['a', 'b']);
  await control.transfer('a', 0, 'human');
  expect(await control.transfer('a', 1, 'agent')).toStrictEqual({ owner: 'agent', epoch: 2 });
  await expect(control.execute('a', 'human', 1, () => expect.unreachable())).rejects.toMatchObject({
    code: 'STALE_CONTROL',
  });
  await expect(control.transfer('a', 1, 'human')).rejects.toMatchObject({ code: 'STALE_CONTROL' });
  expect(await control.execute('a', 'agent', 2, () => 42)).toBe(42);
  expect(control.state('b')).toStrictEqual({ owner: 'agent', epoch: 0 });
});

test('unknown Bots and same-owner transfers cannot create implicit access', async () => {
  const control = new Control(['a']);
  await expect(control.execute('other', 'agent', 0, () => 1)).rejects.toMatchObject({
    code: 'UNKNOWN_BOT',
  });
  await expect(control.transfer('a', 0, 'agent')).rejects.toMatchObject({ code: 'STALE_CONTROL' });
});

test('handoff settles native held input before granting the new owner', async () => {
  const control = new Control(['a']);
  let release!: () => unknown;
  let started = false;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const pending = control.transfer('a', 0, 'human', async () => {
    started = true;
    await gate;
  });
  await new Promise(setImmediate);
  expect(started, 'native cleanup must run').toBe(true);
  expect(control.state('a').owner).toBe('handoff');
  await expect(control.execute('a', 'human', 1, () => expect.unreachable())).rejects.toMatchObject({
    code: 'STALE_CONTROL',
  });
  release();
  expect(await pending).toStrictEqual({ owner: 'human', epoch: 1 });
});

test('failed native cleanup keeps the previous owner under a new epoch', async () => {
  const control = new Control(['a']);
  await expect(
    control.transfer('a', 0, 'human', async () => {
      throw new Error('synthetic display failure');
    }),
  ).rejects.toThrowError(/synthetic display failure/);
  expect(control.state('a')).toStrictEqual({ owner: 'agent', epoch: 1 });
});

test('execution time excludes human ownership and handoff independently for each Bot', async () => {
  let now = 0;
  const control = new Control(['a', 'b'], () => now);
  now = 60000;
  await control.transfer('a', 0, 'human');
  now += 30 * 60 * 1000;
  expect(control.activeMilliseconds('a')).toBe(60000);
  expect(control.activeMilliseconds('b')).toBe(31 * 60 * 1000);
  await control.transfer('a', 1, 'agent');
  now += 240000;
  expect(control.activeMilliseconds('a')).toBe(300000);
});

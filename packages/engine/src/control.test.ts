import assert from 'node:assert/strict';
import test from 'node:test';
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
  await assert.rejects(
    control.execute('mock-dynamic', 'agent', 0, () => assert.fail()),
    { code: 'COMPUTER_NOT_CONNECTED' },
  );
  now = 500;
  const first = control.activate('mock-dynamic');
  now = 530;
  assert.equal(control.activeMilliseconds('mock-dynamic'), 30);
  await control.revoke('mock-dynamic');
  now = 900;
  assert.equal(control.activeMilliseconds('mock-dynamic'), 30);
  control.register('mock-dynamic');
  const next = control.activate('mock-dynamic');
  assert.ok(next.epoch > first.epoch);
  await assert.rejects(
    control.execute('mock-dynamic', 'agent', first.epoch, () => assert.fail()),
    { code: 'STALE_CONTROL' },
  );
  assert.equal(
    await control.execute('mock-dynamic', 'agent', next.epoch, () => 'SYNTHETIC-47'),
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
  const rejected = assert.rejects(
    control.execute('mock-a', 'agent', 0, () => assert.fail('retired input ran')),
    { code: 'COMPUTER_NOT_CONNECTED' },
  );
  const revoking = control.revoke('mock-a');
  assert.equal(await control.execute('mock-b', 'agent', 0, () => 'OTHER-BOT'), 'OTHER-BOT');
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
  const queued = control.execute('a', 'agent', 0, () => assert.fail('stale queued action ran'));
  const rejected = assert.rejects(queued, { code: 'STALE_CONTROL' });
  const transfer = control.transfer('a', 0, 'human');
  assert.equal(control.state('a').owner, 'handoff');
  assert.equal(await control.execute('b', 'agent', 0, () => 'b progressed'), 'b progressed');
  finish();
  assert.equal(await first, 'finished');
  await rejected;
  assert.deepEqual(await transfer, { owner: 'human', epoch: 1 });
  assert.equal(await control.execute('a', 'human', 1, () => 'manual'), 'manual');
});

test('returning a Bot rejects late human packets and resumes only its Agent', async () => {
  const control = new Control(['a', 'b']);
  await control.transfer('a', 0, 'human');
  assert.deepEqual(await control.transfer('a', 1, 'agent'), { owner: 'agent', epoch: 2 });
  await assert.rejects(
    control.execute('a', 'human', 1, () => assert.fail()),
    { code: 'STALE_CONTROL' },
  );
  await assert.rejects(control.transfer('a', 1, 'human'), { code: 'STALE_CONTROL' });
  assert.equal(await control.execute('a', 'agent', 2, () => 42), 42);
  assert.deepEqual(control.state('b'), { owner: 'agent', epoch: 0 });
});

test('unknown Bots and same-owner transfers cannot create implicit access', async () => {
  const control = new Control(['a']);
  await assert.rejects(
    control.execute('other', 'agent', 0, () => 1),
    { code: 'UNKNOWN_BOT' },
  );
  await assert.rejects(control.transfer('a', 0, 'agent'), { code: 'STALE_CONTROL' });
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
  assert.equal(started, true, 'native cleanup must run');
  assert.equal(control.state('a').owner, 'handoff');
  await assert.rejects(
    control.execute('a', 'human', 1, () => assert.fail()),
    { code: 'STALE_CONTROL' },
  );
  release();
  assert.deepEqual(await pending, { owner: 'human', epoch: 1 });
});

test('failed native cleanup keeps the previous owner under a new epoch', async () => {
  const control = new Control(['a']);
  await assert.rejects(
    control.transfer('a', 0, 'human', async () => {
      throw new Error('synthetic display failure');
    }),
    /synthetic display failure/,
  );
  assert.deepEqual(control.state('a'), { owner: 'agent', epoch: 1 });
});

test('execution time excludes human ownership and handoff independently for each Bot', async () => {
  let now = 0;
  const control = new Control(['a', 'b'], () => now);
  now = 60000;
  await control.transfer('a', 0, 'human');
  now += 30 * 60 * 1000;
  assert.equal(control.activeMilliseconds('a'), 60000);
  assert.equal(control.activeMilliseconds('b'), 31 * 60 * 1000);
  await control.transfer('a', 1, 'agent');
  now += 240000;
  assert.equal(control.activeMilliseconds('a'), 300000);
});

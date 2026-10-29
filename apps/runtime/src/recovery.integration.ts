import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isRecoveryReceipt, isRecoveryReview } from '@daban/protocol';
import { startPrototype } from './server.js';

test('runtime scope identity remains valid when random entropy begins with URL punctuation', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-recovery-identity-'));
  const random = t.mock.method(crypto, 'randomBytes', (size: number) => Buffer.alloc(size, 255));
  syncBuiltinESMExports();
  let app: Awaited<ReturnType<typeof startPrototype>> | undefined;
  try {
    app = await startPrototype({
      profileDir: path.join(root, 'profile'),
      port: 0,
      computers: true,
    });
    const response = await fetch(app.url + '/api/recovery/review', {
      headers: { 'x-prototype-token': app.token },
    });
    assert.equal(response.status, 200);
    assert.ok(isRecoveryReview(await response.json()));
  } finally {
    random.mock.restore();
    syncBuiltinESMExports();
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('claim drains an already-claimed but unissued group stage before authorizing a host stop', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-recovery-draining-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  let release: () => unknown = () => undefined,
    entered: () => unknown = () => undefined,
    claimEntered: () => unknown = () => undefined;
  const waiting = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  const started = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  const draining = new Promise((resolve) => {
    claimEntered = () => resolve(undefined);
  });
  const call = async (route: string, data?: unknown) => {
    const response = await fetch(app.url + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'x-prototype-token': app.token,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.ok(app.models && app.groups && app.recovery);
    for (const id of ['mock-drain-a', 'mock-drain-b'])
      await app.models.profiles.register({
        id,
        name: id,
        instructions: '',
        memory: '',
        color: 'mint',
      });
    await app.groups.register({
      id: 'mock-drain-group',
      name: '合成排空群',
      members: ['mock-drain-a', 'mock-drain-b'],
    });
    app.groups.runner.start = async () => {
      entered();
      await waiting;
      throw Object.assign(new Error('RUNTIME_RECOVERY_PENDING'), {
        code: 'RUNTIME_RECOVERY_PENDING',
      });
    };
    await app.groups.send({
      id: 'mock-drain-turn',
      group: 'mock-drain-group',
      prompt: '合成尚未执行',
      recipients: ['mock-drain-a'],
    });
    const ticking = app.groups.tick();
    await started;
    const review = (await call('/api/recovery/review')).value;
    assert.ok(isRecoveryReview(review));
    const prepared = (
      await call('/api/recovery/prepare', {
        id: 'mock-drain-operation',
        revision: review.revision,
        review: review.digest,
        confirmation: 'restart-all-apps',
      })
    ).value;
    assert.ok(isRecoveryReceipt(prepared));
    const original = app.groups.drain.bind(app.groups);
    app.groups.drain = async () => {
      claimEntered();
      await original();
    };
    let complete = false;
    const claiming = call('/api/recovery/claim', {
      id: prepared.id,
      revision: prepared.revision,
    }).then((value) => {
      complete = true;
      return value;
    });
    await draining;
    assert.equal(complete, false);
    assert.equal(app.recovery.receipt(prepared.id).phase, 'prepared');
    release();
    await ticking;
    assert.equal((await claiming).value.phase, 'claimed');
    assert.equal((await app.groups.read('mock-drain-group')).deliveries[0].state, 'pending');
  } finally {
    release();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('human recovery APIs retain exact intent, fence all mutation routes and distinguish service restart from kernel restart', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-recovery-api-'));
  const config = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(config);
  const call = async (route: string, data?: unknown, token = app.token) => {
    const response = await fetch(app.url + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'x-prototype-token': token,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.equal((await call('/api/recovery')).status, 200);
    assert.ok(app.models);
    for (const id of ['mock-reader-a', 'mock-reader-b'])
      await app.models.profiles.register({
        id,
        name: id,
        instructions: '',
        memory: '',
        color: 'mint',
      });
    assert.ok(app.groups);
    await app.groups.register({
      id: 'mock-reader-group',
      name: '合成只读群',
      members: ['mock-reader-a', 'mock-reader-b'],
    });
    await writeFile(path.join(root, 'desktops/shared/mock-retained.txt'), 'SYNTHETIC-READABLE');
    assert.equal((await call('/api/recovery/review', undefined, 'mock-invalid-token')).status, 403);
    const review = (await call('/api/recovery/review')).value;
    assert.ok(isRecoveryReview(review));
    const request = {
      id: 'mock-api-recovery',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    };
    assert.equal((await call('/api/recovery/prepare', { ...request, force: true })).status, 400);
    const prepared = await call('/api/recovery/prepare', request);
    assert.equal(prepared.status, 200);
    assert.ok(isRecoveryReceipt(prepared.value));
    assert.equal(prepared.value.phase, 'prepared');
    assert.equal(
      (await call('/api/computers/receipt', { id: 'mock-unissued', bot: 'mock-reader-a' })).status,
      200,
    );
    assert.equal(
      (await call('/api/files/read', { path: 'mock-retained.txt' })).value.content,
      'SYNTHETIC-READABLE',
    );
    assert.equal((await call('/api/groups/read', { group: 'mock-reader-group' })).status, 200);
    assert.equal((await call('/api/skills/list', { bot: 'mock-reader-a' })).status, 200);
    assert.equal((await call('/api/mcp/list', { type: 'mcp.list' })).status, 200);
    for (const [route, data] of [
      [
        '/api/bots',
        {
          id: 'mock-blocked-profile',
          name: '合成不得创建',
          instructions: '',
          memory: '',
          color: 'mint',
        },
      ],
      [
        '/api/groups/register',
        { id: 'mock-blocked-group', name: '合成不得创建', members: ['mock-a', 'mock-b'] },
      ],
      ['/api/model/configure', { apiKey: 'synthetic-must-not-save' }],
    ] as const) {
      const blocked = await call(route, data);
      assert.equal(blocked.status, 409);
      assert.equal(blocked.value.error, 'RUNTIME_RECOVERY_PENDING');
    }
    assert.equal((await call('/api/state')).status, 200);
    const claim = { id: request.id, revision: prepared.value.revision };
    const claimed = await call('/api/recovery/claim', claim);
    assert.equal(claimed.status, 200);
    assert.equal(claimed.value.phase, 'claimed');
    assert.deepEqual((await call('/api/recovery/claim', claim)).value, claimed.value);
    assert.equal(
      (await call('/api/recovery/cancel', claim)).value.error,
      'RECOVERY_ALREADY_CLAIMED',
    );
    assert.deepEqual(
      (await call('/api/recovery/receipt', { id: request.id })).value,
      claimed.value,
    );
    await app.close();
    app = await startPrototype(config);
    const after = (await call('/api/recovery')).value;
    assert.equal(after.operation.phase, 'claimed');
    assert.equal(
      (
        await call('/api/bots', {
          id: 'mock-still-blocked',
          name: '合成',
          instructions: '',
          memory: '',
          color: 'mint',
        })
      ).value.error,
      'RUNTIME_RECOVERY_PENDING',
    );
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
test('an in-flight authenticated write rejects recovery without transiently fencing the accepted write', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-recovery-writing-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  let unblock: () => unknown = () => undefined;
  let entered: () => unknown = () => undefined;
  const started = new Promise((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise((resolve) => {
    unblock = () => resolve(undefined);
  });
  const call = async (route: string, data?: unknown) => {
    const response = await fetch(app.url + route, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        'x-prototype-token': app.token,
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    assert.ok(app.models);
    await app.models.profiles.register({
      id: 'mock-writing',
      name: '合成资料',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const update = app.models.profiles.update.bind(app.models.profiles);
    app.models.profiles.update = async (...args) => {
      entered();
      await gate;
      return update(...args);
    };
    const saving = call('/api/bots/mock-writing/profile', {
      revision: 1,
      patch: { name: '合成新名称' },
    });
    await started;
    const review = (await call('/api/recovery/review')).value;
    assert.ok(isRecoveryReview(review));
    assert.equal(review.changing, true);
    const result = await call('/api/recovery/prepare', {
      id: 'mock-no-interruption',
      revision: review.revision,
      review: review.digest,
      confirmation: 'restart-all-apps',
    });
    assert.equal(result.value.error, 'RECOVERY_CHANGES_RUNNING');
    assert.equal(app.models.admit('mock-writing'), true);
    unblock();
    assert.equal((await saving).status, 200);
    assert.equal((await app.models.profiles.get('mock-writing'))?.name, '合成新名称');
  } finally {
    unblock();
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

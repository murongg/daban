import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isNoteItem, isNoteReceipt, managedProtocol } from '@daban/protocol';
import { Fault } from './control.js';
import { startPrototype } from './server.js';

const alpha = 'mock-alpha',
  beta = 'mock-beta';
const request = {
  id: 'mock-create',
  note: 'mock-private-note',
  action: 'create',
  revision: 0,
  value: { title: '合成便笺', body: 'MOCK ALPHA DETAIL', status: 'open' },
};
const human = { kind: 'human' };
function channel(app: Awaited<ReturnType<typeof startPrototype>>) {
  return async (
    action: string,
    input: unknown,
    options: { token?: string; query?: string; method?: string } = {},
  ) => {
    const method = options.method ?? 'POST';
    const response = await fetch(`${app.url}/api/notes/${action}${options.query ?? ''}`, {
      method,
      headers: {
        'x-prototype-token': options.token ?? app.token,
        'content-type': 'application/json',
        'x-daban-client-protocol': String(managedProtocol),
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() };
  };
}
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-notes-api-'));
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
  for (const bot of [alpha, beta])
    await app.models!.profiles.register({
      id: bot,
      name: bot,
      instructions: 'MOCK ROLE',
      memory: '',
      color: 'mint',
    });
  return {
    root,
    get app() {
      return app;
    },
    async reopen() {
      await app.close();
      app = await startPrototype(options);
    },
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('notes HTTP closes routes, owns human authorship and keeps Bot data and receipt scopes distinct', async () => {
  const f = await fixture();
  try {
    const call = channel(f.app);
    const advertised = await (
      await fetch(`${f.app.url}/api/state`, { headers: { 'x-prototype-token': f.app.token } })
    ).json();
    assert.equal(advertised.clientProtocol, managedProtocol);
    assert.deepEqual(advertised.notes, { available: true });
    assert.equal(
      (await call('write', { bot: alpha, request }, { token: 'mock-denied' })).status,
      403,
    );
    for (const action of ['status', 'list', 'read', 'write', 'receipt']) {
      assert.equal((await call(action, {}, { method: 'GET' })).status, 405);
      assert.equal((await call(action, {}, { query: '?extra=1' })).status, 400);
    }
    for (const input of [
      { bot: alpha, request, actor: { kind: 'bot', bot: beta } },
      { bot: alpha, request, type: 'notes.read' },
      { bot: alpha, request: { ...request, bot: beta } },
      { bot: alpha, request: { ...request, value: { ...request.value, createdBy: human } } },
    ])
      assert.equal((await call('write', input)).status, 400);
    assert.equal((await call('list', { bot: alpha, query: { filter: ['active'] } })).status, 400);
    assert.equal((await call('status', { bot: 'mock-unknown' })).status, 404);
    const saved = await call('write', { bot: alpha, request });
    assert.equal(saved.status, 200);
    assert.ok(isNoteReceipt(saved.value) && saved.value.state === 'complete');
    assert.equal(saved.value.bot, alpha);
    assert.deepEqual(saved.value.item.createdBy, human);
    assert.deepEqual(
      (await call('read', { bot: alpha, id: request.note })).value,
      saved.value.item,
    );
    assert.equal(
      (await call('read', { bot: beta, id: request.note })).value.error,
      'NOTE_NOT_FOUND',
    );
    assert.deepEqual((await call('list', { bot: beta, query: {} })).value.page.items, []);
    assert.deepEqual((await call('receipt', { bot: beta, request })).value, {
      state: 'unknown',
      bot: beta,
      request,
      actor: human,
    });
    const query = { filter: 'active', limit: 1 };
    assert.deepEqual((await call('list', { bot: alpha, query })).value, {
      bot: alpha,
      query,
      page: { bot: alpha, revision: 1, items: [{ ...saved.value.item, bodyTruncated: false }] },
    });
    assert.deepEqual((await call('status', { bot: alpha })).value, {
      bot: alpha,
      status: { available: true, revision: 1, count: 1 },
    });
    assert.equal(f.app.models!.jobs.size, 0);
    assert.deepEqual(f.app.runtime.status().items, []);
  } finally {
    await f.close();
  }
});

test('HTTP note retries survive restart, conflict and later trash/restore without reapplying an old edit', async () => {
  const f = await fixture();
  try {
    let call = channel(f.app);
    await call('write', { bot: alpha, request });
    const update = {
      id: 'mock-update',
      note: request.note,
      action: 'update',
      revision: 1,
      value: { body: 'MOCK LATER', status: 'parked' },
    };
    assert.equal((await call('write', { bot: alpha, request: update })).status, 200);
    assert.equal(
      (await call('write', { bot: alpha, request: { ...update, id: 'mock-conflict' } })).value
        .error,
      'NOTE_CONFLICT',
    );
    const trashed = (
      await call('write', {
        bot: alpha,
        request: { id: 'mock-trash', note: request.note, action: 'trash', revision: 2 },
      })
    ).value;
    await f.reopen();
    call = channel(f.app);
    for (const action of ['write', 'receipt']) {
      const replay = (await call(action, { bot: alpha, request })).value;
      assert.ok(isNoteReceipt(replay) && replay.state === 'complete');
      assert.equal(replay.acceptedRevision, 1);
      assert.deepEqual(replay.item, trashed.item);
    }
    const restored = (
      await call('write', {
        bot: alpha,
        request: { id: 'mock-restore', note: request.note, action: 'restore', revision: 3 },
      })
    ).value;
    assert.equal(restored.item.body, 'MOCK LATER');
    assert.equal(restored.item.status, 'parked');
    assert.equal(restored.item.deleted, false);
  } finally {
    await f.close();
  }
});

test('recovery and archive allow note readers and receipts but fence queued writes at the owner', async (t) => {
  const f = await fixture();
  try {
    const call = channel(f.app),
      models = f.app.models!;
    await call('write', { bot: alpha, request });
    assert.ok(f.app.recovery);
    const admission = t.mock.method(f.app.recovery, 'admit', () => false);
    const enter = t.mock.method(f.app.recovery, 'enter', () => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    assert.equal((await call('status', { bot: alpha })).status, 200);
    assert.equal((await call('list', { bot: alpha, query: {} })).status, 200);
    assert.ok(isNoteItem((await call('read', { bot: alpha, id: request.note })).value));
    assert.equal((await call('receipt', { bot: alpha, request })).value.state, 'complete');
    assert.equal(enter.mock.callCount(), 0);
    assert.equal(
      (
        await call('write', {
          bot: alpha,
          request: { ...request, id: 'mock-blocked', note: 'mock-blocked' },
        })
      ).value.error,
      'RUNTIME_RECOVERY_PENDING',
    );
    await assert.rejects(
      models.notes.write(
        alpha,
        { ...request, id: 'mock-queued-recovery', note: 'mock-queued-recovery' },
        human,
      ),
      /RUNTIME_RECOVERY_PENDING/,
    );
    admission.mock.restore();
    enter.mock.restore();
    const pending = models.notes.write(
      alpha,
      {
        id: 'mock-racing',
        note: request.note,
        action: 'update',
        revision: 1,
        value: { status: 'parked' },
      },
      human,
    );
    const release = models.profiles.reserveLifecycle(alpha);
    await assert.rejects(pending, /BOT_CHANGING/);
    release();
    const profile = await models.profiles.get(alpha);
    assert.ok(profile);
    const archivedLease = models.profiles.reserveLifecycle(alpha);
    await models.profiles.beginLifecycle({
      id: 'mock-archive',
      bot: alpha,
      revision: profile.revision,
      action: 'archive',
    });
    assert.equal((await call('read', { bot: alpha, id: request.note })).status, 200);
    assert.equal((await call('receipt', { bot: alpha, request })).value.state, 'complete');
    assert.equal(
      (
        await call('write', {
          bot: alpha,
          request: { ...request, id: 'mock-archive-blocked', note: 'mock-archive-blocked' },
        })
      ).value.error,
      'BOT_CHANGING',
    );
    await models.profiles.finishLifecycle(alpha, 'mock-archive');
    archivedLease();
    assert.equal(
      (
        await call('write', {
          bot: alpha,
          request: { ...request, id: 'mock-after-archive', note: 'mock-after-archive' },
        })
      ).value.error,
      'BOT_ARCHIVED',
    );
    assert.equal((await call('status', { bot: beta })).value.status.count, 0);
    await assert.rejects(
      models.notes.write('mock-unknown', request, human),
      /BOT_PROFILE_NOT_FOUND/,
    );
  } finally {
    await f.close();
  }
});

test('a corrupt optional notes store leaves ordinary Agent and existing storage available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-notes-corrupt-api-'));
  const file = path.join(root, 'model/notes.sqlite'),
    bytes = Buffer.from('MOCK CORRUPT NOTES');
  await mkdir(path.dirname(file), { mode: 0o700 });
  await writeFile(file, bytes, { mode: 0o600 });
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  try {
    const state = await (
      await fetch(`${app.url}/api/state`, { headers: { 'x-prototype-token': app.token } })
    ).json();
    assert.deepEqual(state.notes, { available: false, error: 'NOTES_CORRUPT' });
    assert.equal(state.mode, 'agent');
    assert.equal(state.work.available, true);
    await app.models!.profiles.register({
      id: alpha,
      name: 'MOCK',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    assert.equal(
      (await channel(app)('list', { bot: alpha, query: {} })).value.error,
      'NOTES_CORRUPT',
    );
    assert.deepEqual(await readFile(file), bytes);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('shutdown closes notes even when another resource owner fails', async (t) => {
  const f = await fixture(),
    models = f.app.models!;
  const close = models.work.close.bind(models.work);
  t.mock.method(models.work, 'close', async () => {
    await close();
    throw new Fault('MOCK_CLOSE_FAILURE');
  });
  try {
    assert.deepEqual(await models.notes.availability(), { available: true });
    await assert.rejects(f.app.close(), /MOCK_CLOSE_FAILURE/);
    assert.deepEqual(await models.notes.availability(), {
      available: false,
      error: 'NOTES_CLOSED',
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

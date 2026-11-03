import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isNoteItem, isNoteReceipt, managedProtocol } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
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
    expect(advertised.clientProtocol).toBe(managedProtocol);
    expect(advertised.notes).toStrictEqual({ available: true });
    expect((await call('write', { bot: alpha, request }, { token: 'mock-denied' })).status).toBe(
      403,
    );
    for (const action of ['status', 'list', 'read', 'write', 'receipt']) {
      expect((await call(action, {}, { method: 'GET' })).status).toBe(405);
      expect((await call(action, {}, { query: '?extra=1' })).status).toBe(400);
    }
    for (const input of [
      { bot: alpha, request, actor: { kind: 'bot', bot: beta } },
      { bot: alpha, request, type: 'notes.read' },
      { bot: alpha, request: { ...request, bot: beta } },
      { bot: alpha, request: { ...request, value: { ...request.value, createdBy: human } } },
    ])
      expect((await call('write', input)).status).toBe(400);
    expect((await call('list', { bot: alpha, query: { filter: ['active'] } })).status).toBe(400);
    expect((await call('status', { bot: 'mock-unknown' })).status).toBe(404);
    const saved = await call('write', { bot: alpha, request });
    expect(saved.status).toBe(200);
    expect.assert(isNoteReceipt(saved.value) && saved.value.state === 'complete');
    expect(saved.value.bot).toBe(alpha);
    expect(saved.value.item.createdBy).toStrictEqual(human);
    expect((await call('read', { bot: alpha, id: request.note })).value).toStrictEqual(
      saved.value.item,
    );
    expect((await call('read', { bot: beta, id: request.note })).value.error).toBe(
      'NOTE_NOT_FOUND',
    );
    expect((await call('list', { bot: beta, query: {} })).value.page.items).toStrictEqual([]);
    expect((await call('receipt', { bot: beta, request })).value).toStrictEqual({
      state: 'unknown',
      bot: beta,
      request,
      actor: human,
    });
    const query = { filter: 'active', limit: 1 };
    expect((await call('list', { bot: alpha, query })).value).toStrictEqual({
      bot: alpha,
      query,
      page: { bot: alpha, revision: 1, items: [{ ...saved.value.item, bodyTruncated: false }] },
    });
    expect((await call('status', { bot: alpha })).value).toStrictEqual({
      bot: alpha,
      status: { available: true, revision: 1, count: 1 },
    });
    expect(f.app.models!.jobs.size).toBe(0);
    expect(f.app.runtime.status().items).toStrictEqual([]);
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
    expect((await call('write', { bot: alpha, request: update })).status).toBe(200);
    expect(
      (await call('write', { bot: alpha, request: { ...update, id: 'mock-conflict' } })).value
        .error,
    ).toBe('NOTE_CONFLICT');
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
      expect.assert(isNoteReceipt(replay) && replay.state === 'complete');
      expect(replay.acceptedRevision).toBe(1);
      expect(replay.item).toStrictEqual(trashed.item);
    }
    const restored = (
      await call('write', {
        bot: alpha,
        request: { id: 'mock-restore', note: request.note, action: 'restore', revision: 3 },
      })
    ).value;
    expect(restored.item.body).toBe('MOCK LATER');
    expect(restored.item.status).toBe('parked');
    expect(restored.item.deleted).toBe(false);
  } finally {
    await f.close();
  }
});

test('recovery and archive allow note readers and receipts but fence queued writes at the owner', async () => {
  const f = await fixture();
  try {
    const call = channel(f.app),
      models = f.app.models!;
    await call('write', { bot: alpha, request });
    expect.assert(f.app.recovery);
    const admission = vi.spyOn(f.app.recovery, 'admit').mockImplementation(() => false);
    const enter = vi.spyOn(f.app.recovery, 'enter').mockImplementation(() => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    expect((await call('status', { bot: alpha })).status).toBe(200);
    expect((await call('list', { bot: alpha, query: {} })).status).toBe(200);
    expect.assert(isNoteItem((await call('read', { bot: alpha, id: request.note })).value));
    expect((await call('receipt', { bot: alpha, request })).value.state).toBe('complete');
    expect(enter.mock.calls.length).toBe(0);
    expect(
      (
        await call('write', {
          bot: alpha,
          request: { ...request, id: 'mock-blocked', note: 'mock-blocked' },
        })
      ).value.error,
    ).toBe('RUNTIME_RECOVERY_PENDING');
    await expect(
      models.notes.write(
        alpha,
        { ...request, id: 'mock-queued-recovery', note: 'mock-queued-recovery' },
        human,
      ),
    ).rejects.toThrowError(/RUNTIME_RECOVERY_PENDING/);
    admission.mockRestore();
    enter.mockRestore();
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
    await expect(pending).rejects.toThrowError(/BOT_CHANGING/);
    release();
    const profile = await models.profiles.get(alpha);
    expect.assert(profile);
    const archivedLease = models.profiles.reserveLifecycle(alpha);
    await models.profiles.beginLifecycle({
      id: 'mock-archive',
      bot: alpha,
      revision: profile.revision,
      action: 'archive',
    });
    expect((await call('read', { bot: alpha, id: request.note })).status).toBe(200);
    expect((await call('receipt', { bot: alpha, request })).value.state).toBe('complete');
    expect(
      (
        await call('write', {
          bot: alpha,
          request: { ...request, id: 'mock-archive-blocked', note: 'mock-archive-blocked' },
        })
      ).value.error,
    ).toBe('BOT_CHANGING');
    await models.profiles.finishLifecycle(alpha, 'mock-archive');
    archivedLease();
    expect(
      (
        await call('write', {
          bot: alpha,
          request: { ...request, id: 'mock-after-archive', note: 'mock-after-archive' },
        })
      ).value.error,
    ).toBe('BOT_ARCHIVED');
    expect((await call('status', { bot: beta })).value.status.count).toBe(0);
    await expect(models.notes.write('mock-unknown', request, human)).rejects.toThrowError(
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
    expect(state.notes).toStrictEqual({ available: false, error: 'NOTES_CORRUPT' });
    expect(state.mode).toBe('agent');
    expect(state.work.available).toBe(true);
    await app.models!.profiles.register({
      id: alpha,
      name: 'MOCK',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    expect((await channel(app)('list', { bot: alpha, query: {} })).value.error).toBe(
      'NOTES_CORRUPT',
    );
    expect(await readFile(file)).toStrictEqual(bytes);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('shutdown closes notes even when another resource owner fails', async () => {
  const f = await fixture(),
    models = f.app.models!;
  const close = models.work.close.bind(models.work);
  vi.spyOn(models.work, 'close').mockImplementation(async () => {
    await close();
    throw new Fault('MOCK_CLOSE_FAILURE');
  });
  try {
    expect(await models.notes.availability()).toStrictEqual({ available: true });
    await expect(f.app.close()).rejects.toThrowError(/MOCK_CLOSE_FAILURE/);
    expect(await models.notes.availability()).toStrictEqual({
      available: false,
      error: 'NOTES_CLOSED',
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

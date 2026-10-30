import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isWorkCommentReceipt, managedProtocol } from '@daban/protocol';
import { Fault } from './control.js';
import { startPrototype } from './server.js';

const create = {
  id: 'mock-create',
  item: 'mock-work',
  action: 'create',
  revision: 0,
  value: { title: '合成任务', description: 'MOCK DETAIL', progress: '', status: 'todo' },
};
const request = { id: 'mock-comment', item: create.item, revision: 1, body: '合成讨论记录' };
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-comment-api-'));
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
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
function channel(f: Awaited<ReturnType<typeof fixture>>) {
  return async (
    action: string,
    input: unknown,
    opts: { token?: string; method?: string; query?: string } = {},
  ) => {
    const method = opts.method ?? 'POST';
    const response = await fetch(`${f.app.url}/api/work/${action}${opts.query ?? ''}`, {
      method,
      headers: {
        'x-prototype-token': opts.token ?? f.app.token,
        'content-type': 'application/json',
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() };
  };
}
test('Human comment HTTP closes routes and authorship without starting a model or screen', async () => {
  const f = await fixture();
  const call = channel(f);
  try {
    await call('write', create);
    assert.equal((await call('comment', request, { token: 'mock-denied' })).status, 403);
    for (const action of ['comments', 'comment', 'comment-receipt']) {
      assert.equal((await call(action, {}, { method: 'GET' })).status, 405);
      assert.equal((await call(action, {}, { query: '?extra=1' })).status, 400);
    }
    for (const input of [
      { ...request, actor: { kind: 'bot', bot: 'mock-spoof' } },
      { ...request, createdBy: { kind: 'human' } },
      { ...request, body: '  ' },
      { ...request, revision: 0 },
    ])
      assert.equal((await call('comment', input)).status, 400);
    assert.equal((await call('comments', { item: create.item, limit: 51 })).status, 400);
    assert.equal((await call('comment-receipt', request)).value.state, 'unknown');
    const reply = await call('comment', request);
    assert.equal(reply.status, 200);
    assert.ok(isWorkCommentReceipt(reply.value) && reply.value.state === 'complete');
    assert.deepEqual(reply.value.actor, { kind: 'human' });
    assert.equal(reply.value.comment.body, request.body);
    const query = { item: create.item, limit: 1 };
    const list = await call('comments', query);
    assert.equal(list.status, 200);
    assert.deepEqual(list.value.query, query);
    assert.equal(list.value.page.comments[0].id, request.id);
    const state = await fetch(`${f.app.url}/api/state`, {
      headers: { 'x-prototype-token': f.app.token },
    }).then((r) => r.json());
    assert.equal(state.clientProtocol, managedProtocol);
    assert.ok(managedProtocol >= 38);
    assert.equal(f.app.models?.jobs.size, 0);
    assert.equal(state.computers.items.length, 0);
  } finally {
    await f.close();
  }
});
test('discussion HTTP receipt/retry keeps newer edits and trash after restart', async () => {
  const f = await fixture();
  const call = channel(f);
  try {
    await call('write', create);
    await call('comment', request);
    await call('write', {
      id: 'mock-edit',
      item: create.item,
      revision: 2,
      action: 'update',
      value: { description: 'MOCK NEWER', status: 'done' },
    });
    await call('write', { id: 'mock-trash', item: create.item, revision: 3, action: 'trash' });
    await f.reopen();
    for (const action of ['comment', 'comment-receipt']) {
      const result = (await call(action, request)).value;
      assert.ok(isWorkCommentReceipt(result) && result.state === 'complete');
      assert.equal(result.acceptedRevision, 2);
      assert.equal(result.item.revision, 4);
      assert.equal(result.item.description, 'MOCK NEWER');
      assert.equal(result.item.deleted, true);
    }
    assert.equal((await call('comments', { item: create.item })).value.page.comments.length, 1);
    assert.equal(
      (await call('comment', { ...request, id: 'mock-new', revision: 4 })).value.error,
      'WORK_TRASHED',
    );
  } finally {
    await f.close();
  }
});
test('recovery permits comment readers/receipts but fences writes at the actual queue effect', async (t) => {
  const f = await fixture();
  const call = channel(f);
  try {
    await call('write', create);
    await call('comment', request);
    assert.ok(f.app.recovery);
    const admit = t.mock.method(f.app.recovery, 'admit', () => false);
    const enter = t.mock.method(f.app.recovery, 'enter', () => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    assert.equal((await call('comments', { item: create.item })).status, 200);
    assert.equal((await call('comment-receipt', request)).value.state, 'complete');
    assert.equal(enter.mock.callCount(), 0);
    assert.equal(
      (await call('comment', { ...request, id: 'mock-blocked', revision: 2 })).value.error,
      'RUNTIME_RECOVERY_PENDING',
    );
    await assert.rejects(
      f.app.models!.work.comment({ ...request, id: 'mock-direct', revision: 2 }, { kind: 'human' }),
      /RUNTIME_RECOVERY_PENDING/,
    );
    admit.mock.restore();
    enter.mock.restore();
    const pending = f.app.models!.work.comment(
      { ...request, id: 'mock-race', revision: 2 },
      { kind: 'human' },
    );
    const edit = f.app.models!.work.write(
      {
        id: 'mock-work-race',
        item: create.item,
        action: 'update',
        revision: 2,
        value: { progress: 'MOCK FENCED PROGRESS' },
      },
      { kind: 'human' },
    );
    const fence = t.mock.method(f.app.recovery, 'admit', () => false);
    await Promise.all([
      assert.rejects(pending, /RUNTIME_RECOVERY_PENDING/),
      assert.rejects(edit, /RUNTIME_RECOVERY_PENDING/),
    ]);
    assert.equal((await f.app.models!.work.comment(request, { kind: 'human' })).state, 'complete');
    fence.mock.restore();
    assert.equal((await call('comments', { item: create.item })).value.page.comments.length, 1);
  } finally {
    await f.close();
  }
});
test('queued Bot authorship checks existing active profile while Human readers and exact receipts remain available', async () => {
  const f = await fixture();
  const call = channel(f);
  const bot = 'mock-author';
  try {
    await call('write', create);
    const models = f.app.models!;
    await assert.rejects(
      models.work.comment(request, { kind: 'bot', bot }),
      /BOT_PROFILE_NOT_FOUND/,
    );
    await assert.rejects(
      models.work.write(
        { ...create, id: 'mock-bot-create', item: 'mock-bot-work' },
        { kind: 'bot', bot },
      ),
      /BOT_PROFILE_NOT_FOUND/,
    );
    await models.profiles.register({
      id: bot,
      name: '合成评论作者',
      instructions: 'MOCK',
      memory: '',
      color: 'mint',
    });
    const pending = models.work.comment(request, { kind: 'bot', bot });
    const release = models.profiles.reserveLifecycle(bot);
    await assert.rejects(pending, /BOT_CHANGING/);
    release();
    const saved = await models.work.comment(request, { kind: 'bot', bot });
    assert.equal(saved.comment.createdBy.kind, 'bot');
    const profile = await models.profiles.get(bot);
    assert.ok(profile);
    const lease = models.profiles.reserveLifecycle(bot);
    await models.profiles.beginLifecycle({
      id: 'mock-archive-author',
      bot,
      revision: profile.revision,
      action: 'archive',
    });
    await models.profiles.finishLifecycle(bot, 'mock-archive-author');
    lease();
    await assert.rejects(
      models.work.comment({ ...request, id: 'mock-archived', revision: 2 }, { kind: 'bot', bot }),
      /BOT_ARCHIVED/,
    );
    assert.equal(
      (await models.work.commentReceipt(request, { kind: 'bot', bot })).state,
      'complete',
    );
    assert.equal((await models.work.comment(request, { kind: 'bot', bot })).state, 'complete');
    assert.equal((await call('comments', { item: create.item })).status, 200);
  } finally {
    await f.close();
  }
});
test('unavailable shared Work store retains ordinary Agent startup', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-comment-corrupt-'));
  await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'model/work.sqlite'), 'MOCK CORRUPT DATA');
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  try {
    const state = await fetch(`${app.url}/api/state`, {
      headers: { 'x-prototype-token': app.token },
    }).then((r) => r.json());
    assert.equal(state.mode, 'agent');
    assert.equal(state.work.available, false);
    assert.equal(state.notes.available, true);
    assert.ok(app.models);
    await app.models.profiles.register({
      id: 'mock-corrupt-work-bot',
      name: '合成独立 Agent',
      instructions: 'MOCK ROLE',
      memory: '',
      color: 'mint',
    });
    assert.equal((await app.models.profiles.list()).length, 1);
    const response = await fetch(`${app.url}/api/work/comments`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify({ item: create.item }),
    });
    assert.equal(response.status, 409);
    assert.equal(await readFile(path.join(root, 'model/work.sqlite'), 'utf8'), 'MOCK CORRUPT DATA');
    assert.equal(app.models.jobs.size, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

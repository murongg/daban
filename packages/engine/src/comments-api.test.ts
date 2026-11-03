import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isWorkCommentReceipt, managedProtocol } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
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
    expect((await call('comment', request, { token: 'mock-denied' })).status).toBe(403);
    for (const action of ['comments', 'comment', 'comment-receipt']) {
      expect((await call(action, {}, { method: 'GET' })).status).toBe(405);
      expect((await call(action, {}, { query: '?extra=1' })).status).toBe(400);
    }
    for (const input of [
      { ...request, actor: { kind: 'bot', bot: 'mock-spoof' } },
      { ...request, createdBy: { kind: 'human' } },
      { ...request, body: '  ' },
      { ...request, revision: 0 },
    ])
      expect((await call('comment', input)).status).toBe(400);
    expect((await call('comments', { item: create.item, limit: 51 })).status).toBe(400);
    expect((await call('comment-receipt', request)).value.state).toBe('unknown');
    const reply = await call('comment', request);
    expect(reply.status).toBe(200);
    expect.assert(isWorkCommentReceipt(reply.value) && reply.value.state === 'complete');
    expect(reply.value.actor).toStrictEqual({ kind: 'human' });
    expect(reply.value.comment.body).toBe(request.body);
    const query = { item: create.item, limit: 1 };
    const list = await call('comments', query);
    expect(list.status).toBe(200);
    expect(list.value.query).toStrictEqual(query);
    expect(list.value.page.comments[0].id).toBe(request.id);
    const state = await fetch(`${f.app.url}/api/state`, {
      headers: { 'x-prototype-token': f.app.token },
    }).then((r) => r.json());
    expect(state.clientProtocol).toBe(managedProtocol);
    expect.assert(managedProtocol >= 38);
    expect(f.app.models?.jobs.size).toBe(0);
    expect(state.computers.items.length).toBe(0);
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
      expect.assert(isWorkCommentReceipt(result) && result.state === 'complete');
      expect(result.acceptedRevision).toBe(2);
      expect(result.item.revision).toBe(4);
      expect(result.item.description).toBe('MOCK NEWER');
      expect(result.item.deleted).toBe(true);
    }
    expect((await call('comments', { item: create.item })).value.page.comments.length).toBe(1);
    expect((await call('comment', { ...request, id: 'mock-new', revision: 4 })).value.error).toBe(
      'WORK_TRASHED',
    );
  } finally {
    await f.close();
  }
});
test('recovery permits comment readers/receipts but fences writes at the actual queue effect', async () => {
  const f = await fixture();
  const call = channel(f);
  try {
    await call('write', create);
    await call('comment', request);
    expect.assert(f.app.recovery);
    const admit = vi.spyOn(f.app.recovery, 'admit').mockImplementation(() => false);
    const enter = vi.spyOn(f.app.recovery, 'enter').mockImplementation(() => {
      throw new Fault('RUNTIME_RECOVERY_PENDING');
    });
    expect((await call('comments', { item: create.item })).status).toBe(200);
    expect((await call('comment-receipt', request)).value.state).toBe('complete');
    expect(enter.mock.calls.length).toBe(0);
    expect(
      (await call('comment', { ...request, id: 'mock-blocked', revision: 2 })).value.error,
    ).toBe('RUNTIME_RECOVERY_PENDING');
    await expect(
      f.app.models!.work.comment({ ...request, id: 'mock-direct', revision: 2 }, { kind: 'human' }),
    ).rejects.toThrowError(/RUNTIME_RECOVERY_PENDING/);
    admit.mockRestore();
    enter.mockRestore();
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
    const fence = vi.spyOn(f.app.recovery, 'admit').mockImplementation(() => false);
    await Promise.all([
      expect(pending).rejects.toThrowError(/RUNTIME_RECOVERY_PENDING/),
      expect(edit).rejects.toThrowError(/RUNTIME_RECOVERY_PENDING/),
    ]);
    expect((await f.app.models!.work.comment(request, { kind: 'human' })).state).toBe('complete');
    fence.mockRestore();
    expect((await call('comments', { item: create.item })).value.page.comments.length).toBe(1);
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
    await expect(models.work.comment(request, { kind: 'bot', bot })).rejects.toThrowError(
      /BOT_PROFILE_NOT_FOUND/,
    );
    await expect(
      models.work.write(
        { ...create, id: 'mock-bot-create', item: 'mock-bot-work' },
        { kind: 'bot', bot },
      ),
    ).rejects.toThrowError(/BOT_PROFILE_NOT_FOUND/);
    await models.profiles.register({
      id: bot,
      name: '合成评论作者',
      instructions: 'MOCK',
      memory: '',
      color: 'mint',
    });
    const pending = models.work.comment(request, { kind: 'bot', bot });
    const release = models.profiles.reserveLifecycle(bot);
    await expect(pending).rejects.toThrowError(/BOT_CHANGING/);
    release();
    const saved = await models.work.comment(request, { kind: 'bot', bot });
    expect(saved.comment.createdBy.kind).toBe('bot');
    const profile = await models.profiles.get(bot);
    expect.assert(profile);
    const lease = models.profiles.reserveLifecycle(bot);
    await models.profiles.beginLifecycle({
      id: 'mock-archive-author',
      bot,
      revision: profile.revision,
      action: 'archive',
    });
    await models.profiles.finishLifecycle(bot, 'mock-archive-author');
    lease();
    await expect(
      models.work.comment({ ...request, id: 'mock-archived', revision: 2 }, { kind: 'bot', bot }),
    ).rejects.toThrowError(/BOT_ARCHIVED/);
    expect((await models.work.commentReceipt(request, { kind: 'bot', bot })).state).toBe(
      'complete',
    );
    expect((await models.work.comment(request, { kind: 'bot', bot })).state).toBe('complete');
    expect((await call('comments', { item: create.item })).status).toBe(200);
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
    expect(state.mode).toBe('agent');
    expect(state.work.available).toBe(false);
    expect(state.notes.available).toBe(true);
    expect.assert(app.models);
    await app.models.profiles.register({
      id: 'mock-corrupt-work-bot',
      name: '合成独立 Agent',
      instructions: 'MOCK ROLE',
      memory: '',
      color: 'mint',
    });
    expect((await app.models.profiles.list()).length).toBe(1);
    const response = await fetch(`${app.url}/api/work/comments`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify({ item: create.item }),
    });
    expect(response.status).toBe(409);
    expect(await readFile(path.join(root, 'model/work.sqlite'), 'utf8')).toBe('MOCK CORRUPT DATA');
    expect(app.models.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

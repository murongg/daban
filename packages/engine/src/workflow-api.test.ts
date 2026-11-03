import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { startPrototype } from './server.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-workflow-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  await app.models!.profiles.register({
    id: 'mock-beta',
    name: '合成负责 Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  const call = async (protocol: number, route: string, body: unknown) => {
    const response = await fetch(app.url + '/api/work/' + route, {
      method: 'POST',
      headers: {
        'x-prototype-token': app.token,
        'x-daban-client-protocol': String(protocol),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, value: await response.json() };
  };
  const request = {
    id: 'mock-create',
    item: 'mock-work',
    action: 'create',
    revision: 0,
    value: {
      title: '合成带负责人的任务',
      description: 'MOCK SHARED CARD',
      progress: '',
      status: 'blocked',
      priority: 'urgent',
      assignee: 'mock-beta',
    },
  };
  expect((await call(39, 'write', request)).status).toBe(200);
  return {
    app,
    call,
    request,
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('legacy HTTP reads retain their closed shape and full-form edits preserve hidden metadata and blocked state', async () => {
  const f = await fixture();
  try {
    const modern = (await f.call(39, 'read', { id: f.request.item })).value;
    expect(modern.status).toBe('blocked');
    expect(modern.priority).toBe('urgent');
    expect(modern.assignee).toBe('mock-beta');
    const legacy = (await f.call(38, 'read', { id: f.request.item })).value;
    expect(legacy.status).toBe('doing');
    expect(Object.hasOwn(legacy, 'priority')).toBe(false);
    expect(Object.hasOwn(legacy, 'assignee')).toBe(false);
    const update = {
      id: 'mock-legacy-edit',
      item: legacy.id,
      revision: legacy.revision,
      action: 'update',
      value: {
        title: '合成旧界面编辑',
        description: legacy.description,
        progress: legacy.progress,
        status: legacy.status,
      },
    };
    const edited = await f.call(38, 'write', update);
    expect(edited.status).toBe(200);
    expect(edited.value.request).toStrictEqual(update);
    const after = (await f.call(39, 'read', { id: legacy.id })).value;
    expect(after.status).toBe('blocked');
    expect(after.assignee).toBe('mock-beta');
    expect(after.priority).toBe('urgent');
    expect(after.title).toBe(update.value.title);
    await f.call(39, 'write', {
      id: 'mock-later',
      item: after.id,
      revision: after.revision,
      action: 'update',
      value: { priority: 'low', progress: 'MOCK LATER HUMAN PROGRESS' },
    });
    const replay = await f.call(38, 'write', update);
    expect(replay.status).toBe(200);
    expect(replay.value.acceptedRevision).toBe(2);
    expect(replay.value.item.revision).toBe(3);
    expect(replay.value.item.status).toBe('doing');
    expect(replay.value.item.progress).toBe('MOCK LATER HUMAN PROGRESS');
    expect((await f.call(39, 'read', { id: after.id })).value.priority).toBe('low');
    expect(f.app.models!.jobs.size).toBe(0);
    expect(f.app.runtime.status().items).toStrictEqual([]);
  } finally {
    await f.close();
  }
});

test('legacy closed projections cannot silently reopen a task, and comment receipts keep their original intent', async () => {
  const f = await fixture();
  try {
    const closed = (
      await f.call(39, 'write', {
        id: 'mock-close',
        item: f.request.item,
        revision: 1,
        action: 'update',
        value: { status: 'closed' },
      })
    ).value.item;
    const title = {
      id: 'mock-legacy-title',
      item: closed.id,
      revision: closed.revision,
      action: 'update',
      value: { title: '合成已关闭任务注释', status: 'done' },
    };
    expect((await f.call(38, 'write', title)).status).toBe(200);
    const latest = (await f.call(39, 'read', { id: closed.id })).value;
    expect(latest.status).toBe('closed');
    expect(latest.completedAt).toBe(closed.completedAt);
    const denied = await f.call(38, 'write', {
      id: 'mock-old-reopen',
      item: latest.id,
      revision: latest.revision,
      action: 'update',
      value: { status: 'todo' },
    });
    expect(denied.value.error).toBe('WORK_CONFLICT');
    const request = {
      id: 'mock-comment',
      item: latest.id,
      revision: latest.revision,
      body: 'MOCK LITERAL CLOSED DISCUSSION',
    };
    const comment = await f.call(39, 'comment', request);
    expect(comment.status).toBe(200);
    const receipt = await f.call(38, 'comment-receipt', request);
    expect(receipt.status).toBe(200);
    expect(receipt.value.request).toStrictEqual(request);
    expect(receipt.value.item.status).toBe('done');
    expect(Object.hasOwn(receipt.value.item, 'priority')).toBe(false);
    expect(
      (
        await f.call(38, 'write', {
          id: 'mock-legacy-meta',
          item: latest.id,
          revision: receipt.value.item.revision,
          action: 'update',
          value: { priority: 'high' },
        })
      ).status,
    ).toBe(400);
    expect((await f.call(38, 'list', { priority: 'urgent' })).status).toBe(400);
  } finally {
    await f.close();
  }
});

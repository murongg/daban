import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
  assert.equal((await call(39, 'write', request)).status, 200);
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
    assert.equal(modern.status, 'blocked');
    assert.equal(modern.priority, 'urgent');
    assert.equal(modern.assignee, 'mock-beta');
    const legacy = (await f.call(38, 'read', { id: f.request.item })).value;
    assert.equal(legacy.status, 'doing');
    assert.equal(Object.hasOwn(legacy, 'priority'), false);
    assert.equal(Object.hasOwn(legacy, 'assignee'), false);
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
    assert.equal(edited.status, 200);
    assert.deepEqual(edited.value.request, update);
    const after = (await f.call(39, 'read', { id: legacy.id })).value;
    assert.equal(after.status, 'blocked');
    assert.equal(after.assignee, 'mock-beta');
    assert.equal(after.priority, 'urgent');
    assert.equal(after.title, update.value.title);
    await f.call(39, 'write', {
      id: 'mock-later',
      item: after.id,
      revision: after.revision,
      action: 'update',
      value: { priority: 'low', progress: 'MOCK LATER HUMAN PROGRESS' },
    });
    const replay = await f.call(38, 'write', update);
    assert.equal(replay.status, 200);
    assert.equal(replay.value.acceptedRevision, 2);
    assert.equal(replay.value.item.revision, 3);
    assert.equal(replay.value.item.status, 'doing');
    assert.equal(replay.value.item.progress, 'MOCK LATER HUMAN PROGRESS');
    assert.equal((await f.call(39, 'read', { id: after.id })).value.priority, 'low');
    assert.equal(f.app.models!.jobs.size, 0);
    assert.deepEqual(f.app.runtime.status().items, []);
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
    assert.equal((await f.call(38, 'write', title)).status, 200);
    const latest = (await f.call(39, 'read', { id: closed.id })).value;
    assert.equal(latest.status, 'closed');
    assert.equal(latest.completedAt, closed.completedAt);
    const denied = await f.call(38, 'write', {
      id: 'mock-old-reopen',
      item: latest.id,
      revision: latest.revision,
      action: 'update',
      value: { status: 'todo' },
    });
    assert.equal(denied.value.error, 'WORK_CONFLICT');
    const request = {
      id: 'mock-comment',
      item: latest.id,
      revision: latest.revision,
      body: 'MOCK LITERAL CLOSED DISCUSSION',
    };
    const comment = await f.call(39, 'comment', request);
    assert.equal(comment.status, 200);
    const receipt = await f.call(38, 'comment-receipt', request);
    assert.equal(receipt.status, 200);
    assert.deepEqual(receipt.value.request, request);
    assert.equal(receipt.value.item.status, 'done');
    assert.equal(Object.hasOwn(receipt.value.item, 'priority'), false);
    assert.equal(
      (
        await f.call(38, 'write', {
          id: 'mock-legacy-meta',
          item: latest.id,
          revision: receipt.value.item.revision,
          action: 'update',
          value: { priority: 'high' },
        })
      ).status,
      400,
    );
    assert.equal((await f.call(38, 'list', { priority: 'urgent' })).status, 400);
  } finally {
    await f.close();
  }
});

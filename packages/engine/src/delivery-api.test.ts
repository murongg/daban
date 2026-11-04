import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { Delivery } from './delivery.js';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';
import { WorkspaceFiles } from './workspace.js';

test('human checklist creation is CAS-bound, durable, idempotent and never starts a model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-delivery-'));
  // Production Host bootstrap establishes this private root before publishing control credentials.
  await secureDirectory(root);
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
  const call = async (route: string, input: unknown) => {
    const response = await fetch(`${app.url}/api/${route}`, {
      method: 'POST',
      headers: {
        'x-prototype-token': app.token,
        'x-daban-client-protocol': String(managedProtocol),
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, value: (await response.json()) as unknown };
  };
  try {
    expect.assert(app.models);
    const start = vi.spyOn(app.models, 'start');
    await call('work/write', {
      id: 'mock-create',
      item: 'mock-work',
      revision: 0,
      action: 'create',
      value: { title: 'Synthetic work', description: '', progress: '', status: 'todo' },
    });
    expect((await call('delivery/checklist.get', { workId: 'mock-work' })).status).toBe(400);
    expect(await call('delivery/checklist/get', { workId: 'mock-work' })).toEqual({
      status: 200,
      value: { workId: 'mock-work', revision: 0, items: [] },
    });
    const request = {
      requestId: 'mock-checklist',
      workId: 'mock-work',
      workRevision: 1,
      checklistRevision: 0,
      items: [{ id: 'mock-text', text: 'Synthetic result', kind: 'text', required: true }],
    };
    const saved = await call('delivery/checklist/write', request);
    expect(saved.status).toBe(200);
    expect(await call('delivery/checklist/write', request)).toEqual(saved);
    expect(
      (await call('delivery/checklist/write', { ...request, requestId: 'mock-stale' })).status,
    ).toBe(409);
    expect((await call('delivery/checklist/write', { ...request, items: [] })).status).toBe(409);
    expect(start).not.toHaveBeenCalled();
    expect((await app.models.work.get('mock-work')).revision).toBe(1);
    await app.close();
    app = await startPrototype(options);
    expect(await call('delivery/checklist/receipt', request)).toEqual(saved);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

import {
  type DeliveryAttempt,
  isDeliveryPage,
  isDeliveryReceipt,
  managedProtocol,
} from '@daban/protocol';
import type { RunReceipt } from './tasks.js';

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-delivery-flow-'));
  await secureDirectory(root);
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  expect.assert(app.models);
  const models = app.models;
  await models.profiles.register({
    id: 'mock-bot',
    name: 'Synthetic Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  });
  const call = async (route: string, input: unknown) => {
    const response = await fetch(`${app.url}/api/${route}`, {
      method: 'POST',
      headers: {
        'x-prototype-token': app.token,
        'x-daban-client-protocol': String(managedProtocol),
        'content-type': 'application/json',
      },
      body: JSON.stringify(input),
    });
    return { status: response.status, value: (await response.json()) as unknown };
  };
  await call('work/write', {
    id: 'mock-create',
    item: 'mock-work',
    revision: 0,
    action: 'create',
    value: {
      title: 'Synthetic work',
      description: 'Synthetic task',
      progress: '',
      status: 'todo',
      assignee: 'mock-bot',
    },
  });
  const receipts = new Map<string, RunReceipt>();
  vi.spyOn(models, 'findRequest').mockImplementation((_bot, request) => receipts.get(request));
  const start = vi
    .spyOn(models, 'start')
    .mockImplementation(async (_bot, input, _scope, delivery) => {
      const request = input as { requestId: string };
      expect((await models.work.get('mock-work')).status).toBe('doing');
      receipts.set(request.requestId, {
        runId: request.requestId === 'mock-start' ? 'mock-run' : `mock-${request.requestId}`,
        phase: 'running',
        delivery,
        conversationId: _scope?.id,
      });
      return {} as Awaited<ReturnType<typeof models.start>>;
    });
  const page = async () => {
    const value = (await call('delivery/get', { workId: 'mock-work' })).value;
    expect.assert(isDeliveryPage(value));
    return value;
  };
  const target = async (attempt: DeliveryAttempt, requestId: string) => ({
    requestId,
    workId: attempt.workId,
    workRevision: (await models.work.get(attempt.workId)).revision,
    attemptId: attempt.attemptId,
    attemptRevision: attempt.revision,
  });
  return {
    root,
    app,
    models,
    call,
    receipts,
    start,
    page,
    target,
    startInput: {
      requestId: 'mock-start',
      workId: 'mock-work',
      workRevision: 1,
      checklistRevision: 0,
      bot: 'mock-bot',
    },
    async close() {
      await app.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('explicit start durably claims once; new checklist and human edits cannot mutate its snapshot or be overwritten', async () => {
  const f = await fixture();
  try {
    const first = await f.call('delivery/start', f.startInput);
    expect(first.status).toBe(200);
    expect(isDeliveryReceipt(first.value)).toBe(true);
    expect(await f.call('delivery/start', f.startInput)).toEqual(first);
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.call('delivery/start', {
          ...f.startInput,
          requestId: 'mock-other',
          workRevision: 2,
        })
      ).status,
    ).toBe(409);
    await f.call('delivery/checklist/write', {
      requestId: 'mock-next-checklist',
      workId: 'mock-work',
      workRevision: 2,
      checklistRevision: 0,
      items: [{ id: 'mock-next', text: 'For next execution', kind: 'text', required: true }],
    });
    await f.models.work.write(
      {
        id: 'mock-human-edit',
        item: 'mock-work',
        revision: 2,
        action: 'update',
        value: { title: 'Human changed task', status: 'done' },
      },
      { kind: 'human' },
    );
    f.receipts.set('mock-start', {
      ...f.receipts.get('mock-start')!,
      runId: 'mock-run',
      phase: 'completed',
      result: 'Synthetic result',
    });
    const root = f.receipts.get('mock-start')!.delivery!;
    f.receipts.set('mock-start', {
      ...f.receipts.get('mock-start')!,
      delivery: { workId: root.workId, requestId: root.requestId, attemptId: root.attemptId },
    });
    const page = await f.page();
    expect(page.attempts[0]).toMatchObject({
      title: 'Synthetic work',
      phase: 'ready',
      checklist: { revision: 0, items: [] },
    });
    expect(page.checklist.revision).toBe(1);
    expect((await f.models.work.get('mock-work')).status).toBe('done');
    expect(page.attempts[0].decision).toBeUndefined();
  } finally {
    await f.close();
  }
});

test('missing start acknowledgement remains unknown; querying never replays and closing needs human confirmation and reason', async () => {
  const f = await fixture();
  try {
    f.start.mockRejectedValue(new Error('MOCK_ACK_LOST'));
    expect((await f.call('delivery/start', f.startInput)).status).toBe(200);
    let attempt = (await f.page()).attempts[0];
    expect(attempt.phase).toBe('unknown');
    expect(f.start).toHaveBeenCalledTimes(1);
    expect(
      (await f.call('delivery/start', { ...f.startInput, requestId: 'mock-new', workRevision: 2 }))
        .status,
    ).toBe(409);
    const request = {
      ...(await f.target(attempt, 'mock-close')),
      action: 'close-unknown',
      checked: [],
      reason: 'Checked; effects may already exist',
      confirmed: true,
    };
    expect((await f.call('delivery/decide', { ...request, confirmed: false })).status).toBe(400);
    expect((await f.call('delivery/decide', { ...request, reason: '' })).status).toBe(400);
    expect((await f.call('delivery/decide', request)).status).toBe(200);
    attempt = (await f.page()).attempts[0];
    expect(attempt.phase).toBe('unknown');
    expect(attempt.decision?.action).toBe('close-unknown');
    f.start.mockResolvedValue({} as Awaited<ReturnType<typeof f.models.start>>);
    expect(
      (await f.call('delivery/start', { ...f.startInput, requestId: 'mock-new', workRevision: 2 }))
        .status,
    ).toBe(200);
    expect(f.start).toHaveBeenCalledTimes(2);
  } finally {
    await f.close();
  }
});

test('only explicit accept creates a versioned human decision; empty lists still require confirmation', async () => {
  const f = await fixture();
  try {
    await f.call('delivery/start', f.startInput);
    f.receipts.set('mock-start', {
      ...f.receipts.get('mock-start')!,
      runId: 'mock-run',
      phase: 'completed',
      result: 'Synthetic result',
    });
    const attempt = (await f.page()).attempts[0];
    expect((await f.models.work.get('mock-work')).status).toBe('review');
    const request = {
      ...(await f.target(attempt, 'mock-accept')),
      action: 'accept',
      checked: [],
      reason: '',
      confirmed: true,
    };
    expect((await f.call('delivery/decide', { ...request, confirmed: false })).status).toBe(400);
    const accepted = await f.call('delivery/decide', request);
    expect(accepted.status).toBe(200);
    expect(await f.call('delivery/decide', request)).toEqual(accepted);
    expect((await f.models.work.get('mock-work')).status).toBe('done');
    expect((await f.page()).attempts[0]).toMatchObject({
      phase: 'accepted-by-user',
      decision: { action: 'accept', criteria: [], evidence: [] },
    });
    expect(f.start).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test('file acceptance binds actual run bytes and requires rechecking after the same path changes', async () => {
  const f = await fixture();
  try {
    const directory = path.join(f.root, 'desktops/shared/mock-run');
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'report.txt'), 'SYNTHETIC VERSION ONE');
    await f.call('delivery/checklist/write', {
      requestId: 'mock-file-list',
      workId: 'mock-work',
      workRevision: 1,
      checklistRevision: 0,
      items: [{ id: 'mock-file', kind: 'file', text: 'Synthetic report', required: true }],
    });
    await f.call('delivery/start', { ...f.startInput, checklistRevision: 1 });
    f.receipts.set('mock-start', {
      ...f.receipts.get('mock-start')!,
      phase: 'completed',
      files: [
        {
          path: 'mock-run/report.txt',
          name: 'report.txt',
          size: 21,
          modified: '2026-01-01T00:00:00Z',
        },
      ],
    });
    let attempt = (await f.page()).attempts[0];
    const decision = async (id: string) => ({
      ...(await f.target(attempt, id)),
      action: 'accept',
      checked: ['mock-file'],
      reason: '',
      confirmed: true,
    });
    expect((await f.call('delivery/decide', await decision('mock-no-file'))).status).toBe(409);
    const bind = {
      ...(await f.target(attempt, 'mock-bind')),
      criterionId: 'mock-file',
      output: { path: 'mock-run/report.txt', runId: 'mock-run', bot: 'mock-bot' },
    };
    expect(
      (
        await f.call('delivery/file/bind', {
          ...bind,
          output: { ...bind.output, runId: 'mock-other-run' },
        })
      ).status,
    ).toBe(409);
    const bound = await f.call('delivery/file/bind', bind);
    expect(bound.status).toBe(200);
    expect(await f.call('delivery/file/bind', bind)).toEqual(bound);
    attempt = (await f.page()).attempts[0];
    expect(attempt.evidence[0]).toMatchObject({ source: 'file-check', available: true });
    expect.assert(attempt.evidence[0].source === 'file-check');
    const oldDigest = attempt.evidence[0].sha256;
    await writeFile(path.join(directory, 'report.txt'), 'SYNTHETIC VERSION TWO');
    expect((await f.call('delivery/decide', await decision('mock-changed-file'))).status).toBe(409);
    attempt = (await f.page()).attempts[0];
    expect(attempt.evidence[0]).toMatchObject({ source: 'file-check', available: false });
    expect(
      (
        await f.call('delivery/file/bind', {
          ...bind,
          ...(await f.target(attempt, 'mock-recheck')),
        })
      ).status,
    ).toBe(200);
    attempt = (await f.page()).attempts[0];
    expect.assert(attempt.evidence[0].source === 'file-check');
    expect(attempt.evidence[0].sha256).not.toBe(oldDigest);
    expect(
      (await f.call('delivery/decide', await decision('mock-accept-version-two'))).status,
    ).toBe(200);
    const accepted = (await f.page()).attempts[0];
    await writeFile(path.join(directory, 'report.txt'), 'SYNTHETIC VERSION THREE');
    expect((await f.page()).attempts[0].decision).toEqual(accepted.decision);
    expect(f.start).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test.each(['completed', 'failed'])(
  'handoff retains active ownership until all group stages finish after primary %s',
  async (primaryPhase) => {
    const f = await fixture();
    try {
      await f.models.profiles.register({
        id: 'mock-helper',
        name: 'Synthetic helper',
        instructions: '',
        memory: '',
        color: 'mint',
      });
      await f.call('delivery/start', f.startInput);
      const attempt = (await f.page()).attempts[0];
      const reference = {
        attemptId: attempt.attemptId,
        workId: attempt.workId,
        requestId: attempt.requestId,
      };
      vi.spyOn(f.models, 'groupSource').mockReturnValue({
        intentId: 'mock-intent',
        delivery: reference,
      });
      expect.assert(f.app.groups);
      const group = await f.app.groups.collaborate(
        { bot: 'mock-bot', runId: 'mock-run' },
        {
          name: 'Synthetic collaborators',
          members: ['mock-helper'],
          message: 'Synthetic shared request',
        },
      );
      f.receipts.set('mock-start', { ...f.receipts.get('mock-start')!, phase: primaryPhase });
      expect((await f.page()).attempts[0]).toMatchObject({
        phase: 'running',
        groups: [{ groupId: group.group.id, sourceId: group.sourceId }],
      });
      await f.app.groups.tick();
      const stages = (await f.app.groups.read(group.group.id)).deliveries;
      const first = f.receipts.get(stages[0].requestId)!;
      f.receipts.set(stages[0].requestId, { ...first, phase: 'completed' });
      await f.app.groups.tick();
      expect((await f.page()).attempts[0].phase).toBe('running');
      const last = (await f.app.groups.read(group.group.id)).deliveries.at(-1)!;
      f.receipts.set(last.requestId, { ...f.receipts.get(last.requestId)!, phase: 'completed' });
      await f.app.groups.tick();
      expect((await f.page()).attempts[0].phase).toBe(
        primaryPhase === 'completed' ? 'ready' : 'failed',
      );
      expect((await f.models.work.get('mock-work')).status).toBe(
        primaryPhase === 'completed' ? 'review' : 'blocked',
      );
    } finally {
      await f.close();
    }
  },
);

test('concurrent reused start IDs reject changed intent while an acknowledgement is still pending', async () => {
  const f = await fixture();
  let release!: () => unknown;
  let entered!: () => unknown;
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const called = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  try {
    f.start.mockImplementation(async () => {
      entered();
      await gate;
      return {} as Awaited<ReturnType<typeof f.models.start>>;
    });
    const service = new Delivery(
      f.models,
      f.app.groups,
      new WorkspaceFiles(path.join(f.root, 'desktops/shared')),
    );
    const first = service.command({ type: 'delivery.start', request: f.startInput });
    await called;
    const conflict = service.command({
      type: 'delivery.start',
      request: { ...f.startInput, checklistRevision: 1 },
    });
    release();
    await expect(conflict).rejects.toMatchObject({ code: 'DELIVERY_REQUEST_CONFLICT' });
    await expect(first).resolves.toMatchObject({ state: 'complete' });
    expect(f.start).toHaveBeenCalledTimes(1);
  } finally {
    release();
    await f.close();
  }
});

test('recycle-bin execution remains stoppable and late receipts cannot accept or overwrite a closed card', async () => {
  const f = await fixture();
  try {
    await f.call('delivery/start', f.startInput);
    await f.models.work.write(
      { id: 'mock-trash', item: 'mock-work', action: 'trash', revision: 2 },
      { kind: 'human' },
    );
    let attempt = (await f.page()).attempts[0];
    const stop = vi
      .spyOn(f.models, 'stopRequest')
      .mockImplementation(async (bot, requestId, group) => {
        expect([bot, requestId, group]).toEqual(['mock-bot', 'mock-start', undefined]);
        f.receipts.set('mock-start', { ...f.receipts.get('mock-start')!, phase: 'stopped' });
      });
    const request = await f.target(attempt, 'mock-stop');
    expect((await f.call('delivery/stop', request)).status).toBe(200);
    expect((await f.call('delivery/stop', request)).status).toBe(200);
    expect(stop).toHaveBeenCalledTimes(1);
    attempt = (await f.page()).attempts[0];
    expect(attempt.phase).toBe('stopped');
    expect((await f.models.work.get('mock-work')).deleted).toBe(true);
    expect(
      (
        await f.call('delivery/start', {
          ...f.startInput,
          requestId: 'mock-trash-start',
          workRevision: 3,
        })
      ).status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

test('recovery keeps public delivery reads available and manual closed cards require reopening before acceptance', async () => {
  const f = await fixture();
  try {
    await f.call('delivery/start', f.startInput);
    f.receipts.set('mock-start', { ...f.receipts.get('mock-start')!, phase: 'completed' });
    await f.models.work.write(
      {
        id: 'mock-close-card',
        item: 'mock-work',
        revision: 2,
        action: 'update',
        value: { status: 'closed' },
      },
      { kind: 'human' },
    );
    let attempt = (await f.page()).attempts[0];
    expect(
      (
        await f.call('delivery/decide', {
          ...(await f.target(attempt, 'mock-cannot-reopen')),
          action: 'accept',
          checked: [],
          reason: '',
          confirmed: true,
        })
      ).status,
    ).toBe(409);
    expect((await f.models.work.get('mock-work')).status).toBe('closed');
    expect.assert(f.app.recovery);
    vi.spyOn(f.app.recovery, 'admit').mockReturnValue(false);
    attempt = (await f.page()).attempts[0];
    expect(attempt.phase).toBe('ready');
  } finally {
    await f.close();
  }
});

test('unavailable group facts stay unknown and queryable instead of guessing a successful handoff', async () => {
  const f = await fixture();
  try {
    await f.call('delivery/start', f.startInput);
    f.receipts.set('mock-start', { ...f.receipts.get('mock-start')!, phase: 'completed' });
    expect.assert(f.app.groups);
    vi.spyOn(f.app.groups, 'deliveryProgress').mockRejectedValue(
      new Error('MOCK_GROUP_STORAGE_UNAVAILABLE'),
    );
    const attempt = (await f.page()).attempts[0];
    expect(attempt.phase).toBe('unknown');
    expect(attempt.queriedAt).toBeTruthy();
    expect(f.start).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test('explicit stop cancels a pending handoff and records stopped only after known execution facts', async () => {
  const f = await fixture();
  try {
    await f.models.profiles.register({
      id: 'mock-helper',
      name: 'Synthetic helper',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    await f.call('delivery/start', f.startInput);
    let attempt = (await f.page()).attempts[0];
    vi.spyOn(f.models, 'groupSource').mockReturnValue({
      intentId: 'mock-intent',
      delivery: {
        attemptId: attempt.attemptId,
        workId: attempt.workId,
        requestId: attempt.requestId,
      },
    });
    expect.assert(f.app.groups);
    const group = await f.app.groups.collaborate(
      { bot: 'mock-bot', runId: 'mock-run' },
      {
        name: 'Synthetic collaborators',
        members: ['mock-helper'],
        message: 'Synthetic shared task',
      },
    );
    f.receipts.set('mock-start', { ...f.receipts.get('mock-start')!, phase: 'completed' });
    attempt = (await f.page()).attempts[0];
    expect(
      (await f.call('delivery/stop', await f.target(attempt, 'mock-stop-handoff'))).status,
    ).toBe(200);
    expect((await f.page()).attempts[0].phase).toBe('stopped');
    expect(
      (await f.app.groups.read(group.group.id)).deliveries.every(
        (stage) => stage.state === 'cancelled',
      ),
    ).toBe(true);
    expect(f.start).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

test('all permitted Unicode checklist text reaches the existing task input without exceeding its prompt limit', async () => {
  const f = await fixture();
  try {
    const items = Array.from({ length: 20 }, (_, index) => ({
      id: `mock-${index}`,
      text: '🤖'.repeat(300),
      kind: 'text',
      required: true,
    }));
    await f.call('delivery/checklist/write', {
      requestId: 'mock-unicode-list',
      workId: 'mock-work',
      workRevision: 1,
      checklistRevision: 0,
      items,
    });
    let valid = false;
    const { validateTask } = await import('./tasks.js');
    f.start.mockImplementation(async (_bot, input) => {
      const task = validateTask(input);
      valid = true;
      const content =
        task.prompt +
        (task.files ?? []).map((file) => ('content' in file ? file.content : '')).join('');
      expect(content).toContain('🤖'.repeat(300));
      return {} as Awaited<ReturnType<typeof f.models.start>>;
    });
    await f.call('delivery/start', { ...f.startInput, checklistRevision: 1 });
    expect(valid).toBe(true);
  } finally {
    await f.close();
  }
});

test('text criteria retain model-report run evidence without inventing file verification', async () => {
  const f = await fixture();
  try {
    await f.call('delivery/checklist/write', {
      requestId: 'mock-text-list',
      workId: 'mock-work',
      workRevision: 1,
      checklistRevision: 0,
      items: [{ id: 'mock-text', text: 'Synthetic criterion', kind: 'text', required: true }],
    });
    await f.call('delivery/start', { ...f.startInput, checklistRevision: 1 });
    f.receipts.set('mock-start', {
      ...f.receipts.get('mock-start')!,
      phase: 'completed',
      result: 'Synthetic result',
    });
    let attempt = (await f.page()).attempts[0];
    expect(attempt.evidence).toMatchObject([
      { criterionId: 'mock-text', source: 'model-report', bot: 'mock-bot', runId: 'mock-run' },
    ]);
    expect(attempt.evidence[0]).not.toHaveProperty('path');
    expect(attempt.evidence[0]).not.toHaveProperty('sha256');
    const receipt = f.receipts.get('mock-start')!;
    const results = attempt.results;
    f.receipts.delete('mock-start');
    const unknown = (await f.page()).attempts[0];
    expect(unknown.phase).toBe('unknown');
    expect(unknown.results).toEqual(results);
    f.receipts.set('mock-start', receipt);
    attempt = (await f.page()).attempts[0];

    expect(
      (
        await f.call('delivery/decide', {
          ...(await f.target(attempt, 'mock-accept-text')),
          action: 'accept',
          checked: ['mock-text'],
          reason: '',
          confirmed: true,
        })
      ).status,
    ).toBe(200);
    expect((await f.page()).attempts[0].decision?.evidence).toEqual(attempt.evidence);
  } finally {
    await f.close();
  }
});

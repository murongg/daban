import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { automationCapability, isSchedule } from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { secureDirectory } from './private-files.js';
import * as calendar from './schedule-domain.js';
import { startPrototype } from './server.js';

test('authenticated automation routes preserve old projections and saving or checking never starts a model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-automation-api-'));
  await secureDirectory(root);
  const profileDir = path.join(root, 'profile');
  await secureDirectory(profileDir);
  vi.spyOn(calendar, 'nativeSchedules').mockResolvedValue({
    create: (input, now) => ({
      ...input,
      kind: 'every',
      scheduledAt: new Date(now + 60000).toISOString(),
    }),
    decode: (value) => value,
    due: (value) => ({
      occurrenceAt: value.scheduledAt,
      nextScheduledAt: new Date(Date.parse(value.scheduledAt) + 60000).toISOString(),
    }),
  });
  const app = await startPrototype({ profileDir, port: 0, computers: true });
  const start = vi
    .spyOn(app.models!, 'start')
    .mockRejectedValue(new Error('SYNTHETIC MUST NOT DISPATCH'));
  const call = async (route: string, input?: unknown, modern = true, authorized = true) => {
    const response = await fetch(app.url + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: {
        ...(authorized ? { 'x-prototype-token': app.token } : {}),
        ...(modern ? { 'x-daban-automation': automationCapability } : {}),
        'content-type': 'application/json',
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    await app.models!.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const input = {
      id: 'mock-time',
      bot: 'mock-bot',
      title: 'Synthetic',
      prompt: 'Synthetic task',
      enabled: false,
      rule: { kind: 'every', everySeconds: 60 },
    };
    expect((await call('/api/schedules/create', input)).status).toBe(200);
    expect(
      (
        await call(
          '/api/schedules/monitor',
          { id: input.id, revision: 1, policy: { kind: 'changes', signalPath: 'result.txt' } },
          true,
          false,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await call('/api/schedules/monitor', {
          id: input.id,
          revision: 1,
          policy: { kind: 'changes' },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('/api/schedules/monitor', {
          type: 'schedule.ack',
          id: input.id,
          notice: 'mock-injected',
        })
      ).status,
    ).toBe(400);
    const saved = await call('/api/schedules/monitor', {
      id: input.id,
      revision: 1,
      policy: { kind: 'changes', signalPath: 'result.txt' },
    });
    expect(saved.status).toBe(200);
    expect(isSchedule(saved.value)).toBe(true);
    expect(saved.value.automation.policy.kind).toBe('changes');
    const old = await call('/api/schedules/get', { id: input.id }, false);
    expect(old.status).toBe(200);
    expect(old.value).not.toHaveProperty('automation');
    const changed = await call(
      '/api/schedules/update',
      { id: input.id, revision: saved.value.revision, patch: { title: 'Synthetic renamed' } },
      false,
    );
    expect(changed.status).toBe(200);
    expect((await app.schedules!.get(input.id)).automation?.policy.kind).toBe('changes');
    const file = {
      ...input,
      id: 'mock-file',
      rule: {
        kind: 'file',
        scope: { projectId: 'mock-project', revision: 1 },
        paths: ['mock.bin'],
        pollSeconds: 60,
      },
    };
    expect((await call('/api/schedules/create', file, false)).value.error).toBe(
      'AUTOMATION_UPGRADE_REQUIRED',
    );
    expect((await call('/api/schedules/create', file)).status).toBe(200);
    expect(
      (await call('/api/state', undefined, false)).value.schedules.items.map(
        (value: { id: string }) => value.id,
      ),
    ).toEqual([input.id]);
    const state = await call('/api/state');
    expect(state.value.schedules.automation).toEqual({ changes: true, files: false });
    expect(state.value.schedules.items).toHaveLength(2);
    expect(
      (await call('/api/schedules/receipt', { id: file.id, firing: 'mock-unknown' })).status,
    ).toBe(404);
    expect(
      (await call('/api/schedules/ack', { id: input.id, notice: 'mock-notice', extra: true }))
        .status,
    ).toBe(400);
    expect(start).not.toHaveBeenCalled();
    await app.schedules!.run(input.id, 'mock-unknown-receipt');
    await app.schedules!.tick();
    vi.spyOn(app.groups!, 'notices').mockRejectedValue(
      new Error('Synthetic optional group failure'),
    );
    const partial = await call('/api/state');
    expect(
      partial.value.notices.items.some(
        (notice: { kind: string; code?: string }) =>
          notice.kind === 'automation' && notice.code === 'SCHEDULE_OUTCOME_UNKNOWN',
      ),
    ).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

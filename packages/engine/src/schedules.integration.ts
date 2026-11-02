import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nativeSchedules } from './schedule-domain.js';
import { Schedules } from './schedules.js';

test('installed DSH scheduling computes real timezones, once, intervals and cron with durable round trips', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-native-schedules-'));
  const options = {
    domain: nativeSchedules(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-sdk-client')),
    file: path.join(directory, 'schedules.sqlite'),
    clock: () => Date.parse('2026-01-02T00:00:00Z'),
    runner: { running: () => false, findRequest: () => undefined, start: async () => ({}) },
  };
  let schedules = new Schedules(options);
  try {
    await schedules.ready;
    assert.deepEqual(
      await schedules.preview({
        kind: 'weekly',
        time: '09:00',
        timeZone: 'Asia/Shanghai',
        weekdays: [1, 2, 3, 4, 5],
      }),
      ['2026-01-02T01:00:00.000Z', '2026-01-05T01:00:00.000Z', '2026-01-06T01:00:00.000Z'],
    );
    assert.equal(
      (
        await schedules.preview({
          kind: 'cron',
          expression: '0 9 * * 1-5',
          timeZone: 'Asia/Shanghai',
        })
      )[1],
      '2026-01-05T01:00:00.000Z',
    );
    assert.deepEqual(
      await schedules.preview({
        kind: 'once',
        date: '2026-01-03',
        time: '09:00',
        timeZone: 'Asia/Shanghai',
      }),
      ['2026-01-03T01:00:00.000Z'],
    );
    assert.equal(
      (await schedules.preview({ kind: 'every', everySeconds: 60 }))[0],
      '2026-01-02T00:01:00.000Z',
    );
    await assert.rejects(
      schedules.preview({ kind: 'cron', expression: '99 99 * * *', timeZone: 'Asia/Shanghai' }),
      { code: 'INVALID_SCHEDULE' },
    );
    await assert.rejects(
      schedules.preview({
        kind: 'once',
        date: '2025-01-01',
        time: '09:00',
        timeZone: 'Asia/Shanghai',
      }),
      { code: 'INVALID_SCHEDULE' },
    );
    const stored = await schedules.create({
      id: 'mock-native-daily',
      bot: 'mock-bot',
      title: '合成日程',
      prompt: '只处理合成数据',
      rule: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' },
    });
    assert.equal(stored.nextRunAt, '2026-01-02T01:00:00.000Z');
    const edited = await schedules.update(stored.id, stored.revision, {
      title: '  合成新标题  ',
      rule: stored.rule,
    });
    assert.equal(edited.title, '合成新标题');
    assert.equal(edited.nextRunAt, stored.nextRunAt);
    await schedules.close();
    schedules = new Schedules(options);
    assert.deepEqual((await schedules.list())[0], edited);
  } finally {
    await schedules.close();
    await rm(directory, { recursive: true, force: true });
  }
});

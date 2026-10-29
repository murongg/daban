import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBotLifecycleAck } from '@daban/protocol';
import type { Screens } from './desktop.js';
import { Native } from './native.js';
import { startPrototype } from './server.js';

const nativeSchedules = existsSync(
  '/opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-schedule/lib/index.js',
);
const profile = {
  id: 'mock-life-a',
  name: '合成归档助手',
  instructions: '',
  memory: 'SYNTHETIC-RETAINED-MEMORY',
  color: 'mint' as const,
};

test('authenticated lifecycle API preserves owned data, checks task/resource/queue state and binds exact receipts', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-lifecycle-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  const request = async (bot: string, action: string, data: unknown, token = app.token) => {
    const response = await fetch(`${app.url}/api/bots/${bot}/${action}`, {
      method: 'POST',
      headers: { 'x-prototype-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  const archive = { id: 'mock-life-archive', bot: profile.id, action: 'archive', revision: 1 };
  try {
    assert.ok(app.models && app.groups && app.schedules && app.lifecycle);
    await app.models.profiles.register(profile);
    await app.models.profiles.register({ ...profile, id: 'mock-life-b' });
    const state = await (
      await fetch(`${app.url}/api/state`, { headers: { 'x-prototype-token': app.token } })
    ).json();
    assert.equal(state.clientProtocol, 33);
    assert.equal(
      (await request(profile.id, 'lifecycle', archive, 'synthetic-wrong-token')).status,
      403,
    );
    assert.equal((await request('mock-life-b', 'lifecycle', archive)).status, 400);
    assert.equal(
      (await request(profile.id, 'lifecycle', { ...archive, eraseFiles: true })).status,
      400,
    );
    assert.equal((await request(profile.id, 'lifecycle-receipt', { id: archive.id })).status, 404);
    let driverStarts = 0;
    Object.assign(app.runtime.options.driver, {
      start: async (bot: string, _slot: number, control: Native['control']) => {
        driverStarts++;
        let closed = false;
        const screens = {
          instance: () => 'mock-api-screen',
          frame: async () => Buffer.from('SYNTHETIC-FRAME'),
          input: async () => {},
          openApp: async () => {},
          close: async () => {
            closed = true;
          },
        };
        return {
          bot,
          instance: 'mock-api-screen',
          native: new Native(control, screens as unknown as Screens),
          alive: () => !closed,
        };
      },
      stop: async (resource: { native: Native }) => resource.native.close(),
    });
    const connected = await app.runtime.operate({
      id: 'mock-life-connect',
      bot: profile.id,
      action: 'connect',
      revision: 0,
    });
    assert.equal(
      (await request(profile.id, 'lifecycle', archive)).value.error,
      'BOT_COMPUTER_CONNECTED',
    );
    assert.equal((await app.models.profiles.get(profile.id))?.archived, undefined);
    await app.runtime.operate({
      id: 'mock-life-stop',
      bot: profile.id,
      action: 'stop',
      revision: connected.state.revision,
      instance: connected.state.instance!,
      confirmation: 'close-apps',
    });
    const running = app.groups.runner.running;
    app.groups.runner.running = () => true;
    await app.groups.register({
      id: 'mock-life-group',
      name: '合成保留群',
      members: [profile.id, 'mock-life-b'],
    });
    await app.groups.send({
      id: 'mock-life-queued',
      group: 'mock-life-group',
      prompt: '合成保留消息',
      recipients: [profile.id],
    });
    assert.equal(
      (await request(profile.id, 'lifecycle', archive)).value.error,
      'BOT_GROUP_PENDING',
    );
    await app.groups.cancel('mock-life-group', 'mock-life-queued');
    app.groups.runner.running = running;
    const report = path.join(root, 'desktops/shared/synthetic-retained.txt');
    const bytes = Buffer.from('SYNTHETIC-RETAINED-FILE');
    await writeFile(report, bytes);
    if (nativeSchedules)
      await app.schedules.create({
        id: 'mock-life-plan',
        bot: profile.id,
        title: '合成保留计划',
        prompt: '合成未来工作',
        rule: { kind: 'every', everySeconds: 86400 },
        locked: true,
      });
    const archived = await request(profile.id, 'lifecycle', archive);
    assert.equal(archived.status, nativeSchedules ? 200 : 409);
    const receipt = await request(profile.id, 'lifecycle-receipt', { id: archive.id });
    assert.ok(isBotLifecycleAck(receipt.value));
    assert.equal(receipt.value.profile.archived, true);
    assert.equal(receipt.value.receipt.phase, nativeSchedules ? 'complete' : 'pending');
    assert.equal(
      (await request('mock-life-b', 'lifecycle-receipt', { id: archive.id })).status,
      404,
    );
    const blocked = await request(profile.id, 'model', {
      running: true,
      task: { requestId: 'mock-archived-never-start', prompt: '合成不得开始' },
    });
    assert.equal(blocked.value.error, nativeSchedules ? 'BOT_ARCHIVED' : 'BOT_CHANGING');
    assert.equal(app.models.findRequest(profile.id, 'mock-archived-never-start'), undefined);
    assert.equal(app.models.jobs.size, 0);
    assert.equal(driverStarts, 1);
    assert.deepEqual(await readFile(report), bytes);
    assert.equal((await app.models.profiles.get(profile.id))?.memory, profile.memory);
    const groups = await app.groups.status();
    assert.deepEqual(groups.items[0].members, [profile.id, 'mock-life-b']);
    if (nativeSchedules) {
      assert.equal((await app.schedules.get('mock-life-plan')).enabled, false);
      const restored = await request(profile.id, 'lifecycle', {
        id: 'mock-life-restore',
        bot: profile.id,
        action: 'restore',
        revision: receipt.value.profile.revision,
      });
      assert.equal(restored.status, 200);
      assert.ok(isBotLifecycleAck(restored.value));
      assert.equal(restored.value.profile.archived, false);
      assert.equal((await app.schedules.get('mock-life-plan')).enabled, false);
      assert.equal(app.models.jobs.size, 0);
      assert.equal(driverStarts, 1);
      assert.equal((await request(profile.id, 'lifecycle', archive)).status, 409);
    }
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('startup finishes accepted archive before automatic schedules and groups start', {
  skip: !nativeSchedules && process.env.REQUIRE_LINUX !== '1',
}, async () => {
  assert.equal(nativeSchedules, true);
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-lifecycle-startup-'));
  const options = { profileDir: path.join(root, 'profile'), port: 0, computers: true as const };
  let app = await startPrototype(options);
  try {
    assert.ok(app.models && app.schedules);
    await app.models.profiles.register(profile);
    await app.schedules.create({
      id: 'mock-startup-plan',
      bot: profile.id,
      title: '合成未来计划',
      prompt: '合成保留工作',
      rule: { kind: 'every', everySeconds: 86400 },
    });
    const release = app.models.profiles.reserveLifecycle(profile.id);
    try {
      await app.models.profiles.beginLifecycle({
        id: 'mock-startup-archive',
        bot: profile.id,
        action: 'archive',
        revision: 1,
      });
    } finally {
      release();
    }
    await app.close();
    app = await startPrototype(options);
    assert.ok(app.lifecycle && app.models && app.schedules);
    const receipt = await app.lifecycle.receipt(profile.id, 'mock-startup-archive');
    assert.equal(receipt.receipt.phase, 'complete');
    assert.equal(receipt.profile.revision, 3);
    assert.equal((await app.schedules.get('mock-startup-plan')).enabled, false);
    assert.equal((await app.schedules.get('mock-startup-plan')).history.length, 0);
    assert.equal(app.models.jobs.size, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

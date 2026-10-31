import assert from 'node:assert/strict';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  isRecoveryReceipt,
  isRecoveryReview,
  type RecoveryReceipt,
  type RecoveryRequest,
} from '@daban/protocol';
import { errorCode } from './control.js';
import { startPrototype } from './server.js';

const configuredRoot = process.env.RECOVERY_ACCEPTANCE_ROOT;
assert.ok(configuredRoot && path.isAbsolute(configuredRoot));
const root = configuredRoot;
await mkdir(root, { recursive: true, mode: 0o700 });
const app = await startPrototype({
  profileDir: path.join(root, 'profile'),
  port: 8766,
  computers: { dir: path.join(root, 'desktops'), limit: 2, displayBase: 11 },
});
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  try {
    await app.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
};
process.once('SIGTERM', () => {
  close().catch(() => process.exit(1));
});
process.once('SIGINT', () => {
  close().catch(() => process.exit(1));
});
async function api(route: string, data?: unknown) {
  const response = await fetch(app.url + route, {
    method: data === undefined ? 'GET' : 'POST',
    headers: {
      'x-prototype-token': app.token,
      ...(data === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  return { status: response.status, value: await response.json() };
}
async function save(name: string, value: unknown) {
  const destination = path.join(root, name),
    temporary = `${destination}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, destination);
}
const ids = ['mock-recovery-alpha', 'mock-recovery-beta'];
const marker = (bot: string) => `SYNTHETIC-FILE-${bot}`;
const filename = (bot: string) => path.join(root, 'desktops/shared', `${bot}.txt`);
interface Checkpoint {
  request: RecoveryRequest;
  claimed: RecoveryReceipt;
  instances: Record<string, string>;
  epochs: Record<string, number>;
}
const checkpointFile = path.join(root, 'seed.json');
const checkpoint = await readFile(checkpointFile, 'utf8').then(
  (text) => JSON.parse(text) as Checkpoint,
  (error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  },
);
const completed = await readFile(path.join(root, 'verified.json'), 'utf8').then(
  (text) => JSON.parse(text) as { verified?: boolean },
  (error: unknown) => {
    if (errorCode(error) === 'ENOENT') return undefined;
    throw error;
  },
);
assert.ok(app.models && app.recovery);
if (completed?.verified) {
  console.log('SYNTHETIC_RECOVERY_ALREADY_VERIFIED_NO_REPLAY');
} else if (!checkpoint) {
  for (const bot of ids)
    await app.models.profiles.register({
      id: bot,
      name: `合成${bot}`,
      instructions: '只使用合成数据。',
      memory: `SYNTHETIC-MEMORY-${bot}`,
      color: bot === ids[0] ? 'mint' : 'violet',
    });
  const instances: Record<string, string> = {},
    epochs: Record<string, number> = {};
  for (const bot of ids) {
    const response = await api('/api/computers/action', {
      id: `mock-connect-${bot}`,
      bot,
      action: 'connect',
      revision: 0,
    });
    assert.equal(response.status, 200);
    assert.equal(response.value.state.phase, 'connected');
    instances[bot] = response.value.state.instance as string;
    const lease = await app.runtime.transfer(
      bot,
      app.runtime.control.state(bot).epoch,
      'human',
      instances[bot],
    );
    epochs[bot] = lease.epoch;
    await app.runtime.openApp(bot, lease.epoch, 'terminal', instances[bot]);
    await app.runtime.input(
      bot,
      lease.epoch,
      { type: 'text', text: `printf '%s' '${marker(bot)}' > '${filename(bot)}'` },
      instances[bot],
    );
    await app.runtime.input(bot, lease.epoch, { type: 'key', key: 'Enter' }, instances[bot]);
    let content = '';
    for (let i = 0; i < 50; i++) {
      content = await readFile(filename(bot), 'utf8').catch(() => '');
      if (content === marker(bot)) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(content, marker(bot));
  }
  assert.notEqual(instances[ids[0]], instances[ids[1]]);
  const browser = app.runtime.browserFor(ids[0]);
  for (const bot of ids)
    await browser.tabs!.navigate(
      bot,
      'human',
      epochs[bot],
      `${app.url}/fixture/page?bot=${bot}`,
      new AbortController().signal,
      `mock-page-${bot}`,
    );
  await browser.act(ids[0], 'human', epochs[ids[0]], (page) => page.locator('#login').click());
  await browser
    .page(ids[1])
    .waitForFunction(() => document.querySelector('#identity')?.textContent === '示例用户');
  await browser.page(ids[0]).locator('#note').fill('SYNTHETIC-A-INDEPENDENT');
  await browser.page(ids[1]).locator('#note').fill('SYNTHETIC-B-INDEPENDENT');
  for (const bot of ids) {
    await app.runtime.openApp(bot, epochs[bot], 'browser', instances[bot]);
    await writeFile(
      path.join(root, `${bot}-before.jpg`),
      await app.runtime.frame(bot, instances[bot], epochs[bot]),
      { mode: 0o600 },
    );
  }
  const review = (await api('/api/recovery/review')).value;
  assert.ok(isRecoveryReview(review));
  assert.equal(review.screens.length, 2);
  assert.ok(review.screens.every((row) => row.lease?.owner === 'human'));
  const request: RecoveryRequest = {
    id: 'mock-whole-vm-recovery',
    revision: review.revision,
    review: review.digest,
    confirmation: 'restart-all-apps',
  };
  const prepared = (await api('/api/recovery/prepare', request)).value;
  assert.ok(isRecoveryReceipt(prepared));
  assert.equal(prepared.phase, 'prepared');
  const release = await api(`/api/bots/${ids[0]}/input`, {
    epoch: epochs[ids[0]],
    instance: instances[ids[0]],
    input: { type: 'release' },
  });
  assert.equal(release.status, 200);
  assert.equal(
    (await api('/api/computers/receipt', { id: `mock-connect-${ids[0]}`, bot: ids[0] })).status,
    200,
  );
  assert.equal(
    (await api('/api/files/read', { path: `${ids[0]}.txt` })).value.content,
    marker(ids[0]),
  );
  const blocked = await api(`/api/bots/${ids[0]}/input`, {
    epoch: epochs[ids[0]],
    instance: instances[ids[0]],
    input: { type: 'text', text: 'SYNTHETIC-NEVER-TYPE' },
  });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.value.error, 'RUNTIME_RECOVERY_PENDING');
  const claimed = (
    await api('/api/recovery/claim', { id: request.id, revision: prepared.revision })
  ).value;
  assert.ok(isRecoveryReceipt(claimed));
  assert.equal(claimed.phase, 'claimed');
  await save('seed.json', { request, claimed, instances, epochs } satisfies Checkpoint);
  console.log('SYNTHETIC_RECOVERY_SEED_READY');
} else {
  const current = app.recovery.receipt(checkpoint.request.id);
  if (current.phase !== 'complete') {
    assert.equal(current.phase, 'claimed');
    assert.equal(app.recovery.admit(), false);
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    assert.equal(boot, checkpoint.claimed.review.boot);
    await save('same-boot.json', { verified: true, phase: current.phase, admission: false, boot });
    console.log('SYNTHETIC_SAME_BOOT_FENCED');
  } else {
    const prior = JSON.parse(await readFile(path.join(root, 'same-boot.json'), 'utf8'));
    assert.equal(prior.verified, true);
    assert.equal(prior.admission, false);
    assert.equal(prior.boot, checkpoint.claimed.review.boot);
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    assert.equal(current.boot, boot);
    assert.notEqual(current.boot, checkpoint.claimed.review.boot);
    assert.notEqual(current.instance, checkpoint.claimed.review.instance);
    assert.equal(app.runtime.status().items.filter((row) => row.reserved).length, 0);
    for (const bot of ids) {
      assert.equal(await readFile(filename(bot), 'utf8'), marker(bot));
      assert.equal((await app.models.profiles.get(bot))?.memory, `SYNTHETIC-MEMORY-${bot}`);
      const state = app.runtime.status().items.find((row) => row.bot === bot)!;
      const next = await app.runtime.operate({
        id: `mock-reconnect-${bot}`,
        bot,
        action: 'connect',
        revision: state.revision,
      });
      assert.equal(next.state.phase, 'connected');
      assert.notEqual(next.state.instance, checkpoint.instances[bot]);
      const lease = await app.runtime.transfer(
        bot,
        app.runtime.control.state(bot).epoch,
        'human',
        next.state.instance,
      );
      await assert.rejects(
        app.runtime.input(
          bot,
          lease.epoch,
          { type: 'text', text: 'SYNTHETIC-OLD-SCREEN' },
          checkpoint.instances[bot],
        ),
        { code: 'DESKTOP_VIEW_STALE' },
      );
    }
    const browser = app.runtime.browserFor(ids[0]);
    assert.equal(
      (await browser.context.cookies()).find((cookie) => cookie.name === 'demo_session')?.value,
      'synthetic-user',
    );
    for (const bot of ids) {
      const epoch = app.runtime.control.state(bot).epoch;
      await browser.tabs!.navigate(
        bot,
        'human',
        epoch,
        `${app.url}/fixture/page?bot=${bot}`,
        new AbortController().signal,
        `mock-new-page-${bot}`,
      );
      await browser
        .page(bot)
        .waitForFunction(() => document.querySelector('#identity')?.textContent === '示例用户');
      await app.runtime.openApp(bot, epoch, 'browser', app.runtime.state(bot).instance);
      await writeFile(
        path.join(root, `${bot}-after.jpg`),
        await app.runtime.frame(bot, app.runtime.state(bot).instance, epoch),
        { mode: 0o600 },
      );
    }
    const count = app.runtime.status().items.filter((row) => row.reserved).length;
    const old = await api('/api/recovery/prepare', checkpoint.request);
    assert.equal(old.value.phase, 'complete');
    assert.equal(app.runtime.status().items.filter((row) => row.reserved).length, count);
    assert.equal(
      Object.values(app.models.status().bots).some((row) => row.running || row.runId),
      false,
    );
    await save('verified.json', {
      verified: true,
      scope:
        'Real isolated Linux whole-kernel reboot through the durable recovery API; manual test driver, not product host orchestration',
      sameBootFenced: true,
      newKernelProved: true,
      oldReceiptsReadOnly: true,
      twoScreensReconnected: true,
      oldInstancesRejected: true,
      sharedSyntheticLoginRetained: true,
      filesAndMemoryRetained: true,
      noAutomaticComputerReconnect: true,
      paidModelTaskTurns: 0,
    });
    console.log('SYNTHETIC_WHOLE_VM_RECOVERY_VERIFIED');
  }
}

import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startNativeAgent } from '@daban/engine/agent';
import { expect, test } from 'vitest';
import { resolveSdk } from './sdk.js';

test('real host calendar recovers an accepted archive and preserves schedules and other Bots after restart', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-host-calendar-'));
  const root = path.join(temporary, 'private');
  const scope = createHash('sha256').update(root).digest('hex');
  const options = {
    dataRoot: root,
    nativeWorkspace: path.join(root, 'workspace'),
    socketPath:
      process.platform === 'win32'
        ? String.raw`\\.\pipe\daban-agent-${scope.slice(0, 24)}`
        : path.join(root, 'a.sock'),
    scope,
    sdkFile: resolveSdk(),
  };
  let agent: Awaited<ReturnType<typeof startNativeAgent>> | undefined;
  t.onTestFinished(async () => {
    await agent?.close();
    await rm(temporary, { recursive: true, force: true });
  });
  agent = await startNativeAgent(options);
  const store = agent.models.tools.schedules?.store;
  expect.assert(store, 'the real SDK calendar must be available on every host platform');
  for (const id of ['mock-alpha', 'mock-beta'])
    await agent.models.profiles.register({
      id,
      name: id,
      instructions: '',
      memory: 'SYNTHETIC MEMORY',
      color: 'mint',
    });
  const other = await agent.models.profiles.get('mock-beta');
  await store.create({
    id: 'mock-owned-schedule',
    bot: 'mock-alpha',
    title: 'Synthetic timer',
    prompt: 'SYNTHETIC ONLY',
    rule: { kind: 'every', everySeconds: 3600 },
    enabled: false,
  });
  const release = agent.models.profiles.reserveLifecycle('mock-alpha');
  await agent.models.profiles.beginLifecycle({
    id: 'mock-accepted-archive',
    bot: 'mock-alpha',
    action: 'archive',
    revision: 1,
  });
  release();
  await agent.close();
  agent = undefined;
  agent = await startNativeAgent(options);
  const recovered = await agent.models.profiles.get('mock-alpha');
  expect(recovered?.lifecycle?.id).toBe('mock-accepted-archive');
  expect(recovered?.lifecycle?.phase).toBe('complete');
  expect(recovered?.memory).toBe('SYNTHETIC MEMORY');
  expect(await agent.models.profiles.get('mock-beta')).toStrictEqual(other);
  const retained = await agent.models.tools.schedules!.store.list();
  expect(retained.length).toBe(1);
  expect(retained[0].enabled).toBe(false);
});

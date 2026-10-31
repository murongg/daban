import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { type BotBundle, botBundleText } from '@daban/protocol';
import { startPrototype } from './server.js';

test('authenticated Bot bundle HTTP creates once, clones no model routes, and preserves settings on replay', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-bundles-http-'));
  const app = await startPrototype({
    port: 0,
    profileDir: path.join(root, 'profile'),
    computers: true,
  });
  const bundle: BotBundle = {
    format: 'daban.bot',
    version: 1,
    profile: { name: '合成导入助手', instructions: 'SYNTHETIC', color: 'mint' },
    preferences: 'SYNTHETIC PREF',
    skills: [],
    knowledge: [{ path: 'mock.md', content: 'SYNTHETIC DOCUMENT' }],
  };
  const text = botBundleText(bundle),
    header = {
      id: 'mock-http-import',
      sha256: createHash('sha256').update(text).digest('hex'),
      size: Buffer.byteLength(text),
    };
  const call = async (route: string, data?: unknown, auth = true) =>
    fetch(`${app.url}${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(auth ? { 'x-prototype-token': app.token } : {}),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
  try {
    const settings = await (await call('/api/model/settings')).json();
    assert.equal((await call('/api/bundles/begin', header, false)).status, 403);
    const begun = await (await call('/api/bundles/begin', header)).json();
    assert.equal(begun.state, 'awaiting', JSON.stringify(begun));
    assert.equal(
      (await (await call(`/api/bundles/submit/${header.id}`, bundle)).json()).state,
      'validating',
    );
    await app.models!.bundles.settled;
    const receipt = await (await call(`/api/bundles/status/${header.id}`)).json();
    assert.equal(receipt.state, 'complete');
    const profiles = await (await call('/api/bots')).json();
    assert.equal(profiles.length, 1);
    assert.equal(receipt.profile.model, undefined);
    const exportRequest = {
      bot: receipt.profile.id,
      revision: 1,
      memory: true,
      skills: [],
      knowledge: (await app.models!.knowledge.list(receipt.profile.id)).map((doc) => ({
        id: doc.id,
        revision: doc.revision,
      })),
    };
    const exported = await (await call('/api/bundles/export', exportRequest)).json();
    assert.equal(exported.preferences, bundle.preferences);
    assert.deepEqual(exported.knowledge, bundle.knowledge);
    assert.equal(
      (await (await call('/api/bundles/begin', header)).json()).profile.id,
      receipt.profile.id,
    );
    assert.deepEqual(await (await call('/api/model/settings')).json(), settings);
    const unsafe = JSON.stringify({
      id: 'mock-http-import',
      bundle: { nested: Array.from({ length: 1000 }, () => ({})) },
    });
    const oversizedGraph = await fetch(`${app.url}/api/bundles/submit/${header.id}`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: unsafe,
    });
    assert.equal(oversizedGraph.status, 400);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

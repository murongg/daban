import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { BrowserProfiles } from './browser-profiles.js';
import { Control } from './control.js';
import { createBrowser } from './runtime.js';

test('synthetic persistent profiles isolate private cookies, explicitly share project cookies, and retain legacy identity without navigation replay', {
  timeout: 90000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-project-browser-'));
  let visits = 0;
  const server = createServer((_request, response) => {
    visits++;
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>SYNTHETIC SITE</title><p>synthetic account</p>');
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const control = new Control(['mock-a', 'mock-b']);
  const profiles = new BrowserProfiles((id, lease) =>
    createBrowser({ profileDir: path.join(root, id), origin, bots: [], control: lease, proxy: {} }),
  );
  try {
    const legacy = await profiles.acquire('legacy', 'mock-a', control);
    await legacy.context.addCookies([
      { name: 'synthetic-login', value: 'LEGACY', url: origin, expires: 4102444800 },
    ]);
    await legacy.page('mock-a').goto(origin);
    await profiles.release('legacy', 'mock-a');
    const first = await profiles.acquire('private-a', 'mock-a', control);
    assert.equal((await first.context.cookies(origin)).length, 0);
    await first.context.addCookies([
      { name: 'synthetic-login', value: 'PRIVATE-A', url: origin, expires: 4102444800 },
    ]);
    const second = await profiles.acquire('private-b', 'mock-b', control);
    assert.equal((await second.context.cookies(origin)).length, 0);
    assert.notEqual(first.context, second.context);
    await profiles.release('private-a', 'mock-a');
    await profiles.release('private-b', 'mock-b');
    const sharedA = await profiles.acquire('shared', 'mock-a', control);
    await sharedA.context.addCookies([
      { name: 'synthetic-login', value: 'PROJECT', url: origin, expires: 4102444800 },
    ]);
    const sharedB = await profiles.acquire('shared', 'mock-b', control);
    assert.equal(sharedA, sharedB);
    assert.equal((await sharedB.context.cookies(origin))[0]?.value, 'PROJECT');
    assert.notEqual(sharedA.page('mock-a'), sharedB.page('mock-b'));
    assert.throws(() => sharedB.tabs!.assertBinding('mock-b', sharedA.tabs!.binding('mock-a')));
    await profiles.release('shared', 'mock-a');
    await profiles.release('shared', 'mock-b');
    const before = visits;
    const restored = await profiles.acquire('legacy', 'mock-a', control);
    assert.equal((await restored.context.cookies(origin))[0]?.value, 'LEGACY');
    assert.equal(visits, before);
    assert.equal(restored.page('mock-a').url(), 'about:blank');
  } finally {
    await profiles.close();
    await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
    await rm(root, { recursive: true, force: true });
  }
});

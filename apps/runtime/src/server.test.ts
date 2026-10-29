import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Fault } from './control.js';
import { Screens } from './desktop.js';
import { ModelRuns } from './model.js';
import { startPrototype } from './server.js';

test('a failed optional desktop leaves ordinary Agent stores and HTTP tools available without graphical authority', {
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-computer-unavailable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(Screens.prototype, 'start', async () => {
    throw new Fault('SYNTHETIC_PRIVATE_GUI_FAILURE', 503, '/private/synthetic-config');
  });
  const closeScreens = Screens.prototype.close;
  let cleaned = 0;
  t.mock.method(Screens.prototype, 'close', async function (this: Screens) {
    cleaned++;
    await closeScreens.call(this);
  });
  const directory = path.join(root, 'custom-desktops'),
    workspace = path.join(directory, 'shared');
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, 'existing.txt'), 'SYNTHETIC-EXISTING-47');
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    desktop: { dir: directory },
  });
  t.after(() => app.close());
  const call = async (route: string, data?: unknown, authorized = true) => {
    const response = await fetch(`${app.url}${route}`, {
      method: data === undefined ? 'GET' : 'POST',
      headers: {
        ...(authorized ? { 'x-prototype-token': app.token } : {}),
        ...(data === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  const state = await call('/api/state');
  assert.equal(state.status, 200);
  assert.equal(state.value.clientProtocol, 18);
  assert.equal(state.value.mode, 'agent');
  assert.equal(state.value.computerError, 'COMPUTER_START_FAILED');
  assert.deepEqual(state.value.bots, {});
  assert.equal(state.value.sharedLogin, false);
  assert.ok(!JSON.stringify(state.value).includes('SYNTHETIC_PRIVATE_GUI_FAILURE'));
  assert.ok(!JSON.stringify(state.value).includes('/private/synthetic-config'));
  assert.equal(cleaned, process.platform === 'linux' ? 1 : 0);
  assert.throws(() => app.runtime, { code: 'COMPUTER_NOT_CONNECTED' });
  assert.ok(app.models);
  const names = app.models.tools.list('mock-headless').map((tool) => tool.name);
  assert.ok(names.includes('read_file'));
  for (const name of ['screenshot', 'act', 'open_app', 'browser_navigate'])
    assert.ok(!names.includes(name));
  const profile = {
    id: 'mock-headless',
    name: '合成普通 Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  };
  assert.equal((await call('/api/bots', profile)).value.id, profile.id);
  assert.equal((await call('/api/bots')).value.length, 1);
  assert.equal((await call('/api/model/settings')).status, 200);
  const file = await call('/api/files/read', { path: 'existing.txt' });
  assert.equal(file.value.content, 'SYNTHETIC-EXISTING-47');
  assert.equal(
    await readFile(path.join(workspace, 'existing.txt'), 'utf8'),
    'SYNTHETIC-EXISTING-47',
  );
  assert.equal(state.value.knowledge.available, true);
  assert.equal(state.value.groups.available, true);
  // The host may lack DSH's schedule domain; Linux acceptance verifies that dependency independently of graphics.
  assert.ok(app.schedules);
  assert.equal(typeof state.value.schedules.available, 'boolean');
  assert.ok(Array.isArray(state.value.schedules.items));
  assert.equal((await call('/api/state', undefined, false)).status, 403);
  for (const [route, input] of [
    ['/api/bots/a/frame', undefined],
    ['/api/bots/a/browser-view', undefined],
    ['/api/bots/a/input', { epoch: 0, input: { type: 'text', text: 'NEVER-TYPE' } }],
    ['/api/bots/a/control', { epoch: 0, owner: 'human' }],
    ['/api/bots/a/app', { epoch: 0, app: 'terminal' }],
  ] as const) {
    const result = await call(route, input);
    assert.equal(result.status, 503);
    assert.equal(result.value.error, 'COMPUTER_NOT_CONNECTED');
  }
  await assert.rejects(app.models.start(profile.id), { code: 'COMPUTER_NOT_CONNECTED' });
});

test('a failed ordinary-service initialization closes its stores and HTTP listener after graphical failure', {
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-agent-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(Screens.prototype, 'start', async () => {
    throw new Error('synthetic GUI failure');
  });
  const closeModels = ModelRuns.prototype.close;
  let closed = 0;
  t.mock.method(ModelRuns.prototype, 'close', async function (this: ModelRuns) {
    closed++;
    await closeModels.call(this);
  });
  await mkdir(path.join(root, 'model'), { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, 'model/task-journal'), 'SYNTHETIC-NOT-A-DIRECTORY');
  const listener = createServer();
  await new Promise<unknown>((resolve) =>
    listener.listen(0, '127.0.0.1', () => resolve(undefined)),
  );
  const address = listener.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<unknown>((resolve) => listener.close(() => resolve(undefined)));
  await assert.rejects(
    startPrototype({ profileDir: path.join(root, 'profile'), port: address.port, desktop: true }),
    { code: 'EEXIST' },
  );
  assert.equal(closed, 1);
  await assert.rejects(fetch(`http://127.0.0.1:${address.port}/`));
});

test('public bootstrap never publishes the control capability and authenticated diagnostics still work', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-private-bootstrap-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(Screens.prototype, 'start', async () => {
    throw new Fault('SYNTHETIC_GUI_FAILURE');
  });
  const app = await startPrototype({
    profileDir: path.join(directory, 'profile'),
    port: 0,
    desktop: true,
  });
  t.after(() => app.close());
  const publicReply = await fetch(app.url);
  const publicText = await publicReply.text();
  assert.ok(!publicText.includes(app.token));
  assert.ok(!publicText.includes('prototype-token'));
  assert.deepEqual(JSON.parse(publicText), { service: 'daban', authentication: 'ssh-file' });
  const diagnostic = await fetch(app.url, { headers: { 'x-prototype-token': app.token } });
  assert.ok((await diagnostic.text()).includes(app.token));
  assert.equal(
    (await readFile(path.join(directory, 'model/control-token'), 'utf8')).trim(),
    app.token,
  );
});

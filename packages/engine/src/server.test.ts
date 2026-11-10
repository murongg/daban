import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { Fault } from './control.js';
import { Screens } from './desktop.js';
import { ModelRuns } from './model.js';
import { startPrototype } from './server.js';

test('a failed optional desktop leaves ordinary Agent stores and HTTP tools available without graphical authority', {
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-computer-unavailable-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  vi.spyOn(Screens.prototype, 'start').mockImplementation(async () => {
    throw new Fault('SYNTHETIC_PRIVATE_GUI_FAILURE', 503, '/private/synthetic-config');
  });
  const closeScreens = Screens.prototype.close;
  let cleaned = 0;
  vi.spyOn(Screens.prototype, 'close').mockImplementation(async function (this: Screens) {
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
  t.onTestFinished(async () => {
    await app.close();
  });
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
  expect(state.status).toBe(200);
  expect(state.value.clientProtocol).toBe(18);
  expect(state.value.mode).toBe('agent');
  expect(state.value.computerError).toBe('COMPUTER_START_FAILED');
  expect(state.value.bots).toStrictEqual({});
  expect(state.value.sharedLogin).toBe(false);
  expect(state.value.jinaReader).toBe(false);
  expect((await call('/api/web/jina', { enabled: true }, false)).status).toBe(403);
  expect((await call('/api/web/jina', { enabled: 'true' })).status).toBe(400);
  expect((await call('/api/web/jina', { enabled: true })).value).toBe(true);
  expect((await call('/api/state')).value.jinaReader).toBe(true);
  expect((await call('/api/web/jina', { enabled: false })).value).toBe(false);
  expect((await call('/api/state')).value.jinaReader).toBe(false);
  expect.assert(!JSON.stringify(state.value).includes('SYNTHETIC_PRIVATE_GUI_FAILURE'));
  expect.assert(!JSON.stringify(state.value).includes('/private/synthetic-config'));
  expect(cleaned).toBe(process.platform === 'linux' ? 1 : 0);
  expect(() => app.runtime).toThrowError(
    expect.objectContaining({ code: 'COMPUTER_NOT_CONNECTED' }),
  );
  expect.assert(app.models);
  const names = app.models.tools.list('mock-headless').map((tool) => tool.name);
  expect.assert(names.includes('read_file'));
  for (const name of ['screenshot', 'act', 'open_app', 'browser_navigate'])
    expect.assert(!names.includes(name));
  const profile = {
    id: 'mock-headless',
    name: '合成普通 Bot',
    instructions: '',
    memory: '',
    color: 'mint',
  };
  expect((await call('/api/bots', profile)).value.id).toBe(profile.id);
  expect((await call('/api/bots')).value.length).toBe(1);
  expect((await call('/api/model/settings')).status).toBe(200);
  const file = await call('/api/files/read', { path: 'existing.txt' });
  expect(file.value.content).toBe('SYNTHETIC-EXISTING-47');
  expect(await readFile(path.join(workspace, 'existing.txt'), 'utf8')).toBe(
    'SYNTHETIC-EXISTING-47',
  );
  expect(state.value.knowledge.available).toBe(true);
  expect(state.value.groups.available).toBe(true);
  // The host may lack DSH's schedule domain; Linux acceptance verifies that dependency independently of graphics.
  expect.assert(app.schedules);
  expect(typeof state.value.schedules.available).toBe('boolean');
  expect.assert(Array.isArray(state.value.schedules.items));
  expect((await call('/api/state', undefined, false)).status).toBe(403);
  for (const [route, input] of [
    ['/api/bots/a/frame', undefined],
    ['/api/bots/a/browser-view', undefined],
    ['/api/bots/a/input', { epoch: 0, input: { type: 'text', text: 'NEVER-TYPE' } }],
    ['/api/bots/a/control', { epoch: 0, owner: 'human' }],
    ['/api/bots/a/app', { epoch: 0, app: 'terminal' }],
  ] as const) {
    const result = await call(route, input);
    expect(result.status).toBe(503);
    expect(result.value.error).toBe('COMPUTER_NOT_CONNECTED');
  }
  await expect(app.models.start(profile.id)).rejects.toMatchObject({
    code: 'COMPUTER_NOT_CONNECTED',
  });
});

test('a failed ordinary-service initialization closes its stores and HTTP listener after graphical failure', {
  timeout: 10000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-agent-startup-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  vi.spyOn(Screens.prototype, 'start').mockImplementation(async () => {
    throw new Error('synthetic GUI failure');
  });
  const closeModels = ModelRuns.prototype.close;
  let closed = 0;
  vi.spyOn(ModelRuns.prototype, 'close').mockImplementation(async function (this: ModelRuns) {
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
  expect.assert(address && typeof address !== 'string');
  await new Promise<unknown>((resolve) => listener.close(() => resolve(undefined)));
  await expect(
    startPrototype({ profileDir: path.join(root, 'profile'), port: address.port, desktop: true }),
  ).rejects.toMatchObject({ code: 'EEXIST' });
  expect(closed).toBe(1);
  await expect(fetch(`http://127.0.0.1:${address.port}/`)).rejects.toThrowError();
});

test('public bootstrap never publishes the control capability and authenticated diagnostics still work', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-private-bootstrap-'));
  t.onTestFinished(() => rm(directory, { recursive: true, force: true }));
  vi.spyOn(Screens.prototype, 'start').mockImplementation(async () => {
    throw new Fault('SYNTHETIC_GUI_FAILURE');
  });
  const app = await startPrototype({
    profileDir: path.join(directory, 'profile'),
    port: 0,
    desktop: true,
  });
  t.onTestFinished(async () => {
    await app.close();
  });
  const publicReply = await fetch(app.url);
  const publicText = await publicReply.text();
  expect.assert(!publicText.includes(app.token));
  expect.assert(!publicText.includes('prototype-token'));
  expect(JSON.parse(publicText)).toStrictEqual({ service: 'daban', authentication: 'ssh-file' });
  const diagnostic = await fetch(app.url, { headers: { 'x-prototype-token': app.token } });
  expect.assert((await diagnostic.text()).includes(app.token));
  expect((await readFile(path.join(directory, 'model/control-token'), 'utf8')).trim()).toBe(
    app.token,
  );
});

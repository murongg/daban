import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ComputerTools, type ToolRun } from './computer-tools.js';
import { startPrototype } from './server.js';

test('native computer tools retain a working shared desktop without service files, process environment or global control authority', {
  skip: process.platform !== 'linux',
  timeout: 90000,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-desktop-boundary-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secret = path.join(directory, 'private/synthetic-secret');
  await mkdir(path.dirname(secret), { mode: 0o700 });
  await writeFile(secret, 'SYNTHETIC-PRIVATE-47', { mode: 0o600 });
  const previous = process.env.DABAN_SYNTHETIC_PRIVATE;
  process.env.DABAN_SYNTHETIC_PRIVATE = 'SYNTHETIC-ENV-53';
  t.after(() => {
    if (previous === undefined) delete process.env.DABAN_SYNTHETIC_PRIVATE;
    else process.env.DABAN_SYNTHETIC_PRIVATE = previous;
  });
  const app = await startPrototype({
    profileDir: path.join(directory, 'profile'),
    port: 0,
    computers: { displayBase: 151, limit: 2 },
  });
  t.after(() => app.close());
  assert.ok(app.models);
  for (const bot of ['mock-boundary-a', 'mock-boundary-b']) {
    await app.models.profiles.register({
      id: bot,
      name: '合成隔离测试',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const result = await app.runtime.operate({
      id: `mock-connect-${bot}`,
      bot,
      action: 'connect',
      revision: 0,
    });
    assert.equal(result.state.phase, 'connected');
  }
  const resultFile = path.join(directory, 'desktops/shared/proof.json');
  const script = `python3 - <<'PY'
import json,os,pathlib,urllib.request
secret=${JSON.stringify(secret)}
def readable(p):
 try: pathlib.Path(p).read_bytes(); return True
 except OSError: return False
out={'private':readable(secret),'environment':bool(os.getenv('DABAN_SYNTHETIC_PRIVATE')),'serviceProcess':readable('/proc/${process.pid}/environ'),'inheritedDirectory':False}
for fd in range(3,12):
 try:
  f=os.open('../private/synthetic-secret',os.O_RDONLY,dir_fd=fd); os.close(f); out['inheritedDirectory']=True
 except OSError: pass
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
out['publicToken']='prototype-token' in op.open(${JSON.stringify(app.url)}).read().decode()
pathlib.Path(${JSON.stringify(resultFile)}).write_text(json.dumps(out))
PY`;
  assert.ok(script.length <= 2000);
  const tools = new ComputerTools(app.runtime.facade);
  const run: ToolRun = {
    bot: 'mock-boundary-a',
    abort: new AbortController(),
    toolCount: 0,
    limit: 8,
    seen: {},
    trace: [],
  };
  for (const [name, args] of [
    ['screenshot', { surface: 'desktop' }],
    ['open_app', { app: 'terminal' }],
    [
      'act',
      {
        surface: 'desktop',
        actions: [
          { type: 'text', text: script },
          { type: 'key', key: 'Enter' },
        ],
      },
    ],
  ] as const)
    assert.equal((await tools.invoke(run, name, args)).isError, undefined);
  let proof: unknown;
  for (let attempt = 0; attempt < 100; attempt++) {
    proof = await readFile(resultFile, 'utf8').then(
      (text) => JSON.parse(text) as unknown,
      () => undefined,
    );
    if (proof) break;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  assert.deepEqual(proof, {
    private: false,
    environment: false,
    serviceProcess: false,
    inheritedDirectory: false,
    publicToken: false,
  });
  const viewer = (
    await readFile(path.join(directory, 'desktops/mock-boundary-a/viewer-token'), 'utf8')
  ).trim();
  assert.notEqual(viewer, app.token);
  const denied = await fetch(`${app.url}/api/state`, { headers: { 'x-prototype-token': viewer } });
  assert.equal(denied.status, 403);
  const capability = { 'x-prototype-token': viewer };
  const view = await fetch(`${app.url}/viewer/mock-boundary-a`, { headers: capability });
  assert.equal(view.status, 200);
  const own = await view.json();
  assert.deepEqual(Object.keys(own).sort(), ['lease', 'view']);
  assert.equal(own.view.bot, 'mock-boundary-a');
  assert.equal(
    (await fetch(`${app.url}/viewer/mock-boundary-b`, { headers: capability })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${app.url}/api/bots/mock-boundary-b/control`, {
        method: 'POST',
        headers: { ...capability, 'content-type': 'application/json' },
        body: JSON.stringify({ epoch: 0, owner: 'human' }),
      })
    ).status,
    403,
  );
  assert.equal(app.runtime.control.state('mock-boundary-b').owner, 'agent');
  const row = app.runtime.status().items.find((item) => item.bot === 'mock-boundary-a')!;
  const stopped = await app.runtime.operate({
    id: 'mock-retire-viewer',
    bot: row.bot,
    action: 'stop',
    revision: row.revision,
    instance: row.instance,
    confirmation: 'close-apps',
  });
  assert.equal(stopped.state.phase, 'disconnected');
  assert.equal(
    (await fetch(`${app.url}/viewer/mock-boundary-a`, { headers: capability })).status,
    403,
  );
  const reconnected = await app.runtime.operate({
    id: 'mock-replace-viewer',
    bot: row.bot,
    action: 'connect',
    revision: stopped.state.revision,
  });
  assert.equal(reconnected.state.phase, 'connected');
  assert.equal(
    (await fetch(`${app.url}/viewer/mock-boundary-a`, { headers: capability })).status,
    403,
  );
  assert.notEqual(
    (await readFile(path.join(directory, 'desktops/mock-boundary-a/viewer-token'), 'utf8')).trim(),
    viewer,
  );
});

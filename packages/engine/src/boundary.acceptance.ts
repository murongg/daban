import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ComputerTools, type ToolRun } from './computer-tools.js';
import { Computers } from './computers.js';
import { startPrototype } from './server.js';

// Manual observation on the disposable VM only; a successful observation is not a security pass.
const root = process.env.BOUNDARY_ACCEPTANCE_ROOT;
assert.equal(process.platform, 'linux');
assert.equal(process.env.BOUNDARY_ACCEPTANCE_VM, 'disposable-recovery');
assert.ok(root);
assert.ok(root.startsWith('/var/lib/bot-prototype/isolation-'));
const output = process.argv[2];
assert.ok(output && path.isAbsolute(output));
await mkdir(root, { recursive: true, mode: 0o700 });
const app = await startPrototype({
  profileDir: path.join(root, 'profile'),
  port: 0,
  computers: { dir: path.join(root, 'desktops'), displayBase: 121, limit: 2 },
});
try {
  assert.ok(app.runtime instanceof Computers && app.models);
  for (const bot of ['mock-boundary-a', 'mock-boundary-b']) {
    await app.models.profiles.register({
      id: bot,
      name: '合成边界验证',
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
  const privateDirectory = path.join(root, 'private');
  await mkdir(privateDirectory, { mode: 0o700 });
  const secret = path.join(privateDirectory, 'synthetic-service-secret');
  const marker = `SYNTHETIC-PRIVATE-${randomUUID()}`;
  await writeFile(secret, marker, { mode: 0o600 });
  const resultFile = path.join(root, 'desktops/shared/boundary-proof.json');
  const command = `python3 - <<'PY'
import json,pathlib,re,urllib.request
origin=${JSON.stringify(app.url)}
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
html=op.open(origin+'/').read().decode()
found=re.search(r'name="prototype-token" content="([a-zA-Z0-9_-]+)"',html)
try: private=pathlib.Path(${JSON.stringify(secret)}).read_text()==${JSON.stringify(marker)}
except OSError: private=False
out={'privateFileReadable':private,'unauthenticatedGlobalTokenAvailable':bool(found),'otherBotControlChanged':False}
if found:
 token=found.group(1)
 state=json.load(op.open(urllib.request.Request(origin+'/api/state',headers={'x-prototype-token':token})))
 target=state['bots']['mock-boundary-b']
 data=json.dumps({'epoch':target['epoch'],'instance':target['instance'],'owner':'human'}).encode()
 req=urllib.request.Request(origin+'/api/bots/mock-boundary-b/control',data=data,headers={'x-prototype-token':token,'content-type':'application/json'})
 out['otherBotControlChanged']=json.load(op.open(req))['owner']=='human'
pathlib.Path(${JSON.stringify(resultFile)}).write_text(json.dumps(out))
PY`;
  assert.ok(command.length <= 2000);
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
          { type: 'text', text: command },
          { type: 'key', key: 'Enter' },
        ],
      },
    ],
  ] as const) {
    const result = await tools.invoke(run, name, args);
    assert.equal(
      result.isError,
      undefined,
      result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n'),
    );
  }
  let observed: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    observed = await readFile(resultFile, 'utf8').then(
      (text) => JSON.parse(text) as Record<string, unknown>,
      () => undefined,
    );
    if (observed) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  assert.ok(observed);
  assert.deepEqual(Object.keys(observed).sort(), [
    'otherBotControlChanged',
    'privateFileReadable',
    'unauthenticatedGlobalTokenAvailable',
  ]);
  assert.ok(Object.values(observed).every((value) => typeof value === 'boolean'));
  assert.equal(app.runtime.control.state('mock-boundary-a').owner, 'agent');
  await writeFile(
    output,
    `${JSON.stringify(
      {
        scope:
          'Disposable synthetic VM, native model computer-tool interface; no real model task or credential',
        observationOnly: true,
        syntheticOnly: true,
        originalVmOperated: false,
        paidModelTaskTurns: 0,
        modelToolCalls: run.toolCount,
        observed,
        boundaryEstablished: Object.values(observed).every((value) => value === false),
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
} finally {
  await app.close();
}

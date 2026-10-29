import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execute, ManagedHost, validateHost } from '../electron/host';

const [configuration, output] = process.argv.slice(2);
assert.ok(configuration && output);
const config = validateHost(JSON.parse(await readFile(configuration, 'utf8')));
assert.equal(config.limaHome, '/Users/murong/.local/share/daban/verify/r24');
assert.equal(config.vm, 'recovery');
assert.equal(config.port, 18891);
const root = await mkdtemp('/tmp/mock-tunnel-');
const controls = new Map<string, string>();
const executions: { scope: string; args: string[] }[] = [];
const make = (scope: string, port: number) =>
  new ManagedHost(
    { ...config, port },
    join(root, `${scope}-${'用户目录-'.repeat(8)}`, 'runtime-tunnel.sock'),
    {
      exec: async (program, args, options) => {
        if (program === 'ssh') {
          const address = args[args.indexOf('-S') + 1];
          assert.ok(address && Buffer.byteLength(address) <= 80);
          controls.set(scope, address);
        }
        executions.push({ scope, args });
        return execute(program, args, options);
      },
    },
  );
const a = make('alpha', 18891),
  b = make('beta', 18892);
let adopted: ManagedHost | undefined;
try {
  const first = await a.connect();
  const second = await b.connect();
  const [x, y] = await Promise.all([first.status(), second.status()]);
  assert.equal(x.phase, 'ready');
  assert.equal(y.phase, 'ready');
  assert.notEqual(controls.get('alpha'), controls.get('beta'));
  for (const host of [a, b]) {
    const checks = await host.inspect();
    for (const id of ['configuration', 'vm', 'tunnel', 'service', 'agent'])
      assert.equal(checks.checks.find((row) => row.id === id)?.state, 'ready');
  }
  a.abort(); // Retain its live master to reproduce a process crash before owner cleanup.
  adopted = make('alpha', 18891);
  const count = executions.filter((row) => row.scope === 'alpha' && row.args.includes('-M')).length;
  assert.equal((await (await adopted.connect()).status()).phase, 'ready');
  assert.equal(
    executions.filter((row) => row.scope === 'alpha' && row.args.includes('-M')).length,
    count,
  );
  await adopted.close();
  assert.equal((await second.status()).phase, 'ready');
  const recoveryFolder = join(root, `journal-${'用户目录-'.repeat(8)}`);
  await mkdir(recoveryFolder, { mode: 0o700 });
  const journal = join(recoveryFolder, 'runtime-recovery.json');
  await writeFile(journal, 'SYNTHETIC CORRUPT JOURNAL MUST SURVIVE', { mode: 0o600 });
  const journalHost = new ManagedHost(
    { ...config, port: 18893 },
    join(recoveryFolder, 'runtime-tunnel.sock'),
  );
  assert.equal((await journalHost.recoveryStatus()).available, false);
  assert.equal(await readFile(journal, 'utf8'), 'SYNTHETIC CORRUPT JOURNAL MUST SURVIVE');
  await journalHost.close();
  assert.equal(
    executions.some((row) => row.args[0] === 'stop'),
    false,
  );
  await writeFile(
    output,
    JSON.stringify(
      {
        verified: true,
        realSsh: true,
        syntheticOnly: true,
        originalVmAccessed: false,
        longUnicodePaths: true,
        distinctPrivateMasters: true,
        liveMasterAdoptedWithoutDuplicateCreation: true,
        closingOneKeptOtherReady: true,
        recoveryJournalRemainsAtOriginalLogicalPath: true,
        vmStopsIssued: 0,
        modelCalls: 0,
        protocols: [x.protocolVersion, y.protocolVersion],
        controlPathBytes: [...controls.values()].map((value) => Buffer.byteLength(value)),
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await adopted?.close();
  await a.close();
  await b.close();
  for (const socket of new Set(controls.values())) await rmdir(dirname(socket));
  await rm(root, { recursive: true, force: true });
}

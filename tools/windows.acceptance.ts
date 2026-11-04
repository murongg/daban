import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, mkdir, readFile } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { privateClientOptions } from '@daban/engine/local-computer';
import { isLocalComputerStatus } from '@daban/protocol';
import { withComponentStage } from './components.ts';
import { hashAsset } from './environment.ts';

assert.equal(process.platform, 'win32');
assert.equal(process.env.CI, 'true', 'Fresh Windows CI runner required');
const target = process.argv[2];
assert.ok(target && process.env.APPDATA);
const root = path.join(process.env.APPDATA, 'daban-preview');
// Never inspect or launch against an existing person's workspace. This acceptance owns a fresh CI profile only.
const exists = await access(root).then(
  () => true,
  () => false,
);
assert.equal(exists, false, 'SMOKE_PROFILE_ALREADY_EXISTS');
const dataRoot = path.join(root, 'agent');
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = digest([path.resolve(dataRoot), path.resolve(root, 'runtime.json')]);
const socketPath = String.raw`\\.\pipe\daban-agent-${digest([path.resolve(root, 'agent.sock'), scope]).slice(0, 32)}`;
const run = promisify(execFile);
const executable = path.resolve(target, 'Daban.exe');
const abi = await run(
  executable,
  [
    '--experimental-strip-types',
    fileURLToPath(new URL('./native.ts', import.meta.url)),
    'abi',
    path.resolve(target, 'resources/app/package.json'),
  ],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: 45000,
    maxBuffer: 2 * 1024 * 1024,
  },
);
process.stdout.write(abi.stdout);
const archive = process.argv[3];
assert.ok(archive, 'RUNTIME_ARCHIVE_REQUIRED');
const reference = JSON.parse(
  await readFile(path.resolve(target, 'resources/runtime.json'), 'utf8'),
);
assert.equal((await hashAsset(archive, 'sha256')).digest, reference.assets[0].sha256);
await assert.rejects(access(path.resolve(target, 'resources/agent')), { code: 'ENOENT' });
await withComponentStage(async (inspect) => {
  console.time('acceptance:inspect-extract');
  await run('tar.exe', ['-xf', path.resolve(archive), '-C', inspect]);
  console.timeEnd('acceptance:inspect-extract');
  const cache = path.join(root, 'components/downloads');
  await mkdir(cache, { recursive: true });
  await copyFile(archive, path.join(cache, `${reference.assets[0].sha256}.zip`));
  const agent = path.join(inspect, 'DabanRuntime/agent'),
    smokes = ['native-loop.test.js', 'calendar.test.js'].map((name) => path.join(agent, name));
  for (const smoke of smokes)
    await copyFile(
      fileURLToPath(new URL(`../dist-agent/${path.basename(smoke)}`, import.meta.url)),
      smoke,
      constants.COPYFILE_EXCL,
    );
  console.time('acceptance:sdk-smoke');
  const sdk = await run(
    path.join(agent, 'node/node.exe'),
    [
      '--experimental-sqlite',
      fileURLToPath(new URL('../node_modules/vitest/vitest.mjs', import.meta.url)),
      'run',
      '--config',
      fileURLToPath(new URL('./testing/packaged.config.ts', import.meta.url)),
      '--root',
      agent,
      '--reporter=verbose',
      '--maxWorkers=1',
      ...smokes,
    ],
    // The serial 60s native-loop and 30s calendar checks also need runner startup time.
    { cwd: agent, timeout: 120000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.match(sdk.stdout, /real DSH dispatches/);
  assert.match(sdk.stdout, /real host calendar recovers/);
  process.stdout.write(sdk.stdout);
  console.timeEnd('acceptance:sdk-smoke');
});
const child = spawn(path.resolve(target, 'Daban.exe'), [], {
  cwd: path.resolve(target),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let launchOutput = '';
const observe = (chunk: Buffer) => {
  launchOutput = (launchOutput + chunk.toString('utf8')).slice(-16384);
};
child.stdout.on('data', observe);
child.stderr.on('data', observe);
let spawnFailure: unknown;
child.once('error', (error) => {
  spawnFailure = error;
});
async function state(route = '/api/state', body?: Record<string, string>) {
  const token = (await readFile(path.join(dataRoot, 'model/control-token'), 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  const tls = await privateClientOptions(path.join(dataRoot, 'model/control-certificate.pem'));
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const call = request(
      {
        ...tls,
        socketPath,
        path: route,
        method: body ? 'POST' : 'GET',
        headers: {
          host: '127.0.0.1:8766',
          'x-prototype-token': token,
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) call.destroy(new Error('SMOKE_RESPONSE_TOO_LARGE'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            assert.equal(res.statusCode, 200);
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    call.on('error', reject);
    // Cold CIM/WHPX detection needs the same budget as Electron's EnvironmentClient.
    const timeout = route === '/api/host/environment' ? 8000 : 2000;
    call.setTimeout(timeout, () => call.destroy(new Error(`SMOKE_TIMEOUT:${route}`)));
    call.end(body ? JSON.stringify(body) : undefined);
  });
}
try {
  let ready = false,
    lastError: unknown;
  // Cold extraction and per-file integrity verification took 73 seconds on the clean runner.
  const preparationStarted = Date.now();
  const until = preparationStarted + 180000;
  while (Date.now() < until) {
    if (spawnFailure) throw spawnFailure;
    if (/\[agent-components\] failed/.test(launchOutput))
      throw Error('SMOKE_COMPONENT_PREPARATION_FAILED');
    if (child.exitCode !== null) throw new Error('SMOKE_CLIENT_EXITED');
    try {
      const value = await state();
      assert.deepEqual(value.agent, {
        location: 'host',
        execution: 'local-workspace',
        privilege: 'workspace',
        approvals: 'host',
      });
      assert.ok(isLocalComputerStatus(value.localComputer));
      assert.equal(value.localComputer.platform, 'win32');
      assert.equal(value.localComputer.available, true);
      assert.equal(value.localComputer.session, undefined);
      assert.deepEqual(value.profiles, []);
      assert.equal((value.knowledge as { documentParsing?: boolean }).documentParsing, false);
      assert.equal((value.schedules as { available?: boolean }).available, true);
      const setup = await state('/api/host/environment', { scope, action: 'status' });
      assert.equal(setup.phase, 'available');
      assert.ok((setup.windows as { downloadBytes?: number }).downloadBytes);
      ready = true;
      console.log(`Runtime ready after ${Date.now() - preparationStarted} ms.`);
      break;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(
    ready,
    `Packaged client failed first-use startup: ${lastError instanceof Error ? lastError.message : 'not ready'}`,
  );
  console.log(
    'Packaged Windows first-use startup verified: optional Linux download available, no VM, empty workspace, desktop control disabled.',
  );
} finally {
  // Only fixed preflight codes and durations are public diagnostics; other daemon logs can contain private context.
  const diagnostics = await readFile(path.join(dataRoot, 'agent.log'), 'utf8').catch(() => '');
  for (const line of diagnostics.split(/\r?\n/))
    if (
      /^\[windows-probe\] \d+ (ready|disabled|restart|firmware|unsupported|QEMU_HOST_UNAVAILABLE)$/.test(
        line,
      ) ||
      /^\[windows-probe-stage\] (module|cpu|feature|capability|launch)$/.test(line) ||
      /^\[windows-probe-cim\] ([0-9]|[1-5][0-9]|6[0-4])$/.test(line)
    )
      console.log(line);
  for (const line of launchOutput.split(/\r?\n/))
    if (/^\[agent-components\] [a-z]+(?: [A-Z_]+)?\s*$/.test(line)) console.log(line);
  if (child.pid && child.exitCode === null && child.signalCode === null)
    await promisify(execFile)(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true },
    ).catch(() => {});
}

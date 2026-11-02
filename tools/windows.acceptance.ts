import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, readFile, unlink } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { privateClientOptions } from '@daban/engine/local-computer';
import { isLocalComputerStatus } from '@daban/protocol';

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
const agent = path.resolve(target, 'resources/agent'),
  smokes = ['native-loop.test.js', 'calendar.test.js'].map((name) => path.join(agent, name));
for (const smoke of smokes)
  await copyFile(
    fileURLToPath(new URL(`../dist-agent/${path.basename(smoke)}`, import.meta.url)),
    smoke,
    constants.COPYFILE_EXCL,
  );
try {
  const sdk = await run(
    path.join(agent, 'node/node.exe'),
    ['--experimental-sqlite', '--test', ...smokes],
    { cwd: agent, timeout: 60000, maxBuffer: 2 * 1024 * 1024 },
  );
  assert.match(sdk.stdout, /real DSH dispatches/);
  assert.match(sdk.stdout, /real host calendar recovers/);
  process.stdout.write(sdk.stdout);
} finally {
  for (const smoke of smokes) await unlink(smoke);
}
const child = spawn(path.resolve(target, 'Daban.exe'), [], {
  cwd: path.resolve(target),
  stdio: 'ignore',
});
let spawnFailure: unknown;
child.once('error', (error) => {
  spawnFailure = error;
});
async function state() {
  const token = (await readFile(path.join(dataRoot, 'model/control-token'), 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  const tls = await privateClientOptions(path.join(dataRoot, 'model/control-certificate.pem'));
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const call = request(
      {
        ...tls,
        socketPath,
        path: '/api/state',
        headers: { host: '127.0.0.1:8766', 'x-prototype-token': token },
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
    call.setTimeout(2000, () => call.destroy(new Error('SMOKE_TIMEOUT')));
    call.end();
  });
}
try {
  let ready = false,
    lastError: unknown;
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    if (spawnFailure) throw spawnFailure;
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
      ready = true;
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
    'Packaged Windows first-use startup verified: no VM, empty workspace, desktop control disabled.',
  );
} finally {
  if (child.pid && child.exitCode === null && child.signalCode === null)
    await promisify(execFile)(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/taskkill.exe'),
      ['/PID', String(child.pid), '/T', '/F'],
      { windowsHide: true },
    ).catch(() => {});
}

import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const project = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(project, 'outputs/remote');
const clientBuild = process.env.DABAN_REMOTE_CLIENT_BUILD
  ? path.resolve(process.env.DABAN_REMOTE_CLIENT_BUILD)
  : project;
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, 'rtc-'));
let turn: ChildProcess | undefined;
try {
  await rm(path.join(output, 'webrtc.json'), { force: true });
  const entry = path.join(root, 'acceptance.cjs');
  // Exercise the same resolver as the shipped Electron main, including Node-only package exports.
  await build({
    configFile: path.join(project, 'apps/desktop/electron/vite.config.ts'),
    logLevel: 'silent',
    build: {
      outDir: root,
      emptyOutDir: false,
      lib: {
        entry: path.join(project, 'apps/desktop/acceptance/remote.acceptance.ts'),
        formats: ['cjs'],
        fileName: () => 'acceptance.cjs',
      },
    },
  });
  const probe = net.createServer();
  await new Promise<undefined>((resolve) => probe.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = probe.address();
  assert.ok(address && typeof address !== 'string');
  const port = address.port;
  await new Promise<undefined>((resolve) => probe.close(() => resolve(undefined)));
  const secret = randomBytes(32).toString('hex');
  const configuration = path.join(root, 'turn.conf');
  await writeFile(
    configuration,
    [
      `listening-port=${port}`,
      'listening-ip=127.0.0.1',
      'relay-ip=127.0.0.1',
      'min-port=50000',
      'max-port=50030',
      'use-auth-secret',
      `static-auth-secret=${secret}`,
      'realm=synthetic.example.test',
      'fingerprint',
      'no-tls',
      'no-dtls',
      'no-cli',
      'allow-loopback-peers',
      'no-multicast-peers',
      'total-quota=24',
      'user-quota=12',
      'no-stdout-log',
      `log-file=${path.join(root, 'turn.log')}`,
    ].join('\n'),
    { mode: 0o600 },
  );
  turn = spawn(
    process.env.DABAN_TURN_BINARY ??
      (process.platform === 'darwin' ? '/opt/homebrew/opt/coturn/bin/turnserver' : 'turnserver'),
    ['-c', configuration],
    { stdio: 'ignore' },
  );
  let turnFailed = false;
  turn.once('error', () => {
    turnFailed = true;
  });
  const deadline = Date.now() + 10000;
  let available = false;
  while (!available && Date.now() < deadline && turn.exitCode === null && !turnFailed) {
    available = await new Promise<boolean>((resolve) => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (!available) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(available, 'A local coturn binary is required for the real relay test');
  const username = `${Math.floor(Date.now() / 1000) + 120}:synthetic-video`;
  const ice = [
    {
      urls: [`turn:127.0.0.1:${port}?transport=tcp`],
      username,
      credential: createHmac('sha1', secret).update(username).digest('base64'),
    },
  ];
  const require = createRequire(path.join(project, 'apps/desktop/package.json'));
  const electron: string = require('electron');
  const status = await new Promise<number | null>((resolve, reject) => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [entry], {
      cwd: project,
      stdio: 'inherit',
      timeout: 90_000,
      env: {
        ...env,
        DABAN_REMOTE_TEST_ROOT: root,
        DABAN_REMOTE_TEST_PROJECT: project,
        DABAN_REMOTE_TEST_BUILD: clientBuild,
        DABAN_REMOTE_TEST_ICE: JSON.stringify(ice),
      },
    });
    child.once('error', reject);
    child.once('close', resolve);
  });
  assert.equal(status, 0, 'Real Chromium WebRTC acceptance failed');
  const report: unknown = JSON.parse(await readFile(path.join(output, 'webrtc.json'), 'utf8'));
  assert.ok(
    report && typeof report === 'object' && 'verified' in report && report.verified === true,
  );
} finally {
  if (turn?.pid && turn.exitCode === null && turn.signalCode === null) {
    turn.kill('SIGTERM');
    await once(turn, 'close');
  }
  await rm(root, { recursive: true, force: true });
}

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  componentAsset,
  componentIndex,
  qemuPayload,
  windowsEnvironment,
} from '@daban/engine/component';
import { readVmConnection } from '@daban/engine/host';
import { privateClientOptions, secureDirectory } from '@daban/engine/local-computer';
import type {
  ComputerAck,
  RuntimeBridge,
  RuntimeCommand,
  RuntimeSnapshot,
  SetupStatus,
} from '@daban/protocol';
import { _electron, type ElectronApplication, type Page } from 'playwright';
import { hashAsset } from './environment.ts';

const repository = fileURLToPath(new URL('..', import.meta.url));
const { QemuLink }: typeof import('../apps/agent/src/qemu.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qemu.js')).href
);
const { ExecutionConnection }: typeof import('../apps/agent/src/connection.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/connection.js')).href
);
const [binary, profileDirectory, reportDirectory, mode, continuation, runtimeArchive] =
  process.argv.slice(2);
const resumeDownload = continuation === '--resume-download';
const download = continuation === '--download' || resumeDownload;
assert.ok(
  binary && profileDirectory && reportDirectory && (mode === 'tcg' || mode === 'whpx'),
  'Usage: qemu-client.acceptance.ts <Daban.exe> <new-profile> <reports> tcg|whpx',
);
const profile = path.resolve(profileDirectory),
  reports = path.resolve(reportDirectory),
  dataRoot = path.join(profile, 'agent');
const exists = await lstat(profile).then(
  () => true,
  (error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return false;
  },
);
const resume = continuation === '--resume';
const marker = path.join(profile, 'acceptance-owner.json');
if (resume || resumeDownload)
  assert.deepEqual(JSON.parse(await readFile(marker, 'utf8')), {
    version: 1,
    owner: 'qemu-client',
    mode,
  });
else assert.equal(exists, false, 'Existing profiles are never used for acceptance.');
await mkdir(reports, { recursive: true });
await secureDirectory(profile);
if (!resume && !resumeDownload)
  await writeFile(marker, JSON.stringify({ version: 1, owner: 'qemu-client', mode }), {
    flag: 'wx',
  });
if (download) assert.ok(runtimeArchive, 'DOWNLOAD_ACCEPTANCE_RUNTIME_REQUIRED');
if (runtimeArchive) {
  const reference = JSON.parse(
    await readFile(path.resolve(binary, '../resources/runtime.json'), 'utf8'),
  ) as { id: string };
  const asset = componentAsset(componentIndex(reference, reference.id), 'win32', 'x64');
  const actual = await hashAsset(path.resolve(runtimeArchive), 'sha256');
  assert.equal(actual.bytes, asset.bytes);
  assert.equal(actual.digest, asset.sha256);
  const cache = await secureDirectory(path.join(profile, 'components/downloads'));
  await copyFile(path.resolve(runtimeArchive), path.join(cache, asset.sha256 + '.zip'));
}
if (download) {
  await assert.rejects(lstat(path.resolve(binary, '../resources/environment/qemu')), {
    code: 'ENOENT',
  });
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scope = digest([path.resolve(dataRoot), path.resolve(profile, 'runtime.json')]);
const socketPath = String.raw`\\.\pipe\daban-agent-${digest([path.resolve(profile, 'agent.sock'), scope]).slice(0, 32)}`;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const env = Object.fromEntries(
  [
    'PATH',
    'Path',
    'SystemRoot',
    'WINDIR',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'ProgramData',
    'TEMP',
    'TMP',
    'HOMEDRIVE',
    'HOMEPATH',
    'LANG',
  ].flatMap((name) => (typeof process.env[name] === 'string' ? [[name, process.env[name]!]] : [])),
);
async function host(route: string, body?: Record<string, unknown>): Promise<unknown> {
  const token = (await readFile(path.join(dataRoot, 'model/control-token'), 'utf8')).trim();
  assert.match(token, /^[a-f0-9]{64}$/);
  const tls = await privateClientOptions(path.join(dataRoot, 'model/control-certificate.pem'));
  return new Promise((resolve, reject) => {
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
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 ** 2) call.destroy(Error('ACCEPTANCE_RESPONSE_LIMIT'));
          else chunks.push(chunk);
        });
        response.on('error', reject);
        response.on('end', () => {
          try {
            assert.equal(response.statusCode, 200);
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    call.on('error', reject);
    call.setTimeout(8000, () => call.destroy(Error('ACCEPTANCE_TIMEOUT')));
    call.end(body ? JSON.stringify(body) : undefined);
  });
}
async function invoke<T>(page: Page, command: RuntimeCommand): Promise<T> {
  const reply = await page.evaluate(async (value) => {
    const bridge = (window as unknown as { daban?: { runtime: RuntimeBridge } }).daban?.runtime;
    if (!bridge) throw Error('ACCEPTANCE_BRIDGE_UNAVAILABLE');
    return bridge.invoke(value);
  }, command);
  if (!reply.ok) throw Error(reply.error);
  return reply.value as T;
}
async function ready(page: Page, execution: 'local-workspace' | 'linux-vm') {
  const end = Date.now() + 180000;
  while (Date.now() < end) {
    const state = await invoke<RuntimeSnapshot>(page, { type: 'status' });
    if (state.phase === 'ready' && state.agent?.execution === execution) return state;
    await delay(500);
  }
  throw Error('ACCEPTANCE_CLIENT_NOT_READY');
}
async function launch() {
  const app = await _electron.launch({
    executablePath: path.resolve(binary),
    args: [`--user-data-dir=${profile}`],
    env,
    timeout: 45000,
  });
  assert.equal(await app.evaluate(({ app }) => app.getPath('userData')), profile);
  const page = await app.firstWindow();
  await page.waitForFunction(
    () => !!(window as Window & { daban?: { runtime?: unknown } }).daban?.runtime,
  );
  return { app, page };
}
async function closeWindow(app: ElectronApplication, page: Page) {
  const process = app.process();
  const exited = new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('ACCEPTANCE_WINDOW_DID_NOT_EXIT')), 20000);
    process.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
  // One quit request avoids racing Playwright with an already destroyed BrowserWindow.
  // Native process exit is the evidence; a slow inspector disconnect cannot hold the test indefinitely.
  const closing = app.close();
  await Promise.race([closing, exited]);
  await exited;
  await Promise.race([closing, delay(1000)]);
  assert.ok(page.isClosed());
}
let opened: Awaited<ReturnType<typeof launch>> | undefined;
const checks: string[] =
    resume || resumeDownload
      ? (
          JSON.parse(readFileSync(path.join(reports, 'progress.json'), 'utf8')) as {
            checks: string[];
          }
        ).checks
      : [],
  started = Date.now();
const check = (name: string) => {
  if (!checks.includes(name)) checks.push(name);
  writeFileSync(path.join(reports, 'progress.json'), JSON.stringify({ complete: false, checks }));
  console.log(name);
};
try {
  if (!resume) {
    opened = await launch();
    const initial = await ready(opened.page, 'local-workspace');
    assert.equal(initial.profiles.length, 0);
    assert.equal(initial.model.configured, false);
    const setup = await invoke<SetupStatus>(opened.page, { type: 'setup.status' });
    assert.ok(setup.windows);
    if (mode === 'whpx')
      assert.equal(
        setup.windows.acceleration,
        'ready',
        'WHPX acceptance requires a completed Windows restart.',
      );
    check(
      download
        ? 'lightweight-client-without-bundled-qemu-or-image'
        : 'isolated-packaged-client-and-bundled-runtime',
    );
    if (download) {
      assert.equal(setup.phase, resumeDownload ? 'cancelled' : 'available');
      assert.equal(setup.windows.downloadBytes, windowsEnvironment.bytes);
      if (!resumeDownload)
        await assert.rejects(lstat(path.join(dataRoot, 'qemu-cache')), { code: 'ENOENT' });
      check('opening-client-does-not-download-linux');
      // Environment publication may still be uploading. This harness-only HEAD never warms the VM cache.
      const until = Date.now() + 60 * 60 * 1000;
      console.log('Waiting for the public environment release before download acceptance.');
      let published = false;
      while (Date.now() < until) {
        const response = await fetch(qemuPayload(windowsEnvironment).url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(15000),
        }).catch(() => undefined);
        if (response?.ok) {
          published = true;
          break;
        }
        await delay(30000);
      }
      assert.ok(published, 'PUBLIC_ENVIRONMENT_UNAVAILABLE');
    }
    const previousPartial = resumeDownload
      ? (await lstat(path.join(dataRoot, 'qemu-cache', windowsEnvironment.sha256 + '.zip.part')))
          .size
      : 0;
    await invoke(opened.page, { type: 'setup.start', mode });
    if (download) {
      const end = Date.now() + 180000;
      let received = 0;
      while (Date.now() < end) {
        const state = await invoke<RuntimeSnapshot>(opened.page, { type: 'status' });
        if (state.setup?.phase === 'failed')
          throw Error(state.setup.error ?? 'ACCEPTANCE_DOWNLOAD_FAILED');
        if (
          state.setup?.phase === 'downloading' &&
          (state.setup.downloaded ?? 0) > previousPartial + 32 * 1024 ** 2
        ) {
          received = state.setup.downloaded!;
          break;
        }
        await delay(300);
      }
      assert.ok(
        received > 0 && received < windowsEnvironment.bytes,
        'REAL_DOWNLOAD_PROGRESS_REQUIRED',
      );
      await invoke(opened.page, { type: 'setup.cancel' });
      const until = Date.now() + 30000;
      let paused = false;
      while (Date.now() < until) {
        const state = await invoke<RuntimeSnapshot>(opened.page, { type: 'status' });
        if (state.setup?.phase === 'cancelled') {
          paused = true;
          break;
        }
        await delay(200);
      }
      assert.ok(paused, 'DOWNLOAD_DID_NOT_PAUSE');
      const partial = await lstat(
        path.join(dataRoot, 'qemu-cache', windowsEnvironment.sha256 + '.zip.part'),
      );
      assert.ok(partial.size >= received && partial.size < windowsEnvironment.bytes);
      await closeWindow(opened.app, opened.page);
      opened = await launch();
      const state = await ready(opened.page, 'local-workspace');
      assert.equal(state.setup?.phase, 'cancelled');
      check('real-https-download-paused-with-partial-data-and-survives-client-reopen');
      await invoke(opened.page, { type: 'setup.start', mode });
    }
    await closeWindow(opened.app, opened.page);
    opened = undefined;
    let installed: SetupStatus | undefined;
    let phase = '';
    const end = Date.now() + (download ? 1200000 : 660000);
    while (Date.now() < end) {
      installed = (await host('/api/host/environment', { scope, action: 'status' })) as SetupStatus;
      if (phase !== installed.phase) {
        phase = installed.phase;
        console.log('installation', phase, installed.error ?? '');
      }
      if (!installed.required) break;
      if (installed.phase === 'failed' || installed.phase === 'waiting')
        throw Error(installed.error ?? 'ACCEPTANCE_INSTALL_WAITING');
      await delay(1000);
    }
    assert.equal(installed?.required, false);
    check('installation-continues-after-window-closes');
  }
  opened = await launch();
  const connected = await ready(opened.page, 'linux-vm');
  assert.ok(connected.profiles.every((item) => item.id === 'qemu-client-synthetic'));
  assert.equal(connected.model.configured, false);
  check('automatic-idle-handoff-to-linux-without-connection-fields');
  const reference = JSON.parse(
    await readFile(path.resolve(binary, '../resources/runtime.json'), 'utf8'),
  ) as { id: string };
  componentIndex(reference, reference.id);
  const pointer = path.join(
    profile,
    'components',
    reference.id.slice(0, 24) + '-win32-x64/current.json',
  );
  const originalPointer = await readFile(pointer, 'utf8');
  const originalTime = (await lstat(pointer)).mtimeMs;
  for (let restart = 0; restart < 2; restart++) {
    await closeWindow(opened.app, opened.page);
    opened = await launch();
    await ready(opened.page, 'linux-vm');
    assert.equal(
      await readFile(pointer, 'utf8'),
      originalPointer,
      'RESTART_MUST_REUSE_RUNTIME_GENERATION',
    );
    assert.equal(
      (await lstat(pointer)).mtimeMs,
      originalTime,
      'RESTART_MUST_NOT_REEXTRACT_RUNTIME',
    );
  }
  check('two-same-version-restarts-reuse-the-existing-runtime-without-extraction');
  const bot = 'qemu-client-synthetic';
  if (!connected.profiles.some((item) => item.id === bot))
    await invoke(opened.page, {
      type: 'bot.register',
      profile: {
        id: bot,
        name: '合成验收',
        instructions: 'Synthetic acceptance only',
        memory: '',
        color: 'mint',
      },
    });
  // A resumed VM can retain a disconnected computer with a nonzero revision after the client restarts.
  const desktopState = await invoke<RuntimeSnapshot>(opened.page, { type: 'status' });
  let computer = desktopState.computers?.items.find((item) => item.bot === bot);
  if (computer?.phase !== 'connected') {
    const requestId = `desktop-${randomUUID()}`;
    let ack: ComputerAck | undefined;
    try {
      ack = await invoke(opened.page, {
        type: 'computer.action',
        request: { id: requestId, bot, action: 'connect', revision: computer?.revision ?? 0 },
      });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !['EXECUTION_OUTCOME_UNKNOWN', 'RUNTIME_UNAVAILABLE'].includes(error.message)
      )
        throw error;
    }
    const desktopEnd = Date.now() + 180000;
    while ((!ack || ack.receipt.phase !== 'settled') && Date.now() < desktopEnd) {
      ack = await invoke(opened.page, { type: 'computer.receipt', bot, id: requestId });
      await delay(500);
    }
    assert.ok(ack && ack.state.phase === 'connected' && ack.state.instance);
    computer = ack.state;
  }
  assert.ok(computer.instance);
  const current = await invoke<RuntimeSnapshot>(opened.page, { type: 'status' });
  const lease = current.bots[bot];
  assert.ok(lease);
  const human = await invoke<{ epoch: number }>(opened.page, {
    type: 'control',
    bot,
    epoch: lease.epoch,
    instance: computer.instance,
    owner: 'human',
  });
  const frame = await invoke<string>(opened.page, {
    type: 'frame',
    bot,
    surface: 'desktop',
    epoch: human.epoch,
    instance: computer.instance,
  });
  assert.match(frame, /^data:image\/jpeg;base64,/);
  await invoke(opened.page, {
    type: 'app',
    bot,
    epoch: human.epoch,
    instance: computer.instance,
    app: 'terminal',
  });
  await invoke(opened.page, {
    type: 'input',
    bot,
    epoch: human.epoch,
    instance: computer.instance,
    input: { type: 'text', text: "printf 'SYNTHETIC-CLIENT' > client-ui.txt" },
  });
  await invoke(opened.page, {
    type: 'input',
    bot,
    epoch: human.epoch,
    instance: computer.instance,
    input: { type: 'key', key: 'Return' },
  });
  await delay(1000);
  const file = await invoke<{ content: string }>(opened.page, {
    type: 'files.read',
    path: 'client-ui.txt',
  });
  assert.equal(file.content, 'SYNTHETIC-CLIENT');
  const after = await invoke<string>(opened.page, {
    type: 'frame',
    bot,
    surface: 'desktop',
    epoch: human.epoch,
    instance: computer.instance,
  });
  assert.notEqual(after, frame);
  await writeFile(
    path.join(reports, 'client-desktop.jpg'),
    Buffer.from(after.slice(after.indexOf(',') + 1), 'base64'),
  );
  await invoke(opened.page, {
    type: 'app',
    bot,
    epoch: human.epoch,
    instance: computer.instance,
    app: 'browser',
  });
  const browser = await invoke<string>(opened.page, {
    type: 'frame',
    bot,
    surface: 'browser',
    epoch: human.epoch,
    instance: computer.instance,
  });
  assert.match(browser, /^data:image\/jpeg;base64,/);
  await invoke(opened.page, {
    type: 'control',
    bot,
    epoch: human.epoch,
    instance: computer.instance,
    owner: 'agent',
  });
  check('packaged-preload-desktop-keyboard-files-and-browser');
  const config = await readVmConnection(path.join(profile, 'runtime.json'));
  assert.ok(config?.provider === 'qemu');
  const link = new QemuLink(config, dataRoot),
    peer = new ExecutionConnection(link, { attachOnly: true });
  await peer.ready;
  const taskId = `client-background-${randomUUID()}`;
  const task = await peer.call<{ path: string; handleId: string }>('workspace.create', {
    parts: [taskId, bot],
  });
  const processId = `process-${randomUUID()}`;
  await peer.call('process.start', {
    id: processId,
    command: 'sleep 8; printf QEMU-CLIENT-CONTINUES >> client-background.txt; printf COMPLETE',
    cwd: task.path,
  });
  await peer.close();
  await closeWindow(opened.app, opened.page);
  opened = undefined;
  await delay(9000);
  const hostState = (await host('/api/state')) as { agent?: { execution?: string } };
  assert.equal(hostState.agent?.execution, 'linux-vm');
  const nextLink = new QemuLink(config, dataRoot);
  assert.equal(await nextLink.state(), 'running');
  const next = new ExecutionConnection(nextLink, { attachOnly: true });
  try {
    await next.ready;
    const result = await next.call<{ phase: string; stdout: string }>('process.poll', {
      id: processId,
    });
    assert.equal(result.phase, 'exited');
    assert.equal(result.stdout, 'COMPLETE');
    assert.equal(
      (
        await next.call<{ content: string }>('workspace.read', {
          path: `${taskId}/${bot}/client-background.txt`,
        })
      ).content,
      'QEMU-CLIENT-CONTINUES',
    );
    await next.call('workspace.close', { handleId: task.handleId });
  } finally {
    await next.close();
  }
  check('background-host-vm-and-task-survive-real-client-exit-without-replay');
  await writeFile(
    path.join(reports, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        executable: path.resolve(binary),
        runtimeId: reference.id,
        continued: resume,
        acceleration: mode,
        vmId: config.vmId,
        elapsedMs: Date.now() - started,
        checks,
      },
      null,
      2,
    ),
  );
} finally {
  if (opened && opened.app.process().exitCode === null)
    await Promise.race([opened.app.close(), delay(15000)]);
}

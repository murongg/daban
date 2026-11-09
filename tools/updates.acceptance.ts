import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { builtinModules, createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Arch, build, type Configuration, Platform } from 'electron-builder';
import { build as bundle } from 'vite';
import { attachRuntimeReference } from './installer.ts';

const platform = process.platform;
assert.ok(platform === 'darwin' || platform === 'win32');
if (process.platform === 'win32')
  assert.equal(
    process.env.CI,
    'true',
    'Windows installer acceptance requires a disposable CI account',
  );
const root = fileURLToPath(new URL('..', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'daban-update-fixture-'));
const id = `dev.daban.update-fixture.run${Date.now()}`;
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
const electron: string = requireDesktop('electron');
const run = promisify(execFile);
const feed = path.join(temporary, 'feed');
await mkdir(feed);
const runtimeBytes = Buffer.from('SYNTHETIC UPDATE RUNTIME ARCHIVE');
const runtimeId = 'a'.repeat(64);
await writeFile(path.join(feed, 'runtime-fixture.bin'), runtimeBytes);
const server = createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url ?? '/', 'http://127.0.0.1').pathname).slice(1);
    if (!name || path.basename(name) !== name) {
      res.writeHead(404);
      res.end();
      return;
    }
    const bytes = await readFile(path.join(feed, name));
    res.writeHead(200, {
      'content-length': bytes.length,
      'content-type': name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
    });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
const address = server.address();
assert.ok(address && typeof address !== 'string');
const url = `http://127.0.0.1:${address.port}`;
let child: ReturnType<typeof spawn> | undefined;
let cache: string | undefined;
try {
  const code = path.join(temporary, 'code');
  await bundle({
    configFile: false,
    build: {
      outDir: code,
      target: 'node22',
      minify: false,
      lib: {
        entry: path.join(root, 'apps/desktop/acceptance/update-fixture.ts'),
        formats: ['cjs'],
        fileName: () => 'main.cjs',
      },
      rolldownOptions: {
        external: (source) =>
          source === 'electron' || source.startsWith('node:') || builtinModules.includes(source),
      },
    },
  });
  async function assemble(version: string) {
    const directory = path.join(temporary, version);
    await mkdir(directory);
    const app =
      process.platform === 'darwin'
        ? path.join(directory, 'DabanUpdateFixture.app')
        : path.join(directory, 'app');
    const distribution =
      process.platform === 'darwin' ? path.resolve(electron, '../../..') : path.dirname(electron);
    await cp(distribution, app, {
      recursive: true,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
    if (process.platform === 'win32')
      await rename(path.join(app, 'electron.exe'), path.join(app, 'DabanUpdateFixture.exe'));
    const resources = path.join(
      app,
      process.platform === 'darwin' ? 'Contents/Resources' : 'resources',
    );
    await mkdir(path.join(resources, 'app'));
    await cp(path.join(code, 'main.cjs'), path.join(resources, 'app/main.cjs'));
    await writeFile(
      path.join(resources, 'app/package.json'),
      JSON.stringify({ name: 'daban-update-fixture', version, main: 'main.cjs' }),
    );
    await writeFile(
      path.join(resources, 'fixture.json'),
      JSON.stringify({ root: temporary, feed: url, id }),
    );
    await writeFile(
      path.join(resources, 'app-update.yml'),
      `provider: generic\nurl: ${url}\nupdaterCacheDirName: ${path.basename(temporary)}\n`,
    );
    if (version === '1.1.0')
      await writeFile(
        path.join(resources, 'runtime.json'),
        JSON.stringify({
          version: 1,
          id: runtimeId,
          assets: [
            {
              platform: process.platform,
              arch: process.platform === 'darwin' ? 'arm64' : 'x64',
              bytes: runtimeBytes.length,
              sha256: createHash('sha256').update(runtimeBytes).digest('hex'),
            },
          ],
        }),
      );
    if (process.platform === 'darwin') {
      await rename(
        path.join(app, 'Contents/MacOS/Electron'),
        path.join(app, 'Contents/MacOS/DabanUpdateFixture'),
      );
      const plist = path.join(app, 'Contents/Info.plist');
      for (const [key, value] of Object.entries({
        CFBundleIdentifier: id,
        CFBundleExecutable: 'DabanUpdateFixture',
        CFBundleName: 'DabanUpdateFixture',
        CFBundleShortVersionString: version,
        CFBundleVersion: version,
      }))
        await run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist]);
      // Only these disposable fixtures use an ad-hoc identifier requirement; production retains Developer ID validation.
      await run('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', app]);
      await run('/usr/bin/codesign', [
        '--force',
        '--sign',
        '-',
        '--requirements',
        `=designated => identifier "${id}"`,
        app,
      ]);
      await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    }
    return app;
  }
  const one = await assemble('1.0.0'),
    two = await assemble('1.1.0');
  const config: Configuration = {
    appId: id,
    productName: 'DabanUpdateFixture',
    extraMetadata: { name: 'daban-update-fixture', version: '1.1.0' },
    directories: { app: path.join(root, 'apps/desktop'), output: feed },
    publish: [{ provider: 'generic', url }],
    npmRebuild: false,
    artifactName: 'fixture-${version}-${arch}.${ext}',
    mac: { identity: null },
    nsis: {
      oneClick: true,
      perMachine: false,
      allowElevation: false,
      deleteAppDataOnUninstall: false,
      createDesktopShortcut: false,
      createStartMenuShortcut: false,
      runAfterFinish: true,
    },
  };
  await build({
    projectDir: root,
    prepackaged: two,
    publish: 'never',
    targets:
      process.platform === 'darwin'
        ? Platform.MAC.createTarget(['zip'], Arch.arm64)
        : Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
    config,
  });
  await attachRuntimeReference(
    feed,
    path.join(two, platform === 'darwin' ? 'Contents/Resources' : 'resources'),
    platform,
  );
  if (process.platform === 'darwin') {
    const archive = (await readdir(feed)).find((name) => name.endsWith('.zip'));
    assert.ok(archive);
    const extracted = path.join(temporary, 'extract');
    await mkdir(extracted);
    await run('/usr/bin/ditto', ['-x', '-k', path.join(feed, archive), extracted]);
    await run('/usr/bin/codesign', [
      '--verify',
      '--deep',
      '--strict',
      path.join(extracted, 'DabanUpdateFixture.app'),
    ]);
  }
  let executable = path.join(
    one,
    process.platform === 'darwin' ? 'Contents/MacOS/DabanUpdateFixture' : 'DabanUpdateFixture.exe',
  );
  if (process.platform === 'win32') {
    const firstFeed = path.join(temporary, 'first');
    await build({
      projectDir: root,
      prepackaged: one,
      publish: 'never',
      targets: Platform.WINDOWS.createTarget(['nsis'], Arch.x64),
      config: {
        ...config,
        nsis: { ...config.nsis, runAfterFinish: false },
        extraMetadata: { name: 'daban-update-fixture', version: '1.0.0' },
        directories: { ...config.directories, output: firstFeed },
      },
    });
    const installer = (await readdir(firstFeed)).find((name) => name.endsWith('.exe'));
    assert.ok(installer);
    const installed = path.join(temporary, 'installed');
    await run(path.join(firstFeed, installer), ['/S', `/D=${installed}`], { timeout: 120000 });
    executable = path.join(installed, 'DabanUpdateFixture.exe');
  }
  let logs = '';
  child = spawn(executable, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (value) => {
    logs += String(value);
  });
  child.stderr?.on('data', (value) => {
    logs += String(value);
  });
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    if (
      await access(path.join(temporary, 'failure.json')).then(
        () => true,
        () => false,
      )
    )
      throw Error((await readFile(path.join(temporary, 'failure.json'), 'utf8')) + '\n' + logs);
    if (
      await access(path.join(temporary, 'result.json')).then(
        () => true,
        () => false,
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const resultFile = path.join(temporary, 'result.json');
  if (
    !(await access(resultFile).then(
      () => true,
      () => false,
    ))
  ) {
    const phase = await readFile(path.join(temporary, 'phase.json'), 'utf8').catch(
      () => 'unknown phase',
    );
    throw Error(`FIXTURE_UPDATE_TIMEOUT: ${phase}\n${logs}`);
  }
  const result = JSON.parse(await readFile(resultFile, 'utf8'));
  assert.equal(result.version, '1.1.0');
  assert.equal(result.workspacePreserved, true);
  assert.equal(result.savedBeforeRestart, true);
  assert.equal(result.runtimeCachedBeforeRestart, true);
  assert.equal(
    JSON.parse(await readFile(path.join(temporary, 'blocked.json'), 'utf8')).busyBlocked,
    true,
  );
  const cached = JSON.parse(await readFile(path.join(temporary, 'cache.json'), 'utf8'))
    .file as string;
  if (typeof cached === 'string' && cached.includes(path.basename(temporary)))
    cache = path.dirname(path.dirname(cached));
  console.log(
    JSON.stringify({
      platform: process.platform,
      realUpdater: true,
      versionChanged: '1.0.0 -> 1.1.0',
      busyBlocked: true,
      workspacePreserved: true,
      savedBeforeRestart: true,
      runtimeCachedBeforeRestart: true,
      publicReleaseCreated: false,
    }),
  );
} finally {
  if (process.platform === 'darwin') {
    // Relaunch replaces the original PID. Only this run's uniquely located fixture processes may be stopped.
    const canonical = await realpath(temporary);
    const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm=']);
    const owned = stdout
      .split('\n')
      .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
      .filter(
        (match): match is RegExpMatchArray =>
          !!match &&
          (match[2].startsWith(temporary + path.sep) ||
            match[2].startsWith(canonical + path.sep) ||
            match[2].includes(id)),
      );
    for (const match of owned)
      try {
        process.kill(Number(match[1]), 'SIGTERM');
      } catch {}
    if (owned.length) await new Promise((resolve) => setTimeout(resolve, 400));
  } else if (child?.pid && child.exitCode === null) {
    await run('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined);
  }
  await new Promise<unknown>((resolve) => server.close(() => resolve(undefined)));
  if (!cache) {
    try {
      const file = JSON.parse(await readFile(path.join(temporary, 'cache.json'), 'utf8'))
        .file as string;
      if (typeof file === 'string' && file.includes(path.basename(temporary)))
        cache = path.dirname(path.dirname(file));
    } catch {}
  }
  if (cache && path.basename(cache) === path.basename(temporary))
    // NSIS may still be returning after the relaunched app writes its success receipt.
    await rm(cache, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  if (process.platform === 'darwin') {
    await run('/bin/launchctl', ['bootout', `gui/${process.getuid?.()}/${id}.ShipIt`]).catch(
      () => undefined,
    );
    await rm(path.join(homedir(), 'Library/LaunchAgents', `${id}.ShipIt.plist`), { force: true });
    await rm(path.join(homedir(), 'Library/Caches', `${id}.ShipIt`), {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
    await rm(path.join(homedir(), 'Library/Caches', id), { recursive: true, force: true });
  }
  await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}

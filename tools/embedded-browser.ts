import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireDesktop = createRequire(path.join(root, 'apps/desktop/package.json'));
const electron: string = requireDesktop('electron');
const directory = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-check-'));
const fixture = path.join(root, 'outputs/embedded-browser/fixture.cjs');
function exit(child: ChildProcess, milliseconds = 120000) {
  return new Promise<unknown>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, milliseconds);
    child.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      code === 0 && !timedOut
        ? resolve(undefined)
        : reject(
            new Error(
              timedOut
                ? 'Embedded browser check timed out'
                : `Embedded browser check failed (${code})`,
            ),
          );
    });
  });
}
let server: ChildProcess | undefined;
let stopped: Promise<unknown> | undefined;
try {
  await build({ configFile: 'apps/desktop/electron/vite.config.ts', mode: 'preload' });
  await build({
    configFile: false,
    publicDir: false,
    base: './',
    define: { 'process.env.NODE_ENV': '"production"' },
    plugins: [react()],
    build: {
      target: 'es2022',
      outDir: path.join(path.dirname(fixture), 'ui'),
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: path.join(root, 'apps/desktop/acceptance/embedded-page.tsx'),
        formats: ['es'],
        fileName: () => 'ui.js',
        cssFileName: 'ui',
      },
    },
  });
  await writeFile(
    path.join(path.dirname(fixture), 'ui/index.html'),
    '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; img-src \'self\' data: blob:; connect-src \'none\'; object-src \'none\'"><link rel="stylesheet" href="./ui.css"></head><body><div id="root"></div><script type="module" src="./ui.js"></script></body></html>',
  );
  await build({
    configFile: false,
    publicDir: false,
    resolve: { conditions: ['node'], mainFields: ['module', 'main'] },
    build: {
      target: 'node22',
      outDir: path.dirname(fixture),
      emptyOutDir: false,
      minify: false,
      lib: {
        entry: path.join(root, 'apps/desktop/acceptance/embedded-browser.ts'),
        formats: ['cjs'],
        fileName: () => 'fixture.cjs',
      },
      rolldownOptions: {
        external: (id) =>
          id === 'electron' ||
          id === 'playwright' ||
          id.startsWith('node:') ||
          builtinModules.includes(id),
      },
    },
  });
  const smoke = spawn(electron, [fixture], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, DABAN_BROWSER_SMOKE_ROOT: path.join(directory, 'smoke') },
  });
  await exit(smoke, process.env.DABAN_BROWSER_HOLD === '1' ? 180000 : 40000);
  const profile = path.join(directory, 'workflow');
  server = spawn(electron, [fixture], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, DABAN_BROWSER_SERVER_ROOT: profile },
  });
  stopped = exit(server);
  stopped.catch(() => {});
  await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Embedded browser did not start')), 20000);
    let output = '';
    server!.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    server!.once('exit', () => {
      clearTimeout(timeout);
      reject(new Error('Embedded browser stopped during startup'));
    });
    server!.stdout!.on('data', (chunk: Buffer) => {
      output = (output + chunk.toString()).slice(-4096);
      if (output.includes('EMBEDDED_BROWSER_READY')) {
        clearTimeout(timeout);
        resolve(undefined);
      }
    });
  });
  const test = spawn(
    process.execPath,
    ['--experimental-sqlite', '--test', 'packages/engine/dist/host-browser.integration.js'],
    { cwd: root, stdio: 'inherit', env: { ...process.env, DABAN_EMBEDDED_BROWSER_ROOT: profile } },
  );
  await exit(test);
  server.stdin!.end('close\n');
  await stopped;
  server = undefined;
  stopped = undefined;
  await exit(
    spawn(electron, [fixture], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, DABAN_BROWSER_SERVER_ROOT: profile, DABAN_BROWSER_RESTART_CHECK: '1' },
    }),
  );
} finally {
  server?.stdin?.end('close\n');
  if (server && stopped) {
    const timer = setTimeout(() => server!.kill('SIGKILL'), 10000);
    try {
      await stopped.catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

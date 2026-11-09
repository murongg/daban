import { execFile, execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { build } from 'vite';
import { expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
  handler: undefined as undefined | ((event: unknown, command: unknown) => Promise<unknown>),
  windows: [] as { webContents: unknown }[],
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => mock.windows },
  clipboard: { writeText: () => {} },
  shell: { openExternal: async () => {} },
  ipcMain: {
    handle: (_name: string, handler: typeof mock.handler) => {
      mock.handler = handler;
    },
    removeHandler: () => {
      mock.handler = undefined;
    },
  },
}));

import { daemonScope } from './daemon';
import { runtimeService } from './service';
import { prepareAgentUpdate } from './upgrade';

const run = promisify(execFile);
it.skipIf(process.platform !== 'darwin' || process.env.DABAN_LAUNCHD_TEST !== '1')(
  'migrates a real scoped legacy launchd host only on confirmation, keeping workspace/VM markers intact',
  async () => {
    const root = await realpath(await mkdtemp('/tmp/mock-daban-legacy-'));
    const config = {
      dataRoot: path.join(root, 'data'),
      socketPath: path.join(root, 'agent.sock'),
      vmConfig: path.join(root, 'runtime.json'),
      entry: path.join(root, 'main.js'),
      executable: process.execPath,
    };
    const label = `dev.daban.agent.${daemonScope(config.dataRoot, config.vmConfig).slice(0, 32)}`,
      domain = `gui/${process.getuid!()}`,
      target = `${domain}/${label}`;
    let service: ReturnType<typeof runtimeService> | undefined;
    try {
      await mkdir(config.dataRoot, { mode: 0o700 });
      await writeFile(config.vmConfig, 'SYNTHETIC VM CONFIG', { mode: 0o600 });
      await writeFile(path.join(root, 'user-work.txt'), 'SYNTHETIC WORKSPACE RETAINED');
      await writeFile(path.join(root, 'vm-state.txt'), 'SYNTHETIC VM REMAINS RUNNING');
      await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
      await build({
        configFile: false,
        logLevel: 'silent',
        build: {
          target: 'node24',
          outDir: root,
          emptyOutDir: false,
          minify: false,
          lib: {
            entry: path.resolve('apps/desktop/electron/legacy.fixture.ts'),
            formats: ['es'],
            fileName: () => 'fixture.js',
          },
          rolldownOptions: { external: (id) => id.startsWith('node:') },
        },
      });
      await copyFile(path.join(root, 'fixture.js'), config.entry);
      await copyFile(path.join(root, 'fixture.js'), path.join(root, 'legacy.js'));
      const plist = path.join(config.dataRoot, 'agent.plist');
      const options = {
        Label: label,
        ProgramArguments: [
          process.execPath,
          '--expose-internals',
          path.join(root, 'legacy.js'),
          '--data',
          config.dataRoot,
          '--socket',
          config.socketPath,
          '--vm-config',
          config.vmConfig,
        ],
        WorkingDirectory: config.dataRoot,
        RunAtLoad: true,
        KeepAlive: { SuccessfulExit: false },
        StandardOutPath: path.join(root, 'legacy.log'),
        StandardErrorPath: path.join(root, 'legacy.log'),
      };
      const xml = execFileSync('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '-'], {
        input: JSON.stringify(options),
        encoding: 'utf8',
      });
      await writeFile(plist, xml, { mode: 0o600 });
      await run('/bin/launchctl', ['bootstrap', domain, plist]);
      const frame = { url: 'file:///synthetic/index.html' },
        sender = { mainFrame: frame, send: vi.fn() };
      mock.windows.push({ webContents: sender });
      service = runtimeService(root, frame.url, '/synthetic/environment', undefined, {
        ...config,
        nativeFirst: true,
      });
      let state = await service.connect();
      for (let attempt = 0; attempt < 30 && state.phase !== 'ready'; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        state = await service.connect();
      }
      expect(state.phase).toBe('ready');
      expect(state.protocolVersion).toBe(42);
      expect(state.setup?.error).toBe('AGENT_LEGACY_RESTART_REQUIRED');
      const reply = await mock.handler!(
        { senderFrame: frame, sender },
        { type: 'agent.upgrade', confirmed: true },
      );
      expect(reply, JSON.stringify(reply)).toMatchObject({
        ok: true,
        value: {
          phase: 'ready',
          protocolVersion: 43,
          agent: { execution: 'local-workspace' },
        },
      });
      // Linux setup is reported by the background poll after the new Agent is ready.
      await vi.waitFor(
        async () => {
          expect(
            await mock.handler!({ senderFrame: frame, sender }, { type: 'status' }),
          ).toMatchObject({
            ok: true,
            value: { setup: { required: false, target: 'linux', phase: 'existing' } },
          });
        },
        { timeout: 3000 },
      );
      expect(await readFile(path.join(root, 'user-work.txt'), 'utf8')).toBe(
        'SYNTHETIC WORKSPACE RETAINED',
      );
      expect(await readFile(path.join(root, 'vm-state.txt'), 'utf8')).toBe(
        'SYNTHETIC VM REMAINS RUNNING',
      );
    } finally {
      await service?.close();
      await run('/bin/launchctl', ['bootout', target]).catch(() => {});
      // The native replacement is detached from launchd and must also leave the disposable scope.
      await prepareAgentUpdate({
        ...config,
        scope: daemonScope(config.dataRoot, config.vmConfig),
      }).catch(() => {});
      mock.windows.length = 0;
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

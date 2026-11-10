import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import type { RequestListener, Server } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { expect, test } from 'vitest';
import { packageNative } from './native.ts';

test('the bundled native channel uses Node cryptography when generating a Windows TLS certificate', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-native-bundle-'));
  try {
    await build({
      configFile: 'apps/desktop/electron/vite.config.ts',
      logLevel: 'silent',
      build: {
        outDir: directory,
        lib: {
          entry: fileURLToPath(
            new URL('../packages/engine/src/private-channel.ts', import.meta.url),
          ),
          formats: ['cjs'],
          fileName: () => 'channel.cjs',
        },
      },
    });
    const generated = createRequire(import.meta.url)(path.join(directory, 'channel.cjs')) as {
      privateServer(
        listener: RequestListener,
        certificateFile: string,
        platform: NodeJS.Platform,
      ): Promise<{ server: Server }>;
    };
    const channel = await generated.privateServer(
      (_req, res) => res.end(),
      path.join(directory, 'mock.pem'),
      'win32',
    );
    expect(channel.server.listening).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== 'darwin' && process.platform !== 'win32')(
  'loads the staged Cua SDK in Electron outside the workspace',
  async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mock-native-dependencies-'));
    try {
      const owner = fileURLToPath(new URL('../apps/desktop/package.json', import.meta.url));
      await packageNative(directory, owner);
      const electron = createRequire(owner)('electron') as string;
      const output = execFileSync(
        electron,
        [
          '--input-type=module',
          '-e',
          "import { CuaDriver } from '@trycua/cua-driver'; const driver = CuaDriver.create({ embedded: true }); await driver.shutdown(); driver.uniffiDestroy(); console.log('staged SDK loaded')",
        ],
        {
          cwd: directory,
          encoding: 'utf8',
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            CUA_DRIVER_RS_TELEMETRY_ENABLED: 'false',
          },
          timeout: 15000,
        },
      );
      expect(output.trim()).toBe('staged SDK loaded');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

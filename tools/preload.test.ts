import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { RuntimeBridge } from '@daban/protocol';
import { build } from 'vite';
import { expect, test } from 'vitest';

test('the production preload exposes its validated bridge without requiring files outside the Electron sandbox', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daban-preload-'));
  try {
    const configFile = 'apps/desktop/electron/vite.config.ts';
    await build({ configFile, logLevel: 'silent', build: { outDir: directory } });
    await build({
      configFile,
      mode: 'preload',
      logLevel: 'silent',
      build: { outDir: directory, emptyOutDir: false },
    });
    let exposed: unknown;
    const calls: unknown[][] = [];
    runInNewContext(await readFile(join(directory, 'preload.cjs'), 'utf8'), {
      process: { platform: 'darwin' },
      require: (name: string) => {
        expect(name, 'SANDBOX_CANNOT_REQUIRE_LOCAL_CHUNKS').toBe('electron');
        return {
          contextBridge: {
            exposeInMainWorld(key: string, value: unknown) {
              expect(key).toBe('daban');
              exposed = value;
            },
          },
          ipcRenderer: {
            invoke: async (...args: unknown[]) => {
              calls.push(args);
              return { ok: true, value: 'SYNTHETIC READY' };
            },
          },
        };
      },
    });
    expect.assert(exposed && typeof exposed === 'object' && 'runtime' in exposed);
    const bridge = exposed as { runtime: RuntimeBridge };
    const command = { type: 'status' } as const;
    expect((await bridge.runtime.invoke(command)).ok).toBe(true);
    expect(calls).toStrictEqual([['daban:runtime', command]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

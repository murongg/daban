import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import type { RuntimeBridge } from '@daban/protocol';
import { build } from 'vite';

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
        assert.equal(name, 'electron', 'SANDBOX_CANNOT_REQUIRE_LOCAL_CHUNKS');
        return {
          contextBridge: {
            exposeInMainWorld(key: string, value: unknown) {
              assert.equal(key, 'daban');
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
    assert.ok(exposed && typeof exposed === 'object' && 'runtime' in exposed);
    const bridge = exposed as { runtime: RuntimeBridge };
    const command = { type: 'status' } as const;
    assert.equal((await bridge.runtime.invoke(command)).ok, true);
    assert.deepEqual(calls, [['daban:runtime', command]]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

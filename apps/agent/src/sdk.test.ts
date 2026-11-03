import childProcess, { type SpawnOptions } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client';
import { expect, test, vi } from 'vitest';
import { resolveSdk } from './sdk.js';

test('agent resolves its owned SDK entry only when both SDK and DSH match the pinned version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-agent-sdk-'));
  const owner = join(root, 'package.json');
  const client = join(root, 'node_modules/@deepseek-ai/dsh-sdk-client');
  const runtime = join(root, 'node_modules/@deepseek-ai/dsh');
  try {
    await mkdir(client, { recursive: true });
    await mkdir(runtime, { recursive: true });
    await writeFile(owner, '{"name":"mock-agent"}');
    await writeFile(join(client, 'index.js'), '');
    const manifest = (name: string, version: string) =>
      JSON.stringify({
        name,
        version,
        main: 'index.js',
        exports: { '.': './index.js', './package.json': './package.json' },
      });
    await writeFile(
      join(client, 'package.json'),
      manifest('@deepseek-ai/dsh-sdk-client', '0.2.1-rc.3'),
    );
    await writeFile(join(runtime, 'package.json'), manifest('@deepseek-ai/dsh', '0.2.1-rc.3'));
    expect(resolveSdk(owner)).toBe(await realpath(join(client, 'index.js')));
    await writeFile(join(runtime, 'package.json'), manifest('@deepseek-ai/dsh', '0.2.1-rc.4'));
    expect(() => resolveSdk(owner)).toThrowError(
      expect.objectContaining({
        name: 'Error',
        message: expect.stringMatching(/^AGENT_SDK_VERSION_UNSUPPORTED$/),
      }),
    );
    await writeFile(join(runtime, 'package.json'), manifest('@deepseek-ai/dsh', '0.2.1-rc.3'));
    await writeFile(
      join(client, 'package.json'),
      manifest('@deepseek-ai/dsh-sdk-client', '0.2.1-rc.4'),
    );
    expect(() => resolveSdk(owner)).toThrowError(
      expect.objectContaining({
        name: 'Error',
        message: expect.stringMatching(/^AGENT_SDK_VERSION_UNSUPPORTED$/),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('agent reports unavailable SDK packages without exposing resolution diagnostics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mock-agent-sdk-missing-'));
  try {
    const owner = join(root, 'package.json');
    await writeFile(owner, '{"name":"mock-agent"}');
    expect(() => resolveSdk(owner)).toThrowError(
      expect.objectContaining({
        name: 'Error',
        message: expect.stringMatching(/^AGENT_SDK_UNAVAILABLE$/),
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the installed SDK starts background runtimes without a Windows console and preserves stdio transport', () => {
  let options: SpawnOptions | undefined;
  const launch = vi.spyOn(childProcess, 'spawn').mockImplementation((_program, _args, value) => {
    options = value;
    throw Error('SYNTHETIC_PROCESS_CAPTURED');
  });
  syncBuiltinESMExports();
  try {
    const directory = path.resolve('mock-project');
    const harness = new DeepSeekHarness({
      profile: 'sdk-minimal',
      processCwd: directory,
      dshHome: path.join(directory, 'mock-dsh'),
      env: { SYNTHETIC_ENV: 'mock-value' },
    });
    expect(() => harness.client.start()).toThrow('SYNTHETIC_PROCESS_CAPTURED');
    expect(options?.windowsHide).toBe(true);
    expect(options?.stdio).toEqual(['pipe', 'pipe', 'pipe']);
    expect(options?.cwd).toBe(directory);
    expect(options?.env?.SYNTHETIC_ENV).toBe('mock-value');
    expect(options?.env?.DABAN_MODEL_KEY).toBeUndefined();
  } finally {
    launch.mockRestore();
    syncBuiltinESMExports();
  }
});

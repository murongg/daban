import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { expect, test } from 'vitest';
import { patchSdk, sdkWindowsSource } from './sdk.ts';

const source = `
const instance = {
  runtime: { command: 'mock-node', args: ['mock-entry'], cwd: 'mock-project', environment: () => ({ SYNTHETIC_ENV: 'mock' }) },
  start() {
    const child = spawn(this.runtime.command, this.runtime.args, {
      cwd: this.runtime.cwd,
      env: this.runtime.environment(),
      stdio: ['pipe', 'pipe', 'pipe']
    });
    return child;
  }
};
instance.start();
`;
const patched = source.replace(
  'const child = spawn(this.runtime.command, this.runtime.args, {',
  'const child = spawn(this.runtime.command, this.runtime.args, {\n\t\t\twindowsHide: true,',
);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const integrity = { before: hash(source), after: hash(patched) };

test('the pinned SDK patch hides the console without replacing process ownership, environment or stdio', () => {
  const launch = { program: '', args: [] as string[], options: {} as Record<string, unknown> };
  runInNewContext(sdkWindowsSource(source, integrity), {
    spawn(program: string, args: string[], options: Record<string, unknown>) {
      Object.assign(launch, { program, args, options });
      return {};
    },
  });
  expect(launch.program).toBe('mock-node');
  expect(launch.args).toEqual(['mock-entry']);
  expect(launch.options).toEqual({
    windowsHide: true,
    cwd: 'mock-project',
    env: { SYNTHETIC_ENV: 'mock' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  expect(sdkWindowsSource(patched, integrity)).toBe(patched);
  expect(() => sdkWindowsSource(source + '\n', integrity)).toThrow('SDK_WINDOWS_PATCH_UNSUPPORTED');
});

test('SDK packaging refuses unknown dependency bytes or versions and leaves their files untouched', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-sdk-patch-'));
  const directory = path.join(root, 'node_modules/@deepseek-ai/dsh-sdk-client');
  const entry = path.join(directory, 'index.js');
  const manifest = path.join(directory, 'package.json');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{}');
    const metadata = {
      name: '@deepseek-ai/dsh-sdk-client',
      version: '0.2.1-rc.3',
      main: 'index.js',
    };
    await writeFile(manifest, JSON.stringify(metadata));
    await writeFile(entry, source);
    await patchSdk(path.join(root, 'package.json'), integrity);
    expect(await readFile(entry, 'utf8')).toBe(patched);
    await patchSdk(path.join(root, 'package.json'), integrity);
    await writeFile(entry, 'SYNTHETIC UNKNOWN SDK');
    await expect(patchSdk(path.join(root, 'package.json'), integrity)).rejects.toThrow(
      'SDK_WINDOWS_PATCH_UNSUPPORTED',
    );
    expect(await readFile(entry, 'utf8')).toBe('SYNTHETIC UNKNOWN SDK');
    await writeFile(entry, source);
    await writeFile(manifest, JSON.stringify({ ...metadata, version: '0.0.0-mock' }));
    await expect(patchSdk(path.join(root, 'package.json'), integrity)).rejects.toThrow(
      'SDK_WINDOWS_PATCH_UNSUPPORTED',
    );
    expect(await readFile(entry, 'utf8')).toBe(source);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

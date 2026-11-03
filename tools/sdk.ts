import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

interface Integrity {
  before: string;
  after: string;
}
const integrity: Integrity = {
  before: '0d6af62fb2486af56d341a18d203092d5d594cf60996d80f627bfb12a9ea4ffc',
  after: '2a12437690dd2fa3f31afa62d81e4d360b7bf7152eaf2b0ab656ca7126e2825b',
};
const hash = (source: string) => createHash('sha256').update(source).digest('hex');

export function sdkWindowsSource(source: string, expected: Integrity = integrity) {
  const actual = hash(source);
  if (actual === expected.after) return source;
  const marker = 'const child = spawn(this.runtime.command, this.runtime.args, {';
  if (actual !== expected.before || source.split(marker).length !== 2)
    throw Error('SDK_WINDOWS_PATCH_UNSUPPORTED');
  // DSH 0.2.1-rc.3 has no public spawn-options hook. Remove this pinned patch once upstream hides its SDK console.
  const patched = source.replace(marker, marker + '\n\t\t\twindowsHide: true,');
  if (hash(patched) !== expected.after) throw Error('SDK_WINDOWS_PATCH_UNSUPPORTED');
  return patched;
}

export async function patchSdk(owner: string, expected: Integrity = integrity) {
  const requireSdk = createRequire(path.resolve(owner));
  const manifestFile = requireSdk.resolve('@deepseek-ai/dsh-sdk-client/package.json');
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as { version?: string };
  if (manifest.version !== '0.2.1-rc.3') throw Error('SDK_WINDOWS_PATCH_UNSUPPORTED');
  const file = requireSdk.resolve('@deepseek-ai/dsh-sdk-client');
  const metadata = await lstat(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1)
    throw Error('SDK_WINDOWS_PATCH_UNSAFE');
  const original = await readFile(file, 'utf8');
  const patched = sdkWindowsSource(original, expected);
  if (patched !== original) await writeFile(file, patched);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const owner =
    process.argv[2] || fileURLToPath(new URL('../apps/agent/package.json', import.meta.url));
  await patchSdk(owner);
  console.log('Verified SDK background-console compatibility patch.');
}

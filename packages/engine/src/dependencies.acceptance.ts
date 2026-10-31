import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import path from 'node:path';
import { sdkPatch } from './model.js';

// Build-time metadata/RPC self-check. The caller supplies an empty network namespace; no inference is requested.
assert.equal(process.platform, 'linux');
assert.equal(userInfo().username, 'bot-prototype');
const root = await mkdtemp('/var/lib/bot-prototype/verify-dependencies-');
interface Session {
  setWorkingDirectory(directory: string): Promise<string>;
  getWorkingDirectory(): Promise<string>;
}
interface Harness {
  start(): Promise<unknown>;
  close(): Promise<unknown>;
  session(): Session;
}
const sdkUrl =
  'file:///opt/bot-prototype/dsh/node_modules/@deepseek-ai/dsh-sdk-client/lib/index.js';
const module = (await import(sdkUrl)) as {
  DeepSeekHarness: new (options: Record<string, unknown>) => Harness;
};
const patch = path.join(root, 'metadata.patch.json');
await writeFile(
  patch,
  JSON.stringify(
    sdkPatch(
      'http://127.0.0.1:8766',
      'mock-build-check',
      'synthetic-local-control',
      undefined,
      60,
      'deepseek-flash',
    ).map((row) =>
      'insert' in row
        ? { ...row, insert: row.insert.filter((item) => item.id !== 'computer-tools') }
        : row,
    ),
  ),
  { mode: 0o600 },
);
await mkdir(path.join(root, 'workspace'), { mode: 0o700 });
const directory = path.join(root, 'workspace');
const harness = new module.DeepSeekHarness({
  profile: 'sdk-minimal',
  patches: [patch],
  dshHome: path.join(root, 'dsh'),
  processCwd: directory,
  cwd: directory,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  initializeTimeoutMs: 40000,
  env: {
    PATH: '/opt/bot-prototype/node/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    DEEPSEEK_API_KEY: 'synthetic-build-key-never-used-for-inference',
  },
});
try {
  await harness.start();
  const session = harness.session();
  assert.equal(typeof session.setWorkingDirectory, 'function');
  assert.equal(
    await realpath(await session.setWorkingDirectory(directory)),
    await realpath(directory),
  );
  assert.equal(await realpath(await session.getWorkingDirectory()), await realpath(directory));
  console.log(
    JSON.stringify({
      nativeSdkInitialized: true,
      applicationProviderPatchUsed: true,
      sessionDirectoryApiVerified: true,
      networkNamespaceIsolatedByCaller: true,
      inferenceCalls: 0,
      providerKeySyntheticOnly: true,
    }),
  );
} finally {
  await harness.close();
  await rm(root, { recursive: true, force: true });
}

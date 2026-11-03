import assert from 'node:assert/strict';
import { lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVmConnection } from '@daban/engine/host';
import type { QemuMode } from '@daban/protocol';

const repository = fileURLToPath(new URL('..', import.meta.url));
const { QemuSetup }: typeof import('../apps/agent/src/qemu-setup.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qemu-setup.js')).href
);
const [bundleDirectory, directory, mode] = process.argv.slice(2);
assert.ok(
  bundleDirectory && directory && (mode === 'tcg' || mode === 'whpx'),
  'Usage: qemu-install.acceptance.ts <bundle-directory> <new-agent-directory> tcg|whpx',
);
const dataRoot = path.resolve(directory);
assert.equal(
  await lstat(dataRoot).then(
    () => true,
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return false;
    },
  ),
  false,
);
const setup = new QemuSetup({
  dataRoot,
  vmConfigFile: path.join(dataRoot, 'runtime.json'),
  bundleDirectory: path.resolve(bundleDirectory),
});
const started = Date.now();
let phase = '';
const timer = setInterval(() => {
  setup
    .status()
    .then((status) => {
      if (phase !== status.phase) {
        phase = status.phase;
        console.log(phase, status.error ?? '');
      }
    })
    .catch(() => {});
}, 2000);
try {
  const initial = await setup.status();
  assert.equal(initial.phase, 'available');
  const accepted = await setup.start(mode as QemuMode);
  assert.notEqual(
    accepted.phase,
    'waiting',
    'Real WHPX is not available; restart Windows before hardware acceptance.',
  );
  await setup.settled;
  const complete = await setup.status();
  assert.equal(complete.required, false, JSON.stringify(complete));
  assert.equal(complete.phase, 'complete');
  const config = await readVmConnection(path.join(dataRoot, 'runtime.json'));
  assert.ok(config?.enabled && config.provider === 'qemu');
  const result = {
    passed: true,
    acceleration: mode,
    vmId: config.vmId,
    elapsedMs: Date.now() - started,
    windows: initial.windows,
    manualGuestCommands: false,
    manualConnectionFields: false,
    bundledEnvironment: true,
  };
  await writeFile(path.join(dataRoot, 'installation-result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  clearInterval(timer);
  await setup.close();
}

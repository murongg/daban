import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readVmConnection, saveVmConnection } from '@daban/engine/host';

const repository = fileURLToPath(new URL('..', import.meta.url));
const { QemuSetup }: typeof import('../apps/agent/src/qemu-setup.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qemu-setup.js')).href
);
const [directory] = process.argv.slice(2);
assert.ok(directory);
const dataRoot = path.resolve(directory),
  file = path.join(dataRoot, 'runtime.json');
const receipt = JSON.parse(
  await readFile(path.join(dataRoot, 'installation-result.json'), 'utf8'),
) as { passed: boolean; vmId: string };
const connection = await readVmConnection(file);
assert.ok(
  receipt.passed &&
    connection?.provider === 'qemu' &&
    connection.enabled &&
    connection.vmId === receipt.vmId,
);
const machine = await readFile(path.join(dataRoot, 'qemu/machine.json'), 'utf8');
const setup = new QemuSetup({
  dataRoot,
  vmConfigFile: file,
  bundleDirectory: path.join(dataRoot, 'mock-removed-old-app-bundle'),
});
try {
  await saveVmConnection(file, { ...connection, enabled: false });
  const status = await setup.start();
  assert.equal(status.error, undefined, JSON.stringify(status));
  await setup.settled;
  assert.equal((await setup.status()).required, false, JSON.stringify(await setup.status()));
  assert.equal((await readVmConnection(file))?.vmId, connection.vmId);
  assert.equal(await readFile(path.join(dataRoot, 'qemu/machine.json'), 'utf8'), machine);
  await writeFile(
    path.join(dataRoot, 'reuse-result.json'),
    JSON.stringify({
      passed: true,
      vmId: connection.vmId,
      oldAppBundleRequired: false,
      machineRecreated: false,
    }),
  );
  console.log(
    'Existing VM re-enabled without its old application bundle or any disk/identity replacement.',
  );
} finally {
  await setup.close();
  const current = await readVmConnection(file);
  if (current?.vmId === connection.vmId && !current.enabled)
    await saveVmConnection(file, connection);
}

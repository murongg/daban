import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractArchive } from '@daban/engine/archive';
import { qemuIndex, windowsEnvironment } from '@daban/engine/component';
import { secureDirectory } from '@daban/engine/local-computer';

const [archive, report] = process.argv.slice(2);
assert.ok(archive && report, 'Usage: qemu-download.acceptance.ts <environment.zip> <report.json>');
const repository = fileURLToPath(new URL('..', import.meta.url));
const install: typeof import('../apps/agent/src/qemu-install.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qemu-install.js')).href
);
const qemu: typeof import('../apps/agent/src/qemu.ts') = await import(
  pathToFileURL(path.join(repository, 'dist-agent/qemu.js')).href
);
const reference = qemuIndex(windowsEnvironment);
const temporary = await mkdtemp(path.join(tmpdir(), 'daban-environment-inspect-'));
const cleanup = async () => {
  const resolved = path.resolve(temporary);
  assert.equal(path.dirname(resolved), path.resolve(tmpdir()));
  assert.ok(path.basename(resolved).startsWith('daban-environment-inspect-'));
  await rm(resolved, { recursive: true, force: true });
};
try {
  const target = await secureDirectory(path.join(temporary, 'private'));
  const actual = await qemu.qemuFileHash(path.resolve(archive));
  assert.equal(actual.bytes, reference.bytes);
  assert.equal(actual.sha256, reference.sha256);
  assert.equal(
    await extractArchive(path.resolve(archive), target, {
      sha256: reference.sha256,
      maxBytes: reference.unpackedBytes,
    }),
    reference.unpackedBytes,
  );
  const bundle = await install.readQemuBundle(target);
  await assert.rejects(lstat(path.join(target, 'desktop.qcow2')), { code: 'ENOENT' });
  await qemu.verifyQemuTools(bundle, target);
  assert.deepEqual(await qemu.qemuFileHash(path.join(target, 'desktop.qcow2.gz')), {
    bytes: bundle.image.bytes,
    sha256: bundle.image.sha256,
  });
  const result = {
    passed: true,
    reference,
    toolsId: bundle.toolsId,
    image: bundle.image,
    unpackedRawBuildDisk: false,
  };
  await writeFile(path.resolve(report), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await cleanup();
}

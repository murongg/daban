import { copyFile, cp, lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createArchive } from '@daban/engine/archive';
import { qemuFilename, qemuIndex, qemuTag, windowsEnvironment } from '@daban/engine/component';
import { secureDirectory } from '@daban/engine/local-computer';
import { publishComponent, verifyPublishedComponent } from './component-release.ts';
import { hashAsset } from './environment.ts';

export async function archiveQemu(source: string, output: string) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const install: typeof import('../apps/agent/src/qemu-install.ts') = await import(
    pathToFileURL(path.join(root, 'dist-agent/qemu-install.js')).href
  );
  const qemu: typeof import('../apps/agent/src/qemu.ts') = await import(
    pathToFileURL(path.join(root, 'dist-agent/qemu.js')).href
  );
  const bundle = await install.readQemuBundle(source);
  const image = await qemu.qemuFileHash(path.join(source, 'desktop.qcow2.gz'));
  if (image.bytes !== bundle.image.bytes || image.sha256 !== bundle.image.sha256)
    throw Error('QEMU_ASSET_INTEGRITY');
  await qemu.verifyQemuTools(bundle, source);
  for (const name of ['COMPONENTS.md', 'provenance.json'])
    await qemu.qemuFileHash(path.join(source, name));
  const target = path.resolve(output);
  const exists = await lstat(target).then(
    () => true,
    (error) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
        return false;
      throw error;
    },
  );
  if (exists) throw Error('QEMU_OUTPUT_EXISTS');
  await secureDirectory(target);
  const stage = await mkdtemp(path.join(target, '.stage-'));
  await secureDirectory(stage);
  const cleanup = async () => {
    if (path.dirname(path.resolve(stage)) !== target) throw Error('QEMU_STAGE_UNSAFE');
    await rm(stage, { recursive: true, force: true });
  };
  try {
    // Publish only sealed distribution resources. Mutable build disks and identities stay local.
    for (const name of ['qemu.json', 'desktop.qcow2.gz', 'COMPONENTS.md', 'provenance.json'])
      await copyFile(path.join(source, name), path.join(stage, name));
    await cp(path.join(source, 'tools'), path.join(stage, 'tools'), {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    const file = path.join(target, qemuFilename());
    const archive = await createArchive(stage, file);
    const reference = qemuIndex({
      version: 1,
      protocol: bundle.protocol,
      ...archive,
      requiredBytes:
        archive.bytes + archive.unpackedBytes + bundle.image.expandedBytes + 4 * 1024 ** 3,
    });
    await writeFile(path.join(target, 'qemu.json'), JSON.stringify(reference, null, 2) + '\n', {
      flag: 'wx',
      mode: 0o600,
    });
    return { file, reference };
  } finally {
    await cleanup();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, source, output] = process.argv.slice(2);
  if (action === 'build' && source && output)
    console.log(JSON.stringify(await archiveQemu(path.resolve(source), path.resolve(output))));
  else if (action === 'verify') {
    const reference = qemuIndex(windowsEnvironment);
    await verifyPublishedComponent(qemuTag(reference), qemuFilename(), reference);
    console.log('Windows environment release verified.');
  } else if (action === 'publish' && source && output) {
    const reference = qemuIndex(windowsEnvironment);
    const file = path.resolve(source);
    const actual = await hashAsset(file, 'sha256');
    if (
      path.basename(file) !== qemuFilename() ||
      actual.bytes !== reference.bytes ||
      actual.digest !== reference.sha256
    )
      throw Error('QEMU_ASSET_INTEGRITY');
    await publishComponent(qemuTag(reference), output, [file]);
    await verifyPublishedComponent(qemuTag(reference), qemuFilename(), reference);
    console.log('Windows environment release published and verified.');
  } else
    throw Error(
      'Usage: qemu-release.ts build <sealed-environment> <new-output-directory> | publish <archive> <commit> | verify',
    );
}

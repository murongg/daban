import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { componentAsset, componentIndex } from '@daban/engine/component';
import { secureDirectory } from '@daban/engine/local-computer';
import {
  type ComponentInstallation,
  componentPaths,
  extractComponent,
  verifyComponent,
} from '../apps/desktop/electron/component-install.ts';
import { withComponentStage } from './components.ts';
import { hashAsset } from './environment.ts';

export async function withVerifiedComponent(
  {
    reference,
    ...installation
  }: Omit<ComponentInstallation, 'directory' | 'signal'> & {
    reference: unknown;
  },
  inspect: (directory: string, sha256: string) => Promise<unknown>,
) {
  const { id, platform, arch, archive } = installation;
  const asset = componentAsset(componentIndex(reference, id), platform, arch);
  const integrityStarted = performance.now();
  assert.equal((await stat(archive)).size, asset.bytes);
  assert.equal((await hashAsset(archive, 'sha256')).digest, asset.sha256);
  console.log(`runtime:archive-integrity: ${Math.round(performance.now() - integrityStarted)}ms`);

  await withComponentStage(async (temporary) => {
    // Extraction must inherit private ACLs rather than the Windows shared temp permissions.
    const directory = await secureDirectory(path.join(temporary, 'private'));
    const extractionStarted = performance.now();
    await extractComponent(archive, directory, platform);
    console.log(`runtime:extract: ${Math.round(performance.now() - extractionStarted)}ms`);
    const verificationStarted = performance.now();
    await verifyComponent({ ...installation, directory });
    console.log(`runtime:verify: ${Math.round(performance.now() - verificationStarted)}ms`);
    assert.equal(
      execFileSync(componentPaths(directory, platform).executable, ['--version'], {
        encoding: 'utf8',
      }).trim(),
      'v24.22.1',
    );
    await inspect(directory, asset.sha256);
  });
  console.log('Verified downloaded runtime integrity, publisher trust and standalone Node.');
}

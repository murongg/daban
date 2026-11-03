import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { publishComponent } from './component-release.ts';
import { hashAsset } from './environment.ts';

test('runtime publication never overwrites an existing asset and checks its digest', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-runtime-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Daban-runtime-macos-arm64.zip');
  await writeFile(file, 'SYNTHETIC SIGNED ARCHIVE');
  const digest = (await hashAsset(file, 'sha256')).digest;
  const calls: string[][] = [];
  let remote = digest;
  const run = async (args: string[]) => {
    calls.push(args);
    return JSON.stringify({
      assets: [{ name: path.basename(file), digest: `sha256:${remote}`, size: 24 }],
    });
  };
  await publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), [file], run);
  assert.equal(calls.length, 1);
  remote = 'c'.repeat(64);
  await assert.rejects(
    publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), [file], run),
    /COMPONENT_RELEASE_CONFLICT/,
  );
  assert.equal(
    calls.some((args) => args.includes('upload')),
    false,
  );
});

test('checks uploaded runtime digests before allowing the desktop release to continue', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-runtime-publish-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'Daban-runtime-windows-x64.zip');
  await writeFile(file, 'SYNTHETIC WINDOWS ARCHIVE');
  const digest = (await hashAsset(file, 'sha256')).digest;
  let created = false,
    inspections = 0;
  const run = async (args: string[]) => {
    if (args[0] === 'api') {
      inspections++;
      if (!created) throw Object.assign(Error('not found'), { stderr: 'HTTP 404' });
      return JSON.stringify({
        assets: [
          {
            name: path.basename(file),
            size: Buffer.byteLength('SYNTHETIC WINDOWS ARCHIVE'),
            digest: `sha256:${digest}`,
          },
        ],
      });
    }
    assert.deepEqual(args.slice(0, 2), ['release', 'create']);
    assert.ok(args.includes('--latest=false'));
    created = true;
    return '';
  };
  await publishComponent('runtime-' + 'a'.repeat(24), 'b'.repeat(40), [file], run);
  assert.equal(inspections, 2);
});

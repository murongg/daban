import assert from 'node:assert/strict';
import test from 'node:test';
import { releaseVersion } from './release.ts';

test('accepts stable and prerelease tags only when all workspace versions agree', () => {
  assert.equal(releaseVersion('v1.2.3', ['1.2.3', '1.2.3']), '1.2.3');
  assert.equal(releaseVersion('v1.2.3-beta.1', ['1.2.3-beta.1']), '1.2.3-beta.1');
  for (const tag of ['main', 'v01.2.3', 'v1.2', 'v1.2.3;echo injected', 'v1.2.3\n'])
    assert.throws(() => releaseVersion(tag, ['1.2.3']), /RELEASE_TAG/);
  assert.throws(() => releaseVersion('v1.2.3', ['1.2.3', '1.2.2']), /RELEASE_VERSION/);
});

import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import {
  botReleaseText,
  compareReleaseVersions,
  isBotRelease,
  mergeRelease,
  parseBotRelease,
} from '../packages/protocol/src/releases.js';
import { syntheticRelease } from './testing/releases.js';

describe('portable Bot releases', () => {
  test('freezes the cross-platform canonical contract', () => {
    const release = syntheticRelease();
    const text = botReleaseText(release);
    expect(Buffer.byteLength(text)).toBe(567);
    expect(createHash('sha256').update(text).digest('hex')).toBe(
      'a31e10907bbc628a8b3f913b3ef82f2c0ee4c403b3a9e1dc62f1f5ed3d490631',
    );
    expect(parseBotRelease(JSON.stringify(release, null, 2))).toEqual(release);
    expect(() => parseBotRelease(JSON.stringify(release, null, 2), true)).toThrow(
      'NON_CANONICAL_PACKAGE',
    );
  });

  test('rejects duplicate JSON keys, unknown fields, malformed text and excessive nesting', () => {
    const text = botReleaseText(syntheticRelease());
    expect(() => parseBotRelease(text.replace('"version":3', '"version":3,"version":3'))).toThrow();
    expect(isBotRelease({ ...syntheticRelease(), token: 'synthetic-secret' })).toBe(false);
    const release = syntheticRelease();
    release.definition.profile.instructions = '\ud800';
    expect(isBotRelease(release)).toBe(false);
    expect(() => parseBotRelease('['.repeat(17) + ']'.repeat(17))).toThrow();
    expect(compareReleaseVersions('1.10.0', '1.2.0')).toBe(1);
    expect(() => compareReleaseVersions('01.0.0', '1.0.0')).toThrow();
    expect(() => parseBotRelease(JSON.stringify({ ...syntheticRelease(), version: 4 }))).toThrow(
      'UNSUPPORTED_PACKAGE_VERSION',
    );
  });

  test('preserves original bytes and checks stable keys, names, paths and skill main files', () => {
    const release = syntheticRelease();
    release.manifest.requires.capabilities.push('skill-packages-v1');
    const content =
      '\ufeff---\nname: mock-outline\ndescription: Synthetic outline\n---\nSynthetic only.\r\n';
    release.definition.skills = [
      {
        key: 'outline',
        package: {
          root: 'mock-outline',
          files: [
            { path: 'SKILL.md', data: Buffer.from(content).toString('base64'), executable: false },
          ],
        },
      },
    ];
    expect(parseBotRelease(botReleaseText(release))).toEqual(release);
    release.definition.skills.push(structuredClone(release.definition.skills[0]));
    expect(isBotRelease(release)).toBe(false);
    release.definition.skills.pop();
    release.definition.skills[0].package.files[0].path = '../SKILL.md';
    expect(isBotRelease(release)).toBe(false);
    release.definition.skills[0].package.files[0].path = 'SKILL.md';
    release.definition.skills[0].package.files[0].data = Buffer.from([255]).toString('base64');
    expect(isBotRelease(release)).toBe(false);
  });
});

describe('three-way release upgrade', () => {
  test('combines independent changes and retains deletions', () => {
    const base = syntheticRelease().definition;
    base.knowledge = [{ key: 'manual', path: 'mock.md', content: 'SYNTHETIC A' }];
    const local = structuredClone(base);
    local.profile.instructions = 'SYNTHETIC LOCAL';
    local.knowledge = [];
    const target = structuredClone(base);
    target.defaultPreferences = 'SYNTHETIC UPSTREAM';
    const result = mergeRelease(base, local, target);
    expect(result.conflicts).toEqual([]);
    expect(result.definition.profile.instructions).toBe('SYNTHETIC LOCAL');
    expect(result.definition.defaultPreferences).toBe('SYNTHETIC UPSTREAM');
    expect(result.definition.knowledge).toEqual([]);
  });

  test('requires explicit decisions for changes versus deletions and rebase preserves the choice', () => {
    const base = syntheticRelease().definition;
    base.knowledge = [{ key: 'manual', path: 'mock.md', content: 'SYNTHETIC A' }];
    const local = structuredClone(base);
    local.knowledge[0].content = 'SYNTHETIC LOCAL';
    const target = structuredClone(base);
    target.knowledge = [];
    expect(mergeRelease(base, local, target).conflicts).toEqual(['knowledge:manual']);
    const resolved = mergeRelease(base, local, target, { 'knowledge:manual': 'local' });
    expect(resolved.conflicts).toEqual([]);
    expect(resolved.definition.knowledge).toEqual(local.knowledge);
    expect(mergeRelease(target, resolved.definition, target).definition.knowledge).toEqual(
      local.knowledge,
    );
  });
});

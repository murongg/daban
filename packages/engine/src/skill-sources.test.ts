import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const entry = new URL('./skill-sources.js', import.meta.url).href;
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const blobHash = (value: string) =>
  createHash('sha1')
    .update(`blob ${Buffer.byteLength(value)}\0`)
    .update(value)
    .digest('hex');
const main =
  '---\nname: mock-source\ndescription: Synthetic source skill\n---\nRead references/guide.txt.\n';
test('normalizes public registry search without credentials or executing install commands', async () => {
  const { SkillSources } = await import(entry);
  const calls: string[] = [];
  const sources = new SkillSources(async (url: string) => {
    calls.push(url);
    if (url.startsWith('https://skills.sh/'))
      return bytes({
        skills: [
          {
            id: 'synthetic-org/mock-repo/mock-source',
            source: 'synthetic-org/mock-repo',
            skillId: 'mock-source',
            name: 'Mock skill',
            installs: 12,
          },
        ],
      });
    if (url.startsWith('https://skillsmp.com/'))
      return bytes({
        success: true,
        data: {
          skills: [
            {
              id: 'mock-source',
              name: 'Mock skill',
              description: 'Synthetic',
              githubUrl: 'https://github.com/synthetic-org/mock-repo/tree/main/skills/mock-source',
              skillUrl: 'https://skillsmp.com/skills/mock-source',
            },
          ],
        },
      });
    return bytes({
      results: [
        {
          slug: 'mock-source',
          displayName: 'Mock skill',
          ownerHandle: 'synthetic-org',
          summary: 'Synthetic',
          install: { kind: 'clawhub', reference: 'synthetic-org/mock-source' },
          trust: { installability: 'installable' },
        },
      ],
    });
  });
  const metric = (await sources.search('skills.sh', 'mock', new AbortController().signal))
    .items[0] as unknown as { usage?: { kind: string; count: number } };
  assert.deepEqual(metric.usage, { kind: 'installs', count: 12 });
  for (const platform of ['skills.sh', 'skillsmp', 'clawhub']) {
    const result = await sources.search(platform, 'mock', new AbortController().signal);
    assert.equal(result.items.length, 1);
    assert.ok(result.items[0].source);
    assert.equal(result.platform, platform);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((url) => new URL(url).protocol === 'https:'));
});
test('pins GitHub files to one commit and fetches every resource, never running repository code', async () => {
  const { SkillSources } = await import(entry);
  const calls: string[] = [];
  const sha = 'a'.repeat(40),
    tree = 'b'.repeat(40);
  const sources = new SkillSources(async (url: string) => {
    calls.push(url);
    if (url.includes('/commits/')) return bytes({ sha, commit: { tree: { sha: tree } } });
    if (url.includes('/git/trees/'))
      return bytes({
        truncated: false,
        tree: [
          {
            path: 'skills/mock-source/SKILL.md',
            type: 'blob',
            mode: '100644',
            size: Buffer.byteLength(main),
            sha: blobHash(main),
          },
          {
            path: 'skills/mock-source/references/guide.txt',
            type: 'blob',
            mode: '100644',
            size: 16,
            sha: blobHash('SYNTHETIC SOURCE'),
          },
        ],
      });
    if (url.endsWith('/SKILL.md')) return Buffer.from(main);
    if (url.endsWith('/references/guide.txt')) return Buffer.from('SYNTHETIC SOURCE');
    return bytes({ default_branch: 'main' });
  });
  const result = await sources.preview(
    { platform: 'github', url: 'https://github.com/synthetic-org/mock-repo', skill: 'mock-source' },
    new AbortController().signal,
  );
  assert.equal(result.kind, 'package');
  assert.equal(result.selection.preview.fileCount, 2);
  assert.equal(result.origin.revision, sha);
  assert.ok(
    calls
      .filter((url) => url.startsWith('https://raw.githubusercontent.com/'))
      .every((url) => url.includes(`/${sha}/`)),
  );
});
test('rejects private/non-GitHub URLs, truncated catalogs and source symlinks rather than guessing a package', async () => {
  const { SkillSources } = await import(entry);
  const sources = new SkillSources(async (url: string) =>
    url.includes('/commits/')
      ? bytes({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } })
      : url.includes('/git/trees/')
        ? bytes({ truncated: true, tree: [] })
        : bytes({ default_branch: 'main' }),
  );
  await assert.rejects(
    sources.preview(
      { platform: 'github', url: 'http://127.0.0.1/private' },
      new AbortController().signal,
    ),
    { code: 'SKILL_SOURCE_INVALID' },
  );
  await assert.rejects(
    sources.preview(
      { platform: 'github', url: 'https://github.com/synthetic-org/mock-repo' },
      new AbortController().signal,
    ),
    { code: 'SKILL_SOURCE_TOO_LARGE' },
  );
});
test('rejects same-size bytes that do not match the selected Git object', async () => {
  const { SkillSources } = await import(entry);
  const sources = new SkillSources(async (url: string) => {
    if (url.includes('/commits/'))
      return bytes({ sha: 'a'.repeat(40), commit: { tree: { sha: 'b'.repeat(40) } } });
    if (url.includes('/git/trees/'))
      return bytes({
        truncated: false,
        tree: [
          {
            path: 'SKILL.md',
            type: 'blob',
            mode: '100644',
            size: Buffer.byteLength(main),
            sha: blobHash(main),
          },
        ],
      });
    if (url.startsWith('https://raw.githubusercontent.com/'))
      return Buffer.from(main.replace('Synthetic', 'SYNTHETIC'));
    return bytes({ default_branch: 'main' });
  });
  await assert.rejects(
    sources.preview(
      { platform: 'github', url: 'https://github.com/synthetic-org/mock-repo' },
      new AbortController().signal,
    ),
    { code: 'SKILL_SOURCE_CHANGED' },
  );
});

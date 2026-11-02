import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { zipSync } from 'fflate';

const entry = new URL('./skill-package.js', import.meta.url).href;
const content =
  '---\nname: mock-package\ndescription: Process synthetic records\nlicense: MIT\ncompatibility: Requires Python\nmetadata:\n  author: synthetic\n---\nRead references/guide.md and run scripts/report.py with assets/data.json.\n';
const files = {
  'SKILL.md': Buffer.from(content),
  'references/guide.md': Buffer.from('SYNTHETIC GUIDE'),
  'scripts/report.py': Buffer.from('print("SYNTHETIC RESULT")\n'),
  'assets/data.json': Buffer.from('{"synthetic":true}'),
  'assets/template.bin': Uint8Array.from([0, 1, 255, 0]),
};
test('preserves namespaced OpenClaw metadata as inert package data', async () => {
  const codec = await import(entry);
  const text =
    '---\nname: mock-package\ndescription: Synthetic extension\nmetadata:\n  openclaw:\n    requires:\n      bins: [python3]\n    install:\n      - id: synthetic\n        kind: brew\n---\nSynthetic instructions.\n';
  const value = {
    root: 'mock-package',
    files: [{ path: 'SKILL.md', data: Buffer.from(text).toString('base64') }],
  };
  assert.equal(codec.inspectSkillPackage(value).name, 'mock-package');
  assert.equal(
    Buffer.from(codec.normalizeSkillPackage(value).files[0].data, 'base64').toString(),
    text,
  );
});
test('imports and exports a standard directory archive without losing metadata or binary resources', async () => {
  const codec = await import(entry);
  const archive = zipSync(
    Object.fromEntries(
      Object.entries(files).map(([name, bytes]) => [`mock-package/${name}`, bytes]),
    ),
  );
  const bundle = codec.readSkillZip(archive);
  assert.equal(bundle.root, 'mock-package');
  assert.equal(bundle.files.length, 5);
  assert.equal(
    Buffer.from(
      bundle.files.find((file: { path: string }) => file.path === 'SKILL.md').data,
      'base64',
    ).toString(),
    content,
  );
  assert.deepEqual(codec.readSkillZip(codec.writeSkillZip(bundle)), bundle);
  assert.equal(codec.inspectSkillPackage(bundle).name, 'mock-package');
  assert.equal(codec.inspectSkillPackage(bundle).fileCount, 5);
});
test('rejects traversal, duplicate paths, symlink entries, multiple roots, encryption and false decompressed sizes', async () => {
  const codec = await import(entry);
  const cases: Record<string, Uint8Array>[] = [
    { 'SKILL.md': files['SKILL.md'], '../outside.txt': Buffer.from('SYNTHETIC') },
    { 'SKILL.md': files['SKILL.md'], '/outside.txt': Buffer.from('SYNTHETIC') },
    {
      'SKILL.md': files['SKILL.md'],
      'assets/A.txt': Buffer.from('A'),
      'assets/a.txt': Buffer.from('a'),
    },
    { 'first/SKILL.md': files['SKILL.md'], 'second/SKILL.md': files['SKILL.md'] },
  ];
  for (const names of cases)
    assert.throws(() => codec.readSkillZip(zipSync(names)), { code: 'INVALID_SKILL_PACKAGE' });
  const base = Buffer.from(zipSync(files));
  const central = base.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const link = Buffer.from(base);
  link.writeUInt32LE(0xa1ff0000, central + 38);
  assert.throws(() => codec.readSkillZip(link), { code: 'INVALID_SKILL_PACKAGE' });
  const encrypted = Buffer.from(base);
  encrypted.writeUInt16LE(encrypted.readUInt16LE(central + 8) | 1, central + 8);
  assert.throws(() => codec.readSkillZip(encrypted), { code: 'INVALID_SKILL_PACKAGE' });
  const bomb = Buffer.from(base);
  bomb.writeUInt32LE(0x7fffffff, central + 24);
  assert.throws(() => codec.readSkillZip(bomb), { code: 'SKILL_PACKAGE_TOO_LARGE' });
});
test('checks standard frontmatter and directory identity while permitting arbitrary resource subdirectories', async () => {
  const codec = await import(entry);
  const from = (text: string, root = 'mock-package') => ({
    root,
    files: [{ path: 'SKILL.md', data: Buffer.from(text).toString('base64') }],
  });
  assert.throws(() => codec.inspectSkillPackage(from(content, 'wrong-name')), {
    code: 'INVALID_SKILL_PACKAGE',
  });
  for (const text of [
    content.replace('author: synthetic', 'author: true'),
    content.replace('MIT', '[]'),
    content.replace('Requires Python', 'x'.repeat(501)),
  ])
    assert.throws(() => codec.inspectSkillPackage(from(text)), { code: 'INVALID_SKILL_PACKAGE' });
  assert.equal(
    codec.inspectSkillPackage(from('---\nname: mock-package\ndescription: Synthetic only\n---\n'))
      .name,
    'mock-package',
  );
});
test('reads only regular files from a selected directory and rejects symbolic links', async () => {
  const codec = await import(entry);
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-package-'));
  const folder = path.join(root, 'mock-package');
  try {
    await mkdir(path.join(folder, 'references'), { recursive: true });
    await writeFile(path.join(folder, 'SKILL.md'), content);
    await writeFile(path.join(folder, 'references/guide.md'), 'SYNTHETIC GUIDE');
    const bundle = await codec.readSkillDirectory(folder);
    assert.equal(bundle.files.length, 2);
    assert.deepEqual(await readFile(path.join(folder, 'SKILL.md')), Buffer.from(content));
    // A junction needs no Windows symlink privilege and still exercises link rejection.
    await symlink(
      process.platform === 'win32' ? root : path.join(root, 'outside.txt'),
      path.join(folder, 'references/link.txt'),
      process.platform === 'win32' ? 'junction' : 'file',
    );
    await assert.rejects(codec.readSkillDirectory(folder), { code: 'INVALID_SKILL_PACKAGE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

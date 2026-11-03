import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { SkillPackage } from '@daban/protocol';
import { expect, test } from 'vitest';
import { NativeWorkspace } from './native-workspace.js';
import { WorkspaceFiles } from './workspace.js';

const bundle: SkillPackage = {
  root: 'mock-stage',
  files: [
    { path: 'SKILL.md', data: Buffer.from('SYNTHETIC INSTRUCTIONS').toString('base64') },
    {
      path: 'scripts/nested/run.py',
      data: Buffer.from('print("SYNTHETIC STAGED")').toString('base64'),
      executable: true,
    },
    { path: 'assets/data.bin', data: Buffer.from([0, 2, 255]).toString('base64') },
  ],
};
test('stages the whole tree into a unique task-local directory without exposing it as generated output', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-skill-stage-'));
  try {
    const files = new WorkspaceFiles(root);
    await files.prepare();
    const staged = await Reflect.get(files, 'stageSkill').call(
      files,
      bundle,
      new AbortController().signal,
    );
    expect.assert(staged.startsWith((await files.base()) + path.sep + '.skills-'));
    expect((await readFile(path.join(staged, 'scripts/nested/run.py'))).toString()).toBe(
      'print("SYNTHETIC STAGED")',
    );
    expect(await readFile(path.join(staged, 'assets/data.bin'))).toStrictEqual(
      Buffer.from([0, 2, 255]),
    );
    expect(await files.list()).toStrictEqual([]);
    await expect(
      Reflect.get(files, 'stageSkill').call(
        files,
        { files: [...bundle.files, { path: '../escape.txt', data: 'eA==' }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL_PACKAGE' });
    const abort = new AbortController();
    abort.abort();
    await expect(
      Reflect.get(files, 'stageSkill').call(files, bundle, abort.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('native scratch staging preserves resources on Windows-compatible file APIs', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-native-skills-'));
  try {
    const workspace = new NativeWorkspace(root);
    await workspace.prepare();
    const target = await workspace.stageSkill(bundle, new AbortController().signal);
    expect(await readFile(path.join(target, 'scripts/nested/run.py'), 'utf8')).toBe(
      'print("SYNTHETIC STAGED")',
    );
    expect(await workspace.list()).toStrictEqual([]);
    await expect(
      workspace.stageSkill(
        { files: [{ path: '../escape', data: 'eA==' }] },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'INVALID_SKILL_PACKAGE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

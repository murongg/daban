import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { SkillPackage } from '@daban/protocol';
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
    assert.ok(staged.startsWith((await files.base()) + path.sep + '.skills-'));
    assert.equal(
      (await readFile(path.join(staged, 'scripts/nested/run.py'))).toString(),
      'print("SYNTHETIC STAGED")',
    );
    assert.deepEqual(
      await readFile(path.join(staged, 'assets/data.bin')),
      Buffer.from([0, 2, 255]),
    );
    assert.deepEqual(await files.list(), []);
    await assert.rejects(
      Reflect.get(files, 'stageSkill').call(
        files,
        { files: [...bundle.files, { path: '../escape.txt', data: 'eA==' }] },
        new AbortController().signal,
      ),
      { code: 'INVALID_SKILL_PACKAGE' },
    );
    const abort = new AbortController();
    abort.abort();
    await assert.rejects(Reflect.get(files, 'stageSkill').call(files, bundle, abort.signal), {
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
    assert.equal(
      await readFile(path.join(target, 'scripts/nested/run.py'), 'utf8'),
      'print("SYNTHETIC STAGED")',
    );
    assert.deepEqual(await workspace.list(), []);
    await assert.rejects(
      workspace.stageSkill(
        { files: [{ path: '../escape', data: 'eA==' }] },
        new AbortController().signal,
      ),
      { code: 'INVALID_SKILL_PACKAGE' },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

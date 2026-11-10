import { execFileSync } from 'node:child_process';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, onTestFinished, test, vi } from 'vitest';
import { extractComponent, verifyComponent } from '../apps/desktop/electron/component-install.ts';
import { withVerifiedComponent } from './component-validation.ts';
import { referenceComponent } from './components.ts';

vi.mock('node:child_process', { spy: true });
vi.mock('../apps/desktop/electron/component-install.ts', { spy: true });

test.each(['verified', 'invalid archive', 'invalid tree'] as const)(
  'a runtime stage is extracted once and exposed only after validation (%s)',
  async (outcome) => {
    const root = await mkdtemp(path.join(tmpdir(), 'synthetic-component-validation-'));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const archive = path.join(root, 'runtime.zip');
    const id = 'a'.repeat(64);
    await writeFile(archive, 'SYNTHETIC ZIP');
    const reference = await referenceComponent(archive, id, 'win32', 'x64');
    if (outcome === 'invalid archive') await writeFile(archive, 'SYNTHETIC BAD');

    let stage = '';
    const steps: string[] = [];
    vi.mocked(extractComponent).mockImplementation(async (_archive, directory) => {
      stage = directory;
      steps.push('extract');
    });
    const failure = new Error('SYNTHETIC INVALID TREE');
    vi.mocked(verifyComponent).mockImplementation(async ({ directory }) => {
      expect(directory).toBe(stage);
      steps.push('verify');
      if (outcome === 'invalid tree') throw failure;
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      steps.push('node');
      return 'v24.22.1\n';
    });
    const inspect = vi.fn(async (directory: string, sha256: string) => {
      expect(directory).toBe(stage);
      expect((await lstat(directory)).isDirectory()).toBe(true);
      expect(sha256).toBe(reference.assets[0].sha256);
      steps.push('inspect');
    });

    const result = withVerifiedComponent(
      { archive, reference, id, platform: 'win32', arch: 'x64', publisher: 'Synthetic.exe' },
      inspect,
    );
    if (outcome === 'verified') {
      await result;
      expect(steps).toEqual(['extract', 'verify', 'node', 'inspect']);
    } else {
      if (outcome === 'invalid tree') await expect(result).rejects.toBe(failure);
      else await expect(result).rejects.toThrow();
      expect(steps).toEqual(outcome === 'invalid tree' ? ['extract', 'verify'] : []);
      expect(inspect).not.toHaveBeenCalled();
    }
    if (stage) await expect(lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

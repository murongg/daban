import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { macVersion, releaseVersion } from './release.ts';

test('accepts stable and prerelease tags only when all workspace versions agree', () => {
  expect(releaseVersion('v1.2.3', ['1.2.3', '1.2.3'])).toBe('1.2.3');
  expect(releaseVersion('v1.2.3-beta.1', ['1.2.3-beta.1'])).toBe('1.2.3-beta.1');
  for (const tag of ['main', 'v01.2.3', 'v1.2', 'v1.2.3;echo injected', 'v1.2.3\n'])
    expect(() => releaseVersion(tag, ['1.2.3'])).toThrowError(/RELEASE_TAG/);
  expect(() => releaseVersion('v1.2.3', ['1.2.3', '1.2.2'])).toThrowError(/RELEASE_VERSION/);
});

test('keeps prerelease identifiers out of Apple numeric bundle version fields', () => {
  expect(macVersion('1.2.3')).toBe('1.2.3');
  expect(macVersion('1.2.3-beta.1')).toBe('1.2.3');
  expect(() => macVersion('synthetic-invalid-version')).toThrowError();
});

test('the CLI emits release outputs only for a matching tag whose commit belongs to main', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-release-git-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: 'pipe' }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Synthetic',
      '-c',
      'user.email=user@example.test',
      'commit',
      '-m',
      'Synthetic release fixture',
    );
  };
  const packages = [
    '.',
    'apps/desktop',
    'apps/agent',
    'apps/runtime',
    'packages/engine',
    'packages/protocol',
  ];
  const version = async (value: string) => {
    for (const location of packages) {
      await mkdir(path.join(directory, location), { recursive: true });
      await writeFile(
        path.join(directory, location, 'package.json'),
        JSON.stringify({ version: value }),
      );
    }
  };
  const output = path.join(directory, 'release-output');
  const run = (tag: string) =>
    execFileSync(
      process.execPath,
      ['--experimental-strip-types', fileURLToPath(new URL('./release.ts', import.meta.url))],
      {
        cwd: directory,
        stdio: 'pipe',
        env: { ...process.env, RELEASE_TAG: tag, GITHUB_OUTPUT: output },
      },
    );
  try {
    git('init');
    await version('1.2.3');
    commit();
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('tag', 'v1.2.3');
    run('v1.2.3');
    expect(await readFile(output, 'utf8')).toMatch(/tag=v1.2.3\nversion=1.2.3\ncommit=/);
    await writeFile(output, '');
    await version('1.2.3-beta.1');
    commit();
    git('tag', 'v1.2.3-beta.1');
    expect(() => run('v1.2.3-beta.1')).toThrowError();
    expect(await readFile(output, 'utf8')).toBe('');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

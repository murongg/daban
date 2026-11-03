import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { syncVersions } from './bump.ts';

const workspaces = [
  'apps/desktop',
  'apps/agent',
  'apps/runtime',
  'packages/engine',
  'packages/protocol',
];
const names = workspaces.map((directory) => `@mock/${path.basename(directory)}`);
const lockfiles = [
  'package-lock.json',
  'apps/agent/standalone-lock.json',
  'apps/runtime/standalone-lock.json',
];

async function fixture(root: string, version: string) {
  const write = async (file: string, value: unknown) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), `${JSON.stringify(value, null, 2)}\n`);
  };
  const manifest = (name: string) => ({
    name,
    version: '1.2.3',
    dependencies: { '@mock/engine': '1.2.3', '@mock/protocol': '1.2.3', external: '1.2.3' },
    devDependencies: { '@mock/protocol': '1.2.3' },
    optionalDependencies: { '@mock/protocol': '1.2.3' },
    peerDependencies: { '@mock/protocol': '1.2.3' },
  });
  await write('package.json', {
    ...manifest('mock-project'),
    version,
    workspaces,
    scripts: { release: 'bumpp' },
  });
  for (const [index, directory] of workspaces.entries())
    await write(`${directory}/package.json`, manifest(names[index]));
  for (const file of lockfiles) {
    const standalone = file !== 'package-lock.json';
    const owner = standalone ? `@mock/${path.basename(path.dirname(file))}` : 'mock-project';
    await write(file, {
      name: owner,
      version: '1.2.3',
      lockfileVersion: 3,
      packages: {
        '': standalone
          ? {
              ...manifest(owner),
              dependencies: {
                '@mock/engine': 'file:./vendor/engine',
                '@mock/protocol': 'file:./vendor/protocol',
              },
            }
          : manifest(owner),
        ...Object.fromEntries(
          workspaces.map((directory, index) => [
            standalone ? `vendor/${path.basename(directory)}` : directory,
            manifest(names[index]),
          ]),
        ),
        'vendor/linked': {
          ...manifest('@mock/engine'),
          dependencies: { '@mock/protocol': 'file:../protocol' },
        },
        'node_modules/@mock/protocol': { resolved: 'vendor/protocol', link: true },
        'node_modules/external': {
          name: 'external',
          version: '1.2.3',
          integrity: 'synthetic-integrity',
        },
      },
    });
  }
}

async function verifyVersions(root: string, version: string) {
  for (const directory of ['.', ...workspaces]) {
    const manifest = JSON.parse(await readFile(path.join(root, directory, 'package.json'), 'utf8'));
    expect(manifest.version).toBe(version);
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
      'peerDependencies',
    ])
      expect(manifest[field]['@mock/protocol']).toBe(version);
    expect(manifest.dependencies.external).toBe('1.2.3');
  }
  for (const file of lockfiles) {
    const lock = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    expect(lock.version).toBe(version);
    expect(lock.packages[''].version).toBe(version);
    for (const directory of workspaces) {
      const location =
        file === 'package-lock.json' ? directory : `vendor/${path.basename(directory)}`;
      expect(lock.packages[location].version).toBe(version);
      expect(lock.packages[location].dependencies['@mock/protocol']).toBe(version);
    }
    expect(lock.packages['vendor/linked'].dependencies['@mock/protocol']).toBe('file:../protocol');
    expect(lock.packages['node_modules/@mock/protocol']).toEqual({
      resolved: 'vendor/protocol',
      link: true,
    });
    expect(lock.packages['node_modules/external']).toEqual({
      name: 'external',
      version: '1.2.3',
      integrity: 'synthetic-integrity',
    });
    if (file !== 'package-lock.json')
      expect(lock.packages[''].dependencies['@mock/engine']).toBe('file:./vendor/engine');
    else expect(lock.packages[''].dependencies['@mock/engine']).toBe(version);
  }
}

test.each(['2.3.4', '2.3.4-beta.1'])(
  'synchronizes owned versions and preserves external dependencies and file links (%s)',
  async (version) => {
    const root = await mkdtemp(path.join(tmpdir(), 'daban-bump-'));
    try {
      await fixture(root, version);
      await syncVersions(root);
      await verifyVersions(root, version);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('the release command commits synchronized files and pushes an annotated tag to a local remote', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'daban-bump-git-'));
  const root = path.join(directory, 'checkout');
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  try {
    await fixture(root, '1.2.3');
    await mkdir(path.join(root, 'tools'), { recursive: true });
    await copyFile(
      fileURLToPath(new URL('../bump.config.ts', import.meta.url)),
      path.join(root, 'bump.config.ts'),
    );
    await copyFile(
      fileURLToPath(new URL('./bump.ts', import.meta.url)),
      path.join(root, 'tools/bump.ts'),
    );
    await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      path.join(root, 'node_modules'),
      'dir',
    );
    git('init', '-b', 'main');
    git('config', 'user.name', 'Synthetic');
    git('config', 'user.email', 'user@example.test');
    git('config', 'commit.gpgsign', 'false');
    git('config', 'tag.gpgsign', 'false');
    git('add', '.');
    git('commit', '-m', 'Synthetic initial version');
    const remote = path.join(directory, 'remote.git');
    git('init', '--bare', remote);
    git('remote', 'add', 'origin', remote);
    git('push', '-u', 'origin', 'main');
    const npm = process.platform === 'win32' ? process.execPath : 'npm';
    const prefix =
      process.platform === 'win32'
        ? [
            process.env.npm_execpath ||
              path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
          ]
        : [];
    execFileSync(npm, [...prefix, 'run', 'release', '--', '--release', '2.3.4-beta.1', '--yes'], {
      cwd: root,
      stdio: 'pipe',
      windowsHide: true,
    });
    await verifyVersions(root, '2.3.4-beta.1');
    expect(git('status', '--porcelain')).toBe('');
    expect(git('log', '-1', '--format=%s')).toBe('chore(release): v2.3.4-beta.1');
    expect(git('cat-file', '-t', 'v2.3.4-beta.1')).toBe('tag');
    expect(git('rev-parse', 'v2.3.4-beta.1^{commit}')).toBe(git('rev-parse', 'HEAD'));
    expect(git('ls-remote', 'origin', 'refs/heads/main')).toContain(git('rev-parse', 'HEAD'));
    expect(git('ls-remote', 'origin', 'refs/tags/v2.3.4-beta.1')).toContain(
      git('rev-parse', 'refs/tags/v2.3.4-beta.1'),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

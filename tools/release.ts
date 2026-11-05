import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseVersion(tag: string, versions: string[]) {
  assert.match(
    tag,
    /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-zA-Z0-9]+(?:[.-][a-zA-Z0-9]+)*)?$/,
    'RELEASE_TAG',
  );
  const version = tag.slice(1);
  assert.ok(versions.length && versions.every((value) => value === version), 'RELEASE_VERSION');
  return version;
}
export function macVersion(version: string) {
  const match = /^(\d+\.\d+\.\d+)(?:-[a-zA-Z0-9.-]+)?$/.exec(version);
  assert.ok(match, 'MACOS_BUNDLE_VERSION');
  // The full prerelease stays in package.json and artifact names; Apple's bundle fields are numeric.
  return match[1];
}
async function main() {
  const tag = process.env.RELEASE_TAG ?? '';
  const project = JSON.parse(await readFile('package.json', 'utf8')) as { workspaces: string[] };
  const packages = ['.', ...project.workspaces];
  const versions = await Promise.all(
    packages.map(
      async (directory) =>
        JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).version as string,
    ),
  );
  const version = releaseVersion(tag, versions);
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).trim();
  const commit = git(['rev-parse', 'HEAD']);
  assert.equal(git(['rev-parse', `refs/tags/${tag}^{commit}`]), commit, 'RELEASE_TAG_COMMIT');
  execFileSync('git', ['merge-base', '--is-ancestor', commit, 'origin/main']);
  if (process.env.GITHUB_OUTPUT)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `tag=${tag}\nversion=${version}\ncommit=${commit}\nprerelease=${version.includes('-')}\n`,
    );
  console.log(`Validated release ${tag}: workspace versions agree and commit belongs to main.`);
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  await main();

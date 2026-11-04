import assert from 'node:assert/strict';
import { lstat, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { hashAsset } from './environment.ts';
import { releaseVersion } from './release.ts';
import type { NotaryReceipt } from './sign.ts';

export interface ReleaseContext {
  commit: string;
  source: string;
  release: string;
}
export type CheckpointInput = ReleaseContext &
  (
    | ({ phase: 'runtime-prepared' } & (
        | { cached: true }
        | { cached: false; receipt: NotaryReceipt }
      ))
    | { phase: 'runtime-ready' }
    | { phase: 'client-prepared'; receipt: NotaryReceipt; runtime: string }
    | { phase: 'client-ready'; receipt: NotaryReceipt; runtime: string; update: string }
  );
export type CheckpointPhase = CheckpointInput['phase'];
interface CheckpointFile {
  name: string;
  bytes: number;
  sha256: string;
}
export type ReleaseCheckpoint = CheckpointInput & { version: 1; files: CheckpointFile[] };
const linux = ['linux.json', 'Daban-lima-macos-arm64.tar.gz', 'Daban-executor-linux-arm64.tar.gz'];
export function checkpointNames(input: CheckpointInput) {
  releaseVersion(`v${input.release}`, [input.release]);
  if (input.phase === 'client-ready') {
    assert.match(input.update, /^[a-zA-Z0-9][a-zA-Z0-9.-]*-mac\.yml$/, 'CHECKPOINT_UPDATE');
    return [
      `Daban-${input.release}-macos-arm64.dmg`,
      `Daban-${input.release}-macos-arm64.zip`,
      `Daban-${input.release}-macos-arm64.zip.blockmap`,
      input.update,
    ];
  }
  if (input.phase === 'client-prepared')
    return ['client-signed.zip', `Daban-${input.release}-macos-arm64.dmg`];
  if (input.phase === 'runtime-ready')
    return ['Daban-runtime-macos-arm64.zip', 'runtime-macos-arm64.json', ...linux];
  return [input.cached ? 'Daban-runtime-macos-arm64.zip' : 'runtime-signed.zip', ...linux];
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function accepted(value: unknown): NotaryReceipt {
  assert.ok(record(value), 'CHECKPOINT_RECEIPT');
  assert.deepEqual(Object.keys(value).sort(), ['id', 'status'], 'CHECKPOINT_RECEIPT');
  assert.equal(value.status, 'Accepted', 'CHECKPOINT_RECEIPT');
  assert.ok(typeof value.id === 'string', 'CHECKPOINT_RECEIPT');
  assert.match(value.id, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, 'CHECKPOINT_RECEIPT');
  return { id: value.id, status: 'Accepted' };
}
function metadata(value: unknown, expected: ReleaseContext, phase: CheckpointPhase) {
  assert.ok(record(value), 'CHECKPOINT_INVALID');
  assert.equal(value.version, 1, 'CHECKPOINT_VERSION');
  assert.equal(value.phase, phase, 'CHECKPOINT_PHASE');
  for (const key of ['commit', 'source', 'release'] as const)
    assert.equal(value[key], expected[key], 'CHECKPOINT_SOURCE');
  assert.match(expected.commit, /^[a-f0-9]{40}$/, 'CHECKPOINT_COMMIT');
  assert.match(expected.source, /^[a-f0-9]{64}$/, 'CHECKPOINT_SOURCE');
  releaseVersion(`v${expected.release}`, [expected.release]);
  let input: CheckpointInput;
  if (phase === 'runtime-prepared') {
    assert.ok(value.cached === true || value.cached === false, 'CHECKPOINT_CACHE');
    input = value.cached
      ? { ...expected, phase, cached: true }
      : { ...expected, phase, cached: false, receipt: accepted(value.receipt) };
  } else if (phase === 'runtime-ready') input = { ...expected, phase };
  else {
    assert.ok(typeof value.runtime === 'string', 'CHECKPOINT_RUNTIME');
    assert.match(value.runtime, /^[a-f0-9]{64}$/, 'CHECKPOINT_RUNTIME');
    const base = { ...expected, runtime: value.runtime, receipt: accepted(value.receipt) };
    if (phase === 'client-ready') {
      assert.ok(typeof value.update === 'string' && value.update.length < 100, 'CHECKPOINT_UPDATE');
      assert.match(value.update, /^[a-zA-Z0-9][a-zA-Z0-9.-]*-mac\.yml$/, 'CHECKPOINT_UPDATE');
      input = { ...base, phase, update: value.update };
    } else input = { ...base, phase };
  }
  assert.deepEqual(
    Object.keys(value).sort(),
    ['version', 'files', ...Object.keys(input)].sort(),
    'CHECKPOINT_FIELDS',
  );
  assert.ok(Array.isArray(value.files), 'CHECKPOINT_FILES');
  const files: CheckpointFile[] = [];
  for (const file of value.files) {
    assert.ok(record(file), 'CHECKPOINT_FILES');
    assert.deepEqual(Object.keys(file).sort(), ['bytes', 'name', 'sha256'], 'CHECKPOINT_FILES');
    assert.ok(
      typeof file.bytes === 'number' &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0 &&
        file.bytes <= 2 * 1024 ** 3,
      'CHECKPOINT_SIZE',
    );
    assert.ok(typeof file.sha256 === 'string', 'CHECKPOINT_DIGEST');
    assert.match(file.sha256, /^[a-f0-9]{64}$/, 'CHECKPOINT_DIGEST');
    assert.ok(typeof file.name === 'string', 'CHECKPOINT_FILES');
    files.push({ name: file.name, bytes: file.bytes, sha256: file.sha256 });
  }
  const result: ReleaseCheckpoint = { version: 1, ...input, files };
  assert.deepEqual(
    files.map((file) => file.name).sort(),
    checkpointNames(input).sort(),
    'CHECKPOINT_FILES',
  );
  return result;
}
async function regular(file: string, maximum: number) {
  const info = await lstat(file);
  assert.ok(
    info.isFile() &&
      !info.isSymbolicLink() &&
      info.nlink === 1 &&
      info.size > 0 &&
      info.size <= maximum,
    'CHECKPOINT_FILE_UNSAFE',
  );
}
async function directoryRoot(directory: string) {
  const info = await lstat(directory);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'CHECKPOINT_DIRECTORY');
}
async function verify(directory: string, checkpoint: ReleaseCheckpoint) {
  const expected = [...checkpointNames(checkpoint), 'checkpoint.json'];
  assert.deepEqual((await readdir(directory)).sort(), expected.sort(), 'CHECKPOINT_CONTENTS');
  for (const file of checkpoint.files) {
    const absolute = path.join(directory, file.name);
    await regular(absolute, 2 * 1024 ** 3);
    const actual = await hashAsset(absolute, 'sha256');
    assert.equal(actual.bytes, file.bytes, 'CHECKPOINT_SIZE');
    assert.equal(actual.digest, file.sha256, 'CHECKPOINT_DIGEST');
  }
}
export async function writeCheckpoint(directory: string, input: CheckpointInput) {
  await directoryRoot(directory);
  const files: CheckpointFile[] = [];
  for (const name of checkpointNames(input)) {
    await regular(path.join(directory, name), 2 * 1024 ** 3);
    const file = await hashAsset(path.join(directory, name), 'sha256');
    files.push({ name, bytes: file.bytes, sha256: file.digest });
  }
  const value = metadata({ version: 1, ...input, files }, input, input.phase);
  // Checkpoints contain only approved distribution bytes and metadata, never keychains or credentials.
  assert.deepEqual(
    (await readdir(directory)).sort(),
    checkpointNames(input).sort(),
    'CHECKPOINT_CONTENTS',
  );
  await writeFile(path.join(directory, 'checkpoint.json'), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  return value;
}
export async function readCheckpoint(
  directory: string,
  context: ReleaseContext,
  phase: CheckpointPhase,
) {
  await directoryRoot(directory);
  const file = path.join(directory, 'checkpoint.json');
  await regular(file, 65536);
  const value = metadata(JSON.parse(await readFile(file, 'utf8')), context, phase);
  await verify(directory, value);
  return value;
}

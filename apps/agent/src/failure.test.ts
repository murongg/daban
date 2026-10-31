import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { startupErrorCode, writeStartupFailure } from './failure.js';

test('startup failure progress contains only registered diagnostic codes and remains private', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-startup-failure-'));
  const secret = 'synthetic-provider-key-that-must-stay-private';
  try {
    assert.equal(await writeStartupFailure(root, new Error(`Failed request with ${secret}`)), true);
    assert.deepEqual(JSON.parse(await readFile(path.join(root, 'progress.json'), 'utf8')), {
      required: true,
      phase: 'failed',
      error: 'AGENT_START_FAILED',
    });
    assert.equal((await lstat(path.join(root, 'progress.json'))).mode & 0o777, 0o600);
    for (const code of [
      'MIGRATION_CREDENTIAL_UNAVAILABLE',
      'MIGRATION_SECRET_IN_PUBLIC',
      'SOURCE_METADATA_INVALID',
    ]) {
      const error = Object.assign(new Error(secret), { code });
      assert.equal(startupErrorCode(error), code);
      await writeStartupFailure(root, error);
      const progress = await readFile(path.join(root, 'progress.json'), 'utf8');
      assert.equal(JSON.parse(progress).error, code);
      assert.ok(!progress.includes(secret));
    }
    assert.equal(startupErrorCode(new Error('SOURCE_SYNTHETIC_PRIVATE_KEY')), 'AGENT_START_FAILED');
    assert.equal(
      startupErrorCode(new Error(`MIGRATION_SECRET_IN_PUBLIC ${secret}`)),
      'AGENT_START_FAILED',
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('unsafe, linked or absent startup directories cannot receive failure progress', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-startup-unsafe-'));
  const target = path.join(root, 'target'),
    link = path.join(root, 'link');
  await mkdir(target, { mode: 0o700 });
  await symlink(target, link);
  try {
    assert.equal(await writeStartupFailure(link, new Error('MIGRATION_SECRET_IN_PUBLIC')), false);
    await assert.rejects(readFile(path.join(target, 'progress.json')), { code: 'ENOENT' });
    assert.equal(
      await writeStartupFailure(path.join(root, 'missing'), new Error('AGENT_START_FAILED')),
      false,
    );
    await assert.rejects(lstat(path.join(root, 'missing')), { code: 'ENOENT' });
    await chmod(target, 0o755);
    assert.equal(await writeStartupFailure(target, new Error('AGENT_START_FAILED')), false);
    await assert.rejects(readFile(path.join(target, 'progress.json')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { startupErrorCode, writeStartupFailure } from './failure.js';

test('startup failure progress contains only registered diagnostic codes and remains private', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-startup-failure-'));
  const secret = 'synthetic-provider-key-that-must-stay-private';
  try {
    expect(await writeStartupFailure(root, new Error(`Failed request with ${secret}`))).toBe(true);
    expect(JSON.parse(await readFile(path.join(root, 'progress.json'), 'utf8'))).toStrictEqual({
      required: true,
      phase: 'failed',
      error: 'AGENT_START_FAILED',
    });
    expect((await lstat(path.join(root, 'progress.json'))).mode & 0o777).toBe(0o600);
    for (const code of [
      'MIGRATION_CREDENTIAL_UNAVAILABLE',
      'MIGRATION_SECRET_IN_PUBLIC',
      'SOURCE_METADATA_INVALID',
    ]) {
      const error = Object.assign(new Error(secret), { code });
      expect(startupErrorCode(error)).toBe(code);
      await writeStartupFailure(root, error);
      const progress = await readFile(path.join(root, 'progress.json'), 'utf8');
      expect(JSON.parse(progress).error).toBe(code);
      expect.assert(!progress.includes(secret));
    }
    expect(startupErrorCode(new Error('SOURCE_SYNTHETIC_PRIVATE_KEY'))).toBe('AGENT_START_FAILED');
    expect(startupErrorCode(new Error(`MIGRATION_SECRET_IN_PUBLIC ${secret}`))).toBe(
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
    expect(await writeStartupFailure(link, new Error('MIGRATION_SECRET_IN_PUBLIC'))).toBe(false);
    await expect(readFile(path.join(target, 'progress.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      await writeStartupFailure(path.join(root, 'missing'), new Error('AGENT_START_FAILED')),
    ).toBe(false);
    await expect(lstat(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'ENOENT' });
    await chmod(target, 0o755);
    expect(await writeStartupFailure(target, new Error('AGENT_START_FAILED'))).toBe(false);
    await expect(readFile(path.join(target, 'progress.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

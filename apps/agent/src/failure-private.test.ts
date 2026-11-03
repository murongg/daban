import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { secureDirectory } from '@daban/engine/local-computer';
import { expect, test } from 'vitest';
import { writeStartupFailure } from './failure.js';

test('a private Windows VM startup failure retains a bounded actionable code without raw SSH diagnostics', async (t) => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-vm-failure-'));
  t.onTestFinished(() => rm(temporary, { recursive: true, force: true }));
  const root = await secureDirectory(path.join(temporary, 'private'));
  expect(await writeStartupFailure(root, new Error('EXECUTOR_SSH_HOST_KEY'))).toBe(true);
  expect(JSON.parse(await readFile(path.join(root, 'progress.json'), 'utf8'))).toStrictEqual({
    required: true,
    phase: 'failed',
    error: 'EXECUTOR_SSH_HOST_KEY',
  });
});

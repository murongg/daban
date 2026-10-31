import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDiagnosticReport } from '@daban/protocol';
import { startPrototype } from './server.js';

async function files(root: string, directory = root): Promise<Record<string, string>> {
  const values: Record<string, string> = {};
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name),
      info = await lstat(file);
    if (info.isSymbolicLink() || name.endsWith('-shm')) continue;
    if (info.isDirectory()) Object.assign(values, await files(root, file));
    else if (info.isFile())
      values[path.relative(root, file)] = createHash('sha256')
        .update(await readFile(file))
        .digest('hex');
  }
  return values;
}
export async function acceptDiagnostics(output: string, credential: string) {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-diagnostics-'));
  const beforeKey = await stat(credential);
  const keyHash = createHash('sha256')
    .update(await readFile(credential))
    .digest('hex');
  await mkdir(path.join(root, 'model'), { mode: 0o700 });
  await symlink(credential, path.join(root, 'model/credentials.json'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  }).catch(async (error) => {
    await rm(root, { recursive: true, force: true });
    throw error;
  });
  try {
    assert.ok(app.models);
    let graphics = 0;
    app.runtime.options.driver.start = async () => {
      graphics++;
      throw new Error('UNEXPECTED_GRAPHICAL_START');
    };
    await app.models.profiles.register({
      id: 'mock-inspection-bot',
      name: '合成检查助手',
      instructions: 'SYNTHETIC-PRIVATE-INSTRUCTIONS',
      memory: 'SYNTHETIC-PRIVATE-MEMORY',
      color: 'mint',
    });
    const before = await files(root);
    const inspect = async () => {
      const response = await fetch(`${app.url}/api/diagnostics`, {
        headers: { 'x-prototype-token': app.token },
      });
      assert.equal(response.status, 200);
      const report: unknown = await response.json();
      assert.ok(isDiagnosticReport(report));
      assert.equal(JSON.stringify(report).includes('SYNTHETIC-PRIVATE'), false);
      return report;
    };
    const reports = await Promise.all([inspect(), inspect(), inspect()]);
    assert.ok(reports.every((report) => report.checks.every((row) => row.state === 'ready')));
    const status = app.models.skills.status;
    app.models.skills.status = async () => {
      throw new Error('SYNTHETIC-PRIVATE-FAILURE');
    };
    const degraded = await inspect();
    app.models.skills.status = status;
    assert.equal(degraded.checks.find((row) => row.id === 'skills')?.state, 'unavailable');
    assert.equal(degraded.checks.find((row) => row.id === 'agent')?.state, 'ready');
    assert.deepEqual(await files(root), before);
    assert.equal(graphics, 0);
    assert.equal(
      Object.values(app.models.status().bots).some((job) => job.running || job.runId),
      false,
    );
    const afterKey = await stat(credential);
    assert.ok(
      createHash('sha256')
        .update(await readFile(credential))
        .digest('hex') === keyHash,
      'Saved credential content changed',
    );
    assert.equal(afterKey.ino, beforeKey.ino);
    assert.equal(afterKey.mtimeMs, beforeKey.mtimeMs);
    assert.equal(afterKey.mode, beforeKey.mode);
    await writeFile(
      output,
      JSON.stringify(
        {
          verified: true,
          scope:
            'Isolated real Linux23 read-only API with retained official saved configuration; not original Electron activation',
          reports,
          optionalFailure: degraded,
          retainedDataFilesUnchanged: true,
          graphicsAttempts: graphics,
          paidModelTaskTurns: 0,
          savedKeyContentAndMetadataUnchanged: true,
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
  } finally {
    try {
      await app.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv[2] && process.env.DIAGNOSTIC_CREDENTIAL_FILE);
  await acceptDiagnostics(process.argv[2], process.env.DIAGNOSTIC_CREDENTIAL_FILE);
}

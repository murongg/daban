import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DshLog, readDshStartup, startupLogLimit, startupSnapshotLimit } from './dsh.js';
import { redact } from './redaction.js';

const run = promisify(execFile);
const secret = 'synthetic-secret-"quoted';
const clean = (value: string) => redact(value, [secret]);

test('snapshot collection accepts startup fields only, never arbitrary configuration or request bodies', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-snapshot-fields-'));
  const file = path.join(root, 'snapshot.json');
  try {
    await writeFile(
      file,
      JSON.stringify({
        stage: 'initialized',
        stderr: 'mock warning',
        prompt: 'SYNTHETIC PRIVATE REQUEST',
        env: { key: 'SYNTHETIC PRIVATE CONFIG' },
        exception: { name: 'Error', message: 'mock failure', request: 'SYNTHETIC PRIVATE REQUEST' },
      }),
    );
    const snapshot = await readDshStartup(file);
    assert.ok(snapshot);
    assert.equal(JSON.stringify(snapshot).includes('SYNTHETIC PRIVATE'), false);
    await writeFile(file, JSON.stringify({ credentials: 'SYNTHETIC PRIVATE CONFIG' }));
    assert.equal(await readDshStartup(file), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup diagnostics rotate within a fixed three-file budget and redact before persistence', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-log-'));
  const file = path.join(root, 'dsh-startup.log');
  const logger = new DshLog(file);
  try {
    await Promise.all(
      Array.from({ length: 96 }, (_, index) =>
        logger.write(
          {
            stage: 'initialize-failed',
            runId: `mock-${index}`,
            bot: 'mock-bot',
            error: `${secret} Bearer synthetic-authorization`,
            details: 'x'.repeat(32000),
          },
          clean,
        ),
      ),
    );
    const files = (await readdir(root)).filter((name) => name.startsWith('dsh-startup.log'));
    assert.equal(files.length, 3);
    for (const name of files) {
      const info = await stat(path.join(root, name));
      assert.ok(info.size <= startupLogLimit);
      if (process.platform !== 'win32') assert.equal(info.mode & 0o777, 0o600);
      const text = await readFile(path.join(root, name), 'utf8');
      assert.equal(text.includes('synthetic-secret'), false);
      assert.equal(text.includes('synthetic-authorization'), false);
      for (const line of text.trim().split('\n')) assert.ok(JSON.parse(line).runId);
    }
    const current = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(current.at(-1).runId, 'mock-95');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an oversized event stays valid JSON within the file limit and logging failures do not throw', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-overflow-'));
  try {
    const file = path.join(root, 'dsh-startup.log');
    assert.equal(
      await new DshLog(file).write(
        {
          stage: 'initialize-failed',
          runId: 'mock-overflow',
          error: '\u0000'.repeat(startupLogLimit * 2),
        },
        clean,
      ),
      true,
    );
    const text = await readFile(file, 'utf8');
    assert.ok(Buffer.byteLength(text) <= startupLogLimit);
    assert.equal(JSON.parse(text).truncated, true);
    assert.equal(
      await new DshLog(path.join(root, 'missing/log')).write(
        { stage: 'sdk-loading', runId: 'mock' },
        clean,
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('startup logging never follows an existing symlink', {
  skip: process.platform === 'win32',
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-link-'));
  try {
    const target = path.join(root, 'unrelated');
    await writeFile(target, 'SYNTHETIC UNRELATED CONTENT');
    const file = path.join(root, 'dsh-startup.log');
    await symlink(target, file);
    assert.equal(
      await new DshLog(file).write({ stage: 'sdk-loading', runId: 'mock' }, clean),
      false,
    );
    assert.equal(await readFile(target, 'utf8'), 'SYNTHETIC UNRELATED CONTENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

const preload = fileURLToPath(new URL('./dsh-preload.js', import.meta.url));
function childEnvironment(file: string) {
  return {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    DABAN_MODEL_KEY: secret,
    DABAN_DSH_STARTUP_FILE: file,
    DABAN_DSH_STARTUP_PARENT: String(process.pid),
    DABAN_DSH_STARTUP_REDACT: 'synthetic-rpc-token',
  };
}

test('a checkpoint I/O failure cannot turn an otherwise healthy runtime into a startup failure', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-checkpoint-io-'));
  try {
    const result = await run(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import fs from 'node:fs';
      import {syncBuiltinESMExports} from 'node:module';
      fs.closeSync=()=>{throw new Error('mock close failure');};
      syncBuiltinESMExports();
      await import(${JSON.stringify(new URL('./dsh-preload.js', import.meta.url).href)});
      process.stderr.write('mock startup output');
      process.stdout.write('mock runtime still runs');
    `,
      ],
      { cwd: root, env: childEnvironment(path.join(root, 'snapshot.json')), timeout: 10000 },
    );
    assert.equal(result.stdout, 'mock runtime still runs');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the preload captures partial startup stderr, preserves RPC output, and stops before chat content', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-preload-'));
  const file = path.join(root, 'startup.json');
  const reply = {
    jsonrpc: '2.0',
    id: 1,
    result: { serverInfo: { name: 'mock-runtime', version: '0.0.0' } },
  };
  try {
    const result = await run(
      process.execPath,
      [
        '--import',
        preload,
        '--input-type=module',
        '-e',
        `
      process.stderr.write('startup synthetic-secret-');
      process.stderr.write('"quoted');
      process.stdout.write(${JSON.stringify(JSON.stringify(reply) + '\n')});
      process.stderr.write('SYNTHETIC CHAT MUST NOT BE RECORDED');
    `,
        secret,
      ],
      { env: childEnvironment(file), cwd: root, timeout: 10000 },
    );
    assert.equal(result.stdout, JSON.stringify(reply) + '\n');
    assert.ok(result.stderr.includes(secret));
    const text = await readFile(file, 'utf8');
    const snapshot = JSON.parse(text);
    assert.equal(snapshot.stage, 'initialized');
    assert.ok(snapshot.stderr.includes('[credential redacted]'));
    assert.equal(text.includes('synthetic-secret'), false);
    assert.equal(text.includes('SYNTHETIC CHAT'), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the preload bounds noisy stderr and does not swallow a startup crash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-crash-'));
  const file = path.join(root, 'startup.json');
  try {
    await assert.rejects(
      run(
        process.execPath,
        [
          '--import',
          preload,
          '--input-type=module',
          '-e',
          `
      process.stderr.write('\\u0000'.repeat(256000));
      throw new Error('mock startup crash '+process.env.DABAN_MODEL_KEY);
    `,
        ],
        { env: childEnvironment(file), cwd: root, timeout: 10000, maxBuffer: 1024 * 1024 },
      ),
      { code: 1 },
    );
    const text = await readFile(file, 'utf8');
    assert.ok(Buffer.byteLength(text) <= startupSnapshotLimit);
    const snapshot = JSON.parse(text);
    assert.equal(snapshot.truncated, true);
    assert.ok(snapshot.exception.message.includes('mock startup crash'));
    assert.equal(text.includes('synthetic-secret'), false);
    assert.equal(snapshot.exitCode, 1);
    assert.deepEqual(await readdir(root), ['startup.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

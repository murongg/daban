import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
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
    expect.assert(snapshot);
    expect(JSON.stringify(snapshot).includes('SYNTHETIC PRIVATE')).toBe(false);
    await writeFile(file, JSON.stringify({ credentials: 'SYNTHETIC PRIVATE CONFIG' }));
    expect(await readDshStartup(file)).toBe(undefined);
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
    expect(files.length).toBe(3);
    for (const name of files) {
      const info = await stat(path.join(root, name));
      expect.assert(info.size <= startupLogLimit);
      if (process.platform !== 'win32') expect(info.mode & 0o777).toBe(0o600);
      const text = await readFile(path.join(root, name), 'utf8');
      expect(text.includes('synthetic-secret')).toBe(false);
      expect(text.includes('synthetic-authorization')).toBe(false);
      for (const line of text.trim().split('\n')) expect.assert(JSON.parse(line).runId);
    }
    const current = (await readFile(file, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(current.at(-1).runId).toBe('mock-95');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an oversized event stays valid JSON within the file limit and logging failures do not throw', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-overflow-'));
  try {
    const file = path.join(root, 'dsh-startup.log');
    expect(
      await new DshLog(file).write(
        {
          stage: 'initialize-failed',
          runId: 'mock-overflow',
          error: '\u0000'.repeat(startupLogLimit * 2),
        },
        clean,
      ),
    ).toBe(true);
    const text = await readFile(file, 'utf8');
    expect.assert(Buffer.byteLength(text) <= startupLogLimit);
    expect(JSON.parse(text).truncated).toBe(true);
    expect(
      await new DshLog(path.join(root, 'missing/log')).write(
        { stage: 'sdk-loading', runId: 'mock' },
        clean,
      ),
    ).toBe(false);
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
    expect(await new DshLog(file).write({ stage: 'sdk-loading', runId: 'mock' }, clean)).toBe(
      false,
    );
    expect(await readFile(target, 'utf8')).toBe('SYNTHETIC UNRELATED CONTENT');
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
      const checkpoint=process.env.DABAN_DSH_STARTUP_FILE+'.tmp';
      const open=fs.openSync;
      const close=fs.closeSync;
      const descriptors=new Set();
      let failures=0;
      // Node also closes module-loader files; inject the fault only into our checkpoint descriptors.
      fs.openSync=(file,...args)=>{
        const descriptor=open(file,...args);
        if(String(file)===checkpoint)descriptors.add(descriptor);
        return descriptor;
      };
      fs.closeSync=(descriptor)=>{
        if(descriptors.delete(descriptor)){
          close(descriptor);
          failures++;
          throw new Error('mock close failure');
        }
        return close(descriptor);
      };
      syncBuiltinESMExports();
      await import(${JSON.stringify(new URL('./dsh-preload.js', import.meta.url).href)});
      process.stderr.write('mock startup output');
      process.stdout.write(JSON.stringify({running:true,failures}));
    `,
      ],
      { cwd: root, env: childEnvironment(path.join(root, 'snapshot.json')), timeout: 10000 },
    );
    const resultValue = JSON.parse(result.stdout);
    expect(resultValue.running).toBe(true);
    expect.assert(resultValue.failures > 0, 'the checkpoint fault must actually be exercised');
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
    expect(result.stdout).toBe(JSON.stringify(reply) + '\n');
    expect.assert(result.stderr.includes(secret));
    const text = await readFile(file, 'utf8');
    const snapshot = JSON.parse(text);
    expect(snapshot.stage).toBe('initialized');
    expect.assert(snapshot.stderr.includes('[credential redacted]'));
    expect(text.includes('synthetic-secret')).toBe(false);
    expect(text.includes('SYNTHETIC CHAT')).toBe(false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the preload bounds noisy stderr and does not swallow a startup crash', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-dsh-crash-'));
  const file = path.join(root, 'startup.json');
  try {
    await expect(
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
    ).rejects.toMatchObject({ code: 1 });
    const text = await readFile(file, 'utf8');
    expect.assert(Buffer.byteLength(text) <= startupSnapshotLimit);
    const snapshot = JSON.parse(text);
    expect(snapshot.truncated).toBe(true);
    expect.assert(snapshot.exception.message.includes('mock startup crash'));
    expect(text.includes('synthetic-secret')).toBe(false);
    expect(snapshot.exitCode).toBe(1);
    expect(await readdir(root)).toStrictEqual(['startup.json']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { downloadPayload, type Payload } from './payload.js';

const bytes = Buffer.from('SYNTHETIC IMMUTABLE RUNTIME PAYLOAD');
const asset: Payload = {
  url: 'https://example.test/runtime.zip',
  bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
const response = (data: Uint8Array = bytes) =>
  new Response(new Uint8Array(data), { headers: { 'content-length': String(data.length) } });
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'mock-payload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: path.join(directory, 'runtime.zip') };
}

test('publishes only a verified payload and reuses a valid cache without a request', async (t) => {
  const { file } = await fixture(t);
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return response();
  };
  await downloadPayload(file, asset, { fetcher });
  assert.deepEqual(await readFile(file), bytes);
  await downloadPayload(file, asset, { fetcher });
  assert.equal(calls, 1);
  if (process.platform !== 'win32') assert.equal((await lstat(file)).mode & 0o777, 0o600);
});

test('resumes an interrupted stream and verifies the complete file before publishing', async (t) => {
  const { file } = await fixture(t);
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
  await assert.rejects(
    downloadPayload(file, asset, {
      fetcher: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              stream = controller;
              controller.enqueue(bytes.subarray(0, 5));
            },
          }),
          { headers: { 'content-length': String(bytes.length) } },
        ),
      progress: (value) => {
        if (value.received === 5) stream?.error(new Error('SYNTHETIC_CONNECTION_LOST'));
      },
    }),
  );
  assert.deepEqual(await readFile(file + '.part'), bytes.subarray(0, 5));
  const fetcher: typeof fetch = async (_url, init) => {
    assert.equal(new Headers(init?.headers).get('range'), 'bytes=5-');
    return new Response(bytes.subarray(5), {
      status: 206,
      headers: {
        'content-range': `bytes 5-${bytes.length - 1}/${bytes.length}`,
        'content-length': String(bytes.length - 5),
      },
    });
  };
  await downloadPayload(file, asset, { fetcher });
  assert.deepEqual(await readFile(file), bytes);
  await assert.rejects(lstat(file + '.part'), { code: 'ENOENT' });
});

test('restarts cleanly if a server ignores Range, without appending a second full archive', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file + '.part', bytes.subarray(0, 5), { mode: 0o600 });
  await downloadPayload(file, asset, { fetcher: async () => response() });
  assert.deepEqual(await readFile(file), bytes);
});

test('refuses wrong hashes, oversized bodies and inconsistent range metadata', async (t) => {
  const { file } = await fixture(t);
  await assert.rejects(
    downloadPayload(
      file,
      { ...asset, sha256: '0'.repeat(64) },
      { fetcher: async () => response() },
    ),
    /PAYLOAD_INTEGRITY/,
  );
  await assert.rejects(lstat(file), { code: 'ENOENT' });
  await assert.rejects(lstat(file + '.part'), { code: 'ENOENT' });
  await assert.rejects(
    downloadPayload(file, asset, { fetcher: async () => response(Buffer.alloc(bytes.length + 1)) }),
  );
  await writeFile(file + '.part', bytes.subarray(0, 5), { mode: 0o600 });
  await assert.rejects(
    downloadPayload(file, asset, {
      fetcher: async () =>
        new Response(bytes.subarray(5), {
          status: 206,
          headers: { 'content-range': 'bytes 1-2/3' },
        }),
    }),
    /PAYLOAD_RANGE/,
  );
  await assert.rejects(lstat(file), { code: 'ENOENT' });
});

test('deduplicates concurrent requests and repairs a corrupt app-owned cache', async (t) => {
  const { file } = await fixture(t);
  await writeFile(file, 'SYNTHETIC CORRUPT CACHE', { mode: 0o600 });
  let calls = 0;
  const fetcher: typeof fetch = async () => {
    calls++;
    return response();
  };
  await Promise.all([
    downloadPayload(file, asset, { fetcher }),
    downloadPayload(file, asset, { fetcher }),
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(await readFile(file), bytes);
});

test('cancellation retains a resumable partial file and never publishes incomplete data', async (t) => {
  const { file } = await fixture(t);
  const abort = new AbortController();
  abort.abort();
  await writeFile(file + '.part', bytes.subarray(0, 5), { mode: 0o600 });
  let requested = false;
  await assert.rejects(
    downloadPayload(file, asset, {
      signal: abort.signal,
      fetcher: async () => {
        requested = true;
        return response();
      },
    }),
  );
  assert.equal(requested, false);
  assert.deepEqual(await readFile(file + '.part'), bytes.subarray(0, 5));
  await assert.rejects(lstat(file), { code: 'ENOENT' });
});

test('does not follow a symlink or accept an insecure download descriptor', async (t) => {
  const { directory, file } = await fixture(t);
  const other = path.join(directory, 'unrelated.txt');
  await writeFile(other, 'SYNTHETIC UNRELATED FILE', { mode: 0o600 });
  if (process.platform !== 'win32') {
    await symlink(other, file + '.part');
    await assert.rejects(
      downloadPayload(file, asset, { fetcher: async () => response() }),
      /PAYLOAD_UNSAFE/,
    );
    assert.equal(await readFile(other, 'utf8'), 'SYNTHETIC UNRELATED FILE');
  }
  await assert.rejects(
    downloadPayload(file, { ...asset, url: 'http://example.test/runtime.zip' }),
    /PAYLOAD_DESCRIPTOR/,
  );
});

test('closes a rejected response body and refuses an HTTPS redirect downgrade', async (t) => {
  const { file } = await fixture(t);
  let cancelled = false;
  await assert.rejects(
    downloadPayload(file, asset, {
      fetcher: async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: { 'content-length': '1' },
          },
        ),
    }),
    /PAYLOAD_LENGTH/,
  );
  assert.equal(cancelled, true);
  await assert.rejects(
    downloadPayload(file, asset, {
      fetcher: async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'http://example.test/unsafe.zip' },
        }),
    }),
    /PAYLOAD_DESCRIPTOR/,
  );
});

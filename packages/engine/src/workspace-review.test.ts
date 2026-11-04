import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, vi } from 'vitest';
import { WorkspaceFiles } from './workspace.js';
import { captureWorkspaceReview, checkedReviewCapture } from './workspace-review.js';

const captureTest = test.skipIf(process.platform !== 'linux');

captureTest(
  'capture records synthetic input bytes and digest rather than a display list',
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'input.txt'), 'before\n');
    const capture = await captureWorkspaceReview(root, await realpath(root));
    expect(capture.files).toEqual([
      {
        area: 'task',
        path: 'input.txt',
        state: 'present',
        bytes: 7,
        sha256: createHash('sha256').update('before\n').digest('hex'),
        text: true,
      },
    ]);
    expect(capture.texts).toEqual([
      { area: 'task', path: 'input.txt', data: Buffer.from('before\n').toString('base64') },
    ]);
    expect(capture.snapshot.capture).toBe('complete');
  },
);

captureTest(
  'WorkspaceFiles exposes the same bounded capture without using its truncated list',
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-facade-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const workspace = new WorkspaceFiles(root);
    await writeFile(path.join(root, '.input.txt'), 'synthetic');
    workspace.list = async () => {
      throw Error('DISPLAY_LIST_MUST_NOT_CAPTURE');
    };
    expect((await workspace.captureReview()).files).toMatchObject([
      { path: '.input.txt', state: 'present' },
    ]);
  },
);

captureTest(
  'hidden inputs are included while excluded directories and downloads make coverage partial',
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-hidden-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, '.input'), 'synthetic');
    await writeFile(path.join(root, '.browser-download-mock'), 'incomplete');
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'secret'), 'synthetic excluded');
    await mkdir(path.join(root, '.skills-mock'));
    const capture = await captureWorkspaceReview(root, await realpath(root));
    expect(capture.files.map((file) => file.path)).toEqual(['.input']);
    expect(capture.snapshot).toMatchObject({
      capture: 'partial',
      omitted: 3,
      reasons: ['excluded'],
    });
  },
);

captureTest(
  'shared paths are exact, missing remains absent and unsafe links never expose bytes',
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-shared-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'input.txt'), 'synthetic input');
    await writeFile(path.join(root, 'unselected.txt'), 'synthetic private');
    await symlink(path.join(root, 'unselected.txt'), path.join(root, 'linked.txt'));
    await link(path.join(root, 'unselected.txt'), path.join(root, 'hard.txt'));
    const capture = await captureWorkspaceReview(root, await realpath(root), [
      'missing.txt',
      'linked.txt',
      'hard.txt',
      'input.txt',
    ]);
    expect(capture.files.map((file) => [file.path, file.state])).toEqual([
      ['hard.txt', 'unknown'],
      ['input.txt', 'present'],
      ['linked.txt', 'unknown'],
      ['missing.txt', 'absent'],
    ]);
    expect(capture.texts.map((file) => file.path)).toEqual(['input.txt']);
    expect(capture.snapshot.capture).toBe('partial');
    await expect(
      captureWorkspaceReview(root, await realpath(root), ['../escape']),
    ).rejects.toMatchObject({ code: 'INVALID_FILE' });
  },
);

captureTest('binary, oversized and text-limited evidence never claims retained text', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-review-budgets-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'binary'), Buffer.from([0xff, 0xfe]));
  await writeFile(path.join(root, 'nul'), Buffer.from([65, 0, 66]));
  await writeFile(path.join(root, 'large'), Buffer.alloc(16 * 1024 * 1024 + 1));
  await writeFile(path.join(root, 'long'), 'x'.repeat(256 * 1024 + 1));
  const capture = await captureWorkspaceReview(root, await realpath(root));
  expect(capture.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'binary', state: 'present', text: false }),
      expect.objectContaining({ path: 'nul', state: 'present', text: false }),
      expect.objectContaining({ path: 'large', state: 'unknown', reason: 'size-limit' }),
      expect.objectContaining({ path: 'long', state: 'present', text: false }),
    ]),
  );
  expect(capture.texts).toEqual([]);
  expect(capture.snapshot.reasons).toEqual(expect.arrayContaining(['size-limit', 'text-limit']));
});

captureTest('entry and depth bounds are explicit partial observations', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-review-entries-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 2001 }, (_, i) => writeFile(path.join(root, `mock-${i}`), '')),
  );
  const capture = await captureWorkspaceReview(root, await realpath(root));
  expect(capture.files.length).toBeLessThanOrEqual(2000);
  expect(capture.snapshot).toMatchObject({ capture: 'partial', reasons: ['entry-limit'] });
  const deep = await mkdtemp(path.join(tmpdir(), 'mock-review-depth-'));
  t.onTestFinished(() => rm(deep, { recursive: true, force: true }));
  const target = path.join(deep, ...Array.from({ length: 17 }, () => 'nested'));
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, 'hidden.txt'), 'synthetic');
  expect((await captureWorkspaceReview(deep, await realpath(deep))).snapshot).toMatchObject({
    capture: 'partial',
    reasons: ['entry-limit'],
  });
});

captureTest(
  'replacement or truncation while reading returns unknown rather than mixed evidence',
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-unstable-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const target = path.join(root, 'input.txt');
    await writeFile(target, 'synthetic original');
    const capture = await captureWorkspaceReview(root, await realpath(root), undefined, undefined, {
      afterOpen: async () => truncate(target, 1),
    });
    expect(capture.files).toEqual([
      { area: 'task', path: 'input.txt', state: 'unknown', reason: 'unstable' },
    ]);
    expect(capture.texts).toEqual([]);
    expect(capture.snapshot.capture).toBe('partial');
  },
);

captureTest(
  'root swaps discard all text, and cancellation never returns a complete capture',
  async (t) => {
    const parent = await mkdtemp(path.join(tmpdir(), 'mock-review-root-'));
    t.onTestFinished(() => rm(parent, { recursive: true, force: true }));
    const root = path.join(parent, 'workspace');
    await mkdir(root);
    await writeFile(path.join(root, 'input'), 'synthetic input');
    const capture = await captureWorkspaceReview(root, await realpath(root), undefined, undefined, {
      afterOpen: async () => {
        await rename(root, path.join(parent, 'moved'));
        await mkdir(root);
      },
    });
    expect(capture.snapshot.reasons).toContain('root-moved');
    expect(capture.texts).toEqual([]);
    expect(capture.files.every((file) => file.state !== 'present')).toBe(true);
    const abort = new AbortController();
    abort.abort();
    const cancelled = await captureWorkspaceReview(
      root,
      await realpath(root),
      ['missing'],
      abort.signal,
    );
    expect(cancelled.snapshot).toMatchObject({ capture: 'unknown', reasons: ['cancelled'] });
  },
);

test('runtime text requires matching digest as well as bounded shape', () => {
  const at = '2026-01-01T00:00:00.000Z';
  const capture = {
    snapshot: {
      area: 'task',
      startedAt: at,
      endedAt: at,
      capture: 'complete',
      reasons: [],
      omitted: 0,
    },
    files: [
      {
        area: 'task',
        path: 'input.txt',
        state: 'present',
        bytes: 4,
        sha256: 'a'.repeat(64),
        text: true,
      },
    ],
    texts: [{ area: 'task', path: 'input.txt', data: Buffer.from('mock').toString('base64') }],
  };
  expect(() => checkedReviewCapture(capture)).toThrow('INVALID_EXECUTOR_RESPONSE');
});

captureTest('shared paths still obey the directory depth bound', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-review-shared-depth-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const relative = [...Array.from({ length: 17 }, () => 'd'), 'input'].join('/');
  await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
  await writeFile(path.join(root, relative), 'synthetic');
  const capture = await captureWorkspaceReview(root, await realpath(root), [relative]);
  expect(capture.files).toEqual([
    { area: 'shared', path: relative, state: 'unknown', reason: 'entry-limit' },
  ]);
  expect(capture.texts).toEqual([]);
});

captureTest(
  'total retained text and total hashing budgets preserve digest-only or unknown evidence',
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-total-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const chunk = Buffer.alloc(256 * 1024, 65);
    await Promise.all(
      Array.from({ length: 17 }, (_, i) =>
        writeFile(path.join(root, `text-${String(i).padStart(2, '0')}`), chunk),
      ),
    );
    const capture = await captureWorkspaceReview(root, await realpath(root));
    expect(capture.files).toHaveLength(17);
    expect(capture.texts).toHaveLength(16);
    expect(capture.snapshot.reasons).toContain('text-limit');
    await rm(root, { recursive: true });
    await mkdir(root);
    const binary = Buffer.alloc(16 * 1024 * 1024);
    for (let i = 0; i < 5; i++) await writeFile(path.join(root, `binary-${i}`), binary);
    const bounded = await captureWorkspaceReview(root, await realpath(root));
    expect(bounded.files.filter((file) => file.state === 'present')).toHaveLength(4);
    expect(bounded.files.filter((file) => file.state === 'unknown')).toMatchObject([
      { reason: 'size-limit' },
    ]);
    expect(bounded.snapshot.capture).toBe('partial');
  },
);

captureTest(
  'directory mutation invalidates observed descendants, while a replaced file cannot reuse evidence',
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-directory-race-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(path.join(root, 'nested'));
    await writeFile(path.join(root, 'nested/input'), 'synthetic before');
    let once = false;
    const capture = await captureWorkspaceReview(root, await realpath(root), undefined, undefined, {
      afterOpen: async () => {
        if (once) return;
        once = true;
        await writeFile(path.join(root, 'nested/new'), 'synthetic later');
      },
    });
    expect(capture.snapshot.reasons).toContain('unstable');
    expect(capture.texts).toEqual([]);
    expect(capture.files.every((file) => file.state === 'unknown')).toBe(true);
    const replaced = await captureWorkspaceReview(
      root,
      await realpath(root),
      ['nested/input'],
      undefined,
      {
        afterOpen: async () => {
          await rename(path.join(root, 'nested/input'), path.join(root, 'nested/old'));
          await writeFile(path.join(root, 'nested/input'), 'synthetic replacement');
        },
      },
    );
    expect(replaced.files[0]).toMatchObject({ state: 'unknown', reason: 'unstable' });
    expect(replaced.texts).toEqual([]);
  },
);

captureTest(
  'a deadline returns explicit unknown evidence instead of an empty complete inventory',
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-review-time-'));
    t.onTestFinished(() => rm(root, { recursive: true, force: true }));
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValue(6000);
    t.onTestFinished(() => clock.mockRestore());
    const capture = await captureWorkspaceReview(root, await realpath(root), ['input']);
    expect(capture.snapshot).toMatchObject({ capture: 'unknown', reasons: ['time-limit'] });
    expect(capture.files[0]).toMatchObject({ state: 'unknown', reason: 'time-limit' });
  },
);

captureTest('FIFO and cancellation during an opened read return no text', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-review-fifo-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  await promisify(execFile)('mkfifo', [path.join(root, 'fifo')]);
  const fifo = await captureWorkspaceReview(root, await realpath(root));
  expect(fifo.files).toEqual([
    { area: 'task', path: 'fifo', state: 'unknown', reason: 'permission' },
  ]);
  expect(fifo.texts).toEqual([]);
  await writeFile(path.join(root, 'input'), 'synthetic');
  const abort = new AbortController();
  const capture = await captureWorkspaceReview(
    root,
    await realpath(root),
    ['input'],
    abort.signal,
    {
      afterOpen: async () => abort.abort(),
    },
  );
  expect(capture.snapshot).toMatchObject({ capture: 'unknown', reasons: ['cancelled'] });
  expect(capture.texts).toEqual([]);
});

captureTest('serialization is bounded independently from entry and text budgets', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mock-review-wire-'));
  t.onTestFinished(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, ...Array.from({ length: 3 }, () => '路'.repeat(70)));
  await mkdir(directory, { recursive: true });
  const text = 'x'.repeat(256 * 1024);
  for (let offset = 0; offset < 1950; offset += 50) {
    await Promise.all(
      Array.from({ length: 50 }, (_, index) => {
        const i = offset + index;
        return writeFile(
          path.join(directory, `${'文'.repeat(20)}-${String(i).padStart(4, '0')}`),
          i < 16 ? text : '',
        );
      }),
    );
  }
  const capture = await captureWorkspaceReview(root, await realpath(root));
  expect(Buffer.byteLength(JSON.stringify(capture))).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(capture.snapshot.reasons).toContain('size-limit');
  expect(capture.snapshot.capture).toBe('partial');
  expect(capture.snapshot.omitted).toBeGreaterThan(0);
});

test.runIf(process.platform !== 'linux')(
  'unsupported platform never adopts a weaker file reader',
  async () => {
    const capture = await captureWorkspaceReview(
      '/synthetic/nonexistent',
      '/synthetic/nonexistent',
    );
    expect(capture.snapshot).toMatchObject({ capture: 'unknown', reasons: ['unsupported'] });
    expect(capture.files).toEqual([]);
  },
);

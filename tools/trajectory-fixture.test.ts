import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ModelRuns, type TrajectoryCase } from '@daban/engine/agent';
import { afterEach, expect, test, vi } from 'vitest';
import { smokeCases, unknownCase } from './trajectory-cases.ts';
import {
  collectTrajectoryArtifacts,
  readTrajectoryArtifact,
  runTrajectoryFixture,
} from './trajectory-fixture.ts';

const temporary: string[] = [];
async function directory() {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-artifact-test-'));
  temporary.push(root);
  return root;
}

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(temporary.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test('stable synthetic bytes require a real verified handle and digest', async () => {
  const root = await directory();
  const bytes = 'SYNTHETIC BYTES 🧪\n';
  await writeFile(path.join(root, 'report.txt'), bytes);
  expect(await readTrajectoryArtifact(root, 'report.txt')).toStrictEqual({
    path: 'report.txt',
    state: 'verified',
    size: Buffer.byteLength(bytes),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
});

test('missing, oversized and unsafe synthetic artifacts stay unknown', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'large.bin'), Buffer.alloc(1024 * 1024 + 1));
  for (const [file, reason] of [
    ['missing.txt', 'missing'],
    ['large.bin', 'too-large'],
    ['../target.txt', 'unsafe'],
    ['/target.txt', 'unsafe'],
    ['C:\\target.txt', 'unsafe'],
  ])
    expect(await readTrajectoryArtifact(root, file)).toStrictEqual({
      path: file,
      state: 'unknown',
      reason,
    });
});

test.skipIf(process.platform === 'win32')('artifact reads reject file symlinks', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'target.txt'), 'SYNTHETIC TARGET');
  await symlink(path.join(root, 'target.txt'), path.join(root, 'linked.txt'));
  expect(await readTrajectoryArtifact(root, 'linked.txt')).toStrictEqual({
    path: 'linked.txt',
    state: 'unknown',
    reason: 'unsafe',
  });
});

test('a same-sized rewrite during a stable read is unknown', async () => {
  const root = await directory();
  const file = path.join(root, 'changed.txt');
  await writeFile(file, 'SYNTHETIC-A');
  const result = await readTrajectoryArtifact(root, 'changed.txt', async (handle) => {
    const bytes = await handle.readFile();
    await writeFile(file, 'SYNTHETIC-B');
    return bytes;
  });
  expect(result).toStrictEqual({ path: 'changed.txt', state: 'unknown', reason: 'changed' });
});

test('a pathname replaced during a stable read cannot certify the original opened bytes', async () => {
  const root = await directory();
  const file = path.join(root, 'replaced.txt');
  await writeFile(file, 'SYNTHETIC BYTES');
  const result = await readTrajectoryArtifact(root, 'replaced.txt', async (handle) => {
    const bytes = await handle.readFile();
    await rename(file, path.join(root, 'old.txt'));
    await writeFile(file, bytes);
    return bytes;
  });
  expect(result).toStrictEqual({ path: 'replaced.txt', state: 'unknown', reason: 'changed' });
});

test('artifact reads reject a linked parent directory', async () => {
  const root = await directory();
  const target = await directory();
  await writeFile(path.join(target, 'report.txt'), 'SYNTHETIC OUTSIDE');
  // Windows junctions exercise directory-link rejection without requiring symlink privileges.
  await symlink(
    target,
    path.join(root, 'linked'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(await readTrajectoryArtifact(root, 'linked/report.txt')).toStrictEqual({
    path: 'linked/report.txt',
    state: 'unknown',
    reason: 'unsafe',
  });
});

test('artifact collection retains extra files and records missing expected files', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'extra.txt'), 'SYNTHETIC EXTRA');
  const result = await collectTrajectoryArtifacts(root, ['missing.txt']);
  expect(result.complete).toBe(true);
  expect(result.artifacts.map((artifact) => artifact.path)).toStrictEqual([
    'extra.txt',
    'missing.txt',
  ]);
  expect(result.artifacts[1]).toMatchObject({ state: 'unknown', reason: 'missing' });
});

test('too many artifact paths make collection explicitly incomplete', async () => {
  const root = await directory();
  await Promise.all(
    Array.from({ length: 65 }, (_, index) =>
      writeFile(path.join(root, `mock-${index}.txt`), 'SYNTHETIC'),
    ),
  );
  const result = await collectTrajectoryArtifacts(root, []);
  expect(result.complete).toBe(false);
  expect(result.artifacts.length).toBeLessThanOrEqual(64);
});

test('smoke fixtures use current scoped ModelRuns with no real dispatch or provider request', async () => {
  const rpc = vi.spyOn(ModelRuns.prototype, 'rpc').mockImplementation(async () => {
    throw new Error('SYNTHETIC FIXTURE MUST NOT DISPATCH');
  });
  const provider = vi.fn(async () => {
    throw new Error('SYNTHETIC FIXTURE MUST NOT FETCH');
  });
  vi.stubGlobal('fetch', provider);
  const scopes: string[] = [];
  for (const spec of smokeCases) {
    const capture = await runTrajectoryFixture(spec);
    scopes.push(capture.scope.runId);
    expect(capture.origin).toBe('synthetic');
    expect(capture.drained).toBe(true);
    expect(capture.lateEvents).toBe(0);
    expect(capture.terminal).toBe(spec.terminal);
    expect(capture.modelRequests).toBe(1);
    expect(capture.pages.every((page) => page.state === 'complete')).toBe(true);
    const allowed = new Set(
      capture.pages
        .flatMap((page) =>
          page.items.filter((item) => ['call', 'result', 'interaction'].includes(item.kind)),
        )
        .map((item) => item.seq),
    );
    expect(capture.contents.every((content) => allowed.has(content.seq))).toBe(true);
  }
  expect(new Set(scopes).size).toBe(smokeCases.length);
  expect(provider).not.toHaveBeenCalled();
  expect(rpc).not.toHaveBeenCalled();
});

test('the synthetic unknown script is captured once without replay', async () => {
  const capture = await runTrajectoryFixture(unknownCase);
  expect(
    capture.pages.flatMap((page) => page.items).filter((item) => item.kind === 'call'),
  ).toHaveLength(1);
  expect(capture.contents.some((content) => content.text.includes('COMMAND_OUTCOME_UNKNOWN'))).toBe(
    true,
  );
});

test('repeated cases use new profiles and remove only their closed synthetic directories', async () => {
  const [first, second] = await Promise.all([
    runTrajectoryFixture(smokeCases[0]),
    runTrajectoryFixture(smokeCases[0]),
  ]);
  expect(first.scope.runId).not.toBe(second.scope.runId);
  expect(first.sessionId).not.toBe(second.sessionId);
  expect(first.bindings.workspace).not.toBe(second.bindings.workspace);
  expect(first.artifacts).toStrictEqual(second.artifacts);
  for (const capture of [first, second])
    await expect(lstat(path.dirname(capture.bindings.workspace))).rejects.toMatchObject({
      code: 'ENOENT',
    });
});

test('capture reads complete pages and UTF-16 blocks but never assistant or thinking bodies', async () => {
  const long = 'SYNTHETIC 🧪 '.repeat(4000);
  const spec: TrajectoryCase = {
    schema: 1,
    id: 'synthetic-paged',
    revision: 1,
    input: {
      prompt: 'SYNTHETIC PAGING',
      events: [
        ...Array.from({ length: 15 }, (_, index) => [
          {
            kind: 'call' as const,
            callId: `mock-call-${index}`,
            tool: 'read_file',
            args: { text: long },
          },
          {
            kind: 'result' as const,
            callId: `mock-call-${index}`,
            body: { ok: true },
            isError: false,
          },
        ]).flat(),
        { kind: 'barrier', action: 'complete' },
      ],
      files: [],
    },
    steps: [],
    terminal: 'completed',
    budget: { maxCalls: 15 },
    artifacts: [],
    rules: [],
    sensitive: [],
  };
  const capture = await runTrajectoryFixture(spec);
  expect(capture.pages.length).toBeGreaterThan(1);
  expect(capture.contents.filter((content) => content.seq === 1).length).toBeGreaterThan(1);
  expect(
    capture.contents
      .filter((content) => content.seq === 1)
      .map((part) => part.text)
      .join(''),
  ).toBe(JSON.stringify({ text: long }));
  const assistant = capture.pages
    .flatMap((page) => page.items)
    .filter((item) => ['assistant', 'thinking'].includes(item.kind))
    .map((item) => item.seq);
  expect(capture.contents.some((content) => assistant.includes(content.seq))).toBe(false);
});

test('a stop barrier closes the owned mock and preserves its durable stopped terminal', async () => {
  const cancel = smokeCases.find((spec) => spec.id === 'simulated-cancel-sequence')!;
  const capture = await runTrajectoryFixture(cancel);
  expect(capture.drained).toBe(true);
  expect(capture.terminal).toBe('stopped');
  expect(capture.pages.at(-1)?.state).toBe('complete');
});

test('events after a completion barrier remain late evidence and cannot mutate frozen capture', async () => {
  const spec: TrajectoryCase = {
    ...unknownCase,
    id: 'synthetic-late',
    input: {
      ...unknownCase.input,
      events: [
        ...unknownCase.input.events,
        { kind: 'call', callId: 'mock-late-call', tool: 'write_file', args: {} },
        { kind: 'result', callId: 'mock-late-call', body: { ok: true }, isError: false },
      ],
    },
  };
  const capture = await runTrajectoryFixture(spec);
  expect(capture.lateEvents).toBe(2);
  const frozen = JSON.stringify(capture);
  await new Promise((resolve) => setImmediate(resolve));
  expect(JSON.stringify(capture)).toBe(frozen);
});

test('aborting one fixture leaves a concurrent independent fixture usable', async () => {
  const controller = new AbortController();
  const stopped = runTrajectoryFixture(unknownCase, { signal: controller.signal });
  controller.abort();
  const [first, other] = await Promise.all([stopped, runTrajectoryFixture(unknownCase)]);
  expect(first.terminal).not.toBe('completed');
  expect(other.terminal).toBe('completed');
  expect(other.drained).toBe(true);
  expect(first.scope.runId).not.toBe(other.scope.runId);
});

test('an abort after acceptance stops its owned run before returning the capture', async () => {
  const controller = new AbortController();
  const original = ModelRuns.prototype.start;
  vi.spyOn(ModelRuns.prototype, 'start').mockImplementation(async function (
    this: ModelRuns,
    ...args: Parameters<ModelRuns['start']>
  ) {
    const result = await original.apply(this, args);
    controller.abort();
    return result;
  });
  const capture = await runTrajectoryFixture(unknownCase, { signal: controller.signal });
  expect(capture.terminal).toBe('stopped');
  expect(capture.drained).toBe(true);
});

test('the fixture does not return while its owned ModelRuns close is unfinished', async () => {
  let entered!: () => unknown;
  let release!: () => unknown;
  const closing = new Promise<unknown>((resolve) => {
    entered = () => resolve(undefined);
  });
  const gate = new Promise<unknown>((resolve) => {
    release = () => resolve(undefined);
  });
  const original = ModelRuns.prototype.close;
  vi.spyOn(ModelRuns.prototype, 'close').mockImplementation(async function (this: ModelRuns) {
    entered();
    await gate;
    await original.call(this);
  });
  let settled = false;
  const running = runTrajectoryFixture(unknownCase).then((capture) => {
    settled = true;
    return capture;
  });
  await closing;
  expect(settled).toBe(false);
  release();
  expect((await running).drained).toBe(true);
});

test('fixtures reject undeclared aliases before creating a mock run', async () => {
  const start = vi.spyOn(ModelRuns.prototype, 'start');
  const spec: TrajectoryCase = {
    ...unknownCase,
    input: {
      ...unknownCase.input,
      events: [
        {
          kind: 'call',
          callId: 'mock-alias',
          tool: 'read_file',
          args: { path: `\${undeclared}/file.txt` },
        },
        { kind: 'barrier', action: 'complete' },
      ],
    },
  };
  await expect(runTrajectoryFixture(spec)).rejects.toThrow(/ALIAS/);
  expect(start).not.toHaveBeenCalled();
});

test.each([
  `prefix-\${workspace}/file.txt`,
  `\${workspace}/../file.txt`,
  `\${workspace}//file.txt`,
  `\${workspace}/file/\${workspace}`,
  `\${workspace}/file\\child.txt`,
])('fixtures reject unsupported alias form %s before creating a mock run', async (value) => {
  const start = vi.spyOn(ModelRuns.prototype, 'start');
  const base = smokeCases[0];
  const spec: TrajectoryCase = {
    ...base,
    input: {
      ...base.input,
      events: base.input.events.map((event) =>
        event.kind === 'call' ? { ...event, args: { path: value } } : event,
      ),
    },
  };
  await expect(runTrajectoryFixture(spec)).rejects.toThrow(/ALIAS/);
  expect(start).not.toHaveBeenCalled();
});

test('fixtures reject artifact input above the fixed limit before creating a mock run', async () => {
  const start = vi.spyOn(ModelRuns.prototype, 'start');
  const spec: TrajectoryCase = {
    ...unknownCase,
    input: {
      ...unknownCase.input,
      files: Array.from({ length: 65 }, (_, index) => ({
        path: `mock-${index}.txt`,
        utf8: 'SYNTHETIC',
      })),
    },
  };
  await expect(runTrajectoryFixture(spec)).rejects.toThrow();
  expect(start).not.toHaveBeenCalled();
});

test('artifact read errors do not reveal filesystem contents', async () => {
  const root = await directory();
  await writeFile(path.join(root, 'report.txt'), 'SYNTHETIC PRIVATE VALUE');
  const result = await readTrajectoryArtifact(root, 'report.txt', async () => {
    throw new Error(await readFile(path.join(root, 'report.txt'), 'utf8'));
  });
  expect(result).toStrictEqual({ path: 'report.txt', state: 'unknown', reason: 'unsafe' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE VALUE');
});

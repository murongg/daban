import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { isReviewCapture, workspaceReviewCapability } from '@daban/protocol';
import { RemoteExecutor } from './execution.js';
import { startExecutor } from './executor.js';
import { FileReviews } from './file-review.js';
import { RemoteWorkspace } from './remote-workspace.js';
import { captureWorkspaceReview } from './workspace-review.js';

const linux = { skip: process.platform !== 'linux', timeout: 20000 };

test(
  'Linux capture observes synthetic shell writes only inside its explicit range',
  linux,
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-file-review-shell-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(workspace, 'input.txt'), 'before\n');
    const before = await captureWorkspaceReview(workspace, await realpath(workspace));
    assert.equal(before.files[0].state, 'present');
    const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
    const reviews = new FileReviews(path.join(root, 'private-reviews'));
    await reviews.begin(scope);
    await reviews.before(scope, [before], {
      task: { root: workspace, canonical: await realpath(workspace) },
    });
    await promisify(execFile)('/bin/sh', [
      '-c',
      'printf "after\\n" > "$1/input.txt"; printf "output\\n" > "$1/output.txt"; printf "outside\\n" > "$2"; printf "transient" > "$1/transient.txt"; rm "$1/transient.txt"',
      'mock-task',
      workspace,
      path.join(root, 'outside.txt'),
    ]);
    const after = await captureWorkspaceReview(workspace, await realpath(workspace));
    assert.deepEqual(
      after.files.map((file) => file.path),
      ['input.txt', 'output.txt'],
    );
    assert.equal(after.snapshot.capture, 'complete');
    assert.equal(
      after.texts.find((file) => file.path === 'input.txt')?.data,
      Buffer.from('after\n').toString('base64'),
    );
    assert.equal(before.texts[0].data, Buffer.from('before\n').toString('base64'));
    // Range completeness is independent from effects outside this range or a transient file between observations.
    assert.equal(await readFile(path.join(root, 'outside.txt'), 'utf8'), 'outside\n');
    const pointer = await reviews.finish(scope, [after]);
    const report = await reviews.read({ scope });
    assert.deepEqual(report.counts, {
      created: 1,
      modified: 1,
      deleted: 0,
      unchanged: 0,
      unknown: 0,
    });
    assert.equal(report.effects, 'partial');
    assert.equal(report.writers, 'unknown');
    const query = { scope, revision: pointer.revision, area: 'task' as const, path: 'input.txt' };
    const diff = await reviews.diff(query);
    assert.equal(diff.state, 'text');
    await writeFile(path.join(workspace, 'input.txt'), 'later\n');
    assert.equal(
      (
        await reviews.current(query, (root, paths) =>
          captureWorkspaceReview(root.root, root.canonical, paths),
        )
      ).state,
      'changed',
    );
    assert.deepEqual(await reviews.diff(query), diff);
  },
);

test(
  'Linux links, FIFO, root replacement and cancellation cannot leak bytes or descriptors',
  linux,
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-file-review-fd-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    await mkdir(workspace);
    await writeFile(path.join(root, 'private.txt'), 'SYNTHETIC OUTSIDE');
    await symlink(path.join(root, 'private.txt'), path.join(workspace, 'symlink'));
    await link(path.join(root, 'private.txt'), path.join(workspace, 'hardlink'));
    await promisify(execFile)('mkfifo', [path.join(workspace, 'fifo')]);
    const links = await captureWorkspaceReview(workspace, await realpath(workspace));
    assert.equal(links.files.length, 3);
    assert.ok(links.files.every((file) => file.state === 'unknown'));
    assert.deepEqual(links.texts, []);
    const before = (await readdir('/proc/self/fd')).length;
    for (let i = 0; i < 20; i++) {
      const abort = new AbortController();
      abort.abort();
      const cancelled = await captureWorkspaceReview(
        workspace,
        await realpath(workspace),
        ['symlink'],
        abort.signal,
      );
      assert.equal(cancelled.snapshot.capture, 'unknown');
      assert.ok(cancelled.snapshot.reasons.includes('cancelled'));
    }
    assert.ok((await readdir('/proc/self/fd')).length <= before);
    await writeFile(path.join(workspace, 'input.txt'), 'SYNTHETIC INPUT');
    const moved = await captureWorkspaceReview(
      workspace,
      await realpath(workspace),
      undefined,
      undefined,
      {
        afterOpen: async () => {
          await rename(workspace, path.join(root, 'moved'));
          await symlink(root, workspace);
        },
      },
    );
    assert.ok(moved.snapshot.reasons.includes('root-moved'));
    assert.deepEqual(moved.texts, []);
    assert.ok(moved.files.every((file) => file.state !== 'present'));
  },
);

test(
  'Linux review RPC carries real guest capture without reading a Host fallback',
  linux,
  async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mock-file-review-rpc-'));
    const executor = await startExecutor({ directory: root, port: 0, boot: 'mock-review-boot' });
    t.after(async () => {
      await executor.close();
      await rm(root, { recursive: true, force: true });
    });
    const token = (await readFile(path.join(root, 'token'), 'utf8')).trim();
    const execution = new RemoteExecutor({ url: `${executor.origin}/exec`, token });
    await execution.ready;
    assert.ok(execution.snapshot?.capabilities.includes(workspaceReviewCapability));
    const workspace = new RemoteWorkspace(execution);
    const directory = await workspace.create(['mock-review-run', 'mock-bot']);
    await directory.write('input.txt', 'SYNTHETIC GUEST');
    const capture = await workspace.scope(directory.canonical, directory.canonical).captureReview();
    assert.equal(isReviewCapture(capture), true);
    assert.equal(capture.files[0].state, 'present');
    assert.equal(Buffer.from(capture.texts[0].data, 'base64').toString('utf8'), 'SYNTHETIC GUEST');
    await assert.rejects(
      execution.call('workspace.review.capture', { root: `${root}-outside` }),
      /EXECUTION_WORKSPACE_SCOPE/,
    );
    await directory.close();
  },
);

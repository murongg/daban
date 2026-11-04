import assert from 'node:assert/strict';
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { documentLimit } from '@daban/protocol';
import { type AgentToolRun, AgentTools } from './agent-tools.js';
import { compareFiles } from './file-diff.js';
import { type Browser, createBrowser } from './runtime.js';
import { WorkspaceFiles } from './workspace.js';

const bytes = Buffer.from([0, 1, 2, 3, 47, 53, 59, 255]);
const ref = (text: string, label: string) => {
  const value = text
    .split('\n')
    .find((line) => line.includes(`"${label}"`))
    ?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
  assert.ok(value, `Missing ${label}`);
  return value;
};
const payload = (result: Awaited<ReturnType<AgentTools['invoke']>>) => {
  assert.ok(!result.isError, JSON.stringify(result));
  const part = result.content[0];
  return JSON.parse(part.type === 'text' ? part.text : '') as {
    id: string;
    text: string;
    observation?: { id: string; text: string };
    file?: { path: string; bytes: number };
  };
};
test('real browser tools upload actual task bytes, download binary output, refuse overwrite/oversize and cancel a slow transfer', {
  skip: process.platform !== 'linux',
  timeout: 60000,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-transfer-'));
  const workspace = path.join(root, 'workspace'),
    workdir = path.join(workspace, 'current');
  await mkdir(workdir, { recursive: true });
  await writeFile(path.join(workdir, 'source.csv'), 'item,count\nSYNTHETIC-UPLOAD-79,47');
  let browser: Browser | undefined;
  let uploaded = false;
  let started!: () => unknown;
  const slowStarted = new Promise<unknown>((resolve) => {
    started = () => resolve(undefined);
  });
  const server = createServer(async (req, res) => {
    if (
      req.url === '/fixture/download' ||
      req.url === '/fixture/large' ||
      req.url === '/fixture/slow-download'
    ) {
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('content-disposition', 'attachment; filename="synthetic.bin"');
      if (req.url === '/fixture/download') {
        res.end(bytes);
        return;
      }
      if (req.url === '/fixture/large') {
        res.setHeader('content-length', documentLimit + 65536);
        res.end(Buffer.alloc(documentLimit + 65536, 65));
        return;
      }
      res.write(Buffer.from('SYNTHETIC-SLOW'));
      started();
      // Keep the transfer incomplete until cancellation; capture latency must not finish the cancel fixture first.
      await new Promise<unknown>((resolve) => res.once('close', () => resolve(undefined)));
      return;
    }
    if (req.method === 'POST' && req.url === '/fixture/upload') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString('utf8');
      uploaded = body.includes('SYNTHETIC-UPLOAD-79,47') && body.includes('filename="source.csv"');
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(
      `<main><span id="identity" data-ready="true">Guest</span><span id="count">0</span><input id="note"><h1>${uploaded ? 'UPLOAD-OK-79' : 'TRANSFER-READY'}</h1><form method="POST" action="/fixture/upload" enctype="multipart/form-data"><input type="file" name="source" aria-label="Synthetic attachment"><button>Submit synthetic upload</button></form><a href="/fixture/download">Download synthetic binary</a><a href="/fixture/large">Download oversized binary</a><a href="/fixture/slow-download">Download slow binary</a></main>`,
    );
  });
  await new Promise<unknown>((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    browser = await createBrowser({ profileDir: path.join(root, 'profile'), origin });
    const forbidden = async (): Promise<never> => {
      assert.fail('no native GUI or screenshot is needed');
    };
    const tools = new AgentTools(
      {
        control: browser.control,
        frame: forbidden,
        screens: { input: forbidden, openApp: forbidden },
        browser,
      },
      new WorkspaceFiles(workspace),
    );
    const run: AgentToolRun = {
      id: 'mock-transfer-run',
      bot: 'a',
      model: 'deepseek-v4-pro',
      abort: new AbortController(),
      toolCount: 0,
      limit: 30,
      seen: {},
      trace: [],
      workdir,
      canonicalRoot: await realpath(workdir),
      task: {
        requestId: 'mock-transfer-request',
        prompt: '在合成网站上传 source.csv 并下载结果。',
      },
    };
    const reviewWorkspace = new WorkspaceFiles(workdir, await realpath(workdir));
    const beforeFiles = await reviewWorkspace.captureReview();
    let shot = payload(
      await tools.invoke(run, 'browser_navigate', { url: `${origin}/fixture/page` }),
    );
    const attached = payload(
      await tools.invoke(run, 'browser_upload', {
        observation: shot.id,
        ref: ref(shot.text, 'Synthetic attachment'),
        path: 'source.csv',
      }),
    );
    assert.ok(attached.observation);
    shot = attached.observation;
    await browser.page('a').evaluate(() => {
      const input = document.querySelector<HTMLInputElement>('input[type=file]')!;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Choose via synthetic dialog';
      button.addEventListener('click', () => input.click());
      document.body.prepend(button);
    });
    shot = payload(await tools.invoke(run, 'browser_snapshot', {}));
    const chosen = payload(
      await tools.invoke(run, 'browser_upload', {
        observation: shot.id,
        ref: ref(shot.text, 'Choose via synthetic dialog'),
        path: 'source.csv',
      }),
    );
    assert.ok(chosen.observation);
    shot = chosen.observation;
    const submitted = payload(
      await tools.invoke(run, 'browser_act', {
        observation: shot.id,
        actions: [{ kind: 'click', ref: ref(shot.text, 'Submit synthetic upload') }],
      }),
    );
    assert.ok(submitted.observation);
    shot = submitted.observation;
    assert.match(shot.text, /UPLOAD-OK-79/);
    assert.equal(uploaded, true);
    const probe = await open(path.join(root, 'publication-handle-probe'), 'wx', 0o600);
    const fileHandles = Object.getPrototypeOf(probe) as FileHandle;
    await probe.close();
    const originalWrite = fileHandles.writeFile;
    let announceStaging!: () => unknown;
    let releaseStaging!: () => unknown;
    const staging = new Promise<undefined>((resolve) => {
      announceStaging = () => resolve(undefined);
    });
    const released = new Promise<undefined>((resolve) => {
      releaseStaging = () => resolve(undefined);
    });
    let held = false;
    const publicationWrite = t.mock.method(
      fileHandles,
      'writeFile',
      async function (this: FileHandle, ...args: Parameters<FileHandle['writeFile']>) {
        const target = await realpath(`/proc/self/fd/${this.fd}`).catch(() => '');
        if (!held && target.startsWith(`${run.canonicalRoot}/.browser-download-`)) {
          // Download bytes arrive before publication staging exists; hold the real file write to observe that phase deterministically.
          held = true;
          announceStaging();
          await released;
        }
        return originalWrite.apply(this, args);
      },
    );
    const saving = tools.invoke(run, 'browser_download', {
      observation: shot.id,
      ref: ref(shot.text, 'Download synthetic binary'),
      name: 'result.bin',
    });
    try {
      const observed = await Promise.race([
        staging.then(() => true),
        saving.then((result) => {
          payload(result);
          return false;
        }),
      ]);
      assert.equal(
        observed,
        true,
        'publication staging must be observed before download completion',
      );
      const stagedFiles = await reviewWorkspace.captureReview();
      assert.ok(stagedFiles.snapshot.reasons.includes('excluded'));
      assert.ok(stagedFiles.files.every((file) => !file.path.startsWith('.browser-download-')));
      assert.ok(stagedFiles.files.every((file) => file.path !== 'result.bin'));
    } finally {
      releaseStaging();
      publicationWrite.mock.restore();
      await saving;
    }
    const saved = payload(await saving);
    assert.ok(saved.file);
    assert.deepEqual(await readFile(path.join(workdir, 'result.bin')), bytes);
    const publishedFiles = await reviewWorkspace.captureReview();
    assert.deepEqual(
      compareFiles([beforeFiles], [publishedFiles]).map((change) => [
        change.before.path,
        change.kind,
      ]),
      [
        ['result.bin', 'created'],
        ['source.csv', 'unchanged'],
      ],
    );
    assert.equal(publishedFiles.files.find((file) => file.path === 'result.bin')?.state, 'present');
    assert.ok(
      publishedFiles.files.some(
        (file) => file.path === 'result.bin' && file.state === 'present' && !file.text,
      ),
    );
    assert.equal(
      await readFile(path.join(workdir, 'source.csv'), 'utf8'),
      'item,count\nSYNTHETIC-UPLOAD-79,47',
    );
    const unrequested = browser.page('a').waitForEvent('download');
    await browser.page('a').getByRole('link', { name: 'Download synthetic binary' }).click();
    await unrequested;
    // The event announces an artifact before async cancellation/deletion; metadata reads must not wait for that IO.
    const directory = path.join(root, 'profile/.downloads'),
      deadline = performance.now() + 2000;
    while ((await readdir(directory)).length && performance.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      await readdir(directory),
      [],
      'unrequested browser downloads must be cancelled and removed',
    );
    shot = payload(await tools.invoke(run, 'browser_snapshot', {}));
    const collision = await tools.invoke(run, 'browser_download', {
      observation: shot.id,
      ref: ref(shot.text, 'Download synthetic binary'),
      name: 'source.csv',
    });
    assert.equal(collision.isError, true);
    assert.match(JSON.stringify(collision), /BROWSER_FILE_EXISTS/);
    const collisionFiles = await reviewWorkspace.captureReview();
    assert.ok(
      compareFiles([publishedFiles], [collisionFiles]).every(
        (change) => change.kind === 'unchanged',
      ),
    );
    assert.equal(
      await readFile(path.join(workdir, 'source.csv'), 'utf8'),
      'item,count\nSYNTHETIC-UPLOAD-79,47',
    );
    shot = payload(await tools.invoke(run, 'browser_snapshot', {}));
    assert.equal(
      (
        await tools.invoke(run, 'browser_download', {
          observation: shot.id,
          ref: ref(shot.text, 'Download oversized binary'),
          name: 'too-large.bin',
        })
      ).isError,
      true,
    );
    await assert.rejects(readFile(path.join(workdir, 'too-large.bin')));
    shot = payload(await tools.invoke(run, 'browser_snapshot', {}));
    const slow = tools.invoke(run, 'browser_download', {
      observation: shot.id,
      ref: ref(shot.text, 'Download slow binary'),
      name: 'cancelled.bin',
    });
    await slowStarted;
    const incompleteFiles = await reviewWorkspace.captureReview();
    assert.ok(incompleteFiles.files.every((file) => !file.path.startsWith('.browser-download-')));
    assert.ok(incompleteFiles.files.every((file) => file.path !== 'cancelled.bin'));
    const human = await Promise.race([
      browser.control.transfer('a', 0, 'human'),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('A background download must not hold the takeover queue')),
          400,
        ),
      ),
    ]);
    assert.equal(human.owner, 'human');
    run.abort.abort();
    assert.equal((await slow).isError, true);
    await assert.rejects(readFile(path.join(workdir, 'cancelled.bin')));
    assert.ok(run.trace.every((trace) => trace.surface === 'browser' && !trace.args));
    assert.ok(
      run.trace.some((trace) => trace.name === 'browser_download' && trace.phase === 'settled'),
    );
  } finally {
    await browser?.close();
    await new Promise<unknown>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve(undefined));
    });
    await rm(root, { recursive: true, force: true });
  }
});

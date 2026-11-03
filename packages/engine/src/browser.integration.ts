import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Browser } from './runtime.js';
import type { Prototype } from './server.js';
import { startPrototype } from './server.js';

test('real browser: shared login, independent pages, both handoffs, persistence, and API boundaries', {
  timeout: 90000,
}, async (t) => {
  const profileDir = await mkdtemp(path.join(tmpdir(), 'bot-browser-test-'));
  let app!: Prototype<Browser>;
  const evidence: { fixture: string; checks: Record<string, unknown>[] } = {
    fixture: 'Synthetic localhost site only',
    checks: [],
  };
  const check = (name: string, detail: Record<string, unknown> = {}) =>
    evidence.checks.push({ name, passed: true, ...detail });
  try {
    app = await startPrototype({ profileDir, port: 0, interval: 100, fixture: true });
    const { runtime } = app;
    const a = runtime.pages.get('a')!;
    const b = runtime.pages.get('b')!;

    await t.test(
      'runtime reports the OS executing Chromium, with Linux required for the VM run',
      async () => {
        const { environment } = await runtime.snapshot();
        assert.equal(environment.platform, process.platform);
        assert.equal(environment.arch, process.arch);
        assert.ok(environment.kernel && environment.browser);
        if (process.env.REQUIRE_LINUX === '1') assert.equal(environment.platform, 'linux');
        check('execution-environment', environment);
      },
    );

    await t.test(
      'a real HttpOnly browser cookie grants the same synthetic identity to both pages',
      async () => {
        assert.equal(await a.locator('#identity').textContent(), '尚未登录');
        await runtime.act('a', 'agent', 0, (page) => page.locator('#login').click());
        await a.waitForFunction(
          () => document.querySelector('#identity')!.textContent === '示例用户',
        );
        await b.waitForFunction(
          () => document.querySelector('#identity')!.textContent === '示例用户',
        );
        const cookie = (await runtime.context.cookies()).find(
          (item) => item.name === 'demo_session',
        );
        assert.ok(cookie);
        assert.equal(cookie.httpOnly, true);
        assert.equal((await a.evaluate(() => document.cookie)).includes('demo_session'), false);
        const identities = await Promise.all(
          [a, b].map((page) => page.locator('#identity').textContent()),
        );
        check('shared-login', { identities, httpOnly: true });
      },
    );

    await t.test('concurrent real clicks and typing stay on their assigned pages', async () => {
      await Promise.all([
        runtime.act('a', 'agent', 0, async (page) => {
          for (let i = 0; i < 3; i++) await page.locator('#increment').click();
          await page.locator('#note').fill('synthetic-note-a');
        }),
        runtime.act('b', 'agent', 0, async (page) => {
          for (let i = 0; i < 7; i++) await page.locator('#increment').click();
          await page.locator('#note').fill('synthetic-note-b');
        }),
      ]);
      assert.equal(await a.locator('#count').textContent(), '3');
      assert.equal(await b.locator('#count').textContent(), '7');
      assert.equal(await a.locator('#note').inputValue(), 'synthetic-note-a');
      assert.equal(await b.locator('#note').inputValue(), 'synthetic-note-b');
      check('independent-pages', { counts: [3, 7], notesDistinct: true });
    });

    for (const [target, other] of [
      ['a', 'b'],
      ['b', 'a'],
    ]) {
      await t.test(
        `human takes ${target.toUpperCase()} while ${other.toUpperCase()} keeps running`,
        async () => {
          await runtime.startWorker('a');
          await runtime.startWorker('b');
          const current = runtime.control.state(target);
          const lease = await runtime.transfer(target, current.epoch, 'human');
          const targetPage = runtime.pages.get(target)!;
          const otherPage = runtime.pages.get(other)!;
          const before = Number(await targetPage.locator('#count').textContent());
          const otherBefore = Number(await otherPage.locator('#count').textContent());
          await otherPage.waitForFunction(
            (n) => Number(document.querySelector('#count')!.textContent) >= n + 2,
            otherBefore,
          );
          assert.equal(Number(await targetPage.locator('#count').textContent()), before);
          await assert.rejects(
            runtime.act(target, 'agent', current.epoch, () => assert.fail()),
            { code: 'STALE_CONTROL' },
          );
          const note = await targetPage.locator('#note').boundingBox();
          await runtime.input(target, lease.epoch, {
            type: 'click',
            x: note!.x + 15,
            y: note!.y + 15,
          });
          await runtime.input(target, lease.epoch, { type: 'key', key: 'ControlOrMeta+A' });
          await runtime.input(target, lease.epoch, { type: 'text', text: `手动输入-${target}` });
          assert.equal(await targetPage.locator('#note').inputValue(), `手动输入-${target}`);
          assert.ok(note);
          const increment = await targetPage.locator('#increment').boundingBox();
          await runtime.input(target, lease.epoch, {
            type: 'click',
            x: increment!.x + 15,
            y: increment!.y + 15,
          });
          assert.equal(Number(await targetPage.locator('#count').textContent()), before + 1);
          const returned = await runtime.transfer(target, lease.epoch, 'agent');
          await assert.rejects(runtime.input(target, lease.epoch, { type: 'key', key: 'Enter' }), {
            code: 'STALE_CONTROL',
          });
          await targetPage.waitForFunction(
            (n) => Number(document.querySelector('#count')!.textContent) > n,
            before + 1,
          );
          assert.equal(returned.owner, 'agent');
          await Promise.all(['a', 'b'].map((id) => runtime.stopWorker(id)));
          check(`handoff-${target}`, {
            otherContinued: true,
            staleInputRejected: true,
            resumed: true,
          });
        },
      );
    }

    await t.test('actual browser frames are different and not placeholders', async () => {
      const frames = await Promise.all(['a', 'b'].map((id) => runtime.frame(id)));
      assert.ok(frames.every((frame) => frame.length > 10000));
      assert.notDeepEqual(frames[0], frames[1]);
      if (process.env.EVIDENCE_DIR) {
        await mkdir(process.env.EVIDENCE_DIR, { recursive: true });
        await Promise.all(
          frames.map((frame, i) =>
            writeFile(path.join(process.env.EVIDENCE_DIR!, `bot-${i ? 'b' : 'a'}.jpg`), frame),
          ),
        );
      }
      check('real-frames', { bytes: frames.map((frame) => frame.length) });
    });

    await t.test(
      'API rejects missing credentials, a foreign origin and stale control',
      async () => {
        const request = (headers: Record<string, string>, body: Record<string, unknown> = {}) =>
          fetch(`${app.url}/api/bots/a/control`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify(body),
          });
        assert.equal((await request({})).status, 403);
        assert.equal(
          (await request({ 'x-prototype-token': app.token, origin: 'https://example.test' }))
            .status,
          403,
        );
        assert.equal(
          (await request({ 'x-prototype-token': app.token }, { owner: 'human', epoch: -1 })).status,
          409,
        );
        assert.equal(
          (
            await fetch(`${app.url}/api/bots/unknown/frame`, {
              headers: { 'x-prototype-token': app.token },
            })
          ).status,
          404,
        );
        check('api-boundaries');
      },
    );

    await t.test(
      'the dedicated persistent profile preserves login after a complete restart',
      async () => {
        const port = Number(new URL(app.url).port);
        await app.close();
        app = await startPrototype({ profileDir, port, interval: 100, fixture: true });
        await app.runtime.pages
          .get('a')!
          .waitForFunction(() => document.querySelector('#identity')!.textContent === '示例用户');
        await app.runtime.pages
          .get('b')!
          .waitForFunction(() => document.querySelector('#identity')!.textContent === '示例用户');
        check('persistent-login');
      },
    );

    await t.test(
      'logout reaches both pages without an old copy restoring the session',
      async () => {
        await app.runtime.act('a', 'agent', 0, (page) => page.locator('#logout').click());
        await Promise.all(
          [...app.runtime.pages.values()].map((page) =>
            page.waitForFunction(
              () => document.querySelector('#identity')!.textContent === '尚未登录',
            ),
          ),
        );
        assert.equal(
          (await app.runtime.context.cookies()).some((cookie) => cookie.name === 'demo_session'),
          false,
        );
        check('shared-logout');
      },
    );
  } finally {
    if (app) await app.close();
    await rm(profileDir, { recursive: true, force: true });
  }
  if (process.env.EVIDENCE_DIR)
    await writeFile(
      path.join(process.env.EVIDENCE_DIR!, 'checks.json'),
      JSON.stringify(evidence, null, 2),
    );
});

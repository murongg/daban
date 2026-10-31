import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Browser, createBrowser } from './runtime.js';
import type { BrowserObservation } from './tabs.js';

// Manual public-page probe of the candidate runtime, with a disposable browser profile and no model key.
export async function acceptBrowser(output = '/tmp/daban-general-browser-live.json') {
  assert.equal(process.platform, 'linux');
  const root = await mkdtemp(path.join(tmpdir(), 'daban-public-browser-'));
  const fixture = createServer((_req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(
      '<span id="identity" data-ready="true">Guest</span><span id="count">0</span><input id="note">',
    );
  });
  let browser: Browser | undefined;
  try {
    await new Promise<unknown>((resolve) =>
      fixture.listen(0, '127.0.0.1', () => resolve(undefined)),
    );
    const address = fixture.address();
    assert.ok(address && typeof address !== 'string');
    let upstream: string | undefined;
    try {
      const network = JSON.parse(
        await readFile('/var/lib/bot-prototype/model/network.json', 'utf8'),
      );
      assert.ok(network.proxy == null || typeof network.proxy === 'string');
      upstream = network.proxy ?? undefined;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    browser = await createBrowser({
      profileDir: path.join(root, 'profile'),
      origin: `http://127.0.0.1:${address.port}`,
      proxy: { upstream },
    });
    assert.ok(browser.tabs);
    const pages = [];
    for (const [bot, url, expected] of [
      ['a', 'https://example.com/', 'Example Domain'],
      ['b', 'https://playwright.dev/docs/aria-snapshots', 'Playwright'],
    ] as const) {
      const observation: BrowserObservation = await browser.tabs.navigate(
        bot,
        'agent',
        0,
        url,
        new AbortController().signal,
        `synthetic-public-${bot}`,
      );
      assert.equal(new URL(observation.url).origin, new URL(url).origin);
      assert.ok(
        observation.title.includes(expected) || observation.text.includes(expected),
        `Missing public page content for ${bot}: ${observation.title} | ${observation.text.slice(0, 180)}`,
      );
      assert.ok(observation.text.length > 50, 'A live page must contain readable DOM text');
      pages.push({
        bot,
        url: observation.url,
        title: observation.title,
        observedCharacters: observation.text.length,
        truncated: observation.truncated,
      });
    }
    await assert.rejects(
      browser.tabs.navigate(
        'a',
        'agent',
        0,
        'http://127.0.0.1:8766/api/state',
        new AbortController().signal,
        'synthetic-public-a',
      ),
      { code: 'INVALID_BROWSER_URL' },
    );
    const value = {
      passed: true,
      scope: 'Candidate browser backend only; not native Electron or DSH tool activation',
      publicPages: pages,
      privateDestinationRefused: true,
      credentialRead: false,
      liveUserBrowserChanged: false,
    };
    await writeFile(output, JSON.stringify(value, null, 2), { mode: 0o600 });
    return value;
  } finally {
    await browser?.close();
    await new Promise<unknown>((resolve) => {
      fixture.closeAllConnections();
      fixture.close(() => resolve(undefined));
    });
    await rm(root, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  acceptBrowser(process.argv[2])
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

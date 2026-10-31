import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isBrowserState } from '@daban/protocol';
import { startPrototype } from './server.js';
import type { BrowserObservation } from './tabs.js';

const html = `<html><head><title>Synthetic human browser</title></head><body>
<h1>Synthetic human browser</h1>
<button id="prompt" onclick="window.answer=prompt('SYNTHETIC-PROMPT','');if(window.answer!==null)window.accepted=(window.accepted||0)+1">Ask synthetic prompt</button>
<input type="file" id="file" style="display:none" onchange="document.querySelector('#picked').textContent=this.files[0]?.name||''">
<button id="picker" onclick="document.querySelector('#file').click()">Choose synthetic file</button>
<output id="picked"></output><input id="note" aria-label="Note">
</body></html>`;
const ref = (observation: BrowserObservation, name: string) => {
  const line = observation.text.split('\n').find((value) => value.includes(`button "${name}"`));
  const id = line?.match(/\[ref=([a-z0-9]+)\]/)?.[1];
  assert.ok(id, `Missing synthetic button: ${name}`);
  return id;
};
test('actual Chromium dialogs and pickers release the queue for human takeover, preserve inputs and fence exact answers', {
  skip: process.platform !== 'linux',
  timeout: 45000,
}, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-browser-prompts-'));
  const app = await startPrototype({ profileDir: path.join(root, 'profile'), port: 0 });
  const browser = app.runtime;
  const tabs = browser.tabs!;
  const call = async (bot: string, data: unknown) => {
    const response = await fetch(`${app.url}/api/bots/${bot}/browser-answer`, {
      method: 'POST',
      headers: { 'x-prototype-token': app.token, 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    return { status: response.status, value: await response.json() };
  };
  try {
    await browser.context.route('**/fixture/human', (route) =>
      route.fulfill({ contentType: 'text/html', body: html }),
    );
    const observed = await tabs.navigate(
      'a',
      'agent',
      0,
      `${app.url}/fixture/human`,
      new AbortController().signal,
      'mock-dialog-run',
    );
    const started = performance.now();
    const result = await tabs.act(
      'a',
      'agent',
      0,
      observed.id,
      [{ kind: 'click', ref: ref(observed, 'Ask synthetic prompt') }],
      AbortSignal.timeout(1500),
      'mock-dialog-run',
    );
    assert.equal(result.error, 'BROWSER_HUMAN_REQUIRED');
    assert.ok(performance.now() - started < 1200, 'a modal must not hold the computer queue');
    assert.equal(result.observation.humanRequired, true);
    assert.equal(
      JSON.stringify(result).includes('SYNTHETIC-PROMPT'),
      false,
      'human-only prompt metadata is not a model tool result',
    );
    const state = await tabs.state('a');
    assert.ok(isBrowserState(state));
    assert.equal(state.pending?.length, 1);
    const prompt = state.pending![0];
    assert.equal(prompt.kind, 'dialog');
    const other = await tabs.navigate(
      'b',
      'agent',
      0,
      `${app.url}/fixture/human`,
      AbortSignal.timeout(1500),
      'mock-other-bot',
    );
    assert.match(other.text, /Synthetic human browser/);
    assert.equal((await tabs.state('b')).pending?.length, 0);
    const taking = performance.now();
    const human = await browser.transfer('a', 0, 'human');
    assert.ok(performance.now() - taking < 1000);
    const view = await browser.view('a');
    assert.equal(view.paused, true);
    assert.equal(view.image, undefined);
    assert.equal(view.binding.tab, prompt.tab);
    const answer = {
      kind: 'dialog',
      id: 'mock-human-dialog',
      epoch: human.epoch,
      binding: { instance: state.instance, tab: prompt.tab, generation: prompt.generation },
      prompt: prompt.id,
      accept: true,
      text: 'SYNTHETIC-PRIVATE-ANSWER',
    };
    assert.equal((await call('a', { ...answer, epoch: 0 })).status, 409);
    assert.equal((await call('b', answer)).status, 409);
    assert.equal((await call('a', answer)).status, 200);
    assert.equal((await call('a', answer)).status, 200);
    const page = browser.page('a');
    assert.equal(
      await page.evaluate(() => (window as unknown as { accepted?: number }).accepted),
      1,
    );
    assert.equal(JSON.stringify(await tabs.state('a')).includes(answer.text), false);
    assert.equal((await tabs.state('a')).pending?.length || 0, 0);
    const agent = await browser.transfer('a', human.epoch, 'agent');
    const beforeFile = await tabs.snapshot(
      'a',
      'agent',
      agent.epoch,
      new AbortController().signal,
      'mock-picker-run',
    );
    const picked = await tabs.act(
      'a',
      'agent',
      agent.epoch,
      beforeFile.id,
      [{ kind: 'click', ref: ref(beforeFile, 'Choose synthetic file') }],
      AbortSignal.timeout(1500),
      'mock-picker-run',
    );
    assert.equal(picked.error, 'BROWSER_HUMAN_REQUIRED', JSON.stringify(picked));
    const filesState = await tabs.state('a'),
      chooser = filesState.pending![0];
    assert.equal(chooser.kind, 'files');
    const owner = await browser.transfer('a', agent.epoch, 'human');
    const fileAnswer = {
      kind: 'files',
      id: 'mock-human-file',
      epoch: owner.epoch,
      binding: { instance: filesState.instance, tab: chooser.tab, generation: chooser.generation },
      prompt: chooser.id,
      files: [
        { name: 'synthetic.csv', data: Buffer.from('item,count\nmock,47\n').toString('base64') },
      ],
    };
    assert.equal((await call('a', fileAnswer)).status, 200);
    assert.equal(await page.locator('#picked').textContent(), 'synthetic.csv');
    const content = await page
      .locator('#file')
      .evaluate(async (element) => (element as HTMLInputElement).files![0].text());
    assert.equal(content, 'item,count\nmock,47\n');
    const resumed = await browser.transfer('a', owner.epoch, 'agent');
    const beforeCancel = await tabs.snapshot(
      'a',
      'agent',
      resumed.epoch,
      new AbortController().signal,
      'mock-cancel-picker',
    );
    await tabs.act(
      'a',
      'agent',
      resumed.epoch,
      beforeCancel.id,
      [{ kind: 'click', ref: ref(beforeCancel, 'Choose synthetic file') }],
      AbortSignal.timeout(1500),
      'mock-cancel-picker',
    );
    const cancelState = await tabs.state('a'),
      cancel = cancelState.pending![0];
    const cancelling = await browser.transfer('a', resumed.epoch, 'human');
    assert.equal(
      (
        await call('a', {
          kind: 'files',
          id: 'mock-cancel-files',
          epoch: cancelling.epoch,
          binding: {
            instance: cancelState.instance,
            tab: cancel.tab,
            generation: cancel.generation,
          },
          prompt: cancel.id,
          files: [],
        })
      ).status,
      200,
    );
    assert.equal(
      await page
        .locator('#file')
        .evaluate((element) => (element as HTMLInputElement).files![0].name),
      'synthetic.csv',
    );
    const model = await browser.transfer('a', cancelling.epoch, 'agent');
    const uploadObservation = await tabs.snapshot(
      'a',
      'agent',
      model.epoch,
      new AbortController().signal,
      'mock-model-picker',
    );
    const upload = await tabs.upload(
      'a',
      'agent',
      model.epoch,
      uploadObservation.id,
      ref(uploadObservation, 'Choose synthetic file'),
      { name: 'model-synthetic.csv', mimeType: 'text/csv', buffer: Buffer.from('mock,53') },
      new AbortController().signal,
      'mock-model-picker',
    );
    assert.equal(upload.completed, 1);
    assert.equal((await tabs.state('a')).pending?.length || 0, 0);
    assert.equal(await page.locator('#picked').textContent(), 'model-synthetic.csv');
    const manual = await browser.transfer('a', model.epoch, 'human');
    const promptButton = await page.locator('#prompt').boundingBox();
    assert.ok(promptButton);
    let dialog: import('playwright').Dialog | undefined;
    page.once('dialog', (value) => {
      dialog = value;
    });
    const pixel = browser.boundInput('a', manual.epoch, tabs.binding('a'), {
      type: 'click',
      x: promptButton.x + 5,
      y: promptButton.y + 5,
    });
    const completed = await Promise.race([
      pixel.then(
        () => true,
        (error: unknown) => {
          assert.ok(
            error instanceof Error && 'code' in error && error.code === 'BROWSER_HUMAN_REQUIRED',
          );
          return true;
        },
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800)),
    ]);
    if (!completed) await dialog?.dismiss();
    await pixel.catch((error: unknown) => {
      assert.ok(
        error instanceof Error && 'code' in error && error.code === 'BROWSER_HUMAN_REQUIRED',
      );
    });
    assert.equal(
      completed,
      true,
      'native pixel clicks must also release the queue when a JavaScript dialog opens',
    );
    const lastState = await tabs.state('a'),
      last = lastState.pending![0];
    assert.equal(
      (
        await call('a', {
          kind: 'dialog',
          id: 'mock-pixel-dismiss',
          epoch: manual.epoch,
          binding: { instance: lastState.instance, tab: last.tab, generation: last.generation },
          prompt: last.id,
          accept: false,
        })
      ).status,
      200,
    );
    page.once('dialog', (value) => {
      dialog = value;
    });
    await browser.boundInput('a', manual.epoch, tabs.binding('a'), {
      type: 'pointer',
      phase: 'down',
      x: promptButton.x + 5,
      y: promptButton.y + 5,
    });
    const release = browser.boundInput('a', manual.epoch, tabs.binding('a'), {
      type: 'pointer',
      phase: 'up',
      x: promptButton.x + 5,
      y: promptButton.y + 5,
    });
    const settledRelease = release.then(
      () => true,
      (error: unknown) => {
        assert.ok(
          error instanceof Error && 'code' in error && error.code === 'BROWSER_HUMAN_REQUIRED',
        );
        return true;
      },
    );
    const released = await Promise.race([
      settledRelease,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 800)),
    ]);
    if (!released) await dialog?.dismiss();
    await settledRelease;
    assert.equal(
      released,
      true,
      'the live-viewer mouse-up path must release its queue on a dialog without waiting for cleanup timeout',
    );
    const gestureState = await tabs.state('a'),
      gesture = gestureState.pending![0];
    assert.equal(
      (
        await call('a', {
          kind: 'dialog',
          id: 'mock-gesture-dismiss',
          epoch: manual.epoch,
          binding: {
            instance: gestureState.instance,
            tab: gesture.tab,
            generation: gesture.generation,
          },
          prompt: gesture.id,
          accept: false,
        })
      ).status,
      200,
    );
    await browser.boundInput('a', manual.epoch, tabs.binding('a'), { type: 'key', key: 'Escape' });
    assert.equal((await tabs.state('a')).pending?.length, 0);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

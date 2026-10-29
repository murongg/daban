import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserContext, Page } from 'playwright';
import { Control } from './control.js';
import { Tabs } from './tabs.js';

test('cancelling a blocked read releases the lease and a late password query cannot publish an observation', {
  timeout: 1000,
}, async () => {
  let release!: (values: string[]) => unknown;
  let started!: () => unknown;
  const entered = new Promise<unknown>((resolve) => {
    started = () => resolve(undefined);
  });
  const delayed = new Promise<string[]>((resolve) => {
    release = resolve;
  });
  const page = {
    on: () => {},
    once: () => {},
    isClosed: () => false,
    url: () => 'https://example.test/mock',
    title: async () => 'Synthetic page',
    frames: () => [
      {
        locator: () => ({
          evaluateAll: () => {
            started();
            return delayed;
          },
        }),
      },
    ],
    ariaSnapshot: async () => '- button "Synthetic button" [ref=f1e2]',
  } as unknown as Page;
  const control = new Control(['a']);
  const tabs = new Tabs(
    { on: () => {}, removeListener: () => {} } as unknown as BrowserContext,
    new Map([['a', page]]),
    control,
    'http://127.0.0.1:18766',
  );
  const controller = new AbortController();
  try {
    const snapshot = tabs.snapshot('a', 'agent', 0, controller.signal, 'mock-run');
    await entered;
    controller.abort();
    await assert.rejects(snapshot, /abort/i);
    const human = await control.transfer('a', 0, 'human');
    release(['SYNTHETIC-LATE-PASSWORD']);
    await new Promise(setImmediate);
    const resumed = await control.transfer('a', human.epoch, 'agent');
    await assert.rejects(
      tabs.act(
        'a',
        'agent',
        resumed.epoch,
        'mock-observation',
        [{ kind: 'click', ref: 'f1e2' }],
        new AbortController().signal,
        'mock-run',
      ),
      { code: 'BROWSER_OBSERVATION_STALE' },
    );
  } finally {
    release([]);
    tabs.dispose();
  }
});

test('an aborted metadata request is rejected before publishing cached state', async () => {
  const page = {
    on: () => {},
    once: () => {},
    isClosed: () => false,
    url: () => 'about:blank',
  } as unknown as Page;
  const tabs = new Tabs(
    { on: () => {}, removeListener: () => {} } as unknown as BrowserContext,
    new Map([['a', page]]),
    new Control(['a']),
    'http://127.0.0.1:18766',
  );
  const stop = new AbortController();
  stop.abort();
  try {
    await assert.rejects(tabs.state('a', stop.signal), /abort/i);
  } finally {
    tabs.dispose();
  }
});

test('browser metadata never waits for JavaScript execution or a dialog-blocked title query', async () => {
  let reads = 0;
  const page = {
    on: () => {},
    once: () => {},
    isClosed: () => false,
    url: () => 'about:blank',
    title: async () => {
      reads++;
      return 'Must not query';
    },
  } as unknown as Page;
  const tabs = new Tabs(
    { on: () => {}, removeListener: () => {} } as unknown as BrowserContext,
    new Map([['a', page]]),
    new Control(['a']),
    'http://127.0.0.1:18766',
  );
  try {
    await tabs.state('a');
    assert.equal(reads, 0);
  } finally {
    tabs.dispose();
  }
});

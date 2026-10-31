import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import type { Dialog, FileChooser, Page } from 'playwright';

const uri = new URL('./browser-prompts.js', import.meta.url).href;
const load = () => import(uri) as Promise<typeof import('./browser-prompts.js')>;
function fixture() {
  const page = new EventEmitter();
  return { page, tab: { id: 'mock-tab', bot: 'a', page: page as unknown as Page, generation: 2 } };
}
test('owned dialog capture interrupts native abortable work without accepting it or exposing its text to model snapshots', async () => {
  const { BrowserPrompts } = await load();
  const { page, tab } = fixture();
  let accepted = 0,
    dismissed = 0;
  const prompts = new BrowserPrompts('mock-instance', () => {});
  prompts.attach(tab);
  const dialog = {
    type: () => 'prompt',
    message: () => 'SYNTHETIC-DIALOG',
    defaultValue: () => 'SYNTHETIC-DEFAULT',
    accept: async () => {
      accepted++;
    },
    dismiss: async () => {
      dismissed++;
    },
  } as unknown as Dialog;
  try {
    const work = prompts.guard(
      tab,
      new AbortController().signal,
      (signal) =>
        new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          page.emit('dialog', dialog);
        }),
    );
    await assert.rejects(work, { code: 'BROWSER_HUMAN_REQUIRED' });
    const pending = prompts.items('a');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].kind, 'dialog');
    assert.equal(accepted, 0);
    assert.equal(dismissed, 0);
    assert.deepEqual(prompts.items('b'), []);
    const response = {
      kind: 'dialog' as const,
      id: 'mock-answer',
      epoch: 1,
      prompt: pending[0].id,
      binding: { instance: 'mock-instance', tab: tab.id, generation: 2 },
      accept: true,
      text: 'SYNTHETIC-SECRET',
    };
    await assert.rejects(prompts.answer('b', response), { code: 'BROWSER_PROMPT_STALE' });
    await assert.rejects(
      prompts.answer('a', {
        ...response,
        binding: { ...response.binding, instance: 'old-instance' },
      }),
      { code: 'BROWSER_PROMPT_STALE' },
    );
    await prompts.answer('a', response);
    assert.equal(accepted, 1);
    assert.deepEqual(prompts.items('a'), []);
    await assert.rejects(prompts.answer('a', response), { code: 'BROWSER_PROMPT_STALE' });
  } finally {
    prompts.dispose();
  }
});
test('truncated prompts cannot be accepted and a newer chained dialog survives completion of the old answer', async () => {
  const { BrowserPrompts } = await load();
  const { page, tab } = fixture();
  const prompts = new BrowserPrompts('mock-instance', () => {});
  prompts.attach(tab);
  let accepted = 0,
    dismissed = 0;
  const next = {
    type: () => 'alert',
    message: () => 'SYNTHETIC-NEXT',
    defaultValue: () => '',
    dismiss: async () => {},
    accept: async () => {},
  } as unknown as Dialog;
  const dialog = {
    type: () => 'confirm',
    message: () => 'M'.repeat(17000),
    defaultValue: () => '',
    accept: async () => {
      accepted++;
    },
    dismiss: async () => {
      dismissed++;
      page.emit('dialog', next);
    },
  } as unknown as Dialog;
  try {
    page.emit('dialog', dialog);
    const first = prompts.items('a')[0];
    assert.ok(first.kind === 'dialog' && first.truncated);
    const response = {
      kind: 'dialog' as const,
      id: 'mock-answer',
      epoch: 1,
      prompt: first.id,
      binding: { instance: 'mock-instance', tab: tab.id, generation: 2 },
      accept: true,
    };
    await assert.rejects(prompts.answer('a', response), { code: 'BROWSER_PROMPT_TRUNCATED' });
    assert.equal(accepted, 0);
    await prompts.answer('a', { ...response, accept: false });
    assert.equal(dismissed, 1);
    assert.equal(prompts.items('a').length, 1);
    assert.notEqual(prompts.items('a')[0].id, first.id);
    tab.generation++;
    prompts.retire(tab);
    assert.deepEqual(prompts.items('a'), []);
  } finally {
    prompts.dispose();
  }
});
test('human file choosers retain no file bytes, enforce multiple selection and ignore a model-owned picker', async () => {
  const { BrowserPrompts } = await load();
  const { page, tab } = fixture();
  const prompts = new BrowserPrompts('mock-instance', () => {});
  prompts.attach(tab);
  const chosen: unknown[] = [];
  const chooser = {
    isMultiple: () => false,
    setFiles: async (files: unknown) => {
      chosen.push(files);
    },
  } as unknown as FileChooser;
  try {
    await prompts.expectFiles(tab.page, async () => {
      page.emit('filechooser', chooser);
      page.emit('filechooser', chooser);
    });
    assert.equal(prompts.items('a').length, 1, 'only the first model-owned picker is suppressed');
    prompts.retire(tab);
    assert.deepEqual(prompts.items('a'), []);
    page.emit('filechooser', chooser);
    const pending = prompts.items('a')[0];
    assert.equal(pending.kind, 'files');
    const file = {
      name: 'synthetic.csv',
      mimeType: 'text/csv',
      data: Buffer.from('mock,47').toString('base64'),
    };
    const response = {
      kind: 'files' as const,
      id: 'mock-files',
      epoch: 1,
      prompt: pending.id,
      binding: { instance: 'mock-instance', tab: tab.id, generation: 2 },
      files: [file, file],
    };
    await assert.rejects(prompts.answer('a', response), { code: 'INVALID_BROWSER_FILE' });
    assert.equal(chosen.length, 0);
    await prompts.answer('a', { ...response, files: [file] });
    assert.equal(chosen.length, 1);
    assert.equal((chosen[0] as { mimeType: string }[])[0].mimeType, 'text/csv');
    assert.deepEqual(prompts.items('a'), []);
    assert.equal(JSON.stringify(prompts.items('a')).includes(file.data), false);
  } finally {
    prompts.dispose();
  }
});

test('an early popup dialog is retained until its exact opener Bot is known and interrupts that Bot only', async () => {
  const { BrowserPrompts } = await load();
  const parent = fixture(),
    child = fixture();
  child.tab.id = 'mock-popup';
  const prompts = new BrowserPrompts('mock-instance', () => {});
  const dialog = {
    type: () => 'confirm',
    message: () => 'SYNTHETIC-POPUP',
    defaultValue: () => '',
    accept: async () => {},
    dismiss: async () => {},
  } as unknown as Dialog;
  prompts.attach(parent.tab);
  try {
    prompts.prepare(child.tab.page);
    child.page.emit('dialog', dialog);
    assert.deepEqual(prompts.items('a'), []);
    const guarded = prompts.guard(
      parent.tab,
      new AbortController().signal,
      (signal) =>
        new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          prompts.attach(child.tab);
        }),
    );
    await assert.rejects(guarded, { code: 'BROWSER_HUMAN_REQUIRED' });
    assert.equal(prompts.items('a')[0].tab, 'mock-popup');
    assert.deepEqual(prompts.items('b'), []);
  } finally {
    prompts.dispose();
  }
});

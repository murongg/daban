import { EventEmitter } from 'node:events';
import type { Dialog, FileChooser, Page } from 'playwright';
import { expect, test } from 'vitest';

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
    await expect(work).rejects.toMatchObject({ code: 'BROWSER_HUMAN_REQUIRED' });
    const pending = prompts.items('a');
    expect(pending.length).toBe(1);
    expect(pending[0].kind).toBe('dialog');
    expect(accepted).toBe(0);
    expect(dismissed).toBe(0);
    expect(prompts.items('b')).toStrictEqual([]);
    const response = {
      kind: 'dialog' as const,
      id: 'mock-answer',
      epoch: 1,
      prompt: pending[0].id,
      binding: { instance: 'mock-instance', tab: tab.id, generation: 2 },
      accept: true,
      text: 'SYNTHETIC-SECRET',
    };
    await expect(prompts.answer('b', response)).rejects.toMatchObject({
      code: 'BROWSER_PROMPT_STALE',
    });
    await expect(
      prompts.answer('a', {
        ...response,
        binding: { ...response.binding, instance: 'old-instance' },
      }),
    ).rejects.toMatchObject({ code: 'BROWSER_PROMPT_STALE' });
    await prompts.answer('a', response);
    expect(accepted).toBe(1);
    expect(prompts.items('a')).toStrictEqual([]);
    await expect(prompts.answer('a', response)).rejects.toMatchObject({
      code: 'BROWSER_PROMPT_STALE',
    });
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
    expect.assert(first.kind === 'dialog' && first.truncated);
    const response = {
      kind: 'dialog' as const,
      id: 'mock-answer',
      epoch: 1,
      prompt: first.id,
      binding: { instance: 'mock-instance', tab: tab.id, generation: 2 },
      accept: true,
    };
    await expect(prompts.answer('a', response)).rejects.toMatchObject({
      code: 'BROWSER_PROMPT_TRUNCATED',
    });
    expect(accepted).toBe(0);
    await prompts.answer('a', { ...response, accept: false });
    expect(dismissed).toBe(1);
    expect(prompts.items('a').length).toBe(1);
    expect(prompts.items('a')[0].id).not.toBe(first.id);
    tab.generation++;
    prompts.retire(tab);
    expect(prompts.items('a')).toStrictEqual([]);
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
    expect(prompts.items('a').length, 'only the first model-owned picker is suppressed').toBe(1);
    prompts.retire(tab);
    expect(prompts.items('a')).toStrictEqual([]);
    page.emit('filechooser', chooser);
    const pending = prompts.items('a')[0];
    expect(pending.kind).toBe('files');
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
    await expect(prompts.answer('a', response)).rejects.toMatchObject({
      code: 'INVALID_BROWSER_FILE',
    });
    expect(chosen.length).toBe(0);
    await prompts.answer('a', { ...response, files: [file] });
    expect(chosen.length).toBe(1);
    expect((chosen[0] as { mimeType: string }[])[0].mimeType).toBe('text/csv');
    expect(prompts.items('a')).toStrictEqual([]);
    expect(JSON.stringify(prompts.items('a')).includes(file.data)).toBe(false);
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
    expect(prompts.items('a')).toStrictEqual([]);
    const guarded = prompts.guard(
      parent.tab,
      new AbortController().signal,
      (signal) =>
        new Promise<unknown>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          prompts.attach(child.tab);
        }),
    );
    await expect(guarded).rejects.toMatchObject({ code: 'BROWSER_HUMAN_REQUIRED' });
    expect(prompts.items('a')[0].tab).toBe('mock-popup');
    expect(prompts.items('b')).toStrictEqual([]);
  } finally {
    prompts.dispose();
  }
});

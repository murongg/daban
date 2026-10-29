import { randomUUID } from 'node:crypto';
import {
  type BrowserAnswerRequest,
  type BrowserPrompt,
  isBrowserAnswerRequest,
} from '@daban/protocol';
import type { Dialog, FileChooser, Page } from 'playwright';
import { Fault } from './control.js';

interface PromptTab {
  id: string;
  bot: string;
  page: Page;
  generation: number;
}
type Pending = { tab: PromptTab; value: BrowserPrompt } & (
  | { kind: 'dialog'; dialog: Dialog }
  | { kind: 'files'; chooser: FileChooser }
);

export class BrowserPrompts {
  private readonly pending = new Map<string, Pending>();
  private readonly operations = new Map<Page, Set<AbortController>>();
  private readonly expected = new Map<Page, boolean>();
  private readonly owners = new WeakMap<Page, PromptTab>();
  private readonly prepared = new WeakSet<Page>();
  private readonly early = new Map<Page, { dialog?: Dialog; chooser?: FileChooser }>();
  private disposed = false;
  constructor(
    private readonly instance: string,
    private readonly changed: (bot: string) => unknown,
  ) {}
  prepare(page: Page) {
    if (this.prepared.has(page)) return;
    this.prepared.add(page);
    page.on('dialog', (dialog) => {
      if (this.disposed) {
        dialog.dismiss().catch(() => {});
        return;
      }
      const tab = this.owners.get(page);
      if (tab) this.dialog(tab, dialog);
      else this.early.set(page, { ...this.early.get(page), dialog });
    });
    page.on('filechooser', (chooser) => {
      if (this.disposed) return;
      if (this.expected.get(page) === false) {
        this.expected.set(page, true);
        return;
      }
      const tab = this.owners.get(page);
      if (tab) this.files(tab, chooser);
      else this.early.set(page, { ...this.early.get(page), chooser });
    });
    page.once('close', () => this.early.delete(page));
  }
  attach(tab: PromptTab) {
    this.owners.set(tab.page, tab);
    this.prepare(tab.page);
    const early = this.early.get(tab.page);
    this.early.delete(tab.page);
    if (early?.dialog) this.dialog(tab, early.dialog);
    if (early?.chooser) this.files(tab, early.chooser);
  }
  private dialog(tab: PromptTab, dialog: Dialog) {
    const message = dialog.message().replaceAll('\0', ''),
      defaultValue = dialog.defaultValue().replaceAll('\0', '');
    const value: BrowserPrompt = {
      id: randomUUID(),
      tab: tab.id,
      generation: tab.generation,
      kind: 'dialog',
      dialog: dialog.type() as 'alert' | 'confirm' | 'prompt' | 'beforeunload',
      message: message.slice(0, 16000),
      defaultValue: defaultValue.slice(0, 2000),
      truncated: message.length > 16000 || defaultValue.length > 2000,
    };
    this.capture({ tab, value, kind: 'dialog', dialog });
  }
  private files(tab: PromptTab, chooser: FileChooser) {
    this.capture({
      tab,
      kind: 'files',
      chooser,
      value: {
        id: randomUUID(),
        tab: tab.id,
        generation: tab.generation,
        kind: 'files',
        multiple: chooser.isMultiple(),
      },
    });
  }
  private capture(pending: Pending) {
    for (const [id, existing] of this.pending)
      if (existing.tab === pending.tab && existing.kind === pending.kind) this.pending.delete(id);
    this.pending.set(pending.value.id, pending);
    for (const [page, operations] of this.operations)
      if (this.owners.get(page)?.bot === pending.tab.bot)
        for (const operation of operations) operation.abort(new Fault('BROWSER_HUMAN_REQUIRED'));
    this.changed(pending.tab.bot);
  }
  items(bot: string): BrowserPrompt[] {
    return [...this.pending.values()]
      .filter((item) => item.tab.bot === bot)
      .map((item) => ({ ...item.value }));
  }
  blocked(bot: string) {
    return [...this.pending.values()].some((item) => item.tab.bot === bot);
  }
  clear(bot: string) {
    if (this.blocked(bot)) throw new Fault('BROWSER_HUMAN_REQUIRED');
  }
  async guard<T>(
    tab: PromptTab,
    signal: AbortSignal,
    action: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.clear(tab.bot);
    const stop = new AbortController();
    const operations = this.operations.get(tab.page) || new Set<AbortController>();
    operations.add(stop);
    this.operations.set(tab.page, operations);
    const bounded = AbortSignal.any([signal, stop.signal]);
    try {
      bounded.throwIfAborted();
      const result = await action(bounded);
      bounded.throwIfAborted();
      return result;
    } catch (error) {
      if (stop.signal.aborted) throw stop.signal.reason;
      throw error;
    } finally {
      operations.delete(stop);
      if (!operations.size) this.operations.delete(tab.page);
    }
  }
  async expectFiles<T>(page: Page, action: () => Promise<T>) {
    this.expected.set(page, false);
    try {
      return await action();
    } finally {
      this.expected.delete(page);
    }
  }
  async answer(bot: string, request: BrowserAnswerRequest) {
    if (!isBrowserAnswerRequest(request)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
    const pending = this.pending.get(request.prompt);
    if (
      !pending ||
      pending.tab.bot !== bot ||
      pending.kind !== request.kind ||
      request.binding.instance !== this.instance ||
      request.binding.tab !== pending.tab.id ||
      request.binding.generation !== pending.value.generation ||
      pending.tab.generation !== pending.value.generation
    )
      throw new Fault('BROWSER_PROMPT_STALE');
    if (pending.kind === 'dialog' && request.kind === 'dialog') {
      if (request.accept && pending.value.kind === 'dialog' && pending.value.truncated)
        throw new Fault('BROWSER_PROMPT_TRUNCATED');
      if (request.text !== undefined && pending.dialog.type() !== 'prompt')
        throw new Fault('INVALID_BROWSER_REQUEST', 400);
      if (request.accept) await pending.dialog.accept(request.text);
      else await pending.dialog.dismiss();
    } else if (pending.kind === 'files' && request.kind === 'files') {
      if (!pending.chooser.isMultiple() && request.files.length > 1)
        throw new Fault('INVALID_BROWSER_FILE', 400);
      const files = request.files.map((file) => ({
        name: file.name,
        mimeType: file.mimeType || 'application/octet-stream',
        buffer: Buffer.from(file.data, 'base64'),
      }));
      if (files.some((file, i) => file.buffer.toString('base64') !== request.files[i].data))
        throw new Fault('INVALID_BROWSER_FILE', 400);
      // Cancelling the intercepted picker must preserve any files already selected in the page.
      if (files.length) {
        const stop = new AbortController();
        const operations = this.operations.get(pending.tab.page) || new Set<AbortController>();
        operations.add(stop);
        this.operations.set(pending.tab.page, operations);
        try {
          await pending.chooser.setFiles(files, { timeout: 5000, signal: stop.signal });
        } catch (error) {
          if (stop.signal.aborted) throw stop.signal.reason;
          throw error;
        } finally {
          operations.delete(stop);
          if (!operations.size) this.operations.delete(pending.tab.page);
          if (this.pending.get(request.prompt) === pending) this.pending.delete(request.prompt);
          this.changed(bot);
        }
      }
    }
    // Accepting a dialog may synchronously open its successor; never retire the new prompt.
    if (this.pending.get(request.prompt) === pending) this.pending.delete(request.prompt);
    this.changed(bot);
  }
  retire(tab: PromptTab) {
    for (const [id, pending] of this.pending)
      if (pending.tab === tab) {
        this.pending.delete(id);
        if (pending.kind === 'dialog') pending.dialog.dismiss().catch(() => {});
      }
    this.changed(tab.bot);
  }
  dispose() {
    this.disposed = true;
    for (const pending of this.pending.values())
      if (pending.kind === 'dialog') pending.dialog.dismiss().catch(() => {});
    this.pending.clear();
    for (const early of this.early.values()) early.dialog?.dismiss().catch(() => {});
    this.early.clear();
    for (const operations of this.operations.values())
      for (const operation of operations) operation.abort(new Fault('BROWSER_UNAVAILABLE', 503));
    this.operations.clear();
    this.expected.clear();
  }
}

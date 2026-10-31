import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import {
  type BrowserAck,
  type BrowserAnswerRequest,
  type BrowserBinding,
  type BrowserCommandRequest,
  type BrowserReceipt,
  type BrowserState,
  documentLimit,
  isBrowserAnswerRequest,
  isBrowserBinding,
  isBrowserCommandRequest,
  isTaskFileName,
  publicUrl,
  validAgentId,
} from '@daban/protocol';
import type { BrowserContext, CDPSession, Download, Page } from 'playwright';
import { BrowserPrompts } from './browser-prompts.js';
import { type Control, Fault } from './control.js';
import { publicAddress } from './proxy.js';
import type { TabRegistry, TabStore } from './tab-store.js';

export interface BrowserObservation {
  humanRequired?: boolean;
  id: string;
  tab: string;
  url: string;
  title: string;
  text: string;
  offset: number;
  total: number;
  truncated: boolean;
  nextOffset?: number;
  omitted?: boolean;
}
export type BrowserTabs = BrowserState;
export interface BrowserUpload {
  name: string;
  mimeType: string;
  buffer: Buffer;
}
export interface BrowserSavedFile {
  path: string;
  bytes: number;
}
interface Tab {
  id: string;
  bot: string;
  page: Page;
  generation: number;
  url: string;
  title: string;
  suspended?: boolean;
}
interface Observation {
  id: string;
  tab: Tab;
  generation: number;
  epoch: number;
  actor: string;
  run?: string;
  text: string;
  total: number;
  url: string;
  title: string;
  refs: Set<string>;
}
type Action =
  | { kind: 'click'; ref: string }
  | { kind: 'fill'; ref: string; text: string }
  | { kind: 'press'; ref: string; key: string }
  | { kind: 'select'; ref: string; values: string[] }
  | { kind: 'scroll'; deltaY: number };
const reference = /^[a-z0-9]{1,32}$/;
function actions(value: unknown): Action[] {
  if (!Array.isArray(value) || !value.length || value.length > 4)
    throw new Fault('INVALID_BROWSER_ACTION', 400);
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item))
      throw new Fault('INVALID_BROWSER_ACTION', 400);
    const fields =
      item.kind === 'click'
        ? ['kind', 'ref']
        : item.kind === 'fill'
          ? ['kind', 'ref', 'text']
          : item.kind === 'press'
            ? ['kind', 'ref', 'key']
            : item.kind === 'select'
              ? ['kind', 'ref', 'values']
              : item.kind === 'scroll'
                ? ['kind', 'deltaY']
                : [];
    if (
      !fields.length ||
      Object.keys(item).some((key) => !fields.includes(key)) ||
      (item.kind !== 'scroll' && (typeof item.ref !== 'string' || !reference.test(item.ref)))
    )
      throw new Fault('INVALID_BROWSER_ACTION', 400);
    if (
      item.kind === 'fill' &&
      (typeof item.text !== 'string' || item.text.length > 12000 || item.text.includes('\0'))
    )
      throw new Fault('INVALID_BROWSER_ACTION', 400);
    if (
      item.kind === 'press' &&
      (typeof item.key !== 'string' ||
        !/^(?:(?:Control|Meta|Alt|Shift|ControlOrMeta)\+)*(?:[a-zA-Z0-9]|Enter|Tab|Backspace|Delete|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|Escape|Home|End|PageUp|PageDown|Space)$/.test(
          item.key,
        ))
    )
      throw new Fault('INVALID_BROWSER_ACTION', 400);
    if (
      item.kind === 'select' &&
      (!Array.isArray(item.values) ||
        !item.values.length ||
        item.values.length > 8 ||
        !item.values.every(
          (value: unknown) =>
            typeof value === 'string' && value.length <= 1000 && !value.includes('\0'),
        ))
    )
      throw new Fault('INVALID_BROWSER_ACTION', 400);
    if (item.kind === 'scroll' && (!Number.isFinite(item.deltaY) || Math.abs(item.deltaY) > 2000))
      throw new Fault('INVALID_BROWSER_ACTION', 400);
  }
  return structuredClone(value) as Action[];
}

// Race only read-only inspection; mutating Playwright calls must use their native AbortSignal to prevent late effects.
async function inspect<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  bounded.throwIfAborted();
  let cancel: () => unknown = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(bounded.reason);
    bounded.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([read(), interrupted]);
  } finally {
    bounded.removeEventListener('abort', cancel);
  }
}

export class Tabs {
  private readonly attached = new Set<string>();
  private ownership: Promise<unknown> = Promise.resolve();
  readonly instance = randomUUID();
  readonly prompts: BrowserPrompts;
  private revision = 0;
  private restoring = false;
  private storeError = '';
  private saving: Promise<unknown> = Promise.resolve();
  private readonly records = new Map<Page, Tab>();
  private readonly observations = new Map<string, Observation>();
  private readonly background = new Set<Promise<unknown>>();
  private readonly creating = new Set<Promise<Page>>();
  private readonly adopting = new Set<Promise<unknown>>();
  private readonly guarded = new WeakSet<Page>();
  private readonly expecting = new Map<Page, { download?: Download }>();
  private monitor?: CDPSession;
  private disposed = false;
  private readonly added = (page: Page) => {
    this.prompts.prepare(page);
    this.guardDownloads(page);
    const work = this.adopt(page);
    this.adopting.add(work);
    work.finally(() => this.adopting.delete(work)).catch(() => {});
    this.track(work);
  };
  constructor(
    private readonly context: BrowserContext,
    private readonly pages: Map<string, Page>,
    private readonly control: Control,
    private readonly origin: string,
    private readonly onChange: (bot: string) => unknown = () => {},
    private readonly store?: TabStore,
  ) {
    this.prompts = new BrowserPrompts(this.instance, (bot) => this.invalidate(bot));
    this.restoring = !!store;
    for (const [bot, page] of pages) {
      this.attached.add(bot);
      this.register(bot, page);
    }
    context.on('page', this.added);
  }
  private track(work: Promise<unknown>) {
    this.background.add(work);
    work.catch(() => {}).finally(() => this.background.delete(work));
  }
  private register(bot: string, page: Page) {
    if (this.disposed) throw new Fault('BROWSER_UNAVAILABLE', 503);
    const existing = this.records.get(page);
    if (existing) return existing;
    if ([...this.records.values()].filter((tab) => tab.bot === bot).length >= 8)
      throw new Fault('BROWSER_TAB_LIMIT');
    const tab: Tab = { id: randomUUID(), bot, page, generation: 0, url: page.url(), title: '' };
    this.records.set(page, tab);
    this.guardDownloads(page);
    page.on('framenavigated', (frame) => {
      if (this.disposed) return;
      // A snapshot includes child frames too; a new child document invalidates its old element references.
      tab.generation++;
      this.prompts.retire(tab);
      this.invalidate(bot);
      if (frame === page.mainFrame()) {
        const url = page.url();
        if (
          (publicUrl(url) || url === 'about:blank') &&
          !(tab.suspended && url === 'about:blank')
        ) {
          tab.url = url;
          tab.suspended = false;
          tab.title = '';
          this.schedule();
        }
      }
    });
    page.on('domcontentloaded', () => {
      this.track(this.title(tab));
    });
    page.on('close', () => {
      if (this.disposed) return;
      this.prompts.retire(tab);
      this.records.delete(page);
      this.invalidate(bot);
      if (!this.attached.has(bot)) return;
      if (this.pages.get(bot) !== page) {
        this.schedule();
        return;
      }
      const next = [...this.records.values()].find((value) => value.bot === bot);
      if (next) {
        this.pages.set(bot, next.page);
        this.schedule();
      } else
        this.track(
          this.newPage(bot).then((value) => {
            if (!this.disposed) {
              this.pages.set(bot, value);
              this.schedule();
            }
          }),
        );
    });
    this.prompts.attach(tab);
    this.schedule();
    return tab;
  }
  private async title(tab: Tab) {
    if (this.disposed || tab.suspended) return;
    const generation = tab.generation;
    const title = (
      await inspect(() => tab.page.title(), new AbortController().signal).catch(() => '')
    ).slice(0, 200);
    if (
      !this.disposed &&
      this.records.has(tab.page) &&
      tab.generation === generation &&
      title !== tab.title
    ) {
      tab.title = title;
      this.revision++;
      this.schedule();
    }
  }
  private registry(): TabRegistry {
    const tabs: TabRegistry['tabs'] = [],
      active: Record<string, string> = {};
    for (const bot of this.attached) {
      for (const tab of this.records.values())
        if (tab.bot === bot) tabs.push({ id: tab.id, bot, url: tab.url, title: tab.title });
      const selected = this.records.get(this.pages.get(bot)!);
      if (selected) active[bot] = selected.id;
    }
    return { tabs, active };
  }
  private persist() {
    if (!this.store || this.restoring) return Promise.resolve();
    const next = this.saving
      .catch(() => {})
      .then(() => {
        if (this.storeError) throw new Fault(this.storeError, 503);
        return this.store!.save(this.registry());
      });
    this.saving = next;
    return next;
  }
  private schedule() {
    if (this.disposed || this.restoring || !this.store || this.storeError) return;
    this.persist().catch(() => {
      this.storeError = 'BROWSER_STATE_UNAVAILABLE';
      this.revision++;
    });
  }
  async restore(bots = [...this.pages.keys()]) {
    if (!this.store) {
      for (const bot of bots) this.attached.add(bot);
      this.restoring = false;
      return;
    }
    this.restoring = true;
    try {
      const saved = await this.store.read();
      if (saved) {
        for (const bot of bots) {
          const owned = saved.tabs.filter((tab) => tab.bot === bot);
          if (!owned.length) continue;
          for (const [index, value] of owned.entries()) {
            const page = index === 0 ? this.pages.get(bot)! : await this.newPage(bot);
            const tab = this.records.get(page)!;
            Object.assign(tab, {
              id: value.id,
              url: value.url,
              title: value.title,
              suspended: value.url !== 'about:blank',
            });
          }
          const selected = [...this.records.values()].find(
            (tab) => tab.bot === bot && tab.id === saved.active[bot],
          );
          if (!selected) throw new Fault('BROWSER_STATE_UNAVAILABLE');
          this.pages.set(bot, selected.page);
          this.invalidate(bot);
        }
      }
      for (const bot of bots) this.attached.add(bot);
      this.restoring = false;
      await this.persist();
    } catch {
      this.restoring = false;
      this.storeError = 'BROWSER_STATE_UNAVAILABLE';
      this.revision++;
    }
  }
  has(bot: string) {
    const page = this.pages.get(bot);
    return (
      this.attached.has(bot) && !!page && !page.isClosed() && !this.disposed && !this.storeError
    );
  }
  private changeOwnership<T>(operation: () => Promise<T>) {
    const pending = this.ownership.catch(() => {}).then(operation);
    this.ownership = pending;
    return pending;
  }
  attach(bot: string) {
    return this.changeOwnership(async () => {
      this.control.state(bot);
      if (this.disposed || this.storeError)
        throw new Fault(this.storeError || 'BROWSER_UNAVAILABLE', 503);
      if (this.attached.has(bot)) return this.state(bot);
      if (this.pages.has(bot)) throw new Fault('BROWSER_OUTCOME_UNKNOWN');
      try {
        const page = await this.newPage(bot);
        this.pages.set(bot, page);
        await this.restore([bot]);
        if (this.storeError) throw new Fault(this.storeError, 503);
        return await this.state(bot);
      } catch (error) {
        this.attached.delete(bot);
        for (const tab of [...this.records.values()].filter((item) => item.bot === bot))
          await tab.page.close().catch(() => {});
        if (![...this.records.values()].some((tab) => tab.bot === bot && !tab.page.isClosed()))
          this.pages.delete(bot);
        throw error;
      }
    });
  }
  detach(bot: string) {
    return this.changeOwnership(async () => {
      if (!this.pages.has(bot)) return;
      // Save the complete owner before removing it; later saves from other Bots must not erase its suspended metadata.
      if (this.attached.has(bot)) await this.persist();
      this.attached.delete(bot);
      this.observations.delete(bot);
      for (const tab of [...this.records.values()].filter((item) => item.bot === bot)) {
        this.prompts.retire(tab);
        await tab.page.close({ reason: 'Bot computer stopped' });
      }
      this.pages.delete(bot);
      this.invalidate(bot);
    });
  }
  async closeStorage() {
    await this.saving.catch(() => {});
    await this.store?.close();
  }
  private guardDownloads(page: Page) {
    if (this.guarded.has(page)) return;
    this.guarded.add(page);
    page.on('download', (download) => {
      const expected = this.expecting.get(page);
      if (expected && !expected.download) {
        expected.download = download;
        return;
      }
      // Only an explicitly observed download action may retain a file; popups and extra automatic downloads are cancelled.
      this.track(download.cancel().then(() => download.delete()));
    });
  }
  async monitorDownloads(directory: string) {
    this.monitor = await this.context.browser()!.newBrowserCDPSession();
    const oversized = new Set<string>();
    this.monitor.on('Browser.downloadProgress', (event) => {
      if (event.state !== 'inProgress') {
        oversized.delete(event.guid);
        return;
      }
      if (
        !oversized.has(event.guid) &&
        (event.receivedBytes > documentLimit || event.totalBytes > documentLimit)
      ) {
        oversized.add(event.guid);
        this.track(this.monitor!.send('Browser.cancelDownload', { guid: event.guid }));
      }
    });
    // Match Playwright's owned download directory; enable progress events without detaching downloads from its artifact owner.
    await this.monitor.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: directory,
      eventsEnabled: true,
    });
  }
  private async adopt(page: Page) {
    try {
      const opener = await page.opener();
      const source = opener ? this.records.get(opener) : undefined;
      if (source && this.attached.has(source.bot)) {
        this.register(source.bot, page);
        return;
      }
      // Explicit newPage calls register themselves; an opener-less page must not inherit another Bot's concurrent creation.
      await Promise.allSettled([...this.creating]);
      if (!this.records.has(page)) await page.close();
    } catch {
      await page.close().catch(() => {});
    }
  }
  private async newPage(bot: string) {
    const promise = this.context.newPage();
    this.creating.add(promise);
    let page: Page | undefined;
    try {
      page = await promise;
      this.register(bot, page);
      return page;
    } catch (error) {
      await page?.close().catch(() => {});
      throw error;
    } finally {
      this.creating.delete(promise);
    }
  }
  invalidate(bot: string) {
    this.revision++;
    this.observations.delete(bot);
    this.onChange(bot);
  }
  private current(bot: string, metadata = false) {
    if (!metadata && this.storeError) throw new Fault(this.storeError, 503);
    this.control.state(bot);
    const page = this.pages.get(bot),
      tab = page && this.records.get(page);
    if (!tab || page.isClosed() || this.disposed) throw new Fault('BROWSER_UNAVAILABLE', 503);
    return tab;
  }
  private url(value: unknown) {
    if (!publicUrl(value)) throw new Fault('INVALID_BROWSER_URL', 400);
    const url = new URL(value),
      host = url.hostname.replace(/^\[|\]$/g, '');
    const fixture = url.origin === this.origin && url.pathname.startsWith('/fixture/');
    if (
      !fixture &&
      ((isIP(host) && !publicAddress(host)) || host === 'localhost' || host.endsWith('.localhost'))
    )
      throw new Fault('INVALID_BROWSER_URL', 400);
    return url.href;
  }
  async state(bot: string, signal = new AbortController().signal): Promise<BrowserTabs> {
    await inspect(() => Promise.allSettled([...this.adopting]), signal);
    signal.throwIfAborted();
    return this.metadata(bot);
  }
  metadata(bot: string): BrowserTabs {
    const current = this.current(bot, true);
    return {
      bot,
      available: !this.storeError,
      instance: this.instance,
      revision: this.revision,
      active: current.id,
      tabs: [...this.records.values()]
        .filter((tab) => tab.bot === bot)
        .map((tab) => ({
          id: tab.id,
          url: tab.page.url(),
          title: tab.title,
          generation: tab.generation,
          ...(tab.suspended ? { suspended: true, restoreUrl: tab.url } : {}),
        })),
      pending: this.prompts.items(bot),
      ...(this.storeError ? { error: this.storeError } : {}),
    };
  }
  private async modelState(bot: string, signal: AbortSignal) {
    const { pending, ...state } = await this.state(bot, signal);
    return { ...state, ...(pending?.length ? { humanRequired: true } : {}) };
  }

  binding(bot: string): BrowserBinding {
    const tab = this.current(bot);
    return { instance: this.instance, tab: tab.id, generation: tab.generation };
  }
  frame(bot: string) {
    const tab = this.current(bot);
    return this.prompts.guard(tab, AbortSignal.timeout(4000), (signal) =>
      tab.page.screenshot({ type: 'jpeg', quality: 75, timeout: 4000, signal }),
    );
  }
  input<T>(bot: string, action: (signal: AbortSignal) => Promise<T>) {
    return this.prompts.guard(this.current(bot), AbortSignal.timeout(5000), action);
  }
  assertBinding(bot: string, value: unknown) {
    const current = this.binding(bot);
    if (
      !isBrowserBinding(value) ||
      value.instance !== current.instance ||
      value.tab !== current.tab ||
      value.generation !== current.generation
    )
      throw new Fault('BROWSER_VIEW_STALE');
  }
  async receipt(bot: string, id: string): Promise<BrowserReceipt> {
    this.control.state(bot);
    if (!this.store) throw new Fault('BROWSER_STATE_UNAVAILABLE', 503);
    return { id, bot, ...((await this.store.receipt(id, bot)) || { phase: 'unknown' as const }) };
  }
  async human(bot: string, request: BrowserCommandRequest): Promise<BrowserAck> {
    if (!isBrowserCommandRequest(request)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
    this.control.state(bot);
    if (!this.store) throw new Fault('BROWSER_STATE_UNAVAILABLE', 503);
    return this.mutate(
      bot,
      request.id,
      request.epoch,
      request.instance,
      [request.instance, request.epoch, request.action, request.tab ?? null, request.url ?? null],
      () => this.change(bot, request, AbortSignal.timeout(18000)),
      request.url,
    );
  }
  async answer(bot: string, request: BrowserAnswerRequest) {
    if (!isBrowserAnswerRequest(request)) throw new Fault('INVALID_BROWSER_REQUEST', 400);
    return this.mutate(
      bot,
      request.id,
      request.epoch,
      request.binding.instance,
      [
        request.epoch,
        request.binding,
        request.kind,
        request.prompt,
        request.kind === 'dialog' ? [request.accept, request.text ?? null] : request.files,
      ],
      () => this.prompts.answer(bot, request),
    );
  }
  private async mutate(
    bot: string,
    id: string,
    epoch: number,
    instance: string,
    fields: unknown[],
    effect: () => Promise<unknown>,
    url?: string,
  ): Promise<BrowserAck> {
    this.control.state(bot);
    if (!this.store) throw new Fault('BROWSER_STATE_UNAVAILABLE', 503);
    const signature = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
    const acknowledgement = async (): Promise<BrowserAck> => {
      const receipt = await this.store!.receipt(id, bot);
      return {
        id: id,
        state: await this.state(bot),
        ...(receipt?.phase === 'claimed'
          ? { error: 'BROWSER_OUTCOME_UNKNOWN', uncertain: true }
          : receipt?.error
            ? { error: receipt.error, uncertain: receipt.uncertain }
            : {}),
      };
    };
    // Settled retries are reads, even after the browser or control lease has changed.
    if (await this.store.receipt(id, bot)) {
      await this.store.claim(id, bot, signature);
      return acknowledgement();
    }
    if (instance !== this.instance) throw new Fault('BROWSER_INSTANCE_CHANGED');
    if (url) this.url(url);
    return this.control.execute(bot, 'human', epoch, async () => {
      if ((await this.store!.claim(id, bot, signature)) !== 'new') return acknowledgement();
      let error: string | undefined,
        uncertain = false;
      try {
        const lease = this.control.state(bot);
        if (lease.owner !== 'human' || lease.epoch !== epoch) throw new Fault('STALE_CONTROL');
        this.current(bot);
        uncertain = true;
        await effect();
        uncertain = false;
      } catch (failure) {
        error = failure instanceof Fault ? failure.code : 'BROWSER_COMMAND_FAILED';
      }
      try {
        await this.saving;
        await this.store!.finish(id, bot, this.registry(), error, uncertain);
      } catch {
        this.storeError = 'BROWSER_STATE_UNAVAILABLE';
        this.revision++;
        throw new Fault(this.storeError, 503);
      }
      return acknowledgement();
    });
  }

  private async change(
    bot: string,
    input: { action: string; tab?: string; url?: string },
    signal: AbortSignal,
  ) {
    this.current(bot);
    signal.throwIfAborted();
    if (!['select', 'close'].includes(input.action)) this.prompts.clear(bot);
    let tab: Tab;
    if (input.action === 'open' || input.action === 'new') {
      const page = await this.newPage(bot);
      tab = this.records.get(page)!;
      this.pages.set(bot, page);
    } else tab = this.owned(bot, input.tab);
    if (
      ['navigate', 'back', 'forward', 'reload'].includes(input.action) &&
      this.current(bot) !== tab
    )
      throw new Fault('BROWSER_VIEW_STALE');
    if (input.action === 'select' || input.action === 'resume') this.pages.set(bot, tab.page);
    this.invalidate(bot);
    if (input.action === 'select') return;
    if (input.action === 'close') {
      if ([...this.records.values()].filter((value) => value.bot === bot).length === 1)
        this.pages.set(bot, await this.newPage(bot));
      await tab.page.close({ reason: 'Owned browser tab closed' });
      return;
    }
    await this.prompts.guard(tab, signal, async (signal) => {
      const options = { waitUntil: 'domcontentloaded' as const, timeout: 18000, signal };
      if (input.action === 'open' || input.action === 'navigate')
        await tab.page.goto(this.url(input.url), options);
      if (input.action === 'resume') {
        if (tab.suspended) await tab.page.goto(this.url(tab.url), options);
      }
      if (input.action === 'back') await tab.page.goBack(options);
      if (input.action === 'forward') await tab.page.goForward(options);
      if (input.action === 'reload') await tab.page.reload(options);
    });
  }

  private owned(bot: string, id: unknown) {
    const tab = [...this.records.values()].find((tab) => tab.bot === bot && tab.id === id);
    if (!tab) throw new Fault('BROWSER_TAB_NOT_FOUND', 404);
    return tab;
  }
  private slice(value: Observation, offset = 0, limit = 16000): BrowserObservation {
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > value.text.length ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 32000
    )
      throw new Fault('INVALID_BROWSER_QUERY', 400);
    const text = value.text.slice(offset, offset + limit),
      next = offset + text.length;
    // Only structural ARIA entries grant a reference; page text containing a fake [ref=...] marker grants nothing.
    for (const line of text.split('\n')) {
      const ref = line.match(
        /^\s*- [a-z][\w-]*(?: "(?:[^"\\]|\\.)*")?(?: \[(?!ref=)[^\]\n]*\])* \[ref=([a-z0-9]+)\]/,
      )?.[1];
      if (ref) value.refs.add(ref);
    }
    return {
      id: value.id,
      tab: value.tab.id,
      url: value.url,
      title: value.title,
      text,
      offset,
      total: value.total,
      truncated: next < value.total,
      ...(next < value.text.length ? { nextOffset: next } : {}),
      ...(value.total > value.text.length ? { omitted: true } : {}),
    };
  }
  private saved(bot: string, actor: string, epoch: number, id: string, run?: string) {
    const value = this.observations.get(bot),
      tab = this.current(bot);
    if (
      !value ||
      value.id !== id ||
      value.tab !== tab ||
      value.generation !== tab.generation ||
      value.epoch !== epoch ||
      value.actor !== actor ||
      value.run !== run
    )
      throw new Fault('BROWSER_OBSERVATION_STALE');
    return value;
  }
  private async observe(
    bot: string,
    actor: string,
    epoch: number,
    signal: AbortSignal,
    run?: string,
    limit = 16000,
  ): Promise<BrowserObservation> {
    if (this.prompts.blocked(bot)) {
      signal.throwIfAborted();
      const tab = this.current(bot),
        text =
          'A browser interaction requires human takeover. Do not repeat the action or switch tools to bypass it.';
      return {
        id: randomUUID(),
        tab: tab.id,
        url: tab.page.url(),
        title: tab.title,
        text,
        offset: 0,
        total: text.length,
        truncated: false,
        humanRequired: true,
      };
    }
    // Child documents can finish loading while we read. Retry reads only; never repeat a click or navigation here.
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      const tab = this.current(bot),
        generation = tab.generation;
      try {
        return await this.prompts.guard(tab, signal, async (signal) => {
          const passwords = await inspect(
            () =>
              Promise.all(
                tab.page
                  .frames()
                  .map((frame) =>
                    frame
                      .locator(
                        'input[type="password"],input[autocomplete="current-password"],input[autocomplete="new-password"],input[autocomplete="one-time-code"]',
                      )
                      .evaluateAll((elements) =>
                        elements
                          .map((element) => (element as HTMLInputElement).value)
                          .filter(Boolean),
                      ),
                  ),
              ),
            signal,
          );
          let text = await tab.page.ariaSnapshot({ mode: 'ai', depth: 12, timeout: 5000, signal });
          // Playwright includes password values in AI snapshots. Strip them before caching or publishing any page text.
          for (const password of passwords.flat()) text = text.replaceAll(password, '[hidden]');
          signal.throwIfAborted();
          if (this.current(bot) !== tab || tab.generation !== generation)
            throw new Fault('BROWSER_OBSERVATION_STALE');
          const value: Observation = {
            id: randomUUID(),
            tab,
            generation,
            epoch,
            actor,
            run,
            text: text.slice(0, 256000),
            total: text.length,
            url: tab.page.url(),
            title: (await inspect(() => tab.page.title(), signal)).slice(0, 200),
            refs: new Set(),
          };
          if (this.current(bot) !== tab || tab.generation !== generation)
            throw new Fault('BROWSER_OBSERVATION_STALE');
          this.observations.set(bot, value);
          return this.slice(value, 0, limit);
        });
      } catch (error) {
        signal.throwIfAborted();
        if (this.prompts.blocked(bot)) return this.observe(bot, actor, epoch, signal, run, limit);
        if (attempt < 2 && (this.current(bot) !== tab || tab.generation !== generation)) continue;
        throw error;
      }
    }
    throw new Fault('BROWSER_OBSERVATION_STALE');
  }

  async navigate(
    bot: string,
    actor: string,
    epoch: number,
    value: unknown,
    signal: AbortSignal,
    run?: string,
  ) {
    const url = this.url(value);
    return this.control.execute(bot, actor, epoch, async () => {
      signal.throwIfAborted();
      this.invalidate(bot);
      const tab = this.current(bot);
      await this.prompts.guard(tab, signal, (signal) =>
        tab.page.goto(url, {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
          signal,
        }),
      );
      return this.observe(bot, actor, epoch, signal, run);
    });
  }
  async snapshot(
    bot: string,
    actor: string,
    epoch: number,
    signal: AbortSignal,
    run?: string,
    page: { observation?: string; offset?: number; limit?: number } = {},
  ) {
    return this.control.execute(bot, actor, epoch, async () => {
      signal.throwIfAborted();
      if (
        !page ||
        typeof page !== 'object' ||
        Array.isArray(page) ||
        Object.keys(page).some((key) => !['observation', 'offset', 'limit'].includes(key)) ||
        (page.observation !== undefined && !validAgentId(page.observation)) ||
        (page.offset !== undefined && (!Number.isSafeInteger(page.offset) || page.offset < 0)) ||
        (page.limit !== undefined &&
          (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 32000))
      )
        throw new Fault('INVALID_BROWSER_QUERY', 400);
      if (page.observation)
        return this.slice(
          this.saved(bot, actor, epoch, page.observation, run),
          page.offset,
          page.limit,
        );
      if (page.offset !== undefined) throw new Fault('INVALID_BROWSER_QUERY', 400);
      return this.observe(bot, actor, epoch, signal, run, page.limit);
    });
  }
  async act(
    bot: string,
    actor: string,
    epoch: number,
    id: string,
    input: unknown,
    signal: AbortSignal,
    run?: string,
  ) {
    const steps = actions(input);
    return this.control.execute(bot, actor, epoch, async () => {
      signal.throwIfAborted();
      this.prompts.clear(bot);
      const observed = this.saved(bot, actor, epoch, id, run),
        tab = observed.tab;
      for (const step of steps)
        if ('ref' in step && !observed.refs.has(step.ref))
          throw new Fault('BROWSER_REF_NOT_OBSERVED');
      let completed = 0,
        started = false,
        error: string | undefined,
        uncertain = false;
      try {
        await this.prompts.guard(tab, signal, async (signal) => {
          for (const step of steps) {
            signal.throwIfAborted();
            if (this.current(bot) !== tab || tab.generation !== observed.generation)
              throw new Fault('BROWSER_OBSERVATION_STALE');
            const locator = 'ref' in step ? tab.page.locator(`aria-ref=${step.ref}`) : undefined;
            if (locator && (step.kind === 'fill' || step.kind === 'press')) {
              const type = await locator.getAttribute('type', { timeout: 4000, signal });
              const autocomplete = await locator.getAttribute('autocomplete', {
                timeout: 4000,
                signal,
              });
              if (
                type === 'password' ||
                ['current-password', 'new-password', 'one-time-code'].includes(autocomplete || '')
              )
                throw new Fault('BROWSER_HUMAN_REQUIRED');
            }
            started = true;
            const options = { timeout: 5000, signal };
            if (step.kind === 'click') await locator!.click(options);
            if (step.kind === 'fill') await locator!.fill(step.text, options);
            if (step.kind === 'press') await locator!.press(step.key, options);
            if (step.kind === 'select') await locator!.selectOption(step.values, options);
            if (step.kind === 'scroll') await tab.page.mouse.wheel(0, step.deltaY);
            completed++;
            started = false;
          }
        });
      } catch (failure) {
        signal.throwIfAborted();
        uncertain = started;
        error = failure instanceof Fault ? failure.code : 'BROWSER_ACTION_FAILED';
      } finally {
        // An aborted action may have dispatched before cancellation; its old observation must never be reused.
        this.invalidate(bot);
      }
      const observation = await this.observe(bot, actor, epoch, signal, run);
      if (observation.humanRequired) error ||= 'BROWSER_HUMAN_REQUIRED';
      return { completed, observation, ...(error ? { error, uncertain } : {}) };
    });
  }
  async upload(
    bot: string,
    actor: string,
    epoch: number,
    id: string,
    ref: string,
    file: BrowserUpload,
    signal: AbortSignal,
    run?: string,
  ) {
    if (
      !isTaskFileName(file?.name) ||
      !Buffer.isBuffer(file.buffer) ||
      file.buffer.length > documentLimit ||
      typeof file.mimeType !== 'string'
    )
      throw new Fault('INVALID_BROWSER_FILE', 400);
    return this.control.execute(bot, actor, epoch, async () => {
      signal.throwIfAborted();
      this.prompts.clear(bot);
      const observed = this.saved(bot, actor, epoch, id, run);
      if (!observed.refs.has(ref)) throw new Fault('BROWSER_REF_NOT_OBSERVED');
      let completed = 0,
        started = false,
        error: string | undefined;
      const chooserStop = new AbortController();
      try {
        await this.prompts.guard(observed.tab, signal, async (signal) => {
          const locator = observed.tab.page.locator(`aria-ref=${ref}`);
          const type = await locator.getAttribute('type', { timeout: 4000, signal });
          if (type === 'file') {
            started = true;
            await locator.setInputFiles(file, { timeout: 5000, signal });
          } else {
            await this.prompts.expectFiles(observed.tab.page, async () => {
              const chooser = observed.tab.page.waitForEvent('filechooser', {
                timeout: 5000,
                signal: AbortSignal.any([signal, chooserStop.signal]),
              });
              chooser.catch(() => {});
              started = true;
              await locator.click({ timeout: 5000, signal });
              await (await chooser).setFiles(file, { timeout: 5000, signal });
            });
          }
          completed = 1;
          started = false;
        });
      } catch (failure) {
        signal.throwIfAborted();
        error = failure instanceof Fault ? failure.code : 'BROWSER_UPLOAD_FAILED';
      } finally {
        chooserStop.abort();
        this.invalidate(bot);
      }
      const observation = await this.observe(bot, actor, epoch, signal, run);
      if (observation.humanRequired) error ||= 'BROWSER_HUMAN_REQUIRED';
      return {
        completed,
        observation,
        ...(error ? { error, uncertain: started } : {}),
      };
    });
  }
  async download(
    bot: string,
    actor: string,
    epoch: number,
    id: string,
    ref: string,
    signal: AbortSignal,
    run: string | undefined,
    consume: (download: Download, signal: AbortSignal) => Promise<BrowserSavedFile>,
  ) {
    if (!this.monitor) throw new Fault('BROWSER_DOWNLOAD_UNAVAILABLE');
    let completed = 0,
      started = false,
      error: string | undefined,
      file: BrowserSavedFile | undefined,
      download: Download | undefined,
      page: Page | undefined;
    const waiter = new AbortController();
    try {
      await this.control.execute(bot, actor, epoch, async () => {
        signal.throwIfAborted();
        this.prompts.clear(bot);
        const observed = this.saved(bot, actor, epoch, id, run);
        if (!observed.refs.has(ref)) throw new Fault('BROWSER_REF_NOT_OBSERVED');
        await this.prompts.guard(observed.tab, signal, async (signal) => {
          this.invalidate(bot);
          page = observed.tab.page;
          this.expecting.set(page, {});
          const next = page.waitForEvent('download', {
            timeout: 15000,
            signal: AbortSignal.any([signal, waiter.signal]),
          });
          next.catch(() => {});
          started = true;
          await page.locator(`aria-ref=${ref}`).click({ timeout: 5000, signal });
          download = await next;
          completed = 1;
          started = false;
        });
      });
      // The click is fenced, but background transfer/file IO must not keep the computer takeover queue locked.
      file = await consume(download!, signal);
    } catch (failure) {
      signal.throwIfAborted();
      error = failure instanceof Fault ? failure.code : 'BROWSER_DOWNLOAD_FAILED';
    } finally {
      waiter.abort();
      if (page) this.expecting.delete(page);
      if (download) {
        const finished = download;
        this.track(finished.cancel().then(() => finished.delete()));
      }
    }
    let observation: BrowserObservation | undefined;
    try {
      observation = await this.control.execute(bot, actor, epoch, () =>
        this.observe(bot, actor, epoch, signal, run),
      );
    } catch (failure) {
      signal.throwIfAborted();
      error ||= failure instanceof Fault ? failure.code : 'BROWSER_OBSERVATION_STALE';
    }
    return {
      completed,
      ...(observation ? { observation } : {}),
      ...(file ? { file } : {}),
      ...(error ? { error, uncertain: started } : {}),
    };
  }

  async command(
    bot: string,
    actor: string,
    epoch: number,
    input: { action: string; tab?: string; url?: string },
    signal: AbortSignal,
    run?: string,
  ) {
    const fields =
      input?.action === 'list'
        ? ['action']
        : input?.action === 'open'
          ? ['action', 'url']
          : ['select', 'close', 'resume'].includes(input?.action)
            ? ['action', 'tab']
            : [];
    if (
      !input ||
      typeof input !== 'object' ||
      Array.isArray(input) ||
      !fields.length ||
      Object.keys(input).some((key) => !fields.includes(key)) ||
      (['select', 'close', 'resume'].includes(input.action) && !validAgentId(input.tab))
    )
      throw new Fault('INVALID_BROWSER_ACTION', 400);
    const url = input.action === 'open' ? this.url(input.url) : undefined;
    return this.control.execute(bot, actor, epoch, async () => {
      signal.throwIfAborted();
      this.current(bot);
      if (input.action === 'list') return { state: await this.modelState(bot, signal) };
      await this.change(bot, { ...input, ...(url ? { url } : {}) }, signal);
      await this.persist();
      return {
        state: await this.modelState(bot, signal),
        observation: await this.observe(bot, actor, epoch, signal, run),
      };
    });
  }
  dispose() {
    this.disposed = true;
    this.context.removeListener('page', this.added);
    this.observations.clear();
    this.prompts.dispose();
    this.monitor?.detach().catch(() => {});
  }
}

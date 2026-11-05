import { mkdir, readFile } from 'node:fs/promises';
import { arch, platform, release } from 'node:os';
import path from 'node:path';
import {
  type BrowserBinding,
  type BrowserView,
  isBrowserInput,
  validAgentId,
} from '@daban/protocol';
import type { BrowserContext, Page } from 'playwright';
import { Control, errorCode, Fault } from './control.js';
import { browserEngine } from './playwright-input.js';
import { createProxy, type ProxyOptions, type PublicProxy } from './proxy.js';
import type { LegacySnapshot } from './snapshot.js';
import { TabStore } from './tab-store.js';
import { Tabs } from './tabs.js';

export interface BrowserOptions {
  bots?: readonly string[];
  control?: Control;
  profileDir: string;
  networkFile?: string;
  origin: string;
  interval?: number;
  fixture?: boolean;
  proxy?: Omit<ProxyOptions, 'fixtureOrigin'>;
  workerAction?: (id: string, page: Page) => Promise<unknown>;
}
export async function createBrowser({
  profileDir,
  networkFile,
  origin,
  interval = 700,
  workerAction,
  fixture = false,
  proxy: suppliedProxy,
  bots,
  control,
}: BrowserOptions) {
  const ids = bots ?? ['a', 'b'];
  if (ids.length > 16 || !ids.every(validAgentId) || new Set(ids).size !== ids.length)
    throw new Fault('INVALID_BROWSER_STATE', 400);
  const { chromium } = await browserEngine();
  let proxyOptions = suppliedProxy;
  if (!proxyOptions) {
    try {
      const network: unknown = JSON.parse(
        await readFile(networkFile ?? path.resolve(profileDir, '../model/network.json'), 'utf8'),
      );
      if (!network || typeof network !== 'object' || Array.isArray(network))
        throw new Fault('BROWSER_PROXY_CONFIG_INVALID', 503);
      const upstream = 'proxy' in network ? network.proxy : undefined;
      if (upstream != null && typeof upstream !== 'string')
        throw new Fault('BROWSER_PROXY_CONFIG_INVALID', 503);
      // Existing installations store null for disabled proxying; do not turn that valid legacy state into a startup failure.
      proxyOptions = { upstream: upstream ?? undefined };
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new Fault('BROWSER_PROXY_CONFIG_INVALID', 503);
    }
  }
  const downloads = path.join(profileDir, '.downloads');
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  const proxy = await createProxy({ ...proxyOptions, fixtureOrigin: origin });
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      viewport: { width: 960, height: 640 },
      deviceScaleFactor: 1,
      chromiumSandbox: true,
      acceptDownloads: true,
      downloadsPath: downloads,
      proxy: { server: proxy.url },
      // Chromium normally bypasses a proxy for loopback. All page traffic must cross the same private-address boundary.
      args: [
        '--proxy-bypass-list=<-loopback>',
        '--disable-quic',
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ],
    });
    await context.route('**/*', (route) => {
      try {
        const url = new URL(route.request().url());
        return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
          ? route.continue()
          : route.abort('blockedbyclient');
      } catch {
        return route.abort('blockedbyclient');
      }
    });
    const pages = new Map();
    await Promise.all(
      ids.map(async (id) => {
        const page = await context!.newPage();
        page.setDefaultTimeout(4000);
        if (fixture) {
          await page.goto(`${origin}/fixture/page?bot=${id}`);
          await page.locator('#identity[data-ready="true"]').waitFor();
        }
        pages.set(id, page);
      }),
    );
    for (const page of context.pages()) if (![...pages.values()].includes(page)) await page.close();
    const browser = new Browser(context, pages, interval, workerAction, { origin, proxy, control });
    browser.tabs = new Tabs(
      context,
      pages,
      browser.control,
      origin,
      (bot) => browser.changed(bot),
      fixture
        ? undefined
        : new TabStore(
            path.join(profileDir, '.daban-tabs.sqlite'),
            bots === undefined ? [...pages.keys()] : undefined,
          ),
    );
    await browser.tabs.restore();
    await browser.tabs.monitorDownloads(downloads);
    return browser;
  } catch (error) {
    try {
      await context?.close();
    } finally {
      await proxy.close();
    }
    throw error;
  }
}

interface Worker {
  running: boolean;
  generation: number;
  timer: ReturnType<typeof setTimeout> | null;
  error: string | null;
}
export class Browser {
  context: BrowserContext;
  pages: Map<string, Page>;
  control: Control;
  workers: Map<string, Worker>;
  frames: Map<string, Promise<Buffer>>;
  events: LegacySnapshot['events'];
  interval: number;
  workerAction: NonNullable<BrowserOptions['workerAction']>;
  closed: boolean;
  origin?: string;
  tabs?: Tabs;
  private readonly pointers = new Map<
    string,
    { page: Page; button: 'left' | 'middle' | 'right'; binding: BrowserBinding; retired?: boolean }
  >();
  private readonly releasing = new Map<string, Promise<unknown>>();
  constructor(
    context: BrowserContext,
    pages: Map<string, Page>,
    interval: number,
    workerAction: NonNullable<BrowserOptions['workerAction']> = async (_id, page) =>
      page.locator('#increment').click(),
    private readonly resources: { origin?: string; proxy?: PublicProxy; control?: Control } = {},
  ) {
    this.context = context;
    this.origin = resources.origin;
    this.pages = pages;
    this.control = resources.control ?? new Control([...pages.keys()]);
    this.workers = new Map(
      [...pages.keys()].map((id) => [
        id,
        { running: false, generation: 0, timer: null, error: null },
      ]),
    );
    this.frames = new Map();
    this.events = [];
    this.interval = interval;
    this.workerAction = workerAction;
    this.closed = false;
    this.log('system', '两个真实页面已就绪，共用一个持久浏览器会话');
  }
  log(bot: string, message: string) {
    this.events.push({ at: new Date().toISOString(), bot, message });
    this.events = this.events.slice(-60);
  }
  page(id: string) {
    this.control.state(id);
    const page = this.pages.get(id);
    if (!page) throw new Fault('BROWSER_UNAVAILABLE', 503);
    return page;
  }
  async attach(id: string) {
    this.control.state(id);
    if (this.closed || !this.tabs) throw new Fault('BROWSER_UNAVAILABLE', 503);
    if (!this.workers.has(id))
      this.workers.set(id, { running: false, generation: 0, timer: null, error: null });
    return this.tabs.attach(id);
  }
  async detach(id: string) {
    await this.stopWorker(id);
    await this.tabs?.detach(id);
    await this.releasePointer(id);
    this.frames.delete(id);
  }
  changed(id: string) {
    this.frames.delete(id);
    const held = this.pointers.get(id);
    if (!held || !this.tabs) return;
    if (this.tabs.prompts.blocked(id)) {
      held.retired = true;
      return;
    }
    try {
      if (held.retired) throw new Fault('BROWSER_HUMAN_REQUIRED');
      this.tabs.assertBinding(id, held.binding);
    } catch {
      this.releasePointer(id).catch(() => this.log(id, '浏览器鼠标释放失败，请重新接管后继续'));
    }
  }
  private releasePointer(id: string, signal = AbortSignal.timeout(1000)) {
    const held = this.pointers.get(id);
    if (!held) return this.releasing.get(id) || Promise.resolve();
    this.pointers.delete(id);
    // Mouse-up can wait on a JS dialog; active input must forward its prompt-cancellation signal.
    // Release the original page, and fence the next press until that release has settled.
    const pending = held.page.mouse
      .up({ button: held.button, signal })
      .catch((error) => {
        if (held.page.isClosed()) return;
        if (!this.pointers.has(id)) this.pointers.set(id, held);
        throw error;
      })
      .finally(() => {
        if (this.releasing.get(id) === pending) this.releasing.delete(id);
      });
    this.releasing.set(id, pending);
    return pending;
  }
  act<T>(
    id: string,
    actor: string,
    epoch: number,
    action: (page: Page) => T | Promise<T>,
    binding?: BrowserBinding,
  ) {
    return this.control.execute(id, actor, epoch, () => {
      if (binding) this.tabs?.assertBinding(id, binding);
      this.tabs?.prompts.clear(id);
      const page = this.page(id);
      this.tabs?.invalidate(id);
      return action(page);
    });
  }
  async transfer(id: string, epoch: number, owner: string, settle?: () => Promise<unknown>) {
    const lease = await this.control.transfer(id, epoch, owner, async () => {
      if (!this.tabs?.prompts.blocked(id)) await this.releasePointer(id);
      await settle?.();
    });
    this.tabs?.invalidate(id);
    this.log(
      id,
      owner === 'human' ? '已暂停 Agent，用户获得页面控制权' : '用户已交还，Agent 可以继续操作',
    );
    return lease;
  }
  async input(
    id: string,
    epoch: number,
    value: unknown,
    actor = 'human',
    binding?: BrowserBinding,
  ) {
    if (!binding && this.tabs) binding = this.tabs.binding(id);
    if (binding) return this.boundInput(id, epoch, binding, value, actor);
    if (!value || typeof value !== 'object') throw new Fault('INVALID_INPUT', 400);
    const input = value as { type?: string; x?: number; y?: number; text?: string; key?: string };
    const keys = [
      'Enter',
      'Tab',
      'Backspace',
      'Delete',
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Escape',
      'Home',
      'End',
      'ControlOrMeta+A',
    ];
    if (input.type === 'click') {
      if (
        !Number.isFinite(input.x) ||
        !Number.isFinite(input.y) ||
        input.x! < 0 ||
        input.y! < 0 ||
        input.x! >= 960 ||
        input.y! >= 640
      )
        throw new Fault('INVALID_INPUT', 400);
    } else if (input.type === 'text') {
      if (typeof input.text !== 'string' || input.text.length > 2000)
        throw new Fault('INVALID_INPUT', 400);
    } else if (input.type === 'key') {
      if (!keys.includes(input.key || '')) throw new Fault('INVALID_INPUT', 400);
    } else throw new Fault('INVALID_INPUT', 400);
    return this.act(id, actor, epoch, async (page) => {
      if (input.type === 'click') await page.mouse.click(input.x!, input.y!);
      if (input.type === 'text') await page.keyboard.insertText(input.text!);
      if (input.type === 'key') await page.keyboard.press(input.key!);
    });
  }
  async view(id: string): Promise<BrowserView> {
    if (!this.tabs) throw new Fault('BROWSER_UNAVAILABLE', 503);
    const binding = this.tabs.binding(id),
      { epoch } = this.control.state(id);
    let image: Buffer | undefined;
    if (!this.tabs.prompts.blocked(id)) {
      try {
        image = await this.frame(id);
      } catch (error) {
        if (!this.tabs.prompts.blocked(id)) throw error;
      }
    }
    this.tabs.assertBinding(id, binding);
    if (this.control.state(id).epoch !== epoch) throw new Fault('STALE_CONTROL');
    return {
      bot: id,
      epoch,
      binding,
      ...(image
        ? { image: `data:image/jpeg;base64,${image.toString('base64')}` }
        : { paused: true as const }),
      width: 960,
      height: 640,
    };
  }
  async boundInput(
    id: string,
    epoch: number,
    binding: BrowserBinding,
    input: unknown,
    actor = 'human',
  ) {
    if (!isBrowserInput(input)) throw new Fault('INVALID_INPUT', 400);
    if (!this.tabs) throw new Fault('BROWSER_UNAVAILABLE', 503);
    return this.act(
      id,
      actor,
      epoch,
      async (page) =>
        this.tabs!.input(id, async (signal) => {
          await this.releasing.get(id);
          this.tabs!.assertBinding(id, binding);
          if (input.type !== 'pointer') await this.releasePointer(id, signal);
          if (input.type === 'click')
            await page.mouse.click(input.x, input.y, {
              signal,
              button: input.button === 2 ? 'middle' : input.button === 3 ? 'right' : 'left',
            });
          if (input.type === 'text') await page.keyboard.insertText(input.text, { signal });
          if (input.type === 'key') await page.keyboard.press(input.key, { signal });
          if (input.type === 'scroll') await page.mouse.wheel(0, input.deltaY, { signal });
          if (input.type === 'pointer') {
            await page.mouse.move(input.x, input.y, { signal });
            const options = {
              signal,
              button:
                input.button === 2
                  ? ('middle' as const)
                  : input.button === 3
                    ? ('right' as const)
                    : ('left' as const),
            };
            if (input.phase === 'down') {
              await this.releasePointer(id, signal);
              this.tabs!.assertBinding(id, binding);
              this.pointers.set(id, { page, button: options.button, binding });
              await page.mouse.down(options);
            }
            if (input.phase === 'up') await this.releasePointer(id, signal);
          }
        }),
      binding,
    );
  }
  async startWorker(id: string) {
    if (this.origin && !this.fixture(this.page(id))) throw new Fault('DEMO_PAGE_REQUIRED');
    this.page(id);
    const worker = this.workers.get(id)!;
    if (worker.running) return;
    worker.running = true;
    const generation = ++worker.generation;
    worker.error = null;
    this.log(id, '开始演示任务');
    const tick = async () => {
      if (!worker.running || this.closed || worker.generation !== generation) return;
      const lease = this.control.state(id);
      if (lease.owner === 'agent') {
        try {
          await this.act(id, 'agent', lease.epoch, (page) => {
            if (this.origin && !this.fixture(page)) throw new Fault('DEMO_PAGE_REQUIRED');
            return this.workerAction(id, page);
          });
        } catch (error) {
          if (errorCode(error) !== 'STALE_CONTROL' && worker.generation === generation) {
            worker.error = '任务操作失败，请停止任务后重试';
            worker.running = false;
            this.log(id, worker.error);
          }
        }
      }
      // A retired in-flight tick must not spawn a second loop after a quick restart.
      if (worker.running && !this.closed && worker.generation === generation)
        worker.timer = setTimeout(tick, this.interval);
    };
    worker.timer = setTimeout(tick, 0);
  }
  async stopWorker(id: string) {
    this.control.state(id);
    const worker = this.workers.get(id);
    if (!worker) return;
    const wasRunning = worker.running;
    worker.running = false;
    worker.generation++;
    if (worker.timer) clearTimeout(worker.timer);
    await this.control.drain(id);
    if (wasRunning) this.log(id, '脚本任务已停止');
  }
  async frame(id: string) {
    const page = this.page(id);
    if (!this.frames.has(id)) {
      const pending = (
        this.tabs
          ? this.tabs.frame(id)
          : page.screenshot({ type: 'jpeg', quality: 75, timeout: 4000 })
      ).finally(() => {
        if (this.frames.get(id) === pending) this.frames.delete(id);
      });
      this.frames.set(id, pending);
    }
    return this.frames.get(id)!;
  }
  private fixture(page: Page) {
    try {
      const url = new URL(page.url());
      return url.origin === this.origin && url.pathname === '/fixture/page';
    } catch {
      return false;
    }
  }
  async snapshot(): Promise<LegacySnapshot> {
    const cookies = await this.context.cookies();
    const bots: LegacySnapshot['bots'] = {};
    await Promise.all(
      [...this.pages.keys()].map(async (id) => {
        const empty = { count: 0, identity: '', note: '' };
        const page = this.page(id);
        const content =
          this.fixture(page) && !this.tabs?.prompts.blocked(id)
            ? await page
                .evaluate(() => ({
                  count: Number(document.querySelector('#count')?.textContent || 0),
                  identity: document.querySelector('#identity')?.textContent || '',
                  note: document.querySelector<HTMLInputElement>('#note')?.value || '',
                }))
                .catch(() => empty)
            : empty;
        const worker = this.workers.get(id)!;
        bots[id] = {
          ...this.control.state(id),
          ...content,
          running: worker.running,
          error: worker.error,
        };
      }),
    );
    return {
      browsers: this.tabs
        ? Object.fromEntries(
            await Promise.all(
              [...this.pages.keys()].map(async (id) => [id, await this.tabs!.state(id)]),
            ),
          )
        : undefined,
      bots,
      sharedLogin: cookies.some((cookie) => cookie.name === 'demo_session'),
      events: this.events,
      viewport: { width: 960, height: 640 },
      environment: {
        platform: platform(),
        arch: arch(),
        kernel: release(),
        node: process.versions.node,
        browser: this.context.browser()!.version(),
      },
    };
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([...this.workers.keys()].map((id) => this.stopWorker(id)));
    await Promise.allSettled(this.frames.values());
    this.tabs?.dispose();
    try {
      await this.context.close();
    } finally {
      try {
        await this.tabs?.closeStorage();
      } finally {
        await this.resources.proxy?.close();
      }
    }
  }
}

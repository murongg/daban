import { arch, platform, release } from 'node:os';
import type {
  BrowserState,
  ComputerAck,
  ComputerRequest,
  ComputerState,
  ComputerStatus,
} from '@daban/protocol';
import { isBrowserState, validAgentId } from '@daban/protocol';
import type { BrowserDriver } from './browser-tools.js';
import type { ComputerFacade } from './computer-tools.js';
import { Connections } from './connections.js';
import { Control, Fault } from './control.js';
import type { Native } from './native.js';
import type { Browser } from './runtime.js';
import type { LegacySnapshot } from './snapshot.js';

export interface ComputerResource {
  bot: string;
  instance?: string;
  native: Native;
  alive: () => boolean;
}
export interface ComputerDriver {
  start: (bot: string, slot: number, control: Control) => Promise<ComputerResource>;
  stop: (resource: ComputerResource) => Promise<unknown>;
  close: () => Promise<unknown>;
  hasBrowser: (bot: string) => boolean;
  browserFor: (bot: string) => Browser;
}
export class ComputerStartFailure extends Fault {
  constructor(
    code: string,
    readonly cleaned: boolean,
    readonly resource?: ComputerResource,
  ) {
    super(code, 503);
  }
}
const failureCode = (error: unknown, fallback: string) =>
  error instanceof Fault && /^[A-Z_]{1,80}$/.test(error.code) ? error.code : fallback;

export class Computers {
  readonly facade: ComputerFacade;
  readonly control = new Control([]);
  readonly connections: Connections;
  readonly ready: Promise<unknown>;
  private readonly resources = new Map<string, ComputerResource>();
  private readonly operations = new Map<string, Promise<ComputerAck>>();
  private closed = false;
  private closing?: Promise<unknown>;
  constructor(
    readonly options: {
      file: string;
      limit: number;
      boot: string;
      driver: ComputerDriver;
      registered: (bot: string) => Promise<boolean>;
      admit?: (bot: string) => boolean;
      busy: (bot: string) => boolean;
      drain: (bot: string) => Promise<unknown>;
    },
  ) {
    this.connections = new Connections(options);
    this.ready = this.connections.ready;
    const tabs: BrowserDriver = {
      navigate: (...args) => this.browserFor(args[0]).tabs!.navigate(...args),
      snapshot: (...args) => this.browserFor(args[0]).tabs!.snapshot(...args),
      act: (...args) => this.browserFor(args[0]).tabs!.act(...args),
      command: (...args) => this.browserFor(args[0]).tabs!.command(...args),
      upload: (...args) => this.browserFor(args[0]).tabs!.upload(...args),
      download: (...args) => this.browserFor(args[0]).tabs!.download(...args),
    };
    this.facade = {
      control: this.control,
      available: (bot) => this.available(bot),
      admit: (bot) => {
        this.assertStable(bot);
        return true;
      },
      stopWorker: (bot) => this.stopWorker(bot),
      frame: (bot, instance, epoch) => this.frame(bot, instance, epoch),
      screens: {
        instance: (bot) => this.resource(bot).native.screens.instance(bot),
        input: (bot, input) => this.resource(bot).native.screens.input(bot, input),
        openApp: (bot, app) => {
          if (app === 'browser') this.browserFor(bot);
          return this.resource(bot).native.screens.openApp(bot, app);
        },
      },
      browser: {
        tabs,
        available: (bot) => this.available(bot) && this.options.driver.hasBrowser(bot),
        frame: (bot) => this.browserFor(bot).frame(bot),
        view: (bot) => this.browserFor(bot).view(bot),
        input: (bot, epoch, input, actor, binding) =>
          this.browserFor(bot).input(bot, epoch, input, actor, binding),
      },
    };
  }
  browserFor(bot: string) {
    this.resource(bot);
    return this.options.driver.browserFor(bot);
  }
  page(bot: string) {
    this.resource(bot);
    return this.options.driver.hasBrowser(bot) ? this.browserFor(bot).page(bot) : undefined;
  }
  assertInstance(bot: string, instance: unknown) {
    this.resource(bot).native.assertInstance(bot, instance);
  }
  async frame(bot: string, instance?: string, epoch?: number) {
    const resource = this.resource(bot);
    const image = await resource.native.frame(bot, instance, epoch);
    if (this.resource(bot) !== resource) throw new Fault('DESKTOP_VIEW_STALE');
    return image;
  }
  input(bot: string, epoch: number, input: unknown, instance?: string) {
    return this.resource(bot).native.input(bot, epoch, input, instance);
  }
  openApp(bot: string, epoch: number, app: string, instance?: string) {
    if (app === 'browser') this.browserFor(bot);
    return this.resource(bot).native.openApp(bot, epoch, app, instance);
  }
  transfer(bot: string, epoch: number, owner: string, instance?: string) {
    this.assertInstance(bot, instance);
    const settle = () => {
      this.assertInstance(bot, instance);
      return this.resource(bot).native.screens.release(bot);
    };
    return this.options.driver.hasBrowser(bot)
      ? this.browserFor(bot).transfer(bot, epoch, owner, settle)
      : this.control.transfer(bot, epoch, owner, settle);
  }
  browserFrame(bot: string) {
    return this.browserFor(bot).frame(bot);
  }
  stopWorker(bot: string) {
    return this.options.driver.hasBrowser(bot)
      ? this.browserFor(bot).stopWorker(bot)
      : this.control.drain(bot);
  }
  async startWorker(_bot: string): Promise<never> {
    throw new Fault('TASK_REQUIRED', 400);
  }
  async snapshot(): Promise<LegacySnapshot> {
    const bots = Object.fromEntries(
      [...this.resources.keys()]
        .filter((bot) => this.available(bot))
        .map((bot) => [
          bot,
          {
            ...this.control.state(bot),
            instance: this.resource(bot).instance!,
            running: false,
            error: null,
            count: 0,
            identity: '',
            note: '',
          },
        ]),
    );
    const browsers: Record<string, BrowserState> = {};
    for (const bot of Object.keys(bots)) {
      try {
        // Global polling reads cached metadata only; a dialog or page adoption must not stall every Bot.
        if (this.options.driver.hasBrowser(bot)) {
          const tabs = this.browserFor(bot).tabs;
          const state = tabs?.metadata(bot);
          // Page-derived malformed fields must not invalidate every Bot in the strict client snapshot.
          if (isBrowserState(state) && state.bot === bot) browsers[bot] = state;
        }
      } catch {
        /* Optional browser bookkeeping must not hide an available native screen or ordinary Agent. */
      }
    }
    return {
      mode: Object.keys(bots).length ? 'desktop' : 'agent',
      bots,
      browsers,
      sharedLogin: false,
      viewport: { width: 1280, height: 800 },
      environment: {
        platform: platform(),
        arch: arch(),
        kernel: release(),
        node: process.versions.node,
        browser: '',
      },
      events: [],
    };
  }
  state(bot: string): ComputerState {
    const state = this.connections.get(bot),
      resource = this.resources.get(bot);
    if (state.phase === 'connected') {
      let alive = false;
      try {
        alive = !!resource && resource.instance === state.instance && resource.alive();
      } catch {}
      if (!alive)
        return {
          ...state,
          phase: 'failed',
          error: 'COMPUTER_RUNTIME_FAILED',
          recovery: resource ? 'stop' : 'restart',
        };
    }
    return state;
  }
  status(): ComputerStatus {
    const state = this.connections.snapshot();
    if (this.closed)
      return { ...state, available: false, items: [], error: 'COMPUTER_SERVICE_CLOSED' };
    return { ...state, items: state.items.map((item) => this.state(item.bot)) };
  }
  resource(bot: string) {
    if (this.closed || this.state(bot).phase !== 'connected')
      throw new Fault('COMPUTER_NOT_CONNECTED', 503);
    const resource = this.resources.get(bot);
    if (!resource?.instance) throw new Fault('COMPUTER_NOT_CONNECTED', 503);
    return resource;
  }
  available(bot: string) {
    try {
      this.resource(bot);
      return true;
    } catch {
      return false;
    }
  }
  assertStable(bot: string) {
    if (this.closed) throw new Fault('COMPUTER_SERVICE_CLOSED', 503);
    if (!this.connections.snapshot().available) return;
    if (['connecting', 'stopping'].includes(this.connections.get(bot).phase))
      throw new Fault('COMPUTER_CHANGING');
  }
  private ack(id: string, bot: string): ComputerAck {
    return { receipt: this.connections.receipt(id, bot), state: this.state(bot) };
  }
  async receipt(id: string, bot: string) {
    await this.ready;
    return this.ack(id, bot);
  }
  async operate(input: ComputerRequest): Promise<ComputerAck> {
    const request = structuredClone(input);
    await this.ready;
    if (this.closed) throw new Fault('COMPUTER_SERVICE_CLOSED', 503);
    const prior = this.connections.receipt(request.id, request.bot);
    if (prior.phase !== 'unknown') {
      this.connections.claim(request);
      return this.operations.get(request.id) ?? this.ack(request.id, request.bot);
    }
    if (request.action === 'connect' && !(await this.options.registered(request.bot)))
      throw new Fault('COMPUTER_BOT_NOT_FOUND', 404);
    if (this.closed) throw new Fault('COMPUTER_SERVICE_CLOSED', 503);
    // Registration can yield while a Bot starts archiving; recheck in the same turn as the resource claim.
    if (request.action === 'connect' && this.options.admit?.(request.bot) === false)
      throw new Fault('COMPUTER_BOT_UNAVAILABLE');
    if (this.options.busy(request.bot)) throw new Fault('COMPUTER_BUSY');
    const current = this.state(request.bot);
    if (current.reserved && !this.resources.has(request.bot))
      throw new Fault('COMPUTER_RECOVERY_REQUIRED');
    const claim = this.connections.claim(request);
    if (!claim.fresh) return this.operations.get(request.id) ?? this.ack(request.id, request.bot);
    // Claim and model admission are synchronous; neither can grant authority halfway through the other's change.
    const pending = this.perform(request, claim.slot).finally(() => {
      if (this.operations.get(request.id) === pending) this.operations.delete(request.id);
    });
    this.operations.set(request.id, pending);
    return pending;
  }
  private async perform(request: ComputerRequest, slot?: number): Promise<ComputerAck> {
    if (request.action === 'connect') {
      this.control.register(request.bot);
      let resource: ComputerResource | undefined;
      let driverCalled = false;
      try {
        await this.options.drain(request.bot);
        if (slot === undefined) throw new Fault('INVALID_COMPUTER_STATE');
        driverCalled = true;
        resource = await this.options.driver.start(request.bot, slot, this.control);
        if (
          resource.bot !== request.bot ||
          !validAgentId(resource.instance) ||
          resource.native.control !== this.control
        )
          throw new Fault('INVALID_COMPUTER_STATE');
        this.resources.set(request.bot, resource);
        this.connections.finish(request.id, { phase: 'connected', instance: resource.instance });
        this.control.activate(request.bot);
      } catch (error) {
        let cleaned = !driverCalled || (error instanceof ComputerStartFailure && error.cleaned);
        resource ??= error instanceof ComputerStartFailure ? error.resource : undefined;
        if (resource && !(error instanceof ComputerStartFailure)) {
          try {
            await this.options.driver.stop(resource);
            cleaned = true;
          } catch {
            cleaned = false;
          }
        }
        await this.control.revoke(request.bot);
        if (!cleaned && resource) this.resources.set(request.bot, resource);
        else this.resources.delete(request.bot);
        this.connections.finish(request.id, {
          phase: 'failed',
          error: failureCode(error, 'COMPUTER_START_FAILED'),
          reserved: !cleaned,
          recovery: cleaned ? undefined : resource ? 'stop' : 'restart',
          instance: resource?.instance,
        });
      }
    } else {
      const resource = this.resources.get(request.bot);
      if (!resource) throw new Fault('COMPUTER_RECOVERY_REQUIRED');
      try {
        await this.control.revoke(request.bot);
        await this.options.drain(request.bot);
        await this.options.driver.stop(resource);
        this.connections.finish(request.id, { phase: 'disconnected' });
        this.resources.delete(request.bot);
      } catch (error) {
        this.connections.finish(request.id, {
          phase: 'failed',
          error: failureCode(error, 'COMPUTER_STOP_UNCONFIRMED'),
          reserved: true,
          recovery: 'stop',
          instance: resource.instance,
        });
      }
    }
    return this.ack(request.id, request.bot);
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.closing = this.shutdown();
    return this.closing;
  }
  private async shutdown() {
    await this.ready;
    await Promise.allSettled(this.operations.values());
    let failure: unknown;
    for (const [bot, resource] of this.resources) {
      try {
        await this.control.revoke(bot);
        await this.options.drain(bot);
        await this.options.driver.stop(resource);
        this.connections.suspend(bot);
        this.resources.delete(bot);
      } catch (error) {
        failure ||= error;
      }
    }
    try {
      await this.options.driver.close();
    } catch (error) {
      failure ||= error;
    }
    await this.connections.close();
    if (failure) throw failure;
  }
}

import { randomUUID } from 'node:crypto';
import {
  isLocalComputerInput,
  type LocalComputerCommand,
  type LocalComputerFrame,
  type LocalComputerInput,
  type LocalComputerSession,
  type LocalComputerStatus,
  type LocalComputerWindow,
  validAgentId,
} from '@daban/protocol';

export interface LocalCapture {
  image: string;
  width: number;
  height: number;
  context: string;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface LocalDriver {
  supported: boolean;
  platform: 'darwin' | 'win32' | 'unsupported';
  prepare?: () => undefined;
  requestPermissions?: () => Promise<unknown>;
  windows?: () => Promise<LocalComputerWindow[]> | LocalComputerWindow[];
  forWindow?: (id: string) => Promise<WindowDriver> | WindowDriver;
  close?: () => Promise<unknown>;
  permissions(): { screen: boolean; accessibility: boolean };
  capture(): Promise<LocalCapture>;
  context(): Promise<string>;
  input(input: LocalComputerInput, frame: LocalCapture, check: () => unknown): Promise<unknown>;
  openApp(app: string): Promise<unknown>;
  release(): Promise<unknown>;
  hide(): Promise<unknown>;
}
export type WindowDriver = Pick<LocalDriver, 'capture' | 'context' | 'input'> & {
  name: string;
  interrupt?: () => unknown;
};
export interface LocalBinding {
  bot: string;
  runId: string;
  model: string;
  modelRevision: number;
  session: string;
}
export class LocalComputer {
  private session?: LocalComputerSession;
  private consent?: Extract<LocalComputerCommand, { type: 'local.connect' }>;
  private window?: WindowDriver;
  private readonly retired = new Set<string>();
  private observation?: {
    id: string;
    run: string;
    session: string;
    revision: number;
    frame: LocalCapture;
    at: number;
  };
  private last?: LocalComputerFrame;
  private run?: string;
  private started = false;
  private readonly cancelled = new Set<string>();
  private closed = false;
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly driver: LocalDriver,
    readonly shortcut: boolean,
  ) {}

  status(): LocalComputerStatus {
    return {
      platform: this.driver.platform,
      available: this.driver.supported && !this.closed,
      permissions: this.driver.permissions(),
      shortcut: this.shortcut,
      ...(this.session ? { session: { ...this.session } } : {}),
    };
  }
  private requirePermissions() {
    if (this.closed) throw new Error('LOCAL_CLIENT_UNAVAILABLE');
    if (!this.driver.supported) throw new Error('LOCAL_PLATFORM_UNSUPPORTED');
    const permissions = this.driver.permissions();
    if (!permissions.screen || !permissions.accessibility) {
      this.clear();
      throw new Error(
        !permissions.screen ? 'LOCAL_SCREEN_PERMISSION' : 'LOCAL_ACCESSIBILITY_PERMISSION',
      );
    }
  }
  private clear() {
    const hadSession = !!this.session;
    this.generation++;
    this.window?.interrupt?.();
    this.session = undefined;
    this.consent = undefined;
    this.window = undefined;
    this.observation = undefined;
    this.last = undefined;
    this.run = undefined;
    this.started = false;
    if (hadSession) this.enqueue(() => this.driver.release()).catch(() => {});
  }
  async connect(request: Extract<LocalComputerCommand, { type: 'local.connect' }>) {
    const generation = this.generation;
    return this.enqueue(async () => {
      this.requirePermissions();
      if (generation !== this.generation) throw new Error('LOCAL_CONSENT_EXPIRED');
      if (!this.shortcut) throw new Error('LOCAL_SHORTCUT_UNAVAILABLE');
      if (this.consent?.id === request.id) {
        if (JSON.stringify(this.consent) !== JSON.stringify(request))
          throw new Error('LOCAL_CONSENT_CONFLICT');
        return this.status();
      }
      if (this.session) throw new Error('LOCAL_COMPUTER_BUSY');
      if (this.retired.has(request.id)) throw new Error('LOCAL_CONSENT_EXPIRED');
      if (this.retired.size >= 200) throw new Error('LOCAL_SESSION_LIMIT');
      const window = request.window ? await this.driver.forWindow?.(request.window) : undefined;
      // Revocation and permission changes can occur while the SDK looks up the window.
      if (generation !== this.generation) throw new Error('LOCAL_CONSENT_EXPIRED');
      this.requirePermissions();
      if (request.window && !window) throw new Error('LOCAL_PLATFORM_UNSUPPORTED');
      if (!window) this.driver.prepare?.();
      this.retired.add(request.id);
      this.cancelled.clear();
      this.consent = structuredClone(request);
      this.window = window;
      this.session = {
        id: randomUUID(),
        bot: request.bot,
        revision: 1,
        owner: 'agent',
        model: request.model,
        modelRevision: request.modelRevision,
        ...(window ? { window: window.name } : {}),
      };
      return this.status();
    });
  }
  private current(id: string, revision: number) {
    if (!this.session || this.session.id !== id || this.session.revision !== revision)
      throw new Error('LOCAL_SESSION_STALE');
    return this.session;
  }
  async pause(id: string, revision: number) {
    const session = this.current(id, revision);
    session.owner = 'human';
    session.revision++;
    this.window?.interrupt?.();
    this.observation = undefined;
    await this.enqueue(() => this.driver.release());
    return this.status();
  }
  async interrupt() {
    const current = this.session;
    if (current?.owner === 'agent') return this.pause(current.id, current.revision);
    return this.status();
  }
  async interruptForeground() {
    if (!this.window) return this.interrupt();
    return this.status();
  }
  async resume(id: string, revision: number) {
    const session = this.current(id, revision);
    this.requirePermissions();
    if (!this.window) await this.driver.hide();
    this.current(id, revision);
    session.owner = 'agent';
    session.revision++;
    this.started = true;
    this.observation = undefined;
    return this.status();
  }
  async disconnect(id: string, revision: number) {
    this.current(id, revision);
    // Fence work before awaiting native IO; queued events must not survive a disconnect.
    this.clear();
    await this.enqueue(() => this.driver.release());
    return this.status();
  }
  preview(id: string, revision: number) {
    this.current(id, revision);
    return this.last;
  }
  async cancel(runId: string, session?: string) {
    if (session && this.session?.id !== session) return;
    if (this.cancelled.size >= 4096) {
      await this.revoke();
      return;
    }
    this.cancelled.add(runId);
    if (this.run !== runId) return;
    this.window?.interrupt?.();
    this.run = undefined;
    this.observation = undefined;
    await this.enqueue(() => this.driver.release());
  }
  private authorize(binding: LocalBinding) {
    this.requirePermissions();
    const session = this.session;
    if (!session || session.bot !== binding.bot) throw new Error('LOCAL_NOT_CONNECTED');
    if (binding.session !== session.id) throw new Error('LOCAL_SESSION_STALE');
    if (session.model !== binding.model || session.modelRevision !== binding.modelRevision) {
      this.clear();
      throw new Error('LOCAL_MODEL_CHANGED');
    }
    if (session.owner !== 'agent') throw new Error('LOCAL_PAUSED');
    if (this.cancelled.has(binding.runId)) throw new Error('LOCAL_RUN_STALE');
    if (!validAgentId(binding.runId)) throw new Error('LOCAL_INVALID_REQUEST');
    return session;
  }
  private enqueue<T>(action: () => Promise<T>) {
    const next = this.tail.then(action);
    this.tail = next.catch(() => {});
    return next;
  }
  private async take(binding: LocalBinding): Promise<LocalComputerFrame> {
    const session = this.authorize(binding);
    const id = session.id,
      revision = session.revision;
    this.run = binding.runId;
    this.observation = undefined;
    const driver = this.window ?? this.driver;
    if (!this.started) {
      this.started = true;
      if (!this.window) await this.driver.hide();
    }
    let frame: LocalCapture;
    try {
      frame = await driver.capture();
    } catch (error) {
      // A pause can change focus while capture is pending; report that control fence before a camera error.
      this.authorize(binding);
      this.current(id, revision);
      throw error;
    }
    this.authorize(binding);
    this.current(id, revision);
    const observation = randomUUID();
    this.run = binding.runId;
    this.observation = {
      id: observation,
      run: binding.runId,
      session: id,
      revision,
      frame,
      at: Date.now(),
    };
    this.last = {
      session: id,
      observation,
      bot: binding.bot,
      runId: binding.runId,
      width: frame.width,
      height: frame.height,
      image: frame.image,
    };
    return this.last;
  }
  async capture(binding: LocalBinding) {
    this.authorize(binding);
    return this.enqueue(() => this.take(binding));
  }
  private observed(binding: LocalBinding, observation: string) {
    const session = this.authorize(binding),
      saved = this.observation;
    if (
      !saved ||
      saved.id !== observation ||
      saved.run !== binding.runId ||
      saved.session !== session.id ||
      saved.revision !== session.revision ||
      Date.now() - saved.at > 60_000
    )
      throw new Error('LOCAL_OBSERVATION_STALE');
    return { session: { ...session }, saved };
  }
  async act(request: LocalBinding & { observation: string; actions: unknown[] }) {
    if (
      !Array.isArray(request.actions) ||
      !request.actions.length ||
      request.actions.length > 4 ||
      !request.actions.every(isLocalComputerInput)
    )
      throw new Error('LOCAL_INVALID_REQUEST');
    const { session, saved } = this.observed(request, request.observation);
    return this.enqueue(async () => {
      this.observed(request, request.observation);
      const driver = this.window ?? this.driver;
      this.observation = undefined;
      const check = () => {
        this.authorize(request);
        this.current(session.id, session.revision);
        if (this.run !== request.runId) throw new Error('LOCAL_RUN_STALE');
      };
      try {
        for (const input of request.actions as LocalComputerInput[]) {
          check();
          if ((await driver.context()) !== saved.frame.context)
            throw new Error('LOCAL_SCREEN_CHANGED');
          if (
            'x' in input &&
            input.x !== undefined &&
            (input.x >= saved.frame.width || (input.y ?? 0) >= saved.frame.height)
          )
            throw new Error('LOCAL_INVALID_COORDINATE');
          await driver.input(input, saved.frame, check);
        }
        check();
        return await this.take(request);
      } catch (error) {
        await this.driver.release();
        // Input failures must not hide a newer pause or revocation.
        this.authorize(request);
        this.current(session.id, session.revision);
        throw error;
      }
    });
  }
  async openApp(request: LocalBinding & { observation: string; app: string }) {
    if (!['terminal', 'files', 'editor', 'browser'].includes(request.app))
      throw new Error('LOCAL_INVALID_REQUEST');
    const { session } = this.observed(request, request.observation);
    if (this.window) throw new Error('LOCAL_WINDOW_SCOPED');
    return this.enqueue(async () => {
      this.observed(request, request.observation);
      this.observation = undefined;
      await this.driver.openApp(request.app);
      this.authorize(request);
      this.current(session.id, session.revision);
      return this.take(request);
    });
  }
  async revoke() {
    this.clear();
    await this.enqueue(() => this.driver.release());
  }
  async requestPermissions() {
    await this.driver.requestPermissions?.();
    return this.status();
  }
  windows() {
    this.requirePermissions();
    return this.driver.windows?.() ?? [];
  }
  async close() {
    this.closed = true;
    await this.revoke();
    await this.driver.close?.();
  }
}

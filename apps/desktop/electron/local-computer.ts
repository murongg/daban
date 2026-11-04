import { randomUUID } from 'node:crypto';
import {
  isLocalComputerInput,
  type LocalComputerCommand,
  type LocalComputerFrame,
  type LocalComputerInput,
  type LocalComputerSession,
  type LocalComputerStatus,
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
  platform: 'darwin' | 'win32' | 'linux' | 'unsupported';
  reason?: string;
  prepare?: () => undefined;
  requestPermissions?: () => Promise<unknown>;
  permissions(): { screen: boolean; accessibility: boolean };
  capture(): Promise<LocalCapture>;
  context(): Promise<string>;
  input(input: LocalComputerInput, frame: LocalCapture, check: () => unknown): Promise<unknown>;
  openApp(app: string): Promise<unknown>;
  release(): Promise<unknown>;
  hide(): Promise<unknown>;
}
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
  private humanObservation?: {
    id: string;
    session: string;
    revision: number;
    frame: LocalCapture;
    at: number;
  };
  private run?: string;
  private started = false;
  private readonly cancelled = new Set<string>();
  private closed = false;
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
      ...(this.driver.reason ? { error: this.driver.reason } : {}),
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
    this.session = undefined;
    this.consent = undefined;
    this.observation = undefined;
    this.humanObservation = undefined;
    this.last = undefined;
    this.run = undefined;
    this.started = false;
    if (hadSession) this.enqueue(() => this.driver.release()).catch(() => {});
  }
  async connect(request: Extract<LocalComputerCommand, { type: 'local.connect' }>) {
    this.requirePermissions();
    this.driver.prepare?.();
    if (!this.shortcut) throw new Error('LOCAL_SHORTCUT_UNAVAILABLE');
    if (this.consent?.id === request.id) {
      if (JSON.stringify(this.consent) !== JSON.stringify(request))
        throw new Error('LOCAL_CONSENT_CONFLICT');
      return this.status();
    }
    if (this.session) throw new Error('LOCAL_COMPUTER_BUSY');
    if (this.retired.has(request.id)) throw new Error('LOCAL_CONSENT_EXPIRED');
    if (this.retired.size >= 200) throw new Error('LOCAL_SESSION_LIMIT');
    this.retired.add(request.id);
    this.cancelled.clear();
    this.consent = structuredClone(request);
    this.session = {
      id: randomUUID(),
      bot: request.bot,
      revision: 1,
      owner: 'agent',
      model: request.model,
      modelRevision: request.modelRevision,
    };
    return this.status();
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
    this.observation = undefined;
    this.humanObservation = undefined;
    await this.enqueue(() => this.driver.release());
    return this.status();
  }
  async interrupt() {
    const current = this.session;
    if (current?.owner === 'agent') return this.pause(current.id, current.revision);
    return this.status();
  }
  async resume(id: string, revision: number) {
    const session = this.current(id, revision);
    this.requirePermissions();
    await this.driver.hide();
    this.current(id, revision);
    session.owner = 'agent';
    session.revision++;
    this.started = true;
    this.observation = undefined;
    this.humanObservation = undefined;
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
  private human(id: string, revision: number) {
    this.requirePermissions();
    const session = this.current(id, revision);
    if (session.owner !== 'human') throw Error('LOCAL_NOT_HUMAN');
    return session;
  }
  private async humanFrame(id: string, revision: number): Promise<LocalComputerFrame> {
    this.human(id, revision);
    this.humanObservation = undefined;
    const frame = await this.driver.capture();
    const session = this.human(id, revision);
    const observation = randomUUID();
    this.humanObservation = { id: observation, session: id, revision, frame, at: Date.now() };
    return {
      session: id,
      observation,
      bot: session.bot,
      runId: 'human',
      width: frame.width,
      height: frame.height,
      image: frame.image,
    };
  }
  async observeHuman(id: string, revision: number) {
    this.human(id, revision);
    return this.enqueue(() => this.humanFrame(id, revision));
  }
  async inputHuman(id: string, revision: number, observation: string, input: unknown) {
    if (!isLocalComputerInput(input)) throw Error('LOCAL_INVALID_REQUEST');
    this.human(id, revision);
    const saved = this.humanObservation;
    if (
      !saved ||
      saved.id !== observation ||
      saved.session !== id ||
      saved.revision !== revision ||
      Date.now() - saved.at > 60000
    )
      throw Error('LOCAL_OBSERVATION_STALE');
    return this.enqueue(async () => {
      this.human(id, revision);
      if (this.humanObservation?.id !== observation) throw Error('LOCAL_OBSERVATION_STALE');
      // Consume before native IO; an uncertain delivery must not authorize a second input.
      this.humanObservation = undefined;
      const check = () => {
        this.human(id, revision);
      };
      try {
        if ((await this.driver.context()) !== saved.frame.context)
          throw Error('LOCAL_SCREEN_CHANGED');
        if (
          'x' in input &&
          input.x !== undefined &&
          (input.x >= saved.frame.width || (input.y ?? 0) >= saved.frame.height)
        )
          throw Error('LOCAL_INVALID_COORDINATE');
        await this.driver.input(input, saved.frame, check);
        check();
        return await this.humanFrame(id, revision);
      } catch (error) {
        await this.driver.release();
        check();
        throw error;
      }
    });
  }
  async cancel(runId: string, session?: string) {
    if (session && this.session?.id !== session) return;
    if (this.cancelled.size >= 4096) {
      await this.revoke();
      return;
    }
    this.cancelled.add(runId);
    if (this.run !== runId) return;
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
    if (!this.started) {
      this.started = true;
      await this.driver.hide();
    }
    let frame: LocalCapture;
    try {
      frame = await this.driver.capture();
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
      this.observation = undefined;
      const check = () => {
        this.authorize(request);
        this.current(session.id, session.revision);
        if (this.run !== request.runId) throw new Error('LOCAL_RUN_STALE');
      };
      try {
        for (const input of request.actions as LocalComputerInput[]) {
          check();
          if ((await this.driver.context()) !== saved.frame.context)
            throw new Error('LOCAL_SCREEN_CHANGED');
          if (
            'x' in input &&
            input.x !== undefined &&
            (input.x >= saved.frame.width || (input.y ?? 0) >= saved.frame.height)
          )
            throw new Error('LOCAL_INVALID_COORDINATE');
          await this.driver.input(input, saved.frame, check);
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
  async close() {
    this.closed = true;
    await this.revoke();
  }
}

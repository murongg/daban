import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  isRemoteCommand,
  isRemoteMediaRequest,
  isRemoteRpcRequest,
  isRemoteSnapshotCapabilities,
  isReviewResponse,
  type PeerEvent,
  parseRemoteInvitation,
  parseRuntimeCommand,
  type RemoteHost,
  type RemoteIdentity,
  type RemoteInvitation,
  type RemoteMediaRequest,
  type RemotePairRequest,
  type RemotePeerPort,
  type RemoteRpcReply,
  type RemoteRpcRequest,
  type RemoteSignal,
  type RemoteState,
  type RemoteViewer,
  type RuntimeCommand,
  remoteInvitation,
  remoteServer,
  remoteSnapshotFor,
  type SnapshotAccept,
  supportedSnapshotCapabilities,
  validAgentId,
} from '@daban/protocol';
import { remoteProof, validRemoteIdentity, verifyRemoteProof } from './remote-crypto.js';
import { RemoteGateway } from './remote-gateway.js';
import { RemoteKeys } from './remote-identity.js';
import { SignalConnection } from './remote-signal.js';
import { RemoteStore } from './remote-store.js';

interface Session {
  id: string;
  device: RemoteIdentity;
  server: string;
  workspace: string;
  role: 'host' | 'controller';
  connected: boolean;
  purpose?: 'media';
  parent?: string;
  peer?: RemotePeerPort;
  captureRequested?: boolean;
  snapshotAccept?: SnapshotAccept;
  snapshotHintSent?: true;
}
interface MediaPlan {
  parent: string;
  device: string;
  request: RemoteMediaRequest;
  port: RemotePeerPort;
  expires: number;
}
interface Waiting<T> {
  resolve(value: T): unknown;
  reject(error: Error): unknown;
  timer: ReturnType<typeof setTimeout>;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function code(error: unknown) {
  return error instanceof Error && /^[A-Z_]{1,100}$/.test(error.message)
    ? error.message
    : 'REMOTE_OPERATION_FAILED';
}
function validateReviewReply(command: RuntimeCommand, value: unknown) {
  if (
    (command.type === 'files.review.read' ||
      command.type === 'files.review.diff' ||
      command.type === 'files.review.current') &&
    !isReviewResponse(command, value)
  )
    throw Error('INVALID_RUNTIME_STATE');
}
export class RemoteAccess {
  readonly ready: Promise<unknown>;
  private keys!: RemoteKeys;
  private store!: RemoteStore;
  private gateway!: RemoteGateway;
  private readonly signals = new Map<string, SignalConnection>();
  private readonly sessions = new Map<string, Session>();
  private readonly hosts = new Map<string, RemoteHost>();
  private readonly requests = new Map<string, Waiting<unknown> & { session: string }>();
  private readonly connecting = new Map<string, Waiting<undefined>>();
  private readonly hostConnections = new Map<string, Promise<Session>>();
  private readonly pairing = new Map<
    string,
    Waiting<undefined> & { invitation: RemoteInvitation }
  >();
  private readonly pending = new Map<string, RemotePairRequest & { server: string }>();
  private readonly listeners = new Set<(state: RemoteState) => unknown>();
  private readonly mediaPlans = new Map<string, MediaPlan>();
  private readonly extraPorts = new Map<RemotePeerPort, () => unknown>();
  private viewer?: RemoteViewer;
  private selected: string | null = null;
  private enabled = false;
  private server = '';
  private invitation?: RemoteInvitation;
  private sequence = 0;
  private stopped = false;
  private signalTail: Promise<unknown> = Promise.resolve();
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private unsubscribe?: () => unknown;
  constructor(
    private readonly options: {
      directory: string;
      name: string;
      platform: string;
      peer: RemotePeerPort;
      dispatch(command: RuntimeCommand, device?: RemoteIdentity): Promise<unknown>;
      authorize?(device: RemoteIdentity, command: RuntimeCommand): Promise<unknown>;
      revoke?(device: string): Promise<unknown>;
      snapshot?(value: unknown, host: string): unknown;
      media?(device: RemoteIdentity, request: RemoteMediaRequest): Promise<RemotePeerPort>;
      currentMedia?(request: RemoteMediaRequest): boolean;
    },
  ) {
    this.ready = this.load();
  }
  private async load() {
    this.keys = await RemoteKeys.open(this.options.directory, this.options.name);
    this.store = new RemoteStore({
      file: path.join(this.options.directory, 'remote.sqlite'),
      host: this.keys.identity.id,
      workspace: this.keys.identity.id,
    });
    await this.store.ready;
    this.gateway = new RemoteGateway(
      this.store,
      (command, device) =>
        this.options.dispatch(
          command,
          device ? this.store.device(device, 'controller')?.identity : undefined,
        ),
      this.options.authorize
        ? async (id, command) => {
            const device = this.store.device(id, 'controller');
            if (!device) throw Error('REMOTE_UNAUTHORIZED');
            await this.options.authorize!(device.identity, command);
          }
        : undefined,
    );
    this.enabled = this.store.setting('hosting') === 'true';
    this.server = this.store.setting('server') ?? '';
    for (const device of this.store.devices('host'))
      this.hosts.set(device.identity.id, {
        identity: device.identity,
        server: device.server,
        workspace: device.workspace,
        platform: device.platform,
        state: 'offline',
        transport: 'unknown',
      });
    this.unsubscribe = this.options.peer.subscribe((event) => {
      this.event(event).catch(() => {});
    });
    this.poll = setInterval(() => {
      this.publishSnapshot().catch(() => {});
    }, 1000);
    this.poll.unref();
    if (this.enabled && this.server)
      this.connection(this.server)
        .start()
        .catch(() => this.changed());
  }
  state(): RemoteState {
    if (!this.keys) throw Error('REMOTE_NOT_READY');
    for (const [id, request] of this.pending)
      if (request.expiresAt <= Date.now()) this.pending.delete(id);
    return structuredClone({
      selected: this.selected,
      identity: this.keys.identity,
      hosting: this.enabled,
      server: this.server,
      hosts: [...this.hosts.values()],
      pending: [...this.pending.values()].map(({ id, identity, expiresAt }) => ({
        id,
        identity,
        expiresAt,
      })),
      controllers: this.controllers(),
      ...(this.viewer ? { viewer: this.viewer } : {}),
      ...(this.invitation && this.invitation.expiresAt > Date.now()
        ? { invitation: remoteInvitation(this.invitation) }
        : {}),
    });
  }
  controllers() {
    return this.store.devices('controller').map((device) => device.identity);
  }
  subscribe(listener: (state: RemoteState) => unknown) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private changed() {
    if (this.stopped) return;
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
  private connection(server: string) {
    const existing = this.signals.get(server);
    if (existing) return existing;
    if (this.signals.size >= 16) throw Error('REMOTE_SERVER_LIMIT');
    const connection = new SignalConnection({
      server,
      keys: this.keys,
      signal: (message) => {
        this.signalTail = this.signalTail
          .catch(() => {})
          .then(() => this.signal(server, message))
          .catch(() => {});
      },
      changed: () => this.changed(),
    });
    this.signals.set(server, connection);
    return connection;
  }
  async command(command: unknown): Promise<RemoteState> {
    await this.ready;
    if (this.stopped) throw Error('REMOTE_CONNECTION_CLOSED');
    if (!isRemoteCommand(command)) throw Error('REMOTE_INVALID_COMMAND');
    switch (command.type) {
      case 'view': {
        if (this.selected !== command.host) throw Error('REMOTE_WRONG_TARGET');
        if (this.viewer) await this.drop(this.viewer.id);
        const parent = await this.connect(command.host);
        const response = await this.rpc(parent, 'media.open', { ...command.request });
        if (!record(response) || !validAgentId(response.id) || !response.id.startsWith('media_'))
          throw Error('REMOTE_INVALID_MEDIA');
        if (this.selected !== command.host) {
          await this.rpc(parent, 'media.close', { id: response.id });
          throw Error('REMOTE_WRONG_TARGET');
        }
        const session: Session = {
          ...parent,
          id: response.id,
          purpose: 'media',
          parent: parent.id,
          connected: false,
        };
        this.sessions.set(session.id, session);
        this.viewer = {
          id: session.id,
          host: command.host,
          bot: command.request.bot,
          surface: command.request.surface,
          binding:
            command.request.surface === 'native'
              ? command.request.session
              : command.request.instance,
          phase: 'connecting',
        };
        const ice = await this.connection(session.server).start();
        try {
          await this.options.peer.open(session.id, true, ice, true);
        } catch (error) {
          await this.drop(session.id, true, code(error));
          throw error;
        }
        break;
      }
      case 'view.close': {
        if (this.viewer?.id === command.id) {
          await this.drop(command.id);
          this.viewer = undefined;
        }
        break;
      }
      case 'status':
        break;
      case 'host': {
        this.server = remoteServer(command.server);
        this.enabled = command.enabled;
        this.store.saveSetting('server', this.server);
        this.store.saveSetting('hosting', String(this.enabled));
        if (this.enabled) await this.connection(this.server).start();
        else {
          this.invitation = undefined;
          this.pending.clear();
          for (const session of [...this.sessions.values()])
            if (session.role === 'host') await this.drop(session.id);
        }
        break;
      }
      case 'invite': {
        if (!this.enabled || !this.server) throw Error('REMOTE_HOST_DISABLED');
        await this.connection(this.server).start();
        this.invitation = {
          version: 1,
          host: this.keys.identity,
          server: this.server,
          code: randomBytes(32).toString('base64url'),
          expiresAt: Date.now() + 300_000,
        };
        break;
      }
      case 'pair':
        await this.pair(command.invitation);
        break;
      case 'approve':
        await this.approve(command.id, command.accepted);
        break;
      case 'select': {
        const previous = this.selected;
        if (command.host !== null && !this.hosts.has(command.host))
          throw Error('REMOTE_UNKNOWN_HOST');
        this.selected = command.host;
        this.changed();
        if (command.host !== null) await this.connect(command.host);
        if (previous && previous !== command.host) {
          for (const session of [...this.sessions.values()])
            if (session.role === 'controller' && session.device.id === previous)
              await this.drop(session.id);
        }
        break;
      }
      case 'revoke': {
        await this.options.revoke?.(command.device);
        this.store.revoke(command.device);
        this.hosts.delete(command.device);
        if (this.selected === command.device) this.selected = null;
        for (const session of [...this.sessions.values()])
          if (session.device.id === command.device) await this.drop(session.id);
        break;
      }
    }
    this.changed();
    return this.state();
  }
  private wait<T>(map: Map<string, Waiting<T>>, id: string, timeout: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        map.delete(id);
        reject(Error('REMOTE_TIMEOUT'));
      }, timeout);
      timer.unref();
      map.set(id, { resolve, reject, timer });
    });
  }
  private async pair(text: string) {
    const invitation = parseRemoteInvitation(text);
    if (!validRemoteIdentity(invitation.host)) throw Error('REMOTE_INVALID_IDENTITY');
    const connection = this.connection(invitation.server);
    await connection.start();
    const id = randomUUID();
    const result = new Promise<undefined>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pairing.delete(id);
        reject(Error('REMOTE_PAIR_TIMEOUT'));
      }, 120_000);
      timer.unref();
      this.pairing.set(id, { invitation, resolve, reject, timer });
    });
    connection.send(invitation.host.id, id, { type: 'pair', code: invitation.code });
    await result;
  }
  private async approve(id: string, accepted: boolean) {
    const request = this.pending.get(id);
    if (!request || request.expiresAt <= Date.now()) throw Error('REMOTE_PAIR_EXPIRED');
    this.pending.delete(id);
    if (accepted) {
      this.store.pair(request.identity, 'controller');
      this.invitation = undefined;
      this.pending.clear();
    }
    const workspace = this.keys.identity.id;
    const platform = this.options.platform;
    const signature = this.keys.sign(
      remoteProof('pair', [
        this.keys.identity.id,
        request.identity.id,
        id,
        String(accepted),
        workspace,
        platform,
      ]),
    );
    this.connection(request.server).send(request.identity.id, id, {
      type: 'paired',
      accepted,
      signature,
      workspace,
      platform,
    });
  }
  private connect(hostId: string): Promise<Session> {
    const active = this.hostConnections.get(hostId);
    if (active) return active;
    const pending = this.connectHost(hostId).finally(() => {
      if (this.hostConnections.get(hostId) === pending) this.hostConnections.delete(hostId);
    });
    this.hostConnections.set(hostId, pending);
    return pending;
  }
  private async connectHost(hostId: string) {
    const active = [...this.sessions.values()].find(
      (session) =>
        session.role === 'controller' &&
        session.purpose !== 'media' &&
        session.device.id === hostId &&
        session.connected,
    );
    if (active) return active;
    const host = this.hosts.get(hostId);
    if (!host) throw Error('REMOTE_UNKNOWN_HOST');
    host.state = 'connecting';
    delete host.error;
    this.changed();
    const signal = this.connection(host.server);
    const ice = await signal.start();
    const id = randomUUID();
    const session: Session = {
      id,
      device: host.identity,
      server: host.server,
      workspace: host.workspace,
      role: 'controller',
      connected: false,
    };
    this.sessions.set(id, session);
    const ready = this.wait(this.connecting, id, 30_000);
    try {
      await this.options.peer.open(id, true, ice);
      await ready;
      return session;
    } catch (error) {
      await this.drop(id);
      host.error = code(error);
      this.changed();
      throw error;
    }
  }
  private async signal(server: string, message: Extract<RemoteSignal, { type: 'signal' }>) {
    if (!('from' in message) || this.stopped || !validRemoteIdentity(message.from)) return;
    const { session: id, from, payload } = message;
    if (payload.type === 'pair') {
      const invitation = this.invitation;
      if (
        !this.enabled ||
        server !== this.server ||
        !invitation ||
        invitation.expiresAt <= Date.now() ||
        this.pending.size >= 8
      )
        return;
      const a = Buffer.from(payload.code),
        b = Buffer.from(invitation.code);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return;
      this.pending.set(id, {
        id,
        identity: from,
        server,
        expiresAt: Math.min(invitation.expiresAt, Date.now() + 120_000),
      });
      this.changed();
      return;
    }
    if (payload.type === 'paired') {
      const pending = this.pairing.get(id);
      if (
        !pending ||
        pending.invitation.host.id !== from.id ||
        server !== pending.invitation.server
      )
        return;
      if (
        !verifyRemoteProof(
          pending.invitation.host,
          remoteProof('pair', [
            from.id,
            this.keys.identity.id,
            id,
            String(payload.accepted),
            payload.workspace,
            payload.platform,
          ]),
          payload.signature,
        )
      )
        return;
      clearTimeout(pending.timer);
      this.pairing.delete(id);
      if (!payload.accepted) {
        pending.reject(Error('REMOTE_PAIR_REFUSED'));
        return;
      }
      this.store.pair(pending.invitation.host, 'host', {
        server,
        workspace: payload.workspace,
        platform: payload.platform,
      });
      this.hosts.set(from.id, {
        identity: pending.invitation.host,
        server,
        workspace: payload.workspace,
        platform: payload.platform,
        state: 'offline',
        transport: 'unknown',
      });
      pending.resolve(undefined);
      this.changed();
      return;
    }
    let session = this.sessions.get(id);
    if (!session) {
      const plan = this.mediaPlans.get(id);
      if (
        !this.enabled ||
        payload.type !== 'offer' ||
        server !== this.server ||
        !this.store.device(from.id, 'controller')
      )
        return;
      if (
        id.startsWith('media_') &&
        (!plan ||
          plan.device !== from.id ||
          plan.expires <= Date.now() ||
          !this.sessions.get(plan.parent)?.connected)
      )
        return;
      if (this.sessions.size >= 16) return;
      if (
        !verifyRemoteProof(
          from,
          remoteProof('sdp', [id, from.id, this.keys.identity.id, payload.type, payload.sdp]),
          payload.signature,
        )
      )
        return;
      session = {
        id,
        device: from,
        server,
        workspace: this.keys.identity.id,
        role: 'host',
        connected: false,
        ...(plan ? { purpose: 'media' as const, parent: plan.parent, peer: plan.port } : {}),
      };
      this.sessions.set(id, session);
      const ice = await this.connection(server).start();
      await this.port(session).open(id, false, ice, !!plan);
      if (plan) plan.expires = Number.MAX_SAFE_INTEGER;
    }
    if (session.device.id !== from.id || session.server !== server) return;
    if (payload.type === 'close') {
      await this.drop(id, false, payload.error);
      return;
    }
    if (payload.type === 'offer' || payload.type === 'answer') {
      if (
        !verifyRemoteProof(
          session.device,
          remoteProof('sdp', [id, from.id, this.keys.identity.id, payload.type, payload.sdp]),
          payload.signature,
        )
      ) {
        await this.drop(id);
        return;
      }
      await this.port(session).signal(id, { type: payload.type, sdp: payload.sdp });
    } else if (payload.type === 'candidate') await this.port(session).signal(id, payload);
  }
  private async event(event: Exclude<PeerEvent, { type: 'result' }>) {
    const session = this.sessions.get(event.session);
    if (!session || this.stopped) return;
    if (event.type === 'signal') {
      const payload = event.payload;
      const signed =
        payload.type === 'candidate'
          ? payload
          : {
              ...payload,
              signature: this.keys.sign(
                remoteProof('sdp', [
                  session.id,
                  this.keys.identity.id,
                  session.device.id,
                  payload.type,
                  payload.sdp,
                ]),
              ),
            };
      this.connection(session.server).send(session.device.id, session.id, signed);
    } else if (event.type === 'track') {
      if (
        session.purpose === 'media' &&
        session.role === 'controller' &&
        this.viewer?.id === session.id
      ) {
        this.viewer.phase = 'ready';
        this.changed();
      }
    } else if (event.type === 'state') {
      if (event.state !== 'connected') {
        await this.drop(session.id, true, event.error ?? 'REMOTE_SESSION_CLOSED');
        return;
      }
      session.connected = true;
      if (session.purpose === 'media') {
        if (session.role === 'host' && !session.captureRequested) {
          session.captureRequested = true;
          try {
            const port = this.port(session);
            if (!port.capture) throw Error('REMOTE_MEDIA_UNAVAILABLE');
            await port.capture(session.id);
          } catch (error) {
            await this.drop(session.id, true, code(error));
          }
        }
        this.changed();
        return;
      }
      const host = this.hosts.get(session.device.id);
      if (session.role === 'controller' && host) {
        host.state = 'connected';
        host.transport = event.transport ?? 'unknown';
        if (!session.snapshotHintSent) {
          session.snapshotHintSent = true;
          // This is a parser hint on this connection only; no acknowledgement or permission is implied.
          await this.port(session)
            .send(
              session.id,
              JSON.stringify({
                type: 'snapshot-capabilities',
                host: session.device.id,
                workspace: session.workspace,
                accept: supportedSnapshotCapabilities,
              }),
            )
            .catch(() => undefined);
        }
      }
      const pending = this.connecting.get(session.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.connecting.delete(session.id);
        pending.resolve(undefined);
      }
      this.changed();
    } else if (session.purpose === 'media')
      await this.drop(session.id, true, 'REMOTE_MEDIA_CHANNEL_FORBIDDEN');
    else await this.message(session, event.data);
  }
  private port(session: Session) {
    return session.peer ?? this.options.peer;
  }
  private async openMedia(session: Session, request: unknown) {
    if (!isRemoteMediaRequest(request) || !this.options.media)
      throw Error('REMOTE_MEDIA_UNAVAILABLE');
    if (this.mediaPlans.size >= 16) throw Error('REMOTE_SESSION_LIMIT');
    const port = await this.options.media(session.device, request);
    if (this.sessions.get(session.id) !== session || !this.enabled)
      throw Error('REMOTE_SESSION_CLOSED');
    const id = `media_${randomUUID()}`;
    this.mediaPlans.set(id, {
      parent: session.id,
      device: session.device.id,
      request,
      port,
      expires: Date.now() + 60000,
    });
    if (port !== this.options.peer && !this.extraPorts.has(port)) {
      this.extraPorts.set(
        port,
        port.subscribe((event) => {
          // A guest media process cannot impersonate a trusted business connection.
          if (this.sessions.get(event.session)?.peer === port) this.event(event).catch(() => {});
        }),
      );
    }
    return { id };
  }
  async stopMedia(surface?: RemoteMediaRequest['surface']) {
    for (const [id, plan] of [...this.mediaPlans]) {
      if (surface && plan.request.surface !== surface) continue;
      this.mediaPlans.delete(id);
      if (this.sessions.has(id)) await this.drop(id);
      else await plan.port.close(id).catch(() => {});
    }
  }
  private async message(session: Session, text: string) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      await this.drop(session.id);
      return;
    }
    if (!record(value)) return;
    if (value.type === 'snapshot-capabilities') {
      if (
        session.role === 'host' &&
        session.connected &&
        this.sessions.get(session.id) === session &&
        this.store.device(session.device.id, 'controller') &&
        isRemoteSnapshotCapabilities(value) &&
        value.host === this.keys.identity.id &&
        value.workspace === session.workspace
      )
        session.snapshotAccept = structuredClone(value.accept);
      return;
    }
    if (value.type === 'request' && session.role === 'host' && isRemoteRpcRequest(value)) {
      let reply: RemoteRpcReply;
      try {
        if (
          !this.store.device(session.device.id, 'controller') ||
          value.host !== this.keys.identity.id ||
          value.workspace !== session.workspace
        )
          throw Error('REMOTE_WRONG_TARGET');
        let result: unknown;
        if (value.method === 'media.open') result = await this.openMedia(session, value.params);
        else if (value.method === 'media.close') {
          if (
            Object.keys(value.params).some((key) => key !== 'id') ||
            !validAgentId(value.params.id)
          )
            throw Error('REMOTE_INVALID_MEDIA');
          const plan = this.mediaPlans.get(value.params.id);
          if (!plan || plan.parent !== session.id) throw Error('REMOTE_INVALID_MEDIA');
          this.mediaPlans.delete(value.params.id);
          await this.drop(value.params.id);
          result = { closed: true };
        } else {
          result = await this.gateway.invoke(session.device.id, session.id, value);
          validateReviewReply(parseRuntimeCommand({ type: value.method, ...value.params }), result);
        }
        reply = {
          type: 'reply',
          id: value.id,
          host: this.keys.identity.id,
          workspace: session.workspace,
          ok: true,
          value:
            value.method === 'status' || value.method === 'connect'
              ? remoteSnapshotFor(result, session.snapshotAccept)
              : result,
        };
      } catch (error) {
        reply = {
          type: 'reply',
          id: value.id,
          host: this.keys.identity.id,
          workspace: session.workspace,
          ok: false,
          error: code(error),
        };
      }
      if (this.sessions.get(session.id) === session)
        await this.port(session).send(session.id, JSON.stringify(reply));
    } else if (
      value.type === 'reply' &&
      session.role === 'controller' &&
      typeof value.id === 'string' &&
      value.host === session.device.id &&
      value.workspace === session.workspace
    ) {
      const pending = this.requests.get(value.id);
      if (!pending || pending.session !== session.id) return;
      clearTimeout(pending.timer);
      this.requests.delete(value.id);
      if (value.ok === true) pending.resolve(value.value);
      else
        pending.reject(
          Error(
            typeof value.error === 'string' && /^[A-Z_]+$/.test(value.error)
              ? value.error
              : 'REMOTE_OPERATION_FAILED',
          ),
        );
    } else if (
      value.type === 'snapshot' &&
      session.role === 'controller' &&
      value.host === session.device.id &&
      value.workspace === session.workspace
    ) {
      this.options.snapshot?.(value.value, session.device.id);
    }
  }
  async request(command: RuntimeCommand, host = this.selected): Promise<unknown> {
    const captured = structuredClone(command);
    await this.ready;
    const target = host;
    if (!target || this.stopped) throw Error('REMOTE_NO_HOST_SELECTED');
    const session = await this.connect(target);
    const { type, ...params } = captured;
    const result = await this.rpc(session, type, params);
    if (this.sessions.get(session.id) !== session) throw Error('REMOTE_SESSION_CLOSED');
    validateReviewReply(captured, result);
    return result;
  }
  private async rpc(session: Session, type: string, params: Record<string, unknown>) {
    const request: RemoteRpcRequest = {
      type: 'request',
      id: randomUUID(),
      host: session.device.id,
      workspace: session.workspace,
      method: type,
      params,
      ...(['input', 'browser.input', 'local.input'].includes(type)
        ? { sequence: ++this.sequence }
        : {}),
    };
    if (!isRemoteRpcRequest(request)) throw Error('REMOTE_COMMAND_UNAVAILABLE');
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(request.id);
        reject(Error('REMOTE_OUTCOME_UNKNOWN'));
      }, 30_000);
      timer.unref();
      this.requests.set(request.id, { resolve, reject, timer, session: session.id });
    });
    try {
      await this.port(session).send(session.id, JSON.stringify(request));
    } catch (error) {
      const pending = this.requests.get(request.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.requests.delete(request.id);
        pending.reject(Error(code(error)));
      }
    }
    return result;
  }
  private async publishSnapshot() {
    for (const [id, plan] of [...this.mediaPlans])
      if (
        (!this.sessions.has(id) && plan.expires < Date.now()) ||
        this.options.currentMedia?.(plan.request) === false
      ) {
        this.mediaPlans.delete(id);
        if (this.sessions.has(id)) await this.drop(id, true, 'REMOTE_MEDIA_REVOKED');
        else await plan.port.close(id).catch(() => {});
      }

    if (
      this.polling ||
      this.stopped ||
      ![...this.sessions.values()].some(
        (session) => session.role === 'host' && session.purpose !== 'media' && session.connected,
      )
    )
      return;
    this.polling = true;
    try {
      const value = await this.options.dispatch({ type: 'status' });
      for (const session of this.sessions.values()) {
        if (
          session.role !== 'host' ||
          session.purpose === 'media' ||
          !session.connected ||
          !this.store.device(session.device.id, 'controller')
        )
          continue;
        await this.options.peer.send(
          session.id,
          JSON.stringify({
            type: 'snapshot',
            host: this.keys.identity.id,
            workspace: session.workspace,
            value: remoteSnapshotFor(value, session.snapshotAccept),
          }),
          'events',
        );
      }
    } finally {
      this.polling = false;
    }
  }
  private async drop(id: string, notify = true, error = 'REMOTE_SESSION_CLOSED') {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    if (session.purpose !== 'media') {
      for (const [mediaId, plan] of [...this.mediaPlans])
        if (plan.parent === id) {
          this.mediaPlans.delete(mediaId);
          if (this.sessions.has(mediaId)) await this.drop(mediaId, notify, error);
          else await plan.port.close(mediaId).catch(() => {});
        }
      for (const child of [...this.sessions.values()])
        if (child.parent === id) await this.drop(child.id, notify, error);
      await this.gateway.disconnect(session.device.id, id);
    } else {
      this.mediaPlans.delete(id);
      if (this.viewer?.id === id) {
        this.viewer.phase = 'failed';
        this.viewer.error = error;
      }
    }
    if (notify) {
      try {
        this.connection(session.server).send(session.device.id, id, {
          type: 'close',
          error,
        });
      } catch {}
    }
    await this.port(session)
      .close(id)
      .catch(() => {});
    const host = this.hosts.get(session.device.id);
    if (host && session.role === 'controller' && session.purpose !== 'media')
      host.state = 'offline';
    const connecting = this.connecting.get(id);
    if (connecting) {
      clearTimeout(connecting.timer);
      this.connecting.delete(id);
      connecting.reject(Error('REMOTE_SESSION_CLOSED'));
    }
    for (const [key, pending] of this.requests)
      if (pending.session === id) {
        clearTimeout(pending.timer);
        this.requests.delete(key);
        pending.reject(Error('REMOTE_OUTCOME_UNKNOWN'));
      }
    this.changed();
  }
  async close() {
    await this.ready;
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.poll);
    this.unsubscribe?.();
    for (const id of [...this.sessions.keys()]) await this.drop(id);
    for (const signal of this.signals.values()) signal.close();
    for (const pending of this.pairing.values()) {
      clearTimeout(pending.timer);
      pending.reject(Error('REMOTE_CONNECTION_CLOSED'));
    }
    this.pairing.clear();
    for (const unsubscribe of this.extraPorts.values()) unsubscribe();
    this.extraPorts.clear();
    this.store.close();
  }
}

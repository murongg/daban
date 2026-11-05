import {
  isLocalComputerCommand,
  isLocalComputerStatus,
  isRemoteRpcRequest,
  parseRuntimeCommand,
  type RuntimeCommand,
  validAgentId,
} from '@daban/protocol';
import type { RemoteStore } from './remote-store.js';

export class RemoteGateway {
  private readonly sequences = new Map<string, number>();
  private readonly retired = new Set<string>();
  private readonly nativeOwners = new Map<
    string,
    { device: string; session: string; revision: number }
  >();
  private readonly owners = new Map<
    string,
    { device: string; session: string; epoch: number; instance?: string }
  >();
  constructor(
    private readonly store: RemoteStore,
    private readonly dispatch: (
      command: RuntimeCommand,
      device?: string,
      schema?: 1 | 2,
    ) => Promise<unknown>,
    private readonly authorize?: (
      device: string,
      command: RuntimeCommand,
      session: string,
    ) => Promise<unknown>,
  ) {}
  async invoke(device: string, session: string, value: unknown, schema: 1 | 2 = 2) {
    if (!validAgentId(session) || !isRemoteRpcRequest(value) || 'type' in value.params)
      throw Error('REMOTE_INVALID_REQUEST');
    const sessionKey = JSON.stringify([device, session]);
    if (this.retired.has(sessionKey)) throw Error('REMOTE_SESSION_CLOSED');
    const command = parseRuntimeCommand({ type: value.method, ...value.params });
    if (isLocalComputerCommand(command) && 'session' in command) {
      const owner = this.nativeOwners.get(command.session);
      const ours = owner?.device === device && owner.session === session;
      if (command.type === 'local.input' || command.type === 'local.observe') {
        if (!ours || owner.revision !== command.revision) throw Error('REMOTE_CONTROL_NOT_OWNED');
      } else if (owner && !ours && command.type !== 'local.preview')
        throw Error('REMOTE_CONTROL_NOT_OWNED');
    }
    if (
      command.type === 'control' ||
      command.type === 'input' ||
      command.type === 'browser.input' ||
      command.type === 'app'
    ) {
      const owner = this.owners.get(command.bot);
      const ours = owner?.device === device && owner.session === session;
      if (command.type === 'control') {
        if (owner && !ours) throw Error('REMOTE_CONTROL_NOT_OWNED');
      } else if (
        !ours ||
        owner.epoch !== command.epoch ||
        (command.type !== 'browser.input' && owner.instance !== command.instance)
      )
        throw Error('REMOTE_CONTROL_NOT_OWNED');
    }
    if (
      value.method === 'input' ||
      value.method === 'browser.input' ||
      value.method === 'local.input'
    ) {
      const key = JSON.stringify([device, session]);
      if (value.sequence! <= (this.sequences.get(key) ?? 0)) throw Error('REMOTE_INPUT_REPLAY');
      if (!this.sequences.has(key) && this.sequences.size >= 256)
        throw Error('REMOTE_SESSION_LIMIT');
      this.sequences.set(key, value.sequence!);
    }
    const result = await this.store.run(device, value, async () => {
      if (this.retired.has(sessionKey)) throw Error('REMOTE_SESSION_CLOSED');
      if (isLocalComputerCommand(command) && command.type !== 'local.status') {
        if (!this.authorize) throw Error('REMOTE_NATIVE_AUTH_REQUIRED');
        await this.authorize(device, command, session);
        if (this.retired.has(sessionKey)) throw Error('REMOTE_SESSION_CLOSED');
      }
      return this.dispatch(command, device, schema);
    });
    if (command.type === 'control') {
      if (command.owner === 'agent') this.owners.delete(command.bot);
      else {
        if (
          !result ||
          typeof result !== 'object' ||
          !('epoch' in result) ||
          !Number.isSafeInteger(result.epoch)
        )
          throw Error('REMOTE_INVALID_CONTROL');
        const owner = { device, session, epoch: Number(result.epoch), instance: command.instance };
        this.owners.set(command.bot, owner);
        if (this.retired.has(sessionKey)) {
          await this.disconnect(device, session);
          throw Error('REMOTE_SESSION_CLOSED');
        }
      }
    }
    if (command.type === 'local.pause') {
      if (!isLocalComputerStatus(result) || !result.session || result.session.owner !== 'human')
        throw Error('REMOTE_INVALID_CONTROL');
      this.nativeOwners.set(result.session.id, {
        device,
        session,
        revision: result.session.revision,
      });
      if (this.retired.has(sessionKey)) {
        await this.disconnect(device, session);
        throw Error('REMOTE_SESSION_CLOSED');
      }
    } else if (command.type === 'local.resume' || command.type === 'local.disconnect')
      this.nativeOwners.delete(command.session);
    return result;
  }
  async disconnect(device: string, session: string) {
    const key = JSON.stringify([device, session]);
    this.retired.add(key);
    if (this.retired.size > 4096) this.retired.delete(this.retired.values().next().value!);
    this.sequences.delete(key);
    const releases: Promise<unknown>[] = [];
    for (const [nativeSession, owner] of this.nativeOwners)
      if (owner.device === device && owner.session === session) {
        this.nativeOwners.delete(nativeSession);
        releases.push(
          this.dispatch({ type: 'local.pause', session: nativeSession, revision: owner.revision }),
        );
      }
    for (const [bot, owner] of this.owners)
      if (owner.device === device && owner.session === session) {
        this.owners.delete(bot);
        releases.push(
          this.dispatch({
            type: 'input',
            bot,
            epoch: owner.epoch,
            instance: owner.instance,
            input: { type: 'release' },
          }),
        );
      }
    const results = await Promise.allSettled(releases);
    if (results.some((result) => result.status === 'rejected'))
      console.error('Remote input release could not be confirmed; desktop control remains paused.');
  }
}

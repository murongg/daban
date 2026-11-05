import {
  isLocalComputerCommand,
  type LocalComputerSession,
  type RemoteIdentity,
  type RemoteMediaRequest,
  type RuntimeCommand,
} from '@daban/protocol';

export interface NativeScope {
  bot: string;
  model: string;
  modelRevision: number;
}
export class RemoteConsent {
  private readonly devices = new Map<string, NativeScope>();
  private owner?: { device: string; session: string };
  constructor(
    private readonly current: () => LocalComputerSession | undefined,
    private readonly review: (device: RemoteIdentity, scope: NativeScope) => Promise<boolean>,
  ) {}
  async authorize(device: RemoteIdentity, command: RuntimeCommand) {
    if (!isLocalComputerCommand(command) || command.type === 'local.status') return;
    if (command.type === 'local.permissions') throw Error('REMOTE_NATIVE_AUTH_REQUIRED');
    const current = this.current();
    const scope: NativeScope =
      command.type === 'local.connect'
        ? {
            bot: command.bot,
            model: command.model,
            modelRevision: command.modelRevision,
          }
        : current
          ? { bot: current.bot, model: current.model, modelRevision: current.modelRevision }
          : (() => {
              throw Error('LOCAL_NOT_CONNECTED');
            })();
    if (
      'session' in command &&
      (current?.id !== command.session || current.revision !== command.revision)
    )
      throw Error('LOCAL_SESSION_STALE');
    const saved = this.devices.get(device.id);
    if (
      saved?.bot === scope.bot &&
      saved.model === scope.model &&
      saved.modelRevision === scope.modelRevision
    )
      return;
    if (!(await this.review(device, scope))) throw Error('REMOTE_NATIVE_REFUSED');
    if ('session' in command) {
      const fresh = this.current();
      if (
        fresh?.id !== command.session ||
        fresh.revision !== command.revision ||
        fresh.model !== scope.model ||
        fresh.modelRevision !== scope.modelRevision
      )
        throw Error('LOCAL_SESSION_STALE');
    }
    this.devices.set(device.id, scope);
  }
  granted(device: string, session: LocalComputerSession) {
    this.owner = { device, session: session.id };
  }
  pause() {
    this.devices.clear();
  }
  revoke(device: string) {
    this.devices.delete(device);
    if (this.owner?.device !== device) return false;
    const owns = this.current()?.id === this.owner.session;
    this.owner = undefined;
    return owns;
  }
}

export function nativeMediaCurrent(
  request: RemoteMediaRequest,
  session: LocalComputerSession | undefined,
  scope: NativeScope | undefined,
) {
  // Ownership revisions change during handoff; the viewing grant still belongs to the same Bot/model.
  return (
    request.surface === 'native' &&
    !!session &&
    !!scope &&
    session.id === request.session &&
    session.bot === request.bot &&
    session.bot === scope.bot &&
    session.model === scope.model &&
    session.modelRevision === scope.modelRevision
  );
}

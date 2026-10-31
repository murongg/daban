import { Reboot, type RebootDriver, type RebootOptions } from '@daban/engine/host';
import {
  isRecoveryRequest,
  isRecoveryReview,
  type RebootStatus,
  type RecoveryReview,
  type RuntimeCommand,
  validAgentId,
} from '@daban/protocol';

export type PowerCommand = Extract<RuntimeCommand, { type: `recovery.${string}` }>;
function validCommand(value: unknown): value is PowerCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('type' in value))
    return false;
  const keys = Object.keys(value);
  if (value.type === 'recovery.status' || value.type === 'recovery.review')
    return keys.length === 1;
  if (value.type === 'recovery.restart')
    return keys.length === 2 && 'request' in value && isRecoveryRequest(value.request);
  return (
    ['recovery.inspect', 'recovery.cancel', 'recovery.start'].includes(String(value.type)) &&
    keys.length === 2 &&
    'id' in value &&
    validAgentId(value.id)
  );
}
export interface PowerOptions extends Omit<RebootOptions, 'driver'> {
  driver: RebootDriver;
  beforeStop?: () => Promise<unknown>;
}
export class HostPower {
  readonly ready: Promise<unknown>;
  private readonly reboot: Reboot;
  private closed = false;
  constructor(readonly options: PowerOptions) {
    this.reboot = new Reboot({
      file: options.file,
      target: options.target,
      driver: {
        review: () => options.driver.review(),
        prepare: (request) => options.driver.prepare(request),
        claim: (request) => options.driver.claim(request),
        receipt: (id) => options.driver.receipt(id),
        cancel: (request) => options.driver.cancel(request),
        vm: () => options.driver.vm(),
        stop: async () => {
          // Reboot calls this only after claim and the synced stop-issued record; review never quiesces work.
          if (this.closed) throw new Error('RUNTIME_CLOSED');
          await options.beforeStop?.();
          if (this.closed) throw new Error('RUNTIME_CLOSED');
          await options.driver.stop();
        },
        start: () => options.driver.start(),
      },
    });
    this.ready = this.reboot.ready;
  }
  status() {
    return this.reboot.status();
  }
  async handle(command: RuntimeCommand): Promise<RebootStatus | RecoveryReview> {
    if (!validCommand(command)) throw new Error('INVALID_HOST_RECOVERY_COMMAND');
    const captured = structuredClone(command);
    await this.ready;
    if (this.closed) throw new Error('RUNTIME_CLOSED');
    if (captured.type === 'recovery.status') return this.status();
    const status = this.status();
    if (!status.available) throw new Error(status.error);
    if (captured.type === 'recovery.review') {
      const review = await this.options.driver.review();
      if (!isRecoveryReview(review)) throw new Error('INVALID_RUNTIME_STATE');
      return structuredClone(review);
    }
    if (captured.type === 'recovery.restart') return this.reboot.restart(captured.request);
    if (captured.type === 'recovery.inspect') return this.reboot.inspect(captured.id);
    if (captured.type === 'recovery.cancel') return this.reboot.cancel(captured.id);
    if (captured.type === 'recovery.start') return this.reboot.start(captured.id);
    throw new Error('INVALID_HOST_RECOVERY_COMMAND');
  }
  async close() {
    this.closed = true;
    await this.reboot.close();
  }
}

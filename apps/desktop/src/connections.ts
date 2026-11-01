import { type ComputerRequest, isComputerRequest, validAgentId } from '@daban/protocol';
import { clientCache } from './cache';

export type ComputerPending = Pick<
  ComputerRequest,
  'id' | 'bot' | 'action' | 'revision' | 'instance'
>;
const key = 'daban-computer-pending-v1';
const event = 'daban:computer-pending';
function read(): Record<string, ComputerPending> {
  try {
    const raw = clientCache().getItem(key);
    if (!raw) return {};
    if (raw.length > 600000) throw new Error();
    const value: unknown = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > 2000
    )
      throw new Error();
    for (const [bot, pending] of Object.entries(value)) {
      if (
        !validAgentId(bot) ||
        !isComputerRequest(pending) ||
        pending.bot !== bot ||
        Object.keys(pending).some(
          (field) => !['id', 'bot', 'action', 'revision', 'instance'].includes(field),
        )
      )
        throw new Error();
    }
    return value as Record<string, ComputerPending>;
  } catch {
    throw new Error('COMPUTER_REQUEST_STORAGE_UNAVAILABLE');
  }
}
function write(value: Record<string, ComputerPending>) {
  try {
    clientCache().setItem(key, JSON.stringify(value));
    window.dispatchEvent(new Event(event));
  } catch {
    throw new Error('COMPUTER_REQUEST_STORAGE_UNAVAILABLE');
  }
}
export function watchComputers(changed: () => unknown) {
  const storage = (value: StorageEvent) => {
    if (value.key === key) changed();
  };
  window.addEventListener(event, changed);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(event, changed);
    window.removeEventListener('storage', storage);
  };
}
export function pendingComputer(bot: string) {
  const state = read();
  return Object.hasOwn(state, bot) ? state[bot] : undefined;
}
export function beginComputer(input: ComputerPending) {
  const pending: ComputerPending = {
    id: input.id,
    bot: input.bot,
    action: input.action,
    revision: input.revision,
    ...(input.instance === undefined ? {} : { instance: input.instance }),
  };
  if (!isComputerRequest(pending)) throw new Error('INVALID_COMPUTER_REQUEST');
  const state = read();
  if (Object.hasOwn(state, pending.bot)) throw new Error('COMPUTER_OUTCOME_UNKNOWN');
  write({ ...state, [pending.bot]: pending });
}
export function clearComputer(bot: string, id: string) {
  const state = read();
  if (!Object.hasOwn(state, bot) || state[bot].id !== id) return;
  delete state[bot];
  write(state);
}

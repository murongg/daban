import { validAgentId } from './id.js';
import {
  type BrowserAnswerRequest,
  type BrowserBinding,
  type BrowserCommandRequest,
  type BrowserState,
  type DesktopInput,
  isBrowserAnswerRequest,
  isBrowserBinding,
  isBrowserCommandRequest,
  isBrowserInput,
  isBrowserState,
} from './index.js';

export interface HostBrowserConnection {
  bot: string;
  epoch: number;
  owner: 'human' | 'agent' | 'handoff';
  state: BrowserState;
}
export interface HostBrowserStatus {
  available: boolean;
  connections: HostBrowserConnection[];
  error?: string;
}
export type HostBrowserRequest =
  | { action: 'open' | 'state' | 'view'; bot: string }
  | { action: 'close'; bot: string; instance: string; epoch: number }
  | { action: 'control'; bot: string; instance: string; epoch: number; owner: 'human' | 'agent' }
  | { action: 'command'; bot: string; request: BrowserCommandRequest }
  | { action: 'answer'; bot: string; request: BrowserAnswerRequest }
  | { action: 'receipt'; bot: string; id: string }
  | { action: 'input'; bot: string; epoch: number; binding: BrowserBinding; input: DesktopInput };

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key));
const epoch = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export function isHostBrowserRequest(value: unknown): value is HostBrowserRequest {
  if (!record(value) || !validAgentId(value.bot)) return false;
  switch (value.action) {
    case 'open':
    case 'state':
    case 'view':
      return exact(value, ['action', 'bot']);
    case 'close':
    case 'control':
      return (
        exact(
          value,
          value.action === 'close'
            ? ['action', 'bot', 'instance', 'epoch']
            : ['action', 'bot', 'instance', 'epoch', 'owner'],
        ) &&
        validAgentId(value.instance) &&
        epoch(value.epoch) &&
        (value.action === 'close' || ['human', 'agent'].includes(String(value.owner)))
      );
    case 'command':
      return exact(value, ['action', 'bot', 'request']) && isBrowserCommandRequest(value.request);
    case 'answer':
      return exact(value, ['action', 'bot', 'request']) && isBrowserAnswerRequest(value.request);
    case 'receipt':
      return exact(value, ['action', 'bot', 'id']) && validAgentId(value.id);
    case 'input':
      return (
        exact(value, ['action', 'bot', 'epoch', 'binding', 'input']) &&
        epoch(value.epoch) &&
        isBrowserBinding(value.binding) &&
        isBrowserInput(value.input)
      );
    default:
      return false;
  }
}
export function isHostBrowserStatus(value: unknown): value is HostBrowserStatus {
  if (
    !record(value) ||
    !exact(value, ['available', 'connections', 'error']) ||
    typeof value.available !== 'boolean' ||
    !Array.isArray(value.connections) ||
    value.connections.length > 16 ||
    (!value.available && value.connections.length > 0) ||
    (value.error !== undefined &&
      (typeof value.error !== 'string' || !/^[A-Z_]{1,80}$/.test(value.error)))
  )
    return false;
  const bots = new Set<string>();
  return value.connections.every((connection) => {
    if (
      !record(connection) ||
      !exact(connection, ['bot', 'epoch', 'owner', 'state']) ||
      !validAgentId(connection.bot) ||
      bots.has(connection.bot) ||
      !epoch(connection.epoch) ||
      !['agent', 'human', 'handoff'].includes(String(connection.owner)) ||
      !isBrowserState(connection.state) ||
      connection.state.bot !== connection.bot
    )
      return false;
    bots.add(connection.bot);
    return true;
  });
}

import {
  type BrowserBinding,
  isBrowserBinding,
  type RuntimeReply,
  validAgentId,
} from '@daban/protocol';

export const browserPartition = 'persist:daban-browser';

export interface BrowserBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type BrowserMount =
  | { action: 'hide'; id: string; revision: number }
  | {
      action: 'show';
      id: string;
      revision: number;
      bot: string;
      epoch: number;
      binding: BrowserBinding;
      bounds: BrowserBounds;
    };
export interface BrowserBridge {
  invoke(command: BrowserMount): Promise<RuntimeReply<{ attached: boolean }>>;
}
export function parseBrowserMount(value: unknown): BrowserMount {
  const invalid = (): never => {
    throw new Error('INVALID_BROWSER_MOUNT');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const data = value as Record<string, unknown>;
  const number = (item: unknown) => Number.isSafeInteger(item) && Number(item) >= 0;
  if (!validAgentId(data.id) || !number(data.revision)) return invalid();
  if (
    data.action === 'hide' &&
    Object.keys(data).every((key) => ['action', 'id', 'revision'].includes(key))
  )
    return data as BrowserMount;
  if (
    data.action !== 'show' ||
    Object.keys(data).some(
      (key) => !['action', 'id', 'revision', 'bot', 'epoch', 'binding', 'bounds'].includes(key),
    ) ||
    !validAgentId(data.bot) ||
    !number(data.epoch) ||
    !isBrowserBinding(data.binding)
  )
    return invalid();
  const bounds = data.bounds as Record<string, unknown> | undefined;
  if (
    !bounds ||
    typeof bounds !== 'object' ||
    Object.keys(bounds).length !== 4 ||
    !['x', 'y', 'width', 'height'].every((key) => number(bounds[key])) ||
    Number(bounds.x) > 16384 ||
    Number(bounds.y) > 16384 ||
    Number(bounds.width) < 1 ||
    Number(bounds.width) > 960 ||
    Number(bounds.height) < 1 ||
    Number(bounds.height) > 640
  )
    return invalid();
  return data as BrowserMount;
}

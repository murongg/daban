import {
  type BrowserAnswerRequest,
  documentLimit,
  isTaskFileName,
  type RuntimeBot,
  validAgentId,
} from '@daban/protocol';
import { type ClientCache, clientCache } from '../../app/cache';

type WithoutMeta<T> = T extends unknown ? Omit<T, 'id' | 'epoch'> : never;
export type BrowserAnswer = WithoutMeta<BrowserAnswerRequest>;

export interface BrowserPending {
  id: string;
  instance: string;
  epoch: number;
}
const key = 'daban-browser-pending-v1';
function read(cache: ClientCache): Partial<Record<RuntimeBot, BrowserPending>> {
  try {
    const raw = cache.getItem(key);
    if (!raw) return {};
    if (raw.length > 600000) throw new Error();
    const value = JSON.parse(raw);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length > 2000
    )
      throw new Error();
    for (const [bot, pending] of Object.entries(value)) {
      if (!validAgentId(bot) || !pending || typeof pending !== 'object' || Array.isArray(pending))
        throw new Error();
      const item = pending as Record<string, unknown>;
      if (
        Object.keys(item).some((field) => !['id', 'instance', 'epoch'].includes(field)) ||
        !validAgentId(item.id) ||
        !validAgentId(item.instance) ||
        !Number.isSafeInteger(item.epoch) ||
        Number(item.epoch) < 0
      )
        throw new Error();
    }
    return value;
  } catch {
    throw new Error('BROWSER_REQUEST_STORAGE_UNAVAILABLE');
  }
}
function write(value: Partial<Record<RuntimeBot, BrowserPending>>, cache: ClientCache) {
  try {
    cache.setItem(key, JSON.stringify(value));
  } catch {
    throw new Error('BROWSER_REQUEST_STORAGE_UNAVAILABLE');
  }
}
export function browserRequest(bot: RuntimeBot, cache = clientCache()) {
  const state = read(cache);
  return Object.hasOwn(state, bot) ? state[bot] : undefined;
}
export function beginBrowserRequest(
  bot: RuntimeBot,
  pending: BrowserPending,
  cache = clientCache(),
) {
  const state = read(cache);
  if (Object.hasOwn(state, bot)) throw new Error('BROWSER_OUTCOME_UNKNOWN');
  write({ ...state, [bot]: pending }, cache);
}
export function clearBrowserRequest(bot: RuntimeBot, id: string, cache = clientCache()) {
  const state = read(cache);
  if (!Object.hasOwn(state, bot) || state[bot]?.id !== id) return;
  delete state[bot];
  write(state, cache);
}

// Address edits remain in this renderer's memory; URL queries and human replies must not enter workspace exports.
const addresses = new Map<string, string>();
export function addressDraft(key: string, value?: string) {
  if (value !== undefined) {
    addresses.set(key, value.slice(0, 2048));
    if (addresses.size > 64) addresses.delete(addresses.keys().next().value!);
  }
  return addresses.get(key);
}
export function forgetAddress(key: string) {
  addresses.delete(key);
}
export async function browserFiles(files: File[]) {
  if (
    files.length > 4 ||
    files.reduce((bytes, file) => bytes + file.size, 0) > documentLimit ||
    files.some((file) => !isTaskFileName(file.name))
  )
    throw new Error('INVALID_BROWSER_FILE');
  return Promise.all(
    files.map(async (file) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return {
        name: file.name,
        data: btoa(binary),
        mimeType: file.type || 'application/octet-stream',
      };
    }),
  );
}

import { validAgentId } from './index.js';
import type { RemoteIceServer } from './remote.js';

export type PeerDescription =
  | { type: 'offer' | 'answer'; sdp: string }
  | { type: 'candidate'; candidate: string; mid: string | null; line: number | null };
export type PeerCommand =
  | {
      id: string;
      type: 'open';
      session: string;
      initiator: boolean;
      ice: RemoteIceServer[];
      media?: boolean;
    }
  | { id: string; type: 'signal'; session: string; payload: PeerDescription }
  | { id: string; type: 'send'; session: string; data: string; channel?: 'events' }
  | { id: string; type: 'close'; session: string }
  | { id: string; type: 'capture'; session: string };
export type PeerEvent =
  | { type: 'track'; session: string }
  | { type: 'result'; id: string; ok: boolean; error?: string }
  | { type: 'signal'; session: string; payload: PeerDescription }
  | {
      type: 'state';
      session: string;
      state: 'connected' | 'closed' | 'failed';
      transport?: 'direct' | 'relay';
      error?: string;
    }
  | { type: 'message'; session: string; data: string };
export interface PeerBridge {
  subscribe(callback: (command: PeerCommand) => unknown): () => unknown;
  emit(event: PeerEvent): unknown;
}
export interface RemotePeerPort {
  open(
    session: string,
    initiator: boolean,
    ice: RemoteIceServer[],
    media?: boolean,
  ): Promise<unknown>;
  signal(session: string, payload: PeerDescription): Promise<unknown>;
  send(session: string, data: string, channel?: 'events'): Promise<unknown>;
  close(session: string): Promise<unknown>;
  capture?(session: string): Promise<unknown>;
  subscribe(callback: (event: Exclude<PeerEvent, { type: 'result' }>) => unknown): () => unknown;
}

export function isPeerEvent(value: unknown): value is PeerEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const exact = (keys: string[]) => Object.keys(item).every((key) => keys.includes(key));
  if (item.type === 'result')
    return (
      exact(['type', 'id', 'ok', 'error']) &&
      validAgentId(item.id) &&
      typeof item.ok === 'boolean' &&
      (item.error === undefined ||
        (typeof item.error === 'string' && /^[A-Z_]{1,100}$/.test(item.error)))
    );
  if (!validAgentId(item.session)) return false;
  if (item.type === 'track') return exact(['type', 'session']);
  if (item.type === 'message')
    return (
      exact(['type', 'session', 'data']) &&
      typeof item.data === 'string' &&
      item.data.length <= 144 * 1024 * 1024
    );
  if (item.type === 'state')
    return (
      exact(['type', 'session', 'state', 'transport', 'error']) &&
      ['connected', 'closed', 'failed'].includes(String(item.state)) &&
      (item.transport === undefined || ['direct', 'relay'].includes(String(item.transport))) &&
      (item.error === undefined ||
        (typeof item.error === 'string' && /^[A-Z_]{1,100}$/.test(item.error)))
    );
  if (
    item.type !== 'signal' ||
    !exact(['type', 'session', 'payload']) ||
    !item.payload ||
    typeof item.payload !== 'object' ||
    Array.isArray(item.payload)
  )
    return false;
  const payload = item.payload as Record<string, unknown>;
  if (payload.type === 'offer' || payload.type === 'answer')
    return (
      Object.keys(payload).every((key) => ['type', 'sdp'].includes(key)) &&
      typeof payload.sdp === 'string' &&
      payload.sdp.length > 0 &&
      payload.sdp.length <= 131072 &&
      !payload.sdp.includes('\0')
    );
  return (
    payload.type === 'candidate' &&
    Object.keys(payload).every((key) => ['type', 'candidate', 'mid', 'line'].includes(key)) &&
    typeof payload.candidate === 'string' &&
    payload.candidate.length <= 4096 &&
    (payload.mid === null || (typeof payload.mid === 'string' && payload.mid.length <= 100)) &&
    (payload.line === null ||
      (Number.isInteger(payload.line) && Number(payload.line) >= 0 && Number(payload.line) < 100))
  );
}

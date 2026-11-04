import { parseRuntimeCommand } from './command.js';
import { validAgentId } from './index.js';

export const remoteVersion = 2;
export const remoteMessageLimit = 256 * 1024;
export const remoteFileChunk = 48 * 1024;

export interface RemoteIdentity {
  id: string;
  publicKey: string;
  name: string;
}
export interface RemoteInvitation {
  version: 2;
  host: RemoteIdentity;
  server: string;
  code: string;
  expiresAt: number;
  certificate: string;
  alternatives?: string[];
}
export interface RemoteIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}
export type RemoteSignalPayload =
  | { type: 'connect'; signature: string }
  | { type: 'connected'; signature: string }
  | { type: 'data'; data: string }
  | { type: 'frame'; data: string }
  | { type: 'pair'; code: string }
  | { type: 'paired'; accepted: boolean; signature: string; workspace: string; platform: string }
  | { type: 'offer' | 'answer'; sdp: string; signature: string }
  | { type: 'candidate'; candidate: string; mid: string | null; line: number | null }
  | { type: 'close'; error: string };
export type RemoteSignal =
  | { type: 'left'; identity: RemoteIdentity }
  | { type: 'challenge'; nonce: string }
  | { type: 'register'; identity: RemoteIdentity; signature: string }
  | { type: 'ready'; iceServers: RemoteIceServer[] }
  | { type: 'signal'; to: string; session: string; payload: RemoteSignalPayload }
  | {
      type: 'signal';
      from: RemoteIdentity;
      session: string;
      payload: RemoteSignalPayload;
    }
  | { type: 'error'; error: string };

const remoteLocalEffects = new Set([
  'clipboard.write',
  'link.open',
  'skill.pick',
  'local.permissions',
]);

function remoteMethod(method: string, params: Record<string, unknown>) {
  if ('type' in params) return false;
  if (method === 'media.open') return isRemoteMediaRequest(params);
  if (method === 'media.close') return exact(params, ['id']) && validAgentId(params.id);
  if (remoteLocalEffects.has(method) || /^(setup|agent|vm|recovery)\./.test(method)) return false;
  try {
    parseRuntimeCommand({ type: method, ...params });
    return true;
  } catch {
    return false;
  }
}

export interface RemoteRpcRequest {
  type: 'request';
  id: string;
  host: string;
  workspace: string;
  method: string;
  params: Record<string, unknown>;
  sequence?: number;
}
export type RemoteRpcReply =
  | { type: 'reply'; id: string; host: string; workspace: string; ok: true; value: unknown }
  | { type: 'reply'; id: string; host: string; workspace: string; ok: false; error: string };

export interface RemoteHost {
  certificate?: string;
  alternatives?: string[];
  identity: RemoteIdentity;
  server: string;
  workspace: string;
  platform: string;
  state: 'offline' | 'connecting' | 'connected' | 'revoked';
  transport: 'unknown' | 'direct' | 'relay';
  error?: string;
}
export interface RemotePairRequest {
  id: string;
  identity: RemoteIdentity;
  expiresAt: number;
}
export type RemoteMediaRequest =
  | { surface: 'native'; bot: string; session: string; revision: number }
  | { surface: 'desktop'; bot: string; instance: string; epoch: number };
export interface RemoteViewer {
  id: string;
  host: string;
  bot: string;
  surface: 'native' | 'desktop';
  binding: string;
  phase: 'connecting' | 'ready' | 'failed';
  error?: string;
}
export interface RemoteState {
  selected: string | null;
  identity: RemoteIdentity;
  hosting: boolean;
  server: string;
  hosts: RemoteHost[];
  pending: RemotePairRequest[];
  controllers?: RemoteIdentity[];
  viewer?: RemoteViewer;
  invitation?: string;
}
export type RemoteCommand =
  | { type: 'view'; host: string; request: RemoteMediaRequest }
  | { type: 'view.close'; id: string }
  | { type: 'status' }
  | { type: 'host'; enabled: boolean }
  | { type: 'invite' }
  | { type: 'pair'; invitation: string }
  | { type: 'approve'; id: string; accepted: boolean }
  | { type: 'select'; host: string | null }
  | { type: 'revoke'; device: string };
export interface RemoteBridge {
  invoke(command: RemoteCommand): Promise<RemoteState>;
  subscribe(callback: (state: RemoteState) => unknown): () => unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function isRemoteMediaRequest(value: unknown): value is RemoteMediaRequest {
  if (!record(value) || !validAgentId(value.bot)) return false;
  return value.surface === 'native'
    ? exact(value, ['surface', 'bot', 'session', 'revision']) &&
        validAgentId(value.session) &&
        Number.isSafeInteger(value.revision) &&
        Number(value.revision) >= 1
    : value.surface === 'desktop' &&
        exact(value, ['surface', 'bot', 'instance', 'epoch']) &&
        validAgentId(value.instance) &&
        Number.isSafeInteger(value.epoch) &&
        Number(value.epoch) >= 0;
}
function exact(value: Record<string, unknown>, names: string[]) {
  return Object.keys(value).every((key) => names.includes(key));
}
function text(value: unknown, max: number, min = 1): value is string {
  return (
    typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0')
  );
}
export function remoteDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}
export function isRemoteIdentity(value: unknown): value is RemoteIdentity {
  return (
    record(value) &&
    exact(value, ['id', 'publicKey', 'name']) &&
    remoteDeviceId(value.id) &&
    text(value.publicKey, 64, 59) &&
    /^[A-Za-z0-9_-]+$/.test(value.publicKey) &&
    text(value.name, 160)
  );
}
export function remoteServer(value: string) {
  const url = new URL(value);
  const parts = url.hostname.split('.').map(Number);
  const local =
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 192 && parts[1] === 168) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31));
  if (
    url.protocol !== 'https:' ||
    !local ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname) ||
    value.length > 2048
  )
    throw Error('REMOTE_INVALID_SERVER');
  return url.origin;
}

function invitation(value: unknown): value is RemoteInvitation {
  if (
    !record(value) ||
    !exact(value, [
      'version',
      'host',
      'server',
      'code',
      'expiresAt',
      'certificate',
      'alternatives',
    ]) ||
    value.version !== remoteVersion ||
    !isRemoteIdentity(value.host) ||
    !text(value.server, 2048) ||
    !text(value.code, 128, 32) ||
    !/^[A-Za-z0-9_-]+$/.test(value.code) ||
    !Number.isSafeInteger(value.expiresAt)
  )
    return false;
  try {
    return (
      remoteServer(value.server) === value.server &&
      isRemoteCertificate(value.certificate) &&
      (value.alternatives === undefined ||
        (Array.isArray(value.alternatives) &&
          value.alternatives.length <= 8 &&
          value.alternatives.every(
            (server) => typeof server === 'string' && remoteLanServer(server),
          )))
    );
  } catch {
    return false;
  }
}
export function remoteInvitation(value: RemoteInvitation) {
  if (!invitation(value)) throw new Error('REMOTE_INVALID_INVITATION');
  return `daban://pair#${encodeURIComponent(JSON.stringify(value))}`;
}
export function parseRemoteInvitation(value: string, now = Date.now()): RemoteInvitation {
  if (!text(value, 8192)) throw new Error('REMOTE_INVALID_INVITATION');
  const url = new URL(value);
  if (
    url.protocol !== 'daban:' ||
    url.hostname !== 'pair' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname ||
    url.search
  )
    throw new Error('REMOTE_INVALID_INVITATION');
  const parsed: unknown = JSON.parse(decodeURIComponent(url.hash.slice(1)));
  if (!invitation(parsed) || parsed.expiresAt <= now || parsed.expiresAt > now + 10 * 60_000)
    throw new Error('REMOTE_INVITATION_EXPIRED');
  return parsed;
}
function payload(value: unknown): value is RemoteSignalPayload {
  if (!record(value)) return false;
  switch (value.type) {
    case 'connect':
      return exact(value, ['type', 'signature']) && text(value.signature, 86, 86);
    case 'connected':
      return exact(value, ['type', 'signature']) && text(value.signature, 86, 86);
    case 'data':
      return exact(value, ['type', 'data']) && text(value.data, remoteFileChunk);
    case 'frame':
      return (
        exact(value, ['type', 'data']) &&
        text(value.data, 65560) &&
        value.data.length % 4 === 0 &&
        /^[A-Za-z0-9+/]+={0,2}$/.test(value.data)
      );
    case 'pair':
      return exact(value, ['type', 'code']) && text(value.code, 128, 32);
    case 'paired':
      return (
        exact(value, ['type', 'accepted', 'signature', 'workspace', 'platform']) &&
        typeof value.accepted === 'boolean' &&
        text(value.signature, 128, 80) &&
        validAgentId(value.workspace) &&
        text(value.platform, 40)
      );
    case 'offer':
    case 'answer':
      return (
        exact(value, ['type', 'sdp', 'signature']) &&
        text(value.sdp, 131072) &&
        text(value.signature, 86, 86)
      );
    case 'candidate':
      return (
        exact(value, ['type', 'candidate', 'mid', 'line']) &&
        text(value.candidate, 4096, 0) &&
        (value.mid === null || text(value.mid, 100, 0)) &&
        (value.line === null ||
          (Number.isSafeInteger(value.line) && Number(value.line) >= 0 && Number(value.line) < 100))
      );
    case 'close':
      return exact(value, ['type', 'error']) && text(value.error, 100);
    default:
      return false;
  }
}
export function isRemoteSignal(value: unknown): value is RemoteSignal {
  if (!record(value)) return false;
  if (value.type === 'left')
    return exact(value, ['type', 'identity']) && isRemoteIdentity(value.identity);
  if (value.type === 'challenge')
    return exact(value, ['type', 'nonce']) && text(value.nonce, 64, 64);
  if (value.type === 'register')
    return (
      exact(value, ['type', 'identity', 'signature']) &&
      isRemoteIdentity(value.identity) &&
      text(value.signature, 128, 80)
    );
  if (value.type === 'error') return exact(value, ['type', 'error']) && text(value.error, 100);
  if (value.type === 'ready')
    return (
      exact(value, ['type', 'iceServers']) &&
      Array.isArray(value.iceServers) &&
      value.iceServers.length === 0 &&
      value.iceServers.every(
        (server) =>
          record(server) &&
          exact(server, ['urls', 'username', 'credential']) &&
          Array.isArray(server.urls) &&
          server.urls.length > 0 &&
          server.urls.length <= 4 &&
          server.urls.every((url) => text(url, 1024) && /^(stun|turn|turns):/.test(url)) &&
          (server.username === undefined || text(server.username, 256)) &&
          (server.credential === undefined || text(server.credential, 256)),
      )
    );
  return (
    value.type === 'signal' &&
    (('to' in value &&
      !('from' in value) &&
      exact(value, ['type', 'to', 'session', 'payload']) &&
      remoteDeviceId(value.to)) ||
      ('from' in value &&
        !('to' in value) &&
        exact(value, ['type', 'from', 'session', 'payload']) &&
        isRemoteIdentity(value.from))) &&
    validAgentId(value.session) &&
    payload(value.payload)
  );
}
export function isRemoteRpcRequest(value: unknown): value is RemoteRpcRequest {
  return (
    record(value) &&
    exact(value, ['type', 'id', 'host', 'workspace', 'method', 'params', 'sequence']) &&
    value.type === 'request' &&
    validAgentId(value.id) &&
    remoteDeviceId(value.host) &&
    validAgentId(value.workspace) &&
    typeof value.method === 'string' &&
    record(value.params) &&
    remoteMethod(value.method, value.params) &&
    (value.sequence === undefined ||
      (Number.isSafeInteger(value.sequence) && Number(value.sequence) > 0)) &&
    (!['input', 'browser.input', 'local.input'].includes(String(value.method)) ||
      value.sequence !== undefined)
  );
}
export function isRemoteCommand(value: unknown): value is RemoteCommand {
  if (!record(value)) return false;
  switch (value.type) {
    case 'view':
      return (
        exact(value, ['type', 'host', 'request']) &&
        remoteDeviceId(value.host) &&
        isRemoteMediaRequest(value.request)
      );
    case 'view.close':
      return exact(value, ['type', 'id']) && validAgentId(value.id);

    case 'status':
    case 'invite':
      return exact(value, ['type']);
    case 'host':
      return exact(value, ['type', 'enabled']) && typeof value.enabled === 'boolean';
    case 'pair':
      return exact(value, ['type', 'invitation']) && text(value.invitation, 8192);
    case 'approve':
      return (
        exact(value, ['type', 'id', 'accepted']) &&
        validAgentId(value.id) &&
        typeof value.accepted === 'boolean'
      );
    case 'select':
      return exact(value, ['type', 'host']) && (value.host === null || remoteDeviceId(value.host));
    case 'revoke':
      return exact(value, ['type', 'device']) && remoteDeviceId(value.device);
    default:
      return false;
  }
}

export function remoteLanServer(value: string) {
  try {
    return remoteServer(value) === value;
  } catch {
    return false;
  }
}
export function isRemoteCertificate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 8192 &&
    /^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----\r?\n?$/.test(
      value,
    )
  );
}

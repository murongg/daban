import { validAgentId } from './index.js';

export type AppOAuthPhase =
  | 'preparing'
  | 'waiting'
  | 'exchanging'
  | 'connected'
  | 'cancelled'
  | 'expired'
  | 'failed'
  | 'interrupted';
export interface AppTarget {
  bot: string;
  connection: string;
  revision: number;
}
export interface AppOAuthStart extends AppTarget {
  requestId: string;
  app: 'notion';
  name?: string;
}
export interface AppOAuthReceipt extends AppTarget {
  requestId: string;
  attempt: string;
  phase: AppOAuthPhase;
  error?: string;
}
export interface AppConnectionAuth {
  connection: string;
  state: 'disconnected' | 'authorizing' | 'connected' | 'reconnect-required';
  scope?: string;
  expiresAt?: number;
}
export interface AppCatalogEntry {
  id: 'notion' | 'custom-mcp';
  publisher: string;
  origin?: string;
  auth: 'oauth' | 'bearer';
  available: boolean;
  reason?: 'OAUTH_CALLBACK_UNAVAILABLE' | 'OAUTH_NOT_VERIFIED';
}
export interface AppCatalog {
  bot: string;
  apps: AppCatalogEntry[];
  connections: AppConnectionAuth[];
  attempts: { input: AppOAuthStart; receipt: AppOAuthReceipt }[];
}
export interface AppConnectionsCapability {
  catalog: true;
  oauthLoopback: boolean;
}
export type AppCommand =
  | { type: 'app.catalog'; bot: string }
  | { type: 'app.oauth.start'; input: AppOAuthStart }
  | { type: 'app.oauth.status'; target: AppTarget; attempt: string }
  | { type: 'app.oauth.cancel'; target: AppTarget; attempt: string; requestId: string }
  | { type: 'app.disconnect'; target: AppTarget; requestId: string };

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const revision = (v: unknown) =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) < Number.MAX_SAFE_INTEGER - 1;
export function isAppTarget(v: unknown): v is AppTarget {
  return (
    object(v) &&
    keys(v, ['bot', 'connection', 'revision']) &&
    validAgentId(v.bot) &&
    validAgentId(v.connection) &&
    revision(v.revision)
  );
}
export function isAppOAuthStart(v: unknown): v is AppOAuthStart {
  return (
    object(v) &&
    keys(v, ['bot', 'connection', 'revision', 'requestId', 'app', 'name']) &&
    validAgentId(v.bot) &&
    validAgentId(v.connection) &&
    revision(v.revision) &&
    validAgentId(v.requestId) &&
    v.app === 'notion' &&
    (v.revision === 0
      ? typeof v.name === 'string' &&
        !!v.name.trim() &&
        v.name.length <= 60 &&
        !v.name.includes('\0')
      : v.name === undefined)
  );
}
export function isAppCommand(v: unknown): v is AppCommand {
  if (!object(v)) return false;
  switch (v.type) {
    case 'app.catalog':
      return keys(v, ['type', 'bot']) && validAgentId(v.bot);
    case 'app.oauth.start':
      return keys(v, ['type', 'input']) && isAppOAuthStart(v.input);
    case 'app.oauth.status':
      return (
        keys(v, ['type', 'target', 'attempt']) && isAppTarget(v.target) && validAgentId(v.attempt)
      );
    case 'app.oauth.cancel':
      return (
        keys(v, ['type', 'target', 'attempt', 'requestId']) &&
        isAppTarget(v.target) &&
        validAgentId(v.attempt) &&
        validAgentId(v.requestId)
      );
    case 'app.disconnect':
      return (
        keys(v, ['type', 'target', 'requestId']) &&
        isAppTarget(v.target) &&
        v.target.revision > 0 &&
        validAgentId(v.requestId)
      );
    default:
      return false;
  }
}
export function isAppOAuthReceipt(v: unknown): v is AppOAuthReceipt {
  return (
    object(v) &&
    keys(v, ['bot', 'connection', 'revision', 'requestId', 'attempt', 'phase', 'error']) &&
    validAgentId(v.bot) &&
    validAgentId(v.connection) &&
    revision(v.revision) &&
    validAgentId(v.requestId) &&
    validAgentId(v.attempt) &&
    [
      'preparing',
      'waiting',
      'exchanging',
      'connected',
      'cancelled',
      'expired',
      'failed',
      'interrupted',
    ].includes(String(v.phase)) &&
    (v.error === undefined || (typeof v.error === 'string' && /^OAUTH_[A-Z_]{1,70}$/.test(v.error)))
  );
}
export function isAppConnectionsCapability(v: unknown): v is AppConnectionsCapability {
  return (
    object(v) &&
    keys(v, ['catalog', 'oauthLoopback']) &&
    v.catalog === true &&
    typeof v.oauthLoopback === 'boolean'
  );
}
export function isAppCatalog(v: unknown): v is AppCatalog {
  if (
    !object(v) ||
    !keys(v, ['bot', 'apps', 'connections', 'attempts']) ||
    !validAgentId(v.bot) ||
    !Array.isArray(v.apps) ||
    v.apps.length !== 2 ||
    !Array.isArray(v.connections) ||
    v.connections.length > 50 ||
    !Array.isArray(v.attempts) ||
    v.attempts.length > 50 ||
    !v.attempts.every(
      (a) =>
        object(a) &&
        keys(a, ['input', 'receipt']) &&
        isAppOAuthStart(a.input) &&
        isAppOAuthReceipt(a.receipt) &&
        a.receipt.bot === v.bot &&
        appReceiptMatches(a.receipt, a.input) &&
        a.receipt.requestId === a.input.requestId &&
        ['preparing', 'waiting', 'exchanging'].includes(a.receipt.phase),
    )
  )
    return false;
  return (
    new Set(v.apps.map((a) => (object(a) ? a.id : undefined))).size === 2 &&
    v.apps.every(
      (a) =>
        object(a) &&
        keys(a, ['id', 'publisher', 'origin', 'auth', 'available', 'reason']) &&
        ['notion', 'custom-mcp'].includes(String(a.id)) &&
        typeof a.publisher === 'string' &&
        a.publisher.length <= 100 &&
        (a.id === 'notion'
          ? a.origin === 'https://mcp.notion.com' && a.auth === 'oauth'
          : a.origin === undefined && a.auth === 'bearer') &&
        typeof a.available === 'boolean' &&
        (a.reason === undefined ||
          ['OAUTH_CALLBACK_UNAVAILABLE', 'OAUTH_NOT_VERIFIED'].includes(String(a.reason))),
    ) &&
    new Set(v.connections.map((c) => (object(c) ? c.connection : undefined))).size ===
      v.connections.length &&
    v.connections.every(
      (c) =>
        object(c) &&
        keys(c, ['connection', 'state', 'scope', 'expiresAt']) &&
        validAgentId(c.connection) &&
        ['disconnected', 'authorizing', 'connected', 'reconnect-required'].includes(
          String(c.state),
        ) &&
        (c.scope === undefined || (typeof c.scope === 'string' && c.scope.length <= 4096)) &&
        (c.expiresAt === undefined ||
          (Number.isSafeInteger(c.expiresAt) && Number(c.expiresAt) > 0)),
    )
  );
}
export function appReceiptMatches(receipt: AppOAuthReceipt, target: AppTarget) {
  return (
    receipt.bot === target.bot &&
    receipt.connection === target.connection &&
    receipt.revision === target.revision
  );
}
export function isNotionAuthorizeUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 16000) return false;
  try {
    const url = new URL(value);
    const redirect = new URL(url.searchParams.get('redirect_uri') ?? '');
    const allowed = [
      'response_type',
      'client_id',
      'redirect_uri',
      'state',
      'code_challenge',
      'code_challenge_method',
      'resource',
      'scope',
    ];
    return (
      url.origin === 'https://mcp.notion.com' &&
      url.pathname === '/authorize' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.searchParams.get('response_type') === 'code' &&
      url.searchParams.get('code_challenge_method') === 'S256' &&
      url.searchParams.get('resource') === 'https://mcp.notion.com/mcp' &&
      url.searchParams.get('scope') === 'default' &&
      /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('state') ?? '') &&
      /^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge') ?? '') &&
      !!url.searchParams.get('client_id') &&
      [...url.searchParams.keys()].every(
        (k) => allowed.includes(k) && url.searchParams.getAll(k).length === 1,
      ) &&
      redirect.protocol === 'http:' &&
      redirect.hostname === '127.0.0.1' &&
      Number(redirect.port) > 0 &&
      !redirect.username &&
      !redirect.password &&
      !redirect.hash &&
      !redirect.search &&
      /^\/oauth\/[a-f0-9]{48}$/.test(redirect.pathname)
    );
  } catch {
    return false;
  }
}

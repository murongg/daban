import { validAgentId } from './index.js';
import { type AppId, appProvider, appProviders, isAppAuthorizeUrl } from './app-providers.js';

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
export interface AppConnect extends Omit<AppOAuthStart, 'app'> {
  app: AppId;
}
export const appDirectoryProtocol = 'app-directory-v2';
export interface AppDirectoryEntry {
  id: AppId | 'custom-mcp';
  publisher: string;
  origin?: string;
  auth: 'oauth' | 'bearer';
  available: boolean;
  scope?: string;
  adminApproval?: boolean;
  reason?: 'OAUTH_CALLBACK_UNAVAILABLE' | 'OAUTH_NOT_VERIFIED';
}
export interface AppDirectory {
  protocol: typeof appDirectoryProtocol;
  bot: string;
  apps: AppDirectoryEntry[];
  connections: (AppConnectionAuth & { app: AppId; name: string; revision: number })[];
  attempts: { input: AppConnect; receipt: AppOAuthReceipt }[];
  attemptsMore: boolean;
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
  | { type: 'app.directory'; bot: string }
  | { type: 'app.oauth.connect'; input: AppConnect }
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
  return isAppConnect(v) && v.app === 'notion';
}
export function isAppConnect(v: unknown): v is AppConnect {
  return (
    object(v) &&
    keys(v, ['bot', 'connection', 'revision', 'requestId', 'app', 'name']) &&
    validAgentId(v.bot) &&
    validAgentId(v.connection) &&
    revision(v.revision) &&
    validAgentId(v.requestId) &&
    appProvider(v.app) !== undefined &&
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
    case 'app.directory':
      return keys(v, ['type', 'bot']) && validAgentId(v.bot);
    case 'app.oauth.start':
      return keys(v, ['type', 'input']) && isAppOAuthStart(v.input);
    case 'app.oauth.connect':
      return keys(v, ['type', 'input']) && isAppConnect(v.input);
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
function connectionAuth(v: unknown, directory = false): v is AppConnectionAuth {
  return (
    object(v) &&
    keys(v, [
      'connection',
      'state',
      'scope',
      'expiresAt',
      ...(directory ? ['app', 'name', 'revision'] : []),
    ]) &&
    validAgentId(v.connection) &&
    ['disconnected', 'authorizing', 'connected', 'reconnect-required'].includes(String(v.state)) &&
    (v.scope === undefined || (typeof v.scope === 'string' && v.scope.length <= 4096)) &&
    (v.expiresAt === undefined || (Number.isSafeInteger(v.expiresAt) && Number(v.expiresAt) > 0)) &&
    (!directory ||
      (appProvider(v.app) !== undefined &&
        revision(v.revision) &&
        Number(v.revision) > 0 &&
        typeof v.name === 'string' &&
        !!v.name.trim() &&
        v.name.length <= 60 &&
        !v.name.includes('\0')))
  );
}
export function isAppDirectoryCapability(v: unknown) {
  return object(v) && keys(v, ['protocol']) && v.protocol === appDirectoryProtocol;
}
export function isAppDirectory(v: unknown): v is AppDirectory {
  if (
    !object(v) ||
    !keys(v, ['protocol', 'bot', 'apps', 'connections', 'attempts', 'attemptsMore']) ||
    v.protocol !== appDirectoryProtocol ||
    !validAgentId(v.bot) ||
    typeof v.attemptsMore !== 'boolean' ||
    !Array.isArray(v.apps) ||
    v.apps.length !== appProviders.length + 1 ||
    !Array.isArray(v.connections) ||
    v.connections.length > 50 ||
    !Array.isArray(v.attempts) ||
    v.attempts.length > 50
  )
    return false;
  return (
    new Set(v.apps.map((entry) => (object(entry) ? entry.id : undefined))).size === v.apps.length &&
    v.apps.every((entry) => {
      if (
        !object(entry) ||
        !keys(entry, [
          'id',
          'publisher',
          'origin',
          'auth',
          'available',
          'reason',
          'scope',
          'adminApproval',
        ]) ||
        typeof entry.available !== 'boolean'
      )
        return false;
      if (entry.id === 'custom-mcp')
        return (
          entry.publisher === 'Custom MCP' &&
          entry.auth === 'bearer' &&
          entry.origin === undefined &&
          entry.scope === undefined &&
          entry.adminApproval === undefined &&
          entry.available === true &&
          entry.reason === undefined
        );
      const provider = appProvider(entry.id);
      return (
        !!provider &&
        entry.publisher === provider.publisher &&
        entry.origin === new URL(provider.resource).origin &&
        entry.auth === 'oauth' &&
        entry.scope === provider.scope &&
        entry.adminApproval === provider.adminApproval &&
        (entry.reason === undefined ||
          ['OAUTH_CALLBACK_UNAVAILABLE', 'OAUTH_NOT_VERIFIED'].includes(String(entry.reason))) &&
        (entry.available || entry.reason !== undefined)
      );
    }) &&
    v.connections.every((entry) => connectionAuth(entry, true)) &&
    new Set(v.connections.map((entry) => entry.connection)).size === v.connections.length &&
    v.attempts.every(
      (entry) =>
        object(entry) &&
        keys(entry, ['input', 'receipt']) &&
        isAppConnect(entry.input) &&
        isAppOAuthReceipt(entry.receipt) &&
        entry.input.bot === v.bot &&
        appReceiptMatches(entry.receipt, entry.input) &&
        entry.receipt.requestId === entry.input.requestId &&
        ['preparing', 'waiting', 'exchanging', 'failed', 'interrupted', 'expired'].includes(
          entry.receipt.phase,
        ),
    )
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
    v.connections.every((entry) => connectionAuth(entry))
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
  return isAppAuthorizeUrl(value, 'notion');
}

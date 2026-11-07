import { validAgentId } from './id.js';

export type SearchProvider = 'deepseek' | 'brave' | 'duckduckgo' | 'bing';
export const searchRequiresKey = (provider: SearchProvider) =>
  provider !== 'duckduckgo' && provider !== 'bing';
export interface SearchSource {
  url: string;
  title?: string;
  snippet?: string;
  publishedAt?: string;
}
export interface SearchResult {
  sources: SearchSource[];
  truncated: boolean;
}
export type SearchHealth =
  | 'disabled'
  | 'unconfigured'
  | 'unchecked'
  | 'ready'
  | 'empty'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'unavailable'
  | 'timeout'
  | 'invalid-response'
  | 'config-changed'
  | 'cancelled'
  | 'unknown';
export interface SearchStatus {
  revision: number;
  // Task outcomes advance this too, so a retained test receipt cannot restore older health.
  checkRevision: number;
  enabled: boolean;
  provider: SearchProvider;
  credentialConfigured: boolean;
  credentialSource: 'none' | 'independent' | 'legacy-linked';
  health: SearchHealth;
  checkedAt?: string;
  error?: SearchErrorCode;
  retryAfter?: number;
}
export interface SearchUpdate {
  requestId: string;
  revision: number;
  enabled: boolean;
  provider: SearchProvider;
  key?: string;
}
export interface SearchCheckRequest {
  requestId: string;
  revision: number;
  checkRevision: number;
}
export interface SearchReceiptQuery {
  kind: 'configure' | 'check';
  requestId: string;
}
export interface SearchReceipt extends SearchReceiptQuery {
  phase: 'saved' | 'claimed' | 'settled' | 'unknown' | 'superseded';
  revision?: number;
  checkRevision?: number;
  status?: SearchStatus;
}
export type SearchCommand =
  | { type: 'search.status' }
  | { type: 'search.configure'; input: SearchUpdate }
  | { type: 'search.check'; input: SearchCheckRequest }
  | { type: 'search.saved'; query: SearchReceiptQuery };

export const searchErrorCodes = [
  'SEARCH_UNAUTHORIZED',
  'SEARCH_FORBIDDEN',
  'SEARCH_RATE_LIMITED',
  'SEARCH_UNAVAILABLE',
  'SEARCH_TIMEOUT',
  'SEARCH_INVALID_RESPONSE',
  'SEARCH_CONFIG_CHANGED',
  'SEARCH_CANCELLED',
  'SEARCH_OUTCOME_UNKNOWN',
  'SEARCH_LEGACY_UNAVAILABLE',
  'SEARCH_NOT_CONFIGURED',
  'SEARCH_DISABLED',
  'SEARCH_INVALID_QUERY',
  'SEARCH_QUERY_TOO_LONG',
] as const;
export type SearchErrorCode = (typeof searchErrorCodes)[number];
const health: SearchHealth[] = [
  'disabled',
  'unconfigured',
  'unchecked',
  'ready',
  'empty',
  'unauthorized',
  'forbidden',
  'rate-limited',
  'unavailable',
  'timeout',
  'invalid-response',
  'config-changed',
  'cancelled',
  'unknown',
];
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const fields = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
export const isSearchProvider = (value: unknown): value is SearchProvider =>
  value === 'deepseek' || value === 'brave' || value === 'duckduckgo' || value === 'bing';
export function isSearchErrorCode(value: unknown): value is SearchErrorCode {
  return searchErrorCodes.some((code) => code === value);
}
export function validSearchKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\s\p{Cc}]/u.test(value)
  );
}
export function isSearchStatus(value: unknown): value is SearchStatus {
  return (
    object(value) &&
    fields(value, [
      'revision',
      'checkRevision',
      'enabled',
      'provider',
      'credentialConfigured',
      'credentialSource',
      'health',
      'checkedAt',
      'error',
      'retryAfter',
    ]) &&
    revision(value.revision) &&
    revision(value.checkRevision) &&
    typeof value.enabled === 'boolean' &&
    isSearchProvider(value.provider) &&
    typeof value.credentialConfigured === 'boolean' &&
    ['none', 'independent', 'legacy-linked'].includes(String(value.credentialSource)) &&
    value.credentialConfigured === (value.credentialSource !== 'none') &&
    (searchRequiresKey(value.provider) ||
      (value.credentialSource === 'none' && value.health !== 'unconfigured')) &&
    (value.credentialSource !== 'legacy-linked' || value.provider === 'deepseek') &&
    (value.enabled ? value.health !== 'disabled' : value.health === 'disabled') &&
    (value.credentialConfigured ||
      !searchRequiresKey(value.provider) ||
      !value.enabled ||
      value.health === 'unconfigured') &&
    health.includes(value.health as SearchHealth) &&
    (value.checkedAt === undefined ||
      (typeof value.checkedAt === 'string' &&
        value.checkedAt.length === 24 &&
        Number.isFinite(Date.parse(value.checkedAt)) &&
        new Date(value.checkedAt).toISOString() === value.checkedAt)) &&
    (value.error === undefined || isSearchErrorCode(value.error)) &&
    (value.retryAfter === undefined || (revision(value.retryAfter) && value.retryAfter <= 86400))
  );
}
export function isSearchUpdate(value: unknown): value is SearchUpdate {
  return (
    object(value) &&
    fields(value, ['requestId', 'revision', 'enabled', 'provider', 'key']) &&
    validAgentId(value.requestId) &&
    revision(value.revision) &&
    typeof value.enabled === 'boolean' &&
    isSearchProvider(value.provider) &&
    (searchRequiresKey(value.provider) || value.key === undefined || value.key === '') &&
    (value.key === undefined || value.key === '' || validSearchKey(value.key))
  );
}
export function isSearchCheckRequest(value: unknown): value is SearchCheckRequest {
  return (
    object(value) &&
    fields(value, ['requestId', 'revision', 'checkRevision']) &&
    validAgentId(value.requestId) &&
    revision(value.revision) &&
    revision(value.checkRevision)
  );
}
export function isSearchReceiptQuery(value: unknown): value is SearchReceiptQuery {
  return (
    object(value) &&
    fields(value, ['kind', 'requestId']) &&
    (value.kind === 'configure' || value.kind === 'check') &&
    validAgentId(value.requestId)
  );
}
export function isSearchReceipt(value: unknown): value is SearchReceipt {
  if (
    !object(value) ||
    !fields(value, ['kind', 'requestId', 'phase', 'revision', 'checkRevision', 'status']) ||
    !isSearchReceiptQuery({ kind: value.kind, requestId: value.requestId })
  )
    return false;
  if (value.phase === 'superseded') return fields(value, ['kind', 'requestId', 'phase']);
  return (
    (value.kind === 'configure'
      ? value.phase === 'saved'
      : ['claimed', 'settled', 'unknown'].includes(String(value.phase))) &&
    revision(value.revision) &&
    revision(value.checkRevision) &&
    isSearchStatus(value.status) &&
    value.status.revision === value.revision &&
    value.status.checkRevision === value.checkRevision
  );
}
export function isSearchCommand(value: unknown): value is SearchCommand {
  if (!object(value)) return false;
  if (value.type === 'search.status') return fields(value, ['type']);
  if (value.type === 'search.configure')
    return fields(value, ['type', 'input']) && isSearchUpdate(value.input);
  if (value.type === 'search.check')
    return fields(value, ['type', 'input']) && isSearchCheckRequest(value.input);
  if (value.type === 'search.saved')
    return fields(value, ['type', 'query']) && isSearchReceiptQuery(value.query);
  return false;
}

import { validAgentId } from './id.js';

export type PreflightRequirement =
  | { kind: 'model'; vision: boolean; tools: boolean; minContextTokens?: number }
  | { kind: 'search' }
  | { kind: 'computer'; mode: 'linux' | 'local'; access: 'observe' | 'control' }
  | { kind: 'office' }
  | { kind: 'mcp'; connection: string; catalogDigest: string; tool: string };
export type PreflightState = 'ready' | 'missing' | 'unknown' | 'stale' | 'unsupported';
export type PreflightReason =
  | 'CONFIG_PRESENT'
  | 'MODEL_NOT_CONFIGURED'
  | 'MODEL_CAPABILITY_UNKNOWN'
  | 'MODEL_CAPABILITY_MISSING'
  | 'INPUT_BUDGET_TOO_SMALL'
  | 'SEARCH_NOT_CONFIGURED'
  | 'COMPUTER_DISCONNECTED'
  | 'CONTROL_HELD_BY_HUMAN'
  | 'LOCAL_PERMISSION_MISSING'
  | 'LOCAL_SESSION_MISMATCH'
  | 'MCP_NOT_SELECTED'
  | 'MCP_CATALOG_STALE'
  | 'OWNER_UNAVAILABLE'
  | 'CHECK_TIMED_OUT'
  | 'CONFIG_CHANGED'
  | 'CAPABILITY_UNSUPPORTED';
export type PreflightEvidence = 'local-config' | 'local-status' | 'cached-catalog' | 'unavailable';
export type PreflightAction =
  | 'none'
  | 'models'
  | 'search'
  | 'integrations'
  | 'computer'
  | 'environment'
  | 'recheck';
export interface PreflightQuery {
  id: string;
  bot: string;
  requirements: PreflightRequirement[];
}
export interface PreflightCheck {
  index: number;
  state: PreflightState;
  reason: PreflightReason;
  action: PreflightAction;
  evidence: PreflightEvidence;
  observedAt: string;
}
export const preflightSources = [
  'model',
  'profile',
  'mcp',
  'computer',
  'runtime',
  'search',
] as const;
export interface PreflightStamp {
  source: (typeof preflightSources)[number];
  stamp: string | null;
}
export interface PreflightReport {
  schema: 1;
  id: string;
  bot: string;
  workspace: string;
  checkedAt: string;
  freshUntil: string;
  expiresAt: string;
  requirements: PreflightRequirement[];
  versions: PreflightStamp[];
  checks: PreflightCheck[];
  summary: 'ready' | 'attention';
  externalProbe: 'not-run';
  digest: string;
}
export interface PreflightOptionsQuery {
  bot: string;
  cursor?: string;
}
export interface PreflightOptions {
  bot: string;
  workspace: string;
  state: 'ready' | 'empty' | 'unavailable';
  version: string | null;
  truncated: boolean;
  items: {
    connection: string;
    catalogDigest: string;
    tool: string;
    connectionLabel: string;
    toolLabel: string;
  }[];
  next?: string;
}
export interface PreflightRead {
  id: string;
  digest: string;
}
export interface PreflightPackageData {
  schemaVersion: 1;
  productVersion: string;
  protocolVersion: number;
  platform: 'darwin' | 'linux' | 'win32' | 'unknown';
  ageSeconds: number;
  checks: {
    index: number;
    kind: PreflightRequirement['kind'];
    state: PreflightState;
    reason: PreflightReason;
    evidence: PreflightEvidence;
    botAlias: 'bot-1';
    connectionAlias?: string;
    toolAlias?: string;
  }[];
}
export interface PreflightPackage {
  id: string;
  reportDigest: string;
  packageDigest: string;
  json: string;
}
export type PreflightCommand =
  | { type: 'preflight.options'; query: PreflightOptionsQuery }
  | { type: 'preflight.inspect'; query: PreflightQuery }
  | { type: 'preflight.preview' | 'preflight.export'; query: PreflightRead };

export const preflightByteLimit = 128 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const hash = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const alias = (value: unknown): value is string =>
  typeof value === 'string' && /^ext_[a-f0-9]{20}$/.test(value);
const text = (value: unknown, max: number): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  [...value].every((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127);
const cursor = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,1024}$/.test(value);
const array = (value: unknown, max: number): value is unknown[] =>
  Array.isArray(value) &&
  value.length <= max &&
  Array.from(value).every((entry) => entry !== undefined);
const iso = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
};
const states: readonly string[] = ['ready', 'missing', 'unknown', 'stale', 'unsupported'];
const reasons: readonly string[] = [
  'CONFIG_PRESENT',
  'MODEL_NOT_CONFIGURED',
  'MODEL_CAPABILITY_UNKNOWN',
  'MODEL_CAPABILITY_MISSING',
  'INPUT_BUDGET_TOO_SMALL',
  'SEARCH_NOT_CONFIGURED',
  'COMPUTER_DISCONNECTED',
  'CONTROL_HELD_BY_HUMAN',
  'LOCAL_PERMISSION_MISSING',
  'LOCAL_SESSION_MISMATCH',
  'MCP_NOT_SELECTED',
  'MCP_CATALOG_STALE',
  'OWNER_UNAVAILABLE',
  'CHECK_TIMED_OUT',
  'CONFIG_CHANGED',
  'CAPABILITY_UNSUPPORTED',
];
const evidence: readonly string[] = [
  'local-config',
  'local-status',
  'cached-catalog',
  'unavailable',
];
const actions: readonly string[] = [
  'none',
  'models',
  'search',
  'integrations',
  'computer',
  'environment',
  'recheck',
];
const kinds: readonly string[] = ['model', 'search', 'computer', 'office', 'mcp'];
const bytes = (value: string) => new TextEncoder().encode(value).length;

export function preflightJson(value: unknown, depth = 0): string {
  if (depth > 16) throw new Error('INVALID_PREFLIGHT_JSON');
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${Array.from(value, (entry) => preflightJson(entry, depth + 1)).join(',')}]`;
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value)))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${preflightJson(value[key], depth + 1)}`)
      .join(',')}}`;
  throw new Error('INVALID_PREFLIGHT_JSON');
}
export function isPreflightRequirement(value: unknown): value is PreflightRequirement {
  if (!object(value)) return false;
  switch (value.kind) {
    case 'model':
      return (
        keys(value, ['kind', 'vision', 'tools', 'minContextTokens']) &&
        typeof value.vision === 'boolean' &&
        typeof value.tools === 'boolean' &&
        (!Object.hasOwn(value, 'minContextTokens') ||
          (Number.isSafeInteger(value.minContextTokens) &&
            Number(value.minContextTokens) >= 1 &&
            Number(value.minContextTokens) <= 1000000))
      );
    case 'search':
    case 'office':
      return keys(value, ['kind']);
    case 'computer':
      return (
        keys(value, ['kind', 'mode', 'access']) &&
        ['linux', 'local'].includes(String(value.mode)) &&
        ['observe', 'control'].includes(String(value.access))
      );
    case 'mcp':
      return (
        keys(value, ['kind', 'connection', 'catalogDigest', 'tool']) &&
        validAgentId(value.connection) &&
        hash(value.catalogDigest) &&
        alias(value.tool)
      );
    default:
      return false;
  }
}
function requirements(value: unknown): value is PreflightRequirement[] {
  if (!array(value, 16) || !value.length || !value.every(isPreflightRequirement)) return false;
  if (value.filter((entry) => entry.kind === 'mcp').length > 10) return false;
  const ids = value.map((entry) =>
    entry.kind === 'mcp' ? `${entry.kind}:${entry.connection}:${entry.tool}` : entry.kind,
  );
  return new Set(ids).size === value.length;
}
export function isPreflightQuery(value: unknown): value is PreflightQuery {
  return (
    object(value) &&
    keys(value, ['id', 'bot', 'requirements']) &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    requirements(value.requirements)
  );
}
export function preflightQueryKey(query: PreflightQuery) {
  return preflightJson({ bot: query.bot, requirements: query.requirements });
}
export function isPreflightRead(value: unknown): value is PreflightRead {
  return (
    object(value) && keys(value, ['id', 'digest']) && validAgentId(value.id) && hash(value.digest)
  );
}
export function isPreflightOptionsQuery(value: unknown): value is PreflightOptionsQuery {
  return (
    object(value) &&
    keys(value, ['bot', 'cursor']) &&
    validAgentId(value.bot) &&
    (value.cursor === undefined || cursor(value.cursor))
  );
}
export function isPreflightCommand(value: unknown): value is PreflightCommand {
  if (!object(value) || !keys(value, ['type', 'query'])) return false;
  if (value.type === 'preflight.options') return isPreflightOptionsQuery(value.query);
  if (value.type === 'preflight.inspect') return isPreflightQuery(value.query);
  return (
    (value.type === 'preflight.preview' || value.type === 'preflight.export') &&
    isPreflightRead(value.query)
  );
}
function result(value: Record<string, unknown>) {
  return (
    states.includes(String(value.state)) &&
    reasons.includes(String(value.reason)) &&
    (value.state === 'ready') === (value.reason === 'CONFIG_PRESENT') &&
    evidence.includes(String(value.evidence))
  );
}
export function preflightReportData(report: PreflightReport): Omit<PreflightReport, 'digest'> {
  return {
    schema: report.schema,
    id: report.id,
    bot: report.bot,
    workspace: report.workspace,
    checkedAt: report.checkedAt,
    freshUntil: report.freshUntil,
    expiresAt: report.expiresAt,
    requirements: report.requirements,
    versions: report.versions,
    checks: report.checks,
    summary: report.summary,
    externalProbe: report.externalProbe,
  };
}
export function isPreflightReport(value: unknown): value is PreflightReport {
  if (
    !object(value) ||
    !keys(value, [
      'schema',
      'id',
      'bot',
      'workspace',
      'checkedAt',
      'freshUntil',
      'expiresAt',
      'requirements',
      'versions',
      'checks',
      'summary',
      'externalProbe',
      'digest',
    ]) ||
    value.schema !== 1 ||
    !validAgentId(value.id) ||
    !validAgentId(value.bot) ||
    !validAgentId(value.workspace) ||
    !hash(value.digest) ||
    !iso(value.checkedAt) ||
    !iso(value.freshUntil) ||
    !iso(value.expiresAt) ||
    Date.parse(value.freshUntil) - Date.parse(value.checkedAt) !== 30000 ||
    Date.parse(value.expiresAt) - Date.parse(value.checkedAt) !== 300000 ||
    !requirements(value.requirements) ||
    !array(value.checks, 16) ||
    value.checks.length !== value.requirements.length ||
    !array(value.versions, 6) ||
    value.versions.length !== 6 ||
    value.externalProbe !== 'not-run'
  )
    return false;
  const checks = value.checks;
  if (
    !checks.every(
      (entry, index) =>
        object(entry) &&
        keys(entry, ['index', 'state', 'reason', 'action', 'evidence', 'observedAt']) &&
        entry.index === index &&
        result(entry) &&
        actions.includes(String(entry.action)) &&
        iso(entry.observedAt),
    )
  )
    return false;
  if (
    !value.versions.every(
      (entry) =>
        object(entry) &&
        keys(entry, ['source', 'stamp']) &&
        preflightSources.some((source) => source === entry.source) &&
        (entry.stamp === null || hash(entry.stamp)),
    ) ||
    new Set(value.versions.map((entry) => (entry as Record<string, unknown>).source)).size !== 6
  )
    return false;
  return (
    value.summary ===
      (checks.every((entry) => (entry as Record<string, unknown>).state === 'ready')
        ? 'ready'
        : 'attention') && bytes(preflightJson(value)) <= preflightByteLimit
  );
}
export function isPreflightOptions(value: unknown): value is PreflightOptions {
  if (
    !object(value) ||
    !keys(value, ['bot', 'workspace', 'state', 'version', 'truncated', 'items', 'next']) ||
    !validAgentId(value.bot) ||
    !validAgentId(value.workspace) ||
    typeof value.truncated !== 'boolean' ||
    !array(value.items, 50) ||
    (value.next !== undefined && !cursor(value.next))
  )
    return false;
  if (value.state === 'unavailable')
    return (
      value.version === null && !value.items.length && !value.truncated && value.next === undefined
    );
  if (
    !hash(value.version) ||
    !['ready', 'empty'].includes(String(value.state)) ||
    (value.state === 'ready') !== value.items.length > 0 ||
    (value.state === 'empty' && value.next !== undefined)
  )
    return false;
  const ids: string[] = [];
  for (const entry of value.items) {
    if (
      !object(entry) ||
      !keys(entry, ['connection', 'catalogDigest', 'tool', 'connectionLabel', 'toolLabel']) ||
      !validAgentId(entry.connection) ||
      !hash(entry.catalogDigest) ||
      !alias(entry.tool) ||
      !text(entry.connectionLabel, 80) ||
      !text(entry.toolLabel, 120)
    )
      return false;
    ids.push(`${entry.connection}:${entry.tool}`);
  }
  return (
    new Set(ids).size === ids.length &&
    value.items.every((entry, index, all) => {
      if (index === 0) return true;
      const current = entry as Record<string, string>,
        previous = all[index - 1] as Record<string, string>;
      return (
        previous.connection < current.connection ||
        (previous.connection === current.connection && previous.tool < current.tool)
      );
    }) &&
    bytes(preflightJson(value)) <= preflightByteLimit
  );
}
export function isPreflightPackageData(value: unknown): value is PreflightPackageData {
  return (
    object(value) &&
    keys(value, [
      'schemaVersion',
      'productVersion',
      'protocolVersion',
      'platform',
      'ageSeconds',
      'checks',
    ]) &&
    value.schemaVersion === 1 &&
    typeof value.productVersion === 'string' &&
    /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value.productVersion) &&
    value.productVersion.length <= 80 &&
    Number.isSafeInteger(value.protocolVersion) &&
    Number(value.protocolVersion) >= 1 &&
    ['darwin', 'linux', 'win32', 'unknown'].includes(String(value.platform)) &&
    Number.isSafeInteger(value.ageSeconds) &&
    Number(value.ageSeconds) >= 0 &&
    Number(value.ageSeconds) <= 300 &&
    array(value.checks, 16) &&
    value.checks.length > 0 &&
    value.checks.every(
      (entry, index) =>
        object(entry) &&
        keys(entry, [
          'index',
          'kind',
          'state',
          'reason',
          'evidence',
          'botAlias',
          'connectionAlias',
          'toolAlias',
        ]) &&
        entry.index === index &&
        kinds.includes(String(entry.kind)) &&
        result(entry) &&
        entry.botAlias === 'bot-1' &&
        (entry.kind === 'mcp'
          ? typeof entry.connectionAlias === 'string' &&
            /^connection-(?:[1-9]|10)$/.test(entry.connectionAlias) &&
            typeof entry.toolAlias === 'string' &&
            /^tool-(?:[1-9]|10)$/.test(entry.toolAlias)
          : entry.connectionAlias === undefined && entry.toolAlias === undefined),
    ) &&
    bytes(preflightJson(value)) <= preflightByteLimit
  );
}
export function isPreflightPackage(value: unknown): value is PreflightPackage {
  if (
    !object(value) ||
    !keys(value, ['id', 'reportDigest', 'packageDigest', 'json']) ||
    !validAgentId(value.id) ||
    !hash(value.reportDigest) ||
    !hash(value.packageDigest) ||
    typeof value.json !== 'string' ||
    bytes(value.json) > preflightByteLimit
  )
    return false;
  try {
    const data: unknown = JSON.parse(value.json);
    return (
      isPreflightPackageData(data) &&
      preflightJson(data) === value.json &&
      bytes(preflightJson(value)) <= preflightByteLimit
    );
  } catch {
    return false;
  }
}

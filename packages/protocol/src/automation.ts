import { validAgentId } from './id.js';
import { isProjectScope, type ProjectScope } from './projects.js';

// Origin metadata keeps ordinary scheduled tasks and historical receipts bound to their owner.
// File observation and quiet result monitoring are no longer execution capabilities.
type MonitorPolicy = { kind: 'all' } | { kind: 'changes'; signalPath: string };
export interface AutomationSource {
  scheduleId: string;
  firingId: string;
  configRevision: number;
  trigger: 'time' | 'manual' | 'file';
  policy: MonitorPolicy;
  scope?: ProjectScope;
  paths?: string[];
  fromCursor?: number;
  toCursor?: number;
  before?: string;
  after?: string;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
const isAutomationDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function isAutomationPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !/[\\\0*?[\]:]/.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..')
  );
}
function isMonitorPolicy(value: unknown): value is MonitorPolicy {
  return (
    object(value) &&
    ((value.kind === 'all' && keys(value, ['kind'])) ||
      (value.kind === 'changes' &&
        keys(value, ['kind', 'signalPath']) &&
        isAutomationPath(value.signalPath)))
  );
}
export function isAutomationSource(value: unknown): value is AutomationSource {
  return (
    object(value) &&
    keys(value, [
      'scheduleId',
      'firingId',
      'configRevision',
      'trigger',
      'policy',
      'scope',
      'paths',
      'fromCursor',
      'toCursor',
      'before',
      'after',
    ]) &&
    validAgentId(value.scheduleId) &&
    validAgentId(value.firingId) &&
    integer(value.configRevision, 1) &&
    typeof value.trigger === 'string' &&
    ['time', 'manual', 'file'].includes(value.trigger) &&
    isMonitorPolicy(value.policy) &&
    (value.scope === undefined || isProjectScope(value.scope)) &&
    (value.paths === undefined ||
      (Array.isArray(value.paths) &&
        value.paths.length >= 1 &&
        value.paths.length <= 20 &&
        value.paths.every(isAutomationPath) &&
        new Set(value.paths).size === value.paths.length)) &&
    (value.fromCursor === undefined || integer(value.fromCursor, 1)) &&
    (value.toCursor === undefined ||
      (integer(value.toCursor, 1) && Number(value.toCursor) >= Number(value.fromCursor))) &&
    (value.before === undefined || isAutomationDigest(value.before)) &&
    (value.after === undefined || isAutomationDigest(value.after)) &&
    (value.trigger !== 'file' ||
      (isProjectScope(value.scope) &&
        Array.isArray(value.paths) &&
        integer(value.fromCursor, 1) &&
        integer(value.toCursor, 1) &&
        isAutomationDigest(value.before) &&
        isAutomationDigest(value.after)))
  );
}

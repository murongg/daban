import { validAgentId } from './id.js';
import { isProjectScope, type ProjectScope } from './projects.js';

export const automationCapability = 'schedule-automation-v1';
export const fileObservationCapability = 'file-observation-read-v1';
export interface FileTrigger {
  kind: 'file';
  scope: ProjectScope;
  paths: string[];
  pollSeconds: number;
}
export type MonitorPolicy = { kind: 'all' } | { kind: 'changes'; signalPath: string };
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
export type MonitorDecision = 'all' | 'baseline' | 'unchanged' | 'changed' | 'fault' | 'recovered';
export interface AutomationView {
  configRevision: number;
  policy: MonitorPolicy;
  initialized: boolean;
  cursor: number;
  committed?: string;
  candidate?: string;
  count: number;
  nextPollAt?: string;
  error?: string;
}
export interface AutomationNotice {
  kind: 'automation';
  id: string;
  bot: string;
  schedule: string;
  phase: 'completed' | 'failed' | 'interrupted';
  reason: 'changed' | 'fault' | 'recovered';
  runId?: string;
  code?: string;
  firing?: string;
  createdAt?: string;
}
export type AutomationCommand =
  | { type: 'schedule.monitor'; id: string; revision: number; policy: MonitorPolicy }
  | { type: 'schedule.receipt'; id: string; firing: string }
  | { type: 'schedule.ack'; id: string; notice: string };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const integer = (value: unknown, min = 0) => Number.isSafeInteger(value) && Number(value) >= min;
export const isAutomationDigest = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const isAutomationCode = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z_]{1,100}$/.test(value);
export function isAutomationPath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith('/') &&
    !/[\\\0*?[\]:]/.test(value) &&
    value.split('/').every((part) => !!part && part !== '.' && part !== '..')
  );
}
export function isFileTrigger(value: unknown): value is FileTrigger {
  return (
    object(value) &&
    keys(value, ['kind', 'scope', 'paths', 'pollSeconds']) &&
    value.kind === 'file' &&
    isProjectScope(value.scope) &&
    Array.isArray(value.paths) &&
    value.paths.length >= 1 &&
    value.paths.length <= 20 &&
    value.paths.every(isAutomationPath) &&
    new Set(value.paths).size === value.paths.length &&
    integer(value.pollSeconds, 60) &&
    Number(value.pollSeconds) <= 86400
  );
}
export function isMonitorPolicy(value: unknown): value is MonitorPolicy {
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
export function isMonitorDecision(value: unknown): value is MonitorDecision {
  return (
    typeof value === 'string' &&
    ['all', 'baseline', 'unchanged', 'changed', 'fault', 'recovered'].includes(value)
  );
}
export function isAutomationView(value: unknown): value is AutomationView {
  return (
    object(value) &&
    keys(value, [
      'configRevision',
      'policy',
      'initialized',
      'cursor',
      'committed',
      'candidate',
      'count',
      'nextPollAt',
      'error',
    ]) &&
    integer(value.configRevision, 1) &&
    isMonitorPolicy(value.policy) &&
    typeof value.initialized === 'boolean' &&
    integer(value.cursor) &&
    integer(value.count) &&
    Number(value.count) <= 2 &&
    (value.committed === undefined || isAutomationDigest(value.committed)) &&
    (value.candidate === undefined || isAutomationDigest(value.candidate)) &&
    (value.nextPollAt === undefined ||
      (typeof value.nextPollAt === 'string' && Number.isFinite(Date.parse(value.nextPollAt)))) &&
    (value.error === undefined || isAutomationCode(value.error))
  );
}
export function isAutomationNotice(value: unknown): value is AutomationNotice {
  return (
    object(value) &&
    keys(value, [
      'kind',
      'id',
      'bot',
      'schedule',
      'phase',
      'reason',
      'runId',
      'code',
      'firing',
      'createdAt',
    ]) &&
    value.kind === 'automation' &&
    validAgentId(value.id) &&
    validAgentId(value.bot) &&
    validAgentId(value.schedule) &&
    typeof value.phase === 'string' &&
    ['completed', 'failed', 'interrupted'].includes(value.phase) &&
    typeof value.reason === 'string' &&
    ['changed', 'fault', 'recovered'].includes(value.reason) &&
    (value.runId === undefined || validAgentId(value.runId)) &&
    (value.code === undefined || isAutomationCode(value.code)) &&
    (value.firing === undefined || validAgentId(value.firing)) &&
    (value.createdAt === undefined ||
      (typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))))
  );
}
export function isAutomationCommand(value: unknown): value is AutomationCommand {
  if (!object(value) || !validAgentId(value.id)) return false;
  if (value.type === 'schedule.monitor')
    return (
      keys(value, ['type', 'id', 'revision', 'policy']) &&
      integer(value.revision, 1) &&
      isMonitorPolicy(value.policy)
    );
  if (value.type === 'schedule.receipt')
    return keys(value, ['type', 'id', 'firing']) && validAgentId(value.firing);
  return (
    value.type === 'schedule.ack' &&
    keys(value, ['type', 'id', 'notice']) &&
    validAgentId(value.notice)
  );
}

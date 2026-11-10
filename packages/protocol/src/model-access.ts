import {
  isModelId,
  isModelInspectionRequest,
  isModelKey,
  isModelStatus,
  isSessionStats,
  type ModelEndpoint,
  type ModelId,
  type ModelStatus,
  modelReference,
  type SessionStats,
  validAgentId,
} from './index.js';

export interface ModelAccess {
  scope: string;
  fallback: true;
  diagnostics: true;
  cli: boolean;
}
interface ModelIntent {
  scope: string;
  requestId: string;
  revision: number;
}
export interface ModelSavedRequest extends ModelIntent {
  connection: string;
  model: ModelId;
}
export interface ModelFallbackRequest extends ModelIntent {
  model: ModelId | null;
}
export interface ModelRemoveRequest extends ModelIntent {
  connection: string;
  disconnect?: true;
}
export interface ModelDiagnoseRequest extends ModelIntent {
  probeRevision: number;
  connection: ModelEndpoint;
  model: string;
  apiKey?: string;
  kind: 'list' | 'inference';
}
export interface ModelDiagnostic {
  kind: 'list' | 'inference';
  model: ModelId;
  checkedAt: string;
  latencyMs: number;
}
export interface ModelSaved extends ModelSavedRequest {
  kind: 'configure' | 'fallback' | 'remove' | 'diagnose';
  phase: 'claimed' | 'committed' | 'failed' | 'unknown' | 'settled' | 'superseded' | 'missing';
  committedRevision?: number;
  error?: string;
  diagnostic?: ModelDiagnostic;
  references?: ModelReference[];
  current: ModelStatus;
}
export type ModelReference = 'default' | 'bot' | 'fallback' | 'search' | 'running';
export type ModelFailureKind =
  | 'auth'
  | 'quota'
  | 'rate-limit'
  | 'unavailable'
  | 'timeout'
  | 'unknown';
export type ModelAttemptFence = 'clean' | 'output' | 'tool' | 'unknown';
export interface ModelAttempt {
  attemptId: string;
  model: ModelId;
  phase: 'starting' | 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  fence: ModelAttemptFence;
  failure?: ModelFailureKind;
  createdAt: string;
  finishedAt?: string;
  usage: 'unknown';
  stats?: SessionStats;
}
export function isModelAttempt(value: unknown): value is ModelAttempt {
  return (
    object(value) &&
    keys(value, [
      'attemptId',
      'model',
      'phase',
      'fence',
      'failure',
      'createdAt',
      'finishedAt',
      'usage',
      'stats',
    ]) &&
    validAgentId(value.attemptId) &&
    isModelId(value.model) &&
    ['starting', 'running', 'completed', 'failed', 'stopped', 'interrupted'].includes(
      String(value.phase),
    ) &&
    ['clean', 'output', 'tool', 'unknown'].includes(String(value.fence)) &&
    (value.failure === undefined ||
      ['auth', 'quota', 'rate-limit', 'unavailable', 'timeout', 'unknown'].includes(
        String(value.failure),
      )) &&
    typeof value.createdAt === 'string' &&
    value.createdAt.length === 24 &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    (value.finishedAt === undefined ||
      (typeof value.finishedAt === 'string' &&
        value.finishedAt.length === 24 &&
        Number.isFinite(Date.parse(value.finishedAt)))) &&
    value.usage === 'unknown' &&
    (value.stats === undefined || isSessionStats(value.stats))
  );
}
export function isModelAttempts(value: unknown): value is ModelAttempt[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 2 &&
    value.every(isModelAttempt) &&
    new Set(value.map((item) => item.attemptId)).size === value.length
  );
}
export function modelRecoveryBlocked(task: { trace?: unknown[]; attemptSummary?: ModelAttempt[] }) {
  return (
    task.attemptSummary?.some((attempt) => attempt.fence === 'unknown') === true ||
    (task.trace || []).some(
      (entry) =>
        object(entry) &&
        (entry.phase === 'running' ||
          (typeof entry.code === 'string' &&
            (entry.code.endsWith('_OUTCOME_UNKNOWN') || entry.code.endsWith('_UNCERTAIN')))),
    )
  );
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const revision = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const intent = (value: unknown): value is Record<string, unknown> =>
  object(value) &&
  validAgentId(value.scope) &&
  validAgentId(value.requestId) &&
  revision(value.revision);
export function isModelAccess(value: unknown): value is ModelAccess {
  return (
    object(value) &&
    keys(value, ['scope', 'fallback', 'diagnostics', 'cli']) &&
    validAgentId(value.scope) &&
    value.fallback === true &&
    value.diagnostics === true &&
    typeof value.cli === 'boolean'
  );
}
export function isModelSavedRequest(value: unknown): value is ModelSavedRequest {
  return (
    intent(value) &&
    keys(value, ['scope', 'requestId', 'revision', 'connection', 'model']) &&
    validAgentId(value.connection) &&
    isModelId(value.model)
  );
}
export function isModelFallbackRequest(value: unknown): value is ModelFallbackRequest {
  return (
    intent(value) &&
    keys(value, ['scope', 'requestId', 'revision', 'model']) &&
    (value.model === null || isModelId(value.model))
  );
}
export function isModelRemoveRequest(value: unknown): value is ModelRemoveRequest {
  return (
    intent(value) &&
    keys(value, ['scope', 'requestId', 'revision', 'connection', 'disconnect']) &&
    validAgentId(value.connection) &&
    (value.disconnect === undefined || value.disconnect === true)
  );
}
export function isModelDiagnoseRequest(value: unknown): value is ModelDiagnoseRequest {
  if (
    !intent(value) ||
    !keys(value, [
      'scope',
      'requestId',
      'revision',
      'probeRevision',
      'connection',
      'model',
      'apiKey',
      'kind',
    ]) ||
    !revision(value.probeRevision) ||
    !['list', 'inference'].includes(String(value.kind)) ||
    typeof value.model !== 'string' ||
    (value.apiKey !== undefined && !isModelKey(value.apiKey))
  )
    return false;
  return isModelInspectionRequest({
    kind: 'test',
    connection: value.connection,
    model: value.model,
    revision: value.revision,
    ...(value.apiKey ? { apiKey: value.apiKey } : {}),
  });
}
export function isModelDiagnostic(value: unknown): value is ModelDiagnostic {
  return (
    object(value) &&
    keys(value, ['kind', 'model', 'checkedAt', 'latencyMs']) &&
    ['list', 'inference'].includes(String(value.kind)) &&
    isModelId(value.model) &&
    typeof value.checkedAt === 'string' &&
    value.checkedAt.length === 24 &&
    Number.isFinite(Date.parse(value.checkedAt)) &&
    revision(value.latencyMs) &&
    Number(value.latencyMs) <= 120000
  );
}
export function isModelSaved(value: unknown): value is ModelSaved {
  return (
    intent(value) &&
    keys(value, [
      'scope',
      'requestId',
      'revision',
      'connection',
      'model',
      'kind',
      'phase',
      'committedRevision',
      'error',
      'diagnostic',
      'references',
      'current',
    ]) &&
    validAgentId(value.connection) &&
    isModelId(value.model) &&
    ['configure', 'fallback', 'remove', 'diagnose'].includes(String(value.kind)) &&
    ['claimed', 'committed', 'failed', 'unknown', 'settled', 'superseded', 'missing'].includes(
      String(value.phase),
    ) &&
    (value.committedRevision === undefined ||
      (revision(value.committedRevision) &&
        value.committedRevision === Number(value.revision) + 1)) &&
    (value.error === undefined ||
      (typeof value.error === 'string' && /^[A-Z_]{1,100}$/.test(value.error))) &&
    (value.diagnostic === undefined || isModelDiagnostic(value.diagnostic)) &&
    (value.references === undefined ||
      (Array.isArray(value.references) &&
        value.references.length <= 5 &&
        value.references.every((item) =>
          ['default', 'bot', 'fallback', 'search', 'running'].includes(String(item)),
        ))) &&
    isModelStatus(value.current)
  );
}
export function diagnosticModel(input: ModelDiagnoseRequest) {
  return modelReference(input.connection.id, input.model);
}

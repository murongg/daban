import { validAgentId } from './id.js';

export const deliveryPhases = [
  'accepted',
  'running',
  'ready',
  'failed',
  'stopped',
  'unknown',
  'accepted-by-user',
  'rejected',
] as const;
export type DeliveryPhase = (typeof deliveryPhases)[number];
export interface DeliveryCriterion {
  id: string;
  text: string;
  kind: 'text' | 'file';
  required: boolean;
}
export interface DeliveryChecklist {
  workId: string;
  revision: number;
  items: DeliveryCriterion[];
}
export interface DeliveryReference {
  attemptId: string;
  workId: string;
  requestId: string;
}
export interface DeliveryOutputRef {
  bot: string;
  runId: string;
  path: string;
}
export interface DeliveryArtifact extends DeliveryOutputRef {
  size: number;
  sha256: string;
  checkedAt: string;
}
export interface DeliveryFileEvidence extends DeliveryOutputRef {
  criterionId: string;
  source: 'file-check';
  size: number;
  sha256: string;
  checkedAt: string;
  available: boolean;
}
export interface DeliveryTextEvidence {
  criterionId: string;
  source: 'model-report';
  bot: string;
  runId: string;
  checkedAt: string;
}
export type DeliveryEvidence = DeliveryFileEvidence | DeliveryTextEvidence;
export interface DeliveryResult {
  bot: string;
  runId: string;
  text: string;
  source: 'model-report';
}
export interface DeliveryDecisionRecord {
  action: 'accept' | 'reject' | 'close-unknown';
  checked: string[];
  reason: string;
  at: string;
  criteria: DeliveryCriterion[];
  evidence: DeliveryEvidence[];
}
export interface DeliveryAttempt extends DeliveryReference {
  sequence: number;
  revision: number;
  workRevision: number;
  ownershipRevision: number;
  bot: string;
  title: string;
  description: string;
  checklist: DeliveryChecklist;
  phase: DeliveryPhase;
  createdAt: string;
  updatedAt: string;
  runId?: string;
  error: string;
  results: DeliveryResult[];
  outputs: DeliveryOutputRef[];
  evidence: DeliveryEvidence[];
  groups: { groupId: string; sourceId: string }[];
  queriedAt?: string;
  decision?: DeliveryDecisionRecord;
}
export interface DeliveryChecklistWrite {
  requestId: string;
  workId: string;
  workRevision: number;
  checklistRevision: number;
  items: DeliveryCriterion[];
}
export interface DeliveryStart {
  requestId: string;
  workId: string;
  workRevision: number;
  checklistRevision: number;
  bot: string;
}
export interface DeliveryTarget {
  requestId: string;
  workId: string;
  workRevision: number;
  attemptId: string;
  attemptRevision: number;
}
export interface DeliveryFileBind extends DeliveryTarget {
  criterionId: string;
  output: DeliveryOutputRef;
}
export interface DeliveryDecision extends DeliveryTarget {
  action: 'accept' | 'reject' | 'close-unknown';
  checked: string[];
  reason: string;
  confirmed: boolean;
}
export interface DeliveryQuery {
  workId: string;
  before?: number;
  limit?: number;
}
export interface DeliveryPage {
  workId: string;
  checklist: DeliveryChecklist;
  attempts: DeliveryAttempt[];
  nextBefore?: number;
}
export type DeliveryWrite =
  | DeliveryChecklistWrite
  | DeliveryStart
  | DeliveryFileBind
  | DeliveryDecision
  | DeliveryTarget;
export type DeliveryReceipt =
  | { state: 'unknown'; request: DeliveryWrite }
  | { state: 'complete'; request: DeliveryWrite; checklist: DeliveryChecklist }
  | { state: 'complete'; request: DeliveryWrite; attempt: DeliveryAttempt };
export type DeliveryCommand =
  | { type: 'delivery.get'; query: DeliveryQuery }
  | { type: 'delivery.checklist.get'; query: { workId: string } }
  | {
      type: 'delivery.checklist.write' | 'delivery.checklist.receipt';
      request: DeliveryChecklistWrite;
    }
  | { type: 'delivery.start' | 'delivery.receipt'; request: DeliveryStart }
  | { type: 'delivery.file.bind' | 'delivery.file.bind-receipt'; request: DeliveryFileBind }
  | { type: 'delivery.decide' | 'delivery.decision-receipt'; request: DeliveryDecision }
  | { type: 'delivery.stop' | 'delivery.stop-receipt'; request: DeliveryTarget };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));
const keys = (value: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(value, key)) &&
  Object.keys(value).every((key) => [...required, ...optional].includes(key));
const text = (value: unknown, max: number, empty = false): value is string =>
  typeof value === 'string' &&
  !value.includes('\0') &&
  Array.from(value).length <= max &&
  (empty || !!value.trim());
const revision = (value: unknown, minimum = 1): value is number =>
  Number.isSafeInteger(value) && Number(value) >= minimum;
const time = (value: unknown): value is string =>
  text(value, 40) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
export const deliveryPath = (value: unknown): value is string =>
  text(value, 512) &&
  !value.startsWith('/') &&
  !value.includes('\\') &&
  value.split('/').every((part) => !!part && part !== '.' && part !== '..');
export function isDeliveryCriteria(value: unknown): value is DeliveryCriterion[] {
  return (
    Array.isArray(value) &&
    value.length <= 20 &&
    value.every(
      (item) =>
        object(item) &&
        keys(item, ['id', 'text', 'kind', 'required']) &&
        validAgentId(item.id) &&
        text(item.text, 300) &&
        ['text', 'file'].includes(String(item.kind)) &&
        typeof item.required === 'boolean',
    ) &&
    new Set(value.map((item) => item.id)).size === value.length
  );
}
export function isDeliveryChecklist(value: unknown): value is DeliveryChecklist {
  return (
    object(value) &&
    keys(value, ['workId', 'revision', 'items']) &&
    validAgentId(value.workId) &&
    revision(value.revision, 0) &&
    isDeliveryCriteria(value.items)
  );
}
export function isDeliveryReference(value: unknown): value is DeliveryReference {
  return (
    object(value) &&
    keys(value, ['attemptId', 'workId', 'requestId']) &&
    [value.attemptId, value.workId, value.requestId].every(validAgentId)
  );
}
export function deliveryReferenceKey(value: DeliveryReference) {
  return JSON.stringify({
    attemptId: value.attemptId,
    workId: value.workId,
    requestId: value.requestId,
  });
}
export function sameDeliveryReference(
  left: DeliveryReference | undefined,
  right: DeliveryReference | undefined,
) {
  return !!left && !!right && deliveryReferenceKey(left) === deliveryReferenceKey(right);
}
export function isDeliveryOutput(value: unknown): value is DeliveryOutputRef {
  return (
    object(value) &&
    keys(value, ['bot', 'runId', 'path']) &&
    validAgentId(value.bot) &&
    validAgentId(value.runId) &&
    deliveryPath(value.path)
  );
}
export function isDeliveryQuery(value: unknown): value is DeliveryQuery {
  return (
    object(value) &&
    keys(value, ['workId'], ['before', 'limit']) &&
    validAgentId(value.workId) &&
    (value.before === undefined || revision(value.before)) &&
    (value.limit === undefined || (revision(value.limit) && value.limit <= 50))
  );
}
function target(value: Record<string, unknown>) {
  return (
    [value.requestId, value.workId, value.attemptId].every(validAgentId) &&
    revision(value.workRevision) &&
    revision(value.attemptRevision)
  );
}
const targetKeys = ['requestId', 'workId', 'workRevision', 'attemptId', 'attemptRevision'];
export function isDeliveryWrite(action: string, value: unknown): value is DeliveryWrite {
  if (!object(value)) return false;
  if (action === 'checklist.write')
    return (
      keys(value, ['requestId', 'workId', 'workRevision', 'checklistRevision', 'items']) &&
      validAgentId(value.requestId) &&
      validAgentId(value.workId) &&
      revision(value.workRevision) &&
      revision(value.checklistRevision, 0) &&
      isDeliveryCriteria(value.items)
    );
  if (action === 'start')
    return (
      keys(value, ['requestId', 'workId', 'workRevision', 'checklistRevision', 'bot']) &&
      [value.requestId, value.workId, value.bot].every(validAgentId) &&
      revision(value.workRevision) &&
      revision(value.checklistRevision, 0)
    );
  if (action === 'file.bind')
    return (
      keys(value, [...targetKeys, 'criterionId', 'output']) &&
      target(value) &&
      validAgentId(value.criterionId) &&
      isDeliveryOutput(value.output)
    );
  if (action === 'decide')
    return (
      keys(value, [...targetKeys, 'action', 'checked', 'reason', 'confirmed']) &&
      target(value) &&
      ['accept', 'reject', 'close-unknown'].includes(String(value.action)) &&
      Array.isArray(value.checked) &&
      value.checked.length <= 20 &&
      value.checked.every(validAgentId) &&
      new Set(value.checked).size === value.checked.length &&
      text(value.reason, 2000, value.action === 'accept') &&
      value.confirmed === true
    );
  return action === 'stop' && keys(value, targetKeys) && target(value);
}
export function deliveryAction(type: string) {
  return (
    (
      {
        receipt: 'start',
        'checklist.receipt': 'checklist.write',
        'file.bind-receipt': 'file.bind',
        'decision-receipt': 'decide',
        'stop-receipt': 'stop',
      } as Record<string, string>
    )[type] ?? type
  );
}
export function isDeliveryCommand(value: unknown): value is DeliveryCommand {
  if (!object(value) || typeof value.type !== 'string' || !value.type.startsWith('delivery.'))
    return false;
  const action = value.type.slice(9);
  if (action === 'get' || action === 'checklist.get')
    return (
      keys(value, ['type', 'query']) &&
      isDeliveryQuery(value.query) &&
      (action === 'get' || Object.keys(value.query).length === 1)
    );
  return keys(value, ['type', 'request']) && isDeliveryWrite(deliveryAction(action), value.request);
}
export function deliveryKey(action: string, value: DeliveryWrite) {
  const canonical = (input: unknown): unknown =>
    Array.isArray(input)
      ? input.map(canonical)
      : object(input)
        ? Object.fromEntries(
            Object.keys(input)
              .sort()
              .map((key) => [key, canonical(input[key])]),
          )
        : input;
  return JSON.stringify(['daban.delivery.v1', action, canonical(value)]);
}
export function isDeliveryEvidence(value: unknown): value is DeliveryEvidence {
  if (object(value) && value.source === 'model-report')
    return (
      keys(value, ['criterionId', 'source', 'bot', 'runId', 'checkedAt']) &&
      [value.criterionId, value.bot, value.runId].every(validAgentId) &&
      time(value.checkedAt)
    );
  if (
    !object(value) ||
    !keys(value, [
      'criterionId',
      'source',
      'bot',
      'runId',
      'path',
      'size',
      'sha256',
      'checkedAt',
      'available',
    ])
  )
    return false;
  return (
    validAgentId(value.criterionId) &&
    value.source === 'file-check' &&
    isDeliveryOutput({ bot: value.bot, runId: value.runId, path: value.path }) &&
    revision(value.size, 0) &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    time(value.checkedAt) &&
    typeof value.available === 'boolean'
  );
}
function sameCriteria(left: DeliveryCriterion[], right: DeliveryCriterion[]) {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        item.id === other.id &&
        item.text === other.text &&
        item.kind === other.kind &&
        item.required === other.required
      );
    })
  );
}
export function isDeliveryAttempt(value: unknown): value is DeliveryAttempt {
  if (
    !object(value) ||
    !keys(
      value,
      [
        'attemptId',
        'workId',
        'requestId',
        'sequence',
        'revision',
        'workRevision',
        'ownershipRevision',
        'bot',
        'title',
        'description',
        'checklist',
        'phase',
        'createdAt',
        'updatedAt',
        'error',
        'results',
        'outputs',
        'evidence',
        'groups',
      ],
      ['runId', 'queriedAt', 'decision'],
    )
  )
    return false;
  if (
    ![value.attemptId, value.workId, value.requestId, value.bot].every(validAgentId) ||
    ![value.sequence, value.revision, value.workRevision, value.ownershipRevision].every((item) =>
      revision(item),
    ) ||
    !text(value.title, 500) ||
    !text(value.description, 4000, true) ||
    !isDeliveryChecklist(value.checklist) ||
    value.checklist.workId !== value.workId ||
    !deliveryPhases.includes(value.phase as DeliveryPhase) ||
    !time(value.createdAt) ||
    !time(value.updatedAt) ||
    !text(value.error, 2000, true)
  )
    return false;
  if (
    (value.runId !== undefined && !validAgentId(value.runId)) ||
    (value.queriedAt !== undefined && !time(value.queriedAt))
  )
    return false;
  if (
    !Array.isArray(value.outputs) ||
    value.outputs.length > 1000 ||
    !value.outputs.every(isDeliveryOutput) ||
    !Array.isArray(value.evidence) ||
    value.evidence.length > 20 ||
    !value.evidence.every(isDeliveryEvidence)
  )
    return false;
  if (
    !Array.isArray(value.results) ||
    value.results.length > 100 ||
    !value.results.every(
      (item) =>
        object(item) &&
        keys(item, ['bot', 'runId', 'text', 'source']) &&
        validAgentId(item.bot) &&
        validAgentId(item.runId) &&
        text(item.text, 100000, true) &&
        item.source === 'model-report',
    )
  )
    return false;
  if (
    !Array.isArray(value.groups) ||
    value.groups.length > 10 ||
    !value.groups.every(
      (item) =>
        object(item) &&
        keys(item, ['groupId', 'sourceId']) &&
        validAgentId(item.groupId) &&
        validAgentId(item.sourceId),
    )
  )
    return false;
  const criteria = value.checklist.items;
  if (
    new Set(value.evidence.map((item) => item.criterionId)).size !== value.evidence.length ||
    value.evidence.some(
      (item) =>
        !criteria.some(
          (criterion) =>
            criterion.id === item.criterionId &&
            criterion.kind === (item.source === 'file-check' ? 'file' : 'text'),
        ),
    )
  )
    return false;
  if (
    ['accepted-by-user', 'rejected'].includes(String(value.phase)) &&
    value.decision === undefined
  )
    return false;
  if (value.decision !== undefined) {
    const d = value.decision;
    if (
      !object(d) ||
      !keys(d, ['action', 'checked', 'reason', 'at', 'criteria', 'evidence']) ||
      !['accept', 'reject', 'close-unknown'].includes(String(d.action)) ||
      !Array.isArray(d.checked) ||
      d.checked.length > 20 ||
      !d.checked.every(validAgentId) ||
      !text(d.reason, 2000, true) ||
      !time(d.at) ||
      !isDeliveryCriteria(d.criteria) ||
      !Array.isArray(d.evidence) ||
      !d.evidence.every(isDeliveryEvidence)
    )
      return false;
    if (
      new Set(d.checked).size !== d.checked.length ||
      !sameCriteria(d.criteria, criteria) ||
      d.checked.some((id) => !criteria.some((criterion) => criterion.id === id))
    )
      return false;
    if (
      (d.action === 'accept' &&
        (value.phase !== 'accepted-by-user' || d.checked.length !== criteria.length)) ||
      (d.action === 'reject' && (value.phase !== 'rejected' || !d.reason.trim())) ||
      (d.action === 'close-unknown' &&
        (value.phase !== 'unknown' || !d.reason.trim() || !value.queriedAt))
    )
      return false;
    const evidence = d.evidence;
    if (
      new Set(evidence.map((entry) => entry.criterionId)).size !== evidence.length ||
      evidence.some(
        (entry) =>
          !criteria.some(
            (criterion) =>
              criterion.id === entry.criterionId &&
              criterion.kind === (entry.source === 'file-check' ? 'file' : 'text'),
          ),
      )
    )
      return false;
    if (
      d.action === 'accept' &&
      criteria.some(
        (criterion) =>
          criterion.required &&
          criterion.kind === 'file' &&
          !evidence.some(
            (entry) =>
              entry.source === 'file-check' &&
              entry.criterionId === criterion.id &&
              entry.available,
          ),
      )
    )
      return false;
  }
  return true;
}
export function isDeliveryPage(value: unknown): value is DeliveryPage {
  return (
    object(value) &&
    keys(value, ['workId', 'checklist', 'attempts'], ['nextBefore']) &&
    validAgentId(value.workId) &&
    isDeliveryChecklist(value.checklist) &&
    value.checklist.workId === value.workId &&
    Array.isArray(value.attempts) &&
    value.attempts.length <= 50 &&
    value.attempts.every(
      (item, index, entries) =>
        isDeliveryAttempt(item) &&
        item.workId === value.workId &&
        (index === 0 || entries[index - 1].sequence > item.sequence),
    ) &&
    new Set(value.attempts.map((item) => item.attemptId)).size === value.attempts.length &&
    (value.nextBefore === undefined ||
      (revision(value.nextBefore) && value.nextBefore === value.attempts.at(-1)?.sequence))
  );
}
function isDeliveryRequest(value: unknown): value is DeliveryWrite {
  return ['checklist.write', 'start', 'file.bind', 'decide', 'stop'].some((action) =>
    isDeliveryWrite(action, value),
  );
}
export function isDeliveryReceipt(value: unknown): value is DeliveryReceipt {
  if (!object(value) || !isDeliveryRequest(value.request)) return false;
  const request = value.request;
  if (value.state === 'unknown') return keys(value, ['state', 'request']);
  if (value.state !== 'complete') return false;
  if ('items' in request) {
    return (
      keys(value, ['state', 'request', 'checklist']) &&
      isDeliveryChecklist(value.checklist) &&
      value.checklist.workId === request.workId &&
      value.checklist.revision === request.checklistRevision + 1 &&
      sameCriteria(value.checklist.items, request.items)
    );
  }
  if (!keys(value, ['state', 'request', 'attempt']) || !isDeliveryAttempt(value.attempt))
    return false;
  const attempt = value.attempt;
  if (attempt.workId !== request.workId) return false;
  if ('bot' in request)
    return (
      attempt.requestId === request.requestId &&
      attempt.bot === request.bot &&
      attempt.workRevision === request.workRevision &&
      attempt.checklist.revision === request.checklistRevision
    );
  if (attempt.attemptId !== request.attemptId) return false;
  if ('criterionId' in request)
    return (
      attempt.revision === request.attemptRevision + 1 &&
      attempt.phase === 'ready' &&
      attempt.evidence.some(
        (entry) =>
          entry.source === 'file-check' &&
          entry.criterionId === request.criterionId &&
          entry.bot === request.output.bot &&
          entry.runId === request.output.runId &&
          entry.path === request.output.path &&
          entry.available,
      )
    );
  if ('action' in request)
    return (
      attempt.revision === request.attemptRevision + 1 &&
      attempt.decision?.action === request.action &&
      attempt.decision.reason === request.reason &&
      JSON.stringify(attempt.decision.checked) === JSON.stringify(request.checked)
    );
  return attempt.revision === request.attemptRevision;
}

import { safeRuntimePath } from './command.js';
import { isTranscriptScope, sameTranscriptScope, type TranscriptScope } from './index.js';

export const workspaceReviewCapability = 'workspace-review-v1';
// Separate proof is required: older capture peers may reject project scopes despite supporting both features.
export const projectWorkspaceReviewCapability = 'project-workspace-review-v1';
export const reviewLimits = {
  entries: 2000,
  depth: 16,
  fileBytes: 16 * 1024 * 1024,
  hashBytes: 64 * 1024 * 1024,
  textBytes: 256 * 1024,
  totalTextBytes: 4 * 1024 * 1024,
  responseBytes: 8 * 1024 * 1024,
  milliseconds: 5000,
  page: 200,
} as const;
export type ReviewCoverage = 'complete' | 'partial' | 'unknown';
export const reviewReasons = [
  'permission',
  'size-limit',
  'entry-limit',
  'text-limit',
  'time-limit',
  'excluded',
  'unstable',
  'root-moved',
  'unbounded-writer',
  'background-writer',
  'drain-failed',
  'cancelled',
  'disconnected',
  'unsupported',
  'baseline-missing',
  'storage-limit',
  'corrupt',
  'expired',
] as const;
export type ReviewReason = (typeof reviewReasons)[number];
export type ReviewState =
  | 'capturing-before'
  | 'recording'
  | 'capturing-after'
  | 'complete'
  | 'interrupted'
  | 'unavailable'
  | 'expired';
export type ReviewArea = 'task' | 'shared';
export type ReviewFile = { area: ReviewArea; path: string } & (
  | { state: 'present'; bytes: number; sha256: string; text: boolean }
  | { state: 'absent' }
  | { state: 'unknown'; reason: ReviewReason; bytes?: number }
);
export interface ReviewChange {
  before: ReviewFile;
  after: ReviewFile;
  kind: 'created' | 'modified' | 'deleted' | 'unchanged' | 'unknown';
}
export interface ReviewSnapshot {
  area: ReviewArea;
  startedAt: string;
  endedAt: string;
  capture: ReviewCoverage;
  reasons: ReviewReason[];
  omitted: number;
}
export interface ReviewPage {
  scope: TranscriptScope;
  revision: number;
  state: ReviewState;
  writers: 'drained' | 'open' | 'unknown';
  effects: ReviewCoverage;
  reasons: ReviewReason[];
  before?: ReviewSnapshot[];
  after?: ReviewSnapshot[];
  counts: Record<ReviewChange['kind'], number>;
  items: ReviewChange[];
  next?: string;
}
export type ReviewQuery = { scope: TranscriptScope; cursor?: string };
export type ReviewFileQuery = {
  scope: TranscriptScope;
  revision: number;
  area: ReviewArea;
  path: string;
};
export type ReviewDiff = ReviewFileQuery &
  (
    | { state: 'text'; lines: { kind: 'context' | 'add' | 'remove'; text: string }[] }
    | { state: 'unavailable'; reason: ReviewReason | 'binary' | 'diff-limit' }
  );
export type ReviewCurrent = ReviewFileQuery & {
  state: 'matching' | 'changed' | 'missing' | 'unknown';
};
export interface ReviewCapture {
  snapshot: ReviewSnapshot;
  files: ReviewFile[];
  texts: { area: ReviewArea; path: string; data: string }[];
}
export type ReviewSelection = { sharedPaths: string[] };

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, fields: string[]) =>
  Object.keys(value).every((key) => fields.includes(key));
const integer = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min;
const member = (value: unknown, options: readonly string[]) =>
  typeof value === 'string' && options.includes(value);
const area = (value: unknown): value is ReviewArea => member(value, ['task', 'shared']);
const reasons = (value: unknown): value is ReviewReason[] =>
  Array.isArray(value) &&
  value.length <= reviewReasons.length &&
  new Set(value).size === value.length &&
  value.every((item) => member(item, reviewReasons));
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const cursor = (value: unknown) =>
  typeof value === 'string' &&
  value.length > 0 &&
  byteLength(value) <= 256 &&
  /^[A-Za-z0-9_-]+$/.test(value);

export function compareReviewPaths(left: string, right: string) {
  const a = new TextEncoder().encode(left),
    b = new TextEncoder().encode(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export const reviewFileKey = (file: Pick<ReviewFile, 'area' | 'path'>) =>
  `${file.area}\0${file.path}`;
export function isReviewSelection(value: unknown): value is ReviewSelection {
  return (
    object(value) &&
    exact(value, ['sharedPaths']) &&
    Array.isArray(value.sharedPaths) &&
    value.sharedPaths.length <= 8 &&
    value.sharedPaths.every(safeRuntimePath) &&
    new Set(value.sharedPaths).size === value.sharedPaths.length
  );
}
export function isReviewQuery(value: unknown): value is ReviewQuery {
  return (
    object(value) &&
    exact(value, ['scope', 'cursor']) &&
    isTranscriptScope(value.scope) &&
    (value.cursor === undefined || cursor(value.cursor))
  );
}
function fileQuery(
  value: unknown,
  extra: string[] = [],
): value is ReviewFileQuery & Record<string, unknown> {
  return (
    object(value) &&
    exact(value, ['scope', 'revision', 'area', 'path', ...extra]) &&
    isTranscriptScope(value.scope) &&
    integer(value.revision, 1) &&
    area(value.area) &&
    safeRuntimePath(value.path)
  );
}
export function isReviewFileQuery(value: unknown): value is ReviewFileQuery {
  return fileQuery(value);
}
export function isReviewFile(value: unknown): value is ReviewFile {
  if (!object(value) || !area(value.area) || !safeRuntimePath(value.path)) return false;
  if (value.state === 'absent') return exact(value, ['area', 'path', 'state']);
  if (value.state === 'unknown')
    return (
      exact(value, ['area', 'path', 'state', 'reason', 'bytes']) &&
      member(value.reason, reviewReasons) &&
      (value.bytes === undefined || integer(value.bytes))
    );
  return (
    value.state === 'present' &&
    exact(value, ['area', 'path', 'state', 'bytes', 'sha256', 'text']) &&
    integer(value.bytes) &&
    value.bytes <= reviewLimits.fileBytes &&
    typeof value.sha256 === 'string' &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.text === 'boolean' &&
    (!value.text || value.bytes <= reviewLimits.textBytes)
  );
}
export function isReviewSnapshot(value: unknown): value is ReviewSnapshot {
  return (
    object(value) &&
    exact(value, ['area', 'startedAt', 'endedAt', 'capture', 'reasons', 'omitted']) &&
    area(value.area) &&
    typeof value.startedAt === 'string' &&
    typeof value.endedAt === 'string' &&
    /^\d{4}-\d\d-\d\dT/.test(value.startedAt) &&
    /^\d{4}-\d\d-\d\dT/.test(value.endedAt) &&
    Number.isFinite(Date.parse(value.startedAt)) &&
    Date.parse(value.endedAt) >= Date.parse(value.startedAt) &&
    member(value.capture, ['complete', 'partial', 'unknown']) &&
    reasons(value.reasons) &&
    integer(value.omitted) &&
    (value.capture !== 'complete' || (value.reasons.length === 0 && value.omitted === 0))
  );
}
const sorted = (files: Pick<ReviewFile, 'area' | 'path'>[]) =>
  files.every(
    (file, i) =>
      i === 0 || compareReviewPaths(reviewFileKey(files[i - 1]), reviewFileKey(file)) < 0,
  );
export function isReviewCapture(value: unknown): value is ReviewCapture {
  if (
    !object(value) ||
    !exact(value, ['snapshot', 'files', 'texts']) ||
    !isReviewSnapshot(value.snapshot) ||
    !Array.isArray(value.files) ||
    value.files.length > reviewLimits.entries ||
    !value.files.every(isReviewFile) ||
    !sorted(value.files) ||
    !value.files.every((file) => file.area === (value.snapshot as ReviewSnapshot).area) ||
    !Array.isArray(value.texts) ||
    value.texts.length > value.files.length ||
    byteLength(JSON.stringify(value)) > reviewLimits.responseBytes
  )
    return false;
  const expected = new Map(
    value.files
      .filter((file) => file.state === 'present' && file.text)
      .map((file) => [reviewFileKey(file), file]),
  );
  let total = 0;
  for (const text of value.texts) {
    if (
      !object(text) ||
      !exact(text, ['area', 'path', 'data']) ||
      !area(text.area) ||
      !safeRuntimePath(text.path) ||
      typeof text.data !== 'string' ||
      text.data.length > 4 * Math.ceil(reviewLimits.textBytes / 3) ||
      text.data.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text.data)
    )
      return false;
    const key = reviewFileKey({ area: text.area, path: text.path }),
      file = expected.get(key);
    if (file?.state !== 'present') return false;
    try {
      const bytes = Uint8Array.from(atob(text.data), (character) => character.charCodeAt(0));
      if (bytes.length !== file.bytes || bytes.includes(0)) return false;
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      total += bytes.length;
    } catch {
      return false;
    }
    expected.delete(key);
  }
  return (
    expected.size === 0 &&
    total <= reviewLimits.totalTextBytes &&
    value.files.reduce((sum, file) => sum + (file.state === 'present' ? file.bytes : 0), 0) <=
      reviewLimits.hashBytes
  );
}
function changeKind(before: ReviewFile, after: ReviewFile): ReviewChange['kind'] {
  if (before.state === 'unknown' || after.state === 'unknown') return 'unknown';
  if (before.state === 'absent') return after.state === 'present' ? 'created' : 'unchanged';
  if (after.state === 'absent') return 'deleted';
  return before.sha256 === after.sha256 ? 'unchanged' : 'modified';
}
export function isReviewChange(value: unknown): value is ReviewChange {
  return (
    object(value) &&
    exact(value, ['before', 'after', 'kind']) &&
    isReviewFile(value.before) &&
    isReviewFile(value.after) &&
    reviewFileKey(value.before) === reviewFileKey(value.after) &&
    value.kind === changeKind(value.before, value.after)
  );
}
export function isReviewPage(value: unknown): value is ReviewPage {
  const snapshots = (items: unknown) =>
    items === undefined ||
    (Array.isArray(items) &&
      items.length <= 2 &&
      items.every(isReviewSnapshot) &&
      new Set(items.map((item) => item.area)).size === items.length);
  return (
    object(value) &&
    exact(value, [
      'scope',
      'revision',
      'state',
      'writers',
      'effects',
      'reasons',
      'before',
      'after',
      'counts',
      'items',
      'next',
    ]) &&
    isTranscriptScope(value.scope) &&
    integer(value.revision, 1) &&
    member(value.state, [
      'capturing-before',
      'recording',
      'capturing-after',
      'complete',
      'interrupted',
      'unavailable',
      'expired',
    ]) &&
    member(value.writers, ['drained', 'open', 'unknown']) &&
    member(value.effects, ['complete', 'partial', 'unknown']) &&
    reasons(value.reasons) &&
    snapshots(value.before) &&
    snapshots(value.after) &&
    object(value.counts) &&
    exact(value.counts, ['created', 'modified', 'deleted', 'unchanged', 'unknown']) &&
    ['created', 'modified', 'deleted', 'unchanged', 'unknown'].every((key) =>
      integer((value.counts as Record<string, unknown>)[key]),
    ) &&
    Array.isArray(value.items) &&
    value.items.length <= reviewLimits.page &&
    value.items.every(isReviewChange) &&
    ['created', 'modified', 'deleted', 'unchanged', 'unknown'].every(
      (kind) =>
        Number((value.counts as Record<string, unknown>)[kind]) >=
        (value.items as ReviewChange[]).filter((item) => item.kind === kind).length,
    ) &&
    sorted(value.items.map((item) => item.before)) &&
    (value.next === undefined || cursor(value.next)) &&
    Object.values(value.counts).reduce<number>((sum, count) => sum + Number(count), 0) >=
      value.items.length &&
    Object.values(value.counts).reduce<number>((sum, count) => sum + Number(count), 0) <=
      2 * reviewLimits.entries + 8
  );
}
export function isReviewDiff(value: unknown): value is ReviewDiff {
  if (!fileQuery(value, ['state', 'reason', 'lines'])) return false;
  if (value.state === 'unavailable')
    return (
      value.lines === undefined && member(value.reason, [...reviewReasons, 'binary', 'diff-limit'])
    );
  return (
    value.state === 'text' &&
    value.reason === undefined &&
    Array.isArray(value.lines) &&
    value.lines.length <= 2000 &&
    value.lines.every(
      (line) =>
        object(line) &&
        exact(line, ['kind', 'text']) &&
        member(line.kind, ['context', 'add', 'remove']) &&
        typeof line.text === 'string',
    ) &&
    byteLength(JSON.stringify(value.lines)) <= 200 * 1024
  );
}
export function isReviewCurrent(value: unknown): value is ReviewCurrent {
  return (
    fileQuery(value, ['state']) &&
    member(value.state, ['matching', 'changed', 'missing', 'unknown'])
  );
}
export function isReviewResponse(
  command: { type: string; query: ReviewQuery | ReviewFileQuery },
  value: unknown,
) {
  if (!['files.review.read', 'files.review.diff', 'files.review.current'].includes(command.type))
    return false;
  if (!object(value) || !isTranscriptScope(value.scope)) return false;
  if (command.type === 'files.review.read')
    return isReviewPage(value) && sameTranscriptScope(value.scope, command.query.scope);
  const query = command.query;
  return (
    'revision' in query &&
    (command.type === 'files.review.diff' ? isReviewDiff(value) : isReviewCurrent(value)) &&
    sameTranscriptScope(value.scope, query.scope) &&
    value.revision === query.revision &&
    value.area === query.area &&
    value.path === query.path
  );
}

import { isTranscriptScope, type TranscriptScope, validAgentId } from './index.js';

export const contextCategories = [
  'request',
  'persona',
  'preferences',
  'references',
  'skills',
  'tools',
  'history',
  'toolResults',
  'images',
  'runtimeRules',
] as const;

export type ContextPressureValue = Omit<ContextPressure, 'seq' | 'at'>;
export type ContextBreakdownValue = Omit<ContextBreakdown, 'seq' | 'at'>;

export type ContextCategory =
  | 'request'
  | 'persona'
  | 'preferences'
  | 'references'
  | 'skills'
  | 'tools'
  | 'history'
  | 'toolResults'
  | 'images'
  | 'runtimeRules';
export type ContextRef = {
  scope: TranscriptScope;
  seq: number;
};
export type ContextSource = {
  category: ContextCategory;
  evidence: 'estimated' | 'unknown' | 'not-injected';
  membership: 'host-injected' | 'saved-only' | 'unknown';
  hostTokens: number | null;
  savedCharacters: number;
  refs: ContextRef[];
  omittedRefs: number;
};
export type ContextPressure = {
  seq: number;
  at: string;
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
};
export type ContextBreakdown = {
  seq: number;
  at: string;
  systemTokens: number;
  toolsTokens: number;
  messageTokens: number;
};
export type ContextBoundary = {
  kind: 'summary' | 'prune';
  endSeq: number;
  shadowedSeqs: number[];
  omittedSeqs: number;
};
export type ContextCapture = {
  revision: number;
  at: string;
  reason: 'turn' | 'projection' | 'compaction' | 'settled';
  coverage: 'partial';
  turnId: string;
  estimator: 'daban-text-v1';
  configuredWindow: number;
  configuredOutput: number;
  sources: ContextSource[];
  pressure?: ContextPressure;
  breakdown?: ContextBreakdown;
  boundary?: ContextBoundary;
  gaps: ('sdk-envelope' | 'images' | 'retention' | 'capture-failed')[];
};
export type ContextQuery = { scope: TranscriptScope; revision?: number };
export type ContextSourceQuery = {
  scope: TranscriptScope;
  revision: number;
  ref: ContextRef;
  offset?: number;
};
export type ContextView = { scope: TranscriptScope } & (
  | { state: 'unavailable'; reason: 'legacy' | 'not-captured' | 'capture-unavailable' }
  | {
      state: 'captured';
      health: 'ok' | 'capture-failed';
      selected: ContextCapture;
      revisions: number[];
    }
);

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const integer = (value: unknown, min = 0): value is number =>
  Number.isSafeInteger(value) && Number(value) >= min;
// Coercion can throw past the optional journal-field boundary and hide an otherwise readable task.
const enumValue = (value: unknown, values: readonly string[]) =>
  typeof value === 'string' && values.includes(value);

function instant(value: unknown): value is string {
  const match =
    typeof value === 'string' &&
    /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    );
  if (!match || typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return false;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return (
    date.getUTCFullYear() === Number(match[1]) &&
    date.getUTCMonth() === Number(match[2]) - 1 &&
    date.getUTCDate() === Number(match[3])
  );
}

export function sameContextConversation(left: TranscriptScope, right: TranscriptScope) {
  return (
    left.bot === right.bot &&
    left.conversationId === right.conversationId &&
    left.chatRevision === right.chatRevision
  );
}

export function isContextRef(value: unknown): value is ContextRef {
  return (
    object(value) &&
    exact(value, ['scope', 'seq']) &&
    isTranscriptScope(value.scope) &&
    integer(value.seq, 1)
  );
}

export function isContextQuery(value: unknown): value is ContextQuery {
  return (
    object(value) &&
    exact(value, ['scope', 'revision']) &&
    isTranscriptScope(value.scope) &&
    (value.revision === undefined || integer(value.revision, 1))
  );
}

export function isContextSourceQuery(value: unknown): value is ContextSourceQuery {
  return (
    object(value) &&
    exact(value, ['scope', 'revision', 'ref', 'offset']) &&
    isTranscriptScope(value.scope) &&
    integer(value.revision, 1) &&
    isContextRef(value.ref) &&
    sameContextConversation(value.scope, value.ref.scope) &&
    (value.offset === undefined || integer(value.offset))
  );
}

export function isContextPressureValue(value: unknown): value is ContextPressureValue {
  return (
    object(value) &&
    exact(value, ['pressureTokens', 'projectedTokens', 'contextWindow']) &&
    Object.values(value).every((item) => integer(item))
  );
}

export function isContextBreakdownValue(value: unknown): value is ContextBreakdownValue {
  return (
    object(value) &&
    exact(value, ['systemTokens', 'toolsTokens', 'messageTokens']) &&
    integer(value.systemTokens) &&
    integer(value.toolsTokens) &&
    integer(value.messageTokens)
  );
}

function pressure(value: unknown) {
  if (!object(value)) return false;
  const { seq, at, ...numbers } = value;
  return integer(seq) && instant(at) && isContextPressureValue(numbers);
}

function breakdown(value: unknown) {
  if (!object(value)) return false;
  const { seq, at, ...numbers } = value;
  return integer(seq) && instant(at) && isContextBreakdownValue(numbers);
}

export function isContextBoundary(value: unknown): value is ContextBoundary {
  return (
    object(value) &&
    exact(value, ['kind', 'endSeq', 'shadowedSeqs', 'omittedSeqs']) &&
    enumValue(value.kind, ['summary', 'prune']) &&
    integer(value.endSeq) &&
    Array.isArray(value.shadowedSeqs) &&
    value.shadowedSeqs.length <= 32 &&
    value.shadowedSeqs.every((seq) => integer(seq)) &&
    new Set(value.shadowedSeqs).size === value.shadowedSeqs.length &&
    integer(value.omittedSeqs)
  );
}

function source(value: unknown): value is ContextSource {
  if (
    !object(value) ||
    !exact(value, [
      'category',
      'evidence',
      'membership',
      'hostTokens',
      'savedCharacters',
      'refs',
      'omittedRefs',
    ])
  )
    return false;
  return (
    contextCategories.includes(value.category as ContextCategory) &&
    enumValue(value.evidence, ['estimated', 'unknown', 'not-injected']) &&
    enumValue(value.membership, ['host-injected', 'saved-only', 'unknown']) &&
    (value.hostTokens === null || integer(value.hostTokens)) &&
    (value.evidence !== 'unknown' || value.hostTokens === null) &&
    (value.evidence !== 'estimated' || integer(value.hostTokens, 1)) &&
    (value.evidence !== 'not-injected' || value.hostTokens === 0) &&
    integer(value.savedCharacters) &&
    integer(value.omittedRefs) &&
    Array.isArray(value.refs) &&
    ((value.category !== 'persona' && value.category !== 'preferences') ||
      value.refs.length === 0) &&
    value.refs.length <= 5 &&
    value.refs.every(isContextRef)
  );
}

export function isContextCapture(value: unknown): value is ContextCapture {
  return (
    object(value) &&
    exact(value, [
      'revision',
      'at',
      'reason',
      'coverage',
      'turnId',
      'estimator',
      'configuredWindow',
      'configuredOutput',
      'sources',
      'pressure',
      'breakdown',
      'boundary',
      'gaps',
    ]) &&
    integer(value.revision, 1) &&
    instant(value.at) &&
    enumValue(value.reason, ['turn', 'projection', 'compaction', 'settled']) &&
    value.coverage === 'partial' &&
    validAgentId(value.turnId) &&
    value.estimator === 'daban-text-v1' &&
    integer(value.configuredWindow) &&
    integer(value.configuredOutput) &&
    Array.isArray(value.sources) &&
    value.sources.length === contextCategories.length &&
    value.sources.every(
      (item, index) => source(item) && item.category === contextCategories[index],
    ) &&
    value.sources.reduce((count, item: ContextSource) => count + item.refs.length, 0) <= 20 &&
    (value.pressure === undefined || pressure(value.pressure)) &&
    (value.breakdown === undefined || breakdown(value.breakdown)) &&
    (value.boundary === undefined || isContextBoundary(value.boundary)) &&
    Array.isArray(value.gaps) &&
    value.gaps.length <= 4 &&
    new Set(value.gaps).size === value.gaps.length &&
    value.gaps.every((gap) =>
      ['sdk-envelope', 'images', 'retention', 'capture-failed'].includes(gap),
    ) &&
    new TextEncoder().encode(JSON.stringify(value)).length <= 6144
  );
}

export function isContextView(value: unknown): value is ContextView {
  if (!object(value) || !isTranscriptScope(value.scope)) return false;
  if (value.state === 'unavailable')
    return (
      exact(value, ['scope', 'state', 'reason']) &&
      enumValue(value.reason, ['legacy', 'not-captured', 'capture-unavailable'])
    );
  return (
    value.state === 'captured' &&
    exact(value, ['scope', 'state', 'health', 'selected', 'revisions']) &&
    enumValue(value.health, ['ok', 'capture-failed']) &&
    isContextCapture(value.selected) &&
    Array.isArray(value.revisions) &&
    value.revisions.length > 0 &&
    value.revisions.length <= 20 &&
    value.revisions.every(
      (revision, index, all) => integer(revision, 1) && (index === 0 || revision > all[index - 1]),
    ) &&
    value.revisions.includes(value.selected.revision) &&
    value.selected.sources.every((item) =>
      item.refs.every((ref) => sameContextConversation(value.scope as TranscriptScope, ref.scope)),
    )
  );
}

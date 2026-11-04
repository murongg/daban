import { createHash } from 'node:crypto';
import type { TranscriptContent, TranscriptPage, TranscriptScope } from '@daban/protocol';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Verdict = 'pass' | 'fail' | 'inconclusive';
export type UnknownCode =
  | 'MCP_OUTCOME_UNKNOWN'
  | 'COMMAND_OUTCOME_UNKNOWN'
  | 'EXECUTION_OUTCOME_UNKNOWN'
  | 'PROCESS_OUTCOME_UNKNOWN'
  | 'BROWSER_OUTCOME_UNKNOWN'
  | 'COMPUTER_OUTCOME_UNKNOWN'
  | 'SOFTWARE_OUTCOME_UNKNOWN'
  | 'REMOTE_OUTCOME_UNKNOWN';
export type Terminal = 'completed' | 'failed' | 'stopped' | 'interrupted';
export type Check =
  | 'coverage'
  | 'order'
  | 'arguments'
  | 'budget'
  | 'artifacts'
  | 'terminal'
  | 'unknown'
  | 'no-replay';
export type Rule = { pointer: string; kind: 'workspace' | 'clock' | 'nonce'; alias: string };
export type Artifact = { path: string } & (
  | { state: 'verified'; size: number; sha256: string }
  | { state: 'unknown'; reason: 'missing' | 'changed' | 'unsafe' | 'too-large' }
);
export interface TrajectoryCase {
  schema: 1;
  id: string;
  revision: number;
  input: {
    prompt: string;
    events: (
      | { kind: 'call'; callId: string; tool: string; args: Json }
      | { kind: 'result'; callId: string; body: Json; isError: boolean }
      | { kind: 'barrier'; action: 'complete' | 'stop' }
    )[];
    files: { path: string; utf8: string }[];
  };
  steps: { slot: string; tool: string; args: Json; result: 'success' | 'error'; code?: string }[];
  terminal: Terminal;
  budget: { maxCalls: number; maxModelRequests?: number };
  artifacts: { path: string; size: number; sha256: string }[];
  rules: Rule[];
  sensitive: string[];
  stopAfter?: string;
}
export interface TrajectoryCapture {
  schema: 1;
  origin: 'synthetic';
  scope: TranscriptScope;
  sessionId: string;
  requestId: string;
  drained: boolean;
  lateEvents: number;
  pages: TranscriptPage[];
  contents: TranscriptContent[];
  terminal?: Terminal;
  modelRequests?: number;
  artifacts: Artifact[];
  bindings: Record<string, string>;
}
export interface ToolAttempt {
  event: number;
  callId: string;
  tool: string;
  args?: Json;
  outcome: 'success' | 'error' | 'unknown' | 'missing';
  resultEvent?: number;
  code?: string;
}
export interface Trajectory {
  scope: TranscriptScope;
  requestId: string;
  attempts: ToolAttempt[];
  issues: { check: Check; state: 'fail' | 'inconclusive'; code: string; event?: number }[];
}
export interface TrajectoryReport {
  schema: 1;
  caseId: string;
  revision: number;
  caseHash: string;
  configHash: string;
  codeRevision: string;
  scope: TranscriptScope;
  requestId: string;
  checks: { check: Check; verdict: Verdict; code: string; events: number[]; pointers: string[] }[];
  verdict: Verdict;
}
export interface TrajectorySuiteReport {
  schema: 1;
  evidence: 'simulated-notifications-and-owner-regressions';
  cases: TrajectoryReport[];
  owners: {
    suite: 'commands' | 'integration-tools';
    verdict: Verdict;
    exitCode: number | null;
    total: number;
    passed: number;
    failed: number;
    pending: number;
    todo: number;
    reportHash?: string;
  }[];
  verdict: Verdict;
}

import {
  isTranscriptContent,
  isTranscriptItem,
  isTranscriptPage,
  isTranscriptScope,
  sameTranscriptScope,
  type TranscriptItem,
} from '@daban/protocol';

export const trajectoryLimits = {
  maxCases: 100,
  maxItems: 1000,
  maxText: 8 * 1024 * 1024,
  maxArtifacts: 64,
  maxArtifactBytes: 1024 * 1024,
  maxDepth: 16,
  maxKeys: 100,
  maxArray: 1000,
} as const;

const checks: Check[] = [
  'coverage',
  'order',
  'arguments',
  'budget',
  'artifacts',
  'terminal',
  'unknown',
  'no-replay',
];
const terminals: Terminal[] = ['completed', 'failed', 'stopped', 'interrupted'];
const unknownCodes = new Set<UnknownCode>([
  'MCP_OUTCOME_UNKNOWN',
  'COMMAND_OUTCOME_UNKNOWN',
  'EXECUTION_OUTCOME_UNKNOWN',
  'PROCESS_OUTCOME_UNKNOWN',
  'BROWSER_OUTCOME_UNKNOWN',
  'COMPUTER_OUTCOME_UNKNOWN',
  'SOFTWARE_OUTCOME_UNKNOWN',
  'REMOTE_OUTCOME_UNKNOWN',
]);
const sha256 = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9_-]{1,100}$/;
const publicCode = /^[A-Z][A-Z0-9_]{0,80}$/;
const refusalCode = /(?:^|_)(?:REJECTED|DENIED|REFUSED|CANCELLED|CANCELED)$/;
const has = (value: object, key: string) => Object.hasOwn(value, key);

export class TrajectoryInputError extends Error {
  readonly code = 'INVALID_TRAJECTORY_INPUT';
  constructor(reason = 'invalid-input') {
    super(reason);
    this.name = 'TrajectoryInputError';
  }
}

function invalid(reason: string): never {
  throw new TrajectoryInputError(reason);
}

function object(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === 'string' && descriptor.enumerable && 'value' in descriptor;
  });
}

function fields(value: unknown, required: string[], optional: string[] = []) {
  if (!object(value) || required.some((key) => !has(value, key))) invalid('invalid-fields');
  const allowed = new Set([...required, ...optional]);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid('unknown-field');
  return value;
}

function text(value: unknown, maximum = trajectoryLimits.maxText, empty = false): value is string {
  return (
    typeof value === 'string' &&
    (empty || value.length > 0) &&
    value.length <= maximum &&
    !value.includes('\0')
  );
}

function integer(value: unknown, minimum = 0): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function list(value: unknown, maximum: number): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= maximum &&
    Array.from({ length: value.length }, (_, index) => has(value, String(index))).every(Boolean)
  );
}

function relativePath(value: unknown): value is string {
  return (
    text(value, 1000) &&
    !/[\\:]/.test(value) &&
    !value.startsWith('/') &&
    value.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
  );
}

function assertJson(
  value: unknown,
  depth = 0,
  ancestors = new Set<object>(),
): asserts value is Json {
  if (depth > trajectoryLimits.maxDepth) invalid('json-depth');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (value.length > trajectoryLimits.maxText) invalid('json-string-limit');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
      invalid('json-number');
    return;
  }
  if (typeof value !== 'object' || !value || ancestors.has(value)) invalid('invalid-json');
  ancestors.add(value);
  if (Array.isArray(value)) {
    if (!list(value, trajectoryLimits.maxArray)) invalid('json-array-limit');
    for (const item of value) assertJson(item, depth + 1, ancestors);
  } else {
    if (!object(value) || Object.keys(value).length > trajectoryLimits.maxKeys)
      invalid('json-object-limit');
    for (const item of Object.values(value)) assertJson(item, depth + 1, ancestors);
  }
  ancestors.delete(value);
}

function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
    .join(',')}}`;
}

export function canonicalTrajectory(value: unknown): string {
  assertJson(value);
  return canonical(value);
}

export function hashTrajectory(value: unknown): string {
  return createHash('sha256').update(canonicalTrajectory(value)).digest('hex');
}

function jsonLength(value: Json, maximum: number): number {
  let length = 0;
  const add = (count: number) => {
    length += count;
    if (length > maximum) invalid('case-text-limit');
  };
  const visit = (item: Json) => {
    if (item === null || typeof item !== 'object') {
      if (typeof item === 'string' && item.length > maximum - length) invalid('case-text-limit');
      add(JSON.stringify(item).length);
    } else if (Array.isArray(item)) {
      add(2 + Math.max(0, item.length - 1));
      for (const nested of item) visit(nested);
    } else {
      const entries = Object.entries(item);
      add(2 + Math.max(0, entries.length - 1));
      for (const [key, nested] of entries) {
        add(JSON.stringify(key).length + 1);
        visit(nested);
      }
    }
  };
  visit(value);
  return length;
}

// JSON.parse alone discards duplicate keys and rounds integer tokens before they can be checked.
function decodeJson(source: string): Json {
  if (source.length > trajectoryLimits.maxText) invalid('json-text-limit');
  let position = 0;
  const whitespace = () => {
    while (position < source.length && /[\t\n\r ]/.test(source[position])) position++;
  };
  const string = () => {
    if (source[position] !== '"') invalid('json-string');
    const start = position++;
    while (position < source.length) {
      const character = source[position++];
      if (character === '\\') position++;
      else if (character === '"') return JSON.parse(source.slice(start, position)) as string;
    }
    return invalid('json-string');
  };
  const value = (depth: number): Json => {
    if (depth > trajectoryLimits.maxDepth) invalid('json-depth');
    whitespace();
    const character = source[position];
    if (character === '"') return string();
    if (character === '{') {
      position++;
      whitespace();
      const result: { [key: string]: Json } = {};
      const keys = new Set<string>();
      if (source[position] === '}') {
        position++;
        return result;
      }
      while (position < source.length) {
        whitespace();
        const key = string();
        if (keys.has(key) || keys.size >= trajectoryLimits.maxKeys) invalid('json-key');
        keys.add(key);
        whitespace();
        if (source[position++] !== ':') invalid('json-colon');
        Object.defineProperty(result, key, {
          value: value(depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
        whitespace();
        if (source[position] === '}') {
          position++;
          return result;
        }
        if (source[position++] !== ',') invalid('json-comma');
      }
      return invalid('json-object');
    }
    if (character === '[') {
      position++;
      whitespace();
      const result: Json[] = [];
      if (source[position] === ']') {
        position++;
        return result;
      }
      while (position < source.length) {
        if (result.length >= trajectoryLimits.maxArray) invalid('json-array-limit');
        result.push(value(depth + 1));
        whitespace();
        if (source[position] === ']') {
          position++;
          return result;
        }
        if (source[position++] !== ',') invalid('json-comma');
      }
      return invalid('json-array');
    }
    for (const [token, decoded] of [
      ['null', null],
      ['true', true],
      ['false', false],
    ] as const) {
      if (source.startsWith(token, position)) {
        position += token.length;
        return decoded;
      }
    }
    const token = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      source.slice(position),
    )?.[0];
    if (!token) invalid('json-token');
    position += token.length;
    const number = Number(token);
    if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number)))
      invalid('json-number');
    return number;
  };
  const decoded = value(0);
  whitespace();
  if (position !== source.length) invalid('json-trailing');
  return decoded;
}

function pointer(value: unknown): string[] {
  if (!text(value, 1000) || !value.startsWith('/')) invalid('invalid-pointer');
  return value
    .slice(1)
    .split('/')
    .map((part) => {
      if (/~(?![01])/.test(part)) invalid('invalid-pointer');
      return part.replace(/~1/g, '/').replace(/~0/g, '~');
    });
}

function lookup(value: Json, parts: string[]): { found: boolean; value?: Json } {
  let current = value;
  for (const part of parts) {
    if (current === null || typeof current !== 'object') return { found: false };
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(part) || Number(part) >= current.length)
        return { found: false };
      current = current[Number(part)];
    } else {
      if (!has(current, part)) return { found: false };
      current = current[part];
    }
  }
  return { found: true, value: current };
}

function replace(value: Json, parts: string[], replacement: string): Json {
  if (!parts.length) return replacement;
  const parent = lookup(value, parts.slice(0, -1));
  if (!parent.found || parent.value === null || typeof parent.value !== 'object')
    return invalid('invalid-pointer');
  const key = parts.at(-1)!;
  if (Array.isArray(parent.value)) parent.value[Number(key)] = replacement;
  else parent.value[key] = replacement;
  return value;
}

function artifact(value: unknown, observed: boolean) {
  if (!object(value)) invalid('invalid-artifact');
  if (observed && value.state === 'unknown') {
    fields(value, ['path', 'state', 'reason']);
    if (!['missing', 'changed', 'unsafe', 'too-large'].includes(String(value.reason)))
      invalid('invalid-artifact-reason');
  } else {
    fields(value, observed ? ['path', 'state', 'size', 'sha256'] : ['path', 'size', 'sha256']);
    if (
      (observed && value.state !== 'verified') ||
      !integer(value.size) ||
      value.size > trajectoryLimits.maxArtifactBytes ||
      typeof value.sha256 !== 'string' ||
      !sha256.test(value.sha256)
    )
      invalid('invalid-artifact-bytes');
  }
  if (!relativePath(value.path)) invalid('invalid-artifact-path');
}

export function validateTrajectoryCase(value: unknown): TrajectoryCase {
  const spec = fields(
    value,
    [
      'schema',
      'id',
      'revision',
      'input',
      'steps',
      'terminal',
      'budget',
      'artifacts',
      'rules',
      'sensitive',
    ],
    ['stopAfter'],
  );
  if (
    spec.schema !== 1 ||
    typeof spec.id !== 'string' ||
    !identifier.test(spec.id) ||
    !integer(spec.revision, 1) ||
    !terminals.includes(spec.terminal as Terminal)
  )
    invalid('invalid-case');
  const input = fields(spec.input, ['prompt', 'events', 'files']);
  if (
    !text(input.prompt) ||
    !list(input.events, trajectoryLimits.maxItems) ||
    !list(input.files, trajectoryLimits.maxArtifacts)
  )
    invalid('invalid-case-input');
  let barriers = 0;
  let scriptText = 0;
  for (const item of input.events) {
    if (!object(item)) invalid('invalid-script-event');
    if (item.kind === 'call') {
      fields(item, ['kind', 'callId', 'tool', 'args']);
      if (!text(item.callId, 300) || !text(item.tool, 300)) invalid('invalid-script-call');
      assertJson(item.args);
      scriptText += jsonLength(item.args, trajectoryLimits.maxText - scriptText);
    } else if (item.kind === 'result') {
      fields(item, ['kind', 'callId', 'body', 'isError']);
      if (!text(item.callId, 300) || typeof item.isError !== 'boolean')
        invalid('invalid-script-result');
      assertJson(item.body);
      scriptText += jsonLength(item.body, trajectoryLimits.maxText - scriptText);
    } else if (item.kind === 'barrier') {
      fields(item, ['kind', 'action']);
      if (!['complete', 'stop'].includes(String(item.action))) invalid('invalid-script-barrier');
      barriers++;
    } else invalid('unsupported-script-event');
  }
  if (barriers !== 1) invalid('invalid-script-barrier');
  const files = new Set<string>();
  for (const item of input.files) {
    const file = fields(item, ['path', 'utf8']);
    if (
      !relativePath(file.path) ||
      typeof file.utf8 !== 'string' ||
      Buffer.byteLength(file.utf8) > trajectoryLimits.maxArtifactBytes ||
      files.has(file.path)
    )
      invalid('invalid-script-file');
    files.add(file.path);
  }
  if (
    !list(spec.steps, trajectoryLimits.maxItems) ||
    !list(spec.rules, trajectoryLimits.maxItems) ||
    !list(spec.sensitive, trajectoryLimits.maxItems) ||
    !list(spec.artifacts, trajectoryLimits.maxArtifacts)
  )
    invalid('invalid-case-collections');
  const slots = new Map<string, Json>();
  let expectedText = 0;
  for (const item of spec.steps) {
    const step = fields(item, ['slot', 'tool', 'args', 'result'], ['code']);
    if (
      typeof step.slot !== 'string' ||
      !identifier.test(step.slot) ||
      slots.has(step.slot) ||
      !text(step.tool, 300) ||
      !['success', 'error'].includes(String(step.result)) ||
      (step.code !== undefined && (typeof step.code !== 'string' || !publicCode.test(step.code)))
    )
      invalid('invalid-case-step');
    if (
      step.result === 'success' &&
      step.code !== undefined &&
      (unknownCodes.has(step.code as UnknownCode) || /OUTCOME_UNKNOWN/.test(String(step.code)))
    )
      invalid('unknown-success-expectation');
    assertJson(step.args);
    expectedText += jsonLength(step.args, trajectoryLimits.maxText - expectedText);
    slots.set(step.slot, step.args);
  }
  const budget = fields(spec.budget, ['maxCalls'], ['maxModelRequests']);
  if (
    !integer(budget.maxCalls) ||
    (budget.maxModelRequests !== undefined && !integer(budget.maxModelRequests))
  )
    invalid('invalid-case-budget');
  const paths = new Set<string>();
  for (const item of spec.artifacts) {
    artifact(item, false);
    const path = (item as { path: string }).path;
    if (paths.has(path)) invalid('duplicate-artifact-path');
    paths.add(path);
  }
  const declared: string[][] = [];
  const aliases = new Map<string, string>();
  const target = (encoded: unknown) => {
    const parts = pointer(encoded);
    const args = slots.get(parts[0]);
    if (args === undefined || !lookup(args, parts.slice(1)).found) invalid('missing-pointer');
    return { parts, value: lookup(args, parts.slice(1)).value };
  };
  for (const item of spec.rules) {
    const rule = fields(item, ['pointer', 'kind', 'alias']);
    if (
      !['workspace', 'clock', 'nonce'].includes(String(rule.kind)) ||
      typeof rule.alias !== 'string' ||
      !identifier.test(rule.alias)
    )
      invalid('invalid-rule');
    const { parts, value: expected } = target(rule.pointer);
    if (
      declared.some(
        (other) =>
          other.every((part, index) => parts[index] === part) ||
          parts.every((part, index) => other[index] === part),
      )
    )
      invalid('overlapping-rule');
    declared.push(parts);
    const marker = `\${${rule.alias}}`;
    if (
      typeof expected !== 'string' ||
      (rule.kind === 'workspace'
        ? expected !== marker && !expected.startsWith(`${marker}/`)
        : expected !== marker)
    )
      invalid('invalid-rule-expectation');
    if (
      rule.kind === 'workspace' &&
      typeof expected === 'string' &&
      expected !== marker &&
      !relativePath(expected.slice(marker.length + 1))
    )
      invalid('unsafe-rule-expectation');
    if (aliases.has(rule.alias) && aliases.get(rule.alias) !== rule.kind)
      invalid('alias-kind-conflict');
    aliases.set(rule.alias, String(rule.kind));
  }
  const sensitive = new Set<string>();
  for (const encoded of spec.sensitive) {
    target(encoded);
    if (typeof encoded !== 'string' || sensitive.has(encoded))
      invalid('duplicate-sensitive-pointer');
    sensitive.add(encoded);
  }
  if (spec.stopAfter !== undefined) {
    if (typeof spec.stopAfter !== 'string' || !slots.has(spec.stopAfter))
      invalid('invalid-stop-slot');
    const step = (spec.steps as TrajectoryCase['steps']).find(
      (entry) => entry.slot === spec.stopAfter,
    )!;
    if (step.result !== 'error' || !step.code || !refusalCode.test(step.code))
      invalid('invalid-stop-result');
  }
  return value as TrajectoryCase;
}

function validateCapture(value: unknown): TrajectoryCapture {
  const capture = fields(
    value,
    [
      'schema',
      'origin',
      'scope',
      'sessionId',
      'requestId',
      'drained',
      'lateEvents',
      'pages',
      'contents',
      'artifacts',
      'bindings',
    ],
    ['terminal', 'modelRequests'],
  );
  if (
    capture.schema !== 1 ||
    capture.origin !== 'synthetic' ||
    !isTranscriptScope(capture.scope) ||
    !text(capture.sessionId, 300) ||
    !text(capture.requestId, 300) ||
    typeof capture.drained !== 'boolean' ||
    !integer(capture.lateEvents) ||
    !list(capture.pages, 2000) ||
    !list(capture.contents, 2000) ||
    !list(capture.artifacts, trajectoryLimits.maxArtifacts) ||
    !object(capture.bindings) ||
    Object.keys(capture.bindings).length > trajectoryLimits.maxKeys ||
    (capture.terminal !== undefined && !terminals.includes(capture.terminal as Terminal)) ||
    (capture.modelRequests !== undefined && !integer(capture.modelRequests))
  )
    invalid('invalid-capture');
  for (const [alias, binding] of Object.entries(capture.bindings))
    if (!identifier.test(alias) || !text(binding, 4096)) invalid('invalid-binding');
  for (const item of capture.artifacts) artifact(item, true);
  return value as TrajectoryCapture;
}

type Issue = Trajectory['issues'][number];

function resultCode(body: string): { code?: string; malformed: boolean } {
  let value: unknown;
  let malformed = false;
  try {
    value = decodeJson(body);
  } catch {
    value = undefined;
    malformed = /^\s*[[{]/.test(body);
  }
  const error = object(value) ? value.error : undefined;
  const candidate = typeof error === 'string' ? error : object(error) ? error.code : body;
  if (typeof candidate !== 'string') return { malformed };
  const match = /^([A-Z][A-Z0-9_]{0,80})(?::[\s\S]*)?$/.exec(candidate);
  return { ...(match ? { code: match[1] } : {}), malformed };
}

export function normalizeTrajectory(input: TrajectoryCapture): Trajectory {
  const capture = validateCapture(input);
  const issues: Issue[] = [];
  const add = (check: Check, state: 'fail' | 'inconclusive', code: string, event?: number) => {
    issues.push({ check, state, code, ...(event !== undefined ? { event } : {}) });
  };
  if (!capture.pages.length) add('coverage', 'inconclusive', 'pages-missing');
  if (!capture.drained) add('coverage', 'inconclusive', 'observer-not-drained');
  if (capture.lateEvents) add('coverage', 'inconclusive', 'late-event');
  const items = new Map<number, TranscriptItem>();
  const pageFields = ['bot', 'runId', 'state', 'items'];
  const optionalScope = ['chatRevision', 'conversationId'];
  for (const page of capture.pages) {
    fields(page, pageFields, [...optionalScope, 'nextAfter']);
    if (!sameTranscriptScope(page, capture.scope)) add('coverage', 'fail', 'scope-conflict');
    if (!isTranscriptPage(page)) add('coverage', 'inconclusive', 'invalid-page');
    if (page.state !== 'complete') add('coverage', 'inconclusive', 'transcript-unclosed');
    if (!list(page.items, 20)) invalid('capture-page-limit');
    for (const item of page.items) {
      fields(
        item,
        ['seq', 'kind', 'at', 'characters'],
        ['name', 'callId', 'thinkingId', 'isError', 'code'],
      );
      if (!isTranscriptItem(item)) {
        add('coverage', 'inconclusive', 'invalid-item');
        continue;
      }
      const previous = items.get(item.seq);
      if (previous && canonicalTrajectory(previous) !== canonicalTrajectory(item))
        add('coverage', 'fail', 'event-conflict', item.seq);
      else items.set(item.seq, item);
      if (items.size > trajectoryLimits.maxItems) invalid('capture-item-limit');
    }
  }
  if (items.size > trajectoryLimits.maxItems) invalid('capture-item-limit');
  const ordered = [...items.values()].sort((left, right) => left.seq - right.seq);
  ordered.forEach((item, index) => {
    if (item.seq !== index + 1) add('coverage', 'inconclusive', 'sequence-gap', item.seq);
  });
  const last = ordered.at(-1)?.seq ?? 0;
  for (const page of capture.pages) {
    if (page.nextAfter !== undefined && (!items.has(page.nextAfter + 1) || page.nextAfter >= last))
      add('coverage', 'inconclusive', 'page-tail-missing', page.nextAfter);
    if (page.items.length && page.nextAfter === undefined && page.items.at(-1)!.seq < last)
      add('coverage', 'inconclusive', 'page-boundary-changed', page.items.at(-1)!.seq);
  }
  const chunks = new Map<number, Map<number, TranscriptContent>>();
  let receivedText = 0;
  for (const part of capture.contents) {
    fields(
      part,
      ['bot', 'runId', 'seq', 'offset', 'total', 'text'],
      [...optionalScope, 'nextOffset'],
    );
    if (!sameTranscriptScope(part, capture.scope))
      add('coverage', 'fail', 'scope-conflict', part.seq);
    const item = items.get(part.seq);
    if (!item) {
      add('coverage', 'inconclusive', 'content-owner-missing', part.seq);
      continue;
    }
    if (!['call', 'result', 'interaction'].includes(item.kind)) continue;
    const seq = part.seq;
    if (!isTranscriptContent(part)) {
      add('coverage', 'inconclusive', 'invalid-content', seq);
      continue;
    }
    const group = chunks.get(part.seq) ?? new Map<number, TranscriptContent>();
    const previous = group.get(part.offset);
    if (previous && canonicalTrajectory(previous) !== canonicalTrajectory(part))
      add('coverage', 'fail', 'content-conflict', part.seq);
    else if (!previous) {
      group.set(part.offset, part);
      receivedText += part.text.length;
    }
    chunks.set(part.seq, group);
  }
  if (receivedText > trajectoryLimits.maxText) invalid('capture-text-limit');
  const bodies = new Map<number, string>();
  for (const item of ordered) {
    if (!['call', 'result', 'interaction'].includes(item.kind)) continue;
    const parts = [...(chunks.get(item.seq)?.values() ?? [])].sort(
      (left, right) => left.offset - right.offset,
    );
    let offset = 0;
    let complete = !!parts.length;
    for (const part of parts) {
      // Offsets count UTF-16 code units, including a surrogate split across two chunks.
      if (part.offset !== offset || part.total !== item.characters) complete = false;
      offset = part.offset + part.text.length;
    }
    if (offset !== item.characters || parts.at(-1)?.nextOffset !== undefined) complete = false;
    if (complete) bodies.set(item.seq, parts.map((part) => part.text).join(''));
    else add('coverage', 'inconclusive', 'content-incomplete', item.seq);
  }
  const attempts: ToolAttempt[] = [];
  const calls = new Map<string, ToolAttempt>();
  const settled = new Set<string>();
  for (const item of ordered) {
    if (item.kind === 'call') {
      const attempt: ToolAttempt = {
        event: item.seq,
        callId: item.callId ?? '',
        tool: item.name ?? '',
        outcome: 'missing',
      };
      if (!item.callId || !item.name)
        add('coverage', 'inconclusive', 'call-identity-missing', item.seq);
      if (containsRedaction(item.callId))
        add('coverage', 'inconclusive', 'call-identity-redacted', item.seq);
      if (item.callId && calls.has(item.callId))
        add('coverage', 'fail', 'call-id-reused', item.seq);
      else if (item.callId) calls.set(item.callId, attempt);
      const body = bodies.get(item.seq);
      if (body !== undefined) {
        try {
          attempt.args = decodeJson(body);
        } catch {
          add('arguments', 'fail', 'invalid-arguments', item.seq);
        }
      } else add('arguments', 'inconclusive', 'arguments-missing', item.seq);
      attempts.push(attempt);
    }
    if (item.kind !== 'result') continue;
    const attempt = item.callId ? calls.get(item.callId) : undefined;
    if (!attempt) {
      add('coverage', 'fail', 'orphan-result', item.seq);
      continue;
    }
    if (settled.has(item.callId!)) {
      add('coverage', 'fail', 'duplicate-result', item.seq);
      continue;
    }
    settled.add(item.callId!);
    attempt.resultEvent = item.seq;
    const body = bodies.get(item.seq);
    const inspected = body === undefined ? undefined : resultCode(body);
    const code = inspected?.code;
    if (item.code && code && item.code !== code)
      add('coverage', 'fail', 'result-code-conflict', item.seq);
    attempt.code = item.code ?? code;
    if (attempt.code === undefined) delete attempt.code;
    const codes = [item.code, code].filter((value): value is string => value !== undefined);
    const uncertain = codes.find((value) => unknownCodes.has(value as UnknownCode));
    const unrecognized = codes.find((value) => /(?:^|_)OUTCOME_UNKNOWN(?:_|$)/.test(value));
    if (uncertain || unrecognized || inspected?.malformed) {
      attempt.outcome = 'unknown';
      if (uncertain || unrecognized) attempt.code = uncertain ?? unrecognized;
      add(
        'unknown',
        'inconclusive',
        uncertain
          ? 'outcome-unknown'
          : unrecognized
            ? 'unrecognized-unknown-code'
            : 'result-json-unavailable',
        item.seq,
      );
    } else if (body !== undefined) attempt.outcome = item.isError === true ? 'error' : 'success';
  }
  for (const attempt of attempts)
    if (attempt.outcome === 'missing')
      add('coverage', 'inconclusive', 'result-missing', attempt.event);
  return { scope: { ...capture.scope }, requestId: capture.requestId, attempts, issues };
}

function escapePointer(value: string) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function differences(expected: Json, actual: Json, path: string): string[] {
  if (canonical(expected) === canonical(actual)) return [];
  if (
    expected === null ||
    actual === null ||
    typeof expected !== 'object' ||
    typeof actual !== 'object' ||
    Array.isArray(expected) !== Array.isArray(actual)
  )
    return [path];
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const result: string[] = [];
    for (let index = 0; index < Math.max(expected.length, actual.length); index++) {
      const nested = `${path}/${index}`;
      if (index >= expected.length || index >= actual.length) result.push(nested);
      else result.push(...differences(expected[index], actual[index], nested));
    }
    return result;
  }
  const left = expected as { [key: string]: Json };
  const right = actual as { [key: string]: Json };
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort().flatMap((key) => {
    const nested = `${path}/${escapePointer(key)}`;
    return !has(left, key) || !has(right, key)
      ? [nested]
      : differences(left[key], right[key], nested);
  });
}

function normalizedBinding(
  value: Json | undefined,
  root: string | undefined,
  rule: Rule,
): string | undefined {
  if (typeof value !== 'string' || root === undefined) return;
  const marker = `\${${rule.alias}}`;
  if (rule.kind !== 'workspace') return value === root ? marker : undefined;
  const path = value.replace(/\\/g, '/');
  const normalizedRoot = root.replace(/\\/g, '/');
  const base =
    normalizedRoot === '/' || /^[A-Za-z]:\/$/.test(normalizedRoot)
      ? normalizedRoot
      : normalizedRoot.replace(/\/$/, '');
  if (
    !base ||
    /\0/.test(path) ||
    /\0/.test(base) ||
    path.split('/').some((part) => part === '.' || part === '..') ||
    base.split('/').some((part) => part === '.' || part === '..') ||
    !(base.startsWith('/') || /^[A-Za-z]:\//.test(base))
  )
    return;
  if (path === base) return marker;
  const boundary = base.endsWith('/') ? base : `${base}/`;
  return path.startsWith(boundary) ? `${marker}/${path.slice(boundary.length)}` : undefined;
}

function containsRedaction(value: Json | undefined): boolean {
  if (typeof value === 'string') return /\[(?:credential )?redacted\]/i.test(value);
  if (Array.isArray(value)) return value.some(containsRedaction);
  return (
    value !== null && typeof value === 'object' && Object.values(value).some(containsRedaction)
  );
}

function redactedPointers(value: Json, path: string): string[] {
  if (typeof value === 'string') return containsRedaction(value) ? [path] : [];
  if (Array.isArray(value))
    return value.flatMap((item, index) => redactedPointers(item, `${path}/${index}`));
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    redactedPointers(item, `${path}/${escapePointer(key)}`),
  );
}

export function evaluateTrajectory(
  input: TrajectoryCase,
  observed: TrajectoryCapture,
  identity: { configHash: string; codeRevision: string },
): TrajectoryReport {
  const spec = validateTrajectoryCase(input);
  const capture = validateCapture(observed);
  fields(identity, ['configHash', 'codeRevision']);
  if (!sha256.test(identity.configHash) || !text(identity.codeRevision, 500))
    invalid('invalid-identity');
  const trajectory = normalizeTrajectory(capture);
  const results = new Map<Check, TrajectoryReport['checks'][number]>(
    checks.map((check) => [
      check,
      {
        check,
        verdict: 'pass',
        code: 'matched',
        events: [],
        pointers: [],
      },
    ]),
  );
  const rank: Record<Verdict, number> = { pass: 0, inconclusive: 1, fail: 2 };
  const add = (
    name: Check,
    verdict: Verdict,
    code: string,
    events: number[] = [],
    pointers: string[] = [],
  ) => {
    const result = results.get(name)!;
    if (rank[verdict] > rank[result.verdict]) {
      result.verdict = verdict;
      result.code = code;
    }
    result.events = [...new Set([...result.events, ...events])].sort((left, right) => left - right);
    result.pointers = [...new Set([...result.pointers, ...pointers])].sort();
  };
  for (const issue of trajectory.issues)
    add(issue.check, issue.state, issue.code, issue.event === undefined ? [] : [issue.event]);
  // Missing result/body evidence cannot erase counts already proved by complete event metadata.
  const metadataIncomplete = trajectory.issues.some(
    (issue) =>
      issue.check === 'coverage' &&
      issue.state === 'inconclusive' &&
      ![
        'content-incomplete',
        'invalid-content',
        'result-missing',
        'call-identity-missing',
        'call-identity-redacted',
      ].includes(issue.code),
  );
  const actual = trajectory.attempts;
  const expectedTools = spec.steps.map((step) => step.tool);
  const actualTools = actual.map((attempt) => attempt.tool);
  const unknownNames = actualTools.some((tool) => !tool);
  if (actual.length !== spec.steps.length)
    add(
      'coverage',
      actual.length > spec.steps.length || !metadataIncomplete ? 'fail' : 'inconclusive',
      actual.length > spec.steps.length ? 'extra-call' : 'call-missing',
    );
  for (const tool of new Set([...expectedTools, ...actualTools])) {
    if (!tool) continue;
    const expected = expectedTools.filter((name) => name === tool).length;
    const observed = actualTools.filter((name) => name === tool).length;
    if (observed > expected)
      add(
        'coverage',
        'fail',
        'extra-call',
        actual.filter((attempt) => attempt.tool === tool).map((attempt) => attempt.event),
      );
    if (observed < expected)
      add('coverage', metadataIncomplete || unknownNames ? 'inconclusive' : 'fail', 'call-missing');
  }
  const exactOrder = canonical(expectedTools) === canonical(actualTools);
  // Missing bodies cannot erase an observed order violation; missing calls can only complete a compatible subsequence.
  let position = 0;
  for (const tool of actualTools) {
    if (!tool) {
      position++;
      continue;
    }
    while (position < expectedTools.length && expectedTools[position] !== tool) position++;
    position++;
  }
  if (!exactOrder)
    add(
      'order',
      (metadataIncomplete || unknownNames) && position <= expectedTools.length
        ? 'inconclusive'
        : 'fail',
      'call-order',
      actual.map((attempt) => attempt.event),
    );
  if (metadataIncomplete) add('budget', 'inconclusive', 'call-budget-incomplete');
  if (actual.length > spec.budget.maxCalls)
    add(
      'budget',
      'fail',
      'call-budget-exceeded',
      actual.map((attempt) => attempt.event),
    );
  if (spec.budget.maxModelRequests !== undefined) {
    if (capture.modelRequests === undefined)
      add('budget', 'inconclusive', 'model-requests-missing');
    else if (capture.modelRequests > spec.budget.maxModelRequests)
      add('budget', 'fail', 'model-budget-exceeded');
  }
  const aliasValues = new Map<string, string>();
  const conflictedAliases = new Set<string>();
  for (const rule of spec.rules) {
    if (rule.kind === 'workspace') continue;
    // Legal alias names include constructor and __proto__; inherited properties are never fixture bindings.
    const binding = has(capture.bindings, rule.alias) ? capture.bindings[rule.alias] : undefined;
    if (binding === undefined) continue;
    const previous = aliasValues.get(binding);
    if (previous && previous !== rule.alias) {
      conflictedAliases.add(previous);
      conflictedAliases.add(rule.alias);
    } else aliasValues.set(binding, rule.alias);
  }
  spec.steps.forEach((step, index) => {
    if (!exactOrder) {
      add('arguments', 'inconclusive', 'slot-association-incomplete', [], [`/${step.slot}`]);
      return;
    }
    const attempt = actual[index];
    if (!attempt) {
      add(
        'arguments',
        metadataIncomplete ? 'inconclusive' : 'fail',
        'call-arguments-missing',
        [],
        [`/${step.slot}`],
      );
      return;
    }
    if (attempt.outcome === 'missing' || attempt.outcome === 'unknown')
      add('coverage', 'inconclusive', 'outcome-unresolved', [attempt.resultEvent ?? attempt.event]);
    else if (
      attempt.outcome !== step.result ||
      (step.code !== undefined && attempt.code !== step.code)
    )
      add('coverage', 'fail', 'result-mismatch', [attempt.resultEvent ?? attempt.event]);
    if (attempt.args === undefined) {
      add('arguments', 'inconclusive', 'arguments-missing', [attempt.event], [`/${step.slot}`]);
      return;
    }
    let args = structuredClone(attempt.args);
    const redacted = redactedPointers(args, `/${step.slot}`);
    const display = (encoded: string) =>
      spec.sensitive.find(
        (sensitive) => encoded === sensitive || encoded.startsWith(`${sensitive}/`),
      ) ?? encoded;
    if (redacted.length)
      add(
        'arguments',
        'inconclusive',
        'sensitive-evidence-redacted',
        [attempt.event],
        redacted.map(display),
      );
    for (const rule of spec.rules) {
      const parts = pointer(rule.pointer);
      if (parts[0] !== step.slot) continue;
      const selected = lookup(args, parts.slice(1));
      if (containsRedaction(selected.value)) continue;
      const binding = has(capture.bindings, rule.alias) ? capture.bindings[rule.alias] : undefined;
      const replacement = normalizedBinding(selected.value, binding, rule);
      if (!selected.found || replacement === undefined || conflictedAliases.has(rule.alias))
        add('arguments', 'fail', 'binding-mismatch', [attempt.event], [rule.pointer]);
      else args = replace(args, parts.slice(1), replacement);
    }
    // Sensitive values participate in equality before reporting; a redaction marker is missing evidence, not a value.
    const pointers = differences(step.args, args, `/${step.slot}`)
      .filter(
        (encoded) =>
          !redacted.some((missing) => encoded === missing || encoded.startsWith(`${missing}/`)),
      )
      .map(display);
    if (pointers.length) add('arguments', 'fail', 'arguments-mismatch', [attempt.event], pointers);
  });
  const artifacts = new Map<string, Artifact>();
  for (const item of capture.artifacts) {
    if (artifacts.has(item.path)) add('artifacts', 'fail', 'duplicate-artifact');
    else artifacts.set(item.path, item);
    if (!spec.artifacts.some((expected) => expected.path === item.path))
      add('artifacts', 'fail', 'extra-artifact');
  }
  for (const expected of spec.artifacts) {
    const item = artifacts.get(expected.path);
    if (!item || item.state === 'unknown') add('artifacts', 'inconclusive', 'artifact-unverified');
    else if (item.size !== expected.size || item.sha256 !== expected.sha256)
      add('artifacts', 'fail', 'artifact-mismatch');
  }
  if (capture.terminal === undefined) add('terminal', 'inconclusive', 'terminal-missing');
  else if (capture.terminal !== spec.terminal) add('terminal', 'fail', 'terminal-mismatch');
  for (const attempt of actual) {
    if (attempt.outcome !== 'unknown') continue;
    // Once an external effect is uncertain, even a new tool or call id is a prohibited replay in this suite.
    const later = actual.filter(
      (candidate) => candidate.event > (attempt.resultEvent ?? attempt.event),
    );
    if (later.length)
      add(
        'no-replay',
        'fail',
        'call-after-unknown',
        later.map((candidate) => candidate.event),
      );
  }
  if (spec.stopAfter !== undefined) {
    const index = spec.steps.findIndex((step) => step.slot === spec.stopAfter);
    const attempt = actual[index];
    const prefixMatches = actual
      .slice(0, index + 1)
      .every((candidate, slot) => candidate.tool === spec.steps[slot].tool);
    if (
      metadataIncomplete ||
      !prefixMatches ||
      !attempt?.resultEvent ||
      attempt.outcome !== 'error' ||
      attempt.code !== spec.steps[index].code
    )
      add('no-replay', 'inconclusive', 'stop-boundary-missing');
    else {
      const later = actual.filter((candidate) => candidate.event > attempt.resultEvent!);
      if (later.length)
        add(
          'no-replay',
          'fail',
          'call-after-stop',
          later.map((candidate) => candidate.event),
        );
    }
  }
  const reports = checks.map((name) => results.get(name)!);
  const verdict = reports.some((check) => check.verdict === 'fail')
    ? 'fail'
    : reports.some((check) => check.verdict === 'inconclusive')
      ? 'inconclusive'
      : 'pass';
  const versioned = {
    schema: spec.schema,
    id: spec.id,
    revision: spec.revision,
    input: spec.input,
    steps: spec.steps,
    terminal: spec.terminal,
    budget: spec.budget,
    artifacts: spec.artifacts,
    rules: spec.rules,
    sensitive: spec.sensitive,
    ...(spec.stopAfter !== undefined ? { stopAfter: spec.stopAfter } : {}),
  };
  return {
    schema: 1,
    caseId: spec.id,
    revision: spec.revision,
    caseHash: createHash('sha256')
      .update(canonical(versioned as unknown as Json))
      .digest('hex'),
    configHash: identity.configHash,
    codeRevision: identity.codeRevision,
    scope: { ...capture.scope },
    requestId: capture.requestId,
    checks: reports,
    verdict,
  };
}

export function compareTrajectoryReports(left: TrajectoryReport, right: TrajectoryReport) {
  return left.caseHash === right.caseHash && left.configHash === right.configHash
    ? ('comparable' as const)
    : ('incomparable' as const);
}

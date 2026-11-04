import {
  type ContextCapture,
  type ContextCategory,
  type ContextSource,
  type ContextView,
  contextCategories,
  isContextCapture,
  sameContextConversation,
  type TranscriptScope,
} from '@daban/protocol';
import { contextEstimate } from './context.js';
import { Fault } from './control.js';

export interface ContextArchive {
  version: 1;
  nextRevision: number;
  captures: ContextCapture[];
}
export const emptyContextArchive = (): ContextArchive => ({
  version: 1,
  nextRevision: 1,
  captures: [],
});

export function contextSources(
  materials: Partial<Record<ContextCategory, string | null>>,
): ContextSource[] {
  return contextCategories.map((category) => {
    const text = materials[category];
    const hostTokens = typeof text === 'string' ? contextEstimate(text) : null;
    return {
      category,
      evidence: hostTokens === null ? 'unknown' : hostTokens === 0 ? 'not-injected' : 'estimated',
      membership: hostTokens === null || hostTokens === 0 ? 'unknown' : 'host-injected',
      hostTokens,
      savedCharacters: 0,
      refs: [],
      omittedRefs: 0,
    };
  });
}

const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));

export function isContextArchive(value: unknown, scope?: TranscriptScope): value is ContextArchive {
  // Only this optional diagnostic field is quarantined when malformed structure or encoding fails.
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    return (
      Object.keys(record).every((key) => ['version', 'nextRevision', 'captures'].includes(key)) &&
      record.version === 1 &&
      Number.isSafeInteger(record.nextRevision) &&
      Number(record.nextRevision) >= 1 &&
      Array.isArray(record.captures) &&
      record.captures.length <= 20 &&
      record.captures.every(
        (capture, index, all) =>
          isContextCapture(capture) &&
          bytes(capture) <= 6144 &&
          capture.revision < Number(record.nextRevision) &&
          (index === 0 || capture.revision > all[index - 1].revision) &&
          (!scope ||
            capture.sources.every((source) =>
              source.refs.every((ref) => sameContextConversation(scope, ref.scope)),
            )),
      ) &&
      bytes(record) <= 65536
    );
  } catch {
    return false;
  }
}

export function captureContext(
  archive: ContextArchive,
  input: Omit<ContextCapture, 'revision'>,
): ContextArchive {
  if (!isContextArchive(archive) || archive.nextRevision === Number.MAX_SAFE_INTEGER)
    throw new Fault('CONTEXT_CAPTURE_UNAVAILABLE', 503);
  const capture = structuredClone({ ...input, revision: archive.nextRevision });
  const retained = () => {
    if (!capture.gaps.includes('retention')) capture.gaps.push('retention');
  };
  let remaining = 20;
  for (const source of capture.sources) {
    if (source.omittedRefs) retained();
    const count = Math.min(5, remaining, source.refs.length);
    if (count < source.refs.length) retained();
    source.omittedRefs += source.refs.length - count;
    source.refs = source.refs.slice(0, count);
    remaining -= count;
  }
  if (capture.boundary?.omittedSeqs) retained();
  if (capture.boundary && capture.boundary.shadowedSeqs.length > 32) {
    capture.boundary.omittedSeqs += capture.boundary.shadowedSeqs.length - 32;
    capture.boundary.shadowedSeqs = capture.boundary.shadowedSeqs.slice(0, 32);
    retained();
  }
  while (bytes(capture) > 6144) {
    const source = [...capture.sources].reverse().find((item) => item.refs.length);
    if (source) {
      source.refs.pop();
      source.omittedRefs++;
    } else if (capture.boundary?.shadowedSeqs.length) {
      capture.boundary.shadowedSeqs.pop();
      capture.boundary.omittedSeqs++;
    } else throw new Fault('CONTEXT_CAPTURE_UNAVAILABLE', 503);
    retained();
  }
  if (!isContextCapture(capture)) throw new Fault('INVALID_CONTEXT_CAPTURE', 400);
  const next: ContextArchive = {
    version: 1,
    nextRevision: archive.nextRevision + 1,
    captures: [...archive.captures.slice(-19), capture],
  };
  while (bytes(next) > 65536) next.captures.shift();
  return structuredClone(next);
}

export function readContext(
  scope: TranscriptScope,
  archive?: ContextArchive,
  failed = false,
  revision?: number,
): ContextView {
  if (!archive?.captures.length)
    return {
      scope,
      state: 'unavailable',
      reason: failed ? 'capture-unavailable' : archive ? 'not-captured' : 'legacy',
    };
  const selected =
    revision === undefined
      ? archive.captures.at(-1)!
      : archive.captures.find((capture) => capture.revision === revision);
  if (!selected) throw new Fault('CONTEXT_CAPTURE_EXPIRED', 409);
  return structuredClone({
    scope,
    state: 'captured',
    health: failed ? 'capture-failed' : 'ok',
    selected,
    revisions: archive.captures.map((capture) => capture.revision),
  });
}

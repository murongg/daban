import { type ContextCapture, isContextCapture } from '@daban/protocol';
import { expect, test } from 'vitest';
import {
  captureContext,
  contextSources,
  emptyContextArchive,
  isContextArchive,
} from './context-inspector.js';

const scope = { bot: 'mock-bot', runId: 'mock-run', chatRevision: 0 };
const input = (): Omit<ContextCapture, 'revision'> => ({
  at: '2026-01-01T00:00:00.000Z',
  reason: 'turn',
  coverage: 'partial',
  turnId: 'mock-turn',
  estimator: 'daban-text-v1',
  configuredWindow: 16384,
  configuredOutput: 1024,
  sources: contextSources({ request: 'abc合😀', preferences: '', images: null }),
  gaps: ['sdk-envelope', 'images'],
});

test('rejects deep malformed archives before encoding and contains diagnostic serialization exceptions', () => {
  const encoded =
    '{"version":1,"nextRevision":2,"captures":[{"toJSON":null,"x":' +
    '['.repeat(12000) +
    '0' +
    ']'.repeat(12000) +
    '}]}';
  const malformed: unknown = JSON.parse(encoded);
  expect(Buffer.byteLength(encoded)).toBeLessThan(65536);
  expect(() => isContextArchive(malformed, scope)).not.toThrow();
  expect(isContextArchive(malformed, scope)).toBe(false);
  const valid = captureContext(emptyContextArchive(), input());
  const hostile: unknown = Object.setPrototypeOf(
    { ...valid },
    {
      toJSON() {
        throw new Error('SYNTHETIC DIAGNOSTIC SERIALIZATION FAILURE');
      },
    },
  );
  expect(() => isContextArchive(hostile, scope)).not.toThrow();
  expect(isContextArchive(hostile, scope)).toBe(false);
  expect(isContextArchive(valid, scope)).toBe(true);
});

test('estimates only known Host materials without persisting their private content', () => {
  const sources = input().sources;
  expect(sources).toHaveLength(10);
  expect(sources[0]).toMatchObject({ evidence: 'estimated', hostTokens: 5, savedCharacters: 0 });
  expect(sources[2]).toMatchObject({
    evidence: 'not-injected',
    membership: 'unknown',
    hostTokens: 0,
  });
  expect(sources[8]).toMatchObject({ evidence: 'unknown', hostTokens: null });
  expect(JSON.stringify(sources)).not.toContain('abc合😀');
});

test('retains independent SDK numbers and immutable revisions instead of balancing estimates', () => {
  const first = input();
  first.pressure = { seq: 0, at: first.at, pressureTokens: 80, projectedTokens: 100 };
  first.breakdown = { seq: 9, at: first.at, systemTokens: 2, toolsTokens: 3, messageTokens: 4 };
  const archive = captureContext(emptyContextArchive(), first);
  expect(archive.nextRevision).toBe(2);
  expect(isContextCapture(archive.captures[0])).toBe(true);
  expect(archive.captures[0]).toMatchObject({
    pressure: first.pressure,
    breakdown: first.breakdown,
  });
  first.sources[0].hostTokens = 500;
  expect(archive.captures[0].sources[0].hostTokens).toBe(5);
});

test('keeps retention gaps for references already omitted by the producer', () => {
  const value = input();
  value.sources[7].omittedRefs = 3;
  const archive = captureContext(emptyContextArchive(), value);
  expect(archive.captures[0].gaps).toContain('retention');
});

test('bounds references, boundary nodes, bytes and history without reusing evicted revisions', () => {
  let archive = emptyContextArchive();
  const value = input();
  for (const source of value.sources) {
    if (source.category === 'persona' || source.category === 'preferences') continue;
    source.refs = Array.from({ length: 8 }, (_, index) => ({ scope, seq: index + 1 }));
  }
  value.boundary = {
    kind: 'summary',
    endSeq: 100,
    shadowedSeqs: Array.from({ length: 40 }, (_, i) => i),
    omittedSeqs: 0,
  };
  for (let i = 0; i < 25; i++) archive = captureContext(archive, value);
  expect(archive.nextRevision).toBe(26);
  expect(archive.captures.length).toBeGreaterThan(0);
  expect(archive.captures.length).toBeLessThanOrEqual(20);
  expect(archive.captures[0].revision).toBeGreaterThan(1);
  expect(Buffer.byteLength(JSON.stringify(archive))).toBeLessThanOrEqual(65536);
  const last = archive.captures.at(-1)!;
  expect(last.revision).toBe(25);
  expect(last.sources.reduce((n, source) => n + source.refs.length, 0)).toBeLessThanOrEqual(20);
  expect(last.sources.every((source) => source.refs.length <= 5)).toBe(true);
  expect(last.boundary?.shadowedSeqs).toHaveLength(32);
  expect(last.boundary?.omittedSeqs).toBe(8);
  expect(Buffer.byteLength(JSON.stringify(last))).toBeLessThanOrEqual(6144);
  expect(last.gaps).toContain('retention');
  expect(isContextCapture(last)).toBe(true);
});

import { diagnosticIds, isDiagnosticReport } from '@daban/protocol';
import { expect, test } from 'vitest';
import { type DiagnosticSources, Diagnostics } from './diagnostics.js';

function sources() {
  return Object.fromEntries(
    diagnosticIds.runtime.map((id) => [id, () => ({ state: 'ready' })]),
  ) as DiagnosticSources;
}
test('diagnostics isolates failures and returns only fixed status fields, never source details', async () => {
  const checks = sources();
  checks.model = () => ({ state: 'unconfigured', private: 'SYNTHETIC-PRIVATE' });
  checks.profiles = () => ({ state: 'degraded', affected: 2 });
  checks.skills = () => {
    throw new Error('SYNTHETIC-PRIVATE');
  };
  const report = await new Diagnostics(checks).inspect();
  expect(isDiagnosticReport(report)).toBe(true);
  expect(report.checks.find((row) => row.id === 'model')).toStrictEqual({
    id: 'model',
    state: 'unconfigured',
  });
  expect(report.checks.find((row) => row.id === 'profiles')).toStrictEqual({
    id: 'profiles',
    state: 'degraded',
    affected: 2,
  });
  expect(report.checks.find((row) => row.id === 'skills')).toStrictEqual({
    id: 'skills',
    state: 'unavailable',
  });
  expect(report.checks.find((row) => row.id === 'agent')?.state).toBe('ready');
  expect(JSON.stringify(report).includes('SYNTHETIC-PRIVATE')).toBe(false);
});
test('a hung source has a bounded response and concurrent inspections reuse that exact live check', async () => {
  let release: () => unknown = () => undefined;
  let calls = 0;
  const waiting = new Promise<{ state: 'ready' }>((resolve) => {
    release = () => resolve({ state: 'ready' });
  });
  const checks = sources();
  checks.knowledge = () => {
    calls++;
    return waiting;
  };
  const owner = new Diagnostics(checks, 10);
  const reports = await Promise.all([owner.inspect(), owner.inspect(), owner.inspect()]);
  expect(calls).toBe(1);
  expect.assert(
    reports.every(
      (report) => report.checks.find((row) => row.id === 'knowledge')?.state === 'timeout',
    ),
  );
  expect.assert(reports.every(isDiagnosticReport));
  await owner.inspect();
  expect(calls).toBe(1);
  release();
  const recovered = await owner.inspect();
  expect(recovered.checks.find((row) => row.id === 'knowledge')?.state).toBe('ready');
  expect(calls).toBe(1);
});

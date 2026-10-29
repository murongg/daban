import assert from 'node:assert/strict';
import test from 'node:test';
import { diagnosticIds, isDiagnosticReport } from '@daban/protocol';
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
  assert.equal(isDiagnosticReport(report), true);
  assert.deepEqual(
    report.checks.find((row) => row.id === 'model'),
    { id: 'model', state: 'unconfigured' },
  );
  assert.deepEqual(
    report.checks.find((row) => row.id === 'profiles'),
    { id: 'profiles', state: 'degraded', affected: 2 },
  );
  assert.deepEqual(
    report.checks.find((row) => row.id === 'skills'),
    { id: 'skills', state: 'unavailable' },
  );
  assert.equal(report.checks.find((row) => row.id === 'agent')?.state, 'ready');
  assert.equal(JSON.stringify(report).includes('SYNTHETIC-PRIVATE'), false);
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
  assert.equal(calls, 1);
  assert.ok(
    reports.every(
      (report) => report.checks.find((row) => row.id === 'knowledge')?.state === 'timeout',
    ),
  );
  assert.ok(reports.every(isDiagnosticReport));
  await owner.inspect();
  assert.equal(calls, 1);
  release();
  const recovered = await owner.inspect();
  assert.equal(recovered.checks.find((row) => row.id === 'knowledge')?.state, 'ready');
  assert.equal(calls, 1);
});

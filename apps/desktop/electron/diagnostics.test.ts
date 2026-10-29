import { type DiagnosticReport, diagnosticIds, isDiagnosticReport } from '@daban/protocol';
import { expect, it } from 'vitest';
import { parseCommand } from './ipc';
import { RuntimeClient } from './runtime';

it('accepts only a complete closed report and a parameterless human inspection command', () => {
  const report: DiagnosticReport = {
    scope: 'runtime',
    checkedAt: '2026-01-01T00:00:00.000Z',
    checks: diagnosticIds.runtime.map((id) => ({ id, state: 'ready' })),
  };
  expect(isDiagnosticReport(report)).toBe(true);
  expect(parseCommand({ type: 'runtime.inspect' })).toEqual({ type: 'runtime.inspect' });
  for (const bad of [
    { ...report, credentials: 'SYNTHETIC-PRIVATE' },
    { ...report, checkedAt: 'not-a-date' },
    { ...report, checks: report.checks.slice(1) },
    { ...report, checks: new Array(report.checks.length) },
    { ...report, checks: [...report.checks, report.checks[0]] },
    { ...report, checks: report.checks.map((row) => ({ ...row, detail: 'SYNTHETIC-PRIVATE' })) },
    { ...report, checks: report.checks.map((row) => ({ ...row, state: 'invented' })) },
    { ...report, checks: report.checks.map((row) => ({ ...row, affected: 0 })) },
    { ...report, scope: 'host' },
  ])
    expect(isDiagnosticReport(bad)).toBe(false);
  for (const key of ['url', 'path', 'command', 'restart'])
    expect(() => parseCommand({ type: 'runtime.inspect', [key]: 'synthetic' })).toThrow();
});

it('requires a closed runtime-only diagnostic reply and uses no effectful API', async () => {
  let value: unknown = {
    scope: 'runtime',
    checkedAt: '2026-01-01T00:00:00.000Z',
    checks: diagnosticIds.runtime.map((id) => ({ id, state: 'ready' })),
  };
  const routes: string[] = [];
  const client = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    fetcher: async (url, init) => {
      routes.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`);
      if (url.endsWith('/'))
        return new Response('<meta name="prototype-token" content="mock-diagnostics-token">');
      return Response.json(value);
    },
  });
  expect(await client.invoke({ type: 'runtime.inspect' })).toEqual(value);
  value = { ...(value as DiagnosticReport), secret: 'SYNTHETIC-PRIVATE' };
  await expect(client.invoke({ type: 'runtime.inspect' })).rejects.toThrow('INVALID_RUNTIME_STATE');
  expect(routes).toEqual(['GET /', 'GET /api/diagnostics', 'GET /api/diagnostics']);
});

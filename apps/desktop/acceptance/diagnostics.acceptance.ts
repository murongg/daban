import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { isDiagnosticReport } from '@daban/protocol';
import { loadHost } from '../electron/host';

const [config, socket, output] = process.argv.slice(2);
assert.ok(config && socket && output);
const host = await loadHost(config, socket);
try {
  const value = await host.inspect();
  assert.ok(isDiagnosticReport(value) && value.scope === 'host');
  assert.equal(value.checks.find((row) => row.id === 'vm')?.state, 'ready');
  assert.equal(value.checks.find((row) => row.id === 'tunnel')?.state, 'ready');
  assert.equal(value.checks.find((row) => row.id === 'agent')?.state, 'ready');
  assert.equal(value.checks.find((row) => row.id === 'model')?.state, 'unsupported');
  // The adopted service is deliberately still15; inspection must not turn into an upgrade or restart.
  const original = JSON.parse(await readFile(config, 'utf8')) as { port: number };
  await writeFile(
    output,
    JSON.stringify(
      {
        verified: true,
        scope:
          'Actual configured host and original15 read-only inspection; no native Electron or candidate23 host activation',
        report: value,
        originalPortConfigurationRetained: original.port === host.config.port,
        paidModelTaskTurns: 0,
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
} finally {
  await host.close();
}

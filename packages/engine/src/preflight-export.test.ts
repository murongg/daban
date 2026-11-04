import { createHash } from 'node:crypto';
import { type PreflightReport, preflightJson } from '@daban/protocol';
import { expect, test } from 'vitest';
import { preflightPackage } from './preflight-export.js';

const at = Date.parse('2026-01-01T00:00:00.000Z');
const marker = 'SYNTHETIC-PRIVATE-EMAIL-PATH-TOKEN-PROMPT';
function report(): PreflightReport {
  return {
    schema: 1,
    id: 'mock-report',
    bot: 'mock-bot-private',
    workspace: 'mock-private-workspace',
    checkedAt: new Date(at).toISOString(),
    freshUntil: new Date(at + 30000).toISOString(),
    expiresAt: new Date(at + 300000).toISOString(),
    requirements: [0, 1].map((i) => ({
      kind: 'mcp',
      connection: 'mock-connection-private',
      catalogDigest: 'a'.repeat(64),
      tool: `ext_${i.toString(16).padStart(20, '0')}`,
    })),
    checks: [0, 1].map((index) => ({
      index,
      state: 'ready',
      reason: 'CONFIG_PRESENT',
      action: 'none',
      evidence: 'cached-catalog',
      observedAt: new Date(at).toISOString(),
    })),
    versions: [],
    summary: 'ready',
    externalProbe: 'not-run',
    digest: 'b'.repeat(64),
  };
}
test('export projects a closed allowlist even when nested owner fields contain synthetic private markers', () => {
  const source = report();
  Object.assign(source, { token: marker, nested: { account: marker } });
  Object.assign(source.checks[0], { rawError: marker, socket: marker });
  Object.assign(source.requirements[0], {
    description: marker,
    endpoint: marker,
    inputSchema: { secret: marker },
  });
  const pack = preflightPackage(source, at + 1000, '1.2.3');
  expect(pack.json).not.toContain(marker);
  for (const privateId of [
    'mock-bot-private',
    'mock-private-workspace',
    'mock-connection-private',
    'ext_',
  ])
    expect(pack.json).not.toContain(privateId);
  const json = JSON.parse(pack.json);
  expect(
    json.checks.map((check: { connectionAlias: string; toolAlias: string }) => [
      check.connectionAlias,
      check.toolAlias,
    ]),
  ).toEqual([
    ['connection-1', 'tool-1'],
    ['connection-1', 'tool-2'],
  ]);
  expect(pack.json).toBe(preflightJson(json));
  expect(pack.packageDigest).toBe(createHash('sha256').update(pack.json).digest('hex'));
  expect(pack.reportDigest).toBe(source.digest);
});

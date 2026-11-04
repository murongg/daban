import { createHash } from 'node:crypto';
import {
  isPreflightOptions,
  isPreflightPackage,
  isPreflightPackageData,
  isPreflightReport,
  type PreflightReport,
  parseRuntimeCommand,
  preflightJson,
  preflightReportData,
  preflightSources,
} from '@daban/protocol';
import { expect, it } from 'vitest';

const digest = 'a'.repeat(64);
const mcp = {
  kind: 'mcp',
  connection: 'mock-connection',
  catalogDigest: digest,
  tool: `ext_${'b'.repeat(20)}`,
};
const query = {
  id: 'mock-preflight',
  bot: 'mock-bot',
  requirements: [{ kind: 'model', vision: false, tools: true }],
};
function report(): PreflightReport {
  const value: PreflightReport = {
    schema: 1,
    ...query,
    workspace: 'mock-scope',
    checkedAt: '2026-11-04T00:00:00.000Z',
    freshUntil: '2026-11-04T00:00:30.000Z',
    expiresAt: '2026-11-04T00:05:00.000Z',
    requirements: [{ kind: 'model', vision: false, tools: true }],
    versions: preflightSources.map((source) => ({ source, stamp: null })),
    checks: [
      {
        index: 0,
        state: 'unknown',
        reason: 'MODEL_CAPABILITY_UNKNOWN',
        evidence: 'local-config',
        action: 'models',
        observedAt: '2026-11-04T00:00:00.000Z',
      },
    ],
    summary: 'attention',
    externalProbe: 'not-run',
    digest,
  };
  value.digest = createHash('sha256')
    .update(preflightJson(preflightReportData(value)))
    .digest('hex');
  return value;
}
it('rejects overbroad requests, duplicate requirements and non-JSON optional fields', () => {
  const bad = [
    { ...query, workspace: 'mock-other' },
    { ...query, id: '../mock' },
    { ...query, requirements: new Array(2) },
    { ...query, requirements: Array.from({ length: 17 }, () => ({ kind: 'search' })) },
    { ...query, requirements: [mcp, { ...mcp, catalogDigest: 'c'.repeat(64) }] },
    {
      ...query,
      requirements: [
        { kind: 'computer', mode: 'linux', access: 'observe' },
        { kind: 'computer', mode: 'local', access: 'control' },
      ],
    },
    ...[0, 1000001, 2.5, NaN].map((minContextTokens) => ({
      ...query,
      requirements: [{ kind: 'model', vision: false, tools: true, minContextTokens }],
    })),
    {
      ...query,
      requirements: [{ kind: 'model', vision: false, tools: true, minContextTokens: undefined }],
    },
    { ...query, requirements: [{ ...mcp, endpoint: 'https://mock.example.test' }] },
    { ...query, requirements: [{ ...mcp, tool: 'raw-tool-name' }] },
  ];
  for (const input of bad)
    expect(() => parseRuntimeCommand({ type: 'preflight.inspect', query: input })).toThrow(
      'INVALID_COMMAND',
    );
  expect(
    parseRuntimeCommand({
      type: 'preflight.inspect',
      query: { ...query, requirements: [mcp, { ...mcp, connection: 'mock-other' }] },
    }),
  ).toBeTruthy();
});
it('validates ordered checks, fixed sources, matching summary and bounded snapshot times', () => {
  const value = report();
  expect(isPreflightReport(value)).toBe(true);
  for (const invalid of [
    { ...value, token: 'SYNTHETIC-PRIVATE' },
    { ...value, summary: 'ready' },
    { ...value, checks: [{ ...value.checks[0], index: 1 }] },
    { ...value, checks: [] },
    { ...value, checks: [{ ...value.checks[0], detail: 'SYNTHETIC-PRIVATE' }] },
    { ...value, versions: value.versions.slice(1) },
    { ...value, versions: value.versions.map(() => value.versions[0]) },
    { ...value, versions: value.versions.map((row) => ({ ...row, stamp: 'bad' })) },
    { ...value, freshUntil: value.expiresAt },
    { ...value, expiresAt: 'bad' },
    { ...value, externalProbe: 'passed' },
  ])
    expect(isPreflightReport(invalid)).toBe(false);
});
it('bounds MCP pages and keeps unavailable distinct from an empty selection', () => {
  const page = {
    bot: 'mock-bot',
    workspace: 'mock-scope',
    state: 'ready',
    version: digest,
    truncated: false,
    items: [
      {
        connection: mcp.connection,
        catalogDigest: digest,
        tool: mcp.tool,
        connectionLabel: 'Mock connection',
        toolLabel: 'Mock tool',
      },
    ],
  };
  expect(isPreflightOptions(page)).toBe(true);
  expect(isPreflightOptions({ ...page, items: [] })).toBe(false);
  expect(isPreflightOptions({ ...page, items: [...page.items, ...page.items] })).toBe(false);
  expect(
    isPreflightOptions({
      ...page,
      items: page.items.map((item) => ({ ...item, endpoint: 'SYNTHETIC-PRIVATE' })),
    }),
  ).toBe(false);
  expect(isPreflightOptions({ ...page, state: 'empty', items: [] })).toBe(true);
  expect(isPreflightOptions({ ...page, state: 'unavailable', version: null, items: [] })).toBe(
    true,
  );
  expect(
    isPreflightOptions({
      ...page,
      state: 'unavailable',
      version: null,
      items: [],
      truncated: true,
    }),
  ).toBe(false);
});
it('accepts only canonical whitelist package bytes and keeps UTF-16 sorting and array order', () => {
  expect(preflightJson({ z: '中文', a: [{ z: 1, a: 2 }, 3] })).toBe(
    '{"a":[{"a":2,"z":1},3],"z":"中文"}',
  );
  for (const input of [undefined, NaN, Infinity, new Array(2), new Date()])
    expect(() => preflightJson(input)).toThrow('INVALID_PREFLIGHT_JSON');
  const data = {
    schemaVersion: 1,
    productVersion: '0.1.7',
    protocolVersion: 44,
    platform: 'unknown',
    ageSeconds: 0,
    checks: [
      {
        index: 0,
        kind: 'model',
        state: 'unknown',
        reason: 'MODEL_CAPABILITY_UNKNOWN',
        evidence: 'local-config',
        botAlias: 'bot-1',
      },
    ],
  };
  expect(isPreflightPackageData(data)).toBe(true);
  expect(isPreflightPackageData({ ...data, token: 'SYNTHETIC-PRIVATE' })).toBe(false);
  const json = preflightJson(data);
  const value = {
    id: 'mock-preflight',
    reportDigest: digest,
    packageDigest: createHash('sha256').update(json).digest('hex'),
    json,
  };
  expect(isPreflightPackage(value)).toBe(true);
  expect(isPreflightPackage({ ...value, json: JSON.stringify(data) })).toBe(false);
  expect(
    isPreflightPackage({
      ...value,
      json: preflightJson({ ...data, nested: { token: 'SYNTHETIC-PRIVATE' } }),
    }),
  ).toBe(false);
});

it('orders MCP pages by connection then alias even when connection ids share a prefix', () => {
  const item = {
    catalogDigest: digest,
    tool: `ext_${'b'.repeat(20)}`,
    connectionLabel: 'Mock',
    toolLabel: 'Mock',
  };
  expect(
    isPreflightOptions({
      bot: 'mock-bot',
      workspace: 'mock-scope',
      state: 'ready',
      version: digest,
      truncated: false,
      items: [
        { ...item, connection: 'a' },
        { ...item, connection: 'a-b' },
      ],
    }),
  ).toBe(true);
});

it('rejects a green summary whose individual reason contradicts readiness', () => {
  const value = report();
  expect(
    isPreflightReport({
      ...value,
      summary: 'ready',
      checks: [{ ...value.checks[0], state: 'ready', reason: 'MODEL_NOT_CONFIGURED' }],
    }),
  ).toBe(false);
});

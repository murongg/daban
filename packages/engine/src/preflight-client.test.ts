import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  approvalRulesCapability,
  automationCapability,
  disconnected,
  type PreflightPackage,
  type PreflightReport,
  preflightJson,
  preflightReportData,
  preflightSources,
  type RuntimeConsumer,
} from '@daban/protocol';
import { expect, test, vi } from 'vitest';
import { RuntimeClient } from './client.js';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

const query = {
  id: 'mock-query',
  bot: 'mock-bot',
  requirements: [{ kind: 'model' as const, vision: false, tools: false }],
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function report(): PreflightReport {
  const now = Date.now();
  const value: PreflightReport = {
    schema: 1,
    ...query,
    workspace: 'mock-host-scope',
    checkedAt: new Date(now).toISOString(),
    freshUntil: new Date(now + 30000).toISOString(),
    expiresAt: new Date(now + 300000).toISOString(),
    versions: preflightSources.map((source) => ({ source, stamp: null })),
    checks: [
      {
        index: 0,
        state: 'ready',
        reason: 'CONFIG_PRESENT',
        action: 'none',
        evidence: 'local-config',
        observedAt: new Date(now).toISOString(),
      },
    ],
    summary: 'ready',
    externalProbe: 'not-run',
    digest: '',
  };
  value.digest = hash(preflightJson(preflightReportData(value)));
  return value;
}
function bundle(value: PreflightReport): PreflightPackage {
  const json = preflightJson({
    schemaVersion: 1,
    productVersion: '0.1.7',
    protocolVersion: 44,
    platform: 'unknown',
    ageSeconds: 0,
    checks: [
      {
        index: 0,
        kind: 'model',
        state: 'ready',
        reason: 'CONFIG_PRESENT',
        evidence: 'local-config',
        botAlias: 'bot-1',
      },
    ],
  });
  return { id: value.id, reportDigest: value.digest, packageDigest: hash(json), json };
}
function client() {
  const calls: { url: string; init?: RequestInit }[] = [];
  let value: unknown = report();
  const owner = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json(value);
    },
  });
  vi.spyOn(owner, 'status').mockResolvedValue({ ...disconnected('ready'), preflight: 1 });
  return {
    owner,
    calls,
    set: (next: unknown) => {
      value = next;
    },
  };
}
test('does not send preflight commands to a Host without the optional schema capability', async () => {
  const f = client();
  vi.mocked(f.owner.status).mockResolvedValue(disconnected('ready'));
  await expect(f.owner.invoke({ type: 'preflight.inspect', query })).rejects.toThrow(
    'PREFLIGHT_UNSUPPORTED',
  );
  expect(f.calls).toEqual([]);
});
test('maps all four commands exactly and binds preview/export to the inspected immutable report', async () => {
  const f = client(),
    value = report(),
    pack = bundle(value);
  f.set({
    bot: query.bot,
    workspace: value.workspace,
    state: 'empty',
    version: 'a'.repeat(64),
    truncated: false,
    items: [],
  });
  await f.owner.invoke({ type: 'preflight.options', query: { bot: query.bot } });
  f.set(value);
  await expect(f.owner.invoke({ type: 'preflight.inspect', query })).resolves.toEqual(value);
  const read = { id: value.id, digest: value.digest };
  f.set(pack);
  await expect(f.owner.invoke({ type: 'preflight.preview', query: read })).resolves.toEqual(pack);
  await expect(f.owner.invoke({ type: 'preflight.export', query: read })).resolves.toEqual(pack);
  expect(
    f.calls.map(
      (call) => `${call.init?.method} ${new URL(call.url).pathname}${new URL(call.url).search}`,
    ),
  ).toEqual([
    'GET /api/preflight/options?bot=mock-bot',
    'POST /api/preflight/inspect',
    `GET /api/preflight/mock-query/preview?digest=${value.digest}`,
    `GET /api/preflight/mock-query/export?digest=${value.digest}`,
  ]);
  expect(JSON.parse(f.calls[1].init?.body as string)).toEqual(query);
});
test('rejects mismatched Bot, requirements, report digest and package bytes', async () => {
  const f = client(),
    value = report();
  for (const next of [
    { ...value, bot: 'mock-other' },
    { ...value, digest: 'a'.repeat(64) },
    { ...value, requirements: [{ kind: 'search' }] },
    { ...value, checks: [{ ...value.checks[0], token: 'SYNTHETIC-PRIVATE' }] },
  ]) {
    f.set(next);
    await expect(f.owner.invoke({ type: 'preflight.inspect', query })).rejects.toThrow(
      'INVALID_PREFLIGHT_RESPONSE',
    );
  }
  f.set(value);
  await f.owner.invoke({ type: 'preflight.inspect', query });
  const pack = bundle(value),
    read = { id: value.id, digest: value.digest };
  f.set({ ...pack, packageDigest: 'a'.repeat(64) });
  await expect(f.owner.invoke({ type: 'preflight.preview', query: read })).rejects.toThrow(
    'INVALID_PREFLIGHT_RESPONSE',
  );
  f.set(pack);
  await expect(f.owner.invoke({ type: 'preflight.export', query: read })).rejects.toThrow(
    'PREFLIGHT_PREVIEW_REQUIRED',
  );
  await f.owner.invoke({ type: 'preflight.preview', query: read });
  const changedJson = pack.json.replace('"ageSeconds":0', '"ageSeconds":1');
  f.set({ ...pack, json: changedJson, packageDigest: hash(changedJson) });
  await expect(f.owner.invoke({ type: 'preflight.export', query: read })).rejects.toThrow(
    'INVALID_PREFLIGHT_RESPONSE',
  );
});

test('bounds untrusted preflight response bytes before JSON decoding', async () => {
  const response = new Response('x'.repeat(128 * 1024 + 1), {
    headers: { 'content-type': 'application/json' },
  });
  const decode = vi.spyOn(response, 'json');
  const owner = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async () => response,
  });
  vi.spyOn(owner, 'status').mockResolvedValue({ ...disconnected('ready'), preflight: 1 });
  await expect(owner.invoke({ type: 'preflight.inspect', query })).rejects.toThrow(
    'INVALID_PREFLIGHT_RESPONSE',
  );
  expect(decode).not.toHaveBeenCalled();
});

test('real authenticated HTTP client preserves capability, report and preview bytes without starting work', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-preflight-client-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    computers: true,
    port: 0,
  });
  try {
    expect.assert(app.models);
    await app.models.profiles.register({
      id: query.bot,
      name: 'Synthetic',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const owner = new RuntimeClient({ origin: app.url, tokenProvider: async () => app.token });
    expect(await owner.status()).toMatchObject({ phase: 'ready', preflight: 1 });
    expect(
      await owner.invoke({ type: 'preflight.options', query: { bot: query.bot } }),
    ).toMatchObject({ bot: query.bot, state: 'empty', items: [] });
    const value = (await owner.invoke({ type: 'preflight.inspect', query })) as PreflightReport;
    expect(value.checks[0]).toMatchObject({ state: 'missing', reason: 'MODEL_NOT_CONFIGURED' });
    const read = { id: value.id, digest: value.digest };
    const preview = await owner.invoke({ type: 'preflight.preview', query: read });
    expect(await owner.invoke({ type: 'preflight.export', query: read })).toEqual(preview);
    expect(app.runtime.status().items).toHaveLength(0);
    expect(app.models.jobs.size).toBe(0);
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('concurrent preflight invocations preserve their own consumer format and captured query', async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const consumers: unknown[] = [];
  let release: () => unknown = () => undefined;
  const waiting = new Promise<undefined>((resolve) => {
    release = () => resolve(undefined);
  });
  const owner = new RuntimeClient({
    origin: 'http://127.0.0.1:18766',
    tokenProvider: async () => 'a'.repeat(64),
    fetcher: async (url, init) => {
      calls.push({ url, init });
      return Response.json({
        bot: new URL(url).searchParams.get('bot'),
        workspace: 'mock-host-scope',
        state: 'empty',
        version: 'a'.repeat(64),
        truncated: false,
        items: [],
      });
    },
  });
  vi.spyOn(owner, 'status').mockImplementation(async (...args: unknown[]) => {
    consumers.push(structuredClone(args[0]));
    await waiting;
    return { ...disconnected('ready'), preflight: 1 };
  });
  const legacyCommand = { type: 'preflight.options' as const, query: { bot: 'mock-legacy' } };
  const modernCommand = { type: 'preflight.options' as const, query: { bot: 'mock-modern' } };
  const modern: RuntimeConsumer = {
    schema: 2,
    formats: { approvalRules: approvalRulesCapability },
  };
  const legacy = owner.invoke(legacyCommand, 1);
  const current = owner.invoke(modernCommand, modern);
  legacyCommand.query.bot = 'mock-mutated-legacy';
  modernCommand.query.bot = 'mock-mutated-modern';
  Reflect.set(modern.formats!, 'approvalRules', 'mock-mutated-format');
  release();
  const results = await Promise.all([legacy, current]);
  expect(results).toMatchObject([{ bot: 'mock-legacy' }, { bot: 'mock-modern' }]);
  expect(consumers).toEqual([
    { formats: {} },
    { schema: 2, formats: { approvalRules: approvalRulesCapability } },
  ]);
  expect(calls).toHaveLength(2);
  const legacyCall = calls.find(
    (call) => new URL(call.url).searchParams.get('bot') === 'mock-legacy',
  );
  const modernCall = calls.find(
    (call) => new URL(call.url).searchParams.get('bot') === 'mock-modern',
  );
  expect(legacyCall).toBeDefined();
  expect(modernCall).toBeDefined();
  const legacyHeaders = new Headers(legacyCall?.init?.headers);
  const modernHeaders = new Headers(modernCall?.init?.headers);
  expect(legacyHeaders.get('x-daban-automation')).toBeNull();
  expect(legacyHeaders.get('x-daban-approval-rules')).toBeNull();
  expect(modernHeaders.get('x-daban-automation')).toBe(automationCapability);
  expect(modernHeaders.get('x-daban-approval-rules')).toBe(approvalRulesCapability);
});

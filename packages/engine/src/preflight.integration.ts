import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { mock } from 'node:test';
import { isPreflightOptions, isPreflightPackage, isPreflightReport } from '@daban/protocol';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

test('synthetic preflight is read-only, exports only reviewed bytes, and never authorizes execution', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-preflight-integration-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    computers: true,
    port: 0,
  });
  const headers = { 'x-prototype-token': app.token, 'content-type': 'application/json' };
  const get = (route: string) => fetch(`${app.url}${route}`, { headers });
  const inspect = (query: unknown) =>
    fetch(`${app.url}/api/preflight/inspect`, {
      method: 'POST',
      headers,
      body: JSON.stringify(query),
    });
  try {
    assert.ok(app.models);
    const owners = app.models;
    await owners.profiles.register({
      id: 'mock-bot',
      name: 'SYNTHETIC-PRIVATE-NAME',
      instructions: 'SYNTHETIC-PRIVATE-PROMPT',
      memory: 'SYNTHETIC-PRIVATE-MEMORY',
      color: 'mint',
    });
    await owners.settings.save({ apiKey: 'synthetic-private-model-key' });
    const created = await owners.integrations.save(
      {
        requestId: 'mock-save',
        id: 'mock-mcp',
        revision: 0,
        name: 'SYNTHETIC-PRIVATE-CONNECTION',
        endpoint: 'https://mcp.example.test/private',
        bearer: 'synthetic-private-bearer',
      },
      'mock-bot',
    );
    const catalog = await owners.integrations.catalog(
      created.current.id,
      created.current.revision,
      [{ name: 'mock_tool', inputSchema: { type: 'object' } }],
    );
    await owners.integrations.bind('mock-bot', {
      connection: catalog.current.id,
      configRevision: catalog.current.revision,
      bindingRevision: 0,
      catalogDigest: catalog.current.catalogDigest,
      enabled: true,
      tools: ['mock_tool'],
    });
    const captured = await owners.integrations.capture('mock-bot');
    const files = [owners.settings.file, path.join(owners.profiles.directory, 'mock-bot.json')];
    const before = await Promise.all(files.map((file) => readFile(file, 'utf8')));
    const forbidden = () => {
      throw Error('SYNTHETIC-FORBIDDEN-EFFECT');
    };
    const spies = [
      mock.method(owners.settings, 'check', forbidden),
      mock.method(owners.settings, 'inspect', forbidden),
      mock.method(owners.settings, 'configure', forbidden),
      mock.method(owners, 'start', forbidden),
      mock.method(owners, 'stop', forbidden),
      mock.method(owners.tools.integrations!, 'probe', forbidden),
      mock.method(owners.tools.integrations!, 'invoke', forbidden),
      mock.method(app.runtime, 'operate', forbidden),
    ];
    const options = await (await get('/api/preflight/options?bot=mock-bot')).json();
    assert.ok(isPreflightOptions(options));
    const option = options.items[0];
    const query = {
      id: 'mock-query',
      bot: 'mock-bot',
      requirements: [
        { kind: 'model', vision: false, tools: false },
        { kind: 'search' },
        {
          kind: 'mcp',
          connection: option.connection,
          tool: option.tool,
          catalogDigest: option.catalogDigest,
        },
      ],
    };
    const response = await inspect(query);
    assert.equal(response.status, 200);
    const report = await response.json();
    assert.ok(isPreflightReport(report));
    assert.equal(report.summary, 'ready');
    assert.equal(report.externalProbe, 'not-run');
    assert.equal(JSON.stringify(report).includes('SYNTHETIC-PRIVATE'), false);
    assert.equal(JSON.stringify(report).includes(root), false);
    const route = `/api/preflight/${report.id}`;
    const digest = `?digest=${report.digest}`;
    assert.equal((await get(`${route}/export${digest}`)).status, 409);
    const [a, b] = await Promise.all([
      get(`${route}/preview${digest}`),
      get(`${route}/preview${digest}`),
    ]);
    const first = await a.json(),
      second = await b.json();
    assert.ok(isPreflightPackage(first));
    assert.deepEqual(first, second);
    assert.deepEqual(first, await (await get(`${route}/export${digest}`)).json());
    assert.equal(first.json.includes('mock-bot'), false);
    assert.equal(first.json.includes(option.tool), false);
    assert.deepEqual(await Promise.all(files.map((file) => readFile(file, 'utf8'))), before);
    assert.equal(app.runtime.status().items.length, 0);
    assert.equal([...owners.jobs.values()].length, 0);
    for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
    const assignment = (await owners.integrations.assignments('mock-bot')).items[0];
    await owners.integrations.bind('mock-bot', {
      connection: option.connection,
      configRevision: assignment.connection.revision,
      bindingRevision: assignment.revision,
      enabled: false,
      tools: [],
    });
    assert.equal((await get(`${route}/export${digest}`)).status, 409);
    await assert.rejects(
      owners.integrations.assertLive('mock-bot', captured.connections[0], 'mock_tool'),
      { code: 'MCP_AUTHORITY_CHANGED' },
    );
  } finally {
    mock.restoreAll();
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

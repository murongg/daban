import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { secureDirectory } from './private-files.js';
import { startPrototype } from './server.js';

test('human-only preflight checks a synthetic Bot without starting a task or computer', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-preflight-api-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    computers: true,
    port: 0,
  });
  const query = {
    id: 'mock-check',
    bot: 'mock-bot',
    requirements: [{ kind: 'model', vision: false, tools: false }],
  };
  const request = (body: unknown = query, token = app.token) =>
    fetch(`${app.url}/api/preflight/inspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prototype-token': token },
      body: JSON.stringify(body),
    });
  try {
    expect.assert(app.models);
    await app.models.profiles.register({
      id: query.bot,
      name: 'SYNTHETIC-PRIVATE-NAME',
      instructions: 'SYNTHETIC-PRIVATE-PROMPT',
      memory: '',
      color: 'mint',
    });
    const file = path.join(app.models.profiles.directory, `${query.bot}.json`);
    const before = await readFile(file, 'utf8');
    expect((await request(query, 'mock-unauthorized')).status).toBe(403);
    const response = await request();
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report).toMatchObject({
      id: query.id,
      bot: query.bot,
      externalProbe: 'not-run',
      checks: [{ index: 0, state: 'missing', reason: 'MODEL_NOT_CONFIGURED' }],
    });
    expect(JSON.stringify(report)).not.toContain('SYNTHETIC-PRIVATE');
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(app.runtime.status().items).toHaveLength(0);
    expect(Object.values(app.models.status().bots).some((job) => job.running)).toBe(false);
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('exact MCP options, immutable preview bytes and scoped authorization use only local owner facts', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'mock-preflight-mcp-api-'));
  const root = await secureDirectory(path.join(temporary, 'private'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    computers: true,
    port: 0,
  });
  const headers = { 'x-prototype-token': app.token, 'content-type': 'application/json' };
  const get = (route: string) => fetch(`${app.url}${route}`, { headers });
  const post = (route: string, body: unknown) =>
    fetch(`${app.url}${route}`, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    expect.assert(app.models);
    await app.models.profiles.register({
      id: 'mock-bot',
      name: 'Synthetic',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    const integrations = app.models.integrations;
    const saved = await integrations.save(
      {
        requestId: 'mock-save',
        id: 'mock-tools',
        revision: 0,
        name: 'SYNTHETIC-PRIVATE-NAME',
        endpoint: 'https://mcp.example.test/private',
        bearer: 'synthetic-private-bearer',
      },
      'mock-bot',
    );
    const catalog = await integrations.catalog(saved.current.id, saved.current.revision, [
      {
        name: 'synthetic_echo',
        description: 'SYNTHETIC-PRIVATE-DESCRIPTION',
        inputSchema: { type: 'object', properties: {} },
      },
    ]);
    await integrations.bind('mock-bot', {
      connection: catalog.current.id,
      configRevision: catalog.current.revision,
      bindingRevision: 0,
      enabled: true,
      catalogDigest: catalog.current.catalogDigest,
      tools: ['synthetic_echo'],
    });
    const pageResponse = await get('/api/preflight/options?bot=mock-bot');
    expect(pageResponse.status).toBe(200);
    const page = await pageResponse.json();
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain('SYNTHETIC-PRIVATE-DESCRIPTION');
    expect(JSON.stringify(page)).not.toContain('mcp.example.test');
    const option = page.items[0];
    const response = await post('/api/preflight/inspect', {
      id: 'mock-mcp',
      bot: 'mock-bot',
      requirements: [
        {
          kind: 'mcp',
          connection: option.connection,
          tool: option.tool,
          catalogDigest: option.catalogDigest,
        },
      ],
    });
    expect(response.status).toBe(200);
    const report = await response.json();
    expect(report.checks[0].state).toBe('ready');
    const base = `/api/preflight/${report.id}`;
    const search = `?digest=${report.digest}`;
    expect((await get(`${base}/export${search}`)).status).toBe(409);
    const first = await get(`${base}/preview${search}`);
    expect(first.status).toBe(200);
    const preview = await first.json();
    expect(preview.json).not.toContain('mock-tools');
    expect(preview.json).not.toContain('synthetic_echo');
    expect(preview.json).not.toContain('SYNTHETIC-PRIVATE');
    expect(await (await get(`${base}/export${search}`)).json()).toEqual(preview);
    expect((await get(`${base}/preview${search}&path=mock`)).status).toBe(400);
    expect((await get(`${base}/preview${search}&digest=${report.digest}`)).status).toBe(400);
    expect((await get('/api/preflight/options?bot=mock-bot&bot=mock-other')).status).toBe(400);
    expect((await get('/api/preflight/options?bot=mock-bot&endpoint=mock')).status).toBe(400);
    expect(
      (
        await post('/api/preflight/inspect', {
          id: 'mock-foreign',
          bot: 'mock-unknown',
          requirements: [{ kind: 'search' }],
        })
      ).status,
    ).toBe(404);
    const binding = (await integrations.assignments('mock-bot')).items[0];
    await integrations.bind('mock-bot', {
      connection: catalog.current.id,
      configRevision: catalog.current.revision,
      bindingRevision: binding.revision,
      enabled: false,
      tools: [],
    });
    expect((await get(`${base}/export${search}`)).status).toBe(409);
    expect(app.runtime.status().items).toHaveLength(0);
    expect(await integrations.calls('mock-bot')).toMatchObject({ items: [] });
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

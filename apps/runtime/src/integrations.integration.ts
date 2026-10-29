import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isMcpAssignments,
  isMcpCatalog,
  isMcpHistory,
  isMcpSaved,
  managedProtocol,
} from '@daban/protocol';
import { IntegrationTools } from './integration-tools.js';
import { startPrototype } from './server.js';

test('authenticated MCP API keeps config private, isolates Bot review, and offers read-only receipts without a tool-execution route', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-mcp-api-'));
  const app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  let probes = 0;
  const offered = [
    { name: 'synthetic_echo', description: '合成回声', inputSchema: { type: 'object' } },
  ];
  const input = {
    requestId: 'mock-api-save',
    id: 'mock-api-connection',
    revision: 0,
    name: '合成 API 连接',
    endpoint: 'https://mcp.example.test/private-path?key=synthetic-api-query',
    bearer: 'synthetic-api-bearer',
  };
  const request = async (
    command: Record<string, unknown>,
    token = app.token,
    action = String(command.type).slice(4),
  ) => {
    const response = await fetch(`${app.url}/api/mcp/${action}`, {
      method: 'POST',
      headers: { 'x-prototype-token': token, 'content-type': 'application/json' },
      body: JSON.stringify(command),
    });
    const value = await response.json();
    const json = JSON.stringify(value);
    assert.equal(json.includes(input.endpoint), false);
    assert.equal(json.includes(input.bearer), false);
    assert.equal(json.includes('synthetic-api-query'), false);
    return { status: response.status, value };
  };
  try {
    assert.ok(app.models);
    const models = app.models;
    await models.tools.integrations!.close();
    models.tools.integrations = new IntegrationTools(models.integrations, models.interactions, {
      remote: async () => {
        probes++;
        return {
          start: async () => {},
          tools: async () => offered,
          call: async () => {
            throw new Error('HTTP setup must never execute a tool');
          },
          close: async () => {},
        };
      },
    });
    for (const id of ['mock-api-a', 'mock-api-b'])
      await models.profiles.register({ id, name: id, instructions: '', memory: '', color: 'mint' });
    const state = await (
      await fetch(`${app.url}/api/state`, { headers: { 'x-prototype-token': app.token } })
    ).json();
    assert.equal(state.clientProtocol, managedProtocol);
    assert.equal(state.mcp.available, true);
    assert.equal((await request({ type: 'mcp.list' }, 'synthetic-wrong-token')).status, 403);
    assert.equal((await request({ type: 'mcp.save', input, permissions: 'all' })).status, 400);
    assert.equal(
      (await request({ type: 'mcp.saved', id: input.requestId, connection: input.id })).status,
      404,
    );
    const saved = await request({ type: 'mcp.save', input });
    assert.equal(saved.status, 200);
    assert.ok(isMcpSaved(saved.value));
    assert.equal(saved.value.current.revision, 1);
    assert.equal(
      (await request({ type: 'mcp.saved', id: input.requestId, connection: input.id })).status,
      200,
    );
    assert.equal(
      (
        await request({
          type: 'mcp.saved',
          id: input.requestId,
          connection: 'mock-foreign-connection',
        })
      ).status,
      404,
    );
    assert.equal((await request({ type: 'mcp.list' })).value.items.length, 1);
    assert.equal(probes, 0);
    const checked = await request({ type: 'mcp.check', id: input.id, revision: 1 });
    assert.equal(checked.status, 200);
    assert.ok(isMcpCatalog(checked.value));
    assert.equal(probes, 1);
    const cached = await request({ type: 'mcp.catalog', id: input.id });
    assert.ok(isMcpCatalog(cached.value));
    assert.equal(probes, 1);
    const binding = {
      connection: input.id,
      configRevision: 1,
      bindingRevision: 0,
      catalogDigest: checked.value.current.catalogDigest,
      tools: ['synthetic_echo'],
      enabled: true,
    };
    assert.equal(
      (await request({ type: 'mcp.bind', bot: 'mock-unregistered', input: binding })).status,
      404,
    );
    const bound = await request({ type: 'mcp.bind', bot: 'mock-api-a', input: binding });
    assert.equal(bound.value.bot, 'mock-api-a');
    assert.equal(bound.value.entry.available, true);
    assert.equal(
      (await request({ type: 'mcp.bind', bot: 'mock-api-a', input: binding })).status,
      409,
    );
    const other = await request({ type: 'mcp.bindings', bot: 'mock-api-b' });
    assert.ok(isMcpAssignments(other.value));
    assert.equal(other.value.items[0].enabled, false);
    assert.equal(
      (await request({ type: 'mcp.catalog', id: input.id }, app.token, 'bind')).status,
      400,
    );
    assert.equal(
      (await request({ type: 'mcp.invoke', bot: 'mock-api-a', tool: 'synthetic_echo' })).status,
      400,
    );
    assert.equal((await request({ type: 'mcp.constructor' })).status, 400);
    await models.integrations.claim({
      id: 'mock-api-call',
      bot: 'mock-api-a',
      run: 'mock-api-run',
      session: 'mock-api-session',
      connection: input.id,
      configRevision: 1,
      tool: 'synthetic_echo',
      arguments: {},
      preview: '{}',
    });
    await models.integrations.dispatched('mock-api-call');
    await models.integrations.finish('mock-api-call', {
      phase: 'unknown',
      error: 'MCP_OUTCOME_UNKNOWN',
    });
    const history = await request({ type: 'mcp.calls', bot: 'mock-api-a', connection: input.id });
    assert.ok(isMcpHistory(history.value));
    assert.equal(history.value.items[0].phase, 'unknown');
    assert.equal(history.value.items[0].configRevision, 1);
    assert.equal(
      (
        await request({
          type: 'mcp.receipt',
          bot: 'mock-api-b',
          run: 'mock-api-run',
          id: 'mock-api-call',
        })
      ).status,
      404,
    );
    assert.equal((await request({ type: 'mcp.calls', bot: 'mock-api-b' })).value.items.length, 0);
    const archived = await request({ type: 'mcp.archive', id: input.id, revision: 1 });
    assert.equal(archived.value.deleted, true);
    assert.equal((await request({ type: 'mcp.list' })).value.items.length, 0);
    assert.equal((await request({ type: 'mcp.list', includeDeleted: true })).value.items.length, 1);
    await request({ type: 'mcp.restore', id: input.id, revision: 2 });
    const restored = await request({ type: 'mcp.bindings', bot: 'mock-api-a' });
    assert.equal(restored.value.items[0].enabled, false);
    assert.equal(probes, 1);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('an unreadable MCP store is retained while the ordinary runtime and profiles remain available', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'synthetic-mcp-api-corrupt-'));
  let app = await startPrototype({
    profileDir: path.join(root, 'profile'),
    port: 0,
    computers: true,
  });
  await app.close();
  const file = path.join(root, 'model/integrations.sqlite');
  const bytes = Buffer.from('SYNTHETIC-CORRUPT-MCP-STORE');
  await writeFile(file, bytes);
  app = await startPrototype({ profileDir: path.join(root, 'profile'), port: 0, computers: true });
  try {
    const state = await (
      await fetch(`${app.url}/api/state`, { headers: { 'x-prototype-token': app.token } })
    ).json();
    assert.equal(state.clientProtocol, managedProtocol);
    assert.equal(state.mcp.available, false);
    assert.equal(state.computers.available, true);
    assert.ok(app.models);
    await app.models.profiles.register({
      id: 'mock-corrupt-chat',
      name: '合成普通 Bot',
      instructions: '',
      memory: '',
      color: 'mint',
    });
    assert.equal((await app.models.integrations.capture('mock-corrupt-chat')).available, false);
    assert.equal((await app.models.profiles.get('mock-corrupt-chat'))?.id, 'mock-corrupt-chat');
    assert.deepEqual(await readFile(file), bytes);
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});

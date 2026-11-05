import { isMcpAssignments, isMcpCatalog, isMcpList, type McpCommand } from '@daban/protocol';
import { expect, test } from 'vitest';
import { createMcpViewFixture as fixture } from './mcp-view.fixture.js';

test.each([1, 77])(
  'legacy Bearer list/check/bind remains usable beside an OAuth catalog of %i tools',
  async (count) => {
    const f = await fixture(count);
    try {
      const listed = await f.request({ type: 'mcp.list', bot: 'mock-a' });
      expect(listed.status).toBe(200);
      expect.assert(isMcpList(listed.value));
      expect(listed.value.items.map((item) => item.id)).toEqual([f.bearer.id]);
      expect(listed.value.items.every((item) => item.toolCount <= 64)).toBe(true);
      const checked = await f.request({
        type: 'mcp.check',
        bot: 'mock-a',
        id: f.bearer.id,
        revision: 1,
      });
      expect(checked.status).toBe(200);
      expect(isMcpCatalog(checked.value)).toBe(true);
      const input = {
        connection: f.bearer.id,
        configRevision: 1,
        bindingRevision: 0,
        catalogDigest: f.bearerCatalog.current.catalogDigest,
        tools: ['synthetic_echo'],
        enabled: true,
      };
      expect((await f.request({ type: 'mcp.bind', bot: 'mock-a', input })).status).toBe(200);
      const assignments = await f.request({ type: 'mcp.bindings', bot: 'mock-a' });
      expect.assert(isMcpAssignments(assignments.value));
      expect(assignments.value.items.map((item) => item.connection.id)).toEqual([f.bearer.id]);
      const full = await f.request({ type: 'mcp.list', bot: 'mock-a' }, 'apps');
      expect.assert(isMcpList(full.value));
      expect(full.value.items).toHaveLength(2);
      expect(full.value.items.find((item) => item.id === f.target.connection)?.toolCount).toBe(
        count,
      );
      expect((await f.models.integrations.list(false, 'mock-a')).items).toHaveLength(2);
    } finally {
      await f.close();
    }
  },
);

test('a legacy check cannot replace a reviewed Bearer catalog with a response its decoder cannot read', async () => {
  const f = await fixture(1);
  try {
    f.setBearerCount(77);
    const checked = await f.request({
      type: 'mcp.check',
      bot: 'mock-a',
      id: f.bearer.id,
      revision: 1,
    });
    expect(checked.status).toBe(409);
    expect(checked.value).toEqual({ error: 'INVALID_MCP_CATALOG' });
    expect((await f.models.integrations.catalogView(f.bearer.id, 'mock-a')).tools).toEqual(
      f.bearerCatalog.tools,
    );
    const full = await f.request(
      { type: 'mcp.check', bot: 'mock-a', id: f.bearer.id, revision: 1 },
      'apps',
    );
    expect(full.status).toBe(200);
    expect.assert(isMcpCatalog(full.value));
    expect(full.value.tools).toHaveLength(77);
    const legacy = await f.request({ type: 'mcp.list', bot: 'mock-a' });
    expect.assert(isMcpList(legacy.value));
    expect(legacy.value.items).toEqual([]);
    expect((await f.models.integrations.list(false, 'mock-a')).items).toHaveLength(2);
  } finally {
    await f.close();
  }
});

test('legacy management cannot use or alter OAuth, and the full view header is not interactive authority', async () => {
  const f = await fixture(1);
  try {
    const before = await f.models.integrations.oauthGrant(f.target.connection);
    for (const command of [
      { type: 'mcp.catalog', bot: 'mock-a', id: f.target.connection },
      { type: 'mcp.check', bot: 'mock-a', id: f.target.connection, revision: 1 },
      {
        type: 'mcp.bind',
        bot: 'mock-a',
        input: {
          connection: f.target.connection,
          configRevision: 1,
          bindingRevision: 0,
          catalogDigest: f.appCatalog.current.catalogDigest,
          tools: ['synthetic_oauth_0'],
          enabled: true,
        },
      },
    ] satisfies McpCommand[]) {
      const result = await f.request(command);
      expect(result.status).toBe(409);
      expect(result.value).toEqual({ error: 'MCP_APP_VIEW_REQUIRED' });
    }
    expect(f.authorizations()).toBe(0);
    expect(
      (
        await f.request(
          { type: 'mcp.archive', bot: 'mock-a', id: f.target.connection, revision: 1 },
          'apps',
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          {
            type: 'mcp.save',
            bot: 'mock-a',
            input: {
              requestId: 'mock-overwrite',
              id: f.target.connection,
              revision: 1,
              name: 'Synthetic replacement',
              bearer: 'synthetic-replacement',
            },
          },
          'apps',
        )
      ).value,
    ).toEqual({ error: 'OAUTH_MANAGED_CONNECTION' });
    expect(await f.models.integrations.oauthGrant(f.target.connection)).toEqual(before);
    expect((await f.request({ type: 'mcp.list', bot: 'mock-a' }, 'unexpected')).status).toBe(400);
  } finally {
    await f.close();
  }
});

test('the full view does not bypass Bot ownership or change missing save-receipt recovery', async () => {
  const f = await fixture(77);
  try {
    await f.models.profiles.register({
      id: 'mock-b',
      name: 'Synthetic other Bot',
      instructions: '',
      memory: '',
      color: 'blue',
    });
    const other = await f.request({ type: 'mcp.list', bot: 'mock-b' }, 'apps');
    expect.assert(isMcpList(other.value));
    expect(other.value.items).toEqual([]);
    expect(
      (await f.request({ type: 'mcp.catalog', bot: 'mock-b', id: f.target.connection }, 'apps'))
        .status,
    ).toBe(404);
    const missing = await f.request({
      type: 'mcp.saved',
      bot: 'mock-a',
      id: 'mock-no-save',
      connection: 'mock-no-connection',
    });
    expect(missing.status).toBe(404);
    expect(missing.value).toEqual({ error: 'MCP_SAVE_NOT_FOUND' });
  } finally {
    await f.close();
  }
});

test('unsupported large Bearer metadata cannot poison another legacy Bearer or disappear from storage', async () => {
  const f = await fixture(1);
  try {
    const input = {
      requestId: 'mock-large-save',
      id: 'mock-large-bearer',
      revision: 0,
      name: 'Synthetic large Bearer',
      endpoint: 'https://large.example.test/mcp',
      bearer: 'synthetic-large-bearer',
    };
    await f.models.integrations.save(input, 'mock-a');
    await f.models.integrations.catalog(
      input.id,
      1,
      Array.from({ length: 77 }, (_, index) => ({
        name: `synthetic_large_${index}`,
        description: 'Synthetic',
        inputSchema: { type: 'object' },
      })),
    );
    const legacy = await f.request({ type: 'mcp.list', bot: 'mock-a' });
    expect.assert(isMcpList(legacy.value));
    expect(legacy.value.items.map((item) => item.id)).toEqual([f.bearer.id]);
    const full = await f.request({ type: 'mcp.list', bot: 'mock-a' }, 'apps');
    expect.assert(isMcpList(full.value));
    expect(full.value.items).toHaveLength(3);
    expect((await f.models.integrations.privateConfig(input.id)).bearer).toBe(input.bearer);
    expect((await f.models.integrations.list(false, 'mock-a')).items).toHaveLength(3);
  } finally {
    await f.close();
  }
});

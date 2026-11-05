import { expect, test } from 'vitest';
import { mcpCatalog, mcpDigest } from './mcp-catalog.js';

const tool = {
  name: 'synthetic_echo',
  description: 'Synthetic tool description',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
};

test.each([
  {
    input: [{ ...tool, name: '' }],
    diagnostic: { reason: 'tool_name', path: 'tools[0].name', actual: 0, limit: 200 },
  },
  {
    input: 'synthetic-private-value',
    diagnostic: { reason: 'catalog_type', path: 'tools', kind: 'string' },
  },
  {
    input: Array.from({ length: 65 }, () => tool),
    diagnostic: { reason: 'tool_count', path: 'tools', actual: 65, limit: 64 },
  },
  {
    input: [[]],
    diagnostic: { reason: 'tool_type', path: 'tools[0]', kind: 'array', toolCount: 1 },
  },
  {
    input: [{ ...tool, name: 'x'.repeat(201) }],
    diagnostic: {
      reason: 'tool_name',
      path: 'tools[0].name',
      actual: 201,
      limit: 200,
      toolCount: 1,
    },
  },
  {
    input: [{ ...tool, name: 'synthetic\nname' }],
    diagnostic: { reason: 'tool_name', path: 'tools[0].name', controlCharacters: true },
  },
  {
    input: [{ ...tool, inputSchema: null }],
    diagnostic: { reason: 'input_schema', path: 'tools[0].inputSchema', kind: 'null' },
  },
  {
    input: [{ ...tool, inputSchema: { properties: {} } }],
    diagnostic: { reason: 'schema_type', path: 'tools[0].inputSchema.type', kind: 'undefined' },
  },
  {
    input: [{ ...tool, inputSchema: { type: 'array' } }],
    diagnostic: { reason: 'schema_type', path: 'tools[0].inputSchema.type', schemaType: 'array' },
  },
  {
    input: [{ ...tool, description: 'x'.repeat(2001) }],
    diagnostic: {
      reason: 'description_length',
      path: 'tools[0].description',
      actual: 2001,
      limit: 2000,
      toolCount: 1,
    },
  },
])(
  'catalog rejection retains its code and exposes only bounded diagnostic facts: $diagnostic.reason',
  ({ input, diagnostic }) => {
    expect(() => mcpCatalog('synthetic-connection', input, [])).toThrowError('INVALID_MCP_CATALOG');
    try {
      mcpCatalog('synthetic-connection', input, []);
      expect.unreachable('The rejected synthetic catalog must not be accepted');
    } catch (error) {
      expect(error).toMatchObject({ code: 'INVALID_MCP_CATALOG', diagnostic });
    }
  },
);

test('catalog diagnostics never include provider names, descriptions, schema fields or credentials', () => {
  const sensitive = {
    name: 'synthetic-private-tool-name',
    description: 'synthetic-private-description'.padEnd(2001, 'x'),
    inputSchema: {
      type: 'object',
      properties: { 'synthetic-private-field': { const: 'synthetic-credential-value' } },
    },
  };
  let diagnostic: unknown;
  try {
    mcpCatalog('synthetic-connection', [sensitive], []);
  } catch (error) {
    expect(error).toMatchObject({ diagnostic: { reason: 'description_length' } });
    diagnostic = (error as { diagnostic: unknown }).diagnostic;
  }
  expect(diagnostic).toEqual({
    reason: 'description_length',
    path: 'tools[0].description',
    toolCount: 1,
    actual: 2001,
    limit: 2000,
  });
  const serialized = JSON.stringify(diagnostic);
  for (const value of [
    sensitive.name,
    'synthetic-private-description',
    'synthetic-private-field',
    'synthetic-credential-value',
  ])
    expect(serialized.includes(value)).toBe(false);
  expect(serialized.length).toBeLessThan(256);
});

test('unknown schema type strings are classified without logging their contents', () => {
  const privateType = 'synthetic-private-schema-type';
  try {
    mcpCatalog('synthetic-connection', [{ ...tool, inputSchema: { type: privateType } }], []);
    expect.unreachable('A non-object schema type must remain rejected');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'INVALID_MCP_CATALOG',
      diagnostic: {
        reason: 'schema_type',
        path: 'tools[0].inputSchema.type',
        kind: 'string',
        schemaType: 'unknown',
      },
    });
    expect(JSON.stringify(error).includes(privateType)).toBe(false);
  }
});

test('valid catalog boundaries preserve the complete definition, stable alias and digest', () => {
  const maximum = { ...tool, description: 'x'.repeat(2000) };
  const catalog = mcpCatalog('synthetic-connection', [maximum], []);
  expect(catalog).toEqual([
    {
      ...maximum,
      alias: `ext_${mcpDigest(['synthetic-connection', maximum.name]).slice(0, 20)}`,
      digest: mcpDigest(maximum),
    },
  ]);
  expect(
    mcpCatalog(
      'synthetic-connection',
      Array.from({ length: 64 }, (_, index) => ({ ...tool, name: `synthetic_${index}` })),
      [],
    ).length,
  ).toBe(64);
  expect(() =>
    mcpCatalog(
      'synthetic-connection',
      [{ ...tool, inputSchema: { type: 'object', padding: 'x'.repeat(32768) } }],
      [],
    ),
  ).toThrowError('MCP_CATALOG_LIMIT');
  expect(() =>
    mcpCatalog(
      'synthetic-connection',
      [{ ...tool, description: 'synthetic-secret' }],
      ['synthetic-secret'],
    ),
  ).toThrowError('MCP_SECRET_IN_CATALOG');
});

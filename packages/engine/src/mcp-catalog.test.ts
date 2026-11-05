import { expect, test } from 'vitest';
import { canonicalJson, mcpCatalog, mcpDigest } from './mcp-catalog.js';

const tool = {
  name: 'synthetic_echo',
  description: 'Synthetic tool description',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
};

function nested(depth: number) {
  let value: unknown = 'synthetic-private-leaf';
  for (let index = 0; index < depth; index++) value = { [`synthetic-private-key-${index}`]: value };
  return value;
}

test.each([
  { value: undefined, reason: 'json_type', kind: 'undefined' },
  { value: 1n, reason: 'json_type', kind: 'bigint' },
  { value: Symbol('synthetic-private-symbol'), reason: 'json_type', kind: 'symbol' },
  { value: () => 'synthetic-private-function', reason: 'json_type', kind: 'function' },
  { value: Number.NaN, reason: 'json_number', kind: 'number' },
  { value: Number.POSITIVE_INFINITY, reason: 'json_number', kind: 'number' },
  { value: Number.NEGATIVE_INFINITY, reason: 'json_number', kind: 'number' },
  { value: new Date(0), reason: 'json_prototype', kind: 'object' },
  { value: new Map(), reason: 'json_prototype', kind: 'object' },
  { value: new Set(), reason: 'json_prototype', kind: 'object' },
  { value: new Uint8Array(1), reason: 'json_prototype', kind: 'object' },
])(
  'JSON rejection classifies $reason/$kind without exporting the value',
  ({ value, reason, kind }) => {
    try {
      canonicalJson({ 'synthetic-private-field': value });
      expect.unreachable('Unsupported JSON values must remain rejected');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_MCP_JSON',
        status: 400,
        diagnostic: { reason, stage: 'value', path: 'value.object[0]', kind, depth: 1 },
      });
      expect(JSON.stringify(error)).not.toContain('synthetic-private');
    }
  },
);

test('JSON diagnostics retain the exact depth16 boundary and omit arbitrary keys at every level', () => {
  expect(canonicalJson(nested(16))).toBe(JSON.stringify(nested(16)));
  try {
    canonicalJson(nested(17));
    expect.unreachable('Depth17 must remain rejected');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'INVALID_MCP_JSON',
      status: 400,
      diagnostic: {
        reason: 'json_depth',
        stage: 'value',
        path: `value${'.object[0]'.repeat(17)}`,
        kind: 'string',
        depth: 17,
        limit: 16,
      },
    });
    expect(JSON.stringify(error)).not.toContain('synthetic-private');
  }
});

test.each([
  { depth: 15, stage: 'definition' },
  { depth: 14, stage: 'catalog' },
])(
  'catalog JSON diagnostics identify the $stage serialization pass without changing its boundary',
  ({ depth, stage }) => {
    const input = [
      { ...tool, inputSchema: { type: 'object', 'synthetic-private-field': nested(depth) } },
    ];
    try {
      mcpCatalog('synthetic-connection', input, []);
      expect.unreachable('Both definition and aggregate depth limits must remain enforced');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'INVALID_MCP_JSON',
        status: 400,
        diagnostic: { reason: 'json_depth', stage, kind: 'string', depth: 17, limit: 16 },
      });
      const diagnostic = (error as { diagnostic: { path: string } }).diagnostic;
      expect(diagnostic.path).toMatch(/^tools(?:\[0\])?(?:\.(?:object|array)\[\d+\])+$/);
      expect(JSON.stringify(diagnostic)).not.toContain('synthetic-private');
    }
    expect(
      mcpCatalog(
        'synthetic-connection',
        [{ ...tool, inputSchema: { type: 'object', padding: nested(13) } }],
        [],
      ),
    ).toHaveLength(1);
  },
);

test('JSON diagnostics use numeric array positions and never inspect a private constructor name', () => {
  class SyntheticPrivateClass {}
  try {
    canonicalJson([new SyntheticPrivateClass()]);
    expect.unreachable('Non-plain objects must remain rejected');
  } catch (error) {
    expect(error).toMatchObject({
      diagnostic: {
        reason: 'json_prototype',
        stage: 'value',
        path: 'value.array[0]',
        kind: 'object',
        depth: 1,
      },
    });
    expect(JSON.stringify(error)).not.toContain('SyntheticPrivateClass');
  }
});

test('valid JSON canonical output, tool aliases and digests remain byte-for-byte stable', () => {
  const value = { z: ['synthetic', null, true, false, -2.5], a: { q: 1, b: 'quote"\n' } };
  expect(canonicalJson(value)).toBe(
    '{"a":{"b":"quote\\"\\n","q":1},"z":["synthetic",null,true,false,-2.5]}',
  );
  expect(mcpDigest(value)).toBe('5f1be9c3e7a2984ff7fc163171edfba70f9b71988586451b4786224ea96b8079');
  const plain = Object.assign(Object.create(null) as Record<string, unknown>, { z: 2, a: 1 });
  expect(canonicalJson(plain)).toBe('{"a":1,"z":2}');
  expect(mcpCatalog('synthetic-connection', [{ ...tool, description: 'Synthetic' }], [])).toEqual([
    {
      ...tool,
      description: 'Synthetic',
      alias: 'ext_98ec0b8590d1d0004aa6',
      digest: '0d0340e742031f925420f0d97fbd2922098261dd30923ec78e8cbf44dae65df9',
    },
  ]);
});

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
    input: Array.from({ length: 129 }, () => tool),
    diagnostic: { reason: 'tool_count', path: 'tools', actual: 129, limit: 128 },
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

test.each([77, 128])(
  'a bounded candidate catalog retains all %i tools and their complete digest',
  (count) => {
    const input = Array.from({ length: count }, (_, index) => ({
      ...tool,
      name: `synthetic_capacity_${index}`,
    }));
    const catalog = mcpCatalog('synthetic-capacity', input, []);
    expect(catalog).toHaveLength(count);
    const changed = input.map((entry, index) =>
      index === count - 1 ? { ...entry, description: 'Synthetic changed final tool' } : entry,
    );
    const revised = mcpCatalog('synthetic-capacity', changed, []);
    expect(mcpDigest(catalog)).not.toBe(mcpDigest(revised));
    expect(catalog.map((entry) => entry.alias)).toEqual(revised.map((entry) => entry.alias));
  },
);

test('candidate capacity still rejects 129 tools before processing individual definitions', () => {
  try {
    mcpCatalog(
      'synthetic-capacity',
      Array.from({ length: 129 }, () => tool),
      [],
    );
    expect.unreachable('The bounded catalog must reject its first excess item');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'INVALID_MCP_CATALOG',
      diagnostic: { reason: 'tool_count', actual: 129, limit: 128 },
    });
  }
});

test('a larger candidate count cannot evade the unchanged total-byte budget', () => {
  const input = Array.from({ length: 77 }, (_, index) => ({
    name: `synthetic_capacity_${index}`,
    description: 'x'.repeat(1800),
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string', description: 'y'.repeat(1800) } },
    },
  }));
  expect(() => mcpCatalog('synthetic-capacity', input, [])).toThrowError('MCP_CATALOG_LIMIT');
});

test.each(['duplicate', 'schema', 'secret'] as const)(
  'the final candidate tool still participates in %s rejection',
  (invalid) => {
    const input = Array.from({ length: 77 }, (_, index) => ({
      ...tool,
      name: `synthetic_capacity_${index}`,
    }));
    if (invalid === 'duplicate') input[76] = { ...input[76], name: input[0].name };
    if (invalid === 'schema')
      input[76] = { ...input[76], inputSchema: { ...tool.inputSchema, type: 'array' } };
    if (invalid === 'secret')
      input[76] = { ...input[76], description: 'synthetic-capacity-secret' };
    const code =
      invalid === 'duplicate'
        ? 'MCP_CATALOG_LIMIT'
        : invalid === 'secret'
          ? 'MCP_SECRET_IN_CATALOG'
          : 'INVALID_MCP_CATALOG';
    expect(() =>
      mcpCatalog('synthetic-capacity', input, ['synthetic-capacity-secret']),
    ).toThrowError(code);
    if (invalid === 'schema') {
      try {
        mcpCatalog('synthetic-capacity', input, []);
      } catch (error) {
        expect(error).toMatchObject({
          diagnostic: { reason: 'schema_type', path: 'tools[76].inputSchema.type' },
        });
      }
    }
  },
);

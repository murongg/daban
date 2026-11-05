import { expect, test, vi } from 'vitest';
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

function deepDefinition(name: string, nesting: number) {
  return {
    ...tool,
    name,
    inputSchema: { type: 'object', 'synthetic-private-schema': nested(nesting) },
  };
}

function rejectedCatalog(input: unknown, secrets: readonly string[] = []) {
  try {
    mcpCatalog('synthetic-measurement', input, secrets);
  } catch (error) {
    return error;
  }
  return expect.unreachable('Measurement must not make the depth16 catalog acceptable');
}

test.each([
  {
    nesting: [15, 20],
    stage: 'definition',
    schemaDepth: 21,
    definitionDepth: 22,
    catalogDepth: 23,
  },
  { nesting: [14], stage: 'catalog', schemaDepth: 15, definitionDepth: 16, catalogDepth: 17 },
])(
  'a rejected $stage pass can report complete catalog measurements without accepting it',
  ({ nesting, stage, schemaDepth, definitionDepth, catalogDepth }) => {
    const input = nesting.map((depth, index) =>
      deepDefinition(`synthetic-private-tool-${index}`, depth),
    );
    const error = rejectedCatalog(input);
    expect(error).toMatchObject({
      code: 'INVALID_MCP_JSON',
      status: 400,
      diagnostic: {
        reason: 'json_depth',
        stage,
        depth: 17,
        limit: 16,
        measurement: {
          status: 'complete',
          toolCount: input.length,
          schemaDepth,
          definitionDepth,
          catalogDepth,
          maxDefinitionBytes: Math.max(
            ...input.map((entry) => Buffer.byteLength(JSON.stringify(entry))),
          ),
          catalogBytes: Buffer.byteLength(
            JSON.stringify(
              input.map((entry) => ({
                ...entry,
                alias: `ext_${'0'.repeat(20)}`,
                digest: '0'.repeat(64),
              })),
            ),
          ),
          depthCeiling: 64,
          nodeLimit: 524288,
        },
      },
    });
    expect(JSON.stringify(error)).not.toContain('synthetic-private');
  },
);

test('observation stops at its own finite ceiling without claiming the catalog maximum', () => {
  const error = rejectedCatalog([
    deepDefinition('synthetic-first', 15),
    deepDefinition('synthetic-later', 63),
  ]);
  expect(error).toMatchObject({
    code: 'INVALID_MCP_JSON',
    status: 400,
    diagnostic: {
      reason: 'json_depth',
      stage: 'definition',
      depth: 17,
      limit: 16,
      measurement: {
        status: 'incomplete',
        stopCode: 'MCP_OBSERVATION_DEPTH_LIMIT',
        depthCeiling: 64,
        nodeLimit: 524288,
      },
    },
  });
  expect(error).not.toHaveProperty('diagnostic.measurement.schemaDepth');
  expect(error).not.toHaveProperty('diagnostic.measurement.definitionDepth');
  expect(error).not.toHaveProperty('diagnostic.measurement.catalogDepth');
});

test.each([61, 62])(
  'the observation ceiling includes the catalog wrapper for nesting%i',
  (nesting) => {
    const error = rejectedCatalog([deepDefinition('synthetic-boundary', nesting)]);
    expect(error).toMatchObject({ code: 'INVALID_MCP_JSON', diagnostic: { depth: 17, limit: 16 } });
    if (nesting === 61)
      expect(error).toMatchObject({
        diagnostic: {
          measurement: {
            status: 'complete',
            schemaDepth: 62,
            definitionDepth: 63,
            catalogDepth: 64,
          },
        },
      });
    else {
      expect(error).toMatchObject({
        diagnostic: {
          measurement: { status: 'incomplete', stopCode: 'MCP_OBSERVATION_DEPTH_LIMIT' },
        },
      });
      expect(error).not.toHaveProperty('diagnostic.measurement.catalogDepth');
    }
  },
);

test('unexpected observation errors cannot export their text or impersonate local stop codes', () => {
  const later = {
    ...tool,
    get inputSchema(): Record<string, unknown> {
      throw Object.assign(Error('synthetic-private-error'), { code: 'MCP_CATALOG_LIMIT' });
    },
  };
  const error = rejectedCatalog([deepDefinition('synthetic-first', 15), later]);
  expect(error).toMatchObject({
    code: 'INVALID_MCP_JSON',
    diagnostic: {
      depth: 17,
      limit: 16,
      measurement: { status: 'incomplete', stopCode: 'MCP_OBSERVATION_UNAVAILABLE' },
    },
  });
  expect(JSON.stringify(error)).not.toContain('synthetic-private');
});

test('complete byte metrics retain UTF8, escaped controls and lone-surrogate JSON semantics', () => {
  let value: unknown = '合成\n"\\😀\ud800';
  for (let index = 0; index < 15; index++) value = { synthetic: value };
  const definition = { ...tool, inputSchema: { type: 'object', padding: value } };
  const error = rejectedCatalog([definition]);
  expect(error).toMatchObject({
    diagnostic: {
      measurement: {
        status: 'complete',
        maxDefinitionBytes: Buffer.byteLength(JSON.stringify(definition)),
        catalogBytes: Buffer.byteLength(
          JSON.stringify([
            { ...definition, alias: `ext_${'0'.repeat(20)}`, digest: '0'.repeat(64) },
          ]),
        ),
      },
    },
  });
});

test.each([
  {
    later: { ...tool, inputSchema: { type: 'object', 'synthetic-private-field': undefined } },
    stopCode: 'INVALID_MCP_JSON',
  },
  {
    later: { ...tool, inputSchema: { type: 'object', 'synthetic-private-field': new Date(0) } },
    stopCode: 'INVALID_MCP_JSON',
  },
  {
    later: { ...tool, inputSchema: { type: 'object', 'synthetic-private-field': Number.NaN } },
    stopCode: 'INVALID_MCP_JSON',
  },
  {
    later: { ...tool, description: 'synthetic-private-secret' },
    stopCode: 'MCP_SECRET_IN_CATALOG',
  },
  {
    later: { ...tool, inputSchema: { type: 'object', padding: 'x'.repeat(32768) } },
    stopCode: 'MCP_CATALOG_LIMIT',
  },
  { later: { ...tool, name: 'synthetic-first' }, stopCode: 'MCP_CATALOG_LIMIT' },
  {
    later: { ...tool, description: 'synthetic-private-description'.padEnd(2001, 'x') },
    stopCode: 'INVALID_MCP_CATALOG',
  },
])(
  'a later $stopCode prevents a complete measurement and preserves the original depth rejection',
  ({ later, stopCode }) => {
    const error = rejectedCatalog(
      [deepDefinition('synthetic-first', 15), later],
      ['synthetic-private-secret'],
    );
    expect(error).toMatchObject({
      code: 'INVALID_MCP_JSON',
      status: 400,
      diagnostic: {
        reason: 'json_depth',
        stage: 'definition',
        depth: 17,
        limit: 16,
        measurement: { status: 'incomplete', stopCode, depthCeiling: 64, nodeLimit: 524288 },
      },
    });
    expect(error).not.toHaveProperty('diagnostic.measurement.catalogDepth');
    expect(JSON.stringify(error)).not.toContain('synthetic-private');
  },
);

test('a complete depth scan cannot hide the unchanged total catalog byte rejection', () => {
  const input = [
    deepDefinition('synthetic-first', 15),
    ...Array.from({ length: 76 }, (_, index) => ({
      ...tool,
      name: `synthetic-later-${index}`,
      description: 'x'.repeat(1800),
      inputSchema: { type: 'object', padding: 'y'.repeat(1800) },
    })),
  ];
  const error = rejectedCatalog(input);
  expect(error).toMatchObject({
    code: 'INVALID_MCP_JSON',
    status: 400,
    diagnostic: {
      reason: 'json_depth',
      depth: 17,
      limit: 16,
      measurement: {
        status: 'incomplete',
        stopCode: 'MCP_CATALOG_LIMIT',
        depthCeiling: 64,
        nodeLimit: 524288,
      },
    },
  });
  expect(error).not.toHaveProperty('diagnostic.measurement.catalogDepth');
});

test('a wide invalid catalog stops within the observation work or byte budget', () => {
  let reads = 0;
  const padding = new Proxy(Array<number>(600000).fill(0), {
    get(target, key, receiver): unknown {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
      return Reflect.get(target, key, receiver);
    },
  });
  const error = rejectedCatalog([
    deepDefinition('synthetic-first', 15),
    { ...tool, inputSchema: { type: 'object', padding } },
  ]);
  expect(error).toMatchObject({
    code: 'INVALID_MCP_JSON',
    diagnostic: {
      depth: 17,
      limit: 16,
      measurement: {
        status: 'incomplete',
        nodeLimit: 524288,
        stopCode: expect.stringMatching(/^(MCP_CATALOG_LIMIT|MCP_OBSERVATION_NODE_LIMIT)$/),
      },
    },
  });
  expect(reads).toBeLessThanOrEqual(524289);
  expect(error).not.toHaveProperty('diagnostic.measurement.catalogDepth');
});

test.each(['value', 'key'] as const)(
  'observation refuses a huge %s before JSON string encoding',
  (position) => {
    const huge = 'x'.repeat(1048576);
    const stringify = JSON.stringify;
    let encodes = 0;
    const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (value === huge) {
        encodes++;
        throw Error('SYNTHETIC_OVERSIZED_SCALAR_ENCODED');
      }
      return stringify(value);
    });
    try {
      const schema =
        position === 'value'
          ? { type: 'object', padding: huge }
          : { type: 'object', [huge]: 'synthetic' };
      const error = rejectedCatalog([
        deepDefinition('synthetic-first', 15),
        { ...tool, inputSchema: schema },
      ]);
      expect(error).toMatchObject({
        code: 'INVALID_MCP_JSON',
        diagnostic: {
          limit: 16,
          measurement: { status: 'incomplete', stopCode: 'MCP_CATALOG_LIMIT' },
        },
      });
      expect(encodes).toBe(0);
    } finally {
      spy.mockRestore();
    }
  },
);

test('each repeated shared string is charged before a definition can amplify its output', () => {
  const shared = 'x'.repeat(12000);
  const stringify = JSON.stringify;
  let encodes = 0;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
    if (value === shared) encodes++;
    return stringify(value);
  });
  try {
    const branch = { value: shared };
    const error = rejectedCatalog([
      deepDefinition('synthetic-first', 15),
      { ...tool, inputSchema: { type: 'object', padding: Array(40).fill(branch) } },
    ]);
    expect(error).toMatchObject({
      code: 'INVALID_MCP_JSON',
      diagnostic: {
        limit: 16,
        measurement: { status: 'incomplete', stopCode: 'MCP_CATALOG_LIMIT' },
      },
    });
    expect(encodes).toBeLessThanOrEqual(2);
  } finally {
    spy.mockRestore();
  }
});

test('the catalog byte budget stops shared-scalar amplification across individually valid definitions', () => {
  const shared = 'x'.repeat(12000);
  const stringify = JSON.stringify;
  let encodes = 0;
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
    if (value === shared) encodes++;
    return stringify(value);
  });
  try {
    const error = rejectedCatalog([
      deepDefinition('synthetic-first', 15),
      ...Array.from({ length: 30 }, (_, index) => ({
        ...tool,
        name: `synthetic-shared-${index}`,
        inputSchema: { type: 'object', padding: shared },
      })),
    ]);
    expect(error).toMatchObject({
      code: 'INVALID_MCP_JSON',
      diagnostic: {
        limit: 16,
        measurement: { status: 'incomplete', stopCode: 'MCP_CATALOG_LIMIT' },
      },
    });
    expect(encodes).toBeLessThanOrEqual(21);
  } finally {
    spy.mockRestore();
  }
});

test('generic request digests keep depth16 and never start catalog observation', () => {
  try {
    mcpDigest(nested(17));
    expect.unreachable('Request fingerprint depth17 must remain rejected');
  } catch (error) {
    expect(error).toMatchObject({
      code: 'INVALID_MCP_JSON',
      diagnostic: { stage: 'value', depth: 17, limit: 16 },
    });
    expect(error).not.toHaveProperty('diagnostic.measurement');
  }
});

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

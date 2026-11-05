import { createHash } from 'node:crypto';
import type { McpTool } from '@daban/protocol';
import { Fault } from './control.js';

export type { McpTool } from '@daban/protocol';

export interface McpCatalogDiagnostic {
  reason:
    | 'catalog_type'
    | 'tool_count'
    | 'tool_type'
    | 'tool_name'
    | 'input_schema'
    | 'schema_type'
    | 'description_length';
  path: string;
  toolCount?: number;
  kind?: ReturnType<typeof valueKind>;
  actual?: number;
  limit?: number;
  controlCharacters?: boolean;
  schemaType?: 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'unknown';
}

export class McpCatalogError extends Fault {
  constructor(readonly diagnostic: McpCatalogDiagnostic) {
    super('INVALID_MCP_CATALOG', 400);
  }
}

function valueKind(value: unknown) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function rejectCatalog(diagnostic: McpCatalogDiagnostic): never {
  throw new McpCatalogError(diagnostic);
}

export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 16) throw new Fault('INVALID_MCP_JSON', 400);
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (
    value &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key], depth + 1)}`,
      )
      .join(',')}}`;
  throw new Fault('INVALID_MCP_JSON', 400);
}
export const mcpDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export function mcpCatalog(
  connection: string,
  input: unknown,
  secrets: readonly string[],
): McpTool[] {
  if (!Array.isArray(input))
    rejectCatalog({ reason: 'catalog_type', path: 'tools', kind: valueKind(input) });
  if (input.length > 64)
    rejectCatalog({ reason: 'tool_count', path: 'tools', actual: input.length, limit: 64 });
  const tools = input
    .map((raw: unknown, index) => {
      const path = `tools[${index}]`;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        rejectCatalog({ reason: 'tool_type', path, toolCount: input.length, kind: valueKind(raw) });
      const value = raw as Record<string, unknown>;
      // Keep malformed oversized names on the constant-time rejection path.
      const controlCharacters =
        typeof value.name === 'string' &&
        value.name.length <= 200 &&
        [...value.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
      if (
        typeof value.name !== 'string' ||
        !value.name ||
        value.name.length > 200 ||
        controlCharacters
      )
        rejectCatalog({
          reason: 'tool_name',
          path: `${path}.name`,
          toolCount: input.length,
          kind: valueKind(value.name),
          ...(typeof value.name === 'string'
            ? {
                actual: value.name.length,
                limit: 200,
                ...(value.name.length <= 200 ? { controlCharacters } : {}),
              }
            : {}),
        });
      if (
        !value.inputSchema ||
        typeof value.inputSchema !== 'object' ||
        Array.isArray(value.inputSchema)
      )
        rejectCatalog({
          reason: 'input_schema',
          path: `${path}.inputSchema`,
          toolCount: input.length,
          kind: valueKind(value.inputSchema),
        });
      const schema = value.inputSchema as Record<string, unknown>;
      if (schema.type !== 'object') {
        const type = schema.type;
        rejectCatalog({
          reason: 'schema_type',
          path: `${path}.inputSchema.type`,
          toolCount: input.length,
          kind: valueKind(type),
          schemaType:
            type === 'array' ||
            type === 'string' ||
            type === 'number' ||
            type === 'integer' ||
            type === 'boolean' ||
            type === 'null'
              ? type
              : 'unknown',
        });
      }
      const description =
        typeof value.description === 'string' ? value.description : `External tool ${value.name}`;
      if (description.length > 2000)
        rejectCatalog({
          reason: 'description_length',
          path: `${path}.description`,
          toolCount: input.length,
          actual: description.length,
          limit: 2000,
        });
      const definition = {
        name: value.name,
        description,
        inputSchema: value.inputSchema as Record<string, unknown>,
      };
      const json = canonicalJson(definition);
      if (Buffer.byteLength(json) > 32768) throw new Fault('MCP_CATALOG_LIMIT', 400);
      if (secrets.some((secret) => secret && json.includes(JSON.stringify(secret).slice(1, -1))))
        throw new Fault('MCP_SECRET_IN_CATALOG', 400);
      return {
        ...definition,
        inputSchema: structuredClone(definition.inputSchema),
        alias: `ext_${mcpDigest([connection, value.name]).slice(0, 20)}`,
        digest: mcpDigest(definition),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  if (
    new Set(tools.map((tool) => tool.name)).size !== tools.length ||
    Buffer.byteLength(canonicalJson(tools)) > 256000
  )
    throw new Fault('MCP_CATALOG_LIMIT', 400);
  return tools;
}

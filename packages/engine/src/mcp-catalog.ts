import { createHash } from 'node:crypto';
import type { McpTool } from '@daban/protocol';
import { Fault } from './control.js';

export type { McpTool } from '@daban/protocol';
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
  if (!Array.isArray(input) || input.length > 64) throw new Fault('INVALID_MCP_CATALOG', 400);
  const tools = input
    .map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        throw new Fault('INVALID_MCP_CATALOG', 400);
      const value = raw as Record<string, unknown>;
      if (
        typeof value.name !== 'string' ||
        !value.name ||
        value.name.length > 200 ||
        [...value.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
        !value.inputSchema ||
        typeof value.inputSchema !== 'object' ||
        Array.isArray(value.inputSchema) ||
        (value.inputSchema as Record<string, unknown>).type !== 'object'
      )
        throw new Fault('INVALID_MCP_CATALOG', 400);
      const description =
        typeof value.description === 'string' ? value.description : `External tool ${value.name}`;
      if (description.length > 2000) throw new Fault('INVALID_MCP_CATALOG', 400);
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

import { createHash } from 'node:crypto';
import {
  legacyMcpCatalogToolLimit,
  type McpTool,
  type McpView,
  mcpCatalogToolLimit,
} from '@daban/protocol';
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

interface McpJsonDiagnostic {
  reason: 'json_depth' | 'json_type' | 'json_number' | 'json_prototype';
  stage: 'value' | 'definition' | 'catalog';
  path: string;
  kind: ReturnType<typeof valueKind>;
  depth: number;
  limit?: number;
  measurement?: CatalogMeasurement;
}

const observationLimits = { depthCeiling: 64, nodeLimit: 524288 } as const;
const observationStopCodes = [
  'INVALID_MCP_CATALOG',
  'INVALID_MCP_JSON',
  'MCP_CATALOG_LIMIT',
  'MCP_SECRET_IN_CATALOG',
  'MCP_OBSERVATION_DEPTH_LIMIT',
  'MCP_OBSERVATION_NODE_LIMIT',
  'MCP_OBSERVATION_UNAVAILABLE',
] as const;
type ByteStopKind =
  | 'definition_bytes'
  | 'retained_catalog_bytes'
  | 'aggregate_bytes'
  | 'definition_and_retained_bytes';
interface ByteFrame {
  kind: ByteStopKind;
  frameBudgetBytes: number;
  remaining: number;
  toolOffset?: number;
}
type CatalogLimitStop =
  | {
      kind: ByteStopKind;
      frameBudgetBytes: number;
      remainingBytes: number;
      fragmentBytes: number;
      fragmentBasis: 'exact' | 'minimum';
      toolOffset?: number;
    }
  | { kind: 'duplicate_names'; toolCount: number; uniqueCount: number }
  | { kind: 'budget_accounting' | 'unclassified_limit' };

class CatalogLimitError extends Fault {
  constructor(readonly stop: CatalogLimitStop) {
    super('MCP_CATALOG_LIMIT', 400);
  }
}

type CatalogMeasurement = typeof observationLimits &
  (
    | {
        status: 'complete';
        toolCount: number;
        schemaDepth: number;
        definitionDepth: number;
        catalogDepth: number;
        maxDefinitionBytes: number;
        catalogBytes: number;
      }
    | { status: 'incomplete'; stopCode: 'MCP_CATALOG_LIMIT'; stop: CatalogLimitStop }
    | {
        status: 'incomplete';
        stopCode: Exclude<(typeof observationStopCodes)[number], 'MCP_CATALOG_LIMIT'>;
      }
  );
interface CatalogObservation {
  nodes: number;
  definitionDepth: number;
  catalogDepth: number;
  maxDefinitionBytes: number;
  catalogBytes: number;
}
interface CanonicalBudget extends ByteFrame {
  depth: number;
  observation: CatalogObservation;
}

export class McpJsonError extends Fault {
  constructor(readonly diagnostic: McpJsonDiagnostic) {
    super('INVALID_MCP_JSON', 400);
  }
}

function valueKind(value: unknown) {
  return value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
}

function rejectCatalog(diagnostic: McpCatalogDiagnostic): never {
  throw new McpCatalogError(diagnostic);
}

function limitFault(budget: ByteFrame, bytes: number, basis: 'exact' | 'minimum') {
  if (
    ![budget.frameBudgetBytes, budget.remaining, bytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    budget.frameBudgetBytes > 256000 ||
    budget.remaining > budget.frameBudgetBytes ||
    (budget.toolOffset !== undefined &&
      (!Number.isSafeInteger(budget.toolOffset) ||
        budget.toolOffset < 0 ||
        budget.toolOffset >= mcpCatalogToolLimit))
  )
    return new CatalogLimitError({ kind: 'budget_accounting' });
  // Project only locally known fields; foreign exceptions and budget internals must never enter the diagnostic.
  return new CatalogLimitError({
    kind: budget.kind,
    frameBudgetBytes: budget.frameBudgetBytes,
    remainingBytes: budget.remaining,
    fragmentBytes: bytes,
    fragmentBasis: basis,
    ...(budget.toolOffset === undefined ? {} : { toolOffset: budget.toolOffset }),
  });
}

function definitionBudget(observation: CatalogObservation, toolOffset: number): CanonicalBudget {
  const retained = 256000 - observation.catalogBytes - Number(toolOffset > 0);
  const remaining = Math.min(32768, retained);
  return {
    kind:
      retained < 32768
        ? 'retained_catalog_bytes'
        : retained === 32768
          ? 'definition_and_retained_bytes'
          : 'definition_bytes',
    frameBudgetBytes: remaining,
    remaining,
    toolOffset,
    depth: 0,
    observation,
  };
}

function spend(bytes: number, budget: CanonicalBudget) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.remaining)
    throw limitFault(budget, bytes, 'exact');
  budget.remaining -= bytes;
}

function scalar(value: string | number | boolean | null, budget?: CanonicalBudget) {
  // JSON encoding cannot be shorter than its UTF16 input plus quotes; bound allocation before escaping.
  if (budget && typeof value === 'string' && value.length + 2 > budget.remaining)
    throw limitFault(budget, value.length + 2, 'minimum');
  const json = JSON.stringify(value);
  if (budget) spend(Buffer.byteLength(json), budget);
  return json;
}

export function canonicalJson(value: unknown, depth = 0): string {
  return canonical(value, depth, 'value', 'value');
}

function canonical(
  value: unknown,
  depth: number,
  path: string,
  stage: McpJsonDiagnostic['stage'],
  budget?: CanonicalBudget,
): string {
  if (budget) {
    if (++budget.observation.nodes > observationLimits.nodeLimit)
      throw new Fault('MCP_OBSERVATION_NODE_LIMIT', 400);
    if (depth > observationLimits.depthCeiling) throw new Fault('MCP_OBSERVATION_DEPTH_LIMIT', 400);
    budget.depth = Math.max(budget.depth, depth);
  } else if (depth > 16)
    throw new McpJsonError({
      reason: 'json_depth',
      stage,
      path,
      kind: valueKind(value),
      depth,
      limit: 16,
    });
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return scalar(value, budget);
  if (Array.isArray(value)) {
    if (budget) {
      const length = value.length;
      spend(2 + Math.max(0, length - 1), budget);
      const items: string[] = [];
      // Fix the bounded length before iteration; Array.map could allocate from an untrusted length first.
      for (let index = 0; index < length; index++)
        items.push(
          index in value
            ? canonical(value[index], depth + 1, `${path}.array[${index}]`, stage, budget)
            : '',
        );
      return `[${items.join(',')}]`;
    }
    return `[${value.map((item, index) => canonical(item, depth + 1, `${path}.array[${index}]`, stage)).join(',')}]`;
  }
  if (
    value &&
    typeof value === 'object' &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    const keys = Object.keys(value);
    if (budget) spend(2 + Math.max(0, keys.length - 1) + keys.length, budget);
    return `{${keys
      .sort()
      .map(
        // Schema keys can contain credentials; diagnostics use sorted positions, never their names.
        (key, index) =>
          `${scalar(key, budget)}:${canonical((value as Record<string, unknown>)[key], depth + 1, `${path}.object[${index}]`, stage, budget)}`,
      )
      .join(',')}}`;
  }
  throw new McpJsonError({
    reason:
      typeof value === 'object'
        ? 'json_prototype'
        : typeof value === 'number'
          ? 'json_number'
          : 'json_type',
    stage,
    path,
    kind: valueKind(value),
    depth,
  });
}
export const mcpDigest = (value: unknown) =>
  createHash('sha256').update(canonicalJson(value)).digest('hex');
export function mcpCatalog(
  connection: string,
  input: unknown,
  secrets: readonly string[],
  view: McpView = 'apps',
): McpTool[] {
  try {
    return catalog(connection, input, secrets, view);
  } catch (error) {
    if (
      error instanceof McpJsonError &&
      error.diagnostic.reason === 'json_depth' &&
      error.diagnostic.stage !== 'value'
    )
      error.diagnostic.measurement = observeCatalog(connection, input, secrets, view);
    // Observation is evidence only; a complete measurement must never become an accepted catalog.
    throw error;
  }
}

function observeCatalog(
  connection: string,
  input: unknown,
  secrets: readonly string[],
  view: McpView,
): CatalogMeasurement {
  const observation: CatalogObservation = {
    nodes: 0,
    definitionDepth: 0,
    catalogDepth: 0,
    maxDefinitionBytes: 0,
    catalogBytes: 2,
  };
  try {
    const tools = catalog(connection, input, secrets, view, observation);
    return {
      ...observationLimits,
      status: 'complete',
      toolCount: tools.length,
      schemaDepth: Math.max(0, observation.definitionDepth - 1),
      definitionDepth: observation.definitionDepth,
      catalogDepth: observation.catalogDepth,
      maxDefinitionBytes: observation.maxDefinitionBytes,
      catalogBytes: observation.catalogBytes,
    };
  } catch (error) {
    const stopCode = observationStopCodes.find(
      (code) => error instanceof Fault && error.code === code,
    );
    if (stopCode === 'MCP_CATALOG_LIMIT')
      return {
        ...observationLimits,
        status: 'incomplete',
        stopCode,
        stop: error instanceof CatalogLimitError ? error.stop : { kind: 'unclassified_limit' },
      };
    return {
      ...observationLimits,
      status: 'incomplete',
      stopCode: stopCode ?? 'MCP_OBSERVATION_UNAVAILABLE',
    };
  }
}

function catalog(
  connection: string,
  input: unknown,
  secrets: readonly string[],
  view: McpView,
  observation?: CatalogObservation,
): McpTool[] {
  if (!Array.isArray(input))
    rejectCatalog({ reason: 'catalog_type', path: 'tools', kind: valueKind(input) });
  const limit = view === 'bearer' ? legacyMcpCatalogToolLimit : mcpCatalogToolLimit;
  if (input.length > limit)
    rejectCatalog({ reason: 'tool_count', path: 'tools', actual: input.length, limit });
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
      // Apply the remaining catalog allowance while encoding each definition, before shared graphs can expand.
      const budget = observation ? definitionBudget(observation, index) : undefined;
      const json = canonical(definition, 0, `tools[${index}]`, 'definition', budget);
      const bytes = Buffer.byteLength(json);
      if (bytes > 32768) {
        if (observation)
          throw limitFault(
            {
              kind: 'definition_bytes',
              frameBudgetBytes: 32768,
              remaining: 32768,
              toolOffset: index,
            },
            bytes,
            'exact',
          );
        throw new Fault('MCP_CATALOG_LIMIT', 400);
      }
      if (secrets.some((secret) => secret && json.includes(JSON.stringify(secret).slice(1, -1))))
        throw new Fault('MCP_SECRET_IN_CATALOG', 400);
      // Diagnostic traversal retains references to avoid expanding shared input graphs through cloning.
      const inputSchema = observation
        ? definition.inputSchema
        : structuredClone(definition.inputSchema);
      const alias = `ext_${mcpDigest([connection, value.name]).slice(0, 20)}`;
      const digest = observation
        ? createHash('sha256').update(json).digest('hex')
        : mcpDigest(definition);
      if (observation && budget) {
        // Merging two JSON objects removes two braces and adds one comma.
        const extra = Buffer.byteLength(JSON.stringify({ alias, digest })) - 1;
        const before = observation.catalogBytes;
        const added = bytes + extra + Number(index > 0);
        observation.catalogBytes += added;
        if (observation.catalogBytes > 256000)
          throw limitFault(
            {
              kind: 'retained_catalog_bytes',
              frameBudgetBytes: 256000,
              remaining: 256000 - before,
              toolOffset: index,
            },
            added,
            'exact',
          );
        observation.definitionDepth = Math.max(observation.definitionDepth, budget.depth);
        observation.maxDefinitionBytes = Math.max(observation.maxDefinitionBytes, bytes);
      }
      return {
        ...definition,
        inputSchema,
        alias,
        digest,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const budget: CanonicalBudget | undefined = observation
    ? {
        kind: 'aggregate_bytes',
        frameBudgetBytes: 256000,
        remaining: 256000,
        depth: 0,
        observation,
      }
    : undefined;
  const uniqueCount = new Set(tools.map((tool) => tool.name)).size;
  if (uniqueCount !== tools.length) {
    if (observation)
      throw new CatalogLimitError(
        [tools.length, uniqueCount].every(
          (value) => Number.isSafeInteger(value) && value >= 0 && value <= mcpCatalogToolLimit,
        )
          ? { kind: 'duplicate_names', toolCount: tools.length, uniqueCount }
          : { kind: 'budget_accounting' },
      );
    throw new Fault('MCP_CATALOG_LIMIT', 400);
  }
  // Preserve duplicate-before-serialization order and the original aggregate depth16 admission bound.
  const catalogBytes = Buffer.byteLength(canonical(tools, 0, 'tools', 'catalog', budget));
  if (catalogBytes > 256000) {
    if (observation)
      throw limitFault(
        { kind: 'aggregate_bytes', frameBudgetBytes: 256000, remaining: 256000 },
        catalogBytes,
        'exact',
      );
    throw new Fault('MCP_CATALOG_LIMIT', 400);
  }
  if (observation && budget) {
    observation.catalogDepth = budget.depth;
    observation.catalogBytes = 256000 - budget.remaining;
  }
  return tools;
}

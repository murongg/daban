import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { isSearchErrorCode, type SearchResult } from '@daban/protocol';
import type { BridgeConfig, BridgeFetch } from './bridge.js';
import { bridgeRequest } from './bridge.js';
import { runtimeRequire } from './dsh.js';
import { readSearchClaim } from './policy.js';

export interface SearchProviderConfig extends BridgeConfig {
  sdkFile: string;
  runId: string;
  revision: number;
  available: boolean;
}
interface Agent {
  id: string;
  session: { id: string };
}
interface Execution {
  readonly token?: symbol;
  name: string;
  callId: string;
  agent?: Agent;
  arguments: unknown;
  signal: AbortSignal;
}
export interface SearchProviderContext {
  web: {
    registerSearchProvider(provider: {
      id: string;
      available(): boolean;
      search(
        request: { query: string; maxResults?: number },
        signal?: AbortSignal,
      ): Promise<SearchResult>;
    }): unknown;
  };
  agents: {
    roots(): Agent[];
    get(id: string): Agent | undefined;
    isOwnedBy(id: string, owner: Agent): boolean;
  };
  on(
    event: 'tools/execute',
    listener: (exec: Execution, next: () => Promise<unknown>) => Promise<unknown>,
  ): unknown;
}
export const name = 'daban-search-provider';
export const inject = ['web', 'tools', 'agents'];
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function searchResult(value: unknown): value is SearchResult {
  return (
    object(value) &&
    Object.keys(value).every((key) => ['sources', 'truncated'].includes(key)) &&
    typeof value.truncated === 'boolean' &&
    Array.isArray(value.sources) &&
    value.sources.length <= 5 &&
    value.sources.every(
      (source) =>
        object(source) &&
        Object.keys(source).every((key) =>
          ['url', 'title', 'snippet', 'publishedAt'].includes(key),
        ) &&
        typeof source.url === 'string' &&
        source.url.length <= 2048 &&
        ['title', 'snippet', 'publishedAt'].every(
          (key) =>
            source[key] === undefined ||
            (typeof source[key] === 'string' && source[key].length <= 4096),
        ),
    )
  );
}
export async function apply(
  ctx: SearchProviderContext,
  config: SearchProviderConfig,
  request: BridgeFetch = fetch,
) {
  const { WebError } = (await import(
    pathToFileURL(runtimeRequire(config.sdkFile).resolve('@deepseek-ai/dsh-web')).href
  )) as { WebError: new (message: string, code: string) => Error };
  const failure = (code: string): never => {
    throw new WebError(code, code);
  };
  const executions = new AsyncLocalStorage<{
    claimId: string;
    queries: readonly string[];
    signal: AbortSignal;
    current(): boolean;
  }>();
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name !== 'web_search') return next();
    if (!config.available) return failure('SEARCH_DISABLED');
    const roots = ctx.agents.roots();
    const agent = exec.agent;
    if (
      roots.length !== 1 ||
      !agent ||
      ctx.agents.get(agent.id) !== agent ||
      (agent !== roots[0] && !ctx.agents.isOwnedBy(agent.id, roots[0]))
    )
      return failure('SEARCH_INVALID_QUERY');
    const args = exec.arguments;
    if (
      !object(args) ||
      !Array.isArray(args.queries) ||
      !args.queries.length ||
      args.queries.length > 4 ||
      args.queries.some((query) => typeof query !== 'string' || !query.trim())
    )
      return failure('SEARCH_INVALID_QUERY');
    const claim = readSearchClaim(exec.token, config);
    if (
      !claim ||
      claim.root !== roots[0] ||
      claim.agent !== agent ||
      !claim.current() ||
      claim.sessionId !== roots[0].session.id ||
      claim.executionSessionId !== agent.session.id ||
      JSON.stringify([...new Set(args.queries)]) !== JSON.stringify(claim.queries)
    )
      return failure('SEARCH_INVALID_QUERY');
    let receipt: { claimId: string };
    try {
      receipt = await claim.receipt;
    } catch {
      return failure('SEARCH_INVALID_QUERY');
    }
    if (
      !claim.current() ||
      ctx.agents.roots()[0] !== roots[0] ||
      ctx.agents.get(agent.id) !== agent
    )
      return failure('SEARCH_INVALID_QUERY');
    // Async context keeps concurrent tool batches separate without replacing DSH's web_search or policy pipeline.
    return executions.run(
      {
        claimId: receipt.claimId,
        queries: claim.queries,
        signal: exec.signal,
        current: claim.current,
      },
      next,
    );
  });
  ctx.web.registerSearchProvider({
    id: 'daban-host-search',
    available: () => config.available,
    async search(input, caller) {
      if (!config.available) return failure('SEARCH_DISABLED');
      const execution = executions.getStore();
      if (
        !execution?.current() ||
        !execution.queries.includes(input.query) ||
        (input.maxResults !== undefined && input.maxResults !== 5)
      )
        return failure('SEARCH_INVALID_QUERY');
      const signal = AbortSignal.any([
        execution.signal,
        ...(caller ? [caller] : []),
        AbortSignal.timeout(30000),
      ]);
      if (signal.aborted) return failure('SEARCH_CANCELLED');
      const id = randomUUID();
      let reply: unknown;
      try {
        reply = await bridgeRequest(
          config,
          {
            jsonrpc: '2.0',
            id,
            method: 'search.query',
            params: {
              claimId: execution.claimId,
              query: input.query,
            },
          },
          signal,
          request,
          30000,
        );
      } catch {
        return failure(
          signal.aborted
            ? execution.signal.aborted || caller?.aborted
              ? 'SEARCH_CANCELLED'
              : 'SEARCH_TIMEOUT'
            : 'SEARCH_UNAVAILABLE',
        );
      }
      if (signal.aborted) return failure('SEARCH_CANCELLED');
      if (!execution.current()) return failure('SEARCH_INVALID_QUERY');
      if (!object(reply) || reply.id !== id) return failure('SEARCH_INVALID_RESPONSE');
      if (object(reply.error))
        return failure(
          isSearchErrorCode(reply.error.message) || reply.error.message === 'TOOL_LIMIT'
            ? String(reply.error.message)
            : 'SEARCH_UNAVAILABLE',
        );
      if (!searchResult(reply.result)) return failure('SEARCH_INVALID_RESPONSE');
      return reply.result;
    },
  });
}

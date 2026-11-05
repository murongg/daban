import { Agent, request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { connect as secureConnect } from 'node:tls';
import {
  isSearchErrorCode,
  isSearchProvider,
  type SearchProvider,
  type SearchResult,
  type SearchSource,
  searchRequiresKey,
} from '@daban/protocol';
import { Fault } from './control.js';
import { duckDuckGoResults } from './duckduckgo.js';
import { dialAddress, publicAddress, resolvePublic } from './network.js';
import { redact } from './redaction.js';

const responseLimit = 1024 * 1024;
const endpoints = {
  deepseek: 'https://api.deepseek.com/v1/tools/search',
  brave: 'https://api.search.brave.com/res/v1/web/search',
  duckduckgo: 'https://lite.duckduckgo.com/lite/',
} as const;

class SearchFault extends Fault {
  constructor(
    code: string,
    status = 502,
    readonly retryAfter?: number,
  ) {
    super(code, status);
  }
}

function invalidResponse(): never {
  throw new SearchFault('SEARCH_INVALID_RESPONSE');
}

async function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

// Resolve once, then dial that public address: global fetch/proxy resolution must not retarget a credential.
type SearchRequest = (
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
  beforeSend?: () => unknown,
) => Promise<Response>;

const pinnedRequest: SearchRequest = async (input, init = {}, beforeSend) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (
    !Object.values(endpoints).some((endpoint) => url.origin + url.pathname === endpoint) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new SearchFault('SEARCH_UNAVAILABLE', 503);
  const signal = init.signal ?? new AbortController().signal;
  const headers = new Headers(init.headers);
  if (headers.has('cookie') || headers.has('proxy-authorization'))
    throw new SearchFault('SEARCH_UNAVAILABLE', 503);
  headers.set('accept-encoding', 'identity');
  headers.set('connection', 'close');
  headers.set('host', url.host);
  const addresses = await resolvePublic(url.hostname, signal);
  beforeSend?.();
  const socket = await dialAddress(addresses[0].address, 443, signal);
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () =>
    secureConnect({ socket, servername: url.hostname, rejectUnauthorized: true });
  try {
    beforeSend?.();
    return await new Promise<Response>((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: url.hostname,
          port: 443,
          path: url.pathname + url.search,
          method: init.method,
          headers: Object.fromEntries(headers),
          agent,
        },
        (response) => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > responseLimit) {
              const failure = new SearchFault('SEARCH_INVALID_RESPONSE');
              reject(failure);
              response.destroy(failure);
              return;
            }
            chunks.push(chunk);
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              const status = response.statusCode ?? 502;
              const encoding = response.headers['content-encoding'];
              if (encoding && encoding !== 'identity') invalidResponse();
              const output = new Headers();
              if (typeof response.headers['content-type'] === 'string')
                output.set('content-type', response.headers['content-type']);
              if (typeof response.headers['retry-after'] === 'string')
                output.set('retry-after', response.headers['retry-after']);
              resolve(
                new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), {
                  status,
                  headers: output,
                }),
              );
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      const cancel = () => request.destroy(new SearchFault('SEARCH_CANCELLED', 409));
      signal.addEventListener('abort', cancel, { once: true });
      request.once('close', () => signal.removeEventListener('abort', cancel));
      request.once('error', reject);
      if (signal.aborted) cancel();
      else {
        try {
          // DNS and dialing yield; no credential or query may leave under their earlier authority snapshot.
          beforeSend?.();
          request.end(typeof init.body === 'string' ? init.body : undefined);
        } catch (error) {
          request.destroy();
          reject(error);
        }
      }
    });
  } finally {
    socket.destroy();
    agent.destroy();
  }
};

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function inspectShape(value: unknown) {
  const stack: [unknown, number][] = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop()!;
    if (++nodes > 10000 || depth > 20) invalidResponse();
    if (item && typeof item === 'object') {
      const children = Array.isArray(item) ? item : Object.values(item);
      if (children.length > 1000) invalidResponse();
      for (const child of children) stack.push([child, depth + 1]);
    }
  }
}

async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  const length = response.headers.get('content-length');
  if (length && (!/^\d+$/u.test(length) || Number(length) > responseLimit)) invalidResponse();
  if (!response.body) invalidResponse();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await bounded(reader.read(), signal);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > responseLimit) invalidResponse();
      chunks.push(next.value);
    }
  } finally {
    // Cleanup belongs to the same deadline; a stalled stream cancellation cannot keep a task alive.
    await bounded(reader.cancel(), signal);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    return invalidResponse();
  }
}

async function responseJSON(response: Response, signal: AbortSignal): Promise<unknown> {
  // A lost response is a transport uncertainty, not a settled JSON-format refusal.
  const text = await responseText(response, signal);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return invalidResponse();
  }
  inspectShape(value);
  return value;
}

function sourceUrl(value: unknown, key: string) {
  // Keyless search has no secret to match; an empty string must not reject every destination.
  if (typeof value !== 'string' || value.length > 2048 || /[\s\p{Cc}]/u.test(value))
    return invalidResponse();
  try {
    const url = new URL(value);
    const host = url.hostname
      .replace(/^\[|\]$/g, '')
      .replace(/\.$/u, '')
      .toLowerCase();
    const decoded = decodeURIComponent(value);
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      (!!key && (value.includes(key) || decoded.includes(key))) ||
      (isIP(host)
        ? !publicAddress(host)
        : !host.includes('.') ||
          host === 'localhost' ||
          /\.(?:localhost|local|internal|home|lan)$/u.test(host))
    )
      return invalidResponse();
    // Keep the provider's exact URL; redacting or rebuilding it would invent a different read grant.
    return value;
  } catch {
    return invalidResponse();
  }
}

function sourceText(value: unknown, key: string, limit: number) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return invalidResponse();
  return (
    redact(value, key ? [key] : [])
      .replace(/[\p{Cc}]/gu, ' ')
      .slice(0, limit) || undefined
  );
}

function project(
  provider: SearchProvider,
  value: unknown,
  key: string,
  count: number,
): SearchResult {
  if (!object(value)) return invalidResponse();
  if (provider === 'brave' && value.type === 'search' && value.web == null)
    return { sources: [], truncated: false };
  const results =
    provider !== 'brave' ? value.results : object(value.web) ? value.web.results : undefined;
  if (!Array.isArray(results) || results.length > 100) return invalidResponse();
  const sources: SearchSource[] = results.map((item: unknown) => {
    if (!object(item) || typeof item.title !== 'string') return invalidResponse();
    if (provider !== 'brave' && typeof item.snippet !== 'string') return invalidResponse();
    const title = sourceText(item.title, key, 500);
    const snippet = sourceText(provider !== 'brave' ? item.snippet : item.description, key, 2000);
    const date = provider === 'deepseek' ? item.date : item.page_age;
    if (
      date !== undefined &&
      date !== null &&
      (typeof date !== 'string' ||
        date.length > 100 ||
        (!!key && date.includes(key)) ||
        !Number.isFinite(Date.parse(date)))
    )
      return invalidResponse();
    return {
      url: sourceUrl(item.url, key),
      ...(title ? { title } : {}),
      ...(snippet ? { snippet } : {}),
      ...(typeof date === 'string' ? { publishedAt: date } : {}),
    };
  });
  return { sources: sources.slice(0, count), truncated: sources.length > count };
}

function statusFailure(response: Response) {
  if (response.ok) return;
  if (response.status === 401) throw new SearchFault('SEARCH_UNAUTHORIZED', 401);
  if (response.status === 403) throw new SearchFault('SEARCH_FORBIDDEN', 403);
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    const retryAfter =
      header && /^\d+$/u.test(header) && Number(header) <= 86400 ? Number(header) : undefined;
    throw new SearchFault('SEARCH_RATE_LIMITED', 429, retryAfter);
  }
  throw new SearchFault('SEARCH_UNAVAILABLE', 503);
}

export class SearchClient {
  constructor(
    private readonly request: SearchRequest = pinnedRequest,
    private readonly timeoutMs = 30000,
  ) {}

  async query(
    provider: SearchProvider,
    key: string,
    query: string,
    caller = new AbortController().signal,
    maxResults = 5,
    beforeSend?: () => unknown,
  ): Promise<SearchResult> {
    if (!isSearchProvider(provider)) throw new SearchFault('SEARCH_INVALID_PROVIDER', 400);
    if (
      searchRequiresKey(provider)
        ? !key || key.length > 4096 || /[\s\p{Cc}]/u.test(key)
        : key !== ''
    )
      throw new SearchFault('SEARCH_INVALID_CREDENTIAL', 400);
    if (
      !query.trim() ||
      /[\uD800-\uDFFF]/u.test(query) ||
      !Number.isSafeInteger(maxResults) ||
      maxResults < 1 ||
      maxResults > 5
    )
      throw new SearchFault('SEARCH_INVALID_QUERY', 400);
    if (
      Array.from(query).length > (provider === 'deepseek' ? 128 : 600) ||
      (provider === 'brave' && query.trim().split(/\s+/u).length > 75)
    )
      throw new SearchFault('SEARCH_QUERY_TOO_LONG', 400);
    const signal = AbortSignal.any([caller, AbortSignal.timeout(this.timeoutMs)]);
    let denied: { error: unknown } | undefined;
    const guard = () => {
      try {
        beforeSend?.();
      } catch (error) {
        denied = { error };
        throw error;
      }
    };
    try {
      signal.throwIfAborted();
      const endpoint = new URL(endpoints[provider]);
      const headers = new Headers({
        accept: provider === 'duckduckgo' ? 'text/html' : 'application/json',
      });
      const init: RequestInit = {
        method: provider === 'deepseek' ? 'POST' : 'GET',
        headers,
        signal,
        redirect: 'error',
        credentials: 'omit',
      };
      if (provider === 'deepseek') {
        headers.set('authorization', `Bearer ${key}`);
        headers.set('content-type', 'application/json');
        init.body = JSON.stringify({ query, count: maxResults, need_content: false });
      } else if (provider === 'brave') {
        headers.set('x-subscription-token', key);
        endpoint.search = new URLSearchParams({
          q: query,
          count: String(maxResults),
          result_filter: 'web',
        }).toString();
      } else {
        headers.set('user-agent', 'Mozilla/5.0 (compatible; Daban)');
        endpoint.search = new URLSearchParams({ q: query }).toString();
      }
      guard();
      const response = await bounded(this.request(endpoint.href, init, guard), signal);
      try {
        signal.throwIfAborted();
        statusFailure(response);
        let value: unknown;
        if (provider === 'duckduckgo') {
          if (
            response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'text/html'
          )
            invalidResponse();
          value = { results: duckDuckGoResults(await responseText(response, signal)) };
        } else value = await responseJSON(response, signal);
        guard();
        const result = project(provider, value, key, maxResults);
        signal.throwIfAborted();
        return result;
      } finally {
        if (!response.bodyUsed && response.body) await bounded(response.body.cancel(), signal);
      }
    } catch (error) {
      if (denied && denied.error === error) throw error;
      if (caller.aborted) throw new SearchFault('SEARCH_CANCELLED', 409);
      if (signal.aborted) throw new SearchFault('SEARCH_TIMEOUT', 504);
      if (error instanceof SearchFault || (error instanceof Fault && isSearchErrorCode(error.code)))
        throw error;
      throw new SearchFault('SEARCH_UNAVAILABLE', 503);
    }
  }
}

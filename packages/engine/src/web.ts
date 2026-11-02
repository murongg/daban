import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';
import { BlockList, isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

type Lookup = (host: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>;
type Fetch = (url: string, options: RequestInit) => Promise<Response>;
const proxyAddresses = new BlockList();
proxyAddresses.addSubnet('198.18.0.0', 15, 'ipv4');
proxyAddresses.addSubnet('2001:2::', 48, 'ipv6');
export async function fallbackLookup(
  host: string,
  signal: AbortSignal,
  resolve: Lookup = lookup,
  request: Fetch = fetch,
): Promise<LookupAddress[]> {
  signal.throwIfAborted();
  let cancel: () => unknown = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
  });
  let addresses: LookupAddress[];
  try {
    // OS lookup cannot be cancelled; discard its eventual result once the caller stops waiting.
    addresses = await Promise.race([resolve(host, { all: true, order: 'verbatim' }), aborted]);
  } finally {
    signal.removeEventListener('abort', cancel);
  }
  if (
    !addresses.length ||
    !addresses.every((entry) =>
      entry.family === 4
        ? proxyAddresses.check(entry.address, 'ipv4')
        : entry.family === 6 && proxyAddresses.check(entry.address, 'ipv6'),
    )
  )
    return addresses;
  // Dual-stack proxy benchmark addresses use this fixed TLS resolver; its answers still need public-IP validation and pinning.
  const query = new URLSearchParams({ name: host, type: 'A' });
  const response = await request(`https://223.5.5.5/resolve?${query}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
    redirect: 'error',
  });
  if (!response.ok || !response.body) throw new Error('WEB_DNS_UNAVAILABLE');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 16384) throw new Error('WEB_DNS_RESPONSE_TOO_LARGE');
    chunks.push(Buffer.from(chunk));
  }
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (
    !result ||
    typeof result !== 'object' ||
    !('Status' in result) ||
    result.Status !== 0 ||
    !('Answer' in result) ||
    !Array.isArray(result.Answer)
  )
    throw new Error('WEB_DNS_UNAVAILABLE');
  const answer: LookupAddress[] = [];
  for (const row of result.Answer) {
    if (!row || typeof row !== 'object' || row.type !== 1) continue;
    if (typeof row.data !== 'string' || isIP(row.data) !== 4)
      throw new Error('WEB_DNS_INVALID_RESPONSE');
    answer.push({ address: row.data, family: 4 });
  }
  if (!answer.length) throw new Error('WEB_DNS_UNAVAILABLE');
  return answer;
}

export const name = 'daban-web';
export const inject = ['web'];
interface Context {
  web: { registerFetchProvider: (provider: unknown) => unknown };
}
interface Limits {
  maxResponseBytes: number;
  maxBodyChars: number;
  timeoutMs: number;
  maxRedirects: number;
}
interface Provider {
  id: string;
  available: () => boolean;
  fetch: (input: { url: string }, signal?: AbortSignal) => Promise<unknown>;
}
type NativeProvider = new (
  limits: Limits & { userAgent: string },
  resolve?: (host: string, signal: AbortSignal) => Promise<LookupAddress[]>,
) => Provider;
export function createFetcher(
  Factory: NativeProvider,
  limits: Limits & { userAgent: string },
  isPublic: (ip: string) => boolean,
  resolve: Lookup = lookup,
  request: Fetch = fetch,
): Provider {
  const native = new Factory(limits);
  return {
    id: native.id,
    available: () => native.available(),
    async fetch(input, caller = new AbortController().signal) {
      const signal = AbortSignal.any([caller, AbortSignal.timeout(limits.timeoutMs)]);
      try {
        return await native.fetch(input, signal);
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'WEB_BLOCKED_URL'
        )
          throw error;
        const host = new URL(input.url).hostname;
        if (isIP(host.startsWith('[') ? host.slice(1, -1) : host)) throw error;
        const addresses = await fallbackLookup(host, signal, resolve, request);
        if (
          !addresses.length ||
          addresses.some((entry) => entry.family !== 4 || !isPublic(entry.address))
        )
          throw error;
        // Native validation handles all normal DNS/IPv6 cases. Only validated IPv4 fallback answers enter this resolver seam.
        const fallback = new Factory(limits, async (target) => {
          if (target !== host) throw error;
          return addresses;
        });
        return fallback.fetch(input, signal);
      }
    },
  };
}
export async function apply(ctx: Context, config: Limits & { sdkFile: string }) {
  const { sdkFile, ...limits } = config;
  // Resolve through the captured SDK's dependency tree, including nested installs and Windows paths.
  const sdk = createRequire(sdkFile);
  const runtime = createRequire(sdk.resolve('@deepseek-ai/dsh/package.json'));
  const base = createRequire(runtime.resolve('@deepseek-ai/dsh-base/package.json'));
  const entry = base.resolve('@deepseek-ai/dsh-web-fetch-http');
  const { HttpFetchProvider, DEFAULT_USER_AGENT } = await import(pathToFileURL(entry).href);
  const ipaddr = createRequire(entry)('ipaddr.js');
  ctx.web.registerFetchProvider(
    createFetcher(
      HttpFetchProvider,
      { ...limits, userAgent: DEFAULT_USER_AGENT },
      (address) => ipaddr.parse(address).range() === 'unicast',
    ),
  );
}

import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { type Fetch, fallbackLookup, type Lookup } from './dns.js';
import { runtimeRequire } from './dsh.js';

export { fallbackLookup } from './dns.js';

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
  const runtime = runtimeRequire(sdkFile);
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

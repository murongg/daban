import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

export type Lookup = (
  host: string,
  options: { all: true; order: 'verbatim' },
) => Promise<LookupAddress[]>;
export type Fetch = (url: string, options: RequestInit) => Promise<Response>;
const proxyAddresses = new BlockList();
proxyAddresses.addSubnet('198.18.0.0', 15, 'ipv4');
proxyAddresses.addSubnet('2001:2::', 48, 'ipv6');
export async function fallbackLookup(
  host: string,
  signal: AbortSignal,
  resolve: Lookup = lookup,
  request: Fetch = fetch,
  isPublic?: (address: string) => boolean,
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
  const proxy = (entry: LookupAddress) =>
    entry.family === 4
      ? proxyAddresses.check(entry.address, 'ipv4')
      : entry.family === 6 && proxyAddresses.check(entry.address, 'ipv6');
  if (
    !addresses.length ||
    !addresses.some(proxy) ||
    !addresses.every((entry) => proxy(entry) || isPublic?.(entry.address) === true)
  )
    return addresses;
  // Mixed public/proxy answers are safe to re-resolve, but private addresses must never gain this fallback. Callers still validate and pin the TLS resolver's answers.
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

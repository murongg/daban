import { randomUUID } from 'node:crypto';

export interface BridgeConfig {
  url: string;
  capability: string;
}
export type BridgeFetch = (url: string, options: RequestInit) => Promise<Response>;
export async function callBridge(
  config: BridgeConfig,
  method: string,
  params: unknown,
  signal: AbortSignal,
  request: BridgeFetch = fetch,
): Promise<unknown> {
  signal.throwIfAborted();
  const response = await request(config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.capability}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) throw new Error('BRIDGE_UNAVAILABLE');
  const value: unknown = await response.json();
  if (!value || typeof value !== 'object' || !Object.hasOwn(value, 'result') || 'error' in value)
    throw new Error('BRIDGE_UNAVAILABLE');
  return (value as { result: unknown }).result;
}

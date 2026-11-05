import { createContext, type ReactNode, useContext, useMemo } from 'react';
import { type ClientCache, cacheForHost, clientCache } from './cache';

const Context = createContext<ClientCache | undefined>(undefined);
export function CacheProvider({ host, children }: { host: string | null; children: ReactNode }) {
  const cache = useMemo(() => cacheForHost(host), [host]);
  return <Context value={cache}>{children}</Context>;
}
export function useCache() {
  return useContext(Context) ?? clientCache();
}

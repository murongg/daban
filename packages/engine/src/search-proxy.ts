import { readFile } from 'node:fs/promises';
import { errorCode, Fault } from './control.js';

export async function searchProxy(destination: URL, networkFile?: string) {
  let proxy: unknown;
  if (networkFile) {
    try {
      const config: unknown = JSON.parse(await readFile(networkFile, 'utf8'));
      if (!config || typeof config !== 'object' || !('proxy' in config)) throw new Error();
      proxy = config.proxy;
      if (proxy === null) return undefined;
      if (typeof proxy !== 'string' || !proxy) throw new Error();
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw new Fault('SEARCH_UNAVAILABLE', 503);
    }
  }
  if (proxy === undefined) {
    const bypass = process.env.no_proxy || process.env.NO_PROXY || '';
    if (
      bypass.split(/[\s,]+/u).some((entry) => {
        if (entry === '*') return true;
        const [pattern, port] = entry.toLowerCase().split(':');
        if (!pattern || (port && port !== (destination.port || '443'))) return false;
        const host = pattern.replace(/^\*?\./u, '');
        return destination.hostname === host || destination.hostname.endsWith(`.${host}`);
      })
    )
      return undefined;
    proxy =
      process.env.DSH_NETWORK_PROXY ||
      process.env.https_proxy ||
      process.env.HTTPS_PROXY ||
      process.env.all_proxy ||
      process.env.ALL_PROXY;
    if (!proxy) return undefined;
  }
  try {
    const url = new URL(String(proxy));
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error();
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
    return url;
  } catch {
    throw new Fault('SEARCH_UNAVAILABLE', 503);
  }
}

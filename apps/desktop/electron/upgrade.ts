import path from 'node:path';
import { readAgentToken, unixFetch } from './unix';

interface Config {
  dataRoot: string;
  socketPath: string;
  scope: string;
}
interface Dependencies {
  token?: () => Promise<string>;
  fetcher?: (url: string, init: RequestInit) => Promise<Response>;
  alive?: (pid: number) => boolean;
  pause?: () => Promise<unknown>;
}
export async function prepareAgentUpdate(config: Config, dependencies: Dependencies = {}) {
  try {
    const token = await (dependencies.token ?? (() => readAgentToken(config.dataRoot)))();
    const fetcher =
      dependencies.fetcher ??
      unixFetch(config.socketPath, {
        certificateFile: path.join(config.dataRoot, 'model/control-certificate.pem'),
        maxBytes: 16384,
      });
    const response = await fetcher('http://127.0.0.1:8766/api/host/update', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-prototype-token': token },
      body: JSON.stringify({ scope: config.scope }),
      signal: AbortSignal.timeout(8000),
    });
    if ([404, 405].includes(response.status)) throw Error('AGENT_LEGACY_RESTART_REQUIRED');
    if (response.status === 409) throw Error('AGENT_UPDATE_BUSY');
    if (!response.ok) throw Error('AGENT_UPDATE_UNAVAILABLE');
    const value: unknown = await response.json();
    if (
      !value ||
      typeof value !== 'object' ||
      Object.keys(value).length !== 2 ||
      !('scope' in value) ||
      value.scope !== config.scope ||
      !('pid' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      value.pid > 2147483647 ||
      value.pid === process.pid
    )
      throw Error('AGENT_UPDATE_UNAVAILABLE');
    const alive =
      dependencies.alive ??
      ((pid: number) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch (error) {
          return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
        }
      });
    const until = Date.now() + 20000;
    // A closed socket is insufficient on Windows: the old node.exe may still lock installation files.
    while (alive(value.pid)) {
      if (Date.now() >= until) throw Error('AGENT_UPDATE_UNAVAILABLE');
      await (dependencies.pause ?? (() => new Promise((resolve) => setTimeout(resolve, 150))))();
    }
  } catch (error) {
    if (
      error instanceof Error &&
      ['AGENT_UPDATE_BUSY', 'AGENT_LEGACY_RESTART_REQUIRED'].includes(error.message)
    )
      throw error;
    throw Error('AGENT_UPDATE_UNAVAILABLE');
  }
}

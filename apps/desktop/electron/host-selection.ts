import net from 'node:net';
import path from 'node:path';
import type { DaemonConfig } from './daemon';
import { RuntimeClient } from './runtime';
import { socketReady } from './socket';
import { readAgentToken, unixFetch } from './unix';
import { prepareAgentUpdate } from './upgrade';
export async function reconcileAgent(
  config: DaemonConfig & { scope: string },
  native: boolean,
  dependencies: {
    identity?: () => Promise<unknown>;
    execution?: () => Promise<string | undefined>;
    handoff?: () => Promise<unknown>;
    restart?: boolean;
  } = {},
) {
  if (!dependencies.identity) {
    if (!(await socketReady(config.socketPath))) return false;
    const reachable = await new Promise<boolean>((resolve, reject) => {
      const socket = net.createConnection(config.socketPath);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', (error: NodeJS.ErrnoException) => {
        socket.destroy();
        if (['ENOENT', 'ECONNREFUSED'].includes(error.code ?? '')) resolve(false);
        else reject(Error('AGENT_DAEMON_UNAVAILABLE'));
      });
      socket.setTimeout(1500, () => {
        socket.destroy();
        reject(Error('AGENT_DAEMON_UNAVAILABLE'));
      });
    });
    if (!reachable) return false;
  }
  const fetcher = unixFetch(config.socketPath, {
    certificateFile: path.join(config.dataRoot, 'model/control-certificate.pem'),
    maxBytes: 65536,
  });
  let value: unknown;
  try {
    value = await (
      dependencies.identity ??
      (async () => {
        const response = await fetcher('http://127.0.0.1:8766/agent/identity', {
          signal: AbortSignal.timeout(1500),
        });
        if (!response.ok) throw Error('AGENT_DAEMON_UNAVAILABLE');
        return response.json();
      })
    )();
  } catch (error) {
    // Only a missing/refused private socket proves no host is currently listening.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      ['ENOENT', 'ECONNREFUSED'].includes(String(error.code))
    )
      return false;
    throw error;
  }
  if (value === undefined) return false;
  if (
    !value ||
    typeof value !== 'object' ||
    !('role' in value) ||
    value.role !== 'agent' ||
    !('scope' in value) ||
    value.scope !== config.scope ||
    !('dataRoot' in value) ||
    value.dataRoot !== config.dataRoot ||
    !('socketPath' in value) ||
    value.socketPath !== config.socketPath
  )
    throw Error('AGENT_DAEMON_SCOPE_MISMATCH');
  const execution = await (
    dependencies.execution ??
    (async () => {
      const client = new RuntimeClient({
        origin: 'http://127.0.0.1:8766',
        agent: true,
        tokenProvider: () => readAgentToken(config.dataRoot),
        fetcher,
      });
      return (await client.status()).agent?.execution;
    })
  )();
  const changed =
    dependencies.restart ||
    !('entry' in value) ||
    value.entry !== config.entry ||
    !('executable' in value) ||
    value.executable !== config.executable ||
    (execution !== undefined && execution !== (native ? 'local-workspace' : 'linux-vm'));
  if (!changed) return false;
  // This endpoint fences admissions and refuses handoff while any job, installer or recovery is busy.
  await (dependencies.handoff ?? (() => prepareAgentUpdate(config)))();
  return true;
}

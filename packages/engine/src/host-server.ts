import { lstat, unlink } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { Fault } from './control.js';
import { windowsPrivatePipe } from './private-channel.js';
import { secureDirectory } from './private-files.js';
import { type HostComposition, startPrototype } from './server.js';

export type AgentOptions = HostComposition & {
  execution: NonNullable<HostComposition['execution']>;
};
async function privateDirectory(directory: string) {
  try {
    return await secureDirectory(directory);
  } catch {
    throw new Fault('AGENT_UNSAFE_DIRECTORY');
  }
}
async function prepareSocket(socketPath: string) {
  if (process.platform === 'win32') {
    if (!windowsPrivatePipe(socketPath)) throw new Fault('AGENT_UNSAFE_SOCKET');
    return;
  }
  const previous = await lstat(socketPath).catch((error) => {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
      return undefined;
    throw error;
  });
  if (!previous) return;
  if (
    !previous.isSocket() ||
    previous.isSymbolicLink() ||
    previous.uid !== process.getuid?.() ||
    (previous.mode & 0o077) !== 0
  )
    throw new Fault('AGENT_UNSAFE_SOCKET');
  const refused = await new Promise<boolean>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const done = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.once('connect', () => done(false));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      if (error.code === 'ECONNREFUSED') resolve(true);
      else reject(new Fault('AGENT_SOCKET_UNAVAILABLE'));
    });
    socket.setTimeout(1000, () => {
      socket.destroy();
      reject(new Fault('AGENT_SOCKET_UNAVAILABLE'));
    });
  });
  if (!refused) throw new Fault('AGENT_ALREADY_RUNNING');
  const current = await lstat(socketPath);
  if (current.ino !== previous.ino || current.dev !== previous.dev || !current.isSocket())
    throw new Fault('AGENT_SOCKET_CHANGED');
  await unlink(socketPath);
}

export async function startAgent(options: AgentOptions) {
  if (
    !options?.execution ||
    typeof options.execution.call !== 'function' ||
    typeof options.execution.refresh !== 'function' ||
    !options.execution.ready
  )
    throw new Fault('AGENT_REMOTE_REQUIRED');
  if (!options.sdkFile || !path.isAbsolute(options.sdkFile) || options.sdkFile.includes('\0'))
    throw new Fault('AGENT_SDK_REQUIRED');
  if (
    options.offlineWorkspaceRoot !== undefined &&
    (!path.posix.isAbsolute(options.offlineWorkspaceRoot) ||
      options.offlineWorkspaceRoot.length > 4096 ||
      options.offlineWorkspaceRoot.includes('\0') ||
      options.offlineWorkspaceRoot.includes('\\') ||
      options.offlineWorkspaceRoot.split('/').includes('..'))
  )
    throw new Fault('AGENT_INVALID_CONFIG');
  const sdk = await lstat(options.sdkFile).catch(() => undefined);
  if (!sdk?.isFile() || sdk.isSymbolicLink()) throw new Fault('AGENT_SDK_UNAVAILABLE');
  if (
    !options.dataRoot ||
    !path.isAbsolute(options.dataRoot) ||
    !options.socketPath ||
    !path.isAbsolute(options.socketPath) ||
    options.socketPath.includes('\0') ||
    !/^[a-f0-9]{64}$/.test(options.scope)
  )
    throw new Fault('AGENT_INVALID_CONFIG');
  const dataRoot = await privateDirectory(options.dataRoot);
  let socketPath = options.socketPath;
  if (process.platform !== 'win32') {
    const socketParent = await privateDirectory(path.dirname(options.socketPath));
    socketPath = path.join(socketParent, path.basename(options.socketPath));
    if (Buffer.byteLength(socketPath) > 100) throw new Fault('AGENT_SOCKET_TOO_LONG');
  }
  await prepareSocket(socketPath);
  const prototype = await startPrototype({
    host: {
      ...options,
      dataRoot,
      socketPath,
      identity: {
        ...options.identity,
        dataRoot: path.resolve(options.dataRoot),
        socketPath: path.resolve(options.socketPath),
      },
    },
  });
  return {
    url: prototype.url,
    token: prototype.token,
    socketPath,
    scope: options.scope,
    models: prototype.models!,
    schedules: prototype.schedules,
    groups: prototype.groups,
    lifecycle: prototype.lifecycle,
    get recovery() {
      return prototype.recovery;
    },
    refreshExecution: prototype.refreshExecution!,
    close: prototype.close,
  };
}

export async function startNativeAgent(options: HostComposition & { nativeWorkspace: string }) {
  if (
    !path.isAbsolute(options.dataRoot) ||
    !path.isAbsolute(options.nativeWorkspace) ||
    !path.isAbsolute(options.sdkFile) ||
    !/^[a-f0-9]{64}$/.test(options.scope)
  )
    throw new Fault('AGENT_INVALID_CONFIG');
  const sdk = await lstat(options.sdkFile);
  if (!sdk.isFile() || sdk.isSymbolicLink()) throw new Fault('AGENT_SDK_UNAVAILABLE');
  const dataRoot = await secureDirectory(options.dataRoot);
  if (process.platform !== 'win32') await secureDirectory(path.dirname(options.socketPath));
  await prepareSocket(options.socketPath);
  const prototype = await startPrototype({ host: { ...options, dataRoot } });
  return {
    url: prototype.url,
    models: prototype.models!,
    get recovery() {
      return prototype.executionRecovery ?? prototype.recovery;
    },
    refreshExecution: prototype.refreshExecution!,
    close: prototype.close,
  };
}
